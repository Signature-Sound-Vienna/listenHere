// exhibit/main.js
//
// The wiring. Everything interesting lives in the modules this pulls together;
// what is here is the geometry, the boot sequence, and the one loop that keeps
// sixteen cursors on the same musical moment.
//
// THE LOOP IS THE POINT OF THE WHOLE EXHIBIT, so it is worth being explicit about
// what it does. One recording is audible. Its player is the clock. Every frame, the
// clock's time is turned into an alignment index once, and that index is read back
// out of every other recording's grid — so a cursor on each strip stands at *the
// same place in the piece*, not at the same number of seconds. That is the thing
// visitors are being asked to see, and it is one call to `align-core` per frame
// rather than a reimplementation, because two consumers with their own copy of that
// arithmetic is how they start disagreeing about which moment an annotation is
// about.
//
// THE RULE: no import of `js/listen.js`, at any depth. Enforced by
// tests/e2e/33-exhibit-boundary.spec.ts, ratcheted at zero. Anything the engine
// will not give us gets copied WITH A ROW IN ENGINE-WANTS.md.

import {
  readConfig, rotationFor, bandOrientationFor, bandTapFor, viewsEnabled, DEFAULTS,
} from "./config.js";
import { resolveText, setDebug, t } from "./strings.js";
import {
  getClosestAlignmentIx,
  getCorrespondingTime,
} from "../js/engine/align-core.js";
import { configureGroupingCore, safeColor } from "../js/engine/grouping-core.js";
import { AUDIENCES, loadExhibitData, metadataFor, portraitUrl } from "./payload.js";
import { mountStrips } from "./strips.js";
import { createStrap } from "./strap.js";
import { createMarkerLayer } from "./marker.js";
import { syncRegions } from "./regions.js";
import { Transport } from "./audio.js";
import { TurnTaking, bandTapViewport } from "./turns.js";
import { createArbiter } from "./arbiter.js";
import { AudienceStore, buildAudienceSwitch } from "./audience.js";
import { createViewportZoom } from "./zoom.js";
import { applyTheme, annotationSeries, recolorAnnotations } from "./themes.js";
import { createMiddleBand } from "./middle-band.js";
import { createAnnotationList, groupForFileIn, hasGroupStory } from "./annotation-list.js";
import { loadConcerts } from "./concerts.js";

const config = readConfig();
setDebug(config.debug);

// ---------------------------------------------------------------------------
// The exhibit is a SECOND host for the grouping read model, and this is the whole
// point of the injected context: it hands over its own alignment and its own
// score key without listen.js being anywhere in the graph. The payload is not
// loaded yet, so this reads from a holder the loader fills.
// ---------------------------------------------------------------------------
const data = {
  alignment: null, // the merged exhibit payload, once the loader has run
  grids: {}, // filename -> number[] of times, for align-core
  exhibit: null, // the indexed view of it, from payload.js
  // The transport, for the few module-level renderers that need to know what
  // is AUDIBLE rather than what a viewport chose — the per-recording note is
  // the first (renderAnnotations). Same holder idiom as the payload above,
  // rather than threading the transport through every render signature.
  transport: null,
  // The turn machine, for the same reason: the by-year explorer's "listen"
  // tap is a bare recording switch made from a module-level view.
  turns: null,
};

/** The recording the shared clock is on, or null before the first selection. */
function activeFileForNotes() {
  return data.transport?.activeFile || null;
}

configureGroupingCore({
  getAlignment: () => data.alignment,
  // The exhibit's score view is an optional bonus (plan §8) and the synthesised
  // score is not part of the curated set, so nothing is ungroupable-by-key here.
  // Naming it explicitly beats inheriting a default we did not choose.
  SYNTH_MEI_KEY: null,
});

/**
 * Project a time in the active recording onto every other recording's timeline.
 *
 * This is the operation the stacked layout exists to show — the shared clock runs
 * on whichever recording is playing, and each other strip must show where that
 * moment falls in ITS OWN timeline. It is one line here because align-core is
 * shared rather than reimplemented; a copy is how two consumers start disagreeing
 * about what an alignment index means.
 *
 * @param {number} time          seconds in `activeFile`'s timeline
 * @param {string} activeFile    the recording the clock is running on
 * @param {string[]} others      recordings to project onto
 * @returns {Record<string, number|undefined>} per-recording seconds
 */
export function projectPlayhead(time, activeFile, others) {
  const ix = getClosestAlignmentIx(data.grids, time, activeFile);
  const out = {};
  for (const f of others) out[f] = getCorrespondingTime(data.grids, f, ix);
  return out;
}

/**
 * Cursor positions for every recording, given the clock.
 *
 * Differs from projectPlayhead in one deliberate way: the ACTIVE recording gets
 * the clock's exact time, not the time of the nearest grid entry. Rounding the
 * playing recording to its own grid would make its cursor advance in 20 ms
 * staircase steps while the audio ran smoothly — visible, and wrong in the one
 * place the exhibit has ground truth.
 */
function positionsFor(time, activeFile) {
  if (!activeFile) return {};
  const out = projectPlayhead(time, activeFile, data.exhibit.order);
  out[activeFile] = time;
  return out;
}

// ---------------------------------------------------------------------------
// The side slot's tenants (?sideSlot=<name>, feedback item 5). The screen has
// a MAIN CONTENT area (the strips, full width or sharing with the side panel)
// and a BELOW CONTENT area (the annotation chips, always — plus the
// commentary body whenever no tenant has taken it to the side). The slot, the
// CSS, and the parameter know nothing about annotations, because the Verovio
// score view (plan §2.3) is the confirmed second tenant — and when the score
// takes the panel, the annotations body simply stays below with the chips,
// which is its default rendering. A tenant is a function from a booted
// viewport to the element that fills the PANEL; adding one is an entry here
// plus its module.
// ---------------------------------------------------------------------------
const SIDE_TENANTS = {
  // First tenant: the commentary BODY (text + group story) — the chips stay
  // below the strips in either layout, so the same cards drive both.
  annotations: (vp) => vp.annList.bodyEl,
};

// ---------------------------------------------------------------------------
// Geometry. Two halves of a portrait screen, the far one rotated, with the middle
// band between them — carrying conductor, year, and portrait, and NO UI labels,
// because a caption would have to pick a language for a surface two people read
// from opposite sides (plan §6.3).
// ---------------------------------------------------------------------------
function buildScreen(root) {
  root.textContent = "";
  root.style.setProperty("--strip-height", config.stripHeight + "px");
  root.style.setProperty("--side-slot-w", config.sideSlotWidth + "%");
  // Rotated band text pays for its length vertically, so that orientation gets
  // a taller band by default — but an EXPLICIT ?middleBandHeight= always wins,
  // because the whole point of the orientation switch is comparing variants
  // whose geometry the user can still pin down per URL.
  const bandOrientation = bandOrientationFor(config);
  const bandHeight =
    bandOrientation === "rotated" && config.middleBandHeight === DEFAULTS.middleBandHeight
      ? config.middleBandHeightRotated
      : config.middleBandHeight;
  root.style.setProperty("--middle-band-height", bandHeight + "px");
  root.dataset.split = config.splitOrientation;
  // The desktop-debug stage rotation (config.js). Only the two values the CSS
  // knows how to place are honoured — a typo'd angle silently painting the
  // screen off-viewport would be a miserable thing to debug on a rotated laptop.
  if (config.stageRotation) {
    if (config.stageRotation === 90 || config.stageRotation === 270) {
      root.dataset.stageRotation = String(config.stageRotation);
    } else {
      console.warn(
        `exhibit: stageRotation ${config.stageRotation} is not 90 or 270 — ignored`,
      );
    }
  }

  const viewports = [];
  const bands = [];
  // ONE BAND PER GAP is the two-sided rule, and with a single viewport there is
  // no gap — which used to mean no band at all. That was never a decision: the
  // band is also the only place the exhibit carries the discographic identity
  // (conductor, orchestra, year, portrait) and the ONLY play/pause and time
  // readout anywhere in the interface, so a single-viewport screen lost the
  // transport with them (Chanda, demo feedback 2026-09-01). The band is built
  // either way, so the whole bug was that nothing ever mounted it.
  //
  // It goes at the TOP for one reader — the "now playing" position — which
  // needs the plain column direction: the two-sided layout is column-REVERSE so
  // that viewport 0 sits at the near edge, and under that a first child renders
  // at the bottom. One viewport has nothing to reverse, so the attribute turns
  // the reversal off and DOM order is reading order again.
  if (config.viewports === 1) {
    root.dataset.singleViewport = "1";
    const slot = document.createElement("div");
    slot.className = "middle-band-slot";
    root.appendChild(slot);
    bands.push(slot);
  }
  for (let i = 0; i < config.viewports; i++) {
    if (i > 0) {
      // One band per gap. It is built later than the viewports because it needs
      // the metadata sidecar; until then the gap holds a placeholder of the right
      // height so the strips do not move when the data lands.
      const slot = document.createElement("div");
      slot.className = "middle-band-slot";
      root.appendChild(slot);
      bands.push(slot);
    }
    const vp = document.createElement("section");
    vp.className = "vp";
    vp.dataset.viewport = String(i);
    // Per-viewport, because the two halves resolve audience and language
    // independently and may differ at the same moment.
    vp.dataset.audience = config.audiences[i] ?? config.audiences[0];
    vp.dataset.language = config.languages[i] ?? config.languages[0];
    // Set BEFORE any strip mounts, like the side slot below: the strap's
    // reserved padding narrows the strips column, and WaveSurfer sizes its
    // canvases from the width it sees at creation. The button rail mounts
    // later (absolutely positioned, so it costs no re-measure); the leather
    // BAND — viewport-tall, sliding under the middle band — is pure paint
    // and mounts here.
    if (config.tapMode === "direct") {
      vp.dataset.tapMode = "direct";
      const strapBand = document.createElement("div");
      strapBand.className = "vp-strap-band";
      vp.appendChild(strapBand);
    }
    // The marker's hook rail lives in the same reserved column as the strap,
    // and aligned mode has no strap — so the marker reserves the column
    // itself (the CSS unions the two selectors into one padding), and it must
    // do so HERE for the same canvas-sizing reason as the strap above.
    if (config.marker === "glass") vp.dataset.marker = "glass";
    // Set BEFORE any strip mounts, like the strap and the side slot above: the
    // caption column reserves the note dot's width, and reserving it later
    // would shift ten captions sideways after the visitor could already read
    // them. Pure paint, so unlike the strap it costs no canvas re-measure.
    if (config.targetNotes === "on") vp.dataset.targetNotes = "on";
    // The grouping edge's WIDTH is part of the strip's border box, so a
    // waveform sized at creation would be a few pixels wrong if this arrived
    // later — the same before-any-strip-mounts rule as the strap above, and
    // the reason this is set here rather than when a grouping first paints.
    if (config.groupIndicator !== "edge") vp.dataset.groupIndicator = config.groupIndicator;
    const rot = rotationFor(config, i);
    if (rot) vp.style.transform = `rotate(${rot}deg)`;

    const strips = document.createElement("div");
    strips.className = "strips";
    vp.appendChild(strips);

    // The side slot's shell is built HERE, before any strip mounts, because the
    // grid narrows the strips column and WaveSurfer sizes its canvases from the
    // width it sees at creation. The tenant's content arrives in boot; only a
    // KNOWN tenant reshapes the layout — an empty 40% column beside narrowed
    // waveforms is a worse failure than ignoring a typo.
    let sideSlot = null;
    if (config.sideSlot) {
      if (SIDE_TENANTS[config.sideSlot]) {
        vp.dataset.sideSlot = config.sideSlot;
        sideSlot = document.createElement("aside");
        sideSlot.className = "vp-side-slot";
        sideSlot.dataset.tenant = config.sideSlot;
        vp.appendChild(sideSlot);
      } else if (i === 0) {
        console.warn(`exhibit: unknown side-slot tenant "${config.sideSlot}" — ignored`);
      }
    }

    // Inside the strips container, absolutely positioned over it (exhibit.css):
    // out of the flow entirely, so the transient "Loading…" can never move a
    // strip — the stronger form of 34.10's reserved-height fix, adopted when
    // week 2's commentary panel needed the line's 30 px back.
    const status = document.createElement("p");
    status.className = "vp-status";
    status.textContent = t("state.loading", vp.dataset.language);
    strips.appendChild(status);

    // The turn-taking surface (turns.js): the request prompt on the holder's
    // half, the waiting note on the requester's, and the transient notices.
    // Overlaid like the status line, but interactive — it carries the grant
    // and deny buttons — so it is its own element rather than a status state.
    const turn = document.createElement("div");
    turn.className = "vp-turn";
    turn.hidden = true;
    strips.appendChild(turn);

    root.appendChild(vp);
    viewports.push({
      index: i,
      el: vp,
      stripsEl: strips,
      statusEl: status,
      turnEl: turn,
      turnNotice: 0,
      sideSlotEl: sideSlot,
      language: vp.dataset.language,
      strips: new Map(),
      annList: null,
      // Focus state, split per the agreed definition (2026-08-25):
      //   washIds — the MOMENTARY wash: every annotation with a region under
      //             the playhead paints its strip-side surfaces (chip
      //             highlight, region emphasis, strip deemphasis) — the UNION
      //             at overlaps (ruled 2026-08-25). Under focusWash=clear it
      //             empties when the playhead leaves; under =sticky it holds
      //             the single latest-start winner, week 3's comparator.
      //   washId  — the latest-start PRIMARY of that set (null when empty):
      //             the one annotation whose group edges paint, and the one
      //             the detail follows.
      //   shownId — the STICKY detail: the annotation whose commentary shows.
      //             Exits never blank it — only the machine's unfocus (the
      //             below-layout toggle-off, the side panel's ×, an audience
      //             switch, a pin expiry) does, so text is never snatched
      //             mid-read.
      //   washEntries/washHold/washTimer — the minimum-lifetime bookkeeping
      //             (config.focusHoldMs): entry timestamps, exited ids held to
      //             their deadline, and the timer that repaints when a hold
      //             runs out.
      washIds: [],
      washId: null,
      shownId: null,
      washEntries: new Map(),
      washHold: new Map(),
      washTimer: 0,
      // The "Keep reading…" countdown (config.pinExpiry, config.panelFollow):
      // deadline, total, ticker, the ring element, and what a ring tap
      // re-arms — the pin's expiry clock or the wash's reading window,
      // whichever armed last.
      pinDeadline: null,
      pinTotalMs: 0,
      pinTicker: 0,
      expiryEl: null,
      ringRearm: null,
      // ?detailFade: the shown text's lifecycle — when it went on show, its
      // window, whether a ring tap bumped it to the full window, the bump's
      // deadline, a switch deferred by the focusHoldMs floor, the deadline a
      // time-jump pulled forward (the "Keep reading…" countdown, ruled
      // 2026-08-25 — relevance voids it), and the two timers (the 200 ms
      // ticker; the fade-out animation step). All stamps and deadlines are in
      // READING-CLOCK time (see boot), so the pause button freezes them.
      shownAt: null,
      shownMs: 0,
      shownBumped: false,
      fadeBumpUntil: 0,
      fadePending: false,
      fadeCapAt: 0,
      fadeTicker: 0,
      fadeTimer: 0,
      // ?focus=playhead (config.js): whether a tap has pinned the focus against
      // the follow machinery (paint AND detail hold on shownId), and the last
      // SET of annotations the playhead was inside (as a joined key) — the
      // edge detector that makes following event-driven rather than a
      // per-frame overwrite of whatever the visitor just did.
      focusPinned: false,
      followLast: null,
      panelOpen: false,
      // ?views / ?viewSwitch / ?bandTap (plan §11): which view this half
      // shows, the toolbar switch that changes it (the fallback entry), and
      // the explorers once built, by name — kept across switches so a
      // re-entry costs no rebuild.
      view: "listen",
      viewSwitchEl: null,
      views: {},
    });
  }
  return { viewports, bands };
}

