#!/usr/bin/env python3
"""Build the exhibit's "Did you know?" sidecar from Chanda's authored markdown.

Writes `app/static/exhibit/data/dyk.json` — one entry per concert YEAR and per
CONDUCTOR that she has written about, each carrying the same fact told three times
over for the exhibit's three audiences. The two explorers read nothing else.

## Why a parser at all, for thirty-six paragraphs

Because the ruling is that her text ships VERBATIM. Hand-transcribing museum prose
into JSON is exactly the operation that drifts — a smart quote flattened, a dash
normalised, a clause dropped — and it drifts silently. Her markdown stays the
source of truth in `content/dyk/`, she hands over a revised file or a translation,
the tool is re-run, and the diff is hers rather than a transcriber's.

## The input, and what is inconsistent about it

Two Google Docs exports (`content/dyk/concert-years.md`, `content/dyk/conductors.md`):

  * `# YYYY` or `# YYYY (the time the concert was first televised)` for a year; the
    parenthetical is the HOOK, and the exhibit shows it as the card's eyebrow.
  * `# Willi Boskovsky (1955-1979)` for a conductor; the years in the parenthesis
    are already in the concerts sidecar, so they are read and discarded — the join
    key is the NAME, and all six match the sidecar's spelling exactly.
  * Empty `# ` headings sit between two conductors. Skipped.
  * Each body paragraph opens with an audience label, and the label's formatting is
    inconsistent BETWEEN the files and WITHIN the conductors file: `**Kids: Did you
    know?**`, `**Kids:** Did you know?`, `Kids: Did you know?`, `Experts / nerds:
    Did you know?`. So the label is matched on the AUDIENCE WORD with the bold
    markers and the "Did you know?" stripped off, never on the exact string.

Audiences map to the payload's own ids: Kids -> kids, Adults -> adults, Nerds and
"Experts / nerds" -> expert (displayed to visitors as "Scholars", strings.js).

## What is stripped, and what is emphatically not

Stripped: the image references (`![][image1]`), the author's own note to herself
(`\\[insert AI photo of Boskovsky with violin in hand here\\]`), the audience label,
and Google's backslash escapes (`\\!`, `\\.`, `\\[`, `\\]`, `\\(`, `\\)`, `\\-`).

KEPT: `**bold**` and `*italic*`, passed through into the JSON as markers and
rendered by `dyk.js` with a tiny splitter that builds `<strong>`/`<em>` elements
and sets everything else as text — authored content never reaches `innerHTML`.

KEPT AS WRITTEN: her spelling, including the six editorial slips listed in
`content/dyk/README.md`. They are hers to rule on. A tool that quietly fixed
"Radetzsky" would make the museum's text a moving target.

## The images are placeholders, and the captions are OURS

The two photographs were split out of the export on 2026-09-18 and gitignored —
press photographs of unknown licence (`content/dyk/README.md`). The JSON therefore
carries no `src`: it carries the image's ID, its measured ASPECT, a caption, and
`status: "placeholder"`, and the exhibit draws a framed box at that aspect. The
captions live in IMAGES below rather than in her markdown because she supplied
none; her only image note was an instruction to insert a picture, not a caption.
When a licensed or properly-labelled image exists, the entry gains `src` and
`status: "licensed"` and the same figure shows it.

ILLUSTRATIONS are the exception: pictures we made with AI (2026-10-20, Jansons
first), keyed by conductor and optionally limited to some registers. They ship as
`status: "generated"` with a `src`, and the tool renders their assets with the AI
mark burned in — see ILLUSTRATIONS below.

## Committed, unlike concerts.json

`concerts.json` is gitignored because it is a scrape of two archives that can be
re-derived at any time. This one is AUTHORED CONTENT with no upstream to re-derive
it from: if it is not in the tree, the exhibit has no museum text. Hence the
`.gitignore` exception beside the `*overrides.json` one, and hence no wall-clock
timestamp in the output — a committed build product that changes on every run makes
noise in every diff. The source files are identified by their SHA-256 instead, so
"is the JSON current?" is still an answerable question.

Usage:
    tools/prep_exhibit_dyk.py                 # write the sidecar
    tools/prep_exhibit_dyk.py --report        # parse and report, write nothing
    tools/prep_exhibit_dyk.py --self-test     # check the parser's helpers, exit
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCHEMA = "lh-exhibit-dyk/1"
SOURCE_DIR = os.path.join(REPO, "content", "dyk")
YEARS_FILE = "concert-years.md"
CONDUCTORS_FILE = "conductors.md"
DEFAULT_DATA_DIR = os.path.join(REPO, "app", "static", "exhibit", "data")
LANG = "en"  # English only; the German half falls back (strings.js resolveText)

# The audience word, as she may write it, -> the payload's id. Matched
# case-insensitively against the first words of a paragraph, longest first, so
# "Experts / nerds" wins over a bare "nerds".
AUDIENCE_WORDS = [
    ("experts / nerds", "expert"),
    ("experts/nerds", "expert"),
    ("experts", "expert"),
    ("nerds", "expert"),
    ("adults", "adults"),
    ("kids", "kids"),
]
AUDIENCES = ["kids", "adults", "expert"]

# Our captions for her two images, and the aspect measured from the PNGs when they
# were split out (content/dyk/README.md). Keyed by the export's reference id so a
# re-export with the same references needs no change here.
IMAGES = {
    "image1": {
        "id": "boskovsky-violin",
        "aspect": [624, 292],
        "caption": {LANG: "Willi Boskovsky conducting the New Year's Concert from the violin"},
    },
    "image2": {
        "id": "karajan-battle-1987",
        "aspect": [624, 407],
        "caption": {LANG: "Herbert von Karajan with the soprano Kathleen Battle, 1 January 1987"},
    },
}

# Illustrations WE made, as opposed to the pictures in her export. Keyed by the
# conductor, because her markdown has no reference for them and adding one would
# edit her source. `audiences` limits the figure to those registers (absent: all).
# Each is AI-generated, so each carries the plan's §5.5 obligations: the spark
# burned in (render_illustration), the IPTC source type in the XMP, a disclosure
# while the picture is shown (dyk.js aiDisclosure), and its provenance in the sidecar.
ILLUSTRATIONS = {
    "Mariss Jansons": {
        "id": "jansons-vergnuegungszug",
        "source": "assets/dyk-images/Jansons-Vergnuegungszug.jpg",
        "caption": {LANG: "Mariss Jansons honks the horn in the train polka, 2016"},
        "provenance": {
            "model": "Nano Banana (Google Gemini image model)",
            "style": "content/dyk/image-style-prompt.md",
            # The prompt is lost; the style fragment was derived FROM this picture,
            # by asking Gemini to describe it (user, 2026-10-20).
            "prompt": None,
            "date": "2026-10-20",
        },
    },
    # Replaces the placeholder for her image2, the press photograph of the same scene.
    "Herbert von Karajan": {
        "id": "karajan-battle",
        "source": "assets/dyk-images/Karajan-Battle.jpg",
        "caption": {LANG: "Herbert von Karajan conducts as Kathleen Battle sings Voices of Spring, 1987"},
        "provenance": {
            "model": "Nano Banana (Google Gemini image model)",
            "style": "content/dyk/image-style-prompt.md",
            # No scene text of its own (user, 2026-10-20): the style fragment was
            # the whole prompt, less its sound-effect lettering and drifting notes.
            "prompt": "the style fragment, without the sound-effect text and musical notes",
            "date": "2026-10-20",
        },
    },
}
ILLUSTRATION_DIR = os.path.join(REPO, "app", "static", "exhibit", "dyk-images")
ILLUSTRATION_WIDTH = 960  # 2x the widest the card could draw it

# The AI mark, after the portraits' (tools/split_portraits.py, THE AI MARK): a gold
# bubble with the four-point spark knocked out of it dark, so it carries its own
# contrast on any part of the picture. Here it sits in the lower-right corner, in
# fractions of the output WIDTH.
MARK_R = 0.016         # bubble radius (halved 2026-10-20: it drew the eye, worst in the lightbox)
MARK_INSET = 0.036     # bubble centre from the right and bottom edges (the same 0.02 gap to them)
MARK_SPARK = 0.62      # spark radius, as a fraction of the bubble's
MARK_GOLD = (212, 178, 94)
MARK_KEYLINE = (108, 82, 30)
MARK_SPARK_INK = (38, 30, 14)
XMP = (
    '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>'
    '<x:xmpmeta xmlns:x="adobe:ns:meta/">'
    '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
    '<rdf:Description rdf:about=""'
    ' xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/"'
    ' xmlns:dc="http://purl.org/dc/elements/1.1/">'
    "<Iptc4xmpExt:DigitalSourceType>"
    "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia"
    "</Iptc4xmpExt:DigitalSourceType>"
    "<dc:description><rdf:Alt><rdf:li xml:lang=\"x-default\">"
    "{description}"
    "</rdf:li></rdf:Alt></dc:description>"
    "</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end=\"w\"?>"
)

# --- the shapes the two exports use -----------------------------------------
HEADING = re.compile(r"^#\s*(.*)$")
YEAR_HEADING = re.compile(r"^(\d{4})\s*(?:\((.*?)\)\s*)?$")
CONDUCTOR_HEADING = re.compile(r"^(.+?)\s*\((.*?)\)\s*$")
IMAGE_REF = re.compile(r"!\[\]\[(image\d+)\]")
# Her note to herself, escaped by the exporter: \[insert AI photo ... here\]
AUTHOR_NOTE = re.compile(r"\\?\[\s*insert\b[^\]]*\\?\]")
# A blockquote holding nothing but an image reference (Karajan's).
BLOCKQUOTE = re.compile(r"^>\s*")
# The link reference definitions the exporter parks at the foot of the file. They
# land inside whatever section happens to be last (Dudamel's), so they are dropped
# before anything tries to read them as prose.
LINK_DEF = re.compile(r"^\[[^\]]+\]:\s*\S")
ESCAPES = re.compile(r"\\([!.\[\]()\-*_>#+])")


def log(*a):
    print(*a, file=sys.stderr)


def unescape(text: str) -> str:
    """Undo Google's backslash escapes; leave every other backslash alone."""
    return ESCAPES.sub(r"\1", text)


