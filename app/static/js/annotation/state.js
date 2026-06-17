// V6 annotation in-memory state.
//
// Pure data + actions + a tiny event emitter. No DOM, no Solid, no LD —
// those concerns live in ui-* modules and mao-adapter.js.
//
// Model:
//   Annotation {
//     id, label, color, description,
//     hasUnsavedChanges, published,
//     lastPostedUris,                         // populated by mao-adapter on post/update
//     lastPostedHashes,                       // per-resource content hash, lets Update skip unchanged PUTs
//     regions: [{ id, label }],               // GLOBAL, ordered; identity preserved
//     targets: [{
//       file, description,
//       regionTimes: { [regionId]: {start, end} }  // entry for every region
//     }],
//     groupNotes:  { [groupId]: string },        // keyed by stable group id, not label
//     comparisons: [{ id, leftGroupId, rightGroupId, text }],
//     pinnedGrouping: { name, groups: [{ groupId, label, color, files: [] }] } | null,
//     detachedNotes: [{ groupId, label, color, text }],  // notes whose group left the
//                                                         // pinned set on a re-pin; held
//                                                         // for recovery, re-attach by id.
//   }
//
// Group identity: `groupId` is stable across a rename; `label` is display-only.
// Legacy data (pre-groupId) and imports without an explicit id fall back to
// groupId === label, which is exactly how notes/comparisons used to be keyed —
// so old alignment JSON and old pod resources round-trip unchanged.
//
// Invariant: every regions[].id has a regionTimes[regions[].id] entry on every target.
// Collapsed regions use start === end. All mutating actions preserve this.

const V6_DEFAULT_COLORS = [
  "#22c55e", "#3b82f6", "#a855f7", "#f59e0b", "#ef4444",
  "#14b8a6", "#ec4899", "#0ea5e9", "#84cc16", "#eab308",
];

let _annotations = [];
let _activeId = null;
let _colorIx = 0;
let _nextLocalId = 1;
const _listeners = new Set();

function _id(prefix) {
  return prefix + "_" + Date.now().toString(36) + "_" + _nextLocalId++;
}

function _nextColor() {
  const c = V6_DEFAULT_COLORS[_colorIx % V6_DEFAULT_COLORS.length];
  _colorIx++;
  return c;
}

/**
 * Security: alignment JSON can come from an attacker-controlled URL.
 * Colour fields end up in inline `style.background` and WaveSurfer region
 * colour options — both let CSS through, including `url(http://...)` which
 * silently exfiltrates via a remote-resource fetch. We accept only #hex and
 * rgb/rgba forms; everything else falls back to null (caller picks default).
 */
const _HEX_RE = /^#[0-9a-fA-F]{3,8}$/;
const _RGB_RE = /^rgba?\(\s*[\d.]+\s*[, ]+\s*[\d.]+\s*[, ]+\s*[\d.]+\s*(?:[, /]+\s*[\d.]+%?\s*)?\)$/;
function _sanitiseColor(c) {
  if (typeof c !== "string") return null;
  const trimmed = c.trim();
  if (_HEX_RE.test(trimmed)) return trimmed;
  if (_RGB_RE.test(trimmed)) return trimmed;
  return null;
}

function _emit() {
  for (const fn of _listeners) {
    try {
      fn();
    } catch (e) {
      console.error("[annotation/v6] listener threw", e);
    }
  }
}

function _getMut(annId) {
  return _annotations.find((a) => a.id === annId) || null;
}

// ----- subscription / reads ------------------------------------------------

