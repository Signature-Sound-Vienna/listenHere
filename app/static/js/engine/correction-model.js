// correction-model.js — the pure model of hand corrections (anchors + gaps)
// to a score↔reference alignment (plan §14, increment 1).
//
// Vocabulary:
//   ANCHOR {i, q, t, kind, ts} — pins score event i (score_onset[i] = q
//     quarters) to reference time t seconds. kind: 'drag' (the user moved
//     it), 'approve' (the user confirmed the current value), or 'gap' (an
//     endpoint of an unscored-audio gap, owned by its gap record).
//   GAP {i, tEnd, tResume, ts} — labels the audio between events i and i+1
//     as unscored (a repeat the unfolded score lacks, applause, a pause).
//     It implies the two 'gap' anchors (i, tEnd) and (i+1, tResume);
//     consumers use the label to tell a discontinuity from an extreme
//     ritardando.
//   SEGMENT {iA, tA, iB, tB, interiorCount} — the events strictly between
//     two neighbouring anchors, the unit of DTW refill. iA === -1 is the
//     piece-start corner (tA = 0); iB === nEvents is the piece-end corner
//     (tB = refDuration) — the same corner-to-corner semantics as the
//     wizard's score_align.
//
// Pure data + arithmetic: no imports, no DOM, no Date (callers pass ts).
// The only mutation is applySegment / applyAnchorValue, which edit arrays
// the CALLER owns and hand back the before-values for its undo entry.

export const CORRECTIONS_VERSION = 1;

const ANCHOR_KINDS = ['drag', 'approve', 'gap'];

/** Fresh empty correction state. `audio` holds the audio-to-audio anchors
 *  per target recording (see the TARGET ANCHOR block below). */
export function createCorrections() {
  return { anchors: [], gaps: [], audio: {} };
}

/** The anchor pinning event i, or null. */
export function findAnchor(state, i) {
  return state.anchors.find((a) => a.i === i) || null;
}

/** The gap between events i and i+1, or null. */
export function findGap(state, i) {
  return state.gaps.find((g) => g.i === i) || null;
}

/**
 * The nearest anchors strictly before / after event i (null = the piece
 * corner on that side). Anchors are kept sorted by event index.
 */
export function neighbourAnchors(state, i) {
  let prev = null;
  let next = null;
  for (const a of state.anchors) {
    if (a.i < i) prev = a;
    else if (a.i > i) {
      next = a;
      break;
    }
  }
  return { prev, next };
}

function segmentBetween(prevAnchor, nextAnchor, ctx) {
  const iA = prevAnchor ? prevAnchor.i : -1;
  const tA = prevAnchor ? prevAnchor.t : 0;
  const iB = nextAnchor ? nextAnchor.i : ctx.nEvents;
  const tB = nextAnchor ? nextAnchor.t : ctx.refDuration;
  return { iA, tA, iB, tB, interiorCount: Math.max(0, iB - iA - 1) };
}

function assertCtx(ctx) {
  if (
    !ctx ||
    !Number.isInteger(ctx.nEvents) ||
    ctx.nEvents < 1 ||
    !Number.isFinite(ctx.refDuration) ||
    ctx.refDuration <= 0
  ) {
    throw new Error('correction-model: ctx needs {nEvents ≥ 1, refDuration > 0}');
  }
}

/**
 * Validate a candidate anchor time against its neighbours: strictly between
 * real neighbouring anchors, non-strictly within the piece corners.
 * `ignoreI` excludes an anchor being replaced from its own validation.
 */
function validateAnchorTime(state, i, t, ctx, ignoreI = null) {
  const { prev, next } = neighbourAnchors(state, i);
  const prevA = prev && prev.i === ignoreI ? null : prev;
  const nextA = next && next.i === ignoreI ? null : next;
  const lo = prevA ? prevA.t : 0;
  const hi = nextA ? nextA.t : ctx.refDuration;
  const loOk = prevA ? t > lo : t >= lo;
  const hiOk = nextA ? t < hi : t <= hi;
  if (!loOk || !hiOk) {
    throw new Error(
      `correction-model: anchor time ${t} for event ${i} is outside its ` +
        `neighbour bounds (${lo}, ${hi})`,
    );
  }
}

