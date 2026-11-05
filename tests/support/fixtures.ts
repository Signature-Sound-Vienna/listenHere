import { test as base, expect, type BrowserContext, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { loadLocalAlignment, showWaveform, waitForWaveformsReady } from './helpers';

export { expect };

// ---------------------------------------------------------------------------
// Test fixture file/name constants
// ---------------------------------------------------------------------------

export const AUDIO_A = 'audio-a.mp3';
export const AUDIO_B = 'audio-b.mp3';
export const AUDIO_C = 'audio-c.mp3';
export const AUDIO_SHORT = 'audio-short.mp3';
export const ALIGNMENT_JSON = 'alignment.json';
export const ALIGNMENT_MALFORMED = 'alignment-malformed.json';
// Alignment with 6 recordings and NO precalculated peaks — exercises the
// "auto-load only the first 5 waveforms" default path.
export const ALIGNMENT_NO_PEAKS = 'alignment-no-peaks.json';
/** 20 recordings with precalculated peaks — exercises lazy waveform creation. */
export const ALIGNMENT_MANY = 'alignment-many.json';
/**
 * alignment.json plus two grouping tabs, the active one deliberately DEFECTIVE:
 * "First" and "Second" both list audio-b.mp3 explicitly, and "Pattern" claims it
 * (and the score) by regex. Exercises the load-time overlap repair — a recording
 * belongs to exactly one group per grouping context. The second tab is clean and
 * gives audio-b.mp3 to a different group, so a tab switch legitimately changes
 * its affiliation. See roadmap item U.
 */
export const ALIGNMENT_OVERLAP = 'alignment-overlap.json';

// ---------------------------------------------------------------------------
// Custom fixture types
// ---------------------------------------------------------------------------

type AppFixtures = {
  /** Navigated to listen mode with local alignment; no waveforms shown yet. */
  listenPage: Page;
  /** listenPage + audio-a and audio-b shown and ready. */
  loadedPage: Page;
};

// ---------------------------------------------------------------------------
// Extended test object with common setup
// ---------------------------------------------------------------------------

/**
 * Wait until the app reports a completed load. networkidle is NOT a substitute:
 * it can fire inside setGrids' CPU-bound Verovio window (after the MEI fetch
 * lands, before the sidebar renders), so tests would run against a page whose
 * sidebar — including the Score fieldset — does not exist yet.
 */
async function waitForAppLoad(page: Page) {
  await page.waitForFunction(() => ((window as any)._listenTest?.loadGeneration ?? 0) > 0, null, {
    timeout: 40_000,
  });
}

// ---------------------------------------------------------------------------
// Pyodide from tests/fixtures/pyodide/ instead of jsDelivr
// ---------------------------------------------------------------------------

/**
 * The alignment worker loads Pyodide (runtime + numpy, ~27 MB) from jsDelivr.
 * Every test gets a fresh context with an empty HTTP cache, so each boot would
 * fetch it all again. Serve the copies in tests/fixtures/pyodide/<version>/
 * instead; the context route covers the worker's requests too. Production keeps
 * the CDN, where the browser cache does this job. A file missing here answers
 * 404 at once rather than reaching the CDN: vendor it from the same folder.
 */
const PYODIDE_CDN = /^https:\/\/cdn\.jsdelivr\.net\/pyodide\/(v[^/]+)\/full\/([^?#]+)/;
const PYODIDE_FIXTURES = path.resolve(__dirname, '../fixtures/pyodide');
const PYODIDE_TYPES: Record<string, string> = {
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.zip': 'application/zip',
  '.whl': 'application/octet-stream',
};

async function routePyodideToFixtures(context: BrowserContext) {
  await context.route(PYODIDE_CDN, async (route) => {
    const [, version, file] = route.request().url().match(PYODIDE_CDN)!;
    const local = path.join(PYODIDE_FIXTURES, version, file);
    const headers = { 'Access-Control-Allow-Origin': '*' };
    if (!fs.existsSync(local)) {
      await route.fulfill({ status: 404, headers, body: `not in tests/fixtures/pyodide/: ${version}/${file}` });
      return;
    }
    await route.fulfill({
      path: local,
      headers,
      contentType: PYODIDE_TYPES[path.extname(file)] ?? 'application/octet-stream',
    });
  });
}

export const test = base.extend<AppFixtures>({
  context: async ({ context }, use) => {
    await routePyodideToFixtures(context);
    await use(context);
  },

  listenPage: async ({ page }, use) => {
    await loadLocalAlignment(page, ALIGNMENT_JSON);
    await waitForAppLoad(page);
    await use(page);
  },

  loadedPage: async ({ page }, use) => {
    await loadLocalAlignment(page, ALIGNMENT_JSON);
    await waitForAppLoad(page);
    await showWaveform(page, AUDIO_A);
    await showWaveform(page, AUDIO_B);
    await waitForWaveformsReady(page);
    // Click first waveform to make it active (sets currentAudioIx)
    const wf = page.locator(`#waveforms .waveform[data-ix="${AUDIO_A}"]`);
    await wf.click({ position: { x: 10, y: 10 }, force: true });
    await page.waitForTimeout(200);
    await use(page);
  },
});
