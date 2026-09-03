#!/usr/bin/env python3
"""Build the exhibit's New Year's Concert sidecar: the whole series, year by year.

Writes `app/static/exhibit/data/concerts.json` — one entry per New Year's Concert of
the Wiener Philharmoniker, from the founding concert of 31 December 1939 to the last
one the archives know, with the concert's date, conductor, programme, what the
project's library holds of it, and which of the exhibit's recordings come from it.
The by-year explorer in the exhibit reads nothing else (plan §11).

## The spine is the CONCERT SERIES, not the library — and the obvious graph is wrong

The graph the exhibit already reads (`data` repo, TISMIR branch) is DISCOGRAPHIC: it
describes the CDs physically held in the library. A by-year view built on it would
enumerate only the years the library happens to own a recording of and present that
as the concert history. The series is 80-plus concerts; the library holds about 45
years of it. So the spine comes from two PROGRAMME-HISTORICAL graphs, scraped in
March 2022 from the concert archives of the orchestra and of the venue
(`new-years-scrapers` repo; both sites have since changed, do NOT rescrape):

  * `output-philharmoniker-20220322.ttl` — wienerphilharmoniker.at. People are
    LITERALS. Has the two founding concerts of 30/31 December 1939, which the
    Musikverein archive lacks; lacks 1945 and 1951.
  * `output-musikverein-20220322.ttl` — musikverein.at. People are ENTITIES with
    labels. Has 1945, 1951, and the (programme-less, then future) 2023 concert;
    lists the standard encores for recent years where the orchestra's archive does not.

Both use the scrapers' own vocabulary: `mo:Performance` with `dcterms:date`,
`dcterms:title`, `ny:Dirigent`, and numbered `ny:ProgrammeItem`s carrying
`dcterms:creator` + `dcterms:title`. The 2022-03-17 Musikverein file is a broken
earlier scrape (garbage predicates, malformed dates) and is ignored.

## Reconciliation, not a join — and CONTRADICTIONS ARE REPORTED, NEVER CHOSEN SILENTLY

The two archives agree on the conductor of every one of the 82 concerts they share,
and on the year set. They disagree on the programmes in most years, in three ways:

  1. SPELLING of the same work ("Johann Strauß II." vs "Johann Strauß Sohn";
     "Ouv. Prinz Methusalem" vs "Ouvertüre zur Operette „Prinz Methusalem”").
     Handled: items are paired by opus number + composer, then by a normalised
     distinctive title, then by programme position. Paired items count as ONE work.
  2. ENCORES. Neither archive marks them. The Musikverein lists the Blue Danube and
     the Radetzky March for ~21 recent years; the orchestra's archive lists other
     tail items in older years. Handled: the UNION, every item stamped with its
     `source` ("both" / "philharmoniker" / "musikverein") so the view can say which
     archive vouches for it. Nothing is invented — a year where neither archive
     lists the encores shows none.
  3. GENUINE CONTRADICTIONS: the same slot, a different work or composer or opus
     (1946 Persischer Marsch: Johann II, op. 289, or Josef? 1950: Aurora-Polka
     op. 165 or Aurora-Ball op. 219? 1997 Patronessen-Polka: op. 286 or op. 186?).
     Eight in all, measured 2026-09-02.
     Handled: the orchestra's archive is the DEFAULT for display (it is the
     orchestra's own record and it carries the founding concerts), the other reading
     is kept beside it as `alt`, a warning names both, and the markdown report
     (`--report`) lists them for a human ruling. `concerts-overrides.json` is where
     rulings land; it is applied LAST and never rewritten.

## The library join: VPO New Year's Concert records ONLY

The library graph's records are keyed by slug, and the slug convention IS the
concert year for the orchestra's New Year's Concert releases ("1987", "1983
(Bonbons)", ranges like "1951-1954"). Everything else in the library — other VPO
recordings, other orchestras covering the same repertoire — is out of scope for
this view by ruling (user, 2026-09-02): the exhibit is a VPO New Year's Concert
exhibit, and the comparison material lives in the listening view. BOTH graph dumps
are read, because they have diverged (neither is a superset: the newer lost 21
records and gained 8), and a record present in only one dump is reported.

Range records ("1951-1954") attach to every year they cover, marked `covers`, and
the payload's own VPO-1951-1954 is deliberately NOT playable from any year: its
Fledermaus track is a September 1950 studio session, not a New Year's Concert
(metadata-overrides.json has the liner-note evidence).

## Gaps are reported, never filled from memory

The archives were scraped in March 2022, so the series ends at 2023 (conductor
only). 2024 onwards is a GAP and the sidecar says so; the exhibit shows those years
as empty. An override entry may supply them, but it is included only when it carries
`"verified": true` — a plausible recollection is not a fact a museum may publish.

Usage:
    tools/prep_exhibit_concerts.py                 # derive, write the sidecar
    tools/prep_exhibit_concerts.py --dry-run       # report only
    tools/prep_exhibit_concerts.py --report docs/concerts-reconciliation.md
    tools/prep_exhibit_concerts.py --self-test     # check the matching helpers, exit
"""
from __future__ import annotations

import argparse
import collections
import datetime as _dt
import json
import os
import re
import sys
import unicodedata
from urllib.parse import unquote

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCHEMA = "lh-exhibit-concerts/1"
SCRAPERS = "/var/git/signature-sound-vienna/new-years-scrapers"
DEFAULT_PHILHARMONIKER = os.path.join(SCRAPERS, "output-philharmoniker-20220322.ttl")
DEFAULT_MUSIKVEREIN = os.path.join(SCRAPERS, "output-musikverein-20220322.ttl")
DUMP_DIR = "/var/git/signature-sound-vienna/data/data/graph_dump"
# Both, oldest first, because they have diverged (see the docstring). The N-Triples
# serialisation: one triple per line, no prefix games, and the slugs' `_-XX` escapes
# survive intact.
DEFAULT_DUMPS = [os.path.join(DUMP_DIR, "20250605.nt"), os.path.join(DUMP_DIR, "20250826.nt")]
OVERRIDES_FILE = "concerts-overrides.json"

