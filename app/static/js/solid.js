//import {
//  log,
//  meiFileName,
//  fileLocationType,
//  github, // instance
//  meiFileLocation,
//  storage,
//  version
//} from './main.js';

import {
  attemptFetchExternalResource,
  markSelection,
  registerExtract,
  registerMusicalMaterial,
} from "./annotation.js";
import { nsp, politeness } from "./linked-data.js";

import { storage, versionString } from "./listen.js";
import { ensureRelativeURL } from "./utils.js";

export const solid = solidClientAuthentication.default;

// mei-friend resource containers (internal path within Solid storage)
export const friendContainer = "at.ac.mdw.mei-friend/";
export const annotationContainer = friendContainer + "oa/";
export const musicalObjectContainer = friendContainer + "mao/";
export const selectionContainer = musicalObjectContainer + "selection/";
export const extractContainer = musicalObjectContainer + "extract/";
export const musicalMaterialContainer =
  musicalObjectContainer + "musicalMaterial/";
export const discoveryFragment = "discovery/";

/**
 * Resolve a Location header from a fetch response into an absolute URI.
 * Uses ensureRelativeURL to normalise the Location to a pathname first,
 * then prepends the origin — the same approach used in postResource().
 */
export function resolveLocation(response) {
  const loc = response.headers.get("Location");
  if (!loc) return response.url;
  return new URL(response.url).origin + ensureRelativeURL(loc);
}

// resource templates
export const resources = {
  ldpContainer: {
    "@type": [nsp.LDP + "Container", nsp.LDP + "BasicContainer"],
  },
  maoExtract: {
    "@type": [nsp.MAO + "Extract"],
  },
  maoSelection: {
    "@type": [nsp.MAO + "Selection"],
  },
  maoMusicalMaterial: {
    "@type": [nsp.MAO + "MusicalMaterial"],
  },
};

