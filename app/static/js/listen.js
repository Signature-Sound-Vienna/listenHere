// Re-export globals set by the template's inline <script>
export let versionString = window.versionString;
export let versionDate = window.versionDate;

import { initSolidAuth } from "./solid.js";
import { confirmDialog, el } from "./annotation/ui-common.js";
import * as v6UiState from "./annotation/ui-state.js";
import * as v6State from "./annotation/state.js";
import WaveSurfer from "../vendor/wavesurfer.esm.js";
import RegionsPlugin from "../vendor/wavesurfer-regions.esm.js";
import HoverPlugin from "../vendor/wavesurfer-hover.esm.js";
import {
  maybeBuildWindowedPlayer,
  teardownNormGainNode,
  applyNormGain,
  seekAnalysis,
} from "./engine/normalization.js";
import {
  seekBy,
  playpause,
} from "./engine/transport.js";
import {
  interpAlignmentGrid,
  parseMidi,
  tickToSec,
  fmtSec,
  synthToWav,
} from "./engine/mei-synth.js";
import {
  waveformViews,
  isWaveformRendered,
  setRegionsPlugin,
  regionsPluginEntries,
  drawAlignmentGrid,
  updatePositionIndicator,
  disposeWaveformView,
  clearWaveformViews,
} from "./engine/waveform-view.js";
import {
  wireWaveformEvents,
  onWaveformReady,
} from "./engine/waveform-events.js";
import { createWaveformRow } from "./engine/waveform-layout.js";
import { openGroupModal } from "./engine/group-modal.js";
import {
  ensureWaveformGroupContainers,
  renderGroupingTabPills,
  renderSidebarFileList,
  updateGroupCounts,
} from "./engine/grouping-ui.js";
import {
  configureGroupingCore,
  getActiveFileGroups,
  resolveGroupFor,
} from "./engine/grouping-core.js";
import {
  getActiveGroupingSnapshot,
  migrateToGroupingTabs,
  normaliseGroupOverlap,
  warnGroupOverlap,
} from "./engine/grouping-model.js";
import {
  initAlignPanel,
  configure as configureAlign,
  setVerovioPromise,
} from "./align.js";
import {
  attachFixEntryButton,
  fixModeOnPieceReset,
  fixModePrewarm,
  fixTestState,
  fixTestControl,
  isFixModeActive,
  fixRealignBusy,
  applyFixCorrectionUndo,
  applyFixCorrectionRedo,
  fixCorrectionsDirty,
  fixRevertCorrections,
} from "./fix-mode.js";
import {
  initAnnotationV6,
  commitAnnotationsToAlignment,
  loadAnnotationsFromAlignment,
  maybeSyncV6Regions,
  setActiveRegionStart,
  setPlayingAnnotations,
} from "./annotation/index.js";
import {
  ZOOM_LEVELS,
  currentZoomLevel,
  scrollMode,
  setScrollMode,
  setSharedTimeAxis,
  setCurrentZoomLevel,
  applyZoom,
  getScrollContainer,
  getZoomedWidth,
  syncOverlayScroll,
  applyScrollMode,
  syncAllWaveformScrolls,
  setScrollSyncLock,
} from "./engine/zoom-scroll.js";
import {
  DataSession,
  refillArray,
  clearMap,
  gridFingerprint,
} from "./engine/data-session.js";
import {
  initMeasureInteractions,
  clearMeasureVisuals,
} from "./engine/measure.js";
import { updateAllRegionNavArrows } from "./engine/region-nav.js";
// Aliased because listen.js keeps wrappers under the historic names, which every
// existing call site (here and in six sibling modules) still uses.
import {
  getClosestAlignmentIx as _coreClosestAlignmentIx,
  getCorrespondingTime as _coreCorrespondingTime,
} from "./engine/align-core.js";
import {
  redrawAllMarkers,
  clearMarkers,
  addMarker,
  updateMarkerDraggableClass,
  seekToActiveMarker,
  persistMarkers,
} from "./engine/markers.js";
// Preserve the public API: annotation/waveform-interactions.js reaches the
// per-waveform renderer registry through listen.js rather than importing the
// engine module directly, as it did for the overlay wrappers before increment
// 19 folded that store into the view.
export { waveformViews, isWaveformRendered, regionsPluginEntries };
// Re-exported for the V6 annotation layer, which reads the pinned grouping
// through listen.js (annotation/{state,ui-editor,ui-ribbon}.js).
export { getActiveGroupingSnapshot };

// ---------------------------------------------------------------------------
// The one DataSession for this screen.
//
// Listen Here is the single-session, single-viewport reference application, so
// there is exactly one. State migrated into it (see engine/data-session.js) is
// aliased below under its historical name and re-exported unchanged, keeping
// this module's public API — and therefore every sibling module — untouched.
// ---------------------------------------------------------------------------
const session = new DataSession();

// Owned by the DataSession (Wave B). Rebinds became in-place resets, so the
// aliases stay valid for every call site and every importing module.
export const markers = session.markers;
export const loaded = session.loaded;
// Verovio timemap. Exported for fix-mode.js, which maps onset quarters to the
// xml:ids sounding at them (reference-stable: refilled in place, never rebound).
export const timemap = session.timemap;
let parser = new DOMParser(); // XML parser for MEI
let ref;
let colorMap;

// ---------------------------------------------------------------------------
// Wave C mirrors of DataSession primitives.
//
// A primitive can't be aliased by reference, and several of these are imported
// by sibling modules as ESM live bindings, so each is MIRRORED here: `session`
// is the store, these bindings are the read path, and every write goes through
// the matching setter below (grep-verified: no bare assignments remain). Keeping
// the mirrors means all ~250 read sites and every importer stay untouched.
//
// The mirrors are scaffolding. When call sites take a session explicitly
// (multi-viewport), they disappear and reads become session.x.
// ---------------------------------------------------------------------------
export let currentAudioIx = session.currentAudioIx;
export let alignmentGrids = session.alignmentGrids;
export let scoreAlignment = session.scoreAlignment; // score tstamp to ref tstamp maps for onset and offset

// Corrected synth timing tables (seconds in the client-rendered synth audio),
// derived in _buildAndPrepareSynthWaveform by matching the alignment's score
// quarters against the MIDI Verovio actually rendered here. Alignment JSONs
// generated before align-worker.js's tempo-sort fix carry skewed
// synth_onset/synth_offset wherever the MIDI opens with a real tempo event
// (the seeded 120 BPM default won the tick-0 tie), so consumers prefer these
// and fall back to the stored scoreAlignment values while they are null
// (no synth waveform prepared yet, or qstamp matching failed).
export let correctedSynthOnsets = null;
export let correctedSynthOffsets = null;
let mei = session.mei; // MEI XML
let meiDOM = session.meiDOM; // MEI DOM
let referenceAudioIx = session.referenceAudioIx;
export let tk = session.tk; // verovio toolkit — exported so V6's loader can project score-element IDs to ref-audio times when loading score annotations.

function setCurrentAudioIx(v) {
  return (currentAudioIx = session.currentAudioIx = v);
}
function setAlignmentGrids(v) {
  return (alignmentGrids = session.alignmentGrids = v);
}
function setScoreAlignment(v) {
  // New score alignment → any previously derived corrected tables are stale.
  correctedSynthOnsets = null;
  correctedSynthOffsets = null;
  return (scoreAlignment = session.scoreAlignment = v);
}
function setMei(v) {
  return (mei = session.mei = v);
}
/** The loaded MEI XML text (fix-mode re-lays the score out from it). */
export function getMeiXml() {
  return mei;
}
function setMeiDOM(v) {
  return (meiDOM = session.meiDOM = v);
}
function setReferenceAudioIx(v) {
  return (referenceAudioIx = session.referenceAudioIx = v);
}
function setTk(v) {
  return (tk = session.tk = v);
}

/** Re-read every mirror from the session. Needed after session.reset(). */
function _syncMirrorsFromSession() {
  currentAudioIx = session.currentAudioIx;
  alignmentGrids = session.alignmentGrids;
  scoreAlignment = session.scoreAlignment;
  mei = session.mei;
  meiDOM = session.meiDOM;
  referenceAudioIx = session.referenceAudioIx;
  activeMarkerIx = session.activeMarkerIx;
  tk = session.tk;
  storage = session.storage;
  meiUri = session.meiUri;
  loadedAlignmentJSON = session.loadedAlignmentJSON;
}

// seconds by which to nudge markers when arrow keys pressed in close-listening mode
const smallMarkerNudge = 0.02;
const bigMarkerNudge = 0.1;

export let storage = session.storage;
export let meiUri = session.meiUri;
function setStorage(v) {
  return (storage = session.storage = v);
}
function setMeiUri(v) {
  return (meiUri = session.meiUri = v);
}
export const wavesurfers = session.view.wavesurfers; // filename -> WaveSurfer renderer
// Owned by the DataSession (Wave A). Reference-stable: never rebound, so these
// aliases stay valid for every call site and every importing module.
export const waveformPeaks = session.waveformPeaks; // filename -> { peaks: number[], duration: number } when pre-computed

// Audio normalization + windowed-player lifecycle extracted to
// ./engine/normalization.js (Phase 1 refactor). seekAnalysis is imported above
// for the reload-time .clear(); other norm state is private to that module.
const _preparing = new Set(); // filenames mid-(async)-prepareWaveform, to avoid double-create

// ---------------------------------------------------------------------------
// Lazy waveform creation (roadmap item L)
//
// A recording with 55 renditions used to create 55 WaveSurfer instances and
// fetch 55 long audio files at once, on one main thread. Above the threshold
// below, the pane instead lays out every ROW up front — so scroll extent,
// grouping and ordering are correct from the start — and builds each renderer
// only when its row comes near the viewport, or when the user asks for that
// recording by name.
//
// That splits two things `wavesurfers` used to answer together: which
// recordings are in the pane (now waveformViews' key set — the working set) and
// which have a live renderer (still wavesurfers). Anything iterating one when
// it means the other is a bug; the sites that had to change are marked
// "working set" in comments.
// ---------------------------------------------------------------------------

/** Recording count above which a piece defers off-screen waveforms. */
const LAZY_WAVEFORM_THRESHOLD = 12;
/**
 * How far outside the pane a row counts as "near". A whole pane-height of
 * prefetch on each side, so ordinary scrolling meets waveforms that are already
 * built rather than watching them appear.
 */
const LAZY_ROOT_MARGIN = "100% 0px";
/**
 * How many deferred waveforms may be mid-build at once. Without this, flicking
 * the scrollbar past forty rows would fire forty creations together — exactly
 * the pile-up deferral exists to prevent.
 */
const MATERIALIZE_CONCURRENCY = 4;
/** A build that never signals ready must not wedge the queue behind it. */
const MATERIALIZE_WATCHDOG_MS = 30_000;

/** Does the loaded piece have enough recordings to be worth deferring? */
let _lazyWaveforms = false;
/** Working-set members with a row but no renderer yet. */
const _deferred = new Set();
/** Deferred filenames the observer has asked for, awaiting a build slot. */
const _materializeQueue = [];
/** Filenames currently being built, i.e. holding a concurrency slot. */
const _materializing = new Map(); // filename -> watchdog timer id
let _wfIntersectionObserver = null;

/**
 * Should this waveform's renderer wait until its row is near the viewport?
 *
 * The score is always built eagerly: it is synthesised rather than fetched, its
 * blob arrives asynchronously through a separate path, and there is exactly one
 * of it — so it is never part of the pile-up this defers.
 */
function _shouldDeferWaveform(filename) {
  return _lazyWaveforms && filename !== SYNTH_MEI_KEY;
}

/**
 * Park a waveform: mark the row, say so in place of a spinner that would never
 * resolve, and hand it to the observer.
 */
function _deferWaveform(filename, wfEl) {
  _deferred.add(filename);
  wfEl.classList.add("wf-deferred");
  hideWaveformOverlay(wfEl);
  let note = wfEl.querySelector(".wf-deferred-note");
  if (!note) {
    note = document.createElement("div");
    note.className = "wf-deferred-note";
    const name = document.createElement("span");
    name.className = "wf-deferred-name";
    const hint = document.createElement("span");
    hint.className = "wf-deferred-hint";
    hint.textContent = "loads when scrolled into view";
    note.append(name, hint);
    wfEl.appendChild(note);
  }
  note.querySelector(".wf-deferred-name").textContent = filename.substring(
    filename.lastIndexOf("/") + 1,
  );
  _setSidebarFileState(filename, "queued");
  _observeWaveformRow(wfEl);
}

/** Undo _deferWaveform, because this waveform is being built now. */
function _undeferWaveform(filename) {
  if (!_deferred.delete(filename)) return;
  const wfEl = waveformViews[filename]?.container;
  if (wfEl) {
    wfEl.classList.remove("wf-deferred");
    wfEl.querySelector(".wf-deferred-note")?.remove();
    _wfIntersectionObserver?.unobserve(wfEl);
  }
  _setSidebarFileState(filename, "loading");
}

/**
 * Set the sidebar entry's single state class. "queued" is the deferred state:
 * in the pane, waiting on the viewport — distinct from "loading", which means
 * a build is actually under way.
 */
function _setSidebarFileState(filename, state) {
  const label = document.getElementById(filename)?.querySelector("label");
  if (!label) return;
  label.classList.remove("queued", "loading", "ready");
  if (state) label.classList.add(state);
}

/** Watch one row, creating the shared observer on first use. */
function _observeWaveformRow(wfEl) {
  if (!_wfIntersectionObserver) {
    const root = document.getElementById("waveforms");
    if (!root || typeof IntersectionObserver === "undefined") {
      // No observer available: build it rather than stranding the row.
      _requestMaterialize(wfEl.dataset.ix);
      return;
    }
    _wfIntersectionObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const fn = entry.target.dataset.ix;
          if (fn) _requestMaterialize(fn);
        }
      },
      { root, rootMargin: LAZY_ROOT_MARGIN, threshold: 0 },
    );
  }
  _wfIntersectionObserver.observe(wfEl);
}

/** Queue a deferred waveform for building as soon as a slot is free. */
function _requestMaterialize(filename) {
  if (!filename || !_deferred.has(filename)) return;
  if (_materializeQueue.includes(filename) || _materializing.has(filename))
    return;
  _materializeQueue.push(filename);
  _pumpMaterializeQueue();
}

function _pumpMaterializeQueue() {
  while (
    _materializing.size < MATERIALIZE_CONCURRENCY &&
    _materializeQueue.length
  ) {
    const filename = _materializeQueue.shift();
    // It may have been built by an explicit request, or pruned, while queued.
    if (!_deferred.has(filename)) continue;
    _materializeNow(filename);
  }
}

/**
 * Build one waveform now, holding a concurrency slot until it reports ready (or
 * fails, or the watchdog fires). The slot is held across the audio load, not
 * just the synchronous setup — otherwise the cap would gate nothing.
 */
function _materializeNow(filename, playPosition = 0, isPlaying = false) {
  if (!_materializing.has(filename)) {
    _materializing.set(
      filename,
      setTimeout(() => {
        console.warn("waveform build did not settle in time:", filename);
        materializeSettled(filename);
      }, MATERIALIZE_WATCHDOG_MS),
    );
  }
  return Promise.resolve(
    materializeWaveform(filename, playPosition, isPlaying),
  ).catch((e) => {
    console.warn("waveform build failed for", filename, e);
    materializeSettled(filename);
  });
}

/** Release this waveform's build slot and let the next one start. */
export function materializeSettled(filename) {
  const timer = _materializing.get(filename);
  if (timer === undefined) return;
  clearTimeout(timer);
  _materializing.delete(filename);
  _pumpMaterializeQueue();
}

/** Forget every deferral — used by the two full-teardown paths. */
function _clearDeferredWaveforms() {
  for (const timer of _materializing.values()) clearTimeout(timer);
  _materializing.clear();
  _materializeQueue.length = 0;
  _deferred.clear();
  _wfIntersectionObserver?.disconnect();
  _wfIntersectionObserver = null;
}

/**
 * Resolve once this waveform has finished loading. Used before swapping onto a
 * recording that had to be built first: swapping needs a real duration, and
 * until "ready" fires getDuration() is 0.
 */
function _whenWaveformReady(filename) {
  if (loaded.has(filename)) return Promise.resolve();
  const ws = wavesurfers[filename];
  if (!ws) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, MATERIALIZE_WATCHDOG_MS);
    ws.once("ready", done);
    ws.once("error", done);
  });
}

/** Return the pre-computed peak data for a filename, or null if unavailable. */
export function getWaveformPeaks(filename) {
  const p = waveformPeaks[filename];
  return p && p.peaks ? p : null;
}

/** Return the current reference audio key (alignment header.ref). */
export function getReferenceAudioIx() {
  return referenceAudioIx;
}

/** Return all alignment-grid keys (i.e. audio filenames loaded). */
export function getAlignmentKeys() {
  return Object.keys(alignmentGrids);
}

/** Return the alignment-grid index closest to a given time on a given waveform. */
export { getClosestAlignmentIx };

/**
 * Resolve the linked-data URI for an audio file (alignment key).
 * Priority: per-file full URI > prefix + ldFilename > prefix + filename > bare filename.
 */
export function getAudioLinkedDataUri(filename) {
  const header = loadedAlignmentJSON?.header;
  const perFile = header?.linkedDataUris?.[filename];
  if (perFile?.uri) return perFile.uri;
  const prefix = header?.linkedDataUriPrefix || "";
  const name = perFile?.ldFilename || filename;
  if (prefix) return prefix.replace(/\/$/, "") + "/" + name;
  return name;
}

// File picker: maps alignment audio keys to blob URLs from user-selected files
const fileBlobUrls = session.fileBlobUrls;
export const fileBlobs = session.fileBlobs; // alignment audio keys -> File/Blob objects
let useFilesMode = false;
let _fromAlignmentHandoff = false;

// Synthesised MEI waveform: key used in wavesurfers / alignmentGrids for the synth track
export const SYNTH_MEI_KEY = "Score (synthesised from MEI)";

// Point the grouping read model (engine/grouping-core.js, zero imports) at this
// application's state. Done here rather than in an init function because the
// grouping question can be asked from any render path, and because a getter for
// `loadedAlignmentJSON` reads the live binding on each call — it is declared
// further down, but only ever read from inside a function body.
configureGroupingCore({
  getAlignment: () => loadedAlignmentJSON,
  SYNTH_MEI_KEY,
});
// Maps SYNTH_MEI_KEY -> blob URL once synthesis is done, or the sentinel '__pending__'
const _synthBlobUrls = session.synthBlobUrls; // DataSession-owned (Wave A)

// HTTP Basic Auth: scoped per-origin to avoid leaking credentials
// Maps origin string -> fetchParams objects: { headers: { Authorization: 'Basic ...' } }
const authByOrigin = session.authByOrigin;
const authPromptedOrigins = session.authPromptedOrigins;

// Close-listening mode state
export let closeListeningMode = false;

// jumpToTarget mode: show numbered overlays on on-screen waveforms
let _jumpToTargetActive = false;
let _jumpToTargetWaveforms = []; // snapshot of badged waveforms for the current session
// The active close-listening "jump target" is EITHER a marker OR an
// active-annotation region start. At most one of these is non-null at a time:
//   activeMarkerIx     — index into markers[] when the target is a marker
//   _activeRegionStart — { annId, regionId } when the target is a region start
export let activeMarkerIx = session.activeMarkerIx; // index into markers[] array
export function setActiveMarkerIx(v) {
  return (activeMarkerIx = session.activeMarkerIx = v);
}
let _activeRegionStart = null; // { annId, regionId } | null

/** Set/clear the active region-start target and its left-border indicator. */
function _setActiveRegionStart(ref) {
  _activeRegionStart = ref || null;
  setActiveRegionStart(_activeRegionStart);
}

function getOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function xhrOptionsForUrl(url) {
  const origin = getOrigin(url);
  if (origin && authByOrigin.has(origin)) {
    return authByOrigin.get(origin);
  }
  return {};
}

function promptForAuth(failedUrl) {
  const origin = getOrigin(failedUrl);
  if (!origin || authPromptedOrigins.has(origin)) return false;
  authPromptedOrigins.add(origin);
  const user = prompt(
    `Audio server ${origin} requires authentication.\nUsername:`,
  );
  if (user === null) return false;
  const pass = prompt("Password:");
  if (pass === null) return false;
  const token = btoa(user + ":" + pass);
  authByOrigin.set(origin, {
    headers: { Authorization: "Basic " + token },
  });
  return true;
}

function reloadWaveformsForOrigin(authedOrigin) {
  // Only reload waveforms whose audio URL matches the authenticated origin
  for (const [filename, ws] of Object.entries(wavesurfers)) {
    const url = resolveAudioUrl(filename);
    if (getOrigin(url) === authedOrigin) {
      ws.setOptions({ fetchParams: authByOrigin.get(authedOrigin) });
      ws.load(url);
    }
  }
}

try {
  setStorage(window.localStorage);
} catch (err) {
  console.warn("unable to access local storage: ", err);
}

export function resolveAudioUrl(filename) {
  // Synthesised MEI audio: return blob URL once ready, or null while still being synthesised
  if (_synthBlobUrls.has(filename)) {
    const _u = _synthBlobUrls.get(filename);
    return _u === "__pending__" ? null : _u;
  }
  // If ?useFiles is active and we have a blob URL for this file, use it
  if (useFilesMode && fileBlobUrls.has(filename)) {
    return fileBlobUrls.get(filename);
  }
  // If ?useLocal is present, override with local base URL
  let useLocal = params.get("useLocal");
  if (useLocal !== null) {
    let base = useLocal || "http://127.0.0.1:8080";
    let name = filename.split("/").pop();
    return base.replace(/\/$/, "") + "/" + name;
  }
  // Full URLs: load directly from the web
  if (filename.startsWith("http://") || filename.startsWith("https://")) {
    return filename;
  }
  // Relative paths: load from local static files
  return root + "wav/" + filename;
}

// --- Resize handling ---

let _resizeDebounce = null;

// Per-waveform closures that repaint the position indicator on every canvas.
// Registered in each waveform's "ready" handler. DataSession-owned (Wave A),
// per-viewport in the target model.
// Per-waveform closures that redraw the alignment grid canvas.

// ---------------------------------------------------------------------------
// Zoom & scroll state
// ---------------------------------------------------------------------------
// Zoom state (ZOOM_LEVELS, currentZoomLevel, scrollMode, sharedTimeAxis) moved
// to ./engine/zoom-scroll.js and imported below; the overlay wrappers it used to
// own are now waveform-view.js's waveformViews[filename].ow.
// The cross-waveform scroll-sync lock moved to ./engine/zoom-scroll.js too
// (increment 23): it guards re-entry into that module's syncAllWaveformScrolls,
// and that module is the declared per-viewport home. This file only ever WROTE
// it — the two sites below call setScrollSyncLock.
export const wfBgCache = {}; // filename → cached tick background colour string

// ---------------------------------------------------------------------------
// Tempo curve state
// ---------------------------------------------------------------------------
let _tempoCurveVisible = false;
let _tempoCurveMode = "absolute"; // "absolute" | "relative"
let _tempoCurveSmoothing = 0; // 0–10 window size for Gaussian smoothing
let _tempoScopeWithinGroup = false; // true = within group, false = across groups
let _tempoScopeDisplayedOnly = false; // true = restrict to displayed files
const _tempoRawCache = {}; // filename → [{time, tempo}] (unsmoothed)
let _tempoYRange = null; // {min, max} — uniform across waveforms, recomputed on scope/mode change

// Outlier threshold: values deviating from the median by more than this
// many scaled MADs are treated as outliers — both for Y-axis clipping
// and for exclusion from the corpus reference in relative mode.
// Scaled MAD ≈ 1.4826 × MAD approximates SD for normal data, so
// TEMPO_OUTLIER_K = 2 corresponds to ≈ 2 standard deviations.
const TEMPO_OUTLIER_K = 2;
const _TEMPO_OUTLIER_SCALE = TEMPO_OUTLIER_K * 1.4826; // pre-computed

/**
 * Compute raw (unsmoothed) tempo data points for a single audio file.
 * Returns [{time, scoreTime, tempo}] where time is in seconds (in this
 * file's timeline), scoreTime is in quarter-note units, and tempo is in QPM.
 *
 * Approach: build a monotonic (scoreTime → audioTime) mapping, then
 * resample at regular score-time intervals (every TEMPO_RESAMPLE_QN
 * quarter notes).  Tempo = ΔQN / Δt × 60 between consecutive samples.
 * This inherently smooths chord duplicates, grace notes, and alignment
 * quantisation noise.
 *
 * Quarter-note positions are sourced from the Verovio timemap (qstamp)
 * when available, avoiding a dependency on MIDI tick resolution (TPQ).
 * Falls back to scoreAlignment.score_onset (tick / TPQ) for older
 * alignment data that predates timemap support.
 */
const TEMPO_RESAMPLE_QN = 1; // resample every 1 quarter-note

