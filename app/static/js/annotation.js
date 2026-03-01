import { nsp, traverseAndFetch } from "./linked-data.js";
import {
  currentAudioIx,
  currentlyAnnotatedRegions,
  getCorrespondingTime,
  maoSelections,
  meiUri,
  markScoreRegion,
  updateRenderAnnoRegions,
  wavesurfers,
  _regionsPlugins,
} from "./listen.js";
import { addNewMAOSelectionToExtract } from "./solid.js";

const dummyUriPrefix =
  "https://repo.mdw.ac.at/signature-sound-vienna/media/wav/"; // HACK cheat for DH2023

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

  // We attach loop play logic
  let loopInterval = null;
  playBtn.addEventListener("click", () => {
    // If we're already playing this loop, stop it
    if (playBtn.classList.contains("playing")) {
      playBtn.classList.remove("playing");
      playBtn.innerHTML = "\u25B6 Play";

      const audioToStop = currentAudioIx || Object.keys(wavesurfers)[0];
      if (audioToStop && wavesurfers[audioToStop]) {
        wavesurfers[audioToStop].pause();
      }
      if (loopInterval) clearInterval(loopInterval);
      return;
    }

    // Reset all other playing buttons
    document
      .querySelectorAll(".maoExtract button.playing")
      .forEach((btn) => btn.click());

    // Mark as playing
    playBtn.classList.add("playing");
    playBtn.innerHTML = "\u25A0 Stop";

    // Figure out which waveform to play on
    const targetAudio = currentAudioIx || Object.keys(wavesurfers)[0];
    if (!targetAudio || !wavesurfers[targetAudio]) {
      console.warn("No waveform available to play annotation");
      return;
    }

    // Find the corresponding region in currentlyAnnotatedRegions
    let mySelections = obj[nsp.FRBR + "embodiment"].map((e) => e["@id"]);
    let regionIx = currentlyAnnotatedRegions.findIndex((r) =>
      mySelections.includes(r.selection),
    );

    if (regionIx >= 0) {
      const regionId = "anno_region_" + regionIx;
      const regPlugin = _regionsPlugins[targetAudio];
      const region =
        regPlugin && regPlugin.getRegions().find((r) => r.id === regionId);

      if (region) {
        region.play();

        // Setup loop monitor
        if (loopInterval) clearInterval(loopInterval);
        const ws = wavesurfers[targetAudio];
        loopInterval = setInterval(() => {
          if (!playBtn.classList.contains("playing")) {
            clearInterval(loopInterval);
            return;
          }
          if (ws.getCurrentTime() >= region.end) {
            region.play(); // Seek back to start and continue
          }
        }, 50);

        // Cleanup interval if user pauses manually via main play/pause
        ws.once("pause", () => {
          if (playBtn.classList.contains("playing")) {
            playBtn.click(); // trigger our toggle to turn it off cleanly
          }
        });
      } else {
        console.warn("Region not found on waveform: ", regionId);
        playBtn.click(); // turn off
      }
    }
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
      for (const filename of set) {
        // Compute region bounds
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
        await addNewMAOSelectionToExtract(
          filename,
          audioMediaUri,
          extractId,
          labelText,
        );
      }
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
