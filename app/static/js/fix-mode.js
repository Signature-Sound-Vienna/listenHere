// fix-mode.js — the alignment-correction screen (plan §14, increment 2).
//
// A per-waveform correction mode for a loaded score alignment: activating it on
// the score row or the reference row opens SCORE↔REF correction (the mode that
// edits ref_onset). The content pane is replaced by the full score rendered
// page-fit (~85% height, Verovio renderToSVG — the Spike B pattern) over a
// single waveform strip (~15%) showing the reference recording, whose viewport
// tracks the current score page's time span. Every onset of the current page
// draws as a faint tick with a connector from its score position; ◀/▶ skip the
// selection between onsets, and a score note-click selects its onset.
//
// Opt-in via the ?fixMode query parameter while experimental: without it, no
// entry affordance exists and the app is byte-identical (the A/B policy).
//
// This increment is the SCREEN — inspection, selection, paging, and the
// correction-engine bootstrap (ref-audio decode + the worker's fix_begin).
// The interaction loop (drag/approve/marks, auto-realign, L/R audition, undo)
// is increment 3 and builds on the session state assembled here.
//
// Entry is gated by the item-T guard (plan §14 D1): the header's Verovio
// stamps must be compatible with the live toolkit, and a freshly rendered
// MIDI's event quarters must match the stored score_onset exactly — anchors
// laid on a skewed quarters basis are poisoned data, so a mismatch refuses
// entry with an error naming the stamp.

import {
  tk,
  scoreAlignment,
  loadedAlignmentJSON,
  waveformPeaks,
  wavesurfers,
  fileBlobs,
  timemap,
  SYNTH_MEI_KEY,
  getReferenceAudioIx,
  getMeiXml,
  resolveAudioUrl,
} from "./listen.js";
import { verifyQuarters } from "./engine/correction-model.js";
import { parseMidi } from "./engine/mei-synth.js";
import { confirmDialog } from "./annotation/ui-common.js";
import WaveSurfer from "../vendor/wavesurfer.esm.js";

// ---------------------------------------------------------------------------
// Tunables (deliberately module constants, not options — measure, then tune).
// ---------------------------------------------------------------------------

/** Verovio scale for the page-fit render. Revisit if orchestral systems are
 *  illegible at pane-fit (plan §14 flags the page-turn model for that case). */
const FIX_SCALE = 40;
/** Strip viewport padding around the page's time span: at least this many
 *  seconds, or this fraction of the span, whichever is larger. */
const STRIP_PAD_SEC = 1.5;
const STRIP_PAD_FRAC = 0.08;
/** Tick hit radius for selecting an onset by clicking the strip (CSS px). */
const TICK_HIT_PX = 8;
/** Peak count for strip peaks derived from the bootstrap's decoded samples. */
const STRIP_PEAK_COUNT = 8000;
/** The aligner's sample rate — fix_begin expects ref samples at this rate. */
const FIX_SR = 22050;

/** Quantised quarter key — the 1e-6 rounding every quarters consumer uses. */
const qKey = (q) => Math.round(q * 1e6);

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/** The active fix session, or null. One at a time by construction. */
let _fix = null;
/** The last entry refusal message (test surface; cleared per attempt). */
let _lastRefusal = null;
/** The correction worker. Outlives a fix session (Pyodide is expensive to
 *  boot), disposed of its audio state on exit, terminated on piece reset. */
let _worker = null;
let _workerHasSession = false;
/**
 * Piece-derived state that outlives a fix session: the guard's fresh event
 * table, the onset groups, and the page model + SVG cache for the current
 * pane size. Built by the load-idle prewarm (or by the first entry) so that
 * entering fix mode costs milliseconds, not the measured ~2 s of Verovio
 * layout + page attribution on an orchestral score. Invalidated whenever a
 * piece (re)loads.
 */
let _derived = null;
let _prewarmTimer = null;
/** How the last entry went (test + telemetry surface). */
let _lastEntry = { usedPrewarm: false, spinnerShown: false, ms: 0 };

// ---------------------------------------------------------------------------
// Entry affordance
// ---------------------------------------------------------------------------

let _paramChecked = null;
function _fixModeParamPresent() {
  if (_paramChecked === null) {
    _paramChecked = new URLSearchParams(window.location.search).has("fixMode");
  }
  return _paramChecked;
}

/**
 * Hang the fix-mode entry button on a waveform row. Called by listen.js for
 * every row it creates; this module decides whether the row gets one — only
 * under ?fixMode, and in v1 only on the score row and the reference row
 * (score↔ref correction; audio-to-audio rows join with a later increment).
 */
export function attachFixEntryButton(filename, rowEl) {
  if (!_fixModeParamPresent()) return;
  if (!rowEl || rowEl.querySelector(".wf-fix-btn")) return;
  if (filename !== SYNTH_MEI_KEY && filename !== getReferenceAudioIx()) return;
  if (!scoreAlignment?.score_onset?.length || !scoreAlignment?.ref_onset?.length)
    return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "wf-fix-btn";
  btn.tabIndex = -1;
  btn.title = "Correct alignment (experimental)";
  btn.setAttribute("aria-label", "Correct alignment");
  btn.innerHTML =
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true">' +
    '<line x1="4" y1="6" x2="20" y2="6"/><circle cx="9" cy="6" r="2.4" fill="var(--color-surface, #fff)"/>' +
    '<line x1="4" y1="12" x2="20" y2="12"/><circle cx="15" cy="12" r="2.4" fill="var(--color-surface, #fff)"/>' +
    '<line x1="4" y1="18" x2="20" y2="18"/><circle cx="7" cy="18" r="2.4" fill="var(--color-surface, #fff)"/>' +
    "</svg>";
  btn.addEventListener("mousedown", (e) => e.preventDefault());
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    enterFixMode(filename);
  });
  rowEl.appendChild(btn);
}

// ---------------------------------------------------------------------------
// The item-T entry guard (plan §14 D1)
// ---------------------------------------------------------------------------