function _computeRawTempo(filename) {
  if (!scoreAlignment || !scoreAlignment.ref_onset) return [];
  const refOnsets = scoreAlignment.ref_onset;

  const refGrid = alignmentGrids[referenceAudioIx];
  const fileGrid = alignmentGrids[filename];
  if (!refGrid || !refGrid.length || !fileGrid || !fileGrid.length) return [];

  // Binary search: find the grid index whose value is closest to t
  function gridIxForTime(grid, t) {
    let lo = 0,
      hi = grid.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (grid[mid] <= t) lo = mid + 1;
      else hi = mid;
    }
    const ix = Math.max(0, lo - 1);
    if (
      ix < grid.length - 1 &&
      Math.abs(grid[ix + 1] - t) < Math.abs(grid[ix] - t)
    )
      return ix + 1;
    return ix;
  }

  // Prefer Verovio timemap qstamp values (authoritative quarter-note positions
  // from the MEI) over MIDI-tick-derived score_onset.  The timemap tstamp
  // (MIDI ms) maps to synth-audio seconds, which feeds into the same
  // alignment-grid lookup as before.  Falls back to score_onset if no timemap.
  let onsets; // quarter-note positions
  let synthTimes; // corresponding synth-audio seconds (for grid mapping)
  if (timemap && timemap.length > 1) {
    // Extract non-measure entries that carry note events
    const entries = timemap.filter((e) => "qstamp" in e && !("measureOn" in e));
    if (entries.length > 1) {
      onsets = entries.map((e) => e.qstamp);
      synthTimes = entries.map((e) => e.tstamp / 1000); // MIDI ms → seconds
    }
  }
  if (!onsets || onsets.length < 2) {
    // Fallback: use MIDI-tick-derived values from score alignment
    if (!scoreAlignment.score_onset || scoreAlignment.score_onset.length < 2)
      return [];
    onsets = scoreAlignment.score_onset;
    // Prefer the corrected table: it is what the synth alignment grid was
    // built from, and stored synth_onset may carry the pre-fix tempo skew.
    synthTimes = correctedSynthOnsets || scoreAlignment.synth_onset || null;
  }

  // 1. Build deduplicated, monotonic (scoreTime → audioTime) pairs.
  //    For duplicate score onsets (chords), keep only the first.
  //    Enforce monotonicity in audioTime (skip retrograde mappings).
  const synthGrid = alignmentGrids[SYNTH_MEI_KEY];
  const useSynthGrid = !!(synthTimes && synthGrid && synthGrid.length);
  const pairs = []; // [{s, t}]  s = score QN, t = audio seconds
  let prevS = -Infinity,
    prevT = -Infinity;
  for (let i = 0; i < onsets.length; i++) {
    const s = onsets[i];
    if (s <= prevS) continue; // skip duplicate / non-advancing score time
    // Map to target file time via alignment grids.
    // When synth times are available, search the synth alignment grid to
    // find the shared grid index, then read fileGrid at that index directly
    // (all alignment grids are parallel arrays indexed by the same positions).
    // Otherwise fall back to searching refGrid for ref_onset[i].
    let gIdx;
    if (useSynthGrid && i < synthTimes.length) {
      gIdx = gridIxForTime(synthGrid, synthTimes[i]);
    } else if (i < refOnsets.length) {
      gIdx = gridIxForTime(refGrid, refOnsets[i]);
    } else {
      continue;
    }
    const t = fileGrid[Math.min(gIdx, fileGrid.length - 1)];
    if (t <= prevT) continue; // skip non-advancing audio time
    pairs.push({ s, t });
    prevS = s;
    prevT = t;
  }
  if (pairs.length < 2) return [];

  // 2. Resample at regular score-time intervals via linear interpolation.
  const sMin = pairs[0].s;
  const sMax = pairs[pairs.length - 1].s;
  const step = TEMPO_RESAMPLE_QN;
  const samples = []; // [{s, t}]
  let pairIdx = 0;
  for (let sq = Math.ceil(sMin / step) * step; sq <= sMax; sq += step) {
    // Advance pairIdx so pairs[pairIdx].s <= sq < pairs[pairIdx+1].s
    while (pairIdx < pairs.length - 2 && pairs[pairIdx + 1].s <= sq) pairIdx++;
    const p0 = pairs[pairIdx],
      p1 = pairs[pairIdx + 1];
    const frac = p1.s - p0.s > 0 ? (sq - p0.s) / (p1.s - p0.s) : 0;
    const tInterp = p0.t + frac * (p1.t - p0.t);
    samples.push({ s: sq, t: tInterp });
  }

  // 3. Compute instantaneous tempo between consecutive samples.
  const points = [];
  for (let i = 0; i < samples.length - 1; i++) {
    const ds = samples[i + 1].s - samples[i].s; // quarter notes (= step)
    const dt = samples[i + 1].t - samples[i].t; // seconds
    if (dt <= 0) continue;
    const tempo = (ds / dt) * 60; // QPM
    const time = (samples[i].t + samples[i + 1].t) / 2; // mid-point in audio time
    points.push({ time, scoreTime: samples[i].s + ds / 2, tempo });
  }
  return points;
}

/**
 * Get (cached) raw tempo data for a file. Cache is invalidated when
 * alignment grids change (caller must clear _tempoRawCache on grid reload).
 */
function _getRawTempo(filename) {
  if (!_tempoRawCache[filename])
    _tempoRawCache[filename] = _computeRawTempo(filename);
  return _tempoRawCache[filename];
}

/**
 * Apply Gaussian smoothing to tempo points.
 * windowSize 0 = no smoothing; higher = more smoothing.
 */
function _smoothTempo(points, windowSize) {
  if (windowSize <= 0 || points.length <= 1) return points;
  const out = [];
  for (let i = 0; i < points.length; i++) {
    let wSum = 0,
      wCount = 0;
    for (
      let j = Math.max(0, i - windowSize);
      j <= Math.min(points.length - 1, i + windowSize);
      j++
    ) {
      const d = (j - i) / windowSize;
      const w = Math.exp(-2 * d * d);
      wSum += points[j].tempo * w;
      wCount += w;
    }
    out.push({
      time: points[i].time,
      scoreTime: points[i].scoreTime,
      tempo: wSum / wCount,
    });
  }
  return out;
}

/**
 * Get the set of filenames for the current tempo scope.
 *
 * Two independent dimensions:
 *   _tempoScopeWithinGroup: true = same group as forFilename; false = all groups
 *   _tempoScopeDisplayedOnly: true = restrict to currently displayed files
 */
function _getTempoScopeFiles(forFilename) {
  // Working set: the tempo curve is derived from alignment grids and the
  // timemap, not from any renderer, so a deferred recording still counts. Using
  // the renderer set here would make the shared Y axis jump as rows appear.
  let files = Object.keys(waveformViews).filter(
    (fn) =>
      fn !== SYNTH_MEI_KEY && alignmentGrids[fn] && alignmentGrids[fn].length,
  );

  if (_tempoScopeWithinGroup) {
    // Restrict to files in the same group as forFilename, or to the ungrouped
    // ones when it has no group. Membership via the shared resolveGroupFor: this
    // used to iterate every group and let the last match win, which could scope
    // the curve to a different group than the one holding forFilename's row
    // (roadmap item U).
    const groups = getActiveFileGroups();
    const myGroup = resolveGroupFor(forFilename, groups);
    files = files.filter((fn) => resolveGroupFor(fn, groups) === myGroup);
  }

  if (_tempoScopeDisplayedOnly) {
    const displayed = new Set(
      Array.from(document.querySelectorAll("#waveforms .waveform"))
        .filter((el) => el.style.display !== "none")
        .map((el) => el.dataset.ix)
        .filter((fn) => fn && wavesurfers[fn]),
    );
    files = files.filter((fn) => displayed.has(fn));
  }

  return files;
}

/**
 * Compute the corpus reference tempo at each resampled score position
 * across the given files.
 *
 * Per-file outlier exclusion: for each file, compute the median and
 * scaled MAD of its own tempo values.  At each score position, exclude
 * a file's value if it deviates from that file's own median by more
 * than TEMPO_OUTLIER_K scaled MADs (≈ 2 standard deviations for normal
 * data).  This catches structural-mismatch artefacts (e.g. a file that
 * skips a repeat produces extreme QPM in the unmatched region) even when
 * a large fraction of the corpus is affected, because the test is
 * per-file rather than cross-corpus.
 *
 * The reference value at each position is the median of the remaining
 * (non-excluded) values.
 *
 * Returns a Map<scoreTime, medianTempo> keyed by score position
 * (multiples of TEMPO_RESAMPLE_QN).  This avoids index-alignment bugs:
 * different files may have different-length arrays due to monotonicity
 * filtering and dt <= 0 skips, so array-index matching is unreliable.
 */
function _computeCorpusMeanTempo(files, smoothing) {
  const sm = smoothing || 0;
  const tempos = files.map((fn) => _smoothTempo(_getRawTempo(fn), sm));

  // Pre-compute per-file median and outlier threshold (TEMPO_OUTLIER_K × scaled MAD).
  const fileStats = tempos.map((pts) => {
    if (!pts.length) return { med: 0, threshold: Infinity };
    const sorted = pts.map((p) => p.tempo).sort((a, b) => a - b);
    const med = _median(sorted);
    const absDevs = sorted.map((v) => Math.abs(v - med)).sort((a, b) => a - b);
    const mad = _median(absDevs);
    const threshold = _TEMPO_OUTLIER_SCALE * mad;
    return { med, threshold: Math.max(threshold, 1) }; // floor of 1 QPM to avoid zero-threshold
  });

  // Collect all score positions across all files, keyed by scoreTime
  // (multiples of TEMPO_RESAMPLE_QN, so rounding removes float noise).
  const posMap = new Map(); // scoreTime → [{tempo, fileIdx}]
  for (let f = 0; f < tempos.length; f++) {
    for (const pt of tempos[f]) {
      const key = Math.round(pt.scoreTime * 1e6) / 1e6; // remove float noise
      if (!posMap.has(key)) posMap.set(key, []);
      posMap.get(key).push({ tempo: pt.tempo, fileIdx: f });
    }
  }

  const result = new Map();
  for (const [scoreTime, entries] of posMap) {
    const vals = [];
    for (const { tempo, fileIdx } of entries) {
      const { med, threshold } = fileStats[fileIdx];
      if (Math.abs(tempo - med) <= threshold) vals.push(tempo);
    }
    if (vals.length === 0) {
      // All values excluded — fall back to unfiltered median
      const fallback = entries.map((e) => e.tempo).sort((a, b) => a - b);
      result.set(scoreTime, _median(fallback));
      continue;
    }
    vals.sort((a, b) => a - b);
    result.set(scoreTime, _median(vals));
  }
  return result;
}

/**
 * Robust median of a sorted (ascending) numeric array.
 */
function _median(sorted) {
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = n >> 1;
  return n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Recompute the uniform Y-axis range for the tempo curve.
 * Uses robust statistics (median ± 2 × scaled MAD) so that extreme
 * outliers (alignment artefacts, 1000+ QPM spikes) do not inflate the
 * range.  Scaled MAD ≈ 1.4826 × MAD approximates SD for normal data.
 * Values outside this range are clipped and marked with indicators.
 * For relative mode the range is symmetric around 0.
 */
function _recomputeTempoYRange() {
  // Working set — see _getTempoScopeFiles.
  const allFiles = Object.keys(waveformViews).filter(
    (fn) =>
      fn !== SYNTH_MEI_KEY && alignmentGrids[fn] && alignmentGrids[fn].length,
  );
  if (!allFiles.length || !scoreAlignment) {
    _tempoYRange = null;
    return;
  }

  // Use smoothed data for range computation so the range matches what is
  // actually drawn, and isolated spikes dampened by smoothing don't widen it.
  const sm = _tempoCurveSmoothing;

  if (_tempoCurveMode === "absolute") {
    const allTempos = [];
    for (const fn of allFiles) {
      for (const pt of _smoothTempo(_getRawTempo(fn), sm))
        allTempos.push(pt.tempo);
    }
    if (!allTempos.length) {
      _tempoYRange = null;
      return;
    }
    allTempos.sort((a, b) => a - b);
    const med = _median(allTempos);
    const absDevs = allTempos.map((t) => Math.abs(t - med));
    absDevs.sort((a, b) => a - b);
    const mad = _median(absDevs);
    _tempoYRange = {
      min: Math.max(0, med - _TEMPO_OUTLIER_SCALE * mad),
      max: med + _TEMPO_OUTLIER_SCALE * mad,
    };
  } else {
    // Relative deviation: robust range symmetric around 0
    const corpusMean = _computeCorpusMeanTempo(allFiles, sm);
    const devs = [];
    for (const fn of allFiles) {
      const smoothed = _smoothTempo(_getRawTempo(fn), sm);
      for (const pt of smoothed) {
        const key = Math.round(pt.scoreTime * 1e6) / 1e6;
        const ref = corpusMean.get(key);
        if (ref && ref > 0) devs.push(((pt.tempo - ref) / ref) * 100);
      }
    }
    if (!devs.length) {
      _tempoYRange = { min: -10, max: 10 };
      return;
    }
    devs.sort((a, b) => a - b);
    const dMed = _median(devs);
    const dAbsDevs = devs.map((d) => Math.abs(d - dMed));
    dAbsDevs.sort((a, b) => a - b);
    const dMad = _median(dAbsDevs);
    // Use a generous floor for deviation Y-range: real corpora routinely show
    // ±75% deviations from legitimate tempo differences between recordings.
    // Beyond the floor, use 3× scaled MAD to accommodate the data if needed.
    const DEV_Y_SCALE = 3 * 1.4826;
    const extent = Math.max(75, Math.abs(dMed) + DEV_Y_SCALE * dMad);
    _tempoYRange = { min: -extent, max: extent };
  }
}

/**
 * Everything the tempo-curve renderer needs, or null when there is nothing to
 * draw. The derivation — raw cache, smoothing, scope, corpus mean, and the
 * shared Y-range — stays here because it is still in flux; engine/waveform-view
 * consumes only this snapshot, so a later tempo rework need not touch it.
 */
export function getTempoDrawModel(filename) {
  if (!_tempoCurveVisible || filename === SYNTH_MEI_KEY) return null;
  const raw = _getRawTempo(filename);
  if (!raw.length) return null;

  // Ensure Y-range is computed
  if (!_tempoYRange) _recomputeTempoYRange();
  if (!_tempoYRange) return null;

  const smoothed = _smoothTempo(raw, _tempoCurveSmoothing);

  // In relative mode, compute per-file deviation from scope-based corpus mean
  let corpusMean = null;
  if (_tempoCurveMode === "relative") {
    const scopeFiles = _getTempoScopeFiles(filename);
    corpusMean = _computeCorpusMeanTempo(scopeFiles, _tempoCurveSmoothing);
  }
  return { mode: _tempoCurveMode, yRange: _tempoYRange, smoothed, corpusMean };
}

/**
 * Group membership changed: redraw the tempo curves that depend on it.
 *
 * Only group-scoped curves care — across-groups scoping and a hidden curve
 * are both no-ops. The y-range is dropped so the next draw recomputes it over
 * the new membership. Called by engine/grouping-ui.js after a tab switch: the
 * tempo state stays private here, so the view asks for the redraw rather than
 * reading the flags.
 */
export function redrawTempoCurvesForGroupChange() {
  if (_tempoScopeWithinGroup && _tempoCurveVisible) {
    _tempoYRange = null;
    Object.keys(waveformViews).forEach((fn) => drawAlignmentGrid(fn));
  }
}

/**
 * Look up the tempo value at a given time for a file.
 * Returns { tempo, label } or null if tempo curve is not available.
 * In relative mode, label shows "±X% avg." ; in absolute mode, "X QPM".
 */
function _getTempoAtTime(filename, time) {
  if (!_tempoCurveVisible || filename === SYNTH_MEI_KEY) return null;
  const raw = _getRawTempo(filename);
  if (!raw.length) return null;
  // Find the raw point whose time is closest to (but ≤) the query time
  let idx = 0;
  for (let i = 1; i < raw.length; i++) {
    if (raw[i].time <= time) idx = i;
    else break;
  }
  const smoothed = _smoothTempo(raw, _tempoCurveSmoothing);
  if (idx >= smoothed.length) idx = smoothed.length - 1;
  const tempo = smoothed[idx].tempo;

  if (_tempoCurveMode === "relative") {
    const scopeFiles = _getTempoScopeFiles(filename);
    const corpusMean = _computeCorpusMeanTempo(
      scopeFiles,
      _tempoCurveSmoothing,
    );
    const key = Math.round(smoothed[idx].scoreTime * 1e6) / 1e6;
    const ref = corpusMean.get(key);
    if (ref && ref > 0) {
      const dev = ((tempo - ref) / ref) * 100;
      const sign = dev >= 0 ? "+" : "";
      return { tempo, label: sign + dev.toFixed(0) + "% avg." };
    }
  }
  return { tempo, label: Math.round(tempo) + " QPM" };
}

/** Parse a CSS colour string ("rgba(…)", "#rrggbb", "#rgb") into {r,g,b,a} or null. */
export function parseCssColor(str) {
  str = (str || "").trim();
  const m = str.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)/);
  if (m) return { r: +m[1], g: +m[2], b: +m[3], a: m[4] != null ? +m[4] : 1 };
  const h6 = str.match(/^#([0-9a-f]{6})$/i);
  if (h6) { const v = parseInt(h6[1], 16); return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255, a: 1 }; }
  const h3 = str.match(/^#([0-9a-f]{3})$/i);
  if (h3) { const [, h] = h3; return { r: parseInt(h[0]+h[0],16), g: parseInt(h[1]+h[1],16), b: parseInt(h[2]+h[2],16), a: 1 }; }
  return null;
}

/** Alpha-composite fg (rgba) over a solid bg colour, returns {r,g,b}. */
function _blendOver({ r: fr, g: fg, b: fb, a }, { r: br, g: bg, b: bb }) {
  return {
    r: Math.round(fr * a + br * (1 - a)),
    g: Math.round(fg * a + bg * (1 - a)),
    b: Math.round(fb * a + bb * (1 - a)),
  };
}

/**
 * Recompute the effective label background colour for a waveform.
 * Reads CSS custom properties so the result is always theme-correct.
 * Active waveforms blend --color-waveform-active over --color-bg;
 * non-active waveforms use --color-bg directly.
 */
