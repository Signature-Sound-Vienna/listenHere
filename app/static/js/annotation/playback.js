// V6 annotation — looped playback of an annotation's regions.
//
// Plays every region of an annotation in start-time order on a chosen
// waveform, looping back to the first region after the last. One loop is
// active at a time; starting a new one stops the previous.
//
// Loop-killing signals (in priority order):
//   1. `interaction` on the playing waveform — user clicked/dragged to
//      seek somewhere outside the loop's control; we stop so the overlay
//      doesn't lie.
//   2. `pause` on the playing waveform, ONLY when not in the middle of a
//      swap (see `notifySwap`). Catches Space-key pauses and transport
//      pauses while ignoring the implicit pause that swapCurrentAudio
//      fires on the outgoing waveform.
//   3. `finish` on the playing waveform — WaveSurfer reached the end of
//      the audio before our region-end check triggered. We restart from
//      the first region's start so the loop continues seamlessly.
//
// Waveform switching is a non-resetting signal: listen.js's
// swapCurrentAudio calls `notifySwap(newFile)`; if the new file is also a
// target of the playing annotation, we transfer the loop there
// transparently. If it isn't, we stop (overlay resets, audio is silent
// on the new ws anyway).
//
// Region scheduling uses WaveSurfer 7's `audioprocess` event: when current
// time crosses the current region's end, we seek to the next region's
// start. Cheap and frame-accurate enough for our use.

import * as state from "./state.js";
import { wavesurfers, currentAudioIx } from "../listen.js";

let _playing = null; // { annId, file, ws, regions, currentIx, listeners }
let _swapping = false; // true while listen.js is transitioning between waveforms
const _subscribers = new Set();

/**
 * Notify all subscribers (currently just the ribbon, which redraws to
 * swap the play/pause icon on the chip).
 */
function _emit() {
  for (const fn of _subscribers) {
    try { fn(); } catch (e) { console.error("[annotation/v6] playback listener threw", e); }
  }
}

export function subscribe(fn) {
  _subscribers.add(fn);
  return () => _subscribers.delete(fn);
}

export function getPlayingAnnId() {
  return _playing && _playing.annId;
}

export function isPlaying(annId) {
  return !!(_playing && _playing.annId === annId);
}

/**
 * Start looping the annotation's regions. Picks the waveform to play on
 * in this priority: (1) currently-active waveform if it's a target of
 * this annotation, (2) any target whose waveform exists in the
 * wavesurfers map. If neither matches, returns false (UI can surface a
 * hint).
 *
 * @returns {boolean} true if playback actually started.
 */
export function start(annId) {
  const ann = state.getById(annId);
  if (!ann || !ann.targets || ann.targets.length === 0) return false;

  // Pick the file to play on.
  let target = ann.targets.find((t) => t.file === currentAudioIx && wavesurfers[t.file]);
  if (!target) target = ann.targets.find((t) => wavesurfers[t.file]);
  if (!target) return false;

  // Collect region intervals — drop zero-length regions and sort by start.
  const intervals = (ann.regions || [])
    .map((r) => target.regionTimes[r.id])
    .filter((rt) => rt && rt.end > rt.start)
    .map((rt) => ({ start: rt.start, end: rt.end }))
    .sort((a, b) => a.start - b.start);
  if (intervals.length === 0) return false;

  // Tear down any previous loop.
  stop();

  const ws = wavesurfers[target.file];
  _attachToWaveform(annId, target.file, ws, intervals);
  _safeSeek(ws, intervals[0].start);
  const playResult = ws.play();
  if (playResult && typeof playResult.catch === "function") {
    playResult.catch((err) => {
      console.warn("[annotation/v6] playback start failed", err);
      stop();
    });
  }
  _emit();
  return true;
}

export function stop() {
  if (!_playing) return;
  const { ws, listeners } = _playing;
  try {
    ws.un("audioprocess", listeners.audioprocess);
    ws.un("interaction", listeners.interaction);
    ws.un("pause", listeners.pause);
    ws.un("finish", listeners.finish);
    if (typeof ws.isPlaying === "function" && ws.isPlaying()) ws.pause();
  } catch (_) { /* ws may have been torn down */ }
  _playing = null;
  _emit();
}

