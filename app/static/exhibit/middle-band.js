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
// WHICH WAY UP, though, is a real question for a surface read from two opposite
// sides, and it is A/B-TESTABLE BY CONFIG (`?bandOrientation=`, plan §4.3's
// orientation question pulled forward by user feedback): "upright" favours the
// near visitor and inverts for the far one; "rotated" turns everything 90° so it
// is equally sideways for both; "mirrored" renders the whole cluster TWICE, the
// far copy turned 180°, so each reader gets a right-way-up copy — at the price of
// naming the piece once per reader rather than once per view (34.12 pins the
// upright default only). The clusters are built by one function and updated in
// lockstep, so the copies cannot drift apart.
//
// Portraits are null on all eight recordings today: they are to be generated, which
// is an open editorial item and not a code one, so the placeholder is the
// conductor's initials. Initials are still just their name, so the rule holds.
//
// One band per gap between viewports. With the default two viewports that is one
// band; with `?viewports=1` there is none, and the update below is a no-op rather
// than a special case.

import { metadataFor } from "./payload.js";
import { resolveText, t } from "./strings.js";

/**
 * Build a band. Returns a handle so `update` can be called per selection without
 * the caller having to know the band's internal structure.
 *
 * @param {object} data      from payload.js
 * @param {object} [opts]
 * @param {string} [opts.language]     for the piece title — see the caveat below
 * @param {string} [opts.orientation]  "upright" | "rotated" | "mirrored" (config.js)
 * @param {() => void} [opts.onToggle] the shared play/pause tap
 * @returns {{el: HTMLElement, update: (file: string|null) => void,
 *            tick: (state: {time: number, playing: boolean}) => void}}
 */
export function createMiddleBand(
  data,
  { language = "en", orientation = "upright", onToggle } = {},
) {
  const el = document.createElement("div");
  el.className = "middle-band";
  el.dataset.orientation = orientation;

  // Two copies for "mirrored", one for everything else. Same builder, same
  // update loop — the far reader's copy is a CSS rotation of an identical
  // cluster, never a second implementation that could drift.
  const clusters = [buildCluster(data, language)];
  if (orientation === "mirrored") clusters.push(buildCluster(data, language));
  clusters.forEach((c, i) => {
    c.root.classList.toggle("mb-flipped", i === 1);
    el.appendChild(c.root);
  });

  // The shared transport control: one LARGE play/pause in the middle of the
  // band (the one place both visitors own equally), with the current playback
  // time below it TWICE, the far copy rotated — numerals, so the no-labels
  // rule holds, and mirrored so each reader has one the right way up. In
  // mirrored mode it sits between the two clusters; otherwise it goes inside
  // the cluster before the piece block, which is as close to the band's centre
  // as the flex layout naturally puts it.
  const play = buildPlayControl(language, onToggle);
  if (orientation === "mirrored") el.insertBefore(play.root, clusters[1].root);
  else clusters[0].root.insertBefore(play.root, clusters[0].pieceEl);

  function update(file) {
    const meta = file ? metadataFor(data, file) : {};
    el.dataset.file = file || "";
    for (const c of clusters) c.update(meta);
  }

  update(null);
  return { el, update, tick: play.tick };
}

/** The play/pause button plus the mirrored pair of time readouts. */
function buildPlayControl(language, onToggle) {
  const root = document.createElement("div");
  root.className = "mb-play-wrap";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "mb-play";
  const near = document.createElement("span");
  near.className = "mb-time";
  const far = document.createElement("span");
  far.className = "mb-time mb-time-flipped";
  // A sandwich: the times are the bread, the button is the filling — one
  // readout on each side of the button, the far one rotated for the far
  // reader (user feedback, 2026-08-24).
  root.append(near, button, far);
  button.addEventListener("click", () => onToggle?.());

  let lastText = null;
  let lastPlaying = null;
  /** Per-frame, so both writes are guarded on change (the 34.10 discipline). */
  function tick({ time, playing }) {
    const text = _formatTime(time);
    if (text !== lastText) {
      lastText = text;
      near.textContent = text;
      far.textContent = text;
    }
    if (playing !== lastPlaying) {
      lastPlaying = playing;
      button.textContent = playing ? "❚❚" : "▶";
      button.setAttribute("aria-label", t(playing ? "transport.pause" : "transport.play", language));
      button.dataset.playing = playing ? "1" : "";
    }
  }
  tick({ time: 0, playing: false });
  return { root, tick };
}

/** m:ss — the seconds granularity a visitor can actually read at a glance. */
function _formatTime(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * One full content cluster: portrait, conductor over ensemble, year, piece.
 * Returns the root plus its own `update(meta)` so the band can drive one or two
 * of these identically.
 */
function buildCluster(data, language) {
  const root = document.createElement("div");
  root.className = "mb-cluster";

  // The piece: title, composer, and the opus number when the payload carries one.
  // Shown ONCE PER CLUSTER — every strip is the same piece, so repeating the
  // title eight times would say nothing — and set at build time, because the
  // piece does not change per selection (the attract loop's second piece
  // rebuilds the band).
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
  // The honest label for a pseudonymous credit (the Scholz b-shape ruling,
  // 2026-08-27): a sidecar `displayNote` — a language map, so it rides the
  // same documented tension as the piece title rather than breaking the
  // no-labels rule a second way — shown where the names would have been.
  const note = document.createElement("div");
  note.className = "mb-note";
  who.append(conductor, ensemble, note);
  const year = document.createElement("div");
  year.className = "mb-year";
  // Recording facts (portrait, conductor over ensemble, year) as one cluster,
  // then the piece, visually separated: the year belongs to the RECORDING, so it
  // stays beside the people who made it rather than drifting to the title.
  root.append(portrait, who, year, piece);

  function update(meta) {
    // textContent throughout, never innerHTML: these values come from MusicBrainz
    // and an RDF dump by way of the prep script, so they are external data even
    // though they were fetched offline.
    conductor.textContent = meta.conductor || "";
    ensemble.textContent = meta.ensemble || "";
    note.textContent = meta.displayNote
      ? resolveText(meta.displayNote, { language })
      : "";
    year.textContent = meta.year != null ? String(meta.year) : "";

    portrait.textContent = "";
    portrait.style.backgroundImage = "";
    if (meta.portrait) {
      // A generated portrait, once there is one. Set as a background rather than
      // an <img> so a missing file degrades to the placeholder circle instead of
      // a broken-image glyph on a museum wall.
      portrait.style.backgroundImage = `url("${encodeURI(meta.portrait)}")`;
    } else {
      // "?" for an identity decided to be unknown (the displayNote says why);
      // initials otherwise. An empty circle only when the sidecar has nothing.
      portrait.textContent = initials(meta.conductor) || (meta.displayNote ? "?" : "");
    }
  }

  return { root, update, pieceEl: piece };
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
