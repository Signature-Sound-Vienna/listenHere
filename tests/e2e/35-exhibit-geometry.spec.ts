import { test, expect, type Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Section 35 — Week 2: the doubled-up geometry (plan §4.2)
//
// Everything here is about how the exhibit occupies and maps the screen —
// starting with the desktop-debug stage rotation, with per-viewport zoom and
// scroll to follow. Driven through `window._exhibitTest` like spec 34, and for
// the same reasons (shadow-root canvases, state with no visible text).
//
// 35.1/35.2 pin the STAGE ROTATION (?stageRotation=90|270): a final-touch
// transform on #screen alone, added so a physically turned laptop or a
// swivelled desktop monitor can show the portrait kiosk at its intended
// aspect. The contract worth pinning is not the pretty picture — it is that
// the rotation is composited AFTER layout (so nothing inside re-measures) and
// that the browser maps pointer coordinates back through it (so taps still
// land). If either half broke, the feature would silently poison every
// debugging session run through it.
// ---------------------------------------------------------------------------

/** Navigate to the exhibit and wait for the boot sequence to finish. */
async function boot(page: Page, qs = 'debug=1') {
  await page.goto(`/exhibit?${qs}`);
  const ok = await page.evaluate(() => (window as any)._exhibitTest.ready);
  expect(ok, 'exhibit boot promise resolved falsy — see console for the error').toBe(true);
  return page.evaluate(() => {
    const T = (window as any)._exhibitTest;
    return {
      order: T.exhibit.order as string[],
      ref: T.exhibit.piece.ref as string,
    };
  });
}

test.describe('35. Week 2 geometry — stage rotation', () => {
  // A LANDSCAPE window, deliberately — the laptop case the stage rotation
  // exists for, unlike spec 34's portrait-kiosk 1024×1366.
  test.use({ viewport: { width: 1366, height: 1024 } });

  // 35.1 The rotated screen fills the landscape window edge to edge, the
  // rotation demonstrably happened after layout (a strip's painted rect is
  // tall and thin while its layout box stays wide and short), and a tap on a
  // strip still reaches it through the transform.
  test('35.1 ?stageRotation=90 composites the portrait screen into a landscape window and taps still land', async ({
    page,
  }) => {
    const { order } = await boot(page, 'debug=1&stageRotation=90');

    const shape = await page.evaluate(() => {
      const T = (window as any)._exhibitTest;
      const screen = document.getElementById('screen')!;
      const stripEl = [...T.viewports[0].strips.values()][0].el as HTMLElement;
      const painted = stripEl.getBoundingClientRect();
      return {
        dataset: screen.dataset.stageRotation,
        screenRect: screen.getBoundingClientRect().toJSON(),
        // offsetWidth/Height are LAYOUT values, untouched by transforms —
        // getBoundingClientRect is the PAINTED box. The pair is the proof that
        // the rotation is a final composite and not a re-layout.
        stripLayout: { w: stripEl.offsetWidth, h: stripEl.offsetHeight },
        stripPainted: { w: painted.width, h: painted.height },
      };
    });

    expect(shape.dataset).toBe('90');
    // Fills the landscape window: the painted screen is the window, ±1px of
    // rounding. If the translate half of the transform were wrong the screen
    // would sit entirely off-viewport and these would be wildly out.
    expect(Math.abs(shape.screenRect.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(shape.screenRect.y)).toBeLessThanOrEqual(1);
    expect(shape.screenRect.width).toBeCloseTo(1366, 0);
    expect(shape.screenRect.height).toBeCloseTo(1024, 0);
    // Layout unrotated (wide, strip-height tall), paint rotated (thin, tall).
    expect(shape.stripLayout.w).toBeGreaterThan(shape.stripLayout.h);
    expect(shape.stripPainted.h).toBeGreaterThan(shape.stripPainted.w);
    expect(shape.stripPainted.w).toBeCloseTo(shape.stripLayout.h, 0);

    // The half that matters for debugging THROUGH the rotation: Playwright
    // clicks the painted box, the browser maps the point back through the
    // transform, and the strip's own handler must fire as if nothing happened.
    const [, second] = order;
    await page.click(`.vp[data-viewport="0"] .strip[data-file="${second}"] .strip-ws`);
    await expect
      .poll(() => page.evaluate(() => (window as any)._exhibitTest.transport.activeFile), {
        message: 'a tap through the stage rotation never reached the strip',
      })
      .toBe(second);
  });

  // 35.2 The kiosk guard: without the parameter there is no transform at all,
  // and an angle the CSS cannot place is refused rather than half-applied.
  test('35.2 stage rotation is opt-in and only 90/270 are honoured', async ({ page }) => {
    await boot(page);
    const plain = await page.evaluate(() => {
      const screen = document.getElementById('screen')!;
      return {
        dataset: screen.dataset.stageRotation ?? null,
        transform: getComputedStyle(screen).transform,
      };
    });
    expect(plain.dataset).toBeNull();
    expect(plain.transform).toBe('none');

    await boot(page, 'debug=1&stageRotation=45');
    const bad = await page.evaluate(() => {
      const screen = document.getElementById('screen')!;
      return {
        dataset: screen.dataset.stageRotation ?? null,
        transform: getComputedStyle(screen).transform,
      };
    });
    expect(bad.dataset).toBeNull();
    expect(bad.transform).toBe('none');
  });
});

test.describe('35. Week 2 geometry — per-viewport zoom and scroll', () => {
  test.use({ viewport: { width: 1024, height: 1366 } });

  // 35.3 Zoom anchors on the playhead: after zooming, every strip's viewport is
  // centred on the moment the transport is at — projected per recording, so the
  // centres are DIFFERENT times that mean the same place in the piece. And
  // zooming back out must land at an exact fit: the naive width/duration
  // arithmetic leaves the wrapper one pixel wider than the container with a
  // stuck scroll of 1 (reproduced on the first probe of this feature; the spec
  // 28.3 bug), which is why fitting goes through engine/zoom-fit.js.
  test('35.3 zoom centres the playhead moment on every strip, and zoom-out returns to an exact fit', async ({
    page,
  }) => {
    const { ref } = await boot(page);
    const probe = await page.evaluate(async (ref) => {
      const T = (window as any)._exhibitTest;
      await T.transport.select(ref, 120, /* play */ false);
      const vp = T.viewports[0];
      vp.zoom.setLevel(4);
      const expected = T.positionsFor(120, ref);
      const zoomed = [...vp.strips.entries()].map(([file, s]: [string, any]) => {
        const wrapper = s.ws.getWrapper();
        const box = s.host.clientWidth;
        const full = wrapper.scrollWidth;
        return {
          file,
          full,
          box,
          centreTime: ((s.ws.getScroll() + box / 2) / full) * s.duration,
          expected: expected[file],
        };
      });
      vp.zoom.setLevel(1);
      const refit = [...vp.strips.values()].map((s: any) => ({
        full: s.ws.getWrapper().scrollWidth,
        box: s.host.clientWidth,
        scroll: s.ws.getScroll(),
      }));
      return { zoomed, refit };
    }, ref);

    for (const s of probe.zoomed) {
      expect(s.full, `${s.file} did not actually zoom`).toBeGreaterThan(s.box * 3.5);
      // Half a second of tolerance: a pixel of scroll is ~0.15 s at 4×, and the
      // projection itself is the same function the expectation used.
      expect(
        Math.abs(s.centreTime - s.expected),
        `${s.file} centred on ${s.centreTime}, expected ~${s.expected}`,
      ).toBeLessThan(0.5);
    }
    for (const s of probe.refit) {
      expect(s.full, 'zoom-out left the one-pixel overflow').toBeLessThanOrEqual(s.box);
      expect(s.scroll, 'zoom-out left a stuck scroll').toBe(0);
    }
  });

  // 35.4 Scrolling ONE strip while zoomed re-places the other seven on the
  // same musical moment — the exhibit's whole claim, extended to scroll. The
  // scroll is a real container scroll (what a touch pan produces), not a call
  // into the sync code.
  test('35.4 panning one zoomed strip re-centres every other strip on the same moment', async ({
    page,
  }) => {
    const { order } = await boot(page);
    const [, fileB] = order;
    await page.evaluate((fileB) => {
      const T = (window as any)._exhibitTest;
      T.viewports[0].zoom.setLevel(4);
      // Wait past the controller's own sync lock (two frames), then pan.
      return new Promise<void>((resolve) =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              const s = T.viewports[0].strips.get(fileB);
              s.ws.setScroll(1500);
              resolve();
            }),
          ),
        ),
      );
    }, fileB);

    await expect
      .poll(
        () =>
          page.evaluate((fileB) => {
            const T = (window as any)._exhibitTest;
            const vp = T.viewports[0];
            const centre = (s: any) => {
              const full = s.ws.getWrapper().scrollWidth;
              const box = s.host.clientWidth;
              return ((s.ws.getScroll() + box / 2) / full) * s.duration;
            };
            const src = vp.strips.get(fileB);
            const srcCentre = centre(src);
            let worst = 0;
            for (const [f, s] of vp.strips) {
              if (f === fileB) continue;
              const expected = T.projectPlayhead(srcCentre, fileB, [f])[f];
              worst = Math.max(worst, Math.abs(centre(s) - expected));
            }
            return worst;
          }, fileB),
        { message: 'the other strips never synced to the panned strip’s moment' },
      )
      .toBeLessThan(0.5);
  });

  // 35.5 The minimum-width floor on regions is a pixel quantity, so its span in
  // seconds must SHRINK when the viewport zooms in — a floor computed once at
  // fit-to-width and never re-derived would draw the hand-placement region
  // eight times too wide at 8×.
  test('35.5 the widened-region floor is re-derived at the new zoom level', async ({ page }) => {
    const { ref } = await boot(page);
    await page.click('.audience-switch[data-viewport="0"] .audience-btn[data-audience="expert"]');
    const span = (rid: string) =>
      page.evaluate(
        ({ ref, rid }) => {
          const T = (window as any)._exhibitTest;
          const r = T.viewports[0].strips
            .get(ref)
            .regions.getRegions()
            .find((r: any) => r.id.endsWith(rid));
          return r ? r.end - r.start : null;
        },
        { ref, rid },
      );

    const atFit = await span('rgn_msvors30_2');
    expect(atFit).not.toBeNull();
    await page.evaluate(() => (window as any)._exhibitTest.viewports[0].zoom.setLevel(8));
    const at8x = await span('rgn_msvors30_2');
    expect(at8x).not.toBeNull();
    expect(at8x!, `floor did not shrink: ${atFit} -> ${at8x}`).toBeLessThan(atFit! / 6);
    expect(at8x!).toBeGreaterThan(0);
  });

  // 35.6 The buttons: finger-sized, per-viewport, and honest about their range.
  // Zooming viewport 0 must not touch viewport 1 — audience taught this lesson
  // (34.4), and zoom is the same per-viewport contract.
  test('35.6 the zoom buttons step one viewport without moving the other', async ({ page }) => {
    await boot(page);
    const outBtn = page.locator('.zoom-ctl[data-viewport="0"] .zoom-btn[data-zoom="zoom-out"]');
    const inBtn = page.locator('.zoom-ctl[data-viewport="0"] .zoom-btn[data-zoom="zoom-in"]');
    await expect(outBtn).toBeDisabled(); // already at fit
    await inBtn.click();

    const state = await page.evaluate(() => {
      const T = (window as any)._exhibitTest;
      const widthsOf = (vp: any) =>
        [...vp.strips.values()].map((s: any) => s.ws.getWrapper().scrollWidth);
      return {
        level0: T.viewports[0].zoom.level(),
        level1: T.viewports[1].zoom.level(),
        readout0: document.querySelector('.zoom-ctl[data-viewport="0"] .zoom-level')!.textContent,
        vp0Zoomed: widthsOf(T.viewports[0]).every(
          (w: number, i: number) => w > [...T.viewports[0].strips.values()][i].host.clientWidth,
        ),
        vp1Widths: widthsOf(T.viewports[1]),
        vp1Boxes: [...T.viewports[1].strips.values()].map((s: any) => s.host.clientWidth),
      };
    });
    expect(state.level0).toBe(2);
    expect(state.readout0).toBe('2×');
    expect(state.vp0Zoomed).toBe(true);
    expect(state.level1).toBe(1);
    expect(state.vp1Widths).toEqual(state.vp1Boxes); // still at fit, nothing overflows
    await expect(outBtn).toBeEnabled();
  });
});

