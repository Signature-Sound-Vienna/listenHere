//import {
//  log,
//  meiFileName,
//  fileLocationType,
//  github, // instance
//  meiFileLocation,
//  storage,
//  version
//} from './main.js';

import { attemptFetchExternalResource, markSelection, registerExtract } from './annotation.js';
import { 
  nsp, politeness
} from './linked-data.js';

import { 
  storage,
  versionString
} from './listen.js';


export const solid = solidClientAuthentication.default;

// mei-friend resource containers (internal path within Solid storage)
export const friendContainer = "at.ac.mdw.mei-friend/";
export const annotationContainer = friendContainer + "oa/";
export const musicalObjectContainer = friendContainer + "mao/";
export const selectionContainer = musicalObjectContainer + "selection/";
export const extractContainer = musicalObjectContainer + "extract/";
export const musicalMaterialContainer = musicalObjectContainer + "musicalMaterial/";
export const discoveryFragment = "discovery/";

// resource templates
export const resources = {
  ldpContainer:  { 
    "@type": [nsp.LDP+"Container", nsp.LDP+"BasicContainer"]
  },
  maoExtract:{ 
    "@type": [nsp.MAO + "Extract"]
  },
  maoSelection:{ 
    "@type": [nsp.MAO + "Selection"]
  },
  maoMusicalMaterial: { 
    "@type": [nsp.MAO + "MusicalMaterial"]
  }

}

export async function postResource(containerUri, resource) { 
  console.log("Call to postResource", containerUri, resource);
  resource["@id"] = ""; // document base URI
  const webId = solid.getDefaultSession().info.webId;
  resource[nsp.DCT + "creator"] = { "@id": webId};
  resource[nsp.DCT + "created"] = new Date(Date.now()).toISOString();
  resource[nsp.DCT + "provenance"] = `Generated using Listen Here v.${versionString}: https://iwk.mdw.ac.at/signature-sound-vienna`;
  return establishContainerResource(containerUri).then((containerUriResource) => {
    return solid.fetch(containerUriResource, {
      method: 'POST',
      headers: { 
        "Content-Type": 'application/ld+json'
      },
      body: JSON.stringify(resource)
    }).then(async postResp => {
      console.log("GOT POST RESPONSE:", postResp);
      return postResp;
    }).catch(e => { 
      console.error("Couldn't post resource to container: ", e, containerUriResource, resource)
    })
  }).catch(e => {
    console.error("Couldn't establish container: ", e, containerUri)
  })
}

/**
 * Safely append to the specified resource:
 * 1. Get fresh copy of resource from URI, noting its etag
 * 2. Apply patch to the obtained resource copy
 * 3. Conditionally PUT specifying if-match on the etag
 *  - if it matches, do PUT
 *  - if it doesn't match, GO TO 1
 * n.b. in the glorious future, this should be done using HTTP PATCH.
 * but while the implementation of this in Solid is still under discussion, 
 * we do this instead.
 */
export async function safelyPatchResource(uri, patch) {
  let etag;
  solid.fetch(uri, {
    headers: { 
      Accept: 'application/ld+json'
    }
  }).then(resp => {
    etag = resp.headers.get("ETag");
    return resp.json();
  }).then(freshlyFetched => {
    console.log("Found freshlyFetched resource at URI: ", freshlyFetched, uri, patch);
    const patched = jsonpatch.applyPatch(freshlyFetched, patch).newDocument;
    solid.fetch(uri, { 
      method: 'PUT',   
      headers: { 
        "Content-Type": 'application/ld+json',
        "If-Match": etag, 
      },
      body: JSON.stringify(patched)
    }).then(putResp => { 
      if(putResp.status === 412) { 
        console.info("Precondition failed: resource has changed while we were trying to patch it. Retrying...");
        setTimeout(safelyPatchResource(uri, patch), politeness)
      } else if(putResp.status >= 400) {
        throw Error(putResp)
      } else { 
        console.log("Patched successfully: ", uri);
      }
    }).catch(e => {
      console.warn("Failed to apply patch to resource: ", uri, patch, e)
    })
  })
}

