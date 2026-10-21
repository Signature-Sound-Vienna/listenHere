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
  alignedSpans,
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
 * Every waveform's indicator stands at its own aligned position for the
 * playhead's grid index and takes the shape of an alignment line there, in
 * the visualise-alignments style (2026-10-21): To reference — the top and
 * bottom tips at that index's reference position (index × width), the same
 * point in every waveform; To next — vertical, slanting in the bottom sixth to
 * the next visible waveform's position for the index, the lowest vertical.
 * (The tips used to sit at the playing file's CLOCK time on each waveform's
 * own axis: no shared position at all once durations differ.) The playing
 * waveform keeps the playhead colour; the others are tinted by their slant.
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
  const toNext = _visalignMode() === "next";
  _lastIndicatorFile = filename;
  if (visrelalign && toNext) _watchRowOrder();
  const order = visrelalign && toNext ? _visibleRowOrder() : null;
  const _piC = parseCssColor(getComputedStyle(document.documentElement).getPropertyValue("--color-alignment-playhead").trim()) || { r: 100, g: 100, b: 200 };
  Array.from(canvases).forEach((c) => {
    const file =
      c.closest(".wf-overlays")?.parentElement?.dataset["ix"] ||
      c.closest(".waveform")?.dataset["ix"];
    if (!file || !wavesurfers[file] || !alignmentGrids[file]) return;
    const ctx = c.getContext("2d");
    const fileGrid = alignmentGrids[file];
    const duration = wavesurfers[file].getDuration();
    const fullW = getZoomedWidth(file);
    const scrollLeft = wavesurfers[file].getScroll();
    ctx.clearRect(0, 0, c.width, c.height);
    if (!visrelalign || !c.width || !c.height) return;

    // This waveform's own position for the playhead's grid index (the playing
    // waveform: the playhead itself), and where its tips go.
    const ix = Math.min(currentGridIx, fileGrid.length - 1);
    const alignedX =
      ((file === filename ? currentTime : fileGrid[ix]) / duration) * fullW - scrollLeft;
    let topX = alignedX;
    let bottomX = alignedX;
    if (!toNext) {
      topX = bottomX = (ix / fileGrid.length) * fullW - scrollLeft;
    } else {
      const nb = _lowerNeighbour(file, order);
      if (nb && ix < nb.grid.length) {
        bottomX = (nb.grid[ix] / nb.dur) * nb.fullW - nb.scroll + nb.dx;
      }
    }
    ctx.beginPath();
    ctx.lineWidth = 2;
    ctx.moveTo(topX, 0);
    ctx.lineTo(alignedX, c.height / 6);
    ctx.lineTo(alignedX, 5 * (c.height / 6));
    ctx.lineTo(bottomX, c.height);
    if (file === filename) {
      ctx.strokeStyle = `rgba(${_piC.r},${_piC.g},${_piC.b},0.7)`;
    } else {
      // Tinted by the slant: red leaning left, blue leaning right.
      const diffMapped = Math.floor((255 * (bottomX - alignedX)) / 100);
      ctx.strokeStyle =
        diffMapped < 0
          ? `rgb(${-1 * diffMapped} 100 100)`
          : `rgb(100 100 ${diffMapped})`;
    }
    ctx.stroke();
  });
}

/** Shorter than this (seconds) and a head or tail is rounding, not a gap. */
const NO_COUNTERPART_MIN_SEC = 0.05;

/** The no-counterpart band's diagonal hatch, cached per colour. */
let _ncHatch = null;

function _noCounterpartPattern(ctx, color) {
  if (_ncHatch && _ncHatch.color === color) return _ncHatch.pattern;
  const c = document.createElement("canvas");
  c.width = 8;
  c.height = 8;
  const g = c.getContext("2d");
  g.strokeStyle = color;
  g.lineWidth = 1.5;
  g.beginPath();
  g.moveTo(-1, 9);
  g.lineTo(9, -1);
  g.moveTo(-1, 1);
  g.lineTo(1, -1);
  g.moveTo(7, 9);
  g.lineTo(9, 7);
  g.stroke();
  _ncHatch = { color, pattern: ctx.createPattern(c, "repeat") };
  return _ncHatch.pattern;
}

