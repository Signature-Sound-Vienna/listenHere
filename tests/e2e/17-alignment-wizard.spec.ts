import { test as base, expect } from '@playwright/test';
import * as path from 'path';

const test = base;
const FIXTURES = path.resolve(__dirname, '..', 'fixtures');

type Pg = import('@playwright/test').Page;

/** data-step of the wizard's currently active step. */
const activeStep = (page: Pg) =>
  page.evaluate(
    () => document.querySelector('.align-step.active')?.getAttribute('data-step') ?? null,
  );

/** Wait until the picked files have actually been read into the wizard table. */
async function filesListed(page: Pg) {
  await expect(page.locator('#align-file-table tbody tr').first()).toBeVisible({
    timeout: 20_000,
  });
}

/** Click Next/Back and wait for the step indicator to really move. */
async function stepBy(page: Pg, button: '#align-next-btn' | '#align-prev-btn') {
  const before = await activeStep(page);
  await page.click(button);
  await expect.poll(() => activeStep(page), { timeout: 15_000 }).not.toBe(before);
}

// ---------------------------------------------------------------------------
// Section 17 — In-Browser Alignment Workflow (/?mode=align)
// ---------------------------------------------------------------------------

test.describe('17. Alignment Wizard', () => {

  // 17.1 Landing page shows alignment wizard
  test('17.1 /?mode=align shows align panel', async ({ page }) => {
    await page.goto('/?mode=align');
    await page.waitForLoadState('networkidle');

    await expect(page.locator('#align-panel')).toBeVisible();
    // Step 1 (Files) should be active
    await expect(page.locator('.align-step[data-step="1"]')).toHaveClass(/active/);
    // No waveforms should be loaded in listen interface
    const waveformCount = await page.locator('#waveforms .waveform').count();
    expect(waveformCount).toBe(0);
  });

  // 17.2 Step 1 — load files via Choose Files
  test('17.2 loading files populates file table', async ({ page }) => {
    await page.goto('/?mode=align');
    await page.waitForLoadState('networkidle');

    // Provide audio files via the hidden file input
    const fileInput = page.locator('#align-file-input');
    await fileInput.setInputFiles([
      path.join(FIXTURES, 'audio-a.mp3'),
      path.join(FIXTURES, 'audio-b.mp3'),
      path.join(FIXTURES, 'audio-c.mp3'),
    ]);
    await filesListed(page);

    // File table should show 3 rows
    const rows = page.locator('#align-file-table tbody tr');
    await expect(rows).toHaveCount(3);

    // One file should be auto-selected as reference
    const refRadios = page.locator('#align-file-table input[type="radio"]:checked');
    await expect(refRadios).toHaveCount(1);
  });

  // 17.4 Step 1 — change reference audio
  test('17.4 changing reference radio updates selection', async ({ page }) => {
    await page.goto('/?mode=align');
    await page.waitForLoadState('networkidle');

    const fileInput = page.locator('#align-file-input');
    await fileInput.setInputFiles([
      path.join(FIXTURES, 'audio-a.mp3'),
      path.join(FIXTURES, 'audio-b.mp3'),
    ]);
    await filesListed(page);

    // Click the second ref radio
    const secondRadio = page.locator('#align-file-table input[type="radio"]').nth(1);
    await secondRadio.check({ force: true });
    await expect(secondRadio).toBeChecked();
  });

  // 17.5 Step 1 → Step 2 navigation
  test('17.5 Next button advances to Quality step', async ({ page }) => {
    await page.goto('/?mode=align');
    await page.waitForLoadState('networkidle');

    const fileInput = page.locator('#align-file-input');
    await fileInput.setInputFiles([
      path.join(FIXTURES, 'audio-a.mp3'),
      path.join(FIXTURES, 'audio-b.mp3'),
    ]);
    await filesListed(page);

    await stepBy(page, '#align-next-btn');

    // Step 2 should be active
    await expect(page.locator('.align-step[data-step="2"]')).toHaveClass(/active/);
    // Quality tab should be visible
    await expect(page.locator('#align-tab-quality')).toBeVisible();
    // Back button should be visible
    await expect(page.locator('#align-prev-btn')).toBeVisible();
  });

  // 17.6 Step 2 — quality preset selection
  test('17.6 quality presets can be selected', async ({ page }) => {
    await page.goto('/?mode=align');
    await page.waitForLoadState('networkidle');

    const fileInput = page.locator('#align-file-input');
    await fileInput.setInputFiles([
      path.join(FIXTURES, 'audio-a.mp3'),
      path.join(FIXTURES, 'audio-b.mp3'),
    ]);
    await filesListed(page);
    await stepBy(page, '#align-next-btn');

    // Select Fast
    await page.locator('input[name="align-quality"][value="fast"]').check({ force: true });
    await expect(page.locator('input[name="align-quality"][value="fast"]')).toBeChecked();

    // Select High quality
    await page.locator('input[name="align-quality"][value="hq"]').check({ force: true });
    await expect(page.locator('input[name="align-quality"][value="hq"]')).toBeChecked();

    // Back to Balanced
    await page.locator('input[name="align-quality"][value="balanced"]').check({ force: true });
    await expect(page.locator('input[name="align-quality"][value="balanced"]')).toBeChecked();
  });

  // 17.9 Step 2 → Step 3 navigation
  test('17.9 Next from Quality advances to URIs step', async ({ page }) => {
    await page.goto('/?mode=align');
    await page.waitForLoadState('networkidle');

    const fileInput = page.locator('#align-file-input');
    await fileInput.setInputFiles([
      path.join(FIXTURES, 'audio-a.mp3'),
      path.join(FIXTURES, 'audio-b.mp3'),
    ]);
    await filesListed(page);
    await stepBy(page, '#align-next-btn'); // → Step 2
    await stepBy(page, '#align-next-btn'); // → Step 3

    await expect(page.locator('.align-step[data-step="3"]')).toHaveClass(/active/);
    await expect(page.locator('#align-tab-uris')).toBeVisible();
    await expect(page.locator('#align-mei-input')).toBeVisible();
  });

  // 17.12 Step 3 → Step 4 navigation
  test('17.12 Next from URIs advances to Align step', async ({ page }) => {
    await page.goto('/?mode=align');
    await page.waitForLoadState('networkidle');

    const fileInput = page.locator('#align-file-input');
    await fileInput.setInputFiles([
      path.join(FIXTURES, 'audio-a.mp3'),
      path.join(FIXTURES, 'audio-b.mp3'),
    ]);
    await filesListed(page);
    await stepBy(page, '#align-next-btn'); // → Step 2
    await stepBy(page, '#align-next-btn'); // → Step 3
    await stepBy(page, '#align-next-btn'); // → Step 4

    await expect(page.locator('.align-step[data-step="4"]')).toHaveClass(/active/);
    await expect(page.locator('#align-tab-align')).toBeVisible();
    await expect(page.locator('#align-start-btn')).toBeVisible();
  });

  // 17.18 Back navigation preserves state
  test('17.18 Back navigation preserves quality selection', async ({ page }) => {
    await page.goto('/?mode=align');
    await page.waitForLoadState('networkidle');

    const fileInput = page.locator('#align-file-input');
    await fileInput.setInputFiles([
      path.join(FIXTURES, 'audio-a.mp3'),
      path.join(FIXTURES, 'audio-b.mp3'),
    ]);
    await filesListed(page);
    await stepBy(page, '#align-next-btn'); // → Step 2

    // Select Fast
    await page.locator('input[name="align-quality"][value="fast"]').check({ force: true });

    await stepBy(page, '#align-next-btn'); // → Step 3
    await stepBy(page, '#align-prev-btn'); // ← Step 2

    // Fast should still be selected
    await expect(page.locator('input[name="align-quality"][value="fast"]')).toBeChecked();
  });

  // 17.21 Error — fewer than 2 files
  test('17.21 single file cannot proceed past Step 1', async ({ page }) => {
    await page.goto('/?mode=align');
    await page.waitForLoadState('networkidle');

    const fileInput = page.locator('#align-file-input');
    await fileInput.setInputFiles([path.join(FIXTURES, 'audio-a.mp3')]);
    await filesListed(page);

    // Next must NOT advance here, so this stays a bounded wait: there is no
    // positive signal to await when the correct behaviour is "nothing happens".
    await page.click('#align-next-btn');
    await page.waitForTimeout(300);

    // Should still be on Step 1
    await expect(page.locator('.align-step[data-step="1"]')).toHaveClass(/active/);
  });

});