export function subscribe(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

export function getAll() {
  return _annotations;
}

export function getById(id) {
  return _annotations.find((a) => a.id === id) || null;
}

export function getActiveId() {
  return _activeId;
}

// ----- selection -----------------------------------------------------------

export function setActiveAnnotation(id) {
  _activeId = id;
  _emit();
}

// ----- bulk load -----------------------------------------------------------

export function replaceAll(list) {
  _annotations = (list || []).map(_normalise);
  _activeId = null;
  _emit();
}

function _normalise(a) {
  const regions = (a.regions || []).map((r) => ({
    id: r.id,
    label: r.label || "",
  }));
  const targets = (a.targets || []).map((t) => {
    const regionTimes = {};
    regions.forEach((r) => {
      const src = t.regionTimes && t.regionTimes[r.id];
      regionTimes[r.id] = src
        ? { start: src.start, end: src.end }
        : { start: 0, end: 0 };
    });
    return {
      file: t.file,
      description: t.description || "",
      regionTimes,
    };
  });
  // Sanitise the pinned grouping's per-group colours too — they end up in
  // inline styles as well.
  let pinnedGrouping = null;
  if (a.pinnedGrouping && Array.isArray(a.pinnedGrouping.groups)) {
    pinnedGrouping = {
      name: typeof a.pinnedGrouping.name === "string" ? a.pinnedGrouping.name : "",
      groups: a.pinnedGrouping.groups.map(_normaliseGroup),
    };
  }
  const detachedNotes = (Array.isArray(a.detachedNotes) ? a.detachedNotes : [])
    .map((d) => ({
      groupId: d.groupId || d.label || "",
      label: d.label || "",
      color: _sanitiseColor(d.color) || "#94a3b8",
      text: typeof d.text === "string" ? d.text : "",
    }))
    .filter((d) => d.groupId && d.text);
  return {
    id: a.id,
    label: a.label || "",
    color: _sanitiseColor(a.color) || _nextColor(),
    description: a.description || "",
    hasUnsavedChanges: !!a.hasUnsavedChanges,
    published: !!a.published,
    lastPostedUris: a.lastPostedUris || null,
    lastPostedHashes: a.lastPostedHashes || null,
    // Selection URIs that aren't a per-target audio Selection — typically
    // score-side Selections from a mei-friend-loaded MAO chain. The
    // adapter appends these to Extract.frbr:embodiment on serialize so
    // the chain stays additive (the original score Selections keep their
    // place alongside the audio ones the user creates in listen-here).
    preservedSelections: Array.isArray(a.preservedSelections)
      ? [...a.preservedSelections]
      : [],
    regions,
    targets,
    groupNotes: { ...(a.groupNotes || {}) },
    comparisons: (a.comparisons || []).map((c) => ({
      id: c.id,
      // groupId-keyed endpoints. Accept legacy {leftLabel,rightLabel} —
      // for legacy data groupId === label, so the values still resolve.
      leftGroupId: c.leftGroupId != null ? c.leftGroupId : c.leftLabel,
      rightGroupId: c.rightGroupId != null ? c.rightGroupId : c.rightLabel,
      text: c.text || "",
    })),
    pinnedGrouping,
    detachedNotes,
  };
}

// Normalise one pinned-grouping group: backfill a stable groupId from the
// label when absent (legacy / import), sanitise the colour.
function _normaliseGroup(g) {
  const label = g.label || "";
  return {
    groupId: g.groupId || label,
    label,
    color: _sanitiseColor(g.color) || "#94a3b8",
    files: Array.isArray(g.files) ? [...g.files] : [],
  };
}

// ----- annotation lifecycle ------------------------------------------------

export function createAnnotation(opts = {}) {
  const ann = {
    id: opts.id || _id("ann"),
    label: opts.label || "",
    color: opts.color || _nextColor(),
    description: "",
    hasUnsavedChanges: true,
    published: false,
    lastPostedUris: null,
    lastPostedHashes: null,
    preservedSelections: [],
    regions: [],
    targets: [],
    groupNotes: {},
    comparisons: [],
    pinnedGrouping: opts.pinnedGrouping
      ? { name: opts.pinnedGrouping.name || "", groups: (opts.pinnedGrouping.groups || []).map(_normaliseGroup) }
      : null,
    detachedNotes: [],
  };
  _annotations.push(ann);
  _activeId = ann.id;
  _emit();
  return ann.id;
}

/**
 * Add a fully-formed annotation (e.g. one reconstructed by mao-adapter's
 * deserialize). The caller owns the object's invariants; we normalise
 * defensively. Does NOT set active — caller decides.
 */
export function addAnnotation(ann) {
  if (!ann || !ann.id) return null;
  _annotations.push(_normalise(ann));
  _emit();
  return ann.id;
}

export function removeAnnotation(annId) {
  _annotations = _annotations.filter((a) => a.id !== annId);
  if (_activeId === annId) _activeId = null;
  _emit();
}

export function updateAnnotationField(annId, field, value) {
  const a = _getMut(annId);
  if (!a) return;
  if (!["label", "color", "description"].includes(field)) return;
  a[field] = value;
  a.hasUnsavedChanges = true;
  _emit();
}

// ----- targets (attached recordings) --------------------------------------

function _attachTargetInternal(a, file) {
  // Seed regionTimes for every existing region from the first existing target,
  // or zero-zero if no targets exist yet.
  const regionTimes = {};
  const src = a.targets[0];
  a.regions.forEach((r) => {
    const seed = src && src.regionTimes[r.id];
    regionTimes[r.id] = seed
      ? { start: seed.start, end: seed.end }
      : { start: 0, end: 0 };
  });
  a.targets.push({ file, description: "", regionTimes });
}

/**
 * Attach a recording as a target.
 *
 * @param {string} annId
 * @param {string} file
 * @param {object} [opts]
 * @param {object} [opts.regionTimes] — explicit per-region times
 *   `{ [regionId]: {start, end} }`. The waveform bridge supplies
 *   alignment-aware times so a newly-selected recording's regions line up
 *   musically with existing targets. When omitted, region times are seeded
 *   from the first existing target (identical seconds).
 * @param {string} [opts.description] — optional initial per-recording note.
 *   Used to restore an orphan note when a previously-detached recording is
 *   re-selected within the same session.
 */
export function addTarget(annId, file, opts = {}) {
  const a = _getMut(annId);
  if (!a) return;
  if (a.targets.find((t) => t.file === file)) return;
  const { regionTimes, description } = opts;
  if (regionTimes) {
    const newRegionTimes = {};
    a.regions.forEach((r) => {
      const t = regionTimes[r.id];
      newRegionTimes[r.id] = t
        ? { start: t.start, end: t.end }
        : { start: 0, end: 0 };
    });
    a.targets.push({
      file,
      description: description || "",
      regionTimes: newRegionTimes,
    });
  } else {
    _attachTargetInternal(a, file);
    if (description) {
      const t = a.targets.find((x) => x.file === file);
      if (t) t.description = description;
    }
  }
  a.hasUnsavedChanges = true;
  _emit();
}

export function removeTarget(annId, file) {
  const a = _getMut(annId);
  if (!a) return;
  if (!a.targets.find((t) => t.file === file)) return;
  a.targets = a.targets.filter((t) => t.file !== file);
  a.hasUnsavedChanges = true;
  _emit();
}

export function updateTargetNote(annId, file, text) {
  const a = _getMut(annId);
  if (!a) return;
  const t = a.targets.find((x) => x.file === file);
  if (!t) return;
  t.description = text;
  a.hasUnsavedChanges = true;
  _emit();
}

// ----- regions (global, ordered) ------------------------------------------

export function addRegion(annId, file, start, end, timesByFile) {
  const a = _getMut(annId);
  if (!a) return null;
  const rid = _id("rgn");
  a.regions.push({ id: rid, label: "" });
  // Attach the dragged file if it isn't already.
  if (!a.targets.find((t) => t.file === file)) {
    _attachTargetInternal(a, file);
  }
  // If the caller has alignment-mapped per-file times, use them so each
  // target's regionTimes reflects that recording's own timescale. Falls
  // back to mirroring the raw drag bounds when the caller can't compute
  // alignment (e.g. tests, single-target annotations).
  a.targets.forEach((t) => {
    const mapped = timesByFile && timesByFile[t.file];
    t.regionTimes[rid] = mapped
      ? { start: mapped.start, end: mapped.end }
      : { start, end };
  });
  a.hasUnsavedChanges = true;
  _emit();
  return rid;
}

export function removeRegion(annId, regionId) {
  const a = _getMut(annId);
  if (!a) return;
  a.regions = a.regions.filter((r) => r.id !== regionId);
  a.targets.forEach((t) => {
    delete t.regionTimes[regionId];
  });
  a.hasUnsavedChanges = true;
  _emit();
}

export function updateRegionTime(annId, file, regionId, patch) {
  const a = _getMut(annId);
  if (!a) return;
  const t = a.targets.find((x) => x.file === file);
  if (!t) return;
  const cur = t.regionTimes[regionId];
  if (!cur) return;
  if (patch.start !== undefined) cur.start = patch.start;
  if (patch.end !== undefined) cur.end = patch.end;
  a.hasUnsavedChanges = true;
  _emit();
}

/**
 * Bulk update: set a region's times across many targets in one emit.
 * Used by the waveform bridge to mirror a resize/move across all attached
 * recordings (alignment-aware times computed by the caller).
 */
export function updateRegionTimeMulti(annId, regionId, timesByFile) {
  const a = _getMut(annId);
  if (!a) return;
  let changed = false;
  for (const t of a.targets) {
    const nt = timesByFile[t.file];
    if (!nt) continue;
    const cur = t.regionTimes[regionId];
    if (!cur || cur.start !== nt.start || cur.end !== nt.end) {
      t.regionTimes[regionId] = { start: nt.start, end: nt.end };
      changed = true;
    }
  }
  if (changed) {
    a.hasUnsavedChanges = true;
    _emit();
  }
}

export function updateRegionLabel(annId, regionId, label) {
  const a = _getMut(annId);
  if (!a) return;
  const r = a.regions.find((x) => x.id === regionId);
  if (!r) return;
  r.label = label;
  a.hasUnsavedChanges = true;
  _emit();
}

// ----- group notes & comparisons ------------------------------------------

export function setGroupNote(annId, groupId, text) {
  const a = _getMut(annId);
  if (!a) return;
  if (text) a.groupNotes[groupId] = text;
  else delete a.groupNotes[groupId];
  a.hasUnsavedChanges = true;
  _emit();
}

export function addComparison(annId, { leftGroupId, rightGroupId, text = "" }) {
  const a = _getMut(annId);
  if (!a) return null;
  const cid = _id("cmp");
  a.comparisons.push({ id: cid, leftGroupId, rightGroupId, text });
  a.hasUnsavedChanges = true;
  _emit();
  return cid;
}

export function updateComparison(annId, cid, patch) {
  const a = _getMut(annId);
  if (!a) return;
  const c = a.comparisons.find((x) => x.id === cid);
  if (!c) return;
  if (patch.leftGroupId !== undefined) c.leftGroupId = patch.leftGroupId;
  if (patch.rightGroupId !== undefined) c.rightGroupId = patch.rightGroupId;
  if (patch.text !== undefined) c.text = patch.text;
  a.hasUnsavedChanges = true;
  _emit();
}

// ----- re-pin grouping (adopt current application grouping) ---------------

function _nonEmpty(s) {
  return typeof s === "string" && s.trim().length > 0;
}

/**
 * Compute what a re-pin to `snapshot` (from getActiveGroupingSnapshot) would
 * change for this annotation, WITHOUT mutating anything. Drives the
 * diff-confirmation dialog. Groups are matched by stable groupId.
 *
 * Returns { changed, added[], removed[], renamed[], affectedComparisons[],
 *           detachedNoteCount, restoredNoteCount, podDeleteCount }.
 */
export function diffGrouping(ann, snapshot) {
  const curGroups = (ann && ann.pinnedGrouping && ann.pinnedGrouping.groups) || [];
  const newGroups = (snapshot && snapshot.groups) || [];
  const curById = new Map(curGroups.map((g) => [g.groupId, g]));
  const newById = new Map(newGroups.map((g) => [g.groupId, g]));
  const detached = (ann && ann.detachedNotes) || [];
  const groupNotes = (ann && ann.groupNotes) || {};

  const added = newGroups
    .filter((g) => !curById.has(g.groupId))
    .map((g) => ({ groupId: g.groupId, label: g.label }));
  const removed = curGroups
    .filter((g) => !newById.has(g.groupId))
    .map((g) => ({
      groupId: g.groupId,
      label: g.label,
      hasNote: _nonEmpty(groupNotes[g.groupId]),
    }));
  const renamed = curGroups
    .filter((g) => newById.has(g.groupId) && newById.get(g.groupId).label !== g.label)
    .map((g) => ({ groupId: g.groupId, from: g.label, to: newById.get(g.groupId).label }));

  const removedIds = new Set(removed.map((g) => g.groupId));
  const affectedComparisons = ((ann && ann.comparisons) || [])
    .filter((c) => removedIds.has(c.leftGroupId) || removedIds.has(c.rightGroupId))
    .map((c) => ({
      id: c.id,
      left: (curById.get(c.leftGroupId) || {}).label || c.leftGroupId,
      right: (curById.get(c.rightGroupId) || {}).label || c.rightGroupId,
    }));

  const detachedNoteCount = removed.filter((g) => g.hasNote).length;
  const restoredNoteCount = detached.filter((d) => newById.has(d.groupId)).length;

  // Pod impact: only meaningful once posted. A removed group's note OA and
  // any affected comparison OA would be DELETEd on the next Update.
  let podDeleteCount = 0;
  if (ann && ann.published && ann.lastPostedUris) {
    const lpu = ann.lastPostedUris;
    for (const g of removed) if (lpu["oa/group/" + g.groupId]) podDeleteCount++;
    for (const c of affectedComparisons) if (lpu["oa/cmp/" + c.id]) podDeleteCount++;
  }

  const changed =
    added.length > 0 ||
    removed.length > 0 ||
    renamed.length > 0 ||
    restoredNoteCount > 0;

  return {
    changed,
    added,
    removed,
    renamed,
    affectedComparisons,
    detachedNoteCount,
    restoredNoteCount,
    podDeleteCount,
  };
}

/**
 * Adopt `snapshot` (current application grouping) as this annotation's pinned
 * grouping. Group notes are matched by groupId: survivors keep their note;
 * notes on groups that left the set move to detachedNotes (recoverable);
 * detached notes whose group reappears are re-attached; comparisons that
 * reference a departed group are dropped. The caller is responsible for
 * obtaining explicit user confirmation first (see diffGrouping).
 */
export function repinGrouping(annId, snapshot) {
  const a = _getMut(annId);
  if (!a || !snapshot) return;
  const newGroups = (snapshot.groups || []).map(_normaliseGroup);
  const newById = new Map(newGroups.map((g) => [g.groupId, g]));
  const curGroups = (a.pinnedGrouping && a.pinnedGrouping.groups) || [];

  // 1. Departed groups with a note → detachedNotes (dedupe by groupId).
  const detachedById = new Map((a.detachedNotes || []).map((d) => [d.groupId, d]));
  for (const g of curGroups) {
    if (newById.has(g.groupId)) continue;
    const note = a.groupNotes[g.groupId];
    if (_nonEmpty(note)) {
      detachedById.set(g.groupId, {
        groupId: g.groupId,
        label: g.label,
        color: g.color || "#94a3b8",
        text: note,
      });
    }
    delete a.groupNotes[g.groupId];
  }

  // 2. Re-attach detached notes whose group is back in the set (only when
  //    the survivor doesn't already carry a note).
  for (const [gid, d] of [...detachedById.entries()]) {
    if (newById.has(gid)) {
      if (!_nonEmpty(a.groupNotes[gid])) a.groupNotes[gid] = d.text;
      detachedById.delete(gid);
    }
  }
  a.detachedNotes = [...detachedById.values()];

  // 3. Drop comparisons referencing a now-absent group.
  a.comparisons = a.comparisons.filter(
    (c) => newById.has(c.leftGroupId) && newById.has(c.rightGroupId),
  );

  // 4. Swap in the new grouping.
  a.pinnedGrouping = { name: snapshot.name || "", groups: newGroups };
  a.hasUnsavedChanges = true;
  _emit();
}

/** Permanently drop a detached (removed-group) note. */
export function discardDetachedNote(annId, groupId) {
  const a = _getMut(annId);
  if (!a || !a.detachedNotes) return;
  const next = a.detachedNotes.filter((d) => d.groupId !== groupId);
  if (next.length === a.detachedNotes.length) return;
  a.detachedNotes = next;
  a.hasUnsavedChanges = true;
  _emit();
}

export function removeComparison(annId, cid) {
  const a = _getMut(annId);
  if (!a) return;
  a.comparisons = a.comparisons.filter((c) => c.id !== cid);
  a.hasUnsavedChanges = true;
  _emit();
}

// ----- lifecycle flags ----------------------------------------------------

export function markSaved(annId) {
  const a = _getMut(annId);
  if (!a) return;
  a.hasUnsavedChanges = false;
  _emit();
}

/** True iff any annotation currently has hasUnsavedChanges. */
export function isAnyDirty() {
  return _annotations.some((a) => a.hasUnsavedChanges);
}

/** Clear hasUnsavedChanges on every annotation. Single emit at the end. */
export function markAllSaved() {
  let changed = false;
  for (const a of _annotations) {
    if (a.hasUnsavedChanges) {
      a.hasUnsavedChanges = false;
      changed = true;
    }
  }
  if (changed) _emit();
}

export function markPosted(annId, lastPostedUris, lastPostedHashes) {
  const a = _getMut(annId);
  if (!a) return;
  a.published = true;
  // Post acts as a save: dirty indicator clears. The caller is responsible
  // for also updating the in-memory loadedAlignmentJSON so the URIs persist
  // through a subsequent Save Data download — otherwise a reload before
  // Save would lose lastPostedUris and a future Post would create
  // duplicates on the pod.
  a.hasUnsavedChanges = false;
  if (lastPostedUris) a.lastPostedUris = lastPostedUris;
  if (lastPostedHashes) a.lastPostedHashes = lastPostedHashes;
  _emit();
}

export function markDirty(annId) {
  const a = _getMut(annId);
  if (!a) return;
  a.hasUnsavedChanges = true;
  _emit();
}

// ----- test helper --------------------------------------------------------

export function _resetForTests() {
  _annotations = [];
  _activeId = null;
  _colorIx = 0;
  _nextLocalId = 1;
  _listeners.clear();
}
