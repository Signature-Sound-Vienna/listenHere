#!/usr/bin/env node
// tools/make_standins.mjs — copyright-safe MIDI stand-ins (plan §13, roadmap item 18)
//
// Copyright blocks publishing the real recordings online, so online exhibits
// get a stand-in: the score's MIDI warped onto each recording's timeline via
// the alignment, carrying the real performance's tempo (and, from the
// published peaks, its dynamics) with zero copyrighted audio.
//
// Per recording, emits a warped .mid by TEMPO-TRACK REPLACEMENT: note events
// keep their ticks (channels, programs, and track structure untouched); the
// existing tempo events are stripped and ~one tempo event per unique onset is
// inserted, each computed CUMULATIVELY against the ideal absolute time so
// rounding never accumulates. Optionally also a preview WAV via the engine's
// synthToWav under the same warped tempo track.
//
// The time route is QUARTERS ONLY (tick/tpq → score_onset → ref_onset → grid;
// engine/time-map.js owns the chain). Stored synth_onset is never read — it
// embeds the generating toolkit's tempo semantics (the 4 s tick-0 skew class,
// fixed 0.37.1).
//
// Provenance contract (feedback: verovio-option-provenance): the alignment's
// header.verovioVersion + header.verovioOptions stamps are read and honoured —
// an absent options stamp means pre-Verovio-6 no-expansion semantics, which
// expandNever pins; a stamped expansion is applied to the live toolkit
// instead. The decisive compatibility check is behavioural: the deduplicated
// onset quarters of the fresh render must match the alignment's score_onset
// set exactly, or the tool refuses.
//
// MIDI tempo ceiling: a 24-bit tempo tops out at ~16.777 s per quarter, and
// the alignment data contains inter-onset gaps far beyond it (~36 s of real
// audio on a quarter-beat of score near the piece's end — an alignment
// artifact in the aligner's known worst zone, plan §5.2d). No event splitting
// can exceed the per-tick ceiling while note ticks stay untouched, so such
// segments are clamped at the ceiling and the cumulative construction catches
// up over the following segments; every clamped zone is reported per
// recording, and verification excludes those zones from its exactness
// assertion while reporting their residual separately.
//
// Usage:
//   node tools/make_standins.mjs --alignment ExhibitAnnots/Alignment_Fledermaus_HQ.json \
//     [--mei app/static/exhibit/data/fledermaus.mei]  (default: fetch header.meiUri)
//     [--out DIR]                (default: <alignment dir>/standins)
//     [--recordings A,B]        (case-insensitive substring filter; default all)
//     [--wav]                    (also render preview WAVs — ~25 MB each)
//     [--stereo --audio-dir DIR] (also mix one audition WAV per recording:
//                                 LEFT = the real recording from DIR/<key>,
//                                 mono at 22050 Hz, RIGHT = the warped synth,
//                                 channels normalised separately, sample-locked
//                                 — plan §13 ruling 2's construction, offline.
//                                 Misalignment is heard as inter-ear flams.
//                                 Requires ffmpeg on PATH; ~50 MB each)
//     [--no-dynamics]            (skip peaks-derived velocity shaping)
//     [--no-verify]              (skip reparse-and-check of written files)
//     [--force]                  (proceed past a failed provenance check)

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  parseMidi,
  tickToSec,
  synthToWav,
} from "../app/static/js/engine/mei-synth.js";
import { buildTimeMap, dedupePairs } from "../app/static/js/engine/time-map.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VEROVIO_PATH = path.join(ROOT, "app/static/js/verovio-toolkit-wasm.js");
const MAX_TEMPO = 0xffffff; // 24-bit µs per quarter ≈ 16.777 s
const CLAMP_REPORT_S = 0.001; // residual beyond this marks a catch-up zone

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    alignment: null,
    mei: null,
    out: null,
    recordings: null,
    wav: false,
    stereo: false,
    audioDir: null,
    dynamics: true,
    verify: true,
    force: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--alignment") args.alignment = argv[++i];
    else if (a === "--mei") args.mei = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--recordings")
      args.recordings = argv[++i].split(",").map((s) => s.trim().toLowerCase());
    else if (a === "--wav") args.wav = true;
    else if (a === "--stereo") args.stereo = true;
    else if (a === "--audio-dir") args.audioDir = argv[++i];
    else if (a === "--no-dynamics") args.dynamics = false;
    else if (a === "--no-verify") args.verify = false;
    else if (a === "--force") args.force = true;
    else if (a === "--help" || a === "-h") {
      usage();
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      usage();
      process.exit(2);
    }
  }
  if (!args.alignment) {
    usage();
    process.exit(2);
  }
  if (args.stereo && !args.audioDir) {
    console.error("--stereo needs --audio-dir (where the real recordings live)");
    process.exit(2);
  }
  return args;
}

