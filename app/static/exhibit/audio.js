// exhibit/audio.js
//
// The transport: one shared clock, one recording audible at a time, and every
// strip's cursor derived from that clock rather than from its own playback.
//
// WHY ONE PLAYER AND NOT EIGHT. The exhibit's question is "how do these eight
// differ", not "what do eight sound like at once", and eight simultaneous streams
// would be both unlistenable and, on the iPad, eight decode pipelines. Spike C
// drove six renderers from ONE `WindowedAudioPlayer` with the clock advancing
// (plan §4.0a), which is the pattern this is: the player is the clock, and
// `align-core` turns its time into a position on every other recording.
//
// WHY `WindowedAudioPlayer` RATHER THAN AN <audio> ELEMENT. The prepped files are
// VBR MP3, and an <audio> element seeks VBR by estimating time from byte offset —
// landing up to a Xing-TOC bucket, ~15 s, away from where it was asked to go. An
// exhibit whose whole content is "listen to THIS moment in each recording" cannot
// afford a 15 s seek error, so playback goes through the same accurate-seek path
// Listen Here uses. That module and its frame index are both already uncoupled, so
// they are IMPORTED, not copied.
//
// SWITCHING PRESERVES THE MUSICAL MOMENT, not the wall-clock second. Tapping a
// different strip continues at the same place *in the piece* — the current time is
// projected through the alignment into the new recording's own timeline. Seconds
// would be the wrong invariant: the eight recordings differ by up to a minute over
// the overture, which is the very thing on display.
//
// LEDGER: the player builder is copied from engine/normalization.js — see
// ENGINE-WANTS.md row 1. Everything else here is the exhibit's own.

import { analyzeAudio } from "../js/audio-seek-index.js";
import { WindowedAudioPlayer } from "../js/windowed-audio-player.js";

// How many built players to keep alive by default. Each holds its compressed blob
// (~9 MB) and an LRU of decoded chunks, so keeping all eight would be ~72 MB of
// blob before any decoding — and week 4's one-hour soak (plan §7.4) is the open
// question about this tier, so the conservative number is the right one to start
// from. Two keeps an A/B comparison instant, which is the interaction visitors
// will actually repeat; anything older is re-fetched from the HTTP cache. The
// kiosk can raise it (?playerCache=8) once the soak blesses the memory cost.
const PLAYER_CACHE = 2;

export class Transport {
  /**
   * @param {object} opts
   * @param {Record<string, string>} opts.audio      file -> absolute URL
   * @param {Record<string, number>} opts.durations  file -> alignment duration
   * @param {(time: number, from: string, to: string) => number|undefined} opts.project
   *        map a time in `from`'s timeline to `to`'s. This is the alignment, handed
   *        in rather than imported so the transport has no opinion about how the
   *        projection is done — main.js owns the align-core wiring.
   * @param {number} [opts.playerCache]  built players kept alive (LRU)
   * @param {boolean} [opts.debug]
   */
  constructor({ audio, durations, project, playerCache = PLAYER_CACHE, debug = false }) {
    this._audio = audio;
    this._durations = durations;
    this._project = project;
    this._cacheSize = Math.max(1, playerCache);
    this._debug = debug;

    this._ctx = null;
    this._players = new Map(); // file -> player, in LRU order (oldest first)
    this._pending = new Map(); // file -> in-flight build promise
    this._bytes = new Map(); // file -> {buf, type} warmed by preloadAll, consumed by _build
    this._listeners = new Set();
    this._raf = 0;

    this.activeFile = null;
    /** Time in the ACTIVE file's timeline. Authoritative while nothing plays. */
    this._time = 0;
    this._loading = null; // file currently being fetched, or null
  }

  // ---- what the rest of the exhibit reads -----------------------------------

  get playing() {
    const p = this.activeFile && this._players.get(this.activeFile);
    return !!p && !p.paused;
  }

