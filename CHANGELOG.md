# Listen Here! CHANGELOG.md

### 0.11.0
* Add "Describe" button on annotation cards to post textual Web Annotations (OA) targeting MusicalMaterial resources on Solid
* Add "Open in Primal" button linking to the posted Web Annotation in the Primal viewer
* Optionally allow 'peaks' to be included within MAO:Selections to enable viewing in Primal (if not otherwise available)

### 0.10.0
* Add dynamic file grouping: users can organise recordings into named, reorderable groups via a dual-pane modal with drag-and-drop and regex matching, persisted to localStorage
* Improve annotation workflow with Solid-backed linked-data annotations: selection mode, loop playback across waveform switches, annotation cards pinned at the bottom of the interface
* Fix Solid URI doubling and 412 retry storm when patching resources
* Score waveform now always sorted first in the waveform list and sidebar

### 0.9.1
* Comprehensively update documentation and landing page for better clarity and accessibility

### 0.9.0
* Upgrade to WaveSurfer v7 ESM with vendored local copies of all external dependencies (wavesurfer, regions, hover plugins)
* Localise all external JS dependencies (Solid, JSON-LD, fast-json-patch) to avoid CDN reliance
* Merge alignment and listening into a single page — audio decoded for alignment is handed directly to the listen view without page reload or re-fetching
* Extract alignment logic into ES module (align.js) shared with listen.js
* New `/?mode=align` entry point; `/align` now redirects there
* Remove spectrogram display (performance issues with long audio; vendor files kept for future use)

### 0.8.0
* Implement in-browser score synthesis and alignment
* Fix resize behaviour for alignment and relative position indicators

### 0.7.0
* Implement in-browser alignment functionality
* Implement close-listening mode (marker navigation and interaction via keyboard commands)
* Removed "Jump to marker" checkbox and "Play from last marker" button (close-listening mode supersedes)
* UI and overlay improvements for per-waveform loading, progress, and resize

### 0.6.1 patch
* Implement ?useFiles to allow users to load audio from their local filesystem

### 0.6.0 patch
* Refactor to allow specification of Web-hosted align.json referencing (Web-hosted) audios using ?align=
* Refactor to allow ?useLocal= to allow a server run on localhost (or elsewhere) to overwrite audio URLs from the align.json, e.g., to adequately handle copyright constraints.