// engine/normalization.js
//
// Per-waveform audio normalization via Web Audio GainNodes, plus the
// WindowedAudioPlayer lifecycle for frame-stream formats (VBR MP3 / ADTS AAC)
// whose native <audio> seeking is inaccurate.
//
// Extracted from listen.js (Phase 1 refactor, increment 2). Behaviour-preserving
// relocation; this is a DataSession-side concern (shared decoded-audio / gain).
// State here is module-local (self-owned): no other module writes it. The only
// external touch is seekAnalysis.clear() on a full reload, so seekAnalysis is
// exported for that.

import { analyzeAudio } from "../audio-seek-index.js";
import { WindowedAudioPlayer } from "../windowed-audio-player.js";
import { wavesurfers, fileBlobs, waveformPeaks } from "../listen.js";

let _normAudioCtx = null; // lazy AudioContext shared across all waveforms
const _normGainNodes = {}; // filename -> GainNode
const _normSourceNodes = {}; // filename -> MediaElementAudioSourceNode
const _normPeaks = {}; // filename -> peak amplitude (0..1)

// Windowed Web-Audio players for frame-stream formats (VBR MP3 / ADTS AAC) whose
// <audio> seeking is inaccurate. Keyed by filename; absent => native playback.
const _windowedPlayers = {}; // filename -> WindowedAudioPlayer
export const seekAnalysis = new Map(); // filename -> analyzeAudio() result (index, or null = native seek)

/** Lazily create the shared AudioContext (must happen after a user gesture). */
function _getNormAudioCtx() {
  if (!_normAudioCtx) {
    _normAudioCtx = new AudioContext();
  }
  return _normAudioCtx;
}

/** Compute the peak amplitude of decoded audio data (0..1). */
function _computePeak(decodedData) {
  let peak = 0;
  for (let ch = 0; ch < decodedData.numberOfChannels; ch++) {
    const chan = decodedData.getChannelData(ch);
    for (let i = 0; i < chan.length; i++) {
      const abs = Math.abs(chan[i]);
      if (abs > peak) peak = abs;
    }
  }
  return peak;
}

/** Peak amplitude (0..1) from a pregenerated peaks array (already abs maxima). */
function _peakFromPeaks(peaks) {
  let peak = 0;
  for (let i = 0; i < peaks.length; i++) {
    const abs = Math.abs(peaks[i]);
    if (abs > peak) peak = abs;
  }
  return peak;
}

/**
 * Build (and calibrate) a WindowedAudioPlayer for a file if it's a frame-stream
 * format with inaccurate native seeking (VBR MP3 / ADTS AAC). Returns the
 * player, or null to use WaveSurfer's default <audio> playback. Requires the
 * original blob (user-supplied audio); URL-only sources use the native path.
 */
export async function maybeBuildWindowedPlayer(filename) {
  if (_windowedPlayers[filename]) return _windowedPlayers[filename];
  const blob = fileBlobs.get(filename);
  if (!blob) return null;
  try {
    // Analyze once per file (cached; negative results too, so CBR/WAV/etc. are
    // not re-read/re-scanned on reloadWaveforms).
    let index;
    if (seekAnalysis.has(filename)) {
      index = seekAnalysis.get(filename);
    } else {
      index = analyzeAudio(await blob.arrayBuffer());
      seekAnalysis.set(filename, index);
    }
    if (!index) return null; // CBR MP3 / WAV / Ogg / FLAC / MP4 → seek natively
    const player = new WindowedAudioPlayer(blob, index, {
      audioContext: _getNormAudioCtx(),
      duration: waveformPeaks[filename]?.duration,
    });
    // Calibrate the gapless offset in the background so it doesn't block the
    // waveform render. Until it lands (~tens of ms) the player uses the
    // ~10 ms-accurate duration heuristic; seeks become exact once calibrated.
    player.init();
    _windowedPlayers[filename] = player;
    console.log(
      `Windowed playback for ${filename} (${index.format} VBR, accurate seek)`,
    );
    return player;
  } catch (e) {
    console.warn("Windowed player setup failed for", filename, e);
    return null;
  }
}

/**
 * Set up a GainNode for a waveform after it signals "ready".
 * Native: <audio> → MediaElementSourceNode → GainNode → destination.
 * Windowed: the player owns its gain chain; we just drive its app-gain node.
 */
export function setupNormGainNode(filename) {
  const ws = wavesurfers[filename];
  if (!ws) return;
  if (_normGainNodes[filename]) return; // already wired
  const ctx = _getNormAudioCtx();
  const player = _windowedPlayers[filename];
  let gain;
  if (player) {
    // Engine-backed: normalize via the player's own gain node (already routed
    // to destination). Peak comes from the pregenerated peaks (no full buffer).
    gain = player.getGainNode();
    const pk = waveformPeaks[filename]?.peaks;
    if (pk) _normPeaks[filename] = _peakFromPeaks(pk);
  } else {
    const mediaEl = ws.getMediaElement();
    const source = ctx.createMediaElementSource(mediaEl);
    gain = ctx.createGain();
    source.connect(gain);
    gain.connect(ctx.destination);
    _normSourceNodes[filename] = source;
    const decoded = ws.getDecodedData();
    if (decoded) _normPeaks[filename] = _computePeak(decoded);
  }
  _normGainNodes[filename] = gain;
  // Apply current normalize state
  if (document.getElementById("normalize").checked) {
    const peak = _normPeaks[filename] || 1;
    gain.gain.value = peak > 0 ? 1 / peak : 1;
  }
}

/** Disconnect and clean up the GainNode for a waveform being destroyed. */
export function teardownNormGainNode(filename) {
  const player = _windowedPlayers[filename];
  if (player) {
    // The player owns its gain chain; destroying it disconnects everything.
    player.destroy();
    delete _windowedPlayers[filename];
    delete _normGainNodes[filename]; // (this was the player's gain; don't disconnect here)
    delete _normPeaks[filename];
    return;
  }
  if (_normSourceNodes[filename]) {
    _normSourceNodes[filename].disconnect();
    delete _normSourceNodes[filename];
  }
  if (_normGainNodes[filename]) {
    _normGainNodes[filename].disconnect();
    delete _normGainNodes[filename];
  }
  delete _normPeaks[filename];
}

/** Apply or remove normalization gain across all waveforms. */
export function applyNormGain(normalize) {
  for (const [filename, gain] of Object.entries(_normGainNodes)) {
    if (normalize) {
      const peak = _normPeaks[filename] || 1;
      gain.gain.value = peak > 0 ? 1 / peak : 1;
    } else {
      gain.gain.value = 1;
    }
  }
}
