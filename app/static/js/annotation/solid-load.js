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
  correctedSynthOffsets,
  correctedSynthOnsets,
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
  const mmEntries = dataset.filter((entry) => {
    const t = _firstId(_asArray(entry?.[nsp.SCHEMA + "additionalType"]));
    return t === nsp.MAO + "MusicalMaterial";
  });

  // §3 fast path: discovery entries written by current Listen Here carry
  // denormalised schema:name + schema:dateCreated, so the picker row is built
  // straight from the (single, already-fetched) discovery resource — no per-MM
  // GET. Entries lacking them — annotations posted by older LH, or by
  // mei-friend, which doesn't denormalise — fall back to fetching the MM.
  // schema:dateCreated is the denormalisation sentinel: we always write it for
  // new entries (a title may be empty, but a creation date never is).
  const out = await _mapLimit(mmEntries, READ_CONCURRENCY, async (entry) => {
    const url = _firstId(_asArray(entry?.[nsp.SCHEMA + "url"]));
    if (!url) return null;
    const inlineCreated = _firstValueOrText(entry?.[nsp.SCHEMA + "dateCreated"]);
    const inlineName = _firstValueOrText(entry?.[nsp.SCHEMA + "name"]);
    if (inlineCreated !== null || inlineName !== null) {
      return {
        mmUri: url,
        label: inlineName || "(untitled)",
        created: inlineCreated || null,
      };
    }
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
  });
  return out.filter(Boolean);
}

/**
 * For every locally-loaded recording with a Linked Data URI, read its
 * pod discovery resource and return the union of MM entries it lists.
 * Each result row carries `coveredFiles` — the loaded file keys it shows
 * up for — so the UI can hint at how relevant the annotation is to the
 * current workspace. Audios with no discovery resource on the pod (404)
 * are silently skipped.
 */