/**
 * Render a fresh MIDI from the loaded MEI and build the aligner's event table
 * from it: notes deduplicated per unique (start, end) tick pair, sorted by
 * that pair — the same construction as score_align and fix_begin.
 */
function _freshEventTable() {
  const midiB64 = tk.renderToMIDI();
  if (!midiB64) throw new Error("Verovio produced empty MIDI output");
  const bin = atob(midiB64);
  const midiBytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) midiBytes[i] = bin.charCodeAt(i);
  const { tpq, notes } = parseMidi(midiBytes);
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
  return {
    qOn: events.map((e) => e.s / tpq),
    qOff: events.map((e) => e.e / tpq),
    midiBytes,
  };
}

/** The stamp half of the guard: null when compatible, else the refusal text. */
function _stampCheck(header) {
  const opts = header?.verovioOptions || null;
  // Live semantics are expandNever (no expansion); an absent stamp means the
  // alignment predates Verovio 6 here, which also rendered without expansion.
  if (opts && (opts.expand || opts.expandAlways)) {
    return (
      "its score MIDI was rendered with Verovio expansion options " +
      `${JSON.stringify(opts)}, but this app renders without expansion ` +
      "(expandNever)"
    );
  }
  const live = typeof tk.getVersion === "function" ? tk.getVersion() : null;
  const stamped = header?.verovioVersion || null;
  if (stamped && live && stamped !== live) {
    return (
      `its score MIDI was rendered by Verovio ${stamped}, but this app ` +
      `runs Verovio ${live}`
    );
  }
  return null;
}

/**
 * Run the full entry guard. Returns the fresh event table on success; throws
 * with the honest refusal message otherwise.
 */
function _entryGuard() {
  if (!tk) throw new Error("the score renderer (Verovio) is unavailable");
  if (!getMeiXml()) throw new Error("the score MEI is not loaded");
  const header = loadedAlignmentJSON?.header;
  const stampProblem = _stampCheck(header);
  if (stampProblem) throw new Error(stampProblem);
  const fresh = _freshEventTable();
  const stampNote = header?.verovioVersion
    ? `both stamped and rendered under Verovio ${header.verovioVersion}`
    : "the alignment carries no Verovio version stamp";
  for (const [name, stored, freshQ] of [
    ["score_onset", scoreAlignment.score_onset, fresh.qOn],
    ["score_offset", scoreAlignment.score_offset, fresh.qOff],
  ]) {
    if (!Array.isArray(stored)) continue; // ancient JSONs may lack offsets
    const v = verifyQuarters(stored, freshQ);
    if (v.ok) continue;
    if (v.lengthMismatch) {
      throw new Error(
        `the freshly rendered score MIDI has ${freshQ.length} events but ` +
          `the stored alignment has ${stored.length} — the score rendering ` +
          `has changed since this alignment was made (${stampNote})`,
      );
    }
    const f = v.firstMismatch;
    throw new Error(
      `${v.mismatchCount} of ${stored.length} ${name} quarters differ from ` +
        `the freshly rendered score MIDI (first at event ${f.index}: stored ` +
        `${f.stored}, fresh ${f.fresh}); ${stampNote}`,
    );
  }
  return fresh;
}

function _refuse(message) {
  _lastRefusal = message;
  console.warn("fix mode refused:", message);
  return confirmDialog({
    title: "Cannot correct this alignment",
    body: [
      `Correction mode refused: ${message}.`,
      "Corrections made against a score rendering that differs from the " +
        "one the aligner saw would silently corrupt the alignment, so fix " +
        "mode only opens when the two match exactly.",
    ],
    confirmLabel: "Close",
    cancelLabel: null,
  });
}

// ---------------------------------------------------------------------------
// Entry / exit
// ---------------------------------------------------------------------------

export function isFixModeActive() {
  return !!_fix;
}

/** Let the just-shown loading overlay actually paint before synchronous
 *  Verovio work blocks the thread. rAF suspends in hidden panes, so a plain
 *  timeout races it as the backstop. */
function _paintFrame() {
  return Promise.race([
    new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0))),
    new Promise((r) => setTimeout(r, 60)),
  ]);
}

/** The current pane size matches the derived cache closely enough to reuse
 *  it — the viewBox scaling absorbs small deltas as letterboxing. */
function _derivedFitsPane(w, h) {
  if (!_derived || !_derived.dims) return false;
  const dw = Math.abs(_derived.dims.w - w);
  const dh = Math.abs(_derived.dims.h - h);
  return dw <= Math.max(8, w * 0.02) && dh <= Math.max(8, h * 0.02);
}

