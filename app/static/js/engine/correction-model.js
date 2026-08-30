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

/** Fresh empty correction state. */
export function createCorrections() {
  return { anchors: [], gaps: [] };
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
 * which stays owned by its gap only if the kind stays 'gap'; re-pinning it
 * with another kind detaches it from the gap (the gap record is removed).
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

/**
 * The durable hand-correction record for header.corrections. `base` is the
 * provenance of the alignment the corrections were applied to (Verovio
 * version + options stamps, alignmentParams, …) — the item-T guard's data.
 */
export function serialize(state, base) {
  return {
    version: CORRECTIONS_VERSION,
    base: base || null,
    anchors: state.anchors.map((a) => ({ ...a })),
    gaps: state.gaps.map((g) => ({ ...g })),
  };
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
