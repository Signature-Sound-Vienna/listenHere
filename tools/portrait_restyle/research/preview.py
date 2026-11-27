"""Larger previews of named Commons files, or of a full-text File: search, with
licence and size. Research only.

usage: preview.py OUT.jpg (--search "TERMS" | "File:A.jpg" "File:B.jpg" ...)
"""
import io, json, re, sys, time, urllib.parse, urllib.request
from PIL import Image, ImageDraw, ImageFont

API = "https://commons.wikimedia.org/w/api.php"
UA = "exhibit-portrait-pilot/0.1 (local research script)"


def get(url, tries=6):
    for a in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=60) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code != 429 or a == tries - 1:
                raise
            time.sleep(int(e.headers.get("Retry-After") or 10 * (a + 1)))


def api(**p):
    p.update(format="json", formatversion=2)
    return json.loads(get(API + "?" + urllib.parse.urlencode(p)))


def clean(v):
    return re.sub(r"\s+", " ", re.sub("<[^>]+>", "", v or "")).strip()


def main(out, args):
    if args[0] == "--search":
        r = api(action="query", list="search", srsearch=args[1], srnamespace=6, srlimit=40)
        titles = [s["title"] for s in r["query"]["search"]]
    else:
        titles = args
    items = []
    for i in range(0, len(titles), 40):
        r = api(action="query", titles="|".join(titles[i:i + 40]), prop="imageinfo",
                iiprop="url|size|extmetadata|mime", iiurlwidth=520)
        for pg in r["query"]["pages"]:
            ii = (pg.get("imageinfo") or [{}])[0]
            if not ii.get("mime", "").startswith("image/") or "svg" in ii.get("mime", ""):
                continue
            md = ii.get("extmetadata", {})
            items.append((pg["title"], ii["thumburl"], ii["width"], ii["height"],
                          clean(md.get("LicenseShortName", {}).get("value")),
                          clean(md.get("DateTimeOriginal", {}).get("value"))[:20]))
    font = ImageFont.load_default(15)
    cell, cols = 520, 4
    rows = (len(items) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * (cell + 10) + 10, rows * (cell + 62) + 10), (30, 30, 30))
    d = ImageDraw.Draw(sheet)
    for k, (t, u, w, h, lic, date) in enumerate(items):
        x, y = 10 + (k % cols) * (cell + 10), 10 + (k // cols) * (cell + 62)
        im = Image.open(io.BytesIO(get(u))).convert("RGB")
        im.thumbnail((cell, cell))
        sheet.paste(im, (x, y))
        d.text((x, y + cell + 4), f"#{k} {w}x{h} {date}  {lic}", fill=(240, 220, 160), font=font)
        d.text((x, y + cell + 24), t[5:62], fill=(210, 210, 210), font=font)
        print(k, t, w, h, lic, date, flush=True)
        time.sleep(0.3)
    sheet.save(out, quality=85)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2:])
