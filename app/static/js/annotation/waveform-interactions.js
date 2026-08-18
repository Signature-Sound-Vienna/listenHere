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
import { fmtRegionRange, fmtRegionDuration } from "./ui-editor.js";
import { confirmRemoveIfTextful } from "./ui-common.js";
import {
  regionsPlugins,
  overlayWrappers,
  wavesurfers,
  setDrawModeActive,
  setCurrentAudioInactive,
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
  syncSelectionOverlays();
}

// ---------------------------------------------------------------------------
// Region rendering
// ---------------------------------------------------------------------------

function syncRegions() {
  if (_syncingRegions) return;
  _syncingRegions = true;
  try {
    const annotations = state.getAll();
    const activeId = state.getActiveId();
    const specsByFile = _computeSpecsByFile(annotations, activeId);
    for (const file of Object.keys(regionsPlugins)) {
      const plugin = regionsPlugins[file];
      if (!plugin) continue;
      _ensureHooked(plugin, file);
      _reconcileForFile(plugin, file, specsByFile[file] || []);
    }
  } finally {
    _syncingRegions = false;
  }
  // Region elements are (re)created during reconciliation, so re-apply the
  // active close-listening region-start border afterwards.
  _applyActiveRegionStyling();
}

// ---------------------------------------------------------------------------
// Active close-listening jump target (region-start variant)
// ---------------------------------------------------------------------------
// When close-listening's active jump target is a region start (rather than a
// marker), it's indicated with a left border on the region, matching the
// marker thickness (2px) and coloured to the annotation. listen.js owns the
// active-target selection and calls setActiveRegionStart to paint/clear it.

let _activeRegionRef = null; // { annId, regionId } | null

export function setActiveRegionStart(ref) {
  _activeRegionRef = ref || null;
  _applyActiveRegionStyling();
}

