// V6 annotation — Post / Update-to-Solid orchestrator.
//
// Phase E2: `postAnnotationToSolid` does greenfield posts — walks the
// adapter's resource templates in dependency order, POSTs each to the
// appropriate Solid container, substituting `_:<localKey>` placeholders
// with real URIs as they resolve, then patches each audio's discovery
// resource. Records the localKey → URI map via state.markPosted.
//
// Phase E3: `updateAnnotationOnSolid` reuses the same template generation
// but diffs against `ann.lastPostedUris`. Per-resource behaviour:
//   - localKey present in lastPostedUris → PUT the existing URI (preserving
//     dct:creator/created/provenance from the resource on the pod).
//   - localKey new → POST as usual.
//   - localKey absent from new template set → DELETE from the pod.
// Discovery resources are reconciled: new dataset entries added, entries
// pointing at deleted URIs removed. PUTs honour ETag via If-Match, with
// 412 retry on conflict.

import * as state from "./state.js";
import * as adapter from "./mao-adapter.js";
import { nsp } from "../linked-data.js";
import {
  establishContainers,
  establishDiscoveryResource,
  postResource,
  resolveLocation,
  safelyPatchResource,
  selectionContainer,
  extractContainer,
  musicalMaterialContainer,
  annotationContainer,
  solid,
} from "../solid.js";
import { getAudioLinkedDataUri, loadedAlignmentJSON } from "../listen.js";
import { commitAnnotationsToAlignment } from "./index.js";

/**
 * Post an annotation to the user's Solid pod. Throws on precondition or
 * network failure. Returns the localKey → posted-URI map on success.
 *
 * @param {string} annId
 * @param {object} [opts]
 * @param {(step: number, total: number, label?: string) => void} [opts.onProgress]
 */
