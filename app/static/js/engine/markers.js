// engine/markers.js
//
// Marker rendering and interaction: draw the marker overlays on every waveform,
// keep the active one highlighted, handle marker clicks, and persist the marker
// list into the alignment JSON.
//
// Holds NO state of its own — the marker list and the active index live in the
// DataSession (session.markers / session.activeMarkerIx), reached here through
// listen.js's live bindings and its setter. When those mirrors are retired
// (Wave C's scaffolding), these imports become direct session reads.
//
// Extracted from listen.js (Phase 1 refactor, increment 13). Behaviour-preserving.
//
// Deliberately left in listen.js: _seekCloseListeningTo (shared with region-start
// navigation), enterCloseListeningMode/exitCloseListeningMode (their own cluster),
// _updateMarkBtnTooltip (transport button, already part of the public API), the
// nudge constants (used by the keyboard handler), and _showMarkerDurations (it
// feeds _measureElements, so it belongs to the Shift-measure cluster).

import {
  wavesurfers,
  currentAudioIx,
  markers,
  activeMarkerIx,
  setActiveMarkerIx,
  closeListeningMode,
  _dragMarkersEnabled,
  loadedAlignmentJSON,
  getCorrespondingTime,
  enterCloseListeningMode,
  _seekCloseListeningTo,
  _updateMarkBtnTooltip,
} from "../listen.js";
import {
  _ensureWfLabel,
  _getZoomedWidth,
  _overlayWrappers,
} from "./zoom-scroll.js";

// Redraws all markers on all wavesurfers, highlighting the active marker in close-listening mode
export function redrawAllMarkers() {
  const _style = getComputedStyle(document.documentElement);
  const markerColor       = _style.getPropertyValue("--color-marker").trim()        || "red";
  const markerActiveColor = _style.getPropertyValue("--color-marker-active").trim() || "#8b0000";
  Object.keys(wavesurfers).forEach((ws) => {
    _clearMarkers(ws);
    _ensureWfLabel(ws);
    markers.forEach((m, i) => {
      const t = getCorrespondingTime(ws, m);
      const color = closeListeningMode && activeMarkerIx === i ? markerActiveColor : markerColor;
      _addMarker(ws, { time: t, color, alignIx: m });
    });
  });
  // Re-apply draggable visual class after DOM recreation
  _updateMarkerDraggableClass();
}

export function _clearMarkers(filename) {
  const wfEl = document.querySelector(`.waveform[data-ix='${filename}']`);
  if (!wfEl) return;
  wfEl.querySelectorAll(".ws-marker").forEach((el) => el.remove());
}

export function _addMarker(
  filename,
  { time, label, color = "red", position = "bottom", alignIx } = {},
) {
  const ws = wavesurfers[filename];
  if (!ws) return null;
  const duration = ws.getDuration();
  const wfEl = document.querySelector(`.waveform[data-ix='${filename}']`);
  if (!wfEl) return null;
  // Use pixel positioning on the full-width overlay inner div
  const fullW = _getZoomedWidth(filename);
  const leftPx =
    duration > 0 ? Math.max(0, Math.min(fullW, (time / duration) * fullW)) : 0;
  const marker = document.createElement("div");
  marker.className = "ws-marker";
  marker.dataset.time = time;
  marker.dataset.position = position;
  if (alignIx != null) marker.dataset.alignIx = alignIx;
  marker.style.left = `${leftPx}px`;
  marker.style.color = color;
  if (label) {
    const lbl = document.createElement("span");
    lbl.className = "ws-marker-label";
    lbl.textContent = label;
    marker.appendChild(lbl);
  }
  marker.addEventListener("click", (ev) => {
    ev.stopPropagation();
    _onMarkerClick(filename, marker);
  });
  // Append to the overlay inner div (scrolls with the waveform)
  const overlayInner = _overlayWrappers[filename]?.inner;
  (overlayInner || wfEl).appendChild(marker);
  return marker;
}

export function _onMarkerClick(filename, markerEl) {
  if (markerEl.dataset.position === "top") return;
  const alignIxStr = markerEl.dataset.alignIx;
  if (alignIxStr == null) return;
  // If drag markers is enabled, let the mousedown handler on #waveforms
  // handle it (start a drag instead of seeking/entering close-listening).
  if (_dragMarkersEnabled) return;
  const alignmentIx = parseInt(alignIxStr);
  const markerArrayIx = markers.indexOf(alignmentIx);
  if (markerArrayIx > -1) {
    if (closeListeningMode) {
      setActiveMarkerIx(markerArrayIx);
      redrawAllMarkers();
      seekToActiveMarker();
    } else {
      enterCloseListeningMode(markerArrayIx);
    }
  } else {
    console.error("Could not find marker with alignIx", alignmentIx);
  }
}

export function seekToActiveMarker() {
  if (activeMarkerIx == null || !currentAudioIx) return;
  _seekCloseListeningTo(getCorrespondingTime(currentAudioIx, markers[activeMarkerIx]));
  _updateMarkBtnTooltip();
}

export function _updateMarkerDraggableClass() {
  const draggable = _dragMarkersEnabled;
  document.querySelectorAll(".ws-marker[data-align-ix]").forEach((el) => {
    el.classList.toggle("draggable", draggable);
  });
}

export function _persistMarkers() {
  if (!loadedAlignmentJSON) return;
  if (!loadedAlignmentJSON.header) loadedAlignmentJSON.header = {};
  loadedAlignmentJSON.header.markers = [...markers];
}
