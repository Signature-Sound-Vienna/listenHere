// V6 annotation — WaveSurfer integration.
//
// Bridges the V6 state to the live RegionsPlugin instances managed by
// listen.js:
//
//   1. Region rendering — on every state change, every attached
//      target's regions are reconciled with the plugin's region set.
//      Region IDs are namespaced `v6_<annId>_<regionId>` so they're
//      ignored by the legacy region-created / region-updated handlers
//      in listen.js. Metadata is stashed on `region._v6Meta` so we
//      don't have to parse the ID back out.
//
//   2. Drag-to-create — when (V6 is active, an annotation is selected,
//      drawer is in edit mode, draw-mode toggle is on), enable
//      WaveSurfer's drag selection on every plugin. A user drag fires
//      region-created with a fresh untagged region; we remove it and
//      dispatch to state.addRegion(...), which mirrors the times to
//      every attached target.
//
//   3. Edge-drag (resize) — region-updated on a V6-tagged region
//      routes to state.updateRegionTime(...) for that file only.
//      Other recordings of the same regionId are unchanged.
//
// Phase C scope. Click-to-focus + per-tile attach pill are Phase C
// follow-ups; recordings can be attached implicitly by dragging on a
// detached waveform (state.addRegion auto-attaches).

import * as state from "./state.js";
import * as uiState from "./ui-state.js";
import {
  _regionsPlugins,
  _overlayWrappers,
  wavesurfers,
  setDrawModeActive,
  getClosestAlignmentIx,
  getCorrespondingTime,
} from "../listen.js";

export const V6_REGION_PREFIX = "v6_";

// Plugins we've already wired region-updated on. Lazy: a plugin is
// hooked the first time syncRegions encounters it.
const _hookedPlugins = new WeakSet();

// Cleanup functions returned by enableDragSelection (per plugin). Stored
// here so we can tear them down when conditions change.
let _dragSelectionCleanups = [];
let _activeRegionCreatedListeners = []; // [{plugin, file, fn}]

// Last draw-mode signature applied, so we can short-circuit redundant work.
let _lastDrawModeKey = null;

// Re-entrancy guard for syncRegions. ensureTargetsAttached emits, which
// would otherwise recurse via state.subscribe(syncAll).
let _syncingRegions = false;

// Shift-key tracking. Two roles:
//   1. Holding Shift while resizing or moving a V6 region scopes the change
//      to that recording only ("local override"). Default behaviour
//      propagates alignment-aware to every attached recording.
//   2. Holding Shift without dragging shows a duration label inside each V6
//      region and gap labels between consecutive regions, on every loaded
//      waveform. Mirrors the legacy marker-duration feature in listen.js.
//
// The Shift+drag time-measurement feature (in listen.js) is suppressed when
// the mousedown lands on a region — see the composedPath check there.
let _shiftHeld = false;
let _shiftListenersInstalled = false;
function _installShiftListeners() {
  if (_shiftListenersInstalled) return;
  _shiftListenersInstalled = true;
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Shift" || e.repeat) return;
    _shiftHeld = true;
    _showRegionDurations();
  });
  document.addEventListener("keyup", (e) => {
    if (e.key !== "Shift") return;
    _shiftHeld = false;
    _clearRegionDurations();
  });
  // Safety: if the window loses focus, drop the held state and clear visuals.
  window.addEventListener("blur", () => {
    _shiftHeld = false;
    _clearRegionDurations();
  });
}

export function initWaveformInteractions() {
  _installShiftListeners();
  state.subscribe(syncAll);
  uiState.subscribe(syncAll);
  // Initial sync — wavesurfers may not exist yet at init time. That's fine;
  // listen.js's updateRenderAnnoRegions delegates to us once they do.
  syncAll();
}

/**
 * Public entry point: re-render V6 regions on every loaded waveform.
 * Called by listen.js's updateRenderAnnoRegions when V6 is active.
 */
export function syncWaveformRegions() {
  syncRegions();
}

function syncAll() {
  syncRegions();
  syncDrawMode();
}

