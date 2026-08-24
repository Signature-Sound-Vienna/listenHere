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

test.describe('35. Week 2 — the band orientation A/B switch', () => {
  test.use({ viewport: { width: 1024, height: 1366 } });

  // 35.9 ?bandOrientation is the A/B switch for the user testing (user feedback,
  // 2026-08-24): the default stays byte-for-byte the upright band 34.11/34.12
  // pin; "rotated" turns the text blocks 90° and takes the taller band unless
  // the height is explicitly overridden; "mirrored" renders TWO identical
  // clusters, the far one turned 180°, and a selection updates both — the
  // copies must not be able to drift apart.
  test('35.9 the band orientation variants are opt-in and the mirrored copies update in lockstep', async ({
    page,
  }) => {
    // Default: one cluster, upright, the standard height.
    await boot(page);
    const upright = await page.evaluate(() => {
      const band = (window as any)._exhibitTest.band.el;
      return {
        orientation: band.dataset.orientation,
        clusters: band.querySelectorAll('.mb-cluster').length,
        height: Math.round(band.getBoundingClientRect().height),
        writingMode: getComputedStyle(band.querySelector('.mb-who')).writingMode,
      };
    });
    expect(upright.orientation).toBe('upright');
    expect(upright.clusters).toBe(1);
    expect(upright.height).toBe(96);
    expect(upright.writingMode).toBe('horizontal-tb');

    // Rotated: sideways text, the taller default height — and an explicit
    // height override still wins.
    await boot(page, 'debug=1&bandOrientation=rotated');
    const rotated = await page.evaluate(() => {
      const band = (window as any)._exhibitTest.band.el;
      return {
        height: Math.round(band.getBoundingClientRect().height),
        writingMode: getComputedStyle(band.querySelector('.mb-who')).writingMode,
        titles: band.querySelectorAll('.mb-piece-title').length,
      };
    });
    expect(rotated.writingMode).toBe('vertical-rl');
    expect(rotated.height).toBe(176);
    expect(rotated.titles).toBe(1);

    await boot(page, 'debug=1&bandOrientation=rotated&middleBandHeight=120');
    expect(
      await page.evaluate(() =>
        Math.round((window as any)._exhibitTest.band.el.getBoundingClientRect().height),
      ),
    ).toBe(120);

    // Mirrored: two clusters, the second flipped, both updated by a selection.
    await boot(page, 'debug=1&bandOrientation=mirrored');
    const mirrored = await page.evaluate(async () => {
      const T = (window as any)._exhibitTest;
      const band = T.band.el;
      const other = T.exhibit.order.find((f: string) => f !== T.transport.activeFile);
      await T.transport.select(other, 10, /* play */ false);
      const conductors = [...band.querySelectorAll('.mb-conductor')].map(
        (c: any) => c.textContent,
      );
      return {
        clusters: band.querySelectorAll('.mb-cluster').length,
        flippedTransform: getComputedStyle(band.querySelector('.mb-flipped')).transform,
        conductors,
        expected: T.exhibit.metadata.recordings[other].conductor,
        height: Math.round(band.getBoundingClientRect().height),
      };
    });
    expect(mirrored.clusters).toBe(2);
    expect(mirrored.flippedTransform).not.toBe('none'); // the 180° copy
    expect(mirrored.height).toBe(96); // mirroring costs no height
    expect(mirrored.conductors).toEqual([mirrored.expected, mirrored.expected]);
  });
});

