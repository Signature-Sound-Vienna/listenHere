#!/usr/bin/env python3
"""Split a contact sheet of Gen-AI conductor portraits into one file per sitter,
and mark each one visibly as AI-generated.

The portraits arrive as a single image: a grid of circular gold-ringed medallions
on blue velvet, separated by white rules. This cuts them out and stamps them.

WHY IT FINDS THE RINGS INSTEAD OF DIVIDING BY THE GRID. A nominal 3x3 of a
1600x898 sheet gives 533x299 cells, and the medallions are neither centred in
those cells nor the same distance from their edges — the sheet is letterboxed,
the rules have their own thickness, and the generator does not place the circles
to the pixel. Cropping on the nominal grid clips gold off one side of most of
them. Finding each ring by colour and cropping a square around its own centre is
both more accurate and indifferent to the grid shape, so the next batch can be a
4x3 or a strip of five without editing anything but --rows and --cols.

MARGIN. A few pixels of velvet outside the ring, so the circular cut below has
clean pixels to antialias against instead of shaving the gold.

THE AI MARK (plan s5.5, designed 2026-09-01). These are invented images of real,
named, living and recently-living people, so every surface that shows one has to
show that it is an impression. The mark is burned into the ASSET rather than
added by the interface, for one reason: a surface cannot forget it. The band,
the strap, the discographic views still to be built, and anything after them all
inherit it, and it needs no text, so the band's no-labels rule (plan s6.3 — a
caption would have to pick one of two readers' languages) survives intact.

Its shape and position are all forced by measurements, not taste:

  * NOT ON THE GOLD RING. The ring is only ~4.5% of the diameter (radius 130 to
    143 of a 289 px crop) — 3.2 px at the band's 72 and 1.3 px on a strap disc.
    A mark laid on the metal is invisible even at full asset size. Tried.
  * NOT IN THE SQUARE'S CORNER EITHER, tempting as it is. Both surfaces clip to
    a circle (`border-radius: 50%` on `.mb-portrait` and `.strap-btn::before`),
    so a corner mark is clipped away and never drawn. That is also why the
    medallion is INSET to MEDALLION_FRAC: the mark needs somewhere to sit that
    the clip will still keep.
  * IT STRADDLES THE RIM rather than floating clear of it (user's call,
    2026-09-01, having seen both). Clear of the gold is possible but costs the
    face: the mark and its clearance have to fit inside the same circular clip,
    so a bubble that clears the ring puts the medallion at 0.70-0.76 of the box
    instead of 0.86 — 56 px in the band against 69. Straddling reads as a seal
    pinned to the rim and costs nothing.
  * IT CARRIES ITS OWN CONTRAST. Half the mark lies outside the ring, on the
    THEME's ground rather than on the portrait, and those grounds run from
    #17171b to parchment's cream #e0cfa8. A plain gold spark measures ~1.3:1 on
    the cream and simply disappears. A gold bubble with the spark knocked out of
    it dark, and a dark keyline round its edge, reads on all four grounds the
    exhibit uses because its contrast is internal.

Geometry is in units of the canvas HALF-WIDTH, so 1.0 is the clip boundary and
MEDALLION_FRAC is the medallion's RADIUS (not its diameter — that trap cost a
round of this design). The invariants are asserted in main().

FORMAT. WebP, not JPEG (no alpha channel, and the inset medallion needs one) and
not PNG. Measured on a real crop: WebP q88 20 KB, PNG 134 KB, the JPEG this
replaces 24 KB. Alpha therefore costs nothing.

No font is loaded anywhere: the spark is a polygon and the bubble an ellipse, so
this reproduces identically on a machine with different fonts installed.

NAMING is per RECORDING, not per conductor (user, 2026-09-01): the corpus runs
to 90-odd releases and 60-plus New Year's Concerts, the same conductor recurs
across decades, and each version gets a portrait of the sitter at the age they
were for that concert. So the mapping below is authored, not derived — a sheet
carries faces, and only a person knows which recording each face is for.
Anything with no recording yet goes to unassigned/ under the sitter's surname.

Usage:
    python3 tools/split_portraits.py ConductorPortraits_initial.jpg

Needs Pillow and numpy. NOTE: they are in the SYSTEM python3 on this machine,
not in venv/ — run it with python3, not venv/bin/python.
"""

