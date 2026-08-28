// engine/time-map.js
//
// The composed score-time ↔ performance-time mapping: quarters → reference
// seconds (piecewise-linear over the alignment's deduplicated onset pairs) →
// any recording's seconds (its alignment grid, frame-interpolated), with the
// inverse of every stage. This is the one place that owns the chain, because
// two consumers with their own copy of this arithmetic is exactly how they
// start disagreeing about when a note happens.
//
// Consumers (plan §12/§13): the MIDI stand-in tool warps score-derived MIDI
// onto each recording's timeline through quartersToSec; the score-time and
// pinned-note axis modes render through the same maps and their inverses; a
// score-less alignment can still use the grid half alone (refSecToSec /
// secToRefSec) with reference time as the common axis.
//
// Route via QUARTERS, never via stored synth seconds: synth_onset embeds the
// generating toolkit's tempo semantics (the 4 s tick-0 tie-break skew class,
// fixed in 0.37.1), while tick/tpq quarters are exact and were verified to
// match score_onset 2,453/2,453 under Verovio 5.6.0 and 6.3.0+expandNever.
//
// Align-core family: pure functions over their arguments — no module state,
// no DOM, no imports (spec 33.3 ratchets this at zero).

/**
 * Collapse duplicate x values (chord onsets share a quarter) so xs is strictly
 * increasing. The first pair per x wins; in the alignment data duplicates
 * carry identical y (verified), so the choice only matters defensively.
 * Pairs must arrive sorted by x, which score_onset/ref_onset and the grids
 * already guarantee.
 *
 * @param {number[]} xs  nondecreasing
 * @param {number[]} ys  same length
 * @returns {{xs: number[], ys: number[]}}
 */
export function dedupePairs(xs, ys) {
  const ox = [];
  const oy = [];
  for (let i = 0; i < xs.length; i++) {
    if (ox.length && xs[i] === ox[ox.length - 1]) continue;
    ox.push(xs[i]);
    oy.push(ys[i]);
  }
  return { xs: ox, ys: oy };
}

/**
 * Monotonic piecewise-linear map over (xs, ys) knots. Beyond the knots,
 * extrapolate by the edge segment's slope. Deliberately NO clamping anywhere
 * — not even interpAlignmentGrid's left-edge floor at 0 — because knot values
 * themselves can be legitimately negative (a DTW grid can start below zero
 * when a recording begins "late" against the reference), and clamping only
 * part of the range breaks monotonicity while clamping all of it breaks
 * exact inversion. Nonnegative-playable-time is the consumer's concern.
 * xs must be strictly increasing — run dedupePairs first when it might not be.
 *
 * @param {number[]} xs  strictly increasing knot inputs
 * @param {number[]} ys  knot outputs (nondecreasing for a time map)
 * @returns {(x: number) => number}
 */
export function piecewiseLinear(xs, ys) {
  const n = xs.length;
  if (!n) return () => 0;
  if (n === 1) return () => ys[0];
  const slope0 = (ys[1] - ys[0]) / Math.max(xs[1] - xs[0], 1e-9);
  const slopeN =
    (ys[n - 1] - ys[n - 2]) / Math.max(xs[n - 1] - xs[n - 2], 1e-9);
  return (x) => {
    if (x <= xs[0]) return ys[0] + slope0 * (x - xs[0]);
    if (x >= xs[n - 1]) return ys[n - 1] + slopeN * (x - xs[n - 1]);
    let lo = 0,
      hi = n - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (xs[m] <= x) lo = m;
      else hi = m;
    }
    return (
      ys[lo] +
      ((x - xs[lo]) / Math.max(xs[hi] - xs[lo], 1e-9)) * (ys[hi] - ys[lo])
    );
  };
}

/**
 * Build the composed time map for one recording.
 *
 * The grid half maps between the reference's timeline and the target
 * recording's: both grids share the alignment frame index (align-core's
 * contract), so (refGrid[i], targetGrid[i]) are the knots directly. The score
 * half maps quarters ↔ reference seconds over the deduplicated
 * (scoreOnset, refOnset) pairs. Composition gives quarters ↔ target seconds.
 *
 * Score-less alignments: omit scoreOnset/refOnset and use the grid half
 * (refSecToSec / secToRefSec) alone; the quarter maps are then null.
 * Mapping the reference onto itself (targetGrid === refGrid) is legal and
 * yields identity for the grid half — that is the score↔reference QA case.
 *
 * All returned functions are total: outside the knots they extrapolate by
 * the edge slope, and values pass through unclamped — a map onto a recording
 * that starts "late" against the reference can legitimately return small
 * negative seconds. Clamp at the playback layer, not here.
 *
 * @param {object} args
 * @param {number[]} [args.scoreOnset]  onset quarters, nondecreasing (chord
 *                                      duplicates fine)
 * @param {number[]} [args.refOnset]    matching reference seconds
 * @param {number[]} args.refGrid       the reference recording's grid
 * @param {number[]} args.targetGrid    the target recording's grid (same
 *                                      length, same frame index)
 * @returns {{
 *   quartersToSec: ((q: number) => number) | null,
 *   secToQuarters: ((s: number) => number) | null,
 *   quartersToRefSec: ((q: number) => number) | null,
 *   refSecToQuarters: ((s: number) => number) | null,
 *   refSecToSec: (s: number) => number,
 *   secToRefSec: (s: number) => number,
 *   onsetQuarters: number[] | null,
 * }}
 */
export function buildTimeMap({ scoreOnset, refOnset, refGrid, targetGrid }) {
  if (!refGrid || !targetGrid || refGrid.length !== targetGrid.length)
    throw new Error(
      "buildTimeMap: refGrid and targetGrid must be same-length arrays",
    );
  const grid = dedupePairs(refGrid, targetGrid);
  const refSecToSec = piecewiseLinear(grid.xs, grid.ys);
  const gridInv = dedupePairs(grid.ys, grid.xs);
  const secToRefSec = piecewiseLinear(gridInv.xs, gridInv.ys);

  let quartersToRefSec = null,
    refSecToQuarters = null,
    quartersToSec = null,
    secToQuarters = null,
    onsetQuarters = null;
  if (scoreOnset && scoreOnset.length && refOnset) {
    if (scoreOnset.length !== refOnset.length)
      throw new Error(
        "buildTimeMap: scoreOnset and refOnset must be same-length arrays",
      );
    const score = dedupePairs(scoreOnset, refOnset);
    onsetQuarters = score.xs;
    quartersToRefSec = piecewiseLinear(score.xs, score.ys);
    const scoreInv = dedupePairs(score.ys, score.xs);
    refSecToQuarters = piecewiseLinear(scoreInv.xs, scoreInv.ys);
    quartersToSec = (q) => refSecToSec(quartersToRefSec(q));
    secToQuarters = (s) => refSecToQuarters(secToRefSec(s));
  }

  return {
    quartersToSec,
    secToQuarters,
    quartersToRefSec,
    refSecToQuarters,
    refSecToSec,
    secToRefSec,
    onsetQuarters,
  };
}