export async function establishResource(uri, resource) { 
  resource["@id"] = uri;
  // check whether a resource exists at uri
  // if not, create one initialised to the supplied resource
  let resp = await solid.fetch(uri, { 
    method: 'HEAD',
    headers: { 
      Accept: 'application/ld+json'
    }
   }).then(async headResp=> { 
    console.log("GOT HEAD RESPONSE:", headResp)
    if(headResp.ok) { 
      return headResp;
    } else if(headResp.status === 404) {
      // resource doesn't yet exist - let's try to create it
      let putResp = await solid.fetch(uri, { 
        method: 'PUT',   
        headers: {
        'Content-Type': 'application/ld+json',
        },
        body: JSON.stringify(resource)
      }).catch(e => { 
        log("Sorry, network error while trying to initialize resource at ", uri, e);
      });
      return putResp;
    } else if(headResp.status === 403) { 
      // user needs to authorize mei-friend application to access their Pod
      log("Unauthorized - please provide mei-friend application access to your Solid Pod: " + headResp.status + " " + headResp.statusText);
      return headResp;
    } else { 
      // another problem...
      log("Sorry, unable to establish resource in your Solid Pod: " + headResp.status + " " + headResp.statusText)
    }
  });
  return resp;
}

export async function getSolidStorage() { 
  return getProfile().then(async (profile) => { 
    if(nsp.PIM + 'storage' in profile) { 
      let storage = Array.isArray(profile[nsp.PIM + 'storage'])
        ? profile[nsp.PIM + 'storage'][0] // TODO what if more than one storage?
        : profile[nsp.PIM + 'storage'];
      if (typeof storage === 'object') {
        if ('@id' in storage) {
          storage = storage['@id'];
        } else {
          console.warn('Unexpected pim:storage object in your Solid Pod profile: ', profile);
        }
      }
      return storage;
    } else {
      log("Sorry, couldn't establish storage location from your Solid Pod's profile ", profile);
      throw Error(profile);
    }
  })
}

export async function establishContainerResource(container){ 
  return getSolidStorage().then(async (storage) => {
    // establish container resource
    let resource = structuredClone(resources.ldpContainer);
    console.log("attempting to establish resource: ", storage + container, resource)
    return establishResource(storage + container, resource).then(async (resp) => {
      if(resp) {
        if(resp.ok) {
          console.log("Response OK:", resp, storage, container);
          return storage + container;
        } else { 
          console.warn("Response not OK:", resp, storage, container);
          return null;
        }  
      }
    })
    .catch(() => console.error("Couldn't establish resource:", storage + container, resource));
  });
}

export async function establishDiscoveryResource(currentFileUri) {
  return establishContainerResource(friendContainer + discoveryFragment).then((discoveryContainer) => {
    // establish a discovery resource (if it doesn't already exist)
    const currentFileUriHash = encodeURIComponent(currentFileUri);
    const discoveryUri = discoveryContainer + currentFileUriHash;
    return establishResource(discoveryUri, {
      '@type': nsp.SCHEMA + 'DataCatalog',
      [nsp.SCHEMA + 'description']: 'Collection of datasets about ' + currentFileUri,
      [nsp.SCHEMA + 'about']: { '@id': currentFileUri },
      [nsp.SCHEMA + 'dataset']: [],
    });
  });
}

/*export async function createMAOMusicalObject(selectedElements, label = "") {
  // Function to build a Musical Object according to the Music Annotation Ontology:
  // https://dl.acm.org/doi/10.1145/3543882.3543891
  // For the purposes of mei-friend, we want to build a composite structure encompassing MusicalMaterial, 
  // Extract, and Selection (see paper)
  return establishContainerResource(friendContainer).then(async () => { 
    return establishContainerResource(musicalObjectContainer).then(async (musicalObjectContainer) => { 
      return createMAOSelection(selectedElements, label).then(async selectionResource => { 
        return createMAOExtract(selectionResource, label).then(async extractResource => { 
          return createMAOMusicalMaterial(extractResource, label)
        })
      })
    })
  })
  .catch(e => { console.error("Failed to create nsp.MAO Musical Object:", e) })
}*/

