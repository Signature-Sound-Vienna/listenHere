// exhibit/dyk.js
//
// "Did you know?" — the museum's authored text, shared by both explorers.
//
// Chanda's content (content/dyk/, tools/prep_exhibit_dyk.py) tells six concerts
// and six conductors' stories, each written three times over for the exhibit's
// three audiences. It is CONTENT, not a UX variant: always on, with no query
// parameter to earn it (user, 2026-09-18). The one knob is `?dykImages`, and it
// governs the two PICTURES, not the prose.
//
// IT IS SIMPLY THERE (user, 2026-09-18, after trying the alternative). The story
// sits in the card — under the programme in the by-year explorer, under the
// conductor's own facts in the by-conductor one — and appears whenever the
// selected year or conductor has one. It was briefly a chip that opened a panel
// over the card, because the card is tight (see the measurements below); the
// user tried that and preferred the text simply being present, accepting a
// scroll when it does not fit. Which is the right trade: a story a visitor has
// to ask for is a story most visitors never see.
//
// SO THIS IS THE ONE PLACE IN THE EXHIBIT THAT SCROLLS, and it is deliberate.
// Everywhere else the kiosk rule holds — the programme list degrades its type
// rather than scroll, the roster steps denser — because those are LISTS, where
// a hidden last item reads as "there is no more". Prose is different: a
// paragraph cut mid-sentence is visibly cut, and a reader who wants the rest
// can ask for it. The block still says so rather than hoping: `data-scroll="1"`
// and a soft fade at its foot when there is more below.
//
// MEASURED, so nobody re-derives it: at the kiosk geometry (1024×1366, two
// viewports, so an explorer overlay 571 px tall) the by-year card has 4 px of
// slack on 2005 and 9 px on 1968, up to 113 px on 1945, and a story needs
// 121–210 px. The programme gives up what it can first (fitProgramme steps it
// denser), and the story takes the rest. On most of the six years it will
// scroll; the by-conductor card, with 263–331 px spare, mostly will not.
//
// ONE REGISTER, THE READER'S OWN (user, 2026-09-18). The three texts are
// alternatives, not a stack, so the block shows the audience this viewport is
// set to and re-renders when that changes. Under the `all` pseudo-audience
// (?audienceAll=1) there is no union to show, so it reads as adults.
//
// ENGLISH ONLY for now: her text is untranslated, and the German half falls back
// exactly as the attract band's title does (strings.js resolveText). The
// heading around it is ours and has German.
//
// The text arrives carrying `**bold**` and `*italic*` markers. They are rendered
// by splitting into `<strong>`/`<em>` elements with everything else set as text:
// authored content never reaches innerHTML.

import { resolveText, t } from "./strings.js";

// Sidecar paths resolve against this directory, not the document (payload.js
// portraitUrl says why).
const EXHIBIT_BASE = new URL("./", import.meta.url);

/** The audience whose text a card shows, given the store's current value. */
export function dykAudience(audience) {
  // "all" unions annotation LISTS; a story has no union — the three registers
  // are three tellings of the same fact. The middle one is the reasonable read.
  return audience === "all" || !audience ? "adults" : audience;
}

/**
 * Render `**bold**` and `*italic*` into `target`; everything else is text.
 *
 * Deliberately tiny and deliberately not a markdown parser: the only markers the
 * prep tool leaves in the JSON are these two, and anything it does not recognise
 * must appear as the characters the author typed rather than disappear. An
 * unclosed marker is left alone for the same reason — Chanda's Krips paragraph
 * has one ("*Anschlus*s"), and it is hers to rule on, not ours to tidy.
 */
export function renderMarkup(target, text) {
  const RE = /\*\*([^*]+)\*\*|\*([^*]+)\*/g;
  let last = 0;
  let m;
  while ((m = RE.exec(text))) {
    if (m.index > last) target.appendChild(document.createTextNode(text.slice(last, m.index)));
    const strong = m[1] != null;
    const el = document.createElement(strong ? "strong" : "em");
    el.textContent = strong ? m[1] : m[2];
    target.appendChild(el);
    last = RE.lastIndex;
  }
  if (last < text.length) target.appendChild(document.createTextNode(text.slice(last)));
  return target;
}

