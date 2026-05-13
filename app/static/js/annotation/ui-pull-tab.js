// V6 annotation — drawer pull-tab button.
//
// Injected as a third button into the existing right-edge `.drawer-btns`
// column (alongside Settings and Solid), matching the established Listen
// Here affordance pattern. Click toggles the V6 drawer open / closed.

import * as uiState from "./ui-state.js";
import { el } from "./ui-common.js";

const PENCIL_SVG =
  '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
  ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M16.5 3.5l4 4-13 13H3.5v-4l13-13z"/><path d="M14 6l4 4"/></svg>';

export function mountPullTab() {
  const container = document.querySelector(".drawer-btns");
  if (!container) {
    console.warn(
      "[annotation/v6] .drawer-btns not found; pull-tab not mounted.",
    );
    return null;
  }
  const btn = el("button", {
    id: "v6-annotation-drawer-btn",
    class: "lh-v6-pull-tab",
    type: "button",
    title: "Toggle annotation editor",
    "aria-label": "Toggle annotation editor",
    onclick: () => uiState.setDrawerOpen(!uiState.getDrawerOpen()),
    html: PENCIL_SVG,
  });
  container.appendChild(btn);
  const sync = () => btn.classList.toggle("open", uiState.getDrawerOpen());
  uiState.subscribe(sync);
  sync();
  return btn;
}
