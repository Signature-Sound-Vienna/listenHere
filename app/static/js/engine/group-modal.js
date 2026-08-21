// engine/group-modal.js
//
// The Group Recordings modal: the editor where the user creates groups, drags
// recordings into and between them, adds them by filename or regex, renames and
// reorders tabs, and picks group colours. One exported entry point,
// openGroupModal(), which builds the whole dialog and tears it down again.
//
// It is deliberately ONE closure rather than a set of module-level functions.
// Everything the modal knows — the working copy of the tabs, which tab is
// active, the ungrouped selection and its shift-click anchor, the in-flight drag
// payload, and the DOM nodes the render functions write into — is per-OPEN
// state: minted fresh on every call and dead when the dialog closes. Hoisting it
// to module level would make it a singleton that has to be reset by hand, so the
// nesting is load-bearing, not an accident of the extraction.
//
// The modal edits a deep CLONE of header.groupingTabs and touches nothing else
// until Apply. applyChanges is the only path that writes back, and the only
// place this module reaches into the app: it marks the document dirty, re-renders
// the sidebar and the tab pills, rebuilds the waveform pane, and announces the
// change. Cancel, the ✕, Esc, and a backdrop click all route through
// attemptClose, which offers Apply / Discard / Keep editing whenever the clone
// has diverged from the snapshot taken when the dialog opened.
//
// Membership, colours, and persistence are NOT decided here — they come from
// engine/grouping-model.js. The one exception is the pattern→files expansion at
// the top of openGroupModal, which is a migration rather than a view concern:
// older saved groups could claim recordings by regex `pattern`, and the modal
// replaces that with explicit, individually removable members. The expansion is
// first-wins within a tab, so it cannot mint the double membership roadmap item
// U outlawed.
//
// Extracted from listen.js (Phase 1 refactor, cluster J, slice 2).

import {
  alignmentGrids,
  bumpChangeCounter,
  loadedAlignmentJSON,
  reloadWaveforms,
  renderGroupingTabPills,
  renderSidebarFileList,
  setLoadedAlignmentJSON,
  SYNTH_MEI_KEY,
  updateDirtyState,
} from "../listen.js";
import {
  GROUP_PALETTE,
  emitGroupingChanged,
  groupTextColor,
  matchesGroup,
  migrateToGroupingTabs,
  mintGroupId,
  nextGroupColour,
} from "./grouping-model.js";

