// 41. Alignment-correction increment 1 (plan §14) — the pure correction
// model (engine/correction-model.js) and the worker's anchored segment
// realign (fix_begin / fix_realign_segment in align-worker.js's Python).
//
// Model tests use the spec-40 no-app-boot module-page pattern. Worker tests
// run the worker's own PYTHON_CODE verbatim under system python3 + numpy +
// scipy (the 39.3 mechanism, extended: the whole blob executes with a
// stubbed `js` module), against a synthetic scenario whose ground truth is
// analytic — the same 16 chromatic notes synthesised under two tempo maps,
// so every true onset time is computable in closed form. The JS message
// plumbing (fix_begin/fix_realign/fix_dispose handlers) is thin and is
// exercised by the fix-mode UI specs (increment 2+).
import { test, expect } from '../support/fixtures';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const MODULE_URL = '/static/js/engine/correction-model.js';

/* ------------------------------------------------------------------ */
/* The synthetic scenario                                              */
/* ------------------------------------------------------------------ */

// MIDI A (the "score"): TPQ 120, tempo 500000 µs/beat (120 BPM), sixteen
// chromatic quarter notes 60..75 back to back. Chromatic pitches give every
// event a distinct chroma column, so segment DTW has real discrimination.
const TPQ = 120;
const N_NOTES = 16;
function buildMidiA(): Buffer {
  const track: number[] = [];
  track.push(0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20); // Δ0 tempo 500000
  for (let k = 0; k < N_NOTES; k++) {
    const p = 60 + k;
    track.push(0x00, 0x90, p, 64); // Δ0 note-on
    track.push(0x78, 0x80, p, 0); // Δ120 (one quarter) note-off
  }
  track.push(0x00, 0xff, 0x2f, 0x00); // end of track
  const header = [
    0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, (TPQ >> 8) & 0xff, TPQ & 0xff,
    0x4d, 0x54, 0x72, 0x6b,
    (track.length >> 24) & 0xff, (track.length >> 16) & 0xff,
    (track.length >> 8) & 0xff, track.length & 0xff,
  ];
  return Buffer.from([...header, ...track]);
}

// MIDI B: the same chromatic ladder one quarter apart, but every note is HELD
// 2.5 quarters, so off[k] > on[k+2] — the sustained-overlap shape that ties,
// pedal notes, and any polyphony produce. Measured against the next DISTINCT
// onset (comparing against on[i+1] only counts chord siblings): 41.9% of this
// repo's own 725-event fixture sustains past it and 33.5% of the Fledermaus HQ
// corpus; over the events an anchor is laid on, 24.2% of the fixture's onset
// groups and 8.3% of the corpus's, and at distance 2 — where the worker rather
// than the linear fill answers — 6.5% and 0.7%.
const HOLD_TICKS = 300;
function vlq(n: number): number[] {
  const out = [n & 0x7f];
  n >>= 7;
  while (n > 0) {
    out.unshift((n & 0x7f) | 0x80);
    n >>= 7;
  }
  return out;
}
function buildMidiOverlap(): Buffer {
  const evs: Array<{ tick: number; order: number; data: number[] }> = [];
  for (let k = 0; k < N_NOTES; k++) {
    const p = 60 + k;
    evs.push({ tick: TPQ * k, order: 1, data: [0x90, p, 64] });
    evs.push({ tick: TPQ * k + HOLD_TICKS, order: 0, data: [0x80, p, 0] });
  }
  evs.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const track: number[] = [0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20];
  let prev = 0;
  for (const e of evs) {
    track.push(...vlq(e.tick - prev), ...e.data);
    prev = e.tick;
  }
  track.push(0x00, 0xff, 0x2f, 0x00);
  const header = [
    0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, (TPQ >> 8) & 0xff, TPQ & 0xff,
    0x4d, 0x54, 0x72, 0x6b,
    (track.length >> 24) & 0xff, (track.length >> 16) & 0xff,
    (track.length >> 8) & 0xff, track.length & 0xff,
  ];
  return Buffer.from([...header, ...track]);
}

