#!/usr/bin/env python3
"""Derive the exhibit's metadata sidecar (conductor, year, ensemble) from the SSV RDF.

Writes a FLAT sidecar — `app/static/exhibit/data/metadata.json`. No LD traversal
happens in the browser: the museum machine is a frozen PC with no network, so the
graph is queried once here and the answers are written out as plain fields. That
is a robustness choice, not a rejection of the linked data (plan §5.4).

Source: the `data` repository's **TISMIR branch**, `data/graph_dump/*.ttl`. Music
Ontology plus c4dm event/timeline. Read-only — nothing here writes to that repo.

## Why this is not a one-liner: the graph does not have a conductor property

There is no `conductor` predicate. Every track has exactly one `mo:MusicArtist`
reached by `mo:performed`, and that field is used INCONSISTENTLY:

  * on most tracks it is the **composer** ("Johann Strauss II");
  * on some it is the **ensemble and conductor together**, as one string
    ("Wiener Philharmoniker, Georges Prêtre");
  * once it is a bare **conductor** ("Kurt Schmid").

So three sources are tried in order, and WHICH ONE WAS USED IS RECORDED per field
in `provenance`. A metadata sidecar whose numbers cannot be traced is worse than
no sidecar: this is going on a museum wall next to a real, named person.

  1. `musicbrainz:byArtist` — the BEST source, and the one that scales. Every
     record carries a MusicBrainz release id, and asking musicbrainz.org for
     `application/ld+json` returns schema.org in which `byArtist` is STRUCTURED:
     the ensemble is typed `MusicGroup` and the conductor `Person`. So the two are
     told apart by type rather than by splitting a string — which matters, because
     MusicBrainz's own `creditedTo` strings are irregular ("Wiener Philharmoniker ,
     Herbert von Karajan", "Lugansk Philarmonic Orchestra , Kurt Schmid": note the
     stray spaces and the misspelling).
  2. `rdf:ensemble-artist` — a MusicArtist name anywhere on the same record that
     looks like an ensemble (matches ENSEMBLE_RE). This is what finds Prêtre for
     2010, from sibling tracks rather than from the overture's own.
  3. `slug` — for the non-VPO recordings the record slug IS
     "Ensemble, Conductor (year)", so the last comma splits it.
  4. `override` — `metadata-overrides.json`, authored and committed, applied LAST.

Responses are cached under `tools/.cache/musicbrainz/`, so a re-run is offline and
the API is asked once per entity. Requests are rate-limited to one per second and
carry a descriptive User-Agent, as MusicBrainz asks.

## Year means CONCERT year, not release year

`dcterms:issued` and `timeline:atYear` are RELEASE dates and they are not the same
thing: `VPO-1987`'s release is **2005** while the concert was 1987. So the title is
preferred over the release date, and when the release date is all there is, the
provenance says `rdf:issued` so nobody mistakes it for a concert year.

Usage:
    tools/prep_exhibit_metadata.py                 # derive, enrich, write the sidecar
    tools/prep_exhibit_metadata.py --dry-run       # report only
    tools/prep_exhibit_metadata.py --no-musicbrainz  # RDF + overrides only, no network
    tools/prep_exhibit_metadata.py --refresh-mb    # ignore the cache and refetch
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from collections import Counter
from urllib.parse import unquote

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCHEMA = "lh-exhibit-metadata/1"
DEFAULT_DUMP = "/var/git/signature-sound-vienna/data/data/graph_dump/20250826.ttl"
BASE = "https://w3id.org/ssv/TISMIR/data/"
OVERRIDES_FILE = "metadata-overrides.json"
MB_CACHE = os.path.join(REPO, "tools/.cache/musicbrainz")
# MusicBrainz asks for a descriptive User-Agent naming the application and a way
# to reach whoever runs it. The project's public page serves as that contact; a
# personal address deliberately does not go out to a third-party service.
MB_UA = "ListenHere-ExhibitPrep/0.26.0 ( https://iwk.mdw.ac.at/signature-sound-vienna )"
MB_MIN_INTERVAL = 1.1  # seconds between requests — MusicBrainz allows ~1/s

# wav key -> the record slug in the graph. The VPO recordings are keyed by year
# alone; everything else by its full "Ensemble, Conductor (year)" string, with
# `%` written as `_-` (so `_-20` is a space, `_-2C` a comma, `_-28` a paren).
CURATED_SLUGS = {
    "VPO-2010.wav": "2010",
    "VPO-1987.wav": "1987",
    "VPO-1989.wav": "1989",
    "VPO-2022.wav": "2022",
    "Philharmonia Orchestra London, Georg Randolph Warren (1982).wav":
        "Philharmonia_-20Orchestra_-20London_-2C_-20Georg_-20Randolph_-20Warren_-20_-281982_-29",
    "K&K Philharmoniker, Kendlinger (2010).wav":
        "K_-26K_-20Philharmoniker_-2C_-20Kendlinger_-20_-282010_-29",
    "Philharmonie Lugansk, Kurt Schmid.wav":
        "Philharmonie_-20Lugansk_-2C_-20Kurt_-20Schmid",
    "Wiener Volksopernorchester, Franz Bauer-Theussl (1985).wav":
        "Wiener_-20Volksopernorchester_-2C_-20Franz_-20Bauer-Theussl_-20_-281985_-29",
}

# What an ensemble name looks like, so it can be told apart from a composer.
ENSEMBLE_RE = re.compile(
    r"philharmoni|orchester|orchestra|symphoni|symphony|kapelle|ensemble|volksopern",
    re.I)

# Names that are composers however they are spelled, so a "Strauss" record whose
# artist field holds the composer is never mistaken for an ensemble.
COMPOSER_RE = re.compile(
    r"^\s*(johann|josef|joseph|eduard)\s+strauss|mozart|rossini|nicolai|glinka|"
    r"beethoven|wagner|offenbach|lumbye|ziehrer|hellmesberger|anonymous", re.I)


def log(m):
    print(m, file=sys.stderr)


def deslug(s):
    return unquote(re.sub(r"_-", "%", s))


def split_ensemble_conductor(text):
    """"Ensemble, Conductor (year)" -> (ensemble, conductor, year|None)."""
    year = None
    m = re.search(r"\((\d{4})\)\s*$", text)
    if m:
        year = int(m.group(1))
        text = text[: m.start()].strip()
    if "," in text:
        ensemble, conductor = text.rsplit(",", 1)
        return ensemble.strip(), conductor.strip(), year
    return None, text.strip() or None, year


def year_from_title(title):
    """A concert year out of a record title, e.g. "Neujahrskonzert 2010" -> 2010."""
    if not title:
        return None
    years = [int(y) for y in re.findall(r"(1[89]\d\d|20\d\d)", title)]
    return years[0] if years else None


_mb_last_request = [0.0]


def mb_fetch(url, cache_dir=MB_CACHE, refresh=False, warnings=None):
    """GET `url` as application/ld+json, cached on disk and rate-limited.

    Returns the parsed document, or None. A network failure is a warning rather
    than a stop: the RDF-derived values are still perfectly usable without it.
    """
    mbid = url.rstrip("/").rsplit("/", 1)[-1]
    kind = url.rstrip("/").rsplit("/", 2)[-2]
    os.makedirs(cache_dir, exist_ok=True)
    path = os.path.join(cache_dir, f"{kind}-{mbid}.jsonld")
    if os.path.exists(path) and not refresh:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)

    wait = MB_MIN_INTERVAL - (time.monotonic() - _mb_last_request[0])
    if wait > 0:
        time.sleep(wait)
    req = urllib.request.Request(url, headers={
        "Accept": "application/ld+json", "User-Agent": MB_UA})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = resp.read()
    except (urllib.error.URLError, urllib.error.HTTPError, OSError) as exc:
        if warnings is not None:
            warnings.append({"kind": "musicbrainz-fetch-failed",
                             "detail": f"{url}: {exc}"})
        return None
    finally:
        _mb_last_request[0] = time.monotonic()
    try:
        doc = json.loads(body)
    except ValueError as exc:
        if warnings is not None:
            warnings.append({"kind": "musicbrainz-bad-json", "detail": f"{url}: {exc}"})
        return None
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=False)
    return doc


def _by_artist(doc):
    """Structured (ensemble, conductor) out of a schema.org byArtist list.

    Type is the discriminator: `MusicGroup` alone is an ensemble, anything typed
    `Person` is a human. MusicBrainz types conductors as BOTH Person and
    MusicGroup, so Person has to be tested first.
    """
    if not isinstance(doc, dict):
        return None, None
    cands = doc.get("byArtist") or (doc.get("releaseOf") or {}).get("byArtist") or []
    if isinstance(cands, dict):
        cands = [cands]
    ensemble = conductor = None
    for a in cands:
        if not isinstance(a, dict):
            continue
        types = a.get("@type") or []
        types = types if isinstance(types, list) else [types]
        name = (a.get("name") or "").strip()
        if not name:
            continue
        if "Person" in types and conductor is None:
            conductor = name
        elif "MusicGroup" in types and ensemble is None:
            ensemble = name
    return ensemble, conductor


def _release_dates(doc):
    """Every releaseDate on the document, earliest first. RELEASE dates, not concerts."""
    out = []
    for region in (doc.get("hasReleaseRegion") or []) if isinstance(doc, dict) else []:
        d = (region or {}).get("releaseDate")
        if d:
            out.append(str(d))
    return sorted(set(out))


def mb_enrich(recordings, refresh, warnings):
    """Fill conductor/ensemble from MusicBrainz, preferring it over the RDF guesses.

    Year is deliberately NOT taken from MusicBrainz: `releaseDate` is a RELEASE
    date and the two differ (VPO-1987's concert is 1987, its release 2005). The
    dates are recorded as `mbReleaseDates` for reference, and used for `year` only
    when nothing else produced one.
    """
    for wav, e in recordings.items():
        url = e.get("musicbrainz")
        if not url:
            warnings.append({"kind": "no-musicbrainz-id", "recording": wav,
                             "detail": "the graph carries no release MBID"})
            continue
        doc = mb_fetch(url, refresh=refresh, warnings=warnings)
        if not doc:
            continue
        ensemble, conductor = _by_artist(doc)
        dates = _release_dates(doc)
        if dates:
            e["mbReleaseDates"] = dates
        if doc.get("creditedTo"):
            e["mbCreditedTo"] = str(doc["creditedTo"]).strip()
        if conductor:
            if e["conductor"] and e["conductor"] != conductor:
                # Worth saying out loud: the two sources disagree, and MusicBrainz
                # wins because it is structured, but somebody should look.
                warnings.append({
                    "kind": "conductor-source-disagreement", "recording": wav,
                    "detail": f"RDF/slug said {e['conductor']!r}, MusicBrainz says "
                              f"{conductor!r}; using MusicBrainz"})
            e["conductor"] = conductor
            e["provenance"]["conductor"] = "musicbrainz:byArtist"
        if ensemble:
            # POLICY (user, 2026-08-24): MusicBrainz is the source of truth, and
            # MusicBrainz mistakes are corrected AT SOURCE rather than patched
            # around here. So MB wins by default even where the corpus disagrees —
            # otherwise a local workaround would silently outlive the upstream fix
            # and nobody would ever know the data had been repaired.
            #
            # A deliberate local difference therefore has to be an explicit entry
            # in metadata-overrides.json, each carrying a disposition:
            #   `until-upstream-fixed` — a real MB error; delete once MB is edited
            #   `editorial`            — a legitimate variant we prefer on the wall
            # which is the same two-disposition discipline ENGINE-WANTS.md uses.
            corpus_name = e["ensemble"]
            e["ensemble"] = ensemble
            e["provenance"]["ensemble"] = "musicbrainz:byArtist"
            if corpus_name and corpus_name != ensemble:
                e["corpusEnsemble"] = corpus_name
                warnings.append({
                    "kind": "ensemble-name-differs", "recording": wav,
                    "detail": f"MusicBrainz says {ensemble!r}, the corpus filename says "
                              f"{corpus_name!r}; using MusicBrainz per the "
                              f"correct-at-source policy — override it if MB is wrong"})
        if not e["year"] and dates:
            year = re.match(r"(\d{4})", dates[0])
            if year:
                e["year"] = int(year.group(1))
                e["provenance"]["year"] = "musicbrainz:releaseDate"
                warnings.append({
                    "kind": "year-is-release-date", "recording": wav,
                    "detail": f"no concert year available; using MusicBrainz's "
                              f"RELEASE date {dates[0]} — verify before display"})
    return recordings


def derive(dump, warnings):
    try:
        from rdflib import Graph, Namespace, RDFS, URIRef
        from rdflib.namespace import DCTERMS, FOAF, RDF
    except ImportError:
        warnings.append({"kind": "no-rdflib",
                         "detail": "rdflib is not installed; cannot read the graph"})
        return {}
    MO = Namespace("http://purl.org/ontology/mo/")
    TL = Namespace("http://purl.org/NET/c4dm/timeline.owl#")
    EV = Namespace("https://purl.org/NET/c4dm/event.owl#")

    g = Graph()
    g.parse(dump, format="turtle")
    log(f"  parsed {len(g)} triples from {dump}")

    # One pass over every performance, bucketed by record slug, so each record's
    # artist names are known without re-scanning the graph per recording.
    artists_by_slug = {}
    for perf in g.subjects(RDF.type, MO.Performance):
        m = re.match(r".*/performance/([^#]+)#\d+$", str(perf))
        if not m:
            continue
        for artist in g.subjects(MO.performed, perf):
            name = str(g.value(artist, FOAF.name) or "").strip().strip('"')
            if name:
                artists_by_slug.setdefault(m.group(1), Counter())[name] += 1

    out = {}
    for wav, slug in CURATED_SLUGS.items():
        rec_label = g.value(URIRef(BASE + "record/" + slug), RDFS.label)
        rec_title = re.sub(r'^Record:\s*', "", str(rec_label or "")).strip().strip('"') or None
        release = URIRef(BASE + "release/" + slug)
        issued = g.value(release, DCTERMS.issued)
        mbid = g.value(release, MO.musicbrainz)
        publisher = g.value(release, DCTERMS.publisher)
        label_name = g.value(publisher, FOAF.name) if publisher else None
        ev_time = g.value(URIRef(BASE + "release_event/" + slug), EV.time)
        at_year = g.value(ev_time, TL.atYear) if ev_time is not None else None

        prov = {}
        ensemble = conductor = None

        # (1) an ensemble-looking artist anywhere on this record
        for name, _ in (artists_by_slug.get(slug) or Counter()).most_common():
            if COMPOSER_RE.search(name) or not ENSEMBLE_RE.search(name):
                continue
            ensemble, conductor, _ = split_ensemble_conductor(name)
            prov["conductor"] = prov["ensemble"] = "rdf:ensemble-artist"
            break

        # (2) the slug, which for the non-VPO records carries both
        slug_ens, slug_cond, slug_year = split_ensemble_conductor(deslug(slug))
        if conductor is None and slug_cond and not re.fullmatch(r"\d{4}", slug_cond):
            ensemble, conductor = slug_ens, slug_cond
            prov["conductor"] = prov["ensemble"] = "slug"

        # (3) year: the title first, because issued/atYear are RELEASE dates
        year, year_src = None, None
        for cand, src in ((year_from_title(rec_title), "rdf:title"),
                          (slug_year, "slug"),
                          (int(str(issued)) if issued and str(issued).isdigit() else None, "rdf:issued"),
                          (int(str(at_year)) if at_year and str(at_year).isdigit() else None, "rdf:atYear")):
            if cand:
                year, year_src = cand, src
                break
        if year:
            prov["year"] = year_src

        entry = {
            "conductor": conductor,
            "ensemble": ensemble,
            "year": year,
            "recordTitle": rec_title,
            "releaseLabel": str(label_name).strip('"') if label_name else None,
            "musicbrainz": str(mbid) if mbid else None,
            "releaseYear": int(str(issued)) if issued and str(issued).isdigit() else None,
            "portrait": None,      # Gen-AI, generated separately; not derivable here
            "slug": slug,
            "provenance": prov,
        }
        # Say so loudly when the release year and the concert year disagree — that
        # is the compilation trap, and VPO-1987 really does hit it (2005 vs 1987).
        if entry["releaseYear"] and year and entry["releaseYear"] != year:
            entry["releaseYearDiffers"] = True
            warnings.append({
                "kind": "release-year-differs", "recording": wav,
                "detail": f"concert year {year} (from {year_src}) but release issued "
                          f"{entry['releaseYear']} — a compilation or reissue"})
        for field in ("conductor", "year"):
            if not entry[field]:
                warnings.append({"kind": f"no-{field}", "recording": wav,
                                 "detail": f"the graph yields no {field} for slug {deslug(slug)!r}"})
        out[wav] = entry
    return out


def apply_overrides(recordings, overrides, warnings):
    applied = 0
    pending = []
    stopgaps = []
    for wav, fields in (overrides or {}).items():
        if wav.startswith("_"):
            continue
        if wav not in recordings:
            warnings.append({"kind": "override-unknown-recording", "recording": wav,
                             "detail": "named in the overrides but not in the curated set"})
            continue
        for field, value in (fields or {}).items():
            if field.startswith("_"):
                continue
            if value is None:
                # A null is the seeded PLACEHOLDER for something still unanswered,
                # not a decision to blank the field. Claiming `override` provenance
                # for it would dress a gap up as an answer.
                pending.append(f"{wav}.{field}")
                continue
            recordings[wav][field] = value
            disp = (fields or {}).get("_disposition")
            recordings[wav].setdefault("provenance", {})[field] = (
                f"override:{disp}" if disp else "override")
            if disp == "until-upstream-fixed":
                stopgaps.append(f"{wav}.{field}")
            applied += 1
    log(f"  overrides applied: {applied}")
    if pending:
        log(f"  overrides still to fill in: {', '.join(pending)}")
    if stopgaps:
        # These exist only because an upstream source is wrong. Naming them every
        # run is what stops a stopgap turning into permanent divergence.
        log(f"  STOPGAPS awaiting an upstream fix: {', '.join(stopgaps)}")
        warnings.append({
            "kind": "awaiting-upstream-fix",
            "detail": f"{len(stopgaps)} override(s) exist only to paper over an "
                      f"upstream error and should be deleted once it is corrected: "
                      f"{', '.join(stopgaps)}"})
    return applied


def seed_overrides(path, recordings):
    """Write the override file, pre-listing exactly what the graph could not answer."""
    if os.path.exists(path):
        return False
    unresolved = {}
    for wav, e in recordings.items():
        missing = {f: None for f in ("conductor", "year") if not e[f]}
        if missing:
            unresolved[wav] = missing
    template = {
        "_README": [
            "Authored metadata overrides. AUTHORITY: this file wins over anything",
            "derived from the RDF, and tools/prep_exhibit_metadata.py applies it LAST",
            "and never rewrites it. COMMITTED, unlike the generated sidecar.",
            "Any field of a recording may be set: conductor, ensemble, year,",
            "recordTitle, portrait, ...",
            "The entries below are the ones the graph could not answer; fill in the",
            "nulls. Delete a key rather than leaving it null if the RDF value is fine.",
        ],
        **unresolved,
    }
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(template, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    log(f"  seeded {path} with {len(unresolved)} unresolved recording(s)")
    return True


def report(recordings):
    print(f"\n{'recording':<50} {'year':>5} {'src':<18} {'conductor':<26} {'src'}")
    print("-" * 118)
    for wav, e in recordings.items():
        p = e.get("provenance", {})
        print(f"{wav[:50]:<50} {str(e['year'] or '—'):>5} {p.get('year', '—'):<18} "
              f"{(e['conductor'] or '—')[:26]:<26} {p.get('conductor', '—')}")
        detail = f"    ensemble: {e['ensemble'] or '—'}"
        if e.get("releaseYearDiffers"):
            detail += f"   [release year {e['releaseYear']} != concert year]"
        print(detail)


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dump", default=DEFAULT_DUMP,
                    help="a turtle graph dump from the data repo's TISMIR branch")
    ap.add_argument("--data-dir", default=os.path.join(REPO, "app/static/exhibit/data"))
    ap.add_argument("--dry-run", action="store_true", help="report without writing the sidecar")
    ap.add_argument("--no-musicbrainz", dest="musicbrainz", action="store_false",
                    help="skip the MusicBrainz enrichment (no network)")
    ap.add_argument("--refresh-mb", action="store_true",
                    help="ignore the on-disk cache and refetch from MusicBrainz")
    args = ap.parse_args()

    if not os.path.exists(args.dump):
        sys.exit(f"graph dump not found: {args.dump}\n"
                 f"(expected the `data` repo on its TISMIR branch)")

    warnings = []
    log("deriving metadata:")
    recordings = derive(args.dump, warnings)
    if not recordings:
        sys.exit("nothing derived")

    if args.musicbrainz:
        log("enriching from MusicBrainz:")
        mb_enrich(recordings, args.refresh_mb, warnings)
        cached = len([f for f in os.listdir(MB_CACHE)]) if os.path.isdir(MB_CACHE) else 0
        log(f"  {cached} document(s) in {MB_CACHE}")

    os.makedirs(args.data_dir, exist_ok=True)
    ov_path = os.path.join(args.data_dir, OVERRIDES_FILE)
    if not args.dry_run:
        seed_overrides(ov_path, recordings)
    overrides = {}
    if os.path.exists(ov_path):
        with open(ov_path, encoding="utf-8") as fh:
            overrides = json.load(fh)
    apply_overrides(recordings, overrides, warnings)

    # Derivation warnings are raised BEFORE overrides are applied, so drop the ones
    # the override file has since answered. A warning list that keeps reporting
    # solved problems is a warning list nobody reads.
    def _settled(w):
        e = recordings.get(w.get("recording") or "", {})
        prov = e.get("provenance", {})
        # A gap the override file filled.
        if w["kind"].startswith("no-") and e.get(w["kind"][3:]):
            return True
        # A source disagreement the override file has since ruled on. The decision
        # is recorded in `provenance` and, for a stopgap, in the single
        # `awaiting-upstream-fix` warning — repeating the disagreement is noise.
        field = {"ensemble-name-differs": "ensemble",
                 "conductor-source-disagreement": "conductor"}.get(w["kind"])
        return bool(field and str(prov.get(field, "")).startswith("override"))

    resolved = [w for w in warnings if _settled(w)]
    for w in resolved:
        warnings.remove(w)
    if resolved:
        log(f"  {len(resolved)} warning(s) answered by the override file")

    report(recordings)

    if warnings:
        print(f"\n{len(warnings)} warning(s):")
        for w in warnings:
            print(f"  - {w['kind']}: {w.get('recording', '')} — {w['detail']}")

    if args.dry_run:
        log("\n--dry-run: nothing written")
        return
    payload = {"schema": SCHEMA,
               "source": {"graph": args.dump, "branch": "TISMIR",
                          "musicbrainz": bool(args.musicbrainz)},
               "recordings": recordings, "warnings": warnings}
    out = os.path.join(args.data_dir, "metadata.json")
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    log(f"\nwrote {out}")


if __name__ == "__main__":
    main()
