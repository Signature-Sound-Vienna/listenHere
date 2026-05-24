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
import { el } from "./ui-common.js";

export function renderEditor(ann) {
  const root = el("div", { class: "lh-v6-editor" });
  root.appendChild(_identitySection(ann));
  root.appendChild(_descriptionSection(ann));
  root.appendChild(_recordingsSection(ann));
  if (ann.pinnedGrouping && ann.pinnedGrouping.groups.length > 0) {
    root.appendChild(_groupNotesSection(ann));
    if (ann.pinnedGrouping.groups.length >= 2) {
      root.appendChild(_comparisonsSection(ann));
    }
  }
  return root;
}

// ---------------------------------------------------------------------------
// Identity / Description (Phase B; data-v6-key added for focus restore)
// ---------------------------------------------------------------------------

function _identitySection(ann) {
  const sec = el("section", { class: "lh-v6-section lh-v6-section-identity" });
  sec.appendChild(
    el("h3", { class: "lh-v6-section-title", text: "Identity" }),
  );
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
      el("input", {
        type: "text",
        class: "lh-v6-title-input",
        placeholder: "Annotation title",
        value: ann.label,
        "data-v6-key": "title",
        oninput: (e) =>
          state.updateAnnotationField(ann.id, "label", e.target.value),
      }),
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
  sec.appendChild(
    el("textarea", {
      class: "lh-v6-description-textarea",
      placeholder: "Overall description — what this annotation is about.",
      rows: "3",
      value: ann.description,
      "data-v6-key": "description",
      oninput: (e) =>
        state.updateAnnotationField(ann.id, "description", e.target.value),
    }),
  );
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
  return el(
    "div",
    { class: "lh-v6-recording-tile" },
    [
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
          class: "lh-v6-recording-detach",
          type: "button",
          title: "Detach this recording from the annotation",
          "aria-label": "Detach " + target.file,
          text: "×",
          onclick: () => state.removeTarget(ann.id, target.file),
        }),
      ]),
      el("textarea", {
        class: "lh-v6-recording-note",
        placeholder: "Notes on this recording in this annotation…",
        rows: "2",
        value: target.description || "",
        "data-v6-key": "tgt-note-" + target.file,
        oninput: (e) =>
          state.updateTargetNote(ann.id, target.file, e.target.value),
      }),
    ],
  );
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

function _groupNotesSection(ann) {
  const sec = el("section", { class: "lh-v6-section" });
  sec.appendChild(
    el("h3", { class: "lh-v6-section-title", text: "Group notes" }),
  );
  const attached = new Set(ann.targets.map((t) => t.file));
  for (const g of ann.pinnedGrouping.groups) {
    const eligibleFiles = g.files.filter((f) => attached.has(f));
    const hasUnderlyingNote = ann.targets.some(
      (t) =>
        g.files.includes(t.file) &&
        typeof t.description === "string" &&
        t.description.trim().length > 0,
    );
    const disabledReason = !hasUnderlyingNote
      ? eligibleFiles.length === 0
        ? "Attach at least one recording from this group to enable."
        : "Add a per-recording note to at least one recording in this group first."
      : null;
    sec.appendChild(_groupNoteTile(ann, g, disabledReason));
  }
  return sec;
}

function _groupNoteTile(ann, g, disabledReason) {
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
        el("span", {
          class: "lh-v6-group-tile-count",
          text:
            g.files.length === 1
              ? "1 recording"
              : g.files.length + " recordings",
        }),
      ]),
      el("textarea", {
        class: "lh-v6-group-note-textarea",
        placeholder: disabledReason
          ? disabledReason
          : "Notes about this group in this annotation…",
        title: disabledReason || "",
        rows: "2",
        value: ann.groupNotes[g.label] || "",
        disabled: !!disabledReason,
        "data-v6-key": "group-note-" + g.label,
        oninput: (e) => state.setGroupNote(ann.id, g.label, e.target.value),
      }),
    ],
  );
}

// ---------------------------------------------------------------------------
// Comparisons: pairwise group-vs-group. Add disabled when fewer than two
// groups have non-empty group notes.
// ---------------------------------------------------------------------------

function _comparisonsSection(ann) {
  const sec = el("section", { class: "lh-v6-section" });
  const groupsWithNotes = ann.pinnedGrouping.groups.filter(
    (g) =>
      typeof ann.groupNotes[g.label] === "string" &&
      ann.groupNotes[g.label].trim().length > 0,
  );
  const canAdd = groupsWithNotes.length >= 2;
  const addReason = canAdd
    ? "Add a comparison between two groups."
    : "Add a group note to at least two groups first.";

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
          leftLabel: groupsWithNotes[0].label,
          rightLabel: groupsWithNotes[1].label,
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
          : "Add a group note to at least two groups to enable comparisons.",
      }),
    );
    return sec;
  }
  for (const c of ann.comparisons) {
    sec.appendChild(_comparisonTile(ann, c, groupsWithNotes));
  }
  return sec;
}

function _comparisonTile(ann, c, groupsWithNotes) {
  const opts = groupsWithNotes.length >= 2 ? groupsWithNotes : [];
  const makeSelect = (side, value) =>
    el(
      "select",
      {
        class: "lh-v6-comparison-select",
        "data-v6-key": "cmp-" + c.id + "-" + side,
        disabled: opts.length < 2,
        title:
          opts.length < 2
            ? "Both groups need a group note to be comparable."
            : "",
        onchange: (e) =>
          state.updateComparison(ann.id, c.id, { [side + "Label"]: e.target.value }),
      },
      opts.map((g) =>
        el("option", { value: g.label, selected: g.label === value }, g.label),
      ),
    );

  return el(
    "div",
    { class: "lh-v6-comparison-tile" },
    [
      el("div", { class: "lh-v6-comparison-header" }, [
        makeSelect("left", c.leftLabel),
        el("span", { class: "lh-v6-comparison-vs", text: "vs." }),
        makeSelect("right", c.rightLabel),
        el("button", {
          class: "lh-v6-comparison-remove",
          type: "button",
          title: "Remove this comparison",
          "aria-label": "Remove comparison",
          text: "×",
          onclick: () => state.removeComparison(ann.id, c.id),
        }),
      ]),
      el("textarea", {
        class: "lh-v6-comparison-textarea",
        placeholder: "What's different between these two groups?",
        rows: "2",
        value: c.text || "",
        "data-v6-key": "cmp-" + c.id + "-text",
        oninput: (e) =>
          state.updateComparison(ann.id, c.id, { text: e.target.value }),
      }),
    ],
  );
}
