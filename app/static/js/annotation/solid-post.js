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
//
// Phase E3-perf (added later): three orthogonal speed-ups apply to both
// flows.
//   1. Skip-unchanged via content hash. On every post/update we hash each
//      resource's final body (post-substitution, post-decoration) and store
//      the hash next to lastPostedUris. On the next Update, resources whose
//      hash matches skip the PUT entirely — a text-only edit becomes a
//      single PUT instead of N.
//   2. Topo-level parallelism. Templates are grouped by depth in the
//      dependency graph; each level fires Promise.all so independent
//      resources don't serialise. PUTs (URIs stable) and POSTs (URIs
//      assigned within the level) coexist within a level.
//   3. Session-scoped existence cache for containers and per-audio
//      discovery resources, so we don't re-check via HEAD on every run.
//      Caches are soft: a 404 on a presumed-existing resource invalidates
//      the cache entry and re-establishes once before retrying.
//
// OA discovery: each OA is also listed in the discovery resource of every
// audio it (transitively) targets, tagged with schema:additionalType =
// oa:Annotation. Consumers can therefore find every annotation about a
// given audio by reading that audio's discovery resource alone.

import * as state from "./state.js";
import * as adapter from "./mao-adapter.js";
import { nsp } from "../linked-data.js";
import {
  createResourceAtUri,
  establishContainers,
  establishDiscoveryResource,
  getSolidStorage,
  safelyPatchResource,
  selectionContainer,
  extractContainer,
  musicalMaterialContainer,
  annotationContainer,
  solid,
} from "../solid.js";
import { getAudioLinkedDataUri, loadedAlignmentJSON } from "../listen.js";
import { commitAnnotationsToAlignment } from "./index.js";

// ---------------------------------------------------------------------------
// Session-scoped existence cache. We don't HEAD containers / discovery
// resources twice per session — once verified, we trust them. Both caches
// are invalidated lazily on 404 (see _safePostResource).
// ---------------------------------------------------------------------------

let _containersEstablished = false;
const _discoveryCache = new Map(); // audioUri → discoveryResourceUri

async function _ensureContainers() {
  if (_containersEstablished) return;
  await establishContainers();
  _containersEstablished = true;
}

function _invalidateContainersCache() {
  _containersEstablished = false;
  _discoveryCache.clear();
}

async function _ensureDiscoveryFor(audioUri) {
  if (_discoveryCache.has(audioUri)) return _discoveryCache.get(audioUri);
  const r = await establishDiscoveryResource(audioUri);
  if (!r || !r.url) {
    throw new Error("Couldn't establish discovery resource for " + audioUri);
  }
  _discoveryCache.set(audioUri, r.url);
  return r.url;
}

function _invalidateDiscoveryFor(audioUri) {
  _discoveryCache.delete(audioUri);
}

/**
 * Fire-and-forget container + per-audio discovery establishment, called
 * after login so the first user-triggered post doesn't pay for the
 * ~3 round trips that `_ensureContainers` + `_ensureDiscoveryFor` would
 * otherwise add to its critical path. Safe to call repeatedly: cached
 * results short-circuit on the second call.
 *
 * If we don't know the audio URIs yet (e.g. alignment hasn't loaded),
 * we just warm the containers and let discovery establish on demand.
 */
export async function prewarmCaches(audioUris) {
  try {
    await _ensureContainers();
  } catch (err) {
    console.warn("[annotation/v6] prewarm: container establish failed", err);
  }
  if (!Array.isArray(audioUris) || audioUris.length === 0) return;
  await Promise.all(
    audioUris.map(async (u) => {
      try { await _ensureDiscoveryFor(u); }
      catch (err) { console.warn("[annotation/v6] prewarm: discovery establish failed for", u, err); }
    }),
  );
}

