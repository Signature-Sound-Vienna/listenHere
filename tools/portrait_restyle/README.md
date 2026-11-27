# Portrait restyle

Restyles the exhibit's conductor portraits (`app/static/exhibit/portraits/`) into one
warm storybook-illustration look with a **local** image-edit model, because museum
feedback found the photo medallions stylistically incoherent. Institutional sign-off
was given on 2026-11-27.

## Stack (outside the repo)

- ComfyUI in `~/ComfyUI` (uv venv `.venv`), started with `.venv/bin/python main.py`, port 8188.
- Custom node ComfyUI-GGUF.
- Models, all Apache 2.0:

  | role | file |
  |---|---|
  | image-edit model | Qwen-Image-Edit-2511 `qwen-image-edit-2511-Q6_K.gguf` |
  | text encoder | `qwen_2.5_vl_7b.safetensors` |
  | VAE | `qwen_image_vae.safetensors` |
  | LoRA | Lightning `Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors` |

- Settings: 4 steps, cfg 1.0, euler/simple, shift 3.1, 1 MP. A render takes about 90 s on an M5 Pro with 48 GB.

## Steps

Run all three with `~/ComfyUI/.venv/bin/python -I`.

1. `make_inputs.py [SLUG ...]`
   - Fetches each ORIGINAL Commons file named in `sources.json`.
   - Cuts the authored medallion `crop` at 1024 px.
   - Writes to `tools/.cache/portrait-restyle/inputs/`. That directory is gitignored, as is everything under `tools/.cache/`.
2. `render.py prompts/p3.txt 1,2,3 all`
   - Renders each sitter at the given seeds into `tools/.cache/portrait-restyle/out/`.
   - It is resumable: a finished render is skipped, never overwritten.
3. `sheet.py OUT.png p3 all`
   - Builds the review sheet. Per sitter it shows the source crop, the shipped medallion, and every render, composed into the real medallion template.

## Prompts and their provenance

- **Templates** live in `prompts/`. `{facts}` is replaced per sitter by the sentence in `sitters.json`.
- **Every render's full recipe is stored twice:**
  - appended to **`renders.jsonl`** (committed);
  - written as a sidecar `.json` next to the image.
- **The recipe holds:**
  - the resolved prompt;
  - the template file and its SHA-256;
  - the facts and their basis;
  - the input, model files, seed, sampler, and timing.
- **`renders-pilot.jsonl`** is the pilot's log: rounds 1 and 2, three sitters, made from a scratch copy of these scripts with the same models and settings.

| template | what it is | verdict |
|---|---|---|
| `p1.txt` | Cel-shaded storybook cartoon. | Good likeness, but flatter than the references; invents colour for black-and-white sources (Karajan brown-haired). |
| `p2.txt` | Painterly "3D-animated film still". | Closest to the references, but flatters: slimmer, younger, enlarged eyes. |
| `mem.txt` | Text only, no photograph ("Karajan as he looked in the 1960s"). | No likeness; rejected. |
| `p3.txt` | p2's lighting, plus "keep true age, wrinkles, and weight; do not flatter", plus `{facts}`. | **Chosen 2026-11-27** for the full run. |
| `p3ref.txt` | p3 plus a second image as a style reference. | Overrides pose and identity, giving frontal, generic faces; rejected. |
| `p4.txt` | p3 with the clothing as a `{clothes}` slot (default "in a dark concert suit", so without an override p4 IS p3, word for word). | Used from 2026-11-28 for per-sitter fixes (Kleiber keeps his polo shirt). |

## Variants (`slug.variant` in `sitters.json`)

A variant is a trial of another source or framing for one sitter, rendered under its
own name so it never overwrites the sitter's other renders:

- **Inheritance.** It inherits the sitter's entry (`facts`, `clothes`) and overrides
  only what it states. Its `source` overrides `sources.json`'s file, crop, and year.
- **Crop-only variant** (e.g. `krips.wide`): the same photograph, reframed. It reuses
  the cached original, and its credit is the photo medallion's.
- **Different photograph** (e.g. `thielemann.michelides`, `mehta.pbs1980wide`): it
  must state `author`, `licence`, `sourceUrl`, and `year`. `build.py` credits that
  photograph instead.

## Sitter facts (`sitters.json`)

- **Coverage.** Nine sources are black and white or colour-cast, so the model would otherwise invent hair, eye, and skin colour. Each gets one authored sentence describing the sitter *as at the year of the source photo*.
- **Basis.** Each fact records how it was established:
  - `seen`: read off dated colour photographs found by image search. These were looked at only, never reused.
  - `text`: a written first-hand description.
  - `tone`: inferred from the grey tone of the source. This is the weakest.
- **Sitters with colour sources** get no sentence.

## Before anything ships

The outputs are AI-generated derivatives, so the provenance obligations return:

- XMP `DigitalSourceType` becomes `trainedAlgorithmicMedia`.
- The credit reads "illustration generated from a photograph by X".
- Derivatives of CC BY-SA photographs are released CC BY-SA.
- No gold-spark AI mark (user, 2026-11-28): with every portrait illustrated, the footer sentence is the disclosure.
- The three placeholder figures (Kendlinger, Bauer-Theussl, and Schmid) are never restyled, and no face is invented.
