# Listen Here!

<img src="/app/static/bat/ListenHereBat.png" width="150" alt="Listen Here!">

_Listen Here!_ is a tool that lets you seamlessly compare and switch between different audio recordings of the same piece of music. It provides a machine-assisted close listening interface.

For a detailed description, please see: [Weigl et al (DLfM '23)](https://doi.org/10.1145/3625135.3625144).

This tool is developed as part of the [Signature Sound Vienna (SSV)](https://iwk.mdw.ac.at/signature-sound-vienna) [FWF P 34664-G](https://doi.org/10.55776/P34664) and [Vienna's New Year's Concerts: Same procedure as every year?](https://iwk.mdw.ac.at/same-procedure) [FWF SCP 1556025](https://doi.org/10.55776/SCP1556025) projects, funded by the Austrian Science Fund.

> **🔒 Your audio is never uploaded.** Whether you load files from your computer or stream them from the web, all audio processing — including alignment, playback, and waveform rendering — happens entirely in your web browser. Audio is fetched directly into your browser and is never sent onward to Listen Here! or any other server. This is particularly important when working with copyrighted recordings.

## Getting Started

Listen Here! is publicly hosted and runs directly in your web browser at **https://listen-here.mdw.ac.at**.

To use the tool, you need two things:

1. An **alignment JSON file** (a mapping file that tells the app how the different audio recordings match up in time). You can generate this mapping within the tool using the "Align in browser" feature.
2. A collection of **audio files** that you want to compare. You can load these files directly from your computer or from a web server.

There are a few ways to load your audio into the application:

### 1. Loading audio directly from your computer (Easiest)

You can load audio files directly from your computer using your browser's built-in file picker. This requires no installation or server setup, and your audio data stays entirely on your device.

1. Go to the start page at **https://listen-here.mdw.ac.at** and click **Local files**.
2. Alternatively, visit this link directly:
   `https://listen-here.mdw.ac.at/?align=<URL_of_your_alignment_JSON>&useFiles`
3. The tool will show an overlay listing the audio recordings referenced by the alignment file. You can then:
   - **Choose a folder** to automatically match all audio files inside it.
   - **Choose individual files** to select specific audio recordings.
   - **Drag and drop** audio files directly onto the overlay.
   - Optionally, switch to the **Linked Data URIs** tab to configure how linked-data annotations will be targeted - see [Annotations (Linked Data)](#annotations-linked-data) below.
4. You can reopen this overlay at any time by clicking the **Manage files** button in the toolbar.

### 2. Using hosted audio files (Basic Usage)

If your audio files are already hosted on a web server, you can point the app to load them automatically.

1. Go to the start page at **https://listen-here.mdw.ac.at**.
2. Paste the URL of your alignment JSON file into the form and click **Load**.
3. Alternatively, visit this link directly:
   `https://listen-here.mdw.ac.at/?align=<URL_of_your_alignment_JSON>`

The app will read the alignment JSON file, which contains the web addresses (URLs) for your audio files, and your browser will fetch them directly. Loading from authenticated servers is supported using HTTP Basic Authentication.

### 3. Creating a new alignment in your browser

If you don't have an alignment JSON file yet, you can create one directly in the app! The alignment runs entirely in your browser; your audio files are never uploaded to any server.

1. Go to the start page at **https://listen-here.mdw.ac.at** and click **Align in browser**.
2. Alternatively, visit this link directly:
   `https://listen-here.mdw.ac.at/?mode=align`
3. A step-by-step wizard guides you through the process:

   **Step 1 — Files:** Select or drag-and-drop the audio files you want to align. You need at least two. The longest file is automatically chosen as the reference, but you can change this using the radio buttons in the file table.

   **Step 2 — Quality:** Choose an alignment quality preset:
   - **Fast** — good quality, quickest results. Best for previewing or working with many files.
   - **Balanced** (recommended) — better precision, a little slower.
   - **High quality** — best precision, slower. Best for final or archival alignments.

   You can also expand **Advanced parameters** to fine-tune individual settings (see [Alignment parameters](#alignment-parameters) below). Changing a value switches automatically to "Custom" mode; you can reset back to a preset at any time. Your quality settings are remembered across sessions.

   **Step 3 — URIs** (optional): Provide a **MEI URI** if you want to include score–performance alignment. You can also set an **Audio URI prefix** to embed linked-data identifiers in the output.

   **Step 4 — Align:** Review a summary of your choices, optionally enable pre-calculated waveform peaks (speeds up later load times at the cost of a slightly larger file), then click **Start Alignment**. A progress display shows each step in real time.

4. You can click any completed step in the indicator bar at the top to jump back and adjust settings before starting.
5. After alignment completes, you can click **Save data** to download the alignment JSON file, or click **Listen!** to transition seamlessly into the listening interface — no page reload required. Your audio stays loaded and ready to play.

---

## Using the listening interface

Once your audio files and alignment are loaded, the listening interface allows you to seamlessly switch between different recordings of the same piece during playback.

### Basic Features

- **Sidebar**: Toggle which audio recordings are visible by checking/unchecking them in the left sidebar.
- **Playback**: Use the play/pause button or the **Spacebar** to toggle playback. Click anywhere on a waveform to jump to that timestamp across all synced recordings.
- **Switching Audio**: Click on a recording's name in the sidebar, or use the **Up/Down Arrow** keys to change which audio recording is currently active and audible.
- **Toolbar Options**: You can toggle waveform normalization, visualize alignment points, or show relative positions using the checkboxes in the sidebar toolbar. The toolbar also features a **Save data** button, which displays an orange dot (change indicator) whenever there are unsaved modifications to the alignment JSON (such as new marker locations or grouped files).

### Keyboard Shortcuts

- **`Spacebar`** - Play/Pause
- **`Up`/`Down` Arrow** - Switch between previous/next visible waveforms
- **`Left`/`Right` Arrow** - Seek backwards/forwards by 10 seconds. Hold `Shift` for 5 seconds, or `Shift + Alt` for 1 second increments.
- **`1` - `9` and `0`** - Quickly jump to the 1st through 10th loaded waveform.
- **`Alt` + `1` - `9` and `0`** - Numbered badges will appear over the visible waveforms, allowing you to quickly jump to the first ten waveforms currently on screen (which change depending on your scroll position).
- **`M`** - Drop a marker at the current playback position.

### Close-Listening Mode

Close-listening mode allows targeted navigation between specific markers you've dropped.

- Press **`C`** to toggle close-listening mode on or off.
- Use the **`Left`/`Right` Arrow** keys to immediately snap playback to the previous or next marker.
- Hold **`Shift` + `Left`/`Right` Arrow** to precisely nudge the selected marker's position (100ms, or hold **`Alt`** for 20ms).
- Press **`Backspace` / `Delete`** to delete the currently selected marker.

### Zoom

The zoom slider in the Settings panel lets you magnify all waveforms simultaneously (up to 50x) for detailed analysis, and alignment inspection and correction.

- When zoomed, waveforms become horizontally scrollable. Scrolling one waveform automatically scrolls all others to the corresponding aligned position.
- Three **scroll modes** appear when zoomed (selectable via radio buttons below the slider):
  - **Page** — the view jumps when the playhead reaches the edge of the visible area (default).
  - **Follow** — the playhead stays centred during playback.
  - **Manual** — no automatic scrolling; scroll freely by hand.
- The **alignment grid** ("Visualise alignments") scales with zoom: more grid lines become visible at higher magnification, up to the grid's native resolution (at 20 ms in the reference audio).

### File Grouping

When many recordings are loaded, you can organise them into named groups for easier navigation.

- Click the **Group files** button in the toolbar to open the grouping modal.
- The modal has two panes: **Ungrouped Files** on the left and **Groups** on the right.
- Click **+ New Group** to create a group. Give it a name and optionally a substring or regex pattern to auto-match filenames.
- **Drag and drop** files from the ungrouped list into a group, or use the remove button (✕) to move them back.
- Groups can be **reordered** (▲/▼), **renamed**, or **deleted**.
- Click **Apply** to save. Groups are persisted in your browser's localStorage and restored automatically on future visits.
- The sidebar displays groups in order: Score (if present), then your groups, then any ungrouped recordings.

### Annotations (Linked Data)

If you are logged into a [Solid Pod](https://solidproject.org), you can create and manage linked-data annotations using the Music Annotation Ontology.

#### Getting started

- Click the **RDF logo** button in the toolbar to open the Linked Data drawer and log in. Login opens in a popup window, so your loaded audio and waveforms are preserved — no page reload.
- You can also load annotations from any publicly accessible URL by pasting it into the **Load annotations** input at the bottom of the Linked Data drawer — no Solid login required.

#### Creating a new annotation

Once logged in, a **+ New Annotation** button appears at the bottom of the interface. Clicking it creates a **draft card** — a workspace where you build up an annotation before posting it.

1. **Give it a label.** Type a name into the text field at the top of the card.
2. **Draw regions.** Click **Draw Regions** to enter drawing mode — your cursor changes and you can click-and-drag on any waveform to mark a time region. Each region appears as a coloured overlay across all synchronised recordings. Click **Stop Drawing** when you are done. You can draw multiple regions per annotation.
   - Regions can be **resized or repositioned** by dragging their edges or body. By default, adjustments snap to the alignment grid so all recordings stay in sync.
   - Hold **Shift** while dragging to make a **local override** — an adjustment that applies only to that specific recording's waveform.
   - Each region is listed on the card with a **delete** button (✕) to remove it.
3. **Select recordings.** Click **Select Recordings** to enter selection mode. Overlay icons appear on each waveform — click them to **stage** (or unstage) recordings you want to include in the annotation. A counter shows how many are selected.
4. **Include peaks** (optional). The "Include peaks" checkbox (on by default) attaches a compact waveform envelope so the waveform shape can be displayed publicly without sharing any playable audio.
5. **Post to Solid.** Click **Post to Solid** to publish the annotation to your Solid Pod. The button is disabled until you have selected at least one recording with a valid audio URI (set via _Manage files → Linked Data URIs_).
6. **Discard.** Click the **✕** in the card header to discard a draft at any time.

You can have multiple draft cards open simultaneously; each is assigned a distinct colour so its regions are easy to identify on the waveforms.

#### Working with existing annotations

- Annotation cards appear pinned at the bottom of the interface. Each card has a **Play** button to loop the annotated region. Loop playback automatically transfers when you switch between waveforms.
- Use **Select Recordings** on a card to enter selection mode: click waveform overlays to stage recordings, then **Post to Solid** to save.
- Use **Describe** on a card to add a textual description (posted as a Web Annotation to your Solid Pod).
- Use **Primal** to open the Primal interface, which identifies the original recording used when creating the annotation.
- Click the **✕** button on a card to unload it from the interface.

**What does "Post to Solid" publish?** Only structured linked-data annotations are posted: timeline interval descriptions (start/end times) identifying selections within recordings, and (if the "Include peaks" option is checked) a compact waveform envelope that allows the waveform shape to be displayed publicly. **No playable audio data is ever uploaded.** Audio content never leaves your browser.

---

## Alignment parameters

The alignment wizard exposes several parameters that control how the DTW (Dynamic Time Warping) chroma alignment is computed. The three built-in presets set sensible combinations; you can also adjust each value individually.

| Parameter          | Fast     | Balanced | High quality | Description                                                                                                                                                                            |
| ------------------ | -------- | -------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Coarse resolution  | 4        | 2        | 2            | How much to downsample audio for the initial structural pass. Lower values are more precise but slower.                                                                                |
| Search flexibility | 80       | 120      | 160          | How far (in frames) the fine alignment can deviate from the structural estimate. Wider values are more forgiving of large tempo changes, but slower.                                   |
| Feature rate       | 10 Hz    | 10 Hz    | 20 Hz        | How many chroma analysis frames are computed per second of audio. Higher rates capture fast passages more accurately but increase processing time.                                     |
| Score resolution   | 2 (half) | 1 (full) | 1 (full)     | Downsampling factor for score-to-performance alignment. Only applies when an MEI URI is provided. 1 = full resolution, slower but more accurate.                                       |
| Onset emphasis     | 2.0      | 2.0      | 2.0          | How strongly note attacks in the score are emphasised during alignment. Higher values anchor the alignment more firmly to clear note onsets. Only applies when an MEI URI is provided. |

**Choosing a preset:**

- Use **Fast** when you want a quick preview or are working with a large number of files.
- Use **Balanced** (the default) for most situations — it offers noticeably better precision with only a modest speed trade-off.
- Use **High quality** when precision matters most, for example when producing a final or archival alignment.

All settings are saved in your browser and restored automatically the next time you open the wizard. If the "Include alignment settings in output" checkbox is enabled (on by default), the chosen parameter values are written into the `header.alignmentParams` field of the output JSON for reproducibility.

---

## Technical & Advanced Usage

### CORS requirements for remote audio

Listen Here! needs [CORS](https://developer.mozilla.org/en-US/docs/Web/HTTP/CORS) headers on any remote audio server. The tool fetches and decodes audio in the browser (for waveform rendering and for the "Normalize audio" feature, which routes playback through a Web Audio `GainNode`). Without CORS, the browser will block the fetch request and the audio will fail to load.

If you control the server, ensure it sends at least:

```
Access-Control-Allow-Origin: *
```

The bundled `serve_local.py` script already includes this header.

### Serving audio from your local machine

If your audio files are on your local computer but you prefer to use a local file server (e.g., when publishing Linked Data about audio files that cannot be put online for copyright reasons), you can use the `?useLocal` parameter along with the included `serve_local.py` script.

1. Start a local file server pointing at the directory containing your audio files:
   ```bash
   python3 serve_local.py /path/to/your/audio/files 8080
   ```
2. Open Listen Here! with the `useLocal` parameter appended:
   `https://listen-here.mdw.ac.at/?align=<URL_of_your_alignment_JSON>&useLocal=http://localhost:8080`

When `useLocal` is specified, the tool extracts only the filename from each audio key in the alignment file and loads it from your local server.

> **Note:** `serve_local.py` is a minimal CORS-enabled HTTP file server. It accepts any local directory path (absolute or relative) and an optional port number (default: 8080).

### Alignment JSON format

The alignment file tells the app how recordings relate in time. It follows this structure:

```json
{
  "header": {
    "ref": "<URL or filename of the reference audio>",
    "meiUri": "<URL of MEI encoding (optional, for score alignment)>",
    "linkedDataUriPrefix": "<URI prefix for linked-data annotations (optional)>",
    "createdBy": "Listen Here! v0.13.0",
    "createdAt": "2026-03-15T12:00:00.000Z",
    "alignmentParams": {
      "coarse": 2,
      "slack": 120,
      "featureRate": 10,
      "scoreDownsample": 1,
      "onsetWeight": 2.0
    }
  },
  "body": {
    "audio": {
      "<audio_key_1>": [0.0, 0.02, 0.04, ...],
      "<audio_key_2>": [0.0, 0.03, 0.05, ...],
      ...
    },
    "score": {
      "score_onset": [0.0, 0.5, 1.0, ...],
      "ref_onset": [0.0, 0.48, 0.97, ...],
      "score_offset": [0.25, 0.75, 1.25, ...],
      "ref_offset": [0.24, 0.73, 1.22, ...]
    }
  }
}
```

When **peaks** are included (the default), each audio entry becomes an object instead of a plain array:

```json
"<audio_key>": {
  "times": [0.0, 0.02, 0.04, ...],
  "peaks": [0.12, 0.45, 0.87, ...],
  "duration": 423.576
}
```

#### Header fields

| Field                 | Required            | Description                                                                                                                                                                             |
| --------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ref`                 | yes                 | Must match one of the keys in `body.audio`. Identifies the reference recording.                                                                                                         |
| `meiUri`              | if score is present | URL of the MEI encoding used for score–performance alignment.                                                                                                                           |
| `linkedDataUriPrefix` | no                  | A URI prefix prepended to audio filenames when constructing linked-data annotation targets.                                                                                             |
| `createdBy`           | no                  | Tool name and version that generated the file. Added automatically by Listen Here!                                                                                                      |
| `createdAt`           | no                  | ISO 8601 timestamp of when the alignment was created.                                                                                                                                   |
| `alignmentParams`     | no                  | The DTW parameter values used to produce the alignment (see [Alignment parameters](#alignment-parameters)). Included when the "Include alignment settings in output" option is enabled. |

#### Body fields

| Field        | Required | Description                                                                                                                                                                                             |
| ------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `body.audio` | yes      | Each key is a URL or filename identifying an audio recording. The value is either an array of alignment times (in seconds), or an object with `times`, `peaks`, and `duration` when peaks are included. |
| `body.score` | no       | Score-to-performance alignment arrays (`score_onset`, `ref_onset`, `score_offset`, `ref_offset`). Requires `header.meiUri`.                                                                             |

Alignment JSON files can be generated using the tool's in-client alignment feature, or offline using the [SSV alignment workflow](https://github.com/signature-sound-vienna/alignment), based on [SyncToolbox](https://github.com/meinhardmueller/synctoolbox).

### Running locally (Development)

To run Listen Here! locally for development:

```bash
pip install -r requirements.txt
flask run
```

Then visit `http://localhost:5000/?align=<alignment_URL>`.

### Annotations

Use [mei-friend](https://mei-friend.mdw.ac.at) to generate compatible MEI annotations within your [Solid Pod](https://solidproject.org), using the Music Annotation Ontology data model described in [Lewis et al. (DLfM 2022)](https://doi.org/10.1145/3543882.3543891).
