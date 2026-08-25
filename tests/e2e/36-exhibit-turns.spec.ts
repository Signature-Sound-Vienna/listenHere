import { test, expect, type Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Section 36 — Turn-taking and the AudioArbiter (plan §4.3)
//
// The central §1 feedback question: two visitors, one shared clock, and what
// "play my region" should feel like when it takes the room's audio. turns.js
// is the three candidate answers behind one interface — hijack (the shipped
// default), attribution, and request-and-grant — and arbiter.js is the
// room-level guard against two screens playing at once. Everything here is
// opt-in by query parameter; 36.1 pins that the default is byte-for-byte the
// pre-turns behaviour, which is what makes the variants comparable at the
// Oct/Nov user testing.
//
// HOW THE MACHINE TESTS DRIVE THE TRANSPORT. The contended predicate reads
// `transport.playing`, and real playback arrives on the transport's own
// schedule — the async select tail that poisoned two drafts of spec 35's
// pins. So the policy tests take the armTapRecorder approach one step
// further: `select` is wrapped (recording its arguments and passing
// play=false, so no audio machinery runs at all), and `playing` is shadowed
// by an instance property the test sets explicitly. That tests turns.js
// against exactly the surface it consumes; 36.13–36.15 then run the genuine
// audio path end to end, once per behaviour rather than once per assertion.
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

/**
 * Make the transport quiet and controllable: select() records its calls and
 * never starts audio, and `playing` reads a flag the test flips. See the
 * header — this is the deterministic stand-in for "the holder is listening".
 */
async function armQuietTransport(page: Page) {
  await page.evaluate(() => {
    const T = (window as any)._exhibitTest;
    (window as any)._taps = [];
    const orig = T.transport.select.bind(T.transport);
    T.transport.select = (file: string, time: number) => {
      (window as any)._taps.push({ file, time });
      return orig(file, time, false);
    };
    (window as any)._playing = false;
    Object.defineProperty(T.transport, 'playing', {
      get: () => (window as any)._playing,
      configurable: true,
    });
  });
}

async function setPlaying(page: Page, on: boolean) {
  await page.evaluate((on) => ((window as any)._playing = on), on);
}

/** turns.request(viewport, file, time) from inside the page. */
async function tap(page: Page, viewport: number, file: string, time?: number) {
  await page.evaluate(
    ({ viewport, file, time }) =>
      (window as any)._exhibitTest.turns.request(viewport, file, time),
    { viewport, file, time },
  );
}

/** The turn machine's snapshot plus the transport facts the policies steer. */
async function turnState(page: Page) {
  return page.evaluate(() => {
    const T = (window as any)._exhibitTest;
    const s = T.turns.state();
    return {
      policy: s.policy as string,
      holder: s.holder as number | null,
      pending: s.pending ? { viewport: s.pending.viewport, file: s.pending.file } : null,
      selected: s.selected as string[],
      activeFile: T.transport.activeFile as string,
    };
  });
}

/** One viewport's turn element, as rendered: hidden, role, text, buttons. */
async function turnEl(page: Page, viewport: number) {
  return page.evaluate((viewport) => {
    const el = document.querySelector(`.vp[data-viewport="${viewport}"] .vp-turn`) as HTMLElement;
    return {
      hidden: el.hidden,
      role: el.dataset.role ?? null,
      text: el.textContent,
      buttons: el.querySelectorAll('button').length,
    };
  }, viewport);
}

/** Which files carry this viewport's is-selected mark. */
async function selectedIn(page: Page, viewport: number) {
  return page.evaluate(
    (viewport) =>
      [...document.querySelectorAll(`.vp[data-viewport="${viewport}"] .strip.is-selected`)].map(
        (el: any) => el.dataset.file,
      ),
    viewport,
  );
}

test.describe('36. Turn-taking policies', () => {
  // The kiosk geometry, same reasoning as specs 34/35 (no scroll container).
  test.use({ viewport: { width: 1024, height: 1366 } });

  // 36.1 THE DEFAULT IS THE SHIPPED BEHAVIOUR: no ?turnPolicy means instant,
  // silent hijack — a real tap on the near half switches the recording at
  // once, no turn UI exists on either half, and the only new observable is
  // that the machine now knows WHOSE tap it was. This is the A/B baseline
  // every other test in this file is a variant of.
  test('36.1 default policy is instant hijack: a tap switches immediately and shows no turn UI', async ({
    page,
  }) => {
    const { order, ref } = await boot(page);
    await armQuietTransport(page);
    const other = order.find((f) => f !== ref)!;
    const box = await page
      .locator(`.vp[data-viewport="0"] .strip[data-file="${other}"] .strip-ws`)
      .boundingBox();
    await page.mouse.click(box!.x + box!.width * 0.5, box!.y + box!.height * 0.5);

    const s = await turnState(page);
    expect(s.policy).toBe('hijack');
    expect(s.activeFile).toBe(other);
    expect(s.holder).toBe(0);
    expect(s.pending).toBeNull();
    expect((await turnEl(page, 0)).hidden).toBe(true);
    expect((await turnEl(page, 1)).hidden).toBe(true);
    // The switch-tap rule is unchanged through the new seam: a tap on a
    // NON-active strip carries the moment, so select saw time=undefined.
    const taps = await page.evaluate(() => (window as any)._taps);
    expect(taps).toHaveLength(1);
    expect(taps[0].file).toBe(other);
    expect(taps[0].time).toBeUndefined();
  });

  // 36.2 Per-viewport selection: each half marks ITS OWN last choice, and one
  // side's tap never moves the other side's mark.
  test('36.2 selection marks the tapping viewport only, and the marks are independent', async ({
    page,
  }) => {
    const { order, ref } = await boot(page);
    await armQuietTransport(page);
    const [a, b] = order.filter((f) => f !== ref);
    await tap(page, 0, a);
    expect(await selectedIn(page, 0)).toEqual([a]);
    expect(await selectedIn(page, 1)).toEqual([]);
    await tap(page, 1, b);
    expect(await selectedIn(page, 0)).toEqual([a]);
    expect(await selectedIn(page, 1)).toEqual([b]);
  });

  // 36.3 Attribution: the take is still instant, but the side that LOST the
  // clock is told — and only that side. The notice then fades by itself.
  test('36.3 attribution announces the take to the displaced side, and the notice fades', async ({
    page,
  }) => {
    const { order, ref } = await boot(page, 'turnPolicy=attribution&turnNoticeMs=2500');
    await armQuietTransport(page);
    const [a, b] = order.filter((f) => f !== ref);
    await tap(page, 0, a);
    // The first-ever take displaces nobody: nothing to announce.
    expect((await turnEl(page, 0)).hidden).toBe(true);
    expect((await turnEl(page, 1)).hidden).toBe(true);

    await tap(page, 1, b);
    const s = await turnState(page);
    expect(s.activeFile).toBe(b); // instant, not queued
    expect(s.holder).toBe(1);
    const displaced = await turnEl(page, 0);
    expect(displaced.hidden).toBe(false);
    expect(displaced.role).toBe('notice');
    expect((await turnEl(page, 1)).hidden).toBe(true);
    await expect
      .poll(async () => (await turnEl(page, 0)).hidden, {
        timeout: 10_000,
        message: 'the attribution notice never faded',
      })
      .toBe(true);
  });

  // 36.4 Attribution stays quiet when the clock does not change hands.
  test('36.4 attribution shows nothing when the same side re-taps', async ({ page }) => {
    const { order, ref } = await boot(page, 'turnPolicy=attribution');
    await armQuietTransport(page);
    const [a, b] = order.filter((f) => f !== ref);
    await tap(page, 0, a);
    await tap(page, 0, b);
    expect((await turnEl(page, 0)).hidden).toBe(true);
    expect((await turnEl(page, 1)).hidden).toBe(true);
    expect((await turnState(page)).activeFile).toBe(b);
  });

  // 36.5 Request policy: contention needs a holder AND audible playback, so
  // taps pass instantly before anyone holds the clock and whenever the music
  // is paused — a paused table must never demand a grant from an empty chair.
  test('36.5 request passes freely while nothing is playing', async ({ page }) => {
    const { order, ref } = await boot(page, 'turnPolicy=request');
    await armQuietTransport(page);
    const [a, b] = order.filter((f) => f !== ref);
    await tap(page, 0, a);
    let s = await turnState(page);
    expect(s.holder).toBe(0);
    expect(s.pending).toBeNull();
    // Other side taps while paused: passes, no prompt anywhere.
    await tap(page, 1, b);
    s = await turnState(page);
    expect(s.holder).toBe(1);
    expect(s.activeFile).toBe(b);
    expect(s.pending).toBeNull();
    expect((await turnEl(page, 0)).hidden).toBe(true);
    expect((await turnEl(page, 1)).hidden).toBe(true);
  });

  // 36.6 The contended tap queues: the holder's half grows the prompt with
  // its two buttons, the requester's half says it is waiting, the audio is
  // untouched — and the requester's chosen strip is marked on THEIR half,
  // which is what "selection is expressed desire" buys.
  test('36.6 a contended tap becomes a pending request: prompt, waiting note, audio untouched', async ({
    page,
  }) => {
    const { order, ref } = await boot(page, 'turnPolicy=request');
    await armQuietTransport(page);
    const [a, b] = order.filter((f) => f !== ref);
    await tap(page, 0, a);
    await setPlaying(page, true);
    await tap(page, 1, b);

    const s = await turnState(page);
    expect(s.activeFile).toBe(a); // nothing switched
    expect(s.holder).toBe(0);
    expect(s.pending).toEqual({ viewport: 1, file: b });
    const prompt = await turnEl(page, 0);
    expect(prompt.role).toBe('prompt');
    expect(prompt.buttons).toBe(2);
    expect((await turnEl(page, 1)).role).toBe('waiting');
    expect(await selectedIn(page, 1)).toEqual([b]);
    // One select so far — the requester's tap never reached the transport.
    expect(await page.evaluate(() => (window as any)._taps.length)).toBe(1);
  });

  // 36.7 Grant executes the request: the clock changes hands, the request is
  // consumed, and both surfaces clear.
  test('36.7 the grant button hands the clock over', async ({ page }) => {
    const { order, ref } = await boot(page, 'turnPolicy=request');
    await armQuietTransport(page);
    const [a, b] = order.filter((f) => f !== ref);
    await tap(page, 0, a);
    await setPlaying(page, true);
    await tap(page, 1, b);
    await page.click('.vp[data-viewport="0"] .turn-grant');

    const s = await turnState(page);
    expect(s.activeFile).toBe(b);
    expect(s.holder).toBe(1);
    expect(s.pending).toBeNull();
    expect((await turnEl(page, 0)).hidden).toBe(true);
    expect((await turnEl(page, 1)).hidden).toBe(true);
    // The granted switch carries the musical moment (time undefined), exactly
    // like an uncontended switch-tap would have.
    const last = await page.evaluate(() => (window as any)._taps.at(-1));
    expect(last.file).toBe(b);
    expect(last.time).toBeUndefined();
  });

  // 36.8 Deny dismisses the request and tells the requester — who can simply
  // tap again; nothing is locked.
  test('36.8 the deny button dismisses the request and notifies the requester', async ({
    page,
  }) => {
    const { order, ref } = await boot(page, 'turnPolicy=request');
    await armQuietTransport(page);
    const [a, b] = order.filter((f) => f !== ref);
    await tap(page, 0, a);
    await setPlaying(page, true);
    await tap(page, 1, b);
    await page.click('.vp[data-viewport="0"] .turn-deny');

    const s = await turnState(page);
    expect(s.activeFile).toBe(a);
    expect(s.holder).toBe(0);
    expect(s.pending).toBeNull();
    expect((await turnEl(page, 0)).hidden).toBe(true);
    expect((await turnEl(page, 1)).role).toBe('notice');
    expect(await page.evaluate(() => (window as any)._taps.length)).toBe(1);
  });

  // 36.9 The auto-grant: a pending request resolves by itself after
  // ?turnGrantMs, so an absent holder can never lock the table. This is the
  // museum-floor property the whole policy hangs on.
  test('36.9 a pending request auto-grants after turnGrantMs', async ({ page }) => {
    const { order, ref } = await boot(page, 'turnPolicy=request&turnGrantMs=1500');
    await armQuietTransport(page);
    const [a, b] = order.filter((f) => f !== ref);
    await tap(page, 0, a);
    await setPlaying(page, true);
    await tap(page, 1, b);
    expect((await turnState(page)).pending).not.toBeNull();
    await expect
      .poll(async () => (await turnState(page)).activeFile, {
        timeout: 10_000,
        message: 'the auto-grant never fired',
      })
      .toBe(b);
    expect((await turnState(page)).holder).toBe(1);
  });

  // 36.10 The holder acting while a request stands is the implicit "not yet":
  // their own tap proceeds, the stale request dies with a denial notice, and —
  // critically — the auto-grant timer dies with it, so it cannot fire minutes
  // later against a holder who never saw a prompt.
  test('36.10 the holder tapping while a request is pending implicitly denies it', async ({
    page,
  }) => {
    const { order, ref } = await boot(page, 'turnPolicy=request&turnGrantMs=1500');
    await armQuietTransport(page);
    const [a, b, c] = order.filter((f) => f !== ref);
    await tap(page, 0, a);
    await setPlaying(page, true);
    await tap(page, 1, b);
    await tap(page, 0, c);

    const s = await turnState(page);
    expect(s.activeFile).toBe(c);
    expect(s.holder).toBe(0);
    expect(s.pending).toBeNull();
    expect((await turnEl(page, 1)).role).toBe('notice');
    // The dead request's timer must not resurrect it.
    await page.waitForTimeout(2000);
    const later = await turnState(page);
    expect(later.activeFile).toBe(c);
    expect(later.holder).toBe(0);
  });

  // 36.11 The latest tap wins: a requester changing their mind replaces the
  // pending request — the same last-tap-counts rule the transport applies to
  // racing fetches.
  test('36.11 a newer request replaces the pending one', async ({ page }) => {
    const { order, ref } = await boot(page, 'turnPolicy=request');
    await armQuietTransport(page);
    const [a, b, c] = order.filter((f) => f !== ref);
    await tap(page, 0, a);
    await setPlaying(page, true);
    await tap(page, 1, b);
    await tap(page, 1, c);
    expect((await turnState(page)).pending).toEqual({ viewport: 1, file: c });
    await page.click('.vp[data-viewport="0"] .turn-grant');
    expect((await turnState(page)).activeFile).toBe(c);
  });

  // 36.12 A contended SEEK keeps its tapped moment: the seek-vs-switch intent
  // is captured at tap time, so granting later still lands on the place the
  // finger pointed at, not wherever the clock has since travelled.
  test('36.12 a contended seek on the active strip is honoured at grant time', async ({
    page,
  }) => {
    const { order, ref } = await boot(page, 'turnPolicy=request');
    await armQuietTransport(page);
    const a = order.find((f) => f !== ref)!;
    await tap(page, 0, a);
    await setPlaying(page, true);
    await tap(page, 1, a, 42.5); // the other side taps a PLACE in the active strip
    expect((await turnState(page)).pending).toEqual({ viewport: 1, file: a });
    await page.click('.vp[data-viewport="0"] .turn-grant');
    const last = await page.evaluate(() => (window as any)._taps.at(-1));
    expect(last.file).toBe(a);
    expect(last.time).toBeCloseTo(42.5, 5);
    expect((await turnState(page)).holder).toBe(1);
  });

  // 36.13 An unknown policy must not leave the table tap-dead: it warns and
  // falls back to hijack.
  test('36.13 an unknown turnPolicy falls back to hijack', async ({ page }) => {
    await boot(page, 'turnPolicy=banana');
    expect((await turnState(page)).policy).toBe('hijack');
  });

  // 36.14 The genuine audio path, end to end, once: a real tap starts real
  // playback, a contended request queues against it, and the grant switches
  // the audible recording. Everything 36.5–36.12 asserted piecewise, with the
  // transport's own `playing` doing the gating.
  test('36.14 request-and-grant works against real playback', async ({ page }) => {
    const { order, ref } = await boot(page, 'turnPolicy=request');
    const other = order.find((f) => f !== ref)!;
    const box = await page
      .locator(`.vp[data-viewport="0"] .strip[data-file="${ref}"] .strip-ws`)
      .boundingBox();
    await page.mouse.click(box!.x + box!.width * 0.1, box!.y + box!.height * 0.5);
    await expect
      .poll(() => page.evaluate(() => (window as any)._exhibitTest.transport.playing), {
        timeout: 15_000,
        message: 'the tapped strip never started playing',
      })
      .toBe(true);

    await tap(page, 1, other);
    expect((await turnState(page)).pending).toEqual({ viewport: 1, file: other });
    expect((await turnEl(page, 0)).role).toBe('prompt');
    await page.click('.vp[data-viewport="0"] .turn-grant');
    const s = await turnState(page);
    expect(s.activeFile).toBe(other);
    expect(s.holder).toBe(1);
  });

  // 36.15 The middle band's shared play/pause is policy-exempt by
  // construction: one surface read from both sides cannot be attributed to a
  // viewport, so it neither takes nor needs the turn — and because it leaves
  // the holder empty, the first strip tap afterwards passes without a prompt
  // even under the request policy while audio is genuinely playing.
  test('36.15 the band play button takes no turn, so a first tap passes even mid-playback', async ({
    page,
  }) => {
    const { order, ref } = await boot(page, 'turnPolicy=request');
    const other = order.find((f) => f !== ref)!;
    await page.click('.mb-play');
    await expect
      .poll(() => page.evaluate(() => (window as any)._exhibitTest.transport.playing), {
        timeout: 15_000,
        message: 'the band play button never started the transport',
      })
      .toBe(true);
    expect((await turnState(page)).holder).toBeNull();

    await tap(page, 0, other);
    const s = await turnState(page);
    expect(s.pending).toBeNull();
    expect(s.activeFile).toBe(other);
    expect(s.holder).toBe(0);
  });
});

test.describe('36b. The AudioArbiter', () => {
  test.use({ viewport: { width: 1024, height: 1366 } });

  // 36.16 ?arbiter=broadcast: the LAST claimant wins across two windows of
  // one browser profile — the one-PC-many-windows arrangement the museum
  // table actually is. The default "local" arbiter is inert by construction
  // (one screen, one claimant, nothing to revoke), and every audio test above
  // runs under it — that is the default-unchanged pin.
  test('36.16 with ?arbiter=broadcast the newest playing screen silences the other', async ({
    context,
  }) => {
    const pageA = await context.newPage();
    const pageB = await context.newPage();
    await boot(pageA, 'arbiter=broadcast');
    await boot(pageB, 'arbiter=broadcast');

    await pageA.click('.mb-play');
    await expect
      .poll(() => pageA.evaluate(() => (window as any)._exhibitTest.transport.playing), {
        timeout: 15_000,
        message: 'screen A never started playing',
      })
      .toBe(true);

    await pageB.click('.mb-play');
    await expect
      .poll(() => pageB.evaluate(() => (window as any)._exhibitTest.transport.playing), {
        timeout: 15_000,
        message: 'screen B never started playing',
      })
      .toBe(true);
    await expect
      .poll(() => pageA.evaluate(() => (window as any)._exhibitTest.transport.playing), {
        timeout: 10_000,
        message: "screen B's claim never paused screen A",
      })
      .toBe(false);

    await pageA.close();
    await pageB.close();
  });
});
