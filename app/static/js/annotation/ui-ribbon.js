// V6 annotation — bottom ribbon.
//
// Horizontal strip of annotation chips + filter + "+ New" button. Clicking a
// chip selects the annotation (does NOT auto-open the drawer per locked design).

import * as state from "./state.js";
import * as uiState from "./ui-state.js";
import { el, clearChildren } from "./ui-common.js";
import { getActiveGroupingSnapshot } from "../listen.js";

export function mountRibbon(parent) {
  const filterInput = el("input", {
    type: "text",
    class: "lh-v6-ribbon-filter",
    placeholder: "Filter…",
    "aria-label": "Filter annotations",
    oninput: () => render(),
  });

  const chips = el("div", { class: "lh-v6-ribbon-chips" });

  const newBtn = el("button", {
    class: "lh-v6-ribbon-new",
    type: "button",
    text: "+ New",
    title: "Create new annotation",
    onclick: () => {
      const pinnedGrouping = getActiveGroupingSnapshot();
      const id = state.createAnnotation({ pinnedGrouping });
      uiState.setDrawerOpen(true);
      uiState.setMode("edit");
      state.setActiveAnnotation(id);
    },
  });

  const ribbon = el(
    "div",
    { class: "lh-v6-ribbon", role: "toolbar", "aria-label": "Annotations" },
    [
      el("span", {
        class: "lh-v6-ribbon-label",
        text: "Annotations",
      }),
      filterInput,
      chips,
      newBtn,
    ],
  );
  parent.appendChild(ribbon);

  function render() {
    clearChildren(chips);
    const all = state.getAll();
    const q = filterInput.value.trim().toLowerCase();
    const filtered = q
      ? all.filter((a) => (a.label || "").toLowerCase().includes(q))
      : all;
    if (filtered.length === 0) {
      chips.appendChild(
        el("span", {
          class: "lh-v6-ribbon-empty",
          text: q ? "No matches." : "No annotations yet.",
        }),
      );
      return;
    }
    filtered.forEach((a) => chips.appendChild(_chip(a)));
  }

  function _chip(a) {
    const isActive = a.id === state.getActiveId();
    return el(
      "button",
      {
        class: "lh-v6-chip" + (isActive ? " active" : ""),
        type: "button",
        title: a.label || "Untitled annotation",
        onclick: () => state.setActiveAnnotation(a.id),
      },
      [
        el("span", {
          class: "lh-v6-chip-swatch",
          style: { background: a.color },
        }),
        el("span", {
          class: "lh-v6-chip-label",
          text: a.label || "Untitled",
        }),
        // Per-annotation unsaved-dot intentionally omitted: dirty state is
        // shown centrally on the "Save data" button (managed by listen.js).
        a.published
          ? el("span", {
              class: "lh-v6-chip-tick",
              text: "✓",
              title: "Posted to Solid",
              "aria-label": "Posted to Solid",
            })
          : null,
      ],
    );
  }

  state.subscribe(render);
  render();
  return ribbon;
}
