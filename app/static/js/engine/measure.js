// engine/measure.js
//
// Time measurement: hold Shift to label the durations between consecutive
// markers, Shift+drag across a waveform to measure an arbitrary span. Both
// render into each viewport's overlay inner div, and both project through the
// alignment grids, so one gesture measures the same musical span on every
// loaded recording.
//
// Unlike markers or region-nav this module owns real state — the visuals it
// created, whether Shift is down, the in-progress drag — because none of it is
// session data. It owns its event wiring too: initMeasureInteractions is called
// once the DOM is ready.
//
// The Shift key is contended: align-correction mode uses it for the influence
// zone. Rather than import that flag, the owner passes an `isSuppressed`
// predicate, so this module stays ignorant of whatever else may claim the key.
//
// Extracted from listen.js (Phase 1 refactor, increment 17). Behaviour-preserving.

import {
  markers,
  wavesurfers,
  loaded,
  getCorrespondingTime,
  getClosestAlignmentIx,
} from "../listen.js";
import { getZoomedWidth } from "./zoom-scroll.js";
import { waveformViews } from "./waveform-view.js";

let _measureShiftHeld = false;
let _measureDragState = null; // { filename, startAlignIx, endAlignIx }
const _measureElements = []; // DOM elements to clean up on Shift-up

/** Format a duration in seconds for measurement labels. */
function _formatDuration(seconds) {
  const abs = Math.abs(seconds);
  if (abs < 60) return abs.toFixed(2) + "s";
  const m = Math.floor(abs / 60);
  const s = (abs % 60).toFixed(1);
  return m + ":" + String(s).padStart(4, "0");
}

/** Show duration labels between consecutive markers on all waveforms. */
export function showMarkerDurations() {
  if (markers.length < 2) return;
  // Sort markers by alignment index to get consecutive pairs
  const sorted = markers
    .map((alignIx, i) => ({ alignIx, i }))
    .sort((a, b) => a.alignIx - b.alignIx);

  Object.keys(wavesurfers).forEach((filename) => {
    if (!loaded.has(filename)) return;
    const ws = wavesurfers[filename];
    const ow = waveformViews[filename]?.ow;
    if (!ws || !ow) return;
    const dur = ws.getDuration();
    const fullW = getZoomedWidth(filename);

    for (let i = 0; i < sorted.length - 1; i++) {
      const t1 = getCorrespondingTime(filename, sorted[i].alignIx);
      const t2 = getCorrespondingTime(filename, sorted[i + 1].alignIx);
      const x1 = (t1 / dur) * fullW;
      const x2 = (t2 / dur) * fullW;
      const midX = (x1 + x2) / 2;
      const spanW = Math.abs(x2 - x1);

      // Duration label
      const label = document.createElement("div");
      label.className = "measure-label";
      label.textContent = _formatDuration(Math.abs(t2 - t1));
      label.style.left = midX + "px";
      ow.inner.appendChild(label);
      _measureElements.push(label);

      // Subtle span highlight
      const span = document.createElement("div");
      span.className = "measure-span";
      span.style.left = Math.min(x1, x2) + "px";
      span.style.width = spanW + "px";
      ow.inner.appendChild(span);
      _measureElements.push(span);
    }
  });
}

/**
 * Draw a measurement span from startAlignIx to endAlignIx across all waveforms.
 */
function _drawMeasureSpan(startAlignIx, endAlignIx) {
  // Clear previous span elements (keep marker duration labels)
  _measureElements.forEach((el) => {
    if (
      el.classList.contains("measure-drag-span") ||
      el.classList.contains("measure-drag-label")
    ) {
      el.remove();
    }
  });
  // Filter out removed elements
  for (let i = _measureElements.length - 1; i >= 0; i--) {
    if (!_measureElements[i].isConnected) _measureElements.splice(i, 1);
  }

  const ix1 = Math.min(startAlignIx, endAlignIx);
  const ix2 = Math.max(startAlignIx, endAlignIx);

  Object.keys(wavesurfers).forEach((filename) => {
    if (!loaded.has(filename)) return;
    const ws = wavesurfers[filename];
    const ow = waveformViews[filename]?.ow;
    if (!ws || !ow) return;
    const dur = ws.getDuration();
    const fullW = getZoomedWidth(filename);
    const t1 = getCorrespondingTime(filename, ix1);
    const t2 = getCorrespondingTime(filename, ix2);
    const x1 = (t1 / dur) * fullW;
    const x2 = (t2 / dur) * fullW;
    const spanW = Math.abs(x2 - x1);

    // Highlight span
    const span = document.createElement("div");
    span.className = "measure-drag-span";
    span.style.left = Math.min(x1, x2) + "px";
    span.style.width = spanW + "px";
    ow.inner.appendChild(span);
    _measureElements.push(span);

    // Duration label
    const label = document.createElement("div");
    label.className = "measure-drag-label";
    label.textContent = _formatDuration(Math.abs(t2 - t1));
    label.style.left = (x1 + x2) / 2 + "px";
    ow.inner.appendChild(label);
    _measureElements.push(label);
  });
}

