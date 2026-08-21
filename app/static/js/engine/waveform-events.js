// engine/waveform-events.js
//
// One waveform's WaveSurfer event wiring, in two parts.
//
// wireWaveformEvents() attaches the cheap per-waveform handlers. Every one of
// them is a dispatcher: it decides whether this waveform is the active one and
// then calls into the subsystem that owns the response — transport icons,
// annotation highlights, zoom scrolling, the position indicator.
//
// onWaveformReady() is the expensive one (increment 22). It runs once, off the
// "ready" event, and finishes building the waveform: the overlay canvases, the
// correction canvas, the scroll wiring, zoom and scroll mode, the initial grid
// draw, and the "redrawcomplete" handler that keeps all of it in sync. It was
// the last of materializeWaveform's four handlers still living in listen.js;
// "loading" and "error" deliberately stayed behind — see the note above it.
//
// It lives apart from engine/waveform-view.js on purpose. Wiring reaches across
// the whole app, whereas the view module should only ever draw; keeping them
// separate stops the renderer from acquiring imports it has no use for.
//
// Follows engine/measure.js in owning its own wiring: prepareWaveform calls
// wireWaveformEvents once, after the instance exists.
//
// Extracted from listen.js (Phase 1 refactor, cluster L). Behaviour-preserving.

import {
  wavesurfers,
  currentAudioIx,
  swapCurrentAudio,
  updateMarkBtnTooltip,
  maybeLoopActiveRegion,
  updatePlayingAnnotationHighlights,
  clearPlayingAnnotationHighlights,
  activeMarkerIx,
  closeListeningMode,
  getCorrespondingTime,
  loaded,
  loadedAlignmentJSON,
  markers,
  updateRenderAnnoRegions,
  materializeSettled,
  updateGroupCounts,
  hideWaveformOverlay,
  correctionOverlaysInteractive,
} from "../listen.js";
import { updateTransportIcons } from "./transport.js";
import {
  currentZoomLevel,
  scrollMode,
  pageScrollIfNeeded,
  syncAllWaveformScrolls,
  applyScrollMode,
  createOverlayWrapper,
  ensureWfLabel,
  getScrollContainer,
  syncOverlayScroll,
  scrollSyncLock,
  setScrollSyncLock,
} from "./zoom-scroll.js";
import {
  updatePositionIndicator,
  createWaveformOverlays,
  drawAlignmentGrid,
  isWaveformRendered,
} from "./waveform-view.js";
import {
  addMarker,
  clearMarkers,
  updateMarkerDraggableClass,
} from "./markers.js";
import {
  createRegionNavArrows,
  updateAllRegionNavArrows,
} from "./region-nav.js";
import { setupNormGainNode } from "./normalization.js";
import { refillArray } from "./data-session.js";

/**
 * Attach every per-waveform event handler for `filename`.
 *
 * `currentAudioIx` is read through its live binding on each event, so the
 * active-waveform guards stay correct across swaps.
 */
export function wireWaveformEvents(filename) {
  const ws = wavesurfers[filename];
  ws.on("interaction", () => {
    updatePositionIndicator(filename);
  });
  ws.on("interaction", () => {
    if (filename !== currentAudioIx) swapCurrentAudio(filename);
  });
  ws.on("seeking", () => {
    updateMarkBtnTooltip();
  });
  // Only the active waveform drives the transport icon. The two media
  // backends emit play/pause with different timing (WindowedAudioPlayer
  // synchronously, native HTML audio asynchronously), so during a swap a
  // stale, out-of-order event from the outgoing waveform could otherwise
  // overwrite the icon set by the incoming one.
  ws.on("play", () => {
    if (filename === currentAudioIx) updateTransportIcons(true);
  });
  ws.on("pause", () => {
    if (filename === currentAudioIx) {
      updateTransportIcons(false);
      clearPlayingAnnotationHighlights();
    }
  });
  ws.on("finish", () => {
    if (filename === currentAudioIx) {
      updateTransportIcons(false);
      clearPlayingAnnotationHighlights();
    }
  });

  ws.on("audioprocess", () => {
    // Close-listening single-region loop (active jump target is a region start).
    maybeLoopActiveRegion(filename);
    // Light the ribbon cards of annotations whose regions contain the playhead.
    if (filename === currentAudioIx) updatePlayingAnnotationHighlights();
    // Zoom scroll: only act on the playing waveform.
    // Use isPlaying() instead of filename===currentAudioIx to handle edge
    // cases where currentAudioIx hasn't been set yet (e.g. first playback
    // on the Score synth without switching waveforms first).
    const isActive = wavesurfers[filename].isPlaying();
    if (currentZoomLevel > 1 && isActive && scrollMode === "page") {
      pageScrollIfNeeded(filename);
    }
    // Cross-waveform scroll sync during playback — BEFORE position indicator
    // so that non-active waveforms have correct scroll positions for drawing.
    if (currentZoomLevel > 1 && isActive) {
      syncAllWaveformScrolls(filename);
    }
    // Update position indicator AFTER scroll sync
    updatePositionIndicator(filename);
    // Reset mark button while playing (position is moving)
    const markBtn = document.getElementById("mark");
    if (markBtn && markBtn.dataset.mode !== "place") {
      markBtn.title = "Place a marker at the current playback position";
      markBtn.dataset.mode = "place";
      const im = markBtn.querySelector(".icon-mark");
      const imx = markBtn.querySelector(".icon-mark-x");
      if (im) im.style.display = "";
      if (imx) imx.style.display = "none";
    }
  });
}

