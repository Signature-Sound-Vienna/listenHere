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
// upright default only); and "flip" turns the single cluster to face whichever
// side last took the clock, so it is right-way-up for the person who just acted
// (Chanda, demo feedback 2026-09-01). The clusters are built by one function and
// updated in lockstep, so the copies cannot drift apart.
//
// FLIP IS ALSO A TURN SIGNAL, which is why it and the indicator below landed
// together: a band that turns towards you is the most legible statement the
// shared surface can make about whose tap the clock is answering. It does not
// replace the indicator, though — a band already facing you says nothing about
// whether you still hold the clock or merely read it last, and it says nothing
// at all in the other three orientations.
//
// The known cost, worth watching at the October testing rather than pre-solving:
// under the default `hijack` policy the holder changes on EVERY tap, so two
// visitors taking turns quickly make the band turn back and forth. Flip is much
// better behaved under `attribution` and `request`, where the clock changes
// hands as an event rather than as a side effect of touching anything.
//
// Portraits are null on all eight recordings today: they are to be generated, which
// is an open editorial item and not a code one, so the placeholder is the
// conductor's initials. Initials are still just their name, so the rule holds.
//
// One band per gap between viewports. With the default two viewports that is one
// band; with `?viewports=1` there is none, and the update below is a no-op rather
// than a special case.