export function refreshWfBg(filename) {
  const wfEl = document.querySelector(
    `.waveform[data-ix='${CSS.escape(filename)}']`,
  );
  const style = getComputedStyle(document.documentElement);
  const baseBg = parseCssColor(style.getPropertyValue("--color-bg")) ?? { r: 255, g: 255, b: 255, a: 1 };

  let rgb;
  if (wfEl?.classList.contains("active")) {
    const activeFg = parseCssColor(style.getPropertyValue("--color-waveform-active"));
    rgb = activeFg ? _blendOver(activeFg, baseBg) : baseBg;
  } else {
    rgb = baseBg;
  }
  const bg = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.90)`;

  wfBgCache[filename] = bg;
  // Sync the wf-label element
  const lbl =
    wfEl &&
    (
      waveformViews[filename]?.ow?.wrapper ||
      wfEl
    ).querySelector(".wf-label");
  if (lbl) lbl.style.backgroundColor = bg;
  return bg;
}

// Zoom & scroll subsystem (applyZoom, scroll-sync, overlay wrappers) was
// extracted to ./engine/zoom-scroll.js in the Phase-1 engine refactor and is
// imported at the top of this file.

// ---------------------------------------------------------------------------
// Alignment correction (drag-to-morph)
// ---------------------------------------------------------------------------
let _alignCorrectionMode = false;
// Unified Undo/Redo: arrays of tagged entries
// Entry types:
//   { type:'align-fix', filename, grid }
//   { type:'marker-add', alignIx, markerArrayIx }
//   { type:'marker-delete', alignIx, markerArrayIx }
//   { type:'marker-move', markerArrayIx, oldAlignIx, newAlignIx }
const _undoStack = [];
const _redoStack = [];
// Dirty-state tracking: counter incremented on commit, decremented on undo,
// incremented on redo. Dirty = _changeCounter !== _savedAtCounter.
let _changeCounter = 0;
let _savedAtCounter = 0;
/** Record one alignment-data change. Exported because engine/group-modal.js
 *  commits grouping edits and an importer cannot assign a live binding; the
 *  counter stays here because nine other sites in this file touch it, and the
 *  undo/redo stacks it pairs with have not moved. Deliberately does NOT call
 *  updateDirtyState() — every existing site makes that call itself, and folding
 *  it in would double up. */
export function bumpChangeCounter() {
  _changeCounter++;
}
/** Fix-mode pushes its fix-anchor/fix-gap snapshot entries through this seam
 *  (the push half lives in the DOMContentLoaded closure with the buttons it
 *  updates; the closure assigns the implementation below). */
let _pushFixUndoImpl = null;
export function pushFixUndoEntry(entry) {
  _pushFixUndoImpl?.(entry, true);
}
// V6 annotation-changes pending. Pushed by annotation/index.js via
// setAnnoChangesPending(). ORed into updateDirtyState() so the central
// Save-data indicator reflects annotation changes too. Tracked separately
// from _changeCounter so a Solid post can clear annotation dirtiness without
// affecting the alignment-data dirty flag.
let _annoChangesPending = false;
export function setAnnoChangesPending(v) {
  _annoChangesPending = !!v;
  updateDirtyState();
}
// Revert: original grids captured when alignment first loads
const _alignOriginalGrids = {};
// Radius presets (in alignment indices)
const _ALIGN_RADIUS_NARROW = 10;
const _ALIGN_RADIUS_MEDIUM = 30;
const _ALIGN_RADIUS_WIDE = 90;
// Current radius selection (set from UI)
let _alignRadius = _ALIGN_RADIUS_MEDIUM;
// Drag markers: whether markers are currently draggable
export let dragMarkersEnabled = false;
// Drag mode: 'move' or 'fix'
let _dragMode = "move";
// Track whether pulse hints have been shown (first-time tooltips)
let _pulseHintShown = false;
let _disableDragHintShown = false;

/** Symmetric Gaussian weight. */
function _gaussianWeight(j, jCenter, sigma) {
  const diff = j - jCenter;
  return Math.exp(-(diff * diff) / (2 * sigma * sigma));
}

/** Choose sigma: modifier keys override the UI selection. */
function _sigmaFromEvent(e) {
  if (e.shiftKey && e.altKey) return _ALIGN_RADIUS_NARROW;
  if (e.shiftKey) return _ALIGN_RADIUS_MEDIUM;
  return _alignRadius;
}

/**
 * Apply a Gaussian-weighted displacement to a grid, enforcing monotonicity.
 * Returns a new array (does not mutate the input).
 *
 * @param {number[]} grid        - alignment times
 * @param {number}   jCenter     - index of the drag anchor
 * @param {number}   dtDrag      - displacement in seconds at the anchor
 * @param {number}   sigma       - Gaussian radius (in indices)
 * @returns {number[]} morphed grid
 */
function _morphGrid(grid, jCenter, dtDrag, sigma) {
  const n = grid.length;

  const out = new Array(n);
  for (let j = 0; j < n; j++) {
    const w = _gaussianWeight(j, jCenter, sigma);
    out[j] = grid[j] + dtDrag * w;
  }
  // Enforce monotonicity outward from the drag anchor: entries that
  // would violate ordering get shoved aside in the appropriate direction.
  const EPS = 1e-6;
  // Left of anchor: push entries leftward if they collide
  for (let j = jCenter - 1; j >= 0; j--) {
    if (out[j] >= out[j + 1]) out[j] = out[j + 1] - EPS;
  }
  // Right of anchor: push entries rightward if they collide
  for (let j = jCenter + 1; j < n; j++) {
    if (out[j] <= out[j - 1]) out[j] = out[j - 1] + EPS;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pane-level loading indicator.
//
// Between accepting an alignment and creating the first waveform element there
// is nothing to hang a per-waveform overlay on, so the content pane sat blank —
// several seconds on a long piece with many recordings, spent rendering MIDI
// from the score, interpolating the synth grid, and then decoding audio. This
// covers exactly that window and hands over to the per-waveform overlays as
// soon as the first waveform exists.
//
// The phases are named rather than shown as an opaque spinner: several seconds
// of unexplained spinning is only marginally better than several seconds of
// nothing.
// ---------------------------------------------------------------------------

/** Show (or retext) the pane indicator. */
function showWaveformsPaneLoading(statusText) {
  const pane = document.getElementById("waveforms");
  if (!pane) return;
  let el = pane.querySelector(":scope > .wf-pane-loading");
  if (!el) {
    el = document.createElement("div");
    el.className = "wf-pane-loading";
    el.innerHTML =
      '<div class="resize-spinner"></div><span class="wf-overlay-status"></span>';
    pane.appendChild(el);
  }
  const status = el.querySelector(".wf-overlay-status");
  if (status) status.textContent = statusText || "";
}

/**
 * Retext the pane indicator, but never resurrect it.
 *
 * Once a waveform exists the indicator is gone for good; a late phase update
 * must not bring it back over a pane that is already showing content.
 */
function setWaveformsPaneLoadingStatus(statusText) {
  const el = document.querySelector("#waveforms > .wf-pane-loading");
  if (!el) return;
  const status = el.querySelector(".wf-overlay-status");
  if (status) status.textContent = statusText || "";
}

/** Remove the pane indicator. Safe to call when it was never shown. */
export function hideWaveformsPaneLoading() {
  document.querySelector("#waveforms > .wf-pane-loading")?.remove();
}

function showWaveformOverlays() {
  document.querySelectorAll("#waveforms .waveform").forEach((wf) => {
    showWaveformOverlay(wf, "Redrawing\u2026");
  });
}

function showWaveformOverlay(wfEl, statusText) {
  let overlay = wfEl.querySelector(".wf-resize-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.className = "wf-resize-overlay";
    overlay.innerHTML =
      '<div class="resize-spinner"></div><span class="wf-overlay-status"></span>';
    wfEl.appendChild(overlay);
  }
  const statusEl = overlay.querySelector(".wf-overlay-status");
  if (statusEl) statusEl.textContent = statusText || "";
  overlay.style.display = "flex";
}

function updateWaveformOverlayStatus(wfEl, statusText) {
  const overlay = wfEl.querySelector(".wf-resize-overlay");
  if (!overlay) return;
  const statusEl = overlay.querySelector(".wf-overlay-status");
  if (statusEl) statusEl.textContent = statusText || "";
}

export function hideWaveformOverlay(wfEl) {
  const overlay = wfEl.querySelector(".wf-resize-overlay");
  if (overlay) overlay.style.display = "none";
}

// --- Custom marker system (replaces WaveSurfer v4 markers plugin) ---

// --- Alt-mode number overlay helpers ---

/** Returns .waveform elements that are >25% visible in the viewport, in DOM order.
 *  Renderer set on purpose: these become numbered jump targets, and a deferred
 *  row has nothing to jump to yet. */
function _getOnScreenWaveforms() {
  const vpTop = 0;
  const vpBottom = window.innerHeight;
  return Array.from(document.querySelectorAll("#waveforms .waveform")).filter(
    (el) => {
      if (!(el.dataset.ix in wavesurfers)) return false;
      const r = el.getBoundingClientRect();
      if (r.height === 0) return false;
      const visible = Math.min(r.bottom, vpBottom) - Math.max(r.top, vpTop);
      return visible / r.height > 0.25;
    },
  );
}

/** Insert numbered badges on the first 10 on-screen waveforms. */
function _showAltNumbers() {
  _hideAltNumbers();
  _jumpToTargetWaveforms = _getOnScreenWaveforms().slice(0, 10);
  _jumpToTargetWaveforms.forEach((el, i) => {
    const badge = document.createElement("div");
    badge.className = "wf-alt-number";
    // 1–9 for slots 0–8, 0 for the 10th slot
    badge.textContent = String(i === 9 ? 0 : i + 1);
    el.appendChild(badge);
  });
}

/** Remove all number badges. */
function _hideAltNumbers() {
  document.querySelectorAll(".wf-alt-number").forEach((b) => b.remove());
  _jumpToTargetWaveforms = [];
}

window.addEventListener("resize", () => {
  if (Object.keys(wavesurfers).length === 0) return;
  // Clear custom markers immediately (positions shift when container width changes).
  Object.keys(wavesurfers).forEach((ws) => clearMarkers(ws));
  // Show spinners; WaveSurfer v7's built-in ResizeObserver triggers rerenders per
  // waveform, each of which hides its own overlay in its "redrawcomplete" handler.
  showWaveformOverlays();
  // Those rerenders are not enough on their own: applyZoom fits a waveform with
  // ws.zoom(containerWidth / duration), which PINS minPxPerSec to the width it saw
  // at the time. WaveSurfer then keeps rerendering at that pinned rate, so after a
  // resize the content holds its old width — at zoom 1 it overflows its container,
  // the scroll container stays scrollable, and a parked scrollLeft can leave the
  // waveform showing a slice that was never rendered (blank waveform, working
  // playback). Re-applying the current zoom recomputes the rate for the new width.
  // Debounced: a drag-resize fires this continuously (see spec 28).
  clearTimeout(_resizeDebounce);
  _resizeDebounce = setTimeout(() => applyZoom(currentZoomLevel), 150);
});

// --- Close-listening mode ---

export function enterCloseListeningMode(markerArrayIndex) {
  closeListeningMode = true;
  if (markerArrayIndex != null) {
    // Explicit marker entry (e.g. clicking a marker): activate that marker.
    setActiveMarkerIx(markerArrayIndex);
    _setActiveRegionStart(null);
    seekToActiveMarker();
  } else {
    // General entry: activate the closest jump target (marker or active-
    // annotation region start) at or before the current playback position.
    _activateClosestJumpTargetBehind();
  }
  redrawAllMarkers();
  updateCloseListeningBadge();
  updateMarkBtnTooltip();
}

function exitCloseListeningMode() {
  closeListeningMode = false;
  setActiveMarkerIx(null);
  _setActiveRegionStart(null);
  updateMarkBtnTooltip();
  // Leave the playhead exactly where it is on exit (whether playing or paused).
  // We deliberately do NOT seekTo(0) here: that old clip-path reset would jump
  // the position back to the start; keeping the playhead put is what's wanted.
  redrawAllMarkers();
  updateCloseListeningBadge();
}

/**
 * Activate the close-listening jump target (marker or active-annotation region
 * start) closest to and at/before the current playback position, seeking to
 * it. Falls back to the earliest target if none lies before the playhead.
 */
function _activateClosestJumpTargetBehind() {
  setActiveMarkerIx(null);
  _setActiveRegionStart(null);
  // Focus fix: fall back to the first loaded waveform if none is current.
  if (!currentAudioIx || !wavesurfers[currentAudioIx]) {
    const keys = Object.keys(wavesurfers);
    if (keys.length === 0) return;
    setCurrentAudioIx(keys[0]);
  }
  const stops = _getCloseListeningStops();
  if (!stops.length) return;
  const currentTime = wavesurfers[currentAudioIx].getCurrentTime();
  let chosen = null;
  for (const s of stops) {
    if (s.time <= currentTime + 1e-6) chosen = s;
  }
  if (!chosen) chosen = stops[0];
  _activateJumpTarget(chosen);
}

/** Make a jump-target stop active (updating marker/region indicators) and seek to it. */
function _activateJumpTarget(stop) {
  if (stop.markerIx != null) {
    setActiveMarkerIx(stop.markerIx);
    _setActiveRegionStart(null);
    redrawAllMarkers();
    seekToActiveMarker();
  } else {
    setActiveMarkerIx(null);
    _setActiveRegionStart(stop.regionRef);
    redrawAllMarkers();
    seekCloseListeningTo(stop.time);
  }
}

/**
 * Seek the current waveform to time `t` (seconds) and, when zoomed, scroll it
 * into view if it isn't already. Shared by active-marker seeks and the
 * close-listening jump-to-region-start navigation.
 */
export function seekCloseListeningTo(t) {
  if (!currentAudioIx || !wavesurfers[currentAudioIx]) return;
  const duration = wavesurfers[currentAudioIx].getDuration();
  wavesurfers[currentAudioIx].seekTo(t / duration);
  // At zoom: only scroll if the target is outside the visible viewport
  if (currentZoomLevel > 1) {
    const ws = wavesurfers[currentAudioIx];
    const fullW = getZoomedWidth(currentAudioIx);
    const scrollLeft = ws.getScroll();
    const scrollContainer = getScrollContainer(currentAudioIx);
    const viewW = scrollContainer ? scrollContainer.clientWidth : fullW;
    const targetPx = (t / duration) * fullW;
    const inView = targetPx >= scrollLeft && targetPx <= scrollLeft + viewW;
    if (!inView) {
      ws.setScrollTime(t);
      syncOverlayScroll(currentAudioIx);
      syncAllWaveformScrolls(currentAudioIx);
    }
  }
}

/**
 * Play an annotation from the beginning of its first region. Called when an
 * annotation card (chip) is clicked: activate the annotation, pick a target
 * waveform (the current one if it's attached, else the first loaded target),
 * seek to that region's start, and start playback.
 *
 * In close-listening mode the region start also becomes the active jump
 * target, so the region loops back on itself at its end (see
 * maybeLoopActiveRegion). Outside close-listening, playback runs on past the
 * region end as normal.
 */
export function playAnnotation(annId) {
  v6State.setActiveAnnotation(annId);
  const ann = v6State.getById(annId);
  if (!ann || !Array.isArray(ann.targets) || ann.targets.length === 0) return;
  // Pick a target waveform: prefer the current one, else the first loaded.
  let target = ann.targets.find((t) => t.file === currentAudioIx && wavesurfers[t.file]);
  if (!target) target = ann.targets.find((t) => wavesurfers[t.file]);
  if (!target) return;
  // First region by start time among those with extent on this target.
  const first = (ann.regions || [])
    .map((r) => {
      const rt = target.regionTimes[r.id];
      return rt && rt.end > rt.start ? { id: r.id, start: rt.start } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.start - b.start)[0];
  if (!first) return;
  // Make the target the active waveform (swap carries position; we re-seek next).
  if (target.file !== currentAudioIx) swapCurrentAudio(target.file);
  // In close-listening, the region start becomes the active jump target so the
  // region loops; redraw markers to clear any previously-active marker.
  if (closeListeningMode) {
    setActiveMarkerIx(null);
    _setActiveRegionStart({ annId, regionId: first.id });
    redrawAllMarkers();
  }
  seekCloseListeningTo(first.start);
  const ws = wavesurfers[currentAudioIx];
  const r = ws && ws.play();
  if (r && typeof r.catch === "function") r.catch(() => {});
}

/**
 * Close-listening region loop: when the active jump target is a region start,
 * loop that region back to its start upon reaching its end. Gated on
 * closeListeningMode (live) — switching close-listening off mid-playback lets
 * playback continue past the region end as normal. Called from the active
 * waveform's audioprocess handler.
 */
export function maybeLoopActiveRegion(filename) {
  if (!closeListeningMode || !_activeRegionStart || filename !== currentAudioIx) return;
  const ann = v6State.getById(_activeRegionStart.annId);
  if (!ann || !Array.isArray(ann.targets)) return;
  const target = ann.targets.find((t) => t.file === filename);
  const rt = target && target.regionTimes[_activeRegionStart.regionId];
  if (!rt || !(rt.end > rt.start)) return;
  const ws = wavesurfers[filename];
  if (ws && ws.getCurrentTime() >= rt.end) seekCloseListeningTo(rt.start);
}

/**
 * Start time (seconds) of the region referenced by `ref` ({ annId, regionId })
 * on `file`, or null if that region has no extent on that file. Used when
 * swapping waveforms with a region start as the active close-listening jump
 * target, so playback restarts at the equivalent region start on the new
 * waveform rather than carrying the playhead position across.
 */
function _regionStartTimeOnFile(ref, file) {
  if (!ref) return null;
  const ann = v6State.getById(ref.annId);
  if (!ann || !Array.isArray(ann.targets)) return null;
  const target = ann.targets.find((t) => t.file === file);
  const rt = target && target.regionTimes && target.regionTimes[ref.regionId];
  return rt && rt.end > rt.start ? rt.start : null;
}

// --- Playing-annotation card highlights ---
//
// While audio plays, light the ribbon chip of every annotation whose region on
// the current waveform contains the playhead. Several can be lit at once
// (regions overlap) and this is independent of the single "active" annotation
// shown in the editor. Recomputed each audioprocess frame, but only pushed to
// the ribbon when the lit set actually changes (key compare) so the DOM isn't
// touched ~60×/s.
let _playingAnnKey = "";

export function updatePlayingAnnotationHighlights() {
  const ids = _annotationsAtPlayhead();
  const key = ids.join(",");
  if (key === _playingAnnKey) return;
  _playingAnnKey = key;
  setPlayingAnnotations(ids);
}

/** Sorted IDs of annotations with a region containing the playhead on the current waveform. */
function _annotationsAtPlayhead() {
  const ws = currentAudioIx && wavesurfers[currentAudioIx];
  if (!ws) return [];
  const t = ws.getCurrentTime();
  const ids = [];
  for (const ann of v6State.getAll()) {
    if (!Array.isArray(ann.targets)) continue;
    const target = ann.targets.find((tg) => tg.file === currentAudioIx);
    if (!target || !target.regionTimes) continue;
    const hit = (ann.regions || []).some((r) => {
      const rt = target.regionTimes[r.id];
      return rt && rt.end > rt.start && t >= rt.start && t < rt.end;
    });
    if (hit) ids.push(ann.id);
  }
  return ids.sort();
}

/** Clear all playing-card highlights (called when playback stops). */
export function clearPlayingAnnotationHighlights() {
  if (_playingAnnKey === "") return;
  _playingAnnKey = "";
  setPlayingAnnotations([]);
}

/**
 * Build the ordered list of close-listening "stops" on the current waveform:
 * every marker, plus the start of each region of *every* annotation that has
 * extent on the current waveform (not just the active annotation). Each entry
 * is { time, markerIx, regionRef }, where time is in seconds on the current
 * waveform; markerIx is the markers[] index, or null for a region start; and
 * regionRef is { annId, regionId }, or null for a marker.
 */
function _getCloseListeningStops() {
  const stops = [];
  for (let i = 0; i < markers.length; i++) {
    stops.push({
      time: getCorrespondingTime(currentAudioIx, markers[i]),
      markerIx: i,
      regionRef: null,
    });
  }
  for (const ann of v6State.getAll()) {
    if (!Array.isArray(ann.targets)) continue;
    const target = ann.targets.find((t) => t.file === currentAudioIx);
    if (!target || !target.regionTimes) continue;
    (ann.regions || []).forEach((r) => {
      const rt = target.regionTimes[r.id];
      if (rt && rt.end > rt.start) {
        stops.push({
          time: rt.start,
          markerIx: null,
          regionRef: { annId: ann.id, regionId: r.id },
        });
      }
    });
  }
  return stops.sort((a, b) => a.time - b.time);
}

/**
 * Close-listening plain-arrow navigation: jump to the previous (dir < 0) or
 * next (dir > 0) stop relative to the current playback position. Returns true
 * if it handled the key (there were stops to navigate), false otherwise so the
 * caller can fall back to normal-mode seeking.
 *
 * The backward window is 800ms: after a leftward jump,
 * playback advances, so a too-tight window would re-select the just-reached
 * stop on a quick second press instead of stepping to the prior one.
 */
function _jumpCloseListening(dir) {
  if (!currentAudioIx || !wavesurfers[currentAudioIx]) return false;
  const stops = _getCloseListeningStops();
  if (!stops.length) return false;
  const currentTime = wavesurfers[currentAudioIx].getCurrentTime();
  let target = null;
  if (dir < 0) {
    for (let j = stops.length - 1; j >= 0; j--) {
      if (stops[j].time < currentTime - 0.8) {
        target = stops[j];
        break;
      }
    }
    if (target == null) {
      // Nothing far enough in the past — jump to start of file.
      wavesurfers[currentAudioIx].seekTo(0);
      return true;
    }
  } else {
    for (let j = 0; j < stops.length; j++) {
      if (stops[j].time > currentTime + 0.1) {
        target = stops[j];
        break;
      }
    }
    if (target == null) return true; // nothing ahead; stay put
  }
  // Region-start targets keep activeMarkerIx null, so cross-waveform position
  // carry follows the playhead rather than a stale marker.
  _activateJumpTarget(target);
  return true;
}


function updateCloseListeningBadge() {
  const cb = document.getElementById("close-listening-cb");
  if (cb) cb.checked = closeListeningMode;
  // Update dependent controls
  _updateDragFieldsetState();
}

/** Update enabled state of drag-marker fieldset and radius fieldset. */
function _updateDragFieldsetState() {
  const dragFieldset = document.getElementById("drag-marker-fieldset");
  const radiusFieldset = document.getElementById("radius-fieldset");
  // Drag markers is always available (not gated on close-listening)
  if (dragFieldset) dragFieldset.disabled = false;
  if (radiusFieldset)
    radiusFieldset.disabled = !(dragMarkersEnabled && _dragMode === "fix");
  // Update marker visual classes
  updateMarkerDraggableClass();
  // Update correction overlay pointer-events
  const corrActive = dragMarkersEnabled && _dragMode === "fix";
  if (corrActive !== _alignCorrectionMode) {
    _alignCorrectionMode = corrActive;
    _applyCorrectionOverlayPointerEvents();
  }
}

/** Apply the effective pointer-events state to correction overlay canvases.
 *  Correction overlays are interactive only when fix-alignment mode is active
 *  AND draw-region mode is not active (draw mode needs events to pass through
 *  to the WaveSurfer wrapper for the regions plugin). */
let _drawModeActive = false;

/** Are the alignment-correction overlay canvases interactive right now?
 *  The two flags are only ever meaningful together, so engine modules get this
 *  one accessor rather than both (increment 22): a correction canvas takes
 *  pointer events only in fix-alignment mode with draw-region mode off.
 *  This is the single source of truth for that expression — the pointer-events
 *  sweep below and engine/waveform-events.js's canvas creation both read it. */
export function correctionOverlaysInteractive() {
  return _alignCorrectionMode && !_drawModeActive;
}

function _applyCorrectionOverlayPointerEvents() {
  const effective = correctionOverlaysInteractive();
  document.querySelectorAll(".align-correction-overlay").forEach((c) => {
    c.style.pointerEvents = effective ? "auto" : "none";
    if (!effective) c.style.cursor = "";
  });
  document.body.classList.toggle("align-correction-active", effective);
}

/** Called by annotation.js when entering/exiting draw-region mode.
 *  Suppresses correction overlay pointer-events so drag-selection
 *  events reach the WaveSurfer wrapper. */
/** Read-only accessor for engine modules; only annotation code sets the flag. */
export function isDrawModeActive() {
  return _drawModeActive;
}

export function setDrawModeActive(active) {
  _drawModeActive = active;
  _applyCorrectionOverlayPointerEvents();
  // Toggle a class so CSS can suppress native drag on waveform elements
  document
    .getElementById("waveforms")
    ?.classList.toggle("draw-mode-active", active);
}

// The index↔time arithmetic itself lives in engine/align-core.js, which every
// consumer of an alignment grid must agree with. These wrappers own only the two
// defaults — current playback time and current recording — and the grid
// collection to read them from.
function getClosestAlignmentIx(
  time = wavesurfers[currentAudioIx].getCurrentTime(),
  audioIx = currentAudioIx,
) {
  return _coreClosestAlignmentIx(alignmentGrids, time, audioIx);
}

export function getCorrespondingTime(audioIx, alignmentIx) {
  return _coreCorrespondingTime(alignmentGrids, audioIx, alignmentIx);
}

export function onClickRenditionName(e) {
  // Catches clicks on checkboxes or labels
  // Used to load / switch to the respective rendition
  let checkbox;
  if (e.target.nodeName.toLowerCase() === "label") {
    // retrieve checkbox
    checkbox = document.getElementById(e.target.for);
  } else if (e.target.nodeName.toLowerCase === "li") {
    checkbox = e.target.querySelector("input");
  } else {
    checkbox = e.target;
  }
  console.log("CLick: ", e);
  console.log("Checkbox: ", checkbox);

  if (checkbox.value) {
    const status = document
      .getElementById(checkbox.value)
      .querySelector("label").classList;
    if (!status.contains("ready") && !status.contains("loading")) {
      status.add("loading");
    }
    prepareWaveform(checkbox.value);
    console.log("Clicked!", checkbox.value);
  }
}

export function onClickRenditionCheckbox(e) {
  // n.b. separate handler to onClickRenditionName
  // used only to specifically show/hide renditions when
  // they have already loaded
  let checkbox = e.target;
  let checked = checkbox.checked;
  let label = checkbox.parentElement.querySelector("label");
  let waveform = document.getElementById("waveform-" + e.target.value + "-wav");
  if (!waveform) return; // element may not be in DOM during tab switch
  // A deferred recording is shown and checked but has no waveform yet, so the
  // hide/show pair must not relabel it "loading" on the way out or "ready" on
  // the way back in — neither is true until something actually builds it.
  const isDeferred = _deferred.has(e.target.value);
  if (!checked) {
    e.stopPropagation(); // hide from other handler
    waveform.style.display = "none";
    checkbox.checked = false;
    label.classList.remove("ready");
    label.classList.add(isDeferred ? "queued" : "loading");
  } else if (isDeferred) {
    e.stopPropagation(); // hide from other handler
    waveform.style.display = "unset";
    checkbox.checked = true;
    // Back on screen and still deferred: the observer takes it from here, and
    // builds it as soon as the row is actually near the viewport.
    _observeWaveformRow(waveform);
  } else if (label.classList.contains("loading")) {
    e.stopPropagation(); // hide from other handler
    waveform.style.display = "unset";
    checkbox.checked = true;
    label.classList.remove("loading");
    label.classList.add("ready");
  } else {
    // user clicked unloaded checkbox, so it is now checked
    // uncheck it again - it wil set itself after loading finished
    checkbox.checked = false;
  }
  updateGroupCounts();
  // Redraw tempo curves if scope depends on displayed files
  if (_tempoScopeDisplayedOnly && _tempoCurveVisible) {
    _tempoYRange = null;
    Object.keys(waveformViews).forEach((fn) => drawAlignmentGrid(fn));
  }
}

/**
 * Deactivate a waveform: pause it, reset its progress clip-path (so the
 * played portion doesn't stay visually clipped), remove the `.active`
 * background, and clear `currentAudioIx` if this was the active recording.
 * No-op if the named file isn't currently active. Used by the V6 annotation
 * module when the user removes a recording from the active selection.
 */
export function setCurrentAudioInactive(filename) {
  if (!filename || currentAudioIx !== filename) return;
  const ws = wavesurfers[filename];
  if (ws) {
    try {
      ws.pause();
    } catch (_) {}
    // Reset clip-path via seekTo(0), saving/restoring scroll under the
    // scroll-sync lock so the waveform doesn't visibly jump. Mirrors the
    // demoted-waveform dance in swapCurrentAudio.
    try {
      const scrollEl = getScrollContainer(filename);
      const savedScroll = scrollEl ? scrollEl.scrollLeft : 0;
      setScrollSyncLock(true);
      ws.seekTo(0);
      if (scrollEl) scrollEl.scrollLeft = savedScroll;
    } finally {
      setScrollSyncLock(false);
    }
  }
  const wfEl = document.getElementById(`waveform-${filename}-wav`);
  if (wfEl) wfEl.classList.remove("active");
  setCurrentAudioIx("");
}

export function swapCurrentAudio(newAudio) {
  if (currentAudioIx === newAudio) {
    // no need to swap
    return;
  }
  // Swapping onto a recording whose renderer was deferred: build it, wait for a
  // real duration (everything below divides by getDuration()), then swap. The
  // caller's contract stays synchronous — the swap simply lands a tick later
  // instead of being dropped.
  if (_deferred.has(newAudio)) {
    _materializeNow(newAudio)
      .then(() => _whenWaveformReady(newAudio))
      .then(() => {
        if (wavesurfers[newAudio]) swapCurrentAudio(newAudio);
      });
    return;
  }
  // Only the branch below dereferences the incoming renderer; the no-current
  // branch just marks it active, which is still meaningful without one.
  if (currentAudioIx && !wavesurfers[newAudio]) return;
  if (currentAudioIx) {
    console.log("Pausing current: ", currentAudioIx);
    console.log(
      "Current duration: ",
      wavesurfers[currentAudioIx].getDuration(),
    );
    const wasPlaying = wavesurfers[currentAudioIx].isPlaying();
    wavesurfers[currentAudioIx].pause();
    // In close-listening mode, seek to the active marker; otherwise follow
    // the current playback position.
    let closestAlignmentIx =
      closeListeningMode && activeMarkerIx != null
        ? markers[activeMarkerIx]
        : getClosestAlignmentIx();
    document
      .getElementById(`waveform-${currentAudioIx}` + "-wav")
      ?.classList.remove("active");
    var prevAudio = currentAudioIx;
    // Reset the demoted waveform's canvas clip-path to 0 (WaveSurfer v7 uses
    // a clip-path on the canvases div to show only the unplayed region; the
    // CSS ::part(progress) hides the progress overlay on inactive waveforms,
    // but the clip-path persists and makes the beginning appear blank).
    // Save & restore scroll position so the seekTo(0) doesn't visibly jump.
    const oldScrollEl = getScrollContainer(currentAudioIx);
    const savedScroll = oldScrollEl ? oldScrollEl.scrollLeft : 0;
    setScrollSyncLock(true);
    wavesurfers[currentAudioIx].seekTo(0);
    if (oldScrollEl) oldScrollEl.scrollLeft = savedScroll;
    setScrollSyncLock(false);
    // swap to new audio and alignment grid
    setCurrentAudioIx(newAudio);
    console.log("new audio ix: ", currentAudioIx);
    let currentGrid = alignmentGrids[currentAudioIx];
    console.log("new audio grid: ", alignmentGrids[currentAudioIx]);
    console.log("new duration: ", wavesurfers[currentAudioIx].getDuration());
    let newWaveform = document.getElementById(
      `waveform-${currentAudioIx}` + "-wav",
    );
    // highlight as active
    newWaveform.classList.add("active");
    // scroll to position
    let bbox = newWaveform.getBoundingClientRect();
    let waveforms = document.getElementById("waveforms");
    waveforms.scrollTo({
      top: bbox.top + waveforms.scrollTop - 128,
      left: 0,
      behavior: "smooth",
    });
    // seek to new (corresponding) position. When the active close-listening
    // jump target is a region start (not a marker), restart at the equivalent
    // region start on the new waveform if that region exists there; otherwise
    // fall back to carrying the playhead position via the alignment grid.
    const regionStartT =
      closeListeningMode && activeMarkerIx == null && _activeRegionStart
        ? _regionStartTimeOnFile(_activeRegionStart, currentAudioIx)
        : null;
    let newPosition;
    if (regionStartT != null) {
      newPosition = regionStartT / wavesurfers[currentAudioIx].getDuration();
    } else {
      let correspondingPosition = currentGrid[closestAlignmentIx];
      newPosition =
        correspondingPosition / wavesurfers[currentAudioIx].getDuration();
    }
    wavesurfers[currentAudioIx].seekTo(newPosition);
    // At zoom: the new waveform is already scroll-synced via
    // syncAllWaveformScrolls, so don't reposition — just sync overlays.
    if (currentZoomLevel > 1) {
      syncOverlayScroll(currentAudioIx);
    }
    if (wasPlaying) wavesurfers[currentAudioIx].play();
  } else {
    setCurrentAudioIx(newAudio);
    const newActiveWaveform = document.getElementById(
      `waveform-${currentAudioIx}` + "-wav",
    );
    if (newActiveWaveform) {
      newActiveWaveform.classList.add("active");
    }
  }
  // Redraw grids for old and new waveforms so tick backgrounds reflect active state
  // Refresh cached backgrounds and redraw grids so tick colours match active state
  refreshWfBg(prevAudio);
  refreshWfBg(currentAudioIx);
  drawAlignmentGrid(prevAudio);
  drawAlignmentGrid(currentAudioIx);
}

export function updateDirtyState() {
  const isDirty =
    _changeCounter !== _savedAtCounter || _annoChangesPending;
  const dlBtn = document.getElementById("download-json-btn");
  if (dlBtn) {
    dlBtn.classList.toggle("json-dirty", isDirty);
    dlBtn.title = isDirty
      ? "Download alignment data (You have unsaved changes!)"
      : "Download alignment data";
  }
  const ctrl = document.getElementById("nav-middle-toggle");
  if (ctrl) {
    ctrl.classList.toggle("json-dirty", isDirty);
    ctrl.title = isDirty
      ? "Collapse / expand controls (You have unsaved changes!)"
      : "Collapse / expand controls";
  }
}

/**
 * Update the Mark button tooltip: "Remove marker" when paused at a marker,
 * "Place marker" otherwise.
 */
export function updateMarkBtnTooltip() {
  const btn = document.getElementById("mark");
  if (!btn) return;
  let atMarker = false;
  const ws =
    currentAudioIx && wavesurfers[currentAudioIx]
      ? wavesurfers[currentAudioIx]
      : null;
  const isPlaying = ws ? ws.isPlaying() : false;
  if (closeListeningMode && activeMarkerIx != null && !isPlaying && ws) {
    // Check whether playback position is actually at the active marker
    const markerTime = getCorrespondingTime(
      currentAudioIx,
      markers[activeMarkerIx],
    );
    const currentTime = ws.getCurrentTime();
    atMarker = Math.abs(currentTime - markerTime) < 0.05;
  } else if (
    closeListeningMode &&
    activeMarkerIx != null &&
    !isPlaying &&
    !ws
  ) {
    // Before first playback — no waveform active, trust close-listening state
    atMarker = true;
  }
  btn.title = atMarker
    ? "Remove the currently-active marker"
    : "Place a marker at the current playback position";
  const iconMark = btn.querySelector(".icon-mark");
  const iconMarkX = btn.querySelector(".icon-mark-x");
  if (iconMark) iconMark.style.display = atMarker ? "none" : "";
  if (iconMarkX) iconMarkX.style.display = atMarker ? "" : "none";
  btn.dataset.mode = atMarker ? "remove" : "place";
}

export function reloadWaveforms() {
  let playPosition = 0;
  let isPlaying = false;
  // Working set: everything in the pane comes back, whether or not it had a
  // renderer. Rebuilding only the built ones would silently drop every deferred
  // recording from the pane on something as ordinary as toggling Normalize.
  const prevLoaded = [
    ...new Set([...Object.keys(waveformViews), ...Object.keys(wavesurfers)]),
  ];
  if (currentAudioIx && wavesurfers[currentAudioIx]) {
    playPosition = wavesurfers[currentAudioIx].getCurrentTime();
    isPlaying = wavesurfers[currentAudioIx].isPlaying();
  }
  // get current play position of active wavesurfer
  // destroy current wavesurfers
  prevLoaded.forEach((ws) => {
    wavesurfers[ws]?.destroy();
    teardownNormGainNode(ws);
  });
  clearMap(wavesurfers);
  // forget waveform elements (and spectorgrams)
  document.getElementById("waveforms").replaceChildren();
  // …and the views that pointed at them. Without this the map kept entries for
  // detached nodes of any recording that does not come back — harmless while
  // every consumer guarded on isConnected, but it is a teardown path like the
  // other two and should leave nothing behind.
  clearWaveformViews();
  // Deferrals refer to rows that no longer exist; prepareWaveform below decides
  // afresh which of the returning waveforms to defer.
  _clearDeferredWaveforms();
  // re-create previously loaded waveforms
  prevLoaded.forEach((ws) => prepareWaveform(ws, playPosition, isPlaying));
}

function visualiseAlignments() {
  // go through all wavesurfers, throw out user-defined markers, and instead draw in alignment positions as markers
  Object.keys(wavesurfers).forEach((ws) => {
    clearMarkers(ws);
    alignmentGrids[ws].forEach((t) => {
      addMarker(ws, { time: t, color: "red" });
    });
  });
}

async function prepareWaveform(filename, playPosition = 0, isPlaying = false) {
  // A deferred waveform has a row but no renderer. Being asked for it by name —
  // a sidebar click, arrow-key navigation, the group All button — outranks the
  // viewport heuristic that deferred it, so build it now rather than queueing.
  if (_deferred.has(filename)) {
    await _materializeNow(filename, playPosition, isPlaying);
    return;
  }
  // if not yet created, do so (guard against the async gap below re-entering):
  if (!(filename in wavesurfers) && !_preparing.has(filename)) {
    const waveform = createWaveformRow(filename);
    // Fix-mode entry affordance (?fixMode only; the module decides which rows).
    attachFixEntryButton(filename, waveform);

    // Row done. Whether its renderer gets built now or when the user scrolls to
    // it is the lazy-creation decision (roadmap item L).
    if (_shouldDeferWaveform(filename)) {
      _deferWaveform(filename, waveform);
      return;
    }
    await materializeWaveform(filename, playPosition, isPlaying);
  } else {
    // waveform already loaded...
    let checkbox = document.getElementById(filename).querySelector("input");
    if (!checkbox.checked) {
      // if hidden, unhide by clicking on checkbox
      checkbox.click();
    }
    // now swap to the audio
    swapCurrentAudio(filename);
  }
}

/**
 * Build one waveform's renderer: its plugins, its WaveSurfer instance, the
 * audio load, and every handler hanging off it. Phase 2 of prepareWaveform —
 * the row and the view already exist.
 *
 * Split out for roadmap item L: with dozens of recordings this is the expensive
 * half (a WaveSurfer instance and a full audio fetch each), so above the lazy
 * threshold it runs only when a row nears the viewport or the user asks for
 * that recording by name.
 *
 * The bulk of the work happens later, off the "ready" event, in
 * engine/waveform-events.js's onWaveformReady. The row itself is built before
 * any of this, by engine/waveform-layout.js's createWaveformRow.
 */
async function materializeWaveform(filename, playPosition = 0, isPlaying = false) {
  if (filename in wavesurfers || _preparing.has(filename)) return;
  const view = waveformViews[filename];
  const waveform = view?.container;
  if (!waveform || !waveform.isConnected) {
    // The row went away (pruned, or the piece was replaced) while this sat in
    // the queue. Release the slot; there is nothing left to build.
    materializeSettled(filename);
    return;
  }
  _preparing.add(filename);
  _undeferWaveform(filename);
  // Claim the row straight away. WaveSurfer is not created until after the
  // await further down, and with dozens of recordings that queue is long — so
  // without this the row would sit as an empty reserved box, with no spinner,
  // until its turn came. The later "Loading audio…" call just retexts this.
  showWaveformOverlay(waveform, "Preparing\u2026");
  // create new wavesurfer instance in the new container
  const _regPlugin = RegionsPlugin.create();
  const _hoverPlugin = HoverPlugin.create({
    lineColor: "#000",
    labelColor: "#fff",
    labelBackground: "#000",
    labelSize: "10px",
    formatTimeCallback: (t) => {
      const m = Math.floor(t / 60);
      const s = (t % 60).toFixed(2);
      let label = m + ":" + s.padStart(5, "0");
      const ti = _getTempoAtTime(filename, t);
      if (ti) label += " \u2014 " + ti.label;
      return label;
    },
  });
  setRegionsPlugin(filename, _regPlugin);

  // For frame-stream formats (VBR MP3 / ADTS AAC), hand WaveSurfer a windowed
  // Web-Audio media object so seeking is sample-accurate. Returns null for
  // formats that seek fine natively (CBR MP3, WAV, …) → default <audio> path.
  const _windowedPlayer = await maybeBuildWindowedPlayer(filename);
  const _wpPeaks = _windowedPlayer ? waveformPeaks[filename] : null;
  wavesurfers[filename] = WaveSurfer.create({
    container: `#${CSS.escape("waveform-" + filename) + "-wav"}`,
    ...(_waveformColors()),
    normalize: document.getElementById("normalize").checked,
    plugins: [_regPlugin, _hoverPlugin],
    autoScroll: false, // managed by our zoom scroll logic
    autoCenter: false, // managed by our zoom scroll logic
    ...(_windowedPlayer
      ? {
          // External media owns playback; render from pregenerated peaks.
          media: _windowedPlayer,
          peaks: _wpPeaks?.peaks ? [_wpPeaks.peaks] : undefined,
          duration: _wpPeaks?.duration,
        }
      : { fetchParams: xhrOptionsForUrl(resolveAudioUrl(filename)) }),
  });
  // Past the async gap; the wavesurfers[] entry now guards re-entry.
  _preparing.delete(filename);

  // Region create/update events are handled by the V6 module's listeners
  // wired in annotation/waveform-interactions.js — listen.js doesn't need
  // its own.

  // Start loading (deferred for synth entries until the blob URL is available)
  const wfEl = document.querySelector(`.waveform[data-ix='${filename}']`);
  const _audioUrl = resolveAudioUrl(filename);
  // Prefer passing the Blob directly to WaveSurfer to avoid cross-origin
  // issues that some browsers (Firefox) have with blob: URLs via fetch().
  const _audioBlob = fileBlobs.get(filename);
  if (_windowedPlayer) {
    // Windowed player already holds the audio and peaks were passed at
    // create(); nothing to load. Overlay clears on the "ready" event.
    showWaveformOverlay(wfEl, "Loading audio…");
  } else if (_audioBlob || _audioUrl) {
    // If pre-computed peaks are available, pass them to load() so WaveSurfer
    // can render the waveform shape immediately (before full audio decode).
    const _peakInfo = waveformPeaks[filename];
    if (_audioBlob) {
      wavesurfers[filename].loadBlob(
        _audioBlob,
        _peakInfo?.peaks ? [_peakInfo.peaks] : undefined,
        _peakInfo?.duration,
      );
    } else if (_peakInfo && _peakInfo.peaks && _peakInfo.duration) {
      wavesurfers[filename].load(
        _audioUrl,
        [_peakInfo.peaks],
        _peakInfo.duration,
      );
    } else {
      wavesurfers[filename].load(_audioUrl);
    }
    showWaveformOverlay(wfEl, "Loading audio\u2026");
  } else {
    showWaveformOverlay(wfEl, "Synthesising audio from MEI\u2026");
  }
  // Update overlay with download progress
  wavesurfers[filename].on("loading", (pct) => {
    if (pct < 100) {
      updateWaveformOverlayStatus(wfEl, `Loading audio\u2026 ${pct}%`);
    } else {
      updateWaveformOverlayStatus(wfEl, "Rendering waveform\u2026");
    }
  });
  // Handle 401 errors: prompt for credentials and retry (scoped to origin)
  wavesurfers[filename].on("error", function (err) {
    materializeSettled(filename);
    if (err && err.message && err.message.includes("401")) {
      const url = resolveAudioUrl(filename);
      const origin = getOrigin(url);
      if (promptForAuth(url)) {
        reloadWaveformsForOrigin(origin);
      }
    }
  });
  wavesurfers[filename].on("ready", () =>
    onWaveformReady(filename, playPosition, isPlaying),
  );
  wireWaveformEvents(filename);

  // render anno regions
  updateRenderAnnoRegions();
}

