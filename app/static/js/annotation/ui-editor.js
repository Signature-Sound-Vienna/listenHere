// V6 annotation — drawer body in EDIT mode.
//
// Phase B scope: Identity (color + title + delete) and Description sections.
// Group notes, comparisons, and Recordings land in Phase D.

import * as state from "./state.js";
import { el } from "./ui-common.js";

export function renderEditor(ann) {
  const root = el("div", { class: "lh-v6-editor" });
  root.appendChild(_identitySection(ann));
  root.appendChild(_descriptionSection(ann));
  root.appendChild(
    el("div", {
      class: "lh-v6-editor-placeholder",
      text:
        "Recordings, group notes, and comparisons appear here once Phase D lands.",
    }),
  );
  return root;
}

function _identitySection(ann) {
  const sec = el("section", { class: "lh-v6-section lh-v6-section-identity" });
  sec.appendChild(
    el("h3", { class: "lh-v6-section-title", text: "Identity" }),
  );
  const row = el("div", { class: "lh-v6-identity-row" }, [
    el("input", {
      type: "color",
      class: "lh-v6-color-picker",
      title: "Annotation color",
      value: ann.color,
      oninput: (e) =>
        state.updateAnnotationField(ann.id, "color", e.target.value),
    }),
    el("input", {
      type: "text",
      class: "lh-v6-title-input",
      placeholder: "Annotation title",
      value: ann.label,
      oninput: (e) =>
        state.updateAnnotationField(ann.id, "label", e.target.value),
    }),
    el("button", {
      class: "lh-v6-delete-btn",
      type: "button",
      title: "Delete annotation",
      "aria-label": "Delete annotation",
      text: "×",
      onclick: () => {
        if (window.confirm("Delete this annotation?"))
          state.removeAnnotation(ann.id);
      },
    }),
  ]);
  sec.appendChild(row);
  return sec;
}

function _descriptionSection(ann) {
  const sec = el("section", { class: "lh-v6-section" });
  sec.appendChild(
    el("h3", { class: "lh-v6-section-title", text: "Description" }),
  );
  sec.appendChild(
    el("textarea", {
      class: "lh-v6-description-textarea",
      placeholder: "Overall description — what this annotation is about.",
      rows: "4",
      value: ann.description,
      oninput: (e) =>
        state.updateAnnotationField(ann.id, "description", e.target.value),
    }),
  );
  return sec;
}
