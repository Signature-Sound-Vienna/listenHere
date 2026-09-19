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
export const DYK_SCHEMA = "lh-exhibit-dyk/1";

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
        // Every sitting the exhibit has a portrait of, by year. Under the Gen-AI
        // batch a conductor legitimately had several, one per recording; the
        // freely-licensed photographs that replaced them are one per PERSON, so
        // this is normally a single entry — see the loop after this one.
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
  // ONE portrait per conductor, and the year against it is the PHOTOGRAPH's, not
  // the concert's. The per-concert scan above would otherwise give Boskovsky 25
  // identical sittings, because the sidecar now stamps the same picture on every
  // year a conductor worked. A conductor with a portrait but no free photograph
  // gets a placeholder medallion, which is still a path and still renders.
  const portraitCredits = new Map(Object.entries(json.conductorPortraits || {}));
  for (const e of byConductor.values()) {
    const credit = portraitCredits.get(e.name);
    if (!credit) continue;
    e.portraits = [{ year: credit.photoYear ?? null, path: credit.path }];
    e.portraitCredit = credit;
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
    /**
     * The photographer and licence for a conductor's portrait, or null. CC BY and
     * CC BY-SA make this a condition of showing the picture at all, so both
     * explorers ask for it whenever they put a face on the glass.
     */
    portraitCredit: (name) => portraitCredits.get(name) || null,
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

// ---------------------------------------------------------------------------
// "Did you know?" — the museum's authored text about six of these concerts and
// six of these conductors (content/dyk/, tools/prep_exhibit_dyk.py).
//
// It lives beside the sidecar rather than inside it because the two have
// opposite natures: concerts.json is a SCRAPE, gitignored and regenerable, and
// dyk.json is AUTHORED CONTENT that is committed. Folding one into the other
// would let a re-run of the concerts tool delete the museum's text.
//
// Same rules as the sidecar otherwise: optional, pinned schema, a 404 resolves
// to null with a warning, and the shipped listening kiosk never asks for it.
// ---------------------------------------------------------------------------

/**
 * Fetch and index the "Did you know?" content, or resolve null when it is
 * absent or unusable — the explorers then simply carry no cards.
 *
 * @param {{debug?: boolean}} [opts]
 * @returns {Promise<Dyk|null>}
 */
export async function loadDyk({ debug = false } = {}) {
  const url = new URL("./data/dyk.json", EXHIBIT_BASE);
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    console.warn(`exhibit: cannot reach ${url} — ${e.message}`);
    return null;
  }
  if (!res.ok) {
    // Committed, unlike the sidecar, so a 404 here means a deployment lost a
    // tracked file rather than "nobody ran the prep tool".
    console.warn(`exhibit: ${url} returned ${res.status} — the explorers will carry no "did you know?" cards`);
    return null;
  }
  let json;
  try {
    json = await res.json();
  } catch (e) {
    console.warn(`exhibit: ${url} is not JSON — ${e.message}`);
    return null;
  }
  return buildDyk(json, { debug });
}

/**
 * Index already-parsed content. Split from the fetch like buildConcerts, so the
 * indexing is testable without a network.
 *
 * @param {object} json
 * @returns {Dyk|null}
 */
export function buildDyk(json, { debug = false } = {}) {
  if (!json || json.schema !== DYK_SCHEMA) {
    console.warn(
      `exhibit "did you know?" content is "${json?.schema}", expected "${DYK_SCHEMA}" — ` +
        "ignoring it; re-run tools/prep_exhibit_dyk.py",
    );
    return null;
  }
  // Years arrive keyed by the JSON's string year; the explorers hold numbers.
  const years = new Map();
  for (const [y, entry] of Object.entries(json.years || {})) years.set(Number(y), entry);
  const conductors = new Map(Object.entries(json.conductors || {}));
  const data = {
    json,
    years,
    conductors,
    /** The entry for a concert year, or null. */
    forYear: (year) => years.get(Number(year)) || null,
    /** The entry for a conductor, by the name the archives spell — or null. */
    forConductor: (name) => conductors.get(name) || null,
  };
  if (debug) {
    console.log(
      `exhibit: "did you know?" — ${years.size} year(s), ${conductors.size} conductor(s), ` +
        `${(json.warnings || []).length} warning(s)`,
    );
    for (const w of json.warnings || []) console.warn(`exhibit dyk warning: ${w}`);
  }
  return data;
}

/**
 * @typedef {object} DykEntry
 * @property {Record<string, Record<string, string>>} text   audience id -> language -> text
 * @property {Record<string, string>} [subtitle]             the year's hook, per language
 * @property {DykImage|null} image
 */

/**
 * @typedef {object} DykImage
 * @property {string} id
 * @property {[number, number]} aspect
 * @property {Record<string, string>} caption
 * @property {"placeholder"|"licensed"} status
 * @property {string|null} src
 */

/**
 * @typedef {object} Dyk
 * @property {object} json
 * @property {Map<number, DykEntry>} years
 * @property {Map<string, DykEntry>} conductors
 * @property {(year: number) => DykEntry|null} forYear
 * @property {(name: string) => DykEntry|null} forConductor
 */

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