function insertSorted(state, anchor) {
  const at = state.anchors.findIndex((a) => a.i > anchor.i);
  if (at === -1) state.anchors.push(anchor);
  else state.anchors.splice(at, 0, anchor);
}

/**
 * Pin (or re-pin) event i at reference time t. Returns the two refill
 * segments flanking the anchor (left may have interiorCount 0). Replacing
 * an existing anchor at i updates it in place — including a gap anchor,
 * which stays owned by its gap only if the kind stays 'gap': re-pinning it
 * AS 'gap' moves that gap's boundary with it (increment 4's ruling — the
 * boundary is what the user places by ear), while re-pinning it with another
 * kind detaches it from the gap (the gap record is removed).
 */
export function setAnchor(state, { i, q, t, kind, ts }, ctx) {
  assertCtx(ctx);
  if (!Number.isInteger(i) || i < 0 || i >= ctx.nEvents) {
    throw new Error(`correction-model: anchor event index ${i} out of range`);
  }
  if (!Number.isFinite(t)) {
    throw new Error('correction-model: anchor time must be finite');
  }
  if (!ANCHOR_KINDS.includes(kind)) {
    throw new Error(`correction-model: unknown anchor kind "${kind}"`);
  }
  const existing = findAnchor(state, i);
  validateAnchorTime(state, i, t, ctx, existing ? i : null);
  if (existing) {
    if (existing.kind === 'gap' && kind !== 'gap') {
      // Re-pinning a gap endpoint as a plain anchor dissolves the gap label.
      state.gaps = state.gaps.filter((g) => g.i !== i && g.i + 1 !== i);
    }
    existing.q = q;
    existing.t = t;
    existing.kind = kind;
    existing.ts = ts;
  } else {
    insertSorted(state, { i, q, t, kind, ts });
  }
  if (kind === 'gap') syncGapTimes(state);
  const { prev, next } = neighbourAnchors(state, i);
  const self = findAnchor(state, i);
  return {
    segments: [segmentBetween(prev, self, ctx), segmentBetween(self, next, ctx)],
  };
}

/**
 * Remove the anchor at event i; returns the merged refill segment spanning
 * its former neighbours. Gap anchors are owned by their gap — remove the
 * gap instead.
 */
export function removeAnchor(state, i, ctx) {
  assertCtx(ctx);
  const at = state.anchors.findIndex((a) => a.i === i);
  if (at === -1) throw new Error(`correction-model: no anchor at event ${i}`);
  if (state.anchors[at].kind === 'gap') {
    throw new Error(
      `correction-model: anchor at event ${i} belongs to a gap — remove the gap`,
    );
  }
  state.anchors.splice(at, 1);
  const { prev, next } = neighbourAnchors(state, i);
  return { segment: segmentBetween(prev, next, ctx) };
}

/**
 * Label the span between events i and i+1 as unscored audio, anchoring
 * event i at tEnd and event i+1 at tResume. Any plain anchors already on
 * those events are converted. Returns the refill segments flanking the gap
 * (the gap itself has no interior events by construction).
 */
export function setGap(state, { i, tEnd, tResume, ts }, ctx) {
  assertCtx(ctx);
  if (!Number.isInteger(i) || i < 0 || i + 1 >= ctx.nEvents) {
    throw new Error(`correction-model: gap index ${i} out of range`);
  }
  if (!(Number.isFinite(tEnd) && Number.isFinite(tResume) && tEnd < tResume)) {
    throw new Error('correction-model: gap needs finite tEnd < tResume');
  }
  if (findGap(state, i)) {
    throw new Error(`correction-model: a gap between events ${i} and ${i + 1} exists`);
  }
  // Validate both endpoint times before touching state (ignore the two
  // events' own anchors, which the gap replaces).
  validateAnchorTime(state, i, tEnd, ctx, i);
  const probe = { anchors: state.anchors.filter((a) => a.i !== i), gaps: state.gaps };
  validateAnchorTime(probe, i + 1, tResume, ctx, i + 1);
  setAnchor(state, { i, q: null, t: tEnd, kind: 'gap', ts }, ctx);
  const res = setAnchor(state, { i: i + 1, q: null, t: tResume, kind: 'gap', ts }, ctx);
  state.gaps.push({ i, tEnd, tResume, ts });
  state.gaps.sort((a, b) => a.i - b.i);
  const { prev } = neighbourAnchors(state, i);
  return {
    segments: [
      segmentBetween(prev, findAnchor(state, i), ctx),
      res.segments[1],
    ],
  };
}

