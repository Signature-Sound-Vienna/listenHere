# End-to-End Test Scenarios

This document enumerates Playwright E2E test scenarios for *Listen Here!*. Tests are grouped by feature area. Each scenario has a short title, preconditions, steps, and expected outcome.

Test fixtures assume a small collection of public-domain audio files (e.g. `audio-a.mp3`, `audio-b.mp3`, `audio-c.mp3`) and a corresponding `alignment.json`, available both in-repo (served by the Flask dev server) and hosted at a known public URL.

---

## 0. Scope & Conventions

> **Out of scope:** `align.html` (deprecated) and any piece-specific legacy routes are excluded from these tests.
>
> **In scope routes:** `/?mode=listen` (default listen interface), `/?mode=align` (in-browser DTW alignment workflow), `/?useFiles`, `/?data=`, `/?useLocal=`. The alignment workflow is tested via Section 1 (scenarios 1.5–1.6) and Section 17.


- **`alignment.json` (local)** — served from `app/static/wav/test/` by the dev server
- **`alignment.json` (remote)** — URL to the same file on a public host
- **"loaded state"** — app has a valid alignment JSON and at least two audio files loaded and ready
- **"waveforms visible"** — at least two waveform canvases are rendered and non-hidden

---

## 1. Application Load & Initialisation

### 1.1 Clean load with remote alignment JSON
- **URL** `/?data=<remote-alignment-url>`
- Expected: page loads, alignment is fetched, waveform list populated in nav sidebar, at least one waveform renders

### 1.2 Clean load with `?useFiles` — file picker shown
- **URL** `/?useFiles`
- Expected: file-picker overlay is visible before any files are selected; main content pane is empty

### 1.3 `?useFiles` — load alignment JSON then match audio files
- Open `/?useFiles`, drop `alignment.json` then the audio files onto the picker card
- Expected: status list shows each audio file as matched; Continue button becomes enabled; clicking Continue loads waveforms

### 1.4 `?useFiles` — partial match (some audio files missing)
- Drop `alignment.json` and only one of three audio files
- Expected: matched file shown as ready; unmatched files shown as unmatched; Continue available (partial load is allowed)

### 1.5 In-browser alignment — create alignment from local audio files only
- Navigate to the alignment page; provide a reference audio file and two comparison files (no pre-existing `alignment.json`); run the DTW alignment
- Expected: alignment completes; page transitions to listen mode (`/?useFiles`); waveforms load and are synchronised; no `alignment.json` file was required as input

### 1.6 In-browser alignment — result is equivalent to loading pre-computed JSON
- Run in-browser alignment on `audio-a.mp3`, `audio-b.mp3`, `audio-c.mp3`; then save the result and reload it via `?useFiles`
- Expected: both sessions show the same waveforms, the same sync behaviour, and no errors

### 1.7 `?useLocal=http://localhost:8080` — audio loaded from local server
- Serve audio files from `localhost:8080`; load page with `?useLocal=http://localhost:8080&data=<alignment-url>`
- Expected: waveforms load from the local base URL, not from the alignment JSON's embedded paths

### 1.8 State restoration after reload
- Load app, change zoom to level 3, collapse the Settings fieldset, reload
- Expected: zoom slider restores to 3; Settings fieldset remains collapsed

### 1.9 Malformed alignment JSON
- Pass a URL to a file containing `{"not": "valid alignment"}` as `?data=`
- Expected: error state shown; app does not crash; user-visible error message

### 1.10 Network failure fetching alignment JSON
- Pass a `?data=` URL to a non-existent resource (404)
- Expected: error state shown gracefully; no uncaught exception

---

## 2. Waveform Display & Loading

### 2.1 Default display — only score waveform shown on load
- Load with valid alignment JSON + 3 audio files (and a score/MEI synthesis available)
- Expected: only the synthesised score waveform is visible by default; the 3 recording waveforms are listed in the nav sidebar but not yet rendered

### 2.1b Selecting a waveform in the nav bar triggers render
- Click a recording's checkbox in the nav sidebar
- Expected: that waveform renders and becomes visible in the content pane; other unchecked recordings remain hidden

### 2.1c No score — no waveforms shown on load
- Load with valid alignment JSON + 3 audio files but no MEI/score
- Expected: content pane is initially empty; recordings only appear after their nav checkboxes are clicked

### 2.2 Waveform show/hide via sidebar checkbox
- Uncheck a file's checkbox in the nav sidebar
- Expected: corresponding waveform hidden (`display:none`); re-checking shows it again

