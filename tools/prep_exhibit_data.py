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
* **Hand corrections travel INSIDE the HQ alignment, never beside it.** Fix mode
  (plan §14, `?fixMode`) writes corrected `ref_onset`/`ref_offset` values in place
  and the anchor/gap record under `header.corrections`; this script copies that
  record's counts and base into `source.corrections`, so a payload says whether it
  was built from a corrected alignment. The flow after a correcting session:
  Save data → `alignment.json`; replace `ExhibitAnnots/Alignment_Fledermaus_HQ.json`
  with it (keep the dated predecessor); re-run `--steps payload`. Note what that
  moves: score↔ref corrections change `body.score` only — every region time here
  re-derives through the audio-to-audio grids, which such corrections never touch —
  so nothing on the wall moves until the exhibit's score view reads `body.score`.
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
* **Audio is transcoded to 48 kHz** (§5.2e). The corpus is mixed 44.1/48 — it was
  an exact VPO/non-VPO split at eight, and stopped being one at ten (VPO-1951-1954
  is 44.1, so it is six 48 kHz against four 44.1) — and the
  iPad's AudioContext runs at 48 kHz, so half the set would hit iOS's resampling
  path inside `windowed-audio-player.js`'s gapless calibration. Resampling once,
  offline, deletes that risk instead of testing it, and costs no re-alignment
  because resampling preserves duration and the grids are in seconds.
* **`linkedDataUriPrefix` stays PER ANNOTATION.** The three sets disagree
  (`…/fledermaus`, `…/fledermausadults`, `…/fledermausEXPERTS`, and the HQ run's
  `…/Fledermaus/`), and the prefix mints identifiers that already exist. Picking a
  winner would silently re-identify somebody's annotations.

* **A second piece is a table entry, not a fork of this script** (PIECES below,
  `--piece`): its alignment source, curated recordings, canonical pairs, wav
  directory, title, and opus. Kaiserwalzer (op. 437, the attract loop's next
  piece, plan §4.4 R6) is the first — PROVISIONAL, from a fast-preset alignment
  with no annotation sets, and its payload says so in `warnings`.

Usage:
    tools/prep_exhibit_data.py                     # everything, Die Fledermaus
    tools/prep_exhibit_data.py --steps payload     # just the merge
    tools/prep_exhibit_data.py --steps audio --force
    tools/prep_exhibit_data.py --piece kaiserwalzer  # the second piece (all steps)
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

# The curated set: reference first, then chronological, then the non-VPO four.
#
# EIGHT UNTIL 2026-09-01, when the author raised the cap to TEN for this piece and
# every future one (Q1). The eight were forced: the four narrow annotations plus
# the reference, landing on an exact 4 VPO / 4 non-VPO split, which is also the
# 48 kHz / 44.1 kHz split (§5.2e). The two additions are chosen, not forced:
#   VPO-2002       her own pick — the pivot recording of "D or E?", the year the
#                  correction first appears. Without it the annotation names a
#                  moment a visitor cannot hear (Q2, answered by adding it).
#   VPO-1951-1954  unstrands the danced-origins argument in Agogic and "Schwung"
#                  (Q3): 239 characters that had nowhere to appear.
# TEN IS A CAP, NOT A TARGET. Adding an eleventh needs the author, not this file.
CURATED = [
    "VPO-2010.wav",  # the reference, and the slowest
    "VPO-1951-1954.wav",
    "VPO-1987.wav",  # NB: the plain file is the 48 kHz one; both alternate 1987 releases are 44.1
    "VPO-1989.wav",
    "VPO-2002.wav",
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
    "rgn_mrxebibu_3": (26315, 29120),  # Kids, Clapping Detective
    "rgn_mrxej01r_5": (2843, 2866),   # Kids, Lonely Bell (a)
    "rgn_mrxeqqiz_6": (2755, 3420),   # Kids, Lonely Bell (b)
    "rgn_ms4gs23a_2": (25280, 26589),  # Kids, Rollercoaster Ending
}