// ---------------------------------------------------------------------------
// Views (plan §11). "listen" is the shipped interface; "years" and "conductors"
// draw an explorer OVER this viewport's strips and commentary (years-view.js
// says why over rather than instead). Per viewport and in-session: one half
// explores while the other keeps listening, and nothing reloads (user ruling
// 2026-09-02). The modules and the sidecar are fetched only when an entry is
// configured — the toolbar switch, or the band's tappable facts — so the
// default kiosk stays byte-identical on the wire.
//
// TWO WAYS IN, ONE WAY BACK (plan §11(f), ruled 2026-09-02). The ruled entry is
// the MIRRORED BAND: tap the year, tap the conductor, and the tapping reader's
// half opens the matching explorer on that fact — "current" is the audible
// recording's, which is what the band shows. The toolbar switch of 0.50.0
// stays as the debug and fallback entry (`?viewSwitch=1`). The way back is
// INSIDE the overlay: a close control this file adds to every explorer (the
// side panel's × precedent), so an explorer opened from the band can always be
// left, switch or no switch.
// ---------------------------------------------------------------------------
const VIEWS = ["listen", "years", "conductors"];
let viewModules = null;   // { years, conductors }: Promise<module> each, once an entry is configured
let concertsData;         // Promise<Concerts|null> once asked; undefined = never asked
let concertsResolved;     // the settled value of the above; undefined until it lands
let bandHandle = null;    // the middle band, once built (its facts re-ask when the sidecar lands)

/**
 * The series' conductor of a payload recording, or null when the series does
 * not know them — the payload's own name, checked against the sidecar's index
 * (the two archives spell every conductor the way the payload does today; a
 * spelling the series lacks simply makes the fact not tappable, never wrong).
 */
function concertConductorOf(file) {
  const name = file && data.exhibit ? metadataFor(data.exhibit, file).conductor : "";
  return name && concertsResolved?.byConductor.has(name) ? name : null;
}

function positionView(vp) {
  // The overlay starts where the toolbar ends. Layout values, not painted
  // ones: the far half is rotated 180°, and offsetTop/offsetHeight do not
  // know that, which is exactly what makes them right here.
  const bar = vp.el.querySelector(".vp-toolbar");
  if (!bar) return;
  vp.el.style.setProperty("--vp-view-top", `${bar.offsetTop + bar.offsetHeight + 4}px`);
}

function paintViewSwitch(vp) {
  if (!vp.viewSwitchEl) return;
  for (const b of vp.viewSwitchEl.querySelectorAll(".view-btn")) {
    const on = b.dataset.view === vp.view;
    b.classList.toggle("is-on", on);
    b.setAttribute("aria-pressed", on ? "true" : "false");
  }
}

function buildViewSwitch(vp) {
  const bar = document.createElement("div");
  bar.className = "view-switch";
  bar.dataset.viewport = String(vp.index);
  for (const name of VIEWS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "view-btn";
    b.dataset.view = name;
    b.textContent = t("view." + name, vp.language);
    b.addEventListener("click", () => setView(vp, name));
    bar.appendChild(b);
  }
  vp.viewSwitchEl = bar;
  paintViewSwitch(vp);
  return bar;
}

/**
 * Where an explorer opens: the fact the visitor tapped when there is one
 * (`opening.year` / `opening.conductor`, from the band), else what the audible
 * recording says — the band's own reading of "current" (§11(f)). Null leaves
 * the view its own resting choice.
 */
function openingFor(name, opening) {
  const file = data.transport?.activeFile;
  if (name === "years") return opening.year ?? concertsResolved?.yearOf(file) ?? null;
  if (name === "conductors") return opening.conductor ?? concertConductorOf(file);
  return null;
}

/** Build an explorer for `vp`, with the close control that is its way back. */
function buildView(name, m, vp, concerts, opening) {
  const exhibit = data.exhibit;
  const common = {
    viewport: vp.index,
    language: vp.language,
    concerts,
    piece: exhibit.piece,
    portraitUrl: (path) => portraitUrl({ portrait: path }),
    // The way from a concert into its music: the BARE aligned switch a strip
    // tap makes (turns.request with no time — a standing marker catches it,
    // per the marker ruling), then back to the listening view so the reader
    // sees the recording they asked for.
    onListen: (file) => {
      if (vp.bareSwitch) vp.bareSwitch(file);
      else data.turns?.request(vp.index, file, undefined);
      setView(vp, "listen");
    },
  };
  const at = openingFor(name, opening);
  const handle =
    name === "years"
      ? m.createYearsView({ ...common, initialYear: at })
      : m.createConductorsView({ ...common, initialConductor: at });
  // The way back, inside the overlay (plan §11(f)): the band is the way in and
  // the toolbar switch only the fallback, so the overlay itself must be
  // leavable. An × like the side panel's, in the overlay's top-right corner.
  const close = document.createElement("button");
  close.type = "button";
  close.className = "view-close";
  close.textContent = "×";
  close.setAttribute("aria-label", t("view.close", vp.language));
  close.addEventListener("click", () => setView(vp, "listen"));
  handle.el.appendChild(close);
  return handle;
}

/**
 * Switch one viewport's view, optionally onto a fact (`opening.year` /
 * `opening.conductor` — a band tap). Async only because the explorers' modules
 * and data load lazily; the switch paints at once, the overlay lands when
 * ready. Asking for the view already up is not a no-op when a fact comes with
 * it: the explorer moves to that fact, which is what a second band tap means.
 */
async function setView(vp, name, opening = {}) {
  if (!VIEWS.includes(name)) {
    console.warn(`exhibit: unknown view "${name}" — ignored`);
    return;
  }
  if (name !== "listen" && !viewModules) {
    console.warn(`exhibit: view "${name}" asked for with no entry configured — ignored`);
    return;
  }
  if (vp.view === name) {
    if (name !== "listen" && vp.views[name]) {
      const at = openingFor(name, opening);
      if (at != null) vp.views[name].select(at);
    }
    return;
  }
  const leaving = vp.view;
  vp.view = name;
  vp.el.dataset.view = name;
  paintViewSwitch(vp);
  // This reader's band copy stands its cue down on the fact that opened the
  // view (mirrored only; the band decides). Also pushed when the band is built.
  bandHandle?.setCurrentView(vp.index, name);
  vp.views[leaving]?.el.remove();
  if (name === "listen") return;
  let handle = vp.views[name];
  if (!handle) {
    const [m, concerts] = await Promise.all([viewModules[name], concertsData]);
    if (vp.view !== name) return; // switched away while loading
    handle = vp.views[name] = buildView(name, m, vp, concerts, opening);
  } else {
    // Re-entering: onto the tapped fact, else the audible recording's.
    const at = openingFor(name, opening);
    if (at != null) handle.select(at);
  }
  positionView(vp);
  vp.el.appendChild(handle.el);
  handle.refit?.();
}

const root = document.getElementById("screen");
// Theme before anything renders: the CSS tokens flip instantly, and the wave
// colours have to exist before the first strip is created (they are WaveSurfer
// options, not CSS). Takes the whole config — the preset plus any per-category
// pins (themeWaves, themeBand, …).
const themeColors = applyTheme(config);
// Non-null only when ?annotationColors=theme: the diverging series that
// replaces the authored annotation/group colours at render time.
const annotationPalette =
  config.annotationColors === "theme" ? annotationSeries(config) : null;
const { viewports, bands } = buildScreen(root);
document.title = t("app.title", config.languages[0]);

// The staff-facing study panel, opt-in and lazily imported: visitors' kiosks
// never even fetch the module.
if (config.studyPanel) {
  import("./study-panel.js")
    .then((m) => m.mountStudyPanel(config))
    .catch((e) => console.warn("exhibit: study panel failed to load", e));
}

