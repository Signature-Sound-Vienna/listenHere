// V6 annotation — Load-from-Solid orchestrator.
//
// Given an MM URI, walks: MM → Extract → Selections → OAs (discovered via
// per-audio discovery resources). Builds a graph object, hands it to
// adapter.deserialize, and adds the result to state with lastPostedUris
// populated so a subsequent Update routes PUTs to the right resources.
//
// listAnnotationsForAudio is the browse path: given an audio URI, returns
// the MM entries listed in that audio's discovery resource so the user can
// pick one.
//
// We refuse to load if any of the annotation's selected audios isn't
// currently loaded locally — the user's choice (E4 scoping decision). The
// per-target reverse map uses the audio's Linked Data URI, which is
// computed from the loaded alignment header.

import * as state from "./state.js";
import * as adapter from "./mao-adapter.js";
import { nsp } from "../linked-data.js";
import { solid, friendContainer, discoveryFragment, getSolidStorage } from "../solid.js";
import { getAudioLinkedDataUri, loadedAlignmentJSON } from "../listen.js";

/**
 * List annotations that involve a given audio. We read the audio's
 * discovery resource and return one entry per mao:MusicalMaterial URL it
 * lists. We fetch each MM in parallel to enrich the row with its label
 * and creation date so the user has something to pick by.
 *
 * @param {string} audioUri — the audio's Linked Data URI.
 * @returns {Promise<Array<{ mmUri, label, created }>>}
 */
export async function listAnnotationsForAudio(audioUri) {
  const session = solid.getDefaultSession();
  if (!session || !session.info || !session.info.isLoggedIn) {
    throw new Error("Sign in to your Solid pod first.");
  }
  const normalised = _normaliseIri(audioUri);
  const discoveryUri = await _discoveryUriFor(normalised);
  if (!discoveryUri) return [];
  const discovery = await _fetchJsonLd(discoveryUri);
  const dataset = _asArray(discovery[nsp.SCHEMA + "dataset"]);
  const mmUrls = dataset
    .filter((entry) => {
      const t = _firstId(_asArray(entry?.[nsp.SCHEMA + "additionalType"]));
      return t === nsp.MAO + "MusicalMaterial";
    })
    .map((entry) => _firstId(_asArray(entry?.[nsp.SCHEMA + "url"])))
    .filter(Boolean);

  const out = await Promise.all(
    mmUrls.map(async (url) => {
      try {
        const mm = await _fetchJsonLd(url);
        return {
          mmUri: url,
          label: _firstValueOrText(mm[nsp.RDFS + "label"]) || "(untitled)",
          created: _firstValueOrText(mm[nsp.DCT + "created"]) || null,
        };
      } catch (_) {
        return { mmUri: url, label: "(unreadable)", created: null };
      }
    }),
  );
  return out;
}

/**
 * For every locally-loaded recording with a Linked Data URI, read its
 * pod discovery resource and return the union of MM entries it lists.
 * Each result row carries `coveredFiles` — the loaded file keys it shows
 * up for — so the UI can hint at how relevant the annotation is to the
 * current workspace. Audios with no discovery resource on the pod (404)
 * are silently skipped.
 */
export async function listAnnotationsForLoadedAudios() {
  const session = solid.getDefaultSession();
  if (!session || !session.info || !session.info.isLoggedIn) {
    throw new Error("Sign in to your Solid pod first.");
  }
  const reverseMap = _buildReverseAudioMap();
  const audios = [...reverseMap.keys()];
  if (audios.length === 0) return [];

  const perAudio = await Promise.all(
    audios.map(async (audioUri) => {
      try {
        const entries = await listAnnotationsForAudio(audioUri);
        return { file: reverseMap.get(audioUri), entries };
      } catch (_) {
        return { file: reverseMap.get(audioUri), entries: [] };
      }
    }),
  );

  // De-dupe by mmUri; record which loaded files each annotation covers.
  const byMm = new Map();
  for (const { file, entries } of perAudio) {
    for (const entry of entries) {
      if (!byMm.has(entry.mmUri)) {
        byMm.set(entry.mmUri, { ...entry, coveredFiles: new Set() });
      }
      byMm.get(entry.mmUri).coveredFiles.add(file);
    }
  }
  return [...byMm.values()].map((e) => ({
    ...e,
    coveredFiles: [...e.coveredFiles].sort(),
  }));
}