// --- MEI synthesised waveform helpers ---

// Why the score MEI could not be loaded, or null when it loaded fine. Read by
// the synth-waveform builder so a score-source failure is reported as such.
let _meiLoadError = null;

// Resolves once Verovio's toolkit exists (or with null if Verovio is absent).
// Module-scope because setGrids has to await it: the toolkit is built from a wasm
// runtime callback, and whoever touches `tk` first must not assume it has fired.
let _verovioReady = null;

/**
 * Fetch the score MEI, failing loudly on anything that is not XML.
 *
 * A bare fetch().text() hands the body straight to Verovio whatever it is: an
 * HTTP error page, a rate-limit notice, or a 404 from a mistyped local path all
 * parse to a document with no MEI root, yield zero notes, and finally surface as
 * "synthesis produced no audio" — blaming the last step for the first one's
 * failure. parseFromString does not throw on malformed input and tk.loadData
 * only logs, so nothing upstream can raise on our behalf; the check has to
 * happen here.
 */
async function _fetchMeiXml(uri) {
  let response;
  try {
    response = await fetch(uri);
  } catch (e) {
    // Network-level: DNS, offline, CORS, connection reset.
    throw new Error(`could not reach the score source (${e.message})`);
  }
  if (!response.ok) {
    throw new Error(
      `score source returned HTTP ${response.status} ${response.statusText}`.trim(),
    );
  }
  const text = await response.text();
  if (!text.trim()) throw new Error("score source returned an empty response");
  // Sniff rather than trust Content-Type: raw hosts and static servers label
  // .mei inconsistently (text/plain, application/octet-stream, …), so the body
  // is the only reliable signal.
  if (!/<\s*(\?xml|mei\b|music\b)/i.test(text.slice(0, 2048))) {
    const preview = text.trim().slice(0, 120).replace(/\s+/g, " ");
    throw new Error(`score source did not return MEI XML (got "${preview}…")`);
  }
  return text;
}

/**
 * Match alignment-event score positions (quarter notes) against the parsed
 * MIDI's note ticks, returning each event's position in seconds within the
 * synth audio — or null if any event finds no matching tick (the rendered
 * MIDI differs from what the aligner saw, e.g. across Verovio versions).
 * `tickOf` selects start (onsets) or end (offsets) ticks.
 */
function _matchScoreQuartersToSynthSecs(
  quarters,
  expectedLen,
  notes,
  tickOf,
  tpq,
  tempoChanges,
) {
  if (!quarters || quarters.length !== expectedLen || !notes.length || !tpq)
    return null;
  // Quarter positions are multiples of 1/TPQ (≥ ~1e-3 apart), so a 1e-6
  // quantised key matches exactly without trusting float equality.
  const qKey = (q) => Math.round(q * 1e6);
  const secByQ = new Map();
  for (const n of notes) {
    const k = qKey(tickOf(n) / tpq);
    if (!secByQ.has(k)) secByQ.set(k, tickToSec(tickOf(n), tpq, tempoChanges));
  }
  const out = new Array(quarters.length);
  for (let i = 0; i < quarters.length; i++) {
    const sec = secByQ.get(qKey(quarters[i]));
    if (sec === undefined) return null;
    out[i] = sec;
  }
  return out;
}

/**
 * Last resort for ancient alignment JSONs with neither a usable score_onset
 * nor synth_onset: rebuild the aligner's event list from the MIDI. Alignment
 * events are the notes deduplicated per unique (start, end) tick pair, sorted
 * by that pair — NOT one per note, so indexing notes[i] directly (the old
 * fallback) drifted as soon as the first chord sounded.
 */
function _reconstructEventOnsetSecs(expectedLen, notes, tpq, tempoChanges) {
  const seen = new Set();
  const events = [];
  for (const n of notes) {
    const k = n.s + ":" + n.e;
    if (!seen.has(k)) {
      seen.add(k);
      events.push(n);
    }
  }
  events.sort((a, b) => a.s - b.s || a.e - b.e);
  return Array.from({ length: expectedLen }, (_, i) => {
    if (!events.length) return 0;
    const ev = events[Math.min(i, events.length - 1)];
    return tickToSec(ev.s, tpq, tempoChanges);
  });
}

/**
 * Orchestrate synth-waveform creation:
 *   1. Build alignment grid synchronously (must be ready before WaveSurfer "ready" fires)
 *   2. Register key as pending → prepareWaveform shows "Synthesising..." overlay
 *   3. Create WaveSurfer skeleton immediately (user sees spinner right away)
 *   4. Async: decode MIDI, synthesise, register blob URL, load into WaveSurfer
 */
async function _buildAndPrepareSynthWaveform(
  synthKey,
  scoreData,
  refKey,
  midiB64,
) {
  // The score never arrived: report that on the score waveform instead of
  // running the pipeline on an empty MEI, where the failure would resurface as
  // "synthesis produced no audio" and blame the last step for the first one's
  // problem. Await prepareWaveform here: it only builds the overlay after its
  // own await, and unlike the synthesis path below there are no later progress
  // updates to land the message for us.
  if (_meiLoadError) {
    console.error("skipping synthesis, MEI never loaded:", _meiLoadError);
    // Pending marker first, so resolveAudioUrl returns null and prepareWaveform
    // renders an overlay rather than trying to load audio (as the normal path does).
    _synthBlobUrls.set(synthKey, "__pending__");
    await prepareWaveform(synthKey);
    const wfEl = document.querySelector(`.waveform[data-ix='${synthKey}']`);
    if (wfEl) {
      updateWaveformOverlayStatus(
        wfEl,
        `\u26a0 Score unavailable: ${_meiLoadError}`,
      );
    }
    return;
  }

  // ---- Synchronous phase (must complete before first await) ----
  // Parse MIDI first so we can compute synth timings synchronously,
  // then set the alignment grid BEFORE calling prepareWaveform / before
  // WaveSurfer's 'ready' event could ever fire.
  let midiBytes;
  try {
    const bin = atob(midiB64);
    midiBytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) midiBytes[i] = bin.charCodeAt(i);
  } catch (err) {
    console.error("MEI MIDI decode failed:", err);
    return;
  }

  let tpq, tempoChanges, notes;
  try {
    ({ tpq, tempoChanges, notes } = parseMidi(midiBytes));
  } catch (err) {
    console.error("MEI MIDI parse failed:", err);
    return;
  }

  // Compute alignment grid: map ref times → synth times.
  //
  // Derive synth times from the MIDI actually being rendered, by matching
  // each alignment event's score position in quarters (score_onset/offset =
  // tick / TPQ, written by the aligner from the same MEI) against the parsed
  // note ticks. Stored synth_onset is deliberately NOT preferred: alignment
  // JSONs generated before align-worker.js's tempo-sort fix carry a constant
  // skew wherever the MIDI opens with a real tempo event (the seeded 120 BPM
  // default won the tick-0 tie), and regeneration cannot be assumed. Stored
  // values remain the fallback for when matching fails (e.g. a Verovio
  // upgrade changed the rendered MIDI since the alignment was made).
  const refOnsets = scoreData.ref_onset || [];
  const derivedOnsets = _matchScoreQuartersToSynthSecs(
    scoreData.score_onset,
    refOnsets.length,
    notes,
    (n) => n.s,
    tpq,
    tempoChanges,
  );
  if (derivedOnsets) {
    correctedSynthOnsets = derivedOnsets;
    correctedSynthOffsets = _matchScoreQuartersToSynthSecs(
      scoreData.score_offset,
      refOnsets.length,
      notes,
      (n) => n.e,
      tpq,
      tempoChanges,
    );
    // Tempo curves computed against the stored tables are stale now.
    for (const k of Object.keys(_tempoRawCache)) delete _tempoRawCache[k];
  } else if (scoreData.score_onset) {
    console.warn(
      "score_onset does not match the rendered MIDI; keeping stored synth_onset",
    );
  }
  const synthOnsets =
    derivedOnsets ||
    (scoreData.synth_onset && scoreData.synth_onset.length === refOnsets.length
      ? scoreData.synth_onset
      : _reconstructEventOnsetSecs(refOnsets.length, notes, tpq, tempoChanges));
  alignmentGrids[synthKey] = interpAlignmentGrid(
    alignmentGrids[refKey] || [],
    refOnsets,
    synthOnsets,
  );

  // Register as pending BEFORE prepareWaveform so resolveAudioUrl returns null
  _synthBlobUrls.set(synthKey, "__pending__");

  // Create WaveSurfer skeleton — alignment grid is already set so drawAlignmentGrid
  // inside the 'ready' handler will have data to work with.
  prepareWaveform(synthKey);

  // ---- Async phase ----
  const getWfEl = () =>
    document.querySelector(`.waveform[data-ix='${synthKey}']`);
  try {
    updateWaveformOverlayStatus(
      getWfEl(),
      `Synthesising audio from MEI\u2026 (${notes.length.toLocaleString()}\u00a0notes)`,
    );
    const wavBlob = await synthToWav(
      notes,
      tpq,
      tempoChanges,
      (elapsed, estimated) => {
        const elStr = fmtSec(elapsed);
        const estStr =
          estimated !== null ? `, est. ${fmtSec(estimated)} total` : "";
        updateWaveformOverlayStatus(
          getWfEl(),
          `Synthesising audio from MEI\u2026 ${elStr}${estStr}`,
        );
      },
    );
    if (!wavBlob) throw new Error("synthesis produced no audio");

    const blobUrl = URL.createObjectURL(wavBlob);
    _synthBlobUrls.set(synthKey, blobUrl);

    const ws = wavesurfers[synthKey];
    if (ws) {
      updateWaveformOverlayStatus(getWfEl(), "Loading audio\u2026");
      ws.loadBlob(wavBlob);
    }
  } catch (err) {
    console.error("MEI waveform synthesis failed:", err);
    updateWaveformOverlayStatus(
      getWfEl(),
      `\u26a0 Synthesis failed: ${err.message}`,
    );
  }
}

export let loadedAlignmentJSON = session.loadedAlignmentJSON; // Full alignment object for download
export function setLoadedAlignmentJSON(v) {
  return (loadedAlignmentJSON = session.loadedAlignmentJSON = v);
}

// Number of waveforms to auto-load when the alignment JSON lacks
// precalculated peaks (loading each one then requires decoding the audio,
// so we limit the default to keep initial load responsive).
const DEFAULT_WAVEFORM_LOAD_COUNT = 5;

/**
 * Automatically load waveforms when the listen interface first loads.
 *
 * If the alignment JSON shipped precalculated peaks for every recording,
 * rendering a waveform is cheap (no audio decode needed), so we load all of
 * them — as if the user had clicked the "All" button. Otherwise we load only
 * the first few recordings to keep the initial load responsive.
 *
 * Loading is triggered by programmatically clicking each unchecked checkbox,
 * mirroring the "All" list-selector so the exact same load path runs.
 */
function _autoLoadDefaultWaveforms(filenames) {
  if (!filenames.length) return;
  const hasPrecalculatedPeaks = filenames.every(
    (fn) =>
      waveformPeaks[fn] &&
      Array.isArray(waveformPeaks[fn].peaks) &&
      waveformPeaks[fn].peaks.length > 0,
  );
  const toLoad = hasPrecalculatedPeaks
    ? filenames
    : filenames.slice(0, DEFAULT_WAVEFORM_LOAD_COUNT);
  console.log(
    `Auto-loading ${toLoad.length} waveform(s) on load ` +
      `(precalculated peaks: ${hasPrecalculatedPeaks})`,
  );
  toLoad.forEach((fn) => {
    const cb = document.getElementById("checkbox-" + fn);
    if (cb && !cb.checked) cb.click();
  });
}

/**
 * Revoke retired object URLs (see DataSession.retireFileBlobs), skipping any
 * that still back a live media element — revoking one mid-load would fail that
 * waveform. Anything skipped stays retired and is swept on the next call, so a
 * URL is released as soon as its renderer is gone and never before.
 */
function _revokeRetiredBlobUrls() {
  const retired = session.retiredBlobUrls;
  if (!retired.length) return;
  const inUse = new Set();
  for (const ws of Object.values(wavesurfers)) {
    const src = ws?.getMediaElement?.()?.currentSrc;
    if (src) inUse.add(src);
  }
  const stillInUse = [];
  for (const url of retired) {
    if (inUse.has(url)) stillInUse.push(url);
    else URL.revokeObjectURL(url);
  }
  refillArray(retired, stillInUse);
}

/**
 * Audio keys an incoming alignment object declares, across the three formats
 * setGrids accepts (final, pre-final dev, and bare-grids legacy).
 */
function _incomingAudioKeys(grids) {
  if (!grids || typeof grids !== "object") return [];
  const src = grids.body?.audio || grids.body || grids;
  return Object.keys(src).filter((k) => k !== SYNTH_MEI_KEY);
}

/**
 * The time arrays an incoming alignment declares, keyed by recording. Handles
 * all three accepted shapes (final `{times, peaks, duration}`, pre-final dev,
 * bare-grids legacy) and skips anything that isn't a time array.
 */
function _incomingGridTimes(grids) {
  if (!grids || typeof grids !== "object") return {};
  const src = grids.body?.audio || grids.body || grids;
  const out = {};
  for (const [k, v] of Object.entries(src)) {
    if (k === SYNTH_MEI_KEY) continue;
    const times = Array.isArray(v)
      ? v
      : Array.isArray(v?.times)
        ? v.times
        : null;
    if (times) out[k] = times;
  }
  return out;
}

/**
 * Tear down everything belonging to the currently loaded piece.
 *
 * Issue #32: setGrids() used to swap the alignment data while the previous
 * piece's renderers, loaded set, markers and caches survived, so any read of
 * alignmentGrids[staleKey] returned undefined. Order matters here — leave the
 * modes that hold indices into the outgoing piece first, destroy renderers
 * while their state still exists, then clear.
 *
 * @param {string[]} keepAudioKeys keys of the incoming piece. The file picker
 *   registers the new piece's blobs BEFORE setGrids runs, so those entries must
 *   survive; everything else is dropped and its object URL revoked.
 */
function resetSession(keepAudioKeys = []) {
  const keep = new Set(keepAudioKeys);

  // 1. Leave transient modes that reference the outgoing piece
  fixModeOnPieceReset();
  if (closeListeningMode) exitCloseListeningMode();
  clearMeasureVisuals();
  _jumpToTargetActive = false;
  _jumpToTargetWaveforms = [];
  _setActiveRegionStart(null);
  _playingAnnKey = "";

  // 2. Destroy the renderers (same teardown reloadWaveforms performs)
  Object.keys(wavesurfers).forEach((fn) => {
    teardownNormGainNode(fn);
    try {
      wavesurfers[fn].destroy();
    } catch (e) {
      console.warn("resetSession: destroy failed for", fn, e);
    }
  });
  seekAnalysis.clear();

  // 3. Release object URLs we minted for the outgoing piece. Renderers are
  //    destroyed by now, so the sweep below can revoke everything it holds.
  for (const url of session.synthBlobUrls.values()) {
    if (url && url !== "__pending__") URL.revokeObjectURL(url);
  }
  for (const [k, url] of session.fileBlobUrls) {
    if (!keep.has(k)) session.retiredBlobUrls.push(url);
  }
  _revokeRetiredBlobUrls();

  // 4. Piece-scoped state living outside the DataSession
  _preparing.clear();
  _clearDeferredWaveforms();
  clearMap(wfBgCache);
  clearWaveformViews();
  clearMap(_tempoRawCache);
  _tempoYRange = null;
  clearMap(_alignOriginalGrids);
  _undoStack.length = 0;
  _redoStack.length = 0;
  _changeCounter = 0;
  _savedAtCounter = 0;
  setAnnoChangesPending(false);
  v6State.replaceAll([]); // V6 annotations belong to the outgoing piece

  // 5. The DataSession, then the mirrors that shadow it. The picker maps are
  //    the *input* to the next load, so prune rather than clear them.
  const keptBlobs = [...session.fileBlobs].filter(([k]) => keep.has(k));
  const keptUrls = [...session.fileBlobUrls].filter(([k]) => keep.has(k));
  session.reset();
  for (const [k, v] of keptBlobs) session.fileBlobs.set(k, v);
  for (const [k, v] of keptUrls) session.fileBlobUrls.set(k, v);
  _syncMirrorsFromSession();

  // 6. Waveform stack. The sidebar file list, grouping pills and LD URI
  //    section are re-rendered from the new alignment by setGrids.
  document.getElementById("waveforms").replaceChildren();
}

/**
 * Destroy any created waveform whose alignment grid is not in the incoming
 * alignment. Without this, a recording that the new alignment simply doesn't
 * mention keeps its renderer, and every projection through its grid throws
 * (#32). Covers the cases the different-piece prompt can't judge on its own:
 * two pieces aligned over the same recordings, or the same piece re-loaded with
 * fewer of them.
 *
 * @returns {string[]} keys dropped
 */
function _pruneWaveformsWithoutGrids() {
  const valid = new Set(Object.keys(alignmentGrids));
  const dropped = [];
  // The working set, not just the renderers: a row can be in the pane with its
  // WaveSurfer not yet created (deferred, or mid-async-gap), and it needs
  // dropping just the same — otherwise the row outlives its alignment grid.
  const inPane = new Set([
    ...Object.keys(waveformViews),
    ...Object.keys(wavesurfers),
  ]);
  inPane.forEach((fn) => {
    if (valid.has(fn)) return;
    dropped.push(fn);
    teardownNormGainNode(fn);
    try {
      wavesurfers[fn]?.destroy();
    } catch (e) {
      console.warn("prune: destroy failed for", fn, e);
    }
    delete wavesurfers[fn];
    delete wfBgCache[fn];
    delete waveformPeaks[fn];
    delete _tempoRawCache[fn];
    delete _alignOriginalGrids[fn];
    loaded.delete(fn);
    _preparing.delete(fn);
    _deferred.delete(fn);
    materializeSettled(fn);
    if (currentAudioIx === fn) setCurrentAudioIx("");
    // The overlay wrapper, when present, contains the waveform element
    const ow = waveformViews[fn]?.ow;
    const el = document.getElementById("waveform-" + fn + "-wav");
    (ow?.wrapper || el)?.remove();
    disposeWaveformView(fn);
  });
  if (dropped.length) {
    console.warn(
      "dropped waveform(s) absent from the new alignment:",
      dropped.join(", "),
    );
    _tempoYRange = null;
  }
  return dropped;
}

/**
 * Guard for setGrids: an alignment whose recordings don't overlap the loaded
 * ones is a *different piece*, and layering it on top is issue #32. Ask, then
 * either reset or abandon the load. Overlapping keys mean the user is managing
 * the current piece's recordings, which stays a no-op.
 *
 * @returns {boolean} whether the load should proceed
 */
/**
 * Alignment object the user has already agreed to load in place of the current
 * piece (approved in the file picker, before it touched any state). Kept so
 * setGrids doesn't ask a second time for the same object.
 */
let _approvedReplacement = null;

/**
 * Decide whether an incoming alignment is a different piece from the loaded
 * one. Pure — no prompting, no state changes — so callers can ask before they
 * commit to anything. See _confirmReplacePiece for the prompt.
 *
 * @returns {{different: boolean, why: string, incoming: string[]}}
 */
/**
 * Is there work a reload would throw away? Markers, grouping, and alignment
 * corrections all bump the change counter; V6 annotations track their own dirty
 * flag. Both replacement paths ask this before discarding anything.
 */
