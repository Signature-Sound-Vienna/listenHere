// exhibit/conductors-view.js
//
// The by-conductor explorer: everyone who has conducted a New Year's Concert of
// the Wiener Philharmoniker, in the order they first did, beside one
// conductor's card — the portrait large where the exhibit has one, their years
// on the podium, and, where the exhibit holds their recording of the current
// piece, the one tap that plays it.
//
// The second of the non-comparative views (plan §2.4, §11), built on the same
// three decisions as years-view.js and re-deriving none of them:
//
//   * DRAWN OVER the viewport's strips and commentary (main.js mounts it as an
//     absolutely positioned layer), so the listening machinery underneath keeps
//     running and the other half of the table hears no difference.
//   * READS ONLY the concerts sidecar (concerts.js — its `conductors` index is
//     pure indexing of the series) plus two facts from the payload: the piece's
//     title and which files are playable. Names and years are the archives'.
//   * ALLOWED TO CARRY TEXT, like the by-year view, because it lives on one
//     reader's half. So the AI-disclosure sentence (§11(d)) is at its foot too:
//     this is where a portrait is shown LARGE, and the mark it carries is
//     burned into the asset — nothing here labels it, one sentence explains it.
//
// WHAT IS DELIBERATELY NOT HERE: the years on the card are marks, not buttons.
// Facets as navigation INSIDE an explorer is the fallback design for an upright
// band (plan §11(f)); the ruled entry is the mirrored band, and building both
// would leave the October testing comparing two navigations at once.
//
// One conductor, several sittings: the exhibit's portraits are named per
// RECORDING (each shows the sitter at the age they were for that concert), so a
// conductor with more than one portrait shows every sitting, by year. That is
// the naming working as intended (§11(d)), not duplication.
//
// KIOSK RULE: nothing scrolls. The roster is two columns of finger-sized rows
// filled down then across, stepped to denser rows if the series ever outgrows
// the height (fitRoster); the card is a fixed stack that fits at the iPad
// geometry — spec 46 measures both.

import { resolveText, t } from "./strings.js";
import { initials } from "./middle-band.js";

/**
 * @param {object} opts
 * @param {number} opts.viewport
 * @param {string} opts.language          resolved per viewport (plan §5.3)
 * @param {import("./concerts.js").Concerts|null} opts.concerts
 * @param {object} opts.piece             the payload's piece (id, title map)
 * @param {(path: string) => string} opts.portraitUrl
 * @param {(file: string) => void} opts.onListen
 * @param {string|null} [opts.initialConductor]  a name the sidecar knows
 */
export function createConductorsView({
  viewport, language, concerts, piece, portraitUrl, onListen, initialConductor = null,
}) {
  const el = document.createElement("div");
  el.className = "vp-view";
  el.dataset.view = "conductors";
  el.dataset.viewport = String(viewport);

  const about = document.createElement("p");
  about.className = "cv-about";
  about.textContent = t("about.portraitsAi", language);

  if (!concerts) {
    // A degraded exhibit, said on the glass (the state.dataError precedent).
    const msg = document.createElement("p");
    msg.className = "cv-unavailable";
    msg.dataset.state = "unavailable";
    msg.textContent = t("years.unavailable", language);
    el.append(msg, about);
    return {
      el, select() {}, refit() {},
      state: () => ({ conductor: null, available: false }),
      destroy() {},
    };
  }

  const heading = document.createElement("h2");
  heading.className = "cv-heading";
  heading.textContent = t("conductors.heading", language);

  const roster = buildRoster(concerts, language, portraitUrl);
  const detail = document.createElement("section");
  detail.className = "cv-detail";

  el.append(heading, roster.el, detail, about);

  let selected = null;
  const pieceTitle = resolveText(piece?.title, { language }) || piece?.id || "";

  function select(name) {
    const c = concerts.byConductor.get(name);
    if (!c) return;
    selected = name;
    roster.paint(name);
    renderDetail(detail, c, { language, pieceId: piece?.id, pieceTitle, portraitUrl, onListen });
  }
  roster.onPick(select);

  // Resting selection: the conductor of the audible recording when the series
  // knows them, else the most recent conductor — the one a visitor most likely
  // saw on television (the by-year view's "newest concert" reasoning).
  const last = concerts.conductors[concerts.conductors.length - 1];
  select(
    initialConductor && concerts.byConductor.has(initialConductor)
      ? initialConductor
      : last?.name,
  );

  return {
    el,
    select,
    state: () => ({ conductor: selected, available: true }),
    // Re-measure the roster's fit once the overlay is in the document (the
    // years view's refit precedent: a hidden tab never gets a frame).
    refit: () => fitRoster(roster.el),
    destroy: () => el.remove(),
  };
}

