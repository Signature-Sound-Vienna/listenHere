#!/usr/bin/env python3
"""Build the museum exhibit's data payload from the authored alignment sets.

The exhibit does not read the authoring files at runtime. This script merges them
once, offline, into a single payload under `app/static/exhibit/data/`, transcodes
the curated audio, and pins the MEI locally — because the museum machine is a
frozen PC with no network, and because "resolve at runtime" is exactly the kind of
cleverness a kiosk cannot afford.

Three steps, all on by default (see --help to run one at a time), and a warning
report printed at the end of any run:

  payload   merge the three audience sets over the HQ alignment  -> data/<piece>.json
  mei       fetch header.meiUri and pin it beside the payload    -> data/<piece>.mei
  audio     transcode the curated recordings to 48 kHz mp3       -> audio/*.mp3

`--self-test` checks the index arithmetic against a literal port of align-core on
the real grids, and exits. Run it after touching closest_ix or after a re-align.

WHAT THIS ENCODES, and why — every one of these is a decision recorded in
docs/exhibit-prototype-plan.md, not a preference:

* **Times are RE-DERIVED from the HQ grid through canonical index PAIRS, never
  copied.** Alignment indices are portable across re-alignments and times are not:
  every grid is 29,121 entries whatever the preset, because the length is
  score-determined (§5.2c). Only ONE time per region was ever authored — the rest
  were mirrored through the grid — so re-deriving *improves* 15–18 times per
  region rather than damaging hand-work.
* **The 13 canonical pairs are ASSERTED, not trusted.** CANONICAL_PAIRS below is
  the plan's table; the script re-derives each pair from the source set's own grid
  and fails loudly on any disagreement. If a future re-align changes grid length,
  this is what tells you before the exhibit shows the wrong bar.
* **`overrides` is applied LAST and is never recomputed.** `D or E?` region (a) is
  6 indices / 0.12 s wide while alignment disagreement there reaches 2.53 s, so it
  cannot be fixed by any preset and must be hand-placed per recording (§5.2d).
  Those hand-placed times are authority; a re-run of this script must not touch
  them. That is the whole reason the block exists and is separate.
* **Audience is a FILTER over one merged payload, never a runtime alignment swap**
  (§5.3), because audience is resolved per viewport — two halves of the table can
  differ at the same moment, so one store cannot hold swapped payloads.
* **Every visitor-visible string becomes a language map** (`{"en": …}`), so German
  drops in without touching the exhibit. Bilingual is release-blocking for
  December; retrofitting i18n later is the expensive path (§6.6).
* **Audio is transcoded to 48 kHz** (§5.2e). The corpus is mixed 44.1/48 — the four
  curated VPO recordings are 48 kHz and the four non-VPO ones are 44.1 — and the
  iPad's AudioContext runs at 48 kHz, so half the set would hit iOS's resampling
  path inside `windowed-audio-player.js`'s gapless calibration. Resampling once,
  offline, deletes that risk instead of testing it, and costs no re-alignment
  because resampling preserves duration and the grids are in seconds.
* **`linkedDataUriPrefix` stays PER ANNOTATION.** The three sets disagree
  (`…/fledermaus`, `…/fledermausadults`, `…/fledermausEXPERTS`, and the HQ run's
  `…/Fledermaus/`), and the prefix mints identifiers that already exist. Picking a
  winner would silently re-identify somebody's annotations.

Usage:
    tools/prep_exhibit_data.py                     # everything
    tools/prep_exhibit_data.py --steps payload     # just the merge
    tools/prep_exhibit_data.py --steps audio --force
"""
from __future__ import annotations

import argparse
import bisect
import json
import os
import re
import shutil
import subprocess
import sys
import unicodedata
from collections import Counter
from datetime import datetime, timezone

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PIECE = "fledermaus"
SCHEMA = "lh-exhibit-payload/1"

SOURCES = {
    "hq": "Alignment_Fledermaus_HQ.json",
    "kids": "Alignment_Fledermaus_Kids.json",
    "adults": "Alignment_Fledermaus_Adults.json",
    "expert": "Alignment_Fledermaus_Expert.json",
}
AUDIENCES = ["kids", "adults", "expert"]

