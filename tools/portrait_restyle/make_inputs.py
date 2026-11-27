"""Restyle inputs: fetch the ORIGINAL Commons file for each sitter and cut the
authored medallion square (sources.json `crop`, same semantics as
tools/fetch_conductor_portraits.py square_crop) at 1024 px for the image model.

usage: ~/ComfyUI/.venv/bin/python -I make_inputs.py [SLUG ...]   (default: every sitter)
Run with the ComfyUI venv (it has Pillow + numpy).
"""
import json, math, os, sys, urllib.parse, urllib.request
import numpy as np
from PIL import Image, ImageOps

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import FACTS, SOURCES, ORIGINALS as CACHE, INPUTS as OUT, sitters

UA = "exhibit-portrait-restyle/0.1 (local research script)"
EDGE = 1024


def get(url):
    import time
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    for attempt in range(6):
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return r.read()
        except urllib.error.HTTPError as exc:
            if exc.code != 429 or attempt == 5:
                raise
            wait = int(exc.headers.get("Retry-After") or 0) or 10 * (attempt + 1)
            print(f"  429, waiting {wait}s", flush=True)
            time.sleep(wait)


def original_url(title):
    q = urllib.parse.urlencode({"action": "query", "prop": "imageinfo", "iiprop": "url|size",
                                "titles": title, "format": "json"})
    d = json.loads(get("https://commons.wikimedia.org/w/api.php?" + q))
    ii = next(iter(d["query"]["pages"].values()))["imageinfo"][0]
    return ii["url"], ii["width"], ii["height"]


def square_crop(img, crop):
    cx, cy, size = crop
    short = min(img.width, img.height)
    half = max(8.0, size * short / 2)
    x, y = cx * img.width, cy * img.height
    if half > short / 2:  # zoom out past the edge: replicate edge pixels
        pad = int(math.ceil(half - short / 2)) + 2
        img = ImageOps.expand(img, border=pad)
        arr = np.array(img)
        arr[:pad, :] = arr[pad:pad + 1, :]
        arr[-pad:, :] = arr[-pad - 1:-pad, :]
        arr[:, :pad] = arr[:, pad:pad + 1]
        arr[:, -pad:] = arr[:, -pad - 1:-pad]
        img = Image.fromarray(arr)
        x, y = x + pad, y + pad
    half = min(half, img.width / 2, img.height / 2)
    nx = min(max(x, half), img.width - half)
    ny = min(max(y, half), img.height - half)
    return img.crop((round(nx - half), round(ny - half), round(nx + half), round(ny + half)))


def main(slugs):
    os.makedirs(CACHE, exist_ok=True)
    os.makedirs(OUT, exist_ok=True)
    src = json.load(open(SOURCES, encoding="utf-8"))["conductors"]
    facts = json.load(open(FACTS, encoding="utf-8"))
    for slug in slugs:
        # 'slug.variant' (sitters.json) trials another source photo for the same sitter
        base = slug.split(".")[0]
        e = dict(src[base], **facts.get(slug, {}).get("source", {}))
        title = e["file"] if e["file"].startswith("File:") else "File:" + e["file"]
        # A crop-only variant (same photograph, new framing) reuses the sitter's original.
        owner = base if e["file"] == src[base]["file"] else slug
        cached = os.path.join(CACHE, owner + os.path.splitext(e["file"])[1].lower())
        if not os.path.exists(cached):
            url, w, h = original_url(title)
            data = get(url)  # fetch first: a failed fetch must not leave an empty cache file
            open(cached, "wb").write(data)
            print(f"{slug}: fetched original {w}x{h}", flush=True)
            __import__("time").sleep(3)  # be gentle with upload.wikimedia.org (429s seen)
        img = Image.open(cached).convert("RGB")
        sq = square_crop(img, e["crop"])
        native = sq.width
        sq = sq.resize((EDGE, EDGE), Image.LANCZOS)
        sq.save(os.path.join(OUT, f"in-{slug}.png"))
        print(f"{slug}: crop {e['crop']} -> {native} px native, saved at {EDGE}")


if __name__ == "__main__":
    main(sys.argv[1:] or sitters())
