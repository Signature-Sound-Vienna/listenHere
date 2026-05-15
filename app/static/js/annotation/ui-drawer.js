// V6 annotation — side drawer.
//
// Header (title + View/Edit toggle + close) + Draw-mode toolbar (edit only)
// + scrollable body (delegates to ui-editor / ui-viewer) + sticky publish bar
// (placeholder in Phase B; wired in Phase E).

import * as state from "./state.js";
import * as uiState from "./ui-state.js";
import { el, clearChildren } from "./ui-common.js";
import { renderEditor } from "./ui-editor.js";
import { renderViewer } from "./ui-viewer.js";

export function mountDrawer(parent) {
  const drawer = el("aside", {
    class: "lh-v6-drawer",
    "aria-label": "Annotation editor",
  });

  const titleSpan = el("span", { class: "lh-v6-drawer-title", text: "Annotations" });
  const modeToggle = _modeToggle();
  const closeBtn = el("button", {
    class: "lh-v6-drawer-close",
    type: "button",
    title: "Close drawer",
    "aria-label": "Close drawer",
    text: "×",
    onclick: () => uiState.setDrawerOpen(false),
  });
  const header = el("div", { class: "lh-v6-drawer-header" }, [
    titleSpan,
    modeToggle,
    closeBtn,
  ]);

  const drawModeCheckbox = el("input", {
    type: "checkbox",
    class: "lh-v6-draw-mode-checkbox",
    checked: uiState.getDrawMode(),
    onchange: (e) => uiState.setDrawMode(e.target.checked),
  });
  const drawModeToolbar = el(
    "div",
    { class: "lh-v6-drawer-toolbar" },
    el("label", { class: "lh-v6-draw-mode-label" }, [
      drawModeCheckbox,
      " Draw mode (drag on a waveform to add a region)",
    ]),
  );

  const body = el("div", { class: "lh-v6-drawer-body" });

  const publishBar = el(
    "div",
    { class: "lh-v6-publish-bar" },
    el("span", {
      class: "lh-v6-publish-placeholder",
      text: "Save / Post-to-Solid wires up in Phase E.",
    }),
  );

  drawer.append(header, drawModeToolbar, body, publishBar);
  parent.appendChild(drawer);

  function render() {
    const ann = state.getById(state.getActiveId());
    drawer.classList.toggle("open", uiState.getDrawerOpen());
    drawer.classList.toggle("mode-edit", uiState.getMode() === "edit");
    drawer.classList.toggle("mode-view", uiState.getMode() === "view");
    drawer.classList.toggle("no-active", !ann);
    drawModeToolbar.style.display =
      uiState.getMode() === "edit" && ann ? "" : "none";
    drawModeCheckbox.checked = uiState.getDrawMode();
    modeToggle.querySelectorAll("button").forEach((b) => {
      b.classList.toggle("active", b.dataset.mode === uiState.getMode());
      b.disabled = !ann;
    });
    titleSpan.textContent = ann
      ? ann.label || "Untitled annotation"
      : "Annotations";

    // Always re-render the body. Chain-enforced sections (group notes,
    // comparisons) depend on text content of upstream sections, so we can't
    // short-circuit when only text changed. Focus + cursor are preserved
    // across rebuilds via data-v6-key (see _saveFocus / _restoreFocus).
    const saved = _saveFocus(body);
    clearChildren(body);
    if (!ann) {
      body.appendChild(
        el("div", {
          class: "lh-v6-empty",
          text:
            "Click + New annotation in the ribbon below to start, or select one to edit.",
        }),
      );
    } else {
      body.appendChild(
        uiState.getMode() === "edit" ? renderEditor(ann) : renderViewer(ann),
      );
    }
    _restoreFocus(body, saved);
  }

  state.subscribe(render);
  uiState.subscribe(render);
  render();
  return drawer;
}

function _modeToggle() {
  return el("div", { class: "lh-v6-mode-toggle", role: "tablist" }, [
    el("button", {
      class: "lh-v6-mode-btn",
      type: "button",
      dataset: { mode: "view" },
      text: "View",
      onclick: () => uiState.setMode("view"),
    }),
    el("button", {
      class: "lh-v6-mode-btn",
      type: "button",
      dataset: { mode: "edit" },
      text: "Edit",
      onclick: () => uiState.setMode("edit"),
    }),
  ]);
}

function _saveFocus(body) {
  const a = document.activeElement;
  if (!a || !body.contains(a)) return null;
  const key = a.getAttribute && a.getAttribute("data-v6-key");
  if (!key) return null;
  let selStart = null;
  let selEnd = null;
  try {
    selStart = a.selectionStart;
    selEnd = a.selectionEnd;
  } catch (_) {}
  return { key, selStart, selEnd };
}

function _restoreFocus(body, saved) {
  if (!saved) return;
  let safeKey;
  try {
    safeKey = CSS.escape(saved.key);
  } catch (_) {
    return;
  }
  const next = body.querySelector('[data-v6-key="' + safeKey + '"]');
  if (!next) return;
  try {
    next.focus();
    if (
      saved.selStart != null &&
      saved.selEnd != null &&
      typeof next.setSelectionRange === "function"
    ) {
      next.setSelectionRange(saved.selStart, saved.selEnd);
    }
  } catch (_) {}
}