/** Remove all measurement visuals. */
export function clearMeasureVisuals() {
  _measureElements.forEach((el) => el.remove());
  _measureElements.length = 0;
  _measureDragState = null;
}

/**
 * Wire the Shift-hold and Shift+drag gestures. Call once, after the DOM exists.
 *
 * @param {object} opts
 * @param {() => boolean} [opts.isSuppressed] true while another mode owns the
 *   Shift key (align correction), so measurement stays out of its way.
 */
export function initMeasureInteractions({ isSuppressed = () => false } = {}) {
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Shift" || e.repeat) return;
    if (isSuppressed()) return; // another mode (align correction) owns Shift
    _measureShiftHeld = true;
    showMarkerDurations();
  });

  document.addEventListener("keyup", (e) => {
    if (e.key !== "Shift") return;
    if (!_measureShiftHeld) return;
    _measureShiftHeld = false;
    clearMeasureVisuals();
  });

  // Shift+drag on waveforms for arbitrary measurement spans
  const waveformsRoot = document.getElementById("waveforms");

  /** Given a mouse event over #waveforms, find the waveform filename and time. */
  function _measureHitTest(e) {
    // Walk up from target to find the .waveform container
    let wfEl = e.target.closest(".waveform[data-ix]");
    if (!wfEl) return null;
    const filename = wfEl.dataset.ix;
    const ws = wavesurfers[filename];
    if (!ws || !loaded.has(filename)) return null;
    const dur = ws.getDuration();
    const fullW = getZoomedWidth(filename);
    if (fullW <= 0 || dur <= 0) return null;
    // Get x relative to the overlay inner (accounts for scroll)
    const ow = waveformViews[filename]?.ow;
    if (!ow) return null;
    const rect = ow.inner.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const time = (x / fullW) * dur;
    const alignIx = getClosestAlignmentIx(time, filename);
    return { filename, time, alignIx };
  }

  waveformsRoot.addEventListener("mousedown", (e) => {
    if (!_measureShiftHeld || e.button !== 0) return;
    // Suppress time measurement when the mousedown lands on a WaveSurfer
    // region or its resize handles — that pointerdown begins a region drag
    // (Shift modifies the drag's local-vs-global semantics), so we must not
    // also start a measurement span. Use composedPath to reach inside any
    // shadow root the wavesurfer wrapper uses.
    const path = typeof e.composedPath === "function" ? e.composedPath() : [];
    for (const el of path) {
      if (!el || !el.getAttribute) continue;
      const part = el.getAttribute("part") || "";
      if (part.startsWith("region")) return;
    }
    const hit = _measureHitTest(e);
    if (!hit) return;
    e.preventDefault();
    _measureDragState = {
      filename: hit.filename,
      startAlignIx: hit.alignIx,
      endAlignIx: hit.alignIx,
    };
  });

  document.addEventListener("mousemove", (e) => {
    if (!_measureDragState) return;
    const hit = _measureHitTest(e);
    if (!hit) return;
    _measureDragState.endAlignIx = hit.alignIx;
    _drawMeasureSpan(
      _measureDragState.startAlignIx,
      _measureDragState.endAlignIx,
    );
  });

  // mouseup does NOT clear — visuals persist until Shift is released
  document.addEventListener("mouseup", () => {
    if (!_measureDragState) return;
    // Finalize the drag state but keep visuals
    _measureDragState = null;
  });
}
