#!/usr/bin/env python3
"""Freely-licensed conductor portraits from Wikimedia Commons, cut to the
exhibit's medallion template.

This REPLACES the Gen-AI portraits of tools/split_portraits.py. The reason is
external: image models now decline to render living public figures, even as
caricature, so the batch that was going to cover the remaining conductors cannot
be made. Photographs under a free licence are the alternative, and they change
three things that the AI route got for free.

  1. PROVENANCE RUNS THE OTHER WAY. Every AI asset had to be marked as synthetic
     (a gold spark, and IPTC `trainedAlgorithmicMedia` in its XMP). A photograph
     must carry the OPPOSITE claim, so the mark is gone and the XMP now records
     `digitalCapture` plus the photographer, the licence and the file's page on
     Commons. Stamping a photograph with the AI mark would be a false statement
     about a real person's picture, which is why --build refuses to reuse any of
     split_portraits.py's drawing code.

  2. ATTRIBUTION IS A LICENCE CONDITION, NOT A COURTESY. Most of these are CC BY
     or CC BY-SA and the medallion is a derivative of the photograph. The band
     carries no labels (plan §6.3), so the credit cannot live there; it goes to
     the foot of the explorers, beside the sentence that used to explain the AI
     mark, and `credits.json` is what feeds it. That file is GENERATED here and
     COMMITTED, because the kiosk has no network.

  3. THE SITTING IS THE PHOTOGRAPH'S DATE, NOT THE CONCERT'S. The AI naming was
     per RECORDING so each sitter could appear at the age they were that year
     (README, §11(d)). Commons offers one usable picture of a given conductor,
     taken whenever it was taken, so portraits become per CONDUCTOR and the year
     shown against a medallion is the year the photograph was made. Karajan is
     1963 against a 1987 concert, and that is now the honest reading rather than
     a bug.

WHY SELECTION IS NOT AUTOMATED. It is tempting to take each conductor's Wikidata
P18, or the best-licensed file in their Commons category, and be done. Both are
wrong, measurably. Ranking Karajan's category by licence and resolution returns a
STREET SIGN and an institute building before his face; Boskovsky's best free file
is his GRAVE; Mehta's is a letter he wrote; and Thielemann's category contains a
portrait of Renée Fleming. So --survey PROPOSES and a human DISPOSES: it builds a
contact sheet per conductor, and the choice is written by hand into sources.json.
--build then reads only that file, so the result is reproducible and reviewable.

WHY THERE IS NO FACE DETECTOR. The crop is authored in sources.json instead. A
detector would be one more thing that has to behave identically on the next
machine, and OpenCV 5 no longer ships the Haar cascades this would have used —
so it would mean committing a model file to get a square that a person can pick
once, by eye, in a second. split_portraits.py loads no font for the same reason.

THE TEMPLATE, measured off the three shipped AI medallions rather than assumed
(see MEDALLION_FRAC and RING_INNER): a 340 px canvas, gold ring from 0.775 to
0.849 of the half-width, rgb(198,162,94), transparent outside. The 0.86 inset
exists ONLY because the AI mark straddled the rim, and the mark is gone — but it
STAYS, because exhibit.css grew `.mb-portrait` and `--ex-strap-disc-portrait` to
compensate for exactly that margin so the gold circle lines up with the paper
discs beside it. Changing it here would silently shrink every face on the wall.

Usage:
    python3 tools/fetch_conductor_portraits.py survey            # propose
    python3 tools/fetch_conductor_portraits.py survey --only muti
    python3 tools/fetch_conductor_portraits.py build             # render
    python3 tools/fetch_conductor_portraits.py build --only muti

Needs Pillow and numpy, and a network for `survey` and for `build`'s first run
(originals are cached under --cache, which is outside the repo by default).
"""

import argparse
import io
import json
import math
import os
import re
import sys
import time
import urllib.parse
import urllib.request

try:
    import numpy as np
    from PIL import Image, ImageDraw, ImageFont, ImageOps
except ImportError as exc:  # pragma: no cover - environment guidance
    sys.exit(f"{exc}. Install into the venv: venv/bin/pip install Pillow numpy")


HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORTRAIT_DIR = os.path.join(HERE, "app", "static", "exhibit", "portraits")
SOURCES = os.path.join(PORTRAIT_DIR, "sources.json")
CREDITS = os.path.join(PORTRAIT_DIR, "credits.json")
CONCERTS = os.path.join(HERE, "app", "static", "exhibit", "data", "concerts.json")
METADATA = os.path.join(HERE, "app", "static", "exhibit", "data", "metadata.json")

# Wikimedia asks for a real contact in the agent string, and throttles anonymous
# clients that do not give one.
UA = "SignatureSoundVienna-exhibit/1.0 (https://www.mdw.ac.at/; weigl@mdw.ac.at)"

# --- the medallion template (measured; see THE TEMPLATE above) ----------------
CANVAS = 340           # output edge in px, as the AI batch shipped
MEDALLION_FRAC = 0.86  # outer edge of the gold, in canvas half-widths
RING_INNER = 0.775     # inner edge of the gold; the photograph fills inside it
RING_GOLD = (198, 162, 94)
SUPERSAMPLE = 4

# The placeholder's field, for a conductor with no free photograph: the blue the
# AI sheet used as its velvet ground, darkened so it reads as "no picture" and
# not as a portrait that failed to load.
PLACEHOLDER_FIELD = (28, 38, 66)
PLACEHOLDER_FIELD_EDGE = (16, 22, 40)

# --- candidate filtering (see WHY SELECTION IS NOT AUTOMATED) -----------------
# Titles that are about the conductor but are not OF the conductor. Every one of
# these was returned, in the top three by licence and resolution, by a ranking
# that did not have this list.
NOT_A_PORTRAIT = re.compile(
    r"stra(ss|ß)e|platz|institut|friedhof|grab|grave|brunnen|denkmal|gedenktafel"
    r"|plaque|b(ü|ue)ste|bust|lettera|letter|brief|autograph|signature|unterschrift"
    r"|briefmarke|stamp|museum|saal|haus|plakat|poster|cover|notenblatt|score"
    r"|tomb|memorial|schild|sign\b|geburtshaus|wohnhaus",
    re.I,
)
IMAGE_EXT = (".jpg", ".jpeg", ".png", ".tif", ".tiff")

# Licence tiers, freest first. The tier is what --survey sorts on, because a
# free-of-attribution file removes a credit obligation that the band has no room
# for — see ATTRIBUTION IS A LICENCE CONDITION above.
TIER_FREE, TIER_BY, TIER_SA, TIER_OTHER = 0, 1, 2, 3


def licence_tier(short):
    s = (short or "").strip().lower()
    if not s:
        return TIER_OTHER
    if "public domain" in s or s.startswith("cc0") or s.startswith("pd"):
        return TIER_FREE
    if "-sa" in s or " sa " in s:
        return TIER_SA
    if s.startswith("cc by") or s == "attribution":
        return TIER_BY
    return TIER_OTHER


TIER_NAME = {TIER_FREE: "free", TIER_BY: "BY", TIER_SA: "BY-SA", TIER_OTHER: "?"}


# --- Wikimedia -----------------------------------------------------------------
def api(host, params):
    params = dict(params, format="json")
    url = f"https://{host}/w/api.php?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=45) as r:
                return json.load(r)
        except Exception:
            if attempt == 2:
                raise
            time.sleep(1.5 * (attempt + 1))


def strip_html(s):
    """extmetadata gives Artist and Credit as HTML; the credits line wants text."""
    s = re.sub(r"<[^>]+>", "", s or "")
    s = (s.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
          .replace("&quot;", '"').replace("&#039;", "'").replace("&nbsp;", " "))
    return " ".join(s.split()).strip()


