#!/usr/bin/env python3
"""Put the authored annotations back on the HQ grid, so they can be checked where they are shown.

WHY THIS EXISTS
---------------
The exhibit never shows an authored region time. `tools/prep_exhibit_data.py`
re-derives every one of them from a canonical index PAIR against the HQ
alignment's grids (plan §5.2c), because indices are portable across
re-alignments and times are not.

The three authoring sets, meanwhile, still carry the times they were authored
against — and those came from weaker, older alignments:

    Kids    Listen Here! v0.13.0, 2026-03-17   coarse 4, slack 80,  featureRate 10
    Adults  Listen Here! v0.23.0, 2026-07-28   coarse 2, slack 120, featureRate 10
    Expert  Listen Here! v0.23.0, 2026-08-15   coarse 2, slack 120, featureRate 10
    HQ      Listen Here! v0.63.0, 2026-09-18   coarse 2, slack 160, featureRate 20 (open-ended)

So opening `Alignment_Fledermaus_Kids.json` in the listen interface and checking
the regions there checks them against the MARCH grid, not against the wall. The
two disagree by a median 0.08 s and a maximum 2.10 s across the curated ten —
small enough to look right, large enough to be wrong.

This script writes, per audience, a Listen Here! session file whose `body` is the
HQ alignment and whose `annotations` are that audience's, with every region time
re-derived exactly as prep derives it (and hand-placed overrides applied last, as
prep applies them). What the author sees in the listen interface is then what the
exhibit shows, and a correction made there is a correction to the wall.

It also writes a drift report: every region x recording whose time moved, worst
first, so a checking session can go to the ones that actually moved instead of
reading all eighty.

THE RETURN TRIP. `CANONICAL_PAIRS` is asserted on every payload build and
`verify_pairs` calls `sys.exit` on any disagreement — deliberately, so that a
moved region fails the build rather than putting the wrong bar on a museum wall.
A corrected file therefore comes back as an updated TABLE, not just as a new
export: run `--derive-pairs <corrected file>` to print the new entries.

    tools/exhibit_annots_on_hq.py                      # three files + the report
    tools/exhibit_annots_on_hq.py --threshold 0.5      # a quieter report
    tools/exhibit_annots_on_hq.py --derive-pairs ExhibitAnnots/Fledermaus_Expert_on_HQ.json
"""
from __future__ import annotations

import argparse
import copy
import json
import os
import statistics
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import prep_exhibit_data as prep  # noqa: E402  (the single source of the arithmetic)

REPO = prep.REPO
OUT_TEMPLATE = "Fledermaus_{Audience}_on_HQ.json"
REPORT_NAME = "annots-on-hq-report.md"

# Header keys that belong to the AUTHOR rather than to the alignment, and so
# travel from the audience set onto the HQ body. `markers` is deliberately NOT
# among them: marker times were placed against the old grid and would arrive
# stale, pointing at moments a few tenths of a second off.
AUTHOR_HEADER_KEYS = ("linkedDataUriPrefix", "groupingTabs", "activeTab")


def log(msg=""):
    print(msg, flush=True)


# --------------------------------------------------------------------- splicing
def rederive_onto(annotations, hq_audio, notes):
    """Rewrite every regionTime as HQgrid[file][startIx] -> HQgrid[file][endIx].

    Identical arithmetic to prep's `rederive_times`, over the authoring shape
    rather than the payload's. Returns (rows, filled): the drift rows it could
    measure, and how many times it actually wrote. The two differ, because a
    target whose authored time was null has no drift to report but is still
    filled in — which is the re-derive doing its job.
    """
    rows = []
    filled = 0
    for ann in annotations:
        for reg in ann.get("regions", []):
            rid = reg["id"]
            pair = prep.CANONICAL_PAIRS.get(rid)
            if pair is None:
                notes.append(f"region {rid} ({ann.get('label')}) is not in CANONICAL_PAIRS — left as authored")
                continue
            a, b = pair
            for tgt in ann.get("targets", []):
                filename = tgt["file"]
                times = tgt.get("regionTimes") or {}
                if rid not in times:
                    continue
                grid = (hq_audio.get(filename) or {}).get("times")
                if not grid or b >= len(grid):
                    notes.append(f"{rid} on {filename}: no HQ grid (or too short) — left as authored")
                    continue
                was = times.get(rid) or {}
                now = {"start": grid[a], "end": grid[b], "derived": True}
                times[rid] = now
                filled += 1
                if was.get("start") is not None:
                    rows.append({
                        "region": rid,
                        "label": ann.get("label"),
                        "file": filename,
                        "was": (was["start"], was["end"]),
                        "now": (now["start"], now["end"]),
                        "shift": max(abs(now["start"] - was["start"]), abs(now["end"] - was["end"])),
                    })
    return rows, filled


