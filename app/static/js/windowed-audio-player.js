// windowed-audio-player.js
//
// A Web-Audio "media object" for WaveSurfer 7's supported `media` option
// (the same interface WS7's own WebAudioPlayer implements). Unlike WS7's
// player, this one does NOT decode the whole file: it decodes ~30 s chunks on
// demand via a precomputed frame index (see audio-seek-index.js), so seeking is
// sample-accurate for VBR MP3 / ADTS AAC while memory stays at tens of MB.
//
// Why this exists: the HTML <audio> element seeks VBR MP3 by estimating
// time->byte, landing up to ~one Xing-TOC bucket (~15 s) away. Decoding exact
// byte ranges ourselves removes that error. We ride WS7's `media` seam, so we
// touch no wavesurfer internals (verified against WS 7.12.1, Chromium+Firefox).
//
// Timeline note: the alignment `times`/`peaks` were produced by decodeAudioData,
// whose duration is stored in the alignment JSON. Our frame index counts every
// frame (untrimmed), so it can be ~50 ms longer (Xing frame + encoder delay).
// We reconcile by `gaplessOffset = indexDuration - alignDuration` and map
// ws/peaks time -> index time by adding it, so playback lands on the marker the
// user sees.

/** Minimal event emitter mirroring WS7's (on/un/once/emit + DOM-style aliases). */
class Emitter {
  constructor() {
    this.listeners = {};
    this.addEventListener = this.on.bind(this);
    this.removeEventListener = this.un.bind(this);
  }
  on(t, fn, opts) {
    (this.listeners[t] || (this.listeners[t] = new Set()));
    if (opts && opts.once) {
      const wrap = (...a) => { this.un(t, wrap); fn(...a); };
      this.listeners[t].add(wrap);
      return () => this.un(t, wrap);
    }
    this.listeners[t].add(fn);
    return () => this.un(t, fn);
  }
  un(t, fn) { this.listeners[t] && this.listeners[t].delete(fn); }
  once(t, fn) { return this.on(t, fn, { once: true }); }
  emit(t, ...a) { this.listeners[t] && this.listeners[t].forEach((fn) => fn(...a)); }
}

// Tuning constants.
const CHUNK_SEC = 30; // decoded chunk length (steady-state, for decode-ahead)
const FIRST_CHUNK_SEC = 3; // small first chunk after a (re)start → fast startup
const REFILL_SEC = 6; // begin decoding the next chunk this far before the current ends
const SCHEDULE_LATENCY = 0.04; // start the first source this far in the future
const WARMUP_FRAMES = { mp3: 12, "aac-adts": 3 }; // frames decoded before the target (bit reservoir / SBR)
// Per-fragment priming to skip. 0 for both: the priming a fragment decode adds
// also appears in the full/peaks decode, so it cancels (verified empirically,
// Chromium MP3 + AAC → 0-sample lag). Kept as a hook in case a format differs.
const DECODER_DELAY = { mp3: 0, "aac-adts": 0 };
const CHUNK_CACHE = 4; // LRU of decoded chunks (keyed by sliceStartFrame)

