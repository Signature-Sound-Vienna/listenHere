#!/usr/bin/env node
// tools/mei_measure_times.mjs — where every measure of an alignment's MEI
// starts on its reference recording, as JSON on stdout.
//
// Written for tools/prep_exhibit_data.py (the exhibit's section ribbon,
// roadmap 28): prep knows the MEI's <section> tree but has no Verovio, so it
// asks this tool for each measure's onset and joins the two by measure xml:id.
//
// The route is the engine's, not a copy: Verovio's measure timemap gives each
// measure's QUARTERS (qstamp), and engine/time-map.js maps quarters to
// reference seconds over the alignment's score_onset/ref_onset pairs. Quarters,
// never the timemap's milliseconds, for the reason time-map.js gives: tstamp
// embeds the toolkit's tempo semantics, and a tempo edit in the MEI (the
// Cancan's mm=144) would move every later bar while quarters stay put.
//
// The MEI must be the alignment's score — checked behaviourally, exactly as
// make_standins.mjs checks it (tools/verovio_node.mjs): the fresh render's
// unique onset quarters must equal the alignment's score_onset set, or the
// tool refuses (--force to proceed anyway, reported in the output).
//
// Usage:
//   node tools/mei_measure_times.mjs --alignment <file.json> --mei <file.mei> [--force]
//
// Output: { toolkit, provenance, quarters: {rendered, aligned, misses, forced},
//           ref, measures: [{id, q, refSec}], end: {q, refSec} }
// `end.refSec` is the latest ref_offset: past the last onset, the alignment's
// own note-off pairs know where the music stops; extrapolating the last onset
// segment's slope would not.

import fs from "node:fs";
import path from "node:path";
import { buildTimeMap } from "../app/static/js/engine/time-map.js";
import { initVerovio, applyProvenance, checkOnsetQuarters } from "./verovio_node.mjs";

function parseArgs(argv) {
  const args = { alignment: null, mei: null, force: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--alignment") args.alignment = argv[++i];
    else if (a === "--mei") args.mei = argv[++i];
    else if (a === "--force") args.force = true;
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  if (!args.alignment || !args.mei) {
    console.error("usage: mei_measure_times.mjs --alignment <file.json> --mei <file.mei> [--force]");
    process.exit(2);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const { header, body } = JSON.parse(fs.readFileSync(path.resolve(args.alignment), "utf8"));
  const score = body && body.score;
  if (!score || !score.score_onset || !score.ref_onset)
    throw new Error("alignment has no body.score onset arrays — it is not score-aligned");
  const refGrid = body.audio[header.ref] && body.audio[header.ref].times;
  if (!refGrid) throw new Error(`reference recording "${header.ref}" has no grid in body.audio`);

  const tk = await initVerovio();
  const prov = applyProvenance(header, tk);
  if (!tk.loadData(fs.readFileSync(path.resolve(args.mei), "utf8")))
    throw new Error("Verovio could not parse the MEI");
  const check = checkOnsetQuarters(tk, score);
  if (check.misses.length && !args.force)
    throw new Error(
      `onset quarters do NOT match the alignment's score_onset set:\n  ${check.misses.join("\n  ")}\n(--force to proceed anyway)`,
    );

  const map = buildTimeMap({
    scoreOnset: score.score_onset,
    refOnset: score.ref_onset,
    refGrid,
    targetGrid: refGrid,
  });
  const timemap = tk.renderToTimemap({ includeMeasures: true });
  const measures = [];
  let endQ = 0;
  for (const entry of timemap) {
    if (entry.qstamp > endQ) endQ = entry.qstamp;
    if (!entry.measureOn) continue;
    measures.push({ id: entry.measureOn, q: entry.qstamp, refSec: map.quartersToRefSec(entry.qstamp) });
  }

  process.stdout.write(
    JSON.stringify({
      toolkit: prov.liveVersion,
      provenance: prov.notes,
      quarters: {
        rendered: check.rendered,
        aligned: check.aligned,
        misses: check.misses,
        forced: check.misses.length > 0,
      },
      ref: header.ref,
      measures,
      end: { q: endQ, refSec: Math.max(...score.ref_offset) },
    }),
  );
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
