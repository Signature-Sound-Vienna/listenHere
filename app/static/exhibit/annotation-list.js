// exhibit/annotation-list.js
//
// The per-viewport commentary panel: the current audience's annotations as
// chips, the focused one's commentary, and its GROUP NOTES — the authored
// comparison ("the VPO leaves the bell alone; every other orchestra doubles
// it") that the strip-edge colours are otherwise asking the visitor to guess.
// Read-only, like everything in the exhibit.
//
// This is week 2's real panel, replacing the week-1 stand-in (a chip row and
// one paragraph). Two constraints shaped it, and both are layout constraints
// before they are visual ones:
//
//  * NOTHING MAY MOVE. The panel absorbs the viewport's remaining height
//    (flex: 1 in exhibit.css) so focusing an annotation changes what is inside
//    the panel, never the position of the strips above it — the same rule as
//    .vp-status and the middle-band slot. The week-1 stand-in actually violated
//    this: its min-height reserved two lines and "Die Glocke" is six.
//  * THE TEXT IS LONGER THAN THE SPACE. Expert commentary runs to 1640
//    characters (measured), and no fixed panel on a halved portrait screen can
//    show that. So the detail area scrolls INTERNALLY — the one deliberate
//    scroll container in the kiosk, finger-paginated, with overscroll contained
//    so a swipe past the end cannot rubber-band the screen. The alternative was
//    clamping with an ellipsis, which silently hides authored content; a museum
//    label that cannot be read to the end is an editorial decision, not a CSS
//    default.
//
// Focus is what makes grouping legible. Each annotation pins its OWN grouping —
// "Die Glocke" pins VPO versus Other Orchestras — so a grouping only means
// something relative to an annotation, which is exactly the context
// `grouping-core`'s read model is defined over. The group cards here are the
// LEGEND for the strip-edge colours main.js paints: same annotation, same
// groups, same `safeColor`, so the card and the edge cannot disagree.
//
// Authored text goes through `resolveText`, never a bare property read: the
// payload carries language maps on every visitor-visible string so that German
// drops in without touching this file (plan §6.6).

import { resolveText, t } from "./strings.js";
import { resolveGroupFor, safeColor, groupTextColor } from "../js/engine/grouping-core.js";

/**
 * @param {object} opts
 * @param {number} opts.viewport
 * @param {string} opts.language          resolved per viewport, so passed in
 * @param {(annId: string|null) => void} opts.onFocus
 * @returns {{el: HTMLElement, update: (annotations: object[], focusedId: string|null) => void}}
 */
export function createAnnotationList({ viewport, language, onFocus }) {
  const el = document.createElement("div");
  el.className = "ann-panel";
  el.dataset.viewport = String(viewport);

  const chips = document.createElement("div");
  chips.className = "ann-chips";
  const body = document.createElement("div");
  body.className = "ann-body";
  const detail = document.createElement("p");
  detail.className = "ann-detail";
  const groups = document.createElement("div");
  groups.className = "ann-groups";
  body.append(detail, groups);
  el.append(chips, body);

  function update(annotations, focusedId) {
    chips.textContent = "";
    for (const ann of annotations) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "ann-chip";
      chip.dataset.ann = ann.id;
      chip.textContent = resolveText(ann.label, { language });
      const colour = safeColor(ann.color);
      if (colour) chip.style.borderColor = colour;
      const on = ann.id === focusedId;
      chip.classList.toggle("is-on", on);
      chip.setAttribute("aria-pressed", on ? "true" : "false");
      if (on && colour) {
        chip.style.backgroundColor = colour;
        chip.style.color = groupTextColor(colour);
      }
      // A second tap on the focused chip clears focus, so a visitor can get back
      // to the plain waveforms without hunting for a close button.
      chip.addEventListener("click", () => onFocus(on ? null : ann.id));
      chips.appendChild(chip);
    }

    const focused = annotations.find((a) => a.id === focusedId) || null;
    if (!annotations.length) {
      detail.textContent = t("state.nothingForAudience", language);
      detail.dataset.state = "empty";
    } else if (focused) {
      detail.textContent = resolveText(focused.description, { language });
      delete detail.dataset.state;
    } else {
      detail.textContent = t("listen.tapToListen", language);
      detail.dataset.state = "hint";
    }
    // A new annotation's text starts at its beginning, not wherever the last
    // reader left the previous one.
    detail.scrollTop = 0;

    renderGroups(focused);
  }

  /**
   * The focused annotation's groups as cards: the group's name, tinted with the
   * SAME resolved colour main.js paints on the strip edges, plus the authored
   * group note when the annotation carries one (`groupNotes` is keyed by
   * groupId). Name-only cards still earn their place — they are the legend that
   * says what the coloured edges mean — but a lone unnamed default group says
   * nothing a visitor can use, so it renders no card at all.
   */
  function renderGroups(focused) {
    groups.textContent = "";
    const list = focused?.grouping?.groups || [];
    const cards = list
      .map((g) => ({
        name: resolveText(g.label, { language }),
        note: resolveText(focused.groupNotes?.[g.groupId], { language }),
        colour: safeColor(g.color),
      }))
      .filter((c) => c.name || c.note);
    el.dataset.hasGroups = cards.length ? "1" : "";
    for (const c of cards) {
      const card = document.createElement("div");
      card.className = "ann-group-card";
      if (c.colour) {
        card.style.backgroundColor = c.colour;
        // Composited text colour, not a hardcoded dark: the palette is authored
        // in the payload, and pale-card-illegible-text is a bug this codebase
        // has already shipped once (spec 9.16).
        card.style.color = groupTextColor(c.colour);
      }
      const name = document.createElement("span");
      name.className = "ann-group-name";
      name.textContent = c.name;
      card.appendChild(name);
      if (c.note) {
        const note = document.createElement("span");
        note.className = "ann-group-note";
        note.textContent = c.note;
        card.appendChild(note);
      }
      groups.appendChild(card);
    }
  }

  update([], null);
  return { el, update };
}

/**
 * The group owning `file` within one annotation's pinned grouping, or null.
 *
 * A one-line pass-through to `grouping-core`, and that is the point: the exhibit is
 * the second host of that read model, and if it answered "which group?" its own way
 * the two codebases would disagree about which recordings an annotation is about —
 * the exact failure `resolveGroupFor` was extracted to prevent (roadmap item U).
 *
 * NOTE ON THE OTHER CONTEXT: `grouping-core` answers this question over two kinds
 * of grouping context, an active TAB and an annotation's PINNED grouping. The
 * exhibit only ever has the second. The prepped payload carries no
 * `header.groupingTabs` at all — there is no authoring session and so no active tab
 * — so `getActiveFileGroups()` would correctly return nothing here, and asking it
 * would be asking the wrong question rather than getting a wrong answer.
 */
export function groupForFileIn(annotation, file) {
  return resolveGroupFor(file, annotation?.grouping?.groups || []);
}
