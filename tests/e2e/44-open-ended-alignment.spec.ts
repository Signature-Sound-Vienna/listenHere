// 44. Open-ended alignment — audio with no counterpart in the reference
// (applause, announcements, tuning).
//
// The wizard's DTW used to pin both endpoints, so material present in one
// signal and absent in the other could not be skipped, only stretched: the
// Fledermaus corpus's DVD 1, which opens with ~27 s of applause, aligned to a
// grid running from -67.5 s. The fix is a subsequence coarse DTW, asymmetric —
// the reference is consumed in full, the target may be entered and left
// anywhere — plus a reference span for the case where the reference ITSELF
// opens with applause.
//
// Worker tests run align-worker.js's own PYTHON_CODE blob verbatim under
// system python3 + numpy, against synthetic chroma whose ground truth is
// exact (a known number of flat "applause" frames spliced onto a tonal
// sequence), which is the cheap place to test a DTW change — no browser, no
// Pyodide. The UI tests drive the wizard and the listen view.
import { test, expect } from '../support/fixtures';
import {
  loadLocalAlignment,
  showWaveform,
  waitForWaveformsReady,
} from '../support/helpers';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const FIXTURES = path.resolve(__dirname, '..', 'fixtures');

/* ------------------------------------------------------------------ */
/* The worker's Python, driven directly                                */
/* ------------------------------------------------------------------ */

