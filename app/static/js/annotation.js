import { nsp, traverseAndFetch } from "./linked-data.js";
import {
  currentAudioIx,
  currentlyAnnotatedRegions,
  getAlignmentKeys,
  getAudioLinkedDataUri,
  getClosestAlignmentIx,
  getCorrespondingTime,
  getReferenceAudioIx,
  getWaveformPeaks,
  maoSelections,
  meiUri,
  markScoreRegion,
  swapCurrentAudio,
  updateRenderAnnoRegions,
  wavesurfers,
  _regionsPlugins,
  setDrawModeActive,
} from "./listen.js";
import {
  addMultipleMAOSelectionsToExtract,
  addNewMAOSelectionToExtract,
  createMAOExtract,
  createMAOMusicalMaterial,
  createMAOMusicalObject,
  createMAOSelection,
  establishContainers,
  establishDiscoveryResource,
  postWebAnnotation,
  resolveLocation,
  safelyPatchResource,
  solid,
} from "./solid.js";

const PRIMAL_BASE = "https://primal.mdw.ac.at/?obj=";

// ============================================================================
// Draft Annotation System
// ============================================================================

// Color palette for draft annotations (rotating)
const DRAFT_COLORS = [
  { bg: "rgba(59,130,246,0.25)", border: "#3b82f6" }, // blue
  { bg: "rgba(16,185,129,0.25)", border: "#10b981" }, // emerald
  { bg: "rgba(245,158,11,0.25)", border: "#f59e0b" }, // amber
  { bg: "rgba(168,85,247,0.25)", border: "#a855f7" }, // purple
  { bg: "rgba(236,72,153,0.25)", border: "#ec4899" }, // pink
  { bg: "rgba(20,184,166,0.25)", border: "#14b8a6" }, // teal
  { bg: "rgba(249,115,22,0.25)", border: "#f97316" }, // orange
  { bg: "rgba(99,102,241,0.25)", border: "#6366f1" }, // indigo
];

// Color palette for live (posted) annotations — same hues, more saturated
const LIVE_COLORS = [
  { bg: "rgba(59,130,246,0.45)", border: "#2563eb" }, // blue
  { bg: "rgba(16,185,129,0.45)", border: "#059669" }, // emerald
  { bg: "rgba(245,158,11,0.45)", border: "#d97706" }, // amber
  { bg: "rgba(168,85,247,0.45)", border: "#7c3aed" }, // purple
  { bg: "rgba(236,72,153,0.45)", border: "#db2777" }, // pink
  { bg: "rgba(20,184,166,0.45)", border: "#0d9488" }, // teal
  { bg: "rgba(249,115,22,0.45)", border: "#ea580c" }, // orange
  { bg: "rgba(99,102,241,0.45)", border: "#4f46e5" }, // indigo
];
let _liveColorIx = 0;
const _liveColorMap = new Map(); // extractUri / selectionUri → color object

/** Get the live color for an extract or selection URI. */
export function getLiveColor(uri) {
  return _liveColorMap.get(uri) || null;
}

const _drafts = new Map(); // draftId → Draft object
let _nextDraftId = 1;
let _activeDraftId = null; // draft currently in draw-region mode
let _draftColorIx = 0;

const _URI_MISSING_TOOLTIP =
  "Set a URI prefix in Manage Files → Linked Data URIs before posting";