### 2.3 All / None buttons
- In a group with 3 files, click **All**
- Expected: all 3 waveforms render and are visible; group count shows 3/3
- Click **None** → all 3 waveforms hidden; group count shows 0/3

### 2.4 Score waveform — synthesis progress indicator
- Load alignment JSON that includes a `meiUri`; observe the score waveform while synthesis is in progress
- Expected: a "Synthesising audio…" status message is shown on the score waveform canvas; once synthesis completes the message is replaced by the rendered waveform

### 2.5 Normalize audio toggle
- Enable **Normalize audio**; compare waveform peak heights
- Expected: quiet recordings increase in visual amplitude; no clipping artefacts; disabling restores original heights

### 2.6 Waveform peaks loaded from alignment JSON
- Use an alignment JSON that includes pre-computed peak data
- Expected: waveform renders immediately (no decode delay) with correct shape

---

## 3. Playback & Transport

### 3.1 Play / Pause
- Click the play button; click pause
- Expected: play icon changes to pause during playback; position indicator advances; stops on pause

### 3.2 Space bar play/pause
- Press Space to play; press Space again to pause
- Expected: same as 3.1

### 3.3 Skip to start
- Seek to ~30s; click Skip to start
- Expected: playhead returns to 0:00 on all waveforms

### 3.4 Skip to end
- Click Skip to end
- Expected: playhead jumps to end of audio; playback stops

### 3.5 Seek back / forward (plain, Shift, Shift+Alt)
- At 30s: press Seek Back → position is 20s
- At 30s: Shift+Seek Back → position is 25s
- At 30s: Shift+Alt+Seek Back → position is 29s
- Expected: position changes by 10s / 5s / 1s respectively

### 3.6 Arrow-key seeking (normal mode)
- Press Arrow Right → seek forward 10s; Arrow Left → seek back 10s
- Expected: position changes correctly

### 3.7 Switch active waveform with Arrow Up/Down
- With 3 visible waveforms, press Arrow Down
- Expected: next waveform becomes active (highlighted); playback continues from same alignment position in new file

### 3.8 Alt+number jump — nth visible waveform
- Hold Alt; number overlays appear on visible waveforms
- Press `2` while holding Alt → second visible waveform becomes active
- Expected: active waveform switches; playback seeks to correct aligned position

### 3.8b Number key jump — nth waveform from top
- With 3+ waveforms loaded, press `2` (without Alt)
- Expected: second waveform from the top (regardless of scroll position or visibility) becomes active; playback seeks to correct aligned position

### 3.9 Clicking on a waveform seeks to that position
- Click at ~50% of waveform width
- Expected: playhead moves to corresponding time; position indicator updates across all waveforms

---

## 4. Synchronisation & Alignment Visualisation

### 4.1 Scroll synchronisation at zoom > 0
- Set zoom to level 2; scroll one waveform horizontally
- Expected: all other visible waveforms scroll to the same position simultaneously

### 4.2 Scroll sync does not trigger on hidden waveforms
- Hide one waveform; scroll at zoom > 0
- Expected: hidden waveform does not affect scroll state; no errors

### 4.3 Visualise alignments — grid lines appear
- Enable **Visualise alignments**
- Expected: vertical lines appear connecting corresponding positions across waveforms; lines visible at current scroll position

### 4.4 Visualise alignments — grid lines disappear when disabled
- Disable **Visualise alignments**
- Expected: grid overlay lines removed from all canvases

### 4.5 Grid lines do not flicker during scrolled playback
- Enable alignments, zoom to level 2, play audio
- Expected: grid lines remain stable during playback and scrolling (no flickering/disappearing)

### 4.6 Show relative position indicator — active waveform
- Enable **Show relative position**; play audio
- Expected: straight vertical line on the playing waveform at current playback time

### 4.7 Show relative position indicator — non-active waveforms
- Enable **Show relative position**; play audio
- Expected: slanted indicator on non-playing waveforms — vertical at the aligned position, slanted toward the playing waveform's position

### 4.8 Shared time axis
- Enable **Shared time axis** with files of different durations
- Expected: shorter files render proportionally narrower; all waveforms share same pixels-per-second scale

### 4.9 Shared time axis — position indicator
- Enable **Shared time axis**, play audio
- Expected: position indicator on all waveforms reflects correct absolute time (not proportional)

### 4.10 Switching waveform while zoomed does not cause scroll jump
- Zoom to level 3, scroll to middle, switch active waveform via Arrow Down
- Expected: scroll position does not jump to left and back; no visible scroll jank

---

## 5. Zoom & Scroll Modes

### 5.1 Zoom level 0 — fit to container
- Set zoom to 0
- Expected: all waveforms fill container width; scroll controls hidden

