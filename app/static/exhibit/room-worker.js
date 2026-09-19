// exhibit/room-worker.js
//
// THE ROOM'S MACHINE (plan §4.4, the room machine planned 2026-09-11 for
// 0.62.0). A SharedWorker: one instance per origin, shared by every window of
// the museum PC, alive as long as any of them is connected. It hosts the one
// thing the four viewports of the two screens must agree on — the TURN STATE
// (turns.js TurnMachine: holder, pending request, cooldowns, selections,
// lastTake) — and, since the contended predicate is "is the room audible?",
// the SPEAKERS too: which window sounds, as which kind, with the broadcast
// arbiter's one ranking (a visitor outranks the loop).
//
// The windows send INTENTS and receive SNAPSHOTS: after every change the whole
// state goes to every window with the event that caused it, and a take is an
// `execute` event that the window OWNING the taking viewport acts on — so a
// grant pressed on the holder's screen starts the recording on the requester's
// screen, and every other window follows it through the room's clock (room.js).
//
// WHY A WORKER AND NOT A LEADER WINDOW (decided with the user 2026-09-10): a
// leader would need an election and a hand-over across the loop's reload in
// the gap; the worker survives either window's reload as long as the other
// stays connected (the reloads are staggered for exactly that), and it dies
// with the last window — the state is idle by then anyway. The worker's URL
// carries the protocol version (room.js), so a code change gets a fresh
// worker by construction; the `welcome` echoes the version as belt and braces.
//
// PRESENCE AND THE LOOP'S FACTS (0.64.0, planned 2026-09-16 — "the loop as
// the machine's idle case"). Every message stamps the sender's `lastSeen`;
// room.js pings every 5 s, and a window silent for longer than WINDOW_TTL_MS
// is EXPIRED as if it had said bye — the speakers cleared if it held them,
// its pending request withdrawn, its markers dropped — which closes the
// 0.62.0 hole where a crashed audible window's stale claim outranked the
// loop's for ever. The MessagePort `close` event is deliberately not relied
// on (unverified in Firefox). The snapshot names the LEADER (the lowest LIVE
// screen, ties by id), and — increment 3 — the room's `loop` facts: quiet
// since the latest touch, idle, the pass count, the gap. The verdict is the
// worker's; what to do about it (take over, pass, rest) is each window's.
//
// It also holds the room's LISTENING MARKERS (marker.js): each viewport's
// anchored moment, so every reader's ghosts can show the other three's
// (main.js turns them into oriented ghosts). What the worker deliberately does
// NOT hold: the clock (room.js posts the audible window's sync on the
// BroadcastChannel — high-frequency fan-out with no state to keep) and the
// attract loop's pass (attract.js).
//
// Runs as a MODULE worker so it can import the machine the windows use —
// the same class, not a copy (verified in both Playwright browsers 2026-09-11).

import { TurnMachine } from "./turns.js";
import { claimRank } from "./arbiter.js";
import { ROOM_PROTOCOL } from "./room.js";

/** A window silent this long (no message, no ping) has closed or crashed. */
const WINDOW_TTL_MS = 15000;
/** How often the registry is swept for expired windows. */
const SWEEP_MS = 5000;

/** Connected windows: port -> {id, screen, viewports (room ids), lastSeen, lastActivity}. */
const windows = new Map();
/**
 * Windows that left, by their stable tab id (room.js keeps one per tab across
 * its own reloads): id -> {lastActivity, at}. A window reloading in the loop's
 * gap says bye and hellos again a second later; were its hello stamped as a
 * touch, the room would count as in use for the whole idle window and a
 * visitor's touch on the other screen during the next pass would wake nobody.
 * So a returning id gets its clock back; a genuinely new window is stamped now.
 */
const departed = new Map();
const DEPARTED_TTL_MS = 120000;
/** The room's turn machine, created by the first hello. */
let machine = null;
/** Who is on the speakers: {port, id, kind, screen} or null. */
let audible = null;
/** The listening markers: room viewport id -> {ix, file} (marker.js). */
const markers = new Map();

/**
 * THE LOOP'S FACTS (attract.js reads them through its presence seam):
 *   idleMs      the attract loop's idle window, from the newest hello (0 = no loop)
 *   quietSince  the latest touch anywhere in the room (a hello counts as one)
 *   idle        idleMs > 0 and the room quiet for at least idleMs — nothing
 *               about audibility: each window decides take-over / pass / rest
 *   passCount   passes the loop has completed (the gap reports increment it)
 *   gap         {endsAt} while the room is in the silence between passes
 */
const loop = { idleMs: 0, quietSince: 0, idle: false, passCount: 0, gap: null };
const TICK_MS = 1000;
let tickTimer = 0;