/**
 * Remove the gap between events i and i+1 along with its two anchors;
 * returns the merged refill segment spanning its former neighbours.
 */
export function removeGap(state, i, ctx) {
  assertCtx(ctx);
  const at = state.gaps.findIndex((g) => g.i === i);
  if (at === -1) throw new Error(`correction-model: no gap at event ${i}`);
  state.gaps.splice(at, 1);
  state.anchors = state.anchors.filter(
    (a) => !((a.i === i || a.i === i + 1) && a.kind === 'gap'),
  );
  const { prev, next } = neighbourAnchors(state, i);
  return { segment: segmentBetween(prev, next, ctx) };
}

/**
 * Make every gap record's boundary times follow its two 'gap' anchors. The
 * anchors are the values the correction loop edits (drags, undo, redo);
 * the record is the label consumers read — this keeps them one truth.
 * Callers that splice anchors directly (snapshot undo/redo) call it after.
 */
export function syncGapTimes(state) {
  for (const g of state.gaps) {
    const a = findAnchor(state, g.i);
    const b = findAnchor(state, g.i + 1);
    if (a && a.kind === 'gap') g.tEnd = a.t;
    if (b && b.kind === 'gap') g.tResume = b.t;
  }
}

/**
 * Splice a refill's interior values into the caller's arrays (events
 * strictly between segment.iA and segment.iB). Mutates refOnset/refOffset
 * in place; returns the before-values for the caller's undo entry.
 */
export function applySegment(refOnset, refOffset, segment, newOn, newOff) {
  const n = segment.interiorCount;
  if (newOn.length !== n || newOff.length !== n) {
    throw new Error(
      `correction-model: refill length ${newOn.length}/${newOff.length} ` +
        `does not match interiorCount ${n}`,
    );
  }
  const beforeOn = [];
  const beforeOff = [];
  for (let k = 0; k < n; k++) {
    const idx = segment.iA + 1 + k;
    beforeOn.push(refOnset[idx]);
    beforeOff.push(refOffset[idx]);
    refOnset[idx] = newOn[k];
    refOffset[idx] = newOff[k];
  }
  return { iA: segment.iA, iB: segment.iB, beforeOn, beforeOff };
}

/** Set one event's ref onset (the anchor's own value); returns the before-value. */
export function applyAnchorValue(refOnset, i, t) {
  const before = refOnset[i];
  refOnset[i] = t;
  return before;
}

// ---------------------------------------------------------------------------
// Audio-to-audio anchors (plan §14, increment 5)
//
//   TARGET ANCHOR {refT, t, kind, ts, i?, q?} — pins REFERENCE time refT to
//     time t of one target recording. Keyed by refT, not by event: the pair
//     is a statement about two recordings, so it survives a later
//     score↔reference edit (or a regeneration) that moves the tick it was
//     laid on. i/q are display hints only (the onset group it was laid on)
//     and are absent in a score-less session. kind: 'drag' | 'approve'.
//   GRID SEGMENT {refA, tA, refB, tB, kLo, kHi, interiorCount} — the raster
//     samples strictly between two neighbouring target anchors, the unit of
//     refill. kLo..kHi index the recording's grid, which is its own time
//     sampled on the reference raster; the corners are the grid's first and
//     last samples, frozen (a recording may start "late": tLo can be < 0).
//   ctx = {refGrid, tLo, tHi, base?} — the reference's own grid (the raster
//     times), the target grid's two corner values, and optionally the
//     per-target provenance recorded on the first anchor.
// ---------------------------------------------------------------------------