### 5.2 Zoom levels 1–5 — progressive zoom
- Cycle through zoom levels 1–5
- Expected: waveforms grow progressively wider; scroll controls appear; horizontal scrollbar appears

### 5.3 Scroll mode: Follow
- Zoom to level 2, select **Follow** scroll mode, play
- Expected: scroll position continuously updates to keep playhead visible/centred

### 5.4 Scroll mode: Page
- Zoom to level 2, select **Page** scroll mode, play
- Expected: scroll jumps when playhead reaches viewport edge; no continuous smooth scrolling

### 5.5 Scroll mode: Manual
- Zoom to level 2, select **Manual** scroll mode, play
- Expected: scroll position does not change during playback; user can scroll freely

### 5.6 Follow mode persists across page reload
- Enable Follow mode, reload page
- Expected: Follow mode still selected after reload; waveforms scroll during playback

### 5.7 Zoom level persists across page reload
- Set zoom to level 3, reload
- Expected: zoom slider at 3; waveforms rendered at zoom-3 width

---

## 6. Markers

### 6.1 Add marker via M key
- Seek to ~20s; press **M**
- Expected: marker appears on all waveforms at the aligned position; transport button changes to "Remove marker"

### 6.2 Add marker via Mark button
- Seek to ~30s; click the **Mark** button
- Expected: marker appears on all waveforms at correct aligned positions

### 6.3 Remove active marker
- Add a marker; click it to make it active (or navigate to it with arrow keys in close-listening mode); press M (or click the Mark/Remove marker button)
- Expected: marker removed from all waveforms

### 6.4 Multiple markers
- Add markers at 10s, 20s, 30s
- Expected: all three appear on all waveforms; no duplicates

### 6.5 Markers survive waveform switch
- Add marker, switch active waveform
- Expected: marker still visible on all waveforms at correct aligned positions

### 6.6 Marker persisted in saved JSON
- Add 2 markers, click **Save data**, inspect downloaded JSON
- Expected: `header.markers` array contains 2 entries; values are alignment grid indices

---

## 7. Close Listening Mode

### 7.1 Enter close listening — active marker highlighted
- Place at least one marker; check **Close listening**
- Expected: one marker is designated active and painted darker than the others; mode toggle works without error

### 7.2 Enter close listening via C key
- Press **C** to enter; press **Escape** to exit
- Expected: same as 7.1

### 7.3 Arrow navigation between markers in close listening
- Add markers at 10s, 20s, 30s; enter close listening; click the 10s marker to make it active; press Arrow Right
- Expected: active marker advances to 20s; playhead jumps there

### 7.4 Playback starts from active marker in close listening
- Set active marker to 20s; press Play
- Expected: playback starts from 20s, not from 0

### 7.5 Nudge marker with Shift+Arrow
- Enter close listening; select marker at 20s; press Shift+Arrow Right
- Expected: marker moves forward by 100ms; all waveforms update

### 7.6 Fine nudge with Shift+Alt+Arrow
- Same as 7.5 but with Shift+Alt+Arrow
- Expected: marker moves forward by 20ms

### 7.7 Delete marker with Delete key
- Select a marker in close listening; press Delete
- Expected: marker removed; active marker moves to adjacent marker (or none if last)

### 7.8 Undo marker deletion
- Delete a marker; press Ctrl+Z
- Expected: marker restored at original position

### 7.9 Undo marker addition
- Add a marker; press Ctrl+Z
- Expected: marker removed

### 7.10 Redo
- Add marker, undo, Ctrl+Shift+Z
- Expected: marker restored

---

## 8. Alignment Correction (Drag Markers)

### 8.1 Enable drag mode
- Check **Enable dragging** in Drag Markers fieldset
- Expected: cursor changes to indicate drag mode active; hint tooltip appears on waveforms

### 8.2 Move marker mode — drag a marker
- Add a marker; enable drag with **Move marker** mode; drag the marker on a non-reference waveform
- Expected: marker position updates in real time; releases at new position; all other waveforms show corresponding new aligned position

### 8.3 Fix alignment mode — drag shifts alignment grid
- Enable **Fix alignment** mode with Medium range; drag a marker
- Expected: alignment grid for that waveform is locally warped around the dragged position; alignment visualisation lines update; other waveforms unaffected

### 8.4 Fix alignment — range options
- Test Narrow, Medium, Wide ranges
- Expected: Narrow produces tight local shift; Wide produces broad smooth shift

