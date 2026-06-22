// V6 annotation — bottom ribbon.
//
// Horizontal strip of annotation chips + filter + "+ New" + "Load from Solid"
// buttons. Clicking a chip selects the annotation (does NOT auto-open the
// drawer per locked design).

import * as state from "./state.js";
import * as uiState from "./ui-state.js";
import { el, clearChildren, setStatusText, confirmDeleteFromPod } from "./ui-common.js";
import { getActiveGroupingSnapshot, playAnnotation } from "../listen.js";
import {
  deleteAnnotationFromPod,
  listAnnotationsForLoadedAudios,
  loadAnnotationFromMM,
} from "./solid-load.js";
import { solid } from "../solid.js";

// Pencil glyph mirroring the drawer pull-tab (ui-pull-tab.js), used as the
// ribbon's leading "Annotations" affordance in place of the wordy label.
const PENCIL_SVG =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
  ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M16.5 3.5l4 4-13 13H3.5v-4l13-13z"/><path d="M14 6l4 4"/></svg>';

// Annotations whose regions are currently under the playhead. Distinct from
// the single "active" annotation (shown in the editor): several can be lit at
// once when regions overlap. listen.js drives this from playback events via
// setPlayingAnnotations; we keep the set at module scope so it survives chip
// re-renders, and toggle the class directly to avoid a full re-render per frame.
let _chipsContainer = null;
let _playingIds = new Set();

/**
 * Mark the chips of `ids` (an iterable of annotation IDs) as currently
 * playing. Toggles the `.playing` class on existing chip elements without a
 * re-render; the set is also consulted in _chip so the highlight reapplies if
 * the ribbon re-renders while playback continues.
 */
export function setPlayingAnnotations(ids) {
  _playingIds = new Set(ids || []);
  if (!_chipsContainer) return;
  for (const chip of _chipsContainer.querySelectorAll(".lh-v6-chip")) {
    const id = chip.dataset.annId;
    chip.classList.toggle("playing", !!id && _playingIds.has(id));
  }
}

