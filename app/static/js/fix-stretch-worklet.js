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
 * Messages in:  load {ch0, ch1, srcRate}, patch {ch, offset, data},
 *               play, pause, seek {pos seconds}, rate {value},
 *               probe {t0, t1, tag}.
 * Messages out: pos {pos seconds} (~12/s while playing), ended,
 *               probe {tag, t0, t1, len, ch0: {peak, rms}, ch1: {peak, rms}}.
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

class FixStretchProcessor extends AudioWorkletProcessor {
  constructor() {
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
    this.sincePost = 0;
    this.win = new Float32Array(GRAIN);
    for (let i = 0; i < GRAIN; i++) {
      this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / GRAIN);
    }
    this.port.onmessage = (e) => this._onMsg(e.data);
  }

  _onMsg(m) {
    if (m.type === "load") {
      this.ch = [m.ch0, m.ch1];
      this.srcRate = m.srcRate;
      this.r = this.srcRate / sampleRate;
      this._seek(0);
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
  }

  /** New younger grain, one hop on: nominal target + WSOLA refinement. */
  _spawn() {
    const prev = this.gB;
    const O = prev.O + HOP;
    const seamless = prev.S + HOP * this.r; // pitch-true continuation
    let S = this.nominal;
    if (this.rate !== 1 && this.ch) {
      const ref = Math.round(seamless);
      const mono = this.ch[0]; // the recording ear anchors the alignment
      const last = mono.length - CORR_LEN - 1;
      if (ref >= 0 && ref <= last) {
        const lo = Math.max(0, Math.round(S) - SEARCH);
        const hi = Math.min(last, Math.round(S) + SEARCH);
        let best = -Infinity;
        let bestS = Math.round(S);
        for (let c = lo; c <= hi; c++) {
          let acc = 0;
          for (let j = 0; j < CORR_LEN; j++) acc += mono[c + j] * mono[ref + j];
          if (acc > best) {
            best = acc;
            bestS = c;
          }
        }
        S = bestS;
      }
    }
    this.gA = prev;
    this.gB = { S, O };
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
    const len = c0.length;
    const L = out[0].length;
    for (let k = 0; k < L; k++) {
      if (this.n >= this.gB.O + HOP) this._spawn();
      out[0][k] =
        this._grainSample(this.gA, c0) + this._grainSample(this.gB, c0);
      out[1][k] =
        this._grainSample(this.gA, c1) + this._grainSample(this.gB, c1);
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
      this.port.postMessage({ type: "pos", pos: this.nominal / this.srcRate });
    }
    return true;
  }
}

registerProcessor("fix-stretch", FixStretchProcessor);