function _hasUnsavedWork() {
  return _annoChangesPending || _changeCounter !== _savedAtCounter;
}

function _assessIncomingPiece(grids) {
  const current = Object.keys(alignmentGrids).filter((k) => k !== SYNTH_MEI_KEY);
  const incoming = _incomingAudioKeys(grids);
  const nothingToJudge = !current.length || !incoming.length;
  if (nothingToJudge) return { different: false, why: "", incoming };
  // Recordings alone don't identify a piece: in this corpus filenames name the
  // ALBUM, so several pieces are aligned over the SAME recordings and a shared
  // key set is no evidence of sameness. Two signals settle it, in order.
  //
  // 1. A different score.
  const incomingMeiUri = grids?.header?.meiUri;
  const differentScore =
    !!incomingMeiUri && !!meiUri && incomingMeiUri !== meiUri;

  // 2. A different warped time sequence for a recording we already hold. This
  //    is what carries audio-only alignments, which have no score to compare.
  //    Fingerprints are the as-loaded ones, so in-session corrections don't
  //    register as a different piece.
  const incomingTimes = _incomingGridTimes(grids);
  const shared = incoming.filter((k) => current.includes(k));
  let differentTimes = false;
  let evidence = "";
  for (const k of shared) {
    const stored = session.gridFingerprints[k];
    if (!stored || !incomingTimes[k]) continue; // nothing to compare
    if (gridFingerprint(incomingTimes[k]) !== stored) {
      differentTimes = true;
      evidence = k;
      break;
    }
  }

  if (!differentScore && !differentTimes && shared.length) {
    // Managing the recordings of the piece already loaded. Flagged distinctly
    // from the nothingToJudge case above: that one is a first load, where there
    // is nothing yet to overwrite.
    return { different: false, samePiece: true, why: "", incoming };
  }

  const why = differentScore
    ? "it uses a different score"
    : differentTimes
      ? `its alignment times differ from the loaded ones (${evidence})`
      : "none of its recordings match the ones loaded";
  console.log("incoming alignment looks like a different piece —", why);
  return { different: true, why, incoming };
}

/**
 * Ask whether to replace the loaded piece. Styled like the app's other
 * dangerous-operation dialogs (see confirmDialog), and spells out what the
 * replacement closes, loads, and discards.
 *
 * @returns {Promise<boolean>} true to replace
 */
async function _confirmReplacePiece({ why, incoming }) {
  // Working set: the prompt is telling the user how much they are closing, and
  // a deferred recording is just as much theirs as a built one.
  const outgoing = Object.keys(waveformViews).filter((k) => k !== SYNTH_MEI_KEY);
  const unsaved = _hasUnsavedWork();

  const lines = [
    el("li", {
      class: "lh-v6-confirm-line removed",
      text:
        "− Closes " +
        outgoing.length +
        " loaded waveform" +
        (outgoing.length === 1 ? "" : "s"),
    }),
    el("li", {
      class: "lh-v6-confirm-line added",
      text:
        "+ Loads " +
        incoming.length +
        " recording" +
        (incoming.length === 1 ? "" : "s") +
        " from the new alignment",
    }),
    el("li", {
      class: "lh-v6-confirm-line " + (unsaved ? "removed" : "neutral"),
      text: unsaved
        ? "− Discards unsaved markers, annotations, and/or alignment corrections"
        : "✓ Nothing unsaved to discard",
    }),
  ];

  // Enter deliberately does NOT confirm here: the prompt follows a click on
  // the file picker's Continue button, and a stray Enter would discard work.
  const ok = await confirmDialog({
    title: "Replace the loaded piece?",
    confirmLabel: "Replace piece",
    cancelLabel: "Keep current",
    focus: "cancel",
    enterConfirms: false,
    body: [
      el("p", { class: "lh-v6-confirm-target" }, [
        "This alignment appears to be for a different piece — ",
        el("strong", { class: "lh-v6-confirm-reason", text: why }),
        ".",
      ]),
      el("ul", { class: "lh-v6-confirm-list" }, lines),
      el("p", {
        class: "lh-v6-confirm-detail",
        text: "Files already saved to disk or to your Solid pod are unaffected.",
      }),
    ],
  });
  return ok;
}

/**
 * setGrids guard. Honours an approval already given in the file picker;
 * otherwise assesses and, if this is a different piece, prompts.
 *
 * @returns {Promise<boolean>} whether the load should proceed
 */
/**
 * Ask before re-reading the alignment that is already loaded.
 *
 * Re-picking the same piece tears nothing down, so it looks harmless — but it
 * still adopts the file's markers, annotations, and alignment times over
 * whatever is in memory, so unsaved work is lost just as surely as on a
 * replacement. The different-piece prompt covers the obvious case; this covers
 * the one that does not look dangerous.
 *
 * Only reached when there IS unsaved work: a clean re-pick changes nothing the
 * user would want to confirm, and 25.7 pins that it must not prompt.
 *
 * @returns {Promise<boolean>} true to go ahead and re-read the file
 */
async function _confirmReloadSamePiece({ incoming }) {
  const current = Object.keys(waveformViews).filter((k) => k !== SYNTH_MEI_KEY);
  const incomingSet = new Set(incoming);
  const dropped = current.filter((k) => !incomingSet.has(k));
  const added = incoming.filter((k) => !current.includes(k));
  const kept = current.length - dropped.length;

  // Same wording as the replace-piece prompt, and true here for the same
  // reason: setGrids now adopts the file's markers as well as its annotations
  // and grids, so a reload discards unsaved work whichever path it takes.
  const lines = [
    el("li", {
      class: "lh-v6-confirm-line removed",
      text: "− Discards unsaved markers, annotations, and/or alignment corrections",
    }),
    el("li", {
      class: "lh-v6-confirm-line neutral",
      text:
        "✓ Keeps the " +
        kept +
        " waveform" +
        (kept === 1 ? "" : "s") +
        " already loaded",
    }),
  ];
  if (dropped.length) {
    lines.push(
      el("li", {
        class: "lh-v6-confirm-line removed",
        text:
          "− Closes " +
          dropped.length +
          " recording" +
          (dropped.length === 1 ? "" : "s") +
          " this file no longer lists",
      }),
    );
  }
  if (added.length) {
    lines.push(
      el("li", {
        class: "lh-v6-confirm-line added",
        text:
          "+ Loads " +
          added.length +
          " recording" +
          (added.length === 1 ? "" : "s") +
          " not currently open",
      }),
    );
  }

  // Enter deliberately does NOT confirm, for the same reason as the
  // replace-piece prompt: it follows a click on the picker's Continue button,
  // and a stray Enter would discard work.
  return await confirmDialog({
    title: "Reload the loaded piece?",
    confirmLabel: "Reload alignment",
    cancelLabel: "Keep current",
    focus: "cancel",
    enterConfirms: false,
    body: [
      el("p", { class: "lh-v6-confirm-target" }, [
        "This is the piece already loaded, and you have ",
        el("strong", { class: "lh-v6-confirm-reason", text: "unsaved changes" }),
        ". Re-reading the file replaces them with what is on disk.",
      ]),
      el("ul", { class: "lh-v6-confirm-list" }, lines),
      el("p", {
        class: "lh-v6-confirm-detail",
        text: "Files already saved to disk or to your Solid pod are unaffected.",
      }),
    ],
  });
}

async function _maybeResetForNewPiece(grids) {
  if (grids && grids === _approvedReplacement) {
    // Approved in the picker before it replaced its own state — reset, no
    // second prompt.
    _approvedReplacement = null;
    resetSession(_incomingAudioKeys(grids));
    return true;
  }
  const assessment = _assessIncomingPiece(grids);
  if (!assessment.different) {
    // Same piece: nothing is torn down, but the file is still re-read over the
    // top of whatever is in memory. Ask only when that would cost something.
    if (assessment.samePiece && _hasUnsavedWork()) {
      return await _confirmReloadSamePiece(assessment);
    }
    return true;
  }
  if (!(await _confirmReplacePiece(assessment))) return false;
  resetSession(assessment.incoming);
  return true;
}

/** Ticks once per completed setGrids — a load-completion signal for tests. */
let _loadGeneration = 0;
// Group-overlap repairs from the load in progress, surfaced once it completes.
let _pendingGroupOverlapReport = [];

async function setGrids(grids) {
  console.log("received grids: ", grids);
  // Replacing the loaded piece requires a full teardown first (issue #32)
  if (!(await _maybeResetForNewPiece(grids))) {
    console.log("setGrids: user declined replacing the loaded piece");
    return;
  }
  // After the guard, not before: the confirm dialog must not sit behind a spinner.
  showWaveformsPaneLoading("Loading alignment\u2026");
  setLoadedAlignmentJSON(grids);
  // V6 hook: load any persisted V6 annotations out of the alignment JSON
  // into the in-memory state. No-op when V6 is inactive.
  loadAnnotationsFromAlignment(grids);
  if ("body" in grids) {
    if ("audio" in grids.body) {
      // final version of alignment json
      // Build alignmentGrids as a fresh map of filename → bare time array,
      // stashing inline {peaks, duration} into waveformPeaks. Crucially, do
      // NOT mutate grids.body.audio — loadedAlignmentJSON aliases the same
      // object and the inline peaks/duration must survive a Save Data round-trip.
      setAlignmentGrids({});
      for (const [key, val] of Object.entries(grids.body.audio)) {
        if (val && !Array.isArray(val) && Array.isArray(val.times)) {
          waveformPeaks[key] = { peaks: val.peaks, duration: val.duration };
          alignmentGrids[key] = val.times;
        } else {
          alignmentGrids[key] = val;
        }
      }
      if ("header" in grids) {
        if ("meiUri" in grids.header && "score" in grids.body) {
          setMeiUri(grids.header.meiUri);
          setScoreAlignment(grids.body.score);
          // Reserve a slot in alignmentGrids for the synth waveform (filled later)
          if (scoreAlignment) {
            alignmentGrids[SYNTH_MEI_KEY] = []; // placeholder; computed in _buildAndPrepareSynthWaveform
          }
          console.log("starting MEI fetch: ", meiUri);
          setWaveformsPaneLoadingStatus("Fetching score\u2026");
          _meiLoadError = null;
          try {
            // Verovio builds its toolkit from a wasm runtime callback, so `tk`
            // is not ready just because the script tag ran. Chrome happened to
            // win that race and Firefox did not, where every tk use below threw
            // and took the rest of setGrids with it — including the auto-load,
            // so the page came up with no waveforms at all.
            if (_verovioReady) await _verovioReady;
            if (!tk) throw new Error("the score renderer (Verovio) is unavailable");
            const meiXml = await _fetchMeiXml(meiUri);
            setMei(meiXml);
            setMeiDOM(parser.parseFromString(mei, "application/xml"));
            tk.loadData(mei, {});
            refillArray(timemap, tk.renderToTimemap({ includeMeasures: true }));
            // Invalidate tempo cache so it picks up timemap qstamp values
            for (const k of Object.keys(_tempoRawCache))
              delete _tempoRawCache[k];
            _tempoYRange = null;
            console.log("timemap set!", timemap, mei);
          } catch (e) {
            // Record WHY, so the score waveform can say so instead of blaming
            // synthesis. Without this the failure surfaced as "synthesis
            // produced no audio", which sends debugging to the wrong place.
            _meiLoadError = e.message;
            console.error("Couldn't load MEI: ", e, grids.header.meiUri);
          }
          console.log("MEI fetched: ", meiUri);
        }
        if ("ref" in grids.header) {
          setReferenceAudioIx(grids.header.ref);
        }
      } else {
        hideWaveformsPaneLoading();
        console.error(
          "Broken grids received from alignment json file: ",
          grids,
        );
      }
    } else {
      // pre-final dev version of alignment json
      setAlignmentGrids(grids.body);
    }
  } else {
    // old version of alignment json
    setAlignmentGrids(grids);
  }
  console.log("setting grids: ", grids);

  // Any waveform the new alignment doesn't mention must go before anything
  // tries to project through its (now absent) grid — see #32.
  _pruneWaveformsWithoutGrids();
  // Re-picking the SAME piece's alignment retires its blob URLs without any
  // session reset, so sweep here as well. The in-use check makes it a no-op for
  // URLs still backing a renderer.
  _revokeRetiredBlobUrls();

  // Invalidate tempo curve cache (alignment data changed)
  for (const k of Object.keys(_tempoRawCache)) delete _tempoRawCache[k];
  _tempoYRange = null;

  // Capture original alignment grids for the "Revert all" feature, and
  // fingerprint them as the loaded piece's identity (see gridFingerprint).
  clearMap(_alignOriginalGrids);
  clearMap(session.gridFingerprints);
  for (const [key, grid] of Object.entries(alignmentGrids)) {
    if (key !== SYNTH_MEI_KEY && Array.isArray(grid)) {
      _alignOriginalGrids[key] = grid.slice();
      session.gridFingerprints[key] = gridFingerprint(grid);
    }
  }

  // Adopt the file's markers, the same way the annotations and the grids above
  // are taken wholesale from it. Without this a same-piece reload behaved
  // differently from a different-piece one: resetSession clears the markers for
  // the latter, while the only other load-time refill lives in a waveform's
  // "ready" handler — which nothing reaches when no waveform is re-created, so
  // the previous piece's unsaved markers quietly survived a reload.
  refillArray(
    markers,
    Array.isArray(grids?.header?.markers) ? grids.header.markers : [],
  );
  setActiveMarkerIx(null);
  redrawAllMarkers();
  // The session now holds exactly what the file holds, so nothing is
  // outstanding and no undo entry still refers to anything live. Mirrors what
  // resetSession does for the different-piece path.
  _undoStack.length = 0;
  _redoStack.length = 0;
  _savedAtCounter = _changeCounter;
  updateDirtyState();

  /* ---- Dynamic file grouping ---- */
  migrateToGroupingTabs();

  let filenames = Object.keys(alignmentGrids).filter(
    (n) => n !== SYNTH_MEI_KEY,
  );
  filenames.sort();

  // Repair overlapping group membership BEFORE anything reads the groups, so
  // the sidebar, the pane's containers, and every later snapshot all see one
  // group per recording. The user is told at the end of the load, not here:
  // a dialog raised now would sit behind the pane spinner.
  _pendingGroupOverlapReport = normaliseGroupOverlap(filenames);

  // Lazy waveform creation is a property of the loaded piece, not of one batch:
  // whether a row is built now or on scroll must not depend on whether it came
  // from the auto-load, a group's All button, or a sidebar click.
  _lazyWaveforms = filenames.length > LAZY_WAVEFORM_THRESHOLD;

  renderSidebarFileList(filenames);
  renderGroupingTabPills();

  // Tempo curves are a score-derived view, so only meaningful when a score
  // alignment is loaded. Enable/disable the control (and its tooltip) to
  // match the current alignment.
  const tempoCb = document.getElementById("show-tempo-curve");
  if (tempoCb) {
    const hasScore = !!scoreAlignment;
    tempoCb.disabled = !hasScore;
    const tip = hasScore
      ? "Overlay tempo curve on each waveform"
      : "Tempo curve requires a score alignment";
    tempoCb.title = tip;
    const tempoLabel = document.querySelector('label[for="show-tempo-curve"]');
    if (tempoLabel) tempoLabel.title = tip;
    // If the alignment lacks a score, make sure any previously-enabled tempo
    // curve is switched off and its options collapsed.
    if (!hasScore && tempoCb.checked) {
      tempoCb.checked = false;
      _tempoCurveVisible = false;
      const tempoOpts = document.getElementById("tempo-curve-options");
      if (tempoOpts) tempoOpts.style.display = "none";
    }
  }

  // Populate the content pane with group containers up front so the group
  // header ("All recordings" / named groups) and the All/None buttons are
  // visible before any waveform is loaded. Without this, the content pane
  // would sit empty until the user clicks a file in the nav sidebar.
  ensureWaveformGroupContainers(
    filenames.concat(SYNTH_MEI_KEY in alignmentGrids ? [SYNTH_MEI_KEY] : []),
  );

  // Show the "Group files" button
  const groupBtn = document.getElementById("group-files-btn");
  if (groupBtn) groupBtn.style.display = "";

  // Show the "Tools" panel (visible once alignment loaded)
  const toolsPanelEl = document.getElementById("tools-panel");
  if (toolsPanelEl) toolsPanelEl.style.display = "";

  // Always show manage-files button once alignment is loaded (for URI config)
  const _manageBtn = document.getElementById("manage-files-btn");
  if (_manageBtn && !_manageBtn._wired) {
    _manageBtn._wired = true;
    _manageBtn.addEventListener("click", () => {
      document.getElementById("file-picker-overlay").style.display = "flex";
      populateLdUriSection();
    });
  }

  // If ?useFiles mode is active, show file picker overlay
  showFilePickerIfNeeded();

  // Kick off async MEI-to-audio synthesis for the score waveform entry.
  //
  // Wrapped: this used to be the last unguarded call in setGrids, so a throw here
  // (tk undefined in Firefox) skipped _autoLoadDefaultWaveforms below and the page
  // came up with no waveforms at all. The score is one entry among many — losing
  // it must never cost the recordings too.
  if (
    SYNTH_MEI_KEY in alignmentGrids &&
    grids.body &&
    grids.body.score &&
    grids.header &&
    grids.header.ref
  ) {
    try {
      if (!tk) throw new Error("the score renderer (Verovio) is unavailable");
      setWaveformsPaneLoadingStatus("Preparing score\u2026");
      const _midiB64 = tk.renderToMIDI();
      _buildAndPrepareSynthWaveform(
        SYNTH_MEI_KEY,
        grids.body.score,
        grids.header.ref,
        _midiB64,
      );
    } catch (e) {
      // Surface it on the score waveform rather than only in the console.
      _meiLoadError = _meiLoadError || e.message;
      console.error("score synthesis could not start:", e);
      _buildAndPrepareSynthWaveform(
        SYNTH_MEI_KEY,
        grids.body.score,
        grids.header.ref,
        "",
      );
    }
  }

  // Auto-load waveforms: all of them if the alignment JSON has precalculated
  // peaks, otherwise just the first few. Uses the same sorted filename list
  // already rendered into the sidebar above.
  setWaveformsPaneLoadingStatus("Creating waveforms\u2026");
  _autoLoadDefaultWaveforms(filenames);
  // Nothing will be auto-loaded, so no waveform will arrive to take over: a
  // spinner left running forever is worse than the blank pane it replaced.
  if (!filenames.length) hideWaveformsPaneLoading();
  // Same reasoning for a pane that is ALREADY full. The indicator is normally
  // retired by the first row a load creates, but re-picking the alignment that
  // is already loaded creates none — every recording is checked, so the
  // auto-load has nothing to click — and the spinner sat over a full pane for
  // good. Row creation is synchronous, so by here every row this load will add
  // has been added, and a pane with content must not claim to be loading.
  // Deliberately conditional: an empty pane may still be waiting on the score,
  // which builds asynchronously and retires the indicator when its row lands.
  if (document.querySelector("#waveforms .waveform")) hideWaveformsPaneLoading();
  // One tick per completed load. Exposed on _listenTest so e2e tests can wait
  // for "this piece finished loading" instead of sleeping for a guessed duration.
  _loadGeneration++;
  // Fix-mode prewarm (?fixMode only; no-op otherwise): invalidates the old
  // piece's derived caches and, at load-idle, does the Verovio layout work so
  // entering the correction screen is instant.
  fixModePrewarm();
  // Now that the pane is populated and its spinner retired, report any group
  // overlap the load had to repair. Deliberately not awaited: the load IS
  // finished, and blocking setGrids on a dialog would hold up every caller.
  if (_pendingGroupOverlapReport.length) {
    const report = _pendingGroupOverlapReport;
    _pendingGroupOverlapReport = [];
    void warnGroupOverlap(report);
  }
}

// ---------------------------------------------------------------------------
// Align → Listen in-memory handoff
// Called by align.js when alignment completes (no page reload needed).
// ---------------------------------------------------------------------------
function onAlignmentComplete(alignmentResult, files) {
  // Store each audio file so WaveSurfer can load them directly
  files.forEach((f) => {
    fileBlobUrls.set(f.name, URL.createObjectURL(f));
    fileBlobs.set(f.name, f);
  });
  useFilesMode = true;
  _fromAlignmentHandoff = true;
  setLoadedAlignmentJSON(alignmentResult);
  workId = "in-browser-alignment";

  // Update URL to reflect listen mode (so Solid redirects return here, not to align)
  history.replaceState(null, "", "/?useFiles");

  // Collapse the align panel and show listen UI
  const alignPanel = document.getElementById("align-panel");
  if (alignPanel) alignPanel.style.display = "none";

  // Show download button so user can save the result
  const dlBtn = document.getElementById("download-json-btn");
  if (dlBtn) dlBtn.style.display = "";

  // Show manage-files button in case user wants to re-match files
  const manageBtn = document.getElementById("manage-files-btn");
  if (manageBtn && !manageBtn._wired) {
    manageBtn._wired = true;
    manageBtn.addEventListener("click", () => {
      document.getElementById("file-picker-overlay").style.display = "flex";
      populateLdUriSection();
    });
  }

  // Load alignment data → build waveforms
  setGrids(alignmentResult);

  // Now in listen mode — initialise the Solid panel.
  initSolidAuth();
}

// ----------------------------------------------------------------------------
// Settings Drawer — theme & i18n
// ----------------------------------------------------------------------------

const _LANG_KEY  = "listenTool_language";

/** Read current waveform colours from CSS custom properties. */
function _waveformColors() {
  const s = getComputedStyle(document.documentElement);
  return {
    waveColor:     s.getPropertyValue("--color-waveform").trim()          || "violet",
    progressColor: s.getPropertyValue("--color-waveform-progress").trim() || "purple",
  };
}

/** Repaint everything on this page that caches a theme colour.
 *
 *  theme-setup.js owns the theme itself — the persisted choice, the `data-theme`
 *  attribute, the logo swap, and the drawer's Theme radios — and announces each
 *  change with `lh-theme-change`. Only the waveform-side repaint lives here. */
function _onThemeChange() {
  // Re-apply waveform colours to any live WaveSurfer instances
  const { waveColor, progressColor } = _waveformColors();
  for (const ws of Object.values(wavesurfers)) {
    try { ws.setOptions({ waveColor, progressColor }); } catch (_) {}
  }

  // Refresh label backgrounds (clears cache so next draw picks up new theme)
  for (const filename of Object.keys(wavesurfers)) {
    delete wfBgCache[filename];
    refreshWfBg(filename);
  }
  // Redraw time axes and alignment grids with new tick/label colours
  for (const fn of Object.keys(waveformViews)) drawAlignmentGrid(fn);
  // Redraw markers and position indicators with new theme colours
  redrawAllMarkers();
  // One call repaints every position-indicator canvas; the filename passed
  // selects which one gets the plain playhead line, so keep using the first
  // registered view exactly as the old first-updater lookup did.
  const _firstViewed = Object.keys(waveformViews).find(isWaveformRendered);
  if (_firstViewed) updatePositionIndicator(_firstViewed);
}

document.addEventListener("lh-theme-change", _onThemeChange);

/** Apply a language preference. Persists to localStorage.
 *  Full i18n support is a future feature; this stores the preference for later. */
function _applyLanguage(lang) {
  document.documentElement.setAttribute("lang", lang);
  try { localStorage.setItem(_LANG_KEY, lang); } catch (_) {}
}

/** Restore the persisted language on page load. The theme is restored earlier
 *  still, by theme-setup.js, which runs before this module is evaluated. */
function _restoreLanguage() {
  try {
    const lang = localStorage.getItem(_LANG_KEY);
    if (lang) _applyLanguage(lang);
  } catch (_) {}
}

/** Wire up the Settings drawer UI. Called from DOMContentLoaded.
 *  The Theme section is injected into this drawer, and wired, by theme-setup.js. */
function _initSettingsDrawer() {
  const drawer = document.getElementById("settings-drawer");
  const openBtn = document.getElementById("settings-drawer-btn");
  const closeBtn = document.getElementById("close-settings-drawer");

  openBtn.addEventListener("click", () => {
    drawer.classList.toggle("closed");
    const isOpen = !drawer.classList.contains("closed");
    // Highlight the button when drawer is open
    openBtn.classList.toggle("active", isOpen);
    // Mutual exclusion: opening settings closes the annotation drawer.
    if (isOpen) v6UiState.setDrawerOpen(false);
  });

  closeBtn.addEventListener("click", () => {
    drawer.classList.add("closed");
    openBtn.classList.remove("active");
  });

  // Mutual exclusion: opening the annotation drawer closes settings.
  v6UiState.subscribe(() => {
    if (v6UiState.getDrawerOpen() && !drawer.classList.contains("closed")) {
      drawer.classList.add("closed");
      openBtn.classList.remove("active");
    }
  });

  // Language select — reflect persisted state, then wire change handler
  const savedLang = (() => {
    try { return localStorage.getItem(_LANG_KEY) || "en"; } catch (_) { return "en"; }
  })();
  const langSelect = document.getElementById("settings-language");
  if (langSelect) {
    langSelect.value = savedLang;
    langSelect.addEventListener("change", () => _applyLanguage(langSelect.value));
  }
}

_restoreLanguage();

// ----------------------------------------------------------------------------
// Document Ready Hook
// ----------------------------------------------------------------------------

