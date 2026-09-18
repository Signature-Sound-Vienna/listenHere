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
      if (u.includes('concerts.json') || u.includes('dyk.json') || u.includes('-view.js')) fetched.push(u);
    });
    await boot(page, 'debug=1&bandOrientation=mirrored');
    const f = await facts(page);
    expect(f.clusters).toBe(2);
    expect(f.tap).toBeNull();
    expect(f.facts).toEqual([]);
    expect(f.buttonsInBand, 'only the shared play control is a button').toBe(1);
    expect(await series(page)).toEqual({ fetched: false });
    expect(fetched, 'the shipped mirrored band must not fetch the explorers or their data').toEqual([]);
    expect(await page.locator('.view-back').count()).toBe(0);

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
        closes: document.querySelectorAll('.vp-view .view-back').length,
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
    const close = ov.locator('.view-back');
    await expect(close).toHaveCount(1);
    // A WORD, not an × (user, 2026-09-19): an × says "dismiss", and this goes
    // somewhere. The accessible name is the longer sentence and CONTAINS the
    // visible word, so voice control and the eye agree on what to call it.
    await expect(close).toHaveText('Back');
    const closeLabel = await close.getAttribute('aria-label');
    expect(closeLabel).toMatch(/.+/);
    expect(closeLabel!.toLowerCase()).toContain('back');
    // Behind the overlay the zoom control stands down and the audience switch
    // does not, like 45.2 — the explorer carries text in the reader's register.
    expect(
      await page.evaluate(() => ({
        zoom: getComputedStyle(document.querySelector('.vp[data-viewport="1"] .zoom-ctl')!).visibility,
        audience: getComputedStyle(document.querySelector('.vp[data-viewport="1"] .audience-switch')!).visibility,
      })),
    ).toEqual({ zoom: 'hidden', audience: 'visible' });
    expect(await page.locator('.view-switch').count()).toBe(0);
    // THE KIOSK'S OWN SHAPE — band in, no fallback switch — so the toolbar is
    // uncrowded and the explorer's title shares its strip rather than taking a
    // row of its own: 27 px of card, measured by main.js's fitViewStrip rather
    // than assumed. 46.8 pins the other side of that decision.
    expect(
      await page.evaluate(() => {
        const ov = document.querySelector('.vp[data-viewport="1"] .vp-view') as HTMLElement;
        const toolbar = document.querySelector('.vp[data-viewport="1"] .vp-toolbar') as HTMLElement;
        const h = ov.querySelector('.cv-heading') as HTMLElement;
        // LAYOUT OFFSETS, NOT PAINTED ONES. This is the FAR half: it is rotated
        // 180°, so its painted left and right are each other's, and a
        // `right <= left` comparison on client rects reports a collision that
        // is not there. offsetLeft does not know about the rotation, which is
        // exactly what makes it right — the same reason main.js measures the
        // strip that way. Only the text's WIDTH comes from a rect, and a width
        // survives being turned upside down.
        const range = document.createRange();
        range.selectNodeContents(h);
        const textWidth = range.getBoundingClientRect().width;
        const headingRight = ov.offsetLeft + h.offsetLeft + textWidth;
        const first = Math.min(...[...toolbar.children].map((c) => (c as HTMLElement).offsetLeft));
        return {
          strip: ov.dataset.stripHeading ?? null,
          clears: headingRight <= first,
          // …and the title sits ON the controls' line rather than above or below.
          sameLine: Math.abs((ov.offsetTop + h.offsetTop) - toolbar.offsetTop) <= 12,
        };
      }),
    ).toEqual({ strip: '1', clears: true, sameLine: true });
    await close.click();
    await expect(page.locator('.vp[data-viewport="1"] .vp-view')).toHaveCount(0);
    expect(await page.evaluate(() => (window as any)._exhibitTest.view(1))).toBe('listen');
    await expect(page.locator('.vp[data-viewport="1"] .audience-switch')).toBeVisible();
    // Re-entering reuses the built explorer (no second close control, one overlay).
    await page.click(fact(1, 'conductor'));
    await overlay(page, 1, 'conductors');
    expect(await page.locator('.vp[data-viewport="1"] .view-back').count()).toBe(1);
  });

  // 46.3b The Back control shares the toolbar's strip but belongs to the OVERLAY,
  // which is drawn under the toolbar — so a toolbar control that reaches that far
  // paints straight over it. Reported from a kiosk running ?zoomControls=0
  // (2026-09-19): without the zoom buttons the audience switch ran to the bar's
  // edge and the Back button vanished underneath it. A count or a visibility
  // check would have passed the whole time — the element was there, the right
  // size, and completely covered — so this HIT-TESTS the middle of it.
  test('46.3b the Back control is reachable however few controls the toolbar carries', async ({
    page,
  }) => {
    for (const qs of [
      'debug=1&bandOrientation=mirrored&bandTap=plain',
      'debug=1&bandOrientation=mirrored&bandTap=plain&zoomControls=0',
    ]) {
      await boot(page, qs);
      await awaitConcerts(page);
      await page.click(fact(0, 'conductor'));
      await overlay(page, 0, 'conductors');
      const seen = await page.evaluate(() => {
        const vp = document.querySelector('.vp[data-viewport="0"]') as HTMLElement;
        const back = vp.querySelector('.view-back') as HTMLElement;
        const box = back.getBoundingClientRect();
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return { onTop: hit?.classList.contains('view-back') ?? false, width: Math.round(box.width) };
      });
      expect(seen.onTop, `?${qs}: something is painted over the Back control`).toBe(true);
      expect(seen.width).toBeGreaterThan(0);
      // …and it still does its job from under whatever is up there.
      await page.locator('.vp[data-viewport="0"] .view-back').click();
      await expect(page.locator('.vp[data-viewport="0"] .vp-view')).toHaveCount(0);
    }
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
        // The count badge is gone since 0.70.0 — the number rides in the years
        // phrase instead, so this asserts the badge is not merely empty but absent.
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
      expect(r.years, c.name).toBe(
        c.years.length <= 3
          ? c.years.join(', ')
          : `${c.first}–${c.last} (${c.years.length} concerts)`,
      );
      expect(r.count, c.name).toBeNull();
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
      // One mark on these cells since 0.66.0, like the by-year grid's: playable.
      expect(cell.programme, `year ${cell.year}`).toBe(false);
      // REVERSED 2026-09-18 (user, by name: "I cannot imagine that
      // inter-explorer-navigation will not be wanted"). Plan §11(f) had made
      // these marks so the October testing would not compare two navigations at
      // once; they are buttons into the by-year explorer now, and 46.15 walks
      // the round trip. This line is left as an assertion rather than deleted so
      // the reversal is recorded where the old ruling was.
      expect(cell.button, 'years on the card are navigation (plan §11(f), reversed)').toBe(true);
    }
    expect(await card.locator('.cv-role').count()).toBe(most.roles.length ? 1 : 0);
    if (most.roles.length) await expect(card.locator('.cv-role')).toHaveText(most.roles.join(' · '));

    // A conductor with a portrait: shown large, no label added to the medallion.
    // Since 0.68.0 that is ONE sitting per conductor rather than one per
    // recording, and the year against it is the PHOTOGRAPH's — which is sometimes
    // not knowable at all (the BnF dates Boskovsky's plate 1936 while dating the
    // ensemble in it from 1948), so the attribute is absent rather than wrong.
    const faced = s.conductors.find((c) => c.portraits.length > 0);
    expect(faced, 'fixture needs a conductor with a portrait').toBeTruthy();
    if (faced) {
      await ov.locator(`.cv-entry[data-conductor="${faced.name}"]`).click();
      await expect(card).toHaveAttribute('data-conductor', faced.name);
      const latest = faced.portraits[faced.portraits.length - 1];
      const medallion = card.locator('.cv-medallion-large');
      if (latest.year == null) {
        expect(await medallion.getAttribute('data-portrait-year')).toBeNull();
      } else {
        await expect(medallion).toHaveAttribute('data-portrait-year', String(latest.year));
      }
      expect(await card.locator('.cv-portrait').getAttribute('src')).toContain(latest.path.split('/').pop()!);
      expect(await card.locator('[data-ai-label]').count()).toBe(0);
      expect(await card.locator('.cv-sitting').count()).toBe(faced.portraits.length > 1 ? faced.portraits.length : 0);
    }
    // The one portraits sentence, once per explorer (plan §11(d)) — since 0.68.0
    // it carries the photograph's credit rather than explaining the AI mark.
    await expect(ov.locator('.cv-about')).toContainText('photographs from Wikimedia Commons');
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
        // The overlay FILLS the half since 2026-09-18 and keeps the toolbar's
        // strip clear as padding, so what has to hold is that the CONTENT still
        // starts below the toolbar — see 45.2, which pins the box itself.
        contentTop: ov.offsetTop + parseFloat(getComputedStyle(ov).paddingTop),
        toolbarBottom: toolbar.offsetTop + toolbar.offsetHeight,
        // THE HEADING SHARES THE TOOLBAR'S STRIP at this geometry (user,
        // 2026-09-19), which is worth 27 px of card. It is a MEASURED decision
        // (main.js fitViewStrip), so both halves are pinned: that it happened,
        // and that the title actually clears the leftmost control rather than
        // running under it — the failure mode is a title behind the audience
        // chips, which no overflow check would ever report.
        stripHeading: ov.dataset.stripHeading ?? null,
        headingClears: (() => {
          const h = vp.querySelector('.cv-heading') as HTMLElement;
          const range = document.createRange();
          range.selectNodeContents(h);
          // Layout offsets, like 46.3 — see the note there about the far half's
          // rotation. Only the width comes from a rect.
          const right = ov.offsetLeft + h.offsetLeft + range.getBoundingClientRect().width;
          const first = Math.min(...[...toolbar.children].map((c) => (c as HTMLElement).offsetLeft));
          return ov.dataset.stripHeading !== '1' || right <= first;
        })(),
        closeInside: (() => {
          const c = ov.querySelector('.view-back') as HTMLElement;
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
    expect(fit.contentTop).toBeGreaterThanOrEqual(fit.toolbarBottom);
    // THE NEGATIVE CASE, and it is the point of measuring rather than assuming:
    // `?views=` forces the fallback switch on (a view you cannot leave is a
    // trap), so this toolbar carries a THIRD control and there is no longer room
    // beside it for a 329 px title. The heading keeps its own row, and the card
    // gives back the 27 px. 46.3 pins the positive case, at the kiosk's own
    // entry, where the band is the way in and the switch is absent.
    expect(fit.stripHeading, 'a crowded toolbar must push the heading back to its own row').toBeNull();
    expect(fit.headingClears, 'the heading runs under the toolbar’s controls').toBe(true);
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
    await expect(ov.locator('.view-back')).toHaveCount(1);
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

  // 46.11 A working fact answers the tap at once (user, 2026-09-03): the
  // `is-acknowledged` class runs a 400 ms bloom of a hairline frame (::before)
  // and is cleared soon after, on every cue alike — the cue says "tappable",
  // the acknowledgement "tapped". Read in the same evaluate as the click, so
  // the 400 ms window cannot slip past the assertion.
  test('46.11 a tap on a working fact is acknowledged for a moment, on every cue', async ({ page }) => {
    for (const v of ['plain', 'shimmer']) {
      await boot(page, `debug=1&bandOrientation=mirrored&bandTap=${v}`);
      await awaitConcerts(page);
      const r = await page.evaluate(() => {
        const q = (sel: string) => document.querySelector(`.mb-cluster[data-cluster="0"] ${sel}`) as HTMLElement;
        const year = q('.mb-year.is-tappable');
        const face = q('.mb-portrait.is-tappable');
        year.click();
        const yb = getComputedStyle(year, '::before');
        face.click();
        const fb = getComputedStyle(face, '::before');
        return {
          yearOn: year.classList.contains('is-acknowledged'), yearFrame: yb.animationName, yearRadius: yb.borderRadius,
          faceOn: face.classList.contains('is-acknowledged'), faceFrame: fb.animationName, faceRadius: fb.borderRadius,
          // Read on the OTHER reader's copy: this reader's stands down for the explorer it opened (46.12).
          sheen: getComputedStyle(document.querySelector('.mb-cluster[data-cluster="1"] .mb-conductor.is-tappable') as HTMLElement).animationName,
        };
      });
      expect(r.yearOn, v).toBe(true);
      expect(r.yearFrame, v).toBe('band-ack-frame');
      expect(r.yearRadius, v).toBe('999px');
      expect(r.faceOn, v).toBe(true);
      expect(r.faceFrame, v).toBe('band-ack-frame');
      expect(r.faceRadius, v).toBe('50%');
      // The acknowledgement leaves the cue's own animation alone.
      expect(r.sheen, v).toBe(v === 'shimmer' ? 'band-sheen' : 'none');
      // Cleared by time, both of them.
      await expect(page.locator('.mb-cluster[data-cluster="0"] .is-acknowledged')).toHaveCount(0);
      // And the taps did their work: the last one opened the by-conductor explorer.
      expect(await page.evaluate(() => (window as any)._exhibitTest.view(0))).toBe('conductors');
    }
  });

  // 46.12 The fact whose explorer this reader's half is showing stands its
  // shimmer down (user, 2026-09-03), on that reader's copy only; the other
  // reader's copy and the other fact keep shimmering, and back in the
  // listening view everything shimmers again. Mirrored only, by construction
  // (cluster = viewport), which is the only orientation shimmer exists in.
  test("46.12 under shimmer the fact that opened this half's explorer stops shimmering until the half returns", async ({ page }) => {
    await boot(page, 'debug=1&bandOrientation=mirrored&bandTap=shimmer');
    await awaitConcerts(page);
    const anims = () => page.evaluate(() => {
      const a = (c: number, sel: string, p?: string) =>
        getComputedStyle(document.querySelector(`.mb-cluster[data-cluster="${c}"] ${sel}`) as HTMLElement, p).animationName;
      return {
        year0: a(0, '.mb-year.is-tappable'), name0: a(0, '.mb-conductor.is-tappable'), ring0: a(0, '.mb-portrait.is-tappable', '::after'),
        year1: a(1, '.mb-year.is-tappable'), name1: a(1, '.mb-conductor.is-tappable'), ring1: a(1, '.mb-portrait.is-tappable', '::after'),
        current0: (document.querySelector('.mb-cluster[data-cluster="0"]') as HTMLElement).dataset.currentView ?? null,
      };
    });
    const all = { year0: 'band-sheen', name0: 'band-sheen', ring0: 'band-sheen-ring', year1: 'band-sheen', name1: 'band-sheen', ring1: 'band-sheen-ring' };
    expect(await anims()).toEqual({ ...all, current0: null });

    await page.evaluate(() => (window as any)._exhibitTest.setView(0, 'years'));
    await expect(page.locator('.vp[data-viewport="0"] .vp-view[data-view="years"]')).toBeAttached();
    expect(await anims()).toEqual({ ...all, year0: 'none', current0: 'years' });

    await page.evaluate(() => (window as any)._exhibitTest.setView(0, 'conductors'));
    await expect(page.locator('.vp[data-viewport="0"] .vp-view[data-view="conductors"]')).toBeAttached();
    expect(await anims()).toEqual({ ...all, name0: 'none', ring0: 'none', current0: 'conductors' });

    await page.evaluate(() => (window as any)._exhibitTest.setView(0, 'listen'));
    expect(await anims()).toEqual({ ...all, current0: null });
  });
});

test.describe('46. The band is the interface — a single reader', () => {
  test.use({ viewport: { width: 1024, height: 1366 } });

  // 46.15 ONE VIEWPORT (0.66.0, user 2026-09-18). The mirrored requirement
  // exists only so a tap can be told apart between two facing readers; with one
  // viewport there is one reader, so the single cluster's facts are attributable
  // whatever the orientation. Before this, a one-viewport table had no way into
  // the explorers but ?viewSwitch=1, and the band said so in a warning.
  test('46.15 with one viewport the band’s facts are tappable upright, and open that reader’s explorer', async ({
    page,
  }) => {
    const warnings: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'warning') warnings.push(m.text());
    });
    await boot(page, 'debug=1&viewports=1&bandTap=plain');
    await awaitConcerts(page);
    const f = await facts(page);
    expect(f.tap, 'bandTap was resolved away at a single viewport').toBe('plain');
    expect(f.clusters).toBe(1);
    expect(f.facts.length).toBeGreaterThan(0);
    expect(f.facts.every((x) => x.tappable)).toBe(true);
    expect(
      warnings.some((w) => w.includes('bandTap') && w.includes('mirrored')),
      'the mirrored warning fired at a single viewport',
    ).toBe(false);

    // The year opens the one reader's by-year explorer, on the audible concert.
    const s = await series(page);
    await page.click(fact(0, 'year'));
    await overlay(page, 0, 'years');
    expect(await page.evaluate(() => (window as any)._exhibitTest.view(0))).toBe('years');
    expect(await page.evaluate(() => (window as any)._exhibitTest.yearsView(0).year)).toBe(
      s.playableYears[s.activeFile],
    );
    // And the fact that opened it stands its cue down on that one cluster too.
    expect(
      await page.evaluate(
        () => (document.querySelector('.mb-cluster') as HTMLElement).dataset.currentView ?? null,
      ),
    ).toBe('years');

    // The conductor opens the other explorer, from the same one cluster.
    await page.locator('.vp[data-viewport="0"] .view-back').click();
    await page.click(fact(0, 'conductor'));
    await overlay(page, 0, 'conductors');
    expect(await page.evaluate(() => (window as any)._exhibitTest.view(0))).toBe('conductors');
    expect(await page.evaluate(() => (window as any)._exhibitTest.conductorsView(0).conductor)).toBe(
      s.metadata[s.activeFile].conductor,
    );
  });
});

