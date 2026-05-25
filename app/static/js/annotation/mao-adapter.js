// V6 annotation state ↔ MAO + OA Linked Data adapter.
//
// Pure functions; no network calls (those land in Phase E's persistence
// module, which consumes the templates produced here).
//
// Translation summary (per locked design):
//   - 1 annotation = 1 mao:MusicalMaterial + 1 mao:Extract + N mao:Selections
//     (one per attached recording).
//   - Every Selection in one Extract carries a PARALLEL frbr:part list, in the
//     canonical order of `annotation.regions[]`. Index = identity on re-import.
//   - rdfs:label on all three MAO levels when annotation title is non-empty;
//     Selection uses the discriminating form "<title> — <file>". Skip entirely
//     when title is empty.
//   - Layered oa:Annotations carry the descriptive content:
//       sda:observing   — track-level (per-recording note), targets a Selection
//       sda:observing   — group-level (group note), targets oa:specificResources
//                         whose oa:hasSource = track-level OAs and oa:hasScope = Extract
//       sda:comparing   — comparison, targets oa:compositeTarget of specificResources
//                         (hasSource = group-level OA, hasPurpose = sda:evidencing,
//                          hasScope = Extract)
//       sda:commenting  — top-level description, targets MusicalMaterial directly
//                         when no lower-level OAs exist; otherwise an
//                         oa:compositeTarget over the highest-covering roots
//                         from the per-track OA tree.
//   - Chain enforcement: a group-level OA can only exist when at least one
//     recording in that group has a track-level OA. A comparison can only
//     exist between two group-level OAs. The UI (Phase D) gates inputs
//     accordingly; the adapter assumes these invariants hold.
//
// Local keys: stable identifiers for resources within one annotation. Phase E's
// orchestrator maps localKey → posted URI and rewrites references between
// resources during the post sequence. The adapter does not invent URIs.
//   "mm"                          — MusicalMaterial
//   "extract"                     — Extract
//   "sel/<file>"                  — Selection for a recording
//   "oa/track/<file>"             — track-level OA (per-recording note)
//   "oa/group/<groupLabel>"       — group-level OA (group note)
//   "oa/cmp/<comparisonId>"       — comparison OA
//   "oa/top"                      — top-level description OA

import { nsp } from "../linked-data.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nonEmpty(s) {
  return typeof s === "string" && s.trim().length > 0;
}

function textBody(text) {
  return {
    "@type": [nsp.OA + "TextualBody"],
    [nsp.RDF + "value"]: [{ "@value": text }],
  };
}

function ref(uri) {
  return { "@id": uri };
}

function lit(value) {
  return { "@value": value };
}

// ---------------------------------------------------------------------------
// serialize: annotation state → resource templates
// ---------------------------------------------------------------------------

/**
 * Serialise an annotation to a list of resource templates ready for posting.
 *
 * @param {object} annotation — state-shape annotation object
 * @param {object} ctx
 * @param {(file: string) => string|null} ctx.resolveAudioUri — recording filename → LD URI
 * @param {(localKey: string) => string} [ctx.uri] — localKey → posted URI (Phase E supplies a real resolver; tests use a stub)
 * @returns {object} { templates: Array<{localKey, kind, body, dependsOn}> }
 */
