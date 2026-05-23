// V6 annotation — bottom ribbon.
//
// Horizontal strip of annotation chips + filter + "+ New" + "Load from Solid"
// buttons. Clicking a chip selects the annotation (does NOT auto-open the
// drawer per locked design).

import * as state from "./state.js";
import * as uiState from "./ui-state.js";
import { el, clearChildren, setStatusText } from "./ui-common.js";
import { getActiveGroupingSnapshot } from "../listen.js";
import {
  deleteAnnotationFromPod,
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

  const actions = el(
    "div",
    { class: "lh-v6-ribbon-actions" },
    [newBtn, loadBtn],
  );

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
      actions,
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

  // Shared across both sections — user can mix-and-match selections.
  const selection = new Set(); // mmUri strings
  const entryByUri = new Map(); // mmUri → entry (for label lookup at load time)

  const closeBtn = el("button", {
    class: "lh-v6-load-close",
    type: "button",
    text: "×",
    title: "Close",
    "aria-label": "Close",
    onclick: () => _close(),
  });

  const defaultStatus = el("div", { class: "lh-v6-load-status" });
  const defaultResults = el("div", { class: "lh-v6-load-results" });
  // Single "All" link, styled like the waveform group-all action. Lives
  // between the status and the first row; hidden until results populate.
  const defaultAllLink = el("span", {
    class: "group-all lh-v6-load-all",
    role: "button",
    tabIndex: "0",
    title: "Select all annotations in this list",
    text: "All",
    onclick: () => _selectAllInto(defaultResults),
    onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); _selectAllInto(defaultResults); } },
  });
  defaultAllLink.style.display = "none";
  const defaultSection = el(
    "section",
    { class: "lh-v6-load-section" },
    [
      el("h3", { class: "lh-v6-load-section-title", text: "Annotations involving your loaded recordings" }),
      defaultStatus,
      defaultAllLink,
      defaultResults,
    ],
  );

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

  // Footer: bulk-load button + a shared status area.
  const footerStatus = el("div", { class: "lh-v6-load-status lh-v6-load-footer-status" });
  const loadSelectedBtn = el("button", {
    class: "lh-v6-load-bulk",
    type: "button",
    text: "Load selected (0)",
    disabled: true,
    onclick: () => _loadSelected(),
  });
  const footer = el("div", { class: "lh-v6-load-footer" }, [footerStatus, loadSelectedBtn]);

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
      footer,
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

  function _refreshBulkBtn() {
    loadSelectedBtn.textContent = "Load selected (" + selection.size + ")";
    loadSelectedBtn.disabled = selection.size === 0;
  }

  function _onToggle(mmUri, checked) {
    if (checked) selection.add(mmUri);
    else selection.delete(mmUri);
    _refreshBulkBtn();
  }

  async function _onDelete(mmUri, rowEl) {
    const entry = entryByUri.get(mmUri);
    const title = (entry && entry.label) || mmUri;
    const ok = await _confirmDelete(title);
    if (!ok) return;
    rowEl.classList.add("is-busy");
    _setStatus(footerStatus, "Deleting " + title + "…");
    deleteAnnotationFromPod(mmUri, {
      onProgress: (label) => _setStatus(footerStatus, "Deleting " + title + ": " + label + "…"),
    })
      .then((res) => {
        rowEl.remove();
        entryByUri.delete(mmUri);
        selection.delete(mmUri);
        _refreshBulkBtn();
        if (defaultResults.children.length === 0) defaultAllLink.style.display = "none";
        const failedCount = res.failedUris.length;
        _setStatus(
          footerStatus,
          failedCount > 0
            ? "Deleted with " + failedCount + " failure(s) — see console."
            : "✓ Deleted " + res.deletedUris.length + " resource(s).",
        );
      })
      .catch((err) => {
        rowEl.classList.remove("is-busy");
        _setStatus(footerStatus, "Couldn't delete: " + (err.message || err));
      });
  }

  async function _loadSelected() {
    if (selection.size === 0) return;
    const uris = [...selection];
    loadSelectedBtn.disabled = true;
    for (let i = 0; i < uris.length; i++) {
      const mmUri = uris[i];
      const title = (entryByUri.get(mmUri) || {}).label || mmUri;
      const prefix = "Loading " + (i + 1) + "/" + uris.length + " (" + title + ")";
      _setStatus(footerStatus, prefix + "…");
      try {
        await loadAnnotationFromMM(mmUri, {
          onProgress: (label) => _setStatus(footerStatus, prefix + ": " + label + "…"),
        });
      } catch (err) {
        _setStatus(footerStatus, prefix + " failed: " + (err.message || err));
        loadSelectedBtn.disabled = false;
        return;
      }
    }
    _setStatus(footerStatus, "✓ Loaded " + uris.length + " annotation(s).");
    setTimeout(_close, 800);
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
      entries.forEach((entry) => {
        entryByUri.set(entry.mmUri, entry);
        browseResults.appendChild(_resultRow(entry, _onToggle, _onDelete));
      });
    } catch (err) {
      _setStatus(browseStatus, "Couldn't browse: " + (err.message || err));
    }
  }

  // URL-param autoload: skip both browse paths and load straight away.
  if (opts.presetMm) {
    _setStatus(footerStatus, "Loading from URL parameter…");
    loadAnnotationFromMM(opts.presetMm, {
      onProgress: (label) => _setStatus(footerStatus, "Loading " + label + "…"),
    })
      .then(() => {
        _setStatus(footerStatus, "✓ Loaded.");
        setTimeout(_close, 600);
      })
      .catch((err) => _setStatus(footerStatus, "Couldn't load: " + (err.message || err)));
    return;
  }

  // Default flow: auto-list annotations for loaded recordings.
  _autoListForLoaded(defaultStatus, defaultResults, defaultAllLink, entryByUri, _onToggle, _onDelete);
}

