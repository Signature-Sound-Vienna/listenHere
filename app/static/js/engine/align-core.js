// engine/align-core.js
//
// The alignment-index ↔ time mapping, and nothing else. Every consumer of an
// alignment grid — Listen Here, the museum exhibit, primal — has to agree on
// what an alignment index *means*, so this is semantics rather than convention
// and it gets extracted rather than copied. Two codebases with their own copy
// of this arithmetic is exactly how they start disagreeing about which moment
// an annotation is about.
//
// Pure functions over their arguments: the grid collection arrives as the first
// parameter, so there is no module state to share, no DOM, no WaveSurfer, and
// no import back into listen.js. The one piece of retained state is the
// warned-about-this-grid set, which exists only to keep the console usable.
//
// listen.js keeps thin wrappers under the historic names and supplies both
// defaults (current playback time, current recording) from its own signature,
// so all 37 existing call sites across 7 modules are untouched.
//
// Extracted from listen.js (Phase 2, week 0, plan §4.0b). Behaviour-preserving.

/**
 * Alignment index closest to `time` in the grid for `audioIx`.
 * @param {Record<string, number[]>} grids  alignment grids, keyed by recording
 * @param {number} time                     time in seconds
 * @param {string} audioIx                  the recording's key
 * @param {[number, number]|null} [range]   aligned index range (see
 *   alignedIndexRange): a time outside it parks at its nearer edge
 * @returns {number} grid index, 0 when the grid is missing
 */
export function getClosestAlignmentIx(grids, time, audioIx, range = null) {
  // No trace log here. It was an unconditional console.log of every call, which
  // was survivable while the only caller was Listen Here reacting to clicks — and
  // is not, now that the exhibit calls this once per animation frame to place
  // sixteen cursors. 60 lines of console per second is not a diagnostic.
  // return alignment index closest to supplied time (default: current playback position)
  let currentGrid = grids[audioIx];
  if (!currentGrid) {
    _warnMissingGrid(grids, "getClosestAlignmentIx", audioIx);
    return 0;
  }
  const ix = _closestIx(currentGrid, time);
  if (!range) return ix;
  return Math.min(Math.max(ix, range[0]), range[1]);
}

function _closestIx(currentGrid, time) {
  // find the last grid entry at or below target time
  const lower = currentGrid.filter((t) => t <= time);
  const belowIx = lower.length - 1; // last index at or below time
  const aboveIx = lower.length; // first index above time
  if (belowIx < 0) return 0; // time is before grid start
  if (aboveIx >= currentGrid.length) return belowIx; // time is past grid end
  // return whichever is closer (prefer earlier on tie)
  const distBelow = time - currentGrid[belowIx];
  const distAbove = currentGrid[aboveIx] - time;
  return distAbove < distBelow ? aboveIx : belowIx;
}

/**
 * The grid indices that have a counterpart in every recording, as [lo, hi].
 *
 * Open-ended alignment aligns every pair against the SAME stretch of the
 * reference — its span, alignedFrom..alignedTo — and the grid runs over the
 * whole reference file. Indices whose reference time falls outside that span
 * are extrapolated, not aligned: they map applause onto applause, or onto a
 * recording's last sample, by the slope of a single path step. So the span is
 * one index range shared by all recordings, and inside it each recording's
 * times lie within its own span.
 *
 * @param {Record<string, number[]>} grids  alignment grids, keyed by recording
 * @param {Record<string, {from: number, to: number}>} spans  aligned spans
 * @param {string} refKey                   the reference recording's key
 * @returns {[number, number]|null} null when the whole grid is aligned
 */
export function alignedIndexRange(grids, spans, refKey) {
  const g = grids?.[refKey];
  const span = spans?.[refKey];
  if (!Array.isArray(g) || !g.length || !span) return null;
  // The reference maps to itself: its grid holds reference seconds.
  const eps = 1e-6;
  let lo = 0;
  while (lo < g.length && g[lo] < span.from - eps) lo++;
  let hi = g.length - 1;
  while (hi >= 0 && g[hi] > span.to + eps) hi--;
  if (lo > hi || (lo === 0 && hi === g.length - 1)) return null;
  return [lo, hi];
}

/**
 * Time in `audioIx`'s timeline for a given alignment index.
 * @param {Record<string, number[]>} grids  alignment grids, keyed by recording
 * @param {string} audioIx                  the recording's key
 * @param {number} alignmentIx              grid index
 * @returns {number|undefined} seconds, or undefined when the grid is missing
 */
export function getCorrespondingTime(grids, audioIx, alignmentIx) {
  // get time position corresponding to current position of current audio,
  // in the alternative audio with index audioIx
  let grid = grids[audioIx];
  if (!grid) {
    // A waveform outliving its alignment grid means state got mixed (#32).
    // Degrade instead of throwing, and name the key so it stays diagnosable.
    _warnMissingGrid(grids, "getCorrespondingTime", audioIx);
    return undefined;
  }
  return grid[alignmentIx];
}

// Missing-grid warnings, one per key, so a repeating render loop can't flood
// the console while still reporting every distinct offender.
const _warnedMissingGrids = new Set();
function _warnMissingGrid(grids, where, audioIx) {
  const key = where + "|" + audioIx;
  if (_warnedMissingGrids.has(key)) return;
  _warnedMissingGrids.add(key);
  console.warn(
    `${where}: no alignment grid for "${audioIx}" — ` +
      `known keys: ${Object.keys(grids).join(", ")}`,
  );
}
