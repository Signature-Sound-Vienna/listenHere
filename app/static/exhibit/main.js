// exhibit/main.js
//
// The walking skeleton: read the display configuration, build the viewport
// geometry, and prove the engine boundary is real by doing actual work through
// the two shared modules.
//
// What is NOT here yet: the loader (alignment JSON → grids + peaks + durations),
// the stacked strips, the shared WindowedAudioPlayer per recording, the middle
// band, and the annotation display. Those arrive once the curated data is prepped
// (plan §4.1 / §5).
//
// THE RULE: no import of `js/listen.js`, at any depth. Enforced by
// tests/e2e/33-exhibit-boundary.spec.ts, ratcheted at zero. Anything the engine
// will not give us gets copied WITH A ROW IN ENGINE-WANTS.md.

import { readConfig, rotationFor } from "./config.js";
import { setDebug, t } from "./strings.js";
import {
  getClosestAlignmentIx,
  getCorrespondingTime,
} from "../js/engine/align-core.js";
import {
  configureGroupingCore,
  getActiveFileGroups,
  resolveGroupFor,
} from "../js/engine/grouping-core.js";

const config = readConfig();
setDebug(config.debug);

// ---------------------------------------------------------------------------
// The exhibit is a SECOND host for the grouping read model, and this is the whole
// point of the injected context: it hands over its own alignment and its own
// score key without listen.js being anywhere in the graph. The payload is not
// loaded yet, so this reads from a holder the loader will fill.
// ---------------------------------------------------------------------------
const data = {
  alignment: null, // the merged exhibit payload, once the loader exists
  grids: {}, // filename -> number[] of times, for align-core
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

/** The group owning `filename` in the active grouping context, or null. */
export function groupFor(filename) {
  return resolveGroupFor(filename, getActiveFileGroups());
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
  root.style.setProperty("--middle-band-height", config.middleBandHeight + "px");
  root.dataset.split = config.splitOrientation;

  const viewports = [];
  for (let i = 0; i < config.viewports; i++) {
    if (i > 0) root.appendChild(buildMiddleBand());
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
    for (let r = 0; r < config.stackedRecordings; r++) {
      const strip = document.createElement("div");
      strip.className = "strip";
      strip.dataset.slot = String(r);
      strips.appendChild(strip);
    }
    vp.appendChild(strips);

    const status = document.createElement("p");
    status.className = "vp-status";
    status.textContent = t("state.loading", vp.dataset.language);
    vp.appendChild(status);

    root.appendChild(vp);
    viewports.push(vp);
  }
  return viewports;
}

/** The shared band between the halves. Images and numerals only, by design. */
function buildMiddleBand() {
  const band = document.createElement("div");
  band.className = "middle-band";
  band.append(
    Object.assign(document.createElement("div"), { className: "mb-portrait" }),
    Object.assign(document.createElement("div"), { className: "mb-conductor" }),
    Object.assign(document.createElement("div"), { className: "mb-year" }),
  );
  return band;
}

const root = document.getElementById("screen");
const viewports = buildScreen(root);
document.title = t("app.title", config.languages[0]);

// A single hook for the eventual Playwright smoke tests, mirroring listen.js's
// `_listenTest` convention so the exhibit is drivable the same way.
window._exhibitTest = { config, data, viewports, projectPlayhead, groupFor };

if (config.debug) console.log("exhibit: config", config);