// The "reference performance" tempo map: 120 BPM for the first 8 quarters,
// 160 BPM (375000 µs/beat) from tick 960. True onset of event k:
//   k ≤ 8: 0.5·k   —   k > 8: 4.0 + 0.375·(k − 8)
function trueOnset(k: number): number {
  return k <= 8 ? 0.5 * k : 4.0 + 0.375 * (k - 8);
}

const HARNESS = `
import base64, json, sys, types
_js = types.ModuleType('js')
_js.reportProgress = lambda *a, **k: None
_js.reportStep = lambda *a, **k: None
sys.modules['js'] = _js

with open(sys.argv[2]) as f:
    exec(compile(f.read(), 'align-worker-python', 'exec'))

midi_a = base64.b64decode(sys.argv[1])
tpq, tcs, notes = parse_midi(midi_a)

tcs_b = [(0, 500000), (960, 375000)]
dur_b = _tick_to_sec(max(n[1] for n in notes), tpq, tcs_b) + 0.5
ref_audio = synth_midi_audio(notes, tpq, tcs_b, dur_b)

ev = fix_begin(ref_audio, midi_a)
n = ev['n_events']
ref_dur = ev['ref_duration']
true_on = [_tick_to_sec(int(round(q * tpq)), tpq, tcs_b) for q in ev['score_onset']]
naive = [s * ref_dur / ev['midi_duration'] for s in ev['synth_onset']]

out = {'events': ev, 'trueOn': true_on}

# S1: corner-to-corner refill guided by the deliberately naive linear prior.
out['s1'] = fix_realign_segment(-1, 0.0, n, ref_dur, naive, 4.0, None)

# S2: event 8 anchored WRONG on purpose (+0.4 s); refill both flanks.
t8w = true_on[8] + 0.4
out['t8w'] = t8w
out['s2l'] = fix_realign_segment(-1, 0.0, 8, t8w, naive[0:8], 4.0, None)
out['s2r'] = fix_realign_segment(8, t8w, n, ref_dur, naive[9:n], 4.0, None)

# S3: consecutive anchors — no interior events, no DTW.
out['s3'] = fix_realign_segment(7, true_on[7], 8, true_on[8], [], None, None)

# S5: the frame cap drives the hop up for long segments.
out['s5'] = fix_realign_segment(-1, 0.0, n, ref_dur, naive, 4.0, 200)

# S6: a DISCONTINUOUS true map — one 16.7 s quarter (the MIDI tempo field's
# ceiling) between events 8 and 9 makes the reference jump far more per
# score frame than the band slack at a coarse hop. Before the band floors
# were bridged to the previous ceiling, the rows went DISJOINT there: the
# DP was severed, every downstream cell was inf, and the backtrack walked
# out of band — the 2026-08-31 corpus break (a first-onset fix mapped the
# whole opening ~55 s late). Prior = truth; the refill must stay glued.
tcs_c = [(0, 500000), (960, 16777215), (1080, 375000)]
dur_c = _tick_to_sec(max(n2[1] for n2 in notes), tpq, tcs_c) + 0.5
ref_c = synth_midi_audio(notes, tpq, tcs_c, dur_c)
fix_begin(ref_c, midi_a)  # replaces the session for S6 and the error paths
true_c = [_tick_to_sec(int(round(q * tpq)), tpq, tcs_c) for q in ev['score_onset']]
ref_dur_c = len(ref_c) / SR
out['s6'] = fix_realign_segment(-1, 0.0, n, ref_dur_c, true_c, 0.5, 200)
out['trueC'] = true_c

def _raises(fn):
    try:
        fn()
        return False
    except Exception:
        return True

out['s4'] = {
    'badIndices': _raises(lambda: fix_realign_segment(8, 1.0, 3, 2.0, [], None, None)),
    'reversedTimes': _raises(lambda: fix_realign_segment(-1, 5.0, n, 1.0, naive, None, None)),
    'priorLen': _raises(lambda: fix_realign_segment(-1, 0.0, n, ref_dur, naive[0:3], None, None)),
}
fix_dispose()
out['s4']['afterDispose'] = _raises(lambda: fix_realign_segment(-1, 0.0, n, ref_dur, naive, None, None))

print(json.dumps(out))
`;

