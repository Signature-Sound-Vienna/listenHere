// exhibit/explorer-shell.js
//
// The explorers' two layouts (roadmap 29). Each explorer is a CHOOSER (the year
// grid, the conductor roster) and a CARD (one concert's or one conductor's
// detail, with the portrait credit at its foot). Where they live is not the
// explorer's business, so this shell builds the roots and the explorer fills
// them:
//
//   * "overlay" — today's interface and the default (`?explorers=overlay`): ONE
//     root, `.vp-view`, drawn over the half, holding heading, chooser, card, and
//     credit as siblings of its CSS grid. The DOM is exactly what it was before
//     the split existed, so the overlay's specs (45, 46) are the regression gate.
//   * "split" — the explorer zone (`?explorers=zone`): TWO roots. `.vp-chooser`
//     goes into the always-visible zone above the strips; `.vp-card` into the
//     side slot, beside the waveforms (the user's ruling: zone = chooser, side
//     slot = card). There is no heading, because the zone's tabs name the view.
//
// Both roots of a split explorer carry the same `data-view` and `data-viewport`
// as the overlay's one, so styles and tests can key on either.

import { pulseStoryHint } from "./dyk.js";

/**
 * @param {object} opts
 * @param {"years"|"conductors"} opts.view
 * @param {number} opts.viewport
 * @param {"overlay"|"split"} [opts.layout]
 */
export function createExplorerShell({ view, viewport, layout = "overlay" }) {
  const root = (className) => {
    const el = document.createElement("div");
    el.className = className;
    el.dataset.view = view;
    el.dataset.viewport = String(viewport);
    return el;
  };

  if (layout !== "split") {
    const el = root("vp-view");
    return {
      el,
      chooserEl: null,
      cardEl: null,
      roots: [el],
      /** Heading, chooser, then the card's parts — the overlay grid's order. */
      mount: ({ heading, chooser, card }) => el.append(heading, chooser, ...card),
      /** A degraded explorer: the message where the panes would be, the credit below. */
      mountUnavailable: (msg, about) => el.append(msg, about),
    };
  }

  const chooserEl = root("vp-chooser");
  const cardEl = root("vp-card");
  return {
    el: null,
    chooserEl,
    cardEl,
    roots: [chooserEl, cardEl],
    mount: ({ chooser, card }) => {
      chooserEl.append(chooser);
      cardEl.append(...card);
    },
    mountUnavailable: (msg, about) => {
      chooserEl.append(msg);
      cardEl.append(about);
    },
  };
}

/**
 * Say what an audience switch was FOR (dyk.js pulseStoryHint) on every root:
 * the marked cells live in the chooser and the story's heading in the card, and
 * in the split layout those are two elements rather than one.
 */
export function pulseShellHint(shell) {
  for (const r of shell.roots) pulseStoryHint(r);
}

/** Detach every root (a cached explorer is rebuilt, never re-parented, on destroy). */
export function removeShell(shell) {
  for (const r of shell.roots) r.remove();
}
