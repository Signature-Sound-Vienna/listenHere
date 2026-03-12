import { nsp, traverseAndFetch } from "./linked-data.js";
import {
  currentAudioIx,
  currentlyAnnotatedRegions,
  getCorrespondingTime,
  getWaveformPeaks,
  maoSelections,
  meiUri,
  markScoreRegion,
  swapCurrentAudio,
  updateRenderAnnoRegions,
  wavesurfers,
  _regionsPlugins,
} from "./listen.js";
import {
  addMultipleMAOSelectionsToExtract,
  addNewMAOSelectionToExtract,
  postWebAnnotation,
  resolveLocation,
} from "./solid.js";

const dummyUriPrefix =
  "https://repo.mdw.ac.at/signature-sound-vienna/media/wav/"; // HACK cheat for DH2023

const PRIMAL_BASE = "https://primal.mdw.ac.at/?obj=";

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
    postBtn.disabled = set.size === 0;
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

// Wrapper around traverseAndFetch that reports back errors / progress to 'Load linked data' UI
export function attemptFetchExternalResource(url, targetTypes, configObj) {
  console.log("fetch external resource: ", url, targetTypes, configObj);
  // spin the icon to indicate loading activity
  traverseAndFetch(url, targetTypes, configObj).catch((resp) => {
    console.warn("Couldn't traverseAndFetch: ", resp);
  });
}

export function registerExtract(obj, url) {
  if (nsp.SCHEMA + "about") {
    let matching = obj[nsp.SCHEMA + "about"].filter((m) => {
      console.log("Inspecting: ", m["@id"], meiUri, decodeURI(meiUri));
      return meiUriMatches(meiUri, m["@id"]);
    });
    if (matching.length) {
      console.log(
        "Found matching extract resource: ",
        matching[0]["@id"],
        meiUri,
      );
      obj["@id"] = url;
      drawExtractUIElement(obj);
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

  let extract = document.createElement("div");
  extract.id = obj["@id"];
  extract.className = "maoExtract";
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
  peaksCb.checked = false;
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
        const audioMediaUri = `${dummyUriPrefix}${filename}#t=${regionStart},${regionEnd}`;
        const peaksData = peaksCb.checked ? getWaveformPeaks(filename) : null;
        items.push({
          currentFileUri: filename,
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
  // use only selections corresponding to current MEI
  let matchingSelectionUrls = selections.filter((s) => {
    let selObj = maoSelections[s["@id"]];
    if (selObj && nsp.SCHEMA + "about" in selObj) {
      let meiMatches = selObj[nsp.SCHEMA + "about"].filter((t) =>
        meiUriMatches(meiUri, t["@id"]),
      );
      return meiMatches.length;
    } else {
      return false;
    }
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
    return; // skip processing of selections we arleady know about
  }
  console.log("markSelection called: ", obj);
  if (obj && "@type" in obj && obj["@type"].includes(nsp.MAO + "Selection")) {
    console.log("markSelection found mao:Selection type");
    if (nsp.SCHEMA + "about" in obj) {
      console.log("mao:Selection is about: ", obj[nsp.SCHEMA + "about"]);
      console.log("current meiUri: ", meiUri);
      let about = obj[nsp.SCHEMA + "about"];
      if (!Array.isArray(about)) {
        about = [about]; // ensure array
      }
      let selectionResource = about.filter((f) =>
        meiUriMatches(meiUri, f["@id"]),
      );
      if (selectionResource.length) {
        console.log(
          "mao:Selection has selection resources: ",
          selectionResource,
        );
        // selection is about our current score!
        if (nsp.FRBR + "part" in obj) {
          console.log("mao:Selection has parts: ", obj[nsp.FRBR + "part"]);
          maoSelections[url] = obj;
          markScoreRegions([{ "@id": url }]);
          //setActiveSelection(url);
          /*
                    let selectedElementIds = obj[nsp.FRBR + "part"].map(uri => uri["@id"].substr(uri["@id"].lastIndexOf("#")+1));
                    if(selectedElementIds.length) { 
                        // mark from first to last element
                        markScoreRegion(selectedElementIds[0], selectedElementIds[selectedElementIds.length-1]);
                    } else {
                        console.warn("Selection with unexpected parts: ", obj);
                    }
                    */
        } else {
          console.warn("Selection without parts: ", obj);
        }
      }
    }
  } else {
    console.warn("markSelection called on non-selection object:", obj);
  }
}
