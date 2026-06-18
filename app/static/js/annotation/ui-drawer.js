// V6 annotation — side drawer.
//
// Header (title + View/Edit toggle + close) + Draw-mode toolbar (edit only)
// + scrollable body (delegates to ui-editor / ui-viewer) + sticky publish bar
// (placeholder in Phase B; wired in Phase E).

import * as state from "./state.js";
import * as uiState from "./ui-state.js";
import { el, clearChildren, bouncingDots, confirmDeleteFromPod } from "./ui-common.js";
import { renderEditor } from "./ui-editor.js";
import { renderViewer } from "./ui-viewer.js";
import {
  postAnnotationToSolid,
  updateAnnotationOnSolid,
} from "./solid-post.js";
import { deleteAnnotationFromPod } from "./solid-load.js";
import { solid, loginAndFetch, solidLogout } from "../solid.js";
import { getAudioLinkedDataUri } from "../listen.js";

export function mountDrawer(parent) {
  const drawer = el("aside", {
    class: "lh-v6-drawer",
    "aria-label": "Annotation editor",
  });

  const titleSpan = el("span", { class: "lh-v6-drawer-title", text: "Annotations" });
  const modeToggle = _modeToggle();
  const trashBtn = el("button", {
    class: "lh-v6-drawer-trash",
    type: "button",
    title: "Delete this annotation from your Solid pod",
    "aria-label": "Delete from pod",
    text: "🗑",
    onclick: () => _onTrashClick(),
  });
  const unloadBtn = el("button", {
    class: "lh-v6-drawer-unload",
    type: "button",
    title: "Unload this annotation from the session (the pod copy is preserved)",
    "aria-label": "Unload annotation",
    text: "×",
    onclick: () => _onUnloadClick(),
  });
  const header = el("div", { class: "lh-v6-drawer-header" }, [
    titleSpan,
    modeToggle,
    trashBtn,
    unloadBtn,
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

  const publishBar = el("div", { class: "lh-v6-publish-bar" });

  // Sticky footer: Solid auth status + login/logout controls. Lives
  // outside the body so it stays visible while editing.
  const solidFooter = el("div", { class: "lh-v6-drawer-solid" });

  drawer.append(header, drawModeToolbar, body, publishBar, solidFooter);
  parent.appendChild(drawer);

  function _onUnloadClick() {
    const ann = state.getById(state.getActiveId());
    if (!ann) return;
    if (ann.hasUnsavedChanges) {
      const ok = window.confirm(
        "Discard unsaved changes to “" +
          (ann.label || "this annotation") +
          "”?\n\nThe annotation will be removed from this session. " +
          "If it was posted to your Solid pod, the pod copy is preserved.",
      );
      if (!ok) return;
    }
    state.removeAnnotation(ann.id);
  }

  async function _onTrashClick() {
    const ann = state.getById(state.getActiveId());
    if (!ann) return;
    const mmUri = ann.lastPostedUris && ann.lastPostedUris.mm;
    if (!mmUri) {
      // Not published — fall back to a plain unload (with confirm if dirty).
      _onUnloadClick();
      return;
    }
    const ok = await confirmDeleteFromPod(ann.label || mmUri);
    if (!ok) return;
    try {
      await deleteAnnotationFromPod(mmUri);
      // deleteAnnotationFromPod already removes the matching local copy.
    } catch (err) {
      window.alert(
        "Couldn't delete: " + ((err && err.message) || err),
      );
    }
  }

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
    // Header buttons are only meaningful when an annotation is active.
    unloadBtn.style.display = ann ? "" : "none";
    trashBtn.style.display = ann ? "" : "none";

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
    _renderPublishBar(publishBar, ann);
    _renderSolidFooter(solidFooter);
  }
  // Expose a re-renderer the click handler can call independently of state
  // emits — needed to update the in-flight "Posting… 3/12" counter.
  _rerenderPublishBar = () => {
    const ann = state.getById(state.getActiveId());
    _renderPublishBar(publishBar, ann);
  };

  state.subscribe(render);
  uiState.subscribe(render);
  // Solid auth state changes affect the Post-to-Solid button's gating
  // and the footer's logged-in/out switch.
  document.addEventListener("solid-auth-changed", render);
  // Application grouping changes (tab switch / grouping-modal apply) affect
  // the editor's "Update to current view" gate, which is computed from a
  // live snapshot — re-render so it doesn't go stale.
  document.addEventListener("lh-grouping-changed", render);
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

// Per-annotation transient publish state, keyed by annId. Holds:
//   { phase: 'posting' | 'flash', step?, total?, kind: 'post' | 'update' }
// Module-level so the render function can read it without going through
// state.js (state is for persisted things; this is purely UI feedback).
const _publishUiState = new Map();
let _rerenderPublishBar = null; // set by mountDrawer

function _renderPublishBar(bar, ann) {
  clearChildren(bar);
  if (!ann) {
    bar.appendChild(
      el("span", {
        class: "lh-v6-publish-placeholder",
        text: "Select an annotation to publish.",
      }),
    );
    return;
  }
  const transient = _publishUiState.get(ann.id);
  const noTargets = ann.targets.length === 0;
  const alreadyPublished = ann.published;
  const missingUriFiles = noTargets
    ? []
    : ann.targets
        .filter((t) => {
          const u = getAudioLinkedDataUri(t.file);
          return !u || !/^https?:\/\//i.test(u);
        })
        .map((t) => t.file);
  const sess = solid.getDefaultSession && solid.getDefaultSession();
  const isLoggedIn = !!(sess && sess.info && sess.info.isLoggedIn);

  let labelChildren = [alreadyPublished ? "Update on Solid" : "Post to Solid"];
  let disabled;
  let tooltip;
  let extraClass = "";
  if (transient && transient.phase === "posting") {
    const verb = transient.kind === "update" ? "Updating" : "Posting";
    labelChildren = [verb, bouncingDots()];
    // Only show the step counter once we know the denominator — `total` is 0
    // for the brief window between click and the first onProgress call, and
    // "0/0" reads as broken. The resource kind label hints at progress when
    // a single PUT/POST is itself slow.
    if (transient.total > 0) {
      const kindLabel = transient.label ? " " + transient.label : "";
      labelChildren.push(kindLabel + " " + transient.step + "/" + transient.total);
    }
    disabled = true;
    tooltip = "Talking to your Solid pod…";
    extraClass = " is-busy";
  } else if (transient && transient.phase === "flash") {
    labelChildren = [transient.kind === "update" ? "✓ Updated!" : "✓ Posted!"];
    disabled = true;
    tooltip = "";
    extraClass = " is-flash";
  } else if (noTargets) {
    disabled = true;
    tooltip = "Select at least one recording first.";
  } else if (missingUriFiles.length > 0) {
    disabled = true;
    tooltip =
      "Set Linked Data URI prefix in Manage files first. Missing for: " +
      missingUriFiles.join(", ");
  } else if (!isLoggedIn) {
    disabled = true;
    tooltip = "Sign in to your Solid pod first (use the Solid section at the bottom of this drawer).";
  } else {
    disabled = false;
    tooltip = alreadyPublished
      ? "Push your local changes to your Solid pod."
      : "Post this annotation to your Solid pod.";
  }
  const btn = el("button", {
    class: "lh-v6-publish-btn" + extraClass,
    type: "button",
    title: tooltip,
    disabled,
    onclick: async () => {
      const isUpdate = alreadyPublished;
      _publishUiState.set(ann.id, {
        phase: "posting",
        step: 0,
        total: 0,
        kind: isUpdate ? "update" : "post",
      });
      if (_rerenderPublishBar) _rerenderPublishBar();
      const onProgress = (step, total, label) => {
        const cur = _publishUiState.get(ann.id);
        if (!cur || cur.phase !== "posting") return;
        cur.step = step;
        cur.total = total;
        if (label !== undefined) cur.label = label;
        if (_rerenderPublishBar) _rerenderPublishBar();
      };
      try {
        if (isUpdate) {
          await updateAnnotationOnSolid(ann.id, { onProgress });
        } else {
          await postAnnotationToSolid(ann.id, { onProgress });
        }
        _publishUiState.set(ann.id, {
          phase: "flash",
          kind: isUpdate ? "update" : "post",
        });
        if (_rerenderPublishBar) _rerenderPublishBar();
        setTimeout(() => {
          if ((_publishUiState.get(ann.id) || {}).phase === "flash") {
            _publishUiState.delete(ann.id);
            if (_rerenderPublishBar) _rerenderPublishBar();
          }
        }, 2000);
      } catch (err) {
        console.error("[annotation/v6] post/update failed:", err);
        _publishUiState.delete(ann.id);
        if (_rerenderPublishBar) _rerenderPublishBar();
        window.alert(
          (alreadyPublished ? "Update" : "Post") +
            " failed: " +
            (err && err.message ? err.message : err),
        );
      }
    },
  }, labelChildren);
  bar.appendChild(btn);
  if (alreadyPublished && ann.lastPostedUris && ann.lastPostedUris["mm"]) {
    bar.appendChild(
      el("a", {
        class: "lh-v6-publish-link",
        href: ann.lastPostedUris["mm"],
        target: "_blank",
        rel: "noopener noreferrer",
        title: ann.lastPostedUris["mm"],
        text: "↗ pod",
      }),
    );
  }
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

/**
 * Render the Solid auth footer. Logged-out: provider chooser + Connect
 * button (uses any stored provider as the default option). Logged-in:
 * one-line status with the WebID host and a Log-out link.
 */
function _renderSolidFooter(node) {
  clearChildren(node);
  const sess = solid.getDefaultSession && solid.getDefaultSession();
  const isLoggedIn = !!(sess && sess.info && sess.info.isLoggedIn);
  if (isLoggedIn) {
    const webId = sess.info.webId || "";
    let label = "your pod";
    try { label = new URL(webId).hostname; } catch (_) {}
    node.appendChild(
      el("div", { class: "lh-v6-solid-row" }, [
        el("span", { class: "lh-v6-solid-tick", text: "●", "aria-hidden": "true" }),
        el("span", { class: "lh-v6-solid-status", text: "Connected to " + label }),
        el("button", {
          class: "lh-v6-solid-link",
          type: "button",
          text: "Log out",
          onclick: () => { solidLogout(); },
        }),
      ]),
    );
    return;
  }
  // Logged out: provider chooser + Connect button.
  const stored = (function () {
    try { return localStorage.getItem("solidProvider") || ""; } catch (_) { return ""; }
  })();
  const providers = [
    { value: "https://solidcommunity.net", label: "SolidCommunity.net" },
    { value: "https://login.inrupt.com", label: "Inrupt PodSpaces" },
  ];
  const select = el("select", { class: "lh-v6-solid-select", "aria-label": "Solid provider" });
  for (const p of providers) {
    select.appendChild(
      el("option", { value: p.value, text: p.label, selected: p.value === stored }),
    );
  }
  select.appendChild(el("option", { value: "_other", text: "Other…" }));
  const customInput = el("input", {
    type: "url",
    class: "lh-v6-solid-custom",
    placeholder: "https://your-provider.example",
  });
  customInput.style.display = "none";
  select.addEventListener("change", () => {
    customInput.style.display = select.value === "_other" ? "" : "none";
  });
  const connectBtn = el("button", {
    class: "lh-v6-solid-connect",
    type: "button",
    text: "Connect",
    onclick: () => {
      const chosen =
        select.value === "_other"
          ? customInput.value.trim()
          : select.value;
      if (!chosen) return;
      const provider = chosen.startsWith("http") ? chosen : "https://" + chosen;
      loginAndFetch(provider);
    },
  });
  node.appendChild(
    el("div", { class: "lh-v6-solid-row" }, [
      el("span", { class: "lh-v6-solid-label", text: "Solid:" }),
      select,
      connectBtn,
    ]),
  );
  node.appendChild(customInput);
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
