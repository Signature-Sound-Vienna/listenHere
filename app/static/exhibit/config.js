// exhibit/config.js
//
// Display geometry, as configuration rather than as assumptions baked into CSS.
//
// The laptop, the iPad, and the eventual museum table are three CONFIGURATIONS of
// one build, not three builds (plan §7.8). The hardware install date is an
// external dependency with no date attached, so the geometry has to be a value we
// can change rather than a layout we have to rewrite — and if the table turns out
// to be a different size or a different split, that must cost a query parameter.
//
// Every field is overridable from the query string, which is how Spike C was run
// across two very different screens without editing it. Same idea here.
//
// ZERO imports, by rule (see ENGINE-WANTS.md).

/**
 * Two viewports facing each other across the table: the portrait screen splits
 * into two landscape halves, and the far half is rotated 180° so the person on
 * the other side reads it the right way up.
 *
 * Measured on the real device 2026-08-24: the 13-inch iPad Air is 1024×1366 CSS
 * at dpr 2, so each half gets 1024×~640 and eight 54 px strips use 432 px of it.
 */
const DEFAULTS = {
  // --- content selection ---
  // Which prepped payload to load. The stretch goal for the attract loop is a
  // second piece (Kaiserwalzer, which needs no annotations to autoplay), so the
  // piece is a parameter from the start rather than a path spelled out in the
  // loader — `?piece=kaiserwalzer` is the whole change.
  piece: "fledermaus",

  // --- geometry ---
  viewports: 2,
  splitOrientation: "horizontal", // "horizontal" = stacked halves; "vertical" = side by side
  rotations: [0, 180], // per viewport, degrees; index beyond the end means 0
  stackedRecordings: 8,
  // 48, down from week 1's 54: the commentary panel absorbs whatever height the
  // strips leave over, and at 54 the longest authored text showed two lines on
  // the iPad's halves (measured; annotation-list.js). Six pixels a strip buys
  // the panel ~78 px — the waveforms are the overview, the commentary is the
  // exhibit's voice, and `?stripHeight=54` puts the week-1 look back for an
  // eyeball comparison.
  stripHeight: 48, // CSS px per waveform strip
  middleBandHeight: 96, // conductor, year, portrait — and NO UI labels (plan §6.3)
  // Desktop-debugging convenience, never set on the kiosk: rotate the WHOLE
  // composed screen 90° or 270° so a physically turned laptop or a swivelled
  // monitor shows the portrait kiosk at its intended aspect. Applied as one
  // final-touch transform on #screen (see exhibit.css) — layout, measurement,
  // and WaveSurfer's canvas sizing all run untransformed, and the browser maps
  // pointer coordinates back through the transform, so nothing inside can tell.
  // A query parameter rather than any environment sniffing, by the §7.8 rule:
  // laptop, iPad, and table are configurations of one build.
  stageRotation: 0,

  // --- waveform ---
  // 0 means FIT THE WHOLE RECORDING INTO THE STRIP, which is WaveSurfer's
  // `fillParent` behaviour when `minPxPerSec` is 0. That is the right resting
  // state for this interface and not merely a convenient default: the exhibit's
  // whole proposition is seeing eight interpretations of the *same* moment at
  // once, and at the previous default of 30 px/s a 582 s overture shows about 3%
  // of itself, so the stacked comparison has nothing to compare. Per-viewport
  // zoom and scroll arrive in week 2 (plan §4.2); until then `?zoom=30` is still
  // one query parameter away.
  zoom: 0,
  // The steps the per-viewport zoom buttons walk (1 = fit-to-width, the resting
  // state above). Capped at 8× deliberately: the renderer draws lazily in
  // container-width chunks (measured, see exhibit/zoom.js), but chunks
  // accumulate as a visitor scrolls, and at 8× a fully-scrolled viewport stays
  // inside the canvas-memory envelope Spike C measured on the real iPad. Raise
  // this only with the §7.2 device test in hand.
  zoomLevels: [1, 2, 4, 8],
  peakBuckets: 4096, // what the alignment JSON ships
  // Regions narrower than this vanish entirely at fit-to-width — 582 s across
  // ~1000 px is 0.58 s per pixel, and `D or E?` region (a) is 0.012–0.120 s wide
  // (plan §5.2d). Sub-pixel regions are widened symmetrically to at least this,
  // and marked provisional when they were flagged for hand placement, rather than
  // being silently dropped or silently drawn at a misleading width.
  minRegionPx: 4,

  // --- content ---
  // Audience and language are resolved PER VIEWPORT, never swapped globally, so
  // these are only the starting values for each half (plan §5.3).
  audiences: ["adults", "adults"],
  languages: ["en", "en"],

  // --- operations ---
  attractAfterIdleMs: 0, // 0 disables the attract loop; week 4 turns it on
  debug: false,
};

/** Coerce a query-string value to the type of the default it is replacing. */
function _coerce(raw, fallback) {
  if (Array.isArray(fallback)) {
    const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
    if (!parts.length) return fallback;
    return typeof fallback[0] === "number" ? parts.map(Number) : parts;
  }
  if (typeof fallback === "number") {
    const n = parseFloat(raw);
    return Number.isFinite(n) ? n : fallback;
  }
  if (typeof fallback === "boolean") return raw !== "0" && raw !== "false";
  return raw;
}

/**
 * Resolve the display configuration, letting the query string override any field.
 *
 * @param {string|URLSearchParams} [search] defaults to the current location
 * @returns {typeof DEFAULTS} a fresh object; DEFAULTS is never mutated
 */
export function readConfig(search = typeof location === "undefined" ? "" : location.search) {
  const q = search instanceof URLSearchParams ? search : new URLSearchParams(search);
  const out = { ...DEFAULTS };
  for (const [key, fallback] of Object.entries(DEFAULTS)) {
    if (!q.has(key)) continue;
    out[key] = _coerce(q.get(key), fallback);
  }
  // A viewport count the other per-viewport arrays cannot cover is a config bug
  // that would otherwise surface as an undefined rotation halfway through layout.
  out.viewports = Math.max(1, Math.round(out.viewports));
  return out;
}

/** Rotation in degrees for viewport `i` — 0 for anything the config doesn't name. */
export function rotationFor(config, i) {
  return Number(config.rotations?.[i]) || 0;
}

export { DEFAULTS };
