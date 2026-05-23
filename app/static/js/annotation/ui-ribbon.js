// V6 annotation — bottom ribbon.
//
// Horizontal strip of annotation chips + filter + "+ New" + "Load from Solid"
// buttons. Clicking a chip selects the annotation (does NOT auto-open the
// drawer per locked design).

import * as state from "./state.js";
import * as uiState from "./ui-state.js";
import { el, clearChildren } from "./ui-common.js";
import { getActiveGroupingSnapshot } from "../listen.js";
import {
  listAnnotationsForAudio,
  listAnnotationsForLoadedAudios,
  loadAnnotationFromMM,
} from "./solid-load.js";
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
 * Open a modal that presents annotations available on the pod. Default
 * mode auto-lists annotations involving the user's currently loaded
 * recordings; a secondary "Browse a different audio…" section lets the
 * user paste an arbitrary audio URI to discover annotations involving
 * recordings they haven't loaded.
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

  const closeBtn = el("button", {
    class: "lh-v6-load-close",
    type: "button",
    text: "×",
    title: "Close",
    "aria-label": "Close",
    onclick: () => _close(),
  });

  // Default section: annotations for loaded recordings.
  const defaultStatus = el("div", { class: "lh-v6-load-status" });
  const defaultResults = el("div", { class: "lh-v6-load-results" });
  const defaultSection = el(
    "section",
    { class: "lh-v6-load-section" },
    [
      el("h3", { class: "lh-v6-load-section-title", text: "Annotations involving your loaded recordings" }),
      defaultStatus,
      defaultResults,
    ],
  );

  // Secondary section: paste-an-audio-URI browse.
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
    onclick: () => _browseSpecific(),
  });
  const browseStatus = el("div", { class: "lh-v6-load-status" });
  const browseResults = el("div", { class: "lh-v6-load-results" });
  const browseSection = el(
    "section",
    { class: "lh-v6-load-section lh-v6-load-section-secondary" },
    [
      el("h3", { class: "lh-v6-load-section-title", text: "Or browse a different audio" }),
      el("div", { class: "lh-v6-load-row" }, [audioInput, browseBtn]),
      browseStatus,
      browseResults,
    ],
  );

  const dialog = el(
    "div",
    { class: "lh-v6-load-dialog", role: "dialog", "aria-label": "Load annotation from Solid pod" },
    [
      el("div", { class: "lh-v6-load-header" }, [
        el("span", { class: "lh-v6-load-title", text: "Load annotation from Solid" }),
        closeBtn,
      ]),
      defaultSection,
      browseSection,
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
  audioInput.addEventListener("keydown", (e) => { if (e.key === "Enter") _browseSpecific(); });

  function _close() {
    if (_modalEl) _modalEl.remove();
    _modalEl = null;
  }

  async function _browseSpecific() {
    const uri = audioInput.value.trim();
    if (!uri) { _setStatus(browseStatus, "Enter an audio URI first."); return; }
    _setStatus(browseStatus, "Reading discovery resource…");
    clearChildren(browseResults);
    try {
      const entries = await listAnnotationsForAudio(uri);
      if (entries.length === 0) {
        _setStatus(browseStatus, "No MusicalMaterial entries in that audio's discovery resource.");
        return;
      }
      _setStatus(browseStatus, "Found " + entries.length + " annotation(s):");
      entries.forEach((entry) => browseResults.appendChild(_resultRow(entry, browseStatus, _close)));
    } catch (err) {
      _setStatus(browseStatus, "Couldn't browse: " + (err.message || err));
    }
  }

  // URL-param autoload: skip both browse paths and load straight away.
  if (opts.presetMm) {
    _setStatus(defaultStatus, "Loading from URL parameter…");
    _loadMm(opts.presetMm, defaultStatus, _close).catch((err) => {
      _setStatus(defaultStatus, "Couldn't load: " + (err.message || err));
    });
    return;
  }

  // Default flow: auto-list annotations for loaded recordings.
  _autoListForLoaded(defaultStatus, defaultResults, _close);
}

async function _autoListForLoaded(status, results, close) {
  _setStatus(status, "Checking your pod for annotations involving the loaded recordings…");
  try {
    const entries = await listAnnotationsForLoadedAudios();
    if (entries.length === 0) {
      _setStatus(
        status,
        "No annotations on your pod reference the currently loaded recordings. Use the section below to browse a different audio.",
      );
      return;
    }
    _setStatus(status, "Found " + entries.length + " annotation(s):");
    // Sort by created date desc (newest first), then label.
    entries.sort((a, b) => {
      const ta = a.created ? Date.parse(a.created) || 0 : 0;
      const tb = b.created ? Date.parse(b.created) || 0 : 0;
      if (ta !== tb) return tb - ta;
      return (a.label || "").localeCompare(b.label || "");
    });
    entries.forEach((entry) => results.appendChild(_resultRow(entry, status, close)));
  } catch (err) {
    _setStatus(status, "Couldn't list: " + (err.message || err));
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
  const metaChildren = [
    el("span", { class: "lh-v6-load-name", text: title }),
    sub,
  ];
  if (Array.isArray(entry.coveredFiles) && entry.coveredFiles.length > 0) {
    metaChildren.push(
      el("span", {
        class: "lh-v6-load-covers",
        text: "covers: " + entry.coveredFiles.join(", "),
      }),
    );
  }
  const btn = el("button", {
    class: "lh-v6-load-pick",
    type: "button",
    text: "Load",
    onclick: () => _loadMm(entry.mmUri, status, close),
  });
  return el("div", { class: "lh-v6-load-row-result" }, [
    el("div", { class: "lh-v6-load-meta" }, metaChildren),
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
