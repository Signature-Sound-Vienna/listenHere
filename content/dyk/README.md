# "Did you know?" — the museum text

Chanda's authored content for the two explorers: six New Year's Concerts and six
conductors, each written three times over for the exhibit's three audiences.
Supplied 2026-09-18 as two Google Docs markdown exports.

**This folder is the source of truth.** `tools/prep_exhibit_dyk.py` parses it into
`app/static/exhibit/data/dyk.json`, which the exhibit reads and which — unlike
`concerts.json` — is committed. Chanda hands over a revised file; the tool is
re-run; the JSON is committed with it. Nothing is transcribed by hand, because the
ruling is that her text is rendered **verbatim**.

| file | what |
|---|---|
| `concert-years.md` | 1939–2026 as `# YYYY` headings; six carry content. A content year's heading carries the hook as a parenthetical subtitle. |
| `conductors.md` | six conductors as `# Name (years)` headings. |
| `images/` | the two photographs, **gitignored** — see below. |
| `original-export/` | Chanda's two files exactly as they arrived, base64 and all; **gitignored**, kept so the stripped copies can be checked against the originals. |

## The registers

Chanda labels them **Kids**, **Adults**, and **Nerds** (spelled `Experts / nerds` in
the conductors file). They map to the payload's audience ids `kids`, `adults`, and
`expert` — the last displayed to visitors as "Scholars" (`strings.js`). The label
formatting is inconsistent between and within the two files (`**Kids: Did you
know?**`, `**Kids:** Did you know?`, `Kids: Did you know?`), so the tool matches on
the audience word and not on the bold.

**English only.** The German half of the exhibit falls back to English, as the
attract band's title does, until the in-house translation lands.

## The two images are NOT shipped

Both are embedded in the original export as base64. They are press photographs of
**unknown licence**, so they were split out on 2026-09-18 into `images/` and
gitignored; the reference definitions in `conductors.md` were rewritten to point at
them. Keep them, never delete them — they are the reference for what should be
there. The exhibit shows a **placeholder figure** at the right aspect instead, and
`?dykImages=off` (study panel, Views) hides even that.

| ref | file | size | shows |
|---|---|---|---|
| `image1` | `boskovsky-violin.png` | 624×292 | Boskovsky conducting with his violin |
| `image2` | `karajan-battle-1987.png` | 624×407 | Karajan with Kathleen Battle, 1987 |

Two things to settle before either becomes a real figure:

1. **Chanda's own note asks for an AI image, not this one** — the Boskovsky
   paragraph carries `[insert AI photo of Boskovsky with violin in hand here]`
   (stripped by the tool). An AI-generated image inherits the plan's §5.5
   obligations in full: the spark mark burned into the asset, and the disclosure
   sentence. The portraits' own README is the precedent.
2. **The captions are ours, not hers.** She supplied none, and the note above is an
   instruction rather than a caption. They are authored in the tool's `IMAGES`
   table, where they can be changed without touching her markdown.

## Editorial slips, for Chanda — listed, not fixed

Her text is rendered verbatim, so none of these has been corrected here. They are
hers to rule on, and re-running the tool picks up whatever she decides.

| where | as written | looks like |
|---|---|---|
| 1959 Adults | "with conductor Willi Boskovsky **was on** the podium" | a half-edited sentence |
| 1982 Nerds | "*Neujarhskonzert*" | "Neujahrskonzert" |
| 2005 Nerds | "Radetzsky" | "Radetzky", as spelled everywhere else |
| Krips Nerds | "*Anschlus*s" | a stray escape split the italics mid-word |
| Kleiber Nerds | "preoccupation of Kleibers" | "Kleiber's" |
| Boskovsky Kids | "conducted with his violin\!" | a Google-Docs escape, harmless — the tool unescapes it |

One more that is not a slip but wants her decision: **Boskovsky's Kids text ends
"Can you find the violin in his photo?"** — which dangles while the figure is a
placeholder, and dangles further under `?dykImages=off`.

## Re-running the tool

    tools/prep_exhibit_dyk.py --report     # parse and print what it found, write nothing
    tools/prep_exhibit_dyk.py              # write app/static/exhibit/data/dyk.json
    tools/prep_exhibit_dyk.py --self-test  # check the parser's helpers, exit

Every decision the parser makes is in its docstring.
