// exhibit/payload.js
//
// The loader. Fetches the prepped payload (and the metadata sidecar beside it),
// checks that it is the shape this code was written against, and hands back the
// few derived views the rest of the exhibit actually asks for.
//
// The exhibit reads NOTHING at runtime that `tools/prep_exhibit_data.py` did not
// already resolve offline. No alignment authoring files, no MEI over the network,
// no MusicBrainz, no linked-data traversal: the museum machine is a frozen PC with
// no network connection (plan §5, §8). So this module is deliberately dull — two
// fetches of local JSON and some indexing — and every interesting decision lives
// in the prep script's docstring instead, where it can be re-run and re-checked.
//
// THE SCHEMA IS PINNED, and a mismatch throws rather than degrades. A kiosk that
// half-loads is worse than a kiosk that says it is broken: the payload's shape is
// the contract between an offline tool and this code, and if the tool's output
// moves, the honest failure is the one a technician can act on.
//
// ZERO imports, by rule (see ENGINE-WANTS.md) — and none are needed: the grids go
// to `engine/align-core.js` and the pinned groupings to `engine/grouping-core.js`
// from main.js, so this module never has to know those modules exist.

export const PAYLOAD_SCHEMA = "lh-exhibit-payload/1";
export const METADATA_SCHEMA = "lh-exhibit-metadata/1";

/** The exhibit root, so `recordings[].audio` resolves the same from any module. */
const EXHIBIT_BASE = new URL("./", import.meta.url);

/**
 * The audience ids, in the order the switch should offer them.
 *
 * Not read from the payload: the payload only carries the audiences that happen
 * to have annotations, and an empty mode is a legitimate state the visitor may
 * switch into ("nothing here for this view"). A switch whose buttons appear and
 * disappear with the data is a worse interface than one that is always the same
 * three, so the order is authored here and the payload is checked against it.
 */
export const AUDIENCES = ["kids", "adults", "expert"];

/**
 * Load the piece's payload plus, if it is there, the metadata sidecar.
 *
 * @param {object}  opts
 * @param {string}  opts.piece     payload basename, from config.piece
 * @param {boolean} [opts.debug]
 * @returns {Promise<ExhibitData>}
 */
export async function loadExhibitData({ piece, debug = false } = {}) {
  const payloadUrl = new URL(`./data/${piece}.json`, EXHIBIT_BASE);
  const metadataUrl = new URL("./data/metadata.json", EXHIBIT_BASE);

  // Both in flight at once: the payload is ~5 MB and the sidecar ~7 kB, so
  // serialising them would cost a whole round trip for nothing.
  const [payload, metadata] = await Promise.all([
    _fetchJson(payloadUrl, { required: true }),
    _fetchJson(metadataUrl, { required: false }),
  ]);

  if (payload.schema !== PAYLOAD_SCHEMA) {
    throw new Error(
      `exhibit payload is "${payload.schema}", expected "${PAYLOAD_SCHEMA}" — ` +
        "re-run tools/prep_exhibit_data.py",
    );
  }
  if (metadata && metadata.schema !== METADATA_SCHEMA) {
    // Not fatal, unlike the payload: the sidecar feeds the middle band only, and
    // a nameless band is a degraded exhibit rather than a broken one.
    console.warn(
      `exhibit metadata is "${metadata.schema}", expected "${METADATA_SCHEMA}" — ` +
        "ignoring it; re-run tools/prep_exhibit_metadata.py",
    );
  }

  return buildExhibitData(payload, metadata, { debug });
}

/**
 * Index an already-parsed payload. Split from the fetch so the indexing is
 * testable without a network, and so a future attract loop can pre-parse a second
 * piece without going through the loader again.
 *
 * @param {object} payload
 * @param {object|null} metadata
 * @returns {ExhibitData}
 */
