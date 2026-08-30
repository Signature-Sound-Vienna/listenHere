// exhibit/zoom.js
//
// Per-viewport zoom and scroll (plan §4.2). One controller per viewport: the
// zoom buttons, the fit/zoom arithmetic for its eight strips, and the scroll
// sync that keeps them showing the same MUSICAL MOMENT while zoomed.
//
// WHAT THE PROBE ESTABLISHED (2026-08-24, this increment), so nobody re-derives
// it: WaveSurfer 7.12's renderer already IS the viewport-sized-canvas-over-a-
// scrolled-inner idiom the plan told us to copy from waveform-view.js — at 4×
// it kept every canvas at container width (996 px chunks) and lazily rendered
// new chunks as the container scrolled. So the ~30 lines the plan budgeted for
// copying are zero lines: the strips just get `ws.zoom()` and their shadow-root
// scroll container, and the iOS canvas-memory ceiling is respected by the
// renderer itself. What the probe ALSO reproduced is the one-pixel zoom-out
// overflow (wrapper 997 over a 996 container, scroll stuck at 1) — the spec
// 28.3 bug — which is why fitting goes through the engine's `fitPxPerSec`,
// extracted to `engine/zoom-fit.js` rather than copied.
//
// SCROLLING IS NATIVE, deliberately. The scroll container scrolls itself —
// touch pan with momentum on the iPad, trackpad on a desk — and this module
// only LISTENS: when one strip scrolls, the other seven are placed so that the
// moment at its centre sits at their centres too. That is the engine's
// alignment-based sync policy (zoom-scroll.js, syncAllWaveformScrolls), rebuilt
// here over the injected projection because the engine's version reaches
// through listen.js's registries. The SEMANTICS — which moment corresponds —
// come from align-core via `project`, exactly like the cursors; only the
// scroll-position arithmetic is local.
//
// ZOOM ANCHORS ON THE PLAYHEAD, not the tap or the viewport centre. The
// transport's time is the exhibit's one source of truth, every strip already
// shows its cursor at that moment, and a zoom that keeps the cursor centred is
// the only one that never disorients: what you were looking at stays where it
// was. Anchoring the centre-of-view instead would diverge from the cursor the
// first time a visitor scrolled away and then zoomed.

import { fitPxPerSec } from "../js/engine/zoom-fit.js";
import { t } from "./strings.js";

/**
 * @param {object} opts
 * @param {number} opts.viewport
 * @param {Map<string, object>} opts.strips        file -> Strip (strips.js)
 * @param {number[]} opts.levels                   config.zoomLevels, ascending; 1 = fit
 * @param {string} opts.language                   for the buttons' aria-labels
 * @param {(time: number, from: string, to: string) => number|undefined} opts.project
 * @param {() => {file: string|null, time: number}} opts.anchor   the transport's now
 * @param {(level: number) => void} [opts.onChange] fires after strips re-render
 * @returns {{el: HTMLElement, level: () => number, setLevel: (l: number) => void,
 *   centerAllOn: (file: string, time: number) => void, refit: () => void}}
 */
