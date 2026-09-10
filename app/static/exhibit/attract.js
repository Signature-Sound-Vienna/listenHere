// exhibit/attract.js
//
// THE ATTRACT LOOP (plan §4.4; design ruled with the user 2026-09-07). How an
// unattended table behaves for eleven months: when the whole ROOM has been idle
// for `attractAfterIdleMs` — no touch on any viewport of any screen, and no
// music playing — the table tidies itself (the sweep), raises the attract band
// over the middle band (the station's name, a sentence of intent, the logos, and
// "tap to start"), and plays the piece through BY ITSELF, switching recordings
// at the annotations' moments so the table demonstrates its own signature move.
// Between passes it falls silent for `attractGapMs` so the room breathes, and in
// that silence it may reload itself (`attractReload`), which is invisible,
// flushes any leak an eight-hour day could accumulate (§7.4), and is how the
// pieces will cycle once there are several (`?piece=`).
//
// THE VISITOR WALKS INTO A LIVE TABLE (ruling R7). A touch on a screen lowers
// that screen's band at once and stops the loop's SCHEDULING — never the music.
// The visitor's first strip tap is an ordinary take. The untouched screen keeps
// its band until it is touched itself.
//
// THE ROOM. Two screens (one PC, two windows) share one set of speakers, so idle
// is a room fact, agreed over a BroadcastChannel: every window announces its
// interactions, keeps a last-interaction time per peer, and the room is idle
// when every known peer has been quiet. Only the LEADER (the lowest peer id)
// plays the sequence; the other window raises its band and rests. Mirroring the
// leader's playback muted on the other screen is the ruled next step, not this
// one. The channel is the loop's own, so the AudioArbiter's semantics are
// untouched; the arbiter still decides who is audible when both try.
//
// THE AUTOPLAY CONSTRAINT. Browsers refuse audible playback without a user
// activation unless the kiosk's policy is opened (the museum PC's launch flag).
// The loop ATTEMPTS playback and, when refused, shows the band with the tap
// line emphasised — "locked" — until the first touch, which is the activation.
//
// OFF unless configured: with attractAfterIdleMs 0 main.js never creates this.

import { t } from "./strings.js";

const CHANNEL = "lh-exhibit-room";
const RESUME_KEY = "lh-exhibit-attract-resume";
const ID_KEY = "lh-exhibit-room-id";
const HELLO_MS = 5000;   // presence heartbeat
const PEER_TTL_MS = 15000; // a peer silent this long has closed or crashed
const EVAL_MS = 1000;    // how often the idle rule is evaluated
const AUDIENCE_ORDER = ["kids", "adults", "expert"];
// The marks are drawn MONOCHROME (user, 2026-09-08): each SVG is a CSS mask over the
// band's paper colour, so the three institutions sit in the band's own tone with
// nothing behind them. The ratio is the SVG's viewBox, since a mask has no size;
// `scale` trims a mark that reads over-large beside the others (the IWK wordmark).
const LOGOS = {
  de: [
    { src: "logos/iwk-de.svg", ratio: 602 / 118, scale: 0.85, name: "Institut für musikalische Akustik – Wiener Klangstil" },
    { src: "logos/mdw-de.svg", ratio: 90.57 / 70.5, name: "mdw – Universität für Musik und darstellende Kunst Wien" },
    { src: "logos/fwf-de.svg", ratio: 875.9 / 238.1, name: "FWF – Österreichischer Wissenschaftsfonds" },
  ],
  en: [
    { src: "logos/iwk-en.svg", ratio: 602 / 118, scale: 0.85, name: "Department of Music Acoustics – Wiener Klangstil" },
    { src: "logos/mdw-en.svg", ratio: 417 / 355, name: "mdw – University of Music and Performing Arts Vienna" },
    { src: "logos/fwf-en.svg", ratio: 875.9 / 238.1, name: "FWF – Austrian Science Fund" },
  ],
};

/**
 * @param {object} opts
 * @param {object} opts.config          the resolved exhibit config
 * @param {object} opts.exhibit         ExhibitData (payload.js): order, audio, durations, annotations
 * @param {object} opts.transport       audio.js Transport
 * @param {object[]} opts.viewports     main.js viewport records (index, language)
 * @param {object} opts.store           AudienceStore (audience.js)
 * @param {HTMLElement} opts.host       #screen — the band is positioned inside it
 * @param {HTMLElement} opts.bandEl     the middle band the attract band is centred on
 * @param {(file: string, time: number) => number} opts.ixFor   align-core: alignment index of a moment
 * @param {(file: string, ix: number) => number} opts.timeFor   align-core: a moment of an index
 * @param {() => void} opts.sweep       main.js: tidy every viewport and reset the turn machine
 * @param {(url: string) => void} [opts.reload]   the page reload (a seam for tests)
 * @param {() => number} [opts.now]
 */
