# Listen Here!

<img src="/app/static/bat/ListenHereBat.png" width="150" alt="Listen Here!">

_Listen Here!_ is a tool that lets you seamlessly compare and switch between different audio recordings of the same piece of music. It provides a machine-assisted close listening interface: align the recordings (and, optionally, a score), listen across them, annotate what you hear, and correct the alignment where the machine got it wrong.

For a detailed description, please see: [Weigl et al (DLfM '23)](https://doi.org/10.1145/3625135.3625144).

If Listen Here! is useful in your research, please cite:

> Weigl, D. M., VanderHart, C., & Goebl, W. (2026). Publishing and Performing Digital Musicology on the Web: Signature Sound Vienna. _Transactions of the International Society for Music Information Retrieval_, 9(1), 247–263. https://doi.org/10.5334/tismir.315

Citation metadata is also available in [CITATION.cff](CITATION.cff).

This tool is developed as part of the [Signature Sound Vienna (SSV)](https://iwk.mdw.ac.at/signature-sound-vienna) [FWF P 34664-G](https://doi.org/10.55776/P34664) and [Vienna's New Year's Concerts: Same procedure as every year?](https://iwk.mdw.ac.at/same-procedure) [FWF SCP 1556025](https://doi.org/10.55776/SCP1556025) projects, funded by the Austrian Science Fund.

> **🔒 Your audio is never uploaded.** Whether you load files from your computer or stream them from the web, all audio processing — including alignment, alignment correction, playback, and waveform rendering — happens entirely in your web browser. Audio is fetched directly into your browser and is never sent onward to Listen Here! or any other server. This is particularly important when working with copyrighted recordings.

## Getting Started

Listen Here! is publicly hosted and runs directly in your web browser at **https://listen-here.mdw.ac.at**.

To use the tool, you need two things:

1. An **alignment JSON file** (a mapping file that tells the app how the different audio recordings match up in time). You can create one within the tool using the **Align in browser** feature.
2. A collection of **audio files** that you want to compare. You can load these files directly from your computer or from a web server.

There are a few ways to get started:

### 1. Loading audio directly from your computer (Easiest)

You can load audio files directly from your computer using your browser's built-in file picker. This requires no installation or server setup, and your audio data stays entirely on your device.

1. Go to the start page at **https://listen-here.mdw.ac.at** and click **Local files**.
2. Alternatively, visit this link directly:
   `https://listen-here.mdw.ac.at/?align=<URL_of_your_alignment_JSON>&useFiles`
3. The tool will show an overlay listing the audio recordings referenced by the alignment file. You can then:
   - **Choose a folder** to automatically match all audio files inside it.
   - **Choose individual files** to select specific audio recordings.
   - **Drag and drop** audio files directly onto the overlay.
   - Optionally, **name the session** (the name is used for the saved file and helps find unsaved work again).
   - Optionally, switch to the **Linked Data URIs** tab to configure how linked-data annotations will be targeted — see [Sharing annotations on Solid](#sharing-annotations-on-solid) below.
4. You can reopen this overlay at any time with the **Manage recordings** button in the toolbar.

### 2. Using hosted audio files

If your audio files are already hosted on a web server, you can point the app to load them automatically.

1. Go to the start page at **https://listen-here.mdw.ac.at**.
2. Paste the URL of your alignment JSON file into the form and click **Load**.
3. Alternatively, visit this link directly:
   `https://listen-here.mdw.ac.at/?align=<URL_of_your_alignment_JSON>`

The app reads the alignment JSON file, which contains the web addresses (URLs) of your audio files, and your browser fetches them directly. If the alignment file can't be fetched or isn't valid, you are returned to the start page with the reason. Loading from authenticated servers is supported using HTTP Basic Authentication. Remote servers must allow cross-origin requests — see [CORS requirements](#cors-requirements-for-remote-audio).

### 3. Creating a new alignment in your browser

If you don't have an alignment JSON file yet, you can create one directly in the app. The alignment runs entirely in your browser; your audio files are never uploaded to any server.

1. Go to the start page at **https://listen-here.mdw.ac.at** and click **Align in browser**.
2. Alternatively, visit this link directly:
   `https://listen-here.mdw.ac.at/?mode=align`
3. A step-by-step wizard guides you through the process:

   **Step 1 — Files:** Select or drag-and-drop the audio files you want to align. You need at least two.
   - **Reference:** by default the reference is chosen automatically once the files are read: the recording the others agree with best. To choose it yourself, use the radio buttons in the file table's **Ref** column.
   - **Trim ends:** by default, audio at the start or end of a recording that has no counterpart in the reference — applause, announcements, or tuning — is left out of the alignment rather than stretched to fit. Set a single recording differently in the **Trim ends** column.

   **Step 2 — Quality:** Choose an alignment quality preset:
   - **Fast** — good quality, quickest results. Best for previewing or working with many files.
   - **Balanced** (recommended) — better precision, a little slower.
   - **High quality** — best precision, slower. Best for final or archival alignments.

   You can also expand **Advanced parameters** to fine-tune individual settings (see [Alignment parameters](#alignment-parameters) below). Changing a value switches to "Custom"; you can reset to a preset at any time. Your quality settings are remembered across sessions.

   **Step 3 — URIs** (optional): Provide an **MEI URI** if you want to include score–performance alignment. A score alignment enables the score row, the tempo curve, and [alignment correction](#correcting-an-alignment). You can also set an **Audio URI prefix** to embed linked-data identifiers in the output.

   **Step 4 — Align:** Review a summary of your choices, optionally include pre-calculated waveform peaks (faster loading later, at the cost of a slightly larger file), then click **Start Alignment**. A progress display shows each step in real time.

4. You can click any completed step in the indicator bar at the top to jump back and adjust settings before starting.
5. When the alignment completes, a summary names the chosen reference and lists anything trimmed. You can name the session, click **Save data** to download the alignment JSON file, or click **Listen!** to move straight into the listening interface — no page reload required. Your audio stays loaded and ready to play.

---

## Using the listening interface

Once your audio files and alignment are loaded, the listening interface lets you switch between different recordings of the same piece during playback, always landing at the same moment in the music.

### Basic features

- **Sidebar**: Toggle which recordings are visible by checking or unchecking them. The toolbar's controls sit in collapsible **Playback**, **Files**, and **Tools** sections.
- **Playback**: Use the play/pause button or the **Spacebar**. Click anywhere on a waveform to jump to that moment across all synced recordings. The recording you are hearing is marked with an accent-coloured glow.
- **Switching recordings**: Click on a recording's name in the sidebar, or use the **Up/Down Arrow** keys, to change which recording is audible.
- **Score**: When the alignment includes a score, the MEI encoding is synthesised and shown as its own row, aligned like any recording.
- **Display options**: Normalize audio levels, **Visualise alignments** (lines joining aligned moments, drawn either from each waveform **to the next** or **to the reference**), **Show relative position**, and **Shared time axis**.
- **Trimmed ends**: Where a recording's head or tail has no counterpart in the reference, it is hatched over, so it doesn't read as a misalignment.
- **Save data**: Downloads the alignment JSON with everything you've added — markers, groupings, annotations, and corrections. An orange dot on the button shows there are unsaved changes; its tooltip says what they are.

### Keyboard shortcuts

- **`Spacebar`** - Play/Pause
- **`Up`/`Down` Arrow** - Switch between previous/next visible waveforms
- **`Left`/`Right` Arrow** - Seek backwards/forwards by 10 seconds. Hold `Shift` for 5 seconds, or `Shift + Alt` for 1 second increments.
- **`1` - `9` and `0`** - Jump to the 1st through 10th loaded waveform.
- **`Alt` + `1` - `9` and `0`** - Numbered badges appear over the visible waveforms, letting you jump to the first ten waveforms currently on screen.
- **`M`** - Drop a marker at the current playback position.
- **`C`** - Toggle close-listening mode.
- **`Ctrl`/`Cmd` + `Z`** - Undo; add `Shift` to redo.

### Markers and close listening

Markers drop at the current moment on every recording at once and are saved in the alignment file. With **Enable dragging** (under Tools → Drag Markers), markers can be moved by dragging.

Close-listening mode allows targeted navigation between markers and annotation regions:

- Press **`C`** to toggle close-listening mode. Turning it off leaves the playhead where it is.
- Use the **`Left`/`Right` Arrow** keys to snap playback to the previous or next marker or annotation region start.
- Hold **`Shift` + `Left`/`Right` Arrow** to nudge the selected marker (100 ms, or hold **`Alt`** for 20 ms).
- Press **`Backspace` / `Delete`** to delete the selected marker.
- When the active stop is the start of an annotation region, that region loops.

### Zoom

The zoom slider in the Playback section magnifies all waveforms simultaneously (up to 50x). You can also zoom with **Ctrl+scroll** (Cmd+scroll on Mac) over any waveform.

- When zoomed, waveforms scroll horizontally; scrolling one scrolls all others to the corresponding aligned position.
- Three **scroll modes** decide what happens during playback: **Page** (the view jumps when the playhead reaches the edge; default), **Follow** (the playhead stays centred), and **Manual** (no automatic scrolling).
- The alignment lines scale with zoom: more become visible at higher magnification.

### Time axis and measurement

Each waveform shows **time-axis ticks** along its top edge, with density adapting to the zoom level. The **Shared time axis** option places all waveforms on the same time scale: shorter recordings appear proportionally narrower.

Hold **Shift** to measure:
- **Duration labels** appear between consecutive markers, showing the elapsed time in each recording.
- **Shift+drag** on any waveform measures an arbitrary span, projected across all waveforms, so you can see how the same passage differs in duration across recordings.

### Tempo curve

When the alignment includes a score, **Tempo curve** draws each recording's tempo over its waveform, either in quarter notes per minute (**QPM**) or as a percentage **Deviation** from the mean tempo of the recordings it is compared with. Those are all recordings (**Across groups**) or those in the same group (**Within group**), optionally restricted to the **Only visible** ones. **Smooth** sets the smoothing window. See [docs/tempo-curve-algorithm.md](docs/tempo-curve-algorithm.md) for how the curve is derived.

### Grouping recordings

When many recordings are loaded, you can organise them into named, coloured groups. Click **Group recordings** in the toolbar:

- Create groups with **+ New Group**, optionally with a filename pattern (substring or regular expression) that matches recordings automatically.
- **Drag and drop** recordings into, between, and out of groups (several at once with multi-select), or drag onto empty space to create a group.
- Reorder, rename, recolour, or delete groups; click **Apply** to save.
- **Grouping tabs** keep several independent groupings of the same recordings — say, one by year and another by orchestra. Switch between them with the pill buttons above the waveforms.
- Groups can also be reordered in the sidebar by dragging the ☰ handle on each group header.

A recording belongs to exactly one group per tab. All grouping is saved in the alignment JSON.

### Settings and themes

The **cog (⚙)** button on the right edge opens the Settings drawer. Choose from eight themes: Light (default), Solarized, Sepia, Peach, Dark, Dracula, Forest, and Nord. Your choice is remembered. A language choice (English, Deutsch) is stored, but the interface is not yet translated.

---

## Annotations

Annotations describe passages of the music across recordings: which recordings, which time regions, and what you have to say about them, as a whole, per recording, per group of recordings, and as comparisons between groups. They are saved in the alignment JSON with **Save data**, and can be published as linked data to a [Solid Pod](https://solidproject.org).

### Creating and editing an annotation

Open the annotation drawer with the **pencil** button on the right edge. The annotation ribbon along the bottom lists the loaded annotations, with a search box.

1. Click **+ New** in the ribbon to create an annotation. It opens in **Edit** mode.
2. Give it a **title**, a **colour**, and a **description**.
3. **Select recordings** by clicking their waveforms. A selected recording shows a ✓; click it to remove the recording again.
4. **Draw regions** by dragging on a waveform. A region appears at the same musical moment on every selected recording; drawing on a recording that isn't selected yet adds it.
   - Drag a region's edges or body to adjust it; the change follows the alignment on every recording.
   - Hold **Shift** while dragging for a **local adjustment** to that one recording.
5. Add **notes** on each recording, **group notes** on each group of recordings, and **comparisons** between two groups. The annotation keeps its own copy of the grouping it was made with; **Update groups to current view** adopts the current grouping later.

Switch to **View** mode to read an annotation. Clicking an annotation card jumps to the start of its first region and plays; cards light up in their colour while the playhead is inside one of their regions. When zoomed, arrows on each waveform lead to regions that are off-screen.

When you [correct an alignment](#correcting-an-alignment), annotation regions follow: each region remembers the recording it was drawn on (or, for annotations from mei-friend, the score notes it covers) and is placed again through the corrected alignment. Local adjustments stay as they are. Annotations saved before version 0.107.0 don't carry this information and are not moved.

### Sharing annotations on Solid

Sign in to your Solid Pod from the bottom of the annotation drawer (the sign-in opens in a popup, so your loaded audio stays put).

- **Post to Solid** publishes the selected annotation to your pod, using the [Music Annotation Ontology](https://doi.org/10.1145/3543882.3543891) and Web Annotations. **Update on Solid** pushes later edits. Recordings are identified by their audio URIs, set under _Manage recordings → Linked Data URIs_.
- **Make public / Make private** sets who can read a posted annotation. New annotations are private.
- **Load from Solid** lists the annotations on your pod that involve the loaded recordings. From there you can load them, delete them from your pod, or **Tidy up** list entries whose annotation was already deleted. You can also load a specific annotation by its MusicalMaterial URI, including other people's public annotations.
- Annotations created in [mei-friend](https://mei-friend.mdw.ac.at) against the score load too, and are projected onto every aligned recording.
- Annotations outside your own pod can be read, but never updated or deleted from Listen Here!.

**What does posting publish?** Only structured linked data: the time intervals of each selection, your texts, and (optionally) a compact waveform envelope that lets the waveform shape be displayed publicly. **No playable audio is ever uploaded.**

---

## Correcting an alignment

Automatic alignment is good but not perfect. When the alignment includes a score, **Correct alignment…** (under Tools) opens a correction screen. It offers two steps:

1. **The score against the reference recording.**
2. **Each other recording against the reference**, available once step 1 has been opened (or skipped).

The correction screen shows the score above a strip with the recording's waveform, with optional **spectrogram** and **onset** lanes beneath. Ticks on the strip mark where each score event currently falls. During playback, the left ear hears the recording and the right ear a synthesised rendering of the score, so you can hear where the two part ways.

- **Drag a tick** to where the note really is. It becomes an **anchor**, and the alignment ahead of it is recomputed up to the next anchor or the **Reach** horizon. **Bend** sets how far the ticks behind follow it. With **Magnet on drag**, a dragged tick snaps to nearby detected onsets.
- **`Left`/`Right`** step between onsets; **`Shift` + `Left`/`Right`** nudge the selected tick (add **`Alt`** for finer steps). **`Up`/`Down`** turn the score page.
- **`Enter`** anchors the selected tick where it stands, or unanchors it; **`Backspace`/`Delete`** unanchors it.
- **`S`** moves the selected ticks to the nearest detected onset; **`A`** selects all ticks on the page.
- **`G`** marks the audio after the selected onset as **unscored** (applause, a pause, an unwritten repeat), so nothing is aligned across it.
- **`R`** replays the last fix. With **Re-align automatically** turned off, fixes only pin their ticks and **`Shift` + `R`** re-aligns the spans that are waiting.
- **`+`/`-`** zoom the score; **`Escape`** or the **×** returns to the listening view.

Every correction can be undone and redone, and **Revert alignment edits** restores the original alignment. Corrections are saved in the alignment JSON with **Save data** and resumed when the file is loaded again. The listening view, the tempo curve, and annotation regions all follow the corrected alignment.

---

## Adding recordings to an alignment

To add recordings to an alignment you have already made, open **Manage recordings → Add Recordings** and pick or drop the new audio files. They are aligned to the existing reference and join the session without a reload. Nothing already aligned changes, including the score alignment and any corrections.

The settings default to those of the original alignment run, where the file records them; **Restore original alignment settings** puts them back if you change them. In a local-files session, the reference recording's audio is needed too, and the tab asks for it.

---

## Unsaved work and recovery

Listen Here! keeps a copy of your unsaved work in your browser: markers, groupings, and annotations are saved locally a moment after each change. If you close or reload the tab with unsaved work, the browser asks first. When you next load the same piece, the app offers the unsaved work back: **Restore**, **Discard**, or **Not now**. The file picker also lists unsaved work from earlier sessions.

- Corrections and added recordings are not part of this copy; save them with **Save data**.
- Copies older than 30 days, or beyond the newest 20, are discarded.
- **Save data** is still the way to keep your work: the copy lives only in this browser.

---

## Alignment parameters

The alignment wizard exposes several parameters that control how the DTW (Dynamic Time Warping) chroma alignment is computed. The three presets set sensible combinations; you can also adjust each value individually.

| Parameter          | Fast     | Balanced | High quality | Description                                                                                                                                          |
| ------------------ | -------- | -------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Coarse resolution  | 4        | 2        | 2            | How much to downsample audio for the initial structural pass. Lower values are more precise but slower.                                              |
| Search flexibility | 80       | 120      | 160          | How far (in frames) the fine alignment can deviate from the structural estimate. Wider values are more forgiving of large tempo changes, but slower. |
| Feature rate       | 10 Hz    | 10 Hz    | 20 Hz        | How many chroma analysis frames are computed per second of audio. Higher rates capture fast passages more accurately but increase processing time.   |
| Score resolution   | 2 (half) | 1 (full) | 1 (full)     | Downsampling factor for score-to-performance alignment. Only applies when an MEI URI is provided. 1 = full resolution, slower but more accurate.     |

All settings are saved in your browser and restored the next time you open the wizard. The values used are always written into the output file (`header.alignmentParams`) for reproducibility.

---

## Technical & Advanced Usage

### CORS requirements for remote audio

Listen Here! needs [CORS](https://developer.mozilla.org/en-US/docs/Web/HTTP/CORS) headers on any remote server it loads audio or alignment files from. The browser fetches and decodes audio itself (for waveform rendering and audio normalisation), and blocks the fetch without CORS. If you control the server, ensure it sends at least:

```
Access-Control-Allow-Origin: *
```

The bundled `serve_local.py` script already includes this header.

### Serving audio from your local machine

If your audio files are on your computer but you prefer a local file server (e.g., when publishing linked data about audio files that cannot be put online for copyright reasons), use the `useLocal` parameter with the included `serve_local.py` script:

1. Start a local file server pointing at the directory containing your audio files:
   ```bash
   python3 serve_local.py /path/to/your/audio/files 8080
   ```
2. Open Listen Here! with the `useLocal` parameter appended:
   `https://listen-here.mdw.ac.at/?align=<URL_of_your_alignment_JSON>&useLocal=http://localhost:8080`

When `useLocal` is specified, the tool takes only the filename from each audio key in the alignment file and loads it from your local server. `serve_local.py` accepts any directory path and an optional port (default: 8080).

### Alignment JSON format

This section covers what you need to use Listen Here! alignments and annotations in other tools. Other fields in the file (groupings, correction records, run provenance) are Listen Here!'s own bookkeeping and can be ignored.

```json
{
  "header": {
    "ref": "VPO-2005.wav",
    "meiUri": "https://example.org/score.mei",
    "label": "Donauwalzer",
    "markers": [1520, 8410],
    ...
  },
  "body": {
    "audio": {
      "VPO-2005.wav": {
        "times": [0.0, 0.02, 0.04, ...],
        "duration": 698.25,
        "alignedFrom": 4.60,
        "alignedTo": 555.20,
        "peaks": [...]
      },
      "NYP-1982.wav": { "times": [0.0, 0.0, 0.01, ...], ... }
    },
    "score": {
      "score_onset": [0, 0.125, 0.25, ...],
      "ref_onset": [4.60, 4.66, 4.73, ...],
      "score_offset": [...],
      "ref_offset": [...]
    }
  },
  "annotations": [ ... ]
}
```

**The alignment grid.** `body.audio` has one entry per recording, keyed by URL or filename. `header.ref` names the reference recording. All `times` arrays have the same length: entry *i* of every array is the same musical moment, given in seconds of that recording. In alignments made by Listen Here!, the reference's own `times` run on a regular 20 ms grid. So to find where reference time *t* falls in another recording, look up index *t* / 0.02 in that recording's `times` (interpolating between entries as needed). A recording's entry may also be a bare array of times, without the other fields.

- `alignedFrom` / `alignedTo` (optional) bound the part of a recording that is aligned; outside it (applause, tuning) grid values are not meaningful.
- `duration` is the recording's length in seconds; `peaks` is an optional waveform envelope for display.

**The score alignment** (`body.score`, present when `header.meiUri` is): parallel arrays, one entry per score event. `score_onset` / `score_offset` are positions in the score in quarter notes; `ref_onset` / `ref_offset` are the corresponding times in seconds in the reference recording. Combine with the grid to place a score event in any other recording. (`synth_onset` / `synth_offset`, if present, are times in Listen Here!'s synthesised score audio.)

**Markers** (`header.markers`) are indices into the grid.

**Annotations** (`annotations`, top level) are an array of objects with `id`, `label`, `color`, `description`, `regions` (each with an `id`), and `targets`: one per recording, with its `file` (a key of `body.audio`), its `description` (the per-recording note), and `regionTimes`, which maps each region `id` to `{start, end}` in seconds of that recording. Group notes and comparisons refer to the annotation's own copy of the grouping (`pinnedGrouping`). The format version is `schemaVersion`.

Annotations posted to Solid follow the [Music Annotation Ontology](https://doi.org/10.1145/3543882.3543891) (`mao:MusicalMaterial` → `mao:Extract` → one `mao:Selection` per recording, with media-fragment time intervals) plus [Web Annotations](https://www.w3.org/TR/annotation-model/) for the texts. They can be read from a pod without Listen Here!.

Alignment JSON files can be generated using the tool's in-browser alignment, or offline using the [SSV alignment workflow](https://github.com/signature-sound-vienna/alignment), based on [SyncToolbox](https://github.com/meinhardmueller/synctoolbox). Score alignments from that workflow are converted when loaded.

### Running locally (Development)

To run Listen Here! locally for development, with pip:

```bash
pip install -r requirements.txt
flask run
```

or with [uv](https://docs.astral.sh/uv/):

```bash
uv venv
uv pip install -r requirements.txt
uv run flask run
```

Then visit `http://localhost:5000/`.

The end-to-end tests use [Playwright](https://playwright.dev): `npm install`, then `npm test` (with the Flask server running, or Playwright starts it).