// The overlap scenario: two segments off the same held-note ladder — one
// whose left anchor sustains PAST the right anchor's onset (no image under
// this segment's warp) and one control whose offset lies inside the span.
const HARNESS_OVERLAP = `
import base64, json, sys, types
_js = types.ModuleType('js')
_js.reportProgress = lambda *a, **k: None
_js.reportStep = lambda *a, **k: None
sys.modules['js'] = _js

with open(sys.argv[2]) as f:
    exec(compile(f.read(), 'align-worker-python', 'exec'))

midi = base64.b64decode(sys.argv[1])
tpq, tcs, notes = parse_midi(midi)

tcs_b = [(0, 500000), (480, 375000)]
dur_b = _tick_to_sec(max(n[1] for n in notes), tpq, tcs_b) + 0.5
ref_audio = synth_midi_audio(notes, tpq, tcs_b, dur_b)

ev = fix_begin(ref_audio, midi)
s_on = list(ev['synth_onset']); s_off = list(ev['synth_offset'])
ref_dur = ev['ref_duration']; midi_dur = ev['midi_duration']

def true_on(k):
    return _tick_to_sec(int(round(ev['score_onset'][k] * tpq)), tpq, tcs_b)

def run(i_a, i_b):
    t_a = true_on(i_a); t_b = true_on(i_b)
    prior = [s_on[k] * ref_dur / midi_dur for k in range(i_a + 1, i_b)]
    res = fix_realign_segment(i_a, t_a, i_b, t_b, prior)
    res['t_a'] = t_a; res['t_b'] = t_b
    res['s_a'] = s_on[i_a]; res['s_b'] = s_on[i_b]
    res['s_off_a'] = s_off[i_a]
    res['s_off_interior'] = [s_off[k] for k in range(i_a + 1, i_b)]
    return res

print(json.dumps({'events': ev, 'over': run(2, 4), 'ctrl': run(2, 7)}))
`;