export async function createMAOMusicalObject(selectedElements, label = '') {
  // Function to build a Musical Object according to the Music Annotation Ontology:
  // https://dl.acm.org/doi/10.1145/3543882.3543891
  // For the purposes of mei-friend, we want to build a composite structure encompassing MusicalMaterial,
  // Extract, and Selection (see paper)
  let currentFileUri = getCurrentFileUri();
  let currentFileUriHash = encodeURIComponent(currentFileUri);
  let storageResource;
  return establishContainerResource(friendContainer)
    .then(async (stoRes) => {
      storageResource = stoRes;
      return establishDiscoveryResource(currentFileUri);
    })
    .then(async (dataCatalogResource) => {
      return establishContainerResource(musicalObjectContainer).then(async () => {
        return createMAOSelection(selectedElements, currentFileUri, dataCatalogResource.url, label).then(
          async (selectionResource) => {
            return createMAOExtract(selectionResource, currentFileUri, dataCatalogResource.url, label).then(
              async (extractResource) => {
                return createMAOMusicalMaterial(extractResource, currentFileUri, dataCatalogResource.url, label)
                .then(async (musMatResource) => {
                    // patch the now-established discovery resource with our new MAO objects
                    return safelyPatchResource(dataCatalogResource.url, [
                      {
                        op: 'add',
                        // escape ~ and / characters according to JSON POINTER spec
                        // use '-' at end of path specification to indicate new array item to be created
                        path: `/${nsp.SCHEMA.replaceAll('~', '~0').replaceAll('/', '~1')}dataset/-`,
                        value: {
                          '@type': `${nsp.SCHEMA}Dataset`,
                          [`${nsp.SCHEMA}additionalType`]: { '@id': `${nsp.MAO}MusicalMaterial` },
                          [`${nsp.SCHEMA}url`]: {
                            '@id': new URL(storageResource).origin + musMatResource.headers.get('Location'),
                          },
                        },
                      },
                      {
                        op: 'add',
                        // escape ~ and / characters according to JSON POINTER spec
                        // use '-' at end of path specification to indicate new array item to be created
                        path: `/${nsp.SCHEMA.replaceAll('~', '~0').replaceAll('/', '~1')}dataset/-`,
                        value: {
                          '@type': `${nsp.SCHEMA}Dataset`,
                          [`${nsp.SCHEMA}additionalType`]: { '@id': `${nsp.MAO}Extract` },
                          [`${nsp.SCHEMA}url`]: {
                            '@id': new URL(storageResource).origin + extractResource.headers.get('Location'),
                          },
                        },
                      },
                      {
                        op: 'add',
                        // escape ~ and / characters according to JSON POINTER spec
                        // use '-' at end of path specification to indicate new array item to be created
                        path: `/${nsp.SCHEMA.replaceAll('~', '~0').replaceAll('/', '~1')}dataset/-`,
                        value: {
                          '@type': `${nsp.SCHEMA}Dataset`,
                          [`${nsp.SCHEMA}additionalType`]: { '@id': `${nsp.MAO}Selection` },
                          [`${nsp.SCHEMA}url`]: {
                            '@id': new URL(storageResource).origin + selectionResource.headers.get('Location'),
                          },
                        },
                      },
                    ]).then(() => {
                      return musMatResource;
                    }); // finally, return the musMat resource to the UI
                  });
                }
              );
            }
          );
        }
      );
    })
    .catch((e) => {
      console.error('Failed to create nsp.MAO Musical Object:', e);
    });
}


export async function establishContainers() { 
  return establishContainerResource(friendContainer).then(async (storageResource) => { 
    return establishContainerResource(friendContainer + discoveryFragment).then(async () => { 
      return establishContainerResource(musicalObjectContainer).then(() => {
        return storageResource; // return friendContainer URI
      })
    })
  })
}

