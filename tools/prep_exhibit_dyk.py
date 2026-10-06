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
    report(years, conductors, warnings)

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