# The curated eight (§5.2). Barely a choice: the four narrow annotations plus the
# reference force exactly this set, and it lands on an exact 4 VPO / 4 non-VPO
# split — which turns out to be the 48 kHz / 44.1 kHz split too (§5.2e).
CURATED = [
    "VPO-2010.wav",  # the reference, and the slowest
    "VPO-1987.wav",  # NB: the plain file is the 48 kHz one; both alternate 1987 releases are 44.1
    "VPO-1989.wav",
    "VPO-2022.wav",
    "Philharmonia Orchestra London, Georg Randolph Warren (1982).wav",
    "K&K Philharmoniker, Kendlinger (2010).wav",
    "Philharmonie Lugansk, Kurt Schmid.wav",
    "Wiener Volksopernorchester, Franz Bauer-Theussl (1985).wav",
]

# plan §5.2c — the durable artifact of the re-alignment analysis. Asserted below.
CANONICAL_PAIRS = {
    "rgn_ms4sh8ta_2": (2755, 3450),   # Adults, "Die Glocke"
    "rgn_ms4su3uj_4": (5266, 7805),   # Adults, Keeping time
    "rgn_msu6vl9p_2": (8835, 9794),   # Adults, The Viennese Lilt
    "rgn_msvors30_2": (705, 711),     # Expert, D or E? (a) — NEEDS HAND-PLACEMENT (§5.2d)
    "rgn_msvos2fy_3": (432, 894),     # Expert, D or E? (b)
    "rgn_msvpcupp_5": (12772, 13933),  # Expert, Oboe Solos (a)
    "rgn_msvpd6fv_6": (14990, 15582),  # Expert, Oboe Solos (b)
    "rgn_msvqekba_8": (8564, 9414),   # Expert, Agogic and "Schwung"
    "rgn_mrxa6xz4_2": (0, 0),         # Kids, Clapping Detective — DEGENERATE, dropped
    "rgn_mrxebibu_3": (26315, 29120),  # Kids, Clapping Detective
    "rgn_mrxej01r_5": (2843, 2866),   # Kids, Lonely Bell (a)
    "rgn_mrxeqqiz_6": (2755, 3420),   # Kids, Lonely Bell (b)
    "rgn_ms4gs23a_2": (25280, 26589),  # Kids, Rollercoaster Ending
}

# A stray empty region the author must delete; a re-derive cannot repair a
# zero-length one, and drawing it would put an invisible target on the wall.
DEGENERATE_REGIONS = {"rgn_mrxa6xz4_2"}

# Region → recordings whose times Chanda hand-places, and which this script must
# therefore leave alone once they arrive in the overrides file (§5.2d).
NEEDS_HAND_PLACEMENT = {"rgn_msvors30_2"}

OVERRIDES_FILE = "overrides.json"


# --------------------------------------------------------------------------- util
def log(msg):
    print(msg, file=sys.stderr)


class Warnings(list):
    def add(self, kind, detail, **extra):
        self.append({"kind": kind, "detail": detail, **extra})
        log(f"  ! {kind}: {detail}")


def slugify(name: str) -> str:
    """A URL-safe stem. The keys carry commas, parentheses, ampersands and umlauts."""
    stem = re.sub(r"\.wav$", "", name, flags=re.I)
    stem = stem.replace("ß", "ss").replace("&", " and ")
    stem = unicodedata.normalize("NFKD", stem).encode("ascii", "ignore").decode()
    stem = re.sub(r"[^A-Za-z0-9]+", "-", stem).strip("-").lower()
    return stem or "recording"


def closest_ix(grid, t):
    """The index `engine/align-core.js` would return, found by bisection.

    align-core scans linearly and prefers the EARLIER index on a tie. Grids are
    monotonic (verified §5.2d), so bisection gives the identical answer — which is
    what `--self-test` checks, on the real grids, against align_core_linear below.
    A 29,121-point linear scan per probe is affordable here but the equivalence is
    load-bearing: every region time in the payload comes through this function.
    """
    if not grid:
        return 0
    i = bisect.bisect_right(grid, t)
    below, above = i - 1, i
    if below < 0:
        return 0
    if above >= len(grid):
        return below
    return above if (grid[above] - t) < (t - grid[below]) else below