async function _autoListForLoaded(status, results, allLink, entryByUri, onToggle, onDelete) {
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
    entries.forEach((entry) => {
      entryByUri.set(entry.mmUri, entry);
      results.appendChild(_resultRow(entry, onToggle, onDelete));
    });
    allLink.style.display = "";
  } catch (err) {
    _setStatus(status, "Couldn't list: " + (err.message || err));
  }
}

function _selectAllInto(resultsEl) {
  resultsEl.querySelectorAll(".lh-v6-load-check").forEach((cb) => {
    if (!cb.checked) {
      cb.checked = true;
      cb.dispatchEvent(new Event("change"));
    }
  });
}

function _resultRow(entry, onToggle, onDelete) {
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
  const checkbox = el("input", {
    type: "checkbox",
    class: "lh-v6-load-check",
    "aria-label": "Select " + title,
    onchange: (e) => onToggle(entry.mmUri, e.target.checked),
  });
  const row = el("div", { class: "lh-v6-load-row-result" }, [
    checkbox,
    el("div", { class: "lh-v6-load-meta" }, metaChildren),
  ]);
  const trashBtn = el("button", {
    class: "lh-v6-load-trash",
    type: "button",
    title: "Delete from pod",
    "aria-label": "Delete from pod",
    text: "🗑",
    onclick: () => onDelete(entry.mmUri, row),
  });
  row.appendChild(trashBtn);
  return row;
}

// Thin wrapper around setStatusText so existing call sites keep their name
// and we get the trailing-ellipsis → bouncing-dots swap for free.
function _setStatus(status, text) {
  setStatusText(status, text);
}

/**
 * Custom confirmation dialog for pod-side deletion. Returns a Promise that
 * resolves to true if the user clicks Delete, false otherwise (Cancel,
 * backdrop click, or Escape). Layered above the load modal (higher
 * z-index) and visually alarming so a misclick stands out.
 */
function _confirmDelete(title) {
  return new Promise((resolve) => {
    let settled = false;
    function settle(answer) {
      if (settled) return;
      settled = true;
      document.removeEventListener("keydown", onKey);
      overlay.remove();
      resolve(answer);
    }
    function onKey(e) {
      if (e.key === "Escape") settle(false);
      else if (e.key === "Enter") settle(true);
    }

    const cancelBtn = el("button", {
      class: "lh-v6-confirm-cancel",
      type: "button",
      text: "Cancel",
      onclick: () => settle(false),
    });
    const deleteBtn = el("button", {
      class: "lh-v6-confirm-delete",
      type: "button",
      text: "Delete from pod",
      onclick: () => settle(true),
    });

    const dialog = el(
      "div",
      { class: "lh-v6-confirm-dialog", role: "alertdialog", "aria-labelledby": "lh-v6-confirm-h" },
      [
        el("div", { class: "lh-v6-confirm-header" }, [
          el("span", { class: "lh-v6-confirm-warning", text: "⚠", "aria-hidden": "true" }),
          el("h2", { id: "lh-v6-confirm-h", class: "lh-v6-confirm-title", text: "Delete this annotation?" }),
        ]),
        el("div", { class: "lh-v6-confirm-body" }, [
          el("p", { class: "lh-v6-confirm-target" }, [
            "You are about to permanently delete ",
            el("strong", { text: '"' + title + '"' }),
            " from your Solid pod.",
          ]),
          el("p", { class: "lh-v6-confirm-detail", text: "This removes the MusicalMaterial, Extract, Selections, and every related OA Annotation. If a local copy is loaded in this session, it will also be removed." }),
          el("p", { class: "lh-v6-confirm-warn", text: "This cannot be undone." }),
        ]),
        el("div", { class: "lh-v6-confirm-actions" }, [cancelBtn, deleteBtn]),
      ],
    );

    const overlay = el(
      "div",
      {
        class: "lh-v6-confirm-overlay",
        onclick: (e) => { if (e.target === overlay) settle(false); },
      },
      dialog,
    );
    document.body.appendChild(overlay);
    document.addEventListener("keydown", onKey);
    cancelBtn.focus(); // safer default focus than the destructive button
  });
}
