// exhibit/room.js
//
// THE ROOM: the channel the windows of one PC share, and the CLOCK that runs on
// it (plan §4.4 — ruling R7 in full, and the room machine planned 2026-09-11 for
// 0.62.0). Two screens of one table share one set of speakers, so "what the room
// hears" is a room fact, and this module is where a window learns it and follows
// it. It grew out of attract.js, whose v2 (0.60.0) mirrored the audible window
// only while a screen was idle under its band; the room machine makes the mirror
// UNIVERSAL — every non-audible window follows the audible one, band or no band —
// so a take anywhere carries over from the moment the room is at, and the screen
// that loses the speakers mutes and follows instead of falling silent.
//
// WHAT RUNS HERE
//   * The channel (`post`/`onMessage`): one BroadcastChannel per window, one
//     stable id per tab, every message stamped with the sender's id, screen, and
//     time. attract.js is a subscriber (presence, activity, the pass, the gap).
//   * The SYNC: whichever window is AUDIBLE — playing and not muted — says where
//     it is once a second and once more when it stops.
//   * The MIRROR: a non-audible window plays the same file MUTED at the same
//     moment, re-seeking past DRIFT_S of drift. A mirror is a running player, so
//     the hand-off is an unmute, never a start — the ruling's instant take.
//   * The HAND-OFF: any touch on a muted window fades it in over FADE_MS
//     (`touch`/`unmute`); main.js sees the audible edge and claims the speakers;
//     the arbiter's revoke on the other window lands in `yieldAudio`, which
//     mutes it over the same fade and keeps it following (a crossfade of one
//     performance from one screen to the other, not a cut).
//   * THE LINK TO THE ROOM'S MACHINE (`worker`; room-worker.js, a SharedWorker
//     under `?room=shared`): the turn state and the speakers for every window
//     of the PC. This module only connects it — turns.js and arbiter.js speak
//     over the link. Its URL carries ROOM_PROTOCOL, so a code change gets a
//     fresh worker by construction; the worker's `welcome` echoes the version.
//     No SharedWorker (or a failed one) means turns stay per screen, with a
//     warning — the screens still mirror. This window pings the worker every
//     PING_MS (protocol 2): a window silent for 15 s is expired there as if it
//     had said bye, so a crashed window's claim on the speakers dies with it.
//
// WHEN IT RUNS. `?room=shared` is the room machine: the mirror is universal and
// the arbiter is room-wide. Under `room=off` (the shipped default) this module
// still carries the channel and the clock for the attract loop, exactly as v2
// did — the mirror and the yield are gated on the loop's band being up — and
// without the loop configured it is INERT: no channel, no listeners, no sync,
// so the shipped single kiosk is byte-for-byte unchanged (the A/B rule).
//
// The audience follows the sync ONLY on an idle screen (band up): a live table's
// readers chose their own annotations, and the room's clock is not entitled to
// change them (ruled: audience per viewport, set only by the loop while idle).
//
// ZERO imports, by rule (see ENGINE-WANTS.md).

const CHANNEL = "lh-exhibit-room";
const ID_KEY = "lh-exhibit-room-id";
const WORKER_URL = "./room-worker.js";
const WORKER_NAME = "lh-exhibit-room";
/** The worker protocol: bump it when the intents or the snapshot change shape. */
export const ROOM_PROTOCOL = 2;
const SYNC_MS = 1000;   // how often the audible window says where it is
const PING_MS = 5000;   // the heartbeat to the room's worker; silent 15 s = gone (room-worker.js)
const DRIFT_S = 0.1;    // a mirror further off than this re-seeks
const FADE_MS = 200;    // the hand-off crossfade, both directions
const PEER_SYNC_TTL_MS = 2500; // a peer's "playing" sync older than this no longer counts

/** Query-string values config.room accepts. */
export const ROOM_MODES = ["off", "shared"];

/**
 * The ROOM id of a window's local viewport `i`: screen × viewports + i, so every
 * viewport in a room of same-shaped screens has one stable number (0–3 for the
 * two-screen table). Every window of a room is assumed to run the same
 * `viewports`, which the one-PC arrangement guarantees by construction.
 */
export function roomViewportId(config, i) {
  const screen = Math.max(0, Math.round(Number(config.screen) || 0));
  return screen * Math.max(1, Math.round(Number(config.viewports) || 1)) + i;
}