def tidy_artist(s):
    """Reduce Commons's uploader boilerplate to the name a credit line can show.

    Commons often stores an Artist of the form "The original uploader was Emerson7
    at English Wikipedia. (Original text: not known)". Printed verbatim under a
    kiosk portrait that is a whole sentence of apparatus around one word that
    matters, so take the name and drop the rest. Anything that does not match the
    boilerplate is left exactly as the photographer wrote it.

    Returns "" when the field says nobody knows — Commons writes that as
    "Unknown", and its own template doubles it into "UnknownUnknown". A credit
    line reading "Photo: unknown" is worse than no credit line.
    """
    s = strip_html(s)
    s = re.sub(r"\s*\((?:Original text|original text)[^)]*\)\s*", " ", s)
    s = s.strip()
    if re.fullmatch(r"(unknown|unbekannt|anonymous|not known)+", s, re.I):
        return ""
    m = re.match(r"^The original uploader was (.+?) at ([\w ]+?)\.?$", s)
    if m:
        return f"{m.group(1)} ({m.group(2)})"
    m = re.match(r"^(.+?) at (English |German |[\w]+ )?Wikipedia\.?$", s)
    if m:
        return f"{m.group(1).strip()} (Wikipedia)"
    return s


def wikidata_claims(qid):
    ent = api("www.wikidata.org", {"action": "wbgetentities", "props": "claims",
                                   "ids": qid})["entities"][qid]
    return ent.get("claims", {})


def file_meta(titles):
    """imageinfo + extmetadata for a batch of File: titles."""
    out = {}
    titles = list(titles)
    for i in range(0, len(titles), 25):
        chunk = titles[i:i + 25]
        data = api("commons.wikimedia.org", {
            "action": "query", "prop": "imageinfo",
            "iiprop": "url|size|extmetadata", "iiurlwidth": 1600,
            "titles": "|".join(chunk),
        })
        for p in data.get("query", {}).get("pages", {}).values():
            ii = (p.get("imageinfo") or [{}])[0]
            em = ii.get("extmetadata", {})

            def v(k):
                return (em.get(k, {}).get("value") or "").strip()

            out[p["title"]] = {
                "title": p["title"],
                "url": ii.get("url", ""),
                "thumb": ii.get("thumburl", ""),
                "descriptionurl": ii.get("descriptionurl", ""),
                "width": ii.get("width") or 0,
                "height": ii.get("height") or 0,
                "licence": strip_html(v("LicenseShortName")),
                "licence_url": v("LicenseUrl"),
                "artist": strip_html(v("Artist")),
                "credit": strip_html(v("Credit")),
                "date": strip_html(v("DateTimeOriginal")),
                "restrictions": strip_html(v("Restrictions")),
            }
    return out


def candidates_for(name, qid, name_filter=True):
    """Plausible portrait files for one conductor, freest licence first.

    `name_filter=False` keeps files whose title does not carry the surname. That
    filter is what keeps other people's faces out of a category (Renée Fleming
    sits in Thielemann's), but it also HIDES a whole concert series filed under
    the venue — Andris Nelsons' best-licensed pictures are named after the
    Gewandhaus, not after him. Off, the sheet needs a more careful eye.
    """
    titles = []
    claims = wikidata_claims(qid) if qid else {}
    if "P18" in claims:
        titles.append("File:" + claims["P18"][0]["mainsnak"]["datavalue"]["value"])
    category = None
    if "P373" in claims:
        category = claims["P373"][0]["mainsnak"]["datavalue"]["value"]
        data = api("commons.wikimedia.org", {
            "action": "query", "list": "categorymembers", "cmtype": "file",
            "cmlimit": 200, "cmtitle": "Category:" + category,
        })
        titles += [m["title"] for m in data.get("query", {}).get("categorymembers", [])]
    if len(titles) < 4:
        data = api("commons.wikimedia.org", {
            "action": "query", "list": "search", "srnamespace": 6,
            "srlimit": 40, "srsearch": name,
        })
        titles += [m["title"] for m in data.get("query", {}).get("search", [])]

    seen, ordered = set(), []
    for t in titles:
        if t not in seen:
            seen.add(t)
            ordered.append(t)

    surname = name.split()[-1].lower()
    metas = file_meta(ordered)
    keep = []
    for t in ordered:
        m = metas.get(t)
        if not m or not m["url"]:
            continue
        # Commons appends ?utm_source=... to imageinfo URLs, so test the PATH.
        path = urllib.parse.urlparse(m["url"]).path.lower()
        if not path.endswith(IMAGE_EXT):
            continue
        bare = t[5:]
        # The surname test is what keeps other people's faces out of a category
        # (Renée Fleming sits in Thielemann's). P18 is exempt: Wikidata has
        # already asserted that this file depicts this person.
        is_p18 = "P18" in claims and bare == claims["P18"][0]["mainsnak"]["datavalue"]["value"]
        if not is_p18:
            if name_filter and surname not in bare.lower():
                continue
            if NOT_A_PORTRAIT.search(bare):
                continue
        m["tier"] = licence_tier(m["licence"])
        m["p18"] = is_p18
        keep.append(m)

    keep.sort(key=lambda m: (m["tier"], -(m["width"] * m["height"])))
    return category, keep


