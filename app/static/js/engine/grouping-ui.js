// engine/grouping-ui.js
//
// The grouping VIEWS: every piece of DOM that shows the user which groups exist
// and which recording sits in which one. Three surfaces, one module, because
// they are the same state drawn three ways and they reorder each other:
//
//   * the sidebar  — collapsible <fieldset> per group, its checkbox list, and
//     the drag-and-drop that reorders rows within a group, moves them between
//     groups, and reorders the groups themselves;
//   * the content pane — the `.file-group` containers the waveform rows are
//     parented into, their (x/y) loaded-count badges, and the FLIP animation
//     that reorders them to follow the sidebar;
//   * the tab strip — the grouping-context pills and the switch between them.
//
// The sidebar is the source of truth for ORDER. A nav drag mutates the sidebar
// DOM live, throttles a content-pane reorder through rAF, and only on drop does
// _syncGroupsFromNav read the settled DOM back out and _persistGroupOrder write
// it into loadedAlignmentJSON.header. The content pane never reorders itself.
//
// What is NOT decided here: which group owns a recording, what a group is
// called, what colour it is, and where any of it is persisted — all of that is
// engine/grouping-model.js, and resolveGroupFor is the single answer app-wide
// (roadmap item U). This module only draws the answers. The editor for them is
// engine/group-modal.js, which calls back in here to re-render after Apply.
//
// Deliberately left behind in listen.js, each because moving it would have cost
// more surface than it saved:
//   * updateDirtyState — it reads the undo/redo counters and the annotation
//     dirty flag and no grouping state at all, so it belongs to a dirty-state
//     cut, not this one;
//   * onClickRenditionName / onClickRenditionCheckbox — the checkbox handlers
//     generateCheckboxList wires. They drive loading and the lazy-deferral path
//     (roadmap item L), not grouping;
//   * the tempo-curve redraw after a tab switch — tempo stays wrapped, so
//     _switchActiveTab asks listen.js for it via
//     redrawTempoCurvesForGroupChange() rather than reading the tempo flags.
//
// State owned here: the two rAF-throttle flags for the nav drags. Everything
// else is read out of loadedAlignmentJSON.header, which listen.js owns.
//
// Extracted from listen.js (Phase 1 refactor, cluster J, slice 3 — the last).

import { el } from "../annotation/ui-common.js";
import {
  alignmentGrids,
  bumpChangeCounter,
  loaded,
  loadedAlignmentJSON,
  onClickRenditionCheckbox,
  onClickRenditionName,
  redrawTempoCurvesForGroupChange,
  SYNTH_MEI_KEY,
  updateDirtyState,
  wavesurfers,
} from "../listen.js";
import {
  buildGroupTitle,
  emitGroupingChanged,
  getActiveFileGroups,
  getActiveGroupOrder,
  groupTextColor,
  resolveGroupFor,
  resolveGroupMembers,
  safeColor,
  setActiveFileGroups,
  setActiveGroupOrder,
} from "./grouping-model.js";
import { redrawAllMarkers } from "./markers.js";
import { drawAlignmentGrid, waveformViews } from "./waveform-view.js";
import { syncOverlayScroll } from "./zoom-scroll.js";

function generateCheckboxList(list, isDraggable = false) {
  console.log("Generate checkbox list: ", list);
  // generate content for <ul>:
  // <li> containing a checkbox for each list member
  const ul = document.createElement("ul");
  list.forEach((n) => {
    const li = document.createElement("li");
    li.classList.add("renditionName");
    li.id = n;

    const checkboxSpan = document.createElement("span");
    const checkbox = document.createElement("input");
    checkbox.id = "checkbox-" + n;
    checkbox.name = "checkbox-" + n;
    checkbox.type = "checkbox";
    checkbox.classList.add("renditionCheckbox");
    checkbox.value = n;
    const label = document.createElement("label");
    label.htmlFor = "checkbox-" + n; // use htmlFor for DOM property
    label.innerText = n.substr(n.indexOf("/") + 1); // HACK, use semantic title

    checkboxSpan.appendChild(checkbox);
    checkboxSpan.appendChild(label);

    li.appendChild(checkboxSpan);

    if (isDraggable) {
      const handle = document.createElement("span");
      handle.className = "nav-drag-handle";
      handle.setAttribute("aria-hidden", "true");
      handle.textContent = "⠿";
      li.appendChild(handle);

      // Only start a drag when the handle is the pointer-down target
      let _fromHandle = false;
      handle.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        _fromHandle = true;
      });
      handle.addEventListener("click", (e) => e.stopPropagation());
      li.addEventListener("pointerup", () => {
        _fromHandle = false;
      });
      li.draggable = true;
      li.addEventListener("dragstart", (ev) => {
        if (!_fromHandle) {
          ev.preventDefault();
          return;
        }
        _fromHandle = false;
        ev.dataTransfer.setData("nav-file", n);
        ev.dataTransfer.effectAllowed = "move";
        li.classList.add("nav-dragging");
      });
      li.addEventListener("dragend", () => {
        _fromHandle = false;
        li.classList.remove("nav-dragging");
      });
    }

    ul.appendChild(li);
  });
  return ul;
}

