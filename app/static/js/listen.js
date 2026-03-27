// Re-export globals set by the template's inline <script>
export let versionString = window.versionString;
export let versionDate = window.versionDate;

import { initSolidAuth } from "./solid.js";
import {
  toggleStagedSelection,
  toggleDraftStagedSelection,
  getDraftRegionsForWaveform,
  onDraftRegionCreated,
  onDraftRegionUpdated,
  continueAnnotationLoopOnWaveform,
  prepareAnnotationLoopTransfer,
  initNewAnnotationButton,
  onSolidAuthChanged,
  getLiveColor,
} from "./annotation.js";
import WaveSurfer from "../vendor/wavesurfer.esm.js";
import RegionsPlugin from "../vendor/wavesurfer-regions.esm.js";
import HoverPlugin from "../vendor/wavesurfer-hover.esm.js";
import {
  initAlignPanel,
  configure as configureAlign,
  setVerovioPromise,
} from "./align.js";

let markers = [];
let loaded = new Set();
let alignmentGrids = {};
let scoreAlignment; // score tstamp to ref tstamp maps for onset and offset
let timemap = []; // verovio timemap
let mei = null; // MEI XML
let meiDOM = null; // MEI DOM
let parser = new DOMParser(); // XML parser for MEI
let ref;
export let currentAudioIx = "";
export let currentlyAnnotatedRegions = []; // alignment indexes of start and end for each active annotated region
export let maoSelections = [];
let referenceAudioIx;
let colorMap;
let timerFrom = 0;
let timerTo = 0;
let tk; // verovio toolkit

// seconds by which to nudge markers when arrow keys pressed in close-listening mode
const smallMarkerNudge = 0.02;
const bigMarkerNudge = 0.1;

export let storage;
export let meiUri;
export let currentlyActiveMaoSelection = "";
export let wavesurfers = {};
export const _regionsPlugins = {}; // filename -> RegionsPlugin instance
const _timerRegions = {}; // filename -> timer Region object
const _waveformPeaks = {}; // filename -> { peaks: number[], duration: number } when pre-computed

// Audio normalization via Web Audio GainNode
let _normAudioCtx = null; // lazy AudioContext shared across all waveforms
const _normGainNodes = {}; // filename -> GainNode
const _normSourceNodes = {}; // filename -> MediaElementAudioSourceNode
const _normPeaks = {}; // filename -> peak amplitude (0..1)

/** Return the pre-computed peak data for a filename, or null if unavailable. */
export function getWaveformPeaks(filename) {
  const p = _waveformPeaks[filename];
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
let fileBlobUrls = new Map();
let fileBlobs = new Map(); // alignment audio keys -> File/Blob objects
let useFilesMode = false;
let _fromAlignmentHandoff = false;

// Synthesised MEI waveform: key used in wavesurfers / alignmentGrids for the synth track
const SYNTH_MEI_KEY = "Score (synthesised from MEI)";
// Maps SYNTH_MEI_KEY -> blob URL once synthesis is done, or the sentinel '__pending__'
const _synthBlobUrls = new Map();

// HTTP Basic Auth: scoped per-origin to avoid leaking credentials
// Maps origin string -> fetchParams objects: { headers: { Authorization: 'Basic ...' } }
let authByOrigin = new Map();
let authPromptedOrigins = new Set();

// Close-listening mode state
let closeListeningMode = false;

// jumpToTarget mode: show numbered overlays on on-screen waveforms
let _jumpToTargetActive = false;
let _jumpToTargetWaveforms = []; // snapshot of badged waveforms for the current session
let activeMarkerIx = null; // index into markers[] array

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
  storage = window.localStorage;
} catch (err) {
  console.warn("unable to access local storage: ", err);
}

function resolveAudioUrl(filename) {
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

// --- Marker redraw helper ---
// Redraws all markers on all wavesurfers, highlighting the active marker in close-listening mode
function redrawAllMarkers() {
  Object.keys(wavesurfers).forEach((ws) => {
    _clearMarkers(ws);
    _ensureWfLabel(ws);
    markers.forEach((m, i) => {
      const t = getCorrespondingTime(ws, m);
      const color =
        closeListeningMode && activeMarkerIx === i ? "#8b0000" : "red";
      _addMarker(ws, { time: t, color, alignIx: m });
    });
  });
  // Re-apply draggable visual class after DOM recreation
  _updateMarkerDraggableClass();
}

// --- Resize handling ---

let _resizeDebounce = null;

// Per-waveform closures that repaint the position indicator on every canvas.
// Registered in each waveform's "ready" handler.
const _positionUpdaters = {};
// Per-waveform closures that redraw the alignment grid canvas.
const _gridRedrawers = {};

// ---------------------------------------------------------------------------
// Zoom state
// ---------------------------------------------------------------------------
const ZOOM_LEVELS = [1, 2, 5, 10, 20, 50];
let _currentZoomLevel = 1; // multiplier (1 = no zoom)
let _scrollMode = "page"; // "follow" | "page" | "manual"
let _scrollSyncLock = false; // prevents infinite loop in cross-waveform scroll sync
let _sharedTimeAxis = false; // when true, all waveforms use same px/sec
const _overlayWrappers = {}; // filename → { wrapper, inner }
const _wfBgCache = {}; // filename → cached tick background colour string

// ---------------------------------------------------------------------------
// Tempo curve state
// ---------------------------------------------------------------------------
let _tempoCurveVisible = false;
let _tempoCurveMode = "absolute"; // "absolute" | "relative"
let _tempoCurveSmoothing = 0; // 0–10 window size for Gaussian smoothing
let _tempoScopeWithinGroup = false; // true = within group, false = across groups
let _tempoScopeDisplayedOnly = false; // true = restrict to displayed files
const _tempoRawCache = {}; // filename → [{time, tempo}] (unsmoothed)
const _tempoCurveRedrawers = {}; // filename → redraw function
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
    synthTimes = scoreAlignment.synth_onset || null;
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
  let files = Object.keys(wavesurfers).filter(
    (fn) =>
      fn !== SYNTH_MEI_KEY && alignmentGrids[fn] && alignmentGrids[fn].length,
  );

  if (_tempoScopeWithinGroup) {
    // Restrict to files in the same group as forFilename
    const groups = _getActiveFileGroups();
    const grouped = new Set();
    let myGroupFiles = null;
    for (const g of groups) {
      const members = new Set(g.files || []);
      if (g.pattern) {
        try {
          const re = new RegExp(g.pattern);
          files.forEach((f) => {
            const short = f.substring(f.lastIndexOf("/") + 1);
            if (re.test(short) || re.test(f)) members.add(f);
          });
        } catch (_) {}
      }
      members.forEach((f) => grouped.add(f));
      if (members.has(forFilename)) {
        myGroupFiles = files.filter((fn) => members.has(fn));
      }
    }
    if (myGroupFiles) {
      files = myGroupFiles;
    } else {
      // forFilename is ungrouped — use all ungrouped files as the group
      files = files.filter((fn) => !grouped.has(fn));
    }
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
  const allFiles = Object.keys(wavesurfers).filter(
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

/** Recompute the effective background colour for a waveform's tick labels. */
function _refreshWfBg(filename) {
  const wfEl = document.querySelector(
    `.waveform[data-ix='${CSS.escape(filename)}']`,
  );
  let bg = "rgba(255, 255, 255, 0.85)";
  for (let el = wfEl; el && el !== document.body; el = el.parentElement) {
    const raw = getComputedStyle(el).backgroundColor;
    if (raw && raw !== "rgba(0, 0, 0, 0)" && raw !== "transparent") {
      const m = raw.match(/[\d.]+/g);
      if (m && m.length >= 3) bg = `rgba(${m[0]}, ${m[1]}, ${m[2]}, 0.85)`;
      break;
    }
  }
  _wfBgCache[filename] = bg;
  // Also sync the wf-label
  const lbl =
    wfEl &&
    (
      (_overlayWrappers[filename] && _overlayWrappers[filename].wrapper) ||
      wfEl
    ).querySelector(".wf-label");
  if (lbl) lbl.style.backgroundColor = bg;
  return bg;
}

/** Toggle play/pause icons in the transport bar. */
function _updateTransportIcons(playing) {
  const pp = document.getElementById("playpause");
  if (!pp) return;
  const iconPlay = pp.querySelector(".icon-play");
  const iconPause = pp.querySelector(".icon-pause");
  if (iconPlay) iconPlay.style.display = playing ? "none" : "";
  if (iconPause) iconPause.style.display = playing ? "" : "none";
}

// ---------------------------------------------------------------------------
// Time-axis tick marks
// ---------------------------------------------------------------------------

const _NICE_INTERVALS = [
  0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200, 3600,
];

/** Format seconds for tick labels. */
function _formatTickTime(t) {
  if (t < 60) {
    // Show sub-second decimals only for small intervals
    return t % 1 === 0 ? String(t) : t.toFixed(1);
  }
  const m = Math.floor(t / 60);
  const s = Math.round(t % 60);
  return m + ":" + String(s).padStart(2, "0");
}

/**
 * Draw subtle time ticks at the top edge of a waveform overlay canvas.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} viewW  visible viewport width in px
 * @param {number} h      canvas height
 * @param {number} fullW  full zoomed width of the waveform in px
 * @param {number} dur    duration in seconds
 * @param {number} scrollLeft  current scroll offset in px
 */
function _drawTimeTicks(ctx, viewW, h, fullW, dur, scrollLeft, bgColor) {
  if (dur <= 0 || fullW <= 0) return;
  const pxPerSec = fullW / dur;
  const visibleSec = viewW / pxPerSec;

  // Choose a "nice" interval so we get roughly 60 ticks in the viewport
  const rawInterval = visibleSec / 60;
  const interval =
    _NICE_INTERVALS.find((n) => n >= rawInterval) ||
    _NICE_INTERVALS[_NICE_INTERVALS.length - 1];

  // Label every 2nd tick
  const labelEvery = 2;

  const startTime = (scrollLeft / fullW) * dur;
  const endTime = ((scrollLeft + viewW) / fullW) * dur;
  const firstTick = Math.ceil(startTime / interval) * interval;

  ctx.save();
  ctx.lineWidth = 1;

  for (let t = firstTick; t <= endTime + interval * 0.01; t += interval) {
    const x = Math.round((t / dur) * fullW - scrollLeft) + 0.5;
    if (x < -1 || x > viewW + 1) continue;

    // Label every 2nd tick
    const tickIndex = Math.round(t / interval);
    const isLabelled = tickIndex % labelEvery === 0;
    const tickH = isLabelled ? 7 : 4;

    ctx.strokeStyle = isLabelled
      ? "rgba(80, 80, 80, 0.5)"
      : "rgba(120, 120, 120, 0.3)";
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, tickH);
    ctx.stroke();

    if (isLabelled) {
      ctx.font = "9px sans-serif";
      ctx.textAlign = "center";
      const text = _formatTickTime(t);
      const tw = ctx.measureText(text).width;
      const pad = 1;
      ctx.fillStyle = bgColor || "rgba(255, 255, 255, 0.7)";
      ctx.fillRect(x - tw / 2 - pad, tickH, tw + pad * 2, 10);
      ctx.fillStyle = "rgba(60, 60, 60, 0.7)";
      ctx.fillText(text, x, tickH + 9);
    }
  }
  ctx.restore();
}

/** Get the shadow-DOM scroll container for a WaveSurfer instance. */
function _getScrollContainer(filename) {
  const ws = wavesurfers[filename];
  if (!ws) return null;
  // ws.getWrapper() returns the .wrapper div; its parent is the .scroll div
  return ws.getWrapper().parentElement;
}

/** Get the full rendered width of the waveform (accounts for zoom). */
function _getZoomedWidth(filename) {
  const ws = wavesurfers[filename];
  if (!ws) return 0;
  if (_currentZoomLevel <= 1) {
    const wfEl = document.querySelector(`.waveform[data-ix='${filename}']`);
    return wfEl ? wfEl.clientWidth : 0;
  }
  const wrapper = ws.getWrapper();
  return wrapper ? wrapper.clientWidth : 0;
}

/** Create the overlay wrapper structure for a waveform. */
function _createOverlayWrapper(wfEl, height) {
  const wrapper = document.createElement("div");
  wrapper.className = "wf-overlays";
  wrapper.style.height = height + "px";

  const inner = document.createElement("div");
  inner.className = "wf-overlays-inner";
  wrapper.appendChild(inner);

  wfEl.appendChild(wrapper);
  return { wrapper, inner };
}

/** Ensure a sticky filename label exists on the waveform overlay (not in the scrolling inner). */
function _ensureWfLabel(filename) {
  const ow = _overlayWrappers[filename];
  const wfEl = document.querySelector(`.waveform[data-ix='${filename}']`);
  const parent = ow ? ow.wrapper : wfEl;
  if (!parent) return;
  // Remove any existing label
  const existing = parent.querySelector(".wf-label");
  if (existing) return; // already exists
  const lbl = document.createElement("div");
  lbl.className = "wf-label";
  lbl.textContent = filename;
  parent.appendChild(lbl);
  // Match background to the waveform's effective background colour
  lbl.style.backgroundColor = _wfBgCache[filename] || _refreshWfBg(filename);
}

/** Sync overlay scroll transform to match WaveSurfer's scroll position. */
function _syncOverlayScroll(filename) {
  const ow = _overlayWrappers[filename];
  if (!ow) return;
  const scrollLeft = wavesurfers[filename]
    ? wavesurfers[filename].getScroll()
    : 0;
  ow.inner.style.transform = `translateX(${-scrollLeft}px)`;
}

/** Configure WaveSurfer autoScroll/autoCenter for a waveform based on scroll mode. */
function _applyScrollMode(filename) {
  const ws = wavesurfers[filename];
  if (!ws) return;
  if (_currentZoomLevel <= 1) {
    ws.options.autoScroll = false;
    ws.options.autoCenter = false;
    return;
  }
  switch (_scrollMode) {
    case "follow":
      ws.options.autoScroll = true;
      ws.options.autoCenter = true;
      break;
    case "page":
    case "manual":
      ws.options.autoScroll = false;
      ws.options.autoCenter = false;
      break;
  }
}

/** Apply zoom level to all loaded waveforms. */
function applyZoom(level) {
  _currentZoomLevel = level;
  const label = document.getElementById("zoom-label");
  if (label) label.textContent = level + "x";
  const scrollControls = document.getElementById("scroll-mode-controls");
  if (scrollControls) scrollControls.style.display = level > 1 ? "" : "none";

  // For shared time axis, compute a common pxPerSec from the longest duration
  let sharedPxPerSec = null;
  let maxDuration = 0;
  if (_sharedTimeAxis) {
    Object.keys(wavesurfers).forEach((fn) => {
      if (!loaded.has(fn)) return;
      const d = wavesurfers[fn].getDuration();
      if (d > maxDuration) maxDuration = d;
    });
  }

  // When toggling shared time axis, first reset all widths synchronously so
  // layout settles before we call ws.zoom(). This avoids WaveSurfer's
  // ResizeObserver racing with our zoom calls.
  if (_sharedTimeAxis && maxDuration > 0 && level <= 1) {
    Object.keys(wavesurfers).forEach((filename) => {
      if (!loaded.has(filename)) return;
      const wfEl = document.querySelector(`.waveform[data-ix='${filename}']`);
      if (!wfEl) return;
      const fraction = wavesurfers[filename].getDuration() / maxDuration;
      wfEl.style.width = Math.max(fraction * 100, 5) + "%"; // min 5% to avoid collapse
    });
  } else if (!_sharedTimeAxis) {
    Object.keys(wavesurfers).forEach((filename) => {
      const wfEl = document.querySelector(`.waveform[data-ix='${filename}']`);
      if (wfEl) wfEl.style.width = "";
    });
  }

  // Compute shared pxPerSec once from a reference container (after widths settle)
  if (_sharedTimeAxis && maxDuration > 0 && level > 1) {
    // Reset widths first, then compute from parent container
    Object.keys(wavesurfers).forEach((filename) => {
      const wfEl = document.querySelector(`.waveform[data-ix='${filename}']`);
      if (wfEl) wfEl.style.width = "";
    });
    const refEl = document.querySelector("#waveforms .waveform");
    const refWidth = refEl ? refEl.clientWidth : 800;
    sharedPxPerSec = (level * refWidth) / maxDuration;
  }

  Object.keys(wavesurfers).forEach((filename) => {
    if (!loaded.has(filename)) return;
    const ws = wavesurfers[filename];
    const wfEl = document.querySelector(`.waveform[data-ix='${filename}']`);
    if (!ws || !wfEl) return;

    try {
      if (_sharedTimeAxis && maxDuration > 0) {
        if (level <= 1) {
          ws.zoom(0); // fillParent within narrower container
        } else {
          ws.zoom(sharedPxPerSec);
        }
      } else {
        const containerWidth = wfEl.clientWidth;
        if (level <= 1) {
          ws.zoom(0); // reset to fillParent
        } else {
          ws.zoom((level * containerWidth) / ws.getDuration());
        }
      }
    } catch (e) {
      console.warn("Zoom error for", filename, e);
    }
    _applyScrollMode(filename);
    // redrawcomplete will fire and handle overlay resize + marker redraw
  });
}

/** Page-scroll the active waveform if playhead is about to leave visible area. */
function _pageScrollIfNeeded(filename) {
  const ws = wavesurfers[filename];
  const scrollContainer = _getScrollContainer(filename);
  if (!ws || !scrollContainer) return;
  const currentTime = ws.getCurrentTime();
  const duration = ws.getDuration();
  const visibleWidth = scrollContainer.clientWidth;
  const totalWidth = scrollContainer.scrollWidth;
  const currentScroll = scrollContainer.scrollLeft;
  const playheadPx = (currentTime / duration) * totalWidth;
  const visibleEnd = currentScroll + visibleWidth;
  const margin = visibleWidth * 0.05;
  if (playheadPx > visibleEnd - margin || playheadPx < currentScroll) {
    const newScroll = Math.max(0, playheadPx - visibleWidth * 0.1);
    ws.setScroll(newScroll);
    _syncOverlayScroll(filename);
  }
}

/** Sync all waveform scroll positions to match the source waveform's center time. */
function _syncAllWaveformScrolls(sourceFilename) {
  if (_currentZoomLevel <= 1) return;
  const sourceWs = wavesurfers[sourceFilename];
  if (!sourceWs) return;
  const sourceWrapper = sourceWs.getWrapper();
  if (!sourceWrapper) return;
  const sourceScrollEl = sourceWrapper.parentElement;
  const sourceVisibleWidth = sourceScrollEl.clientWidth;
  const sourceTotalWidth = sourceWrapper.clientWidth;
  const sourceScroll = sourceWs.getScroll();
  const sourceDuration = sourceWs.getDuration();

  if (_sharedTimeAxis) {
    // Shared time axis: all waveforms share the same pxPerSec, so same
    // scrollLeft aligns to the same absolute time.
    Object.keys(wavesurfers).forEach((targetFilename) => {
      if (targetFilename === sourceFilename) return;
      if (!loaded.has(targetFilename)) return;
      const targetWs = wavesurfers[targetFilename];
      if (!targetWs) return;
      targetWs.setScroll(sourceScroll);
      _syncOverlayScroll(targetFilename);
      if (_gridRedrawers[targetFilename]) _gridRedrawers[targetFilename]();
    });
    return;
  }

  // Alignment-based sync: map through alignment grid
  // Time at center of source viewport
  const centerFraction =
    (sourceScroll + sourceVisibleWidth / 2) / sourceTotalWidth;
  const centerTime = centerFraction * sourceDuration;
  const sourceAlignIx = getClosestAlignmentIx(centerTime, sourceFilename);

  Object.keys(wavesurfers).forEach((targetFilename) => {
    if (targetFilename === sourceFilename) return;
    if (!loaded.has(targetFilename)) return;
    const targetWs = wavesurfers[targetFilename];
    if (!targetWs) return;
    const targetWrapper = targetWs.getWrapper();
    if (!targetWrapper) return;
    const targetTime = getCorrespondingTime(targetFilename, sourceAlignIx);
    const targetDuration = targetWs.getDuration();
    const targetTotalWidth = targetWrapper.clientWidth;
    const targetScrollEl = targetWrapper.parentElement;
    const targetVisibleWidth = targetScrollEl.clientWidth;
    const targetFraction = targetTime / targetDuration;
    const targetCenterPx = targetFraction * targetTotalWidth;
    const targetScroll = Math.max(0, targetCenterPx - targetVisibleWidth / 2);
    targetWs.setScroll(targetScroll);
    _syncOverlayScroll(targetFilename);
    // Redraw viewport-based canvases for this target
    if (_gridRedrawers[targetFilename]) _gridRedrawers[targetFilename]();
  });
}

// ---------------------------------------------------------------------------
// Time measurement (Shift-hold for marker durations, Shift+drag for spans)
// ---------------------------------------------------------------------------
let _measureShiftHeld = false;
let _measureDragState = null; // { filename, startAlignIx, endAlignIx }
const _measureElements = []; // DOM elements to clean up on Shift-up

/** Format a duration in seconds for measurement labels. */
function _formatDuration(seconds) {
  const abs = Math.abs(seconds);
  if (abs < 60) return abs.toFixed(2) + "s";
  const m = Math.floor(abs / 60);
  const s = (abs % 60).toFixed(1);
  return m + ":" + String(s).padStart(4, "0");
}

/** Show duration labels between consecutive markers on all waveforms. */
function _showMarkerDurations() {
  if (markers.length < 2) return;
  // Sort markers by alignment index to get consecutive pairs
  const sorted = markers
    .map((alignIx, i) => ({ alignIx, i }))
    .sort((a, b) => a.alignIx - b.alignIx);

  Object.keys(wavesurfers).forEach((filename) => {
    if (!loaded.has(filename)) return;
    const ws = wavesurfers[filename];
    const ow = _overlayWrappers[filename];
    if (!ws || !ow) return;
    const dur = ws.getDuration();
    const fullW = _getZoomedWidth(filename);

    for (let i = 0; i < sorted.length - 1; i++) {
      const t1 = getCorrespondingTime(filename, sorted[i].alignIx);
      const t2 = getCorrespondingTime(filename, sorted[i + 1].alignIx);
      const x1 = (t1 / dur) * fullW;
      const x2 = (t2 / dur) * fullW;
      const midX = (x1 + x2) / 2;
      const spanW = Math.abs(x2 - x1);

      // Duration label
      const label = document.createElement("div");
      label.className = "measure-label";
      label.textContent = _formatDuration(Math.abs(t2 - t1));
      label.style.left = midX + "px";
      ow.inner.appendChild(label);
      _measureElements.push(label);

      // Subtle span highlight
      const span = document.createElement("div");
      span.className = "measure-span";
      span.style.left = Math.min(x1, x2) + "px";
      span.style.width = spanW + "px";
      ow.inner.appendChild(span);
      _measureElements.push(span);
    }
  });
}

/**
 * Draw a measurement span from startAlignIx to endAlignIx across all waveforms.
 */
function _drawMeasureSpan(startAlignIx, endAlignIx) {
  // Clear previous span elements (keep marker duration labels)
  _measureElements.forEach((el) => {
    if (
      el.classList.contains("measure-drag-span") ||
      el.classList.contains("measure-drag-label")
    ) {
      el.remove();
    }
  });
  // Filter out removed elements
  for (let i = _measureElements.length - 1; i >= 0; i--) {
    if (!_measureElements[i].isConnected) _measureElements.splice(i, 1);
  }

  const ix1 = Math.min(startAlignIx, endAlignIx);
  const ix2 = Math.max(startAlignIx, endAlignIx);

  Object.keys(wavesurfers).forEach((filename) => {
    if (!loaded.has(filename)) return;
    const ws = wavesurfers[filename];
    const ow = _overlayWrappers[filename];
    if (!ws || !ow) return;
    const dur = ws.getDuration();
    const fullW = _getZoomedWidth(filename);
    const t1 = getCorrespondingTime(filename, ix1);
    const t2 = getCorrespondingTime(filename, ix2);
    const x1 = (t1 / dur) * fullW;
    const x2 = (t2 / dur) * fullW;
    const spanW = Math.abs(x2 - x1);

    // Highlight span
    const span = document.createElement("div");
    span.className = "measure-drag-span";
    span.style.left = Math.min(x1, x2) + "px";
    span.style.width = spanW + "px";
    ow.inner.appendChild(span);
    _measureElements.push(span);

    // Duration label
    const label = document.createElement("div");
    label.className = "measure-drag-label";
    label.textContent = _formatDuration(Math.abs(t2 - t1));
    label.style.left = (x1 + x2) / 2 + "px";
    ow.inner.appendChild(label);
    _measureElements.push(label);
  });
}

/** Remove all measurement visuals. */
function _clearMeasureVisuals() {
  _measureElements.forEach((el) => el.remove());
  _measureElements.length = 0;
  _measureDragState = null;
}

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
// Revert: original grids captured when alignment first loads
const _alignOriginalGrids = {};
// Radius presets (in alignment indices)
const _ALIGN_RADIUS_NARROW = 10;
const _ALIGN_RADIUS_MEDIUM = 30;
const _ALIGN_RADIUS_WIDE = 90;
// Current radius selection (set from UI)
let _alignRadius = _ALIGN_RADIUS_MEDIUM;
// Drag markers: whether markers are currently draggable
let _dragMarkersEnabled = false;
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

function hideWaveformOverlay(wfEl) {
  const overlay = wfEl.querySelector(".wf-resize-overlay");
  if (overlay) overlay.style.display = "none";
}

// --- Custom marker system (replaces WaveSurfer v4 markers plugin) ---

function _clearMarkers(filename) {
  const wfEl = document.querySelector(`.waveform[data-ix='${filename}']`);
  if (!wfEl) return;
  wfEl.querySelectorAll(".ws-marker").forEach((el) => el.remove());
}

function _addMarker(
  filename,
  { time, label, color = "red", position = "bottom", alignIx } = {},
) {
  const ws = wavesurfers[filename];
  if (!ws) return null;
  const duration = ws.getDuration();
  const wfEl = document.querySelector(`.waveform[data-ix='${filename}']`);
  if (!wfEl) return null;
  // Use pixel positioning on the full-width overlay inner div
  const fullW = _getZoomedWidth(filename);
  const leftPx =
    duration > 0 ? Math.max(0, Math.min(fullW, (time / duration) * fullW)) : 0;
  const marker = document.createElement("div");
  marker.className = "ws-marker";
  marker.dataset.time = time;
  marker.dataset.position = position;
  if (alignIx != null) marker.dataset.alignIx = alignIx;
  marker.style.left = `${leftPx}px`;
  marker.style.color = color;
  if (label) {
    const lbl = document.createElement("span");
    lbl.className = "ws-marker-label";
    lbl.textContent = label;
    marker.appendChild(lbl);
  }
  marker.addEventListener("click", (ev) => {
    ev.stopPropagation();
    _onMarkerClick(filename, marker);
  });
  // Append to the overlay inner div (scrolls with the waveform)
  const overlayInner = _overlayWrappers[filename]?.inner;
  (overlayInner || wfEl).appendChild(marker);
  return marker;
}

function _onMarkerClick(filename, markerEl) {
  if (markerEl.dataset.position === "top") return;
  const alignIxStr = markerEl.dataset.alignIx;
  if (alignIxStr == null) return;
  // If drag markers is enabled, let the mousedown handler on #waveforms
  // handle it (start a drag instead of seeking/entering close-listening).
  if (_dragMarkersEnabled) return;
  const alignmentIx = parseInt(alignIxStr);
  const markerArrayIx = markers.indexOf(alignmentIx);
  if (markerArrayIx > -1) {
    if (closeListeningMode) {
      activeMarkerIx = markerArrayIx;
      redrawAllMarkers();
      seekToActiveMarker();
    } else {
      enterCloseListeningMode(markerArrayIx);
    }
  } else {
    console.error("Could not find marker with alignIx", alignmentIx);
  }
}

// --- Alt-mode number overlay helpers ---

/** Returns .waveform elements that are >25% visible in the viewport, in DOM order. */
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
  Object.keys(wavesurfers).forEach((ws) => _clearMarkers(ws));
  // Show spinners; WaveSurfer v7's built-in ResizeObserver triggers rerenders per
  // waveform, each of which hides its own overlay in its "redrawcomplete" handler.
  showWaveformOverlays();
});

