// exhibit/study-panel.js
//
// The in-situ design-discussion panel (`?studyPanel=true`): a cog in the corner
// that opens a tabbed panel of the exhibit's A/B parameters, so competing
// design-space points can be flipped between live at a table instead of argued
// about from memory. STAFF TOOLING, not visitor UI — which is why it is exempt
// from the strings catalogue (English literals, like the console), exempt from
// the no-labels rule, and appended to document.body so the stage rotation and
// the viewport transforms never touch it.
//
// HOW A CHANGE APPLIES: by REWRITING THE QUERY STRING AND RELOADING, never by
// live-patching. Almost every parameter is consumed at boot (renderer heights,
// WaveSurfer colours, viewport count), boot is sub-second from the HTTP cache,
// and the reload buys the property that makes this a study tool rather than a
// toy: THE URL IS ALWAYS THE COMPLETE CONFIGURATION. Copy it out of the footer
// mid-discussion and that design-space point is saved. Values equal to the
// default are REMOVED from the URL rather than written, so the query string
// stays a minimal diff against the shipped exhibit.
//
// Parameters are declared in TABS below — adding a config field to the panel is
// one entry there, nothing else (a per-viewport field: one entry per slot, with
// `index`).

import { DEFAULTS } from "./config.js";
import { PALETTES, CATEGORY_KEYS, categoryOptions } from "./themes.js";

/** Panel labels for the theme categories (staff-facing English, see header). */
const CATEGORY_LABELS = {
  canvas: "Canvas (background)",
  strips: "Strips",
  waves: "Waveforms",
  captions: "Strip captions",
  text: "Commentary text",
  controls: "Controls & chips",
  accent: "Accent",
  band: "Middle band",
};

/** Panel labels for the views, the toolbar switch's own wording (strings.js `view.*`). */
const VIEW_LABELS = { listen: "Listen", years: "Year by year", conductors: "Conductors" };