NY = "http://localhost:9999/vocab/"
DCT = "http://purl.org/dc/terms/"
MO = "http://purl.org/ontology/mo/"
RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type"
RDFS_LABEL = "http://www.w3.org/2000/01/rdf-schema#label"
RDFS_COMMENT = "http://www.w3.org/2000/01/rdf-schema#comment"
FOAF_NAME = "http://xmlns.com/foaf/0.1/name"

FOUNDING_YEAR = 1939
# The series' first concert was on New Year's EVE 1939; there was no concert in
# 1940 at all, and from 1941 the date is 1 January. The orchestra's own archive
# titles 1941 "1. Neujahrskonzert" and 1939 "Außerordentliches Konzert", so which
# is "the first" is a matter of framing; the sidecar carries 1939 with
# `founding: true` and lets the view (and the editor) say so.
FOUNDING_DATE = "1939-12-31"

# --- pieces the exhibit can play, and how to recognise them on a programme -------
# Keyed by payload piece id. A programme item matches when its normalised title
# matches `title` and does not match `exclude` — the Fledermaus Csárdás ("Klänge
# der Heimat") is from the same operetta and is not the overture.
PIECES = {
    "fledermaus": {"title": r"\bfledermaus\b", "require": r"\bouvert|\bovert", "exclude": r"csardas|klaenge"},
    "kaiserwalzer": {"title": r"\bkaiser ?walzer\b", "require": None, "exclude": None},
}

# --- composers -----------------------------------------------------------------
# One id per person, however the two archives spell them. `de` follows German
# orthography (the exhibit is German-primary), `en` the international form. Anyone
# not listed passes through as the archive wrote them, with an id slugged from the
# name — this table exists for the handful of names the two archives spell
# DIFFERENTLY from each other, so that one work is never counted twice.
COMPOSERS = {
    "johann-strauss-ii": {
        "match": ["johann strauss ii", "johann strauss sohn", "johann strauss jr", "johann strauss"],
        "de": "Johann Strauß (Sohn)", "en": "Johann Strauss II"},
    "johann-strauss-i": {
        "match": ["johann strauss i", "johann strauss vater", "johann strauss sr"],
        "de": "Johann Strauß (Vater)", "en": "Johann Strauss I"},
    "josef-strauss": {"match": ["josef strauss", "joseph strauss"], "de": "Josef Strauß", "en": "Josef Strauss"},
    "eduard-strauss": {"match": ["eduard strauss"], "de": "Eduard Strauß", "en": "Eduard Strauss"},
    "josef-hellmesberger-ii": {
        "match": ["josef hellmesberger sohn", "josef hellmesberger d j", "josef d j hellmesberger",
                  "josef hellmesberger jr", "joseph hellmesberger sohn"],
        "de": "Josef Hellmesberger (Sohn)", "en": "Josef Hellmesberger Jr."},
    "josef-hellmesberger-i": {
        "match": ["josef hellmesberger vater", "josef hellmesberger sen", "josef hellmesberger d a"],
        "de": "Josef Hellmesberger (Vater)", "en": "Josef Hellmesberger Sr."},
    "emile-waldteufel": {"match": ["emile waldteufel", "emil waldteufel"], "de": "Émile Waldteufel", "en": "Émile Waldteufel"},
    "gioachino-rossini": {"match": ["gioachino rossini", "gioacchino rossini"], "de": "Gioachino Rossini", "en": "Gioachino Rossini"},
    "pyotr-tchaikovsky": {
        "match": ["peter iljitsch tschaikowsky", "peter iljitsch tschaikowskij", "pjotr iljitsch tschaikowski"],
        "de": "Peter Iljitsch Tschaikowski", "en": "Pyotr Ilyich Tchaikovsky"},
    "franz-von-suppe": {"match": ["franz von suppe"], "de": "Franz von Suppè", "en": "Franz von Suppé"},
}
_COMPOSER_INDEX = {m: cid for cid, c in COMPOSERS.items() for m in c["match"]}

# Words that describe a work's genre or framing rather than identify it. Stripped
# before two titles are compared, so "Ouvertüre zur Operette „X“" and "Ouv. X" meet.
GENERIC_WORDS = set("""
ouverture ouvertuere ouv overture zur zu zum der die das den dem des aus operette oper
komischen komische walzer polka schnell francaise franzoesische mazur mazurka marsch
galopp galoppe quadrille op o ohne nach motiven fuer und im akt einleitung vorspiel
ballettmusik charakterstueck musikalischer scherz intermezzo introduktion woo kv d
lustspiel volksstueck komoedie ballett dem couplet
""".split())

# Concert titles that mark the MAIN concert of a year (as opposed to its preview
# or New Year's Eve sibling). Anything dated 1 January is the main concert; the
# founding concert is special-cased.
RELATED_WINDOW_BEFORE = 4   # days before 1 Jan that a Voraufführung/Silvester may fall
RELATED_WINDOW_AFTER = 14   # days after 1 Jan that a Wiederholung may fall


def log(m):
    print(m, file=sys.stderr)


# ---------------------------------------------------------------------------
# Normalisation helpers. All pure, all covered by --self-test.
# ---------------------------------------------------------------------------

def norm(s: str) -> str:
    """Lower-case ASCII skeleton: ß→ss, umlauts transliterated, accents dropped,
    punctuation collapsed to single spaces."""
    s = (s.replace("ß", "ss").replace("ä", "ae").replace("ö", "oe").replace("ü", "ue")
         .replace("Ä", "Ae").replace("Ö", "Oe").replace("Ü", "Ue"))
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9]+", " ", s.lower()).strip()


_OPUS_RE = re.compile(r"\b[o0]p\.?\s*(?:posth?\.?\s*)?(\d+)", re.I)
_NO_OPUS_RE = re.compile(r"\b(ohne|o\.)\s*op|\bo\.op\b|\bwoo\b", re.I)


def opus_of(title: str):
    """The opus number in a title, or None. "0p. 28" (a digit-zero typo in the
    orchestra's archive) counts; "ohne op." / "o. op." / "WoO" do not."""
    if _NO_OPUS_RE.search(title):
        return None
    m = _OPUS_RE.search(title)
    return int(m.group(1)) if m else None


