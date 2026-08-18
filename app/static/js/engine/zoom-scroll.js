// engine/zoom-scroll.js
//
// Zoom & scroll subsystem, extracted from listen.js (Phase 1 engine
// modularisation, roadmap item 13). Behaviour-preserving relocation — no logic
// changed. This is per-viewport ("WaveformView") state in the target tiered
// architecture; for now it is a module-level singleton, exactly as it was in
// listen.js, and Listen Here (one viewport) is the reference app.
//
// Coupling notes (see docs/museum-exhibit-architecture.md §4):
//  - Borrows the shared waveform registry + a few helpers from listen.js. These
//    are the seed of the future DataSession; they are imported here (a circular
//    but eval-safe import — every borrowed binding is used only inside function
//    bodies, never at module top level).
//  - `currentZoomLevel` / `scrollMode` / `sharedTimeAxis` are exported as live
//    bindings so listen.js keeps reading the current value; the few writes that
//    still live in listen.js's DOMContentLoaded wiring go through the setters
//    below (ESM importers cannot assign to a live binding directly).
//  - `_scrollSyncLock` deliberately stays in listen.js: it coordinates the scroll
//    event handlers registered in prepareWaveform/swapCurrentAudio and is never
//    touched here.

import {
  wavesurfers,
  loaded,
  wfBgCache,
  refreshWfBg,
  gridRedrawers,
  getClosestAlignmentIx,
  getCorrespondingTime,
  updateAllRegionNavArrows,
} from "../listen.js";

// ---------------------------------------------------------------------------
// Zoom state (owned here)
// ---------------------------------------------------------------------------
export const ZOOM_LEVELS = [1, 2, 5, 10, 20, 50];
export let currentZoomLevel = 1; // multiplier (1 = no zoom)
export let scrollMode = "page"; // "follow" | "page" | "manual"
export let sharedTimeAxis = false; // when true, all waveforms use same px/sec
export const overlayWrappers = {}; // filename → { wrapper, inner }

// Setters for the writes that still originate in listen.js's UI wiring
// (live-binding imports are read-only for the importer).
export function setScrollMode(mode) {
  scrollMode = mode;
}
export function setSharedTimeAxis(on) {
  sharedTimeAxis = on;
}
/** Set the zoom level without side effects (used by form-restore). */
export function setCurrentZoomLevel(level) {
  currentZoomLevel = level;
}

/** Get the shadow-DOM scroll container for a WaveSurfer instance. */
export function getScrollContainer(filename) {
  const ws = wavesurfers[filename];
  if (!ws) return null;
  // ws.getWrapper() returns the .wrapper div; its parent is the .scroll div
  return ws.getWrapper().parentElement;
}

/** Get the full rendered width of the waveform (accounts for zoom). */
export function getZoomedWidth(filename) {
  const ws = wavesurfers[filename];
  if (!ws) return 0;
  if (currentZoomLevel <= 1) {
    const wfEl = document.querySelector(`.waveform[data-ix='${filename}']`);
    return wfEl ? wfEl.clientWidth : 0;
  }
  const wrapper = ws.getWrapper();
  return wrapper ? wrapper.clientWidth : 0;
}

/** Create the overlay wrapper structure for a waveform. */
export function createOverlayWrapper(wfEl, height) {
  const wrapper = document.createElement("div");
  wrapper.className = "wf-overlays";
  wrapper.style.height = height + "px";

  const inner = document.createElement("div");
  inner.className = "wf-overlays-inner";
  wrapper.appendChild(inner);

  wfEl.appendChild(wrapper);
  return { wrapper, inner };
}

/** Ensure a sticky filename label exists on the waveform overlay (not in the scrolling inner). */
export function ensureWfLabel(filename) {
  const ow = overlayWrappers[filename];
  const wfEl = document.querySelector(`.waveform[data-ix='${filename}']`);
  const parent = ow ? ow.wrapper : wfEl;
  if (!parent) return;
  // Remove any existing label
  const existing = parent.querySelector(".wf-label");
  if (existing) return; // already exists
  const lbl = document.createElement("div");
  lbl.className = "wf-label";
  lbl.textContent = filename;
  parent.appendChild(lbl);
  // Match background to the waveform's effective background colour
  lbl.style.backgroundColor = wfBgCache[filename] || refreshWfBg(filename);
}