// Every param carries a `hint` — the 1–2-sentence explanation behind its
// header (user, 2026-08-27). Rendered as a title tooltip for a desktop hover
// AND as a tap-to-toggle line under the row, because the panel's real home is
// an iPad, where hover does not exist.
const TABS = [
  {
    id: "layout",
    label: "Layout",
    hint: "Screen geometry: viewports, strips, and the side panel.",
    params: [
      {
        key: "viewports",
        label: "Viewports",
        options: [1, 2],
        hint:
          "How many visitor stations the screen splits into. The table is two facing halves; 1 is a single-reader debug view.",
      },
      {
        key: "languages",
        index: 0,
        label: "Near half language",
        options: ["en", "de"],
        display: (v) => (v === "de" ? "Deutsch" : "English"),
        hint: "The language viewport 0 reads: the explorers, the attract band, and every catalogue string. German strings arrive from the in-house translation; a string without one falls back to English.",
      },
      {
        key: "languages",
        index: 1,
        label: "Far half language",
        options: ["en", "de"],
        display: (v) => (v === "de" ? "Deutsch" : "English"),
        hint: "The language viewport 1 reads. One URL parameter for both halves: ?languages=<near>,<far>.",
      },
      {
        key: "splitOrientation",
        label: "Split",
        options: ["horizontal", "vertical"],
        hint:
          "How the screen divides into viewports: stacked halves (horizontal), or side by side (vertical).",
      },
      {
        key: "stageRotation",
        label: "Stage rotation (desktop)",
        options: [0, 90, 270],
        hint:
          "Desktop debugging only: turns the whole composed screen so a physically rotated monitor shows the portrait kiosk at its intended aspect. Never set on the kiosk itself.",
      },
      {
        key: "stripHeight",
        label: "Strip height (px)",
        // 38 IS THE SHIPPED VALUE and was missing from this list until
        // 2026-09-01, so the panel could not put the exhibit back the way it
        // found it. The taller options stay, and are still worth trying — but
        // read the FIT LINE in the footer after picking one: strips and the
        // commentary share one budget, and at ten recordings 48 px takes the
        // description text to zero pixels visible with nothing failing.
        options: [32, 38, 44, 48, 54],
        hint:
          "Height of each waveform strip. The commentary panel is the RESIDUAL — it gets whatever the strips leave — so a taller strip is paid for out of the text. 38 is shipped; watch the fit line in the footer.",
      },
      {
        key: "activeStrip",
        label: "Audible strip",
        options: ["surface", "edge", "glow", "bars"],
        hint: "How loudly the strip the clock runs on says so (alpha-tester feedback, 2026-09-10: too subtle). surface is the shipped look — a brighter surface and waveform; edge adds an accent line along its top; glow an accent ring and soft glow round it; bars a small three-bar glyph after the caption that moves while the music plays.",
      },
      {
        key: "stackedRecordings",
        label: "Recordings",
        // 10 since 2026-09-01, when the author raised the cap and named
        // VPO-2002. Without it here the panel could not select the shipped set.
        options: [4, 6, 8, 10],
        hint:
          "How many curated recordings each viewport stacks. The exhibit's claim is the same moment across ten interpretations; fewer is a debug view. More strips means less commentary — see the fit line.",
      },
      {
        key: "zoomControls",
        label: "Zoom buttons",
        options: [true, false],
        display: (v) => (v ? "show" : "hide"),
        hint:
          "Show or hide the −/+ buttons on each viewport's toolbar. The zoom machinery itself (moment-synced scroll, the API) stays wired either way.",
      },
      // The generic side slot (feedback item 5): options name TENANTS, and the
      // score view will add itself here when it lands (main.js SIDE_TENANTS).
      {
        key: "sideSlot",
        label: "Side slot",
        options: ["", "annotations"],
        display: (v) => (v === "" ? "off" : v),
        hint:
          "Moves the commentary body into a panel beside the waveforms instead of below them; the chips stay below either way. The score view is the planned second tenant.",
      },
      {
        key: "sideSlotWidth",
        label: "Side slot width (%)",
        options: [30, 40, 50],
        hint: "How much of the viewport's width the side panel takes; the strips keep the rest.",
      },
    ],
  },
  {
    id: "band",
    label: "Band",
    hint: "The shared strip between the halves: conductor, orchestra, year, and the play button.",
    params: [
      {
        key: "bandOrientation",
        label: "Orientation",
        options: ["upright", "rotated", "mirrored", "flip"],
        hint:
          "How one surface is read from two opposite sides: upright favours the near visitor, rotated is equally sideways for both, mirrored renders two copies with the far one turned 180\u00b0, and flip turns the single cluster to face whichever side last took the clock. Flip costs no band height, and under the hijack policy it turns on every tap \u2014 try it with request.",
      },
      {
        key: "turnIndicator",
        label: "Turn mark",
        options: ["edge", "wash", "off"],
        hint:
          "Marks the side of the band whose tap the clock is answering. Under the request policy that means \u201cthis side may play back\u201d; under hijack and attribution nobody can withhold the audio, so it means \u201cthis side chose what you are hearing\u201d. Edge is a bar on the holder's side, wash a tint rising from it.",
      },
      {
        key: "bandTap",
        label: "Tappable facts",
        options: ["off", "plain", "chip", "underline", "glyph", "shimmer"],
        hint:
          "The band as the interface (plan §11(f)): tap the year to open the by-year explorer at that concert, tap the conductor's name or portrait to open the by-conductor explorer with them — on the tapping reader's own half. Needs the mirrored orientation, because only a copy per reader can say who tapped; anywhere else it resolves to off. The value is the wordless cue the tappable facts wear, to be compared at the user testing rather than picked: plain shows nothing (the discoverability baseline), chip outlines each fact softly and rings the portrait, underline draws a hairline under the name and the year, glyph adds a small chevron after them, shimmer sends a sheen across them and a light once round the portrait's rim, resting between passes on one rhythm (reduced motion gets the underline). A fact is tappable only where the series can follow it: the year when the audible recording is that year's concert, the conductor when the series knows them.",
      },
      {
        key: "bandFlipMotion",
        label: "Flip cue",
        options: ["fade", "spin"],
        hint:
          "How the flip orientation changes over: fade dips the cluster almost out, turns it while it is faint, and lets it settle; spin animates the rotation itself, which reads as a large gesture for a small fact. Only applies to bandOrientation=flip, and reduced-motion gets neither.",
      },
      {
        key: "middleBandHeight",
        label: "Band height (px)",
        options: [72, 96, 120, 176],
        hint:
          "Height of the shared band. Rotated text pays for its length vertically, so that orientation defaults taller (176).",
      },
    ],
  },
  {
    id: "views",
    label: "Views",
    hint: "The explorers of the New Year's Concert series (plan §11): which view each half starts in, and the toolbar switch between them. The band's tappable-facts entry is on the Band tab. The explorers' own styling knobs live here as they arrive.",
    params: [
      {
        key: "views",
        index: 0,
        label: "Near half starts in",
        options: ["listen", "years", "conductors"],
        display: (o) => VIEW_LABELS[o] || String(o),
        hint:
          "Which view viewport 0 — the near, unrotated half — shows at boot: the listening interface, the by-year explorer, or the by-conductor explorer. An explorer draws over that half's strips and commentary while the other half keeps listening; the view switch below is forced on so the half can come back. One URL parameter for both halves: ?views=<near>,<far>.",
      },
      {
        key: "views",
        index: 1,
        label: "Far half starts in",
        options: ["listen", "years", "conductors"],
        display: (o) => VIEW_LABELS[o] || String(o),
        hint: "Which view viewport 1 — the far, rotated half — shows at boot. Ignored with one viewport.",
      },
      {
        key: "viewSwitch",
        label: "View switch",
        options: [false, true],
        hint:
          "Offers each viewport a toolbar switch between the listening interface and the explorers of the whole New Year's Concert series — year by year, and conductor by conductor (plan §11). Off is the shipped exhibit; an explorer draws over this half's strips while the other half keeps listening. Since 0.52.0 this is the debug and fallback entry: the ruled entry is the band (Band tab, “Tappable facts”), and every explorer carries its own close control.",
      },
      {
        key: "dykImages",
        label: "Did-you-know images",
        options: ["on", "off"],
        hint:
          "Whether the “Did you know?” story shows the picture it refers to. The TEXT is content and always on — six concerts and six conductors, told in whichever register this half is set to (Kids, Adults, Scholars), reachable from the chip in the explorer's corner. Two of the twelve stories carry a picture, and both are photographs of unknown licence, so what is drawn today is a placeholder frame at the picture's own shape. Off hides the frame and keeps the text.",
      },
      {
        key: "dykSkin",
        label: "Did-you-know skin",
        options: ["pad", "coil", "plain"],
        hint:
          "How the museum's story is drawn. Pad is a clipboard — paper with ruled lines, a sprung metal clip, a pad of pages under it and a degree of tilt. Coil is a spiral notepad: the same paper with wire loops across the head and punched holes down the left, which costs a little more text width. Plain is the accent rule down its side that the exhibit shipped with through 0.72.0. Nothing about the words changes either way.",
      },
      {
        key: "dykWidth",
        label: "Did-you-know width (%)",
        // 94 is the shipped value and must stay in this list, or the panel
        // cannot put the exhibit back the way it found it (the stripHeight
        // lesson, 2026-09-01). The two narrow rungs are the user's ask of
        // 2026-09-19 — a pad that is visibly a pad ON the card rather than the
        // width of it.
        options: [70, 80, 88, 94, 100],
        hint:
          "How much of the card's width the story's pad takes. It is the other half of the tilt: a rotated sheet needs room for its corners, and this is the room — at 100% any tilt has its corners clipped by the card. WATCH THE NARROW RUNGS with a story that carries a picture: the figure is a fixed 150 px beside the text, so at 70% the text column is squeezed hard, and at one viewport it all but disappears. Ignored when the skin is plain.",
      },
      {
        key: "dykTilt",
        label: "Did-you-know tilt (deg)",
        options: [0, 0.6, 1.3, 2, 3],
        hint:
          "How far the pad is turned, anticlockwise. Nothing in a layout is ever off-square, so a fraction of a degree reads as “put there by a hand”. Each degree swings a tall sheet about 9 px wider, which the width has to cover — 94/1.3 is the shipped pair and clears at both geometries. Ignored when the skin is plain, and stood down entirely under reduced motion.",
      },
      {
        key: "dykFont",
        label: "Did-you-know face",
        options: ["print", "hand"],
        hint:
          "Which face the museum's story is set in. Print is the card's own serif, like the archive data around it; hand is a researcher's handwriting on the notepad the story is drawn as. Handwriting is the riskier choice — harder to read at a glance, and harder again for a visitor with dyslexia or low vision — so print ships and this is here for the October testing to settle. System faces only, since the kiosk has no network.",
      },
    ],
  },
  {
    id: "attract",
    label: "Attract",
    hint: "The unattended loop (plan §4.4): when the whole room has been idle, the table tidies itself, raises the attract band over the middle band, and plays the piece through by itself, switching recordings at the annotations. A touch ends the loop and finds a live table.",
    params: [
      {
        action: "attractNow",
        label: "Demo",
        button: "Start the attract loop now",
        unavailable: "Loop is off — set a timer first",
        hint: "Raises the band and starts a pass at once, whatever the idle clock says (user, 2026-09-10). Needs the loop enabled: the idle timer above 0. Taps on this panel never count as a visitor's, so the panel can stay open while the loop runs.",
      },
      {
        key: "attractAfterIdleMs",
        label: "Screen idle after (ms; 0 = off)",
        options: [0, 15000, 60000, 180000, 300000], // 15 s is for testing and demos
        hint:
          "How long this screen must have gone untouched — touches only; music playing or stopping does not move the count — before its table is tidied and the band comes up. While the other screen is in use the screen rests under the band, mirroring the room; once both screens are past the window the loop plays: from the playhead if music is on the speakers, from the top if the room is silent. 0 is the shipped default until release; the staff preset carries 3 min.",
      },
      {
        key: "attractGapMs",
        label: "Silence between passes (ms)",
        options: [10000, 25000, 40000],
        hint: "The pause after a piece ends before the next pass starts, so the room breathes and a piece starts out of silence.",
      },
      {
        key: "attractReload",
        label: "Reload in the silence",
        options: [true, false],
        hint:
          "Reload the page in the silence: invisible, it flushes anything an eight-hour day accumulates, and it is how the pieces cycle. The leader reloads at the midpoint and the other window later, so the room's worker always keeps a window. Needs the kiosk browser's autoplay policy opened, or the loop resumes as “tap to start”.",
      },
      {
        key: "attractAudience",
        label: "Annotations shown",
        options: ["cycle", "kids", "adults", "expert"],
        display: (v) => (v === "expert" ? "scholars" : v),
        hint: "Whose annotations a pass shows and switches at: cycle walks the three audiences pass by pass, or hold one.",
      },
      {
        key: "attractLogos",
        label: "Logo language",
        options: ["de", "en"],
        hint: "Which language's institutional marks the band shows (mdw, IWK, FWF). The funder's line is bilingual regardless. Undecided (2026-09-07).",
      },
    ],
  },
  {
    id: "theme",
    label: "Theme",
    hint: "The palette, as a preset plus per-surface pins.",
    params: [
      {
        key: "theme",
        label: "Preset",
        options: Object.keys(PALETTES),
        display: (v) => PALETTES[v]?.label || v,
        hint:
          "The whole palette at once: canvas, strips, waveforms, text, controls, and band. Picking a preset clears every per-surface pin below.",
      },
      // One row per themable category: pin it to any palette (or extra
      // variant) independently of the preset. "follow" is the default and
      // keeps the URL clean.
      ...CATEGORY_KEYS.map((cat) => ({
        key: "theme" + cat[0].toUpperCase() + cat.slice(1),
        label: CATEGORY_LABELS[cat] || cat,
        options: ["", ...categoryOptions(cat)],
        display: (v) => (v === "" ? "follow" : v),
        hint:
          `Pins ${(CATEGORY_LABELS[cat] || cat).toLowerCase().replace(/ \(.*\)$/, "")} to any palette independently of the preset — mixing, say, parchment controls into the dark theme. “follow” keeps the preset's own value.`,
      })),
      {
        key: "annotationColors",
        label: "Annotation colours",
        options: ["authored", "theme"],
        display: (v) => (v === "authored" ? "authored" : "theme series"),
        hint:
          "Whose colours the regions and chips wear: the annotators' own authored colours, or the theme's 12-colour series. Display-only; the payload is untouched.",
      },
    ],
  },
  {
    // The central §1 feedback question gets its own tab: which of the three
    // turn-taking policies the exhibit should ship is exactly the kind of
    // decision this panel exists to let staff FEEL rather than argue about.
    id: "turns",
    label: "Turns",
    hint: "Who gets the one shared clock when both sides want it.",
    params: [
      {
        key: "turnPolicy",
        label: "Policy",
        options: ["hijack", "attribution", "request"],
        hint:
          "What a tap does while the OTHER side is listening: hijack takes the audio silently (shipped), attribution takes it but tells the side that lost it, and request asks the listener to grant or deny.",
      },
      {
        key: "turnGrantMs",
        label: "Auto-grant (ms; 0 = explicit only)",
        options: [0, 4000, 8000, 15000],
        hint:
          "Under the request policy, a pending request grants itself after this long, so an absent visitor can never lock the table. 0 means only an explicit grant executes it.",
      },
      {
        key: "turnDenyCooldownMs",
        label: "After “Not yet” (ms; 0 = ask again at once)",
        options: [0, 5000, 10000, 20000],
        hint:
          "Under the request policy, how long a denied side waits before a tap of theirs is put to the listener again. Meanwhile a repeated tap only tells the requester that the other side is still listening — nobody is prompted, so a denial cannot be spammed. 0 asks again at once (shipped).",
      },
      {
        key: "turnNoticeMs",
        label: "Notice duration (ms)",
        options: [2000, 4000, 8000],
        hint:
          "How long the transient notices — “the other side changed the recording”, a denial — stay on screen before fading.",
      },
      {
        key: "switchCue",
        label: "Switch cue",
        options: ["off", "arrow"],
        hint: "A switch this side did not make — the other side's, or the attract loop's — drawn as a looping arrow from the old strip to the new one at the moment it happens, on every viewport but the taker's (alpha-tester feedback, 2026-09-10).",
      },
      {
        key: "arbiter",
        label: "Audio arbiter",
        options: ["local", "broadcast"],
        hint:
          "Room-level arbitration between multiple screens: broadcast yields this screen's audio when another same-profile window claims the room's — a live table pauses, an idle one (attract band up) mutes and mirrors. Last claimant wins, except that a visitor always outranks the attract loop. local is inert single-screen behaviour. The two-screen attract loop needs broadcast; room=shared below implies it.",
      },
      {
        key: "room",
        label: "Room",
        options: ["off", "shared"],
        hint:
          "The room machine (plan §4.4, 0.62.0): shared makes every non-audible window of this PC mirror the audible one — muted, in step — whether or not its attract band is up, so a take on any screen fades that screen in and the screen that loses the speakers mutes and follows instead of pausing; the arbiter is room-wide. off is the 0.60.0 behaviour: the mirror runs only under the band.",
      },
      {
        key: "screen",
        label: "This window's screen",
        options: [0, 1],
        hint:
          "Which screen of the room this window is: room viewport ids are screen × viewports + the local index, 0–3 for two screens. Per window — set it in each window's URL; the Defaults reset keeps it.",
      },
    ],
  },
  {
    id: "misc",
    label: "Misc",
    hint: "Focus and reading behaviour, tap semantics, the marker, and kiosk readiness.",
    params: [
      // Chanda's demo feedback (2026-09-01): the per-recording notes were
      // authored, shipped in the payload, and rendered nowhere.
      {
        key: "targetNotes",
        label: "Per-recording notes",
        options: ["on", "off"],
        hint:
          "The annotator's note about the RECORDING you are hearing, below the shared description, plus a dot on every strip the shown annotation has a note for. 31 of the 61 targets in the shown set carry one and none were rendered before 2026-09-01. Off is the comparator, not a fallback.",
      },
      // Feedback item 4: the audience switch's union position.
      {
        key: "audienceAll",
        label: "Audience ‘All’ option",
        options: [false, true],
        display: (v) => (v ? "offer" : "off"),
        hint:
          "Adds an “All” position to the audience switch that unions every audience's annotations, each chip marked with its audience. A display union only — the three authored sets are untouched.",
      },
      // The playhead-driven focus wash (?focus=playhead, main.js), and the two
      // halves of the agreed definition (2026-08-25): the wash's lifetime and
      // the strip deemphasis.
      {
        key: "focus",
        label: "Focus",
        options: ["manual", "playhead"],
        hint:
          "What drives the focused annotation: taps only (manual, shipped), or the playhead — focus follows region entries on the audible recording, and a chip tap pins it.",
      },
      {
        key: "focusWash",
        label: "Focus wash",
        options: ["clear", "sticky"],
        hint:
          "Lifetime of the wash — the paint on and beside the strips: clear empties when the playhead leaves a region, sticky keeps the latest annotation painted after exit.",
      },
      {
        key: "focusDim",
        label: "Strip deemphasis",
        options: ["auto", "on", "off"],
        hint:
          "Fades the waveform and caption of strips the focused annotation does NOT target, so the comparison it makes stands out. auto means on under playhead focus, off in manual mode.",
      },
      {
        key: "focusHoldMs",
        label: "Wash hold (ms)",
        options: [0, 2500, 5000],
        hint:
          "Minimum lifetime of the wash's paint, so a sub-frame region (the “D or E?” note) still paints perceivably instead of blinking. Seeks and recording switches still drop held paint at once.",
      },
      {
        key: "pinExpiry",
        label: "Pin expiry",
        options: ["off", "auto"],
        hint:
          "How long a chip-tap pin holds before the table comes back to life: off holds until an unfocus, auto estimates a reading time from the shown text. A “Keep reading…” ring warns first, and tapping it re-arms.",
      },
      {
        key: "detailFade",
        label: "Text fade-out",
        options: ["off", "auto"],
        hint:
          "Playback-summoned commentary fades after its reading window instead of lingering forever; auto estimates the window per text. Relevant text never expires, and the ring warns before the end.",
      },
      {
        key: "detailTitle",
        label: "Detail title",
        options: ["auto", "on", "off"],
        hint:
          "Shows the annotation's title above its commentary — answering “which annotation am I reading?” once playback moves the text. auto means only under playhead focus.",
      },
      {
        key: "detailJump",
        label: "Jump button",
        options: ["on", "off"],
        hint:
          "The detail header's “Jump to annotation” button: makes a recording the shown annotation targets audible at its earliest region start. On everywhere by ruling — the only direct route from a text to its music.",
      },
      // The alpha-tester tap question (2026-08-26): aligned carry vs literal
      // both-axes taps with the switch strap. See config.js's tapMode.
      {
        key: "tapMode",
        label: "Waveform tap",
        options: ["aligned", "direct"],
        hint:
          "What a tap on a NON-active waveform means: aligned switches recording and carries the musical moment across, ignoring the tap's x-position; direct takes the tap literally on both axes and moves the aligned switch onto the strap of medallion buttons.",
      },
      // The strap on its own switch (alpha testing, 2026-09-22): the faces are
      // wanted whatever the waveform tap means. See config.js's strap.
      {
        key: "strap",
        label: "Switch strap",
        options: ["auto", "on", "off"],
        hint:
          "The column of conductor medallions left of the waveforms; a medallion always does the aligned switch, carrying the musical moment across. auto shows it only under direct waveform taps (shipped); on shows it in either tap mode; off never — in direct mode that leaves no aligned switch at all.",
      },
      // The week-4 listening marker (ruled 2026-08-27; marker.js).
      {
        key: "marker",
        label: "Listening marker",
        options: ["off", "glass"],
        hint:
          "The visitor's own “listen here” marker: a magnifying glass resting beside the waveforms — drag it, or tap-lift then tap, to anchor a musical moment. While it stands, that side's bare recording switches land on it, and the other side sees a ghost it can adopt.",
      },
      // Chanda's demo feedback (2026-09-01): the grouping edge can be missed.
      {
        key: "groupIndicator",
        label: "Grouping indicator",
        options: ["edge", "wide", "tint"],
        hint:
          "How loudly a strip says which group it is in: edge is the shipped 4 px rule, wide is the same rule at 12 px, tint adds the group's colour washed behind the waveform. None of them changes WHEN a grouping paints \u2014 that still needs the annotation to have something authored to say about its groups, so today only \u201cDie Glocke\u201d shows one.",
      },
      {
        key: "minRegionPx",
        label: "Region floor (px)",
        options: [2, 4, 8],
        hint:
          "The floor under a rendered region's width: sub-pixel annotation regions are widened to at least this instead of silently vanishing at fit-to-width.",
      },
      {
        key: "zoom",
        label: "Initial zoom (px/s; 0 = fit)",
        options: [0, 30],
        hint:
          "The strips' starting scale in pixels per second. 0 fits the whole recording into the strip — the resting state the stacked comparison needs.",
      },
      // Readiness (user, 2026-08-26, iPad round): warm bytes at boot, players
      // kept, and the grace before "Loading…" earns its place on the glass.
      {
        key: "preload",
        label: "Warm audio at boot",
        options: ["off", "on"],
        hint:
          "Fetches every recording's bytes sequentially after boot, reference first, so the first visitor never pays a cold ~9 MB wait. A visitor's tap always outranks the warm loop.",
      },
      {
        key: "playerCache",
        label: "Players kept (LRU)",
        options: [2, 4, 8],
        hint:
          "How many built audio players the transport keeps alive. 2 keeps an A/B comparison instant; 8 pins all eight and makes every switch permanently instant, pending the soak's memory verdict.",
      },
      {
        key: "loadingGrace",
        label: "‘Loading…’ grace (ms)",
        options: [0, 250, 500, 1000],
        hint:
          "Shows “Loading…” only after a genuine wait this long, so warm switches never flash it for two frames.",
      },
      {
        key: "debug",
        label: "Debug logging",
        options: [false, true],
        hint: "Verbose console logging, plus the frame-cost probe.",
      },
    ],
  },
];