### 8.5 Fix alignment — Ctrl+drag applies to all waveforms
- Ctrl+drag a marker in Fix alignment mode
- Expected: all non-reference waveforms receive the same alignment correction (not just the dragged one)

### 8.6 Cannot drag reference audio or score waveform
- Attempt to drag a marker on the reference audio waveform
- Expected: drag has no effect; no error
- If a synthesised score waveform is present, attempt to drag a marker on it as well
- Expected: drag has no effect; no error

### 8.7 Revert alignment edits
- Make several drag corrections; click **Revert alignment edits**
- Expected: all alignment grids return to original state; alignment visualisation updates

### 8.8 Undo alignment fix
- Fix alignment; press Ctrl+Z
- Expected: alignment grid reverts to state before fix

### 8.9 Alignment fix persisted in saved JSON
- Fix alignment, save data, inspect JSON
- Expected: modified alignment grid values present in the corresponding file's grid in `body`

---

## 9. File Groups

### 9.1 Default grouping — ungrouped files
- Load alignment JSON with no group configuration
- Expected: all recording files appear in an "Ungrouped recordings" section in the sidebar and content pane; if a synthesised score waveform is present it appears in its own separate "Score" section alongside the ungrouped recordings

### 9.2 Grouping modal — create a group
- Open **Group files**; assign 2 files to a new group "Group A"; save
- Expected: sidebar shows "Group A" fieldset with 2 files; content pane shows waveforms under "Group A" heading

### 9.3 Grouping modal — pattern matching
- Set a group's **Pattern** to a regex matching 2 filenames; save
- Expected: matching files appear in that group automatically

### 9.4 Grouping tabs — create a second tab
- Open Group files modal; create Tab 2 with different grouping; save
- Expected: tab pills appear at top of content pane; switching pill changes content-pane grouping

### 9.5 Grouping tabs — switch tab updates sidebar
- Switch to Tab 2
- Expected: sidebar groups update to Tab 2's structure

### 9.6 Drag to reorder files within group
- Drag a file to a new position within its group
- Expected: file appears at new position in sidebar and content pane; order persists after reload (saved in JSON)

### 9.7 Drag to reorder groups
- Drag an entire group to a new position
- Expected: group appears at new position in both sidebar and content pane

### 9.8 Group All/None buttons
- In a group of 3, click **None** then **All** in the content pane header
- Expected: all 3 waveforms hide then show; group counts update

### 9.9 Groups saved to JSON
- Configure groups, save data, reload with saved JSON
- Expected: same grouping configuration present after reload

---

## 10. Tempo Curves

### 10.1 Tempo curve enabled — QPM mode
- Enable **Tempo curve** with QPM mode selected
- Expected: tempo curve overlay appears on each waveform; Y-axis labelled "QPM"; values in plausible range (30–300 QPM)

### 10.2 Tempo curve enabled — Deviation mode
- Switch to Deviation mode
- Expected: curve shows percentage deviation; Y-axis shows %; zero line visible; scope controls appear

### 10.3 Scope controls hidden in QPM mode
- Select QPM mode
- Expected: "Within group / Across groups" radios and "Only visible" checkbox are not visible

### 10.4 Scope controls visible in Deviation mode
- Select Deviation mode
- Expected: scope controls are visible

### 10.5 Smoothing slider
- Move smoothing slider from 0 to 5
- Expected: tempo curve becomes visually smoother; Y-axis range may narrow

### 10.6 Y-axis range uniform across waveforms
- Enable tempo curves with multiple waveforms
- Expected: Y-axis scale is identical on all visible waveforms

### 10.7 Clipping indicators
- Use a corpus with extreme tempo outliers (structural mismatch)
- Expected: red triangles visible at top/bottom edges of waveforms at clipped regions

### 10.8 Hover shows tempo value
- Enable tempo curves; hover over waveform
- Expected: hover time tooltip includes tempo value (e.g., "1:23.4 — 145 QPM" or "1:23.4 — +12% avg.")

### 10.9 Scope: Within group
- Configure two groups; enable Deviation; select "Within group"
- Expected: each group's curves deviate relative to their own group's median, not the full corpus

### 10.10 Scope: Only visible
- Hide one waveform; enable "Only visible"
- Expected: hidden file excluded from corpus reference; curves update

### 10.11 Tempo curve state restores after reload
- Enable tempo curve in Deviation mode with smoothing=3; reload
- Expected: tempo curve still visible in Deviation mode with smoothing=3

---

## 11. Time Axis

### 11.1 Time ticks visible
- Load waveforms
- Expected: time axis labels visible on each waveform (e.g., "0:30", "1:00")

