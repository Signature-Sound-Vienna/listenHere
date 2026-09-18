// exhibit/years-view.js
//
// The by-year explorer: every New Year's Concert of the Wiener Philharmoniker,
// as a grid of years beside one concert's card — its date, conductor, programme,
// what the project's collection holds of it, and, where the exhibit has that
// concert's recording of the current piece, the one tap that plays it.
//
// The first of the non-comparative views (plan §2.4, §11), and the FIRST
// SURFACE ALLOWED TO CARRY TEXT: it lives on a viewport's own half, so it may
// speak that reader's language — unlike the shared band (§6.3). That is also why
// the portraits' sentence lives here (§11(d)) — and at the foot of the
// by-conductor explorer (conductors-view.js), which shows a portrait large.
// Since 0.68.0 the portraits are freely-licensed photographs rather than Gen-AI
// impressions, so that line carries their CREDIT, which the licences require,
// rather than explaining a mark.
//
// DRAWN OVER the viewport's strips and commentary rather than replacing them
// (main.js mounts it as an absolutely positioned layer): the listening machinery
// underneath keeps running untouched, so the other half of the table hears no
// difference, and switching back costs nothing — no renderer is rebuilt, no
// canvas re-measured, no transition frozen by a hidden pane.
//
// READS ONLY the concerts sidecar (concerts.js) plus two facts from the payload
// — the piece's title and which files are playable. It knows nothing about how
// the two archives were reconciled; every item carries its `source`, and every
// item either archive lists is SHOWN rather than dropped or silently chosen
// between. That `source` is no longer DRAWN (user, 2026-09-18): which archive
// vouches for an encore is the museum's bookkeeping, not a visitor's reading.
//
// KIOSK RULE: nothing scrolls. The grid is nine decade rows of ten finger-sized
// cells; the programme lists in two columns and is clipped rather than scrolled
// if it ever overflows — spec 45 measures the longest one at the iPad geometry.

import { portraitAbout, resolveText, t } from "./strings.js";
import { acknowledgeThen, initials } from "./middle-band.js";
import { createDyk, pulseStoryHint } from "./dyk.js";

/**
 * @param {object} opts
 * @param {number} opts.viewport
 * @param {string} opts.language          resolved per viewport (plan §5.3)
 * @param {import("./concerts.js").Concerts|null} opts.concerts
 * @param {import("./concerts.js").Dyk|null} [opts.dyk]  the museum's "did you know?" text
 * @param {object} [opts.audienceStore]   AudienceStore; the story is told in THIS reader's register
 * @param {boolean} [opts.dykImages]      `?dykImages` — whether the story's figure is drawn
 * @param {object} opts.piece             the payload's piece (id, title map)
 * @param {(path: string) => string} opts.portraitUrl
 * @param {(file: string) => void} opts.onListen
 * @param {(view: string, at: object) => void} [opts.onExplore]  the OTHER explorer, on a fact
 * @param {number|null} [opts.initialYear]
 */
