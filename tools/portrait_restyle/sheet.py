"""Comparison sheet for the pilot: per sitter, the source crop, the shipped
medallion, and every render, each composed into the REAL medallion template
(constants and drawing copied from tools/fetch_conductor_portraits.py compose()).

usage: sheet.py OUT.png TAG[,TAG...] (SLUG [SLUG...] | all)
"""
import glob, math, os, re, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import INPUTS, OUT, PORTRAITS as SHIPPED, sitters
CANVAS, MEDALLION_FRAC, RING_INNER, RING_GOLD, SS = 340, 0.86, 0.775, (198, 162, 94), 4


def compose(face, size=CANVAS):
    n = size * SS
    yy, xx = np.mgrid[0:n, 0:n]
    c = (n - 1) / 2
    rad = np.hypot(yy - c, xx - c) / (n / 2)
    ang = np.arctan2(yy - c, xx - c)
    disc = np.asarray(face.convert("RGB").resize((n, n), Image.LANCZOS), dtype=float)
    lit = 1.0 + 0.16 * np.cos(ang - math.radians(-135.0))
    mid, halfband = (RING_INNER + MEDALLION_FRAC) / 2, (MEDALLION_FRAC - RING_INNER) / 2
    bevel = 1.0 - 0.28 * np.clip(np.abs(rad - mid) / halfband, 0, 1) ** 2
    rgb = np.clip(np.array(RING_GOLD, float)[None, None] * np.clip(lit * bevel, .35, 1.45)[..., None], 0, 255)
    ring_a = ((rad >= RING_INNER) & (rad <= MEDALLION_FRAC)).astype(float) * 255
    inner_a = (rad <= RING_INNER + 1.5 / (n / 2)).astype(float) * 255
    out = np.concatenate([np.where(ring_a[..., None] > 0, rgb, disc),
                          np.maximum(inner_a, ring_a)[..., None]], axis=2)
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8)).resize((size, size), Image.LANCZOS)


def main(out_path, tags, slugs, cell=300):
    tags = tags.split(",")
    try:
        font = ImageFont.load_default(15)
    except TypeError:
        font = ImageFont.load_default()
    rows = []
    for slug in slugs:
        items = [("source crop", Image.open(os.path.join(INPUTS, f"in-{slug}.png"))),
                 ("photo", Image.open(os.path.join(SHIPPED, "photo", f"{slug.split('.')[0]}.webp")).convert("RGBA"))]
        for tag in tags:
            for p in sorted(glob.glob(os.path.join(OUT, f"{slug}-{tag}-s*.png"))):
                seed = re.search(r"-s(\d+)\.png$", p).group(1)
                items.append((f"{tag} seed {seed}", compose(Image.open(p))))
        rows.append((slug, items))
    ncol = max(len(i) for _, i in rows)
    W, H = 20 + ncol * (cell + 12), 20 + len(rows) * (cell + 40)
    sheet = Image.new("RGB", (W, H), (32, 28, 30))
    d = ImageDraw.Draw(sheet)
    for r, (slug, items) in enumerate(rows):
        for c, (label, im) in enumerate(items):
            x, y = 20 + c * (cell + 12), 20 + r * (cell + 40)
            im = im.copy()
            if label == "source crop":
                im = im.convert("RGB").resize((cell, cell), Image.LANCZOS)
                sheet.paste(im, (x, y))
            else:
                im = im.resize((cell, cell), Image.LANCZOS)
                sheet.paste(im, (x, y), im)
            d.text((x + 4, y + cell + 6), f"{slug}: {label}", fill=(235, 220, 170), font=font)
    sheet.save(out_path)
    print(out_path, sheet.size)


if __name__ == "__main__":
    slugs = sys.argv[3:]
    main(sys.argv[1], sys.argv[2], sitters() if slugs == ["all"] else slugs)
