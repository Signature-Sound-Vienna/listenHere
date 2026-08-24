// exhibit/middle-band.js
//
// The band between the two halves. It shows who is conducting the recording the
// clock is on, in what year, and eventually their portrait — and NOTHING ELSE.
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

/**
 * Build a band. Returns a handle so `update` can be called per selection without
 * the caller having to know the band's internal structure.
 *
 * @returns {{el: HTMLElement, update: (file: string|null) => void}}
 */
export function createMiddleBand(data) {
  const el = document.createElement("div");
  el.className = "middle-band";

  const portrait = document.createElement("div");
  portrait.className = "mb-portrait";
  const conductor = document.createElement("div");
  conductor.className = "mb-conductor";
  const year = document.createElement("div");
  year.className = "mb-year";
  el.append(portrait, conductor, year);

  function update(file) {
    const meta = file ? metadataFor(data, file) : {};
    // textContent throughout, never innerHTML: these values come from MusicBrainz
    // and an RDF dump by way of the prep script, so they are external data even
    // though they were fetched offline.
    conductor.textContent = meta.conductor || "";
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