### 11.2 Time ticks visible during playback
- Play audio and observe time axis
- Expected: time axis labels do not disappear during playback

### 11.3 Time ticks visible when switching active waveform during playback
- Play audio; press Arrow Down to switch waveform
- Expected: time axis labels remain on all waveforms after switch

### 11.4 Time ticks at various zoom levels
- Step through zoom levels 0–5
- Expected: tick density adapts (fewer ticks when zoomed out, more when zoomed in); labels never overlap

---

## 12. Save & Load

### 12.1 Save data produces valid JSON
- Load alignment via `/?useFiles`, add 2 markers, fix one alignment; click **Save data**
- Expected: file `alignment.json` downloaded; parseable JSON; `header.markers` has 2 entries; modified grid present in `body`

### 12.2 Reload saved JSON restores state
- Save, then reload page with saved file via `?useFiles`
- Expected: same files, same groups, same markers present; alignment grids match saved state

### 12.3 Dirty state indicator
- Load alignment; make a change (add marker, fix alignment)
- Expected: "Save data" button shows unsaved-changes indicator (orange dot or similar)

### 12.4 Unsaved changes warning not shown on first load
- Load alignment without making changes
- Expected: no dirty indicator visible

---

## 13. Manage Files Modal

### 13.1 Modal opens and closes
- Click **Manage files**; modal appears; click close
- Expected: modal dismisses cleanly

### 13.2 Linked Data URIs tab — set global prefix
- Open modal → Linked Data URIs tab; enter `https://example.com/audio/`
- Expected: all per-file resolved URIs update to show prefix + filename

### 13.3 Linked Data URIs tab — per-file override
- Set a per-file LD Filename override; observe resolved URI
- Expected: resolved URI uses override filename, not original

### 13.4 URI configuration saved to JSON
- Set prefix, save data, inspect JSON
- Expected: `header.linkedDataUriPrefix` present in saved file

---

## 14. Error & Edge Cases

### 14.1 Audio 404 error
- Load alignment JSON referencing a non-existent audio URL
- Expected: that waveform shows an error overlay; other waveforms load normally; no crash

### 14.2 Auth prompt on HTTP 401
- Point `?data=` at a URL behind Basic Auth
- Expected: auth prompt appears; entering correct credentials loads the file; cancelling shows error

### 14.3 Zero-waveform state
- Uncheck all waveforms via **None** buttons
- Expected: content pane is empty but no crash; re-checking waveforms restores display

### 14.4 Single waveform loaded
- Load alignment JSON with only one audio file
- Expected: single waveform renders; alignment/position overlays do not crash; tempo curve works if score alignment present

### 14.5 Very short audio file (< 5s)
- Include a very short clip in the test corpus
- Expected: waveform renders; time ticks adapt; no division-by-zero errors in tempo or position calculations

### 14.6 Very long audio file (> 30 min)
- Include a long clip if available
- Expected: waveform renders at zoom level 0; no out-of-memory or timeout error; zoom-in scroll works

### 14.7 Large number of waveforms (10+)
- Load alignment JSON with 10+ files
- Expected: all waveforms render (may take time); scroll sync remains functional; no crash

### 14.8 Rapid play/pause toggling
- Click Play/Pause 10 times in quick succession
- Expected: app remains in consistent state; no dangling audio contexts or position desync

### 14.9 Switching active waveform rapidly
- Press Arrow Down 5 times quickly
- Expected: final active waveform is correct; no audio glitches; position indicator correct

### 14.10 Zoom in, scroll to end, switch to waveform with different duration
- At zoom 3, scroll to end of short file, switch to longer file
- Expected: no crash; scroll position is reasonable (not past end of new file)

---

## 15. Cross-Browser & Accessibility

### 15.1 Chromium (primary)
- All scenarios above pass in Chromium/Chrome

### 15.2 Firefox
- File loading via blob URL (key regression: blob cross-origin fix)
- Play/pause, seeking
- Scroll sync
- Expected: no `Security Error: Content at ... may not load data from blob:` errors

### 15.3 WebKit/Safari
- Basic load, play/pause, zoom
- Expected: no crashes; audio plays

### 15.4 Keyboard-only navigation
- Tab through controls; activate play/pause, zoom, checkboxes via keyboard
- Expected: all interactive elements reachable and operable via keyboard

### 15.5 Viewport resize
- Resize browser window while waveforms loaded
- Expected: waveforms reflow; zoom-level-0 waveforms resize to fit new container; no broken layout

---

## 16. Performance Regression Guards

Performance tests measure wall-clock time for specific operations using `performance.now()` via `page.evaluate()`. Thresholds are set at roughly **3× the expected time on the CI machine** — generous enough to avoid flakiness from CI jitter, tight enough to catch 10× regressions.

