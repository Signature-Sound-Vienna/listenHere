import { test, expect } from '../support/fixtures';
import { play, pause } from '../support/helpers';

// ---------------------------------------------------------------------------
// Section 7 — Close Listening Mode
// ---------------------------------------------------------------------------

test.describe('7. Close Listening Mode', () => {

  // Helper: place a marker at current position
  async function placeMarker(page: import('@playwright/test').Page) {
    await page.keyboard.press('m');
    await page.waitForTimeout(200);
  }

  // 7.1 Enter close listening — active marker highlighted
  test('7.1 close listening checkbox activates mode', async ({ loadedPage: page }) => {
    // Place a marker first
    await play(page);
    await page.waitForTimeout(500);
    await pause(page);
    await placeMarker(page);

    // Enable close listening
    const cb = page.locator('#close-listening-cb');
    await cb.check({ force: true });
    await page.waitForTimeout(300);

    // Should have an active marker (darker red / highlighted)
    const activeMarkers = await page.evaluate(() => {
      const markers = document.querySelectorAll('.ws-marker');
      // Active marker gets a darker color (#8b0000)
      return [...markers].filter(m => (m as HTMLElement).style.color === 'rgb(139, 0, 0)').length;
    });
    expect(activeMarkers).toBeGreaterThan(0);
  });

  // 7.2 Enter close listening via C key
  test('7.2 C key toggles close listening mode', async ({ loadedPage: page }) => {
    await play(page);
    await page.waitForTimeout(500);
    await pause(page);
    await placeMarker(page);

    // Press C to enter
    await page.keyboard.press('c');
    await page.waitForTimeout(300);
    const cbChecked = await page.locator('#close-listening-cb').isChecked();
    expect(cbChecked).toBe(true);

    // Press Escape to exit
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    const cbUnchecked = await page.locator('#close-listening-cb').isChecked();
    expect(cbUnchecked).toBe(false);
  });

  // 7.3 Arrow navigation between markers in close listening
  test('7.3 ArrowRight advances to next marker in close listening', async ({ loadedPage: page }) => {
    // Place two markers well apart: one near start, one ~30s further
    await play(page);
    await page.waitForTimeout(500);
    await pause(page);
    await placeMarker(page);

    // Seek forward several times to get a clearly different position
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => (document.getElementById('seek-fwd') as HTMLElement).click());
    }
    await page.waitForTimeout(200);
    await placeMarker(page);

    // Seek back to start so close listening activates on the first marker
    await page.evaluate(() => (document.getElementById('skip-back') as HTMLElement).click());
    await page.waitForTimeout(200);

    // Enter close listening — activates closest marker (the first one near start)
    const cb = page.locator('#close-listening-cb');
    await cb.check({ force: true });
    await page.waitForTimeout(300);

    // Get initial playback time (should be at first marker)
    const t1 = await page.evaluate(() => {
      const t = (window as any)._listenTest;
      return t?.wavesurfers[t.currentAudioIx]?.getCurrentTime() ?? 0;
    });

    // Arrow right to advance to the second marker
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(300);

    const t2 = await page.evaluate(() => {
      const t = (window as any)._listenTest;
      return t?.wavesurfers[t.currentAudioIx]?.getCurrentTime() ?? 0;
    });

    // Playhead should have jumped to the second marker (>5s apart)
    expect(Math.abs(t2 - t1)).toBeGreaterThan(5);
  });

  // 7.7 Delete marker with Delete key
  test('7.7 Delete key removes marker in close listening', async ({ loadedPage: page }) => {
    await play(page);
    await page.waitForTimeout(500);
    await pause(page);
    await placeMarker(page);

    const cb = page.locator('#close-listening-cb');
    await cb.check({ force: true });
    await page.waitForTimeout(300);

    const markersBefore = await page.locator('.ws-marker').count();
    expect(markersBefore).toBeGreaterThan(0);

    await page.keyboard.press('Delete');
    await page.waitForTimeout(300);

    const markersAfter = await page.locator('.ws-marker').count();
    expect(markersAfter).toBeLessThan(markersBefore);
  });

  // 7.8 Undo marker deletion
  test('7.8 Ctrl+Z undoes marker deletion', async ({ loadedPage: page }) => {
    await play(page);
    await page.waitForTimeout(500);
    await pause(page);
    await placeMarker(page);

    const cb = page.locator('#close-listening-cb');
    await cb.check({ force: true });
    await page.waitForTimeout(300);

    const markersBefore = await page.locator('.ws-marker').count();
    await page.keyboard.press('Delete');
    await page.waitForTimeout(300);
    expect(await page.locator('.ws-marker').count()).toBeLessThan(markersBefore);

    // Undo
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(300);
    const markersAfterUndo = await page.locator('.ws-marker').count();
    expect(markersAfterUndo).toBe(markersBefore);
  });

  // 7.9 Undo marker addition
  test('7.9 Ctrl+Z undoes marker addition', async ({ loadedPage: page }) => {
    const markersBefore = await page.locator('.ws-marker').count();

    await play(page);
    await page.waitForTimeout(500);
    await pause(page);
    await placeMarker(page);

    const markersAfterAdd = await page.locator('.ws-marker').count();
    expect(markersAfterAdd).toBeGreaterThan(markersBefore);

    // Undo
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(300);
    const markersAfterUndo = await page.locator('.ws-marker').count();
    expect(markersAfterUndo).toBe(markersBefore);
  });

});