def align_core_linear(grid, time):
    """A LITERAL port of engine/align-core.js's getClosestAlignmentIx.

    Deliberately transcribed line for line, filter and all, rather than written
    idiomatically — its only job is to be obviously the same algorithm as the
    JavaScript, so that closest_ix can be checked against it.
    """
    if not grid:
        return 0
    lower = [t for t in grid if t <= time]
    below_ix = len(lower) - 1
    above_ix = len(lower)
    if below_ix < 0:
        return 0
    if above_ix >= len(grid):
        return below_ix
    dist_below = time - grid[below_ix]
    dist_above = grid[above_ix] - time
    return above_ix if dist_above < dist_below else below_ix


def self_test(src_dir):
    """Check bisection against the linear port on the real grids, then exit."""
    hq = json.load(open(os.path.join(src_dir, SOURCES["hq"]), encoding="utf-8"))
    audio = hq["body"]["audio"]
    checked = failures = nonmonotonic = 0
    for key in CURATED:
        grid = audio[key]["times"]
        # Monotonicity is the precondition for bisection; assert it, do not assume.
        if any(grid[i] > grid[i + 1] for i in range(len(grid) - 1)):
            nonmonotonic += 1
            log(f"  NOT MONOTONIC: {key}")
        # Probe the interesting places: both ends, every canonical index, exact grid
        # values (the tie case), and points between samples.
        probes = [-1.0, 0.0, grid[0], grid[-1], grid[-1] + 10.0]
        for a, b in CANONICAL_PAIRS.values():
            for ix in (a, b):
                if ix < len(grid):
                    probes += [grid[ix], grid[ix] - 0.004, grid[ix] + 0.004]
        for i in range(0, len(grid) - 1, max(1, len(grid) // 40)):
            probes.append((grid[i] + grid[i + 1]) / 2)
        for t in probes:
            checked += 1
            fast, slow = closest_ix(grid, t), align_core_linear(grid, t)
            if fast != slow:
                failures += 1
                log(f"  MISMATCH {key} t={t!r}: bisect {fast} vs linear {slow}")
    log(f"self-test: {checked} probes over {len(CURATED)} grids, "
        f"{failures} mismatch(es), {nonmonotonic} non-monotonic grid(s)")
    if failures or nonmonotonic:
        sys.exit("self-test FAILED")
    log("self-test OK — bisection agrees with align-core everywhere probed")


def lang_map(value, lang="en"):
    """Wrap an authored string as a language map. Empty stays empty, not {"en": ""}."""
    if value is None:
        return None
    if isinstance(value, dict):
        return value  # already tagged; pass a translated payload straight through
    text = str(value).strip()
    return {lang: text} if text else None


# ------------------------------------------------------------------------ payload
def load_sources(src_dir):
    out = {}
    for key, fname in SOURCES.items():
        path = os.path.join(src_dir, fname)
        if not os.path.exists(path):
            sys.exit(f"missing source: {path}")
        with open(path, encoding="utf-8") as fh:
            out[key] = json.load(fh)
    return out


def verify_pairs(sets, warnings):
    """Re-derive every region's index pair from its OWN set and assert the table.

    This is the step that makes re-running safe: if a future re-align changes grid
    length or an author moves a region, the derived pair stops matching and the
    build fails here rather than putting the wrong bar on a museum wall.
    """
    derived = {}
    mismatches = []
    for audience in AUDIENCES:
        d = sets[audience]
        audio = d["body"]["audio"]
        for ann in d.get("annotations", []):
            for reg in ann.get("regions", []):
                rid = reg["id"]
                votes = Counter()
                for tgt in ann.get("targets", []):
                    rt = (tgt.get("regionTimes") or {}).get(rid)
                    grid = audio.get(tgt["file"], {}).get("times")
                    if not rt or not grid:
                        continue
                    votes[(closest_ix(grid, rt["start"]), closest_ix(grid, rt["end"]))] += 1
                if not votes:
                    warnings.add("region-not-derivable",
                                 f"{audience}/{ann['label']}/{rid} has no target times")
                    continue
                pair, agree = votes.most_common(1)[0]
                total = sum(votes.values())
                derived[rid] = pair
                expected = CANONICAL_PAIRS.get(rid)
                if expected is None:
                    mismatches.append(f"{rid} is not in CANONICAL_PAIRS (derived {pair})")
                elif expected != pair:
                    mismatches.append(f"{rid}: derived {pair}, table says {expected}")
                if agree < total:
                    dissent = {f"{k}": v for k, v in votes.items() if k != pair}
                    warnings.add("region-pair-dissent",
                                 f"{audience}/{ann['label']}/{rid} {agree}/{total} agree on {pair}",
                                 dissent=str(dissent))
    unseen = sorted(set(CANONICAL_PAIRS) - set(derived))
    if unseen:
        mismatches.append(f"CANONICAL_PAIRS has regions absent from the sources: {unseen}")
    if mismatches:
        sys.exit("index-pair verification FAILED:\n  " + "\n  ".join(mismatches))
    log(f"  index pairs verified: {len(derived)}/{len(CANONICAL_PAIRS)} regions match the table")
    return derived


def check_ids(sets, warnings):
    """Annotation and region ids must be unique ACROSS the merged sets (risk §7.5)."""
    ann_ids, reg_ids = Counter(), Counter()
    for audience in AUDIENCES:
        for ann in sets[audience].get("annotations", []):
            ann_ids[ann["id"]] += 1
            for reg in ann.get("regions", []):
                reg_ids[reg["id"]] += 1
    for label, counter in (("annotation", ann_ids), ("region", reg_ids)):
        clashes = {k: v for k, v in counter.items() if v > 1}
        if clashes:
            warnings.add(f"{label}-id-collision",
                         f"ids appear in more than one set: {clashes}")
    log(f"  ids: {len(ann_ids)} annotations, {len(reg_ids)} regions, "
        f"{'collisions found' if any(v > 1 for v in list(ann_ids.values()) + list(reg_ids.values())) else 'no collisions'}")


def build_recordings(hq, warnings, probe=True):
    audio = hq["body"]["audio"]
    out = {}
    for key in CURATED:
        entry = audio.get(key)
        if entry is None:
            sys.exit(f"curated recording missing from the HQ alignment: {key!r}")
        rec = {
            # Relative to app/static/exhibit/ — the exhibit ROOT, not the payload's
            # own directory. Resolving against the page rather than the data file is
            # the less surprising of the two, and it survives the payload moving.
            "audio": f"audio/{slugify(key)}.mp3",
            "duration": entry["duration"],
            "peaks": entry["peaks"],
            "times": entry["times"],
        }
        if probe:
            rate = probe_rate(os.path.join(REPO, "app/static/wav/Fledermaus", key))
            if rate:
                # Recorded so §5.2e stays visible in the data rather than only in prose.
                rec["sourceSampleRate"] = rate
                rec["outputSampleRate"] = 48000
        out[key] = rec
    lens = {len(r["times"]) for r in out.values()}
    if len(lens) != 1:
        warnings.add("grid-length-mismatch", f"curated grids differ in length: {lens}")
    log(f"  recordings: {len(out)} curated, grid length {lens.pop() if len(lens) == 1 else '?'}")
    return out


def build_annotations(sets, warnings):
    curated = set(CURATED)
    annotations = []
    for audience in AUDIENCES:
        d = sets[audience]
        prefix = d.get("header", {}).get("linkedDataUriPrefix")
        for ann in d.get("annotations", []):
            regions = []
            for reg in ann.get("regions", []):
                if reg["id"] in DEGENERATE_REGIONS:
                    warnings.add("degenerate-region-dropped",
                                 f"{audience}/{ann['label']}/{reg['id']} is 0.0→0.0 at index 0–0; "
                                 f"dropped from the payload. The AUTHOR must delete it at source.")
                    continue
                regions.append({
                    "id": reg["id"],
                    "label": lang_map(reg.get("label")),
                    "indexPair": list(CANONICAL_PAIRS[reg["id"]]),
                    "needsHandPlacement": reg["id"] in NEEDS_HAND_PLACEMENT,
                })
            kept_region_ids = {r["id"] for r in regions}

            targets, dropped = [], 0
            for tgt in ann.get("targets", []):
                if tgt["file"] not in curated:
                    dropped += 1
                    continue
                targets.append({
                    "file": tgt["file"],
                    "description": lang_map(tgt.get("description")),
                    # Times are filled by rederive_times(); never copied from source.
                    "regionTimes": {rid: None for rid in kept_region_ids},
                })
            if dropped:
                warnings.add("targets-outside-curation",
                             f"{audience}/{ann['label']}: {dropped} of "
                             f"{len(ann.get('targets', []))} targets are not in the curated 8",
                             kept=len(targets))
            if not targets:
                warnings.add("annotation-has-no-targets",
                             f"{audience}/{ann['label']} shows nothing for the curated set")

            groups = []
            for g in (ann.get("pinnedGrouping") or {}).get("groups", []):
                files = [f for f in g.get("files", []) if f in curated]
                label = g.get("label") or ""
                if label == "New Group":
                    warnings.add("unrenamed-default-group",
                                 f"{audience}/{ann['label']} has a group literally called "
                                 f'"New Group" — visitor-visible. The AUTHOR must rename it.')
                groups.append({
                    "groupId": g.get("groupId") or label,
                    "label": lang_map(label),
                    "color": g.get("color"),
                    "files": files,
                })

            annotations.append({
                "id": ann["id"],
                "audience": audience,
                "label": lang_map(ann.get("label")),
                "description": lang_map(ann.get("description")),
                "color": ann.get("color"),
                "linkedDataUriPrefix": prefix,
                "regions": regions,
                "targets": targets,
                "grouping": {
                    "name": (ann.get("pinnedGrouping") or {}).get("name"),
                    "groups": groups,
                },
                "groupNotes": {k: lang_map(v) for k, v in (ann.get("groupNotes") or {}).items()},
            })
    per_audience = Counter(a["audience"] for a in annotations)
    log(f"  annotations: {len(annotations)} total {dict(per_audience)}")
    return annotations


def rederive_times(annotations, recordings, warnings):
    """Fill every regionTimes entry as HQgrid[file][startIx] → HQgrid[file][endIx]."""
    filled = 0
    for ann in annotations:
        pairs = {r["id"]: r["indexPair"] for r in ann["regions"]}
        for tgt in ann["targets"]:
            grid = recordings[tgt["file"]]["times"]
            for rid in list(tgt["regionTimes"]):
                a, b = pairs[rid]
                if a >= len(grid) or b >= len(grid):
                    warnings.add("index-out-of-grid",
                                 f"{ann['id']}/{rid} pair ({a},{b}) exceeds grid {len(grid)}")
                    tgt["regionTimes"][rid] = None
                    continue
                tgt["regionTimes"][rid] = {"start": grid[a], "end": grid[b], "derived": True}
                filled += 1
    log(f"  re-derived {filled} region times from the HQ grid")
    return filled


def apply_overrides(annotations, overrides, warnings):
    """Overlay hand-placed times. Applied LAST; a re-run must never recompute these."""
    applied = 0
    index = {a["id"]: a for a in annotations}
    for ann_id, regions in (overrides or {}).items():
        if ann_id.startswith("_"):
            continue  # a note key, not data
        ann = index.get(ann_id)
        if ann is None:
            warnings.add("override-unknown-annotation", f"overrides name {ann_id}, which is absent")
            continue
        by_file = {t["file"]: t for t in ann["targets"]}
        for region_id, files in (regions or {}).items():
            if region_id.startswith("_"):
                continue
            for filename, times in (files or {}).items():
                tgt = by_file.get(filename)
                if tgt is None or region_id not in tgt["regionTimes"]:
                    warnings.add("override-unknown-target",
                                 f"overrides name {ann_id}/{region_id}/{filename}, which is absent")
                    continue
                tgt["regionTimes"][region_id] = {
                    "start": times["start"], "end": times["end"], "derived": False,
                }
                applied += 1
    if applied:
        log(f"  applied {applied} hand-placed override times")
    else:
        log("  no overrides applied (none authored yet)")
    return applied


def pending_hand_placement(annotations, warnings):
    for ann in annotations:
        for reg in ann["regions"]:
            if not reg["needsHandPlacement"]:
                continue
            derived = [t["file"] for t in ann["targets"]
                       if (t["regionTimes"].get(reg["id"]) or {}).get("derived")]
            if derived:
                warnings.add("awaiting-hand-placement",
                             f"{ann['id']}/{reg['id']} is still derived on {len(derived)} "
                             f"recording(s); it is 0.12 s wide against 2.53 s of alignment "
                             f"disagreement, so those times are NOT trustworthy (§5.2d)",
                             recordings=derived)


def load_overrides(path, warnings):
    if not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    log(f"  overrides: read {path}")
    return data


def seed_overrides(path):
    """Write the overrides file with its slot and its rules, if it does not exist."""
    if os.path.exists(path):
        return False
    template = {
        "_README": [
            "Hand-placed region times. AUTHORITY: this file wins over anything the",
            "re-derive computes, and tools/prep_exhibit_data.py applies it LAST and",
            "never rewrites it. Keep it in the repository even though the payload is",
            "generated — it is authored data, not a build product.",
            "Shape: { annotationId: { regionId: { 'recording.wav': {start, end} } } }",
        ],
        "_pending": {
            "ann_msvorn7q_1?": [
                "Expert / 'D or E?' region (a), rgn_msvors30_2, index 705-711.",
                "6 indices / 0.12 s wide, against up to 2.53 s of alignment disagreement",
                "at that point - 21x the region width - so no alignment preset can place",
                "it. Chanda hand-places it on the eight curated recordings AFTER the",
                "re-derive; the tool supports per-recording edge-drag. Once those times",
                "land here they are overrides forever: no future re-alignment may",
                "recompute them. See plan 5.2d.",
            ],
        },
    }
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(template, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    log(f"  overrides: seeded {path} (empty, with the D-or-E slot documented)")
    return True


def step_payload(args, sets, warnings):
    log("payload:")
    verify_pairs(sets, warnings)
    check_ids(sets, warnings)
    recordings = build_recordings(sets["hq"], warnings, probe=args.probe)
    annotations = build_annotations(sets, warnings)
    rederive_times(annotations, recordings, warnings)

    os.makedirs(args.data_dir, exist_ok=True)
    overrides_path = os.path.join(args.data_dir, OVERRIDES_FILE)
    seed_overrides(overrides_path)
    overrides = load_overrides(overrides_path, warnings)
    apply_overrides(annotations, overrides, warnings)
    pending_hand_placement(annotations, warnings)

    hq_header = sets["hq"]["header"]
    payload = {
        "schema": SCHEMA,
        "piece": {
            "id": PIECE,
            "title": {"en": "Die Fledermaus — Overture"},
            "composer": "Johann Strauss II",
            "ref": hq_header.get("ref"),
            "meiUri": f"./{PIECE}.mei",
            "meiSource": hq_header.get("meiUri"),
        },
        "source": {
            "generatedBy": f"tools/prep_exhibit_data.py ({os.path.basename(__file__)})",
            "generatedAt": args.timestamp,
            "alignment": SOURCES["hq"],
            "alignmentCreatedBy": hq_header.get("createdBy"),
            "alignmentParams": hq_header.get("alignmentParams"),
            "audienceSets": {a: SOURCES[a] for a in AUDIENCES},
        },
        "recordings": recordings,
        "annotations": annotations,
        "score": sets["hq"]["body"].get("score") if args.with_score else None,
        "warnings": list(warnings),
    }
    out = os.path.join(args.data_dir, f"{PIECE}.json")
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, separators=(",", ":"))
    size = os.path.getsize(out)
    log(f"  wrote {out} ({size / 1048576:.1f} MB)")
    return payload


# ---------------------------------------------------------------------------- mei
def step_mei(args, sets, warnings):
    log("mei:")
    uri = sets["hq"]["header"].get("meiUri")
    out = os.path.join(args.data_dir, f"{PIECE}.mei")
    if not uri:
        warnings.add("no-mei-uri", "the HQ alignment has no header.meiUri")
        return
    if os.path.exists(out) and not args.force:
        log(f"  {out} exists; --force to refetch")
        return
    os.makedirs(args.data_dir, exist_ok=True)
    # The kiosk has no network, so the MEI must be a local file, not a URL.
    import urllib.request
    try:
        with urllib.request.urlopen(uri, timeout=30) as resp:
            body = resp.read()
    except Exception as exc:  # noqa: BLE001 — any failure is the same story here
        warnings.add("mei-fetch-failed", f"{uri}: {exc}")
        return
    if b"<mei" not in body[:4000] and b"<music" not in body[:4000]:
        warnings.add("mei-not-mei", f"{uri} returned {len(body)} bytes with no MEI root")
        return
    with open(out, "wb") as fh:
        fh.write(body)
    log(f"  pinned {uri} -> {out} ({len(body) / 1024:.0f} KB)")


# -------------------------------------------------------------------------- audio
def probe_rate(path):
    if not (shutil.which("ffprobe") and os.path.exists(path)):
        return None
    r = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "a:0",
         "-show_entries", "stream=sample_rate", "-of", "csv=p=0", path],
        capture_output=True, text=True)
    try:
        return int(r.stdout.strip())
    except ValueError:
        return None


