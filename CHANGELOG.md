# Listen Here! CHANGELOG.md

### 0.53.0 -- Fix mode: score zoom-and-scroll, one peak per mark, spectrogram scales and labels
* The score pane zooms: fit the page (as before), fill the width, or a percentage of the fit, chosen in the Score fieldset or stepped with `+` and `-`. A page narrower than the pane is centred; a wider one scrolls, the connectors follow the scroll, and the selected onset is scrolled into view, during playback too. Sticky; the Verovio layout and the prewarm fit are untouched.
* The Correction region's controls sit in collapsible fieldsets like the listening interface's: Score, Playback, Snap to onsets, Lanes, and Edits.
* While a realign runs, the alignment ticks pulse, the strip's cursor says so, the magnet button stands down, and during `S` the status chip counts "Moving k of n". While the spectrogram is recomputed after a setting change, the lane dims under a spinning badge.
* "Move to nearest onset" no longer lets one detected onset attract several marks: a peak claimed by an anchor is nobody else's target (drag magnet and `S` alike), and on several marks the peaks are assigned in score order, each used once, with two moved marks never landing closer than half their score-implied interval at the local tempo (the median inter-onset rate of the surrounding events). A mark that loses its peak is left to the realign of its neighbour's segment, and the announcement says how many were.
* The spectrogram's frequency scale is selectable, mel, log, or linear, and Hz labels can be drawn on its left edge.
* The snap target ("detected" / "perceived") is a pair of radio buttons in the listening interface's shape; the drag magnet's switch is labelled "Magnet on drag"; "Move to nearest onset" is a lightning-and-magnet icon at the end of that row, its wording in the tooltip.
* Testing: spec 41 grows to 13 (the three filterbanks), spec 42 to 30 (zoom, scale and labels), spec 43 to 34 (one peak per mark, the dispersal, the claimed-peak repulsion). All verified red first. The Firefox test profiles' disk and media caches are capped; they grew to 660 MB each and, left behind by interrupted runs, filled a disk. The runner takes a machine-wide lock, so a second suite in another checkout waits for the first instead of flaking both (`E2E_NO_LOCK=1` bypasses it).

### 0.51.0 -- Fix mode: faster arming, a configurable and resizable lane stack, and "Move to nearest onset"
* The correction engine arms in about a third of the time: the Python runtime is warmed at load-idle under `?fixMode` and at entry while the audio decodes, and scipy is no longer loaded (its three linear interpolations and one running maximum are numpy now, checked equal to the scipy originals). Measured on the fixture: 5.9 s → 2.0 s to "Ready to correct"; the console now prints where the arming seconds went.
* The spectrogram is configurable from the Correction region: FFT size, window type, overlap, and mel bands, sticky across sessions, re-requested from the engine on change while the onset curve and its peaks stay.
* The lane stack is resizable: drag the gap under the score to trade height between score and lanes, drag the boundary between two lanes to trade between them, double-click either to reset. Both sticky; the score re-fits at the end of a drag, and the prewarm fit follows.
* "Move to nearest onset" (nav button, or `S`): moves the selected onset, or several, to the nearest detected onset within 250 ms, laying anchors in order and realigning; several moves are one undo step and one replay, and the outcome is announced, including how many had no onset in range or were blocked by a neighbouring anchor.
* Several onsets are selected by dragging across empty strip (a marquee), Shift+clicking ticks, or `A` for the whole page; `Escape` clears the selection first. Members wear their cap in outline.
* The snap target can be the perceived attack instead of the detected onset, for the drag magnet and for `S` alike: the moment the energy envelope's rise passes 6 dB below its crest, which lags the flux peak on a slow attack and sits on it for a sharp one.
* Testing: spec 41 grows to 12 (perceived attacks on slow synthetic attacks, the scipy-free interpolation checked against scipy, no scipy import), spec 42 to 28 (configuration, resizing, the runtime warm-up and arming trail), spec 43 to 33 (multi-selection, the batch command and its single undo, the perceived-attack target). All verified red first.

