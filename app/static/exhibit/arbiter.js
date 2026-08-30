// exhibit/arbiter.js
//
// The AudioArbiter: who may make sound in the ROOM (plan §4.3, minimal form).
// Turn-taking (turns.js) arbitrates the clock between two visitors at ONE
// screen; this arbitrates audio between SCREENS — the release-required guard
// against two kiosks playing over each other in one room (plan §2.3). The
// minimal form is exactly what the plan asked for: one interface, an
// in-process implementation, and a BroadcastChannel implementation.
//
// The contract is deliberately tiny. A screen calls `claim()` whenever its
// audio starts; the LAST claimant wins, and every other holder is told via
// `onRevoked` and pauses itself. No grants, no queues, no reply traffic: the
// room-level policy question ("should screens negotiate like viewports do?")
// is an October question, and this interface is the seam it would slot into.
//
// "local" is the DEFAULT and is inert by construction — one screen, one
// claimant, nothing to revoke — so shipping the seam changes no behaviour
// (the ?arbiter=broadcast variant is the opt-in, per the A/B rule). The
// BroadcastChannel impl covers the one-PC-many-windows arrangement the museum
// table actually is (see the architecture notes); true multi-machine rooms
// would need a socket implementation of this same interface, no more.
//
// ZERO imports, by rule (see ENGINE-WANTS.md).

/** Query-string values createArbiter accepts (config.arbiter). */
export const ARBITERS = ["local", "broadcast"];

/**
 * @typedef {object} AudioArbiter
 * @property {() => void} claim      this screen's audio is starting
 * @property {() => void} release    this screen's audio stopped on its own
 * @property {(fn: (byId: string) => void) => () => void} onRevoked
 * @property {() => void} destroy
 */

/** @returns {AudioArbiter} */
export function createArbiter(kind = "local") {
  if (kind === "broadcast") return new BroadcastArbiter();
  if (kind !== "local") {
    console.warn(`exhibit arbiter: unknown kind "${kind}" — using "local"`);
  }
  return new LocalArbiter();
}

/** One screen: every claim succeeds and nothing can revoke it. */
class LocalArbiter {
  claim() {}
  release() {}
  onRevoked() {
    return () => {};
  }
  destroy() {}
}

/** Screens in one browser profile, e.g. two windows of the museum PC. */
class BroadcastArbiter {
  constructor(channelName = "lh-exhibit-audio") {
    // randomUUID needs a secure context, which the plain-http LAN spike server
    // is not; uniqueness is all that matters here, not unguessability.
    this.id = crypto.randomUUID?.() ?? `screen-${Math.random().toString(36).slice(2)}`;
    this._holding = false;
    this._handlers = new Set();
    this._bc = new BroadcastChannel(channelName);
    this._bc.onmessage = (e) => {
      const msg = e.data;
      if (!msg || msg.type !== "claim" || msg.id === this.id) return;
      if (!this._holding) return;
      this._holding = false;
      for (const fn of this._handlers) {
        try {
          fn(msg.id);
        } catch (err) {
          console.warn("exhibit arbiter: onRevoked handler threw", err);
        }
      }
    };
  }
  claim() {
    this._holding = true;
    this._bc.postMessage({ type: "claim", id: this.id });
  }
  release() {
    this._holding = false;
  }
  onRevoked(fn) {
    this._handlers.add(fn);
    return () => this._handlers.delete(fn);
  }
  destroy() {
    this._bc.close();
    this._handlers.clear();
  }
}
