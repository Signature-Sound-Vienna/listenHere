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
    // 5 tabs since week 3 added Turns (spec 36's subject) to the panel.
    await expect(page.locator('.study-tab')).toHaveCount(5);

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
        // The new focus shape (agreed 2026-08-25): the cards read shownId.
        { paintId: 'fake_cmp', shownId: 'fake_cmp', pinned: true },
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

  // 35.25 The footer's Defaults button is the staff DEBUG preset (user,
  // 2026-08-25) — a RESET, not a merge: the whole query becomes the preset,
  // other experiments drop away, and the exhibit boots under it. The shipped
  // config defaults are untouched by this feature (they stay the A/B baseline
  // the • markers point at).
  test('35.25 the Defaults button resets the URL to the staff debug preset', async ({ page }) => {
    await boot(page, 'studyPanel=true&stripHeight=60');
    await page.click('.study-cog');
    await page.click('.study-defaults');
    await page.waitForURL(/turnPolicy=attribution/);
    const search = await page.evaluate(() => location.search);
    for (const pair of [
      'focus=playhead',
      'studyPanel=true',
      'sideSlot=annotations',
      'detailFade=auto',
      'stageRotation=90',
      'zoomControls=false',
      'bandOrientation=mirrored',
      'annotationColors=theme',
      'turnPolicy=attribution',
      'audienceAll=true',
      'pinExpiry=auto',
    ]) {
      expect(search).toContain(pair);
    }
    expect(search).not.toContain('stripHeight'); // a reset, not a merge
    const ok = await page.evaluate(() => (window as any)._exhibitTest.ready);
    expect(ok, 'the exhibit boots under the preset').toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 35.18–35.20 pin the TAP→TIME MAPPING through the exhibit's transforms
// (feedback round 2, 2026-08-24). The bug they guard: WaveSurfer's own
// `interaction` event computes the tapped position as `clientX −
// boundingRect.left` over the PAINTED box, which is transform-naive — on the
// 180° viewport a tap seeked to `duration − t` (the playhead landing
// mirror-image from the finger), and under ?stageRotation every tap collapsed
// to the visual x-axis. strips.js now owns the mapping (`interact: false` +
// offsetX + the scroll offset); these pin the three geometries that proved it:
// fit-width in both viewport rotations, the stage rotation, and zoom+scroll.
//
// The mapped time is read at the seam the fix owns: `transport.select` is
// wrapped to record its arguments (and to pass play=false, so no audio loads
// and nothing asynchronous can race the read — the transport's own emissions
// arrive on their own schedule and poisoned two earlier drafts of these pins).
// Tolerance ±2 s: one pixel at fit-width is ~0.58 s, and offsetX is integer.
// ---------------------------------------------------------------------------

/** Record every select() a tap produces, without starting audio. */
async function armTapRecorder(page: Page) {
  await page.evaluate(() => {
    const T = (window as any)._exhibitTest;
    (window as any)._taps = [];
    const orig = T.transport.select.bind(T.transport);
    T.transport.select = (file: string, time: number) => {
      (window as any)._taps.push({ file, time });
      return orig(file, time, false);
    };
  });
}

/** Click at a fraction of the strip host's PAINTED (visual) box. */
async function clickStripAt(page: Page, vp: number, file: string, fx: number, fy = 0.5) {
  const box = await page
    .locator(`.vp[data-viewport="${vp}"] .strip[data-file="${file}"] .strip-ws`)
    .boundingBox();
  await page.mouse.click(box!.x + fx * box!.width, box!.y + fy * box!.height);
}

async function lastTap(page: Page) {
  return page.evaluate(() => (window as any)._taps.at(-1) as { file: string; time: number });
}

test.describe('35. Feedback round 2 — tap-to-seek through transforms', () => {
  test.use({ viewport: { width: 1024, height: 1366 } });

  // 35.18 The far (180°) viewport seeks to the moment DRAWN under the finger.
  // A tap at 25% of the painted box sits on content at 75% of the recording
  // there — the drawn waveform is rotated with the viewport. The unrotated
  // half is the control: same visual fraction, mirrored expectation.
  test('35.18 a tap seeks to the drawn moment under the finger in both viewport rotations', async ({
    page,
  }) => {
    const { ref } = await boot(page);
    const duration = await page.evaluate(
      () => (window as any)._exhibitTest.exhibit.durations[(window as any)._exhibitTest.exhibit.piece.ref] as number,
    );

    await armTapRecorder(page);
    await clickStripAt(page, 0, ref, 0.25);
    expect(Math.abs((await lastTap(page)).time - 0.25 * duration)).toBeLessThanOrEqual(2);

    await clickStripAt(page, 1, ref, 0.25);
    expect(
      Math.abs((await lastTap(page)).time - 0.75 * duration),
      'the 180° viewport seeked mirror-image from the finger — the transform-naive mapping is back',
    ).toBeLessThanOrEqual(2);

    // Both taps were on the already-active strip: position honoured, no switch.
    const active = await page.evaluate(() => (window as any)._exhibitTest.transport.activeFile);
    expect(active).toBe(ref);
  });

  // 35.20 The scroll term: zoomed in and panned, the mapping must add the
  // scroll offset to the (viewport-relative) offsetX. The expectation is
  // derived independently from the painted box and the scroll the test set,
  // not from the implementation's own internals.
  test('35.20 tap-to-seek holds while zoomed and scrolled', async ({ page }) => {
    const { ref } = await boot(page);
    const duration = await page.evaluate(
      () => (window as any)._exhibitTest.exhibit.durations[(window as any)._exhibitTest.exhibit.piece.ref] as number,
    );
    const box = await page
      .locator(`.vp[data-viewport="0"] .strip[data-file="${ref}"] .strip-ws`)
      .boundingBox();

    const scrollPx = 400;
    await page.evaluate((s) => {
      const T = (window as any)._exhibitTest;
      T.viewports[0].zoom.setLevel(2);
      T.viewports[0].strips.get(T.exhibit.piece.ref).ws.setScroll(s);
    }, scrollPx);
    await page.waitForTimeout(200); // let the re-render and the scroll settle

    await armTapRecorder(page);
    await clickStripAt(page, 0, ref, 0.25);
    const expected = ((scrollPx + 0.25 * box!.width) / (2 * box!.width)) * duration;
    expect(Math.abs((await lastTap(page)).time - expected)).toBeLessThanOrEqual(2);
  });
});

test.describe('35. Feedback round 2 — tap-to-seek through the stage rotation', () => {
  // The landscape laptop case, like 35.1 — the whole screen turned 90°, so a
  // strip's local time axis runs visually DOWN the painted (tall, thin) box.
  test.use({ viewport: { width: 1366, height: 1024 } });

  // 35.19 Before the fix every tap here collapsed to the visual x-axis (any
  // position on the strip seeked to ~50% — the strip's visual centre), so the
  // pin is that the position ALONG the strip is what maps: 25% down the
  // painted box is 25% of the recording on the unrotated viewport, and 75% on
  // the 180° one (its composite is 270°, so its time axis runs visually up).
  test('35.19 taps through ?stageRotation=90 map along the strip axis in both viewports', async ({
    page,
  }) => {
    const { ref } = await boot(page, 'debug=1&stageRotation=90');
    const duration = await page.evaluate(
      () => (window as any)._exhibitTest.exhibit.durations[(window as any)._exhibitTest.exhibit.piece.ref] as number,
    );

    await armTapRecorder(page);
    await clickStripAt(page, 0, ref, 0.5, 0.25);
    expect(Math.abs((await lastTap(page)).time - 0.25 * duration)).toBeLessThanOrEqual(2);

    await clickStripAt(page, 1, ref, 0.5, 0.25);
    expect(Math.abs((await lastTap(page)).time - 0.75 * duration)).toBeLessThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// 35.21/35.22 pin the GENERIC SIDE SLOT (?sideSlot=<tenant>, feedback item 5,
// reshaped by the follow-up feedback). The screen is a MAIN CONTENT area
// (toolbar + strips, full width or sharing with the side panel) over a BELOW
// CONTENT area (the chips, always). The panel holds only the tenant's content
// — the commentary body: text plus the group story, which is ALWAYS visible
// when relevant (no fold control) — and visibility follows main.js's machine:
// chip focuses + opens, the same chip toggles the panel KEEPING focus, and
// the panel's × is the one unfocus. What is worth pinning: the default DOM is
// unchanged, an unknown tenant changes nothing, the split puts chips below
// and body beside, the strips genuinely change width with the panel (exact
// fit both ways — the spec-28.3 discipline), and the machine's transitions,
// including keeping focus through a close and refitting a ZOOMED strip.
// ---------------------------------------------------------------------------

test.describe('35. Feedback round 2 — the generic side slot', () => {
  test.use({ viewport: { width: 1024, height: 1366 } });

  /** Layout facts read in LAYOUT coordinates (offset*), transform-free. */
  async function slotLayout(page: Page, vpIndex: number) {
    return page.evaluate((i) => {
      const T = (window as any)._exhibitTest;
      const vp = T.viewports[i];
      const slot = vp.el.querySelector('.vp-side-slot') as HTMLElement;
      const strip = [...vp.strips.values()][0];
      return {
        open: vp.el.dataset.sideOpen === '1',
        slotVisible: !!slot && getComputedStyle(slot).display !== 'none',
        stripsRight: vp.stripsEl.offsetLeft + vp.stripsEl.offsetWidth,
        slotLeft: slot ? slot.offsetLeft : null,
        slotWidth: slot ? slot.offsetWidth : null,
        vpWidth: vp.el.clientWidth,
        hostW: strip.host.clientWidth,
        wrapperW: strip.ws.getWrapper().clientWidth,
        scroll: strip.ws.getScroll(),
        // Manual mode: the sticky detail (shownId) IS the old single focus.
        focusedId: vp.shownId,
      };
    }, vpIndex);
  }

  test('35.21 the side slot is opt-in and tenant-checked; opening splits chips below from the body beside, exact fit both ways', async ({
    page,
  }) => {
    // Default: no slot, no close control, body inside the below-strips panel.
    await boot(page);
    expect(await page.locator('.vp-side-slot').count()).toBe(0);
    expect(await page.locator('.side-close').count()).toBe(0);
    expect(await page.locator('.vp > .ann-panel .ann-body').count()).toBe(2);

    // An unknown tenant must not reshape the layout for an empty column.
    await boot(page, 'debug=1&sideSlot=bogus');
    expect(await page.locator('.vp-side-slot').count()).toBe(0);
    expect(await page.locator('.vp > .ann-panel .ann-body').count()).toBe(2);

    // Slot mode, resting state: chips below in BOTH viewports, the body
    // relocated into the (closed) panel, strips at FULL width and exactly fit.
    await boot(page, 'debug=1&sideSlot=annotations');
    expect(await page.locator('.vp-side-slot[data-tenant="annotations"]').count()).toBe(2);
    expect(await page.locator('.vp > .ann-panel').count()).toBe(2);
    expect(await page.locator('.vp > .ann-panel .ann-body').count()).toBe(0);
    expect(await page.locator('.vp-side-slot .ann-body').count()).toBe(2);
    const rest = await slotLayout(page, 0);
    expect(rest.open).toBe(false);
    expect(rest.slotVisible).toBe(false);
    expect(rest.wrapperW).toBe(rest.hostW);
    // Full width: the strips span their viewport's content box (± padding).
    expect(rest.stripsRight).toBeGreaterThan(0.9 * rest.vpWidth);

    // Focus a chip: the panel opens in THIS viewport only, columns disjoint,
    // the narrowed strips exactly fit again, and the text is on show.
    // The first chip the DEFAULT audience actually shows — the payload's own
    // first annotation belongs to another audience and has no chip here.
    const first = await page.evaluate(
      () => (window as any)._exhibitTest.exhibit.byAudience.adults[0].id,
    );
    const chipsRow = page.locator('.vp[data-viewport="0"] > .ann-panel');
    const rowBefore = await chipsRow.boundingBox();
    await page.click(`.ann-panel[data-viewport="0"] .ann-chip[data-ann="${first}"]`);
    const open = await slotLayout(page, 0);
    expect(open.open).toBe(true);
    expect(open.slotVisible).toBe(true);
    expect(open.stripsRight).toBeLessThanOrEqual(open.slotLeft!);
    expect(Math.abs(open.slotWidth! - 0.4 * open.vpWidth)).toBeLessThanOrEqual(12);
    expect(open.wrapperW).toBe(open.hostW);
    expect(open.scroll).toBe(0);
    await expect(
      page.locator('.vp[data-viewport="0"] .vp-side-slot .ann-detail'),
    ).toBeVisible();
    expect((await slotLayout(page, 1)).open).toBe(false);

    // The no-bounce rule (user feedback): the panel changes the main area's
    // WIDTH only. The chips row must hold its exact vertical band — position
    // and height — through open and close alike.
    const rowOpen = await chipsRow.boundingBox();
    expect(rowOpen!.y).toBe(rowBefore!.y);
    expect(rowOpen!.height).toBe(rowBefore!.height);
    await page.click('.vp[data-viewport="0"] .side-close');
    const rowClosed = await chipsRow.boundingBox();
    expect(rowClosed!.y).toBe(rowBefore!.y);
    expect(rowClosed!.height).toBe(rowBefore!.height);
  });

  test('35.22 the chip toggles the panel keeping focus, × is the one unfocus, and a zoomed strip refits on both transitions', async ({
    page,
  }) => {
    await boot(page, 'debug=1&sideSlot=annotations');
    // An annotation WITH a group story, so "focus kept" is observable on the
    // strip edges (the same recipe as 35.8), and the group cards are ALWAYS
    // visible while it is focused and open — the fold control is gone.
    const ann = await page.evaluate(() => {
      const T = (window as any)._exhibitTest;
      return T.exhibit.annotations.find((a: any) => a.groupNotes && Object.keys(a.groupNotes).length);
    });
    expect(ann, 'no annotation with groupNotes left in the payload — re-point this test').toBeTruthy();

    const chip = page.locator(`.ann-panel[data-viewport="0"] .ann-chip[data-ann="${ann.id}"]`);
    const facts = () =>
      page.evaluate(() => {
        const T = (window as any)._exhibitTest;
        const vp = T.viewports[0];
        const edges = [...vp.strips.values()].filter(
          (s: any) => s.el.style.getPropertyValue('--group-color') !== 'transparent',
        ).length;
        const strip = [...vp.strips.values()][0];
        return {
          open: vp.el.dataset.sideOpen === '1',
          // Manual mode: the sticky detail (shownId) IS the old single focus.
          focusedId: vp.shownId,
          edges,
          hostW: strip.host.clientWidth,
          wrapperW: strip.ws.getWrapper().clientWidth,
        };
      });

    // chip → focus + open. Edges painted, group cards on show, no fold control.
    await chip.click();
    let f = await facts();
    expect(f.open).toBe(true);
    expect(f.focusedId).toBe(ann.id);
    expect(f.edges).toBeGreaterThan(0);
    await expect(
      page.locator('.vp[data-viewport="0"] .vp-side-slot .ann-group-card').first(),
    ).toBeVisible();
    expect(await page.locator('.ann-details-toggle').count()).toBe(0);

    // chip again → panel CLOSED, focus KEPT: highlights stay while the strips
    // go back to full width — and stay exactly fit at the new width.
    const narrowW = f.hostW;
    await chip.click();
    f = await facts();
    expect(f.open).toBe(false);
    expect(f.focusedId, 'closing via the chip must keep focus').toBe(ann.id);
    expect(f.edges).toBeGreaterThan(0);
    expect(f.hostW).toBeGreaterThan(narrowW);
    expect(f.wrapperW).toBe(f.hostW);

    // chip a third time → reopen, still focused.
    await chip.click();
    f = await facts();
    expect(f.open).toBe(true);
    expect(f.focusedId).toBe(ann.id);

    // × → the ONE unfocus: panel closed, highlights cleared, full width.
    await page.click('.vp[data-viewport="0"] .side-close');
    f = await facts();
    expect(f.open).toBe(false);
    expect(f.focusedId).toBeNull();
    expect(f.edges).toBe(0);
    expect(f.wrapperW).toBe(f.hostW);

    // The zoomed case: a 2× strip's pixels-per-second is derived from its
    // container width, so opening the panel must REFIT — wrapper ≈ 2× the
    // narrowed width, not 2× the stale full width (the spec-28 failure mode).
    await page.evaluate(() => (window as any)._exhibitTest.viewports[0].zoom.setLevel(2));
    await chip.click();
    f = await facts();
    expect(f.open).toBe(true);
    expect(Math.abs(f.wrapperW - 2 * f.hostW)).toBeLessThanOrEqual(2);
    await page.click('.vp[data-viewport="0"] .side-close');
    f = await facts();
    expect(Math.abs(f.wrapperW - 2 * f.hostW)).toBeLessThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// 35.23 pins the AUDIENCE UNION MODE (?audienceAll=1, feedback item 4): an
// opt-in fourth switch position that shows every audience's annotations at
// once, each chip marked with the audience it targets — the one mode where
// the switch position no longer implies that fact. "all" is a UI pseudo-mode:
// the payload, its byAudience partition, and the default three-way switch are
// untouched, and the other viewport keeps filtering independently.
// ---------------------------------------------------------------------------

test.describe('35. Feedback round 2 — the audience union mode', () => {
  test.use({ viewport: { width: 1024, height: 1366 } });

  test('35.23 "All" is opt-in, unions the annotations with audience markers, and leaves the other viewport filtering', async ({
    page,
  }) => {
    const btns = (vp: number) => `.audience-switch[data-viewport="${vp}"] .audience-btn`;

    // Default: the shipped three-way switch, no "all" anywhere.
    await boot(page);
    expect(await page.locator(btns(0)).count()).toBe(3);
    expect(await page.locator('[data-audience="all"]').count()).toBe(0);

    await boot(page, 'debug=1&audienceAll=1');
    expect(await page.locator(btns(0)).count()).toBe(4);
    const adultsRegions = await page.evaluate(() => {
      const T = (window as any)._exhibitTest;
      return [...T.viewports[0].strips.values()][0].regions.getRegions().length;
    });

    await page.click(`${btns(0)}[data-audience="all"]`);
    const shown = await page.evaluate(() => {
      const T = (window as any)._exhibitTest;
      const chip = (vp: number) => [
        ...T.viewports[vp].annList.el.querySelectorAll('.ann-chip'),
      ];
      return {
        vp0: chip(0).map((c: any) => ({
          ann: c.dataset.ann,
          marker: c.querySelector('.ann-chip-audience')?.textContent ?? null,
        })),
        vp1Chips: chip(1).length,
        vp1Markers: T.viewports[1].annList.el.querySelectorAll('.ann-chip-audience').length,
        annotations: T.exhibit.annotations.map((a: any) => ({ id: a.id, audience: a.audience })),
        allRegions: [...T.viewports[0].strips.values()][0].regions.getRegions().length,
      };
    });

    // The union, in the payload's own order, every chip marked with ITS
    // audience — through the same catalogue the switch buttons use, so the
    // marker can never disagree with the button the visitor just left.
    const names: Record<string, string> = { kids: 'Kids', adults: 'Adults', expert: 'Scholars' };
    expect(shown.vp0.map((c: any) => c.ann)).toEqual(shown.annotations.map((a: any) => a.id));
    for (let i = 0; i < shown.vp0.length; i++) {
      expect(shown.vp0[i].marker).toBe(names[shown.annotations[i].audience]);
    }
    // Every audience's regions are on the strips now, not just one filter's.
    expect(shown.allRegions).toBeGreaterThan(adultsRegions);
    // The far half neither gained the mode nor the markers: audience stays
    // per viewport (plan §5.3).
    expect(shown.vp1Chips).toBe(3);
    expect(shown.vp1Markers).toBe(0);

    // Leaving the union restores the plain filtered chips, markers gone.
    await page.click(`${btns(0)}[data-audience="adults"]`);
    expect(await page.locator('.ann-panel[data-viewport="0"] .ann-chip-audience').count()).toBe(0);
    expect(await page.locator('.ann-panel[data-viewport="0"] .ann-chip').count()).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 35.24 pins the widened-region floor against an UNSETTLED boot layout. The
// floor (config.minRegionPx) is a pixel quantity converted through the strip's
// LIVE width, and nothing guarantees boot's first render ran against a settled
// layout: a window mid-resize during boot has been observed laying the strips
// out a few pixels wide, where four pixels of a 582 s overture IS the whole
// recording — every region inflated to 0→duration, and an idle kiosk kept
// them that way, because only a re-render repairs specs. Two halves to pin,
// each of which fails alone: the conversion is CAPPED (regions.js
// MAX_WIDEN_FRACTION — no layout, however broken, widens a region past a
// small fraction of the piece), and the settle is the REPAIR (WaveSurfer
// re-renders on real container-width changes and re-emits "resize" after the
// wrapper has its new geometry; main.js re-derives the viewport's regions
// there — with NO interaction, because a museum kiosk gets none).
// ---------------------------------------------------------------------------

test.describe('35. Regions vs an unsettled boot layout', () => {
  // Narrow enough that the px→seconds conversion is garbage (strips lay out
  // ~32 px wide — measured on both engines), wide enough that both engines
  // still lay the exhibit out and boot cleanly.
  test.use({ viewport: { width: 60, height: 1366 } });

  test('35.24 a degenerate boot layout cannot inflate regions past the cap, and the settled layout repairs them untouched', async ({
    page,
  }) => {
    // The expert audience carries the sub-second hand-placement regions — the
    // ones the floor exists for, and therefore the ones a bad conversion
    // corrupts. Set from the URL: at 60 px the switch buttons are unclickable.
    await boot(page, 'debug=1&audiences=expert');

    // One prober for both halves: every drawn ex_ region on every strip, its
    // span, and its TRUE span re-derived independently from the payload's own
    // regionTimes — plus the constants, imported from the module under test so
    // this spec cannot drift from the implementation.
    const snapshot = () =>
      page.evaluate(async () => {
        const T = (window as any)._exhibitTest;
        const { MAX_WIDEN_FRACTION, EX_REGION_PREFIX } = await import(
          '/static/exhibit/regions.js'
        );
        const trueSpans = new Map<string, number>();
        for (const ann of T.exhibit.annotations) {
          for (const target of ann.targets || []) {
            for (const rgn of ann.regions || []) {
              const t = target.regionTimes?.[rgn.id];
              if (!t) continue;
              trueSpans.set(`${target.file}|${EX_REGION_PREFIX}${ann.id}_${rgn.id}`, t.end - t.start);
            }
          }
        }
        const strips: any[] = [];
        for (const vp of T.viewports) {
          for (const [file, s] of vp.strips) {
            strips.push({
              vp: vp.index,
              file,
              hostW: s.host.clientWidth,
              wrapperW: s.ws.getWrapper().scrollWidth,
              duration: s.duration,
              regions: s.regions
                .getRegions()
                .filter((r: any) => r.id?.startsWith(EX_REGION_PREFIX))
                .map((r: any) => ({
                  id: r.id,
                  span: r.end - r.start,
                  trueSpan: trueSpans.get(`${file}|${r.id}`) ?? null,
                })),
            });
          }
        }
        return { cap: MAX_WIDEN_FRACTION, minRegionPx: T.config.minRegionPx, strips };
      });

    const atBoot = await snapshot();
    // The premise, asserted so a CSS change cannot quietly defuse this test:
    // the strips are laid out — nonzero, else the widening skips entirely —
    // but so narrow that the UNCAPPED floor would exceed the cap.
    let capped = 0;
    let drawn = 0;
    for (const s of atBoot.strips) {
      expect(s.hostW, `${s.file} (vp ${s.vp}) lost its layout entirely`).toBeGreaterThan(0);
      expect(
        s.hostW,
        `${s.file} (vp ${s.vp}) is too wide for a degenerate-layout test — shrink the viewport`,
      ).toBeLessThan(atBoot.minRegionPx / atBoot.cap);
      const ceiling = s.duration * atBoot.cap;
      for (const r of s.regions) {
        drawn++;
        expect(r.trueSpan, `${r.id} is drawn but absent from the payload`).not.toBeNull();
        // THE CAP: nothing may be drawn wider than max(its true span, ceiling)
        // — before the fix, every region here was floored to ~73 s (and at a
        // few px of width, to the whole recording).
        expect(
          r.span,
          `${r.id} on ${s.file} was widened past the cap at a degenerate width`,
        ).toBeLessThanOrEqual(Math.max(r.trueSpan!, ceiling) + 0.01);
        if (Math.abs(r.span - ceiling) < 0.01) capped++;
      }
    }
    expect(drawn, 'no regions drawn at all — the premise is gone').toBeGreaterThan(0);
    // At least one region actually HIT the ceiling, proving the degenerate
    // conversion was exercised rather than dodged.
    expect(capped, 'no region was capped — the layout was not degenerate').toBeGreaterThan(0);

    // The kiosk scenario's second act: the window settles at the real size.
    // No clicks, no zoom, no audience change — the repair must drive itself
    // off the renderer's own resize signal.
    await page.setViewportSize({ width: 1024, height: 1366 });

    await expect
      .poll(
        async () => {
          const now = await snapshot();
          let worst = 0;
          for (const s of now.strips) {
            if (s.wrapperW <= 0) return Number.MAX_VALUE;
            const floor = Math.min(
              now.minRegionPx * (s.duration / s.wrapperW),
              s.duration * now.cap,
            );
            for (const r of s.regions) {
              if (r.trueSpan == null) return Number.MAX_VALUE;
              // What the settled geometry demands: the true span, floored by
              // the pixel minimum at the REAL width.
              const expected = Math.max(r.trueSpan, floor);
              worst = Math.max(worst, Math.abs(r.span - expected));
            }
          }
          return worst;
        },
        {
          timeout: 10_000,
          message:
            'the settled layout never repaired the boot-time regions — the resize re-derivation is broken',
        },
      )
      .toBeLessThan(0.05);
  });
});