export async function addNewMAOSelectionToExtract(currentFileUri, selectedElements, extractResource, label = "") {
  let storageResource;
  let dataCatalogResource;
  return establishContainers().then(async (stoRes) => {
      storageResource = stoRes;
      return establishDiscoveryResource(currentFileUri);
    })
  .then(async dataCatRes => { 
    dataCatalogResource = dataCatRes;
    return createMAOSelection(selectedElements, currentFileUri, dataCatalogResource.url, label);
  })
  .then(async(selectionResource) => { 
    // patch the now-established discovery resource
    safelyPatchResource(dataCatalogResource.url, [{
      op: "add",
      // escape ~ and / characters according to JSON POINTER spec
      // use '-' at end of path specification to indicate new array item to be created
      path: `/${nsp.SCHEMA.replaceAll("~", "~0").replaceAll("/", "~1")}dataset/-`,
      value: {
        "@type": `${nsp.SCHEMA}Dataset`,
        [`${nsp.SCHEMA}additionalType`]: { "@id":`${nsp.MAO}Selection` },
        [`${nsp.SCHEMA}url`]: { "@id": new URL(selectionResource.url).origin + selectionResource.headers.get("Location") }
      }
    }]).catch(() => { 
      console.warn("Couldn't pach discovery resource: ", dataCatalogResource.url);
    })
    return selectionResource;
  }).then(async(selectionResource) => { 
    // patch the extract to point to our new selection resource
    console.log("in finally, selection resource:", selectionResource)
    return safelyPatchResource(extractResource, [
      {
        op: "add", 
        // escape ~ and / characters according to JSON POINTER spec
        // use '-' at end of path specification to indicate new array item to be created
        path: `/${nsp.FRBR.replaceAll("~", "~0").replaceAll("/", "~1")}embodiment/-`,
        value: {
          "@id": new URL(selectionResource.url).origin + selectionResource.headers.get("Location") 
        }
      }
    ])
  })
}

async function createMAOSelection(selection, aboutUri, discoveryUri, label = "") {
  // private function -- called *after* friendContainer and musicalObjectContainer already established
  let resource = structuredClone(resources.maoSelection);
  resource[nsp.FRBR + "part"] = [
    {
      "@id": selection
    }
  ];
  if(label) { 
    resource[nsp.RDFS + "label"] = label;
  }
  // resource(s) this MAO object is about
  aboutUri = Array.isArray(aboutUri) ? aboutUri : [aboutUri];
  resource[nsp.SCHEMA + 'about'] = aboutUri.map((uri) => {
    return { '@id': uri };
  });
  // data catalog resource(s) in our discoveryContainer that point to this MAO object
  discoveryUri = Array.isArray(discoveryUri) ? discoveryUri : [discoveryUri];
  resource[nsp.SCHEMA + 'includedInDataCatalog'] = discoveryUri.map((uri) => {
    return { '@id': uri };
  });

  let response = await postResource(selectionContainer, resource);
  console.log("GOT RESPONSE: ", response);
  return response;
}
 
async function createMAOExtract(postSelectionResponse, label = "") {
  console.log("createMAOExtract: ", postSelectionResponse);
  let selectionUri = new URL(postSelectionResponse.url).origin +  
    postSelectionResponse.headers.get("location");
  let resource = structuredClone(resources.maoExtract);
  resource[nsp.FRBR + "embodiment"] = { "@id": selectionUri };
  if(label) { 
    resource[nsp.RDFS + "label"] = label;
  }
  return postResource(extractContainer, resource);
}

async function createMAOMusicalMaterial(postExtractResponse, label = "") {
  console.log("createMAOMusicalMaterial: ", postExtractResponse);
  let extractUri = new URL(postExtractResponse.url).origin + 
    postExtractResponse.headers.get("location");
  let resource = structuredClone(resources.maoMusicalMaterial);
  resource[nsp.MAO + "setting"] = { "@id": extractUri }
  if(label) { 
    resource[nsp.RDFS + "label"] = label;
  }
  return postResource(musicalMaterialContainer, resource);
}

export async function populateSolidTab() { 
  const solidTab = document.getElementById("solidTab");
  if(solid.getDefaultSession().info.isLoggedIn) {
    solidTab.innerHTML = await populateLoggedInSolidTab();
    document.getElementById('solidLogout').addEventListener('click', solidLogout)
    document.getElementById('fetchExternal').addEventListener("click", () => { 
      let urlstr = window.prompt("Please enter URL:");
      if (urlstr) {
        if (!(urlstr.startsWith('http://') || urlstr.startsWith('https://'))) urlstr = 'https://' + urlstr;
        try {
          // ensure working URLs provided
          attemptFetchExternalResource(
            new URL(urlstr), // traversal start
            [new URL(nsp.MAO + 'Selection'), new URL(nsp.MAO + 'Extract')], // target types
            {
              typeToHandlerMap: {
                [nsp.MAO + 'Selection']: {
                  func: markSelection
                },
                [nsp.MAO + 'Extract']: { 
                  func: registerExtract
                }
              },
              followList: [
                new URL(nsp.LDP + 'contains'),
                new URL(nsp.MAO + 'setting'),
                new URL(nsp.FRBR + 'embodiment')
              ], // predicates to traverse
              fetchMethod: solid.getDefaultSession().info.isLoggedIn ? solid.fetch : fetch
            }
          );
        } catch (e) {
          // invalid URL
          console.warn("Could not load external resource:", e);
        }
      }
    })
  } else {
    solidTab.innerHTML = populateLoggedOutSolidTab();
    document.getElementById('solidLogin').addEventListener('click', loginAndFetch)
  }
}