const TARGET_ANCHOR_KINDS = ['drag', 'approve'];
/** Two reference times this close are the same raster point / anchor. */
export const REF_T_EPS = 1e-6;

function assertTargetCtx(ctx) {
  if (
    !ctx ||
    !Array.isArray(ctx.refGrid) ||
    ctx.refGrid.length < 2 ||
    !Number.isFinite(ctx.tLo) ||
    !Number.isFinite(ctx.tHi) ||
    !(ctx.tHi > ctx.tLo)
  ) {
    throw new Error('correction-model: target ctx needs {refGrid[≥ 2], tLo < tHi}');
  }
}

/** The per-target slot {anchors, base}, created on demand when `create`. */
export function targetSlot(state, name, create = false) {
  if (!state.audio) state.audio = {};
  let slot = state.audio[name];
  if (!slot && create) slot = state.audio[name] = { anchors: [], base: null };
  return slot || null;
}

/** One target's anchors, sorted by refT (empty when none). */
export function targetAnchors(state, name) {
  return targetSlot(state, name)?.anchors || [];
}

/** Whether any target recording carries anchors. */
export function hasTargetAnchors(state) {
  return Object.values(state.audio || {}).some((s) => s.anchors.length > 0);
}

/** The anchor at reference time refT (within REF_T_EPS), or null. */
export function findTargetAnchor(state, name, refT) {
  return targetAnchors(state, name).find((a) => Math.abs(a.refT - refT) <= REF_T_EPS) || null;
}

/** The nearest anchors strictly before / after refT (null = the corner). */
export function neighbourTargetAnchors(state, name, refT) {
  let prev = null;
  let next = null;
  for (const a of targetAnchors(state, name)) {
    if (a.refT < refT - REF_T_EPS) prev = a;
    else if (a.refT > refT + REF_T_EPS) {
      next = a;
      break;
    }
  }
  return { prev, next };
}