/**
 * The angle (degrees, CSS-clockwise) a ghost of `source`'s marker is turned by
 * on `viewer`'s half so that its HILT POINTS AT THE SOURCE (ruled 2026-09-10,
 * user: "effectively pointing to the source viewport"). 0 is the handle down,
 * toward the viewer. Expressed in the VIEWER's own frame and applied inside
 * their already-rotated half, so the world conversion is implicit:
 *
 *   the reader across my table       → 180  (the handle away from me)
 *   the far table's same-side reader → a DOWN-diagonal toward that table
 *   the far table's opposite reader  → an UP-diagonal toward that table
 *
 * Never horizontal: a handle along a waveform would read as a time span.
 * Screens are numbered along the UPRIGHT reader's right hand (`screenOrder`
 * "ltr"; "rtl" the reverse); a rotated reader sees them the other way round.
 * Both screens are assumed to stand the same way round (viewport 0 at the
 * same edge), so "same side" is "same local index".
 */
export function ghostAngleFor(config, viewer, source) {
  const n = Math.max(1, Math.round(Number(config.viewports) || 1));
  const myScreen = Math.floor(viewer / n);
  const i = viewer % n;
  const srcScreen = Math.floor(source / n);
  const j = source % n;
  if (myScreen === srcScreen) return j === i ? 0 : 180;
  const rotated = ((((Number(config.rotations?.[i]) || 0) % 360) + 360) % 360) === 180;
  const rtl = config.screenOrder === "rtl";
  // Does the source's screen stand to THIS reader's right?
  const right = (srcScreen > myScreen) !== rotated !== rtl;
  const up = j !== i;
  // CSS rotate() is clockwise: from "down", a negative angle turns the handle
  // toward the right, a positive one toward the left.
  return (up ? 135 : 45) * (right ? -1 : 1);
}

/**
 * @param {object} opts
 * @param {object} opts.config      the resolved exhibit config
 * @param {object} opts.transport   audio.js Transport
 * @param {object} opts.store       AudienceStore (audience.js)
 * @param {object[]} opts.viewports main.js viewport records (index)
 * @param {object} opts.exhibit     ExhibitData (payload.js): audio per file
 * @param {() => number} [opts.now]
 */
