// exhibit/strap.js
//
// The switch strap (?tapMode=direct — alpha-tester feedback, 2026-08-26).
//
// In the shipped tap mode, tapping another waveform switches to it and CARRIES
// the musical moment across through the alignment, deliberately ignoring the
// tap's x-position (spec 34.8). Testers who have not lived with the interface
// read that as a miss: they expected the tap to land where their finger did.
// Direct mode takes the tap literally on both axes — switch AND seek — which
// removes the aligned switch from the strips entirely. This strap is where it
// moves: one button per recording, beside its own waveform, doing exactly what
// a strip tap used to do. The buttons will eventually carry excerpts of the
// gen-AI conductor portraits (plan §5.5); until those exist they show
// conductor initials and the year — proper names and numerals, the two things
// that need no translation (the stripLabel argument, plan §6.3).
//
// The strap is absolutely positioned inside the strips container's reserved
// left padding (exhibit.css), so mounting it never re-measures a waveform, and
// its rows copy the strip stack's own height and gap, so each button sits
// exactly beside the strip it switches to. Styling is the theme's business:
// the optional --ex-strap-bg token gives parchment its leather.

// The nav arrows' shape: a chunky pentagon arrow (up), stretched along the
// direction it points, the second path the stitching. The stitch is a TRUE
// parallel offset of the outline (each edge moved inward by 3 units, corners
// re-intersected by hand), not a scale of it — scaling insets proportionally
// to the distance from the centre, so the gap gapes at the tip and pinches at
// the near edges. Inline SVG because a dashed CSS border cannot follow an
// arrow outline; colours come from the theme tokens via classed paths.
const ARROW_SVG =
  "<svg viewBox='0 0 48 56' aria-hidden='true'>" +
  "<path class='arrow-fill' d='M24 3 L45 26 L34 26 L34 53 L14 53 L14 26 L3 26 Z'/>" +
  "<path class='arrow-stitch' d='M24 7.5 L38.2 23 L31 23 L31 50 L17 50 L17 23 L9.8 23 Z'/>" +
  "</svg>";

/**
 * Mount one viewport's strap.
 *
 * @param {HTMLElement} parent   the viewport's `.strips` container
 * @param {object} opts
 * @param {string[]} opts.files                     recordings, in strip order
 * @param {(file: string) => string} opts.labelFor  the short button text
 * @param {(file: string) => string} opts.titleFor  the accessible full name
 * @param {(file: string) => string} [opts.portraitFor]  the recording's Gen-AI
 *   portrait URL, or "" — the medallion the initials were standing in for
 *   (plan §5.5; first batch 2026-09-01). The disc is the button's ::before, so
 *   the image arrives as a custom property rather than as an element
 * @param {(file: string) => void} opts.onPick      the aligned switch
 * @param {(delta: number) => void} [opts.onNav]    step to the adjacent strip
 *   (−1 up, +1 down), the aligned switch again — mounts the arrow buttons
 * @param {{up: string, down: string}} [opts.navLabels]  their accessible names
 * @returns {{el: HTMLElement, setActive(file: string|null): void}}
 */
export function createStrap(
  parent,
  { files, labelFor, titleFor, portraitFor, onPick, onNav, navLabels },
) {
  const el = document.createElement("div");
  el.className = "vp-strap";
  const buttons = new Map();
  for (const file of files) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "strap-btn";
    btn.dataset.file = file;
    // Each word of the label as its own span, so "HvK ’87" stacks into two
    // lines on the medallion. The separating text nodes keep textContent equal
    // to the label verbatim; as whitespace-only anonymous flex items they are
    // never rendered, so the layout sees only the spans.
    const words = labelFor(file).split(" ");
    words.forEach((word, i) => {
      if (i) btn.appendChild(document.createTextNode(" "));
      const line = document.createElement("span");
      line.textContent = word;
      btn.appendChild(line);
    });
    // THE PORTRAIT, where one exists. The disc a strap button wears is its
    // ::before, so the image cannot be an element and arrives as a custom
    // property the CSS reads. The initials stay IN THE DOM, hidden — they are
    // this button's written identity, the `aria-label` above is what a screen
    // reader gets either way, and a recording with no portrait yet (most of
    // them, for months) simply keeps showing them.
    const portrait = portraitFor?.(file);
    if (portrait) {
      btn.style.setProperty("--strap-portrait", `url("${encodeURI(portrait)}")`);
      btn.classList.add("has-portrait");
    }
    btn.setAttribute("aria-label", titleFor(file));
    btn.addEventListener("click", () => onPick(file));
    el.appendChild(btn);
    buttons.set(file, btn);
  }
  // The arrow medallions: above the top medallion and below the bottom one,
  // anchored to the rail's ends (absolute, so the rows keep their exact
  // strip alignment), stepping to the adjacent recording along the alignment.
  if (onNav) {
    for (const [dir, delta] of [["up", -1], ["down", 1]]) {
      const nav = document.createElement("button");
      nav.type = "button";
      nav.className = `strap-nav strap-nav-${dir}`;
      nav.innerHTML = ARROW_SVG;
      nav.setAttribute("aria-label", navLabels?.[dir] ?? dir);
      nav.addEventListener("click", () => onNav(delta));
      el.appendChild(nav);
    }
  }
  parent.appendChild(el);
  return {
    el,
    /** Mirror the audible recording, the strap's copy of strip.setActive. */
    setActive(file) {
      for (const [f, btn] of buttons) btn.classList.toggle("is-active", f === file);
    },
  };
}
