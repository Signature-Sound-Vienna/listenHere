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
  // --- geometry ---
  viewports: 2,
  splitOrientation: "horizontal", // "horizontal" = stacked halves; "vertical" = side by side
  rotations: [0, 180], // per viewport, degrees; index beyond the end means 0
  stackedRecordings: 8,
  stripHeight: 54, // CSS px per waveform strip
  middleBandHeight: 96, // conductor, year, portrait — and NO UI labels (plan §6.3)

  // --- waveform ---
  zoom: 30, // minPxPerSec at rest
  peakBuckets: 4096, // what the alignment JSON ships

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
