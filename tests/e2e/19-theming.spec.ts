import { test, expect } from '../support/fixtures';

// ---------------------------------------------------------------------------
// Section 19 — Theming
// ---------------------------------------------------------------------------

const THEME_KEY = 'listenTool_theme';
// Time (ms) to allow the settings drawer slide-in transition to complete
const DRAWER_TRANSITION_MS = 350;

/** Open the settings drawer and wait for its transition to settle. Every page
 *  uses the same ids: listen.html declares the drawer, theme-setup.js injects an
 *  identical one wherever the page has none. */
async function openSettingsDrawer(page: import('@playwright/test').Page) {
  await page.locator('#settings-drawer-btn').click();
  await page.waitForTimeout(DRAWER_TRANSITION_MS);
}

/** Click a theme option by value. Radio inputs are visually hidden; click the label instead. */
async function selectTheme(page: import('@playwright/test').Page, drawerSelector: string, value: string) {
  await page.locator(`${drawerSelector} .settings-theme-option:has(input[value="${value}"])`).click();
}

test.describe('19. Theming', () => {

  // 19.1 Theme persists across page reload on the listen page
  test('19.1 selected theme persists across reload', async ({ listenPage: page }) => {
    await openSettingsDrawer(page);
    await selectTheme(page, '#settings-drawer', 'dark');

    // data-theme attribute should be applied immediately
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    // Reload and verify persistence
    await page.reload();
    await page.waitForLoadState('networkidle');

    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    // The correct radio should be checked after restore
    const isChecked = await page.evaluate(() => {
      const radio = document.querySelector('input[name="app-theme"][value="dark"]') as HTMLInputElement;
      return radio?.checked ?? false;
    });
    expect(isChecked).toBe(true);

    // Clean up: restore light theme so other tests are unaffected
    await page.evaluate((key) => localStorage.removeItem(key), THEME_KEY);
  });

  // 19.2 Landing page settings drawer opens and applies theme
  test('19.2 landing page settings drawer opens and applies theme', async ({ page }) => {
    await page.goto('/');

    // Injected cog button should be present
    await expect(page.locator('#settings-drawer-btn')).toBeVisible();

    await openSettingsDrawer(page);
    const drawer = page.locator('#settings-drawer');
    await expect(drawer).not.toHaveClass(/closed/);

    // Select a non-default theme
    await selectTheme(page, '#settings-drawer', 'solarized');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'solarized');

    // Theme should carry over to the listen page (same localStorage key)
    const storedTheme = await page.evaluate((key) => localStorage.getItem(key), THEME_KEY);
    expect(storedTheme).toBe('solarized');

    // Navigate to the listen page and confirm data-theme is restored before paint
    await page.goto('/?align=http://localhost:5001/static/test/alignment.json&useLocal=http://localhost:5001/static/test');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'solarized');

    // Clean up
    await page.evaluate((key) => localStorage.removeItem(key), THEME_KEY);
  });

  // 19.3 Logo swaps between sleeping/active bat based on theme background
  test('19.3 logo swaps to active bat on dark-background themes', async ({ listenPage: page }) => {
    const logo = page.locator('.nav-logo-img');

    // Light theme — sleeping bat
    await page.evaluate((key) => localStorage.removeItem(key), THEME_KEY);
    await page.reload();
    await page.waitForLoadState('networkidle');
    await expect(logo).toHaveAttribute('src', /ListenHereBatAsleep\.svg/);

    // Switch to a dark-background theme
    await openSettingsDrawer(page);
    await selectTheme(page, '#settings-drawer', 'dark');
    const darkSrc = await logo.getAttribute('src');
    expect(darkSrc).toMatch(/ListenHereBat\.svg/);
    expect(darkSrc).not.toMatch(/Asleep/);

    // Switch back to a light theme (drawer is already open)
    await selectTheme(page, '#settings-drawer', 'light');
    await expect(logo).toHaveAttribute('src', /ListenHereBatAsleep\.svg/);

    // Clean up
    await page.evaluate((key) => localStorage.removeItem(key), THEME_KEY);
  });

  // 19.4 Group card uses dark text on pastel background
  test('19.4 pastel group colour gets dark text for legibility', async ({ listenPage: page }) => {
    // Open the group-files modal
    await page.locator('#group-files-btn').click();
    await expect(page.locator('.gm-backdrop')).toBeVisible();

    // Add a new group
    await page.locator('.gm-add-group').click();

    // The new group card should exist
    const card = page.locator('.gm-group-card').last();
    await expect(card).toBeVisible();

    // Pick the first palette swatch (soft blue #dbeafe)
    await card.locator('.gm-swatch').first().click();

    // Card background and text color should both be set inline.
    // Browsers normalise hex to rgb(), so compare against rgb(34,34,34) for #222.
    const { bg, color } = await card.evaluate((el: HTMLElement) => ({
      bg:    el.style.backgroundColor,
      color: el.style.color,
    }));

    expect(bg).toBeTruthy();
    expect(color).toBe('rgb(34, 34, 34)');

    // Text inside the card should also end up dark. This reads the COMPUTED
    // colour rather than the inline one: the dark text used to be stamped onto
    // each label inline, and is now inherited from the card via a
    // `.gm-has-colour` CSS rule, which also covers the filename rows the inline
    // sweep never reached. Asserting the inline value tested the mechanism, so
    // it could not have caught those rows being illegible; the computed value
    // tests the outcome and holds either way.
    await expect(card).toHaveClass(/gm-has-colour/);
    const labelColor = await card.locator('.gm-addby-row label').evaluate(
      (el: HTMLElement) => getComputedStyle(el).color
    );
    expect(labelColor).toBe('rgb(34, 34, 34)');
  });

  // 19.5 One drawer per page: theme-setup.js injects the Theme section into the
  //      drawer listen.html already declares, rather than a second drawer of its own.
  test('19.5 the listen page has exactly one settings drawer, with an injected Theme section', async ({ listenPage: page }) => {
    // Exactly one drawer, one pull button, one Theme section, one set of radios
    await expect(page.locator('#settings-drawer')).toHaveCount(1);
    await expect(page.locator('#settings-drawer-btn')).toHaveCount(1);
    await expect(page.locator('#settings-drawer-content > .settings-section')).toHaveCount(2);
    await expect(page.locator('input[name="app-theme"]')).toHaveCount(8);

    // Theme is injected ahead of the page's own Language section
    const titles = await page.locator('#settings-drawer-content .settings-section-title')
      .allTextContents();
    expect(titles).toEqual(['Theme', 'Language']);
  });

});