def step_audio(args, sets, warnings):
    log("audio:")
    if not shutil.which("ffmpeg"):
        warnings.add("no-ffmpeg", "ffmpeg is not on PATH; skipping the transcode")
        return
    os.makedirs(args.audio_dir, exist_ok=True)
    wav_dir = os.path.join(REPO, "app/static/wav/Fledermaus")
    for key in CURATED:
        src = os.path.join(wav_dir, key)
        dst = os.path.join(args.audio_dir, f"{slugify(key)}.mp3")
        if not os.path.exists(src):
            warnings.add("source-wav-missing", f"{src}")
            continue
        if os.path.exists(dst) and not args.force:
            log(f"  skip {os.path.basename(dst)} (exists; --force to redo)")
            continue
        rate = probe_rate(src)
        cmd = [
            "ffmpeg", "-v", "error", "-y", "-i", src,
            # 48 kHz for every recording, whatever the source: see §5.2e.
            "-ar", "48000", "-ac", "2",
            # VBR, because windowed-audio-player.js's seek index is built for it
            # and Spike C confirmed the VBR path on the device.
            "-codec:a", "libmp3lame", "-q:a", str(args.quality),
            dst,
        ]
        r = subprocess.run(cmd, capture_output=True, text=True)
        if r.returncode != 0:
            warnings.add("transcode-failed", f"{key}: {r.stderr.strip()[:200]}")
            continue
        mb = os.path.getsize(dst) / 1048576
        log(f"  {slugify(key)}.mp3  {mb:5.1f} MB  ({rate or '?'} -> 48000 Hz)")