/**
 * Load a full annotation chain from the user's Solid pod, given the MM
 * URI, and add it to state. Throws if any referenced audio isn't locally
 * loaded.
 *
 * @param {string} mmUri
 * @param {object} [opts]
 * @param {(label: string) => void} [opts.onProgress]
 * @returns {Promise<string>} the local id of the loaded annotation.
 */
export async function loadAnnotationFromMM(mmUri, opts = {}) {
  const onProgress = opts.onProgress || (() => {});
  const session = solid.getDefaultSession();
  if (!session || !session.info || !session.info.isLoggedIn) {
    throw new Error("Sign in to your Solid pod first.");
  }

  const { graph, selUris, uniqueAudios } = await _fetchChainAsGraph(mmUri, onProgress);

  // Per-Selection audio URI (from schema:about). Refuse the load if any
  // audio isn't locally loaded — the user's strict-mode E4 choice.
  const localUriToFile = _buildReverseAudioMap();
  const missing = uniqueAudios.filter((u) => !localUriToFile.has(u));
  if (missing.length > 0) {
    throw new Error(
      "Refusing to load: this annotation references " +
        missing.length +
        " recording(s) that aren't loaded locally:\n\n" +
        missing.map((m) => "  • " + m).join("\n") +
        "\n\nLoad these audio files (and set their Linked Data URIs in Manage files) before loading the annotation.",
    );
  }

  void selUris; // not needed past the chain build

  onProgress("Reconstructing");
  const annotation = adapter.deserialize(graph, {
    musicalMaterialUri: mmUri,
    resolveFileFromAudioUri: (uri) => localUriToFile.get(_normaliseIri(uri)) || null,
  });
  if (!annotation) {
    throw new Error("Couldn't reconstruct annotation from the fetched graph.");
  }

  // Give the loaded annotation a fresh local id so it doesn't collide with
  // any existing in-memory annotation that was deserialized from the same
  // MM URI earlier in the session.
  annotation.id = "ann_loaded_" + Date.now().toString(36);
  // lastPostedHashes intentionally left null — the FIRST Update after a
  // load will re-PUT every resource (no hashes to compare against),
  // populating hashes in the process. Subsequent Updates skip-unchanged
  // correctly. This avoids reconstructing local-shape canonical bodies
  // here just to seed the hash map.
  annotation.lastPostedHashes = null;

  state.addAnnotation(annotation);
  state.setActiveAnnotation(annotation.id);
  return annotation.id;
}

/**
 * Delete an annotation chain (MM + Extract + Selections + related OAs)
 * from the pod, then patch each affected audio's discovery resource to
 * remove the dataset entries pointing at the deleted resources. Best-
 * effort on discovery cleanup: a discovery PATCH failure doesn't roll the
 * deletions back, just logs and surfaces a warning to the caller.
 *
 * If a local annotation with the same lastPostedUris.mm exists, it's also
 * removed from state — having a local copy that points at non-existent
 * pod resources would be confusing.
 *
 * @param {string} mmUri
 * @param {object} [opts]
 * @param {(label: string) => void} [opts.onProgress]
 * @returns {Promise<{ deletedUris: string[], failedUris: string[] }>}
 */