export function createViewportZoom({
  viewport,
  strips,
  levels,
  language,
  project,
  anchor,
  onChange,
}) {
  let level = levels[0] ?? 1;
  // True while THIS module is writing scroll positions, so the scroll listener
  // can tell a visitor's pan from its own echo. Released a frame later because
  // programmatic scrollLeft writes dispatch their scroll events asynchronously.
  let syncing = false;

  const el = document.createElement("div");
  el.className = "zoom-ctl";
  el.dataset.viewport = String(viewport);

  const out = _button("zoom-out", "−", t("zoom.out", language));
  const readout = document.createElement("span");
  readout.className = "zoom-level";
  const zin = _button("zoom-in", "+", t("zoom.in", language));
  el.append(out, readout, zin);

  out.addEventListener("click", () => setLevel(levels[levels.indexOf(level) - 1]));
  zin.addEventListener("click", () => setLevel(levels[levels.indexOf(level) + 1]));

  /** The full rendered width a strip will have at `lvl`, without reading the DOM. */
  function zoomedWidth(strip, lvl) {
    const box = strip.host.clientWidth;
    if (lvl <= 1) return box;
    // Mirrors the renderer's own sizing: Math.ceil(duration * minPxPerSec).
    return Math.ceil(strip.duration * ((lvl * box) / strip.duration));
  }

  /** Scroll `strip` so `time` (its own timeline) sits at the viewport centre. */
  function centerOn(strip, time, lvl) {
    const box = strip.host.clientWidth;
    const full = zoomedWidth(strip, lvl);
    const target = (time / strip.duration) * full - box / 2;
    strip.ws.setScroll(Math.max(0, Math.min(target, full - box)));
  }

  /** Place every strip so `time`-in-`file` is centred everywhere. */
  function centerAllOn(file, time, lvl = level) {
    if (lvl <= 1 || !file || !strips.has(file)) return;
    _withSyncLock(() => {
      for (const [f, strip] of strips) {
        const at = f === file ? time : project(time, file, f);
        if (Number.isFinite(at)) centerOn(strip, at, lvl);
      }
    });
  }

  /**
   * Re-run the CURRENT level's geometry against the strips' present widths,
   * keeping the anchored moment centred. Exists because the widths can change
   * under a live zoom level — the side panel opening or closing resizes the
   * strips column — and every zoomed width here is derived from the container
   * width the strips had when the level was set.
   */
  function refit() {
    const { file, time } = anchor();
    _withSyncLock(() => {
      for (const strip of strips.values()) {
        if (level <= 1) {
          // Through the engine's fit arithmetic — the naive width/duration
          // reproduces the one-pixel overflow (see the header).
          strip.ws.zoom(fitPxPerSec(strip.host.clientWidth, strip.ws));
          strip.ws.setScroll(0);
        } else {
          strip.ws.zoom((level * strip.host.clientWidth) / strip.duration);
        }
      }
    });
    centerAllOn(file, time);
  }

  function setLevel(next) {
    if (!Number.isFinite(next) || !levels.includes(next) || next === level) return;
    level = next;
    refit();
    _paint();
    onChange?.(level);
  }

  /**
   * A visitor panned one strip: put the moment at its centre at the centre of
   * the other seven. rAF-coalesced — momentum scrolling emits a burst of events
   * per frame, and seven projections per event would be work the screen never
   * shows.
   */
  let pendingSource = null;
  function _onStripScroll(sourceFile) {
    if (syncing || level <= 1) return;
    const first = pendingSource === null;
    pendingSource = sourceFile;
    if (!first) return;
    requestAnimationFrame(() => {
      const src = strips.get(pendingSource);
      pendingSource = null;
      if (!src || level <= 1) return;
      const box = src.host.clientWidth;
      const full = zoomedWidth(src, level);
      const centreTime = ((src.ws.getScroll() + box / 2) / full) * src.duration;
      _withSyncLock(() => {
        for (const [f, strip] of strips) {
          if (f === src.file) continue;
          const at = project(centreTime, src.file, f);
          if (Number.isFinite(at)) centerOn(strip, at, level);
        }
      });
    });
  }

  for (const [file, strip] of strips) {
    strip.ws.on("scroll", () => _onStripScroll(file));
  }

  function _withSyncLock(fn) {
    syncing = true;
    try {
      fn();
    } finally {
      // Two frames, not one: programmatic scrolls dispatch their scroll events
      // in the frame's render steps, and Firefox has been seen delivering them
      // one frame later than Chromium.
      requestAnimationFrame(() => requestAnimationFrame(() => (syncing = false)));
    }
  }

  function _paint() {
    readout.textContent = level <= 1 ? "1×" : `${level}×`;
    out.disabled = levels.indexOf(level) <= 0;
    zin.disabled = levels.indexOf(level) >= levels.length - 1;
  }
  _paint();

  return { el, level: () => level, setLevel, centerAllOn, refit };
}

function _button(kind, glyph, label) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "zoom-btn";
  b.dataset.zoom = kind;
  // A glyph, not a word: the zoom buttons sit on a surface read in two
  // languages at once, so like the middle band they carry nothing to translate.
  // The accessible name still says what it does.
  b.textContent = glyph;
  b.setAttribute("aria-label", label);
  return b;
}