/** Run one python harness over align-worker.js's own PYTHON_CODE blob. */
function execPython(harness: string, midiB64: string): any {
  const workerSrc = fs.readFileSync(
    path.resolve(__dirname, '../../app/static/js/align-worker.js'),
    'utf8',
  );
  const tpl = workerSrc.match(/const PYTHON_CODE = `([\s\S]*?)`;/);
  expect(tpl, 'PYTHON_CODE template literal not found in align-worker.js').toBeTruthy();
  // Evaluate as a template literal so JS escape sequences reach Python
  // exactly as Pyodide sees them (the 39.3 mechanism).
  // eslint-disable-next-line no-eval
  const python: string = eval('`' + tpl![1] + '`');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lh-fix-spec-'));
  try {
    const blobPath = path.join(dir, 'align-worker-python.py');
    fs.writeFileSync(blobPath, python);
    const stdout = execFileSync('python3', ['-c', harness, midiB64, blobPath], {
      encoding: 'utf8',
      timeout: 110_000,
    });
    return JSON.parse(stdout.trim());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

let workerOut: any = null;
function runWorkerScenario(): any {
  if (!workerOut) workerOut = execPython(HARNESS, buildMidiA().toString('base64'));
  return workerOut;
}

let overlapOut: any = null;
function runOverlapScenario(): any {
  if (!overlapOut) {
    overlapOut = execPython(HARNESS_OVERLAP, buildMidiOverlap().toString('base64'));
  }
  return overlapOut;
}

function expectMonotonic(values: number[]) {
  for (let k = 1; k < values.length; k++) {
    expect(values[k], `index ${k} of ${JSON.stringify(values)}`).toBeGreaterThanOrEqual(
      values[k - 1],
    );
  }
}

/* ------------------------------------------------------------------ */
/* The pure correction model                                           */
/* ------------------------------------------------------------------ */

test.describe('41. alignment correction — model', () => {
  test('41.1 the first anchor splits the piece into two corner segments, anchors stay sorted', async ({ page }) => {
    await page.goto(MODULE_URL);
    const r = await page.evaluate(async () => {
      const m: any = await import('/static/js/engine/correction-model.js');
      const ctx = { nEvents: 10, refDuration: 100 };
      const st = m.createCorrections();
      const first = m.setAnchor(st, { i: 4, q: 4, t: 40, kind: 'drag', ts: 1 }, ctx);
      m.setAnchor(st, { i: 7, q: 7, t: 70, kind: 'approve', ts: 2 }, ctx);
      m.setAnchor(st, { i: 2, q: 2, t: 20, kind: 'approve', ts: 3 }, ctx);
      return { first, order: st.anchors.map((a: any) => a.i) };
    });
    expect(r.first.segments[0]).toEqual({ iA: -1, tA: 0, iB: 4, tB: 40, interiorCount: 4 });
    expect(r.first.segments[1]).toEqual({ iA: 4, tA: 40, iB: 10, tB: 100, interiorCount: 5 });
    expect(r.order).toEqual([2, 4, 7]);
  });

  test('41.2 anchor validation: neighbour bounds, index range, kind; re-anchor replaces', async ({ page }) => {
    await page.goto(MODULE_URL);
    const r = await page.evaluate(async () => {
      const m: any = await import('/static/js/engine/correction-model.js');
      const ctx = { nEvents: 10, refDuration: 100 };
      const st = m.createCorrections();
      m.setAnchor(st, { i: 4, q: 4, t: 40, kind: 'drag', ts: 1 }, ctx);
      const threw = (fn: () => void) => {
        try {
          fn();
          return false;
        } catch {
          return true;
        }
      };
      const beyondNext = threw(() =>
        m.setAnchor(st, { i: 2, q: 2, t: 50, kind: 'drag', ts: 2 }, ctx),
      );
      const badIndex = threw(() =>
        m.setAnchor(st, { i: 10, q: 10, t: 90, kind: 'drag', ts: 2 }, ctx),
      );
      const badKind = threw(() =>
        m.setAnchor(st, { i: 3, q: 3, t: 30, kind: 'nudge', ts: 2 }, ctx),
      );
      const rePin = m.setAnchor(st, { i: 4, q: 4, t: 45, kind: 'drag', ts: 9 }, ctx);
      return {
        beyondNext,
        badIndex,
        badKind,
        count: st.anchors.length,
        t: st.anchors[0].t,
        segments: rePin.segments,
      };
    });
    expect(r.beyondNext).toBe(true);
    expect(r.badIndex).toBe(true);
    expect(r.badKind).toBe(true);
    expect(r.count).toBe(1);
    expect(r.t).toBe(45);
    expect(r.segments[1].tA).toBe(45);
  });

  test('41.3 removeAnchor merges; gaps own their anchors and dissolve on re-pin', async ({ page }) => {
    await page.goto(MODULE_URL);
    const r = await page.evaluate(async () => {
      const m: any = await import('/static/js/engine/correction-model.js');
      const ctx = { nEvents: 10, refDuration: 100 };
      const st = m.createCorrections();
      m.setAnchor(st, { i: 2, q: 2, t: 20, kind: 'approve', ts: 1 }, ctx);
      m.setAnchor(st, { i: 4, q: 4, t: 40, kind: 'drag', ts: 1 }, ctx);
      m.setAnchor(st, { i: 7, q: 7, t: 70, kind: 'approve', ts: 1 }, ctx);
      const merged = m.removeAnchor(st, 4, ctx).segment;
      const gapRes = m.setGap(st, { i: 4, tEnd: 42, tResume: 58, ts: 2 }, ctx);
      const gapAnchors = st.anchors
        .filter((a: any) => a.kind === 'gap')
        .map((a: any) => [a.i, a.t]);
      const threw = (fn: () => void) => {
        try {
          fn();
          return false;
        } catch {
          return true;
        }
      };
      const gapAnchorProtected = threw(() => m.removeAnchor(st, 4, ctx));
      const afterRemove = m.removeGap(st, 4, ctx).segment;
      const noGapAnchorsLeft = st.anchors.every((a: any) => a.kind !== 'gap');
      // Re-pin one endpoint of a fresh gap as a plain drag → the label dissolves.
      m.setGap(st, { i: 4, tEnd: 42, tResume: 58, ts: 3 }, ctx);
      m.setAnchor(st, { i: 4, q: 4, t: 41, kind: 'drag', ts: 4 }, ctx);
      return {
        merged,
        gapSegments: gapRes.segments,
        gapAnchors,
        gapAnchorProtected,
        afterRemove,
        noGapAnchorsLeft,
        gapsAfterRePin: st.gaps.length,
      };
    });
    expect(r.merged).toEqual({ iA: 2, tA: 20, iB: 7, tB: 70, interiorCount: 4 });
    expect(r.gapAnchors).toEqual([
      [4, 42],
      [5, 58],
    ]);
    expect(r.gapSegments[0]).toEqual({ iA: 2, tA: 20, iB: 4, tB: 42, interiorCount: 1 });
    expect(r.gapSegments[1]).toEqual({ iA: 5, tA: 58, iB: 7, tB: 70, interiorCount: 1 });
    expect(r.gapAnchorProtected).toBe(true);
    expect(r.afterRemove).toEqual({ iA: 2, tA: 20, iB: 7, tB: 70, interiorCount: 4 });
    expect(r.noGapAnchorsLeft).toBe(true);
    expect(r.gapsAfterRePin).toBe(0);
  });

  test('41.4 applySegment touches interior only and its before-values undo exactly', async ({ page }) => {
    await page.goto(MODULE_URL);
    const r = await page.evaluate(async () => {
      const m: any = await import('/static/js/engine/correction-model.js');
      const ctx = { nEvents: 10, refDuration: 100 };
      const st = m.createCorrections();
      const seg = m.setAnchor(st, { i: 4, q: 4, t: 40, kind: 'drag', ts: 1 }, ctx)
        .segments[0]; // events 0..3
      const refOn = Array.from({ length: 10 }, (_, k) => k * 10);
      const refOff = Array.from({ length: 10 }, (_, k) => k * 10 + 5);
      const onBefore = refOn.slice();
      const offBefore = refOff.slice();
      const undoEntry = m.applySegment(refOn, refOff, seg, [1, 2, 3, 4], [1.5, 2.5, 3.5, 4.5]);
      const mutated = refOn.slice();
      const outsideUntouched =
        refOn.slice(4).join() === onBefore.slice(4).join() &&
        refOff.slice(4).join() === offBefore.slice(4).join();
      // Undo: splice the before-values back.
      m.applySegment(refOn, refOff, seg, undoEntry.beforeOn, undoEntry.beforeOff);
      const restored =
        refOn.join() === onBefore.join() && refOff.join() === offBefore.join();
      const threw = (fn: () => void) => {
        try {
          fn();
          return false;
        } catch {
          return true;
        }
      };
      const lengthGuard = threw(() => m.applySegment(refOn, refOff, seg, [1, 2], [1, 2]));
      const anchorBefore = m.applyAnchorValue(refOn, 4, 44.5);
      return { mutated, outsideUntouched, restored, lengthGuard, anchorBefore, anchorNow: refOn[4] };
    });
    expect(r.mutated.slice(0, 4)).toEqual([1, 2, 3, 4]);
    expect(r.outsideUntouched).toBe(true);
    expect(r.restored).toBe(true);
    expect(r.lengthGuard).toBe(true);
    expect(r.anchorBefore).toBe(40);
    expect(r.anchorNow).toBe(44.5);
  });

  test('41.5 serialization round-trips; verifyQuarters is the item-T entry guard', async ({ page }) => {
    await page.goto(MODULE_URL);
    const r = await page.evaluate(async () => {
      const m: any = await import('/static/js/engine/correction-model.js');
      const ctx = { nEvents: 10, refDuration: 100 };
      const st = m.createCorrections();
      m.setAnchor(st, { i: 4, q: 4.5, t: 40, kind: 'drag', ts: 111 }, ctx);
      m.setGap(st, { i: 6, tEnd: 62, tResume: 68, ts: 222 }, ctx);
      const base = { verovioVersion: '6.3.0', verovioOptions: { expand: 'none' } };
      const rec = m.serialize(st, base);
      const back = m.deserialize(rec);
      const threw = (fn: () => void) => {
        try {
          fn();
          return false;
        } catch {
          return true;
        }
      };
      const versionGuard = threw(() => m.deserialize({ version: 0, anchors: [], gaps: [] }));
      return {
        rec,
        backAnchors: back.state.anchors,
        backGaps: back.state.gaps,
        backBase: back.base,
        versionGuard,
        okSame: m.verifyQuarters([0, 1.5, 2], [0, 1.5, 2]),
        valueMismatch: m.verifyQuarters([0, 1.5, 2], [0, 1.75, 2]),
        lengthMismatch: m.verifyQuarters([0, 1.5], [0, 1.5, 2]),
      };
    });
    expect(r.rec.version).toBe(1);
    expect(r.backBase).toEqual({ verovioVersion: '6.3.0', verovioOptions: { expand: 'none' } });
    expect(r.backAnchors).toEqual(r.rec.anchors);
    expect(r.backGaps).toEqual(r.rec.gaps);
    expect(r.versionGuard).toBe(true);
    expect(r.okSame.ok).toBe(true);
    expect(r.valueMismatch.ok).toBe(false);
    expect(r.valueMismatch.firstMismatch).toEqual({ index: 1, stored: 1.5, fresh: 1.75 });
    expect(r.lengthMismatch.ok).toBe(false);
    expect(r.lengthMismatch.lengthMismatch).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* The worker's anchored segment realign                               */
/* ------------------------------------------------------------------ */

test.describe('41. alignment correction — worker segment realign', () => {
  test('41.6 fix_begin builds the score_align event table; corner refill recovers a known tempo map', async () => {
    test.setTimeout(120_000);
    const out = runWorkerScenario();
    expect(out.events.n_events).toBe(N_NOTES);
    for (let k = 0; k < N_NOTES; k++) {
      expect(out.events.score_onset[k]).toBeCloseTo(k, 9);
      expect(out.events.synth_onset[k]).toBeCloseTo(0.5 * k, 9);
      expect(out.trueOn[k]).toBeCloseTo(trueOnset(k), 9);
    }
    // Corner-to-corner refill (all 16 events interior), guided only by the
    // naive linear prior, must land near the analytic truth.
    expect(out.s1.hop).toBe(512);
    expect(out.s1.ref_onset.length).toBe(N_NOTES);
    expectMonotonic(out.s1.ref_onset);
    for (let k = 0; k < N_NOTES; k++) {
      expect(
        Math.abs(out.s1.ref_onset[k] - trueOnset(k)),
        `event ${k}: got ${out.s1.ref_onset[k]}, true ${trueOnset(k)}`,
      ).toBeLessThan(0.2);
    }
    expectMonotonic(out.s1.ref_offset);
  });

  test('41.7 a wrong anchor bends its flanks locally: bounds, monotonicity, far ends stay true', async () => {
    const out = runWorkerScenario();
    const t8w = out.t8w;
    // Left flank: events 0..7 stay within [0, t8w] and monotonic.
    expect(out.s2l.ref_onset.length).toBe(8);
    expectMonotonic(out.s2l.ref_onset);
    for (const v of out.s2l.ref_onset) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(t8w);
    }
    // Far from the anchor the band snaps back to the truth.
    for (let k = 0; k <= 4; k++) {
      expect(Math.abs(out.s2l.ref_onset[k] - trueOnset(k))).toBeLessThan(0.25);
    }
    // Right flank: events 9..15 within [t8w, ref_dur], monotonic, tail true.
    expect(out.s2r.ref_onset.length).toBe(7);
    expectMonotonic(out.s2r.ref_onset);
    for (const v of out.s2r.ref_onset) {
      expect(v).toBeGreaterThanOrEqual(t8w);
      expect(v).toBeLessThanOrEqual(out.events.ref_duration);
    }
    for (let k = 13; k <= 15; k++) {
      expect(Math.abs(out.s2r.ref_onset[k - 9] - trueOnset(k))).toBeLessThan(0.25);
    }
    // The whole corrected sequence is monotonic across the join.
    expectMonotonic([...out.s2l.ref_onset, t8w, ...out.s2r.ref_onset]);
  });

  test('41.8 empty interiors, error paths, and the adaptive hop cap', async () => {
    const out = runWorkerScenario();
    // Consecutive anchors: nothing to refill, no DTW run.
    expect(out.s3).toEqual({ ref_onset: [], ref_offset: [], anchor_a_offset: null, hop: 0 });
    // Bad calls raise instead of returning silently wrong data.
    expect(out.s4.badIndices).toBe(true);
    expect(out.s4.reversedTimes).toBe(true);
    expect(out.s4.priorLen).toBe(true);
    expect(out.s4.afterDispose).toBe(true);
    // maxFrames 200 on the full piece drives the hop to the cap's value.
    const expectedHop = Math.max(
      512,
      Math.ceil((out.events.midi_duration * 22050) / 200),
    );
    expect(out.s5.hop).toBe(expectedHop);
    expectMonotonic(out.s5.ref_onset);
  });

  test('41.9 a discontinuous map cannot sever the banded refill (bridged band floors)', async () => {
    const out = runWorkerScenario();
    const trueC: number[] = out.trueC;
    // The reference genuinely jumps ~16.7 s between events 8 and 9 — steeper
    // per score frame than the band slack at this hop. Pre-bridge, the band
    // rows went disjoint there and the decoded path corrupted WHOLESALE
    // (events far from the jump displaced by tens of seconds — the corpus
    // break). With connective floors the refill stays glued to the truth on
    // BOTH sides of the jump.
    expect(out.s6.ref_onset.length).toBe(N_NOTES);
    expectMonotonic(out.s6.ref_onset);
    for (let k = 0; k < N_NOTES; k++) {
      // Events 7–9 straddle the jump itself, where placement within the
      // giant sustain is genuinely ambiguous at this coarse hop (~120 ms
      // frames); everywhere else the refill must be tight. Pre-bridge, the
      // OPENING sat ~15.6 s off — either bound catches that wholesale.
      const tol = k >= 7 && k <= 9 ? 2.5 : 0.35;
      expect(
        Math.abs(out.s6.ref_onset[k] - trueC[k]),
        `event ${k}: got ${out.s6.ref_onset[k]}, true ${trueC[k]}`,
      ).toBeLessThan(tol);
    }
    expectMonotonic(out.s6.ref_offset);
  });

  test('41.10 an offset sustaining past the segment continues at its rate — never clipped, never null', async () => {
    const out = runOverlapScenario();
    const o = out.over;
    const rate = (o.t_b - o.t_a) / (o.s_b - o.s_a);
    // Precondition: the left anchor's note genuinely outlasts the segment.
    expect(o.s_off_a).toBeGreaterThan(o.s_b);
    expect(o.ref_onset.length).toBeGreaterThan(0);
    // It used to come back null, and the caller then left ref_offset[i_a]
    // STALE — a rightward drag could put it at or before the new onset, which
    // the synth floors at 20 ms and the ear hears as a dropped note. Now it
    // continues at the segment's own average rate.
    expect(o.anchor_a_offset).not.toBeNull();
    expect(o.anchor_a_offset).toBeGreaterThan(o.t_b);
    expect(o.anchor_a_offset).toBeCloseTo(o.t_b + (o.s_off_a - o.s_b) * rate, 6);
    // Interior offsets that overrun are no longer pinned to the segment edge
    // (they used to come back as an exact run of t_b, truncating the notes).
    o.s_off_interior.forEach((s: number, k: number) => {
      if (s > o.s_b) {
        expect(o.ref_offset[k]).toBeGreaterThan(o.t_b);
        expect(o.ref_offset[k]).toBeCloseTo(o.t_b + (s - o.s_b) * rate, 6);
      }
      // Whatever the case, a note never ends at or before it starts.
      expect(o.ref_offset[k]).toBeGreaterThan(o.ref_onset[k]);
    });
    // Onsets still clip INTO the segment: only offsets may reach past it.
    o.ref_onset.forEach((v: number) => {
      expect(v).toBeGreaterThanOrEqual(o.t_a);
      expect(v).toBeLessThanOrEqual(o.t_b);
    });
    // The extension is capped by the recording.
    expect(o.anchor_a_offset).toBeLessThanOrEqual(out.events.ref_duration);
    // Control: an offset inside the span is mapped by the warp exactly as
    // before — the new rule touches nothing that already worked.
    const c = out.ctrl;
    expect(c.s_off_a).toBeLessThan(c.s_b);
    expect(c.anchor_a_offset).toBeGreaterThan(c.t_a);
    expect(c.anchor_a_offset).toBeLessThan(c.t_b);
  });
});