# --- the survey sheet ----------------------------------------------------------
def fetch_bytes(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=90) as r:
        return r.read()


def contact_sheet(name, cands, cell=260, cols=4):
    """A labelled grid of candidates, for a person to choose from.

    A font IS loaded here, unlike anywhere in split_portraits.py: this sheet is a
    REVIEW ARTEFACT that never ships, so reproducing identically on another
    machine does not matter to it.
    """
    rows = max(1, math.ceil(len(cands) / cols))
    pad, label_h = 8, 34
    sheet = Image.new("RGB", (cols * (cell + pad) + pad,
                              rows * (cell + label_h + pad) + pad + 24), (24, 24, 28))
    draw = ImageDraw.Draw(sheet)
    try:
        font = ImageFont.load_default(13)
    except TypeError:  # Pillow < 10.1 takes no size
        font = ImageFont.load_default()
    draw.text((pad, 6), name, fill=(235, 220, 170), font=font)

    for i, c in enumerate(cands):
        col, row = i % cols, i // cols
        x = pad + col * (cell + pad)
        y = 24 + pad + row * (cell + label_h + pad)
        try:
            im = Image.open(io.BytesIO(fetch_bytes(c["thumb"] or c["url"]))).convert("RGB")
            im.thumbnail((cell, cell), Image.LANCZOS)
            sheet.paste(im, (x + (cell - im.width) // 2, y + (cell - im.height) // 2))
        except Exception as exc:
            draw.text((x + 6, y + cell // 2), f"[{exc}]"[:34], fill=(200, 90, 90), font=font)
        draw.rectangle([x, y, x + cell, y + cell], outline=(70, 70, 80))
        tag = f"[{i}] {TIER_NAME[c['tier']]} {c['licence'][:18]}"
        draw.text((x + 2, y + cell + 3), tag[:40], fill=(220, 220, 200), font=font)
        draw.text((x + 2, y + cell + 17), f"{c['width']}x{c['height']} {c['date'][:14]}",
                  fill=(150, 150, 160), font=font)
    return sheet


# --- the medallion -------------------------------------------------------------
def _rings(n):
    """Radius (in half-widths) and angle for every pixel of an n x n canvas."""
    yy, xx = np.mgrid[0:n, 0:n]
    cy = cx = (n - 1) / 2
    dy, dx = yy - cy, xx - cx
    return np.hypot(dy, dx) / (n / 2), np.arctan2(dy, dx)


def _gold_ring(n, rad, ang):
    """The gold annulus as (rgb array, alpha array), with a lit bevel.

    Flat gold reads as plastic at 150 px in the by-conductor card. The sheen is
    a single highlight from the upper left plus a darkening at both edges of the
    band, which is what makes a struck rim legible at 30 px on the strap.
    """
    base = np.array(RING_GOLD, dtype=float)
    lit = 1.0 + 0.16 * np.cos(ang - math.radians(-135.0))
    mid = (RING_INNER + MEDALLION_FRAC) / 2
    halfband = (MEDALLION_FRAC - RING_INNER) / 2
    bevel = 1.0 - 0.28 * np.clip(np.abs(rad - mid) / halfband, 0, 1) ** 2
    shade = np.clip(lit * bevel, 0.35, 1.45)
    rgb = np.clip(base[None, None, :] * shade[:, :, None], 0, 255)
    alpha = ((rad >= RING_INNER) & (rad <= MEDALLION_FRAC)).astype(float) * 255.0
    return rgb, alpha


def _placeholder_field(n, rad):
    """A quiet blue disc for a conductor with no free photograph."""
    a = np.array(PLACEHOLDER_FIELD, dtype=float)
    b = np.array(PLACEHOLDER_FIELD_EDGE, dtype=float)
    k = np.clip(rad / RING_INNER, 0, 1)[:, :, None]
    return a[None, None, :] * (1 - k) + b[None, None, :] * k


def square_crop(img, crop, label=""):
    """Cut the authored square out of the source image.

    `crop` is [cx, cy, size]: centre as a fraction of width and height, edge as
    a fraction of the SHORTER side — so the same numbers survive Commons serving
    a different thumbnail width than the one they were picked on.

    WARNS WHEN IT HAS TO CLAMP, which is not cosmetic. A square that will not fit
    around the authored centre is slid back inside the picture, and the frame then
    lands somewhere nobody chose: Karajan's first crop asked for a centre 622 px
    down with a half-edge of 816, so it was pushed to the top of the image and
    took his chin off. Silently. The warning is the only thing that makes the
    authored numbers and the delivered frame the same conversation.
    """
    cx, cy, size = crop
    short = min(img.width, img.height)
    half = max(8.0, size * short / 2)
    x, y = cx * img.width, cy * img.height

    # A `size` OVER 1.0 asks for a frame wider than the picture, which is the only
    # way to zoom out of a photograph that already fills its own frame — Karajan's
    # and Nelsons' best (and, for Nelsons, only) pictures are both head-and-
    # shoulders with no margin, and the author wanted the faces smaller in the
    # disc. The overflow is filled by REPLICATING THE EDGE PIXELS, which invents
    # no detail: it continues the ground the sitter is already standing against,
    # and both of those grounds are a plain sweep (blurred grey, a red backdrop),
    # so the join does not read. It would read on a busy background — check the
    # asset, and prefer a different photograph over a large pad.
    if half > short / 2:
        pad = int(math.ceil(half - short / 2)) + 2
        img = ImageOps.expand(img, border=pad)
        arr = np.array(img)  # a COPY: np.asarray of a PIL image is read-only
        arr[:pad, :] = arr[pad:pad + 1, :]
        arr[-pad:, :] = arr[-pad - 1:-pad, :]
        arr[:, :pad] = arr[:, pad:pad + 1]
        arr[:, -pad:] = arr[:, -pad - 1:-pad]
        img = Image.fromarray(arr)
        x, y = x + pad, y + pad
        print(f"      .. {label}: frame is wider than the picture; "
              f"{pad} px of edge-replicated ground added on each side",
              file=sys.stderr)

    # Keep the square inside the picture rather than padding it with a colour
    # that would show as a hard edge inside the ring.
    half = min(half, img.width / 2, img.height / 2)
    nx = min(max(x, half), img.width - half)
    ny = min(max(y, half), img.height - half)
    if (abs(nx - x) > 1 or abs(ny - y) > 1) and size <= 1.0:
        print(f"      !! {label}: crop clamped to fit: centre ({cx:.3f}, {cy:.3f}) -> "
              f"({nx / img.width:.3f}, {ny / img.height:.3f}) — shrink `size` or "
              f"move the centre, or the frame is not the one you chose",
              file=sys.stderr)
    return img.crop((round(nx - half), round(ny - half),
                     round(nx + half), round(ny + half)))


def compose(face, size=CANVAS, supersample=SUPERSAMPLE):
    """The finished asset: photograph inside the gold ring, transparent outside.

    `face` is a square crop, or None for the placeholder. Drawn large and reduced
    because the ring and the circular cut are diagonal edges that look chewed
    otherwise — the strap draws this at 30 px, where chewed is all you would see.
    """
    n = size * supersample
    rad, ang = _rings(n)

    if face is not None:
        disc = np.asarray(face.convert("RGB").resize((n, n), Image.LANCZOS), dtype=float)
    else:
        disc = _placeholder_field(n, rad)

    rgb, ring_a = _gold_ring(n, rad, ang)
    # One supersampled pixel of overlap under the gold, so no seam shows between
    # the photograph's edge and the ring's inner edge after the reduction.
    inner_a = (rad <= RING_INNER + 1.5 / (n / 2)).astype(float) * 255.0

    out_rgb = np.where(ring_a[:, :, None] > 0, rgb, disc)
    out_a = np.maximum(inner_a, ring_a)
    arr = np.concatenate([out_rgb, out_a[:, :, None]], axis=2)
    img = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))
    return img.resize((size, size), Image.LANCZOS)


# --- provenance ----------------------------------------------------------------
XMP_PHOTO = (
    '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>'
    '<x:xmpmeta xmlns:x="adobe:ns:meta/">'
    '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
    '<rdf:Description rdf:about=""'
    ' xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/"'
    ' xmlns:xmpRights="http://ns.adobe.com/xap/1.0/rights/"'
    ' xmlns:dc="http://purl.org/dc/elements/1.1/">'
    "<Iptc4xmpExt:DigitalSourceType>"
    "http://cv.iptc.org/newscodes/digitalsourcetype/digitalCapture"
    "</Iptc4xmpExt:DigitalSourceType>"
    "<dc:creator><rdf:Seq><rdf:li>{artist}</rdf:li></rdf:Seq></dc:creator>"
    "<dc:rights><rdf:Alt><rdf:li xml:lang=\"x-default\">{licence}</rdf:li></rdf:Alt></dc:rights>"
    "<dc:source>{source}</dc:source>"
    "<xmpRights:WebStatement>{licence_url}</xmpRights:WebStatement>"
    "<dc:description><rdf:Alt><rdf:li xml:lang=\"x-default\">{description}</rdf:li>"
    "</rdf:Alt></dc:description>"
    "</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end=\"w\"?>"
)

XMP_PLACEHOLDER = (
    '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>'
    '<x:xmpmeta xmlns:x="adobe:ns:meta/">'
    '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
    '<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">'
    "<dc:description><rdf:Alt><rdf:li xml:lang=\"x-default\">{description}</rdf:li>"
    "</rdf:Alt></dc:description>"
    "</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end=\"w\"?>"
)

PHOTO_DESC = (
    "Photograph of {sitter} by {artist}, {licence}, from Wikimedia Commons "
    "({source}). Cropped to a circle and set in the Signature Sound Vienna "
    "exhibit's medallion frame; display only, no fact is derived from it."
)
PLACEHOLDER_DESC = (
    "Placeholder medallion for {sitter}, who has no freely-licensed photograph "
    "on Wikimedia Commons. Depicts nobody: a drawn frame with an empty field."
)


# --- roster --------------------------------------------------------------------
def roster():
    """Every conductor the exhibit names, with how often, newest data wins.

    Derived rather than hard-coded, so a conductor added to either sidecar shows
    up here as a missing portrait instead of being silently absent.
    """
    out = {}
    with open(CONCERTS, encoding="utf-8") as fh:
        for c in json.load(fh)["concerts"]:
            n = c.get("conductor")
            if n:
                out.setdefault(n, {"concerts": 0, "recordings": 0})["concerts"] += 1
    with open(METADATA, encoding="utf-8") as fh:
        recs = json.load(fh)["recordings"]
        for r in (recs.values() if isinstance(recs, dict) else recs):
            n = r.get("conductor")
            if n:
                out.setdefault(n, {"concerts": 0, "recordings": 0})["recordings"] += 1
    return out


def load_sources():
    if not os.path.exists(SOURCES):
        sys.exit(f"{SOURCES} does not exist yet — run `survey` first and author it.")
    with open(SOURCES, encoding="utf-8") as fh:
        return json.load(fh)


# --- commands ------------------------------------------------------------------
def cmd_survey(args):
    people = roster()
    known = load_sources()["conductors"] if os.path.exists(SOURCES) else {}
    qids = {v.get("name", k): v.get("wikidata") for k, v in known.items()}
    os.makedirs(args.out, exist_ok=True)

    report = {}
    for name, counts in sorted(people.items(), key=lambda kv: -kv[1]["concerts"]):
        if args.only and args.only.lower() not in name.lower():
            continue
        qid = qids.get(name)
        if not qid:
            print(f"  {name:28s} NO WIKIDATA QID in sources.json — skipped")
            report[name] = {"error": "no wikidata qid"}
            continue
        try:
            category, cands = candidates_for(name, qid, name_filter=not args.any_name)
        except Exception as exc:
            print(f"  {name:28s} ERROR {exc}")
            report[name] = {"error": str(exc)}
            continue
        cands = cands[:args.limit]
        tiers = ", ".join(f"{TIER_NAME[t]}={sum(1 for c in cands if c['tier'] == t)}"
                          for t in (TIER_FREE, TIER_BY, TIER_SA) )
        print(f"  {name:28s} {len(cands):2d} candidate(s)  [{tiers}]  cat={category}")
        report[name] = {"wikidata": qid, "category": category, "candidates": cands}
        if cands and not args.no_sheets:
            path = os.path.join(args.out, re.sub(r"\W+", "-", name.lower()).strip("-") + ".png")
            contact_sheet(name, cands).save(path)
            print(f"      sheet: {path}")
        time.sleep(0.2)

    with open(os.path.join(args.out, "candidates.json"), "w", encoding="utf-8") as fh:
        json.dump(report, fh, ensure_ascii=False, indent=2)
    print(f"\ncandidates.json written to {args.out}")
    print("Choose by eye, then write the file title and crop into\n  " + SOURCES)


def cmd_build(args):
    src = load_sources()
    people = roster()
    os.makedirs(args.cache, exist_ok=True)
    credits, written, missing = {}, [], []

    for slug, entry in src["conductors"].items():
        if args.only and args.only.lower() not in slug.lower():
            continue
        name = entry["name"]
        out_path = os.path.join(PORTRAIT_DIR, f"{slug}.webp")

        if not entry.get("file"):
            asset = compose(None, size=args.size)
            desc = PLACEHOLDER_DESC.format(sitter=name)
            if not args.dry_run:
                asset.save(out_path, "WEBP", quality=args.quality, method=6,
                           xmp=XMP_PLACEHOLDER.format(description=desc).encode())
            credits[name] = {
                "path": f"portraits/{slug}.webp", "placeholder": True,
                "why": entry.get("_why", "no freely-licensed photograph found"),
            }
            missing.append(name)
            print(f"  {slug:18s} PLACEHOLDER   {name}")
            continue

        title = entry["file"] if entry["file"].startswith("File:") else "File:" + entry["file"]
        meta = file_meta([title]).get(title)
        if not meta or not meta["url"]:
            sys.exit(f"{slug}: Commons has no file {title!r} — check sources.json")

        cached = os.path.join(args.cache, re.sub(r"\W+", "_", title)[:120] + ".img")
        if not os.path.exists(cached):
            with open(cached, "wb") as fh:
                fh.write(fetch_bytes(meta["thumb"] or meta["url"]))
        img = Image.open(cached).convert("RGB")

        asset = compose(square_crop(img, entry["crop"], slug), size=args.size)
        # CREDIT EVERYTHING WE CAN NAME, not only what the licence compels (user,
        # 2026-09-18). So a public-domain photograph is credited too, and when the
        # photographer is genuinely unrecorded the holding institution stands in —
        # that is what Commons's Credit field usually carries for an archive scan.
        artist = (entry.get("artist") or tidy_artist(meta["artist"])
                  or tidy_artist(meta["credit"]) or "")
        desc = PHOTO_DESC.format(sitter=name, artist=artist, licence=meta["licence"],
                                 source=meta["descriptionurl"])
        if not args.dry_run:
            asset.save(out_path, "WEBP", quality=args.quality, method=6,
                       xmp=XMP_PHOTO.format(
                           artist=_xml(artist), licence=_xml(meta["licence"]),
                           source=_xml(meta["descriptionurl"]),
                           licence_url=_xml(meta["licence_url"]),
                           description=_xml(desc)).encode())
        credits[name] = {
            "path": f"portraits/{slug}.webp",
            "artist": artist or None,
            # Whether the LICENCE COMPELS a credit, decided here rather than by the
            # exhibit parsing licence strings on the glass. The exhibit credits
            # every picture it can name regardless (see `artist` above), so this
            # is the record of what was obligatory as against what was courtesy —
            # which is the thing anyone auditing the wall will want to know.
            "attribution": licence_tier(meta["licence"]) != TIER_FREE,
            "licence": meta["licence"],
            "licenceUrl": meta["licence_url"],
            "source": meta["descriptionurl"],
            # An authored `year` of null means "there is no reliable date", not
            # "look one up": the BnF dates Boskovsky's plate 1936 while dating the
            # ensemble in it from 1948, so the exhibit shows no year rather than a
            # wrong one. Only a MISSING key falls back to what Commons says.
            "photoYear": _year(entry["year"] if "year" in entry else meta["date"]),
            "restrictions": meta["restrictions"] or None,
        }
        written.append(name)
        kb = 0 if args.dry_run else os.path.getsize(out_path) // 1024
        print(f"  {slug:18s} {TIER_NAME[licence_tier(meta['licence'])]:5s} "
              f"{meta['licence'][:16]:16s} {kb:3d} KB  {name}")

    if not args.dry_run:
        with open(CREDITS, "w", encoding="utf-8") as fh:
            json.dump({
                "schema": "ssv-exhibit-portrait-credits/1",
                "note": ("Generated by tools/fetch_conductor_portraits.py and COMMITTED: "
                         "the kiosk has no network, and CC BY/BY-SA require the credit to "
                         "travel with the image."),
                "conductors": credits,
            }, fh, ensure_ascii=False, indent=2)
            fh.write("\n")

    absent = [n for n in people if n not in credits]
    print(f"\n{len(written)} portrait(s), {len(missing)} placeholder(s).")
    if absent:
        print("NOT IN sources.json (no portrait at all): " + ", ".join(sorted(absent)))
    if not args.dry_run:
        print(f"credits.json written to {CREDITS}")
        print("Now re-run tools/prep_exhibit_concerts.py so the sidecar picks them up.")


def _xml(s):
    return (str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))


def _year(s):
    m = re.search(r"(1[89]\d\d|20\d\d)", str(s or ""))
    return int(m.group(1)) if m else None


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    default_review = os.path.join(os.environ.get("TMPDIR", "/tmp"), "ssv-portrait-survey")
    s = sub.add_parser("survey", help="propose candidates for a human to choose from")
    s.add_argument("--out", default=default_review, help="review directory (outside the repo)")
    s.add_argument("--only", help="substring of one conductor's name")
    s.add_argument("--limit", type=int, default=8, help="candidates per conductor")
    s.add_argument("--no-sheets", action="store_true", help="JSON only, no contact sheets")
    s.add_argument("--any-name", action="store_true",
                   help="keep files whose title does not name the sitter — a category "
                        "filed under a venue hides its portraits from the usual filter")
    s.set_defaults(func=cmd_survey)

    b = sub.add_parser("build", help="render medallions from the authored sources.json")
    b.add_argument("--only", help="substring of one conductor's slug")
    b.add_argument("--cache", default=os.path.join(default_review, "originals"))
    b.add_argument("--size", type=int, default=CANVAS)
    b.add_argument("--quality", type=int, default=88)
    b.add_argument("--dry-run", action="store_true")
    b.set_defaults(func=cmd_build)

    args = ap.parse_args()
    # The template's invariants, asserted rather than trusted.
    if not 0 < RING_INNER < MEDALLION_FRAC <= 1.0:
        sys.exit("ring geometry is inside out")
    args.func(args)


if __name__ == "__main__":
    main()
