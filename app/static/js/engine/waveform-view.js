// engine/waveform-view.js
//
// The per-waveform renderer: everything painted *over* a WaveSurfer instance
// rather than by it — the alignment grid, the time axis, the tempo curve, and
// the relative-position indicator.
//
// These were closures inside prepareWaveform's "ready" handler, captured over
// one filename and its canvases and then published into the DataSession's
// gridRedrawers / positionUpdaters maps so the rest of the app could call back
// into a single waveform's renderer. That indirection *was* an implicit
// WaveformView (design doc §3); this module makes it explicit: `waveformViews`
// holds each waveform's DOM refs, and the drawing functions take a filename.
//
// The positionUpdaters registry is gone (increment 19): every entry was just
// `() => updatePositionIndicator(filename)`, so callers now invoke that directly.
//
// A view is built in TWO phases (increment 19 V4 + roadmap item L):
//   1. ensureWaveformView(filename, container) — the moment the waveform's row
//      exists in the pane. The view is the WORKING-SET entry: this recording is
//      in the pane, whether or not it has a renderer yet.
//   2. createWaveformOverlays(...) — in the "ready" handler, once WaveSurfer has
//      painted and the overlay wrapper exists. This fills in the canvases and
//      makes the view RENDERED.
// So `waveformViews[f]` no longer means "has a renderer"; isWaveformRendered(f)
// does. Keeping the two apart is what lets a recording exist in the pane with
// its audio and WaveSurfer instance not yet created at all.
//
// The tempo curve is drawn here but derived in listen.js, behind the single
// getTempoDrawModel() accessor: the derivation (cache, smoothing, scope, corpus
// mean, Y-range) is still in flux, so a later rework should not have to touch
// this module.
//
// Extracted from listen.js (Phase 1 refactor, cluster L). Behaviour-preserving.

import {
  alignmentGrids,
  wavesurfers,
  parseCssColor,
  wfBgCache,
  refreshWfBg,
  getTempoDrawModel,
} from "../listen.js";
import { getZoomedWidth } from "./zoom-scroll.js";
import { drawTimeTicks } from "./time-axis.js";
import { clearMap } from "./data-session.js";

// ---------------------------------------------------------------------------
// One view per waveform in the pane: filename → { filename, container, regions,
// ow, gridCanvas, positionIndicatorCanvas, tempoCanvas }. Everything but
// `filename` and `container` starts null and is filled in as the waveform is
// built up.
//
// These are renderer internals, not session data, so they live here rather than
// in DataSession. This map IS the per-waveform WaveformView registry of design
// doc §3; increment 19 folded the other per-filename stores into it, so a
// waveform's renderer state is created and torn down as one unit instead of via
// a manual per-store checklist.
//
// Reference-stable and reset in place (clearMap), so importers may hold it.
//
// Its key set is the WORKING SET — the recordings the user has in the pane. That
// is deliberately NOT the same question as "does this have a live WaveSurfer",
// which `wavesurfers` answers; the two only coincide when nothing is deferred.
// Use isWaveformRendered() for readiness, never the key set.
// ---------------------------------------------------------------------------
export const waveformViews = {};

/**
 * Register this waveform's view, or return the existing one.
 *
 * Called as soon as the waveform's row is in the pane, long before there is a
 * WaveSurfer instance to render into it — that is the point: the view is where
 * a not-yet-rendered waveform is recorded.
 */
export function ensureWaveformView(filename, container) {
  const existing = waveformViews[filename];
  if (existing) {
    // A reload rebuilds the row; keep the view but point it at the live node.
    if (container) existing.container = container;
    return existing;
  }
  const view = {
    filename,
    container,
    regions: null, // RegionsPlugin, set when WaveSurfer is created
    ow: null, // overlay wrapper, set in the ready handler
    gridCanvas: null,
    positionIndicatorCanvas: null,
    tempoCanvas: null,
  };
  waveformViews[filename] = view;
  return view;
}

/**
 * True once this waveform's overlay canvases exist, i.e. there is something to
 * draw into. The readiness check for every painting path — a view on its own
 * only means the row is in the pane.
 */
export function isWaveformRendered(filename) {
  return !!waveformViews[filename]?.gridCanvas;
}

/** Attach the RegionsPlugin created alongside this waveform's WaveSurfer. */
export function setRegionsPlugin(filename, plugin) {
  ensureWaveformView(filename).regions = plugin;
}

