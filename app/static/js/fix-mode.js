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
// Increment 2 built the SCREEN — inspection, selection, paging, and the
// correction-engine bootstrap (ref-audio decode + the worker's fix_begin).
// Increment 3 adds THE LOOP on top of it:
//   - the ORIENTATION slice: L/R audition playback (left = the real reference
//     recording, right = the score synth rendered through the CURRENT
//     corrected map, sample-locked — §13 ruling 2's construction, live), a
//     playback-following sounding-onset highlight, and seek-to-selected-note;
//   - the EDIT gestures: dragging a strip tick lays a hard anchor
//     (auto-realign of the flanking segments on release via the worker's
//     fix_realign, then auto-replay from just before the previous anchor),
//     Enter APPROVEs the selected onset as a zero-drag anchor, and M lays
//     session-local MARKS on the audio timeline (N skips to the next one);
//   - GLOBAL undo: fix-anchor entries ride listen.js's unified stack with
//     snapshot semantics (before/after values stored — undo and redo never
//     need the alignment worker).
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
  pushFixUndoEntry,
} from "./listen.js";
import {
  verifyQuarters,
  createCorrections,
  findAnchor,
  neighbourAnchors,
  setAnchor,
  applySegment,
  applyAnchorValue,
  serialize as serializeCorrections,
  deserialize as deserializeCorrections,
} from "./engine/correction-model.js";
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
/** The granular time-stretch worklet behind the header's speed slider. */
const FIX_STRETCH_WORKLET_URL = "/static/js/fix-stretch-worklet.js";
/**
 * The audition's minimum SOUNDING length, the renderer's alone — it never
 * touches ref_offset. Alignment data legitimately holds very short notes
 * (11.6% of the Fledermaus HQ corpus is under 70 ms, 2.3% under 20 ms, the
 * shortest 0.6 ms: tremolo strokes, grace notes, collapsed offsets), and a
 * correction can shrink a note to the gap it was dropped into. Rendered at
 * their true length those notes are inaudible, and silence is the worst
 * possible symptom for a data problem: it reads as the tool ignoring the fix.
 * A floored note is heard as a short click — the problem stays audible AS a
 * problem, while the commit log and the degenerate canary name it.
 *
 * The floor is bounded by the gap to the next onset, because it is only the
 * ISOLATED short note that goes missing. 96% of that corpus's sub-70 ms notes
 * have their next onset within 70 ms (median 15 ms) — tremolo strokes and fast
 * runs — and lengthening each of those would smear the passage into a cluster
 * chord while fixing nothing: their neighbours already sound around them.
 */
const MIN_SOUND_SEC = 0.07;

/** Seek-to-selected-note lands the playhead this far before the onset. */
const SEEK_PREROLL_SEC = 0.5;
/** Auto-replay after a fix starts this far before the previous anchor. */
const REPLAY_PREROLL_SEC = 0.5;
/** ...but never more than this before the fix itself. The previous anchor can
 *  be a page away when anchoring into virgin territory, and the replay's
 *  principled start (the whole invalidated span) is then unusable — this is
 *  the ceiling that makes it predictable. */
const MAX_RUNUP_SEC = 2;
/** A mousedown that travels less than this is a tick CLICK, not a drag. */
const DRAG_THRESHOLD_PX = 3;
/**
 * The playhead BRACKET: two filled arrowheads marking the position from
 * either side of the waveform, with no line drawn across it. A vertical line
 * is the alignment tick's own shape, and the two read as one another on a
 * screen whose whole job is judging instants. Two opposed marks also read
 * more precisely than one — the eye interpolates the line between them.
 *
 * The TOP arrowhead sits just inside the strip's top edge rather than above
 * it: every onset group's score connector terminates exactly at the strip
 * top and the session marks draw as diamond flags along that same line, so
 * above the strip is the busiest region on the screen. The bottom edge is
 * clear, and the waveform stops short of it (`--fix-strip-gutter`) so the
 * lower arrowhead sits outside the waveform entirely.
 *
 * Shape vocabulary, which does more disambiguating work than colour:
 * hairline = alignment tick, diamond = session mark, filled triangle =
 * playhead. That is also why the selected tick's own cap is a bar, not the
 * triangle it used to be.
 */
const PH_ARROW_HALF_W = 5.5;
const PH_ARROW_H = 8;
/** Keyboard nudge steps (the app's marker-nudge convention: Shift = coarse,
 *  Shift+Alt = fine). Nudges accumulate while any nudge key is held and
 *  commit as ONE anchor on full release — the keyup that leaves no nudge key
 *  down (per-keystroke realigns would spam worker and undo stack, and a
 *  quiet-period timer cut in while the user was still adjusting). */
const NUDGE_COARSE_SEC = 0.1;
const NUDGE_FINE_SEC = 0.02;
/** Arrow keys physically down right now (modifier state rides each keyup). */
const _heldArrows = new Set();
/** Anchor times clamp this far inside the neighbouring anchors' times. */
const ANCHOR_EPS_SEC = 0.01;
/** M within this distance of an existing mark removes it instead of adding. */
const MARK_HIT_SEC = 0.35;

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
/**
 * Piece-scoped correction state (plan §14 cluster B): the anchor/gap model,
 * the as-loaded ref tables for Revert (captured lazily at the first commit),
 * and the session MARKS (flagged misalignments on the audio timeline — QA
 * aids, deliberately neither persisted nor undoable). All of it outlives a
 * fix-mode exit and dies with the piece (fixModePrewarm resets it per load).
 */
let _corrections = createCorrections();
let _pristine = null; // { on: number[], off: number[] } — as-loaded ref tables
let _marks = []; // sorted reference times
/** The mark the last N-jump landed on, recoloured as ACTIVE; Delete removes
 *  it (M's hit test misses after a jump — the preroll parks 0.5 s away). */
let _activeMarkT = null;
/** Base-alignment provenance for header.corrections (item-T's data). */
let _correctionsBase = null;
/** The as-loaded correction record, for Revert and dirtiness (JSON of
 *  {a: anchors, g: gaps}; "no record" is the empty pair, not null). */
let _loadedCorrectionsJson = JSON.stringify({ a: [], g: [] });
/** The one in-flight fix_realign request, or null (the worker is serial). */
let _pendingRealign = null;
/** The last off-screen undo/redo announcement (test surface). */
let _lastAnnounce = null;
let _announceTimer = null;
/** Audition L/R balance, −1 (recording only) … +1 (synth only); 0 = even.
 *  A listening-ergonomics preference, so it survives sessions and pieces. */
let _audBalance = 0;
/** Page-only playback: the audition stops at the current page's boundary
 *  instead of turning it (sticky across fix sessions, like the balance). */
let _pageOnly = false;
/** Suppress the AUTO-replay after a commit (sticky, like _pageOnly). The
 *  commit itself always happens: it is being dragged back through the span
 *  that gets in the way in a tight cluster, not the anchoring. A sticky mode
 *  rather than a held modifier, because the nudge already owns Shift and
 *  Shift+Alt and commits on the keyup that leaves no nudge key down. */
let _replaySuppressed = false;
/** The last committed fix's replay span, so R can replay it on demand. */
let _lastReplay = null;

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

/** Whether a fix's segment realign is in flight (undo/redo must wait: the
 *  commit's continuation still holds the data it will splice). */
export function fixRealignBusy() {
  return !!_fix?.realignBusy;
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
    aud: null, // the L/R audition (built by the bootstrap's decode)
    drag: null, // an in-progress tick drag, or null
    engineReady: false, // fix_ready arrived with a matching event count
    realignBusy: false,
    soundingGroupIx: null,
    followFloor: null, // { ix, untilT } — holds the follower after a seek
    pageOnlyPassUntilT: null, // a replay/mark jump may cross pages until here
    keydownHandler: null,
    keyupHandler: null,
    blurHandler: null,
    lastCommit: null, // test surface: what the last anchor commit did
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
  const paneSizeKey = () =>
    `${f.els.scoreEl.clientWidth}x${f.els.scoreEl.clientHeight}|` +
    `${f.els.stripWs.clientWidth}`;
  f.lastPaneSize = paneSizeKey();
  f.resizeObserver = new ResizeObserver(() => {
    if (_fix !== f) return;
    const size = paneSizeKey();
    // A hidden (zero-sized) pane must not re-lay-out to the fallback page
    // dimensions; the relayout runs when it comes back.
    if (size === f.lastPaneSize || size.startsWith("0x0")) return;
    f.lastPaneSize = size;
    clearTimeout(f.resizeDebounce);
    f.resizeDebounce = setTimeout(() => {
      if (_fix === f) _onResize();
    }, 150);
  });
  f.resizeObserver.observe(f.els.scoreEl);
  f.resizeObserver.observe(f.els.stripWs);

  // Fix mode owns the keyboard while it is open: listen.js's global handler
  // stands down via isFixModeActive() (the conscious resolution of the
  // increment-2 deferral), and this document-level handler takes over.
  // Ctrl+Z / Ctrl+Shift+Z stay with listen.js — undo is GLOBAL by ruling.
  f.keydownHandler = (e) => _onFixKeydown(e);
  document.addEventListener("keydown", f.keydownHandler);
  // A floating keyboard nudge commits on full release (see _onFixKeyup); a
  // window blur can eat that keyup, so it commits the nudge instead — a
  // pending nudge is never silently abandoned.
  f.keyupHandler = (e) => _onFixKeyup(e);
  document.addEventListener("keyup", f.keyupHandler);
  f.blurHandler = () => {
    _heldArrows.clear();
    _commitPendingNudge();
  };
  window.addEventListener("blur", f.blurHandler);

  // The engine bootstrap (decode + fix_begin) runs in the background; the
  // screen is usable for inspection while it loads, and the loop's realign
  // and audition wait on it.
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
  if (f.keydownHandler) {
    document.removeEventListener("keydown", f.keydownHandler);
    f.keydownHandler = null;
  }
  if (f.keyupHandler) {
    document.removeEventListener("keyup", f.keyupHandler);
    f.keyupHandler = null;
  }
  if (f.blurHandler) {
    window.removeEventListener("blur", f.blurHandler);
    f.blurHandler = null;
  }
  _heldArrows.clear();
  _endDrag(f);
  _auditionDispose(f);
  if (_pendingRealign) {
    _pendingRealign.reject(new Error("fix mode exited"));
    _pendingRealign = null;
  }
  try {
    f.stripWS?.destroy();
  } catch (_) {}
  f.els.root?.remove();
  document.body.classList.remove("fix-mode-open");
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
  // The replay span belongs to THIS session's recording: a re-entry (or a
  // different reference row) must not let R seek to times that no longer
  // mean anything. The suppression MODE is deliberately sticky, unlike this.
  _lastReplay = null;
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
  // A (re)loaded piece invalidates the piece-scoped correction state too.
  _corrections = createCorrections();
  _pristine = null;
  _marks = [];
  _activeMarkT = null;
  _lastMarkJumpT = null;
  _lastAnnounce = null;
  _correctionsBase = null;
  _loadedCorrectionsJson = JSON.stringify({ a: [], g: [] });
  if (_pendingRealign) {
    _pendingRealign.reject(new Error("piece replaced"));
    _pendingRealign = null;
  }
  if (!_fixModeParamPresent()) return;
  // A previously saved correction record resumes: its anchors join the live
  // model so this session's edits EXTEND the durable record instead of
  // clobbering it on the next save. (Without ?fixMode the record just rides
  // through loadedAlignmentJSON untouched.)
  const record = loadedAlignmentJSON?.header?.corrections;
  if (record) {
    try {
      const { state, base } = deserializeCorrections(record);
      _corrections = state;
      _correctionsBase = base;
      _loadedCorrectionsJson = JSON.stringify({
        a: _corrections.anchors,
        g: _corrections.gaps,
      });
      console.log(
        `fix mode: resumed ${state.anchors.length} anchors and ` +
          `${state.gaps.length} gaps from header.corrections`,
      );
    } catch (e) {
      console.warn("fix mode: could not resume header.corrections —", e.message);
    }
  }
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
/** MIDI quarters that may differ between the rendered MIDI and the timemap
 *  for the SAME notated event: grace notes land a tick or two apart, so the
 *  match is nearest-within-tolerance, far below any real inter-onset gap. */
const GROUP_MATCH_TOL_Q = 0.02;
/** A sounding event with no notated entry of its own (a tremolo stroke: the
 *  MIDI expands measured tremolos, the timemap only carries the written
 *  note) inherits the ids of the preceding notated event, if it is close
 *  enough to plausibly be its generator. */
const GROUP_INHERIT_MAX_Q = 4;

function _buildGroupsFrom(qOn) {
  // Do NOT filter out entries carrying measureOn (as the tempo derivation
  // does): a measure boundary coincides with a note onset, so such entries
  // carry the very ids this map exists for — q=0 always among them.
  const entries = timemap
    .filter((e) => "qstamp" in e && Array.isArray(e.on) && e.on.length)
    .map((e) => ({ q: e.qstamp, on: e.on }))
    .sort((a, b) => a.q - b.q);
  const nearestEntry = (q) => {
    let lo = 0;
    let hi = entries.length - 1;
    if (hi < 0) return null;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (entries[mid].q < q) lo = mid + 1;
      else hi = mid;
    }
    let best = entries[lo];
    if (lo > 0 && Math.abs(entries[lo - 1].q - q) < Math.abs(best.q - q)) {
      best = entries[lo - 1];
    }
    return Math.abs(best.q - q) <= GROUP_MATCH_TOL_Q ? best : null;
  };
  const groups = [];
  let cur = null;
  let lastNotated = null; // { q, ids } of the last directly matched group
  let inherited = 0;
  let orphaned = 0;
  for (let i = 0; i < qOn.length; i++) {
    const k = qKey(qOn[i]);
    if (!cur || cur.k !== k) {
      const q = qOn[i];
      const entry = nearestEntry(q);
      let ids;
      if (entry) {
        ids = entry.on;
        lastNotated = { q, ids };
      } else if (lastNotated && q - lastNotated.q <= GROUP_INHERIT_MAX_Q) {
        ids = lastNotated.ids; // e.g. the 2nd/3rd strokes of a tremolo
        inherited++;
      } else {
        ids = [];
        orphaned++;
      }
      cur = { k, q, eventIxs: [], ids, page: 0, xScore: null };
      groups.push(cur);
    }
    cur.eventIxs.push(i);
  }
  _lastGroupStats = { matched: groups.length - inherited - orphaned, inherited, orphaned };
  if (inherited || orphaned) {
    console.log(
      `fix mode: of ${groups.length} onsets, ${inherited} have no own ` +
        `timemap entry and attach to their generating note (tremolo ` +
        `strokes), ${orphaned} found nothing to attach to`,
    );
  }
  return groups;
}

