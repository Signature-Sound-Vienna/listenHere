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
import { setAnnoChangesPending, _regionsPlugins } from "../listen.js";

const STORAGE_KEY = "annot-v6";

/**
 * Phase E hook: persist V6 annotation state into the alignment.json object
 * (so the existing Save data button writes annotations too) and clear
 * per-annotation hasUnsavedChanges flags. For Phase B we just clear the
 * flags; the actual JSON serialisation lands in Phase E.
 */
export function commitAnnotationsToAlignment(_alignmentJSON) {
  // TODO Phase E: serialise state.getAll() into _alignmentJSON.annotations.
  state.markAllSaved();
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
    "[annotation/v6] feature flag active — Phase B UI mounting.",
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
  };

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