def strip_label(para: str):
    """(audience, rest) if the paragraph opens with an audience label, else (None, para).

    Tolerant by design — see the docstring. The bold markers around the label are
    removed with it, but markers INSIDE the remaining text are kept.
    """
    probe = para.lstrip()
    # Peel any leading bold/italic markers off so "**Kids:** …" and "**Kids: …**"
    # look the same to the match.
    head = probe.lstrip("*").lstrip()
    low = head.lower()
    for word, aid in AUDIENCE_WORDS:
        if not low.startswith(word):
            continue
        rest = head[len(word):]
        rest = rest.lstrip("*").lstrip()
        if not rest.startswith(":"):
            continue
        rest = rest[1:].lstrip().lstrip("*").lstrip()
        # The question itself is chrome; the view supplies its own heading.
        if rest.lower().startswith("did you know?"):
            rest = rest[len("did you know?"):]
        rest = rest.lstrip()
        # A trailing bold marker left over from "**Kids: Did you know?** text" is
        # the opener's partner and goes with it; a genuine closing ** would have
        # its own opener inside the text.
        if rest.startswith("**") and rest.count("**") % 2 == 1:
            rest = rest[2:].lstrip()
        return aid, rest
    return None, para


def clean(text: str, images: list):
    """Strip the image references and the author's note; unescape; tidy whitespace."""
    for m in IMAGE_REF.finditer(text):
        images.append(m.group(1))
    text = IMAGE_REF.sub("", text)
    text = AUTHOR_NOTE.sub("", text)
    text = unescape(text)
    text = re.sub(r"[ \t]+", " ", text)
    return text.strip()


