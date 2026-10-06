// exhibit/attract.js
//
// THE ATTRACT LOOP (plan §4.4; design ruled with the user 2026-09-07, the idle
// model replaced 2026-09-16). How an unattended table behaves for eleven
// months: a SCREEN nobody has touched for `attractAfterIdleMs` tidies itself
// (the sweep of its own table) and raises the attract band over the middle
// band (the station's name, a sentence of intent, the logos, and "tap to
// start"). What plays under the band is the ROOM's business: while the other
// screen is in use this one RESTS — band up, mirroring what the room hears,
// muted — and once BOTH screens are past their idle window the loop plays the
// piece through BY ITSELF, switching recordings at the annotations' moments so
// the table demonstrates its own signature move: the window whose music is on
// the speakers carries on from its playhead (the take-over), or, the room
// silent, the LEADER plays from the top while the other screen mirrors.
// Between passes it falls silent for `attractGapMs` so the room breathes, and
// in that silence it may reload itself (`attractReload`), which is invisible,
// flushes any leak an eight-hour day could accumulate (§7.4), and is how the
// pieces will cycle once there are several (`?piece=`).
//
// ONE TIMER PER SCREEN, COUNTING TOUCHES (user, 2026-09-16; it replaced the
// two-timer room model — idle-and-silent for X, playing-untouched for Y —
// judged not worth two knobs: the band over a listener costs one tap and the
// music plays on, and the sweep the band brings is what the take-over did
// anyway). Music playing or stopping does not move the count; only a touch
// does. The room is idle exactly when the LATER screen reaches its window, so
// there is no room timer: `quietSince` is the latest touch anywhere.
//
// THE VISITOR WALKS INTO A LIVE TABLE (ruling R7). A touch on a screen lowers
// that screen's band at once and stops the loop's SCHEDULING — never the music.
// The visitor's first strip tap is an ordinary take. A touch on the OTHER
// screen during a pass or a gap leaves this one RESTING: band up, the music
// playing on, nothing scheduled, until this screen is touched itself.
//
// PHASES. "idle-wait" (live table, band down, counting) · "rest" (band up, the
// other screen in use) · "attract" (the loop runs — this window plays the pass,
// or mirrors the one that does) · "gap" (the silence between passes) ·
// "locked" (playback refused here — "tap to start").
//
// PRESENCE — ONE SEAM, TWO IMPLEMENTATIONS. The room's facts the loop needs —
// the latest touch anywhere, idle, the leader, another window's music on the
// speakers, the peers, the gap — come through `presence`: `channelPresence`
// keeps them over the room's BroadcastChannel (hello/bye with a 15 s TTL,
// activity, gap; the leader the lowest id, or the worker's registry when there
// is one) — the v2 path, kept verbatim for room=off and for a room without a
// SharedWorker; `workerPresence` (room=shared with the worker) reads them from
// the room's snapshot (room-worker.js keeps them) and forwards the intents.
//
// THE MIRROR (ruling R7 in full, v2) LIVES IN room.js since the room machine
// (0.62.0): the audible window's once-a-second `sync`, the muted follow, the
// touch that fades a window in, and the yield that fades the loser out. The
// loop's part is to tell the room when this screen is IDLE (its band is up —
// under room=off that is the only time the mirror runs, and the only time the
// audience follows the sync) and when playback is refused here, and to unmute
// for its own pass. The loop's pass claims as "loop", which any visitor's claim
// outranks (arbiter.js). When the audible pass ends, its `gap` puts every idle
// screen into the same silence, so both reload in it.
//
// THE AUTOPLAY CONSTRAINT. Browsers refuse audible playback without a user
// activation unless the kiosk's policy is opened (the museum PC's launch flag).
// The loop ATTEMPTS playback and, when refused, shows the band with the tap
// line emphasised — "locked" — until the first touch, which is the activation.
//
// OFF unless configured: with attractAfterIdleMs 0 main.js never creates this.

import { t } from "./strings.js";

