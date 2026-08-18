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
// Introduced in the Phase-1 refactor *behind listen.js's existing export
// facade*: listen.js instantiates exactly one session and aliases each migrated
// global to the session's field, so every call site and every importing sibling
// module (engine/*, annotation/*, solid.js) is unchanged. Listen Here stays the
// single-session, single-viewport reference application.
//
// Migration is incremental. Currently held here:
//   Wave A — reference-stable maps (declared `const` in listen.js, never
//   rebound), aliased by reference with zero ref rewrites.
//   Wave B — collections that listen.js used to REBIND on load/reload. Their
//   rebinds are now in-place resets (refillArray / clearMap below) so the
//   aliases — and every importer holding one — stay valid. listen.js declares
//   them `const`, which turns any future stray rebind into a hard error.
// Still in listen.js, to follow:
//   Wave C — primitives and exported live-bindings (currentAudioIx,
//   loadedAlignmentJSON, alignmentGrids, scoreAlignment, meiUri, tk, storage,
//   activeMarkerIx, …); listen.js will keep `export let` mirrors updated via
//   setters so siblings' live-binding imports keep working. alignmentGrids
//   belongs to that wave, not this one: its legacy-format rebinds alias
//   loadedAlignmentJSON.body, and an in-place reset would break that container
//   identity.

/**
 * Replace an array's contents in place, keeping the reference stable.
 * Iterates rather than spreading into push() so arbitrarily long sources
 * (e.g. a Verovio timemap) can't hit the argument-count limit.
 */
export function refillArray(target, source) {
  target.length = 0;
  for (const v of source) target.push(v);
  return target;
}

/**
 * Identity fingerprint for one recording's alignment grid: FNV-1a over
 * millisecond-rounded times, salted with the entry count.
 *
 * Recording filenames do not identify a piece — in this corpus they name the
 * ALBUM, so a Donauwalzer and a Radetzkymarsch off the same album share a
 * filename (issue #32). The warped time sequence does identify it: two
 * different pieces producing an identical sequence to the millisecond is not a
 * realistic collision. ~0.4 ms for four 15k-entry grids, so it is cheap enough
 * to run on every load.
 *
 * Fingerprint the grid AS LOADED and keep the result: re-hashing live grids
 * would make in-session alignment corrections look like a different piece.
 */
export function gridFingerprint(times) {
  let h = 0x811c9dc5;
  for (let i = 0; i < times.length; i++) {
    const v = Math.round(times[i] * 1000) | 0;
    for (let s = 0; s < 4; s++) {
      h ^= (v >>> (s * 8)) & 0xff;
      h = Math.imul(h, 0x01000193);
    }
  }
  return (h >>> 0).toString(16) + ":" + times.length;
}

/** Delete every own key of a plain-object map in place. */
export function clearMap(target) {
  for (const k of Object.keys(target)) delete target[k];
  return target;
}