/** How the last group build resolved score elements (test surface). */
let _lastGroupStats = null;

/** A group's CURRENT reference time — read live, so refills show through. */
function _groupRefTime(group) {
  return scoreAlignment.ref_onset[group.eventIxs[0]];
}

/** The reference recording's duration — the correction model's upper corner.
 *  The decoded audition is exact; the worker's fix_ready and the stored strip
 *  peaks agree to within a frame, which is all the corner bound needs. */
function _refDuration() {
  const f = _fix;
  return (
    f?.aud?.duration ??
    f?.workerEvents?.ref_duration ??
    f?.stripSource?.duration ??
    0
  );
}

// ---------------------------------------------------------------------------
// DOM skeleton
// ---------------------------------------------------------------------------

function _buildDom(contentEl, waveformsEl) {
  const f = _fix;
  waveformsEl.style.display = "none";
  // Annotation chrome stands down while correcting: the ribbon is irrelevant
  // here AND is fixed to the viewport bottom, where it covered the strip's
  // lower 40 px — the anchor glyphs among them. The pencil tab goes with it,
  // because the drawer it opens pads the body by 380 px, which would resize
  // the score pane (and its prewarmed fit) mid-session.
  document.body.classList.add("fix-mode-open");

  const root = document.createElement("div");
  root.id = "fix-mode";

  const header = document.createElement("div");
  header.className = "fix-header";

  const exitBtn = document.createElement("button");
  exitBtn.type = "button";
  exitBtn.id = "fix-exit";
  exitBtn.textContent = "✕ Exit correction mode";
  exitBtn.addEventListener("click", () => exitFixMode());

  const playBtn = document.createElement("button");
  playBtn.type = "button";
  playBtn.id = "fix-play";
  playBtn.textContent = "⏵";
  playBtn.disabled = true;
  playBtn.title =
    "Play audition (left ear: the recording, right ear: the aligned synth) — Space";
  playBtn.addEventListener("mousedown", (e) => e.preventDefault());
  playBtn.addEventListener("click", () => _audToggle());

  // Page-only playback toggle: play stops at the current page's boundary.
  const pageOnlyBtn = document.createElement("button");
  pageOnlyBtn.type = "button";
  pageOnlyBtn.id = "fix-page-only";
  pageOnlyBtn.textContent = "Page only";
  pageOnlyBtn.title =
    "Play only the current page — playback stops at the page boundary";
  pageOnlyBtn.setAttribute("aria-pressed", String(_pageOnly));
  pageOnlyBtn.addEventListener("mousedown", (e) => e.preventDefault());
  pageOnlyBtn.addEventListener("click", () => {
    _pageOnly = !_pageOnly;
    pageOnlyBtn.setAttribute("aria-pressed", String(_pageOnly));
    if (_fix) _fix.pageOnlyPassUntilT = null;
  });

  // Auto-replay suppression (sticky). Pressed = no replay after a commit;
  // R replays the last fix on demand.
  const replayBtn = document.createElement("button");
  replayBtn.type = "button";
  replayBtn.id = "fix-replay-off";
  replayBtn.textContent = "Replay off";
  replayBtn.title =
    "Suppress the automatic replay after each fix (the fix is still " +
    "committed) — R replays the last fix on demand";
  replayBtn.setAttribute("aria-pressed", String(_replaySuppressed));
  replayBtn.addEventListener("mousedown", (e) => e.preventDefault());
  replayBtn.addEventListener("click", () => {
    _replaySuppressed = !_replaySuppressed;
    replayBtn.setAttribute("aria-pressed", String(_replaySuppressed));
  });

  // Playback speed (pitch preserved via the stretch worklet). The % button
  // is the "back to 100%" affordance and lights up whenever speed ≠ 100%.
  const speed = document.createElement("span");
  speed.className = "fix-speed";
  speed.title =
    "Playback speed (pitch preserved) — click the % to return to 100%";
  const speedInput = document.createElement("input");
  speedInput.type = "range";
  speedInput.min = "50";
  speedInput.max = "100";
  speedInput.step = "5";
  speedInput.value = "100";
  speedInput.disabled = true; // enabled once the stretch worklet attaches
  speedInput.setAttribute("aria-label", "Playback speed (%)");
  const speedReset = document.createElement("button");
  speedReset.type = "button";
  speedReset.className = "fix-speed-reset";
  speedReset.textContent = "100%";
  speedReset.title = "Back to full speed";
  speedReset.disabled = true;
  speedInput.addEventListener("input", () => {
    _audSetRate(Number(speedInput.value) / 100);
  });
  // Give the keyboard back once the thumb is released (as the balance does).
  speedInput.addEventListener("pointerup", () => speedInput.blur());
  speedReset.addEventListener("mousedown", (e) => e.preventDefault());
  speedReset.addEventListener("click", () => {
    _audSetRate(1);
  });
  speed.append(speedInput, speedReset);

  // Real-time L/R balance: left ear = the recording, right ear = the synth.
  const balance = document.createElement("span");
  balance.className = "fix-balance";
  balance.title =
    "Audition balance — left ear: the recording, right ear: the aligned synth";
  const balanceL = document.createElement("span");
  balanceL.textContent = "rec";
  const balanceInput = document.createElement("input");
  balanceInput.type = "range";
  balanceInput.min = "-100";
  balanceInput.max = "100";
  balanceInput.step = "5";
  balanceInput.value = String(Math.round(_audBalance * 100));
  balanceInput.setAttribute("aria-label", "Audition balance (recording ↔ synth)");
  const balanceR = document.createElement("span");
  balanceR.textContent = "synth";
  balanceInput.addEventListener("input", () => {
    _audBalance = Number(balanceInput.value) / 100;
    if (_fix?.aud) _applyAudBalance(_fix.aud);
  });
  // Give the keyboard back to the fix screen once the thumb is released
  // (a focused range input would otherwise swallow the arrow keys).
  balanceInput.addEventListener("pointerup", () => balanceInput.blur());
  balance.append(balanceL, balanceInput, balanceR);

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

  header.append(
    exitBtn,
    playBtn,
    pageOnlyBtn,
    replayBtn,
    speed,
    balance,
    title,
    pageCtl,
    chip,
  );

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
  ticks.addEventListener("mousedown", (e) => _onTickMouseDown(e));
  // The playhead (and drag ghosting) repaints every frame during playback; it
  // gets its own canvas so the tick/connector rebuild stays selection-rate.
  const playhead = document.createElement("canvas");
  playhead.className = "fix-playhead";
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
  strip.append(stripWs, ticks, playhead, skipPrev, skipNext);

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
    playhead,
    conn,
    pageLabel,
    chip,
    title,
    playBtn,
    speedWrap: speed,
    speedInput,
    speedReset,
    loading,
    loadingText,
  };
  f.playheadColor =
    getComputedStyle(document.documentElement)
      .getPropertyValue("--color-playhead")
      .trim() || "#2563eb";
  // The active mark borrows close-listening's active-marker colour.
  f.markActiveColor =
    getComputedStyle(document.documentElement)
      .getPropertyValue("--color-marker-active")
      .trim() || "#8b0000";
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

function _setChip(state, text, full) {
  if (!_fix) return;
  _fix.chipState = state;
  _fix.els.chip.dataset.state = state;
  _fix.els.chip.textContent = text;
  // The chip is ellipsised on purpose (the header must hold ONE line, whose
  // height feeds the prewarm fit), so the untruncated message lives in the
  // tooltip — `full` when the short form dropped something.
  _fix.els.chip.title = full || text;
}

/**
 * While the engine is arming, the strip reads as not-yet-live: the ticks dim
 * and the cursor says wait. The marker a user reaches for first is bottom
 * left and the chip is top right, so "why will this not move" has to be
 * answerable without looking away from the marker.
 */
function _syncReadyAffordance() {
  const f = _fix;
  if (!f) return;
  const pending = !f.engineReady;
  f.els.strip.classList.toggle("fix-strip-pending", pending);
  f.els.ticks.classList.toggle("fix-ticks-pending", pending);
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
    // ONE system per page (user ruling, feedback round 2): several systems on
    // one page make the connectors cross along x, so a "page" in fix mode is
    // a single system — broken where the encoder put the sb/pb when the MEI
    // has encoded breaks, else where Verovio's auto layout breaks (an MEI
    // with no breaks at all must not collapse into one giant system).
    breaks: /<[sp]b[\s/>]/.test(getMeiXml() || "") ? "line" : "auto",
    systemMaxPerPage: 1,
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
  _buildPageGeometry(page);
  f.els.pageLabel.textContent = `Page ${page} / ${f.pageCount}`;
  _updateStripWindow();
  _scheduleRedraw();
  _schedulePlayheadFrame();
}

/**
 * The outer page svg's letterboxed content box: where its viewBox actually
 * paints, in screen coordinates, plus the px-per-viewBox-unit scale. Plain
 * meet arithmetic on getBoundingClientRect + viewBox — deliberately NOT
 * getScreenCTM, which proved unreliable for nested SVGs across browsers
 * (Firefox mapped underlay x positions to the far left of the page; both
 * feedback-round bugs in this geometry traced to platform CTM reads).
 */
function _scoreContentBox() {
  const outer = _fix?.els.scoreSvg.querySelector("svg");
  if (!outer) return null;
  const oRect = outer.getBoundingClientRect();
  const vb = outer.viewBox?.baseVal;
  if (!(vb && vb.width > 0 && vb.height > 0 && oRect.width && oRect.height)) {
    return null;
  }
  const scale = Math.min(oRect.width / vb.width, oRect.height / vb.height);
  if (!(scale > 0)) return null;
  return {
    outer,
    scale,
    vbWidth: vb.width,
    vbHeight: vb.height,
    left: oRect.left + (oRect.width - vb.width * scale) / 2,
    top: oRect.top + (oRect.height - vb.height * scale) / 2,
  };
}

/**
 * Per-page connector geometry. The IN-SCORE part of each connector is a
 * vertical line spanning from the HIGHEST element sounding at the onset down
 * to the page box's bottom, injected into the page SVG as its first-painted
 * child — beneath every score element (staff lines included: one line cannot
 * sit between all staves' lines and all their notes in SVG paint order, and
 * at this width the difference is invisible). The lines live in the OUTER
 * svg's viewBox units, converted from screen rects by _scoreContentBox's
 * arithmetic. The overlay polyline continues from the content bottom to the
 * strip.
 */
/**
 * Where the letterboxed score content ends vertically, in SCREEN coordinates.
 * Computed fresh at every use — a value cached while the pane was hidden or
 * mid-transition paints connectors from the wrong height for the whole page.
 */
function _scoreContentBottomScreen() {
  const box = _scoreContentBox();
  return box ? box.top + box.vbHeight * box.scale : null;
}

