# Listen Here! CHANGELOG.md

### 0.33.0 -- Exhibit readiness: audio preload, player cache, loading grace
* `?preload=on` (default off): after boot, every recording's bytes are fetched sequentially — reference first — so the exhibit is never half-ready for its first visitor; a visitor's tap always outranks the warm loop. Bytes only; players still build on first use.
* `?playerCache=N` (default 2, the shipped LRU): 8 keeps every built player, making all switches permanently instant — kiosk adoption pending the week-4 soak's memory verdict.
* `?loadingGrace=ms` (default 0): "Loading…" appears only after a genuine wait this long, so warm switches never flash it.
* All three in the study panel; the staff "Defaults" preset now carries `preload=on&playerCache=8&loadingGrace=500`.

### 0.32.0 -- Exhibit "parchment" theme
* New `?theme=parchment` preset: aged-paper ground with procedural staining, foxing, grain, and vignette (inline SVG turbulence — no asset, no fetch); iron-gall-ink waveforms on clean untextured lanes; bronze accent; an old-style system serif stack (Iowan/Palatino/Georgia); a historical-pigment annotation series for `?annotationColors=theme`.
* The structured stain layer renders as ONE non-repeating cover image (tiling drummed a visible repeat); only the scale-critical fine grain tiles. Full-screen rasterization cost noted for the iPad/soak watch list.
* Theme machinery: palettes may carry OPTIONAL tokens (`--ex-texture`, `--ex-texture-repeat`, `--ex-texture-size`, `--ex-font`) — absent ones keep the :root defaults, so every existing theme renders byte-identically (35.11's zero-override pin holds).
* Testing: 35.26 pins the optional-token mechanics both ways. 256/2 per browser, green on both.

### 0.31.0 -- Exhibit detail header: the annotation's title, and a jump to its music
* **Title above the commentary** (`?detailTitle=auto|on|off`, auto = playhead mode only): playback-driven switching makes "which annotation am I reading?" forgettable — the shown text now carries its chip's label and colour swatch, pinned above the scrolling text.
* **"Jump to annotation"** (`?detailJump=on|off`, ON everywhere by explicit ruling — manual mode's chips are pure focus controls, so this is the only direct route from a text to its music): makes a recording the annotation targets audible at its earliest region start — the active recording when targeted, else the first targeted strip in stack order; plays if paused. Routed through the turn machine via a new jump request whose time survives a recording switch (and a contended grant); to the fade machinery it is the reader's own seek, so the relevance hold protects the very text they jumped from.
* Both parameters in the study panel.
* Testing: 37.25/37.26 pin the header's two controls, 36.17 pins the jump's kept time across a pending switch; 37.4's synthetic-span plant hardened against re-render races. 255/2 per browser, green on both.

### 0.30.0 -- Exhibit detailFade edge rules: relevance, the reading clock, jump ownership
* **Relevance holds off the fade**: text whose annotation is under the playhead cannot expire — the deadline defers to the region exit, the ring draining toward it (extend-only; switchover at overlaps stays exempt, ring first).
* **The reading clock**: fade windows and pin expiry drain only while the music runs — pause freezes them, play resumes where they stopped (supersedes "paused = natural window only"). Test hook: `_exhibitTest.readingClock.advance(ms)`.
* **Jump ownership**: your own time-jump lands — switching to an annotated landing or starting the "Keep reading…" countdown on unannotated ground (spent windows still get the full warning) — while the other viewport's text is never snatched: countdown first, catch-up after. Recording switches exempt for the jumping side; relevance voids a countdown; pins untouched. Attribution via the turn machine's holder.
* All three folded into `?detailFade` (no new parameters; shipped default `off` untouched).
* Fix: the transport reported a paused player's uncalibrated VBR position (a second-plus off at depth), so a `select()`'s async settle read as a fresh user seek; `_time` is now authoritative while paused.
* Testing: spec 37 grows 20 → 24 (the genuine reading clock, jump ownership across viewports, relevance voiding the countdown, the recording-switch exemption via a payload-derived probe); 37.17–37.19 rewritten to the new semantics. 252/2 per browser, green on both.

### 0.29.0 -- Exhibit playhead-focus feedback round: the agreed definition of "in focus"
* **Focus split into two surfaces** (agreed 2026-08-25): the WASH — all strip-side paint (chip highlight, region emphasis, group edges, deemphasis) — clears when the playhead leaves a region; the DETAIL (commentary and group cards) lingers, so text is never snatched mid-read. A tap-pin holds both regardless of the playhead. By explicit ruling this is now `?focus=playhead`'s default; `?focusWash=sticky` keeps week 3's lingering wash as the A/B comparator.
* **Strip deemphasis**: strips the painted annotation does not target fade — waveform and caption only; background and grouping edge stay. `?focusDim=auto|on|off`; auto (default) dims in playhead mode only, keeping the manual exhibit byte-for-byte shipped.
* **Distinct chip states**: `is-on` for the paint as before, an accent ring on pinned chips, a subtle ring (`is-shown`) anchoring lingering text. Chip states and dimming transition over 200 ms.
* **Union wash at overlaps** (ruled in-round): every annotation with a region under the playhead paints — chips, region emphasis, and deemphasis over the union of their targets — while the detail text and group edges follow the single latest-start winner.
* **Minimum wash hold** `?focusHoldMs=` (default 2500, 0 disables): paint from a region shorter than the bound is held to it, so a sub-frame region cannot blink for one frame; seeks and recording switches drop held paint at once.
* **Pin auto-expiry** `?pinExpiry=off|auto|<ms>` (default off): "auto" derives a reading time from text length, audience pace, and the group story. A "Keep reading…" ring counts down near the deadline, a tap re-arms the full time, and expiry — unlike the × — re-derives the wash immediately.
* **Playback-triggered text fades out** `?detailFade=off|auto|<ms>` (default off — the detail stays sticky): text the wash puts on show lives for its reading window; the ring warns before the end (squeezed when the next region arrives sooner while playing, never below the focusHoldMs floor) and a tap bumps the text to its full window, deferring switches. At the end the text catches up to whatever is relevant, or fades out; under `?sideSlot=annotations` the same machine opens the panel on entry and closes it on fade. Pins are exempt.
* Study panel: the focus tab gains all five parameters, and the footer gains a "Defaults" button — a staff debug preset that resets the whole URL (the shipped defaults and the A/B baseline are untouched).
* Testing: spec 37 grows 9 → 20 (clearing default, sticky comparator, deemphasis, focusDim pins, chip visuals, union at overlaps, hold + discontinuity drop, pin expiry, detailFade lifecycle, both A/B default pins); spec 35 updated to the split state. 244 numbered tests per browser, green on both.

### 0.28.0 -- Exhibit week 3: turn-taking, and the audio arbiter
* **Three turn-taking policies behind one interface** (`?turnPolicy=hijack|attribution|request`) — the central staff-feedback question: two visitors share one clock, so "play my region" takes the room's audio, and the question is what that taking should feel like. `hijack` is the shipped instant switch and stays the default, so the variants remain comparable at the autumn user testing. `attribution` switches just as instantly but tells the side that lost the clock. `request` turns a contended tap — the other side holds the clock and the music is actually playing — into a request the holder answers from their own half ("Go ahead" / "Not yet"), auto-granting after `?turnGrantMs=` (default 8 s; 0 means explicit grants only) so an absent visitor can never lock the table. The holder's own tap while a request stands is the implicit "not yet"; a requester's newer tap replaces their older one; a contended seek keeps the moment the finger pointed at, however much later the grant lands. The prompts and notices render per viewport in that viewport's own language — the middle band stays label-free — and the band's shared play/pause belongs to no side, so it neither takes nor needs the turn.
* **Per-viewport recording selection**: each half now marks its own last-chosen recording with a right-edge accent, independent of the highlight on the audible one. Active is the screen's audible truth; selected is one side's expressed desire — under the request policy they differ for exactly as long as the request is pending, which is how the requester sees what they are waiting for.
* **The `AudioArbiter` in its minimal form** (`arbiter.js`): a claim/revoke interface deciding which *screen* may make sound in the room, as distinct from which visitor holds one screen's clock. The default in-process arbiter is inert on a single screen — no behaviour change — and `?arbiter=broadcast` opts windows of one machine into last-claimant-wins arbitration over a `BroadcastChannel`, the guard a two-screen room will need (plan §2.3's release-required list).
* The study panel grows a Turns tab: policy, auto-grant timeout, notice duration, and arbiter, each one URL parameter away, live-switchable at the table.
* **Playhead-driven focus** (`?focus=playhead`, opt-in; manual taps stay the default): each viewport's focused annotation follows the shared clock through region entries on the audible recording — the exhibit's cousin of the listening interface's card wash, and the driver the chip/× machine was designed to survive. Edge-driven, so it acts only when the annotation under the playhead changes and can never fight a visitor by rewriting focus every frame; sticky, so leaving a region keeps the commentary rather than blanking it mid-read; sweep-aware, so a region narrower than one frame (the 12 ms "D or E?" spans) still raises its entry between two clock samples, while seeks and recording switches count only where they land. A chip tap pins focus against the wash — including re-tapping the focused chip to open the side panel, since reading is engagement — and the machine's unfocus (the below-layout toggle-off, or the side panel's ×) releases the pin, with the wash resuming on the next region entry rather than instantly re-grabbing the region it is still inside. An audience switch re-derives immediately against the new audience's list, per viewport. Containment reads the authored region spans, never the widened display spans.
* Fix: a tap on an annotation chip could be silently eaten if a re-render landed between the finger's down and its up — every render rebuilt all chip elements, so the click fired on the row (the common ancestor of the old and new targets) instead of on any chip. Rare but real on the museum floor, and more likely now that the focus wash re-renders on every region entry; it surfaced as low-rate Firefox test flakes racing the boot-settling resize re-render. Chips are now reconciled in place — same-list renders keep every element and only an audience switch rebuilds the row — and, while in there: a re-render of the same focus no longer yanks a mid-read commentary text back to the top (only an actual focus change resets its scroll).
* Testing: spec 37 (nine tests per browser) pins the manual default, containment and sweep entries, stickiness, both pin/release machines, the per-viewport audience re-derivation, and the real-playback path. Test moments are computed from the payload's own spans and gaps at runtime, and overlap-aware — adults spans on the reference genuinely overlap, so expectations use the same latest-start tie-break the app does.
* Testing: spec 36 (sixteen tests per browser) pins all three policies — including that the default is byte-for-byte the pre-turns behaviour — the selection marks, the auto-grant, the implicit deny (and that its timer dies with it), and the broadcast arbiter across two windows. The policy machine is driven with the transport quietened and its playing state under test control, the same discipline as the tap-seek pins; the genuine audio path runs end to end in three integration tests. The full suite stands at 233 numbered tests per browser, green on both.

### 0.27.0 -- The 'Same Procedure…?' exhibit prototype
* **The museum exhibit page exists** (`/exhibit`, served entirely from `app/static/exhibit/`): a portrait kiosk split into two viewports facing each other across a table, the far half rotated 180°, each half showing eight recordings of the Fledermaus overture as stacked waveform strips. The strips render from pregenerated peaks alone — nothing decodes and nothing downloads to draw them — and playback runs through exactly one shared windowed-audio clock, with every cursor (including the audible recording's own) positioned per frame from that clock projected through the shared alignment arithmetic, so all sixteen cursors stand at the same place *in the piece*, not at the same number of seconds. Annotation regions are display-only; audience and language resolve per viewport, never globally. Every dimension and behaviour is a query parameter over one build, so the laptop, the iPad, and the eventual museum table are three URLs rather than three builds.
* **The exhibit's data pipeline**: `tools/prep_exhibit_data.py` merges the three audience alignments into one curated payload (48 kHz audio, pinned MEI), and `tools/prep_exhibit_metadata.py` builds a metadata sidecar (conductor, ensemble, and year per recording) from the project RDF plus MusicBrainz, with a small authored-overrides file whose policy is that upstream mistakes are corrected at source — every override carries a disposition, and stopgaps are named on each run so they cannot quietly become permanent.
* **The middle band** between the halves shows the audible recording's conductor, year, and ensemble, and names the piece and composer (with opus support the payload can grow into) — proper names and numerals only, no UI labels, because the surface is read in two languages from two directions at once. A shared play/pause control with the current time rendered twice, the far copy rotated for the other reader.
* **Per-viewport zoom and scroll**: zoom anchors on the playhead, and panning one zoomed strip re-centres the other seven on the musical moment at its centre — native scrolling with momentum, the sync listening rather than driving. Kiosk touch guards refuse pinch and double-tap zoom on the glass. A desktop-debugging stage rotation (`?stageRotation=90|270`) composites the portrait screen onto a physically turned monitor after layout, so nothing inside re-measures.
* **The commentary panel**: the audience's annotations as chips, the focused one's commentary scrolling internally (authored text runs to 1640 characters and may not be silently clamped), and the focused annotation's group notes as colour-matched cards — the legend for the strip edges, painted from the same resolved grouping, so card and edge cannot disagree. Group legends and strip edges render only when the annotation actually has something to say about its groups; between-group comparison texts flow through the pipeline into the same panel.
* **A first feedback round, entirely as opt-in query parameters with the shipped behaviour as default** — the standing rule, so competing variants stay comparable at the autumn user testing: three middle-band orientations (`?bandOrientation=upright|rotated|mirrored`); a staff-facing study panel (`?studyPanel=true`) — a cog opening a tabbed panel over all of these parameters, where every change rewrites the URL, so the URL *is* the configuration; ten theme presets sliced into eight independently pinnable categories plus wave and accent extras (`?theme=`, `?themeWaves=`, …); `?annotationColors=theme` replacing the authored annotation colours with the preset's twelve-colour diverging series, display-only; and `?zoomControls=0` hiding the zoom buttons while the zoom machinery stays wired.
* **A second feedback round, same rules**: a GENERIC side slot (`?sideSlot=annotations`, `?sideSlotWidth=`) — the annotation chips always keep their own row below the content area, and while the panel is open the viewport splits into strips left and panel right, "right" being each reader's own right since the panel rotates with its viewport. The panel holds the focused annotation's commentary and, whenever the annotation has one, its group story. Tapping a chip focuses and opens; tapping the same chip again closes the panel while KEEPING the focus, so the highlighted regions and group edges stay over full-width waveforms; the panel's × is the one control that clears everything. The panel changes the main area's width only, never its height — the chips row holds its exact vertical position through open and close — and opening or closing re-runs the current zoom geometry, so a zoomed strip refits to its new width. The seam is deliberately tenant-agnostic, because the optional Verovio score view would occupy exactly this split — with annotations then returning below in full. And an audience union mode (`?audienceAll=1`) adding an "All" position to the switch that shows every audience's annotations at once, each chip marked with the audience it targets.
* Fix: tapping a strip to seek only placed the playhead correctly on the unrotated half. The renderer's own tap handling maps `clientX` against the *painted* box, which is transform-naive: on the 180° half every seek landed mirror-image from the finger (at `duration − t`), and under the stage rotation every tap collapsed to the strip's visual centre line. The exhibit now owns the tap→time mapping from local-space offset coordinates, which the browser maps back through every ancestor transform — measured on both engines, and reproducing the renderer's own arithmetic exactly in the one geometry that already worked.
* Fix: switching recordings twitched the whole exhibit screen for a frame — the transient status line took its height back. Its height is now reserved and the text written only on change.
* Fix: if the exhibit booted while its window was still mid-resize, the strips could be laid out a few pixels wide and the minimum-width floor then inflated every annotation region to essentially the whole recording — and an idle kiosk kept them that way, because only a re-render repairs them. The widening floor is now capped at 2% of the recording, and each viewport re-derives its regions whenever the renderer reports a real width change, so a late-settling display heals itself.
* Engine: the fit-to-width arithmetic moved into `engine/zoom-fit.js`, so the exhibit imports the zoom-out one-pixel-overflow fix (0.25.0) instead of copying it — the only engine change in this release, and `listen.js` keeps its behaviour through the shared function.
* Testing: the exhibit is covered by specs 34 (thirteen tests: loader, strips, regions, audience, band) and 35 (twenty-three tests: stage rotation, zoom and scroll sync, the commentary panel, and every feedback-round parameter, including seek positions through both viewport rotations and the stage rotation, poison-verified). The full suite stands at 207 numbered tests per browser, green on both.

### 0.26.0 -- Exhibit groundwork
* **Two engine modules now stand entirely alone**, the first step in preparing the listen engine for a second consumer — the museum exhibit for 'Same Procedure...?'. They are the alignment index↔time arithmetic, and the grouping read model that answers which group a recording belongs to. Both encode semantics every consumer has to agree on, so they are shared rather than copied: a divergent copy is how two codebases start disagreeing about which moment, or which recordings, an annotation is about. `listen.js` keeps wrappers under the existing names, so all 37 alignment call sites and every grouping call site are unchanged, and the grouping read model now takes the little it needs from the surrounding application as a parameter rather than reaching in for it.
* Testing: a source invariant enforces the rule that the exhibit page may not import `listen.js` — directly or through any chain of imports — and reports the whole import chain rather than just the fact. It carries a self-check, so it cannot pass merely because the import walker broke. The multiset reconstruction check that verified every step of the refactor is now a repository tool (`tools/verify_multiset.py`) instead of being rewritten from scratch each time it is needed.

### 0.25.0 -- Large-scale refactor
* **Phase-1 engine modularisation.** Large parts of `listen.js` have been pulled out into fifteen focused modules under `app/static/js/engine/` — zoom & scroll, audio normalisation and the windowed-player lifecycle, playback transport, time-axis ticks, marker rendering and interaction, off-screen region navigation, time measurement, waveform rendering, waveform event wiring, waveform row layout and group placement, the grouping model that answers which group a recording belongs to, the sidebar / content-pane / tab-strip views that draw it, the Group Recordings dialog, MEI MIDI parsing and software synthesis, and the alignment/session data seam. Every extraction is behaviour-preserving and was landed only with the full e2e suite green on both browsers. Groundwork for running the listen engine in more than one place (e.g. the museum kiosk as part of 'Same Procedure...?') rather than a feature in itself.
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
* Fix: the Score group is displayed at the top of the waveform pane again, where the saved group order puts it. A leftover sort at the end of waveform creation — from before recordings could be grouped, and written to order individual waveforms rather than group containers — was reversing the order of the group containers each time a waveform was added, so the pane came out upside-down whenever an odd number of waveforms had been built. 
* Fix: score-source failures are now reported honestly instead of silently, and a Verovio toolkit that isn't built yet can no longer empty the page mid-load.
* Fix: recordings listed inside a coloured group card were illegible in dark mode. The group colours are a fixed set of pale pastels that ignore the active theme, so the theme's near-white text colour was landing on a pale background; the card already worked out a dark contrast colour for itself, but each filename row set a colour of its own that overrode it. The card now hands that colour to its text, including the hover state, which would otherwise have put dark text on the theme's dark hover background.
* Fix: in every non-light theme, all twelve buttons of the Group Recordings dialog rendered as the same grey — "Discard" and the delete-group ✕ lost the red that marks them as destructive, "New Group" and "Add" lost their accent colour, and the bare ✕ icons became solid grey boxes. A general "buttons in a non-light theme" rule was picking up ID-level precedence from an exclusion written into it, which no ordinary rule could outrank; "Apply" had been kept blue by brute force, and that workaround is now gone. Also fixes "Apply" quietly depending on the same workaround in light mode.
* **A recording now belongs to exactly one group at a time**, within a given grouping context (a tab, or an annotation's pinned grouping). Switching context can change that affiliation — that is what tabs are for — but two groups could previously claim the same recording at once, because "which group is this in?" was answered independently in six places that disagreed: waveform creation took the first matching group, switching tabs took the last, and the sidebar, the group containers, the tempo-curve scope, and the grouping saved with an annotation each counted the recording under every group it matched. So a recording could change group just by switching tabs and back, and a group could sit in the pane permanently empty while its badge claimed a recording that was actually shown elsewhere. An alignment file that puts a recording in more than one group is now reported on loading and corrected to the first of them.
* The score is no longer groupable: a group whose filename pattern happened to match the synthesised score could pull it out of its own Score group entirely.
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