export async function postResource(containerUri, resource) {
  console.log("Call to postResource", containerUri, resource);
  resource["@id"] = ""; // document base URI
  const webId = solid.getDefaultSession().info.webId;
  resource[nsp.DCT + "creator"] = { "@id": webId };
  resource[nsp.DCT + "created"] = new Date(Date.now()).toISOString();
  resource[nsp.DCT + "provenance"] =
    `Generated using Listen Here v.${versionString}: https://iwk.mdw.ac.at/signature-sound-vienna`;
  return establishContainerResource(containerUri)
    .then((containerUriResource) => {
      return solid
        .fetch(containerUriResource, {
          method: "POST",
          headers: {
            "Content-Type": "application/ld+json",
          },
          body: JSON.stringify(resource),
        })
        .then(async (postResp) => {
          // patch the posted resource with its own URI
          let origin = new URL(containerUriResource).origin;
          let postedResourceUri =
            origin + ensureRelativeURL(postResp.headers.get("Location"));
          await safelyPatchResource(postedResourceUri, [
            {
              op: "replace", // replace the empty @id with the actual URI
              path: "/@id",
              value: postedResourceUri,
            },
          ]);
          return postResp;
        })
        .catch((e) => {
          console.error(
            "Couldn't post resource to container: ",
            e,
            containerUriResource,
            resource,
          );
        });
    })
    .catch((e) => {
      console.error("Couldn't establish container: ", e, containerUri);
    });
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

export async function safelyPatchResource(uri, patch, _retries = 5) {
  const resp = await solid.fetch(uri, {
    headers: {
      Accept: "application/ld+json",
    },
  });
  const etag = resp.headers.get("ETag");
  const freshlyFetched = await resp.json();
  const patched = jsonpatch.applyPatch(freshlyFetched, patch).newDocument;
  const putResp = await solid.fetch(uri, {
    method: "PUT",
    headers: {
      "Content-Type": "application/ld+json",
      ...(etag ? { "If-Match": etag } : {}),
    },
    body: JSON.stringify(patched),
  });
  if (putResp.status === 412) {
    if (_retries <= 0) {
      console.error("safelyPatchResource: max retries exceeded for", uri);
      return putResp;
    }
    console.info(
      "Precondition failed: resource changed while patching. Retrying...",
    );
    await new Promise((r) => setTimeout(r, politeness));
    return safelyPatchResource(uri, patch, _retries - 1);
  } else if (putResp.status >= 400) {
    console.warn("Couldn't PUT patched resource: ", putResp);
  } else {
    console.log("Patched successfully: ", uri);
  }
  return putResp;
}

export async function establishResource(uri, resource) {
  resource["@id"] = uri;
  // check whether a resource exists at uri
  // if not, create one initialised to the supplied resource
  let resp = await solid
    .fetch(uri, {
      method: "HEAD",
      headers: {
        Accept: "application/ld+json",
      },
    })
    .then(async (headResp) => {
      console.log("GOT HEAD RESPONSE:", headResp);
      if (headResp.ok) {
        return headResp;
      } else if (headResp.status === 404) {
        // resource doesn't yet exist - let's try to create it
        let putResp = await solid
          .fetch(uri, {
            method: "PUT",
            headers: {
              "Content-Type": "application/ld+json",
            },
            body: JSON.stringify(resource),
          })
          .catch((e) => {
            log(
              "Sorry, network error while trying to initialize resource at ",
              uri,
              e,
            );
          });
        return putResp;
      } else if (headResp.status === 403) {
        // user needs to authorize mei-friend application to access their Pod
        log(
          "Unauthorized - please provide mei-friend application access to your Solid Pod: " +
            headResp.status +
            " " +
            headResp.statusText,
        );
        return headResp;
      } else {
        // another problem...
        log(
          "Sorry, unable to establish resource in your Solid Pod: " +
            headResp.status +
            " " +
            headResp.statusText,
        );
      }
    });
  return resp;
}

export async function getSolidStorage() {
  return getProfile().then(async (profile) => {
    if (nsp.PIM + "storage" in profile) {
      let storage = Array.isArray(profile[nsp.PIM + "storage"])
        ? profile[nsp.PIM + "storage"][0] // TODO what if more than one storage?
        : profile[nsp.PIM + "storage"];
      if (typeof storage === "object") {
        if ("@id" in storage) {
          storage = storage["@id"];
        } else {
          console.warn(
            "Unexpected pim:storage object in your Solid Pod profile: ",
            profile,
          );
        }
      }
      return storage;
    } else {
      log(
        "Sorry, couldn't establish storage location from your Solid Pod's profile ",
        profile,
      );
      throw Error(profile);
    }
  });
}

export async function establishContainerResource(container) {
  return getSolidStorage().then(async (storage) => {
    // establish container resource
    let resource = structuredClone(resources.ldpContainer);
    console.log(
      "attempting to establish resource: ",
      storage + container,
      resource,
    );
    return establishResource(storage + container, resource)
      .then(async (resp) => {
        if (resp) {
          if (resp.ok) {
            console.log("Response OK:", resp, storage, container);
            return storage + container;
          } else {
            console.warn("Response not OK:", resp, storage, container);
            return null;
          }
        }
      })
      .catch(() =>
        console.error(
          "Couldn't establish resource:",
          storage + container,
          resource,
        ),
      );
  });
}

export async function establishDiscoveryResource(currentFileUri) {
  return establishContainerResource(friendContainer + discoveryFragment).then(
    (discoveryContainer) => {
      // establish a discovery resource (if it doesn't already exist)
      const currentFileUriHash = encodeURIComponent(currentFileUri);
      const discoveryUri = discoveryContainer + currentFileUriHash;
      return establishResource(discoveryUri, {
        "@type": nsp.SCHEMA + "DataCatalog",
        [nsp.SCHEMA + "description"]:
          "Collection of datasets about " + currentFileUri,
        [nsp.SCHEMA + "about"]: { "@id": currentFileUri },
        [nsp.SCHEMA + "dataset"]: [],
      });
    },
  );
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

export async function createMAOMusicalObject(selectedElements, label = "") {
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
      return establishContainerResource(musicalObjectContainer).then(
        async () => {
          return createMAOSelection(
            selectedElements,
            currentFileUri,
            dataCatalogResource.url,
            label,
          ).then(async (selectionResource) => {
            return createMAOExtract(
              selectionResource,
              currentFileUri,
              dataCatalogResource.url,
              label,
            ).then(async (extractResource) => {
              return createMAOMusicalMaterial(
                extractResource,
                currentFileUri,
                dataCatalogResource.url,
                label,
              ).then(async (musMatResource) => {
                // patch the now-established discovery resource with our new MAO objects
                return safelyPatchResource(dataCatalogResource.url, [
                  {
                    op: "add",
                    // escape ~ and / characters according to JSON POINTER spec
                    // use '-' at end of path specification to indicate new array item to be created
                    path: `/${nsp.SCHEMA.replaceAll("~", "~0").replaceAll(
                      "/",
                      "~1",
                    )}dataset/-`,
                    value: {
                      "@type": `${nsp.SCHEMA}Dataset`,
                      [`${nsp.SCHEMA}additionalType`]: {
                        "@id": `${nsp.MAO}MusicalMaterial`,
                      },
                      [`${nsp.SCHEMA}url`]: {
                        "@id": resolveLocation(musMatResource),
                      },
                    },
                  },
                  {
                    op: "add",
                    // escape ~ and / characters according to JSON POINTER spec
                    // use '-' at end of path specification to indicate new array item to be created
                    path: `/${nsp.SCHEMA.replaceAll("~", "~0").replaceAll(
                      "/",
                      "~1",
                    )}dataset/-`,
                    value: {
                      "@type": `${nsp.SCHEMA}Dataset`,
                      [`${nsp.SCHEMA}additionalType`]: {
                        "@id": `${nsp.MAO}Extract`,
                      },
                      [`${nsp.SCHEMA}url`]: {
                        "@id": resolveLocation(extractResource),
                      },
                    },
                  },
                  {
                    op: "add",
                    // escape ~ and / characters according to JSON POINTER spec
                    // use '-' at end of path specification to indicate new array item to be created
                    path: `/${nsp.SCHEMA.replaceAll("~", "~0").replaceAll(
                      "/",
                      "~1",
                    )}dataset/-`,
                    value: {
                      "@type": `${nsp.SCHEMA}Dataset`,
                      [`${nsp.SCHEMA}additionalType`]: {
                        "@id": `${nsp.MAO}Selection`,
                      },
                      [`${nsp.SCHEMA}url`]: {
                        "@id": resolveLocation(selectionResource),
                      },
                    },
                  },
                ]).then(() => {
                  return musMatResource;
                }); // finally, return the musMat resource to the UI
              });
            });
          });
        },
      );
    })
    .catch((e) => {
      console.error("Failed to create nsp.MAO Musical Object:", e);
    });
}