Playwright mechanisms used:
- `page.evaluate(() => performance.now())` — measure time before/after an action in the page context
- `page.waitForFunction(predicate, { timeout })` — assert a condition is met within a time limit; test fails (timeout) if it isn't
- `page.waitForSelector(selector, { state: 'visible', timeout })` — assert an element appears within budget
- `cdpSession.send('Performance.getMetrics')` (Chromium only) — JS heap, DOM node count, script duration

A reusable helper for all timing tests:
```js
// Returns elapsed ms for an async action
async function measureMs(page, action) {
  const t0 = await page.evaluate(() => performance.now());
  await action();
  return await page.evaluate(() => performance.now()) - t0;
}
```

Thresholds should be recorded as named constants in a `perf-thresholds.js` fixture file so they can be updated in one place as hardware changes.

---

### 16.1 Initial load — first waveform visible
- Navigate to `/?data=<local-alignment-url>`
- Measure time from `page.goto()` to `page.waitForSelector('.waveform canvas', { state: 'visible' })`
- **Threshold:** 5 000 ms (local server, 3 files)
- Regression signal: catches slow WaveSurfer init, layout thrashing on startup, synchronous blocking in `DOMContentLoaded` handlers

### 16.2 All waveforms ready (decode complete)
- After navigation, wait for all `redrawcomplete` events (or a sentinel element the app sets on full load)
- Measure time from navigation to last waveform ready
- **Threshold:** 15 000 ms (3 × ~3 min files, local)
- Regression signal: catches added synchronous work in the `ready` handler or in `prepareWaveform()`

### 16.3 Zoom level change
- With 5 waveforms loaded at zoom 0, measure time to change to zoom level 3 and await all canvases repainted
- `const ms = await measureMs(page, () => zoomSlider.fill('3'))`; then `waitForFunction` checking canvas widths updated
- **Threshold:** 500 ms
- Regression signal: catches quadratic work in zoom handler or synchronous peaks re-render

### 16.4 Scroll sync latency
- At zoom 3, programmatically `scrollLeft` one waveform's scroll container by 500px; measure time until all other waveform containers reach the same `scrollLeft`
- Use `page.waitForFunction(() => allScrollsMatch(), { timeout: 200 })`
- **Threshold:** 100 ms
- Regression signal: catches added synchronous work in the scroll event handler or broken `_scrollSyncLock` debouncing

### 16.5 Alignment grid render on scroll
- Enable **Visualise alignments**, zoom to level 3, measure time for `drawAlignmentGrid()` to complete across all waveforms during a programmatic scroll of 1000px
- Instrument via `window._lastGridDrawMs` (a test-only global the app sets after each draw) and poll it
- **Threshold:** 100 ms per scroll event
- Regression signal: catches O(n²) grid iteration or re-introduction of `getComputedStyle` layout thrashing

### 16.6 Tempo curve computation — first render
- Enable **Tempo curve** (QPM mode) with 5 waveforms; measure time from checkbox click to all curves visible
- `const ms = await measureMs(page, () => tempoCheckbox.check())` + `waitForFunction` checking `_tempoYRange !== null` via `page.evaluate`
- **Threshold:** 2 000 ms
- Regression signal: catches regressions in `_computeRawTempo`, `_recomputeTempoYRange`, or the smoothing pipeline

### 16.7 Tempo curve recompute on smoothing change
- With curves visible, drag smoothing slider from 0 to 10; measure time to repaint
- **Threshold:** 500 ms
- Regression signal: catches cache invalidation bugs that force full re-decode instead of using cached raw data

### 16.8 Tempo curve recompute on scope change (Deviation mode)
- In Deviation mode with 10 waveforms, switch from "Across groups" to "Within group"
- **Threshold:** 1 000 ms
- Regression signal: catches `_computeCorpusMeanTempo` becoming O(n²) or re-running for every waveform independently

### 16.9 Marker add/remove latency
- In a loop, add and remove a marker 20 times; measure total elapsed time
- **Threshold:** 200 ms total (10 ms per add+remove cycle)
- Regression signal: catches O(n) per-marker work that should be O(1)

### 16.10 Memory — no heap growth over repeated play/pause cycles
- Using `cdpSession.send('Performance.getMetrics')`, record JS heap size after load
- Play/pause 50 times; record heap size again
- **Threshold:** heap growth < 10 MB
- Regression signal: catches AudioContext leaks, detached canvas accumulation, or closure retention of large arrays

