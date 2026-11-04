// Re-basing an alignment onto an edited score.
//
// An alignment's score tables (score_onset/score_offset in quarters, and the
// synth_onset/synth_offset seconds derived from them) belong to the MEI they
// were rendered from. When that MEI is edited afterwards — a tempo mark over
// grace notes, whose ~31 ms Verovio lead moves them in quarters, or a tie that
// lengthens an event — the stored quarters no longer match a fresh render.
// If every event is still recognisably the same event, the tables can be
// re-based onto the current score: the recording side (ref_onset, anchors'
// recording times) is untouched, only the score positions are refreshed.

/** Largest per-event onset shift, in quarters, that still counts as the same
 *  event. Verovio gives an unaccented grace note a fixed ~31 ms lead, so its
 *  quarter position moves with the tempo: 116 → 176 bpm moved Fledermaus's
 *  graces by 0.033 q; the whole lead is 0.125 q even at 240 bpm. */
export const MAX_EVENT_SHIFT_Q = 0.125;

const EPS_Q = 1e-6;

/** -1, 0, or 1: how event i+1 stands to event i (before, together, after). */
function _order(a, b) {
  return b - a > EPS_Q ? 1 : a - b > EPS_Q ? -1 : 0;
}

/**
 * Can the stored score tables be re-based onto a fresh render? Requires the
 * same event count, every onset within MAX_EVENT_SHIFT_Q of its stored value,
 * and no change of order between neighbouring events (an event that became
 * simultaneous with its neighbour, or stopped being, may have swapped places
 * with it in the sorted table). Offsets are not bounded: an added tie moves
 * an event's end by whole beats without changing which event it is.
 *
 * Returns { ok: true, onsetsMoved, offsetsMoved, maxOnsetShiftQ } or
 * { ok: false, reason }.
 */
export function planRebase(stored, fresh) {
  const on = stored.score_onset;
  const off = Array.isArray(stored.score_offset) ? stored.score_offset : null;
  if (!Array.isArray(on) || on.length !== fresh.qOn.length) {
    return { ok: false, reason: "the number of events differs" };
  }
  let onsetsMoved = 0;
  let offsetsMoved = 0;
  let maxOnsetShiftQ = 0;
  for (let i = 0; i < on.length; i++) {
    const dq = Math.abs(fresh.qOn[i] - on[i]);
    if (dq > MAX_EVENT_SHIFT_Q) {
      return {
        ok: false,
        reason:
          `event ${i} moved ${+dq.toFixed(4)} quarter, more than ` +
          `${MAX_EVENT_SHIFT_Q}`,
      };
    }
    if (dq > EPS_Q) onsetsMoved++;
    if (dq > maxOnsetShiftQ) maxOnsetShiftQ = dq;
    if (off && Math.abs(fresh.qOff[i] - off[i]) > EPS_Q) offsetsMoved++;
    if (
      i + 1 < on.length &&
      _order(on[i], on[i + 1]) !== _order(fresh.qOn[i], fresh.qOn[i + 1])
    ) {
      return {
        ok: false,
        reason: `events ${i} and ${i + 1} changed order`,
      };
    }
  }
  return { ok: true, onsetsMoved, offsetsMoved, maxOnsetShiftQ };
}

/** Overwrite table[key] element-wise, so anything holding the array sees it. */
function _overwrite(table, key, values) {
  const cur = table[key];
  if (Array.isArray(cur) && cur.length === values.length) {
    for (let k = 0; k < values.length; k++) cur[k] = values[k];
  } else {
    table[key] = values.slice();
  }
}

/**
 * Re-base a score table in place: fresh quarters, and synth seconds from the
 * fresh tempo map (`fresh.sOn`/`fresh.sOff`). ref_onset/ref_offset are not
 * touched.
 */
export function rebaseScoreTable(table, fresh) {
  _overwrite(table, "score_onset", fresh.qOn);
  _overwrite(table, "score_offset", fresh.qOff);
  _overwrite(table, "synth_onset", fresh.sOn);
  _overwrite(table, "synth_offset", fresh.sOff);
}

/**
 * Point score↔ref anchors at their event's current quarter, in place. Anchors
 * without a quarter (gap endpoints carry q: null) are left alone. Returns how
 * many anchors moved.
 */
export function rebaseAnchorQuarters(anchors, qOn) {
  let moved = 0;
  for (const a of anchors || []) {
    if (a.q == null || !Number.isInteger(a.i) || qOn[a.i] === undefined) continue;
    if (Math.abs(a.q - qOn[a.i]) > EPS_Q) moved++;
    a.q = qOn[a.i];
  }
  return moved;
}

/**
 * The same for audio-to-audio anchors (`corrections.audio`, per recording):
 * their i/q are display hints for the onset group they were laid on, so q
 * follows the event; refT and t are recording times and are not touched.
 * Score-less anchors (no i) are left alone. Returns how many anchors moved.
 */
export function rebaseAudioAnchorQuarters(audio, qOn) {
  let moved = 0;
  for (const slot of Object.values(audio || {})) {
    for (const a of slot?.anchors || []) {
      if (!Number.isInteger(a.i) || qOn[a.i] === undefined) continue;
      if (a.q == null || Math.abs(a.q - qOn[a.i]) > EPS_Q) moved++;
      a.q = qOn[a.i];
    }
  }
  return moved;
}

/**
 * SHA-256 of an MEI text (UTF-8), as lowercase hex: the alignment's record of
 * which score it was made against, since its meiUri may be a moving target
 * such as a branch head. Null where Web Crypto is unavailable (an insecure,
 * non-localhost origin).
 */
export async function meiSha256(text) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle || typeof text !== "string") return null;
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