  /** Current time in the active recording's own timeline. */
  get time() {
    // Authoritative while nothing plays (see _time): a paused player's own
    // report can be the uncalibrated VBR seek heuristic, a second-plus off at
    // depth, and a select()'s async settle emitting that estimate reads as a
    // fresh user seek downstream (it spuriously armed the focus machinery's
    // jump countdown). The requested moment is the truth while paused; once
    // playing, the player is the clock.
    const p = this.activeFile && this._players.get(this.activeFile);
    return p && !p.paused ? p.currentTime : this._time;
  }

  get loadingFile() {
    return this._loading;
  }

  /** Subscribe to state changes; returns an unsubscribe. */
  subscribe(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  // ---- the interaction ------------------------------------------------------

  /**
   * Make `file` the audible recording and continue from `time`.
   *
   * @param {string} file
   * @param {number} [time] seconds in `file`'s OWN timeline. Omitted means "carry
   *   the current musical moment across", which is what a tap on another strip
   *   means; supplied means the visitor tapped a place, so it is taken literally.
   * @param {boolean} [play=true]
   */
  async select(file, time, play = true) {
    if (!this._audio[file]) {
      console.warn(`exhibit transport: no audio for "${file}"`);
      return;
    }
    const at =
      Number.isFinite(time)
        ? time
        : this._carryOver(file);

    const previous = this.activeFile;
    if (previous && previous !== file) this._pause(previous);
    this.activeFile = file;
    this._time = Math.max(0, Math.min(this._durations[file] ?? at, at));
    this._emit();

    let player;
    try {
      player = await this._playerFor(file);
    } catch (e) {
      console.warn(`exhibit transport: ${file} failed to load`, e);
      this._emit();
      return;
    }
    // A second tap can land while the first is still fetching nine megabytes, and
    // the visitor's LAST tap is the one that counts. Without this the losing fetch
    // would finish afterwards and start playing the recording nobody asked for.
    if (this.activeFile !== file) return;

    player.currentTime = this._time;
    if (play) {
      await player.play();
      this._startTicking();
    }
    this._emit();
  }

  /**
   * Name the recording the exhibit is "on" without building a player or making a
   * sound. Used once at boot so the resting state is coherent: the middle band has
   * a conductor to show and the reference strip is marked as the one a tap would
   * play, rather than nine megabytes being fetched before anybody has touched the
   * table. Ignored once something is genuinely active.
   */
  preselect(file) {
    if (this.activeFile || !this._audio[file]) return;
    this.activeFile = file;
    this._time = 0;
    this._emit();
  }

  /** Toggle the active recording, or start the reference if nothing is active. */
  async toggle(fallbackFile) {
    const file = this.activeFile || fallbackFile;
    if (!file) return;
    const player = this._players.get(file);
    if (player && !player.paused) {
      this.pause();
      return;
    }
    await this.select(file, this.activeFile === file ? this.time : undefined);
  }

  pause() {
    if (this.activeFile) this._pause(this.activeFile);
    this._stopTicking();
    this._emit();
  }

  /** Seek within the active recording, in its own timeline. */
  seek(time) {
    if (!this.activeFile) return;
    this._time = Math.max(0, Math.min(this._durations[this.activeFile], time));
    const p = this._players.get(this.activeFile);
    if (p) p.currentTime = this._time;
    this._emit();
  }

  /**
   * Warm every recording's bytes so no visitor ever meets a cold cache
   * (?preload=on — user ruling 2026-08-26, from the iPad device test: the
   * exhibit must not be half-ready for its first visitor).
   *
   * Bytes only, one file at a time: players are still built on first use, so
   * decoded memory stays governed by the player cache, and the sequential
   * fetches never gang up on the network. A visitor's tap always wins — the
   * loop yields to any in-flight user build before starting its next fetch,
   * and a file the visitor got to first is simply skipped. Deliberately never
   * touches `_loading`: warming is invisible, "Loading…" belongs to taps.
   *
   * @param {string[]} files
   * @returns {Promise<{warmed: number, skipped: number, failed: number}>}
   */
  async preloadAll(files) {
    const out = { warmed: 0, skipped: 0, failed: 0 };
    for (const file of files) {
      while (this._pending.size) {
        await Promise.allSettled([...this._pending.values()]);
      }
      if (!this._audio[file] || this._players.has(file) || this._bytes.has(file)) {
        out.skipped++;
        continue;
      }
      try {
        const res = await fetch(this._audio[file]);
        if (!res.ok) throw new Error(`${res.status} for ${this._audio[file]}`);
        const buf = await res.arrayBuffer();
        const type = res.headers.get("content-type") || "audio/mpeg";
        // Re-check: a tap may have built this player while the bytes streamed.
        if (this._players.has(file) || this._pending.has(file)) {
          out.skipped++;
          continue;
        }
        this._bytes.set(file, { buf, type });
        out.warmed++;
      } catch (e) {
        // A failed warm costs nothing but the head start — the tap path will
        // retry the fetch itself and report its own failure.
        console.warn(`exhibit transport: preload of ${file} failed`, e);
        out.failed++;
      }
    }
    if (this._debug) console.log("exhibit transport: preload", out);
    return out;
  }

  destroy() {
    this._stopTicking();
    for (const [, p] of this._players) p.destroy();
    this._players.clear();
    this._bytes.clear();
    this._listeners.clear();
  }

  // ---- internals -----------------------------------------------------------

  /**
   * Where `file` should continue from, given where the active recording is now.
   * Falls back to the raw time when there is no grid for either side — a missing
   * grid should cost alignment accuracy, not playback.
   */
  _carryOver(file) {
    if (!this.activeFile || this.activeFile === file) return this.time;
    const projected = this._project(this.time, this.activeFile, file);
    return Number.isFinite(projected) ? projected : this.time;
  }

  _pause(file) {
    const p = this._players.get(file);
    if (!p) return;
    this._time = p.currentTime;
    p.pause();
  }

  /** The shared AudioContext, created on first use — which is a user gesture. */
  _context() {
    if (!this._ctx) {
      // iOS will not start a context outside a gesture, and every path into here
      // begins with a tap on a strip. Week 4's attract loop breaks that assumption
      // and will need the context primed by the last real visitor interaction —
      // worth knowing now rather than discovering on the museum floor.
      this._ctx = new AudioContext();
    }
    if (this._ctx.state === "suspended") this._ctx.resume();
    return this._ctx;
  }

  async _playerFor(file) {
    const existing = this._players.get(file);
    if (existing) {
      // Refresh LRU position: a Map keeps insertion order, so re-inserting moves
      // this file to the young end and the eviction below stays honest.
      this._players.delete(file);
      this._players.set(file, existing);
      return existing;
    }
    if (this._pending.has(file)) return this._pending.get(file);

    const build = this._build(file).finally(() => this._pending.delete(file));
    this._pending.set(file, build);
    return build;
  }

  async _build(file) {
    this._loading = file;
    this._emit();
    try {
      // Bytes warmed by preloadAll skip the fetch entirely — consumed on use,
      // so the warm store never holds what a living player already owns.
      let warm = this._bytes.get(file);
      if (warm) this._bytes.delete(file);
      if (!warm) {
        const res = await fetch(this._audio[file]);
        if (!res.ok) throw new Error(`${res.status} for ${this._audio[file]}`);
        // The type matters only for the <audio> fallback below — `decodeAudioData`
        // sniffs the bytes — but an untyped blob URL is one an element may refuse,
        // and a fallback that cannot play is not a fallback.
        warm = {
          buf: await res.arrayBuffer(),
          type: res.headers.get("content-type") || "audio/mpeg",
        };
      }
      const { buf, type } = warm;
      const player = buildWindowedPlayer(new Blob([buf], { type }), buf, {
        audioContext: this._context(),
        duration: this._durations[file],
        label: file,
      });
      this._players.set(file, player);
      while (this._players.size > this._cacheSize) {
        const [oldest, victim] = this._players.entries().next().value;
        if (oldest === file || oldest === this.activeFile) break;
        this._players.delete(oldest);
        victim.destroy();
        if (this._debug) console.log(`exhibit transport: evicted ${oldest}`);
      }
      return player;
    } finally {
      if (this._loading === file) this._loading = null;
      this._emit();
    }
  }

  _startTicking() {
    if (this._raf) return;
    const tick = () => {
      this._raf = 0;
      const p = this.activeFile && this._players.get(this.activeFile);
      if (!p || p.paused) {
        this._emit();
        return;
      }
      this._time = p.currentTime;
      this._emit();
      this._startTicking();
    };
    this._raf = requestAnimationFrame(tick);
  }

  _stopTicking() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
  }

