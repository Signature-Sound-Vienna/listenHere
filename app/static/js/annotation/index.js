// V6 annotation rework — module entry point.
//
// As of Phase F this module is the only annotation UI: the legacy
// annotation.js stack and the `?annot=v6` feature flag have been removed.

import * as state from "./state.js";
import * as adapter from "./mao-adapter.js";
import * as uiState from "./ui-state.js";
import { mountRibbon, setPlayingAnnotations } from "./ui-ribbon.js";
import { mountDrawer } from "./ui-drawer.js";
import { mountPullTab } from "./ui-pull-tab.js";
import {
  initWaveformInteractions,
  syncWaveformRegions,
  setActiveRegionStart,
} from "./waveform-interactions.js";

export { setActiveRegionStart, setPlayingAnnotations };
import {
  postAnnotationToSolid,
  prewarmCaches,
  updateAnnotationOnSolid,
} from "./solid-post.js";
import { getAnnotationAccess, setAnnotationAccess } from "./solid-access.js";
import {
  deleteAnnotationFromPod,
  loadAnnotationFromMM,
  listAnnotationsForAudio,
  listAnnotationsForLoadedAudios,
} from "./solid-load.js";
import { openLoadModal, consumeLoadIntent } from "./ui-ribbon.js";
import { confirmLoadFromLink } from "./ui-common.js";
import { solid } from "../solid.js";
import {
  setAnnoChangesPending,
  waveformViews,
} from "../listen.js";

/**
 * Persist V6 annotation state into the alignment.json object (so the
 * existing Save data button writes annotations too) and mark all V6
 * annotations as saved. Called from listen.js's Save-data click handler.
 *
 * Session-only fields (hasUnsavedChanges) are stripped; everything else
 * (regions, targets, group notes, comparisons, pinnedGrouping,
 * detachedNotes, lastPostedUris) is written under a top-level `annotations`
 * array.
 */
export function commitAnnotationsToAlignment(alignmentJSON) {
  if (!alignmentJSON) return;
  alignmentJSON.annotations = serializeAnnotations();
  state.markAllSaved();
}

/** The annotations as a save writes them, WITHOUT marking anything saved —
 *  for session recovery's snapshots, which must not clear the dirty state. */
