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

/** Connected windows: port -> {id, screen, viewports (room ids)}. */
const windows = new Map();
/** The room's turn machine, created by the first hello. */
let machine = null;
/** Who is on the speakers: {port, id, kind, screen} or null. */
let audible = null;
/** The listening markers: room viewport id -> {ix, file} (marker.js). */
const markers = new Map();

const snapshotOf = () => ({
  ...machine.state(),
  markers: Object.fromEntries(markers),
  audible: audible ? { id: audible.id, kind: audible.kind, screen: audible.screen } : null,
  windows: [...windows.values()].map((w) => ({ id: w.id, screen: w.screen, viewports: w.viewports.slice() })),
});

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

/** A window left (pagehide) — a request from one of its viewports can never be executed there. */
function onBye(port) {
  const w = windows.get(port);
  if (!w) return;
  windows.delete(port);
  if (audible?.port === port) audible = null;
  for (const v of w.viewports) markers.delete(v); // its glasses leave with it
  if (machine?.pending && w.viewports.includes(machine.pending.viewport)) {
    machine.withdraw(machine.pending.viewport); // broadcasts through the subscriber
  } else {
    broadcast();
  }
}

self.onconnect = (e) => {
  const port = e.ports[0];
  port.onmessage = (ev) => {
    const msg = ev.data;
    if (!msg || typeof msg.type !== "string") return;
    switch (msg.type) {
      case "hello": {
        windows.set(port, {
          id: String(msg.id),
          screen: Number(msg.screen) || 0,
          viewports: Array.isArray(msg.viewports) ? msg.viewports.map(Number) : [],
        });
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
        // The sweep (attract.js): the room's markers go with the turn state.
        markers.clear();
        machine?.reset();
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
      case "bye":
        onBye(port);
        break;
      default:
        break;
    }
  };
  port.start();
};