/** Check whether every filename in the Set has an absolute audio LD URI. */
function _allHaveAbsoluteUri(filenames) {
  for (const fn of filenames) {
    const uri = getAudioLinkedDataUri(fn);
    if (!uri || !/^https?:\/\//i.test(uri)) return false;
  }
  return true;
}

/**
 * A draft annotation tracks user-drawn regions before posting to Solid.
 * @typedef {Object} Draft
 * @property {number} id
 * @property {string} label
 * @property {Object} color - { bg, border }
 * @property {Array<{from: number, to: number, localOverrides: Object}>} regions
 * @property {Set<string>} stagedRecordings
 * @property {boolean} includePeaks
 * @property {boolean} posted
 */

function createDraft() {
  const id = _nextDraftId++;
  const color = DRAFT_COLORS[_draftColorIx % DRAFT_COLORS.length];
  _draftColorIx++;
  const draft = {
    id,
    label: "",
    color,
    regions: [],
    stagedRecordings: new Set(),
    includePeaks: true,
    posted: false,
  };
  _drafts.set(id, draft);
  return draft;
}

/** Return all draft region descriptors for rendering on a given waveform. */
export function getDraftRegionsForWaveform(filename) {
  const result = [];
  for (const [draftId, draft] of _drafts) {
    if (draft.posted) continue;
    draft.regions.forEach((r, regionIx) => {
      let start, end;
      if (r.localOverrides && r.localOverrides[filename]) {
        start = r.localOverrides[filename].start;
        end = r.localOverrides[filename].end;
      } else {
        start = getCorrespondingTime(filename, r.from);
        end = getCorrespondingTime(filename, r.to);
      }
      result.push({
        id: `draft_${draftId}_region_${regionIx}`,
        start,
        end,
        drag: true,
        resize: true,
        color: draft.color.bg,
      });
    });
  }
  return result;
}

/** Return the ID of the draft currently in draw-region mode, or null. */
export function getActiveDraftId() {
  return _activeDraftId;
}

/** Handle a draft region being dragged/resized on a waveform. */
export function onDraftRegionUpdated(filename, region) {
  // Parse draft_N_region_M
  const match = region.id.match(/^draft_(\d+)_region_(\d+)$/);
  if (!match) return;
  const draftId = parseInt(match[1]);
  const regionIx = parseInt(match[2]);
  const draft = _drafts.get(draftId);
  if (!draft || !draft.regions[regionIx]) return;

  const isShiftPressed = window.event && window.event.shiftKey;
  if (isShiftPressed) {
    if (!draft.regions[regionIx].localOverrides) {
      draft.regions[regionIx].localOverrides = {};
    }
    draft.regions[regionIx].localOverrides[filename] = {
      start: region.start,
      end: region.end,
    };
  } else {
    const newFrom = getClosestAlignmentIx(region.start, filename);
    const newTo = getClosestAlignmentIx(region.end, filename);
    draft.regions[regionIx].localOverrides = {};
    draft.regions[regionIx].from = newFrom;
    draft.regions[regionIx].to = newTo;
    updateRenderAnnoRegions();
    _updateDraftRegionList(draftId);
  }
}

/**
 * Called when the user draws a new region on a waveform via RegionsPlugin.
 * Converts to alignment indices and adds to the active draft.
 */
export function onDraftRegionCreated(filename, region) {
  if (!_activeDraftId) {
    region.remove();
    return;
  }
  const draft = _drafts.get(_activeDraftId);
  if (!draft) {
    region.remove();
    return;
  }
  // Convert to alignment indices
  const from = getClosestAlignmentIx(region.start, filename);
  const to = getClosestAlignmentIx(region.end, filename);
  // Remove the raw WaveSurfer region — we'll re-render via updateRenderAnnoRegions
  region.remove();
  // Add to draft
  draft.regions.push({ from, to, localOverrides: {} });
  // Re-render all waveforms to show the new region
  updateRenderAnnoRegions();
  // Update the region count and list on the card
  _updateDraftRegionList(draft.id);
}

function _updateDraftRegionCount(draftId) {
  const draft = _drafts.get(draftId);
  if (!draft) return;
  const card = document.getElementById(`draft-card-${draftId}`);
  if (!card) return;
  const countEl = card.querySelector(".draft-region-count");
  if (countEl) {
    const n = draft.regions.length;
    countEl.textContent =
      n === 0 ? "No regions drawn" : `${n} region${n > 1 ? "s" : ""}`;
  }
}

// --- MusicalMaterial ↔ Extract mapping ---
// Populated during traversal: extractUri → musicalMaterialUri
const _extractToMusMat = new Map();

/**
 * Handler called by traverseAndFetch when a MusicalMaterial resource is found.
 * Stores the mapping so that annotation cards can look up their MusicalMaterial.
 * Also retroactively updates any already-drawn card whose Extract matches.
 */
export function registerMusicalMaterial(obj, url) {
  const musMatUri =
    typeof url === "object" && url.href ? url.href : String(url);
  const settings = obj[nsp.MAO + "setting"];
  if (settings) {
    const arr = Array.isArray(settings) ? settings : [settings];
    arr.forEach((s) => {
      if (s["@id"]) {
        const extractKey = String(s["@id"]);
        _extractToMusMat.set(extractKey, musMatUri);
        // Retroactively update any already-drawn card for this Extract
        const card = document.getElementById(extractKey);
        if (card) {
          card.dataset.musicalMaterial = musMatUri;
          // Show the Primal button if it was hidden
          const primalLink = card.querySelector(".primal-btn");
          if (primalLink) {
            primalLink.href = PRIMAL_BASE + encodeURIComponent(musMatUri);
            primalLink.style.display = "";
          }
        }
      }
    });
  }
}

// --- Annotation loop playback state ---
let _activeLoop = null; // { regionIx, playBtn, intervalId, pauseCleanup }

/** Returns true if an annotation loop is currently active. */
export function hasActiveAnnotationLoop() {
  return _activeLoop !== null;
}

/**
 * Continue the active annotation loop on a newly-switched waveform.
 * Called from listen.js swapCurrentAudio() after the new waveform is active.
 */
export function continueAnnotationLoopOnWaveform(newFilename) {
  if (!_activeLoop) return;
  // Start the loop on the new waveform (old monitor already cleaned up)
  _startLoopOnWaveform(newFilename, _activeLoop.regionIx, _activeLoop.playBtn);
}

/**
 * Detach the loop's pause listener from the old waveform so that the
 * upcoming waveform pause during swap doesn't kill the loop.
 * Must be called BEFORE pausing the old waveform in swapCurrentAudio.
 */
export function prepareAnnotationLoopTransfer() {
  if (!_activeLoop) return;
  // Remove the interval + pause listener on the old waveform
  if (_activeLoop.intervalId) clearInterval(_activeLoop.intervalId);
  _activeLoop.intervalId = null;
  if (_activeLoop.pauseCleanup) {
    _activeLoop.pauseCleanup();
    _activeLoop.pauseCleanup = null;
  }
}

/** Stop the active annotation loop entirely (e.g. when card is dismissed). */
export function stopAnnotationLoop() {
  if (!_activeLoop) return;
  _cleanupLoopMonitor();
  const btn = _activeLoop.playBtn;
  _activeLoop = null;
  if (btn && btn.classList.contains("playing")) {
    btn.classList.remove("playing");
    btn.innerHTML = "\u25B6 Play";
  }
  // Pause whichever waveform is active
  const audioToStop = currentAudioIx || Object.keys(wavesurfers)[0];
  if (audioToStop && wavesurfers[audioToStop]) {
    wavesurfers[audioToStop].pause();
  }
}

function _cleanupLoopMonitor() {
  if (!_activeLoop) return;
  if (_activeLoop.intervalId) clearInterval(_activeLoop.intervalId);
  _activeLoop.intervalId = null;
  // Remove the one-time pause listener if still attached
  if (_activeLoop.pauseCleanup) {
    _activeLoop.pauseCleanup();
    _activeLoop.pauseCleanup = null;
  }
}

function _startLoopOnWaveform(filename, regionIx, playBtn) {
  const regionId = "anno_region_" + regionIx;
  const regPlugin = _regionsPlugins[filename];
  const region =
    regPlugin && regPlugin.getRegions().find((r) => r.id === regionId);
  if (!region) {
    console.warn("Region not found on waveform for loop:", regionId, filename);
    return;
  }
  region.play();
  const ws = wavesurfers[filename];
  const intervalId = setInterval(() => {
    if (!_activeLoop || !playBtn.classList.contains("playing")) {
      clearInterval(intervalId);
      return;
    }
    if (ws.getCurrentTime() >= region.end) {
      region.play();
    }
  }, 50);
  // Pause handler: if user stops via main controls, cleanly turn off the loop
  const onPause = () => {
    if (_activeLoop && playBtn.classList.contains("playing")) {
      stopAnnotationLoop();
    }
  };
  // .once() wraps the callback — use the returned unsub function for cleanup
  const unsubPause = ws.once("pause", onPause);
  // Update active loop state
  _activeLoop = { regionIx, playBtn, intervalId, pauseCleanup: unsubPause };
}

// --- Selection mode state ---
let _activeSelectionCardId = null; // extract @id of card in selection mode
let _stagedSelections = {}; // extractId -> Set of filenames staged for posting

/** Returns the extract ID currently in selection mode, or null */
export function getActiveSelectionCardId() {
  return _activeSelectionCardId;
}

/** Toggle a waveform filename as staged for the current active card */
export function toggleStagedSelection(filename) {
  if (!_activeSelectionCardId) return;
  if (!_stagedSelections[_activeSelectionCardId]) {
    _stagedSelections[_activeSelectionCardId] = new Set();
  }
  const set = _stagedSelections[_activeSelectionCardId];
  if (set.has(filename)) {
    set.delete(filename);
  } else {
    set.add(filename);
  }
  _updateStagedListUI(_activeSelectionCardId);
  _updateWaveformIcons();
}

/** Check whether a filename is staged for the current active card */
export function isStagedSelection(filename) {
  if (!_activeSelectionCardId) return false;
  const set = _stagedSelections[_activeSelectionCardId];
  return set ? set.has(filename) : false;
}

function _enterSelectionMode(extractId) {
  // Exit any previous selection mode
  if (_activeSelectionCardId && _activeSelectionCardId !== extractId) {
    _exitSelectionMode(_activeSelectionCardId);
  }
  _activeSelectionCardId = extractId;
  const card = document.getElementById(extractId);
  if (card) card.classList.add("selecting");
  _updateWaveformIcons();
  _updateStagedListUI(extractId);
}

function _exitSelectionMode(extractId) {
  _activeSelectionCardId = null;
  const card = document.getElementById(extractId);
  if (card) card.classList.remove("selecting");
  _updateWaveformIcons();
}

function _updateWaveformIcons() {
  const inMode = _activeSelectionCardId !== null;
  document.querySelectorAll(".wf-select-overlay").forEach((overlay) => {
    const filename = overlay.closest(".waveform")?.dataset.ix;
    if (inMode) {
      overlay.classList.add("visible");
      overlay.classList.toggle("staged", isStagedSelection(filename));
    } else {
      overlay.classList.remove("visible", "staged");
    }
  });
}

function _updateStagedListUI(extractId) {
  const card = document.getElementById(extractId);
  if (!card) return;
  const listEl = card.querySelector(".staged-list");
  const countEl = card.querySelector(".staged-count");
  const postBtn = card.querySelector(".post-to-solid-btn");
  const set = _stagedSelections[extractId] || new Set();
  if (countEl) {
    countEl.textContent = set.size
      ? `${set.size} recording${set.size > 1 ? "s" : ""} selected`
      : "No recordings selected";
  }
  if (listEl) {
    listEl.innerHTML = "";
    for (const fn of set) {
      const li = document.createElement("li");
      li.textContent = fn.substring(fn.lastIndexOf("/") + 1);
      li.title = fn;
      listEl.appendChild(li);
    }
  }
  if (postBtn) {
    const hasAbsUri = set.size > 0 && _allHaveAbsoluteUri(set);
    postBtn.disabled = set.size === 0 || !hasAbsUri;
    postBtn.title = set.size > 0 && !hasAbsUri ? _URI_MISSING_TOOLTIP : "";
  }
}

/**
 * Returns all URL aliases for a given URI, transparently normalizing
 * raw.githubusercontent.com URLs between their `refs/heads/<branch>` and
 * bare `<branch>` forms. For non-GitHub URLs, returns a single-element array.
 */
function githubRawAliases(uri) {
  if (!uri) return [uri];
  const decoded = decodeURI(uri);
  const aliases = new Set([uri, decoded]);
  // Match: https://raw.githubusercontent.com/<owner>/<repo>/refs/heads/<branch>/...
  const withRefs =
    /^(https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/)refs\/heads\/(.+)$/;
  // Match: https://raw.githubusercontent.com/<owner>/<repo>/<branch>/...  (no refs/heads)
  const withoutRefs =
    /^(https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/)(?!refs\/)(.+)$/;
  for (const u of [uri, decoded]) {
    let m;
    if ((m = u.match(withRefs))) {
      // Add the bare form (without refs/heads/)
      aliases.add(m[1] + m[2]);
    } else if ((m = u.match(withoutRefs))) {
      // Add the refs/heads/ form, but only if the first path component looks like a
      // branch name (no dots — avoids false-matching commit SHA paths).
      const firstComponent = m[2].split("/")[0];
      if (!firstComponent.includes(".")) {
        aliases.add(m[1] + "refs/heads/" + m[2]);
      }
    }
  }
  return Array.from(aliases);
}

/** Returns true if candidateUri is an alias of referenceUri. */
function meiUriMatches(referenceUri, candidateUri) {
  const refAliases = githubRawAliases(referenceUri);
  const candAliases = githubRawAliases(candidateUri);
  return refAliases.some((r) => candAliases.includes(r));
}

/**
 * Returns true if candidateUri matches any currently loaded context:
 * - the alignment score (meiUri), OR
 * - any loaded audio file's linked-data URI.
 */
function _uriMatchesLoadedContext(candidateUri) {
  // Check alignment score URI
  if (meiUri && meiUriMatches(meiUri, candidateUri)) return true;
  // Check all loaded audio URIs
  const keys = getAlignmentKeys();
  for (const key of keys) {
    const audioUri = getAudioLinkedDataUri(key);
    if (audioUri && meiUriMatches(audioUri, candidateUri)) return true;
  }
  return false;
}

/** Briefly display a dismissible notification in the Solid drawer. */
function _showAnnotationNotice(message) {
  const drawer = document.getElementById("solidTab");
  if (!drawer) {
    console.warn(message);
    return;
  }
  const notice = document.createElement("div");
  notice.className = "annotation-notice";
  const span = document.createElement("span");
  span.textContent = message;
  notice.appendChild(span);
  const btn = document.createElement("button");
  btn.className = "annotation-notice-dismiss";
  btn.title = "Dismiss";
  btn.textContent = "\u2715";
  btn.addEventListener("click", () => notice.remove());
  notice.appendChild(btn);
  drawer.appendChild(notice);
}

// Wrapper around traverseAndFetch that reports back errors / progress to 'Load linked data' UI
export function attemptFetchExternalResource(url, targetTypes, configObj) {
  console.log("fetch external resource: ", url, targetTypes, configObj);
  // spin the icon to indicate loading activity
  traverseAndFetch(url, targetTypes, configObj).catch((resp) => {
    console.warn("Couldn't traverseAndFetch: ", resp);
  });
}

export function registerExtract(obj, url) {
  const aboutProp = nsp.SCHEMA + "about";
  if (aboutProp in obj && Array.isArray(obj[aboutProp])) {
    let matching = obj[aboutProp].filter((m) =>
      _uriMatchesLoadedContext(m["@id"]),
    );
    if (matching.length) {
      obj["@id"] = url;
      drawExtractUIElement(obj);
    } else {
      const aboutUris = obj[aboutProp].map((m) => m["@id"]).join(", ");
      _showAnnotationNotice(
        `Skipped annotation: it is about "${aboutUris}", ` +
          `which does not match any loaded audio or score URI.`,
      );
    }
  }
}

export function unloadAnnotation(annotationId) {
  // The card's DOM id is the extract URI, but currentlyAnnotatedRegions
  // tracks by the selection (embodiment) URI stored in dataset.selection.
  const el = document.getElementById(annotationId);
  const selectionUri = el ? el.dataset.selection : annotationId;

  // Remove from our tracker array
  const ix = currentlyAnnotatedRegions.findIndex(
    (r) => r.selection === selectionUri,
  );
  if (ix >= 0) {
    currentlyAnnotatedRegions.splice(ix, 1);
  }

  // Remove from the maoSelections cache so it can be re-loaded later
  if (selectionUri in maoSelections) {
    delete maoSelections[selectionUri];
  }

  // Re-render waveforms to clear the region overlay
  updateRenderAnnoRegions();

  // Remove from DOM
  if (el) el.remove();
}

function drawExtractUIElement(obj) {
  let extractsPanel = document.getElementById("maoExtracts");

  // Don't draw duplicates
  if (document.getElementById(obj["@id"])) return;

  // Assign a rotating live color to this extract
  const extractUri = obj["@id"];
  if (!_liveColorMap.has(extractUri)) {
    _liveColorMap.set(
      extractUri,
      LIVE_COLORS[_liveColorIx % LIVE_COLORS.length],
    );
    _liveColorIx++;
  }
  const liveColor = _liveColorMap.get(extractUri);

  // Also map each selection (embodiment) URI to the same color
  if (obj[nsp.FRBR + "embodiment"]) {
    obj[nsp.FRBR + "embodiment"].forEach((e) => {
      _liveColorMap.set(e["@id"], liveColor);
    });
  }

  let extract = document.createElement("div");
  extract.id = obj["@id"];
  extract.className = "maoExtract";
  extract.style.borderColor = liveColor.border;
  extract.dataset.selection = obj[nsp.FRBR + "embodiment"][0]["@id"];

  // Card header with label and dismiss button
  let header = document.createElement("div");
  header.className = "maoExtract-header";

  let labelText = obj[nsp.RDFS + "label"]
    ? obj[nsp.RDFS + "label"][0]["@value"]
    : "Untitled Annotation";
  let label = document.createElement("div");
  label.className = "maoExtract-label";
  label.innerText = labelText;
  label.title = labelText;

  let colorBadge = document.createElement("span");
  colorBadge.className = "extract-color-badge";
  colorBadge.style.background = liveColor.border;

  let dismissBtn = document.createElement("button");
  dismissBtn.className = "maoExtract-dismiss";
  dismissBtn.innerHTML = "\u2715";
  dismissBtn.title = "Unload annotation";

  dismissBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    // Exit selection mode if this card was active
    if (_activeSelectionCardId === obj["@id"]) {
      _exitSelectionMode(obj["@id"]);
    }
    delete _stagedSelections[obj["@id"]];
    unloadAnnotation(obj["@id"]);
  });

  header.appendChild(colorBadge);
  header.appendChild(label);
  header.appendChild(dismissBtn);
  extract.appendChild(header);

  // Playback controls container
  let controls = document.createElement("div");
  controls.className = "extractTools";

  let playBtn = document.createElement("button");
  playBtn.className = "extract-play-btn";
  playBtn.innerHTML = "\u25B6 Play";

  playBtn.addEventListener("click", () => {
    // If we're already playing this loop, stop it
    if (playBtn.classList.contains("playing")) {
      stopAnnotationLoop();
      return;
    }

    // Stop any other active annotation loop first
    stopAnnotationLoop();

    // Determine the target waveform — activate first if none active
    let targetAudio = currentAudioIx;
    if (!targetAudio || !wavesurfers[targetAudio]) {
      const firstKey = Object.keys(wavesurfers)[0];
      if (!firstKey) {
        console.warn("No waveform available to play annotation");
        return;
      }
      swapCurrentAudio(firstKey);
      targetAudio = firstKey;
    }

    // Find the corresponding region
    let mySelections = obj[nsp.FRBR + "embodiment"].map((e) => e["@id"]);
    let regionIx = currentlyAnnotatedRegions.findIndex((r) =>
      mySelections.includes(r.selection),
    );
    if (regionIx < 0) {
      console.warn("No matching region found for annotation");
      return;
    }

    // Mark as playing
    playBtn.classList.add("playing");
    playBtn.innerHTML = "\u25A0 Stop";

    // Start loop on the active waveform
    _startLoopOnWaveform(targetAudio, regionIx, playBtn);
  });

  // --- Select Recordings toggle button ---
  let selectBtn = document.createElement("button");
  selectBtn.className = "extract-select-btn";
  selectBtn.innerHTML = "Select Recordings";
  selectBtn.addEventListener("click", () => {
    if (_activeSelectionCardId === obj["@id"]) {
      // Already in selection mode for this card — exit
      _exitSelectionMode(obj["@id"]);
      selectBtn.innerHTML = "Select Recordings";
    } else {
      // Enter selection mode
      // Exit draft selection if active
      if (_activeDraftSelectionId !== null) {
        _exitDraftSelectionMode();
      }
      // Reset any other card's button text
      document.querySelectorAll(".extract-select-btn").forEach((b) => {
        b.innerHTML = "Select Recordings";
      });
      _enterSelectionMode(obj["@id"]);
      selectBtn.innerHTML = "Cancel Selection";
    }
  });

  controls.appendChild(playBtn);
  controls.appendChild(selectBtn);
  extract.appendChild(controls);

  // --- Staged selections area (visible during selection mode) ---
  let stagedArea = document.createElement("div");
  stagedArea.className = "staged-area";

  let stagedCount = document.createElement("div");
  stagedCount.className = "staged-count";
  stagedCount.textContent = "No recordings selected";
  stagedArea.appendChild(stagedCount);

  let stagedDetails = document.createElement("details");
  let stagedSummary = document.createElement("summary");
  stagedSummary.textContent = "Show selected";
  stagedDetails.appendChild(stagedSummary);
  let stagedList = document.createElement("ul");
  stagedList.className = "staged-list";
  stagedDetails.appendChild(stagedList);
  stagedArea.appendChild(stagedDetails);

  // --- Include peaks checkbox ---
  let peaksLabel = document.createElement("label");
  peaksLabel.className = "include-peaks-label";
  let peaksCb = document.createElement("input");
  peaksCb.type = "checkbox";
  peaksCb.className = "include-peaks-cb";
  peaksCb.checked = true;
  peaksLabel.appendChild(peaksCb);
  peaksLabel.append(" Include peaks");
  stagedArea.appendChild(peaksLabel);

  // --- Solid posting clarification ---
  let postHint = document.createElement("p");
  postHint.className = "post-hint";
  postHint.textContent =
    "Posts timeline annotations and (optionally) waveform envelope data. No audio information is ever posted.";
  stagedArea.appendChild(postHint);

  // --- Post to Solid button ---
  let postBtn = document.createElement("button");
  postBtn.className = "post-to-solid-btn";
  postBtn.textContent = "Post to Solid";
  postBtn.disabled = true;
  postBtn.addEventListener("click", async () => {
    const extractId = obj["@id"];
    const set = _stagedSelections[extractId];
    if (!set || set.size === 0) return;
    postBtn.disabled = true;
    postBtn.textContent = "Posting\u2026";
    try {
      // Build all selection items, then post them in one batched call
      const items = [];
      for (const filename of set) {
        const selectionUri = extract.dataset.selection;
        const regionIx = currentlyAnnotatedRegions.findIndex(
          (r) => r.selection === selectionUri,
        );
        let regionStart = 0,
          regionEnd = 0;
        if (regionIx >= 0) {
          const globalRegion = currentlyAnnotatedRegions[regionIx];
          if (
            globalRegion.localOverrides &&
            globalRegion.localOverrides[filename]
          ) {
            regionStart = globalRegion.localOverrides[filename].start;
            regionEnd = globalRegion.localOverrides[filename].end;
          } else {
            regionStart = getCorrespondingTime(filename, globalRegion.from);
            regionEnd = getCorrespondingTime(filename, globalRegion.to);
          }
        }
        const audioBaseUri = getAudioLinkedDataUri(filename);
        const audioMediaUri = `${audioBaseUri}#t=${regionStart},${regionEnd}`;
        const peaksData = peaksCb.checked ? getWaveformPeaks(filename) : null;
        items.push({
          currentFileUri: audioBaseUri,
          selectedElements: audioMediaUri,
          peaksData,
        });
      }
      await addMultipleMAOSelectionsToExtract(items, extractId, labelText);
      postBtn.textContent = `Posted ${set.size} selection${set.size > 1 ? "s" : ""}!`;
      setTimeout(() => {
        postBtn.textContent = "Post to Solid";
      }, 3000);
    } catch (e) {
      console.error("Error posting selections to Solid:", e);
      postBtn.textContent = "Error \u2014 retry?";
    }
    postBtn.disabled = false;
  });
  stagedArea.appendChild(postBtn);

  extract.appendChild(stagedArea);

  // --- Describe area ---
  let describeArea = document.createElement("div");
  describeArea.className = "describe-area";

  let descTextarea = document.createElement("textarea");
  descTextarea.className = "describe-textarea";
  descTextarea.placeholder = "Add a textual description\u2026";
  descTextarea.rows = 2;
  describeArea.appendChild(descTextarea);

  let descBtnRow = document.createElement("div");
  descBtnRow.className = "describe-btn-row";

  let describeBtn = document.createElement("button");
  describeBtn.className = "describe-btn";
  describeBtn.textContent = "Describe";
  describeBtn.addEventListener("click", async () => {
    const text = descTextarea.value.trim();
    if (!text) return;
    const musMatUri = extract.dataset.musicalMaterial;
    if (!musMatUri) {
      console.warn("No MusicalMaterial URI available for this annotation card");
      describeBtn.textContent = "No target \u2014 load from Solid first";
      setTimeout(() => {
        describeBtn.textContent = "Describe";
      }, 3000);
      return;
    }
    describeBtn.disabled = true;
    describeBtn.textContent = "Posting\u2026";
    try {
      const resp = await postWebAnnotation(musMatUri, text);
      const annotationUri = resolveLocation(resp);
      describeBtn.textContent = "Posted!";
      // Show the Open in Primal button — point to the newly created annotation
      primalBtn.style.display = "";
      primalBtn.href = PRIMAL_BASE + encodeURIComponent(annotationUri);
      setTimeout(() => {
        describeBtn.textContent = "Describe";
        describeBtn.disabled = false;
      }, 3000);
    } catch (e) {
      console.error("Error posting Web Annotation:", e);
      describeBtn.textContent = "Error \u2014 retry?";
      describeBtn.disabled = false;
    }
  });
  descBtnRow.appendChild(describeBtn);

  let primalBtn = document.createElement("a");
  primalBtn.className = "primal-btn";
  primalBtn.textContent = "Open in Primal";
  primalBtn.target = "_blank";
  primalBtn.rel = "noopener noreferrer";
  primalBtn.style.display = "none"; // shown once MusicalMaterial URI is known
  // Look up MusicalMaterial URI — use string key to match _extractToMusMat entries
  const extractIdStr = String(obj["@id"]);
  const knownMusMat = _extractToMusMat.get(extractIdStr);
  if (knownMusMat) {
    primalBtn.href = PRIMAL_BASE + encodeURIComponent(knownMusMat);
    primalBtn.style.display = "";
  }
  descBtnRow.appendChild(primalBtn);

  describeArea.appendChild(descBtnRow);
  extract.appendChild(describeArea);

  // Store MusicalMaterial URI on card if known (registerMusicalMaterial
  // will fill this retroactively if MusMat arrives after card is drawn)
  extract.dataset.musicalMaterial = knownMusMat || "";

  extractsPanel.insertAdjacentElement("beforeend", extract);
}

