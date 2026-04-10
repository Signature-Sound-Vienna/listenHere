import { test, expect, AUDIO_A, AUDIO_B } from '../support/fixtures';
import { play, pause, showWaveform, hideWaveform } from '../support/helpers';

// ---------------------------------------------------------------------------
// Section 14 — Error & Edge Cases
// ---------------------------------------------------------------------------

test.describe('14. Error & Edge Cases', () => {

  // 14.3 Zero-waveform state
  test('14.3 hiding all waveforms does not crash', async ({ loadedPage: page }) => {
    // Hide all waveforms
    await hideWaveform(page, AUDIO_A);
    await hideWaveform(page, AUDIO_B);
    await page.waitForTimeout(300);

    // No crash — page is still responsive
    await expect(page.locator('#playpause')).toBeVisible();

    // Re-show a waveform
    await showWaveform(page, AUDIO_A);
    await expect(page.locator(`#waveforms .waveform[data-ix="${AUDIO_A}"]`)).toBeVisible();
  });

  // 14.5 Very short audio file
  test('14.5 short audio file renders without error', async ({ listenPage: page }) => {
    await showWaveform(page, 'audio-short.mp3');
    await page.waitForTimeout(500);

    const wf = page.locator('#waveforms .waveform[data-ix="audio-short.mp3"]');
    await expect(wf).toBeVisible();
  });

  // 14.8 Rapid play/pause toggling
  test('14.8 rapid play/pause does not crash', async ({ loadedPage: page }) => {
    for (let i = 0; i < 10; i++) {
      await page.evaluate(() => (document.getElementById('playpause') as HTMLElement).click());
      await page.waitForTimeout(50);
    }
    // Ensure we end in a paused state
    await page.evaluate(() => {
      const t = (window as any)._listenTest;
      if (t?.wavesurfers[t.currentAudioIx]?.isPlaying()) {
        (document.getElementById('playpause') as HTMLElement).click();
      }
    });
    await page.waitForTimeout(300);

    // App is still responsive
    await expect(page.locator('#playpause')).toBeVisible();
    // No console errors would have crashed by now
  });

  // 14.9 Switching active waveform rapidly
  test('14.9 rapid ArrowDown does not crash', async ({ loadedPage: page }) => {
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('ArrowDown');
      await page.waitForTimeout(50);
    }
    await page.waitForTimeout(300);

    // Active waveform should exist
    const activeWf = await page.evaluate(() =>
      document.querySelector('.waveform.active')?.getAttribute('data-ix'),
    );
    expect(activeWf).toBeTruthy();
  });

});
