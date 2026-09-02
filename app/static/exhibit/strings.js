// exhibit/strings.js
//
// Every visitor-visible string goes through here. No inline literals anywhere in
// the exhibit, from week 1 — because German plus English is release-blocking for
// December and retrofitting i18n across every view is the expensive way to do it
// (plan §6.6, §7.7).
//
// Two separate jobs, deliberately not conflated:
//
//   * `t(key, lang)` — UI CHROME. Short, ours, translated in-house, and keyed.
//   * `resolveText(value, {language})` — AUTHORED ANNOTATION CONTENT. Arrives from
//     the merged payload as a language-tagged object, not from this catalogue.
//     `audience` selects WHICH annotations are shown, and is a filter applied
//     before this point; language selects which text of the one that survived.
//
// Both take the language EXPLICITLY rather than reading a global, because audience
// and language are resolved PER VIEWPORT — the two halves of the table can differ
// at the same time, so there is no single "current language" to read (plan §5.3).
//
// No Latin-only layout assumptions: if Japanese or Chinese follow, they need
// different fonts, different line-breaking, and roughly 40% more width — worst in
// the narrow, two-sided middle band. Hence the middle band carries no labels at
// all (plan §6.3), which is why this catalogue is as small as it is.
//
// ZERO imports, by rule (see ENGINE-WANTS.md).

export const LANGUAGES = ["en", "de"];
export const FALLBACK_LANGUAGE = "en";

/**
 * The UI catalogue. Keys are dotted and stable; values are per language.
 *
 * German is deliberately absent for now rather than machine-guessed: translation
 * is in-house editorial work already under way, and a placeholder that looks like
 * a translation is worse than a visible gap. `t()` falls back to English and, in
 * debug mode, says which key was missing.
 */
const CATALOGUE = {
  "app.title": { en: "Same Procedure…?" },
  "listen.nowPlaying": { en: "Now playing" },
  "listen.tapToListen": { en: "Tap a recording to hear it" },
  // PROVISIONAL wording, to be settled by the user testing in Oct/Nov 2026.
  //
  // The KEYS track the internal audience ids, which come from the authored source
  // filenames (Alignment_Fledermaus_{Kids,Adults,Expert}.json) and are stamped on
  // every annotation in the payload — so `audience.expert` displays as "Scholars"
  // while staying keyed on `expert`. Do not "fix" that mismatch by renaming the
  // key: the lookup is t("audience." + <the payload's audience value>).
  "audience.kids": { en: "Kids" },
  "audience.adults": { en: "Adults" },
  "audience.expert": { en: "Scholars" },
  // The ?audienceAll=1 union mode (config.js) — a UI pseudo-audience, so it is
  // catalogue chrome here rather than a payload id like the three above.
  "audience.all": { en: "All" },
  // aria-labels only: the buttons themselves show +/− glyphs, which need no
  // translation on a two-language surface (same rule as the middle band).
  "zoom.in": { en: "Zoom in" },
  "zoom.out": { en: "Zoom out" },
  "transport.play": { en: "Play" },
  "transport.pause": { en: "Pause" },
  // aria-label only: the side panel's close control shows an × glyph
  // (main.js, ?sideSlot=…) — nothing to translate on the glass itself.
  "panel.close": { en: "Close the side panel" },
  // The pin-expiry warning (config.pinExpiry, main.js): shown near the
  // deadline; tapping re-arms the reading time.
  "panel.keepReading": { en: "Keep reading…" },
  // The detail header's jump control (config.detailJump, main.js): make a
  // recording this annotation targets audible at its first region — reading
  // without jumping stays possible, jumping is one tap. PROVISIONAL wording,
  // to be settled by the Oct/Nov user testing.
  "panel.jumpToAnnotation": { en: "Jump to annotation" },
  // The detail header's MARK control, beside the jump (?marker=glass only):
  // puts this reader's own marker on the annotation's first region. Deliberately
  // a labelled button rather than a bare glass glyph — a magnifying glass with
  // no chrome invites a visitor to try to DRAG it, and the draggable one is the
  // object on the hook. PROVISIONAL wording, like the jump beside it.
  "panel.markAnnotation": { en: "Mark" },
  "panel.markAnnotationLong": {
    en: "Place my marker at the start of this annotation",
  },
  // Turn-taking (plan §4.3; ?turnPolicy=…, turns.js). These render on the
  // viewports' own surfaces, so unlike the middle band they MAY carry language
  // — each half shows its own reader's copy. PROVISIONAL wording, to be
  // settled by the Oct/Nov user testing like the audience labels above.
  "turn.prompt": { en: "The other side wants to choose the music." },
  "turn.grant": { en: "Go ahead" },
  "turn.deny": { en: "Not yet" },
  "turn.waiting": { en: "Waiting for the other side…" },
  "turn.denied": { en: "The other side is still listening." },
  "turn.taken": { en: "The other side changed the recording." },
  "state.loading": { en: "Loading…" },
  "strap.prev": { en: "Previous recording" },
  "strap.next": { en: "Next recording" },
  // The listening marker (?marker=glass): aria only — the glass is a physical
  // object and deliberately carries no words on screen.
  "marker.glass": { en: "Listening marker" },
  "marker.ghost": { en: "The other visitor’s marker" },
  "state.nothingForAudience": { en: "Nothing here for this view — try another." },
  // A kiosk that fails must say so on the glass, not only in a console nobody can
  // open. The message names no cause on purpose: the visitor cannot act on one and
  // the technician has the console.
  "state.dataError": { en: "This exhibit is temporarily unavailable." },
  // The per-viewport VIEW SWITCH (?viewSwitch=1, ?views=…; main.js): the
  // listening interface, or the by-year explorer of the whole New Year's
  // Concert series (plan §11). These render on the viewport's own toolbar, so
  // like the turn notices they may carry language. PROVISIONAL wording, to be
  // settled by the Oct/Nov user testing.
  "view.listen": { en: "Listen" },
  "view.years": { en: "Year by year" },
  // The by-year explorer (years-view.js). The concert facts themselves —
  // titles, composers, conductors — arrive from the concerts sidecar as data
  // (German, as the archives wrote them; composers carry a language map), so
  // only the chrome is here.
  "years.heading": { en: "The New Year's Concerts of the Wiener Philharmoniker" },
  "years.founding": { en: "The founding concert, on New Year's Eve" },
  "years.noConcert": { en: "No concert was given this year." },
  "years.afterArchives": { en: "This concert is not yet in our archives." },
  "years.missing": { en: "This concert is missing from our archives." },
  "years.programme": { en: "Programme" },
  // The author's own caveat (2026-09-02): the archives list the printed
  // programme, and the encores — the Blue Danube, the Radetzky March — were
  // often not written down.
  "years.programmeCaveat": {
    en: "As listed in the concert archives. Encores were often not recorded.",
  },
  "years.programmeUnknown": { en: "The programme is not in our archives." },
  // Legend for the per-item source marks: an item one archive lists and the
  // other does not is shown, and marked, rather than dropped or trusted.
  "years.legendPhilharmoniker": { en: "listed by the orchestra's archive only" },
  "years.legendMusikverein": { en: "listed by the Musikverein's archive only" },
  "years.with": { en: "With" },
  "years.inLibrary": { en: "On disc in the project's collection" },
  // The direct route from a concert to its music: switches the transport to
  // the recording of this piece from that concert (the aligned switch, like a
  // strip tap) and returns to the listening view. `{piece}` is the payload's
  // piece title, resolved per language.
  "years.listen": { en: "Listen to {piece} from this concert" },
  "years.onProgramme": { en: "{piece} was on the programme." },
  "years.unavailable": { en: "The concert history is temporarily unavailable." },
  "years.chooseYear": { en: "Choose a year" },
  // THE ONE PLAIN SENTENCE that the AI mark on the portraits needs (plan §5.5,
  // §11(d)) — release-blocking for December, and this view is the first
  // surface allowed to carry text. The glyph itself is burned into every
  // portrait asset, so no view adds a label; this sentence explains it once.
  "about.portraitsAi": {
    en: "The conductor portraits are AI-generated impressions, not photographs; the small gold spark marks each one.",
  },
};