/**
 * Build the sidebar file list from the current filenames + saved groups.
 * Score foldout is added separately if present.
 */
export function renderSidebarFileList(filenames) {
  const audiosElement = document.getElementById("audios");
  // Remove old fieldsets / lists (preserve non-list children like buttons)
  audiosElement
    .querySelectorAll("fieldset.audio-group, ul.ungrouped-files")
    .forEach((el) => el.remove());

  // Use active tab's groups (migrated on load)
  const groups = loadedAlignmentJSON ? getActiveFileGroups() : [];

  // Effective group membership: each recording resolves to exactly ONE group
  // (or none). resolveGroupFor is the single source of truth — see roadmap
  // item U; this used to list a recording under every group it matched, which
  // disagreed with the pane, where its row can only have one parent.
  const groupMembers = resolveGroupMembers(filenames, groups);

  // Ungrouped files
  const ungrouped = filenames
    .filter((f) => !resolveGroupFor(f, groups))
    .sort();

  /** Helper: create a <fieldset class="audio-group collapsible-fieldset"> */
  function _makeGroupFieldset(
    label,
    filesArray,
    isDraggable,
    isGroupDraggable,
  ) {
    const fs = document.createElement("fieldset");
    fs.className = "audio-group collapsible-fieldset";
    fs.id = "audio-group-" + label.toLowerCase().replace(/\s+/g, "-");

    const legend = document.createElement("legend");
    legend.title = "Collapse / expand " + label;
    legend.textContent = label + " ";
    const arrow = document.createElement("span");
    arrow.className = "collapse-arrow";
    arrow.innerHTML = "&#9662;";
    legend.appendChild(arrow);

    // Group-level drag handle (for reordering groups in the sidebar)
    if (isGroupDraggable) {
      const groupHandle = document.createElement("span");
      groupHandle.className = "nav-group-drag-handle";
      groupHandle.setAttribute("aria-hidden", "true");
      groupHandle.textContent = "\u2630"; // hamburger ☰
      groupHandle.title = "Drag to reorder group";
      legend.appendChild(groupHandle);

      let _fromGroupHandle = false;
      groupHandle.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        _fromGroupHandle = true;
        fs.draggable = true; // only make fieldset draggable while handle is held
      });
      groupHandle.addEventListener("click", (e) => e.stopPropagation());
      fs.addEventListener("pointerup", () => {
        _fromGroupHandle = false;
      });
      fs.addEventListener("dragstart", (ev) => {
        if (!_fromGroupHandle) {
          fs.draggable = false;
          return; // let file-level drags pass through
        }
        _fromGroupHandle = false;
        ev.dataTransfer.setData("nav-group", label);
        ev.dataTransfer.effectAllowed = "move";
        fs.classList.add("nav-group-dragging");
      });
      fs.addEventListener("dragend", () => {
        _fromGroupHandle = false;
        fs.draggable = false;
        fs.classList.remove("nav-group-dragging");
      });
    }

    fs.appendChild(legend);

    const body = document.createElement("div");
    body.className = "fieldset-body";

    if (isDraggable) {
      const listSelectors = document.createElement("span");
      listSelectors.className = "listSelectors";
      listSelectors.innerHTML =
        "<span class='all'>All</span><span class='none'>None</span>";
      body.appendChild(listSelectors);
    }

    body.appendChild(generateCheckboxList(filesArray, isDraggable));
    fs.appendChild(body);

    // Restore collapsed state from localStorage
    try {
      if (localStorage.getItem("fieldset-collapsed-" + fs.id) === "true") {
        fs.classList.add("collapsed");
      }
    } catch (_) {}

    return fs;
  }

  // --- Build all fieldsets, then append in saved order ---

  // Create fieldsets keyed by group name
  const fieldsetsByName = {};

  // Score fieldset
  if (SYNTH_MEI_KEY in alignmentGrids) {
    fieldsetsByName["Score"] = _makeGroupFieldset(
      "Score",
      [SYNTH_MEI_KEY],
      false,
      true,
    );
  }

  // Named group fieldsets
  groups.forEach((g, i) => {
    const members = groupMembers[i];
    if (members.length === 0) return;
    const fs = _makeGroupFieldset(g.name, members, true, true);
    _wireNavGroupDrop(fs);
    fieldsetsByName[g.name] = fs;
  });

  // Ungrouped fieldset
  const ungroupedLabel =
    groups.length > 0 ? "Ungrouped recordings" : "All recordings";
  if (ungrouped.length > 0) {
    const fs = _makeGroupFieldset(ungroupedLabel, ungrouped, true, true);
    _wireNavGroupDrop(fs);
    fieldsetsByName["Ungrouped"] = fs;
  }

  // Append in saved groupOrder (uses normalized names), then any remaining
  const activeOrder = loadedAlignmentJSON ? getActiveGroupOrder() : [];
  const savedOrder = activeOrder.length > 0 ? activeOrder : null;

  const appended = new Set();
  if (savedOrder) {
    savedOrder.forEach((name) => {
      if (fieldsetsByName[name] && !appended.has(name)) {
        audiosElement.appendChild(fieldsetsByName[name]);
        appended.add(name);
      }
    });
  }
  // Default order for any not in savedOrder: Score, named groups, Ungrouped
  const defaultOrder = ["Score", ...groups.map((g) => g.name), "Ungrouped"];
  defaultOrder.forEach((name) => {
    if (fieldsetsByName[name] && !appended.has(name)) {
      audiosElement.appendChild(fieldsetsByName[name]);
      appended.add(name);
    }
  });

  // Wire up group-level drag-and-drop reordering on the sidebar
  _wireNavGroupReorder(audiosElement);

  // Wire up list selectors (All / None)
  _wireListSelectors();

  // Rendition click / checkbox handlers
  Array.from(document.getElementsByClassName("renditionName")).forEach((r) => {
    r.addEventListener("click", onClickRenditionName);
  });
  Array.from(document.getElementsByClassName("renditionCheckbox")).forEach(
    (r) => {
      r.addEventListener("click", onClickRenditionCheckbox);
    },
  );
}