/** Enter score↔ref fix mode from a row's entry button. */
export async function enterFixMode(entryFile) {
  if (_fix) return;
  _lastRefusal = null;
  const t0 = performance.now();

  const refFile = getReferenceAudioIx();
  const waveformsEl = document.getElementById("waveforms");
  const contentEl = document.getElementById("content");
  if (!waveformsEl || !contentEl) return;

  _fix = {
    mode: "score-ref",
    entryFile,
    refFile,
    qOn: null,
    qOff: null,
    midiBytes: null,
    nEvents: 0,
    groups: [],
    page: 1,
    pageCount: 1,
    selGroupIx: 0,
    pageSvgCache: new Map(),
    pageIndex: new Map(), // xml:id → element, for the CURRENT page only
    stripWS: null,
    stripSource: null,
    stripPps: 0,
    chipState: "idle",
    els: {},
    resizeObserver: null,
    resizeDebounce: null,
    lastPaneSize: null,
    raf: 0,
  };
  const f = _fix;

  // The skeleton (with its loading overlay) goes up BEFORE any Verovio work,
  // so a slow entry looks like loading instead of a hang; one painted frame
  // is yielded for it. The prewarmed path removes the overlay ~instantly.
  _buildDom(contentEl, waveformsEl);
  const w = f.els.scoreEl.clientWidth;
  const h = f.els.scoreEl.clientHeight;
  const usePrewarm = _derivedFitsPane(w, h);
  if (!usePrewarm) {
    _showFixLoading("Preparing correction view…");
    _lastEntry = { usedPrewarm: false, spinnerShown: true, ms: 0 };
    await _paintFrame();
    if (_fix !== f) return; // exited (or replaced) during the yield
  } else {
    _lastEntry = { usedPrewarm: true, spinnerShown: false, ms: 0 };
  }

  if (!_derived) {
    // No (valid) prewarm: run the guard now. Refusal tears the skeleton down.
    let fresh;
    try {
      fresh = _entryGuard();
    } catch (e) {
      _teardownFixDom(f);
      await _refuse(e.message);
      return;
    }
    _derived = {
      fresh,
      groups: _buildGroupsFrom(fresh.qOn),
      dims: null,
      pageCount: 0,
      svgCache: new Map(),
    };
  }
  f.qOn = _derived.fresh.qOn;
  f.qOff = _derived.fresh.qOff;
  f.midiBytes = _derived.fresh.midiBytes;
  f.nEvents = f.qOn.length;
  f.groups = _derived.groups;
  f.pageSvgCache = _derived.svgCache; // shared: survives exit for re-entry

  if (!usePrewarm || !_derived.pageCount) {
    // Layout for THIS pane size (the expensive part prewarm normally covers).
    _applyFixLayoutAt(w, h);
    _derived.dims = { w, h };
    _derived.pageCount = tk.getPageCount();
    _derived.svgCache.clear();
    _assignGroupPages(f.groups);
  }
  f.pageCount = _derived.pageCount;

  _buildStrip(_stripSource());
  _renderPage(f.groups[0]?.page || 1);
  _select(0);
  _hideFixLoading();
  _lastEntry.ms = Math.round(performance.now() - t0);
  console.log(
    `fix mode: entered in ${_lastEntry.ms} ms` +
      (_lastEntry.usedPrewarm ? " (prewarmed)" : " (cold: layout + guard ran now)"),
  );

  // The score pane can resize without a window resize — the nav collapsing,
  // the annotation drawer pushing, the pane becoming visible at all — and
  // every one of those invalidates the page-fit geometry wholesale.
  f.lastPaneSize = `${f.els.scoreEl.clientWidth}x${f.els.scoreEl.clientHeight}`;
  f.resizeObserver = new ResizeObserver(() => {
    if (_fix !== f) return;
    const size = `${f.els.scoreEl.clientWidth}x${f.els.scoreEl.clientHeight}`;
    // A hidden (zero-sized) pane must not re-lay-out to the fallback page
    // dimensions; the relayout runs when it comes back.
    if (size === f.lastPaneSize || size === "0x0") return;
    f.lastPaneSize = size;
    clearTimeout(f.resizeDebounce);
    f.resizeDebounce = setTimeout(() => {
      if (_fix === f) _onResize();
    }, 150);
  });
  f.resizeObserver.observe(f.els.scoreEl);

  // The engine bootstrap (decode + fix_begin) runs in the background; the
  // screen is usable for inspection while it loads, and increment 3's
  // realign waits on it.
  _bootstrap().catch((e) => {
    console.error("fix-mode bootstrap failed:", e);
    _setChip("error", `Correction engine unavailable: ${e.message}`);
  });
}

/** Remove a session's DOM and renderer without any toolkit work. */
function _teardownFixDom(f) {
  if (_fix === f) _fix = null;
  f.resizeObserver?.disconnect();
  clearTimeout(f.resizeDebounce);
  if (f.raf) cancelAnimationFrame(f.raf);
  try {
    f.stripWS?.destroy();
  } catch (_) {}
  f.els.root?.remove();
  const waveformsEl = document.getElementById("waveforms");
  if (waveformsEl) waveformsEl.style.display = "";
}

/**
 * Leave fix mode. Deliberately NO toolkit restore: under ?fixMode the fix
 * layout stays RESIDENT between sessions (every remaining toolkit consumer —
 * renderToMIDI, timemap, getTimesForElement — is layout-independent), which
 * is what makes exit and re-entry cost milliseconds instead of a full
 * relayout each way. Without ?fixMode this module never touches the toolkit.
 */
export function exitFixMode() {
  if (!_fix) return;
  const f = _fix;
  _teardownFixDom(f);
  // The worker keeps its Pyodide runtime for a cheap re-entry, but drops the
  // session's resident audio.
  if (_worker && _workerHasSession) {
    _workerHasSession = false;
    try {
      _worker.postMessage({ type: "fix_dispose" });
    } catch (_) {}
  }
}

/**
 * Piece teardown hook, called from listen.js's resetSession: a new piece
 * invalidates the fix session, the derived caches, AND the worker's resident
 * audio wholesale.
 */
export function fixModeOnPieceReset() {
  exitFixMode();
  _derived = null;
  clearTimeout(_prewarmTimer);
  if (_worker) {
    try {
      _worker.terminate();
    } catch (_) {}
    _worker = null;
    _workerHasSession = false;
  }
}

// ---------------------------------------------------------------------------
// Load-idle prewarm
// ---------------------------------------------------------------------------

/**
 * Called by listen.js at the end of every completed load (setGrids): the old
 * derived state is stale now; under ?fixMode, rebuild it once the load has
 * settled, so the first entry into fix mode is instant. The prewarm runs the
 * guard, builds the onset groups, applies the fix layout (which then stays
 * resident), attributes groups to pages, and renders the first page — the
 * measured ~2 s of entry work, moved to idle time.
 */
export function fixModePrewarm() {
  _derived = null;
  if (!_fixModeParamPresent()) return;
  clearTimeout(_prewarmTimer);
  _schedulePrewarm(2000, 20);
}

/**
 * Run the prewarm at idle after `delayMs`. `retries` covers the pane being
 * hidden (zero-sized) when the moment comes — a tab loaded in the background
 * measures 0×0 until the user switches to it, so the attempt reschedules
 * itself for a while instead of silently never prewarming.
 */