function markScoreRegions(selections) {
  console.log("I was initially called with selections ", selections);
  // use only selections about the current score URI
  let matchingSelectionUrls = selections.filter((s) => {
    let selObj = maoSelections[s["@id"]];
    if (selObj && nsp.SCHEMA + "about" in selObj) {
      return selObj[nsp.SCHEMA + "about"].some((t) =>
        meiUriMatches(meiUri, t["@id"]),
      );
    }
    return false;
  });
  if (matchingSelectionUrls.length) {
    matchingSelectionUrls.forEach((s) => {
      let url = s["@id"];
      if (url in maoSelections) {
        let obj = maoSelections[url];
        let selectedElementIds = obj[nsp.FRBR + "part"].map((uri) =>
          uri["@id"].substr(uri["@id"].lastIndexOf("#") + 1),
        );
        if (selectedElementIds.length) {
          console.log("I was successfully called with selections ", selections);
          markScoreRegion(selectedElementIds, url);
        }
      } else {
        console.warn(
          "setActiveSelection: Attempting to switch to unknown selection ",
          url,
        );
      }
    });
  } else {
    console.warn(
      "setActiveSelection supplied without any selections matching the current meiUrl:",
      selections,
    );
  }
}

export function markSelection(obj, url) {
  if (url in maoSelections) {
    return; // skip processing of selections we already know about
  }
  if (obj && "@type" in obj && obj["@type"].includes(nsp.MAO + "Selection")) {
    if (nsp.SCHEMA + "about" in obj) {
      let about = obj[nsp.SCHEMA + "about"];
      if (!Array.isArray(about)) {
        about = [about];
      }
      let selectionResource = about.filter((f) =>
        _uriMatchesLoadedContext(f["@id"]),
      );
      if (selectionResource.length) {
        if (nsp.FRBR + "part" in obj) {
          maoSelections[url] = obj;
          // Only attempt score-region marking if there is a score alignment
          if (meiUri) {
            markScoreRegions([{ "@id": url }]);
          }
        } else {
          console.warn("Selection without parts: ", obj);
        }
      }
    }
  } else {
    console.warn("markSelection called on non-selection object:", obj);
  }
}

