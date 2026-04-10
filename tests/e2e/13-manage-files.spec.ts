import { test, expect } from '../support/fixtures';

// ---------------------------------------------------------------------------
// Section 13 — Manage Files Modal
// ---------------------------------------------------------------------------

test.describe('13. Manage Files Modal', () => {

  // 13.1 Modal opens and closes
  test('13.1 manage files button opens file picker overlay', async ({ loadedPage: page }) => {
    // Click Manage files
    await page.evaluate(() => (document.getElementById('manage-files-btn') as HTMLElement).click());
    await page.waitForTimeout(300);

    // File picker overlay should be visible
    const overlay = page.locator('#file-picker-overlay');
    await expect(overlay).toBeVisible();
  });

});