export function serialize(annotation, ctx) {
  const uri = ctx && ctx.uri ? ctx.uri : (k) => "_:" + k;
  const linkTo = (k) => ref(uri(k));

  const templates = [];

  // ---- mao:Selection per attached recording -------------------------------
  annotation.targets.forEach((target) => {
    const audioUri = ctx.resolveAudioUri(target.file);
    const baseForFragments = audioUri || target.file;
    const selKey = `sel/${target.file}`;
    const selBody = {
      "@type": [nsp.MAO + "Selection", nsp.SCHEMA + "Dataset"],
      // frbr:parts written in canonical region order; same length on every Selection.
      [nsp.FRBR + "part"]: annotation.regions.map((r) => {
        const t = target.regionTimes[r.id] || { start: 0, end: 0 };
        return ref(`${baseForFragments}#t=${t.start},${t.end}`);
      }),
    };
    if (audioUri) {
      selBody[nsp.SCHEMA + "about"] = [ref(audioUri)];
    }
    if (nonEmpty(annotation.label)) {
      selBody[nsp.RDFS + "label"] = [lit(`${annotation.label} — ${target.file}`)];
    }
    templates.push({
      localKey: selKey,
      kind: "mao:Selection",
      body: selBody,
      dependsOn: [],
    });
  });

  // ---- mao:Extract --------------------------------------------------------
  const extractBody = {
    "@type": [nsp.MAO + "Extract", nsp.SCHEMA + "Dataset"],
    [nsp.FRBR + "embodiment"]: annotation.targets.map((t) =>
      linkTo(`sel/${t.file}`),
    ),
  };
  if (nonEmpty(annotation.label)) {
    extractBody[nsp.RDFS + "label"] = [lit(annotation.label)];
  }
  templates.push({
    localKey: "extract",
    kind: "mao:Extract",
    body: extractBody,
    dependsOn: annotation.targets.map((t) => `sel/${t.file}`),
  });

  // ---- mao:MusicalMaterial -----------------------------------------------
  const mmBody = {
    "@type": [nsp.MAO + "MusicalMaterial", nsp.SCHEMA + "Dataset"],
    [nsp.MAO + "setting"]: [linkTo("extract")],
  };
  if (nonEmpty(annotation.label)) {
    mmBody[nsp.RDFS + "label"] = [lit(annotation.label)];
  }
  templates.push({
    localKey: "mm",
    kind: "mao:MusicalMaterial",
    body: mmBody,
    dependsOn: ["extract"],
  });

  // ---- Track-level OAs (sda:observing on Selection) ----------------------
  const trackKeysByFile = new Map();
  annotation.targets.forEach((target) => {
    if (!nonEmpty(target.description)) return;
    const key = `oa/track/${target.file}`;
    trackKeysByFile.set(target.file, key);
    templates.push({
      localKey: key,
      kind: "oa:Annotation",
      body: {
        "@type": [nsp.OA + "Annotation", nsp.SCHEMA + "Dataset"],
        [nsp.OA + "motivatedBy"]: [ref(nsp.SDA + "observing")],
        [nsp.OA + "hasBody"]: [textBody(target.description)],
        [nsp.OA + "hasTarget"]: [linkTo(`sel/${target.file}`)],
      },
      dependsOn: [`sel/${target.file}`],
    });
  });

  // ---- Group-level OAs (sda:observing on specificResources) --------------
  // Chain rule: a group-level OA's specificResources each reference a
  // track-level OA when one exists for that recording, otherwise the
  // Selection directly. We only include recordings that (a) are in the
  // group AND (b) are attached to the annotation. Per-recording notes
  // are no longer required for a group note to be emitted.
  const attachedFiles = new Set(annotation.targets.map((t) => t.file));
  const groupKeysByLabel = new Map();
  if (annotation.pinnedGrouping && annotation.pinnedGrouping.groups) {
    annotation.pinnedGrouping.groups.forEach((g) => {
      const noteText = annotation.groupNotes[g.label];
      if (!nonEmpty(noteText)) return;
      // Files in this group that are attached to the annotation. Prefer
      // pointing each item at the track-level OA when one exists (so the
      // group note is composed of per-recording observations); otherwise
      // point directly at the Selection.
      const includedFiles = g.files.filter((f) => attachedFiles.has(f));
      if (includedFiles.length === 0) return;
      const items = includedFiles.map((f) => ({
        "@type": [nsp.OA + "SpecificResource"],
        [nsp.OA + "hasSource"]: [
          trackKeysByFile.has(f)
            ? linkTo(trackKeysByFile.get(f))
            : linkTo(`sel/${f}`),
        ],
        [nsp.OA + "hasScope"]: [linkTo("extract")],
      }));
      const key = `oa/group/${g.label}`;
      groupKeysByLabel.set(g.label, key);
      const body = {
        "@type": [nsp.OA + "Annotation", nsp.SCHEMA + "Dataset"],
        [nsp.OA + "motivatedBy"]: [ref(nsp.SDA + "observing")],
        [nsp.OA + "hasBody"]: [textBody(noteText)],
        [nsp.OA + "hasTarget"]: items,
        [nsp.RDFS + "label"]: [lit(g.label)],
      };
      templates.push({
        localKey: key,
        kind: "oa:Annotation",
        body,
        dependsOn: [
          "extract",
          ...includedFiles.map((f) =>
            trackKeysByFile.has(f) ? trackKeysByFile.get(f) : `sel/${f}`,
          ),
        ],
      });
    });
  }

  // ---- Comparison OAs (sda:comparing) ------------------------------------
  const comparisonKeys = [];
  annotation.comparisons.forEach((c) => {
    const leftKey = groupKeysByLabel.get(c.leftLabel);
    const rightKey = groupKeysByLabel.get(c.rightLabel);
    if (!leftKey || !rightKey) return; // UI guarantees both exist
    const items = [leftKey, rightKey].map((gk) => ({
      "@type": [nsp.OA + "SpecificResource"],
      [nsp.OA + "hasSource"]: [linkTo(gk)],
      [nsp.OA + "hasPurpose"]: [ref(nsp.SDA + "evidencing")],
      [nsp.OA + "hasScope"]: [linkTo("extract")],
    }));
    const key = `oa/cmp/${c.id}`;
    comparisonKeys.push(key);
    templates.push({
      localKey: key,
      kind: "oa:Annotation",
      body: {
        "@type": [nsp.OA + "Annotation", nsp.SCHEMA + "Dataset"],
        [nsp.OA + "motivatedBy"]: [ref(nsp.SDA + "comparing")],
        [nsp.OA + "hasBody"]: [textBody(c.text || "")],
        [nsp.OA + "hasTarget"]: [
          {
            "@type": [nsp.OA + "CompositeTarget"],
            [nsp.OA + "items"]: items,
          },
        ],
      },
      dependsOn: ["extract", leftKey, rightKey],
    });
  });

  // ---- Top-level description (sda:commenting) ----------------------------
  // No lower-level OAs at all → hasTarget = MusicalMaterial directly.
  // Otherwise → hasTarget = compositeTarget over highest-covering roots,
  // computed per-track and deduped.
  if (nonEmpty(annotation.description)) {
    const roots = _computeTopCommentingRoots(
      annotation,
      trackKeysByFile,
      groupKeysByLabel,
      comparisonKeys,
    );
    const body = {
      "@type": [nsp.OA + "Annotation", nsp.SCHEMA + "Dataset"],
      [nsp.OA + "motivatedBy"]: [ref(nsp.SDA + "commenting")],
      [nsp.OA + "hasBody"]: [textBody(annotation.description)],
    };
    let dependsOn;
    if (roots.length === 0) {
      body[nsp.OA + "hasTarget"] = [linkTo("mm")];
      dependsOn = ["mm"];
    } else {
      body[nsp.OA + "hasTarget"] = [
        {
          "@type": [nsp.OA + "CompositeTarget"],
          [nsp.OA + "items"]: roots.map((rk) => ({
            "@type": [nsp.OA + "SpecificResource"],
            [nsp.OA + "hasSource"]: [linkTo(rk)],
            [nsp.OA + "hasPurpose"]: [ref(nsp.SDA + "evidencing")],
            [nsp.OA + "hasScope"]: [linkTo("extract")],
          })),
        },
      ];
      dependsOn = ["mm", "extract", ...roots];
    }
    templates.push({
      localKey: "oa/top",
      kind: "oa:Annotation",
      body,
      dependsOn,
    });
  }

  return { templates };
}

