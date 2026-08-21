// engine/mei-synth.js
//
// MIDI parsing and software synthesis for the MEI score waveform: Standard MIDI
// File decoding, tick-to-seconds conversion, additive PCM rendering, and WAV
// encoding, plus the ref-to-synth alignment-grid interpolation that keeps the
// synthesised audio in step with the reference recording.
//
// Pure functions over their arguments — no shared module state, no DOM, no
// WaveSurfer access — so this module carries no imports back to listen.js.
// The orchestration half (_buildAndPrepareSynthWaveform) stays in listen.js,
// where the overlay status, blob-URL registry, and alignment grids live.
//
// Extracted from listen.js (Phase 1 refactor, increment 24). Behaviour-preserving.

/**
 * Interpolate a synth-audio alignment grid from the score body's ref_onset / synth_onset
 * arrays.  For each time in refGrid, returns the corresponding time in the synth audio.
 */
export function interpAlignmentGrid(refGrid, refOnsets, synthOnsets) {
  if (!refOnsets || !refOnsets.length || !synthOnsets)
    return Array.from(refGrid, () => 0);
  const n = refOnsets.length;
  const pairs = Array.from({ length: n }, (_, i) => [
    refOnsets[i],
    synthOnsets[i],
  ]).sort((a, b) => a[0] - b[0]);
  const xs = pairs.map((p) => p[0]),
    ys = pairs.map((p) => p[1]);
  const slope0 = n > 1 ? (ys[1] - ys[0]) / Math.max(xs[1] - xs[0], 1e-9) : 0;
  const slopeN =
    n > 1 ? (ys[n - 1] - ys[n - 2]) / Math.max(xs[n - 1] - xs[n - 2], 1e-9) : 0;
  return Array.from(refGrid, (t) => {
    if (t <= xs[0]) return Math.max(0, ys[0] + slope0 * (t - xs[0]));
    if (t >= xs[n - 1]) return ys[n - 1] + slopeN * (t - xs[n - 1]);
    let lo = 0,
      hi = n - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (xs[m] <= t) lo = m;
      else hi = m;
    }
    return (
      ys[lo] +
      ((t - xs[lo]) / Math.max(xs[hi] - xs[lo], 1e-9)) * (ys[hi] - ys[lo])
    );
  });
}

/**
 * Parse a Standard MIDI File (Uint8Array) into { tpq, tempoChanges, notes }.
 * tempoChanges: [{tick, tempo}] sorted ascending.
 * notes: [{s, e, p, v}] = start/end tick, pitch, velocity.
 */
export function parseMidi(bytes) {
  let p = 0;
  const r4 = () => {
    const v =
      ((bytes[p] << 24) |
        (bytes[p + 1] << 16) |
        (bytes[p + 2] << 8) |
        bytes[p + 3]) >>>
      0;
    p += 4;
    return v;
  };
  const r2 = () => {
    const v = (bytes[p] << 8) | bytes[p + 1];
    p += 2;
    return v;
  };
  const rb = () => bytes[p++];
  const rv = () => {
    let v = 0;
    for (;;) {
      const b = rb();
      v = (v << 7) | (b & 0x7f);
      if (!(b & 0x80)) break;
    }
    return v;
  };
  p = 4;
  const hlen = r4();
  r2();
  const nTracks = r2();
  const tpq = r2();
  p = 8 + hlen;
  const tempoChanges = [{ tick: 0, tempo: 500000 }];
  const notes = [];
  for (let tr = 0; tr < nTracks; tr++) {
    if (bytes[p] !== 0x4d) break; // 'M' of 'MTrk'
    p += 4;
    const tlen = r4();
    const endPos = p + tlen;
    let tick = 0,
      rs = 0;
    const active = new Map();
    while (p < endPos) {
      tick += rv();
      let b = bytes[p];
      if (b === 0xff) {
        p++;
        const mtype = rb();
        const mlen = rv();
        if (mtype === 0x51 && mlen === 3)
          tempoChanges.push({
            tick,
            tempo: (bytes[p] << 16) | (bytes[p + 1] << 8) | bytes[p + 2],
          });
        p += mlen;
      } else if (b === 0xf0 || b === 0xf7) {
        p++;
        p += rv();
      } else {
        if (b & 0x80) {
          rs = b;
          p++;
        }
        const kind = (rs >> 4) & 0xf;
        if (kind === 0x9) {
          const pitch = rb(),
            vel = rb();
          if (vel > 0) active.set((rs & 0xf) * 128 + pitch, { tick, vel });
          else {
            const k = (rs & 0xf) * 128 + pitch;
            if (active.has(k)) {
              const s = active.get(k);
              notes.push({ s: s.tick, e: tick, p: pitch, v: s.vel });
              active.delete(k);
            }
          }
        } else if (kind === 0x8) {
          const pitch = rb();
          rb();
          const k = (rs & 0xf) * 128 + pitch;
          if (active.has(k)) {
            const s = active.get(k);
            notes.push({ s: s.tick, e: tick, p: pitch, v: s.vel });
            active.delete(k);
          }
        } else if (kind === 0xa || kind === 0xb || kind === 0xe) {
          p += 2;
        } else if (kind === 0xc || kind === 0xd) {
          p += 1;
        }
      }
    }
    active.forEach((s, k) =>
      notes.push({ s: s.tick, e: tick, p: k % 128, v: s.vel }),
    );
    p = endPos;
  }
  tempoChanges.sort((a, b) => a.tick - b.tick);
  notes.sort((a, b) => a.s - b.s);
  return { tpq, tempoChanges, notes };
}