### 16.11 DOM node count stability
- Record DOM node count after initial load (`Performance.getMetrics → Nodes`)
- Show/hide all waveforms 10 times; record count again
- **Threshold:** count must not grow (± 50 nodes tolerance for transient elements)
- Regression signal: catches leaked waveform DOM elements on hide/show cycles

---

### Performance Test Fixtures

- Tests 16.1–16.9 use **local** server only (remote network variance would make thresholds unreliable in CI)
- Thresholds should be **calibrated on the CI machine** on first run and stored in `perf-thresholds.js`; failing tests print both actual and threshold values to aid diagnosis
- Consider running performance tests as a separate Playwright project (`--project=perf`) so they can be skipped in fast feedback loops and run nightly or pre-merge

---

## 17. In-Browser Alignment Workflow (`/?mode=align`)

The alignment wizard is a 4-step flow: **Files → Quality → URIs → Align**. All steps are served at `/?mode=align`; the `#align-panel` is shown and the listen interface hidden.

### 17.1 Landing page shows alignment wizard
- Navigate to `/?mode=align`
- Expected: `#align-panel` visible; step indicator shows Step 1 (Files) active; listen interface hidden

### 17.2 Step 1 — load files via Choose Files button
- Click **Choose Files**; provide `audio-a.mp3`, `audio-b.mp3`, `audio-c.mp3` via `page.setInputFiles`
- Expected: file table populates with 3 rows showing filename and duration; one file auto-selected as reference

### 17.3 Step 1 — load files via drag and drop
- Drag `audio-a.mp3` and `audio-b.mp3` onto `#align-drop-zone`
- Expected: same as 17.2 — file table populates correctly

### 17.4 Step 1 — change reference audio
- Load 3 files; click the **Ref** radio for `audio-b.mp3`
- Expected: `audio-b.mp3` marked as reference; others marked as comparison files

### 17.5 Step 1 → Step 2 navigation
- Load at least 2 files; click **Next**
- Expected: Step 2 (Quality) becomes active; quality preset radios visible; Back button enabled

### 17.6 Step 2 — quality preset selection
- Select **Fast**, then **High quality**, then back to **Balanced**
- Expected: selected preset highlighted; advanced parameter fields update to reflect preset values

### 17.7 Step 2 — advanced parameters
- Expand the **Advanced parameters** section; change **Coarse resolution** to 1
- Expected: quality switches to "Custom" mode; reset link appears; clicking reset restores the preset values

### 17.8 Step 2 — include alignment settings checkbox
- Uncheck **Include alignment settings in output**
- Expected: checkbox unchecked; setting persists to Step 4

### 17.9 Step 2 → Step 3 navigation
- Click **Next** from Step 2
- Expected: Step 3 (URIs) active; MEI URI and audio URI prefix fields visible

### 17.10 Step 3 — MEI URI input
- Enter a valid MEI URL in the **MEI URI** field
- Expected: value accepted; no validation error

### 17.11 Step 3 — audio URI prefix input
- Enter `https://example.com/audio/` in the **Audio URI prefix** field
- Expected: value accepted

### 17.12 Step 3 → Step 4 navigation
- Click **Next** from Step 3
- Expected: Step 4 (Align) active; alignment summary visible; **Start Alignment** button enabled

### 17.13 Step 4 — peaks checkbox and count
- Uncheck **Include pre-calculated waveform envelope**; change peaks count to 2048
- Expected: peaks row reflects changes; file size estimate updates

### 17.14 Step 4 — start alignment and progress
- Click **Start Alignment**
- Expected: progress bar appears; step list shows incremental progress messages; elapsed time updates; button disabled during alignment

### 17.15 Step 4 — alignment completes
- Wait for alignment to finish (may take 30–120s depending on quality setting; use **Fast** for tests)
- Expected: `#align-results` shown with "Alignment complete!"; **Save data** and **Listen!** buttons appear; progress bar at 100%

### 17.16 Save data from alignment results
- After alignment completes, click **Save data**
- Expected: `alignment.json` downloaded; file is valid JSON with `header`, `body`, and (if MEI URI provided) `scoreAlignment` fields

### 17.17 Listen! — transition to listen mode
- After alignment completes, click **Listen!**
- Expected: URL changes to `/?useFiles`; listen interface shown; waveforms load and sync correctly for all aligned files; no page reload

### 17.18 Back navigation through steps
- Reach Step 4; click **Back** twice to return to Step 2
- Expected: step indicator updates correctly; previously entered values (quality preset, advanced params) are preserved

### 17.19 Quality setting persisted across sessions
- Select **High quality**, navigate away, return to `/?mode=align`
- Expected: **High quality** preset still selected (persisted in localStorage)