def overlay_overrides(annotations, overrides, notes):
    """Hand-placed times win over the re-derive, exactly as prep applies them last."""
    applied = 0
    index = {a["id"]: a for a in annotations}
    for ann_id, regions in (overrides or {}).items():
        if ann_id.startswith("_"):
            continue  # a note key, not data
        ann = index.get(ann_id)
        if ann is None:
            continue  # belongs to another audience's file
        by_file = {t["file"]: t for t in ann.get("targets", [])}
        for region_id, files in (regions or {}).items():
            if region_id.startswith("_"):
                continue
            for filename, t in (files or {}).items():
                tgt = by_file.get(filename)
                if tgt is None or region_id not in (tgt.get("regionTimes") or {}):
                    notes.append(f"override {ann_id}/{region_id}/{filename} names a target that is absent")
                    continue
                tgt["regionTimes"][region_id] = {"start": t["start"], "end": t["end"], "derived": False}
                applied += 1
    return applied


def filter_grouping(tabs, hq_files, notes):
    """Drop files the HQ body does not carry, so a group never names a missing file."""
    if not tabs:
        return tabs
    dropped = set()
    out = copy.deepcopy(tabs)
    for tab in out:
        for grp in tab.get("fileGroups", []):
            keep = [f for f in grp.get("files", []) if f in hq_files]
            dropped |= set(grp.get("files", [])) - set(keep)
            grp["files"] = keep
    if dropped:
        notes.append("grouping tabs: dropped " + ", ".join(sorted(dropped)) + " (not in the HQ alignment)")
    return out


def build_one(audience, source, hq, overrides, notes):
    annotations = copy.deepcopy(source.get("annotations", []))
    hq_audio = hq["body"]["audio"]
    rows, filled = rederive_onto(annotations, hq_audio, notes)
    applied = overlay_overrides(annotations, overrides, notes)

    header = copy.deepcopy(hq["header"])
    for key in AUTHOR_HEADER_KEYS:
        if key in source.get("header", {}):
            header[key] = copy.deepcopy(source["header"][key])
    header["groupingTabs"] = filter_grouping(header.get("groupingTabs"), set(hq_audio), notes)
    header["_splicedBy"] = {
        "tool": "tools/exhibit_annots_on_hq.py",
        "audience": audience,
        "alignment": prep.SOURCES["hq"],
        "alignmentCreatedBy": hq["header"].get("createdBy"),
        "annotationsFrom": prep.SOURCES[audience],
        "annotationsCreatedBy": source["header"].get("createdBy"),
        "note": ("Region times are re-derived from CANONICAL_PAIRS against this body's grids, "
                 "so they match the exhibit exactly. Markers were dropped as stale. "
                 "Moving a region here changes its index pair: feed the saved file back "
                 "through --derive-pairs and update CANONICAL_PAIRS."),
    }
    out = {"header": header, "body": hq["body"], "annotations": annotations}
    return out, rows, applied, filled


# ----------------------------------------------------------------------- report
def fmt(t):
    return f"{int(t // 60)}:{t % 60:05.2f}"


def write_report(path, per_audience, threshold, overrides):
    curated = set(prep.CURATED)
    all_rows = [r for rows in per_audience.values() for r in rows]
    vals = [r["shift"] for r in all_rows]
    lines = []
    lines.append("# Chanda's annotations on the HQ grid — what moved")
    lines.append("")
    lines.append("Generated by `tools/exhibit_annots_on_hq.py`. Every row is one region on one")
    lines.append("recording: the time as AUTHORED (against the audience set's own, older alignment)")
    lines.append("against the time the EXHIBIT shows (re-derived through the canonical index pair")
    lines.append(f"on `{prep.SOURCES['hq']}`). `shift` is the larger of the two edge movements.")
    lines.append("")
    if vals:
        lines.append(f"**{len(vals)} comparable times — median {statistics.median(vals):.2f} s, "
                     f"mean {statistics.mean(vals):.2f} s, max {max(vals):.2f} s.** "
                     f"{sum(1 for v in vals if v > threshold)} move more than {threshold:.2f} s.")
        lines.append("")
    lines.append("A region is ONE musical position mirrored to every recording through the grid, so")
    lines.append("a row is not an independent judgement: correcting a region on one recording and")
    lines.append("re-deriving moves it on all of them. Check where the music is, not where the")
    lines.append("numbers are.")
    lines.append("")
    lines.append(f"`*` marks the curated ten — the only recordings the exhibit shows.")
    lines.append("")

    for audience in prep.AUDIENCES:
        rows = per_audience.get(audience, [])
        lines.append(f"## {audience}")
        lines.append("")
        by_region = {}
        for r in rows:
            by_region.setdefault((r["region"], r["label"]), []).append(r)
        for (rid, label), rs in sorted(by_region.items(), key=lambda kv: -max(r["shift"] for r in kv[1])):
            pair = prep.CANONICAL_PAIRS.get(rid)
            width = rs[0]["now"][1] - rs[0]["now"][0]
            flag = ""
            if rid in prep.NEEDS_HAND_PLACEMENT:
                pending = not any(
                    rid in (regions or {})
                    for ann_id, regions in (overrides or {}).items()
                    if not ann_id.startswith("_")
                )
                flag = ("  — **HAND-PLACEMENT PENDING: no grid can place this one, do not "
                        "trust these times**" if pending else "  — hand-placed (override)")
            lines.append(f"### {label} · `{rid}`  indices {pair[0]}–{pair[1]}, "
                         f"{width:.2f} s wide{flag}")
            lines.append("")
            over = [r for r in sorted(rs, key=lambda r: -r["shift"]) if r["shift"] > threshold]
            if not over:
                lines.append(f"Nothing moved more than {threshold:.2f} s "
                             f"(largest {max(r['shift'] for r in rs):.2f} s).")
                lines.append("")
                continue
            lines.append("| recording | authored | exhibit | shift |")
            lines.append("|---|---|---|---|")
            for r in over:
                mark = "*" if r["file"] in curated else ""
                lines.append(f"| {mark}{r['file']} | {fmt(r['was'][0])}–{fmt(r['was'][1])} "
                             f"| {fmt(r['now'][0])}–{fmt(r['now'][1])} | **{r['shift']:.2f} s** |")
            lines.append("")
            quiet = len(rs) - len(over)
            if quiet:
                lines.append(f"({quiet} further recording(s) moved less than {threshold:.2f} s.)")
                lines.append("")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")


