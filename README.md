# Listen Here!

<img src="/app/static/bat/ListenHereBat.png" width="150" alt="Listen Here!">

Tool for machine-assisted close listening. Please see: [Weigl et al (DLfM '23)](https://doi.org/10.1145/3625135.3625144) for a detailed description.

This tool is development as part of the [Signature Sound Vienna (SSV)](https://iwk.mdw.ac.at/signature-sound-vienna) [FWF P 34664-G](https://doi.org/10.55776/P34664) and [Vienna's New Year's Concerts: Same procedure as every year?](https://iwk.mdw.ac.at/same-procedure) [FWF SCP 1556025](https://doi.org/10.55776/SCP1556025) projects, funded by the Austrian Science Fund.

## Using the public instance

Listen Here! is publicly hosted at **https://listen-here.mdw.ac.at**.

To use it with your own aligned audio, you need:

1. An **alignment JSON file** hosted at a publicly accessible URL (see [Alignment JSON format](#alignment-json-format) below).
2. **Audio files** hosted on a web server — either publicly, or on your local machine.

### Basic usage

Point your browser to:

```
https://listen-here.mdw.ac.at/?align=<URL_of_your_alignment_JSON>
```

The tool will fetch and validate your alignment JSON, then load the listen interface. Audio files are referenced by the URLs specified as keys in the alignment JSON and are fetched directly by your browser (never by the server).

### Serving audio from your local machine

If your audio files are on your local computer rather than on a public server, you can use the `?useLocal` parameter together with the included `serve_local.py` utility.

1. Start a local file server pointing at the directory containing your audio files:

   ```
   python3 serve_local.py /path/to/your/audio/files 8080
   ```

2. Open Listen Here! with the `useLocal` parameter:

   ```
   https://listen-here.mdw.ac.at/?align=<URL_of_your_alignment_JSON>&useLocal=http://localhost:8080
   ```

   When `useLocal` is specified, the tool extracts only the filename from each audio key in the alignment JSON and loads it from your local server instead. If you omit the URL value (i.e., just `&useLocal`), it defaults to `http://127.0.0.1:8080`. This behaviour is useful when publishing Linked Data about audio files that cannot be put online, e.g., for copyright reasons.

> **Note:** `serve_local.py` is a minimal CORS-enabled HTTP file server. It accepts any local directory path (absolute or relative) and an optional port number (default: 8080).

## Alignment JSON format

The alignment JSON must follow this structure:

```json
{
  "header": {
    "ref": "<URL of the reference audio>",
    "meiUri": "<URI of MEI encoding (optional, required if score is provided)>"
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
- **`body.score`** (optional): score-to-performance alignment arrays. If provided, `header.meiUri` must also be supplied (and vice versa).

Alignment JSON files can be generated using the [SSV alignment workflow](https://github.com/signature-sound-vienna/alignment).

## Running locally

To run Listen Here! locally for development:

```bash
pip install -r requirements.txt
flask run
```

Then visit `http://localhost:5000/?align=<alignment_URL>`.

## Annotations

Use [mei-friend](https://mei-friend.mdw.ac.at) to generate compatible MEI annotations within your [Solid Pod](https://solidproject.org), using the Music Annotation Ontology data model described in [Lewis et al. (DLfM 2022)](https://doi.org/10.1145/3543882.3543891).
