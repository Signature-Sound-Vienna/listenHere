// Validation of an alignment JSON loaded from a URL (?align=).
//
// Ported from the server's validate_alignment_json (app/routes.py, until
// 0.104.6), with the same checks and messages. The server used to download
// the alignment itself to validate it before serving the page; it fetched any
// URL it was given (local files and internal hosts included), and the browser
// then downloaded the same file again. Now only the browser fetches it, and
// validates it here.

const isNumber = (t) => typeof t === "number" && Number.isFinite(t);
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** What is wrong with `data` as an alignment, or null if nothing is. */
export function alignmentJsonProblem(data) {
  if (!isObject(data)) return "Alignment data must be a JSON object";
  if (!("body" in data)) return "Missing required 'body' field";
  const body = data.body;
  if (!isObject(body)) return "'body' must be an object";
  if (!("audio" in body)) return "Missing required 'audio' field in body";
  const audio = body.audio;
  if (!isObject(audio)) return "'audio' must be an object";
  if (Object.keys(audio).length === 0) return "'audio' must contain at least one entry";
  for (const [key, val] of Object.entries(audio)) {
    if (Array.isArray(val)) {
      // Plain array of times (no precomputed peaks)
      if (!val.every(isNumber)) return `Audio entry '${key}': time values must be numbers`;
    } else if (isObject(val)) {
      // Inline format with precomputed peaks: {times, peaks, duration}
      if (!Array.isArray(val.times)) return `Audio entry '${key}' must have a 'times' array`;
      if (!val.times.every(isNumber)) return `Audio entry '${key}' times must contain only numbers`;
      if ("peaks" in val && !Array.isArray(val.peaks)) return `Audio entry '${key}' peaks must be an array`;
      if ("duration" in val && !isNumber(val.duration)) return `Audio entry '${key}' duration must be a number`;
    } else {
      return `Audio entry '${key}' must be an array of times or an object with times/peaks/duration`;
    }
  }
  if (!("header" in data)) return "Missing required 'header' field";
  const header = data.header;
  if (!isObject(header)) return "'header' must be an object";
  if (!("ref" in header)) return "Missing required 'ref' field in header";
  if (!Object.prototype.hasOwnProperty.call(audio, header.ref)) {
    return "'ref' must reference one of the audio entries";
  }
  // Validate optional score section
  const hasScore = "score" in body;
  const hasMei = "meiUri" in header;
  if (hasScore !== hasMei) {
    return "If 'score' is provided, 'meiUri' must also be provided (and vice versa)";
  }
  if (hasScore) {
    const score = body.score;
    if (!isObject(score)) return "'score' must be an object";
    for (const key of ["score_onset", "ref_onset", "score_offset", "ref_offset"]) {
      if (!(key in score)) return `Missing required score field: '${key}'`;
      if (!Array.isArray(score[key])) return `Score field '${key}' must be an array`;
      if (!score[key].every(isNumber)) return `Score field '${key}' must contain only numbers`;
    }
  }
  return null;
}