// THE STAFF DEBUG PRESET (user, 2026-08-25): what the footer's "Defaults"
// button resets the URL to — the most convenient configuration to debug with
// right now. These are NOT the shipped defaults: DEFAULTS (config.js) stays
// the A/B baseline and the • markers keep pointing at it; every parameter and
// value stays selectable. Update this object as debugging tastes change.
const STUDY_PRESET = {
  focus: "playhead",
  studyPanel: true,
  sideSlot: "annotations",
  detailFade: "auto",
  stageRotation: 90,
  zoomControls: false,
  bandOrientation: "mirrored",
  // The band as the interface (plan §11(f); user, 2026-09-03): the staff see the
  // explorers — and the AI-disclosure sentence at their foot — through the
  // tappable facts, wearing the shimmer cue. Needs the mirrored band above.
  bandTap: "shimmer",
  // The parchment ground (user, 2026-09-03): the staff table reads like the
  // hand-written concert diaries the palette was drawn from.
  theme: "parchment",
  // The attract loop (user, 2026-09-07; one per-screen timer since 2026-09-16):
  // a screen untouched for 3 min; the shipped default stays 0 until release.
  attractAfterIdleMs: 180000,
  // Two screens of one PC share the speakers: the loop's muted mirror and the
  // tap hand-off (ruling R7) ride on the broadcast arbiter (2026-09-10).
  arbiter: "broadcast",
  // The room machine (2026-09-11): every window mirrors the audible one, band
  // or no band. Each window's URL adds its own `screen=`; the reset keeps it.
  room: "shared",
  // The switch cue (alpha-tester feedback, 2026-09-10).
  switchCue: "arrow",
  annotationColors: "theme",
  // WHAT ALPHA TESTING HAS SETTLED ON (user, 2026-09-01). These four are no
  // longer "convenient to debug with" — they are the variants that keep
  // winning, so the button that resets the table now resets it to them:
  //   request  — the turn policy testers prefer; it is also the only policy
  //              under which the turn indicator means "allowed to play back"
  //              rather than "chose what you are hearing".
  //   direct   — a waveform tap taken literally on both axes, with the
  //              aligned switch on the strap of medallion buttons.
  //   glass    — the visitor's own listening marker on its hook.
  // (sideSlot: "annotations" above is the fourth, and it predates them.)
  turnPolicy: "request",
  tapMode: "direct",
  // The faces whatever the tap mode (alpha testing, user, 2026-09-22).
  strap: "on",
  marker: "glass",
  audienceAll: true,
  pinExpiry: "auto",
  // The warm-kiosk experience asked for on the iPad (2026-08-26): everything
  // fetched at boot, all eight players kept once built, no "Loading…" flash.
  preload: "on",
  playerCache: 8,
  loadingGrace: 500,
};