function _buildPageGeometry(page) {
  const f = _fix;
  const rootRect = f.els.root.getBoundingClientRect();
  f.underlayByGroup = new Map();
  const box = _scoreContentBox();
  // px per viewBox unit, inverted: attribute values (stroke width included)
  // are in the outer svg's user units.
  f.underlayUnitsPerPx = box ? 1 / box.scale : 0;
  const svgNS = "http://www.w3.org/2000/svg";
  const underlay = document.createElementNS(svgNS, "g");
  underlay.classList.add("fix-underlay");
  for (const g of f.groups) {
    g.xScore = null;
    if (g.page !== page || !g.ids.length) continue;
    let xSum = 0;
    let n = 0;
    let yTopScreen = Infinity;
    for (const id of g.ids) {
      const el = f.pageIndex.get(id);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      xSum += r.x + r.width / 2;
      yTopScreen = Math.min(yTopScreen, r.top);
      n++;
    }
    if (!n) continue;
    const xScreen = xSum / n;
    g.xScore = xScreen - rootRect.x;
    if (box) {
      // Screen → outer viewBox units by the same meet arithmetic that placed
      // the content. The bottom end is the page box's own bottom — a pure
      // SVG-space value, immune to whatever the pane was doing on screen.
      const x = (xScreen - box.left) / box.scale;
      const y1 = (yTopScreen - box.top) / box.scale;
      if (!(y1 < box.vbHeight)) continue; // degenerate geometry: no line
      const line = document.createElementNS(svgNS, "line");
      line.setAttribute("x1", x.toFixed(1));
      line.setAttribute("y1", y1.toFixed(1));
      line.setAttribute("x2", x.toFixed(1));
      line.setAttribute("y2", box.vbHeight.toFixed(1));
      f.underlayByGroup.set(g, line);
      underlay.appendChild(line);
    }
  }
  // First-painted child of the page svg: beneath the definition-scale svg
  // that holds every score element (desc/defs/style render nothing).
  if (underlay.childNodes.length && box) {
    box.outer.insertBefore(underlay, box.outer.firstChild);
  }
  _applyUnderlaySelection();
}

/** The selected onset's in-score line is emphasised; the rest stay faint. */
function _applyUnderlaySelection() {
  const f = _fix;
  if (!f?.underlayByGroup) return;
  const sel = f.groups[f.selGroupIx];
  for (const [g, line] of f.underlayByGroup) {
    const selected = g === sel;
    line.classList.toggle("fix-underlay-sel", selected);
    line.setAttribute(
      "stroke-width",
      ((selected ? 1.8 : 1.2) * f.underlayUnitsPerPx).toFixed(1),
    );
  }
}

function _turnPage(delta) {
  const f = _fix;
  _commitPendingNudge();
  const page = Math.min(Math.max(1, f.page + delta), f.pageCount);
  if (page === f.page) return;
  // Keep the selection meaningful: land it on the new page's first onset.
  const first = f.groups.findIndex((g) => g.page === page);
  if (first !== -1) _select(first, { seek: true });
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
  // WaveSurfer decodes ASYNCHRONOUSLY even when the peaks and duration are
  // handed over at construction (loadAudio awaits before setting decodedData),
  // so the synchronous call below is refused — `zoom()` throws "No audio
  // loaded" — and the strip was left at whole-piece zoom until the next page
  // turn happened to call this again. The ticks meanwhile used the page
  // window's scale, so the waveform under them was a DIFFERENT stretch of
  // audio: the shape disagreed with every tick and with the playhead, which
  // is what "the playhead lags" turned out to be on first entry (user repro,
  // 2026-08-31: enter → page forward → page back gives three different
  // waveforms for the same page). Applying it again on `ready` is the fix;
  // the synchronous attempt stays because it sets the tick scale immediately.
  const ws = f.stripWS;
  ws.once("ready", () => {
    if (_fix !== f || f.stripWS !== ws) return;
    _updateStripWindow();
    _scheduleRedraw();
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

/**
 * The waveform's bottom edge inside the strip. The strip is taller than its
 * waveform by the CSS gutter the playhead's lower arrowhead lives in; ticks,
 * anchor glyphs and drag ghosts all stop here so that gutter stays the
 * playhead's alone. Derived from the two elements rather than a duplicated
 * constant: the CSS is the single source of the gutter's size.
 */
function _waveBottomY() {
  const f = _fix;
  const h = f.els.strip.clientHeight;
  const waveH = f.els.stripWs.clientHeight;
  return waveH > 0 && waveH <= h ? waveH : h;
}

function _redrawOverlays() {
  const f = _fix;
  if (!f) return;
  const strip = f.els.strip;
  const canvas = f.els.ticks;
  const w = strip.clientWidth;
  const h = strip.clientHeight;
  const wb = _waveBottomY();
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, w, h);

  const rootRect = f.els.root.getBoundingClientRect();
  const stripRect = strip.getBoundingClientRect();
  const stripTopY = stripRect.y - rootRect.y;
  const scoreRect = f.els.scoreEl.getBoundingClientRect();
  const scoreBottomY = scoreRect.bottom - rootRect.y;
  const _cbs = _scoreContentBottomScreen();
  const contentBottomY = _cbs === null ? null : _cbs - rootRect.y;

  const style = getComputedStyle(document.documentElement);
  const tickColor =
    style.getPropertyValue("--color-alignment").trim() || "rgb(140,90,90)";

  // Connectors rebuilt wholesale — a page has at most a few hundred onsets.
  const conn = f.els.conn;
  conn.setAttribute("viewBox", `0 0 ${f.els.root.clientWidth} ${f.els.root.clientHeight}`);
  conn.setAttribute("width", f.els.root.clientWidth);
  conn.setAttribute("height", f.els.root.clientHeight);
  while (conn.firstChild) conn.removeChild(conn.firstChild);

  // No strip scale yet (the pane was zero-sized when the window was last
  // computed): draw nothing rather than a fan collapsed onto x = 0. The next
  // page render or resize recomputes the window and redraws.
  if (!f.stripPps) {
    f.ticksOnPage = 0;
    return;
  }
  const pageGroups = _groupsOnPage(f.page);
  const selGroup = f.groups[f.selGroupIx] || null;
  const dragGroup =
    f.drag && f.drag.moved && f.drag.editable
      ? f.groups[f.drag.groupIx]
      : null;
  let ticksDrawn = 0;

  for (const g of pageGroups) {
    const dragging = g === dragGroup;
    const t = dragging ? f.drag.curT : _groupRefTime(g);
    if (!Number.isFinite(t)) continue;
    const x = _timeToStripX(t);
    if (x === null) continue;
    const selected = g === selGroup;
    const anchor = findAnchor(_corrections, g.eventIxs[0]);
    // Tick: the vertical line on the strip — the loop's drag handle.
    if (x >= -1 && x <= w + 1) {
      ctx.beginPath();
      ctx.lineWidth = selected || anchor ? 2 : 1;
      ctx.strokeStyle = tickColor;
      ctx.globalAlpha = selected || dragging ? 0.95 : anchor ? 0.7 : 0.35;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, wb);
      ctx.stroke();
      if (selected) {
        // A CAP, not the arrowhead this used to be: the filled triangle now
        // belongs to the playhead alone, and the two sat at the same height
        // in the same few pixels.
        ctx.globalAlpha = 0.95;
        ctx.fillStyle = tickColor;
        ctx.fillRect(x - 5, 0, 10, 3);
      }
      if (anchor) {
        // Anchored onsets carry a base glyph: solid square for a drag anchor,
        // open square for an approve (zero-drag) anchor.
        ctx.globalAlpha = 0.95;
        ctx.beginPath();
        ctx.rect(x - 3.5, wb - 9, 7, 7);
        if (anchor.kind === "approve") {
          ctx.lineWidth = 1.6;
          ctx.stroke();
        } else {
          ctx.fillStyle = tickColor;
          ctx.fill();
        }
      }
      ticksDrawn++;
    }
    if (dragging) {
      // Ghost of the pre-drag position plus a live delta readout.
      const gx = _timeToStripX(f.drag.startT);
      if (gx !== null && gx >= -1 && gx <= w + 1) {
        ctx.beginPath();
        ctx.setLineDash([3, 3]);
        ctx.lineWidth = 1;
        ctx.globalAlpha = 0.5;
        ctx.strokeStyle = tickColor;
        ctx.moveTo(gx, 0);
        ctx.lineTo(gx, wb);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      const delta = f.drag.curT - f.drag.startT;
      ctx.globalAlpha = 0.95;
      ctx.fillStyle = tickColor;
      ctx.font = "11px sans-serif";
      ctx.textAlign = x > w - 60 ? "right" : "left";
      ctx.fillText(
        `${delta >= 0 ? "+" : ""}${delta.toFixed(3)} s`,
        x + (x > w - 60 ? -6 : 6),
        14,
      );
      ctx.textAlign = "left";
    }
    ctx.globalAlpha = 1;
    // Connector continuation: the in-score half lives INSIDE the page SVG
    // (the underlay, beneath the score elements); this polyline takes over at
    // the rendered content's bottom edge, drops to the pane bottom, and bends
    // across the gap onto the strip tick (faint, selected emphasised).
    if (g.xScore !== null) {
      const xt = stripRect.x - rootRect.x + x;
      if (xt < -40 || xt > f.els.root.clientWidth + 40) continue;
      const yFrom = Math.min(contentBottomY ?? scoreBottomY, scoreBottomY);
      const line = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "polyline",
      );
      line.setAttribute(
        "points",
        `${g.xScore},${yFrom} ${g.xScore},${scoreBottomY} ${xt},${stripTopY}`,
      );
      line.setAttribute("class", selected ? "fix-conn fix-conn-sel" : "fix-conn");
      conn.appendChild(line);
    }
  }
  // MARKS: flagged misalignments on the audio timeline (diamond flags along
  // the strip top). They survive refills by living in time, not in events.
  // The ACTIVE mark (the last N-jump's target, Delete's victim) draws larger
  // in the close-listening active-marker colour.
  ctx.globalAlpha = 0.9;
  for (const mt of _marks) {
    const x = _timeToStripX(mt);
    if (x === null || x < -8 || x > w + 8) continue;
    const active = mt === _activeMarkT;
    ctx.fillStyle = active ? f.markActiveColor : "#d97706";
    const rx = active ? 7 : 5;
    const ry = active ? 8 : 6;
    ctx.beginPath();
    ctx.moveTo(x, 8 - ry);
    ctx.lineTo(x + rx, 8);
    ctx.lineTo(x, 8 + ry);
    ctx.lineTo(x - rx, 8);
    ctx.closePath();
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  f.ticksOnPage = ticksDrawn;
}

/**
 * Select onset group `ix`, turning the page to it when needed. A user gesture
 * passes `seek: true` — seek-to-selected-note, the orientation ruling: the
 * audition playhead lands just before the onset so pressing (or continuing)
 * play audits exactly the selected moment. The playback follower selects with
 * `seek: false` (it IS the playhead) and the entry/resize paths do too.
 */
function _select(ix, { seek = false } = {}) {
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
    el.classList.remove("fix-note-sounding");
  });
  for (const id of g.ids) {
    const el = f.pageIndex.get(id);
    if (el) el.classList.add("fix-note-sel");
  }
  _applyUnderlaySelection();
  _scheduleRedraw();
  if (seek) {
    const t = _groupRefTime(g);
    if (Number.isFinite(t) && f.aud?.ready) {
      // Hold the follower until the playhead reaches the selected onset, or
      // the very next preroll frame would re-select the PREVIOUS group and
      // yank the user's choice away.
      f.followFloor = { ix, untilT: t };
      f.pageOnlyPassUntilT = null; // an explicit selection ends any pass
      _activeMarkT = null; // …and moves attention off the active mark
      _audSeek(Math.max(0, t - SEEK_PREROLL_SEC));
    }
  }
}

function _skipOnset(delta) {
  const f = _fix;
  _commitPendingNudge();
  _select(f.selGroupIx + delta, { seek: true });
}

function _onScoreClick(e) {
  const f = _fix;
  _commitPendingNudge();
  // Walk up from the clicked SVG node to an element the page index knows,
  // then to the onset group that sounds it.
  let el = e.target;
  while (el && el !== f.els.scoreSvg) {
    if (el.id && f.pageIndex.has(el.id)) {
      const ix = f.groups.findIndex((g) => g.ids.includes(el.id));
      if (ix !== -1) {
        _select(ix, { seek: true });
        return;
      }
    }
    el = el.parentElement;
  }
}

/** The onset group whose tick is nearest to canvas-x, within the hit radius. */
function _tickHit(x) {
  const f = _fix;
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
  return best;
}

// ---------------------------------------------------------------------------
// Tick dragging — the correction gesture (a drag lays a hard anchor)
// ---------------------------------------------------------------------------

/**
 * The dragged tick's allowed time range: strictly between the neighbouring
 * anchors (open interval, ANCHOR_EPS inside), non-strictly within the piece
 * corners — the same bounds correction-model's validateAnchorTime enforces,
 * applied as a clamp so the gesture can never build an invalid anchor.
 */