// --- Close-listening mode ---

function enterCloseListeningMode(markerArrayIndex) {
  closeListeningMode = true;
  if (markers.length > 0) {
    activeMarkerIx =
      markerArrayIndex != null ? markerArrayIndex : findClosestMarkerIndex();
    seekToActiveMarker();
  } else {
    activeMarkerIx = null;
  }
  redrawAllMarkers();
  updateCloseListeningBadge();
  _updateMarkBtnTooltip();
}

function exitCloseListeningMode() {
  closeListeningMode = false;
  activeMarkerIx = null;
  _updateMarkBtnTooltip();
  // Reset clip-path on the active waveform so the waveform isn't clipped
  // from a prior seekToActiveMarker() call (score-only page bug).
  if (currentAudioIx && wavesurfers[currentAudioIx]) {
    wavesurfers[currentAudioIx].seekTo(0);
  }
  redrawAllMarkers();
  updateCloseListeningBadge();
}

function seekToActiveMarker() {
  if (activeMarkerIx == null || !currentAudioIx) return;
  const alignIx = markers[activeMarkerIx];
  const t = getCorrespondingTime(currentAudioIx, alignIx);
  const duration = wavesurfers[currentAudioIx].getDuration();
  wavesurfers[currentAudioIx].seekTo(t / duration);
  // At zoom: only scroll if the marker is outside the visible viewport
  if (_currentZoomLevel > 1) {
    const ws = wavesurfers[currentAudioIx];
    const fullW = _getZoomedWidth(currentAudioIx);
    const scrollLeft = ws.getScroll();
    const scrollContainer = _getScrollContainer(currentAudioIx);
    const viewW = scrollContainer ? scrollContainer.clientWidth : fullW;
    const markerPx = (t / duration) * fullW;
    const inView = markerPx >= scrollLeft && markerPx <= scrollLeft + viewW;
    if (!inView) {
      ws.setScrollTime(t);
      _syncOverlayScroll(currentAudioIx);
      _syncAllWaveformScrolls(currentAudioIx);
    }
  }
  _updateMarkBtnTooltip();
}

function findClosestMarkerIndex() {
  // Find the closest marker at or before current playback position.
  // If none, use the closest marker in the future.
  if (markers.length === 0) return null;
  // Ensure we have a valid currentAudioIx (focus fix)
  if (!currentAudioIx || !wavesurfers[currentAudioIx]) {
    const keys = Object.keys(wavesurfers);
    if (keys.length === 0) return 0;
    currentAudioIx = keys[0];
  }
  const currentAlignIx = getClosestAlignmentIx();
  // Build sorted array of {markerArrayIndex, alignmentIx}
  const sorted = markers.map((m, i) => ({ i, m })).sort((a, b) => a.m - b.m);
  // Find closest at or before current position
  let best = null;
  for (const entry of sorted) {
    if (entry.m <= currentAlignIx) best = entry;
  }
  if (best != null) return best.i;
  // No marker in the past; use closest in the future
  return sorted[0].i;
}

function getSortedMarkerIndices() {
  // Returns indices into markers[] sorted by their alignment grid position
  return markers
    .map((m, i) => ({ i, m }))
    .sort((a, b) => a.m - b.m)
    .map((x) => x.i);
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
    radiusFieldset.disabled = !(_dragMarkersEnabled && _dragMode === "fix");
  // Update marker visual classes
  _updateMarkerDraggableClass();
  // Update correction overlay pointer-events
  const corrActive = _dragMarkersEnabled && _dragMode === "fix";
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
function _applyCorrectionOverlayPointerEvents() {
  const effective = _alignCorrectionMode && !_drawModeActive;
  document.querySelectorAll(".align-correction-overlay").forEach((c) => {
    c.style.pointerEvents = effective ? "auto" : "none";
    if (!effective) c.style.cursor = "";
  });
  document.body.classList.toggle("align-correction-active", effective);
}

/** Called by annotation.js when entering/exiting draw-region mode.
 *  Suppresses correction overlay pointer-events so drag-selection
 *  events reach the WaveSurfer wrapper. */
export function setDrawModeActive(active) {
  _drawModeActive = active;
  _applyCorrectionOverlayPointerEvents();
  // Toggle a class so CSS can suppress native drag on waveform elements
  document
    .getElementById("waveforms")
    ?.classList.toggle("draw-mode-active", active);
}

/** Toggle .draggable class on all marker elements. */
function _updateMarkerDraggableClass() {
  const draggable = _dragMarkersEnabled;
  document.querySelectorAll(".ws-marker[data-align-ix]").forEach((el) => {
    el.classList.toggle("draggable", draggable);
  });
}

function getClosestAlignmentIx(
  time = wavesurfers[currentAudioIx].getCurrentTime(),
  audioIx = currentAudioIx,
) {
  console.log("Get closest alignment Ix: ", time, audioIx);
  // return alignment index closest to supplied time (default: current playback position)
  let currentGrid = alignmentGrids[audioIx];
  // find the last grid entry at or below target time
  const lower = currentGrid.filter((t) => t <= time);
  const belowIx = lower.length - 1; // last index at or below time
  const aboveIx = lower.length; // first index above time
  if (belowIx < 0) return 0; // time is before grid start
  if (aboveIx >= currentGrid.length) return belowIx; // time is past grid end
  // return whichever is closer (prefer earlier on tie)
  const distBelow = time - currentGrid[belowIx];
  const distAbove = currentGrid[aboveIx] - time;
  return distAbove < distBelow ? aboveIx : belowIx;
}

export function getCorrespondingTime(audioIx, alignmentIx) {
  // get time position corresponding to current position of current audio,
  // in the alternative audio with index audioIx
  let grid = alignmentGrids[audioIx];
  return grid[alignmentIx];
}

function onClickRenditionName(e) {
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

function onClickRenditionCheckbox(e) {
  // n.b. separate handler to onClickRenditionName
  // used only to specifically show/hide renditions when
  // they have already loaded
  let checkbox = e.target;
  let checked = checkbox.checked;
  let label = checkbox.parentElement.querySelector("label");
  let waveform = document.getElementById("waveform-" + e.target.value + "-wav");
  if (!waveform) return; // element may not be in DOM during tab switch
  if (!checked) {
    e.stopPropagation(); // hide from other handler
    waveform.style.display = "none";
    checkbox.checked = false;
    label.classList.remove("ready");
    label.classList.add("loading");
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
  _updateGroupCounts();
  // Redraw tempo curves if scope depends on displayed files
  if (_tempoScopeDisplayedOnly && _tempoCurveVisible) {
    _tempoYRange = null;
    Object.values(_gridRedrawers).forEach((fn) => fn());
  }
}

export function swapCurrentAudio(newAudio) {
  if (currentAudioIx === newAudio) {
    // no need to swap
    return;
  }
  if (currentAudioIx) {
    console.log("Pausing current: ", currentAudioIx);
    console.log(
      "Current duration: ",
      wavesurfers[currentAudioIx].getDuration(),
    );
    // Detach annotation loop's pause listener before pausing,
    // so the swap-pause doesn't kill the active annotation loop.
    prepareAnnotationLoopTransfer();
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
    const oldScrollEl = _getScrollContainer(currentAudioIx);
    const savedScroll = oldScrollEl ? oldScrollEl.scrollLeft : 0;
    _scrollSyncLock = true;
    wavesurfers[currentAudioIx].seekTo(0);
    if (oldScrollEl) oldScrollEl.scrollLeft = savedScroll;
    _scrollSyncLock = false;
    // swap to new audio and alignment grid
    currentAudioIx = newAudio;
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
    // seek to new (corresponding) position
    let correspondingPosition = currentGrid[closestAlignmentIx];
    let newPosition =
      correspondingPosition / wavesurfers[currentAudioIx].getDuration();
    wavesurfers[currentAudioIx].seekTo(newPosition);
    // At zoom: the new waveform is already scroll-synced via
    // _syncAllWaveformScrolls, so don't reposition — just sync overlays.
    if (_currentZoomLevel > 1) {
      _syncOverlayScroll(currentAudioIx);
    }
    if (wasPlaying) wavesurfers[currentAudioIx].play();
  } else {
    currentAudioIx = newAudio;
    const newActiveWaveform = document.getElementById(
      `waveform-${currentAudioIx}` + "-wav",
    );
    if (newActiveWaveform) {
      newActiveWaveform.classList.add("active");
    }
  }
  // Redraw grids for old and new waveforms so tick backgrounds reflect active state
  // Refresh cached backgrounds and redraw grids so tick colours match active state
  _refreshWfBg(prevAudio);
  _refreshWfBg(currentAudioIx);
  if (_gridRedrawers[prevAudio]) _gridRedrawers[prevAudio]();
  if (_gridRedrawers[currentAudioIx]) _gridRedrawers[currentAudioIx]();
  // If an annotation loop is active, continue it on the newly-active waveform
  continueAnnotationLoopOnWaveform(currentAudioIx);
}

function generateCheckboxList(list, isDraggable = false) {
  console.log("Generate checkbox list: ", list);
  // generate content for <ul>:
  // <li> containing a checkbox for each list member
  const ul = document.createElement("ul");
  list.forEach((n) => {
    const li = document.createElement("li");
    li.classList.add("renditionName");
    li.id = n;

    const checkboxSpan = document.createElement("span");
    const checkbox = document.createElement("input");
    checkbox.id = "checkbox-" + n;
    checkbox.name = "checkbox-" + n;
    checkbox.type = "checkbox";
    checkbox.classList.add("renditionCheckbox");
    checkbox.value = n;
    const label = document.createElement("label");
    label.htmlFor = "checkbox-" + n; // use htmlFor for DOM property
    label.innerText = n.substr(n.indexOf("/") + 1); // HACK, use semantic title

    checkboxSpan.appendChild(checkbox);
    checkboxSpan.appendChild(label);

    li.appendChild(checkboxSpan);

    if (isDraggable) {
      const handle = document.createElement("span");
      handle.className = "nav-drag-handle";
      handle.setAttribute("aria-hidden", "true");
      handle.textContent = "⠿";
      li.appendChild(handle);

      // Only start a drag when the handle is the pointer-down target
      let _fromHandle = false;
      handle.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        _fromHandle = true;
      });
      handle.addEventListener("click", (e) => e.stopPropagation());
      li.addEventListener("pointerup", () => {
        _fromHandle = false;
      });
      li.draggable = true;
      li.addEventListener("dragstart", (ev) => {
        if (!_fromHandle) {
          ev.preventDefault();
          return;
        }
        _fromHandle = false;
        ev.dataTransfer.setData("nav-file", n);
        ev.dataTransfer.effectAllowed = "move";
        li.classList.add("nav-dragging");
      });
      li.addEventListener("dragend", () => {
        _fromHandle = false;
        li.classList.remove("nav-dragging");
      });
    }

    ul.appendChild(li);
  });
  return ul;
}

// ---------------------------------------------------------------------------
// File grouping — state, persistence, sidebar rendering, modal
// ---------------------------------------------------------------------------
const _GROUPS_STORAGE_PREFIX = "listenTool_fileGroups_";

/** Predefined pastel palette for group colours (similar saturation, subtle). */
const _GROUP_PALETTE = [
  "#dbeafe", // soft blue
  "#dcfce7", // soft green
  "#fce7f3", // soft pink
  "#ede9fe", // soft lavender
  "#ffedd5", // soft peach
  "#ccfbf1", // soft teal
  "#fef9c3", // soft yellow
  "#ffe4e6", // soft rose
  "#e0e7ff", // soft indigo
  "#d1fae5", // soft mint
  "#fde68a", // soft amber
  "#e9d5ff", // soft purple
];

/** Return the next palette colour not yet used by any group. */
function _nextGroupColour(groups) {
  const used = new Set((groups || []).map((g) => g.color).filter(Boolean));
  for (const c of _GROUP_PALETTE) {
    if (!used.has(c)) return c;
  }
  // All used — cycle back
  return _GROUP_PALETTE[(groups || []).length % _GROUP_PALETTE.length];
}

/** Returns the localStorage key for the current context. */
function _groupsStorageKey() {
  return _GROUPS_STORAGE_PREFIX + (window.location.pathname || "default");
}

/**
 * Load saved groups from localStorage.
 * Format: [ { name: string, pattern: string, files: string[] }, ... ]
 */
function _loadGroups() {
  try {
    const raw = localStorage.getItem(_groupsStorageKey());
    if (raw) return JSON.parse(raw);
  } catch (e) {
    console.warn("Could not load file groups from localStorage:", e);
  }
  return [];
}

// ---------------------------------------------------------------------------
// Grouping Tabs – migration and accessors
// ---------------------------------------------------------------------------

/**
 * Migrate legacy flat fileGroups/groupOrder into the new groupingTabs format.
 * Call once after alignment JSON is loaded.
 */
function _migrateToGroupingTabs() {
  if (!loadedAlignmentJSON) return;
  if (!loadedAlignmentJSON.header) loadedAlignmentJSON.header = {};
  const h = loadedAlignmentJSON.header;

  if (Array.isArray(h.groupingTabs) && h.groupingTabs.length > 0) return;

  // Wrap existing flat groups (or localStorage fallback) into a "Default" tab
  const groups = Array.isArray(h.fileGroups) ? h.fileGroups : _loadGroups();
  const order = Array.isArray(h.groupOrder) ? h.groupOrder : [];
  h.groupingTabs = [{ name: "Default", fileGroups: groups, groupOrder: order }];
  h.activeTab = "Default";

  // Remove legacy flat properties now that they are nested inside the tab
  delete h.fileGroups;
  delete h.groupOrder;
}

/** Return the active tab object (falls back to index 0). */
function _getActiveTab() {
  const h = loadedAlignmentJSON?.header;
  if (!h || !Array.isArray(h.groupingTabs) || h.groupingTabs.length === 0) {
    return { name: "Default", fileGroups: [], groupOrder: [] };
  }
  return (
    h.groupingTabs.find((t) => t.name === h.activeTab) || h.groupingTabs[0]
  );
}

function _getActiveFileGroups() {
  return _getActiveTab().fileGroups || [];
}

function _getActiveGroupOrder() {
  return _getActiveTab().groupOrder || [];
}

function _setActiveFileGroups(groups) {
  const tab = _getActiveTab();
  tab.fileGroups = groups;
}

function _setActiveGroupOrder(order) {
  const tab = _getActiveTab();
  tab.groupOrder = order;
}

/**
 * Build the sidebar file list from the current filenames + saved groups.
 * Score foldout is added separately if present.
 */
function _renderSidebarFileList(filenames) {
  const audiosElement = document.getElementById("audios");
  // Remove old fieldsets / lists (preserve non-list children like buttons)
  audiosElement
    .querySelectorAll("fieldset.audio-group, ul.ungrouped-files")
    .forEach((el) => el.remove());

  // Use active tab's groups (migrated on load)
  const groups = loadedAlignmentJSON ? _getActiveFileGroups() : [];

  // Determine which files belong to groups
  const grouped = new Set();
  groups.forEach((g) => {
    (g.files || []).forEach((f) => grouped.add(f));
    if (g.pattern) {
      try {
        const re = new RegExp(g.pattern);
        filenames.forEach((f) => {
          const short = f.substring(f.lastIndexOf("/") + 1);
          if (re.test(short) || re.test(f)) grouped.add(f);
        });
      } catch (_) {
        /* invalid regex — ignore */
      }
    }
  });

  // Build effective group membership (pattern + explicit)
  const groupMembers = groups.map((g) => {
    const members = new Set(g.files || []);
    if (g.pattern) {
      try {
        const re = new RegExp(g.pattern);
        filenames.forEach((f) => {
          const short = f.substring(f.lastIndexOf("/") + 1);
          if (re.test(short) || re.test(f)) members.add(f);
        });
      } catch (_) {}
    }
    return [...members].filter((f) => filenames.includes(f)).sort();
  });

  // Ungrouped files
  const ungrouped = filenames.filter((f) => !grouped.has(f)).sort();

  /** Helper: create a <fieldset class="audio-group collapsible-fieldset"> */
  function _makeGroupFieldset(
    label,
    filesArray,
    isDraggable,
    isGroupDraggable,
  ) {
    const fs = document.createElement("fieldset");
    fs.className = "audio-group collapsible-fieldset";
    fs.id = "audio-group-" + label.toLowerCase().replace(/\s+/g, "-");

    const legend = document.createElement("legend");
    legend.title = "Collapse / expand " + label;
    legend.textContent = label + " ";
    const arrow = document.createElement("span");
    arrow.className = "collapse-arrow";
    arrow.innerHTML = "&#9662;";
    legend.appendChild(arrow);

    // Group-level drag handle (for reordering groups in the sidebar)
    if (isGroupDraggable) {
      const groupHandle = document.createElement("span");
      groupHandle.className = "nav-group-drag-handle";
      groupHandle.setAttribute("aria-hidden", "true");
      groupHandle.textContent = "\u2630"; // hamburger ☰
      groupHandle.title = "Drag to reorder group";
      legend.appendChild(groupHandle);

      let _fromGroupHandle = false;
      groupHandle.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        _fromGroupHandle = true;
        fs.draggable = true; // only make fieldset draggable while handle is held
      });
      groupHandle.addEventListener("click", (e) => e.stopPropagation());
      fs.addEventListener("pointerup", () => {
        _fromGroupHandle = false;
      });
      fs.addEventListener("dragstart", (ev) => {
        if (!_fromGroupHandle) {
          fs.draggable = false;
          return; // let file-level drags pass through
        }
        _fromGroupHandle = false;
        ev.dataTransfer.setData("nav-group", label);
        ev.dataTransfer.effectAllowed = "move";
        fs.classList.add("nav-group-dragging");
      });
      fs.addEventListener("dragend", () => {
        _fromGroupHandle = false;
        fs.draggable = false;
        fs.classList.remove("nav-group-dragging");
      });
    }

    fs.appendChild(legend);

    const body = document.createElement("div");
    body.className = "fieldset-body";

    if (isDraggable) {
      const listSelectors = document.createElement("span");
      listSelectors.className = "listSelectors";
      listSelectors.innerHTML =
        "<span class='all'>All</span><span class='none'>None</span>";
      body.appendChild(listSelectors);
    }

    body.appendChild(generateCheckboxList(filesArray, isDraggable));
    fs.appendChild(body);

    // Restore collapsed state from localStorage
    try {
      if (localStorage.getItem("fieldset-collapsed-" + fs.id) === "true") {
        fs.classList.add("collapsed");
      }
    } catch (_) {}

    return fs;
  }

  // --- Build all fieldsets, then append in saved order ---

  // Create fieldsets keyed by group name
  const fieldsetsByName = {};

  // Score fieldset
  if (SYNTH_MEI_KEY in alignmentGrids) {
    fieldsetsByName["Score"] = _makeGroupFieldset(
      "Score",
      [SYNTH_MEI_KEY],
      false,
      true,
    );
  }

  // Named group fieldsets
  groups.forEach((g, i) => {
    const members = groupMembers[i];
    if (members.length === 0) return;
    const fs = _makeGroupFieldset(g.name, members, true, true);
    _wireNavGroupDrop(fs);
    fieldsetsByName[g.name] = fs;
  });

  // Ungrouped fieldset
  const ungroupedLabel =
    groups.length > 0 ? "Ungrouped recordings" : "All recordings";
  if (ungrouped.length > 0) {
    const fs = _makeGroupFieldset(ungroupedLabel, ungrouped, true, true);
    _wireNavGroupDrop(fs);
    fieldsetsByName["Ungrouped"] = fs;
  }

  // Append in saved groupOrder (uses normalized names), then any remaining
  const activeOrder = loadedAlignmentJSON ? _getActiveGroupOrder() : [];
  const savedOrder = activeOrder.length > 0 ? activeOrder : null;

  const appended = new Set();
  if (savedOrder) {
    savedOrder.forEach((name) => {
      if (fieldsetsByName[name] && !appended.has(name)) {
        audiosElement.appendChild(fieldsetsByName[name]);
        appended.add(name);
      }
    });
  }
  // Default order for any not in savedOrder: Score, named groups, Ungrouped
  const defaultOrder = ["Score", ...groups.map((g) => g.name), "Ungrouped"];
  defaultOrder.forEach((name) => {
    if (fieldsetsByName[name] && !appended.has(name)) {
      audiosElement.appendChild(fieldsetsByName[name]);
      appended.add(name);
    }
  });

  // Wire up group-level drag-and-drop reordering on the sidebar
  _wireNavGroupReorder(audiosElement);

  // Wire up list selectors (All / None)
  _wireListSelectors();

  // Rendition click / checkbox handlers
  Array.from(document.getElementsByClassName("renditionName")).forEach((r) => {
    r.addEventListener("click", onClickRenditionName);
  });
  Array.from(document.getElementsByClassName("renditionCheckbox")).forEach(
    (r) => {
      r.addEventListener("click", onClickRenditionCheckbox);
    },
  );
}