/**
 * Hatch the head and tail this recording has no counterpart for.
 *
 * A trimmed head is otherwise indistinguishable from a mis-alignment: the
 * waveform simply starts before the shared timeline does. Returns the number
 * of bands painted (0, 1, or 2) — also the test surface.
 */
function drawNoCounterpartBands(ctx, filename, dur, fullW, scrollLeft, viewW, h) {
  const span = alignedSpans[filename];
  if (!span || !(dur > 0)) return 0;
  const ranges = [];
  if (span.from > NO_COUNTERPART_MIN_SEC) {
    ranges.push([0, Math.min(span.from, dur)]);
  }
  if (dur - span.to > NO_COUNTERPART_MIN_SEC) {
    ranges.push([Math.max(0, span.to), dur]);
  }
  if (!ranges.length) return 0;
  const muted =
    getComputedStyle(document.documentElement)
      .getPropertyValue("--color-text-muted")
      .trim() || "#94a3b8";
  let painted = 0;
  ctx.save();
  for (const [t0, t1] of ranges) {
    const x0 = Math.max(0, (t0 / dur) * fullW - scrollLeft);
    const x1 = Math.min(viewW, (t1 / dur) * fullW - scrollLeft);
    if (x1 <= x0) continue;
    ctx.globalAlpha = 0.16;
    ctx.fillStyle = muted;
    ctx.fillRect(x0, 0, x1 - x0, h);
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = _noCounterpartPattern(ctx, muted);
    ctx.fillRect(x0, 0, x1 - x0, h);
    painted++;
  }
  ctx.restore();
  return painted;
}

// ---------------------------------------------------------------------------
// "Visualise alignments", To next (2026-10-21; "To reference" is the older
// drawing): each line is vertical through its waveform and slants, in the
// bottom sixth, to the same grid index in the next VISIBLE waveform on screen,
// across group headings; the lowest visible waveform's lines are vertical
// throughout. A waveform's lines so depend on its lower neighbour's geometry:
// a redraw of one schedules its upper neighbour's when what it slants to has
// changed, and a change in which waveforms show, or their order, redraws all.
// ---------------------------------------------------------------------------

/** The visualise-alignments style: "next" or "reference". */
function _visalignMode() {
  return document.querySelector('input[name="visalign-mode"]:checked')?.value || "next";
}

/** Filenames of the waveform rows on screen, top to bottom — rows hidden
 *  themselves or by a collapsed group are left out. */
function _visibleRowOrder() {
  const root = document.getElementById("waveforms");
  if (!root) return [];
  return [...root.querySelectorAll(".waveform[data-ix]")]
    .filter((el) => el.getClientRects().length > 0)
    .map((el) => el.dataset.ix);
}

/** What `filename`'s lines slant to: the next visible waveform's grid and
 *  geometry, its x offset relative to this one's canvas (`dx`), and a
 *  signature of it all; null when there is none, or it has no renderer yet
 *  (its lines are then drawn vertical, and redrawn once it has one). */
function _lowerNeighbour(filename, order = _visibleRowOrder()) {
  const k = order.indexOf(filename);
  const next = k >= 0 ? order[k + 1] : undefined;
  const nv = next ? waveformViews[next] : null;
  const ws = next ? wavesurfers[next] : null;
  const grid = next ? alignmentGrids[next] : null;
  if (!nv?.container || !ws || !grid?.length) return null;
  const dur = ws.getDuration();
  if (!(dur > 0)) return null;
  const own = waveformViews[filename]?.container;
  const dx = own
    ? nv.container.getBoundingClientRect().left - own.getBoundingClientRect().left
    : 0;
  const fullW = getZoomedWidth(next);
  const scroll = ws.getScroll();
  return {
    next,
    grid,
    dur,
    fullW,
    scroll,
    dx,
    sig: `${next}|${grid.length}|${dur}|${fullW}|${scroll}|${dx}`,
  };
}

/** Upper neighbours waiting for a redraw, flushed once per frame. */
const _neighbourQueue = new Set();
let _neighbourRaf = 0;