// Synthetic chroma. Tonal frames put their energy in two pitch classes and so
// score high on max/mean; "applause" frames spread it evenly over all twelve
// and score near 1. FEATURE_RATE is 10 Hz by default, so 10 frames = 1 s.
const HARNESS = `
import json, sys, types
import numpy as np

_js = types.ModuleType('js')
_js.reportProgress = lambda *a, **k: None
_js.reportStep = lambda *a, **k: None
sys.modules['js'] = _js

with open(sys.argv[1]) as f:
    exec(compile(f.read(), 'align-worker-python', 'exec'))

def tonal(n, seed):
    r = np.random.default_rng(seed)
    ch = np.full((12, n), 0.05, dtype=np.float32)
    for k in range(0, n, 20):
        pc = int(r.integers(0, 12))
        ch[pc, k:k + 20] = 1.0
        ch[(pc + 7) % 12, k:k + 20] = 0.5
    ch += r.random((12, n)).astype(np.float32) * 0.01
    ch /= np.linalg.norm(ch, axis=0, keepdims=True)
    return ch

def flat(n, seed):
    r = np.random.default_rng(seed)
    ch = np.ones((12, n), dtype=np.float32) + r.random((12, n)).astype(np.float32) * 0.10
    ch /= np.linalg.norm(ch, axis=0, keepdims=True)
    return ch

out = {}

# --- the discriminator ---
out['peakTonal'] = float(np.median(chroma_peakiness(tonal(400, 3))))
out['peakFlat'] = float(np.median(chroma_peakiness(flat(400, 4))))

# --- detect_music_span: head and tail only, and it refuses a wild trim ---
HEAD, TAIL, BODY = 120, 80, 600
sig = np.concatenate([flat(HEAD, 6), tonal(BODY, 5), flat(TAIL, 7)], axis=1)
i0, i1 = detect_music_span(sig)
out['spanHeadErr'] = int(i0 - HEAD)
out['spanTailErr'] = int(i1 - (HEAD + BODY - 1))
out['spanClean'] = list(detect_music_span(tonal(600, 5))) == [0, 599]
out['spanNothingTonal'] = list(detect_music_span(flat(400, 8))) == [0, 399]
out['spanRefusesBigTrim'] = list(
    detect_music_span(np.concatenate([flat(500, 9), tonal(300, 10)], axis=1))
) == [0, 799]

# --- _dtw_f32: pinned unchanged, open_ends enters past the applause ---
PRE = 60
ref = tonal(200, 11)
tgt = np.concatenate([flat(PRE, 12), ref], axis=1)
C = np.clip(1.0 - ref.T @ tgt, 0, 2).astype(np.float32)
pin = _dtw_f32(C)
opn = _dtw_f32(C, open_ends=True)
out['pinnedStart'] = [int(pin[0][0]), int(pin[1][0])]
out['pinnedEnd'] = [int(pin[0][-1]), int(pin[1][-1])]
out['openStart'] = [int(opn[0][0]), int(opn[1][0])]
out['openEnd'] = [int(opn[0][-1]), int(opn[1][-1])]

# --- align_pair end to end ---
ref_dur = (ref.shape[1] - 1) / FEATURE_RATE
tgt_dur = (tgt.shape[1] - 1) / FEATURE_RATE
p = align_pair(ref, tgt, ref_dur, tgt_dur)
o = align_pair(ref, tgt, ref_dur, tgt_dur, open_ends=True)
out['refDur'] = ref_dur
out['tgtDur'] = tgt_dur
out['pinFirstTime'] = round(p['times'][0], 3)
out['openFirstTime'] = round(o['times'][0], 3)
out['openFrom'] = round(o['from'], 3)
out['openTo'] = round(o['to'], 3)
out['openGuard'] = o['guard']
out['gridLensEqual'] = len(p['times']) == len(o['times'])
out['noNegative'] = min(min(o['times']), min(p['times'])) >= 0.0
out['noOverrun'] = max(max(o['times']), max(p['times'])) <= tgt_dur

# --- the detector's window bounds what the free ends may skip ---
# Unbounded free ends overshoot: they cut seconds off recordings that have
# nothing extra in them at all, because skipping columns means fewer cells to
# pay for. Every shipped pair therefore passes target_span.
def warp(ch, factor, seed):
    n = ch.shape[1]
    m = int(round(n * factor))
    r = np.random.default_rng(seed)
    t = np.linspace(0, n - 1, m) + r.normal(0, 0.8, m)
    t = np.clip(np.maximum.accumulate(t), 0, n - 1)
    o = ch[:, np.round(t).astype(int)]
    o = o + r.random(o.shape).astype(np.float32) * 0.18
    o /= np.linalg.norm(o, axis=0, keepdims=True)
    return o.astype(np.float32)

def trims(ref_ch, tgt_ch, bounded):
    rd = (ref_ch.shape[1] - 1) / FEATURE_RATE
    td = (tgt_ch.shape[1] - 1) / FEATURE_RATE
    span = detect_music_span(tgt_ch) if bounded else None
    res = align_pair(ref_ch, tgt_ch, rd, td, open_ends=True, target_span=span)
    return [round(res['from'], 2), round(td - res['to'], 2)]

base = tonal(400, 11)
out['cleanBounded'] = [trims(base, warp(base, f, s), True)
                       for f, s in ((1.0, 21), (0.9, 22), (1.15, 23), (1.05, 25))]
out['cleanUnbounded'] = [trims(base, warp(base, f, s), False)
                         for f, s in ((1.0, 21), (1.15, 23))]
applause = np.concatenate([flat(270, 133), warp(base, 1.0, 33)], axis=1)
out['applauseBounded'] = trims(base, applause, True)

# --- the span guard trips on a degenerate free-ended path ---
short = tonal(200, 13)
tgt2 = np.concatenate([short[:, :40], flat(900, 14)], axis=1)
g = align_pair(short, tgt2, ref_dur, (tgt2.shape[1] - 1) / FEATURE_RATE, open_ends=True)
out['degenerateGuard'] = g['guard']

# --- a reference SLICE still reports times in the whole reference's seconds ---
# ref frame 20 sits at target frame PRE + 20 = 80, i.e. 8.0 s.
sl = align_pair(ref[:, 20:200], tgt, ref_dur, tgt_dur, open_ends=True,
                ref_frame0=20, ref_frames_total=200)
out['sliceFrom'] = round(sl['from'], 3)
out['sliceGuard'] = sl['guard']
out['sliceGridLen'] = len(sl['times'])
out['fullGridLen'] = len(p['times'])

print(json.dumps(out))
`;

