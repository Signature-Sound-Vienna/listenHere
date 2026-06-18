// V6 annotation — drawer body in EDIT mode.
//
// Section order (Phase D): Identity → Description → Recordings → Group notes
// → Comparisons. The user-facing order deviates from the V6 prototype's
// (which placed Recordings last) so the chain-enforced upstream sections
// (group notes need per-recording notes; comparisons need group notes) read
// in the order the user must populate them. Disabled inputs with tooltips
// communicate the dependency when prerequisites are missing.
//
// All editable inputs carry a stable `data-v6-key` so the drawer can restore
// focus + selection across re-renders.

import * as state from "./state.js";
import { el, confirmRemoveIfTextful, confirmRepin } from "./ui-common.js";
import { getActiveGroupingSnapshot } from "../listen.js";

// Custom drag MIME for transferring a detached (removed-group) note onto a
// group note. Scoping to our own type means group-note textareas only
// intercept OUR drags — native text drag-and-drop into the textarea still
// works as usual.
const DETACHED_MIME = "application/x-lh-detached-note";

/** Join dropped text onto existing field content (blank-line, or space for single-line inputs). */
function _joinNote(cur, text, singleLine) {
  if (!cur || !cur.trim()) return text;
  return cur.replace(/\s*$/, "") + (singleLine ? " " : "\n\n") + text;
}

/**
 * Wire an <input>/<textarea> as a detached-note drop target. `append(text)`
 * is invoked with the dropped note text on a successful drop. We only react
 * to our own MIME, so native text drag-and-drop into the field still works.
 */