export class DataSession {
  constructor() {
    // -----------------------------------------------------------------------
    // Shared per screen — true DataSession state
    // -----------------------------------------------------------------------

    /** Alignment keys (filenames) whose waveform is currently loaded. */
    this.loaded = new Set();

    /** Marker times, in reference-audio seconds.
     *  Session-level because markers are persisted alignment data here
     *  (loadedAlignmentJSON.header.markers). Whether the exhibit wants them
     *  per-viewport instead is an open product question (design doc §7),
     *  and would be a move into `view` below. */
    this.markers = [];

    /** filename -> gridFingerprint() of its grid as loaded. Piece identity for
     *  the next load, so a different piece over the same albums is detected. */
    this.gridFingerprints = {};

    /** Verovio timemap for the loaded MEI. */
    this.timemap = [];

    /** filename -> { peaks: number[], duration: number } when pre-computed.
     *  Shared so a recording is decoded once per screen, not once per viewport. */
    this.waveformPeaks = {};

    /** SYNTH_MEI_KEY -> blob URL once MEI synthesis is done, or '__pending__'. */
    this.synthBlobUrls = new Map();

    /** Alignment key -> File/Blob from the local file picker. */
    this.fileBlobs = new Map();
    /** Alignment key -> object URL minted for the picked file. */
    this.fileBlobUrls = new Map();

    /** Object URLs whose owner has gone but which may still back a live media
     *  element, so they can't be revoked yet. Drained by listen.js's
     *  _revokeRetiredBlobUrls once nothing references them. */
    this.retiredBlobUrls = [];

    /** origin -> fetchParams ({ headers: { Authorization } }); scoped per
     *  origin so HTTP Basic credentials can't leak across hosts. */
    this.authByOrigin = new Map();
    /** Origins already prompted for credentials this session. */
    this.authPromptedOrigins = new Set();

    // --- Wave C: primitives. These cannot be aliased by reference, so
    // listen.js mirrors them in module-level bindings kept in sync by setters
    // (its importers rely on those as ESM live bindings). This object stays the
    // store; the mirrors are scaffolding that disappears once call sites are
    // parameterised per session.

    /** Active recording (alignment key) — the selection shared per screen. */
    this.currentAudioIx = "";

    /** filename -> alignment-grid time array. Rebindable on purpose: on the
     *  legacy alignment formats it aliases loadedAlignmentJSON.body, and
     *  corrections propagate to the saved file through that shared identity. */
    this.alignmentGrids = {};

    /** The whole alignment object, as loaded and as saved. */
    this.loadedAlignmentJSON = null;

    /** Score alignment: score tstamp -> ref tstamp, onset and offset. */
    this.scoreAlignment = undefined;

    /** Score (MEI) for this piece: source URI, raw XML, parsed DOM. */
    this.meiUri = undefined;
    this.mei = null;
    this.meiDOM = null;

    /** Reference recording (alignment header.ref). */
    this.referenceAudioIx = undefined;

    /** Index into markers[] of the active marker. */
    this.activeMarkerIx = null;

    // --- Not piece-scoped, so untouched by reset(): the Verovio toolkit is
    // expensive to build and reusable, and storage is just a localStorage
    // handle. HTTP auth is per origin, not per piece.

    /** Verovio toolkit instance. */
    this.tk = undefined;
    /** window.localStorage, or undefined when inaccessible. */
    this.storage = undefined;

    // -----------------------------------------------------------------------
    // Per viewport in the target model (§3) — future WaveformView state.
    // Today session ≡ view: Listen Here has exactly one viewport.
    // -----------------------------------------------------------------------
    this.view = {
      /** filename -> WaveSurfer instance (the renderer). */
      wavesurfers: {},
      /** filename -> RegionsPlugin instance (one per renderer). */
      regionsPlugins: {},
      /** filename -> closure redrawing the alignment grid canvas. */
      gridRedrawers: {},
      /** filename -> closure repainting the position indicator. */
      positionUpdaters: {},
    };
  }

  /**
   * Clear all piece-scoped state, in place wherever an alias or importer could
   * be holding a reference. Used when a different piece's alignment replaces
   * the loaded one (issue #32): before this existed, setGrids() swapped the
   * alignment data while the previous piece's renderers, loaded set and
   * markers survived, leaving reads of alignmentGrids[staleKey] undefined.
   *
   * Renderer teardown is NOT done here — this object doesn't own the WaveSurfer
   * lifecycle or the DOM. The caller destroys the renderers, calls this, and
   * re-syncs its mirrors (listen.js resetSession does all three).
   *
   * Deliberately preserved: tk (expensive, piece-independent), storage, and the
   * per-origin auth maps (host credentials, not piece data).
   */
  /**
   * Hand the picked-file maps' object URLs over for later revocation and empty
   * the maps. The file picker calls this when a newly picked alignment starts a
   * fresh matching slate: dropping the maps outright would strand those URLs in
   * the document's object-URL store with no handle left to revoke them.
   */
  retireFileBlobs() {
    for (const url of this.fileBlobUrls.values()) this.retiredBlobUrls.push(url);
    this.fileBlobUrls.clear();
    this.fileBlobs.clear();
  }

  reset() {
    this.loaded.clear();
    this.markers.length = 0;
    this.timemap.length = 0;
    clearMap(this.waveformPeaks);
    clearMap(this.gridFingerprints);
    this.synthBlobUrls.clear();
    this.fileBlobs.clear();
    this.fileBlobUrls.clear();
    // retiredBlobUrls deliberately survives: those URLs are still owed a
    // revoke, and the caller sweeps them once the renderers are gone.

    this.currentAudioIx = "";
    this.alignmentGrids = {};
    this.loadedAlignmentJSON = null;
    this.scoreAlignment = undefined;
    this.meiUri = undefined;
    this.mei = null;
    this.meiDOM = null;
    this.referenceAudioIx = undefined;
    this.activeMarkerIx = null;

    for (const m of Object.values(this.view)) clearMap(m);
  }
}