export async function postAnnotationToSolid(annId, opts = {}) {
  const onProgress = opts.onProgress || (() => {});
  const ann = state.getById(annId);
  if (!ann) throw new Error("Annotation not found.");
  const session = solid.getDefaultSession();
  if (!session || !session.info || !session.info.isLoggedIn) {
    throw new Error("Sign in to your Solid pod first.");
  }
  if (ann.targets.length === 0) {
    throw new Error("Select at least one recording before posting.");
  }

  // 1. Resolve each selected recording's Linked Data URI. Bail loudly if any
  //    are missing — without these we can't anchor frbr:parts. URIs are
  //    normalised through the URL constructor so unencoded spaces and
  //    special chars in path components get percent-encoded; otherwise the
  //    JSON-LD parser on the Solid server rejects them as invalid IRIs.
  const fileToAudioUri = {};
  for (const t of ann.targets) {
    const audioUri = getAudioLinkedDataUri(t.file);
    if (!audioUri || !/^https?:\/\//i.test(audioUri)) {
      throw new Error(
        `${t.file} has no Linked Data URI. Set one in Manage files → Linked Data URIs first.`,
      );
    }
    fileToAudioUri[t.file] = _normaliseIri(audioUri);
  }

  // 2. Ensure containers + discovery resources exist.
  await establishContainers();
  const uniqueAudioUris = [...new Set(Object.values(fileToAudioUri))];
  const discoveryByAudio = {};
  for (const audioUri of uniqueAudioUris) {
    const r = await establishDiscoveryResource(audioUri);
    if (!r || !r.url) {
      throw new Error("Couldn't establish discovery resource for " + audioUri);
    }
    discoveryByAudio[audioUri] = r.url;
  }

  // 3. Serialise. Adapter emits `{"@id": "_:<localKey>"}` placeholders for
  //    every inter-resource reference; we'll resolve those at POST time.
  const { templates } = adapter.serialize(ann, {
    resolveAudioUri: (f) => fileToAudioUri[f],
  });

  // 4. Topological order (deps before dependents).
  const sorted = _topoSort(templates);

  // 5. POST each in turn, substituting placeholders with already-resolved URIs.
  const total = sorted.length + Object.keys(discoveryByAudio).length;
  let step = 0;
  onProgress(step, total);
  const localToUri = {};
  for (const t of sorted) {
    const body = _substitutePlaceholders(t.body, localToUri);
    _decorateMAOResource(body, t, fileToAudioUri, discoveryByAudio);
    const container = _containerForKind(t.kind);
    const response = await postResource(container, body);
    if (!response || !response.headers || !response.headers.get("Location")) {
      throw new Error("POST returned no Location header for " + t.localKey);
    }
    localToUri[t.localKey] = resolveLocation(response);
    onProgress(++step, total);
  }

  // 6. Patch discovery resources so future loads can find the chain by audio.
  await _patchDiscoveryResources(
    localToUri,
    fileToAudioUri,
    discoveryByAudio,
    () => onProgress(++step, total),
  );

  // 7. Record on state and commit the URIs into in-memory alignment.json so
  //    a subsequent Save Data captures them.
  state.markPosted(annId, localToUri);
  if (loadedAlignmentJSON) commitAnnotationsToAlignment(loadedAlignmentJSON);

  return localToUri;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Pass an IRI through the URL constructor so spaces and other special chars
 * in path/query/fragment get percent-encoded. The Solid server's JSON-LD
 * parser rejects unencoded spaces (and similar) as invalid IRIs.
 */
function _normaliseIri(uri) {
  try {
    return new URL(uri).toString();
  } catch (_) {
    return uri;
  }
}

function _topoSort(templates) {
  const byKey = new Map(templates.map((t) => [t.localKey, t]));
  const visited = new Set();
  const out = [];
  function visit(t) {
    if (!t || visited.has(t.localKey)) return;
    visited.add(t.localKey);
    for (const dep of t.dependsOn || []) {
      visit(byKey.get(dep));
    }
    out.push(t);
  }
  for (const t of templates) visit(t);
  return out;
}

function _substitutePlaceholders(node, mapping) {
  if (Array.isArray(node)) {
    return node.map((x) => _substitutePlaceholders(x, mapping));
  }
  if (node && typeof node === "object") {
    if (typeof node["@id"] === "string" && node["@id"].startsWith("_:")) {
      const key = node["@id"].substring(2);
      if (!mapping[key]) {
        throw new Error("Unresolved dependency: " + key);
      }
      const copy = {};
      for (const k of Object.keys(node)) {
        copy[k] = k === "@id" ? mapping[key] : _substitutePlaceholders(node[k], mapping);
      }
      return copy;
    }
    const out = {};
    for (const k of Object.keys(node)) {
      out[k] = _substitutePlaceholders(node[k], mapping);
    }
    return out;
  }
  return node;
}

function _containerForKind(kind) {
  switch (kind) {
    case "mao:Selection": return selectionContainer;
    case "mao:Extract": return extractContainer;
    case "mao:MusicalMaterial": return musicalMaterialContainer;
    case "oa:Annotation": return annotationContainer;
    default: throw new Error("Unknown resource kind: " + kind);
  }
}

function _decorateMAOResource(body, template, fileToAudioUri, discoveryByAudio) {
  // Add schema:about and schema:includedInDataCatalog (mirroring the legacy
  // convention) so MAO resources are discoverable from their audio. OA
  // annotations aren't decorated — they're found via the chain.
  if (template.kind === "mao:Selection") {
    const file = template.localKey.substring("sel/".length);
    const audioUri = fileToAudioUri[file];
    if (audioUri) {
      // Adapter already set schema:about; just add discovery.
      body[nsp.SCHEMA + "includedInDataCatalog"] = [
        { "@id": discoveryByAudio[audioUri] },
      ];
    }
    return;
  }
  if (template.kind === "mao:Extract" || template.kind === "mao:MusicalMaterial") {
    const audios = [...new Set(Object.values(fileToAudioUri))];
    body[nsp.SCHEMA + "about"] = audios.map((u) => ({ "@id": u }));
    body[nsp.SCHEMA + "includedInDataCatalog"] = audios.map((u) => ({
      "@id": discoveryByAudio[u],
    }));
  }
}

async function _patchDiscoveryResources(
  localToUri,
  fileToAudioUri,
  discoveryByAudio,
  onAudioPatched,
) {
  const mmUri = localToUri["mm"];
  const extractUri = localToUri["extract"];
  if (!mmUri || !extractUri) return;

  // Group Selection URIs by audio URI (defensive — different files could
  // share an audio in pathological cases).
  const audioToSelUris = {};
  for (const file of Object.keys(fileToAudioUri)) {
    const audioUri = fileToAudioUri[file];
    const selUri = localToUri["sel/" + file];
    if (!selUri) continue;
    (audioToSelUris[audioUri] = audioToSelUris[audioUri] || []).push(selUri);
  }

  const datasetPath =
    "/" +
    nsp.SCHEMA.replaceAll("~", "~0").replaceAll("/", "~1") +
    "dataset/-";

  for (const audioUri of Object.keys(audioToSelUris)) {
    const discoveryUri = discoveryByAudio[audioUri];
    if (!discoveryUri) continue;
    const selUris = audioToSelUris[audioUri];
    const ops = [
      _datasetOp(datasetPath, mmUri, nsp.MAO + "MusicalMaterial"),
      _datasetOp(datasetPath, extractUri, nsp.MAO + "Extract"),
      ...selUris.map((s) => _datasetOp(datasetPath, s, nsp.MAO + "Selection")),
    ];
    try {
      await safelyPatchResource(discoveryUri, ops);
    } catch (err) {
      // Discovery is for findability, not correctness — log but don't abort
      // the whole post over a patch failure.
      console.warn(
        "[annotation/v6] discovery patch failed for " + discoveryUri,
        err,
      );
    }
    if (typeof onAudioPatched === "function") onAudioPatched();
  }
}

function _datasetOp(path, url, additionalTypeIri) {
  return {
    op: "add",
    path,
    value: {
      "@type": nsp.SCHEMA + "Dataset",
      [nsp.SCHEMA + "additionalType"]: { "@id": additionalTypeIri },
      [nsp.SCHEMA + "url"]: { "@id": url },
    },
  };
}

// ---------------------------------------------------------------------------
// Phase E3 — update an already-posted annotation
// ---------------------------------------------------------------------------

const _PRESERVED_METADATA_PREDS = [
  nsp.DCT + "creator",
  nsp.DCT + "created",
  nsp.DCT + "provenance",
];

/**
 * Update an annotation on the user's Solid pod. Requires that the annotation
 * has been previously posted (lastPostedUris populated). Throws on
 * precondition or hard network failure. Returns the new localKey → URI map.
 *
 * Resources in lastPostedUris that no longer correspond to a new template
 * are DELETEd. New resources are POSTed. Existing resources are PUT in-place
 * with their original dct:creator/created/provenance preserved.
 */
export async function updateAnnotationOnSolid(annId, opts = {}) {
  const onProgress = opts.onProgress || (() => {});
  const ann = state.getById(annId);
  if (!ann) throw new Error("Annotation not found.");
  const session = solid.getDefaultSession();
  if (!session || !session.info || !session.info.isLoggedIn) {
    throw new Error("Sign in to your Solid pod first.");
  }
  if (!ann.published || !ann.lastPostedUris || !ann.lastPostedUris["mm"]) {
    throw new Error(
      "This annotation hasn't been posted yet — use Post to Solid first.",
    );
  }
  if (ann.targets.length === 0) {
    throw new Error("Select at least one recording before updating.");
  }

  // Resolve and normalise audio URIs for the current target set.
  const fileToAudioUri = {};
  for (const t of ann.targets) {
    const audioUri = getAudioLinkedDataUri(t.file);
    if (!audioUri || !/^https?:\/\//i.test(audioUri)) {
      throw new Error(
        `${t.file} has no Linked Data URI. Set one in Manage files → Linked Data URIs first.`,
      );
    }
    fileToAudioUri[t.file] = _normaliseIri(audioUri);
  }

  // Ensure containers + discovery resources exist for the current audio set.
  await establishContainers();
  const uniqueAudioUris = [...new Set(Object.values(fileToAudioUri))];
  const discoveryByAudio = {};
  for (const audioUri of uniqueAudioUris) {
    const r = await establishDiscoveryResource(audioUri);
    if (r && r.url) discoveryByAudio[audioUri] = r.url;
  }
  // Audios that were involved before but aren't anymore (detached files)
  // — we still need to touch their discovery resource to remove stale entries.
  const oldFileToAudioUri = _oldFileToAudioUri(ann.lastPostedUris);
  for (const oldAudio of Object.values(oldFileToAudioUri)) {
    if (!discoveryByAudio[oldAudio]) {
      const r = await establishDiscoveryResource(oldAudio);
      if (r && r.url) discoveryByAudio[oldAudio] = r.url;
    }
  }

  // Generate new templates from current state.
  const { templates } = adapter.serialize(ann, {
    resolveAudioUri: (f) => fileToAudioUri[f],
  });

  // Delta vs lastPostedUris.
  const oldKeys = new Set(Object.keys(ann.lastPostedUris));
  const newKeys = new Set(templates.map((t) => t.localKey));
  const toDeleteKeys = [...oldKeys].filter((k) => !newKeys.has(k));

  // Process in topological order: deps first so dependent resources have
  // their reference URIs available for substitution.
  const sorted = _topoSort(templates);
  const localToUri = { ...ann.lastPostedUris };
  const createdUris = [];
  const total =
    sorted.length + toDeleteKeys.length + Object.keys(discoveryByAudio).length;
  let step = 0;
  onProgress(step, total);

  for (const t of sorted) {
    const body = _substitutePlaceholders(t.body, localToUri);
    _decorateMAOResource(body, t, fileToAudioUri, discoveryByAudio);
    if (oldKeys.has(t.localKey)) {
      // Existing resource — PUT new body in place, preserving provenance.
      await _safelyReplaceResource(localToUri[t.localKey], body);
    } else {
      // New resource — POST.
      const response = await postResource(_containerForKind(t.kind), body);
      if (!response || !response.headers || !response.headers.get("Location")) {
        throw new Error("POST returned no Location header for " + t.localKey);
      }
      const uri = resolveLocation(response);
      localToUri[t.localKey] = uri;
      createdUris.push(uri);
    }
    onProgress(++step, total);
  }

  // DELETE removed resources.
  const deletedUris = [];
  for (const key of toDeleteKeys) {
    const uri = ann.lastPostedUris[key];
    try {
      const resp = await solid.fetch(uri, { method: "DELETE" });
      if (resp.ok || resp.status === 404) {
        deletedUris.push(uri);
        delete localToUri[key];
      } else {
        console.warn("[annotation/v6] DELETE failed for", uri, resp.status);
      }
    } catch (err) {
      console.warn("[annotation/v6] DELETE threw for", uri, err);
    }
    onProgress(++step, total);
  }

  // Reconcile each audio's discovery: add entries for newly-created URIs,
  // remove entries pointing at deleted ones.
  await _reconcileDiscoveryResources(
    discoveryByAudio,
    fileToAudioUri,
    localToUri,
    createdUris,
    deletedUris,
    () => onProgress(++step, total),
  );

  state.markPosted(annId, localToUri);
  if (loadedAlignmentJSON) commitAnnotationsToAlignment(loadedAlignmentJSON);
  return localToUri;
}

/**
 * Build a fileToAudioUri map for the files referenced by an old lastPostedUris
 * (used to discover discovery resources for files that have since been
 * detached from the annotation). Quietly skips files whose LD URI no longer
 * resolves.
 */
function _oldFileToAudioUri(oldUris) {
  const out = {};
  for (const key of Object.keys(oldUris || {})) {
    if (!key.startsWith("sel/")) continue;
    const file = key.slice("sel/".length);
    const audio = getAudioLinkedDataUri(file);
    if (audio && /^https?:\/\//i.test(audio)) {
      out[file] = _normaliseIri(audio);
    }
  }
  return out;
}

/**
 * PUT a new body to an existing Solid resource, preserving its
 * dct:creator / dct:created / dct:provenance fields and adding a fresh
 * dct:modified. Retries on 412 (ETag conflict) up to MAX_RETRIES times,
 * each retry refetching the current body + ETag so the merge is against
 * the latest server state.
 */
async function _safelyReplaceResource(uri, newContentBody) {
  const MAX_RETRIES = 5;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const getResp = await solid.fetch(uri, {
      headers: { Accept: "application/ld+json" },
    });
    if (!getResp.ok) {
      throw new Error(
        "Couldn't GET " + uri + " for update: " + getResp.status,
      );
    }
    const etag = getResp.headers.get("ETag");
    const current = await getResp.json();

    const merged = {};
    // Start with new content fields.
    for (const k of Object.keys(newContentBody)) {
      merged[k] = newContentBody[k];
    }
    // Preserve provenance fields from current server state.
    for (const k of _PRESERVED_METADATA_PREDS) {
      if (current[k] !== undefined) merged[k] = current[k];
    }
    // @id must match the resource's URI.
    merged["@id"] = current["@id"] || uri;
    merged[nsp.DCT + "modified"] = new Date().toISOString();

    const putResp = await solid.fetch(uri, {
      method: "PUT",
      headers: {
        "Content-Type": "application/ld+json",
        ...(etag ? { "If-Match": etag } : {}),
      },
      body: JSON.stringify(merged),
    });
    if (putResp.ok) return putResp;
    if (putResp.status === 412) {
      // ETag conflict — wait briefly then refetch and retry.
      await new Promise((r) => setTimeout(r, 200));
      continue;
    }
    throw new Error(
      "PUT failed for " + uri + ": " + putResp.status + " " + putResp.statusText,
    );
  }
  throw new Error("PUT for " + uri + " exhausted retries on 412 conflicts.");
}

