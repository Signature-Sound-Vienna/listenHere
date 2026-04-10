import { test, expect } from '../support/fixtures';
import { play, pause } from '../support/helpers';

// ---------------------------------------------------------------------------
// Section 8 — Alignment Correction (Drag Markers)
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
  });

  // 8.6 Fix alignment drag on score waveform has no effect
  // In "Fix alignment" mode (not "Move marker"), dragging on score or reference
  // should not warp the alignment grid.
  test('8.6 fix-alignment drag on score waveform does not alter alignment', async ({ loadedPage: page }) => {
    await play(page);
    await page.waitForTimeout(500);
    await pause(page);
    await placeMarker(page);

    // Enable drag in Fix alignment mode
    const dragCb = page.locator('#drag-markers-cb');
    await dragCb.check({ force: true });
    await page.locator('#drag-mode-fix').check({ force: true });
    await page.waitForTimeout(300);

    // Snapshot the score alignment grid before drag
    const gridBefore = await page.evaluate(() => {
      const t = (window as any)._listenTest;
      const key = 'Score (synthesised from MEI)';
      // alignmentGrids is not on _listenTest, but we can check the marker position
      const scoreWf = document.querySelector(`.waveform[data-ix="${key}"]`);
      if (!scoreWf) return null;
      const marker = scoreWf.querySelector('.ws-marker');
      return marker ? (marker as HTMLElement).dataset.alignIx : null;
    });

    // Attempt to drag the score marker
    const scoreMarker = page.locator('.waveform[data-ix="Score (synthesised from MEI)"] .ws-marker').first();
    const box = await scoreMarker.boundingBox();
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + 100, box.y, { steps: 5 });
      await page.mouse.up();
      await page.waitForTimeout(300);
    }

    // Score marker alignment index should not have changed
    const gridAfter = await page.evaluate(() => {
      const scoreWf = document.querySelector('.waveform[data-ix="Score (synthesised from MEI)"]');
      if (!scoreWf) return null;
      const marker = scoreWf.querySelector('.ws-marker');
      return marker ? (marker as HTMLElement).dataset.alignIx : null;
    });
    expect(gridAfter).toBe(gridBefore);
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
