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
//     groupNotes:  { [groupLabel]: string },
//     comparisons: [{ id, leftLabel, rightLabel, text }],
//     pinnedGrouping: { name, groups: [{ label, color, files: [] }] } | null,
//   }
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
      groups: a.pinnedGrouping.groups.map((g) => ({
        label: g.label || "",
        color: _sanitiseColor(g.color) || "#94a3b8",
        files: Array.isArray(g.files) ? [...g.files] : [],
      })),
    };
  }
  return {
    id: a.id,
    label: a.label || "",
    color: _sanitiseColor(a.color) || _nextColor(),
    description: a.description || "",
    hasUnsavedChanges: !!a.hasUnsavedChanges,
    published: !!a.published,
    lastPostedUris: a.lastPostedUris || null,
    lastPostedHashes: a.lastPostedHashes || null,
    regions,
    targets,
    groupNotes: { ...(a.groupNotes || {}) },
    comparisons: (a.comparisons || []).map((c) => ({
      id: c.id,
      leftLabel: c.leftLabel,
      rightLabel: c.rightLabel,
      text: c.text || "",
    })),
    pinnedGrouping,
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
    regions: [],
    targets: [],
    groupNotes: {},
    comparisons: [],
    pinnedGrouping: opts.pinnedGrouping || null,
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

export function addRegion(annId, file, start, end) {
  const a = _getMut(annId);
  if (!a) return null;
  const rid = _id("rgn");
  a.regions.push({ id: rid, label: "" });
  // Attach the dragged file if it isn't already.
  if (!a.targets.find((t) => t.file === file)) {
    _attachTargetInternal(a, file);
  }
  // Mirror the drag bounds to every attached target (V6 option A).
  a.targets.forEach((t) => {
    t.regionTimes[rid] = { start, end };
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

export function setGroupNote(annId, groupLabel, text) {
  const a = _getMut(annId);
  if (!a) return;
  if (text) a.groupNotes[groupLabel] = text;
  else delete a.groupNotes[groupLabel];
  a.hasUnsavedChanges = true;
  _emit();
}

export function addComparison(annId, { leftLabel, rightLabel, text = "" }) {
  const a = _getMut(annId);
  if (!a) return null;
  const cid = _id("cmp");
  a.comparisons.push({ id: cid, leftLabel, rightLabel, text });
  a.hasUnsavedChanges = true;
  _emit();
  return cid;
}

export function updateComparison(annId, cid, patch) {
  const a = _getMut(annId);
  if (!a) return;
  const c = a.comparisons.find((x) => x.id === cid);
  if (!c) return;
  if (patch.leftLabel !== undefined) c.leftLabel = patch.leftLabel;
  if (patch.rightLabel !== undefined) c.rightLabel = patch.rightLabel;
  if (patch.text !== undefined) c.text = patch.text;
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
