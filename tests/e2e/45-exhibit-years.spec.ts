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
//      concerts sidecar, and the portraits sentence appears nowhere.
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
  test('45.1 without ?viewSwitch the exhibit has no switch, no overlay, no sidecar fetch, and no portraits sentence', async ({
    page,
  }) => {
    const fetched: string[] = [];
    page.on('request', (r) => {
      const u = r.url();
      if (u.includes('concerts.json') || u.includes('dyk.json') || u.includes('years-view.js')) fetched.push(u);
    });
    await boot(page);
    expect(await page.locator('.view-switch').count()).toBe(0);
    expect(await page.locator('.vp-view').count()).toBe(0);
    expect(await concerts(page)).toEqual({ fetched: false });
    expect(fetched, 'the default kiosk must not fetch the explorer or its data').toEqual([]);
    const sentence = await page.evaluate(() => {
      // The catalogue text itself, so the assertion cannot drift from the string.
      return (window as any)._exhibitTest.viewports.length &&
        document.body.textContent!.includes('photographs from Wikimedia Commons');
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
    // Three positions each (listen, years, conductors — 0.52.0 added the
    // third), the listening one pressed at rest.
    for (let i = 0; i < 2; i++) {
      const s = switches.nth(i);
      await expect(s.locator('.view-btn')).toHaveCount(3);
      await expect(s.locator('.view-btn[data-view="listen"]')).toHaveAttribute('aria-pressed', 'true');
      await expect(s.locator('.view-btn[data-view="years"]')).toHaveAttribute('aria-pressed', 'false');
      await expect(s.locator('.view-btn[data-view="conductors"]')).toHaveAttribute('aria-pressed', 'false');
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
        // Behind the overlay the zoom control stands down — there is no
        // waveform to zoom. The AUDIENCE switch does not, since 0.66.0: the
        // explorer carries authored text in the reader's register ("did you
        // know?"), so changing register belongs inside it (45.10).
        zoomVisible: getComputedStyle(vp1.querySelector('.zoom-ctl')!).visibility,
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
    expect(state.zoomVisible).toBe('hidden');
    expect(state.audienceSwitchVisible).toBe('visible');
    expect(state.pressed).toEqual([['listen', 'false'], ['years', 'true'], ['conductors', 'false']]);
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
          dyk: el.dataset.dyk === '1',
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
      // TWO marks only, since 0.66.0 (user, 2026-09-18): playable, and has a
      // story. The "the current piece was on this programme" hairline went —
      // three signals over 84 cells was noise, and the card says that one in
      // words. The sidecar still knows it; the grid simply does not draw it.
      expect(cell.programme, `year ${y}`).toBe(false);
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
  test('45.6 an item only one archive lists is still shown, and no longer marked or explained on the glass', async ({ page }) => {
    await boot(page, 'debug=1&views=years,listen');
    await overlay(page, 0);
    const c = await concerts(page);
    const year = c.years.find((y: number) => c.byYear[y].musikvereinOnly > 0)!;
    await page.locator(`.vp[data-viewport="0"] .yv-cell[data-year="${year}"]`).click();
    const card = page.locator('.vp[data-viewport="0"] .yv-detail');
    // The half of the contract that matters, and it is unchanged: the UNION is
    // shown — nothing an archive lists is dropped, and no disagreement is
    // silently resolved. `data-source` still records which vouched for what.
    await expect(card.locator('.yv-item[data-source="musikverein"]')).toHaveCount(c.byYear[year].musikvereinOnly);
    await expect(card.locator('.yv-item')).toHaveCount(c.byYear[year].items);
    // The half that went (user, 2026-09-18): no per-item ◆/◇, no legend. Which
    // archive vouches for an encore is the museum's bookkeeping; a visitor
    // reading a programme is not served by it, and 84 cells of marks were noise.
    expect(await card.locator('.yv-legend').count()).toBe(0);
    const marks = await page.evaluate(() => {
      const items = [...document.querySelectorAll('.vp[data-viewport="0"] .yv-item')];
      return items.map((li) => getComputedStyle(li, '::after').content).filter((c) => c && c !== 'none');
    });
    expect(marks, 'the programme items still draw a source mark').toEqual([]);
    // The caveat stays — it is a fact about the programme, not about our sources.
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
        listWidthOverflow: list.scrollWidth - list.clientWidth,
        lastItemVisible:
          (list.lastElementChild as HTMLElement).getBoundingClientRect().right <=
          list.getBoundingClientRect().right + 1,
        cardOverflow: card.scrollHeight - card.clientHeight,
        overlayOverflow: ov.scrollHeight - ov.clientHeight,
        aboutVisible: about.offsetHeight > 0 && about.offsetTop + about.offsetHeight <= ov.clientHeight,
      };
    });
    expect(fit.items).toBe(c.byYear[longest].items);
    expect(fit.listOverflow, 'the programme list scrolls or clips').toBeLessThanOrEqual(0);
    // Width too: `columns: 2` does not grow taller when it overflows, it spills
    // a third column off the right edge where nobody sees the items in it.
    expect(fit.listWidthOverflow, 'the programme spills a column off the edge').toBeLessThanOrEqual(0);
    expect(fit.lastItemVisible, 'the programme’s last item is off the card').toBe(true);
    expect(fit.cardOverflow, 'the card overflows').toBeLessThanOrEqual(0);
    expect(fit.overlayOverflow, 'the overlay overflows').toBeLessThanOrEqual(0);
    expect(fit.aboutVisible).toBe(true);
  });

  // 45.8 The portraits sentence (plan §11(d)): present in the explorer, and
  // nowhere else (45.1 covers the default exhibit). Since 0.68.0 the portraits
  // are photographs rather than Gen-AI impressions, so this line carries their
  // CREDIT instead of explaining a mark — and the credit is not decoration: CC BY
  // and CC BY-SA make it a condition of showing the picture at all. It names the
  // photographer of the portrait CURRENTLY on the card, so selecting a different
  // year must change it.
  test('45.8 the explorer credits the photograph it is currently showing', async ({ page }) => {
    await boot(page, 'debug=1&views=years,listen');
    const ov = await overlay(page, 0);
    await expect(ov.locator('.yv-about')).toContainText('photographs from Wikimedia Commons');
    // One sentence, once per explorer — not a per-portrait label.
    expect(await page.locator('.yv-about').count()).toBe(1);

    // The credit tracks the selection. 1989 is Kleiber, whose only free picture is
    // CC BY-SA 3.0, so his card MUST name its photographer; 2020 is Nelsons.
    const creditFor = async (year: number) => {
      await ov.locator(`.yv-cell[data-year="${year}"]`).click();
      await expect(ov.locator('.yv-detail')).toHaveAttribute('data-year', String(year));
      return (await ov.locator('.yv-about').textContent()) ?? '';
    };
    const kleiber = await creditFor(1989);
    expect(kleiber).toContain('Mirschel');
    expect(kleiber).toContain('CC BY-SA 3.0');
    expect(await creditFor(2020)).not.toContain('Mirschel');
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

  // -------------------------------------------------------------------------
  // "Did you know?" (0.66.0) — the museum's authored text, in the reader's own
  // register, IN the card under the programme. Three contracts:
  //
  //   1. IT IS CONTENT, NOT A VARIANT: no query parameter earns it, it is
  //      simply present whenever the selected year has a story, and it is
  //      rendered VERBATIM — Chanda's emphasis survives as elements, and her
  //      note to herself about a picture survives nowhere.
  //   2. ONE REGISTER, THIS READER'S: the card shows the text the viewport's
  //      audience is set to, and follows a change of register without the
  //      reader having to leave the explorer.
  //   3. THE PROGRAMME NEVER PAYS IN CONTENT: the story and the list share the
  //      card, and the list may only degrade its TYPE (fitProgramme), never
  //      clip — a lost encore is invisible, a cut-off paragraph is not. The
  //      story is the one thing here allowed to scroll, and says when it does.
  // -------------------------------------------------------------------------

  // 45.10 The content, the marks, and the register.
  test('45.10 a year with a story shows it in the card in this reader’s register, and follows a change of register', async ({
    page,
  }) => {
    await boot(page, 'debug=1&views=years,listen&audiences=kids,adults');
    const ov = await overlay(page, 0);
    // The content is the sidecar's, like everything else here (the 34.13 lesson).
    const content = await page.evaluate(() => {
      const d = (window as any)._exhibitTest.dyk;
      if (d === undefined) return { fetched: false };
      if (d === null) return { fetched: true, available: false };
      return { fetched: true, available: true, years: [...d.years.keys()].sort() };
    });
    expect(content.available).toBe(true);
    // Exactly the years that have one carry the mark — no more, no fewer.
    const marked = await ov.locator('.yv-cell[data-dyk="1"]').evaluateAll((els) =>
      els.map((e) => Number((e as HTMLElement).dataset.year)).sort(),
    );
    expect(marked).toEqual(content.years);
    expect(marked.length).toBeGreaterThan(0);

    const story = ov.locator('.yv-detail .dyk');
    // A year without a story shows none — and no empty frame where one was.
    await ov.locator('.yv-cell[data-year="1946"]').click();
    await expect(story).toBeHidden();

    // A year with one: simply there, under the programme, no tap required.
    const year = marked[0];
    await ov.locator(`.yv-cell[data-year="${year}"]`).click();
    await expect(story).toBeVisible();
    // Under the programme, and above the way into the music.
    expect(
      await page.evaluate(() => {
        const kids = [...document.querySelectorAll('.vp[data-viewport="0"] .yv-detail > *')].map(
          (e) => e.className.split(' ')[0],
        );
        return { order: kids, dykAfterProgramme: kids.indexOf('dyk') > kids.indexOf('yv-programme') };
      }),
    ).toMatchObject({ dykAfterProgramme: true });
    // The hook Chanda wrote into the heading is the story's eyebrow.
    await expect(story.locator('.dyk-eyebrow')).not.toBeEmpty();
    const kids = await story.locator('.dyk-text').textContent();
    expect(await story.getAttribute('data-audience')).toBe('kids');

    // The register changes from the toolbar, WITHOUT leaving the explorer
    // (0.66.0 stopped hiding the switch behind an overlay — see 45.2).
    await page.click('.vp[data-viewport="0"] .audience-switch .audience-btn[data-audience="expert"]');
    await expect(story).toHaveAttribute('data-audience', 'expert');
    const expert = await story.locator('.dyk-text').textContent();
    expect(expert).not.toBe(kids);
    expect(expert!.length).toBeGreaterThan(0);
    // Both are the authored text for this year, whichever six years ship.
    const authored = await page.evaluate((y) => {
      const e = (window as any)._exhibitTest.dyk.forYear(y);
      return { kids: e.text.kids.en, expert: e.text.expert.en };
    }, year);
    expect(kids!.trim()).toBe(authored.kids.replace(/\*\*?/g, '').trim());
    expect(expert!.trim()).toBe(authored.expert.replace(/\*\*?/g, '').trim());

    // Her emphasis survives as elements, not as asterisks on the glass...
    const withEm = await page.evaluate(() => {
      const d = (window as any)._exhibitTest.dyk;
      for (const [k, e] of d.years) if (/\*/.test(e.text.kids.en)) return k;
      return null;
    });
    if (withEm != null) {
      await page.click('.vp[data-viewport="0"] .audience-switch .audience-btn[data-audience="kids"]');
      await ov.locator(`.yv-cell[data-year="${withEm}"]`).click();
      expect(await story.locator('.dyk-text em, .dyk-text strong').count()).toBeGreaterThan(0);
      expect(await story.locator('.dyk-text').textContent()).not.toContain('*');
    }
    // ...and the author's note about a picture appears nowhere at all.
    expect(await page.evaluate(() => document.body.textContent!.includes('insert AI photo'))).toBe(false);

    // A year without a story takes it away again.
    await ov.locator('.yv-cell[data-year="1946"]').click();
    await expect(story).toBeHidden();
  });

  // 45.11 The two of them in one card. The story may scroll — it is the one
  // thing in the exhibit that may — and when it does it SAYS so, because a
  // kiosk has no scrollbar. The programme may not: it degrades its type
  // instead, and 45.7 still measures the longest one in the series.
  test('45.11 the story and the programme share the card: the list never clips, and a scrolling story says so', async ({
    page,
  }) => {
    await boot(page, 'debug=1&views=years,listen');
    const ov = await overlay(page, 0);
    // The longest text the content holds, in any register: the worst case.
    const longest = await page.evaluate(() => {
      const d = (window as any)._exhibitTest.dyk;
      let best = { year: 0, audience: 'adults', words: -1 };
      for (const [year, e] of d.years) {
        for (const [audience, v] of Object.entries(e.text as Record<string, any>)) {
          const words = (v as any).en.split(/\s+/).length;
          if (words > best.words) best = { year, audience, words };
        }
      }
      return best;
    });
    expect(longest.words).toBeGreaterThan(0);
    await page.click(
      `.vp[data-viewport="0"] .audience-switch .audience-btn[data-audience="${longest.audience}"]`,
    );
    await ov.locator(`.yv-cell[data-year="${longest.year}"]`).click();

    const state = await page.evaluate(() => {
      const vp = document.querySelector('.vp[data-viewport="0"]') as HTMLElement;
      const detail = vp.querySelector('.yv-detail') as HTMLElement;
      const list = vp.querySelector('.yv-programme') as HTMLElement;
      const dyk = vp.querySelector('.dyk') as HTMLElement;
      const body = vp.querySelector('.dyk-body') as HTMLElement;
      return {
        cardOverflow: detail.scrollHeight - detail.clientHeight,
        listOverflow: list.scrollHeight - list.clientHeight,
        listFlagged: list.dataset.overflow ?? null,
        storyH: Math.round(dyk.getBoundingClientRect().height),
        storyScrolls: body.scrollHeight > body.clientHeight + 1,
        flagged: dyk.dataset.scroll ?? null,
      };
    });
    // The CARD itself never scrolls; the story inside it may.
    expect(state.cardOverflow, 'the card overflows').toBeLessThanOrEqual(0);
    expect(state.listOverflow, 'the programme scrolls or clips').toBeLessThanOrEqual(0);
    expect(state.listFlagged, 'the programme ran out of density steps').toBeNull();
    // The story is never squeezed to a teasing sliver.
    expect(state.storyH).toBeGreaterThan(50);
    // And if it does not all fit, it says so — that flag drives the fade.
    expect(state.flagged).toBe(state.storyScrolls ? '1' : null);

    // EVERY year that has a story, not just the longest one: the card is shared
    // on all of them, and the year that broke was 2005 — neither the longest
    // story nor the longest programme, so sampling the extremes missed it.
    // Checked on WIDTH as well as height, because a multi-column list does not
    // grow taller when it overflows: it spills a third column off the right
    // edge, invisibly. That is how 2005 lost its Radetzky March — on the one
    // year whose story is that the Radetzky March was left out.
    const storyYears = await page.evaluate(() => [...(window as any)._exhibitTest.dyk.years.keys()]);
    for (const y of storyYears) {
      await ov.locator(`.yv-cell[data-year="${y}"]`).click();
      const shape = await page.evaluate(() => {
        const list = document.querySelector('.vp[data-viewport="0"] .yv-programme') as HTMLElement;
        const last = list.lastElementChild as HTMLElement;
        return {
          items: list.children.length,
          heightOverflow: list.scrollHeight - list.clientHeight,
          widthOverflow: list.scrollWidth - list.clientWidth,
          lastVisible: last.getBoundingClientRect().right <= list.getBoundingClientRect().right + 1,
          flagged: list.dataset.overflow ?? null,
        };
      });
      expect(shape.heightOverflow, `year ${y}: the programme clips vertically`).toBeLessThanOrEqual(0);
      expect(shape.widthOverflow, `year ${y}: the programme spills a column off the edge`).toBeLessThanOrEqual(0);
      expect(shape.lastVisible, `year ${y}: the programme's last item is off the card`).toBe(true);
      expect(shape.flagged, `year ${y}: the programme ran out of density steps`).toBeNull();
    }

    // 45.7's own subject — the longest programme in the series — is unaffected:
    // it has no story, so nothing shares its card.
    const c = await concerts(page);
    const fullest = c.years.reduce(
      (a: number, y: number) => (c.byYear[y].items > c.byYear[a].items ? y : a),
      c.years[0],
    );
    await ov.locator(`.yv-cell[data-year="${fullest}"]`).click();
    const card = await page.evaluate(() => {
      const vp = document.querySelector('.vp[data-viewport="0"]') as HTMLElement;
      const list = vp.querySelector('.yv-programme') as HTMLElement;
      const detail = vp.querySelector('.yv-detail') as HTMLElement;
      return {
        items: list.children.length,
        listOverflow: list.scrollHeight - list.clientHeight,
        listWidthOverflow: list.scrollWidth - list.clientWidth,
        lastItemVisible:
          (list.lastElementChild as HTMLElement).getBoundingClientRect().right <=
          list.getBoundingClientRect().right + 1,
        cardOverflow: detail.scrollHeight - detail.clientHeight,
        flagged: list.dataset.overflow ?? null,
      };
    });
    expect(card.items).toBe(c.byYear[fullest].items);
    expect(card.listOverflow).toBeLessThanOrEqual(0);
    expect(card.cardOverflow).toBeLessThanOrEqual(0);
    expect(card.flagged).toBeNull();
  });

  // 45.12 The content missing degrades the story, not the explorer — the 45.9
  // rule applied to the other file. Committed, so this should never happen;
  // the exhibit still opens if it does.
  test('45.12 missing "did you know?" content leaves the explorer working, with no marks and no story', async ({
    page,
  }) => {
    await page.route('**/data/dyk.json', (route) => route.fulfill({ status: 404, body: 'not here' }));
    await boot(page, 'debug=1&views=years,listen');
    const ov = await overlay(page, 0);
    expect(await page.evaluate(() => (window as any)._exhibitTest.dyk)).toBeNull();
    expect(await ov.locator('.yv-cell[data-dyk="1"]').count()).toBe(0);
    await expect(ov.locator('.dyk')).toBeHidden();
    // The explorer itself is untouched: the grid, the card, and the sentence.
    expect(await ov.locator('.yv-cell').count()).toBeGreaterThan(0);
    await expect(ov.locator('.yv-programme')).toHaveCount(1);
    await expect(ov.locator('.yv-about')).toContainText('photographs from Wikimedia Commons');
  });
});
