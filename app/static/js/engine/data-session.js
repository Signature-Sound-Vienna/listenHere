// engine/data-session.js
//
// DataSession — the instantiable holder for state that today lives as
// module-level globals in listen.js. See docs/museum-exhibit-architecture.md §3:
// a DataSession is scoped to ONE screen and owns the *shared* half of the
// sharing boundary (loaded recordings, alignment, decoded audio + peaks, the
// active-recording selection, one playback clock). Per-viewport state
// (renderers, zoom, scroll) belongs to a future WaveformView — one per viewport
// per loaded recording — and is parked under `session.view` until that split
// happens, so the eventual cut is a namespace move rather than a hunt for which
// map was which.
//
// Introduced in the Phase-1 refactor (increment 5) *behind listen.js's existing
// export facade*: listen.js instantiates exactly one session and aliases each
// migrated global to the session's field, so every call site and every importing
// sibling module (engine/*, annotation/*, solid.js) is unchanged. Listen Here
// stays the single-session, single-viewport reference application.
//
// Migration is incremental. Currently held here:
//   Wave A — reference-stable maps (declared `const` in listen.js, never
//   rebound), so listen.js can alias them by reference with zero ref rewrites.
// Still in listen.js, to follow:
//   Wave B — collections rebound on load/reload (wavesurfers, markers, loaded,
//   timemap, the file/auth Maps); their rebinds become in-place resets.
//   Wave C — primitives and exported live-bindings (currentAudioIx,
//   loadedAlignmentJSON, alignmentGrids, scoreAlignment, meiUri, tk, storage,
//   activeMarkerIx, …); listen.js keeps `export let` mirrors updated via
//   setters so siblings' live-binding imports keep working.

export class DataSession {
  constructor() {
    // -----------------------------------------------------------------------
    // Shared per screen — true DataSession state
    // -----------------------------------------------------------------------

    /** filename -> { peaks: number[], duration: number } when pre-computed.
     *  Shared so a recording is decoded once per screen, not once per viewport. */
    this.waveformPeaks = {};

    /** SYNTH_MEI_KEY -> blob URL once MEI synthesis is done, or '__pending__'. */
    this.synthBlobUrls = new Map();

    // -----------------------------------------------------------------------
    // Per viewport in the target model (§3) — future WaveformView state.
    // Today session ≡ view: Listen Here has exactly one viewport.
    // -----------------------------------------------------------------------
    this.view = {
      /** filename -> RegionsPlugin instance (one per renderer). */
      regionsPlugins: {},
      /** filename -> timer Region object. */
      timerRegions: {},
      /** filename -> closure redrawing the alignment grid canvas. */
      gridRedrawers: {},
      /** filename -> closure repainting the position indicator. */
      positionUpdaters: {},
    };
  }
}