/**
 * For each attached recording with a track-level OA, walk up the OA tree
 * (track → group → comparison) and return the set of highest-covering roots.
 * sda:assembling is supported in deserialise but not authored in v1.
 */
function _computeTopCommentingRoots(
  annotation,
  trackKeysByFile,
  groupKeysByLabel,
  comparisonKeys,
) {
  // Build reverse-coverage indexes:
  //   groupCoversTrack[trackKey] = [groupKey, ...]
  //   compCoversGroup[groupKey]  = [comparisonKey, ...]
  const groupCoversTrack = new Map();
  if (annotation.pinnedGrouping && annotation.pinnedGrouping.groups) {
    annotation.pinnedGrouping.groups.forEach((g) => {
      const gk = groupKeysByLabel.get(g.label);
      if (!gk) return;
      g.files.forEach((f) => {
        const tk = trackKeysByFile.get(f);
        if (!tk) return;
        if (!groupCoversTrack.has(tk)) groupCoversTrack.set(tk, []);
        groupCoversTrack.get(tk).push(gk);
      });
    });
  }
  const compCoversGroup = new Map();
  annotation.comparisons.forEach((c) => {
    const ck = `oa/cmp/${c.id}`;
    if (!comparisonKeys.includes(ck)) return;
    [c.leftLabel, c.rightLabel].forEach((label) => {
      const gk = groupKeysByLabel.get(label);
      if (!gk) return;
      if (!compCoversGroup.has(gk)) compCoversGroup.set(gk, []);
      compCoversGroup.get(gk).push(ck);
    });
  });

  // For each track, find highest ancestors (per-track set; multiple if covered
  // by multiple comparisons / etc.). Then union all per-track sets.
  const roots = new Set();
  for (const trackKey of trackKeysByFile.values()) {
    const groups = groupCoversTrack.get(trackKey) || [];
    if (groups.length === 0) {
      roots.add(trackKey);
      continue;
    }
    let foundAncestorAboveGroup = false;
    for (const gk of groups) {
      const comps = compCoversGroup.get(gk) || [];
      if (comps.length > 0) {
        comps.forEach((ck) => roots.add(ck));
        foundAncestorAboveGroup = true;
      } else {
        roots.add(gk);
      }
    }
    void foundAncestorAboveGroup; // for clarity; track is covered either way
  }
  return Array.from(roots);
}