// Kiosk touch guards (plan §4.2). The declarative layers — `touch-action:
// pan-x pan-y` in exhibit.css (pinch and double-tap zoom both refused, panning
// kept) and the viewport meta's maximum-scale — cover every engine that honours
// them; iOS Safari's page pinch predates touch-action and can ignore both, and
// its proprietary gesture events are the reliable veto. Belt and braces,
// because the failure mode is a visitor pinching the whole exhibit sideways
// and the next visitor finding it that way.
for (const type of ["gesturestart", "gesturechange", "gestureend"]) {
  document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
}

// A single hook for the Playwright smoke tests, mirroring listen.js's
// `_listenTest` convention so the exhibit is drivable the same way. `ready`
// resolves when the boot sequence has finished, so a spec can await the load
// instead of polling for strips to appear.
let _signalReady;
window._exhibitTest = {
  config,
  data,
  viewports,
  annotationPalette,
  projectPlayhead,
  positionsFor,
  // Views (plan §11): which view each half shows, a programmatic switch (the
  // readingClock.advance precedent — the semantic path without the tap), and
  // the explorer's own state.
  view: (i) => viewports[i]?.view ?? null,
  setView: (i, name, opening) => setView(viewports[i], name, opening),
  yearsView: (i) => viewports[i]?.views.years?.state() ?? null,
  conductorsView: (i) => viewports[i]?.views.conductors?.state() ?? null,
  ready: new Promise((resolve) => {
    _signalReady = resolve;
  }),
};

// ---------------------------------------------------------------------------
// Boot.
// ---------------------------------------------------------------------------
boot().then(
  (ok) => _signalReady(ok),
  (e) => {
    // The catch is here rather than inside boot so that a failure anywhere in the
    // sequence lands in one place and says the same thing on the glass.
    console.error("exhibit: boot failed", e);
    for (const vp of viewports) {
      vp.statusEl.textContent = t("state.dataError", vp.language);
      vp.statusEl.dataset.state = "error";
    }
    _signalReady(false);
  },
);