def sections(path: str):
    """Yield (heading, [paragraph, ...]) for each `# ` heading; empty ones skipped."""
    with open(path, encoding="utf-8") as fh:
        lines = fh.read().splitlines()
    heading, buf = None, []
    for line in lines:
        m = HEADING.match(line)
        if m:
            if heading is not None:
                yield heading, paragraphs(buf)
            heading, buf = m.group(1).strip(), []
        else:
            buf.append(line)
    if heading is not None:
        yield heading, paragraphs(buf)


def paragraphs(lines):
    """Blank-line-separated blocks, with blockquote markers dropped."""
    out, cur = [], []
    for line in lines:
        line = BLOCKQUOTE.sub("", line) if line.lstrip().startswith(">") else line
        if LINK_DEF.match(line.strip()):
            continue
        if line.strip():
            cur.append(line.strip())
        elif cur:
            out.append(" ".join(cur))
            cur = []
    if cur:
        out.append(" ".join(cur))
    return out


def parse_entries(path: str, kind: str, warnings: list):
    """Parse one export into {key: entry}. `kind` is "years" or "conductors"."""
    entries = {}
    for heading, paras in sections(path):
        if not heading:
            continue  # the empty headings between two conductors
        if kind == "years":
            m = YEAR_HEADING.match(heading)
            if not m:
                warnings.append(f"{os.path.basename(path)}: unreadable heading {heading!r}")
                continue
            key, subtitle = m.group(1), (m.group(2) or "").strip()
        else:
            m = CONDUCTOR_HEADING.match(heading)
            key = (m.group(1) if m else heading).strip()
            subtitle = ""
        text, images = {}, []
        for para in paras:
            aid, body = strip_label(para)
            # Cleaned before the label is judged, because an image can sit in a
            # paragraph of its own: Karajan's is a blockquote holding nothing but
            # the reference, and it belongs to the conductor, not to a register.
            body = clean(body, images)
            if aid is None:
                if body:
                    warnings.append(f"{os.path.basename(path)} [{key}]: unlabelled paragraph dropped")
                continue
            if not body:
                continue
            if aid in text:
                warnings.append(f"{os.path.basename(path)} [{key}]: two {aid} paragraphs; the first is kept")
                continue
            text[aid] = {LANG: body}
        if not text:
            continue  # a year with no content: the great majority of them
        missing = [a for a in AUDIENCES if a not in text]
        if missing:
            warnings.append(f"{os.path.basename(path)} [{key}]: no {', '.join(missing)} text")
        image = None
        if images:
            ref = images[0]
            if len(images) > 1:
                warnings.append(f"{os.path.basename(path)} [{key}]: {len(images)} images; the first is used")
            if ref in IMAGES:
                image = dict(IMAGES[ref], status="placeholder", src=None)
            else:
                warnings.append(f"{os.path.basename(path)} [{key}]: unknown image reference {ref}")
        entry = {"text": text, "image": image}
        if subtitle:
            entry["subtitle"] = {LANG: unescape(subtitle)}
        entries[key] = entry
    return entries


