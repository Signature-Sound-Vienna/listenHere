// exhibit/strips.js
//
// One horizontal waveform per recording, stacked. The whole interface is these
// strips plus the middle band, so this is where the exhibit's central claim gets
// made visible: the same moment, eight interpretations, all on screen at once.
//
// TWO THINGS ARE LOAD-BEARING HERE, and both are decisions rather than details:
//
// 1. **The renderers carry NO MEDIA.** Every strip is created from `peaks` plus
//    `duration` with no `url` and no `media`, so nothing decodes and nothing
//    downloads to draw a waveform. That is what makes sixteen strips affordable
//    on an iPad — Spike C measured 48 renderers at 3.30 MB of canvas each with
//    zero purges and a 60 fps playhead (plan §4.0a) — and it is also the week-1
//    constraint from §8's closed decisions, because a view that renders from
//    peaks alone is the one that can later show a visitor's own annotation over a
//    recording the kiosk is not licensed to play.
//
// 2. **Playback does not run through WaveSurfer at all.** Exactly one shared
//    `WindowedAudioPlayer` is the clock (see audio.js), and every cursor —
//    including the playing recording's own — is positioned by us, per frame, from
//    that clock projected through `align-core`. Attaching the player as one
//    strip's `media` would make that strip privileged: it would advance itself
//    while the other seven were driven, and the two paths would drift apart at
//    exactly the moments the exhibit is asking visitors to compare. One clock,
//    sixteen followers.
//
// The strips import the vendored WaveSurfer bundles directly, which the boundary
// test permits (they are not first-party modules and cannot reach listen.js).

import WaveSurfer from "../vendor/wavesurfer.esm.js";
import RegionsPlugin from "../vendor/wavesurfer-regions.esm.js";

/**
 * Colours. Not per-recording rainbow: the strips are meant to be read as eight
 * views of one thing, and eight hues invite the visitor to read the colour as
 * meaning something. Grouping colours are the ones that carry meaning here
 * (grouping-core's palette, via the annotations), so the waveform itself stays
 * neutral and the ACTIVE strip is what changes.
 *
 * These are the DEFAULT (dark) theme's values; main.js passes the active
 * theme's set through `opts.colors` (themes.js) — as options, not CSS tokens,
 * because WaveSurfer paints them into canvases.
 */
const DEFAULT_COLORS = {
  wave: "#5c5c68",
  waveActive: "#8fb8e8",
  progress: "#3d3d47",
  progressActive: "#5f86b4",
  cursor: "#f2f2f4",
};

/**
 * Create one strip inside `parent`.
 *
 * @param {HTMLElement} parent
 * @param {object} opts
 * @param {string} opts.file        the recording's payload key
 * @param {number[]} opts.peaks     pregenerated, from the payload
 * @param {number} opts.duration    seconds, from the payload
 * @param {number} opts.height      CSS px
 * @param {number} opts.zoom        minPxPerSec; 0 fits the whole recording
 * @param {string} opts.label       language-neutral caption (conductor · year)
 * @param {(file: string, time: number) => void} opts.onSelect  tap handler
 * @returns {Strip}
 */