/**
 * Every [filename, RegionsPlugin] pair that actually has a plugin. Replaces
 * `Object.keys(regionsPlugins)` at the call sites that used to iterate the
 * standalone map — a view without a renderer simply isn't yielded.
 */
export function regionsPluginEntries() {
  const out = [];
  for (const view of Object.values(waveformViews)) {
    if (view.regions) out.push([view.filename, view.regions]);
  }
  return out;
}

/**
 * Fill in this waveform's overlay canvases — phase 2 of the view, run from the
 * "ready" handler once WaveSurfer has painted. After this the view is RENDERED.
 *
 * Canvas order matters: they stack on the (viewport-fixed, untransformed)
 * overlay wrapper as grid → tempo → position indicator, beneath the inner div
 * that carries the markers.
 */
export function createWaveformOverlays(filename, container, waveHeight, ow) {
  const gridCanvas = document.createElement("canvas");
  const positionIndicatorCanvas = document.createElement("canvas");
  gridCanvas.classList.add("alignment-grid");
  gridCanvas.width = container.clientWidth;
  gridCanvas.height = waveHeight;
  gridCanvas.style.pointerEvents = "none";
  positionIndicatorCanvas.classList.add("position-indicator");
  positionIndicatorCanvas.width = container.clientWidth;
  positionIndicatorCanvas.height = waveHeight;
  positionIndicatorCanvas.style.pointerEvents = "none";
  // Tempo curve canvas (viewport-sized, between grid and position indicator)
  const tempoCanvas = document.createElement("canvas");
  tempoCanvas.classList.add("tempo-curve");
  tempoCanvas.width = container.clientWidth;
  tempoCanvas.height = waveHeight;
  tempoCanvas.style.pointerEvents = "none";

  // Canvases go on the wrapper (viewport-fixed, not transformed)
  ow.wrapper.insertBefore(positionIndicatorCanvas, ow.inner);
  ow.wrapper.insertBefore(tempoCanvas, positionIndicatorCanvas);
  ow.wrapper.insertBefore(gridCanvas, tempoCanvas);

  const view = ensureWaveformView(filename, container);
  view.ow = ow;
  view.gridCanvas = gridCanvas;
  view.positionIndicatorCanvas = positionIndicatorCanvas;
  view.tempoCanvas = tempoCanvas;
  return view;
}

/** Drop one waveform's view (called when its waveform is pruned/destroyed). */
export function disposeWaveformView(filename) {
  delete waveformViews[filename];
}

/** Drop every view (called when all waveforms are torn down and rebuilt). */
export function clearWaveformViews() {
  clearMap(waveformViews);
}

/**
 * Repaint every position-indicator canvas relative to `filename`'s playhead.
 *
 * The playing waveform gets a plain vertical line; every other loaded waveform
 * gets a slanted bracket at its own aligned position, so the slant tips line up
 * vertically across the stack and show each recording's temporal offset.
 */
