//import {
//  log,
//  meiFileName,
//  fileLocationType,
//  github, // instance
//  meiFileLocation,
//  storage,
//  version
//} from './main.js';

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
    "@type": [nsp.MAO + "Extract", nsp.SCHEMA + "Dataset"],
  },
  maoSelection: {
    "@type": [nsp.MAO + "Selection", nsp.SCHEMA + "Dataset"],
  },
  maoMusicalMaterial: {
    "@type": [nsp.MAO + "MusicalMaterial", nsp.SCHEMA + "Dataset"],
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
 * PUT a resource at a caller-chosen URI. Eliminates two round trips per
 * resource vs `postResource`: no container-existence HEAD (the
 * orchestrator's session-level cache is trusted) and no follow-up
 * "@id-fixup" GET+PUT (we know the URI up front and bake it in).
 *
 * Sets dct:creator / dct:created / dct:provenance and the @id, then PUTs
 * with `If-None-Match: *` so an accidental URI collision fails fast
 * rather than overwriting someone else's resource. Throws on non-2xx so
 * callers can surface failure to the user.
 *
 * @param {string} uri — fully-qualified target URI (orchestrator-minted).
 * @param {object} body — JSON-LD body. Mutated in place to add metadata.
 * @returns {Promise<Response>} the PUT response.
 */
export async function createResourceAtUri(uri, body) {
  const webId = solid.getDefaultSession().info.webId;
  body["@id"] = uri;
  body[nsp.DCT + "creator"] = { "@id": webId };
  body[nsp.DCT + "created"] = new Date().toISOString();
  body[nsp.DCT + "provenance"] =
    `Generated using Listen Here v.${versionString}: https://iwk.mdw.ac.at/signature-sound-vienna`;
  const resp = await solid.fetch(uri, {
    method: "PUT",
    headers: {
      "Content-Type": "application/ld+json",
      "If-None-Match": "*",
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    throw new Error("PUT failed for " + uri + ": " + resp.status + " " + resp.statusText);
  }
  return resp;
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

export async function createMAOMusicalObject(
  selectedElements,
  currentFileUri,
  label = "",
) {
  // Function to build a Musical Object according to the Music Annotation Ontology:
  // https://dl.acm.org/doi/10.1145/3543882.3543891
  // Build a composite structure encompassing MusicalMaterial, Extract, and Selection.
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

export async function createMAOSelection(
  selection,
  aboutUri,
  discoveryUri,
  label = "",
  peaksData = null,
) {
  // private function -- called *after* friendContainer and musicalObjectContainer already established
  let resource = structuredClone(resources.maoSelection);
  // selection can be a single URI string or an array of URIs (non-contiguous regions)
  const selArr = Array.isArray(selection) ? selection : [selection];
  resource[nsp.FRBR + "part"] = selArr.map((s) => ({ "@id": s }));
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

export async function createMAOExtract(
  postSelectionResponse,
  aboutUri,
  discoveryUri,
  label = "",
) {
  console.log("createMAOExtract: ", postSelectionResponse);
  // Accept a single response or an array of responses
  const responses = Array.isArray(postSelectionResponse)
    ? postSelectionResponse
    : [postSelectionResponse];
  let resource = structuredClone(resources.maoExtract);
  resource[nsp.FRBR + "embodiment"] = responses.map((r) => ({
    "@id": resolveLocation(r),
  }));
  if (label) {
    resource[nsp.RDFS + "label"] = label;
  }
  aboutUri = Array.isArray(aboutUri) ? aboutUri : [aboutUri];
  resource[nsp.SCHEMA + "about"] = aboutUri.map((uri) => ({ "@id": uri }));
  discoveryUri = Array.isArray(discoveryUri) ? discoveryUri : [discoveryUri];
  resource[nsp.SCHEMA + "includedInDataCatalog"] = discoveryUri.map((uri) => ({
    "@id": uri,
  }));
  return postResource(extractContainer, resource);
}

export async function createMAOMusicalMaterial(
  postExtractResponse,
  aboutUri,
  discoveryUri,
  label = "",
) {
  console.log("createMAOMusicalMaterial: ", postExtractResponse);
  let extractUri = resolveLocation(postExtractResponse);
  let resource = structuredClone(resources.maoMusicalMaterial);
  resource[nsp.MAO + "setting"] = { "@id": extractUri };
  if (label) {
    resource[nsp.RDFS + "label"] = label;
  }
  aboutUri = Array.isArray(aboutUri) ? aboutUri : [aboutUri];
  resource[nsp.SCHEMA + "about"] = aboutUri.map((uri) => ({ "@id": uri }));
  discoveryUri = Array.isArray(discoveryUri) ? discoveryUri : [discoveryUri];
  resource[nsp.SCHEMA + "includedInDataCatalog"] = discoveryUri.map((uri) => ({
    "@id": uri,
  }));
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

/**
 * As of the Phase F + drawer-redesign iteration, this function no longer
 * paints a separate Solid drawer — the V6 annotation drawer subscribes to
 * `solid-auth-changed` and renders its own footer. We just dispatch the
 * event with the current login status and clear the "pending" flag so
 * cancelled-login state doesn't get stuck.
 */
export async function populateSolidDrawer() {
  const isLoggedIn = solid.getDefaultSession().info.isLoggedIn;
  if (isLoggedIn) {
    try { localStorage.removeItem("solidLoginPending"); } catch (_) {}
  }
  document.dispatchEvent(
    new CustomEvent("solid-auth-changed", { detail: { isLoggedIn } }),
  );
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

/** Reference to the login popup window (if open). */
let _loginPopup = null;

/**
 * Listen for postMessage from the login popup.
 * The popup simply captures the IdP callback URL (with ?code=&state=)
 * and forwards it here.  We then call handleIncomingRedirect() on the
 * *main page* so the token exchange happens in our own context —
 * tokens land in the main page's in-memory secure storage.
 * The main page NEVER navigates away.
 */
function _setupPopupMessageListener() {
  window.addEventListener("message", async (event) => {
    // Only accept messages from our own origin
    if (event.origin !== window.location.origin) return;
    if (!event.data || event.data.type !== "solid-popup-callback") return;

    _loginPopup = null; // popup is closing itself

    if (event.data.callbackUrl) {
      console.log("Received callback URL from popup, exchanging tokens…");
      localStorage.removeItem("solidLoginPending");

      // The library's handleIncomingRedirect will: extract code+state from
      // the URL, exchange them for tokens, and populate session info — all
      // without navigating the browser.
      // It also calls cleanUrlAfterRedirect which does a replaceState with
      // the callback origin+path; we counteract that below.
      const savedHref = window.location.href;
      const session = await solid.handleIncomingRedirect(
        event.data.callbackUrl,
      );
      // Restore address bar (the library may have replaced it with the
      // popup callback path during cleanUrlAfterRedirect).
      if (window.location.href !== savedHref) {
        window.history.replaceState({}, "", savedHref);
      }

      if (session && session.isLoggedIn) {
        console.log("Solid popup auth succeeded for", session.webId);
        localStorage.setItem("solidProvider", event.data.provider || "");
      } else {
        console.warn("Token exchange completed but session not logged in");
      }
      populateSolidDrawer();
    } else {
      // Popup reported failure
      console.warn("Solid popup auth failed:", event.data.error || "unknown");
      localStorage.removeItem("solidLoginPending");
      populateSolidDrawer();
    }
  });
}

/**
 * Initialise Solid authentication on page load.
 * Processes any incoming OIDC redirect (code in URL), then populates
 * the Solid drawer.  Also sets up the popup message listener for
 * future login attempts.
 */
export async function initSolidAuth() {
  // Set up the listener for popup-based logins
  _setupPopupMessageListener();

  // Process an incoming OIDC redirect if present (code/state in URL).
  // restorePreviousSession is intentionally omitted (defaults to false)
  // so the library will NOT silently redirect to the IdP on a plain
  // page load.  The redirect restore only happens explicitly after
  // the popup reports success (see _setupPopupMessageListener above).
  await solid.handleIncomingRedirect();
  const session = solid.getDefaultSession();
  if (session.info.isLoggedIn) {
    localStorage.removeItem("solidLoginPending");
  }
  populateSolidDrawer();
}

/**
 * Initiate Solid login via a popup window.
 *
 * We call solid.login() on the MAIN PAGE with a handleRedirect callback
 * that intercepts the IdP navigation and opens it in a popup instead.
 * The popup handles credential entry and the IdP redirects it back to
 * our callback page.  That page captures the callback URL (with
 * ?code=&state=) and posts it to us via postMessage.  We then call
 * handleIncomingRedirect(callbackUrl) on the main page, so the token
 * exchange happens here — tokens end up in the main page's in-memory
 * storage.
 *
 * The main page NEVER navigates.  Blob URLs, waveforms, and draft
 * state are fully preserved.
 *
 * Falls back to a direct redirect if the popup is blocked.
 *
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

  localStorage.setItem("solidProvider", provider);

  // The callback URL that the IdP will redirect the popup to.
  // The popup callback page captures this URL and posts it back.
  const popupCallbackUrl = window.location.origin + "/solid-popup-callback";

  // Pre-open the popup (must happen synchronously in the click handler
  // to avoid popup blockers), pointing at a blank/loading page.
  const w = 520,
    h = 600;
  const left = Math.round(screen.width / 2 - w / 2);
  const top = Math.round(screen.height / 2 - h / 2);
  const features = `width=${w},height=${h},left=${left},top=${top},toolbar=no,menubar=no`;

  _loginPopup = window.open(popupCallbackUrl, "solidLogin", features);

  if (!_loginPopup || _loginPopup.closed) {
    // Popup was blocked — fall back to direct redirect
    console.warn("Popup blocked, falling back to redirect login");
    _loginPopup = null;
    localStorage.setItem("solidLoginPending", Date.now().toString());
    await solid.login({
      oidcIssuer: provider,
      redirectUrl: getCleanRedirectUrl(),
      clientName: "listen-here",
    });
    return;
  }

  // Call solid.login() with handleRedirect — the library prepares the
  // OIDC auth request (stores code_verifier etc. in localStorage) and
  // then calls our callback with the full IdP authorization URL instead
  // of navigating the current page.
  await solid.login({
    oidcIssuer: provider,
    redirectUrl: popupCallbackUrl,
    clientName: "listen-here",
    handleRedirect: (idpUrl) => {
      // Navigate the already-open popup to the IdP login page
      _loginPopup.location.href = idpUrl;
    },
  });
}

export async function solidLogout() {
  return solid.logout().then(() => {
    localStorage.removeItem("solidProvider");
    storage.removeItem("restoreSolidSession"); // legacy cleanup
    populateSolidDrawer();
  });
}