/**
 * Reconcile each audio's discovery resource. Adds dataset entries for newly
 * created URIs (associated with this audio, or for the shared MM/Extract);
 * removes entries pointing at any URI we just DELETEd. Best-effort: a
 * failure logs a warning but doesn't abort the overall update.
 */
async function _reconcileDiscoveryResources(
  discoveryByAudio,
  fileToAudioUri,
  newUris,
  createdUris,
  deletedUris,
  onAudioReconciled,
) {
  const audioCount = Object.keys(discoveryByAudio).length;
  if (audioCount === 0) return;
  if (createdUris.length === 0 && deletedUris.length === 0) {
    // Still report progress for the audios we'd have reconciled, to keep
    // the caller's step counter consistent.
    if (typeof onAudioReconciled === "function") {
      for (let i = 0; i < audioCount; i++) onAudioReconciled();
    }
    return;
  }

  // Map created Selection URIs to their audio.
  const selUriToAudio = {};
  for (const [key, uri] of Object.entries(newUris)) {
    if (key.startsWith("sel/")) {
      const file = key.slice("sel/".length);
      const audio = fileToAudioUri[file];
      if (audio) selUriToAudio[uri] = audio;
    }
  }
  const createdSet = new Set(createdUris);
  const deletedSet = new Set(deletedUris);

  for (const [audioUri, discoveryUri] of Object.entries(discoveryByAudio)) {
    // Determine which new URIs to add to THIS audio's discovery:
    //   - MM (shared, but only add if we created it).
    //   - Extract (same).
    //   - Selections whose audio matches.
    const adds = [];
    if (createdSet.has(newUris["mm"])) {
      adds.push({ uri: newUris["mm"], type: nsp.MAO + "MusicalMaterial" });
    }
    if (createdSet.has(newUris["extract"])) {
      adds.push({ uri: newUris["extract"], type: nsp.MAO + "Extract" });
    }
    for (const uri of createdUris) {
      if (selUriToAudio[uri] === audioUri) {
        adds.push({ uri, type: nsp.MAO + "Selection" });
      }
    }
    if (adds.length === 0 && deletedSet.size === 0) {
      if (typeof onAudioReconciled === "function") onAudioReconciled();
      continue;
    }
    try {
      await _patchDiscoveryReconcile(discoveryUri, adds, deletedSet);
    } catch (err) {
      console.warn(
        "[annotation/v6] discovery reconcile failed for " + discoveryUri,
        err,
      );
    }
    if (typeof onAudioReconciled === "function") onAudioReconciled();
  }
}