function _dragBounds(groupIx) {
  const f = _fix;
  const i = f.groups[groupIx].eventIxs[0];
  const { prev, next } = neighbourAnchors(_corrections, i);
  const own = findAnchor(_corrections, i);
  const dur = _refDuration();
  // The corners stay ANCHOR_EPS inside [0, duration] too: an anchor at
  // exactly 0 or exactly the duration makes its corner segment a zero-width
  // span, which the worker rejects as reversed.
  const lo = prev && prev !== own ? prev.t + ANCHOR_EPS_SEC : ANCHOR_EPS_SEC;
  const hi =
    next && next !== own ? next.t - ANCHOR_EPS_SEC : dur - ANCHOR_EPS_SEC;
  return { lo, hi: Math.max(lo, hi) };
}

function _onTickMouseDown(e) {
  const f = _fix;
  _commitPendingNudge();
  if (e.button !== 0 || f.drag) return;
  const rect = f.els.ticks.getBoundingClientRect();
  const x = e.clientX - rect.x;
  const hit = _tickHit(x);
  if (hit === -1) return;
  e.preventDefault();
  // Editing needs the engine (auto-realign on release); before it is ready a
  // mousedown is only ever a click-select. Deliberately NOT the chip state:
  // a failed realign leaves an error chip standing, but the engine session
  // is intact and the next drag must stay possible (latching editing off on
  // the first error is how the first real-corpus run got stuck).
  const editable = f.engineReady && !f.realignBusy;
  const t0 = _groupRefTime(f.groups[hit]);
  f.drag = {
    groupIx: hit,
    startX: e.clientX,
    startT: t0,
    curT: t0,
    moved: false,
    editable,
    bounds: editable ? _dragBounds(hit) : null,
    onMove: (ev) => _onTickMouseMove(ev),
    onUp: (ev) => _onTickMouseUp(ev),
  };
  window.addEventListener("mousemove", f.drag.onMove);
  window.addEventListener("mouseup", f.drag.onUp);
}

function _onTickMouseMove(e) {
  const f = _fix;
  const d = f?.drag;
  if (!d) return;
  if (!d.moved && Math.abs(e.clientX - d.startX) < DRAG_THRESHOLD_PX) return;
  d.moved = true;
  if (!d.editable) {
    if (!d.refused) {
      d.refused = true; // once per gesture, not once per mousemove
      _announce(_notEditableWhy());
    }
    return;
  }
  const rect = f.els.ticks.getBoundingClientRect();
  const t = _stripXToTime(e.clientX - rect.x);
  if (t === null) return;
  d.curT = Math.min(Math.max(t, d.bounds.lo), d.bounds.hi);
  _scheduleRedraw();
}

function _onTickMouseUp(e) {
  const f = _fix;
  const d = f?.drag;
  if (!d) return;
  _endDrag(f);
  if (!d.moved) {
    // A plain click: select (and seek to) the grabbed onset.
    _select(d.groupIx, { seek: true });
    return;
  }
  if (!d.editable || !Number.isFinite(d.curT) || d.curT === d.startT) {
    _scheduleRedraw();
    return;
  }
  _select(d.groupIx, { seek: false });
  _commitAnchor(d.groupIx, d.curT, "drag").catch((err) => {
    console.error("fix mode: drag commit failed:", err);
  });
}

/** Why the marker would not move — the answer a refused gesture gives. */
function _notEditableWhy() {
  const f = _fix;
  if (f && !f.engineReady) {
    return f.chipState === "error"
      ? "Corrections are unavailable: the correction engine failed."
      : "Not ready yet — the correction engine is still preparing.";
  }
  return "Still realigning the last fix — one moment.";
}

/** Detach a drag's window listeners (teardown-safe). */
function _endDrag(f) {
  const d = f.drag;
  if (!d) return;
  if (d.onMove) window.removeEventListener("mousemove", d.onMove);
  if (d.onUp) window.removeEventListener("mouseup", d.onUp);
  f.drag = null;
}

// ---------------------------------------------------------------------------
// Keyboard nudging — a drag by arrows (Shift = coarse, Shift+Alt = fine)
// ---------------------------------------------------------------------------

/**
 * Move the selected onset's alignment point by one step. Nudges accumulate
 * into the SAME provisional drag state the mouse gesture uses (ghost + delta
 * readout on the strip) and commit as one anchor when the keyboard is fully
 * released (_onFixKeyup) — the keyboard twin of the mouse drag's mouseup, so
 * holding Shift keeps the nudge floating for as long as the user is thinking.
 */
function _nudge(dir, fine) {
  const f = _fix;
  if (!f) return;
  if (!f.engineReady || f.realignBusy) {
    _announce(_notEditableWhy());
    return;
  }
  if (f.drag && !f.drag.keyboard) return; // a mouse drag owns the gesture
  const g = f.groups[f.selGroupIx];
  if (!g) return;
  if (!f.drag) {
    const t0 = _groupRefTime(g);
    if (!Number.isFinite(t0)) return;
    f.drag = {
      groupIx: f.selGroupIx,
      startT: t0,
      curT: t0,
      moved: true,
      editable: true,
      keyboard: true,
      bounds: _dragBounds(f.selGroupIx),
      onMove: null,
      onUp: null,
    };
  }
  const d = f.drag;
  const step = (fine ? NUDGE_FINE_SEC : NUDGE_COARSE_SEC) * dir;
  d.curT = Math.min(Math.max(d.curT + step, d.bounds.lo), d.bounds.hi);
  _scheduleRedraw();
}

/**
 * The nudge's "mouseup": on every keyup, once no nudge key is left down —
 * no modifier (the keyup's own state) and no arrow (_heldArrows) — a
 * floating nudge commits. Runs unfiltered so a keyup can never be missed;
 * it only acts when a keyboard nudge is actually floating.
 */
function _onFixKeyup(e) {
  const f = _fix;
  if (!f) return;
  if (e.code === "ArrowLeft" || e.code === "ArrowRight") {
    _heldArrows.delete(e.code);
  }
  if (!f.drag?.keyboard) return;
  if (!e.shiftKey && !e.altKey && _heldArrows.size === 0) {
    _commitPendingNudge();
  }
}

/** Commit an accumulated keyboard nudge now (also called before any other
 *  gesture, so a pending nudge can never be silently abandoned). */
function _commitPendingNudge() {
  const f = _fix;
  const d = f?.drag;
  if (!d?.keyboard) return;
  f.drag = null;
  if (!Number.isFinite(d.curT) || d.curT === d.startT) {
    _scheduleRedraw();
    return;
  }
  _commitAnchor(d.groupIx, d.curT, "drag").catch((err) => {
    console.error("fix mode: nudge commit failed:", err);
  });
}