export function updatePositionIndicator(filename) {
  // Both of these can legitimately be absent: a waveform can be in the pane
  // with no renderer yet (item L), and a stale row can outlive its alignment
  // grid (#32). Bail rather than throw — this runs on every audioprocess tick,
  // so a throw here takes the playback loop with it.
  const grid = alignmentGrids[filename];
  const ws = wavesurfers[filename];
  if (!grid || !grid.length || !ws) return;
  // work out current alignment grid index via binary search
  const currentTime = ws.getCurrentTime();
  let lo = 0,
    hi = grid.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (grid[mid] <= currentTime) lo = mid + 1;
    else hi = mid;
  }
  let currentGridIx = Math.max(0, lo - 1);
  if (currentGridIx <= 0 && currentTime > grid[grid.length - 1]) {
    currentGridIx = grid.length - 1;
  }
  // iterate through all positionIndicatorCanvases, drawing in current ix position
  const canvases = document.getElementsByClassName("position-indicator");
  const visrelalign = document.getElementById("visrelalign").checked;
  Array.from(canvases).forEach((c) => {
    const file =
      c.closest(".wf-overlays")?.parentElement?.dataset["ix"] ||
      c.closest(".waveform")?.dataset["ix"];
    if (!file || !wavesurfers[file] || !alignmentGrids[file]) return;
    const ctx = c.getContext("2d");
    const duration = wavesurfers[file].getDuration();
    const fullW = getZoomedWidth(file);
    const scrollLeft = wavesurfers[file].getScroll();
    ctx.clearRect(0, 0, c.width, c.height);
    if (!visrelalign) return;

    if (file === filename) {
      // Playing waveform: simple vertical line at current playback position
      const x = (currentTime / duration) * fullW - scrollLeft;
      const _piC = parseCssColor(getComputedStyle(document.documentElement).getPropertyValue("--color-alignment-playhead").trim()) || { r: 100, g: 100, b: 200 };
      ctx.beginPath();
      ctx.lineWidth = 2;
      ctx.strokeStyle = `rgba(${_piC.r},${_piC.g},${_piC.b},0.7)`;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, c.height);
      ctx.stroke();
    } else {
      // Non-playing waveform: vertical section at the corresponding
      // aligned position, with slanted top/bottom pointing toward
      // the playing waveform's indicator position (so all slant tips
      // form a continuous vertical line across stacked waveforms).
      const correspondingSeconds = alignmentGrids[file][currentGridIx];
      const alignedX =
        (correspondingSeconds / duration) * fullW - scrollLeft;
      // playingX: project the playing file's absolute time onto this
      // file's time axis, so the slant shows the temporal offset
      // between the playing file's clock time and the aligned position.
      const playingX = (currentTime / duration) * fullW - scrollLeft;
      const diffMapped = Math.floor((255 * (playingX - alignedX)) / 100);
      ctx.beginPath();
      ctx.lineWidth = 2;
      ctx.moveTo(playingX, 0);
      ctx.lineTo(alignedX, c.height / 6);
      ctx.lineTo(alignedX, 5 * (c.height / 6));
      ctx.lineTo(playingX, c.height);
      ctx.strokeStyle =
        diffMapped < 0
          ? `rgb(${-1 * diffMapped} 100 100)`
          : `rgb(100 100 ${diffMapped})`;
      ctx.stroke();
    }
  });
}

/**
 * Draw (or redraw) one waveform's alignment grid, time ticks, and tempo curve.
 * At zoom, draws only the visible viewport portion, offset by scroll.
 */
