import { test, expect, type Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Section 46 — The band is the interface, and the by-conductor explorer
// (plan §11(f); 0.52.0)
//
// The second non-comparative view, and the RULED way into both views: on the
// MIRRORED band, tap the year and the tapping reader's half opens the by-year
// explorer at that concert; tap the conductor (name or portrait) and it opens
// the by-conductor explorer with them. Four contracts worth pinning:
//
//   1. THE A/B RULE: with no ?bandTap the mirrored band is byte-identical —
//      no tappable facts, no cue, no fetch of the sidecar or the views — and
//      ?bandTap under any orientation but mirrored resolves to "off" with a
//      warning, because only mirrored copies can say who tapped.
//   2. ATTRIBUTION WITHOUT A TURN (turns.js bandTapViewport): a fact in
//      cluster i opens viewport i's view and never touches the clock — not
//      even under the request policy while the other side is listening.
//   3. FACTS LEAD ONLY WHERE THE SERIES FOLLOWS: the year is tappable when the
//      audible recording IS that year's concert, the conductor when the
//      series knows them; anything else is a plain fact, never a dead button.
//   4. THE DATA IS THE SIDECAR'S: every assertion about conductors, years,
//      portraits, and playability reads `_exhibitTest.concerts` and the
//      payload rather than restating them (the 34.13/38.4 lesson).
//
// Plus the way back — a close control inside every overlay — and the toolbar
// switch of 0.50.0 kept as the fallback entry, now with three positions.
// ---------------------------------------------------------------------------

/** Navigate to the exhibit and wait for the boot sequence to finish. */
async function boot(page: Page, qs = 'debug=1') {
  await page.goto(`/exhibit?${qs}`);
  const ok = await page.evaluate(() => (window as any)._exhibitTest.ready);
  expect(ok, 'exhibit boot promise resolved falsy — see console for the error').toBe(true);
}

/** Wait for the concerts sidecar to have settled (either way) when an entry is configured. */
async function awaitConcerts(page: Page) {
  await page.waitForFunction(() => (window as any)._exhibitTest.concerts !== undefined, null, {
    timeout: 15_000,
  });
}

/** The sidecar's conductor index and the payload facts the view joins on, as the page sees them. */
async function series(page: Page) {
  return page.evaluate(() => {
    const T = (window as any)._exhibitTest;
    const c = T.concerts;
    if (c === undefined) return { fetched: false as const };
    if (c === null) return { fetched: true as const, available: false as const };
    const pieceId = T.exhibit.piece.id as string;
    const title = T.exhibit.piece.title;
    const conductors = c.conductors.map((e: any) => ({
      name: e.name as string,
      years: e.years as number[],
      first: e.first as number,
      last: e.last as number,
      portraits: e.portraits as { year: number; path: string }[],
      playable: e.playable as { year: number; file: string; piece: string }[],
      roles: e.roles as string[],
      onProgramme: e.concerts.map((k: any) => [k.year, (k.onProgramme || []).includes(pieceId)]) as [number, boolean][],
    }));
    const playableYears: Record<string, number> = {};
    for (const [f, y] of c.playableYears) playableYears[f] = y;
    const metadata: Record<string, { conductor: string; year: number }> = {};
    for (const [f, m] of Object.entries(T.exhibit.metadata.recordings as Record<string, any>)) {
      metadata[f] = { conductor: m.conductor, year: m.year };
    }
    return {
      fetched: true as const,
      available: true as const,
      conductors,
      playableYears,
      metadata,
      order: T.exhibit.order as string[],
      pieceId,
      pieceTitle: (typeof title === 'string' ? title : title?.en ?? title?.[Object.keys(title)[0]]) as string,
      activeFile: T.transport.activeFile as string,
    };
  });
}

/** The band's facts: which are tappable, in which cluster, with what role and label. */
async function facts(page: Page) {
  return page.evaluate(() => {
    const band = (window as any)._exhibitTest.band.el as HTMLElement;
    return {
      tap: band.dataset.tap ?? null,
      clusters: band.querySelectorAll('.mb-cluster').length,
      facts: [...band.querySelectorAll('[data-fact]')].map((e) => ({
        cluster: (e.closest('.mb-cluster') as HTMLElement).dataset.cluster,
        fact: (e as HTMLElement).dataset.fact,
        el: e.classList.contains('mb-portrait')
          ? 'portrait'
          : e.classList.contains('mb-conductor')
            ? 'conductor'
            : 'year',
        tappable: e.classList.contains('is-tappable'),
        role: e.getAttribute('role'),
        tabindex: e.getAttribute('tabindex'),
        label: e.getAttribute('aria-label'),
      })),
      buttonsInBand: band.querySelectorAll('[role="button"], button').length,
    };
  });
}

/** Wait for viewport `i`'s explorer overlay of `view` to be in the DOM. */
async function overlay(page: Page, i: number, view: string) {
  const sel = `.vp[data-viewport="${i}"] .vp-view[data-view="${view}"]`;
  await page.waitForSelector(sel, { state: 'attached', timeout: 15_000 });
  return page.locator(sel);
}

const fact = (i: number, el: 'year' | 'conductor' | 'portrait') =>
  `.middle-band .mb-cluster[data-cluster="${i}"] .mb-${el}`;

test.describe('46. The band is the interface — by-conductor, and the way in', () => {
  // The kiosk geometry, as in specs 34 and 45.
  test.use({ viewport: { width: 1024, height: 1366 } });

  // 46.1 The A/B rule, both halves of it.
  test('46.1 without ?bandTap the mirrored band has no tappable facts and fetches nothing; ?bandTap off mirrored resolves to off', async ({
    page,
  }) => {
    const fetched: string[] = [];
    page.on('request', (r) => {
      const u = r.url();
      if (u.includes('concerts.json') || u.includes('-view.js')) fetched.push(u);
    });
    await boot(page, 'debug=1&bandOrientation=mirrored');
    const f = await facts(page);
    expect(f.clusters).toBe(2);
    expect(f.tap).toBeNull();
    expect(f.facts).toEqual([]);
    expect(f.buttonsInBand, 'only the shared play control is a button').toBe(1);
    expect(await series(page)).toEqual({ fetched: false });
    expect(fetched, 'the shipped mirrored band must not fetch the explorers or their data').toEqual([]);
    expect(await page.locator('.view-close').count()).toBe(0);

    // Upright cannot attribute a tap, so the request resolves to "off" and says why.
    const warnings: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'warning') warnings.push(m.text());
    });
    await boot(page, 'debug=1&bandTap=chip');
    const g = await facts(page);
    expect(g.tap).toBeNull();
    expect(g.facts).toEqual([]);
    expect(await series(page)).toEqual({ fetched: false });
    expect(warnings.some((w) => w.includes('bandTap') && w.includes('mirrored'))).toBe(true);
    // The configured value is kept for the record; only the resolution is "off".
    expect(await page.evaluate(() => (window as any)._exhibitTest.config.bandTap)).toBe('chip');
  });

  // 46.2 The entry: each reader's copy opens that reader's half, on the fact.
  test('46.2 a tap on a fact opens the tapping reader’s half on that fact, both explorers, no toolbar switch needed', async ({
    page,
  }) => {
    await boot(page, 'debug=1&bandOrientation=mirrored&bandTap=chip');
    await awaitConcerts(page);
    const s = await series(page);
    expect(s.available).toBe(true);
    if (!s.available) return;
    // The resting recording is a concert's (the reference is), so every fact leads somewhere.
    const year = s.playableYears[s.activeFile];
    expect(year, 'the resting recording should be a New Year’s Concert recording').toBeDefined();
    const conductor = s.metadata[s.activeFile].conductor;
    expect(s.conductors.map((c) => c.name)).toContain(conductor);

    const f = await facts(page);
    expect(f.tap).toBe('chip');
    expect(f.facts).toHaveLength(6); // three facts per cluster, two clusters
    for (const x of f.facts) {
      expect(x.tappable, `${x.el} in cluster ${x.cluster}`).toBe(true);
      expect(x.role).toBe('button');
      expect(x.tabindex).toBe('0');
      expect(x.label).toContain(x.fact === 'year' ? String(year) : conductor);
    }
    expect(f.facts.filter((x) => x.cluster === '0')).toHaveLength(3);
    expect(f.facts.filter((x) => x.cluster === '1')).toHaveLength(3);
    // No toolbar switch: the band is the way in.
    expect(await page.locator('.view-switch').count()).toBe(0);

    // The FAR reader taps their year: their half (viewport 1) opens by-year on it.
    await page.click(fact(1, 'year'));
    await overlay(page, 1, 'years');
    expect(await page.evaluate(() => (window as any)._exhibitTest.yearsView(1))).toEqual({
      year, available: true,
    });
    expect(await page.evaluate(() => (window as any)._exhibitTest.view(0))).toBe('listen');
    expect(await page.locator('.vp[data-viewport="0"] .vp-view').count()).toBe(0);

    // The NEAR reader taps the portrait: their half (viewport 0) opens by-conductor on them.
    await page.click(fact(0, 'portrait'));
    await overlay(page, 0, 'conductors');
    expect(await page.evaluate(() => (window as any)._exhibitTest.conductorsView(0))).toEqual({
      conductor, available: true,
    });
    const card = page.locator('.vp[data-viewport="0"] .cv-detail');
    await expect(card).toHaveAttribute('data-conductor', conductor);
    await expect(card.locator('.cv-name')).toHaveText(conductor);
    // Each half has exactly one overlay, each with its close control; the clock is untouched.
    const state = await page.evaluate(() => {
      const T = (window as any)._exhibitTest;
      return {
        views: [T.view(0), T.view(1)],
        overlays: [0, 1].map((i) => document.querySelectorAll(`.vp[data-viewport="${i}"] .vp-view`).length),
        closes: document.querySelectorAll('.vp-view .view-close').length,
        holder: T.turns.state().holder,
        pending: T.turns.state().pending,
        playing: T.transport.playing,
        activeFile: T.transport.activeFile,
      };
    });
    expect(state.views).toEqual(['conductors', 'years']);
    expect(state.overlays).toEqual([1, 1]);
    expect(state.closes).toBe(2);
    expect(state.holder).toBeNull();
    expect(state.pending).toBeNull();
    expect(state.playing).toBe(false);
    expect(state.activeFile).toBe(s.activeFile);

    // The name tapped on the near copy while by-year is up on the far half
    // moves the NEAR half to by-conductor — and a second tap on a fact whose
    // view is already up moves that view to the fact: switch the recording
    // to another concert's, tap the far year, and the far explorer follows.
    const other = s.order.find((f2) => f2 !== s.activeFile && s.playableYears[f2] != null)!;
    expect(other, 'a second concert recording in the shown set').toBeTruthy();
    await page.evaluate((file) => (window as any)._exhibitTest.transport.select(file, 0, false), other);
    await expect
      .poll(() => page.evaluate(() => (window as any)._exhibitTest.band.el.dataset.file))
      .toBe(other);
    await page.click(fact(1, 'year'));
    await expect
      .poll(() => page.evaluate(() => (window as any)._exhibitTest.yearsView(1).year))
      .toBe(s.playableYears[other]);
    expect(await page.evaluate(() => (window as any)._exhibitTest.view(1))).toBe('years');
  });

  // 46.3 The way back lives inside the overlay.
  test('46.3 the close control returns the half to listening and is the only way back when no switch is configured', async ({
    page,
  }) => {
    await boot(page, 'debug=1&bandOrientation=mirrored&bandTap=plain');
    await awaitConcerts(page);
    await page.click(fact(1, 'conductor'));
    const ov = await overlay(page, 1, 'conductors');
    const close = ov.locator('.view-close');
    await expect(close).toHaveCount(1);
    await expect(close).toHaveAttribute('aria-label', /.+/);
    // Behind the overlay the toolbar's per-view controls stand down, like 45.2.
    expect(
      await page.evaluate(() =>
        getComputedStyle(document.querySelector('.vp[data-viewport="1"] .audience-switch')!).visibility,
      ),
    ).toBe('hidden');
    expect(await page.locator('.view-switch').count()).toBe(0);
    await close.click();
    await expect(page.locator('.vp[data-viewport="1"] .vp-view')).toHaveCount(0);
    expect(await page.evaluate(() => (window as any)._exhibitTest.view(1))).toBe('listen');
    await expect(page.locator('.vp[data-viewport="1"] .audience-switch')).toBeVisible();
    // Re-entering reuses the built explorer (no second close control, one overlay).
    await page.click(fact(1, 'conductor'));
    await overlay(page, 1, 'conductors');
    expect(await page.locator('.vp[data-viewport="1"] .view-close').count()).toBe(1);
  });

  // 46.4 Attribution is not a turn (turns.js bandTapViewport).
  test('46.4 a fact tap never takes the clock — not even under request while the other side is listening', async ({
    page,
  }) => {
    await boot(page, 'debug=1&bandOrientation=mirrored&bandTap=plain&turnPolicy=request');
    await awaitConcerts(page);
    const s = await series(page);
    if (!s.available) throw new Error('sidecar unavailable');
    // Viewport 0 takes the clock; a take through the turn machine PLAYS (the
    // transport's select plays by default), so the room is genuinely listening.
    await page.evaluate((file) => (window as any)._exhibitTest.turns.request(0, file, undefined), s.activeFile);
    await expect
      .poll(() => page.evaluate(() => (window as any)._exhibitTest.transport.playing), { timeout: 15_000 })
      .toBe(true);
    expect(await page.evaluate(() => (window as any)._exhibitTest.turns.state().holder)).toBe(0);
    // The OTHER reader taps their year while 0 holds the clock and audio plays:
    // under the request policy a strip tap would become a request; a fact tap
    // is not a tap for the clock at all.
    await page.click(fact(1, 'year'));
    await overlay(page, 1, 'years');
    const after = await page.evaluate(() => {
      const T = (window as any)._exhibitTest;
      return {
        holder: T.turns.state().holder,
        pending: T.turns.state().pending,
        playing: T.transport.playing,
        view1: T.view(1),
        prompts: document.querySelectorAll('.vp-turn:not([hidden])').length,
      };
    });
    expect(after.holder).toBe(0);
    expect(after.pending).toBeNull();
    expect(after.playing).toBe(true);
    expect(after.view1).toBe('years');
    expect(after.prompts).toBe(0);
    // And the rule itself, as the module states it.
    const rule = await page.evaluate(async () => {
      const m = await import('/static/exhibit/turns.js');
      return {
        mirrored: [m.bandTapViewport('mirrored', 0), m.bandTapViewport('mirrored', 1), m.bandTapViewport('mirrored', '1')],
        others: ['upright', 'rotated', 'flip', ''].map((o) => m.bandTapViewport(o, 0)),
        junk: [m.bandTapViewport('mirrored', -1), m.bandTapViewport('mirrored', 1.5), m.bandTapViewport('mirrored', 'x')],
      };
    });
    expect(rule.mirrored).toEqual([0, 1, 1]);
    expect(rule.others).toEqual([null, null, null, null]);
    expect(rule.junk).toEqual([null, null, null]);
  });

  // 46.5 A fact leads only where the series can follow it.
  test('46.5 a recording the series cannot place makes the year a plain fact; an unknown conductor makes both plain', async ({
    page,
  }) => {
    await boot(page, 'debug=1&bandOrientation=mirrored&bandTap=chip');
    await awaitConcerts(page);
    const s = await series(page);
    if (!s.available) throw new Error('sidecar unavailable');
    const known = new Set(s.conductors.map((c) => c.name));
    // A conductor the series knows, on a recording that is not a New Year's
    // Concert (the 1950 studio session): the conductor leads on, the year does not.
    const knownNotPlayable = s.order.find(
      (f) => s.metadata[f].conductor && known.has(s.metadata[f].conductor) && s.playableYears[f] == null,
    );
    // A conductor the series never had: nothing leads anywhere.
    const unknown = s.order.find((f) => s.metadata[f].conductor && !known.has(s.metadata[f].conductor));
    expect(knownNotPlayable, 'the shown set needs a series conductor on a non-concert recording').toBeTruthy();
    expect(unknown, 'the shown set needs a recording by a conductor outside the series').toBeTruthy();

    await page.evaluate((file) => (window as any)._exhibitTest.transport.select(file, 0, false), knownNotPlayable);
    await expect.poll(() => page.evaluate(() => (window as any)._exhibitTest.band.el.dataset.file)).toBe(knownNotPlayable);
    const a = await facts(page);
    expect(a.facts.filter((x) => x.fact === 'year').map((x) => x.tappable)).toEqual([false, false]);
    expect(a.facts.filter((x) => x.fact === 'conductor').map((x) => x.tappable)).toEqual([true, true, true, true]);
    for (const x of a.facts.filter((x) => !x.tappable)) {
      expect(x.role, 'a plain fact carries no button role').toBeNull();
      expect(x.label).toBeNull();
    }
    // The conductor still opens.
    await page.click(fact(0, 'conductor'));
    await overlay(page, 0, 'conductors');
    expect(await page.evaluate(() => (window as any)._exhibitTest.conductorsView(0).conductor)).toBe(
      s.metadata[knownNotPlayable!].conductor,
    );

    await page.evaluate((file) => (window as any)._exhibitTest.transport.select(file, 0, false), unknown);
    await expect.poll(() => page.evaluate(() => (window as any)._exhibitTest.band.el.dataset.file)).toBe(unknown);
    const b = await facts(page);
    expect(b.facts.map((x) => x.tappable)).toEqual([false, false, false, false, false, false]);
    expect(b.buttonsInBand, 'only the play control is a button now').toBe(1);
  });

  // 46.6 The explorer's content is the sidecar's, in the sidecar's order.
  test('46.6 the roster lists every conductor in order of first concert; a card shows their years, marks, portrait, and the sentence', async ({
    page,
  }) => {
    await boot(page, 'debug=1&views=conductors,listen');
    await awaitConcerts(page);
    const s = await series(page);
    if (!s.available) throw new Error('sidecar unavailable');
    // The fallback entry grew a third position.
    const sw = page.locator('.vp[data-viewport="0"] .view-switch .view-btn');
    await expect(sw).toHaveCount(3);
    expect(await sw.evaluateAll((bs) => bs.map((b) => (b as HTMLElement).dataset.view))).toEqual([
      'listen', 'years', 'conductors',
    ]);
    const ov = await overlay(page, 0, 'conductors');
    const roster = await ov.locator('.cv-entry').evaluateAll((bs) =>
      bs.map((b) => ({
        name: (b as HTMLElement).dataset.conductor,
        years: b.querySelector('.cv-entry-years')!.textContent,
        count: b.querySelector('.cv-entry-count')?.textContent ?? null,
        playable: (b as HTMLElement).dataset.playable === '1',
        portrait: !!b.querySelector('.cv-entry-portrait'),
        selected: b.classList.contains('is-selected'),
        pressed: b.getAttribute('aria-pressed'),
      })),
    );
    expect(roster.map((r) => r.name)).toEqual(s.conductors.map((c) => c.name));
    for (let i = 0; i < roster.length; i++) {
      const c = s.conductors[i];
      const r = roster[i];
      expect(r.years, c.name).toBe(c.years.length <= 3 ? c.years.join(', ') : `${c.first}–${c.last}`);
      expect(r.count, c.name).toBe(c.years.length > 3 ? String(c.years.length) : null);
      expect(r.playable, c.name).toBe(c.playable.length > 0);
      expect(r.portrait, c.name).toBe(c.portraits.length > 0);
    }
    // The resting selection follows the audible recording's conductor when the series knows them.
    const restName = s.metadata[s.activeFile].conductor;
    const expectedRest = s.conductors.some((c) => c.name === restName) ? restName : s.conductors[s.conductors.length - 1].name;
    expect(roster.filter((r) => r.selected).map((r) => r.name)).toEqual([expectedRest]);
    expect(await page.evaluate(() => (window as any)._exhibitTest.conductorsView(0))).toEqual({
      conductor: expectedRest, available: true,
    });

    // The conductor with the most concerts: the longest year strip.
    const most = s.conductors.reduce((a, c) => (c.years.length > a.years.length ? c : a), s.conductors[0]);
    await ov.locator(`.cv-entry[data-conductor="${most.name}"]`).click();
    const card = ov.locator('.cv-detail');
    await expect(card).toHaveAttribute('data-conductor', most.name);
    await expect(card.locator('.cv-name')).toHaveText(most.name);
    const summary = await card.locator('.cv-summary').textContent();
    expect(summary).toContain(String(most.years.length));
    expect(summary).toContain(String(most.first));
    expect(summary).toContain(String(most.last));
    const cells = await card.locator('.cv-year').evaluateAll((es) =>
      es.map((e) => ({
        year: Number((e as HTMLElement).dataset.year),
        playable: (e as HTMLElement).dataset.playable === '1',
        programme: (e as HTMLElement).dataset.programme === '1',
        button: e.tagName === 'BUTTON',
      })),
    );
    expect(cells.map((c) => c.year)).toEqual(most.years);
    for (const cell of cells) {
      expect(cell.playable, `year ${cell.year}`).toBe(most.playable.some((p) => p.year === cell.year));
      expect(cell.programme, `year ${cell.year}`).toBe(most.onProgramme.find(([y]) => y === cell.year)![1]);
      expect(cell.button, 'years on the card are marks, not navigation (plan §11(f))').toBe(false);
    }
    expect(await card.locator('.cv-role').count()).toBe(most.roles.length ? 1 : 0);
    if (most.roles.length) await expect(card.locator('.cv-role')).toHaveText(most.roles.join(' · '));

    // A conductor with a portrait: shown large, the mark in the asset, no label added.
    const faced = s.conductors.find((c) => c.portraits.length > 0);
    if (faced) {
      await ov.locator(`.cv-entry[data-conductor="${faced.name}"]`).click();
      await expect(card).toHaveAttribute('data-conductor', faced.name);
      const latest = faced.portraits[faced.portraits.length - 1];
      await expect(card.locator('.cv-medallion-large')).toHaveAttribute('data-portrait-year', String(latest.year));
      expect(await card.locator('.cv-portrait').getAttribute('src')).toContain(latest.path.split('/').pop()!);
      expect(await card.locator('[data-ai-label]').count()).toBe(0);
      expect(await card.locator('.cv-sitting').count()).toBe(faced.portraits.length > 1 ? faced.portraits.length : 0);
    }
    // The one sentence explaining the mark, once per explorer (plan §11(d)).
    await expect(ov.locator('.cv-about')).toContainText('AI-generated');
    expect(await page.locator('.cv-about').count()).toBe(1);
  });

  // 46.7 The way from a conductor into their music.
  test('46.7 Listen on a conductor’s card switches the recording and returns to listening; re-entry follows the audible conductor', async ({
    page,
  }) => {
    await boot(page, 'debug=1&views=conductors,listen');
    await awaitConcerts(page);
    const s = await series(page);
    if (!s.available) throw new Error('sidecar unavailable');
    const ov = await overlay(page, 0, 'conductors');
    // A conductor with a playable recording of the current piece who is NOT
    // the resting one, so the switch is observable.
    const target = s.conductors.find(
      (c) => c.playable.some((p) => p.piece === s.pieceId && p.file !== s.activeFile) && c.name !== s.metadata[s.activeFile].conductor,
    )!;
    expect(target, 'a second playable conductor in the shown set').toBeTruthy();
    await ov.locator(`.cv-entry[data-conductor="${target.name}"]`).click();
    const card = ov.locator('.cv-detail');
    await expect(card).toHaveAttribute('data-conductor', target.name);
    const buttons = card.locator('.cv-listen');
    const theirs = target.playable.filter((p) => p.piece === s.pieceId);
    await expect(buttons).toHaveCount(theirs.length);
    const files = await buttons.evaluateAll((bs) => bs.map((b) => (b as HTMLElement).dataset.file));
    expect(files.sort()).toEqual(theirs.map((p) => p.file).sort());
    const text = await buttons.first().textContent();
    expect(text).toContain(s.pieceTitle);
    const chosen = await buttons.first().getAttribute('data-file');
    await buttons.first().click();
    await expect
      .poll(() => page.evaluate(() => (window as any)._exhibitTest.transport.activeFile), { timeout: 15_000 })
      .toBe(chosen);
    expect(await page.evaluate(() => (window as any)._exhibitTest.view(0))).toBe('listen');
    await expect(page.locator('.vp[data-viewport="0"] .vp-view')).toHaveCount(0);
    // Re-entering by the fallback switch follows the audible recording's conductor.
    await page.locator('.vp[data-viewport="0"] .view-btn[data-view="conductors"]').click();
    await overlay(page, 0, 'conductors');
    expect(await page.evaluate(() => (window as any)._exhibitTest.conductorsView(0).conductor)).toBe(target.name);
  });

  // 46.8 The kiosk rule: nothing scrolls.
  test('46.8 the roster and the fullest card fit the overlay without scrolling at the kiosk geometry', async ({ page }) => {
    await boot(page, 'debug=1&views=conductors,listen');
    await awaitConcerts(page);
    const s = await series(page);
    if (!s.available) throw new Error('sidecar unavailable');
    const ov = await overlay(page, 0, 'conductors');
    const most = s.conductors.reduce((a, c) => (c.years.length > a.years.length ? c : a), s.conductors[0]);
    await ov.locator(`.cv-entry[data-conductor="${most.name}"]`).click();
    await expect(ov.locator('.cv-detail')).toHaveAttribute('data-conductor', most.name);
    const fit = await page.evaluate(() => {
      const vp = document.querySelector('.vp[data-viewport="0"]') as HTMLElement;
      const ov = vp.querySelector('.vp-view') as HTMLElement;
      const roster = vp.querySelector('.cv-roster') as HTMLElement;
      const card = vp.querySelector('.cv-detail') as HTMLElement;
      const about = vp.querySelector('.cv-about') as HTMLElement;
      const toolbar = vp.querySelector('.vp-toolbar') as HTMLElement;
      return {
        entries: roster.children.length,
        rows: roster.style.getPropertyValue('--cv-rows'),
        rosterOverflow: Math.max(roster.scrollHeight - roster.clientHeight, roster.scrollWidth - roster.clientWidth),
        rosterDense: roster.className,
        cardOverflow: card.scrollHeight - card.clientHeight,
        overlayOverflow: ov.scrollHeight - ov.clientHeight,
        aboutVisible: about.offsetHeight > 0 && about.offsetTop + about.offsetHeight <= ov.clientHeight,
        overlayTop: ov.offsetTop,
        toolbarBottom: toolbar.offsetTop + toolbar.offsetHeight,
        closeInside: (() => {
          const c = ov.querySelector('.view-close') as HTMLElement;
          return c.offsetTop >= 0 && c.offsetLeft + c.offsetWidth <= ov.clientWidth;
        })(),
      };
    });
    expect(fit.entries).toBe(s.conductors.length);
    expect(fit.rows).toBe(String(Math.ceil(s.conductors.length / 2)));
    expect(fit.rosterOverflow, 'the roster scrolls or clips').toBeLessThanOrEqual(0);
    expect(fit.rosterDense, 'the roster should fit at the base density today').toBe('cv-roster');
    expect(fit.cardOverflow, 'the card overflows').toBeLessThanOrEqual(0);
    expect(fit.overlayOverflow, 'the overlay overflows').toBeLessThanOrEqual(0);
    expect(fit.aboutVisible).toBe(true);
    expect(fit.overlayTop).toBeGreaterThanOrEqual(fit.toolbarBottom);
    expect(fit.closeInside).toBe(true);
  });

  // 46.9 The sidecar missing degrades both the facts and the explorer, not the exhibit.
  test('46.9 a missing sidecar leaves every fact plain and the by-conductor explorer saying so', async ({ page }) => {
    await page.route('**/data/concerts.json', (route) => route.fulfill({ status: 404, body: 'not here' }));
    await boot(page, 'debug=1&bandOrientation=mirrored&bandTap=chip');
    await awaitConcerts(page);
    expect(await page.evaluate(() => (window as any)._exhibitTest.viewports[0].strips.size)).toBeGreaterThan(0);
    const f = await facts(page);
    expect(f.tap).toBe('chip');
    expect(f.facts).toHaveLength(6);
    expect(f.facts.map((x) => x.tappable)).toEqual([false, false, false, false, false, false]);
    await page.evaluate(() => (window as any)._exhibitTest.setView(0, 'conductors'));
    const ov = await overlay(page, 0, 'conductors');
    await expect(ov.locator('[data-state="unavailable"]')).toHaveCount(1);
    await expect(ov.locator('.view-close')).toHaveCount(1);
    expect(await page.evaluate(() => (window as any)._exhibitTest.conductorsView(0))).toEqual({
      conductor: null, available: false,
    });
  });
});