/**
 * Wire drag-over / drop onto the <ul> inside a nav group fieldset so that
 * nav items can be reordered within and between non-Score groups.
 *
 * During dragover the <li> is moved live in the sidebar and the content panel
 * is reordered (without animation) via a throttled rAF.  On drop we persist
 * the new order and run a final sync.
 */
let _navDragRafPending = false;

function _wireNavGroupDrop(groupEl) {
  const ul = groupEl.querySelector("ul");
  if (!ul) return;

  /** Move draggedLi into `targetUl` at the position closest to `clientY`. */
  function _moveToPosition(draggedLi, targetUl, clientY) {
    const items = Array.from(targetUl.querySelectorAll("li.renditionName"));
    const insertBefore = items.find((li) => {
      if (li === draggedLi) return false;
      const r = li.getBoundingClientRect();
      return clientY < r.top + r.height / 2;
    });
    if (insertBefore) {
      targetUl.insertBefore(draggedLi, insertBefore);
    } else {
      targetUl.appendChild(draggedLi);
    }
  }

  ul.addEventListener("dragover", (e) => {
    if (!e.dataTransfer.types.includes("nav-file")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";

    // Find the currently dragged <li> (it has .nav-dragging)
    const draggedLi = document.querySelector("li.nav-dragging");
    if (!draggedLi) return;

    // Live-move the <li> within this <ul>
    _moveToPosition(draggedLi, ul, e.clientY);

    // Throttled content-panel sync with FLIP animation
    if (!_navDragRafPending) {
      _navDragRafPending = true;
      requestAnimationFrame(() => {
        _navDragRafPending = false;
        _applyNavOrderToContentPanel();
      });
    }
  });

  ul.addEventListener("drop", (e) => {
    e.preventDefault();
    // Final sync + persist
    _syncGroupsFromNav();
  });
}

/**
 * Wire up group-level drag-and-drop reordering in the sidebar.
 * Groups can be dragged above/below each other; Score stays first,
 * Ungrouped stays last.
 */
let _navGroupDragRafPending = false;

function _wireNavGroupReorder(audiosElement) {
  /** Live-move draggedFs to the position closest to clientY among siblings. */
  function _moveGroupToPosition(draggedFs, clientY) {
    const siblings = Array.from(
      audiosElement.querySelectorAll("fieldset.audio-group"),
    ).filter((fs) => fs !== draggedFs);

    const insertBefore = siblings.find((fs) => {
      const r = fs.getBoundingClientRect();
      return clientY < r.top + r.height / 2;
    });

    if (insertBefore) {
      audiosElement.insertBefore(draggedFs, insertBefore);
    } else {
      audiosElement.appendChild(draggedFs);
    }
  }

  audiosElement.addEventListener("dragover", (e) => {
    if (!e.dataTransfer.types.includes("nav-group")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";

    const draggedFs = audiosElement.querySelector(
      "fieldset.nav-group-dragging",
    );
    if (!draggedFs) return;

    // Live-move the fieldset in the sidebar
    _moveGroupToPosition(draggedFs, e.clientY);

    // Throttled content-panel sync (no animation during drag for performance)
    if (!_navGroupDragRafPending) {
      _navGroupDragRafPending = true;
      requestAnimationFrame(() => {
        _navGroupDragRafPending = false;
        _applyNavOrderToContentPanel(false);
      });
    }
  });

  audiosElement.addEventListener("drop", (e) => {
    if (!e.dataTransfer.types.includes("nav-group")) return;
    e.preventDefault();
    const draggedFs = audiosElement.querySelector(
      "fieldset.nav-group-dragging",
    );
    if (draggedFs) draggedFs.classList.remove("nav-group-dragging");
    // Final sync + persist
    _syncGroupsFromNav();
  });
}

/**
 * Read the current sidebar DOM order and persist it to
 * loadedAlignmentJSON.header.fileGroups, then sync the content panel.
 */
function _syncGroupsFromNav() {
  if (!loadedAlignmentJSON) return;
  if (!loadedAlignmentJSON.header) loadedAlignmentJSON.header = {};

  // Build lookup of existing group properties (pattern, color) by name
  const oldGroups = _getActiveFileGroups();
  const oldByName = {};
  oldGroups.forEach((g) => {
    oldByName[g.name] = g;
  });

  const audios = document.getElementById("audios");
  const groups = [];

  audios.querySelectorAll("fieldset.audio-group").forEach((fs) => {
    const groupName = _getGroupNameFromFieldset(fs);
    if (groupName === "Score") return; // Score group is immutable

    const files = Array.from(fs.querySelectorAll("li.renditionName"))
      .map((li) => li.id)
      .filter(Boolean);

    // Ungrouped container is not stored as an explicit group
    if (groupName === "Ungrouped recordings" || groupName === "All recordings")
      return;

    // Preserve pattern and color from existing group definition
    const old = oldByName[groupName] || {};
    const entry = { name: groupName, files };
    if (old.pattern) entry.pattern = old.pattern;
    if (old.color) entry.color = old.color;
    groups.push(entry);
  });

  _setActiveFileGroups(groups);

  // Persist full group display order using normalized names (matching data-group)
  const groupOrder = [];
  audios.querySelectorAll("fieldset.audio-group").forEach((fs) => {
    const name = _getGroupNameFromFieldset(fs);
    if (name === "Ungrouped recordings" || name === "All recordings") {
      groupOrder.push("Ungrouped");
    } else {
      groupOrder.push(name);
    }
  });
  _setActiveGroupOrder(groupOrder);

  _changeCounter++;
  _updateDirtyState();
  _applyNavOrderToContentPanel();
}

/** Extract the group name from a sidebar fieldset legend, stripping UI elements. */
function _getGroupNameFromFieldset(fs) {
  const legend = fs.querySelector("legend");
  if (!legend) return "";
  // Clone legend and remove child elements (collapse arrow, drag handle)
  // to get just the text content of the legend itself
  const clone = legend.cloneNode(true);
  clone
    .querySelectorAll(".collapse-arrow, .nav-group-drag-handle")
    .forEach((el) => el.remove());
  return clone.textContent.trim();
}

/**
 * Reorder waveform elements in the content panel to match the nav sidebar order.
 * @param {boolean} animate - If true, use FLIP animation. If false, just reorder DOM.
 */
function _applyNavOrderToContentPanel(animate = true) {
  const waveformsRoot = document.getElementById("waveforms");
  if (!waveformsRoot) return;

  // FIRST: snapshot positions (only needed for animation)
  const allWaveforms = Array.from(
    waveformsRoot.querySelectorAll(".file-group .waveform"),
  );
  const firstRects = new Map();
  if (animate) {
    allWaveforms.forEach((wf) => {
      firstRects.set(wf, wf.getBoundingClientRect());
    });
  }

  // Build desired order from the nav
  const audios = document.getElementById("audios");

  /** Find the content-pane file-group matching a sidebar group name. */
  function _findContentGroup(groupName) {
    if (groupName === "Score") {
      return waveformsRoot.querySelector(".file-group-score");
    }
    if (
      groupName === "Ungrouped recordings" ||
      groupName === "All recordings"
    ) {
      return waveformsRoot.querySelector(".file-group-ungrouped");
    }
    return waveformsRoot.querySelector(
      `.file-group[data-group='${CSS.escape(groupName)}']`,
    );
  }

  // Reorder file-group containers in content pane to match sidebar order
  audios.querySelectorAll("fieldset.audio-group").forEach((fs) => {
    const groupName = _getGroupNameFromFieldset(fs);
    const fg = _findContentGroup(groupName);
    if (fg) {
      waveformsRoot.appendChild(fg);
    }
  });

  // Reorder waveforms within each group to match nav order
  audios.querySelectorAll("fieldset.audio-group").forEach((fs) => {
    const groupName = _getGroupNameFromFieldset(fs);

    const filenames = Array.from(fs.querySelectorAll("li.renditionName"))
      .map((li) => li.id)
      .filter(Boolean);

    const fg = _findContentGroup(groupName);
    const groupList = fg ? fg.querySelector(".group-list") : null;
    if (!groupList) return;

    // Move any cross-group waveforms into this group-list first
    filenames.forEach((fname) => {
      const wf = waveformsRoot.querySelector(
        `.waveform[data-ix='${CSS.escape(fname)}']`,
      );
      if (wf && wf.parentElement !== groupList) {
        groupList.appendChild(wf);
      }
    });

    // Re-order within the group-list to match nav order
    filenames.forEach((fname, idx) => {
      const wf = groupList.querySelector(
        `.waveform[data-ix='${CSS.escape(fname)}']`,
      );
      if (!wf) return;
      const ref = groupList.children[idx];
      if (ref && ref !== wf) groupList.insertBefore(wf, ref);
      else if (!ref) groupList.appendChild(wf);
    });
  });

  function _onAllTransitionsDone() {
    // After DOM reorder + animation, WaveSurfer containers may need a
    // re-render (especially when zoomed — shadow DOM can go blank).
    Object.keys(wavesurfers).forEach((fn) => {
      if (!loaded.has(fn)) return;
      _syncOverlayScroll(fn);
      if (_gridRedrawers[fn]) _gridRedrawers[fn]();
    });
    redrawAllMarkers();
  }

  if (!animate) {
    _onAllTransitionsDone();
    return;
  }

  // INVERT: shift elements back to where they visually were
  allWaveforms.forEach((wf) => {
    const first = firstRects.get(wf);
    if (!first) return;
    const last = wf.getBoundingClientRect();
    const dy = first.top - last.top;
    if (dy !== 0) {
      wf.style.transition = "none";
      wf.style.transform = `translateY(${dy}px)`;
      // Mark displaced waveforms (not the one being dragged)
      if (!wf.classList.contains("dragging")) {
        wf.classList.add("wf-displaced");
      }
    }
  });

  // PLAY: animate to final positions
  let _pendingTransitions = 0;
  requestAnimationFrame(() => {
    allWaveforms.forEach((wf) => {
      if (wf.style.transform) {
        _pendingTransitions++;
        wf.style.transition = "transform 300ms ease";
        wf.style.transform = "";
        const onEnd = () => {
          wf.style.transition = "";
          wf.classList.remove("wf-displaced");
          wf.removeEventListener("transitionend", onEnd);
          if (--_pendingTransitions === 0) _onAllTransitionsDone();
        };
        wf.addEventListener("transitionend", onEnd);
      }
    });
    // If no transitions were queued (no elements moved), still redraw
    if (_pendingTransitions === 0) _onAllTransitionsDone();
  });
}

/**
 * Ensure waveform group containers exist in the main content pane.
 * Idempotent: creates only missing containers; never destroys existing ones
 * (which would orphan already-mounted waveforms).
 * Pass `forceRebuild = true` (e.g. from reloadWaveforms) to tear down first.
 */
function _ensureWaveformGroupContainers(filenames, forceRebuild = false) {
  const waveformsRoot = document.getElementById("waveforms");

  if (forceRebuild) {
    // Detach waveform elements before removing group containers so they
    // stay in the DOM and can be re-placed into new containers below.
    const detached = [];
    waveformsRoot.querySelectorAll(".file-group .waveform").forEach((wf) => {
      detached.push(wf);
      waveformsRoot.appendChild(wf); // park on root temporarily
    });
    Array.from(waveformsRoot.querySelectorAll(".file-group")).forEach((el) =>
      el.remove(),
    );
  }

  // If containers already exist, nothing to do
  if (waveformsRoot.querySelector(".file-group")) return;

  const groups = loadedAlignmentJSON ? _getActiveFileGroups() : [];

  // Determine membership similar to sidebar: support explicit files + pattern
  const grouped = new Set();
  groups.forEach((g) => {
    (g.files || []).forEach((f) => grouped.add(f));
    if (g.pattern) {
      try {
        const re = new RegExp(g.pattern);
        filenames.forEach((f) => {
          const short = f.substring(f.lastIndexOf("/") + 1);
          if (re.test(short) || re.test(f)) grouped.add(f);
        });
      } catch (_) {}
    }
  });

  const groupMembers = groups.map((g) => {
    const members = new Set(g.files || []);
    if (g.pattern) {
      try {
        const re = new RegExp(g.pattern);
        filenames.forEach((f) => {
          const short = f.substring(f.lastIndexOf("/") + 1);
          if (re.test(short) || re.test(f)) members.add(f);
        });
      } catch (_) {}
    }
    return [...members].filter((f) => filenames.includes(f)).sort();
  });

  const ungrouped = filenames.filter((f) => !grouped.has(f)).sort();

  // Build all containers keyed by group name, then append in saved order
  const contentByName = {};

  // Score container (if present)
  if (SYNTH_MEI_KEY in alignmentGrids) {
    const el = document.createElement("div");
    el.className = "file-group file-group-score";
    el.dataset.group = "Score";
    el.innerHTML = `<div class="group-title">Score <span class="group-count"></span></div><div class="group-list"></div>`;
    contentByName["Score"] = el;
  }

  // Named group containers
  groups.forEach((g, i) => {
    const members = groupMembers[i];
    if (members.length === 0) return;
    const container = document.createElement("div");
    container.className = "file-group";
    container.dataset.group = g.name;
    container.innerHTML = `<div class="group-title">${g.name} <span class="group-count"></span><span class="group-actions"><span class="group-all">All</span><span class="group-none">None</span></span></div><div class="group-list"></div>`;
    if (g.color) {
      container.style.backgroundColor = g.color;
    }
    contentByName[g.name] = container;
  });

  // Ungrouped container
  const ungroupedLabel =
    groups.length > 0 ? "Ungrouped recordings" : "All recordings";
  if (ungrouped.length > 0) {
    const uc = document.createElement("div");
    uc.className = "file-group file-group-ungrouped";
    uc.dataset.group = "Ungrouped";
    uc.innerHTML = `<div class="group-title">${ungroupedLabel} <span class="group-count"></span><span class="group-actions"><span class="group-all">All</span><span class="group-none">None</span></span></div><div class="group-list"></div>`;
    contentByName["Ungrouped"] = uc;
  }

  // Append in saved groupOrder (uses data-group values), then any remaining
  const activeOrder = loadedAlignmentJSON ? _getActiveGroupOrder() : [];
  const savedOrder = activeOrder.length > 0 ? activeOrder : null;

  const contentAppended = new Set();
  if (savedOrder) {
    savedOrder.forEach((name) => {
      if (contentByName[name] && !contentAppended.has(name)) {
        waveformsRoot.appendChild(contentByName[name]);
        contentAppended.add(name);
      }
    });
  }
  const defaultContentOrder = [
    "Score",
    ...groups.map((g) => g.name),
    "Ungrouped",
  ];
  defaultContentOrder.forEach((name) => {
    if (contentByName[name] && !contentAppended.has(name)) {
      waveformsRoot.appendChild(contentByName[name]);
      contentAppended.add(name);
    }
  });

  // Make non-Score group-lists droppable for reordering
  waveformsRoot.querySelectorAll(".group-list").forEach((list) => {
    // Score group-list must not accept drops
    if (list.closest(".file-group-score")) return;

    list.addEventListener("dragover", (e) => {
      e.preventDefault();
    });
    list.addEventListener("drop", (e) => {
      e.preventDefault();
      const fname = e.dataTransfer.getData("text/plain");
      if (!fname) return;
      const draggedEl = document.querySelector(
        `.waveform[data-ix='${CSS.escape(fname)}']`,
      );
      if (!draggedEl) return;
      const targetList = e.currentTarget;
      // Find child under pointer to place before/after
      const afterEl = Array.from(targetList.querySelectorAll(".waveform")).find(
        (el) => {
          const r = el.getBoundingClientRect();
          return e.clientY < r.top + r.height / 2;
        },
      );
      if (afterEl) targetList.insertBefore(draggedEl, afterEl);
      else targetList.appendChild(draggedEl);

      _persistGroupOrder();
    });
  });

  // Wire All/None buttons on content-pane group headers.
  // Use the nav sidebar checkboxes (always present) rather than content-pane
  // .waveform elements (only present after loading).
  waveformsRoot.querySelectorAll(".group-all").forEach((btn) => {
    btn.addEventListener("click", () => {
      const fg = btn.closest(".file-group");
      if (!fg) return;
      _getNavCheckboxesForGroup(fg).forEach((cb) => {
        if (!cb.checked) cb.click();
      });
    });
  });
  waveformsRoot.querySelectorAll(".group-none").forEach((btn) => {
    btn.addEventListener("click", () => {
      const fg = btn.closest(".file-group");
      if (!fg) return;
      _getNavCheckboxesForGroup(fg).forEach((cb) => {
        if (cb.checked) cb.click();
      });
    });
  });

  // Show initial (0/x) counts
  _updateGroupCounts();
}

// ---------------------------------------------------------------------------
// Grouping Tab Pills (content pane) and tab switching
// ---------------------------------------------------------------------------

/**
 * Render the pill selector at the top of the content pane.
 * Only shown when there are 2+ tabs.
 */
function _renderGroupingTabPills() {
  let pillRow = document.getElementById("grouping-tab-pills");
  const tabs = loadedAlignmentJSON?.header?.groupingTabs;
  if (!tabs || tabs.length < 2) {
    if (pillRow) pillRow.remove();
    return;
  }
  const activeTabName = loadedAlignmentJSON.header.activeTab || tabs[0].name;
  const contentEl = document.getElementById("content");
  const waveformsEl = document.getElementById("waveforms");
  if (!pillRow) {
    pillRow = document.createElement("div");
    pillRow.id = "grouping-tab-pills";
    contentEl.insertBefore(pillRow, waveformsEl);
  }
  pillRow.innerHTML = "";
  tabs.forEach((tab) => {
    const pill = document.createElement("span");
    pill.className = "gt-pill" + (tab.name === activeTabName ? " active" : "");
    pill.textContent = tab.name;
    pill.addEventListener("click", () => {
      if (tab.name === activeTabName) return;
      _switchActiveTab(tab.name);
    });
    pillRow.appendChild(pill);
  });
}

/**
 * Switch the active grouping tab — re-renders sidebar and content pane.
 */
function _switchActiveTab(tabName) {
  if (!loadedAlignmentJSON?.header) return;
  loadedAlignmentJSON.header.activeTab = tabName;

  const filenames = Object.keys(alignmentGrids)
    .filter((n) => n !== SYNTH_MEI_KEY)
    .sort();

  // Snapshot waveform positions for FLIP animation
  const waveformEls = document.querySelectorAll("#waveforms .waveform");
  const firstRects = new Map();
  waveformEls.forEach((el) => {
    firstRects.set(el, el.getBoundingClientRect());
  });

  // Re-render sidebar with new tab's groups
  _renderSidebarFileList(filenames);

  // Rebuild content pane group containers
  _ensureWaveformGroupContainers(
    filenames.concat(SYNTH_MEI_KEY in alignmentGrids ? [SYNTH_MEI_KEY] : []),
    true /* forceRebuild */,
  );

  // Move existing waveform elements into their new group containers
  const waveformsRoot = document.getElementById("waveforms");
  const groups = _getActiveFileGroups();
  const groupMap = new Map(); // filename -> group name
  groups.forEach((g) => {
    const members = new Set(g.files || []);
    if (g.pattern) {
      try {
        const re = new RegExp(g.pattern);
        filenames.forEach((f) => {
          const short = f.substring(f.lastIndexOf("/") + 1);
          if (re.test(short) || re.test(f)) members.add(f);
        });
      } catch (_) {}
    }
    members.forEach((f) => groupMap.set(f, g.name));
  });

  // Place each existing waveform into the correct group-list
  Object.keys(wavesurfers).forEach((fname) => {
    const wfEl = waveformsRoot.querySelector(
      `.waveform[data-ix='${CSS.escape(fname)}']`,
    );
    if (!wfEl) return;
    let targetList;
    if (fname === SYNTH_MEI_KEY) {
      targetList = waveformsRoot.querySelector(".file-group-score .group-list");
    } else if (groupMap.has(fname)) {
      const fg = waveformsRoot.querySelector(
        `.file-group[data-group='${CSS.escape(groupMap.get(fname))}']`,
      );
      targetList = fg?.querySelector(".group-list");
    }
    if (!targetList) {
      targetList = waveformsRoot.querySelector(
        ".file-group-ungrouped .group-list",
      );
    }
    if (targetList && wfEl.parentElement !== targetList) {
      targetList.appendChild(wfEl);
    }
  });

  _updateGroupCounts();

  // FLIP animation
  waveformEls.forEach((el) => {
    const first = firstRects.get(el);
    if (!first) return;
    const last = el.getBoundingClientRect();
    const dx = first.left - last.left;
    const dy = first.top - last.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
    el.style.transform = `translate(${dx}px, ${dy}px)`;
    el.style.transition = "none";
    requestAnimationFrame(() => {
      el.style.transition = "transform 0.3s ease";
      el.style.transform = "";
      el.addEventListener("transitionend", function handler() {
        el.style.transition = "";
        el.removeEventListener("transitionend", handler);
      });
    });
  });

  // Update pills
  _renderGroupingTabPills();

  // Redraw tempo curves — group membership may have changed
  if (_tempoScopeWithinGroup && _tempoCurveVisible) {
    _tempoYRange = null;
    Object.values(_gridRedrawers).forEach((fn) => fn());
  }

  _changeCounter++;
  _updateDirtyState();
}

/** Find nav sidebar checkboxes corresponding to a content-pane file-group. */
function _getNavCheckboxesForGroup(fg) {
  const groupName = fg.dataset.group;
  if (!groupName) return [];
  const navId = "audio-group-" + groupName.toLowerCase().replace(/\s+/g, "-");
  const navGroup = document.getElementById(navId);
  if (navGroup) return [...navGroup.querySelectorAll("input[type='checkbox']")];
  // Fallback for ungrouped
  for (const id of [
    "audio-group-ungrouped-recordings",
    "audio-group-all-recordings",
  ]) {
    const el = document.getElementById(id);
    if (el) return [...el.querySelectorAll("input[type='checkbox']")];
  }
  return [];
}

/** Update (x/y) loaded-count badges on content-pane file-group headers. */
function _updateGroupCounts() {
  const waveformsRoot = document.getElementById("waveforms");
  if (!waveformsRoot) return;
  waveformsRoot.querySelectorAll(".file-group").forEach((fg) => {
    if (fg.classList.contains("file-group-score")) return;
    const badge = fg.querySelector(".group-count");
    if (!badge) return;
    // Total from nav sidebar (always present), visible from content-pane waveforms
    const navCbs = _getNavCheckboxesForGroup(fg);
    const total = navCbs.length;
    const list = fg.querySelector(".group-list");
    const wfs = list ? list.querySelectorAll(".waveform") : [];
    const vis = Array.from(wfs).filter(
      (w) => w.style.display !== "none",
    ).length;
    badge.textContent = total > 0 ? `(${vis}/${total})` : "";
  });
}

function _updateDirtyState() {
  const isDirty = _changeCounter !== _savedAtCounter;
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

/** Persist markers into the alignment JSON and mark dirty. */
function _persistMarkers() {
  if (!loadedAlignmentJSON) return;
  if (!loadedAlignmentJSON.header) loadedAlignmentJSON.header = {};
  loadedAlignmentJSON.header.markers = [...markers];
}

/**
 * Update the Mark button tooltip: "Remove marker" when paused at a marker,
 * "Place marker" otherwise.
 */
function _updateMarkBtnTooltip() {
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

/** Persist the current group ordering into loadedAlignmentJSON.header.fileGroups */
function _persistGroupOrder() {
  if (!loadedAlignmentJSON) return;
  if (!loadedAlignmentJSON.header) loadedAlignmentJSON.header = {};

  // Preserve existing group properties (pattern, color) by name
  const oldGroups = _getActiveFileGroups();
  const oldByName = {};
  oldGroups.forEach((g) => {
    oldByName[g.name] = g;
  });

  const waveformsRoot = document.getElementById("waveforms");
  const groups = [];
  Array.from(waveformsRoot.querySelectorAll(".file-group")).forEach((fg) => {
    const gname = fg.dataset.group || "Ungrouped";
    if (gname === "Score") return;
    const list = fg.querySelector(".group-list");
    const files = Array.from(list.querySelectorAll(".waveform"))
      .map((w) => w.dataset.ix)
      .filter(Boolean);
    const old = oldByName[gname] || {};
    const entry = { name: gname, files };
    if (old.pattern) entry.pattern = old.pattern;
    if (old.color) entry.color = old.color;
    groups.push(entry);
  });
  _setActiveFileGroups(groups);

  // Persist full group display order using data-group values
  const groupOrder = Array.from(
    waveformsRoot.querySelectorAll(".file-group"),
  ).map((fg) => fg.dataset.group || "Ungrouped");
  _setActiveGroupOrder(groupOrder);

  _changeCounter++;
  _updateDirtyState();
}

function _wireListSelectors() {
  document.querySelectorAll(".listSelectors .all").forEach((selector) =>
    selector.addEventListener("click", (e) => {
      e.target
        .closest("fieldset.audio-group")
        .querySelectorAll("input")
        .forEach((cb) => {
          if (!cb.checked) cb.click();
        });
    }),
  );
  document.querySelectorAll(".listSelectors .none").forEach((selector) =>
    selector.addEventListener("click", (e) => {
      e.target
        .closest("fieldset.audio-group")
        .querySelectorAll("input")
        .forEach((cb) => {
          if (cb.checked) cb.click();
        });
    }),
  );
}

// ---------------------------------------------------------------------------
// Group Files modal
// ---------------------------------------------------------------------------

/** Open the grouping modal. */
function _openGroupModal() {
  // Remove any existing modal
  document.getElementById("group-modal-backdrop")?.remove();

  const filenames = Object.keys(alignmentGrids)
    .filter((n) => n !== SYNTH_MEI_KEY)
    .sort();

  // Deep-clone all tabs for editing; modal edits this clone until Apply
  _migrateToGroupingTabs();
  const h = loadedAlignmentJSON?.header || {};
  let modalTabs = JSON.parse(
    JSON.stringify(
      h.groupingTabs || [{ name: "Default", fileGroups: [], groupOrder: [] }],
    ),
  );
  let modalActiveIdx = Math.max(
    0,
    modalTabs.findIndex((t) => t.name === (h.activeTab || "Default")),
  );

  /** Convenience: current modal tab's groups array */
  function groups() {
    return modalTabs[modalActiveIdx].fileGroups;
  }

  // --- Build modal DOM ---
  const backdrop = document.createElement("div");
  backdrop.id = "group-modal-backdrop";
  backdrop.className = "gm-backdrop";

  const modal = document.createElement("div");
  modal.className = "gm-modal";

  // Header
  const header = document.createElement("div");
  header.className = "gm-header";
  header.innerHTML = `<h3>Group Files</h3>`;
  const closeBtn = document.createElement("button");
  closeBtn.className = "gm-close";
  closeBtn.innerHTML = "\u2715";
  closeBtn.addEventListener("click", () => backdrop.remove());
  header.appendChild(closeBtn);
  modal.appendChild(header);

  // --- Tab bar ---
  const tabBar = document.createElement("div");
  tabBar.className = "gm-tab-bar";
  modal.appendChild(tabBar);

  // Body: two panes
  const body = document.createElement("div");
  body.className = "gm-body";

  // Left pane: ungrouped files
  const leftPane = document.createElement("div");
  leftPane.className = "gm-pane gm-left";
  leftPane.innerHTML = `<h4>Ungrouped Files</h4>`;
  const ungroupedList = document.createElement("ul");
  ungroupedList.className = "gm-file-list";
  ungroupedList.id = "gm-ungrouped";
  leftPane.appendChild(ungroupedList);
  body.appendChild(leftPane);

  // Right pane: groups
  const rightPane = document.createElement("div");
  rightPane.className = "gm-pane gm-right";
  const rightHeader = document.createElement("div");
  rightHeader.className = "gm-right-header";
  rightHeader.innerHTML = `<h4>Groups</h4>`;
  const addGroupBtn = document.createElement("button");
  addGroupBtn.className = "gm-add-group";
  addGroupBtn.textContent = "+ New Group";
  addGroupBtn.addEventListener("click", () => {
    groups().push({
      name: "New Group",
      pattern: "",
      files: [],
      color: _nextGroupColour(groups()),
    });
    renderGroups();
  });
  rightHeader.appendChild(addGroupBtn);
  rightPane.appendChild(rightHeader);

  const groupsContainer = document.createElement("div");
  groupsContainer.className = "gm-groups-container";
  groupsContainer.id = "gm-groups-container";
  rightPane.appendChild(groupsContainer);
  body.appendChild(rightPane);

  modal.appendChild(body);

  // Footer
  const footer = document.createElement("div");
  footer.className = "gm-footer";
  const cancelBtn = document.createElement("button");
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", () => backdrop.remove());
  const applyBtn = document.createElement("button");
  applyBtn.className = "gm-apply";
  applyBtn.textContent = "Apply";
  applyBtn.addEventListener("click", () => {
    // Write all tabs back to the alignment JSON header
    if (!loadedAlignmentJSON) loadedAlignmentJSON = {};
    if (!loadedAlignmentJSON.header) loadedAlignmentJSON.header = {};
    loadedAlignmentJSON.header.groupingTabs = modalTabs;
    // Keep activeTab unchanged (modal does not switch content pane live)
    // But ensure activeTab name still exists; if it was renamed/deleted, fall back
    const tabNames = new Set(modalTabs.map((t) => t.name));
    if (!tabNames.has(loadedAlignmentJSON.header.activeTab)) {
      loadedAlignmentJSON.header.activeTab = modalTabs[0].name;
    }
    _changeCounter++;
    _updateDirtyState();
    backdrop.remove();
    // Re-render sidebar + content pane + pills
    const fns = Object.keys(alignmentGrids)
      .filter((n) => n !== SYNTH_MEI_KEY)
      .sort();
    _renderSidebarFileList(fns);
    _renderGroupingTabPills();
    reloadWaveforms();
  });
  footer.appendChild(cancelBtn);
  footer.appendChild(applyBtn);
  modal.appendChild(footer);

  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  // Close on backdrop click
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) backdrop.remove();
  });

  // --- Tab bar rendering ---
  function renderTabBar() {
    tabBar.innerHTML = "";
    modalTabs.forEach((tab, idx) => {
      const tabEl = document.createElement("span");
      tabEl.className = "gm-tab" + (idx === modalActiveIdx ? " active" : "");

      const label = document.createElement("span");
      label.className = "gm-tab-label";
      label.textContent = tab.name;
      label.title = "Click to switch, double-click to rename";
      tabEl.appendChild(label);

      // Click to switch (skip re-render if already active, so dblclick can fire)
      tabEl.addEventListener("click", (e) => {
        if (e.target.classList.contains("gm-tab-close")) return;
        if (idx === modalActiveIdx) return;
        modalActiveIdx = idx;
        renderTabBar();
        renderAll();
      });

      // Double-click to rename (inline edit)
      label.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        const input = document.createElement("input");
        input.type = "text";
        input.className = "gm-tab-rename";
        input.value = tab.name;
        input.style.width = Math.max(60, label.offsetWidth + 10) + "px";
        label.replaceWith(input);
        input.focus();
        input.select();
        const commit = () => {
          const newName = input.value.trim();
          if (newName && newName !== tab.name) {
            tab.name = newName;
          }
          renderTabBar();
          renderAll();
        };
        input.addEventListener("blur", commit);
        input.addEventListener("keydown", (ke) => {
          if (ke.key === "Enter") {
            ke.preventDefault();
            input.blur();
          }
          if (ke.key === "Escape") {
            input.value = tab.name;
            input.blur();
          }
        });
      });

      // Delete button (not on the first tab)
      if (modalTabs.length > 1) {
        const del = document.createElement("span");
        del.className = "gm-tab-close";
        del.textContent = "\u2715";
        del.title = "Delete tab";
        del.addEventListener("click", (e) => {
          e.stopPropagation();
          const hasGroups = tab.fileGroups && tab.fileGroups.length > 0;
          if (
            hasGroups &&
            !confirm(
              `Delete tab "${tab.name}" and its ${tab.fileGroups.length} group(s)?`,
            )
          )
            return;
          if (!hasGroups && !confirm(`Delete tab "${tab.name}"?`)) return;
          modalTabs.splice(idx, 1);
          if (modalActiveIdx >= modalTabs.length)
            modalActiveIdx = modalTabs.length - 1;
          if (modalActiveIdx < 0) modalActiveIdx = 0;
          renderTabBar();
          renderAll();
        });
        tabEl.appendChild(del);
      }

      tabBar.appendChild(tabEl);
    });

    // "+" add tab button
    const addTab = document.createElement("span");
    addTab.className = "gm-tab gm-tab-add";
    addTab.textContent = "+";
    addTab.title = "Add new tab";
    addTab.addEventListener("click", () => {
      let n = modalTabs.length + 1;
      let name = `Tab ${n}`;
      while (modalTabs.some((t) => t.name === name)) {
        n++;
        name = `Tab ${n}`;
      }
      modalTabs.push({ name, fileGroups: [], groupOrder: [] });
      modalActiveIdx = modalTabs.length - 1;
      renderTabBar();
      renderAll();
    });
    tabBar.appendChild(addTab);
  }

  // --- Internal helpers to render the modal contents ---
  function shortName(f) {
    return f.substring(f.lastIndexOf("/") + 1);
  }

  /** Compute which files are claimed by any group (explicit + pattern). */
  function getGroupedSet() {
    const s = new Set();
    groups().forEach((g) => {
      (g.files || []).forEach((f) => s.add(f));
      if (g.pattern) {
        try {
          const re = new RegExp(g.pattern);
          filenames.forEach((f) => {
            if (re.test(shortName(f)) || re.test(f)) s.add(f);
          });
        } catch (_) {}
      }
    });
    return s;
  }

  function renderUngrouped() {
    ungroupedList.innerHTML = "";
    const grouped = getGroupedSet();
    const ug = filenames.filter((f) => !grouped.has(f));
    ug.forEach((f) => {
      const li = document.createElement("li");
      li.className = "gm-file-item";
      li.draggable = true;
      li.dataset.file = f;
      li.textContent = shortName(f);
      li.title = f;
      li.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData("text/plain", f);
        e.dataTransfer.effectAllowed = "move";
        li.classList.add("gm-dragging");
      });
      li.addEventListener("dragend", () => li.classList.remove("gm-dragging"));
      ungroupedList.appendChild(li);
    });
    if (ug.length === 0) {
      ungroupedList.innerHTML =
        '<li class="gm-empty">All files are grouped</li>';
    }
  }

  function renderGroups() {
    groupsContainer.innerHTML = "";
    const grps = groups();
    grps.forEach((g, i) => {
      const card = document.createElement("div");
      card.className = "gm-group-card";

      // Group header: name input + controls
      const gh = document.createElement("div");
      gh.className = "gm-group-header";

      const nameInput = document.createElement("input");
      nameInput.type = "text";
      nameInput.className = "gm-group-name";
      nameInput.value = g.name;
      nameInput.addEventListener("input", (e) => {
        g.name = e.target.value;
      });
      gh.appendChild(nameInput);

      // Move up
      if (i > 0) {
        const upBtn = document.createElement("button");
        upBtn.className = "gm-icon-btn";
        upBtn.title = "Move up";
        upBtn.textContent = "\u25B2";
        upBtn.addEventListener("click", () => {
          [grps[i - 1], grps[i]] = [grps[i], grps[i - 1]];
          renderAll();
        });
        gh.appendChild(upBtn);
      }
      // Move down
      if (i < grps.length - 1) {
        const downBtn = document.createElement("button");
        downBtn.className = "gm-icon-btn";
        downBtn.title = "Move down";
        downBtn.textContent = "\u25BC";
        downBtn.addEventListener("click", () => {
          [grps[i], grps[i + 1]] = [grps[i + 1], grps[i]];
          renderAll();
        });
        gh.appendChild(downBtn);
      }
      // Delete
      const delBtn = document.createElement("button");
      delBtn.className = "gm-icon-btn gm-delete";
      delBtn.title = "Delete group";
      delBtn.textContent = "\u2715";
      delBtn.addEventListener("click", () => {
        grps.splice(i, 1);
        renderAll();
      });
      gh.appendChild(delBtn);
      card.appendChild(gh);

      // Regex pattern input
      const patRow = document.createElement("div");
      patRow.className = "gm-pattern-row";
      const patLabel = document.createElement("label");
      patLabel.textContent = "Regex:";
      const patInput = document.createElement("input");
      patInput.type = "text";
      patInput.className = "gm-pattern-input";
      patInput.placeholder = "e.g. ^VPO-";
      patInput.value = g.pattern || "";
      patInput.addEventListener("input", (e) => {
        g.pattern = e.target.value;
        const cursorPos = e.target.selectionStart;
        renderAll();
        // Restore focus to the same regex input after re-render
        const restored =
          groupsContainer.querySelectorAll(".gm-pattern-input")[i];
        if (restored) {
          restored.focus();
          restored.setSelectionRange(cursorPos, cursorPos);
        }
      });
      patRow.appendChild(patLabel);
      patRow.appendChild(patInput);
      card.appendChild(patRow);

      // Colour picker row
      const colourRow = document.createElement("div");
      colourRow.className = "gm-colour-row";
      const colourLabel = document.createElement("label");
      colourLabel.textContent = "Colour:";
      // Palette swatches
      const swatchContainer = document.createElement("span");
      swatchContainer.className = "gm-swatch-container";
      _GROUP_PALETTE.forEach((c) => {
        const swatch = document.createElement("span");
        swatch.className = "gm-swatch";
        if (g.color === c) swatch.classList.add("gm-swatch-selected");
        swatch.style.backgroundColor = c;
        swatch.title = c;
        swatch.addEventListener("click", () => {
          g.color = c;
          renderGroups();
        });
        swatchContainer.appendChild(swatch);
      });
      // Custom colour input
      const colourInput = document.createElement("input");
      colourInput.type = "color";
      colourInput.className = "gm-colour-input";
      colourInput.value = g.color || _nextGroupColour(grps);
      colourInput.title = "Choose a custom colour";
      colourInput.addEventListener("input", (e) => {
        g.color = e.target.value;
        renderGroups();
      });
      // Clear button
      const clearBtn = document.createElement("button");
      clearBtn.className = "gm-icon-btn gm-colour-clear";
      clearBtn.title = "Remove colour";
      clearBtn.textContent = "\u2715";
      clearBtn.addEventListener("click", () => {
        g.color = "";
        renderGroups();
      });
      colourRow.appendChild(colourLabel);
      colourRow.appendChild(swatchContainer);
      colourRow.appendChild(colourInput);
      colourRow.appendChild(clearBtn);
      card.appendChild(colourRow);

      // Apply colour preview to card
      if (g.color) {
        card.style.backgroundColor = g.color;
      }

      // File list (explicit + regex-matched)
      const fileUl = document.createElement("ul");
      fileUl.className = "gm-group-files";

      // Compute effective members
      const members = new Set(g.files || []);
      if (g.pattern) {
        try {
          const re = new RegExp(g.pattern);
          filenames.forEach((f) => {
            if (re.test(shortName(f)) || re.test(f)) members.add(f);
          });
        } catch (_) {}
      }
      const memberArr = [...members]
        .filter((f) => filenames.includes(f))
        .sort();
      memberArr.forEach((f) => {
        const li = document.createElement("li");
        li.className = "gm-file-item gm-grouped";
        li.textContent = shortName(f);
        li.title = f;
        // Remove button (only for explicitly added files, not regex)
        const isExplicit = (g.files || []).includes(f);
        if (isExplicit) {
          const rmBtn = document.createElement("button");
          rmBtn.className = "gm-remove-file";
          rmBtn.textContent = "\u2715";
          rmBtn.title = "Remove from group";
          rmBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            g.files = (g.files || []).filter((x) => x !== f);
            renderAll();
          });
          li.appendChild(rmBtn);
        } else {
          // Matched by regex — show indicator
          const tag = document.createElement("span");
          tag.className = "gm-regex-tag";
          tag.textContent = "(regex)";
          li.appendChild(tag);
        }
        fileUl.appendChild(li);
      });
      if (memberArr.length === 0) {
        fileUl.innerHTML =
          '<li class="gm-empty">Drag files here or set a regex</li>';
      }

      // Drop zone
      card.addEventListener("dragover", (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        card.classList.add("gm-drop-target");
      });
      card.addEventListener("dragleave", () =>
        card.classList.remove("gm-drop-target"),
      );
      card.addEventListener("drop", (e) => {
        e.preventDefault();
        card.classList.remove("gm-drop-target");
        const file = e.dataTransfer.getData("text/plain");
        if (file && filenames.includes(file)) {
          // Remove from any other group's explicit list
          grps.forEach((og) => {
            og.files = (og.files || []).filter((x) => x !== file);
          });
          if (!g.files) g.files = [];
          if (!g.files.includes(file)) g.files.push(file);
          renderAll();
        }
      });

      card.appendChild(fileUl);
      groupsContainer.appendChild(card);
    });

    if (grps.length === 0) {
      groupsContainer.innerHTML = `<p class="gm-empty">No groups yet. Click <strong>+ New Group</strong> to create one.</p>`;
    }
  }

  function renderAll() {
    renderUngrouped();
    renderGroups();
  }

  renderTabBar();
  renderAll();
}

