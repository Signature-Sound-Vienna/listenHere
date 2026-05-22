// V6 annotation rework — module entry point.
//
// Feature-flag-gated for development. Active iff one of:
//   - URL contains ?annot=v6 (which also persists the choice in localStorage)
//   - localStorage["annot-v6"] === "1"
//
// To switch back to legacy, load with ?annot=legacy (clears the localStorage flag).
//
// While the flag is off this module is a no-op; the legacy annotation.js stack
// continues to drive the annotation UI. The flag is removed in Phase F.

import * as state from "./state.js";
import * as adapter from "./mao-adapter.js";
import * as uiState from "./ui-state.js";
import { mountRibbon } from "./ui-ribbon.js";
import { mountDrawer } from "./ui-drawer.js";
import { mountPullTab } from "./ui-pull-tab.js";
import {
  initWaveformInteractions,
  syncWaveformRegions,
} from "./waveform-interactions.js";
import {
  postAnnotationToSolid,
  updateAnnotationOnSolid,
} from "./solid-post.js";
import { loadAnnotationFromMM, listAnnotationsForAudio } from "./solid-load.js";
import { _openLoadModal } from "./ui-ribbon.js";
import { solid } from "../solid.js";
import { setAnnoChangesPending, _regionsPlugins } from "../listen.js";

const STORAGE_KEY = "annot-v6";

/**
 * Persist V6 annotation state into the alignment.json object (so the
 * existing Save data button writes annotations too) and mark all V6
 * annotations as saved. Called from listen.js's Save-data click handler.
 *
 * Session-only fields (hasUnsavedChanges) are stripped; everything else
 * (regions, targets, group notes, comparisons, pinnedGrouping,
 * lastPostedUris) is written under a top-level `annotations` array.
 */
export function commitAnnotationsToAlignment(alignmentJSON) {
  if (!alignmentJSON) return;
  alignmentJSON.annotations = state.getAll().map(_serializeAnnotationForAlignment);
  state.markAllSaved();
}

function _serializeAnnotationForAlignment(a) {
  return {
    id: a.id,
    label: a.label,
    color: a.color,
    description: a.description,
    published: !!a.published,
    lastPostedUris: a.lastPostedUris || null,
    lastPostedHashes: a.lastPostedHashes || null,
    regions: a.regions.map((r) => ({ id: r.id, label: r.label || "" })),
    targets: a.targets.map((t) => ({
      file: t.file,
      description: t.description || "",
      regionTimes: _cloneRegionTimes(t.regionTimes),
    })),
    groupNotes: { ...a.groupNotes },
    comparisons: a.comparisons.map((c) => ({
      id: c.id,
      leftLabel: c.leftLabel,
      rightLabel: c.rightLabel,
      text: c.text || "",
    })),
    pinnedGrouping: a.pinnedGrouping
      ? {
          name: a.pinnedGrouping.name,
          groups: a.pinnedGrouping.groups.map((g) => ({
            label: g.label,
            color: g.color,
            files: [...g.files],
          })),
        }
      : null,
    schemaVersion: 1,
  };
}

function _cloneRegionTimes(rt) {
  const out = {};
  for (const k of Object.keys(rt || {})) {
    out[k] = { start: rt[k].start, end: rt[k].end };
  }
  return out;
}

/**
 * Load V6 annotation state from an alignment.json object. Called by
 * listen.js's setGrids after assigning loadedAlignmentJSON. Replaces the
 * full V6 state, so reloading a different alignment doesn't carry stale
 * annotations across.
 *
 * When V6 isn't active, no-ops (legacy code path handles its own load).
 */
export function loadAnnotationsFromAlignment(alignmentJSON) {
  if (!isV6Active()) return;
  if (!alignmentJSON || !Array.isArray(alignmentJSON.annotations)) {
    state.replaceAll([]);
    return;
  }
  state.replaceAll(alignmentJSON.annotations);
}

/**
 * Listen.js delegates region rendering to us when V6 is active so the
 * legacy anno_/draft_ rendering doesn't run alongside V6's v6_ regions.
 */
export function maybeSyncV6Regions() {
  if (!isV6Active()) return false;
  syncWaveformRegions();
  return true;
}

export function isV6Active() {
  let urlChoice = null;
  try {
    urlChoice = new URLSearchParams(window.location.search).get("annot");
  } catch (_) {}
  if (urlChoice === "v6") {
    try {
      localStorage.setItem(STORAGE_KEY, "1");
    } catch (_) {}
    return true;
  }
  if (urlChoice === "legacy") {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (_) {}
    return false;
  }
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch (_) {
    return false;
  }
}

export function initAnnotationV6() {
  if (!isV6Active()) return;
  console.info(
    "[annotation/v6] feature flag active — V6 module initialised (E1).",
  );

  // Mark the body so the scoped CSS rules apply (padding for ribbon, etc.).
  // Hide the legacy #maoExtracts container while V6 is the active UI.
  document.body.classList.add("lh-v6-active");
  const legacy = document.getElementById("maoExtracts");
  if (legacy) legacy.style.display = "none";

  // Mount the chrome: ribbon (bottom), drawer (right), pull-tab (in drawer-btns column).
  mountRibbon(document.body);
  mountDrawer(document.body);
  mountPullTab();

  // Bridge V6 state to the WaveSurfer regions plugins on each waveform.
  initWaveformInteractions();

  // Push V6 dirty state into the central Save-data indicator on every change.
  state.subscribe(() => setAnnoChangesPending(state.isAnyDirty()));

  // Expose state + adapter + uiState + the live _regionsPlugins map for
  // devtools inspection.
  window.__annotationV6 = {
    active: true,
    state,
    adapter,
    uiState,
    _regionsPlugins,
    commitAnnotationsToAlignment,
    loadAnnotationsFromAlignment,
    postAnnotationToSolid,
    updateAnnotationOnSolid,
    loadAnnotationFromMM,
    listAnnotationsForAudio,
  };

  // URL-param autoload: ?annot=v6&loadMM=<encoded MM URI> opens the load
  // modal pre-pointed at the given MM. We wait until the auth session is
  // actually logged in before firing — otherwise the modal would alert
  // "sign in first" and burn the autoload. The solid-auth-changed event
  // retries once login completes.
  let _autoloadConsumed = false;
  let _pendingMm = null;
  try {
    _pendingMm = new URLSearchParams(window.location.search).get("loadMM");
  } catch (_) {}
  function _maybeAutoload() {
    if (_autoloadConsumed || !_pendingMm) return;
    const sess = solid.getDefaultSession && solid.getDefaultSession();
    if (!sess || !sess.info || !sess.info.isLoggedIn) return; // wait for login
    _autoloadConsumed = true;
    _openLoadModal({ presetMm: _pendingMm });
  }
  if (_pendingMm) {
    document.addEventListener("solid-auth-changed", _maybeAutoload);
    _maybeAutoload();
  }

  // Adapter round-trip smoke runs once so we have a console-visible health check.
  try {
    const report = adapter.selfTest();
    if (report.passed) {
      console.info(
        `[annotation/v6] adapter self-test passed (${report.templateCount} templates).`,
      );
    } else {
      console.error("[annotation/v6] adapter self-test FAILED:", report.failures);
    }
  } catch (e) {
    console.error("[annotation/v6] adapter self-test threw:", e);
  }
}