// ---------------------------------------------------------------------------
// Client-minted slugs. We PUT-to-URI instead of POSTing-to-container so
// that (a) we avoid the post-POST "@id-fixup" round trip Solid otherwise
// requires and (b) every URI is known up front, letting us substitute
// placeholders before any I/O fires. Slug shape:
//   ${YYYYMMDDTHHMMSS}-${sessionShortId}-${counterPadded4}
// The timestamp makes the URI sortable + debuggable when staring at pod
// contents; sessionShortId disambiguates between page-loads / tabs; the
// monotonic counter guarantees no same-millisecond collisions within a
// session (which can happen when topo-level Promise.all fires several
// mints in the same JS tick). Counter is module-level and never resets.
// ---------------------------------------------------------------------------

const _sessionShortId = (function () {
  try {
    return crypto.randomUUID().slice(0, 8);
  } catch (_) {
    return Math.random().toString(36).slice(2, 10).padStart(8, "0");
  }
})();
let _slugCounter = 0;

function _mintSlug() {
  const n = new Date();
  const pad = (x, w) => String(x).padStart(w, "0");
  const ts =
    n.getUTCFullYear() +
    pad(n.getUTCMonth() + 1, 2) +
    pad(n.getUTCDate(), 2) +
    "T" +
    pad(n.getUTCHours(), 2) +
    pad(n.getUTCMinutes(), 2) +
    pad(n.getUTCSeconds(), 2);
  _slugCounter += 1;
  return `${ts}-${_sessionShortId}-${pad(_slugCounter, 4)}`;
}

/**
 * Pre-mint URIs for every template in a serialized annotation, keyed by
 * localKey. The orchestrator substitutes these into bodies before any
 * network I/O — no post-POST @id-fixup, no waiting on Location headers.
 *
 * Container paths come from the existing solid.js constants and are
 * appended to the user's storage root, which we resolve once. Caller is
 * responsible for ensuring containers exist (see _ensureContainers).
 */
async function _mintUrisFor(templates) {
  const storage = await getSolidStorage();
  if (!storage) throw new Error("Couldn't resolve Solid storage root.");
  const containers = {
    "mao:Selection": storage + selectionContainer,
    "mao:Extract": storage + extractContainer,
    "mao:MusicalMaterial": storage + musicalMaterialContainer,
    "oa:Annotation": storage + annotationContainer,
  };
  const localToUri = {};
  for (const t of templates) {
    const root = containers[t.kind];
    if (!root) throw new Error("Unknown resource kind: " + t.kind);
    localToUri[t.localKey] = root + _mintSlug();
  }
  return localToUri;
}

/**
 * PUT a body to its caller-minted URI, retrying once on a 404-shaped
 * failure with a fresh container check. Replaces the older POST path
 * which required a follow-up @id-fixup PUT (eliminated).
 */
async function _safePutResource(uri, body, label) {
  try {
    await createResourceAtUri(uri, body);
    return;
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    if (!/\b404\b/.test(msg)) throw err;
    // Container may have disappeared between sessions — invalidate, re-
    // establish, retry once.
    console.warn(
      "[annotation/v6] PUT 404 for " + label + "; re-establishing containers and retrying once.",
    );
    _invalidateContainersCache();
    await _ensureContainers();
    await createResourceAtUri(uri, body);
  }
}

/**
 * Recursively sort object keys so JSON.stringify produces a stable
 * representation regardless of property-insertion order. Arrays are
 * preserved as-is (order is semantic in JSON-LD).
 */
function _canonicalize(node) {
  if (Array.isArray(node)) return node.map(_canonicalize);
  if (node && typeof node === "object") {
    const out = {};
    for (const k of Object.keys(node).sort()) {
      out[k] = _canonicalize(node[k]);
    }
    return out;
  }
  return node;
}

/**
 * 32-bit FNV-1a hash, returned as 8 hex chars. We're detecting whether a
 * resource body changed between updates — collision-resistance for ~30
 * resources is more than enough, and we avoid the Promise overhead of
 * crypto.subtle.digest in a hot loop.
 */
