# Listen Here! CHANGELOG.md

### 0.25.0
* **Phase-1 engine modularisation.** Large parts of `listen.js` have been pulled out into ten focused modules under `app/static/js/engine/` — zoom & scroll, audio normalisation and the windowed-player lifecycle, playback transport, time-axis ticks, marker rendering and interaction, off-screen region navigation, time measurement, waveform rendering, waveform event wiring, and the alignment/session data seam. Every extraction is behaviour-preserving and was landed only with the full e2e suite green on both browsers. Groundwork for running the listen engine in more than one place (e.g. the museum kiosk as part of 'Same Procedure...?') rather than a feature in itself.
* **A `DataSession` seam** now owns the maps that describe the loaded piece, with `listen.js` aliasing them behind unchanged exports, so state ownership can migrate incrementally instead of in one risky cut.
* **Replacing the loaded piece is now safe (#32).** Loading an alignment whose recordings don't overlap the current ones is recognised as a different *piece*: the app asks first, then either tears the previous session down properly or abandons the load, instead of layering the new piece on top and leaving stale renderers whose alignment grids had been replaced. Piece identity uses the score plus an alignment-grid fingerprint. Re-picking the piece that is already loaded prompts too, but only when there is unsaved work. Both dialogs use the shared confirm shell, the file picker no longer mutates state before asking, and retired object URLs are revoked.
* **Large collections load lazily.** Above twelve recordings, rows are laid out up front and each waveform is built when its row comes within one pane-height of the viewport, behind a small concurrency gate. Deferred rows show a quiet placeholder and a `queued` sidebar state rather than a spinner that would never resolve.
* **The load is now covered visually**: a phased pane spinner, reserved row heights so the page doesn't jump as waveforms arrive, and each row claiming its own spinner immediately.
* Unified the settings drawer so the theme is owned in one place on every page, with `listen.js` keeping only the waveform repaint.
* Removed the dead DH-2023-era timer feature, long superseded by Shift durations, along with its key handlers, timer regions, session fields, and two workarounds.
* Solid discovery denormalises `schema:name` / `dateCreated` to cut HTTP calls, and the listen UI now degrades gracefully when Solid features fail to load (e.g. on very old browsers).
* Swapped the order of the "align" and "listen" buttons.
* Fix: blank waveforms after resizing a zoomed session. `applyZoom` pins WaveSurfer's pixels-per-second to the width it saw, so a later resize kept re-rendering at the stale rate — content wider than its container, a scroll container that stayed scrollable, and a parked scroll offset showing a slice that was never drawn. Waveforms now refit on resize, and a restored scroll position is clamped to the new maximum.
* Fix: zooming in and back out to 1x left some waveforms one pixel wider than their container, so they stayed scrollable and could hold a stale one-pixel horizontal scroll. `applyZoom` fitted each waveform against the duration in the audio file's header, while WaveSurfer sizes its wrapper from the *decoded* buffer's duration — microseconds longer for some recordings, which was enough to round the width up. Fitting against the renderer's own duration removes it; whether a recording was affected depended on the file, which is why it hit some and not others.
* Fix: score-source failures are now reported honestly instead of silently, and a Verovio toolkit that isn't built yet can no longer empty the page mid-load.
* Testing: the e2e suite runs four-up and no longer silently included the performance budget specs, cutting a full run from roughly twelve minutes to four. The score MEI is served from a local fixture rather than GitHub (enforced by a source-invariant check, so no fixture can reintroduce a remote fetch), about 37 s of fixed sleeps were replaced with real load and geometry signals, and browser audio is muted so a background run stays silent.
* Testing: fixed the long-standing flake in the close-listening navigation spec. Drawing a second annotation region re-used the same span as the first, and a pointer-down inside an existing region is claimed by that region rather than starting a new selection, so the second region was intermittently never drawn — the apparent load-sensitivity came from the annotation drawer's 200 ms width animation moving the target between runs.
* Removed the routeless `app.py` stub and the superseded `align.html`; the Playwright config now starts Flask via `wsgi.py`, so suite auto-start works.

### 0.24.0
* Solid annotation discovery improvements (#30)
* Allow reloading of discovery process
* "Load from Solid" while signed out now waits up to 5 minutes for sign-in to complete (was a few seconds), auto-opening the load modal as soon as login finishes. Button icons adjusted to communicate intent ('click on connect'), ('wait for completion'). Also added test coverage for this behaviour.
* Fix annotation playback during close-listening: correctly jump to start-of-region when switching waveforms (rather than switching seamlessly)

### 0.23.0
* Rename Group / Manage files to Group / Manage recordings to avoid confusion (recordings: in app, files: in filesystem)
* Comprehensive improvements to group recordings modal UI: multi-select, make regex less cryptic, drag between groups, drag to create groups, prompt user when exiting modal with unapplied changes
* Annotation editor: Selection groups are now editable after an annotation is created: re-pin, modify, and recover the groups (and any attached notes) of an existing annotation, rather than fixing them at creation time
* Annotation ribbon refinements: replaced the "Annotation" label with the pencil icon (matching the drawer pull) and the "Filter…" field with a compact magnifying-glass search box. Improved styling of annotation cards during overflow. 
* Simplified annotation playback to a single interface: removed the per-card play/pause buttons. Clicking an annotation card now activates it, jumps the playhead to the beginning of its first region, and starts playback. In close-listening mode, if the active jump target is a region beginning, that region loops (back to its start at the region end); switching close-listening off mid-playback lets playback continue past the region end as normal.
* Close-listening left/right marker navigation: widened the backward window (100ms → 800ms) so a quick double-press of Left reliably steps to the previous marker rather than re-selecting the just-reached one. Annotation region beginnings are now also navigable stops (alongside markers).
* Close-listening's "active marker" concept generalised to an "active jump target" that can be a marker *or* any annotation's region start: entering close-listening now activates the closest such target at/before the playhead. When the active target is a region start it's marked with a left border (marker thickness, annotation colour) instead of the marker highlight.
* Annotation cards now highlight during playback: any card whose region currently contains the playhead fades in a wash of the annotation's own colour, fading back out when the playhead leaves (several can light at once when regions overlap). This is visually distinct from the blue "active" ring marking the single annotation open in the editor, which is left in place; a card that is both keeps the ring and the colour wash.
* Disabling close-listening mode no longer moves the playhead: it stays exactly where it was (so playback continues uninterrupted), and waveform switches and left/right arrows revert to the normal, non-close-listening behaviour. Previously exiting reset the playhead to the start.
* Add e2e coverage for the close-listening active-jump-target rework: entering activates an active-annotation region start (left-border indicator + seek), ArrowRight steps from a marker to a region start, and exiting leaves the playhead in place. Plus the new card-driven playback: clicking a card plays from its first region (no per-card buttons), the active region loops at its end in close-listening, and disabling close-listening lets playback continue past the end.
* Fix: drawing an annotation region no longer leaves the waveform dimmed (opacity 0.6) after the editor drawer is closed. Drawing fired the waveform's native HTML5 reorder `dragstart` (adding a `dragging` class) but no `dragend`, so the class stuck; edit mode masked it and closing the drawer revealed it. Native reorder drag is now cancelled while draw mode is active. Affected Firefox in particular, where the existing `-webkit-user-drag` guard has no effect.
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