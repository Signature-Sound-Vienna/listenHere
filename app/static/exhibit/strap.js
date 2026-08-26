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

/**
 * Mount one viewport's strap.
 *
 * @param {HTMLElement} parent   the viewport's `.strips` container
 * @param {object} opts
 * @param {string[]} opts.files                     recordings, in strip order
 * @param {(file: string) => string} opts.labelFor  the short button text
 * @param {(file: string) => string} opts.titleFor  the accessible full name
 * @param {(file: string) => void} opts.onPick      the aligned switch
 * @returns {{el: HTMLElement, setActive(file: string|null): void}}
 */
export function createStrap(parent, { files, labelFor, titleFor, onPick }) {
  const el = document.createElement("div");
  el.className = "vp-strap";
  const buttons = new Map();
  for (const file of files) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "strap-btn";
    btn.dataset.file = file;
    btn.textContent = labelFor(file);
    btn.setAttribute("aria-label", titleFor(file));
    btn.addEventListener("click", () => onPick(file));
    el.appendChild(btn);
    buttons.set(file, btn);
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