/**
 * Finish building one waveform once WaveSurfer has decoded and painted it:
 * the overlay canvases, the correction canvas, the scroll wiring, zoom and
 * scroll mode, the initial grid draw, and the redrawcomplete handler that keeps
 * all of it in sync.
 *
 * This is materializeWaveform's `ready` callback. Only filename, playPosition,
 * and isPlaying cross the boundary: the correction-canvas ref, the row element,
 * and the scroll-redraw latch are closed over by the scroll and redrawcomplete
 * handlers registered in here, so they stay local to it.
 *
 * Its three siblings on the same instance stayed in listen.js on purpose.
 * "redrawcomplete" is registered in here and so travelled for free. "loading"
 * only retexts the load overlay, and it closes over materializeWaveform's row
 * element mid-load — moving five lines of progress text would split the private
 * overlay-text trio (showWaveformOverlay / updateWaveformOverlayStatus /
 * hideWaveformOverlay) across the module boundary. "error" is the 401 path: it
 * would drag resolveAudioUrl, getOrigin, promptForAuth, and
 * reloadWaveformsForOrigin in here, which is credential prompting and a full
 * reload — orchestration, not rendering.
 *
 * On the borrowed scroll lock: `scrollSyncLock` is read through its live binding
 * and written through setScrollSyncLock, both from engine/zoom-scroll.js, which
 * owns it (increment 23) because it guards re-entry into that module's
 * syncAllWaveformScrolls. The scroll handler registered below is that guard's only
 * reader; see the declaration there for why the check cannot simply move inside
 * the function it protects.
 */