export async function establishContainers() {
  return establishContainerResource(friendContainer).then(
    async (storageResource) => {
      return establishContainerResource(
        friendContainer + discoveryFragment,
      ).then(async () => {
        return establishContainerResource(musicalObjectContainer).then(() => {
          return storageResource; // return friendContainer URI
        });
      });
    },
  );
}

export async function addNewMAOSelectionToExtract(
  currentFileUri,
  selectedElements,
  extractResource,
  label = "",
  peaksData = null,
) {
  return addMultipleMAOSelectionsToExtract(
    [{ currentFileUri, selectedElements, peaksData }],
    extractResource,
    label,
  );
}

/**
 * Post multiple MAO Selections in parallel, then batch-patch the discovery
 * resource and the Extract with all new entries in one round-trip each.
 * @param {Array<{currentFileUri: string, selectedElements: string, peaksData: object|null}>} items
 * @param {string} extractResource — the Extract URI to patch
 * @param {string} label
 * @returns {Promise<void>}
 */
export async function addMultipleMAOSelectionsToExtract(
  items,
  extractResource,
  label = "",
) {
  // 1. Establish containers and discovery resources (deduplicated)
  const storageResource = await establishContainers();
  const uniqueFileUris = [...new Set(items.map((i) => i.currentFileUri))];
  const discoveryMap = {}; // fileUri → { url }
  for (const fileUri of uniqueFileUris) {
    discoveryMap[fileUri] = await establishDiscoveryResource(fileUri);
  }

  // 2. POST all selections in parallel
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

  // 3. Build batch patches per discovery resource
  const discoveryPatches = {}; // discoveryUrl → patch ops[]
  selectionResponses.forEach((selRes, i) => {
    const discUrl = discoveryMap[items[i].currentFileUri].url;
    if (!discoveryPatches[discUrl]) discoveryPatches[discUrl] = [];
    discoveryPatches[discUrl].push({
      op: "add",
      path: `/${nsp.SCHEMA.replaceAll("~", "~0").replaceAll("/", "~1")}dataset/-`,
      value: {
        "@type": `${nsp.SCHEMA}Dataset`,
        [`${nsp.SCHEMA}additionalType`]: { "@id": `${nsp.MAO}Selection` },
        [`${nsp.SCHEMA}url`]: { "@id": resolveLocation(selRes) },
      },
    });
  });

  // 4. Patch each discovery resource (usually just one)
  await Promise.all(
    Object.entries(discoveryPatches).map(([url, ops]) =>
      safelyPatchResource(url, ops).catch(() =>
        console.warn("Couldn't patch discovery resource:", url),
      ),
    ),
  );

  // 5. Batch-patch the Extract with all new embodiment entries at once
  const extractOps = selectionResponses.map((selRes) => ({
    op: "add",
    path: `/${nsp.FRBR.replaceAll("~", "~0").replaceAll("/", "~1")}embodiment/-`,
    value: { "@id": resolveLocation(selRes) },
  }));
  await safelyPatchResource(extractResource, extractOps);
}