/** Convert a MIDI tick to wall-clock seconds using a tempo-change list. */
export function tickToSec(tick, tpq, tcs) {
  let secs = 0,
    pt = 0,
    pu = 500000;
  for (const { tick: ct, tempo: cu } of tcs) {
    if (ct >= tick) break;
    secs += (((ct - pt) / tpq) * pu) / 1e6;
    pt = ct;
    pu = cu;
  }
  return secs + (((tick - pt) / tpq) * pu) / 1e6;
}

/** Format seconds as "Xs" or "Mm\u00a0SSs". */
export function fmtSec(s) {
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  return `${m}m\u00a0${String(Math.round(s % 60)).padStart(2, "0")}s`;
}

/**
 * Synthesise MIDI notes directly to a WAV Blob via additive PCM sample writing.
 *
 * OfflineAudioContext creates one OscillatorNode + one GainNode per note —
 * for a large score (18k+ notes) that's tens of thousands of Web Audio nodes
 * and takes several minutes.  Writing samples directly into a Float32Array is
 * O(total_note_samples) instead of O(nodes), and completes in a few seconds.
 *
 * onProgress(elapsedSec, estimatedTotalSec) — called every ~50 ms of real time.
 */
export async function synthToWav(notes, tpq, tempoChanges, onProgress) {
  if (!notes.length) return null;
  const SR = 22050;
  const maxEndTick = notes.reduce((m, n) => Math.max(m, n.e), 0);
  const duration = tickToSec(maxEndTick, tpq, tempoChanges) + 0.5;
  const nSamples = Math.ceil(duration * SR);
  const out = new Float32Array(nSamples);

  const ATK_S = Math.round(0.01 * SR);
  const REL_S = Math.round(0.03 * SR);
  const total = notes.length;
  const renderStart = performance.now();
  let lastYield = renderStart;

  for (let ni = 0; ni < total; ni++) {
    const note = notes[ni];
    const ts = tickToSec(note.s, tpq, tempoChanges);
    if (ts >= duration) continue;

    const te = Math.min(
      duration - 0.01,
      tickToSec(note.e, tpq, tempoChanges),
    );
    const noteDur = Math.max(0.02, te - ts);
    const amp = (note.v / 127) * 0.12;
    const phaseInc = (440 * Math.pow(2, (note.p - 69) / 12)) / SR;

    const iStart = Math.round(ts * SR);
    const iEnd = Math.min(nSamples, Math.round((ts + noteDur) * SR));
    const atkSamples = Math.min(ATK_S, Math.round(noteDur * 0.3 * SR));
    const sustainEnd = Math.max(iStart + atkSamples, iEnd - REL_S);

    let phase = 0;
    for (let i = iStart; i < iEnd; i++) {
      phase += phaseInc;
      if (phase >= 1) phase -= 1;
      const saw = 2 * phase - 1;
      const si = i - iStart;
      let env;
      if (si < atkSamples) {
        env = si / atkSamples;
      } else if (i >= sustainEnd) {
        env = Math.max(0, (iEnd - i) / REL_S);
      } else {
        env = 1;
      }
      out[i] += saw * amp * env;
    }

    // Yield to the event loop every ~50 ms so progress updates and paints can fire.
    const now = performance.now();
    if (now - lastYield > 50) {
      if (onProgress) {
        const elapsed = (now - renderStart) / 1000;
        const frac = (ni + 1) / total;
        onProgress(elapsed, elapsed / frac);
      }
      await new Promise((r) => setTimeout(r, 0));
      lastYield = performance.now();
    }
  }

  // Peak-normalise
  let peak = 0;
  for (let i = 0; i < nSamples; i++)
    if (Math.abs(out[i]) > peak) peak = Math.abs(out[i]);
  if (peak > 1e-6) for (let i = 0; i < nSamples; i++) out[i] /= peak;

  return _float32ToWavBlob(out, SR);
}

/** Encode a mono Float32Array as a 16-bit PCM WAV Blob. */
function _float32ToWavBlob(samples, SR) {
  const n = samples.length;
  const dataBytes = n * 2;
  const ab = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(ab);
  const ws = (o, s) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  ws(0, "RIFF");
  v.setUint32(4, 36 + dataBytes, true);
  ws(8, "WAVE");
  ws(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, SR, true);
  v.setUint32(28, SR * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  ws(36, "data");
  v.setUint32(40, dataBytes, true);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([ab], { type: "audio/wav" });
}