export function onWaveformReady(filename, playPosition, isPlaying) {
  // Whatever else happens below, this build is done occupying a slot.
  materializeSettled(filename);
  // Wire up Web Audio GainNode for volume normalization
  setupNormGainNode(filename);
  // signal file is ready in filename list
  loaded.add(filename);
  updateGroupCounts();
  console.log("READY:...", filename);
  // In WaveSurfer v7 the canvas lives inside a shadow root; we cannot
  // query it from outside.  Size our overlay canvases to the container
  // and keep them in sync via the "redrawcomplete" event.
  const WAVE_HEIGHT = wavesurfers[filename].options.height || 128;
  const readyWfContainer = document.querySelector(
    `.waveform[data-ix='${filename}']`,
  );

  // --- Overlay wrapper structure ---
  // Canvases sit on .wf-overlays (viewport-sized, no transform).
  // Markers sit on .wf-overlays-inner (full zoom width, translateX'd).
  const ow = createOverlayWrapper(readyWfContainer, WAVE_HEIGHT);
  // Register the view first: it owns `ow`, and createRegionNavArrows reads
  // the wrapper back off it. Final DOM order is unchanged — the canvases
  // insertBefore(ow.inner) and the arrows appendChild after it either way.
  createWaveformOverlays(filename, readyWfContainer, WAVE_HEIGHT, ow);
  createRegionNavArrows(filename);

  // Register this waveform's position-updater so it can be called
  // after resize (the updater reads currentTime from this file's wavesurfer
  // and repaints every position-indicator canvas).

  // --- Alignment correction overlay canvas ---
  const corrCanvas = document.createElement("canvas");
  corrCanvas.classList.add("align-correction-overlay");
  corrCanvas.width = readyWfContainer.clientWidth;
  corrCanvas.height = WAVE_HEIGHT;
  corrCanvas.draggable = false; // prevent native browser drag
  const corrStyle = corrCanvas.style;
  corrStyle.pointerEvents = correctionOverlaysInteractive() ? "auto" : "none";
  // Correction canvas goes on the wrapper (viewport-fixed)
  ow.wrapper.insertBefore(corrCanvas, ow.inner);

  // Store reference for resize
  const _corrCanvasRef = corrCanvas;

  // Wire scroll listener on WaveSurfer's shadow-DOM scroll container
  const _wsScrollContainer = getScrollContainer(filename);
  let _scrollRedrawRaf = false;
  if (_wsScrollContainer) {
    _wsScrollContainer.addEventListener("scroll", () => {
      syncOverlayScroll(filename);
      // Redraw viewport-based canvases (throttled)
      if (!_scrollRedrawRaf) {
        _scrollRedrawRaf = true;
        requestAnimationFrame(() => {
          _scrollRedrawRaf = false;
          drawAlignmentGrid(filename);
          if (currentAudioIx && isWaveformRendered(currentAudioIx)) {
            updatePositionIndicator(currentAudioIx);
          }
          // Cross-waveform scroll sync
          if (!scrollSyncLock && currentZoomLevel > 1) {
            setScrollSyncLock(true);
            syncAllWaveformScrolls(filename);
            requestAnimationFrame(() => {
              setScrollSyncLock(false);
            });
          }
          updateAllRegionNavArrows();
        });
      }
    });
  }

  // Apply current zoom level if waveform loads after zoom has been set
  if (currentZoomLevel > 1) {
    const containerWidth = readyWfContainer.clientWidth;
    const duration = wavesurfers[filename].getDuration();
    wavesurfers[filename].zoom(
      (currentZoomLevel * containerWidth) / duration,
    );
  }
  // Always sync scroll mode on ready — browser may have restored the
  // "follow" radio before wavesurfers exist, so the pageshow handler
  // couldn't apply it.  applyScrollMode checks zoom level internally.
  applyScrollMode(filename);

  // Initial draw
  drawAlignmentGrid(filename);

  // Hide the initial-load overlay
  const readyWfEl = document.querySelector(
    `.waveform[data-ix='${filename}']`,
  );
  if (readyWfEl) hideWaveformOverlay(readyWfEl);

  // "redrawcomplete" fires after each WaveSurfer render cycle — both on the
  // initial load and on any automatic resize triggered by its ResizeObserver.
  wavesurfers[filename].on("redrawcomplete", () => {
    // Resize our overlay canvases and repaint grid lines.
    drawAlignmentGrid(filename);
    // Resize correction overlay (viewport-sized)
    if (_corrCanvasRef && readyWfContainer.isConnected) {
      _corrCanvasRef.width = readyWfContainer.clientWidth;
      _corrCanvasRef.height = wavesurfers[filename].options.height || 128;
    }
    // Sync overlay scroll position after redraw
    syncOverlayScroll(filename);
    // Restore markers (canvas has been redrawn, marker positions must refresh).
    clearMarkers(filename);
    ensureWfLabel(filename);
    markers.forEach((m, i) => {
      const t = getCorrespondingTime(filename, m);
      const color =
        closeListeningMode && activeMarkerIx === i ? "#8b0000" : "red";
      addMarker(filename, { time: t, color, alignIx: m });
    });

    // Reveal this waveform once its canvas, alignment grid, and position
    // indicator are all correctly sized and painted — but only if audio
    // has actually finished loading (not during synthesis).
    const wfEl = document.querySelector(`.waveform[data-ix='${filename}']`);
    if (wfEl && loaded.has(filename)) hideWaveformOverlay(wfEl);
    // If this is an inactive waveform, reset its canvas clip-path to 0.
    // WaveSurfer v7 applies a clip-path to the canvases div matching the
    // playback position; the ::part(progress) CSS hides the progress bar
    // but does not clear the clip-path, leaving the beginning blank.
    if (filename !== currentAudioIx) {
      const sc = getScrollContainer(filename);
      const savedSL = sc ? sc.scrollLeft : 0;
      setScrollSyncLock(true);
      wavesurfers[filename].seekTo(0);
      // Clamp on the way back in: a position captured before a resize or a
      // zoom-out can exceed the new maximum, and restoring it verbatim would
      // re-park the waveform on every redraw, so the bad state never healed.
      if (sc) {
        sc.scrollLeft = Math.min(
          savedSL,
          Math.max(0, sc.scrollWidth - sc.clientWidth),
        );
      }
      setScrollSyncLock(false);
    }
    if (currentAudioIx && isWaveformRendered(currentAudioIx)) {
      updatePositionIndicator(currentAudioIx);
    }
    // Re-add annotation regions — WaveSurfer's redraw removes and recreates
    // region SVG elements, so they must be restored after every render cycle.
    updateRenderAnnoRegions();
    // Ensure newly-created marker elements inherit the draggable class
    // so that drag works without re-toggling the checkbox.
    updateMarkerDraggableClass();
    // No _resizeQueue needed: v7 rerenders each waveform independently.
  });
  let listItem = document.getElementById(filename);
  let status = listItem.querySelector("label").classList;
  status.remove("loading");
  status.remove("queued");
  status.add("ready");
  listItem.querySelector("input").checked = true;
  // check if we're the currentAudioIx, and if so make ourselves active and spool to provided playPosition
  // (possible when normalize checkbox has forced a reload of waveform elements)
  if (filename === currentAudioIx) {
    document
      .querySelector(`.waveform[data-ix='${filename}']`)
      .classList.add("active");
    wavesurfers[currentAudioIx].play(playPosition);
    if (!isPlaying) {
      wavesurfers[currentAudioIx].pause();
    }
  }
  // restore markers from alignment JSON if they exist
  if (
    loadedAlignmentJSON &&
    loadedAlignmentJSON.header &&
    Array.isArray(loadedAlignmentJSON.header.markers)
  ) {
    refillArray(markers, loadedAlignmentJSON.header.markers);
    // markers are rendered by the "redrawcomplete" handler
  }
}