def _spark(cx, cy, r):
    """A four-point star: the widely-read shorthand for 'generated'."""
    pts = []
    for k in range(8):
        ang = -math.pi / 2 + k * math.pi / 4
        rad = r if k % 2 == 0 else r * 0.34
        pts.append((cx + rad * math.cos(ang), cy + rad * math.sin(ang)))
    return pts


def render_illustration(name: str, spec: dict, write: bool):
    """The sidecar's image entry for one illustration; with `write`, the asset too.

    The asset is the source scaled to ILLUSTRATION_WIDTH with the AI mark burned
    in, as WebP with the IPTC source type in its XMP. The mark is drawn at four
    times its size and reduced, because the spark's points are diagonal edges.
    """
    try:
        from PIL import Image, ImageDraw
    except ImportError:
        sys.exit("Pillow is needed for the illustrations (it is in .venv/)")
    with Image.open(os.path.join(REPO, spec["source"])) as src:
        w = ILLUSTRATION_WIDTH
        h = round(src.height * w / src.width)
        img = src.convert("RGB").resize((w, h), Image.LANCZOS) if write else None
    rel = f"dyk-images/{spec['id']}.webp"
    if write:
        S = 4
        r, inset = MARK_R * w * S, MARK_INSET * w * S
        layer = Image.new("RGBA", (w * S, h * S), (0, 0, 0, 0))
        dr = ImageDraw.Draw(layer)
        mx, my = w * S - inset, h * S - inset
        dr.ellipse([mx - r, my - r, mx + r, my + r], fill=MARK_GOLD + (255,),
                   outline=MARK_KEYLINE + (255,), width=max(1, round(r * 0.13)))
        dr.polygon(_spark(mx, my, r * MARK_SPARK), fill=MARK_SPARK_INK + (255,))
        img = Image.alpha_composite(img.convert("RGBA"), layer.resize((w, h), Image.LANCZOS))
        os.makedirs(ILLUSTRATION_DIR, exist_ok=True)
        path = os.path.join(ILLUSTRATION_DIR, f"{spec['id']}.webp")
        desc = (f"AI-generated illustration of {name} for the Listen Here! exhibit; "
                "a caricature, not a photograph.")
        img.convert("RGB").save(path, "WEBP", quality=86, method=6,
                                xmp=XMP.format(description=desc).encode())
        log(f"wrote {os.path.relpath(path, REPO)} ({w}x{h}, {os.path.getsize(path) // 1024} kB)")
    entry = {
        "id": spec["id"],
        "aspect": [w, h],
        "caption": spec["caption"],
        "status": "generated",
        "src": rel,
        "provenance": spec["provenance"],
    }
    if spec.get("audiences"):
        entry["audiences"] = spec["audiences"]
    return entry