import argparse
import json
import math
import os
import sys

try:
    import numpy as np
    from PIL import Image, ImageDraw
except ImportError as exc:  # pragma: no cover - environment guidance
    sys.exit(f"{exc}. Pillow and numpy are in the system python3 here, not venv/.")


OUT_DIR = os.path.join("app", "static", "exhibit", "portraits")

# --- the AI mark (see THE AI MARK in the module docstring) --------------------
# Fractions of the canvas half-width, so 1.0 is the surfaces' circular clip.
# MEDALLION_FRAC is the medallion's diameter over the canvas WIDTH, which is the
# same number as its radius in half-widths — the unit the mark's constants use.
# Reading it as a radius over the half-width and then halving it again is the
# mistake that put the mark inside the portrait for a round.
MEDALLION_FRAC = 0.86  # medallion diameter / canvas = medallion radius in half-widths
MARK_DIST = 0.74       # bubble centre, out along the upper-right diagonal
MARK_R = 0.13          # bubble radius
MARK_SPARK = 0.62      # spark radius, as a fraction of the bubble's
MARK_ANGLE = -45.0     # upper right

# The bubble wears the medallion's own gold so it reads as part of the object,
# with a keyline dark enough to hold its edge against parchment's cream.
MARK_GOLD = (212, 178, 94)
MARK_KEYLINE = (108, 82, 30)
MARK_SPARK_INK = (38, 30, 14)

# Everything a viewer or a downstream tool needs to know that this is synthetic.
# `trainedAlgorithmicMedia` is IPTC's term for it, and the XMP travels with the
# file — so the claim survives the image being copied out of the exhibit, which
# a burned-in glyph on its own does not.
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

DESCRIPTION = (
    "AI-generated impression of {sitter}. Not a photograph and not a likeness "
    "taken from life. Made for the Signature Sound Vienna exhibit; display only, "
    "no fact is derived from it."
)

# Batch 1 (2026-09-01), left to right, top to bottom, as delivered. The
# recording is None for a sitter with no recording in the payload yet.
# Spellings are the standard ones, which the contact sheet's caption was not:
# Claudio Abbado (two b), Mariss Jansons (-ons), Franz Welser-Möst.
BATCH1 = [
    ("karajan", "Herbert von Karajan", "vpo-1987"),
    ("muti", "Riccardo Muti", None),
    ("welser-moest", "Franz Welser-Möst", None),
    ("maazel", "Lorin Maazel", None),
    ("kleiber", "Carlos Kleiber", "vpo-1989"),
    ("abbado", "Claudio Abbado", None),
    ("harnoncourt", "Nikolaus Harnoncourt", None),
    ("jansons", "Mariss Jansons", None),
    ("barenboim", "Daniel Barenboim", "vpo-2022"),
]


def _bands(profile, count, bright=200.0, dark=25.0):
    """Split one axis into `count` bands, on the sheet's own rules if it has them.

    `profile` is the mean brightness per row (or per column). A contact sheet of
    this kind carries white rules between cells and a dark letterbox around the
    outside, and both are trivially visible in that profile — so use them, and
    fall back to equal division only when they are not there.

    THIS IS THE PART THAT MATTERS FOR ACCURACY. The medallions fill ~98% of their
    cell's height, so an equal-thirds boundary lands within a pixel or two of the
    neighbouring ring and the gold search then bleeds across the line. Measured
    on batch 1: equal thirds put three of nine crops at 299-303 px against a true
    289, visibly off-centre. Cutting on the rules puts all nine at 283.
    """
    n = len(profile)
    lo, hi = 0, n
    while lo < n and profile[lo] < dark:
        lo += 1
    while hi > lo and profile[hi - 1] < dark:
        hi -= 1

    runs, i = [], lo
    while i < hi:
        if profile[i] > bright:
            j = i
            while j < hi and profile[j] > bright:
                j += 1
            runs.append((i, j))
            i = j
        else:
            i += 1

    if len(runs) == count - 1:
        edges = [lo] + [r[0] for r in runs] + [hi]
        ends = [runs[k][1] for k in range(len(runs))]
        return [
            (edges[k] if k == 0 else ends[k - 1], edges[k + 1])
            for k in range(count)
        ]
    # No usable rules: equal division of the content area, and accept the bleed.
    step = (hi - lo) / count
    return [(round(lo + k * step), round(lo + (k + 1) * step)) for k in range(count)]


