# Listen Here!

<img src="/app/static/bat/ListenHereBat.png" width="150" alt="Listen Here!">

*Listen Here!* is a tool that lets you seamlessly compare and switch between different audio recordings of the same piece of music. It provides a machine-assisted close listening interface.

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
3. Follow the on-screen instructions to select your audio files.
4. (Optional) Check "Include pre-calculated waveform envelope (peaks)" before generating. This significantly speeds up load times when opening the listening interface later, at the cost of a slightly larger alignment file.
5. Generate your new alignment, which you can then save and use for listening.

---

## Using the listening interface

Once your audio files and alignment are loaded, the listening interface allows you to seamlessly switch between different recordings of the same piece during playback.

### Basic Features
- **Sidebar**: Toggle which audio recordings are visible by checking/unchecking them in the left sidebar.
- **Playback**: Use the play/pause button or the **Spacebar** to toggle playback. Click anywhere on a waveform to jump to that timestamp across all synced recordings.
- **Switching Audio**: Click on a recording's name in the sidebar, or use the **Up/Down Arrow** keys to change which audio recording is currently active and audible.
- **Toolbar Options**: You can toggle waveform normalization, visualize alignment points, or show relative positions using the checkboxes in the sidebar toolbar.

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
- Click the **RDF logo** button in the toolbar to open the Linked Data drawer and log in.
- Annotation cards appear pinned at the bottom of the interface. Each card has a **Play** button to loop the annotated region.
- Use **Select Recordings** on a card to enter selection mode: click waveform overlays to stage recordings, then **Post to Solid** to save.
- Loop playback automatically transfers when you switch between waveforms during annotation.

**What does "Post to Solid" publish?** Only structured linked-data annotations are posted: timeline interval descriptions (start/end times) identifying selections within recordings, and (if the "Include peaks" option is checked) a compact waveform envelope that allows the waveform shape to be displayed publicly. **No playable audio data is ever uploaded.** Audio content never leaves your browser.

If you are loading annotations from a publicly accessible Web location, logging in to Solid is not required. You will not be able to post selections, however.

---

## Technical & Advanced Usage

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
The mapping file tells the app how recordings relate. It must follow this structure:

```json
{
  "header": {
    "ref": "<URL of the reference audio>",
    "meiUri": "<URL of MEI encoding (optional, required if score is provided)>"
  },
  "body": {
    "audio": {
      "<audio_URL_1>": [0.0, 0.02, 0.04, ...],
      "<audio_URL_2>": [0.0, 0.03, 0.05, ...],
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

- **`header.ref`** (required): must match one of the keys in `body.audio`.
- **`body.audio`** (required): each key is a URL (or filename) identifying an audio recording; its value is an array of alignment times (in seconds).
- **`body.score`** (optional): score-to-performance alignment arrays. If provided, `header.meiUri` must also be supplied.

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
