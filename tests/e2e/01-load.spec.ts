import { test, expect } from '../support/fixtures';
import { loadViaFilePicker, FIXTURES_DIR } from '../support/helpers';
import { env } from '../support/env';
import * as path from 'path';
import { AUDIO_A, AUDIO_B, AUDIO_C, ALIGNMENT_JSON, ALIGNMENT_MALFORMED } from '../support/fixtures';

// ---------------------------------------------------------------------------
// Section 1 — Application Load & Initialisation
// ---------------------------------------------------------------------------

test.describe('1. Application Load & Initialisation', () => {

  // 1.1 Remote alignment JSON
  test('1.1 loads remote alignment JSON via ?data=', async ({ page }) => {
    test.skip(!env.remoteAlignmentUrl, 'REMOTE_ALIGNMENT_URL not configured');
    await page.goto(`/?align=${encodeURIComponent(env.remoteAlignmentUrl)}`);
    await expect(page.locator('#audios')).toBeVisible();
    // At least one file listed in the nav sidebar
    await expect(page.locator('#audios input[type="checkbox"]').first()).toBeVisible();
  });

  // 1.2 ?useFiles shows file picker
  test('1.2 ?useFiles shows file picker overlay before files are selected', async ({ page }) => {
    await page.goto('/?useFiles');
    await expect(page.locator('#file-picker-overlay')).toBeVisible();
    await expect(page.locator('#waveforms .waveform')).toHaveCount(0);
  });

  // 1.3 ?useFiles — load alignment JSON then match audio files
  test('1.3 ?useFiles — loads alignment JSON and matches audio files', async ({ page }) => {
    await loadViaFilePicker(page, [ALIGNMENT_JSON, AUDIO_A, AUDIO_B, AUDIO_C]);
    // Continue button should appear
    const continueBtn = page.locator('#file-picker-continue');
    await expect(continueBtn).toBeVisible({ timeout: 10_000 });
    await expect(continueBtn).toBeEnabled();
    await continueBtn.click();
    // Wait for the listen interface to appear and nav sidebar to list audio files
    await page.waitForSelector('#audios input[type="checkbox"]', { state: 'visible', timeout: 15_000 });
    const checkboxes = page.locator('#audios input[type="checkbox"]');
    expect(await checkboxes.count()).toBeGreaterThanOrEqual(2);
  });

  // 1.4 ?useFiles — partial match still allows Continue
  test('1.4 ?useFiles — partial file match allows Continue', async ({ page }) => {
    await loadViaFilePicker(page, [ALIGNMENT_JSON, AUDIO_A]);
    const continueBtn = page.locator('#file-picker-continue');
    await expect(continueBtn).toBeVisible({ timeout: 10_000 });
    await expect(continueBtn).toBeEnabled();
  });

  // 1.5 In-browser alignment — covered in 17-align-wizard.spec.ts

  // 1.7 ?useLocal
  test('1.7 ?useLocal overrides audio base URL', async ({ page }) => {
    test.skip(!env.remoteAlignmentUrl, 'REMOTE_ALIGNMENT_URL not configured');
    // Just verify the page loads without error in useLocal mode
    await page.goto(`/?useLocal=${encodeURIComponent(env.localAudioServerUrl)}&data=${encodeURIComponent(env.remoteAlignmentUrl)}`);
    await expect(page.locator('#audios')).toBeVisible();
  });

  // 1.8 State restoration after reload
  // Fieldset collapse state is persisted via localStorage; zoom relies on
  // browser form restoration which Playwright's reload() may not trigger,
  // so we only test localStorage-backed state here.
  test('1.8 fieldset collapse state persists across reload', async ({ page }) => {
    await page.goto(`/?align=http://localhost:5001/static/test/${ALIGNMENT_JSON}`);
    // Collapse the Settings fieldset
    await page.locator('#playback-panel legend').click();
    await expect(page.locator('#playback-panel')).toHaveClass(/collapsed/);
    // Reload
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('#playback-panel')).toHaveClass(/collapsed/);
  });

  // 1.9 Malformed alignment JSON
  test('1.9 malformed alignment JSON shows error, does not crash', async ({ page }) => {
    await page.goto(`/?align=http://localhost:5001/static/test/${ALIGNMENT_MALFORMED}`);
    // Should show an error page or element — not the waveform interface
    await expect(page.locator('#audios')).not.toBeVisible();
    // No uncaught JS exceptions
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    expect(errors).toHaveLength(0);
  });

  // 1.10 Network failure (404) fetching alignment JSON
  test('1.10 missing alignment JSON (404) shows error gracefully', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/?align=http://localhost:5001/static/test/does-not-exist.json');
    await expect(page.locator('#audios')).not.toBeVisible();
    expect(errors).toHaveLength(0);
  });

});
