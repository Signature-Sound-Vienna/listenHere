// 52. Add recordings to a loaded alignment (0.97.0).
//
// Manage recordings has an Add Recordings tab: the files picked there are
// aligned to the alignment's reference, with the original run's settings by
// default, and join the running session without a reload. Every recording is
// aligned to the reference alone, so nothing already aligned changes.
//
// What the file records: header.alignmentParams stays the ORIGINAL run's
// (absent stays absent, meaning unknown); each addition appends a record to
// header.additions with its own settings and per-file open ends. The wizard
// now always writes its settings (the opt-out is gone) and resolves the
// per-file open-ends overrides into header.openEnds.byFile.
//
// Worker tests run align-worker.js's own PYTHON_CODE under system python3 +
// numpy against synthetic chroma, as spec 44 does.
import { test, expect } from '../support/fixtures';
import type { Page } from '@playwright/test';
import { loadLocalAlignment, loadViaFilePicker, readFixtureJson, FIXTURES_DIR } from '../support/helpers';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const fixture = readFixtureJson('alignment.json');
const REF = fixture.header.ref as string; // audio-b.mp3
const NEW = 'audio-1.mp3';

/* ------------------------------------------------------------------ */
/* The worker's Python, driven directly                                */
/* ------------------------------------------------------------------ */

