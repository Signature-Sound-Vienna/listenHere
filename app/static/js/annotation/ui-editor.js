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
import { el, confirmRemoveIfTextful } from "./ui-common.js";

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
    el("textarea", {
      class: "lh-v6-recording-note",
      placeholder: "Notes on this recording in this annotation…",
      rows: "2",
      value: target.description || "",
      "data-v6-key": "tgt-note-" + target.file,
      oninput: (e) =>
        state.updateTargetNote(ann.id, target.file, e.target.value),
    }),
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
    // A group note only needs at least one attached recording from this
    // group — per-recording notes are no longer required. The adapter
    // falls back to referencing the Selections directly when there are
    // no track-level OAs to reference.
    const disabledReason =
      eligibleFiles.length === 0
        ? "Attach at least one recording from this group to enable."
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
          leftLabel: eligibleGroups[0].label,
          rightLabel: eligibleGroups[1].label,
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
  for (const c of ann.comparisons) {
    sec.appendChild(_comparisonTile(ann, c, eligibleGroups));
  }
  return sec;
}

function _comparisonTile(ann, c, eligibleGroups) {
  const opts = eligibleGroups.length >= 2 ? eligibleGroups : [];
  const makeSelect = (side, value) =>
    el(
      "select",
      {
        class: "lh-v6-comparison-select",
        "data-v6-key": "cmp-" + c.id + "-" + side,
        disabled: opts.length < 2,
        title:
          opts.length < 2
            ? "Both groups need attached recordings to be comparable."
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
