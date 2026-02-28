import { nsp, traverseAndFetch } from "./linked-data.js";
import {
  currentAudioIx,
  currentlyAnnotatedRegions,
  getCorrespondingTime,
  maoSelections,
  meiUri,
  markScoreRegion,
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

function drawExtractUIElement(obj) {
  if (document.getElementById(obj["@id"])) {
    return; // skip extracts we have already drawn
  }
  let extractsPanel = document.getElementById("maoExtracts");
  let extract = document.createElement("div");
  extract.setAttribute("id", obj["@id"]);
  extract.classList.add("maoExtract");
  let label = document.createElement("div");
  label.innerText = "[no label]";
  try {
    label.innerText = obj[nsp.RDFS + "label"][0]["@value"];
    extract.setAttribute("title", obj[nsp.RDFS + "label"][0]["@value"]);
  } catch {
    console.warn("Extract without label: ", obj);
  }
  label.classList.add("maoExtract-label");
  let extractTools = document.createElement("div");
  extractTools.classList.add("extractTools");
  let addSelections = document.createElement("div");
  addSelections.innerText = "+";
  addSelections.setAttribute(
    "title",
    "Add currently loaded audio regions to extract as selections",
  );
  addSelections.classList.add("addSelectionsToExtractButton");
  let closeExtract = document.createElement("div");
  closeExtract.innerText = "x";
  closeExtract.classList.add("closeExtractButton");
  closeExtract.setAttribute("title", "Remove this extract from current view");
  closeExtract.addEventListener("click", () => {
    extract.remove();
  });
  extractTools.insertAdjacentElement("afterbegin", closeExtract);
  extractTools.insertAdjacentElement("afterbegin", addSelections);
  extract.insertAdjacentElement("afterbegin", extractTools);
  extract.insertAdjacentElement("afterbegin", label);
  if (nsp.FRBR + "embodiment" in obj) {
    extract.dataset.extractUri = obj["@id"];
    extract.addEventListener("click", () => {
      document
        .querySelectorAll("maoExtract")
        .forEach((el) => el.classList.remove("active"));
      extract.classList.add("active");
      if (nsp.FRBR + "embodiment" in obj) {
        let mySelections = obj[nsp.FRBR + "embodiment"].map((e) => e["@id"]);
        let regionIx = currentlyAnnotatedRegions.findIndex((r) =>
          mySelections.includes(r.selection),
        );
        if (regionIx >= 0) {
          if (currentAudioIx) {
            const regionId = "anno_region_" + regionIx;
            const regPlugin = _regionsPlugins[currentAudioIx];
            const region =
              regPlugin &&
              regPlugin.getRegions().find((r) => r.id === regionId);
            if (region) {
              region.play();
              console.log("playing region: ", region);
            } else {
              console.warn("Could not find region to play: ", regionId);
            }
          }
        } else {
          console.log(
            "Couldn't find regionIx for extract: ",
            extract.dataset.selection,
            currentlyAnnotatedRegions,
          );
        }
      } else {
        console.warn("Extract without embodiment: ", obj);
      }
      // look up index of selection URI in currently annotated regions
      //markScoreRegions(obj[nsp.FRBR+"embodiment"]);
    });
    addSelections.addEventListener("click", () => {
      console.log("Attempting to add selection to extract!");
      Object.keys(wavesurfers).forEach((ws) => {
        let region = wavesurfers[ws].regions.list.anno_region_0;
        region.start = getCorrespondingTime(ws, currentlyAnnotatedRegions.from);
        region.end = getCorrespondingTime(ws, currentlyAnnotatedRegions.to);
        let audioMediaUri = `${dummyUriPrefix}${ws}#t=${region.start},${region.end}`;
        addNewMAOSelectionToExtract(
          ws,
          audioMediaUri,
          extract.id,
          obj[nsp.RDFS + "label"][0]["@value"],
        );
      });
    });
  }
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