# ----------------------------------------------------------------- derive-pairs
def derive_pairs(path):
    """Print the CANONICAL_PAIRS entries a corrected file implies.

    The vote is over every target, exactly as prep's `verify_pairs` votes, so a
    region the author moved on one recording and left on nine shows up as dissent
    rather than as a silent change.
    """
    from collections import Counter
    d = json.load(open(path, encoding="utf-8"))
    audio = d["body"]["audio"]
    log(f"index pairs implied by {os.path.basename(path)}:")
    for ann in d.get("annotations", []):
        for reg in ann.get("regions", []):
            rid = reg["id"]
            votes = Counter()
            for tgt in ann.get("targets", []):
                rt = (tgt.get("regionTimes") or {}).get(rid)
                grid = (audio.get(tgt["file"]) or {}).get("times")
                if not rt or not grid or rt.get("start") is None:
                    continue
                votes[(prep.closest_ix(grid, rt["start"]), prep.closest_ix(grid, rt["end"]))] += 1
            if not votes:
                log(f"  {rid}: no times")
                continue
            pair, agree = votes.most_common(1)[0]
            total = sum(votes.values())
            was = prep.CANONICAL_PAIRS.get(rid)
            change = "unchanged" if was == pair else f"WAS {was}"
            log(f'  "{rid}": {pair},  # {ann.get("label")} — {agree}/{total} agree, {change}')
            if agree < total:
                for k, v in votes.items():
                    if k != pair:
                        log(f"      dissent {k} x{v}")


# ------------------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--src-dir", default=os.path.join(REPO, "ExhibitAnnots"))
    ap.add_argument("--out-dir", default=None,
                    help="defaults to <src-dir>/on-hq — a subdirectory, so the three DERIVED "
                         "files are never mistaken for the four authored sources")
    ap.add_argument("--threshold", type=float, default=0.25,
                    help="report rows that moved more than this many seconds (default 0.25)")
    ap.add_argument("--derive-pairs", metavar="FILE",
                    help="print the CANONICAL_PAIRS entries a corrected file implies, and exit")
    args = ap.parse_args()

    if args.derive_pairs:
        derive_pairs(args.derive_pairs)
        return

    out_dir = args.out_dir or os.path.join(args.src_dir, "on-hq")
    os.makedirs(out_dir, exist_ok=True)
    notes = []

    hq_path = os.path.join(args.src_dir, prep.SOURCES["hq"])
    log(f"reading {hq_path}")
    hq = json.load(open(hq_path, encoding="utf-8"))

    overrides_path = os.path.join(REPO, "app/static/exhibit/data", prep.OVERRIDES_FILE)
    overrides = {}
    if os.path.exists(overrides_path):
        overrides = json.load(open(overrides_path, encoding="utf-8"))

    per_audience = {}
    for audience in prep.AUDIENCES:
        src_path = os.path.join(args.src_dir, prep.SOURCES[audience])
        source = json.load(open(src_path, encoding="utf-8"))
        out, rows, applied, filled = build_one(audience, source, hq, overrides, notes)
        per_audience[audience] = rows
        name = OUT_TEMPLATE.format(Audience=audience.capitalize())
        dest = os.path.join(out_dir, name)
        with open(dest, "w", encoding="utf-8") as fh:
            json.dump(out, fh)
        moved = sum(1 for r in rows if r["shift"] > args.threshold)
        log(f"  {name}: {len(out['annotations'])} annotations, {filled} times re-derived "
            f"({len(rows)} comparable), {moved} moved > {args.threshold:.2f} s"
            + (f", {applied} hand-placed" if applied else ""))

    report = os.path.join(out_dir, REPORT_NAME)
    write_report(report, per_audience, args.threshold, overrides)
    log(f"  {REPORT_NAME}: written")

    if notes:
        log("")
        log(f"{len(notes)} note(s):")
        for n in notes:
            log(f"  - {n}")


if __name__ == "__main__":
    main()