/** Escape during a pending nudge drops it (the tick springs back). */
function _cancelPendingNudge() {
  const f = _fix;
  if (f?.drag?.keyboard) {
    f.drag = null;
    _scheduleRedraw();
  }
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
// The L/R audition (left ear = the recording, right = the corrected-map synth)
// ---------------------------------------------------------------------------

/**
 * Build the audition: one stereo AudioBuffer at the aligner's rate whose left
 * channel is the decoded reference recording and whose right channel is the
 * score synth rendered THROUGH THE CURRENT CORRECTED MAP — every MIDI note
 * (chord voices included) plays from its event's live ref_onset to its
 * ref_offset, so the two ears are sample-locked by construction (§13 ruling
 * 2, the stand-in tool's mix, live in-app). Misalignment is heard as
 * inter-ear flams; after each fix only the changed span re-renders.
 *
 * The synchronous prefix copies the samples into the buffer BEFORE the caller
 * transfers them to the worker; the synth render then proceeds in yielded
 * chunks so a large score never freezes the screen.
 */
function _buildAudition(f, refSamples) {
  const refOff = scoreAlignment.ref_offset;
  if (!Array.isArray(refOff)) {
    console.warn("fix mode: no ref_offset table — audition disabled");
    return Promise.resolve();
  }
  // Every MIDI note maps to its event index by the SAME (start, end)-tick
  // dedup + sort that built the event table, so chord voices ride their
  // event's corrected times.
  const { notes } = parseMidi(f.midiBytes);
  const keys = new Set();
  const uniq = [];
  for (const n of notes) {
    const k = n.s + ":" + n.e;
    if (!keys.has(k)) {
      keys.add(k);
      uniq.push([n.s, n.e, k]);
    }
  }
  uniq.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const ixByKey = new Map(uniq.map((u, ix) => [u[2], ix]));
  if (uniq.length !== f.nEvents) {
    console.warn(
      `fix mode: audition event table disagrees (${uniq.length} vs ` +
        `${f.nEvents}) — audition disabled`,
    );
    return Promise.resolve();
  }
  const audNotes = notes.map((n) => ({
    p: n.p,
    v: n.v,
    ix: ixByKey.get(n.s + ":" + n.e),
  }));

  // A default-rate context resamples on output; the buffer itself lives at
  // FIX_SR so positions stay sample-locked to the aligner's timeline.
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const n = refSamples.length;
  const buffer = ctx.createBuffer(2, n, FIX_SR);
  buffer.copyToChannel(refSamples, 0);
  // Persistent per-ear gain graph: source → splitter → gainL/gainR → merger
  // → out. The gains move in real time from the header's balance slider.
  const splitter = ctx.createChannelSplitter(2);
  const gainL = ctx.createGain();
  const gainR = ctx.createGain();
  const merger = ctx.createChannelMerger(2);
  splitter.connect(gainL, 0);
  splitter.connect(gainR, 1);
  gainL.connect(merger, 0, 0);
  gainR.connect(merger, 0, 1);
  merger.connect(ctx.destination);
  f.aud = {
    ctx,
    buffer,
    splitter,
    gainL,
    gainR,
    synthCh: new Float32Array(n), // raw synth; master gain applied on copy
    duration: n / FIX_SR,
    notes: audNotes,
    gain: 1,
    ready: false,
    rendering: true,
    playing: false,
    pos: 0,
    startedAt: 0,
    srcToken: 0,
    src: null,
    raf: 0,
    lastRenderWindow: null,
    stretch: null, // the time-stretch worklet node (null = source fallback)
    rate: 1, // playback speed, 1 = full; pitch preserved by the worklet
    workletPos: null, // the worklet's own head (test surface, ~12 Hz)
  };
  _applyAudBalance(f.aud);
  return _finishAuditionRender(f);
}

/** Constant-sum pan: the boosted ear stays at 1, the other attenuates. */
function _applyAudBalance(a) {
  a.gainL.gain.value = _audBalance > 0 ? 1 - _audBalance : 1;
  a.gainR.gain.value = _audBalance < 0 ? 1 + _audBalance : 1;
}

async function _finishAuditionRender(f) {
  const a = f.aud;
  const STEP_SEC = 5;
  for (let s = 0; s < a.duration; s += STEP_SEC) {
    if (_fix !== f || f.aud !== a) return;
    _renderSynthWindow(f, s, Math.min(a.duration, s + STEP_SEC));
    await new Promise((r) => setTimeout(r, 0));
  }
  if (_fix !== f || f.aud !== a) return;
  // Master gain from the full render, kept for every later window re-render
  // so amplitude never steps at a re-render boundary.
  let peak = 0;
  for (let i = 0; i < a.synthCh.length; i++) {
    const v = Math.abs(a.synthCh[i]);
    if (v > peak) peak = v;
  }
  a.gain = peak > 1e-6 ? 0.9 / peak : 1;
  _copySynthToBuffer(f, 0, a.duration);
  await _attachStretch(f, a);
  if (_fix !== f || f.aud !== a) return;
  a.rendering = false;
  a.ready = true;
  _updatePlayBtn();
  _schedulePlayheadFrame();
}

/**
 * Pitch-preserving speed: a granular time-stretch worklet feeds the balance
 * graph instead of a per-play BufferSource (which could only speed-change by
 * shifting pitch). On any failure the audition keeps the source path and the
 * speed control hides. Costs one more stereo copy of the piece (~2 × n
 * floats) held inside the worklet.
 */
async function _attachStretch(f, a) {
  try {
    await a.ctx.audioWorklet.addModule(FIX_STRETCH_WORKLET_URL);
    if (_fix !== f || f.aud !== a) return;
    const node = new AudioWorkletNode(a.ctx, "fix-stretch", {
      numberOfInputs: 0,
      outputChannelCount: [2],
    });
    node.port.onmessage = (e) => {
      if (_fix !== f || f.aud !== a) return;
      const m = e.data;
      if (m.type === "pos") {
        a.workletPos = m.pos;
      } else if (m.type === "probe") {
        // What the worklet holds IS what the ear hears; the AudioBuffer beside
        // it can be right while this copy is stale.
        a.lastProbe = m;
        const pending = a.probePending;
        a.probePending = null;
        pending?.(m);
      } else if (m.type === "ended") {
        a.playing = false;
        a.pos = a.duration;
        _updatePlayBtn();
        _schedulePlayheadFrame();
      }
    };
    const ch0 = new Float32Array(a.buffer.getChannelData(0));
    const ch1 = _scaledSynth(a, 0, a.synthCh.length);
    node.port.postMessage({ type: "load", ch0, ch1, srcRate: FIX_SR }, [
      ch0.buffer,
      ch1.buffer,
    ]);
    node.connect(a.splitter);
    a.stretch = node;
    f.els.speedInput.disabled = false;
    f.els.speedReset.disabled = false;
  } catch (err) {
    console.warn(
      "fix mode: time-stretch worklet unavailable — speed control disabled:",
      err,
    );
    if (f.els.speedWrap) f.els.speedWrap.hidden = true;
  }
}

/** Set the audition speed (pitch preserved). Re-anchors the position clock. */
function _audSetRate(v) {
  const f = _fix;
  const a = f?.aud;
  if (!a?.stretch) {
    _updateSpeedUi();
    return;
  }
  if (a.playing) {
    a.pos = _audPos();
    a.startedAt = a.ctx.currentTime;
  }
  a.rate = v;
  a.stretch.port.postMessage({ type: "rate", value: v });
  _updateSpeedUi();
}

function _updateSpeedUi() {
  const f = _fix;
  if (!f?.els.speedReset) return;
  const pct = Math.round((f.aud?.rate ?? 1) * 100);
  f.els.speedReset.textContent = `${pct}%`;
  f.els.speedReset.classList.toggle("fix-speed-off-unity", pct !== 100);
  if (Number(f.els.speedInput.value) !== pct) {
    f.els.speedInput.value = String(pct);
  }
}

/**
 * How long event k actually SOUNDS in the audition: its own length, floored
 * for audibility but never reaching past the next onset (see MIN_SOUND_SEC).
 * The single answer for the renderer, the commit audit, and the re-render
 * window — they must agree or the audit measures the wrong span.
 */
function _soundingDur(refOn, refOff, k) {
  const ts = refOn[k];
  const te = Array.isArray(refOff) ? refOff[k] : undefined;
  const natural = Number.isFinite(te) ? te - ts : 0;
  // ref onsets are monotone in event index (an alignment invariant), so the
  // next distinct onset is a short scan away — a chord's width at most.
  let gap = Infinity;
  for (let j = k + 1; j < refOn.length; j++) {
    if (refOn[j] > ts) {
      gap = refOn[j] - ts;
      break;
    }
  }
  return Math.max(natural, Math.min(MIN_SOUND_SEC, gap));
}

/** (Re)render the raw synth channel for [t0, t1): zero the window, then add
 *  every note's contribution clipped to it — envelope and phase are
 *  deterministic in the distance from the note's own start, so a clipped
 *  re-render reproduces the identical samples. */
function _renderSynthWindow(f, t0, t1) {
  const a = f.aud;
  const out = a.synthCh;
  const iLo = Math.max(0, Math.floor(t0 * FIX_SR));
  const iHi = Math.min(out.length, Math.ceil(t1 * FIX_SR));
  if (iHi <= iLo) return;
  out.fill(0, iLo, iHi);
  const refOn = scoreAlignment.ref_onset;
  const refOff = scoreAlignment.ref_offset;
  const ATK_S = Math.round(0.01 * FIX_SR);
  const REL_S = Math.round(0.03 * FIX_SR);
  for (const note of a.notes) {
    const ts = refOn[note.ix];
    if (!Number.isFinite(ts)) continue;
    const noteDur = _soundingDur(refOn, refOff, note.ix);
    const iStart = Math.round(ts * FIX_SR);
    // The envelope is shaped on the note's INTENDED length, so a window that
    // clips the tail still reproduces the identical samples.
    const nFull = Math.max(1, Math.round(noteDur * FIX_SR));
    const iEnd = Math.min(out.length, iStart + nFull);
    const lo = Math.max(iStart, iLo);
    const hi = Math.min(iEnd, iHi);
    if (hi <= lo) continue;
    const amp = (note.v / 127) * 0.12;
    const phaseInc = (440 * Math.pow(2, (note.p - 69) / 12)) / FIX_SR;
    // Attack and release always FIT: a short note reaches full amplitude
    // instead of being caught mid-release (a 20 ms note used to peak at 0.47
    // of its amplitude, which is most of why a collapsed note vanished).
    const atk = Math.max(1, Math.min(ATK_S, Math.floor(nFull * 0.25)));
    const rel = Math.max(1, Math.min(REL_S, nFull - atk));
    const relStart = nFull - rel;
    let phase = ((lo - iStart) * phaseInc) % 1;
    for (let i = lo; i < hi; i++) {
      phase += phaseInc;
      if (phase >= 1) phase -= 1;
      const saw = 2 * phase - 1;
      const si = i - iStart;
      let env;
      if (si < atk) env = si / atk;
      else if (si >= relStart) env = Math.max(0, (nFull - si) / rel);
      else env = 1;
      out[i] += saw * amp * env;
    }
  }
}

/** Master-gained clip of the raw synth over [iLo, iHi) sample indices. */
function _scaledSynth(a, iLo, iHi) {
  const scaled = new Float32Array(iHi - iLo);
  for (let i = 0; i < scaled.length; i++) {
    const v = a.synthCh[iLo + i] * a.gain;
    scaled[i] = v > 1 ? 1 : v < -1 ? -1 : v;
  }
  return scaled;
}

/** Master-gained copy of a synth window into the stereo buffer's right ear
 *  (copyToChannel, not getChannelData writes — acquired-content semantics
 *  can never leave a playing buffer stale) AND, when the stretch worklet is
 *  attached, the same window patched into its own copy. */
function _copySynthToBuffer(f, t0, t1) {
  const a = f.aud;
  const iLo = Math.max(0, Math.floor(t0 * FIX_SR));
  const iHi = Math.min(a.synthCh.length, Math.ceil(t1 * FIX_SR));
  if (iHi <= iLo) return;
  const scaled = _scaledSynth(a, iLo, iHi);
  a.buffer.copyToChannel(scaled, 1, iLo);
  a.stretch?.port.postMessage({ type: "patch", ch: 1, offset: iLo, data: scaled }, [
    scaled.buffer,
  ]);
}

/** Ask the stretch worklet for peak/RMS over [t0, t1) of ITS OWN copy — the
 *  content playback actually reads. Null when the worklet is not attached. */
function _workletProbe(t0, t1) {
  const a = _fix?.aud;
  if (!a?.stretch) return Promise.resolve(null);
  return new Promise((resolve) => {
    a.probePending = resolve;
    a.stretch.port.postMessage({ type: "probe", t0, t1, tag: "audit" });
  });
}

/** One note's live span and the signal actually present in the synth ear over
 *  it — the audition's own answer to "why can I not hear the note I fixed". */
function _noteAudit(k) {
  const a = _fix?.aud;
  const on = scoreAlignment.ref_onset[k];
  const off = Array.isArray(scoreAlignment.ref_offset)
    ? scoreAlignment.ref_offset[k]
    : undefined;
  const out = {
    i: k,
    on,
    off,
    dur: Number.isFinite(on) && Number.isFinite(off) ? off - on : null,
    bufferPeak: null,
    samples: 0,
    soundingEnd: null,
  };
  if (!a?.ready || !Number.isFinite(on)) return out;
  // Measure exactly the span the renderer wrote, floor included.
  const hi = on + _soundingDur(scoreAlignment.ref_onset, scoreAlignment.ref_offset, k);
  out.soundingEnd = hi;
  const data = a.buffer.getChannelData(1);
  const lo = Math.max(0, Math.floor(on * FIX_SR));
  const end = Math.min(data.length, Math.ceil(hi * FIX_SR));
  let peak = 0;
  for (let s = lo; s < end; s++) {
    const v = data[s] < 0 ? -data[s] : data[s];
    if (v > peak) peak = v;
  }
  out.bufferPeak = peak;
  out.samples = Math.max(0, end - lo);
  return out;
}

/** Re-render the right ear for the span a fix (or an undo hop) changed. */
function _auditionRerender(t0, t1) {
  const f = _fix;
  const a = f?.aud;
  if (!a?.ready) return;
  const pad = 0.05;
  t0 = Math.max(0, t0 - pad);
  t1 = Math.min(a.duration, t1 + pad);
  _renderSynthWindow(f, t0, t1);
  _copySynthToBuffer(f, t0, t1);
  a.lastRenderWindow = { t0, t1 };
}

function _auditionDispose(f) {
  const a = f.aud;
  if (!a) return;
  f.aud = null;
  if (a.raf) cancelAnimationFrame(a.raf);
  a.srcToken++;
  try {
    a.src?.stop();
  } catch (_) {}
  a.src = null;
  try {
    a.ctx?.close();
  } catch (_) {}
}

/** The audition playhead position in seconds. */
function _audPos() {
  const a = _fix?.aud;
  if (!a) return 0;
  return a.playing
    ? Math.min(
        a.duration,
        a.pos + (a.ctx.currentTime - a.startedAt) * (a.stretch ? a.rate : 1),
      )
    : a.pos;
}

function _audPlay() {
  const f = _fix;
  const a = f?.aud;
  if (!a?.ready || a.playing) return;
  if (a.ctx.state === "suspended") a.ctx.resume().catch(() => {});
  if (a.pos >= a.duration - 0.01) a.pos = 0;
  if (a.stretch) {
    a.stretch.port.postMessage({ type: "seek", pos: a.pos });
    a.stretch.port.postMessage({ type: "play" });
    a.startedAt = a.ctx.currentTime;
    a.playing = true;
    _updatePlayBtn();
    _schedulePlayheadFrame();
    return;
  }
  const src = a.ctx.createBufferSource();
  src.buffer = a.buffer;
  src.connect(a.splitter);
  const token = ++a.srcToken;
  src.onended = () => {
    // Natural end of the recording (seek/pause disarm via the token).
    if (_fix !== f || f.aud !== a || a.srcToken !== token) return;
    a.playing = false;
    a.pos = a.duration;
    a.src = null;
    _updatePlayBtn();
    _schedulePlayheadFrame();
  };
  src.start(0, a.pos);
  a.src = src;
  a.startedAt = a.ctx.currentTime;
  a.playing = true;
  _updatePlayBtn();
  _schedulePlayheadFrame();
}

function _audPause() {
  const a = _fix?.aud;
  if (!a?.playing) return;
  a.pos = _audPos();
  if (a.stretch) {
    a.stretch.port.postMessage({ type: "pause" });
    a.playing = false;
    _updatePlayBtn();
    return;
  }
  a.srcToken++;
  try {
    a.src?.stop();
  } catch (_) {}
  a.src = null;
  a.playing = false;
  _updatePlayBtn();
}

function _audSeek(t) {
  const a = _fix?.aud;
  if (!a?.ready) return;
  t = Math.min(Math.max(0, t), a.duration);
  if (a.stretch) {
    a.pos = t;
    a.stretch.port.postMessage({ type: "seek", pos: t });
    if (a.playing) a.startedAt = a.ctx.currentTime;
    else _schedulePlayheadFrame();
    return;
  }
  if (a.playing) {
    a.srcToken++;
    try {
      a.src?.stop();
    } catch (_) {}
    a.src = null;
    a.playing = false;
    a.pos = t;
    _audPlay();
  } else {
    a.pos = t;
    _schedulePlayheadFrame();
  }
}

/**
 * The current page's playback slice: from its first group's live onset to
 * the next non-empty page's first onset (a page owns the music up to where
 * the next system begins; the last page runs to the end of the recording).
 * Null when the page carries no finite onset. Distinct from _pageWindow,
 * the strip's PADDED display window.
 */
function _pageTimeSlice() {
  const f = _fix;
  const own = _groupsOnPage(f.page);
  if (!own.length) return null;
  const startT = _groupRefTime(own[0]);
  if (!Number.isFinite(startT)) return null;
  let endT = f.aud?.duration ?? Infinity;
  for (let p = f.page + 1; p <= f.pageCount; p++) {
    const next = _groupsOnPage(p);
    if (next.length) {
      endT = _groupRefTime(next[0]);
      break;
    }
  }
  return { startT, endT };
}

/** In page-only mode an explicit play starts inside the page: a position
 *  outside the current page's slice snaps to its first onset − preroll. */
function _snapIntoPage() {
  const f = _fix;
  const w = _pageTimeSlice();
  if (!w) return;
  const pos = _audPos();
  if (pos >= w.startT - SEEK_PREROLL_SEC - 0.05 && pos < w.endT - 0.05) return;
  const ix = _groupIxAtTime(w.startT);
  if (ix !== -1) f.followFloor = { ix, untilT: w.startT };
  f.pageOnlyPassUntilT = null;
  _audSeek(Math.max(0, w.startT - SEEK_PREROLL_SEC));
}

function _audToggle() {
  const a = _fix?.aud;
  if (!a?.ready) return;
  if (a.playing) _audPause();
  else {
    if (_pageOnly) _snapIntoPage();
    _audPlay();
  }
}

function _updatePlayBtn() {
  const f = _fix;
  if (!f) return;
  f.els.playBtn.disabled = !f.aud?.ready;
  f.els.playBtn.textContent = f.aud?.playing ? "⏸" : "⏵";
}

// ---------------------------------------------------------------------------
// Playback following (the orientation loop)
// ---------------------------------------------------------------------------

/** One playhead frame; keeps itself scheduled while playing. */
function _schedulePlayheadFrame() {
  const f = _fix;
  const a = f?.aud;
  if (!a || a.raf) return;
  a.raf = requestAnimationFrame(() => {
    if (_fix !== f || f.aud !== a) return;
    a.raf = 0;
    _paintPlayhead();
    if (a.playing) {
      _followPlayback();
      _schedulePlayheadFrame();
    }
  });
}

function _paintPlayhead() {
  const f = _fix;
  const canvas = f.els.playhead;
  const w = f.els.strip.clientWidth;
  const h = f.els.strip.clientHeight;
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, w, h);
  const a = f.aud;
  if (!a?.ready) return;
  const x = _timeToStripX(_audPos());
  if (x === null || x < -PH_ARROW_HALF_W || x > w + PH_ARROW_HALF_W) return;
  // The bracket: one arrowhead just inside the top edge pointing down, one in
  // the gutter beneath the waveform pointing up, and nothing between them.
  ctx.fillStyle = f.playheadColor;
  ctx.globalAlpha = 0.95;
  _fillArrowhead(ctx, x, 1, 1);
  _fillArrowhead(ctx, x, h - 1, -1);
}

