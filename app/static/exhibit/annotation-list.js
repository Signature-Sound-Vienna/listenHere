// exhibit/annotation-list.js
//
// The per-viewport list of the current audience's annotations, and the commentary
// for whichever one is focused. Read-only, like everything in the exhibit.
//
// SCOPE, stated so it is not mistaken for the finished thing: this is the MINIMAL
// version. Week 2 owns the real commentary panel plus group notes and comparisons
// (plan §4.2); what is here is a row of chips and one paragraph. It exists in week
// 1 for two reasons that are not cosmetic:
//
//  * The audience filter has to be *visible* to be believable. Switching from Kids
//    to Scholars changes which regions are drawn, and faint translucent rectangles
//    moving on eight strips is not a demonstration that the filter works.
//  * Focus is what makes grouping legible. Each annotation pins its OWN grouping —
//    "Die Glocke" pins VPO versus Other Orchestras — so a grouping only means
//    something relative to an annotation, which is exactly the context
//    `grouping-core`'s read model is defined over. Nothing here re-implements that
//    question; it asks `resolveGroupFor` and paints the answer.
//
// Authored text goes through `resolveText`, never a bare property read: the payload
// carries language maps on every visitor-visible string so that German drops in
// without touching this file (plan §6.6).

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
  const detail = document.createElement("p");
  detail.className = "ann-detail";
  el.append(chips, detail);

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
  }

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
