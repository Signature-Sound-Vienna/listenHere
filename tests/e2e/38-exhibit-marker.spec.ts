import { test, expect, type Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Section 38 — The listening marker (?marker=glass; plan §4.4, ruled 2026-08-27)
//
// One magnifying-glass marker per viewport, anchored as an ALIGNMENT INDEX.
// The ruled semantics under test:
//   * sketch B: the glass RESTS on a hook in the left rail; placement and
//     removal are the same physical gesture (drag on / drag off), plus the
//     tap path — tap the glass to lift it (expect-placement, the strip stack
//     pulses), tap a waveform to place, tap anywhere else to rest it while
//     that tap still does its normal job;
//   * placement is the reader's own JUMP — a placed glass plays there;
//   * while a marker stands, BARE switches (aligned cross-strip taps, strap
//     picks, nav arrows) land ON it instead of carrying the moment; explicit
//     times (same-strip taps) still win;
//   * the other side's marker appears as a mirrored ghost; my glass dropped
//     or tapped onto it ADOPTS their moment (merge = snap-assisted placement);
//   * a marker-snap switch counts as a SEEK for the fade rules, where a plain
//     aligned switch is exempt for the jumper — 38.13 pins both directions;
//   * projected ticks are salient while the glass is in hand and remain
//     visible (settled-subtle) after placement.
//
// Driven through `window._exhibitTest` (the spec-34 convention). Drag tests
// use real pointer input because the drag's client→local mapping is exactly
// the transform trap 34.8 documented — 38.12 drags on the ROTATED viewport.
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

const markerState = (page: Page, vp = 0) =>
  page.evaluate((i) => (window as any)._exhibitTest.marker(i), vp);

/** Drag helper: press on `from` (client coords), glide to `to`, release. */
async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  // Clear the tap slop first so the gesture is unambiguously a drag.
  await page.mouse.move(from.x + 10, from.y + 10, { steps: 2 });
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
}

const glassBox = async (page: Page, vp = 0) =>
  (await page.locator(`.vp[data-viewport="${vp}"] .marker-glass`).boundingBox())!;

/** The glass travels on a 450ms transition; wait until it has ARRIVED before
 * aiming a pointer at it. Not the two-identical-readings pattern: a janked
 * main thread (the placement's own audio fetch) can delay the transition's
 * START past two samples, so "stable" can be the position it has not yet
 * left. The inline left/top name the destination, so compare against those —
 * arrival is unambiguous, and the overshoot bezier only matches at the end.
 * Client-space comparison — valid on the UNROTATED viewport only, which is
 * where every drag-from-placed test lives (rotated drags start from rest). */
async function arrivedGlassBox(page: Page, vp = 0) {
  await expect
    .poll(() =>
      page.evaluate((i) => {
        const g = document.querySelector(
          `.vp[data-viewport="${i}"] .marker-glass`,
        ) as HTMLElement;
        const p = g.offsetParent as HTMLElement;
        const gr = g.getBoundingClientRect();
        const pr = p.getBoundingClientRect();
        return (
          Math.abs(gr.x - pr.x - parseFloat(g.style.left)) +
          Math.abs(gr.y - pr.y - parseFloat(g.style.top))
        );
      }, vp),
    )
    .toBeLessThan(1);
  return glassBox(page, vp);
}