export function createRoom({ config, transport, store, viewports, exhibit, now = () => Date.now() }) {
  let mode = config.room ?? "off";
  if (!ROOM_MODES.includes(mode)) {
    console.warn(`exhibit room: unknown mode "${mode}" — using "off"`);
    mode = "off";
  }
  const shared = mode === "shared";
  const loopConfigured = (Number(config.attractAfterIdleMs) || 0) > 0;
  const haveChannel = typeof BroadcastChannel === "function";
  if (shared && !haveChannel) {
    console.warn("exhibit room: BroadcastChannel unavailable — the screens run independently");
  }
  // Inert unless something needs the room: the room machine, or the loop.
  const active = haveChannel && (shared || loopConfigured);
  const universal = shared && active;
  const screen = Math.max(0, Math.round(Number(config.screen) || 0));

  // A stable id per TAB, so a window keeps its identity across its own reloads
  // (the loop's leader stays the leader through the reload in the gap).
  let id;
  try {
    id = sessionStorage.getItem(ID_KEY);
    if (!id) {
      id = crypto.randomUUID?.() ?? `screen-${Math.random().toString(36).slice(2)}`;
      sessionStorage.setItem(ID_KEY, id);
    }
  } catch (_) {
    id = crypto.randomUUID?.() ?? `screen-${Math.random().toString(36).slice(2)}`;
  }

  // ---- state -----------------------------------------------------------------
  let mirroring = false;     // this window plays the room's audible state MUTED
  let lastSync = null;       // the latest peer sync {file, time, playing, audience, piece, sentAt, at, from}
  let mirrorPending = null;  // a mirror's select in flight (a build can take a second)
  let idleGate = () => false; // attract.js: this screen is idle under its band
  let vetoGate = () => false; // attract.js: playback is refused here ("locked")
  const peerSyncs = new Map(); // id -> {playing, at}
  const messageSubs = new Set();
  const touchSubs = new Set();
  const refusedSubs = new Set();

  // ---- the channel -------------------------------------------------------------
  const bc = active ? new BroadcastChannel(CHANNEL) : null;
  // `detached` (a debug seam, see detach()): this window has "crashed" — it
  // says nothing more on either the channel or the worker's port.
  let detached = false;
  const post = (msg) => {
    if (!detached) bc?.postMessage({ ...msg, id, screen, t: now() });
  };
  if (bc) {
    bc.onmessage = (e) => {
      const msg = e.data;
      if (!msg || msg.id === id) return;
      if (msg.type === "sync") onSync(msg);
      for (const fn of messageSubs) {
        try {
          fn(msg);
        } catch (err) {
          console.warn("exhibit room: message subscriber threw", err);
        }
      }
    };
  }

  // ---- the sync ------------------------------------------------------------------
  /** This window is on the speakers: playing and not muted. */
  const audible = () => transport.playing && !transport.muted;
  /** Where the room's sound is — posted by the audible window only. */
  const postSync = () =>
    post({
      type: "sync",
      file: transport.activeFile,
      time: transport.time,
      playing: audible(),
      audience: store.get(viewports[0]?.index ?? 0) ?? null,
      piece: config.piece,
    });
  const syncTimer = active
    ? setInterval(() => {
        if (audible()) postSync();
      }, SYNC_MS)
    : 0;
  // The moment this window's sound stops, say so, so a mirror stops with it
  // rather than a second late.
  let wasAudible = audible();
  const unsubscribeTransport = active
    ? transport.subscribe((state) => {
        const nowAudible = state.playing && !state.muted;
        if (wasAudible && !nowAudible) postSync();
        wasAudible = nowAudible;
      })
    : () => {};

  // ---- the mirror ----------------------------------------------------------------
  function onSync(msg) {
    lastSync = {
      file: msg.file,
      time: Number(msg.time) || 0,
      playing: Boolean(msg.playing),
      audience: msg.audience ?? null,
      piece: msg.piece ?? null,
      sentAt: Number(msg.t) || now(),
      at: now(),
      from: msg.id,
    };
    peerSyncs.set(msg.id, { playing: lastSync.playing, at: lastSync.at });
    mirror(lastSync);
  }

  /** Whether this window may follow the room right now. */
  const mayMirror = () => (universal || idleGate()) && !vetoGate();

  /**
   * Follow the room's audible state MUTED: the same file at the same moment, so
   * whoever taps here walks into the performance the room is hearing and the
   * unmute is instant. Annotations, text, and the band derive from the clock, so
   * they mirror for free; the audience is the one extra field, and only an idle
   * screen takes it. Re-seeks only past DRIFT_S — a seek restarts a decoded
   * chunk, and once a second is plenty for a muted cursor.
   */
  function mirror(s) {
    if (!s || !exhibit.audio[s.file]) return;
    if (s.piece && s.piece !== config.piece) return; // another payload; the reload cycle catches up
    if (audible()) return; // this window IS the room's sound — the arbiter decides, not the mirror
    if (!s.playing) {
      // The room's sound stopped: so does the mirror, and this window follows
      // nothing until the next sync says otherwise. The mute stays — a touch
      // here lifts it, and so does the loop's own pass (attract.js runPass).
      stopMirror({ pause: true });
      return;
    }
    if (!mayMirror()) return;
    if (!mirroring) {
      mirroring = true;
      transport.setMuted(true);
    }
    const target = s.time + Math.max(0, now() - s.sentAt) / 1000;
    if (transport.activeFile !== s.file || !transport.playing) {
      // One select at a time: while a build is in flight the next sync re-aims.
      if (mirrorPending) return;
      mirrorPending = transport.select(s.file, target).then(
        () => {
          mirrorPending = null;
        },
        (e) => {
          mirrorPending = null;
          refused(e);
        },
      );
    } else if (Math.abs(transport.time - target) > DRIFT_S) {
      transport.seek(target);
    }
    if (idleGate() && s.audience && store.get(viewports[0]?.index ?? 0) !== s.audience) {
      for (const vp of viewports) store.set(vp.index, s.audience);
    }
  }

  /** Stop following; optionally pause what the mirror was playing. The mute stays. */
  function stopMirror({ pause = false } = {}) {
    if (pause && mirroring && transport.playing) transport.pause();
    mirroring = false;
  }

  /** The tap on a muted window: this copy fades in and becomes the room's sound. */
  function unmute() {
    mirroring = false;
    transport.setMuted(false, { fadeMs: FADE_MS });
  }

  function refused(e) {
    if (!refusedSubs.size) {
      console.warn("exhibit room: the mirror's playback was refused", e?.name || e);
    }
    for (const fn of refusedSubs) fn(e);
  }

  // ---- interaction ---------------------------------------------------------------
  /**
   * A visitor touched this window. The subscribers hear of it FIRST — the loop
   * ends its scheduling and lowers its band — and only then does the hand-off
   * fade this copy in: main.js claims the speakers on the audible edge with the
   * loop's kind while a pass drives the transport, so the unmute must land after
   * the loop has stood down, or a visitor's touch would claim as the loop and
   * lose to a visitor at the other table.
   */
  function touch() {
    link?.send({ type: "activity" }); // the room's clock of touches (protocol 2)
    for (const fn of touchSubs) {
      try {
        fn();
      } catch (err) {
        console.warn("exhibit room: touch subscriber threw", err);
      }
    }
    if (transport.muted) unmute();
  }
  const onInteract = (e) => {
    if (e.isTrusted === false && !e.detail?.attractTest) return;
    // The study panel is staff tooling, not a visitor: its taps are nobody's.
    // The turn prompt's buttons are the holder ANSWERING another viewport's
    // request, not arriving at the table: pressing "Go ahead" on a muted window
    // must not fade it in a moment before the granted take executes elsewhere
    // (turns.js unmutes the executing window instead).
    if (e.target?.closest?.(".study-panel, .study-cog, .vp-turn")) return;
    touch();
  };
  if (active) {
    window.addEventListener("pointerdown", onInteract, true);
    window.addEventListener("keydown", onInteract, true);
  }

  /** Another window's music is on the speakers, by its own recent sync. */
  const peerAudible = () => {
    const cutoff = now() - PEER_SYNC_TTL_MS;
    for (const p of peerSyncs.values()) if (p.playing && p.at >= cutoff) return true;
    return false;
  };

  // ---- the room's machine ----------------------------------------------------------
  // The room ids of this window's viewports: what it owns in the room's snapshots.
  const viewportIds = viewports.map((vp) => vp.roomId ?? vp.index);
  let link = null;
  let roomSnapshot = null; // the worker's latest snapshot (turns + audible + windows), for state()
  if (universal) {
    if (typeof SharedWorker !== "function") {
      console.warn("exhibit room: SharedWorker unavailable — turns stay per screen");
    } else {
      try {
        const sw = new SharedWorker(`${WORKER_URL}?v=${ROOM_PROTOCOL}`, { type: "module", name: WORKER_NAME });
        const workerSubs = new Set();
        let welcomed = false;
        sw.port.onmessage = (e) => {
          const msg = e.data;
          if (!msg) return;
          if (msg.snapshot) roomSnapshot = msg.snapshot;
          if (msg.type === "welcome") {
            welcomed = true;
            if (msg.protocol !== ROOM_PROTOCOL) {
              console.warn(
                `exhibit room: the worker speaks protocol ${msg.protocol}, this window ${ROOM_PROTOCOL} — reload every window`,
              );
            }
          }
          for (const fn of workerSubs) {
            try {
              fn(msg);
            } catch (err) {
              console.warn("exhibit room: worker subscriber threw", err);
            }
          }
        };
        sw.onerror = (e) => console.warn("exhibit room: worker error", e?.message || e);
        sw.port.start();
        const send = (msg) => {
          if (!detached) sw.port.postMessage(msg);
        };
        send({
          type: "hello",
          id,
          screen,
          viewports: viewportIds,
          protocol: ROOM_PROTOCOL,
          policy: config.turnPolicy,
          grantMs: config.turnGrantMs,
          denyCooldownMs: config.turnDenyCooldownMs,
          // The loop's facts the worker keeps (protocol 2): the newest window's
          // idle window wins, as its turn policy does.
          lastActivity: now(),
          idleMs: Math.max(0, Number(config.attractAfterIdleMs) || 0),
        });
        const bye = () => send({ type: "bye" });
        window.addEventListener("pagehide", bye);
        const pingTimer = setInterval(() => send({ type: "ping" }), PING_MS);
        link = {
          send,
          onMessage(fn) {
            workerSubs.add(fn);
            return () => workerSubs.delete(fn);
          },
          get welcomed() {
            return welcomed;
          },
          /** Stop the heartbeat and the pagehide bye (detach(), below). */
          _detach() {
            clearInterval(pingTimer);
            window.removeEventListener("pagehide", bye);
          },
        };
      } catch (e) {
        console.warn("exhibit room: SharedWorker failed — turns stay per screen", e);
      }
    }
  }

  return {
    /** The channel is open (the room machine, or the loop, is configured). */
    active,
    /** The mirror is universal: every non-audible window follows (`?room=shared`). */
    universal,
    id,
    screen,
    /** The room ids of this window's viewports. */
    viewportIds,
    /** The link to the room's SharedWorker ({send, onMessage, welcomed}), or null. */
    worker: link,
    /** The worker's latest snapshot (turns, speakers, windows, leader, loop), or null. */
    get snapshot() {
      return roomSnapshot;
    },
    /**
     * The room's LEADER by the worker's registry — the LIVE window on the
     * lowest screen (ties by id; the worker expires a window silent for 15 s,
     * so a crash without bye leaves the registry within that) — or null
     * without a worker or before its first snapshot.
     */
    leaderId() {
      return roomSnapshot?.leader ?? null;
    },
    /**
     * A DEBUG seam (spec 47.22): this window falls silent as a crashed one
     * would — no heartbeat, no sync, no activity, and no bye at pagehide, on
     * the channel or to the worker — so the room's expiry can be exercised.
     */
    detach() {
      detached = true;
      link?._detach();
    },
    post,
    /** Every message from OTHER windows, sync included; returns an unsubscribe. */
    onMessage(fn) {
      messageSubs.add(fn);
      return () => messageSubs.delete(fn);
    },
    /** A visitor's touch on this window (after the hand-off has run); returns an unsubscribe. */
    onTouch(fn) {
      touchSubs.add(fn);
      return () => touchSubs.delete(fn);
    },
    /** The mirror's playback was refused (a blocked audio context); returns an unsubscribe. */
    onRefused(fn) {
      refusedSubs.add(fn);
      return () => refusedSubs.delete(fn);
    },
    /**
     * attract.js's two facts about this screen: `idle` — the band is up, so the
     * mirror runs even under room=off and the audience follows; `veto` —
     * playback is refused here, so a mirror must not keep trying.
     */
    setGates({ idle, veto } = {}) {
      if (idle) idleGate = idle;
      if (veto) vetoGate = veto;
    },
    get mirroring() {
      return mirroring;
    },
    get lastSync() {
      return lastSync;
    },
    audible,
    peerAudible,
    touch,
    unmute,
    stopMirror,
    /**
     * The arbiter took the speakers from this window. Under the room machine
     * — or, under room=off, on an idle screen with its band up — the performance
     * keeps running MUTED and this window follows the new audible one: handled,
     * true. Otherwise false, and main.js pauses the table as before.
     */
    yieldAudio() {
      if (!transport.playing) return false;
      if (!(universal || idleGate())) return false;
      mirroring = true;
      transport.setMuted(true, { fadeMs: FADE_MS });
      return true;
    },
    /** A snapshot for renderers and tests. */
    state() {
      return {
        mode,
        active,
        universal,
        worker: link != null,
        welcomed: link?.welcomed ?? false,
        detached,
        snapshot: roomSnapshot,
        id,
        screen,
        viewportIds: viewportIds.slice(),
        mirroring,
        muted: transport.muted,
        audible: audible(),
        peerAudible: peerAudible(),
        lastSync: lastSync
          ? { file: lastSync.file, time: lastSync.time, playing: lastSync.playing, ageMs: now() - lastSync.at }
          : null,
      };
    },
    destroy() {
      if (syncTimer) clearInterval(syncTimer);
      link?._detach();
      unsubscribeTransport();
      window.removeEventListener("pointerdown", onInteract, true);
      window.removeEventListener("keydown", onInteract, true);
      bc?.close();
      messageSubs.clear();
      touchSubs.clear();
      refusedSubs.clear();
    },
  };
}
