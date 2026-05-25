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
import {
  getAudioLinkedDataUri,
  getClosestAlignmentIx,
  getCorrespondingTime,
  getReferenceAudioIx,
  loadedAlignmentJSON,
  meiUri,
  scoreAlignment,
  tk,
} from "../listen.js";

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
  // Discovery resources are keyed by encoded URI. For raw.githubusercontent.com
  // URLs the same blob is reachable with or without `/refs/heads/`, and we
  // don't know which form mei-friend (or another writer) used. Try the
  // normalised (short) form first, then any equivalent forms — return the
  // first one that exists.
  const discovery = await _readFirstDiscovery(_iriVariantsForLookup(audioUri));
  if (!discovery) return [];
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
  // Score annotations live in the discovery resource keyed by the
  // reference MEI URI — mei-friend posts MAO stacks there. Include it
  // alongside the audios so score-only annotations surface in the same
  // list, marked with a "score" pill by the result-row renderer.
  const scoreUri = (typeof meiUri === "string" && meiUri) ? _normaliseIri(meiUri) : null;
  if (audios.length === 0 && !scoreUri) return [];

  const perSource = await Promise.all([
    ...audios.map(async (audioUri) => {
      try {
        const entries = await listAnnotationsForAudio(audioUri);
        return { kind: "audio", file: reverseMap.get(audioUri), entries };
      } catch (_) {
        return { kind: "audio", file: reverseMap.get(audioUri), entries: [] };
      }
    }),
    scoreUri
      ? (async () => {
          try {
            const entries = await listAnnotationsForAudio(scoreUri);
            return { kind: "score", file: null, entries };
          } catch (_) {
            return { kind: "score", file: null, entries: [] };
          }
        })()
      : Promise.resolve(null),
  ]);

  // De-dupe by mmUri; record which loaded files each annotation covers
  // and whether it surfaced from the score's discovery resource.
  const byMm = new Map();
  for (const result of perSource) {
    if (!result) continue;
    for (const entry of result.entries) {
      if (!byMm.has(entry.mmUri)) {
        byMm.set(entry.mmUri, {
          ...entry,
          coveredFiles: new Set(),
          aboutsScore: false,
        });
      }
      const agg = byMm.get(entry.mmUri);
      if (result.kind === "audio" && result.file) agg.coveredFiles.add(result.file);
      if (result.kind === "score") agg.aboutsScore = true;
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

  // De-dup: if an annotation with this MM URI is already in local state,
  // just make it active and return its id — skips the chain fetch entirely
  // and avoids ending up with two copies in memory.
  const existing = state.getAll().find(
    (a) => a.lastPostedUris && a.lastPostedUris.mm === mmUri,
  );
  if (existing) {
    state.setActiveAnnotation(existing.id);
    console.info("[annotation/v6] already loaded; switched to existing copy:", mmUri);
    return existing.id;
  }

  const { graph, selUris, uniqueAudios } = await _fetchChainAsGraph(mmUri, onProgress);

  // Branch on Selection shape: if every Selection's schema:about points
  // at the reference MEI URI, this is a score annotation. Otherwise the
  // existing audio-annotation path applies.
  const localUriToFile = _buildReverseAudioMap();
  const normalisedMeiUri = (typeof meiUri === "string" && meiUri) ? _normaliseIri(meiUri) : null;
  const isScoreAnnotation =
    !!normalisedMeiUri &&
    uniqueAudios.length > 0 &&
    uniqueAudios.every((u) => u === normalisedMeiUri);

  if (isScoreAnnotation) {
    // Score annotations from mei-friend reference MEI element IDs in
    // frbr:part. We project those onto every currently-loaded recording
    // via Verovio's timemap + the alignment grids, and synthesize an
    // audio-shaped chain in memory so adapter.deserialize stays simple.
    onProgress("Projecting score regions onto loaded recordings");
    _rewriteScoreChainAsAudio(graph, selUris, localUriToFile);
  } else {
    // Mixed (score + audio) or audio-only annotation: refuse to load if
    // any audio Selection's URI isn't locally loaded. Selections whose
    // schema:about IS the reference MEI URI are valid as-is (they round-
    // trip via preservedSelections), so we exclude them from the missing
    // check rather than treating the MEI URI as an absent recording.
    const missing = uniqueAudios.filter(
      (u) => u !== normalisedMeiUri && !localUriToFile.has(u),
    );
    if (missing.length > 0) {
      throw new Error(
        "Refusing to load: this annotation references " +
          missing.length +
          " recording(s) that aren't loaded locally:\n\n" +
          missing.map((m) => "  • " + m).join("\n") +
          "\n\nLoad these audio files (and set their Linked Data URIs in Manage files) before loading the annotation.",
      );
    }
  }

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

  if (isScoreAnnotation) {
    // The projection synthesised audio Selections in-memory; their
    // `local:score-projected/...` URIs landed in lastPostedUris via the
    // normal deserialize indexing. On the next Update we want those
    // treated as NEW resources to mint at fresh pod URIs (PUT-replacing
    // a local: URI would otherwise fail in solid.fetch).
    //
    // The original score Selections are preserved separately, via
    // annotation.preservedSelections (populated by the deserializer
    // when a Selection's schema:about doesn't resolve to a loaded
    // audio). The Update path's adapter.serialize appends them back
    // into Extract.frbr:embodiment so the chain stays additive: the
    // score Selections + their mei-friend OAs keep their place, the
    // user's newly-created audio Selections + OAs get added.
    annotation.lastPostedUris = {
      mm: annotation.lastPostedUris.mm,
      extract: annotation.lastPostedUris.extract,
    };
  }

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
 * If `_fetchChainAsGraph` fails with a 404 on the MM itself, we treat the
 * entry as a stale discovery reference (an earlier delete left dataset
 * pointers but the underlying resources are gone) and fall through to a
 * cleanup pass: walk the discovery resources of the hinted audios (or all
 * locally-loaded audios as fallback) and drop dataset entries whose
 * schema:url matches this MM URI.
 *
 * @param {string} mmUri
 * @param {object} [opts]
 * @param {(label: string) => void} [opts.onProgress]
 * @param {string[]} [opts.coveredFiles] — local file keys whose discovery resources
 *   listed this annotation (from the load modal's per-row metadata). When the
 *   chain is reachable, this hint is unused; when it isn't (stale case), it
 *   scopes the cleanup pass to just those audios.
 * @returns {Promise<{ deletedUris: string[], failedUris: string[], stale?: boolean, cleanedAudios?: number }>}
 */
export async function deleteAnnotationFromPod(mmUri, opts = {}) {
  const onProgress = opts.onProgress || (() => {});
  const session = solid.getDefaultSession();
  if (!session || !session.info || !session.info.isLoggedIn) {
    throw new Error("Sign in to your Solid pod first.");
  }

  let graph, uniqueAudios;
  try {
    ({ graph, uniqueAudios } = await _fetchChainAsGraph(mmUri, onProgress));
  } catch (err) {
    // Chain unreachable. If it's a 404 anywhere in the walk, switch to
    // stale-cleanup mode — the entry is from an earlier partial-delete
    // and we can at least prune the discovery references that surfaced it.
    if (_isMissingResourceError(err)) {
      return _cleanupStaleDiscoveryRefs(mmUri, opts, onProgress);
    }
    throw err;
  }

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
 * Stale-entry cleanup branch of deleteAnnotationFromPod. The MM URI 404s
 * but it's still listed in one or more discovery resources, so a previous
 * delete must have partially completed. Walk the candidate audios'
 * discovery resources and prune dataset entries whose schema:url equals
 * the dead MM URI. Conservatively scoped: we only remove entries matching
 * this exact URI — never delete sibling dataset entries that might be
 * other orphan Extract / Selection / OA resources. (A wider sweep is in
 * the roadmap.)
 */
async function _cleanupStaleDiscoveryRefs(mmUri, opts, onProgress) {
  // Resolve which audios to scan. Prefer the hint from the UI (covered
  // files from the per-row metadata) so we don't touch unrelated audios.
  // Fallback: every locally-loaded recording.
  const reverseMap = _buildReverseAudioMap();
  let audioUris;
  if (Array.isArray(opts.coveredFiles) && opts.coveredFiles.length > 0) {
    const fileToAudio = new Map();
    for (const [audio, file] of reverseMap.entries()) fileToAudio.set(file, audio);
    audioUris = opts.coveredFiles
      .map((f) => fileToAudio.get(f))
      .filter(Boolean);
  } else {
    audioUris = [...reverseMap.keys()];
  }

  if (audioUris.length === 0) {
    return { deletedUris: [], failedUris: [], stale: true, cleanedAudios: 0 };
  }

  onProgress("Removing stale references from " + audioUris.length + " discovery resource(s)");
  const deadSet = new Set([mmUri]);
  let cleanedAudios = 0;
  await Promise.all(
    audioUris.map(async (audioUri) => {
      try {
        const cleaned = await _purgeDeletedFromDiscovery(audioUri, deadSet);
        if (cleaned) cleanedAudios++;
      } catch (err) {
        console.warn(
          "[annotation/v6] stale-ref cleanup failed for " + audioUri,
          err,
        );
      }
    }),
  );

  // Drop any local copy that points at this dead MM, just in case.
  const local = state.getAll().find((a) => a.lastPostedUris && a.lastPostedUris.mm === mmUri);
  if (local) state.removeAnnotation(local.id);

  return { deletedUris: [], failedUris: [], stale: true, cleanedAudios };
}

function _isMissingResourceError(err) {
  const msg = err && err.message ? err.message : String(err);
  return /\b404\b/.test(msg) || /\b410\b/.test(msg);
}

/**
 * Walk MM → Extract → Selections → (per-audio-discovery) OAs and return
 * the assembled graph plus a few intermediate values callers also use.
 * Shared by load and delete.
 */
/**
 * Rewrite a score-annotation chain into an audio-annotation chain in
 * place. Replaces each score-Selection (one whose schema:about is the
 * reference MEI URI) with one synthetic Selection per locally-loaded
 * recording. Each new Selection's frbr:part list is computed by:
 *   1. Parsing MEI element IDs from the original Selection's frbr:part
 *      (each part being a URI like `${meiUri}#elementId`).
 *   2. Asking Verovio for each element's MIDI onset / offset.
 *   3. Mapping those ref-audio times to the alignment grid for the
 *      reference recording, then projecting to every other loaded
 *      recording via getCorrespondingTime.
 *
 * The original score Selection URIs are removed from the graph and the
 * Extract's frbr:embodiment list is replaced. After this rewrite the
 * graph looks like a normal audio annotation, so the rest of the load
 * path (adapter.deserialize) handles it unchanged. Trade-off: a future
 * Update of this annotation will post audio-Selections, losing the
 * original score reference. That matches the legacy projection-on-load
 * behaviour.
 */
function _rewriteScoreChainAsAudio(graph, scoreSelUris, audioUriToFile) {
  const refFile = (typeof getReferenceAudioIx === "function") ? getReferenceAudioIx() : null;
  if (!refFile) {
    throw new Error("No reference recording is set; cannot project score regions onto audio.");
  }
  if (!tk || typeof tk.getTimesForElement !== "function") {
    throw new Error("Score-rendering toolkit not ready; cannot project score regions.");
  }
  if (!scoreAlignment) {
    throw new Error("Score alignment is missing from the loaded session; cannot project.");
  }
  const audios = [...audioUriToFile.entries()]; // [[audioUri, file], ...]
  if (audios.length === 0) {
    throw new Error("No audio recordings are loaded; cannot project score regions.");
  }

  // Replacement Selection URIs are synthesized so they're stable in the
  // graph but don't collide with anything else; they're never used as
  // identifiers on the pod (this rewrite is purely in-memory).
  const newSelUris = [];
  const onsetTimes = scoreAlignment.synth_onset || scoreAlignment.score_onset;
  const offsetTimes = scoreAlignment.synth_offset || scoreAlignment.score_offset;
  if (!Array.isArray(onsetTimes) || !Array.isArray(offsetTimes)) {
    throw new Error("Score alignment doesn't expose synth_onset/synth_offset.");
  }

  // Pull the original score Selections so we can mine their frbr:part lists.
  const origScoreSels = scoreSelUris.map((u) => graph[u]).filter(Boolean);
  if (origScoreSels.length === 0) {
    throw new Error("No score Selections found in the fetched chain.");
  }

  // For each loaded recording, build a synthetic Selection with ONE
  // projected region spanning every MEI element's onset/offset in this
  // annotation. mei-friend annotations that mark a phrase of N notes
  // would otherwise come through as N adjacent micro-regions, which
  // reads as noise rather than as the intended span. We collapse to
  // [min(onsets), max(offsets)] across every part of every Selection;
  // if no element projects successfully, the Selection has zero parts
  // (whole-audio semantic, matching the V6 no-regions case).
  for (const [audioUri, file] of audios) {
    const synthUri = "local:score-projected/" + encodeURIComponent(file);
    let minStart = Infinity;
    let maxEnd = -Infinity;
    for (const origSel of origScoreSels) {
      const origParts = origSel[nsp.FRBR + "part"] || [];
      for (const p of origParts) {
        const partUri = p && p["@id"];
        if (!partUri) continue;
        const hashIx = partUri.lastIndexOf("#");
        const elementId = hashIx >= 0 ? partUri.slice(hashIx + 1) : null;
        const times = _projectMeiElementToTimes(
          elementId, file, onsetTimes, offsetTimes,
        );
        if (!times) continue;
        if (times.start < minStart) minStart = times.start;
        if (times.end > maxEnd) maxEnd = times.end;
      }
    }
    const parts =
      Number.isFinite(minStart) && Number.isFinite(maxEnd) && maxEnd >= minStart
        ? [{ "@id": audioUri + "#t=" + _fmtSec(minStart) + "," + _fmtSec(maxEnd) }]
        : [];
    graph[synthUri] = {
      "@id": synthUri,
      "@type": [nsp.MAO + "Selection", nsp.SCHEMA + "Dataset"],
      [nsp.SCHEMA + "about"]: [{ "@id": audioUri }],
      [nsp.FRBR + "part"]: parts,
    };
    newSelUris.push(synthUri);
  }

  // ADDITIVE: keep the original score Selections in the Extract's
  // embodiment list. The deserializer recognises them as preserved (its
  // resolveFileFromAudioUri returns null for the score's MEI URI) and
  // they round-trip through ann.preservedSelections so the next Update
  // keeps them in the chain. New audio Selections are appended after
  // the originals.
  let extractUri = null;
  for (const uri of Object.keys(graph)) {
    const node = graph[uri];
    const types = _asArray(node && node["@type"]);
    if (types.includes(nsp.MAO + "Extract")) {
      extractUri = uri;
      break;
    }
  }
  if (extractUri) {
    const existing = _asArray(graph[extractUri][nsp.FRBR + "embodiment"]);
    graph[extractUri][nsp.FRBR + "embodiment"] = [
      ...existing,
      ...newSelUris.map((u) => ({ "@id": u })),
    ];
  }
  // Original score Selections + their referencing OAs stay on the pod
  // untouched. Their body text isn't surfaced in V6's drawer (the
  // existing OAs target the score Selection, not an audio Selection,
  // so V6's track-OA heuristic doesn't pick them up). The user can
  // still add new OAs in V6 that target the audio Selections; those
  // are pure additions to the chain when the user clicks Update.
}

/**
 * Project a single MEI element ID to an audio media-fragment URI on the
 * given audio. Falls back to a zero-length fragment at 0s if Verovio
 * can't resolve the element (so the row still renders rather than
 * dropping silently). Uses the first MIDI expansion.
 */
/**
 * Project a single MEI element ID onto an audio file's timeline.
 * Returns `{ start, end }` in seconds, or null if Verovio can't resolve
 * the element. The caller is responsible for collapsing multiple
 * elements' spans if it wants a single coalesced region.
 */
function _projectMeiElementToTimes(elementId, file, onsetTimes, offsetTimes) {
  if (!elementId) return null;
  let times;
  try { times = tk.getTimesForElement(elementId); } catch (_) { times = null; }
  if (!times || !Array.isArray(times.tstampOn) || times.tstampOn.length === 0) {
    return null;
  }
  // Verovio returns milliseconds; the alignment tables are in seconds.
  const onsetS = times.tstampOn[0] / 1000;
  const offsetS =
    Array.isArray(times.tstampOff) && times.tstampOff.length > 0
      ? times.tstampOff[0] / 1000
      : onsetS;
  // Score time → corresponding time on the REFERENCE recording.
  const refStart = scoreAlignment.ref_onset[_closestIx(onsetS, onsetTimes)];
  const refEnd = scoreAlignment.ref_offset[_closestIx(offsetS, offsetTimes)];
  const refFile = getReferenceAudioIx();
  if (file === refFile) return { start: refStart, end: refEnd };
  // Ref → this file: ref-time → alignment index on the ref grid →
  // corresponding time on this file's grid.
  try {
    const ixStart = getClosestAlignmentIx(refStart, refFile);
    const ixEnd = getClosestAlignmentIx(refEnd, refFile);
    const a = getCorrespondingTime(file, ixStart);
    const b = getCorrespondingTime(file, ixEnd);
    if (Number.isFinite(a) && Number.isFinite(b)) return { start: a, end: b };
  } catch (_) { /* fall through */ }
  return { start: refStart, end: refEnd };
}

function _closestIx(t, table) {
  if (!Array.isArray(table) || table.length === 0) return 0;
  let bestIx = 0;
  let bestDist = Math.abs(table[0] - t);
  for (let i = 1; i < table.length; i++) {
    const d = Math.abs(table[i] - t);
    if (d < bestDist) { bestDist = d; bestIx = i; }
  }
  return bestIx;
}

function _fmtSec(t) {
  return (Math.round(t * 1000) / 1000).toString();
}

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
 * Returns true if at least one entry was removed (and the PUT fired),
 * false otherwise — callers in the stale-cleanup path use this to count
 * how many discoveries were actually touched.
 */
async function _purgeDeletedFromDiscovery(audioUri, deletedSet) {
  const discoveryUri = await _discoveryUriFor(audioUri);
  if (!discoveryUri) return false;
  const resp = await solid.fetch(discoveryUri, {
    headers: { Accept: "application/ld+json" },
  });
  if (!resp.ok) return false; // no discovery — nothing to clean
  const etag = resp.headers.get("ETag");
  const body = await resp.json();
  const datasetKey = nsp.SCHEMA + "dataset";
  let dataset = _asArray(body[datasetKey]);
  const before = dataset.length;
  dataset = dataset.filter((entry) => {
    const url = _firstId(_asArray(entry?.[nsp.SCHEMA + "url"]));
    return !url || !deletedSet.has(url);
  });
  if (dataset.length === before) return false; // nothing to remove
  body[datasetKey] = dataset;
  await solid.fetch(discoveryUri, {
    method: "PUT",
    headers: {
      "Content-Type": "application/ld+json",
      ...(etag ? { "If-Match": etag } : {}),
    },
    body: JSON.stringify(body),
  });
  return true;
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
  const raw = await resp.json();
  // JSON-LD expand so keys are always full IRIs. Our own resources are
  // already expanded (POSTed that way), but third-party writers like
  // mei-friend ship compact form with a `@context`, which our key-by-
  // full-IRI deserialize wouldn't match. Expansion is idempotent on
  // already-expanded input. If expansion fails (no context, malformed,
  // unreachable remote context, …) we fall through to the raw body.
  let expanded;
  try {
    if (typeof globalThis.jsonld !== "undefined") {
      expanded = await globalThis.jsonld.expand(raw);
    }
  } catch (err) {
    console.warn("[annotation/v6] JSON-LD expansion failed for " + uri + "; using raw body.", err);
  }
  if (!Array.isArray(expanded) || expanded.length === 0) return raw;
  // Pick the node whose @id matches the URI we asked for — that's the
  // resource's own self-description. If we can't find it, fall back to
  // common self-reference forms ("" / "./") used by some pods, or
  // (as a last resort) the first entry.
  return (
    expanded.find((e) => e["@id"] === uri) ||
    expanded.find((e) => e["@id"] === "" || e["@id"] === "./") ||
    expanded[0]
  );
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

/**
 * Return URI variants to try when reading a discovery resource — they
 * all reference the same blob but differ in surface form. Order: most-
 * canonical first. For raw.githubusercontent.com URLs that means
 * branch-shorthand before the `/refs/heads/` long form. Non-GH URIs
 * round-trip to a single-entry array.
 */
function _iriVariantsForLookup(uri) {
  const normalised = _normaliseIri(uri);
  const variants = [normalised];
  // Inflate the long form for GH raw URLs whose normalised form is the
  // short version. Match `…/<owner>/<repo>/<ref>/<path>` and inject
  // `refs/heads/` only when the ref segment isn't already a SHA-like
  // hash (which would be a commit hash, not a branch).
  const m = normalised.match(
    /^(https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/)([^/]+)(\/.+)$/,
  );
  if (m && !/^[0-9a-f]{7,40}$/i.test(m[2])) {
    variants.push(`${m[1]}refs/heads/${m[2]}${m[3]}`);
  }
  return variants;
}

/**
 * Try `_discoveryUriFor` for each URI variant in turn; return the
 * first one that successfully GETs as JSON-LD. Returns null if none
 * resolve (e.g. all 404).
 */
async function _readFirstDiscovery(uriVariants) {
  for (const variant of uriVariants) {
    const discoveryUri = await _discoveryUriFor(variant);
    if (!discoveryUri) continue;
    try {
      return await _fetchJsonLd(discoveryUri);
    } catch (_) {
      // 404 (or other) on this variant — try the next.
    }
  }
  return null;
}

/**
 * Normalise a URI for equality comparison. Two passes:
 *   1. Through the URL constructor so percent-encoding is consistent
 *      with whatever the server returns.
 *   2. Specifically for raw.githubusercontent.com URLs, strip the
 *      `/refs/heads/` segment when present. GitHub serves the same blob
 *      from both `…/<owner>/<repo>/<branch>/<path>` and
 *      `…/<owner>/<repo>/refs/heads/<branch>/<path>` — mei-friend and
 *      alignment files in this codebase use both forms interchangeably,
 *      so a strict string-compare misses obviously-equivalent URIs.
 *      We treat the branch-shorthand form as canonical.
 */
function _normaliseIri(uri) {
  let normalised;
  try {
    normalised = new URL(uri).toString();
  } catch (_) {
    return uri;
  }
  return normalised.replace(
    /^(https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/)refs\/heads\/(?=[^/]+\/)/,
    "$1",
  );
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
