// V6 annotation — drawer body in VIEW (read-only) mode.
//
// Phase B scope: title swatch + description. Other sections in Phase D.

import { el } from "./ui-common.js";

export function renderViewer(ann) {
  const root = el("div", { class: "lh-v6-viewer" });
  const title = el("div", { class: "lh-v6-viewer-title" }, [
    el("span", {
      class: "lh-v6-color-swatch",
      style: { background: ann.color },
      "aria-hidden": "true",
    }),
    el("span", {
      class: "lh-v6-viewer-title-text",
      text: ann.label || "Untitled annotation",
    }),
  ]);
  root.appendChild(title);
  if (ann.description) {
    root.appendChild(
      el("p", { class: "lh-v6-viewer-description", text: ann.description }),
    );
  } else {
    root.appendChild(
      el("p", {
        class: "lh-v6-viewer-description lh-v6-empty-hint",
        text: "No description yet.",
      }),
    );
  }
  return root;
}