// ---------------------------------------------------------------------------
// Region rendering
// ---------------------------------------------------------------------------

function syncRegions() {
  if (_syncingRegions) return;
  _syncingRegions = true;
  try {
    // Auto-attach every loaded waveform to every annotation, so regions are
    // visible across all waveforms by default. Recordings can be detached
    // explicitly via the editor's Recordings section (Phase D).
    const loadedFiles = Object.keys(_regionsPlugins);
    if (loadedFiles.length > 0) {
      for (const ann of state.getAll()) {
        state.ensureTargetsAttached(ann.id, loadedFiles);
      }
    }
    const annotations = state.getAll();
    const activeId = state.getActiveId();
    const specsByFile = _computeSpecsByFile(annotations, activeId);
    for (const file of Object.keys(_regionsPlugins)) {
      const plugin = _regionsPlugins[file];
      if (!plugin) continue;
      _ensureHooked(plugin, file);
      _reconcileForFile(plugin, file, specsByFile[file] || []);
    }
  } finally {
    _syncingRegions = false;
  }
}

function _computeSpecsByFile(annotations, activeId) {
  const byFile = {};
  const canResizeActive =
    uiState.getDrawerOpen() &&
    uiState.getMode() === "edit" &&
    uiState.getDrawMode();
  for (const ann of annotations) {
    const isActive = ann.id === activeId;
    const allowResize = isActive && canResizeActive;
    for (const target of ann.targets) {
      if (!byFile[target.file]) byFile[target.file] = [];
      for (const r of ann.regions) {
        const t = target.regionTimes[r.id];
        if (!t) continue;
        byFile[target.file].push({
          id: `${V6_REGION_PREFIX}${ann.id}_${r.id}`,
          annId: ann.id,
          regionId: r.id,
          start: t.start,
          end: t.end,
          color: _withAlpha(ann.color, isActive ? 0.45 : 0.3),
          // drag and resize follow the same edit gate. Alt-held during a
          // drag/resize scopes the change to this recording only.
          drag: allowResize,
          resize: allowResize,
        });
      }
    }
  }
  return byFile;
}

function _reconcileForFile(plugin, file, specs) {
  const existing = plugin
    .getRegions()
    .filter((r) => r.id && r.id.startsWith(V6_REGION_PREFIX));
  const wantById = new Map(specs.map((s) => [s.id, s]));
  for (const r of existing) {
    if (!wantById.has(r.id)) r.remove();
  }
  const existingById = new Map(
    plugin
      .getRegions()
      .filter((r) => r.id && r.id.startsWith(V6_REGION_PREFIX))
      .map((r) => [r.id, r]),
  );
  for (const spec of specs) {
    const cur = existingById.get(spec.id);
    if (
      cur &&
      cur.start === spec.start &&
      cur.end === spec.end &&
      cur.color === spec.color &&
      _resizeFlag(cur) === spec.resize
    ) {
      // Up-to-date; keep metadata current and continue.
      cur._v6Meta = { annId: spec.annId, regionId: spec.regionId };
      continue;
    }
    if (cur) cur.remove();
    const r = plugin.addRegion({
      id: spec.id,
      start: spec.start,
      end: spec.end,
      color: spec.color,
      drag: spec.drag,
      resize: spec.resize,
    });
    if (r) r._v6Meta = { annId: spec.annId, regionId: spec.regionId };
  }
}

function _resizeFlag(region) {
  // WaveSurfer region's resize permission isn't always reflected on the
  // object after construction. Treat undefined as truthy default.
  if (typeof region.resize === "boolean") return region.resize;
  return true;
}

