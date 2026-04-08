import { test, expect, AUDIO_A, AUDIO_B } from '../support/fixtures';
import { play, pause, skipToStart, showWaveform } from '../support/helpers';

// Helper to get current playback time from the first non-score waveform
async function getPlaybackTime(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(() => {
    const t = (window as any)._listenTest;
    if (!t?.wavesurfers) return 0;
    const key = Object.keys(t.wavesurfers).find((k: string) => k !== 'Score (synthesised from MEI)');
    return key ? t.wavesurfers[key].getCurrentTime() : 0;
  });
}

// ---------------------------------------------------------------------------
// Section 3 — Playback & Transport
// ---------------------------------------------------------------------------

test.describe('3. Playback & Transport', () => {

  // 3.1 Play / Pause via button
  test('3.1 play and pause via transport button', async ({ loadedPage: page }) => {
    await play(page);
    const t1 = await getPlaybackTime(page);
    await page.waitForTimeout(500);
    const t2 = await getPlaybackTime(page);
    expect(t2).toBeGreaterThan(t1);
    await pause(page);
  });

  // 3.2 Space bar play/pause
  test('3.2 space bar toggles play/pause', async ({ loadedPage: page }) => {
    await page.keyboard.press('Space');
    await expect(page.locator('#playpause .icon-pause')).toBeVisible({ timeout: 2000 });
    await page.keyboard.press('Space');
    await expect(page.locator('#playpause .icon-play')).toBeVisible({ timeout: 2000 });
  });

  // 3.3 Skip to start
  test('3.3 skip to start returns playhead to 0', async ({ loadedPage: page }) => {
    await play(page);
    await page.waitForTimeout(1000);
    await pause(page);
    const timeBefore = await getPlaybackTime(page);
    expect(timeBefore).toBeGreaterThan(0);

    await skipToStart(page);
    const timeAfter = await getPlaybackTime(page);
    expect(timeAfter).toBeLessThan(1);
  });

  // 3.5 Seek back / forward
  test('3.5 seek back and forward buttons change position', async ({ loadedPage: page }) => {
    await play(page);
    await page.waitForTimeout(1500);
    await pause(page);

    const timeBeforeBack = await getPlaybackTime(page);

    // Seek forward
    await page.evaluate(() => (document.getElementById('seek-fwd') as HTMLElement).click());
    const timeAfterFwd = await getPlaybackTime(page);
    expect(timeAfterFwd).toBeGreaterThan(timeBeforeBack);

    // Seek back
    await page.evaluate(() => (document.getElementById('seek-back') as HTMLElement).click());
    const timeAfterBack = await getPlaybackTime(page);
    expect(timeAfterBack).toBeLessThan(timeAfterFwd);
  });

  // 3.7 Switch active waveform with Arrow Down
  test('3.7 arrow down switches active waveform', async ({ loadedPage: page }) => {
    // Click on the first waveform to make it active
    const wfA = page.locator(`#waveforms .waveform[data-ix="${AUDIO_A}"]`);
    await wfA.click({ position: { x: 50, y: 20 }, force: true });
    await page.waitForTimeout(300);

    const initialActive = await page.evaluate(() =>
      document.querySelector('.waveform.active')?.getAttribute('data-ix'),
    );

    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(300);

    const newActive = await page.evaluate(() =>
      document.querySelector('.waveform.active')?.getAttribute('data-ix'),
    );
    expect(newActive).toBeDefined();
    expect(newActive).not.toBe(initialActive);
  });

  // 3.9 Clicking on a waveform seeks to that position
  test('3.9 clicking on waveform seeks to position', async ({ loadedPage: page }) => {
    await skipToStart(page);

    // Click roughly in the middle of the first visible waveform
    const wf = page.locator(`#waveforms .waveform[data-ix="${AUDIO_A}"]`);
    const box = await wf.boundingBox();
    if (box) {
      await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
      await page.waitForTimeout(300);

      const time = await getPlaybackTime(page);
      expect(time).toBeGreaterThan(0);
    }
  });

});