export async function listAnnotationsForLoadedAudios(opts = {}) {
  const onProgress = opts.onProgress || (() => {});
  // Called as each source (recording / score) resolves, with a fresh
  // deduped snapshot so the UI can render rows progressively instead of
  // waiting for the whole fan-out. `errors` lets the UI distinguish an
  // unreachable pod from a genuinely empty result.
  const onSnapshot = opts.onSnapshot || (() => {});

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
  if (audios.length === 0 && !scoreUri) return { entries: [], errors: [] };

  const sources = [
    ...audios.map((audioUri) => ({
      kind: "audio",
      file: reverseMap.get(audioUri),
      uri: audioUri,
    })),
    ...(scoreUri ? [{ kind: "score", file: null, uri: scoreUri }] : []),
  ];

  // De-dupe by mmUri; record which loaded files each annotation covers and
  // whether it surfaced from the score's discovery resource. Built up
  // incrementally so each resolved source can emit a progress snapshot.
  const byMm = new Map();
  const errors = [];
  const total = sources.length;
  let done = 0;
  onProgress("Checking " + total + " source" + (total === 1 ? "" : "s") + " on your pod…");

  const snapshot = () =>
    [...byMm.values()].map((e) => ({
      ...e,
      coveredFiles: [...e.coveredFiles].sort(),
    }));

  await Promise.all(
    sources.map(async (src) => {
      let entries = [];
      try {
        entries = await listAnnotationsForAudio(src.uri);
      } catch (err) {
        errors.push({ kind: src.kind, file: src.file, error: err });
      }
      for (const entry of entries) {
        if (!byMm.has(entry.mmUri)) {
          byMm.set(entry.mmUri, {
            ...entry,
            coveredFiles: new Set(),
            aboutsScore: false,
          });
        }
        const agg = byMm.get(entry.mmUri);
        if (src.kind === "audio" && src.file) agg.coveredFiles.add(src.file);
        if (src.kind === "score") agg.aboutsScore = true;
      }
      done++;
      onProgress("Checked " + done + " of " + total + " — found " + byMm.size + " so far…");
      onSnapshot({ entries: snapshot(), errors: [...errors], done, total });
    }),
  );

  return { entries: snapshot(), errors };
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
          "\n\nLoad these audio files (and set their Linked Data URIs in Manage recordings) before loading the annotation.",
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
  // Prefer the corrected synth tables (derived from the MIDI Verovio actually
  // rendered): Verovio's tstampOn values are matched against these, and the
  // stored synth_onset/synth_offset may carry the pre-fix tempo skew.
  const onsetTimes =
    correctedSynthOnsets || scoreAlignment.synth_onset || scoreAlignment.score_onset;
  const offsetTimes =
    correctedSynthOffsets || scoreAlignment.synth_offset || scoreAlignment.score_offset;
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
  const sels = await _mapLimit(selUris, READ_CONCURRENCY, _fetchJsonLd);

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
  const oas = await _mapLimit(oaUriArr, READ_CONCURRENCY, async (uri) => {
    try { return await _fetchJsonLd(uri); }
    catch (err) {
      console.warn("[annotation/v6] couldn't fetch OA", uri, err);
      return null;
    }
  });

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

// Resilient read: retry transient failures (network errors, 5xx, 429) with
// backoff, and abort a hung request after a timeout rather than spinning
// forever. Non-transient statuses (incl. 404) are returned as-is for the
// caller to interpret. Reads previously had no retry/timeout at all, so a
// single blip surfaced as "(unreadable)" or a silently-empty list.
const READ_RETRIES = 2; // total attempts = READ_RETRIES + 1
const READ_TIMEOUT_MS = 15000;
const READ_BACKOFF_MS = 400;
const READ_CONCURRENCY = 6; // max in-flight reads per fan-out

function _sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Run `fn` over `items` with at most `limit` calls in flight at once,
// preserving input order in the result. Bounds discovery/chain fan-out so a
// resource listing many entries doesn't fire an unbounded burst of (usually
// authenticated) requests at the pod. Rejection semantics match Promise.all:
// if `fn` throws for any item, the whole call rejects.
async function _mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = [];
  for (let w = 0; w < Math.min(limit, items.length); w++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

// When `authenticated` is false the request is issued with the plain global
// fetch, so the user's Solid access token / DPoP proof never leaves their pod
// origin (see _isPodOrigin). Same retry/timeout behaviour either way.
async function _solidFetchResilient(uri, init = {}, authenticated = true) {
  let lastErr;
  for (let attempt = 0; attempt <= READ_RETRIES; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), READ_TIMEOUT_MS);
    try {
      const reqInit = { ...init, signal: ctrl.signal };
      const resp = authenticated
        ? await solid.fetch(uri, reqInit)
        : await fetch(uri, reqInit);
      clearTimeout(timer);
      if ((resp.status >= 500 || resp.status === 429) && attempt < READ_RETRIES) {
        lastErr = new Error("GET " + uri + " failed: " + resp.status);
        await _sleep(READ_BACKOFF_MS * (attempt + 1));
        continue;
      }
      return resp;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (attempt < READ_RETRIES) {
        await _sleep(READ_BACKOFF_MS * (attempt + 1));
        continue;
      }
      throw lastErr;
    }
  }
  throw lastErr;
}

// Locally-bundled JSON-LD contexts, served without any network request
// (privacy + resilience: a slow/down context host can't break expansion).
// A context here MUST be the authentic document for its URL — a wrong mapping
// would silently mis-expand resources — so we only add contexts we've
// verified. Unknown contexts are still fetched (so unforeseen resources keep
// working) but logged once each, to reveal which real-world contexts to bundle
// next. Seed this as those URLs are observed (see #31).
const _STATIC_CONTEXTS = {
  // "https://www.w3.org/ns/anno.jsonld": { "@context": { /* … */ } },
};

