import { test, expect } from '../support/fixtures';

// ---------------------------------------------------------------------------
// Section 18 — Annotations & Solid / Linked Data
// ---------------------------------------------------------------------------
// These tests require a configured Solid test pod (SOLID_POD_URL in .env).
// The 'solid' Playwright project only runs when the env var is set.

test.describe('18. Annotations & Solid', () => {

  // 18.5 Solid drawer opens and shows login prompt
  test('18.5 Solid drawer opens on button click', async ({ loadedPage: page }) => {
    const drawerBtn = page.locator('#solid-drawer-btn');
    await drawerBtn.click({ force: true });
    await page.waitForTimeout(500);

    const drawer = page.locator('#solid-drawer');
    // Drawer should no longer have .closed class
    const isClosed = await drawer.evaluate(el => el.classList.contains('closed'));
    expect(isClosed).toBe(false);

    // Login prompt should be visible
    await expect(page.locator('#solidLoginBtn')).toBeVisible();
  });

});