/** Sync overlay scroll transform to match WaveSurfer's scroll position. */
export function syncOverlayScroll(filename) {
  const ow = overlayWrappers[filename];
  if (!ow) return;
  const scrollLeft = wavesurfers[filename]
    ? wavesurfers[filename].getScroll()
    : 0;
  ow.inner.style.transform = `translateX(${-scrollLeft}px)`;
}

/** Configure WaveSurfer autoScroll/autoCenter for a waveform based on scroll mode. */
export function applyScrollMode(filename) {
  const ws = wavesurfers[filename];
  if (!ws) return;
  if (currentZoomLevel <= 1) {
    ws.options.autoScroll = false;
    ws.options.autoCenter = false;
    return;
  }
  switch (scrollMode) {
    case "follow":
      ws.options.autoScroll = true;
      ws.options.autoCenter = true;
      break;
    case "page":
    case "manual":
      ws.options.autoScroll = false;
      ws.options.autoCenter = false;
      break;
  }
}

/** Apply zoom level to all loaded waveforms. */
export function applyZoom(level) {
  currentZoomLevel = level;
  const label = document.getElementById("zoom-label");
  if (label) label.textContent = level + "x";
  const scrollControls = document.getElementById("scroll-mode-controls");
  if (scrollControls) scrollControls.style.display = level > 1 ? "" : "none";

  // For shared time axis, compute a common pxPerSec from the longest duration
  let sharedPxPerSec = null;
  let maxDuration = 0;
  if (sharedTimeAxis) {
    Object.keys(wavesurfers).forEach((fn) => {
      if (!loaded.has(fn)) return;
      const d = wavesurfers[fn].getDuration();
      if (d > maxDuration) maxDuration = d;
    });
  }

  // When toggling shared time axis, first reset all widths synchronously so
  // layout settles before we call ws.zoom(). This avoids WaveSurfer's
  // ResizeObserver racing with our zoom calls.
  if (sharedTimeAxis && maxDuration > 0 && level <= 1) {
    Object.keys(wavesurfers).forEach((filename) => {
      if (!loaded.has(filename)) return;
      const wfEl = document.querySelector(`.waveform[data-ix='${filename}']`);
      if (!wfEl) return;
      const fraction = wavesurfers[filename].getDuration() / maxDuration;
      wfEl.style.width = Math.max(fraction * 100, 5) + "%"; // min 5% to avoid collapse
    });
  } else if (!sharedTimeAxis) {
    Object.keys(wavesurfers).forEach((filename) => {
      const wfEl = document.querySelector(`.waveform[data-ix='${filename}']`);
      if (wfEl) wfEl.style.width = "";
    });
  }

  // Compute shared pxPerSec once from a reference container (after widths settle)
  if (sharedTimeAxis && maxDuration > 0 && level > 1) {
    // Reset widths first, then compute from parent container
    Object.keys(wavesurfers).forEach((filename) => {
      const wfEl = document.querySelector(`.waveform[data-ix='${filename}']`);
      if (wfEl) wfEl.style.width = "";
    });
    const refEl = document.querySelector("#waveforms .waveform");
    const refWidth = refEl ? refEl.clientWidth : 800;
    sharedPxPerSec = (level * refWidth) / maxDuration;
  }

  Object.keys(wavesurfers).forEach((filename) => {
    if (!loaded.has(filename)) return;
    const ws = wavesurfers[filename];
    const wfEl = document.querySelector(`.waveform[data-ix='${filename}']`);
    if (!ws || !wfEl) return;

    try {
      const duration = ws.getDuration();
      if (sharedTimeAxis && maxDuration > 0) {
        if (level <= 1) {
          // Explicit pxPerSec instead of ws.zoom(0) — the latter can be a
          // no-op in v7 when fillParent is already active, leaving the wrapper
          // stuck at its previously zoomed width so the waveform vanishes.
          ws.zoom(wfEl.clientWidth / duration);
        } else {
          ws.zoom(sharedPxPerSec);
        }
      } else {
        const containerWidth = wfEl.clientWidth;
        if (level <= 1) {
          ws.zoom(containerWidth / duration);
        } else {
          ws.zoom((level * containerWidth) / duration);
        }
      }
    } catch (e) {
      console.warn("Zoom error for", filename, e);
    }
    applyScrollMode(filename);
    // redrawcomplete will fire and handle overlay resize + marker redraw
  });
  updateAllRegionNavArrows();
}

