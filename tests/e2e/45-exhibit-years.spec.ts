import { test, expect, type Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Section 45 — The by-year explorer (plan §11; 0.50.0)
//
// The first non-comparative view: every New Year's Concert of the Wiener
// Philharmoniker, year by year, drawn OVER one viewport's strips while the
// other half keeps listening. Three contracts worth pinning:
//
//   1. THE A/B RULE (feedback 2026-08-24): with no ?viewSwitch / ?views the
//      exhibit is byte-identical — no switch, no overlay, no fetch of the
//      concerts sidecar, and the AI-disclosure sentence appears nowhere.
//   2. THE OVERLAY IS AN OVERLAY (user ruling 2026-09-02): switching a
//      viewport into the explorer leaves its strips mounted and the shared
//      transport running; the other viewport is untouched.
//   3. THE DATA IS THE SIDECAR'S: every assertion about years, gaps,
//      conductors, and programmes reads `_exhibitTest.concerts` rather than
//      restating it (the 34.13/38.4 lesson), so a regenerated sidecar cannot
//      fail these tests by being more complete.
//
// Driven through `window._exhibitTest` like spec 34, plus the view hooks
// (`view`, `setView`, `yearsView`, `concerts`) main.js exposes for exactly this.
// ---------------------------------------------------------------------------

/** Navigate to the exhibit and wait for the boot sequence to finish. */
async function boot(page: Page, qs = 'debug=1') {
  await page.goto(`/exhibit?${qs}`);
  const ok = await page.evaluate(() => (window as any)._exhibitTest.ready);
  expect(ok, 'exhibit boot promise resolved falsy — see console for the error').toBe(true);
}

/** The indexed sidecar as the page sees it (null = absent, undefined = never fetched). */
async function concerts(page: Page) {
  return page.evaluate(async () => {
    const T = (window as any)._exhibitTest;
    const c = T.concerts;
    if (c === undefined) return { fetched: false };
    if (c === null) return { fetched: true, available: false };
    const byYear: Record<number, any> = {};
    for (const [y, e] of c.byYear) {
      byYear[y] = {
        date: e.date, conductor: e.conductor, note: e.note, founding: !!e.founding,
        items: e.programme.length, playable: e.playable, portrait: e.portrait,
        onProgramme: e.onProgramme || [],
        library: e.library.length,
        musikvereinOnly: e.programme.filter((i: any) => i.source === 'musikverein').length,
      };
    }
    return {
      fetched: true, available: true, first: c.first, through: c.through,
      lastInArchives: c.lastInArchives, years: c.years as number[], byYear,
    };
  });
}

/** Wait for viewport `i`'s explorer overlay to be in the DOM. */
async function overlay(page: Page, i: number) {
  const sel = `.vp[data-viewport="${i}"] .vp-view[data-view="years"]`;
  await page.waitForSelector(sel, { state: 'attached', timeout: 15_000 });
  return page.locator(sel);
}

test.describe('45. The by-year explorer', () => {
  // The kiosk geometry, as in spec 34: the CSS has no scroll container, so the
  // page must be given the screen it was designed for.
  test.use({ viewport: { width: 1024, height: 1366 } });

  // 45.1 The A/B rule: nothing of the explorer exists unless it is asked for.
  test('45.1 without ?viewSwitch the exhibit has no switch, no overlay, no sidecar fetch, and no disclosure sentence', async ({
    page,
  }) => {
    const fetched: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('concerts.json') || r.url().includes('years-view.js')) fetched.push(r.url());
    });
    await boot(page);
    expect(await page.locator('.view-switch').count()).toBe(0);
    expect(await page.locator('.vp-view').count()).toBe(0);
    expect(await concerts(page)).toEqual({ fetched: false });
    expect(fetched, 'the default kiosk must not fetch the explorer or its data').toEqual([]);
    const sentence = await page.evaluate(() => {
      // The catalogue text itself, so the assertion cannot drift from the string.
      return (window as any)._exhibitTest.viewports.length &&
        document.body.textContent!.includes('AI-generated');
    });
    expect(sentence).toBe(false);
    expect(await page.evaluate(() => (window as any)._exhibitTest.config.viewSwitch)).toBe(false);
  });

  // 45.2 The switch mounts per viewport; taking one half into the explorer
  // leaves its strips mounted, the shared transport running, and the other
  // half untouched.
  test('45.2 ?viewSwitch=1 offers the switch on each half; the explorer overlays one half while the clock keeps running', async ({
    page,
  }) => {
    await boot(page, 'debug=1&viewSwitch=1');
    const switches = page.locator('.view-switch');
    await expect(switches).toHaveCount(2);
    // Two positions each, the listening one pressed at rest.
    for (let i = 0; i < 2; i++) {
      const s = switches.nth(i);
      await expect(s.locator('.view-btn')).toHaveCount(2);
      await expect(s.locator('.view-btn[data-view="listen"]')).toHaveAttribute('aria-pressed', 'true');
      await expect(s.locator('.view-btn[data-view="years"]')).toHaveAttribute('aria-pressed', 'false');
    }
    // Start the shared clock from the band, then take viewport 1 (the far half)
    // into the explorer through its own switch.
    await page.click('.mb-play');
    await expect
      .poll(() => page.evaluate(() => (window as any)._exhibitTest.transport.playing), { timeout: 15_000 })
      .toBe(true);
    await page.locator('.vp[data-viewport="1"] .view-btn[data-view="years"]').click();
    const ov = await overlay(page, 1);
    await expect(ov).toBeAttached();
    const state = await page.evaluate(() => {
      const T = (window as any)._exhibitTest;
      const vp1 = document.querySelector('.vp[data-viewport="1"]') as HTMLElement;
      const vp0 = document.querySelector('.vp[data-viewport="0"]') as HTMLElement;
      const toolbar = vp1.querySelector('.vp-toolbar') as HTMLElement;
      const ov = vp1.querySelector('.vp-view') as HTMLElement;
      return {
        views: [T.view(0), T.view(1)],
        vp1Dataset: vp1.dataset.view,
        vp0Dataset: vp0.dataset.view ?? null,
        stripsStillMounted: T.viewports[1].strips.size,
        stripsInDom: vp1.querySelectorAll('.strip').length,
        overlaysInVp0: vp0.querySelectorAll('.vp-view').length,
        playing: T.transport.playing,
        // The overlay begins where the toolbar ends — layout values, so the far
        // half's 180° rotation cannot confuse the measurement.
        overlayTop: ov.offsetTop,
        toolbarBottom: toolbar.offsetTop + toolbar.offsetHeight,
        // Behind the overlay the toolbar's per-view controls stand down.
        audienceSwitchVisible: getComputedStyle(vp1.querySelector('.audience-switch')!).visibility,
        pressed: [...vp1.querySelectorAll('.view-btn')].map((b) => [
          (b as HTMLElement).dataset.view, b.getAttribute('aria-pressed'),
        ]),
      };
    });
    expect(state.views).toEqual(['listen', 'years']);
    expect(state.vp1Dataset).toBe('years');
    expect(state.vp0Dataset).toBeNull();
    expect(state.stripsStillMounted).toBeGreaterThan(0);
    expect(state.stripsInDom).toBe(state.stripsStillMounted);
    expect(state.overlaysInVp0).toBe(0);
    expect(state.playing).toBe(true);
    expect(state.overlayTop).toBeGreaterThanOrEqual(state.toolbarBottom);
    expect(state.audienceSwitchVisible).toBe('hidden');
    expect(state.pressed).toEqual([['listen', 'false'], ['years', 'true']]);
    // The clock is still advancing under the overlay.
    const t1 = await page.evaluate(() => (window as any)._exhibitTest.transport.time);
    await expect
      .poll(() => page.evaluate(() => (window as any)._exhibitTest.transport.time))
      .toBeGreaterThan(t1);
    // And back: the overlay leaves, the controls return.
    await page.locator('.vp[data-viewport="1"] .view-btn[data-view="listen"]').click();
    await expect(page.locator('.vp[data-viewport="1"] .vp-view')).toHaveCount(0);
    expect(await page.evaluate(() => (window as any)._exhibitTest.view(1))).toBe('listen');
    await expect(page.locator('.vp[data-viewport="1"] .audience-switch')).toBeVisible();
  });

  // 45.3 ?views= starts a half in the explorer, and the grid is the sidecar's:
  // one cell per year from the founding concert to the present, gaps marked
  // as gaps, the founding concert flagged, playable years dotted.
  test('45.3 ?views=years,listen boots one half in the explorer, with a cell for every year and the gaps marked', async ({
    page,
  }) => {
    await boot(page, 'debug=1&views=years,listen');
    // Starting a half in the explorer forces the switch on (a view you cannot
    // leave is a trap).
    expect(await page.evaluate(() => (window as any)._exhibitTest.config.viewSwitch)).toBe(true);
    await overlay(page, 0);
    expect(await page.locator('.vp[data-viewport="1"] .vp-view').count()).toBe(0);
    const c = await concerts(page);
    expect(c.available).toBe(true);
    expect(c.first).toBe(1939);
    const cells = await page.evaluate(() => {
      const out: Record<string, any> = {};
      for (const b of document.querySelectorAll('.vp[data-viewport="0"] .yv-cell[data-year]')) {
        const el = b as HTMLElement;
        out[el.dataset.year!] = {
          state: el.dataset.state, founding: el.dataset.founding === '1',
          playable: el.dataset.playable === '1', programme: el.dataset.programme === '1',
          label: el.textContent, aria: el.getAttribute('aria-label'),
        };
      }
      return out;
    });
    expect(Object.keys(cells).map(Number).sort((a, b) => a - b)).toEqual(c.years);
    for (const y of c.years) {
      const e = c.byYear[y];
      const cell = cells[String(y)];
      expect(cell.state, `year ${y}`).toBe(e.date ? 'concert' : 'gap');
      expect(cell.founding, `year ${y}`).toBe(e.founding);
      expect(cell.playable, `year ${y}`).toBe(e.playable.length > 0);
      expect(cell.programme, `year ${y}`).toBe(e.onProgramme.length > 0);
      expect(cell.aria).toBe(String(y));
    }
    // The known shape of the series, as the archives have it: the founding
    // concert, no concert in 1940, and nothing after the March-2022 scrape.
    expect(cells['1939'].founding).toBe(true);
    expect(cells['1940'].state).toBe('gap');
    for (let y = c.lastInArchives + 1; y <= c.through; y++) expect(cells[String(y)].state).toBe('gap');
    // The resting selection follows the audible recording when it is a
    // concert's (the reference recording is, so at boot that is its year), and
    // falls back to the last concert the archives know.
    const active = await page.evaluate(() => (window as any)._exhibitTest.transport.activeFile);
    const activeYear = c.years.find((y: number) => c.byYear[y].playable.some((p: any) => p.file === active));
    expect(await page.evaluate(() => (window as any)._exhibitTest.yearsView(0))).toEqual({
      year: activeYear ?? c.lastInArchives, available: true,
    });
  });

  // 45.4 A playable year: its card names the conductor, shows the portrait
  // (with the AI mark burned in — no label added here), lists the programme,
  // and its listen button switches the transport to that recording through
  // the turn machine and returns the half to the listening view.
  test('45.4 selecting a playable year shows its card, and Listen switches the recording and returns to listening', async ({
    page,
  }) => {
    await boot(page, 'debug=1&views=years,listen');
    await overlay(page, 0);
    const c = await concerts(page);
    // The first year the exhibit can play — read, not hardcoded.
    const year = c.years.find((y: number) => c.byYear[y].playable.length > 0)!;
    const e = c.byYear[year];
    await page.locator(`.vp[data-viewport="0"] .yv-cell[data-year="${year}"]`).click();
    const card = page.locator('.vp[data-viewport="0"] .yv-detail');
    await expect(card).toHaveAttribute('data-year', String(year));
    await expect(card.locator('.yv-conductor-name')).toHaveText(e.conductor);
    await expect(card.locator('.yv-item')).toHaveCount(e.items);
    if (e.portrait) {
      const src = await card.locator('.yv-portrait').getAttribute('src');
      expect(src).toContain(e.portrait.split('/').pop());
      // The mark travels with the asset, so the surface adds no label.
      expect(await card.locator('[data-ai-label]').count()).toBe(0);
    }
    const btn = card.locator('.yv-listen');
    await expect(btn).toHaveAttribute('data-file', e.playable[0].file);
    await btn.click();
    await expect
      .poll(() => page.evaluate(() => (window as any)._exhibitTest.transport.activeFile), { timeout: 15_000 })
      .toBe(e.playable[0].file);
    expect(await page.evaluate(() => (window as any)._exhibitTest.view(0))).toBe('listen');
    await expect(page.locator('.vp[data-viewport="0"] .vp-view')).toHaveCount(0);
    // Re-entering follows the audible recording's year.
    await page.locator('.vp[data-viewport="0"] .view-btn[data-view="years"]').click();
    await overlay(page, 0);
    expect(await page.evaluate(() => (window as any)._exhibitTest.yearsView(0).year)).toBe(year);
  });

  // 45.5 Gaps say why, and a concert without a programme says so — the
  // sidecar reports what the archives lack rather than hiding it.
  test('45.5 gap years and programme-less concerts are explained on the card', async ({ page }) => {
    await boot(page, 'debug=1&views=years,listen');
    await overlay(page, 0);
    const c = await concerts(page);
    const card = page.locator('.vp[data-viewport="0"] .yv-detail');
    await page.locator('.vp[data-viewport="0"] .yv-cell[data-year="1940"]').click();
    await expect(card).toHaveAttribute('data-state', 'gap');
    await expect(card.locator('.yv-note')).toHaveAttribute('data-reason', 'no-concert');
    const after = c.lastInArchives + 1;
    if (after <= c.through) {
      await page.locator(`.vp[data-viewport="0"] .yv-cell[data-year="${after}"]`).click();
      await expect(card.locator('.yv-note')).toHaveAttribute('data-reason', 'after-archives');
    }
    const noProg = c.years.find((y: number) => c.byYear[y].date && c.byYear[y].items === 0);
    if (noProg) {
      await page.locator(`.vp[data-viewport="0"] .yv-cell[data-year="${noProg}"]`).click();
      await expect(card.locator('.yv-programme-empty')).toHaveCount(1);
      await expect(card.locator('.yv-conductor-name')).toHaveText(c.byYear[noProg].conductor);
    }
    await page.locator('.vp[data-viewport="0"] .yv-cell[data-year="1939"]').click();
    await expect(card.locator('.yv-note')).toHaveAttribute('data-reason', 'founding');
  });

  // 45.6 Items one archive lists and the other does not are shown AND marked,
  // with a legend — never dropped, never passed off as agreed.
  test('45.6 single-archive programme items carry a source mark and the card a legend', async ({ page }) => {
    await boot(page, 'debug=1&views=years,listen');
    await overlay(page, 0);
    const c = await concerts(page);
    const year = c.years.find((y: number) => c.byYear[y].musikvereinOnly > 0)!;
    await page.locator(`.vp[data-viewport="0"] .yv-cell[data-year="${year}"]`).click();
    const card = page.locator('.vp[data-viewport="0"] .yv-detail');
    await expect(card.locator('.yv-item[data-source="musikverein"]')).toHaveCount(c.byYear[year].musikvereinOnly);
    await expect(card.locator('.yv-item')).toHaveCount(c.byYear[year].items);
    await expect(card.locator('.yv-legend')).toContainText('Musikverein');
    await expect(card.locator('.yv-caveat')).toContainText('Encores');
  });

  // 45.7 The kiosk rule: nothing scrolls. The longest programme in the series
  // fits its card at the iPad geometry, and the overlay never overlaps the
  // toolbar.
  test('45.7 the longest programme fits the card without scrolling at the kiosk geometry', async ({ page }) => {
    await boot(page, 'debug=1&views=years,listen');
    await overlay(page, 0);
    const c = await concerts(page);
    const longest = c.years.reduce((a: number, y: number) => (c.byYear[y].items > c.byYear[a].items ? y : a), c.years[0]);
    await page.locator(`.vp[data-viewport="0"] .yv-cell[data-year="${longest}"]`).click();
    const fit = await page.evaluate(() => {
      const vp = document.querySelector('.vp[data-viewport="0"]') as HTMLElement;
      const ov = vp.querySelector('.vp-view') as HTMLElement;
      const card = vp.querySelector('.yv-detail') as HTMLElement;
      const list = vp.querySelector('.yv-programme') as HTMLElement;
      const about = vp.querySelector('.yv-about') as HTMLElement;
      return {
        items: list.children.length,
        listOverflow: list.scrollHeight - list.clientHeight,
        cardOverflow: card.scrollHeight - card.clientHeight,
        overlayOverflow: ov.scrollHeight - ov.clientHeight,
        aboutVisible: about.offsetHeight > 0 && about.offsetTop + about.offsetHeight <= ov.clientHeight,
      };
    });
    expect(fit.items).toBe(c.byYear[longest].items);
    expect(fit.listOverflow, 'the programme list scrolls or clips').toBeLessThanOrEqual(0);
    expect(fit.cardOverflow, 'the card overflows').toBeLessThanOrEqual(0);
    expect(fit.overlayOverflow, 'the overlay overflows').toBeLessThanOrEqual(0);
    expect(fit.aboutVisible).toBe(true);
  });

  // 45.8 The disclosure sentence (plan §11(d)): present in the explorer, and
  // nowhere else (45.1 covers the default exhibit).
  test('45.8 the explorer carries the one sentence explaining the AI mark on the portraits', async ({ page }) => {
    await boot(page, 'debug=1&views=years,listen');
    const ov = await overlay(page, 0);
    await expect(ov.locator('.yv-about')).toContainText('AI-generated');
    await expect(ov.locator('.yv-about')).toContainText('spark');
    // One sentence, once per explorer — not a per-portrait label.
    expect(await page.locator('.yv-about').count()).toBe(1);
  });

  // 45.9 The sidecar missing (nobody ran the prep tool, or it failed) degrades
  // the explorer, not the exhibit: the strips boot, the switch works, and the
  // card says the history is unavailable.
  test('45.9 a missing sidecar leaves the exhibit working and the explorer saying so', async ({ page }) => {
    await page.route('**/data/concerts.json', (route) => route.fulfill({ status: 404, body: 'not here' }));
    await boot(page, 'debug=1&viewSwitch=1');
    expect(await page.evaluate(() => (window as any)._exhibitTest.viewports[0].strips.size)).toBeGreaterThan(0);
    await page.locator('.vp[data-viewport="0"] .view-btn[data-view="years"]').click();
    const ov = await overlay(page, 0);
    await expect(ov.locator('[data-state="unavailable"]')).toHaveCount(1);
    expect(await concerts(page)).toEqual({ fetched: true, available: false });
    expect(await page.evaluate(() => (window as any)._exhibitTest.yearsView(0))).toEqual({ year: null, available: false });
  });
});
