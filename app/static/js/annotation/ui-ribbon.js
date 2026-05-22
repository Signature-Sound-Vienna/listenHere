// V6 annotation — bottom ribbon.
//
// Horizontal strip of annotation chips + filter + "+ New" + "Load from Solid"
// buttons. Clicking a chip selects the annotation (does NOT auto-open the
// drawer per locked design).

import * as state from "./state.js";
import * as uiState from "./ui-state.js";
import { el, clearChildren } from "./ui-common.js";
import { getActiveGroupingSnapshot } from "../listen.js";
import { listAnnotationsForAudio, loadAnnotationFromMM } from "./solid-load.js";
import { solid } from "../solid.js";

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

  const loadBtn = el("button", {
    class: "lh-v6-ribbon-load",
    type: "button",
    text: "↓ Load from Solid",
    title: "Browse and load an annotation from your Solid pod",
    onclick: () => _openLoadModal(),
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
      loadBtn,
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

// ---------------------------------------------------------------------------
// Load-from-Solid modal
// ---------------------------------------------------------------------------

let _modalEl = null;

/**
 * Open (or focus) a small modal that asks for an audio Linked Data URI,
 * fetches its discovery resource, and presents a picker for each MM URI
 * listed there. Clicking "Load" walks the chain and adds the annotation
 * to state.
 *
 * Exposed for the URL-param autoload too: callers can pass a presetMm to
 * skip the browse step and load a specific MM straight away.
 */
export function _openLoadModal(opts = {}) {
  const sess = solid.getDefaultSession && solid.getDefaultSession();
  if (!sess || !sess.info || !sess.info.isLoggedIn) {
    window.alert("Sign in to your Solid pod first (use the RDF icon on the right edge).");
    return;
  }

  if (_modalEl) {
    _modalEl.remove();
    _modalEl = null;
  }

  const audioInput = el("input", {
    type: "text",
    class: "lh-v6-load-input",
    placeholder: "Audio Linked Data URI (e.g. https://w3id.org/.../track.wav)",
    "aria-label": "Audio Linked Data URI",
  });
  const browseBtn = el("button", {
    class: "lh-v6-load-browse",
    type: "button",
    text: "Browse",
    onclick: () => _browse(),
  });
  const closeBtn = el("button", {
    class: "lh-v6-load-close",
    type: "button",
    text: "×",
    title: "Close",
    "aria-label": "Close",
    onclick: () => _close(),
  });
  const status = el("div", { class: "lh-v6-load-status" });
  const results = el("div", { class: "lh-v6-load-results" });

  const dialog = el(
    "div",
    { class: "lh-v6-load-dialog", role: "dialog", "aria-label": "Load annotation from Solid pod" },
    [
      el("div", { class: "lh-v6-load-header" }, [
        el("span", { class: "lh-v6-load-title", text: "Load annotation from Solid" }),
        closeBtn,
      ]),
      el("div", { class: "lh-v6-load-row" }, [audioInput, browseBtn]),
      status,
      results,
    ],
  );

  _modalEl = el(
    "div",
    {
      class: "lh-v6-load-overlay",
      onclick: (e) => { if (e.target === _modalEl) _close(); },
    },
    dialog,
  );
  document.body.appendChild(_modalEl);
  audioInput.focus();
  audioInput.addEventListener("keydown", (e) => { if (e.key === "Enter") _browse(); });

  function _close() {
    if (_modalEl) _modalEl.remove();
    _modalEl = null;
  }

  async function _browse() {
    const uri = audioInput.value.trim();
    if (!uri) { _setStatus(status, "Enter an audio URI first."); return; }
    _setStatus(status, "Reading discovery resource…");
    clearChildren(results);
    try {
      const entries = await listAnnotationsForAudio(uri);
      if (entries.length === 0) {
        _setStatus(status, "No MusicalMaterial entries in that audio's discovery resource.");
        return;
      }
      _setStatus(status, "Found " + entries.length + " annotation(s):");
      entries.forEach((entry) => results.appendChild(_resultRow(entry, status, _close)));
    } catch (err) {
      _setStatus(status, "Couldn't browse: " + (err.message || err));
    }
  }

  // If invoked with presetMm (URL-param autoload), skip the browse step.
  if (opts.presetMm) {
    _setStatus(status, "Loading from URL parameter…");
    _loadMm(opts.presetMm, status, _close).catch((err) => {
      _setStatus(status, "Couldn't load: " + (err.message || err));
    });
  }
}

function _resultRow(entry, status, close) {
  const title = entry.label || "(untitled)";
  const sub = el("span", { class: "lh-v6-load-sub" });
  const subParts = [];
  if (entry.created) {
    try { subParts.push(new Date(entry.created).toLocaleString()); } catch (_) { subParts.push(entry.created); }
  }
  subParts.push(entry.mmUri);
  sub.textContent = subParts.join(" — ");
  const btn = el("button", {
    class: "lh-v6-load-pick",
    type: "button",
    text: "Load",
    onclick: () => _loadMm(entry.mmUri, status, close),
  });
  return el("div", { class: "lh-v6-load-row-result" }, [
    el("div", { class: "lh-v6-load-meta" }, [
      el("span", { class: "lh-v6-load-name", text: title }),
      sub,
    ]),
    btn,
  ]);
}

async function _loadMm(mmUri, status, close) {
  _setStatus(status, "Loading… (Fetching MusicalMaterial)");
  try {
    await loadAnnotationFromMM(mmUri, {
      onProgress: (label) => _setStatus(status, "Loading… (" + label + ")"),
    });
    _setStatus(status, "✓ Loaded.");
    setTimeout(close, 600);
  } catch (err) {
    _setStatus(status, (err && err.message) || String(err));
  }
}

function _setStatus(status, text) {
  status.textContent = text;
}
