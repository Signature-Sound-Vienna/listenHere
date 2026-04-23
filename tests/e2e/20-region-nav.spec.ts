import { test, expect, AUDIO_A, AUDIO_B } from '../support/fixtures';

// ---------------------------------------------------------------------------
// Section 20 — Off-screen Annotated Region Navigation Arrows
// ---------------------------------------------------------------------------
// Arrows appear on each zoomed waveform when annotated regions are off-screen
// and scroll the region fully into view (cross-waveform synchronised).

const setZoom = async (page, level: string) => {
  const zoomSlider = page.locator('#zoom-slider');
  await zoomSlider.fill(level);
  await zoomSlider.dispatchEvent('input');
  await page.waitForTimeout(500);
};

const injectRegion = (page, overrides: Record<string, { start: number; end: number }>) =>
  page.evaluate(
    (o) => (window as any)._listenTest.injectTestRegion(o),
    overrides,
  );

const clearRegions = (page) =>
  page.evaluate(() => (window as any)._listenTest.clearTestRegions());

const arrowLeft = (page, fn: string) =>
  page.locator(`#waveforms .waveform[data-ix="${fn}"] .wf-region-nav-left`);
const arrowRight = (page, fn: string) =>
  page.locator(`#waveforms .waveform[data-ix="${fn}"] .wf-region-nav-right`);

const getScroll = (page, fn: string) =>
  page.evaluate((f: string) => {
    const ws = (window as any)._listenTest.wavesurfers[f];
    return ws?.getScroll?.() ?? 0;
  }, fn);

const getDuration = (page, fn: string) =>
  page.evaluate((f: string) => {
    const ws = (window as any)._listenTest.wavesurfers[f];
    return ws?.getDuration?.() ?? 0;
  }, fn);

test.describe('20. Region Navigation Arrows', () => {
  test.afterEach(async ({ page }) => {
    // Ensure injected regions don't leak between tests
    await page.evaluate(() => (window as any)._listenTest?.clearTestRegions?.());
  });

  test('20.1 arrows hidden at zoom level ≤ 1 even with off-screen regions', async ({ loadedPage: page }) => {
    const dur = await getDuration(page, AUDIO_A);
    await injectRegion(page, {
      [AUDIO_A]: { start: dur - 1, end: dur - 0.5 },
      [AUDIO_B]: { start: dur - 1, end: dur - 0.5 },
    });
    // Zoom is 0 by default — arrows must stay hidden
    await expect(arrowLeft(page, AUDIO_A)).toBeHidden();
    await expect(arrowRight(page, AUDIO_A)).toBeHidden();
  });

  test('20.2 right arrow appears when region is off-screen to the right', async ({ loadedPage: page }) => {
    const durA = await getDuration(page, AUDIO_A);
    const durB = await getDuration(page, AUDIO_B);
    // Place region near the end of both waveforms
    await injectRegion(page, {
      [AUDIO_A]: { start: durA - 0.5, end: durA - 0.1 },
      [AUDIO_B]: { start: durB - 0.5, end: durB - 0.1 },
    });
    await setZoom(page, '2'); // well into zoom>1 territory
    await expect(arrowRight(page, AUDIO_A)).toBeVisible();
    await expect(arrowLeft(page, AUDIO_A)).toBeHidden();
  });

  test('20.3 clicking right arrow scrolls region into view', async ({ loadedPage: page }) => {
    const durA = await getDuration(page, AUDIO_A);
    const durB = await getDuration(page, AUDIO_B);
    await injectRegion(page, {
      [AUDIO_A]: { start: durA - 0.5, end: durA - 0.1 },
      [AUDIO_B]: { start: durB - 0.5, end: durB - 0.1 },
    });
    await setZoom(page, '2');

    const scrollBefore = await getScroll(page, AUDIO_A);
    await arrowRight(page, AUDIO_A).click();
    await page.waitForTimeout(300);
    const scrollAfter = await getScroll(page, AUDIO_A);
    expect(scrollAfter).toBeGreaterThan(scrollBefore);

    // Right arrow should now be hidden — region is in view
    await expect(arrowRight(page, AUDIO_A)).toBeHidden();
  });

  test('20.4 click syncs scroll across aligned waveforms', async ({ loadedPage: page }) => {
    const durA = await getDuration(page, AUDIO_A);
    const durB = await getDuration(page, AUDIO_B);
    await injectRegion(page, {
      [AUDIO_A]: { start: durA - 0.5, end: durA - 0.1 },
      [AUDIO_B]: { start: durB - 0.5, end: durB - 0.1 },
    });
    await setZoom(page, '2');

    const scrollBBefore = await getScroll(page, AUDIO_B);
    await arrowRight(page, AUDIO_A).click();
    await page.waitForTimeout(300);
    const scrollBAfter = await getScroll(page, AUDIO_B);
    expect(scrollBAfter).toBeGreaterThan(scrollBBefore);
  });

  test('20.5 arrow badge shows count when multiple regions off-screen', async ({ loadedPage: page }) => {
    const dur = await getDuration(page, AUDIO_A);
    const durB = await getDuration(page, AUDIO_B);
    // Inject two distinct regions both near the end
    await injectRegion(page, {
      [AUDIO_A]: { start: dur - 0.6, end: dur - 0.5 },
      [AUDIO_B]: { start: durB - 0.6, end: durB - 0.5 },
    });
    await injectRegion(page, {
      [AUDIO_A]: { start: dur - 0.3, end: dur - 0.2 },
      [AUDIO_B]: { start: durB - 0.3, end: durB - 0.2 },
    });
    await setZoom(page, '2');
    const badge = arrowRight(page, AUDIO_A).locator('.wf-region-nav-badge');
    await expect(badge).toHaveText('2');
  });

  test('20.6 arrow button is not focusable via Tab', async ({ loadedPage: page }) => {
    const dur = await getDuration(page, AUDIO_A);
    const durB = await getDuration(page, AUDIO_B);
    await injectRegion(page, {
      [AUDIO_A]: { start: dur - 0.3, end: dur - 0.1 },
      [AUDIO_B]: { start: durB - 0.3, end: durB - 0.1 },
    });
    await setZoom(page, '2');
    const tabIndex = await arrowRight(page, AUDIO_A).evaluate(
      (el: HTMLElement) => el.tabIndex,
    );
    expect(tabIndex).toBe(-1);
  });
});