// ============================================================================
// "New Annotation" button + draft card UI
// ============================================================================

/**
 * Initialise the "New Annotation" button inside #maoExtracts.
 * Called once from listen.js after DOM is ready and alignment is loaded.
 */
export function initNewAnnotationButton() {
  const panel = document.getElementById("maoExtracts");
  if (!panel || document.getElementById("new-annotation-btn")) return;
  const btn = document.createElement("button");
  btn.id = "new-annotation-btn";
  btn.textContent = "+ New Annotation";
  btn.title = "Create a new annotation draft";
  btn.style.display = "none"; // shown when Solid is logged in
  btn.addEventListener("click", () => {
    const draft = createDraft();
    _drawDraftCard(draft);
  });
  panel.prepend(btn);
  // Show/hide based on Solid login state (check immediately + observe changes)
  _refreshNewAnnotationBtnVisibility();
}

/** Show the button only when Solid session is active. */
function _refreshNewAnnotationBtnVisibility() {
  const btn = document.getElementById("new-annotation-btn");
  if (!btn) return;
  const isLoggedIn = solid.getDefaultSession().info.isLoggedIn;
  btn.style.display = isLoggedIn ? "" : "none";
}

/** Call after Solid login/logout to update button visibility and tab badge. */
export function onSolidAuthChanged() {
  _refreshNewAnnotationBtnVisibility();
  
  // Update the RDF drawer button styling to reflect login status
  const isLoggedIn = solid.getDefaultSession().info.isLoggedIn;
  const rdfBtn = document.getElementById("solid-drawer-btn");
  if (rdfBtn) {
    if (isLoggedIn) {
      rdfBtn.classList.add("logged-in");
    } else {
      rdfBtn.classList.remove("logged-in");
    }
  }
}