test.describe('46. The band is the interface — the wordless affordances', () => {
  test.use({ viewport: { width: 1024, height: 1366 }, reducedMotion: 'no-preference' });

  // 46.10 Every A/B candidate renders the same tappable facts wearing its own cue.
  test('46.10 plain, chip, underline, glyph, and shimmer each mark the same six facts in their own way', async ({ page }) => {
    const seen: Record<string, any> = {};
    for (const v of ['plain', 'chip', 'underline', 'glyph', 'shimmer']) {
      await boot(page, `debug=1&bandOrientation=mirrored&bandTap=${v}`);
      await awaitConcerts(page);
      const f = await facts(page);
      expect(f.tap, v).toBe(v);
      expect(f.facts.filter((x) => x.tappable), v).toHaveLength(6);
      seen[v] = await page.evaluate(() => {
        const year = document.querySelector('.mb-cluster[data-cluster="0"] .mb-year.is-tappable') as HTMLElement;
        const name = document.querySelector('.mb-cluster[data-cluster="0"] .mb-conductor.is-tappable') as HTMLElement;
        const face = document.querySelector('.mb-cluster[data-cluster="0"] .mb-portrait.is-tappable') as HTMLElement;
        const cs = (e: Element, p?: string) => getComputedStyle(e, p);
        return {
          cursor: cs(year).cursor,
          border: cs(year).borderTopStyle,
          faceOutline: cs(face).outlineStyle,
          underline: cs(name).textDecorationLine,
          glyph: cs(name, '::after').content,
          animation: cs(name).animationName,
          ringAnimation: cs(face, '::after').animationName,
          text: name.textContent,
          yearText: year.textContent,
        };
      });
    }
    // Every variant is tappable and keeps the facts' own text.
    for (const v of Object.keys(seen)) {
      expect(seen[v].cursor, v).toBe('pointer');
      expect(seen[v].text, v).toBe(seen.plain.text);
      expect(seen[v].yearText, v).toBe(seen.plain.yearText);
    }
    // plain: no cue at all.
    expect(seen.plain.border).toBe('none');
    expect(seen.plain.faceOutline).toBe('none');
    expect(seen.plain.underline).toBe('none');
    expect(seen.plain.glyph).toMatch(/^(none|normal)$/);
    expect(seen.plain.animation).toBe('none');
    // chip: outlined facts, ringed portrait.
    expect(seen.chip.border).toBe('solid');
    expect(seen.chip.faceOutline).toBe('solid');
    expect(seen.chip.underline).toBe('none');
    // underline: the hairline, nothing else.
    expect(seen.underline.underline).toContain('underline');
    expect(seen.underline.border).toBe('none');
    // glyph: the chevron after the fact, not in its text.
    expect(seen.glyph.glyph).toContain('›');
    expect(seen.glyph.underline).toBe('none');
    // shimmer: the sheen and the rim light are animations; the text is untouched.
    expect(seen.shimmer.animation).toBe('band-sheen');
    expect(seen.shimmer.ringAnimation).toBe('band-sheen-ring');
    expect(seen.shimmer.border).toBe('none');
  });
});
