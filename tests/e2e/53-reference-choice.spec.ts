// 53. The automatic reference — the wizard chooses the recording the others
// agree with best, unless a row of the Ref column is picked.
//
// The wizard used to default to the longest file, which on the Radetzky and
// Pizzicato corpora was the WORST reference of 57 and 19 (a long applause or a
// passage the others lack makes a file long). choose_reference ranks every
// candidate by cycle consistency over pairwise 1 Hz DTWs, measured in
// working-docs tools/reference-choice-2026-10-28.
//
// Worker tests run align-worker.js's own PYTHON_CODE under python3 + numpy on
// synthetic chroma, as spec 44 does. The wizard tests run real alignments of
// the 5 s fixture under three names.
import { test, expect } from '../support/fixtures';
import type { Page } from '@playwright/test';
import { FIXTURES_DIR } from '../support/helpers';
import { env } from '../support/env';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/* ------------------------------------------------------------------ */
/* The worker's Python, driven directly                                */
/* ------------------------------------------------------------------ */

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

def warp(ch, factor, seed):
    n = ch.shape[1]
    m = int(round(n * factor))
    r = np.random.default_rng(seed)
    t = np.clip(np.maximum.accumulate(np.linspace(0, n - 1, m) + r.normal(0, 0.8, m)), 0, n - 1)
    o = ch[:, np.round(t).astype(int)] + r.random((12, m)).astype(np.float32) * 0.18
    return (o / np.linalg.norm(o, axis=0, keepdims=True)).astype(np.float32)

def batch(files):
    begin_batch('', 0, False, len(files), True, {})
    for k, ch in files.items():
        _chromas[k] = ch
        _durations[k] = (ch.shape[1] - 1) / FEATURE_RATE

out = {}

# Four takes of one 60 s piece at different tempi, and a fifth, the longest:
# the same piece with 40 s in its middle that the others lack.
base = tonal(600, 11)
files = {'take-%d' % i: warp(base, f, 20 + i) for i, f in enumerate((0.95, 1.0, 1.05, 1.1))}
files['long'] = np.concatenate(
    [files['take-1'][:, :300], tonal(400, 5), files['take-1'][:, 300:]], axis=1)
batch(files)
c = choose_reference(1.0)
out['choice'] = c
out['batchRef'] = _batch_ref_name
out['longest'] = max(files, key=lambda k: files[k].shape[1])

# Two recordings have no triple to compare: the longest is kept.
batch({k: files[k] for k in ('take-0', 'long')})
out['two'] = choose_reference(1.0)

# The header records the choice; a manual reference records only that.
batch({k: files[k] for k in ('take-0', 'take-1', 'take-2')})
choose_reference(1.0)
out['autoHeader'] = align_all_from_features()['header']
begin_batch('take-1', 0, False, 2, True, {})
for k in ('take-0', 'take-1'):
    _chromas[k] = files[k]; _durations[k] = (files[k].shape[1] - 1) / FEATURE_RATE
out['manualHeader'] = align_all_from_features()['header']

# The row-vectorised coarse DTW returns _dtw_f32's own paths.
same = []
for trial in range(6):
    a = tonal(60 + 7 * trial, 40 + trial)
    b = warp(a, 1.2, 9)
    C = np.clip(1.0 - a.T @ b, 0, 2).astype(np.float32)
    for kw in ({}, {'open_ends': True},
               {'open_ends': True, 'entry_max': 3, 'exit_min': C.shape[1] - 4}):
        same.append(_dtw_f32(C, **kw).tolist() == _dtw_f32_rows(C, **kw).tolist())
out['dtwSame'] = [sum(same), len(same)]