/**
 * Wire drag-over / drop onto the <ul> inside a nav group fieldset so that
 * nav items can be reordered within and between non-Score groups.
 *
 * During dragover the <li> is moved live in the sidebar and the content panel
 * is reordered (without animation) via a throttled rAF.  On drop we persist
 * the new order and run a final sync.
 */
let _navDragRafPending = false;

function _wireNavGroupDrop(groupEl) {
  const ul = groupEl.querySelector("ul");
  if (!ul) return;

  /** Move draggedLi into `targetUl` at the position closest to `clientY`. */
  function _moveToPosition(draggedLi, targetUl, clientY) {
    const items = Array.from(targetUl.querySelectorAll("li.renditionName"));
    const insertBefore = items.find((li) => {
      if (li === draggedLi) return false;
      const r = li.getBoundingClientRect();
      return clientY < r.top + r.height / 2;
    });
    if (insertBefore) {
      targetUl.insertBefore(draggedLi, insertBefore);
    } else {
      targetUl.appendChild(draggedLi);
    }
  }

  ul.addEventListener("dragover", (e) => {
    if (!e.dataTransfer.types.includes("nav-file")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";

    // Find the currently dragged <li> (it has .nav-dragging)
    const draggedLi = document.querySelector("li.nav-dragging");
    if (!draggedLi) return;

    // Live-move the <li> within this <ul>
    _moveToPosition(draggedLi, ul, e.clientY);

    // Throttled content-panel sync with FLIP animation
    if (!_navDragRafPending) {
      _navDragRafPending = true;
      requestAnimationFrame(() => {
        _navDragRafPending = false;
        _applyNavOrderToContentPanel();
      });
    }
  });

  ul.addEventListener("drop", (e) => {
    e.preventDefault();
    // Final sync + persist
    _syncGroupsFromNav();
  });
}

/**
 * Wire up group-level drag-and-drop reordering in the sidebar.
 * Groups can be dragged above/below each other; Score stays first,
 * Ungrouped stays last.
 */
let _navGroupDragRafPending = false;

function _wireNavGroupReorder(audiosElement) {
  /** Live-move draggedFs to the position closest to clientY among siblings. */
  function _moveGroupToPosition(draggedFs, clientY) {
    const siblings = Array.from(
      audiosElement.querySelectorAll("fieldset.audio-group"),
    ).filter((fs) => fs !== draggedFs);

    const insertBefore = siblings.find((fs) => {
      const r = fs.getBoundingClientRect();
      return clientY < r.top + r.height / 2;
    });

    if (insertBefore) {
      audiosElement.insertBefore(draggedFs, insertBefore);
    } else {
      audiosElement.appendChild(draggedFs);
    }
  }

  audiosElement.addEventListener("dragover", (e) => {
    if (!e.dataTransfer.types.includes("nav-group")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";

    const draggedFs = audiosElement.querySelector(
      "fieldset.nav-group-dragging",
    );
    if (!draggedFs) return;

    // Live-move the fieldset in the sidebar
    _moveGroupToPosition(draggedFs, e.clientY);

    // Throttled content-panel sync (no animation during drag for performance)
    if (!_navGroupDragRafPending) {
      _navGroupDragRafPending = true;
      requestAnimationFrame(() => {
        _navGroupDragRafPending = false;
        _applyNavOrderToContentPanel(false);
      });
    }
  });

  audiosElement.addEventListener("drop", (e) => {
    if (!e.dataTransfer.types.includes("nav-group")) return;
    e.preventDefault();
    const draggedFs = audiosElement.querySelector(
      "fieldset.nav-group-dragging",
    );
    if (draggedFs) draggedFs.classList.remove("nav-group-dragging");
    // Final sync + persist
    _syncGroupsFromNav();
  });
}

/**
 * Read the current sidebar DOM order and persist it to
 * loadedAlignmentJSON.header.fileGroups, then sync the content panel.
 */
function _syncGroupsFromNav() {
  if (!loadedAlignmentJSON) return;
  if (!loadedAlignmentJSON.header) loadedAlignmentJSON.header = {};

  // Build lookup of existing group properties (pattern, color) by name
  const oldGroups = getActiveFileGroups();
  const oldByName = {};
  oldGroups.forEach((g) => {
    oldByName[g.name] = g;
  });

  const audios = document.getElementById("audios");
  const groups = [];

  audios.querySelectorAll("fieldset.audio-group").forEach((fs) => {
    const groupName = _getGroupNameFromFieldset(fs);
    if (groupName === "Score") return; // Score group is immutable

    const files = Array.from(fs.querySelectorAll("li.renditionName"))
      .map((li) => li.id)
      .filter(Boolean);

    // Ungrouped container is not stored as an explicit group
    if (groupName === "Ungrouped recordings" || groupName === "All recordings")
      return;

    // Preserve pattern and color from existing group definition
    const old = oldByName[groupName] || {};
    const entry = { name: groupName, files };
    if (old.pattern) entry.pattern = old.pattern;
    if (old.color) entry.color = old.color;
    groups.push(entry);
  });

  setActiveFileGroups(groups);

  // Persist full group display order using normalized names (matching data-group)
  const groupOrder = [];
  audios.querySelectorAll("fieldset.audio-group").forEach((fs) => {
    const name = _getGroupNameFromFieldset(fs);
    if (name === "Ungrouped recordings" || name === "All recordings") {
      groupOrder.push("Ungrouped");
    } else {
      groupOrder.push(name);
    }
  });
  setActiveGroupOrder(groupOrder);

  bumpChangeCounter();
  updateDirtyState();
  _applyNavOrderToContentPanel();
}

/** Extract the group name from a sidebar fieldset legend, stripping UI elements. */
function _getGroupNameFromFieldset(fs) {
  const legend = fs.querySelector("legend");
  if (!legend) return "";
  // Clone legend and remove child elements (collapse arrow, drag handle)
  // to get just the text content of the legend itself
  const clone = legend.cloneNode(true);
  clone
    .querySelectorAll(".collapse-arrow, .nav-group-drag-handle")
    .forEach((el) => el.remove());
  return clone.textContent.trim();
}

/**
 * Reorder waveform elements in the content panel to match the nav sidebar order.
 * @param {boolean} animate - If true, use FLIP animation. If false, just reorder DOM.
 */
function _applyNavOrderToContentPanel(animate = true) {
  const waveformsRoot = document.getElementById("waveforms");
  if (!waveformsRoot) return;

  // FIRST: snapshot positions (only needed for animation)
  const allWaveforms = Array.from(
    waveformsRoot.querySelectorAll(".file-group .waveform"),
  );
  const firstRects = new Map();
  if (animate) {
    allWaveforms.forEach((wf) => {
      firstRects.set(wf, wf.getBoundingClientRect());
    });
  }

  // Build desired order from the nav
  const audios = document.getElementById("audios");

  /** Find the content-pane file-group matching a sidebar group name. */
  function _findContentGroup(groupName) {
    if (groupName === "Score") {
      return waveformsRoot.querySelector(".file-group-score");
    }
    if (
      groupName === "Ungrouped recordings" ||
      groupName === "All recordings"
    ) {
      return waveformsRoot.querySelector(".file-group-ungrouped");
    }
    return waveformsRoot.querySelector(
      `.file-group[data-group='${CSS.escape(groupName)}']`,
    );
  }

  // Reorder file-group containers in content pane to match sidebar order
  audios.querySelectorAll("fieldset.audio-group").forEach((fs) => {
    const groupName = _getGroupNameFromFieldset(fs);
    const fg = _findContentGroup(groupName);
    if (fg) {
      waveformsRoot.appendChild(fg);
    }
  });

  // Reorder waveforms within each group to match nav order
  audios.querySelectorAll("fieldset.audio-group").forEach((fs) => {
    const groupName = _getGroupNameFromFieldset(fs);

    const filenames = Array.from(fs.querySelectorAll("li.renditionName"))
      .map((li) => li.id)
      .filter(Boolean);

    const fg = _findContentGroup(groupName);
    const groupList = fg ? fg.querySelector(".group-list") : null;
    if (!groupList) return;

    // Move any cross-group waveforms into this group-list first
    filenames.forEach((fname) => {
      const wf = waveformsRoot.querySelector(
        `.waveform[data-ix='${CSS.escape(fname)}']`,
      );
      if (wf && wf.parentElement !== groupList) {
        groupList.appendChild(wf);
      }
    });

    // Re-order within the group-list to match nav order
    filenames.forEach((fname, idx) => {
      const wf = groupList.querySelector(
        `.waveform[data-ix='${CSS.escape(fname)}']`,
      );
      if (!wf) return;
      const ref = groupList.children[idx];
      if (ref && ref !== wf) groupList.insertBefore(wf, ref);
      else if (!ref) groupList.appendChild(wf);
    });
  });

  function _onAllTransitionsDone() {
    // After DOM reorder + animation, WaveSurfer containers may need a
    // re-render (especially when zoomed — shadow DOM can go blank).
    Object.keys(wavesurfers).forEach((fn) => {
      if (!loaded.has(fn)) return;
      syncOverlayScroll(fn);
      drawAlignmentGrid(fn);
    });
    redrawAllMarkers();
  }

  if (!animate) {
    _onAllTransitionsDone();
    return;
  }

  // INVERT: shift elements back to where they visually were
  allWaveforms.forEach((wf) => {
    const first = firstRects.get(wf);
    if (!first) return;
    const last = wf.getBoundingClientRect();
    const dy = first.top - last.top;
    if (dy !== 0) {
      wf.style.transition = "none";
      wf.style.transform = `translateY(${dy}px)`;
      // Mark displaced waveforms (not the one being dragged)
      if (!wf.classList.contains("dragging")) {
        wf.classList.add("wf-displaced");
      }
    }
  });

  // PLAY: animate to final positions
  let _pendingTransitions = 0;
  requestAnimationFrame(() => {
    allWaveforms.forEach((wf) => {
      if (wf.style.transform) {
        _pendingTransitions++;
        wf.style.transition = "transform 300ms ease";
        wf.style.transform = "";
        const onEnd = () => {
          wf.style.transition = "";
          wf.classList.remove("wf-displaced");
          wf.removeEventListener("transitionend", onEnd);
          if (--_pendingTransitions === 0) _onAllTransitionsDone();
        };
        wf.addEventListener("transitionend", onEnd);
      }
    });
    // If no transitions were queued (no elements moved), still redraw
    if (_pendingTransitions === 0) _onAllTransitionsDone();
  });
}

/**
 * Ensure waveform group containers exist in the main content pane.
 * Idempotent: creates only missing containers; never destroys existing ones
 * (which would orphan already-mounted waveforms).
 * Pass `forceRebuild = true` (e.g. from reloadWaveforms) to tear down first.
 */
export function ensureWaveformGroupContainers(filenames, forceRebuild = false) {
  const waveformsRoot = document.getElementById("waveforms");

  if (forceRebuild) {
    // Detach waveform elements before removing group containers so they
    // stay in the DOM and can be re-placed into new containers below.
    const detached = [];
    waveformsRoot.querySelectorAll(".file-group .waveform").forEach((wf) => {
      detached.push(wf);
      waveformsRoot.appendChild(wf); // park on root temporarily
    });
    Array.from(waveformsRoot.querySelectorAll(".file-group")).forEach((el) =>
      el.remove(),
    );
  }

  // If containers already exist, nothing to do
  if (waveformsRoot.querySelector(".file-group")) return;

  const groups = loadedAlignmentJSON ? getActiveFileGroups() : [];

  // Same single-valued membership the sidebar uses, so a container is built
  // only for a group that will actually receive rows. Listing a recording
  // under every group it matched built a container for the losers too — one
  // that stayed empty for good while its badge claimed a recording, because
  // the row itself went to the first group only (roadmap item U).
  const groupMembers = resolveGroupMembers(filenames, groups);

  // The synth/score key has its own dedicated Score container — never count
  // it as ungrouped (otherwise an empty "Ungrouped recordings" header lingers
  // when all real recordings are placed into user groups). resolveGroupFor
  // never puts it in a group either.
  const ungrouped = filenames
    .filter((f) => f !== SYNTH_MEI_KEY && !resolveGroupFor(f, groups))
    .sort();

  // Build all containers keyed by group name, then append in saved order
  const contentByName = {};

  // Score container (if present)
  if (SYNTH_MEI_KEY in alignmentGrids) {
    const el = document.createElement("div");
    el.className = "file-group file-group-score";
    el.dataset.group = "Score";
    el.innerHTML = `<div class="group-title">Score <span class="group-count"></span></div><div class="group-list"></div>`;
    contentByName["Score"] = el;
  }

  // Named group containers
  groups.forEach((g, i) => {
    const members = groupMembers[i];
    if (members.length === 0) return;
    const container = document.createElement("div");
    container.className = "file-group";
    container.dataset.group = g.name;
    container.appendChild(buildGroupTitle(g.name));
    container.appendChild(Object.assign(document.createElement("div"), { className: "group-list" }));
    const safe = safeColor(g.color);
    if (safe) {
      container.style.backgroundColor = safe;
      container.style.color = groupTextColor(safe);
    }
    contentByName[g.name] = container;
  });

  // Ungrouped container
  const ungroupedLabel =
    groups.length > 0 ? "Ungrouped recordings" : "All recordings";
  if (ungrouped.length > 0) {
    const uc = document.createElement("div");
    uc.className = "file-group file-group-ungrouped";
    uc.dataset.group = "Ungrouped";
    uc.appendChild(buildGroupTitle(ungroupedLabel));
    uc.appendChild(Object.assign(document.createElement("div"), { className: "group-list" }));
    contentByName["Ungrouped"] = uc;
  }

  // Append in saved groupOrder (uses data-group values), then any remaining
  const activeOrder = loadedAlignmentJSON ? getActiveGroupOrder() : [];
  const savedOrder = activeOrder.length > 0 ? activeOrder : null;

  const contentAppended = new Set();
  if (savedOrder) {
    savedOrder.forEach((name) => {
      if (contentByName[name] && !contentAppended.has(name)) {
        waveformsRoot.appendChild(contentByName[name]);
        contentAppended.add(name);
      }
    });
  }
  const defaultContentOrder = [
    "Score",
    ...groups.map((g) => g.name),
    "Ungrouped",
  ];
  defaultContentOrder.forEach((name) => {
    if (contentByName[name] && !contentAppended.has(name)) {
      waveformsRoot.appendChild(contentByName[name]);
      contentAppended.add(name);
    }
  });

  // Make non-Score group-lists droppable for reordering
  waveformsRoot.querySelectorAll(".group-list").forEach((list) => {
    // Score group-list must not accept drops
    if (list.closest(".file-group-score")) return;

    list.addEventListener("dragover", (e) => {
      e.preventDefault();
    });
    list.addEventListener("drop", (e) => {
      e.preventDefault();
      const fname = e.dataTransfer.getData("text/plain");
      if (!fname) return;
      const draggedEl = document.querySelector(
        `.waveform[data-ix='${CSS.escape(fname)}']`,
      );
      if (!draggedEl) return;
      const targetList = e.currentTarget;
      // Find child under pointer to place before/after
      const afterEl = Array.from(targetList.querySelectorAll(".waveform")).find(
        (el) => {
          const r = el.getBoundingClientRect();
          return e.clientY < r.top + r.height / 2;
        },
      );
      if (afterEl) targetList.insertBefore(draggedEl, afterEl);
      else targetList.appendChild(draggedEl);

      _persistGroupOrder();
    });
  });

  // Wire All/None buttons on content-pane group headers.
  // Use the nav sidebar checkboxes (always present) rather than content-pane
  // .waveform elements (only present after loading).
  waveformsRoot.querySelectorAll(".group-all").forEach((btn) => {
    btn.addEventListener("click", () => {
      const fg = btn.closest(".file-group");
      if (!fg) return;
      _getNavCheckboxesForGroup(fg).forEach((cb) => {
        if (!cb.checked) cb.click();
      });
    });
  });
  waveformsRoot.querySelectorAll(".group-none").forEach((btn) => {
    btn.addEventListener("click", () => {
      const fg = btn.closest(".file-group");
      if (!fg) return;
      _getNavCheckboxesForGroup(fg).forEach((cb) => {
        if (cb.checked) cb.click();
      });
    });
  });

  // Show initial (0/x) counts
  updateGroupCounts();
}

// ---------------------------------------------------------------------------
// Grouping Tab Pills (content pane) and tab switching
// ---------------------------------------------------------------------------

/**
 * Render the pill selector at the top of the content pane.
 * Only shown when there are 2+ tabs.
 */
export function renderGroupingTabPills() {
  let pillRow = document.getElementById("grouping-tab-pills");
  const tabs = loadedAlignmentJSON?.header?.groupingTabs;
  if (!tabs || tabs.length < 2) {
    if (pillRow) pillRow.remove();
    return;
  }
  const activeTabName = loadedAlignmentJSON.header.activeTab || tabs[0].name;
  const contentEl = document.getElementById("content");
  const waveformsEl = document.getElementById("waveforms");
  if (!pillRow) {
    pillRow = document.createElement("div");
    pillRow.id = "grouping-tab-pills";
    contentEl.insertBefore(pillRow, waveformsEl);
  }
  pillRow.innerHTML = "";
  tabs.forEach((tab) => {
    const pill = document.createElement("span");
    pill.className = "gt-pill" + (tab.name === activeTabName ? " active" : "");
    pill.textContent = tab.name;
    pill.addEventListener("click", () => {
      if (tab.name === activeTabName) return;
      _switchActiveTab(tab.name);
    });
    pillRow.appendChild(pill);
  });
}

/**
 * Switch the active grouping tab — re-renders sidebar and content pane.
 */
function _switchActiveTab(tabName) {
  if (!loadedAlignmentJSON?.header) return;
  loadedAlignmentJSON.header.activeTab = tabName;

  const filenames = Object.keys(alignmentGrids)
    .filter((n) => n !== SYNTH_MEI_KEY)
    .sort();

  // Snapshot waveform positions for FLIP animation
  const waveformEls = document.querySelectorAll("#waveforms .waveform");
  const firstRects = new Map();
  waveformEls.forEach((el) => {
    firstRects.set(el, el.getBoundingClientRect());
  });

  // Re-render sidebar with new tab's groups
  renderSidebarFileList(filenames);

  // Rebuild content pane group containers
  ensureWaveformGroupContainers(
    filenames.concat(SYNTH_MEI_KEY in alignmentGrids ? [SYNTH_MEI_KEY] : []),
    true /* forceRebuild */,
  );

  // Move existing waveform elements into their new group containers
  const waveformsRoot = document.getElementById("waveforms");
  const groups = getActiveFileGroups();

  // Place each existing waveform into the correct group-list. Working set: a
  // deferred row is in the pane and must be re-parented with the rest.
  //
  // Membership comes from the shared resolveGroupFor, the same call row creation
  // makes. This used to build its own filename → group map and let the LAST
  // matching group win, while row creation took the FIRST — so a recording in
  // two groups changed group merely by switching tabs and back (roadmap item U).
  Object.keys(waveformViews).forEach((fname) => {
    const wfEl = waveformsRoot.querySelector(
      `.waveform[data-ix='${CSS.escape(fname)}']`,
    );
    if (!wfEl) return;
    let targetList;
    if (fname === SYNTH_MEI_KEY) {
      targetList = waveformsRoot.querySelector(".file-group-score .group-list");
    } else {
      const g = resolveGroupFor(fname, groups);
      if (g) {
        const fg = waveformsRoot.querySelector(
          `.file-group[data-group='${CSS.escape(g.name)}']`,
        );
        targetList = fg?.querySelector(".group-list");
      }
    }
    if (!targetList) {
      targetList = waveformsRoot.querySelector(
        ".file-group-ungrouped .group-list",
      );
    }
    if (targetList && wfEl.parentElement !== targetList) {
      targetList.appendChild(wfEl);
    }
  });

  updateGroupCounts();

  // FLIP animation
  waveformEls.forEach((el) => {
    const first = firstRects.get(el);
    if (!first) return;
    const last = el.getBoundingClientRect();
    const dx = first.left - last.left;
    const dy = first.top - last.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
    el.style.transform = `translate(${dx}px, ${dy}px)`;
    el.style.transition = "none";
    requestAnimationFrame(() => {
      el.style.transition = "transform 0.3s ease";
      el.style.transform = "";
      el.addEventListener("transitionend", function handler() {
        el.style.transition = "";
        el.removeEventListener("transitionend", handler);
      });
    });
  });

  // Update pills
  renderGroupingTabPills();

  redrawTempoCurvesForGroupChange();

  bumpChangeCounter();
  updateDirtyState();
  emitGroupingChanged();
}

/** Find nav sidebar checkboxes corresponding to a content-pane file-group. */
function _getNavCheckboxesForGroup(fg) {
  const groupName = fg.dataset.group;
  if (!groupName) return [];
  const navId = "audio-group-" + groupName.toLowerCase().replace(/\s+/g, "-");
  const navGroup = document.getElementById(navId);
  if (navGroup) return [...navGroup.querySelectorAll("input[type='checkbox']")];
  // Fallback for ungrouped
  for (const id of [
    "audio-group-ungrouped-recordings",
    "audio-group-all-recordings",
  ]) {
    const el = document.getElementById(id);
    if (el) return [...el.querySelectorAll("input[type='checkbox']")];
  }
  return [];
}

/** Update (x/y) loaded-count badges on content-pane file-group headers. */
export function updateGroupCounts() {
  const waveformsRoot = document.getElementById("waveforms");
  if (!waveformsRoot) return;
  waveformsRoot.querySelectorAll(".file-group").forEach((fg) => {
    if (fg.classList.contains("file-group-score")) return;
    const badge = fg.querySelector(".group-count");
    if (!badge) return;
    // Total from nav sidebar (always present), visible from content-pane waveforms
    const navCbs = _getNavCheckboxesForGroup(fg);
    const total = navCbs.length;
    const list = fg.querySelector(".group-list");
    const wfs = list ? list.querySelectorAll(".waveform") : [];
    const vis = Array.from(wfs).filter(
      (w) => w.style.display !== "none",
    ).length;
    badge.textContent = total > 0 ? `(${vis}/${total})` : "";
  });
}

/** Persist the current group ordering into loadedAlignmentJSON.header.fileGroups */
function _persistGroupOrder() {
  if (!loadedAlignmentJSON) return;
  if (!loadedAlignmentJSON.header) loadedAlignmentJSON.header = {};

  // Preserve existing group properties (pattern, color) by name
  const oldGroups = getActiveFileGroups();
  const oldByName = {};
  oldGroups.forEach((g) => {
    oldByName[g.name] = g;
  });

  const waveformsRoot = document.getElementById("waveforms");
  const groups = [];
  Array.from(waveformsRoot.querySelectorAll(".file-group")).forEach((fg) => {
    const gname = fg.dataset.group || "Ungrouped";
    if (gname === "Score") return;
    const list = fg.querySelector(".group-list");
    const files = Array.from(list.querySelectorAll(".waveform"))
      .map((w) => w.dataset.ix)
      .filter(Boolean);
    const old = oldByName[gname] || {};
    const entry = { name: gname, files };
    if (old.pattern) entry.pattern = old.pattern;
    if (old.color) entry.color = old.color;
    groups.push(entry);
  });
  setActiveFileGroups(groups);

  // Persist full group display order using data-group values
  const groupOrder = Array.from(
    waveformsRoot.querySelectorAll(".file-group"),
  ).map((fg) => fg.dataset.group || "Ungrouped");
  setActiveGroupOrder(groupOrder);

  bumpChangeCounter();
  updateDirtyState();
}

function _wireListSelectors() {
  document.querySelectorAll(".listSelectors .all").forEach((selector) =>
    selector.addEventListener("click", (e) => {
      e.target
        .closest("fieldset.audio-group")
        .querySelectorAll("input")
        .forEach((cb) => {
          if (!cb.checked) cb.click();
        });
    }),
  );
  document.querySelectorAll(".listSelectors .none").forEach((selector) =>
    selector.addEventListener("click", (e) => {
      e.target
        .closest("fieldset.audio-group")
        .querySelectorAll("input")
        .forEach((cb) => {
          if (cb.checked) cb.click();
        });
    }),
  );
}
