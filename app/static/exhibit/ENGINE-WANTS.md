# ENGINE-WANTS — the exhibit's TODO ledger against the listen engine

The exhibit may not import `listen.js`, directly or through any chain of imports. That rule is
enforced by `tests/e2e/33-exhibit-boundary.spec.ts`, not by discipline, and it is ratcheted at zero.

It may freely import the **uncoupled** engine modules. Everything else it needs, it **copies** — and
every copy gets an entry here. This file is the architectural deliverable of the exhibit track: the
list of things the engine should have exposed but didn't. Scattered inline `TODO`s degrade into grep
archaeology, so they live here instead, one row each.

## The rules

1. **One entry per copied or stubbed thing.** What was copied, from where, how many lines, and what
   shape the engine should expose instead.
2. **Every entry carries a disposition**, and there are only two:
   - **`resolve before December`** — a divergence that will cost us if it survives into the release.
     Usually because it encodes a rule two consumers must agree on, or because it will drift.
   - **`acceptable permanent divergence`** — the copy is genuinely the right answer. Usually because
     it encodes *conventions* (pointer mechanics, CSS class names, layout idiom) rather than
     *semantics*, and the two consumers are entitled to differ.
3. **A copy with no disposition is a bug in this file.** If you cannot decide, write
   `resolve before December` — the pessimistic default is the safe one.
4. **Semantics get extracted, not copied.** If a copy would let the exhibit and Listen Here disagree
   about *what something means* — which moment an alignment index is, which recordings a group holds,
   what an annotation is about — it is the wrong call. Extract it into an uncoupled engine module
   instead and delete the row. `engine/align-core.js` and `engine/grouping-core.js` exist for exactly
   this reason and were extracted before any of this was written.

## Imported, not copied

These are shared, so they are **not** ledger entries — they are the boundary working as intended.

| module | why it is shared rather than copied |
|---|---|
| `js/engine/align-core.js` | The alignment index↔time mapping. Pure semantics: every consumer must agree what an index means. |
| `js/engine/grouping-core.js` | The grouping read model. Annotations pin to group ids, so a divergent copy would disagree about which recordings an annotation is about. |
| `js/windowed-audio-player.js` | Accurate VBR-MP3 seeking. The exhibit's whole content is "listen to *this* moment", and an `<audio>` element seeks VBR by estimating time from byte offset — up to ~15 s wrong. Zero imports already, so it is shared as-is; only the *builder* around it had to be copied (row 1). |
| `js/audio-seek-index.js` | The frame index the player seeks by. Same argument, same zero imports. |

The vendored WaveSurfer bundles (`vendor/wavesurfer.esm.js`, `vendor/wavesurfer-regions.esm.js`) are
imported directly too. They are not first-party modules and cannot reach `listen.js`, so the boundary
test ignores them and they are not ledger entries.

Further candidates, all already at zero `listen.js` imports and importable when needed:
`js/engine/data-session.js`, `js/engine/time-axis.js`, `js/engine/mei-synth.js`,
`js/annotation/state.js`, `js/annotation/mao-adapter.js`, `js/annotation/ui-common.js`,
`js/theme-setup.js`, `js/utils.js`.

## The ledger

| # | what | copied from | lines | what the engine should expose | disposition |
|---|---|---|---|---|---|
| 1 | the windowed-player builder — analyse the bytes, construct a `WindowedAudioPlayer`, kick off `init()` in the background, fall back to an element when no index is needed | `js/engine/normalization.js:59-96` (`maybeBuildWindowedPlayer`) | ~20, in `exhibit/audio.js` | a `buildWindowedPlayer(blob, bytes, {audioContext, duration})` free function. The engine's version is not callable from outside because it *finds* its own inputs: `fileBlobs`, `waveformPeaks`, and a module-private `AudioContext`, all reached through `listen.js`. The fifteen lines that matter want four arguments and no state. | **resolve before December** |
| 2 | the annotation region **display** half — spec computation, reconcile-not-rebuild, the `_v6Meta`-style stash, and `_withAlpha` | `js/annotation/waveform-interactions.js:175-271` | ~110, in `exhibit/regions.js` | nothing. See below. | **acceptable permanent divergence** |
| 3 | the alignment-based scroll sync — centre-of-view time, projected per recording, written back as scrollLeft | rebuilt against `js/engine/zoom-scroll.js:344-370` (`syncAllWaveformScrolls`, alignment branch) | ~25, in `exhibit/zoom.js` | nothing, probably. The SEMANTICS (which moment corresponds) go through `align-core` in both consumers; what was rebuilt is scroll-position arithmetic plus each side's own conventions — the engine's version serves three scroll modes, a shared time axis, and overlay canvases the exhibit does not have, and the exhibit's centres ALL strips including the source, holds a per-viewport sync lock, and rAF-coalesces momentum-scroll bursts. If a third consumer ever appears, extract a `centreScrollFor(time, duration, viewW, fullW)` pair then. | **acceptable permanent divergence** |

**Row 2, because a copy always looks like laziness later.** This is plan §8's closed decision, not a
shortcut taken here. What that module encodes is *conventions* — an id namespace, a metadata stash, drag
and resize permissions, pointer mechanics — and the two consumers are entitled to differ about every one
of them: the exhibit has no drag, no alt-scoped edit, no drawer, and reads its times from the prepped
payload's `targets[].regionTimes` rather than from `annotation/state.js`. The exhibit's copy has already
diverged in a way the engine should *not* adopt (a minimum rendered width, and a `provisional` mark for
regions awaiting hand placement — plan §5.2d), which is the evidence that the divergence is real.

What must never diverge is the annotation **serialisation** shape, and that lives in
`annotation/state.js`, on the import side. Rule 4 is satisfied: no *semantics* were copied. The two
things a copy would have let the exhibit disagree about — which moment an index is, which recordings a
group holds — are imported (`align-core`, `grouping-core`).

## Pushed back into the engine

The mirror image of the ledger, and the more valuable half: what building a second consumer *fixed*
upstream rather than worked around. One entry so far.

| what | where | why the exhibit found it |
|---|---|---|
| Removed an unconditional `console.log` of every call | `js/engine/align-core.js`, `getClosestAlignmentIx` | Survivable while the only caller reacted to clicks. The exhibit calls it once per animation frame to place sixteen cursors, so it was 60 lines of console per second — which is not a diagnostic, and would have made the frame-cost measurement unreadable. |
| Extracted `fitPxPerSec` into `js/engine/zoom-fit.js` (new, uncoupled; zoom-scroll.js now imports it) | was private in `js/engine/zoom-scroll.js` | The exhibit's first zoom-out probe reproduced the spec 28.3 one-pixel overflow exactly (wrapper 997 over a 996 container, scroll stuck at 1) — on a PEAKS-ONLY renderer, where the overshooting duration is the mock buffer's float arithmetic rather than an MP3 header. The function encodes a bug fix two consumers must share, which is rule 4's definition of extract-don't-copy. |

<!--
Row template — keep the columns in this order:

| 3 | the thing | `js/engine/whatever.js:1-2` | ~n | the shape the engine should expose instead | resolve before December |
-->