### 0.49.0 -- Fix mode v2 lanes: spectrogram, onset curve, snap-to-onset
* The correction strip is a lane stack: beneath the reference waveform sit a mel spectrogram and the recording's onset-strength curve, all three at the waveform's zoom and scroll, with the playhead's gutter beneath them. The alignment ticks cross every lane.
* Detected onsets hang from the onset lane's top as marks, and a dragged tick snaps to the nearest one within 8 px; holding Alt while dragging places it freely, and a "Snap to onsets" checkbox in the Correction region is the sticky switch. Keyboard nudges never snap.
* "Spectrogram" and "Onset curve" checkboxes switch the lanes (sticky across sessions); the strip grows to hold them and the score pane re-fits, still above three times the strip's height.
* The correction engine computes both lanes and picks the onset peaks after it has armed (`fix_lanes`), so arming time is unchanged; until they arrive the lanes say they are computing. Peaks are picked from the onset curve at 23 ms resolution with a dynamics-aware threshold and a sub-frame parabolic refinement; on the synthetic ladder every peak lands within 9 ms of the analytic onset.
* Testing: spec 41 grows to 11 (the lanes' numerics and peak-picking against closed-form onsets), spec 42 to 25 (the lane stack, its toggles and the prewarm fit; the lanes painting from the engine), spec 43 to 31 (snap, Alt bypass, the sticky switch). All verified red first; 43.30 now measures the ticks against the lane stack's bottom.

### 0.48.1 -- The test harness follows APP_BASE_URL everywhere
* Every URL the e2e harness builds now derives from `APP_BASE_URL` (six files hardcoded `localhost:5001`), and the auto-started Flask listens on that URL's port, so a second checkout can run the suite on its own port beside a main checkout that owns :5001.
* The debug-only fixture route rewrites the fixtures' `localhost:5001` origin to the requesting origin, and the file-picker helpers do the same in memory, so a tree under test never fetches its MEI from another tree's server.
* `.gitignore`: `node_modules` and `ExhibitAnnots` lose their trailing slash, so a worktree may satisfy them with symlinks to the main checkout's copies (as the exhibit audio already could).

### 0.48.0 -- The Gen-AI portraits are marked as AI-generated
* Every conductor portrait carries a small gold bubble with a four-point spark, straddling the medallion's rim at the upper right. It is burned into the image, so the band, the strap, and any surface added later all show it.
* The portraits also carry the IPTC `DigitalSourceType` of `trainedAlgorithmicMedia` in their XMP, so the claim survives the file leaving the exhibit.
* Portrait assets become WebP with an alpha channel; the nine JPEGs are replaced.
* The band's portrait grows 72 → 80 px and the strap's portrait discs 30 → 35 px, so the visible medallion stays the size it was; the strap's portrait medallions still line up with the paper discs beside them.
* `tools/split_portraits.py` draws the mark at split time and refuses to write one that would land inside the portrait or outside the surfaces' circular clip.
* Still open: one sentence on the about page explaining the mark. Until it ships, the §5.5 labelling obligation is only half met.

### 0.47.0 -- Chanda's demo feedback: the per-recording notes appear, the band says whose turn it is
* The annotator's per-recording notes are rendered for the first time. 31 of the 61 targets in the shown set carry one and no code path read any of them; the note for the audible recording now appears below the shared description, headed by that recording's strip caption.
* Strips the shown annotation has a note for carry a dot while it paints, so which of the ten were commented on is visible at a glance. `?targetNotes=off` is the comparator.
* New band orientation `?bandOrientation=flip`: one cluster, turned to face whichever side last took the clock. Same height as upright, so it costs the commentary panel nothing; the play control and time readouts stay out of the rotation.
* The flip changes over as a cross-fade — the cluster dips almost out, turns while it is faint, and settles. `?bandFlipMotion=spin` keeps the animated rotation for comparison; reduced-motion gets neither.
* The band marks the side whose tap the clock is answering (`?turnIndicator=edge|wash|off`), in every orientation. Under the request policy it means that side may play back; under the others, that side chose what you are hearing.
* A single viewport keeps the middle band, at the top of the screen. It had none, taking the discographic identity and the exhibit's only play/pause and time readout with it.
* `?groupIndicator=wide|tint` makes the grouping edge more prominent. When a grouping paints is unchanged: it still needs the annotation to have something authored to say about its groups.
* The first Gen-AI conductor portraits: Karajan (1987), Kleiber (1989), and Barenboim (2022) appear in the middle band and on the strap medallions. Recordings without one keep their initials.
* New `tools/split_portraits.py` cuts a contact sheet into one medallion per sitter, finding each by its gold ring and cutting cells on the sheet's own rules.
* Portrait URLs resolve against the exhibit root rather than the current document, like the audio paths.
* Study panel: strip height offers 38 and recordings offers 10 (neither was selectable, so the shipped exhibit could not be restored from the panel); a footer line reports how much of the commentary is visible at the current geometry; the Defaults preset moves to the request policy, direct taps, and the listening marker.
* Testing: specs 34 to 37 gain one test each and spec 35 gains two (the single-viewport band, the grouping salience, the turn mark, flip, the per-recording note and its off switch, the portraits). All verified red first.

### 0.46.0 -- Chanda's annotation feedback; the exhibit shows ten recordings
* The exhibit's shown set rises from eight recordings to ten: `VPO-2002` (the pivot of "D or E?") and `VPO-1951-1954` join it.
* Strip height drops 48 → 38 px. At ten strips and 48 px the annotation panel loses 100 px and the description text disappears entirely; 38 px leaves the panel exactly the height eight strips left it.
* The authored annotation text is applied as answered: 24 spelling and grammar fixes, "chance" not "change", the recut *Oboe Solos* closing sentence, Eulenburg, Peters, Baumgärtel 1900, "the slowest in this section", Strauss and Joseph throughout.
* Six one-word "E6" notes become sentences; the Warren recording gains its *Lonely Bell* note; `VPO-1987` gains a note in all three Expert annotations.
* Group names: "VPO" → "Vienna Philharmonic Orchestra", "New Group" → "Other Orchestras", and "Ungrouped" is gone from every annotation (its Expert members move into the VPO group).
* The zero-length first region in *Clapping Detective* is deleted at source.
* The Warren identity note now explains what a Scholz production is; the Berky article is recorded as its source.
* `VPO-1951-1954`'s identity is hand-authored from the liner notes (Clemens Krauss, Wiener Philharmoniker, recorded 16 September 1950) — the RDF has no usable record for it. `VPO-2002`'s conductor is pinned to "Seiji Ozawa"; MusicBrainz's artist entity carries 小澤征爾.
* The strap medallion omits the apostrophe-year when the year is not a plain four digits, rather than printing the last two characters of a range.
* New `tools/annots_text.py`: splits the authored ~20 KB out of each 19 MB annotation set so the text is version-controlled, and splices it back over a fresh export.
* Prep warns when a curated recording's note is too short to be a sentence.
* Testing: spec 34's counts derive from the payload's own order, with the set size pinned in one assertion.

### 0.45.0 -- The correction controls move into the left nav
* The correction screen's controls now live in a "Correction" nav region; the Controls and Waveforms regions stand down while it is open, and the header strip over the score is gone (the score and strip get its height).
* Undo, Redo, Revert alignment edits, and Save data join that region for the session and return to Controls on exit.
* The main transport drives the correction screen: play/pause is the audition, the seek buttons step onsets, the skip buttons turn pages, and the marker button places a session mark. Tooltips and the two skip glyphs change with it.
* Page only and Replay off are checkboxes; the speed and balance sliders gain emoji end-labels.
* Fixed: the correction status chip was unreadable on the dark themes (dark green or dark red on a dark background).
* Fixed: the marker button's tooltip dropped its "(M)" hint after the first marker refresh.
* Testing: spec 42 grows to 23 (the nav consolidation, the transport takeover and its restoration at exit). Both verified red first.

### 0.44.1 -- bugfix
* Ensure waveform zooms to score excerpt on initial load (was showing full recording)
* Testing: spec 42 grows to 21 (the strip's rendered zoom and scroll on first entry, and page 1 identical on the way back). 

### 0.44.0 -- The fix-mode playhead becomes a bracket
* The correction strip's playhead is now two filled arrowheads bracketing the position — one just inside the strip's top edge, one in a gutter beneath the waveform — with no line drawn across the waveform, which was the alignment ticks' own shape.
* The selected tick's cap is a bar rather than a filled triangle; ticks, anchor glyphs, and drag ghosts stop at the waveform's bottom edge so the gutter is the playhead's alone.
* The annotation ribbon and its pencil tab are hidden while the correction screen is open; the ribbon had been covering the strip's lower 40 px, anchor glyphs included.
* Testing: spec 42 grows to 20 and spec 43 to 30 (the annotation chrome standing down, the bracket's painted geometry). Both verified red first.

### 0.43.0 -- Fix-mode round 3, second half: a bounded replay, a suppressible one, and a strip that says when it is live
* The auto-replay after a fix now starts at most 2 s before the fix itself, instead of half a second before the previous anchor — the top of the recording when there is none.
* A "Replay off" header toggle suppresses the automatic replay; the commit still happens, and `R` replays the last fix on demand. Sticky across fix sessions, like Page only.
* Until the correction engine arms, the strip's ticks dim, its cursor becomes a waiting cursor, and a drag or nudge that cannot land says why at the pointer instead of failing silently.
* The arming chip counts its phases ("Step 1/4: reference audio…" through "Ready to correct"), with the untruncated message in its tooltip.
* Testing: spec 43 grows to 29 (the replay ceiling, suppression plus R, the not-yet-live strip).

### 0.42.1 -- Sustained notes keep their length across a fix; audition diagnostics
* Fixed: an offset running past its segment's right edge was either clipped onto the next anchor or left stale, so a sustained note dragged beside an anchor collapsed into the gap it was dropped into — a ~20 ms blip at close spacing. Such offsets now continue at the segment's own average rate, capped by the recording; onsets still clip into the segment.
* Corrections saved before this fix, where the dragged note OR its left neighbour sustains past the next anchor, carry a truncated or stale offset — discard and redo them.
* Each commit now logs its own account to the console: the anchored note's onset, offset, and duration before → after, the peak rendered into the synth ear, the realign/linear/degenerate counts, the re-render window, and the previous anchor's note. A second line reports the stretch worklet's own copy — what playback reads — and warns when it disagrees with the buffer.
* A commit-time canary counts any event left with ref_offset ≤ ref_onset and warns; exposed as `lastCommit.degenerate`. The audition's re-render window now extends to the furthest offset a commit wrote.
* The audition renders a minimum SOUNDING length of 70 ms per note, bounded by the gap to the next onset, with an envelope that fits whatever length a note has. Renderer only: ref_offset is never touched by it.
* Testing: spec 41 grows to 10 and spec 43 to 26 (the worker's offset rule against a held-note ladder, a sustained note dragged beside an anchor, a collapsed note still sounding). All three verified red first.

### 0.42.0 -- Fix-mode feedback round 2: the loop refined from real hand-correction use
* Keyboard nudges commit on FULL RELEASE — the keyup that leaves no nudge key down, the keyboard twin of the mouse drag's mouseup — instead of after a 600 ms quiet period (which cut in mid-adjustment). Hold Shift to keep accumulating; Enter/Escape and other gestures behave as before; a window blur commits a floating nudge rather than abandoning it.
* Page-only playback: a "Page only" header toggle pauses the audition at the current page's boundary instead of turning the page; pressing play from outside the page snaps to its first onset − 0.5 s, so play repeats the page. A commit's auto-replay and mark jumps still cross pages deliberately (their pass expires at the target). Off by default, sticky across fix sessions.
* Fixed, a data bug: a drag beside an existing anchor left the dragged event's own OFFSET stale — interior-empty flanking segments were skipped before the offset remap, and the too-short linear fallback returned none — so a rightward drag could leave offset ≤ onset and the synth rendered the note as a ~20 ms blip (the "first-note stutter"). Interior-empty and too-short segments now remap the left-boundary anchor's offset proportionally, clipped into the span (the worker's own discipline). Corrections SAVED with such a drag before this fix carry the stale offset — discard and redo them.
* Marks: N / Shift+N now ACTIVATE the mark they jump to (drawn larger, in close-listening's active-marker colour); Delete or Backspace removes the active mark; Escape deactivates first, and only a bare Escape exits. M's ±0.35 s toggle is unchanged — its hit test could never reach a jumped-to mark across the 0.5 s preroll, which is why removal felt impossible.
* Playback speed with pitch preserved: a granular (WSOLA) time-stretch worklet replaces the plain buffer source; a 50–100% header slider plus a % button that is both the readout and the one-click reset, lit whenever speed ≠ 100%. Both ears share one grain schedule so inter-ear flams never skew, and at 100% the grains tile exactly (full speed stays bit-faithful). Per-session on purpose; costs a second in-worklet stereo copy (~doubles audition memory).
* The fix header keeps ONE stable line (controls no longer wrap when the chip text lengthens): a wrapped header changed the score pane height and silently broke the prewarm's layout reuse at re-entry.
* Testing: spec 43 grows to 24 (43.19/43.20 rewritten for keyup-commit, 43.21 page-only clamp + snap-back, 43.22 the offset follows a drag beside an anchor, 43.23 the active-mark lifecycle, 43.24 the worklet's half-speed head advance + reset); the `setNudgeCommitMs` test seam is gone.

### 0.41.0 -- Alignment correction, increment 3: the interaction loop
* L/R audition playback: one sample-locked stereo buffer — left ear the reference recording, right ear the score synth rendered through the LIVE corrected map (every MIDI note plays from its event's ref_onset to its ref_offset; §13 ruling 2's construction, in-app). Play/pause via the header button or Space; a header slider trims the ear balance in real time; only the changed span re-renders after a fix. The score highlight is bright orange (mei-friend's #ffa500) so it stands apart from the dark-red connector.
* The orientation loop: selection follows the sounding onset during playback (pages turn with it; notes brighten while they actually sound, on at onset and off at offset via the corrected map), and selecting an onset (click, tick, ◀/▶, arrow keys) seeks the audition just before it.
* Dragging a strip tick lays a HARD ANCHOR: auto-realign of the flanking segments on release (worker `fix_realign` on cached features, stored params), then auto-replay from just before the previous anchor. Enter APPROVEs the selected onset as a zero-drag anchor; drags clamp inside neighbouring anchors (and inside the piece corners). A segment squeezed too short for DTW between close anchors falls back to a LINEAR interior fill instead of failing the gesture, and a failed realign rolls the fix back wholesale without latching editing off — both from the first real-corpus run, where accumulating anchors eventually shrank a segment below two analysis frames and the error chip then silently disabled dragging.
* Keyboard fixing: Shift+←/→ nudges the selected onset's alignment point coarsely (100 ms) and Shift+Alt+←/→ finely (20 ms) — the app's existing marker-nudge convention; nudges accumulate on the strip (ghost + delta readout, exactly like a drag) and commit as ONE anchor (one realign, one replay, one undo entry) after a short pause; Enter commits a floating nudge immediately, Escape drops it (a bare Escape still exits). Bare Alt+arrows and Ctrl/Cmd combinations stay with the browser and OS (history navigation, Mission Control) by design.
* Session MARKS on the audio timeline (M lays/lifts, N / Shift+N skip through them with wrap) — QA flags that survive refills, deliberately neither persisted nor undoable.
* Global undo: `fix-anchor` snapshot entries on listen.js's unified stack (before/after values stored — undo and redo never need the worker); a hop with fix mode closed announces itself ("Undid alignment correction near bar N") instead of changing data silently. Revert-all now also restores the as-loaded ref tables and correction record.
* `header.corrections` written on every commit (anchors + base provenance); a loaded record resumes into the live model so new edits extend it. Fix mode owns the keyboard while open (listen.js's global shortcuts stand down; Ctrl+Z/Ctrl+Shift+Z stay global).
* Worker fix: a stored discontinuity (the ~36 s artifact zones) severed the guided refill's band — adjacent rows went disjoint where the prior map jumps more per score frame than the slack, the DP accumulated inf downstream, and the corrupted backtrack could displace the WHOLE segment (a first-onset fix on the Fledermaus HQ corpus mapped the opening ~55 s late). Band floors now bridge to the previous row's ceiling so the DTW genuinely traverses jumps, and the backtrack's out-of-band fallback clamps into the band. Spec 41 grows to 9 (41.9: a 16.7 s discontinuity, refill glued to truth on both sides — 15.6 s off before the fix).
* Testing: spec 43 (20 tests, both browsers: audition stereo content, play/pause/seek, playback following + page turns, drag/approve/clamp, keyboard nudge accumulate/cancel, undo/redo/closed-undo announce, marks, realign rollback + the no-latch retry + the too-short linear fallback, the `fix_realign` payload contract, keyboard standdown, balance gains, Revert-all).

### 0.40.1 -- Fix mode feedback round 2: one system per page, connectors under the score
* Fix mode renders ONE system per page (`systemMaxPerPage: 1`, broken at the encoded sb/pb via `breaks: "line"`; auto breaks when the MEI encodes none), so connectors no longer cross along x between systems.
* Connectors' in-score half now spans from the HIGHEST element sounding at the onset down to the page box's bottom, injected into the page SVG as its first-painted group — beneath every score element (staff lines included; a single line cannot sit between all staves' lines and their notes in SVG paint order). The overlay polyline continues from the content's true bottom edge, computed fresh per frame.
* The in-score lines' geometry avoids `getScreenCTM` entirely (Firefox maps nested-svg CTMs wrongly — lines bunched at the page's left; Chromium's read collapsed the bottom endpoint mid-transition — lines pointed up and out of the page): coordinates come from plain meet arithmetic on the page svg's viewBox + client rects, the bottom endpoint is the viewBox's own height, and spec 42.19 pins the PAINTED line position against the selected notes on both engines.
* Every onset now attaches to a score element: quarters match the timemap within a tick-scale tolerance (grace notes land a tick apart between the rendered MIDI and the timemap), and a sounding event with no notated entry of its own — a measured-tremolo stroke, expanded in the MIDI only — inherits its generating note's element, so its connector rises to the tremolo notehead. Fledermaus corpus: 2,220 direct + 233 tremolo strokes, 0 orphans (previously 394 onsets had ticks with no in-score line).
* Testing: spec 42 grows to 19 (42.18 one system per page, 42.19 underlay beneath the score + painted-position pin + selection emphasis + zero orphaned onsets).

### 0.40.0 -- Alignment correction, increment 2: the fix-mode correction screen
* `fix-mode.js`: a per-waveform correction mode (opt-in via `?fixMode`; defaults byte-identical without it). The score and reference rows carry an entry button; activating either replaces the content pane with the full score rendered page-fit (~85%, Verovio `renderToSVG` on the shared toolkit, layout snapshotted at entry and restored at exit) over a single reference-waveform strip (~15%, peaks-only renderer) whose viewport tracks the current page's time span.
* Every onset of the current page draws as a faint tick on the strip with a connector from its score position; ◀/▶ skip the selection between onsets (turning pages at the edges), a score note-click selects its onset, and the selected onset's notes highlight in the score.
* The item-T entry guard (plan §14 D1): entry re-renders the MIDI and refuses — naming the stamp — on a `verovioVersion` or expansion-options mismatch, or when any stored `score_onset`/`score_offset` quarter differs from the fresh render.
* Correction-engine bootstrap wired: the reference recording decodes to mono 22050 Hz and the worker's `fix_begin` runs in the background (stored `alignmentParams`, no fast parameters); the worker outlives an exit for cheap re-entry and is terminated on piece replacement. The strip's peaks upgrade from the decoded samples.
* Pages always fit the pane: `adjustPageHeight` keeps the page box tracking content (an orchestral system taller than the target page no longer clips — the viewBox scales it down instead), per first-corpus feedback.
* Entry is instant after a load-idle prewarm: the guard, onset groups, page-fit layout (resident from then on — exit no longer relayouts), page attribution (monotone divide-and-conquer over `getPageWithElement`, ~2.5× fewer wasm calls), and the first page's SVG are prepared ~2 s after the piece loads; a cold entry (or a resize relayout) shows a loading overlay instead of appearing hung.
* Testing: spec 42 (17 tests: param gating, the three refusal classes, layout swap and resident-layout exit, ticks/connectors, selection paths, page turns, prewarm + cold-entry overlay, and the `fix_begin` payload contract via a stubbed worker — the fix-message plumbing spec 41 deferred).

### 0.39.0 -- Alignment correction, increment 1: anchors engine + worker segment realign
* `engine/correction-model.js`: the pure fix-mode model — anchors (drag/approve/gap), gap objects labelling unscored audio, refill segments with corner semantics, undo before-value snapshots, `header.corrections` serialization, and the item-T quarters guard; zero imports (spec 33.3 ratchets it). Design rulings in plan §14.
* Alignment worker: `fix_begin` / `fix_realign_segment` / `fix_dispose` — a correction session keeps the reference and score-synth PCM resident and re-runs banded DTW only between neighbouring anchors, on segment features whose hop adapts to segment length (~23 ms frames for short segments vs the full-piece 100 ms), guided by the stored mapping tapered onto the anchor endpoints.
* Fixed a latent decode bug in `_guided_band_dtw` (the wizard's audio-to-audio fine pass): float32 cancellation in the prefix-min trick mis-marked parent pointers as horizontal, yielding paths far costlier than the DP optimum; row temporaries are now float64 and horizontal steps are decided from the cum-min's provenance. Tie-breaks now match `dtw_band` (diagonal wins).
* Licenses verified for the stand-in render step: MuseScore_General is MIT, VSCO 2 CE is CC0 1.0.
* Testing: spec 41 (model: segments, validation, gaps, undo round-trip, serialization, quarters guard; worker: analytic tempo-map recovery, wrong-anchor flank behaviour, adaptive hop, error paths).

### 0.38.2 -- Exhibit marker: round lens, no magnifier, and a Mark button
* The listening marker's lens is a circle again (was an oval), and it no longer magnifies the waveform beneath it.
* The lens spans 80% of a strip's height rather than all of it, and the hook's dashed ring fits inside the strap (was 8 px wider than it).
* New "Mark" button beside "Jump to annotation", shown only under `?marker=glass`: it places the reader's marker at the start of the shown annotation's first region — the same landing the jump uses. Styled as a labelled pill with a plain glyph, so it is not mistaken for the draggable glass.
* Testing: spec 38.17 now pins the round lens and the absent magnifier, and 37.27 the Mark button's landing and its button chrome; exhibit specs 222/222.

### 0.38.1 -- Stand-in tool: stereo audition mix
* `make_standins.mjs --stereo --audio-dir DIR`: one sample-locked audition WAV per recording — left = the real recording mono at 22050 Hz (via ffmpeg), right = the warped synth, channels normalised separately (§13 ruling 2's construction, offline; misalignment is heard as inter-ear flams). The in-app listen.js row remains session 2.

### 0.38.0 -- MIDI stand-ins, session 1: the composed time map and the warp tool
* `engine/time-map.js`: the composed quarters ↔ recording-seconds map (score onsets piecewise-linear, grids frame-interpolated) with inverses; zero imports (spec 33.3 now ratchets it), shared foundation for the stand-in warp and the planned time-axis modes.
* `tools/make_standins.mjs` (Node, vendored Verovio natively): per recording, a warped `.mid` by tempo-track replacement (note ticks untouched, ~2,300 cumulative tempo events) plus an opt-in preview WAV; peaks-derived note velocities (`--no-dynamics` to disable); honours the `header.verovioVersion`/`verovioOptions` stamps and refuses unless the fresh render's onset quarters match `score_onset` exactly.
* Inter-onset gaps beyond the 24-bit MIDI tempo ceiling (~16.8 s/quarter; the corpus has ~36 s alignment artifacts near the piece's end) are clamped and caught up cumulatively, with every affected knot reported; onsets elsewhere land within microseconds.
* Testing: spec 40 (knot exactness, first-pair dedupe, grid half, monotonic round-trips, score-less alignments).

### 0.37.1 -- Synth timing fix: real tick-0 tempo events win, corrected tables for existing alignments
* Alignment worker: tempo changes now sort by tick only, so a file's real tempo event at tick 0 beats the seeded 120 BPM default (Fledermaus opened 20% slow, +4.000 s by quarter 48, in synth times and in the synthesised audio fed to DTW).
* listen.js derives corrected synth onset/offset tables from the MIDI Verovio actually renders (matching alignment-event score quarters against note ticks) and prefers them over the stored `synth_onset`/`synth_offset`; stored values remain the fallback. Tempo curves and Solid score-region projection use the corrected tables; on unskewed alignments the derived values are bit-identical to the stored ones.
* Regenerating alignments after the worker fix may improve score↔reference DTW quality in a piece's opening (the synthesised audio was slow there).
* Testing: spec 39 (planted-skew A/B defence, fallback survival, and the embedded Python's tempo tie-break on a synthetic MIDI).
* (Authored as 0.36.1 in its worktree, before 0.37.0 landed; renumbered at merge.)

### 0.37.0 -- Verovio 6.3.0 and alignment provenance
* Vendored Verovio updated 5.6.0 → 6.3.0; toolkit init now probes readiness by construction (6.x drops `calledRun`), and `expandNever` pins the 5.x no-auto-expansion semantics for MIDI, timemap, and `getTimesForElement` (which otherwise returns zeros when the MEI's expansion cannot be generated).
* The alignment wizard stamps `header.verovioVersion` and, when non-default, `header.verovioOptions` (`expand`, `expandAlways`, and/or `expandNever`, read from the live toolkit) into alignment JSONs whose run rendered MEI, so score-derived timing is traceable to the toolkit and expansion semantics that produced it; a missing `verovioOptions` reads as pre-6 no-expansion semantics.
* `app/__init__.py` version re-synced with this changelog (it had stayed at 0.34.1 through 0.35.0–0.36.0).

### 0.36.0 -- Marker glass round 2: oval lens, rides the audible strip, tap-mediated seeking, real magnification
* The lens is an OVAL sized so a placed, vertical glass covers one strip top-to-bottom; the whole rendering scales with `stripHeight`.
* The glass RIDES THE AUDIBLE STRIP: any recording switch — strap, arrows, an aligned snap, the other side's action — hops it (on the position transition) to the marker's projection on the newly audible strip. The marker index never moves; ghosts follow.
* Direct mode only (user ruling): with a marker standing, a waveform tap LIFTS the glass into expect-placement instead of seeking — the strap owns switching there, so the glass mediates seeking while it is up; the second tap places AND plays. Aligned-mode snap semantics are untouched.
* Lifted taps are a HYBRID (third round): a tap still within the waveform world — the strips container or the strap's switch buttons — keeps the marker and settles the glass back onto it (a strap switch carries the glass along); a tap beyond that world returns the glass to its hook, marker and all. Either way the tap itself still acts. The hook, tapped while the glass is in hand, also removes.
* The strip stack pulses during drags too, matching expect-placement.
* The lens MAGNIFIES at 4×: a canvas under the SVG draws the waveform beneath the glass from the payload's own peaks — live while dragging — in the active-waveform ink, under the amber tint. The vertical cursor hairline is gone (the lens itself is the point).
* The ghost mirrors about its LENS CENTRE (a default-origin 180° rotation painted the lens ~38% of the box below its row); 38.11 now pins glass and ghost lens centring within 3px.
* Testing: 38.14–38.17 (two-tap seek, hybrid cancel + hook removal, the hop, the magnifier) plus the drag-pulse pin; suite 560/4 combined = 280/2 per browser.

### 0.35.1 -- Marker glass aesthetics, and study-panel hints
* Study panel: every parameter header carries a 1–2 sentence hint — a title tooltip for desktop hover, and tap-the-header toggles it inline (the panel's real home is an iPad, where hover does not exist); dotted underlines mark the headers, and the tabs carry one-liners. English-only, per the panel's staff-tooling exemption.
* The glass tilts while in hand (mid-drag, or lifted awaiting placement — the bob sways around the tilt) and hangs vertical at rest and once placed; the lens seats inside the hook's ring, and the resting anchor no longer sits 19px off-centre (the hook was centred with `translateX(-50%)`, which `offsetLeft` never sees — hooks now centre by margin).
* The handle is chunkier, modestly longer (the +50% first cut covered the next waveform when placed, so trimmed 25% — hit box shrunk with the paint), and textured as a leather-wrapped grip between a brass ferrule and end cap: cylinder shading on every theme, saddle-leather grip and pale wrap threads parchment-only (new optional token `--ex-marker-handle`; the wrap takes `--ex-thread-accent` — brown thread vanishes on dark leather, the filled-medallion rule).
* The lifted glass hovers upright over the waveform area, inside the pulsing outline — not in the rail column, where it sat on the strap medallions under `tapMode=direct`.
* `setPointerCapture` guarded with try/catch: a failed capture must not cost the tap.

### 0.35.0 -- Exhibit listening marker (the magnifying glass), and the Scholz display copy
* `?marker=glass` (default off): one marker per viewport, anchored as an alignment index (align-core; the listen.js mark-button semantic). The glass rests on a stitched hook in the left rail — the strap's column; aligned mode reserves the column for the hook alone — dragged onto a waveform to place, dragged off to remove.
* Tap path: tapping the glass lifts it into expect-placement (the strip stack pulses); the next waveform tap places it; a tap anywhere else rests the glass on its hook while still performing its own action.
* Placement, moving, and adoption are the reader's own jump — the placed moment plays. While a marker stands, bare switches (aligned cross-strip taps, strap picks, nav arrows) land on it instead of carrying the moment; explicit times still win. Marker-snap switches count as seeks for the fade rules.
* The other viewport's marker appears as a mirrored translucent ghost, interactive only while this side's glass is in hand; dropping or tapping the glass onto it adopts that moment (merge = snap-assisted placement, no persistent merged object).
* Projected ticks on every strip: salient and live-tracking while the glass is in hand, briefly prominent after placement, then settled-subtle but visible.
* The glass wears the theme accent (parchment's bronze was specified as this metal); one new optional token, `--ex-marker-lens`. `marker` in the study panel (Misc).
* Scholz display copy (option b, ruled; pending Chanda's confirmation): the Warren recording shows "Orchestra and conductor unidentified — a pseudonymous Alfred Scholz production, first issued 1982." in the band (sidecar `displayNote`, a language map), "Unidentified orchestra" in the strip caption (`displayShort`), and a "?" strap medallion; decided-empty conductor/ensemble in the overrides.
* Testing: spec 38 (13 tests), including the rotated-viewport drag mapping and the seek-classification A/B pin. 552/4 combined = 276/2 per browser.

### 0.34.1 -- Strap leather reveal: full height, medallions, arrows, stitching everywhere
* The leather band now runs the viewport's full height — from the page edge up underneath the middle band, which paints above it — so the strap reads as binding the two halves; the toolbar and commentary sit beside it. Buttons stay on a separate rail keeping exact strip-row alignment.
* Labels sit on circular medallions (discs sized to strap and strip geometry, two-line stacked — the §5.5 portrait-excerpt shape); tap targets still fill the whole row.
* Arrow medallions above and below the rail (stitched SVG arrows) step the aligned switch one strip up or down, wrapping at the ends; spec 34.19.
* Stitching generalized to every control button in both states via two optional tokens — `--ex-thread` (resting/paper) and `--ex-thread-accent` (filled/bronze) — parchment-only, a `?themeControls=parchment` pin away for other themes; chips and the pin-expiry pill deliberately excluded; :focus-visible ring restored.
* The leather gained a thresholded blotch layer (wear/oiling), stretched once over the strap's height — the parchment stains lesson applied.
* The staff cog and panel move to the window's bottom-left under a stage rotation, where the fixed bottom-right corner would land on a strap.

### 0.34.0 -- Exhibit direct tap mode and the switch strap
* `?tapMode=direct` (default aligned, alpha-tester feedback): a tap on another waveform is taken literally on BOTH axes — switch and seek to the tapped position — via the ruled jump path (explicit time survives the switch and contention; plays if paused; the reader's own seek to the fade rules).
* The switch strap: in direct mode each viewport gains a per-recording button column left of the waveforms (strap.js) doing the aligned carry-the-moment switch the strips gave up. Buttons show conductor initials + year ("HvK ’87") until the §5.5 portrait excerpts exist, and mirror the active recording.
* Parchment styles the strap as leather via two new OPTIONAL theme tokens (`--ex-strap-bg`, `--ex-strap-btn`); every other theme keeps the panel/card fallbacks.
* `tapMode` in the study panel (Misc); the staff preset stays aligned by ruling.
* Testing: 34.17 pins the literal both-axes tap (the mirror of 34.8's aligned carry), 34.18 the strap — direct-only, labels, aligned carry, active marking.

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