// ---------------------------------------------------------------------------
// Audio normalization helpers (Web Audio GainNode)
// ---------------------------------------------------------------------------

/** Lazily create the shared AudioContext (must happen after a user gesture). */
function _getNormAudioCtx() {
  if (!_normAudioCtx) {
    _normAudioCtx = new AudioContext();
  }
  return _normAudioCtx;
}

/** Compute the peak amplitude of decoded audio data (0..1). */
function _computePeak(decodedData) {
  let peak = 0;
  for (let ch = 0; ch < decodedData.numberOfChannels; ch++) {
    const chan = decodedData.getChannelData(ch);
    for (let i = 0; i < chan.length; i++) {
      const abs = Math.abs(chan[i]);
      if (abs > peak) peak = abs;
    }
  }
  return peak;
}

/**
 * Set up a GainNode for a waveform after it signals "ready".
 * Routes: <audio> → MediaElementSourceNode → GainNode → destination.
 */
function _setupNormGainNode(filename) {
  const ws = wavesurfers[filename];
  if (!ws) return;
  const mediaEl = ws.getMediaElement();
  // MediaElementAudioSourceNode can only be created once per <audio> element.
  // If already connected (shouldn't happen), skip.
  if (_normSourceNodes[filename]) return;
  const ctx = _getNormAudioCtx();
  const source = ctx.createMediaElementSource(mediaEl);
  const gain = ctx.createGain();
  source.connect(gain);
  gain.connect(ctx.destination);
  _normSourceNodes[filename] = source;
  _normGainNodes[filename] = gain;
  // Compute and cache peak amplitude from the decoded audio buffer
  const decoded = ws.getDecodedData();
  if (decoded) {
    _normPeaks[filename] = _computePeak(decoded);
  }
  // Apply current normalize state
  if (document.getElementById("normalize").checked) {
    const peak = _normPeaks[filename] || 1;
    gain.gain.value = peak > 0 ? 1 / peak : 1;
  }
}

