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

import { readConfig, rotationFor, DEFAULTS } from "./config.js";
import { setDebug, t } from "./strings.js";
import {
  getClosestAlignmentIx,
  getCorrespondingTime,
} from "../js/engine/align-core.js";
import { configureGroupingCore, safeColor } from "../js/engine/grouping-core.js";
import { AUDIENCES, loadExhibitData, metadataFor } from "./payload.js";
import { mountStrips } from "./strips.js";
import { syncRegions } from "./regions.js";
import { Transport } from "./audio.js";
import { TurnTaking } from "./turns.js";
import { createArbiter } from "./arbiter.js";
import { AudienceStore, buildAudienceSwitch } from "./audience.js";
import { createViewportZoom } from "./zoom.js";
import { applyTheme, annotationSeries, recolorAnnotations } from "./themes.js";
import { createMiddleBand } from "./middle-band.js";
import { createAnnotationList, groupForFileIn, hasGroupStory } from "./annotation-list.js";

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
};

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
  const bandHeight =
    config.bandOrientation === "rotated" && config.middleBandHeight === DEFAULTS.middleBandHeight
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
      focusedId: null,
      panelOpen: false,
    });
  }
  return { viewports, bands };
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
    debug: config.debug,
  });
  window._exhibitTest.transport = transport;

  // Every strip tap goes through the turn-taking machine (turns.js), which
  // decides — by the ?turnPolicy in force — whether it reaches the transport
  // now, announced, or as a request the other side grants. The default policy
  // is a transparent pass-through, so the shipped tap behaviour is unchanged.
  const turns = new TurnTaking({
    transport,
    policy: config.turnPolicy,
    grantMs: config.turnGrantMs,
  });
  window._exhibitTest.turns = turns;

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
  const band = createMiddleBand(exhibit, {
    language: config.languages[0],
    orientation: config.bandOrientation,
    // The band's shared play/pause. toggle() needs a fallback for the very
    // first tap of a session, before anything is active — the same resting
    // recording preselect names below.
    onToggle: () => transport.toggle(exhibit.piece.ref || exhibit.order[0]),
  });
  for (const slot of bands) slot.replaceWith(band.el);
  window._exhibitTest.band = band;

  const stripsReady = [];
  for (const vp of viewports) {
    const mounted = mountStrips(vp.stripsEl, exhibit, config, {
      // Taps go through the turn machine, which owns the seek-vs-switch rule
      // (a tap's time is only honoured on the already-active strip — see
      // turns.request) and knows WHOSE tap this is, which the transport never
      // needs to.
      onSelect: (file, time) => turns.request(vp.index, file, time),
      labelFor: (file) => stripLabel(exhibit, file),
      colors: themeColors,
    });
    vp.strips = mounted.strips;
    stripsReady.push(mounted.ready);

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
      // that is no longer current.
      onChange: () => renderAnnotations(vp, store),
    });
    const toolbar = document.createElement("div");
    toolbar.className = "vp-toolbar";
    toolbar.append(buildAudienceSwitch({ viewport: vp.index, store, language: vp.language }));
    // The buttons are optional (config.zoomControls); the controller above is
    // not — scroll sync and the setLevel API work with or without them.
    if (config.zoomControls) toolbar.append(vp.zoom.el);
    vp.el.insertBefore(toolbar, vp.stripsEl);

    vp.annList = createAnnotationList({
      viewport: vp.index,
      language: vp.language,
      split: !!vp.sideSlotEl,
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
        if (!vp.sideSlotEl) {
          vp.focusedId = vp.focusedId === annId ? null : annId;
        } else if (vp.focusedId !== annId) {
          vp.focusedId = annId;
          setPanelOpen(vp, true);
        } else {
          setPanelOpen(vp, !vp.panelOpen);
        }
        renderAnnotations(vp, store);
      },
    });
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
        vp.focusedId = null;
        setPanelOpen(vp, false);
        renderAnnotations(vp, store);
      });
      vp.sideSlotEl.append(close, SIDE_TENANTS[config.sideSlot](vp));
    }
    vp.statusEl.textContent = "";
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
  });

  store.subscribe((viewport) => {
    const vp = viewports[viewport];
    if (!vp) return;
    // Focus does not survive a mode change: the annotation being read belongs to
    // the audience that was on screen, and carrying its id across would leave a
    // highlighted chip that is no longer in the list. The side panel closes
    // with it — it was showing that annotation's text.
    vp.focusedId = null;
    setPanelOpen(vp, false);
    vp.el.dataset.audience = store.get(viewport);
    renderAnnotations(vp, store);
  });

  transport.subscribe(onTransport(band));

  // The resting state: the reference recording is the subject, so the band has a
  // conductor to show and one strip is marked as what a tap would play. No audio
  // is fetched — nine megabytes before anybody has touched the table would be
  // rude to the museum's network and pointless on a kiosk.
  transport.preselect(exhibit.piece.ref || exhibit.order[0]);

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
 * five of the eight share an orchestra and a shared prefix would bury the one
 * word that tells the strips apart. The filename is the fallback so a missing
 * sidecar is visible rather than blank.
 */
function stripLabel(exhibit, file) {
  const meta = metadataFor(exhibit, file);
  const parts = [meta.conductor, meta.ensemble, meta.year].filter(
    (v) => v != null && v !== "",
  );
  return parts.length ? parts.join(" · ") : file.replace(/\.wav$/i, "");
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
}

/**
 * One viewport's turn surface (turns.js). Three shapes share the element: the
 * holder's prompt with the grant and deny buttons, the requester's waiting
 * note, and the transient notices ("taken", "denied") that outlive the state
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
  if (vp.focusedId && !annotations.some((a) => a.id === vp.focusedId)) {
    vp.focusedId = null;
  }
  vp.annList.update(annotations, vp.focusedId, { markAudience: showAll });
  syncRegions(vp.strips, annotations, {
    minRegionPx: config.minRegionPx,
    activeId: vp.focusedId,
  });
  paintGroups(vp, annotations);
}

/**
 * Colour each strip's edge by the group it belongs to in the FOCUSED annotation's
 * pinned grouping.
 *
 * Per annotation, not per screen, because that is what a grouping is here: "Die
 * Glocke" pins VPO against Other Orchestras, "The Viennese Lilt" pins Viennese
 * against Other. There is no such thing as the exhibit's current grouping, so
 * nothing is painted until a visitor focuses an annotation — and the answer comes
 * from `resolveGroupFor`, never from reading `files` here.
 */
function paintGroups(vp, annotations) {
  let focused = annotations.find((a) => a.id === vp.focusedId) || null;
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
 * The per-frame handler. Positions every cursor, and touches the band and the
 * active-strip styling only when the audible recording actually changes — those
 * are DOM writes and a re-render, and doing them sixty times a second for a value
 * that changes on a tap is how a 60 fps interface stops being one.
 */
function onTransport(band) {
  let lastFile = null;
  let lastLoading = null;
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
      }
      band.update(state.file);
    }
    // Guarded like the band above, and for the same reason: this runs per frame
    // while playing, and the loading flag changes on a tap, not sixty times a
    // second.
    const loading = !!state.loading;
    if (loading !== lastLoading) {
      lastLoading = loading;
      for (const vp of viewports) {
        vp.statusEl.textContent = loading ? t("state.loading", vp.language) : "";
        vp.statusEl.dataset.state = loading ? "loading" : "";
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
