// 27. Time measurement (Shift-hold durations, Shift+drag spans)
//
// This feature had no coverage at all until its code moved to
// engine/measure.js, which meant a green suite said nothing about whether the
// gestures still worked. These tests exercise the wiring end to end: the key
// listeners, the hit test over #waveforms, and the overlay visuals.
import { test, expect } from '../support/fixtures';
import { play, pause } from '../support/helpers';

const AUDIO_A = 'audio-a.mp3';

/** Place `n` markers at successive playback positions. */
async function placeMarkers(page: import('@playwright/test').Page, n: number) {
  for (let i = 0; i < n; i++) {
    await play(page);
    await page.waitForTimeout(700);
    await pause(page);
    await page.keyboard.press('m');
    await page.waitForTimeout(200);
  }
  await expect.poll(() => page.locator('.ws-marker').count()).toBeGreaterThanOrEqual(n);
}

test.describe('27. Time measurement', () => {
  // 27.1 Shift-hold labels the gap between consecutive markers, and releasing clears it
  test('27.1 Shift-hold shows marker durations and releases cleanly', async ({ loadedPage: page }) => {
    await placeMarkers(page, 2);

    await expect(page.locator('.measure-label')).toHaveCount(0);

    await page.keyboard.down('Shift');
    await expect
      .poll(() => page.locator('.measure-label').count(), { timeout: 5_000 })
      .toBeGreaterThan(0);
    // spans accompany the labels, and both project onto every loaded waveform
    expect(await page.locator('.measure-span').count()).toBeGreaterThan(0);
    // a duration reads as seconds or m:ss, never empty
    expect(await page.locator('.measure-label').first().textContent()).toMatch(/^\d+(\.\d+)?s$|^\d+:\d/);

    await page.keyboard.up('Shift');
    await expect(page.locator('.measure-label')).toHaveCount(0);
    await expect(page.locator('.measure-span')).toHaveCount(0);
  });

  // 27.2 Shift+drag measures an arbitrary span; visuals persist past mouseup,
  // then clear when Shift is released
  test('27.2 Shift+drag draws a measurement span that persists until Shift is up', async ({ loadedPage: page }) => {
    const wf = page.locator(`#waveforms .waveform[data-ix="${AUDIO_A}"]`);
    const box = await wf.boundingBox();
    expect(box).not.toBeNull();
    const y = box!.y + box!.height / 2;

    await page.keyboard.down('Shift');
    await page.mouse.move(box!.x + box!.width * 0.2, y);
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width * 0.6, y, { steps: 8 });

    await expect
      .poll(() => page.locator('.measure-drag-span').count(), { timeout: 5_000 })
      .toBeGreaterThan(0);
    expect(await page.locator('.measure-drag-label').count()).toBeGreaterThan(0);

    // mouseup deliberately keeps the visuals — you read the number after dragging
    await page.mouse.up();
    await page.waitForTimeout(300);
    expect(await page.locator('.measure-drag-span').count()).toBeGreaterThan(0);

    await page.keyboard.up('Shift');
    await expect(page.locator('.measure-drag-span')).toHaveCount(0);
    await expect(page.locator('.measure-drag-label')).toHaveCount(0);
  });
  // 27.3 align-correction mode owns Shift for its influence zone, so
  // measurement must stay out of the way. This is the one behaviour whose shape
  // changed in the extraction: the flag used to be read directly, and is now an
  // injected `isSuppressed` predicate.
  test('27.3 Shift does not measure while Fix alignment is armed', async ({ loadedPage: page }) => {
    await placeMarkers(page, 2);

    await page.locator('#drag-markers-cb').check({ force: true });
    await page.locator('#drag-mode-fix').check({ force: true });
    await page.waitForTimeout(300);

    await page.keyboard.down('Shift');
    await page.waitForTimeout(600);
    await expect(page.locator('.measure-label')).toHaveCount(0);
    await expect(page.locator('.measure-span')).toHaveCount(0);
    await page.keyboard.up('Shift');

    // and it measures again once Fix alignment is disarmed
    await page.locator('#drag-markers-cb').uncheck({ force: true });
    await page.waitForTimeout(300);
    await page.keyboard.down('Shift');
    await expect
      .poll(() => page.locator('.measure-label').count(), { timeout: 5_000 })
      .toBeGreaterThan(0);
    await page.keyboard.up('Shift');
  });

});
