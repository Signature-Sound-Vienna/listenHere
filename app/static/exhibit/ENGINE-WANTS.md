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

Further candidates, all already at zero `listen.js` imports and importable when needed:
`js/engine/data-session.js`, `js/engine/time-axis.js`, `js/engine/mei-synth.js`,
`js/windowed-audio-player.js`, `js/audio-seek-index.js`, `js/annotation/state.js`,
`js/annotation/mao-adapter.js`, `js/annotation/ui-common.js`, `js/theme-setup.js`, `js/utils.js`.

## The ledger

| # | what | copied from | lines | what the engine should expose | disposition |
|---|---|---|---|---|---|
| — | *nothing copied yet* | — | — | — | — |

<!--
Row template — keep the columns in this order:

| 1 | the windowed-player builder | `js/engine/normalization.js:64-96` | ~15 | a `buildWindowedPlayer(blob, opts)` free function, with no normalisation state attached | resolve before December |
-->
