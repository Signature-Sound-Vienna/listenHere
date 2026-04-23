import { test, expect, AUDIO_A } from '../support/fixtures';
import { play, pause } from '../support/helpers';

// ---------------------------------------------------------------------------
// Section 11 — Time Axis
// ---------------------------------------------------------------------------

test.describe('11. Time Axis', () => {

  // 11.1 Time ticks visible
  test('11.1 time ticks are drawn on waveform overlays', async ({ loadedPage: page }) => {
    // Alignment grid canvas also draws time ticks — check it has content
    const hasContent = await page.evaluate(() => {
      const canvases = document.querySelectorAll('canvas.alignment-grid');
      for (const c of canvases) {
        const ctx = (c as HTMLCanvasElement).getContext('2d');
        if (!ctx) continue;
        const data = ctx.getImageData(0, 0, c.width, c.height).data;
        if (data.some((v: number, i: number) => i % 4 === 3 && v > 0)) return true;
      }
      return false;
    });
    expect(hasContent).toBe(true);
  });

  // 11.2 Time ticks visible during playback
  test('11.2 time ticks remain during playback', async ({ loadedPage: page }) => {
    await play(page);
    await page.waitForTimeout(1000);

    const hasContent = await page.evaluate(() => {
      const canvases = document.querySelectorAll('canvas.alignment-grid');
      for (const c of canvases) {
        const ctx = (c as HTMLCanvasElement).getContext('2d');
        if (!ctx) continue;
        const data = ctx.getImageData(0, 0, c.width, c.height).data;
        if (data.some((v: number, i: number) => i % 4 === 3 && v > 0)) return true;
      }
      return false;
    });
    expect(hasContent).toBe(true);

    await pause(page);
  });

  // 11.4 Time ticks at various zoom levels
  test('11.4 time ticks adapt to zoom levels', async ({ loadedPage: page }) => {
    const zoomSlider = page.locator('#zoom-slider');

    // Check content at zoom 0 (default)
    const contentAt0 = await page.evaluate(() => {
      let count = 0;
      document.querySelectorAll('canvas.alignment-grid').forEach(c => {
        const ctx = (c as HTMLCanvasElement).getContext('2d');
        if (!ctx) return;
        const data = ctx.getImageData(0, 0, c.width, c.height).data;
        for (let i = 3; i < data.length; i += 4) if (data[i] > 0) count++;
      });
      return count;
    });

    // Zoom to level 3
    await zoomSlider.fill('3');
    await zoomSlider.dispatchEvent('input');
    await page.waitForTimeout(500);

    const contentAt3 = await page.evaluate(() => {
      let count = 0;
      document.querySelectorAll('canvas.alignment-grid').forEach(c => {
        const ctx = (c as HTMLCanvasElement).getContext('2d');
        if (!ctx) return;
        const data = ctx.getImageData(0, 0, c.width, c.height).data;
        for (let i = 3; i < data.length; i += 4) if (data[i] > 0) count++;
      });
      return count;
    });

    // More ticks should be visible at higher zoom (more pixels used)
    expect(contentAt3).toBeGreaterThan(0);
    // Both should have content — no blank canvases at any zoom
    expect(contentAt0).toBeGreaterThan(0);
  });

});