/** First raster index k with refGrid[k] > x (beyond the eps). */
export function rasterAfter(refGrid, x) {
  let lo = 0;
  let hi = refGrid.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (refGrid[mid] <= x + REF_T_EPS) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Last raster index k with refGrid[k] < x (beyond the eps); -1 if none. */
export function rasterBefore(refGrid, x) {
  let lo = 0;
  let hi = refGrid.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (refGrid[mid] < x - REF_T_EPS) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

/** The raster index sitting ON refT (within eps), or -1. */
export function rasterAt(refGrid, refT) {
  const k = rasterAfter(refGrid, refT) - 1;
  return k >= 0 && Math.abs(refGrid[k] - refT) <= REF_T_EPS ? k : -1;
}

function gridSegmentBetween(prevAnchor, nextAnchor, ctx) {
  const g = ctx.refGrid;
  const last = g.length - 1;
  const refA = prevAnchor ? prevAnchor.refT : g[0];
  const tA = prevAnchor ? prevAnchor.t : ctx.tLo;
  const refB = nextAnchor ? nextAnchor.refT : g[last];
  const tB = nextAnchor ? nextAnchor.t : ctx.tHi;
  const kLo = prevAnchor ? rasterAfter(g, refA) : 1;
  const kHi = nextAnchor ? rasterBefore(g, refB) : last - 1;
  return { refA, tA, refB, tB, kLo, kHi, interiorCount: Math.max(0, kHi - kLo + 1) };
}

function validateTargetAnchor(state, name, refT, t, ctx, ignoreRefT = null) {
  const g = ctx.refGrid;
  if (!Number.isFinite(refT) || !(refT > g[0] + REF_T_EPS) || !(refT < g[g.length - 1] - REF_T_EPS)) {
    throw new Error(
      `correction-model: target anchor reference time ${refT} is not strictly ` +
        `inside the raster (${g[0]}, ${g[g.length - 1]})`,
    );
  }
  if (!Number.isFinite(t)) throw new Error('correction-model: target anchor time must be finite');
  const { prev, next } = neighbourTargetAnchors(state, name, refT);
  const prevA = prev && ignoreRefT !== null && Math.abs(prev.refT - ignoreRefT) <= REF_T_EPS ? null : prev;
  const nextA = next && ignoreRefT !== null && Math.abs(next.refT - ignoreRefT) <= REF_T_EPS ? null : next;
  const lo = prevA ? prevA.t : ctx.tLo;
  const hi = nextA ? nextA.t : ctx.tHi;
  const loOk = prevA ? t > lo : t >= lo;
  const hiOk = nextA ? t < hi : t <= hi;
  if (!loOk || !hiOk) {
    throw new Error(
      `correction-model: target anchor time ${t} at reference ${refT} is outside ` +
        `its neighbour bounds (${lo}, ${hi})`,
    );
  }
}

/**
 * Pin (or re-pin) reference time refT to target time t for recording `name`.
 * Returns the two grid segments flanking the anchor (either may have
 * interiorCount 0). ctx.base, when given, becomes the slot's provenance on
 * its first anchor.
 */
export function setTargetAnchor(state, name, { refT, t, kind, ts, i, q }, ctx) {
  assertTargetCtx(ctx);
  if (!TARGET_ANCHOR_KINDS.includes(kind)) {
    throw new Error(`correction-model: unknown target anchor kind "${kind}"`);
  }
  const existing = findTargetAnchor(state, name, refT);
  validateTargetAnchor(state, name, refT, t, ctx, existing ? existing.refT : null);
  const slot = targetSlot(state, name, true);
  if (!slot.base && ctx.base) slot.base = { ...ctx.base };
  const hint = {};
  if (Number.isInteger(i)) hint.i = i;
  if (Number.isFinite(q)) hint.q = q;
  if (existing) {
    Object.assign(existing, { t, kind, ts }, hint);
  } else {
    const anchor = { refT, t, kind, ts, ...hint };
    const at = slot.anchors.findIndex((a) => a.refT > refT);
    if (at === -1) slot.anchors.push(anchor);
    else slot.anchors.splice(at, 0, anchor);
  }
  const self = findTargetAnchor(state, name, refT);
  const { prev, next } = neighbourTargetAnchors(state, name, refT);
  return {
    segments: [gridSegmentBetween(prev, self, ctx), gridSegmentBetween(self, next, ctx)],
  };
}

/** Remove the anchor at refT; returns the merged segment between its former neighbours. */
export function removeTargetAnchor(state, name, refT, ctx) {
  assertTargetCtx(ctx);
  const slot = targetSlot(state, name);
  const at = slot ? slot.anchors.findIndex((a) => Math.abs(a.refT - refT) <= REF_T_EPS) : -1;
  if (at === -1) {
    throw new Error(`correction-model: no target anchor at reference time ${refT} for ${name}`);
  }
  slot.anchors.splice(at, 1);
  const { prev, next } = neighbourTargetAnchors(state, name, refT);
  return { segment: gridSegmentBetween(prev, next, ctx) };
}

/**
 * Splice a refill's values into the target grid IN PLACE (the loaded grid and
 * the alignment JSON's `times` alias one array — never replace it). Returns
 * the before-values for the caller's undo entry.
 */
export function applyGridSegment(grid, segment, values) {
  const n = segment.interiorCount;
  if (values.length !== n) {
    throw new Error(
      `correction-model: grid refill length ${values.length} does not match interiorCount ${n}`,
    );
  }
  const before = grid.slice(segment.kLo, segment.kLo + n);
  for (let k = 0; k < n; k++) grid[segment.kLo + k] = values[k];
  return { kLo: segment.kLo, kHi: segment.kHi, before };
}

/**
 * An anchor whose refT sits ON a raster sample owns that sample's value (the
 * analogue of applyAnchorValue); between samples the flanking refills, forced
 * through the anchor, carry it. Returns {k, before} or null.
 */
export function applyTargetAnchorValue(grid, refGrid, refT, t) {
  const k = rasterAt(refGrid, refT);
  if (k === -1) return null;
  const before = grid[k];
  grid[k] = t;
  return { k, before };
}

/**
 * The durable hand-correction record for header.corrections. `base` is the
 * provenance of the alignment the corrections were applied to (Verovio
 * version + options stamps, alignmentParams, …) — the item-T guard's data.
 * `audio` (present only when some target carries anchors) holds the
 * audio-to-audio anchors per target recording with that grid's provenance.
 */
export function serialize(state, base) {
  const out = {
    version: CORRECTIONS_VERSION,
    base: base || null,
    anchors: state.anchors.map((a) => ({ ...a })),
    gaps: state.gaps.map((g) => ({ ...g })),
  };
  const audio = {};
  for (const [name, slot] of Object.entries(state.audio || {})) {
    if (!slot.anchors.length) continue;
    audio[name] = { base: slot.base || null, anchors: slot.anchors.map((a) => ({ ...a })) };
  }
  if (Object.keys(audio).length) out.audio = audio;
  return out;
}

/** Rebuild correction state from a header.corrections record. */
export function deserialize(record) {
  if (!record || record.version !== CORRECTIONS_VERSION) {
    throw new Error(
      `correction-model: unsupported corrections record version ` +
        `${record && record.version}`,
    );
  }
  const state = createCorrections();
  for (const a of record.anchors || []) {
    if (!Number.isInteger(a.i) || !Number.isFinite(a.t) || !ANCHOR_KINDS.includes(a.kind)) {
      throw new Error('correction-model: malformed anchor in corrections record');
    }
    state.anchors.push({ ...a });
  }
  for (const g of record.gaps || []) {
    if (!Number.isInteger(g.i) || !Number.isFinite(g.tEnd) || !Number.isFinite(g.tResume)) {
      throw new Error('correction-model: malformed gap in corrections record');
    }
    state.gaps.push({ ...g });
  }
  state.anchors.sort((a, b) => a.i - b.i);
  state.gaps.sort((a, b) => a.i - b.i);
  // Additive since 0.59.0: a record without `audio` is a record with no
  // audio-to-audio anchors, so older files load unchanged.
  for (const [name, slot] of Object.entries(record.audio || {})) {
    const anchors = [];
    for (const a of slot?.anchors || []) {
      if (!Number.isFinite(a.refT) || !Number.isFinite(a.t) || !TARGET_ANCHOR_KINDS.includes(a.kind)) {
        throw new Error(`correction-model: malformed target anchor for ${name} in corrections record`);
      }
      anchors.push({ ...a });
    }
    anchors.sort((x, y) => x.refT - y.refT);
    state.audio[name] = { anchors, base: slot?.base || null };
  }
  return { state, base: record.base || null };
}

/**
 * The item-T entry guard: a freshly rendered MIDI's onset quarters must
 * match the stored score_onset exactly (the make_standins 2,453/2,453
 * check). Refuse fix mode on any mismatch — anchors laid on a skewed
 * quarters basis are poisoned data.
 */
export function verifyQuarters(storedQuarters, freshQuarters, epsilon = 1e-6) {
  if (storedQuarters.length !== freshQuarters.length) {
    return {
      ok: false,
      lengthMismatch: true,
      mismatchCount: Math.abs(storedQuarters.length - freshQuarters.length),
      firstMismatch: null,
    };
  }
  let mismatchCount = 0;
  let firstMismatch = null;
  for (let k = 0; k < storedQuarters.length; k++) {
    if (Math.abs(storedQuarters[k] - freshQuarters[k]) > epsilon) {
      mismatchCount++;
      if (!firstMismatch) {
        firstMismatch = { index: k, stored: storedQuarters[k], fresh: freshQuarters[k] };
      }
    }
  }
  return { ok: mismatchCount === 0, lengthMismatch: false, mismatchCount, firstMismatch };
}