function _drawDraftCard(draft) {
  const panel = document.getElementById("maoExtracts");
  if (!panel) return;

  const card = document.createElement("div");
  card.id = `draft-card-${draft.id}`;
  card.className = "maoExtract draft-card";
  card.style.borderColor = draft.color.border;

  // --- Header ---
  const header = document.createElement("div");
  header.className = "maoExtract-header";

  const colorBadge = document.createElement("span");
  colorBadge.className = "draft-color-badge";
  colorBadge.style.background = draft.color.border;

  const labelInput = document.createElement("input");
  labelInput.type = "text";
  labelInput.className = "draft-label-input";
  labelInput.placeholder = "Annotation label\u2026";
  labelInput.value = draft.label;
  labelInput.addEventListener("input", () => {
    draft.label = labelInput.value;
  });

  const dismissBtn = document.createElement("button");
  dismissBtn.className = "maoExtract-dismiss";
  dismissBtn.innerHTML = "\u2715";
  dismissBtn.title = "Discard draft";
  dismissBtn.addEventListener("click", () => {
    _discardDraft(draft.id);
  });

  header.appendChild(colorBadge);
  header.appendChild(labelInput);
  header.appendChild(dismissBtn);
  card.appendChild(header);

  // --- Region drawing controls ---
  const regionControls = document.createElement("div");
  regionControls.className = "extractTools";

  const drawBtn = document.createElement("button");
  drawBtn.className = "extract-draw-btn";
  drawBtn.textContent = "Draw Regions";
  drawBtn.addEventListener("click", () => {
    if (_activeDraftId === draft.id) {
      _exitDrawMode();
      drawBtn.textContent = "Draw Regions";
      card.classList.remove("drawing");
    } else {
      _enterDrawMode(draft.id);
      // Update all other cards' buttons
      document.querySelectorAll(".extract-draw-btn").forEach((b) => {
        if (b !== drawBtn) {
          b.textContent = "Draw Regions";
          b.closest(".draft-card")?.classList.remove("drawing");
        }
      });
      drawBtn.textContent = "Stop Drawing";
      card.classList.add("drawing");
    }
  });

  const regionCount = document.createElement("span");
  regionCount.className = "draft-region-count";
  regionCount.textContent = "No regions drawn";

  regionControls.appendChild(drawBtn);
  regionControls.appendChild(regionCount);
  card.appendChild(regionControls);

  // --- Region list with delete buttons ---
  const regionList = document.createElement("ul");
  regionList.className = "draft-region-list";
  card.appendChild(regionList);

  // --- Select Recordings toggle ---
  const selectBtn = document.createElement("button");
  selectBtn.className = "extract-select-btn";
  selectBtn.textContent = "Select Recordings";
  selectBtn.addEventListener("click", () => {
    if (_activeDraftSelectionId === draft.id) {
      _exitDraftSelectionMode();
      selectBtn.textContent = "Select Recordings";
      card.classList.remove("selecting");
    } else {
      // Exit any other selection mode
      if (_activeSelectionCardId) {
        _exitSelectionMode(_activeSelectionCardId);
        document.querySelectorAll(".extract-select-btn").forEach((b) => {
          b.textContent = "Select Recordings";
        });
      }
      if (_activeDraftSelectionId !== null) {
        _exitDraftSelectionMode();
      }
      _enterDraftSelectionMode(draft.id);
      selectBtn.textContent = "Cancel Selection";
      card.classList.add("selecting");
    }
  });
  card.appendChild(selectBtn);

  // --- Staged recordings area ---
  const stagedArea = document.createElement("div");
  stagedArea.className = "staged-area";

  const stagedCount = document.createElement("div");
  stagedCount.className = "staged-count";
  stagedCount.textContent = "No recordings selected";
  stagedArea.appendChild(stagedCount);

  const stagedDetails = document.createElement("details");
  const stagedSummary = document.createElement("summary");
  stagedSummary.textContent = "Show selected";
  stagedDetails.appendChild(stagedSummary);
  const stagedList = document.createElement("ul");
  stagedList.className = "staged-list";
  stagedDetails.appendChild(stagedList);
  stagedArea.appendChild(stagedDetails);

  // Include peaks checkbox
  const peaksLabel = document.createElement("label");
  peaksLabel.className = "include-peaks-label";
  const peaksCb = document.createElement("input");
  peaksCb.type = "checkbox";
  peaksCb.className = "include-peaks-cb";
  peaksCb.checked = draft.includePeaks;
  peaksCb.addEventListener("change", () => {
    draft.includePeaks = peaksCb.checked;
  });
  peaksLabel.appendChild(peaksCb);
  peaksLabel.append(" Include peaks");
  stagedArea.appendChild(peaksLabel);

  const postHint = document.createElement("p");
  postHint.className = "post-hint";
  postHint.textContent =
    "Posts timeline annotations and (optionally) waveform envelope data. No audio information is ever posted.";
  stagedArea.appendChild(postHint);

  // Post to Solid button
  const postBtn = document.createElement("button");
  postBtn.className = "post-to-solid-btn";
  postBtn.textContent = "Post to Solid";
  postBtn.disabled = true;
  postBtn.addEventListener("click", () => _postDraftToSolid(draft.id));
  stagedArea.appendChild(postBtn);

  card.appendChild(stagedArea);

  // Insert after the "New Annotation" button
  const newAnnoBtn = document.getElementById("new-annotation-btn");
  if (newAnnoBtn && newAnnoBtn.nextSibling) {
    panel.insertBefore(card, newAnnoBtn.nextSibling);
  } else {
    panel.appendChild(card);
  }
}

