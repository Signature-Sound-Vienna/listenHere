// exhibit/config.js
//
// Display geometry, as configuration rather than as assumptions baked into CSS.
//
// The laptop, the iPad, and the eventual museum table are three CONFIGURATIONS of
// one build, not three builds (plan §7.8). The hardware install date is an
// external dependency with no date attached, so the geometry has to be a value we
// can change rather than a layout we have to rewrite — and if the table turns out
// to be a different size or a different split, that must cost a query parameter.
//
// Every field is overridable from the query string, which is how Spike C was run
// across two very different screens without editing it. Same idea here.
//
// ZERO imports, by rule (see ENGINE-WANTS.md).

/**
 * Two viewports facing each other across the table: the portrait screen splits
 * into two landscape halves, and the far half is rotated 180° so the person on
 * the other side reads it the right way up.
 *
 * Measured on the real device 2026-08-24: the 13-inch iPad Air is 1024×1366 CSS
 * at dpr 2, so each half gets 1024×~640 and eight 54 px strips use 432 px of it.
 */
const DEFAULTS = {
  // --- content selection ---
  // Which prepped payload to load. The stretch goal for the attract loop is a
  // second piece (Kaiserwalzer, which needs no annotations to autoplay), so the
  // piece is a parameter from the start rather than a path spelled out in the
  // loader — `?piece=kaiserwalzer` is the whole change.
  piece: "fledermaus",

  // --- geometry ---
  viewports: 2,
  splitOrientation: "horizontal", // "horizontal" = stacked halves; "vertical" = side by side
  rotations: [0, 180], // per viewport, degrees; index beyond the end means 0
  stackedRecordings: 8,
  // 48, down from week 1's 54: the commentary panel absorbs whatever height the
  // strips leave over, and at 54 the longest authored text showed two lines on
  // the iPad's halves (measured; annotation-list.js). Six pixels a strip buys
  // the panel ~78 px — the waveforms are the overview, the commentary is the
  // exhibit's voice, and `?stripHeight=54` puts the week-1 look back for an
  // eyeball comparison.
  stripHeight: 48, // CSS px per waveform strip
  middleBandHeight: 96, // conductor, year, portrait — and NO UI labels (plan §6.3)
  // How the shared band handles being read from two opposite sides at once —
  // plan §4.3's orientation question, pulled forward by user feedback after the
  // week-2 eyeballing. Three candidates behind one switch so the user study can
  // compare them live rather than argue about them:
  //   "upright"  — as built: right-way-up for the near visitor, inverted for the far one.
  //   "rotated"  — everything turned 90° (reads from the near visitor's right),
  //                equally sideways for both readers. Costs band height: rotated
  //                text pays for its length vertically, so main.js raises the
  //                band to `middleBandHeightRotated` unless the height was
  //                explicitly overridden.
  //   "mirrored" — two copies, the far one rotated 180°: each reader gets a
  //                right-way-up copy at no height cost, but the piece is named
  //                once per READER rather than once per view.
  bandOrientation: "upright",
  middleBandHeightRotated: 176, // fits the longest sidecar name turned 90°
  // The GENERIC side slot (feedback item 5, 2026-08-24): a region beside the
  // strips, on each viewport's own right — "right" is per READER for free,
  // because the slot lives inside the viewport and rotates with it. The value
  // names the TENANT occupying it; "" keeps the shipped below-strips layout.
  // Deliberately not called "annotationsBeside": the Verovio score view (plan
  // §2.3's optional bonus) is the confirmed second tenant of exactly this
  // split, so the seam is tenant-agnostic and main.js dispatches by name
  // (SIDE_TENANTS). An unknown name changes nothing and warns, rather than
  // narrowing the strips for an empty column.
  sideSlot: "",
  // Percent of the viewport's width the slot takes; the strips keep the rest.
  // 40 leaves the waveforms dominant (the resume note's "~60%" reading), and a
  // different balance is one query parameter, per the §7.8 rule.
  sideSlotWidth: 40,
  // Desktop-debugging convenience, never set on the kiosk: rotate the WHOLE
  // composed screen 90° or 270° so a physically turned laptop or a swivelled
  // monitor shows the portrait kiosk at its intended aspect. Applied as one
  // final-touch transform on #screen (see exhibit.css) — layout, measurement,
  // and WaveSurfer's canvas sizing all run untransformed, and the browser maps
  // pointer coordinates back through the transform, so nothing inside can tell.
  // A query parameter rather than any environment sniffing, by the §7.8 rule:
  // laptop, iPad, and table are configurations of one build.
  stageRotation: 0,

  // --- waveform ---
  // 0 means FIT THE WHOLE RECORDING INTO THE STRIP, which is WaveSurfer's
  // `fillParent` behaviour when `minPxPerSec` is 0. That is the right resting
  // state for this interface and not merely a convenient default: the exhibit's
  // whole proposition is seeing eight interpretations of the *same* moment at
  // once, and at the previous default of 30 px/s a 582 s overture shows about 3%
  // of itself, so the stacked comparison has nothing to compare. Per-viewport
  // zoom and scroll arrive in week 2 (plan §4.2); until then `?zoom=30` is still
  // one query parameter away.
  zoom: 0,
  // The steps the per-viewport zoom buttons walk (1 = fit-to-width, the resting
  // state above). Capped at 8× deliberately: the renderer draws lazily in
  // container-width chunks (measured, see exhibit/zoom.js), but chunks
  // accumulate as a visitor scrolls, and at 8× a fully-scrolled viewport stays
  // inside the canvas-memory envelope Spike C measured on the real iPad. Raise
  // this only with the §7.2 device test in hand.
  zoomLevels: [1, 2, 4, 8],
  // Whether the −/+ zoom buttons render at all (?zoomControls=0 hides them —
  // user feedback doubts their value on the museum floor, so the study panel
  // can flip them off live). The zoom MACHINERY stays wired either way: the
  // moment-synced scroll and the setLevel API do not depend on the buttons.
  zoomControls: true,
  peakBuckets: 4096, // what the alignment JSON ships
  // Regions narrower than this vanish entirely at fit-to-width — 582 s across
  // ~1000 px is 0.58 s per pixel, and `D or E?` region (a) is 0.012–0.120 s wide
  // (plan §5.2d). Sub-pixel regions are widened symmetrically to at least this,
  // and marked provisional when they were flagged for hand placement, rather than
  // being silently dropped or silently drawn at a misleading width.
  minRegionPx: 4,

  // --- content ---
  // Audience and language are resolved PER VIEWPORT, never swapped globally, so
  // these are only the starting values for each half (plan §5.3).
  audiences: ["adults", "adults"],
  languages: ["en", "en"],
  // Feedback item 4 (2026-08-24): offer an "All" position on the audience
  // switch that UNIONS every audience's annotations, each chip marked with the
  // audience it targets (annotation-list.js). Opt-in, current three-way switch
  // stays the default; "all" is a UI pseudo-mode, never a payload audience —
  // the payload's byAudience index and the AUDIENCES list are untouched. In
  // this comparison view audience is exactly an annotation filter; future
  // views (programme listings, quizzes) will need their own answer, which is
  // why this is a switch option and not a change to the filter's meaning.
  audienceAll: false,

  // --- appearance ---
  // Palette preset (exhibit/themes.js): "dark" is the shipped look; the others
  // are study-panel discussion placeholders, not candidate finals.
  theme: "dark",
  // Per-category pins on top of the preset — empty means "follow the preset".
  // Eight categories so museum-staff discussions can bikeshed one component at
  // a time and every outcome is still just a URL: ?theme=nord&themeWaves=amber.
  themeCanvas: "",
  themeStrips: "",
  themeWaves: "",
  themeCaptions: "",
  themeText: "",
  themeControls: "",
  themeAccent: "",
  themeBand: "",
  // "authored" shows the annotators' own colours (the shipped behaviour);
  // "theme" replaces them with the preset's 12-colour diverging series
  // (themes.js, recolorAnnotations) — divergence strongest at the front, since
  // real payloads carry fewer than 12. Display-only: the payload is untouched.
  annotationColors: "authored",

  // --- focus (main.js's follow machinery) ---
  // What drives each viewport's focused annotation:
  //   "manual"   — taps only (the shipped behaviour).
  //   "playhead" — focus follows the shared clock through region ENTRIES on
  //                the audible recording (each side in its own audience list);
  //                a chip tap PINS focus and suspends following until the
  //                below-layout toggle-off or the side panel's × releases it.
  //                The chip/× machine was designed for exactly this driver
  //                (2026-08-24); the panel never opens or closes by itself —
  //                that stays tap-owned.
  focus: "manual",
  // The agreed definition of "in focus" (2026-08-25) splits it into two
  // surfaces: the WASH — everything painted on or beside the strips (chip
  // highlight, region emphasis, group edges, strip deemphasis) — and the
  // DETAIL — the commentary text, which lingers so playback moving on never
  // snatches away text mid-read. focusWash sets the wash's lifetime:
  //   "clear"  — the wash paints while the playhead is inside a region and
  //              clears when it leaves; the lingering detail keeps a subtle
  //              chip anchor (.is-shown) so the text stays findable.
  //   "sticky" — the wash lingers after exit along with the detail: week 3's
  //              shipped behaviour, kept as the A/B comparator.
  focusWash: "clear",
  // Deemphasize the strips the painted annotation does not target: waveform
  // and caption fade, the background and the grouping edge stay. "auto" = on
  // under ?focus=playhead and off in manual mode, so the untouched manual
  // exhibit stays byte-for-byte the shipped behaviour per the A/B rule;
  // "on"/"off" force it either way.
  focusDim: "auto",
  // Minimum lifetime of the wash's paint, in ms (focusWash=clear only): a
  // region shorter than this — the sub-frame "D or E?" spans — keeps its paint
  // for the bound instead of blinking for one frame. Exits from longer regions
  // clear immediately, and a discontinuity (seek, recording switch) drops held
  // paint at once: jumps land, they do not carry. 0 disables.
  focusHoldMs: 2500,
  // Pin auto-expiry (feedback round, 2026-08-25): "off" (default — pins hold
  // until the machine's unfocus), "auto" (a reading-time heuristic over the
  // shown text: length, audience speed, group story), or a fixed ms value.
  // Near the deadline a "Keep reading…" ring appears; tapping it re-arms the
  // full time. Expiry unfocuses AND re-derives the wash immediately — a
  // timeout is not a dismissal, so the table comes back to life at once.
  pinExpiry: "off",
  // Playback-triggered text fades out (feedback round, 2026-08-25): "off"
  // (the default — the detail is sticky and follows entries instantly),
  // "auto" (each shown text lives for its reading time, the pinExpiry
  // heuristic), or a fixed window ms. When on: text summoned by the wash is
  // displayed for its window, the "Keep reading…" ring warns before the end —
  // squeezed earlier when the next annotation's region arrives sooner (while
  // playing), never below the focusHoldMs floor — and a ring tap bumps the
  // text to its full time, deferring any switch. At the window's end the text
  // catches up to whatever is relevant then, or fades out entirely. Under
  // ?sideSlot=annotations the same machine opens the panel on entry and
  // closes it on fade; a chip tap still pins, exempt from all of this.
  detailFade: "off",
  // The shown annotation's TITLE above its commentary (ruled 2026-08-25):
  // once playback switches the text (?focus=playhead) and ?detailFade removes
  // it, "which annotation am I reading?" needs answering where the reader is
  // looking. "auto" = title under ?focus=playhead only, so the manual exhibit
  // stays byte-for-byte the shipped behaviour per the A/B rule (the focusDim
  // pattern); "on"/"off" force it either way.
  detailTitle: "auto",
  // The detail header's "Jump to annotation" button: make a recording the
  // shown annotation targets audible at its earliest region start — the
  // active recording when targeted, else the first targeted strip in stack
  // order. ON EVERYWHERE by explicit ruling (user, 2026-08-25) — a deliberate
  // departure from params-keep-defaults, because in manual mode the chips are
  // pure focus controls and this is the only direct route from a text to its
  // music; "off" keeps it A/B-testable.
  detailJump: "on",

  // --- tap semantics (alpha-tester feedback, 2026-08-26) ---
  // What a tap on a NON-ACTIVE waveform means:
  //   "aligned" — the shipped behaviour: switch to that recording and carry
  //               the current musical moment across through the alignment;
  //               the tap's x-position is deliberately ignored (spec 34.8).
  //   "direct"  — the tap is taken literally on BOTH axes: switch to that
  //               recording AND seek to the tapped time (the turns.jump path,
  //               so the ruled jump semantics apply — explicit time honoured
  //               across the switch, plays if paused, the reader's own seek
  //               for the fade rules). Because this removes the aligned
  //               switch from the strips, direct mode also mounts the SWITCH
  //               STRAP (strap.js): a per-recording button column left of the
  //               waveforms whose buttons do the aligned switch instead.
  tapMode: "aligned",

  // --- the listening marker (week 4, ruled 2026-08-27; marker.js) ---
  // "glass" mounts one magnifying-glass marker per viewport, resting on a hook
  // in the left rail (the strap's column; aligned mode reserves the same
  // column for the hook alone). Anchored as an alignment index: while YOUR
  // marker exists, your bare recording switches land on it instead of
  // carrying the moment — the marker's existence IS the mode. Placement,
  // moving, and adoption route through the jump path as the reader's own
  // seek; a marker-snap switch counts as a SEEK for the fade rules (ruled).
  // "off" is the shipped behaviour, byte-identical per the A/B rule.
  marker: "off",

  // --- turn-taking (plan §4.3; turns.js) ---
  // Which policy a tap goes through when the OTHER side holds the clock:
  //   "hijack"      — take it instantly, silently (the shipped behaviour).
  //   "attribution" — take it instantly, but tell the side that lost it.
  //   "request"     — while the other side is actually listening, a tap becomes
  //                   a request they grant or deny (auto-grant below).
  // "hijack" stays the default so the variants are opt-in per the A/B rule.
  turnPolicy: "hijack",
  // request policy: a pending request is granted by itself after this many ms,
  // so an absent visitor can never lock the table. 0 = explicit grant only.
  turnGrantMs: 8000,
  // How long the transient notices stay ("the other side changed the
  // recording", "…is still listening") before fading. UI only.
  turnNoticeMs: 4000,
  // Room-level audio arbitration (arbiter.js): "local" is inert single-screen
  // behaviour; "broadcast" pauses this screen when another same-profile window
  // claims the room's audio. Last claimant wins.
  arbiter: "local",

  // --- operations ---
  // Warm the audio at boot (user ruling 2026-08-26, from the iPad §7.2 round:
  // the exhibit must not be half-ready for its first visitor). "off" is the
  // shipped behaviour — each recording's first tap pays its ~9 MB fetch; "on"
  // fetches every recording's bytes sequentially after boot, reference first,
  // so every later first tap builds from warm bytes. Bytes only: players are
  // still built on first use, so decoded memory stays governed by playerCache.
  preload: "off",
  // How many built players the transport keeps alive (LRU). 2 keeps an A/B
  // comparison instant at ~18 MB of blob; 8 pins every player once built and
  // makes all switches permanent-instant — pending the week-4 soak's memory
  // verdict (plan §7.4) before it becomes the kiosk value.
  playerCache: 2,
  // Show "Loading…" only after a wait this long, in ms (0 = immediately, the
  // shipped behaviour). Once the cache is warm a switch completes in well
  // under half a second, and a text that flashes for two frames between
  // seamless switches reads as a glitch (user, 2026-08-26); with a grace it
  // appears only when there is a genuine wait to explain.
  loadingGrace: 0,
  attractAfterIdleMs: 0, // 0 disables the attract loop; week 4 turns it on
  // ?studyPanel=true mounts the staff-facing cog + tabbed parameter panel
  // (study-panel.js) for in-situ design discussion. Never on for visitors.
  studyPanel: false,
  debug: false,
};

