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
// TWO CLASSES, ONE MACHINE (the room machine, plan §4.4, 2026-09-11). Since
// 0.62.0 the four viewports of the museum's two screens share one clock and
// therefore ONE turn machine, hosted in the room's SharedWorker
// (room-worker.js), and the policies must not fork between "this screen" and
// "the room". So:
//
//   TurnMachine  — the PURE machine: holder, pending, cooldowns, selection,
//                  lastTake, the three policies. It touches no transport: a
//                  take is EMITTED as an `execute {viewport, file, seekTime}`
//                  event, and the one transport fact the policies read —
//                  is audio playing? — is an injected predicate. In the worker
//                  that predicate is "somebody in the room is audible"; in a
//                  window it is the window's transport. Viewports are ROOM ids
//                  (room.js roomViewportId): 0–3 for the two-screen table,
//                  equal to the local indices on a single screen.
//   TurnTaking   — the window's adapter, the interface main.js has always
//                  used (request/jump/grant/deny/reset, subscribe, state).
//                  With the room's worker it forwards intents there and
//                  renders the snapshots that come back, executing the takes
//                  addressed to the viewports THIS window owns; without it
//                  (room=off, or no SharedWorker) it hosts a TurnMachine of
//                  its own and executes every take — the pre-room behaviour,
//                  byte for byte.
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

/** The empty snapshot every renderer can paint from before a machine has spoken. */
function emptyState(policy) {
  return { policy, holder: null, pending: null, selected: {}, cooldownUntil: {}, lastTake: null };
}

/**
 * The pure turn machine. Hosted by TurnTaking in a window, or by
 * room-worker.js for the whole room. Emits `(state, event)` to subscribers;
 * the events are the ones the renderers have always had — taken, requested,
 * granted, denied, cooldown, reset — plus `execute`, the transport effect,
 * and `withdrawn`, a pending request whose viewport left the room.
 */
export class TurnMachine {
  /**
   * @param {object} opts
   * @param {string} [opts.policy]   one of TURN_POLICIES; unknown values warn
   *   and fall back to "hijack" rather than leaving the exhibit tap-dead.
   * @param {number} [opts.grantMs]  request policy: auto-grant a pending request
   *   after this many ms; 0 means explicit grant only.
   * @param {number} [opts.denyCooldownMs] request policy: after a denial, the
   *   denied side's taps are not put to the holder again for this many ms —
   *   they are answered with the "still listening" notice instead (user,
   *   2026-09-03: minimise request-spamming); 0 = ask again at once.
   * @param {() => boolean} [opts.playing]  is audio playing — the one transport
   *   fact the contended predicate reads (the room: is anybody audible).
   * @param {() => number} [opts.now]
   */
  constructor({ policy = "hijack", grantMs = 8000, denyCooldownMs = 0, playing = () => false, now = () => Date.now() } = {}) {
    this._playing = playing;
    this._now = now;
    this.configure({ policy, grantMs, denyCooldownMs });

    /** Viewport (room id) that last took the clock; null until the first tap. */
    this.holder = null;
    /** The queued contended tap, or null. */
    this.pending = null; // { viewport, file, seekTime, expiresAt }
    /** Per-viewport last-chosen recording: room id -> file. */
    this.selected = {};
    /** Per-viewport end of a denial's cooldown (ms epoch), while one runs. */
    this.cooldownUntil = {};
    /** The last take that reached the transport: {viewport, file, at} — so a
     *  switch cue can tell a side's own switch from one it only witnessed. */
    this.lastTake = null;

    this._timer = 0;
    this._listeners = new Set();
  }

