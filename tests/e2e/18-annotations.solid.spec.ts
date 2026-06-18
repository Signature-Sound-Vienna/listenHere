import { test, expect } from '../support/fixtures';

// ---------------------------------------------------------------------------
// Section 18 — Annotations & Solid / Linked Data
// ---------------------------------------------------------------------------
// These tests require a configured Solid test pod (SOLID_POD_URL in .env).
// The 'solid' Playwright project only runs when the env var is set.

test.describe('18. Annotations & Solid', () => {

  // 18.5 Annotation drawer opens and reveals the Solid login surface
  test('18.5 Load-from-Solid opens the drawer and shows the login surface', async ({ loadedPage: page }) => {
    // While logged out, the ribbon's "Load from Solid" action opens the
    // annotation drawer and surfaces the login controls in its footer.
    await page.locator('.lh-v6-ribbon-load').click();

    const drawer = page.locator('.lh-v6-drawer');
    await expect(drawer).toHaveClass(/open/);

    // Logged-out footer shows the provider chooser + Connect button.
    await expect(page.locator('.lh-v6-drawer-solid .lh-v6-solid-connect')).toBeVisible();
    await expect(page.locator('.lh-v6-drawer-solid .lh-v6-solid-select')).toBeVisible();
  });

});