document.addEventListener("DOMContentLoaded", () => {
  initAnnotationV6();

  // --- Collapse wiring for nav cards and collapsible fieldsets ---

  // Nav card collapse (Controls / Waveforms)
  function setupNavSection(toggleId, storageKey) {
    const toggle = document.getElementById(toggleId);
    if (!toggle) return;
    const card = toggle.closest(".nav-card");
    if (!card) return;
    toggle.addEventListener("click", () => {
      card.classList.toggle("collapsed");
      try {
        localStorage.setItem(storageKey, card.classList.contains("collapsed"));
      } catch (_) {}
    });
    try {
      if (localStorage.getItem(storageKey) === "true")
        card.classList.add("collapsed");
    } catch (_) {}
  }
  setupNavSection("nav-middle-toggle", "nav-middle-collapsed");
  setupNavSection("nav-bottom-toggle", "nav-bottom-collapsed");

  // Collapsible fieldset legend clicks (event delegation)
  document.addEventListener("click", (e) => {
    const legend = e.target.closest(".collapsible-fieldset > legend");
    if (!legend) return;
    const fieldset = legend.parentElement;
    fieldset.classList.toggle("collapsed");
    try {
      if (fieldset.id) {
        localStorage.setItem(
          "fieldset-collapsed-" + fieldset.id,
          fieldset.classList.contains("collapsed"),
        );
      }
    } catch (_) {}
  });
  // Restore fieldset collapse states
  document.querySelectorAll(".collapsible-fieldset[id]").forEach((fs) => {
    try {
      if (localStorage.getItem("fieldset-collapsed-" + fs.id) === "true")
        fs.classList.add("collapsed");
    } catch (_) {}
  });

  // Initialise Solid auth (process any incoming redirect code, then populate drawer).
  // Skip in align mode — Solid is irrelevant until user transitions to listen mode.
  if (window.alignMode !== "align") {
    initSolidAuth();
  }

  // set up Verovio
  //
  // Readiness is probed by constructing the toolkit itself: 6.x builds no
  // longer expose `verovio.module.calledRun`, and `onRuntimeInitialized`
  // never fires when the wasm runtime finished before this script ran — so
  // the callback is kept as a fast path with a poll as the backstop. The cap
  // settles to null: an unsettled promise would hang every awaiting caller
  // forever, which is worse than no score.
  _verovioReady = new Promise((resolve) => {
    if (typeof verovio === "undefined") {
      console.warn("Verovio not present; score synthesis unavailable");
      resolve(null);
      return;
    }
    const tryToolkit = () => {
      if (tk) return true;
      try {
        setTk(new verovio.toolkit());
      } catch (_) {
        return false; // wasm runtime not ready yet
      }
      // Pin 5.x semantics: never auto-apply score expansions. Verovio 6
      // otherwise applies a default expansion to MIDI/timemap output, which
      // would skew score_onset against alignments generated under 5.x — and
      // getTimesForElement returns all zeros when the expansion cannot be
      // generated (as with editorial content). Revisit if expansions are
      // ever adopted deliberately (roadmap item T).
      tk.setOptions({ expandNever: true });
      console.log("Have Verovio toolkit:", tk.getVersion());
      resolve(tk);
      return true;
    };
    if (tryToolkit()) return;
    verovio.module.onRuntimeInitialized = () => tryToolkit();
    const started = Date.now();
    const poll = setInterval(() => {
      if (tryToolkit() || Date.now() - started > 30000) {
        clearInterval(poll);
        if (!tk) {
          console.warn(
            "Verovio failed to initialise; score synthesis unavailable",
          );
          resolve(null);
        }
      }
    }, 50);
  });
  setVerovioPromise(_verovioReady);

  // --- Align panel integration ---
  if (window.alignMode === "align") {
    const alignPanel = document.getElementById("align-panel");
    if (alignPanel) {
      alignPanel.style.display = "flex";
      configureAlign({
        workerUrl: root + "js/align-worker.js",
        onComplete: onAlignmentComplete,
      });
      initAlignPanel();
    }
  }

  // Download JSON button
  const dlBtn = document.getElementById("download-json-btn");
  if (dlBtn) {
    dlBtn.addEventListener("click", () => {
      if (!loadedAlignmentJSON) return;
      // Phase E will serialise V6 annotation state into loadedAlignmentJSON
      // inside this hook. For now it just clears V6's per-annotation
      // hasUnsavedChanges flags, which in turn pushes the central indicator
      // clean via setAnnoChangesPending(false).
      commitAnnotationsToAlignment(loadedAlignmentJSON);
      // The saved file carries the current (possibly corrected) times, so
      // re-fingerprint from them — otherwise re-loading what we just wrote
      // would look like a different piece (#32).
      for (const [key, grid] of Object.entries(alignmentGrids)) {
        if (key !== SYNTH_MEI_KEY && Array.isArray(grid)) {
          session.gridFingerprints[key] = gridFingerprint(grid);
        }
      }
      const blob = new Blob([JSON.stringify(loadedAlignmentJSON, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "alignment.json";
      a.click();
      URL.revokeObjectURL(url);
      _savedAtCounter = _changeCounter;
      updateDirtyState();
    });
    if (alignmentData === "session") dlBtn.style.display = ""; // legacy fallback
  }

  // Group files button
  const groupFilesBtn = document.getElementById("group-files-btn");
  if (groupFilesBtn) {
    groupFilesBtn.addEventListener("click", () => openGroupModal());
  }

  // -----------------------------------------------------------------------
  // Tools panel + Unified undo/redo + Marker drag + Alignment correction
  // -----------------------------------------------------------------------
  const toolsPanel = document.getElementById("tools-panel");
  const closeListeningCb = document.getElementById("close-listening-cb");
  const dragMarkersCb = document.getElementById("drag-markers-cb");
  const dragModeMove = document.getElementById("drag-mode-move");
  const dragModeFix = document.getElementById("drag-mode-fix");
  const radiusFieldset = document.getElementById("radius-fieldset");
  const radiusNarrow = document.getElementById("radius-narrow");
  const radiusMedium = document.getElementById("radius-medium");
  const radiusWide = document.getElementById("radius-wide");
  const undoBtn = document.getElementById("undo-btn");
  const redoBtn = document.getElementById("redo-btn");
  const revertBtn = document.getElementById("revert-all-btn");

  // Tools panel collapse is handled by the generic .collapsible-fieldset
  // legend delegation above. The "…" hint also expands it.
  const moreHint = document.getElementById("tools-more-hint");
  if (moreHint) {
    moreHint.addEventListener("click", (e) => {
      e.stopPropagation();
      if (toolsPanel) toolsPanel.classList.remove("collapsed");
      try {
        if (toolsPanel && toolsPanel.id) {
          localStorage.setItem("fieldset-collapsed-" + toolsPanel.id, "false");
        }
      } catch (_) {}
    });
  }

  // --- Close Listening checkbox ---
  if (closeListeningCb) {
    closeListeningCb.addEventListener("change", () => {
      if (closeListeningCb.checked) {
        // null → activate the closest jump target (marker or active-annotation
        // region start) at/before the playhead.
        enterCloseListeningMode(null);
      } else {
        exitCloseListeningMode();
      }
    });
  }

  // --- Drag markers checkbox ---
  if (dragMarkersCb) {
    // Sync initial state from (possibly browser-cached) form value
    dragMarkersEnabled = dragMarkersCb.checked;
    if (dragModeMove) dragModeMove.disabled = !dragMarkersEnabled;
    if (dragModeFix) dragModeFix.disabled = !dragMarkersEnabled;
    dragMarkersCb.addEventListener("change", () => {
      dragMarkersEnabled = dragMarkersCb.checked;
      // Enable/disable the drag-mode radio buttons
      if (dragModeMove) dragModeMove.disabled = !dragMarkersEnabled;
      if (dragModeFix) dragModeFix.disabled = !dragMarkersEnabled;
      _updateDragFieldsetState();
    });
  }

  // --- Drag mode radios ---
  // Sync initial state from (possibly browser-cached) radio selection
  _dragMode =
    document.querySelector('input[name="drag-mode"]:checked')?.value || "move";
  [dragModeMove, dragModeFix].forEach((r) => {
    if (r)
      r.addEventListener("change", () => {
        _dragMode =
          document.querySelector('input[name="drag-mode"]:checked')?.value ||
          "move";
        _updateDragFieldsetState();
      });
  });

  // Apply initial enabled/correction state
  _updateDragFieldsetState();

  // --- Radius radios ---
  // Sync initial state from (possibly browser-cached) radio selection
  const _initRadius = document.querySelector('input[name="radius"]:checked');
  if (_initRadius) _alignRadius = parseInt(_initRadius.value);
  [radiusNarrow, radiusMedium, radiusWide].forEach((r) => {
    if (r)
      r.addEventListener("change", () => {
        _alignRadius = parseInt(r.value);
      });
  });

  // --- Unified Undo / Redo ---

  /** Push an entry onto the undo stack. Clears redo on commit=true. */
  function _pushUndo(entry, commit = false) {
    _undoStack.push(entry);
    if (commit) {
      _changeCounter++;
      _redoStack.length = 0;
    }
    _updateUndoRedoState();
  }
  // Fix-mode correction commits ride the same unified stack (plan §14 B3).
  _pushFixUndoImpl = _pushUndo;

  /** Delete the currently active marker (close-listening mode). */
  function _deleteActiveMarker() {
    if (!closeListeningMode || activeMarkerIx == null) return;
    const deletedAlignIx = markers[activeMarkerIx];
    const deletedArrayIx = activeMarkerIx;
    markers.splice(activeMarkerIx, 1);
    persistMarkers();
    _pushUndo(
      {
        type: "marker-delete",
        alignIx: deletedAlignIx,
        markerArrayIx: deletedArrayIx,
      },
      true,
    );
    if (markers.length === 0) {
      exitCloseListeningMode();
    } else {
      let bestIx = 0;
      let bestDist = Infinity;
      for (let i = 0; i < markers.length; i++) {
        const dist = markers[i] - deletedAlignIx;
        const absDist = Math.abs(dist);
        if (absDist < bestDist || (absDist === bestDist && dist < 0)) {
          bestDist = absDist;
          bestIx = i;
        }
      }
      setActiveMarkerIx(bestIx);
      redrawAllMarkers();
      seekToActiveMarker();
    }
  }

  function _undoOne() {
    if (_undoStack.length === 0) return;
    const top = _undoStack[_undoStack.length - 1];
    // A fix entry cannot hop while its sibling's realign is still splicing.
    if (top.type?.startsWith("fix-") && fixRealignBusy()) return;
    _changeCounter--;
    const entry = _undoStack.pop();
    switch (entry.type) {
      case "align-fix": {
        _redoStack.push({
          type: "align-fix",
          filename: entry.filename,
          grid: alignmentGrids[entry.filename].slice(),
        });
        alignmentGrids[entry.filename] = entry.grid;
        _syncGridToJSON(entry.filename);
        drawAlignmentGrid(entry.filename);
        break;
      }
      case "marker-add": {
        // Undo add = remove the marker
        const ix = markers.indexOf(entry.alignIx);
        if (ix > -1) {
          markers.splice(ix, 1);
          persistMarkers();
          _redoStack.push({
            type: "marker-add",
            alignIx: entry.alignIx,
            markerArrayIx: ix,
          });
          if (closeListeningMode) {
            if (markers.length === 0) {
              exitCloseListeningMode();
            } else {
              setActiveMarkerIx(
                Math.min(activeMarkerIx || 0, markers.length - 1),
              );
            }
          }
          redrawAllMarkers();
        }
        break;
      }
      case "marker-delete": {
        // Undo delete = re-insert the marker
        const insertIx = Math.min(entry.markerArrayIx, markers.length);
        markers.splice(insertIx, 0, entry.alignIx);
        persistMarkers();
        _redoStack.push({
          type: "marker-delete",
          alignIx: entry.alignIx,
          markerArrayIx: insertIx,
        });
        if (closeListeningMode) {
          setActiveMarkerIx(insertIx);
        }
        redrawAllMarkers();
        break;
      }
      case "marker-move": {
        // Undo move = restore old position
        markers[entry.markerArrayIx] = entry.oldAlignIx;
        persistMarkers();
        _redoStack.push({
          type: "marker-move",
          markerArrayIx: entry.markerArrayIx,
          oldAlignIx: entry.newAlignIx,
          newAlignIx: entry.oldAlignIx,
        });
        redrawAllMarkers();
        if (closeListeningMode) seekToActiveMarker();
        break;
      }
      case "fix-anchor":
      case "fix-gap": {
        // Snapshot semantics: the entry carries its before/after values, so
        // fix-mode applies the hop without the alignment worker; the same
        // entry object shuttles between the stacks.
        applyFixCorrectionUndo(entry);
        _redoStack.push(entry);
        break;
      }
    }
    _updateUndoRedoState();
  }

  function _redoOne() {
    if (_redoStack.length === 0) return;
    const top = _redoStack[_redoStack.length - 1];
    if (top.type?.startsWith("fix-") && fixRealignBusy()) return;
    _changeCounter++;
    const entry = _redoStack.pop();
    switch (entry.type) {
      case "align-fix": {
        _undoStack.push({
          type: "align-fix",
          filename: entry.filename,
          grid: alignmentGrids[entry.filename].slice(),
        });
        alignmentGrids[entry.filename] = entry.grid;
        _syncGridToJSON(entry.filename);
        drawAlignmentGrid(entry.filename);
        break;
      }
      case "marker-add": {
        // Redo add = re-insert
        const insertIx = Math.min(entry.markerArrayIx, markers.length);
        markers.splice(insertIx, 0, entry.alignIx);
        persistMarkers();
        _undoStack.push({
          type: "marker-add",
          alignIx: entry.alignIx,
          markerArrayIx: insertIx,
        });
        redrawAllMarkers();
        break;
      }
      case "marker-delete": {
        // Redo delete = remove again
        const ix = markers.indexOf(entry.alignIx);
        if (ix > -1) {
          markers.splice(ix, 1);
          persistMarkers();
          _undoStack.push({
            type: "marker-delete",
            alignIx: entry.alignIx,
            markerArrayIx: ix,
          });
          if (closeListeningMode) {
            if (markers.length === 0) {
              exitCloseListeningMode();
            } else {
              setActiveMarkerIx(
                Math.min(activeMarkerIx || 0, markers.length - 1),
              );
            }
          }
          redrawAllMarkers();
        }
        break;
      }
      case "marker-move": {
        markers[entry.markerArrayIx] = entry.newAlignIx;
        persistMarkers();
        _undoStack.push({
          type: "marker-move",
          markerArrayIx: entry.markerArrayIx,
          oldAlignIx: entry.oldAlignIx,
          newAlignIx: entry.newAlignIx,
        });
        redrawAllMarkers();
        if (closeListeningMode) seekToActiveMarker();
        break;
      }
      case "fix-anchor":
      case "fix-gap": {
        applyFixCorrectionRedo(entry);
        _undoStack.push(entry);
        break;
      }
    }
    _updateUndoRedoState();
  }

  function _revertAll() {
    for (const [filename, original] of Object.entries(_alignOriginalGrids)) {
      alignmentGrids[filename] = original.slice();
      _syncGridToJSON(filename);
      drawAlignmentGrid(filename);
    }
    // Also restore markers to saved state
    if (loadedAlignmentJSON?.header?.markers) {
      refillArray(markers, loadedAlignmentJSON.header.markers);
    } else {
      markers.length = 0;
    }
    redrawAllMarkers();
    // Fix-mode corrections revert to the as-loaded ref tables and record too.
    fixRevertCorrections();
    _undoStack.length = 0;
    _redoStack.length = 0;
    _changeCounter = _savedAtCounter;
    _updateUndoRedoState();
  }

  /** Short description of an undo/redo entry's action. */
  function _actionLabel(entry) {
    if (!entry) return "";
    switch (entry.type) {
      case "align-fix":
        return "fix alignment";
      case "marker-add":
        return "add marker";
      case "marker-delete":
        return "delete marker";
      case "marker-move":
        return "move marker";
      case "fix-anchor":
        return "alignment anchor";
      case "fix-gap":
        return "unscored-audio gap";
      default:
        return "";
    }
  }

  function _updateUndoRedoState() {
    if (undoBtn) {
      undoBtn.disabled = _undoStack.length === 0;
      const uLabel = _actionLabel(_undoStack[_undoStack.length - 1]);
      undoBtn.textContent = uLabel ? `Undo: ${uLabel}` : "Undo";
      undoBtn.title = uLabel ? `Undo: ${uLabel} (Ctrl+Z)` : "Undo (Ctrl+Z)";
    }
    if (redoBtn) {
      redoBtn.disabled = _redoStack.length === 0;
      const rLabel = _actionLabel(_redoStack[_redoStack.length - 1]);
      redoBtn.textContent = rLabel ? `Redo: ${rLabel}` : "Redo";
      redoBtn.title = rLabel
        ? `Redo: ${rLabel} (Ctrl+Shift+Z)`
        : "Redo (Ctrl+Shift+Z)";
    }
    if (revertBtn) {
      let hasChanges = fixCorrectionsDirty();
      if (!hasChanges) {
        for (const [filename, original] of Object.entries(_alignOriginalGrids)) {
          const current = alignmentGrids[filename];
          if (!current || current.length !== original.length) {
            hasChanges = true;
            break;
          }
          for (let i = 0; i < original.length; i++) {
            if (current[i] !== original[i]) {
              hasChanges = true;
              break;
            }
          }
          if (hasChanges) break;
        }
      }
      revertBtn.disabled = !hasChanges;
    }
    updateDirtyState();
  }

  function _syncGridToJSON(filename) {
    if (!loadedAlignmentJSON?.body?.audio) return;
    const entry = loadedAlignmentJSON.body.audio[filename];
    if (!entry) return;
    if (entry && !Array.isArray(entry) && Array.isArray(entry.times)) {
      entry.times = alignmentGrids[filename];
    } else {
      loadedAlignmentJSON.body.audio[filename] = alignmentGrids[filename];
    }
  }

  if (undoBtn) undoBtn.addEventListener("click", _undoOne);
  if (redoBtn) redoBtn.addEventListener("click", _redoOne);
  if (revertBtn) {
    revertBtn.addEventListener("click", () => {
      if (confirm("Revert all alignment corrections to the original?"))
        _revertAll();
    });
  }
  // Ensure buttons reflect initial state (all disabled, clean)
  _updateUndoRedoState();

  // Ctrl+Z / Ctrl+Shift+Z keyboard shortcuts for undo / redo
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey) {
      e.preventDefault();
      _undoOne();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === "z" && e.shiftKey) {
      e.preventDefault();
      _redoOne();
    }
  });

  // --- Marker drag interaction ---
  // Proximity detection: within MARKER_GRAB_PX pixels of a marker line
  const MARKER_GRAB_PX = 20;
  let _markerDragState = null; // { filename, markerArrayIx, startX, startAlignIx, wfEl }

  /** Find the closest marker element near clientX on a waveform element.
   *  Returns { markerEl, markerArrayIx, distPx } or null. */
  function _findNearbyMarker(wfEl, clientX) {
    const markers_els = wfEl.querySelectorAll(".ws-marker[data-align-ix]");
    let best = null;
    markers_els.forEach((el) => {
      const rect = el.getBoundingClientRect();
      const markerX = rect.left + rect.width / 2;
      const dist = Math.abs(clientX - markerX);
      if (dist < MARKER_GRAB_PX && (!best || dist < best.distPx)) {
        const alignIx = parseInt(el.dataset.alignIx);
        const arrIx = markers.indexOf(alignIx);
        if (arrIx > -1)
          best = { markerEl: el, markerArrayIx: arrIx, distPx: dist };
      }
    });
    return best;
  }

  // Expand Controls nav card, Tools panel, and Drag Markers sub-fieldset if collapsed
  function _expandToolsPanel() {
    // Expand the Controls nav card
    const navMiddleToggle = document.getElementById("nav-middle-toggle");
    if (navMiddleToggle) {
      const card = navMiddleToggle.closest(".nav-card");
      if (card && card.classList.contains("collapsed")) {
        card.classList.remove("collapsed");
        try {
          localStorage.setItem("nav-middle-collapsed", "false");
        } catch (_) {}
      }
    }
    const toolsPanel = document.getElementById("tools-panel");
    if (toolsPanel && toolsPanel.classList.contains("collapsed")) {
      toolsPanel.classList.remove("collapsed");
      try {
        localStorage.setItem("fieldset-collapsed-tools-panel", "false");
      } catch (_) {}
    }
    const dragFieldset = document.getElementById("drag-marker-fieldset");
    if (dragFieldset && dragFieldset.classList.contains("collapsed")) {
      dragFieldset.classList.remove("collapsed");
      try {
        localStorage.setItem(
          "fieldset-collapsed-drag-marker-fieldset",
          "false",
        );
      } catch (_) {}
    }
  }

  // Pulse hint for "Drag markers" when user clicks near a marker with drag disabled
  function _showDragMarkerPulse() {
    _expandToolsPanel();
    const fieldset = document.getElementById("drag-marker-fieldset");
    if (!fieldset) return;
    fieldset.classList.add("pulse-hint");
    fieldset.addEventListener(
      "animationend",
      () => {
        fieldset.classList.remove("pulse-hint");
      },
      { once: true },
    );
    // First-time tooltip
    if (!_pulseHintShown) {
      _pulseHintShown = true;
      const tip = document.createElement("div");
      tip.className = "pulse-tooltip";
      tip.textContent = "Enable to drag markers";
      tip.style.cssText =
        "position:absolute;top:-1.5em;left:50%;transform:translateX(-50%);font-size:0.72em;background:#1e40af;color:#fff;padding:0.2em 0.5em;border-radius:3px;white-space:nowrap;z-index:10;pointer-events:none;";
      fieldset.style.position = "relative";
      fieldset.appendChild(tip);
      setTimeout(() => tip.remove(), 2500);
    }
  }

  // Pulse hint to disable drag mode when user clicks empty area with drag enabled
  function _showDisableDragPulse() {
    _expandToolsPanel();
    const fieldset = document.getElementById("drag-marker-fieldset");
    if (!fieldset) return;
    fieldset.classList.add("pulse-hint");
    fieldset.addEventListener(
      "animationend",
      () => {
        fieldset.classList.remove("pulse-hint");
      },
      { once: true },
    );
    if (!_disableDragHintShown) {
      _disableDragHintShown = true;
      const tip = document.createElement("div");
      tip.className = "pulse-tooltip";
      tip.textContent = "Uncheck to click freely";
      tip.style.cssText =
        "position:absolute;top:-1.5em;left:50%;transform:translateX(-50%);font-size:0.72em;background:#1e40af;color:#fff;padding:0.2em 0.5em;border-radius:3px;white-space:nowrap;z-index:10;pointer-events:none;";
      fieldset.style.position = "relative";
      fieldset.appendChild(tip);
      setTimeout(() => tip.remove(), 2500);
    }
  }

  // Prevent native browser drag on waveforms during draw-region mode.
  // Without this, the browser initiates a native HTML drag (ghost image)
  // instead of letting the WaveSurfer regions plugin handle pointer events.
  document.getElementById("waveforms").addEventListener("dragstart", (e) => {
    if (_drawModeActive) e.preventDefault();
  });

  // Mousedown on waveforms: handle marker drag start
  document.getElementById("waveforms").addEventListener("mousedown", (e) => {
    const wfEl = e.target.closest(".waveform");
    if (!wfEl) return;
    const filename = wfEl.dataset.ix;
    if (!filename) return;

    // Check proximity to a marker
    const nearby = _findNearbyMarker(wfEl, e.clientX);
    if (!nearby) {
      // Clicked away from markers — if drag mode is on, hint to disable it
      if (dragMarkersEnabled) _showDisableDragPulse();
      return;
    }

    // If close-listening not active, enter it with this marker
    if (!closeListeningMode) {
      enterCloseListeningMode(nearby.markerArrayIx);
    } else if (!dragMarkersEnabled) {
      // Not dragging — select this marker and seek to it
      setActiveMarkerIx(nearby.markerArrayIx);
      redrawAllMarkers();
      seekToActiveMarker();
    } else {
      // Drag enabled — just select the marker (no seek/jump)
      setActiveMarkerIx(nearby.markerArrayIx);
      redrawAllMarkers();
    }

    // If drag markers not enabled, show pulse hint
    if (!dragMarkersEnabled) {
      _showDragMarkerPulse();
      return;
    }

    // Start drag
    e.preventDefault();
    document.body.classList.add("marker-dragging");
    _markerDragState = {
      filename,
      markerArrayIx: nearby.markerArrayIx,
      startX: e.clientX,
      startAlignIx: markers[nearby.markerArrayIx],
      wfEl,
    };

    // If in fix-alignment mode, also set up the correction drag
    if (_dragMode === "fix") {
      const grid = alignmentGrids[filename];
      if (
        !grid ||
        filename === referenceAudioIx ||
        filename === SYNTH_MEI_KEY
      ) {
        _markerDragState = null;
        document.body.classList.remove("marker-dragging");
        return;
      }
      const jCenter = markers[nearby.markerArrayIx];
      const sigma = _sigmaFromEvent(e);
      const isGlobal = e.ctrlKey || e.metaKey;
      const origGrid = grid.slice();
      const dur = wavesurfers[filename]?.getDuration() || 1;
      // Push undo entries for alignment grids
      if (isGlobal) {
        for (const fn of Object.keys(alignmentGrids)) {
          if (fn === referenceAudioIx || fn === SYNTH_MEI_KEY) continue;
          _pushUndo({
            type: "align-fix",
            filename: fn,
            grid: alignmentGrids[fn].slice(),
          });
        }
      } else {
        _pushUndo({ type: "align-fix", filename, grid: origGrid });
      }
      _markerDragState.fixMode = true;
      _markerDragState.jCenter = jCenter;
      _markerDragState.origGrid = origGrid;
      _markerDragState.sigma = sigma;
      _markerDragState.dur = dur;
      _markerDragState.isGlobal = isGlobal;
    }
  });

  // Mousemove: drag marker
  document.addEventListener("mousemove", (e) => {
    if (!_markerDragState) return;
    const { filename, markerArrayIx, startX, wfEl, fixMode } = _markerDragState;
    const dur = wavesurfers[filename]?.getDuration() || 1;
    const rect = wfEl.getBoundingClientRect();
    const _zoomedW = getZoomedWidth(filename) || rect.width;

    if (fixMode) {
      // Fix alignment mode: morph the grid
      _markerDragState.sigma = _sigmaFromEvent(e);
      const sigma = _markerDragState.sigma;
      const dtDrag = (e.clientX - startX) / (_zoomedW / dur);
      const morphed = _morphGrid(
        _markerDragState.origGrid,
        _markerDragState.jCenter,
        dtDrag,
        sigma,
      );
      const corrCanvas = wfEl.querySelector(".align-correction-overlay");
      if (corrCanvas) {
        _drawMorphPreview(
          corrCanvas,
          filename,
          morphed,
          _markerDragState.origGrid,
        );
      }
      // Show the dragged marker at its morphed position
      const morphedTime = morphed[_markerDragState.jCenter];
      const _fullW = getZoomedWidth(filename);
      const leftPx =
        dur > 0
          ? Math.max(0, Math.min(_fullW, (morphedTime / dur) * _fullW))
          : 0;
      const markerEl = wfEl.querySelector(
        `.ws-marker[data-align-ix="${markers[markerArrayIx]}"]`,
      );
      if (markerEl) markerEl.style.left = `${leftPx}px`;
      // Update all other markers on this waveform to their morphed positions
      wfEl.querySelectorAll(".ws-marker[data-align-ix]").forEach((el) => {
        if (el === markerEl) return;
        const aIx = parseInt(el.dataset.alignIx);
        if (aIx >= 0 && aIx < morphed.length) {
          const t = morphed[aIx];
          const p =
            dur > 0 ? Math.max(0, Math.min(_fullW, (t / dur) * _fullW)) : 0;
          el.style.left = `${p}px`;
        }
      });
      // Global preview on other waveforms
      if (_markerDragState.isGlobal) {
        document.querySelectorAll(".align-correction-overlay").forEach((c) => {
          const fn = c.closest(".waveform")?.dataset.ix;
          if (
            !fn ||
            fn === filename ||
            fn === referenceAudioIx ||
            fn === SYNTH_MEI_KEY
          )
            return;
          const fnOrigGrid = _undoStack
            .slice()
            .reverse()
            .find((u) => u.type === "align-fix" && u.filename === fn)?.grid;
          if (!fnOrigGrid) return;
          const refSpacing =
            _markerDragState.origGrid[_markerDragState.jCenter] || 1;
          const localSpacing = fnOrigGrid[_markerDragState.jCenter] || 1;
          const scale = localSpacing / refSpacing;
          const localMorphed = _morphGrid(
            fnOrigGrid,
            _markerDragState.jCenter,
            dtDrag * scale,
            sigma,
          );
          _drawMorphPreview(c, fn, localMorphed, fnOrigGrid);
        });
      }
    } else {
      // Move marker mode: show cursor at new position
      const pxDelta = e.clientX - startX;
      const timeDelta = (pxDelta / _zoomedW) * dur;
      const origTime = getCorrespondingTime(
        filename,
        _markerDragState.startAlignIx,
      );
      const newTime = Math.max(0, Math.min(dur, origTime + timeDelta));
      const newAlignIx = getClosestAlignmentIx(newTime, filename);
      // Temporarily update marker position for visual feedback
      markers[markerArrayIx] = newAlignIx;
      redrawAllMarkers();
    }
  });

  // Mouseup: commit marker drag
  document.addEventListener("mouseup", (e) => {
    if (!_markerDragState) return;
    const { filename, markerArrayIx, startX, startAlignIx, wfEl, fixMode } =
      _markerDragState;
    const dur = wavesurfers[filename]?.getDuration() || 1;
    const rect = wfEl.getBoundingClientRect();
    const _zoomedW = getZoomedWidth(filename) || rect.width;

    if (fixMode) {
      const dtDrag = (e.clientX - startX) / (_zoomedW / dur);
      if (Math.abs(dtDrag) < 1e-4) {
        // No meaningful drag — pop the undo entries
        if (_markerDragState.isGlobal) {
          for (const fn of Object.keys(alignmentGrids)) {
            if (fn === referenceAudioIx || fn === SYNTH_MEI_KEY) continue;
            _undoStack.pop();
          }
        } else {
          _undoStack.pop();
        }
      } else {
        const sigma = _markerDragState.sigma;
        const morphed = _morphGrid(
          _markerDragState.origGrid,
          _markerDragState.jCenter,
          dtDrag,
          sigma,
        );
        alignmentGrids[filename] = morphed;
        _syncGridToJSON(filename);
        drawAlignmentGrid(filename);
        if (_markerDragState.isGlobal) {
          for (const fn of Object.keys(alignmentGrids)) {
            if (
              fn === filename ||
              fn === referenceAudioIx ||
              fn === SYNTH_MEI_KEY
            )
              continue;
            const fnOrigGrid = _undoStack
              .slice()
              .reverse()
              .find((u) => u.type === "align-fix" && u.filename === fn)?.grid;
            if (!fnOrigGrid) continue;
            const refSpacing =
              _markerDragState.origGrid[_markerDragState.jCenter] || 1;
            const localSpacing = fnOrigGrid[_markerDragState.jCenter] || 1;
            const scale = localSpacing / refSpacing;
            const localMorphed = _morphGrid(
              fnOrigGrid,
              _markerDragState.jCenter,
              dtDrag * scale,
              sigma,
            );
            alignmentGrids[fn] = localMorphed;
            _syncGridToJSON(fn);
            drawAlignmentGrid(fn);
          }
        }
        // Commit: clear redo stack
        _redoStack.length = 0;
      }
      // Clear correction overlays
      document.querySelectorAll(".align-correction-overlay").forEach((c) => {
        c.getContext("2d").clearRect(0, 0, c.width, c.height);
      });
      // Redraw markers — grid times have changed, so marker positions must update
      redrawAllMarkers();
    } else {
      // Move marker mode: commit the new position
      const pxDelta = e.clientX - startX;
      const timeDelta = (pxDelta / _zoomedW) * dur;
      const origTime = getCorrespondingTime(filename, startAlignIx);
      const newTime = Math.max(0, Math.min(dur, origTime + timeDelta));
      const newAlignIx = getClosestAlignmentIx(newTime, filename);
      if (newAlignIx !== startAlignIx) {
        markers[markerArrayIx] = newAlignIx;
        persistMarkers();
        _pushUndo(
          {
            type: "marker-move",
            markerArrayIx,
            oldAlignIx: startAlignIx,
            newAlignIx,
          },
          true,
        );
        redrawAllMarkers();
        if (closeListeningMode) seekToActiveMarker();
      } else {
        // Restore original position (no change)
        markers[markerArrayIx] = startAlignIx;
        redrawAllMarkers();
      }
    }
    _markerDragState = null;
    document.body.classList.remove("marker-dragging");
    _updateUndoRedoState();
  });

  // --- Hover influence zone for fix-alignment mode ---
  let _lastHoverCanvas = null;
  let _lastHoverFilename = null;
  let _lastHoverMouseX = null;

  document.addEventListener("keydown", _onModifierChange);
  document.addEventListener("keyup", _onModifierChange);
  function _onModifierChange(e) {
    if (!_alignCorrectionMode || _markerDragState) return;
    if (!(e.key === "Shift" || e.key === "Alt")) return;
    if (_lastHoverCanvas && _lastHoverFilename && _lastHoverMouseX != null) {
      const sigma = _sigmaFromEvent(e);
      _drawInfluenceZone(
        _lastHoverCanvas,
        _lastHoverFilename,
        _lastHoverMouseX,
        sigma,
      );
    }
  }

  function _drawInfluenceZone(canvas, filename, mouseX, sigma) {
    const ctx = canvas.getContext("2d");
    const viewW = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, viewW, h);
    const grid = alignmentGrids[filename];
    if (!grid || grid.length === 0) return;
    const dur = wavesurfers[filename]?.getDuration() || 1;
    const fullW = getZoomedWidth(filename) || viewW;
    const scrollLeft = wavesurfers[filename]?.getScroll() || 0;
    // mouseX is viewport-relative; convert to full-width coordinate for time lookup
    const mouseTime = ((mouseX + scrollLeft) / fullW) * dur;
    let jCenter = 0;
    let bestDist = Infinity;
    for (let j = 0; j < grid.length; j++) {
      const d = Math.abs(grid[j] - mouseTime);
      if (d < bestDist) {
        bestDist = d;
        jCenter = j;
      }
    }
    const _izC = parseCssColor(getComputedStyle(document.documentElement).getPropertyValue("--color-score-band").trim()) || { r: 70, g: 130, b: 230 };
    const _izRgb = `${_izC.r},${_izC.g},${_izC.b}`;
    ctx.fillStyle = `rgba(${_izRgb},0.12)`;
    const cutoff = Math.ceil(sigma * 3);
    const jMin = Math.max(0, jCenter - cutoff);
    const jMax = Math.min(grid.length - 1, jCenter + cutoff);
    const xMin = (grid[jMin] / dur) * fullW - scrollLeft;
    const xMax = (grid[jMax] / dur) * fullW - scrollLeft;
    ctx.fillRect(xMin, 0, xMax - xMin, h);
    const xCenter = (grid[jCenter] / dur) * fullW - scrollLeft;
    ctx.strokeStyle = `rgba(${_izRgb},0.5)`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(xCenter, 0);
    ctx.lineTo(xCenter, h);
    ctx.stroke();
  }

  function _drawMorphPreview(canvas, filename, morphedGrid, origGrid) {
    const ctx = canvas.getContext("2d");
    const viewW = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, viewW, h);
    const dur = wavesurfers[filename]?.getDuration() || 1;
    const fullW = getZoomedWidth(filename) || viewW;
    const scrollLeft = wavesurfers[filename]?.getScroll() || 0;
    // Dynamic extent band: highlight all entries with displacement > 0.5% of peak
    if (_markerDragState && _markerDragState.fixMode && origGrid) {
      let peakDisp = 0;
      for (let j = 0; j < morphedGrid.length; j++) {
        peakDisp = Math.max(peakDisp, Math.abs(morphedGrid[j] - origGrid[j]));
      }
      if (peakDisp > 1e-6) {
        const threshold = peakDisp * 0.005;
        let jMin = morphedGrid.length - 1;
        let jMax = 0;
        for (let j = 0; j < morphedGrid.length; j++) {
          if (Math.abs(morphedGrid[j] - origGrid[j]) > threshold) {
            if (j < jMin) jMin = j;
            if (j > jMax) jMax = j;
          }
        }
        if (jMin <= jMax) {
          const xMin = (morphedGrid[jMin] / dur) * fullW - scrollLeft;
          const xMax = (morphedGrid[jMax] / dur) * fullW - scrollLeft;
          const _mpBand = parseCssColor(getComputedStyle(document.documentElement).getPropertyValue("--color-score-band").trim()) || { r: 70, g: 130, b: 230 };
          ctx.fillStyle = `rgba(${_mpBand.r},${_mpBand.g},${_mpBand.b},0.08)`;
          ctx.fillRect(xMin, 0, xMax - xMin, h);
        }
      }
    }
    // Compute peak displacement for colour interpolation
    const n = morphedGrid.length;
    let peakDispAll = 0;
    if (origGrid) {
      for (let j = 0; j < n; j++) {
        peakDispAll = Math.max(
          peakDispAll,
          Math.abs(morphedGrid[j] - origGrid[j]),
        );
      }
    }
    // Colour endpoints: grid base → bright red, by displacement ratio
    const r0 = 140,
      g0 = 90,
      b0 = 90,
      a0 = 0.55; // grid base
    const r1 = 220,
      g1 = 40,
      b1 = 40,
      a1 = 0.9; // max displacement
    const minPixelStep = 4;
    let lastAbsX = -999;
    ctx.lineWidth = 1;
    for (let j = 0; j < n; j++) {
      const absoluteX = (j / n) * fullW - scrollLeft;
      const relativeX = (morphedGrid[j] / dur) * fullW - scrollLeft;
      if (absoluteX > viewW + 10 && relativeX > viewW + 10) continue;
      if (absoluteX < -10 && relativeX < -10) continue;
      if (absoluteX - lastAbsX < minPixelStep) continue;
      lastAbsX = absoluteX;
      const disp = origGrid ? Math.abs(morphedGrid[j] - origGrid[j]) : 0;
      // Skip lines with negligible displacement
      if (peakDispAll > 1e-6 && disp / peakDispAll < 0.005) continue;
      const t = peakDispAll > 1e-6 ? disp / peakDispAll : 0;
      const r = Math.round(r0 + (r1 - r0) * t);
      const g = Math.round(g0 + (g1 - g0) * t);
      const b = Math.round(b0 + (b1 - b0) * t);
      const a = (a0 + (a1 - a0) * t).toFixed(2);
      ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${a})`;
      ctx.beginPath();
      ctx.moveTo(absoluteX, 0);
      ctx.lineTo(relativeX, h / 6);
      ctx.moveTo(relativeX, 5 * (h / 6));
      ctx.lineTo(absoluteX, h);
      ctx.stroke();
    }
  }

  // Hover: show influence zone near active marker in fix mode
  // Only display when cursor is close to a marker (within MARKER_GRAB_PX).
  document.getElementById("waveforms").addEventListener("mousemove", (e) => {
    if (!_alignCorrectionMode) return;
    if (_markerDragState) return;
    const wfEl = e.target.closest(".waveform");
    if (!wfEl) return;
    const filename = wfEl.dataset.ix;
    if (!filename || filename === referenceAudioIx) return;
    const canvas = wfEl.querySelector(".align-correction-overlay");
    if (!canvas) return;

    // Only show influence zone when near a marker
    const nearby = _findNearbyMarker(wfEl, e.clientX);
    if (!nearby) {
      canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
      canvas.style.cursor = "";
      canvas.title = "";
      _lastHoverCanvas = null;
      _lastHoverFilename = null;
      _lastHoverMouseX = null;
      return;
    }
    // Score waveform alignment is derived from the notation — show forbidden
    if (filename === SYNTH_MEI_KEY) {
      canvas.style.cursor = "not-allowed";
      canvas.title =
        "Score alignment cannot be adjusted — it is derived from note onsets";
      canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
      _lastHoverCanvas = null;
      _lastHoverFilename = null;
      _lastHoverMouseX = null;
      return;
    }
    canvas.style.cursor = "grab";
    canvas.title = "";
    const rect = canvas.getBoundingClientRect();
    const mouseX = (e.clientX - rect.left) * (canvas.width / rect.width);
    _lastHoverCanvas = canvas;
    _lastHoverFilename = filename;
    _lastHoverMouseX = mouseX;
    const sigma = _sigmaFromEvent(e);
    _drawInfluenceZone(canvas, filename, mouseX, sigma);
  });

  document.getElementById("waveforms").addEventListener(
    "mouseleave",
    (e) => {
      if (!_alignCorrectionMode || _markerDragState) return;
      const wfEl = e.target.closest(".waveform");
      if (wfEl) {
        const canvas = wfEl.querySelector(".align-correction-overlay");
        if (canvas) {
          canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
          canvas.style.cursor = "";
          canvas.title = "";
        }
      }
      _lastHoverCanvas = null;
      _lastHoverFilename = null;
      _lastHoverMouseX = null;
    },
    true,
  );

  // load alignment json
  if (window.alignMode === "align") {
    // Align mode: alignment will be produced in-browser via the align panel.
    // Nothing to load yet — onAlignmentComplete() will call setGrids().
  } else if (alignmentData === "local") {
    // Local mode: alignment will be provided via file picker
    // Just show the file picker, alignment loading happens there
    showFilePickerIfNeeded();
  } else if (alignmentData !== "local") {
    // The alignment JSON itself can be slow to arrive — peaks inflate it
    // roughly fivefold — and this fetch happens before setGrids, so cover it
    // here too rather than leaving the pane blank until setGrids takes over.
    showWaveformsPaneLoading("Loading alignment\u2026");
    fetch(alignmentData)
      .then((response) => response.json())
      .then((contents) => {
        setGrids(contents);
      })
      .catch((err) => {
        // No setGrids, so nothing downstream will ever clear the indicator.
        hideWaveformsPaneLoading();
        console.warn("Couldn't load alignment data: ", err);
      });
  }

  // load a colormap json file (kept for potential future use).
  fetch(root + "js/hot-colormap.json")
    .then((r) => r.json())
    .then((cM) => {
      colorMap = cM;
    })
    .catch((err) => console.warn("Couldn't load colormap:", err));
  // --- Transport controls ---
  // Play/pause
  document.getElementById("playpause").addEventListener("click", function () {
    playpause();
  });

  // Skip to start
  document.getElementById("skip-back").addEventListener("click", function () {
    if (!currentAudioIx || !wavesurfers[currentAudioIx]) return;
    wavesurfers[currentAudioIx].seekTo(0);
  });

  // Rewind 10s
  document.getElementById("seek-back").addEventListener("click", function () {
    seekBy(-10);
  });

  // Forward 10s
  document.getElementById("seek-fwd").addEventListener("click", function () {
    seekBy(10);
  });

  // Skip to end
  document.getElementById("skip-end").addEventListener("click", function () {
    if (!currentAudioIx || !wavesurfers[currentAudioIx]) return;
    wavesurfers[currentAudioIx].seekTo(1);
  });

  // mark button — places a new marker, or removes the active marker when
  // paused at one in close-listening mode
  document.getElementById("mark").addEventListener("click", function (e) {
    if (this.dataset.mode === "remove") {
      _deleteActiveMarker();
      updateMarkBtnTooltip();
      return;
    }
    if (!currentAudioIx || !wavesurfers[currentAudioIx]) return;
    let toMark = getClosestAlignmentIx();
    const arrIx = markers.length;
    markers.push(toMark);
    persistMarkers();
    _pushUndo(
      { type: "marker-add", alignIx: toMark, markerArrayIx: arrIx },
      true,
    );
    Object.keys(wavesurfers).forEach((ws) => {
      const t = getCorrespondingTime(ws, toMark);
      addMarker(ws, { time: t, color: "red", alignIx: toMark });
    });
  });
  // normalize audio checkbox
  document.getElementById("normalize").checked = false;
  document.getElementById("normalize").addEventListener("click", (e) => {
    const norm = e.target.checked;
    // Visual: scale waveform peaks to fill available height
    Object.values(wavesurfers).forEach((ws) =>
      ws.setOptions({ normalize: norm }),
    );
    // Audio: adjust GainNode so quieter recordings play at equal volume
    applyNormGain(norm);
  });
  // visualize alignment checkbox — redraw grids to show/hide alignment lines
  document.getElementById("visalign").checked = false;
  document.getElementById("visalign").addEventListener("click", () => {
    Object.keys(waveformViews).forEach((fn) => drawAlignmentGrid(fn));
  });
  // show relative position checkbox — redraw immediately when toggled while paused
  document.getElementById("visrelalign").addEventListener("click", () => {
    if (currentAudioIx && isWaveformRendered(currentAudioIx)) {
      updatePositionIndicator(currentAudioIx);
    }
  });
  // Shared time axis checkbox
  document
    .getElementById("shared-time-axis")
    .addEventListener("change", (e) => {
      setSharedTimeAxis(e.target.checked);
      applyZoom(currentZoomLevel);
    });

  // --- Tempo curve controls ---
  const tempoCheckbox = document.getElementById("show-tempo-curve");
  const tempoOptions = document.getElementById("tempo-curve-options");
  function _redrawAllTempoCurves() {
    Object.keys(waveformViews).forEach((fn) => drawAlignmentGrid(fn));
  }
  if (tempoCheckbox) {
    tempoCheckbox.addEventListener("change", (e) => {
      _tempoCurveVisible = e.target.checked;
      if (tempoOptions)
        tempoOptions.style.display = _tempoCurveVisible ? "" : "none";
      // Recompute Y range when toggling on
      if (_tempoCurveVisible) {
        for (const k of Object.keys(_tempoRawCache)) delete _tempoRawCache[k];
        _tempoYRange = null;
      }
      _redrawAllTempoCurves();
    });
  }
  const scopeControls = document.getElementById("tempo-scope-controls");
  function _updateScopeVisibility() {
    if (scopeControls)
      scopeControls.style.display = _tempoCurveMode === "relative" ? "" : "none";
  }
  document.querySelectorAll('input[name="tempo-mode"]').forEach((radio) => {
    radio.addEventListener("change", (e) => {
      _tempoCurveMode = e.target.value;
      _tempoYRange = null; // recompute for new mode
      _updateScopeVisibility();
      _redrawAllTempoCurves();
    });
  });
  const tempoSmoothingSlider = document.getElementById("tempo-smoothing");
  if (tempoSmoothingSlider) {
    tempoSmoothingSlider.addEventListener("input", (e) => {
      _tempoCurveSmoothing = parseInt(e.target.value);
      _tempoYRange = null; // range depends on smoothed data
      _redrawAllTempoCurves();
    });
  }
  document.querySelectorAll('input[name="tempo-scope"]').forEach((radio) => {
    radio.addEventListener("change", (e) => {
      _tempoScopeWithinGroup = e.target.value === "group";
      _tempoYRange = null;
      _redrawAllTempoCurves();
    });
  });
  const displayedOnlyCb = document.getElementById("tempo-scope-displayed");
  if (displayedOnlyCb) {
    displayedOnlyCb.addEventListener("change", (e) => {
      _tempoScopeDisplayedOnly = e.target.checked;
      _tempoYRange = null;
      _redrawAllTempoCurves();
    });
  }

  // Restore state from browser form restoration (controls may retain values
  // across page reloads but the JS variables default to initial values).
  if (tempoCheckbox?.checked) {
    _tempoCurveVisible = true;
    if (tempoOptions) tempoOptions.style.display = "";
  }
  const restoredMode = document.querySelector(
    'input[name="tempo-mode"]:checked',
  );
  if (restoredMode) _tempoCurveMode = restoredMode.value;
  const restoredScope = document.querySelector(
    'input[name="tempo-scope"]:checked',
  );
  if (restoredScope) _tempoScopeWithinGroup = restoredScope.value === "group";
  if (displayedOnlyCb) _tempoScopeDisplayedOnly = displayedOnlyCb.checked;
  if (tempoSmoothingSlider)
    _tempoCurveSmoothing = parseInt(tempoSmoothingSlider.value);
  _updateScopeVisibility();
  if (_tempoCurveVisible) _redrawAllTempoCurves();

  // Zoom slider
  const zoomSlider = document.getElementById("zoom-slider");
  if (zoomSlider) {
    zoomSlider.addEventListener("input", (e) => {
      applyZoom(ZOOM_LEVELS[parseInt(e.target.value)]);
    });
    // Restore zoom state from browser form restoration (slider may be non-zero)
    const restoredIdx = parseInt(zoomSlider.value);
    if (restoredIdx > 0) {
      const restoredLevel = ZOOM_LEVELS[restoredIdx] || 1;
      setCurrentZoomLevel(restoredLevel);
      const label = document.getElementById("zoom-label");
      if (label) label.textContent = restoredLevel + "x";
      const scrollControls = document.getElementById("scroll-mode-controls");
      if (scrollControls)
        scrollControls.style.display = restoredLevel > 1 ? "" : "none";
    }
  }

  // Mousewheel zoom when hovering over a waveform
  document.getElementById("waveforms").addEventListener(
    "wheel",
    (e) => {
      if (!e.ctrlKey && !e.metaKey) return; // plain scroll = normal scroll
      e.preventDefault();
      const currentIdx = ZOOM_LEVELS.indexOf(currentZoomLevel);
      const newIdx =
        e.deltaY < 0
          ? Math.min(currentIdx + 1, ZOOM_LEVELS.length - 1)
          : Math.max(currentIdx - 1, 0);
      if (newIdx === currentIdx) return;
      applyZoom(ZOOM_LEVELS[newIdx]);
      if (zoomSlider) zoomSlider.value = newIdx;
    },
    { passive: false },
  );

  // Scroll mode radios — sync variable from browser-restored state on load
  const scrollRadios = document.querySelectorAll('input[name="scroll-mode"]');
  scrollRadios.forEach((radio) => {
    if (radio.checked) setScrollMode(radio.value);
    radio.addEventListener("change", (e) => {
      setScrollMode(e.target.value);
      Object.keys(wavesurfers).forEach((fn) => applyScrollMode(fn));
    });
  });
  // Belt-and-suspenders: some browsers restore form state after DOMContentLoaded
  window.addEventListener("pageshow", () => {
    scrollRadios.forEach((radio) => {
      if (radio.checked && radio.value !== scrollMode) {
        setScrollMode(radio.value);
        Object.keys(wavesurfers).forEach((fn) => applyScrollMode(fn));
      }
    });
  });

  // Show the drawer-pull button stack
  document.querySelector(".drawer-btns").style.display = "flex";

  // Settings Drawer toggle + theme/i18n wiring
  _initSettingsDrawer();

  // Keep focus available for keyboard shortcuts after clicks on nav/sidebar controls.
  // Blur the focused element after mouseup unless the user clicked into a text input,
  // textarea, select, or an element inside a modal / the Solid drawer.
  document.addEventListener("mouseup", () => {
    const active = document.activeElement;
    if (!active || active === document.body) return;
    const tag = active.tagName;
    if (tag === "TEXTAREA" || tag === "SELECT") return;
    if (
      tag === "INPUT" &&
      active.type !== "checkbox" &&
      active.type !== "radio"
    )
      return;
    if (active.closest(".gm-modal, #settings-drawer, #file-picker-overlay, .lh-v6-drawer, .lh-v6-load-overlay, .lh-v6-confirm-overlay"))
      return;
    active.blur();
  });

  document.querySelector("body").addEventListener("keydown", (e) => {
    // Don't intercept when typing in an input/textarea
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
    // Don't intercept when a modal or the Solid drawer has focus
    if (
      e.target.closest &&
      e.target.closest(".gm-modal, #settings-drawer, #file-picker-overlay, .lh-v6-drawer, .lh-v6-load-overlay, .lh-v6-confirm-overlay")
    )
      return;
    // Fix mode owns the keyboard while open (its own document-level handler
    // drives audition/selection/approve/marks); every shortcut here would
    // act on the HIDDEN waveform pane. Ctrl+Z / Ctrl+Shift+Z live in their
    // own listener above and stay global — undo is unified by ruling.
    if (isFixModeActive()) return;
    console.log("KEYDOWN: ", e);
    if (!currentAudioIx) return;

    // --- Helper: get ordered list of visible (checked) waveform filenames ---
    function getVisibleWaveforms() {
      // Working set: stepping onto a deferred recording builds it (see
      // swapCurrentAudio), so skipping it here would make rows unreachable by
      // keyboard purely because they had not been scrolled to.
      return Array.from(document.querySelectorAll("#waveforms .waveform"))
        .map((el) => el.dataset.ix)
        .filter((name) => name in waveformViews);
    }

    let handled = true;

    switch (e.code) {
      case "ArrowUp": {
        // Switch to previous waveform (works in both modes)
        const visible = getVisibleWaveforms();
        const idx = visible.indexOf(currentAudioIx);
        if (idx > 0) swapCurrentAudio(visible[idx - 1]);
        break;
      }
      case "ArrowDown": {
        // Switch to next waveform (works in both modes)
        const visible = getVisibleWaveforms();
        const idx = visible.indexOf(currentAudioIx);
        if (idx < visible.length - 1) swapCurrentAudio(visible[idx + 1]);
        break;
      }
      case "ArrowLeft": {
        if (closeListeningMode && e.shiftKey && activeMarkerIx != null) {
          // Nudge active marker left by constant time: Shift+Alt = 20ms, Shift = 100ms
          const delta = e.altKey ? smallMarkerNudge : bigMarkerNudge;
          const currentTime = getCorrespondingTime(
            currentAudioIx,
            markers[activeMarkerIx],
          );
          const targetTime = currentTime - delta;
          if (targetTime >= 0) {
            const newIx = getClosestAlignmentIx(targetTime, currentAudioIx);
            // Only update if actually different from current position
            if (newIx !== markers[activeMarkerIx]) {
              const oldIx = markers[activeMarkerIx];
              markers[activeMarkerIx] = newIx;
              persistMarkers();
              _pushUndo(
                {
                  type: "marker-move",
                  markerArrayIx: activeMarkerIx,
                  oldAlignIx: oldIx,
                  newAlignIx: newIx,
                },
                true,
              );
              redrawAllMarkers();
              seekToActiveMarker();
            }
          }
        } else if (closeListeningMode && _jumpCloseListening(-1)) {
          // Jumped to the previous stop (marker or active-annotation region start).
        } else {
          // Normal mode: seek backwards
          // plain=10s, Shift=5s, Shift+Alt=1s
          const delta = e.shiftKey ? (e.altKey ? 1 : 5) : 10;
          const ws = wavesurfers[currentAudioIx];
          const dur = ws.getDuration();
          if (dur > 0) {
            const newTime = Math.max(0, ws.getCurrentTime() - delta);
            ws.seekTo(newTime / dur);
          }
        }
        break;
      }
      case "ArrowRight": {
        if (closeListeningMode && e.shiftKey && activeMarkerIx != null) {
          // Nudge active marker right by constant time: Shift+Alt = 20ms, Shift = 100ms
          const delta = e.altKey ? smallMarkerNudge : bigMarkerNudge;
          const currentTime = getCorrespondingTime(
            currentAudioIx,
            markers[activeMarkerIx],
          );
          const gridLength = alignmentGrids[currentAudioIx].length;
          const targetTime = currentTime + delta;
          const newIx = getClosestAlignmentIx(targetTime, currentAudioIx);
          // Only update if actually different and in bounds
          if (newIx !== markers[activeMarkerIx] && newIx < gridLength) {
            const oldIx = markers[activeMarkerIx];
            markers[activeMarkerIx] = newIx;
            persistMarkers();
            _pushUndo(
              {
                type: "marker-move",
                markerArrayIx: activeMarkerIx,
                oldAlignIx: oldIx,
                newAlignIx: newIx,
              },
              true,
            );
            redrawAllMarkers();
            seekToActiveMarker();
          }
        } else if (closeListeningMode && _jumpCloseListening(1)) {
          // Jumped to the next stop (marker or active-annotation region start).
        } else {
          // Normal mode: seek forwards
          // plain=10s, Shift=5s, Shift+Alt=1s
          const delta = e.shiftKey ? (e.altKey ? 1 : 5) : 10;
          const ws = wavesurfers[currentAudioIx];
          const dur = ws.getDuration();
          if (dur > 0) {
            const newTime = Math.min(dur, ws.getCurrentTime() + delta);
            ws.seekTo(newTime / dur);
          }
        }
        break;
      }
      case "AltLeft":
      case "AltRight": {
        // Show numbered overlays on visible waveforms; suppress browser Alt behaviour.
        // Do not activate when Shift is held (user may be nudging markers or seeking).
        if (!e.repeat && !e.shiftKey && !_jumpToTargetActive) {
          _jumpToTargetActive = true;
          _showAltNumbers();
        }
        break;
      }
      case "Digit1":
      case "Digit2":
      case "Digit3":
      case "Digit4":
      case "Digit5":
      case "Digit6":
      case "Digit7":
      case "Digit8":
      case "Digit9":
      case "Digit0":
      case "Numpad1":
      case "Numpad2":
      case "Numpad3":
      case "Numpad4":
      case "Numpad5":
      case "Numpad6":
      case "Numpad7":
      case "Numpad8":
      case "Numpad9":
      case "Numpad0": {
        // Jump-to-target mode (Alt held): jump to nth badged on-screen waveform.
        // Normal mode: jump to nth waveform in the full list (first 10, regardless of scroll).
        if (_jumpToTargetActive) {
          const digit = e.code.replace(/^(Digit|Numpad)/, "");
          const n = digit === "0" ? 9 : parseInt(digit) - 1;
          if (n < _jumpToTargetWaveforms.length) {
            swapCurrentAudio(_jumpToTargetWaveforms[n].dataset.ix);
            if (!wavesurfers[currentAudioIx].isPlaying()) {
              wavesurfers[currentAudioIx].play();
            }
          }
        } else {
          const digit = e.code.replace(/^(Digit|Numpad)/, "");
          const n = digit === "0" ? 9 : parseInt(digit) - 1;
          const allWaveforms = getVisibleWaveforms();
          if (n < allWaveforms.length) {
            swapCurrentAudio(allWaveforms[n]);
            if (!wavesurfers[currentAudioIx].isPlaying()) {
              wavesurfers[currentAudioIx].play();
            }
          }
        }
        break;
      }
      case "KeyM": {
        // Add marker at current playback position
        const toMark = getClosestAlignmentIx();
        const arrIx = markers.length;
        markers.push(toMark);
        persistMarkers();
        _pushUndo(
          { type: "marker-add", alignIx: toMark, markerArrayIx: arrIx },
          true,
        );
        if (closeListeningMode) {
          // Make the newly added marker active
          setActiveMarkerIx(markers.length - 1);
          redrawAllMarkers();
          seekToActiveMarker();
        } else {
          Object.keys(wavesurfers).forEach((ws) => {
            const t = getCorrespondingTime(ws, toMark);
            addMarker(ws, { time: t, color: "red", alignIx: toMark });
          });
        }
        break;
      }
      case "Delete":
      case "Backspace": {
        _deleteActiveMarker();
        break;
      }
      case "KeyC": {
        // Toggle close-listening mode
        if (closeListeningMode) {
          exitCloseListeningMode();
        } else {
          // Enter with the closest jump target (marker or active-annotation
          // region start) at/before the current playback position.
          enterCloseListeningMode(null);
        }
        break;
      }
      case "Escape": {
        if (closeListeningMode) {
          exitCloseListeningMode();
        }
        break;
      }
      case "Space":
        playpause();
        break;
      default:
        handled = false;
    }

    if (handled) e.preventDefault();
  });

  // Alt keyup: exit alt mode and clear number badges
  document.querySelector("body").addEventListener("keyup", (e) => {
    if (
      (e.code === "AltLeft" || e.code === "AltRight") &&
      _jumpToTargetActive
    ) {
      _jumpToTargetActive = false;
      _hideAltNumbers();
    }
  });

  // Time measurement (Shift-hold durations, Shift+drag spans) lives in
  // ./engine/measure.js. Align-correction mode claims Shift for its influence
  // zone, so that conflict is injected rather than imported over there.
  initMeasureInteractions({ isSuppressed: () => _alignCorrectionMode });
});

/**
 * Push every annotation's regions onto every waveform via the V6 module,
 * then refresh the off-screen region nav arrows.
 */
export function updateRenderAnnoRegions() {
  maybeSyncV6Regions();
  updateAllRegionNavArrows();
}

// --- File picker logic for ?useFiles mode ---

// Expected audio keys from the alignment JSON (set during setGrids)
let expectedAudioKeys = [];
let alignmentLoadedFromFile = false; // true when JSON was loaded via file picker

function extractFilename(key) {
  // Extract just the filename from an alignment key (which may be a path or URL)
  return key.split("/").pop();
}

function processPickedJsonFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      // Yield one browser frame before the (potentially long) synchronous
      // JSON.parse so any pending UI updates (e.g. "Reading…" indicator)
      // get a chance to paint.
      setTimeout(() => {
        try {
          resolve(JSON.parse(reader.result));
        } catch (e) {
          reject(new Error("Invalid JSON: " + e.message));
        }
      }, 0);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

function initFilePicker() {
  const overlay = document.getElementById("file-picker-overlay");
  const listEl = document.getElementById("file-picker-list");
  const progressEl = document.getElementById("file-picker-progress");
  const continueBtn = document.getElementById("file-picker-continue");
  const dirBtn = document.getElementById("file-picker-dir-btn");
  const filesBtn = document.getElementById("file-picker-files-btn");
  const fileInput = document.getElementById("file-picker-input");
  const dropZone = document.getElementById("file-picker-card");
  const jsonStatusEl = document.getElementById("file-picker-json-status");

  // --- Tab switching ---
  document.querySelectorAll("#fp-tabs .fp-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document
        .querySelectorAll("#fp-tabs .fp-tab")
        .forEach((t) => t.classList.remove("active"));
      document
        .querySelectorAll(".fp-tab-pane")
        .forEach((p) => p.classList.remove("active"));
      tab.classList.add("active");
      const pane = document.getElementById(tab.dataset.tab);
      if (pane) pane.classList.add("active");
    });
  });

  // Show directory picker button on browsers that support it (Chromium)
  if (typeof window.showDirectoryPicker === "function") {
    dirBtn.style.display = "";
  }

  function updateJsonStatus() {
    if (!jsonStatusEl) return;
    const loaded = expectedAudioKeys.length > 0;
    if (loaded) {
      const name = alignmentLoadedFromFile ? "local file" : "URL";
      jsonStatusEl.innerHTML = `<span class="json-status-ok">&#10003; Alignment JSON loaded (${expectedAudioKeys.length} audio entries, from ${name})</span>`;
    } else {
      jsonStatusEl.innerHTML = `<span class="json-status-missing">No alignment JSON loaded yet \u2014 include a .json file</span>`;
    }
    const modeSwitch = document.getElementById("fp-mode-switch");
    if (modeSwitch) modeSwitch.classList.toggle("is-hidden", loaded);
  }

  // Populate expected file list
  function renderFileList() {
    listEl.innerHTML = "";
    if (expectedAudioKeys.length === 0) {
      progressEl.textContent = "";
      continueBtn.style.display = "none";
      updateJsonStatus();
      return;
    }
    let matched = 0;
    expectedAudioKeys.forEach((key) => {
      const name = extractFilename(key);
      const li = document.createElement("li");
      const isMatched = fileBlobUrls.has(key);
      li.className = isMatched ? "matched" : "missing";
      const icon = document.createElement("span");
      icon.className = "status-icon";
      const fname = document.createElement("span");
      fname.className = "filename";
      fname.textContent = name;
      li.append(icon, fname);
      listEl.appendChild(li);
      if (isMatched) matched++;
    });
    progressEl.textContent = `${matched} of ${expectedAudioKeys.length} files matched`;
    if (matched > 0) {
      continueBtn.style.display = "";
      continueBtn.textContent =
        matched === expectedAudioKeys.length
          ? "Continue"
          : `Continue with ${matched} of ${expectedAudioKeys.length}`;
    } else {
      continueBtn.style.display = "none";
    }
    updateJsonStatus();
  }

  async function handleFiles(files) {
    // Separate JSON from audio files
    const jsonFiles = [];
    const audioFiles = [];
    for (const f of files) {
      if (f.name.toLowerCase().endsWith(".json")) {
        jsonFiles.push(f);
      } else {
        audioFiles.push(f);
      }
    }
    // Process the first JSON file found (if any)
    if (jsonFiles.length > 0) {
      // Give immediate feedback so the user knows their pick registered
      // (large files can take several seconds to read + parse).
      if (jsonStatusEl) {
        // Filename is user-picked but still safer via textContent on a span
        // built up DOM-side than interpolated into innerHTML.
        jsonStatusEl.replaceChildren(
          Object.assign(document.createElement("span"), {
            className: "json-status-pending",
            textContent: "⏳ Reading " + jsonFiles[0].name + "…",
          }),
        );
      }
      try {
        const data = await processPickedJsonFile(jsonFiles[0]);
        // Validate basic structure
        if (data.body && data.body.audio && data.header && data.header.ref) {
          // Ask BEFORE touching any state: accepting a JSON here clears the
          // loaded piece's blobs and rebinds loadedAlignmentJSON, so a "Keep
          // current" answer at Continue-time would leave the app and this
          // dialog describing different pieces (#32 follow-up).
          const assessment = _assessIncomingPiece(data);
          if (assessment.different) {
            if (!(await _confirmReplacePiece(assessment))) {
              if (jsonStatusEl) {
                jsonStatusEl.replaceChildren(
                  Object.assign(document.createElement("span"), {
                    className: "json-status-missing",
                    textContent:
                      "Kept the loaded piece — " +
                      jsonFiles[0].name +
                      " was not applied.",
                  }),
                );
              }
              return; // nothing picked in this batch is applied
            }
            _approvedReplacement = data;
          }
          alignmentLoadedFromFile = true;
          // Start a fresh matching slate for the newly picked alignment.
          // retireFileBlobs (not .clear()) so the outgoing URLs keep a handle
          // and can be revoked once nothing renders them.
          session.retireFileBlobs();
          seekAnalysis.clear();
          expectedAudioKeys = Object.keys(data.body.audio).filter(
            (k) => k !== SYNTH_MEI_KEY,
          );
          // Store the alignment data for use when continue is clicked
          window._pendingLocalAlignment = data;
          // Set workId from the JSON filename
          workId = jsonFiles[0].name;
          // Temporarily set loadedAlignmentJSON so LD URI section can read header
          setLoadedAlignmentJSON(data);
          renderFileList();
          populateLdUriSection();
        } else {
          alert(
            "The JSON file does not appear to be a valid alignment file.\nExpected: {header: {ref: ...}, body: {audio: {...}}}",
          );
        }
      } catch (e) {
        alert("Error reading JSON file: " + e.message);
      }
    }
    // Match audio files
    matchFiles(audioFiles);
  }

  function matchFiles(files) {
    // Build a map of lowercase filename -> File for quick lookup
    const filesByName = new Map();
    for (const f of files) {
      filesByName.set(f.name.toLowerCase(), f);
    }
    // Match against expected audio keys
    for (const key of expectedAudioKeys) {
      if (fileBlobUrls.has(key)) continue; // already matched
      const expectedName = extractFilename(key).toLowerCase();
      if (filesByName.has(expectedName)) {
        const file = filesByName.get(expectedName);
        fileBlobUrls.set(key, URL.createObjectURL(file));
        fileBlobs.set(key, file);
      }
    }
    renderFileList();
  }

  // Directory picker (Chromium only)
  dirBtn.addEventListener("click", async () => {
    try {
      const dirHandle = await window.showDirectoryPicker();
      const files = [];
      for await (const entry of dirHandle.values()) {
        if (entry.kind === "file") {
          files.push(await entry.getFile());
        }
      }
      handleFiles(files);
    } catch (e) {
      if (e.name !== "AbortError") console.warn("Directory picker error:", e);
    }
  });

  // File input (universal fallback)
  filesBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    // Defer by one task to work around a Firefox quirk where .files may not
    // be fully populated yet when the change event fires on the first
    // programmatic .click() of a display:none input.
    setTimeout(() => {
      const files = Array.from(fileInput.files);
      fileInput.value = ""; // reset so the same file can be re-picked
      if (files.length) {
        handleFiles(files);
      }
    }, 0);
  });

  // Drag and drop
  dropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropZone.classList.add("drag-over");
  });
  dropZone.addEventListener("dragleave", () => {
    dropZone.classList.remove("drag-over");
  });
  dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropZone.classList.remove("drag-over");
    if (e.dataTransfer.files.length) {
      handleFiles(Array.from(e.dataTransfer.files));
    }
  });

  // Continue button — persist LD config and close. The V6 publish bar
  // re-reads its enable conditions on each render, so we don't need to
  // imperatively refresh it after LD URI edits.
  function closeOverlay() {
    if (populateLdUriSection._persist) populateLdUriSection._persist();
    overlay.style.display = "none";
    // If alignment was loaded from a local JSON file, apply it now
    if (window._pendingLocalAlignment) {
      const data = window._pendingLocalAlignment;
      window._pendingLocalAlignment = null;
      setGrids(data);
    }
  }

  continueBtn.addEventListener("click", closeOverlay);

  // Close on backdrop click (clicking the overlay outside the card)
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeOverlay();
  });

  // Close on Escape key
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && overlay.style.display !== "none") {
      closeOverlay();
    }
  });

  renderFileList();
  if (_fromAlignmentHandoff) {
    _fromAlignmentHandoff = false;
  } else {
    overlay.style.display = "flex";
  }
}