  /**
   * (Re)configure the policy and its timings — the worker takes the newest
   * window's configuration, so a staff reload with another ?turnPolicy
   * changes the room's policy rather than forking it. Returns true if
   * anything changed.
   */
  configure({ policy = this.policy ?? "hijack", grantMs = this._grantMs ?? 8000, denyCooldownMs = this._cooldownMs ?? 0 } = {}) {
    if (!TURN_POLICIES.includes(policy)) {
      console.warn(`exhibit turns: unknown policy "${policy}" — using "hijack"`);
      policy = "hijack";
    }
    const next = [policy, Math.max(0, Number(grantMs) || 0), Math.max(0, Number(denyCooldownMs) || 0)];
    const changed = next[0] !== this.policy || next[1] !== this._grantMs || next[2] !== this._cooldownMs;
    [this.policy, this._grantMs, this._cooldownMs] = next;
    return changed;
  }

  /** Subscribe to (state, event) notifications; returns an unsubscribe. */
  subscribe(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  /**
   * A tap: `viewport` wants `file` audible, at `seekTime` if that is a number
   * (the adapter has already applied the seek-vs-switch rule — see
   * TurnTaking.request — so the machine never needs a transport to read).
   *
   * @param {number} viewport  room id
   * @param {string} file
   * @param {number} [seekTime] seconds in `file`'s own timeline, or undefined
   *   to carry the current musical moment across at execution time
   */
  tap(viewport, file, seekTime) {
    this.selected[viewport] = file;

    const contended =
      this.policy === "request" &&
      this.holder != null &&
      this.holder !== viewport &&
      this._playing();

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
    if (until > this._now()) {
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
      expiresAt: this._grantMs ? this._now() + this._grantMs : null,
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
    this.lastTake = { viewport, file, at: this._now() };
    this._emit({ type: "execute", viewport, file, seekTime });
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

  /**
   * The requester left the room (its window closed or is reloading): a request
   * nobody could execute is dropped — without a denial, so no cooldown greets
   * the window when it comes back.
   */
  withdraw(viewport) {
    if (!this.pending || this.pending.viewport !== viewport) return;
    this.pending = null;
    this._clearTimer();
    this._emit({ type: "withdrawn", from: viewport });
  }

  /**
   * The attract loop's sweep (attract.js): nobody holds the clock, nothing is
   * pending, no cooldown runs, no side has a choice marked. Emits, so the
   * prompts and the selection marks repaint from the empty state.
   */
  reset() {
    this._clearTimer();
    this.pending = null;
    this.holder = null;
    this.selected = {};
    this.cooldownUntil = {};
    this._emit({ type: "reset" });
  }

  /** A snapshot for renderers and tests; copied so nobody edits ours. */
  state() {
    return {
      policy: this.policy,
      holder: this.holder,
      pending: this.pending ? { ...this.pending } : null,
      selected: { ...this.selected },
      cooldownUntil: { ...this.cooldownUntil },
      lastTake: this.lastTake ? { ...this.lastTake } : null,
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
    this.lastTake = { viewport, file, at: this._now() };
    // The transport effect, as an event: the host that owns `viewport`'s window
    // selects the file. Emitted BEFORE the announcement that follows a take, so
    // the transport has moved when the renderers hear of it — the order the
    // in-process machine always had.
    this._emit({ type: "execute", viewport, file, seekTime });
  }

  /** A denial starts the denied side's cooldown, when one is configured. */
  _startCooldown(viewport) {
    if (this._cooldownMs) this.cooldownUntil[viewport] = this._now() + this._cooldownMs;
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

/**
 * The window's turn-taking: main.js's interface, over the room's shared
 * machine when there is one, over a machine of its own otherwise.
 */
export class TurnTaking {
  /**
   * @param {object} opts
   * @param {object} opts.transport  the exhibit Transport (audio.js). Held as an
   *   object and dereferenced per call, so a test that wraps `transport.select`
   *   (spec 35's armTapRecorder) still sees every call this machine makes.
   * @param {object} [opts.room]     room.js: when it carries the worker link, the
   *   machine is the room's and this adapter owns `room.viewportIds`.
   * @param {string} [opts.policy]   one of TURN_POLICIES
   * @param {number} [opts.grantMs]
   * @param {number} [opts.denyCooldownMs]
   */
  constructor({ transport, room = null, policy = "hijack", grantMs = 8000, denyCooldownMs = 0 }) {
    this._transport = transport;
    this._room = room;
    this._listeners = new Set();
    this._link = room?.worker ?? null;
    this._machine = null;
    this._snapshot = null;
    if (this._link) {
      // THE ROOM'S MACHINE. Intents go to the worker; every snapshot it
      // broadcasts is rendered here, and a take addressed to one of THIS
      // window's viewports is executed on this window's transport — the
      // grant lands on the taker's window wherever the holder pressed it.
      const owned = new Set(room.viewportIds ?? []);
      this._snapshot = emptyState(policy);
      this._warnedPolicy = false;
      this._link.onMessage((msg) => {
        if (msg.type !== "state" && msg.type !== "welcome") return;
        this._snapshot = msg.snapshot;
        if (!this._warnedPolicy && msg.snapshot.policy !== policy) {
          this._warnedPolicy = true;
          console.warn(
            `exhibit turns: the room runs turnPolicy "${msg.snapshot.policy}", this window asked for "${policy}" — the newest window's policy wins`,
          );
        }
        const event = msg.type === "welcome" ? null : msg.event ?? null;
        if (event?.type === "execute") {
          if (owned.has(event.viewport)) this._execute(event);
          return;
        }
        if (event?.type === "revoked") return; // the arbiter's, not ours (arbiter.js RoomArbiter)
        this._fan(event);
      });
    } else {
      this._machine = new TurnMachine({
        policy,
        grantMs,
        denyCooldownMs,
        playing: () => this._transport.playing,
      });
      this._machine.subscribe((state, event) => {
        if (event?.type === "execute") {
          this._execute(event);
          return;
        }
        this._fan(event);
      });
    }
  }

  /**
   * The transport effect of a take on THIS window. A window that has been
   * mirroring the room muted (room.js) sounds when its take executes — the
   * grant may land seconds after the requester's touch, and another window's
   * touch may have taken the speakers meanwhile — so the unmute is here, at
   * the take, not only at the touch. The room's hand-off then has the previous
   * audible window fade out and follow.
   */
  _execute({ file, seekTime }) {
    if (this._room && this._transport.muted) this._room.unmute();
    this._transport.select(file, seekTime);
  }

  /** True when the machine is the room's (room-worker.js), not this window's. */
  get shared() {
    return this._link != null;
  }
  get policy() {
    return this.state().policy;
  }
  get holder() {
    return this.state().holder;
  }
  get pending() {
    return this.state().pending;
  }
  get selected() {
    return this.state().selected;
  }
  get lastTake() {
    return this.state().lastTake;
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
   * @param {number} viewport  room id
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
   * @param {number} viewport  room id
   * @param {string} file
   * @param {number} time seconds in `file`'s own timeline
   */
  jump(viewport, file, time) {
    this._tap(viewport, file, Number.isFinite(time) ? time : undefined);
  }

  /** Execute the pending request — the holder's ✓, or the auto-grant timeout. */
  grant() {
    if (this._link) this._link.send({ type: "grant" });
    else this._machine.grant();
  }

  /** Dismiss the pending request; the requester is told, and can tap again. */
  deny() {
    if (this._link) this._link.send({ type: "deny" });
    else this._machine.deny();
  }

  /** The attract loop's sweep: the machine back to its empty state (room-wide under the worker). */
  reset() {
    if (this._link) this._link.send({ type: "reset" });
    else this._machine.reset();
  }

  /** A snapshot for renderers and tests. */
  state() {
    if (this._machine) return this._machine.state();
    const s = this._snapshot;
    return {
      policy: s.policy,
      holder: s.holder,
      pending: s.pending ? { ...s.pending } : null,
      selected: { ...(s.selected ?? {}) },
      cooldownUntil: { ...(s.cooldownUntil ?? {}) },
      lastTake: s.lastTake ? { ...s.lastTake } : null,
    };
  }

  // ---- internals -----------------------------------------------------------

  _tap(viewport, file, seekTime) {
    if (this._link) this._link.send({ type: "tap", viewport, file, seekTime });
    else this._machine.tap(viewport, file, seekTime);
  }

  _fan(event) {
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