/** Disconnect and clean up the GainNode for a waveform being destroyed. */
function _teardownNormGainNode(filename) {
  if (_normSourceNodes[filename]) {
    _normSourceNodes[filename].disconnect();
    delete _normSourceNodes[filename];
  }
  if (_normGainNodes[filename]) {
    _normGainNodes[filename].disconnect();
    delete _normGainNodes[filename];
  }
  delete _normPeaks[filename];
}

/** Apply or remove normalization gain across all waveforms. */
function _applyNormGain(normalize) {
  for (const [filename, gain] of Object.entries(_normGainNodes)) {
    if (normalize) {
      const peak = _normPeaks[filename] || 1;
      gain.gain.value = peak > 0 ? 1 / peak : 1;
    } else {
      gain.gain.value = 1;
    }
  }
}

function reloadWaveforms() {
  let playPosition = 0;
  let isPlaying = false;
  const prevLoaded = Object.keys(wavesurfers);
  if (currentAudioIx) {
    playPosition = wavesurfers[currentAudioIx].getCurrentTime();
    isPlaying = wavesurfers[currentAudioIx].isPlaying();
  }
  // get current play position of active wavesurfer
  // destroy current wavesurfers
  prevLoaded.forEach((ws) => {
    wavesurfers[ws].destroy();
    delete _regionsPlugins[ws];
    delete _timerRegions[ws];
    _teardownNormGainNode(ws);
  });
  wavesurfers = {};
  // forget waveform elements (and spectorgrams)
  document.getElementById("waveforms").replaceChildren();
  // re-create previously loaded waveforms
  prevLoaded.forEach((ws) => prepareWaveform(ws, playPosition, isPlaying));
}

function visualiseAlignments() {
  // go through all wavesurfers, throw out user-defined markers, and instead draw in alignment positions as markers
  Object.keys(wavesurfers).forEach((ws) => {
    _clearMarkers(ws);
    alignmentGrids[ws].forEach((t) => {
      _addMarker(ws, { time: t, color: "red" });
    });
  });
}

