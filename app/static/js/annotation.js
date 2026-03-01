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
  header.style.display = "flex";
  header.style.justifyContent = "space-between";
  header.style.alignItems = "flex-start";

  let labelText = obj[nsp.RDFS + "label"]
    ? obj[nsp.RDFS + "label"][0]["@value"]
    : "Untitled Annotation";
  let label = document.createElement("div");
  label.className = "maoExtract-label";
  label.innerText = labelText;
  label.title = labelText;

  let dismissBtn = document.createElement("button");
  dismissBtn.innerHTML = "✕";
  dismissBtn.style.background = "none";
  dismissBtn.style.border = "none";
  dismissBtn.style.cursor = "pointer";
  dismissBtn.style.color = "#94a3b8";
  dismissBtn.style.fontSize = "1.2em";
  dismissBtn.style.padding = "0";
  dismissBtn.style.lineHeight = "1";

  dismissBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    unloadAnnotation(obj["@id"]);
  });

  header.appendChild(label);
  header.appendChild(dismissBtn);
  extract.appendChild(header);

  // Playback controls container
  let controls = document.createElement("div");
  controls.className = "extractTools";

  let playBtn = document.createElement("button");
  playBtn.innerHTML = "▶ Play Loop";
  playBtn.style.background = "#e2e8f0";
  playBtn.style.border = "1px solid #cbd5e1";
  playBtn.style.borderRadius = "4px";
  playBtn.style.padding = "0.3em 0.6em";
  playBtn.style.cursor = "pointer";
  playBtn.style.display = "flex";
  playBtn.style.alignItems = "center";
  playBtn.style.gap = "0.4em";

  // We attach loop play logic
  let loopInterval = null;
  playBtn.addEventListener("click", () => {
    // If we're already playing this loop, stop it
    if (playBtn.classList.contains("playing")) {
      playBtn.classList.remove("playing");
      playBtn.innerHTML = "▶ Play Loop";
      playBtn.style.background = "#e2e8f0";
      playBtn.style.color = "initial";

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
    playBtn.innerHTML = "■ Stop Loop";
    playBtn.style.background = "#3b82f6";
    playBtn.style.color = "white";

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

  controls.appendChild(playBtn);
  extract.appendChild(controls);

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