export function serializeAnnotations() {
  return state.getAll().map(_serializeAnnotationForAlignment);
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
    preservedSelections: Array.isArray(a.preservedSelections)
      ? [...a.preservedSelections]
      : [],
    regions: a.regions.map((r) => ({ id: r.id, label: r.label || "" })),
    targets: a.targets.map((t) => ({
      file: t.file,
      description: t.description || "",
      regionTimes: _cloneRegionTimes(t.regionTimes),
    })),
    groupNotes: { ...a.groupNotes },
    comparisons: a.comparisons.map((c) => ({
      id: c.id,
      leftGroupId: c.leftGroupId,
      rightGroupId: c.rightGroupId,
      text: c.text || "",
    })),
    pinnedGrouping: a.pinnedGrouping
      ? {
          name: a.pinnedGrouping.name,
          groups: a.pinnedGrouping.groups.map((g) => ({
            groupId: g.groupId,
            label: g.label,
            color: g.color,
            files: [...g.files],
          })),
        }
      : null,
    detachedNotes: (a.detachedNotes || []).map((d) => ({
      groupId: d.groupId,
      label: d.label,
      color: d.color,
      text: d.text || "",
    })),
    // v2: group notes/comparisons keyed by stable groupId (was label); adds
    // detachedNotes. Older v1 files load fine — state._normalise backfills
    // groupId = label, which is exactly how v1 keyed everything.
    schemaVersion: 2,
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
 */
export function loadAnnotationsFromAlignment(alignmentJSON) {
  if (!alignmentJSON || !Array.isArray(alignmentJSON.annotations)) {
    state.replaceAll([]);
    return;
  }
  state.replaceAll(alignmentJSON.annotations);
}

/**
 * Listen.js delegates region rendering to V6 so legacy anno_/draft_
 * rendering doesn't run alongside V6's v6_ regions. Returns true for
 * compatibility with the previous flag-aware shape.
 */
export function maybeSyncV6Regions() {
  syncWaveformRegions();
  return true;
}

export function initAnnotationV6() {
  console.info("[annotation/v6] module initialised.");

  // Mark the body so the scoped CSS rules apply (padding for ribbon, etc.).
  document.body.classList.add("lh-v6-active");

  // Mount the chrome: ribbon (bottom), drawer (right), pull-tab (in drawer-btns column).
  mountRibbon(document.body);
  mountDrawer(document.body);
  mountPullTab();

  // Bridge V6 state to the WaveSurfer regions plugins on each waveform.
  initWaveformInteractions();

  // Push V6 dirty state into the central Save-data indicator on every change.
  state.subscribe(() => setAnnoChangesPending(state.isAnyDirty()));

  // Expose state + adapter + uiState + the live waveformViews map (each view
  // carries its RegionsPlugin as `.regions`) for devtools inspection.
  window.__annotationV6 = {
    active: true,
    state,
    adapter,
    uiState,
    waveformViews,
    commitAnnotationsToAlignment,
    loadAnnotationsFromAlignment,
    postAnnotationToSolid,
    updateAnnotationOnSolid,
    getAnnotationAccess,
    setAnnotationAccess,
    loadAnnotationFromMM,
    listAnnotationsForAudio,
    listAnnotationsForLoadedAudios,
    deleteAnnotationFromPod,
  };

  // Two auto-open paths for the Load-from-Solid modal:
  //   (a) URL-param autoload: ?annot=v6&loadMM=<encoded MM URI> pops the
  //       modal pre-pointed at the given MM once auth completes. Survives
  //       bookmark sharing.
  //   (b) Load-intent resume: if the user clicked Load-from-Solid while
  //       logged out and then signed in within the window defined in
  //       ui-ribbon.js (5 min) without interacting elsewhere first, we
  //       re-open the modal automatically with a small "Signed in —
  //       resuming…" banner.
  // Both are checked on `solid-auth-changed`. The URL-param path takes
  // priority because it carries a specific target.
  let _autoloadConsumed = false;
  let _pendingMm = null;
  try {
    _pendingMm = new URLSearchParams(window.location.search).get("loadMM");
  } catch (_) {}

  function _onAuthChanged() {
    const sess = solid.getDefaultSession && solid.getDefaultSession();
    const isLoggedIn = !!(sess && sess.info && sess.info.isLoggedIn);
    if (!isLoggedIn) return;
    // Pre-warm the post-orchestrator's container cache in the background,
    // so the first post doesn't pay for it. Per-recording discovery
    // resources are NOT warmed: one HEAD (and PUT) per recording after
    // login overran solidcommunity.net's request limit (429); they are
    // established on demand, for the recordings a post targets.
    prewarmCaches();
    if (!_autoloadConsumed && _pendingMm) {
      _autoloadConsumed = true;
      // The presetMm path bypasses the resumed banner — the user landed
      // here via a shared link, not an in-session intent. A link can name
      // any address, so nothing is fetched until the user agrees.
      const mm = _pendingMm;
      if (!/^https?:\/\//i.test(mm)) {
        console.warn("[annotation/v6] ignoring a loadMM that isn't an http(s) address:", mm);
        return;
      }
      confirmLoadFromLink(mm).then((ok) => {
        if (ok) openLoadModal({ presetMm: mm });
      });
      return;
    }
    const intent = consumeLoadIntent();
    if (intent) {
      openLoadModal({ resumed: true });
    }
  }

  document.addEventListener("solid-auth-changed", _onAuthChanged);
  // Fire once at init in case the session is already authenticated
  // (e.g. page reload mid-session).
  _onAuthChanged();

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