# Zero-length regions: a re-derive cannot repair one, and drawing it would put an
# invisible target on the wall, so the payload drops it and the author must delete
# it at source. EMPTY since 2026-09-01: the one known instance, Kids / Clapping
# Detective's `rgn_mrxa6xz4_2`, was deleted at source on the author's instruction
# (Q8). The mechanism stays for the next one.
DEGENERATE_REGIONS = set()

# Region → recordings whose times Chanda hand-places, and which this script must
# therefore leave alone once they arrive in the overrides file (§5.2d).
NEEDS_HAND_PLACEMENT = {"rgn_msvors30_2"}

OVERRIDES_FILE = "overrides.json"

# The rest of the Fledermaus description: where its wavs are, where its audio goes,
# and what the band calls it. `audio/<slug>.mp3` is the FROZEN layout for this piece:
# the audio directory is shared between worktrees while the payloads are per tree,
# so moving the ten files would break whichever tree has not been regenerated.
WAV_DIR = "app/static/wav/Fledermaus"
AUDIO_SUBDIR = ""  # "" = audio/<slug>.mp3; later pieces get audio/<piece>/<slug>.mp3
PIECE_TITLE = {"en": "Die Fledermaus — Overture"}
PIECE_COMPOSER = "Johann Strauss II"
# No opus, and that is CORRECT rather than missing: Strauss II's dances and
# marches are opus-numbered, his operettas are not, and the graph agrees (the
# overture's Work entity is titled without one while sibling dance works all
# carry theirs, e.g. "Sängerslust, op. 328"). The exhibit displays `opus` when a
# piece carries it — Kaiserwalzer (op. 437) is the first to use it.
PIECE_OPUS = None
DEFAULT_SRC_DIR = os.path.join(REPO, "ExhibitAnnots")
ALIGNMENT_IS_HQ = True

# --------------------------------------------------------------------------- pieces
# A SECOND PIECE (attract loop v2, 2026-09-10; plan §4.4 R6: Kaiserwalzer next,
# about ten pieces by December). The Fledermaus constants above are the module's
# defaults and keep their reasoning in place; `--piece` swaps in another entry
# from this table by rebinding those globals (apply_piece) — a script-sized
# answer, chosen over threading a piece object through a dozen functions.
#
# Kaiserwalzer is PROVISIONAL in every respect and its payload says so:
#   * the spine is `alignment-fast.json` (Listen Here! v0.18.0, the FAST preset:
#     coarse 4, slack 80) — the only Kaiserwalzer alignment in the tree. The
#     §5.2c lesson stands: the HQ re-alignment comes BEFORE any annotation is
#     authored against it, and the payload carries an `alignment-not-hq` warning
#     until then. Cursors and aligned switches may sit seconds off in places.
#   * no audience sets exist, so no annotations, no canonical pairs, and no
#     overrides file — the attract loop plays the piece through without a switch.
#   * the ten recordings are a PROPOSAL, not the author's curation: the
#     alignment's reference and the six other VPO concert years the corpus
#     holds, then three non-VPO recordings with a named conductor and year —
#     Karajan's 1984 Berlin recording, Bernstein's 1982 New York one, and
#     Kendlinger 2010, which the Fledermaus set also has. Left out: the
#     compilations, the two synthetic references, the year-range VPO discs,
#     Böhm 1939 (a 4:36 cut), Furtwängler 1950, and the second Karajan. The
#     author decides; ten is the cap.
#   * audio goes to `audio/kaiserwalzer/`: two file names are shared with the
#     Fledermaus corpus (VPO-1987, Kendlinger 2010) and would collide in `audio/`.
#   * metadata.json (conductor, year, portrait) knows only the Fledermaus set,
#     so the band names nobody for the eight recordings it has not met;
#     prep_exhibit_metadata.py needs these recordings' RDF slugs first.
PIECES = {
    "fledermaus": None,  # the module defaults above
    "kaiserwalzer": {
        "src_dir": os.path.join(REPO, "app/static/wav/Kaiserwalzer"),
        "sources": {"hq": "alignment-fast.json"},
        "audiences": [],
        "curated": [
            "VPO-2021.wav",  # the alignment's reference, and the slowest (13:33)
            "VPO-1987.wav",
            "VPO-1991.wav",
            "VPO-1996.wav",
            "VPO-2003.wav",
            "VPO-2008.wav",
            "VPO-2016.wav",
            "1984_Berliner Philharmoniker, Karajan (Kaiser–Walzer).wav",
            "New York Philharmonic, Leonard Bernstein (1982).wav",
            "K&K Philharmoniker, Kendlinger (2010).wav",
        ],
        "pairs": {},
        "needs_hand_placement": set(),
        "wav_dir": "app/static/wav/Kaiserwalzer",
        "audio_subdir": "kaiserwalzer",
        "title": {"en": "Kaiser-Walzer", "de": "Kaiser-Walzer"},
        "composer": "Johann Strauss II",
        "opus": "op. 437",
        "alignment_is_hq": False,
    },
}