// --- Linked Data URI management in file picker ---
function populateLdUriSection() {
  const section = document.getElementById("ld-uri-section");
  const emptyHint = document.getElementById("ld-uri-empty-hint");
  const tbody = document.getElementById("ld-uri-tbody");
  const prefixInput = document.getElementById("ld-uri-prefix");
  if (!section || !tbody || !prefixInput) return;

  // Enable / disable the LD URI tab based on whether audio keys exist
  const uriTab = document.querySelector('.fp-tab[data-tab="fp-tab-uris"]');
  const hasKeys =
    expectedAudioKeys.length > 0 || Object.keys(alignmentGrids).length > 0;
  if (uriTab) {
    uriTab.classList.toggle("disabled", !hasKeys);
  }
  if (!hasKeys) {
    section.style.display = "none";
    if (emptyHint) emptyHint.style.display = "";
    return;
  }
  section.style.display = "";
  if (emptyHint) emptyHint.style.display = "none";

  const keys =
    expectedAudioKeys.length > 0
      ? expectedAudioKeys
      : Object.keys(alignmentGrids).filter((n) => n !== SYNTH_MEI_KEY);

  // Ensure header and linkedDataUris exist as live references
  if (loadedAlignmentJSON && !loadedAlignmentJSON.header)
    loadedAlignmentJSON.header = {};
  const header = loadedAlignmentJSON?.header || {};
  prefixInput.value = header.linkedDataUriPrefix || "";
  // Work on a local copy; persisted only when the modal is closed
  const perFileConfig = JSON.parse(JSON.stringify(header.linkedDataUris || {}));

  function resolveUri(key) {
    const perFile = perFileConfig[key];
    if (perFile?.uri) return perFile.uri;
    const filePrefix = perFile?.prefix?.trim();
    const prefix = filePrefix || prefixInput.value.trim();
    const name = perFile?.ldFilename || encodeURIComponent(key);
    if (prefix) return prefix.replace(/\/$/, "") + "/" + name;
    return name;
  }

  function renderTable() {
    tbody.innerHTML = "";
    for (const key of keys) {
      const tr = document.createElement("tr");

      // Column 1: original filename
      const tdFile = document.createElement("td");
      const shortName = key.substring(key.lastIndexOf("/") + 1);
      tdFile.textContent = shortName;
      tdFile.title = key;
      tr.appendChild(tdFile);

      // Column 2: LD filename (prepopulated with actual filename)
      const tdLdName = document.createElement("td");
      const ldNameInput = document.createElement("input");
      ldNameInput.type = "text";
      ldNameInput.spellcheck = false;
      ldNameInput.dataset.key = key;
      ldNameInput.className = "ld-filename-input";
      ldNameInput.value =
        perFileConfig[key]?.ldFilename || encodeURIComponent(key);
      ldNameInput.addEventListener("input", () => {
        const val = ldNameInput.value.trim();
        if (!perFileConfig[key]) perFileConfig[key] = {};
        if (val && val !== encodeURIComponent(key)) {
          perFileConfig[key].ldFilename = val;
        } else {
          delete perFileConfig[key].ldFilename;
          if (Object.keys(perFileConfig[key]).length === 0)
            delete perFileConfig[key];
        }
        updateResolvedCell(tr, key);
      });
      tdLdName.appendChild(ldNameInput);
      tr.appendChild(tdLdName);

      // Column 3: per-file prefix override (optional)
      const tdPrefix = document.createElement("td");
      const prefOverride = document.createElement("input");
      prefOverride.type = "text";
      prefOverride.spellcheck = false;
      prefOverride.className = "ld-prefix-input";
      prefOverride.placeholder = "(global)";
      prefOverride.value = perFileConfig[key]?.prefix || "";
      prefOverride.addEventListener("input", () => {
        const val = prefOverride.value.trim();
        if (!perFileConfig[key]) perFileConfig[key] = {};
        if (val) {
          perFileConfig[key].prefix = val;
        } else {
          delete perFileConfig[key].prefix;
          if (Object.keys(perFileConfig[key]).length === 0)
            delete perFileConfig[key];
        }
        updateResolvedCell(tr, key);
      });
      tdPrefix.appendChild(prefOverride);
      tr.appendChild(tdPrefix);

      // Column 4: resolved URI (read-only preview)
      const tdResolved = document.createElement("td");
      tdResolved.className = "ld-resolved-uri";
      tr.appendChild(tdResolved);

      tbody.appendChild(tr);
      updateResolvedCell(tr, key);
    }
  }

  function updateResolvedCell(tr, key) {
    const td = tr.querySelector(".ld-resolved-uri");
    if (td) td.textContent = resolveUri(key);
  }

  function updateAllResolved() {
    for (const tr of tbody.querySelectorAll("tr")) {
      const key = tr.querySelector(".ld-filename-input")?.dataset.key;
      if (key) updateResolvedCell(tr, key);
    }
  }

  prefixInput.addEventListener("input", updateAllResolved);

  // Persist local config to loadedAlignmentJSON.header (called on modal close)
  function persistLdConfig() {
    if (!loadedAlignmentJSON) return;
    if (!loadedAlignmentJSON.header) loadedAlignmentJSON.header = {};
    const prefix = prefixInput.value.trim();
    if (prefix) {
      loadedAlignmentJSON.header.linkedDataUriPrefix = prefix;
    } else {
      delete loadedAlignmentJSON.header.linkedDataUriPrefix;
    }
    // Clean empty entries and persist
    const clean = {};
    for (const key of Object.keys(perFileConfig)) {
      if (perFileConfig[key] && Object.keys(perFileConfig[key]).length > 0) {
        clean[key] = { ...perFileConfig[key] };
      }
    }
    if (Object.keys(clean).length > 0) {
      loadedAlignmentJSON.header.linkedDataUris = clean;
    } else {
      delete loadedAlignmentJSON.header.linkedDataUris;
    }
  }

  // Expose so the modal-close handler can call it
  populateLdUriSection._persist = persistLdConfig;

  renderTable();
}