function _schedulePrewarm(delayMs, retries) {
  _prewarmTimer = setTimeout(() => {
    const run = () => {
      try {
        const outcome = _runPrewarm();
        if (outcome === "retry" && retries > 0) _schedulePrewarm(3000, retries - 1);
      } catch (e) {
        console.warn("fix mode: prewarm failed (entry will do the work):", e);
      }
    };
    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(run, { timeout: 10000 });
    } else {
      setTimeout(run, 0);
    }
  }, delayMs);
}

function _runPrewarm() {
  if (_fix || _derived) return; // entered already, or a prewarm landed
  if (!tk || !getMeiXml()) return;
  if (!scoreAlignment?.score_onset?.length || !scoreAlignment?.ref_onset?.length)
    return;
  const t0 = performance.now();
  let fresh;
  try {
    fresh = _entryGuard();
  } catch (e) {
    // The guard would refuse entry; leave everything untouched so the entry
    // click raises the honest dialog itself.
    console.warn("fix mode: prewarm skipped, guard refuses —", e.message);
    return;
  }
  const dims = _measurePaneDims();
  if (!dims) return "retry"; // hidden/zero pane — try again once it has size
  const groups = _buildGroupsFrom(fresh.qOn);
  _applyFixLayoutAt(dims.w, dims.h);
  const pageCount = tk.getPageCount();
  _assignGroupPages(groups);
  const svgCache = new Map();
  const firstPage = groups[0]?.page || 1;
  svgCache.set(firstPage, tk.renderToSVG(firstPage, {}));
  _derived = { fresh, groups, dims, pageCount, svgCache };
  console.log(
    `fix mode: prewarmed in ${Math.round(performance.now() - t0)} ms ` +
      `(${pageCount} pages at ${dims.w}×${dims.h}; layout resident)`,
  );
}

/**
 * What the score pane WILL measure once fix mode's DOM exists, read from a
 * hidden throwaway skeleton laid out by the same CSS.
 */
function _measurePaneDims() {
  const content = document.getElementById("content");
  if (!content || !content.clientWidth || !content.clientHeight) return null;
  const probe = document.createElement("div");
  probe.id = "fix-mode";
  probe.style.cssText =
    "position:absolute;visibility:hidden;pointer-events:none;left:0;top:0;" +
    `width:${content.clientWidth}px;height:${content.clientHeight}px;`;
  const header = document.createElement("div");
  header.className = "fix-header";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = "✕ Exit correction mode";
  header.appendChild(btn);
  const score = document.createElement("div");
  score.className = "fix-score";
  const gap = document.createElement("div");
  gap.className = "fix-gap";
  const strip = document.createElement("div");
  strip.className = "fix-strip";
  probe.append(header, score, gap, strip);
  content.appendChild(probe);
  const dims = { w: score.clientWidth, h: score.clientHeight };
  probe.remove();
  return dims.w && dims.h ? dims : null;
}

// ---------------------------------------------------------------------------
// The event → onset-group model
// ---------------------------------------------------------------------------

/**
 * Group alignment events by distinct onset quarter. Events sharing an onset
 * (chord notes with different offsets) are one visual onset: one tick, one
 * connector, one selection stop — their ref_onset values coincide by
 * construction. Each group carries its member event indices (the anchor
 * model's unit in increment 3) and the xml:ids sounding at that quarter.
 * Pure derivation from the event quarters + the session timemap, so the
 * prewarm can build it outside any fix session.
 */
function _buildGroupsFrom(qOn) {
  const idsByQ = new Map();
  for (const e of timemap) {
    // Do NOT filter out entries carrying measureOn (as the tempo derivation
    // does): a measure boundary coincides with a note onset, so such entries
    // carry the very ids this map exists for — q=0 always among them.
    if (!("qstamp" in e)) continue;
    if (Array.isArray(e.on) && e.on.length) idsByQ.set(qKey(e.qstamp), e.on);
  }
  const groups = [];
  let cur = null;
  let unmatched = 0;
  for (let i = 0; i < qOn.length; i++) {
    const k = qKey(qOn[i]);
    if (!cur || cur.k !== k) {
      const ids = idsByQ.get(k) || [];
      if (!ids.length) unmatched++;
      cur = { k, q: qOn[i], eventIxs: [], ids, page: 0, xScore: null, yNote: null };
      groups.push(cur);
    }
    cur.eventIxs.push(i);
  }
  if (unmatched) {
    console.warn(
      `fix mode: ${unmatched} of ${groups.length} onsets found no timemap ` +
        "entry (no score highlight/connector for those)",
    );
  }
  return groups;
}

/** A group's CURRENT reference time — read live, so refills show through. */
function _groupRefTime(group) {
  return scoreAlignment.ref_onset[group.eventIxs[0]];
}

// ---------------------------------------------------------------------------
// DOM skeleton
// ---------------------------------------------------------------------------

