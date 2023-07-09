  import { 
    nsp,
    traverseAndFetch
  } from './linked-data.js'  
  import { 
    currentlyActiveMaoSelection,
    maoSelections,
    meiUri, 
    markScoreRegion
 } from './listen.js';

 // Wrapper around traverseAndFetch that reports back errors / progress to 'Load linked data' UI
export function attemptFetchExternalResource(url, targetTypes, configObj) { 
    console.log('fetch external resource: ', url, targetTypes, configObj);
    // spin the icon to indicate loading activity
    traverseAndFetch(url, targetTypes, configObj)
      .catch((resp) => {
        console.warn("Couldn't traverseAndFetch: ", resp)
        })
}

export function registerExtract(obj, url) { 
    if(nsp.SCHEMA+"about") { 
        let matching = obj[nsp.SCHEMA+"about"].filter(m => m["@id"] === decodeURI(meiUri))
        if(matching.length){
            console.log("Found matching extract resource: ", obj);
            obj["@id"] = url;
            drawExtractUIElement(obj);
        }
    }
}

function drawExtractUIElement(obj) {
    if(document.getElementById(obj["@id"])) { 
        return; // skip extracts we have already drawn
    }
    let extractsPanel = document.getElementById("maoExtracts");
    let extract = document.createElement("div");
    extract.setAttribute("id", obj["@id"])
    extract.classList.add("maoExtract");
    let label = document.createElement("div");
    label.innerText = "[no label]"
    try { 
        label.innerText = obj[nsp.RDFS+"label"][0]["@value"];
        extract.setAttribute("title", obj[nsp.RDFS+"label"][0]["@value"]);
    } catch { 
        console.warn("Extract without label: ", obj);
    }
    label.classList.add("maoExtract-label");
    let addSelections = document.createElement("div");
    addSelections.innerText = "+";
    addSelections.setAttribute("title", "Add currently loaded audio regions to extract as selections");
    extract.insertAdjacentElement("afterbegin", addSelections);
    extract.insertAdjacentElement("afterbegin", label);
    if(nsp.FRBR+"embodiment" in obj) { 
        extract.dataset.selection = obj[nsp.FRBR+"embodiment"];
        extract.addEventListener("click", (e) => { 
            document.querySelectorAll("maoExtract").forEach(el => el.classList.remove("active"));
            extract.classList.add("active");
            setActiveSelection(obj[nsp.FRBR+"embodiment"]);
        })
    }
    extractsPanel.insertAdjacentElement("beforeend", extract);
}

function setActiveSelection(selections) { 
    // use first selection corresponding to current MEI
    let matchingSelectionUrls = selections.filter(s => { 
        let selObj = maoSelections[s["@id"]];
        if(selObj && nsp.SCHEMA+"about" in selObj) {
            let meiMatches = selObj[nsp.SCHEMA+"about"].filter(t => t["@id"] === decodeURI(meiUri) )
            return meiMatches.length;
        } else { 
            return false;
        }
    });
    if(matchingSelectionUrls.length) { 
        let url = matchingSelectionUrls[0]["@id"];
        if(url in maoSelections) { 
            let obj = maoSelections[url];
            let selectedElementIds = obj[nsp.FRBR + "part"].map(uri => uri["@id"].substr(uri["@id"].lastIndexOf("#")+1));
            if(selectedElementIds.length) { 
                // mark from first to last element
                markScoreRegion(selectedElementIds[0], selectedElementIds[selectedElementIds.length-1]);
            }
            currentlyActiveMaoSelection = url;
        } else { 
            console.warn("setActiveSelection: Attempting to switch to unknown selection ", url);
        }
    } else { 
        console.warn("setActiveSelection supplied without any selections matching the current meiUrl:", selections);
    }
}

export function markSelection(obj, url) { 
    if(url in maoSelections) { 
        return; // skip processing of selections we arleady know about
    }
    console.log("markSelection called: ", obj)
    if(obj && "@type" in obj && obj["@type"].includes(nsp.MAO + "Selection")) {
        console.log("markSelection found mao:Selection type");
        if(nsp.SCHEMA + "about" in obj) {
            console.log("mao:Selection is about: ", obj[nsp.SCHEMA+"about"]);
            console.log("current meiUri: ", meiUri);
            // HACK DH 2023 -- decodeURI on next line only because alignment process is stupidly encoding it twice!!! Fix.
            let selectionResource = obj[nsp.SCHEMA + "about"].filter(f => f["@id"] === decodeURI(meiUri));
            if(selectionResource.length) {
                console.log("mao:Selection has selection resources: ", selectionResource)
                // selection is about our current score!
                if(nsp.FRBR + "part" in obj) { 
                    console.log("mao:Selection has parts: ", obj[nsp.FRBR + "part"])
                    maoSelections[url] = obj;
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
                    console.warn("Selection without parts: ", obj)
                }
            }
        }
    } else { 
        console.warn("markSelection called on non-selection object:", obj)
    }
}