import { metadataFor, portraitUrl } from "./payload.js";
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
 * @param {string} [opts.tap]          the RESOLVED band-tap affordance (config.js
 *   bandTapFor): "off", or one of the wordless cues the tappable facts wear.
 *   Anything but "off" makes the year and the conductor (name and portrait)
 *   tappable in every cluster — subject to `tappable` — and stamps the cue on
 *   the band for the CSS. The caller has already established that the
 *   orientation can attribute the tap (mirrored only); this module only draws.
 * @param {(fact: "year"|"conductor", meta: object, file: string|null) => boolean} [opts.tappable]
 *   whether a fact leads anywhere for the recording shown — the caller knows
 *   the concert series, the band does not. Null means nothing is tappable.
 * @param {(cluster: number, fact: "year"|"conductor", meta: object, file: string|null) => void} [opts.onFact]
 *   a tap on a tappable fact in cluster `cluster` (0 = the near reader's copy,
 *   1 = the far reader's — turns.js bandTapViewport maps it to a viewport).
 * @returns {{el: HTMLElement, update: (file: string|null) => void, refresh: () => void,
 *            setTurn: Function, tick: (state: {time: number, playing: boolean}) => void}}
 */
export function createMiddleBand(
  data,
  {
    language = "en",
    orientation = "upright",
    turnIndicator = "off",
    flipMotion = "fade",
    onToggle,
    tap = "off",
    tappable = null,
    onFact = null,
  } = {},
) {
  const el = document.createElement("div");
  el.className = "middle-band";
  el.dataset.orientation = orientation;
  el.dataset.flipMotion = flipMotion;
  // "edge" | "wash" | "off" — which mark the band wears for the side holding
  // the clock. An attribute rather than a class so the CSS reads as a switch
  // over named variants, the same shape as data-orientation above.
  el.dataset.turnIndicator = turnIndicator;
  // The tappable facts' cue (?bandTap, plan §11(f)). Absent when "off" so the
  // shipped band's DOM is byte-identical, not merely styled identically.
  if (tap !== "off") el.dataset.tap = tap;
  const facts = tap === "off" ? null : { tappable, onFact, language };

  // Two copies for "mirrored", one for everything else. Same builder, same
  // update loop — the far reader's copy is a CSS rotation of an identical
  // cluster, never a second implementation that could drift. The index is the
  // reader's: cluster 0 faces the near viewport, cluster 1 the far one.
  const clusters = [buildCluster(data, language, 0, facts)];
  if (orientation === "mirrored") clusters.push(buildCluster(data, language, 1, facts));
  clusters.forEach((c, i) => {
    c.root.classList.toggle("mb-flipped", i === 1);
    el.appendChild(c.root);
  });

  // "flip" keeps ONE cluster, like upright, and turns it to face whoever holds
  // the clock. The play control must stay out of that rotation for two
  // separate reasons, and both are load-bearing: ▶ turned 180° is ◀, which
  // would say the opposite of what it does; and the shared button is the one
  // surface on the table both visitors own equally (turns.js exempts it from
  // the turn machine entirely), so it must not jump from one END of the band
  // to the other every time the clock changes hands. So flip borrows
  // mirrored's structural placement — the control as its own child of the band
  // — while rendering upright's single cluster.
  //
  // It does still SHIFT a few pixels as the cluster beside it changes width
  // with the conductor's name, exactly as it does in upright and mirrored.
  // That is a pre-existing property of a centred flex row and not something
  // flip introduces; pinning the control to the band's centre would fix it for
  // all three orientations and is a separate change.
  const flips = orientation === "flip";
  // The cross-fade's first beat. Kept just under the CSS opacity transition so
  // the facing changes at the faintest point rather than on the way back up —
  // the whole trick is that the turn itself is never seen.
  const FADE_OUT_MS = 150;
  let turnTimer = 0;
  let turning = false;

  // The shared transport control: one LARGE play/pause in the middle of the
  // band (the one place both visitors own equally), with the current playback
  // time below it TWICE, the far copy rotated — numerals, so the no-labels
  // rule holds, and mirrored so each reader has one the right way up. In
  // mirrored mode it sits between the two clusters; otherwise it goes inside
  // the cluster before the piece block, which is as close to the band's centre
  // as the flex layout naturally puts it.
  const play = buildPlayControl(language, onToggle);
  if (orientation === "mirrored") el.insertBefore(play.root, clusters[1].root);
  else if (flips) el.appendChild(play.root);
  else clusters[0].root.insertBefore(play.root, clusters[0].pieceEl);

  function update(file) {
    const meta = file ? metadataFor(data, file) : {};
    el.dataset.file = file || "";
    for (const c of clusters) c.update(meta, file || null);
  }

  /**
   * Re-run the current recording's update — for the caller whose `tappable`
   * answer has changed without the recording changing (the concerts sidecar
   * landing after the band was built is the case in hand).
   */
  function refresh() {
    update(el.dataset.file || null);
  }

  /**
   * Whose tap the clock is currently answering — the one piece of turn state
   * the shared band knows about (Chanda, demo feedback 2026-09-01).
   *
   * It drives TWO things that were asked for separately and turn out to be one
   * fact seen twice:
   *
   *  * THE TURN INDICATOR, in every orientation: an edge or a wash on the
   *    holder's side of the band. What it MEANS depends on the policy in
   *    force, and the difference is real — under `request` the holder may
   *    actually withhold the audio, so the mark reads "this side may play
   *    back"; under `hijack` and `attribution` nobody can withhold anything,
   *    so it reads "this side chose what you are hearing". Same pixels, same
   *    source; the caller passes the policy so the panel and the study notes
   *    can say which claim is being made.
   *  * THE FLIP, in that orientation only: the cluster turns to face the
   *    holder. The rotation arrives in DEGREES from the caller rather than
   *    being derived from the viewport index here, because which way a
   *    viewport faces is configuration (`rotations`, §7.8) — a band that
   *    assumed 180 would be wrong the day the table is not two-sided.
   *
   * @param {number|null} holder     viewport index, or null before any tap
   * @param {number} [rotation]      degrees the holder's viewport is rotated
   * @param {string} [policy]        the turn policy in force, for the label
   */
  function setTurn(holder, rotation = 0, policy = "") {
    el.dataset.turnHolder = holder == null ? "" : String(holder);
    if (policy) el.dataset.turnPolicy = policy;
    if (!flips) return;
    // One transform on the cluster, so the play control and the mirrored time
    // readouts are untouched by it. Normalised, because a rotation the CSS
    // cannot animate sensibly (say 540) would spin the band on a museum wall.
    const deg = ((Number(rotation) || 0) % 360 + 360) % 360;
    turnTo(deg ? `rotate(${deg}deg)` : "");
  }

  /**
   * Change the cluster's facing, with the configured cue.
   *
   * "spin" is one assignment and lets the CSS transition animate the rotation.
   * "fade" is a two-beat cross-fade instead: dip the cluster almost out, change
   * the facing WHILE IT IS FAINT so the turn itself is never seen sweeping
   * across the band, then let it settle back. The user's reading (2026-09-01)
   * is that the spin was over the top for what it reports, and a soft beat
   * still says "this turned towards you" without moving anything across the one
   * surface both visitors are reading from.
   *
   * The timer is re-armed rather than stacked, because under ?turnPolicy=hijack
   * the holder changes on EVERY tap and two visitors alternating can land
   * changes closer together than the fade lasts. `turning` is what stops a
   * change that happens to be a no-op from returning early and leaving the
   * cluster parked at 12% opacity for the rest of the session.
   */
  function turnTo(next) {
    const cluster = clusters[0].root;
    if (next === cluster.style.transform && !turning) return;
    const still =
      flipMotion !== "fade" ||
      (typeof matchMedia === "function" &&
        matchMedia("(prefers-reduced-motion: reduce)").matches);
    if (still) {
      cluster.style.transform = next;
      return;
    }
    clearTimeout(turnTimer);
    turning = true;
    cluster.classList.add("mb-turning");
    turnTimer = setTimeout(() => {
      turnTimer = 0;
      turning = false;
      cluster.style.transform = next;
      cluster.classList.remove("mb-turning");
    }, FADE_OUT_MS);
  }

  update(null);
  setTurn(null);
  return { el, update, refresh, setTurn, tick: play.tick };
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
 * Returns the root plus its own `update(meta, file)` so the band can drive one
 * or two of these identically.
 *
 * @param {number} index  which reader's copy this is (mirrored: 0 near, 1 far)
 * @param {{tappable: Function|null, onFact: Function|null, language: string}|null} facts
 *   null when the band's facts are not tappable (the shipped band)
 */
function buildCluster(data, language, index = 0, facts = null) {
  const root = document.createElement("div");
  root.className = "mb-cluster";
  root.dataset.cluster = String(index);

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

  // THE FACTS AS THE INTERFACE (?bandTap, plan §11(f)). The same three
  // elements, not wrappers around them — the specs and the orientation CSS
  // address `.mb-conductor` / `.mb-year` / `.mb-portrait` directly, and a
  // wrapper would move them. When a fact is tappable it gets the button role,
  // a tab stop, an aria-label (the one place words are allowed: they are not
  // on the glass), and the `is-tappable` class the affordance CSS keys off;
  // when it is not, all of that is removed again, so a recording the series
  // cannot follow shows a plain fact — never a dead button.
  let current = { meta: {}, file: null };
  const factEls = facts
    ? [
        [portrait, "conductor"],
        [conductor, "conductor"],
        [year, "year"],
      ]
    : [];
  for (const [elm, fact] of factEls) {
    elm.dataset.fact = fact;
    const fire = () => {
      if (!elm.classList.contains("is-tappable")) return;
      facts.onFact?.(index, fact, current.meta, current.file);
    };
    elm.addEventListener("click", fire);
    elm.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      fire();
    });
  }
  function setTappable(elm, on, label) {
    elm.classList.toggle("is-tappable", on);
    if (on) {
      elm.setAttribute("role", "button");
      elm.setAttribute("tabindex", "0");
      elm.setAttribute("aria-label", label);
    } else {
      elm.removeAttribute("role");
      elm.removeAttribute("tabindex");
      elm.removeAttribute("aria-label");
    }
  }

  function update(meta, file = null) {
    current = { meta, file };
    // textContent throughout, never innerHTML: these values come from MusicBrainz
    // and an RDF dump by way of the prep script, so they are external data even
    // though they were fetched offline.
    conductor.textContent = meta.conductor || "";
    ensemble.textContent = meta.ensemble || "";
    note.textContent = meta.displayNote
      ? resolveText(meta.displayNote, { language })
      : "";
    year.textContent = meta.year != null ? String(meta.year) : "";

    if (facts) {
      const canYear = meta.year != null && facts.tappable?.("year", meta, file) === true;
      const canConductor =
        Boolean(meta.conductor) && facts.tappable?.("conductor", meta, file) === true;
      setTappable(
        year, canYear,
        t("band.openYear", facts.language).replace("{year}", String(meta.year)),
      );
      const whoLabel = t("band.openConductor", facts.language).replace("{name}", meta.conductor || "");
      setTappable(conductor, canConductor, whoLabel);
      setTappable(portrait, canConductor, whoLabel);
    }

    portrait.textContent = "";
    portrait.style.backgroundImage = "";
    const portraitSrc = portraitUrl(meta);
    // The class, not the background alone, is what CSS keys the transparent
    // ground off: a marked asset is transparent around its medallion, and the
    // card colour behind it would ring the face. The initials still want it.
    portrait.classList.toggle("has-portrait", Boolean(portraitSrc));
    if (portraitSrc) {
      // A generated portrait, once there is one. Set as a background rather than
      // an <img> so a missing file degrades to the placeholder circle instead of
      // a broken-image glyph on a museum wall. Resolved against the exhibit root
      // by payload.js, not left relative to whatever document is showing this.
      portrait.style.backgroundImage = `url("${encodeURI(portraitSrc)}")`;
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