test.describe('46. The by-conductor explorer — "did you know?"', () => {
  test.use({ viewport: { width: 1024, height: 1366 } });

  // 46.13 The roster's mark, the story in the card, and the placeholder figure.
  // The text side is pinned by 45.10–45.12 — one module (dyk.js), the same block
  // in both explorers. What is only testable here is the FIGURE: two of the
  // twelve stories refer to a photograph the exhibit may not show, so what is
  // drawn is a frame at the picture's own shape.
  test('46.13 conductors with a story show it under their facts; one with a picture gets a placeholder frame and caption', async ({
    page,
  }) => {
    await boot(page, 'debug=1&views=conductors,listen');
    const ov = await overlay(page, 0, 'conductors');
    const content = await page.evaluate(() => {
      const d = (window as any)._exhibitTest.dyk;
      if (!d) return null;
      const withImage: string[] = [];
      const without: string[] = [];
      for (const [name, e] of d.conductors) (e.image ? withImage : without).push(name);
      return { all: [...d.conductors.keys()], withImage, without };
    });
    expect(content, 'the "did you know?" content did not load').not.toBeNull();
    expect(content!.withImage.length).toBeGreaterThan(0);
    expect(content!.without.length).toBeGreaterThan(0);

    // Exactly the conductors who have one, and no others.
    const marked = await ov.locator('.cv-entry[data-dyk="1"]').evaluateAll((els) =>
      els.map((e) => (e as HTMLElement).dataset.conductor).sort(),
    );
    expect(marked).toEqual([...content!.all].sort());

    const story = ov.locator('.cv-detail .dyk');

    // One with a picture: the frame is a PLACEHOLDER at the picture's own
    // aspect, it says so, and the caption is there. Nothing derives a fact from
    // it (the portraits README's rule 3) — hence no img.
    const withPic = content!.withImage[0];
    await ov.locator(`.cv-entry[data-conductor="${withPic}"]`).click();
    await expect(story).toBeVisible();
    const fig = story.locator('.dyk-figure');
    await expect(fig).toHaveAttribute('data-status', 'placeholder');
    await expect(fig.locator('figcaption')).not.toBeEmpty();
    await expect(fig.locator('.dyk-pending')).toBeVisible();
    expect(await fig.locator('img').count()).toBe(0);
    const shape = await page.evaluate((name) => {
      const d = (window as any)._exhibitTest.dyk;
      const [w, h] = d.forConductor(name).image.aspect;
      const frame = document.querySelector('.vp[data-viewport="0"] .dyk-frame') as HTMLElement;
      const box = frame.getBoundingClientRect();
      return { want: w / h, got: box.width / box.height };
    }, withPic);
    expect(Math.abs(shape.got - shape.want), 'the frame is not at the picture’s aspect').toBeLessThan(0.05);
    // Conductors have no subtitle to be an eyebrow — that is a year's hook.
    await expect(story.locator('.dyk-eyebrow')).toBeHidden();
    // Under their facts, and above the way into their music.
    expect(
      await page.evaluate(() => {
        const kids = [...document.querySelectorAll('.vp[data-viewport="0"] .cv-detail > *')].map(
          (e) => e.className.split(' ')[0],
        );
        return {
          afterYears: kids.indexOf('dyk') > kids.indexOf('cv-years'),
          beforeFoot: kids.indexOf('cv-foot') === -1 || kids.indexOf('dyk') < kids.indexOf('cv-foot'),
        };
      }),
    ).toEqual({ afterYears: true, beforeFoot: true });
    // The card does not scroll; only the story may, and it says when it does.
    const fits = await page.evaluate(() => {
      const vp = document.querySelector('.vp[data-viewport="0"]') as HTMLElement;
      const detail = vp.querySelector('.cv-detail') as HTMLElement;
      const dyk = vp.querySelector('.dyk') as HTMLElement;
      const body = vp.querySelector('.dyk-body') as HTMLElement;
      return {
        cardOverflow: detail.scrollHeight - detail.clientHeight,
        scrolls: body.scrollHeight > body.clientHeight + 1,
        flagged: dyk.dataset.scroll ?? null,
      };
    });
    expect(fits.cardOverflow).toBeLessThanOrEqual(0);
    expect(fits.flagged).toBe(fits.scrolls ? '1' : null);

    // One with a story but no picture: text, no figure.
    await ov.locator(`.cv-entry[data-conductor="${content!.without[0]}"]`).click();
    await expect(story.locator('.dyk-text')).not.toBeEmpty();
    expect(await story.locator('.dyk-figure').count()).toBe(0);

    // One with no story at all: no mark, and nothing in the card.
    const none = await page.evaluate(() => {
      const T = (window as any)._exhibitTest;
      return T.concerts.conductors.map((c: any) => c.name).find((n: string) => !T.dyk.forConductor(n));
    });
    expect(none, 'every conductor has a story — this assertion needs a new subject').toBeTruthy();
    await ov.locator(`.cv-entry[data-conductor="${none}"]`).click();
    await expect(story).toBeHidden();
    expect(await ov.locator(`.cv-entry[data-conductor="${none}"][data-dyk="1"]`).count()).toBe(0);
  });

  // 46.14 ?dykImages=off — the knob is over the PICTURE, never over the text
  // (user, 2026-09-18: the text is content and always on), and it is on the
  // study panel's Views tab where the explorers' knobs live.
  test('46.14 ?dykImages=off drops the figure and keeps the story; the Views tab carries the row', async ({
    page,
  }) => {
    await boot(page, 'debug=1&views=conductors,listen&dykImages=off&studyPanel=true');
    const ov = await overlay(page, 0, 'conductors');
    const withPic = await page.evaluate(() => {
      const d = (window as any)._exhibitTest.dyk;
      for (const [name, e] of d.conductors) if (e.image) return name;
      return null;
    });
    expect(withPic).toBeTruthy();
    await ov.locator(`.cv-entry[data-conductor="${withPic}"]`).click();
    const story = ov.locator('.cv-detail .dyk');
    await expect(story).toBeVisible();
    await expect(story.locator('.dyk-text')).not.toBeEmpty();
    expect(await story.locator('.dyk-figure').count(), 'the figure survived dykImages=off').toBe(0);
    // The story itself is untouched by the knob: the content still carries the
    // picture, the view simply does not draw it.
    expect(await page.evaluate((n) => !!(window as any)._exhibitTest.dyk.forConductor(n).image, withPic)).toBe(true);

    // And the row is on the Views tab, where the explorers' knobs live, showing
    // the value the URL asked for (35.29 counts the tab's rows).
    await page.click('.study-cog');
    await page.click('.study-tab[data-tab="views"]');
    const row = page.locator('.study-row').filter({ has: page.locator('.study-label', { hasText: 'Did-you-know images' }) });
    await expect(row).toHaveCount(1);
    await expect(row.locator('.study-option.is-on')).toHaveText('off');
  });
});