function _hashBody(body) {
  const s = JSON.stringify(_canonicalize(body));
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    // FNV-1a 32-bit prime multiplication via shifts.
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * Group templates into topological levels. Level 0 = no in-set deps. Level
 * N templates depend only on templates at level < N. Templates within a
 * level are mutually independent and can be processed in parallel.
 */
function _topoLevels(templates) {
  const byKey = new Map(templates.map((t) => [t.localKey, t]));
  const level = new Map();
  function depthOf(key) {
    if (level.has(key)) return level.get(key);
    const t = byKey.get(key);
    if (!t) return -1; // External / unknown — pretend it's resolved.
    let d = 0;
    for (const dep of t.dependsOn || []) {
      d = Math.max(d, depthOf(dep) + 1);
    }
    level.set(key, d);
    return d;
  }
  const buckets = [];
  for (const t of templates) {
    const d = depthOf(t.localKey);
    while (buckets.length <= d) buckets.push([]);
    buckets[d].push(t);
  }
  return buckets;
}

/**
 * For a template (typically an OA), return the set of audio URIs it
 * transitively targets. The dependsOn list conflates two kinds of edge:
 * "target-of" (track OA → its Selection; group OA → its track OAs) and
 * "structural-anchor" (group/comparison/top OA → extract or mm, to scope
 * the annotation). Only target-of edges carry audio identity, so we
 * exclude extract/mm from the recursive walk. Top-level OAs that target
 * MM directly (no roots) fall back to "all audios in the annotation",
 * which is what MM/Extract themselves are about.
 */
function _audioSetFor(localKey, byKey, fileToAudioUri, memo = new Map()) {
  if (memo.has(localKey)) return memo.get(localKey);
  if (localKey.startsWith("sel/")) {
    const file = localKey.slice("sel/".length);
    const audio = fileToAudioUri[file];
    const out = audio ? new Set([audio]) : new Set();
    memo.set(localKey, out);
    return out;
  }
  if (localKey === "extract" || localKey === "mm") {
    const all = new Set();
    for (const a of Object.values(fileToAudioUri)) if (a) all.add(a);
    memo.set(localKey, all);
    return all;
  }
  const t = byKey.get(localKey);
  if (!t) {
    const empty = new Set();
    memo.set(localKey, empty);
    return empty;
  }
  const out = new Set();
  for (const dep of t.dependsOn || []) {
    if (dep === "extract" || dep === "mm") continue;
    for (const a of _audioSetFor(dep, byKey, fileToAudioUri, memo)) out.add(a);
  }
  // Top-level OA targeting MM directly (no OA roots) has only structural
  // deps — fall back to all audios.
  if (out.size === 0) {
    for (const a of Object.values(fileToAudioUri)) if (a) out.add(a);
  }
  memo.set(localKey, out);
  return out;
}

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

  const fileToAudioUri = _resolveAudioUris(ann);

  await _ensureContainers();
  const uniqueAudioUris = [...new Set(Object.values(fileToAudioUri))];
  const discoveryByAudio = {};
  for (const audioUri of uniqueAudioUris) {
    discoveryByAudio[audioUri] = await _ensureDiscoveryFor(audioUri);
  }

  const { templates } = adapter.serialize(ann, {
    resolveAudioUri: (f) => fileToAudioUri[f],
  });

  const byKey = new Map(templates.map((t) => [t.localKey, t]));
  const audioSetMemo = new Map();
  const levels = _topoLevels(templates);

  // Mint every resource URI up front. From here on we don't need to wait
  // on Location headers or do post-POST @id-fixup PUTs: every body can be
  // substituted with the final URIs before any I/O fires.
  const localToUri = await _mintUrisFor(templates);

  const total = templates.length + Object.keys(discoveryByAudio).length;
  let step = 0;
  onProgress(step, total, null);
  const localToHash = {};

  for (const level of levels) {
    const results = await Promise.all(
      level.map(async (t) => {
        const body = _substitutePlaceholders(t.body, localToUri);
        const audioSet = _audioSetFor(t.localKey, byKey, fileToAudioUri, audioSetMemo);
        _decorateResource(body, t, fileToAudioUri, discoveryByAudio, audioSet);
        await _safePutResource(localToUri[t.localKey], body, t.localKey);
        return { template: t, hash: _hashBody(body) };
      }),
    );
    for (const r of results) {
      localToHash[r.template.localKey] = r.hash;
      onProgress(++step, total, _labelForKind(r.template.kind));
    }
  }

  await _patchDiscoveryResources(
    templates,
    localToUri,
    fileToAudioUri,
    discoveryByAudio,
    audioSetMemo,
    byKey,
    () => onProgress(++step, total, "Discovery"),
  );

  state.markPosted(annId, localToUri, localToHash);
  if (loadedAlignmentJSON) commitAnnotationsToAlignment(loadedAlignmentJSON);

  return localToUri;
}