export function createYearsView({
  viewport, language, concerts, piece, portraitUrl, onListen, onExplore = null,
  initialYear = null, dyk = null, audienceStore = null, dykImages = true,
}) {
  const el = document.createElement("div");
  el.className = "vp-view";
  el.dataset.view = "years";
  el.dataset.viewport = String(viewport);

  const about = document.createElement("p");
  about.className = "yv-about";
  about.textContent = portraitAbout(language);

  if (!concerts) {
    // A degraded exhibit, said on the glass (the state.dataError precedent).
    const msg = document.createElement("p");
    msg.className = "yv-unavailable";
    msg.dataset.state = "unavailable";
    msg.textContent = t("years.unavailable", language);
    el.append(msg, about);
    return { el, select() {}, refit() {}, state: () => ({ year: null, available: false }), destroy() {} };
  }

  const heading = document.createElement("h2");
  heading.className = "yv-heading";
  heading.textContent = t("years.heading", language);

  const grid = buildGrid(concerts, language, dyk);
  const detail = document.createElement("section");
  detail.className = "yv-detail";

  // The story, when the selected year has one. It lives INSIDE the card, under
  // the programme — renderDetail puts it there — so it is simply present rather
  // than asked for (user, 2026-09-18); dyk.js carries why, and why it is the one
  // thing here allowed to scroll.
  const story = createDyk({
    language,
    images: dykImages,
    audience: () => audienceStore?.get(viewport),
  });
  const unsubscribe = audienceStore?.subscribe((i) => {
    if (i !== viewport) return;
    story.refresh();
    // …and say what the switch was FOR, whether or not this card has a story to
    // re-tell in the new register (dyk.js pulseStoryHint says why).
    pulseStoryHint(el);
  });

  el.append(heading, grid.el, detail, about);

  let selected = null;
  const pieceTitle = resolveText(piece?.title, { language }) || piece?.id || "";

  function select(year) {
    if (!concerts.byYear.has(year) && !concerts.years.includes(year)) return;
    selected = year;
    grid.paint(year);
    story.setEntry(dyk?.forYear(year));
    renderDetail(detail, concerts.get(year), {
      year, language, pieceId: piece?.id, pieceTitle, portraitUrl, onListen, onExplore,
      story: story.el,
    });
    // The credit follows the face: this card shows THIS year's conductor, so the
    // foot names the photographer of THAT portrait (strings.js, portraitAbout).
    about.textContent = portraitAbout(
      language, concerts.portraitCredit(concerts.get(year)?.conductor || ""),
    );
  }
  grid.onPick(select);

  // Resting selection: the concert the audible recording comes from when it is
  // one, else the last year the archives know — the newest concert, which is
  // also the one a visitor most likely remembers.
  select(initialYear ?? concerts.lastInArchives ?? concerts.first);

  return {
    el,
    select,
    state: () => ({ year: selected, available: true }),
    // Re-measure the programme's fit once the overlay is actually in the
    // document: the first card is built before main.js mounts the layer, so
    // its measurement could only be deferred to a frame — and a hidden tab
    // never gets one (the visibility-throttling trap).
    refit: () => {
      const ol = detail.querySelector(".yv-programme");
      if (ol) fitProgramme(ol);
      story.remeasure();
    },
    destroy: () => {
      unsubscribe?.();
      el.remove();
    },
  };
}

// ---------------------------------------------------------------------------
// The grid: one row per decade, ten cells per row, the last digit as the column
// so 1987 sits under 1977 and over 1997. Cells before the first concert are
// blank; every year from the founding concert to the present is a cell, and a
// year the archives cannot fill is a GAP cell — dimmed, but tappable, so the
// card can say why (no concert in 1940; nothing scraped after 2023).
// ---------------------------------------------------------------------------

function buildGrid(concerts, language, dyk) {
  const root = document.createElement("div");
  root.className = "yv-grid";
  root.setAttribute("role", "group");
  root.setAttribute("aria-label", t("years.chooseYear", language));

  const firstDecade = Math.floor(concerts.first / 10) * 10;
  const lastDecade = Math.floor(concerts.through / 10) * 10;
  const cells = new Map();
  let pick = () => {};

  for (let decade = firstDecade; decade <= lastDecade; decade += 10) {
    const row = document.createElement("div");
    row.className = "yv-row";
    const label = document.createElement("span");
    label.className = "yv-decade";
    // Numerals only, like the band: "1980s" would need a language.
    label.textContent = String(decade);
    row.appendChild(label);
    for (let d = 0; d < 10; d++) {
      const year = decade + d;
      if (year < concerts.first || year > concerts.through) {
        const blank = document.createElement("span");
        blank.className = "yv-cell yv-cell-blank";
        row.appendChild(blank);
        continue;
      }
      const c = concerts.get(year);
      const b = document.createElement("button");
      b.type = "button";
      b.className = "yv-cell";
      b.dataset.year = String(year);
      b.dataset.state = c?.date ? "concert" : "gap";
      if (c?.founding) b.dataset.founding = "1";
      // TWO MARKS, NOT FOUR (user, 2026-09-18): the exhibit can PLAY this
      // concert, and this concert has a story. The "the current piece was on
      // this programme" hairline went with the archive marks — 84 cells wearing
      // three signals is noise, and the card says that one in words anyway.
      if (c?.playable?.length) b.dataset.playable = "1";
      if (dyk?.forYear(year)) b.dataset.dyk = "1";
      b.textContent = String(year).slice(2);
      b.setAttribute("aria-label", String(year));
      b.setAttribute("aria-pressed", "false");
      b.addEventListener("click", () => pick(year));
      row.appendChild(b);
      cells.set(year, b);
    }
    root.appendChild(row);
  }

  return {
    el: root,
    onPick: (fn) => {
      pick = fn;
    },
    paint: (year) => {
      for (const [y, b] of cells) {
        const on = y === year;
        b.classList.toggle("is-selected", on);
        b.setAttribute("aria-pressed", on ? "true" : "false");
      }
    },
  };
}

// ---------------------------------------------------------------------------
// The card.
// ---------------------------------------------------------------------------