test.describe('35. Week 2 — the commentary panel', () => {
  test.use({ viewport: { width: 1024, height: 1366 } });

  // 35.7 The two constraints the panel was built around (annotation-list.js):
  // focusing the LONGEST commentary in the payload (measured 1640 chars) moves
  // nothing above the panel, and the text is reachable to its end by scrolling
  // INSIDE the panel — not clipped, not growing the layout.
  test('35.7 focusing the longest commentary shifts nothing and scrolls internally', async ({
    page,
  }) => {
    await boot(page);
    await page.click('.audience-switch[data-viewport="0"] .audience-btn[data-audience="expert"]');

    const before = await page.evaluate(() => {
      const T = (window as any)._exhibitTest;
      const vp = T.viewports[0];
      // The longest description in the current audience, found not hardcoded,
      // so a re-authored payload keeps this test honest.
      const anns = T.exhibit.byAudience[vp.el.dataset.audience];
      const longest = anns.reduce((a: any, b: any) =>
        (b.description?.en || '').length > (a.description?.en || '').length ? b : a,
      );
      return {
        longestId: longest.id,
        stripTop: [...vp.strips.values()][0].el.getBoundingClientRect().top,
        panelTop: vp.annList.el.getBoundingClientRect().top,
      };
    });

    await page.click(`.ann-panel[data-viewport="0"] .ann-chip[data-ann="${before.longestId}"]`);

    const after = await page.evaluate(() => {
      const T = (window as any)._exhibitTest;
      const vp = T.viewports[0];
      const detail = vp.annList.el.querySelector('.ann-detail') as HTMLElement;
      detail.scrollTop = 40;
      return {
        stripTop: [...vp.strips.values()][0].el.getBoundingClientRect().top,
        panelTop: vp.annList.el.getBoundingClientRect().top,
        scrollable: detail.scrollHeight > detail.clientHeight,
        scrolled: detail.scrollTop,
      };
    });

    expect(after.stripTop, 'strips moved when the commentary was focused').toBe(before.stripTop);
    expect(after.panelTop, 'the panel itself moved').toBe(before.panelTop);
    expect(after.scrollable, 'the long commentary is not internally scrollable').toBe(true);
    expect(after.scrolled).toBeGreaterThan(0);
  });

  // 35.8 The group cards are the LEGEND for the strip-edge colours: same
  // annotation, same groups, same resolved colour — and the authored group
  // notes (payload `groupNotes`, keyed by groupId) are what actually explains
  // the comparison. "Die Glocke" is the annotation that carries them today.
  test('35.8 group-note cards name the groups, carry their notes, and match the strip-edge colours', async ({
    page,
  }) => {
    await boot(page);
    const ann = await page.evaluate(() => {
      const T = (window as any)._exhibitTest;
      return T.exhibit.annotations.find((a: any) => a.groupNotes && Object.keys(a.groupNotes).length);
    });
    expect(ann, 'no annotation with groupNotes left in the payload — re-point this test').toBeTruthy();

    await page.click(`.ann-panel[data-viewport="0"] .ann-chip[data-ann="${ann.id}"]`);

    const shown = await page.evaluate((annId) => {
      const T = (window as any)._exhibitTest;
      const vp = T.viewports[0];
      const a = T.exhibit.annotations.find((x: any) => x.id === annId);
      const cards = [...vp.annList.el.querySelectorAll('.ann-group-card')].map((c: any) => ({
        name: c.querySelector('.ann-group-name')?.textContent,
        note: c.querySelector('.ann-group-note')?.textContent || '',
        bg: getComputedStyle(c).backgroundColor,
      }));
      // Normalise each group's payload colour through the same computed-style
      // path, so hex-vs-rgb never fails the comparison spuriously.
      const probe = document.createElement('div');
      document.body.appendChild(probe);
      const groups = a.grouping.groups.map((g: any) => {
        probe.style.backgroundColor = '';
        probe.style.backgroundColor = g.color;
        const bg = getComputedStyle(probe).backgroundColor;
        const member = (g.files || []).find((f: string) => vp.strips.has(f));
        const stripEl = member ? vp.strips.get(member).el : null;
        // The strip edge's custom property, normalised through the same
        // computed-style path as everything else here.
        probe.style.backgroundColor = '';
        probe.style.backgroundColor = stripEl?.style.getPropertyValue('--group-color') || '';
        const stripEdgeBg = getComputedStyle(probe).backgroundColor;
        return {
          id: g.groupId,
          label: g.label?.en,
          note: a.groupNotes?.[g.groupId]?.en || '',
          bg,
          stripGroup: stripEl?.dataset.group ?? null,
          stripEdgeBg,
        };
      });
      probe.remove();
      return { cards, groups };
    }, ann.id);

    expect(shown.cards.length).toBe(shown.groups.length);
    for (const g of shown.groups) {
      const card = shown.cards.find((c: any) => c.name === g.label);
      expect(card, `no card for group "${g.label}"`).toBeTruthy();
      if (g.note) expect(card!.note).toContain(g.note);
      expect(card!.bg, `card colour diverged from the payload for "${g.label}"`).toBe(g.bg);
      // And the strip edge agrees: the member strip is painted with the same
      // group id and colour the card is explaining.
      expect(g.stripGroup).toBe(g.id);
      expect(g.stripEdgeBg, `strip edge colour diverged from the card for "${g.label}"`).toBe(g.bg);
    }
  });
});
