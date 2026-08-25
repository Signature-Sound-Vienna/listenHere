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
 * @param {boolean} [opts.split]  the side-slot arrangement: the BODY (text +
 *   group story) lives elsewhere — main.js moves `bodyEl` into the side panel
 *   — so states the body normally reports while nothing is focused would be
 *   invisible there. Under split, the empty-audience message renders in the
 *   chips row instead, and the idle hint is simply dropped: bare chips under
 *   full-width waveforms ARE the resting state.
 * @param {(annId: string) => void} opts.onChipTap  every chip tap, with its
 *   annotation id — including taps on the already-focused chip. What a tap
 *   MEANS (focus toggle below the strips; the panel state machine in the side
 *   slot) is the caller's decision, because it depends on the layout, and this
 *   component deliberately does not know which layout it is in.
 * @returns {{el: HTMLElement, chipsEl: HTMLElement, bodyEl: HTMLElement,
 *   update: (annotations: object[], focus: object|null, opts?: object) => void}}
 */
export function createAnnotationList({ viewport, language, onChipTap, split = false }) {
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

  // Chips are RECONCILED, not rebuilt. A render that keeps the same annotation
  // list — every focus change, every resize re-derivation, every zoom change,
  // and (in ?focus=playhead) every wash entry — must update the existing
  // elements in place, because replacing a chip between a finger's down and its
  // up makes the click event fire on the row (the common ancestor of the two
  // targets) instead of on any chip, and the tap is silently eaten. That is a
  // museum-floor bug, not a test nicety — found via its Playwright shadow
  // (specs 35.22/37.6 flaking on Firefox under load, 2026-08-25, where the
  // boot-settling resize re-render raced the synthetic tap the same way).
  // Only a CHANGED list (an audience switch) rebuilds the row, and there a
  // racing tap's target legitimately vanished with the list it belonged to.
  const chipById = new Map();
  let lastShownId = null;

  /**
   * @param {object[]} annotations
   * @param {object|null} focus  the caller's focus state, per the agreed
   *   definition (2026-08-25) — two surfaces, three chip states:
   *   `paintIds` are the annotations whose strip-side paint is on (the wash —
   *   the union at overlaps — or the pin): their chips get the strong
   *   `is-on`. `shownId` is the annotation whose commentary shows: with
   *   `pinned` its chip adds `is-pinned` (an explicit hold looks held, not
   *   merely washed); unpinned and no longer painted, it gets the subtle
   *   `is-shown` — the anchor tying the lingering text back to its chip after
   *   the wash has moved on.
   * @param {string[]} [focus.paintIds]
   * @param {string|null} [focus.shownId]
   * @param {boolean} [focus.pinned]
   * @param {object} [opts]
   * @param {boolean} [opts.markAudience]  tag each chip with the audience its
   *   annotation targets — the union mode's job (?audienceAll=1), where the
   *   switch position no longer implies it. A marker, not a second line: the
   *   audience name in the chip's own type, smaller and dimmed, after the
   *   label. Whether that stays legible without cluttering the chips is
   *   exactly what the Oct/Nov user testing is for.
   */
  function update(annotations, focus, { markAudience = false } = {}) {
    const { paintIds = [], shownId = null, pinned = false } = focus || {};
    const sameList =
      annotations.length > 0 &&
      chips.children.length === annotations.length &&
      annotations.every((a, i) => chips.children[i]?.dataset?.ann === a.id);
    if (!sameList) {
      chips.textContent = "";
      chipById.clear();
      // Under split the body may be hidden while nothing is focused, so the
      // one state a visitor must not miss — this audience has nothing at all —
      // is said where the chips would have been.
      if (split && !annotations.length) {
        const empty = document.createElement("span");
        empty.className = "ann-chips-empty";
        empty.textContent = t("state.nothingForAudience", language);
        chips.appendChild(empty);
      }
      for (const ann of annotations) {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "ann-chip";
        chip.dataset.ann = ann.id;
        // The label lives in its own span so in-place updates can never wipe
        // the audience marker beside it.
        const label = document.createElement("span");
        label.className = "ann-chip-label";
        chip.appendChild(label);
        // Every tap is reported with its id, the focused chip's included — the
        // caller decides what it means (see the opts.onChipTap note above).
        chip.addEventListener("click", () => onChipTap(ann.id));
        chipById.set(ann.id, chip);
        chips.appendChild(chip);
      }
    }
    for (const ann of annotations) {
      const chip = chipById.get(ann.id);
      chip.firstChild.textContent = resolveText(ann.label, { language });
      let mark = chip.querySelector(".ann-chip-audience");
      if (markAudience && ann.audience) {
        if (!mark) {
          mark = document.createElement("span");
          mark.className = "ann-chip-audience";
          chip.appendChild(mark);
        }
        // The same catalogue lookup as the switch buttons, so the marker and
        // the button a visitor just left can never disagree about a name.
        mark.textContent = t("audience." + ann.audience, language);
      } else if (mark) {
        mark.remove();
      }
      const colour = safeColor(ann.color);
      chip.style.borderColor = colour || "";
      const on = paintIds.includes(ann.id);
      chip.classList.toggle("is-on", on);
      chip.classList.toggle("is-pinned", pinned && ann.id === shownId);
      chip.classList.toggle("is-shown", !pinned && ann.id === shownId && !on);
      chip.setAttribute("aria-pressed", on ? "true" : "false");
      chip.style.backgroundColor = on && colour ? colour : "";
      chip.style.color = on && colour ? groupTextColor(colour) : "";
    }

    // The detail is the STICKY surface: it reads shownId, not paintId, so the
    // text (and its group cards below) outlives a wash that has cleared.
    const shown = annotations.find((a) => a.id === shownId) || null;
    if (!annotations.length) {
      detail.textContent = t("state.nothingForAudience", language);
      detail.dataset.state = "empty";
    } else if (shown) {
      detail.textContent = resolveText(shown.description, { language });
      delete detail.dataset.state;
    } else {
      detail.textContent = t("listen.tapToListen", language);
      detail.dataset.state = "hint";
    }
    // A NEW annotation's text starts at its beginning, not wherever the last
    // reader left the previous one — but only on an actual change of what is
    // shown: a re-render of the same text (a resize re-derivation, a zoom
    // step, a wash clearing around it) must not yank a mid-read text back to
    // the top.
    if (shownId !== lastShownId) detail.scrollTop = 0;
    lastShownId = shownId;

    renderGroups(shown);
  }

  /**
   * The SHOWN annotation's groups as cards: the group's name, tinted with the
   * SAME resolved colour main.js paints on the strip edges, plus the authored
   * group note when the annotation carries one (`groupNotes` is keyed by
   * groupId). Rendered ONLY when the annotation actually has something to say
   * about its groups (hasGroupStory) — a bare legend of names like "New Group"
   * and "Ungrouped" is authoring scaffolding, not content, and user feedback
   * (2026-08-24) ruled it noise. main.js applies the same predicate to the
   * strip edges. While the annotation paints (a pin, or the wash inside its
   * region) card and edge cannot disagree — same annotation, same groups, same
   * safeColor; under focusWash=clear the cards may honestly OUTLIVE the edges
   * while lingering text waits for the next wash (agreed 2026-08-25).
   */
  function renderGroups(focused) {
    groups.textContent = "";
    const list = hasGroupStory(focused) ? focused.grouping.groups : [];
    const cards = list
      .map((g) => ({
        name: resolveText(g.label, { language }),
        note: resolveText(focused.groupNotes?.[g.groupId], { language }),
        colour: safeColor(g.color),
      }))
      .filter((c) => c.name || c.note);
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

    // Between-group comparisons, below the per-group cards. Endpoints resolve
    // through the grouping's stable groupIds — labels are display-only, the
    // same identity rule as the authoring tool.
    let count = cards.length;
    if (list.length) {
      const byId = new Map(list.map((g) => [g.groupId, g]));
      const groupName = (gid) =>
        resolveText(byId.get(gid)?.label, { language }) || String(gid ?? "");
      for (const cmp of focused.comparisons || []) {
        const text = resolveText(cmp.text, { language });
        if (!text) continue;
        const card = document.createElement("div");
        card.className = "ann-comparison-card";
        const names = document.createElement("span");
        names.className = "ann-cmp-names";
        names.textContent = `${groupName(cmp.leftGroupId)} ↔ ${groupName(cmp.rightGroupId)}`;
        const body = document.createElement("span");
        body.className = "ann-group-note";
        body.textContent = text;
        card.append(names, body);
        groups.appendChild(card);
        count++;
      }
    }
    // On the body as well as the panel: the CSS visibility rule follows the
    // body (which the split layout moves into the side panel), while the
    // panel's copy stays for anything probing the component from outside.
    el.dataset.hasGroups = count ? "1" : "";
    body.dataset.hasGroups = count ? "1" : "";
  }

  update([], null);
  // chipsEl and bodyEl are the two mountable halves: below the strips they
  // stay together inside `el`; the side-slot layout moves bodyEl into the
  // panel while chipsEl (inside `el`) keeps the below-content row.
  return { el, chipsEl: chips, bodyEl: body, update };
}

/** A non-empty authored text value — plain string or language map. */
function _hasText(v) {
  if (typeof v === "string") return v.trim() !== "";
  if (v && typeof v === "object")
    return Object.values(v).some((s) => typeof s === "string" && s.trim() !== "");
  return false;
}

/**
 * Does this annotation have anything to SAY about its groups — at least one
 * non-empty group note, or a between-group comparison (the authoring tool's
 * `comparisons` field; none authored yet as of 2026-08-24, but the pipeline
 * carries them)? Grouping structure alone (names, membership) is not a story:
 * every authored annotation carries a grouping, usually the default
 * everyone-in-one-group, and painting legends for those tells a visitor
 * nothing.
 *
 * @param {object|null} ann
 * @returns {boolean}
 */
export function hasGroupStory(ann) {
  if (!ann?.grouping?.groups?.length) return false;
  if (Object.values(ann.groupNotes || {}).some(_hasText)) return true;
  return (ann.comparisons || []).some((c) => _hasText(c.text));
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
