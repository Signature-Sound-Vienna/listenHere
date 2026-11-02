// engine/legacy-alignment.js
//
// Converts the score table written by the legacy SyncToolbox CLI
// (signature-sound-vienna/alignment, align-to-score.py) into the table this
// app's aligner writes, so such files open in the listen view and fix mode.
//
// The two tables differ in kind, not just in values:
//
//   legacy (align-to-score.py)            this app (align-worker, fix mode)
//   ------------------------------------  ------------------------------------
//   positions in SECONDS (pretty_midi,    positions in QUARTERS (tick / tpq)
//     through the MIDI's tempo map)
//   onsets and offsets deduplicated       one event per unique (start, end)
//     separately, so their lengths differ   tick pair; all four arrays share
//   percussion (pitch 0) dropped            one length
//
// Detection is positive: the stored score_onset must fail to match the fresh
// render as quarters AND match its note starts as seconds. Anything else is
// left alone, so a file this app wrote can never be "converted".
//
// The conversion rebuilds the event table from the freshly rendered MIDI and
// takes each event's reference time from the legacy (seconds → ref) pairs:
// looked up exactly where the legacy table carries that score time (every
// pitched note when the CLI rendered the same MIDI), linearly interpolated
// otherwise. Both legacy lists sample one warping path, so they are merged
// for interpolation.
//
// Pure functions over their arguments: no module state, no DOM.

import { tickToSec } from "./mei-synth.js";

/** Seconds within this of a note time count as that note time. */
const SEC_TOL = 1e-3;
/** Share of legacy onsets that must land on a note start, as seconds. */
const MIN_SECONDS_HIT_RATE = 0.98;

/** Index of the value in sorted `xs` nearest `x`, or -1 when none is within tol. */
function _nearest(xs, x, tol) {
  let lo = 0,
    hi = xs.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (xs[m] < x) lo = m + 1;
    else hi = m;
  }
  let best = -1,
    bestD = tol;
  for (const i of [lo - 1, lo]) {
    if (i < 0 || i >= xs.length) continue;
    const d = Math.abs(xs[i] - x);
    if (d <= bestD) {
      best = i;
      bestD = d;
    }
  }
  return best;
}

/** (x → y) pairs sorted by x, first pair per x kept. */
function _pairs(xs, ys) {
  const n = Math.min(xs?.length ?? 0, ys?.length ?? 0);
  const ps = [];
  for (let i = 0; i < n; i++) ps.push([xs[i], ys[i]]);
  ps.sort((a, b) => a[0] - b[0]);
  const out = { xs: [], ys: [] };
  for (const [x, y] of ps) {
    if (out.xs.length && x === out.xs[out.xs.length - 1]) continue;
    out.xs.push(x);
    out.ys.push(y);
  }
  return out;
}

/** Piecewise-linear y(x), edge-slope extrapolation outside the knots. */
function _interp({ xs, ys }, x) {
  const n = xs.length;
  if (n === 1) return ys[0];
  let i;
  if (x <= xs[0]) i = 0;
  else if (x >= xs[n - 1]) i = n - 2;
  else {
    let lo = 0,
      hi = n - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (xs[m] <= x) lo = m;
      else hi = m;
    }
    i = lo;
  }
  const dx = Math.max(xs[i + 1] - xs[i], 1e-9);
  return ys[i] + ((x - xs[i]) / dx) * (ys[i + 1] - ys[i]);
}

/**
 * Is `score` a legacy seconds table for the MIDI described by notes/tpq/tempo?
 * Returns the onset hit rate when it is, else null.
 */
export function detectLegacySecondsTable(score, notes, tpq, tempoChanges) {
  const on = score?.score_onset;
  if (!Array.isArray(on) || on.length < 2 || !notes?.length || !tpq)
    return null;
  // Already quarters? Then this app's own path handles it.
  const qKey = (q) => Math.round(q * 1e6);
  const startQ = new Set(notes.map((n) => qKey(n.s / tpq)));
  if (on.every((q) => startQ.has(qKey(q)))) return null;
  const startSec = [...new Set(notes.map((n) => n.s))]
    .sort((a, b) => a - b)
    .map((t) => tickToSec(t, tpq, tempoChanges));
  let hits = 0;
  for (const s of on) if (_nearest(startSec, s, SEC_TOL) >= 0) hits++;
  const rate = hits / on.length;
  return rate >= MIN_SECONDS_HIT_RATE ? rate : null;
}

/**
 * Convert a legacy seconds table to this app's quarters table, built from the
 * fresh render's notes. Returns { table, report } or null when `score` is not
 * a legacy seconds table (see detectLegacySecondsTable).
 */
export function convertLegacySecondsTable(score, notes, tpq, tempoChanges) {
  const rate = detectLegacySecondsTable(score, notes, tpq, tempoChanges);
  if (rate === null) return null;

  // The aligner's event table: one event per unique (start, end) tick pair,
  // sorted by that pair (as align-worker's score_align and fix mode build it).
  const seen = new Set();
  const events = [];
  for (const n of notes) {
    const k = n.s + ":" + n.e;
    if (!seen.has(k)) {
      seen.add(k);
      events.push(n);
    }
  }
  events.sort((a, b) => a.s - b.s || a.e - b.e);

  const onPairs = _pairs(score.score_onset, score.ref_onset);
  const offPairs = _pairs(score.score_offset, score.ref_offset);
  const merged = _pairs(
    [...onPairs.xs, ...offPairs.xs],
    [...onPairs.ys, ...offPairs.ys],
  );

  const report = {
    legacyOnsets: score.score_onset.length,
    legacyOffsets: score.score_offset?.length ?? 0,
    events: events.length,
    onsetHitRate: rate,
    exactOnsets: 0,
    exactOffsets: 0,
  };
  // Exact from the event's own legacy list, else interpolated over both.
  const refAt = (own, sec, field) => {
    const i = own.xs.length ? _nearest(own.xs, sec, SEC_TOL) : -1;
    if (i >= 0) {
      report[field]++;
      return own.ys[i];
    }
    return _interp(merged, sec);
  };

  const table = {
    score_onset: [],
    ref_onset: [],
    score_offset: [],
    ref_offset: [],
  };
  for (const ev of events) {
    table.score_onset.push(ev.s / tpq);
    table.score_offset.push(ev.e / tpq);
    table.ref_onset.push(
      refAt(onPairs, tickToSec(ev.s, tpq, tempoChanges), "exactOnsets"),
    );
    table.ref_offset.push(
      refAt(offPairs, tickToSec(ev.e, tpq, tempoChanges), "exactOffsets"),
    );
  }
  return { table, report };
}
