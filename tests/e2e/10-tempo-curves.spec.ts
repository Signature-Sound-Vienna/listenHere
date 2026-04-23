import { test, expect, AUDIO_A } from '../support/fixtures';

// ---------------------------------------------------------------------------
// Section 10 — Tempo Curves
// ---------------------------------------------------------------------------

test.describe('10. Tempo Curves', () => {

  // Helper: check if a canvas has non-transparent pixels
  async function canvasHasContent(page: import('@playwright/test').Page, selector: string): Promise<boolean> {
    return page.evaluate((sel) => {
      const canvases = document.querySelectorAll(sel);
      for (const c of canvases) {
        const ctx = (c as HTMLCanvasElement).getContext('2d');
        if (!ctx) continue;
        const data = ctx.getImageData(0, 0, c.width, c.height).data;
        if (data.some((v: number, i: number) => i % 4 === 3 && v > 0)) return true;
      }
      return false;
    }, selector);
  }

  // 10.1 Tempo curve enabled — QPM mode
  test('10.1 enabling tempo curve in QPM mode draws overlay', async ({ loadedPage: page }) => {
    const cb = page.locator('#show-tempo-curve');
    await cb.check({ force: true });
    await page.waitForTimeout(500);

    // Tempo curve options should appear
    await expect(page.locator('#tempo-curve-options')).toBeVisible();

    // QPM mode is default — canvas should have content
    const hasContent = await canvasHasContent(page, 'canvas.tempo-curve');
    expect(hasContent).toBe(true);
  });

  // 10.2 Tempo curve — Deviation mode
  test('10.2 switching to Deviation mode shows scope controls', async ({ loadedPage: page }) => {
    const cb = page.locator('#show-tempo-curve');
    await cb.check({ force: true });
    await page.waitForTimeout(300);

    // Switch to deviation mode
    await page.locator('#tempo-mode-relative').check({ force: true });
    await page.waitForTimeout(500);

    // Scope controls should be visible in deviation mode
    await expect(page.locator('#tempo-scope-controls')).toBeVisible();

    // Canvas should still have content
    const hasContent = await canvasHasContent(page, 'canvas.tempo-curve');
    expect(hasContent).toBe(true);
  });

  // 10.3 Scope controls hidden in QPM mode
  test('10.3 scope controls hidden in QPM mode', async ({ loadedPage: page }) => {
    const cb = page.locator('#show-tempo-curve');
    await cb.check({ force: true });
    await page.waitForTimeout(300);

    // QPM (absolute) is the default
    await expect(page.locator('#tempo-mode-absolute')).toBeChecked();
    await expect(page.locator('#tempo-scope-controls')).not.toBeVisible();
  });

  // 10.5 Smoothing slider
  test('10.5 smoothing slider changes curve appearance', async ({ loadedPage: page }) => {
    const cb = page.locator('#show-tempo-curve');
    await cb.check({ force: true });
    await page.waitForTimeout(500);

    // Count pixels at smoothing=0
    const pixelsAt0 = await page.evaluate(() => {
      let count = 0;
      document.querySelectorAll('canvas.tempo-curve').forEach(c => {
        const ctx = (c as HTMLCanvasElement).getContext('2d');
        if (!ctx) return;
        const data = ctx.getImageData(0, 0, c.width, c.height).data;
        for (let i = 3; i < data.length; i += 4) if (data[i] > 0) count++;
      });
      return count;
    });

    // Set smoothing to 5
    const slider = page.locator('#tempo-smoothing');
    await slider.fill('5');
    await slider.dispatchEvent('input');
    await page.waitForTimeout(500);

    const pixelsAt5 = await page.evaluate(() => {
      let count = 0;
      document.querySelectorAll('canvas.tempo-curve').forEach(c => {
        const ctx = (c as HTMLCanvasElement).getContext('2d');
        if (!ctx) return;
        const data = ctx.getImageData(0, 0, c.width, c.height).data;
        for (let i = 3; i < data.length; i += 4) if (data[i] > 0) count++;
      });
      return count;
    });

    // Smoothing changes the rendering — pixel count should differ
    expect(pixelsAt5).not.toBe(pixelsAt0);
  });

});
