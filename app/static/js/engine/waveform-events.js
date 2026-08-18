// engine/waveform-events.js
//
// One waveform's WaveSurfer event wiring. Every handler here is a dispatcher:
// it decides whether this waveform is the active one and then calls into the
// subsystem that owns the response — transport icons, annotation highlights,
// zoom scrolling, the position indicator.
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
} from "../listen.js";
import { updateTransportIcons } from "./transport.js";
import {
  currentZoomLevel,
  scrollMode,
  pageScrollIfNeeded,
  syncAllWaveformScrolls,
} from "./zoom-scroll.js";
import { updatePositionIndicator } from "./waveform-view.js";

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