export function createAttractLoop({
  config,
  exhibit,
  transport,
  viewports,
  store,
  host,
  bandEl,
  ixFor,
  timeFor,
  sweep,
  reload = (url) => location.replace(url),
  now = () => Date.now(),
}) {
  const idleMs = Math.max(0, Number(config.attractAfterIdleMs) || 0);
  const playMs = Math.max(0, Number(config.attractDuringPlaybackMs) || 0);
  const gapMs = Math.max(0, Number(config.attractGapMs) || 0);
  const language = viewports[0]?.language ?? "en";

  // ---- state ----------------------------------------------------------------
  let phase = "idle-wait"; // "idle-wait" | "attract" | "gap" | "locked"
  let bandUp = false;
  let started = false;     // the pass's first playback has been asked for
  let steps = [];          // [{ix, file, id}] sorted by alignment index
  let pointer = 0;
  let passCount = 0;
  let audience = null;
  let gapEndsAt = null;
  let gapTimer = 0;
  let resumed = false;
  let takenOver = false; // this pass carried on from a playing table (the second timer)
  let lastLocal = now();
  let lastFile = null;
  const peers = new Map(); // id -> {lastSeen, lastActivity}

  // A stable id per TAB, so the leader stays the leader across its own reloads.
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

  // ---- the room --------------------------------------------------------------
  const bc = typeof BroadcastChannel === "function" ? new BroadcastChannel(CHANNEL) : null;
  const post = (msg) => bc?.postMessage({ ...msg, id, t: now() });
  if (bc) {
    bc.onmessage = (e) => {
      const msg = e.data;
      if (!msg || msg.id === id) return;
      const known = peers.has(msg.id);
      const peer = peers.get(msg.id) ?? { lastSeen: 0, lastActivity: 0 };
      peer.lastSeen = now();
      if (msg.type === "hello") {
        peer.lastActivity = Math.max(peer.lastActivity, Number(msg.lastActivity) || 0);
        peer.playing = Boolean(msg.playing);
      } else if (msg.type === "activity") {
        peer.lastActivity = now();
        // Somebody is at the OTHER screen: the room is no longer idle, so the
        // loop stops scheduling. This screen's band stays — it is untouched —
        // and whatever is playing plays on; the arbiter settles the speakers.
        if (phase !== "idle-wait") endLoop();
      } else if (msg.type === "bye") {
        peers.delete(msg.id);
        return;
      }
      peers.set(msg.id, peer);
      // A newcomer learns of us at once rather than at the next heartbeat, so
      // both windows agree on the leader within a round trip.
      if (!known) hello();
    };
  }
  const isLeader = () => [...peers.keys(), id].sort()[0] === id;
  /** Another window's music is on the speakers (its last hello said so). */
  const peerPlaying = () => [...peers.values()].some((p) => p.playing);
  const hello = () => post({ type: "hello", lastActivity: lastLocal, playing: transport.playing });
  const quietSince = () => {
    let q = lastLocal;
    for (const p of peers.values()) q = Math.max(q, p.lastActivity);
    return q;
  };
  const purgePeers = () => {
    for (const [pid, p] of peers) if (now() - p.lastSeen > PEER_TTL_MS) peers.delete(pid);
  };
  const helloTimer = setInterval(() => {
    purgePeers();
    hello();
  }, HELLO_MS);
  hello();
  window.addEventListener("pagehide", () => post({ type: "bye" }));

  // ---- interaction ---------------------------------------------------------------
  const touch = () => {
    lastLocal = now();
    post({ type: "activity" });
    if (phase !== "idle-wait") {
      endLoop();
      lowerBand();
    }
  };
  const onInteract = (e) => {
    if (e.isTrusted === false && !e.detail?.attractTest) return;
    // The study panel is staff tooling, not a visitor: its taps neither count as
    // room activity nor lower the band, so the loop can be driven from it.
    if (e.target?.closest?.(".study-panel, .study-cog")) return;
    touch();
  };
  window.addEventListener("pointerdown", onInteract, true);
  window.addEventListener("keydown", onInteract, true);

  // ---- the idle rule ------------------------------------------------------------------
  const evalTimer = setInterval(() => {
    if (phase !== "idle-wait") return;
    const quiet = now() - quietSince();
    if (transport.playing) {
      // The second timer (user, 2026-09-07): a playing table nobody has touched
      // for Y is taken over from where it is, never restarted.
      if (playMs && quiet >= playMs) takeOver();
      return;
    }
    if (idleMs && quiet >= idleMs) start();
  }, EVAL_MS);
  // The music stopping is the moment the idle count starts — a visitor who
  // listened for eight minutes without touching anything was not idle.
  let wasPlaying = transport.playing;
  transport.subscribe((state) => {
    if (wasPlaying && !state.playing && phase === "idle-wait") lastLocal = now();
    wasPlaying = state.playing;
    if (phase === "attract" && started) followPass(state);
  });

  // ---- the band -----------------------------------------------------------------------
  const el = buildBand();
  el.hidden = true;
  host.appendChild(el);
  window.addEventListener("resize", () => bandUp && layout());

  function buildBand() {
    const root = document.createElement("div");
    root.className = "attract-band";
    root.setAttribute("role", "region");
    root.setAttribute("aria-label", `${t("attract.eyebrow", language)}: ${t("attract.title", language)}`);
    // The body breathes. Inside the SHEET, two inset layers share its wave mask:
    // the STITCH (dashes of thread, 4 px in) and the FILL (the band's own surface
    // again, 5 px in), so a 1 px dashed seam follows the wave with band on both
    // sides — the medallions' ring, in ribbon form (exhibit.css; user, 2026-09-08).
    const body = document.createElement("div");
    body.className = "ab-body";
    const sheet = document.createElement("div");
    sheet.className = "ab-sheet ab-waved";
    for (const cls of ["ab-stitch", "ab-stitch-fill"]) {
      const layer = document.createElement("div");
      layer.className = `${cls} ab-waved`;
      layer.setAttribute("aria-hidden", "true");
      sheet.appendChild(layer);
    }
    const copies = document.createElement("div");
    copies.className = "ab-copies";
    const n = Math.min(2, viewports.length || 1);
    // Copy 0 (the near, upright reader) on the LEFT and copy 1 on the right — the
    // mirrored band's own order (user, 2026-09-08), natural for two LTR languages.
    for (let i = 0; i < n; i++) copies.appendChild(copy(i));
    sheet.appendChild(copies);
    body.appendChild(sheet);
    root.appendChild(body);
    // A touch on the band itself is the visitor arriving: it lowers the band
    // and nothing else — the interface underneath is not hit by the same tap.
    root.addEventListener("pointerdown", (e) => e.stopPropagation(), false);
    return root;
  }

  function copy(i) {
    const c = document.createElement("div");
    c.className = "ab-copy";
    c.dataset.copy = String(i);
    // Turned to face its reader exactly as that reader's half is (config.rotations).
    const rot = Number(config.rotations?.[i]) || 0;
    if (rot) c.style.transform = `rotate(${rot}deg)`;
    const lang = viewports[i]?.language ?? language;
    // The eyebrow names the series; the title is the question (user, 2026-09-08).
    // ONE language per copy — this reader's (config.languages[i]; user, 2026-09-08).
    // A string without a German text falls back to English (strings.js), which is
    // how the title stays English by design.
    const eyebrow = document.createElement("p");
    eyebrow.className = "ab-eyebrow";
    eyebrow.lang = lang;
    eyebrow.textContent = t("attract.eyebrow", lang);
    const title = document.createElement("h1");
    title.className = "ab-title";
    title.textContent = t("attract.title", lang);
    c.append(eyebrow, title);
    c.appendChild(line("attract.intro", "ab-intro", lang));
    const logos = document.createElement("div");
    logos.className = "ab-logos";
    for (const { src, ratio, scale = 1, name } of LOGOS[config.attractLogos] ?? LOGOS.de) {
      const mark = document.createElement("span");
      mark.className = "ab-mark";
      mark.style.setProperty("--ab-mark-src", `url("${src}")`);
      mark.style.setProperty("--ab-mark-ratio", String(ratio));
      mark.style.setProperty("--ab-mark-scale", String(scale));
      mark.setAttribute("role", "img");
      mark.setAttribute("aria-label", name);
      logos.appendChild(mark);
    }
    c.appendChild(logos);
    c.appendChild(line("attract.fwf", "ab-fwf", lang));
    const tap = document.createElement("p");
    tap.className = "ab-tap";
    const glyph = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    glyph.setAttribute("viewBox", "0 0 24 24");
    glyph.setAttribute("aria-hidden", "true");
    glyph.classList.add("ab-tap-glyph");
    glyph.innerHTML =
      '<path d="M9 11V5.5a1.5 1.5 0 0 1 3 0V11m0-2a1.5 1.5 0 0 1 3 0v2m0-1a1.5 1.5 0 0 1 3 0v1m0 0a1.5 1.5 0 0 1 3 0v3.5c0 3.6-2.4 6-6 6h-1.5c-2 0-3.3-.8-4.4-2.2L6.2 15a1.5 1.5 0 0 1 2.3-1.9L9 14"/>' +
      '<circle class="ab-tap-ring" cx="10.5" cy="5.5" r="4.5"/>';
    tap.appendChild(glyph);
    const words = document.createElement("span");
    words.lang = lang;
    words.textContent = t("attract.tap", lang);
    tap.appendChild(words);
    c.appendChild(tap);
    return c;
  }

  /** One paragraph in the reader's language (falling back as strings.js does). */
  function line(key, className, lang) {
    const p = document.createElement("div");
    p.className = className;
    const para = document.createElement("p");
    para.lang = lang;
    para.textContent = t(key, lang);
    p.appendChild(para);
    return p;
  }

  function layout() {
    // Centred on the middle band, LAYOUT values (offsetTop/offsetHeight), which
    // the stage rotation's transform does not disturb.
    const mid = bandEl.offsetTop + bandEl.offsetHeight / 2;
    el.style.top = `${Math.round(mid - el.offsetHeight / 2)}px`;
  }
  function raiseBand() {
    el.classList.toggle("is-locked", phase === "locked");
    if (bandUp) return;
    bandUp = true;
    el.hidden = false;
    // layout() reads offsetHeight, which is the reflow that lets the opacity
    // transition run from 0 — synchronously, NOT on a requestAnimationFrame: a
    // background tab never fires one (the hidden-tab rAF trap, years-view.js).
    layout();
    el.classList.add("is-up");
  }
  function lowerBand() {
    if (!bandUp) return;
    bandUp = false;
    el.classList.remove("is-up", "is-locked");
    setTimeout(() => {
      if (!bandUp) el.hidden = true;
    }, 450);
  }

  // ---- the loop --------------------------------------------------------------------------
  function audienceFor(pass) {
    const want = config.attractAudience;
    const known = AUDIENCE_ORDER.filter((a) => exhibit.annotations.some((x) => x.audience === a));
    if (want && want !== "cycle") return want;
    if (!known.length) return null;
    return known[pass % known.length];
  }

  /** The pass's switch points: every annotation the shown audience has, at its first region. */
  function buildSteps(mode) {
    const out = [];
    for (const ann of exhibit.annotations) {
      if (mode && mode !== "all" && ann.audience !== mode) continue;
      const region = ann.regions?.[0];
      const target = ann.targets?.find((x) => exhibit.audio[x.file]);
      if (!region?.indexPair || !target) continue;
      out.push({ ix: region.indexPair[0], file: target.file, id: ann.id });
    }
    out.sort((a, b) => a.ix - b.ix);
    return out;
  }

  function start() {
    phase = "attract";
    takenOver = false;
    sweep();
    raiseBand();
    post({ type: "attract", leader: isLeader() });
    // The other screen raises its band and rests — and so does this one when a
    // peer's music is already on the speakers (a taken-over table next door).
    if (!isLeader() || peerPlaying()) return;
    runPass();
  }

  /** The second timer: carry on from the playhead — table tidied, band up, no restart. */
  function takeOver() {
    phase = "attract";
    takenOver = true;
    sweep();
    raiseBand();
    // The audience stays as the last visitor left it; the pass's switch points
    // are its annotations still ahead of the playhead.
    audience = store.get(viewports[0]?.index ?? 0) ?? null;
    steps = buildSteps(audience);
    const file = transport.activeFile;
    const here = file ? ixFor(file, transport.time) : -Infinity;
    pointer = 0;
    while (pointer < steps.length && steps[pointer].ix <= here) pointer++;
    started = true;
    lastFile = file;
    hello(); // tell the other screen the speakers are taken
    post({ type: "attract", leader: true, takenOver: true });
  }

  function runPass() {
    audience = audienceFor(passCount);
    if (audience) for (const vp of viewports) store.set(vp.index, audience);
    steps = buildSteps(audience);
    pointer = 0;
    started = false;
    lastFile = null;
    const first = exhibit.order[0];
    if (!first) return;
    transport.select(first, 0).then(
      () => {
        if (phase !== "attract") return;
        started = true;
        // Anything the pass already passed (a step at index 0) fires on the next tick.
        followPass({ file: transport.activeFile, time: transport.time, playing: transport.playing });
      },
      (e) => lock(e),
    );
  }

  function followPass(state) {
    if (!state.file) return;
    const ix = ixFor(state.file, state.time);
    let fired = null;
    while (pointer < steps.length && steps[pointer].ix <= ix) fired = steps[pointer++];
    if (fired && fired.file !== state.file && exhibit.audio[fired.file]) {
      // The table's signature move: the same musical moment, another recording.
      transport.select(fired.file).catch((e) => lock(e));
      lastFile = fired.file;
      return;
    }
    const duration = exhibit.durations?.[state.file];
    if (!state.playing && duration && state.time >= duration - 0.5) enterGap();
  }

  function enterGap() {
    phase = "gap";
    started = false;
    passCount += 1;
    gapEndsAt = now() + gapMs;
    clearTimeout(gapTimer);
    if (config.attractReload) {
      // Halfway through the silence: nobody sees a reload the music is not
      // playing through. The resume record carries the rest of the gap.
      gapTimer = setTimeout(() => {
        try {
          sessionStorage.setItem(RESUME_KEY, JSON.stringify({ gapEndsAt, passCount }));
        } catch (_) {
          // No storage: the loop simply waits out the whole gap again after the reload.
        }
        reload(nextUrl());
      }, Math.round(gapMs / 2));
    } else {
      gapTimer = setTimeout(nextPass, gapMs);
    }
  }

  function nextPass() {
    if (phase !== "gap") return;
    phase = "attract";
    raiseBand();
    if (isLeader()) runPass();
  }

  /** The URL of the next piece — the same page while there is one piece. */
  function nextUrl() {
    const url = new URL(location.href);
    const pieces = String(config.attractPieces || config.piece || "")
      .split(",").map((s) => s.trim()).filter(Boolean);
    if (pieces.length > 1) {
      const at = pieces.indexOf(config.piece);
      url.searchParams.set("piece", pieces[(at + 1) % pieces.length]);
    }
    return url.toString();
  }

  function lock(err) {
    if (phase === "idle-wait") return;
    console.warn("exhibit attract: playback refused — waiting for the first touch", err?.name || err);
    phase = "locked";
    started = false;
    clearTimeout(gapTimer);
    raiseBand();
  }

  /** The loop stops SCHEDULING; whatever plays, plays on (R7). */
  function endLoop() {
    phase = "idle-wait";
    started = false;
    clearTimeout(gapTimer);
    gapEndsAt = null;
    try {
      sessionStorage.removeItem(RESUME_KEY);
    } catch (_) {
      /* no storage */
    }
  }

  // ---- resume after a reload in the silence -------------------------------------------------
  try {
    const raw = sessionStorage.getItem(RESUME_KEY);
    if (raw) {
      sessionStorage.removeItem(RESUME_KEY);
      const rec = JSON.parse(raw);
      resumed = true;
      passCount = Number(rec.passCount) || 0;
      phase = "gap";
      sweep();
      raiseBand();
      gapEndsAt = Math.max(now(), Number(rec.gapEndsAt) || now());
      gapTimer = setTimeout(nextPass, gapEndsAt - now());
    }
  } catch (_) {
    /* no storage */
  }

  return {
    /** A snapshot for renderers and tests. */
    state() {
      const file = transport.activeFile;
      const next = steps[pointer];
      return {
        phase,
        bandUp,
        leader: isLeader(),
        peers: peers.size,
        idleMs,
        gapMs,
        quietMs: now() - quietSince(),
        started,
        passCount,
        audience,
        steps: steps.map((s) => ({ ...s })),
        pointer,
        nextAt: next && file ? timeFor(file, next.ix) : null,
        gapEndsAt,
        resumed,
        takenOver,
        peerPlaying: peerPlaying(),
        id,
      };
    },
    /** Start now, whatever the idle clock says (tests, and a staff shortcut). */
    force() {
      if (phase === "idle-wait") start();
    },
    /** Register an interaction without a pointer event (tests). */
    touch,
    /** Tear down: timers, listeners, the channel, the band. */
    destroy() {
      clearInterval(helloTimer);
      clearInterval(evalTimer);
      clearTimeout(gapTimer);
      window.removeEventListener("pointerdown", onInteract, true);
      window.removeEventListener("keydown", onInteract, true);
      post({ type: "bye" });
      bc?.close();
      el.remove();
    },
  };
}