### 17.20 Alignment with MEI URI — score waveform appears after Listen!
- Provide a public MEI URI in Step 3; complete alignment; click Listen!
- Expected: synthesised score waveform appears above recordings in listen mode

### 17.21 Error — fewer than 2 files provided
- Load only 1 file; attempt to proceed past Step 1
- Expected: Next button disabled or error shown; cannot proceed to Step 2

### 17.22 Performance — alignment completes within time budget
- Run alignment on 3 × ~3 min files at **Fast** quality
- **Threshold:** 120 000 ms
- Regression signal: catches regressions in DTW worker, feature extraction, or audio decode pipeline

---

## 18. Annotations & Solid / Linked Data

> **Note on test infrastructure:** Solid OAuth and pod interactions require either a live Solid server (e.g. a dedicated test pod on CSS or NSS) or a mock server intercepting the relevant endpoints via `page.route()`. Scenarios 18.1–18.4 (annotation drawing) do not require Solid auth. Scenarios 18.5 onwards require a test Solid pod or mock.

### 18.1 Draw an annotation region on a waveform
- With a waveform loaded, enter annotation draw mode; click and drag across a region of the waveform
- Expected: a coloured rectangle (draft annotation region) appears spanning the dragged time range; region is visible on the waveform

### 18.2 Multiple annotation regions — distinct colours
- Draw three annotation regions in sequence
- Expected: each region receives a distinct colour from the rotating palette; all three are simultaneously visible

### 18.3 Annotation region persists after seeking and scrolling
- Draw a region; seek and scroll away; scroll back
- Expected: region still visible at the correct time position; not displaced or resized

### 18.4 Annotation region removed on delete
- Draw a region; select it; delete it
- Expected: region disappears from the waveform canvas

### 18.5 Solid drawer opens and shows login prompt
- Click the RDF/Solid button
- Expected: Solid drawer slides in; "Click here to log in" prompt visible; status dot reflects unauthenticated state

### 18.6 Solid OAuth login flow
- Click the login prompt; complete OAuth flow against the test Solid pod (or intercept with `page.route()`)
- Expected: drawer updates to show authenticated state; user identity displayed; status dot changes colour

### 18.7 Post annotation to Solid pod
- Authenticate; draw an annotation region; submit it via the Solid annotation interface
- Expected: POST/PATCH request sent to the pod's annotation container; success confirmation shown in drawer; annotation persists (re-fetched on next load)

### 18.8 Fetch existing annotations from Solid pod
- Authenticate against a pod that already contains annotations for the loaded work
- Expected: annotations are fetched on load; corresponding regions rendered on the correct waveforms at the correct positions

### 18.9 Create a MAO selection
- Authenticate; select a time region on a waveform; create a MAO selection via the annotation interface
- Expected: a `mao:Selection` resource is created in the pod's selection container; the selection is linked to the correct audio URI and time interval

### 18.10 Annotation requires audio URI to be set
- Attempt to post an annotation without a Linked Data URI configured for the file
- Expected: informative error or tooltip shown (e.g. "Set a URI prefix in Manage Files"); no broken request sent

### 18.11 Solid logout
- Authenticate; click logout in the Solid drawer
- Expected: authenticated state cleared; login prompt reappears; status dot returns to unauthenticated state

### 18.12 Solid drawer closes before walkthrough / other interactions
- Open Solid drawer; trigger any other major UI action (play, zoom change)
- Expected: drawer does not interfere with main interface interactions; can be closed with the ✕ button

---

## Appendix: Test Fixture Requirements

| Fixture | Description |
|---|---|
| `audio-a.mp3` | ~3 min, standard tempo, public domain |
| `audio-b.mp3` | ~3 min, slightly faster tempo than A |
| `audio-c.mp3` | ~2.5 min, different repeat structure (structural mismatch) |
| `audio-short.mp3` | < 5s, for edge-case testing |
| `alignment.json` | Alignment of A, B, C, short against B as reference; includes score alignment via pinned MEI URI |
| `alignment-malformed.json` | Invalid JSON structure (for error testing) |
| `Schumann-Clara_Romanze-ohne-Opuszahl_a-Moll.mei` | MEI score for score synthesis testing. Pinned to commit [`b58c300`](https://raw.githubusercontent.com/trompamusic-encodings/Schumann-Clara_Romanze-in-a-Moll/b58c300/Schumann-Clara_Romanze-ohne-Opuszahl_a-Moll.mei) for reproducibility. A local copy is stored in `tests/fixtures/`. |