// ---------------------------------------------------------------------------
// The roster: one row per conductor in order of first concert — medallion,
// name, and their years (listed when three or fewer, else the span and a
// count). Filled down then across two columns, so the series' history reads
// down the left and continues down the right.
// ---------------------------------------------------------------------------

function buildRoster(concerts, language, portraitUrl) {
  const root = document.createElement("div");
  root.className = "cv-roster";
  root.setAttribute("role", "group");
  root.setAttribute("aria-label", t("conductors.chooseConductor", language));
  const n = concerts.conductors.length;
  root.style.setProperty("--cv-rows", String(Math.max(1, Math.ceil(n / 2))));

  const entries = new Map();
  let pick = () => {};

  for (const c of concerts.conductors) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "cv-entry";
    b.dataset.conductor = c.name;
    b.dataset.years = String(c.years.length);
    if (c.playable.length) b.dataset.playable = "1";
    b.setAttribute("aria-pressed", "false");

    const medallion = document.createElement("span");
    medallion.className = "cv-entry-medallion";
    const latest = c.portraits[c.portraits.length - 1];
    if (latest) {
      const img = document.createElement("img");
      img.className = "cv-entry-portrait";
      img.alt = "";
      img.decoding = "async";
      img.src = portraitUrl(latest.path);
      medallion.appendChild(img);
      medallion.dataset.portrait = "1";
    } else {
      medallion.textContent = initials(c.name);
    }

    const text = document.createElement("span");
    text.className = "cv-entry-text";
    const name = document.createElement("span");
    name.className = "cv-entry-name";
    name.textContent = c.name;
    const years = document.createElement("span");
    years.className = "cv-entry-years";
    years.textContent = c.years.length <= 3 ? c.years.join(", ") : `${c.first}–${c.last}`;
    text.append(name, years);
    b.append(medallion, text);
    if (c.years.length > 3) {
      // A count beside the span: numerals only, like everything wordless here.
      const count = document.createElement("span");
      count.className = "cv-entry-count";
      count.textContent = String(c.years.length);
      b.appendChild(count);
    }
    b.addEventListener("click", () => pick(c.name));
    root.appendChild(b);
    entries.set(c.name, b);
  }

  return {
    el: root,
    onPick: (fn) => {
      pick = fn;
    },
    paint: (name) => {
      for (const [who, b] of entries) {
        const on = who === name;
        b.classList.toggle("is-selected", on);
        b.setAttribute("aria-pressed", on ? "true" : "false");
      }
    },
  };
}

// ---------------------------------------------------------------------------
// The card.
// ---------------------------------------------------------------------------