export async function getProfile() { 
  const webId = solid.getDefaultSession().info.webId;
  const profile = await solid.fetch(webId, { 
    headers: { 
      Accept: "application/ld+json"
    }
  })
  .then(resp => resp.json())
  .then(json => jsonld.expand(json))
  .then((profile) => {
    let me = Array.from(profile).filter(e => "@id" in e && e["@id"] === webId);
    if(me.length) {
      if(me.length > 1) { 
        console.warn("User profile contains multiple entries for webId: ", me);
      } 
      return me[0];
    } else { 
      // TODO proper error handling
      console.warn("User profile contains no entry matching their webId: ", profile, webId);
    }
  });
  return profile;
}

async function populateLoggedInSolidTab() { 
  // traverse and fetch from discovery service
  let authStatus = document.createElement("div");
  authStatus.innerHTML = `<a id="solidLogout">Log out</a>`;
  authStatus.id = "authStatus";
  let fetchExternal = document.createElement("div");
  fetchExternal.innerHTML = `Load external data`;
  fetchExternal.id = "fetchExternal";
  let populated = document.createElement("div");
  populated.insertAdjacentElement('afterbegin', authStatus);
  populated.insertAdjacentElement('afterbegin', fetchExternal);
  return populated.outerHTML;
}

function populateLoggedOutSolidTab() {
  let providerContainer = document.createElement("div");
  let provider = document.createElement("select");
  provider.setAttribute("name", "provider");
  provider.setAttribute("id", "providerSelect");
  provider.innerHTML = `
    <option value="https://solidcommunity.net">SolidCommunity.net</option>
    <option value="https://login.inrupt.net">Inrupt</option>
    <option value="https://trompa-solid.upf.edu">TROMPA @ UPF</option>
  `
  providerContainer.insertAdjacentElement("afterbegin", provider);
  let msg = document.createElement("div");
  msg.innerHTML = '<div id="authStatus">Please <a id="solidLogin">Click here to log in!</a></div>';
  msg.insertAdjacentElement("afterbegin", providerContainer);
  return msg.outerHTML
}

export async function loginAndFetch() {
  // 1. Call `handleIncomingRedirect()` to complete the authentication process.
  //    If called after the user has logged in with the Solid Identity Provider, 
  //      the user's credentials are stored in-memory, and
  //      the login process is complete. 
  //   Otherwise, no-op.  
  await solid.handleIncomingRedirect({ restorePreviousSession: true });

  // 2. Start the Login Process if not already logged in.
  if (!solid.getDefaultSession().info.isLoggedIn) {
    storage.restoreSolidSession = true;
    if(alignmentData) { 
      storage.setItem("alignmentData", alignmentData);
    } else { 
      alignmentData = storage.getItem("alignmentData");
    }
    if(workId) { 
      storage.setItem("workId", workId);
    } else { 
      workId = storage.getItem("workId");
    }
    let providerEl = document.getElementById("providerSelect");
    if(providerEl) { 
      let provider = providerEl.value;
      await solid.login({
        // Specify the URL of the user's Solid Identity Provider;
        // e.g., "https://login.inrupt.com".
        oidcIssuer: "https://solidcommunity.net",
        // Specify the URL the Solid Identity Provider should redirect the user once logged in,
        // e.g., the current page for a single-page app.
        redirectUrl: window.location.href,//"http://localhost:5003/test", // URL("/test", window.location.href).toString(),
        // Provide a name for the application when sending to the Solid Identity Provider
        clientName: "listen-here"
      });
    } else { 
      console.warn("Couldn't handle incoming redirect from Solid: no provider element");
    }
  } else { 
    populateSolidTab();
    /*
    solid.fetch("https://musicog.solidcommunity.net/private/")
        .then(resp => resp.text())
        .then(data => console.log("GOT DATA: ", data))
        */
  }
}
export async function solidLogout() { 
  return solid.logout().then(() => {
    storage.removeItem("restoreSolidSession")
    populateSolidTab();
  });
}
