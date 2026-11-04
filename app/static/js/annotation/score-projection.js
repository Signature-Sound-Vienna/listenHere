// V6 annotation — score regions.
//
// A score Selection (mei-friend's, or one this app keeps in an annotation's
// chain) lists MEI elements as frbr:parts `${meiUri}#elementId`. Its region is
// ONE span, from the earliest element onset to the latest element offset in
// Verovio's timemap, and is projected from there: as it stands onto the
// synthesised score row (whose audio is the MIDI that timemap describes), and
// through the score alignment and the grids onto every recording.
//
// The pod doesn't say which audio region a score Selection's is: by
// convention it is the one at position 1 (solid-load.js). In memory it is the
// region with a `sourceScore`, which can't be deleted, and on a recording
// only moves for that recording.

import { nsp } from "../linked-data.js";
import {
  correctedSynthOffsets,
  correctedSynthOnsets,
  getClosestAlignmentIx,
  getCorrespondingTime,
  getMeiDOM,
  getReferenceAudioIx,
  scoreAlignment,
  SYNTH_MEI_KEY,
  timemap,
  whenScoreReady,
} from "../listen.js";

/** How long placing a score region waits for the score before giving up. */
export const SCORE_WAIT_MS = 60000;

// What the score region says about itself: on hover, on its locked delete,
// on the synthesised score row, and when a plain drag is refused.
export const SCORE_REGION_TITLE =
  "Projected from a score selection: its times follow the score and the alignment.";
export const SCORE_REGION_LOCKED =
  "This region is projected from the score selection and can't be removed. To annotate without the score, start a new annotation.";
export const SCORE_REGION_SYNTH_TITLE =
  "Projected from a score selection: nailed to the onset and offset times of the selected MEI elements.";
export const SCORE_REGION_DRAG_REFUSED =
  "This region is projected from a score selection, so it follows the alignment. If it is off on every recording, correct it using ‘Correct alignment…’. To adjust it on this recording only, hold Shift and drag.";

/**
 * Every MEI element id the given score Selections name, in order, once each.
 * @param {object} graph — URI → expanded JSON-LD node
 * @param {string[]} selUris — the score Selections
 */