async function _patchDiscoveryReconcile(discoveryUri, adds, removeUriSet) {
  const getResp = await solid.fetch(discoveryUri, {
    headers: { Accept: "application/ld+json" },
  });
  if (!getResp.ok) return;
  const etag = getResp.headers.get("ETag");
  const body = await getResp.json();
  const datasetKey = nsp.SCHEMA + "dataset";
  let dataset = body[datasetKey] || [];
  if (!Array.isArray(dataset)) dataset = [dataset];

  if (removeUriSet.size > 0) {
    dataset = dataset.filter((entry) => {
      const url = entry && entry[nsp.SCHEMA + "url"];
      const id = url && (Array.isArray(url) ? url[0] : url)["@id"];
      return !removeUriSet.has(id);
    });
  }
  for (const { uri, type } of adds) {
    const exists = dataset.some((e) => {
      const url = e && e[nsp.SCHEMA + "url"];
      const id = url && (Array.isArray(url) ? url[0] : url)["@id"];
      return id === uri;
    });
    if (!exists) {
      dataset.push({
        "@type": nsp.SCHEMA + "Dataset",
        [nsp.SCHEMA + "additionalType"]: { "@id": type },
        [nsp.SCHEMA + "url"]: { "@id": uri },
      });
    }
  }
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