// ---------------------------------------------------------------------------
// 46.15 THE EXPLORERS INTERLINK (user, 2026-09-18) — plan §11(f)'s "the facets
// are marks, not buttons" reversed by name. The band stays the way IN; this is
// the way ACROSS, and it has to land on the RIGHT fact in the SAME half, or it
// is worse than no link at all.
// ---------------------------------------------------------------------------

test.describe('46. The explorers interlink', () => {
  test.use({ viewport: { width: 1024, height: 1366 } });

  test('46.15 a year on a conductor\'s card opens by-year on that concert, and its conductor opens by-conductor back on them', async ({
    page,
  }) => {
    await boot(page, 'debug=1&bandOrientation=mirrored&bandTap=shimmer');
    await awaitConcerts(page);
    const s = await series(page);
    if (!s.available) throw new Error('sidecar unavailable');

    // In through the band, as a visitor does — the NEAR reader's portrait, so
    // everything that follows must stay in viewport 0.
    await page.click(fact(0, 'portrait'));
    const conductors = await overlay(page, 0, 'conductors');

    // A conductor with more than one concert, so the year we tap is a CHOICE
    // and not the only thing the link could possibly have landed on.
    const many = s.conductors.find((c) => c.years.length > 1);
    expect(many, 'fixture needs a conductor with two or more concerts').toBeTruthy();
    await conductors.locator(`.cv-entry[data-conductor="${many!.name}"]`).click();
    const wanted = many!.years[0];

    const cell = conductors.locator(`.cv-year[data-year="${wanted}"]`);
    // A real button with a real name: the numerals are all a sighted visitor
    // needs, and all a screen reader would get without this.
    await expect(cell).toHaveAttribute('aria-label', new RegExp(String(wanted)));
    const box = await cell.boundingBox();
    expect(box!.width, 'the year cell is a touch target now').toBeGreaterThanOrEqual(40);
    expect(box!.height, 'the year cell is a touch target now').toBeGreaterThanOrEqual(40);
    await cell.click();

    const years = await overlay(page, 0, 'years');
    await expect(years.locator('.yv-detail')).toHaveAttribute('data-year', String(wanted));
    // THE OTHER HALF IS UNTOUCHED. A link that opened the far reader's screen
    // would be the same bug the band's attribution exists to prevent.
    expect(await page.locator('.vp[data-viewport="1"] .vp-view').count()).toBe(0);

    // …and back the other way, onto the conductor we came from.
    const face = years.locator('.yv-conductor-face');
    await expect(face).toHaveAttribute('aria-label', new RegExp(many!.name.split(' ').pop()!));
    expect(await face.evaluate((e) => e.tagName)).toBe('BUTTON');
    await face.click();
    const back = await overlay(page, 0, 'conductors');
    await expect(back.locator('.cv-detail')).toHaveAttribute('data-conductor', many!.name);
    expect(await page.locator('.vp[data-viewport="1"] .vp-view').count()).toBe(0);

    // The "With …" line is NOT inside the conductor's button: those are the
    // other performers, and a tap there must not claim to be about the
    // conductor (years-view.js says so where the DOM is built).
    await back.locator(`.cv-year[data-year="${wanted}"]`).click();
    const again = await overlay(page, 0, 'years');
    expect(await again.locator('.yv-conductor-face .yv-with').count()).toBe(0);
  });
});