function _withAlpha(hexOrRgb, alpha) {
  if (!hexOrRgb) return `rgba(120,120,120,${alpha})`;
  if (hexOrRgb.startsWith("#")) {
    const h = hexOrRgb.replace("#", "");
    const full =
      h.length === 3
        ? h
            .split("")
            .map((c) => c + c)
            .join("")
        : h;
    const r = parseInt(full.substring(0, 2), 16);
    const g = parseInt(full.substring(2, 4), 16);
    const b = parseInt(full.substring(4, 6), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }
  return hexOrRgb;
}

// ---------------------------------------------------------------------------
// Event wiring — region-updated permanent per plugin, region-created scoped
// to draw-mode-active windows.
// ---------------------------------------------------------------------------

function _ensureHooked(plugin, file) {
  if (_hookedPlugins.has(plugin)) return;
  _hookedPlugins.add(plugin);
  plugin.on("region-updated", (region) => {
    const meta = region && region._v6Meta;
    if (!meta) return;
    const start = Math.min(region.start, region.end);
    const end = Math.max(region.start, region.end);
    if (_shiftHeld) {
      // Local override: only this recording's times change.
      state.updateRegionTime(meta.annId, file, meta.regionId, { start, end });
      return;
    }
    // Propagate alignment-aware to every attached recording.
    const ann = state.getById(meta.annId);
    if (!ann) return;
    const timesByFile = _alignedTimesByFile(ann, file, start, end);
    state.updateRegionTimeMulti(meta.annId, meta.regionId, timesByFile);
  });
}

/**
 * Map a (start, end) drawn on sourceFile to per-file times for every target
 * of the annotation. Uses the alignment grid: sourceFile times → alignment
 * indices → other files' times.
 *
 * Failure modes are explicit:
 *   - sourceFile has no alignment grid → propagation aborted; only sourceFile
 *     updated (treat as a local edit).
 *   - a target file has no alignment grid → that target is skipped; its
 *     existing region times are preserved.
 *
 * Identical-seconds fallback is intentionally NOT used: seconds are not
 * comparable across recordings at different tempos.
 */
function _alignedTimesByFile(ann, sourceFile, start, end) {
  const out = { [sourceFile]: { start, end } };
  let fromIdx, toIdx;
  try {
    fromIdx = getClosestAlignmentIx(start, sourceFile);
    toIdx = getClosestAlignmentIx(end, sourceFile);
  } catch (e) {
    console.warn(
      "[annotation/v6] no alignment grid for source file " +
        sourceFile +
        "; restricting edit to that file.",
      e,
    );
    return out;
  }
  if (!Number.isFinite(fromIdx) || !Number.isFinite(toIdx)) {
    console.warn(
      "[annotation/v6] alignment index non-finite on source file " +
        sourceFile +
        "; restricting edit to that file.",
    );
    return out;
  }
  for (const t of ann.targets) {
    if (t.file === sourceFile) continue;
    let s, e;
    try {
      s = getCorrespondingTime(t.file, fromIdx);
      e = getCorrespondingTime(t.file, toIdx);
    } catch (err) {
      console.warn(
        "[annotation/v6] no alignment grid for target " +
          t.file +
          "; not propagating to it.",
        err,
      );
      continue;
    }
    if (!Number.isFinite(s) || !Number.isFinite(e)) {
      console.warn(
        "[annotation/v6] alignment non-finite for target " +
          t.file +
          "; not propagating to it.",
      );
      continue;
    }
    out[t.file] = { start: s, end: e };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Drag-mode wiring
// ---------------------------------------------------------------------------

function syncDrawMode() {
  const ann = state.getById(state.getActiveId());
  const wantEnabled =
    !!ann &&
    uiState.getDrawerOpen() &&
    uiState.getMode() === "edit" &&
    uiState.getDrawMode();
  const key = wantEnabled ? `on:${ann.id}:${ann.color}` : "off";
  if (key === _lastDrawModeKey) return;
  _lastDrawModeKey = key;

  // Tear down any prior wiring.
  _tearDownDragMode();
  if (!wantEnabled) {
    setDrawModeActive(false);
    return;
  }
  _setUpDragMode(ann);
}

function _setUpDragMode(ann) {
  setDrawModeActive(true);
  const dragColor = _withAlpha(ann.color, 0.25);
  for (const file of Object.keys(_regionsPlugins)) {
    const plugin = _regionsPlugins[file];
    if (!plugin) continue;
    const cleanup = plugin.enableDragSelection({ color: dragColor });
    if (typeof cleanup === "function") _dragSelectionCleanups.push(cleanup);
    const onCreated = (region) => {
      const id = region && region.id;
      if (id && id.startsWith(V6_REGION_PREFIX)) return; // programmatic
      if (id === "timer") return;
      if (id && id.startsWith("anno_region_")) return; // legacy
      if (id && id.startsWith("draft_")) return; // legacy
      // User-drawn drag selection. Capture times, drop the ephemeral region,
      // dispatch to state — sync will re-add it with V6 styling + metadata.
      const start = region.start;
      const end = region.end;
      try {
        region.remove();
      } catch (_) {}
      const activeId = state.getActiveId();
      if (!activeId) return;
      // Ignore vanishingly small drags (sub-10ms — accidental clicks).
      if (Math.abs(end - start) < 0.01) return;
      state.addRegion(activeId, file, start, end);
    };
    plugin.on("region-created", onCreated);
    _activeRegionCreatedListeners.push({ plugin, file, fn: onCreated });
  }
}

function _tearDownDragMode() {
  _dragSelectionCleanups.forEach((fn) => {
    try {
      fn();
    } catch (_) {}
  });
  _dragSelectionCleanups = [];
  _activeRegionCreatedListeners.forEach(({ plugin, fn }) => {
    try {
      plugin.un("region-created", fn);
    } catch (_) {}
  });
  _activeRegionCreatedListeners = [];
}

// ---------------------------------------------------------------------------
// Shift-held region-duration overlay
//
// On Shift-down: each V6 region gets a duration label centered horizontally
// on it, and gap labels appear between consecutive V6 regions on each loaded
// waveform. Both label types share the .lh-v6-duration-label style and are
// positioned to sit just below the time-axis labels. Cleared on Shift-up or
// window blur.
// ---------------------------------------------------------------------------

const _durationLabelElements = []; // DOM nodes to remove on clear

function _formatDuration(seconds) {
  const abs = Math.abs(seconds);
  if (abs < 60) return abs.toFixed(2) + "s";
  const m = Math.floor(abs / 60);
  const s = (abs % 60).toFixed(1);
  return m + ":" + String(s).padStart(4, "0");
}

function _appendDurationLabel(parent, midX, text, kind) {
  const label = document.createElement("div");
  label.className = "lh-v6-duration-label " + kind;
  label.textContent = text;
  label.style.left = midX + "px";
  parent.appendChild(label);
  _durationLabelElements.push(label);
}

function _showRegionDurations() {
  _clearRegionDurations();
  for (const file of Object.keys(_regionsPlugins)) {
    const plugin = _regionsPlugins[file];
    if (!plugin) continue;
    const v6Regions = plugin
      .getRegions()
      .filter((r) => r.id && r.id.startsWith(V6_REGION_PREFIX))
      .slice()
      .sort((a, b) => a.start - b.start);
    if (v6Regions.length === 0) continue;
    const ow = _overlayWrappers[file];
    const ws = wavesurfers[file];
    if (!ow || !ow.inner || !ws) continue;
    const dur = ws.getDuration();
    const fullW = ow.inner.offsetWidth;
    if (!Number.isFinite(dur) || dur <= 0 || fullW <= 0) continue;
    // In-region labels — centered horizontally on each region.
    for (const r of v6Regions) {
      const midTime = (r.start + r.end) / 2;
      const midX = (midTime / dur) * fullW;
      _appendDurationLabel(
        ow.inner,
        midX,
        _formatDuration(r.end - r.start),
        "in-region",
      );
    }
    // Gap labels — centered between consecutive regions.
    for (let i = 0; i < v6Regions.length - 1; i++) {
      const a = v6Regions[i];
      const b = v6Regions[i + 1];
      const gap = b.start - a.end;
      if (gap <= 0) continue;
      const midX = ((a.end + b.start) / 2 / dur) * fullW;
      _appendDurationLabel(
        ow.inner,
        midX,
        _formatDuration(gap),
        "between-regions",
      );
    }
  }
}

function _clearRegionDurations() {
  for (const el of _durationLabelElements) el.remove();
  _durationLabelElements.length = 0;
}