let _debug = false;
/** Turn missing-key reporting on; the exhibit passes config.debug straight in. */
export function setDebug(on) {
  _debug = !!on;
}

const _warned = new Set();
function _warnOnce(what) {
  if (!_debug || _warned.has(what)) return;
  _warned.add(what);
  console.warn("strings: " + what);
}

/**
 * A UI string in `lang`, falling back to English, then to the key itself.
 *
 * Returning the key rather than an empty string is deliberate: a missing string
 * should be visible in testing, not silently blank on a museum wall.
 *
 * @param {string} key   a CATALOGUE key
 * @param {string} lang  BCP-47-ish short code, e.g. "de"
 */
export function t(key, lang = FALLBACK_LANGUAGE) {
  const entry = CATALOGUE[key];
  if (!entry) {
    _warnOnce(`no such key "${key}"`);
    return key;
  }
  if (entry[lang] != null) return entry[lang];
  _warnOnce(`key "${key}" has no "${lang}" translation`);
  return entry[FALLBACK_LANGUAGE] ?? key;
}

/**
 * Resolve one AUTHORED text value, which arrives language-tagged from the merged
 * annotation payload rather than from the catalogue above.
 *
 * Accepts either a plain string (untranslated authored content, which is what the
 * current sets hold) or an object keyed by language. That tolerance is the point:
 * the prep script can start emitting `{en, de}` for translated entries without the
 * exhibit needing to change, and untranslated entries keep working meanwhile.
 *
 * @param {string|Record<string,string>|null|undefined} value
 * @param {{language?: string}} [opts]
 * @returns {string} "" when there is genuinely nothing to show
 */
export function resolveText(value, { language = FALLBACK_LANGUAGE } = {}) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value !== "object") return String(value);
  if (value[language] != null) return value[language];
  if (value[FALLBACK_LANGUAGE] != null) {
    _warnOnce(`authored text has no "${language}" version`);
    return value[FALLBACK_LANGUAGE];
  }
  // Any language beats nothing on a wall in a museum.
  const first = Object.values(value).find((v) => typeof v === "string" && v);
  return first ?? "";
}

/** Every key in the catalogue — used by a completeness check once German lands. */
export function catalogueKeys() {
  return Object.keys(CATALOGUE);
}

/** Keys with no translation for `lang`. The i18n to-do list, computed not guessed. */
export function missingFor(lang) {
  return Object.keys(CATALOGUE).filter((k) => CATALOGUE[k][lang] == null);
}
