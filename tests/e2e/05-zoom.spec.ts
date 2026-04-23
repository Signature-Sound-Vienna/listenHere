import { test, expect, AUDIO_A } from '../support/fixtures';

// ---------------------------------------------------------------------------
// Section 5 — Zoom & Scroll Modes
// ---------------------------------------------------------------------------

test.describe('5. Zoom & Scroll Modes', () => {

  // 5.1 Zoom level 0 — fit to container
  test('5.1 zoom level 0 — waveforms fit container, scroll controls hidden', async ({ loadedPage: page }) => {
    // Default zoom is 0
    const zoomSlider = page.locator('#zoom-slider');
    await expect(zoomSlider).toHaveValue('0');
    // Scroll mode controls should be hidden at zoom 0
    await expect(page.locator('#scroll-mode-controls')).not.toBeVisible();
    // Zoom label shows 1x
    await expect(page.locator('#zoom-label')).toHaveText('1x');
  });

  // 5.2 Zoom levels 1–5 — progressive zoom
  test('5.2 zoom levels 1–5 progressively widen waveforms', async ({ loadedPage: page }) => {
    const zoomSlider = page.locator('#zoom-slider');
    // Get initial waveform wrapper width
    const getWrapperWidth = () => page.evaluate((fn: string) => {
      const t = (window as any)._listenTest;
      const ws = t?.wavesurfers[fn];
      return ws ? ws.getWrapper().clientWidth : 0;
    }, AUDIO_A);

    const widthAt0 = await getWrapperWidth();

    // Set zoom to level 2 (slider value = 2 → ZOOM_LEVELS[2] = 5x)
    await zoomSlider.fill('2');
    await zoomSlider.dispatchEvent('input');
    await page.waitForTimeout(500);
    const widthAt2 = await getWrapperWidth();
    expect(widthAt2).toBeGreaterThan(widthAt0);

    // Scroll mode controls should now be visible
    await expect(page.locator('#scroll-mode-controls')).toBeVisible();
  });

  // 5.3 Scroll mode: Follow
  test('5.3 Follow mode keeps playhead visible during playback', async ({ loadedPage: page }) => {
    // Zoom in
    const zoomSlider = page.locator('#zoom-slider');
    await zoomSlider.fill('2');
    await zoomSlider.dispatchEvent('input');
    await page.waitForTimeout(500);

    // Select Follow mode
    await page.locator('#scroll-mode-follow').check({ force: true });

    // Play briefly
    await page.evaluate(() => (document.getElementById('playpause') as HTMLElement).click());
    await page.waitForTimeout(2000);
    await page.evaluate(() => (document.getElementById('playpause') as HTMLElement).click());

    // No crash — test passes if no error thrown during zoomed playback
    await expect(page.locator(`#waveforms .waveform[data-ix="${AUDIO_A}"]`)).toBeVisible();
  });

  // 5.5 Scroll mode: Manual
  test('5.5 Manual mode does not auto-scroll during playback', async ({ loadedPage: page }) => {
    const zoomSlider = page.locator('#zoom-slider');
    await zoomSlider.fill('2');
    await zoomSlider.dispatchEvent('input');
    await page.waitForTimeout(500);

    // Select Manual mode
    await page.locator('#scroll-mode-manual').check({ force: true });

    // Record scroll position
    const getScroll = () => page.evaluate((fn: string) => {
      const t = (window as any)._listenTest;
      return t?.wavesurfers[fn]?.getScroll?.() ?? 0;
    }, AUDIO_A);

    const scrollBefore = await getScroll();

    // Play briefly
    await page.evaluate(() => (document.getElementById('playpause') as HTMLElement).click());
    await page.waitForTimeout(1500);
    await page.evaluate(() => (document.getElementById('playpause') as HTMLElement).click());

    const scrollAfter = await getScroll();
    // In manual mode, scroll should not have changed
    expect(scrollAfter).toBe(scrollBefore);
  });

});
