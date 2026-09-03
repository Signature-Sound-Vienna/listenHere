// exhibit/turns.js
//
// Turn-taking: who gets to point the one shared clock (plan §4.3, and the
// central §1 feedback question). Two visitors face one screen with one audible
// recording between them, so "play my region" takes the room's audio — the
// question the user study exists to answer is what that taking should feel
// like, and this module is the three candidate answers behind one interface:
//
//   "hijack"       — the shipped behaviour: any tap takes the clock, silently.
//                    THE DEFAULT, so ?turnPolicy stays a pure opt-in and the
//                    baseline the variants are judged against is untouched.
//   "attribution"  — the same instant take, but announced: the side that lost
//                    the clock is told the other side changed the recording.
//   "request"      — a contended tap (the other side holds the clock AND audio
//                    is playing) becomes a REQUEST the holder grants or denies,
//                    auto-granting after `grantMs` so an absent visitor can
//                    never lock the table (0 disables the timeout).
//
// The policies differ ONLY in what happens between a tap and the transport —
// the machine is one class with the policy as data, not three classes, because
// the study panel flips ?turnPolicy live and three implementations of the
// shared bookkeeping would drift at exactly the seams being compared.
//
// This module also owns PER-VIEWPORT SELECTION ("I want to hear that one"):
// every tap records the tapping side's chosen recording, whether or not it won
// the clock, so each half can mark its own choice — under "request" that is
// what the requester sees highlighted while they wait. Selection is expressed
// desire; the transport's activeFile is audible truth.
//
// WHAT IS DELIBERATELY EXEMPT: the middle band's shared play/pause. The band
// is one surface read from both sides, so a tap on its shared control cannot
// be attributed to a viewport — it neither takes nor needs the turn, and a
// pause from it dissolves contention naturally (a paused clock is free to
// take). That exemption is ORIENTATION-AWARE since 0.52.0 (plan §11(f)): the
// MIRRORED band renders one copy of its facts per reader, so a tap on a fact
// in cluster i is reader i's by construction — `bandTapViewport` below is the
// one place that rule is written. An attributed fact tap still takes no turn:
// it opens that reader's own view (by-year, by-conductor), which is
// per-viewport state and never touches the clock. Under every other
// orientation the band stays unattributable and its facts are not tappable.
// Also designed-for but not built here: playhead-driven focus (the next
// increment) will drive annotation focus from this same clock, which is why
// holders and selections are per-viewport state here and not DOM state in
// main.js.
//
// ZERO imports, by rule (see ENGINE-WANTS.md) — the transport is injected.

export const TURN_POLICIES = ["hijack", "attribution", "request"];

/**
 * Which viewport a tap on the band's cluster `clusterIndex` belongs to, or
 * null when the band cannot say. Only "mirrored" can: middle-band.js builds
 * one cluster per facing reader in viewport order (the far copy rotated with
 * the far viewport), so the cluster index IS the viewport index. Upright,
 * rotated, and flip render a single cluster both readers share, and a tap on
 * it is nobody's in particular — the same reasoning that exempts the play
 * control, applied to the facts.
 *
 * @param {string} orientation   the RESOLVED band orientation (config.js)
 * @param {number} clusterIndex
 * @returns {number|null}
 */
export function bandTapViewport(orientation, clusterIndex) {
  if (orientation !== "mirrored") return null;
  const i = Number(clusterIndex);
  return Number.isInteger(i) && i >= 0 ? i : null;
}

export class TurnTaking {
  /**
   * @param {object} opts
   * @param {object} opts.transport  the exhibit Transport (audio.js). Held as an
   *   object and dereferenced per call, so a test that wraps `transport.select`
   *   (spec 35's armTapRecorder) still sees every call this machine makes.
   * @param {string} [opts.policy]   one of TURN_POLICIES; unknown values warn
   *   and fall back to "hijack" rather than leaving the exhibit tap-dead.
   * @param {number} [opts.grantMs]  request policy: auto-grant a pending request
   *   after this many ms; 0 means explicit grant only.
   * @param {number} [opts.denyCooldownMs] request policy: after a denial, the
   *   denied side's taps are not put to the holder again for this many ms —
   *   they are answered with the "still listening" notice instead (user,
   *   2026-09-03: minimise request-spamming); 0 = ask again at once.
   */
  constructor({ transport, policy = "hijack", grantMs = 8000, denyCooldownMs = 0 }) {
    this._transport = transport;
    if (!TURN_POLICIES.includes(policy)) {
      console.warn(`exhibit turns: unknown policy "${policy}" — using "hijack"`);
      policy = "hijack";
    }
    this.policy = policy;
    this._grantMs = Math.max(0, Number(grantMs) || 0);
    this._cooldownMs = Math.max(0, Number(denyCooldownMs) || 0);

    /** Viewport index that last took the clock; null until the first tap. */
    this.holder = null;
    /** The queued contended tap, or null. */
    this.pending = null; // { viewport, file, seekTime, expiresAt }
    /** Per-viewport last-chosen recording (sparse; index = viewport). */
    this.selected = [];
    /** Per-viewport end of a denial's cooldown (ms epoch), while one runs. */
    this.cooldownUntil = {};

    this._timer = 0;
    this._listeners = new Set();
  }