function _buildDom(contentEl, waveformsEl) {
  const f = _fix;
  waveformsEl.style.display = "none";

  const root = document.createElement("div");
  root.id = "fix-mode";

  const header = document.createElement("div");
  header.className = "fix-header";

  const exitBtn = document.createElement("button");
  exitBtn.type = "button";
  exitBtn.id = "fix-exit";
  exitBtn.textContent = "✕ Exit correction mode";
  exitBtn.addEventListener("click", () => exitFixMode());

  const title = document.createElement("span");
  title.className = "fix-title";
  title.textContent = `Correcting alignment: score ↔ ${f.refFile}`;

  const pageCtl = document.createElement("span");
  pageCtl.className = "fix-page-ctl";
  const pagePrev = document.createElement("button");
  pagePrev.type = "button";
  pagePrev.className = "fix-page-prev";
  pagePrev.textContent = "◀";
  pagePrev.title = "Previous page";
  const pageLabel = document.createElement("span");
  pageLabel.className = "fix-page-label";
  const pageNext = document.createElement("button");
  pageNext.type = "button";
  pageNext.className = "fix-page-next";
  pageNext.textContent = "▶";
  pageNext.title = "Next page";
  pagePrev.addEventListener("click", () => _turnPage(-1));
  pageNext.addEventListener("click", () => _turnPage(1));
  pageCtl.append(pagePrev, pageLabel, pageNext);

  const chip = document.createElement("span");
  chip.className = "fix-chip";
  chip.dataset.state = "idle";

  header.append(exitBtn, title, pageCtl, chip);

  const score = document.createElement("div");
  score.className = "fix-score";
  const scoreSvg = document.createElement("div");
  scoreSvg.className = "fix-score-svg";
  score.appendChild(scoreSvg);
  scoreSvg.addEventListener("click", (e) => _onScoreClick(e));

  const gap = document.createElement("div");
  gap.className = "fix-gap";

  const strip = document.createElement("div");
  strip.className = "fix-strip";
  const stripWs = document.createElement("div");
  stripWs.className = "fix-strip-ws";
  const ticks = document.createElement("canvas");
  ticks.className = "fix-ticks";
  ticks.addEventListener("click", (e) => _onTickClick(e));
  const skipPrev = document.createElement("button");
  skipPrev.type = "button";
  skipPrev.className = "fix-onset-skip fix-onset-prev";
  skipPrev.title = "Previous onset";
  skipPrev.textContent = "◀";
  const skipNext = document.createElement("button");
  skipNext.type = "button";
  skipNext.className = "fix-onset-skip fix-onset-next";
  skipNext.title = "Next onset";
  skipNext.textContent = "▶";
  skipPrev.addEventListener("mousedown", (e) => e.preventDefault());
  skipNext.addEventListener("mousedown", (e) => e.preventDefault());
  skipPrev.addEventListener("click", () => _skipOnset(-1));
  skipNext.addEventListener("click", () => _skipOnset(1));
  strip.append(stripWs, ticks, skipPrev, skipNext);

  // Connector overlay spans the whole fix container so a polyline can run
  // from a note in the score pane down across the gap into the strip.
  const conn = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  conn.classList.add("fix-connectors");

  // Loading overlay: shown before any synchronous Verovio work, so a cold
  // entry (or a relayout after a resize) reads as loading, not a hang.
  const loading = document.createElement("div");
  loading.className = "fix-loading";
  loading.hidden = true;
  const loadingSpin = document.createElement("div");
  loadingSpin.className = "fix-loading-spin";
  const loadingText = document.createElement("div");
  loadingText.className = "fix-loading-text";
  loading.append(loadingSpin, loadingText);

  root.append(header, score, gap, strip, conn, loading);
  contentEl.appendChild(root);

  f.els = {
    root,
    scoreEl: score,
    scoreSvg,
    strip,
    stripWs,
    ticks,
    conn,
    pageLabel,
    chip,
    title,
    loading,
    loadingText,
  };
}

function _showFixLoading(text) {
  if (!_fix) return;
  _fix.els.loadingText.textContent = text;
  _fix.els.loading.hidden = false;
}

function _hideFixLoading() {
  if (!_fix) return;
  _fix.els.loading.hidden = true;
}

function _setChip(state, text) {
  if (!_fix) return;
  _fix.chipState = state;
  _fix.els.chip.dataset.state = state;
  _fix.els.chip.textContent = text;
  _fix.els.chip.title = text;
}

// ---------------------------------------------------------------------------
// Verovio layout + page model
// ---------------------------------------------------------------------------

function _redoLayout() {
  if (typeof tk.redoLayout === "function") tk.redoLayout();
  else tk.loadData(getMeiXml());
}

/**
 * Size the Verovio page to a score-pane box (page-fit) and re-lay-out.
 * adjustPageHeight is ON so the page box tracks actual content: a full
 * orchestral system can be TALLER than the target page height, and with a
 * fixed box Verovio overflows it — the viewBox then clips the overflow
 * instead of scaling it. With the box tracking content, svgViewBox + the
 * pane's CSS shrink every page fully into view (page heights — and so the
 * on-screen scale — may vary a little between pages).
 */
function _applyFixLayoutAt(w, h) {
  const factor = 100 / FIX_SCALE;
  tk.setOptions({
    scale: FIX_SCALE,
    pageWidth: Math.max(400, Math.floor((w || 800) * factor)),
    pageHeight: Math.max(400, Math.floor((h || 500) * factor)),
    adjustPageHeight: true,
    breaks: "auto",
    footer: "none",
    header: "none",
    svgViewBox: true,
  });
  _redoLayout();
}

function _pageOfGroup(g) {
  for (const id of g.ids) {
    try {
      const p = tk.getPageWithElement(id);
      if (p > 0) return p;
    } catch (_) {
      /* try the next id */
    }
  }
  return 0;
}

/**
 * Ask the laid-out toolkit which page each onset group renders on. Score
 * order means pages are monotone over the groups, so the boundaries are
 * found by divide-and-conquer instead of one wasm call per group — measured
 * at ~0.7 ms per getPageWithElement call, the naive loop was ~1 s on the
 * Fledermaus corpus (~1,500 groups), most of the old entry cost after
 * layout.
 */
function _assignGroupPages(groups) {
  const known = [];
  for (let i = 0; i < groups.length; i++) {
    groups[i].page = 0;
    if (groups[i].ids.length) known.push(i);
  }
  if (known.length) {
    const first = known[0];
    const last = known[known.length - 1];
    groups[first].page = _pageOfGroup(groups[first]) || 1;
    groups[last].page = _pageOfGroup(groups[last]) || groups[first].page;
    const fill = (loK, hiK) => {
      if (hiK - loK <= 1) return;
      const pLo = groups[known[loK]].page;
      const pHi = groups[known[hiK]].page;
      if (pLo === pHi) {
        for (let k = loK + 1; k < hiK; k++) groups[known[k]].page = pLo;
        return;
      }
      const midK = (loK + hiK) >> 1;
      groups[known[midK]].page = _pageOfGroup(groups[known[midK]]) || pLo;
      fill(loK, midK);
      fill(midK, hiK);
    };
    fill(0, known.length - 1);
  }
  // Groups with no resolvable element inherit their neighbourhood's page,
  // so paging and the strip window stay monotonic.
  let lastPage = 1;
  for (const g of groups) {
    if (g.page > 0) lastPage = g.page;
    else g.page = lastPage;
  }
}