export function buildExhibitData(payload, metadata, { debug = false } = {}) {
  const recordings = payload.recordings || {};
  // Payload key order IS the display order — the prep script writes the curated
  // eight in its CURATED order, reference first (plan §5.2). Sorting here would
  // silently throw that curation away and replace it with the alphabet.
  const order = Object.keys(recordings);

  const grids = {};
  const durations = {};
  const peaks = {};
  const audio = {};
  for (const file of order) {
    const rec = recordings[file];
    // align-core wants `Record<file, number[]>` and nothing else, so the grid is
    // handed over as the bare array rather than as the recording object. Same
    // shape listen.js passes, from a different host — which is the point of
    // having extracted it.
    grids[file] = rec.times;
    durations[file] = rec.duration;
    peaks[file] = rec.peaks;
    // `audio` is relative to the EXHIBIT ROOT, not to data/ — a distinction that
    // costs nothing to honour here and an afternoon to debug if guessed.
    audio[file] = new URL(rec.audio, EXHIBIT_BASE).href;
  }

  const annotations = payload.annotations || [];
  const byAudience = {};
  for (const id of AUDIENCES) byAudience[id] = [];
  for (const ann of annotations) {
    if (!byAudience[ann.audience]) {
      // An audience in the data that this build does not know how to offer is a
      // pipeline/version mismatch, and silently dropping the annotations would
      // look like an authoring mistake instead. Name it and keep going.
      console.warn(`exhibit: payload has unknown audience "${ann.audience}"`);
      byAudience[ann.audience] = [];
    }
    byAudience[ann.audience].push(ann);
  }

  const data = {
    payload,
    metadata: metadata && metadata.schema === METADATA_SCHEMA ? metadata : null,
    piece: payload.piece || {},
    order,
    grids,
    durations,
    peaks,
    audio,
    annotations,
    byAudience,
  };

  if (debug) {
    const counts = AUDIENCES.map((a) => `${a} ${byAudience[a].length}`).join(", ");
    console.log(
      `exhibit: ${order.length} recordings, ${annotations.length} annotations ` +
        `(${counts}), metadata ${data.metadata ? "present" : "absent"}`,
    );
    // The prep script's warnings travel WITH the payload on purpose, so they are
    // visible from the thing they affect rather than only in a build log nobody
    // reads six weeks later. Several are authoring to-dos owned by the annotator.
    for (const w of payload.warnings || []) {
      console.warn(`exhibit payload warning [${w.kind}] ${w.detail}`);
    }
  }
  return data;
}

/** Metadata for one recording, or an empty object — the band handles absence. */
export function metadataFor(data, file) {
  return data.metadata?.recordings?.[file] || {};
}

async function _fetchJson(url, { required }) {
  let res;
  try {
    // `cache: "no-store"` is deliberately NOT set. The payload is a 5 MB local
    // file that changes only when the prep script runs, and on the kiosk the
    // attract loop will reload the page for hours; letting the HTTP cache do its
    // job is the difference between a reload and a re-parse.
    res = await fetch(url);
  } catch (e) {
    if (!required) return null;
    throw new Error(`exhibit: cannot reach ${url} — ${e.message}`);
  }
  if (!res.ok) {
    if (!required) return null;
    // The generated payload is gitignored and regenerable, so a 404 here is much
    // more likely to be "nobody ran the prep script" than a deployment fault.
    throw new Error(
      `exhibit: ${url} returned ${res.status} — run tools/prep_exhibit_data.py`,
    );
  }
  return res.json();
}

/**
 * @typedef {object} ExhibitData
 * @property {object} payload                    the whole parsed payload
 * @property {object|null} metadata              the sidecar, or null
 * @property {object} piece                      title, composer, ref, meiUri
 * @property {string[]} order                     recordings in curated order
 * @property {Record<string, number[]>} grids     for align-core
 * @property {Record<string, number>} durations
 * @property {Record<string, number[]>} peaks
 * @property {Record<string, string>} audio       absolute URLs
 * @property {object[]} annotations               all of them, every audience
 * @property {Record<string, object[]>} byAudience
 */
