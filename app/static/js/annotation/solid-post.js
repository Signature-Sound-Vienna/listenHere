// V6 annotation — Post-to-Solid orchestrator (Phase E2, greenfield only).
//
// Walks the adapter's resource templates in dependency order, POSTs each to
// the appropriate Solid container, substituting `_:<localKey>` placeholders
// in dependent resource bodies with the real URIs as they resolve.
//
// After all resources are posted, patches each audio's discovery resource
// with new entries pointing at the MM, Extract, and that audio's Selection
// so the chain is findable from the audio URI (mirrors legacy convention).
//
// Records the localKey → URI map on the annotation via state.markPosted.
// E3 will diff the next post against that map; for now we assume the
// annotation hasn't been posted before.

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
import { getAudioLinkedDataUri } from "../listen.js";

/**
 * Post an annotation to the user's Solid pod. Throws on precondition or
 * network failure. Returns the localKey → posted-URI map on success.
 */
export async function postAnnotationToSolid(annId) {
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
  }

  // 6. Patch discovery resources so future loads can find the chain by audio.
  await _patchDiscoveryResources(localToUri, fileToAudioUri, discoveryByAudio);

  // 7. Record on state. markPosted leaves hasUnsavedChanges=true so the
  //    posted URIs get persisted into alignment.json on the next Save.
  state.markPosted(annId, localToUri);

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