function _queueNeighbourRedraw(filename) {
  _neighbourQueue.add(filename);
  if (_neighbourRaf) return;
  _neighbourRaf = requestAnimationFrame(() => {
    _neighbourRaf = 0;
    const order = _visibleRowOrder();
    const due = [..._neighbourQueue];
    _neighbourQueue.clear();
    for (const fn of due) {
      // Already drawn against the neighbour as it stands (a redraw-all in the
      // same frame): nothing to do.
      const nb = _lowerNeighbour(fn, order);
      if ((nb?.sig ?? "") === (waveformViews[fn]?.visalignSig ?? "")) continue;
      drawAlignmentGrid(fn, { fromNeighbour: true });
    }
  });
}

/** Watch the waveform list for a change in which rows show, or their order
 *  (hiding, a collapsed group, regrouping), and redraw every grid then. */
let _orderObserver = null;
let _orderSig = "";
/** The waveform the position indicators were last drawn relative to. */
let _lastIndicatorFile = null;

function _watchRowOrder() {
  if (_orderObserver) return;
  const root = document.getElementById("waveforms");
  if (!root) return;
  _orderSig = _visibleRowOrder().join("\n");
  _orderObserver = new MutationObserver((mutations) => {
    // Our own overlay resizing (every draw) is not a layout change.
    if (mutations.every((m) => m.target.closest?.(".wf-overlays"))) return;
    const sig = _visibleRowOrder().join("\n");
    if (sig === _orderSig) return;
    _orderSig = sig;
    if (_visalignMode() !== "next") return;
    if (document.getElementById("visalign")?.checked) {
      for (const fn of Object.keys(waveformViews)) _queueNeighbourRedraw(fn);
    }
    if (document.getElementById("visrelalign")?.checked && _lastIndicatorFile) {
      updatePositionIndicator(_lastIndicatorFile);
    }
  });
  _orderObserver.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["style", "class", "hidden"],
  });
}

/** The grid stride shared by the visible waveforms: lines no closer than
 *  4 px in the narrowest of them. */
function _sharedStride(order) {
  let stride = 1;
  for (const fn of order) {
    const n = alignmentGrids[fn]?.length;
    const w = wavesurfers[fn] ? getZoomedWidth(fn) : 0;
    if (n > 0 && w > 0) stride = Math.max(stride, Math.round(4 / (w / n)));
  }
  return stride;
}

/** The grid indices, in [lo, hi], whose time in `grid` maps into the visible
 *  x range [x0, x1] at (dur, fullW, scroll). */
