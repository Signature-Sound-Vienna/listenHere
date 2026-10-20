import { test, expect, type Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Section 50 — The tour (roadmap 27; museum feedback 2026-09-22, rulings
// 2026-09-23). A live, INTERACTIVE walkthrough drawn over the real interface,
// per half, from ../js/tour/tour.js (shared with the listen interface) and the
// exhibit's own step data (tour-steps.js). Contracts worth pinning:
//
//   1. OFF BY DEFAULT: no layer, no "?" buttons, no tour object (the A/B rule).
//   2. THE BUTTONS: ?tour=buttons mounts a "?" per area — the toolbar, the
//      annotation panel, the explorer — and each runs only its fragment, on
//      its own half.
//   3. THE ARRIVAL: ?tour=arrival starts the walkthrough on the half whose
//      touch lowered the attract band, and nowhere else.
//   4. INTERACTIVE: steps complete on the visitor's own action — a switch, an
//      audience change, a shown annotation — Next is the escape, Skip ends it,
//      and a step whose target is not on this table is skipped, not shown.
//   5. A stalled step folds the tour away after ?tourIdleMs.
//   6. TWO ATTENTION STYLES (?tourStyle=mask|ring), and reduced motion.
// ---------------------------------------------------------------------------

async function boot(page: Page, qs = 'debug=1') {
  await page.goto(`/exhibit?${qs}`);
  const ok = await page.evaluate(() => (window as any)._exhibitTest.ready);
  expect(ok, 'exhibit boot promise resolved falsy — see console for the error').toBe(true);
  return page.evaluate(() => {
    const T = (window as any)._exhibitTest;
    return { order: T.exhibit.order as string[] };
  });
}

/** select() records its calls and never starts audio (spec 47's stand-in). */
async function armQuietTransport(page: Page) {
  await page.evaluate(() => {
    const T = (window as any)._exhibitTest;
    const orig = T.transport.select.bind(T.transport);
    T.transport.select = (file: string, time: number) => orig(file, time, false);
  });
}

const step = (page: Page, i: number) => page.evaluate((i) => (window as any)._exhibitTest.tour(i)?.step() ?? null, i);
const events = (page: Page, i: number) =>
  page.evaluate((i) => ((window as any)._exhibitTest.tour(i)?.events ?? []).map((e: any) => `${e.kind}:${e.step}`), i);

test.describe('50 — the tour', () => {
  // The kiosk's two-up portrait geometry (specs 45/46): at the default 1280×720
  // each half is 312 px and the toolbar falls out of view, so nothing is tappable.
  test.use({ viewport: { width: 1024, height: 1366 } });

  test('50.1 off by default: no layer, no "?" buttons, no tour object', async ({ page }) => {
    await boot(page);
    await expect(page.locator('.tour-layer')).toHaveCount(0);
    await expect(page.locator('.vp-help, .ann-help, .view-help')).toHaveCount(0);
    expect(await page.evaluate(() => (window as any)._exhibitTest.tour(0))).toBeNull();
    // An unknown value is "off", not a half-mounted tour.
    await boot(page, 'debug=1&tour=sideways');
    await expect(page.locator('.vp-help')).toHaveCount(0);
    expect(await page.evaluate(() => (window as any)._exhibitTest.tour(0))).toBeNull();
  });

  test('50.2 ?tour=buttons mounts a "?" in each toolbar and annotation panel; a tap runs the listening fragment on that half only', async ({
    page,
  }) => {
    await boot(page, 'debug=1&tour=buttons');
    await expect(page.locator('.vp[data-viewport="0"] .vp-toolbar .vp-help')).toHaveCount(1);
    await expect(page.locator('.vp[data-viewport="1"] .vp-toolbar .vp-help')).toHaveCount(1);
    await expect(page.locator('.vp[data-viewport="0"] .ann-panel .ann-help')).toHaveCount(1);
    await expect(page.locator('.tour-layer')).toHaveCount(0); // nothing auto-starts
    await page.click('.vp[data-viewport="0"] .vp-help');
    await expect(page.locator('.vp[data-viewport="0"] .tour-layer')).toHaveCount(1);
    await expect(page.locator('.vp[data-viewport="1"] .tour-layer')).toHaveCount(0);
    expect(await step(page, 0)).toBe('stripes');
    await expect(page.locator('.vp[data-viewport="0"] .tour-body')).toContainText('You are hearing');
    // The layer never swallows a tap: everything but the card is pointer-events: none.
    const swallowed = await page.evaluate(() => {
      const el = document.querySelector('.vp[data-viewport="0"] .tour-layer') as HTMLElement;
      return [el, ...el.querySelectorAll('.tour-mask, .tour-hole, .tour-ring')].map((e) => getComputedStyle(e as Element).pointerEvents);
    });
    expect(swallowed.every((v) => v === 'none')).toBe(true);
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('.tour-card')!).pointerEvents)).toBe('auto');
    // The reading "?" restarts on its own fragment.
    await page.click('.vp[data-viewport="0"] .ann-help');
    expect(await step(page, 0)).toBe('audience');
    expect(await page.evaluate(() => (window as any)._exhibitTest.tour(0).active())).toBe('reading');
  });

  test('50.3 ?tour=arrival: the touch that lowers the attract band starts the walkthrough on the touched half only', async ({
    page,
  }) => {
    await boot(page, 'debug=1&tour=arrival&attractAfterIdleMs=1200');
    await armQuietTransport(page);
    await expect(page.locator('.vp-help')).toHaveCount(0); // arrival alone mounts no buttons
    await page.evaluate(() => (window as any)._exhibitTest.attract.force());
    await expect.poll(() => page.evaluate(() => (window as any)._exhibitTest.attract.state().bandUp)).toBe(true);
    // The far reader arrives: a trusted tap on their half. The sweep has tidied
    // the toolbar away under the band, so the tap lands on a strip — which is
    // also what a real visitor taps first.
    // `force`: the far half is rotated 180° under a band whose pass is
    // re-rendering strips, and Playwright's stability wait never settles; the
    // click is still a trusted pointer event, which is all the room checks.
    await page.locator('.vp[data-viewport="1"] .strip').first().click({ force: true });
    await expect.poll(() => page.evaluate(() => (window as any)._exhibitTest.attract.state().bandUp)).toBe(false);
    await expect(page.locator('.vp[data-viewport="1"] .tour-layer')).toHaveCount(1);
    await expect(page.locator('.vp[data-viewport="0"] .tour-layer')).toHaveCount(0);
    expect(await step(page, 1)).toBe('intro');
    // The loop cycles audiences under its band, so the far half may be reading
    // as kids when the visitor arrives — and the intro is then the kids twin.
    await expect(page.locator('.vp[data-viewport="1"] .tour-body')).toContainText(/New Year's Concert|same piece/);
    expect(await page.evaluate(() => (window as any)._exhibitTest.tour(1).active())).toBe('arrival');
    // A second touch, band down, starts nothing new (one arrival per raise).
    const before = (await events(page, 1)).length;
    await page.evaluate(() => (window as any)._exhibitTest.room.touch());
    expect((await events(page, 1)).length).toBe(before);
  });

  test('50.4 steps complete on the visitor\'s action; an absent target is skipped; Skip ends the tour', async ({ page }) => {
    const { order } = await boot(page, 'debug=1&tour=both');
    await armQuietTransport(page);
    await page.evaluate(() => (window as any)._exhibitTest.tour(0).start('arrival'));
    expect(await step(page, 0)).toBe('intro');
    await page.click('.vp[data-viewport="0"] .tour-next');
    expect(await step(page, 0)).toBe('stripes');
    // "You are hearing X" follows a switch made while the step is up.
    const meta = await page.evaluate(() => (window as any)._exhibitTest.exhibit.metadata.recordings as Record<string, any>);
    const audible = await page.evaluate(() => (window as any)._exhibitTest.transport.activeFile as string);
    const unidentified = order.find((f) => !meta[f].conductor)!; // the Scholz re-badge: names blanked editorially
    const [second, third] = order.filter((f) => f !== audible && f !== unidentified);
    const body = page.locator('.vp[data-viewport="0"] .tour-body');
    await expect(body).toContainText(`${meta[audible].conductor}, ${meta[audible].year}, with the ${meta[audible].ensemble}`);
    await page.evaluate((f) => (window as any)._exhibitTest.turns.request(0, f), second);
    await expect(body).toContainText(`${meta[second].conductor}, ${meta[second].year}, with the ${meta[second].ensemble}`);
    // Blanked names stay blank: never the credited invention, never the file name.
    await page.evaluate((f) => (window as any)._exhibitTest.turns.request(0, f), unidentified);
    await expect(body).toContainText(`an unidentified orchestra, ${meta[unidentified].year}`);
    await expect(body).not.toContainText('Warren');
    expect(await step(page, 0)).toBe('stripes'); // a switch does not advance THIS step
    await page.click('.vp[data-viewport="0"] .tour-next');
    expect(await step(page, 0)).toBe('switch');
    // The switch step waits for a real switch — Next is not what completes it.
    await page.evaluate((f) => (window as any)._exhibitTest.turns.request(0, f), third);
    await expect.poll(() => step(page, 0)).toBe('audience');
    await page.evaluate(() => (window as any)._exhibitTest.audience.set(0, 'kids'));
    await expect.poll(() => step(page, 0)).toBe('chips');
    // Kid-hood was declared once, at the switch, and the tour took it over.
    await expect(page.locator('.vp[data-viewport="0"] .tour-body')).toContainText('music expert');
    await page.locator('.vp[data-viewport="0"] .ann-chip').first().click();
    // No explorers on this table (bandTap off, no viewSwitch): "explore" has
    // nothing to point at and was left out when the fragment started, so the
    // shown chip lands on the closing step — and the dots count six steps,
    // not seven (intro, stripes, switch, audience, chips, done).
    await expect.poll(() => step(page, 0)).toBe('done');
    await expect(page.locator('.vp[data-viewport="0"] .tour-dot')).toHaveCount(6);
    await expect(page.locator('.vp[data-viewport="0"] .tour-body')).toContainText('see these hints again');
    await expect(page.locator('.vp[data-viewport="0"] .tour-next')).toHaveText('Close'); // the last card closes
    await page.click('.vp[data-viewport="0"] .tour-skip');
    await expect(page.locator('.tour-layer')).toHaveCount(0);
    const ev = await events(page, 0);
    expect(ev[ev.length - 1]).toBe('skipped:done');
    expect(await step(page, 0)).toBeNull();
  });

  test('50.5 a stalled step folds the tour away after ?tourIdleMs', async ({ page }) => {
    await boot(page, 'debug=1&tour=both&tourIdleMs=300');
    await page.evaluate(() => (window as any)._exhibitTest.tour(0).start('listening'));
    await expect(page.locator('.vp[data-viewport="0"] .tour-layer')).toHaveCount(1);
    await expect(page.locator('.tour-layer')).toHaveCount(0, { timeout: 3000 });
    const ev = await events(page, 0);
    expect(ev[ev.length - 1]).toBe('timedOut:stripes');
  });

  test('50.6 ?tourStyle=loop draws a hand-drawn loop round the target instead of dimming, and undraws it on Next; mask is the default', async ({
    page,
  }) => {
    await boot(page, 'debug=1&tour=both');
    await page.evaluate(() => (window as any)._exhibitTest.tour(0).start('listening'));
    const layer = page.locator('.vp[data-viewport="0"] .tour-layer');
    await expect(layer).toHaveAttribute('data-style', 'mask');
    await expect(layer.locator('.tour-mask-top')).toBeVisible();
    await expect(layer.locator('.tour-loop')).toBeHidden();
    await boot(page, 'debug=1&tour=both&tourStyle=loop');
    await page.evaluate(() => (window as any)._exhibitTest.tour(0).start('listening'));
    const loop = page.locator('.vp[data-viewport="0"] .tour-layer');
    await expect(loop).toHaveAttribute('data-style', 'loop');
    await expect(page.locator('#screen > .tour-sky .tour-loop')).toBeVisible(); // the loop lives in the sky, not the half
    await expect(loop.locator('.tour-mask-top')).toBeHidden();
    // The "you are hearing" loop sits at the reader's LEFT, round the captions
    // (and the medallion rail, when there is one), the strips' full height —
    // once and a sixth round, in the switch cue's line (user, 2026-09-23).
    const drawn = await page.evaluate(() => {
      const strips = document.querySelector('.vp[data-viewport="0"] .strips')!.getBoundingClientRect();
      const label = document.querySelector('.vp[data-viewport="0"] .strip .strip-label')!.getBoundingClientRect();
      const line = document.querySelector('#screen > .tour-sky .tour-loop-line') as SVGGeometryElement;
      const r = line.getBoundingClientRect();
      return {
        leftAnchored: r.left < strips.left && r.right > label.right && r.right < strips.left + strips.width * 0.5,
        fullHeight: r.top < strips.top && r.bottom > strips.bottom,
        moreThanOnceRound: line.getTotalLength() > 1.1 * (2 * (r.width + r.height)) * 0.8,
        stroke: getComputedStyle(line).stroke,
      };
    });
    expect(drawn.leftAnchored).toBe(true);
    expect(drawn.fullHeight).toBe(true);
    expect(drawn.moreThanOnceRound).toBe(true);
    expect(drawn.stroke).toBe('rgb(240, 127, 26)'); // #f07f1a, the switch cue's orange
    // It paints TOP-MOST, in its own layer beside the halves and the band — not
    // inside the half, where the band (a sibling painted above) would cover it.
    const sky = await page.evaluate(() => {
      const s = document.querySelector('#screen > .tour-sky') as HTMLElement;
      const vp = document.querySelector('.vp[data-viewport="0"]') as HTMLElement;
      return s ? { inScreen: true, hasLoop: !!s.querySelector('.tour-loop-line'), sameBox: s.offsetLeft === vp.offsetLeft && s.offsetTop === vp.offsetTop && s.offsetWidth === vp.offsetWidth && s.offsetHeight === vp.offsetHeight, z: getComputedStyle(s).zIndex } : { inScreen: false };
    });
    expect(sky).toEqual({ inScreen: true, hasLoop: true, sameBox: true, z: '10' });
    // It stays until Next, then undraws BEFORE the next step's loop draws.
    await page.waitForTimeout(1100); // the draw-in has settled
    expect(await page.evaluate(() => (document.querySelector('.tour-loop-line') as SVGElement).style.strokeDasharray)).toBe('');
    await page.click('.vp[data-viewport="0"] .tour-next');
    expect(await step(page, 0)).toBe('stripes'); // still: the loop is leaving
    await expect.poll(() => step(page, 0), { timeout: 3000 }).toBe('switch');
    await expect(page.locator('#screen > .tour-sky .tour-loop')).toBeVisible(); // the next step's loop
    // The switch step's loop is the DEFAULT: a capped box (520×320 at most) in
    // the middle of the strips — the strips fill the half, and a loop round the
    // whole half would be enormous (user, 2026-09-23).
    const capped = await page.evaluate(() => {
      const strips = document.querySelector('.vp[data-viewport="0"] .strips')!.getBoundingClientRect();
      const r = document.querySelector('#screen > .tour-sky .tour-loop-line')!.getBoundingClientRect();
      const cx = (r.left + r.right) / 2, tx = (strips.left + strips.right) / 2;
      const cy = (r.top + r.bottom) / 2, ty = (strips.top + strips.bottom) / 2;
      return Math.abs(cx - tx) < 24 && Math.abs(cy - ty) < 24 && r.width < 520 + 100 && r.height < 320 + 100 && r.width > 450;
    });
    expect(capped).toBe(true);
    // Skip takes the sky with it.
    await page.click('.vp[data-viewport="0"] .tour-skip');
    await expect(page.locator('.tour-sky')).toHaveCount(0, { timeout: 3000 });
  });

  test('50.10 with ?marker=glass the listening fragment explains the marker, and the step completes on a placement', async ({
    page,
  }) => {
    const { order } = await boot(page, 'debug=1&tour=both&marker=glass');
    await armQuietTransport(page);
    await page.evaluate(() => (window as any)._exhibitTest.tour(0).start('listening'));
    await expect(page.locator('.vp[data-viewport="0"] .tour-dot')).toHaveCount(5); // stripes, switch, marker, zoom, done
    await page.click('.vp[data-viewport="0"] .tour-next');
    await page.evaluate((f) => (window as any)._exhibitTest.turns.request(0, f), order[1]);
    await expect.poll(() => step(page, 0)).toBe('marker');
    await expect(page.locator('.vp[data-viewport="0"] .tour-body')).toContainText('your own marker');
    // Placing the glass (the semantic path of a drag onto a stripe) completes the step.
    await page.evaluate((f) => (window as any)._exhibitTest.placeMarker(0, f, 30), order[1]);
    await expect.poll(() => step(page, 0)).toBe('zoom');
    // Without a marker the step is not there at all.
    await boot(page, 'debug=1&tour=both');
    await page.evaluate(() => (window as any)._exhibitTest.tour(0).start('listening'));
    await expect(page.locator('.vp[data-viewport="0"] .tour-dot')).toHaveCount(4);
  });

  test('50.9 a drawn loop stays ?tourLoopHoldMs, then undraws and draws itself again while the step is up', async ({ page }) => {
    await boot(page, 'debug=1&tour=both&tourStyle=loop&tourLoopHoldMs=300');
    await page.evaluate(() => (window as any)._exhibitTest.tour(0).start('listening'));
    // draw (900) + hold (300) + undraw (380) + beat (350) ≈ 2 s to the redraw
    await expect.poll(() => events(page, 0), { timeout: 6000 }).toContain('loopRedraw:stripes');
    expect(await step(page, 0)).toBe('stripes'); // the cycle never advances the step
    await expect(page.locator('#screen > .tour-sky .tour-loop')).toBeVisible();
    // The far half's sky turns with its reader.
    await page.evaluate(() => (window as any)._exhibitTest.tour(1).start('listening'));
    const turned = await page.evaluate(() => {
      const skies = [...document.querySelectorAll('#screen > .tour-sky')] as HTMLElement[];
      return skies.map((s) => getComputedStyle(s).transform !== 'none');
    });
    expect(turned).toEqual([false, true]);
  });

  test.describe('reduced motion', () => {
    test('50.7 the layer says so, the loop skips its drawing in and out, and Next is immediate', async ({ page }) => {
      await page.emulateMedia({ reducedMotion: 'reduce' }); // spec 47's way; set before the boot reads it
      await boot(page, 'debug=1&tour=both&tourStyle=loop');
      await page.evaluate(() => (window as any)._exhibitTest.tour(0).start('listening'));
      const layer = page.locator('.vp[data-viewport="0"] .tour-layer');
      await expect(layer).toHaveAttribute('data-reduced', '1');
      const dash = await page.evaluate(() => (document.querySelector('.tour-loop-line') as SVGElement).style.strokeDasharray);
      expect(dash).toBe('');
      await page.click('.vp[data-viewport="0"] .tour-next');
      expect(await step(page, 0)).toBe('switch');
    });
  });

  test('50.8 the explorer overlay carries its own "?" that runs the exploring fragment', async ({ page }) => {
    await boot(page, 'debug=1&tour=both&viewSwitch=1');
    await page.evaluate(() => (window as any)._exhibitTest.setView(0, 'years'));
    await expect(page.locator('.vp[data-viewport="0"] .vp-view')).toHaveCount(1);
    await expect(page.locator('.vp[data-viewport="0"] .vp-view .view-help')).toHaveCount(1);
    // The listening "?" stands down behind the explorer, like the zoom control.
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('.vp[data-viewport="0"] .vp-help')!).visibility)).toBe('hidden');
    await page.click('.vp[data-viewport="0"] .vp-view .view-help');
    expect(await step(page, 0)).toBe('explorer');
    await expect(page.locator('.vp[data-viewport="0"] .tour-body')).toContainText('since 1939');
    await page.click('.vp[data-viewport="0"] .tour-next');
    expect(await step(page, 0)).toBe('back');
    await page.click('.vp[data-viewport="0"] .tour-next');
    // Every fragment closes on "tap ? to see these hints again", pointing at its own "?".
    expect(await step(page, 0)).toBe('done');
    await expect(page.locator('.vp[data-viewport="0"] .tour-body')).toContainText('see these hints again');
    await page.click('.vp[data-viewport="0"] .tour-next');
    await expect(page.locator('.tour-layer')).toHaveCount(0);
    const ev = await events(page, 0);
    expect(ev[ev.length - 1]).toBe('finished:null');
  });
});
