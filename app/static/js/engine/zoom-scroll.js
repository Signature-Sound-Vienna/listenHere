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
//  - The overlay wrappers used to be owned here as `overlayWrappers`. They are
//    now read from waveform-view.js's `waveformViews[filename].ow` (increment
//    19): the same wrapper object was being stored in both places and kept in
//    sync by hand across two teardown paths. Same eval-safe circular-import
//    rule applies — `waveformViews` is only touched inside function bodies.
//  - `currentZoomLevel` / `scrollMode` / `sharedTimeAxis` are exported as live
//    bindings so listen.js keeps reading the current value; the few writes that
//    still live in listen.js's DOMContentLoaded wiring go through the setters
//    below (ESM importers cannot assign to a live binding directly).
//  - `scrollSyncLock` is owned here (increment 23), because it exists to guard
//    re-entry into this module's own syncAllWaveformScrolls. Nothing in here
//    reads it, though: the guard sits at the CALL SITE, so the lock is the one
//    piece of this module's state that this module never touches. That is a
//    known smell, and it is the price of not changing behaviour — see the note
//    on the declaration below for why the guard cannot simply move inside
//    syncAllWaveformScrolls.

import {
  wavesurfers,
  loaded,
  wfBgCache,
  refreshWfBg,
  getClosestAlignmentIx,
  getCorrespondingTime,
} from "../listen.js";
import { updateAllRegionNavArrows } from "./region-nav.js";
import { waveformViews, drawAlignmentGrid } from "./waveform-view.js";

// ---------------------------------------------------------------------------
// Zoom state (owned here)
// ---------------------------------------------------------------------------
export const ZOOM_LEVELS = [1, 2, 5, 10, 20, 50];
export let currentZoomLevel = 1; // multiplier (1 = no zoom)
export let scrollMode = "page"; // "follow" | "page" | "manual"
export let sharedTimeAxis = false; // when true, all waveforms use same px/sec

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

// ---------------------------------------------------------------------------
// Cross-waveform scroll-sync lock (owned here since increment 23)
// ---------------------------------------------------------------------------
// Prevents infinite recursion in cross-waveform scroll sync: syncAllWaveformScrolls
// sets scroll on every other waveform, each of which fires its own scroll handler,
// which would sync back.
//
// It lived in listen.js until increment 23 on the reasoning that engine modules
// only ever borrow from listen.js and never own state listen.js writes. That was
// simply wrong — currentZoomLevel, scrollMode, sharedTimeAxis and waveformViews
// are all engine-owned and written by listen.js through setters, exactly like
// this. Its home is here: it guards this module's function, and this module is
// already the declared per-viewport ("WaveformView") state in the target
// architecture, so this is the lock's final home rather than a way-station.
//
// WHY THE GUARD IS NOT JUST INTERNALISED into syncAllWaveformScrolls, which would
// make the exported reader unnecessary — two reasons, both measured:
//  1. Of its four callers, only ONE takes the lock (the per-waveform scroll
//     handler in waveform-events.js). The audioprocess sync in that same module,
//     the scroll-into-view sync in listen.js, and region-nav.js all sync WITHOUT
//     it. Locking inside the function would change behaviour at those three,
//     including on the playback path.
//  2. swapCurrentAudio and setCurrentAudioInactive hold the lock across a
//     seekTo(0) plus a scroll restore — suppressing sync during an operation that
//     is not a sync at all. That use can never live inside the sync function.
// So the lock stays externally holdable: a live-binding reader for the one
// checker, and a setter for the writers that are not in this module.
export let scrollSyncLock = false;

/** Writers outside this module (waveform-events.js's scroll and redrawcomplete
 *  handlers; listen.js's swapCurrentAudio and setCurrentAudioInactive) go through
 *  here — ESM importers cannot assign to a live binding. */
export function setScrollSyncLock(locked) {
  scrollSyncLock = locked;
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
  const ow = waveformViews[filename]?.ow;
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
  const ow = waveformViews[filename]?.ow;
  if (!ow) return;
  const scrollLeft = wavesurfers[filename]
    ? wavesurfers[filename].getScroll()
    : 0;
  ow.inner.style.transform = `translateX(${-scrollLeft}px)`;
}

/**
 * pxPerSec that makes a waveform fit its container exactly at zoom 1.
 *
 * Two durations are in play and they are not the same number. `ws.getDuration()`
 * reports `media.duration`, read from the MP3 container header, but WaveSurfer's
 * renderer sizes the wrapper from the DECODED buffer:
 * `Math.ceil(decodedData.duration * minPxPerSec)`, treating anything wider than
 * the container as scrollable. Fitting against the header duration therefore
 * overshoots whenever the decoded audio is even microseconds longer — measured
 * on the test fixtures, +9µs on audio-a and audio-b and +5µs on audio-short,
 * enough for the ceil to round up to `containerWidth + 1`. The row then
 * overflows by one pixel, becomes scrollable with a maxScroll of 1, and holds a
 * stale `scrollLeft` of 1 that the redrawcomplete clamp cannot heal because 1 IS
 * the maximum. Files whose decoded duration matches or undershoots the header
 * (the synthesised score, audio-c) were unaffected — hence "some but not all".
 *
 * So fit against the duration the renderer will actually use. The half-pixel
 * fallback then guards the residual case where that product still ceils high in
 * floating point. Below the overflow threshold the row is not scrollable, so
 * fillParent draws it to the container's full width with no gap either side.
 */
function fitPxPerSec(containerWidth, ws) {
  // The renderer's own duration, not the media header's.
  const duration = ws.decodedData?.duration || ws.getDuration();
  if (!(containerWidth > 0) || !(duration > 0)) return 0;
  const exact = containerWidth / duration;
  return Math.ceil(duration * exact) > containerWidth
    ? (containerWidth - 0.5) / duration
    : exact;
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
          ws.zoom(fitPxPerSec(wfEl.clientWidth, ws));
        } else {
          ws.zoom(sharedPxPerSec);
        }
      } else {
        const containerWidth = wfEl.clientWidth;
        if (level <= 1) {
          ws.zoom(fitPxPerSec(containerWidth, ws));
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
      drawAlignmentGrid(targetFilename);
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
    drawAlignmentGrid(targetFilename);
  });
}
