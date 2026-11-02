import { test, expect, AUDIO_A, AUDIO_B, AUDIO_C, AUDIO_SHORT, ALIGNMENT_NO_PEAKS } from '../support/fixtures';
import { loadLocalAlignment, showWaveform, hideWaveform, waitForWaveformsReady } from '../support/helpers';

// ---------------------------------------------------------------------------
// Section 2 — Waveform Display & Loading
// ---------------------------------------------------------------------------

test.describe('2. Waveform Display & Loading', () => {

  // 2.1 Default display — when the alignment JSON ships precalculated peaks,
  // all recording waveforms auto-load on interface load (the fixture has peaks
  // for every recording, so all four become visible without user interaction).
  test('2.1 all waveforms auto-load when alignment has precalculated peaks', async ({ listenPage: page }) => {
    await waitForWaveformsReady(page);
    for (const fn of [AUDIO_A, AUDIO_B, AUDIO_C, AUDIO_SHORT]) {
      await expect(page.locator(`#waveforms .waveform[data-ix="${fn}"]`)).toBeVisible();
    }
  });

  // 2.1c Default display — when the alignment JSON has NO precalculated peaks,
  // only the first five recordings auto-load (the no-peaks fixture has six,
  // named audio-1.mp3 … audio-6.mp3, so audio-6 must stay unloaded).
  test('2.1c only first five waveforms auto-load when alignment lacks peaks', async ({ page }) => {
    await loadLocalAlignment(page, ALIGNMENT_NO_PEAKS);
    await page.waitForLoadState('networkidle');
    await waitForWaveformsReady(page);
    for (const fn of ['audio-1.mp3', 'audio-2.mp3', 'audio-3.mp3', 'audio-4.mp3', 'audio-5.mp3']) {
      await expect(page.locator(`#waveforms .waveform[data-ix="${fn}"]`)).toBeVisible();
    }
    // The sixth recording is beyond the first-five default and must not load.
    await expect(page.locator(`#waveforms .waveform[data-ix="audio-6.mp3"]`)).not.toBeVisible();
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
  test('2.3 All then None buttons show/hide all waveforms in group', async ({ loadedPage: page }) => {
    // Click All — use loadedPage to ensure group containers exist (they're created on waveform load)
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