// --- Draft selection mode (reuses waveform overlay icons) ---
let _activeDraftSelectionId = null;

function _enterDraftSelectionMode(draftId) {
  _activeDraftSelectionId = draftId;
  _updateDraftWaveformIcons();
}

function _exitDraftSelectionMode() {
  _activeDraftSelectionId = null;
  _updateDraftWaveformIcons();
  document.querySelectorAll(".draft-card.selecting").forEach((c) => {
    c.classList.remove("selecting");
    const btn = c.querySelector(".extract-select-btn");
    if (btn) btn.textContent = "Select Recordings";
  });
}

/** Check if a filename is staged in a draft */
export function isDraftStagedSelection(filename) {
  if (_activeDraftSelectionId === null) return false;
  const draft = _drafts.get(_activeDraftSelectionId);
  return draft ? draft.stagedRecordings.has(filename) : false;
}

/** Toggle a filename's draft staged state (called from waveform overlay click). */
export function toggleDraftStagedSelection(filename) {
  if (_activeDraftSelectionId === null) return;
  const draft = _drafts.get(_activeDraftSelectionId);
  if (!draft) return;
  if (draft.stagedRecordings.has(filename)) {
    draft.stagedRecordings.delete(filename);
  } else {
    draft.stagedRecordings.add(filename);
  }
  _updateDraftWaveformIcons();
  _updateDraftStagedUI(draft.id);
}