function _resolveAudioUris(ann) {
  // Resolve each selected recording's Linked Data URI. Bail loudly if any
  // are missing — without these we can't anchor frbr:parts. URIs are
  // normalised through the URL constructor so unencoded spaces and special
  // chars in path components get percent-encoded; otherwise the JSON-LD
  // parser on the Solid server rejects them as invalid IRIs.
  const out = {};
  for (const t of ann.targets) {
    const audioUri = getAudioLinkedDataUri(t.file);
    if (!audioUri || !/^https?:\/\//i.test(audioUri)) {
      throw new Error(
        `${t.file} has no Linked Data URI. Set one in Manage files → Linked Data URIs first.`,
      );
    }
    out[t.file] = _normaliseIri(audioUri);
  }
  return out;
}

function _labelForKind(kind) {
  switch (kind) {
    case "mao:Selection": return "Selection";
    case "mao:Extract": return "Extract";
    case "mao:MusicalMaterial": return "MusicalMaterial";
    case "oa:Annotation": return "Annotation";
    default: return kind;
  }
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


/**
 * Decorate a resource body with schema:about (the audio URIs it's about)
 * and schema:includedInDataCatalog (the discovery resource of each such
 * audio). MAO resources span the full annotation; OAs target subsets, so
 * the audio set is computed per-template via _audioSetFor.
 */
function _decorateResource(body, template, fileToAudioUri, discoveryByAudio, audioSet) {
  if (template.kind === "mao:Selection") {
    // Selection's audio is unambiguous — adapter already set schema:about.
    const file = template.localKey.substring("sel/".length);
    const audioUri = fileToAudioUri[file];
    if (audioUri) {
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
    return;
  }
  if (template.kind === "oa:Annotation") {
    const audios = [...audioSet].filter(Boolean);
    if (audios.length === 0) return;
    body[nsp.SCHEMA + "about"] = audios.map((u) => ({ "@id": u }));
    body[nsp.SCHEMA + "includedInDataCatalog"] = audios
      .map((u) => discoveryByAudio[u])
      .filter(Boolean)
      .map((u) => ({ "@id": u }));
  }
}

/**
 * Patch each audio's discovery resource with dataset entries for every
 * resource it covers: MM + Extract + that audio's Selection + every OA
 * that transitively targets that audio.
 */
async function _patchDiscoveryResources(
  templates,
  localToUri,
  fileToAudioUri,
  discoveryByAudio,
  audioSetMemo,
  byKey,
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
  // Group OA URIs by every audio they target.
  const audioToOaUris = {};
  for (const t of templates) {
    if (t.kind !== "oa:Annotation") continue;
    const uri = localToUri[t.localKey];
    if (!uri) continue;
    const audios = _audioSetFor(t.localKey, byKey, fileToAudioUri, audioSetMemo);
    for (const audio of audios) {
      if (!audio) continue;
      (audioToOaUris[audio] = audioToOaUris[audio] || []).push(uri);
    }
  }

  const datasetPath =
    "/" +
    nsp.SCHEMA.replaceAll("~", "~0").replaceAll("/", "~1") +
    "dataset/-";

  const allAudios = new Set([
    ...Object.keys(audioToSelUris),
    ...Object.keys(audioToOaUris),
  ]);

  // Patch each audio's discovery in parallel — they don't conflict.
  await Promise.all(
    [...allAudios].map(async (audioUri) => {
      const discoveryUri = discoveryByAudio[audioUri];
      if (!discoveryUri) return;
      const selUris = audioToSelUris[audioUri] || [];
      const oaUris = audioToOaUris[audioUri] || [];
      const ops = [
        _datasetOp(datasetPath, mmUri, nsp.MAO + "MusicalMaterial"),
        _datasetOp(datasetPath, extractUri, nsp.MAO + "Extract"),
        ...selUris.map((s) => _datasetOp(datasetPath, s, nsp.MAO + "Selection")),
        ...oaUris.map((o) => _datasetOp(datasetPath, o, nsp.OA + "Annotation")),
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
        // Soft-invalidate so the next run re-establishes (in case the resource
        // disappeared between sessions).
        _invalidateDiscoveryFor(audioUri);
      }
      if (typeof onAudioPatched === "function") onAudioPatched();
    }),
  );
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

  const fileToAudioUri = _resolveAudioUris(ann);
  const oldHashes = ann.lastPostedHashes || {};

  await _ensureContainers();
  const uniqueAudioUris = [...new Set(Object.values(fileToAudioUri))];
  const discoveryByAudio = {};
  for (const audioUri of uniqueAudioUris) {
    try {
      discoveryByAudio[audioUri] = await _ensureDiscoveryFor(audioUri);
    } catch (err) {
      console.warn("[annotation/v6] discovery establish failed; skipping", audioUri, err);
    }
  }
  // Audios that were involved before but aren't anymore (detached files)
  // — we still need to touch their discovery resource to remove stale entries.
  const oldFileToAudioUri = _oldFileToAudioUri(ann.lastPostedUris);
  for (const oldAudio of Object.values(oldFileToAudioUri)) {
    if (!discoveryByAudio[oldAudio]) {
      try {
        discoveryByAudio[oldAudio] = await _ensureDiscoveryFor(oldAudio);
      } catch (_) { /* leave gap; reconcile will skip */ }
    }
  }

  // Generate new templates from current state.
  const { templates } = adapter.serialize(ann, {
    resolveAudioUri: (f) => fileToAudioUri[f],
  });

  const byKey = new Map(templates.map((t) => [t.localKey, t]));
  const audioSetMemo = new Map();

  // Delta vs lastPostedUris.
  const oldKeys = new Set(Object.keys(ann.lastPostedUris));
  const newKeys = new Set(templates.map((t) => t.localKey));
  const toDeleteKeys = [...oldKeys].filter((k) => !newKeys.has(k));

  // Topo-level grouping: within each level, PUTs (existing) and PUTs-to-
  // new-URI (newly-created) run in parallel. All URIs are known up front
  // — existing ones from lastPostedUris, new ones minted client-side —
  // so substitution can run in any order without waiting on POSTs.
  const levels = _topoLevels(templates);
  const localToUri = { ...ann.lastPostedUris };
  // Mint URIs for templates that don't yet have one. The minted URIs are
  // also what we'll consider "created" for discovery reconciliation.
  const freshTemplates = templates.filter((t) => !oldKeys.has(t.localKey));
  if (freshTemplates.length > 0) {
    const fresh = await _mintUrisFor(freshTemplates);
    for (const k of Object.keys(fresh)) localToUri[k] = fresh[k];
  }
  const localToHash = {};
  const createdUris = [];
  const total =
    templates.length + toDeleteKeys.length + Object.keys(discoveryByAudio).length;
  let step = 0;
  let skipped = 0;
  onProgress(step, total, null);

  for (const level of levels) {
    const results = await Promise.all(
      level.map(async (t) => {
        const body = _substitutePlaceholders(t.body, localToUri);
        const audioSet = _audioSetFor(t.localKey, byKey, fileToAudioUri, audioSetMemo);
        _decorateResource(body, t, fileToAudioUri, discoveryByAudio, audioSet);
        const newHash = _hashBody(body);
        if (oldKeys.has(t.localKey)) {
          // Existing resource. Skip the PUT if content hash matches.
          if (oldHashes[t.localKey] === newHash) {
            return { template: t, uri: localToUri[t.localKey], hash: newHash, skipped: true };
          }
          try {
            await _safelyReplaceResource(localToUri[t.localKey], body);
            return { template: t, uri: localToUri[t.localKey], hash: newHash, skipped: false };
          } catch (err) {
            // If the resource disappeared from the pod, fall back to a
            // fresh PUT-to-URI under a newly-minted URI (so creator /
            // created / provenance are set correctly).
            if (_isMissingResourceError(err)) {
              console.warn(
                "[annotation/v6] " + t.localKey + " missing on pod; re-creating at a fresh URI.",
              );
              const replacementUri = (await _mintUrisFor([t]))[t.localKey];
              await _safePutResource(replacementUri, body, t.localKey);
              return { template: t, uri: replacementUri, hash: newHash, skipped: false, created: true };
            }
            throw err;
          }
        }
        // New resource — PUT at its pre-minted URI.
        await _safePutResource(localToUri[t.localKey], body, t.localKey);
        return { template: t, uri: localToUri[t.localKey], hash: newHash, skipped: false, created: true };
      }),
    );
    for (const r of results) {
      localToUri[r.template.localKey] = r.uri;
      localToHash[r.template.localKey] = r.hash;
      if (r.created) createdUris.push(r.uri);
      if (r.skipped) skipped++;
      onProgress(++step, total, _labelForKind(r.template.kind));
    }
  }

  // DELETE removed resources, in parallel.
  const deletedUris = [];
  await Promise.all(
    toDeleteKeys.map(async (key) => {
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
      onProgress(++step, total, "Delete");
    }),
  );

  // Reconcile each audio's discovery: add entries for newly-created URIs,
  // remove entries pointing at deleted ones.
  await _reconcileDiscoveryResources(
    templates,
    byKey,
    audioSetMemo,
    discoveryByAudio,
    fileToAudioUri,
    localToUri,
    createdUris,
    deletedUris,
    () => onProgress(++step, total, "Discovery"),
  );

  if (skipped > 0) {
    console.info(
      "[annotation/v6] update skipped " + skipped + " unchanged resource(s).",
    );
  }

  state.markPosted(annId, localToUri, localToHash);
  if (loadedAlignmentJSON) commitAnnotationsToAlignment(loadedAlignmentJSON);
  return localToUri;
}

function _isMissingResourceError(err) {
  const msg = err && err.message ? err.message : String(err);
  return /\b404\b/.test(msg) || /\b410\b/.test(msg);
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
  templates,
  byKey,
  audioSetMemo,
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

  // Map created Selection URIs to their audio (one-to-one).
  const selUriToAudio = {};
  for (const [key, uri] of Object.entries(newUris)) {
    if (key.startsWith("sel/")) {
      const file = key.slice("sel/".length);
      const audio = fileToAudioUri[file];
      if (audio) selUriToAudio[uri] = audio;
    }
  }
  // Map created OA URIs to the set of audios they cover (potentially many).
  const oaUriToAudios = new Map();
  for (const t of templates) {
    if (t.kind !== "oa:Annotation") continue;
    const uri = newUris[t.localKey];
    if (!uri) continue;
    oaUriToAudios.set(
      uri,
      _audioSetFor(t.localKey, byKey, fileToAudioUri, audioSetMemo),
    );
  }
  const createdSet = new Set(createdUris);
  const deletedSet = new Set(deletedUris);

  // Reconcile each audio in parallel.
  await Promise.all(
    Object.entries(discoveryByAudio).map(async ([audioUri, discoveryUri]) => {
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
        } else if (oaUriToAudios.has(uri) && oaUriToAudios.get(uri).has(audioUri)) {
          adds.push({ uri, type: nsp.OA + "Annotation" });
        }
      }
      if (adds.length === 0 && deletedSet.size === 0) {
        if (typeof onAudioReconciled === "function") onAudioReconciled();
        return;
      }
      try {
        await _patchDiscoveryReconcile(discoveryUri, adds, deletedSet);
      } catch (err) {
        console.warn(
          "[annotation/v6] discovery reconcile failed for " + discoveryUri,
          err,
        );
        _invalidateDiscoveryFor(audioUri);
      }
      if (typeof onAudioReconciled === "function") onAudioReconciled();
    }),
  );
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
