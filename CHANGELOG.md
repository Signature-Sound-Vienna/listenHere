# Listen Here! CHANGELOG.md

### 0.23.0
* Rename Group / Manage files to Group / Manage recordings to avoid confusion (recordings: in app, files: in filesystem)
* Comprehensive improvements to group recordings modal UI: multi-select, make regex less cryptic, drag between groups, drag to create groups, prompt user when exiting modal with unapplied changes
* Annotation editor: Selection groups are now editable after an annotation is created: re-pin, modify, and recover the groups (and any attached notes) of an existing annotation, rather than fixing them at creation time
* Annotation ribbon refinements: replaced the "Annotation" label with the pencil icon (matching the drawer pull) and the "Filter…" field with a compact magnifying-glass search box. Improved styling of annotation cards during overflow. 
* Fix: play/pause transport icon no longer flips to "Play" mid-playback when arrow-navigating between waveforms across a VBR ↔ non-VBR boundary (stale events from the no-longer-active waveform are now ignored)
* Add e2e coverage for the group recordings modal (multi-select, add-by-filename + regex toggle, remove, fixed height, unapplied-changes prompt, and drag into/between/out-of groups, drag-to-create, hover preview) and for annotation group re-pinning (diff dialog, adopt/cancel, detached-note recovery)

### 0.22.0
* Address visual<->audio mismatches when working with variable bitrate formats
* Send VBR formats through a custom Web Audio player that uses an in-memory frame index to decode 30-second audio chunks on demand, ensuring precise seeking and alignment with visual waveforms.
* Optimize to retain fast audio loading (when peaks pre-rendered) and seamless switching between waveforms even in VBR case
* Add new e2e tests to guard against regressions for new VBR playback

### 0.21.0 
* Comprehensive reworking of annotation functionalities
* New ('V6') annotation UI integrating Solid login / load
* Annotate individual selections, groups of selections, and group comparisons, according to ongoing MAO extension work
* Integrate discovery service UI to find existing relevant annotations in Solid pod.


### 0.20.0
* Streaming alignment: decode → extract chroma → discard raw PCM one file at a time, enabling alignment of very large audio collections (verified against prior method — bit-identical output)
* Off-screen annotation region navigation: clickable left/right arrows appear on each zoomed waveform when annotated regions are off-screen, scrolling the region fully into view with cross-waveform sync
* Tempo curve control now disabled with explanatory tooltip when no score alignment is loaded
* Fix: "Post to Solid" button now becomes enabled after updating linked-data URI prefix
* Fix: waveforms no longer disappear after a zoom-in/zoom-out cycle

### 0.19.0
* Introduce settings drawer
* Add comprehensive theming support (configurable in settings)
* Add e2e unit tests for settings and theme functionalities

### 0.18.0
* Time-axis ticks along the top of each waveform with adaptive density and smart labelling
* Shared time axis mode: all waveforms use the same time scale, with shorter recordings displayed proportionally narrower
* Shift-hold to reveal durations between consecutive markers; Shift+drag to measure arbitrary time spans projected across all aligned waveforms
* Ctrl/Cmd+scroll to zoom in and out over waveforms
* Waveform labels and time-axis tick backgrounds now match their waveform's background colour

### 0.17.0
* Allow styling and reordering of file groups, implement tab groups, persist in alignment JSON
* Persist markers in alignment JSON
* Styling improvements for fix-alignments

### 0.16.0
* Global waveform zoom (1x–50x) with alignment-aware cross-waveform scroll sync
* Three playback scroll modes: Page (jump at edge), Follow (auto-centre), Manual
* Add count indicators and Add/Remove all to file-groups in content pane

### 0.15.0
* Reflect waveform groupings into content pane
* Make waveforms reorderable through click-and-drag in nav bar

### 0.14.0
* Improve styling of navigation menu
* Implement 'drag marker' modes for marker movement and alignment correction
* Expand header of alignment JSON to save file groups, marker placements, URI prefix configs

### 0.13.0
* Popup-based Solid authentication: log in without losing loaded audio, waveforms, or draft state
* Falls back to redirect-based login if the popup is blocked
* Implement alignment configuration wizard
* Write alignment info and other metadata into alignment output

### 0.12.0
* Create MAO annotations directly from the interface: select regions across recordings, group them into Extracts and MusicalMaterials, and post to a Solid pod
* Manage audio Linked Data URIs via a dedicated tab in the file picker, with per-file prefix overrides and live URI preview
* Broaden annotation loading to match any loaded audio URI (not just MEI), with user feedback when annotations are skipped
* Reorganise the file picker into a tabbed layout (Load Files / Linked Data URIs) with backdrop and Escape close support

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