export class WindowedAudioPlayer extends Emitter {
  /**
   * @param {Blob} blob               original compressed audio (sliced on demand)
   * @param {object} index            result of analyzeAudio(arrayBuffer)
   * @param {object} opts
   * @param {AudioContext} opts.audioContext shared context
   * @param {number} opts.duration    alignment duration (peaks timeline); defaults to index.duration
   */
  constructor(blob, index, opts = {}) {
    super();
    this._blob = blob;
    this._index = index;
    this._ctx = opts.audioContext || new AudioContext();

    this._fileBytes = blob.size;
    this._dur = Number.isFinite(opts.duration) && opts.duration > 0 ? opts.duration : index.duration;
    // Map ws/peaks time -> untrimmed index time (see header note). Start with the
    // duration-difference heuristic; init() refines it by direct measurement.
    this._gaplessOffset = Math.max(0, Math.min(0.5, index.duration - this._dur));
    this._calibrated = false;
    this._warmup = WARMUP_FRAMES[index.format] ?? 8;
    this._decoderDelay = DECODER_DELAY[index.format] ?? 0;
    this._chunkSec = opts.chunkSec || CHUNK_SEC; // overridable for tests
    this._firstChunkSec = opts.firstChunkSec || FIRST_CHUNK_SEC;

    // Gain chain: source -> appGain (normalization, exposed via getGainNode) ->
    // volGain (WS volume/mute) -> destination. Mirrors the app's two-stage gain.
    this._appGain = this._ctx.createGain();
    this._volGain = this._ctx.createGain();
    this._appGain.connect(this._volGain);
    this._volGain.connect(this._ctx.destination);

    // Transport state.
    this.paused = true;
    this.seeking = false;
    this.ended = false;
    this.autoplay = false;
    this.controls = false;
    this.preservesPitch = true;
    this.crossOrigin = null;
    this.currentSrc = "";
    this._rate = 1;
    this._muted = false;
    this._volume = 1;

    this._pausedWs = 0; // position when paused/seeked
    this._anchorWs = 0; // ws time at _anchorCtx
    this._anchorCtx = 0; // ctx time the contiguous playback's _anchorWs maps to
    this._started = false; // first source actually scheduled
    this._gen = 0; // invalidates stale async work after seek/pause
    this._segments = []; // [{source, endCtx, endWs, sliceEndFrame, eof}]
    this._scheduling = false;
    this._pump = null; // interval id
    this._stopAtWs = Infinity;
    this._chunkCache = new Map(); // sliceStartFrame -> AudioBuffer (LRU)
  }

  /**
   * One-time calibration of the gapless offset so windowed seeks land
   * sample-accurately on the peaks/marker timeline. We calibrate the REAL chunk
   * playback path against a byte-0 reference decode (which == the full/peaks
   * timeline at the start): decode a probe chunk exactly as playback does,
   * cross-correlate it against the reference, and take the lag as the offset.
   * This absorbs every browser-specific per-fragment behaviour (encoder delay,
   * MDCT/overlap startup, dropped first frame) because the probe uses the same
   * decode path as playback. Encoder/format/browser-agnostic; on any failure it
   * keeps the duration-difference heuristic. Idempotent. Safe to await.
   */
  async init() {
    if (this._calibrated) return this;
    this._calibrated = true;
    try {
      const offset = await this._measureGaplessOffset();
      if (Number.isFinite(offset) && offset >= -0.05 && offset < 0.5) this._gaplessOffset = offset;
    } catch (e) {
      // keep heuristic; not fatal
    }
    return this;
  }

  async _measureGaplessOffset() {
    const idx = this._index;
    const SR = idx.sampleRate, spf = idx.samplesPerFrame;
    const dur = (idx.frameCount * spf) / SR;
    const framesFor = (sec) =>
      Math.min(idx.frameCount - 1, Math.max(1, Math.ceil((sec * SR) / spf)));
    const refSec = Math.min(8, dur * 0.6);
    const probeSec = refSec / 2;

    // Reference = decode from byte 0 == the full/peaks timeline (ref[k] = peaks sample k).
    const ref = await this._ctx.decodeAudioData(
      await this._blob.slice(0, idx.frameOffsets[framesFor(refSec)]).arrayBuffer(),
    );
    const bufR = ref.sampleRate;

    // Probe = our exact chunk path at probeSec, computed with offset 0.
    const targetSample = Math.round(probeSec * SR);
    const frameIndex = Math.floor(targetSample / spf);
    const sliceStartFrame = Math.max(0, frameIndex - this._warmup);
    const sliceEndFrame = Math.min(idx.frameCount, frameIndex + framesFor(2));
    const chunk = await this._decodeChunk(sliceStartFrame, sliceEndFrame, this._gen);
    const offsetSec =
      (targetSample - sliceStartFrame * spf) / SR + (this._decoderDelay * (bufR / SR)) / bufR;

    const probeStart = Math.max(0, Math.round(offsetSec * bufR));
    const refStart = Math.round(probeSec * bufR);
    const N = Math.min(
      Math.round(0.8 * bufR),
      chunk.length - probeStart - 1,
      ref.length - refStart - 1,
    );
    if (N < bufR * 0.1) throw new Error("calibration window too small");
    const probe = chunk.getChannelData(0).subarray(probeStart, probeStart + N);
    const refWin = ref.getChannelData(0).subarray(refStart, refStart + N);

    // refWin[i] ~ probe[i+lag]  =>  gaplessOffset(sec) = lag / bufR.
    const { lag, c } = this._xcorr(refWin, probe, Math.round(0.15 * bufR));
    if (c < 0.7) throw new Error("calibration correlation too low: " + c.toFixed(3));
    return lag / bufR;
  }

