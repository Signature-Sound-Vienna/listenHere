# Conductor portraits

One circular gold medallion per conductor of the New Year's Concert, sized to the
band's `border-radius: 50%` frame. Since **0.68.0** these are **freely-licensed
photographs from Wikimedia Commons**, not Gen-AI impressions.

## Why they changed

The first batch (2026-09-01) were AI-generated stylised portraits, and the plan
was to commission more until every conductor had one. That route closed: image
models now decline to render living public figures, even as caricature, so the
remaining fifteen could not be made. Photographs under a free licence are the
alternative, and they are better in two ways and worse in one.

* **Better:** they are of the person. Nothing has to be disclosed as invented, and
  the half-met AI-labelling obligation the old version of this file called
  release-blocking is discharged by deletion rather than by a sentence.
* **Better:** coverage is nearly complete on the first pass — 18 of 21, where the
  AI route had 3 wired and 6 waiting.
* **Worse:** attribution is now a LICENCE CONDITION rather than a courtesy, and
  the band carries no labels (plan §6.3). See **Credit**, below.

## Provenance

| | |
|---|---|
| `sources.json` | **authored.** Which Commons file stands for each conductor, which square of it the medallion cuts, and why that file and not another. |
| `credits.json` | **generated** by `tools/fetch_conductor_portraits.py build`, and committed — the kiosk has no network, so the credit has to travel in the repo. |
| each `.webp` | carries the photographer, licence, Commons page and IPTC `digitalCapture` in its XMP, so the claim survives the file being copied out of the exhibit. |

The old assets stamped IPTC `trainedAlgorithmicMedia` and a gold spark. Both are
gone: on a photograph of a real person they would be a false statement about the
picture. `tools/split_portraits.py`, which drew them, is superseded.

## Credit

18 photographs, of which **8 are public domain or CC0** and **10 require
attribution** (CC BY or CC BY-SA). The exhibit credits **all 18** — more than the
licence compels (user, 2026-09-18) — wherever it can name someone; `attribution`
in `credits.json` records which were obligatory.

The credit appears at the **foot of the explorers**, where the AI-disclosure
sentence used to (`strings.js`, `portraitAbout`; `years-view.js`,
`conductors-view.js`). It names the photographer of the portrait **currently on
the card**, not all eighteen at once: a kiosk that must not scroll has no room for
a roll-call, and a credit beside its own picture is the stronger reading of the
licence. Where the photographer is genuinely unrecorded the holding institution
stands in — the BnF for Boskovsky, the Barindelli collection for Maazel and Mehta.

**This means the kiosk URL must reach an explorer** (`?viewSwitch=1` or
`?bandTap=…`, plan §11(e)/(f)). The band alone shows faces with no surface for
their credit. That was already true of the AI sentence; it is a licence condition
now rather than an editorial promise.

**PERSONALITY RIGHTS ARE NOT SETTLED BY THE LICENCE, and are not this file's to
settle.** Commons flags several living sitters with its own `personality`
restriction, and Austrian §78 UrhG (*Bildnisschutz*) is separate from copyright.
Editorial museum use is the normal case, but the institution signs that off.

## Naming: one portrait per CONDUCTOR

`<surname-slug>.webp` — `karajan.webp`, `welser-moest.webp`.

This **reverses** the old rule, which was one per RECORDING so that each sitting
could show the conductor at the age they were for that concert. That worked when
the faces were commissioned; Commons offers one usable picture of a person, taken
whenever it was taken. So a conductor has one face, and **the year shown against a
medallion is the photograph's, not the concert's** — Karajan is 1963 against a
1987 concert. That is the honest reading, and it is what `conductors-view.js`
prints. Where even the photograph's date is unreliable, no year is shown.

## The three with no photograph

`boskovsky` had none either, until the author identified him in a group plate
(see `sources.json`). These three still have none, and get a **placeholder
medallion** — the gold ring around a quiet blue field, depicting nobody:

| slug | why |
|---|---|
| `kendlinger` | no files on Commons at all; appears only in the recordings payload |
| `bauer-theussl` | no files on Commons at all; appears only in the recordings payload |
| `schmid` | identity unresolved — the only conductor of that name on Wikidata died in 2000, and the recording is dated 2003 |

There is a fourth name with no portrait and no placeholder: **Georg Randolph
Warren**, on the 1982 Philharmonia release, is an Alfred Scholz pseudonym. There is
no sitter to photograph, and the band correctly shows its "?" instead.

## The template

Measured off the shipped AI medallions rather than assumed, because the CSS was
built around them:

| | |
|---|---|
| canvas | 340 × 340, RGBA |
| medallion | outer edge of the gold at **0.86** of the canvas half-width |
| gold ring | **0.775 → 0.849**, rgb(198, 162, 94), lit from the upper left |
| outside | transparent |

**The 0.86 inset stays even though the AI mark it was made for is gone.**
`exhibit.css` grew `.mb-portrait` and `--ex-strap-disc-portrait` specifically to
compensate for that transparent margin, so that the visible gold circle lines up
with the paper discs beside it. Changing it here would silently shrink every face
on the wall.

**WebP, not JPEG** — the inset medallion needs an alpha channel, and alpha is
free: 13–27 KB per asset.

### Zooming out past the edge of the picture

A `crop` `size` over 1.0 asks for a frame wider than the photograph. That is the
only way to make a face smaller in the disc when the picture already fills its own
frame, which Karajan's and Nelsons' both do — and Nelsons has no other picture on
Commons at all. The overflow is filled by **replicating the edge pixels**, which
invents no detail: it continues the ground the sitter already stands against. Both
of those grounds are a plain sweep (blurred grey, a red backdrop), so the join does
not read. It WOULD read on a busy background — the build prints how much it added;
look at the asset, and prefer a different photograph over a large pad.

A velvet ground behind the medallions was tried on 2026-09-18 and removed the same
day (user): the medallion wants nothing behind it.

## Adding or replacing one

```
python3 tools/fetch_conductor_portraits.py survey --only muti   # propose
# look at the contact sheet, write file + crop into sources.json
python3 tools/fetch_conductor_portraits.py build --only muti    # render
python3 tools/prep_exhibit_metadata.py                          # recordings
python3 tools/prep_exhibit_concerts.py                          # concerts + credits
```

`survey` proposes and a person disposes — see **WHY SELECTION IS NOT AUTOMATED**
in the tool, which is not a style preference: ranking a category by licence and
resolution returns a street sign for Karajan, a grave for Boskovsky, a letter for
Mehta, Renée Fleming for Thielemann, and two sixteenth-century maps for Prêtre
(*prêtre* is French for priest).

Watch for `!! <slug>: crop clamped to fit` on a build. It means the square would
not fit around the centre you chose and was slid back inside the picture, so the
frame is not the one you picked. That is how Karajan first shipped with his chin
cut off.

## Wiring

Nothing to wire by hand any more. `prep_exhibit_metadata.py` gives every recording
its conductor's portrait by name, and `prep_exhibit_concerts.py` does the same for
all 88 concerts and emits `conductorPortraits` into the sidecar. The three
`portrait` entries that used to sit in `data/metadata-overrides.json` are gone —
an authored override still wins if one is ever needed again.
