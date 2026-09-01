#!/usr/bin/env python3
"""Split the AUTHORED half out of the exhibit annotation sets, and splice it back.

WHY THIS EXISTS
---------------
`ExhibitAnnots/Alignment_Fledermaus_{Kids,Adults,Expert}.json` are Listen Here!
session exports. Each is ~19 MB, and all but ~20 KB of that is `body.audio` —
the alignment grids, which are a BUILD PRODUCT: `tools/prep_exhibit_data.py`
re-derives every region time from `CANONICAL_PAIRS` against the HQ grid and never
copies a stored time. The remaining ~20 KB — `header` and `annotations` — is
AUTHORED: Chanda's descriptions, her per-recording notes, her group names.

So the sets were gitignored wholesale for their size, which left the authored text
unbacked and untracked. That is the wrong trade: it is the small half that cannot
be regenerated. This script separates the two, so the authored half can live in
the working-docs repository at 50 KB for all three sets instead of 57 MB.

It also makes Chanda's next export survivable. She still owes the hand-placement
of two single-note regions (plan §5.2d), which she does in the app and saves — a
fresh export, with her structure and a fresh `body`, and without any correction we
applied here in the meantime. `merge` splices the tracked authored half back over
that new `body` and reports, line by line, every text it would overwrite.

  split   full sets            -> <out>/Alignment_Fledermaus_<Aud>.authored.json
  merge   authored + full sets -> full sets, authored half replaced
  diff    authored vs full     -> what differs, and nothing written

`--check` on `split` exits non-zero when the tracked copy is stale, which is the
form to run before committing.

TIMES ARE NOT AUTHORED DATA, with one exception. `targets[].regionTimes` rides
along inside `annotations` and goes stale the moment the alignment is re-derived.
That is harmless — prep ignores it — and it is why `merge` never warns about a
time. The exception is a HAND-PLACED time, which is authority forever and lives in
`app/static/exhibit/data/overrides.json`, not here.
"""
from __future__ import annotations

import argparse
import difflib
import json
import os
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SETS = ["Kids", "Adults", "Expert"]
SRC_TMPL = "Alignment_Fledermaus_{}.json"
OUT_TMPL = "Alignment_Fledermaus_{}.authored.json"

# The build product. Everything else in the file is authored and is kept.
DROPPED = "body"


def log(msg=""):
    print(msg, flush=True)