/** Open the grouping modal. */
export function openGroupModal() {
  // Remove any existing modal
  document.getElementById("group-modal-backdrop")?.remove();

  const filenames = Object.keys(alignmentGrids)
    .filter((n) => n !== SYNTH_MEI_KEY)
    .sort();

  // Deep-clone all tabs for editing; modal edits this clone until Apply
  migrateToGroupingTabs();
  const h = loadedAlignmentJSON?.header || {};
  let modalTabs = JSON.parse(
    JSON.stringify(
      h.groupingTabs || [{ name: "Default", fileGroups: [], groupOrder: [] }],
    ),
  );
  let modalActiveIdx = Math.max(
    0,
    modalTabs.findIndex((t) => t.name === (h.activeTab || "Default")),
  );

  // Expand any stored regex `pattern` into explicit file members so that every
  // file in a group is individually removable. We only edit the modal clone;
  // nothing is persisted until Apply. (Backwards-compat: older saved groups
  // may carry a `pattern`; once expanded here we drop it.)
  //
  // Expansion honours first-wins within the tab: a recording already claimed by
  // an earlier group is not added to a later one. Without that, expanding two
  // overlapping patterns would mint the explicit double membership that the rest
  // of the app treats as a defect (roadmap item U) — and unlike a pattern, an
  // explicit `files` entry survives every later save.
  modalTabs.forEach((tab) => {
    const tabGroups = tab.fileGroups || [];
    tabGroups.forEach((g, gi) => {
      if (g.pattern) {
        try {
          const re = new RegExp(g.pattern);
          if (!g.files) g.files = [];
          const earlier = tabGroups.slice(0, gi);
          filenames.forEach((f) => {
            if (!(re.test(shortName(f)) || re.test(f))) return;
            if (g.files.includes(f)) return;
            if (earlier.some((og) => matchesGroup(f, og))) return;
            g.files.push(f);
          });
        } catch (_) {
          /* invalid regex — just drop it */
        }
        delete g.pattern;
      }
    });
  });

  // Baseline snapshot taken AFTER migration, so the pattern→files expansion
  // doesn't count as a user edit. Used to detect unapplied changes on close.
  const initialSnapshot = JSON.stringify(modalTabs);
  function hasUnappliedChanges() {
    return JSON.stringify(modalTabs) !== initialSnapshot;
  }

  /** Convenience: current modal tab's groups array */
  function groups() {
    return modalTabs[modalActiveIdx].fileGroups;
  }

  // Multi-select state for the ungrouped list. Holds full filenames.
  let selectedUngrouped = new Set();
  // Index of the last clicked ungrouped item, for shift-click range select.
  let lastUngroupedAnchor = -1;

  // Recordings currently being dragged within the modal. Tracked here because
  // dataTransfer is unreadable during dragover (only on drop), yet we need the
  // payload to preview a hovered drop target.
  let draggedFiles = [];

  /** Remove any drag-hover previews and target highlights from all groups. */
  function clearDragPreviews() {
    groupsContainer
      .querySelectorAll("li.gm-drag-preview")
      .forEach((el) => el.remove());
    groupsContainer
      .querySelectorAll(".gm-drop-target")
      .forEach((c) => c.classList.remove("gm-drop-target"));
    groupsContainer
      .querySelectorAll("li.gm-empty")
      .forEach((el) => (el.style.display = ""));
  }

  // "Add by filename" mode: substring (default) or regular expression. Global
  // preference, persisted across sessions.
  let addByRegex = false;
  try {
    addByRegex = localStorage.getItem("listenTool_addByRegex") === "1";
  } catch (_) {}

  /** Does file `f` match the typed `term` under the current add-by mode? */
  function addByMatches(f, term) {
    if (!term) return false;
    if (addByRegex) {
      try {
        // Case-insensitive by default, consistent with substring mode.
        const re = new RegExp(term, "i");
        return re.test(f.substring(f.lastIndexOf("/") + 1)) || re.test(f);
      } catch (_) {
        return false; // invalid regex matches nothing
      }
    }
    const t = term.toLowerCase();
    return f.substring(f.lastIndexOf("/") + 1).toLowerCase().includes(t);
  }

  // --- Build modal DOM ---
  const backdrop = document.createElement("div");
  backdrop.id = "group-modal-backdrop";
  backdrop.className = "gm-backdrop";

  const modal = document.createElement("div");
  modal.className = "gm-modal";

  // Header
  const header = document.createElement("div");
  header.className = "gm-header";
  header.innerHTML = `<h3>Group Recordings</h3>`;
  const closeBtn = document.createElement("button");
  closeBtn.className = "gm-close";
  closeBtn.innerHTML = "\u2715";
  // Close handler wired below (attemptClose) so it can guard unapplied changes.
  header.appendChild(closeBtn);
  modal.appendChild(header);

  // --- Tab bar ---
  const tabBar = document.createElement("div");
  tabBar.className = "gm-tab-bar";
  modal.appendChild(tabBar);

  // Body: two panes
  const body = document.createElement("div");
  body.className = "gm-body";

  // Left pane: ungrouped files
  const leftPane = document.createElement("div");
  leftPane.className = "gm-pane gm-left";
  leftPane.innerHTML = `<h4>Ungrouped Recordings</h4>`;
  const ungroupedList = document.createElement("ul");
  ungroupedList.className = "gm-file-list";
  ungroupedList.id = "gm-ungrouped";
  leftPane.appendChild(ungroupedList);
  body.appendChild(leftPane);

  // Make the ungrouped pane a drop target so files can be dragged back out of
  // groups. Dropping here removes them from every group's explicit list.
  leftPane.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    leftPane.classList.add("gm-drop-target");
  });
  leftPane.addEventListener("dragleave", (e) => {
    if (!leftPane.contains(e.relatedTarget))
      leftPane.classList.remove("gm-drop-target");
  });
  leftPane.addEventListener("drop", (e) => {
    e.preventDefault();
    leftPane.classList.remove("gm-drop-target");
    const dropped = (e.dataTransfer.getData("text/plain") || "")
      .split("\n")
      .filter((f) => f && filenames.includes(f));
    if (!dropped.length) return;
    let changed = false;
    groups().forEach((og) => {
      const before = (og.files || []).length;
      og.files = (og.files || []).filter((x) => !dropped.includes(x));
      if (og.files.length !== before) changed = true;
    });
    if (changed) renderAll();
  });

  // Right pane: groups
  const rightPane = document.createElement("div");
  rightPane.className = "gm-pane gm-right";
  const rightHeader = document.createElement("div");
  rightHeader.className = "gm-right-header";
  rightHeader.innerHTML = `<h4>Groups</h4>`;
  const addGroupBtn = document.createElement("button");
  addGroupBtn.className = "gm-add-group";
  addGroupBtn.textContent = "+ New Group";
  addGroupBtn.addEventListener("click", () => {
    groups().push({
      id: mintGroupId(),
      name: "New Group",
      pattern: "",
      files: [],
      color: nextGroupColour(groups()),
    });
    renderGroups();
  });
  rightHeader.appendChild(addGroupBtn);
  rightPane.appendChild(rightHeader);

  const groupsContainer = document.createElement("div");
  groupsContainer.className = "gm-groups-container";
  groupsContainer.id = "gm-groups-container";
  rightPane.appendChild(groupsContainer);
  body.appendChild(rightPane);

  modal.appendChild(body);

  // Footer
  const footer = document.createElement("div");
  footer.className = "gm-footer";
  const cancelBtn = document.createElement("button");
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", attemptClose);
  const applyBtn = document.createElement("button");
  applyBtn.className = "gm-apply";
  applyBtn.textContent = "Apply";
  applyBtn.addEventListener("click", applyChanges);
  footer.appendChild(cancelBtn);
  footer.appendChild(applyBtn);
  modal.appendChild(footer);

  /** Persist modalTabs back to the alignment JSON and refresh the UI. */
  function applyChanges() {
    // Write all tabs back to the alignment JSON header
    if (!loadedAlignmentJSON) setLoadedAlignmentJSON({});
    if (!loadedAlignmentJSON.header) loadedAlignmentJSON.header = {};
    loadedAlignmentJSON.header.groupingTabs = modalTabs;
    // Keep activeTab unchanged (modal does not switch content pane live)
    // But ensure activeTab name still exists; if it was renamed/deleted, fall back
    const tabNames = new Set(modalTabs.map((t) => t.name));
    if (!tabNames.has(loadedAlignmentJSON.header.activeTab)) {
      loadedAlignmentJSON.header.activeTab = modalTabs[0].name;
    }
    bumpChangeCounter();
    updateDirtyState();
    backdrop.remove();
    // Re-render sidebar + content pane + pills
    const fns = Object.keys(alignmentGrids)
      .filter((n) => n !== SYNTH_MEI_KEY)
      .sort();
    renderSidebarFileList(fns);
    renderGroupingTabPills();
    reloadWaveforms();
    emitGroupingChanged();
  }

  /**
   * Dismiss the modal via an ambiguous gesture (backdrop click or ✕). If there
   * are unapplied changes, ask whether to apply or discard them first, so an
   * accidental click doesn't silently throw away the user's work.
   */
  function attemptClose() {
    if (!hasUnappliedChanges()) {
      backdrop.remove();
      return;
    }
    // Avoid stacking multiple confirm overlays.
    if (modal.querySelector(".gm-confirm-overlay")) return;

    const overlay = document.createElement("div");
    overlay.className = "gm-confirm-overlay";
    const box = document.createElement("div");
    box.className = "gm-confirm-box";
    const msg = document.createElement("p");
    msg.className = "gm-confirm-msg";
    msg.textContent = "You have unapplied changes to your file groups.";
    box.appendChild(msg);

    const btnRow = document.createElement("div");
    btnRow.className = "gm-confirm-buttons";
    const keepBtn = document.createElement("button");
    keepBtn.textContent = "Keep editing";
    keepBtn.addEventListener("click", () => overlay.remove());
    const discardBtn = document.createElement("button");
    discardBtn.className = "gm-confirm-discard";
    discardBtn.textContent = "Discard";
    discardBtn.addEventListener("click", () => backdrop.remove());
    const applyConfirmBtn = document.createElement("button");
    applyConfirmBtn.className = "gm-apply";
    applyConfirmBtn.textContent = "Apply";
    applyConfirmBtn.addEventListener("click", applyChanges);
    btnRow.appendChild(keepBtn);
    btnRow.appendChild(discardBtn);
    btnRow.appendChild(applyConfirmBtn);
    box.appendChild(btnRow);
    overlay.appendChild(box);
    modal.appendChild(overlay);
    applyConfirmBtn.focus();
  }

  closeBtn.addEventListener("click", attemptClose);

  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  // Close on backdrop click (guards against discarding unapplied changes)
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) attemptClose();
  });

  // Esc closes the modal (with the same unapplied-changes guard), unless focus
  // is in a text field — there Esc belongs to the field (e.g. cancel a rename).
  function onModalKeydown(e) {
    if (!document.body.contains(backdrop)) {
      document.removeEventListener("keydown", onModalKeydown);
      return;
    }
    if (e.key !== "Escape") return;
    const ae = document.activeElement;
    if (
      ae &&
      (ae.tagName === "INPUT" ||
        ae.tagName === "TEXTAREA" ||
        ae.isContentEditable)
    )
      return;
    e.preventDefault();
    // If the confirm overlay is up, Esc means "keep editing" (dismiss it).
    const overlay = modal.querySelector(".gm-confirm-overlay");
    if (overlay) {
      overlay.remove();
      return;
    }
    attemptClose();
  }
  document.addEventListener("keydown", onModalKeydown);

  // --- Tab bar rendering ---
  function renderTabBar() {
    tabBar.innerHTML = "";
    modalTabs.forEach((tab, idx) => {
      const tabEl = document.createElement("span");
      tabEl.className = "gm-tab" + (idx === modalActiveIdx ? " active" : "");

      const label = document.createElement("span");
      label.className = "gm-tab-label";
      label.textContent = tab.name;
      label.title = "Click to switch, double-click to rename";
      tabEl.appendChild(label);

      // Click to switch (skip re-render if already active, so dblclick can fire)
      tabEl.addEventListener("click", (e) => {
        if (e.target.classList.contains("gm-tab-close")) return;
        if (idx === modalActiveIdx) return;
        modalActiveIdx = idx;
        renderTabBar();
        renderAll();
      });

      // Double-click to rename (inline edit)
      label.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        const input = document.createElement("input");
        input.type = "text";
        input.className = "gm-tab-rename";
        input.value = tab.name;
        input.style.width = Math.max(60, label.offsetWidth + 10) + "px";
        label.replaceWith(input);
        input.focus();
        input.select();
        const commit = () => {
          const newName = input.value.trim();
          if (newName && newName !== tab.name) {
            tab.name = newName;
          }
          renderTabBar();
          renderAll();
        };
        input.addEventListener("blur", commit);
        input.addEventListener("keydown", (ke) => {
          if (ke.key === "Enter") {
            ke.preventDefault();
            input.blur();
          }
          if (ke.key === "Escape") {
            input.value = tab.name;
            input.blur();
          }
        });
      });

      // Delete button (not on the first tab)
      if (modalTabs.length > 1) {
        const del = document.createElement("span");
        del.className = "gm-tab-close";
        del.textContent = "\u2715";
        del.title = "Delete tab";
        del.addEventListener("click", (e) => {
          e.stopPropagation();
          const hasGroups = tab.fileGroups && tab.fileGroups.length > 0;
          if (
            hasGroups &&
            !confirm(
              `Delete tab "${tab.name}" and its ${tab.fileGroups.length} group(s)?`,
            )
          )
            return;
          if (!hasGroups && !confirm(`Delete tab "${tab.name}"?`)) return;
          modalTabs.splice(idx, 1);
          if (modalActiveIdx >= modalTabs.length)
            modalActiveIdx = modalTabs.length - 1;
          if (modalActiveIdx < 0) modalActiveIdx = 0;
          renderTabBar();
          renderAll();
        });
        tabEl.appendChild(del);
      }

      tabBar.appendChild(tabEl);
    });

    // "+" add tab button
    const addTab = document.createElement("span");
    addTab.className = "gm-tab gm-tab-add";
    addTab.textContent = "+";
    addTab.title = "Add new tab";
    addTab.addEventListener("click", () => {
      let n = modalTabs.length + 1;
      let name = `Tab ${n}`;
      while (modalTabs.some((t) => t.name === name)) {
        n++;
        name = `Tab ${n}`;
      }
      modalTabs.push({ name, fileGroups: [], groupOrder: [] });
      modalActiveIdx = modalTabs.length - 1;
      renderTabBar();
      renderAll();
    });
    tabBar.appendChild(addTab);
  }

  // --- Internal helpers to render the modal contents ---
  function shortName(f) {
    return f.substring(f.lastIndexOf("/") + 1);
  }

  /** Compute which files are claimed by any group (all explicit now). */
  function getGroupedSet() {
    const s = new Set();
    groups().forEach((g) => {
      (g.files || []).forEach((f) => s.add(f));
    });
    return s;
  }

  function renderUngrouped() {
    ungroupedList.innerHTML = "";
    const grouped = getGroupedSet();
    const ug = filenames.filter((f) => !grouped.has(f));
    // Drop any stale selections (files that got grouped elsewhere).
    selectedUngrouped.forEach((f) => {
      if (!ug.includes(f)) selectedUngrouped.delete(f);
    });
    ug.forEach((f, idx) => {
      const li = document.createElement("li");
      li.className = "gm-file-item";
      if (selectedUngrouped.has(f)) li.classList.add("gm-selected");
      li.draggable = true;
      li.dataset.file = f;
      li.textContent = shortName(f);
      li.title = f;

      // Click to (multi-)select. Plain click selects just this item;
      // Cmd/Ctrl-click toggles; Shift-click selects a contiguous range.
      li.addEventListener("click", (e) => {
        if (e.shiftKey && lastUngroupedAnchor >= 0) {
          const lo = Math.min(lastUngroupedAnchor, idx);
          const hi = Math.max(lastUngroupedAnchor, idx);
          if (!e.metaKey && !e.ctrlKey) selectedUngrouped.clear();
          for (let k = lo; k <= hi; k++) selectedUngrouped.add(ug[k]);
        } else if (e.metaKey || e.ctrlKey) {
          if (selectedUngrouped.has(f)) selectedUngrouped.delete(f);
          else selectedUngrouped.add(f);
          lastUngroupedAnchor = idx;
        } else {
          selectedUngrouped.clear();
          selectedUngrouped.add(f);
          lastUngroupedAnchor = idx;
        }
        renderUngrouped();
      });

      li.addEventListener("dragstart", (e) => {
        // If dragging an unselected item, reduce selection to just it. Update
        // the highlight in place — calling renderUngrouped() here would destroy
        // the very element being dragged and cancel the drag (requiring a
        // second attempt).
        if (!selectedUngrouped.has(f)) {
          selectedUngrouped.clear();
          selectedUngrouped.add(f);
          lastUngroupedAnchor = idx;
          ungroupedList.querySelectorAll(".gm-file-item").forEach((el) => {
            el.classList.toggle("gm-selected", el.dataset.file === f);
          });
        }
        // Drag the whole current selection; one filename per line.
        const payload = [...selectedUngrouped].join("\n");
        draggedFiles = [...selectedUngrouped];
        e.dataTransfer.setData("text/plain", payload);
        e.dataTransfer.effectAllowed = "move";
        // When dragging more than one file, show a count badge as the drag
        // image so it's clear the whole selection is moving.
        if (selectedUngrouped.size > 1) {
          const ghost = document.createElement("div");
          ghost.className = "gm-drag-ghost";
          ghost.textContent = `${selectedUngrouped.size} files`;
          document.body.appendChild(ghost);
          e.dataTransfer.setDragImage(ghost, 10, 10);
          // Remove the ghost once the browser has snapshotted it.
          setTimeout(() => ghost.remove(), 0);
        }
        // Mark all selected items as dragging.
        ungroupedList
          .querySelectorAll(".gm-selected")
          .forEach((el) => el.classList.add("gm-dragging"));
      });
      li.addEventListener("dragend", () => {
        ungroupedList
          .querySelectorAll(".gm-dragging")
          .forEach((el) => el.classList.remove("gm-dragging"));
        draggedFiles = [];
        clearDragPreviews();
      });
      ungroupedList.appendChild(li);
    });
    if (ug.length === 0) {
      ungroupedList.innerHTML =
        '<li class="gm-empty">All recordings are grouped</li>';
    }
  }

  function renderGroups() {
    groupsContainer.innerHTML = "";
    const grps = groups();
    grps.forEach((g, i) => {
      const card = document.createElement("div");
      card.className = "gm-group-card";

      // Group header: name input + controls
      const gh = document.createElement("div");
      gh.className = "gm-group-header";

      const nameInput = document.createElement("input");
      nameInput.type = "text";
      nameInput.className = "gm-group-name";
      nameInput.value = g.name;
      nameInput.addEventListener("input", (e) => {
        g.name = e.target.value;
      });
      gh.appendChild(nameInput);

      // Move up
      if (i > 0) {
        const upBtn = document.createElement("button");
        upBtn.className = "gm-icon-btn";
        upBtn.title = "Move up";
        upBtn.textContent = "\u25B2";
        upBtn.addEventListener("click", () => {
          [grps[i - 1], grps[i]] = [grps[i], grps[i - 1]];
          renderAll();
        });
        gh.appendChild(upBtn);
      }
      // Move down
      if (i < grps.length - 1) {
        const downBtn = document.createElement("button");
        downBtn.className = "gm-icon-btn";
        downBtn.title = "Move down";
        downBtn.textContent = "\u25BC";
        downBtn.addEventListener("click", () => {
          [grps[i], grps[i + 1]] = [grps[i + 1], grps[i]];
          renderAll();
        });
        gh.appendChild(downBtn);
      }
      // Delete
      const delBtn = document.createElement("button");
      delBtn.className = "gm-icon-btn gm-delete";
      delBtn.title = "Delete group";
      delBtn.textContent = "\u2715";
      delBtn.addEventListener("click", () => {
        grps.splice(i, 1);
        renderAll();
      });
      gh.appendChild(delBtn);
      card.appendChild(gh);

      // "Add by filename" bulk-add: pulls all ungrouped files whose name
      // contains the typed text into this group as regular (removable) members.
      const addRow = document.createElement("div");
      addRow.className = "gm-addby-row";
      const addLabel = document.createElement("label");
      addLabel.textContent = "Add by filename:";
      const addInput = document.createElement("input");
      addInput.type = "text";
      addInput.className = "gm-addby-input";
      addInput.placeholder = addByRegex
        ? "regex, e.g. ^Karajan"
        : "type text, e.g. Karajan";

      // Regex-mode toggle (VS Code-style ".*" icon). Off/grey by default.
      const regexToggle = document.createElement("button");
      regexToggle.type = "button";
      regexToggle.className =
        "gm-regex-toggle" + (addByRegex ? " gm-active" : "");
      regexToggle.textContent = ".*";
      regexToggle.title = "Use regular expressions when adding by filename";
      regexToggle.setAttribute("aria-pressed", String(addByRegex));
      regexToggle.addEventListener("click", () => {
        addByRegex = !addByRegex;
        try {
          localStorage.setItem("listenTool_addByRegex", addByRegex ? "1" : "0");
        } catch (_) {}
        renderGroups();
      });

      const addBtn = document.createElement("button");
      addBtn.className = "gm-addby-btn";
      addBtn.textContent = "Add";

      // Files that the current term would add (ungrouped + matching).
      const previewMatches = () => {
        const term = addInput.value.trim();
        if (!term) return [];
        const grouped = getGroupedSet();
        return filenames.filter(
          (f) => !grouped.has(f) && addByMatches(f, term),
        );
      };

      const doAdd = () => {
        const matches = previewMatches();
        if (!matches.length) return;
        if (!g.files) g.files = [];
        matches.forEach((f) => {
          if (!g.files.includes(f)) g.files.push(f);
        });
        addInput.value = "";
        renderAll();
      };
      addBtn.addEventListener("click", doAdd);
      addInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          doAdd();
        }
      });
      // Live preview: greyed-out entries showing what Enter/Add would pull in.
      const renderPreview = () => {
        fileUl.querySelectorAll("li.gm-preview").forEach((el) => el.remove());
        let invalid = false;
        const term = addInput.value.trim();
        if (addByRegex && term) {
          try {
            new RegExp(term, "i");
          } catch (_) {
            invalid = true;
          }
        }
        addInput.classList.toggle("gm-invalid", invalid);
        const matches = previewMatches().sort();
        // Hide the "Drag files here…" placeholder while previewing.
        const empty = fileUl.querySelector("li.gm-empty");
        if (empty) empty.style.display = matches.length ? "none" : "";
        matches.forEach((f) => {
          const li = document.createElement("li");
          li.className = "gm-file-item gm-grouped gm-preview";
          li.textContent = shortName(f);
          li.title = f + " — press Add to include";
          fileUl.appendChild(li);
        });
      };
      addInput.addEventListener("input", renderPreview);

      addRow.appendChild(addLabel);
      addRow.appendChild(addInput);
      addRow.appendChild(regexToggle);
      addRow.appendChild(addBtn);
      card.appendChild(addRow);

      // Colour picker row
      const colourRow = document.createElement("div");
      colourRow.className = "gm-colour-row";
      const colourLabel = document.createElement("label");
      colourLabel.textContent = "Colour:";
      // Palette swatches
      const swatchContainer = document.createElement("span");
      swatchContainer.className = "gm-swatch-container";
      GROUP_PALETTE.forEach((c) => {
        const swatch = document.createElement("span");
        swatch.className = "gm-swatch";
        if (g.color === c) swatch.classList.add("gm-swatch-selected");
        swatch.style.backgroundColor = c;
        swatch.title = c;
        swatch.addEventListener("click", () => {
          g.color = c;
          renderGroups();
        });
        swatchContainer.appendChild(swatch);
      });
      // Custom colour input
      const colourInput = document.createElement("input");
      colourInput.type = "color";
      colourInput.className = "gm-colour-input";
      colourInput.value = g.color || nextGroupColour(grps);
      colourInput.title = "Choose a custom colour";
      colourInput.addEventListener("input", (e) => {
        g.color = e.target.value;
        renderGroups();
      });
      // Clear button
      const clearBtn = document.createElement("button");
      clearBtn.className = "gm-icon-btn gm-colour-clear";
      clearBtn.title = "Remove colour";
      clearBtn.textContent = "\u2715";
      clearBtn.addEventListener("click", () => {
        g.color = "";
        renderGroups();
      });
      colourRow.appendChild(colourLabel);
      colourRow.appendChild(swatchContainer);
      colourRow.appendChild(colourInput);
      colourRow.appendChild(clearBtn);
      card.appendChild(colourRow);

      // Apply colour preview to card. The palette is a fixed set of pale
      // pastels that ignores the theme, so the theme's text variables are wrong
      // inside a coloured card — in dark mode near-white filenames landed on a
      // pale background. `gm-has-colour` lets one CSS rule hand the card's own
      // contrast colour to the descendants that set a colour of their own
      // (see default.css); it replaces an inline per-label sweep that had to be
      // extended by hand for every new element type.
      if (g.color) {
        card.style.backgroundColor = g.color;
        card.style.color = groupTextColor(g.color);
        card.classList.add("gm-has-colour");
      }

      // File list — every member is an explicit, removable file.
      const fileUl = document.createElement("ul");
      fileUl.className = "gm-group-files";

      const memberArr = (g.files || [])
        .filter((f) => filenames.includes(f))
        .sort();
      memberArr.forEach((f) => {
        const li = document.createElement("li");
        li.className = "gm-file-item gm-grouped";
        li.draggable = true;
        li.dataset.file = f;
        li.textContent = shortName(f);
        li.title = f;
        // Drag a grouped file to another group, or back to the ungrouped pane.
        li.addEventListener("dragstart", (e) => {
          e.dataTransfer.setData("text/plain", f);
          draggedFiles = [f];
          e.dataTransfer.effectAllowed = "move";
          li.classList.add("gm-dragging");
        });
        li.addEventListener("dragend", () => {
          li.classList.remove("gm-dragging");
          draggedFiles = [];
          clearDragPreviews();
        });
        const rmBtn = document.createElement("button");
        rmBtn.className = "gm-remove-file";
        rmBtn.textContent = "\u2715";
        rmBtn.title = "Remove from group";
        rmBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          g.files = (g.files || []).filter((x) => x !== f);
          renderAll();
        });
        li.appendChild(rmBtn);
        fileUl.appendChild(li);
      });
      if (memberArr.length === 0) {
        fileUl.innerHTML =
          '<li class="gm-empty">Drag recordings here, or add by filename above</li>';
      }

      // Drop zone
      card.addEventListener("dragover", (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        card.classList.add("gm-drop-target");
        // Preview the recordings this drop would add (greyed-out), unless
        // they're already members. Rendered once per hover.
        if (!fileUl.querySelector("li.gm-drag-preview")) {
          const toAdd = draggedFiles.filter(
            (f) => filenames.includes(f) && !(g.files || []).includes(f),
          );
          if (toAdd.length) {
            const empty = fileUl.querySelector("li.gm-empty");
            if (empty) empty.style.display = "none";
            toAdd.sort().forEach((f) => {
              const pli = document.createElement("li");
              pli.className = "gm-file-item gm-grouped gm-drag-preview";
              pli.textContent = shortName(f);
              pli.title = f;
              fileUl.appendChild(pli);
            });
          }
        }
      });
      card.addEventListener("dragleave", (e) => {
        // Ignore leave events fired when moving onto a child element.
        if (card.contains(e.relatedTarget)) return;
        card.classList.remove("gm-drop-target");
        fileUl.querySelectorAll("li.gm-drag-preview").forEach((el) =>
          el.remove(),
        );
        const empty = fileUl.querySelector("li.gm-empty");
        if (empty) empty.style.display = "";
      });
      card.addEventListener("drop", (e) => {
        e.preventDefault();
        card.classList.remove("gm-drop-target");
        const dropped = (e.dataTransfer.getData("text/plain") || "")
          .split("\n")
          .filter((f) => f && filenames.includes(f));
        if (dropped.length) {
          dropped.forEach((file) => {
            // Remove from any other group's explicit list
            grps.forEach((og) => {
              og.files = (og.files || []).filter((x) => x !== file);
            });
            if (!g.files) g.files = [];
            if (!g.files.includes(file)) g.files.push(file);
          });
          selectedUngrouped.clear();
          lastUngroupedAnchor = -1;
          renderAll();
        }
      });

      card.appendChild(fileUl);
      groupsContainer.appendChild(card);
    });

    // Drag-to-create target at the bottom (also serves as the empty state):
    // dropping files here mints a new group containing them — no need to click
    // "+ New Group" first.
    const dropNew = document.createElement("div");
    dropNew.className = "gm-newgroup-dropzone";
    dropNew.textContent =
      grps.length === 0
        ? "No groups yet — drag recordings here to create one (or click + New Group)"
        : "Drag recordings here to create a new group (or click + New Group)";
    dropNew.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      dropNew.classList.add("gm-drop-target");
    });
    dropNew.addEventListener("dragleave", () =>
      dropNew.classList.remove("gm-drop-target"),
    );
    dropNew.addEventListener("drop", (e) => {
      e.preventDefault();
      dropNew.classList.remove("gm-drop-target");
      const dropped = (e.dataTransfer.getData("text/plain") || "")
        .split("\n")
        .filter((f) => f && filenames.includes(f));
      if (!dropped.length) return;
      // Pull the files out of any group they were in, then mint a new group.
      grps.forEach((og) => {
        og.files = (og.files || []).filter((x) => !dropped.includes(x));
      });
      grps.push({
        id: mintGroupId(),
        name: "New Group",
        files: dropped,
        color: nextGroupColour(grps),
      });
      selectedUngrouped.clear();
      lastUngroupedAnchor = -1;
      renderAll();
    });
    groupsContainer.appendChild(dropNew);
  }

  function renderAll() {
    renderUngrouped();
    renderGroups();
  }

  renderTabBar();
  renderAll();
}