test.describe('35. Week 2 — the study panel and themes', () => {
  test.use({ viewport: { width: 1024, height: 1366 } });

  // 35.10 ?studyPanel=true is the in-situ design-discussion tool (user
  // request, 2026-08-24): a cog that opens a tabbed panel of the A/B
  // parameters, where a change rewrites the query string and reloads — the URL
  // is the configuration. Absent by default: a visitor's kiosk must not even
  // fetch the module.
  test('35.10 the study panel is opt-in, tabbed, and a change round-trips through the URL', async ({
    page,
  }) => {
    await boot(page);
    await expect(page.locator('.study-cog')).toHaveCount(0);

    await boot(page, 'debug=1&studyPanel=true');
    const cog = page.locator('.study-cog');
    await expect(cog).toBeVisible();
    // Closed until the cog is tapped — display: flex must not beat [hidden].
    await expect(page.locator('.study-panel')).toBeHidden();
    await cog.click();
    await expect(page.locator('.study-panel')).toBeVisible();
    await expect(page.locator('.study-tab')).toHaveCount(4);

    // Change the band orientation from the Band tab: the page reloads with the
    // parameter in the URL — and the panel REOPENS ITSELF ON THE SAME TAB,
    // because open-state and tab live in localStorage (never in the URL, which
    // is reserved for parameter selections).
    await page.click('.study-tab[data-tab="band"]');
    await page.click('.study-option:has-text("mirrored")');
    await page.waitForURL(/bandOrientation=mirrored/);
    await page.evaluate(() => (window as any)._exhibitTest.ready);
    expect(page.url()).toContain('studyPanel=true'); // the panel param survived
    expect(page.url()).not.toContain('Tab'); // no panel state leaked into the URL
    await expect(page.locator('.study-panel')).toBeVisible(); // reopened itself
    await expect(page.locator('.study-tab[data-tab="band"]')).toHaveClass(/is-on/); // same tab
    expect(
      await page.evaluate(() => (window as any)._exhibitTest.band.el.dataset.orientation),
    ).toBe('mirrored');

    // Choosing the DEFAULT value removes the parameter — the URL stays a
    // minimal diff against the shipped exhibit. No cog click needed: the panel
    // is already open.
    await page.click('.study-option:has-text("upright")');
    await page.waitForURL((u) => !u.toString().includes('bandOrientation'));
    expect(page.url()).toContain('studyPanel=true');
    await expect(page.locator('.study-panel')).toBeVisible();

    // The cog toggles: second click hides, third brings it back — same tab.
    await page.click('.study-cog');
    await expect(page.locator('.study-panel')).toBeHidden();
    await page.click('.study-cog');
    await expect(page.locator('.study-panel')).toBeVisible();
    await expect(page.locator('.study-tab[data-tab="band"]')).toHaveClass(/is-on/);
  });

  // 35.11 ?theme= applies a token set and hands the strips their wave colours.
  // The default stays byte-identical because the dark theme overrides nothing —
  // the CSS token defaults ARE the shipped palette.
  test('35.11 themes are opt-in token sets; the default overrides nothing', async ({ page }) => {
    // The INACTIVE wave colour, so read a strip that is not the preselected
    // reference — the ref boots with the active palette applied.
    const inactiveWave = () =>
      page.evaluate(() => {
        const T = (window as any)._exhibitTest;
        const other = T.exhibit.order.find((f: string) => f !== T.transport.activeFile);
        return T.viewports[0].strips.get(other).ws.options.waveColor;
      });

    await boot(page);
    const dark = await page.evaluate(() => ({
      inlineTokens: document.documentElement.style.length,
      bg: getComputedStyle(document.body).backgroundColor,
    }));
    const darkWave = await inactiveWave();
    expect(dark.inlineTokens).toBe(0); // dark = no overrides at all
    expect(dark.bg).toBe('rgb(11, 11, 12)'); // #0b0b0c, the shipped background
    expect(darkWave).toBe('#5c5c68');

    await boot(page, 'debug=1&theme=light');
    const light = await page.evaluate(() => ({
      bg: getComputedStyle(document.body).backgroundColor,
      token: document.documentElement.style.getPropertyValue('--ex-bg'),
    }));
    const lightWave = await inactiveWave();
    expect(light.token).toBe('#f4f4f6');
    expect(light.bg).toBe('rgb(244, 244, 246)');
    expect(lightWave).not.toBe(darkWave);
  });

  // 35.12 The categories mix independently of the preset — the whole point of
  // slicing the token set: "nord's canvas with dark strips and amber
  // waveforms" is a URL, not an argument. And the band, unpinned, FOLLOWS the
  // theme through its var() chain; pinned, it takes the named palette while
  // everything around it stays put.
  test('35.12 theme categories pin independently on top of the preset', async ({ page }) => {
    await boot(page, 'debug=1&theme=nord&themeStrips=dark&themeWaves=amber&themeBand=sepia');
    const mixed = await page.evaluate(() => {
      const T = (window as any)._exhibitTest;
      const other = T.exhibit.order.find((f: string) => f !== T.transport.activeFile);
      return {
        bg: getComputedStyle(document.body).backgroundColor, // nord canvas
        // :not(.is-active) — the first strip is the preselected reference and
        // carries the ACTIVE surface colour (the 35.11 lesson).
        strip: getComputedStyle(document.querySelector('.strip:not(.is-active)')!).backgroundColor,
        wave: T.viewports[0].strips.get(other).ws.options.waveColor, // amber extra
        band: getComputedStyle(T.band.el).backgroundColor, // sepia band
        panel: getComputedStyle(document.querySelector('.zoom-btn')!).backgroundColor, // nord controls
      };
    });
    expect(mixed.bg).toBe('rgb(46, 52, 64)'); // nord #2e3440
    expect(mixed.strip).toBe('rgb(20, 20, 23)'); // dark #141417 — pinned past nord
    expect(mixed.wave).toBe('#6b5f4a'); // the amber extra's inactive wave
    expect(mixed.band).toBe('rgb(237, 224, 206)'); // sepia #ede0ce, band pinned alone
    expect(mixed.panel).toBe('rgb(59, 66, 82)'); // nord #3b4252 — controls untouched
  });

  // 35.13 ?annotationColors=theme swaps the AUTHORED annotation and group
  // colours for the preset's diverging series — annotations take the FRONT of
  // the series (strongest divergence), the focused annotation's groups
  // continue after the annotation block, and the payload's own objects are
  // never mutated. Default stays authored.
  test('35.13 the theme series recolours annotations and groups without touching the payload', async ({
    page,
  }) => {
    // Default: authored colours reach the chips.
    await boot(page);
    const authored = await page.evaluate(() => {
      const T = (window as any)._exhibitTest;
      const vp = T.viewports[0];
      const ann = T.exhibit.byAudience[vp.el.dataset.audience][0];
      const chip = vp.annList.el.querySelector(`.ann-chip[data-ann="${ann.id}"]`) as HTMLElement;
      return { palette: T.annotationPalette, authored: ann.color, border: chip.style.borderColor };
    });
    expect(authored.palette).toBeNull();
    expect(authored.border).toBeTruthy();

    await boot(page, 'debug=1&annotationColors=theme');
    const themed = await page.evaluate(() => {
      const T = (window as any)._exhibitTest;
      const vp = T.viewports[0];
      const anns = T.exhibit.byAudience[vp.el.dataset.audience];
      const withGroups = anns.findIndex((a: any) => a.grouping?.groups?.length);
      const ann = anns[withGroups];
      // Focus it so the group colours land on the strip edges.
      (vp.annList.el.querySelector(`.ann-chip[data-ann="${ann.id}"]`) as HTMLElement).click();
      const probe = document.createElement('div');
      document.body.appendChild(probe);
      const asRgb = (c: string) => {
        probe.style.borderColor = '';
        probe.style.borderColor = c;
        return getComputedStyle(probe).borderColor;
      };
      const chips = anns.map((a: any, i: number) => ({
        border: (vp.annList.el.querySelector(`.ann-chip[data-ann="${a.id}"]`) as HTMLElement)
          .style.borderColor,
        expected: asRgb(T.annotationPalette[i]),
      }));
      const member = ann.grouping.groups[0].files.find((f: string) => vp.strips.has(f));
      const edge = vp.strips.get(member).el.style.getPropertyValue('--group-color');
      probe.remove();
      return {
        palette: T.annotationPalette,
        chips,
        edge,
        expectedEdge: T.annotationPalette[anns.length], // groups continue after the annotations
        payloadColor: ann.color, // must still be the authored value
      };
    });
    expect(themed.palette).toHaveLength(12);
    for (const c of themed.chips) expect(c.border).toBe(c.expected); // front of the series, in order
    expect(themed.edge).toBe(themed.expectedEdge);
    expect(themed.payloadColor).not.toBe(themed.expectedEdge); // payload untouched
    expect(themed.palette).toContain(themed.edge);
    expect(themed.palette).not.toContain(themed.payloadColor);
  });

  // 35.15 Group information only appears when the annotation has something to
  // SAY about its groups — a group note today, a between-group comparison once
  // those are authored (user feedback 2026-08-24: a bare legend of "New Group"
  // and "Ungrouped" is noise). Legend and strip edges obey the same predicate.
  test('35.15 group legend and strip edges hide when the annotation has no group story', async ({
    page,
  }) => {
    await boot(page);
    const probe = await page.evaluate(() => {
      const T = (window as any)._exhibitTest;
      const vp = T.viewports[0];
      const anns = T.exhibit.byAudience[vp.el.dataset.audience];
      const storyless = anns.find(
        (a: any) =>
          a.grouping?.groups?.length &&
          !Object.values(a.groupNotes || {}).length &&
          !(a.comparisons || []).length,
      );
      (vp.annList.el.querySelector(`.ann-chip[data-ann="${storyless.id}"]`) as HTMLElement).click();
      const strip = [...vp.strips.values()][0];
      return {
        found: !!storyless,
        cards: vp.annList.el.querySelectorAll('.ann-group-card').length,
        hasGroups: vp.annList.el.dataset.hasGroups || '',
        edge: strip.el.style.getPropertyValue('--group-color'),
        grouped: strip.el.dataset.group ?? null,
      };
    });
    expect(probe.found).toBe(true);
    expect(probe.cards).toBe(0);
    expect(probe.hasGroups).toBe('');
    expect(probe.edge).toBe('transparent');
    expect(probe.grouped).toBeNull();

    // And a between-group comparison IS a story: a synthetic annotation with
    // one (none are authored yet — the pipeline carries them, this pins the
    // display path) renders the legend plus the comparison card.
    const cmp = await page.evaluate(() => {
      const T = (window as any)._exhibitTest;
      const vp = T.viewports[0];
      vp.annList.update(
        [
          {
            id: 'fake_cmp',
            label: { en: 'Fake' },
            color: '#3b82f6',
            description: { en: 'x' },
            grouping: {
              name: 'x',
              groups: [
                { groupId: 'A', label: { en: 'Alpha' }, color: '#ede9fe', files: [] },
                { groupId: 'B', label: { en: 'Beta' }, color: '#dbeafe', files: [] },
              ],
            },
            groupNotes: {},
            comparisons: [
              { id: 'c1', leftGroupId: 'A', rightGroupId: 'B', text: { en: 'Alpha broadens the upbeat' } },
            ],
          },
        ],
        'fake_cmp',
      );
      const card = vp.annList.el.querySelector('.ann-comparison-card');
      return {
        hasGroups: vp.annList.el.dataset.hasGroups,
        names: card?.querySelector('.ann-cmp-names')?.textContent,
        text: card?.textContent,
      };
    });
    expect(cmp.hasGroups).toBe('1');
    expect(cmp.names).toBe('Alpha ↔ Beta');
    expect(cmp.text).toContain('Alpha broadens the upbeat');
  });

  // 35.16 ?zoomControls=0 removes the buttons but not the machinery — the
  // setLevel API (and with it the moment-synced scroll) keeps working, so the
  // museum build can drop the chrome without losing the capability.
  test('35.16 zoom buttons are hidable while the zoom machinery stays wired', async ({ page }) => {
    await boot(page, 'debug=1&zoomControls=0');
    await expect(page.locator('.zoom-ctl')).toHaveCount(0);
    const zoomed = await page.evaluate(() => {
      const T = (window as any)._exhibitTest;
      const vp = T.viewports[0];
      vp.zoom.setLevel(4);
      const s = [...vp.strips.values()][0];
      return { full: s.ws.getWrapper().scrollWidth, box: s.host.clientWidth };
    });
    expect(zoomed.full).toBeGreaterThan(zoomed.box * 3.5);
  });

  // 35.17 The band's shared play/pause: one large button in the middle of the
  // band starts and stops the transport, and the current time renders TWICE
  // below it — the far copy rotated 180° so each visitor reads one the right
  // way up (numerals only; the no-labels rule holds).
  test('35.17 the band play button toggles the transport and mirrors the time to both readers', async ({
    page,
  }) => {
    await boot(page);
    const resting = await page.evaluate(() => {
      const times = [...document.querySelectorAll('.mb-time')];
      return {
        count: times.length,
        texts: times.map((t: any) => t.textContent),
        flipped: getComputedStyle(times[1] as Element).transform,
        icon: document.querySelector('.mb-play')!.textContent,
      };
    });
    expect(resting.count).toBe(2);
    expect(resting.texts).toEqual(['0:00', '0:00']);
    expect(resting.flipped).not.toBe('none'); // the far reader's copy
    expect(resting.icon).toBe('▶');

    await page.click('.mb-play');
    await expect
      .poll(() => page.evaluate(() => (window as any)._exhibitTest.transport.playing), {
        timeout: 15_000,
        message: 'the band play button never started the transport',
      })
      .toBe(true);
    await expect(page.locator('.mb-play')).toHaveText('❚❚');
    // Both readouts advance together off the shared clock.
    await expect
      .poll(() =>
        page.evaluate(() => [...document.querySelectorAll('.mb-time')].map((t: any) => t.textContent)),
      )
      .toEqual(['0:01', '0:01']);

    await page.click('.mb-play');
    await expect
      .poll(() => page.evaluate(() => (window as any)._exhibitTest.transport.playing))
      .toBe(false);
    await expect(page.locator('.mb-play')).toHaveText('▶');
  });

  // 35.14 Clicking a PRESET clears every per-category pin back to "follow" —
  // a preset click means "show me that theme", not "that theme corrupted by
  // whatever pins are lying around".
  test('35.14 choosing a preset clears the per-category pins', async ({ page }) => {
    await boot(page, 'studyPanel=true&theme=nord&themeWaves=amber&themeBand=sepia');
    await page.click('.study-cog');
    await page.click('.study-tab[data-tab="theme"]');
    // The preset row is the first row on the Theme tab.
    await page
      .locator('.study-row')
      .first()
      .locator('.study-option', { hasText: 'Warm dark' })
      .click();
    await page.waitForURL(/theme=warm/);
    expect(page.url()).not.toContain('themeWaves');
    expect(page.url()).not.toContain('themeBand');
    expect(page.url()).toContain('studyPanel=true');
  });
});