function _groupsOnPage(page) {
  return _fix.groups.filter((g) => g.page === page);
}

/** Render (or re-show) one score page and rebuild its per-page caches. */
function _renderPage(page) {
  const f = _fix;
  page = Math.min(Math.max(1, page), f.pageCount);
  f.page = page;
  let svg = f.pageSvgCache.get(page);
  if (!svg) {
    svg = tk.renderToSVG(page, {});
    f.pageSvgCache.set(page, svg);
  }
  f.els.scoreSvg.innerHTML = svg;
  // Per-page id → element index (scoped lookup, the Spike B pattern).
  f.pageIndex.clear();
  f.els.scoreSvg.querySelectorAll("g[id]").forEach((g) => {
    f.pageIndex.set(g.id, g);
  });
  // Score-side connector endpoints for this page's groups, in #fix-mode
  // container coordinates. The score pane neither scrolls nor zooms, so these
  // stay valid until the next page render or relayout.
  const rootRect = f.els.root.getBoundingClientRect();
  for (const g of f.groups) {
    g.xScore = null;
    g.yNote = null;
    if (g.page !== page || !g.ids.length) continue;
    let xSum = 0;
    let n = 0;
    let yMax = -Infinity;
    for (const id of g.ids) {
      const el = f.pageIndex.get(id);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      xSum += r.x + r.width / 2 - rootRect.x;
      yMax = Math.max(yMax, r.bottom - rootRect.y);
      n++;
    }
    if (n) {
      g.xScore = xSum / n;
      g.yNote = yMax;
    }
  }
  f.els.pageLabel.textContent = `Page ${page} / ${f.pageCount}`;
  _updateStripWindow();
  _scheduleRedraw();
}

function _turnPage(delta) {
  const f = _fix;
  const page = Math.min(Math.max(1, f.page + delta), f.pageCount);
  if (page === f.page) return;
  // Keep the selection meaningful: land it on the new page's first onset.
  const first = f.groups.findIndex((g) => g.page === page);
  if (first !== -1) _select(first);
  else _renderPage(page);
}

// ---------------------------------------------------------------------------
// The strip (peaks-only WaveSurfer, the exhibit's proven pattern)
// ---------------------------------------------------------------------------

/** Best available peaks + duration for the reference recording. */
function _stripSource() {
  const pk = waveformPeaks[_fix.refFile];
  if (pk?.peaks?.length && pk?.duration) {
    return { peaks: pk.peaks, duration: pk.duration };
  }
  const ws = wavesurfers[_fix.refFile];
  if (ws) {
    try {
      const duration = ws.getDuration();
      const exported = ws.exportPeaks?.({ maxLength: STRIP_PEAK_COUNT });
      if (duration && exported?.[0]?.length) {
        return { peaks: exported[0], duration };
      }
    } catch (_) {
      /* no decoded data — the bootstrap's decode will fill this in */
    }
  }
  return null;
}

function _buildStrip(source) {
  const f = _fix;
  if (f.stripWS) {
    try {
      f.stripWS.destroy();
    } catch (_) {}
    f.stripWS = null;
  }
  f.stripSource = source;
  f.els.stripWs.innerHTML = "";
  if (!source) {
    f.els.stripWs.dataset.placeholder =
      "Reference waveform appears when the audio has decoded…";
    return;
  }
  delete f.els.stripWs.dataset.placeholder;
  const style = getComputedStyle(document.documentElement);
  f.stripWS = WaveSurfer.create({
    container: f.els.stripWs,
    height: f.els.stripWs.clientHeight || 96,
    waveColor: style.getPropertyValue("--color-waveform").trim() || "violet",
    progressColor:
      style.getPropertyValue("--color-waveform-progress").trim() || "purple",
    cursorWidth: 0,
    normalize: false,
    interact: false,
    autoScroll: false,
    autoCenter: false,
    peaks: [source.peaks],
    duration: source.duration,
  });
  const scrollEl = f.stripWS.getWrapper().parentElement;
  scrollEl.addEventListener("scroll", () => _scheduleRedraw(), {
    passive: true,
  });
  _updateStripWindow();
}

/** The current page's reference-time window (span of its onsets + padding). */
function _pageWindow() {
  const f = _fix;
  const times = _groupsOnPage(f.page)
    .map((g) => _groupRefTime(g))
    .filter((t) => Number.isFinite(t));
  const duration = f.stripSource?.duration || 0;
  if (!times.length) return { t0: 0, t1: duration || 1 };
  let t0 = Math.min(...times);
  let t1 = Math.max(...times);
  const pad = Math.max(STRIP_PAD_SEC, (t1 - t0) * STRIP_PAD_FRAC);
  return { t0: t0 - pad, t1: t1 + pad };
}

/** Zoom + scroll the strip so the current page's window fills it. */
function _updateStripWindow() {
  const f = _fix;
  if (!f.stripWS || !f.stripSource) return;
  const w = f.els.stripWs.clientWidth;
  if (!w) return;
  const { t0, t1 } = _pageWindow();
  const span = Math.max(t1 - t0, 0.5);
  const pps = w / span;
  f.stripPps = pps;
  f.stripWindow = { t0, t1 };
  try {
    f.stripWS.zoom(pps);
  } catch (_) {
    return; // renderer not ready yet; the next window update will land
  }
  const scrollEl = f.stripWS.getWrapper().parentElement;
  // scrollLeft floors at 0, so a window opening before t=0 (a negative first
  // onset, or padding past the start) shows from 0 — ticks stay honest
  // because the mapping below reads the actual scrollLeft.
  scrollEl.scrollLeft = Math.max(0, t0 * pps);
}

