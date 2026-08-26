import { test, expect, type Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Section 34 — The exhibit loader (plan §4.1)
//
// The payload fetch, the peaks-only strips, the shared WindowedAudioPlayer
// transport, the alignment projection that keeps sixteen cursors on one
// musical moment, the annotation regions, the audience filter, and the
// three-way switch. This is the FIRST thing that actually renders under
// app/static/exhibit/ — spec 33 only ever checked the import graph.
//
// Driven through `window._exhibitTest`, mirroring listen.js's `_listenTest`
// convention (see main.js) rather than CSS locators, because the interesting
// state — grids, the transport, the audience store — has no visible text to
// assert on and WaveSurfer 7 builds its wrapper inside a SHADOW ROOT (a
// document-level canvas query silently finds nothing; Spike C hit this first).
//
// 34.3 is a REGRESSION TEST for a real bug this increment shipped with, not a
// hypothetical: WaveSurfer's constructor does not await its own peaks
// ingestion, so adding a region in the same tick as creating its strip finds
// `getDuration() === 0`. The regions plugin clamps to that and silently
// degrades every region to a `part="marker ..."` sliver at the left edge — 2px
// wide, no colour, no error, no console warning. Costed at about an hour to
// find with a Playwright probe; nothing about the code that adds the regions
// suggests the renderer isn't ready yet. strips.js now exposes `strip.ready`
// and main.js awaits every strip before the first `renderAnnotations`; this
// spec is what keeps that fix from regressing silently the way the bug itself
// did.
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

/** Region elements for one strip, keyed by id, as the DOM actually rendered them. */
function stripRegions(page: Page, file: string, viewport = 0) {
  return page.evaluate(
    ({ file, viewport }) => {
      const T = (window as any)._exhibitTest;
      const strip = T.viewports[viewport].strips.get(file);
      return strip.regions.getRegions().map((r: any) => ({
        id: r.id,
        start: r.start,
        end: r.end,
        part: r.element?.getAttribute('part') || null,
        provisional: r.element?.dataset.provisional === '1',
        px: r.element ? r.element.getBoundingClientRect().width : null,
      }));
    },
    { file, viewport },
  );
}

test.describe('34. The exhibit loader', () => {
  // The exhibit is a kiosk built for a specific portrait screen (the real iPad
  // Air measured 1024×1366 CSS, plan §4.0a) and its CSS deliberately has NO
  // scroll container anywhere (overscroll-behavior: none; nothing overflows) —
  // that is the kiosk feel, not an oversight. Left at Playwright's 1280×720
  // desktop default, most of a stacked-eight-strip viewport renders below the
  // fold with nothing to scroll it into view, and every click on it times out
  // "element is outside of the viewport". Match the geometry the page assumes.
  test.use({ viewport: { width: 1024, height: 1366 } });


  // 34.1 The payload loads, and every recording gets a real renderer — not a
  // stub. Both viewports, because a per-viewport bug (e.g. only viewport 0
  // wired up) would pass a single-viewport check.
  test('34.1 loads the payload and mounts one WaveSurfer renderer per curated recording, per viewport', async ({
    page,
  }) => {
    const { order } = await boot(page);
    expect(order).toHaveLength(8);

    const shape = await page.evaluate(() => {
      const T = (window as any)._exhibitTest;
      return T.viewports.map((vp: any) => ({
        stripCount: vp.strips.size,
        // Through ws.getWrapper(), which is the ONLY way to see WaveSurfer 7's
        // canvases — they live inside a shadow root a bare querySelectorAll
        // cannot reach.
        canvasesPerStrip: [...vp.strips.values()].map(
          (s: any) => s.ws.getWrapper().querySelectorAll('canvas').length,
        ),
      }));
    });
    for (const vp of shape) {
      expect(vp.stripCount).toBe(8);
      // TWO per strip (one waveform canvas under `.canvases`, one under
      // `.progress`) — not Spike C's measured "4 canvases / renderer" (plan
      // §4.0a), which was at a real zoom over a 582 s recording wide enough to
      // exceed WaveSurfer's 8000px chunk cap and split into two chunks. Every
      // strip here renders at fit-to-width (config.zoom = 0), so the whole
      // waveform is one chunk. A jump to 4 here would mean either the zoom
      // default regressed away from fit-to-width, or a chunk-splitting
      // recording made it into the curated set at a size that no longer fits.
      expect(vp.canvasesPerStrip).toEqual(new Array(8).fill(2));
    }
  });

  // 34.2 The grids that align-core needs are exactly the payload's own times
  // arrays — nothing resampled, nothing re-keyed on the way into `data.grids`.
  test('34.2 populates data.grids from the payload, one 29,121-entry array per recording', async ({
    page,
  }) => {
    const { order } = await boot(page);
    const grids = await page.evaluate(() => {
      const T = (window as any)._exhibitTest;
      return Object.fromEntries(
        Object.entries(T.data.grids).map(([k, v]: [string, any]) => [k, v.length]),
      );
    });
    expect(Object.keys(grids).sort()).toEqual([...order].sort());
    for (const len of Object.values(grids)) expect(len).toBe(29121);
  });

  // 34.3 THE REGRESSION TEST — see the file header. A collapsed region has
  // start === end and WaveSurfer renders it as `part="marker …"`; a real one
  // has the payload's own span and renders as `part="region …"`.
  test('34.3 annotation regions render at their real span, not collapsed to zero-width markers', async ({
    page,
  }) => {
    const { ref } = await boot(page);
    const regions = await stripRegions(page, ref); // viewport 0 defaults to "adults"
    expect(regions.length).toBeGreaterThan(0);
    for (const r of regions) {
      expect(r.end - r.start, `region ${r.id} has zero duration`).toBeGreaterThan(1);
      expect(r.part, `region ${r.id} rendered as a marker, not a region`).toMatch(/^region\b/);
      expect(r.px, `region ${r.id} has no rendered width`).toBeGreaterThan(0);
    }
  });

  // 34.3b The one region the prep script flagged as unfit to trust (plan
  // §5.2d: 0.12 s of region against 2.53 s of alignment disagreement) must be
  // WIDENED to stay visible and MARKED provisional — not silently invisible,
  // and not presented as settled. Its sibling region in the same annotation
  // (rgn_msvos2fy_3, which the prep script did not flag) must be neither.
  test('34.3b a region awaiting hand placement is widened and marked provisional; its sibling is not', async ({
    page,
  }) => {
    const { ref } = await boot(page);
    await page.click('.audience-switch[data-viewport="0"] .audience-btn[data-audience="expert"]');
    const regions = await stripRegions(page, ref);

    const flagged = regions.find((r: any) => r.id.endsWith('rgn_msvors30_2'));
    const sibling = regions.find((r: any) => r.id.endsWith('rgn_msvos2fy_3'));
    expect(flagged, 'the hand-placement region was not rendered at all').toBeTruthy();
    expect(sibling, 'its sibling region was not rendered at all').toBeTruthy();
    expect(flagged!.provisional).toBe(true);
    expect(sibling!.provisional).toBe(false);

    // The widened floor in seconds, computed the same way regions.js does it —
    // config.minRegionPx converted through THIS strip's own seconds-per-pixel —
    // so the assertion tracks the config rather than a number copied out of a
    // console log that would go stale the next time minRegionPx changes.
    const { minRegionPx, secondsPerPx } = await page.evaluate((ref) => {
      const T = (window as any)._exhibitTest;
      const strip = T.viewports[0].strips.get(ref);
      const width = strip.ws.getWrapper().scrollWidth;
      return { minRegionPx: T.config.minRegionPx, secondsPerPx: strip.duration / width };
    }, ref);
    expect(flagged!.end - flagged!.start).toBeCloseTo(minRegionPx * secondsPerPx, 2);
  });

  // 34.4 Audience is a filter, and it is a PER-VIEWPORT one (plan §5.3, §6.3):
  // switching one viewport must not move the other.
  test('34.4 the audience switch filters annotations independently per viewport', async ({
    page,
  }) => {
    await boot(page);
    const chipsOf = (vp: number) =>
      page.locator(`.ann-panel[data-viewport="${vp}"] .ann-chip`).allTextContents();

    const before = { vp0: await chipsOf(0), vp1: await chipsOf(1) };
    expect(before.vp0.length).toBeGreaterThan(0);
    expect(before.vp0).toEqual(before.vp1); // both start on "adults"

    await page.click('.audience-switch[data-viewport="0"] .audience-btn[data-audience="kids"]');
    const after = { vp0: await chipsOf(0), vp1: await chipsOf(1) };

    expect(after.vp0).not.toEqual(before.vp0); // viewport 0 changed…
    expect(after.vp1).toEqual(before.vp1); // …viewport 1 did not.

    const pressed = await page
      .locator('.audience-switch[data-viewport="0"] .audience-btn[data-audience="kids"]')
      .getAttribute('aria-pressed');
    expect(pressed).toBe('true');
  });

  // 34.5 The point of the stacked layout: align-core must place the SAME
  // musical moment at DIFFERENT times on different recordings. Tested as a
  // pure function of the loaded grids — no playback, no timing — so it can't
  // be flaky, and it is exactly what onTransport calls every frame.
  test('34.5 projects one moment onto every recording at a genuinely different time', async ({
    page,
  }) => {
    const { ref, order } = await boot(page);
    const positions = await page.evaluate(
      (ref) => (window as any)._exhibitTest.positionsFor(120, ref),
      ref,
    );
    expect(positions[ref]).toBe(120); // the active recording is exact, not grid-snapped
    const others = order.filter((f) => f !== ref).map((f) => positions[f]);
    expect(others.every((t) => Number.isFinite(t))).toBe(true);
    // If projection were a no-op (a passthrough bug), every "other" would also
    // read exactly 120. The eight recordings are known to drift by seconds
    // over the piece (plan §5.2d), so requiring even one to differ by more
    // than a second catches that failure mode without hard-coding a value
    // that the next re-alignment would make this test lie about.
    expect(others.some((t) => Math.abs(t - 120) > 1)).toBe(true);
  });

  // 34.6 Tapping another strip must continue at the same PLACE IN THE PIECE,
  // not the same wall-clock second (header note in audio.js). Paused
  // throughout, so nothing here depends on real playback timing — it isolates
  // the carry-over arithmetic from the transport, which is the thing a
  // regression here would actually break.
  test('34.6 switching the active recording carries the musical moment across, not the clock', async ({
    page,
  }) => {
    const { order } = await boot(page);
    const [fileA, fileB] = order;
    const result = await page.evaluate(
      async ({ fileA, fileB }) => {
        const T = (window as any)._exhibitTest;
        await T.transport.select(fileA, 42, /* play */ false);
        const expected = T.positionsFor(42, fileA)[fileB];
        await T.transport.select(fileB, undefined, /* play */ false);
        return { landed: T.transport.time, expected, file: T.transport.activeFile };
      },
      { fileA, fileB },
    );
    expect(result.file).toBe(fileB);
    expect(result.landed).toBeCloseTo(result.expected, 2);
    // And NOT the naive (and wrong) alternative of preserving the wall-clock
    // second: 42 is far enough from every recording's own drift at that point
    // that if carry-over regressed to a no-op, this would catch it too.
    expect(Math.abs(result.landed - 42)).toBeGreaterThan(0.01);
  });

  // 34.7 A tap actually starts the shared transport — the one path 34.5/34.6
  // deliberately bypass by calling `select` directly.
  test('34.7 tapping a strip starts the shared transport playing', async ({ page }) => {
    const { order } = await boot(page);
    const [, second] = order; // avoid the reference; no behavioural reason, just variety
    await page.click(`.vp[data-viewport="0"] .strip[data-file="${second}"] .strip-ws`, {
      position: { x: 40, y: 10 },
    });
    await expect
      .poll(() => page.evaluate(() => (window as any)._exhibitTest.transport.playing), {
        timeout: 15_000,
        message: 'transport never reported playing after a strip was tapped',
      })
      .toBe(true);
    const active = await page.evaluate(() => (window as any)._exhibitTest.transport.activeFile);
    expect(active).toBe(second);
  });

  // 34.8 A REAL tap on a different strip must carry the musical moment across —
  // the engine's semantics (waveform-events.js ignores the click position on a
  // swap). 34.6 tests the transport's carry-over by calling `select` directly,
  // which is exactly why it missed the original bug: main.js's onSelect passed
  // the tapped time unconditionally, so the carry-over path was unreachable from
  // the UI and every switch jumped to wherever the finger landed (~0.58 s per
  // pixel at fit-to-width). Found by the user's ear on day one, not by 34.6.
  test('34.8 tapping a different strip carries the moment across, ignoring the tap position', async ({
    page,
  }) => {
    const { order } = await boot(page);
    const [fileA, fileB] = order;
    const expected = await page.evaluate(
      async ({ fileA, fileB }) => {
        const T = (window as any)._exhibitTest;
        await T.transport.select(fileA, 42, /* play */ false);
        return T.positionsFor(42, fileA)[fileB];
      },
      { fileA, fileB },
    );

    // Tap strip B far to the RIGHT (80% of its width ≈ 465 s naively), so a
    // regression to tap-literal semantics lands hundreds of seconds from the
    // projected moment and cannot pass by luck.
    const strip = page.locator(`.vp[data-viewport="0"] .strip[data-file="${fileB}"] .strip-ws`);
    const box = (await strip.boundingBox())!;
    await strip.click({ position: { x: Math.round(box.width * 0.8), y: 10 } });

    // `select` sets activeFile and _time synchronously before its first await,
    // so poll for the switch and read the raw _time — playback (if the fetch has
    // already finished) only nudges it forward by real elapsed milliseconds.
    await expect
      .poll(() => page.evaluate(() => (window as any)._exhibitTest.transport.activeFile))
      .toBe(fileB);
    const landed = await page.evaluate(() => (window as any)._exhibitTest.transport.time);
    expect(Math.abs(landed - expected), `landed ${landed}, expected ~${expected}`).toBeLessThan(2);
  });

  // 34.9 The upright viewport (rotation 0) sits at the BOTTOM edge, where the
  // near visitor stands; the rotated half faces the far side from the top. A
  // design decision from the first eyeballing, pinned so a flex-direction edit
  // cannot silently put the readable half back at the top.
  test('34.9 the upright viewport renders at the bottom of the screen, the rotated one on top', async ({
    page,
  }) => {
    await boot(page);
    const tops = await page.evaluate(() => {
      const T = (window as any)._exhibitTest;
      return T.viewports.map((vp: any) => ({
        rotated: /rotate\((?!0deg)/.test(vp.el.style.transform || ''),
        top: vp.el.getBoundingClientRect().top,
      }));
    });
    const upright = tops.filter((v: any) => !v.rotated);
    const rotated = tops.filter((v: any) => v.rotated);
    expect(upright.length).toBeGreaterThan(0);
    expect(rotated.length).toBeGreaterThan(0);
    for (const u of upright) for (const r of rotated) expect(u.top).toBeGreaterThan(r.top);
  });

  // 34.10 Nothing may MOVE during a switch. The "Loading…" status line used to
  // grow from 0 to one line box while the new recording fetched, and because the
  // vp column is justify-content: center that shifted every strip ~10 px up and
  // back — the whole screen twitching on every switch. The status line's height
  // is now reserved (.vp-status min-height); this measures a strip's rect while
  // the loading text is actually showing, in the same JS turn that started the
  // switch, so a reintroduced shift cannot hide between polls.
  test('34.10 the loading status does not shift the strips during a switch', async ({ page }) => {
    const { order } = await boot(page);
    const probe = await page.evaluate(async (order) => {
      const T = (window as any)._exhibitTest;
      const vp = T.viewports[0];
      const stripEl = [...vp.strips.values()][0].el;
      const before = stripEl.getBoundingClientRect().top;
      // A file with no built player, so select() really fetches and the loading
      // state really shows; the emit is synchronous, so measuring in this same
      // turn catches the layout exactly while "Loading…" is on screen.
      const fresh = order.find((f: string) => f !== T.transport.activeFile);
      const done = T.transport.select(fresh, undefined, /* play */ false);
      const during = {
        top: stripEl.getBoundingClientRect().top,
        statusText: vp.statusEl.textContent,
        statusHeight: vp.statusEl.getBoundingClientRect().height,
      };
      await done;
      return { before, during, after: stripEl.getBoundingClientRect().top };
    }, order);
    expect(probe.during.statusText, 'the probe never saw the loading state').toBe('Loading…');
    expect(probe.during.statusHeight).toBeGreaterThan(0);
    expect(probe.during.top, 'strips shifted while loading').toBe(probe.before);
    expect(probe.after, 'strips shifted after loading').toBe(probe.before);
  });

  // 34.11 The orchestra is shown alongside the conductor — a requirement from
  // the user's first eyeballing ("it's not enough to show the conductor"), and
  // load-bearing rather than decorative: the annotations pin groupings like
  // VPO-versus-other-orchestras, which a visitor can only follow if the strips
  // say which orchestra is which. The sidecar has carried `ensemble` (with
  // provenance) since the pipeline landed; this pins that the DISPLAY uses it.
  test('34.11 the middle band and the strip captions name the orchestra as well as the conductor', async ({
    page,
  }) => {
    const { ref } = await boot(page);
    const shown = await page.evaluate((ref) => {
      const T = (window as any)._exhibitTest;
      const meta = T.exhibit.metadata.recordings[ref];
      const strip = T.viewports[0].strips.get(ref);
      return {
        meta: { conductor: meta.conductor, ensemble: meta.ensemble },
        band: {
          conductor: T.band.el.querySelector('.mb-conductor')!.textContent,
          ensemble: T.band.el.querySelector('.mb-ensemble')!.textContent,
        },
        caption: strip.caption.textContent,
      };
    }, ref);
    expect(shown.meta.ensemble, 'the sidecar lost its ensemble field').toBeTruthy();
    expect(shown.band.conductor).toBe(shown.meta.conductor);
    expect(shown.band.ensemble).toBe(shown.meta.ensemble);
    expect(shown.caption).toContain(shown.meta.ensemble);
    expect(shown.caption).toContain(shown.meta.conductor);
  });

  // 34.12 The piece is named ONCE PER VIEW, in the middle band — with the
  // composer, and with the opus number when the payload carries one (Die
  // Fledermaus correctly has none: Strauss II's operettas are not
  // opus-numbered, and the graph's Work entity agrees — see the prep script).
  // Once per view because every strip is the same piece; the title on eight
  // strips would say nothing.
  test('34.12 the middle band names the piece and composer, once per view', async ({ page }) => {
    await boot(page);
    const shown = await page.evaluate(() => {
      const T = (window as any)._exhibitTest;
      return {
        piece: T.exhibit.piece,
        title: T.band.el.querySelector('.mb-piece-title')!.textContent,
        composer: T.band.el.querySelector('.mb-piece-composer')!.textContent,
        titleCount: document.querySelectorAll('.mb-piece-title').length,
      };
    });
    expect(shown.title).toContain(shown.piece.title.en);
    // The opus rendering is data-driven: absent today (correctly), appended
    // after a comma when a payload carries one — asserted both ways so the
    // Kaiserwalzer payload exercises the other branch without a test edit.
    if (shown.piece.opus) expect(shown.title).toContain(shown.piece.opus);
    else expect(shown.title).toBe(shown.piece.title.en);
    expect(shown.composer).toBe(shown.piece.composer);
    expect(shown.titleCount).toBe(1);
  });

  // 34.13 ?preload=on (user ruling 2026-08-26, from the iPad device test: the
  // exhibit must not be half-ready for its first visitor). The pin is
  // behavioral, not structural: after the warm loop reports done, the audio
  // network is KILLED entirely — and switches must still work, because warm
  // bytes carry them. A preload that warmed the wrong URLs, or a build path
  // that quietly re-fetched, fails here rather than on the museum's network.
  test('34.13 ?preload=on warms every recording, so a switch needs no network at all', async ({
    page,
  }) => {
    const { order } = await boot(page, 'preload=on&debug=1');
    const warm = await page.evaluate(() => (window as any)._exhibitTest.preloaded);
    expect(warm).toEqual({ warmed: 8, skipped: 0, failed: 0 });

    await page.route('**/static/exhibit/audio/**', (route) => route.abort());
    const after = await page.evaluate(async (order) => {
      const T = (window as any)._exhibitTest;
      const fresh = order.filter((f: string) => f !== T.transport.activeFile).slice(0, 2);
      for (const f of fresh) await T.transport.select(f, undefined, /* play */ false);
      return {
        built: fresh.map((f: string) => T.transport._players.has(f)),
        active: T.transport.activeFile,
        expected: fresh[1],
      };
    }, order);
    expect(after.built, 'a switch reached for the (dead) network despite warm bytes').toEqual([
      true,
      true,
    ]);
    expect(after.active).toBe(after.expected);
  });

  // 34.14 ?playerCache sizes the transport's LRU. The shipped 2 is a memory
  // decision pending the week-4 soak (plan §7.4), so both sides are pinned:
  // the default evicts the oldest at the third build, and ?playerCache=8
  // keeps everything — the kiosk's all-switches-stay-instant configuration.
  test('34.14 ?playerCache sizes the player LRU: default 2 evicts, 8 retains', async ({
    page,
  }) => {
    const { order } = await boot(page);
    const evicted = await page.evaluate(async (order) => {
      const T = (window as any)._exhibitTest;
      const files = order.slice(0, 3);
      for (const f of files) await T.transport.select(f, undefined, /* play */ false);
      return {
        size: T.transport._players.size,
        oldestGone: !T.transport._players.has(files[0]),
      };
    }, order);
    expect(evicted.size).toBe(2);
    expect(evicted.oldestGone, 'the default LRU kept a third player').toBe(true);

    await boot(page, 'playerCache=8&preload=on&debug=1');
    await page.evaluate(() => (window as any)._exhibitTest.preloaded);
    const retained = await page.evaluate(async (order) => {
      const T = (window as any)._exhibitTest;
      const files = order.slice(0, 4);
      for (const f of files) await T.transport.select(f, undefined, /* play */ false);
      return files.map((f: string) => T.transport._players.has(f));
    }, order);
    expect(retained, 'playerCache=8 evicted a player it had room for').toEqual([
      true,
      true,
      true,
      true,
    ]);
  });

  // 34.15 ?loadingGrace: a WARM switch never shows "Loading…" at all (user,
  // 2026-08-26: a text that flashes for two frames between seamless switches
  // reads as a glitch). Observer planted, switch run, and result collected in
  // ONE evaluate — the 37.4 pattern — so no rAF or poll gap can miss a flash.
  test('34.15 under ?loadingGrace a warm switch never flashes the loading text', async ({
    page,
  }) => {
    const { order } = await boot(page, 'preload=on&loadingGrace=1500&debug=1');
    await page.evaluate(() => (window as any)._exhibitTest.preloaded);
    const probe = await page.evaluate(async (order) => {
      const T = (window as any)._exhibitTest;
      const vp = T.viewports[0];
      const seen: string[] = [];
      const mo = new MutationObserver(() =>
        seen.push(vp.statusEl.dataset.state || '(cleared)'),
      );
      mo.observe(vp.statusEl, { attributes: true, attributeFilter: ['data-state'] });
      const fresh = order.find((f: string) => f !== T.transport.activeFile);
      await T.transport.select(fresh, undefined, /* play */ false);
      // The grace timer may still be pending; give it a beat past the window
      // to prove it was cancelled, not merely not-yet-fired.
      await new Promise((r) => setTimeout(r, 1800));
      mo.disconnect();
      return { seen, built: T.transport._players.has(fresh) };
    }, order);
    expect(probe.built).toBe(true);
    expect(
      probe.seen.filter((s) => s === 'loading'),
      'a warm switch flashed the loading state',
    ).toEqual([]);
  });

  // 34.16 ?loadingGrace: a GENUINE wait still explains itself — the text
  // appears once the grace elapses and clears on arrival. The audio route is
  // held for 4 s; the empty and showing phases are each ≥1.2 s wide (the
  // transient-window rule), sampled at 500 ms and 2500 ms.
  test('34.16 under ?loadingGrace a genuine wait shows the loading text after the grace', async ({
    page,
  }) => {
    const { order } = await boot(page, 'loadingGrace=1500');
    await page.route('**/static/exhibit/audio/**', async (route) => {
      await new Promise((r) => setTimeout(r, 4000));
      await route.continue();
    });
    const probe = await page.evaluate(async (order) => {
      const T = (window as any)._exhibitTest;
      const vp = T.viewports[0];
      const states: string[] = [];
      const sample = (label: string, ms: number) =>
        new Promise<void>((r) =>
          setTimeout(() => {
            states.push(`${label}:${vp.statusEl.dataset.state || 'empty'}`);
            r();
          }, ms),
        );
      const fresh = order.find((f: string) => f !== T.transport.activeFile);
      const done = T.transport.select(fresh, undefined, /* play */ false);
      await Promise.all([sample('inGrace', 500), sample('afterGrace', 2500)]);
      await done;
      states.push(`settled:${vp.statusEl.dataset.state || 'empty'}`);
      return states;
    }, order);
    expect(probe).toEqual(['inGrace:empty', 'afterGrace:loading', 'settled:empty']);
  });

  // 34.17 ?tapMode=direct (alpha-tester feedback, 2026-08-26): a tap on another
  // strip is taken literally on BOTH axes — switch to that recording AND seek
  // to the tapped x-position. The mirror image of 34.8, which pins the shipped
  // aligned carry at the default; the same far-right tap that 34.8 requires to
  // be IGNORED must land here.
  test('34.17 ?tapMode=direct takes a tap on another strip literally on both axes', async ({
    page,
  }) => {
    const { order } = await boot(page, 'tapMode=direct');
    const [fileA, fileB] = order;
    await page.evaluate(
      ({ fileA }) => (window as any)._exhibitTest.transport.select(fileA, 42, /* play */ false),
      { fileA },
    );

    const strip = page.locator(`.vp[data-viewport="0"] .strip[data-file="${fileB}"] .strip-ws`);
    const box = (await strip.boundingBox())!;
    await strip.click({ position: { x: Math.round(box.width * 0.8), y: 10 } });

    await expect
      .poll(() => page.evaluate(() => (window as any)._exhibitTest.transport.activeFile))
      .toBe(fileB);
    const { time, expected } = await page.evaluate(
      ({ fileB }) => {
        const T = (window as any)._exhibitTest;
        return { time: T.transport._time, expected: 0.8 * T.exhibit.durations[fileB] };
      },
      { fileB },
    );
    // Tolerance: the tap's pixel quantum (~0.6 s at fit-to-width) plus however
    // far playback ran before the poll landed — the tap plays, by the ruled
    // jump semantics. Either failure mode is hundreds of seconds out: an
    // aligned carry lands near the projection of 42 s, a time-less switch at 0.
    expect(Math.abs(time - expected)).toBeLessThan(5);
  });

  // 34.18 The switch strap: absent at the default, present in direct mode —
  // one button per recording, beside its strip, labelled with the conductor's
  // initials and year (ruled 2026-08-26) — and a button tap does the ALIGNED
  // carry that direct mode removed from the strips, marked active afterwards.
  test('34.18 the switch strap appears only in direct mode and its buttons carry the moment', async ({
    page,
  }) => {
    await boot(page);
    expect(await page.locator('.vp-strap').count(), 'the default mode grew a strap').toBe(0);

    const { order } = await boot(page, 'tapMode=direct');
    const [fileA, fileB] = order;
    const buttons = page.locator('.vp[data-viewport="0"] .vp-strap .strap-btn');
    await expect(buttons).toHaveCount(8);

    const probe = await page.evaluate(
      async ({ fileA, fileB }) => {
        const T = (window as any)._exhibitTest;
        await T.transport.select(fileA, 42, /* play */ false);
        const meta = T.exhibit.metadata.recordings[fileB];
        const initials = meta.conductor
          .split(/[\s-]+/)
          .filter(Boolean)
          .map((p: string) => p[0])
          .join('');
        const btn = document.querySelector(
          `.vp[data-viewport="0"] .vp-strap .strap-btn[data-file="${fileB}"]`,
        )!;
        return {
          label: btn.textContent,
          expectedLabel: `${initials} ’${String(meta.year).slice(-2)}`,
          expectedTime: T.positionsFor(42, fileA)[fileB],
        };
      },
      { fileA, fileB },
    );
    expect(probe.label).toBe(probe.expectedLabel);

    await page.click(`.vp[data-viewport="0"] .vp-strap .strap-btn[data-file="${fileB}"]`);
    await expect
      .poll(() => page.evaluate(() => (window as any)._exhibitTest.transport.activeFile))
      .toBe(fileB);
    const time = await page.evaluate(() => (window as any)._exhibitTest.transport._time);
    // The aligned carry, 34.8's own assertion shape: near the projected moment,
    // give or take real playback milliseconds — nowhere near a literal-x seek.
    expect(Math.abs(time - probe.expectedTime)).toBeLessThan(5);
    await expect(
      page.locator(`.vp[data-viewport="0"] .vp-strap .strap-btn[data-file="${fileB}"]`),
    ).toHaveClass(/is-active/);
  });
});
