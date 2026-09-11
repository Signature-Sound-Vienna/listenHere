// exhibit/arbiter.js
//
// The AudioArbiter: who may make sound in the ROOM (plan §4.3, minimal form).
// Turn-taking (turns.js) arbitrates the clock between two visitors at ONE
// screen; this arbitrates audio between SCREENS — the release-required guard
// against two kiosks playing over each other in one room (plan §2.3). The
// minimal form is exactly what the plan asked for: one interface, an
// in-process implementation, and a BroadcastChannel implementation.
//
// The contract is deliberately tiny. A screen calls `claim(kind)` whenever its
// audio starts; the LAST claimant wins, and every other holder is told via
// `onRevoked` and yields — a live table pauses, an idle one mutes and mirrors
// (attract.js). No grants, no queues: the room-level policy question ("should
// screens negotiate like viewports do?") is an October question, and this
// interface is the seam it would slot into.
//
// THE ONE RANKING (attract loop v2, plan §4.4): a claim carries a KIND, and a
// VISITOR outranks the LOOP. The attract loop claims as "loop" when its pass
// starts a recording; a visitor's tap claims as "visitor". A holder that
// outranks a claimant keeps the speakers and answers `hold`, and the claimant
// revokes ITSELF — so the loop can never take the audio from a person, while
// a person always takes it from the loop. Equal kinds keep the original rule:
// the newest claim wins. Still no queues, and the two message types are the
// whole protocol.
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

/** Claim kinds, LOWEST rank first: the loop yields to any visitor. */
export const CLAIM_KINDS = ["loop", "visitor"];

/** An unknown kind ranks as a visitor: a person is the safe assumption. */
const rank = (kind) => {
  const r = CLAIM_KINDS.indexOf(kind);
  return r < 0 ? CLAIM_KINDS.length - 1 : r;
};

/**
 * @typedef {object} AudioArbiter
 * @property {(kind?: string) => void} claim   this screen's audio is starting, as "visitor" (default) or "loop"
 * @property {() => void} release              this screen's audio stopped on its own (it no longer defends the speakers)
 * @property {(fn: (byId: string, byKind: string) => void) => () => void} onRevoked
 * @property {boolean} holding                 this screen believes it has the speakers
 * @property {string|null} kind                the kind it holds them as
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
  constructor() {
    this.holding = false;
    this.kind = null;
  }
  claim(kind = "visitor") {
    this.holding = true;
    this.kind = kind;
  }
  release() {
    this.holding = false;
    this.kind = null;
  }
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
    this.holding = false;
    this.kind = null;
    this._handlers = new Set();
    this._bc = new BroadcastChannel(channelName);
    this._bc.onmessage = (e) => {
      const msg = e.data;
      if (!msg || msg.id === this.id || !this.holding) return;
      if (msg.type === "claim") {
        if (rank(this.kind) > rank(msg.kind)) {
          // A person holds the speakers and the loop asked: the loop is told
          // to stand down, and the person hears nothing of it.
          this._bc.postMessage({ type: "hold", id: this.id, to: msg.id, kind: this.kind });
          return;
        }
        this._revoke(msg.id, msg.kind);
      } else if (msg.type === "hold" && msg.to === this.id) {
        this._revoke(msg.id, msg.kind);
      }
    };
  }
  claim(kind = "visitor") {
    this.holding = true;
    this.kind = kind;
    this._bc.postMessage({ type: "claim", id: this.id, kind });
  }
  release() {
    this.holding = false;
    this.kind = null;
  }
  onRevoked(fn) {
    this._handlers.add(fn);
    return () => this._handlers.delete(fn);
  }
  destroy() {
    this._bc.close();
    this._handlers.clear();
  }
  _revoke(byId, byKind) {
    this.holding = false;
    this.kind = null;
    for (const fn of this._handlers) {
      try {
        fn(byId, byKind);
      } catch (err) {
        console.warn("exhibit arbiter: onRevoked handler threw", err);
      }
    }
  }
}
