// 51. engine/legacy-alignment.js — score tables from the legacy SyncToolbox CLI
//
// align-to-score.py (signature-sound-vienna/alignment) writes score positions
// in SECONDS and deduplicates onsets and offsets apart, so its onset and
// offset arrays differ in length. Fix mode's guard refused every such file.
// On load the app now detects that table positively (no quarters match, note
// starts match as seconds) and rebuilds this app's quarters table from the
// fresh render, taking reference times from the legacy pairs.
//
// The legacy table here is derived from the hermetic fixture the way the CLI
// would write it: the fixture MIDI runs at one tempo (0.75 s per quarter,
// checked against its synth_onset), so seconds = quarters × 0.75.
import { test, expect } from '../support/fixtures';
import { stubExternalMei } from '../support/helpers';
import { env } from '../support/env';
import * as fs from 'fs';
import * as path from 'path';
import type { Page } from '@playwright/test';

const fixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'alignment.json'), 'utf8'),
);
const original = fixture.body.score;
const SEC_PER_QUARTER = 0.75;

/** (x, y) pairs deduplicated as pairs, first occurrence kept (pandas drop_duplicates). */
function dropDuplicatePairs(xs: number[], ys: number[]) {
  const seen = new Set<string>();
  const out = { x: [] as number[], y: [] as number[] };
  xs.forEach((x, i) => {
    const k = `${x}:${ys[i]}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.x.push(x);
    out.y.push(ys[i]);
  });
  return out;
}

/** The fixture's score table as align-to-score.py would have written it. */
function toLegacy(score: any) {
  const sec = (q: number) => q * SEC_PER_QUARTER;
  const on = dropDuplicatePairs(score.score_onset.map(sec), score.ref_onset);
  const off = dropDuplicatePairs(score.score_offset.map(sec), score.ref_offset);
  return { score_onset: on.x, ref_onset: on.y, score_offset: off.x, ref_offset: off.y };
}

async function gotoWith(page: Page, patch?: (json: any) => void) {
  await stubExternalMei(page);
  if (patch) {
    // Predicate matcher, not a glob: the navigation URL carries
    // /static/test/ inside its ?align= query (the spec-39 trap).
    await page.route(
      (url) => url.pathname === '/static/test/alignment.json',
      async (route) => {
        const resp = await route.fetch();
        const json = await resp.json();
        patch(json);
        await route.fulfill({ response: resp, json });
      },
    );
  }
  await page.goto(
    `/?align=${env.baseUrl}/static/test/alignment.json` +
      `&useLocal=${env.baseUrl}/static/test&fixMode`,
  );
  await page.waitForFunction(
    () => ((window as any)._listenTest?.loadGeneration ?? 0) > 0,
  );
  // The prewarm warms the correction worker; a hermetic suite must never
  // let the real one fetch Pyodide.
  await page.evaluate(() => {
    (window as any)._listenTest.fixWorkerFactory = () => ({
      postMessage() {},
      terminate() {},
      onmessage: null,
      onerror: null,
    });
  });
}

/** The live score table and header marker, once synthesis has run. */
async function liveTable(page: Page) {
  await page.waitForFunction(
    () =>
      ((window as any)._listenTest.alignmentGrids['Score (synthesised from MEI)'] ?? [])
        .length > 0,
    undefined,
    { timeout: 20_000 },
  );
  return page.evaluate(() => {
    const s = (window as any)._listenTest.session;
    return {
      score: s.scoreAlignment,
      convertedFrom: s.loadedAlignmentJSON?.header?.convertedFrom ?? null,
    };
  });
}

test.describe('51. legacy alignment tables', () => {
  test('51.1 the fixture MIDI runs at one tempo, so the derived legacy table is faithful', () => {
    original.score_onset.forEach((q: number, i: number) =>
      expect(original.synth_onset[i]).toBeCloseTo(q * SEC_PER_QUARTER, 9),
    );
    const legacy = toLegacy(original);
    // The CLI's shape: onset and offset lists of different lengths.
    expect(legacy.score_onset.length).not.toBe(legacy.score_offset.length);
  });

  test('51.2 a legacy seconds table converts back to the original quarters table', async ({ page }) => {
    await gotoWith(page, (json) => {
      json.body.score = toLegacy(json.body.score);
    });
    const { score, convertedFrom } = await liveTable(page);
    expect(score.score_onset).toEqual(original.score_onset);
    expect(score.score_offset).toEqual(original.score_offset);
    score.ref_onset.forEach((r: number, i: number) =>
      expect(r).toBeCloseTo(original.ref_onset[i], 9),
    );
    score.ref_offset.forEach((r: number, i: number) =>
      expect(r).toBeCloseTo(original.ref_offset[i], 9),
    );
    expect(convertedFrom).toMatchObject({
      format: 'legacy-seconds-table',
      events: original.score_onset.length,
      exactOnsets: original.score_onset.length,
      exactOffsets: original.score_offset.length,
      onsetHitRate: 1,
    });
  });

  test('51.3 fix mode accepts the converted table', async ({ page }) => {
    await gotoWith(page, (json) => {
      json.body.score = toLegacy(json.body.score);
    });
    await page.waitForFunction(
      () => (window as any)._listenTest.fix.prewarmReady,
      undefined,
      { timeout: 20_000 },
    );
    expect(await page.evaluate(() => (window as any)._listenTest.fix.lastRefusal)).toBeNull();
  });

  test('51.4 a table this app wrote is left alone', async ({ page }) => {
    await gotoWith(page);
    const { score, convertedFrom } = await liveTable(page);
    expect(convertedFrom).toBeNull();
    expect(score.score_onset).toEqual(original.score_onset);
    expect(score.ref_onset).toEqual(original.ref_onset);
  });
});