/**
 * The story block for one explorer. The caller appends `el` where the story
 * belongs in its card and calls `setEntry` on every selection.
 *
 * @param {object} opts
 * @param {string} opts.language        resolved per viewport (plan §5.3)
 * @param {boolean} opts.images         `?dykImages` — whether the figure is drawn
 * @param {string} [opts.font]          `?dykFont` — "print" (the card's serif) or "hand"
 * @param {string} [opts.skin]          `?dykSkin` — "pad", "coil", or "plain"
 * @param {number} [opts.width]         `?dykWidth` — the pad's width, percent
 * @param {number} [opts.tilt]          `?dykTilt` — the pad's rotation, degrees
 * @param {() => string} opts.audience  the viewport's current audience id
 * @returns {{el: HTMLElement, setEntry: Function, refresh: Function, hasEntry: () => boolean}}
 */
export function createDyk({
  language, images = true, font = "print", skin = "pad",
  width = 94, tilt = 1.3, audience = () => "adults",
}) {
  const el = document.createElement("section");
  el.className = "dyk";
  // The face the story is set in (`?dykFont`). On the ELEMENT rather than in a
  // class, so the study panel's value and the DOM say the same word — and so
  // exhibit.css can key both the family and the size off it, which a handwriting
  // face needs: the same nominal size reads smaller by eye.
  el.dataset.font = font === "hand" ? "hand" : "print";
  // How it is DRAWN (`?dykSkin`): the clipboard, or the accent rule the exhibit
  // shipped with. On the element for the same reason as the face — the whole
  // skin hangs off one attribute in exhibit.css, so "off" is an absence of rules
  // rather than a pile of overrides undoing them.
  el.dataset.skin = SKINS.has(skin) ? skin : "pad";
  // The pad's geometry, as two numbers the study panel can turn (`?dykWidth`,
  // `?dykTilt`). Written as custom properties rather than as width/transform,
  // so exhibit.css keeps the rules and this keeps only the values — and so the
  // reduced-motion branch can override the tilt without fighting an inline
  // style, which it could not do if this wrote `transform` directly.
  el.style.setProperty("--dyk-width", `${Number(width) || 0}%`);
  el.style.setProperty("--dyk-tilt", `${Number(tilt) || 0}deg`);
  el.hidden = true;

  // THE BINDING is a real element, not a pseudo: `.dyk` has spent both of its
  // own on the scroll fade and the punched holes, and the binding needs two of
  // its own — the sprung metal and the shadow it throws on the paper for the
  // clipboard, the wire and its shadow for the coil.
  if (el.dataset.skin !== "plain") {
    const bind = document.createElement("div");
    bind.className = "dyk-bind";
    bind.setAttribute("aria-hidden", "true");
    el.appendChild(bind);
  }

  const heading = document.createElement("h4");
  heading.className = "dyk-heading";
  heading.textContent = t("dyk.heading", language);

  const eyebrow = document.createElement("p");
  eyebrow.className = "dyk-eyebrow";

  // The heading and the hook stay put; only the prose scrolls, so a reader
  // always knows what they are reading even half way down it.
  const body = document.createElement("div");
  body.className = "dyk-body";
  const text = document.createElement("p");
  text.className = "dyk-text";
  body.appendChild(text);

  el.append(heading, eyebrow, body);

  let entry = null;
  let lightbox = null;

  function closeLightbox() {
    lightbox?.remove();
    lightbox = null;
  }

  /**
   * The picture big, over the reader's OWN half: appended to the explorer's
   * `.vp-view` rather than the body, so the far half's lightbox is turned with
   * its half, and outside the pad, so it is not tilted with the story. A tap
   * anywhere closes it, as does a new subject or register.
   */
  function openLightbox(fig, img) {
    closeLightbox();
    const host = fig.closest(".vp-view") || fig.closest(".vp") || document.body;
    const box = document.createElement("div");
    box.className = "dyk-lightbox";
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    const pic = document.createElement("img");
    pic.alt = "";
    pic.src = fig.querySelector("img").src;
    const cap = fig.querySelector("figcaption").cloneNode(true);
    // The lightbox covers the explorer's foot, and the disclosure with it.
    if (img.status === "generated") cap.appendChild(aiDisclosure(language));
    const close = document.createElement("button");
    close.type = "button";
    close.className = "dyk-lightbox-close";
    close.setAttribute("aria-label", t("dyk.closeImage", language));
    close.textContent = "×";
    box.append(pic, cap, close);
    box.addEventListener("click", (ev) => {
      ev.stopPropagation();
      closeLightbox();
    });
    box.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") closeLightbox();
    });
    host.appendChild(box);
    lightbox = box;
    close.focus({ preventScroll: true });
  }

  /** Rebuild for the current entry and audience. */
  function render() {
    closeLightbox();
    const sub = entry?.subtitle ? resolveText(entry.subtitle, { language }) : "";
    eyebrow.textContent = sub;
    eyebrow.hidden = !sub;
    text.textContent = "";
    const aid = dykAudience(audience());
    el.dataset.audience = aid;
    const value = entry?.text?.[aid] || entry?.text?.adults || null;
    if (value) renderMarkup(text, resolveText(value, { language }));
    // The figure: a framed box at the picture's own aspect, because the picture
    // itself may not be shown (licence — content/dyk/README.md). Nothing here
    // derives a fact from it (the portraits README's rule 3).
    body.querySelector(".dyk-figure")?.remove();
    const img = entry?.image;
    // An illustration may be for some registers only (none is, as of 2026-10-20).
    if (img && images && (!img.audiences || img.audiences.includes(aid))) {
      const fig = document.createElement("figure");
      fig.className = "dyk-figure";
      fig.dataset.status = img.status || "placeholder";
      const frame = document.createElement("div");
      frame.className = "dyk-frame";
      const [w, h] = img.aspect || [4, 3];
      frame.style.aspectRatio = `${w} / ${h}`;
      if ((img.status === "licensed" || img.status === "generated") && img.src) {
        const el2 = document.createElement("img");
        el2.alt = "";
        el2.decoding = "async";
        // The scroll fade is measured at render; measure again once the picture
        // is in, or a flag set mid-load outlives the overflow it reported.
        el2.addEventListener("load", markScroll, { once: true });
        el2.src = new URL(img.src, EXHIBIT_BASE).href;
        frame.appendChild(el2);
      } else {
        const note = document.createElement("span");
        note.className = "dyk-pending";
        note.textContent = t("dyk.imagePending", language);
        frame.appendChild(note);
      }
      const cap = document.createElement("figcaption");
      cap.textContent = resolveText(img.caption, { language });
      // No disclosure under the caption: the sentence explaining the spark sits
      // once on the explorer's foot (aiDisclosure), not under every picture.
      fig.append(frame, cap);
      // A real picture opens big on a tap (user, 2026-10-20); a placeholder has
      // nothing to enlarge.
      if (frame.querySelector("img")) {
        fig.tabIndex = 0;
        fig.setAttribute("role", "button");
        fig.setAttribute("aria-label", t("dyk.enlarge", language));
        fig.addEventListener("click", () => openLightbox(fig, img));
        fig.addEventListener("keydown", (ev) => {
          if (ev.key === "Enter" || ev.key === " ") {
            ev.preventDefault();
            openLightbox(fig, img);
          }
        });
      }
      // BEFORE the text, not after it (user, 2026-09-19: the picture sits top
      // right and the words run round it). A float is placed at the line it
      // appears on, so a figure appended after the paragraph would drop below
      // the whole of it — the DOM order IS the layout here, which is the one
      // thing a float asks of its markup.
      body.insertBefore(fig, text);
    }
    markScroll();
  }

  /**
   * Say, in the DOM and on the glass, that there is more text below.
   *
   * A kiosk has no scrollbar and no mouse wheel, so an overflowing box that
   * looks full reads as finished. `data-scroll` drives a soft fade at the foot,
   * and gives a spec something to assert; it is re-read whenever the box or the
   * text changes, because both the audience switch and the card's other content
   * move it.
   */
  function markScroll() {
    const apply = () => {
      // A REAL PICTURE TAKES THE ROOM THERE IS (user, 2026-10-20). Full width
      // above the text when the whole story still fits that way — a lone
      // viewport has hundreds of pixels to spare below the pad's text — and
      // floated beside it, at its CSS width, when it would push the text into
      // a scroll. Decided here because this is where the box is measured.
      const fig = body.querySelector('.dyk-figure[role="button"]');
      if (fig) {
        fig.dataset.fit = "full";
        if (body.scrollHeight > body.clientHeight + 1) fig.dataset.fit = "float";
      }
      // Measured on the scrolling box, flagged on the SECTION — the fade is
      // drawn over the box's foot, and a `::after` inside it would scroll away
      // with the text it is meant to be covering.
      const more = body.scrollHeight > body.clientHeight + 1;
      if (more) el.dataset.scroll = "1";
      else delete el.dataset.scroll;
    };
    if (el.isConnected && body.clientHeight) apply();
    else requestAnimationFrame(apply);
  }

  return {
    el,
    /** The story for what the explorer has just selected, or null for none. */
    setEntry(next) {
      entry = next || null;
      el.hidden = !entry;
      if (entry) {
        body.scrollTop = 0; // a new subject starts at its own beginning
        render();
      }
    },
    /** Re-render for a changed audience (the store's subscriber). */
    refresh() {
      if (entry) {
        body.scrollTop = 0;
        render();
      }
    },
    /** Re-measure the fade once the card is laid out (the views' refit). */
    remeasure: markScroll,
    hasEntry: () => Boolean(entry),
    /** Whether an AI illustration is on show, so the foot owes its disclosure. */
    showsAiImage: () => !el.hidden && Boolean(body.querySelector('.dyk-figure[data-status="generated"]')),
  };
}

