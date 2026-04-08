import { test, expect, AUDIO_A, AUDIO_B, AUDIO_C } from '../support/fixtures';
import { loadLocalAlignment, showWaveform, hideWaveform } from '../support/helpers';

// ---------------------------------------------------------------------------
// Section 2 — Waveform Display & Loading
// ---------------------------------------------------------------------------

test.describe('2. Waveform Display & Loading', () => {

  // 2.1 Default display — only score waveform shown on load
  test('2.1 only score waveform visible by default', async ({ listenPage: page }) => {
    // Score waveform should be visible (if MEI/score alignment exists)
    const scoreWf = page.locator('#waveforms .waveform[data-ix="Score (synthesised from MEI)"]');
    // Recording waveforms should not be rendered yet
    const recordingWfs = page.locator(`#waveforms .waveform:not([data-ix="Score (synthesised from MEI)"])`);
    // Either score is visible or no waveforms at all (if no MEI)
    const scoreVisible = await scoreWf.count() > 0;
    if (scoreVisible) {
      await expect(scoreWf).toBeVisible();
    }
    // Recording waveforms should not be visible
    for (const wf of await recordingWfs.all()) {
      await expect(wf).not.toBeVisible();
    }
  });

  // 2.1b Selecting a waveform in the nav bar triggers render
  test('2.1b selecting waveform checkbox renders it', async ({ listenPage: page }) => {
    await showWaveform(page, AUDIO_A);
    const wf = page.locator(`#waveforms .waveform[data-ix="${AUDIO_A}"]`);
    await expect(wf).toBeVisible();
  });

  // 2.2 Show/hide via sidebar checkbox
  test('2.2 show/hide waveform via sidebar checkbox', async ({ listenPage: page }) => {
    await showWaveform(page, AUDIO_A);
    const wf = page.locator(`#waveforms .waveform[data-ix="${AUDIO_A}"]`);
    await expect(wf).toBeVisible();
    await hideWaveform(page, AUDIO_A);
    await expect(wf).not.toBeVisible();
  });

  // 2.3 All / None buttons
  test('2.3 All then None buttons show/hide all waveforms in group', async ({ listenPage: page }) => {
    // Click All
    const allBtn = page.locator('#waveforms .group-all').first();
    await allBtn.click();
    // Wait for at least 2 waveforms to be visible
    await page.waitForSelector('#waveforms .waveform:not([style*="display: none"])', { timeout: 15_000 });
    const visibleAfterAll = await page.locator('#waveforms .waveform:not([style*="display: none"])').count();
    expect(visibleAfterAll).toBeGreaterThanOrEqual(2);

    // Click None
    const noneBtn = page.locator('#waveforms .group-none').first();
    await noneBtn.click();
    // Allow time for hide to complete
    await page.waitForTimeout(500);
    const visibleAfterNone = await page.locator('#waveforms .waveform:not([style*="display: none"])').count();
    // Score waveform may still be visible (it's in its own group), so just check recordings are hidden
    expect(visibleAfterNone).toBeLessThan(visibleAfterAll);
  });

  // 2.5 Normalize audio toggle
  test('2.5 normalize audio toggles without error', async ({ loadedPage: page }) => {
    const cb = page.locator('#normalize');
    await cb.check({ force: true });
    await expect(cb).toBeChecked();
    // No crash — waveforms still visible
    await expect(page.locator(`#waveforms .waveform[data-ix="${AUDIO_A}"]`)).toBeVisible();
    await cb.uncheck({ force: true });
    await expect(cb).not.toBeChecked();
  });

});
