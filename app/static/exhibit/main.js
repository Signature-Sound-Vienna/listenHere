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
// Geometry. Two halves of a portrait screen, the far one rotated, with the middle
// band between them — carrying conductor, year, and portrait, and NO UI labels,
// because a caption would have to pick a language for a surface two people read
// from opposite sides (plan §6.3).
// ---------------------------------------------------------------------------
function buildScreen(root) {
  root.textContent = "";
  root.style.setProperty("--strip-height", config.stripHeight + "px");
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

    // Inside the strips container, absolutely positioned over it (exhibit.css):
    // out of the flow entirely, so the transient "Loading…" can never move a
    // strip — the stronger form of 34.10's reserved-height fix, adopted when
    // week 2's commentary panel needed the line's 30 px back.
    const status = document.createElement("p");
    status.className = "vp-status";
    status.textContent = t("state.loading", vp.dataset.language);
    strips.appendChild(status);

    root.appendChild(vp);
    viewports.push({
      index: i,
      el: vp,
      stripsEl: strips,
      statusEl: status,
      language: vp.dataset.language,
      strips: new Map(),
      annList: null,
      focusedId: null,
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
    AUDIENCES,
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
      // The tap-time is only honoured on the strip that is already active — the
      // same semantics as the engine (waveform-events.js): tapping ANOTHER strip
      // means "switch to this recording", and the moment is carried across by the
      // transport, not read from the finger. At fit-to-width a pixel is ~0.58 s,
      // so honouring the tap position on a switch would jump tens of seconds to
      // wherever the finger happened to land.
      onSelect: (file, time) =>
        transport.select(file, file === transport.activeFile ? time : undefined),
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
      onFocus: (annId) => {
        vp.focusedId = annId;
        renderAnnotations(vp, store);
      },
    });
    vp.el.appendChild(vp.annList.el);
    vp.statusEl.textContent = "";
  }

  // Every renderer has to know its own duration before a single region is added:
  // the regions plugin clamps to whatever duration it can see, and WaveSurfer's
  // peaks ingestion is not synchronous with `create()`. Skipping this wait does not
  // fail — it draws all nine annotations as two-pixel markers at the left edge of
  // every strip, with no error anywhere. See strips.js's `ready`.
  await Promise.all(stripsReady);
  for (const vp of viewports) renderAnnotations(vp, store);

  store.subscribe((viewport) => {
    const vp = viewports[viewport];
    if (!vp) return;
    // Focus does not survive a mode change: the annotation being read belongs to
    // the audience that was on screen, and carrying its id across would leave a
    // highlighted chip that is no longer in the list.
    vp.focusedId = null;
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

/** Redraw one viewport's annotation chips, its regions, and its group colours. */
function renderAnnotations(vp, store) {
  const audience = store.get(vp.index);
  let annotations = data.exhibit.byAudience[audience] || [];
  // The one seam where the theme's diverging series replaces the authored
  // colours: every consumer below (chips, region fills, group cards, strip
  // edges) reads colours off these objects, so recolouring COPIES here retints
  // all of them at once and the payload's own objects stay untouched.
  if (annotationPalette) annotations = recolorAnnotations(annotations, annotationPalette);
  if (vp.focusedId && !annotations.some((a) => a.id === vp.focusedId)) {
    vp.focusedId = null;
  }
  vp.annList.update(annotations, vp.focusedId);
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