export function scoreElementIdsFromSelections(graph, selUris) {
  const ids = [];
  for (const uri of selUris) {
    for (const p of (graph[uri] && graph[uri][nsp.FRBR + "part"]) || []) {
      const partUri = p && p["@id"];
      const hashIx = partUri ? partUri.lastIndexOf("#") : -1;
      const id = hashIx >= 0 ? partUri.slice(hashIx + 1) : null;
      if (id && !ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}

/** Whether the timemap and score alignment are there to project with now. */
export function isScoreReady() {
  return timemap.length > 0 && !!scoreAlignment && !!getReferenceAudioIx();
}

/**
 * Resolves true once the score is ready, false when it can't be (no score, or
 * it failed to load), or "timeout" when it hasn't arrived within `ms`.
 */
export function scoreReadyWithin(ms = SCORE_WAIT_MS) {
  if (isScoreReady()) return Promise.resolve(true);
  let timer;
  return Promise.race([
    whenScoreReady().then((ok) => ok && isScoreReady()),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve("timeout"), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

// id → { on, off } in score seconds, from the timemap; rebuilt when the
// timemap is refilled (a new score).
let _timesIndex = null;
let _timesIndexKey = null;

function _timesById() {
  const last = timemap[timemap.length - 1];
  const key = timemap.length + ":" + (last ? last.tstamp : "");
  if (_timesIndex && _timesIndexKey === key) return _timesIndex;
  const index = new Map();
  const mark = (id, field, ms) => {
    const t = index.get(id) || {};
    if (t[field] === undefined) t[field] = ms / 1000;
    index.set(id, t);
  };
  for (const entry of timemap) {
    for (const id of entry.on || []) mark(id, "on", entry.tstamp);
    for (const id of entry.restsOn || []) mark(id, "on", entry.tstamp);
    for (const id of entry.off || []) mark(id, "off", entry.tstamp);
    for (const id of entry.restsOff || []) mark(id, "off", entry.tstamp);
  }
  _timesIndex = index;
  _timesIndexKey = key;
  return index;
}

/**
 * The timed elements an element id stands for: itself when the timemap lists
 * it (a note or rest), else the timed elements inside it (a chord, beam,
 * measure, staff…), else those its @startid / @endid point at (a slur,
 * hairpin, dynamic…).
 */
function _timedIds(id, index) {
  if (index.has(id)) return [id];
  const dom = getMeiDOM();
  if (!dom) return [];
  const el = _elementById(dom, id);
  if (!el) return [];
  const inside = [...el.getElementsByTagName("*")]
    .map((d) => d.getAttribute("xml:id"))
    .filter((d) => d && index.has(d));
  if (inside.length) return inside;
  return ["startid", "endid"]
    .map((a) => (el.getAttribute(a) || "").replace(/^#/, ""))
    .filter((d) => d && index.has(d));
}

let _idDom = null;
let _idMap = null;
function _elementById(dom, id) {
  if (_idDom !== dom) {
    _idMap = new Map();
    for (const el of dom.getElementsByTagName("*")) {
      const xid = el.getAttribute("xml:id");
      if (xid) _idMap.set(xid, el);
    }
    _idDom = dom;
  }
  return _idMap.get(id) || null;
}

/**
 * The span of a score region in score seconds — the synthesised score row's
 * own timescale: earliest onset to latest offset of its elements. Null when
 * none is in the timemap.
 */
export function scoreSpan(elementIds) {
  if (!timemap.length || !Array.isArray(elementIds)) return null;
  const index = _timesById();
  let start = Infinity;
  let end = -Infinity;
  for (const id of elementIds) {
    for (const t of _timedIds(id, index)) {
      const { on, off } = index.get(t);
      if (on !== undefined && on < start) start = on;
      const last = off !== undefined ? off : on;
      if (last !== undefined && last > end) end = last;
    }
  }
  return Number.isFinite(start) && Number.isFinite(end) && end >= start
    ? { start, end }
    : null;
}

/** The score-time tables score times are matched against. Prefer the
 *  corrected synth tables (derived from the MIDI Verovio actually rendered):
 *  the stored synth_onset/synth_offset may carry the pre-fix tempo skew. */
function _scoreTimeTables() {
  return {
    onsetTimes:
      correctedSynthOnsets || scoreAlignment.synth_onset || scoreAlignment.score_onset,
    offsetTimes:
      correctedSynthOffsets || scoreAlignment.synth_offset || scoreAlignment.score_offset,
  };
}

function _closestIx(t, table) {
  let bestIx = 0;
  let bestDist = Math.abs(table[0] - t);
  for (let i = 1; i < table.length; i++) {
    const d = Math.abs(table[i] - t);
    if (d < bestDist) {
      bestDist = d;
      bestIx = i;
    }
  }
  return bestIx;
}

/**
 * A score region's times on `file`: the score span itself on the synthesised
 * score row; on the reference recording, through the score alignment; on any
 * other recording, on from the reference through the grids. Null when the
 * score side isn't ready or nothing projects.
 */
export function projectScoreRegion(elementIds, file) {
  const span = scoreSpan(elementIds);
  if (!span) return null;
  if (file === SYNTH_MEI_KEY) return span;
  const refFile = getReferenceAudioIx();
  if (!scoreAlignment || !refFile) return null;
  const { onsetTimes, offsetTimes } = _scoreTimeTables();
  if (!Array.isArray(onsetTimes) || !onsetTimes.length) return null;
  if (!Array.isArray(offsetTimes) || !offsetTimes.length) return null;
  const refStart = scoreAlignment.ref_onset[_closestIx(span.start, onsetTimes)];
  const refEnd = scoreAlignment.ref_offset[_closestIx(span.end, offsetTimes)];
  if (!Number.isFinite(refStart) || !Number.isFinite(refEnd)) return null;
  if (file === refFile) return { start: refStart, end: refEnd };
  try {
    const a = getCorrespondingTime(file, getClosestAlignmentIx(refStart, refFile));
    const b = getCorrespondingTime(file, getClosestAlignmentIx(refEnd, refFile));
    if (Number.isFinite(a) && Number.isFinite(b)) return { start: a, end: b };
  } catch (_) {
    /* no grid for this file */
  }
  return null;
}

/**
 * A score-sourced region's times on every target of `ann`, projected again
 * through the current score alignment and grids (after a correction); null
 * when the score side isn't ready.
 */
export function projectedTimesFromScore(ann, region) {
  if (!region.sourceScore || !isScoreReady()) return null;
  const out = {};
  for (const t of ann.targets) {
    const span = projectScoreRegion(region.sourceScore, t.file);
    if (span) out[t.file] = span;
  }
  return out;
}