  /** Best integer lag of b vs a (a[i] ~ b[i+lag]) and its normalized correlation. */
  _xcorr(a, b, maxLag) {
    const n = Math.min(a.length, b.length) - maxLag;
    let best = { lag: 0, c: -2 };
    for (let lag = -maxLag; lag <= maxLag; lag++) {
      let dot = 0, na = 0, nb = 0;
      for (let i = maxLag; i < n; i += 4) {
        const x = a[i], y = b[i + lag] || 0;
        dot += x * y; na += x * x; nb += y * y;
      }
      const c = dot / (Math.sqrt(na * nb) || 1);
      if (c > best.c) best = { lag, c };
    }
    return best;
  }

  // ---- WS7 media interface -------------------------------------------------

  get duration() { return this._dur; }
  set duration(v) { if (Number.isFinite(v) && v > 0) this._dur = v; }

  get currentTime() {
    if (this.paused || !this._started) return this._clamp(this._pausedWs);
    return this._clamp(this._anchorWs + (this._ctx.currentTime - this._anchorCtx) * this._rate);
  }
  set currentTime(t) { this._seek(this._clamp(t)); this.emit("seeking"); this.emit("timeupdate"); }

  get playbackRate() { return this._rate; }
  set playbackRate(v) {
    if (!v || v <= 0) return;
    const at = this.currentTime;
    this._rate = v;
    if (!this.paused) this._restartFrom(at); // reschedule with new rate
  }

  get volume() { return this._volume; }
  set volume(v) {
    this._volume = v;
    if (!this._muted) this._volGain.gain.value = v;
    this.emit("volumechange");
  }
  get muted() { return this._muted; }
  set muted(m) {
    if (this._muted === m) return;
    this._muted = m;
    this._volGain.gain.value = m ? 0 : this._volume;
  }

  get src() { return this.currentSrc; }
  set src(v) { this.currentSrc = v || ""; } // inert: we own decoding, ignore URLs
  load() { return Promise.resolve(); }

