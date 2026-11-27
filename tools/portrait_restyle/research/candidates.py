"""Survey a sitter's Commons category (+ one level of subcategories) for
replacement portrait candidates: every bitmap, with licence, size, and date,
laid out as a numbered contact sheet. Research only; it proposes, never picks.

usage: candidates.py OUTDIR SLUG=Category_name [...]
"""
import io, json, os, re, sys, time, urllib.parse, urllib.request
from PIL import Image, ImageDraw, ImageFont

API = "https://commons.wikimedia.org/w/api.php"
UA = "exhibit-portrait-pilot/0.1 (local research script)"
SKIP = re.compile(r"grave|grab|signat|autogra|plaque|stern|star|letter|brief|poster|plakat|logo", re.I)


def get(url, tries=6):
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


def clean(v):
    return re.sub(r"\s+", " ", re.sub("<[^>]+>", "", v or "")).strip()


def main(outdir, pairs):
    os.makedirs(outdir, exist_ok=True)
    font = ImageFont.load_default(13)
    for pair in pairs:
        slug, cat = pair.split("=", 1)
        cats = [cat] + [c.split(":", 1)[1] for c in members(cat, "subcat")]
        files = []
        for c in cats:
            files += [f for f in members(c, "file") if f not in files and not SKIP.search(f)]
        items = []
        for i in range(0, len(files), 40):
            r = api(action="query", titles="|".join(files[i:i + 40]), prop="imageinfo",
                    iiprop="url|size|extmetadata|mime", iiurlwidth=300)
            for pg in r["query"]["pages"]:
                ii = (pg.get("imageinfo") or [{}])[0]
                if not ii.get("mime", "").startswith("image/") or "svg" in ii["mime"]:
                    continue
                md = ii.get("extmetadata", {})
                items.append({"title": pg["title"], "thumb": ii.get("thumburl"),
                              "w": ii.get("width"), "h": ii.get("height"),
                              "licence": clean(md.get("LicenseShortName", {}).get("value")),
                              "artist": clean(md.get("Artist", {}).get("value"))[:80],
                              "date": clean(md.get("DateTimeOriginal", {}).get("value"))[:30],
                              "restrictions": clean(md.get("Restrictions", {}).get("value"))})
        cell, cols = 300, 5
        rows = (len(items) + cols - 1) // cols
        sheet = Image.new("RGB", (cols * (cell + 8) + 8, rows * (cell + 60) + 8), (30, 30, 30))
        d = ImageDraw.Draw(sheet)
        for k, it in enumerate(items):
            x, y = 8 + (k % cols) * (cell + 8), 8 + (k // cols) * (cell + 60)
            try:
                im = Image.open(io.BytesIO(get(it["thumb"]))).convert("RGB")
                im.thumbnail((cell, cell))
                sheet.paste(im, (x, y))
            except Exception as exc:  # a broken thumb must not stop the survey
                d.text((x, y), f"thumb failed: {exc}"[:40], fill=(255, 120, 120), font=font)
            d.text((x, y + cell + 4), f"#{k} {it['w']}x{it['h']} {it['date'][:10]}", fill=(240, 220, 160), font=font)
            d.text((x, y + cell + 20), it["licence"][:44], fill=(160, 220, 160), font=font)
            d.text((x, y + cell + 36), it["title"][5:48], fill=(200, 200, 200), font=font)
            time.sleep(0.3)
        sheet.save(os.path.join(outdir, f"cand-{slug}.jpg"), quality=85)
        with open(os.path.join(outdir, f"cand-{slug}.json"), "w") as fh:
            json.dump(items, fh, indent=1, ensure_ascii=False)
        print(slug, len(items), "candidates", flush=True)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2:])