/** Run the harness over align-worker.js's own PYTHON_CODE blob. */
function execPython(): any {
  const workerSrc = fs.readFileSync(
    path.resolve(__dirname, '../../app/static/js/align-worker.js'),
    'utf8',
  );
  const tpl = workerSrc.match(/const PYTHON_CODE = `([\s\S]*?)`;/);
  expect(tpl, 'PYTHON_CODE template literal not found in align-worker.js').toBeTruthy();
  // Evaluate as a template literal so JS escape sequences reach Python exactly
  // as Pyodide sees them (the 39.3 mechanism, as spec 41 uses it).
  // eslint-disable-next-line no-eval
  const python: string = eval('`' + tpl![1] + '`');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lh-openends-'));
  try {
    const blobPath = path.join(dir, 'align-worker-python.py');
    fs.writeFileSync(blobPath, python);
    const stdout = execFileSync('python3', ['-c', HARNESS, blobPath], {
      encoding: 'utf8',
      timeout: 110_000,
    });
    return JSON.parse(stdout.trim());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

let workerOut: any = null;
function worker(): any {
  if (!workerOut) workerOut = execPython();
  return workerOut;
}

test.describe('44. open-ended alignment — the worker', () => {
  test('44.1 chroma peakiness separates tonal music from flat applause', () => {
    const o = worker();
    // The measured corpus values were 2.3-8.4 for music against 1.1-1.8 for
    // applause and quiet gaps; MUSIC_PEAKINESS is 2.0, between the two.
    expect(o.peakTonal).toBeGreaterThan(2.0);
    expect(o.peakFlat).toBeLessThan(2.0);
  });

  test('44.2 detect_music_span errs outward at both ends, never into the music', () => {
    const o = worker();
    // The direction is the point. MUSIC_RUN_FRACTION admits a window that is
    // only a quarter tonal, so the boundary lands OUTSIDE the music — a little
    // applause is kept rather than the end of the piece being cut. Bounded by
    // one window length (MUSIC_MIN_RUN_SEC 3 s = 30 frames at 10 Hz).
    expect(o.spanHeadErr).toBeLessThanOrEqual(0);
    expect(o.spanHeadErr).toBeGreaterThanOrEqual(-30);
    expect(o.spanTailErr).toBeGreaterThanOrEqual(0);
    expect(o.spanTailErr).toBeLessThanOrEqual(30);
  });

  test('44.3 a clean signal, a signal with no music, and an implausible trim all yield the whole file', () => {
    const o = worker();
    expect(o.spanClean).toBe(true);
    expect(o.spanNothingTonal).toBe(true);
    expect(o.spanRefusesBigTrim).toBe(true);
  });

  test('44.4 _dtw_f32 stays corner-to-corner by default and enters past the applause with open_ends', () => {
    const o = worker();
    expect(o.pinnedStart).toEqual([0, 0]);
    expect(o.pinnedEnd).toEqual([199, 259]);
    // 60 flat frames were spliced onto the front of the target; the free start
    // finds exactly that column.
    expect(o.openStart[0]).toBe(0);
    expect(o.openStart[1]).toBe(60);
    expect(o.openEnd).toEqual([199, 259]);
  });

  test('44.5 align_pair reports the aligned span and no longer maps the grid into the applause', () => {
    const o = worker();
    // The pinned run drags reference time 0 to target time 0 — inside the
    // applause. The open-ended run puts it at 6.0 s, where the music starts.
    expect(o.pinFirstTime).toBe(0);
    expect(o.openFirstTime).toBeCloseTo(6.0, 1);
    expect(o.openFrom).toBeCloseTo(6.0, 1);
    expect(o.openTo).toBeCloseTo(o.tgtDur, 1);
    expect(o.openGuard).toBe(true);
    // The output grid is unchanged in shape: one entry per reference step.
    expect(o.gridLensEqual).toBe(true);
  });

  test('44.6 transferred grids are clamped to the target file', () => {
    const o = worker();
    expect(o.noNegative).toBe(true);
    expect(o.noOverrun).toBe(true);
  });

  test('44.7 the span guard rejects a degenerate free-ended path', () => {
    expect(worker().degenerateGuard).toBe(false);
  });

  test('44.17 bounded by the detector, a recording with nothing extra is not trimmed at all', () => {
    const o = worker();
    // Four tempo relationships, 0.9x to 1.15x: nothing may be skipped,
    // because the detector found music from the first frame to the last.
    for (const [head, tail] of o.cleanBounded) {
      expect(head).toBe(0);
      expect(tail).toBe(0);
    }
  });

  test('44.18 unbounded free ends would overshoot — which is why the bound exists', () => {
    const o = worker();
    // The measurement this design rests on: on the SAME clean pairs, free
    // ends with no detector window cut real seconds off. If this ever stops
    // being true the bound could be reconsidered; until then it is load-bearing.
    const worst = Math.max(...o.cleanUnbounded.map(([h, t]: number[]) => Math.max(h, t)));
    expect(worst).toBeGreaterThan(0.5);
  });

  test('44.19 27 s of applause is still found and skipped', () => {
    const [head, tail] = worker().applauseBounded;
    // Never past the applause into the music, and within a window length of
    // it. On the real corpus the same rule gives DVD 1 a 25.6 s bound against
    // 27 s of applause, so a couple of seconds ride along — the cheap error.
    expect(head).toBeGreaterThan(23);
    expect(head).toBeLessThanOrEqual(27);
    expect(tail).toBeLessThan(0.5);
  });

  test('44.8 a reference slice keeps times in the original reference seconds', () => {
    const o = worker();
    expect(o.sliceGuard).toBe(true);
    expect(o.sliceFrom).toBeCloseTo(8.0, 1);
    // The grid still spans the whole reference, not just its usable span.
    expect(o.sliceGridLen).toBe(o.fullGridLen);
  });
});

/* ------------------------------------------------------------------ */
/* The wizard                                                          */
/* ------------------------------------------------------------------ */

test.describe('44. open-ended alignment — the wizard', () => {
  test('44.9 the global toggle is on by default and every row follows it', async ({ page }) => {
    await page.goto('/?mode=align');
    await page.waitForLoadState('networkidle');

    const global = page.locator('#align-open-ends-checkbox');
    await expect(global).toBeChecked();

    await page.locator('#align-file-input').setInputFiles([
      path.join(FIXTURES, 'audio-a.mp3'),
      path.join(FIXTURES, 'audio-b.mp3'),
    ]);
    await expect(page.locator('#align-file-table tbody tr').first()).toBeVisible({
      timeout: 20_000,
    });

    const rows = page.locator('.align-trim-checkbox');
    await expect(rows).toHaveCount(2);
    for (const cb of await rows.all()) await expect(cb).toBeChecked();

    // Turning the global off takes the untouched rows with it.
    await global.uncheck();
    for (const cb of await rows.all()) await expect(cb).not.toBeChecked();
  });

  test('44.10 a row that has been clicked stops following the global setting', async ({ page }) => {
    await page.goto('/?mode=align');
    await page.waitForLoadState('networkidle');
    await page.locator('#align-file-input').setInputFiles([
      path.join(FIXTURES, 'audio-a.mp3'),
      path.join(FIXTURES, 'audio-b.mp3'),
    ]);
    await expect(page.locator('#align-file-table tbody tr').first()).toBeVisible({
      timeout: 20_000,
    });

    const first = page.locator('.align-trim-checkbox').first();
    const second = page.locator('.align-trim-checkbox').nth(1);
    await first.uncheck();
    await expect(first).toHaveClass(/align-trim-explicit/);

    // The global goes off and back on: the clicked row keeps its own value,
    // the untouched one follows.
    await page.locator('#align-open-ends-checkbox').uncheck();
    await page.locator('#align-open-ends-checkbox').check();
    await expect(first).not.toBeChecked();
    await expect(second).toBeChecked();
  });

  test('44.11 the post-run report names what was trimmed, in seconds', async ({ page }) => {
    await page.goto('/?mode=align');
    await page.waitForLoadState('networkidle');

    const report = await page.evaluate(async () => {
      const mod: any = await import('/static/js/align.js');
      mod.renderOpenEndsReport({
        header: {
          ref: 'ref.wav',
          openEnds: {
            enabled: true,
            trimmed: ['ref.wav', 'dvd1.wav', 'both.wav'],
            guardFailed: ['odd.wav'],
          },
        },
        body: {
          audio: {
            'ref.wav': { duration: 500, alignedFrom: 12, alignedTo: 500 },
            'dvd1.wav': { duration: 514.9, alignedFrom: 33.2, alignedTo: 514.9 },
            'both.wav': { duration: 200, alignedFrom: 4, alignedTo: 95 },
          },
        },
      });
      return {
        summary: document.querySelector('#align-open-ends-details summary')
          ?.textContent,
        open: document
          .querySelector('#align-open-ends-details')
          ?.hasAttribute('open'),
        lines: [...document.querySelectorAll('#align-open-ends-list li')].map(
          (li) => li.textContent,
        ),
      };
    });

    // Folded shut, with the count on the summary: twenty recordings must not
    // push the Save and Listen buttons out of view.
    expect(report.open).toBe(false);
    expect(report.summary).toBe('4 recordings had audio with no counterpart');
    const lines = report.lines;
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain('ref.wav (reference)');
    expect(lines[0]).toContain('12 s at the start');
    expect(lines[1]).toBe(
      'dvd1.wav: 33 s at the start had no counterpart in the reference.',
    );
    // Both ends, and over 90 s reads as minutes.
    expect(lines[2]).toContain('4 s at the start and 1 min 45 s at the end');
    expect(lines[3]).toContain('odd.wav');
    expect(lines[3]).toContain('the whole recording was aligned instead');
  });

  test('44.12 with nothing trimmed the report says so rather than staying silent', async ({ page }) => {
    await page.goto('/?mode=align');
    await page.waitForLoadState('networkidle');

    const empty = await page.evaluate(async () => {
      const mod: any = await import('/static/js/align.js');
      mod.renderOpenEndsReport({
        header: { ref: 'a.wav', openEnds: { enabled: true, trimmed: [], guardFailed: [] } },
        body: { audio: { 'a.wav': { duration: 10 } } },
      });
      return {
        none: document.getElementById('align-open-ends-none')?.textContent,
        details: !!document.getElementById('align-open-ends-details'),
      };
    });
    // Nothing to fold away, so no disclosure — just the one reassuring line.
    expect(empty.details).toBe(false);
    expect(empty.none).toBe(
      'No recording had audio without a counterpart in the reference.',
    );
  });

  test('44.13 an alignment that never ran open-ended reports nothing at all', async ({ page }) => {
    await page.goto('/?mode=align');
    await page.waitForLoadState('networkidle');
    const html = await page.evaluate(async () => {
      const mod: any = await import('/static/js/align.js');
      mod.renderOpenEndsReport({ header: { ref: 'a.wav' }, body: { audio: {} } });
      return document.getElementById('align-open-ends-report')!.innerHTML;
    });
    expect(html).toBe('');
  });
});

/* ------------------------------------------------------------------ */
/* The listen view                                                     */
/* ------------------------------------------------------------------ */

test.describe('44. open-ended alignment — the listen view', () => {
  test('44.14 alignedFrom/alignedTo load into the session, and older alignments carry none', async ({ page }) => {
    await loadLocalAlignment(page, 'alignment-openends.json');
    await waitForWaveformsReady(page);

    const spans = await page.evaluate(() => (window as any)._listenTest.alignedSpans);
    expect(Object.keys(spans).sort()).toEqual(['audio-2.mp3', 'audio-3.mp3']);
    expect(spans['audio-2.mp3'].from).toBeCloseTo(1.2, 3);
    expect(spans['audio-3.mp3'].from).toBeCloseTo(0.8, 3);
    expect(spans['audio-3.mp3'].to).toBeCloseTo(4.6, 3);
    // The reference and the guard-failed recording make no claim.
    expect(spans['audio-1.mp3']).toBeUndefined();
    expect(spans['audio-4.mp3']).toBeUndefined();
  });

  test('44.15 the no-counterpart head and tail are hatched over the waveform', async ({ page }) => {
    await loadLocalAlignment(page, 'alignment-openends.json');
    await waitForWaveformsReady(page);
    await showWaveform(page, 'audio-1.mp3');
    await showWaveform(page, 'audio-2.mp3');
    await showWaveform(page, 'audio-3.mp3');
    await waitForWaveformsReady(page);

    // Counted at default zoom, where every band is inside the viewport.
    await expect
      .poll(
        () =>
          page.evaluate(() =>
            (window as any)._listenTest.noCounterpartBands('audio-3.mp3'),
          ),
        { timeout: 15_000 },
      )
      .toBe(2);
    expect(
      await page.evaluate(() =>
        (window as any)._listenTest.noCounterpartBands('audio-2.mp3'),
      ),
    ).toBe(1);
    expect(
      await page.evaluate(() =>
        (window as any)._listenTest.noCounterpartBands('audio-1.mp3'),
      ),
    ).toBe(0);
  });

  test('44.16 an alignment without spans paints no bands', async ({ page }) => {
    await loadLocalAlignment(page, 'alignment-no-peaks.json');
    await waitForWaveformsReady(page);
    await showWaveform(page, 'audio-1.mp3');
    await waitForWaveformsReady(page);
    const spans = await page.evaluate(() => (window as any)._listenTest.alignedSpans);
    expect(spans).toEqual({});
    expect(
      await page.evaluate(() =>
        (window as any)._listenTest.noCounterpartBands('audio-1.mp3'),
      ),
    ).toBe(0);
  });
});