  canPlayType(t) { return /^(audio|video)\//.test(t) ? "maybe" : ""; }
  setSinkId(id) { return this._ctx.setSinkId ? this._ctx.setSinkId(id) : Promise.resolve(); }
  getGainNode() { return this._appGain; }
  getChannelData() { return []; } // windowed: no full buffer (normalization peak comes from peaks[])
  removeAttribute() {}
  remove() { this.destroy(); }

  play() {
    if (!this.paused) return Promise.resolve();
    if (this._ctx.state === "suspended") this._ctx.resume();
    this.paused = false;
    this.ended = false;
    this._restartFrom(this._pausedWs);
    this.emit("play");
    return Promise.resolve();
  }

  pause() {
    if (this.paused) return;
    this._pausedWs = this.currentTime;
    this._teardown();
    this.paused = true;
    this.emit("pause");
  }

  /** WS7 may call this to stop bounded playback at a time (region end). */
  stopAt(t) { this._stopAtWs = this._clamp(t); }

  destroy() {
    this._teardown();
    this._chunkCache.clear();
    try { this._appGain.disconnect(); this._volGain.disconnect(); } catch {}
  }

  // ---- internals -----------------------------------------------------------

  _clamp(t) { return Math.max(0, Math.min(this._dur, t || 0)); }

  /** Map a ws/peaks time to the frame slice + target sample that contains it. */
  _locate(wsStart, chunkSec = this._chunkSec) {
    const idx = this._index;
    const SR = idx.sampleRate, spf = idx.samplesPerFrame;
    const indexTime = wsStart + this._gaplessOffset;
    const targetSample = Math.round(indexTime * SR);
    let frameIndex = Math.floor(targetSample / spf);
    if (frameIndex >= idx.frameCount) frameIndex = idx.frameCount - 1;
    const sliceStartFrame = Math.max(0, frameIndex - this._warmup);
    const chunkFrames = Math.ceil((chunkSec * SR) / spf);
    const sliceEndFrame = Math.min(idx.frameCount, frameIndex + chunkFrames);
    return { SR, spf, targetSample, frameIndex, sliceStartFrame, sliceEndFrame };
  }

  /** Seconds from a decoded chunk's start to the target content (handles resample + priming). */
  _bufferOffsetSec(loc, bufSR) {
    const srScale = bufSR / loc.SR; // 1 unless the browser resampled (e.g. Safari)
    const contentOffsetSec = (loc.targetSample - loc.sliceStartFrame * loc.spf) / loc.SR;
    const primingSec = (this._decoderDelay * srScale) / bufSR;
    return contentOffsetSec + primingSec;
  }

  /**
   * Decode and return the PCM (channel 0) that would be heard starting at a
   * ws/peaks time. Used for verification; also handy for analysis.
   * @returns {Promise<{data: Float32Array, sampleRate: number}>}
   */
  async decodeContentAt(wsStart, durSec) {
    const loc = this._locate(this._clamp(wsStart));
    const buffer = await this._decodeChunk(loc.sliceStartFrame, loc.sliceEndFrame, this._gen);
    const offsetSec = this._bufferOffsetSec(loc, buffer.sampleRate);
    const startS = Math.max(0, Math.round(offsetSec * buffer.sampleRate));
    const n = Math.round(durSec * buffer.sampleRate);
    return { data: buffer.getChannelData(0).slice(startS, startS + n), sampleRate: buffer.sampleRate };
  }

  _seek(wsTime) {
    this._stopAtWs = Infinity;
    if (this.paused) { this._pausedWs = wsTime; return; }
    this._restartFrom(wsTime);
  }

  /** (Re)start contiguous playback at a ws time. */
  _restartFrom(wsTime) {
    this._teardown(/*keepPaused*/ false);
    this._pausedWs = wsTime;
    this._anchorWs = wsTime;
    this._started = false;
    const gen = ++this._gen;
    // Kick off first chunk; its source.start sets the real anchor ctx time.
    this._scheduleNext(wsTime, null, gen);
    this._pump = setInterval(() => this._maybeRefill(gen), 200);
  }

  _teardown() {
    this._gen++;
    if (this._pump) { clearInterval(this._pump); this._pump = null; }
    for (const seg of this._segments) {
      try { seg.source.onended = null; seg.source.stop(); seg.source.disconnect(); } catch {}
    }
    this._segments = [];
    this._scheduling = false;
  }

  _maybeRefill(gen) {
    if (gen !== this._gen || this.paused || this._scheduling) return;
    const last = this._segments[this._segments.length - 1];
    if (!last || last.eof) return;
    if (last.endCtx - this._ctx.currentTime <= REFILL_SEC) {
      this._scheduleNext(last.endWs, last, gen);
    }
  }

  /**
   * Decode the chunk covering [wsStart, …] and schedule its source to begin at
   * the previous segment's end (or SCHEDULE_LATENCY in the future for the first).
   */
  async _scheduleNext(wsStart, prevSeg, gen) {
    if (wsStart >= this._dur - 1e-3) { // reached end
      if (prevSeg) prevSeg.eof = true;
      return;
    }
    this._scheduling = true;
    // Small first chunk → fast startup on play/seek; full chunks for decode-ahead.
    const loc = this._locate(wsStart, prevSeg ? this._chunkSec : this._firstChunkSec);
    const { SR, spf, targetSample, sliceStartFrame, sliceEndFrame } = loc;
    const idx = this._index;

    let buffer;
    try {
      buffer = await this._decodeChunk(sliceStartFrame, sliceEndFrame, gen);
    } catch (e) {
      this._scheduling = false;
      if (gen === this._gen) this.emit("error", e);
      return;
    }
    if (gen !== this._gen || !buffer) { this._scheduling = false; return; }

    const offsetSec = this._bufferOffsetSec(loc, buffer.sampleRate);
    // Audible span: from target to the end of the requested frames.
    const endSampleWanted = sliceEndFrame * spf;
    let playDurSec = (endSampleWanted - targetSample) / SR;
    // Respect a pending stopAt (region end).
    const eof = sliceEndFrame >= idx.frameCount;
    let endWs = wsStart + playDurSec;
    if (endWs > this._stopAtWs) { playDurSec = this._stopAtWs - wsStart; endWs = this._stopAtWs; }
    if (playDurSec <= 0) { this._scheduling = false; return; }
    // Don't read past the buffer.
    playDurSec = Math.min(playDurSec, buffer.duration - offsetSec - 1e-4);

    const startCtx = prevSeg ? prevSeg.endCtx : this._ctx.currentTime + SCHEDULE_LATENCY;
    const source = this._ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = this._rate;
    source.connect(this._appGain);
    try {
      source.start(startCtx, offsetSec, playDurSec);
    } catch (e) {
      this._scheduling = false;
      return;
    }
    const endCtx = startCtx + playDurSec / this._rate;
    const seg = { source, endCtx, endWs, sliceEndFrame, eof: eof || endWs >= this._stopAtWs };

    if (!this._started) {
      this._started = true;
      this._anchorWs = wsStart;
      this._anchorCtx = startCtx;
    }

    source.onended = () => {
      if (gen !== this._gen) return;
      // Release this finished segment (and its decoded buffer) — without this,
      // _segments would retain every chunk's buffer and grow to the whole file.
      try { source.disconnect(); } catch {}
      const i = this._segments.indexOf(seg);
      if (i >= 0) this._segments.splice(i, 1);
      if (seg.eof) {
        if (this._pump) { clearInterval(this._pump); this._pump = null; }
        this._gen++; // invalidate any in-flight scheduling
        this.paused = true;
        this.ended = true;
        this._started = false;
        this._pausedWs = endWs >= this._dur - 1e-2 ? this._dur : endWs;
        this._stopAtWs = Infinity;
        this.emit("timeupdate");
        this.emit("pause");
        this.emit("ended");
      }
    };

    this._segments.push(seg);
    this._scheduling = false;
  }

  async _decodeChunk(sliceStartFrame, sliceEndFrame, gen) {
    if (this._chunkCache.has(sliceStartFrame)) {
      const buf = this._chunkCache.get(sliceStartFrame); // refresh LRU
      this._chunkCache.delete(sliceStartFrame);
      this._chunkCache.set(sliceStartFrame, buf);
      return buf;
    }
    const startByte = this._index.frameOffsets[sliceStartFrame];
    const endByte = sliceEndFrame < this._index.frameCount
      ? this._index.frameOffsets[sliceEndFrame]
      : this._blob.size;
    const ab = await this._blob.slice(startByte, endByte).arrayBuffer();
    if (gen !== this._gen) return null;
    const buffer = await this._ctx.decodeAudioData(ab);
    // LRU insert.
    this._chunkCache.set(sliceStartFrame, buffer);
    if (this._chunkCache.size > CHUNK_CACHE) {
      const oldest = this._chunkCache.keys().next().value;
      this._chunkCache.delete(oldest);
    }
    return buffer;
  }
}

export default WindowedAudioPlayer;