const RESUME_KEY = "lh-exhibit-attract-resume";
// Where in the silence each window reloads (attractReload): the leader at the
// midpoint, a FOLLOWER later — so the two windows of one PC never reload at
// once and the room's SharedWorker (room-worker.js), which dies with its last
// window, is never without one. With the museum's 25 s gap the leader has
// six seconds to reconnect before the follower goes.
const RELOAD_AT_LEADER = 0.5;
const RELOAD_AT_FOLLOWER = 0.75;
const HELLO_MS = 5000;   // presence heartbeat
const PEER_TTL_MS = 15000; // a peer silent this long has closed or crashed
const EVAL_MS = 1000;    // how often the idle rule is evaluated
const AUDIENCE_ORDER = ["kids", "adults", "expert"];
// The marks are drawn MONOCHROME (user, 2026-09-08): each artwork is a CSS mask over
// the band's paper colour, so the institutions sit in the band's own tone with
// nothing behind them. The ratio is the artwork's own, since a mask has no size;
// `scale` trims a mark that reads over-large beside the others (the IWK wordmark).
//
// THE HOUSE OF STRAUSS MARK IS A RASTER, and the only one: it arrived as a WebP
// with no vector beside it (assets/logos/HoS.webp). It masks correctly because it
// carries a real alpha channel — the wordmark is cut out, not painted on white —
// and at 2048 px wide it has resolution to spare for a 52 px-tall mark. Its ratio
// is the file's, whose ink sits inside a ~5% margin, close enough to the others'
// trim that it needs no crop. If a vector ever arrives, swap the file and the
// ratio and nothing else changes.
const LOGOS = {
  de: [
    { src: "logos/iwk-de.svg", ratio: 602 / 118, scale: 0.85, name: "Institut für musikalische Akustik – Wiener Klangstil" },
    { src: "logos/mdw-de.svg", ratio: 90.57 / 70.5, name: "mdw – Universität für Musik und darstellende Kunst Wien" },
    { src: "logos/hos.webp", ratio: 2048 / 969, name: "House of Strauss" },
    { src: "logos/fwf-de.svg", ratio: 875.9 / 238.1, name: "FWF – Österreichischer Wissenschaftsfonds" },
  ],
  en: [
    { src: "logos/iwk-en.svg", ratio: 602 / 118, scale: 0.85, name: "Department of Music Acoustics – Wiener Klangstil" },
    { src: "logos/mdw-en.svg", ratio: 417 / 355, name: "mdw – University of Music and Performing Arts Vienna" },
    { src: "logos/hos.webp", ratio: 2048 / 969, name: "House of Strauss" },
    { src: "logos/fwf-en.svg", ratio: 875.9 / 238.1, name: "FWF – Austrian Science Fund" },
  ],
};

