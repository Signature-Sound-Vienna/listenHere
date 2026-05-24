// V6 annotation — bottom ribbon.
//
// Horizontal strip of annotation chips + filter + "+ New" + "Load from Solid"
// buttons. Clicking a chip selects the annotation (does NOT auto-open the
// drawer per locked design).

import * as state from "./state.js";
import * as uiState from "./ui-state.js";
import { el, clearChildren, setStatusText, confirmDeleteFromPod } from "./ui-common.js";
import { getActiveGroupingSnapshot } from "../listen.js";
import {
  deleteAnnotationFromPod,
  listAnnotationsForAudio,
  listAnnotationsForLoadedAudios,
  loadAnnotationFromMM,
} from "./solid-load.js";
import * as playback from "./playback.js";
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
    title: "Browse, load, or delete annotations on your Solid pod",
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
    const playingNow = playback.isPlaying(a.id);
    // The play/pause overlay only appears on the active chip; click toggles.
    // On non-active chips, clicking the chip body sets it active and the
    // overlay appears in its "ready to play" state.
    const overlay = isActive
      ? el("button", {
          class: "lh-v6-chip-play" + (playingNow ? " playing" : ""),
          type: "button",
          title: playingNow ? "Pause looped playback" : "Play this annotation on loop",
          "aria-label": playingNow ? "Pause" : "Play",
          // Stop propagation so we don't re-fire the chip's setActive click.
          onclick: (e) => { e.stopPropagation(); playback.toggle(a.id); },
          text: playingNow ? "❚❚" : "▶",
        })
      : null;
    return el(
      "div",
      {
        class:
          "lh-v6-chip" +
          (isActive ? " active" : "") +
          (playingNow ? " playing" : ""),
        role: "button",
        tabIndex: "0",
        title: a.label || "Untitled annotation",
        onclick: () => {
          if (!isActive) {
            // Switching annotations: stop any current playback, then activate.
            playback.stop();
            state.setActiveAnnotation(a.id);
          }
        },
        onkeydown: (e) => {
          if ((e.key === "Enter" || e.key === " ") && !isActive) {
            e.preventDefault();
            playback.stop();
            state.setActiveAnnotation(a.id);
          }
        },
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
        overlay,
      ],
    );
  }

  state.subscribe(render);
  playback.subscribe(render);
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
    // Open the drawer (if it isn't already) and pulse the Solid section
    // at the bottom — the only login surface in this iteration. Replaces
    // the older modal-alert that pointed at a now-removed RDF icon.
    _highlightSolidLogin();
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

  // Resumed-after-login banner: only rendered when opts.resumed is true.
  // Causally connects the auto-pop to the just-completed login so the user
  // understands why the modal appeared.
  const resumedBanner = opts.resumed
    ? el("div", { class: "lh-v6-load-resumed", role: "status" }, [
        el("span", { class: "lh-v6-load-resumed-icon", text: "✓", "aria-hidden": "true" }),
        el("span", { text: "Signed in — resuming your Load from Solid." }),
      ])
    : null;

  const dialog = el(
    "div",
    { class: "lh-v6-load-dialog", role: "dialog", "aria-label": "Load annotation from Solid pod" },
    [
      el("div", { class: "lh-v6-load-header" }, [
        el("span", { class: "lh-v6-load-title", text: "Load annotation from Solid" }),
        closeBtn,
      ]),
      resumedBanner,
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
    const ok = await confirmDeleteFromPod(title);
    if (!ok) return;
    rowEl.classList.add("is-busy");
    _setStatus(footerStatus, "Deleting " + title + "…");
    deleteAnnotationFromPod(mmUri, {
      onProgress: (label) => _setStatus(footerStatus, "Deleting " + title + ": " + label + "…"),
      // Hint for the stale-cleanup branch: scope discovery patches to the
      // audios that surfaced this entry in the first place.
      coveredFiles: entry && entry.coveredFiles,
    })
      .then((res) => {
        rowEl.remove();
        entryByUri.delete(mmUri);
        selection.delete(mmUri);
        _refreshBulkBtn();
        if (defaultResults.children.length === 0) defaultAllLink.style.display = "none";
        if (res.stale) {
          // The MM was already gone from the pod; we only pruned stale
          // dataset references. Report that distinctly so the user knows
          // nothing live was deleted.
          const n = res.cleanedAudios || 0;
          _setStatus(
            footerStatus,
            n > 0
              ? "✓ Pod copy was already missing. Pruned stale references from " + n + " discovery resource(s)."
              : "Pod copy was already missing and no stale references were found.",
          );
          return;
        }
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
 * Open the annotation drawer (if it isn't already) and pulse the Solid
 * auth footer so the user notices where to log in. Used when a
 * login-required affordance is hit while signed out — replaces the
 * previous `window.alert` that pointed at a now-removed RDF icon.
 *
 * The class is removed once the animation ends so subsequent triggers
 * restart it cleanly.
 */
function _highlightSolidLogin() {
  uiState.setDrawerOpen(true);
  // Record intent: if the user logs in within LOAD_INTENT_WINDOW_MS, the
  // load modal auto-pops on the auth-changed event with a banner that
  // explains why. sessionStorage so we survive the OAuth redirect.
  try {
    sessionStorage.setItem(
      "v6-load-intent",
      JSON.stringify({ ts: Date.now() }),
    );
  } catch (_) {}
  // Wait for the drawer's transform-transition (≈200ms) before flashing
  // the footer — pulsing on an off-screen element would land unseen.
  setTimeout(() => {
    const footer = document.querySelector(".lh-v6-drawer-solid");
    if (!footer) return;
    footer.classList.remove("lh-v6-pulse");
    // Force a reflow so re-adding the class restarts the animation
    // even if it's still mid-cycle from a previous click.
    void footer.offsetWidth;
    footer.classList.add("lh-v6-pulse");
    const onEnd = () => {
      footer.classList.remove("lh-v6-pulse");
      footer.removeEventListener("animationend", onEnd);
    };
    footer.addEventListener("animationend", onEnd);
  }, 220);
}

const LOAD_INTENT_WINDOW_MS = 15000;

/**
 * If the user clicked Load-from-Solid while logged out within the last
 * LOAD_INTENT_WINDOW_MS, consume the flag and return its timestamp so
 * the caller knows to auto-pop the modal. Returns null otherwise. Called
 * from the `solid-auth-changed{isLoggedIn:true}` handler in index.js.
 */
export function consumeLoadIntent() {
  let raw;
  try { raw = sessionStorage.getItem("v6-load-intent"); } catch (_) { return null; }
  if (!raw) return null;
  try { sessionStorage.removeItem("v6-load-intent"); } catch (_) {}
  try {
    const { ts } = JSON.parse(raw) || {};
    if (typeof ts === "number" && Date.now() - ts <= LOAD_INTENT_WINDOW_MS) {
      return ts;
    }
  } catch (_) {}
  return null;
}