export function createStrip(parent, opts) {
  const colors = opts.colors || DEFAULT_COLORS;
  const el = document.createElement("div");
  el.className = "strip";
  el.dataset.file = opts.file;

  const host = document.createElement("div");
  host.className = "strip-ws";
  el.appendChild(host);

  // Overlaid rather than stacked above the waveform: vertical space is the scarce
  // dimension once a portrait screen is halved and then divided by eight, and an
  // overlay costs none of it. The caption is conductor and year — the two things
  // that need no translation, the same argument as the middle band (plan §6.3).
  const caption = document.createElement("span");
  caption.className = "strip-label";
  caption.textContent = opts.label;
  el.appendChild(caption);

  parent.appendChild(el);

  const regions = RegionsPlugin.create();
  const ws = WaveSurfer.create({
    container: host,
    height: opts.height,
    // 0 means fill the parent — the whole recording in the strip (config.js).
    minPxPerSec: opts.zoom || 0,
    waveColor: colors.wave,
    progressColor: colors.progress,
    cursorColor: colors.cursor,
    cursorWidth: 2,
    normalize: false,
    // Both off for the same reason listen.js turns them off: the exhibit owns
    // scroll position (per viewport, from week 2), and a renderer that scrolls
    // itself towards its own cursor fights whatever the visitor just did.
    autoScroll: false,
    autoCenter: false,
    // Off because WaveSurfer's own tap handling is transform-naive — see the
    // click listener below, which owns the tap→time mapping instead.
    interact: false,
    plugins: [regions],
    // The pair that makes this a peaks-only renderer. `duration` is the alignment
    // duration, which is also the timeline the grids and the peaks are in, so a
    // cursor position computed from a grid lands where the visitor sees it.
    peaks: [opts.peaks],
    duration: opts.duration,
  });

  // The tap→time mapping is OURS (`interact: false` above), because WaveSurfer's
  // is transform-naive: WS 7.12 computes the tapped position as `clientX −
  // boundingRect.left` over the wrapper's PAINTED box, and this exhibit paints
  // its strips through transforms — the far viewport is rotated 180° and
  // ?stageRotation turns the whole screen. Measured with real input events on
  // both engines (2026-08-24): a tap on the far half seeked to `duration − t`,
  // the playhead landing mirror-image from the finger, and under stageRotation
  // every tap collapsed to the visual x-axis regardless of where on the strip it
  // fell. `offsetX` is the coordinate the browser has already mapped back
  // through every ancestor transform, and shadow-DOM retargeting reports it
  // relative to WS's outer div — container-sized, NOT moved by the inner scroll
  // container, hence the explicit scroll term. In the unrotated case
  // (scroll + offsetX)/wrapperWidth reproduced WS's own mapping exactly, so the
  // one geometry that already worked is unchanged. This also keeps WaveSurfer
  // from seeking its own cursor on the tap, which the header note's one-clock
  // rule wanted anyway: the exhibit decides what a tap means, and the cursor
  // follows from the shared clock like every other cursor.
  host.addEventListener("click", (e) => {
    const width = ws.getWrapper().clientWidth;
    if (!width) return;
    const rel = (ws.getScroll() + e.offsetX) / width;
    opts.onSelect?.(opts.file, Math.max(0, Math.min(1, rel)) * opts.duration);
  });

  // WHY THIS PROMISE EXISTS, because it looks like ceremony over a renderer that
  // decodes nothing. WaveSurfer's constructor kicks off `load(url, peaks, duration)`
  // and does not await it, so `decodedData` — and therefore `getDuration()` — is
  // still absent when `create()` returns. The regions plugin clamps every region to
  // the duration it can see at the moment it is asked, so adding regions in the same
  // tick as the strip silently collapses all of them to 0→0, which WaveSurfer then
  // renders as a *marker* rather than a region: two-pixel slivers at the left edge,
  // no colour, and no error anywhere. Cost an hour to find; nothing about it is
  // visible from the code that added the regions.
  const ready = new Promise((resolve) => {
    let settled = false;
    const finish = (how) => {
      if (settled) return;
      settled = true;
      resolve(how);
    };
    ws.on("ready", () => finish("ready"));
    ws.on("error", (e) => {
      console.warn(`exhibit strip ${opts.file}: renderer error`, e);
      finish("error");
    });
    // A race, not an await: this is peaks in memory, so "ready" is a microtask
    // away — but boot must not be able to hang on an event that never arrives,
    // because what that looks like is "Loading…" left on a museum wall.
    setTimeout(() => {
      if (!settled) console.warn(`exhibit strip ${opts.file}: never signalled ready`);
      finish("timeout");
    }, 5000);
  });

  const strip = {
    file: opts.file,
    el,
    host,
    caption,
    ws,
    regions,
    ready,
    duration: opts.duration,
    /** Put this strip's cursor at `time` in its OWN timeline. */
    setTime(time) {
      if (!Number.isFinite(time)) return;
      // WaveSurfer's setTime also writes `media.currentTime`, and the internal
      // <audio> element it made for us has no source. That is a no-op rather than
      // a throw in both engines, but a src-less media element is not a contract
      // anybody wrote down, so the guard stays.
      try {
        ws.setTime(time);
      } catch (_) {
        /* a src-less media element declining a seek costs us nothing */
      }
    },
    /** Mark this strip as the one the shared clock is running on. */
    setActive(active) {
      el.classList.toggle("is-active", !!active);
      ws.setOptions({
        waveColor: active ? colors.waveActive : colors.wave,
        progressColor: active ? colors.progressActive : colors.progress,
      });
    },
    /**
     * Mark this strip as THIS viewport's own last choice (turns.js). Distinct
     * from setActive on purpose: active is the screen's audible truth, selected
     * is one side's expressed desire — under the request policy they differ for
     * as long as the request is pending. A class only, no canvas repaint.
     */
    setSelected(on) {
      el.classList.toggle("is-selected", !!on);
    },
    destroy() {
      try {
        ws.destroy();
      } catch (_) {
        /* nothing to do about a renderer that is already gone */
      }
      el.remove();
    },
  };
  return strip;
}

/**
 * Build one viewport's full stack, in the payload's curated order.
 *
 * @param {HTMLElement} parent      the viewport's `.strips` container
 * @param {object} data             from payload.js
 * @param {object} config
 * @param {(file: string, time: number) => void} onSelect
 * @param {(file: string) => string} labelFor
 * @returns {{strips: Map<string, Strip>, ready: Promise<void>}} the map is keyed by
 *   recording, so the cursor loop and the region sync can both address a strip by
 *   the name the payload uses. `ready` settles once every renderer knows its own
 *   duration — nothing that measures a strip may run before it (see createStrip).
 */
export function mountStrips(parent, data, config, { onSelect, labelFor, colors }) {
  const strips = new Map();
  const files = data.order.slice(0, config.stackedRecordings);
  for (const file of files) {
    strips.set(
      file,
      createStrip(parent, {
        file,
        peaks: data.peaks[file],
        duration: data.durations[file],
        height: config.stripHeight,
        zoom: config.zoom,
        label: labelFor(file),
        onSelect,
        colors,
      }),
    );
  }
  const ready = Promise.all([...strips.values()].map((s) => s.ready)).then(() => {});
  return { strips, ready };
}

/**
 * @typedef {object} Strip
 * @property {string} file
 * @property {HTMLElement} el
 * @property {object} ws
 * @property {object} regions
 * @property {Promise<string>} ready
 * @property {number} duration
 * @property {(t: number) => void} setTime
 * @property {(active: boolean) => void} setActive
 * @property {() => void} destroy
 */
