import * as fs from 'fs';
import { test, expect } from '../support/fixtures';
import { play, pause } from '../support/helpers';

// ---------------------------------------------------------------------------
// Section 6 — Markers
// ---------------------------------------------------------------------------

test.describe('6. Markers', () => {

  // 6.1 Add marker via M key
  test('6.1 M key places a marker on all waveforms', async ({ loadedPage: page }) => {
    // Play briefly so we have a non-zero position
    await play(page);
    await page.waitForTimeout(800);
    await pause(page);

    const markersBefore = await page.locator('.ws-marker').count();

    await page.keyboard.press('m');
    await page.waitForTimeout(300);

    const markersAfter = await page.locator('.ws-marker').count();
    // Markers should appear on all visible waveforms (at least 2: audio-a, audio-b + score)
    expect(markersAfter).toBeGreaterThan(markersBefore);
    expect(markersAfter - markersBefore).toBeGreaterThanOrEqual(2);
  });

  // 6.2 Add marker via Mark button
  test('6.2 Mark button places a marker', async ({ loadedPage: page }) => {
    await play(page);
    await page.waitForTimeout(800);
    await pause(page);

    const markersBefore = await page.locator('.ws-marker').count();

    await page.evaluate(() => (document.getElementById('mark') as HTMLElement).click());
    await page.waitForTimeout(300);

    const markersAfter = await page.locator('.ws-marker').count();
    expect(markersAfter).toBeGreaterThan(markersBefore);
  });

  // 6.4 Multiple markers
  test('6.4 multiple markers can be added at different positions', async ({ loadedPage: page }) => {
    // Seek forward and place markers at different positions
    await play(page);
    await page.waitForTimeout(500);
    await pause(page);
    await page.keyboard.press('m');
    await page.waitForTimeout(200);

    // Seek further
    await page.evaluate(() => (document.getElementById('seek-fwd') as HTMLElement).click());
    await page.waitForTimeout(200);
    await page.keyboard.press('m');
    await page.waitForTimeout(200);

    // Seek further again
    await page.evaluate(() => (document.getElementById('seek-fwd') as HTMLElement).click());
    await page.waitForTimeout(200);
    await page.keyboard.press('m');
    await page.waitForTimeout(200);

    // Should have markers from 3 placements across all waveforms
    const markerCount = await page.locator('.ws-marker').count();
    // Each waveform gets one marker per placement; at least 3 waveforms visible × 3 placements = 9
    expect(markerCount).toBeGreaterThanOrEqual(6); // at least 2 waveforms × 3 markers
  });

  // 6.6 Marker persisted in saved JSON
  test('6.6 markers appear in downloaded alignment JSON', async ({ loadedPage: page }) => {
    await play(page);
    await page.waitForTimeout(800);
    await pause(page);
    await page.keyboard.press('m');
    await page.waitForTimeout(300);

    // Intercept the download triggered by clicking Save data
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.evaluate(() => (document.getElementById('download-json-btn') as HTMLElement).click()),
    ]);

    const filePath = await download.path();
    const json = JSON.parse(fs.readFileSync(filePath!, 'utf8'));

    // The saved JSON must have at least one marker in header.markers
    expect(json.header).toBeDefined();
    expect(Array.isArray(json.header.markers)).toBe(true);
    expect(json.header.markers.length).toBeGreaterThanOrEqual(1);
    // Markers are stored as alignment indices (numbers)
    expect(typeof json.header.markers[0]).toBe('number');
  });

  // 6.5 Markers survive waveform switch
  test('6.5 markers persist after switching active waveform', async ({ loadedPage: page }) => {
    await play(page);
    await page.waitForTimeout(500);
    await pause(page);
    await page.keyboard.press('m');
    await page.waitForTimeout(200);

    const markersBefore = await page.locator('.ws-marker').count();

    // Switch active waveform
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(300);

    const markersAfter = await page.locator('.ws-marker').count();
    expect(markersAfter).toBe(markersBefore);
  });

});