function renderDetail(root, c, { year, language, pieceId, pieceTitle, portraitUrl, onListen, onExplore, story }) {
  root.textContent = "";
  root.dataset.year = String(year);
  root.dataset.state = c?.date ? "concert" : "gap";

  const head = document.createElement("header");
  head.className = "yv-head";
  const h = document.createElement("h3");
  h.className = "yv-year";
  h.textContent = String(year);
  head.appendChild(h);
  if (c?.date) {
    const d = document.createElement("div");
    d.className = "yv-date";
    d.textContent = formatDate(c.date, language);
    head.appendChild(d);
  }
  root.appendChild(head);

  if (!c || !c.date) {
    const note = document.createElement("p");
    note.className = "yv-note";
    note.dataset.reason = c?.note || "missing";
    note.textContent = t(
      c?.note === "no-concert" ? "years.noConcert"
        : c?.note === "after-archives" ? "years.afterArchives"
        : "years.missing",
      language,
    );
    root.appendChild(note);
    return;
  }

  if (c.founding) {
    const note = document.createElement("p");
    note.className = "yv-note";
    note.dataset.reason = "founding";
    note.textContent = t("years.founding", language);
    root.appendChild(note);
  }

  // Conductor: the portrait where the exhibit has one for this concert's
  // conductor (its photo credit sits at the view's foot), initials otherwise —
  // the band's own fallback, so the two surfaces agree about who has a face.
  if (c.conductor) {
    const who = document.createElement("div");
    who.className = "yv-conductor";
    // THE WAY ACROSS (user, 2026-09-18, reversing plan §11(f)): the face and the
    // name are one button into the by-conductor explorer, opened on them. The
    // medallion and the name TOGETHER, so the target is the 56 px face rather
    // than a line of type — and "With …" stays OUTSIDE it, because those are the
    // other performers and a tap there must not claim to be about the conductor.
    // Every conductor the sidecar names is in that explorer's roster by
    // construction (it is built by grouping these same concerts), so the link
    // cannot point at nothing.
    const face = document.createElement(onExplore ? "button" : "div");
    face.className = "yv-conductor-face";
    if (onExplore) {
      face.type = "button";
      face.setAttribute(
        "aria-label",
        t("years.openConductor", language).replace("{conductor}", c.conductor),
      );
      face.addEventListener("click", () =>
        acknowledgeThen(face, () => onExplore("conductors", { conductor: c.conductor })),
      );
    }
    const medallion = document.createElement("div");
    medallion.className = "yv-medallion";
    if (c.portrait) {
      const img = document.createElement("img");
      img.className = "yv-portrait";
      img.alt = "";
      img.decoding = "async";
      img.src = portraitUrl(c.portrait);
      medallion.appendChild(img);
      medallion.dataset.portrait = "1";
    } else {
      medallion.textContent = initials(c.conductor);
    }
    const name = document.createElement("div");
    name.className = "yv-conductor-name";
    name.textContent = c.conductor;
    face.append(medallion, name);
    who.appendChild(face);
    if (c.alsoPerforming?.length) {
      const with_ = document.createElement("div");
      with_.className = "yv-with";
      with_.textContent =
        t("years.with", language) + " " +
        c.alsoPerforming.map((p) => `${p.name} (${p.role})`).join(", ");
      who.appendChild(with_);
    }
    root.appendChild(who);
  }

  // Programme.
  const progHead = document.createElement("h4");
  progHead.className = "yv-programme-head";
  progHead.textContent = t("years.programme", language);
  root.appendChild(progHead);
  if (c.programme?.length) {
    const ol = document.createElement("ol");
    ol.className = "yv-programme";
    for (const item of c.programme) {
      const li = document.createElement("li");
      li.className = "yv-item";
      // WHICH ARCHIVE VOUCHES FOR AN ITEM IS RECORDED, NOT DRAWN (user,
      // 2026-09-18): the reconciliation matters to the museum and is in the
      // sidecar, the tool's report, and this attribute — but a visitor reading a
      // programme does not need to know that the Musikverein listed an encore
      // the orchestra's own archive did not. The contract that matters survives
      // untouched: every item either archive lists is SHOWN, never dropped and
      // never silently chosen between (45.6).
      li.dataset.source = item.source;
      const comp = document.createElement("span");
      comp.className = "yv-item-composer";
      comp.textContent = (item.composers || []).map((x) => resolveText(x.name, { language })).join(" / ");
      const title = document.createElement("span");
      title.className = "yv-item-title";
      title.textContent = item.title;
      li.append(comp, title);
      ol.appendChild(li);
    }
    root.appendChild(ol);
    const caveat = document.createElement("p");
    caveat.className = "yv-caveat";
    caveat.textContent = t("years.programmeCaveat", language);
    root.appendChild(caveat);
    // The per-archive legend went with the per-item marks (see the list above).
    // The caveat above stays: "encores were often not recorded" is a fact about
    // the programme a visitor is reading, not bookkeeping about our sources.
  } else {
    const none = document.createElement("p");
    none.className = "yv-programme-empty";
    none.textContent = t("years.programmeUnknown", language);
    root.appendChild(none);
  }

  // The collection, and the way into the music.
  const foot = document.createElement("div");
  foot.className = "yv-foot";
  if (c.library?.length) {
    const lib = document.createElement("p");
    lib.className = "yv-library";
    const titles = [];
    for (const r of c.library) {
      const label = r.releaseTitle || r.record;
      const span = r.covers ? ` (${r.covers[0]}–${r.covers[1]})` : "";
      if (!titles.includes(label + span)) titles.push(label + span);
    }
    lib.textContent = `${t("years.inLibrary", language)}: ${titles.join("; ")}`;
    foot.appendChild(lib);
  }
  const playable = (c.playable || []).find((p) => p.piece === pieceId);
  if (playable) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "yv-listen";
    btn.dataset.file = playable.file;
    btn.textContent = t("years.listen", language).replace("{piece}", pieceTitle);
    btn.addEventListener("click", () => onListen(playable.file));
    foot.appendChild(btn);
  } else if (pieceId && c.onProgramme?.includes(pieceId)) {
    const on = document.createElement("p");
    on.className = "yv-on-programme";
    on.textContent = t("years.onProgramme", language).replace("{piece}", pieceTitle);
    foot.appendChild(on);
  }
  // The story, under the programme the visitor has just read (user,
  // 2026-09-18). Before the foot, so the one tap into the music stays the last
  // thing on the card, and before the programme is measured: the story claims
  // its share first and `fitProgramme` steps the list denser against what is
  // left, rather than the list taking everything and the story getting 4 px.
  if (story) root.appendChild(story);
  if (foot.childNodes.length) root.appendChild(foot);
  const ol = root.querySelector(".yv-programme");
  if (ol) fitProgramme(ol);
}