def apply_piece(name):
    """Rebind the module's piece constants to PIECES[name]; the default stays put."""
    global PIECE, SOURCES, AUDIENCES, CURATED, CANONICAL_PAIRS, NEEDS_HAND_PLACEMENT
    global WAV_DIR, AUDIO_SUBDIR, PIECE_TITLE, PIECE_COMPOSER, PIECE_OPUS
    global DEFAULT_SRC_DIR, ALIGNMENT_IS_HQ
    spec = PIECES[name]
    PIECE = name
    if spec is None:
        return
    SOURCES = dict(spec["sources"])
    AUDIENCES = list(spec["audiences"])
    CURATED = list(spec["curated"])
    CANONICAL_PAIRS = dict(spec["pairs"])
    NEEDS_HAND_PLACEMENT = set(spec["needs_hand_placement"])
    WAV_DIR = spec["wav_dir"]
    AUDIO_SUBDIR = spec["audio_subdir"]
    PIECE_TITLE = spec["title"]
    PIECE_COMPOSER = spec["composer"]
    PIECE_OPUS = spec["opus"]
    DEFAULT_SRC_DIR = spec["src_dir"]
    ALIGNMENT_IS_HQ = bool(spec.get("alignment_is_hq", True))


def audio_rel(key):
    """The payload's audio path, relative to the exhibit ROOT (see build_recordings)."""
    return f"audio/{AUDIO_SUBDIR}/{slugify(key)}.mp3" if AUDIO_SUBDIR else f"audio/{slugify(key)}.mp3"