function _applyActiveRegionStyling() {
  const ref = _activeRegionRef;
  // The active jump target can be any annotation's region start (not only the
  // currently-active annotation's), so paint the border using that region's
  // own annotation colour. The border is cleared whenever the active target
  // changes or close-listening exits (listen.js calls setActiveRegionStart).
  const ann = ref ? state.getById(ref.annId) : null;
  const color = ann ? ann.color : null;
  for (const file of Object.keys(regionsPlugins)) {
    const plugin = regionsPlugins[file];
    if (!plugin) continue;
    for (const r of plugin.getRegions()) {
      if (!r.id || !r.id.startsWith(V6_REGION_PREFIX) || !r.element) continue;
      const meta = r._v6Meta;
      const isActive =
        !!color &&
        meta &&
        meta.annId === ref.annId &&
        meta.regionId === ref.regionId;
      r.element.style.borderLeft = isActive ? `2px solid ${color}` : "";
    }
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
  // `region-update` fires continuously during drag/resize. We only use it
  // to refresh the dragged target's row in the drawer (cheap DOM-only
  // patch — no state mutation, no editor rebuild), so the numbers move
  // in step with the cursor. The proper state update + alignment
  // propagation happens once on drop via `region-updated` below.
  plugin.on("region-update", (region) => {
    const meta = region && region._v6Meta;
    if (!meta) return;
    const start = Math.min(region.start, region.end);
    const end = Math.max(region.start, region.end);
    const ann = state.getById(meta.annId);
    _liveUpdateRegionRow(file, meta.regionId, start, end, ann && ann.color);
  });
  plugin.on("region-updated", (region) => {
    const meta = region && region._v6Meta;
    if (!meta) return;
    // Cancel any in-flight live-update rAF so it doesn't fire AFTER the
    // editor re-renders below and re-apply the "dragging" class to the
    // freshly-rendered row (which is what was leaving the source row
    // permanently coloured).
    _cancelPendingLiveUpdate();
    const start = Math.min(region.start, region.end);
    const end = Math.max(region.start, region.end);
    const ann = state.getById(meta.annId);
    const annColor = ann && ann.color;
    if (_shiftHeld) {
      // Local override: only this recording's times change. Flash just
      // the source row so the user sees confirmation of the local edit.
      state.updateRegionTime(meta.annId, file, meta.regionId, { start, end });
      _flashRows(meta.regionId, [file], annColor);
      return;
    }
    if (!ann) return;
    // Propagate alignment-aware to every attached recording, then flash
    // every row that received the propagation — including the source —
    // so all updated numbers light up in the region colour and fade
    // back to default in step.
    const timesByFile = _alignedTimesByFile(ann, file, start, end);
    state.updateRegionTimeMulti(meta.annId, meta.regionId, timesByFile);
    _flashRows(meta.regionId, Object.keys(timesByFile), annColor);
  });
}

/**
 * Cheap DOM-only update of the drawer's region row for (file, regionId)
 * during a drag. rAF-coalesced so a burst of region-update events maps
 * to one paint. No state mutation — that happens on drop. Returns early
 * if the drawer isn't currently rendering this row (e.g. drawer closed,
 * different annotation active, viewer mode).
 *
 * Tints the source row's time/duration in the annotation's colour for
 * the duration of the drag (the `.lh-v6-region-dragging` class + CSS
 * custom property are picked up by the editor stylesheet). The next
 * editor re-render — which fires on the `region-updated` drop event —
 * rebuilds the row from scratch and the tint clears naturally.
 */
let _liveRafHandle = null;
let _livePending = null; // { file, regionId, start, end, annColor }
function _liveUpdateRegionRow(file, regionId, start, end, annColor) {
  _livePending = { file, regionId, start, end, annColor };
  if (_liveRafHandle != null) return;
  _liveRafHandle = requestAnimationFrame(() => {
    _liveRafHandle = null;
    const p = _livePending;
    _livePending = null;
    if (!p) return;
    const row = _findRegionRow(p.file, p.regionId);
    if (!row) return;
    if (p.annColor) {
      row.style.setProperty("--lh-v6-region-color", p.annColor);
      row.classList.add("lh-v6-region-dragging");
    }
    const timeEl = row.querySelector(".lh-v6-region-time");
    const durEl = row.querySelector(".lh-v6-region-dur");
    if (timeEl) timeEl.textContent = fmtRegionRange(p.start, p.end);
    if (durEl) {
      const d = fmtRegionDuration(p.end - p.start);
      durEl.textContent = d;
      durEl.style.display = d ? "" : "none";
    }
  });
}

/**
 * Cancel any pending live-update rAF. Called by the drop handler so a
 * region-update event scheduled mid-drag doesn't fire AFTER the editor
 * re-renders — that's what was leaving the source row stuck in the
 * dragging-coloured state.
 */
function _cancelPendingLiveUpdate() {
  if (_liveRafHandle != null) {
    cancelAnimationFrame(_liveRafHandle);
    _liveRafHandle = null;
  }
  _livePending = null;
}

/**
 * Briefly flash the time/duration in each given target's row for this
 * region in the annotation's colour, then fade back to the row's
 * default text colour over 0.5s. Used on drop for every row that
 * received an update (source + other targets for a global propagation,
 * source only for shift-drag/local).
 */
function _flashRows(regionId, files, annColor) {
  if (!annColor) return;
  for (const f of files) {
    const row = _findRegionRow(f, regionId);
    if (!row) continue;
    row.style.setProperty("--lh-v6-region-color", annColor);
    // Force a clean re-start even if a prior flash is still running.
    row.classList.remove("lh-v6-region-flash");
    void row.offsetWidth;
    row.classList.add("lh-v6-region-flash");
    const onEnd = (e) => {
      if (e.target !== row && !row.contains(e.target)) return;
      row.classList.remove("lh-v6-region-flash");
      row.style.removeProperty("--lh-v6-region-color");
      row.removeEventListener("animationend", onEnd);
    };
    row.addEventListener("animationend", onEnd);
  }
}

function _findRegionRow(file, regionId) {
  try {
    const fileSel = CSS.escape(file);
    const idSel = CSS.escape(regionId);
    return document.querySelector(
      `.lh-v6-region-row[data-region-file="${fileSel}"][data-region-id="${idSel}"]`,
    );
  } catch (_) {
    return null;
  }
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
  // Pixel threshold (default 3) bumped to 10 so click jitter doesn't get
  // interpreted as a drag and create an accidental thin region. Intentional
  // drags clear this easily; jittered clicks fall back to the click handler.
  const DRAG_THRESHOLD_PX = 10;
  for (const file of Object.keys(regionsPlugins)) {
    const plugin = regionsPlugins[file];
    if (!plugin) continue;
    const cleanup = plugin.enableDragSelection(
      { color: dragColor },
      DRAG_THRESHOLD_PX,
    );
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
      // Clicks (and jitter-clicks that just barely cross the drag-selection
      // pixel threshold) shouldn't create a region — only intentional
      // drags should. Threshold raised from 10ms to 100ms of audio to
      // filter out the WaveSurfer drag-selection plugin's initial
      // start+5px placeholder when the user releases without further
      // motion. The attach-on-click path lives elsewhere and is
      // unaffected.
      if (Math.abs(end - start) < 0.1) return;
      // Map the drag bounds into every other target's timescale via the
      // alignment grid so the regions list shows each recording's own
      // seconds (otherwise every target would show the source file's
      // raw timestamps — see issue surfaced 2026-05-25). Belt-and-braces:
      // any exception here MUST NOT block the addRegion call, otherwise
      // the source region just disappears (region.remove() ran above).
      let timesByFile = null;
      try {
        const ann = state.getById(activeId);
        if (ann) timesByFile = _alignedTimesByFile(ann, file, start, end);
      } catch (err) {
        console.warn("[annotation/v6] alignment map for new region failed; falling back to mirrored times.", err);
      }
      state.addRegion(activeId, file, start, end, timesByFile);
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
  for (const file of Object.keys(regionsPlugins)) {
    const plugin = regionsPlugins[file];
    if (!plugin) continue;
    const v6Regions = plugin
      .getRegions()
      .filter((r) => r.id && r.id.startsWith(V6_REGION_PREFIX))
      .slice()
      .sort((a, b) => a.start - b.start);
    if (v6Regions.length === 0) continue;
    const ow = overlayWrappers[file];
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

// ---------------------------------------------------------------------------
// Selection affordance
//
// Each waveform gets a small V6-specific indicator button at top-left:
//   - Hidden when waveform is not in the active annotation's targets.
//   - Visible (✓) when selected, during drawer-open + edit-mode + active ann.
//   - On hover the ✓ swaps to ✕ via CSS; clicking it removes the file from
//     the selection, stashing any per-recording note into sessionStorage for
//     restoration if the user re-selects within the session.
//
// Clicking anywhere else on an UN-selected waveform adds it to the
// selection (with alignment-aware region times and orphan-note restore).
//
// The legacy `.wf-select-overlay` stays in the DOM but stays hidden (we
// never add `.visible` to it). Phase F's legacy-removal will delete it.
// ---------------------------------------------------------------------------

const _wiredWaveformsForAdd = new WeakSet();
const _wiredIndicators = new WeakSet();

function syncSelectionOverlays() {
  const ann = state.getById(state.getActiveId());
  const editing =
    !!ann && uiState.getDrawerOpen() && uiState.getMode() === "edit";
  const attached = editing
    ? new Set(ann.targets.map((t) => t.file))
    : new Set();

  // Body-level class drives the desaturation CSS for unselected waveforms.
  if (typeof document !== "undefined" && document.body) {
    document.body.classList.toggle("lh-v6-edit-active", editing);
  }

  for (const file of Object.keys(regionsPlugins)) {
    const wfEl = document.querySelector(
      ".waveform[data-ix='" +
        (window.CSS && CSS.escape ? CSS.escape(file) : file) +
        "']",
    );
    if (!wfEl) continue;
    _wireWaveformClickOnce(wfEl, file);
    const indicator = _ensureIndicator(wfEl, file);
    const showIndicator = editing && attached.has(file);
    indicator.classList.toggle("visible", showIndicator);
    // Per-waveform selected class — CSS combines with body class above to
    // desaturate unselected waveforms during edit mode.
    wfEl.classList.toggle("lh-v6-selected", editing && attached.has(file));
  }
}

function _ensureIndicator(wfEl, file) {
  let indicator = wfEl.querySelector(".lh-v6-selection-indicator");
  if (!indicator) {
    indicator = document.createElement("button");
    indicator.type = "button";
    indicator.className = "lh-v6-selection-indicator";
    indicator.title = "Selected — click to remove from this annotation";
    indicator.setAttribute("aria-label", "Remove from annotation");
    wfEl.appendChild(indicator);
  }
  if (!_wiredIndicators.has(indicator)) {
    _wiredIndicators.add(indicator);
    indicator.addEventListener("click", (e) => {
      e.stopPropagation();
      const ann = state.getById(state.getActiveId());
      if (!ann) return;
      const target = ann.targets.find((t) => t.file === file);
      if (!confirmRemoveIfTextful(target && target.description)) return;
      if (target && target.description && target.description.trim().length > 0) {
        _stashOrphanNote(ann.id, file, target.description);
      }
      state.removeTarget(ann.id, file);
      // If this was the active waveform, pause it and drop the .active state
      // so removing also visually deactivates playback.
      setCurrentAudioInactive(file);
    });
  }
  return indicator;
}

function _wireWaveformClickOnce(wfEl, file) {
  if (_wiredWaveformsForAdd.has(wfEl)) return;
  _wiredWaveformsForAdd.add(wfEl);
  wfEl.addEventListener("click", (e) => {
    // The indicator button has its own handler with stopPropagation; this
    // guard is a belt-and-braces in case stopPropagation didn't reach us.
    if (e.target.closest(".lh-v6-selection-indicator")) return;
    const ann = state.getById(state.getActiveId());
    if (!ann) return;
    if (!uiState.getDrawerOpen() || uiState.getMode() !== "edit") return;
    if (ann.targets.some((t) => t.file === file)) return; // already selected
    const regionTimes = _seedRegionTimesForAttach(ann, file);
    const description = _consumeOrphanNote(ann.id, file);
    state.addTarget(ann.id, file, {
      regionTimes: regionTimes || undefined,
      description: description || undefined,
    });
  });
}

function _seedRegionTimesForAttach(ann, newFile) {
  if (ann.regions.length === 0 || ann.targets.length === 0) return null;
  const source = ann.targets[0];
  const out = {};
  for (const r of ann.regions) {
    const src = source.regionTimes[r.id];
    if (!src) continue;
    let fromIdx = null;
    let toIdx = null;
    try {
      fromIdx = getClosestAlignmentIx(src.start, source.file);
      toIdx = getClosestAlignmentIx(src.end, source.file);
    } catch (_) {}
    let s = src.start;
    let e = src.end;
    if (Number.isFinite(fromIdx) && Number.isFinite(toIdx)) {
      try {
        const a = getCorrespondingTime(newFile, fromIdx);
        const b = getCorrespondingTime(newFile, toIdx);
        if (Number.isFinite(a) && Number.isFinite(b)) {
          s = a;
          e = b;
        }
      } catch (_) {}
    }
    out[r.id] = { start: s, end: e };
  }
  return out;
}

// Orphan per-recording notes — survive a detach/re-attach round trip within
// the same browser session. Cleared when the session ends (sessionStorage
// is per-tab, no cross-session persistence).
function _stashKey(annId, file) {
  return (
    "lh-v6-orphan-note:" +
    encodeURIComponent(annId) +
    ":" +
    encodeURIComponent(file)
  );
}

function _stashOrphanNote(annId, file, note) {
  if (!note) return;
  try {
    sessionStorage.setItem(_stashKey(annId, file), note);
  } catch (_) {}
}

function _consumeOrphanNote(annId, file) {
  const key = _stashKey(annId, file);
  let note = null;
  try {
    note = sessionStorage.getItem(key);
    if (note !== null) sessionStorage.removeItem(key);
  } catch (_) {}
  return note;
}
