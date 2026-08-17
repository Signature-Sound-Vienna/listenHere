// engine/transport.js
//
// Playback transport primitives: play/pause toggle, relative seek, and the
// play/pause button icon state. These are pure operations over the active
// recording (wavesurfers[currentAudioIx]) — no state of their own.
//
// Extracted from listen.js (Phase 1 refactor, increment 3). Behaviour-preserving
// relocation. currentAudioIx is imported as a live binding (reflects
// swapCurrentAudio's reassignment); the button/keyboard wiring stays in
// listen.js and calls these.

import {
  wavesurfers,
  currentAudioIx,
  swapCurrentAudio,
  _updateMarkBtnTooltip,
} from "../listen.js";

/** Swap the play/pause button between its play and pause glyphs. */
export function _updateTransportIcons(playing) {
  const pp = document.getElementById("playpause");
  if (!pp) return;
  const iconPlay = pp.querySelector(".icon-play");
  const iconPause = pp.querySelector(".icon-pause");
  if (iconPlay) iconPlay.style.display = playing ? "none" : "";
  if (iconPause) iconPause.style.display = playing ? "" : "none";
}

/** Seek the active recording by `delta` seconds, clamped to its duration. */
export function _seekBy(delta) {
  if (!currentAudioIx || !wavesurfers[currentAudioIx]) return;
  const ws = wavesurfers[currentAudioIx];
  const dur = ws.getDuration();
  if (dur > 0) {
    const newTime = Math.max(0, Math.min(dur, ws.getCurrentTime() + delta));
    ws.seekTo(newTime / dur);
  }
}

/** Toggle play/pause on the active recording, activating the first one if none. */
export function playpause() {
  if (currentAudioIx) {
    if (wavesurfers[currentAudioIx].isPlaying())
      wavesurfers[currentAudioIx].pause();
    else wavesurfers[currentAudioIx].play();
  } else {
    // if there is at least one waveform loaded, make it active and play it
    let firstWs = document.querySelector(".waveform");
    if (firstWs) {
      swapCurrentAudio(firstWs.dataset.ix);
      wavesurfers[currentAudioIx].play();
    }
  }
  _updateMarkBtnTooltip();
}