function _updateDraftWaveformIcons() {
  const inMode = _activeDraftSelectionId !== null;
  document.querySelectorAll(".wf-select-overlay").forEach((overlay) => {
    const filename = overlay.closest(".waveform")?.dataset.ix;
    if (inMode) {
      overlay.classList.add("visible");
      overlay.classList.toggle("staged", isDraftStagedSelection(filename));
    } else {
      overlay.classList.remove("visible", "staged");
    }
  });
}

function _updateDraftStagedUI(draftId) {
  const draft = _drafts.get(draftId);
  if (!draft) return;
  const card = document.getElementById(`draft-card-${draftId}`);
  if (!card) return;
  const listEl = card.querySelector(".staged-list");
  const countEl = card.querySelector(".staged-count");
  const postBtn = card.querySelector(".post-to-solid-btn");
  const set = draft.stagedRecordings;
  if (countEl) {
    countEl.textContent = set.size
      ? `${set.size} recording${set.size > 1 ? "s" : ""} selected`
      : "No recordings selected";
  }
  if (listEl) {
    listEl.innerHTML = "";
    for (const fn of set) {
      const li = document.createElement("li");
      li.textContent = fn.substring(fn.lastIndexOf("/") + 1);
      li.title = fn;
      listEl.appendChild(li);
    }
  }
  if (postBtn) {
    const hasAbsUri = set.size > 0 && _allHaveAbsoluteUri(set);
    postBtn.disabled =
      set.size === 0 || draft.regions.length === 0 || !hasAbsUri;
    postBtn.title = set.size > 0 && !hasAbsUri ? _URI_MISSING_TOOLTIP : "";
  }
}

function _updateDraftRegionList(draftId) {
  const draft = _drafts.get(draftId);
  if (!draft) return;
  const card = document.getElementById(`draft-card-${draftId}`);
  if (!card) return;
  const listEl = card.querySelector(".draft-region-list");
  if (!listEl) return;
  listEl.innerHTML = "";
  // Use the reference waveform for display times
  const refKey = getReferenceAudioIx() || getAlignmentKeys()[0];
  draft.regions.forEach((r, ix) => {
    const startT = getCorrespondingTime(refKey, r.from);
    const endT = getCorrespondingTime(refKey, r.to);
    const li = document.createElement("li");
    li.innerHTML = `<span class="draft-region-times">${_fmtTime(startT)} \u2013 ${_fmtTime(endT)}</span>`;
    const delBtn = document.createElement("button");
    delBtn.className = "draft-region-delete";
    delBtn.innerHTML = "\u2715";
    delBtn.title = "Remove region";
    delBtn.addEventListener("click", () => {
      draft.regions.splice(ix, 1);
      _updateDraftRegionCount(draftId);
      _updateDraftRegionList(draftId);
      updateRenderAnnoRegions();
      // Update post button state
      const postBtn = card.querySelector(".post-to-solid-btn");
      if (postBtn) {
        const hasAbsUri =
          draft.stagedRecordings.size > 0 &&
          _allHaveAbsoluteUri(draft.stagedRecordings);
        postBtn.disabled =
          draft.stagedRecordings.size === 0 ||
          draft.regions.length === 0 ||
          !hasAbsUri;
        postBtn.title =
          draft.stagedRecordings.size > 0 && !hasAbsUri
            ? _URI_MISSING_TOOLTIP
            : "";
      }
    });
    li.appendChild(delBtn);
    listEl.appendChild(li);
  });
  _updateDraftRegionCount(draftId);
}

function _fmtTime(secs) {
  if (secs == null || isNaN(secs)) return "?";
  const m = Math.floor(secs / 60);
  const s = (secs % 60).toFixed(1);
  return `${m}:${s.padStart(4, "0")}`;
}

// --- Draw mode ---

// Cleanup functions returned by enableDragSelection (one per RegionsPlugin)
let _dragSelectionCleanups = [];

function _enterDrawMode(draftId) {
  // Exit any other draw mode
  if (_activeDraftId !== null && _activeDraftId !== draftId) {
    _exitDrawMode();
  }
  _activeDraftId = draftId;
  // Suppress correction overlay so pointer events reach WaveSurfer wrapper
  setDrawModeActive(true);
  // Enable region creation on all loaded waveforms
  _dragSelectionCleanups = [];
  Object.values(_regionsPlugins).forEach((rp) => {
    const cleanup = rp.enableDragSelection({
      color: _drafts.get(draftId).color.bg,
    });
    if (typeof cleanup === "function") {
      _dragSelectionCleanups.push(cleanup);
    }
  });
}

function _exitDrawMode() {
  _activeDraftId = null;
  // Restore correction overlay pointer-events
  setDrawModeActive(false);
  // Call all cleanup functions to disable drag selection
  _dragSelectionCleanups.forEach((fn) => {
    try {
      fn();
    } catch (e) {
      /* ignore */
    }
  });
  _dragSelectionCleanups = [];
}

function _discardDraft(draftId) {
  const draft = _drafts.get(draftId);
  if (!draft) return;
  if (_activeDraftId === draftId) _exitDrawMode();
  if (_activeDraftSelectionId === draftId) _exitDraftSelectionMode();
  _drafts.delete(draftId);
  const card = document.getElementById(`draft-card-${draftId}`);
  if (card) card.remove();
  updateRenderAnnoRegions();
}