print(json.dumps(out))
`;

function execPython(): any {
  const workerSrc = fs.readFileSync(
    path.resolve(__dirname, '../../app/static/js/align-worker.js'),
    'utf8',
  );
  const tpl = workerSrc.match(/const PYTHON_CODE = `([\s\S]*?)`;/);
  expect(tpl, 'PYTHON_CODE template literal not found in align-worker.js').toBeTruthy();
  // eslint-disable-next-line no-eval
  const python: string = eval('`' + tpl![1] + '`');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lh-refchoice-'));
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

test.describe('53. automatic reference — the worker', () => {
  test('53.1 a longest file holding a passage the others lack is not chosen', () => {
    const o = worker();
    const c = o.choice;
    expect(o.longest).toBe('long'); // the old default
    expect(c.mode).toBe('automatic');
    expect(c.method).toBe('cycle');
    expect(c.rateHz).toBe(1);
    // As the reference, 'long' would fail the span guard of its targets.
    expect(c.excluded).toContain('long');
    expect(c.ref).not.toBe('long');
    expect(c.excluded).not.toContain(c.ref);
    // The pick is the best-scoring candidate that was not excluded.
    const kept = Object.keys(c.scores).filter((k) => !c.excluded.includes(k));
    for (const k of kept) expect(c.scores[c.ref]).toBeLessThanOrEqual(c.scores[k]);
    // And it became the batch's reference.
    expect(o.batchRef).toBe(c.ref);
  });

  test('53.2 two recordings keep the longest', () => {
    expect(worker().two).toEqual({ mode: 'automatic', method: 'longest', ref: 'long' });
  });

  test('53.3 the header records how the reference was chosen', () => {
    const o = worker();
    const auto = o.autoHeader.referenceChoice;
    expect(o.autoHeader.ref).toBeTruthy();
    expect(auto.mode).toBe('automatic');
    expect(auto.method).toBe('cycle');
    expect(Object.keys(auto.scores).sort()).toEqual(['take-0', 'take-1', 'take-2']);
    expect(auto.ref).toBeUndefined(); // header.ref says it once
    expect(o.manualHeader.ref).toBe('take-1');
    expect(o.manualHeader.referenceChoice).toEqual({ mode: 'manual' });
  });

  test('53.4 the row-vectorised coarse DTW returns the original paths', () => {
    const [same, total] = worker().dtwSame;
    expect(same).toBe(total);
  });
});

/* ------------------------------------------------------------------ */
/* The wizard                                                          */
/* ------------------------------------------------------------------ */

const short = () => fs.readFileSync(path.join(FIXTURES_DIR, 'audio-short.mp3'));
const takes = (names: string[]) =>
  names.map((name) => ({ name, mimeType: 'audio/mpeg', buffer: short() }));

async function pick(page: Page, names: string[]) {
  await page.goto('/?mode=align');
  await page.waitForLoadState('networkidle');
  await page.locator('#align-file-input').setInputFiles(takes(names));
  await expect(page.locator('#align-file-table tbody tr')).toHaveCount(names.length, {
    timeout: 20_000,
  });
}

async function run(page: Page, mei: boolean) {
  for (const step of [2, 3]) {
    await page.click('#align-next-btn');
    await expect(page.locator('.align-step.active')).toHaveAttribute('data-step', String(step));
  }
  if (mei) {
    await page.locator('#align-mei-input').fill(
      `${env.baseUrl}/static/test/Schumann-Clara_Romanze-ohne-Opuszahl_a-Moll.mei`,
    );
  }
  await page.click('#align-next-btn');
  await page.click('#align-start-btn');
  await expect(page.locator('#align-results')).toBeVisible({ timeout: 90_000 });
  const [dl] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#align-download-btn'),
  ]);
  return JSON.parse(fs.readFileSync(await dl.path(), 'utf8'));
}

test.describe('53. automatic reference — the wizard', () => {
  test('53.5 automatic is the default; a picked row overrides it until automatic is picked again', async ({ page }) => {
    await pick(page, ['take-a.mp3', 'take-b.mp3']);
    const auto = page.locator('#align-ref-auto');
    const rows = page.locator('#align-file-table input[name="ref"]');
    await expect(auto).toBeChecked();
    await expect(page.locator('#align-file-table input[name="ref"]:checked')).toHaveCount(0);

    await rows.nth(1).check({ force: true });
    await expect(auto).not.toBeChecked();
    // The pick survives more files being added (the table is rebuilt).
    await page.locator('#align-file-input').setInputFiles(takes(['take-c.mp3']));
    await expect(page.locator('#align-file-table tbody tr')).toHaveCount(3, { timeout: 20_000 });
    await expect(rows.nth(1)).toBeChecked();
    await expect(auto).not.toBeChecked();

    await auto.check({ force: true });
    await expect(page.locator('#align-file-table input[name="ref"]:checked')).toHaveCount(0);
    for (const _ of [1, 2, 3]) await page.click('#align-next-btn');
    await expect(page.locator('#align-summary')).toContainText('reference: chosen automatically');
  });

  test('53.6 an automatic run with a score chooses, records, and reports the reference', async ({ page }) => {
    const names = ['take-a.mp3', 'take-b.mp3', 'take-c.mp3'];
    await pick(page, names);
    const saved = await run(page, true);
    expect(names).toContain(saved.header.ref);
    expect(saved.header.referenceChoice).toMatchObject({ mode: 'automatic', method: 'cycle', rateHz: 1 });
    // The score was aligned to the chosen reference, whose audio arrives again.
    expect(saved.body.score).toBeTruthy();
    await expect(page.locator('#align-ref-choice-report')).toBeVisible();
    await expect(page.locator('#align-ref-choice-report')).toContainText(saved.header.ref);
    await expect(page.locator('#align-step-list')).toContainText('Choose reference');
  });

  test('53.7 a picked reference is used and recorded as manual', async ({ page }) => {
    await pick(page, ['take-a.mp3', 'take-b.mp3', 'take-c.mp3']);
    await page.locator('#align-file-table input[name="ref"]').nth(2).check({ force: true });
    const saved = await run(page, false);
    expect(saved.header.ref).toBe('take-c.mp3');
    expect(saved.header.referenceChoice).toEqual({ mode: 'manual' });
    await expect(page.locator('#align-ref-choice-report')).toBeHidden();
    await expect(page.locator('#align-step-list')).not.toContainText('Choose reference');
  });
});