  /** Subscribe to (state, event) notifications; returns an unsubscribe. */
  subscribe(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  /**
   * A tap: `viewport` wants `file` audible. The seek-vs-switch rule lives HERE,
   * captured at tap time: a tap on the already-active strip means "this moment"
   * and keeps its tapped time, while a tap on any other strip means "this
   * recording" and carries the musical moment across at execution time
   * (transport._carryOver) — under "request" that execution may be seconds
   * later, and applying a switch-tap's finger position then would jump tens of
   * seconds to wherever the finger happened to land (see main.js's onSelect
   * note, which this rule moved out of).
   *
   * @param {number} viewport
   * @param {string} file
   * @param {number} [time] seconds in `file`'s own timeline, from the tap
   */
  request(viewport, file, time) {
    const seekTime =
      file === this._transport.activeFile && Number.isFinite(time) ? time : undefined;
    this._tap(viewport, file, seekTime);
  }

  /**
   * A JUMP: a tap whose time is MEANINGFUL on another recording — the detail
   * header's "Jump to annotation" carries a region start in `file`'s own
   * timeline, unlike a finger position on a different strip. The
   * seek-vs-switch rule above therefore does not apply: the time is honoured
   * across a recording switch, and the pending-request capture keeps it, so
   * a contended jump granted seconds later still lands on the annotation.
   * (Ruled 2026-08-25; precedence: explicit time > carried moment.)
   *
   * @param {number} viewport
   * @param {string} file
   * @param {number} time seconds in `file`'s own timeline
   */
  jump(viewport, file, time) {
    this._tap(viewport, file, Number.isFinite(time) ? time : undefined);
  }

  _tap(viewport, file, seekTime) {
    this.selected[viewport] = file;

    const contended =
      this.policy === "request" &&
      this.holder != null &&
      this.holder !== viewport &&
      this._transport.playing;

    if (!contended) {
      const from = this.holder;
      this._take(viewport, file, seekTime);
      // Announced only under "attribution", and only when the clock actually
      // changed hands — a side re-tapping its own strips has nothing to be
      // told. NOT gated on `playing`: a holder who paused to read and comes
      // back to a different recording deserves the explanation too.
      const taken =
        this.policy === "attribution" && from != null && from !== viewport
          ? { type: "taken", from, to: viewport }
          : null;
      this._emit(taken);
      return;
    }

    // A denied side waits out the cooldown: its taps are not put to the holder
    // again — no prompt, so a denial cannot be spammed — the requester is just
    // told once more that the other side is still listening. The tap has
    // still marked their choice on their own half (selected, above).
    const until = this.cooldownUntil[viewport] || 0;
    if (until > Date.now()) {
      this._emit({ type: "cooldown", to: viewport, until });
      return;
    }

    // Contended: queue the tap. One pending at a time and the LATEST tap wins,
    // the same last-tap-counts rule the transport applies to racing fetches.
    this._clearTimer();
    this.pending = {
      viewport,
      file,
      seekTime,
      expiresAt: this._grantMs ? Date.now() + this._grantMs : null,
    };
    if (this._grantMs) this._timer = setTimeout(() => this.grant(), this._grantMs);
    this._emit({ type: "requested", from: viewport, to: this.holder });
  }

  /** Execute the pending request — the holder's ✓, or the auto-grant timeout. */
  grant() {
    if (!this.pending) return;
    const { viewport, file, seekTime } = this.pending;
    this.pending = null;
    this._clearTimer();
    delete this.cooldownUntil[viewport];
    this.holder = viewport;
    this._transport.select(file, seekTime);
    this._emit({ type: "granted", to: viewport });
  }

  /** Dismiss the pending request; the requester is told, and can tap again. */
  deny() {
    if (!this.pending) return;
    const requester = this.pending.viewport;
    this.pending = null;
    this._clearTimer();
    this._startCooldown(requester);
    this._emit({ type: "denied", to: requester });
  }

  /** A snapshot for renderers and tests; arrays copied so nobody edits ours. */
  state() {
    return {
      policy: this.policy,
      holder: this.holder,
      pending: this.pending ? { ...this.pending } : null,
      selected: this.selected.slice(),
      cooldownUntil: { ...this.cooldownUntil },
    };
  }

  // ---- internals -----------------------------------------------------------

  _take(viewport, file, seekTime) {
    // Any successful take dissolves a pending request: leaving it armed would
    // let the auto-grant fire minutes later against a holder who never saw a
    // prompt. If someone ELSE was waiting, their wait just became a denial —
    // the holder tapping their own strips while a request stands is the
    // implicit "not yet".
    if (this.pending && this.pending.viewport !== viewport) {
      const stale = this.pending.viewport;
      this.pending = null;
      this._clearTimer();
      this._startCooldown(stale);
      this._emit({ type: "denied", to: stale });
    } else if (this.pending) {
      this.pending = null;
      this._clearTimer();
    }
    delete this.cooldownUntil[viewport];
    this.holder = viewport;
    this._transport.select(file, seekTime);
  }

  /** A denial starts the denied side's cooldown, when one is configured. */
  _startCooldown(viewport) {
    if (this._cooldownMs) this.cooldownUntil[viewport] = Date.now() + this._cooldownMs;
  }

  _clearTimer() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = 0;
  }

  _emit(event = null) {
    const state = this.state();
    for (const fn of this._listeners) {
      try {
        fn(state, event);
      } catch (e) {
        // One bad subscriber must not make the table tap-dead.
        console.warn("exhibit turns: subscriber threw", e);
      }
    }
  }
}
