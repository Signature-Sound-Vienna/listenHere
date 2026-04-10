import { test as base, expect } from '@playwright/test';
import { loadLocalAlignment, showWaveform, waitForWaveformsReady, measureMs } from '../support/helpers';

const AUDIO_A = 'audio-a.mp3';
const AUDIO_B = 'audio-b.mp3';

// Performance thresholds (ms) — generous to avoid CI flakiness
const THRESHOLDS = {
  INITIAL_LOAD: 5_000,        // 16.1: first waveform canvas visible
  ALL_WAVEFORMS_READY: 15_000, // 16.2: all waveforms decoded and ready
  ZOOM_CHANGE: 500,            // 16.3: zoom level change
  TEMPO_CURVE_INIT: 2_000,     // 16.6: tempo curve first render
  MARKER_CYCLE: 200,           // 16.9: 20 × add+remove marker cycle
};

// Perf tests use base test (no custom fixtures — we measure from navigation)
const test = base;

// ---------------------------------------------------------------------------
// Section 16 — Performance Regression Guards
// ---------------------------------------------------------------------------

test.describe('16. Performance Regression Guards', () => {

  // 16.1 Initial load — first waveform visible
  test('16.1 first waveform visible within budget', async ({ page }) => {
    const t0 = Date.now();
    await loadLocalAlignment(page);
    await page.waitForSelector('#waveforms .waveform', { state: 'visible', timeout: THRESHOLDS.INITIAL_LOAD });
    const elapsed = Date.now() - t0;
    console.log(`16.1 Initial load: ${elapsed}ms (threshold: ${THRESHOLDS.INITIAL_LOAD}ms)`);
    expect(elapsed).toBeLessThan(THRESHOLDS.INITIAL_LOAD);
  });

  // 16.2 All waveforms ready
  test('16.2 all waveforms ready within budget', async ({ page }) => {
    await loadLocalAlignment(page);
    await page.waitForLoadState('networkidle');
    await showWaveform(page, AUDIO_A);
    await showWaveform(page, AUDIO_B);

    const t0 = Date.now();
    await waitForWaveformsReady(page, THRESHOLDS.ALL_WAVEFORMS_READY);
    const elapsed = Date.now() - t0;
    console.log(`16.2 All waveforms ready: ${elapsed}ms (threshold: ${THRESHOLDS.ALL_WAVEFORMS_READY}ms)`);
    expect(elapsed).toBeLessThan(THRESHOLDS.ALL_WAVEFORMS_READY);
  });

  // 16.3 Zoom level change
  test('16.3 zoom change completes within budget', async ({ page }) => {
    await loadLocalAlignment(page);
    await page.waitForLoadState('networkidle');
    await showWaveform(page, AUDIO_A);
    await showWaveform(page, AUDIO_B);
    await waitForWaveformsReady(page);

    const elapsed = await measureMs(page, async () => {
      const slider = page.locator('#zoom-slider');
      await slider.fill('3');
      await slider.dispatchEvent('input');
      await page.waitForTimeout(200);
    });

    console.log(`16.3 Zoom change: ${elapsed}ms (threshold: ${THRESHOLDS.ZOOM_CHANGE}ms)`);
    expect(elapsed).toBeLessThan(THRESHOLDS.ZOOM_CHANGE);
  });

  // 16.6 Tempo curve first render
  test('16.6 tempo curve first render within budget', async ({ page }) => {
    await loadLocalAlignment(page);
    await page.waitForLoadState('networkidle');
    await showWaveform(page, AUDIO_A);
    await showWaveform(page, AUDIO_B);
    await waitForWaveformsReady(page);

    const elapsed = await measureMs(page, async () => {
      await page.evaluate(() => {
        const cb = document.getElementById('show-tempo-curve') as HTMLInputElement;
        cb.checked = true;
        cb.dispatchEvent(new Event('change'));
      });
      await page.waitForTimeout(300);
    });

    console.log(`16.6 Tempo curve init: ${elapsed}ms (threshold: ${THRESHOLDS.TEMPO_CURVE_INIT}ms)`);
    expect(elapsed).toBeLessThan(THRESHOLDS.TEMPO_CURVE_INIT);
  });

  // 16.9 Marker add/remove latency
  test('16.9 20 marker add+remove cycles within budget', async ({ page }) => {
    await loadLocalAlignment(page);
    await page.waitForLoadState('networkidle');
    await showWaveform(page, AUDIO_A);
    await waitForWaveformsReady(page);

    // Click waveform to activate it
    const wf = page.locator(`#waveforms .waveform[data-ix="${AUDIO_A}"]`);
    await wf.click({ position: { x: 50, y: 20 }, force: true });
    await page.waitForTimeout(200);

    const elapsed = await measureMs(page, async () => {
      for (let i = 0; i < 20; i++) {
        await page.keyboard.press('m');
        await page.keyboard.press('Control+z');
      }
    });

    console.log(`16.9 Marker cycles: ${elapsed}ms (threshold: ${THRESHOLDS.MARKER_CYCLE}ms)`);
    expect(elapsed).toBeLessThan(THRESHOLDS.MARKER_CYCLE);
  });

});