# --------------------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--steps", nargs="+", default=["payload", "mei", "audio"],
                    choices=["payload", "mei", "audio"])
    ap.add_argument("--src-dir", default=os.path.join(REPO, "ExhibitAnnots"))
    ap.add_argument("--data-dir", default=os.path.join(REPO, "app/static/exhibit/data"))
    ap.add_argument("--audio-dir", default=os.path.join(REPO, "app/static/exhibit/audio"))
    ap.add_argument("--quality", type=int, default=4, help="libmp3lame -q:a (0 best, 9 worst)")
    ap.add_argument("--force", action="store_true", help="redo work whose output already exists")
    ap.add_argument("--no-score", dest="with_score", action="store_false",
                    help="omit body.score (the score view is an optional bonus)")
    ap.add_argument("--no-probe", dest="probe", action="store_false",
                    help="skip ffprobe of the source wavs")
    ap.add_argument("--self-test", action="store_true",
                    help="check the index arithmetic against align-core and exit")
    args = ap.parse_args()
    args.timestamp = datetime.now(timezone.utc).replace(microsecond=0).isoformat()

    if args.self_test:
        self_test(args.src_dir)
        return

    warnings = Warnings()
    log(f"reading {args.src_dir}")
    sets = load_sources(args.src_dir)

    if "payload" in args.steps:
        step_payload(args, sets, warnings)
    if "mei" in args.steps:
        step_mei(args, sets, warnings)
    if "audio" in args.steps:
        step_audio(args, sets, warnings)

    log("")
    if warnings:
        log(f"{len(warnings)} warning(s):")
        for w in warnings:
            log(f"  - {w['kind']}: {w['detail']}")
        log("")
        log("Warnings are recorded in the payload's `warnings` array too, so the exhibit")
        log("can surface data problems rather than rendering them silently.")
    else:
        log("no warnings")


if __name__ == "__main__":
    main()
