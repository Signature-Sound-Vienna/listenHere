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

  // Per-Selection audio URI (from schema:about). Then refuse the load if
  // any audio isn't locally loaded — the user explicitly chose strict mode.
  const selectionAudios = sels.map((s) => _firstId(_asArray(s[nsp.SCHEMA + "about"])));
  const uniqueAudios = [...new Set(selectionAudios.filter(Boolean).map(_normaliseIri))];
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

  // Discover OAs by reading each audio's discovery resource. We then fetch
  // each candidate OA — deserialize will filter to ones that actually
  // target our chain, so over-fetching is harmless.
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
      try {
        return await _fetchJsonLd(uri);
      } catch (err) {
        console.warn("[annotation/v6] couldn't fetch OA", uri, err);
        return null;
      }
    }),
  );

  // Build the graph object expected by deserialize: { uri: body }.
  const graph = {};
  graph[mmUri] = mm;
  graph[extractUri] = extract;
  selUris.forEach((u, i) => { graph[u] = sels[i]; });
  oaUriArr.forEach((u, i) => { if (oas[i]) graph[u] = oas[i]; });

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