export function drawAlignmentGrid(filename) {
  const view = waveformViews[filename];
  // No canvases means the view exists but has not been rendered yet (its
  // waveform is deferred, or still between create and "ready"). Nothing to
  // paint into, and there will be a draw on ready.
  if (!view || !view.gridCanvas) return;
  const { container, gridCanvas, positionIndicatorCanvas, ow } = view;
  if (!container || !container.isConnected) return;
  if (!wavesurfers[filename]) return;
  const viewW = container.clientWidth;
  const h = wavesurfers[filename].options.height || 128;
  gridCanvas.width = viewW;
  gridCanvas.height = h;
  positionIndicatorCanvas.width = viewW;
  positionIndicatorCanvas.height = h;
  // Update overlay wrapper height
  ow.wrapper.style.height = h + "px";
  // Update inner wrapper width to match zoomed waveform width
  const fullW = getZoomedWidth(filename);
  ow.inner.style.width = fullW + "px";

  const ctx = gridCanvas.getContext("2d");
  ctx.clearRect(0, 0, viewW, h);
  const dur = wavesurfers[filename].getDuration();
  const scrollLeft = wavesurfers[filename].getScroll();

  // Draw alignment grid lines first (so time ticks render on top)
  const visalignEl = document.getElementById("visalign");
  if (visalignEl && visalignEl.checked) {
    const grid = alignmentGrids[filename] || [];
    const gridLen = grid.length;
    if (gridLen > 0) {
      ctx.lineWidth = 1;
      const minPixelStep = 4;
      const pxPerIdx = fullW / gridLen;

      // Compute a deterministic stride so the same grid indices are
      // selected on every frame regardless of scroll position.  This
      // prevents flickering caused by different indices passing a
      // distance filter as scrollLeft changes between frames.
      const stride = Math.max(1, Math.round(minPixelStep / pxPerIdx));

      // Visible range of grid indices (with margin for angled lines)
      const margin = 10;
      // Align loIdx to stride boundary so selection is scroll-independent
      let loIdx = Math.max(
        0,
        Math.floor(((scrollLeft - margin) / fullW) * gridLen),
      );
      loIdx = loIdx - (loIdx % stride); // snap down to stride boundary
      let hiIdx = Math.min(
        gridLen - 1,
        Math.ceil(((scrollLeft + viewW + margin) / fullW) * gridLen),
      );

      // Draw solid lines for the top and bottom sections
      const _agC = parseCssColor(getComputedStyle(document.documentElement).getPropertyValue("--color-alignment").trim()) || { r: 140, g: 90, b: 90 };
      const _agRgb = `${_agC.r},${_agC.g},${_agC.b}`;
      ctx.beginPath();
      ctx.setLineDash([]);
      ctx.strokeStyle = `rgba(${_agRgb},0.55)`;
      for (let gridIx = loIdx; gridIx <= hiIdx; gridIx += stride) {
        const absoluteX = gridIx * pxPerIdx - scrollLeft;
        const relativeX = (grid[gridIx] / dur) * fullW - scrollLeft;
        ctx.moveTo(absoluteX, 0);
        ctx.lineTo(relativeX, h / 6);
        ctx.moveTo(relativeX, 5 * (h / 6));
        ctx.lineTo(absoluteX, h);
      }
      ctx.stroke();

      // Draw sparsely dotted lines over the waveform section
      ctx.beginPath();
      ctx.strokeStyle = `rgba(${_agRgb},0.3)`;
      ctx.setLineDash([2, 1]);
      for (let gridIx = loIdx; gridIx <= hiIdx; gridIx += stride) {
        const relativeX = (grid[gridIx] / dur) * fullW - scrollLeft;
        if (relativeX > viewW + margin || relativeX < -margin) continue;
        ctx.moveTo(relativeX, h / 6);
        ctx.lineTo(relativeX, 5 * (h / 6));
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // Draw time ticks
  const tickBg = wfBgCache[filename] || refreshWfBg(filename);
  const _dttStyle = getComputedStyle(document.documentElement);
  const tickText = _dttStyle.getPropertyValue("--color-text-muted").trim() || "rgba(60,60,60,0.7)";
  const tickColor = _dttStyle.getPropertyValue("--color-waveform-tick").trim() || "#505050";
  drawTimeTicks(ctx, viewW, h, fullW, dur, scrollLeft, tickBg, tickText, tickColor);

  // Draw tempo curve
  _drawTempoCurve(view);
}

function _drawTempoCurve(view) {
  const { filename, container, tempoCanvas } = view;
  if (!container || !container.isConnected) return;
  const viewW = container.clientWidth;
  const h = wavesurfers[filename].options.height || 128;
  tempoCanvas.width = viewW;
  tempoCanvas.height = h;

  // Everything the curve is derived FROM stays in listen.js, which is still in
  // flux; this renderer consumes only the snapshot. Note the canvas has already
  // been resized (and therefore cleared) above, before we can bail — toggling
  // the curve off has to wipe the previous frame.
  const model = getTempoDrawModel(filename);
  if (!model) return;
  const { mode, yRange: tempoRange, smoothed, corpusMean } = model;
  const dur = wavesurfers[filename].getDuration();
  const fullW = getZoomedWidth(filename);
  const scrollLeft = wavesurfers[filename].getScroll();
  const ctx = tempoCanvas.getContext("2d");

  // Read theme colours for tempo curve once per draw
  const _tcStyle = getComputedStyle(document.documentElement);
  const _tcBase = parseCssColor(_tcStyle.getPropertyValue("--color-tempo").trim()) || { r: 30, g: 80, b: 140 };
  const _tcRgb = `${_tcBase.r},${_tcBase.g},${_tcBase.b}`;
  const _outlierBase = parseCssColor(_tcStyle.getPropertyValue("--color-outlier").trim()) || { r: 180, g: 60, b: 60 };
  const _outlierRgb = `${_outlierBase.r},${_outlierBase.g},${_outlierBase.b}`;

  // Map tempo value to Y coordinate (top = high, bottom = low)
  // Use middle 70% of canvas height (leave room for grid and ticks)
  const yTop = h * 0.1;
  const yBot = h * 0.85;
  const yRange = tempoRange.max - tempoRange.min;
  function valToY(val) {
    if (yRange <= 0) return (yTop + yBot) / 2;
    const frac = (val - tempoRange.min) / yRange;
    return yBot - frac * (yBot - yTop); // inverted: high values at top
  }

  // Build screen-space points, tracking which are clipped
  const pts = [];
  for (let i = 0; i < smoothed.length; i++) {
    const x = (smoothed[i].time / dur) * fullW - scrollLeft;
    let val = smoothed[i].tempo;
    if (mode === "relative" && corpusMean) {
      const key = Math.round(smoothed[i].scoreTime * 1e6) / 1e6;
      const ref = corpusMean.get(key);
      val = ref && ref > 0 ? ((smoothed[i].tempo - ref) / ref) * 100 : 0;
    }
    // Track clipping direction: -1 = below, +1 = above, 0 = within range
    let clipped = 0;
    if (val > tempoRange.max) clipped = 1;
    else if (val < tempoRange.min) clipped = -1;
    val = Math.max(tempoRange.min, Math.min(tempoRange.max, val));
    pts.push({ x, y: valToY(val), clipped });
  }

  // Cull to viewport with one-point margin on each side
  let startIdx = 0,
    endIdx = pts.length - 1;
  while (startIdx < pts.length - 1 && pts[startIdx + 1].x < -10)
    startIdx++;
  while (endIdx > 0 && pts[endIdx - 1].x > viewW + 10) endIdx--;
  if (startIdx > 0) startIdx--;
  if (endIdx < pts.length - 1) endIdx++;

  if (startIdx >= endIdx) return;

  // Draw shaded area under curve
  const zeroY = mode === "relative" ? valToY(0) : yBot;
  ctx.beginPath();
  ctx.moveTo(pts[startIdx].x, zeroY);
  for (let i = startIdx; i <= endIdx; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.lineTo(pts[endIdx].x, zeroY);
  ctx.closePath();
  ctx.fillStyle =
    mode === "relative"
      ? `rgba(${_tcRgb},0.22)`
      : `rgba(${_tcRgb},0.25)`;
  ctx.fill();

  // Draw the curve line
  ctx.beginPath();
  ctx.moveTo(pts[startIdx].x, pts[startIdx].y);
  for (let i = startIdx + 1; i <= endIdx; i++)
    ctx.lineTo(pts[i].x, pts[i].y);
  ctx.strokeStyle = `rgba(${_tcRgb},0.9)`;
  ctx.lineWidth = 1.75;
  ctx.stroke();

  // In relative mode, draw zero line
  if (mode === "relative") {
    ctx.beginPath();
    ctx.moveTo(0, zeroY);
    ctx.lineTo(viewW, zeroY);
    ctx.strokeStyle = `rgba(${_tcRgb},0.5)`;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // --- Y-axis labels ---
  const yAxisNiceSteps =
    mode === "relative"
      ? [1, 2, 5, 10, 20, 25, 50, 100]
      : [5, 10, 20, 25, 50, 100, 200, 500];
  const targetTicks = 4;
  const rawStep = yRange / targetTicks;
  let yStep = yAxisNiceSteps[yAxisNiceSteps.length - 1];
  for (const s of yAxisNiceSteps) {
    if (s >= rawStep) {
      yStep = s;
      break;
    }
  }
  ctx.font = "9px sans-serif";
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  // Start from a round number at or above yRange min
  const firstTick = Math.ceil(tempoRange.min / yStep) * yStep;
  for (let v = firstTick; v <= tempoRange.max; v += yStep) {
    const y = valToY(v);
    if (y < 2 || y > h - 2) continue;
    // Tick line
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(4, y);
    ctx.strokeStyle = `rgba(${_tcRgb},0.7)`;
    ctx.lineWidth = 1;
    ctx.stroke();
    // Label
    let tickLabel;
    if (mode === "relative") {
      tickLabel = (v >= 0 ? "+" : "") + v + "%";
    } else {
      tickLabel = String(Math.round(v));
    }
    ctx.fillStyle = `rgba(${_tcRgb},0.95)`;
    ctx.fillText(tickLabel, 5, y);
  }
  // Unit label at top
  ctx.fillStyle = `rgba(${_tcRgb},0.75)`;
  ctx.font = "8px sans-serif";
  ctx.textBaseline = "bottom";
  ctx.fillText(
    mode === "relative" ? "% avg." : "QPM",
    5,
    yTop - 1,
  );

  // --- Clipped-value indicators (small triangles at top/bottom edge) ---
  ctx.fillStyle = `rgba(${_outlierRgb},0.85)`;
  const triH = 5,
    triW = 4;
  for (let i = startIdx; i <= endIdx; i++) {
    if (!pts[i].clipped) continue;
    const px = pts[i].x;
    if (px < -triW || px > viewW + triW) continue;
    ctx.beginPath();
    if (pts[i].clipped > 0) {
      // Arrow pointing up at top edge
      ctx.moveTo(px, yTop);
      ctx.lineTo(px - triW, yTop + triH);
      ctx.lineTo(px + triW, yTop + triH);
    } else {
      // Arrow pointing down at bottom edge
      ctx.moveTo(px, yBot);
      ctx.lineTo(px - triW, yBot - triH);
      ctx.lineTo(px + triW, yBot - triH);
    }
    ctx.closePath();
    ctx.fill();
  }
}