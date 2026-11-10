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
  copied.** Alignment indices are portable across re-alignments ON ONE REFERENCE
  and times are not: every grid is as long as the reference's frames (29,121 on
  VPO-2010 until 2026-11-10; 26,844 on VPO-2022 since), whatever the preset
  (§5.2c). A new reference needs `exhibit_annots_on_hq.py --reanchor`. Only ONE time per region was ever authored — the rest
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
  so those alone move nothing on the wall until the exhibit's score view reads
  `body.score`. AUDIO-TO-AUDIO corrections (0.59.0, `header.corrections.audio`,
  keyed per recording) rewrite that recording's grid in place, so every region
  whose index pair falls in a refilled span gets new times on that recording at
  the next payload build: the wall MOVES, by design — the exhibit's regions were
  never verified and wait for exactly this. `source.corrections.audio` names the
  corrected recordings; diff the derived region times before and after a build.
  A hand-placed override on a corrected recording is warned about below: it is
  never recomputed, so it may now disagree with the grid around it.
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
  piece, plan §4.4 R6) is the first: Chanda's sets on her balanced-preset body,
  its score borrowed from the fast run on the same reference grid (PIECES).

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

# The spine since 2026-11-10: the corrected score alignment re-based onto Eulenburg
# 2f44c21 (the sectioned MEI), reference VPO-2022, with the audio-to-audio grids of
# the eleven recordings it lacked spliced in from Fledermaus-all-fixed.json (same
# reference, identical reference grid; see its header.additions[].splicedFrom). A
# new reference makes every old index meaningless, so the audience sources are
# Chanda's sets RE-ANCHORED onto it (tools/exhibit_annots_on_hq.py --reanchor
# --out-dir ExhibitAnnots/on-hq-2026-11-10), as for the Pizzicato-Polka; AUTHORED
# names her originals, which that tool reads. Its own name, not a replacement of
# Alignment_Fledermaus_HQ.json: ExhibitAnnots/ is shared with checkouts whose
# pairs table still describes the September spine (VPO-2010, 29,121 frames).
SOURCES = {
    "hq": "Alignment_Fledermaus_HQ.2026-11-10.json",
    "kids": "on-hq-2026-11-10/Fledermaus_Kids_on_HQ.json",
    "adults": "on-hq-2026-11-10/Fledermaus_Adults_on_HQ.json",
    "expert": "on-hq-2026-11-10/Fledermaus_Expert_on_HQ.json",
}
AUTHORED = {
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
    "VPO-2010.wav",  # the slowest; the reference until 2026-11-10 (now VPO-2022), kept first so the wall's order holds
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
# On the VPO-2022 grid (26,844 frames), voted by --reanchor 2026-11-10 from the
# authored seconds; the vote and every residual are in
# ExhibitAnnots/on-hq-2026-11-10/annots-on-hq-report.md. FLAG = some target lands
# more than 0.5 s from its authored time: an ear check, not yet a correction.
# The September table (VPO-2010 grid, 29,121 frames) is in git history.
CANONICAL_PAIRS = {
    "rgn_ms4sh8ta_2": (3068, 3717),    # Adults, "Die Glocke" — FLAG 0.65 s
    "rgn_ms4su3uj_4": (5425, 7771),    # Adults, Keeping time
    "rgn_msu6vl9p_2": (8734, 9673),    # Adults, The Viennese Lilt
    "rgn_msvors30_2": (990, 1005),     # Expert, D or E? (a) — NEEDS HAND-PLACEMENT (§5.2d)
    "rgn_msvos2fy_3": (747, 1175),     # Expert, D or E? (b) — FLAG 1.05 s
    "rgn_msvpcupp_5": (12468, 13663),  # Expert, Oboe Solos (a) — FLAG 1.28 s
    "rgn_msvpd6fv_6": (14622, 15235),  # Expert, Oboe Solos (b)
    "rgn_msvqekba_8": (8481, 9296),    # Expert, Agogic and "Schwung"
    # Its one target, VPO-1989, claps from 7:46.8 to 8:44.4: past the music, so
    # past the end of the VPO-2022 grid, whose last frame reaches only 7:51.5 of
    # it. No pair can say this; it needs a hand-placed override.
    "rgn_mrxebibu_3": (25366, 26843),  # Kids, Clapping Detective — FLAG 52.85 s
    "rgn_mrxej01r_5": (3133, 3181),    # Kids, Lonely Bell (a) — FLAG 0.66 s
    "rgn_mrxeqqiz_6": (3068, 3691),    # Kids, Lonely Bell (b)
    "rgn_ms4gs23a_2": (24265, 25797),  # Kids, Rollercoaster Ending — FLAG 0.81 s
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
# Kaiserwalzer (annotated 2026-11-10):
#   * the spine is the body Chanda authored her three sets on (they share it):
#     Listen Here! v0.109.0, 2026-11-03, reference VPO-2021, the BALANCED preset
#     (coarse 2, slack 120), open ends, 28 recordings, audio-to-audio only. Every
#     region is a clean projection on it (all targets agree on one pair), so the
#     pairs are hers, with no re-anchoring. Ruled by the user 2026-11-10 over an
#     HQ run first: an HQ run can still come, through --reanchor. The payload
#     keeps its `alignment-not-hq` warning until then.
#   * the score (sections, the score view, the MEI) is BORROWED from
#     `alignment-fast.json` (v0.18.0, fast preset), SOURCES["score"]: both have
#     VPO-2021 as reference and an identical reference grid (40,671 frames), and
#     score_set() asserts that, since sections are index pairs on that grid.
#   * the ten are Chanda's OPTION A (2026-11-10): her nine questions target 22
#     recordings, and the two curation rules (answers shown; recordings a text
#     points to shown) needed 13, over the cap of ten. She kept all nine
#     questions and dropped Aebi 1996, Falk, and VPO-2008, rewording the three
#     texts that counted them ("six versions", "these three", "the four most
#     recent") through the overrides file's `texts` (apply_texts), with her
#     typo fixes. "Das Grosse Neujahrskonzert" IS Rieu's 2012 recording (the
#     user, same day), not the separate ext-…Rieu file.
#   * audio goes to `audio/kaiserwalzer/`: two file names are shared with the
#     Fledermaus corpus (VPO-1987, Kendlinger 2010) and would collide in `audio/`.
#   * metadata.json (conductor, year, portrait) knows only the Fledermaus set,
#     so the band names nobody for the eight recordings it has not met;
#     prep_exhibit_metadata.py needs these recordings' RDF slugs first.
PIECES = {
    "fledermaus": None,  # the module defaults above
    "kaiserwalzer": {
        "src_dir": os.path.join(REPO, "ExhibitAnnots"),
        "sources": {
            "hq": "Kaiserwalzer_Alignment_Experts.json",  # her body; the three share it
            "score": os.path.join(REPO, "app/static/wav/Kaiserwalzer/alignment-fast.json"),
            "kids": "Kaiserwalzer_alignment_kids.json",
            "adults": "Kaiserwalzer_Alignment-Adults.json",
            "expert": "Kaiserwalzer_Alignment_Experts.json",
        },
        "audiences": ["kids", "adults", "expert"],
        "curated": [
            "VPO-2021.wav",  # the alignment's reference, and the slowest (13:33)
            "VPO-1987.wav",
            "VPO-2003.wav",
            "VPO-2016.wav",
            "Wiener Philharmoniker (10 CDs_4-6).wav",  # Karajan 1946
            "SächsischeStaatskapelleDresden_KarlBöhm_1939.wav",
            "Das Grosse Neujahrskonzert, mixed.wav",  # Rieu 2012
            "K&K Philharmoniker, Kendlinger (2010).wav",
            "New York Philharmonic, Leonard Bernstein (1982).wav",
            "1984_Berliner Philharmoniker, Karajan (Kaiser–Walzer).wav",
        ],
        # On the VPO-2021 grid (40,671 frames), derived 2026-11-10 by
        # exhibit_annots_on_hq.py --derive-pairs from each set: every target agrees.
        "pairs": {
            "rgn_mw0s20mp_15": (669, 2285),     # Kids, How quick is the tip-toeing king?
            "rgn_mw0spfnj_18": (9652, 12146),   # Kids, Who brought the bells (and the piano)?
            "rgn_mw0t0kmz_20": (24114, 24872),  # Kids, Taking an extra "breath"
            "rgn_mw0qanf1_8": (1149, 3689),     # Adults, The same conductor, same orchestra, 41 years apart
            "rgn_mw0qs8wm_10": (9212, 11230),   # Adults, Who tunes higher?
            "rgn_mw0r99p9_13": (31228, 39447),  # Adults, The dancer's shortcut
            "rgn_mw0k63z2_2": (18712, 20112),   # Expert, Prussian boots or Viennese Schwung?
            "rgn_mw0l9ywl_4": (5921, 7270),     # Expert, The lengthening (?) cello solo
            "rgn_mw0m1btd_6": (12054, 16395),   # Expert, Which recordings take the second waltz's repeat?
        },
        "needs_hand_placement": set(),
        "wav_dir": "app/static/wav/Kaiserwalzer",
        "audio_subdir": "kaiserwalzer",
        "title": {"en": "Kaiser-Walzer", "de": "Kaiser-Walzer"},
        "composer": "Johann Strauss II",
        "opus": "op. 437",
        "alignment_is_hq": False,
    },
    # Pizzicato-Polka (2026-10-20), audio-to-audio only (no score):
    #   * Chanda authored her three sets on a balanced-preset body whose
    #     reference, the Volksoper "New Year's Concerto" recording (291 s),
    #     plays the piece TWICE, so the others stalled over 106–132 s of it.
    #     The spine is now an HQ re-alignment on VPO-1989 WITHOUT the Volksoper
    #     (its stalls are gone: 0–11 isolated seconds per recording), and her
    #     regions were re-anchored onto it from their per-recording seconds.
    #     Her three Volksoper targets were dropped with it.
    #   * "The Coda Over Time" found NO consensus in that vote (every authored
    #     start came through the old stall): its pair is a best guess until the
    #     author sets the coda's start by ear.
    #   * the ten are a PROPOSAL (2026-10-20): every question annotation keeps
    #     the recording that answers it (Järvi for "Extra notes", VPO-2005 for
    #     "An extra pick-up" — user, 2026-10-20), and every recording a shown
    #     text points to is shown too (VPO-1987, Karajan's VPO recording, from
    #     Twinkle's answer; VPO-1941 and 1951-1954, Krauss a decade apart, in
    #     the Coda). Harnoncourt is the tenth because he adds to the three
    #     annotations otherwise down to two recordings. The author decides.
    #   * no opus: the Cranz edition prints "Op. 257", unverified against the
    #     catalogue, and the wall shows what it is given.
    "pizzicato": {
        "src_dir": os.path.join(REPO, "ExhibitAnnots/Pizzicato"),
        # The HQ re-alignment (2026-10-20: reference VPO-1989, hq preset, open
        # ends, the Volksoper left out). The audience sources are Chanda's sets
        # RE-ANCHORED onto it (tools/exhibit_annots_on_hq.py --piece pizzicato
        # --reanchor), so verify_pairs votes on the new grids; her originals,
        # which carry the old Volksoper body, are what that tool reads.
        "sources": {
            "hq": "Alignment_Pizzicato_HQ.json",
            "kids": "on-hq/Pizzicato_Kids_on_HQ.json",
            "adults": "on-hq/Pizzicato_Adults_on_HQ.json",
            "expert": "on-hq/Pizzicato_Expert_on_HQ.json",
        },
        "authored": {
            "kids": "PizzicatoPolka_Kids.json",
            "adults": "PizzicatoPolka_Adults.json",
            "expert": "PizzicatoPolka_Experts.json",
        },
        "audiences": ["kids", "adults", "expert"],
        "curated": [
            "VPO-1989.wav",  # the reference
            "VPO-1941 (& unbekannt).wav",
            "VPO-1951-1954.wav",
            "VPO-1987.wav",  # Karajan with the VPO: Twinkle's answer (1971) points to it
            "VPO-2005.wav",  # the "yes" of "An extra pick-up"
            "VPO-2012.wav",
            "Berliner Philharmoniker, Herbert von Karajan (1971).wav",
            "Estonian National Symphony Orchestra, Neeme Järvi (2017).wav",  # the "yes" of "Extra notes"
            "Das Grosse Neujahrskonzert, mixed.wav",  # the sung version
            "mixed, Nikolaus Harnoncourt (Johann Strauss II).wav",
        ],
        # On the VPO-1989 grid (10,129 frames), voted by --reanchor 2026-10-20;
        # the vote and every residual are in on-hq/annots-on-hq-report.md.
        "pairs": {
            "rgn_mv6e4h6f_2": (2147, 2389),   # Adults, Extra notes
            "rgn_mv6eui2q_7": (246, 566),     # Adults, Plucked throughout?
            "rgn_mv6f30wj_9": (5257, 6968),   # Adults, Blimm bloom blimm
            "rgn_mv6fv18j_11": (1381, 1810),  # Expert, An extra pick-up
            "rgn_mv6g8s8m_14": (574, 1075),   # Expert, The poco rit. (b)
            "rgn_mv6gvab3_16": (7674, 8598),  # Expert, The Coda Over Time — start by ear (reanchor_fixed)
            "rgn_mv6n3dvj_18": (3050, 4150),  # Kids, Twinkle Twinkle Little Glockenspiel
            "rgn_mv6nh4m7_20": (4166, 5286),  # Kids, The jingling tambourine
            "rgn_mv6no4fq_22": (619, 2293),   # Kids, The singing version!
        },
        # Endpoints placed BY EAR, which --reanchor takes instead of its vote.
        # The Coda's start (no consensus: every authored start came through the
        # old stall): the user, 2026-10-20, on Karajan's VPO recording, "2:25,
        # almost going into 2:26 — the start of the phrase, highest-pitch plucked
        # note as the first"; 145.75 s is the spectral-flux onset there.
        "reanchor_fixed": {
            "rgn_mv6gvab3_16": {"start": ("VPO-1987.wav", 145.75)},
        },
        # EMPTY since 2026-10-20: poco rit. (a), rgn_mv6g84m9_13, 0.0–0.0 on all
        # seven targets, was deleted at source on the user's ruling.
        "degenerate": set(),
        "needs_hand_placement": set(),
        "wav_dir": "app/static/wav/Pizzicato",
        "audio_subdir": "pizzicato",
        "title": {"en": "Pizzicato-Polka", "de": "Pizzicato-Polka"},
        "composer": "Johann Strauss II and Josef Strauss",
        "opus": None,
        "alignment_is_hq": True,
    },
}


def apply_piece(name):
    """Rebind the module's piece constants to PIECES[name]; the default stays put."""
    global PIECE, SOURCES, AUTHORED, AUDIENCES, CURATED, CANONICAL_PAIRS, NEEDS_HAND_PLACEMENT
    global WAV_DIR, AUDIO_SUBDIR, PIECE_TITLE, PIECE_COMPOSER, PIECE_OPUS
    global DEFAULT_SRC_DIR, ALIGNMENT_IS_HQ, DEGENERATE_REGIONS, OVERRIDES_FILE
    spec = PIECES[name]
    PIECE = name
    if spec is None:
        return
    # Per piece: the default file is Die Fledermaus's, and region ids never repeat
    # across pieces, so sharing it would only produce "unknown annotation" noise.
    OVERRIDES_FILE = f"{name}-overrides.json"
    SOURCES = dict(spec["sources"])
    AUTHORED = dict(spec.get("authored", {}))
    AUDIENCES = list(spec["audiences"])
    CURATED = list(spec["curated"])
    CANONICAL_PAIRS = dict(spec["pairs"])
    NEEDS_HAND_PLACEMENT = set(spec["needs_hand_placement"])
    DEGENERATE_REGIONS = set(spec.get("degenerate", ()))
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


def score_set(sets):
    """The set whose body.score and header.meiUri the payload uses.

    The spine's, unless the piece borrows them (SOURCES["score"]) from another
    alignment, which must then share the spine's reference AND its reference grid
    exactly: sections are index pairs on that grid, and score_onset/ref_onset are
    reference seconds. A mismatch fails the build, as verify_pairs does.
    """
    if "score" not in sets:
        return sets["hq"]
    hq, sc = sets["hq"], sets["score"]
    ref = hq["header"]["ref"]
    if (sc["header"].get("ref") != ref
            or (sc["body"]["audio"].get(ref) or {}).get("times") != hq["body"]["audio"][ref]["times"]):
        sys.exit(f"{SOURCES['score']} is not on the spine's reference grid ({ref}); "
                 f"its score cannot be borrowed")
    return sc


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
                    if rt.get("derived") is False:
                        # Hand-placed (an override overlaid by exhibit_annots_on_hq.py
                        # onto a set that is also a source): not a vote on the pair.
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
                                 f"{audience}/{ann['label']}/{reg['id']} is zero-length at index "
                                 f"{'–'.join(map(str, CANONICAL_PAIRS.get(reg['id'], ('?', '?'))))}; "
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


def apply_overrides(annotations, overrides, warnings, corrections=None):
    """Overlay hand-placed times. Applied LAST; a re-run must never recompute these.
    `corrections` (summarise_corrections' output) names the recordings whose grids
    carry audio-to-audio anchors: an override on one of those is flagged, since
    the grid around it moved and the hand-placed time did not."""
    applied = 0
    corrected = (corrections or {}).get("audio") or {}
    index = {a["id"]: a for a in annotations}
    for ann_id, regions in (overrides or {}).items():
        if ann_id.startswith("_") or ann_id in ("reveal", "sectionLabels", "texts"):
            continue  # a note key, the reveal list, the section labels, or text fixes — not times
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
                if filename in corrected:
                    warnings.add("override-on-corrected-grid",
                                 f"{ann_id}/{region_id}/{filename}: a hand-placed time on a "
                                 f"recording whose grid carries {corrected[filename]} "
                                 f"audio-to-audio anchor(s) — the grid around it moved and "
                                 f"this time did not; check it against the corrected grid or "
                                 f"retire the override")
    if applied:
        log(f"  applied {applied} hand-placed override times")
    else:
        log("  no overrides applied (none authored yet)")
    return applied


def apply_reveal(annotations, overrides, warnings):
    """Flag the annotations whose per-recording notes ANSWER the annotation's
    question ("Which recording has just the bell?" — "Here you hear the flutes
    as well"), so the exhibit can cover them until the reader asks (?reveal).
    An editorial list in the overrides file (`"reveal": [annotationId, ...]`),
    not the authoring tool's: the user, 2026-10-20 — a simple flag for now."""
    ids = (overrides or {}).get("reveal") or []
    index = {a["id"]: a for a in annotations}
    for ann_id in ids:
        ann = index.get(ann_id)
        if ann is None:
            warnings.add("reveal-unknown-annotation", f"reveal names {ann_id}, which is absent")
            continue
        ann["reveal"] = True
    if ids:
        log(f"  reveal: {sum(1 for a in annotations if a.get('reveal'))} annotation(s) answer behind a card")


def apply_texts(annotations, overrides, warnings, sets):
    """Editorial text fixes on top of the author's sets, so they survive a re-export
    (her sets are gitignored; a hand edit there is lost). The overrides file's
    `"texts"` key: { annotationId: { "label": [[find, replace], ...],
    "description": [...], "targets": { "recording.wav": [...] } } }, each a plain
    substring replace on the English text, in order. A find that no longer
    matches WARNS rather than fails: the author has fixed her own text, and the
    override can retire. A target outside the curated set is noted, not warned."""
    texts = (overrides or {}).get("texts") or {}
    if not texts:
        return
    index = {a["id"]: a for a in annotations}
    authored = {}
    for audience in AUDIENCES:
        for ann in sets[audience].get("annotations", []):
            authored[ann["id"]] = {t["file"] for t in ann.get("targets", [])}
    applied, unshown = 0, []

    def replace(where, field, fixes):
        nonlocal applied
        text = (field or {}).get("en")
        for find, repl in fixes:
            if text is None or find not in text:
                warnings.add("text-override-unmatched",
                             f"{where}: {find!r} is not in the text; fixed at source? "
                             f"Retire the override")
                continue
            text = text.replace(find, repl)
            applied += 1
        if text is not None:
            field["en"] = text.strip()

    for ann_id, spec in texts.items():
        if ann_id.startswith("_"):
            continue
        ann = index.get(ann_id)
        if ann is None:
            warnings.add("text-override-unknown-annotation", f"texts name {ann_id}, which is absent")
            continue
        for key in ("label", "description"):
            if spec.get(key):
                replace(f"{ann_id} {key}", ann[key], spec[key])
        by_file = {t["file"]: t for t in ann["targets"]}
        for filename, fixes in (spec.get("targets") or {}).items():
            tgt = by_file.get(filename)
            if tgt is not None:
                replace(f"{ann_id} → {filename}", tgt["description"], fixes)
            elif filename in authored.get(ann_id, ()):
                unshown.append(f"{ann_id} → {filename}")
            else:
                warnings.add("text-override-unknown-target",
                             f"texts name {ann_id} → {filename}, which is not authored")
    log(f"  texts: {applied} fix(es) applied"
        + (f"; {len(unshown)} on targets outside the curated set, skipped: "
           f"{', '.join(unshown)}" if unshown else ""))


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
    audio = {}
    for filename, slot in (record.get("audio") or {}).items():
        n = len((slot or {}).get("anchors") or [])
        if n:
            audio[filename] = n
    return {
        "version": record.get("version"),
        "anchors": len(record.get("anchors") or []),
        "gaps": len(record.get("gaps") or []),
        "audio": audio,  # recording → its audio-to-audio anchor count (0.59.0)
        "base": record.get("base"),
    }


def describe_corrections(summary):
    if summary is None:
        return "none (an uncorrected alignment)"
    text = (f"{summary['anchors']} anchors, {summary['gaps']} unscored-audio gaps "
            "(a hand-corrected alignment)")
    audio = summary.get("audio") or {}
    if audio:
        parts = ", ".join(f"{f} ({n})" for f, n in sorted(audio.items()))
        text += (f"; audio-to-audio anchors on {len(audio)} recording(s): {parts} — "
                 "their region times move with the corrected grids")
    return text


# ------------------------------------------------------------------------ sections
# The MEI's <section> tree, placed on the HQ grid (roadmap 28: the section
# ribbon). Two halves, joined by measure xml:id:
#   * the TREE comes from the pinned MEI, read here — ids, nesting, bar numbers,
#     and a label from the overrides file's `sectionLabels` or the MEI's @label;
#   * the TIMES come from tools/mei_measure_times.mjs — Verovio's measure
#     quarters mapped to reference seconds by engine/time-map.js — because this
#     script has no Verovio and a second copy of that chain is how two consumers
#     start disagreeing about when a bar begins. The tool also REFUSES an MEI
#     whose onset quarters differ from the alignment's score, which is the
#     guard against a pinned MEI that drifted from the alignment.
# Each section becomes an index PAIR on the reference grid, like a region: the
# exhibit reads recordings[file].times[ix], so every recording's section times
# come from the same grids as everything else on the wall. A section ends where
# the next measure in document order starts; the last one at the alignment's
# latest note-off.
MEI_NS = "{http://www.music-encoding.org/ns/mei}"
XML_ID = "{http://www.w3.org/XML/1998/namespace}id"


def read_section_tree(mei_path):
    """[(section element, depth, parent id)] in document order, plus every
    measure id in document order. Endings count as sections (a volta is a span
    a reader may want to see), with their own nesting."""
    import xml.etree.ElementTree as ET

    root = ET.parse(mei_path).getroot()
    body = next(root.iter(MEI_NS + "body"), None)
    if body is None:
        return [], []
    found = []

    def walk(el, depth, parent):
        for child in el:
            tag = child.tag if isinstance(child.tag, str) else ""
            if tag in (MEI_NS + "section", MEI_NS + "ending"):
                found.append((child, depth, parent))
                walk(child, depth + 1, child.get(XML_ID))
            elif tag != MEI_NS + "measure":
                walk(child, depth, parent)

    walk(body, 0, None)
    measure_ids = [m.get(XML_ID) for m in body.iter(MEI_NS + "measure")]
    return found, measure_ids


def measure_times(alignment_path, mei_path, warnings):
    """Run tools/mei_measure_times.mjs; None (with a warning) when it cannot."""
    if not shutil.which("node"):
        warnings.add("no-node", "node is not on PATH; the payload gets no sections")
        return None
    r = subprocess.run(
        ["node", "--no-warnings", os.path.join(REPO, "tools/mei_measure_times.mjs"),
         "--alignment", alignment_path, "--mei", mei_path],
        capture_output=True, text=True)
    if r.returncode != 0:
        # Verovio's own chatter goes to stderr too; the refusal is its last lines.
        tail = " | ".join(r.stderr.strip().splitlines()[-4:])
        warnings.add("sections-failed", f"mei_measure_times.mjs refused: {tail}")
        return None
    return json.loads(r.stdout)


def build_sections(args, sets, overrides, warnings):
    hq = sets["hq"]
    if not (score_set(sets)["body"].get("score") or {}).get("score_onset"):
        log("  sections: none — the alignment is not score-aligned")
        return None
    mei_path = os.path.join(args.data_dir, f"{PIECE}.mei")
    if not os.path.exists(mei_path):
        warnings.add("no-sections", f"{mei_path} is not pinned yet; run --steps mei")
        return None
    tree, measure_ids = read_section_tree(mei_path)
    if not tree:
        log("  sections: none — the MEI has no <section>")
        return None
    timed = measure_times(os.path.join(args.src_dir, SOURCES.get("score", SOURCES["hq"])),
                          mei_path, warnings)
    if timed is None:
        return None
    ref_sec = {m["id"]: m["refSec"] for m in timed["measures"]}
    missing = [mid for mid in measure_ids if mid not in ref_sec]
    if missing:
        warnings.add("sections-measure-untimed",
                     f"{len(missing)} measure(s) have no timemap entry, e.g. {missing[:3]}")
        return None
    position = {mid: i for i, mid in enumerate(measure_ids)}
    ref_grid = hq["body"]["audio"][hq["header"]["ref"]]["times"]
    labels = (overrides or {}).get("sectionLabels") or {}

    out, unlabelled = [], []
    for el, depth, parent in tree:
        sid = el.get(XML_ID)
        bars = [m for m in el.iter(MEI_NS + "measure")]
        if not bars:
            warnings.add("section-empty", f"section {sid} holds no measure")
            continue
        first, last = bars[0].get(XML_ID), bars[-1].get(XML_ID)
        after = position[last] + 1
        start = ref_sec[first]
        end = ref_sec[measure_ids[after]] if after < len(measure_ids) else timed["end"]["refSec"]
        label = lang_map(labels.get(sid)) or lang_map(el.get("label"))
        if label is None:
            unlabelled.append(sid)
        out.append({
            "id": sid,
            "parent": parent,
            "level": depth,
            "label": label,
            "bars": [bars[0].get("n"), bars[-1].get("n")],
            "indexPair": [closest_ix(ref_grid, start), closest_ix(ref_grid, end)],
        })
    if unlabelled:
        warnings.add("section-labels-missing",
                     f"{len(unlabelled)} of {len(out)} section(s) have no label (overrides "
                     f"`sectionLabels` or MEI @label); the exhibit falls back to the xml:id",
                     sections=unlabelled)
    by_level = Counter(s["level"] for s in out)
    log(f"  sections: {len(out)} ({', '.join(f'level {k}: {v}' for k, v in sorted(by_level.items()))}); "
        f"quarters {timed['quarters']['rendered']}/{timed['quarters']['aligned']} match; "
        f"Verovio {timed['toolkit']}")
    return {"toolkit": timed["toolkit"], "list": out}


def step_payload(args, sets, warnings):
    log("payload:")
    verify_pairs(sets, warnings)
    check_ids(sets, warnings)
    recordings = build_recordings(sets["hq"], warnings, probe=args.probe)
    annotations = build_annotations(sets, warnings)
    rederive_times(annotations, recordings, warnings)

    os.makedirs(args.data_dir, exist_ok=True)
    hq_header = sets["hq"]["header"]
    corrections = summarise_corrections(hq_header.get("corrections"))
    overrides_path = os.path.join(args.data_dir, OVERRIDES_FILE)
    if AUDIENCES:
        if NEEDS_HAND_PLACEMENT:
            # The seed documents the D-or-E slot; another piece gets no template
            # until it has a region that needs one.
            seed_overrides(overrides_path)
        overrides = load_overrides(overrides_path, warnings)
        apply_overrides(annotations, overrides, warnings, corrections)
        apply_reveal(annotations, overrides, warnings)
        apply_texts(annotations, overrides, warnings, sets)
        pending_hand_placement(annotations, warnings)
    else:
        # Nothing to hand-place without annotations; seeding the D-or-E slot for
        # a piece that has no "D or E?" would be a lie in a committed file. An
        # existing file may still carry section labels.
        overrides = load_overrides(overrides_path, warnings)
        log("  overrides: none — this piece has no annotation sets")
    sections = build_sections(args, sets, overrides, warnings)
    mei_path = os.path.join(args.data_dir, f"{PIECE}.mei")
    mei_sha = sha256_file(mei_path) if os.path.exists(mei_path) else None
    pin = mei_pin(score_set(sets)["header"])
    log(f"  corrections: {describe_corrections(corrections)}")
    if not ALIGNMENT_IS_HQ:
        warnings.add("alignment-not-hq",
                     f"{SOURCES['hq']} is not an HQ-preset alignment "
                     f"(params {hq_header.get('alignmentParams')}); cursors and aligned "
                     f"switches may sit seconds off in places. Re-align at hq (plan §5.2c); "
                     f"annotations already authored then follow by "
                     f"exhibit_annots_on_hq.py --reanchor.")
    payload = {
        "schema": SCHEMA,
        "piece": {
            "id": PIECE,
            "title": PIECE_TITLE,
            "composer": PIECE_COMPOSER,
            "opus": PIECE_OPUS,  # None is a fact for Die Fledermaus — see PIECE_OPUS
            "ref": hq_header.get("ref"),
            "meiUri": f"./{PIECE}.mei",
            "meiSource": pin["uri"],
            "meiCommit": pin["commit"],
            "meiSha256": mei_sha,
        },
        "source": {
            "generatedBy": f"tools/prep_exhibit_data.py ({os.path.basename(__file__)})",
            "generatedAt": args.timestamp,
            "alignment": SOURCES["hq"],
            "alignmentCreatedBy": hq_header.get("createdBy"),
            "alignmentParams": hq_header.get("alignmentParams"),
            "corrections": corrections,
            "audienceSets": {a: SOURCES[a] for a in AUDIENCES},
            "scoreAlignment": os.path.basename(SOURCES["score"]) if "score" in SOURCES else None,
        },
        "recordings": recordings,
        "annotations": annotations,
        "sections": sections,
        "score": score_set(sets)["body"].get("score") if args.with_score else None,
        "warnings": list(warnings),
    }
    out = os.path.join(args.data_dir, f"{PIECE}.json")
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, separators=(",", ":"))
    size = os.path.getsize(out)
    log(f"  wrote {out} ({size / 1048576:.1f} MB)")
    return payload


# ---------------------------------------------------------------------------- mei
def sha256_file(path):
    import hashlib
    with open(path, "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()


def mei_pin(header):
    """Which MEI the alignment was made against, as precisely as the header says.

    `meiUri` names a BRANCH (raw …/main/… or …/refs/heads/main/…), and a branch
    moves: Eulenburg's Fledermaus gained sections, meter signatures, and a tempo
    reset in November 2026, after the HQ alignment of September was made against
    6b6f774. A correcting session that re-bases the alignment (0.115.0) records
    the commit it re-based onto in `header.rebased.ontoMei.commit`; when present,
    the raw URL is rewritten to that commit, so a re-run fetches the score the
    alignment matches rather than whatever the branch holds today. `meiSha256`
    (0.115.0's stamp) is checked when present.
    """
    uri = header.get("meiUri")
    commit = ((header.get("rebased") or {}).get("ontoMei") or {}).get("commit")
    m = re.match(r"(https://raw\.githubusercontent\.com/[^/]+/[^/]+/)(refs/heads/[^/]+|[^/]+)/(.+)$",
                 uri or "")
    if commit and m:
        uri = f"{m.group(1)}{commit}/{m.group(3)}"
    return {"uri": uri, "commit": commit if (commit and m) else None,
            "sha256": header.get("meiSha256")}


def step_mei(args, sets, warnings):
    log("mei:")
    pin = mei_pin(score_set(sets)["header"])
    uri = pin["uri"]
    out = os.path.join(args.data_dir, f"{PIECE}.mei")
    if not uri:
        warnings.add("no-mei-uri", "the HQ alignment has no header.meiUri")
        return
    pinned = bool(pin["commit"] or pin["sha256"])
    if not pinned:
        warnings.add("mei-unpinned",
                     f"the alignment names {uri}, a branch, with no commit or meiSha256; "
                     f"the pinned MEI is trusted on the quarters check alone")
    if os.path.exists(out) and not args.force:
        if pin["sha256"] and sha256_file(out) == pin["sha256"]:
            log(f"  {out} matches the alignment's meiSha256")
            return
        if not pinned:
            log(f"  {out} exists; --force to refetch")
            return
        # A pinned alignment refetches every run: 5 MB is cheaper than finding
        # out at the wall that the local file predates a re-based alignment.
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
    if pin["sha256"]:
        import hashlib
        got = hashlib.sha256(body).hexdigest()
        if got != pin["sha256"]:
            warnings.add("mei-sha-mismatch",
                         f"{uri} hashes to {got[:12]}…, the alignment stamps "
                         f"{pin['sha256'][:12]}…; not written")
            return
    if os.path.exists(out):
        with open(out, "rb") as fh:
            if fh.read() == body:
                log(f"  {out} already holds {uri}")
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

    # mei BEFORE payload: the payload's sections are read from the pinned MEI.
    if "mei" in args.steps:
        step_mei(args, sets, warnings)
    if "payload" in args.steps:
        step_payload(args, sets, warnings)
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