function showFilePickerIfNeeded() {
  if (
    useFilesMode ||
    params.get("useFiles") !== null ||
    alignmentData === "local"
  ) {
    useFilesMode = true;
    // If we already have alignment grids (from URL), populate expected keys
    if (
      Object.keys(alignmentGrids).length > 0 &&
      expectedAudioKeys.length === 0
    ) {
      expectedAudioKeys = Object.keys(alignmentGrids).filter(
        (k) => k !== SYNTH_MEI_KEY,
      );
    }
    // Show the "Manage recordings" button and wire it to reopen the overlay
    const manageBtn = document.getElementById("manage-files-btn");
    if (manageBtn && !manageBtn._wired) {
      manageBtn._wired = true;
      manageBtn.addEventListener("click", () => {
        document.getElementById("file-picker-overlay").style.display = "flex";
        populateLdUriSection();
      });
    }
    // Show download button (useful once alignment is loaded from file)
    const dlBtn = document.getElementById("download-json-btn");
    if (dlBtn && alignmentData === "local") dlBtn.style.display = "";
    if (!showFilePickerIfNeeded._initialized) {
      showFilePickerIfNeeded._initialized = true;
      initFilePicker();
      populateLdUriSection();
    }
  }
}

// --- Global drag-and-drop for JSON replacement ---
// Dragging a JSON file anywhere on the page auto-opens the Load Files modal,
// which handles the drop itself. This keeps JSON loading constrained to the modal.
function initGlobalJsonDrop() {
  function _hasJsonItem(dataTransfer) {
    if (!dataTransfer || !dataTransfer.items) return false;
    return Array.from(dataTransfer.items).some(
      (item) =>
        item.kind === "file" &&
        (item.type === "application/json" || item.type === "text/json"),
    );
  }

  document.addEventListener("dragenter", (e) => {
    const overlay = document.getElementById("file-picker-overlay");
    if (!overlay || overlay.style.display === "flex") return; // already open
    if (_hasJsonItem(e.dataTransfer)) {
      // Auto-open the modal so the user can drop the JSON into it.
      // Ensure local-file mode is active so the file picker initialises.
      useFilesMode = true;
      if (!showFilePickerIfNeeded._initialized) {
        showFilePickerIfNeeded(); // initialises file picker, which opens the overlay
      } else {
        overlay.style.display = "flex";
      }
    }
  });

  // Allow dragover so the browser doesn't cancel the drag session before
  // the user reaches the modal card.
  document.addEventListener("dragover", (e) => {
    if (_hasJsonItem(e.dataTransfer)) {
      e.preventDefault();
    }
  });
}

// Initialize global JSON drop handler
initGlobalJsonDrop();

// Expose internals for E2E testing (Playwright)
window._listenTest = {
  get wavesurfers() { return wavesurfers; },
  get currentAudioIx() { return currentAudioIx; },
  get alignmentGrids() { return alignmentGrids; },
  get loaded() { return [...loaded]; },
  get markers() { return [...markers]; },
  /** The DataSession itself — state ownership is migrating into it (item 13). */
  get session() { return session; },
  /** header.ref of the loaded alignment — cheap identity check for tests. */
  get alignmentHeaderRef() { return loadedAlignmentJSON?.header?.ref ?? null; },
  /** What the file picker currently expects; must track the loaded piece. */
  get expectedAudioKeys() { return [...expectedAudioKeys]; },
  /** The saved grouping tabs, post-migration and post-overlap-repair (item U). */
  get groupingTabs() { return loadedAlignmentJSON?.header?.groupingTabs ?? null; },
  /** Resolved single-valued membership for the active tab — what an annotation pins. */
  get activeGroupingSnapshot() { return getActiveGroupingSnapshot(); },
  /** Object URLs awaiting revocation — should drain to 0 once renderers die. */
  get retiredBlobUrlCount() { return session.retiredBlobUrls.length; },
  /** Increments once per completed load; lets tests await a load instead of sleeping. */
  get loadGeneration() { return _loadGeneration; },
  /** Live picked-file object URLs, so a test can check they get revoked. */
  get fileBlobUrlValues() { return [...session.fileBlobUrls.values()]; },
  /** Every recording with a row in the pane, renderer or not (the working set). */
  get waveformWorkingSet() { return Object.keys(waveformViews); },
  /** The subset of those whose overlay canvases exist, i.e. actually drawn. */
  get renderedWaveforms() { return Object.keys(waveformViews).filter(isWaveformRendered); },
  /** Rows in the pane still waiting on the viewport (roadmap item L). */
  get deferredWaveforms() { return [..._deferred]; },
  /** Whether the loaded piece is big enough to defer off-screen waveforms. */
  get lazyWaveformsActive() { return _lazyWaveforms; },
  /** Deferred waveforms queued or mid-build; 0 means the build queue has settled. */
  get materializePending() { return _materializeQueue.length + _materializing.size; },
  /** Fix-mode (alignment correction) state; {active:false, lastRefusal} when closed. */
  get fix() { return fixTestState(); },
  /** Fix-mode audition controls + stereo-buffer probe (tests only). */
  fixCtl: fixTestControl,
  /** Activate a recording, building it first if it was deferred. */
  swapCurrentAudio(filename) { swapCurrentAudio(filename); },
  /**
   * Inject a synthetic region directly onto each named waveform's regions
   * plugin. Bypasses V6 state (which is the intended path in production)
   * because these tests only verify the off-screen nav-arrow behaviour,
   * which reads region times from the plugin regardless of source.
   */
  injectTestRegion(overridesByWaveform, selection = "test-region") {
    Object.keys(overridesByWaveform).forEach((filename) => {
      const plugin = waveformViews[filename]?.regions;
      if (!plugin) return;
      const { start, end } = overridesByWaveform[filename];
      plugin.addRegion({
        id: `test_${selection}_${filename}_${Date.now()}`,
        start,
        end,
        color: "rgba(200, 130, 80, 0.3)",
        drag: false,
        resize: false,
      });
    });
    updateRenderAnnoRegions();
  },
  clearTestRegions() {
    regionsPluginEntries().forEach(([, plugin]) => {
      plugin
        .getRegions()
        .filter((r) => r.id.startsWith("test_"))
        .forEach((r) => r.remove());
    });
    updateRenderAnnoRegions();
  },
};
