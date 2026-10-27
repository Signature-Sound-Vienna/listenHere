// Recordings added to an alignment after it was made (0.97.0).
//
// Every recording in an alignment is aligned to the reference alone, so adding
// one later is one more reference pair: the existing grids, the score
// alignment, and everything anchored to reference time stand as they are.
//
// What the file records. The header's own alignmentParams describe the
// ORIGINAL run and are never rewritten by an addition — absent stays absent,
// which reads as "not known". Each addition appends a record to
// header.additions:
//
//   { addedAt, createdBy, recordings: [names], alignmentParams,
//     openEnds: { byFile: {name: bool}, trimmed: [...], guardFailed: [...] } }
//
// The parameters are written into every record, even when they equal the
// original's: a record must say what its recordings were aligned with without
// a reader having to know the inheritance rule, and an original header with no
// parameters leaves nothing to inherit.
//
// Pure: no DOM, no listen.js state.

/** body.audio's recording names, without the synthesised-score entry. */
export function recordingNames(json, synthKey) {
  return Object.keys(json?.body?.audio || {}).filter((k) => k !== synthKey);
}

/**
 * The parameters a recording was aligned with: its addition's, else the
 * original run's. null when neither records them.
 */
export function paramsFor(header, name) {
  for (const a of header?.additions || []) {
    if (a.recordings?.includes(name)) return a.alignmentParams ?? null;
  }
  return header?.alignmentParams ?? null;
}

/**
 * Where the add form starts: the original run's parameters when the file
 * records them (known: true), else the fallback preset (known: false).
 */
export function defaultAddParams(header, fallback) {
  const p = header?.alignmentParams;
  if (p && typeof p === "object") return { params: { ...p }, known: true };
  return { params: { ...fallback }, known: false };
}

/** The open-ends default for a new recording: the original run's switch. */
export function defaultOpenEnds(header) {
  return !!header?.openEnds?.enabled;
}

/**
 * The reference's usable span as the original run decided it, [from, to] in
 * seconds, or null for the whole file. Reused rather than re-detected so the
 * new pairs are aligned over the span the old ones were.
 */
export function refSpanOf(json) {
  const ref = json?.header?.ref;
  const e = ref != null ? json?.body?.audio?.[ref] : null;
  if (e && !Array.isArray(e) && Number.isFinite(e.alignedFrom) && Number.isFinite(e.alignedTo)) {
    return [e.alignedFrom, e.alignedTo];
  }
  return null;
}

/** Waveform peaks per recording in this alignment (0 = none stored). */
export function peakCountOf(json) {
  for (const e of Object.values(json?.body?.audio || {})) {
    if (e && !Array.isArray(e) && Array.isArray(e.peaks)) return e.peaks.length;
  }
  return 0;
}

/**
 * Why a picked file cannot be added, or "" if it can. Names are compared
 * composed (NFC), as the wizard stores them.
 */
export function addRefusal(name, json, synthKey) {
  const nfc = String(name).normalize("NFC");
  if (nfc === synthKey) return "reserved name";
  const taken = Object.keys(json?.body?.audio || {}).some(
    (k) => k.normalize("NFC") === nfc,
  );
  return taken ? "already in this alignment" : "";
}

/**
 * Write an addition into the alignment, in place: the new body.audio entries
 * and one header.additions record. header.alignmentParams is not touched.
 *
 * @param {object} json  the loaded alignment
 * @param {{audio: object, trimmed: string[], guardFailed: string[]}} added
 *        the worker's result for the new recordings
 * @param {{params: object, openEndsByFile: object, createdBy: string, addedAt?: string}} run
 * @returns {object} the record appended
 */
export function applyAddition(json, added, run) {
  if (!json.header) json.header = {};
  if (!json.body) json.body = {};
  if (!json.body.audio) json.body.audio = {};
  const names = Object.keys(added.audio || {});
  for (const n of names) json.body.audio[n] = added.audio[n];
  const byFile = {};
  for (const n of names) byFile[n] = !!run.openEndsByFile?.[n];
  const record = {
    addedAt: run.addedAt || new Date().toISOString(),
    createdBy: run.createdBy,
    recordings: names,
    alignmentParams: { ...run.params },
    openEnds: {
      byFile,
      trimmed: [...(added.trimmed || [])],
      guardFailed: [...(added.guardFailed || [])],
    },
  };
  if (!Array.isArray(json.header.additions)) json.header.additions = [];
  json.header.additions.push(record);
  return record;
}

/** Every recording named by a header's addition records. */
export function addedRecordings(header) {
  return (header?.additions || []).flatMap((a) => a.recordings || []);
}

/**
 * Recordings a recovery snapshot added that the loaded alignment does not
 * hold: added in a session that ended before they were saved, so lost.
 */
export function lostAdditions(snapHeader, loadedNames) {
  const have = new Set(loadedNames);
  return addedRecordings(snapHeader).filter((n) => !have.has(n));
}