/**
 * Called by listen.js's swapCurrentAudio when the user switches between
 * waveforms. If the new file is also a target of the playing annotation,
 * the loop is transferred over so audio + overlay stay aligned. If not,
 * the loop stops (overlay resets to its idle state). Either way, we
 * suppress the pause/interaction signals that the swap itself fires on
 * the outgoing wavesurfer.
 */
export function notifySwap(newFile) {
  if (!_playing) return;
  _swapping = true;
  // Detach from the old waveform without pausing or stopping the loop.
  const old = _playing;
  try {
    old.ws.un("audioprocess", old.listeners.audioprocess);
    old.ws.un("interaction", old.listeners.interaction);
    old.ws.un("pause", old.listeners.pause);
    old.ws.un("finish", old.listeners.finish);
  } catch (_) {}
  _playing = null;

  const ann = state.getById(old.annId);
  const isTransferable =
    ann &&
    ann.targets.some((t) => t.file === newFile) &&
    wavesurfers[newFile];

  if (!isTransferable) {
    // No target match (or no wavesurfer yet) — let the overlay reset and
    // re-allow normal pause/interaction handling on whatever's next.
    _swapping = false;
    _emit();
    return;
  }

  const newTarget = ann.targets.find((t) => t.file === newFile);
  const intervals = (ann.regions || [])
    .map((r) => newTarget.regionTimes[r.id])
    .filter((rt) => rt && rt.end > rt.start)
    .map((rt) => ({ start: rt.start, end: rt.end }))
    .sort((a, b) => a.start - b.start);
  if (intervals.length === 0) {
    _swapping = false;
    _emit();
    return;
  }

  _attachToWaveform(old.annId, newFile, wavesurfers[newFile], intervals);
  // Let downstream pause/interaction events flow normally again.
  _swapping = false;
  _emit();
}

/**
 * Wire the audioprocess / interaction / pause / finish listeners on `ws`.
 * Does NOT seek or play — callers decide. Used by both `start` (fresh
 * loop) and `notifySwap` (transfer to a new waveform during an audio
 * switch).
 */
function _attachToWaveform(annId, file, ws, intervals) {
  const audioprocess = () => {
    if (!_playing || _playing.ws !== ws) return;
    const t = ws.getCurrentTime();
    const cur = _playing.regions[_playing.currentIx];
    if (t >= cur.end) {
      _playing.currentIx = (_playing.currentIx + 1) % _playing.regions.length;
      _safeSeek(ws, _playing.regions[_playing.currentIx].start);
    }
  };
  // User clicked or dragged on the waveform — they're taking manual
  // control, so the loop should yield.
  const interaction = () => {
    if (_playing && _playing.ws === ws) stop();
  };
  // External pause (Space key, transport button, etc.) — stop. We
  // explicitly ignore pauses that happen during a swap (handled by
  // notifySwap), because those aren't user-initiated playback changes.
  const pause = () => {
    if (_swapping) return;
    if (_playing && _playing.ws === ws) stop();
  };
  // WaveSurfer hit the end of the audio. Wrap to the first region's
  // start and keep playing.
  const finish = () => {
    if (!_playing || _playing.ws !== ws) return;
    _playing.currentIx = 0;
    _safeSeek(ws, _playing.regions[0].start);
    const r = ws.play();
    if (r && typeof r.catch === "function") r.catch(() => stop());
  };

  _playing = {
    annId,
    file,
    ws,
    regions: intervals,
    currentIx: 0,
    listeners: { audioprocess, interaction, pause, finish },
  };
  ws.on("audioprocess", audioprocess);
  ws.on("interaction", interaction);
  ws.on("pause", pause);
  ws.on("finish", finish);
}

/**
 * Convenience for the chip overlay: if this annotation is currently
 * playing, stop; otherwise start it.
 */
export function toggle(annId) {
  if (isPlaying(annId)) stop();
  else start(annId);
}

/**
 * WaveSurfer's setTime / seekTo API has shifted between versions; this
 * picks whichever is available.
 */
function _safeSeek(ws, seconds) {
  if (typeof ws.setTime === "function") {
    ws.setTime(seconds);
    return;
  }
  const duration = ws.getDuration && ws.getDuration();
  if (duration > 0 && typeof ws.seekTo === "function") {
    ws.seekTo(Math.max(0, Math.min(1, seconds / duration)));
  }
}