// ---------------------------------------------------------------------------
// deserialize: graph → annotation state
// ---------------------------------------------------------------------------

/**
 * Reconstruct an annotation from a fetched LD graph.
 *
 * @param {object} graph — { [uri]: resourceObject } map, JSON-LD-expanded shape
 * @param {object} ctx
 * @param {string} ctx.musicalMaterialUri — entry-point MM URI
 * @param {(audioUri: string) => string|null} [ctx.resolveFileFromAudioUri] — invert resolveAudioUri; if absent, the bare last-path segment of the audio URI is used as the file key
 * @param {() => string} [ctx.mintRegionId] — region ID generator (defaults to a local counter)
 * @returns {object|null} annotation state object, or null if the MM isn't found
 */
export function deserialize(graph, ctx) {
  const mmUri = ctx.musicalMaterialUri;
  const mm = graph[mmUri];
  if (!mm) return null;

  let _rcount = 0;
  const mintRegionId =
    ctx.mintRegionId ||
    (() => "rgn_imp_" + Date.now().toString(36) + "_" + ++_rcount);

  const fileFromAudio =
    ctx.resolveFileFromAudioUri ||
    ((uri) => {
      try {
        const u = new URL(uri);
        const seg = u.pathname.split("/").filter(Boolean).pop();
        return seg || uri;
      } catch (_) {
        return uri;
      }
    });

  const extractRef = _firstId(mm[nsp.MAO + "setting"]);
  const extract = extractRef ? graph[extractRef] : null;
  if (!extract) return null;

  const annLabel = _firstValue(mm[nsp.RDFS + "label"]) || "";

  // Selections — IN ORDER. Each Selection's frbr:parts are PARALLEL across Selections.
  const selRefs = (extract[nsp.FRBR + "embodiment"] || []).map((o) => o["@id"]);
  const selections = selRefs.map((uri) => ({ uri, body: graph[uri] })).filter((s) => s.body);

  if (selections.length === 0) {
    return _emptyAnnotation(mmUri, extractRef, annLabel);
  }

  // Build canonical regions[] from the first Selection's part count; identity
  // is the index across all Selections.
  const partsBySelection = selections.map((s) =>
    (s.body[nsp.FRBR + "part"] || []).map((o) => o["@id"]),
  );
  const regionCount = partsBySelection[0].length;
  const regions = [];
  for (let i = 0; i < regionCount; i++) {
    regions.push({ id: mintRegionId(), label: "" });
  }

  // Build lastPostedUris as we go so a subsequent Update can route PUTs to
  // the right resources. Keys mirror serialize's local-key convention.
  const lastPostedUris = { mm: mmUri, extract: extractRef };

  // Targets — one per Selection. Map back to file key via schema:about.
  const targets = selections.map((s, sIdx) => {
    const aboutUri = _firstId(s.body[nsp.SCHEMA + "about"]);
    const file = aboutUri ? fileFromAudio(aboutUri) : "";
    const regionTimes = {};
    regions.forEach((r, ri) => {
      const partUri = partsBySelection[sIdx][ri];
      const t = _parseMediaFragment(partUri);
      regionTimes[r.id] = t;
    });
    if (file) lastPostedUris["sel/" + file] = s.uri;
    return { file, description: "", regionTimes, _selectionUri: s.uri };
  });

  // OA layers: scan the graph for oa:Annotations targeting our resources.
  const annotationsInGraph = Object.values(graph).filter((r) => _hasType(r, nsp.OA + "Annotation"));

  // Track-level (sda:observing targeting a Selection of this Extract)
  const selUriSet = new Set(selections.map((s) => s.uri));
  const trackOAByFile = new Map(); // file → OA resource
  for (const a of annotationsInGraph) {
    if (!_hasMotivation(a, nsp.SDA + "observing")) continue;
    const tgt = _firstId(a[nsp.OA + "hasTarget"]);
    if (!tgt || !selUriSet.has(tgt)) continue;
    const matchingTarget = targets.find((t) => t._selectionUri === tgt);
    if (!matchingTarget) continue;
    matchingTarget.description = _readBodyText(a, graph);
    trackOAByFile.set(matchingTarget.file, a);
    if (matchingTarget.file && a["@id"]) {
      lastPostedUris["oa/track/" + matchingTarget.file] = a["@id"];
    }
  }

  // Group-level OAs (sda:observing with a hasTarget list of specificResources)
  const groupNotes = {};
  const pinnedGroups = []; // reconstructed [{label, color, files}]
  for (const a of annotationsInGraph) {
    if (!_hasMotivation(a, nsp.SDA + "observing")) continue;
    const targetArr = a[nsp.OA + "hasTarget"];
    if (!Array.isArray(targetArr) || targetArr.length === 0) continue;
    // Distinguish from track-level: target list is multiple specificResources.
    const isSpecificList = targetArr.every((t) => _hasType(t, nsp.OA + "SpecificResource"));
    if (!isSpecificList) continue;
    // Each item references either a track-level OA (preferred when a
    // per-recording note exists) or a Selection directly (fall-back used
    // when no per-recording note is set). Both shapes scope to our Extract.
    const sourceUris = targetArr
      .map((t) => _firstId(t[nsp.OA + "hasSource"]))
      .filter(Boolean);
    const scopedToOurExtract = targetArr.every(
      (t) => _firstId(t[nsp.OA + "hasScope"]) === extractRef,
    );
    if (!scopedToOurExtract) continue;
    // Map source URIs back to files via either trackOAByFile (track-OA
    // hasSource) or by matching the Selection URI directly.
    const fileBySelectionUri = new Map(
      targets.map((t) => [t._selectionUri, t.file]),
    );
    const filesCovered = [];
    sourceUris.forEach((su) => {
      for (const [file, oa] of trackOAByFile.entries()) {
        if (oa["@id"] === su) {
          filesCovered.push(file);
          return;
        }
      }
      const fileFromSel = fileBySelectionUri.get(su);
      if (fileFromSel) filesCovered.push(fileFromSel);
    });
    if (filesCovered.length === 0) continue;
    const label = _firstValue(a[nsp.RDFS + "label"]) || "";
    if (!label) continue;
    groupNotes[label] = _readBodyText(a, graph);
    pinnedGroups.push({ label, color: "#94a3b8", files: filesCovered });
    if (a["@id"]) lastPostedUris["oa/group/" + label] = a["@id"];
  }

  // Comparisons (sda:comparing with compositeTarget over two group-level refs)
  const comparisons = [];
  for (const a of annotationsInGraph) {
    if (!_hasMotivation(a, nsp.SDA + "comparing")) continue;
    const tgt = (a[nsp.OA + "hasTarget"] || [])[0];
    if (!tgt || !_hasType(tgt, nsp.OA + "CompositeTarget")) continue;
    const items = tgt[nsp.OA + "items"] || [];
    if (items.length < 2) continue;
    // Map item hasSource → group label via pinnedGroups built above.
    const labels = items
      .map((it) => _firstId(it[nsp.OA + "hasSource"]))
      .map((srcUri) => _labelForGroupOaUri(srcUri, graph))
      .filter(Boolean);
    if (labels.length < 2) continue;
    const cmpId = "cmp_imp_" + comparisons.length;
    comparisons.push({
      id: cmpId,
      leftLabel: labels[0],
      rightLabel: labels[1],
      text: _readBodyText(a, graph),
    });
    if (a["@id"]) lastPostedUris["oa/cmp/" + cmpId] = a["@id"];
  }

  // Top-level description (sda:commenting targeting MM or a compositeTarget)
  let description = "";
  for (const a of annotationsInGraph) {
    if (!_hasMotivation(a, nsp.SDA + "commenting")) continue;
    const targetArr = a[nsp.OA + "hasTarget"] || [];
    const targetsMM = targetArr.some((t) => _firstId([t]) === mmUri);
    const targetsCompositeOverOurs = targetArr.some(
      (t) =>
        _hasType(t, nsp.OA + "CompositeTarget") &&
        (t[nsp.OA + "items"] || []).some((it) =>
          [extractRef].includes(_firstId(it[nsp.OA + "hasScope"])),
        ),
    );
    if (targetsMM || targetsCompositeOverOurs) {
      description = _readBodyText(a, graph);
      if (a["@id"]) lastPostedUris["oa/top"] = a["@id"];
      break;
    }
  }

  // Strip the internal _selectionUri before returning targets.
  const cleanTargets = targets.map(({ _selectionUri, ...rest }) => rest);

  return {
    id: "ann_imp_" + mmUri,
    label: annLabel,
    color: "#94a3b8",
    description,
    hasUnsavedChanges: false,
    published: true,
    lastPostedUris,
    regions,
    targets: cleanTargets,
    groupNotes,
    comparisons,
    pinnedGrouping:
      pinnedGroups.length > 0
        ? { name: "Reconstructed", groups: pinnedGroups }
        : null,
  };
}