function prepareWaveform(filename, playPosition = 0, isPlaying = false) {
  console.log(
    "preparing waveform, currently annotated regions:",
    currentlyAnnotatedRegions,
  );
  // if not yet created, do so:
  if (!(filename in wavesurfers)) {
    const waveform = document.createElement("div");
    waveform.id = "waveform-" + filename + "-wav";
    waveform.dataset.ix = filename;
    waveform.classList.add("waveform");

    // Full-coverage selection overlay (hidden by default, shown during selection mode)
    const selectOverlay = document.createElement("div");
    selectOverlay.className = "wf-select-overlay";
    selectOverlay.innerHTML = `<img src="${root}svg/RDF-logo.svg" class="wf-overlay-icon" alt="RDF" />`;
    selectOverlay.addEventListener("click", (e) => {
      e.stopPropagation();
      // Route to whichever selection mode is active (both no-op if inactive)
      toggleStagedSelection(filename);
      toggleDraftStagedSelection(filename);
    });
    waveform.appendChild(selectOverlay);

    // Ensure group containers exist and append into the appropriate group-list
    const allFilenames = Object.keys(alignmentGrids || {})
      .filter((n) => n !== SYNTH_MEI_KEY)
      .sort();
    _ensureWaveformGroupContainers(allFilenames.concat(SYNTH_MEI_KEY));
    const waveformsRoot = document.getElementById("waveforms");
    // determine which group this filename belongs to (match by header.fileGroups or local groups)
    // Score waveform goes into the Score group container
    let parentList = null;
    let placed = false;
    if (filename === SYNTH_MEI_KEY) {
      parentList = waveformsRoot.querySelector(".file-group-score .group-list");
      if (parentList) placed = true;
    }
    if (!parentList) {
      parentList = waveformsRoot.querySelector(
        ".file-group-ungrouped .group-list",
      );
    }
    const groups = loadedAlignmentJSON ? _getActiveFileGroups() : [];
    for (const g of groups) {
      const members = new Set(g.files || []);
      if (members.has(filename)) {
        const fg = waveformsRoot.querySelector(
          `.file-group[data-group='${CSS.escape(g.name)}']`,
        );
        if (fg) {
          parentList = fg.querySelector(".group-list");
          placed = true;
          break;
        }
      } else if (g.pattern) {
        try {
          const re = new RegExp(g.pattern);
          const short = filename.substring(filename.lastIndexOf("/") + 1);
          if (re.test(short) || re.test(filename)) {
            const fg = waveformsRoot.querySelector(
              `.file-group[data-group='${CSS.escape(g.name)}']`,
            );
            if (fg) {
              parentList = fg.querySelector(".group-list");
              placed = true;
              break;
            }
          }
        } catch (_) {}
      }
    }
    if (!placed) {
      // Leave in ungrouped container (or append to root if none)
      parentList = parentList || waveformsRoot;
    }

    // add waveform element
    parentList.appendChild(waveform);

    // Add small drag handle and enable dragging
    const handle = document.createElement("div");
    handle.className = "wf-drag-handle";
    waveform.appendChild(handle);
    waveform.draggable = true;
    waveform.addEventListener("dragstart", (ev) => {
      ev.dataTransfer.setData("text/plain", filename);
      ev.currentTarget.classList.add("dragging");
    });
    waveform.addEventListener("dragend", (ev) => {
      ev.currentTarget.classList.remove("dragging");
    });
    // now resort waveforms to maintain order:
    // 1. Score (synthesised from MEI) first
    // 2. VPO recordings sorted alphabetically
    // 3. Other recordings sorted alphabetically
    const allWfChildren = [...waveforms.children];
    const isScore = (n) => n.dataset.ix === SYNTH_MEI_KEY;
    const isVPO = (n) =>
      !isScore(n) && n.id.substr(n.id.lastIndexOf("/") + 1).startsWith("VPO-");
    const score = allWfChildren.filter(isScore);
    const vpo = allWfChildren.filter(isVPO);
    const other = allWfChildren.filter((n) => !isScore(n) && !isVPO(n));
    score.forEach((node) => waveforms.appendChild(node));
    vpo
      .sort((a, b) => (a.id > b.id ? 1 : -1))
      .forEach((node) => waveforms.appendChild(node));
    other
      .sort((a, b) => (a.id > b.id ? 1 : -1))
      .forEach((node) => waveforms.appendChild(node));
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
    _regionsPlugins[filename] = _regPlugin;
    let regions = extractCurrentlyAnnotatedRegions(filename);
    wavesurfers[filename] = WaveSurfer.create({
      container: `#${CSS.escape("waveform-" + filename) + "-wav"}`,
      waveColor: "violet",
      progressColor: "purple",
      normalize: document.getElementById("normalize").checked,
      fetchParams: xhrOptionsForUrl(resolveAudioUrl(filename)),
      plugins: [_regPlugin, _hoverPlugin],
      autoScroll: false, // managed by our zoom scroll logic
      autoCenter: false, // managed by our zoom scroll logic
    });

    // Handle region adjustments (Phase 4 groundwork)
    _regPlugin.on("region-updated", (region) => {
      onRegionUpdated(filename, region);
    });

    // Handle new regions drawn by user (draft annotation mode)
    _regPlugin.on("region-created", (region) => {
      // Only handle user-drawn regions (drag selection creates these)
      // Programmatic regions (timer, anno_, draft_) are added via addRegion
      if (
        region.id !== "timer" &&
        !region.id.startsWith("anno_region_") &&
        !region.id.startsWith("draft_")
      ) {
        onDraftRegionCreated(filename, region);
      }
    });

    // Add timer region and any annotated regions to the shared RegionsPlugin
    _timerRegions[filename] = _regPlugin.addRegion({
      id: "timer",
      start: 0,
      end: 0,
      drag: false,
      resize: false, // timer shouldn't be resized
      color: "rgba(255, 0, 100, 0.3)",
    });
    regions.forEach((r) => _regPlugin.addRegion(r));

    // Start loading (deferred for synth entries until the blob URL is available)
    const wfEl = document.querySelector(`.waveform[data-ix='${filename}']`);
    const _audioUrl = resolveAudioUrl(filename);
    // Prefer passing the Blob directly to WaveSurfer to avoid cross-origin
    // issues that some browsers (Firefox) have with blob: URLs via fetch().
    const _audioBlob = fileBlobs.get(filename);
    if (_audioBlob || _audioUrl) {
      // If pre-computed peaks are available, pass them to load() so WaveSurfer
      // can render the waveform shape immediately (before full audio decode).
      const _peakInfo = _waveformPeaks[filename];
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
      if (err && err.message && err.message.includes("401")) {
        const url = resolveAudioUrl(filename);
        const origin = getOrigin(url);
        if (promptForAuth(url)) {
          reloadWaveformsForOrigin(origin);
        }
      }
    });
    function updatePositionIndicator() {
      // work out current alignment grid index via binary search
      const grid = alignmentGrids[filename];
      const currentTime = wavesurfers[filename].getCurrentTime();
      let lo = 0,
        hi = grid.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (grid[mid] <= currentTime) lo = mid + 1;
        else hi = mid;
      }
      let currentGridIx = Math.max(0, lo - 1);
      if (currentGridIx <= 0 && currentTime > grid[grid.length - 1]) {
        currentGridIx = grid.length - 1;
      }
      // iterate through all positionIndicatorCanvases, drawing in current ix position
      const canvases = document.getElementsByClassName("position-indicator");
      const visrelalign = document.getElementById("visrelalign").checked;
      Array.from(canvases).forEach((c) => {
        const file =
          c.closest(".wf-overlays")?.parentElement?.dataset["ix"] ||
          c.closest(".waveform")?.dataset["ix"];
        if (!file || !wavesurfers[file]) return;
        const ctx = c.getContext("2d");
        const duration = wavesurfers[file].getDuration();
        const fullW = _getZoomedWidth(file);
        const scrollLeft = wavesurfers[file].getScroll();
        ctx.clearRect(0, 0, c.width, c.height);
        if (!visrelalign) return;

        if (file === filename) {
          // Playing waveform: simple vertical line at current playback position
          const x = (currentTime / duration) * fullW - scrollLeft;
          ctx.beginPath();
          ctx.lineWidth = 2;
          ctx.strokeStyle = "rgba(100, 100, 200, 0.7)";
          ctx.moveTo(x, 0);
          ctx.lineTo(x, c.height);
          ctx.stroke();
        } else {
          // Non-playing waveform: vertical section at the corresponding
          // aligned position, with slanted top/bottom pointing toward
          // the playing waveform's indicator position (so all slant tips
          // form a continuous vertical line across stacked waveforms).
          const correspondingSeconds = alignmentGrids[file][currentGridIx];
          const alignedX =
            (correspondingSeconds / duration) * fullW - scrollLeft;
          // playingX: project the playing file's absolute time onto this
          // file's time axis, so the slant shows the temporal offset
          // between the playing file's clock time and the aligned position.
          const playingX = (currentTime / duration) * fullW - scrollLeft;
          const diffMapped = Math.floor((255 * (playingX - alignedX)) / 100);
          ctx.beginPath();
          ctx.lineWidth = 2;
          ctx.moveTo(playingX, 0);
          ctx.lineTo(alignedX, c.height / 6);
          ctx.lineTo(alignedX, 5 * (c.height / 6));
          ctx.lineTo(playingX, c.height);
          ctx.strokeStyle =
            diffMapped < 0
              ? `rgb(${-1 * diffMapped} 100 100)`
              : `rgb(100 100 ${diffMapped})`;
          ctx.stroke();
        }
      });
    }
    wavesurfers[filename].on("interaction", () => {
      updatePositionIndicator();
    });
    wavesurfers[filename].on("ready", () => {
      // Wire up Web Audio GainNode for volume normalization
      _setupNormGainNode(filename);
      // signal file is ready in filename list
      loaded.add(filename);
      _updateGroupCounts();
      console.log("READY:...", filename);
      // In WaveSurfer v7 the canvas lives inside a shadow root; we cannot
      // query it from outside.  Size our overlay canvases to the container
      // and keep them in sync via the "redrawcomplete" event.
      const WAVE_HEIGHT = wavesurfers[filename].options.height || 128;
      const readyWfContainer = document.querySelector(
        `.waveform[data-ix='${filename}']`,
      );

      // --- Overlay wrapper structure ---
      // Canvases sit on .wf-overlays (viewport-sized, no transform).
      // Markers sit on .wf-overlays-inner (full zoom width, translateX'd).
      const ow = _createOverlayWrapper(readyWfContainer, WAVE_HEIGHT);
      _overlayWrappers[filename] = ow;

      const gridCanvas = document.createElement("canvas");
      const gridStyle = gridCanvas.style;
      const positionIndicatorCanvas = document.createElement("canvas");
      const positionIndicatorStyle = positionIndicatorCanvas.style;
      gridCanvas.classList.add("alignment-grid");
      gridCanvas.width = readyWfContainer.clientWidth;
      gridCanvas.height = WAVE_HEIGHT;
      gridStyle.pointerEvents = "none";
      positionIndicatorCanvas.classList.add("position-indicator");
      positionIndicatorCanvas.width = readyWfContainer.clientWidth;
      positionIndicatorCanvas.height = WAVE_HEIGHT;
      positionIndicatorStyle.pointerEvents = "none";
      // Tempo curve canvas (viewport-sized, between grid and position indicator)
      const tempoCanvas = document.createElement("canvas");
      tempoCanvas.classList.add("tempo-curve");
      tempoCanvas.width = readyWfContainer.clientWidth;
      tempoCanvas.height = WAVE_HEIGHT;
      tempoCanvas.style.pointerEvents = "none";

      // Canvases go on the wrapper (viewport-fixed, not transformed)
      ow.wrapper.insertBefore(positionIndicatorCanvas, ow.inner);
      ow.wrapper.insertBefore(tempoCanvas, positionIndicatorCanvas);
      ow.wrapper.insertBefore(gridCanvas, tempoCanvas);

      // Function to draw (or redraw) the alignment grid and time ticks.
      // At zoom, draws only the visible viewport portion offset by scroll.
      function drawAlignmentGrid() {
        if (!readyWfContainer || !readyWfContainer.isConnected) return;
        const viewW = readyWfContainer.clientWidth;
        const h = wavesurfers[filename].options.height || 128;
        gridCanvas.width = viewW;
        gridCanvas.height = h;
        positionIndicatorCanvas.width = viewW;
        positionIndicatorCanvas.height = h;
        // Update overlay wrapper height
        ow.wrapper.style.height = h + "px";
        // Update inner wrapper width to match zoomed waveform width
        const fullW = _getZoomedWidth(filename);
        ow.inner.style.width = fullW + "px";

        const ctx = gridCanvas.getContext("2d");
        ctx.clearRect(0, 0, viewW, h);
        const dur = wavesurfers[filename].getDuration();
        const scrollLeft = wavesurfers[filename].getScroll();

        // Draw alignment grid lines first (so time ticks render on top)
        const visalignEl = document.getElementById("visalign");
        if (visalignEl && visalignEl.checked) {
          const grid = alignmentGrids[filename];
          const gridLen = grid.length;
          if (gridLen > 0) {
            ctx.lineWidth = 1;
            const minPixelStep = 4;
            const pxPerIdx = fullW / gridLen;

            // Compute a deterministic stride so the same grid indices are
            // selected on every frame regardless of scroll position.  This
            // prevents flickering caused by different indices passing a
            // distance filter as scrollLeft changes between frames.
            const stride = Math.max(1, Math.round(minPixelStep / pxPerIdx));

            // Visible range of grid indices (with margin for angled lines)
            const margin = 10;
            // Align loIdx to stride boundary so selection is scroll-independent
            let loIdx = Math.max(
              0,
              Math.floor(((scrollLeft - margin) / fullW) * gridLen),
            );
            loIdx = loIdx - (loIdx % stride); // snap down to stride boundary
            let hiIdx = Math.min(
              gridLen - 1,
              Math.ceil(((scrollLeft + viewW + margin) / fullW) * gridLen),
            );

            // Draw solid lines for the top and bottom sections
            ctx.beginPath();
            ctx.setLineDash([]);
            ctx.strokeStyle = "rgba(140, 90, 90, 0.55)";
            for (let gridIx = loIdx; gridIx <= hiIdx; gridIx += stride) {
              const absoluteX = gridIx * pxPerIdx - scrollLeft;
              const relativeX = (grid[gridIx] / dur) * fullW - scrollLeft;
              ctx.moveTo(absoluteX, 0);
              ctx.lineTo(relativeX, h / 6);
              ctx.moveTo(relativeX, 5 * (h / 6));
              ctx.lineTo(absoluteX, h);
            }
            ctx.stroke();

            // Draw sparsely dotted lines over the waveform section
            ctx.beginPath();
            ctx.strokeStyle = "rgba(140, 90, 90, 0.3)";
            ctx.setLineDash([2, 1]);
            for (let gridIx = loIdx; gridIx <= hiIdx; gridIx += stride) {
              const relativeX = (grid[gridIx] / dur) * fullW - scrollLeft;
              if (relativeX > viewW + margin || relativeX < -margin) continue;
              ctx.moveTo(relativeX, h / 6);
              ctx.lineTo(relativeX, 5 * (h / 6));
            }
            ctx.stroke();
            ctx.setLineDash([]);
          }
        }

        // Draw time ticks
        const tickBg = _wfBgCache[filename] || _refreshWfBg(filename);
        _drawTimeTicks(ctx, viewW, h, fullW, dur, scrollLeft, tickBg);

        // Draw tempo curve
        drawTempoCurve();
      }

      // --- Tempo curve drawing ---
      function drawTempoCurve() {
        if (!readyWfContainer || !readyWfContainer.isConnected) return;
        const viewW = readyWfContainer.clientWidth;
        const h = wavesurfers[filename].options.height || 128;
        tempoCanvas.width = viewW;
        tempoCanvas.height = h;

        if (!_tempoCurveVisible || filename === SYNTH_MEI_KEY) return;
        const raw = _getRawTempo(filename);
        if (!raw.length) return;

        // Ensure Y-range is computed
        if (!_tempoYRange) _recomputeTempoYRange();
        if (!_tempoYRange) return;

        const smoothed = _smoothTempo(raw, _tempoCurveSmoothing);
        const dur = wavesurfers[filename].getDuration();
        const fullW = _getZoomedWidth(filename);
        const scrollLeft = wavesurfers[filename].getScroll();
        const ctx = tempoCanvas.getContext("2d");

        // In relative mode, compute per-file deviation from scope-based corpus mean
        let corpusMean = null;
        if (_tempoCurveMode === "relative") {
          const scopeFiles = _getTempoScopeFiles(filename);
          corpusMean = _computeCorpusMeanTempo(
            scopeFiles,
            _tempoCurveSmoothing,
          );
        }

        // Map tempo value to Y coordinate (top = high, bottom = low)
        // Use middle 70% of canvas height (leave room for grid and ticks)
        const yTop = h * 0.1;
        const yBot = h * 0.85;
        const yRange = _tempoYRange.max - _tempoYRange.min;
        function valToY(val) {
          if (yRange <= 0) return (yTop + yBot) / 2;
          const frac = (val - _tempoYRange.min) / yRange;
          return yBot - frac * (yBot - yTop); // inverted: high values at top
        }

        // Build screen-space points, tracking which are clipped
        const pts = [];
        for (let i = 0; i < smoothed.length; i++) {
          const x = (smoothed[i].time / dur) * fullW - scrollLeft;
          let val = smoothed[i].tempo;
          if (_tempoCurveMode === "relative" && corpusMean) {
            const key = Math.round(smoothed[i].scoreTime * 1e6) / 1e6;
            const ref = corpusMean.get(key);
            val = ref && ref > 0 ? ((smoothed[i].tempo - ref) / ref) * 100 : 0;
          }
          // Track clipping direction: -1 = below, +1 = above, 0 = within range
          let clipped = 0;
          if (val > _tempoYRange.max) clipped = 1;
          else if (val < _tempoYRange.min) clipped = -1;
          val = Math.max(_tempoYRange.min, Math.min(_tempoYRange.max, val));
          pts.push({ x, y: valToY(val), clipped });
        }

        // Cull to viewport with one-point margin on each side
        let startIdx = 0,
          endIdx = pts.length - 1;
        while (startIdx < pts.length - 1 && pts[startIdx + 1].x < -10)
          startIdx++;
        while (endIdx > 0 && pts[endIdx - 1].x > viewW + 10) endIdx--;
        if (startIdx > 0) startIdx--;
        if (endIdx < pts.length - 1) endIdx++;

        if (startIdx >= endIdx) return;

        // Draw shaded area under curve
        const zeroY = _tempoCurveMode === "relative" ? valToY(0) : yBot;
        ctx.beginPath();
        ctx.moveTo(pts[startIdx].x, zeroY);
        for (let i = startIdx; i <= endIdx; i++) ctx.lineTo(pts[i].x, pts[i].y);
        ctx.lineTo(pts[endIdx].x, zeroY);
        ctx.closePath();
        ctx.fillStyle =
          _tempoCurveMode === "relative"
            ? "rgba(70, 130, 180, 0.12)"
            : "rgba(70, 130, 180, 0.15)";
        ctx.fill();

        // Draw the curve line
        ctx.beginPath();
        ctx.moveTo(pts[startIdx].x, pts[startIdx].y);
        for (let i = startIdx + 1; i <= endIdx; i++)
          ctx.lineTo(pts[i].x, pts[i].y);
        ctx.strokeStyle = "rgba(30, 80, 140, 0.7)";
        ctx.lineWidth = 1.5;
        ctx.stroke();

        // In relative mode, draw zero line
        if (_tempoCurveMode === "relative") {
          ctx.beginPath();
          ctx.moveTo(0, zeroY);
          ctx.lineTo(viewW, zeroY);
          ctx.strokeStyle = "rgba(30, 80, 140, 0.3)";
          ctx.lineWidth = 1;
          ctx.setLineDash([4, 3]);
          ctx.stroke();
          ctx.setLineDash([]);
        }

        // --- Y-axis labels ---
        const yAxisNiceSteps =
          _tempoCurveMode === "relative"
            ? [1, 2, 5, 10, 20, 25, 50, 100]
            : [5, 10, 20, 25, 50, 100, 200, 500];
        const targetTicks = 4;
        const rawStep = yRange / targetTicks;
        let yStep = yAxisNiceSteps[yAxisNiceSteps.length - 1];
        for (const s of yAxisNiceSteps) {
          if (s >= rawStep) {
            yStep = s;
            break;
          }
        }
        ctx.font = "9px sans-serif";
        ctx.textBaseline = "middle";
        ctx.textAlign = "left";
        // Start from a round number at or above yRange min
        const firstTick = Math.ceil(_tempoYRange.min / yStep) * yStep;
        for (let v = firstTick; v <= _tempoYRange.max; v += yStep) {
          const y = valToY(v);
          if (y < 2 || y > h - 2) continue;
          // Tick line
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(4, y);
          ctx.strokeStyle = "rgba(30, 80, 140, 0.5)";
          ctx.lineWidth = 1;
          ctx.stroke();
          // Label
          let tickLabel;
          if (_tempoCurveMode === "relative") {
            tickLabel = (v >= 0 ? "+" : "") + v + "%";
          } else {
            tickLabel = String(Math.round(v));
          }
          ctx.fillStyle = "rgba(30, 80, 140, 0.7)";
          ctx.fillText(tickLabel, 5, y);
        }
        // Unit label at top
        ctx.fillStyle = "rgba(30, 80, 140, 0.5)";
        ctx.font = "8px sans-serif";
        ctx.textBaseline = "bottom";
        ctx.fillText(
          _tempoCurveMode === "relative" ? "% avg." : "QPM",
          5,
          yTop - 1,
        );

        // --- Clipped-value indicators (small triangles at top/bottom edge) ---
        ctx.fillStyle = "rgba(180, 60, 60, 0.6)";
        const triH = 5,
          triW = 4;
        for (let i = startIdx; i <= endIdx; i++) {
          if (!pts[i].clipped) continue;
          const px = pts[i].x;
          if (px < -triW || px > viewW + triW) continue;
          ctx.beginPath();
          if (pts[i].clipped > 0) {
            // Arrow pointing up at top edge
            ctx.moveTo(px, yTop);
            ctx.lineTo(px - triW, yTop + triH);
            ctx.lineTo(px + triW, yTop + triH);
          } else {
            // Arrow pointing down at bottom edge
            ctx.moveTo(px, yBot);
            ctx.lineTo(px - triW, yBot - triH);
            ctx.lineTo(px + triW, yBot - triH);
          }
          ctx.closePath();
          ctx.fill();
        }
      }

      // Register this waveform's position-updater so it can be called
      // after resize (the updater reads currentTime from this file's wavesurfer
      // and repaints every position-indicator canvas).
      _positionUpdaters[filename] = updatePositionIndicator;
      _gridRedrawers[filename] = drawAlignmentGrid;
      _tempoCurveRedrawers[filename] = drawTempoCurve;

      // --- Alignment correction overlay canvas ---
      const corrCanvas = document.createElement("canvas");
      corrCanvas.classList.add("align-correction-overlay");
      corrCanvas.width = readyWfContainer.clientWidth;
      corrCanvas.height = WAVE_HEIGHT;
      corrCanvas.draggable = false; // prevent native browser drag
      const corrStyle = corrCanvas.style;
      corrStyle.pointerEvents =
        _alignCorrectionMode && !_drawModeActive ? "auto" : "none";
      // Correction canvas goes on the wrapper (viewport-fixed)
      ow.wrapper.insertBefore(corrCanvas, ow.inner);

      // Store reference for resize
      const _corrCanvasRef = corrCanvas;

      // Wire scroll listener on WaveSurfer's shadow-DOM scroll container
      const _wsScrollContainer = _getScrollContainer(filename);
      let _scrollRedrawRaf = false;
      if (_wsScrollContainer) {
        _wsScrollContainer.addEventListener("scroll", () => {
          _syncOverlayScroll(filename);
          // Redraw viewport-based canvases (throttled)
          if (!_scrollRedrawRaf) {
            _scrollRedrawRaf = true;
            requestAnimationFrame(() => {
              _scrollRedrawRaf = false;
              drawAlignmentGrid();
              if (currentAudioIx && _positionUpdaters[currentAudioIx]) {
                _positionUpdaters[currentAudioIx]();
              }
              // Cross-waveform scroll sync
              if (!_scrollSyncLock && _currentZoomLevel > 1) {
                _scrollSyncLock = true;
                _syncAllWaveformScrolls(filename);
                requestAnimationFrame(() => {
                  _scrollSyncLock = false;
                });
              }
            });
          }
        });
      }

      // Apply current zoom level if waveform loads after zoom has been set
      if (_currentZoomLevel > 1) {
        const containerWidth = readyWfContainer.clientWidth;
        const duration = wavesurfers[filename].getDuration();
        wavesurfers[filename].zoom(
          (_currentZoomLevel * containerWidth) / duration,
        );
      }
      // Always sync scroll mode on ready — browser may have restored the
      // "follow" radio before wavesurfers exist, so the pageshow handler
      // couldn't apply it.  _applyScrollMode checks zoom level internally.
      _applyScrollMode(filename);

      // Initial draw
      drawAlignmentGrid();

      // Hide the initial-load overlay
      const readyWfEl = document.querySelector(
        `.waveform[data-ix='${filename}']`,
      );
      if (readyWfEl) hideWaveformOverlay(readyWfEl);

      // "redrawcomplete" fires after each WaveSurfer render cycle — both on the
      // initial load and on any automatic resize triggered by its ResizeObserver.
      wavesurfers[filename].on("redrawcomplete", () => {
        // Resize our overlay canvases and repaint grid lines.
        drawAlignmentGrid();
        // Resize correction overlay (viewport-sized)
        if (_corrCanvasRef && readyWfContainer.isConnected) {
          _corrCanvasRef.width = readyWfContainer.clientWidth;
          _corrCanvasRef.height = wavesurfers[filename].options.height || 128;
        }
        // Sync overlay scroll position after redraw
        _syncOverlayScroll(filename);
        // Restore markers (canvas has been redrawn, marker positions must refresh).
        _clearMarkers(filename);
        _ensureWfLabel(filename);
        markers.forEach((m, i) => {
          const t = getCorrespondingTime(filename, m);
          const color =
            closeListeningMode && activeMarkerIx === i ? "#8b0000" : "red";
          _addMarker(filename, { time: t, color, alignIx: m });
        });

        // Reveal this waveform once its canvas, alignment grid, and position
        // indicator are all correctly sized and painted — but only if audio
        // has actually finished loading (not during synthesis).
        const wfEl = document.querySelector(`.waveform[data-ix='${filename}']`);
        if (wfEl && loaded.has(filename)) hideWaveformOverlay(wfEl);
        // If this is an inactive waveform, reset its canvas clip-path to 0.
        // WaveSurfer v7 applies a clip-path to the canvases div matching the
        // playback position; the ::part(progress) CSS hides the progress bar
        // but does not clear the clip-path, leaving the beginning blank.
        if (filename !== currentAudioIx) {
          const sc = _getScrollContainer(filename);
          const savedSL = sc ? sc.scrollLeft : 0;
          _scrollSyncLock = true;
          wavesurfers[filename].seekTo(0);
          if (sc) sc.scrollLeft = savedSL;
          _scrollSyncLock = false;
        }
        if (currentAudioIx && _positionUpdaters[currentAudioIx]) {
          _positionUpdaters[currentAudioIx]();
        }
        // Re-add annotation regions — WaveSurfer's redraw removes and recreates
        // region SVG elements, so they must be restored after every render cycle.
        if (currentlyAnnotatedRegions.length) updateRenderAnnoRegions();
        // Ensure newly-created marker elements inherit the draggable class
        // so that drag works without re-toggling the checkbox.
        _updateMarkerDraggableClass();
        // No _resizeQueue needed: v7 rerenders each waveform independently.
      });
      let listItem = document.getElementById(filename);
      let status = listItem.querySelector("label").classList;
      status.remove("loading");
      status.add("ready");
      listItem.querySelector("input").checked = true;
      // check if we're the currentAudioIx, and if so make ourselves active and spool to provided playPosition
      // (possible when normalize checkbox has forced a reload of waveform elements)
      if (filename === currentAudioIx) {
        document
          .querySelector(`.waveform[data-ix='${filename}']`)
          .classList.add("active");
        wavesurfers[currentAudioIx].play(playPosition);
        if (!isPlaying) {
          wavesurfers[currentAudioIx].pause();
        }
      }
      // restore markers from alignment JSON if they exist
      if (
        loadedAlignmentJSON &&
        loadedAlignmentJSON.header &&
        Array.isArray(loadedAlignmentJSON.header.markers)
      ) {
        markers = [...loadedAlignmentJSON.header.markers];
        // markers are rendered by the "redrawcomplete" handler
      }
    });
    wavesurfers[filename].on("interaction", () => {
      if (filename !== currentAudioIx) swapCurrentAudio(filename);
    });
    wavesurfers[filename].on("seeking", () => {
      _updateMarkBtnTooltip();
    });
    wavesurfers[filename].on("play", () => _updateTransportIcons(true));
    wavesurfers[filename].on("pause", () => _updateTransportIcons(false));
    wavesurfers[filename].on("finish", () => _updateTransportIcons(false));

    wavesurfers[filename].on("audioprocess", () => {
      // continually update timer region when opened but not yet closed
      if (timerFrom === timerTo && timerFrom > 0) {
        _timerRegions[filename].setOptions({
          end: wavesurfers[filename].getCurrentTime(),
        });
        updateRenderTimer();
      }
      // Zoom scroll: only act on the playing waveform.
      // Use isPlaying() instead of filename===currentAudioIx to handle edge
      // cases where currentAudioIx hasn't been set yet (e.g. first playback
      // on the Score synth without switching waveforms first).
      const isActive = wavesurfers[filename].isPlaying();
      if (_currentZoomLevel > 1 && isActive && _scrollMode === "page") {
        _pageScrollIfNeeded(filename);
      }
      // Cross-waveform scroll sync during playback — BEFORE position indicator
      // so that non-active waveforms have correct scroll positions for drawing.
      if (_currentZoomLevel > 1 && isActive) {
        _syncAllWaveformScrolls(filename);
      }
      // Update position indicator AFTER scroll sync
      updatePositionIndicator();
      // Reset mark button while playing (position is moving)
      const markBtn = document.getElementById("mark");
      if (markBtn && markBtn.dataset.mode !== "place") {
        markBtn.title = "Place a marker at the current playback position";
        markBtn.dataset.mode = "place";
        const im = markBtn.querySelector(".icon-mark");
        const imx = markBtn.querySelector(".icon-mark-x");
        if (im) im.style.display = "";
        if (imx) imx.style.display = "none";
      }
    });

    // render anno regions
    if (currentlyAnnotatedRegions) updateRenderAnnoRegions();
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

// --- MEI synthesised waveform helpers ---

/**
 * Interpolate a synth-audio alignment grid from the score body's ref_onset / synth_onset
 * arrays.  For each time in refGrid, returns the corresponding time in the synth audio.
 */
function _interpAlignmentGrid(refGrid, refOnsets, synthOnsets) {
  if (!refOnsets || !refOnsets.length || !synthOnsets)
    return Array.from(refGrid, () => 0);
  const n = refOnsets.length;
  const pairs = Array.from({ length: n }, (_, i) => [
    refOnsets[i],
    synthOnsets[i],
  ]).sort((a, b) => a[0] - b[0]);
  const xs = pairs.map((p) => p[0]),
    ys = pairs.map((p) => p[1]);
  const slope0 = n > 1 ? (ys[1] - ys[0]) / Math.max(xs[1] - xs[0], 1e-9) : 0;
  const slopeN =
    n > 1 ? (ys[n - 1] - ys[n - 2]) / Math.max(xs[n - 1] - xs[n - 2], 1e-9) : 0;
  return Array.from(refGrid, (t) => {
    if (t <= xs[0]) return Math.max(0, ys[0] + slope0 * (t - xs[0]));
    if (t >= xs[n - 1]) return ys[n - 1] + slopeN * (t - xs[n - 1]);
    let lo = 0,
      hi = n - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (xs[m] <= t) lo = m;
      else hi = m;
    }
    return (
      ys[lo] +
      ((t - xs[lo]) / Math.max(xs[hi] - xs[lo], 1e-9)) * (ys[hi] - ys[lo])
    );
  });
}

/**
 * Parse a Standard MIDI File (Uint8Array) into { tpq, tempoChanges, notes }.
 * tempoChanges: [{tick, tempo}] sorted ascending.
 * notes: [{s, e, p, v}] = start/end tick, pitch, velocity.
 */