/** The leader: the connected window on the lowest screen, ties by id; null with no windows. */
function leaderOf() {
  let best = null;
  for (const w of windows.values()) {
    if (!best || w.screen < best.screen || (w.screen === best.screen && w.id < best.id)) best = w;
  }
  return best ? best.id : null;
}

/** The latest touch anywhere in the room; 0 with no windows. */
function quietSinceOf() {
  let q = 0;
  for (const w of windows.values()) q = Math.max(q, w.lastActivity);
  return q;
}

const snapshotOf = () => ({
  ...machine.state(),
  markers: Object.fromEntries(markers),
  audible: audible ? { id: audible.id, kind: audible.kind, screen: audible.screen } : null,
  leader: leaderOf(),
  loop: { quietSince: loop.quietSince, idle: loop.idle, passCount: loop.passCount, gap: loop.gap ? { ...loop.gap } : null },
  windows: [...windows.values()].map((w) => ({
    id: w.id,
    screen: w.screen,
    viewports: w.viewports.slice(),
    lastActivity: w.lastActivity,
  })),
});

/**
 * The once-a-second tick, running only while some window has the loop
 * configured. It draws the idle verdict and broadcasts ONLY when a fact the
 * windows act on changed — quietSince, idle, the leader, the gap — so a
 * visitor's taps cost the worker (and main.js's syncGhosts, which runs on
 * every worker message) at most one broadcast a second. `idle` turning true
 * is the event the resting screens wait for.
 */
/** The idle verdict, from the windows' touch clocks. */
function verdict(now) {
  loop.quietSince = quietSinceOf();
  loop.idle = loop.idleMs > 0 && windows.size > 0 && now - loop.quietSince >= loop.idleMs;
}

function tick() {
  const now = Date.now();
  const before = { quietSince: loop.quietSince, idle: loop.idle, leader: leaderOf(), gap: loop.gap?.endsAt ?? null };
  verdict(now);
  if (loop.gap && loop.gap.endsAt <= now) loop.gap = null;
  const after = { quietSince: loop.quietSince, idle: loop.idle, leader: leaderOf(), gap: loop.gap?.endsAt ?? null };
  if (
    before.quietSince !== after.quietSince ||
    before.idle !== after.idle ||
    before.leader !== after.leader ||
    before.gap !== after.gap
  ) {
    broadcast(!before.idle && after.idle ? { type: "idle" } : null);
  }
}

function ensureTick() {
  if (loop.idleMs > 0 && !tickTimer) tickTimer = setInterval(tick, TICK_MS);
}

/**
 * A visitor touched `port`'s window. Stamped; an idle room WAKES at once —
 * the other screen must stop scheduling promptly, so this is the one intent
 * that broadcasts by itself — and the gap, if the room was in one, ends.
 */
function onActivity(port) {
  const w = windows.get(port);
  if (!w) return;
  w.lastActivity = Date.now();
  const wasIdle = loop.idle;
  loop.quietSince = quietSinceOf();
  loop.idle = false;
  loop.gap = null;
  if (wasIdle) broadcast({ type: "wake", byId: w.id });
}

/** The pass on `port`'s window ended: the room falls silent until `endsAt`. */
function onGap(port, endsAt) {
  const w = windows.get(port);
  if (!w || !Number.isFinite(endsAt)) return;
  loop.gap = { endsAt };
  loop.passCount += 1;
  broadcast({ type: "gap", byId: w.id, endsAt });
}

/** Every window gets the whole state, with the event that changed it. */
function broadcast(event = null) {
  if (!machine) return;
  const snapshot = snapshotOf();
  for (const port of windows.keys()) port.postMessage({ type: "state", snapshot, event });
}

/** One window gets the state with an event addressed to it (a revoke). */
function tell(port, event) {
  port.postMessage({ type: "state", snapshot: snapshotOf(), event });
}

function ensureMachine(cfg) {
  if (!machine) {
    machine = new TurnMachine({ ...cfg, playing: () => audible != null });
    machine.subscribe((state, event) => broadcast(event));
    return;
  }
  // The newest window's configuration wins: a staff reload with another
  // ?turnPolicy changes the room's policy rather than forking it. The windows
  // compare the snapshot's policy with their own and warn (turns.js).
  if (machine.configure(cfg)) broadcast({ type: "configured" });
}

/**
 * A window's audio started (arbiter.js RoomArbiter.claim). The broadcast
 * arbiter's ranking, unchanged: a holder that outranks the claimant keeps the
 * speakers and the claimant is told to stand down; otherwise the newest claim
 * wins and the previous holder is revoked.
 */