export async function deleteAnnotationFromPod(mmUri, opts = {}) {
  const onProgress = opts.onProgress || (() => {});
  const session = solid.getDefaultSession();
  if (!session || !session.info || !session.info.isLoggedIn) {
    throw new Error("Sign in to your Solid pod first.");
  }

  const { graph, uniqueAudios } = await _fetchChainAsGraph(mmUri, onProgress);

  // Run deserialize purely to extract the local-key → URI map. We don't
  // need the annotation object itself.
  const ann = adapter.deserialize(graph, {
    musicalMaterialUri: mmUri,
    resolveFileFromAudioUri: (uri) => uri, // dummy; we don't care about file matching for delete
  });
  if (!ann || !ann.lastPostedUris) {
    throw new Error("Couldn't reconstruct chain from " + mmUri);
  }
  const urisToDelete = [...new Set(Object.values(ann.lastPostedUris))].filter(Boolean);

  onProgress("Deleting " + urisToDelete.length + " resource(s)");
  const deletedUris = [];
  const failedUris = [];
  await Promise.all(
    urisToDelete.map(async (uri) => {
      try {
        const resp = await solid.fetch(uri, { method: "DELETE" });
        if (resp.ok || resp.status === 404) {
          deletedUris.push(uri);
        } else {
          failedUris.push(uri);
          console.warn("[annotation/v6] DELETE failed for", uri, resp.status);
        }
      } catch (err) {
        failedUris.push(uri);
        console.warn("[annotation/v6] DELETE threw for", uri, err);
      }
    }),
  );

  // Reconcile each audio's discovery: drop dataset entries pointing at any
  // URI we deleted. Best-effort.
  if (deletedUris.length > 0 && uniqueAudios.length > 0) {
    onProgress("Cleaning discovery resources");
    const deletedSet = new Set(deletedUris);
    await Promise.all(
      uniqueAudios.map(async (audioUri) => {
        try {
          await _purgeDeletedFromDiscovery(audioUri, deletedSet);
        } catch (err) {
          console.warn(
            "[annotation/v6] discovery purge failed for " + audioUri,
            err,
          );
        }
      }),
    );
  }

  // Drop matching local state if present — the user's pod-side copy is gone.
  const local = state.getAll().find((a) => a.lastPostedUris && a.lastPostedUris.mm === mmUri);
  if (local) state.removeAnnotation(local.id);

  return { deletedUris, failedUris };
}

/**
 * Walk MM → Extract → Selections → (per-audio-discovery) OAs and return
 * the assembled graph plus a few intermediate values callers also use.
 * Shared by load and delete.
 */
async function _fetchChainAsGraph(mmUri, onProgress) {
  onProgress("Fetching MusicalMaterial");
  const mm = await _fetchJsonLd(mmUri);
  const extractUri = _firstId(_asArray(mm[nsp.MAO + "setting"]));
  if (!extractUri) throw new Error("MusicalMaterial has no mao:setting reference.");

  onProgress("Fetching Extract");
  const extract = await _fetchJsonLd(extractUri);
  const selUris = _asArray(extract[nsp.FRBR + "embodiment"])
    .map((o) => o?.["@id"])
    .filter(Boolean);
  if (selUris.length === 0) throw new Error("Extract lists no Selections.");

  onProgress("Fetching Selections");
  const sels = await Promise.all(selUris.map(_fetchJsonLd));

  const selectionAudios = sels.map((s) => _firstId(_asArray(s[nsp.SCHEMA + "about"])));
  const uniqueAudios = [...new Set(selectionAudios.filter(Boolean).map(_normaliseIri))];

  onProgress("Discovering OAs");
  const oaUrisToFetch = new Set();
  await Promise.all(
    uniqueAudios.map(async (audioUri) => {
      try {
        const discoveryUri = await _discoveryUriFor(audioUri);
        if (!discoveryUri) return;
        const disc = await _fetchJsonLd(discoveryUri);
        for (const entry of _asArray(disc[nsp.SCHEMA + "dataset"])) {
          const t = _firstId(_asArray(entry?.[nsp.SCHEMA + "additionalType"]));
          if (t !== nsp.OA + "Annotation") continue;
          const url = _firstId(_asArray(entry?.[nsp.SCHEMA + "url"]));
          if (url) oaUrisToFetch.add(url);
        }
      } catch (err) {
        console.warn("[annotation/v6] couldn't read discovery for", audioUri, err);
      }
    }),
  );

  onProgress("Fetching " + oaUrisToFetch.size + " annotation resource(s)");
  const oaUriArr = [...oaUrisToFetch];
  const oas = await Promise.all(
    oaUriArr.map(async (uri) => {
      try { return await _fetchJsonLd(uri); }
      catch (err) {
        console.warn("[annotation/v6] couldn't fetch OA", uri, err);
        return null;
      }
    }),
  );

  const graph = {};
  graph[mmUri] = mm;
  graph[extractUri] = extract;
  selUris.forEach((u, i) => { graph[u] = sels[i]; });
  oaUriArr.forEach((u, i) => { if (oas[i]) graph[u] = oas[i]; });

  return { graph, extractUri, selUris, uniqueAudios };
}