/** Page-scroll the active waveform if playhead is about to leave visible area. */
export function pageScrollIfNeeded(filename) {
  const ws = wavesurfers[filename];
  const scrollContainer = getScrollContainer(filename);
  if (!ws || !scrollContainer) return;
  const currentTime = ws.getCurrentTime();
  const duration = ws.getDuration();
  const visibleWidth = scrollContainer.clientWidth;
  const totalWidth = scrollContainer.scrollWidth;
  const currentScroll = scrollContainer.scrollLeft;
  const playheadPx = (currentTime / duration) * totalWidth;
  const visibleEnd = currentScroll + visibleWidth;
  const margin = visibleWidth * 0.05;
  if (playheadPx > visibleEnd - margin || playheadPx < currentScroll) {
    const newScroll = Math.max(0, playheadPx - visibleWidth * 0.1);
    ws.setScroll(newScroll);
    syncOverlayScroll(filename);
  }
}

/** Sync all waveform scroll positions to match the source waveform's center time. */
export function syncAllWaveformScrolls(sourceFilename) {
  if (currentZoomLevel <= 1) return;
  const sourceWs = wavesurfers[sourceFilename];
  if (!sourceWs) return;
  const sourceWrapper = sourceWs.getWrapper();
  if (!sourceWrapper) return;
  const sourceScrollEl = sourceWrapper.parentElement;
  const sourceVisibleWidth = sourceScrollEl.clientWidth;
  const sourceTotalWidth = sourceWrapper.clientWidth;
  const sourceScroll = sourceWs.getScroll();
  const sourceDuration = sourceWs.getDuration();

  if (sharedTimeAxis) {
    // Shared time axis: all waveforms share the same pxPerSec, so same
    // scrollLeft aligns to the same absolute time.
    Object.keys(wavesurfers).forEach((targetFilename) => {
      if (targetFilename === sourceFilename) return;
      if (!loaded.has(targetFilename)) return;
      const targetWs = wavesurfers[targetFilename];
      if (!targetWs) return;
      targetWs.setScroll(sourceScroll);
      syncOverlayScroll(targetFilename);
      if (gridRedrawers[targetFilename]) gridRedrawers[targetFilename]();
    });
    return;
  }

  // Alignment-based sync: map through alignment grid
  // Time at center of source viewport
  const centerFraction =
    (sourceScroll + sourceVisibleWidth / 2) / sourceTotalWidth;
  const centerTime = centerFraction * sourceDuration;
  const sourceAlignIx = getClosestAlignmentIx(centerTime, sourceFilename);

  Object.keys(wavesurfers).forEach((targetFilename) => {
    if (targetFilename === sourceFilename) return;
    if (!loaded.has(targetFilename)) return;
    const targetWs = wavesurfers[targetFilename];
    if (!targetWs) return;
    const targetWrapper = targetWs.getWrapper();
    if (!targetWrapper) return;
    const targetTime = getCorrespondingTime(targetFilename, sourceAlignIx);
    const targetDuration = targetWs.getDuration();
    const targetTotalWidth = targetWrapper.clientWidth;
    const targetScrollEl = targetWrapper.parentElement;
    const targetVisibleWidth = targetScrollEl.clientWidth;
    const targetFraction = targetTime / targetDuration;
    const targetCenterPx = targetFraction * targetTotalWidth;
    const targetScroll = Math.max(0, targetCenterPx - targetVisibleWidth / 2);
    targetWs.setScroll(targetScroll);
    syncOverlayScroll(targetFilename);
    // Redraw viewport-based canvases for this target
    if (gridRedrawers[targetFilename]) gridRedrawers[targetFilename]();
  });
}
