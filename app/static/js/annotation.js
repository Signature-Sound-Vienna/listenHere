import {
    solid,
    getSolidStorage,
    friendContainer,
    annotationContainer,
    establishContainerResource,
    establishResource,
    createMAOMusicalObject,
  } from './solid.js';
  import { 
    nsp,
    traverseAndFetch
  } from './linked-data.js'  
  import { meiUri, markScoreRegion } from './listen.js';

 // Wrapper around traverseAndFetch that reports back errors / progress to 'Load linked data' UI
export function attemptFetchExternalResource(url, targetTypes, configObj) { 
    console.log('fetch external resource: ', url, targetTypes, configObj);
    // spin the icon to indicate loading activity
    traverseAndFetch(url, targetTypes, configObj)
      .catch((resp) => {
        console.warn("Couldn't traverseAndFetch: ", resp)
        })
}

export function registerExtract(obj) { 
    console.log("registerExtract called: ", obj);
}

export function markSelection(obj) { 
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
                    let selectedElementIds = obj[nsp.FRBR + "part"].map(uri => uri["@id"].substr(uri["@id"].lastIndexOf("#")+1));
                    if(selectedElementIds.length) { 
                        // mark from first to last element
                        markScoreRegion(selectedElementIds[0], selectedElementIds[selectedElementIds.length-1]);
                    }
                    else {
                        console.warn("Selection with unexpected parts: ", obj);
                    }
                } else { 
                    console.warn("Selection without parts: ", obj)
                }
            }
        }
    } else { 
        console.warn("markSelection called on non-selection object:", obj)
    }
}