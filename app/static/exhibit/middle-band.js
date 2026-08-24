// exhibit/middle-band.js
//
// The band between the two halves. It shows who is conducting the recording the
// clock is on, which orchestra is playing, in what year, and eventually the
// conductor's portrait — and NOTHING ELSE. The orchestra is not decoration: the
// exhibit's annotations pin groupings like VPO-versus-other-orchestras, so the
// ensemble is the one identity fact a visitor needs to follow that comparison.
//
// THE NO-LABELS RULE IS NOT AESTHETIC, it falls out of the sharing boundary (plan
// §6.3, closed in §8). The band is shared per screen, because there is one audible
// recording per screen; audience and language are per viewport, because two people
// read this surface from opposite sides of a table. So the band cannot carry a
// caption: "Conductor" would have to pick one of their two languages, and picking
// is worse than omitting. What is left — a proper name, a year, a face — needs no
// translation, and needs none of the mirrored-versus-single orientation machinery
// week 3 will argue about for the text elsewhere.
//
// Portraits are null on all eight recordings today: they are to be generated, which
// is an open editorial item and not a code one, so the placeholder is the
// conductor's initials. Initials are still just their name, so the rule holds.
//
// One band per gap between viewports. With the default two viewports that is one
// band; with `?viewports=1` there is none, and the update below is a no-op rather
// than a special case.

import { metadataFor } from "./payload.js";
import { resolveText } from "./strings.js";

/**
 * Build a band. Returns a handle so `update` can be called per selection without
 * the caller having to know the band's internal structure.
 *
 * @param {object} data      from payload.js
 * @param {object} [opts]
 * @param {string} [opts.language]  for the piece title — see the caveat below
 * @returns {{el: HTMLElement, update: (file: string|null) => void}}
 */
export function createMiddleBand(data, { language = "en" } = {}) {
  const el = document.createElement("div");
  el.className = "middle-band";

  // The piece: title, composer, and the opus number when the payload carries one.
  // Shown ONCE PER VIEW — every strip is the same piece, so repeating the title
  // eight times would say nothing — and set at build time, because the piece does
  // not change per selection (the attract loop's second piece rebuilds the band).
  //
  // A DOCUMENTED TENSION with the no-labels rule: the title is a language map
  // ("Overture" is an English word), and the band deliberately carries only
  // translation-free content because it cannot pick between two readers'
  // languages (plan §6.3). Today both viewports are English, so nothing is at
  // stake; the day the languages diverge, this line is what forces week 3's
  // mirroring/orientation decision, and it should be found via this comment.
  //
  // No opus for Die Fledermaus is CORRECT, not missing data: Strauss II's dances
  // and marches are opus-numbered, his operettas are not, and the graph agrees
  // (the overture's Work is titled without one while sibling works carry theirs).
  // Kaiserwalzer, the attract loop's stretch piece, will exercise the field.
  const piece = document.createElement("div");
  piece.className = "mb-piece";
  const pieceTitle = document.createElement("div");
  pieceTitle.className = "mb-piece-title";
  const title = resolveText(data.piece.title, { language });
  pieceTitle.textContent = data.piece.opus ? `${title}, ${data.piece.opus}` : title;
  const pieceComposer = document.createElement("div");
  pieceComposer.className = "mb-piece-composer";
  pieceComposer.textContent = data.piece.composer || "";
  piece.append(pieceTitle, pieceComposer);

  const portrait = document.createElement("div");
  portrait.className = "mb-portrait";
  const who = document.createElement("div");
  who.className = "mb-who";
  const conductor = document.createElement("div");
  conductor.className = "mb-conductor";
  const ensemble = document.createElement("div");
  ensemble.className = "mb-ensemble";
  who.append(conductor, ensemble);
  const year = document.createElement("div");
  year.className = "mb-year";
  // Recording facts (portrait, conductor over ensemble, year) as one cluster,
  // then the piece, visually separated: the year belongs to the RECORDING, so it
  // stays beside the people who made it rather than drifting to the title.
  el.append(portrait, who, year, piece);

  function update(file) {
    const meta = file ? metadataFor(data, file) : {};
    // textContent throughout, never innerHTML: these values come from MusicBrainz
    // and an RDF dump by way of the prep script, so they are external data even
    // though they were fetched offline.
    conductor.textContent = meta.conductor || "";
    ensemble.textContent = meta.ensemble || "";
    year.textContent = meta.year != null ? String(meta.year) : "";
    el.dataset.file = file || "";

    portrait.textContent = "";
    portrait.style.backgroundImage = "";
    if (meta.portrait) {
      // A generated portrait, once there is one. Set as a background rather than
      // an <img> so a missing file degrades to the placeholder circle instead of
      // a broken-image glyph on a museum wall.
      portrait.style.backgroundImage = `url("${encodeURI(meta.portrait)}")`;
    } else {
      portrait.textContent = initials(meta.conductor);
    }
  }

  update(null);
  return { el, update };
}

/**
 * Initials from a personal name: "Georges Prêtre" -> "GP".
 *
 * Deliberately naive about name structure — first letter of the first and last
 * whitespace-separated parts, and nothing clever about particles ("von Karajan"
 * gives HK, not HvK). A placeholder awaiting real portraits does not justify a
 * theory of European name order, and getting it subtly wrong for one conductor
 * would be worse than being obviously simple for all of them.
 */
export function initials(name) {
  if (!name) return "";
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "";
  const first = [...parts[0]][0] || "";
  const last = parts.length > 1 ? [...parts[parts.length - 1]][0] || "" : "";
  return (first + last).toUpperCase();
}