function _jsParseMidi(bytes) {
  let p = 0;
  const r4 = () => {
    const v =
      ((bytes[p] << 24) |
        (bytes[p + 1] << 16) |
        (bytes[p + 2] << 8) |
        bytes[p + 3]) >>>
      0;
    p += 4;
    return v;
  };
  const r2 = () => {
    const v = (bytes[p] << 8) | bytes[p + 1];
    p += 2;
    return v;
  };
  const rb = () => bytes[p++];
  const rv = () => {
    let v = 0;
    for (;;) {
      const b = rb();
      v = (v << 7) | (b & 0x7f);
      if (!(b & 0x80)) break;
    }
    return v;
  };
  p = 4;
  const hlen = r4();
  r2();
  const nTracks = r2();
  const tpq = r2();
  p = 8 + hlen;
  const tempoChanges = [{ tick: 0, tempo: 500000 }];
  const notes = [];
  for (let tr = 0; tr < nTracks; tr++) {
    if (bytes[p] !== 0x4d) break; // 'M' of 'MTrk'
    p += 4;
    const tlen = r4();
    const endPos = p + tlen;
    let tick = 0,
      rs = 0;
    const active = new Map();
    while (p < endPos) {
      tick += rv();
      let b = bytes[p];
      if (b === 0xff) {
        p++;
        const mtype = rb();
        const mlen = rv();
        if (mtype === 0x51 && mlen === 3)
          tempoChanges.push({
            tick,
            tempo: (bytes[p] << 16) | (bytes[p + 1] << 8) | bytes[p + 2],
          });
        p += mlen;
      } else if (b === 0xf0 || b === 0xf7) {
        p++;
        p += rv();
      } else {
        if (b & 0x80) {
          rs = b;
          p++;
        }
        const kind = (rs >> 4) & 0xf;
        if (kind === 0x9) {
          const pitch = rb(),
            vel = rb();
          if (vel > 0) active.set((rs & 0xf) * 128 + pitch, { tick, vel });
          else {
            const k = (rs & 0xf) * 128 + pitch;
            if (active.has(k)) {
              const s = active.get(k);
              notes.push({ s: s.tick, e: tick, p: pitch, v: s.vel });
              active.delete(k);
            }
          }
        } else if (kind === 0x8) {
          const pitch = rb();
          rb();
          const k = (rs & 0xf) * 128 + pitch;
          if (active.has(k)) {
            const s = active.get(k);
            notes.push({ s: s.tick, e: tick, p: pitch, v: s.vel });
            active.delete(k);
          }
        } else if (kind === 0xa || kind === 0xb || kind === 0xe) {
          p += 2;
        } else if (kind === 0xc || kind === 0xd) {
          p += 1;
        }
      }
    }
    active.forEach((s, k) =>
      notes.push({ s: s.tick, e: tick, p: k % 128, v: s.vel }),
    );
    p = endPos;
  }
  tempoChanges.sort((a, b) => a.tick - b.tick);
  notes.sort((a, b) => a.s - b.s);
  return { tpq, tempoChanges, notes };
}

/** Convert a MIDI tick to wall-clock seconds using a tempo-change list. */
function _jsTickToSec(tick, tpq, tcs) {
  let secs = 0,
    pt = 0,
    pu = 500000;
  for (const { tick: ct, tempo: cu } of tcs) {
    if (ct >= tick) break;
    secs += (((ct - pt) / tpq) * pu) / 1e6;
    pt = ct;
    pu = cu;
  }
  return secs + (((tick - pt) / tpq) * pu) / 1e6;
}

/** Format seconds as "Xs" or "Mm\u00a0SSs". */
function _fmtSec(s) {
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  return `${m}m\u00a0${String(Math.round(s % 60)).padStart(2, "0")}s`;
}

/**
 * Synthesise MIDI notes directly to a WAV Blob via additive PCM sample writing.
 *
 * OfflineAudioContext creates one OscillatorNode + one GainNode per note —
 * for a large score (18k+ notes) that's tens of thousands of Web Audio nodes
 * and takes several minutes.  Writing samples directly into a Float32Array is
 * O(total_note_samples) instead of O(nodes), and completes in a few seconds.
 *
 * onProgress(elapsedSec, estimatedTotalSec) — called every ~50 ms of real time.
 */
async function _jsSynthToWav(notes, tpq, tempoChanges, onProgress) {
  if (!notes.length) return null;
  const SR = 22050;
  const maxEndTick = notes.reduce((m, n) => Math.max(m, n.e), 0);
  const duration = _jsTickToSec(maxEndTick, tpq, tempoChanges) + 0.5;
  const nSamples = Math.ceil(duration * SR);
  const out = new Float32Array(nSamples);

  const ATK_S = Math.round(0.01 * SR);
  const REL_S = Math.round(0.03 * SR);
  const total = notes.length;
  const renderStart = performance.now();
  let lastYield = renderStart;

  for (let ni = 0; ni < total; ni++) {
    const note = notes[ni];
    const ts = _jsTickToSec(note.s, tpq, tempoChanges);
    if (ts >= duration) continue;

    const te = Math.min(
      duration - 0.01,
      _jsTickToSec(note.e, tpq, tempoChanges),
    );
    const noteDur = Math.max(0.02, te - ts);
    const amp = (note.v / 127) * 0.12;
    const phaseInc = (440 * Math.pow(2, (note.p - 69) / 12)) / SR;

    const iStart = Math.round(ts * SR);
    const iEnd = Math.min(nSamples, Math.round((ts + noteDur) * SR));
    const atkSamples = Math.min(ATK_S, Math.round(noteDur * 0.3 * SR));
    const sustainEnd = Math.max(iStart + atkSamples, iEnd - REL_S);

    let phase = 0;
    for (let i = iStart; i < iEnd; i++) {
      phase += phaseInc;
      if (phase >= 1) phase -= 1;
      const saw = 2 * phase - 1;
      const si = i - iStart;
      let env;
      if (si < atkSamples) {
        env = si / atkSamples;
      } else if (i >= sustainEnd) {
        env = Math.max(0, (iEnd - i) / REL_S);
      } else {
        env = 1;
      }
      out[i] += saw * amp * env;
    }

    // Yield to the event loop every ~50 ms so progress updates and paints can fire.
    const now = performance.now();
    if (now - lastYield > 50) {
      if (onProgress) {
        const elapsed = (now - renderStart) / 1000;
        const frac = (ni + 1) / total;
        onProgress(elapsed, elapsed / frac);
      }
      await new Promise((r) => setTimeout(r, 0));
      lastYield = performance.now();
    }
  }

  // Peak-normalise
  let peak = 0;
  for (let i = 0; i < nSamples; i++)
    if (Math.abs(out[i]) > peak) peak = Math.abs(out[i]);
  if (peak > 1e-6) for (let i = 0; i < nSamples; i++) out[i] /= peak;

  return _float32ToWavBlob(out, SR);
}

/** Encode a mono Float32Array as a 16-bit PCM WAV Blob. */
function _float32ToWavBlob(samples, SR) {
  const n = samples.length;
  const dataBytes = n * 2;
  const ab = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(ab);
  const ws = (o, s) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  ws(0, "RIFF");
  v.setUint32(4, 36 + dataBytes, true);
  ws(8, "WAVE");
  ws(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, SR, true);
  v.setUint32(28, SR * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  ws(36, "data");
  v.setUint32(40, dataBytes, true);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([ab], { type: "audio/wav" });
}

/** Encode a mono AudioBuffer as a 16-bit PCM WAV Blob. */
function _audioBufferToWavBlob(buffer) {
  return _float32ToWavBlob(buffer.getChannelData(0), buffer.sampleRate);
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
    ({ tpq, tempoChanges, notes } = _jsParseMidi(midiBytes));
  } catch (err) {
    console.error("MEI MIDI parse failed:", err);
    return;
  }

  // Compute alignment grid: map ref times → synth times.
  // Prefer synth_onset from the JSON (populated by the latest worker);
  // for older JSONs that lack it, derive from the MIDI note timings directly.
  const refOnsets = scoreData.ref_onset || [];
  const synthOnsets =
    scoreData.synth_onset && scoreData.synth_onset.length === refOnsets.length
      ? scoreData.synth_onset
      : refOnsets.map((_, i) => {
          if (i < notes.length)
            return _jsTickToSec(notes[i].s, tpq, tempoChanges);
          return i > 0
            ? _jsTickToSec(notes[notes.length - 1].s, tpq, tempoChanges)
            : 0;
        });
  alignmentGrids[synthKey] = _interpAlignmentGrid(
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
    const wavBlob = await _jsSynthToWav(
      notes,
      tpq,
      tempoChanges,
      (elapsed, estimated) => {
        const elStr = _fmtSec(elapsed);
        const estStr =
          estimated !== null ? `, est. ${_fmtSec(estimated)} total` : "";
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

let loadedAlignmentJSON = null; // Full alignment object for download

async function setGrids(grids) {
  console.log("received grids: ", grids);
  loadedAlignmentJSON = grids;
  if ("body" in grids) {
    if ("audio" in grids.body) {
      // final version of alignment json
      alignmentGrids = grids.body.audio;
      // Normalise entries that carry inline peak data {times, peaks, duration}
      // to plain time arrays, stashing peak info in _waveformPeaks.
      for (const [key, val] of Object.entries(alignmentGrids)) {
        if (val && !Array.isArray(val) && Array.isArray(val.times)) {
          _waveformPeaks[key] = { peaks: val.peaks, duration: val.duration };
          alignmentGrids[key] = val.times;
        }
      }
      if ("header" in grids) {
        if ("meiUri" in grids.header && "score" in grids.body) {
          meiUri = grids.header.meiUri;
          scoreAlignment = grids.body.score;
          // Reserve a slot in alignmentGrids for the synth waveform (filled later)
          if (scoreAlignment) {
            alignmentGrids[SYNTH_MEI_KEY] = []; // placeholder; computed in _buildAndPrepareSynthWaveform
          }
          console.log("starting MEI fetch: ", meiUri);
          await fetch(meiUri)
            .then((response) => response.text())
            .then((meiXml) => {
              mei = meiXml;
              meiDOM = parser.parseFromString(mei, "application/xml");
              tk.loadData(mei, {});
              timemap = tk.renderToTimemap({ includeMeasures: true });
              // Invalidate tempo cache so it picks up timemap qstamp values
              for (const k of Object.keys(_tempoRawCache))
                delete _tempoRawCache[k];
              _tempoYRange = null;
              console.log("timemap set!", timemap, mei);
            })
            .catch((e) => {
              console.error("Couldn't load MEI: ", e, grids.header.meiUri);
            });
          console.log("MEI fetched: ", meiUri);
        }
        if ("ref" in grids.header) {
          referenceAudioIx = grids.header.ref;
        }
      } else {
        console.error(
          "Broken grids received from alignment json file: ",
          grids,
        );
      }
    } else {
      // pre-final dev version of alignment json
      alignmentGrids = grids.body;
    }
  } else {
    // old version of alignment json
    alignmentGrids = grids;
  }
  console.log("setting grids: ", grids);

  // Invalidate tempo curve cache (alignment data changed)
  for (const k of Object.keys(_tempoRawCache)) delete _tempoRawCache[k];
  _tempoYRange = null;

  // Capture original alignment grids for the "Revert all" feature
  for (const [key, grid] of Object.entries(alignmentGrids)) {
    if (key !== SYNTH_MEI_KEY && Array.isArray(grid)) {
      _alignOriginalGrids[key] = grid.slice();
    }
  }

  /* ---- Dynamic file grouping ---- */
  _migrateToGroupingTabs();

  let filenames = Object.keys(alignmentGrids).filter(
    (n) => n !== SYNTH_MEI_KEY,
  );
  filenames.sort();

  _renderSidebarFileList(filenames);
  _renderGroupingTabPills();

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

  // Kick off async MEI-to-audio synthesis for the score waveform entry
  if (
    SYNTH_MEI_KEY in alignmentGrids &&
    grids.body &&
    grids.body.score &&
    grids.header &&
    grids.header.ref
  ) {
    const _midiB64 = tk.renderToMIDI();
    _buildAndPrepareSynthWaveform(
      SYNTH_MEI_KEY,
      grids.body.score,
      grids.header.ref,
      _midiB64,
    );
  }

  // Initialize the "New Annotation" button (idempotent — checks for duplicates)
  initNewAnnotationButton();
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
  loadedAlignmentJSON = alignmentResult;
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

  // Now in listen mode — initialise the Solid panel
  initSolidAuth().then(onSolidAuthChanged);
}

// ----------------------------------------------------------------------------
// Solid Extraction / Annotation Handlers
// ----------------------------------------------------------------------------

export async function createSelectionForWaveform(filename) {
  // We need to know which MAO Extract is currently active.
  const activeExtract = document.querySelector(".maoExtract.active");
  if (!activeExtract) {
    alert("Please select (click on) an active annotation card first.");
    return;
  }

  // We need the ID of the extract and its label
  const extractId = activeExtract.id;
  const extractLabel =
    activeExtract.querySelector(".maoExtract-label").innerText;

  // We need to find the bounds for this specific waveform
  let regionStart = 0;
  let regionEnd = 0;

  // Find the corresponding global annotation index
  let mySelections = activeExtract.dataset.selection;
  // (In drawExtractUIElement we stashed the first embodiment URI in dataset.selection)

  let regionIx = currentlyAnnotatedRegions.findIndex(
    (r) => r.selection === mySelections,
  );

  if (regionIx >= 0) {
    // If we have a local override (Phase 4), use it.
    const globalRegion = currentlyAnnotatedRegions[regionIx];
    if (globalRegion.localOverrides && globalRegion.localOverrides[filename]) {
      regionStart = globalRegion.localOverrides[filename].start;
      regionEnd = globalRegion.localOverrides[filename].end;
    } else {
      // Fallback to global alignment mapping
      regionStart = getCorrespondingTime(filename, globalRegion.from);
      regionEnd = getCorrespondingTime(filename, globalRegion.to);
    }
  } else {
    // Fallback if not found in memory (shouldn't happen if card is active)
    const ws = wavesurfers[filename];
    if (ws && ws.regions && ws.regions.list && ws.regions.list.anno_region_0) {
      regionStart = ws.regions.list.anno_region_0.start;
      regionEnd = ws.regions.list.anno_region_0.end;
    } else {
      console.error("Could not determine region bounds for selection");
      return;
    }
  }

  const audioMediaUri = `${dummyUriPrefix}${filename}#t=${regionStart},${regionEnd}`;

  // Call the function from annotation.js (it is a global in the current architecture or imported)
  if (typeof window.addNewMAOSelectionToExtract === "function") {
    window.addNewMAOSelectionToExtract(
      filename,
      audioMediaUri,
      extractId,
      extractLabel,
    );
  } else {
    console.error("addNewMAOSelectionToExtract is not available");
  }
}

// Phase 4: Handle Region Edits
function onRegionUpdated(filename, region) {
  // Handle draft regions
  if (region.id.startsWith("draft_")) {
    onDraftRegionUpdated(filename, region);
    return;
  }

  // Only handle our annotation regions (ignore the "timer" region)
  if (!region.id.startsWith("anno_region_")) return;

  const ix = parseInt(region.id.replace("anno_region_", ""));
  if (isNaN(ix) || !currentlyAnnotatedRegions[ix]) return;

  const isShiftPressed = window.event && window.event.shiftKey;

  if (isShiftPressed) {
    // Local Mode: store in overrides and do NOT re-render other waveforms
    if (!currentlyAnnotatedRegions[ix].localOverrides) {
      currentlyAnnotatedRegions[ix].localOverrides = {};
    }
    currentlyAnnotatedRegions[ix].localOverrides[filename] = {
      start: region.start,
      end: region.end,
    };
    console.log(
      `Local override saved for ${filename}:`,
      currentlyAnnotatedRegions[ix].localOverrides[filename],
    );
  } else {
    // Global Mode: convert to alignment ix, update global, re-render all
    const newFromGlobalIx = getClosestAlignmentIx(region.start, filename);
    const newToGlobalIx = getClosestAlignmentIx(region.end, filename);

    // Clear any local overrides for this region since we did a global edit
    currentlyAnnotatedRegions[ix].localOverrides = {};

    currentlyAnnotatedRegions[ix].from = newFromGlobalIx;
    currentlyAnnotatedRegions[ix].to = newToGlobalIx;

    // Re-render to propagate to all waveforms
    updateRenderAnnoRegions();
    console.log(
      `Global region updated to ${newFromGlobalIx} - ${newToGlobalIx}`,
    );
  }
}

// ----------------------------------------------------------------------------
// Document Ready Hook
// ----------------------------------------------------------------------------

document.addEventListener("DOMContentLoaded", () => {
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
    initSolidAuth().then(onSolidAuthChanged);
  }

  // Listen for auth state changes (e.g. logout from within the Solid drawer)
  document.addEventListener("solid-auth-changed", () => onSolidAuthChanged());

  // set up Verovio
  const _verovioReady = new Promise((resolve) => {
    if (typeof verovio !== "undefined" && verovio.module.calledRun) {
      tk = new verovio.toolkit();
      resolve(tk);
    } else if (typeof verovio !== "undefined") {
      verovio.module.onRuntimeInitialized = () => {
        tk = new verovio.toolkit();
        console.log("Have Verovio toolkit:", tk);
        resolve(tk);
      };
    }
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
      _updateDirtyState();
    });
    if (alignmentData === "session") dlBtn.style.display = ""; // legacy fallback
  }

  // Group files button
  const groupFilesBtn = document.getElementById("group-files-btn");
  if (groupFilesBtn) {
    groupFilesBtn.addEventListener("click", () => _openGroupModal());
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
        enterCloseListeningMode(
          markers.length > 0 ? findClosestMarkerIndex() : null,
        );
      } else {
        exitCloseListeningMode();
      }
    });
  }

  // --- Drag markers checkbox ---
  if (dragMarkersCb) {
    // Sync initial state from (possibly browser-cached) form value
    _dragMarkersEnabled = dragMarkersCb.checked;
    if (dragModeMove) dragModeMove.disabled = !_dragMarkersEnabled;
    if (dragModeFix) dragModeFix.disabled = !_dragMarkersEnabled;
    dragMarkersCb.addEventListener("change", () => {
      _dragMarkersEnabled = dragMarkersCb.checked;
      // Enable/disable the drag-mode radio buttons
      if (dragModeMove) dragModeMove.disabled = !_dragMarkersEnabled;
      if (dragModeFix) dragModeFix.disabled = !_dragMarkersEnabled;
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

  /** Delete the currently active marker (close-listening mode). */
  function _deleteActiveMarker() {
    if (!closeListeningMode || activeMarkerIx == null) return;
    const deletedAlignIx = markers[activeMarkerIx];
    const deletedArrayIx = activeMarkerIx;
    markers.splice(activeMarkerIx, 1);
    _persistMarkers();
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
      activeMarkerIx = bestIx;
      redrawAllMarkers();
      seekToActiveMarker();
    }
  }

  function _undoOne() {
    if (_undoStack.length === 0) return;
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
        if (_gridRedrawers[entry.filename]) _gridRedrawers[entry.filename]();
        break;
      }
      case "marker-add": {
        // Undo add = remove the marker
        const ix = markers.indexOf(entry.alignIx);
        if (ix > -1) {
          markers.splice(ix, 1);
          _persistMarkers();
          _redoStack.push({
            type: "marker-add",
            alignIx: entry.alignIx,
            markerArrayIx: ix,
          });
          if (closeListeningMode) {
            if (markers.length === 0) {
              exitCloseListeningMode();
            } else {
              activeMarkerIx = Math.min(
                activeMarkerIx || 0,
                markers.length - 1,
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
        _persistMarkers();
        _redoStack.push({
          type: "marker-delete",
          alignIx: entry.alignIx,
          markerArrayIx: insertIx,
        });
        if (closeListeningMode) {
          activeMarkerIx = insertIx;
        }
        redrawAllMarkers();
        break;
      }
      case "marker-move": {
        // Undo move = restore old position
        markers[entry.markerArrayIx] = entry.oldAlignIx;
        _persistMarkers();
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
    }
    _updateUndoRedoState();
  }

  function _redoOne() {
    if (_redoStack.length === 0) return;
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
        if (_gridRedrawers[entry.filename]) _gridRedrawers[entry.filename]();
        break;
      }
      case "marker-add": {
        // Redo add = re-insert
        const insertIx = Math.min(entry.markerArrayIx, markers.length);
        markers.splice(insertIx, 0, entry.alignIx);
        _persistMarkers();
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
          _persistMarkers();
          _undoStack.push({
            type: "marker-delete",
            alignIx: entry.alignIx,
            markerArrayIx: ix,
          });
          if (closeListeningMode) {
            if (markers.length === 0) {
              exitCloseListeningMode();
            } else {
              activeMarkerIx = Math.min(
                activeMarkerIx || 0,
                markers.length - 1,
              );
            }
          }
          redrawAllMarkers();
        }
        break;
      }
      case "marker-move": {
        markers[entry.markerArrayIx] = entry.newAlignIx;
        _persistMarkers();
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
    }
    _updateUndoRedoState();
  }

  function _revertAll() {
    for (const [filename, original] of Object.entries(_alignOriginalGrids)) {
      alignmentGrids[filename] = original.slice();
      _syncGridToJSON(filename);
      if (_gridRedrawers[filename]) _gridRedrawers[filename]();
    }
    // Also restore markers to saved state
    if (loadedAlignmentJSON?.header?.markers) {
      markers = [...loadedAlignmentJSON.header.markers];
    } else {
      markers.length = 0;
    }
    redrawAllMarkers();
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
      let hasChanges = false;
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
      revertBtn.disabled = !hasChanges;
    }
    _updateDirtyState();
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
      if (_dragMarkersEnabled) _showDisableDragPulse();
      return;
    }

    // If close-listening not active, enter it with this marker
    if (!closeListeningMode) {
      enterCloseListeningMode(nearby.markerArrayIx);
    } else if (!_dragMarkersEnabled) {
      // Not dragging — select this marker and seek to it
      activeMarkerIx = nearby.markerArrayIx;
      redrawAllMarkers();
      seekToActiveMarker();
    } else {
      // Drag enabled — just select the marker (no seek/jump)
      activeMarkerIx = nearby.markerArrayIx;
      redrawAllMarkers();
    }

    // If drag markers not enabled, show pulse hint
    if (!_dragMarkersEnabled) {
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
    const _zoomedW = _getZoomedWidth(filename) || rect.width;

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
      const _fullW = _getZoomedWidth(filename);
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
    const _zoomedW = _getZoomedWidth(filename) || rect.width;

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
        if (_gridRedrawers[filename]) _gridRedrawers[filename]();
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
            if (_gridRedrawers[fn]) _gridRedrawers[fn]();
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
        _persistMarkers();
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
    const fullW = _getZoomedWidth(filename) || viewW;
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
    const bandColor = "rgba(70, 130, 230, 0.12)";
    ctx.fillStyle = bandColor;
    const cutoff = Math.ceil(sigma * 3);
    const jMin = Math.max(0, jCenter - cutoff);
    const jMax = Math.min(grid.length - 1, jCenter + cutoff);
    const xMin = (grid[jMin] / dur) * fullW - scrollLeft;
    const xMax = (grid[jMax] / dur) * fullW - scrollLeft;
    ctx.fillRect(xMin, 0, xMax - xMin, h);
    const xCenter = (grid[jCenter] / dur) * fullW - scrollLeft;
    ctx.strokeStyle = "rgba(70, 130, 230, 0.5)";
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
    const fullW = _getZoomedWidth(filename) || viewW;
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
          ctx.fillStyle = "rgba(70, 130, 230, 0.08)";
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
    fetch(alignmentData)
      .then((response) => response.json())
      .then((contents) => {
        setGrids(contents);
      })
      .catch((err) => console.warn("Couldn't load alignment data: ", err));
  }

  // load a colormap json file (kept for potential future use).
  fetch(root + "js/hot-colormap.json")
    .then((r) => r.json())
    .then((cM) => {
      colorMap = cM;
    })
    .catch((err) => console.warn("Couldn't load colormap:", err));
  // --- Transport controls ---
  function _seekBy(delta) {
    if (!currentAudioIx || !wavesurfers[currentAudioIx]) return;
    const ws = wavesurfers[currentAudioIx];
    const dur = ws.getDuration();
    if (dur > 0) {
      const newTime = Math.max(0, Math.min(dur, ws.getCurrentTime() + delta));
      ws.seekTo(newTime / dur);
    }
  }

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
    _seekBy(-10);
  });

  // Forward 10s
  document.getElementById("seek-fwd").addEventListener("click", function () {
    _seekBy(10);
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
      _updateMarkBtnTooltip();
      return;
    }
    if (!currentAudioIx || !wavesurfers[currentAudioIx]) return;
    let toMark = getClosestAlignmentIx();
    const arrIx = markers.length;
    markers.push(toMark);
    _persistMarkers();
    _pushUndo(
      { type: "marker-add", alignIx: toMark, markerArrayIx: arrIx },
      true,
    );
    Object.keys(wavesurfers).forEach((ws) => {
      const t = getCorrespondingTime(ws, toMark);
      _addMarker(ws, { time: t, color: "red", alignIx: toMark });
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
    _applyNormGain(norm);
  });
  // visualize alignment checkbox — redraw grids to show/hide alignment lines
  document.getElementById("visalign").checked = false;
  document.getElementById("visalign").addEventListener("click", () => {
    Object.values(_gridRedrawers).forEach((fn) => fn());
  });
  // show relative position checkbox — redraw immediately when toggled while paused
  document.getElementById("visrelalign").addEventListener("click", () => {
    if (currentAudioIx && _positionUpdaters[currentAudioIx]) {
      _positionUpdaters[currentAudioIx]();
    }
  });
  // Shared time axis checkbox
  document
    .getElementById("shared-time-axis")
    .addEventListener("change", (e) => {
      _sharedTimeAxis = e.target.checked;
      applyZoom(_currentZoomLevel);
    });

  // --- Tempo curve controls ---
  const tempoCheckbox = document.getElementById("show-tempo-curve");
  const tempoOptions = document.getElementById("tempo-curve-options");
  function _redrawAllTempoCurves() {
    Object.values(_gridRedrawers).forEach((fn) => fn());
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
      _currentZoomLevel = restoredLevel;
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
      const currentIdx = ZOOM_LEVELS.indexOf(_currentZoomLevel);
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
    if (radio.checked) _scrollMode = radio.value;
    radio.addEventListener("change", (e) => {
      _scrollMode = e.target.value;
      Object.keys(wavesurfers).forEach((fn) => _applyScrollMode(fn));
    });
  });
  // Belt-and-suspenders: some browsers restore form state after DOMContentLoaded
  window.addEventListener("pageshow", () => {
    scrollRadios.forEach((radio) => {
      if (radio.checked && radio.value !== _scrollMode) {
        _scrollMode = radio.value;
        Object.keys(wavesurfers).forEach((fn) => _applyScrollMode(fn));
      }
    });
  });

  // show the Solid drawer button so users can open the linked-data panel
  document.getElementById("solid-drawer-btn").style.display = "";

  // Solid Drawer toggle logic
  const solidDrawer = document.getElementById("solid-drawer");
  document.getElementById("solid-drawer-btn").addEventListener("click", () => {
    solidDrawer.classList.toggle("closed");
  });
  document
    .getElementById("close-solid-drawer")
    .addEventListener("click", () => {
      solidDrawer.classList.add("closed");
    });

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
    if (active.closest(".gm-modal, #solid-drawer, #file-picker-overlay"))
      return;
    active.blur();
  });

  document.querySelector("body").addEventListener("keydown", (e) => {
    // Don't intercept when typing in an input/textarea
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
    // Don't intercept when a modal or the Solid drawer has focus
    if (
      e.target.closest &&
      e.target.closest(".gm-modal, #solid-drawer, #file-picker-overlay")
    )
      return;
    console.log("KEYDOWN: ", e);
    if (!currentAudioIx) return;

    // --- Helper: get ordered list of visible (checked) waveform filenames ---
    function getVisibleWaveforms() {
      return Array.from(document.querySelectorAll("#waveforms .waveform"))
        .map((el) => el.dataset.ix)
        .filter((name) => name in wavesurfers);
    }

    let handled = true;
    let updateTimer = false;

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
        if (closeListeningMode && activeMarkerIx != null) {
          if (e.shiftKey) {
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
                _persistMarkers();
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
          } else {
            // Jump to the closest marker more than 100ms before current position.
            // This avoids getting "stuck" on the current marker after a recent jump.
            const currentTime = wavesurfers[currentAudioIx].getCurrentTime();
            const sorted = getSortedMarkerIndices();
            let target = null;
            for (let j = sorted.length - 1; j >= 0; j--) {
              const mTime = getCorrespondingTime(
                currentAudioIx,
                markers[sorted[j]],
              );
              if (mTime < currentTime - 0.1) {
                target = sorted[j];
                break;
              }
            }
            if (target != null) {
              activeMarkerIx = target;
              redrawAllMarkers();
              seekToActiveMarker();
            } else {
              // No marker far enough in the past — jump to start of file
              const ws = wavesurfers[currentAudioIx];
              ws.seekTo(0);
            }
          }
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
        if (closeListeningMode && activeMarkerIx != null) {
          if (e.shiftKey) {
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
              _persistMarkers();
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
          } else {
            // Jump to the closest marker more than 100ms ahead of current position,
            // or if we're more than 100ms before the current active marker, re-seek it.
            const currentTime = wavesurfers[currentAudioIx].getCurrentTime();
            const sorted = getSortedMarkerIndices();
            let target = null;
            for (let j = 0; j < sorted.length; j++) {
              const mTime = getCorrespondingTime(
                currentAudioIx,
                markers[sorted[j]],
              );
              if (mTime > currentTime + 0.1) {
                target = sorted[j];
                break;
              }
            }
            if (target != null) {
              activeMarkerIx = target;
              redrawAllMarkers();
              seekToActiveMarker();
            }
          }
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
        _persistMarkers();
        _pushUndo(
          { type: "marker-add", alignIx: toMark, markerArrayIx: arrIx },
          true,
        );
        if (closeListeningMode) {
          // Make the newly added marker active
          activeMarkerIx = markers.length - 1;
          redrawAllMarkers();
          seekToActiveMarker();
        } else {
          Object.keys(wavesurfers).forEach((ws) => {
            const t = getCorrespondingTime(ws, toMark);
            _addMarker(ws, { time: t, color: "red", alignIx: toMark });
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
        } else if (markers.length > 0) {
          // Enter with closest marker to current playback position
          const closestIdx = findClosestMarkerIndex();
          enterCloseListeningMode(closestIdx);
        }
        break;
      }
      case "Escape": {
        if (closeListeningMode) {
          exitCloseListeningMode();
        }
        break;
      }
      case "KeyT":
        // HACK FOR DH 2023 temporarily disable in this branch
        return false;
        if (timerFrom > 0 && timerFrom === timerTo) {
          timerTo = wavesurfers[currentAudioIx].getCurrentTime();
        } else {
          timerFrom = wavesurfers[currentAudioIx].getCurrentTime();
          timerTo = timerFrom;
        }
        updateTimer = true;
        break;
      case "KeyX":
        // release timer
        timerFrom = 0;
        timerTo = 0;
        updateTimer = true;
        break;
      case "Space":
        playpause();
        break;
      default:
        handled = false;
    }

    if (handled) e.preventDefault();

    if (updateTimer) {
      Object.keys(wavesurfers).forEach((ws) => {
        const wsFrom = getCorrespondingTime(
          ws,
          getClosestAlignmentIx(timerFrom),
        );
        const wsTo = getCorrespondingTime(ws, getClosestAlignmentIx(timerTo));
        _timerRegions[ws].setOptions({ start: wsFrom, end: wsTo });
      });
      updateRenderTimer();
    }
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

  // ---------------------------------------------------------------------------
  // Time measurement: Shift-hold shows marker durations, Shift+drag measures
  // ---------------------------------------------------------------------------
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Shift" || e.repeat) return;
    if (_alignCorrectionMode) return; // Shift is used for influence zone in fix mode
    _measureShiftHeld = true;
    _showMarkerDurations();
  });

  document.addEventListener("keyup", (e) => {
    if (e.key !== "Shift") return;
    if (!_measureShiftHeld) return;
    _measureShiftHeld = false;
    _clearMeasureVisuals();
  });

  // Shift+drag on waveforms for arbitrary measurement spans
  const waveformsRoot = document.getElementById("waveforms");

  /** Given a mouse event over #waveforms, find the waveform filename and time. */
  function _measureHitTest(e) {
    // Walk up from target to find the .waveform container
    let wfEl = e.target.closest(".waveform[data-ix]");
    if (!wfEl) return null;
    const filename = wfEl.dataset.ix;
    const ws = wavesurfers[filename];
    if (!ws || !loaded.has(filename)) return null;
    const dur = ws.getDuration();
    const fullW = _getZoomedWidth(filename);
    if (fullW <= 0 || dur <= 0) return null;
    // Get x relative to the overlay inner (accounts for scroll)
    const ow = _overlayWrappers[filename];
    if (!ow) return null;
    const rect = ow.inner.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const time = (x / fullW) * dur;
    const alignIx = getClosestAlignmentIx(time, filename);
    return { filename, time, alignIx };
  }

  waveformsRoot.addEventListener("mousedown", (e) => {
    if (!_measureShiftHeld || e.button !== 0) return;
    const hit = _measureHitTest(e);
    if (!hit) return;
    e.preventDefault();
    _measureDragState = {
      filename: hit.filename,
      startAlignIx: hit.alignIx,
      endAlignIx: hit.alignIx,
    };
  });

  document.addEventListener("mousemove", (e) => {
    if (!_measureDragState) return;
    const hit = _measureHitTest(e);
    if (!hit) return;
    _measureDragState.endAlignIx = hit.alignIx;
    _drawMeasureSpan(
      _measureDragState.startAlignIx,
      _measureDragState.endAlignIx,
    );
  });

  // mouseup does NOT clear — visuals persist until Shift is released
  document.addEventListener("mouseup", () => {
    if (!_measureDragState) return;
    // Finalize the drag state but keep visuals
    _measureDragState = null;
  });
});