/**
 * @param {object} opts
 * @param {object} opts.config          the resolved exhibit config
 * @param {object} opts.exhibit         ExhibitData (payload.js): order, audio, durations, annotations
 * @param {object} opts.transport       audio.js Transport
 * @param {object} opts.room            room.js: the channel, this tab's id, the clock and the mirror
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
  room,
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
  const gapMs = Math.max(0, Number(config.attractGapMs) || 0);
  const language = viewports[0]?.language ?? "en";

  // ---- state ----------------------------------------------------------------
  let phase = "idle-wait"; // "idle-wait" | "rest" | "attract" | "gap" | "locked"
  let bandUp = false;
  let started = false;     // the pass's first playback has been asked for
  let passPending = false; // runPass's first select is in flight (a build can take a second)
  let steps = [];          // [{ix, file, id}] sorted by alignment index
  let pointer = 0;
  let passCount = 0;
  let audience = null;
  let gapEndsAt = null;
  let gapTimer = 0;
  let reloadAt = null;     // when this window will reload in the gap (attractReload)
  let resumed = false;
  let resumedFrom = null;  // "room" (the worker's welcome snapshot) | "storage" (the sessionStorage record) | null
  let takenOver = false;   // this pass carried on from a playing table (the take-over)
  let lastLocal = now();   // this SCREEN's latest touch — the one timer's origin
  let lastFile = null;

  // ---- the room --------------------------------------------------------------
  // This tab's stable id is the room's (room.js); the mirror is the room's too —
  // read here, never held. The room's facts come through the presence seam.
  const { id } = room;
  /** This window is on the speakers: playing and not muted. */
  const audible = () => room.audible();
  const presence = room.worker
    ? workerPresence({ room, now })
    : channelPresence({ room, now, idleMs, lastActivity: () => lastLocal, audible });
  const unsubscribePresence = presence.onEvent((ev) => {
    if (ev.type === "activity") {
      // Somebody is at the OTHER screen: the room is no longer idle, so the
      // loop stops scheduling. This screen's band stays — it is untouched —
      // and whatever is playing plays on (R7); the arbiter settles the speakers.
      if (phase === "attract" || phase === "gap") rest();
    } else if (ev.type === "gap") {
      // The audible pass ended over there. The silence is the room's, so an
      // idle screen falls into the same gap — and reloads in it, if configured,
      // so the follower flushes its day too (§7.4). A gap can only come from a
      // running pass, so a "rest" that has not yet seen the room turn idle
      // (the tick is a second) joins it too.
      if (bandUp && (phase === "attract" || phase === "rest")) {
        room.stopMirror({ pause: true });
        enterGap(Number.isFinite(ev.endsAt) ? ev.endsAt : now() + gapMs, false);
      }
    }
  });
  const isLeader = () => presence.isLeader();
  const peerAudible = () => presence.peerAudible();

  // ---- interaction ---------------------------------------------------------------
  // The room owns the listeners (room.js: a trusted pointer or key, never the
  // study panel's, which is staff tooling) and tells the loop FIRST, then runs
  // the hand-off (R7) — a tap on a muted screen fades this copy in, and the
  // claim main.js makes on the audible edge has the other screen fade out.
  const touched = () => {
    lastLocal = now();
    presence.postActivity();
    if (phase !== "idle-wait") endLoop();
    lowerBand();
  };
  const unsubscribeTouch = room.onTouch(touched);
  // What the room needs to know about this screen: IDLE (band up) is when the
  // mirror may run under room=off and when the audience follows the sync;
  // locked or in the gap, a mirror must not start a player here.
  room.setGates({ idle: () => bandUp, veto: () => phase === "locked" || phase === "gap" });
  const unsubscribeRefused = room.onRefused((e) => lock(e));

  // ---- the idle rule ------------------------------------------------------------------
  const evalTimer = setInterval(() => {
    if (phase === "idle-wait") {
      // This screen's own window: untouched for T, band up and the table swept,
      // whatever plays — the room then says what happens under the band.
      if (idleMs && now() - lastLocal >= idleMs) raise();
    } else if (phase === "rest") {
      // The other screen has gone quiet too: the room is idle, the loop's.
      if (presence.idle()) decide();
    } else if (phase === "attract" && !started && !passPending && !transport.playing) {
      // A resting leader — it stood back because the other screen was audible
      // when the room went idle, or it mirrored a table whose music has since
      // stopped — and the room is silent and idle: the pass is the leader's to
      // run now. Without this both screens would wait for each other for ever.
      if (isLeader() && !peerAudible() && presence.idle()) runPass();
    }
  }, EVAL_MS);
  transport.subscribe((state) => {
    if (phase === "attract" && started && !room.mirroring) followPass(state);
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

  /**
   * This screen's idle window has passed (or force()): its own table is swept
   * and its band goes up; the room decides what plays under it.
   */
  function raise(roomIdle = presence.idle()) {
    sweep();
    raiseBand();
    decide(roomIdle);
  }

  /**
   * What this screen does under its band, from the room's facts. The other
   * screen in use → REST (mirror, nothing scheduled). The room idle → the loop:
   * this window's own music on the speakers carries on from its playhead (the
   * take-over — never a restart); another window's music → that window's loop
   * takes over and this one mirrors; the room silent → the leader's pass from
   * the top, the other screen mirroring.
   */
  function decide(roomIdle = presence.idle()) {
    if (!roomIdle) {
      phase = "rest";
      started = false;
      return;
    }
    if (audible()) {
      takeOver();
      return;
    }
    phase = "attract";
    takenOver = false;
    started = false;
    if (isLeader() && !peerAudible()) runPass();
  }

  /** The other screen is in use: the band stays up, nothing is scheduled, the music plays on (R7). */
  function rest() {
    phase = "rest";
    started = false;
    clearTimeout(gapTimer);
    gapEndsAt = null;
    reloadAt = null;
    forgetResume();
  }

  /** The take-over: carry on from the playhead — table tidied, band up, no restart. */
  function takeOver() {
    phase = "attract";
    takenOver = true;
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
    presence.announce(); // tell the other screen the speakers are taken
  }

  function runPass() {
    audience = audienceFor(passCount);
    if (audience) for (const vp of viewports) store.set(vp.index, audience);
    steps = buildSteps(audience);
    pointer = 0;
    started = false;
    lastFile = null;
    // A leader that was mirroring the last visitor's table plays its own pass
    // out loud: this is the one place the loop itself unmutes.
    room.stopMirror();
    transport.setMuted(false);
    const first = exhibit.order[0];
    if (!first) return;
    passPending = true;
    transport.select(first, 0).then(
      () => {
        passPending = false;
        if (phase !== "attract") return;
        started = true;
        // Anything the pass already passed (a step at index 0) fires on the next tick.
        followPass({ file: transport.activeFile, time: transport.time, playing: transport.playing });
      },
      (e) => {
        passPending = false;
        lock(e);
      },
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
    // A pass is over when the recording's ALIGNED material runs out, which is
    // not the same as the file running out: open-ended alignment (0.63.0)
    // leaves the applause at the tail unaligned, so the grid can stop many
    // seconds before the audio does — 1.9 s on VPO-1989, 54 s on VPO-2010.
    // Measured against the file's duration the loop never saw a pass end at
    // all, so it never reached the gap and never started another pass.
    const grid = exhibit.grids?.[state.file];
    const end = grid?.length ? grid[grid.length - 1] : exhibit.durations?.[state.file];
    if (!state.playing && end && state.time >= end - 0.5) enterGap();
  }

  /**
   * The silence between passes. Our OWN pass ending (`own`: followPass saw the
   * recording run out) posts the gap to the room so the idle screens share it
   * — and the worker counts the pass — while a peer's gap arrives with its end
   * time (`endsAt`) and is reported by nobody else.
   */
  function enterGap(endsAt, own = endsAt == null) {
    phase = "gap";
    started = false;
    room.stopMirror();
    passCount += 1;
    gapEndsAt = Math.max(now(), Number.isFinite(endsAt) ? endsAt : now() + gapMs);
    if (own) presence.postGap(gapEndsAt);
    const left = gapEndsAt - now();
    clearTimeout(gapTimer);
    if (config.attractReload) {
      // In the silence, where nobody sees a reload the music is not playing
      // through — the leader at its midpoint, a follower later (STAGGERED, so
      // the room's worker keeps a window). The resume record carries the rest
      // of the gap.
      const at = room.worker && !isLeader() ? RELOAD_AT_FOLLOWER : RELOAD_AT_LEADER;
      const delay = Math.round(left * at);
      reloadAt = now() + delay;
      gapTimer = setTimeout(() => {
        try {
          sessionStorage.setItem(RESUME_KEY, JSON.stringify({ gapEndsAt, passCount }));
        } catch (_) {
          // No storage: the loop simply waits out the whole gap again after the reload.
        }
        reload(nextUrl());
      }, delay);
    } else {
      reloadAt = null;
      gapTimer = setTimeout(nextPass, left);
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
    if (phase === "idle-wait" && !bandUp) return;
    console.warn("exhibit attract: playback refused — waiting for the first touch", err?.name || err);
    phase = "locked";
    started = false;
    room.stopMirror();
    clearTimeout(gapTimer);
    raiseBand();
  }

  /** This screen was touched: the loop stops SCHEDULING; whatever plays, plays on (R7). */
  function endLoop() {
    phase = "idle-wait";
    started = false;
    clearTimeout(gapTimer);
    gapEndsAt = null;
    reloadAt = null;
    forgetResume();
  }

  function forgetResume() {
    try {
      sessionStorage.removeItem(RESUME_KEY);
    } catch (_) {
      /* no storage */
    }
  }

  // ---- resume after a reload in the silence -------------------------------------------------
  // The ROOM's gap first (the worker's welcome snapshot: a window connecting
  // while the room is in its silence joins it, with the shared end time and
  // pass count — this is how a window back from its reload carries on); the
  // sessionStorage record this window wrote before it reloaded is the FALLBACK,
  // for a fresh worker (a single-screen room, or both windows gone at once) and
  // for the channel path.
  let stored = null;
  try {
    const raw = sessionStorage.getItem(RESUME_KEY);
    if (raw) {
      sessionStorage.removeItem(RESUME_KEY);
      stored = JSON.parse(raw);
    }
  } catch (_) {
    /* no storage */
  }
  const resumeFrom = (snapshot) => {
    const gap = snapshot?.loop?.gap;
    if (gap && Number(gap.endsAt) > now()) resumeGap(Number(gap.endsAt), Number(snapshot.loop.passCount) || 0, "room");
    else if (stored) resumeGap(Number(stored.gapEndsAt) || now(), Number(stored.passCount) || 0, "storage");
    stored = null;
  };
  if (room.worker) {
    if (room.snapshot) resumeFrom(room.snapshot);
    else {
      const off = room.worker.onMessage((msg) => {
        if (msg.type !== "welcome") return;
        off();
        if (phase === "idle-wait") resumeFrom(msg.snapshot);
      });
    }
  } else if (stored) {
    resumeFrom(null);
  }

  /** Straight into the room's gap after a reload: band up, table swept, the next pass at its end. */
  function resumeGap(endsAt, count, from) {
    resumed = true;
    resumedFrom = from;
    passCount = count;
    phase = "gap";
    sweep();
    raiseBand();
    gapEndsAt = Math.max(now(), endsAt);
    clearTimeout(gapTimer);
    gapTimer = setTimeout(nextPass, gapEndsAt - now());
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
        presence: presence.kind,
        peers: presence.peers(),
        idleMs,
        gapMs,
        quietMs: now() - presence.quietSince(),
        quietHereMs: now() - lastLocal,
        roomIdle: presence.idle(),
        started,
        passCount,
        audience,
        steps: steps.map((s) => ({ ...s })),
        pointer,
        nextAt: next && file ? timeFor(file, next.ix) : null,
        gapEndsAt,
        reloadAt,
        resumed,
        resumedFrom,
        takenOver,
        mirroring: room.mirroring,
        muted: transport.muted,
        audible: audible(),
        peerAudible: peerAudible(),
        lastSync: room.state().lastSync,
        id,
      };
    },
    /** Start now, whatever the clocks say (tests, and the study panel's demo button): the room counts as idle. */
    force() {
      if (phase === "idle-wait") raise(true);
    },
    /** Register an interaction without a pointer event (tests): the room's touch, hand-off included. */
    touch: room.touch,
    /** True while a pass of the loop is what drives the transport: main.js claims the speakers as "loop". */
    drivesAudio() {
      return phase === "attract" && !room.mirroring;
    },
    /** Tear down: timers, the room subscriptions, the band. The channel is the room's. */
    destroy() {
      clearInterval(evalTimer);
      clearTimeout(gapTimer);
      unsubscribePresence();
      unsubscribeTouch();
      unsubscribeRefused();
      presence.destroy();
      el.remove();
    },
  };
}

// ---------------------------------------------------------------------------
// PRESENCE: the room's facts the loop reads, behind one seam.
//
//   quietSince()   the latest touch anywhere in the room (this screen included)
//   idle()         the room is idle: idleMs > 0 and quiet for at least idleMs
//   isLeader()     this window plays the pass when the room is silent
//   peerAudible()  another window's music is on the speakers
//   peers()        live windows besides this one
//   postActivity() a touch here; postGap(endsAt) this window's pass ended
//   announce()     say where we stand at once (the take-over)
//   onEvent(fn)    {type: "activity"} · {type: "gap", endsAt}
// ---------------------------------------------------------------------------

/**
 * Presence from the room's SharedWorker (room=shared with a worker; protocol
 * 2): the facts are the worker's — every window stamps its touches there
 * (room.js's touch() sends `activity`), the worker keeps the latest touch,
 * the idle verdict, the leader among the LIVE windows, the speakers, and the
 * gap — and this window reads them from the latest snapshot. An idle room
 * waking on the other screen's touch arrives as a `wake` event at once; a
 * pass ending anywhere as `gap`.
 */
function workerPresence({ room, now }) {
  const { id } = room;
  const link = room.worker;
  const subs = new Set();
  const snap = () => room.snapshot;
  const emit = (ev) => {
    for (const fn of subs) {
      try {
        fn(ev);
      } catch (err) {
        console.warn("exhibit attract: presence subscriber threw", err);
      }
    }
  };
  const unsubscribe = link.onMessage((msg) => {
    const ev = msg?.event;
    if (!ev) return;
    if (ev.type === "wake" && ev.byId !== id) emit({ type: "activity", byId: ev.byId });
    else if (ev.type === "gap" && ev.byId !== id) emit({ type: "gap", endsAt: Number(ev.endsAt) || undefined });
  });
  return {
    kind: "worker",
    quietSince: () => snap()?.loop?.quietSince ?? now(),
    idle: () => Boolean(snap()?.loop?.idle),
    isLeader: () => snap()?.leader === id,
    peerAudible: () => {
      const a = snap()?.audible;
      return Boolean(a && a.id !== id);
    },
    peers: () => Math.max(0, (snap()?.windows?.length ?? 1) - 1),
    // room.js's touch() has already sent the activity intent: nothing to add.
    postActivity: () => {},
    postGap: (endsAt) => link.send({ type: "gap", endsAt }),
    announce: () => {},
    onEvent(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    destroy() {
      unsubscribe();
      subs.clear();
    },
  };
}

/**
 * Presence over the room's BroadcastChannel — the v2 path: hello every 5 s
 * with this window's latest touch and audibility, a 15 s TTL, activity and
 * gap messages, the leader the lowest id among the live windows (or the
 * worker's registry, when the room has one). Used under room=off, and under
 * room=shared when there is no SharedWorker.
 */
function channelPresence({ room, now, idleMs, lastActivity, audible }) {
  const { id, post } = room;
  const peers = new Map(); // id -> {lastSeen, lastActivity, audible}
  const subs = new Set();
  const emit = (ev) => {
    for (const fn of subs) {
      try {
        fn(ev);
      } catch (err) {
        console.warn("exhibit attract: presence subscriber threw", err);
      }
    }
  };
  const hello = () => post({ type: "hello", lastActivity: lastActivity(), audible: audible() });
  const unsubscribe = room.onMessage((msg) => {
    const known = peers.has(msg.id);
    const peer = peers.get(msg.id) ?? { lastSeen: 0, lastActivity: 0 };
    peer.lastSeen = now();
    if (msg.type === "hello") {
      peer.lastActivity = Math.max(peer.lastActivity, Number(msg.lastActivity) || 0);
      peer.audible = Boolean(msg.audible);
    } else if (msg.type === "sync") {
      // The room's audible state, from whichever window is on the speakers;
      // the room has already mirrored it (room.js). Only the peer's audibility
      // is the loop's business here.
      peer.audible = Boolean(msg.playing);
    } else if (msg.type === "gap") {
      peers.set(msg.id, peer);
      emit({ type: "gap", endsAt: Number(msg.gapEndsAt) || undefined });
      return;
    } else if (msg.type === "activity") {
      peer.lastActivity = now();
      peers.set(msg.id, peer);
      emit({ type: "activity", byId: msg.id });
      return;
    } else if (msg.type === "bye") {
      peers.delete(msg.id);
      return;
    }
    peers.set(msg.id, peer);
    // A newcomer learns of us at once rather than at the next heartbeat, so
    // both windows agree on the leader within a round trip.
    if (!known) hello();
  });
  const purge = () => {
    for (const [pid, p] of peers) if (now() - p.lastSeen > PEER_TTL_MS) peers.delete(pid);
  };
  const helloTimer = setInterval(() => {
    purge();
    hello();
  }, HELLO_MS);
  hello();
  const bye = () => post({ type: "bye" });
  window.addEventListener("pagehide", bye);
  const quietSince = () => {
    let q = lastActivity();
    for (const p of peers.values()) q = Math.max(q, p.lastActivity);
    return q;
  };
  return {
    kind: "channel",
    quietSince,
    idle: () => idleMs > 0 && now() - quietSince() >= idleMs,
    // With the room's worker the leader is the lowest LIVE screen (room.js reads
    // the snapshot; deterministic: screen 0 leads); without it the lowest id.
    isLeader() {
      const fromRoom = room.leaderId?.();
      return fromRoom != null ? fromRoom === id : [...peers.keys(), id].sort()[0] === id;
    },
    peerAudible: () => [...peers.values()].some((p) => p.audible),
    peers: () => peers.size,
    postActivity: () => post({ type: "activity" }),
    postGap: (endsAt) => post({ type: "gap", gapEndsAt: endsAt }),
    announce: hello,
    onEvent(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    destroy() {
      clearInterval(helloTimer);
      unsubscribe();
      window.removeEventListener("pagehide", bye);
      subs.clear();
      bye();
    },
  };
}