  _emit() {
    const state = {
      file: this.activeFile,
      time: this.time,
      playing: this.playing,
      loading: this._loading,
    };
    for (const fn of this._listeners) {
      try {
        fn(state);
      } catch (e) {
        // One bad subscriber must not stop the cursors moving.
        console.warn("exhibit transport: subscriber threw", e);
      }
    }
  }
}

/**
 * Build a `WindowedAudioPlayer` for one already-fetched recording.
 *
 * COPIED from `engine/normalization.js`'s `maybeBuildWindowedPlayer` — see
 * ENGINE-WANTS.md row 1. The copy exists only because that function reaches into
 * listen.js's `fileBlobs`, `waveformPeaks`, and its module-private AudioContext to
 * find its inputs; the fifteen lines that matter take a blob, an index, a context,
 * and a duration, and want nothing else. What the engine should expose is exactly
 * this free function.
 *
 * @param {Blob} blob
 * @param {ArrayBuffer} bytes  the same audio, for the frame-index scan
 * @param {{audioContext: AudioContext, duration: number, label: string}} opts
 */
export function buildWindowedPlayer(blob, bytes, { audioContext, duration, label }) {
  const index = analyzeAudio(bytes);
  if (!index) {
    // Not the expected path: the prep script writes VBR MP3, which is exactly the
    // case the windowed player exists for. Reaching here means the audio was
    // re-encoded to a format that seeks acceptably by itself (CBR MP3, WAV), so
    // an element is the correct player — but say so, because the exhibit's seek
    // accuracy silently changes tier at this point.
    console.warn(
      `exhibit: ${label} needs no accurate-seek index; using an <audio> element, ` +
        "so seeks are only as good as the container allows",
    );
    return new ElementPlayer(blob, duration);
  }
  const player = new WindowedAudioPlayer(blob, index, { audioContext, duration });
  // Calibrate in the background, exactly as listen.js does: until it lands (tens
  // of ms) seeks use the duration-difference heuristic, and awaiting it here would
  // add that latency to the visitor's first tap for no visible benefit.
  player.init();
  return player;
}

/**
 * The fallback for audio that does not need windowed seeking, in the four members
 * the transport actually uses. Deliberately tiny: it is a safety net for a
 * re-encode, not a second supported playback path, and anything more would be a
 * second implementation to keep in step with the first.
 */
class ElementPlayer {
  constructor(blob, duration) {
    this._el = new Audio(URL.createObjectURL(blob));
    this._el.preload = "auto";
    this._duration = duration;
  }
  get paused() {
    return this._el.paused;
  }
  get currentTime() {
    return this._el.currentTime;
  }
  set currentTime(t) {
    this._el.currentTime = t;
  }
  play() {
    return this._el.play();
  }
  pause() {
    this._el.pause();
  }
  destroy() {
    this._el.pause();
    URL.revokeObjectURL(this._el.src);
    this._el.removeAttribute("src");
  }
}
