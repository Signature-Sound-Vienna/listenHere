import { test, expect, type Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Section 61 — The explorer zone (?explorers=zone; roadmap 29 step C, 0.132.0)
//
// The split layout's explorers: an always-visible zone above the listening
// zone holds the two choosers (By year / By conductor) behind tabs, and a pick
// opens its card in the SIDE SLOT, which the annotation text also uses. The
// contracts pinned here:
//
//   1. THE A/B RULE: without ?explorers the zone does not exist; the overlay
//      explorers (specs 45 and 46) are unchanged.
//   2. THE ZONE: two tabs, the first on at rest, no card; a tab changes the
//      chooser and never opens a card; the zone folds away to its tab row and
//      a tab (or a band tap) brings it back.
//   3. THE SLOT'S RULINGS (2026-11-19): the card is a hold over the annotation
//      body, which stays mounted underneath; the LAST TAP WINS between a chip
//      and a pick; an automatic entry never replaces the card; the × closes
//      the card first and only then unfocuses; the attract sweep resets all.
//   4. THE MUSEUM GEOMETRY: 1920×1080 with the stage turned 90°, where the
//      strips' caption must clear the toolbar, and where the card scrolls by
//      a finger dragged along its own axis (drag-scroll.js; native touch
//      scroll does not pass through the rotation — spike A).
//
// Geometry is read in each half's LOCAL frame (offsetTop/offsetHeight, which
// transforms do not touch); the rotation only matters to the drag, which
// derives its direction from the card's own head and foot on screen.
// ---------------------------------------------------------------------------

const MUSEUM =
  'debug=1&focus=playhead&detailFade=auto&stageRotation=90&zoomControls=false' +
  '&bandOrientation=mirrored&bandTap=chip&theme=salon&tapMode=direct&strap=on&marker=glass';
const ZONE = `${MUSEUM}&explorers=zone`;

async function boot(page: Page, qs: string) {
  await page.goto(`/exhibit?${qs}`);
  const ok = await page.evaluate(() => (window as any)._exhibitTest.ready);
  expect(ok, 'exhibit boot promise resolved falsy — see console for the error').toBe(true);
}

async function awaitConcerts(page: Page) {
  await page.waitForFunction(() => (window as any)._exhibitTest.concerts != null, null, {
    timeout: 15_000,
  });
}

type ZoneState = { tab: string | null; open: boolean; card: string | null; panelOpen: boolean; slotOpen: boolean };

async function zone(page: Page, i: number): Promise<ZoneState> {
  return page.evaluate((i) => (window as any)._exhibitTest.zone(i), i);
}

async function shownOf(page: Page, i: number) {
  return page.evaluate((i) => (window as any)._exhibitTest.viewports[i].shownId as string | null, i);
}

const vpSel = (i: number) => `.vp[data-viewport="${i}"]`;

/** Is the annotation body in the slot displayed (it stays mounted under a card)? */
async function bodyShows(page: Page, i: number) {
  return page.evaluate((sel) => {
    const b = document.querySelector(`${sel} .vp-side-slot > .ann-body`) as HTMLElement | null;
    return !!b && getComputedStyle(b).display !== 'none';
  }, vpSel(i));
}

/** The first playable year in the sidecar, and a second one, both concerts. */
async function twoPlayableYears(page: Page) {
  return page.evaluate(() => {
    const c = (window as any)._exhibitTest.concerts;
    const ys = [...new Set((c.playableYears as Map<string, number>).values())].sort();
    return ys as number[];
  });
}

/**
 * Local-frame boxes, relative to the half: offsets are layout values, so the
 * stage's rotation does not enter. Returns {top, bottom, left, width, height}.
 */
async function localBoxes(page: Page, i: number, sels: Record<string, string>) {
  return page.evaluate(
    ({ root, sels }) => {
      const abs = (el: HTMLElement) => {
        let x = 0;
        let y = 0;
        for (let e: HTMLElement | null = el; e; e = e.offsetParent as HTMLElement | null) {
          x += e.offsetLeft;
          y += e.offsetTop;
        }
        return { x, y };
      };
      const r = document.querySelector(root) as HTMLElement;
      const o = abs(r);
      const out: Record<string, { top: number; bottom: number; left: number; width: number; height: number } | null> = {};
      for (const [k, s] of Object.entries(sels)) {
        const el = r.querySelector(s) as HTMLElement | null;
        if (!el || el.offsetParent === null) {
          out[k] = null;
          continue;
        }
        const a = abs(el);
        out[k] = {
          top: a.y - o.y,
          bottom: a.y - o.y + el.offsetHeight,
          left: a.x - o.x,
          width: el.offsetWidth,
          height: el.offsetHeight,
        };
      }
      return out;
    },
    { root: vpSel(i), sels },
  );
}

test.describe('61. The explorer zone', () => {
  test.use({ viewport: { width: 1920, height: 1080 } });

  // 61.1 The A/B rule, and the zone at rest.
  test('61.1 without ?explorers there is no zone; with ?explorers=zone each half rests on By year with no card', async ({
    page,
  }) => {
    await boot(page, MUSEUM);
    expect(await page.locator('.vp-zone').count()).toBe(0);
    expect(await page.locator('.vp[data-explorers]').count()).toBe(0);
    expect(await page.evaluate(() => (window as any)._exhibitTest.config.explorers)).toBe('overlay');

    await boot(page, ZONE);
    await awaitConcerts(page);
    const cfg = await page.evaluate(() => {
      const c = (window as any)._exhibitTest.config;
      return { explorers: c.explorers, sideSlot: c.sideSlot, stripHeight: c.stripHeight, viewSwitch: c.viewSwitch };
    });
    // The zone claims the side slot, and the strips give the caption its room.
    expect(cfg).toEqual({ explorers: 'zone', sideSlot: 'annotations', stripHeight: 36, viewSwitch: false });
    expect(await page.locator('.view-switch').count()).toBe(0);
    for (const i of [0, 1]) {
      expect(await zone(page, i)).toEqual({ tab: 'years', open: true, card: null, panelOpen: false, slotOpen: false });
      // The listening view never stands down: the zone sits beside it.
      expect(await page.evaluate((i) => (window as any)._exhibitTest.view(i), i)).toBe('listen');
      const row = page.locator(`${vpSel(i)} .vp-zone-tabs`);
      await expect(row.locator('.zone-lead')).toHaveText('Explore:');
      await expect(row.locator('.zone-tab')).toHaveText(['By year', 'By conductor']);
      await expect(row.locator('.zone-tab.is-on')).toHaveText('By year');
      await expect(row.locator('.zone-close')).toBeVisible();
      await expect(page.locator(`${vpSel(i)} .vp-chooser[data-view="years"]`)).toBeVisible();
      // No card mounted in the slot until a pick asks for one.
      await expect(page.locator(`${vpSel(i)} .vp-side-slot > .vp-card:not([hidden])`)).toHaveCount(0);
    }
    // An explicit ?stripHeight still wins over the zone's 36.
    await boot(page, `${ZONE}&stripHeight=38`);
    expect(await page.evaluate(() => (window as any)._exhibitTest.config.stripHeight)).toBe(38);
  });

  // 61.2 The museum geometry: zone, toolbar, caption, and strips in order.
  test('61.2 at the museum stage the zone is 386 px and the caption clears the toolbar, with the slot shut and open', async ({
    page,
  }) => {
    await boot(page, ZONE);
    await awaitConcerts(page);
    const sels = {
      zone: '.vp-zone',
      toolbar: '.vp-toolbar',
      caption: '.vp-now-section',
      strips: '.strips',
    };
    const check = async (i: number, label: string) => {
      const b = await localBoxes(page, i, sels);
      expect(b.zone, `${label}: zone`).not.toBeNull();
      // The zone's row is 386 px: the panel plus its 10 px gap above the toolbar.
      expect(b.toolbar!.top - b.zone!.top, `${label}: zone row`).toBe(386);
      expect(b.toolbar!.top, `${label}: toolbar below the zone`).toBeGreaterThanOrEqual(b.zone!.bottom);
      if (b.caption) {
        expect(b.caption.top, `${label}: caption clears the toolbar`).toBeGreaterThanOrEqual(b.toolbar!.bottom);
        expect(b.caption.bottom, `${label}: caption above the strips`).toBeLessThanOrEqual(b.strips!.top);
      }
      return b;
    };
    for (const i of [0, 1]) {
      const shut = await check(i, `vp ${i} slot shut`);
      // Open the slot with a card: the zone keeps its full width, the strips narrow.
      const years = await twoPlayableYears(page);
      await page.evaluate(([i, y]) => (window as any)._exhibitTest.setView(i, 'years', { year: y }), [i, years[0]]);
      await expect.poll(async () => (await zone(page, i)).slotOpen).toBe(true);
      await page.waitForTimeout(300);
      const open = await check(i, `vp ${i} slot open`);
      expect(open.zone!.width, 'the zone never narrows').toBe(shut.zone!.width);
      expect(open.strips!.width).toBeLessThan(shut.strips!.width);
    }
  });

  // 61.3 Tabs change the chooser and never open a card.
  test('61.3 a tab shows its chooser and hides the other, without opening a card', async ({ page }) => {
    await boot(page, ZONE);
    await awaitConcerts(page);
    const v = vpSel(0);
    await page.click(`${v} .zone-tab[data-view="conductors"]`);
    await expect.poll(async () => (await zone(page, 0)).tab).toBe('conductors');
    await expect(page.locator(`${v} .vp-chooser[data-view="conductors"]`)).toBeVisible();
    await expect(page.locator(`${v} .vp-chooser[data-view="years"]`)).toBeHidden();
    await expect(page.locator(`${v} .zone-tab.is-on`)).toHaveText('By conductor');
    expect(await zone(page, 0)).toMatchObject({ card: null, slotOpen: false });
    // The roster fills the chooser in three columns (the split layout's roster).
    expect(
      await page.evaluate((v) => {
        const r = document.querySelector(`${v} .vp-chooser .cv-roster`) as HTMLElement;
        return getComputedStyle(r).getPropertyValue('--cv-cols').trim();
      }, v),
    ).toBe('3');
    // The other half is untouched.
    expect((await zone(page, 1)).tab).toBe('years');
    await page.click(`${v} .zone-tab[data-view="years"]`);
    await expect.poll(async () => (await zone(page, 0)).tab).toBe('years');
    await expect(page.locator(`${v} .vp-chooser[data-view="conductors"]`)).toBeHidden();
  });

  // 61.4 A pick opens the card in the slot, over the annotation body.
  test('61.4 a pick in a chooser opens its card in the side slot, hiding the annotation body under it', async ({
    page,
  }) => {
    await boot(page, ZONE);
    await awaitConcerts(page);
    const v = vpSel(0);
    const [year] = await twoPlayableYears(page);
    await page.click(`${v} .vp-chooser[data-view="years"] .yv-cell[data-year="${year}"]`);
    await expect.poll(async () => (await zone(page, 0)).card).toBe('years');
    expect(await zone(page, 0)).toEqual({ tab: 'years', open: true, card: 'years', panelOpen: false, slotOpen: true });
    expect(await page.evaluate(() => (window as any)._exhibitTest.yearsView(0))).toEqual({ year, available: true });
    const card = page.locator(`${v} .vp-side-slot > .vp-card[data-view="years"]`);
    await expect(card).toBeVisible();
    await expect(card.locator('.yv-year')).toContainText(String(year));
    expect(await bodyShows(page, 0)).toBe(false);
    await expect(page.locator(`${v} .side-close`)).toHaveAttribute('aria-label', 'Close the card');
    // The band's cue stands down for the half whose card is showing — only there.
    await expect(page.locator('.middle-band .mb-cluster[data-cluster="0"]')).toHaveAttribute('data-current-view', 'years');
    await expect(page.locator('.middle-band .mb-cluster[data-cluster="1"]')).not.toHaveAttribute('data-current-view', /.+/);

    // A roster pick swaps the card, the conductors tab on.
    await page.click(`${v} .zone-tab[data-view="conductors"]`);
    const name = await page.locator(`${v} .vp-chooser[data-view="conductors"] .cv-entry`).first().getAttribute('data-conductor');
    // The tab alone kept the years card where it was.
    expect((await zone(page, 0)).card).toBe('years');
    await page.click(`${v} .vp-chooser[data-view="conductors"] .cv-entry[data-conductor="${name}"]`);
    await expect.poll(async () => (await zone(page, 0)).card).toBe('conductors');
    expect(await page.evaluate(() => (window as any)._exhibitTest.conductorsView(0))).toEqual({
      conductor: name,
      available: true,
    });
    await expect(page.locator(`${v} .vp-side-slot > .vp-card[data-view="conductors"]`)).toBeVisible();
    await expect(page.locator(`${v} .vp-side-slot > .vp-card[data-view="years"]`)).toBeHidden();
  });

  // 61.5 The last tap wins, and the × closes the card before it unfocuses.
  test('61.5 a chip replaces the card, a pick brings it back, and the × closes the card first and unfocuses second', async ({
    page,
  }) => {
    await boot(page, ZONE);
    await awaitConcerts(page);
    const v = vpSel(0);
    const [year] = await twoPlayableYears(page);
    const cell = `${v} .vp-chooser[data-view="years"] .yv-cell[data-year="${year}"]`;
    await page.click(cell);
    await expect.poll(async () => (await zone(page, 0)).card).toBe('years');

    // A chip: the card gives way, the chip's text shows.
    const chip = page.locator(`${v} .ann-chip`).first();
    const annId = await chip.getAttribute('data-ann');
    await chip.click();
    expect(await zone(page, 0)).toMatchObject({ card: null, panelOpen: true, slotOpen: true });
    expect(await shownOf(page, 0)).toBe(annId);
    expect(await bodyShows(page, 0)).toBe(true);
    await expect(page.locator(`${v} .side-close`)).not.toHaveAttribute('aria-label', 'Close the card');

    // A pick: the card is back over the text, which stays held underneath.
    await page.click(cell);
    await expect.poll(async () => (await zone(page, 0)).card).toBe('years');
    expect(await zone(page, 0)).toMatchObject({ panelOpen: true, slotOpen: true });
    expect(await bodyShows(page, 0)).toBe(false);
    expect(await shownOf(page, 0)).toBe(annId);

    // A tap on the SHOWN chip under a card shows its text rather than toggling it shut.
    await chip.click();
    expect(await zone(page, 0)).toMatchObject({ card: null, panelOpen: true, slotOpen: true });
    expect(await bodyShows(page, 0)).toBe(true);

    // Card back; the first × closes it and the held text is there.
    await page.click(cell);
    await expect.poll(async () => (await zone(page, 0)).card).toBe('years');
    await page.click(`${v} .side-close`);
    expect(await zone(page, 0)).toMatchObject({ card: null, panelOpen: true, slotOpen: true });
    expect(await bodyShows(page, 0)).toBe(true);
    expect(await shownOf(page, 0)).toBe(annId);
    await expect(page.locator('.middle-band .mb-cluster[data-cluster="0"]')).not.toHaveAttribute('data-current-view', /.+/);
    // The second × is the machine's unfocus.
    await page.click(`${v} .side-close`);
    expect(await zone(page, 0)).toMatchObject({ card: null, panelOpen: false, slotOpen: false });
    expect(await shownOf(page, 0)).toBeNull();
  });

  // 61.6 An automatic entry fills the body under the card and never replaces it.
  test('61.6 a wash entry while a card shows fills the hidden body and leaves the card in place', async ({ page }) => {
    await boot(page, ZONE);
    await awaitConcerts(page);
    // A span on the active recording for the half's audience, from the payload.
    const span = await page.evaluate(() => {
      const T = (window as any)._exhibitTest;
      const file = T.transport.activeFile as string;
      // What the half's chips show (its audience's list), as renderAnnotations left it.
      for (const ann of T.viewports[0].currentAnnotations || []) {
        const target = (ann.targets || []).find((t: any) => t.file === file);
        for (const region of ann.regions || []) {
          const s = target?.regionTimes?.[region.id];
          if (s) return { annId: ann.id as string, mid: (s.start + s.end) / 2 };
        }
      }
      return null;
    });
    expect(span, 'the active recording should carry at least one annotated span').not.toBeNull();
    const [year] = await twoPlayableYears(page);
    await page.evaluate((y) => (window as any)._exhibitTest.setView(0, 'years', { year: y }), year);
    await expect.poll(async () => (await zone(page, 0)).card).toBe('years');

    await page.evaluate((t) => (window as any)._exhibitTest.transport.seek(t), span!.mid);
    await expect.poll(() => shownOf(page, 0)).toBe(span!.annId);
    // The entry opened the panel underneath; the card still holds the slot.
    expect(await zone(page, 0)).toMatchObject({ card: 'years', panelOpen: true, slotOpen: true });
    expect(await bodyShows(page, 0)).toBe(false);
    // Closing the card reveals what the clock put there.
    await page.click(`${vpSel(0)} .side-close`);
    expect(await bodyShows(page, 0)).toBe(true);
  });

  // 61.7 The band is still the way in, and still per reader.
  test('61.7 a band tap opens the tapping reader’s half on its card, under the matching tab', async ({ page }) => {
    await boot(page, ZONE);
    await awaitConcerts(page);
    const fact = (i: number, el: string) => `.middle-band .mb-cluster[data-cluster="${i}"] .mb-${el}`;
    await expect(page.locator(fact(1, 'conductor'))).toHaveAttribute('role', 'button');
    await page.click(fact(1, 'conductor'));
    await expect.poll(async () => (await zone(page, 1)).card).toBe('conductors');
    expect(await zone(page, 1)).toMatchObject({ tab: 'conductors', open: true, slotOpen: true });
    await expect(page.locator(`${vpSel(1)} .zone-tab.is-on`)).toHaveText('By conductor');
    // The near half is untouched.
    expect(await zone(page, 0)).toEqual({ tab: 'years', open: true, card: null, panelOpen: false, slotOpen: false });

    await page.click(fact(0, 'year'));
    await expect.poll(async () => (await zone(page, 0)).card).toBe('years');
    const y = await page.evaluate(() => (window as any)._exhibitTest.yearsView(0));
    expect(y.available).toBe(true);
    await expect(page.locator(`${vpSel(0)} .yv-cell[data-year="${y.year}"]`)).toHaveAttribute('aria-pressed', 'true');
  });

  // 61.8 The zone folds away and comes back.
  test('61.8 the zone’s × folds it to its tab row and closes the card; a tab or a band tap reopens it', async ({
    page,
  }) => {
    await boot(page, ZONE);
    await awaitConcerts(page);
    const v = vpSel(0);
    const [year] = await twoPlayableYears(page);
    const before = await localBoxes(page, 0, { zone: '.vp-zone', strips: '.strips' });
    await page.evaluate((y) => (window as any)._exhibitTest.setView(0, 'years', { year: y }), year);
    await expect.poll(async () => (await zone(page, 0)).card).toBe('years');

    await page.click(`${v} .zone-close`);
    expect(await zone(page, 0)).toEqual({ tab: 'years', open: false, card: null, panelOpen: false, slotOpen: false });
    await expect(page.locator(v)).toHaveAttribute('data-zone', 'closed');
    await expect(page.locator(`${v} .vp-zone-body`)).toBeHidden();
    await expect(page.locator(`${v} .zone-close`)).toBeHidden();
    await expect(page.locator(`${v} .zone-tab.is-on`)).toHaveCount(0);
    // The tab row stays, and the listening zone takes the half back.
    await expect(page.locator(`${v} .zone-tab`)).toHaveCount(2);
    const shut = await localBoxes(page, 0, { zone: '.vp-zone', strips: '.strips' });
    expect(shut.zone!.height).toBeLessThan(100);
    expect(shut.strips!.width).toBe(before.strips!.width);
    expect(shut.strips!.top).toBeLessThan(before.strips!.top);

    // A tab reopens the zone on that chooser, with no card.
    await page.click(`${v} .zone-tab[data-view="conductors"]`);
    expect(await zone(page, 0)).toMatchObject({ tab: 'conductors', open: true, card: null, slotOpen: false });
    await expect(page.locator(v)).not.toHaveAttribute('data-zone', /.+/);
    await expect(page.locator(`${v} .vp-chooser[data-view="conductors"]`)).toBeVisible();

    // Folded again, a band tap reopens it WITH the card.
    await page.click(`${v} .zone-close`);
    await page.click('.middle-band .mb-cluster[data-cluster="0"] .mb-year');
    await expect.poll(async () => (await zone(page, 0)).card).toBe('years');
    expect(await zone(page, 0)).toMatchObject({ tab: 'years', open: true, slotOpen: true });
  });

  // 61.9 The attract sweep tidies the zone too.
  test('61.9 the attract sweep closes the card, reopens a folded zone, and rests it on By year', async ({ page }) => {
    // A long idle window: the loop exists but only force() fires it.
    await boot(page, `${ZONE}&attractAfterIdleMs=600000`);
    await awaitConcerts(page);
    await page.evaluate(() => (window as any)._exhibitTest.setView(0, 'conductors', {}));
    await expect.poll(async () => (await zone(page, 0)).card).toBe('conductors');
    await page.click(`${vpSel(1)} .zone-close`);
    expect((await zone(page, 1)).open).toBe(false);

    await page.evaluate(() => (window as any)._exhibitTest.attract.force());
    for (const i of [0, 1]) {
      await expect.poll(() => zone(page, i)).toEqual({
        tab: 'years',
        open: true,
        card: null,
        panelOpen: false,
        slotOpen: false,
      });
      await expect(page.locator(`${vpSel(i)} .vp-chooser[data-view="years"]`)).toBeVisible();
      await expect(page.locator(`.middle-band .mb-cluster[data-cluster="${i}"]`)).not.toHaveAttribute(
        'data-current-view',
        /.+/,
      );
    }
  });

  // 61.10 The card scrolls by a drag along its own axis, through the turned stage.
  test('61.10 a drag scrolls the card on both halves through the rotation, and a drag that starts on Listen does not press it', async ({
    page,
  }) => {
    await boot(page, ZONE);
    await awaitConcerts(page);
    // The longest programme's year, so the card is surely taller than the slot.
    const year = await page.evaluate(() => {
      const c = (window as any)._exhibitTest.concerts;
      const ys = new Set((c.playableYears as Map<string, number>).values());
      let best = null;
      let n = -1;
      for (const y of ys) {
        const k = c.get(y);
        const len = k?.programme?.length ?? 0;
        if (len > n) {
          n = len;
          best = y;
        }
      }
      return best as number;
    });
    for (const i of [0, 1]) {
      await page.evaluate(([i, y]) => (window as any)._exhibitTest.setView(i, 'years', { year: y }), [i, year]);
      await expect.poll(async () => (await zone(page, i)).card).toBe('years');
      await page.waitForTimeout(300);
      const card = `${vpSel(i)} .vp-side-slot > .vp-card[data-view="years"]`;
      // The card's local "down" on screen: from its pinned head to its pinned foot.
      const geo = await page.evaluate((card) => {
        const el = document.querySelector(card) as HTMLElement;
        el.scrollTop = 0;
        const c = (s: string) => {
          const r = (el.querySelector(s) as HTMLElement).getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        };
        const head = c('.yv-head');
        const foot = c('.yv-foot');
        const r = el.getBoundingClientRect();
        const dx = foot.x - head.x;
        const dy = foot.y - head.y;
        const len = Math.hypot(dx, dy);
        return {
          cx: r.left + r.width / 2,
          cy: r.top + r.height / 2,
          ux: dx / len,
          uy: dy / len,
          overflow: el.scrollHeight - el.clientHeight,
          drag: el.dataset.dragScroll ?? null,
          touchAction: getComputedStyle(el).touchAction,
        };
      }, card);
      expect(geo.drag).toBe('1');
      expect(geo.touchAction).toBe('none');
      expect(geo.overflow, 'the card should be taller than the slot').toBeGreaterThan(150);
      // The rotation is a right angle: "down" runs along one screen axis.
      expect(Math.abs(geo.ux) + Math.abs(geo.uy)).toBeCloseTo(1, 2);

      // Drag 150 px toward the card's local TOP: the content follows, so it scrolls down.
      await page.mouse.move(geo.cx, geo.cy);
      await page.mouse.down();
      for (let s = 1; s <= 15; s++) {
        await page.mouse.move(geo.cx - geo.ux * 10 * s, geo.cy - geo.uy * 10 * s);
      }
      const held = await page.evaluate((card) => (document.querySelector(card) as HTMLElement).scrollTop, card);
      await page.mouse.up();
      // 150 px of movement less the 8 px slop, within a pixel of rounding.
      expect(held, `vp ${i}: content follows the finger`).toBeGreaterThanOrEqual(140);
      expect(held).toBeLessThanOrEqual(143);

      // A drag that starts on Listen does not press it; a plain tap does.
      await page.evaluate((card) => {
        const el = document.querySelector(card) as HTMLElement;
        el.scrollTop = 0;
        (window as any)._listens = 0;
        el.querySelector('.yv-listen')!.addEventListener('click', () => ((window as any)._listens += 1));
      }, card);
      await page.waitForTimeout(1300); // any coast from the drag above has settled
      await page.evaluate((card) => ((document.querySelector(card) as HTMLElement).scrollTop = 0), card);
      const listen = await page.locator(`${card} .yv-listen`).boundingBox();
      const lx = listen!.x + listen!.width / 2;
      const ly = listen!.y + listen!.height / 2;
      // 60 px along the card's axis (either way is a drag; this one is pinned at the top).
      await page.mouse.move(lx, ly);
      await page.mouse.down();
      for (let s = 1; s <= 6; s++) await page.mouse.move(lx + geo.ux * 10 * s, ly + geo.uy * 10 * s);
      await page.mouse.up();
      expect(await page.evaluate(() => (window as any)._listens), `vp ${i}: a drag is not a press`).toBe(0);
      // A press that does not travel is still a tap.
      await page.mouse.click(lx, ly);
      expect(await page.evaluate(() => (window as any)._listens), `vp ${i}: a tap still presses`).toBe(1);
    }
  });
});