def load(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def lean(full):
    """The authored half: the whole document minus the alignment grids."""
    return {k: v for k, v in full.items() if k != DROPPED}


def dumps(obj):
    # Pretty and unescaped, because the point of the tracked copy is a readable
    # `git diff` when a sentence changes.
    return json.dumps(obj, ensure_ascii=False, indent=1, sort_keys=False) + "\n"


# ------------------------------------------------------------------ text walking
def texts(doc):
    """Every visitor-visible string in an authored document, by a stable path.

    Used only for reporting — `merge` replaces the authored half wholesale, so
    this exists to tell a human what that replacement changes.
    """
    out = {}
    for tab in doc.get("header", {}).get("groupingTabs", []):
        for g in tab.get("fileGroups", []):
            out[f"header/tab:{tab.get('name')}/group"] = g.get("name", "")
    for ann in doc.get("annotations", []):
        a = ann.get("label", ann.get("id", "?"))
        out[f"{a}/label"] = ann.get("label", "")
        out[f"{a}/description"] = ann.get("description", "")
        for gid, note in (ann.get("groupNotes") or {}).items():
            out[f"{a}/groupNote:{gid}"] = note or ""
        for g in (ann.get("pinnedGrouping") or {}).get("groups", []):
            out[f"{a}/group:{g.get('groupId')}"] = g.get("label", "")
        for tgt in ann.get("targets", []):
            out[f"{a}/target:{tgt.get('file')}"] = tgt.get("description", "") or ""
        for reg in ann.get("regions", []):
            out[f"{a}/region:{reg.get('id')}"] = reg.get("label", "") or ""
    return out


def report_text_diff(old, new, indent="    "):
    """Print every authored string that differs. Returns the number of them."""
    a, b = texts(old), texts(new)
    n = 0
    for key in sorted(set(a) | set(b)):
        was, now = a.get(key), b.get(key)
        if was == now:
            continue
        n += 1
        log(f"{indent}{key}")
        if was is None:
            log(f"{indent}  + {now[:160]!r}")
        elif now is None:
            log(f"{indent}  - {was[:160]!r}")
        else:
            for line in difflib.unified_diff([was], [now], lineterm="", n=0):
                if line.startswith(("+++", "---", "@@")):
                    continue
                log(f"{indent}  {line[:170]}")
    return n


# ------------------------------------------------------------------------ actions
def do_split(args):
    os.makedirs(args.out, exist_ok=True)
    stale = 0
    for aud in SETS:
        src = os.path.join(args.src_dir, SRC_TMPL.format(aud))
        dst = os.path.join(args.out, OUT_TMPL.format(aud))
        if not os.path.exists(src):
            log(f"  MISSING {src}")
            stale += 1
            continue
        text = dumps(lean(load(src)))
        current = open(dst, encoding="utf-8").read() if os.path.exists(dst) else None
        if current == text:
            log(f"  {aud:<7} unchanged  ({len(text) / 1024:.1f} KB)")
            continue
        stale += 1
        if args.check:
            log(f"  {aud:<7} STALE — the tracked copy differs from {src}")
            if current is not None:
                report_text_diff(json.loads(current), lean(load(src)))
            continue
        with open(dst, "w", encoding="utf-8") as fh:
            fh.write(text)
        size = os.path.getsize(src) / 1048576
        log(f"  {aud:<7} written    ({len(text) / 1024:.1f} KB, from {size:.1f} MB)")
    if args.check and stale:
        log(f"\n{stale} set(s) stale. Run without --check to update, then commit.")
        return 1
    return 0


def do_merge(args):
    for aud in SETS:
        src = os.path.join(args.src_dir, SRC_TMPL.format(aud))
        authored = os.path.join(args.out, OUT_TMPL.format(aud))
        if not (os.path.exists(src) and os.path.exists(authored)):
            log(f"  {aud:<7} SKIPPED — need both {src} and {authored}")
            continue
        full, new = load(src), load(authored)
        changed = report_text_diff(lean(full), new)
        merged = dict(new)
        merged[DROPPED] = full[DROPPED]
        # Key order as the exporter writes it, so a later split is a small diff.
        ordered = {k: merged[k] for k in list(full) if k in merged}
        ordered.update({k: v for k, v in merged.items() if k not in ordered})
        if args.dry_run:
            log(f"  {aud:<7} would rewrite {src} ({changed} text change(s))")
            continue
        with open(src, "w", encoding="utf-8") as fh:
            # indent=2 because that is what listen.js's save writes
            # (`JSON.stringify(…, null, 2)`), and a set that comes back out of the
            # app should not differ from this one by whitespace alone.
            json.dump(ordered, fh, ensure_ascii=False, indent=2)
        log(f"  {aud:<7} spliced into {src} ({changed} text change(s))")
    return 0


def do_diff(args):
    total = 0
    for aud in SETS:
        src = os.path.join(args.src_dir, SRC_TMPL.format(aud))
        authored = os.path.join(args.out, OUT_TMPL.format(aud))
        if not (os.path.exists(src) and os.path.exists(authored)):
            log(f"  {aud:<7} SKIPPED — need both files")
            continue
        n = report_text_diff(load(authored), lean(load(src)))
        total += n
        log(f"  {aud:<7} {n} text difference(s)  (tracked -> working)")
    return 1 if total else 0


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("action", choices=["split", "merge", "diff"])
    ap.add_argument("--src-dir", default=os.path.join(REPO, "ExhibitAnnots"))
    ap.add_argument("--out", default=os.path.join(REPO, "ExhibitAnnots/authored"),
                    help="where the authored halves live (a symlink into the "
                         "working-docs repository)")
    ap.add_argument("--check", action="store_true",
                    help="split: write nothing, exit 1 if the tracked copy is stale")
    ap.add_argument("--dry-run", action="store_true",
                    help="merge: report what would change, write nothing")
    args = ap.parse_args()
    log(f"{args.action}:")
    sys.exit({"split": do_split, "merge": do_merge, "diff": do_diff}[args.action](args))


if __name__ == "__main__":
    main()