/** Reference time → x in strip-viewport (and container) coordinates. */
function _timeToStripX(t) {
  const f = _fix;
  if (!f.stripWS) return null;
  const scrollEl = f.stripWS.getWrapper().parentElement;
  return t * f.stripPps - scrollEl.scrollLeft;
}

function _stripXToTime(x) {
  const f = _fix;
  if (!f.stripWS || !f.stripPps) return null;
  const scrollEl = f.stripWS.getWrapper().parentElement;
  return (x + scrollEl.scrollLeft) / f.stripPps;
}

// ---------------------------------------------------------------------------
// Ticks + connectors + selection
// ---------------------------------------------------------------------------

function _scheduleRedraw() {
  const f = _fix;
  if (!f || f.raf) return;
  f.raf = requestAnimationFrame(() => {
    if (!_fix) return;
    _fix.raf = 0;
    _redrawOverlays();
  });
}

function _redrawOverlays() {
  const f = _fix;
  if (!f) return;
  const strip = f.els.strip;
  const canvas = f.els.ticks;
  const w = strip.clientWidth;
  const h = strip.clientHeight;
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, w, h);

  const rootRect = f.els.root.getBoundingClientRect();
  const stripRect = strip.getBoundingClientRect();
  const stripTopY = stripRect.y - rootRect.y;
  const scoreRect = f.els.scoreEl.getBoundingClientRect();
  const scoreBottomY = scoreRect.bottom - rootRect.y;

  const style = getComputedStyle(document.documentElement);
  const tickColor =
    style.getPropertyValue("--color-alignment").trim() || "rgb(140,90,90)";

  // Connectors rebuilt wholesale — a page has at most a few hundred onsets.
  const conn = f.els.conn;
  conn.setAttribute("viewBox", `0 0 ${f.els.root.clientWidth} ${f.els.root.clientHeight}`);
  conn.setAttribute("width", f.els.root.clientWidth);
  conn.setAttribute("height", f.els.root.clientHeight);
  while (conn.firstChild) conn.removeChild(conn.firstChild);

  const pageGroups = _groupsOnPage(f.page);
  const selGroup = f.groups[f.selGroupIx] || null;
  let ticksDrawn = 0;

  for (const g of pageGroups) {
    const t = _groupRefTime(g);
    if (!Number.isFinite(t)) continue;
    const x = _timeToStripX(t);
    if (x === null) continue;
    const selected = g === selGroup;
    // Tick: the vertical line on the strip — increment 3's drag handle.
    if (x >= -1 && x <= w + 1) {
      ctx.beginPath();
      ctx.lineWidth = selected ? 2 : 1;
      ctx.strokeStyle = tickColor;
      ctx.globalAlpha = selected ? 0.95 : 0.35;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
      if (selected) {
        ctx.beginPath();
        ctx.globalAlpha = 0.95;
        ctx.fillStyle = tickColor;
        ctx.moveTo(x - 5, 0);
        ctx.lineTo(x + 5, 0);
        ctx.lineTo(x, 7);
        ctx.closePath();
        ctx.fill();
      }
      ticksDrawn++;
    }
    ctx.globalAlpha = 1;
    // Connector: score position → straight down → bend across the gap onto
    // the strip tick (the ruled shape; faint, selected emphasised).
    if (g.xScore !== null) {
      const xt = stripRect.x - rootRect.x + x;
      if (xt < -40 || xt > f.els.root.clientWidth + 40) continue;
      const line = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "polyline",
      );
      line.setAttribute(
        "points",
        `${g.xScore},${g.yNote} ${g.xScore},${scoreBottomY} ${xt},${stripTopY}`,
      );
      line.setAttribute("class", selected ? "fix-conn fix-conn-sel" : "fix-conn");
      conn.appendChild(line);
    }
  }
  f.ticksOnPage = ticksDrawn;
}

/** Select onset group `ix`, turning the page to it when needed. */
function _select(ix) {
  const f = _fix;
  if (!f.groups.length) return;
  ix = Math.min(Math.max(0, ix), f.groups.length - 1);
  f.selGroupIx = ix;
  const g = f.groups[ix];
  if (g.page !== f.page) {
    _renderPage(g.page);
  }
  // Score highlight: clear the previous onset's notes, mark this one's.
  f.els.scoreSvg.querySelectorAll(".fix-note-sel").forEach((el) => {
    el.classList.remove("fix-note-sel");
  });
  for (const id of g.ids) {
    const el = f.pageIndex.get(id);
    if (el) el.classList.add("fix-note-sel");
  }
  _scheduleRedraw();
}

function _skipOnset(delta) {
  const f = _fix;
  _select(f.selGroupIx + delta);
}

function _onScoreClick(e) {
  const f = _fix;
  // Walk up from the clicked SVG node to an element the page index knows,
  // then to the onset group that sounds it.
  let el = e.target;
  while (el && el !== f.els.scoreSvg) {
    if (el.id && f.pageIndex.has(el.id)) {
      const ix = f.groups.findIndex((g) => g.ids.includes(el.id));
      if (ix !== -1) {
        _select(ix);
        return;
      }
    }
    el = el.parentElement;
  }
}

function _onTickClick(e) {
  const f = _fix;
  const rect = f.els.ticks.getBoundingClientRect();
  const x = e.clientX - rect.x;
  let best = -1;
  let bestDist = TICK_HIT_PX + 1;
  const pageGroups = _groupsOnPage(f.page);
  for (const g of pageGroups) {
    const t = _groupRefTime(g);
    if (!Number.isFinite(t)) continue;
    const gx = _timeToStripX(t);
    const d = Math.abs(gx - x);
    if (d < bestDist) {
      bestDist = d;
      best = f.groups.indexOf(g);
    }
  }
  if (best !== -1) _select(best);
}

