import * as fs from 'fs';
import { test, expect } from '../support/fixtures';
import { play, pause } from '../support/helpers';

// ---------------------------------------------------------------------------
// Section 12 — Save & Load
// ---------------------------------------------------------------------------

test.describe('12. Save & Load', () => {

  // 12.1 Save data produces valid JSON with expected structure
  test('12.1 save data downloads parseable JSON with markers and grid', async ({ loadedPage: page }) => {
    // Add 2 markers at different positions
    await play(page);
    await page.waitForTimeout(500);
    await pause(page);
    await page.keyboard.press('m');
    await page.waitForTimeout(200);
    await page.evaluate(() => (document.getElementById('seek-fwd') as HTMLElement).click());
    await page.waitForTimeout(200);
    await page.keyboard.press('m');
    await page.waitForTimeout(200);

    // Download and inspect
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.evaluate(() => (document.getElementById('download-json-btn') as HTMLElement).click()),
    ]);

    const filePath = await download.path();
    const json = JSON.parse(fs.readFileSync(filePath!, 'utf8'));

    // Top-level structure
    expect(json.header).toBeDefined();
    expect(json.body).toBeDefined();
    expect(json.body.audio).toBeDefined();

    // 2 markers — stored as alignment indices (numbers)
    expect(Array.isArray(json.header.markers)).toBe(true);
    expect(json.header.markers.length).toBe(2);
    expect(typeof json.header.markers[0]).toBe('number');

    // Alignment grids preserve their inline {times, peaks, duration} envelope
    // when the source had one (Save Data must not be destructive — peaks and
    // duration in the input survive a load → save round-trip).
    const audioKeys = Object.keys(json.body.audio);
    expect(audioKeys.length).toBeGreaterThan(0);
    const entry = json.body.audio[audioKeys[0]];
    expect(typeof entry).toBe('object');
    expect(Array.isArray(entry)).toBe(false);
    expect(Array.isArray(entry.times)).toBe(true);
    expect(Array.isArray(entry.peaks)).toBe(true);
    expect(typeof entry.duration).toBe('number');
  });

  // 12.3 Dirty state indicator
  test('12.3 dirty indicator appears after adding a marker', async ({ loadedPage: page }) => {
    const dlBtn = page.locator('#download-json-btn');
    // Should NOT be dirty initially
    const dirtyBefore = await dlBtn.evaluate(el => el.classList.contains('json-dirty'));
    expect(dirtyBefore).toBe(false);

    // Add a marker
    await play(page);
    await page.waitForTimeout(500);
    await pause(page);
    await page.keyboard.press('m');
    await page.waitForTimeout(300);

    // Should now be dirty
    const dirtyAfter = await dlBtn.evaluate(el => el.classList.contains('json-dirty'));
    expect(dirtyAfter).toBe(true);
  });

  // 12.4 Unsaved changes warning not shown on first load
  test('12.4 no dirty indicator on first load', async ({ loadedPage: page }) => {
    const dlBtn = page.locator('#download-json-btn');
    const isDirty = await dlBtn.evaluate(el => el.classList.contains('json-dirty'));
    expect(isDirty).toBe(false);
  });

});