def find_medallions(img, rows, cols):
    """Bounding box of each medallion, as (cx, cy, radius) in image pixels.

    Cells come from the sheet's own rules (see `_bands`); the crop itself comes
    from the ring's own pixels, so an off-centre medallion is cropped off-centre
    too and stays whole.
    """
    a = np.asarray(img).astype(int)
    r, g, b = a[:, :, 0], a[:, :, 1], a[:, :, 2]
    # Gold: red well clear of blue, and bright enough to exclude both the blue
    # velvet ground and the dark letterbox. Deliberately loose — it only has to
    # separate the ring from two very different backgrounds.
    gold = (r > 140) & (g > 105) & (r - b > 70) & (g - b > 35)

    grey = a.mean(axis=2)
    row_bands = _bands(grey.mean(axis=1), rows)
    col_bands = _bands(grey.mean(axis=0), cols)

    out = []
    for (y0, y1) in row_bands:
        for (x0, x1) in col_bands:
            ys, xs = np.where(gold[y0:y1, x0:x1])
            if len(ys) < 100:
                out.append(None)
                continue
            # Percentiles, not min/max: JPEG ringing scatters a few gold-ish
            # pixels across the velvet, and one of them would inflate the crop.
            #
            # A bounding box rather than a radial fit, which was tried and is
            # WORSE here: the medallion's interior is full of gold-ish pixels
            # (skin, warm highlights, the pale sheet music behind the sitter),
            # so a percentile over distance-from-centre measures the content,
            # not the ring — it put batch 1 at 316-356 px against a true 283.
            # The extremes along each axis are the ring, as long as the cell
            # boundaries are right, which is what `_bands` is for.
            yl, yh = np.percentile(ys, [0.2, 99.8])
            xl, xh = np.percentile(xs, [0.2, 99.8])
            out.append(
                ((xl + xh) / 2 + x0, (yl + yh) / 2 + y0, max(yh - yl, xh - xl) / 2)
            )
    return out


def _spark(cx, cy, r):
    """A four-point star: the widely-read shorthand for 'generated'."""
    pts = []
    for k in range(8):
        ang = -math.pi / 2 + k * math.pi / 4
        rad = r if k % 2 == 0 else r * 0.34
        pts.append((cx + rad * math.cos(ang), cy + rad * math.sin(ang)))
    return pts


