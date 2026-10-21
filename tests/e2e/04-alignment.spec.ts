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

  // 4.10 The relative position indicator takes the alignment style: To next,
  // each one's bottom tip meets the next visible one's position; To
  // reference, every top and bottom tip is the same reference position.
  test('4.10 relative position indicators run on to the next waveform, or share one reference position', async ({ loadedPage: page }) => {
    await page.locator('#visrelalign').check({ force: true });
    await expect(page.locator('#visalign-options')).toBeVisible();
    await page.evaluate(() => {
      const t = (window as any)._listenTest;
      const cur = t.currentAudioIx || Object.keys(t.wavesurfers)[0];
      t.swapCurrentAudio(cur);
      t.wavesurfers[cur].setTime(30);
    });
    await page.waitForTimeout(500);

    /** Per visible row: the indicator's mean x at its top, middle and bottom
     *  pixel rows, in page coordinates. */
    const read = () =>
      page.evaluate(() => {
        const rows = [...document.querySelectorAll('#waveforms .waveform[data-ix]')].filter(
          (e) => e.getClientRects().length,
        );
        const at = (c: HTMLCanvasElement, y: number) => {
          const d = c.getContext('2d')!.getImageData(0, y, c.width, 1).data;
          const xs: number[] = [];
          for (let x = 0; x < c.width; x++) if (d[x * 4 + 3] > 60) xs.push(x);
          const left = c.getBoundingClientRect().left;
          return xs.length ? left + xs.reduce((a, b) => a + b, 0) / xs.length : null;
        };
        return rows.map((r) => {
          const c = r.querySelector('canvas.position-indicator') as HTMLCanvasElement;
          return { top: at(c, 0), mid: at(c, Math.floor(c.height / 2)), bottom: at(c, c.height - 1) };
        });
      });

    // A row whose position sits at its canvas edge (the fixture's 5 s
    // audio-short lands at x ≈ 1 here) draws too little to measure: skipped.
    const next = await read();
    let checked = 0;
    for (let k = 0; k < next.length; k++) {
      const below = next[k + 1] ?? next[k];
      if (next[k].mid === null || below.mid === null) continue;
      expect(Math.abs(next[k].top! - next[k].mid!), `row ${k} top`).toBeLessThan(2);
      expect(Math.abs(next[k].bottom! - below.mid!), `row ${k} bottom`).toBeLessThan(2.5);
      checked++;
    }
    expect(checked).toBeGreaterThanOrEqual(2);

    await page.locator('#visalign-mode-reference').check({ force: true });
    await page.waitForTimeout(300);
    const ref = await read();
    // A shallow slant (a position far from the tip) widens its tip's pixel row
    // and biases the mean towards the slant, so the check is the median, with
    // one row's two tips allowed to stray.
    const tips = ref
      .flatMap((r) => [r.top, r.bottom])
      .filter((x): x is number => x !== null)
      .sort((a, b) => a - b);
    expect(tips.length).toBeGreaterThanOrEqual(4);
    const median = tips[Math.floor(tips.length / 2)];
    expect(tips.filter((x) => Math.abs(x - median) < 1.5).length).toBeGreaterThanOrEqual(tips.length - 2);
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

  // 4.9 Visualise alignments, To next: each waveform's lines run on to the
  // waveform below; the lowest visible one's are vertical; hiding relinks.
  test('4.9 alignment lines run on to the next visible waveform, the lowest is vertical, and hiding one relinks its neighbours', async ({ loadedPage: page }) => {
    await page.locator('#visalign').check({ force: true });
    await expect(page.locator('#visalign-options')).toBeVisible();
    await expect(page.locator('#visalign-mode-next')).toBeChecked();
    await page.waitForTimeout(500);

    /** Per visible row: its link, and how many of the lines at the top of the
     *  row below (or, for the lowest row, at its own top) a line of this row
     *  meets at its canvas bottom. Checked from below: a steep slant crosses
     *  the bottom pixel row over many columns, an end over one. */
    const read = () =>
      page.evaluate(async () => {
        const wv = await import('/static/js/engine/waveform-view.js');
        const rows = [...document.querySelectorAll('#waveforms .waveform[data-ix]')].filter(
          (e) => e.getClientRects().length,
        ) as HTMLElement[];
        const cols = (c: HTMLCanvasElement, y: number) => {
          const d = c.getContext('2d')!.getImageData(0, y, c.width, 1).data;
          const xs: number[] = [];
          for (let x = 0; x < c.width; x++) if (d[x * 4 + 3] > 20) xs.push(x);
          return xs;
        };
        return rows.map((r, k) => {
          const a = r.querySelector('canvas.alignment-grid') as HTMLCanvasElement;
          const below = rows[k + 1]?.querySelector('canvas.alignment-grid') as HTMLCanvasElement | undefined;
          const b = below ?? a;
          const dx = below ? Math.round(b.getBoundingClientRect().left - a.getBoundingClientRect().left) : 0;
          const bottom = new Set(cols(a, a.height - 1));
          const top = cols(b, Math.floor(b.height / 6) - 2).map((x) => x + dx);
          const hit = top.filter((x) => bottom.has(x) || bottom.has(x - 1) || bottom.has(x + 1)).length;
          return {
            ix: r.dataset.ix,
            next: (wv as any).waveformViews[r.dataset.ix!].visalignNext,
            top: top.length,
            hit,
          };
        });
      });

    let rows = await read();
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (let k = 0; k < rows.length; k++) {
      expect(rows[k].next, rows[k].ix).toBe(rows[k + 1]?.ix ?? null);
      expect(rows[k].top, rows[k].ix).toBeGreaterThan(0);
      expect(rows[k].hit / rows[k].top, rows[k].ix).toBeGreaterThan(0.9);
    }

    // Hide the lowest row: the one above it is now the lowest, and vertical.
    const lowest = rows[rows.length - 1].ix;
    await page.locator(`[id="${lowest}"] input[type=checkbox]`).first().click({ force: true });
    await page.waitForTimeout(800);
    rows = await read();
    expect(rows.map((r) => r.ix)).not.toContain(lowest);
    const last = rows[rows.length - 1];
    expect(last.next).toBeNull();
    expect(last.hit / last.top).toBeGreaterThan(0.9);
  });

});