// --- Post to Solid ---

async function _postDraftToSolid(draftId) {
  const draft = _drafts.get(draftId);
  if (!draft || draft.posted) return;
  if (draft.regions.length === 0 || draft.stagedRecordings.size === 0) return;

  const card = document.getElementById(`draft-card-${draftId}`);
  const postBtn = card?.querySelector(".post-to-solid-btn");
  if (postBtn) {
    postBtn.disabled = true;
    postBtn.textContent = "Posting\u2026";
  }

  try {
    const label = draft.label || "Untitled Annotation";

    // 1. Establish containers
    await establishContainers();

    // 2. Build items: one per selected recording, each with all regions as fragments
    const items = [];
    for (const filename of draft.stagedRecordings) {
      const audioBaseUri = getAudioLinkedDataUri(filename);
      const fragments = draft.regions.map((r) => {
        let start, end;
        if (r.localOverrides && r.localOverrides[filename]) {
          start = r.localOverrides[filename].start;
          end = r.localOverrides[filename].end;
        } else {
          start = getCorrespondingTime(filename, r.from);
          end = getCorrespondingTime(filename, r.to);
        }
        return `${audioBaseUri}#t=${start},${end}`;
      });
      const peaksData = draft.includePeaks ? getWaveformPeaks(filename) : null;
      items.push({
        currentFileUri: audioBaseUri,
        selectedElements: fragments,
        peaksData,
      });
    }

    // 3. Establish discovery resources for each unique aboutUri
    const uniqueFileUris = [...new Set(items.map((i) => i.currentFileUri))];
    const discoveryMap = {};
    for (const fileUri of uniqueFileUris) {
      discoveryMap[fileUri] = await establishDiscoveryResource(fileUri);
    }

    // Collect all aboutUris and discoveryUris for the Extract/MusMat
    const allAboutUris = uniqueFileUris;
    const allDiscoveryUris = uniqueFileUris.map((u) => discoveryMap[u].url);

    // 4. POST all Selections in parallel (one per recording)
    const selectionResponses = await Promise.all(
      items.map((item) =>
        createMAOSelection(
          item.selectedElements,
          item.currentFileUri,
          discoveryMap[item.currentFileUri].url,
          label,
          item.peaksData,
        ),
      ),
    );

    // 5. Create Extract with all Selections as embodiments
    const extractResponse = await createMAOExtract(
      selectionResponses,
      allAboutUris,
      allDiscoveryUris,
      label,
    );

    // 6. Create MusicalMaterial
    const musMatResponse = await createMAOMusicalMaterial(
      extractResponse,
      allAboutUris,
      allDiscoveryUris,
      label,
    );

    // 7. Patch all discovery resources with the new MAO objects
    const musMatUri = resolveLocation(musMatResponse);
    const extractUri = resolveLocation(extractResponse);
    for (const [fileUri, discRes] of Object.entries(discoveryMap)) {
      const selUris = selectionResponses
        .filter((_, i) => items[i].currentFileUri === fileUri)
        .map((r) => resolveLocation(r));
      const ops = [
        {
          op: "add",
          path: `/${nsp.SCHEMA.replaceAll("~", "~0").replaceAll("/", "~1")}dataset/-`,
          value: {
            "@type": `${nsp.SCHEMA}Dataset`,
            [`${nsp.SCHEMA}additionalType`]: {
              "@id": `${nsp.MAO}MusicalMaterial`,
            },
            [`${nsp.SCHEMA}url`]: { "@id": musMatUri },
          },
        },
        {
          op: "add",
          path: `/${nsp.SCHEMA.replaceAll("~", "~0").replaceAll("/", "~1")}dataset/-`,
          value: {
            "@type": `${nsp.SCHEMA}Dataset`,
            [`${nsp.SCHEMA}additionalType`]: { "@id": `${nsp.MAO}Extract` },
            [`${nsp.SCHEMA}url`]: { "@id": extractUri },
          },
        },
        ...selUris.map((sUri) => ({
          op: "add",
          path: `/${nsp.SCHEMA.replaceAll("~", "~0").replaceAll("/", "~1")}dataset/-`,
          value: {
            "@type": `${nsp.SCHEMA}Dataset`,
            [`${nsp.SCHEMA}additionalType`]: { "@id": `${nsp.MAO}Selection` },
            [`${nsp.SCHEMA}url`]: { "@id": sUri },
          },
        })),
      ];
      await safelyPatchResource(discRes.url, ops).catch(() =>
        console.warn("Couldn't patch discovery resource:", discRes.url),
      );
    }

    // --- Convert draft card into a live annotation card ---
    draft.posted = true;
    if (_activeDraftId === draftId) _exitDrawMode();
    if (_activeDraftSelectionId === draftId) _exitDraftSelectionMode();

    // 1. Register each Selection in maoSelections and push regions into
    //    currentlyAnnotatedRegions so that waveform rendering picks them up.
    selectionResponses.forEach((selRes, idx) => {
      const selUri = resolveLocation(selRes);
      const item = items[idx];
      // Build a maoSelections entry matching the shape markSelection expects
      const selObj = {
        "@type": [nsp.MAO + "Selection", nsp.SCHEMA + "Dataset"],
        [nsp.FRBR + "part"]: item.selectedElements.map((f) => ({ "@id": f })),
        [nsp.SCHEMA + "about"]: [{ "@id": item.currentFileUri }],
      };
      maoSelections[selUri] = selObj;

      // One currentlyAnnotatedRegions entry per draft region, each pointing
      // to this selection URI so play / rendering logic works.
      draft.regions.forEach((r) => {
        const entry = {
          selection: selUri,
          from: r.from,
          to: r.to,
        };
        if (r.localOverrides) entry.localOverrides = r.localOverrides;
        currentlyAnnotatedRegions.push(entry);
      });
    });

    // 2. Build the extract object that drawExtractUIElement expects
    const extractObj = {
      "@id": extractUri,
      [nsp.FRBR + "embodiment"]: selectionResponses.map((r) => ({
        "@id": resolveLocation(r),
      })),
      [nsp.RDFS + "label"]: [{ "@value": label }],
      [nsp.SCHEMA + "about"]: allAboutUris.map((u) => ({ "@id": u })),
    };

    // 3. Register the MusicalMaterial → Extract mapping
    _extractToMusMat.set(extractUri, musMatUri);

    // 4. Remove the draft card and draw the live one
    _discardDraft(draftId);
    drawExtractUIElement(extractObj);

    // 5. Re-render waveform regions
    updateRenderAnnoRegions();
  } catch (e) {
    console.error("Error posting draft to Solid:", e);
    if (postBtn) {
      postBtn.textContent = "Error \u2014 retry?";
      postBtn.disabled = false;
    }
  }
}