// Session-caching JSON-LD document loader. Listen Here and mei-friend both
// write expanded, context-less resources, so for today's data nothing here is
// exercised. It's defensive support for the source-agnostic goal: a
// third-party MAO-stack source could ship compact form with a remote
// `@context`, and the default loader would re-fetch that context on EVERY
// expand call — a round trip per resource plus a failure surface (context host
// slow/down → expansion throws → we fall back to raw → full-IRI keys don't
// match → "(unreadable)"). Static contexts are served locally; anything else
// is fetched at most once per session.
let _cachingDocumentLoader = null;
function _getDocumentLoader() {
  if (_cachingDocumentLoader) return _cachingDocumentLoader;
  const jsonld = globalThis.jsonld;
  if (
    !jsonld ||
    !jsonld.documentLoaders ||
    typeof jsonld.documentLoaders.xhr !== "function"
  ) {
    return null;
  }
  const base = jsonld.documentLoaders.xhr();
  const cache = new Map();
  const loggedUnknown = new Set();
  _cachingDocumentLoader = async (url) => {
    if (Object.prototype.hasOwnProperty.call(_STATIC_CONTEXTS, url)) {
      return { contextUrl: null, document: _STATIC_CONTEXTS[url], documentUrl: url };
    }
    if (cache.has(url)) return cache.get(url);
    if (!loggedUnknown.has(url)) {
      loggedUnknown.add(url);
      console.info(
        "[annotation/v6] fetching remote JSON-LD @context over the network:",
        url,
        "— bundle it in _STATIC_CONTEXTS to serve locally (see #31).",
      );
    }
    const doc = await base(url);
    cache.set(url, doc);
    return doc;
  };
  return _cachingDocumentLoader;
}

// Decide whether a URI may be fetched with the user's Solid credentials.
// The chain walk follows URIs taken from resource bodies (mao:setting,
// frbr:embodiment, discovery schema:url), which — for annotations the user
// didn't author, or future foreign sources — can point anywhere. We send the
// access token / DPoP proof ONLY to the user's own pod origin; everything
// else is fetched anonymously (allowed, but credential-less). If the storage
// root can't be resolved we default to anonymous (the safe choice).
async function _isPodOrigin(uri) {
  try {
    const storage = await getSolidStorage();
    return !!storage && new URL(uri).origin === new URL(storage).origin;
  } catch (_) {
    return false;
  }
}

async function _fetchJsonLd(uri) {
  const authenticated = await _isPodOrigin(uri);
  const resp = await _solidFetchResilient(
    uri,
    { headers: { Accept: "application/ld+json" } },
    authenticated,
  );
  if (!resp.ok) {
    throw new Error("GET " + uri + " failed: " + resp.status);
  }
  const raw = await resp.json();
  // JSON-LD expand so keys are always full IRIs. Both Listen Here and
  // mei-friend write resources already expanded (full-IRI keys, no
  // `@context`), so for today's data expansion is a no-op. We still expand to
  // stay compatible with ANY MAO-stack source (the source-agnostic loading
  // goal): a third-party author may ship compact form with a `@context`, which
  // our key-by-full-IRI deserialize wouldn't otherwise match. Expansion is
  // idempotent on already-expanded input. If it fails (malformed, unreachable
  // remote context, …) we fall through to the raw body.
  let expanded;
  try {
    if (typeof globalThis.jsonld !== "undefined") {
      const loader = _getDocumentLoader();
      expanded = await globalThis.jsonld.expand(
        raw,
        loader ? { documentLoader: loader } : undefined,
      );
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
  let nonMissingErr = null;
  for (const variant of uriVariants) {
    const discoveryUri = await _discoveryUriFor(variant);
    if (!discoveryUri) continue;
    try {
      return await _fetchJsonLd(discoveryUri);
    } catch (err) {
      // A missing discovery (404) just means "no annotations for this
      // variant" — try the next. Anything else (network error, 5xx after
      // retries, 403) is a real failure we surface to the caller rather
      // than silently treating an unreachable pod as an empty result.
      if (!_isMissingResourceError(err)) nonMissingErr = err;
    }
  }
  if (nonMissingErr) throw nonMissingErr;
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
