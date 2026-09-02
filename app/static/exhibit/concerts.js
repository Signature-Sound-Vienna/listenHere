// exhibit/concerts.js
//
// The loader for the New Year's Concert sidecar — the spine of the by-year
// explorer (plan §11). Same shape and same rules as payload.js: two fetches'
// worth of local JSON that `tools/prep_exhibit_concerts.py` resolved offline,
// a PINNED schema, and a little indexing. Nothing here knows about the two
// programme archives, the library graph, or how they were reconciled; every
// interesting decision lives in the tool's docstring, where it can be re-run.
//
// OPTIONAL, unlike the payload. The sidecar feeds one view; a kiosk whose
// concert history is missing is a degraded exhibit, not a broken one, so a 404
// or a schema mismatch resolves to null and the view says so on the glass
// (strings: years.unavailable). The listening view never waits for this file
// — the default exhibit does not even fetch it (main.js loads it only when a
// view switch is configured), so the shipped kiosk stays byte-identical on the
// wire per the A/B rule.
//
// ZERO imports, by rule (see ENGINE-WANTS.md).

export const CONCERTS_SCHEMA = "lh-exhibit-concerts/1";

const EXHIBIT_BASE = new URL("./", import.meta.url);

/**
 * Fetch and index the sidecar, or resolve null when it is absent or unusable.
 *
 * @param {{debug?: boolean}} [opts]
 * @returns {Promise<Concerts|null>}
 */
export async function loadConcerts({ debug = false } = {}) {
  const url = new URL("./data/concerts.json", EXHIBIT_BASE);
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    console.warn(`exhibit: cannot reach ${url} — ${e.message}`);
    return null;
  }
  if (!res.ok) {
    // Gitignored and regenerable, like the payload: a 404 is far more likely to
    // be "nobody ran the prep tool" than a deployment fault.
    console.warn(`exhibit: ${url} returned ${res.status} — run tools/prep_exhibit_concerts.py`);
    return null;
  }
  let json;
  try {
    json = await res.json();
  } catch (e) {
    console.warn(`exhibit: ${url} is not JSON — ${e.message}`);
    return null;
  }
  return buildConcerts(json, { debug });
}

/**
 * Index an already-parsed sidecar. Split from the fetch so it is testable
 * without a network, like payload.js's buildExhibitData.
 *
 * @param {object} json
 * @returns {Concerts|null}
 */
export function buildConcerts(json, { debug = false } = {}) {
  if (!json || json.schema !== CONCERTS_SCHEMA) {
    console.warn(
      `exhibit concerts sidecar is "${json?.schema}", expected "${CONCERTS_SCHEMA}" — ` +
        "ignoring it; re-run tools/prep_exhibit_concerts.py",
    );
    return null;
  }
  const series = json.series || {};
  const byYear = new Map();
  for (const c of json.concerts || []) byYear.set(c.year, c);
  const first = series.first ?? Math.min(...byYear.keys());
  const through = series.through ?? Math.max(...byYear.keys());
  const years = [];
  for (let y = first; y <= through; y++) years.push(y);
  // Which payload recordings the explorer can hand to the transport, keyed by
  // file, so a tap on a year is one lookup and the view never has to know how
  // the tool decided what "from this concert" means.
  const playableYears = new Map();
  for (const c of byYear.values()) {
    for (const p of c.playable || []) playableYears.set(p.file, c.year);
  }
  // The by-conductor pivot (conductors-view.js), derived here rather than by
  // the tool because it is pure indexing of what the sidecar already says:
  // one entry per conductor NAME as the archives spell it (the two archives
  // agree on every conductor, so the name is a stable key), in the order of
  // each conductor's first concert — the series' own history. A gap year has
  // no conductor and joins nobody.
  const byConductor = new Map();
  for (const c of [...byYear.values()].sort((a, b) => a.year - b.year)) {
    if (!c.date || !c.conductor) continue;
    let e = byConductor.get(c.conductor);
    if (!e) {
      e = {
        name: c.conductor,
        years: [],
        concerts: [],
        first: c.year,
        last: c.year,
        // Every sitting the exhibit has a portrait of, by year — one conductor
        // legitimately has several (the per-recording naming, plan §11(d)).
        portraits: [],
        // The payload recordings the exhibit can play, with their concert year.
        playable: [],
        // Any role the archives give beyond plain conducting (Boskovsky's
        // "Dirigent und Violine"), as the archive wrote it.
        roles: [],
      };
      byConductor.set(c.conductor, e);
    }
    e.years.push(c.year);
    e.concerts.push(c);
    e.last = c.year;
    if (c.portrait) e.portraits.push({ year: c.year, path: c.portrait });
    for (const p of c.playable || []) e.playable.push({ year: c.year, ...p });
    for (const role of Object.values(c.conductorRole || {})) {
      if (role && role !== "Dirigent" && !e.roles.includes(role)) e.roles.push(role);
    }
  }
  const data = {
    json,
    series,
    years,
    first,
    through,
    lastInArchives: series.lastInArchives ?? null,
    byYear,
    playableYears,
    byConductor,
    /** Every conductor, in order of first concert. */
    conductors: [...byConductor.values()],
    get: (year) => byYear.get(year) || null,
    /** The year a payload recording was played at, or null. */
    yearOf: (file) => playableYears.get(file) ?? null,
  };
  if (debug) {
    const dated = [...byYear.values()].filter((c) => c.date).length;
    console.log(
      `exhibit: concerts sidecar — ${dated} concerts ${first}–${through}, ` +
        `${playableYears.size} playable recording(s), ${(json.warnings || []).length} warning(s)`,
    );
    // The tool's warnings travel WITH the sidecar on purpose, like the payload's
    // — a contradiction between the two archives is visible from the thing it
    // affects, not only in a build log.
    for (const w of json.warnings || []) {
      if (w.kind === "programme-contradiction" || w.kind === "conductor-contradiction") {
        console.warn(`exhibit concerts warning [${w.kind}] ${w.year}: ${w.detail}`);
      }
    }
  }
  return data;
}

/**
 * @typedef {object} Concerts
 * @property {object} json                    the whole parsed sidecar
 * @property {object} series                  first, lastInArchives, through, orchestra
 * @property {number[]} years                 every year of the grid, first..through
 * @property {number} first
 * @property {number} through
 * @property {number|null} lastInArchives
 * @property {Map<number, object>} byYear
 * @property {Map<string, number>} playableYears  payload file -> concert year
 * @property {Map<string, Conductor>} byConductor  conductor name -> their entry
 * @property {Conductor[]} conductors             in order of first concert
 * @property {(year: number) => object|null} get
 * @property {(file: string) => number|null} yearOf
 */

/**
 * @typedef {object} Conductor
 * @property {string} name
 * @property {number[]} years
 * @property {object[]} concerts
 * @property {number} first
 * @property {number} last
 * @property {{year: number, path: string}[]} portraits
 * @property {{year: number, file: string, piece: string}[]} playable
 * @property {string[]} roles
 */