/** One filled arrowhead: base of width 2·PH_ARROW_HALF_W on `yBase`, apex
 *  PH_ARROW_H away in direction `dir` (+1 down, −1 up), apex exactly on x. */
function _fillArrowhead(ctx, x, yBase, dir) {
  ctx.beginPath();
  ctx.moveTo(x - PH_ARROW_HALF_W, yBase);
  ctx.lineTo(x + PH_ARROW_HALF_W, yBase);
  ctx.lineTo(x, yBase + dir * PH_ARROW_H);
  ctx.closePath();
  ctx.fill();
}

/**
 * The last onset group at or before reference time t (the groups' live ref
 * onsets are monotone — an alignment invariant), or -1 before the first.
 */
function _groupIxAtTime(t) {
  const gs = _fix.groups;
  if (!gs.length || _groupRefTime(gs[0]) > t) return -1;
  let lo = 0;
  let hi = gs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (_groupRefTime(gs[mid]) <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Selection follows the sounding onset during playback (pages turn with it),
 * and the sounding state — on at onset, off at offset, both read through the
 * corrected map — drives the score highlight's emphasis. After an explicit
 * seek-to-selected, the follower holds until the playhead reaches the
 * selected onset so the preroll cannot yank the selection backwards.
 */
function _followPlayback() {
  const f = _fix;
  const t = _audPos();
  const ix = _groupIxAtTime(t);
  if (ix === -1) {
    _setSounding(false);
    return;
  }
  const floor = f.followFloor;
  if (floor && t < floor.untilT - 1e-3) {
    if (ix < floor.ix) {
      _setSounding(false);
      return;
    }
  } else if (floor) {
    f.followFloor = null;
  }
  if (f.pageOnlyPassUntilT !== null && t >= f.pageOnlyPassUntilT - 1e-3) {
    f.pageOnlyPassUntilT = null;
  }
  // Page-only playback: pause at the page boundary instead of turning the
  // page — unless a commit replay or mark jump is deliberately crossing.
  if (
    _pageOnly &&
    f.pageOnlyPassUntilT === null &&
    f.groups[ix].page > f.page
  ) {
    _audPause();
    _audSeek(Math.max(0, _groupRefTime(f.groups[ix]) - 0.01));
    return;
  }
  if (ix !== f.selGroupIx) _select(ix, { seek: false });
  const g = f.groups[ix];
  const refOff = scoreAlignment.ref_offset;
  let offEnd = Infinity;
  if (Array.isArray(refOff)) {
    offEnd = -Infinity;
    for (const e of g.eventIxs) {
      const v = refOff[e];
      if (Number.isFinite(v) && v > offEnd) offEnd = v;
    }
  }
  _setSounding(t >= _groupRefTime(g) - 1e-3 && t <= offEnd);
}

function _setSounding(on) {
  const f = _fix;
  const target = on ? f.selGroupIx : null;
  if (f.soundingGroupIx === target) return;
  f.soundingGroupIx = target;
  f.els.scoreSvg.querySelectorAll(".fix-note-sel").forEach((el) => {
    el.classList.toggle("fix-note-sounding", on);
  });
}

// ---------------------------------------------------------------------------
// Anchor commits: model + worker realign + undo entry (the edit loop's core)
// ---------------------------------------------------------------------------

/** Ask the worker to refill one segment; single in-flight by construction. */
function _realignSegmentViaWorker(segment, priorRef) {
  const worker = _ensureWorker();
  return new Promise((resolve, reject) => {
    _pendingRealign = { resolve, reject };
    worker.postMessage({
      type: "fix_realign",
      iA: segment.iA,
      tA: segment.tA,
      iB: segment.iB,
      tB: segment.tB,
      priorRef,
    });
  });
}

/**
 * Commit an anchor on a group: 'drag' pins event i at a new time t and
 * auto-realigns the flanking segments (worker fix_realign on cached features,
 * stored params — no fast parameters); 'approve' pins the CURRENT value with
 * zero data change. Both push one fix-anchor snapshot entry onto listen.js's
 * unified undo stack and re-serialize header.corrections, the durable record.
 * A drag ends with auto-replay from just before the previous anchor (RULED).
 */
async function _commitAnchor(groupIx, t, kind) {
  const f = _fix;
  if (!f || f.realignBusy || !Number.isFinite(t)) return;
  const g = f.groups[groupIx];
  if (!g) return;
  const i = g.eventIxs[0];
  const refOn = scoreAlignment.ref_onset;
  const refOff = scoreAlignment.ref_offset;
  if (!Array.isArray(refOff)) {
    _announce("This alignment has no ref_offset table; corrections need one.");
    return;
  }
  const dur = _refDuration();
  if (!(dur > 0)) return;
  const ctx = { nEvents: f.nEvents, refDuration: dur };
  if (!_pristine) _pristine = { on: refOn.slice(), off: refOff.slice() };

  const prevRecord = findAnchor(_corrections, i);
  const entry = {
    type: "fix-anchor",
    i,
    q: f.qOn[i],
    t,
    kind,
    barHint: _barOfQuarter(f.qOn[i]),
    prevAnchor: prevRecord ? { ...prevRecord } : null,
    dissolvedGaps:
      prevRecord?.kind === "gap" && kind !== "gap"
        ? _corrections.gaps
            .filter((gp) => gp.i === i || gp.i + 1 === i)
            .map((gp) => ({ ...gp }))
        : [],
    selfBefore: { on: refOn[i], off: refOff[i] },
    selfAfter: null,
    segments: [],
    anchorOffsets: [],
    window: null,
  };
  let segs;
  try {
    segs = setAnchor(_corrections, { i, q: entry.q, t, kind, ts: Date.now() }, ctx)
      .segments;
  } catch (err) {
    _announce(`Cannot anchor here: ${err.message}`);
    return;
  }

  if (kind === "approve") {
    entry.selfAfter = { ...entry.selfBefore };
    f.lastCommit = { kind, i, t, realigned: 0, linear: 0, degenerate: 0 };
    pushFixUndoEntry(entry);
    _syncCorrectionsHeader();
    _scheduleRedraw();
    return;
  }

  f.realignBusy = true;
  _setChip("realign", "Realigning around the fix…");
  applyAnchorValue(refOn, i, t);
  let linearFilled = 0;
  let realigned = 0;
  try {
    for (const seg of segs) {
      let res;
      if (seg.interiorCount <= 0) {
        // Nothing to refill, but the left-boundary anchor's own OFFSET
        // still lives inside this span and must follow it: skipping here
        // left the offset stale, so a rightward drag beside an existing
        // anchor could leave offset ≤ onset and the synth rendered the
        // note as a 20 ms blip (the first-note stutter).
        if (seg.iA < 0) continue;
        res = _linearFill(seg);
      } else {
        const priorRef = refOn.slice(seg.iA + 1, seg.iB);
        try {
          const reply = await _realignSegmentViaWorker(seg, priorRef);
          if (_fix !== f) throw new Error("fix mode exited during the realign");
          res = reply.result;
          realigned++;
        } catch (err) {
          // A span squeezed between close anchors can have too few analysis
          // frames for DTW (the worker refuses honestly). At that scale a
          // linear fill IS the right refill — interior events sit within a
          // breath of both anchors — so the commit proceeds instead of
          // failing the whole gesture (first real-corpus session got stuck
          // exactly here, with every flanking segment eventually tiny).
          if (_fix === f && /too short to align/.test(err?.message || "")) {
            res = _linearFill(seg);
            linearFilled++;
          } else {
            throw err;
          }
        }
      }
      const before = applySegment(refOn, refOff, seg, res.ref_onset, res.ref_offset);
      entry.segments.push({
        iA: seg.iA,
        iB: seg.iB,
        interiorCount: seg.interiorCount,
        beforeOn: before.beforeOn,
        beforeOff: before.beforeOff,
        afterOn: res.ref_onset.slice(),
        afterOff: res.ref_offset.slice(),
      });
      // The left-boundary anchor's own OFFSET falls inside the segment and
      // comes back remapped; the dragged event's offset arrives this way too
      // (as the right segment's iA) and is covered by selfBefore/selfAfter.
      if (res.anchor_a_offset != null && seg.iA >= 0) {
        if (seg.iA !== i) {
          entry.anchorOffsets.push({
            i: seg.iA,
            before: refOff[seg.iA],
            after: res.anchor_a_offset,
          });
        }
        refOff[seg.iA] = res.anchor_a_offset;
      }
    }
  } catch (err) {
    _rollbackCommit(entry);
    // The chip truncates; the console gets the whole story (a PythonError
    // message carries the worker's full traceback).
    console.error(
      "fix mode: realign failed, fix rolled back — anchor",
      { i, t, kind },
      "segments",
      segs,
      "\n",
      err,
    );
    if (_fix === f) {
      f.realignBusy = false;
      _setChip(
        "error",
        `Realign failed (${err.message}) — the fix was rolled back`,
      );
      _scheduleRedraw();
    }
    return;
  }
  entry.selfAfter = { on: refOn[i], off: refOff[i] };
  entry.window = { t0: segs[0].tA, t1: segs[segs.length - 1].tB };
  // Offsets may now legitimately reach past the window's right edge, so the
  // right ear is re-rendered out to the furthest offset the commit wrote —
  // otherwise a lengthened note keeps its old, shorter tail. And a canary on
  // the invariant every degenerate-offset bug has broken so far: an offset at
  // or before its own onset, which the synth floors at 20 ms and the ear hears
  // as a dropped note. Two real data bugs hid behind that floor; if this ever
  // fires there is a third.
  const iLo = Math.max(0, segs[0].iA);
  const iHi = Math.min(f.nEvents - 1, segs[segs.length - 1].iB);
  let degenerate = 0;
  let renderT1 = entry.window.t1;
  for (let k = iLo; k <= iHi; k++) {
    const onK = refOn[k];
    const offK = refOff[k];
    if (!Number.isFinite(onK)) continue;
    if (Number.isFinite(offK) && offK <= onK) degenerate++;
    // The renderer floors a note's sounding length, so the re-render has to
    // reach past a short note's data offset as well.
    const end = onK + _soundingDur(refOn, refOff, k);
    if (end > renderT1) renderT1 = end;
  }
  entry.renderT1 = renderT1;
  if (degenerate) {
    console.warn(
      `fix mode: commit left ${degenerate} event(s) in [${iLo}, ${iHi}] with ` +
        "ref_offset <= ref_onset — the synth will floor them at 20 ms",
      { i, t, kind },
    );
  }
  f.realignBusy = false;
  f.lastCommit = { kind, i, t, realigned, linear: linearFilled, degenerate };
  // The commit's console trail. Every "the note I fixed does not sound" report
  // so far has come down to one of three numbers: the note's duration (a
  // collapsed offset is floored at 20 ms), the peak actually rendered into the
  // synth ear, and — separately — what the stretch worklet holds, since
  // playback reads the worklet's own copy and not the AudioBuffer beside it.
  const fmt = (v) => (Number.isFinite(v) ? v.toFixed(4) : String(v));
  const audit = _noteAudit(i);
  const leftAudit = segs[0].iA >= 0 ? _noteAudit(segs[0].iA) : null;
  console.log(
    `fix mode: ${kind} on event ${i} (bar ${entry.barHint ?? "?"}) — onset ` +
      `${fmt(entry.selfBefore.on)} → ${fmt(audit.on)}, offset ` +
      `${fmt(entry.selfBefore.off)} → ${fmt(audit.off)}, duration ` +
      `${fmt(entry.selfBefore.off - entry.selfBefore.on)} → ${fmt(audit.dur)} s` +
      (audit.soundingEnd !== null && audit.soundingEnd - audit.on > audit.dur + 1e-3
        ? ` (sounding ${fmt(audit.soundingEnd - audit.on)} s — the audibility floor)`
        : "") +
      "; " +
      `synth ear over the note: peak ${fmt(audit.bufferPeak)} over ` +
      `${audit.samples} samples; realigned ${realigned}, linear ` +
      `${linearFilled}, degenerate ${degenerate}; re-render [` +
      `${fmt(entry.window.t0)}, ${fmt(entry.renderT1)}]` +
      (leftAudit
        ? `; previous anchor event ${leftAudit.i}: ${fmt(leftAudit.on)}–` +
          `${fmt(leftAudit.off)} (dur ${fmt(leftAudit.dur)} s, peak ` +
          `${fmt(leftAudit.bufferPeak)})`
        : ""),
  );
  if (f.aud?.stretch && Number.isFinite(audit.on)) {
    const pt1 = audit.soundingEnd ?? audit.on + MIN_SOUND_SEC;
    _workletProbe(audit.on, pt1)
      .then((p) => {
        if (!p?.ch1) return;
        const stale = audit.bufferPeak > 1e-4 && p.ch1.peak < 1e-4;
        const line =
          `fix mode: playback's own copy over event ${i} — synth peak ` +
          `${fmt(p.ch1.peak)}, recording peak ${fmt(p.ch0?.peak)}`;
        if (stale) {
          console.warn(
            `${line} — MISMATCH: the buffer holds the note but the worklet ` +
              "playback reads does not, so it will not sound",
          );
        } else {
          console.log(line);
        }
      })
      .catch(() => {});
  }
  pushFixUndoEntry(entry);
  _syncCorrectionsHeader();
  _setChip("ready", "Correction engine ready");
  _auditionRerender(entry.window.t0, entry.renderT1);
  _scheduleRedraw();
  // Auto-replay from just before the previous anchor: the invalidated span
  // starts there, so the ear re-checks exactly what the fix changed. Kept
  // even when suppressed, because R replays it on demand.
  _lastReplay = {
    t0: entry.window.t0,
    fixedT: entry.t,
    passUntilT: entry.window.t1,
  };
  if (!_replaySuppressed) _replayFix(_lastReplay);
}

/**
 * Where a fix's replay opens: half a second before the previous anchor, but
 * never more than MAX_RUNUP_SEC before the fix itself. `window.t0` is the
 * previous anchor's time — or 0 when there is none — so without the ceiling a
 * fix into virgin territory replays from the top of the recording.
 */
function _replayStartT(t0, fixedT) {
  return Math.max(0, Math.max(t0 - REPLAY_PREROLL_SEC, fixedT - MAX_RUNUP_SEC));
}

/** Replay the span a commit invalidated. Shared by the auto-replay and R. */
function _replayFix(r) {
  const f = _fix;
  if (!f || !r || !f.aud?.ready) return false;
  f.followFloor = null;
  // A replay may start on an earlier page; in page-only mode this pass lets
  // it cross back into the fixed span before the clamp re-arms.
  f.pageOnlyPassUntilT = r.passUntilT;
  _audSeek(_replayStartT(r.t0, r.fixedT));
  _audPlay();
  return true;
}

/**
 * Interior refill by proportion of score quarters — the honest answer for a
 * span too small for DTW (interior events sit within a breath of both
 * anchors, so the tempo curve between them is as good as linear). Same
 * clip-into-span discipline as the worker's refill, including the left
 * anchor's own offset remap (a stale offset can land before its onset).
 */
function _linearFill(seg) {
  const f = _fix;
  const qA = seg.iA >= 0 ? f.qOn[seg.iA] : 0;
  const qB = seg.iB < f.nEvents ? f.qOn[seg.iB] : f.qOff[f.nEvents - 1];
  const scale = (seg.tB - seg.tA) / Math.max(qB - qA, 1e-9);
  const lin = (q) => seg.tA + (q - qA) * scale;
  const clip = (v) => Math.min(Math.max(v, seg.tA), seg.tB);
  // Onsets belong to this segment and clip into it. An OFFSET past qB —
  // a tie, a sustained note under a moving line; 8.3% of the Fledermaus HQ
  // corpus's onset groups at the adjacent-anchor spacing this path serves —
  // belongs to the music after the next anchor
  // and continues at the same rate (the worker's _map_off rule). Clipping it
  // to tB truncated the note, and for the dragged event's own offset it could
  // collapse the note onto its onset: the synth's 20 ms floor, heard as a
  // dropped note.
  const dur = _refDuration();
  const mapOff = (q) => (q <= qB ? clip(lin(q)) : Math.min(lin(q), dur));
  const on = [];
  const off = [];
  for (let e = seg.iA + 1; e < seg.iB; e++) {
    on.push(clip(lin(f.qOn[e])));
    off.push(mapOff(f.qOff[e]));
  }
  return {
    ref_onset: on,
    ref_offset: off,
    anchor_a_offset: seg.iA >= 0 ? mapOff(f.qOff[seg.iA]) : null,
    hop: 0,
  };
}

/** Reverse a partially applied commit (worker error, exit mid-flight). */
function _rollbackCommit(entry) {
  const refOn = scoreAlignment?.ref_onset;
  const refOff = scoreAlignment?.ref_offset;
  if (!refOn || !refOff) return;
  for (const s of entry.segments) {
    for (let k = 0; k < s.interiorCount; k++) {
      refOn[s.iA + 1 + k] = s.beforeOn[k];
      refOff[s.iA + 1 + k] = s.beforeOff[k];
    }
  }
  for (const ao of entry.anchorOffsets) refOff[ao.i] = ao.before;
  refOn[entry.i] = entry.selfBefore.on;
  refOff[entry.i] = entry.selfBefore.off;
  _restoreAnchorState(entry);
}

/** Put the model back to its pre-entry state (shared by rollback and undo). */
function _restoreAnchorState(entry) {
  const at = _corrections.anchors.findIndex((a) => a.i === entry.i);
  if (at !== -1) _corrections.anchors.splice(at, 1);
  if (entry.prevAnchor) {
    const a = { ...entry.prevAnchor };
    const ins = _corrections.anchors.findIndex((x) => x.i > a.i);
    if (ins === -1) _corrections.anchors.push(a);
    else _corrections.anchors.splice(ins, 0, a);
  }
  for (const gp of entry.dissolvedGaps || []) {
    if (!_corrections.gaps.some((x) => x.i === gp.i)) {
      _corrections.gaps.push({ ...gp });
      _corrections.gaps.sort((a, b) => a.i - b.i);
    }
  }
  _syncCorrectionsHeader();
}

/** Keep header.corrections — the durable hand-correction record — in step. */
function _syncCorrectionsHeader() {
  const header = loadedAlignmentJSON?.header;
  if (!header) return;
  if (!_corrections.anchors.length && !_corrections.gaps.length) {
    delete header.corrections;
    return;
  }
  if (!_correctionsBase) {
    _correctionsBase = {
      verovioVersion: header.verovioVersion ?? null,
      verovioOptions: header.verovioOptions ?? null,
      alignmentParams: header.alignmentParams ?? null,
    };
  }
  header.corrections = serializeCorrections(_corrections, _correctionsBase);
}

/** Rough bar number for a quarter position (announcement copy only). */
function _barOfQuarter(q) {
  let bar = 0;
  for (const e of timemap) {
    if (!("measureOn" in e)) continue;
    if (e.qstamp > q + 1e-6) break;
    bar++;
  }
  return bar || null;
}

// ---------------------------------------------------------------------------
// Global undo integration (listen.js's unified stack calls these)
// ---------------------------------------------------------------------------

/**
 * Apply the UNDO of a fix-anchor entry: restore the before-values (snapshot
 * semantics — never the worker) and the model's previous anchor state. With
 * fix mode open the affected onset is selected so the change is visible; with
 * it closed the hop announces itself instead of changing data silently
 * off-screen (the cluster-B nicety).
 */
export function applyFixCorrectionUndo(entry) {
  const refOn = scoreAlignment?.ref_onset;
  const refOff = scoreAlignment?.ref_offset;
  if (!refOn) return;
  if (entry.kind !== "approve" && Array.isArray(refOff)) {
    for (const s of entry.segments) {
      for (let k = 0; k < s.interiorCount; k++) {
        refOn[s.iA + 1 + k] = s.beforeOn[k];
        refOff[s.iA + 1 + k] = s.beforeOff[k];
      }
    }
    for (const ao of entry.anchorOffsets) refOff[ao.i] = ao.before;
    refOn[entry.i] = entry.selfBefore.on;
    refOff[entry.i] = entry.selfBefore.off;
  }
  _restoreAnchorState(entry);
  _afterHistoryHop(entry, "Undid");
}

/** Apply the REDO of a fix-anchor entry: the after-values and the anchor. */
export function applyFixCorrectionRedo(entry) {
  const refOn = scoreAlignment?.ref_onset;
  const refOff = scoreAlignment?.ref_offset;
  if (!refOn) return;
  if (entry.kind !== "approve" && Array.isArray(refOff)) {
    for (const s of entry.segments) {
      for (let k = 0; k < s.interiorCount; k++) {
        refOn[s.iA + 1 + k] = s.afterOn[k];
        refOff[s.iA + 1 + k] = s.afterOff[k];
      }
    }
    for (const ao of entry.anchorOffsets) refOff[ao.i] = ao.after;
    refOn[entry.i] = entry.selfAfter.on;
    refOff[entry.i] = entry.selfAfter.off;
  }
  // Re-lay the anchor (and re-dissolve any gap it had replaced).
  const at = _corrections.anchors.findIndex((a) => a.i === entry.i);
  if (at !== -1) _corrections.anchors.splice(at, 1);
  for (const gp of entry.dissolvedGaps || []) {
    _corrections.gaps = _corrections.gaps.filter((x) => x.i !== gp.i);
  }
  const a = { i: entry.i, q: entry.q, t: entry.t, kind: entry.kind, ts: null };
  const ins = _corrections.anchors.findIndex((x) => x.i > a.i);
  if (ins === -1) _corrections.anchors.push(a);
  else _corrections.anchors.splice(ins, 0, a);
  _syncCorrectionsHeader();
  _afterHistoryHop(entry, "Redid");
}

function _afterHistoryHop(entry, verb) {
  const f = _fix;
  if (f) {
    const ix = f.groups.findIndex((g) => g.eventIxs.includes(entry.i));
    if (ix !== -1) _select(ix, { seek: false });
    if (entry.window) {
      _auditionRerender(entry.window.t0, entry.renderT1 ?? entry.window.t1);
    }
    _scheduleRedraw();
  } else {
    const where = entry.barHint ? `near bar ${entry.barHint}` : `at event ${entry.i}`;
    _announce(`${verb} alignment correction ${where}.`);
  }
}

/** Transient toast for changes the user cannot currently see. */
function _announce(text) {
  _lastAnnounce = text;
  let el = document.getElementById("fix-toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "fix-toast";
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.classList.add("fix-toast-show");
  clearTimeout(_announceTimer);
  _announceTimer = setTimeout(() => el.classList.remove("fix-toast-show"), 4000);
}

// ---------------------------------------------------------------------------
// Revert integration (listen.js's "Revert all" includes fix corrections)
// ---------------------------------------------------------------------------

/** Whether fix-mode corrections have changed anything since the piece loaded. */
export function fixCorrectionsDirty() {
  if (_pristine) {
    const on = scoreAlignment?.ref_onset || [];
    const off = scoreAlignment?.ref_offset || [];
    for (let k = 0; k < _pristine.on.length; k++) {
      if (on[k] !== _pristine.on[k] || off[k] !== _pristine.off[k]) return true;
    }
  }
  return (
    JSON.stringify({ a: _corrections.anchors, g: _corrections.gaps }) !==
    _loadedCorrectionsJson
  );
}

/** Restore the as-loaded ref tables and correction record ("Revert all"). */
export function fixRevertCorrections() {
  if (_fix?.realignBusy) {
    _announce("A realign is still running — try Revert again in a moment.");
    return;
  }
  if (_pristine) {
    const on = scoreAlignment?.ref_onset;
    const off = scoreAlignment?.ref_offset;
    if (on) {
      for (let k = 0; k < _pristine.on.length; k++) {
        on[k] = _pristine.on[k];
        if (Array.isArray(off)) off[k] = _pristine.off[k];
      }
    }
    _pristine = null;
  }
  const loaded = _loadedCorrectionsJson
    ? JSON.parse(_loadedCorrectionsJson)
    : { a: [], g: [] };
  _corrections = { anchors: loaded.a, gaps: loaded.g };
  _syncCorrectionsHeader();
  const f = _fix;
  if (f) {
    if (f.aud?.ready) _auditionRerender(0, f.aud.duration);
    _scheduleRedraw();
  }
}

// ---------------------------------------------------------------------------
// Marks (session QA flags on the audio timeline) + the fix-mode keyboard
// ---------------------------------------------------------------------------

/** M: lay a mark at the playhead (or the selected onset before the audition
 *  is up); M near an existing mark clears it instead. */
function _toggleMark() {
  const f = _fix;
  const g = f.groups[f.selGroupIx];
  const t = f.aud?.ready ? _audPos() : g ? _groupRefTime(g) : null;
  if (!Number.isFinite(t)) return;
  const near = _marks.findIndex((m) => Math.abs(m - t) <= MARK_HIT_SEC);
  if (near !== -1) {
    if (_marks[near] === _activeMarkT) _activeMarkT = null;
    _marks.splice(near, 1);
  } else {
    _marks.push(t);
    _marks.sort((a, b) => a - b);
    _activeMarkT = null; // attention moved to the new mark; N activates
  }
  _scheduleRedraw();
}

/** The mark the last N-jump landed on (its preroll parks the playhead BEFORE
 *  the mark, so the next N must step from the mark itself, not the preroll). */
let _lastMarkJumpT = null;

/** Delete/Backspace on the ACTIVE mark (the last N-jump's target). */
function _removeActiveMark() {
  const at = _marks.indexOf(_activeMarkT);
  if (at !== -1) _marks.splice(at, 1);
  if (_lastMarkJumpT === _activeMarkT) _lastMarkJumpT = null;
  _activeMarkT = null;
  _scheduleRedraw();
}

/** N / Shift+N: skip to the next / previous mark (wrapping), selecting the
 *  onset there and seeking just before it — the fix → replay → next-mark
 *  loop's navigation half. */
function _jumpMark(dir) {
  const f = _fix;
  if (!_marks.length) return;
  const g = f.groups[f.selGroupIx];
  const pos = f.aud?.ready ? _audPos() : g ? _groupRefTime(g) : 0;
  let t = pos;
  if (
    _lastMarkJumpT !== null &&
    pos >= _lastMarkJumpT - SEEK_PREROLL_SEC - 0.05 &&
    pos <= _lastMarkJumpT + 0.05
  ) {
    t = _lastMarkJumpT;
  }
  let target;
  if (dir > 0) {
    target = _marks.find((m) => m > t + 0.05) ?? _marks[0];
  } else {
    const before = _marks.filter((m) => m < t - 0.05);
    target = before.length ? before[before.length - 1] : _marks[_marks.length - 1];
  }
  _lastMarkJumpT = target;
  _activeMarkT = target;
  const ix = _groupIxAtTime(target);
  if (ix !== -1) _select(ix, { seek: false });
  if (f.aud?.ready) {
    f.followFloor = null;
    // Mark jumps may cross pages; the pass expires at the mark itself.
    f.pageOnlyPassUntilT = target;
    _audSeek(Math.max(0, target - SEEK_PREROLL_SEC));
  }
  _scheduleRedraw();
}

/**
 * Fix mode's keyboard (listen.js's global handler stands down while a fix
 * session is open — see enterFixMode). Ctrl/Cmd combinations pass through:
 * undo and redo stay global on listen.js's stack by ruling, and Ctrl+Arrow
 * is macOS Mission Control's anyway (the page never sees it). Bare Alt+Arrow
 * is deliberately left to the browser too (history navigation on
 * Windows/Linux) — the nudge modifiers are Shift and Shift+Alt, the app's
 * existing marker-nudge convention.
 */
function _onFixKeydown(e) {
  const f = _fix;
  if (!f) return;
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
  if (
    e.target.closest?.(
      ".gm-modal, #settings-drawer, .lh-v6-drawer, .lh-v6-confirm-overlay",
    )
  ) {
    return;
  }
  if (e.ctrlKey || e.metaKey) return;
  const hadPendingNudge = !!f.drag?.keyboard;
  let handled = true;
  switch (e.code) {
    case "Space":
      if (e.altKey) {
        handled = false;
        break;
      }
      _commitPendingNudge();
      _audToggle();
      break;
    case "ArrowLeft":
    case "ArrowRight": {
      _heldArrows.add(e.code);
      const dir = e.code === "ArrowLeft" ? -1 : 1;
      if (e.shiftKey) _nudge(dir, e.altKey);
      else if (e.altKey) handled = false;
      else _skipOnset(dir);
      break;
    }
    case "ArrowUp":
    case "ArrowDown":
      if (e.shiftKey || e.altKey) {
        handled = false;
        break;
      }
      _turnPage(e.code === "ArrowUp" ? -1 : 1);
      break;
    case "Enter": {
      if (e.altKey) {
        handled = false;
        break;
      }
      if (hadPendingNudge) {
        // Enter on a floating nudge means "commit it now", not "approve".
        _commitPendingNudge();
        break;
      }
      const g = f.groups[f.selGroupIx];
      if (g) {
        _commitAnchor(f.selGroupIx, _groupRefTime(g), "approve").catch((err) =>
          console.error("fix mode: approve failed:", err),
        );
      }
      break;
    }
    case "KeyR":
      if (e.altKey || e.shiftKey) {
        handled = false;
        break;
      }
      // Deliberately does NOT commit a floating nudge: R means "let me hear
      // the last fix again", which is the whole point of suppressing the
      // automatic one, and a pending nudge is still being thought about.
      if (!_lastReplay) _announce("No fix to replay yet.");
      else if (!_replayFix(_lastReplay)) {
        _announce("The audition is still preparing.");
      }
      break;
    case "KeyM":
      if (e.altKey) {
        handled = false;
        break;
      }
      _commitPendingNudge();
      _toggleMark();
      break;
    case "KeyN":
      if (e.altKey) {
        handled = false;
        break;
      }
      _commitPendingNudge();
      _jumpMark(e.shiftKey ? -1 : 1);
      break;
    case "Delete":
    case "Backspace":
      if (e.altKey || _activeMarkT === null) {
        handled = false;
        break;
      }
      _commitPendingNudge();
      _removeActiveMark();
      break;
    case "Escape":
      if (hadPendingNudge) _cancelPendingNudge();
      else if (_activeMarkT !== null) {
        _activeMarkT = null; // first Escape deselects the mark…
        _scheduleRedraw();
      } else exitFixMode(); // …a bare one exits
      break;
    default:
      handled = false;
  }
  if (handled) {
    e.preventDefault();
    e.stopPropagation();
  }
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
  _setChip(
    "decoding",
    "Step 1/4: reference audio…",
    "Preparing correction engine: decoding reference audio…",
  );
  _syncReadyAffordance();
  const samples = await _decodeRefAudio(f.refFile);
  if (!_fix || _fix !== f) return; // exited while decoding

  // A decode also upgrades (or provides) the strip: peaks derived from the
  // full-rate samples beat the stored ~4k-point envelope at page zoom.
  const duration = samples.length / FIX_SR;
  _buildStrip({ peaks: _peaksFromSamples(samples), duration });
  _scheduleRedraw();

  // The audition copies the samples into its stereo buffer's left ear NOW —
  // the transfer below detaches them. Its synth render then chunks along in
  // the background; the play button arms when both ears are in.
  const auditionDone = _buildAudition(f, samples);
  auditionDone.catch((e) => {
    console.error("fix-mode audition build failed:", e);
  });

  _setChip(
    "loading",
    "Step 2/4: align runtime…",
    "Preparing correction engine: loading alignment runtime…",
  );
  const worker = _ensureWorker();
  worker.onmessage = (e) => {
    const d = e.data;
    // A pending realign owns the next fix_segment (or error) regardless of
    // which session is showing — the resolver's caller re-checks the session.
    if (_pendingRealign && (d.type === "fix_segment" || d.type === "error")) {
      const p = _pendingRealign;
      _pendingRealign = null;
      if (d.type === "fix_segment") p.resolve(d);
      else p.reject(new Error(d.message));
      return;
    }
    if (!_fix || _fix !== f) return;
    if (d.type === "progress") {
      // fix_begin's one progress message is the score synth. Shortened to
      // fit the chip's 28ch; the full text stays in the tooltip.
      const short = /synthesis/i.test(d.message) ? "score synth…" : "working…";
      _setChip(
        "loading",
        `Step 3/4: ${short}`,
        `Preparing correction engine: ${d.message}`,
      );
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
      f.engineReady = true;
      _setChip("ready", "Ready to correct");
      _syncReadyAffordance();
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
  const corrections = {
    anchors: _corrections.anchors.map((a) => ({ ...a })),
    gapCount: _corrections.gaps.length,
    headerPresent: !!loadedAlignmentJSON?.header?.corrections,
  };
  if (!_fix) {
    return {
      active: false,
      lastRefusal: _lastRefusal,
      prewarmReady: !!(_derived && _derived.pageCount),
      lastEntry: { ..._lastEntry },
      corrections,
      marks: [..._marks],
      lastAnnounce: _lastAnnounce,
    };
  }
  const f = _fix;
  const sel = f.groups[f.selGroupIx] || null;
  const selT = sel ? _groupRefTime(sel) : null;
  return {
    active: true,
    replaySuppressed: _replaySuppressed,
    lastReplay: _lastReplay
      ? { ..._lastReplay, startT: _replayStartT(_lastReplay.t0, _lastReplay.fixedT) }
      : null,
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
    selQ: sel?.q ?? null,
    selPage: sel?.page ?? null,
    selEventIx: sel?.eventIxs[0] ?? null,
    selT,
    selTickX: Number.isFinite(selT) ? _timeToStripX(selT) : null,
    ticksOnPage: f.ticksOnPage ?? 0,
    connectorCount: f.els.conn?.childElementCount ?? 0,
    stripWindow: f.stripWindow || null,
    stripHasWave: !!f.stripWS,
    stripPps: f.stripPps || 0,
    // The RENDERER's own geometry: scrollWidth is duration × pps once the zoom
    // has actually landed, and equals clientWidth while it has not — the one
    // observable that separates "the waveform shows this page" from "the
    // waveform shows the whole piece with this page's ticks over it".
    stripScroll: (() => {
      const el = f.stripWS?.getWrapper?.()?.parentElement;
      return el
        ? { left: el.scrollLeft, width: el.scrollWidth, client: el.clientWidth }
        : null;
    })(),
    chipState: f.chipState,
    groupStats: _lastGroupStats ? { ..._lastGroupStats } : null,
    corrections,
    marks: [..._marks],
    activeMark: _activeMarkT,
    lastAnnounce: _lastAnnounce,
    engineReady: f.engineReady,
    realignBusy: f.realignBusy,
    pendingNudge: f.drag?.keyboard
      ? { startT: f.drag.startT, curT: f.drag.curT }
      : null,
    lastCommit: f.lastCommit ? { ...f.lastCommit } : null,
    soundingGroup: f.soundingGroupIx,
    pageOnly: _pageOnly,
    pageWindow: (() => {
      const w = _pageTimeSlice();
      return w
        ? { startT: w.startT, endT: Number.isFinite(w.endT) ? w.endT : null }
        : null;
    })(),
    aud: f.aud
      ? {
          ready: f.aud.ready,
          rendering: f.aud.rendering,
          playing: f.aud.playing,
          time: _audPos(),
          duration: f.aud.duration,
          balance: _audBalance,
          rate: f.aud.rate,
          stretch: !!f.aud.stretch,
          workletPos: f.aud.workletPos,
          gainL: f.aud.gainL.gain.value,
          gainR: f.aud.gainR.gain.value,
          renderWindow: f.aud.lastRenderWindow ? { ...f.aud.lastRenderWindow } : null,
        }
      : null,
  };
}

/**
 * Test-only controls (attached as _listenTest.fixCtl by listen.js): drive the
 * audition deterministically and probe the stereo buffer's actual content.
 */
export const fixTestControl = {
  seek(t) {
    if (_fix) _fix.followFloor = null;
    _audSeek(t);
  },
  play: () => _audPlay(),
  pause: () => _audPause(),
  pos: () => _audPos(),
  /** Peak/RMS of the STRETCH WORKLET's own copy over [t0, t1) — what playback
   *  reads, which channelRms (the AudioBuffer) cannot see. */
  workletProbe: (t0, t1) => _workletProbe(t0, t1),
  /** RMS of one channel over [t0, t1] — proves an ear holds real signal. */
  channelRms(ch, t0, t1) {
    const a = _fix?.aud;
    if (!a) return null;
    const data = a.buffer.getChannelData(ch);
    const lo = Math.max(0, Math.floor(t0 * FIX_SR));
    const hi = Math.min(data.length, Math.ceil(t1 * FIX_SR));
    if (hi <= lo) return 0;
    let s = 0;
    for (let i = lo; i < hi; i++) s += data[i] * data[i];
    return Math.sqrt(s / (hi - lo));
  },
};