/* ---------------------------------------------------------------------------
 * THE AI DISCLOSURE (plan §5.5; user, 2026-10-20).
 *
 * One sentence with the spark drawn INTO it, so a visitor matches the mark in
 * the corner of the picture to the words without being told to look for it.
 * The sigil is the one tools/prep_exhibit_dyk.py burns in (MARK_*): a gold
 * bubble with the four-point spark knocked out dark.
 * ------------------------------------------------------------------------- */

const SVG_NS = "http://www.w3.org/2000/svg";

function aiSigil() {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "-1 -1 2 2");
  svg.setAttribute("class", "dyk-ai-sigil");
  svg.setAttribute("aria-hidden", "true");
  const disc = document.createElementNS(SVG_NS, "circle");
  disc.setAttribute("r", "0.93");
  disc.setAttribute("fill", "rgb(212 178 94)");
  disc.setAttribute("stroke", "rgb(108 82 30)");
  disc.setAttribute("stroke-width", "0.13");
  // The tool's _spark: eight points from the top, alternating full and 0.34.
  const pts = [];
  for (let k = 0; k < 8; k++) {
    const ang = -Math.PI / 2 + (k * Math.PI) / 4;
    const rad = (k % 2 === 0 ? 1 : 0.34) * 0.62;
    pts.push(`${(rad * Math.cos(ang)).toFixed(3)},${(rad * Math.sin(ang)).toFixed(3)}`);
  }
  const spark = document.createElementNS(SVG_NS, "polygon");
  spark.setAttribute("points", pts.join(" "));
  spark.setAttribute("fill", "rgb(38 30 14)");
  svg.append(disc, spark);
  return svg;
}

