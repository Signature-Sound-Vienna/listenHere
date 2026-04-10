import { test, expect } from '../support/fixtures';
import { play, pause } from '../support/helpers';

// ---------------------------------------------------------------------------
// Section 12 — Save & Load
// ---------------------------------------------------------------------------

test.describe('12. Save & Load', () => {

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