// PANEL STATE LIVES IN localStorage, NEVER IN THE URL — the URL is reserved
// for parameter selections (the configuration), while whether the panel is
// open and which tab it shows is ephemeral discussion state. Both survive the
// reload each change triggers, so changing an option feels continuous: the
// panel reopens itself on the same tab.
const TAB_KEY = "exhibitStudyTab";
const OPEN_KEY = "exhibitStudyOpen";
// …and WHERE IN THE TAB (user, 2026-09-19). The Band and Room tabs are longer
// than the panel, and every option change reloads the page — so without this,
// flipping one knob two thirds of the way down threw you back to the top and
// you had to find your place again, every time.
//
// One position PER TAB rather than one for the panel: the tabs are different
// lengths and hold different discussions, and coming back to a tab at the top
// when you left it half way down is the same annoyance in miniature.
const SCROLL_KEY = "exhibitStudyScroll";

/** The saved scroll offsets, `{tabId: px}`. Never throws — a corrupt or absent
 *  entry is simply no memory, which is the state this feature replaced. */
function readScrolls() {
  try {
    const raw = JSON.parse(localStorage.getItem(SCROLL_KEY) || "{}");
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

/**
 * A param's value in a config object. Per-viewport fields (`views`, like
 * `rotations` and `audiences`) are arrays in the config and one comma-separated
 * value in the URL; a param with an `index` reads one slot, falling back to the
 * default's slot when the URL named fewer viewports than the screen has.
 */
function valueOf(source, param) {
  const v = source[param.key];
  if (param.index === undefined) return v;
  return v?.[param.index] ?? DEFAULTS[param.key][param.index];
}

/**
 * Mount the cog and the panel. Call once, only when config.studyPanel is on.
 * `actions` are the staff shortcuts a param of type `action` can call; each
 * returns false when it could not act, and the button says so for a moment.
 */
export function mountStudyPanel(config, actions = {}) {
  const cog = document.createElement("button");
  cog.type = "button";
  cog.className = "study-cog";
  cog.textContent = "⚙";
  cog.setAttribute("aria-label", "Study panel");

  const panel = document.createElement("div");
  panel.className = "study-panel";
  panel.hidden = true;

  const tabs = document.createElement("div");
  tabs.className = "study-tabs";
  const body = document.createElement("div");
  body.className = "study-body";

  let activeTab = localStorage.getItem(TAB_KEY) || TABS[0].id;
  if (!TABS.some((t) => t.id === activeTab)) activeTab = TABS[0].id;

  for (const tab of TABS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "study-tab";
    b.dataset.tab = tab.id;
    b.textContent = tab.label;
    if (tab.hint) b.title = tab.hint;
    b.addEventListener("click", () => {
      // Bank where THIS tab was left before leaving it, so the two tabs do not
      // trade places (the scroll listener only fires while a tab is scrolled).
      rememberScroll();
      activeTab = tab.id;
      localStorage.setItem(TAB_KEY, activeTab);
      paint();
    });
    tabs.appendChild(b);
  }

  /** Bank the body's offset against the tab now showing. */
  function rememberScroll() {
    clearTimeout(scrollTimer);
    const scrolls = readScrolls();
    scrolls[activeTab] = Math.round(body.scrollTop);
    try {
      localStorage.setItem(SCROLL_KEY, JSON.stringify(scrolls));
    } catch {
      /* a full or blocked store is not worth breaking the panel over */
    }
  }

  // Coalesced, because a scroll fires per frame and this writes to disk. A
  // TIMER, not rAF: the panel is often read on a screen whose tab is hidden or
  // whose window is behind another, and rAF does not run there — the position
  // would simply never be saved.
  let scrollTimer = 0;
  body.addEventListener("scroll", () => {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(rememberScroll, 120);
  });
  // The reload a parameter change triggers can beat that 120 ms.
  window.addEventListener("pagehide", rememberScroll);

  // The footer: the fit line, and the two buttons that carry the configuration
  // away. The URL used to be ECHOED here in full, selectable; it is not any
  // more (user, 2026-09-18) — the query string has grown past 300 characters
  // and the echo was taking most of the panel's height to say what "Copy URL"
  // already does.
  const footer = document.createElement("div");
  footer.className = "study-footer";
  // THE FIT LINE. Strip height, recording count, and the commentary panel are
  // one budget, and the panel is the residual — so a taller strip or an extra
  // recording is paid for out of the description text. The failure is silent:
  // at ten strips of 48 px the text box measures ZERO pixels while every strip
  // still renders and every test still passes (measured 2026-09-01). Nothing in
  // the suite catches it, so the panel that can cause it reports it.
  const fit = document.createElement("span");
  fit.className = "study-fit";
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "study-copy";
  copy.textContent = "Copy URL";
  copy.addEventListener("click", async () => {
    const say = (text, ms) => {
      copy.textContent = text;
      setTimeout(() => (copy.textContent = "Copy URL"), ms);
    };
    try {
      await navigator.clipboard.writeText(location.href);
      say("Copied", 1200);
    } catch (_) {
      // `navigator.clipboard` needs a SECURE CONTEXT, and the exhibit runs on
      // plain http over the museum's LAN — so on the iPad this is the path that
      // actually runs. It used to fall back to "select the text yourself" from
      // the echo below; with the echo gone the button has to finish the job, so
      // it copies from an off-screen textarea the old way.
      const scratch = document.createElement("textarea");
      scratch.value = location.href;
      scratch.setAttribute("readonly", "");
      scratch.style.cssText = "position:fixed;top:-1000px;opacity:0;";
      document.body.appendChild(scratch);
      scratch.select();
      let ok = false;
      try {
        ok = document.execCommand("copy");
      } catch (__) {
        ok = false;
      }
      scratch.remove();
      say(ok ? "Copied" : "Copy failed", ok ? 1200 : 2000);
    }
  });
  // A RESET, not a merge: the button rewrites the whole query to the preset,
  // dropping any other experiment the discussion had layered on.
  const reset = document.createElement("button");
  reset.type = "button";
  reset.className = "study-copy study-defaults";
  reset.textContent = "Defaults";
  reset.title = "Reset to the staff debug preset";
  reset.addEventListener("click", () => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(STUDY_PRESET)) params.set(key, String(value));
    // This window's place in the room is per WINDOW, not part of any preset:
    // a reset that dropped it would make both windows screen 0.
    const here = new URLSearchParams(location.search);
    if (here.has("screen")) params.set("screen", here.get("screen"));
    location.href = location.pathname + `?${params.toString()}`;
  });
  footer.append(fit, reset, copy);

  /**
   * Measure what a visitor can actually READ, and say so.
   *
   * `clientHeight` is the box; `scrollHeight` is the text in it. Their ratio is
   * the honest answer to "does the commentary fit", and both numbers are read
   * from the first viewport's live panel rather than computed from the config —
   * the budget runs through flexbox, and a model of it would be a second thing
   * to keep in step. Under 40 px the box cannot hold a line, which is the
   * regression this line exists to catch.
   */
  let fitWatched = null;
  let fitDebounce = 0;
  function paintFit() {
    const detail = document.querySelector(".ann-detail");
    if (!detail) {
      fit.textContent = "";
      return;
    }
    // The number has to follow the TEXT ON SHOW, not the hint that was there
    // when the panel opened. Without this the line reports the resting state
    // ("Tap to listen", 21 px) and reads healthy while a 1,669-character
    // description behind it is showing none of itself. One observer, attached
    // the first time the element exists, because the component builds it once
    // and rewrites its textContent thereafter.
    if (fitWatched !== detail) {
      fitWatched = detail;
      new MutationObserver(() => {
        clearTimeout(fitDebounce);
        fitDebounce = setTimeout(paintFit, 120);
      }).observe(detail, { childList: true, characterData: true, subtree: true });
    }
    // NOT ON SCREEN IS NOT ZERO (user asked what "commentary 0 px" meant,
    // 2026-09-18, and the honest answer was "nothing"). This line was written
    // for the below-layout, where the box is always shown; under
    // `?sideSlot=annotations` the commentary moves into the side panel, which is
    // CLOSED until a visitor opens it, and an explorer overlay hides it too. In
    // both cases clientHeight is 0 with nothing wrong at all, and the line was
    // reporting its loudest red for the whole session.
    if (detail.offsetParent === null && !detail.getClientRects().length) {
      fit.textContent = "commentary not on screen";
      fit.dataset.level = "";
      fit.title =
        "There is nothing to measure right now: the commentary box is not being " +
        "displayed. With ?sideSlot=annotations it lives in the side panel, which " +
        "opens on a tap; an open explorer hides it too. Not a fault.";
      return;
    }
    const box = detail.clientHeight;
    const text = detail.scrollHeight;
    const pct = text > 0 ? Math.round((Math.min(box, text) / text) * 100) : 100;
    fit.textContent = `commentary ${box} px` + (text > box ? ` of ${text} (${pct}%)` : "");
    fit.dataset.level = box < 40 ? "bad" : pct < 50 ? "warn" : "";
    fit.title =
      "How much of the shown commentary is visible without scrolling. The strips " +
      "and this box share one budget; under 40 px the text is effectively gone.";
  }

  panel.append(tabs, body, footer);

  function paint() {
    for (const b of tabs.children) b.classList.toggle("is-on", b.dataset.tab === activeTab);
    body.textContent = "";
    const tab = TABS.find((t) => t.id === activeTab);
    for (const param of tab.params) {
      const row = document.createElement("div");
      row.className = "study-row";
      const label = document.createElement("span");
      label.className = "study-label";
      label.textContent = param.label;
      const opts = document.createElement("span");
      opts.className = "study-options";
      if (param.action) {
        // A staff shortcut rather than a parameter: one button, no URL change.
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "study-option study-action";
        btn.dataset.action = param.action;
        btn.textContent = param.button;
        btn.addEventListener("click", () => {
          const ok = actions[param.action]?.();
          if (ok === false) {
            btn.textContent = param.unavailable || "Not available";
            setTimeout(() => (btn.textContent = param.button), 1800);
          }
        });
        opts.appendChild(btn);
        row.append(label, opts);
        if (param.hint) {
          label.title = param.hint;
          label.classList.add("has-hint");
          const hint = document.createElement("span");
          hint.className = "study-hint";
          hint.textContent = param.hint;
          hint.hidden = true;
          label.addEventListener("click", () => {
            hint.hidden = !hint.hidden;
          });
          label.after(hint);
        }
        body.appendChild(row);
        continue;
      }
      const current = String(valueOf(config, param));
      for (const option of param.options) {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "study-option";
        const isDefault = String(option) === String(valueOf(DEFAULTS, param));
        chip.textContent = (param.display ? param.display(option) : String(option)) +
          (isDefault ? " •" : "");
        chip.title = isDefault ? "default" : "";
        chip.classList.toggle("is-on", String(option) === current);
        chip.addEventListener("click", () => applyParam(param, option));
        opts.appendChild(chip);
      }
      row.append(label, opts);
      // The hint rides twice: a title for a desktop hover, and a tap on the
      // label toggles it inline under the header — the panel's real home is
      // an iPad, where a title tooltip simply never shows.
      if (param.hint) {
        label.title = param.hint;
        label.classList.add("has-hint");
        const hint = document.createElement("span");
        hint.className = "study-hint";
        hint.textContent = param.hint;
        hint.hidden = true;
        label.addEventListener("click", () => {
          hint.hidden = !hint.hidden;
        });
        label.after(hint);
      }
      body.appendChild(row);
    }
    paintFit();
    // BACK TO WHERE THIS TAB WAS LEFT (user, 2026-09-19). paint() empties the
    // body and rebuilds it, which resets the offset to 0 — so the restore has to
    // happen here, after the rows are in, and not once at mount.
    //
    // No clamping: a browser pins an over-long scrollTop to the new maximum by
    // itself, which is the right answer when a tab has grown shorter.
    body.scrollTop = readScrolls()[activeTab] || 0;
  }

  /**
   * Write one parameter into the URL and reload. Defaults are deleted rather
   * than written, so the URL stays a minimal, readable diff — and studyPanel
   * itself survives because true is not its default.
   */
  function applyParam(param, value) {
    const { key } = param;
    const params = new URLSearchParams(location.search);
    let next = value;
    if (param.index !== undefined) {
      // One slot of a per-viewport field: the whole comma-separated value is
      // rewritten, the other slots kept as they are, so the URL stays one
      // parameter (an array stringifies comma-joined, as the URL wants it).
      next = DEFAULTS[key].map((d, i) => (i === param.index ? value : (config[key]?.[i] ?? d)));
    }
    if (String(next) === String(DEFAULTS[key])) params.delete(key);
    else params.set(key, String(next));
    // Choosing a PRESET clears every per-category pin back to "follow": a
    // preset click means "show me that theme", and stale pins silently
    // corrupting it is the confusing outcome. Pins are re-applied after, if
    // wanted — they are one chip away.
    if (key === "theme") {
      for (const cat of CATEGORY_KEYS) {
        params.delete("theme" + cat[0].toUpperCase() + cat.slice(1));
      }
    }
    const qs = params.toString();
    location.href = location.pathname + (qs ? `?${qs}` : "");
  }

  cog.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
    localStorage.setItem(OPEN_KEY, panel.hidden ? "0" : "1");
    if (!panel.hidden) paint();
  });

  // Keep the staff controls off the straps: fixed positioning ignores the
  // stage-rotation transform (they mount on body, outside #screen), so under
  // a rotation the physical bottom-right corner lands on a strap — the CSS
  // moves both to bottom-left when this attribute is present.
  if (config.stageRotation === 90 || config.stageRotation === 270) {
    cog.dataset.stageRotation = String(config.stageRotation);
    panel.dataset.stageRotation = String(config.stageRotation);
  }
  document.body.append(cog, panel);
  // Reopen where the discussion left off: an option change reloads the page,
  // and the panel comes straight back on the same tab.
  if (localStorage.getItem(OPEN_KEY) === "1") {
    panel.hidden = false;
    paint();
  }
  // The fit line measures a LAID-OUT panel, and the strips are still settling
  // when this mounts — so re-measure once boot has stopped moving, and again
  // whenever the geometry changes under it. Cheap: two reads of one element.
  setTimeout(paintFit, 1200);
  let fitTimer = 0;
  window.addEventListener("resize", () => {
    clearTimeout(fitTimer);
    fitTimer = setTimeout(paintFit, 250);
  });
  return { cog, panel };
}