function renderDetail(root, c, { language, pieceId, pieceTitle, portraitUrl, onListen }) {
  root.textContent = "";
  root.dataset.conductor = c.name;

  const head = document.createElement("header");
  head.className = "cv-head";
  // The portrait LARGE — the newest sitting when there are several; the AI
  // mark is in the asset, so nothing is added here (plan §11(d)). Initials
  // otherwise, the band's own fallback, so the surfaces agree who has a face.
  const medallion = document.createElement("div");
  medallion.className = "cv-medallion-large";
  const latest = c.portraits[c.portraits.length - 1];
  if (latest) {
    const img = document.createElement("img");
    img.className = "cv-portrait";
    img.alt = "";
    img.decoding = "async";
    img.src = portraitUrl(latest.path);
    medallion.appendChild(img);
    medallion.dataset.portrait = "1";
    medallion.dataset.portraitYear = String(latest.year);
  } else {
    medallion.textContent = initials(c.name);
  }
  const names = document.createElement("div");
  names.className = "cv-names";
  const h = document.createElement("h3");
  h.className = "cv-name";
  h.textContent = c.name;
  const summary = document.createElement("p");
  summary.className = "cv-summary";
  summary.textContent =
    c.years.length === 1
      ? t("conductors.summaryOne", language).replace("{year}", String(c.first))
      : t("conductors.summary", language)
          .replace("{n}", String(c.years.length))
          .replace("{first}", String(c.first))
          .replace("{last}", String(c.last));
  names.append(h, summary);
  if (c.roles.length) {
    // The archive's own literal ("Dirigent und Violine"), shown as data like
    // the programme titles — not a caption of ours.
    const role = document.createElement("p");
    role.className = "cv-role";
    role.textContent = c.roles.join(" · ");
    names.appendChild(role);
  }
  head.append(medallion, names);
  root.appendChild(head);

  // Their years: one small cell each, carrying the by-year grid's two marks
  // (a dot: the exhibit plays that concert's recording; a hairline: the
  // current piece was on the programme). Marks, not buttons — see the header.
  const strip = document.createElement("div");
  strip.className = "cv-years";
  for (const concert of c.concerts) {
    const cell = document.createElement("span");
    cell.className = "cv-year";
    cell.dataset.year = String(concert.year);
    cell.textContent = String(concert.year);
    if ((concert.playable || []).length) cell.dataset.playable = "1";
    if (pieceId && concert.onProgramme?.includes(pieceId)) cell.dataset.programme = "1";
    strip.appendChild(cell);
  }
  root.appendChild(strip);

  // Every sitting the exhibit has a face for, when there is more than one.
  if (c.portraits.length > 1) {
    const sittings = document.createElement("div");
    sittings.className = "cv-sittings";
    for (const p of c.portraits) {
      const fig = document.createElement("figure");
      fig.className = "cv-sitting";
      fig.dataset.year = String(p.year);
      const img = document.createElement("img");
      img.alt = "";
      img.decoding = "async";
      img.src = portraitUrl(p.path);
      const cap = document.createElement("figcaption");
      cap.textContent = String(p.year);
      fig.append(img, cap);
      sittings.appendChild(fig);
    }
    root.appendChild(sittings);
  }

  // The way into the music: one button per recording of the current piece
  // from their concerts (the newest first, like the portrait).
  const playable = c.playable.filter((p) => p.piece === pieceId).slice().reverse();
  if (playable.length) {
    const foot = document.createElement("div");
    foot.className = "cv-foot";
    for (const p of playable) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "cv-listen";
      btn.dataset.file = p.file;
      btn.dataset.year = String(p.year);
      btn.textContent = t("conductors.listen", language)
        .replace("{piece}", pieceTitle)
        .replace("{year}", String(p.year));
      btn.addEventListener("click", () => onListen(p.file));
      foot.appendChild(btn);
    }
    root.appendChild(foot);
  }
}

/**
 * Make the roster fit its height. Eighteen conductors in two columns of nine
 * fit at the iPad geometry with room to spare (measured); the series gains a
 * conductor a year at most, so this steps the rows through two denser
 * treatments only when the grid genuinely overflows — the same measured
 * degrade as the programme list, for the same reason: a clipped roster would
 * lose its newest conductor invisibly.
 */
function fitRoster(root) {
  const STEPS = ["", "is-dense", "is-denser"];
  const overflows = () =>
    root.scrollHeight > root.clientHeight + 1 || root.scrollWidth > root.clientWidth + 1;
  const apply = () => {
    for (let i = 0; i < STEPS.length; i++) {
      root.classList.remove("is-dense", "is-denser");
      if (STEPS[i]) root.classList.add(STEPS[i]);
      if (!overflows()) return;
    }
    root.dataset.overflow = "1";
  };
  if (root.isConnected && root.clientHeight) apply();
  else requestAnimationFrame(apply);
}
