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
 * @param {() => string} opts.audience  the viewport's current audience id
 * @returns {{el: HTMLElement, setEntry: Function, refresh: Function, hasEntry: () => boolean}}
 */
export function createDyk({ language, images = true, audience = () => "adults" }) {
  const el = document.createElement("section");
  el.className = "dyk";
  el.hidden = true;

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

  /** Rebuild for the current entry and audience. */
  function render() {
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
    if (img && images) {
      const fig = document.createElement("figure");
      fig.className = "dyk-figure";
      fig.dataset.status = img.status || "placeholder";
      const frame = document.createElement("div");
      frame.className = "dyk-frame";
      const [w, h] = img.aspect || [4, 3];
      frame.style.aspectRatio = `${w} / ${h}`;
      if (img.status === "licensed" && img.src) {
        const el2 = document.createElement("img");
        el2.alt = "";
        el2.decoding = "async";
        el2.src = img.src;
        frame.appendChild(el2);
      } else {
        const note = document.createElement("span");
        note.className = "dyk-pending";
        note.textContent = t("dyk.imagePending", language);
        frame.appendChild(note);
      }
      const cap = document.createElement("figcaption");
      cap.textContent = resolveText(img.caption, { language });
      fig.append(frame, cap);
      body.appendChild(fig);
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
  };
}