// Synthetic chroma as in spec 44: tonal frames peak on two pitch classes,
// "applause" frames are flat. The reference opens and closes with applause,
// so its span is trimmed and the pinned-span path is exercised.
const HARNESS = `
import json, sys, types
import numpy as np

_js = types.ModuleType('js')
_js.reportProgress = lambda *a, **k: None
_js.reportStep = lambda *a, **k: None
sys.modules['js'] = _js

with open(sys.argv[1]) as f:
    exec(compile(f.read(), 'align-worker-python', 'exec'))

def tonal(n, seed, stretch=1.0):
    r = np.random.default_rng(seed)
    pcs = r.integers(0, 12, size=n // 20 + 1)
    m = int(n * stretch)
    ch = np.full((12, m), 0.05, dtype=np.float32)
    for k in range(m):
        pc = int(pcs[min(len(pcs) - 1, int(k / stretch) // 20)])
        ch[pc, k] = 1.0
        ch[(pc + 7) % 12, k] = 0.5
    ch += np.random.default_rng(seed + 1).random((12, m)).astype(np.float32) * 0.01
    return ch / np.linalg.norm(ch, axis=0, keepdims=True)

def flat(n, seed):
    r = np.random.default_rng(seed)
    ch = 1.0 + r.random((12, n)).astype(np.float32) * 0.05
    return ch / np.linalg.norm(ch, axis=0, keepdims=True)

feats = {
    'ref.wav': np.concatenate([flat(60, 1), tonal(400, 7), flat(80, 2)], axis=1),
    'b.wav': tonal(400, 7, 1.1),
    'c.wav': np.concatenate([flat(50, 3), tonal(400, 7, 0.9)], axis=1),
}

def batch(names, open_by_file):
    begin_batch('ref.wav', 0, False, len(names), False, open_by_file)
    for n in names:
        _chromas[n] = feats[n].copy()
        _durations[n] = (feats[n].shape[1] - 1) / FEATURE_RATE

out = {}
obf = {'ref.wav': True, 'b.wav': False, 'c.wav': True}
batch(['ref.wav', 'b.wav', 'c.wav'], obf)
full = align_all_from_features()
out['header'] = full['header']
ref = full['body']['audio']['ref.wav']
span = (ref['alignedFrom'], ref['alignedTo'])
out['refSpan'] = span

batch(['ref.wav', 'c.wav'], {'c.wav': True})
added = align_added_from_features(span)
out['cSame'] = added['audio']['c.wav'] == full['body']['audio']['c.wav']
out['addedKeys'] = sorted(added['audio'].keys())
out['cAligned'] = 'alignedFrom' in added['audio']['c.wav']

batch(['ref.wav', 'b.wav'], {'b.wav': False})
out['bSame'] = align_added_from_features(span)['audio']['b.wav'] == full['body']['audio']['b.wav']

batch(['ref.wav', 'c.wav'], {'c.wav': True})
loose = align_added_from_features(None)['audio']['c.wav']
out['unpinnedMaxDiff'] = float(np.max(np.abs(
    np.array(loose['times']) - np.array(full['body']['audio']['c.wav']['times']))))
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lh-addrec-'));
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

test.describe('52. add recordings — the worker', () => {
  test('52.1 an added recording gets the grid it would have got in the original run', () => {
    const w = worker();
    expect(w.refSpan[0]).toBeGreaterThan(0); // the reference really was trimmed
    expect(w.addedKeys).toEqual(['c.wav']); // the reference is not returned
    expect(w.cSame).toBe(true); // open-ended, over the pinned span
    expect(w.cAligned).toBe(true);
    expect(w.bSame).toBe(true); // pinned
  });

  test('52.2 the reference span is pinned, not re-detected: without it the grid moves', () => {
    expect(worker().unpinnedMaxDiff).toBeGreaterThan(0.1);
  });

  test('52.3 the wizard stamps each recording\'s resolved open-ends setting in header.openEnds.byFile', () => {
    expect(worker().header.openEnds.byFile).toEqual({
      'ref.wav': true,
      'b.wav': false,
      'c.wav': true,
    });
  });
});

/* ------------------------------------------------------------------ */
/* The model: engine/additions.js                                      */
/* ------------------------------------------------------------------ */

test.describe('52. add recordings — the record', () => {
  test('52.4 an addition never touches header.alignmentParams, present or absent', async ({ page }) => {
    await page.goto('/');
    const r = await page.evaluate(async () => {
      const m = await import('/static/js/engine/additions.js');
      const added = { audio: { 'n.wav': [0, 1] }, trimmed: [], guardFailed: [] };
      const run = { params: { coarse: 4, slack: 80, featureRate: 10, scoreDownsample: 2 },
        openEndsByFile: { 'n.wav': true }, createdBy: 'test' };
      const known = { header: { ref: 'r.wav', alignmentParams: { coarse: 2, slack: 160, featureRate: 20, scoreDownsample: 1 } },
        body: { audio: { 'r.wav': [0, 1] } } };
      const unknown = { header: { ref: 'r.wav' }, body: { audio: { 'r.wav': [0, 1] } } };
      m.applyAddition(known, added, run);
      m.applyAddition(unknown, added, run);
      return {
        knownParams: known.header.alignmentParams,
        unknownHasParams: 'alignmentParams' in unknown.header,
        record: unknown.header.additions[0],
        paramsForNew: m.paramsFor(known.header, 'n.wav'),
        paramsForOld: m.paramsFor(known.header, 'r.wav'),
        paramsForUnknownOld: m.paramsFor(unknown.header, 'r.wav'),
        defaults: m.defaultAddParams(unknown.header, { coarse: 2, slack: 120, featureRate: 10, scoreDownsample: 1 }),
      };
    });
    expect(r.knownParams).toEqual({ coarse: 2, slack: 160, featureRate: 20, scoreDownsample: 1 });
    expect(r.unknownHasParams).toBe(false);
    expect(r.record).toMatchObject({
      createdBy: 'test',
      recordings: ['n.wav'],
      alignmentParams: { coarse: 4, slack: 80, featureRate: 10, scoreDownsample: 2 },
      openEnds: { byFile: { 'n.wav': true }, trimmed: [], guardFailed: [] },
    });
    expect(r.paramsForNew).toEqual({ coarse: 4, slack: 80, featureRate: 10, scoreDownsample: 2 });
    expect(r.paramsForOld).toEqual({ coarse: 2, slack: 160, featureRate: 20, scoreDownsample: 1 });
    expect(r.paramsForUnknownOld).toBeNull();
    expect(r.defaults.known).toBe(false);
  });

  test('52.11 a recording already aligned is refused under a folder, another case, or as the reference', async ({ page }) => {
    await page.goto('/');
    const r = await page.evaluate(async () => {
      const m = await import('/static/js/engine/additions.js');
      const json = { header: { ref: 'Kaiserwalzer/VPO-1991.wav' },
        body: { audio: { 'Kaiserwalzer/VPO-1991.wav': [0], 'Kaiserwalzer/VPO-1996.wav': [0] } } };
      return {
        folder: m.addRefusal('VPO-1996.wav', json, 'score'),
        caseDiff: m.addRefusal('vpo-1996.WAV', json, 'score'),
        ref: m.addRefusal('VPO-1991.wav', json, 'score'),
        fresh: m.addRefusal('VPO-2001.wav', json, 'score'),
      };
    });
    expect(r).toEqual({
      folder: 'already in this alignment',
      caseDiff: 'already in this alignment',
      ref: 'the reference recording',
      fresh: '',
    });
  });
});

/* ------------------------------------------------------------------ */
/* The listen view                                                     */
/* ------------------------------------------------------------------ */

async function waitForLoad(page: Page, after = 0) {
  await page.waitForFunction(
    (n) => ((window as any)._listenTest?.loadGeneration ?? 0) > n,
    after,
    { timeout: 40_000 },
  );
}

async function openAddTab(page: Page) {
  await page.click('#manage-files-btn');
  await page.click('.fp-tab[data-tab="fp-tab-add"]');
  await expect(page.locator('#fp-tab-add')).toHaveClass(/active/);
}

async function pickToAdd(page: Page, files: string[]) {
  await page.locator('#add-rec-input').setInputFiles(
    files.map((f) => path.join(FIXTURES_DIR, f)),
  );
}

async function alignAndAdd(page: Page) {
  await page.click('#add-rec-start');
  // Real Pyodide: the first boot fetches the runtime.
  await expect(page.locator('#add-rec-result')).toContainText('Added', { timeout: 90_000 });
}

const alignmentJSON = (page: Page) =>
  page.evaluate(() => (window as any)._listenTest.alignmentJSON);

test.describe('52. add recordings — the listen view', () => {
  test('52.5 Manage recordings works for an alignment loaded from a URL: tabs switch, Close closes', async ({ page }) => {
    await loadLocalAlignment(page);
    await waitForLoad(page);
    await page.click('#manage-files-btn');
    await page.click('.fp-tab[data-tab="fp-tab-uris"]');
    await expect(page.locator('#fp-tab-uris')).toHaveClass(/active/);
    await expect(page.locator('#file-picker-continue')).toHaveText('Close');
    await page.click('#file-picker-continue');
    await expect(page.locator('#file-picker-overlay')).toBeHidden();
    await page.click('#manage-files-btn');
    await page.keyboard.press('Escape');
    await expect(page.locator('#file-picker-overlay')).toBeHidden();
  });

  test('52.6 an added recording joins the session with the original settings, recorded apart', async ({ page }) => {
    await loadLocalAlignment(page);
    await waitForLoad(page);
    const gen = await page.evaluate(() => (window as any)._listenTest.loadGeneration);
    await openAddTab(page);
    await expect(page.locator('#add-rec-ref')).toHaveText(REF);
    // The original run's settings are the default (the fixture's are HQ).
    await expect(page.locator('input[name="add-rec-quality"][value="hq"]')).toBeChecked();
    // The reference and a name already aligned are both listed, refused.
    await pickToAdd(page, [NEW, REF, 'audio-c.mp3']);
    await expect(page.locator('#add-rec-tbody tr')).toHaveCount(3);
    const refused = page.locator('#add-rec-tbody tr.add-rec-refused');
    await expect(refused).toHaveCount(2);
    await expect(refused.filter({ hasText: REF })).toContainText('the reference recording');
    await expect(refused.filter({ hasText: 'audio-c.mp3' })).toContainText('already in this alignment');
    await expect(page.locator('#add-rec-start')).toHaveText('Align and Add');
    await alignAndAdd(page);

    const json = await alignmentJSON(page);
    const entry = json.body.audio[NEW];
    const ref = json.body.audio[REF];
    expect(entry.times.length).toBe(ref.times.length);
    expect(entry.peaks.length).toBe(ref.peaks.length);
    expect(json.header.alignmentParams).toEqual(fixture.header.alignmentParams);
    expect(json.header.additions).toHaveLength(1);
    expect(json.header.additions[0]).toMatchObject({
      recordings: [NEW],
      alignmentParams: { coarse: 2, slack: 160, featureRate: 20, scoreDownsample: 1 },
      openEnds: { byFile: { [NEW]: false } },
    });
    // Only settings a run reads: the fixture's inert onsetWeight is not copied.
    expect(json.header.additions[0].alignmentParams).not.toHaveProperty('onsetWeight');
    // No reload: the same load, the new row rendered, the sidebar entry ticked.
    expect(await page.evaluate(() => (window as any)._listenTest.loadGeneration)).toBe(gen);
    await page.waitForFunction(
      (n) => (window as any)._listenTest.renderedWaveforms.includes(n),
      NEW,
      { timeout: 30_000 },
    );
    await expect(page.locator(`[id="checkbox-${NEW}"]`)).toBeChecked();
    expect(await page.evaluate(() => (window as any)._listenTest.hasUnsavedWork)).toBe(true);
    // Save data, offered right in the tab after the addition, writes it.
    await expect(page.locator('#add-rec-save')).toBeVisible();
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#add-rec-save')]);
    const saved = JSON.parse(fs.readFileSync(await dl.path(), 'utf8'));
    expect(Object.keys(saved.body.audio)).toContain(NEW);
    expect(saved.header.additions[0].recordings).toEqual([NEW]);
    expect(await page.evaluate(() => (window as any)._listenTest.hasUnsavedWork)).toBe(false);
  });

  test('52.7 changed settings are recorded for the addition only', async ({ page }) => {
    await loadLocalAlignment(page);
    await waitForLoad(page);
    await openAddTab(page);
    await pickToAdd(page, [NEW]);
    await page.click('#add-rec-params summary');
    await expect(page.locator('#add-rec-save')).toBeHidden();
    // The original's settings are known: the note says so, nothing to restore.
    const note = page.locator('#add-rec-params-note');
    const restore = page.locator('#add-rec-params-restore');
    await expect(note).toContainText('made with');
    await expect(restore).toBeHidden();
    // Changed: the restore button takes the note's place, and puts them back.
    await page.check('input[name="add-rec-quality"][value="fast"]');
    await expect(restore).toBeVisible();
    await expect(note).toBeHidden();
    await restore.click();
    await expect(page.locator('input[name="add-rec-quality"][value="hq"]')).toBeChecked();
    await expect(restore).toBeHidden();
    await expect(note).toContainText('made with');
    await page.check('input[name="add-rec-quality"][value="fast"]');
    await page.locator('#add-rec-tbody .add-rec-trim').check();
    await alignAndAdd(page);
    const json = await alignmentJSON(page);
    expect(json.header.alignmentParams).toEqual(fixture.header.alignmentParams);
    expect(json.header.additions[0].alignmentParams).toMatchObject({ coarse: 4, slack: 80, featureRate: 10 });
    expect(json.header.additions[0].openEnds.byFile).toEqual({ [NEW]: true });
    // Locked to the settings just used, across closing and reopening the tab;
    // a refused pick keeps them locked, a new recording to align frees them.
    const fast = page.locator('input[name="add-rec-quality"][value="fast"]');
    await expect(fast).toBeDisabled();
    await expect(fast).toBeChecked();
    await expect(note).toContainText('just added');
    await expect(restore).toBeHidden();
    await page.click('#file-picker-continue');
    await openAddTab(page);
    await expect(fast).toBeDisabled();
    await expect(fast).toBeChecked();
    await pickToAdd(page, [NEW]);
    await expect(page.locator('#add-rec-tbody tr.add-rec-refused')).toContainText('already in this alignment');
    await expect(fast).toBeDisabled();
    await pickToAdd(page, ['audio-2.mp3']);
    await expect(fast).toBeEnabled();
    await expect(page.locator('#add-rec-slack')).toBeEnabled();
  });

  test('52.8 in local-files mode without the reference, it is asked for, then used', async ({ page }) => {
    await loadViaFilePicker(page, ['alignment.json', 'audio-a.mp3', 'audio-c.mp3']);
    await page.click('#file-picker-continue');
    await waitForLoad(page);
    await openAddTab(page);
    await pickToAdd(page, [NEW]);
    await expect(page.locator('#add-rec-ref-needed')).toBeVisible();
    await expect(page.locator('#add-rec-start')).toBeDisabled();
    await pickToAdd(page, [REF]);
    await expect(page.locator('#add-rec-ref-needed')).toBeHidden();
    await alignAndAdd(page);
    // The picked reference now plays too, and the Load Files list counts both.
    await page.click('.fp-tab[data-tab="fp-tab-files"]');
    await expect(page.locator(`#file-picker-list li.matched`)).toHaveCount(4);
    expect(await page.evaluate(() => (window as any)._listenTest.expectedAudioKeys)).toContain(NEW);
  });

  test('52.9 an addition lost with its session is named when the session is restored', async ({ page }) => {
    await loadLocalAlignment(page);
    await waitForLoad(page);
    await openAddTab(page);
    await pickToAdd(page, [NEW]);
    await alignAndAdd(page);
    // The snapshot is written a moment after the change.
    await page.waitForFunction(
      (n) => Object.keys(localStorage).some((k) =>
        k.startsWith('lh-recovery:') && (localStorage.getItem(k) || '').includes(n)),
      NEW,
      { timeout: 10_000 },
    );
    await loadLocalAlignment(page); // the tab is lost; the original file reloads
    await waitForLoad(page);
    await expect(page.locator('#recovery-banner')).toContainText('1 added recording');
    await page.click('#recovery-banner .recovery-restore');
    await expect(page.locator('#recovery-lost-additions')).toContainText(NEW);
    const json = await alignmentJSON(page);
    expect(json.header.additions).toBeUndefined();
    expect(Object.keys(json.body.audio)).not.toContain(NEW);
  });
});