async function boot() {
  const exhibit = await loadExhibitData({ piece: config.piece, debug: config.debug });
  data.exhibit = exhibit;
  // grouping-core reads the payload through the holder, and align-core reads the
  // grids. Both are set before anything can ask a question of either.
  data.alignment = exhibit.payload;
  data.grids = exhibit.grids;
  window._exhibitTest.exhibit = exhibit;

  // The explorers' modules and the concerts sidecar, started now so the first
  // tap is instant — but only when an entry is configured (the toolbar switch
  // or the band's tappable facts): the shipped kiosk never fetches any of it.
  if (viewsEnabled(config)) {
    viewModules = {
      years: import("./years-view.js"),
      conductors: import("./conductors-view.js"),
    };
    concertsData = loadConcerts({ debug: config.debug });
    concertsData.then((c) => {
      concertsResolved = c;
      window._exhibitTest.concerts = c;
      // The band's facts could not lead anywhere until now.
      bandHandle?.refresh();
    });
    window.addEventListener("resize", () => {
      for (const vp of viewports) if (vp.view !== "listen") positionView(vp);
    });
  }

  const store = new AudienceStore(
    Array.from({ length: config.viewports }, (_, i) =>
      config.audiences[i] ?? config.audiences[0],
    ),
    // ?audienceAll=1 appends the "all" pseudo-mode: the switch renders it like
    // any other position, and renderAnnotations unions the lists. The store's
    // own validation then also accepts ?audiences=all,adults as starting values
    // — but only when the option is offered at all.
    config.audienceAll ? [...AUDIENCES, "all"] : AUDIENCES,
  );
  window._exhibitTest.audience = store;

  const transport = new Transport({
    audio: exhibit.audio,
    durations: exhibit.durations,
    // The transport is handed the projection rather than importing align-core, so
    // it has no opinion about how a moment maps between recordings — it only knows
    // that switching recording should preserve one.
    project: (time, from, to) => projectPlayhead(time, from, [to])[to],
    playerCache: config.playerCache,
    debug: config.debug,
  });
  window._exhibitTest.transport = transport;
  // The module-level holder, so renderAnnotations can ask what is audible.
  data.transport = transport;

  // THE READING CLOCK (ruled 2026-08-25): every fade and expiry window counts
  // only time the music actually runs. The pause button freezes a reader's
  // remaining window and play resumes it where it stopped — so a paused table
  // never quietly expires what somebody may still be reading, and a silent
  // one never starts a countdown at all. One clock for the whole screen,
  // because there is one transport. `advance` is the test hook: specs drive
  // the timer machinery deterministically, the way seeks drive the follow
  // machinery, instead of waiting out real windows against real audio.
  let readingBase = 0;
  let readingMark = null; // performance.now() at last play start; null while silent
  const readingNow = () =>
    readingBase + (readingMark != null ? performance.now() - readingMark : 0);
  transport.subscribe((state) => {
    if (state.playing && readingMark == null) {
      readingMark = performance.now();
    } else if (!state.playing && readingMark != null) {
      readingBase += performance.now() - readingMark;
      readingMark = null;
    }
  });
  window._exhibitTest.readingClock = {
    now: readingNow,
    advance: (ms) => {
      readingBase += ms;
    },
  };

  // Every strip tap goes through the turn-taking machine (turns.js), which
  // decides — by the ?turnPolicy in force — whether it reaches the transport
  // now, announced, or as a request the other side grants. The default policy
  // is a transparent pass-through, so the shipped tap behaviour is unchanged.
  const turns = new TurnTaking({
    transport,
    policy: config.turnPolicy,
    grantMs: config.turnGrantMs,
    denyCooldownMs: config.turnDenyCooldownMs,
  });
  window._exhibitTest.turns = turns;
  data.turns = turns;
  // The resolved configuration, so a spec can assert against the value in
  // force rather than restating it — the same discipline as reading the shown
  // set from the payload instead of hardcoding eight (the 34.13/38.4 lesson).
  window._exhibitTest.config = config;

  // Room-level audio arbitration (arbiter.js): claim on every silence-to-sound
  // transition, pause when another screen claims. The default "local" arbiter
  // is inert, so this wiring costs nothing until ?arbiter=broadcast opts in.
  // The claim hangs off the transport's own state rather than off the taps, so
  // the band's shared play button claims exactly like a strip tap does.
  const arbiter = createArbiter(config.arbiter);
  window._exhibitTest.arbiter = arbiter;
  arbiter.onRevoked(() => transport.pause());
  {
    let wasAudible = false;
    transport.subscribe((state) => {
      if (state.playing && !wasAudible) arbiter.claim();
      wasAudible = state.playing;
    });
  }

  // The middle band, once the sidecar is known. Shared per screen: there is one
  // audible recording, so there is one thing for it to say. The piece title's
  // language follows viewport 0 — see the documented tension in middle-band.js.
  const bandOrientation = bandOrientationFor(config);
  const band = createMiddleBand(exhibit, {
    language: config.languages[0],
    // The RESOLVED orientation, the same one buildScreen reserved height for
    // (config.js bandOrientationFor) — a single viewport cannot mirror or flip.
    orientation: bandOrientation,
    // A turn mark needs somebody to take a turn FROM: with one viewport the
    // holder is always the only reader, so the mark would be decoration that
    // never changes. Suppressed there rather than painted permanently.
    turnIndicator: config.viewports > 1 ? config.turnIndicator : "off",
    flipMotion: config.bandFlipMotion,
    // The band's shared play/pause. toggle() needs a fallback for the very
    // first tap of a session, before anything is active — the same resting
    // recording preselect names below.
    onToggle: () => transport.toggle(exhibit.piece.ref || exhibit.order[0]),
    // THE BAND AS THE INTERFACE (?bandTap; plan §11(f)). Resolved by config.js
    // to "off" unless the band is mirrored, because only mirrored copies can
    // say who tapped (turns.js bandTapViewport). A fact is tappable only
    // where the series can follow it: the year when the audible recording IS
    // that year's concert (a 1950 studio session is not one; nor is another
    // orchestra's 2010), the conductor when the series knows them — so a tap
    // never opens a card about something the visitor is not hearing.
    tap: bandTapFor(config),
    tappable: (fact, meta, file) => {
      const c = concertsResolved;
      if (!c) return false;
      if (fact === "year") return c.yearOf(file) != null;
      if (fact === "conductor") return Boolean(meta.conductor) && c.byConductor.has(meta.conductor);
      return false;
    },
    // Opens the TAPPING reader's half on the fact. The clock is untouched: a
    // view is per-viewport state, so this is not a turn (turns.js).
    onFact: (cluster, fact, meta, file) => {
      const ix = bandTapViewport(bandOrientation, cluster);
      const vp = ix == null ? null : viewports[ix];
      if (!vp || !concertsResolved) return;
      if (fact === "year") setView(vp, "years", { year: concertsResolved.yearOf(file) });
      else if (fact === "conductor") setView(vp, "conductors", { conductor: meta.conductor });
    },
  });
  for (const slot of bands) slot.replaceWith(band.el);
  bandHandle = band;
  // A half may already be in a view (?views=…) before the band exists.
  for (const vp of viewports) band.setCurrentView(vp.index, vp.view);
  // The sidecar may have landed before the band existed: ask its facts again.
  if (concertsResolved !== undefined) band.refresh();
  window._exhibitTest.band = band;
  window._exhibitTest.marker = (i) => viewports[i]?.marker?.state() ?? null;
  // Programmatic placement for the specs (the readingClock.advance precedent):
  // the semantic path without the pointer choreography, so tests of the SNAP
  // and fade rules do not have to re-prove the gestures each time.
  window._exhibitTest.placeMarker = (i, file, time) => {
    if (viewports[i]?.marker) placeMarker(viewports[i], file, time);
  };

  // Where the detail header's "Jump to annotation" lands (ruled 2026-08-25):
  // the ACTIVE recording when the annotation targets it — a jump should not
  // lose the listening thread — else the first targeted strip in stack
  // order; at the earliest region start there (playback order, not authoring
  // order; zero-extent spans skipped, the playAnnotation precedent).
  const jumpTarget = (ann, vp) => {
    if (!ann) return null;
    const targeted = new Set((ann.targets || []).map((t) => t.file));
    const file = targeted.has(transport.activeFile)
      ? transport.activeFile
      : [...vp.strips.keys()].find((f) => targeted.has(f));
    if (!file) return null;
    const target = ann.targets.find((t) => t.file === file);
    let start = null;
    for (const region of ann.regions || []) {
      const span = target.regionTimes?.[region.id];
      if (span && span.end > span.start && (start == null || span.start < start)) {
        start = span.start;
      }
    }
    return start == null ? null : { file, time: start };
  };

  // ?marker=glass (week 4, ruled 2026-08-27): the SEMANTIC state — which
  // moment each viewport's marker names, as an alignment index — lives here
  // beside the machines that consume it; marker.js owns only the physical
  // object and reports gestures. Three rulings wired below:
  //   * placement, moving, and adoption are the reader's own JUMP (a placed
  //     glass plays there — "listen here" is the product; the turn policies
  //     arbitrate the audio exactly as for any tap, while the marker itself
  //     is per-viewport and never contended);
  //   * a bare switch with a marker up LANDS ON IT instead of carrying the
  //     moment (listen.js's swapCurrentAudio semantic — the marker's
  //     existence is the mode); explicit times still win;
  //   * every marker-driven jump is flagged so the discontinuity classifier
  //     reads it as a SEEK even when it switches recording (ruled: a
  //     deliberate jump to elsewhere, not a moment-preserving switch).
  let markerSeek = null; // { file, time } of the last marker-driven jump
  const markerJump = (vp, file, time) => {
    markerSeek = { file, time };
    turns.jump(vp.index, file, time);
  };
  const syncGhosts = () => {
    for (const vp of viewports) {
      const other = viewports.find((o) => o.index !== vp.index && o.markerIx != null);
      vp.marker?.setGhost(other ? other.markerIx : null, other ? other.markerFile : null);
    }
  };
  const placeMarker = (vp, file, time) => {
    vp.markerIx = getClosestAlignmentIx(exhibit.grids, time, file);
    vp.markerFile = file;
    vp.marker.setMarker(vp.markerIx, file);
    syncGhosts();
    markerJump(vp, file, time);
  };
  const adoptMarker = (vp) => {
    const other = viewports.find((o) => o.index !== vp.index && o.markerIx != null);
    // The ghost can vanish mid-gesture (the other side pulled their glass
    // off): repaint what is true rather than adopting a moment that is gone.
    if (!other) return vp.marker.setMarker(vp.markerIx, vp.markerFile);
    vp.markerIx = other.markerIx;
    vp.markerFile = other.markerFile;
    vp.marker.setMarker(vp.markerIx, vp.markerFile);
    syncGhosts();
    const landing = getCorrespondingTime(exhibit.grids, vp.markerFile, vp.markerIx);
    if (Number.isFinite(landing)) markerJump(vp, vp.markerFile, landing);
  };
  const removeMarker = (vp) => {
    vp.markerIx = null;
    vp.markerFile = null;
    vp.marker.setMarker(null, null);
    syncGhosts();
  };
  const markerSnapSwitch = (vp, file) => {
    const landing = getCorrespondingTime(exhibit.grids, file, vp.markerIx);
    // A grid gap degrades to the aligned carry rather than a dead button.
    if (!Number.isFinite(landing)) return turns.request(vp.index, file, undefined);
    markerJump(vp, file, landing);
  };

  // The glass RIDES THE AUDIBLE STRIP (second iteration round, 2026-08-27,
  // superseding the first build's "the glass stays where the visitor put
  // it"): on any recording switch — a strap pick, an arrow, an aligned snap,
  // or the other side's action — each standing marker's glass hops to the
  // marker's projection on the newly audible strip, so the lens is always
  // over what is being heard. The marker itself (the index) never moves;
  // only its visual home does, on the position transition. Ghosts follow.
  if (config.marker === "glass") {
    let markerHome = null;
    transport.subscribe((state) => {
      if (!state.file || state.file === markerHome) return;
      markerHome = state.file;
      let moved = false;
      for (const vp of viewports) {
        if (vp.markerIx == null || vp.markerFile === state.file) continue;
        vp.markerFile = state.file;
        vp.marker?.setMarker(vp.markerIx, state.file);
        moved = true;
      }
      if (moved) syncGhosts();
    });
  }

  const stripsReady = [];
  for (const vp of viewports) {
    const mounted = mountStrips(vp.stripsEl, exhibit, config, {
      // Taps go through the turn machine, which owns the seek-vs-switch rule
      // (a tap's time is only honoured on the already-active strip — see
      // turns.request) and knows WHOSE tap this is, which the transport never
      // needs to. Under ?tapMode=direct the tap is instead taken literally on
      // both axes via the jump path (ruled 2026-08-25: explicit time honoured
      // across a switch, plays if paused, the reader's own seek to the fade
      // machinery) — the aligned switch moves to the strap below.
      onSelect: (file, time) => {
        // The lifted glass turns the next waveform tap into PLACEMENT
        // (marker.js's expect-placement mode) — reusing the strips' own
        // transform-proof tap→time mapping rather than growing a second one.
        if (vp.marker?.lifted) return placeMarker(vp, file, time);
        if (config.tapMode === "direct") {
          // Direct mode with a marker standing (second iteration round,
          // 2026-08-27, DIRECT ONLY by ruling): a waveform tap LIFTS the
          // glass into expect-placement instead of seeking — the strap owns
          // switching here, so while the marker is up the glass mediates
          // seeking, and the second tap places AND plays (R3). Aligned mode
          // below keeps the ruled snap semantics untouched.
          if (vp.markerIx != null) return vp.marker.lift();
          return turns.jump(vp.index, file, time);
        }
        // Aligned mode: a cross-strip tap is a bare switch, so a standing
        // marker catches it; a same-strip tap keeps its explicit time (ruled).
        if (vp.markerIx != null && file !== transport.activeFile) {
          return markerSnapSwitch(vp, file);
        }
        return turns.request(vp.index, file, time);
      },
      labelFor: (file) => stripLabel(exhibit, file, vp.language),
      colors: themeColors,
    });
    vp.strips = mounted.strips;
    stripsReady.push(mounted.ready);

    // The switch strap (?tapMode=direct — alpha-tester feedback, 2026-08-26):
    // one button per recording, beside its strip, doing the aligned
    // carry-the-moment switch that direct mode removed from the strips. A
    // button tap is a request with no time — exactly what a strip tap was.
    if (config.tapMode === "direct") {
      // A strap pick or arrow step is exactly the BARE switch the marker
      // ruling names, so a standing marker catches both (markerSnapSwitch);
      // without one they stay the aligned carry they always were.
      const bareSwitch = (file) =>
        vp.markerIx != null
          ? markerSnapSwitch(vp, file)
          : turns.request(vp.index, file, undefined);
      vp.strap = createStrap(vp.stripsEl, {
        files: [...mounted.strips.keys()],
        labelFor: (file) => strapLabel(exhibit, file),
        titleFor: (file) => stripLabel(exhibit, file, vp.language),
        // The medallion the initials were standing in for (plan §5.5). Same
        // resolver as the band's, so the two surfaces cannot end up showing a
        // recording two different faces.
        portraitFor: (file) => portraitUrl(metadataFor(exhibit, file)),
        onPick: bareSwitch,
        // The arrows: the same aligned switch, one strip up or down from the
        // audible recording, wrapping at the ends (always set post-boot — the
        // resting preselect names the reference).
        onNav: (delta) => {
          const files = [...mounted.strips.keys()];
          const ix = Math.max(0, files.indexOf(transport.activeFile));
          bareSwitch(files[(ix + delta + files.length) % files.length]);
        },
        navLabels: {
          up: t("strap.prev", vp.language),
          down: t("strap.next", vp.language),
        },
      });
    }

    // The listening marker (?marker=glass — marker.js has the design record;
    // the semantic-state helpers above have the routing).
    if (config.marker === "glass") {
      vp.markerIx = null;
      vp.markerFile = null;
      vp.marker = createMarkerLayer({
        stripsEl: vp.stripsEl,
        strips: mounted.strips,
        // The lens spans one strip top-to-bottom when placed.
        stripHeight: config.stripHeight,
        ixFor: (file, time) => getClosestAlignmentIx(exhibit.grids, time, file),
        timeFor: (file, ix) => getCorrespondingTime(exhibit.grids, file, ix),
        // For the drag's client→local mapping: the viewport's own rotation
        // composed with the debug stage rotation (both right angles).
        rotationOf: () =>
          rotationFor(config, vp.index) + (Number(config.stageRotation) || 0),
        labels: {
          glass: t("marker.glass", vp.language),
          ghost: t("marker.ghost", vp.language),
        },
        onPlace: (file, time) => placeMarker(vp, file, time),
        onAdopt: () => adoptMarker(vp),
        onRemove: () => removeMarker(vp),
      });
    }

    // One toolbar row above the strips: the audience switch and the zoom
    // buttons share it so the controls cost one strip-height of the column, not
    // two. The zoom controller needs the mounted strips, which is why the
    // toolbar is built after them even though it renders above.
    vp.zoom = createViewportZoom({
      viewport: vp.index,
      strips: mounted.strips,
      levels: config.zoomLevels,
      language: vp.language,
      project: (time, from, to) => projectPlayhead(time, from, [to])[to],
      // The playhead is the anchor: zoom keeps the moment the visitor is
      // hearing (or would hear) centred. See zoom.js's header for why not the
      // viewport centre.
      anchor: () => ({ file: transport.activeFile, time: transport.time }),
      // The minimum-width floor on regions is in SECONDS-per-pixel terms, so a
      // zoom change moves it: re-derive this viewport's regions at the new
      // scale rather than leaving kids-region slivers widened for a zoom level
      // that is no longer current. The marker's projections re-derive with
      // them — same scale, same reason.
      onChange: () => {
        renderAnnotations(vp, store);
        vp.marker?.reposition();
      },
    });
    const toolbar = document.createElement("div");
    toolbar.className = "vp-toolbar";
    toolbar.append(buildAudienceSwitch({ viewport: vp.index, store, language: vp.language }));
    // The buttons are optional (config.zoomControls); the controller above is
    // not — scroll sync and the setLevel API work with or without them.
    if (config.zoomControls) toolbar.append(vp.zoom.el);
    // The view switch (plan §11), first on the bar: it changes what the whole
    // half shows, so it reads before the controls that belong to one view.
    if (config.viewSwitch) toolbar.prepend(buildViewSwitch(vp));
    vp.el.insertBefore(toolbar, vp.stripsEl);
    // The BARE recording switch, as one per-viewport function so a view built
    // outside this scope (the by-year explorer) makes exactly the switch a
    // strip tap or strap pick makes: a standing marker catches it
    // (markerSnapSwitch, the marker ruling); otherwise the aligned carry
    // through the turn machine, with no time.
    vp.bareSwitch = (file) =>
      vp.markerIx != null ? markerSnapSwitch(vp, file) : turns.request(vp.index, file, undefined);

    vp.annList = createAnnotationList({
      viewport: vp.index,
      language: vp.language,
      split: !!vp.sideSlotEl,
      // ?detailTitle (ruled 2026-08-25): auto = title under playhead focus
      // only (the focusDim pattern), on/off force it either way.
      showTitle:
        config.detailTitle === "on" ||
        (config.detailTitle === "auto" && config.focus === "playhead"),
      // ?detailJump (ruled 2026-08-25, ON everywhere): routed through the
      // turn machine like any tap — the jump keeps its time across a
      // recording switch (turns.jump), plays if paused, and lands as this
      // reader's own seek for the fade machinery, whose relevance hold then
      // protects the very text they jumped from.
      showJump: config.detailJump !== "off",
      onJumpTap: (annId) => {
        const spot = jumpTarget(
          vp.currentAnnotations?.find((a) => a.id === annId),
          vp,
        );
        if (spot) turns.jump(vp.index, spot.file, spot.time);
      },
      // The MARK button lands this reader's marker on the annotation's first
      // region — the same target the jump uses, so the two buttons agree about
      // where the annotation "starts". Only offered when there is a marker to
      // place. It goes through placeMarker, so the audio follows exactly as it
      // does for a drag or a tap-placement: a placed glass plays there, by
      // ruling, and a marker that arrived silently would be the odd one out.
      showMark: config.marker === "glass",
      onMarkTap: (annId) => {
        if (!vp.marker) return;
        const spot = jumpTarget(
          vp.currentAnnotations?.find((a) => a.id === annId),
          vp,
        );
        if (spot) placeMarker(vp, spot.file, spot.time);
      },
      // What a chip tap MEANS depends on the layout, so the machine lives
      // here, not in the component. Below the strips (default): a plain focus
      // toggle, as shipped. With the side panel: the chip is a pure PANEL
      // control and the panel's × is the only unfocus — tap to focus + open,
      // tap again to close KEEPING focus (highlights stay, waveforms back to
      // full width), tap once more to reopen. Chosen (user, 2026-08-24)
      // because it decouples "what is focused" from "is the panel showing":
      // focus is expected to become playhead-driven later (as in the main
      // listening interface), and chip-toggles-panel / ×-dismisses are the
      // two primitives that survive that change.
      onChipTap: (annId) => {
        // A tap takes manual control of the text: whatever fade window was
        // running is over, one way or the other.
        cancelDetailFade(vp);
        // Under ?focus=playhead a tap also PINS: the visitor's choice outranks
        // the wash until the machine's unfocus (below: the toggle-off; side:
        // the ×) releases it. In manual mode the flag is set but never read.
        if (!vp.sideSlotEl) {
          const off = vp.shownId === annId;
          vp.shownId = off ? null : annId;
          // The unfocus takes the paint with it, but followLast still names
          // the regions the clock may be inside, so the wash resumes on the
          // NEXT entry rather than instantly re-grabbing this one.
          if (off) clearWash(vp);
          vp.focusPinned = !off;
        } else if (vp.shownId !== annId) {
          vp.shownId = annId;
          vp.focusPinned = true;
          setPanelOpen(vp, true);
        } else {
          // Toggling the panel on the shown chip is still engagement with
          // that annotation: it pins too, else the wash could swap the panel's
          // text mid-read the moment the clock crosses another region.
          vp.focusPinned = true;
          setPanelOpen(vp, !vp.panelOpen);
        }
        renderAnnotations(vp, store);
        // Any tap is engagement: a pin (re-)arms its expiry clock, an
        // unfocus cancels it.
        armPinExpiry(vp);
      },
    });
    // The "Keep reading…" ring (config.pinExpiry, config.panelFollow),
    // hidden until a deadline nears; a tap re-arms whichever countdown is
    // running — the pin's expiry clock or the wash's reading window. It
    // lives in the BODY, so the split layout carries it into the side panel
    // along with the text it is warning about.
    if (config.pinExpiry !== "off" || config.detailFade !== "off") {
      const keep = document.createElement("button");
      keep.type = "button";
      keep.className = "pin-expiry";
      const arc = document.createElement("span");
      arc.className = "pin-ring";
      const lab = document.createElement("span");
      lab.textContent = t("panel.keepReading", vp.language);
      keep.append(arc, lab);
      keep.addEventListener("click", () => vp.ringRearm?.());
      vp.annList.bodyEl.appendChild(keep);
      vp.expiryEl = keep;
    }
    // The chips are BELOW CONTENT in either layout; the slot, when a tenant
    // claims it, receives that tenant's panel content plus the × that closes
    // the panel and clears focus — the machine's one unfocus.
    vp.el.appendChild(vp.annList.el);
    if (vp.sideSlotEl) {
      const close = document.createElement("button");
      close.type = "button";
      close.className = "side-close";
      close.textContent = "×";
      close.setAttribute("aria-label", t("panel.close", vp.language));
      close.addEventListener("click", () => {
        cancelDetailFade(vp);
        vp.shownId = null;
        clearWash(vp);
        // The machine's one unfocus also releases the playhead pin — but the
        // wash resumes on the NEXT region entry, not this frame: followLast
        // still names the regions the playhead may be inside, so an × mid-region
        // stays an unfocus rather than being instantly overwritten.
        vp.focusPinned = false;
        setPanelOpen(vp, false);
        renderAnnotations(vp, store);
        armPinExpiry(vp);
      });
      vp.sideSlotEl.append(close, SIDE_TENANTS[config.sideSlot](vp));
    }
    vp.statusEl.textContent = "";
    // ?views=years,listen — this half starts in the explorer. Not awaited: the
    // overlay lands when its module and sidecar arrive; the strips beneath
    // finish booting regardless.
    const startView = config.views[vp.index] ?? config.views[0];
    if (startView && startView !== "listen") setView(vp, startView);
  }

  // Every renderer has to know its own duration before a single region is added:
  // the regions plugin clamps to whatever duration it can see, and WaveSurfer's
  // peaks ingestion is not synchronous with `create()`. Skipping this wait does not
  // fail — it draws all nine annotations as two-pixel markers at the left edge of
  // every strip, with no error anywhere. See strips.js's `ready`.
  await Promise.all(stripsReady);
  for (const vp of viewports) renderAnnotations(vp, store);

  // The widened-region floor (regions.js) is derived from the strips' LIVE
  // width, and nothing guarantees that first render ran against a settled
  // layout: a window mid-resize during boot has been observed laying the strips
  // out a few pixels wide, inflating every region — regions.js caps the damage,
  // but an idle kiosk would keep the capped-yet-wrong regions forever, because
  // only a re-render repairs specs. WaveSurfer already owns the recovery
  // signal: its renderer re-renders on real container-width changes (100 ms
  // debounced, width-guarded) and re-emits "resize" AFTER the wrapper has its
  // new geometry, so re-deriving here always reads sane widths — a boot gate on
  // "plausible" strip width would be redundant, and could strand a kiosk that
  // never reaches one. rAF-coalesced per viewport: a column's eight strips
  // resize together and one re-derivation covers them all.
  for (const vp of viewports) {
    let rederiveQueued = false;
    const rederive = () => {
      if (rederiveQueued) return;
      rederiveQueued = true;
      requestAnimationFrame(() => {
        rederiveQueued = false;
        renderAnnotations(vp, store);
      });
    };
    for (const strip of vp.strips.values()) strip.ws.on("resize", rederive);
  }

  // The turn machine drives two per-viewport surfaces: the selection marks
  // ("what did MY side choose") and the turn element (prompt, waiting note,
  // transient notices). Both are per viewport because that is the whole point
  // — the two halves see different things at the same moment.
  turns.subscribe((state, event) => {
    for (const vp of viewports) {
      const chosen = state.selected[vp.index];
      for (const [file, strip] of vp.strips) strip.setSelected(file === chosen);
      paintTurn(vp, state, event, turns);
    }
    // …and the shared band, which is the surface both sides read: it carries
    // the turn mark in every orientation, and under ?bandOrientation=flip it
    // also turns to face the holder. The rotation comes from the viewport's
    // own configured angle, never a hardcoded 180 — the table's geometry is
    // configuration (§7.8), and a two-sided assumption here would be the one
    // place the exhibit stopped being one build.
    band.setTurn(
      state.holder,
      state.holder == null ? 0 : rotationFor(config, state.holder),
      config.turnPolicy,
    );
  });

  // ?focus=playhead: the follow machinery. One subscriber watches the shared
  // clock and turns region ENTRIES on the audible recording into focus — per
  // viewport, in each viewport's own audience list. Event-driven by design:
  // `followViewport` acts only when the SET of annotations under the playhead
  // changes, so it can never fight a visitor mid-interaction by rewriting
  // focus per frame. Entries advance both surfaces (the wash and, via the
  // latest-start primary, the detail); an exit clears only the wash, and only
  // under focusWash=clear — the detail lingers either way, because blanking
  // the commentary at the moment the visitor started reading it is the worse
  // wash. Exits within config.focusHoldMs of their entry are HELD to that
  // bound, so a sub-frame region paints perceivably instead of blinking.
  // Containment runs on the AUTHORED spans, not the widened display spans —
  // the widening is a visibility affordance, not a musical claim.

  // Repaint when the earliest hold runs out — the one paint change that has
  // no transport event to carry it.
  const scheduleHoldSweep = (vp) => {
    clearTimeout(vp.washTimer);
    vp.washTimer = 0;
    if (!vp.washHold.size) return;
    const next = Math.min(...vp.washHold.values());
    vp.washTimer = setTimeout(() => {
      const now = performance.now();
      let dropped = false;
      for (const [id, deadline] of vp.washHold) {
        if (deadline <= now + 20) {
          vp.washHold.delete(id);
          dropped = true;
        }
      }
      if (dropped) renderAnnotations(vp, store);
      scheduleHoldSweep(vp);
    }, Math.max(30, next - performance.now()));
  };

  const followViewport = (vp, file, time, prevTime, jump = null) => {
    const now = performance.now();
    const { ids, primary } = annotationsUnder(vp.currentAnnotations, file, time, prevTime);
    const discontinuity = prevTime == null;
    const sticky = config.focusWash === "sticky";
    let dirty = false;
    // Jumps land, they do not carry: a seek or a recording switch drops any
    // paint still held past its exit.
    if (discontinuity && vp.washHold.size) {
      vp.washHold.clear();
      dirty = true;
    }
    // What a visitor's jump does to the shown TEXT (ruled 2026-08-25). The
    // text's owner keeps their agency: their own time-jump lands — it switches
    // to what it finds, or starts the "Keep reading…" countdown on unannotated
    // ground. The OTHER side's jump must never snatch text mid-read: it only
    // ever starts the countdown, and the catch-up at its end switches to
    // whatever is relevant then. A recording switch is exempt for the jumping
    // side (comparing interpretations mid-read is the exhibit's point), and
    // relevance is exempt for everyone — tickFade voids a countdown the moment
    // the playhead is back inside the shown annotation's spans. Only
    // fade-tracked text takes part: pins answer to pinExpiry alone, and
    // detailFade=off text stays immortal.
    const mine = !jump || jump.initiator == null || jump.initiator === vp.index;
    const tracked = vp.shownId && vp.shownAt != null && !vp.focusPinned;
    const stealGuard = jump && !mine && tracked;
    if (jump && tracked && !ids.includes(vp.shownId)) {
      if (jump.kind === "seek") armFadeCap(vp);
      else if (!mine && primary && primary !== vp.shownId) armFadeCap(vp);
    }
    const key = ids.join("|");
    if (key !== vp.followLast) {
      vp.followLast = key;
      // The pin holds paint and detail alike; the edge tracking above still
      // runs, so a release resumes the wash on the NEXT change, not this
      // frame. The wash set is left frozen here — it is unpainted while
      // pinned, and every release path empties it explicitly.
      if (!vp.focusPinned) {
        if (sticky) {
          // Week 3's comparator: the single latest-start winner, kept on exit.
          if (primary && primary !== vp.washId) {
            vp.washIds = [primary];
            vp.washId = primary;
            if (!stealGuard) advanceShown(vp, primary);
            dirty = true;
          }
        } else if (ids.length || vp.washIds.length) {
          // Entries stamp their time and cancel any hold on the same id;
          // exits within the bound are held to it.
          for (const id of ids) {
            if (!vp.washEntries.has(id)) vp.washEntries.set(id, now);
            vp.washHold.delete(id);
          }
          for (const id of vp.washIds) {
            if (ids.includes(id)) continue;
            const entered = vp.washEntries.get(id) ?? 0;
            if (!discontinuity && config.focusHoldMs > 0 && now - entered < config.focusHoldMs) {
              vp.washHold.set(id, entered + config.focusHoldMs);
            }
            vp.washEntries.delete(id);
          }
          vp.washIds = ids;
          vp.washId = primary;
          if (primary && !stealGuard) advanceShown(vp, primary);
          dirty = true;
        }
      }
    }
    if (dirty) renderAnnotations(vp, store);
    scheduleHoldSweep(vp);
  };

  // Pin auto-expiry (config.pinExpiry): a pin is a reader's hold, and an
  // abandoned one must not hold the table for the next visitor. Near the
  // deadline the "Keep reading…" ring counts down over the warning window; a
  // tap re-arms the full time. Expiry unfocuses AND re-derives the wash at
  // once — unlike the ×, a timeout is not a dismissal, so the table comes
  // back to life immediately with whatever is playing.
  const cancelPinExpiry = (vp) => {
    clearInterval(vp.pinTicker);
    vp.pinTicker = 0;
    vp.pinDeadline = null;
    vp.expiryEl?.classList.remove("is-live");
  };
  const expirePin = (vp) => {
    cancelPinExpiry(vp);
    vp.shownId = null;
    clearWash(vp);
    vp.focusPinned = false;
    setPanelOpen(vp, false);
    renderAnnotations(vp, store);
    if (config.focus === "playhead" && transport.activeFile) {
      vp.followLast = undefined;
      followViewport(vp, transport.activeFile, transport.time, null);
    }
  };
  const armPinExpiry = (vp) => {
    cancelPinExpiry(vp);
    if (config.pinExpiry === "off" || !vp.focusPinned || !vp.shownId) return;
    const ann = vp.currentAnnotations?.find((a) => a.id === vp.shownId);
    const ms =
      config.pinExpiry === "auto"
        ? readingTimeMs(ann, store.get(vp.index), vp.language)
        : Number(config.pinExpiry);
    if (!Number.isFinite(ms) || ms <= 0) return;
    vp.pinTotalMs = ms;
    // Reading-clock time (ruled 2026-08-25): a pin's clock freezes with the
    // pause button too — it is the same reader's clock as the fade window.
    vp.pinDeadline = readingNow() + ms;
    vp.ringRearm = () => armPinExpiry(vp);
    const warnAt = Math.min(12000, ms / 2);
    const tick = () => {
      const left = vp.pinDeadline - readingNow();
      if (left <= 0) {
        expirePin(vp);
        return;
      }
      if (!vp.expiryEl) return;
      vp.expiryEl.classList.toggle("is-live", left <= warnAt);
      vp.expiryEl.style.setProperty("--pin-frac", String(Math.max(0, Math.min(1, left / warnAt))));
    };
    vp.pinTicker = setInterval(tick, 200);
    tick();
  };

  // ?detailFade (ruled 2026-08-25, edge rules same day): playback-triggered
  // text is MORTAL, but only on the READING CLOCK — its window drains while
  // the music runs and freezes with the pause button. Each text the wash puts
  // on show lives for its reading window, with three amendments to the plain
  // countdown:
  //   RELEVANCE — while the playhead sits inside one of the shown
  //     annotation's spans the text cannot expire: the deadline defers to the
  //     projected region exit, so the ring drains toward the exit and the
  //     fade lands with the end of the region, never inside it. Extends only
  //     — a 12 ms region never shortens a window.
  //   THE SQUEEZE — the ring is pulled earlier when the next annotation's
  //     region arrives sooner (only while playing; paused, nothing
  //     approaches), never below the focusHoldMs floor. Switchover is exempt
  //     from the relevance hold: at overlaps the next entry still takes over,
  //     ring first — the escape hatch, not a fade.
  //   THE JUMP COUNTDOWN (fadeCapAt) — a time-jump that leaves the shown
  //     annotation's spans pulls the deadline to one warning window out
  //     (sooner natural ends kept; spent windows still get the full
  //     warning), armed by followViewport per the ownership rule documented
  //     there. Relevance voids it.
  // A ring tap BUMPS the text to its full window, deferring any switch. At
  // the end the text catches up to whatever is relevant then (never
  // re-showing itself — its budget is spent), or fades out entirely.
  // Layout-agnostic: under sideSlot=annotations the same machine opens the
  // panel on entry and closes it on fade-out. Pins are exempt throughout; a
  // chip tap hands the ring to pinExpiry.
  const stopFadeTicker = (vp) => {
    clearInterval(vp.fadeTicker);
    vp.fadeTicker = 0;
  };
  const cancelDetailFade = (vp) => {
    stopFadeTicker(vp);
    clearTimeout(vp.fadeTimer);
    vp.fadeTimer = 0;
    vp.annList.bodyEl.classList.remove("is-fading");
    // null, not 0: the reading clock legitimately reads 0 on a silent table,
    // so a zero stamp must stay distinguishable from "no fade-tracked text".
    vp.shownAt = null;
    vp.shownBumped = false;
    vp.fadePending = false;
    vp.fadeCapAt = 0;
  };
  const showText = (vp, id) => {
    clearTimeout(vp.fadeTimer);
    vp.fadeTimer = 0;
    vp.annList.bodyEl.classList.remove("is-fading");
    vp.shownId = id;
    vp.shownAt = readingNow();
    vp.shownMs =
      config.detailFade === "auto"
        ? readingTimeMs(
            vp.currentAnnotations?.find((a) => a.id === id),
            store.get(vp.index),
            vp.language,
          )
        : Number(config.detailFade);
    vp.shownBumped = false;
    vp.fadePending = false;
    vp.fadeCapAt = 0;
    vp.ringRearm = () => bumpShown(vp);
    if (vp.sideSlotEl) setPanelOpen(vp, true);
    if (!vp.fadeTicker) vp.fadeTicker = setInterval(() => tickFade(vp), 200);
    renderAnnotations(vp, store);
  };
  const bumpShown = (vp) => {
    if (!vp.shownId || vp.focusPinned) return;
    vp.shownBumped = true;
    vp.fadeBumpUntil = readingNow() + (vp.shownMs || 15000);
    vp.fadePending = false;
    vp.fadeCapAt = 0;
    vp.expiryEl?.classList.remove("is-live");
  };
  // The jump countdown (see the block comment above): a qualifying jump
  // pulls the deadline to one warning window out — or to the text's own
  // sooner end, when less than that remains — and a window already spent
  // during a relevance hold still gets the full warning, because the
  // countdown is an escape hatch, never an instant vanish. The earliest
  // jump wins; a later jump never moves the deadline back out.
  const armFadeCap = (vp) => {
    const now = readingNow();
    const warnAt = Math.min(12000, vp.shownMs / 2);
    const baseEnd = vp.shownBumped ? vp.fadeBumpUntil : vp.shownAt + vp.shownMs;
    const remaining = baseEnd - now;
    const at = now + (remaining > 0 ? Math.min(remaining, warnAt) : warnAt);
    if (!vp.fadeCapAt || at < vp.fadeCapAt) vp.fadeCapAt = at;
  };
  // What a wash entry does to the DETAIL. detailFade off: follow at once (the
  // shipped loose coupling). On: a bump protects outright; a text younger
  // than the floor defers the switch to its floor moment; otherwise switch.
  const advanceShown = (vp, primary) => {
    if (!primary || primary === vp.shownId) return;
    if (config.detailFade === "off") {
      vp.shownId = primary;
      return;
    }
    const now = readingNow();
    if (vp.shownId && vp.shownAt != null) {
      if (vp.shownBumped && now < vp.fadeBumpUntil) return;
      if (now - vp.shownAt < config.focusHoldMs) {
        vp.fadePending = true;
        return;
      }
    }
    showText(vp, primary);
  };
  // The earliest start of a DIFFERENT annotation's span ahead of the clock on
  // the audible recording — what squeezes the ring while playing.
  const nextForeignStart = (vp) => {
    const file = transport.activeFile;
    const time = transport.time;
    let next = null;
    for (const ann of vp.currentAnnotations || []) {
      if (ann.id === vp.shownId) continue;
      const target = (ann.targets || []).find((t) => t.file === file);
      if (!target) continue;
      for (const region of ann.regions || []) {
        const span = target.regionTimes?.[region.id];
        if (span && span.start > time && (next == null || span.start < next)) next = span.start;
      }
    }
    return next;
  };
  // The furthest end among the shown annotation's spans containing the clock,
  // in the audible recording's own timeline — null when the playhead is
  // outside them all. Same containment rule as annotationsUnder (the AUTHORED
  // spans, boundaries inclusive), and computed from the spans rather than the
  // wash set: under focusWash=sticky the wash never empties, and the
  // relevance hold must release when the music actually leaves. Recomputed
  // per tick, so chained and nested spans extend the hold as the playhead
  // crosses into them.
  const relevanceExit = (vp) => {
    if (!vp.shownId) return null;
    const time = transport.time;
    const ann = (vp.currentAnnotations || []).find((a) => a.id === vp.shownId);
    const target = (ann?.targets || []).find((t) => t.file === transport.activeFile);
    if (!target) return null;
    let exit = null;
    for (const region of ann.regions || []) {
      const span = target.regionTimes?.[region.id];
      if (!span || span.start > time || span.end < time) continue;
      if (exit == null || span.end > exit) exit = span.end;
    }
    return exit;
  };
  const resolveFade = (vp) => {
    // Catch up to what is relevant NOW — the wash primary, or the freshest
    // still-held paint — but never re-show the text that just expired.
    const held = [...vp.washHold.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    const target = vp.washId || held || null;
    if (target && target !== vp.shownId) showText(vp, target);
    else fadeOutDetail(vp);
  };
  const fadeOutDetail = (vp) => {
    stopFadeTicker(vp);
    vp.expiryEl?.classList.remove("is-live");
    vp.annList.bodyEl.classList.add("is-fading");
    vp.fadeTimer = setTimeout(() => {
      vp.annList.bodyEl.classList.remove("is-fading");
      vp.shownId = null;
      vp.shownAt = null;
      vp.shownBumped = false;
      vp.fadePending = false;
      vp.fadeCapAt = 0;
      if (vp.sideSlotEl) setPanelOpen(vp, false);
      renderAnnotations(vp, store);
    }, 400);
  };
  const tickFade = (vp) => {
    if (vp.focusPinned) return;
    if (!vp.shownId || vp.shownAt == null) {
      stopFadeTicker(vp);
      return;
    }
    const now = readingNow();
    const warnAt = Math.min(12000, vp.shownMs / 2);
    // The relevance hold: a relevant text cannot expire (extend-only), and
    // relevance voids any jump countdown. Projected in reading-clock terms —
    // paused, both the clock and the playhead stand still, so the hold
    // simply holds.
    const exitAt = relevanceExit(vp);
    if (exitAt != null) vp.fadeCapAt = 0;
    // A deferred switchover stands only while something foreign is still
    // under the playhead: if the entrant left before the floor, the handover
    // evaporates — else its floor deadline would fade a text the relevance
    // hold protects.
    if (vp.fadePending && (!vp.washId || vp.washId === vp.shownId)) vp.fadePending = false;
    const holdTo = exitAt != null ? now + (exitAt - transport.time) * 1000 : -Infinity;
    let end;
    if (vp.shownBumped) {
      end = Math.max(vp.fadeBumpUntil, holdTo);
    } else {
      end = Math.max(vp.shownAt + vp.shownMs, holdTo);
      if (vp.fadePending) {
        // A deferred switchover: exempt from the relevance hold (the N.b. —
        // the ring is the escape hatch for the handover, not a fade).
        end = Math.min(end, vp.shownAt + config.focusHoldMs);
      } else if (transport.playing) {
        const next = nextForeignStart(vp);
        if (next != null) {
          const wallAtNext = now + (next - transport.time) * 1000;
          end = Math.min(end, Math.max(wallAtNext, vp.shownAt + config.focusHoldMs));
        }
      }
    }
    // The armed countdown IS the deadline: armFadeCap already folded a sooner
    // natural end in, and a spent window's granted warning must not be
    // shortened back to a deadline that has already passed.
    if (vp.fadeCapAt) end = vp.fadeCapAt;
    const left = end - now;
    if (left <= 0) {
      resolveFade(vp);
      return;
    }
    if (!vp.expiryEl) return;
    vp.expiryEl.classList.toggle("is-live", left <= warnAt);
    vp.expiryEl.style.setProperty("--pin-frac", String(Math.max(0, Math.min(1, left / warnAt))));
  };

  if (config.focus === "playhead") {
    let prevFile = null;
    let prevTime = null;
    transport.subscribe((state) => {
      if (!state.file) return;
      // A file switch or a jump of more than a second is a discontinuity —
      // a seek, not playback — so only containment at the new position
      // counts; sweeping the gap would "enter" every region it skipped over.
      // Continuous frames sweep [prev, now] instead, so a region narrower
      // than one frame (D or E?'s 12 ms) still raises its entry.
      const switched = state.file !== prevFile && prevFile != null;
      const jumped =
        !switched && state.file === prevFile && prevTime != null &&
        Math.abs(state.time - prevTime) > 1;
      const jump =
        state.file !== prevFile || prevTime == null || Math.abs(state.time - prevTime) > 1;
      // Attribution for the ownership rule (followViewport): every real jump
      // is tap-driven, and turns.js sets its holder BEFORE it touches the
      // transport — the band's shared toggle never moves the clock by more
      // than a frame — so the holder at emit time is the jump's author. Null
      // means nothing has taken the clock yet (boot), where there is no text
      // to protect and every side counts as its own initiator.
      // A marker-driven jump that switches recording still counts as a SEEK
      // (ruled 2026-08-27): the visitor deliberately jumped elsewhere, so the
      // fade rules treat it like one — their own text gets the countdown on
      // unannotated ground, the other side's the steal guard. Matched on the
      // flagged landing rather than on a mode flag, so a request-policy grant
      // executing seconds later still classifies when it finally lands; any
      // other discontinuity spends the flag.
      const markerLanded =
        markerSeek != null &&
        markerSeek.file === state.file &&
        Math.abs(state.time - markerSeek.time) <= 1;
      const jumpInfo =
        switched || jumped
          ? { kind: switched && !markerLanded ? "switch" : "seek", initiator: turns.holder }
          : null;
      if (switched || jumped) markerSeek = null;
      for (const vp of viewports) {
        followViewport(vp, state.file, state.time, jump ? null : prevTime, jumpInfo);
      }
      prevFile = state.file;
      prevTime = state.time;
    });
  }

  store.subscribe((viewport) => {
    const vp = viewports[viewport];
    if (!vp) return;
    // Focus does not survive a mode change: the annotation being read belongs to
    // the audience that was on screen, and carrying its id across would leave a
    // highlighted chip that is no longer in the list. The side panel closes
    // with it — it was showing that annotation's text.
    clearWash(vp);
    vp.shownId = null;
    vp.focusPinned = false;
    cancelPinExpiry(vp);
    cancelDetailFade(vp);
    setPanelOpen(vp, false);
    vp.el.dataset.audience = store.get(viewport);
    renderAnnotations(vp, store);
    // In playhead mode the wash re-derives against the NEW audience's list at
    // once — a mid-region switch refocuses (or honestly clears) rather than
    // waiting for the next entry edge.
    if (config.focus === "playhead" && transport.activeFile) {
      vp.followLast = undefined;
      followViewport(vp, transport.activeFile, transport.time, null);
    }
  });

  transport.subscribe(onTransport(band, store));

  // The resting state: the reference recording is the subject, so the band has a
  // conductor to show and one strip is marked as what a tap would play. No audio
  // is fetched — nine megabytes before anybody has touched the table would be
  // rude to the museum's network and pointless on a casual load. The KIOSK is
  // the opposite case, and says so with ?preload=on below.
  transport.preselect(exhibit.piece.ref || exhibit.order[0]);

  // ?preload=on: warm every recording's bytes after boot, reference first, so
  // the exhibit is never half-ready for its first visitor (user ruling
  // 2026-08-26). Kicked off a beat after boot returns — the specs' `ready`
  // gate stays a first-paint signal, not a 72 MB download — and exposed as a
  // promise so a spec (or the week-4 soak) can await the warm state.
  if (config.preload === "on") {
    const files = [...new Set([exhibit.piece.ref || exhibit.order[0], ...exhibit.order])];
    window._exhibitTest.preloaded = new Promise((resolve) => {
      setTimeout(() => transport.preloadAll(files).then(resolve), 0);
    });
  }

  if (config.debug) {
    console.log("exhibit: config", config);
    installFrameProbe(transport);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Rendering.
// ---------------------------------------------------------------------------

/**
 * The caption on each strip: conductor, orchestra, and year, from the sidecar.
 *
 * The same facts as the middle band, and for the same reason — proper names and a
 * numeral are the things that need no translation (plan §6.3). Without them the
 * stack is eight identical grey rectangles, which makes "compare these
 * interpretations" an instruction nobody can follow. Conductor FIRST, because
 * most of the set shares an orchestra and a shared prefix would bury the one
 * word that tells the strips apart. The filename is the fallback so a missing
 * sidecar is visible rather than blank.
 */
function stripLabel(exhibit, file, language) {
  const meta = metadataFor(exhibit, file);
  // A sidecar `displayShort` (a language map) stands in for the ensemble —
  // the Scholz b-shape ruling (2026-08-27): "Unidentified orchestra" is a
  // decided display, not a missing fact, so it takes the ensemble's slot
  // rather than leaving the caption a bare year.
  const ensemble = meta.displayShort
    ? resolveText(meta.displayShort, { language })
    : meta.ensemble;
  const parts = [meta.conductor, ensemble, meta.year].filter(
    (v) => v != null && v !== "",
  );
  return parts.length ? parts.join(" · ") : file.replace(/\.wav$/i, "");
}

/**
 * The strap button's placeholder text until the gen-AI portrait excerpts exist
 * (plan §5.5): conductor initials and the year — "HvK ’87", "CK ’89" (ruled
 * 2026-08-26). Initials keep each name part's own case, so the particle in
 * "Herbert von Karajan" reads as the lowercase v it is, and hyphenated
 * surnames contribute each half ("Franz Bauer-Theussl" → FBT). The conductors
 * are distinct where several ensembles are not, which is why the conductor and
 * not the ensemble. The filename fallback keeps a missing sidecar visible, the
 * stripLabel precedent.
 */
function strapLabel(exhibit, file) {
  const meta = metadataFor(exhibit, file);
  // A YEAR THAT IS NOT A PLAIN FOUR DIGITS gets no apostrophe-year: the medallion
  // is built by taking the last two characters, so a range like "1951–1954" would
  // print "CK ’54" and assert one concert out of four. Initials alone are honest.
  // No curated recording needs this today — VPO-1951-1954's performance year came
  // off the liner notes as 1950 — but a compilation with an unresolved year is the
  // normal case for this corpus, so the guard stays.
  const yr = /^\d{4}$/.test(String(meta.year ?? "")) ? String(meta.year) : null;
  // An identity DECIDED to be unknown (the Scholz b-shape ruling, 2026-08-27,
  // confirmed by the author 2026-09-01) is not a missing sidecar: the medallion
  // owns up with a "?" rather than minting initials from a pseudonymous
  // filename. Distinguished from genuine absence by the display fields the
  // decision authored, so a broken sidecar still fails visibly below.
  if (!meta.conductor && (meta.displayShort || meta.displayNote)) {
    return yr ? `? ’${yr.slice(-2)}` : "?";
  }
  const name = meta.conductor || file.replace(/\.wav$/i, "");
  const initials = name
    .split(/[\s-]+/)
    .filter(Boolean)
    .map((part) => part[0])
    .join("");
  return yr ? `${initials} ’${yr.slice(-2)}` : initials;
}

/**
 * Open or close one viewport's side panel. The CSS keys the two-column grid on
 * `data-side-open`, so this is also the moment the strips column changes width
 * — the current zoom level's geometry is re-run against the new widths, else a
 * zoomed strip keeps pixels-per-second derived from a container it no longer
 * has (the same failure spec 28 fixed for the listen page's resize).
 */
function setPanelOpen(vp, open) {
  vp.panelOpen = !!open;
  const had = vp.el.dataset.sideOpen === "1";
  if (vp.panelOpen === had) return;
  if (vp.panelOpen) vp.el.dataset.sideOpen = "1";
  else delete vp.el.dataset.sideOpen;
  vp.zoom?.refit();
  vp.marker?.reposition();
}

/**
 * One viewport's turn surface (turns.js). Three shapes share the element: the
 * holder's prompt with the grant and deny buttons, the requester's waiting
 * note, and the transient notices ("taken", "denied", "cooldown") that outlive the state
 * that raised them by config.turnNoticeMs. The transients are addressed to ONE
 * side — the events carry the viewport they are for — while the pending shapes
 * are derived from state, so a repaint mid-notice must not clear a notice the
 * new state knows nothing about: hence the turnNotice guard on the clear.
 */
function paintTurn(vp, state, event, turns) {
  if (event?.type === "taken" && event.from === vp.index) {
    flashTurnNotice(vp, t("turn.taken", vp.language));
    return;
  }
  if (event?.type === "denied" && event.to === vp.index) {
    flashTurnNotice(vp, t("turn.denied", vp.language));
    return;
  }
  // A tap inside the denial's cooldown: the same words, nobody prompted.
  if (event?.type === "cooldown" && event.to === vp.index) {
    flashTurnNotice(vp, t("turn.denied", vp.language));
    return;
  }
  const pending = state.pending;
  if (pending && vp.index === state.holder) {
    cancelTurnNotice(vp);
    vp.turnEl.textContent = "";
    const label = document.createElement("span");
    label.textContent = t("turn.prompt", vp.language);
    const grant = document.createElement("button");
    grant.type = "button";
    grant.className = "turn-grant";
    grant.textContent = t("turn.grant", vp.language);
    grant.addEventListener("click", () => turns.grant());
    const deny = document.createElement("button");
    deny.type = "button";
    deny.className = "turn-deny";
    deny.textContent = t("turn.deny", vp.language);
    deny.addEventListener("click", () => turns.deny());
    vp.turnEl.append(label, grant, deny);
    vp.turnEl.dataset.role = "prompt";
    vp.turnEl.hidden = false;
  } else if (pending && vp.index === pending.viewport) {
    cancelTurnNotice(vp);
    vp.turnEl.textContent = t("turn.waiting", vp.language);
    vp.turnEl.dataset.role = "waiting";
    vp.turnEl.hidden = false;
  } else if (!vp.turnNotice) {
    vp.turnEl.hidden = true;
    vp.turnEl.textContent = "";
    delete vp.turnEl.dataset.role;
  }
}

function flashTurnNotice(vp, text) {
  cancelTurnNotice(vp);
  vp.turnEl.textContent = text;
  vp.turnEl.dataset.role = "notice";
  vp.turnEl.hidden = false;
  vp.turnNotice = setTimeout(() => {
    vp.turnNotice = 0;
    vp.turnEl.hidden = true;
    vp.turnEl.textContent = "";
    delete vp.turnEl.dataset.role;
  }, config.turnNoticeMs);
}

function cancelTurnNotice(vp) {
  if (vp.turnNotice) clearTimeout(vp.turnNotice);
  vp.turnNotice = 0;
}

/** Redraw one viewport's annotation chips, its regions, and its group colours. */
function renderAnnotations(vp, store) {
  const audience = store.get(vp.index);
  // "all" (?audienceAll=1) is the union in the payload's own authored order —
  // `annotations` IS that order, byAudience is just its partition — with each
  // chip marked by the audience it targets, since the union is the one mode
  // where that fact is not implied by the switch position.
  const showAll = audience === "all";
  let annotations = showAll
    ? data.exhibit.annotations
    : data.exhibit.byAudience[audience] || [];
  // The one seam where the theme's diverging series replaces the authored
  // colours: every consumer below (chips, region fills, group cards, strip
  // edges) reads colours off these objects, so recolouring COPIES here retints
  // all of them at once and the payload's own objects stay untouched.
  if (annotationPalette) annotations = recolorAnnotations(annotations, annotationPalette);
  const present = (id) => annotations.some((a) => a.id === id);
  if (vp.shownId && !present(vp.shownId)) vp.shownId = null;
  if (vp.washId && !present(vp.washId)) vp.washId = null;
  vp.washIds = vp.washIds.filter(present);
  for (const id of [...vp.washHold.keys()]) if (!present(id)) vp.washHold.delete(id);
  // The list the follow machinery (?focus=playhead) scans: exactly what this
  // viewport is showing, after the audience filter and any recolouring.
  vp.currentAnnotations = annotations;
  // The one derivation of "what paints": a pin holds every strip-side surface
  // on the visitor's choice; otherwise the UNION of the wash and any ids held
  // past their exit (focusHoldMs) paints. The detail (the commentary text and
  // its group cards) reads shownId instead — the agreed loose coupling, so
  // text outlives the paint rather than the reverse — and the group edges
  // follow the single PRIMARY, because one grouping must own the edges for
  // the legend cards to agree with them.
  const paintIds = vp.focusPinned
    ? vp.shownId
      ? [vp.shownId]
      : []
    : [...new Set([...vp.washIds, ...vp.washHold.keys()])];
  const paintPrimary = vp.focusPinned
    ? vp.shownId
    : paintIds.includes(vp.washId)
      ? vp.washId
      : paintIds.includes(vp.shownId)
        ? vp.shownId
        : (paintIds[0] ?? null);
  // The per-recording note follows the AUDIBLE recording, not this viewport's
  // selection: the note explains what you are hearing, and under the request
  // policy a side's selection can be a recording nobody is playing yet.
  const audible = config.targetNotes === "on" ? activeFileForNotes() : null;
  vp.annList.update(
    annotations,
    { paintIds, shownId: vp.shownId, pinned: vp.focusPinned },
    {
      markAudience: showAll,
      targetFile: audible,
      targetLabel: audible ? stripLabel(data.exhibit, audible, vp.language) : "",
    },
  );
  syncRegions(vp.strips, annotations, {
    minRegionPx: config.minRegionPx,
    activeIds: paintIds,
  });
  paintGroups(vp, annotations, paintPrimary);
  paintDim(vp, annotations, paintIds);
  paintTargetNotes(vp, annotations, paintIds);
}

/**
 * Mark the strips that the painted annotation has something to say ABOUT.
 *
 * The exhibit's question is "the same moment, ten interpretations" — so the
 * question a visitor has, looking at ten stacked waveforms, is which of them
 * the annotator actually commented on. That fact is in the payload
 * (`targets[].description`) and was invisible: the strips looked identical
 * whether the annotator wrote 235 characters about a recording or nothing at
 * all. A dot, not text: a 38 px strip cannot hold a sentence, and the sentence
 * itself belongs in the panel where it can be read.
 *
 * Follows the WASH, like the group edges and the dimming, so the marks appear
 * with the annotation they belong to and leave with it — a permanent dot would
 * be claiming something about the strip rather than about this annotation. At
 * overlaps any painted annotation with a note for the strip lights it, the
 * same union rule paintDim uses.
 */
function paintTargetNotes(vp, annotations, paintIds) {
  const painted =
    config.targetNotes === "on" ? annotations.filter((a) => paintIds.includes(a.id)) : [];
  for (const [file, strip] of vp.strips) {
    const has = painted.some((a) =>
      (a.targets || []).some((t) => t.file === file && _hasNote(t.description)),
    );
    strip.el.classList.toggle("has-note", has);
  }
}

/** A non-empty authored value — plain string or language map (the list's rule). */
function _hasNote(v) {
  if (typeof v === "string") return v.trim() !== "";
  if (v && typeof v === "object")
    return Object.values(v).some((s) => typeof s === "string" && s.trim() !== "");
  return false;
}

/** Empty the wash set and its hold bookkeeping — every unfocus path's job. */
function clearWash(vp) {
  vp.washIds = [];
  vp.washId = null;
  vp.washEntries.clear();
  vp.washHold.clear();
  clearTimeout(vp.washTimer);
  vp.washTimer = 0;
}

/**
 * The "auto" pin-expiry heuristic (user, 2026-08-25): a reading time over
 * everything the pin puts on show — the commentary plus any group story —
 * scaled by the audience's pace (kids read slower). Six seconds of
 * orientation plus the word count at the audience's rate, clamped so a
 * two-line kids caption is never snatched at speed and no essay holds the
 * table past three minutes. The union pseudo-audience "all" reads at the
 * adult rate.
 */
function readingTimeMs(ann, audience, language) {
  if (!ann) return 30000;
  const bits = [resolveText(ann.description, { language })];
  for (const g of ann.grouping?.groups || []) {
    bits.push(resolveText(g.label, { language }));
    bits.push(resolveText(ann.groupNotes?.[g.groupId], { language }));
  }
  for (const c of ann.comparisons || []) bits.push(resolveText(c.text, { language }));
  const words = bits
    .filter(Boolean)
    .join(" ")
    .split(/\s+/)
    .filter(Boolean).length;
  const wpm = { kids: 110, adults: 220, expert: 240 }[audience] || 220;
  const ms = 6000 + (words / wpm) * 60000;
  return Math.max(15000, Math.min(180000, ms));
}

/**
 * Every annotation whose region the clock is inside — or swept through — on
 * the audible recording, for ?focus=playhead, plus the latest-start PRIMARY.
 *
 * `prevTime` non-null means a continuous playback frame: the whole interval
 * [prev, now] counts, so a region narrower than one frame still registers.
 * Null means a discontinuity (a seek, a recording switch, an audience change):
 * only containment at `time` counts. The full set paints (chips, region
 * emphasis, deemphasis — the union ruling, 2026-08-25); where several spans
 * qualify, the latest START is the primary — on a sweep that is the entry
 * closest to now, and on nested regions it is the inner one, the more
 * specific thing to say — and the primary is what the detail text and the
 * group edges follow.
 *
 * Containment uses the AUTHORED spans (`targets[].regionTimes`), not the
 * widened spans the strips draw — widening exists so a 12 ms region is
 * visible, not to claim 12 ms of music lasts four pixels' worth of seconds.
 *
 * @param {object[]} annotations  the viewport's current (audience-filtered) list
 * @param {string} file           the audible recording
 * @param {number} time           seconds, in `file`'s own timeline
 * @param {number|null} prevTime  the previous clock sample, or null
 * @returns {{ids: string[], primary: string|null}} ids in payload order;
 *   primary null when the set is empty
 */
function annotationsUnder(annotations, file, time, prevTime) {
  const lo = prevTime == null ? time : Math.min(prevTime, time);
  const hi = prevTime == null ? time : Math.max(prevTime, time);
  const ids = [];
  let primary = null;
  let bestStart = -Infinity;
  for (const ann of annotations || []) {
    const target = (ann.targets || []).find((t) => t.file === file);
    if (!target) continue;
    let inside = false;
    for (const region of ann.regions || []) {
      const span = target.regionTimes?.[region.id];
      if (!span) continue;
      if (span.end >= lo && span.start <= hi) {
        inside = true;
        if (span.start > bestStart) {
          bestStart = span.start;
          primary = ann.id;
        }
      }
    }
    if (inside) ids.push(ann.id);
  }
  return { ids, primary };
}

/**
 * Colour each strip's edge by the group it belongs to in the PAINTED annotation's
 * pinned grouping.
 *
 * Per annotation, not per screen, because that is what a grouping is here: "Die
 * Glocke" pins VPO against Other Orchestras, "The Viennese Lilt" pins Viennese
 * against Other. There is no such thing as the exhibit's current grouping, so
 * nothing is painted until an annotation paints — a visitor's pin or the wash —
 * and the answer comes from `resolveGroupFor`, never from reading `files` here.
 * Strip paint follows the wash (agreed 2026-08-25), so under focusWash=clear
 * the edges leave with the playhead while the panel's group cards, which read
 * shownId, may honestly outlive them.
 */
function paintGroups(vp, annotations, paintId) {
  let focused = annotations.find((a) => a.id === paintId) || null;
  // Same predicate as the group cards (annotation-list.js): edges only when
  // the annotation has something to say about its groups, so the legend and
  // the stripes appear and disappear together.
  if (focused && !hasGroupStory(focused)) focused = null;
  for (const [file, strip] of vp.strips) {
    const group = focused ? groupForFileIn(focused, file) : null;
    const colour = group ? safeColor(group.color) : null;
    strip.el.style.setProperty("--group-color", colour || "transparent");
    if (group) strip.el.dataset.group = group.groupId || "";
    else delete strip.el.dataset.group;
  }
}

/**
 * Deemphasize the strips the painted annotation does not TARGET — the second
 * half of the agreed focus definition (2026-08-25). Targeting is the payload's
 * own fact (`targets[].file`): an annotation is about the recordings it has
 * regions on, and while it paints, the other strips fade. Only the waveform
 * and the caption fade (.is-dimmed, exhibit.css): the background keeps the
 * strip present as a tap target, and the grouping edge stays at full strength
 * because "you are not hearing this strip's region" and "this strip is in the
 * story's Other group" are both true at once — the edge is the legend's
 * anchor, not part of the region paint.
 *
 * config.focusDim: "auto" dims only under ?focus=playhead, so the untouched
 * manual exhibit stays byte-for-byte the shipped behaviour per the A/B rule;
 * "on"/"off" force it either way (on = manual taps dim too; off = strips never
 * fade even in playhead mode). At overlaps the whole painted set counts (the
 * union ruling, 2026-08-25): a strip stays at full strength if ANY painted
 * annotation targets it.
 */
function paintDim(vp, annotations, paintIds) {
  const enabled =
    config.focusDim === "on" || (config.focusDim === "auto" && config.focus === "playhead");
  const painted = enabled ? annotations.filter((a) => paintIds.includes(a.id)) : [];
  for (const [file, strip] of vp.strips) {
    const dim =
      painted.length > 0 &&
      !painted.some((a) => (a.targets || []).some((t) => t.file === file));
    strip.el.classList.toggle("is-dimmed", dim);
  }
}

/**
 * The per-frame handler. Positions every cursor, and touches the band and the
 * active-strip styling only when the audible recording actually changes — those
 * are DOM writes and a re-render, and doing them sixty times a second for a value
 * that changes on a tap is how a 60 fps interface stops being one.
 */
function onTransport(band, store) {
  let lastFile = null;
  let lastLoading = null;
  let graceTimer = 0;
  const showLoading = (show) => {
    for (const vp of viewports) {
      vp.statusEl.textContent = show ? t("state.loading", vp.language) : "";
      vp.statusEl.dataset.state = show ? "loading" : "";
    }
  };
  return (state) => {
    const positions = positionsFor(state.time, state.file);
    for (const vp of viewports) {
      for (const [file, strip] of vp.strips) {
        const at = positions[file];
        if (at !== undefined) strip.setTime(at);
      }
    }
    // The band's play icon and mirrored time readouts — guarded on change
    // inside tick(), like everything else this handler drives per frame.
    band.tick(state);
    if (state.file !== lastFile) {
      lastFile = state.file;
      for (const vp of viewports) {
        for (const [file, strip] of vp.strips) strip.setActive(file === state.file);
        vp.strap?.setActive(state.file);
      }
      band.update(state.file);
      // The per-recording note is about the AUDIBLE recording, so a switch
      // changes which note (if any) the panel should be showing — the same
      // re-derivation a chip tap does, at tap frequency, not per frame. The
      // guard above is what keeps it there.
      if (config.targetNotes === "on") {
        for (const vp of viewports) renderAnnotations(vp, store);
      }
    }
    // Guarded like the band above, and for the same reason: this runs per frame
    // while playing, and the loading flag changes on a tap, not sixty times a
    // second. ?loadingGrace delays the text: a warm switch that completes
    // inside the grace never shows it — "Loading…" flashing between seamless
    // switches reads as a glitch (user, 2026-08-26) — while a genuine wait
    // still explains itself. The falling edge always clears immediately.
    const loading = !!state.loading;
    if (loading !== lastLoading) {
      lastLoading = loading;
      if (!loading) {
        if (graceTimer) {
          clearTimeout(graceTimer);
          graceTimer = 0;
        }
        showLoading(false);
      } else if (config.loadingGrace > 0) {
        // A single timer per rising edge; the loading FILE changing mid-wait
        // keeps the original deadline — the visitor has been waiting since then.
        if (!graceTimer) {
          graceTimer = setTimeout(() => {
            graceTimer = 0;
            if (lastLoading) showLoading(true);
          }, config.loadingGrace);
        }
      } else {
        showLoading(true);
      }
    }
  };
}

/**
 * `?debug=1` only: report the cost of the cursor loop, because it has never been
 * measured against the real thing.
 *
 * Spike C's playhead phase (plan §4.0a) drove 48 cursors at a steady 60 fps, but it
 * stood in for the alignment with `t * (1 + i * 0.004)` — arithmetic, not a grid
 * lookup. The real projection calls `getClosestAlignmentIx`, which scans a 29,121
 * entry grid with `Array.prototype.filter` and allocates the matching prefix, once
 * per frame. That is the one cost the spike did not measure, and guessing at it is
 * exactly what the spike existed to avoid. So it is instrumented rather than
 * asserted.
 */
function installFrameProbe(transport) {
  let frames = 0;
  let sum = 0;
  let worst = 0;
  let last = 0;
  transport.subscribe(() => {
    if (!transport.playing) {
      last = 0;
      return;
    }
    const now = performance.now();
    if (last) {
      const dt = now - last;
      frames++;
      sum += dt;
      if (dt > worst) worst = dt;
      if (frames % 120 === 0) {
        console.log(
          `exhibit frames: mean ${(sum / frames).toFixed(1)} ms ` +
            `(${(1000 / (sum / frames)).toFixed(0)} fps), worst ${worst.toFixed(0)} ms, ` +
            `${frames} frames, ${viewports.length * viewports[0].strips.size} cursors`,
        );
      }
    }
    last = now;
  });
  window._exhibitTest.frames = () => ({ frames, mean: sum / (frames || 1), worst });
}