function usage() {
  const header = fs
    .readFileSync(fileURLToPath(import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.startsWith("//"))
    .map((l) => l.slice(3))
    .join("\n");
  console.log(header);
}

// ---------------------------------------------------------------------------
// Verovio (vendored toolkit, native in Node: require + construct-poll — 6.x
// exposes no calledRun, so readiness is probed by constructing the toolkit)
// ---------------------------------------------------------------------------

async function initVerovio() {
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
 * is advisory — the behavioural quarters check below is decisive.
 */
function applyProvenance(header, tk) {
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

// ---------------------------------------------------------------------------
// SMF read/write (event-level pass-through; parseMidi only extracts notes and
// tempi, and the warped file must keep programs, channels, and track
// structure untouched, so the rewriter keeps every event verbatim)
// ---------------------------------------------------------------------------

/** Parse an SMF into { format, tpq, tracks } with absolute-tick events. */
function readSmf(bytes) {
  let p = 0;
  const r4 = () => {
    const v =
      ((bytes[p] << 24) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3]) >>> 0;
    p += 4;
    return v;
  };
  const r2 = () => {
    const v = (bytes[p] << 8) | bytes[p + 1];
    p += 2;
    return v;
  };
  const rv = () => {
    let v = 0;
    for (;;) {
      const b = bytes[p++];
      v = (v << 7) | (b & 0x7f);
      if (!(b & 0x80)) break;
    }
    return v;
  };
  if (String.fromCharCode(...bytes.slice(0, 4)) !== "MThd")
    throw new Error("not an SMF (no MThd)");
  p = 4;
  const hlen = r4();
  const format = r2();
  const nTracks = r2();
  const tpq = r2();
  p = 8 + hlen;
  const tracks = [];
  for (let tr = 0; tr < nTracks; tr++) {
    if (String.fromCharCode(...bytes.slice(p, p + 4)) !== "MTrk")
      throw new Error(`track ${tr}: no MTrk at offset ${p}`);
    p += 4;
    const tlen = r4();
    const endPos = p + tlen;
    const events = [];
    let tick = 0,
      rs = 0;
    while (p < endPos) {
      tick += rv();
      const b = bytes[p];
      if (b === 0xff) {
        p++;
        const meta = bytes[p++];
        const mlen = rv();
        events.push({ tick, meta, data: bytes.slice(p, p + mlen) });
        p += mlen;
      } else if (b === 0xf0 || b === 0xf7) {
        p++;
        const slen = rv();
        events.push({ tick, sysex: b, data: bytes.slice(p, p + slen) });
        p += slen;
      } else {
        if (b & 0x80) {
          rs = b;
          p++;
        }
        const kind = (rs >> 4) & 0xf;
        const d1 = bytes[p++];
        if (kind === 0xc || kind === 0xd) {
          events.push({ tick, status: rs, d1 });
        } else {
          const d2 = bytes[p++];
          events.push({ tick, status: rs, d1, d2 });
        }
      }
    }
    tracks.push(events);
    p = endPos;
  }
  return { format, tpq, tracks };
}

function vlq(n) {
  const out = [n & 0x7f];
  while ((n = Math.floor(n / 128))) out.unshift((n & 0x7f) | 0x80);
  return out;
}

/** Serialise { format, tpq, tracks } back to SMF bytes (explicit status). */
function writeSmf(smf) {
  const chunks = [];
  const head = new Uint8Array(14);
  head.set([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6]);
  head[8] = smf.format >> 8;
  head[9] = smf.format & 0xff;
  head[10] = smf.tracks.length >> 8;
  head[11] = smf.tracks.length & 0xff;
  head[12] = smf.tpq >> 8;
  head[13] = smf.tpq & 0xff;
  chunks.push(head);
  for (const events of smf.tracks) {
    const body = [];
    let prev = 0;
    for (const e of events) {
      body.push(...vlq(e.tick - prev));
      prev = e.tick;
      if (e.meta !== undefined) {
        body.push(0xff, e.meta, ...vlq(e.data.length), ...e.data);
      } else if (e.sysex !== undefined) {
        body.push(e.sysex, ...vlq(e.data.length), ...e.data);
      } else {
        body.push(e.status, e.d1);
        if (e.d2 !== undefined) body.push(e.d2);
      }
    }
    const hdr = new Uint8Array(8);
    hdr.set([0x4d, 0x54, 0x72, 0x6b]);
    const len = body.length;
    hdr[4] = (len >>> 24) & 0xff;
    hdr[5] = (len >>> 16) & 0xff;
    hdr[6] = (len >>> 8) & 0xff;
    hdr[7] = len & 0xff;
    chunks.push(hdr, new Uint8Array(body));
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Stereo audition mix (plan §13 ruling 2, offline form): LEFT = the real
// recording mixed down to mono at the synth's 22050 Hz, RIGHT = the warped
// synth, channels peak-normalised separately, sample-locked because both
// timelines start at the recording's t = 0. Misalignment is heard as
// inter-ear flams; on the reference it audits score↔ref, on any other
// recording the composed chain. The listen.js in-app row (session 2) builds
// the same construction live.
// ---------------------------------------------------------------------------

/** Decode any audio file to mono 16-bit PCM at 22050 Hz via ffmpeg. */
function decodeRealMono22050(file) {
  const res = spawnSync(
    "ffmpeg",
    ["-v", "error", "-i", file, "-ac", "1", "-ar", "22050", "-f", "s16le", "-"],
    { maxBuffer: 1 << 30 },
  );
  if (res.error)
    throw new Error(`ffmpeg not runnable (${res.error.message}) — --stereo needs ffmpeg on PATH`);
  if (res.status !== 0)
    throw new Error(`ffmpeg failed on ${file}: ${res.stderr}`);
  const buf = res.stdout;
  const even = buf.byteLength - (buf.byteLength % 2);
  return new Int16Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + even));
}

/** Peak-normalise `ch` to 0.89 full scale into every `stride`-th slot of `out`. */
function normaliseInto(out, stride, offset, ch) {
  let peak = 1;
  for (let i = 0; i < ch.length; i++) {
    const a = Math.abs(ch[i]);
    if (a > peak) peak = a;
  }
  const scale = (0.89 * 32767) / peak;
  for (let i = 0; i < ch.length; i++) out[offset + i * stride] = Math.round(ch[i] * scale);
}

/** Write a 16-bit stereo WAV at 22050 Hz; shorter channel zero-padded. */
function writeStereoWav(file, left, right) {
  const n = Math.max(left.length, right.length);
  const inter = new Int16Array(2 * n);
  normaliseInto(inter, 2, 0, left);
  normaliseInto(inter, 2, 1, right);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + inter.byteLength, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(2, 22);
  header.writeUInt32LE(22050, 24);
  header.writeUInt32LE(22050 * 4, 28);
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(inter.byteLength, 40);
  fs.writeFileSync(file, Buffer.concat([header, Buffer.from(inter.buffer)]));
  return n / 22050;
}

// ---------------------------------------------------------------------------
// The warp
// ---------------------------------------------------------------------------

/**
 * Tempo events realising ideal absolute times at the knot ticks, computed
 * cumulatively (each segment aims at the next knot's ideal absolute time, so
 * per-event rounding — and any ceiling clamp — is absorbed by the following
 * segments instead of accumulating). Returns the events plus the knots whose
 * realised time still missed the ideal by more than CLAMP_REPORT_S — the
 * catch-up zones downstream of over-ceiling segments.
 */
function buildTempoEvents(knotTicks, knotTimes, tpq) {
  const events = [];
  const missedKnots = [];
  let curTick = 0,
    curUs = 0,
    lastTempo = -1,
    clamped = 0;
  for (let i = 0; i < knotTicks.length; i++) {
    const dt = knotTicks[i] - curTick;
    if (dt > 0) {
      const needUs = knotTimes[i] * 1e6 - curUs;
      let tempo = Math.round((needUs / dt) * tpq);
      if (tempo < 1) tempo = 1;
      if (tempo > MAX_TEMPO) {
        tempo = MAX_TEMPO;
        clamped++;
      }
      if (tempo !== lastTempo) {
        events.push({ tick: curTick, tempo });
        lastTempo = tempo;
      }
      curUs += (tempo * dt) / tpq;
      curTick = knotTicks[i];
    }
    if (Math.abs(curUs / 1e6 - knotTimes[i]) > CLAMP_REPORT_S)
      missedKnots.push({
        tick: knotTicks[i],
        idealS: knotTimes[i],
        realisedS: curUs / 1e6,
      });
  }
  return { events, clamped, missedKnots };
}

/**
 * Rewrite the SMF: strip every existing tempo event, insert the new tempo
 * track into track 0, and (when velocityOf is given) reshape note-on
 * velocities. Note ticks, channels, programs, and track structure untouched.
 */
function warpSmf(smf, tempoEvents, velocityOf) {
  const tracks = smf.tracks.map((events, ti) => {
    let out = events.filter((e) => e.meta !== 0x51);
    const eot = out.filter((e) => e.meta === 0x2f);
    out = out.filter((e) => e.meta !== 0x2f);
    if (velocityOf)
      out = out.map((e) =>
        e.status !== undefined && (e.status & 0xf0) === 0x90 && e.d2 > 0
          ? { ...e, d2: velocityOf(e.tick, e.d1, e.d2) }
          : e,
      );
    if (ti === 0)
      out = out.concat(
        tempoEvents.map(({ tick, tempo }) => ({
          tick,
          meta: 0x51,
          data: new Uint8Array([
            (tempo >> 16) & 0xff,
            (tempo >> 8) & 0xff,
            tempo & 0xff,
          ]),
        })),
      );
    out.sort((a, b) => a.tick - b.tick); // stable: same-tick original order kept
    const lastTick = out.length ? out[out.length - 1].tick : 0;
    const eotTick = eot.length ? Math.max(eot[0].tick, lastTick) : lastTick;
    out.push({ tick: eotTick, meta: 0x2f, data: new Uint8Array(0) });
    return out;
  });
  return { format: smf.format, tpq: smf.tpq, tracks };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv);
  const alignPath = path.resolve(args.alignment);
  const alignment = JSON.parse(fs.readFileSync(alignPath, "utf8"));
  const { header, body } = alignment;
  const score = body && body.score;
  if (!score || !score.score_onset || !score.ref_onset)
    throw new Error("alignment has no body.score onset arrays — nothing to warp");
  const refName = header.ref;
  const refGrid = body.audio[refName] && body.audio[refName].times;
  if (!refGrid)
    throw new Error(`reference recording "${refName}" has no grid in body.audio`);

  // MEI: local pin wins; otherwise fetch the alignment's own meiUri.
  let meiText;
  if (args.mei && !/^https?:/.test(args.mei)) {
    meiText = fs.readFileSync(path.resolve(args.mei), "utf8");
    console.log(`MEI: ${args.mei}`);
  } else {
    const uri = args.mei || header.meiUri;
    console.log(`MEI: fetching ${uri}`);
    const resp = await fetch(uri);
    if (!resp.ok) throw new Error(`could not fetch MEI (HTTP ${resp.status})`);
    meiText = await resp.text();
  }

  console.log("Initialising Verovio…");
  const tk = await initVerovio();
  const prov = applyProvenance(header, tk);
  for (const n of prov.notes) console.log(`  provenance: ${n}`);
  console.log(`  toolkit: ${prov.liveVersion}`);

  if (!tk.loadData(meiText)) throw new Error("Verovio could not parse the MEI");
  const midiBase64 = tk.renderToMIDI();
  if (!midiBase64) throw new Error("Verovio produced empty MIDI output");
  const midiBytes = Uint8Array.from(Buffer.from(midiBase64, "base64"));
  const { tpq, notes } = parseMidi(midiBytes);
  const smf = readSmf(midiBytes);
  console.log(
    `Rendered MIDI: format ${smf.format}, ${smf.tracks.length} tracks, tpq ${tpq}, ${notes.length} notes`,
  );

  // THE decisive provenance check: the fresh render's unique onset quarters
  // must equal the alignment's deduplicated score_onset set.
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
  if (misses.length) {
    const msg = `onset quarters do NOT match the alignment's score_onset set:\n  ${misses.join("\n  ")}`;
    if (!args.force) throw new Error(msg + "\n(--force to proceed anyway)");
    console.warn(`WARNING (forced past): ${msg}`);
  } else {
    console.log(
      `Quarters check: ${renderedQ.length}/${alignQ.length} onset quarters match the alignment exactly`,
    );
  }

  const outDir = path.resolve(args.out || path.join(path.dirname(alignPath), "standins"));
  fs.mkdirSync(outDir, { recursive: true });

  const wanted = Object.keys(body.audio).filter(
    (name) =>
      !args.recordings ||
      args.recordings.some((s) => name.toLowerCase().includes(s)),
  );
  if (!wanted.length) throw new Error("no recordings match --recordings");

  const maxEndTick = notes.reduce((m, n) => Math.max(m, n.e), 0);
  const manifest = {
    createdAt: new Date().toISOString(),
    alignment: path.relative(ROOT, alignPath),
    verovio: { version: prov.liveVersion, options: prov.appliedOptions },
    stamps: {
      verovioVersion: header.verovioVersion || null,
      verovioOptions: header.verovioOptions || null,
    },
    dynamics: args.dynamics,
    tpq,
    notes: notes.length,
    onsets: renderedQ.length,
    recordings: {},
  };

  for (const name of wanted) {
    const rec = body.audio[name];
    const map = buildTimeMap({
      scoreOnset: score.score_onset,
      refOnset: score.ref_onset,
      refGrid,
      targetGrid: rec.times,
    });

    // Knots: every unique onset tick, plus the final note end so sustains
    // after the last onset land right. Targets are the composed map's word.
    const knotTicks = onsetTicks.slice();
    if (maxEndTick > knotTicks[knotTicks.length - 1]) knotTicks.push(maxEndTick);
    const knotTimes = knotTicks.map((t) => map.quartersToSec(t / tpq));
    const { events, clamped, missedKnots } = buildTempoEvents(
      knotTicks,
      knotTimes,
      tpq,
    );

    // Dynamics from the published peaks envelope (ruling 3): note-on
    // velocities scaled by the recording's own normalised envelope, sampled
    // at each note's WARPED onset. Linear with a floor so quiet passages
    // stay audible; the render step (session 2) is the place to refine the
    // curve if fluidsynth wants a different law.
    let velocityOf = null;
    if (args.dynamics && rec.peaks && rec.peaks.length && rec.duration) {
      const peaks = rec.peaks;
      const peakMax = peaks.reduce((m, v) => Math.max(m, v), 0) || 1;
      const dur = rec.duration;
      const envAt = (t) => {
        const i = Math.max(
          0,
          Math.min(peaks.length - 1, Math.floor((t / dur) * peaks.length)),
        );
        return peaks[i] / peakMax;
      };
      const timeOfTick = new Map(knotTicks.map((t, i) => [t, knotTimes[i]]));
      velocityOf = (tick, _pitch, vel) => {
        const t = timeOfTick.get(tick) ?? map.quartersToSec(tick / tpq);
        return Math.max(1, Math.min(127, Math.round(vel * (0.15 + 0.85 * envAt(t)))));
      };
    }

    const warped = warpSmf(smf, events, velocityOf);
    const outBytes = writeSmf(warped);
    const base = name.replace(/\.wav$/i, "").replace(/[/\\]/g, "_");
    const midPath = path.join(outDir, `${base}.standin.mid`);
    fs.writeFileSync(midPath, outBytes);

    const stats = {
      mid: path.relative(ROOT, midPath),
      tempoEvents: events.length,
      clampedSegments: clamped,
      catchUpKnots: missedKnots.length,
      durationS: +knotTimes[knotTimes.length - 1].toFixed(3),
    };

    // Verification: reparse the written file and hold it to the map's word.
    if (args.verify) {
      const re = parseMidi(fs.readFileSync(midPath));
      const reTicks = [...new Set(re.notes.map((n) => n.s))].sort((a, b) => a - b);
      if (
        re.notes.length !== notes.length ||
        reTicks.length !== onsetTicks.length ||
        reTicks.some((t, i) => t !== onsetTicks[i])
      )
        throw new Error(`${name}: warped file's notes/ticks differ from the source render`);
      const missed = new Set(missedKnots.map((k) => k.tick));
      let maxErr = 0,
        maxErrClamped = 0;
      for (let i = 0; i < onsetTicks.length; i++) {
        const err = Math.abs(
          tickToSec(onsetTicks[i], re.tpq, re.tempoChanges) -
            map.quartersToSec(onsetTicks[i] / tpq),
        );
        if (missed.has(onsetTicks[i])) {
          if (err > maxErrClamped) maxErrClamped = err;
        } else if (err > maxErr) maxErr = err;
      }
      if (maxErr > 0.001)
        throw new Error(
          `${name}: max onset error ${(maxErr * 1000).toFixed(3)} ms outside catch-up zones`,
        );
      stats.maxOnsetErrorMs = +(maxErr * 1000).toFixed(4);
      if (missedKnots.length)
        stats.catchUpMaxResidualS = +maxErrClamped.toFixed(3);
    }

    // Preview WAV and/or stereo audition mix, both under the same warped
    // tempo track (opt-in: ~25 MB / ~50 MB each).
    if (args.wav || args.stereo) {
      const re = parseMidi(fs.readFileSync(midPath));
      process.stdout.write(`  synthesising ${base}…`);
      const blob = await synthToWav(re.notes, re.tpq, re.tempoChanges, null);
      const ab = await blob.arrayBuffer();
      if (args.wav) {
        const wavPath = path.join(outDir, `${base}.standin.wav`);
        fs.writeFileSync(wavPath, Buffer.from(ab));
        stats.wav = path.relative(ROOT, wavPath);
      }
      if (args.stereo) {
        const realPath = path.join(args.audioDir, name);
        if (!fs.existsSync(realPath))
          throw new Error(`--stereo: no real audio at ${realPath} (alignment keys name the files)`);
        const synthPcm = new Int16Array(ab, 44, (ab.byteLength - 44) >> 1);
        const lrPath = path.join(outDir, `${base}.LR-real-vs-synth.wav`);
        const secs = writeStereoWav(lrPath, decodeRealMono22050(realPath), synthPcm);
        stats.stereo = path.relative(ROOT, lrPath);
        process.stdout.write(` L/R ${secs.toFixed(1)} s`);
      }
      process.stdout.write("\n");
    }

    manifest.recordings[name] = stats;
    console.log(
      `${name}: ${events.length} tempo events` +
        (clamped
          ? `, ${clamped} over-ceiling segments clamped (${missedKnots.length} catch-up knots)`
          : "") +
        (stats.maxOnsetErrorMs !== undefined
          ? `, max onset error ${stats.maxOnsetErrorMs} ms`
          : ""),
    );
  }

  const manifestPath = path.join(outDir, "standins-manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`\nWrote ${wanted.length} stand-in(s) + ${path.relative(ROOT, manifestPath)}`);
}

main().catch((e) => {
  console.error(`make_standins: ${e.message}`);
  process.exit(1);
});