async function _onResize() {
  const f = _fix;
  if (!f) return;
  // A resize changes the page geometry wholesale: re-lay-out, re-derive the
  // page model, and re-render around the current selection. On a large score
  // that is seconds of synchronous wasm, so the loading overlay goes up (and
  // paints) first.
  _showFixLoading("Re-fitting the score…");
  await _paintFrame();
  if (_fix !== f) return;
  const w = f.els.scoreEl.clientWidth;
  const h = f.els.scoreEl.clientHeight;
  _applyFixLayoutAt(w, h);
  _assignGroupPages(f.groups);
  // Keep the shared derived cache describing the CURRENT resident layout.
  if (_derived) {
    _derived.dims = { w, h };
    _derived.pageCount = tk.getPageCount();
    _derived.svgCache.clear();
  }
  f.pageCount = tk.getPageCount();
  const g = f.groups[f.selGroupIx];
  _renderPage(g ? g.page : 1);
  _select(f.selGroupIx);
  _hideFixLoading();
}

// ---------------------------------------------------------------------------
// Correction-engine bootstrap (decode ref audio + the worker's fix_begin)
// ---------------------------------------------------------------------------

/** Decode the reference recording to mono Float32 at the aligner's rate —
 *  the same construction as align.js's decodeAudio. */
async function _decodeRefAudio(refFile) {
  const blob = fileBlobs.get(refFile);
  let arrayBuf;
  if (blob) {
    arrayBuf = await blob.arrayBuffer();
  } else {
    const url = resolveAudioUrl(refFile);
    if (!url) throw new Error("no audio source for the reference recording");
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`could not fetch reference audio (HTTP ${resp.status})`);
    arrayBuf = await resp.arrayBuffer();
  }
  const audioCtx = new AudioContext();
  const decoded = await audioCtx.decodeAudioData(arrayBuf);
  await audioCtx.close();
  const offlineCtx = new OfflineAudioContext(
    1,
    Math.ceil(decoded.duration * FIX_SR),
    FIX_SR,
  );
  const source = offlineCtx.createBufferSource();
  source.buffer = decoded;
  source.connect(offlineCtx.destination);
  source.start(0);
  const resampled = await offlineCtx.startRendering();
  return resampled.getChannelData(0);
}

/** Max-abs peaks from decoded samples, for a strip sharper than stored peaks. */
function _peaksFromSamples(samples, count = STRIP_PEAK_COUNT) {
  const peaks = new Array(count);
  const per = samples.length / count;
  for (let i = 0; i < count; i++) {
    const lo = Math.floor(i * per);
    const hi = Math.min(samples.length, Math.ceil((i + 1) * per));
    let m = 0;
    for (let j = lo; j < hi; j++) {
      const v = Math.abs(samples[j]);
      if (v > m) m = v;
    }
    peaks[i] = m;
  }
  return peaks;
}

function _ensureWorker() {
  if (_worker) return _worker;
  const factory =
    window._listenTest?.fixWorkerFactory || ((url) => new Worker(url));
  _worker = factory(window.root + "js/align-worker.js");
  return _worker;
}

async function _bootstrap() {
  const f = _fix;
  _setChip("decoding", "Preparing correction engine: decoding reference audio…");
  const samples = await _decodeRefAudio(f.refFile);
  if (!_fix || _fix !== f) return; // exited while decoding

  // A decode also upgrades (or provides) the strip: peaks derived from the
  // full-rate samples beat the stored ~4k-point envelope at page zoom.
  const duration = samples.length / FIX_SR;
  _buildStrip({ peaks: _peaksFromSamples(samples), duration });
  _scheduleRedraw();

  _setChip("loading", "Preparing correction engine: loading alignment runtime…");
  const worker = _ensureWorker();
  worker.onmessage = (e) => {
    if (!_fix || _fix !== f) return;
    const d = e.data;
    if (d.type === "progress") {
      _setChip("loading", `Preparing correction engine: ${d.message}`);
    } else if (d.type === "fix_ready") {
      _workerHasSession = true;
      if (d.events?.n_events !== f.nEvents) {
        _setChip(
          "error",
          `Correction engine disagrees on the event count ` +
            `(${d.events?.n_events} vs ${f.nEvents}) — corrections disabled`,
        );
        return;
      }
      f.workerEvents = d.events;
      _setChip("ready", "Correction engine ready");
    } else if (d.type === "error") {
      _setChip("error", `Correction engine failed: ${d.message}`);
    }
  };
  worker.onerror = (e) => {
    if (!_fix || _fix !== f) return;
    _setChip("error", `Correction engine failed: ${e.message || "worker error"}`);
  };
  worker.postMessage(
    {
      type: "fix_begin",
      refSamples: samples,
      meiMidi: f.midiBytes,
      options: loadedAlignmentJSON?.header?.alignmentParams || {},
    },
    [samples.buffer],
  );
}

// ---------------------------------------------------------------------------
// Test surface (read by listen.js's window._listenTest)
// ---------------------------------------------------------------------------

export function fixTestState() {
  if (!_fix) {
    return {
      active: false,
      lastRefusal: _lastRefusal,
      prewarmReady: !!(_derived && _derived.pageCount),
      lastEntry: { ..._lastEntry },
    };
  }
  const f = _fix;
  return {
    active: true,
    lastRefusal: _lastRefusal,
    prewarmReady: !!(_derived && _derived.pageCount),
    lastEntry: { ..._lastEntry },
    mode: f.mode,
    entryFile: f.entryFile,
    refFile: f.refFile,
    nEvents: f.nEvents,
    groupCount: f.groups.length,
    page: f.page,
    pageCount: f.pageCount,
    pageGroupCount: _groupsOnPage(f.page).length,
    selGroup: f.selGroupIx,
    selQ: f.groups[f.selGroupIx]?.q ?? null,
    selPage: f.groups[f.selGroupIx]?.page ?? null,
    ticksOnPage: f.ticksOnPage ?? 0,
    connectorCount: f.els.conn?.childElementCount ?? 0,
    stripWindow: f.stripWindow || null,
    stripHasWave: !!f.stripWS,
    chipState: f.chipState,
  };
}
