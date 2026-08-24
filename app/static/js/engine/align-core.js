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
 * @returns {number} grid index, 0 when the grid is missing
 */
export function getClosestAlignmentIx(grids, time, audioIx) {
  console.log("Get closest alignment Ix: ", time, audioIx);
  // return alignment index closest to supplied time (default: current playback position)
  let currentGrid = grids[audioIx];
  if (!currentGrid) {
    _warnMissingGrid(grids, "getClosestAlignmentIx", audioIx);
    return 0;
  }
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
