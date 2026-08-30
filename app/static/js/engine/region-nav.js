// engine/region-nav.js
//
// Off-screen region navigation: the left/right arrow affordances that appear on
// a zoomed waveform when annotated regions have scrolled out of view, and the
// scroll-into-view jump behind them.
//
// Holds no state of its own — the arrows live in each viewport's overlay wrapper
// and everything else is read from zoom-scroll (zoom level, geometry, scroll
// sync) or from the DataSession maps re-exported by listen.js.
//
// Extracted from listen.js (Phase 1 refactor, increment 16). Behaviour-preserving.
//
// Note the deliberate cycle with zoom-scroll.js: it calls
// updateAllRegionNavArrows after a zoom change, while this module reads its
// geometry helpers. Eval-safe because every imported binding is only touched
// inside a function body, never at module top level.

import { wavesurfers } from "../listen.js";
import { waveformViews, drawAlignmentGrid } from "./waveform-view.js";
import {
  currentZoomLevel,
  getZoomedWidth,
  getScrollContainer,
  syncOverlayScroll,
  syncAllWaveformScrolls,
} from "./zoom-scroll.js";

const REGION_NAV_BUFFER_FRAC = 0.05; // 5% of viewport width

/** Collect all currently-visible region times on a waveform. */
function _collectAllRegionTimes(filename) {
  const plugin = waveformViews[filename]?.regions;
  if (!plugin) return [];
  return plugin
    .getRegions()
    .map((r) => ({ start: r.start, end: r.end }));
}

/** Create left/right region-nav arrow buttons inside the waveform's overlay wrapper. */
export function createRegionNavArrows(filename) {
  const ow = waveformViews[filename]?.ow;
  if (!ow) return;
  if (ow.wrapper.querySelector(".wf-region-nav-left")) return; // already created

  const mkArrow = (side) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.tabIndex = -1; // never part of tab order — arrows are pure pointer affordances
    btn.className = `wf-region-nav wf-region-nav-${side}`;
    btn.style.display = "none";
    btn.setAttribute(
      "aria-label",
      side === "left" ? "Jump to previous off-screen region" : "Jump to next off-screen region",
    );
    const arrow = document.createElement("span");
    arrow.className = "wf-region-nav-arrow";
    arrow.textContent = side === "left" ? "◀" : "▶";
    const badge = document.createElement("span");
    badge.className = "wf-region-nav-badge";
    badge.textContent = "";
    btn.appendChild(arrow);
    btn.appendChild(badge);
    // Don't let the button steal focus from the page — otherwise a subsequent
    // SPACE / ENTER keypress re-activates the arrow and snaps back to the region.
    btn.addEventListener("mousedown", (e) => e.preventDefault());
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      _jumpToOffscreenRegion(filename, side);
      btn.blur();
    });
    // Forward wheel events to the waveform scroll container so the user can
    // scroll past the arrow without it swallowing the gesture.
    btn.addEventListener(
      "wheel",
      (e) => {
        const sc = getScrollContainer(filename);
        if (!sc) return;
        e.preventDefault();
        sc.scrollLeft += e.deltaX || e.deltaY || 0;
      },
      { passive: false },
    );
    return btn;
  };

  ow.wrapper.appendChild(mkArrow("left"));
  ow.wrapper.appendChild(mkArrow("right"));
}

/** Scroll the waveform so that the nearest off-screen region on the given side is fully in view. */
function _jumpToOffscreenRegion(filename, side) {
  const ws = wavesurfers[filename];
  if (!ws || currentZoomLevel <= 1) return;
  const duration = ws.getDuration();
  if (!duration) return;
  const fullW = getZoomedWidth(filename);
  const scrollContainer = getScrollContainer(filename);
  if (!scrollContainer || !fullW) return;
  const viewW = scrollContainer.clientWidth;
  const scrollLeft = ws.getScroll();
  const bufferPx = viewW * REGION_NAV_BUFFER_FRAC;
  const regions = _collectAllRegionTimes(filename);

  // Candidate regions: entirely off-screen on the requested side.
  const candidates = regions
    .map((r) => ({
      startPx: (r.start / duration) * fullW,
      endPx: (r.end / duration) * fullW,
    }))
    .filter((r) =>
      side === "right" ? r.startPx >= scrollLeft + viewW : r.endPx <= scrollLeft,
    );
  if (candidates.length === 0) return;

  // Pick the nearest one (min distance for right, max for left).
  const target =
    side === "right"
      ? candidates.reduce((a, b) => (a.startPx < b.startPx ? a : b))
      : candidates.reduce((a, b) => (a.endPx > b.endPx ? a : b));

  // Target scroll: place region such that it is fully in view with buffer.
  let newScroll;
  if (side === "right") {
    newScroll = target.startPx - bufferPx;
  } else {
    newScroll = target.endPx + bufferPx - viewW;
  }
  newScroll = Math.max(0, Math.min(newScroll, fullW - viewW));
  ws.setScroll(newScroll);
  syncOverlayScroll(filename);
  drawAlignmentGrid(filename);
  syncAllWaveformScrolls(filename);
  updateAllRegionNavArrows();
}

/** Update arrow visibility + badge count on a single waveform. */
function _updateRegionNavArrows(filename) {
  const ow = waveformViews[filename]?.ow;
  if (!ow) return;
  const left = ow.wrapper.querySelector(".wf-region-nav-left");
  const right = ow.wrapper.querySelector(".wf-region-nav-right");
  if (!left || !right) return;

  const ws = wavesurfers[filename];
  if (!ws || currentZoomLevel <= 1) {
    left.style.display = "none";
    right.style.display = "none";
    return;
  }
  const duration = ws.getDuration();
  const fullW = getZoomedWidth(filename);
  const scrollContainer = getScrollContainer(filename);
  if (!duration || !fullW || !scrollContainer) {
    left.style.display = "none";
    right.style.display = "none";
    return;
  }
  const viewW = scrollContainer.clientWidth;
  const scrollLeft = ws.getScroll();
  const viewRight = scrollLeft + viewW;

  let leftCount = 0;
  let rightCount = 0;
  _collectAllRegionTimes(filename).forEach((r) => {
    const startPx = (r.start / duration) * fullW;
    const endPx = (r.end / duration) * fullW;
    if (endPx <= scrollLeft) leftCount++;
    else if (startPx >= viewRight) rightCount++;
  });

  left.style.display = leftCount > 0 ? "" : "none";
  right.style.display = rightCount > 0 ? "" : "none";
  left.querySelector(".wf-region-nav-badge").textContent =
    leftCount > 1 ? String(leftCount) : "";
  right.querySelector(".wf-region-nav-badge").textContent =
    rightCount > 1 ? String(rightCount) : "";
}

/** Update region-nav arrows on all loaded waveforms. */
export function updateAllRegionNavArrows() {
  Object.keys(waveformViews).forEach((fn) => _updateRegionNavArrows(fn));
}