async function createMAOSelection(
  selection,
  aboutUri,
  discoveryUri,
  label = "",
  peaksData = null,
) {
  // private function -- called *after* friendContainer and musicalObjectContainer already established
  let resource = structuredClone(resources.maoSelection);
  resource[nsp.FRBR + "part"] = [
    {
      "@id": selection,
    },
  ];
  if (label) {
    resource[nsp.RDFS + "label"] = label;
  }
  // Optionally include pre-computed waveform peak data
  if (peaksData && peaksData.peaks) {
    resource[nsp.SSV + "peaks"] = JSON.stringify({
      peaks: peaksData.peaks,
      duration: peaksData.duration,
    });
  }
  // resource(s) this MAO object is about
  aboutUri = Array.isArray(aboutUri) ? aboutUri : [aboutUri];
  resource[nsp.SCHEMA + "about"] = aboutUri.map((uri) => {
    return { "@id": uri };
  });
  // data catalog resource(s) in our discoveryContainer that point to this MAO object
  discoveryUri = Array.isArray(discoveryUri) ? discoveryUri : [discoveryUri];
  resource[nsp.SCHEMA + "includedInDataCatalog"] = discoveryUri.map((uri) => {
    return { "@id": uri };
  });

  let response = await postResource(selectionContainer, resource);
  console.log("GOT RESPONSE: ", response);
  return response;
}

async function createMAOExtract(postSelectionResponse, label = "") {
  console.log("createMAOExtract: ", postSelectionResponse);
  let selectionUri = resolveLocation(postSelectionResponse);
  let resource = structuredClone(resources.maoExtract);
  resource[nsp.FRBR + "embodiment"] = { "@id": selectionUri };
  if (label) {
    resource[nsp.RDFS + "label"] = label;
  }
  return postResource(extractContainer, resource);
}

async function createMAOMusicalMaterial(postExtractResponse, label = "") {
  console.log("createMAOMusicalMaterial: ", postExtractResponse);
  let extractUri = resolveLocation(postExtractResponse);
  let resource = structuredClone(resources.maoMusicalMaterial);
  resource[nsp.MAO + "setting"] = { "@id": extractUri };
  if (label) {
    resource[nsp.RDFS + "label"] = label;
  }
  return postResource(musicalMaterialContainer, resource);
}

/**
 * Post an OA Web Annotation with a textual body targeting a MusicalMaterial.
 * The annotation is placed in the annotationContainer (friendContainer + "oa/").
 * @param {string} targetUri — the MusicalMaterial URI to annotate
 * @param {string} bodyText  — the textual description
 * @returns {Promise<Response>} — the Solid POST response
 */