function _emptyAnnotation(mmUri, extractRef, label) {
  return {
    id: "ann_imp_" + mmUri,
    label,
    color: "#94a3b8",
    description: "",
    hasUnsavedChanges: false,
    published: true,
    lastPostedUris: { mm: mmUri, extract: extractRef },
    regions: [],
    targets: [],
    groupNotes: {},
    comparisons: [],
    pinnedGrouping: null,
  };
}

function _firstId(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  return arr[0]["@id"] || null;
}

function _firstValue(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const v = arr[0];
  return typeof v === "string" ? v : v["@value"] || null;
}

function _hasType(node, typeUri) {
  if (!node) return false;
  const types = node["@type"] || [];
  return Array.isArray(types) ? types.includes(typeUri) : types === typeUri;
}

function _hasMotivation(oa, motivationUri) {
  const m = oa[nsp.OA + "motivatedBy"] || [];
  return m.some((x) => x["@id"] === motivationUri);
}

function _readBodyText(oa, graph) {
  const bodyArr = oa[nsp.OA + "hasBody"] || [];
  for (const b of bodyArr) {
    // Inline TextualBody
    if (_hasType(b, nsp.OA + "TextualBody")) {
      const val = b[nsp.RDF + "value"];
      if (Array.isArray(val) && val[0])
        return val[0]["@value"] || val[0] || "";
      if (typeof val === "string") return val;
    }
    // Reference to a body resource
    if (b["@id"] && graph[b["@id"]]) {
      const ref2 = graph[b["@id"]];
      const v = ref2[nsp.RDF + "value"];
      if (Array.isArray(v) && v[0]) return v[0]["@value"] || "";
    }
  }
  return "";
}