function _gridIndexSpan(grid, dur, fullW, scroll, x0, x1) {
  const tLo = ((scroll + x0) / fullW) * dur;
  const tHi = ((scroll + x1) / fullW) * dur;
  const lower = (t) => {
    let lo = 0;
    let hi = grid.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (grid[mid] < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  return [Math.max(0, lower(tLo) - 1), Math.min(grid.length - 1, lower(tHi))];
}

/**
 * Draw (or redraw) one waveform's alignment grid, time ticks, and tempo curve.
 * At zoom, draws only the visible viewport portion, offset by scroll.
 * `fromNeighbour`: this redraw was queued by the waveform below, so it does
 * not queue the one above in turn.
 */
export function drawAlignmentGrid(filename, { fromNeighbour = false } = {}) {
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

  // Audio with no counterpart in the reference — the head and tail the
  // wizard's open-ended alignment left out (applause, announcements, tuning).
  // Painted first so the grid lines and time ticks still read on top.
  view.noCounterpartBands = drawNoCounterpartBands(
    ctx, filename, dur, fullW, scrollLeft, viewW, h,
  );

  // Draw alignment grid lines first (so time ticks render on top)
  const visalignEl = document.getElementById("visalign");
  const visalignNext = !!visalignEl?.checked && _visalignMode() === "next";
  view.visalignSig = "";
  view.visalignNext = null; // test surface: the waveform the lines run on to
  if (visalignNext) {
    _watchRowOrder();
    const order = _visibleRowOrder();
    const nb = _lowerNeighbour(filename, order);
    view.visalignSig = nb?.sig ?? "";
    view.visalignNext = nb?.next ?? null;
    const grid = alignmentGrids[filename] || [];
    if (grid.length > 0 && dur > 0) {
      const margin = 10;
      // The indices whose line touches the view: its own x in range, or —
      // slanting — its x in the waveform below.
      let [lo, hi] = _gridIndexSpan(grid, dur, fullW, scrollLeft, -margin, viewW + margin);
      if (nb) {
        const [nlo, nhi] = _gridIndexSpan(
          nb.grid, nb.dur, nb.fullW, nb.scroll, -margin - nb.dx, viewW + margin - nb.dx,
        );
        lo = Math.min(lo, nlo);
        hi = Math.max(hi, Math.min(nhi, grid.length - 1));
      }
      // A deterministic stride (no flicker on scroll): selection by index,
      // never by distance — and ONE stride for every visible waveform, the
      // coarsest any of them needs, so each line runs on into a line drawn
      // below rather than into a gap of the next waveform's own thinning.
      const stride = _sharedStride(order);
      lo -= lo % stride;
      const _agC = parseCssColor(getComputedStyle(document.documentElement).getPropertyValue("--color-alignment").trim()) || { r: 140, g: 90, b: 90 };
      const _agRgb = `${_agC.r},${_agC.g},${_agC.b}`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.setLineDash([]);
      ctx.strokeStyle = `rgba(${_agRgb},0.55)`;
      for (let gridIx = lo; gridIx <= hi; gridIx += stride) {
        const x = (grid[gridIx] / dur) * fullW - scrollLeft;
        const xNext =
          nb && gridIx < nb.grid.length
            ? (nb.grid[gridIx] / nb.dur) * nb.fullW - nb.scroll + nb.dx
            : x;
        ctx.moveTo(x, 5 * (h / 6));
        ctx.lineTo(xNext, h);
      }
      ctx.stroke();
      // The vertical part, top included, in one style: only the slant to the
      // waveform below stands out.
      ctx.beginPath();
      ctx.strokeStyle = `rgba(${_agRgb},0.3)`;
      ctx.setLineDash([2, 1]);
      for (let gridIx = lo; gridIx <= hi; gridIx += stride) {
        const x = (grid[gridIx] / dur) * fullW - scrollLeft;
        if (x > viewW + margin || x < -margin) continue;
        ctx.moveTo(x, 0);
        ctx.lineTo(x, 5 * (h / 6));
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (!fromNeighbour) {
      const k = order.indexOf(filename);
      if (k > 0) _queueNeighbourRedraw(order[k - 1]);
    }
  } else if (visalignEl && visalignEl.checked) {
    // To reference: each line slants from its position on the reference
    // timeline (grid index × width) to the recording's own, and back.
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

  // Draw the shaded area and the curve line per RUN: a point whose breakAfter
  // is set ends one (an unscored-audio gap follows it), and nothing is drawn
  // across the break — neither fill nor stroke.
  const zeroY = mode === "relative" ? valToY(0) : yBot;
  const runs = [];
  for (let i = startIdx, r0 = startIdx; i <= endIdx; i++) {
    if (smoothed[i].breakAfter || i === endIdx) {
      runs.push([r0, i]);
      r0 = i + 1;
    }
  }
  for (const [a, b] of runs) {
    if (b < a) continue;
    ctx.beginPath();
    ctx.moveTo(pts[a].x, zeroY);
    for (let i = a; i <= b; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.lineTo(pts[b].x, zeroY);
    ctx.closePath();
    ctx.fillStyle =
      mode === "relative"
        ? `rgba(${_tcRgb},0.22)`
        : `rgba(${_tcRgb},0.25)`;
    ctx.fill();
    if (b === a) continue;
    ctx.beginPath();
    ctx.moveTo(pts[a].x, pts[a].y);
    for (let i = a + 1; i <= b; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.strokeStyle = `rgba(${_tcRgb},0.9)`;
    ctx.lineWidth = 1.75;
    ctx.stroke();
  }

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