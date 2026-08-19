// 28. Refitting waveforms when the container width changes
//
// applyZoom fits a waveform with ws.zoom(containerWidth / duration), which pins
// WaveSurfer's minPxPerSec to the width it saw at that moment. WaveSurfer's own
// ResizeObserver keeps rerendering after a later resize, but at the pinned rate —
// so the rendered content stays at the OLD width. At zoom 1 that leaves content
// wider than its container, the scroll container stays scrollable, and any parked
// scrollLeft strands the waveform in a slice WaveSurfer never rendered: a blank
// waveform whose time axis starts near the end of the recording, while playback
// carries on normally.
//
// Reported from a live session (blank waveforms after opening devtools, which
// narrows the viewport). Reproduced in both browsers and confirmed present before
// the Phase-1 cluster-L refactor, so it is long-standing rather than a regression.
//
// One observation from that session is NOT covered here: its waveforms were stuck
// at several DIFFERENT stale widths (938, 1561, 4241, 5994) rather than one shared
// value, which a single pinned rate does not explain on its own. Refitting on
// resize repairs that state whatever produced it, but the cause is still open.
import { test, expect } from '../support/fixtures';

type WfWidths = { file: string; scrollW: number; clientW: number; scrollLeft: number };

/** Rendered vs visible width of every waveform's scroll container. */
async function widths(page: import('@playwright/test').Page): Promise<WfWidths[]> {
  return page.evaluate(() => {
    const t = (window as any)._listenTest;
    return Object.keys(t.wavesurfers).map((fn) => {
      const sc = t.wavesurfers[fn].getWrapper().parentElement as HTMLElement;
      return {
        file: fn,
        scrollW: sc.scrollWidth,
        clientW: sc.clientWidth,
        scrollLeft: Math.round(sc.scrollLeft),
      };
    });
  });
}

/** Resolve once every waveform's geometry has stopped moving. Zoom and resize
 *  both settle asynchronously (WaveSurfer rerenders via its own ResizeObserver),
 *  so wait for two identical readings rather than guessing a duration. */
async function settled(page: import('@playwright/test').Page, timeout = 15_000) {
  let previous = '';
  await expect
    .poll(
      async () => {
        const now = JSON.stringify(await widths(page));
        const stable = now === previous;
        previous = now;
        return stable;
      },
      { timeout, intervals: [100] },
    )
    .toBe(true);
}

async function setZoom(page: import('@playwright/test').Page, value: string) {
  const slider = page.locator('#zoom-slider');
  await slider.fill(value);
  await slider.dispatchEvent('input');
  await settled(page);
}

/** Content wider than its container is only legitimate above zoom 1. */
function overflowing(rows: WfWidths[]): WfWidths[] {
  return rows.filter((r) => r.scrollW > r.clientW + 2);
}

test.describe('28. Refitting on container resize', () => {
  // 28.1 The reported failure: zoom leaves minPxPerSec pinned, so a later
  // narrowing must still refit rather than keep the stale render width.
  test('28.1 narrowing the viewport after a zoom cycle refits every waveform', async ({
    loadedPage: page,
  }) => {
    await setZoom(page, '3');
    await setZoom(page, '0');

    await page.setViewportSize({ width: 720, height: 720 });
    await settled(page);

    // Polled, not slept: still fails if the refit never lands, but returns as
    // soon as it does. The final assertion keeps the diagnostic message.
    await expect
      .poll(async () => overflowing(await widths(page)).length, { timeout: 15_000 })
      .toBe(0);

    const rows = await widths(page);
    const stale = overflowing(rows);
    expect(
      stale,
      `at zoom 1 the render must fit its container: ${stale
        .map((s) => `${s.file} ${s.scrollW}>${s.clientW}`)
        .join('; ')}`,
    ).toEqual([]);
  });

  // 28.2 Widening does NOT currently fail: with fillParent, WaveSurfer renders at
  // max(container, pinned rate), so a wider container still fills correctly. This
  // is a guard for that asymmetry, not a fail-before control — only 28.1 is.
  test('28.2 widening the viewport after a zoom cycle refits every waveform', async ({
    loadedPage: page,
  }) => {
    await setZoom(page, '2');
    await setZoom(page, '0');

    await page.setViewportSize({ width: 1600, height: 900 });
    await settled(page);

    await expect
      .poll(
        async () =>
          Math.max(...(await widths(page)).map((r) => Math.abs(r.scrollW - r.clientW))),
        { timeout: 15_000 },
      )
      .toBeLessThanOrEqual(2);

    const rows = await widths(page);
    for (const r of rows) {
      expect(
        Math.abs(r.scrollW - r.clientW),
        `${r.file} should fill its container after widening (${r.scrollW} vs ${r.clientW})`,
      ).toBeLessThanOrEqual(2);
    }
  });

});