def distinctive(title: str) -> str:
    """The first three identifying words of a title, generic words removed, and
    anything after an arranger credit ("; bearbeitet von …") dropped."""
    head = re.split(r";|\bbearbeitet\b|\binstrumentiert\b|\barrangiert\b|\barr\.", title)[0]
    words = [w for w in norm(head).split() if w not in GENERIC_WORDS and not w.isdigit()]
    return " ".join(words[:3])


def composer_ids(credit: str) -> list:
    """Split a (possibly joint) composer credit into canonical ids.
    "Johann Strauß II., Josef Strauß" and "Johann Strauß Sohn / Josef Strauß" both
    give ["johann-strauss-ii", "josef-strauss"]."""
    out = []
    for part in re.split(r"\s*(?:,|/|&|\bund\b|\band\b)\s*", credit):
        part = part.strip()
        if not part:
            continue
        n = norm(part).replace(" jun ", " jr ").replace(" ii ", " ii ")
        n = re.sub(r"\s+", " ", n).strip()
        cid = _COMPOSER_INDEX.get(n)
        if not cid:
            # Suffix forms: "Josef Strauß" alone must not swallow "Johann Strauß II".
            for m, c in _COMPOSER_INDEX.items():
                if n == m:
                    cid = c
                    break
        out.append(cid or re.sub(r"\s+", "-", n))
    return out


def composer_entry(cid: str, as_written: str) -> dict:
    c = COMPOSERS.get(cid)
    if c:
        return {"id": cid, "name": {"de": c["de"], "en": c["en"]}}
    return {"id": cid, "name": {"de": as_written.strip()}}


def item_key(item: dict):
    """Pairing key, strongest form: opus + first composer; else distinctive title."""
    ids = item["composerIds"]
    op = item["opus"]
    if op is not None:
        return ("op", ids[0] if ids else "", op)
    return ("title", distinctive(item["title"]))


def piece_matches(piece_id: str, title: str) -> bool:
    spec = PIECES[piece_id]
    n = norm(title)
    if not re.search(spec["title"], n):
        return False
    if spec["require"] and not re.search(spec["require"], n):
        return False
    if spec["exclude"] and re.search(spec["exclude"], n):
        return False
    return True


def deslug(s: str) -> str:
    """The library graph writes `%` as `_-` in its slugs (and escapes UTF-8 bytes,
    not code points), so unquote after restoring the percent signs."""
    return unquote(re.sub(r"_-", "%", s))


# ---------------------------------------------------------------------------
# The two programme archives.
# ---------------------------------------------------------------------------

def load_archive(path: str, source: str, warnings: list) -> dict:
    """Parse one scraper output into {uri: performance}. rdflib is in the venv."""
    import rdflib
    from rdflib import RDF, RDFS, URIRef

    g = rdflib.Graph()
    g.parse(path, format="turtle")
    MOp = URIRef(MO + "Performance")
    out = {}

    def label(o):
        if isinstance(o, URIRef):
            lab = g.value(o, RDFS.label)
            return str(lab) if lab else unquote(str(o).rsplit("/", 1)[-1])
        return str(o)

    for p in g.subjects(RDF.type, MOp):
        date = str(g.value(p, URIRef(DCT + "date")) or "")
        if not re.match(r"^\d{4}-\d{2}-\d{2}$", date):
            warnings.append({"kind": "malformed-date", "year": None,
                             "detail": f"{source} {p}: date {date!r} is not yyyy-mm-dd — skipped"})
            continue
        roles = collections.defaultdict(list)
        for pred, o in g.predicate_objects(p):
            ps = str(pred)
            if ps.startswith(NY) and ps != NY + "venue":
                role = unquote(ps[len(NY):]).strip()
                roles[role].append(label(o).strip())
        items = []
        for it in g.subjects(URIRef(DCT + "isPartOf"), p):
            n = g.value(it, URIRef(NY + "programmeItemNumber"))
            title = str(g.value(it, URIRef(DCT + "title")) or "").strip()
            credit = str(g.value(it, URIRef(DCT + "creator")) or "").strip()
            items.append({"n": int(n), "title": title, "credit": credit,
                          "composerIds": composer_ids(credit), "opus": opus_of(title)})
        items.sort(key=lambda i: i["n"])
        conductors = []
        for role, names in roles.items():
            if role.lower().startswith("dirigent"):
                for nm in names:
                    if nm not in conductors:
                        conductors.append(nm)
        comment = g.value(p, RDFS.comment)
        out[str(p)] = {
            "uri": str(p), "source": source, "date": date,
            "title": str(g.value(p, URIRef(DCT + "title")) or "").strip(),
            "conductors": conductors,
            "conductorRole": next((r for r in roles if r.lower().startswith("dirigent")), None),
            "roles": {k: v for k, v in roles.items()},
            "items": items,
            "comment": re.sub(r"\s+", " ", str(comment)).strip() if comment else None,
        }
    log(f"  {source}: {len(out)} performances from {os.path.basename(path)}")
    return out


def main_concert_for(year: int, perfs: list, source: str, warnings: list):
    """The one performance that IS the year's New Year's Concert in one archive:
    dated 1 January (or, for the founding year, 31 December 1939). Duplicated
    identical entries (the orchestra's archive lists 2009 twice) collapse to one."""
    date = FOUNDING_DATE if year == FOUNDING_YEAR else f"{year}-01-01"
    cands = [p for p in perfs if p["date"] == date]
    if not cands:
        return None
    if len(cands) > 1:
        same = all(c["items"] == cands[0]["items"] and c["conductors"] == cands[0]["conductors"]
                   for c in cands[1:])
        warnings.append({"kind": "duplicate-entry", "year": year,
                         "detail": f"{source} lists {len(cands)} performances on {date}"
                                   + (" (identical, one kept)" if same else " (DIFFERENT — first kept)")})
    return cands[0]


def related_for(year: int, perfs: list, main_uri):
    """Sibling performances of the same programme: the preview and New Year's Eve
    concerts just before, and any repeat just after."""
    start = _dt.date(year - 1, 12, 31) - _dt.timedelta(days=RELATED_WINDOW_BEFORE - 1)
    end = _dt.date(year, 1, 1) + _dt.timedelta(days=RELATED_WINDOW_AFTER)
    if year == FOUNDING_YEAR:
        start, end = _dt.date(1939, 12, 29), _dt.date(1940, 1, 14)
    out = []
    for p in perfs:
        d = _dt.date.fromisoformat(p["date"])
        if start <= d <= end and p["uri"] != main_uri:
            out.append({"date": p["date"], "title": p["title"], "source": p["source"], "uri": p["uri"]})
    return out


