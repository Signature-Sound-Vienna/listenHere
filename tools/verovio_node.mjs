// tools/verovio_node.mjs — the vendored Verovio toolkit under Node, shared by
// the offline tools that render an alignment's MEI (make_standins.mjs,
// mei_measure_times.mjs).
//
// Three pieces, moved here from make_standins.mjs so the tools cannot drift
// apart on what "the same score as the alignment" means:
//   initVerovio        load + construct-poll the WASM toolkit
//   applyProvenance    honour header.verovioVersion / header.verovioOptions
//   checkOnsetQuarters THE decisive check: the fresh render's unique onset
//                      quarters must equal the alignment's score_onset set

import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { parseMidi } from "../app/static/js/engine/mei-synth.js";
import { dedupePairs } from "../app/static/js/engine/time-map.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VEROVIO_PATH = path.join(ROOT, "app/static/js/verovio-toolkit-wasm.js");

// ---------------------------------------------------------------------------
// Verovio (vendored toolkit, native in Node: require + construct-poll — 6.x
// exposes no calledRun, so readiness is probed by constructing the toolkit)
// ---------------------------------------------------------------------------

export async function initVerovio() {
  const require = createRequire(import.meta.url);
  const verovio = require(VEROVIO_PATH);
  const started = Date.now();
  for (;;) {
    try {
      return new verovio.toolkit();
    } catch (_) {
      if (Date.now() - started > 30000)
        throw new Error("Verovio failed to initialise within 30 s");
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

/**
 * Honour the alignment's Verovio provenance stamps: configure the live
 * toolkit to the stamped semantics and report what was decided. An absent
 * options stamp reads as pre-Verovio-6 no-expansion semantics (pinned via
 * expandNever); a stamped expansion is applied verbatim. The version stamp
 * is advisory — the behavioural quarters check is decisive.
 */
export function applyProvenance(header, tk) {
  const notes = [];
  const stampVer = header.verovioVersion || null;
  const stampOpts = header.verovioOptions || null;
  let options = { expandNever: true };
  if (stampOpts && (stampOpts.expand || stampOpts.expandAlways)) {
    options = {};
    if (stampOpts.expand) options.expand = stampOpts.expand;
    if (stampOpts.expandAlways) options.expandAlways = true;
    notes.push(
      `alignment was rendered WITH an expansion (${JSON.stringify(stampOpts)}) — applying it`,
    );
  } else if (!stampOpts) {
    notes.push(
      "no verovioOptions stamp — reading as pre-6 no-expansion semantics (expandNever)",
    );
  }
  tk.setOptions(options);
  const liveVer = tk.getVersion();
  if (stampVer && !liveVer.startsWith(stampVer.split("-")[0])) {
    notes.push(
      `version stamp ${stampVer} differs from live toolkit ${liveVer} — relying on the quarters check`,
    );
  } else if (!stampVer) {
    notes.push(
      `no verovioVersion stamp (pre-0.37.0 alignment) — relying on the quarters check (live: ${liveVer})`,
    );
  }
  return { notes, liveVersion: liveVer, appliedOptions: options };
}

/**
 * Render the loaded score to MIDI and compare its unique onset quarters with
 * the alignment's deduplicated score_onset. An empty `misses` means the MEI
 * on hand is, behaviourally, the score the alignment was made against.
 *
 * @returns {{ midiBytes: Uint8Array, tpq: number, notes: object[],
 *             onsetTicks: number[], rendered: number, aligned: number,
 *             misses: string[] }}
 */
export function checkOnsetQuarters(tk, score) {
  const midiBase64 = tk.renderToMIDI();
  if (!midiBase64) throw new Error("Verovio produced empty MIDI output");
  const midiBytes = Uint8Array.from(Buffer.from(midiBase64, "base64"));
  const { tpq, notes } = parseMidi(midiBytes);
  const onsetTicks = [...new Set(notes.map((n) => n.s))].sort((a, b) => a - b);
  const renderedQ = onsetTicks.map((t) => t / tpq);
  const alignQ = dedupePairs(score.score_onset, score.ref_onset).xs;
  const misses = [];
  if (renderedQ.length !== alignQ.length)
    misses.push(`count ${renderedQ.length} vs alignment ${alignQ.length}`);
  else
    for (let i = 0; i < renderedQ.length; i++)
      if (Math.abs(renderedQ[i] - alignQ[i]) > 1e-9) {
        misses.push(`index ${i}: rendered ${renderedQ[i]} vs ${alignQ[i]}`);
        if (misses.length >= 5) break;
      }
  return {
    midiBytes,
    tpq,
    notes,
    onsetTicks,
    rendered: renderedQ.length,
    aligned: alignQ.length,
    misses,
  };
}