function _labelForGroupOaUri(uri, graph) {
  const r = graph[uri];
  if (!r) return null;
  return _firstValue(r[nsp.RDFS + "label"]);
}

function _parseMediaFragment(uri) {
  if (!uri) return { start: 0, end: 0 };
  const hashIdx = uri.lastIndexOf("#t=");
  if (hashIdx === -1) return { start: 0, end: 0 };
  const spec = uri.substring(hashIdx + 3);
  const [s, e] = spec.split(",");
  return {
    start: parseFloat(s) || 0,
    end: parseFloat(e !== undefined ? e : s) || 0,
  };
}

// ---------------------------------------------------------------------------
// Self-test: round-trip a synthetic annotation through serialize → simulated
// post → deserialize, and check structural fidelity. Returns a report object;
// safe to call from devtools. No side effects.
// ---------------------------------------------------------------------------

export function selfTest() {
  const failures = [];
  function assert(cond, msg) {
    if (!cond) failures.push(msg);
  }

  const annotation = {
    id: "ann_test",
    label: "Test annotation",
    color: "#22c55e",
    description: "Overall observation.",
    hasUnsavedChanges: true,
    published: false,
    lastPostedUris: null,
    regions: [
      { id: "r1", label: "" },
      { id: "r2", label: "" },
    ],
    targets: [
      {
        file: "alpha.wav",
        description: "Note on alpha.",
        regionTimes: { r1: { start: 1.0, end: 2.0 }, r2: { start: 5.0, end: 5.0 } },
      },
      {
        file: "beta.wav",
        description: "Note on beta.",
        regionTimes: { r1: { start: 1.1, end: 2.1 }, r2: { start: 5.0, end: 6.0 } },
      },
      {
        file: "gamma.wav",
        description: "",
        regionTimes: { r1: { start: 1.2, end: 2.2 }, r2: { start: 5.1, end: 6.1 } },
      },
    ],
    groupNotes: { Strings: "Group note about strings." },
    comparisons: [],
    pinnedGrouping: {
      name: "By Section",
      groups: [
        { label: "Strings", color: "#3b82f6", files: ["alpha.wav", "beta.wav"] },
        { label: "Brass", color: "#f59e0b", files: ["gamma.wav"] },
      ],
    },
  };

  const ctx = {
    resolveAudioUri: (f) => `https://example.org/audio/${f}`,
    uri: (k) => `https://example.org/r/${encodeURIComponent(k)}`,
  };

  const { templates } = serialize(annotation, ctx);
  assert(templates.some((t) => t.localKey === "mm"), "missing MusicalMaterial template");
  assert(templates.some((t) => t.localKey === "extract"), "missing Extract template");
  assert(
    templates.filter((t) => t.kind === "mao:Selection").length === 3,
    "expected 3 Selection templates",
  );
  // Parallel frbr:part counts:
  const selTemplates = templates.filter((t) => t.kind === "mao:Selection");
  const partCounts = selTemplates.map((s) => s.body[nsp.FRBR + "part"].length);
  assert(
    new Set(partCounts).size === 1 && partCounts[0] === 2,
    "Selections must all have 2 frbr:parts (regions.length)",
  );
  // Discriminating Selection labels:
  selTemplates.forEach((s) => {
    const label = (s.body[nsp.RDFS + "label"] || [])[0];
    assert(label && /Test annotation — /.test(label["@value"]), "Selection label missing or wrong form");
  });
  // Track-level OAs only for recordings with notes:
  const trackOAs = templates.filter((t) => t.localKey.startsWith("oa/track/"));
  assert(trackOAs.length === 2, "expected 2 track-level OAs (alpha + beta only)");
  // Group note OA exists for Strings (both alpha and beta have track-level OAs):
  const groupOAs = templates.filter((t) => t.localKey.startsWith("oa/group/"));
  assert(groupOAs.length === 1, "expected 1 group OA (Strings)");
  // Top-level commenting points at compositeTarget over group OA (highest root):
  const topOA = templates.find((t) => t.localKey === "oa/top");
  assert(topOA, "missing top-level commenting OA");
  if (topOA) {
    const tgt = topOA.body[nsp.OA + "hasTarget"][0];
    assert(_hasType(tgt, nsp.OA + "CompositeTarget"), "top-level should use compositeTarget when lower-level OAs exist");
    const items = tgt[nsp.OA + "items"] || [];
    // Strings is the highest root for alpha + beta; gamma has no track OA, so no root from gamma.
    assert(items.length === 1, "expected exactly 1 composite item (dedup'd Strings group)");
  }

  // ---- Simulate a "post sequence" by collecting each template at a URI, --
  // ---- then deserialize from the resulting graph and assert equivalence. --
  const graph = {};
  templates.forEach((t) => {
    const uri = ctx.uri(t.localKey);
    const body = JSON.parse(JSON.stringify(t.body));
    body["@id"] = uri;
    graph[uri] = body;
  });
  const mmUri = ctx.uri("mm");

  // Drop the placeholder commenting target rewrites: replace _:<key> sentinels
  // — none should exist since ctx.uri is defined.
  const restored = deserialize(graph, {
    musicalMaterialUri: mmUri,
    resolveFileFromAudioUri: (audioUri) =>
      audioUri.replace("https://example.org/audio/", ""),
  });
  assert(restored, "deserialize returned null");
  if (restored) {
    assert(restored.label === "Test annotation", "label round-trip mismatch");
    assert(restored.regions.length === 2, "region count round-trip mismatch");
    assert(restored.targets.length === 3, "target count round-trip mismatch");
    assert(
      restored.targets.find((t) => t.file === "alpha.wav").description ===
        "Note on alpha.",
      "track-level note (alpha) lost",
    );
    assert(
      restored.targets.find((t) => t.file === "gamma.wav").description === "",
      "gamma had no note; should remain empty",
    );
    assert(
      restored.groupNotes.Strings === "Group note about strings.",
      "group note lost",
    );
    assert(restored.description === "Overall observation.", "top-level description lost");
    // Region times survive on first target:
    const aT = restored.targets.find((t) => t.file === "alpha.wav");
    const rIds = restored.regions.map((r) => r.id);
    assert(aT.regionTimes[rIds[0]].start === 1.0, "alpha.r1 start lost");
    assert(aT.regionTimes[rIds[1]].start === 5.0, "alpha.r2 (collapsed) start lost");
    assert(aT.regionTimes[rIds[1]].end === 5.0, "alpha.r2 (collapsed) end lost");

    // lastPostedUris round-trip: every key in the serialised template set
    // (minus discovery decoration) should map back to its known URI.
    const lpu = restored.lastPostedUris || {};
    assert(lpu.mm === ctx.uri("mm"), "lastPostedUris.mm missing");
    assert(lpu.extract === ctx.uri("extract"), "lastPostedUris.extract missing");
    assert(lpu["sel/alpha.wav"] === ctx.uri("sel/alpha.wav"), "lastPostedUris.sel/alpha lost");
    assert(lpu["oa/track/alpha.wav"] === ctx.uri("oa/track/alpha.wav"), "lastPostedUris.oa/track/alpha lost");
    assert(lpu["oa/group/Strings"] === ctx.uri("oa/group/Strings"), "lastPostedUris.oa/group/Strings lost");
    assert(lpu["oa/top"] === ctx.uri("oa/top"), "lastPostedUris.oa/top lost");
  }

  return {
    passed: failures.length === 0,
    failures,
    templateCount: templates.length,
  };
}