# ---------------------------------------------------------------------------
# Programme reconciliation.
# ---------------------------------------------------------------------------

def merge_programmes(year: int, p_items: list, m_items: list, warnings: list) -> list:
    """Pair the two archives' items and return ONE programme.

    Order follows the orchestra's archive; a Musikverein-only item is inserted
    right after the last item it followed in the Musikverein's own order, so an
    encore lands at the end and a mid-programme addition lands where it was played.
    Every item carries `source`; a pair whose readings genuinely differ carries the
    other archive's reading as `alt` and raises a warning.
    """
    if not p_items and not m_items:
        return []
    if not p_items or not m_items:
        src = "philharmoniker" if p_items else "musikverein"
        return [_emit(i, src, None) for i in (p_items or m_items)]

    pairs = {}      # index in p_items -> index in m_items
    how = {}        # index in p_items -> "opus" | "title" | "slot"
    used_m = set()

    # 1. opus + composer, 2. distinctive title.
    for name, keyfn in (("opus", item_key), ("title", lambda i: ("title", distinctive(i["title"])))):
        m_index = {}
        for j, mi in enumerate(m_items):
            if j not in used_m:
                m_index.setdefault(keyfn(mi), j)
        for i, pi in enumerate(p_items):
            if i in pairs:
                continue
            j = m_index.get(keyfn(pi))
            if j is not None and j not in used_m:
                pairs[i] = j
                how[i] = name
                used_m.add(j)
    # 3. Sandwiched: both still unmatched and their NEIGHBOURS are paired with each
    #    other, so this is the same slot in the concert described differently — or
    #    a genuine contradiction. Neighbours rather than the raw item number,
    #    because one archive's extra mid-programme item shifts every later number
    #    by one and equal numbers would then pair the wrong works.
    changed = True
    while changed:
        changed = False
        for i, pi in enumerate(p_items):
            if i in pairs:
                continue
            for j, mi in enumerate(m_items):
                if j in used_m:
                    continue
                before = (i == 0 and j == 0) or pairs.get(i - 1) == j - 1
                after = (i == len(p_items) - 1 and j == len(m_items) - 1) or pairs.get(i + 1) == j + 1
                if before and after:
                    pairs[i] = j
                    how[i] = "slot"
                    used_m.add(j)
                    changed = True
                    break

    merged = []
    for i, pi in enumerate(p_items):
        j = pairs.get(i)
        mi = m_items[j] if j is not None else None
        merged.append(_emit(pi, "both" if mi else "philharmoniker", mi))
        if mi:
            _check_pair(year, pi, mi, merged[-1], how[i], warnings)
    # Musikverein-only items, each placed right after the item that preceded it in
    # the Musikverein's own order — the paired item before it, or the previous
    # Musikverein-only item when several run together (the encores do).
    for i, e in enumerate(merged):
        e["_k"] = i                       # identity, so inserts can be located
    m_to_entry = {j: merged[i] for i, j in pairs.items()}
    last_entry = None
    for j, mi in enumerate(m_items):
        if j in used_m:
            last_entry = m_to_entry[j]
            continue
        entry = _emit(mi, "musikverein", None)
        entry["_k"] = f"m{j}"
        at = (merged.index(last_entry) + 1) if last_entry is not None else 0
        merged.insert(at, entry)
        last_entry = entry
    for n, e in enumerate(merged, 1):
        e["n"] = n
        e.pop("_k", None)
    return merged


def _emit(item: dict, source: str, other) -> dict:
    return {
        "n": item["n"],
        "title": item["title"],
        "composers": [composer_entry(cid, part) for cid, part in
                      zip(item["composerIds"], _credit_parts(item["credit"]))],
        "opus": item["opus"],
        "source": source,
    }


def _credit_parts(credit: str) -> list:
    parts = [p.strip() for p in re.split(r"\s*(?:,|/|&|\bund\b|\band\b)\s*", credit) if p.strip()]
    return parts or [credit]


def _identifying_words(title: str) -> set:
    head = re.split(r";|\bbearbeitet\b|\binstrumentiert\b|\barrangiert\b|\barr\.", title)[0]
    return {w for w in norm(head).split() if w not in GENERIC_WORDS and not w.isdigit()}


def _same_work_words(a: str, b: str) -> bool:
    """Two titles name the same work when they share an identifying word, or one
    side's word is contained in the other's ("Kuss-Walzer" / "Kußwalzer")."""
    wa, wb = _identifying_words(a), _identifying_words(b)
    if wa & wb:
        return True
    na, nb = norm(a), norm(b)
    return any(len(w) >= 4 and w in nb for w in wa) or any(len(w) >= 4 and w in na for w in wb)


def _check_pair(year, pi, mi, entry, how, warnings):
    """A paired item whose readings disagree beyond spelling: a different composer
    (order of a joint credit does not count), a different opus number, or — for a
    pair made only by its slot — titles with no identifying word in common. A pair
    made by opus and composer IS the same work whatever the spelling ("Jokey" /
    "Jockey", "Les Patineurs" / "Die Schlittschuhläufer")."""
    problems = []
    if set(pi["composerIds"]) != set(mi["composerIds"]):
        problems.append(f"composer {pi['credit']!r} vs {mi['credit']!r}")
    if pi["opus"] is not None and mi["opus"] is not None and pi["opus"] != mi["opus"]:
        problems.append(f"opus {pi['opus']} vs {mi['opus']}")
    if how == "slot" and not _same_work_words(pi["title"], mi["title"]):
        problems.append(f"work {pi['title']!r} vs {mi['title']!r}")
    if problems:
        entry["alt"] = {"source": "musikverein", "title": mi["title"], "credit": mi["credit"],
                        "opus": mi["opus"]}
        warnings.append({"kind": "programme-contradiction", "year": year,
                         "detail": f"item {pi['n']}: " + "; ".join(problems)
                                   + " — philharmoniker reading shown, musikverein kept as alt"})


# ---------------------------------------------------------------------------
# The library graph: which New Year's Concert records the project holds.
# ---------------------------------------------------------------------------

