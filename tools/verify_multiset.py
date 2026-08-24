#!/usr/bin/env python3
"""Multiset reconstruction check for a behaviour-preserving code relocation.

The verification that made the Phase-1 refactor's 27 increments safe, and the
Phase-2 extractions after them. It answers one question: **did any line of code
vanish, or appear, that I cannot name?**

Method — deliberately dumb, and that is the point. There is no tokenizer and no
AST, so it cannot be fooled by a clever transformation it does not model:

1. Take the multiset of every non-blank line, comments INCLUDED, over the OLD
   files (read from a git ref) and over the NEW files (read from the worktree).
2. Normalise the OLD side to speak the new names first, via --rename.
3. Subtract. Residual on either side must be explainable line by line: an import,
   a re-export, a signature the wrapper changed, or a comment written on purpose.
   **Zero unexplained executable statements** is the pass condition — not "zero
   residual", which no real extraction achieves.

It is intentionally not a pass/fail test. It prints the residual and a human
decides, because the judgement ("this comment is one I rewrote") is the work.

Two traps, both paid for in real sessions:

* **Make every --rename pattern long enough to be UNIQUE to the moved code.**
  Extracting align-core, `Object.keys(alignmentGrids)` → `Object.keys(grids)`
  looked right and rewrote 11 unrelated call sites elsewhere in listen.js,
  inventing 11 residual lines. Match the whole statement, not the fragment.
* **Where a rename is only partial, leave it IN the residual rather than
  normalising it away.** Showing it as 3-old/3-new is honest; a blanket rewrite
  is positional guesswork wearing normalisation's clothes.

Usage:

    tools/verify_multiset.py \\
      --old app/static/js/listen.js \\
      --new app/static/js/listen.js app/static/js/engine/align-core.js \\
      --rename 'let grid = alignmentGrids\\[audioIx\\];' 'let grid = grids[audioIx];' \\
      --ref HEAD

--old paths are read from --ref (default HEAD); --new paths from the worktree.
--rename takes TWO arguments, a Python `re` pattern and a literal replacement,
applied to the OLD side in the order given. Two arguments rather than
`pattern=replacement` because the patterns worth writing contain `=` themselves.
Backslashes in the replacement are escaped for you, so `$1`-style group
references are not available — write the whole line out instead.
Note that `export ` is stripped from both sides, since export-ness is not a
line's content.

Exit status is 0 unless a file could not be read. Judge the output, don't grep
it for "OK".
"""
import argparse
import re
import subprocess
import sys
from collections import Counter


def parse_args():
    p = argparse.ArgumentParser(add_help=True, description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--old", nargs="+", required=True,
                   help="repo-relative paths making up the OLD side, read from --ref")
    p.add_argument("--new", nargs="+", required=True,
                   help="repo-relative paths making up the NEW side, read from the worktree")
    p.add_argument("--rename", action="append", default=[], nargs=2,
                   metavar=("REGEX", "REPLACEMENT"),
                   help="OLD-side normalisation, applied in order; repeatable. Two separate "
                        "arguments, NOT regex=replacement — the patterns worth writing contain "
                        "'=' themselves (`let grid = ...`), and splitting on it silently mangles "
                        "them into garbage that still 'works'.")
    p.add_argument("--ref", default="HEAD", help="git ref for the OLD side (default HEAD)")
    p.add_argument("--repo", default=".", help="repository root (default .)")
    p.add_argument("--quiet-comments", action="store_true",
                   help="hide residual lines that are pure comments, to inspect code alone")
    return p.parse_args()


def lines(text, renames):
    for pat, rep in renames:
        text = re.sub(pat, rep.replace("\\", "\\\\"), text)
    text = text.replace("export ", "")   # export-ness is not a line's content
    return [ln.strip() for ln in text.splitlines() if ln.strip()]


def read(repo, path, ref):
    if ref is None:
        with open(f"{repo}/{path}", encoding="utf-8") as fh:
            return fh.read()
    r = subprocess.run(["git", "-C", repo, "show", f"{ref}:{path}"],
                       capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit(f"cannot read {path} at {ref}: {r.stderr.strip()}")
    return r.stdout


def collect(repo, paths, ref, renames):
    c = Counter()
    for p in paths:
        c.update(lines(read(repo, p, ref), renames))
    return c


IS_COMMENT = re.compile(r"^(//|/\*|\*)")


def main():
    a = parse_args()
    renames = [(pat, rep) for pat, rep in a.rename]

    old = collect(a.repo, a.old, a.ref, renames)
    new = collect(a.repo, a.new, None, [])
    print(f"OLD {sum(old.values())} lines @ {a.ref}  ->  NEW {sum(new.values())} lines "
          f"(delta {sum(new.values()) - sum(old.values())})")

    for label, residual in (("OLD-ONLY", old - new), ("NEW-ONLY", new - old)):
        shown = residual
        if a.quiet_comments:
            shown = Counter({k: v for k, v in residual.items() if not IS_COMMENT.match(k)})
        note = "" if shown is residual else f" ({sum(residual.values())} incl. comments)"
        print(f"\nRESIDUAL {label} ({sum(shown.values())}){note}:")
        for ln, n in sorted(shown.items()):
            print(f"  {n}x  {ln}")

    print("\nPass condition: every residual line above is an import, a re-export, a changed "
          "signature,\nor a comment written on purpose — and no executable statement is "
          "unexplained.")


if __name__ == "__main__":
    main()