/**
 * Read an audio's discovery resource and PUT it back with all dataset
 * entries pointing at deleted URIs filtered out. Uses ETag if-match.
 */
async function _purgeDeletedFromDiscovery(audioUri, deletedSet) {
  const discoveryUri = await _discoveryUriFor(audioUri);
  if (!discoveryUri) return;
  const resp = await solid.fetch(discoveryUri, {
    headers: { Accept: "application/ld+json" },
  });
  if (!resp.ok) return; // no discovery — nothing to clean
  const etag = resp.headers.get("ETag");
  const body = await resp.json();
  const datasetKey = nsp.SCHEMA + "dataset";
  let dataset = _asArray(body[datasetKey]);
  const before = dataset.length;
  dataset = dataset.filter((entry) => {
    const url = _firstId(_asArray(entry?.[nsp.SCHEMA + "url"]));
    return !url || !deletedSet.has(url);
  });
  if (dataset.length === before) return; // nothing to remove
  body[datasetKey] = dataset;
  await solid.fetch(discoveryUri, {
    method: "PUT",
    headers: {
      "Content-Type": "application/ld+json",
      ...(etag ? { "If-Match": etag } : {}),
    },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function _fetchJsonLd(uri) {
  const resp = await solid.fetch(uri, {
    headers: { Accept: "application/ld+json" },
  });
  if (!resp.ok) {
    throw new Error("GET " + uri + " failed: " + resp.status);
  }
  return resp.json();
}

/**
 * Compute the URI of the discovery resource for a given audio URI. We
 * don't go through establishDiscoveryResource here — that would CREATE
 * the resource if missing, but for Load we only want to READ. Mirror the
 * naming convention (`<storage>/at.ac.mdw.mei-friend/discovery/<encoded>`).
 */
async function _discoveryUriFor(audioUri) {
  const storage = await getSolidStorage();
  if (!storage) return null;
  return storage + friendContainer + discoveryFragment + encodeURIComponent(audioUri);
}

function _normaliseIri(uri) {
  try {
    return new URL(uri).toString();
  } catch (_) {
    return uri;
  }
}

/**
 * Reverse-map every locally-loaded audio file to its Linked Data URI.
 * Files come from loadedAlignmentJSON.body.audio (canonical loaded set).
 * URIs are normalised through the URL constructor so percent-encoding
 * matches whatever the server returns.
 */
function _buildReverseAudioMap() {
  const m = new Map();
  const audioMap = loadedAlignmentJSON && loadedAlignmentJSON.body && loadedAlignmentJSON.body.audio;
  if (!audioMap) return m;
  for (const file of Object.keys(audioMap)) {
    const uri = getAudioLinkedDataUri(file);
    if (!uri) continue;
    m.set(_normaliseIri(uri), file);
  }
  return m;
}

function _asArray(v) {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function _firstId(arr) {
  if (!arr || arr.length === 0) return null;
  const v = arr[0];
  return (v && v["@id"]) || null;
}

function _firstValueOrText(arr) {
  if (!arr) return null;
  const a = Array.isArray(arr) ? arr : [arr];
  if (a.length === 0) return null;
  const v = a[0];
  if (typeof v === "string") return v;
  if (v && v["@value"] !== undefined) return v["@value"];
  return null;
}