_NYC_SLUG_RE = re.compile(r"^(\d{4})(?:-(\d{4}))?(?:\s*\((.*)\))?$")
# Parentheticals on a year-slugged record that name ANOTHER performer. The two the
# library has today; a new one is reported so it can be triaged.
NON_VPO_PARENTHETICALS = {"kendlinger"}


def load_library(dumps: list, warnings: list) -> dict:
    """{record name: {...}} for the VPO New Year's Concert records across all dumps."""
    import rdflib
    from rdflib import RDF, URIRef

    records = {}
    for dump in dumps:
        if not os.path.exists(dump):
            warnings.append({"kind": "dump-missing", "year": None, "detail": f"{dump} not found — skipped"})
            continue
        g = rdflib.Graph()
        # rdflib warns loudly about the graph's literal "__NONE__" gYears; they are
        # upstream's, harmless here, and not ours to fix in a build log.
        import logging
        logging.getLogger("rdflib").setLevel(logging.CRITICAL)
        g.parse(dump, format="nt")
        tag = os.path.basename(dump).split(".")[0]
        n_seen = 0
        for r in g.subjects(RDF.type, URIRef(MO + "Record")):
            slug = str(r).rsplit("/", 1)[-1]
            name = deslug(slug)
            m = _NYC_SLUG_RE.match(name)
            if not m:
                continue
            paren = (m.group(3) or "").strip()
            if paren and any(k in norm(paren) for k in NON_VPO_PARENTHETICALS):
                continue
            if paren and not re.search(r"unbekannt|bonbons|neujahr", norm(paren)):
                warnings.append({"kind": "library-parenthetical", "year": int(m.group(1)),
                                 "detail": f"record {name!r} has an unfamiliar parenthetical — "
                                           "check it is a Wiener Philharmoniker release"})
            n_seen += 1
            rel = g.value(None, URIRef(MO + "record"), r)
            title = str(g.value(rel, URIRef(DCT + "title")) or "") if rel else ""
            title = title.strip().strip('"').strip()
            pub = g.value(rel, URIRef(DCT + "publisher")) if rel else None
            if isinstance(pub, URIRef):
                pub = g.value(pub, URIRef(FOAF_NAME)) or g.value(pub, URIRef(RDFS_LABEL))
            issued = str(g.value(rel, URIRef(DCT + "issued")) or "") if rel else ""
            mb = g.value(r, URIRef(MO + "musicbrainz")) or (g.value(rel, URIRef(MO + "musicbrainz")) if rel else None)
            tracks = []
            for t in g.objects(r, URIRef(MO + "track")):
                lab = str(g.value(t, URIRef(RDFS_LABEL)) or "")
                lab = re.sub(r'^Track:\s*"?', "", lab).rstrip('"').strip()
                num = g.value(t, URIRef(MO + "track_number"))
                tracks.append({"n": int(num) if num is not None else None, "title": lab})
            tracks.sort(key=lambda x: (x["n"] is None, x["n"]))
            pieces = sorted({pid for pid in PIECES for t in tracks if piece_matches(pid, t["title"])})
            e = records.setdefault(name, {
                "record": name, "slug": slug,
                "year": int(m.group(1)), "covers": [int(m.group(1)), int(m.group(2))] if m.group(2) else None,
                "releaseTitle": title, "publisher": str(pub) if pub else None,
                "issued": issued[:10] or None, "trackCount": len(tracks),
                "musicbrainz": str(mb) if mb else None, "pieces": pieces, "dumps": [],
            })
            e["dumps"].append(tag)
        log(f"  library {tag}: {n_seen} New Year's Concert record(s)")
    for e in records.values():
        if len(e["dumps"]) < len([d for d in dumps if os.path.exists(d)]):
            warnings.append({"kind": "library-dump-divergence", "year": e["year"],
                             "detail": f"record {e['record']!r} is in {'/'.join(e['dumps'])} only"})
    return records


# ---------------------------------------------------------------------------
# The exhibit's own payload(s): what can actually be played, per concert.
# ---------------------------------------------------------------------------

def load_playable(data_dir: str, warnings: list) -> tuple:
    """(playable by year, portraits by year). Reads every `<piece>.json` payload
    beside `metadata.json`; a recording is playable FROM a concert when its
    metadata says Wiener Philharmoniker and its library slug is that single year."""
    meta_path = os.path.join(data_dir, "metadata.json")
    if not os.path.exists(meta_path):
        warnings.append({"kind": "no-metadata", "year": None,
                         "detail": "metadata.json missing — nothing marked playable; run prep_exhibit_metadata.py"})
        return {}, {}
    with open(meta_path, encoding="utf-8") as fh:
        meta = json.load(fh).get("recordings", {})
    playable = collections.defaultdict(list)
    portraits = {}
    for fn in sorted(os.listdir(data_dir)):
        if not fn.endswith(".json") or fn in ("metadata.json", "concerts.json") or fn.endswith("overrides.json"):
            continue
        with open(os.path.join(data_dir, fn), encoding="utf-8") as fh:
            payload = json.load(fh)
        if payload.get("schema") != "lh-exhibit-payload/1":
            continue
        piece = payload.get("piece", {}).get("id") or fn[:-5]
        for file in payload.get("recordings", {}):
            m = meta.get(file, {})
            if not re.search(r"wiener philharmoniker", norm(m.get("ensemble") or "")):
                continue
            slug = m.get("slug") or ""
            if re.match(r"^\d{4}$", slug):
                y = int(slug)
                playable[y].append({"file": file, "piece": piece})
                if m.get("portrait") and y not in portraits:
                    portraits[y] = m["portrait"]
            else:
                warnings.append({"kind": "payload-not-a-concert", "year": m.get("year"),
                                 "detail": f"{file} is a Wiener Philharmoniker recording but not a New "
                                           f"Year's Concert (slug {slug!r}) — not playable from any year"})
    return dict(playable), portraits


# ---------------------------------------------------------------------------
# Assembly.
# ---------------------------------------------------------------------------