# A per-recording note this short is a data cell, not something written for a
# reader. Five of the "D or E?" notes were the two characters "E6" until the author
# replaced them with sentences (Q5) — but only on the recordings that were curated
# at the time. Raising the cap can pull a bare one into view, so this warns rather
# than waiting for somebody to notice it on the wall.
STUB_TEXT_CHARS = 8


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
            "audio": audio_rel(key),
            "duration": entry["duration"],
            "peaks": entry["peaks"],
            "times": entry["times"],
        }
        if probe:
            rate = probe_rate(os.path.join(REPO, WAV_DIR, key))
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
                desc = (tgt.get("description") or "").strip()
                if 0 < len(desc) < STUB_TEXT_CHARS:
                    warnings.add("stub-target-text",
                                 f"{audience}/{ann['label']} → {tgt['file']}: "
                                 f"{desc!r} is a data cell, not a sentence. The "
                                 f"AUTHOR must write it out (Q5).")
                targets.append({
                    "file": tgt["file"],
                    "description": lang_map(tgt.get("description")),
                    # Times are filled by rederive_times(); never copied from source.
                    "regionTimes": {rid: None for rid in kept_region_ids},
                })
            if dropped:
                warnings.add("targets-outside-curation",
                             f"{audience}/{ann['label']}: {dropped} of "
                             f"{len(ann.get('targets', []))} targets are not in the curated set",
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
                # Between-group descriptions (the authoring tool's `comparisons`
                # field, keyed by stable groupIds). None are authored yet
                # (2026-08-24) but they are planned; carrying them through now
                # means the day one is written it appears on the glass.
                "comparisons": [
                    {
                        "id": c.get("id"),
                        "leftGroupId": c.get("leftGroupId"),
                        "rightGroupId": c.get("rightGroupId"),
                        "text": lang_map(c.get("text")),
                    }
                    for c in (ann.get("comparisons") or [])
                    if (c.get("text") or "").strip()
                ],
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
                "it. Chanda hand-places it on the curated recordings AFTER the",
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


def summarise_corrections(record):
    """The HQ alignment's hand-correction record (header.corrections, written by
    fix mode) as provenance: the counts plus the base the anchors were laid on.
    None for an uncorrected alignment — the normal state before hand-correction."""
    if not isinstance(record, dict):
        return None
    return {
        "version": record.get("version"),
        "anchors": len(record.get("anchors") or []),
        "gaps": len(record.get("gaps") or []),
        "base": record.get("base"),
    }


def describe_corrections(summary):
    if summary is None:
        return "none (an uncorrected alignment)"
    return (f"{summary['anchors']} anchors, {summary['gaps']} unscored-audio gaps "
            "(a hand-corrected alignment)")


def step_payload(args, sets, warnings):
    log("payload:")
    verify_pairs(sets, warnings)
    check_ids(sets, warnings)
    recordings = build_recordings(sets["hq"], warnings, probe=args.probe)
    annotations = build_annotations(sets, warnings)
    rederive_times(annotations, recordings, warnings)

    os.makedirs(args.data_dir, exist_ok=True)
    if AUDIENCES:
        overrides_path = os.path.join(args.data_dir, OVERRIDES_FILE)
        seed_overrides(overrides_path)
        overrides = load_overrides(overrides_path, warnings)
        apply_overrides(annotations, overrides, warnings)
        pending_hand_placement(annotations, warnings)
    else:
        # Nothing to hand-place without annotations; seeding the D-or-E slot for
        # a piece that has no "D or E?" would be a lie in a committed file.
        log("  overrides: none — this piece has no annotation sets")

    hq_header = sets["hq"]["header"]
    corrections = summarise_corrections(hq_header.get("corrections"))
    log(f"  corrections: {describe_corrections(corrections)}")
    if not ALIGNMENT_IS_HQ:
        warnings.add("alignment-not-hq",
                     f"{SOURCES['hq']} is not an HQ-preset alignment "
                     f"(params {hq_header.get('alignmentParams')}); cursors and aligned "
                     f"switches may sit seconds off in places. Re-align at hq BEFORE any "
                     f"annotation is authored against this piece (plan §5.2c).")
    payload = {
        "schema": SCHEMA,
        "piece": {
            "id": PIECE,
            "title": PIECE_TITLE,
            "composer": PIECE_COMPOSER,
            "opus": PIECE_OPUS,  # None is a fact for Die Fledermaus — see PIECE_OPUS
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
            "corrections": corrections,
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
    out_dir = os.path.join(args.audio_dir, AUDIO_SUBDIR) if AUDIO_SUBDIR else args.audio_dir
    os.makedirs(out_dir, exist_ok=True)
    wav_dir = os.path.join(REPO, WAV_DIR)
    for key in CURATED:
        src = os.path.join(wav_dir, key)
        dst = os.path.join(out_dir, f"{slugify(key)}.mp3")
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
    ap.add_argument("--piece", default="fledermaus", choices=sorted(PIECES),
                    help="which piece to build (PIECES); the default is Die Fledermaus")
    ap.add_argument("--src-dir", default=None,
                    help="where the alignment sources are; defaults per piece "
                         "(ExhibitAnnots/ for Die Fledermaus)")
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
    apply_piece(args.piece)
    if args.src_dir is None:
        args.src_dir = DEFAULT_SRC_DIR
    log(f"piece: {args.piece}")

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