def compose(img, circle, size, margin, supersample=4, mark=True):
    """The finished asset: medallion inset on transparency, plus the AI mark.

    Drawn at `supersample` times the output and reduced, because both the
    circular cut and the spark's points are diagonal edges that look chewed
    without it — and the strap renders this at 30 px, where chewed is all you
    would see.
    """
    cx, cy, radius = circle
    S = supersample
    N = size * S
    out = Image.new("RGBA", (N, N), (0, 0, 0, 0))

    # The medallion, cut at the ring's own outer edge so the velvet corners go.
    # One pixel of slack (at source scale) so the cut does not shave the gold.
    med = int(round(MEDALLION_FRAC * N))
    half = radius + margin
    box = (round(cx - half), round(cy - half), round(cx + half), round(cy + half))
    face = img.crop(box).resize((med, med), Image.LANCZOS)
    keep = (radius + 1) / half  # the ring's share of the cropped square
    mask = Image.new("L", (med, med), 0)
    inset = med * (1 - min(keep, 1.0)) / 2
    ImageDraw.Draw(mask).ellipse(
        [inset, inset, med - 1 - inset, med - 1 - inset], fill=255
    )
    off = (N - med) // 2
    out.paste(face, (off, off), mask)

    if mark:
        dr = ImageDraw.Draw(out)
        mx = N / 2 + MARK_DIST * (N / 2) * math.cos(math.radians(MARK_ANGLE))
        my = N / 2 + MARK_DIST * (N / 2) * math.sin(math.radians(MARK_ANGLE))
        r = MARK_R * (N / 2)
        dr.ellipse([mx - r, my - r, mx + r, my + r], fill=MARK_GOLD + (255,),
                   outline=MARK_KEYLINE + (255,), width=max(1, round(r * 0.13)))
        dr.polygon(_spark(mx, my, r * MARK_SPARK), fill=MARK_SPARK_INK + (255,))

    return out.resize((size, size), Image.LANCZOS)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("sheet", help="the contact sheet image")
    ap.add_argument("--rows", type=int, default=3)
    ap.add_argument("--cols", type=int, default=3)
    ap.add_argument("--margin", type=int, default=3, help="velvet kept outside the ring")
    ap.add_argument("--quality", type=int, default=88, help="WebP quality")
    ap.add_argument("--size", type=int, default=340,
                    help="output edge in px; the medallion is MEDALLION_FRAC of it")
    ap.add_argument("--out", default=OUT_DIR)
    ap.add_argument("--no-mark", dest="mark", action="store_false",
                    help="omit the AI mark — for inspecting the crop ONLY, never "
                         "for an asset the exhibit will show")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    # The three things the mark's position depends on, asserted rather than
    # trusted. All in half-widths, and MEDALLION_FRAC is already a radius.
    if MARK_DIST + MARK_R >= 1.0:
        sys.exit("the AI mark would fall outside the surfaces' circular clip, "
                 "where it is silently never drawn")
    if MARK_DIST + MARK_R <= MEDALLION_FRAC:
        sys.exit("the AI mark would sit wholly inside the medallion, reading as "
                 "a blemish on the portrait rather than a seal on its rim")
    if MARK_DIST - MARK_R >= MEDALLION_FRAC:
        sys.exit("the AI mark would float clear of the rim; it is meant to "
                 "straddle it (see THE AI MARK), so anchor it to the gold")

    img = Image.open(args.sheet).convert("RGB")
    found = find_medallions(img, args.rows, args.cols)
    if len(found) != len(BATCH1):
        sys.exit(
            f"grid is {args.rows}x{args.cols} = {len(found)} cells but the authored "
            f"mapping has {len(BATCH1)} entries — update BATCH1 for this sheet"
        )

    os.makedirs(os.path.join(args.out, "unassigned"), exist_ok=True)
    written = []
    for circle, (surname, full, recording) in zip(found, BATCH1):
        if circle is None:
            print(f"  !! no medallion found for {full}", file=sys.stderr)
            continue
        asset = compose(img, circle, args.size, args.margin, mark=args.mark)
        name = f"{recording}-{surname}.webp" if recording else f"{surname}.webp"
        rel = name if recording else os.path.join("unassigned", name)
        path = os.path.join(args.out, rel)
        if not args.dry_run:
            asset.save(
                path, "WEBP", quality=args.quality, method=6,
                xmp=XMP.format(description=DESCRIPTION.format(sitter=full)).encode(),
            )
        written.append({"file": rel, "sitter": full, "recording": recording,
                        "size": asset.size, "marked": args.mark})
        kb = 0 if args.dry_run else os.path.getsize(path) // 1024
        print(f"  {rel:34s} {full:22s} {asset.size[0]}x{asset.size[1]}  {kb} KB"
              + ("" if args.mark else "   ** UNMARKED **"))

    print(json.dumps({"written": len(written), "out": args.out,
                      "marked": args.mark}, ensure_ascii=False))
    print(
        "\nWire one up by adding a `portrait` field to the recording's entry in\n"
        "app/static/exhibit/data/metadata-overrides.json (see portraits/README.md).\n"
        "Every asset carries the AI mark and the IPTC digital-source-type; the\n"
        "sentence of prose that explains the mark is the about page's job, and\n"
        "until it ships the labelling obligation is only half met."
    )


if __name__ == "__main__":
    main()