test.describe('38. The listening marker', () => {
  // The kiosk geometry, per the spec-34 note: the exhibit assumes the portrait
  // iPad and its CSS deliberately has no scroll container anywhere.
  test.use({ viewport: { width: 1024, height: 1366 } });

  // 38.1 The A/B rule: the default is byte-identical — no glass, no hook, no
  // reserved rail column, and the test hook reports no layer.
  test('38.1 marker off by default: no glass, no rail, no reserved column', async ({ page }) => {
    await boot(page);
    expect(await page.locator('.marker-glass').count()).toBe(0);
    expect(await page.locator('.marker-hook').count()).toBe(0);
    expect(await markerState(page)).toBeNull();
    const pad = await page.evaluate(
      () => getComputedStyle(document.querySelector('.vp')!).paddingLeft,
    );
    expect(pad).toBe('12px');
  });

  // 38.2 ?marker=glass mounts the object — in ALIGNED mode, where there is no
  // strap: the hook rail reserves the same column by itself (the staff preset
  // is aligned by ruling, and staff must see the feature).
  test('38.2 ?marker=glass mounts glass and hook per viewport, reserving the rail without a strap', async ({
    page,
  }) => {
    await boot(page, 'debug=1&marker=glass');
    expect(await page.locator('.marker-glass').count()).toBe(2);
    expect(await page.locator('.marker-hook').count()).toBe(2);
    expect(await page.locator('.vp-strap').count(), 'aligned mode must not grow a strap').toBe(0);
    const pad = await page.evaluate(
      () => getComputedStyle(document.querySelector('.vp[data-marker="glass"]')!).paddingLeft,
    );
    expect(pad).toBe('70px'); // 12 + 52 + 6: the strap's own reservation, shared
    expect(await markerState(page)).toEqual({ ix: null, homeFile: null, lifted: false, ghost: null });
  });

  // 38.3 The tap path's first half: a tap lifts the glass off its hook into
  // expect-placement — the glass floats, the strip stack pulses.
  test('38.3 tapping the resting glass lifts it and the strip stack pulses', async ({ page }) => {
    await boot(page, 'debug=1&marker=glass');
    await page.click('.vp[data-viewport="0"] .marker-glass');
    expect((await markerState(page)).lifted).toBe(true);
    await expect(page.locator('.vp[data-viewport="0"] .marker-glass')).toHaveClass(/is-lifted/);
    await expect(page.locator('.vp[data-viewport="0"] .strips')).toHaveClass(/marker-expect/);
  });

  // 38.4 The tap path's second half: a waveform tap places the marker there —
  // and placement is the reader's own jump, so it PLAYS there (ruled). The
  // ticks appear on every strip and settle visible after the fresh window.
  test('38.4 a waveform tap while lifted places the marker and plays there', async ({ page }) => {
    const { ref, order } = await boot(page, 'debug=1&marker=glass');
    await page.click('.vp[data-viewport="0"] .marker-glass');

    const strip = page.locator(`.vp[data-viewport="0"] .strip[data-file="${ref}"] .strip-ws`);
    const box = (await strip.boundingBox())!;
    await strip.click({ position: { x: Math.round(box.width * 0.5), y: 10 } });

    const state = await markerState(page);
    expect(state.ix, 'no marker after a placement tap').not.toBeNull();
    expect(state.homeFile).toBe(ref);
    expect(state.lifted).toBe(false);
    await expect(page.locator('.vp[data-viewport="0"] .strips')).not.toHaveClass(/marker-expect/);
    await expect(page.locator('.vp[data-viewport="0"] .marker-glass')).toHaveClass(/is-placed/);

    // One tick per strip, visible (settled-subtle is still visible — ruled).
    expect(
      await page.locator('.vp[data-viewport="0"] .marker-tick:not([hidden])').count(),
    ).toBe(order.length);

    // Placement is a jump: the tapped recording is audible AT the tapped
    // moment, playing. Same tolerance shape as 34.17.
    const probe = await page.evaluate((ref) => {
      const T = (window as any)._exhibitTest;
      return {
        file: T.transport.activeFile,
        time: T.transport._time,
        playing: T.transport.playing,
        expected: 0.5 * T.exhibit.durations[ref],
      };
    }, ref);
    expect(probe.file).toBe(ref);
    expect(Math.abs(probe.time - probe.expected)).toBeLessThan(5);
    // Polled, not read once: the first select fetches real bytes, and playback
    // starts when the fetch settles — the jump's play intent, not a race.
    await expect
      .poll(() => page.evaluate(() => (window as any)._exhibitTest.transport.playing), {
        message: 'a placed glass plays there — the jump path',
      })
      .toBe(true);
  });

  // 38.5 A lifted glass never deadens the screen: a tap elsewhere rests the
  // glass on its hook AND the tapped control still does its normal job.
  test('38.5 a tap elsewhere while lifted rests the glass and the tap still acts', async ({
    page,
  }) => {
    await boot(page, 'debug=1&marker=glass');
    await page.click('.vp[data-viewport="0"] .marker-glass');
    expect((await markerState(page)).lifted).toBe(true);

    // The tap: an audience switch button — observable both as UI state and in
    // the store, so "still acts" is not a guess.
    await page.click('.vp[data-viewport="0"] .audience-btn[data-audience="kids"]');
    await expect
      .poll(() => page.evaluate(() => (window as any)._exhibitTest.audience.get(0)))
      .toBe('kids');
    expect((await markerState(page)).lifted).toBe(false);
    expect((await markerState(page)).ix).toBeNull();
    await expect(page.locator('.vp[data-viewport="0"] .strips')).not.toHaveClass(/marker-expect/);
  });

  // 38.6 The marker's existence IS the mode (ruled): in aligned mode a
  // cross-strip tap is a bare switch, and with a marker up it lands ON the
  // marker's projection — the tap's x-position ignored exactly as 34.8
  // requires, but the landing is the marker, not the carried moment.
  test('38.6 an aligned cross-strip tap lands on the marker instead of carrying the moment', async ({
    page,
  }) => {
    const { order, ref } = await boot(page, 'debug=1&marker=glass');
    // A NON-ADJACENT strip, and the tap away from the marker's x: the placed
    // glass is a chunky physical object that overhangs its row's neighbours,
    // and a tap under it belongs to the glass (first run's actionability
    // timeout — a property of the design, not a bug).
    const fileB = order.filter((f) => f !== ref)[3];
    // Place programmatically (the hook), then move the clock elsewhere so the
    // marker landing and the carried moment are far apart and cannot alias.
    await page.evaluate(
      ({ ref }) => {
        const T = (window as any)._exhibitTest;
        T.placeMarker(0, ref, 60);
        T.transport.pause();
        return T.transport.select(ref, 300, /* play */ false);
      },
      { ref },
    );

    const strip = page.locator(`.vp[data-viewport="0"] .strip[data-file="${fileB}"] .strip-ws`);
    const box = (await strip.boundingBox())!;
    await strip.click({ position: { x: Math.round(box.width * 0.5), y: 10 } });

    await expect
      .poll(() => page.evaluate(() => (window as any)._exhibitTest.transport.activeFile))
      .toBe(fileB);
    const probe = await page.evaluate(
      ({ fileB }) => {
        const T = (window as any)._exhibitTest;
        const ix = T.marker(0).ix;
        return {
          time: T.transport._time,
          markerLanding: T.exhibit.grids[fileB][ix],
          carried: T.positionsFor(300, T.exhibit.piece.ref)[fileB],
        };
      },
      { fileB },
    );
    expect(Math.abs(probe.time - probe.markerLanding)).toBeLessThan(5);
    expect(Math.abs(probe.time - probe.carried), 'landed on the carry, not the marker').toBeGreaterThan(30);
  });

  // 38.7 Explicit times still win (ruled): a same-strip tap seeks to the
  // finger, and the marker does not move.
  test('38.7 a same-strip tap keeps its explicit time and leaves the marker standing', async ({
    page,
  }) => {
    const { ref } = await boot(page, 'debug=1&marker=glass');
    await page.evaluate((ref) => {
      const T = (window as any)._exhibitTest;
      T.placeMarker(0, ref, 60);
      T.transport.pause();
    }, ref);
    const before = await markerState(page);

    const strip = page.locator(`.vp[data-viewport="0"] .strip[data-file="${ref}"] .strip-ws`);
    const box = (await strip.boundingBox())!;
    await strip.click({ position: { x: Math.round(box.width * 0.25), y: 10 } });

    const probe = await page.evaluate((ref) => {
      const T = (window as any)._exhibitTest;
      return { time: T.transport._time, expected: 0.25 * T.exhibit.durations[ref] };
    }, ref);
    expect(Math.abs(probe.time - probe.expected)).toBeLessThan(5);
    expect((await markerState(page)).ix).toBe(before.ix);
  });

  // 38.8 Direct mode: the strap's picks and arrows are the bare switches
  // there, so a standing marker catches both.
  test('38.8 strap picks and nav arrows land on the marker in direct mode', async ({ page }) => {
    const { order, ref } = await boot(page, 'debug=1&marker=glass&tapMode=direct');
    const fileB = order.find((f) => f !== ref)!;
    await page.evaluate(
      ({ ref }) => {
        const T = (window as any)._exhibitTest;
        T.placeMarker(0, ref, 60);
        T.transport.pause();
        return T.transport.select(ref, 300, /* play */ false);
      },
      { ref },
    );

    await page.click(`.vp[data-viewport="0"] .vp-strap .strap-btn[data-file="${fileB}"]`);
    await expect
      .poll(() => page.evaluate(() => (window as any)._exhibitTest.transport.activeFile))
      .toBe(fileB);
    let probe = await page.evaluate(
      ({ fileB }) => {
        const T = (window as any)._exhibitTest;
        return { time: T.transport._time, landing: T.exhibit.grids[fileB][T.marker(0).ix] };
      },
      { fileB },
    );
    expect(Math.abs(probe.time - probe.landing)).toBeLessThan(5);

    // The arrow: one strip onward from the audible recording, still snapping.
    await page.evaluate(() => (window as any)._exhibitTest.transport.pause());
    await page.click('.vp[data-viewport="0"] .strap-nav-down');
    const fileC = order[(order.indexOf(fileB) + 1) % order.length];
    await expect
      .poll(() => page.evaluate(() => (window as any)._exhibitTest.transport.activeFile))
      .toBe(fileC);
    probe = await page.evaluate(
      ({ fileC }) => {
        const T = (window as any)._exhibitTest;
        return { time: T.transport._time, landing: T.exhibit.grids[fileC][T.marker(0).ix] };
      },
      { fileC },
    );
    expect(Math.abs(probe.time - probe.landing)).toBeLessThan(5);
  });

  // 38.9 The drag path: pull the glass from its hook onto a waveform. The
  // ticks are SALIENT and live mid-drag (ruled 2026-08-27), and the drop
  // places and plays like the tap path.
  test('38.9 dragging the glass onto a waveform places the marker; ticks are salient mid-drag', async ({
    page,
  }) => {
    const { order } = await boot(page, 'debug=1&marker=glass');
    const target = order[2];
    const from = await glassBox(page, 0);
    const stripBox = (await page
      .locator(`.vp[data-viewport="0"] .strip[data-file="${target}"] .strip-ws`)
      .boundingBox())!;
    const to = { x: stripBox.x + stripBox.width * 0.6, y: stripBox.y + stripBox.height / 2 };

    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2 + 12, from.y + 12, { steps: 2 });
    await page.mouse.move(to.x, to.y, { steps: 8 });
    // Mid-drag, before release: the projections track the hover, salient —
    // and the strip stack pulses during drags too (second iteration round).
    expect(
      await page
        .locator('.vp[data-viewport="0"] .marker-tick.is-salient:not([hidden])')
        .count(),
    ).toBeGreaterThan(0);
    await expect(page.locator('.vp[data-viewport="0"] .strips')).toHaveClass(/marker-expect/);
    await page.mouse.up();

    const state = await markerState(page);
    expect(state.ix).not.toBeNull();
    expect(state.homeFile).toBe(target);
    const probe = await page.evaluate((target) => {
      const T = (window as any)._exhibitTest;
      return {
        file: T.transport.activeFile,
        time: T.transport._time,
        expected: 0.6 * T.exhibit.durations[target],
      };
    }, target);
    expect(probe.file).toBe(target);
    expect(Math.abs(probe.time - probe.expected)).toBeLessThan(5);
  });

  // 38.10 Removal is the same gesture reversed: pull the glass off the
  // waveforms and the marker is gone — no pop-over, no confirmation.
  test('38.10 dragging the glass off the waveforms removes the marker', async ({ page }) => {
    const { ref } = await boot(page, 'debug=1&marker=glass');
    await page.evaluate((ref) => {
      const T = (window as any)._exhibitTest;
      T.placeMarker(0, ref, 60);
      T.transport.pause();
    }, ref);
    expect((await markerState(page)).ix).not.toBeNull();

    const from = await arrivedGlassBox(page, 0);
    const strips = (await page.locator('.vp[data-viewport="0"] .strips').boundingBox())!;
    // Well below the strip stack (the commentary area) — off the waveforms.
    await drag(
      page,
      { x: from.x + from.width / 2, y: from.y + from.height / 2 },
      { x: strips.x + strips.width / 2, y: strips.y + strips.height + 80 },
    );

    const state = await markerState(page);
    expect(state.ix).toBeNull();
    await expect(page.locator('.vp[data-viewport="0"] .marker-glass')).toHaveClass(/is-resting/);
    expect(
      await page.locator('.vp[data-viewport="0"] .marker-tick:not([hidden])').count(),
    ).toBe(0);
  });

  // 38.11 The stretch that motivated the feature ("hey, listen here!"): the
  // other side's marker is a mirrored ghost here, and tapping it with my
  // glass lifted ADOPTS their moment — same index both sides, my audio jumps
  // to their marked recording.
  test('38.11 the other viewport shows a ghost, and adopting it merges the moments', async ({
    page,
  }) => {
    const { ref } = await boot(page, 'debug=1&marker=glass');
    await page.evaluate((ref) => {
      const T = (window as any)._exhibitTest;
      T.placeMarker(0, ref, 120);
      T.transport.pause();
    }, ref);

    // The ghost renders in the OTHER viewport, at their projection — and its
    // LENS is vertically centred on its row (third round: the 180° mirror
    // must rotate about the lens centre; a default-origin rotation painted
    // the lens ~38% of the box below the row). Same check for the glass.
    const ghost = page.locator('.vp[data-viewport="1"] .marker-ghost');
    await expect(ghost).not.toBeHidden();
    expect((await markerState(page, 1)).ghost).toEqual(
      expect.objectContaining({ file: ref }),
    );
    await arrivedGlassBox(page, 0); // the placement transition must land first
    const centring = await page.evaluate((ref) => {
      const cy = (el: Element) => {
        const r = el.getBoundingClientRect();
        return r.y + r.height / 2;
      };
      const q = (vp: number, sel: string) =>
        document.querySelector(`.vp[data-viewport="${vp}"] ${sel}`)!;
      return {
        glass: cy(q(0, '.marker-glass .glass-lens')) - cy(q(0, `.strip[data-file="${ref}"]`)),
        ghost: cy(q(1, '.marker-ghost .glass-lens')) - cy(q(1, `.strip[data-file="${ref}"]`)),
      };
    }, ref);
    expect(Math.abs(centring.glass), 'the glass lens is off its row centre').toBeLessThan(3);
    expect(Math.abs(centring.ghost), 'the ghost lens is off its row centre').toBeLessThan(3);

    // Lift vp1's glass (engaging the ghost as a target), then tap the ghost.
    await page.click('.vp[data-viewport="1"] .marker-glass');
    await ghost.click();

    const probe = await page.evaluate(() => {
      const T = (window as any)._exhibitTest;
      return {
        mine: T.marker(1),
        theirs: T.marker(0),
        file: T.transport.activeFile,
        time: T.transport._time,
        landing: T.exhibit.grids[T.marker(0).homeFile][T.marker(0).ix],
      };
    });
    expect(probe.mine.ix).toBe(probe.theirs.ix);
    expect(probe.mine.homeFile).toBe(probe.theirs.homeFile);
    expect(probe.file).toBe(ref);
    expect(Math.abs(probe.time - probe.landing)).toBeLessThan(5);
  });

  // 38.12 The transform trap, pinned where it bites (the 34.8 lesson): a drag
  // on the ROTATED viewport must map its drop through the 180° inverse — a
  // transform-naive mapping lands mirror-image, hundreds of seconds out.
  test('38.12 a drag on the rotated viewport places at the finger, not its mirror image', async ({
    page,
  }) => {
    const { order } = await boot(page, 'debug=1&marker=glass');
    const target = order[3];
    const from = await glassBox(page, 1);
    const stripBox = (await page
      .locator(`.vp[data-viewport="1"] .strip[data-file="${target}"] .strip-ws`)
      .boundingBox())!;
    // Client-x at 30% of the painted box; under the 180° rotation that is 70%
    // of the recording's own timeline.
    const to = { x: stripBox.x + stripBox.width * 0.3, y: stripBox.y + stripBox.height / 2 };
    await drag(page, { x: from.x + from.width / 2, y: from.y + from.height / 2 }, to);

    const state = await markerState(page, 1);
    expect(state.ix).not.toBeNull();
    expect(state.homeFile).toBe(target);
    const probe = await page.evaluate((target) => {
      const T = (window as any)._exhibitTest;
      return { time: T.transport._time, expected: 0.7 * T.exhibit.durations[target] };
    }, target);
    expect(Math.abs(probe.time - probe.expected)).toBeLessThan(6);
  });

  // 38.13 The fade-rules classification, both directions (ruled: a marker-snap
  // switch counts as a SEEK — a deliberate jump to elsewhere — where a plain
  // aligned switch is exempt for the jumper). Observable as the jump countdown
  // arming: fadeCapAt is stamped for a seek that leaves the shown text behind,
  // and stays 0 for the exempt switch. The shown-text state is PLANTED in the
  // same synchronous evaluate as the triggering tap (the 37.4 one-evaluate
  // rule), with a synthetic id no region can contain.
  test('38.13 a marker-snap switch arms the jump countdown; a plain aligned switch stays exempt', async ({
    page,
  }) => {
    const qs = 'debug=1&marker=glass&focus=playhead&detailFade=30000';
    const { order, ref } = await boot(page, qs);
    const fileB = order.find((f) => f !== ref)!;

    // Leg A: marker up → the cross-strip tap is a marker-snap → SEEK → armed.
    await page.evaluate((ref) => {
      const T = (window as any)._exhibitTest;
      T.placeMarker(0, ref, 60);
      T.transport.pause();
    }, ref);
    await page.evaluate(
      ({ fileB }) => {
        const T = (window as any)._exhibitTest;
        const vp = T.viewports[0];
        vp.shownId = 'zz-planted-38-13'; // no region can contain a synthetic id
        vp.shownAt = T.readingClock.now();
        vp.shownMs = 30000;
        vp.shownBumped = false;
        vp.fadeCapAt = 0;
        // Same synchronous evaluate as the plant: the bare-switch tap. The
        // click's coordinates are irrelevant — a cross-strip bare switch
        // ignores the finger's x by rule.
        const host = document.querySelector(
          `.vp[data-viewport="0"] .strip[data-file="${fileB}"] .strip-ws`,
        )!;
        host.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      },
      { fileB },
    );
    await expect
      .poll(() => page.evaluate(() => (window as any)._exhibitTest.transport.activeFile))
      .toBe(fileB);
    await expect
      .poll(
        () => page.evaluate(() => (window as any)._exhibitTest.viewports[0].fadeCapAt),
        { message: 'the marker-snap switch never armed the jump countdown' },
      )
      .toBeGreaterThan(0);

    // Leg B: same shape, NO marker → the aligned carry switch is exempt for
    // the jumper, so the countdown must NOT arm. A/B in one run.
    await boot(page, qs);
    await page.evaluate((ref) => {
      const T = (window as any)._exhibitTest;
      T.transport.pause();
      return T.transport.select(ref, 300, /* play */ false);
    }, ref);
    await page.evaluate(
      ({ fileB }) => {
        const T = (window as any)._exhibitTest;
        const vp = T.viewports[0];
        vp.shownId = 'zz-planted-38-13';
        vp.shownAt = T.readingClock.now();
        vp.shownMs = 30000;
        vp.shownBumped = false;
        vp.fadeCapAt = 0;
        const host = document.querySelector(
          `.vp[data-viewport="0"] .strip[data-file="${fileB}"] .strip-ws`,
        )!;
        host.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      },
      { fileB },
    );
    await expect
      .poll(() => page.evaluate(() => (window as any)._exhibitTest.transport.activeFile))
      .toBe(fileB);
    expect(
      await page.evaluate(() => (window as any)._exhibitTest.viewports[0].fadeCapAt),
      'a plain aligned switch must stay exempt for the jumper',
    ).toBe(0);
  });

  // 38.14 Direct mode, marker standing (second iteration round, DIRECT ONLY
  // by ruling): a waveform tap LIFTS the glass into expect-placement instead
  // of seeking — the strap owns switching there, so the glass mediates
  // seeking while it is up. The second tap places AND plays.
  test('38.14 in direct mode a waveform tap with a marker standing lifts instead of seeking', async ({
    page,
  }) => {
    const { order, ref } = await boot(page, 'debug=1&marker=glass&tapMode=direct');
    await page.evaluate((ref) => {
      const T = (window as any)._exhibitTest;
      T.placeMarker(0, ref, 60);
      T.transport.pause();
      return T.transport.select(ref, 300, /* play */ false);
    }, ref);

    const fileB = order.filter((f) => f !== ref)[3];
    const strip = page.locator(`.vp[data-viewport="0"] .strip[data-file="${fileB}"] .strip-ws`);
    const box = (await strip.boundingBox())!;
    await strip.click({ position: { x: Math.round(box.width * 0.8), y: 10 } });

    // Lifted, pulsing — and NOTHING moved: no switch, no seek, marker intact.
    const probe = await page.evaluate(() => {
      const T = (window as any)._exhibitTest;
      return { m: T.marker(0), file: T.transport.activeFile, time: T.transport._time };
    });
    expect(probe.m.lifted).toBe(true);
    expect(probe.m.ix).not.toBeNull();
    expect(probe.file).toBe(ref);
    expect(Math.abs(probe.time - 300)).toBeLessThan(2);
    await expect(page.locator('.vp[data-viewport="0"] .strips')).toHaveClass(/marker-expect/);

    // The second tap places there and plays (R3) — the two-tap seek.
    await strip.click({ position: { x: Math.round(box.width * 0.8), y: 10 } });
    await expect
      .poll(() => page.evaluate(() => (window as any)._exhibitTest.transport.activeFile))
      .toBe(fileB);
    const placed = await page.evaluate((fileB) => {
      const T = (window as any)._exhibitTest;
      return { m: T.marker(0), time: T.transport._time, expected: 0.8 * T.exhibit.durations[fileB] };
    }, fileB);
    expect(placed.m.lifted).toBe(false);
    expect(placed.m.homeFile).toBe(fileB);
    expect(Math.abs(placed.time - placed.expected)).toBeLessThan(5);
  });

  // 38.15 The HYBRID cancel (third round): while lifted, a tap still within
  // the waveform world — here the strap's switch buttons — keeps the marker
  // and settles the glass back onto it (the switch proceeds, and the glass
  // rides to the new audible strip); a tap beyond that world — here the
  // audience switch — returns the glass to its hook, marker and all, while
  // the tapped control still acts.
  test('38.15 lifted taps: waveform-world settles onto the marker, elsewhere returns it to the hook', async ({
    page,
  }) => {
    const { order, ref } = await boot(page, 'debug=1&marker=glass&tapMode=direct');
    await page.evaluate((ref) => {
      const T = (window as any)._exhibitTest;
      T.placeMarker(0, ref, 60);
      T.transport.pause();
    }, ref);
    const before = await markerState(page);
    const strip = page.locator(`.vp[data-viewport="0"] .strip[data-file="${ref}"] .strip-ws`);
    const box = (await strip.boundingBox())!;

    // Leg 1: lift, then tap a strap button — the switch happens, the marker
    // SURVIVES, and the glass settles onto its new home on the audible strip.
    await strip.click({ position: { x: Math.round(box.width * 0.6), y: 10 } });
    expect((await markerState(page)).lifted).toBe(true);
    const fileB = order.filter((f) => f !== ref)[2];
    await page.click(`.vp[data-viewport="0"] .vp-strap .strap-btn[data-file="${fileB}"]`);
    await expect
      .poll(() => page.evaluate(() => (window as any)._exhibitTest.transport.activeFile))
      .toBe(fileB);
    const settled = await markerState(page);
    expect(settled.lifted).toBe(false);
    expect(settled.ix, 'a waveform-world tap cost the marker').toBe(before.ix);
    expect(settled.homeFile).toBe(fileB);

    // Leg 2: lift again, then tap the audience switch — beyond the waveform
    // world: the audience changes AND the glass goes home, marker removed.
    await page.evaluate(() => (window as any)._exhibitTest.transport.pause());
    const stripB = page.locator(`.vp[data-viewport="0"] .strip[data-file="${fileB}"] .strip-ws`);
    await stripB.click({ position: { x: Math.round(box.width * 0.3), y: 10 } });
    expect((await markerState(page)).lifted).toBe(true);
    await page.click('.vp[data-viewport="0"] .audience-btn[data-audience="kids"]');
    await expect
      .poll(() => page.evaluate(() => (window as any)._exhibitTest.audience.get(0)))
      .toBe('kids');
    const gone = await markerState(page);
    expect(gone.lifted).toBe(false);
    expect(gone.ix).toBeNull();
    await expect(page.locator('.vp[data-viewport="0"] .marker-glass')).toHaveClass(/is-resting/);
  });

  // 38.16 The glass RIDES THE AUDIBLE STRIP (second iteration round,
  // superseding "the glass stays where the visitor put it"): a switch hops it
  // to the marker's projection on the newly audible strip; the index is
  // untouched.
  test('38.16 the glass hops to the audible strip on a switch, keeping its moment', async ({
    page,
  }) => {
    const { order, ref } = await boot(page, 'debug=1&marker=glass&tapMode=direct');
    await page.evaluate((ref) => {
      const T = (window as any)._exhibitTest;
      T.placeMarker(0, ref, 60);
      T.transport.pause();
    }, ref);
    const before = await markerState(page);
    expect(before.homeFile).toBe(ref);

    const fileB = order.filter((f) => f !== ref)[2];
    await page.click(`.vp[data-viewport="0"] .vp-strap .strap-btn[data-file="${fileB}"]`);
    await expect
      .poll(() => page.evaluate(() => (window as any)._exhibitTest.marker(0).homeFile))
      .toBe(fileB);
    const after = await markerState(page);
    expect(after.ix, 'the hop must not move the marker itself').toBe(before.ix);
    // Both sides' ghosts follow the same truth: the OTHER viewport's ghost
    // mirrors the new home.
    expect((await markerState(page, 1)).ghost).toEqual(
      expect.objectContaining({ file: fileB }),
    );
  });

  // 38.17 The lens is a CIRCLE, and nothing is magnified under it. Both are
  // rulings rather than incidentals — the oval and the 4× zoom shipped
  // together in 0.36.0 and were both taken back after alpha feedback around
  // the institute (2026-09-01) — so both are pinned here.
  test('38.17 the lens is circular and magnifies nothing under it', async ({ page }) => {
    const { ref } = await boot(page, 'debug=1&marker=glass');
    await page.evaluate((ref) => {
      const T = (window as any)._exhibitTest;
      T.placeMarker(0, ref, 120);
      T.transport.pause();
    }, ref);
    const probe = await page.evaluate(() => {
      const glass = document.querySelector(
        '.vp[data-viewport="0"] .marker-glass',
      ) as HTMLElement;
      const lens = glass.querySelector('.glass-lens')!;
      const ring = glass.querySelector('.glass-ring')!;
      const box = lens.getBoundingClientRect();
      return {
        lensTag: lens.tagName.toLowerCase(),
        ringTag: ring.tagName.toLowerCase(),
        ellipses: glass.querySelectorAll('ellipse').length,
        canvases: glass.querySelectorAll('canvas').length,
        w: box.width,
        h: box.height,
      };
    });
    expect(probe.lensTag).toBe('circle');
    expect(probe.ringTag).toBe('circle');
    expect(probe.ellipses, 'no oval geometry left in the glass').toBe(0);
    expect(probe.canvases, 'the zoom under the lens was removed').toBe(0);
    // Round on the screen, not merely in the markup: a placed glass hangs
    // straight, and every viewport/stage rotation here is a right angle, so a
    // circle's painted box is square either way.
    expect(probe.w).toBeGreaterThan(0);
    expect(Math.abs(probe.w - probe.h), 'the lens paints as an oval').toBeLessThan(1.5);
  });
});
