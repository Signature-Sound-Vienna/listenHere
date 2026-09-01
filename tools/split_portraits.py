#!/usr/bin/env python3
"""Split a contact sheet of Gen-AI conductor portraits into one file per sitter.

The portraits arrive as a single image: a grid of circular gold-ringed medallions
on blue velvet, separated by white rules. This cuts them out.

WHY IT FINDS THE RINGS INSTEAD OF DIVIDING BY THE GRID. A nominal 3x3 of a
1600x898 sheet gives 533x299 cells, and the medallions are neither centred in
those cells nor the same distance from their edges — the sheet is letterboxed,
the rules have their own thickness, and the generator does not place the circles
to the pixel. Cropping on the nominal grid clips gold off one side of most of
them. Finding each ring by colour and cropping a square around its own centre is
both more accurate and indifferent to the grid shape, so the next batch can be a
4x3 or a strip of five without editing anything but --rows and --cols.

MARGIN. The band renders a portrait as a `border-radius: 50%` element with
`background-size: cover`, so the inscribed circle of the crop is what a visitor
sees. Cropping flush to the ring's outer edge leaves the ring exactly on that
boundary, where antialiasing eats it; a few pixels of velvet keeps it whole.

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
import os
import sys

try:
    import numpy as np
    from PIL import Image
except ImportError as exc:  # pragma: no cover - environment guidance
    sys.exit(f"{exc}. Pillow and numpy are in the system python3 here, not venv/.")


OUT_DIR = os.path.join("app", "static", "exhibit", "portraits")

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


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("sheet", help="the contact sheet image")
    ap.add_argument("--rows", type=int, default=3)
    ap.add_argument("--cols", type=int, default=3)
    ap.add_argument("--margin", type=int, default=3, help="velvet kept outside the ring")
    ap.add_argument("--quality", type=int, default=90)
    ap.add_argument("--out", default=OUT_DIR)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

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
        cx, cy, radius = circle
        half = radius + args.margin
        box = (round(cx - half), round(cy - half), round(cx + half), round(cy + half))
        crop = img.crop(box)
        name = f"{recording}-{surname}.jpg" if recording else f"{surname}.jpg"
        rel = name if recording else os.path.join("unassigned", name)
        path = os.path.join(args.out, rel)
        if not args.dry_run:
            crop.save(path, "JPEG", quality=args.quality, optimize=True)
        written.append({"file": rel, "sitter": full, "recording": recording,
                        "size": crop.size})
        print(f"  {rel:34s} {full:22s} {crop.size[0]}x{crop.size[1]}")

    print(json.dumps({"written": len(written), "out": args.out}, ensure_ascii=False))
    print(
        "\nWire one up by adding a `portrait` field to the recording's entry in\n"
        "app/static/exhibit/data/metadata-overrides.json (see portraits/README.md).\n"
        "These are AI impressions of real, named people: the visible labelling\n"
        "obligation in that README is NOT yet met."
    )


if __name__ == "__main__":
    main()