/** The disclosure sentence as an element, the sigil standing at `{sigil}`. */
export function aiDisclosure(language) {
  const span = document.createElement("span");
  span.className = "dyk-ai-note";
  const [before, after = ""] = t("dyk.aiImages", language).split("{sigil}");
  span.append(before, aiSigil(), after);
  return span;
}

/* ---------------------------------------------------------------------------
 * THE SWITCH SAYS WHAT IT IS FOR (user, 2026-09-19).
 *
 * Inside an explorer the audience switch changes ONE thing: the register the
 * museum's story is told in. If the selected year or conductor happens to have
 * no story — twelve of the eighteen conductors do not — tapping Kids, Adults or
 * Scholars appears to do nothing at all, and a visitor reasonably concludes the
 * control is broken rather than that this card has nothing to re-tell.
 *
 * So the switch answers by pointing at its own subject: every BOOK mark on the
 * screen pulses once, and so does the story's heading where there is one. The
 * book already means "there is a story here" on the year grid, the roster row,
 * and the heading itself (0.70.0), so the hint teaches the connection rather
 * than introducing a new sign — and it needs no words, which matters because
 * this is the one gesture that must read the same in all three registers.
 * ------------------------------------------------------------------------- */

/** As long as the CSS keyframes run, plus a frame. */
/** The skins `?dykSkin` offers; anything else falls back to the clipboard. */
const SKINS = new Set(["pad", "coil", "plain"]);

const HINT_MS = 1000;
const hintTimers = new WeakMap();

/**
 * Pulse the story marks under `root` — an explorer's `.vp-view`.
 *
 * Cleared by TIME rather than `animationend`, so reduced motion (where the
 * marks brighten without moving, and there is no animation to end) clears it
 * too; the reflow between remove and add is what replays it when a visitor taps
 * twice through the registers.
 */
export function pulseStoryHint(root) {
  // A cached explorer for the other view subscribes to the same store and would
  // pulse in the dark: it is built once per viewport and kept, detached, while
  // the reader is in the other one.
  if (!root || !root.isConnected) return;
  clearTimeout(hintTimers.get(root));
  root.removeAttribute("data-dyk-hint");
  void root.offsetWidth;
  root.setAttribute("data-dyk-hint", "1");
  hintTimers.set(root, setTimeout(() => root.removeAttribute("data-dyk-hint"), HINT_MS));
}