def build(philharmoniker: dict, musikverein: dict, library: dict, playable: dict, portraits: dict,
          through: int, warnings: list) -> list:
    P = list(philharmoniker.values())
    M = list(musikverein.values())
    years_p = {int(p["date"][:4]) for p in P if p["date"][5:] == "01-01"}
    years_m = {int(p["date"][:4]) for p in M if p["date"][5:] == "01-01"}
    if any(p["date"] == FOUNDING_DATE for p in P + M):
        years_p.add(FOUNDING_YEAR)
    last_archive_year = max(years_p | years_m)
    concerts = []
    for year in range(FOUNDING_YEAR, through + 1):
        p = main_concert_for(year, P, "philharmoniker", warnings)
        m = main_concert_for(year, M, "musikverein", warnings)
        entry = {"year": year, "date": None, "founding": year == FOUNDING_YEAR or None,
                 "title": None, "conductor": None, "conductorRole": None,
                 "orchestra": "Wiener Philharmoniker", "alsoPerforming": [],
                 "programme": [], "sources": {}, "related": [],
                 "library": [], "playable": playable.get(year, []),
                 "portrait": portraits.get(year), "note": None}
        if not p and not m:
            entry["founding"] = None
            if year == 1940:
                entry["note"] = "no-concert"       # the series skipped 1940
            elif year > last_archive_year:
                entry["note"] = "after-archives"   # scraped March 2022
            else:
                entry["note"] = "missing"
                warnings.append({"kind": "year-missing", "year": year,
                                 "detail": "neither archive has a concert for this year"})
        else:
            main = p or m
            entry["date"] = main["date"]
            entry["title"] = main["title"]
            # Conductor: the archives agree everywhere they overlap (measured); a
            # disagreement would be a data event worth a loud warning, not a choice.
            cp = p["conductors"] if p else []
            cm = m["conductors"] if m else []
            if cp and cm and norm(cp[0]) != norm(cm[0]):
                warnings.append({"kind": "conductor-contradiction", "year": year,
                                 "detail": f"philharmoniker {cp!r} vs musikverein {cm!r} — philharmoniker shown"})
            entry["conductor"] = (cp or cm or [None])[0]
            entry["conductorRole"] = {k: v for k, v in
                                      (("philharmoniker", p and p["conductorRole"]),
                                       ("musikverein", m and m["conductorRole"])) if v}
            if not entry["conductor"]:
                warnings.append({"kind": "no-conductor", "year": year, "detail": "no Dirigent in either archive"})
            # Other performers (choirs, soloists), deduplicated across archives.
            seen = set()
            for perf in (p, m):
                if not perf:
                    continue
                for role, names in perf["roles"].items():
                    if role.lower().startswith("dirigent") or role == "Orchester":
                        continue
                    for nm in names:
                        k = (norm(role), norm(nm))
                        if k not in seen and nm:
                            seen.add(k)
                            entry["alsoPerforming"].append({"role": role or "—", "name": nm})
            entry["programme"] = merge_programmes(year, p["items"] if p else [], m["items"] if m else [], warnings)
            if not entry["programme"]:
                warnings.append({"kind": "no-programme", "year": year,
                                 "detail": f"conductor known ({entry['conductor']}) but no programme in either archive"})
            if p and not m:
                warnings.append({"kind": "single-source", "year": year, "detail": "philharmoniker archive only"})
            if m and not p:
                warnings.append({"kind": "single-source", "year": year, "detail": "musikverein archive only"})
            for perf in (p, m):
                if perf:
                    entry["sources"][perf["source"]] = perf["uri"]
            entry["related"] = related_for(year, P + M, None)
            entry["related"] = [r for r in entry["related"] if r["uri"] not in entry["sources"].values()]
            for r in entry["related"]:
                r.pop("uri", None)
            if (m and m["comment"]) and not (p and p["comment"]):
                entry["archiveComment"] = m["comment"]
        for pid in PIECES:
            if any(piece_matches(pid, it["title"]) for it in entry["programme"]):
                entry.setdefault("onProgramme", []).append(pid)
        concerts.append(entry)

    # Library records attach by year, ranges to every year they cover.
    by_year = {c["year"]: c for c in concerts}
    for rec in library.values():
        years = range(rec["covers"][0], rec["covers"][1] + 1) if rec["covers"] else [rec["year"]]
        for y in years:
            c = by_year.get(y)
            if not c:
                warnings.append({"kind": "library-year-outside-series", "year": y,
                                 "detail": f"record {rec['record']!r} names a year the series does not have"})
                continue
            c["library"].append({k: rec[k] for k in
                                 ("record", "releaseTitle", "publisher", "issued", "trackCount",
                                  "musicbrainz", "pieces", "dumps", "covers")})
            if c["note"] in ("no-concert", "missing"):
                warnings.append({"kind": "library-record-for-gap-year", "year": y,
                                 "detail": f"record {rec['record']!r} but no concert in the archives"})
    for y, files in playable.items():
        if y not in by_year:
            warnings.append({"kind": "playable-year-outside-series", "year": y,
                             "detail": f"{[f['file'] for f in files]} claims year {y}"})
    return concerts


def apply_overrides(concerts: list, overrides: dict, include_unverified: bool, warnings: list):
    """Patch concerts from the authored file. Only `verified: true` entries land by
    default; the rest are named so nobody forgets they are waiting."""
    by_year = {c["year"]: c for c in concerts}
    for ys, patch in (overrides.get("years") or {}).items():
        if ys.startswith("_"):
            continue
        year = int(ys)
        disp = patch.get("_disposition", "editorial")
        if not patch.get("verified") and not include_unverified:
            warnings.append({"kind": "override-unverified", "year": year,
                             "detail": f"override ({disp}) not applied — set \"verified\": true after checking "
                                       f"{patch.get('source', 'its source')}"})
            continue
        c = by_year.get(year)
        if not c:
            warnings.append({"kind": "override-outside-series", "year": year,
                             "detail": "override names a year outside the generated range"})
            continue
        c.setdefault("provenance", {})
        for k, v in patch.items():
            if k.startswith("_") or k in ("verified", "source"):
                continue
            c[k] = v
            c["provenance"][k] = f"override:{disp}"
        if c.get("note") in ("after-archives", "missing") and c.get("conductor"):
            c["note"] = None
        c["provenance"]["source"] = patch.get("source")