/**
 * Make the programme fit its two columns. The list's height is whatever the
 * card leaves it, and CSS multi-column does not clip a list that is too tall —
 * it SPILLS the overflow into a third column off the right edge, invisibly (the
 * 2010 programme lost its Radetzky March that way on the first render). So the
 * list is measured after layout and stepped down through two denser type sizes
 * until every column fits. Measured, not assumed: 15 items fit at the base
 * size, the 24-item programmes need the dense steps, and a future sidecar with
 * a longer one degrades to smaller type rather than to a missing encore.
 */
function fitProgramme(ol) {
  const STEPS = ["", "is-dense", "is-denser", "is-densest"];
  const overflows = () => ol.scrollWidth > ol.clientWidth + 1 || ol.scrollHeight > ol.clientHeight + 1;
  const apply = () => {
    // Cleared first, because this now runs TWICE (see below) and a verdict from
    // a half-settled layout must not outlive the settled one.
    delete ol.dataset.overflow;
    for (let i = 0; i < STEPS.length; i++) {
      ol.classList.remove("is-dense", "is-denser", "is-densest");
      if (STEPS[i]) ol.classList.add(STEPS[i]);
      if (!overflows()) return;
    }
    // Still overflowing at the densest step: say so in the DOM, so a spec (or a
    // technician) can see it — the visitor sees a clipped list, not a scrolled one.
    ol.dataset.overflow = "1";
  };
  // Not yet laid out at the moment of the call — the card is being built.
  if (ol.isConnected && ol.clientWidth) {
    apply();
    // ...and again once the frame has settled. The card shares its height with
    // the story below (dyk.js), which is a flex item that only resolves against
    // the space left over — so the first, synchronous measurement can read a
    // list as too tall that in fact fits, and 2005 did exactly that.
    requestAnimationFrame(apply);
  } else {
    requestAnimationFrame(apply);
  }
}

/** "1 January 1987" / "1. Jänner 1987" — the date is a plain yyyy-mm-dd, read as UTC noon so no time zone can move it. */
function formatDate(iso, language) {
  try {
    const locale = language === "de" ? "de-AT" : "en-GB";
    return new Intl.DateTimeFormat(locale, {
      day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
    }).format(new Date(iso + "T12:00:00Z"));
  } catch {
    return iso;
  }
}
