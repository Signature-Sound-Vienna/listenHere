import { test, expect, type Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Section 48 — Alpha-tester feedback, 2026-09-10 (0.58.0)
//
//   1. THE AUDIBLE STRIP, LOUDER (?activeStrip): four variants, the shipped
//      look the default; each marks the active strip and nothing else.
//   2. THE SWITCH CUE (?switchCue=arrow): a switch a viewport did not make —
//      the other side's take, or one nobody's (the attract loop calls the
//      transport directly) — draws an arrow on that viewport; the taker's own
//      viewport gets nothing. Off by default.
//   3. THE DEMO BUTTON: the study panel starts the attract loop at once, and
//      the panel's own taps do not end it.
//
// The transport is spec 36's quiet stand-in (select records, never plays).
// ---------------------------------------------------------------------------

async function boot(page: Page, qs = 'debug=1') {
  await page.goto(`/exhibit?${qs}`);
  const ok = await page.evaluate(() => (window as any)._exhibitTest.ready);
  expect(ok, 'exhibit boot promise resolved falsy — see console for the error').toBe(true);
  return page.evaluate(() => {
    const T = (window as any)._exhibitTest;
    return { order: T.exhibit.order as string[], ref: T.exhibit.piece.ref as string };
  });
}

async function armQuietTransport(page: Page) {
  await page.evaluate(() => {
    const T = (window as any)._exhibitTest;
    (window as any)._taps = [];
    const orig = T.transport.select.bind(T.transport);
    T.transport.select = (file: string, time: number) => {
      (window as any)._taps.push({ file, time });
      return orig(file, time, false);
    };
    (window as any)._playing = false;
    Object.defineProperty(T.transport, 'playing', { get: () => (window as any)._playing, configurable: true });
  });
}

/** Per viewport: which strip is active, its box-shadow, and whether the bars show. */
async function activeLook(page: Page, viewport: number) {
  return page.evaluate((v) => {
    const vp = document.querySelector(`.vp[data-viewport="${v}"]`) as HTMLElement;
    const active = vp.querySelector('.strip.is-active') as HTMLElement | null;
    const others = [...vp.querySelectorAll('.strip:not(.is-active)')] as HTMLElement[];
    const bars = (el: HTMLElement) => getComputedStyle(el.querySelector('.strip-live') as HTMLElement).display;
    return {
      variant: vp.dataset.activeStrip,
      file: active?.dataset.file ?? null,
      shadow: active ? getComputedStyle(active).boxShadow : null,
      bars: active ? bars(active) : null,
      othersWithShadow: others.filter((o) => getComputedStyle(o).boxShadow !== 'none').length,
      othersWithBars: others.filter((o) => bars(o) !== 'none').length,
    };
  }, viewport);
}

async function cues(page: Page, viewport: number) {
  return page.evaluate(
    (v) => document.querySelectorAll(`.vp[data-viewport="${v}"] .switch-cue g.cue`).length,
    viewport,
  );
}

test.describe('48. Alpha-tester feedback: salience and the switch cue', () => {
  test.use({ viewport: { width: 1024, height: 1366 } });

  // 48.1 The defaults: the shipped look, no cue.
  test('48.1 by default the audible strip keeps the shipped look and no switch is cued', async ({ page }) => {
    const { order, ref } = await boot(page);
    await armQuietTransport(page);
    const [a] = order.filter((f) => f !== ref);
    await page.evaluate((f) => (window as any)._exhibitTest.transport.select(f), a);
    const look = await activeLook(page, 0);
    expect(look.variant).toBe('surface');
    expect(look.file).toBe(a);
    expect(look.shadow).toBe('none');
    expect(look.bars).toBe('none');
    expect(await page.locator('.switch-cue').count()).toBe(0);
    expect(await page.evaluate(() => (window as any)._exhibitTest.config.switchCue)).toBe('off');
  });

  // 48.2 Each variant marks the active strip, and only it.
  for (const variant of ['edge', 'glow', 'bars'] as const) {
    test(`48.2 ?activeStrip=${variant} marks the audible strip and nothing else`, async ({ page }) => {
      const { order, ref } = await boot(page, `debug=1&activeStrip=${variant}`);
      await armQuietTransport(page);
      const [a] = order.filter((f) => f !== ref);
      // A direct select: active but not selected, so the shadow is the variant's alone.
      await page.evaluate((f) => (window as any)._exhibitTest.transport.select(f), a);
      for (const v of [0, 1]) {
        const look = await activeLook(page, v);
        expect(look.variant, `viewport ${v}`).toBe(variant);
        expect(look.file).toBe(a);
        if (variant === 'bars') {
          expect(look.bars).toBe('inline-flex');
          expect(look.shadow).toBe('none');
        } else {
          expect(look.shadow).not.toBe('none');
          expect(look.bars).toBe('none');
        }
        expect(look.othersWithShadow).toBe(0);
        expect(look.othersWithBars).toBe(0);
      }
      // The bars move only while the clock runs: the flag follows the transport.
      if (variant === 'bars') {
        expect(await page.evaluate(() => document.getElementById('screen')!.dataset.playing)).toBe('false');
      }
    });
  }

  // 48.3 The cue's attribution: a side's own take draws nothing on its
  // viewport and an arrow on the other; a switch nobody made draws on both.
  test('48.3 with ?switchCue=arrow a take is cued on the other side only, and a switch nobody made on both', async ({
    page,
  }) => {
    const { order, ref } = await boot(page, 'debug=1&switchCue=arrow');
    await armQuietTransport(page);
    const [a, b, c] = order.filter((f) => f !== ref);
    // From the resting reference to a: viewport 0's own take.
    await page.evaluate((f) => (window as any)._exhibitTest.turns.request(0, f), a);
    expect(await cues(page, 0), "the taker's own viewport").toBe(0);
    expect(await cues(page, 1), 'the other viewport').toBe(1);
    // Viewport 1 takes b: the mirror image.
    await page.evaluate((f) => (window as any)._exhibitTest.turns.request(1, f), b);
    expect(await cues(page, 0)).toBe(1);
    expect(await cues(page, 1)).toBe(1);
    // Nobody's switch (the attract loop's path): both sides are shown.
    await page.evaluate((f) => (window as any)._exhibitTest.transport.select(f), c);
    expect(await cues(page, 0)).toBe(2);
    expect(await cues(page, 1)).toBe(2);
    // The arrows are transient — and so is the overlay itself: nothing may be left
    // over the strips once the last arrow has gone (the far half's jitter, 2026-09-10).
    await expect.poll(() => cues(page, 0), { timeout: 5_000 }).toBe(0);
    await expect.poll(() => cues(page, 1), { timeout: 5_000 }).toBe(0);
    await expect.poll(() => page.locator('.switch-cue').count(), { timeout: 3_000 }).toBe(0);
    // The geometry: a path with a head, drawn in the strip stack's overlay.
    await page.evaluate((f) => (window as any)._exhibitTest.transport.select(f), a);
    const shape = await page.evaluate(() => {
      const g = document.querySelector('.vp[data-viewport="0"] .switch-cue g.cue')!;
      const d = g.querySelector('path:not(.cue-head)')!.getAttribute('d')!;
      return { hasCurve: d.startsWith('M') && d.includes('C'), head: !!g.querySelector('.cue-head'), dot: !!g.querySelector('.cue-dot') };
    });
    expect(shape).toEqual({ hasCurve: true, head: true, dot: true });
  });

  // 48.6 A time jump within the same recording is cued like a switch: from the
  // position that was playing to the new one, an arch over the strip; the
  // seeker's own viewport gets nothing, and playback frames never count. A
  // direct seek within 2.5 s of a side's take is attributed to that side (the
  // window covers the transport's asynchronous select), so the "nobody's" seek
  // waits the window out first.
  test('48.6 a jump within the same recording is cued on the other side, as an arch from the old position', async ({ page }) => {
    const { order, ref } = await boot(page, 'debug=1&switchCue=arrow');
    await armQuietTransport(page);
    const [a] = order.filter((f) => f !== ref);
    await page.evaluate((f) => (window as any)._exhibitTest.turns.request(0, f), a);
    await page.waitForTimeout(2600); // the attribution window, and the switch's arrow
    await expect.poll(() => cues(page, 1), { timeout: 3_000 }).toBe(0);
    // Viewport 0 seeks its own recording to 60 s: a jump, cued on viewport 1 only.
    await page.evaluate((f) => (window as any)._exhibitTest.turns.request(0, f, 60), a);
    expect(await cues(page, 0)).toBe(0);
    expect(await cues(page, 1)).toBe(1);
    const shape = await page.evaluate(() => {
      const el = document.querySelector('.vp[data-viewport="1"] .switch-cue g.cue')!;
      const d = el.querySelector('.cue-line')!.getAttribute('d')!;
      const nums = d.match(/-?[\d.]+/g)!.map(Number); // M x1 y1 C c1x c1y c2x c2y x2 y2
      return { d, sameRow: nums[1] === nums[7], arches: nums[3] < nums[1] && nums[5] < nums[1], moved: Math.abs(nums[6] - nums[0]) > 20 };
    });
    expect(shape.sameRow, shape.d).toBe(true);
    expect(shape.arches, shape.d).toBe(true);
    expect(shape.moved, shape.d).toBe(true);
    // Once the window has lapsed, a direct seek is nobody's and both sides are shown.
    await page.waitForTimeout(2600);
    await expect.poll(() => cues(page, 1), { timeout: 3_000 }).toBe(0);
    await page.evaluate(() => (window as any)._exhibitTest.transport.seek(120));
    expect(await cues(page, 0)).toBe(1);
    expect(await cues(page, 1)).toBe(1);
    // A sub-second step is playback, not a jump: nothing new.
    await page.evaluate(() => (window as any)._exhibitTest.transport.seek(120.4));
    expect(await cues(page, 0)).toBe(1);
    expect(await cues(page, 1)).toBe(1);
  });

  // 48.4 The demo button starts the loop now; the panel's taps do not end it.
  test('48.4 the study panel starts the attract loop on demand, and operating the panel does not end it', async ({ page }) => {
    await boot(page, 'debug=1&studyPanel=true&attractAfterIdleMs=90000');
    await armQuietTransport(page);
    await page.click('.study-cog');
    await page.click('.study-tab[data-tab="attract"]');
    await page.click('.study-action[data-action="attractNow"]');
    await expect.poll(() => page.evaluate(() => (window as any)._exhibitTest.attract.state().phase)).toBe('attract');
    await expect(page.locator('.attract-band.is-up')).toBeVisible();
    // Using the panel is staff work, not a visitor's touch.
    await page.click('.study-tab[data-tab="band"]');
    await page.click('.study-cog');
    expect(await page.evaluate(() => (window as any)._exhibitTest.attract.state().phase)).toBe('attract');
    await expect(page.locator('.attract-band.is-up')).toBeVisible();
  });

  // 48.5 Without the loop the button says so instead of failing silently.
  test('48.5 with the loop off the demo button explains itself', async ({ page }) => {
    await boot(page, 'debug=1&studyPanel=true');
    await page.click('.study-cog');
    await page.click('.study-tab[data-tab="attract"]');
    await page.click('.study-action[data-action="attractNow"]');
    await expect(page.locator('.study-action[data-action="attractNow"]')).toContainText('Loop is off');
    expect(await page.evaluate(() => (window as any)._exhibitTest.attract ?? null)).toBeNull();
  });
});