export function markScoreRegion(ids, selectionUrl, reset = false) {
  if (reset) {
    currentlyAnnotatedRegions = [];
  }
  console.log("Marking score region for ids: ", ids);
  // iterate over ids, attempting to find the first and last note that the tk can getTimesForElements on
  if (scoreAlignment && tk && referenceAudioIx) {
    let fromId, toId;
    let fromTimes, toTimes;
    for (let id of ids) {
      console.log("MEI DOM: ", meiDOM);
      console.log("Looking for id: ", id);
      let el = meiDOM.querySelector("[*|id='" + id + "']");
      if (!el) {
        console.warn("Couldn't find element with id: ", id);
        continue;
      }
      if (el.tagName !== "note") {
        // get the first note in the closest measure
        let measure = el.closest("measure");
        if (measure) {
          let firstNote = measure.querySelector("note");
          if (firstNote) {
            id = firstNote.getAttribute("xml:id");
            console.log("Using first note in measure: ", id);
          } else {
            console.warn("Measure has no notes, skipping: ", id);
            continue;
          }
        } else {
          console.warn("Element is not within a measure, skipping: ", id);
          continue;
        }
      }
      console.log("Determined from ID to be: ", id);
      fromTimes = tk.getTimesForElement(id);
      if (Object.keys(fromTimes).length) {
        fromId = id;
        break;
      }
    }
    for (let id of ids.reverse()) {
      let el = meiDOM.querySelector("[*|id='" + id + "']");
      if (!el) {
        console.warn("Couldn't find element with id: ", id);
        continue;
      }
      if (el.tagName !== "note") {
        // get the last note in the closest measure
        let measure = el.closest("measure");
        if (measure) {
          let lastNote = measure.querySelector("note:last-of-type");
          if (lastNote) {
            id = lastNote.getAttribute("xml:id");
            console.log("Using last note in measure: ", id);
          } else {
            console.warn("Measure has no notes, skipping: ", id);
            continue;
          }
        } else {
          console.warn("Element is not within a measure, skipping: ", id);
          continue;
        }
      }
      console.log("Determined to ID to be: ", id);
      toTimes = tk.getTimesForElement(id);
      if (Object.keys(toTimes).length) {
        toId = id;
        break;
      }
    }
    if (fromTimes) {
      let onsets = fromTimes.tstampOn;
      // if no toId specified, mark region from onset to offset of fromId; otherwise, mark from onset of fromId to offset of toId
      let offsets = toTimes ? toTimes.tstampOff : fromTimes.tstampOff;
      // getTimesForElements returns onset and offset times for identified elements (plus other stuff)
      // The returned values are arrays, to handle expansions. So we have to handle the arrays.
      // Return regions in the reference audio corresponding to these onsets and offsets
      console.log(
        "fromId: ",
        fromId,
        "toId: ",
        toId,
        "fromTimes",
        fromTimes,
        "toTimes",
        toTimes,
        "onsets: ",
        onsets,
        "offsets: ",
        offsets,
      );
      let refRegions = onsets.map((t, expansionIx) => {
        console.log("In loop: ", t, expansionIx);
        // Verovio's getTimesForElement returns MIDI real-time milliseconds,
        // which corresponds to the synth_onset timescale (seconds), NOT score_onset
        // (which is in symbolic score time / quarter-note positions).
        const onsetTimes =
          scoreAlignment.synth_onset || scoreAlignment.score_onset;
        const offsetTimes =
          scoreAlignment.synth_offset || scoreAlignment.score_offset;
        return {
          from: scoreAlignment.ref_onset[getClosestScoreTimeIx(t, onsetTimes)],
          to: scoreAlignment.ref_offset[
            getClosestScoreTimeIx(offsets[expansionIx], offsetTimes)
          ],
        };
      });
      // convert to alignment ix
      currentlyAnnotatedRegions.push({
        selection: selectionUrl.href,
        from: getClosestAlignmentIx(refRegions[0].from, referenceAudioIx),
        to: getClosestAlignmentIx(refRegions[0].to, referenceAudioIx),
      });
      updateRenderAnnoRegions();
      /* HACK DH 2023, in future handle multiple regions, for now only use the first
      /*refRegions.map(r => { 
        return {
          from: getClosestAlignmentIx(r.from, referenceAudioIx), 
          to: getClosestAlignmentIx(r.to, referenceAudioIx)
        }
      });*/
    } else {
      console.warn(
        "Verovio couldn't find onset / offset times for any of the selection IDs. Were any notes selected?",
      );
    }
  } else {
    console.warn("Current alignment JSON does not support score alignment");
  }
}

function getClosestScoreTimeIx(tInMilliSec, times) {
  let t = tInMilliSec / 1000;
  let closest = times.reduce(function (prev, curr) {
    return Math.abs(curr - t) < Math.abs(prev - t) ? curr : prev;
  });
  return times.indexOf(closest);
}

function playpause() {
  if (currentAudioIx) {
    if (wavesurfers[currentAudioIx].isPlaying())
      wavesurfers[currentAudioIx].pause();
    else wavesurfers[currentAudioIx].play();
  } else {
    // if there is at least one waveform loaded, make it active and play it
    let firstWs = document.querySelector(".waveform");
    if (firstWs) {
      swapCurrentAudio(firstWs.dataset.ix);
      wavesurfers[currentAudioIx].play();
    }
  }
  _updateMarkBtnTooltip();
}

function updateRenderTimer() {
  Object.keys(wavesurfers).forEach((ws) => {
    const timer = _timerRegions[ws];
    if (!timer) return;
    const timeDelta = timer.end - timer.start;
    // Note: injecting a label into the timer region element is not supported
    // in WaveSurfer v7 (shadow DOM). The region is rendered automatically;
    // a future implementation could overlay a label div on the container.
    console.log("timer:", timer.start, timer.end, "delta:", timeDelta);
  });
}

// todo refactor with updateRenderTimer above
export function updateRenderAnnoRegions() {
  // HACK dlfm2023: for now do nothing, ensure annots are loaded before wavesurfers
  Object.keys(wavesurfers).forEach((ws) => {
    console.log("Update render anno regions: ", ws, currentlyAnnotatedRegions);
    const regPlugin = _regionsPlugins[ws];
    if (!regPlugin) return;
    let regions = extractCurrentlyAnnotatedRegions(ws);
    // Also include draft regions
    const draftRegions = getDraftRegionsForWaveform(ws);
    // Remove only annotation + draft regions, preserving the timer region
    regPlugin
      .getRegions()
      .filter((r) => r.id !== "timer")
      .forEach((r) => r.remove());
    regions.forEach((r) => regPlugin.addRegion(r));
    draftRegions.forEach((r) => regPlugin.addRegion(r));
  });
}

function extractCurrentlyAnnotatedRegions(ws) {
  return currentlyAnnotatedRegions.map((r, ix) => {
    let regionStart, regionEnd;

    // Phase 4: Use local override if it exists, otherwise fall back to global alignment
    if (r.localOverrides && r.localOverrides[ws]) {
      regionStart = r.localOverrides[ws].start;
      regionEnd = r.localOverrides[ws].end;
    } else {
      regionStart = getCorrespondingTime(ws, r.from);
      regionEnd = getCorrespondingTime(ws, r.to);
    }

    return {
      id: "anno_region_" + ix,
      start: regionStart,
      end: regionEnd,
      drag: true,
      resize: true,
      color:
        (r.color && r.color.bg) ||
        getLiveColor(r.selection)?.bg ||
        "rgba(200, 130, 80, 0.3)",
    };
  });
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
    if (expectedAudioKeys.length > 0) {
      const name = alignmentLoadedFromFile ? "local file" : "URL";
      jsonStatusEl.innerHTML = `<span class="json-status-ok">&#10003; Alignment JSON loaded (${expectedAudioKeys.length} audio entries, from ${name})</span>`;
    } else {
      jsonStatusEl.innerHTML = `<span class="json-status-missing">No alignment JSON loaded yet \u2014 include a .json file</span>`;
    }
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
      li.innerHTML = `<span class="status-icon"></span><span class="filename">${name}</span>`;
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
        jsonStatusEl.innerHTML = `<span class="json-status-pending">&#8987; Reading ${jsonFiles[0].name}…</span>`;
      }
      try {
        const data = await processPickedJsonFile(jsonFiles[0]);
        // Validate basic structure
        if (data.body && data.body.audio && data.header && data.header.ref) {
          alignmentLoadedFromFile = true;
          // Clear old blob URLs/objects and audio keys
          fileBlobUrls.clear();
          fileBlobs.clear();
          expectedAudioKeys = Object.keys(data.body.audio).filter(
            (k) => k !== SYNTH_MEI_KEY,
          );
          // Store the alignment data for use when continue is clicked
          window._pendingLocalAlignment = data;
          // Set workId from the JSON filename
          workId = jsonFiles[0].name;
          // Temporarily set loadedAlignmentJSON so LD URI section can read header
          loadedAlignmentJSON = data;
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

  // Continue button — persist LD config and close
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
    // Show the "Manage files" button and wire it to reopen the overlay
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