/* ------------------------------------------------------------------ */
/* The wizard                                                          */
/* ------------------------------------------------------------------ */

test.describe('52. add recordings — the wizard', () => {
  test('52.10 the settings are always written, and per-file open ends with them', async ({ page }) => {
    await page.goto('/?mode=align');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('#align-include-params')).toHaveCount(0);
    const short = fs.readFileSync(path.join(FIXTURES_DIR, 'audio-short.mp3'));
    await page.locator('#align-file-input').setInputFiles([
      { name: 'short-a.mp3', mimeType: 'audio/mpeg', buffer: short },
      { name: 'short-b.mp3', mimeType: 'audio/mpeg', buffer: short },
    ]);
    await expect(page.locator('#align-file-table tbody tr')).toHaveCount(2, { timeout: 20_000 });
    // One row set apart from the global switch (on by default).
    await page.locator('#align-file-table tbody tr').nth(1).locator('input[type="checkbox"]').uncheck();
    for (const _ of [1, 2, 3]) {
      const before = await page.locator('.align-step.active').getAttribute('data-step');
      await page.click('#align-next-btn');
      await expect(page.locator('.align-step.active')).not.toHaveAttribute('data-step', before!);
    }
    await page.click('#align-start-btn');
    await expect(page.locator('#align-results')).toBeVisible({ timeout: 90_000 });
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#align-download-btn')]);
    const saved = JSON.parse(fs.readFileSync(await dl.path(), 'utf8'));
    expect(saved.header.alignmentParams).toMatchObject({ coarse: 2, slack: 120, featureRate: 10 });
    expect(saved.header.openEnds.enabled).toBe(true);
    expect(saved.header.openEnds.byFile).toEqual({ 'short-a.mp3': true, 'short-b.mp3': false });
  });
});
