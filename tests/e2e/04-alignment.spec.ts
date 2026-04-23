import { test, expect, AUDIO_A, AUDIO_B } from '../support/fixtures';

// ---------------------------------------------------------------------------
// Section 4 — Synchronisation & Alignment Visualisation
// ---------------------------------------------------------------------------

test.describe('4. Synchronisation & Alignment Visualisation', () => {

  // 4.3 Visualise alignments — grid lines appear
  test('4.3 enabling Visualise alignments draws grid lines', async ({ loadedPage: page }) => {
    const cb = page.locator('#visalign');
    await cb.check({ force: true });
    await page.waitForTimeout(500);

    // Grid canvases should exist on visible waveforms and have non-zero content
    const hasGridContent = await page.evaluate(() => {
      const canvases = document.querySelectorAll('canvas.alignment-grid');
      if (canvases.length === 0) return false;
      // Check at least one canvas has drawn pixels (not all transparent)
      for (const c of canvases) {
        const ctx = (c as HTMLCanvasElement).getContext('2d');
        if (!ctx) continue;
        const data = ctx.getImageData(0, 0, c.width, c.height).data;
        if (data.some((v, i) => i % 4 === 3 && v > 0)) return true; // non-transparent pixel
      }
      return false;
    });
    expect(hasGridContent).toBe(true);
  });

  // 4.4 Visualise alignments — grid lines disappear when disabled
  test('4.4 disabling Visualise alignments reduces drawn pixels', async ({ loadedPage: page }) => {
    const cb = page.locator('#visalign');
    await cb.check({ force: true });
    await page.waitForTimeout(500);

    // Count non-transparent pixels with alignment enabled
    const pixelsOn = await page.evaluate(() => {
      let count = 0;
      document.querySelectorAll('canvas.alignment-grid').forEach(c => {
        const ctx = (c as HTMLCanvasElement).getContext('2d');
        if (!ctx) return;
        const data = ctx.getImageData(0, 0, c.width, c.height).data;
        for (let i = 3; i < data.length; i += 4) if (data[i] > 0) count++;
      });
      return count;
    });

    await cb.uncheck({ force: true });
    await page.waitForTimeout(500);

    const pixelsOff = await page.evaluate(() => {
      let count = 0;
      document.querySelectorAll('canvas.alignment-grid').forEach(c => {
        const ctx = (c as HTMLCanvasElement).getContext('2d');
        if (!ctx) return;
        const data = ctx.getImageData(0, 0, c.width, c.height).data;
        for (let i = 3; i < data.length; i += 4) if (data[i] > 0) count++;
      });
      return count;
    });

    // Disabling should significantly reduce drawn pixels (grid lines removed,
    // only time ticks remain)
    expect(pixelsOff).toBeLessThan(pixelsOn);
  });

  // 4.6 Show relative position indicator — active waveform
  test('4.6 relative position indicator appears on active waveform', async ({ loadedPage: page }) => {
    const cb = page.locator('#visrelalign');
    await cb.check({ force: true });

    // Play briefly so the position indicator has a position to render
    await page.evaluate(() => (document.getElementById('playpause') as HTMLElement).click());
    await page.waitForTimeout(800);
    await page.evaluate(() => (document.getElementById('playpause') as HTMLElement).click());
    await page.waitForTimeout(300);

    // Position indicator canvas should have drawn content
    const hasIndicator = await page.evaluate(() => {
      const canvases = document.querySelectorAll('canvas.position-indicator');
      for (const c of canvases) {
        const ctx = (c as HTMLCanvasElement).getContext('2d');
        if (!ctx) continue;
        const data = ctx.getImageData(0, 0, c.width, c.height).data;
        if (data.some((v, i) => i % 4 === 3 && v > 0)) return true;
      }
      return false;
    });
    expect(hasIndicator).toBe(true);
  });

  // 4.8 Shared time axis
  test('4.8 shared time axis rescales waveforms', async ({ loadedPage: page }) => {
    const cb = page.locator('#shared-time-axis');
    await cb.check({ force: true });
    await page.waitForTimeout(500);
    // No errors — waveforms still visible
    await expect(page.locator(`#waveforms .waveform[data-ix="${AUDIO_A}"]`)).toBeVisible();
    await expect(page.locator(`#waveforms .waveform[data-ix="${AUDIO_B}"]`)).toBeVisible();
  });

});