function _wireNoteDrop(node, append) {
  const carries = (e) =>
    Array.from(e.dataTransfer.types || []).includes(DETACHED_MIME);
  node.addEventListener("dragover", (e) => {
    if (!carries(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    node.classList.add("lh-v6-drop-target");
  });
  node.addEventListener("dragleave", () => node.classList.remove("lh-v6-drop-target"));
  node.addEventListener("drop", (e) => {
    if (!carries(e)) return;
    e.preventDefault();
    node.classList.remove("lh-v6-drop-target");
    const text =
      e.dataTransfer.getData(DETACHED_MIME) || e.dataTransfer.getData("text/plain");
    if (text) append(text);
  });
}

export function renderEditor(ann) {
  const root = el("div", { class: "lh-v6-editor" });
  root.appendChild(_identitySection(ann));
  root.appendChild(_descriptionSection(ann));
  root.appendChild(_recordingsSection(ann));
  // Grouping section is always present so the "Update groups to current view"
  // affordance is reachable even when nothing is pinned yet.
  root.appendChild(_groupingSection(ann));
  const groupCount = ann.pinnedGrouping ? ann.pinnedGrouping.groups.length : 0;
  if (groupCount >= 2) {
    root.appendChild(_comparisonsSection(ann));
  }
  return root;
}

/**
 * Re-pin: adopt the current application grouping into this annotation, behind
 * a diff-confirmation dialog. Computes the snapshot fresh at click time (the
 * grouping may have changed since the editor last rendered).
 */
async function _doRepin(ann) {
  const snapshot = getActiveGroupingSnapshot();
  if (!snapshot) {
    window.alert("No grouping is available — load an alignment with groups first.");
    return;
  }
  const diff = state.diffGrouping(ann, snapshot);
  if (!diff.changed) {
    window.alert("The annotation's grouping already matches the current view.");
    return;
  }
  const ok = await confirmRepin(diff, ann.published);
  if (ok) state.repinGrouping(ann.id, snapshot);
}

/**
 * Region row for a specific (target, region) pair. Shows the times in
 * that recording's timescale + the duration. Deleting removes the region
 * across every selection (state.removeRegion is global by design).
 */
function _regionRowForTarget(ann, target, region, ix) {
  const rt = target.regionTimes && target.regionTimes[region.id];
  const timeText = rt ? _fmtRange(rt.start, rt.end) : "(no times)";
  const durText = rt ? _fmtDuration(rt.end - rt.start) : "";
  // data-* attributes let waveform-interactions.js's region-update handler
  // find this row by (file, regionId) and patch its text directly during
  // a drag — no state churn until drop.
  return el("li", {
    class: "lh-v6-region-row",
    "data-region-file": target.file,
    "data-region-id": region.id,
  }, [
    el("span", { class: "lh-v6-region-ix", text: "#" + (ix + 1) }),
    el("span", { class: "lh-v6-region-time", text: timeText }),
    el("span", {
      class: "lh-v6-region-dur",
      text: durText || "",
      style: durText ? {} : { display: "none" },
    }),
    region.label
      ? el("span", { class: "lh-v6-region-label", text: region.label })
      : null,
    el("button", {
      class: "lh-v6-region-trash",
      type: "button",
      title: "Remove this region from every recording in this annotation",
      "aria-label": "Remove region",
      text: "🗑",
      onclick: () => {
        const ok = window.confirm(
          "Remove region #" +
            (ix + 1) +
            " from this annotation? It will be deleted from every recording.",
        );
        if (ok) state.removeRegion(ann.id, region.id);
      },
    }),
  ]);
}

export function fmtRegionRange(start, end) {
  const fmt = (t) => {
    const m = Math.floor(t / 60);
    const s = (t % 60).toFixed(2);
    return m + ":" + s.padStart(5, "0");
  };
  if (Math.abs(end - start) < 0.005) return fmt(start) + " (point)";
  return fmt(start) + " – " + fmt(end);
}

export function fmtRegionDuration(d) {
  if (d == null || isNaN(d) || d < 0.005) return "";
  return d.toFixed(2) + "s";
}

// Internal-name aliases keep existing callsites in this file readable.
const _fmtRange = fmtRegionRange;
const _fmtDuration = (d) => fmtRegionDuration(d) || "—";

// ---------------------------------------------------------------------------
// Identity / Description (Phase B; data-v6-key added for focus restore)
// ---------------------------------------------------------------------------

function _identitySection(ann) {
  const sec = el("section", { class: "lh-v6-section lh-v6-section-identity" });
  sec.appendChild(
    el("h3", { class: "lh-v6-section-title", text: "Identity" }),
  );
  const titleInput = el("input", {
    type: "text",
    class: "lh-v6-title-input",
    placeholder: "Annotation title",
    value: ann.label,
    "data-v6-key": "title",
    oninput: (e) =>
      state.updateAnnotationField(ann.id, "label", e.target.value),
  });
  _wireNoteDrop(titleInput, (text) => {
    const cur = state.getById(ann.id)?.label || "";
    state.updateAnnotationField(ann.id, "label", _joinNote(cur, text, true));
  });
  sec.appendChild(
    el("div", { class: "lh-v6-identity-row" }, [
      el("input", {
        type: "color",
        class: "lh-v6-color-picker",
        title: "Annotation color",
        value: ann.color,
        "data-v6-key": "color",
        oninput: (e) =>
          state.updateAnnotationField(ann.id, "color", e.target.value),
      }),
      titleInput,
      el("button", {
        class: "lh-v6-delete-btn",
        type: "button",
        title: "Delete annotation",
        "aria-label": "Delete annotation",
        text: "×",
        onclick: () => {
          if (window.confirm("Delete this annotation?"))
            state.removeAnnotation(ann.id);
        },
      }),
    ]),
  );
  return sec;
}

function _descriptionSection(ann) {
  const sec = el("section", { class: "lh-v6-section" });
  sec.appendChild(
    el("h3", { class: "lh-v6-section-title", text: "Description" }),
  );
  const ta = el("textarea", {
    class: "lh-v6-description-textarea",
    placeholder: "Overall description — what this annotation is about.",
    rows: "3",
    value: ann.description,
    "data-v6-key": "description",
    oninput: (e) =>
      state.updateAnnotationField(ann.id, "description", e.target.value),
  });
  _wireNoteDrop(ta, (text) => {
    const cur = state.getById(ann.id)?.description || "";
    state.updateAnnotationField(ann.id, "description", _joinNote(cur, text));
  });
  sec.appendChild(ta);
  return sec;
}

// ---------------------------------------------------------------------------
// Recordings: attached + detached, per-recording note
// ---------------------------------------------------------------------------

function _recordingsSection(ann) {
  const sec = el("section", { class: "lh-v6-section" });
  sec.appendChild(
    el("h3", { class: "lh-v6-section-title", text: "Recordings" }),
  );
  if (ann.targets.length === 0) {
    sec.appendChild(
      el("p", {
        class: "lh-v6-empty-hint",
        text:
          "No recordings selected yet. While Edit mode is active, click on any waveform to add it as a selection. Drawing a region on a waveform also selects it automatically.",
      }),
    );
    return sec;
  }
  for (const t of ann.targets) {
    sec.appendChild(_recordingTile(ann, t));
  }
  return sec;
}

function _recordingTile(ann, target) {
  const groupLabel = _groupLabelForFile(ann, target.file);
  const children = [
    el("div", { class: "lh-v6-recording-header" }, [
      el("span", {
        class: "lh-v6-recording-filename",
        title: target.file,
        text: target.file,
      }),
      groupLabel
        ? el("span", {
            class: "lh-v6-recording-group-pill",
            style: {
              background: (groupLabel.color || "#94a3b8") + "33",
              borderColor: groupLabel.color || "#94a3b8",
            },
            text: groupLabel.label,
          })
        : null,
      el("button", {
        class: "lh-v6-recording-remove",
        type: "button",
        title: "Remove this recording from the annotation",
        "aria-label": "Remove " + target.file,
        text: "×",
        onclick: () => {
          if (!confirmRemoveIfTextful(target.description)) return;
          state.removeTarget(ann.id, target.file);
        },
      }),
    ]),
    _recordingNoteTextarea(ann, target),
  ];
  // Per-target region list. Each row shows times in this recording's
  // own timescale + duration, with a trash that removes the region
  // across every recording (regions are a global per-annotation concept).
  if (ann.regions && ann.regions.length > 0) {
    const list = el("ol", { class: "lh-v6-regions-list" });
    ann.regions.forEach((r, ix) => {
      list.appendChild(_regionRowForTarget(ann, target, r, ix));
    });
    children.push(list);
  }
  return el("div", { class: "lh-v6-recording-tile" }, children);
}

function _recordingNoteTextarea(ann, target) {
  const ta = el("textarea", {
    class: "lh-v6-recording-note",
    placeholder: "Notes on this recording in this annotation…",
    rows: "2",
    value: target.description || "",
    "data-v6-key": "tgt-note-" + target.file,
    oninput: (e) =>
      state.updateTargetNote(ann.id, target.file, e.target.value),
  });
  _wireNoteDrop(ta, (text) => {
    const cur =
      state.getById(ann.id)?.targets.find((t) => t.file === target.file)
        ?.description || "";
    state.updateTargetNote(ann.id, target.file, _joinNote(cur, text));
  });
  return ta;
}

function _groupLabelForFile(ann, file) {
  if (!ann.pinnedGrouping) return null;
  for (const g of ann.pinnedGrouping.groups) {
    if (g.files.includes(file)) return g;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Group notes: one textarea per pinned group, chain-enforced via
// `at least one attached recording in that group has a per-recording note`.
// ---------------------------------------------------------------------------

function _groupingSection(ann) {
  const sec = el("section", { class: "lh-v6-section" });

  // Header row: title + the deliberate "re-pin to current view" action.
  // Disabled when the pinned grouping already matches the current view. This
  // render-time diff stays accurate because the drawer re-renders the editor
  // on `lh-grouping-changed` (dispatched by listen.js on tab switch / grouping
  // apply) as well as on annotation-state changes. _doRepin recomputes the
  // diff fresh on click as a belt-and-braces guard.
  const snapshot = getActiveGroupingSnapshot();
  const diff = snapshot ? state.diffGrouping(ann, snapshot) : null;
  const canRepin = !!(diff && diff.changed);
  const repinBtn = el("button", {
    class: "lh-v6-group-repin",
    type: "button",
    text: "↻ Update to current view",
    disabled: !canRepin,
    title: !snapshot
      ? "No grouping available — load an alignment with groups first."
      : canRepin
        ? "Adopt the current application grouping into this annotation"
        : "Grouping already matches the current view",
    onclick: () => _doRepin(ann),
  });
  sec.appendChild(
    el("div", { class: "lh-v6-section-title-row" }, [
      el("h3", { class: "lh-v6-section-title", text: "Group notes" }),
      repinBtn,
    ]),
  );

  const groups = (ann.pinnedGrouping && ann.pinnedGrouping.groups) || [];
  if (groups.length === 0) {
    sec.appendChild(
      el("p", {
        class: "lh-v6-empty-hint",
        text: snapshot
          ? "No groups pinned. Click “Update to current view” to adopt the current grouping."
          : "No grouping is loaded.",
      }),
    );
  } else {
    const attached = new Set(ann.targets.map((t) => t.file));
    for (const g of groups) {
      const eligibleFiles = g.files.filter((f) => attached.has(f));
      const hasNote = !!(ann.groupNotes[g.groupId] || "").trim();
      // A group note needs at least one attached recording from this group.
      // Exception: when a note already exists (e.g. an imported group whose
      // recordings aren't loaded), keep it editable/visible rather than
      // hiding the user's content behind a disabled control.
      const disabledReason =
        eligibleFiles.length === 0 && !hasNote
          ? "Attach at least one recording from this group to enable."
          : null;
      sec.appendChild(_groupNoteTile(ann, g, disabledReason));
    }
  }

  // Recoverable notes whose group left the pinned set on a previous re-pin.
  if (ann.detachedNotes && ann.detachedNotes.length > 0) {
    sec.appendChild(_detachedNotesStrip(ann));
  }
  return sec;
}

function _groupNoteTile(ann, g, disabledReason) {
  const loaded = new Set(ann.targets.map((t) => t.file));
  const loadedCount = g.files.filter((f) => loaded.has(f)).length;
  const countText =
    (g.files.length === 1 ? "1 recording" : g.files.length + " recordings") +
    (loadedCount < g.files.length ? " (" + loadedCount + " loaded)" : "");
  return el(
    "div",
    { class: "lh-v6-group-tile" + (disabledReason ? " disabled" : "") },
    [
      el("div", { class: "lh-v6-group-tile-header" }, [
        el("span", {
          class: "lh-v6-group-tile-swatch",
          style: { background: g.color },
        }),
        el("span", { class: "lh-v6-group-tile-label", text: g.label }),
        el("span", { class: "lh-v6-group-tile-count", text: countText }),
      ]),
      _groupNoteTextarea(ann, g, disabledReason),
    ],
  );
}

function _groupNoteTextarea(ann, g, disabledReason) {
  const ta = el("textarea", {
    class: "lh-v6-group-note-textarea",
    placeholder: disabledReason
      ? disabledReason
      : "Notes about this group in this annotation…",
    title: disabledReason || "",
    rows: "2",
    value: ann.groupNotes[g.groupId] || "",
    disabled: !!disabledReason,
    "data-v6-key": "group-note-" + g.groupId,
    oninput: (e) => state.setGroupNote(ann.id, g.groupId, e.target.value),
  });
  // Drop target for detached-note transfer (enabled group notes only).
  if (!disabledReason) {
    _wireNoteDrop(ta, (text) => {
      const cur = state.getById(ann.id)?.groupNotes[g.groupId] || "";
      state.setGroupNote(ann.id, g.groupId, _joinNote(cur, text));
    });
  }
  return ta;
}

// Collapsible strip of notes whose group is no longer in the pinned set.
// Each note is read-only here with a copy + discard affordance; it
// re-attaches automatically if its group returns on a later re-pin.
function _detachedNotesStrip(ann) {
  const wrap = el("details", { class: "lh-v6-detached" }, [
    el("summary", {
      class: "lh-v6-detached-summary",
      text:
        "Notes from removed groups (" + ann.detachedNotes.length + ")",
    }),
    el("p", {
      class: "lh-v6-detached-hint",
      text:
        "Drag a note onto any note field above to copy its text there, or use Copy. Notes stay here until you discard them.",
    }),
  ]);
  for (const d of ann.detachedNotes) {
    wrap.appendChild(_detachedTile(ann, d));
  }
  return wrap;
}

function _detachedTile(ann, d) {
  const tile = el("div", { class: "lh-v6-detached-tile", draggable: "true" }, [
    el("div", { class: "lh-v6-group-tile-header" }, [
      el("span", {
        class: "lh-v6-detached-grip",
        title: "Drag onto a group note to copy its text there",
        "aria-hidden": "true",
        text: "⠿",
      }),
      el("span", {
        class: "lh-v6-group-tile-swatch",
        style: { background: d.color || "#94a3b8" },
      }),
      el("span", { class: "lh-v6-group-tile-label", text: d.label || "(untitled)" }),
      el("button", {
        class: "lh-v6-detached-copy",
        type: "button",
        title: "Copy this note's text to the clipboard",
        text: "Copy",
        onclick: (e) => _copyDetached(e.currentTarget, d.text),
      }),
      el("button", {
        class: "lh-v6-detached-discard",
        type: "button",
        title: "Discard this detached note",
        "aria-label": "Discard detached note",
        text: "×",
        onclick: () => {
          if (window.confirm('Discard the detached note for "' + (d.label || "this group") + '"?'))
            state.discardDetachedNote(ann.id, d.groupId);
        },
      }),
    ]),
    el("p", { class: "lh-v6-detached-text", text: d.text }),
  ]);
  tile.addEventListener("dragstart", (e) => {
    e.dataTransfer.setData(DETACHED_MIME, d.text);
    e.dataTransfer.setData("text/plain", d.text);
    e.dataTransfer.effectAllowed = "copy";
    tile.classList.add("lh-v6-detached-dragging");
  });
  tile.addEventListener("dragend", () => tile.classList.remove("lh-v6-detached-dragging"));
  return tile;
}

// Copy to clipboard with brief in-button feedback. Falls back silently if the
// Clipboard API is unavailable (e.g. insecure context).
function _copyDetached(btn, text) {
  const done = () => {
    const prev = btn.textContent;
    btn.textContent = "Copied";
    btn.disabled = true;
    setTimeout(() => {
      btn.textContent = prev;
      btn.disabled = false;
    }, 1200);
  };
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, () => {});
    }
  } catch (_) {
    /* no-op */
  }
}

// ---------------------------------------------------------------------------
// Comparisons: pairwise group-vs-group. Enabled when at least two groups
// have attached recordings — neither group notes nor per-recording notes
// are required.
// ---------------------------------------------------------------------------

function _comparisonsSection(ann) {
  const sec = el("section", { class: "lh-v6-section" });
  const attached = new Set(ann.targets.map((t) => t.file));
  const eligibleGroups = ann.pinnedGrouping.groups.filter((g) =>
    g.files.some((f) => attached.has(f)),
  );
  const canAdd = eligibleGroups.length >= 2;
  const addReason = canAdd
    ? "Add a comparison between two groups."
    : "Attach at least one recording from each of two groups first.";

  const header = el("div", { class: "lh-v6-section-title-row" }, [
    el("h3", { class: "lh-v6-section-title", text: "Comparisons" }),
    el("button", {
      class: "lh-v6-comparison-add",
      type: "button",
      text: "+ Add",
      title: addReason,
      disabled: !canAdd,
      onclick: () => {
        if (!canAdd) return;
        state.addComparison(ann.id, {
          leftGroupId: eligibleGroups[0].groupId,
          rightGroupId: eligibleGroups[1].groupId,
          text: "",
        });
      },
    }),
  ]);
  sec.appendChild(header);

  if (ann.comparisons.length === 0) {
    sec.appendChild(
      el("p", {
        class: "lh-v6-empty-hint",
        text: canAdd
          ? "No comparisons yet."
          : "Attach at least one recording from each of two groups to enable comparisons.",
      }),
    );
    return sec;
  }
  // Selects offer every pinned group (not just eligible ones) so a
  // comparison that references a group whose recordings aren't currently
  // loaded — e.g. on an imported annotation — still shows its real endpoints.
  const allGroups = ann.pinnedGrouping.groups;
  for (const c of ann.comparisons) {
    sec.appendChild(_comparisonTile(ann, c, allGroups));
  }
  return sec;
}

function _comparisonTile(ann, c, allGroups) {
  const opts = allGroups.length >= 2 ? allGroups : [];
  const makeSelect = (side, value) =>
    el(
      "select",
      {
        class: "lh-v6-comparison-select",
        "data-v6-key": "cmp-" + c.id + "-" + side,
        disabled: opts.length < 2,
        title:
          opts.length < 2
            ? "At least two groups are needed to compare."
            : "",
        onchange: (e) =>
          state.updateComparison(ann.id, c.id, { [side + "GroupId"]: e.target.value }),
      },
      opts.map((g) =>
        el("option", { value: g.groupId, selected: g.groupId === value }, g.label),
      ),
    );

  return el(
    "div",
    { class: "lh-v6-comparison-tile" },
    [
      el("div", { class: "lh-v6-comparison-header" }, [
        makeSelect("left", c.leftGroupId),
        el("span", { class: "lh-v6-comparison-vs", text: "vs." }),
        makeSelect("right", c.rightGroupId),
        el("button", {
          class: "lh-v6-comparison-remove",
          type: "button",
          title: "Remove this comparison",
          "aria-label": "Remove comparison",
          text: "×",
          onclick: () => state.removeComparison(ann.id, c.id),
        }),
      ]),
      _comparisonTextarea(ann, c),
    ],
  );
}

function _comparisonTextarea(ann, c) {
  const ta = el("textarea", {
    class: "lh-v6-comparison-textarea",
    placeholder: "What's different between these two groups?",
    rows: "2",
    value: c.text || "",
    "data-v6-key": "cmp-" + c.id + "-text",
    oninput: (e) =>
      state.updateComparison(ann.id, c.id, { text: e.target.value }),
  });
  _wireNoteDrop(ta, (text) => {
    const cur =
      state.getById(ann.id)?.comparisons.find((x) => x.id === c.id)?.text || "";
    state.updateComparison(ann.id, c.id, { text: _joinNote(cur, text) });
  });
  return ta;
}