export function mountRibbon(parent) {
  // Placeholder intentionally blank: the magnifying-glass icon (CSS
  // background) communicates "filter", and the input collapses to roughly
  // icon-width when unfocused, expanding on focus.
  const filterInput = el("input", {
    type: "text",
    class: "lh-v6-ribbon-filter",
    placeholder: "",
    title: "Filter annotations",
    "aria-label": "Filter annotations",
    oninput: (e) => {
      // Keep the field expanded while it holds a real (non-whitespace)
      // query, even after focus leaves; CSS can't trim, so we toggle a class.
      e.currentTarget.classList.toggle(
        "has-query",
        e.currentTarget.value.trim() !== "",
      );
      _updateFilterOverflow();
      render();
    },
    // Enter / Escape always drop focus. When the field is empty it collapses
    // back to its icon-only width; with a real query the .has-query class
    // keeps it expanded, which is intended.
    onkeydown: (e) => {
      if (e.key === "Enter" || e.key === "Escape") {
        e.preventDefault();
        e.currentTarget.blur();
      }
    },
  });

  // The input is wrapped so we can lay edge-fade overlays over it (inputs
  // can't host ::before/::after). _updateFilterOverflow() toggles ov-left /
  // ov-right when the typed text scrolls past the visible area — mirroring
  // the chip strip's can-left / can-right affordance below.
  const filterFadeLeft = el("span", {
    class: "lh-v6-ribbon-filter-fade left",
    "aria-hidden": "true",
  });
  const filterFadeRight = el("span", {
    class: "lh-v6-ribbon-filter-fade right",
    "aria-hidden": "true",
  });
  const filterWrap = el("div", { class: "lh-v6-ribbon-filter-wrap" }, [
    filterInput,
    filterFadeLeft,
    filterFadeRight,
  ]);

  function _updateFilterOverflow() {
    const overflowing = filterInput.scrollWidth > filterInput.clientWidth + 1;
    const canLeft = overflowing && filterInput.scrollLeft > 1;
    const canRight =
      overflowing &&
      filterInput.scrollLeft + filterInput.clientWidth < filterInput.scrollWidth - 1;
    filterWrap.classList.toggle("ov-left", canLeft);
    filterWrap.classList.toggle("ov-right", canRight);
  }

  // Caret movement scrolls the text without firing `input`; recompute on
  // scroll, and after the collapse/expand width transition settles.
  filterInput.addEventListener("scroll", _updateFilterOverflow, { passive: true });
  filterInput.addEventListener("transitionend", (e) => {
    if (e.propertyName === "width") _updateFilterOverflow();
  });

  const chips = el("div", { class: "lh-v6-ribbon-chips" });
  _chipsContainer = chips;

  // Chevron buttons + wrapper give the scrolling chip strip a tidy,
  // scrollbar-free overflow affordance. The native scrollbar is hidden in
  // CSS (it stole vertical space inside the 40px ribbon and clipped chips);
  // instead the wrapper gains .can-left / .can-right classes that fade the
  // corresponding edge and reveal a chevron. _updateScrollAffordance()
  // recomputes these from the strip's scroll position.
  const scrollLeftBtn = el("button", {
    class: "lh-v6-ribbon-chev lh-v6-ribbon-chev-left",
    type: "button",
    tabIndex: "-1",
    "aria-hidden": "true",
    title: "Scroll annotations left",
    text: "‹",
    onclick: () => _scrollChips(-1),
  });
  const scrollRightBtn = el("button", {
    class: "lh-v6-ribbon-chev lh-v6-ribbon-chev-right",
    type: "button",
    tabIndex: "-1",
    "aria-hidden": "true",
    title: "Scroll annotations right",
    text: "›",
    onclick: () => _scrollChips(1),
  });
  // Slim scroll-position bar pinned to the strip's bottom edge: the thumb's
  // width conveys how much of the full list is currently visible, its offset
  // where we are within it. Non-interactive; shown only when overflowing.
  const scrollThumb = el("div", { class: "lh-v6-ribbon-scrollpos-thumb" });
  const scrollPos = el("div", { class: "lh-v6-ribbon-scrollpos" }, [scrollThumb]);
  const chipsWrap = el(
    "div",
    { class: "lh-v6-ribbon-chips-wrap" },
    [scrollLeftBtn, chips, scrollRightBtn, scrollPos],
  );

  function _scrollChips(dir) {
    // Scroll by ~80% of the visible width so consecutive clicks march
    // through the strip while keeping a sliver of context.
    chips.scrollBy({ left: dir * chips.clientWidth * 0.8, behavior: "smooth" });
  }

  function _updateScrollAffordance() {
    const canLeft = chips.scrollLeft > 1;
    const canRight = chips.scrollLeft + chips.clientWidth < chips.scrollWidth - 1;
    chipsWrap.classList.toggle("can-left", canLeft);
    chipsWrap.classList.toggle("can-right", canRight);
    // Position bar: thumb fraction = visible/total, offset = scroll progress.
    const overflowing = chips.scrollWidth > chips.clientWidth + 1;
    chipsWrap.classList.toggle("overflowing", overflowing);
    if (overflowing) {
      const frac = chips.clientWidth / chips.scrollWidth;
      const maxScroll = chips.scrollWidth - chips.clientWidth;
      const progress = maxScroll > 0 ? chips.scrollLeft / maxScroll : 0;
      scrollThumb.style.width = (frac * 100).toFixed(2) + "%";
      // left ranges 0 → (1 - frac) of the track as we scroll end to end.
      scrollThumb.style.left = (progress * (1 - frac) * 100).toFixed(2) + "%";
    }
  }

  chips.addEventListener("scroll", _updateScrollAffordance, { passive: true });
  window.addEventListener("resize", _updateScrollAffordance);

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

  // Two waiting affordances live at the end of the label, each hidden at
  // rest (see the lh-v6-ribbon-load--waiting / --connecting CSS):
  //   • a → that nudges rightward toward the Solid login footer (which opens
  //     to the ribbon's right) while we're waiting on the user to sign in;
  //   • a spinner, shown once they click Connect and the OAuth exchange is
  //     actually in flight — at which point the app, not the user, is busy.
  const loadBtn = el(
    "button",
    {
      class: "lh-v6-ribbon-load",
      type: "button",
      title: "Browse, load, or delete annotations on your Solid pod",
      onclick: () => _openLoadModal(),
    },
    [
      el("span", { text: "Load from Solid" }),
      el("span", { class: "lh-v6-ribbon-load-arrow", "aria-hidden": "true", text: "→" }),
      el("span", { class: "lh-v6-ribbon-load-spinner", "aria-hidden": "true" }),
    ],
  );
  // Module-level handle so _armLoadIntent / _disarmLoadIntent can toggle
  // the waiting nudge-arrow from outside this factory.
  _loadBtn = loadBtn;

  const actions = el(
    "div",
    { class: "lh-v6-ribbon-actions" },
    [newBtn, loadBtn],
  );

  // Count badge sits beside the label: shows the total number of
  // annotations, or "n / total" while a filter is narrowing the list.
  const countEl = el("span", {
    class: "lh-v6-ribbon-count",
    "aria-live": "polite",
  });
  const labelGroup = el("span", { class: "lh-v6-ribbon-labelgroup" }, [
    el("span", {
      class: "lh-v6-ribbon-label",
      html: PENCIL_SVG,
      title: "Annotations",
      "aria-label": "Annotations",
    }),
    countEl,
  ]);

  const ribbon = el(
    "div",
    { class: "lh-v6-ribbon", role: "toolbar", "aria-label": "Annotations" },
    [
      labelGroup,
      filterWrap,
      chipsWrap,
      actions,
    ],
  );
  parent.appendChild(ribbon);

  // The ribbon's right edge slides via a CSS transition when the drawer
  // opens/closes, changing the chip strip's width. Recompute the chevron /
  // fade / position-bar state when that transition finishes — otherwise the
  // affordance reflects the pre-transition width and only corrects itself on
  // the next chip interaction.
  ribbon.addEventListener("transitionend", (e) => {
    if (e.target === ribbon && e.propertyName === "right") {
      _updateScrollAffordance();
    }
  });

  function render() {
    clearChildren(chips);
    const all = state.getAll();
    const q = filterInput.value.trim().toLowerCase();
    const filtered = q
      ? all.filter((a) => (a.label || "").toLowerCase().includes(q))
      : all;
    // Count badge: bare total normally; "matches / total" while filtering.
    if (all.length === 0) {
      countEl.textContent = "";
      countEl.title = "";
    } else if (q) {
      countEl.textContent = filtered.length + " / " + all.length;
      countEl.title =
        filtered.length +
        " of " +
        all.length +
        " annotation" +
        (all.length === 1 ? "" : "s") +
        " match the current filter";
    } else {
      countEl.textContent = String(all.length);
      countEl.title =
        all.length + " annotation" + (all.length === 1 ? "" : "s");
    }
    if (filtered.length === 0) {
      chips.appendChild(
        el("span", {
          class: "lh-v6-ribbon-empty",
          text: q ? "No matches." : "No annotations yet.",
        }),
      );
      _updateScrollAffordance();
      return;
    }
    filtered.forEach((a) => chips.appendChild(_chip(a)));
    _updateScrollAffordance();
  }

  function _chip(a) {
    const isActive = a.id === state.getActiveId();
    const isPlaying = _playingIds.has(a.id);
    // Clicking a chip activates the annotation and plays it from the start of
    // its first region (listen.js owns waveform pick, seek, play, and the
    // close-listening loop). No per-card play/pause control any more.
    const activateAndPlay = () => playAnnotation(a.id);
    const chip = el(
      "div",
      {
        class:
          "lh-v6-chip" +
          (isActive ? " active" : "") +
          (isPlaying ? " playing" : ""),
        role: "button",
        tabIndex: "0",
        "data-ann-id": a.id,
        title: a.label || "Untitled annotation",
        onclick: activateAndPlay,
        onkeydown: (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            activateAndPlay();
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
      ],
    );
    // Drive the playing-pulse tint from the annotation's own colour. Custom
    // properties must be set via setProperty (the el() style-object path uses
    // Object.assign, which doesn't apply CSS variables).
    if (a.color) chip.style.setProperty("--lh-chip-color", a.color);
    return chip;
  }

  state.subscribe(render);
  render();
  return ribbon;
}

// ---------------------------------------------------------------------------
// Load-from-Solid modal
// ---------------------------------------------------------------------------

let _modalEl = null;
// Ribbon "Load from Solid" button, captured in createRibbon so the
// login-intent helpers can drive its waiting nudge-arrow.
let _loadBtn = null;
// Live state for a pending "auto-open Load once signed in" intent.
let _loadIntentTimer = null; // expiry timer (LOAD_INTENT_WINDOW_MS)
let _loadIntentCancel = null; // document interaction handler that cancels it
let _loadIntentConnect = null; // solid-login-started handler: arrow → spinner
let _loadIntentAbort = null; // failed/cancelled-login handler: spinner → arrow

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
  // Manual reload: re-run discovery so annotations that appeared on the pod
  // during this session show up without reopening the modal. Discovery is
  // entirely user-initiated here (no background polling — see the load-modal
  // live-update follow-up in the roadmap), so this is the only freshening path.
  const reloadBtn = el("button", {
    class: "lh-v6-load-reload",
    type: "button",
    text: "↻ Reload",
    title: "Re-check your pod for annotations",
    "aria-label": "Reload the list of annotations",
    onclick: () => _reload(),
  });
  const defaultSectionHead = el("div", { class: "lh-v6-load-section-head" }, [
    el("h3", { class: "lh-v6-load-section-title", text: "Annotations involving your loaded recordings" }),
    reloadBtn,
  ]);
  const defaultSection = el(
    "section",
    { class: "lh-v6-load-section" },
    [
      defaultSectionHead,
      defaultStatus,
      defaultAllLink,
      defaultResults,
    ],
  );

  // "Load specific annotation" — direct-MM-URI input. Useful for loading
  // annotations whose contents aren't surfaced by the auto-discovery
  // above (e.g. score annotations created in mei-friend, or anything
  // hosted on a pod we haven't queried). Replaces the older
  // "Browse a different audio" affordance.
  const directInput = el("input", {
    type: "text",
    class: "lh-v6-load-input",
    placeholder: "MusicalMaterial URI (e.g. https://your-pod/at.ac.mdw.mei-friend/mao/musicalMaterial/…)",
    "aria-label": "MusicalMaterial URI",
  });
  const directLoadBtn = el("button", {
    class: "lh-v6-load-browse",
    type: "button",
    text: "Load",
    onclick: () => _loadDirect(),
  });
  const directStatus = el("div", { class: "lh-v6-load-status" });
  const directSection = el(
    "section",
    { class: "lh-v6-load-section lh-v6-load-section-secondary" },
    [
      el("h3", { class: "lh-v6-load-section-title", text: "Load specific annotation" }),
      el("div", { class: "lh-v6-load-row" }, [directInput, directLoadBtn]),
      directStatus,
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
      directSection,
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
  directInput.addEventListener("keydown", (e) => { if (e.key === "Enter") _loadDirect(); });

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

  async function _loadDirect() {
    const uri = directInput.value.trim();
    if (!uri) { _setStatus(directStatus, "Paste a MusicalMaterial URI first."); return; }
    if (!/^https?:\/\//i.test(uri)) {
      _setStatus(directStatus, "URI must start with http:// or https://.");
      return;
    }
    _setStatus(directStatus, "Loading…");
    try {
      await loadAnnotationFromMM(uri, {
        onProgress: (label) => _setStatus(directStatus, label + "…"),
      });
      _setStatus(directStatus, "✓ Loaded.");
      setTimeout(_close, 600);
    } catch (err) {
      _setStatus(directStatus, "Couldn't load: " + ((err && err.message) || err));
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

  function _reload() {
    _autoListForLoaded(defaultStatus, defaultResults, defaultAllLink, entryByUri, _onToggle, _onDelete, selection, reloadBtn);
  }

  // Default flow: auto-list annotations for loaded recordings.
  _reload();
}

async function _autoListForLoaded(status, results, allLink, entryByUri, onToggle, onDelete, selection, reloadBtn) {
  if (reloadBtn) reloadBtn.disabled = true;
  _setStatus(status, "Checking your pod for annotations involving the loaded recordings…");

  // Sort by created date desc (newest first), then label.
  const sortEntries = (entries) =>
    entries.slice().sort((a, b) => {
      const ta = a.created ? Date.parse(a.created) || 0 : 0;
      const tb = b.created ? Date.parse(b.created) || 0 : 0;
      if (ta !== tb) return tb - ta;
      return (a.label || "").localeCompare(b.label || "");
    });

  // Full re-render from a snapshot: coverage pills and the score flag
  // aggregate across sources, so a later-resolving source can enrich an
  // already-shown row — appending would leave those stale. Checkbox state is
  // restored from the persistent `selection` Set, so re-rendering mid-load
  // doesn't drop the user's picks.
  const render = (entries) => {
    clearChildren(results);
    entryByUri.clear();
    for (const entry of sortEntries(entries)) {
      entryByUri.set(entry.mmUri, entry);
      results.appendChild(
        _resultRow(entry, onToggle, onDelete, selection.has(entry.mmUri)),
      );
    }
    allLink.style.display = entries.length > 0 ? "" : "none";
  };

  try {
    const { entries, errors } = await listAnnotationsForLoadedAudios({
      onProgress: (label) => _setStatus(status, label),
      onSnapshot: (snap) => render(snap.entries),
    });
    render(entries);
    _setStatus(status, _discoverySummary(entries.length, errors.length));
  } catch (err) {
    _setStatus(status, "Couldn't list: " + (err.message || err));
  } finally {
    if (reloadBtn) reloadBtn.disabled = false;
  }
}

// Terminal status line for discovery, distinguishing an empty pod from one we
// couldn't fully reach.
function _discoverySummary(found, errorCount) {
  if (found === 0) {
    return errorCount > 0
      ? "Couldn't reach your pod for " +
          errorCount +
          " source(s); no annotations found from the rest. Use the section below to browse a different audio."
      : "No annotations on your pod reference the currently loaded recordings. Use the section below to browse a different audio.";
  }
  let msg = "Found " + found + " annotation(s):";
  if (errorCount > 0) {
    msg +=
      " (couldn't reach " + errorCount + " source(s) — list may be incomplete)";
  }
  return msg;
}

function _selectAllInto(resultsEl) {
  resultsEl.querySelectorAll(".lh-v6-load-check").forEach((cb) => {
    if (!cb.checked) {
      cb.checked = true;
      cb.dispatchEvent(new Event("change"));
    }
  });
}

function _resultRow(entry, onToggle, onDelete, checked) {
  const title = entry.label || "(untitled)";
  const sub = el("span", { class: "lh-v6-load-sub" });
  const subParts = [];
  if (entry.created) {
    try { subParts.push(new Date(entry.created).toLocaleString()); } catch (_) { subParts.push(entry.created); }
  }
  subParts.push(entry.mmUri);
  sub.textContent = subParts.join(" — ");
  const titleRow = el("div", { class: "lh-v6-load-name-row" }, [
    el("span", { class: "lh-v6-load-name", text: title }),
    entry.aboutsScore
      ? el("span", {
          class: "lh-v6-load-pill lh-v6-load-pill-score",
          title: "Annotates the reference score (MEI)",
          text: "score",
        })
      : null,
  ]);
  const metaChildren = [titleRow, sub];
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
  checkbox.checked = !!checked;
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
  // Record intent and start waiting for sign-in: if the user logs in
  // within LOAD_INTENT_WINDOW_MS (and doesn't do anything else first) the
  // load modal auto-pops on the auth-changed event with a banner that
  // explains why. See _armLoadIntent.
  _armLoadIntent();
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

// How long after a logged-out "Load from Solid" click we keep waiting for
// the user to finish signing in before giving up on the auto-open.
// Generous (5 min) because the OAuth dance — choosing a provider, entering
// credentials, consenting — can be slow, especially in the login popup.
// The wait is cut short the moment the user does anything else (see
// _armLoadIntent).
const LOAD_INTENT_WINDOW_MS = 5 * 60 * 1000;

/**
 * Record the user's intent to load from Solid and begin waiting for them
 * to finish signing in. The timestamp is stored in sessionStorage so the
 * intent also survives the full-page redirect fallback used when the login
 * popup is blocked.
 *
 * While waiting, a → nudges rightward at the end of the "Load from Solid"
 * label, gesturing toward the login footer ("your move"). Once the user
 * clicks Connect and the OAuth exchange is in flight (signalled by the
 * `solid-login-started` event), the nudge gives way to a spinner — the app
 * is now the one working. If that attempt then fails or the user closes the
 * login popup (a not-logged-in `solid-auth-changed`), the spinner reverts to
 * the nudge so they can retry. The wait ends when:
 *   - sign-in completes within the window  → consumeLoadIntent auto-opens;
 *   - the window elapses                    → intent dropped silently;
 *   - the user does anything deliberate elsewhere in the app first
 *     (a pointer press or key press outside the Solid login footer / the
 *     Load button) → intent cancelled. Passive motion (scroll, hover,
 *     mousemove) is intentionally ignored so we don't drop the intent by
 *     accident. This stays active through the connecting phase too —
 *     interacting elsewhere cancels the auto-open even mid-login.
 */
function _armLoadIntent() {
  // Reset any prior arming so re-clicking Load restarts the window cleanly.
  _disarmLoadIntent();
  try {
    sessionStorage.setItem(
      "v6-load-intent",
      JSON.stringify({ ts: Date.now() }),
    );
  } catch (_) {}
  if (_loadBtn) _loadBtn.classList.add("lh-v6-ribbon-load--waiting");

  // Connect clicked → OAuth in flight: swap the "your move" nudge for a
  // spinner so we don't keep gesturing at the user once the popup is open.
  _loadIntentConnect = () => {
    if (_loadBtn) {
      _loadBtn.classList.remove("lh-v6-ribbon-load--waiting");
      _loadBtn.classList.add("lh-v6-ribbon-load--connecting");
    }
  };
  document.addEventListener("solid-login-started", _loadIntentConnect);

  // Login attempt ended without signing in (IdP error, or the user closed
  // the popup): drop the spinner and return to the "your move" nudge. The
  // intent is still live within the window, so the user can retry Connect.
  // Success (isLoggedIn:true) is handled by consumeLoadIntent, which
  // disarms before this fires.
  _loadIntentAbort = (e) => {
    if (e && e.detail && e.detail.isLoggedIn) return;
    if (_loadBtn) {
      _loadBtn.classList.remove("lh-v6-ribbon-load--connecting");
      _loadBtn.classList.add("lh-v6-ribbon-load--waiting");
    }
  };
  document.addEventListener("solid-auth-changed", _loadIntentAbort);

  _loadIntentCancel = (e) => {
    const t = e.target;
    // Interactions with the login footer (where Connect lives) or the Load
    // button itself are part of (re)initiating login — never cancel on those.
    if (t && t.closest && t.closest(".lh-v6-drawer-solid, .lh-v6-ribbon-load")) {
      return;
    }
    _disarmLoadIntent({ clearStorage: true });
  };
  // Capture phase so we still see the interaction even if a downstream
  // handler stops propagation.
  document.addEventListener("pointerdown", _loadIntentCancel, true);
  document.addEventListener("keydown", _loadIntentCancel, true);

  _loadIntentTimer = setTimeout(
    () => _disarmLoadIntent({ clearStorage: true }),
    LOAD_INTENT_WINDOW_MS,
  );
}

/**
 * Tear down the live waiting state set up by _armLoadIntent: drop the
 * nudge-arrow / spinner, remove the interaction and login-started
 * listeners, clear the expiry timer. Pass { clearStorage: true } to also
 * forget the stored intent (cancel / timeout paths); the consume path
 * leaves storage removal to consumeLoadIntent, which clears it as it reads.
 */
function _disarmLoadIntent({ clearStorage = false } = {}) {
  if (_loadIntentCancel) {
    document.removeEventListener("pointerdown", _loadIntentCancel, true);
    document.removeEventListener("keydown", _loadIntentCancel, true);
    _loadIntentCancel = null;
  }
  if (_loadIntentConnect) {
    document.removeEventListener("solid-login-started", _loadIntentConnect);
    _loadIntentConnect = null;
  }
  if (_loadIntentAbort) {
    document.removeEventListener("solid-auth-changed", _loadIntentAbort);
    _loadIntentAbort = null;
  }
  if (_loadIntentTimer) {
    clearTimeout(_loadIntentTimer);
    _loadIntentTimer = null;
  }
  if (_loadBtn) {
    _loadBtn.classList.remove(
      "lh-v6-ribbon-load--waiting",
      "lh-v6-ribbon-load--connecting",
    );
  }
  if (clearStorage) {
    try { sessionStorage.removeItem("v6-load-intent"); } catch (_) {}
  }
}

/**
 * If the user clicked Load-from-Solid while logged out within the last
 * LOAD_INTENT_WINDOW_MS and didn't cancel by interacting elsewhere,
 * consume the flag and return its timestamp so the caller knows to
 * auto-pop the modal. Returns null otherwise. Always tears down the live
 * waiting state (nudge-arrow/spinner/listeners/timer). Called from the
 * `solid-auth-changed{isLoggedIn:true}` handler in index.js.
 */
export function consumeLoadIntent() {
  let raw;
  try { raw = sessionStorage.getItem("v6-load-intent"); } catch (_) { raw = null; }
  // Sign-in has resolved — stop waiting regardless of the outcome below.
  _disarmLoadIntent();
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