def add_illustrations(conductors: dict, warnings: list, write: bool):
    """Attach ILLUSTRATIONS to their conductors; ours replaces a placeholder."""
    for name, spec in ILLUSTRATIONS.items():
        if name not in conductors:
            warnings.append(f"illustration {spec['id']}: no story for {name}")
            continue
        if conductors[name]["image"]:
            warnings.append(f"illustration {spec['id']} replaces {name}'s {conductors[name]['image']['id']}")
        conductors[name]["image"] = render_illustration(name, spec, write)


def sha256(path: str) -> str:
    with open(path, "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()


def report(years: dict, conductors: dict, warnings: list):
    for label, entries in (("years", years), ("conductors", conductors)):
        print(f"\n{len(entries)} {label}:")
        for key, e in entries.items():
            have = "".join(a[0].upper() if a in e["text"] else "-" for a in AUDIENCES)
            words = sum(len(v[LANG].split()) for v in e["text"].values())
            img = f"  image={e['image']['id']}" if e["image"] else ""
            sub = f"  “{e['subtitle'][LANG]}”" if e.get("subtitle") else ""
            print(f"  {key:<22} {have}  {words:>4} words{img}{sub}")
    if warnings:
        print(f"\n{len(warnings)} warning(s):")
        for w in warnings:
            print(f"  - {w}")


def self_test() -> int:
    """The parser's tolerance for her three label spellings, and the strippers."""
    cases = [
        ("**Kids: Did you know?** The waltz\\!", "kids", "The waltz!"),
        ("**Kids:** Did you know? A *singer\\!*", "kids", "A *singer!*"),
        ("Kids: Did you know? For 25 years", "kids", "For 25 years"),
        ("**Adults:** Did you know? **Willi Boskovsky** led", "adults", "**Willi Boskovsky** led"),
        ("Experts / nerds:  Did you know? **Boskovsky**’s", "expert", "**Boskovsky**’s"),
        ("**Experts / nerds:** Did you know? Krips’s two", "expert", "Krips’s two"),
        ("**Nerds: Did you know?** Introduced by Krauss", "expert", "Introduced by Krauss"),
        ("A paragraph with no label at all", None, "A paragraph with no label at all"),
    ]
    bad = 0
    for src, want_aid, want_text in cases:
        aid, rest = strip_label(src)
        got = clean(rest, []) if aid else rest
        if aid != want_aid or got != want_text:
            bad += 1
            print(f"FAIL {src!r}\n  got  ({aid!r}, {got!r})\n  want ({want_aid!r}, {want_text!r})")
    strips = [
        ("photo here? \\[insert AI photo of Boskovsky with violin in hand here\\]![][image1]",
         "photo here?", ["image1"]),
        ("![][image2]", "", ["image2"]),
        ("no images here", "no images here", []),
    ]
    for src, want_text, want_imgs in strips:
        imgs = []
        got = clean(src, imgs)
        if got != want_text or imgs != want_imgs:
            bad += 1
            print(f"FAIL {src!r}\n  got  ({got!r}, {imgs})\n  want ({want_text!r}, {want_imgs})")
    # The heading shapes.
    for src, want in [("1945 (the time the Blue Danube waltz was first performed)", ("1945", "the time the Blue Danube waltz was first performed")),
                      ("2021 (the time the concert played to an empty hall)", ("2021", "the time the concert played to an empty hall")),
                      ("1939", ("1939", None))]:
        m = YEAR_HEADING.match(src)
        if not m or (m.group(1), m.group(2)) != want:
            bad += 1
            print(f"FAIL heading {src!r} -> {m and m.groups()!r}, want {want!r}")
    print("self-test: " + ("OK" if not bad else f"{bad} failure(s)"))
    return 1 if bad else 0


def check_roster(conductors: dict, data_dir: str):
    """Name the stories the conductors explorer cannot show: its roster is the
    concerts sidecar's, so a conductor with no concert there has no card.

    Logged only, never written to dyk.json: the sidecar is gitignored, so a
    warning that depends on it would change the committed file per machine.
    """
    path = os.path.join(data_dir, "concerts.json")
    if not os.path.exists(path):
        log(f"\n(no {os.path.relpath(path, REPO)}: the roster check is skipped)")
        return
    with open(path, encoding="utf-8") as fh:
        concerts = json.load(fh).get("concerts") or []
    if isinstance(concerts, dict):
        concerts = list(concerts.values())
    roster = {c.get("conductor") for c in concerts if c.get("conductor")}
    missing = [name for name in conductors if name not in roster]
    for name in missing:
        log(f"  not shown: {name} conducts no concert in the concerts sidecar")
    if not missing:
        log("\nroster: every conductor story has a card")


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--source-dir", default=SOURCE_DIR, help="where the markdown lives")
    ap.add_argument("--data-dir", default=DEFAULT_DATA_DIR)
    ap.add_argument("--report", action="store_true", help="parse and report; write nothing")
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args()

    if args.self_test:
        sys.exit(self_test())

    years_path = os.path.join(args.source_dir, YEARS_FILE)
    conductors_path = os.path.join(args.source_dir, CONDUCTORS_FILE)
    for p in (years_path, conductors_path):
        if not os.path.exists(p):
            sys.exit(f"source not found: {p}\n(see content/dyk/README.md)")

    warnings = []
    years = parse_entries(years_path, "years", warnings)
    conductors = parse_entries(conductors_path, "conductors", warnings)
    add_illustrations(conductors, warnings, write=not args.report)
    report(years, conductors, warnings)
    check_roster(conductors, args.data_dir)

    if args.report:
        log("\n--report: nothing written")
        return

    out = {
        "schema": SCHEMA,
        "source": [
            {"path": os.path.relpath(years_path, REPO), "sha256": sha256(years_path)},
            {"path": os.path.relpath(conductors_path, REPO), "sha256": sha256(conductors_path)},
        ],
        "years": years,
        "conductors": conductors,
        "warnings": warnings,
    }
    os.makedirs(args.data_dir, exist_ok=True)
    path = os.path.join(args.data_dir, "dyk.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=1)
        fh.write("\n")
    log(f"\nwrote {path} ({os.path.getsize(path) // 1024} kB)")


if __name__ == "__main__":
    main()