def seed_overrides(path: str):
    if os.path.exists(path):
        return
    seed = {
        "_README": [
            "Authored rulings for the New Year's Concert sidecar. AUTHORITY: applied LAST by",
            "tools/prep_exhibit_concerts.py, never rewritten by it. COMMITTED, unlike the",
            "generated concerts.json.",
            "",
            "Two uses: (1) rule on a programme-contradiction the tool reported (the two",
            "archives disagree; see the report), (2) supply a concert the archives predate",
            "(2024 onwards). Every entry needs `_disposition` ('editorial' — a ruling; or",
            "'until-upstream-fixed' — an archive error), a `source` naming where the fact",
            "was checked, and `\"verified\": true` once a person has checked it. UNVERIFIED",
            "ENTRIES ARE NOT APPLIED: the tool names them on every run instead.",
            "",
            "Fields patch the year's entry as generated: `conductor`, `date`, `title`,",
            "`programme` (the whole list), `note`.",
        ],
        "years": {},
    }
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(seed, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    log(f"  seeded {path}")


# ---------------------------------------------------------------------------
# Reporting.
# ---------------------------------------------------------------------------

def table(concerts: list):
    print(f"\n{'year':>4} {'date':<10} {'conductor':<24} {'items':>5} {'src':<6} {'lib':>3} {'play':>4} note")
    print("-" * 78)
    for c in concerts:
        src = "".join(s[0].upper() for s in ("philharmoniker", "musikverein") if s in c["sources"])
        print(f"{c['year']:>4} {c['date'] or '—':<10} {(c['conductor'] or '—')[:24]:<24} "
              f"{len(c['programme']):>5} {src:<6} {len(c['library']):>3} {len(c['playable']):>4} "
              f"{c.get('note') or ''}{' founding' if c.get('founding') else ''}"
              f"{' ' + ','.join(c['onProgramme']) if c.get('onProgramme') else ''}")


def write_report(path: str, concerts: list, warnings: list, sources: dict):
    by_kind = collections.defaultdict(list)
    for w in warnings:
        by_kind[w["kind"]].append(w)
    lines = ["# New Year's Concert sidecar — reconciliation report", "",
             f"Generated {sources['generated']} by `tools/prep_exhibit_concerts.py`.", "",
             "Sources:", ""]
    for k in ("philharmoniker", "musikverein"):
        lines.append(f"- {k}: `{sources[k]}`")
    for d in sources["library"]:
        lines.append(f"- library dump: `{d}`")
    have = [c for c in concerts if c["date"]]
    lines += ["", "## Coverage", "",
              f"- {len(have)} concerts with a date, {have[0]['year']}–{have[-1]['year']}; "
              f"{sum(1 for c in concerts if c['programme'])} with a programme; "
              f"{sum(1 for c in concerts if c['library'])} with a library record; "
              f"{sum(1 for c in concerts if c['playable'])} with a recording the exhibit can play.",
              f"- Years without a concert entry: {[c['year'] for c in concerts if not c['date']]}",
              f"- Single-archive years: " + ", ".join(f"{w['year']} ({w['detail'].split()[0]})"
                                                    for w in by_kind.get("single-source", [])),
              ""]
    lines += ["## Programme contradictions — need a ruling", "",
              "The orchestra's archive is shown; the Musikverein's reading is kept beside it as `alt`. "
              "Rule on each in `concerts-overrides.json` (or accept the default by deleting nothing — "
              "the list is the record).", "",
              "| year | item | disagreement |", "|---|---|---|"]
    for w in by_kind.get("programme-contradiction", []):
        item, _, rest = w["detail"].partition(": ")
        lines.append(f"| {w['year']} | {item} | {rest.replace('|', '/')} |")
    lines += ["", "## Everything else the tool flagged", ""]
    for kind, ws in sorted(by_kind.items()):
        if kind == "programme-contradiction":
            continue
        lines.append(f"### {kind} ({len(ws)})")
        lines.append("")
        for w in ws:
            lines.append(f"- {w['year'] if w['year'] is not None else '—'}: {w['detail']}")
        lines.append("")
    lines += ["## Encore asymmetry (tail items vouched for by one archive only)", "",
              "| year | philharmoniker only | musikverein only |", "|---|---|---|"]
    for c in concerts:
        prog = c["programme"]
        tail = [i for i in prog if i["source"] != "both" and i["n"] > len(prog) - 3]
        if tail:
            po = "; ".join(i["title"] for i in tail if i["source"] == "philharmoniker")
            mo = "; ".join(i["title"] for i in tail if i["source"] == "musikverein")
            lines.append(f"| {c['year']} | {po} | {mo} |")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")
    log(f"wrote {path}")


# ---------------------------------------------------------------------------
# Self-test of the pure helpers.
# ---------------------------------------------------------------------------

def self_test():
    assert opus_of("Hopser- Polka. 0p. 28") == 28
    assert opus_of("Accelerationen. Walzer, op.234") == 234
    assert opus_of("Einzugsmarsch aus der Operette „Der Zigeunerbaron“, ohne op.") is None
    assert opus_of("Liebesbotschaft. Galopp o. op.") is None
    assert opus_of("Zwölf Contretänze, WoO 14") is None
    assert opus_of("Ouvertüre in C-Dur, op post. 170, D 591") == 170
    assert composer_ids("Johann Strauß II.") == ["johann-strauss-ii"]
    assert composer_ids("Johann Strauß Sohn") == ["johann-strauss-ii"]
    assert composer_ids("Johann Strauß Vater") == composer_ids("Johann Strauß I.") == ["johann-strauss-i"]
    assert composer_ids("Johann Strauß II., Josef Strauß") == ["johann-strauss-ii", "josef-strauss"]
    assert composer_ids("Johann Strauß Sohn / Josef Strauß / Eduard Strauß") == \
        ["johann-strauss-ii", "josef-strauss", "eduard-strauss"]
    assert composer_ids("Josef Hellmesberger d.J.") == composer_ids("Josef d. J. Hellmesberger") == \
        composer_ids("Josef Hellmesberger (Sohn)") == ["josef-hellmesberger-ii"]
    assert composer_ids("Émile Waldteufel") == composer_ids("Emil Waldteufel")
    assert composer_ids("Carl Michael Ziehrer") == ["carl-michael-ziehrer"]
    assert distinctive('Ouvertüre zur Operette "Die Fledermaus"') == distinctive("Ouv. Die Fledermaus") == "fledermaus"
    assert distinctive("Ouv. Prinz Methusalem") == distinctive("Ouvertüre zur Operette „Prinz Methusalem”")
    assert distinctive("Auf Ferienreisen. Polka schnell, op. 133; bearbeitet von Gerald Wirth") == \
        distinctive("Auf Ferienreisen. Polka schnell, op. 133")
    assert piece_matches("fledermaus", 'Ouvertüre zur Operette "Die Fledermaus"')
    assert piece_matches("fledermaus", "Ouverture: Die Fledermaus")
    assert not piece_matches("fledermaus", 'Die Fledermaus, "Klänge der Heimat", Csárdás')
    assert not piece_matches("fledermaus", "Csárdás aus der Operette „Die Fledermaus”")
    assert piece_matches("kaiserwalzer", "Kaiser-Walzer, op. 437")
    assert deslug("Johann-Strau_-C3_-9F-Orchester") == "Johann-Strauß-Orchester"
    # Pairing: spelling variants pair, encores append, a same-slot contradiction pairs with alt.
    def it(n, credit, title):
        return {"n": n, "title": title, "credit": credit, "composerIds": composer_ids(credit), "opus": opus_of(title)}
    w = []
    P = [it(1, "Johann Strauß II.", "Ouv. Prinz Methusalem"),
         it(2, "Johann Strauß II.", "Vergnügungszug. Polka (schnell), op. 281"),
         it(3, "Josef Strauß", "Eislauf. Polka schnell, op. 261")]
    M = [it(1, "Johann Strauß Sohn", "Ouvertüre zur Operette „Prinz Methusalem”"),
         it(2, "Josef Strauß", "Heiterer Muth. Polka française, op. 281"),
         it(3, "Josef Strauß", "Eislauf-Polka, op. 261"),
         it(4, "Johann Strauß Sohn", "An der schönen blauen Donau. Walzer, op. 314"),
         it(5, "Johann Strauß Vater", "Radetzky Marsch, op. 228")]
    merged = merge_programmes(1970, P, M, w)
    assert [m["source"] for m in merged] == ["both", "both", "both", "musikverein", "musikverein"], merged
    assert merged[1]["alt"]["title"].startswith("Heiterer"), merged[1]
    assert len(w) == 1 and w[0]["kind"] == "programme-contradiction", w
    assert [m["n"] for m in merged] == [1, 2, 3, 4, 5]
    # A Musikverein-only item in the MIDDLE lands after its predecessor, not at the end.
    w = []
    merged = merge_programmes(2014, [P[0], P[2]], [M[0], M[3], M[2]], w)
    assert [m["source"] for m in merged] == ["both", "musikverein", "both"], merged
    print("self-test ok")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--philharmoniker", default=DEFAULT_PHILHARMONIKER)
    ap.add_argument("--musikverein", default=DEFAULT_MUSIKVEREIN)
    ap.add_argument("--dump", action="append", dest="dumps",
                    help="a library graph dump (.nt); repeatable; default: both known dumps")
    ap.add_argument("--data-dir", default=os.path.join(REPO, "app/static/exhibit/data"))
    ap.add_argument("--through", type=int, default=_dt.date.today().year,
                    help="last year of the grid (default: this year); later years show as gaps")
    ap.add_argument("--report", help="also write a markdown reconciliation report here")
    ap.add_argument("--include-unverified", action="store_true",
                    help="apply override entries that lack \"verified\": true (never for the kiosk)")
    ap.add_argument("--dry-run", action="store_true", help="report without writing the sidecar")
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args()

    if args.self_test:
        self_test()
        return
    for p in (args.philharmoniker, args.musikverein):
        if not os.path.exists(p):
            sys.exit(f"archive not found: {p}\n(expected the new-years-scrapers repo beside this one)")
    dumps = args.dumps or DEFAULT_DUMPS

    warnings = []
    log("reading the programme archives:")
    P = load_archive(args.philharmoniker, "philharmoniker", warnings)
    M = load_archive(args.musikverein, "musikverein", warnings)
    log("reading the library graph:")
    library = load_library(dumps, warnings)
    log("reading the exhibit payload(s):")
    playable, portraits = load_playable(args.data_dir, warnings)
    log(f"  {sum(len(v) for v in playable.values())} playable recording(s) across {len(playable)} year(s)")

    concerts = build(P, M, library, playable, portraits, args.through, warnings)

    ov_path = os.path.join(args.data_dir, OVERRIDES_FILE)
    if not args.dry_run:
        os.makedirs(args.data_dir, exist_ok=True)
        seed_overrides(ov_path)
    overrides = {}
    if os.path.exists(ov_path):
        with open(ov_path, encoding="utf-8") as fh:
            overrides = json.load(fh)
    apply_overrides(concerts, overrides, args.include_unverified, warnings)

    table(concerts)
    if warnings:
        counts = collections.Counter(w["kind"] for w in warnings)
        print(f"\n{len(warnings)} warning(s): " + ", ".join(f"{k} {n}" for k, n in sorted(counts.items())))
        for w in warnings:
            if w["kind"] in ("programme-contradiction", "conductor-contradiction", "year-missing",
                             "override-unverified", "duplicate-entry", "library-parenthetical"):
                print(f"  - {w['kind']} {w['year'] or ''}: {w['detail']}")

    sources = {"philharmoniker": args.philharmoniker, "musikverein": args.musikverein,
               "library": dumps, "generated": _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds"),
               "scraped": "2022-03-22"}
    if args.report:
        write_report(args.report, concerts, warnings, sources)
    if args.dry_run:
        log("\n--dry-run: nothing written")
        return
    have = [c for c in concerts if c["date"]]
    out = {"schema": SCHEMA, "source": sources,
           "series": {"first": have[0]["year"], "lastInArchives": have[-1]["year"], "through": args.through,
                      "orchestra": "Wiener Philharmoniker"},
           "concerts": concerts, "warnings": warnings}
    path = os.path.join(args.data_dir, "concerts.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=1)
        fh.write("\n")
    log(f"\nwrote {path} ({os.path.getsize(path) // 1024} kB)")


if __name__ == "__main__":
    main()
