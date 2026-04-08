import { type Page, expect } from '@playwright/test';
import * as path from 'path';

export const FIXTURES_DIR = path.resolve(__dirname, '../fixtures');

// ---------------------------------------------------------------------------
// Navigation helpers
// ---------------------------------------------------------------------------

/**
 * Navigate to the listen interface with a local alignment JSON served by
 * the Flask dev server from tests/fixtures/.
 */
export async function loadLocalAlignment(page: Page, filename = 'alignment.json') {
  // useLocal overrides the audio base URL so that relative filenames in the
  // alignment JSON resolve to /static/test/ (where test fixtures are served).
  await page.goto(`/?align=http://localhost:5001/static/test/${filename}&useLocal=http://localhost:5001/static/test`);
}

/**
 * Navigate to the listen interface in ?useFiles mode and provide files
 * via the Playwright file-chooser API.
 */
export async function loadViaFilePicker(
  page: Page,
  files: string[], // absolute paths or filenames relative to FIXTURES_DIR
) {
  const resolved = files.map((f) =>
    path.isAbsolute(f) ? f : path.join(FIXTURES_DIR, f),
  );
  await page.goto('/?useFiles');
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.click('#file-picker-files-btn'),
  ]);
  await chooser.setFiles(resolved);
}

/**
 * Navigate to the alignment wizard.
 */
export async function goToAlignMode(page: Page) {
  await page.goto('/?mode=align');
}

// ---------------------------------------------------------------------------
// Waveform helpers
// ---------------------------------------------------------------------------

/**
 * Click the nav sidebar checkbox to show a waveform, then wait for it
 * to be visible in the content pane.
 */
export async function showWaveform(page: Page, filename: string) {
  // The checkbox value attribute contains the filename key.
  // Use evaluate to click directly — the nav layout can overlap checkboxes
  // at small viewport sizes, preventing normal Playwright clicks.
  await page.evaluate((fn) => {
    const cb = document.querySelector(`#audios input[type="checkbox"][value="${fn}"]`) as HTMLInputElement;
    if (cb && !cb.checked) cb.click();
  }, filename);
  await page.waitForSelector(
    `#waveforms .waveform[data-ix="${filename}"]`,
    { state: 'visible', timeout: 15_000 },
  );
}

/**
 * Hide a waveform via its sidebar checkbox.
 */
export async function hideWaveform(page: Page, filename: string) {
  await page.evaluate((fn) => {
    const cb = document.querySelector(`#audios input[type="checkbox"][value="${fn}"]`) as HTMLInputElement;
    if (cb && cb.checked) cb.click();
  }, filename);
}

/**
 * Wait for all currently checked waveforms to finish loading
 * (WaveSurfer fires 'redrawcomplete' which we detect via a data attribute
 * set in the ready handler).
 */
export async function waitForWaveformsReady(page: Page, timeout = 30_000) {
  // The app adds .ready to the checkbox label when a waveform finishes loading.
  // Wait until all checked checkboxes have a .ready label sibling.
  await page.waitForFunction(
    () => {
      const checked = document.querySelectorAll('#audios input[type="checkbox"]:checked');
      if (checked.length === 0) return true;
      return [...checked].every((cb) => {
        const label = cb.parentElement?.querySelector('label');
        return label?.classList.contains('ready');
      });
    },
    { timeout },
  );
}

// ---------------------------------------------------------------------------
// Playback helpers
// ---------------------------------------------------------------------------

export async function play(page: Page) {
  await page.evaluate(() => (document.getElementById('playpause') as HTMLElement).click());
  await expect(page.locator('#playpause .icon-pause')).toBeVisible();
}

export async function pause(page: Page) {
  await page.evaluate(() => (document.getElementById('playpause') as HTMLElement).click());
  await expect(page.locator('#playpause .icon-play')).toBeVisible();
}

export async function skipToStart(page: Page) {
  await page.evaluate(() => (document.getElementById('skip-back') as HTMLElement).click());
}

// ---------------------------------------------------------------------------
// Timing / performance helper
// ---------------------------------------------------------------------------

/**
 * Measures wall-clock time (ms) for an async action in the browser context.
 */
export async function measureMs(page: Page, action: () => Promise<void>): Promise<number> {
  const t0 = await page.evaluate(() => performance.now());
  await action();
  return await page.evaluate(() => performance.now()) - t0;
}
