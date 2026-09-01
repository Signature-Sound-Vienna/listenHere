# Conductor portraits

Gen-AI stylised portraits for the middle band (exhibit plan §5.5). Circular gold
medallions on blue velvet, sized to the band's `border-radius: 50%` frame.

## Provenance — read this before adding any

These are **AI-generated impressions of real, named people**, not photographs
and not licensed likenesses. Three obligations follow, and only the first is
currently met:

1. **Provenance is recorded per image** — the table below, plus a
   `_disposition` and `_why` on every `portrait` entry in
   `../data/metadata-overrides.json`.
2. **They must be labelled visibly as AI-generated impressions** wherever a
   visitor sees them. **NOT YET IMPLEMENTED.** The band deliberately carries no
   text (the no-labels rule, plan §6.3 — a caption would have to pick one of two
   readers' languages), so the label needs a design decision rather than a
   string. This is release-blocking for a public exhibit showing invented images
   of named living and recently-living people.
3. **They are display only.** Nothing derives a fact from a portrait.

| batch | delivered | source | count |
|---|---|---|---|
| 1 | 2026-09-01 | `ConductorPortraits_initial.jpg`, a 1600×898 3×3 contact sheet | 9 |

Batch 1 was split by `tools/split_portraits.py`, which finds each medallion by
its gold ring rather than by assuming a grid pitch, and crops a square with 3 px
of margin so `border-radius: 50%` cannot clip the ring.

## Naming: one portrait per RECORDING

`<recording-slug>-<sitter>.jpg`, where the recording slug is the same one the
prepped payload uses for audio (`audio/vpo-1987.mp3` → `vpo-1987-karajan.jpg`).

**Per recording, not per conductor** — the corpus runs to 90-odd releases and
60-plus New Year's Concerts, so the same conductor recurs across decades and
each version gets its own sitting, at the age they were for that concert. A
conductor-keyed file would have collapsed those into one face.

| file | recording | sitter |
|---|---|---|
| `vpo-1987-karajan.jpg` | `VPO-1987.wav` | Herbert von Karajan |
| `vpo-1989-kleiber.jpg` | `VPO-1989.wav` | Carlos Kleiber |
| `vpo-2022-barenboim.jpg` | `VPO-2022.wav` | Daniel Barenboim |

### `unassigned/`

Batch 1 arrived keyed to conductors, and six of the nine have no recording in
the *Fledermaus* payload yet. They wait here under the sitter's surname — the
only thing known about them — and get a recording slug when one is assigned:

`abbado`, `harnoncourt`, `jansons`, `maazel`, `muti`, `welser-moest`.

All six conduct New Year's Concerts in the wider corpus; none of them conducts
one of the twenty *Fledermaus* overture recordings, which is why they are not
wired up. Spellings here are the standard ones (Claudio Abb**a**do, Mariss
Jans**ons**, Franz Welser-M**ö**st) rather than the contact sheet's.

## Wiring one up

Add a `portrait` field to the recording's entry in
`../data/metadata-overrides.json` — the authored, committed layer that
`tools/prep_exhibit_metadata.py` applies last. The path is relative to the
exhibit root (`portraits/…`); `payload.js`'s `portraitUrl` resolves it, so it
does not depend on which document is showing the band.
