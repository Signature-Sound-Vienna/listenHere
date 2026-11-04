/**
 * Granular (WSOLA) time-stretch player for the fix-mode audition.
 *
 * Holds its own copy of the stereo source at the aligner's rate (22050) and
 * renders context-rate output in Hann-windowed grains overlap-added at 50%.
 * WITHIN a grain the source is read at its natural rate (pitch intact;
 * linear interpolation does the 22050 → context-rate resample); BETWEEN
 * grains the source head advances by hop × rate, so rate < 1 stretches time
 * without touching pitch. Each new grain's source start is refined by a
 * small cross-correlation search against the seamless continuation of the
 * previous grain (the WSOLA half), which suppresses blind-OLA phasing. At
 * rate = 1 the grains tile exactly (Hann at 50% overlap sums to 1), so 100%
 * speed is bit-faithful up to the resampling interpolation.
 *
 * BOTH channels share one grain schedule: inter-ear timing — the flams the
 * audition exists to expose — is never skewed between the ears.
 *
 * WARP (score-less correction): channel 1 may instead be the REFERENCE
 * recording played through the alignment, so the ear hears it where the
 * alignment says it belongs. Each of its grains starts where the reference
 * corresponds to channel 0's grain start — the target time mapped back
 * through the grids (piecewise-linear; a flat stretch maps to its first
 * sample — fix-mode.js's _targetToRef, repeated here because a worklet
 * cannot share its module) — refined by the same correlation search against
 * its own seamless continuation. The grain schedule stays channel 0's, so the
 * speed control composes. Where the ratio of reference to target time over
 * the 2 s around a grain leaves [1/4, 4] the alignment pairs audio that barely
 * corresponds (a gap, applause, a repeat one recording lacks): those grains
 * get zero gain, and the Hann overlap turns that into a ~23 ms fade. A new
 * grid takes effect at the next grain.
 *
 * Messages in:  load {ch0, ch1, srcRate}, patch {ch, offset, data},
 *               play, pause, seek {pos seconds}, rate {value},
 *               probe {t0, t1, tag},
 *               warp {ref, rg, tg, gain} | warp {ref: null} (off),
 *               warpGrid {rg, tg, sentAt?}.
 * Messages out: pos {pos seconds, refPos?, warpGain?} (~12/s while playing),
 *               warpAck {deliverMs, waitMs} (a new grid's first grain), ended,
 *               probe {tag, t0, t1, len, ch0: {peak, rms}, ch1: {peak, rms}}.
 * processorOptions may carry {ch0, ch1, srcRate, warp, playing} to start
 * loaded — what an OfflineAudioContext test needs, since port messages
 * posted before rendering are not guaranteed to arrive first.
 *
 * `probe` exists because this copy — not the AudioBuffer the client patches
 * beside it — is what the ear actually hears: a diagnostic that cannot be
 * answered from the main thread any other way.
 */

const GRAIN = 1024; // output samples per grain (~21 ms at 48 k)
const HOP = 512; // 50% overlap — Hann COLA, unity gain
const SEARCH = 96; // WSOLA search half-window in source samples (~4 ms)
const CORR_LEN = 256; // correlation length in source samples (~12 ms)
const POS_EVERY = 4096; // output samples between pos posts
const WARP_MAX_RATIO = 4; // beyond 4× either way the warped ear fades out
// The ratio is measured over 2 s of target time around the grain: the grid is
// a DTW path whose 20 ms steps swing from 0.02 to 43, and a pizzicato's rests
// let it wander — measured per hop, the fade silenced 21–56 % of Pizzicato's
// recordings; over 2 s, 0.6–6 % but where material is missing or repeated.
const WARP_RATIO_SPAN_SEC = 2;

class FixStretchProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.ch = null; // [Float32Array, Float32Array] at srcRate
    this.srcRate = 22050;
    this.r = this.srcRate / sampleRate; // source samples per output sample
    this.rate = 1;
    this.playing = false;
    this.nominal = 0; // nominal source position (samples, float)
    this.n = 0; // absolute output-sample counter
    this.gA = null; // older grain {S: source start, O: output start}
    this.gB = null; // younger grain
    this.warp = null; // {ref, rg, tg, gain}: channel 1 is the warped reference
    this.wA = null; // channel 1's grains then: {S: reference start, O, g: gain}
    this.wB = null;
    this.sincePost = 0;
    this.win = new Float32Array(GRAIN);
    for (let i = 0; i < GRAIN; i++) {
      this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / GRAIN);
    }
    this.port.onmessage = (e) => this._onMsg(e.data);
    const o = options && options.processorOptions;
    if (o && o.ch0) {
      this._onMsg({ type: "load", ch0: o.ch0, ch1: o.ch1, srcRate: o.srcRate });
      if (o.warp) this._onMsg({ type: "warp", ...o.warp });
      this.playing = !!o.playing;
    }
  }

  _onMsg(m) {
    if (m.type === "load") {
      this.ch = [m.ch0, m.ch1];
      this.srcRate = m.srcRate;
      this.r = this.srcRate / sampleRate;
      this._seek(0);
    } else if (m.type === "warp") {
      this.warp = m.ref ? { ref: m.ref, rg: m.rg, tg: m.tg, gain: m.gain ?? 1 } : null;
      this._seek(this.nominal);
    } else if (m.type === "warpGrid") {
      if (this.warp) {
        this.warp.rg = m.rg;
        this.warp.tg = m.tg;
        // Timing surface: the delivery delay, and (at the first grain on the
        // new grid, while playing) how many output frames it waited.
        this.gridAck = {
          deliverMs: m.sentAt != null ? (currentTime - m.sentAt) * 1000 : null,
          atN: this.n,
        };
      }
    } else if (m.type === "patch") {
      if (this.ch) this.ch[m.ch].set(m.data, m.offset);
    } else if (m.type === "play") {
      this.playing = true;
    } else if (m.type === "pause") {
      this.playing = false;
    } else if (m.type === "seek") {
      this._seek(m.pos * this.srcRate);
    } else if (m.type === "rate") {
      this.rate = m.value;
    } else if (m.type === "probe") {
      this.port.postMessage({
        type: "probe",
        tag: m.tag,
        t0: m.t0,
        t1: m.t1,
        len: this.ch ? this.ch[0].length : 0,
        srcRate: this.srcRate,
        ch0: this._stats(0, m.t0, m.t1),
        ch1: this._stats(1, m.t0, m.t1),
      });
    }
  }

  /** Peak and RMS of one held channel over [t0, t1) seconds — see `probe`. */
  _stats(ch, t0, t1) {
    const data = this.ch ? this.ch[ch] : null;
    if (!data) return null;
    const lo = Math.max(0, Math.floor(t0 * this.srcRate));
    const hi = Math.min(data.length, Math.ceil(t1 * this.srcRate));
    if (hi <= lo) return { peak: 0, rms: 0, n: 0 };
    let peak = 0;
    let acc = 0;
    for (let i = lo; i < hi; i++) {
      const v = data[i];
      const a = v < 0 ? -v : v;
      if (a > peak) peak = a;
      acc += v * v;
    }
    return { peak, rms: Math.sqrt(acc / (hi - lo)), n: hi - lo };
  }

  _seek(srcSamples) {
    const len = this.ch ? this.ch[0].length : 0;
    this.nominal = Math.min(Math.max(0, srcSamples), len);
    // Restart the grain pair at the seek point; the phantom older grain
    // reads real pre-seek content, so there is no fade-in gap.
    this.gB = { S: this.nominal, O: this.n };
    this.gA = { S: this.nominal - HOP * this.r * this.rate, O: this.n - HOP };
    if (this.warp) {
      this.wB = this._warpGrain(this.gB.S, this.gB.O, null);
      this.wA = this._warpGrain(this.gA.S, this.gA.O, null);
      this._ackGrid(); // a seek rebuilds the grains on the newest grid at once
    }
  }

  /** The timing surface's acknowledgement: the first grain on a new grid. */
  _ackGrid() {
    const ack = this.gridAck;
    if (!ack) return;
    this.gridAck = null;
    this.port.postMessage({
      type: "warpAck",
      deliverMs: ack.deliverMs,
      waitMs: ((this.n - ack.atN) / sampleRate) * 1000,
    });
  }

  /** New younger grain, one hop on: nominal target + WSOLA refinement. */
  _spawn() {
    const prev = this.gB;
    const O = prev.O + HOP;
    const seamless = prev.S + HOP * this.r; // pitch-true continuation
    let S = this.nominal;
    if (this.rate !== 1 && this.ch) S = this._bestStart(this.ch[0], S, seamless);
    this.gA = prev;
    this.gB = { S, O };
    if (this.warp) {
      const w = this._warpGrain(S, O, this.wB);
      this.wA = this.wB;
      this.wB = w;
      this._ackGrid();
    }
  }

  /** WSOLA: the start within ±SEARCH of `nominal` whose next CORR_LEN samples
   *  best match the seamless continuation of the previous grain. */
  _bestStart(data, nominal, seamless) {
    const ref = Math.round(seamless);
    const last = data.length - CORR_LEN - 1;
    if (ref < 0 || ref > last) return nominal;
    const lo = Math.max(0, Math.round(nominal) - SEARCH);
    const hi = Math.min(last, Math.round(nominal) + SEARCH);
    let best = -Infinity;
    let bestS = Math.round(nominal);
    for (let c = lo; c <= hi; c++) {
      let acc = 0;
      for (let j = 0; j < CORR_LEN; j++) acc += data[c + j] * data[ref + j];
      if (acc > best) {
        best = acc;
        bestS = c;
      }
    }
    return bestS;
  }

  /** Channel 1's grain for channel 0's grain at target sample S0: its
   *  reference start (refined against `prev`'s continuation, when there is
   *  one) and its gain (0 where the local ratio leaves the WARP_MAX_RATIO band).
   *  The grain's CENTRE — where its window weighs most — is what is mapped:
   *  mapping its start put the content late wherever the ratio is not 1. */
  _warpGrain(S0, O, prev) {
    const w = this.warp;
    const half = (GRAIN / 2) * this.r;
    const centre = this._toRef(S0 + half);
    const nominal = centre - half;
    const span = HOP * this.r; // one hop, in source samples
    const win = WARP_RATIO_SPAN_SEC * this.srcRate;
    const ratio = (this._toRef(S0 + half + win / 2) - this._toRef(S0 + half - win / 2)) / win;
    const g =
      Number.isFinite(ratio) && ratio <= WARP_MAX_RATIO && ratio >= 1 / WARP_MAX_RATIO ? 1 : 0;
    const S = prev ? this._bestStart(w.ref, nominal, prev.S + span) : nominal;
    return { S, O, g };
  }

  /** Target source samples → reference source samples through the grids. */
  _toRef(s) {
    const { rg, tg } = this.warp;
    const n = tg.length;
    if (!rg || n < 2 || rg.length !== n) return s;
    const t = s / this.srcRate;
    let lo = 0;
    let hi = n; // first index with tg[k] >= t
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tg[mid] < t) lo = mid + 1;
      else hi = mid;
    }
    let k = lo;
    if (k <= 0) k = 1;
    if (k >= n) k = n - 1;
    const d = tg[k] - tg[k - 1];
    if (!(d > 1e-9)) return rg[k - 1] * this.srcRate;
    return (rg[k - 1] + ((t - tg[k - 1]) / d) * (rg[k] - rg[k - 1])) * this.srcRate;
  }

  _grainSample(g, data) {
    const i = this.n - g.O;
    if (i < 0 || i >= GRAIN) return 0;
    const sp = g.S + i * this.r; // natural-rate read: pitch preserved
    const si = Math.floor(sp);
    if (si < 0 || si + 1 >= data.length) return 0;
    const fr = sp - si;
    return (data[si] * (1 - fr) + data[si + 1] * fr) * this.win[i];
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    if (!this.ch || !this.playing || !out[0]) return true;
    const c0 = this.ch[0];
    const c1 = this.ch[1];
    const w = this.warp;
    const len = c0.length;
    const L = out[0].length;
    for (let k = 0; k < L; k++) {
      if (this.n >= this.gB.O + HOP) this._spawn();
      out[0][k] =
        this._grainSample(this.gA, c0) + this._grainSample(this.gB, c0);
      out[1][k] = w
        ? w.gain *
          (this.wA.g * this._grainSample(this.wA, w.ref) +
            this.wB.g * this._grainSample(this.wB, w.ref))
        : this._grainSample(this.gA, c1) + this._grainSample(this.gB, c1);
      this.n++;
      this.nominal += this.r * this.rate;
      if (this.nominal >= len) {
        this.nominal = len;
        this.playing = false;
        this.port.postMessage({ type: "ended" });
        break;
      }
    }
    this.sincePost += L;
    if (this.sincePost >= POS_EVERY) {
      this.sincePost = 0;
      const m = { type: "pos", pos: this.nominal / this.srcRate };
      if (w) {
        m.refPos = this.wB.S / this.srcRate; // where the warped ear reads now
        m.warpGain = this.wB.g;
      }
      this.port.postMessage(m);
    }
    return true;
  }
}

registerProcessor("fix-stretch", FixStretchProcessor);
