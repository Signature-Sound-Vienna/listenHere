"""Image search for appearance FACTS (hair, eyes, glasses, complexion) of the
sitters whose source photo is black and white. Lists each Commons category (one
level of subcategories), keeps the COLOUR images, and lays them out by date so
hair and eye colour can be read near the year of the source photo.
Nothing fetched here is reused in any output image.

usage: look.py OUTDIR SLUG=Category_name [...]
"""
import io, json, os, re, sys, time, urllib.parse, urllib.request
import numpy as np
from PIL import Image, ImageDraw, ImageFont

API = "https://commons.wikimedia.org/w/api.php"
UA = "exhibit-portrait-pilot/0.1 (local research script)"


def get(url, tries=5):
    for a in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code != 429 or a == tries - 1:
                raise
            time.sleep(int(e.headers.get("Retry-After") or 10 * (a + 1)))


def api(**p):
    p.update(format="json", formatversion=2)
    return json.loads(get(API + "?" + urllib.parse.urlencode(p)))


def members(cat, kind):
    out, cont = [], {}
    while True:
        r = api(action="query", list="categorymembers", cmtitle="Category:" + cat,
                cmtype=kind, cmlimit=500, **cont)
        out += [m["title"] for m in r["query"]["categorymembers"]]
        if "continue" not in r:
            return out
        cont = {"cmcontinue": r["continue"]["cmcontinue"]}


def info(titles):
    res = []
    for i in range(0, len(titles), 40):
        r = api(action="query", titles="|".join(titles[i:i + 40]), prop="imageinfo",
                iiprop="url|extmetadata|mime", iiurlwidth=260)
        for pg in r["query"]["pages"]:
            ii = (pg.get("imageinfo") or [{}])[0]
            if not ii.get("mime", "").startswith("image/") or "svg" in ii.get("mime", ""):
                continue
            md = ii.get("extmetadata", {})
            date = re.sub("<[^>]+>", "", md.get("DateTimeOriginal", {}).get("value", ""))
            res.append({"title": pg["title"], "thumb": ii.get("thumburl"), "date": date.strip()[:40]})
    return res


def year_of(d, title):
    m = re.search(r"(18|19|20)\d\d", d) or re.search(r"(18|19|20)\d\d", title)
    return int(m.group(0)) if m else 9999


def main(outdir, pairs):
    os.makedirs(outdir, exist_ok=True)
    font = ImageFont.load_default(13)
    for pair in pairs:
        slug, cat = pair.split("=", 1)
        cats = [cat] + [c.split(":", 1)[1] for c in members(cat, "subcat")]
        files = []
        for c in cats:
            files += [f for f in members(c, "file") if f not in files]
        items = []
        for it in info(files[:150]):
            if not it["thumb"]:
                continue
            im = Image.open(io.BytesIO(get(it["thumb"]))).convert("RGB")
            a = np.asarray(im, float)
            chroma = (a.max(2) - a.min(2)).mean()
            if chroma < 14:  # black and white or near it: says nothing about colour
                continue
            it.update(im=im, chroma=chroma, year=year_of(it["date"], it["title"]))
            items.append(it)
            time.sleep(0.2)
        items.sort(key=lambda x: x["year"])
        cell, cols = 260, 6
        rows = max(1, (len(items) + cols - 1) // cols)
        sheet = Image.new("RGB", (cols * (cell + 8) + 8, rows * (cell + 44) + 8), (30, 30, 30))
        d = ImageDraw.Draw(sheet)
        for k, it in enumerate(items):
            x, y = 8 + (k % cols) * (cell + 8), 8 + (k // cols) * (cell + 44)
            im = it["im"].copy()
            im.thumbnail((cell, cell))
            sheet.paste(im, (x, y))
            d.text((x, y + cell + 4), f"#{k} {it['year'] if it['year'] < 9999 else '?'}",
                   fill=(240, 220, 160), font=font)
            d.text((x, y + cell + 20), it["title"][5:40], fill=(200, 200, 200), font=font)
        sheet.save(os.path.join(outdir, f"{slug}.jpg"), quality=85)
        with open(os.path.join(outdir, f"{slug}.json"), "w") as fh:
            json.dump([{k: v for k, v in it.items() if k != "im"} for it in items], fh, indent=1)
        print(slug, len(files), "files,", len(items), "colour", flush=True)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2:])