/** Coerce a query-string value to the type of the default it is replacing. */
function _coerce(raw, fallback) {
  if (Array.isArray(fallback)) {
    const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
    if (!parts.length) return fallback;
    return typeof fallback[0] === "number" ? parts.map(Number) : parts;
  }
  if (typeof fallback === "number") {
    const n = parseFloat(raw);
    return Number.isFinite(n) ? n : fallback;
  }
  if (typeof fallback === "boolean") return raw !== "0" && raw !== "false";
  return raw;
}

/**
 * Resolve the display configuration, letting the query string override any field.
 *
 * @param {string|URLSearchParams} [search] defaults to the current location
 * @returns {typeof DEFAULTS} a fresh object; DEFAULTS is never mutated
 */
export function readConfig(search = typeof location === "undefined" ? "" : location.search) {
  const q = search instanceof URLSearchParams ? search : new URLSearchParams(search);
  const out = { ...DEFAULTS };
  for (const [key, fallback] of Object.entries(DEFAULTS)) {
    if (!q.has(key)) continue;
    out[key] = _coerce(q.get(key), fallback);
  }
  // A viewport count the other per-viewport arrays cannot cover is a config bug
  // that would otherwise surface as an undefined rotation halfway through layout.
  out.viewports = Math.max(1, Math.round(out.viewports));
  return out;
}

/** Rotation in degrees for viewport `i` — 0 for anything the config doesn't name. */
export function rotationFor(config, i) {
  return Number(config.rotations?.[i]) || 0;
}

export { DEFAULTS };