function onAudible(port, kind) {
  const w = windows.get(port);
  if (!w) return;
  if (audible && audible.port !== port && claimRank(audible.kind) > claimRank(kind)) {
    tell(port, { type: "revoked", to: w.id, byId: audible.id, byKind: audible.kind });
    return;
  }
  const previous = audible && audible.port !== port ? audible : null;
  audible = { port, id: w.id, kind, screen: w.screen };
  if (previous) tell(previous.port, { type: "revoked", to: previous.id, byId: w.id, byKind: kind });
  broadcast();
}

/** A window's audio stopped on its own: it no longer defends the speakers. */
function onSilent(port) {
  if (audible?.port !== port) return;
  audible = null;
  broadcast();
}

/**
 * A window left (pagehide's bye), or fell silent past the TTL (`expired`) — a
 * request from one of its viewports can never be executed there, its glasses
 * leave with it, and a claim on the speakers dies with it.
 */
function onBye(port, expired = false) {
  const w = windows.get(port);
  if (!w) return;
  windows.delete(port);
  departed.set(w.id, { lastActivity: w.lastActivity, at: Date.now() });
  if (audible?.port === port) audible = null;
  for (const v of w.viewports) markers.delete(v);
  const gone = expired ? { type: "gone", id: w.id } : null;
  if (machine?.pending && w.viewports.includes(machine.pending.viewport)) {
    machine.withdraw(machine.pending.viewport); // broadcasts through the subscriber
    if (gone) broadcast(gone);
  } else {
    broadcast(gone);
  }
}

/** The presence sweep: every window silent for longer than the TTL is gone. */
function sweep() {
  const cutoff = Date.now() - WINDOW_TTL_MS;
  for (const [port, w] of [...windows]) if (w.lastSeen < cutoff) onBye(port, true);
}
setInterval(sweep, SWEEP_MS);

self.onconnect = (e) => {
  const port = e.ports[0];
  port.onmessage = (ev) => {
    const msg = ev.data;
    if (!msg || typeof msg.type !== "string") return;
    const now = Date.now();
    const known = windows.get(port);
    if (known) known.lastSeen = now;
    switch (msg.type) {
      case "hello": {
        const id = String(msg.id);
        for (const [did, d] of departed) if (now - d.at > DEPARTED_TTL_MS) departed.delete(did);
        const back = departed.get(id);
        departed.delete(id);
        windows.set(port, {
          id,
          screen: Number(msg.screen) || 0,
          viewports: Array.isArray(msg.viewports) ? msg.viewports.map(Number) : [],
          lastSeen: now,
          // A fresh window is not idle: its arrival counts as the room's latest
          // touch. A window back from its own reload keeps the clock it left with.
          lastActivity: back ? back.lastActivity : now,
        });
        // The newest window's idle window wins, as its turn policy does.
        if (Number.isFinite(Number(msg.idleMs))) loop.idleMs = Math.max(0, Number(msg.idleMs) || 0);
        verdict(now);
        ensureTick();
        ensureMachine({ policy: msg.policy, grantMs: msg.grantMs, denyCooldownMs: msg.denyCooldownMs });
        port.postMessage({ type: "welcome", protocol: ROOM_PROTOCOL, snapshot: snapshotOf() });
        broadcast(); // everyone learns of the newcomer
        break;
      }
      case "tap":
        machine?.tap(Number(msg.viewport), msg.file, Number.isFinite(msg.seekTime) ? msg.seekTime : undefined);
        break;
      case "grant":
        machine?.grant();
        break;
      case "deny":
        machine?.deny();
        break;
      case "reset":
        // The sweep (attract.js). Scoped to one screen's viewports since 0.64.0
        // (the band is per screen): their markers and turn state go, the other
        // table's stay. A bare reset is the whole room's, as before.
        if (Array.isArray(msg.viewports)) {
          const ids = msg.viewports.map(Number).filter(Number.isFinite);
          for (const v of ids) markers.delete(v);
          machine?.resetViewports(ids);
        } else {
          markers.clear();
          machine?.reset();
        }
        break;
      case "marker": {
        const v = Number(msg.viewport);
        if (!Number.isFinite(v)) break;
        if (msg.ix == null || !msg.file) markers.delete(v);
        else markers.set(v, { ix: Number(msg.ix), file: String(msg.file) });
        broadcast({ type: "marker", viewport: v });
        break;
      }
      case "audible":
        onAudible(port, typeof msg.kind === "string" ? msg.kind : "visitor");
        break;
      case "silent":
        onSilent(port);
        break;
      case "ping":
        // The heartbeat: `lastSeen` is stamped above; nothing to broadcast.
        break;
      case "activity":
        onActivity(port);
        break;
      case "gap":
        onGap(port, Number(msg.endsAt));
        break;
      case "bye":
        onBye(port);
        break;
      default:
        break;
    }
  };
  port.start();
};
