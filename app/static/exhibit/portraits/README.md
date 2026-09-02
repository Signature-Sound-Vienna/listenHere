# Conductor portraits

Gen-AI stylised portraits for the middle band (exhibit plan §5.5). Circular gold
medallions on blue velvet, sized to the band's `border-radius: 50%` frame.

## Provenance — read this before adding any

These are **AI-generated impressions of real, named people**, not photographs
and not licensed likenesses. Three obligations follow, and the second is only
half met:

1. **Provenance is recorded per image** — the table below, plus a
   `_disposition` and `_why` on every `portrait` entry in
   `../data/metadata-overrides.json`.
2. **They must be labelled visibly as AI-generated impressions** wherever a
   visitor sees them.
   - **The mark is done** (designed 2026-09-01). Every asset carries a small
     gold bubble with a four-point spark in it, straddling the medallion's rim
     at the upper right, plus the IPTC `DigitalSourceType` of
     `trainedAlgorithmicMedia` in its XMP. It is burned into the image by
     `tools/split_portraits.py`, so no surface can forget it and no surface has
     to remember it — see **THE AI MARK** in that file for why it looks the way
     it does. It needs no text, so the band's no-labels rule (plan §6.3 — a
     caption would have to pick one of two readers' languages) survives.
   - **The prose is NOT done, and it is still release-blocking.** A spark is
     recognisable, not self-explanatory: a visitor who has never seen it cannot
     know what it claims. One plain sentence saying the portraits are
     AI-generated impressions, on the **about page** when that is built, is what
     turns the mark into disclosure. Until then this obligation is half met.
3. **They are display only.** Nothing derives a fact from a portrait.

| batch | delivered | source | count |
|---|---|---|---|
| 1 | 2026-09-01 | `ConductorPortraits_initial.jpg`, a 1600×898 3×3 contact sheet | 9 |

Batch 1 was split by `tools/split_portraits.py`, which finds each medallion by
its gold ring rather than by assuming a grid pitch, cuts it out onto
transparency, and stamps the AI mark. **WebP, not JPEG** — the inset medallion
needs an alpha channel, and alpha turns out to be free: measured on a real crop,
WebP q88 is 20 KB against the 24 KB JPEG it replaces (PNG would be 134 KB).

## Naming: one portrait per RECORDING

`<recording-slug>-<sitter>.webp`, where the recording slug is the same one the
prepped payload uses for audio (`audio/vpo-1987.mp3` → `vpo-1987-karajan.webp`).

**Per recording, not per conductor** — the corpus runs to 90-odd releases and
60-plus New Year's Concerts, so the same conductor recurs across decades and
each version gets its own sitting, at the age they were for that concert. A
conductor-keyed file would have collapsed those into one face.

| file | recording | sitter |
|---|---|---|
| `vpo-1987-karajan.webp` | `VPO-1987.wav` | Herbert von Karajan |
| `vpo-1989-kleiber.webp` | `VPO-1989.wav` | Carlos Kleiber |
| `vpo-2022-barenboim.webp` | `VPO-2022.wav` | Daniel Barenboim |

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
