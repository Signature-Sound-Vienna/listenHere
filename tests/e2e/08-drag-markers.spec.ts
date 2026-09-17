import { test, expect } from '../support/fixtures';
import { play, pause } from '../support/helpers';

// ---------------------------------------------------------------------------
// Section 8 — Drag Markers. (The marker-drag "Fix alignment" mode this section
// once covered was removed in 0.61.0, ruling B4; alignment correction is fix
// mode's, specs 41–43.)
// ---------------------------------------------------------------------------

test.describe('8. Alignment Correction (Drag Markers)', () => {

  // Helper: place a marker at current position
  async function placeMarker(page: import('@playwright/test').Page) {
    await page.keyboard.press('m');
    await page.waitForTimeout(200);
  }

  // 8.1 Enable drag mode
  test('8.1 enabling drag mode changes cursor and shows controls', async ({ loadedPage: page }) => {
    // Place a marker first
    await play(page);
    await page.waitForTimeout(500);
    await pause(page);
    await placeMarker(page);

    const cb = page.locator('#drag-markers-cb');
    await cb.check({ force: true });
    await page.waitForTimeout(300);

    // Markers should have .draggable class
    const draggableCount = await page.locator('.ws-marker.draggable').count();
    expect(draggableCount).toBeGreaterThan(0);

    // The legacy "Fix alignment" drag mode, its range fieldset, and the
    // per-waveform correction overlay are gone (0.61.0, ruling B4).
    await expect(page.locator('#drag-mode-fix, #radius-fieldset, .align-correction-overlay')).toHaveCount(0);
  });

  // 8.7 Revert alignment edits
  test('8.7 revert button is disabled until edits are made', async ({ loadedPage: page }) => {
    const revertBtn = page.locator('#revert-all-btn');
    await expect(revertBtn).toBeDisabled();
  });

  // 8.8 Undo/redo buttons start disabled
  test('8.8 undo and redo buttons start disabled', async ({ loadedPage: page }) => {
    await expect(page.locator('#undo-btn')).toBeDisabled();
    await expect(page.locator('#redo-btn')).toBeDisabled();
  });

  // 8.8b Undo becomes enabled after adding a marker
  test('8.8b undo becomes enabled after adding a marker', async ({ loadedPage: page }) => {
    await play(page);
    await page.waitForTimeout(500);
    await pause(page);
    await placeMarker(page);

    await expect(page.locator('#undo-btn')).toBeEnabled();
  });

});