export async function postWebAnnotation(targetUri, bodyText) {
  const resource = {
    "@type": [nsp.OA + "Annotation", nsp.SCHEMA + "Dataset"],
    [nsp.OA + "motivatedBy"]: [{ "@id": nsp.OA + "describing" }],
    [nsp.OA + "hasBody"]: [
      {
        "@type": [nsp.OA + "TextualBody"],
        [nsp.RDF + "value"]: bodyText,
      },
    ],
    [nsp.OA + "hasTarget"]: [{ "@id": targetUri }],
  };
  return postResource(annotationContainer, resource);
}

export async function populateSolidDrawer() {
  const solidTab = document.getElementById("solidTab");
  const isLoggedIn = solid.getDefaultSession().info.isLoggedIn;

  if (isLoggedIn) {
    const profile = await getProfile();
    const webId = solid.getDefaultSession().info.webId;
    // JSON-LD expanded: foaf:name → [{"@value": "Name"}]
    const foafName = profile && profile[nsp.FOAF + "name"];
    const extractedName =
      Array.isArray(foafName) && foafName.length > 0
        ? foafName[0]["@value"]
        : typeof foafName === "string"
          ? foafName
          : null;
    // Fall back to the WebID hostname (e.g. "username.solidcommunity.net")
    const name = extractedName || (webId ? new URL(webId).hostname : "Unknown");

    solidTab.innerHTML = `
      <div id="authStatus" style="margin-bottom: 1.5em; color: #1e293b;">
        Logged in as <strong>${name}</strong>
        <div style="margin-top: 0.5em;">
          <a id="solidLogout" style="color: #64748b; font-size: 0.9em; cursor: pointer; text-decoration: underline;">Log out</a>
        </div>
      </div>
      <div class="annotation-loader" style="padding-top: 1.5em; border-top: 1px solid #e2e8f0;">
        <label for="annotationUrlInput" style="display: block; margin-bottom: 0.5em; font-weight: 600; font-size: 0.9em;">Load external annotations (URL)</label>
        <input type="text" id="annotationUrlInput" placeholder="https://" style="width: 100%; padding: 0.6em; margin-bottom: 0.8em; border: 1px solid #cbd5e1; border-radius: 4px; box-sizing: border-box;" />
        <button id="fetchExternalBtn" style="width: 100%; padding: 0.6em; background: #3b82f6; color: white; border: none; border-radius: 4px; cursor: pointer; font-weight: 500;">Load</button>
      </div>
    `;

    document
      .getElementById("solidLogout")
      .addEventListener("click", solidLogout);
  } else {
    const wasCancelled = localStorage.getItem("solidLoginPending") !== null;
    if (wasCancelled) {
      localStorage.removeItem("solidLoginPending");
    }

    const storedProvider = localStorage.getItem("solidProvider");
    const hasStoredSession =
      localStorage.getItem("solidClientAuthn:currentSession") !== null;

    const annotationLoaderHTML = `
      <div class="annotation-loader" style="margin-bottom: 2em; padding-bottom: 2em; border-bottom: 1px solid #e2e8f0;">
        <label for="annotationUrlInput" style="display: block; margin-bottom: 0.5em; font-weight: 600; font-size: 0.9em;">Load public annotations (URL)</label>
        <input type="text" id="annotationUrlInput" placeholder="https://" style="width: 100%; padding: 0.6em; margin-bottom: 0.8em; border: 1px solid #cbd5e1; border-radius: 4px; box-sizing: border-box;" />
        <button id="fetchExternalBtn" style="width: 100%; padding: 0.6em; background: #e2e8f0; color: #1e293b; border: 1px solid #cbd5e1; border-radius: 4px; cursor: pointer; font-weight: 500;">Load</button>
      </div>`;

    if (storedProvider && hasStoredSession && !wasCancelled) {
      // Reconnect UI — user has a previous Solid session
      const providerLabel = storedProvider
        .replace(/^https?:\/\//, "")
        .replace(/\/$/, "");
      solidTab.innerHTML =
        annotationLoaderHTML +
        `<div id="authStatus">
          <p style="font-size: 0.9em; color: #475569; margin-bottom: 1em;">
            Previously connected via <strong>${providerLabel}</strong>
          </p>
          <button id="solidReconnectBtn" style="width: 100%; padding: 0.6em; background: #3b82f6; color: white; border: none; border-radius: 4px; cursor: pointer; font-weight: 500;">Reconnect to Solid</button>
          <div style="text-align: center; margin-top: 0.6em;">
            <a id="solidDifferentBtn" style="color: #64748b; font-size: 0.85em; cursor: pointer; text-decoration: underline;">Use a different account</a>
          </div>
        </div>`;
      document
        .getElementById("solidReconnectBtn")
        .addEventListener("click", () => loginAndFetch(storedProvider));
      document
        .getElementById("solidDifferentBtn")
        .addEventListener("click", () => {
          localStorage.removeItem("solidProvider");
          localStorage.removeItem("solidClientAuthn:currentSession");
          populateSolidDrawer();
        });
    } else {
      // Full login UI
      solidTab.innerHTML =
        annotationLoaderHTML +
        `<div id="authStatus">
          <label for="providerSelect" style="display: block; margin-bottom: 0.5em; font-weight: 600; font-size: 0.9em;">Solid Provider</label>
          <select name="provider" id="providerSelect" style="width: 100%; padding: 0.6em; margin-bottom: 0.5em; border: 1px solid #cbd5e1; border-radius: 4px;">
            <option value="https://solidcommunity.net">SolidCommunity.net</option>
            <option value="https://login.inrupt.com">Inrupt PodSpaces</option>
            <option value="_other">Other…</option>
          </select>
          <div id="customProviderWrap" style="display:none; margin-bottom: 0.5em;">
            <input type="url" id="customProviderInput" placeholder="https://your-provider.example" style="width: 100%; padding: 0.6em; border: 1px solid #cbd5e1; border-radius: 4px; box-sizing: border-box;" />
          </div>
          ${wasCancelled ? '<div style="color: #ef4444; font-size: 0.85em; margin-bottom: 0.8em;">Login cancelled. Try again?</div>' : ""}
          <button id="solidLoginBtn" style="width: 100%; padding: 0.6em; margin-top: 0.5em; background: #3b82f6; color: white; border: none; border-radius: 4px; cursor: pointer; font-weight: 500;">Connect to Solid Pod</button>
        </div>`;
      const providerSelect = document.getElementById("providerSelect");
      const customWrap = document.getElementById("customProviderWrap");
      providerSelect.addEventListener("change", () => {
        customWrap.style.display =
          providerSelect.value === "_other" ? "" : "none";
      });
      document
        .getElementById("solidLoginBtn")
        .addEventListener("click", () => {
          if (providerSelect.value === "_other") {
            const custom = document
              .getElementById("customProviderInput")
              .value.trim();
            if (!custom) return;
            loginAndFetch(
              custom.startsWith("http") ? custom : "https://" + custom,
            );
          } else {
            loginAndFetch();
          }
        });
    }
  }

  // Set up annotation loading regardless of auth state
  document.getElementById("fetchExternalBtn").addEventListener("click", () => {
    let urlstr = document.getElementById("annotationUrlInput").value.trim();
    if (urlstr) {
      if (!(urlstr.startsWith("http://") || urlstr.startsWith("https://"))) {
        urlstr = "https://" + urlstr;
      }
      loadExternalAnnotations(urlstr);
    }
  });
}

export async function getProfile() {
  const webId = solid.getDefaultSession().info.webId;
  const profile = await solid
    .fetch(webId, {
      headers: {
        Accept: "application/ld+json",
      },
    })
    .then((resp) => resp.json())
    .then((json) => jsonld.expand(json))
    .then((profile) => {
      let me = Array.from(profile).filter(
        (e) => "@id" in e && e["@id"] === webId,
      );
      if (me.length) {
        if (me.length > 1) {
          console.warn(
            "User profile contains multiple entries for webId: ",
            me,
          );
        }
        return me[0];
      } else {
        // TODO proper error handling
        console.warn(
          "User profile contains no entry matching their webId: ",
          profile,
          webId,
        );
      }
    });
  return profile;
}

function loadExternalAnnotations(urlstr) {
  const url = new URL(urlstr);
  const isLoggedIn = solid.getDefaultSession().info.isLoggedIn;

  // Smart fetch strategy
  let fetchMethod = fetch; // default to plain public fetch
  const hostname = url.hostname.toLowerCase();

  // Rule 1: Always plain fetch for known public CDNs/repos to prevent credential leakage
  if (hostname === "raw.githubusercontent.com" || hostname === "github.com") {
    fetchMethod = fetch;
  }
  // Rule 2: Use solid.fetch for known Solid pods if logged in
  else if (
    isLoggedIn &&
    (hostname.includes("solidcommunity.net") ||
      hostname.includes("inrupt.net") ||
      hostname.includes("upf.edu"))
  ) {
    fetchMethod = solid.fetch;
  }

  // Ensure we have a wrapper method that falls back securely
  const smartFetch = async (reqUrl, options) => {
    let res = await fetchMethod(reqUrl, options);
    // Fallback: if we tried plain fetch, got 401/403, and are logged in, retry with solid.fetch
    if (
      (res.status === 401 || res.status === 403) &&
      fetchMethod === fetch &&
      isLoggedIn
    ) {
      console.log("Plain fetch denied; retrying with Solid authentication");
      res = await solid.fetch(reqUrl, options);
    }
    return res;
  };

  try {
    attemptFetchExternalResource(
      url, // traversal start
      [
        new URL(nsp.MAO + "Selection"),
        new URL(nsp.MAO + "Extract"),
        new URL(nsp.MAO + "MusicalMaterial"),
      ], // target types
      {
        typeToHandlerMap: {
          [nsp.MAO + "Selection"]: { func: markSelection },
          [nsp.MAO + "Extract"]: { func: registerExtract },
          [nsp.MAO + "MusicalMaterial"]: { func: registerMusicalMaterial },
        },
        followList: [
          new URL(nsp.LDP + "contains"),
          new URL(nsp.MAO + "setting"),
          new URL(nsp.FRBR + "embodiment"),
        ],
        fetchMethod: smartFetch,
      },
    );
  } catch (e) {
    console.warn("Could not load external resource:", e);
  }
}

/**
 * Return a redirect URL suitable for Solid login:
 * - strips OIDC callback params
 * - replaces ?mode=align with ?useFiles (post-alignment listen mode)
 */
function getCleanRedirectUrl() {
  const url = new URL(window.location.href);
  if (url.searchParams.get("mode") === "align") {
    url.searchParams.delete("mode");
    url.searchParams.set("useFiles", "");
  }
  for (const p of ["code", "state", "iss", "error", "error_description"]) {
    url.searchParams.delete(p);
  }
  return url.toString();
}

/**
 * Initialise Solid authentication on page load.
 * Processes any incoming OIDC redirect (code in URL), then populates
 * the Solid drawer.  Never triggers a silent re-auth redirect.
 */
export async function initSolidAuth() {
  // restorePreviousSession is intentionally omitted (defaults to false)
  // so the library will NOT silently redirect to the IdP.
  await solid.handleIncomingRedirect();
  const session = solid.getDefaultSession();
  if (session.info.isLoggedIn) {
    localStorage.removeItem("solidLoginPending");
  }
  populateSolidDrawer();
}

/**
 * Initiate Solid login.
 * @param {string} [provider] – OIDC issuer URL; if omitted, reads from #providerSelect
 */
export async function loginAndFetch(provider) {
  if (!provider) {
    const providerEl = document.getElementById("providerSelect");
    if (!providerEl) {
      console.warn("Solid login: no provider available");
      return;
    }
    provider = providerEl.value;
  }

  localStorage.setItem("solidLoginPending", Date.now().toString());
  localStorage.setItem("solidProvider", provider);

  await solid.login({
    oidcIssuer: provider,
    redirectUrl: getCleanRedirectUrl(),
    clientName: "listen-here",
  });
}

export async function solidLogout() {
  return solid.logout().then(() => {
    localStorage.removeItem("solidProvider");
    storage.removeItem("restoreSolidSession"); // legacy cleanup
    populateSolidDrawer();
  });
}
