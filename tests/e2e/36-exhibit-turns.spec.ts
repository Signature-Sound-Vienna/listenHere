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

  // 36.17 turns.jump (the detail header's "Jump to annotation", ruled
  // 2026-08-25): unlike a strip tap, a jump's time is MEANINGFUL on another
  // recording, so it survives the seek-vs-switch rule — and the pending
  // capture keeps it, so a contended jump granted later still lands on the
  // annotation, not on wherever the clock has drifted to.
  test('36.17 a jump keeps its seek time across a recording switch, pending included', async ({
    page,
  }) => {
    const { order, ref } = await boot(page, 'turnPolicy=request');
    await armQuietTransport(page);
    await tap(page, 0, ref); // side 0 takes the clock…
    await setPlaying(page, true); // …and is listening: the table is contended

    await page.evaluate(
      ({ file, t }) => (window as any)._exhibitTest.turns.jump(1, file, t),
      { file: order[1], t: 12.34 },
    );
    let s = await turnState(page);
    expect(s.pending).toEqual({ viewport: 1, file: order[1] });

    await page.evaluate(() => (window as any)._exhibitTest.turns.grant());
    const taps = await page.evaluate(() => (window as any)._taps);
    // The granted jump switched recording AND kept the annotation's moment.
    expect(taps[taps.length - 1]).toEqual({ file: order[1], time: 12.34 });
    s = await turnState(page);
    expect(s.holder).toBe(1);
    expect(s.activeFile).toBe(order[1]);
  });

  // 36.20 After "Not yet", a cooldown (user, 2026-09-03; ?turnDenyCooldownMs,
  // 0 = off, the shipped behaviour): a repeated tap from the denied side is
  // not put to the holder again — no prompt — the requester just sees "the
  // other side is still listening" once more, until the period is over. The
  // tap still marks their choice on their own half.
  test('36.20 after a denial the requester waits out the cooldown: no new prompt, the notice instead, then the prompt again', async ({
    page,
  }) => {
    const { order, ref } = await boot(page, 'turnPolicy=request&turnDenyCooldownMs=1500&turnNoticeMs=600');
    await armQuietTransport(page);
    const [a, b] = order.filter((f) => f !== ref);
    await tap(page, 0, a);
    await setPlaying(page, true);
    await tap(page, 1, b);
    await page.click('.vp[data-viewport="0"] .turn-deny');
    expect((await turnEl(page, 1)).role).toBe('notice');
    // Let the denial's notice fade, so the next notice is provably the cooldown's.
    await expect.poll(async () => (await turnEl(page, 1)).hidden).toBe(true);

    await tap(page, 1, b);
    let s = await turnState(page);
    expect(s.pending, 'no request is put to the holder during the cooldown').toBeNull();
    expect(s.holder).toBe(0);
    expect(s.activeFile).toBe(a);
    expect((await turnEl(page, 0)).hidden, 'the holder is not prompted again').toBe(true);
    const note = await turnEl(page, 1);
    expect(note.role).toBe('notice');
    expect(note.text).toContain('still listening');
    expect(note.buttons).toBe(0);
    expect(await selectedIn(page, 1), 'the tap still marks the choice on its own half').toEqual([b]);
    expect(
      await page.evaluate(() => (window as any)._exhibitTest.turns.state().cooldownUntil[1] > Date.now()),
    ).toBe(true);

    // The period over, a tap is a request again.
    await page.waitForTimeout(1600);
    await tap(page, 1, b);
    s = await turnState(page);
    expect(s.pending).toEqual({ viewport: 1, file: b });
    expect((await turnEl(page, 0)).buttons).toBe(2);
    expect(await page.evaluate(() => (window as any)._taps.length)).toBe(1);
  });

  // 36.21 The default is 0: a re-tap after a denial prompts again at once —
  // the shipped behaviour, kept for the A/B.
  test('36.21 with no cooldown configured a re-tap after a denial prompts the holder again at once', async ({
    page,
  }) => {
    const { order, ref } = await boot(page, 'turnPolicy=request');
    await armQuietTransport(page);
    const [a, b] = order.filter((f) => f !== ref);
    await tap(page, 0, a);
    await setPlaying(page, true);
    await tap(page, 1, b);
    await page.click('.vp[data-viewport="0"] .turn-deny');
    await tap(page, 1, b);
    expect((await turnState(page)).pending).toEqual({ viewport: 1, file: b });
    expect((await turnEl(page, 0)).buttons).toBe(2);
    expect(await page.evaluate(() => (window as any)._exhibitTest.config.turnDenyCooldownMs)).toBe(0);
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

  // 36.22 Claims carry a KIND (attract loop v2, 0.60.0): a visitor's outranks
  // the loop's. The loop asking for the speakers a person holds is told to
  // stand down and the person hears nothing of it; a person asking for the
  // speakers the loop holds takes them, as the last claimant always did.
  test("36.22 with kinds, the loop's claim cannot silence a person and a person's claim silences the loop", async ({
    context,
  }) => {
    const pageA = await context.newPage();
    const pageB = await context.newPage();
    await boot(pageA, 'arbiter=broadcast');
    await boot(pageB, 'arbiter=broadcast');

    // A person plays on A: a "visitor" claim (no loop drives A's transport).
    await pageA.click('.mb-play');
    await expect
      .poll(() => pageA.evaluate(() => (window as any)._exhibitTest.transport.playing), { timeout: 15_000 })
      .toBe(true);
    // The claim rides on the transport's emit after play(), which on Firefox
    // follows the suspended context's start by a few milliseconds: poll.
    await expect.poll(() => pageA.evaluate(() => (window as any)._exhibitTest.arbiter.kind)).toBe('visitor');

    // The loop on B asks: B is revoked by the visitor, A plays on untouched.
    await pageB.evaluate(() => {
      const T = (window as any)._exhibitTest;
      (window as any)._revoked = [];
      T.arbiter.onRevoked((_by: string, kind: string) => (window as any)._revoked.push(kind));
      T.arbiter.claim('loop');
    });
    await expect.poll(() => pageB.evaluate(() => (window as any)._revoked)).toEqual(['visitor']);
    expect(await pageB.evaluate(() => (window as any)._exhibitTest.arbiter.holding)).toBe(false);
    await pageB.waitForTimeout(500);
    expect(await pageA.evaluate(() => (window as any)._exhibitTest.transport.playing), 'the loop cannot silence a person').toBe(true);
    expect(await pageA.evaluate(() => (window as any)._exhibitTest.arbiter.holding)).toBe(true);

    // The other way round: A's speakers were the loop's; a person's tap on B takes them.
    await pageA.evaluate(() => (window as any)._exhibitTest.arbiter.claim('loop'));
    await pageB.click('.mb-play');
    await expect
      .poll(() => pageB.evaluate(() => (window as any)._exhibitTest.transport.playing), { timeout: 15_000 })
      .toBe(true);
    await expect
      .poll(() => pageA.evaluate(() => (window as any)._exhibitTest.transport.playing), {
        timeout: 10_000,
        message: "the person's claim never silenced the loop's screen",
      })
      .toBe(false);
    expect(await pageB.evaluate(() => (window as any)._exhibitTest.arbiter.kind)).toBe('visitor');

    await pageA.close();
    await pageB.close();
  });
});

test.describe('36. Demo feedback — the band says whose turn it is', () => {
  test.use({ viewport: { width: 1024, height: 1366 } });

  // 36.18 THE TURN MARK. Nothing on the shared band said whose tap the clock was
  // answering (Chanda, demo feedback 2026-09-01) — `.strip.is-selected` speaks
  // for one viewport only, and the `.vp-turn` notices are transient and exist
  // under two of the three policies. The mark is on the HOLDER'S EDGE of the
  // band, which makes it language-free and orientation-free, and it paints
  // nothing before the first tap: with no holder there is no claim to make.
  test('36.18 the turn mark paints on the holder’s edge, in every band orientation', async ({
    page,
  }) => {
    await boot(page, 'debug=1');

    const markFor = (holder: number | null) =>
      page.evaluate(async (h) => {
        const T = (window as any)._exhibitTest;
        if (h != null) T.turns.request(h, T.exhibit.order[h === 0 ? 1 : 2]);
        await new Promise((r) => setTimeout(r, 60));
        const band = T.band.el as HTMLElement;
        const cs = getComputedStyle(band, '::before');
        return {
          holder: band.dataset.turnHolder,
          height: cs.height,
          top: cs.top,
          bottom: cs.bottom,
          transparent: cs.backgroundColor === 'rgba(0, 0, 0, 0)',
        };
      }, holder);

    // Before anybody has taken the clock: no mark at all.
    const idle = await markFor(null);
    expect(idle.holder).toBe('');
    expect(idle.height).toBe('0px');
    expect(idle.transparent).toBe(true);

    // Viewport 0 renders BELOW the band (the column is reversed so the near
    // reader is at the near edge), so its mark is the band's bottom edge.
    const near = await markFor(0);
    expect(near.holder).toBe('0');
    expect(near.height).toBe('4px');
    expect(near.bottom).toBe('0px');
    expect(near.transparent).toBe(false);

    // Viewport 1 is above it.
    const far = await markFor(1);
    expect(far.holder).toBe('1');
    expect(far.top).toBe('0px');
    expect(far.transparent).toBe(false);

    // It is not tied to one orientation — that was the explicit ask.
    for (const orientation of ['rotated', 'mirrored', 'flip']) {
      await boot(page, `debug=1&bandOrientation=${orientation}`);
      const m = await markFor(0);
      expect(m.holder, `holder unset under ${orientation}`).toBe('0');
      expect(m.transparent, `no mark painted under ${orientation}`).toBe(false);
    }

    // ?turnIndicator=off is the comparator and paints nothing at all.
    await boot(page, 'debug=1&turnIndicator=off');
    const off = await markFor(0);
    expect(off.holder).toBe('0');
    expect(off.transparent, 'turnIndicator=off must paint nothing').toBe(true);

    // One viewport has no turn to signal, so the mark is suppressed rather
    // than painted permanently for the only reader there is.
    await boot(page, 'debug=1&viewports=1');
    expect(
      await page.evaluate(
        () => ((window as any)._exhibitTest.band.el as HTMLElement).dataset.turnIndicator,
      ),
    ).toBe('off');
  });

  // 36.19 FLIP: the fourth band orientation (Chanda, demo feedback 2026-09-01) —
  // upright's single cluster, turned to face whoever last took the clock.
  //
  // The assertions read the INLINE transform, not the computed one, and that is
  // deliberate: the rotation is animated, so the computed value is a matrix
  // somewhere along a 420 ms curve — and in a backgrounded page transitions do
  // not advance at all, which would read as a permanent identity matrix. The
  // inline value is the app's decision, which is what this pins.
  test('36.19 ?bandOrientation=flip turns the cluster to the holder and never the play control', async ({
    page,
  }) => {
    await boot(page, 'debug=1&bandOrientation=flip');

    const read = () =>
      page.evaluate(() => {
        const band = (window as any)._exhibitTest.band.el as HTMLElement;
        const cluster = band.querySelector('.mb-cluster') as HTMLElement;
        const play = band.querySelector('.mb-play') as HTMLElement;
        return {
          orientation: band.dataset.orientation,
          clusters: band.querySelectorAll('.mb-cluster').length,
          height: Math.round(band.getBoundingClientRect().height),
          cluster: cluster.style.transform || '',
          // The play control must never be inside the rotation: ▶ turned 180°
          // is ◀, which would say the opposite of what the button does.
          playInsideCluster: !!play.closest('.mb-cluster'),
          playRotation: getComputedStyle(play).transform,
          glyph: play.textContent,
          turning: cluster.classList.contains('mb-turning'),
          opacity: getComputedStyle(cluster).opacity,
        };
      });

    const take = (v: number) =>
      page.evaluate((i) => {
        const T = (window as any)._exhibitTest;
        T.turns.request(i, T.exhibit.order[i + 1]);
      }, v);

    // RETRYING, because the default cue is a cross-fade: the facing changes at
    // the faint midpoint, ~150 ms after the tap, not synchronously with it. A
    // one-shot read a few frames later would see the OLD facing and fail, which
    // is how the fade first announced itself here.
    const expectFacing = (want: string) =>
      expect
        .poll(async () =>
          page.evaluate(
            () =>
              (
                (window as any)._exhibitTest.band.el.querySelector(
                  '.mb-cluster',
                ) as HTMLElement
              ).style.transform || '',
          ),
        )
        .toBe(want);

    const idle = await read();
    // ONE cluster, like upright — the piece is named once per view, not once
    // per reader — and upright's height, so unlike `rotated` the flip costs
    // the commentary panel nothing.
    expect(idle.clusters).toBe(1);
    expect(idle.height).toBe(96);
    expect(idle.cluster, 'no rotation before anyone has taken the clock').toBe('');
    expect(idle.playInsideCluster).toBe(false);

    await take(0);
    await expectFacing('');

    await take(1);
    // …and viewport 1's configured rotation, read from the config rather than
    // assumed: a hardcoded 180 here would be wrong the day the table is not
    // two facing halves (§7.8).
    const expected = await page.evaluate(
      () => (window as any)._exhibitTest.config?.rotations?.[1] ?? 180,
    );
    await expectFacing(`rotate(${expected}deg)`);
    const far = await read();
    expect(far.playRotation, 'the play control is never rotated').toBe('none');
    expect(far.glyph, 'and never becomes ◀').not.toBe('◀');
    // The cue never leaves the cluster parked mid-dip. `turning` is the state
    // machine and is settled the moment the facing lands; the OPACITY is a CSS
    // transition still running back up at that instant, so it has to be polled
    // rather than read once — asserting a mid-transition value is precisely the
    // flake this suite has been bitten by before.
    expect(far.turning, 'the fade settles').toBe(false);
    await expect
      .poll(async () =>
        page.evaluate(
          () =>
            getComputedStyle(
              (window as any)._exhibitTest.band.el.querySelector('.mb-cluster'),
            ).opacity,
        ),
      )
      .toBe('1');

    // Back again — the band returns, it does not accumulate rotation.
    await take(0);
    await expectFacing('');

    // ?bandFlipMotion=spin is the comparator: the rotation itself animates, so
    // the facing is set at once and the CSS carries it.
    await boot(page, 'debug=1&bandOrientation=flip&bandFlipMotion=spin');
    await take(1);
    await expectFacing(`rotate(${expected}deg)`);
    expect(
      await page.evaluate(() => {
        const c = (window as any)._exhibitTest.band.el.querySelector(
          '.mb-cluster',
        ) as HTMLElement;
        return getComputedStyle(c).transitionProperty;
      }),
      'spin animates transform, fade animates opacity',
    ).toContain('transform');

    // Flip needs a second side to face. One viewport degrades to upright.
    await boot(page, 'debug=1&viewports=1&bandOrientation=flip');
    expect(
      await page.evaluate(
        () => ((window as any)._exhibitTest.band.el as HTMLElement).dataset.orientation,
      ),
    ).toBe('upright');
  });
});

// ---------------------------------------------------------------------------
// 36c. THE ROOM'S TURN MACHINE (plan §4.4, the room machine, 2026-09-11). Under
// ?room=shared the two windows of the museum PC share ONE machine, hosted in a
// SharedWorker (room-worker.js): viewports are room ids (screen × 2 + local
// index, so 0–3), the holder can be on either table, the prompt of the request
// policy appears on the HOLDER's viewport wherever it is, the requester sees
// the wait, the other two viewports see nothing of it, and a take — a tap, a
// grant, an auto-grant — is EXECUTED on the window that owns the taking
// viewport. Two pages of one browser context share the worker (probed in both
// browsers 2026-09-11), which is exactly the two-window arrangement.
//
// The same quiet transport as above: select() records, `playing` is a flag.
// Room audibility (the contended predicate) is the worker's: a window claims
// on its audible edge, so "the holder is listening" is the flag plus a seek.
// THE MIRROR RECORDS TOO: once a window is audible, every other window follows
// it through select() with the room's TIME as the target (room.js), so
// `_taps` holds the mirror's re-aims beside the machine's takes. The takes
// here are all bare switches — no time, the carry-over — so `tapsOf` reads
// exactly the entries without a time: the machine's, never the mirror's.
// ---------------------------------------------------------------------------

test.describe("36c. The room's turn machine", () => {
  test.use({ viewport: { width: 1024, height: 1366 } });

  const tapsOf = (p: Page) =>
    p.evaluate(() =>
      ((window as any)._taps as { file: string; time?: number }[]).filter((t) => t.time === undefined).map((t) => t.file),
    );
  const roomState = (p: Page) => p.evaluate(() => (window as any)._exhibitTest.room.state());
  const bandHolder = (p: Page) =>
    p.evaluate(() => ((window as any)._exhibitTest.band.el as HTMLElement).dataset.turnHolder);

  /** Two windows of one room, screen 0 and screen 1, both welcomed by the worker. */
  async function bootRoom(context: any, qs = '') {
    const pageA = await context.newPage();
    const pageB = await context.newPage();
    const { order } = await boot(pageA, `debug=1&room=shared&screen=0${qs}`);
    await boot(pageB, `debug=1&room=shared&screen=1${qs}`);
    await armQuietTransport(pageA);
    await armQuietTransport(pageB);
    for (const p of [pageA, pageB]) {
      await expect.poll(async () => (await roomState(p)).welcomed, { timeout: 5_000 }).toBe(true);
    }
    // One worker, two windows: each snapshot lists both.
    await expect.poll(async () => (await roomState(pageA)).snapshot?.windows?.length, { timeout: 5_000 }).toBe(2);
    await expect.poll(async () => (await roomState(pageB)).snapshot?.windows?.length, { timeout: 5_000 }).toBe(2);
    return { pageA, pageB, order };
  }

  /**
   * The room hears `page`: a person touches it (the hand-off — a window that has
   * been MIRRORING is muted, and the audible edge needs the unmute; without the
   * touch this raced the once-a-second sync and failed on Firefox), its
   * transport "plays", and the arbiter claims through the worker.
   */
  async function makeAudible(page: Page) {
    await page.evaluate(() => (window as any)._exhibitTest.room.touch());
    await setPlaying(page, true);
    await page.evaluate(() => (window as any)._exhibitTest.transport.seek(10));
    const id = await page.evaluate(() => (window as any)._exhibitTest.room.id);
    await expect.poll(async () => (await roomState(page)).snapshot?.audible?.id, { timeout: 5_000 }).toBe(id);
  }

  test('36.23 two windows share one machine: a tap on screen 1 takes the clock for room viewport 2 and executes on that window alone', async ({
    context,
  }) => {
    const { pageA, pageB, order } = await bootRoom(context);
    expect(await pageA.evaluate(() => (window as any)._exhibitTest.turns.shared)).toBe(true);
    expect(await pageB.evaluate(() => (window as any)._exhibitTest.viewports.map((v: any) => v.roomId))).toEqual([2, 3]);
    const [a, b] = order;

    // A's near reader (room 0) chooses: the take executes on A, and B's snapshot agrees.
    await tap(pageA, 0, a);
    await expect.poll(async () => (await turnState(pageB)).holder).toBe(0);
    expect(await tapsOf(pageA)).toEqual([a]);
    expect(await tapsOf(pageB)).toEqual([]);
    expect(await selectedIn(pageA, 0)).toEqual([a]);
    expect(await selectedIn(pageB, 0), 'room viewport 2 chose nothing yet').toEqual([]);
    expect(await bandHolder(pageA), "A's band marks its near edge").toBe('0');
    expect(await bandHolder(pageB), "B's band marks nobody: the holder is on the other table").toBe('');

    // B's near reader (room 2) takes: executed on B, not on A; both agree on the holder.
    await tap(pageB, 2, b);
    await expect.poll(async () => (await turnState(pageA)).holder).toBe(2);
    expect((await turnState(pageB)).holder).toBe(2);
    await expect.poll(() => tapsOf(pageB)).toEqual([b]);
    expect(await tapsOf(pageA), 'the take is executed once, on the taker\'s window').toEqual([a]);
    expect(await selectedIn(pageB, 0)).toEqual([b]);
    expect(await selectedIn(pageA, 0), "A's own choice stays marked").toEqual([a]);
    expect(await bandHolder(pageB)).toBe('0');
    expect(await bandHolder(pageA)).toBe('');

    await pageA.close();
    await pageB.close();
  });

  test('36.24 attribution across screens: the viewport that lost the clock is told, on its own window and nowhere else', async ({
    context,
  }) => {
    const { pageA, pageB, order } = await bootRoom(context, '&turnPolicy=attribution');
    await tap(pageA, 0, order[0]);
    await expect.poll(async () => (await turnState(pageB)).holder).toBe(0);
    // B's FAR reader (room 3) takes.
    await tap(pageB, 3, order[1]);
    await expect.poll(async () => (await turnEl(pageA, 0)).role).toBe('notice');
    expect((await turnEl(pageA, 1)).hidden).toBe(true);
    expect((await turnEl(pageB, 0)).hidden).toBe(true);
    expect((await turnEl(pageB, 1)).hidden).toBe(true);
    expect((await turnState(pageA)).holder).toBe(3);
    await expect.poll(() => tapsOf(pageB)).toEqual([order[1]]);
    await pageA.close();
    await pageB.close();
  });

  test("36.25 request across screens: the prompt on the holder's viewport, the wait on the requester's, nothing on the other two; the grant executes on the requester's window", async ({
    context,
  }) => {
    const { pageA, pageB, order } = await bootRoom(context, '&turnPolicy=request&turnGrantMs=0');
    const idOf = (p: Page) => p.evaluate(() => (window as any)._exhibitTest.room.id as string);
    const mutedOf = (p: Page) => p.evaluate(() => (window as any)._exhibitTest.transport.muted as boolean);
    const fileOf = (p: Page) => p.evaluate(() => (window as any)._exhibitTest.transport.activeFile as string);
    // A's far reader (room 1) holds and listens; B mirrors, muted.
    await tap(pageA, 1, order[0]);
    await expect.poll(async () => (await turnState(pageB)).holder).toBe(1);
    await makeAudible(pageA);
    await expect.poll(() => mutedOf(pageB), { timeout: 5_000 }).toBe(true);

    // A visitor arrives at B: the touch is the hand-off (B sounds the same
    // performance, A fades out and follows), and B's near reader (room 2) asks.
    await setPlaying(pageB, true);
    await pageB.evaluate(() => (window as any)._exhibitTest.room.touch());
    await expect.poll(async () => (await roomState(pageA)).snapshot?.audible?.id, { timeout: 5_000 }).toBe(await idOf(pageB));
    await expect.poll(() => mutedOf(pageA), { timeout: 5_000 }).toBe(true);
    await tap(pageB, 2, order[1]);
    await expect.poll(async () => (await turnEl(pageA, 1)).role).toBe('prompt');
    expect((await turnEl(pageA, 1)).buttons).toBe(2);
    await expect.poll(async () => (await turnEl(pageB, 0)).role).toBe('waiting');
    expect((await turnEl(pageA, 0)).hidden, 'the holder\'s neighbour sees nothing').toBe(true);
    expect((await turnEl(pageB, 1)).hidden, "the requester's neighbour sees nothing").toBe(true);
    expect((await turnState(pageA)).pending).toEqual({ viewport: 2, file: order[1] });
    expect(await tapsOf(pageB), 'nothing executed yet').toEqual([]);
    expect(await selectedIn(pageB, 0), 'the requester\'s choice is marked while they wait').toEqual([order[1]]);

    // The holder grants, on A — a real click on the prompt's button, which is
    // NOT a hand-off touch: A stays muted. The take lands on B, and A follows it.
    await pageA.click('.vp[data-viewport="1"] .turn-grant');
    await expect.poll(async () => (await turnState(pageB)).holder).toBe(2);
    await expect.poll(() => tapsOf(pageB)).toEqual([order[1]]);
    expect(await tapsOf(pageA)).toEqual([order[0]]);
    expect(await mutedOf(pageA), 'the grant button is an answer, not an arrival').toBe(true);
    expect(await mutedOf(pageB)).toBe(false);
    await expect.poll(() => fileOf(pageA), { timeout: 10_000 }).toBe(order[1]);
    await expect.poll(async () => (await turnEl(pageA, 1)).hidden).toBe(true);
    await expect.poll(async () => (await turnEl(pageB, 0)).hidden).toBe(true);
    expect((await turnState(pageA)).pending).toBeNull();
    await pageA.close();
    await pageB.close();
  });

  test("36.26 deny and cooldown across screens: the requester's notice on their window, and a re-tap inside the cooldown prompts nobody", async ({
    context,
  }) => {
    const { pageA, pageB, order } = await bootRoom(
      context,
      '&turnPolicy=request&turnGrantMs=0&turnDenyCooldownMs=60000',
    );
    await tap(pageA, 0, order[0]);
    await expect.poll(async () => (await turnState(pageB)).holder).toBe(0);
    await makeAudible(pageA);
    await tap(pageB, 2, order[1]);
    await expect.poll(async () => (await turnEl(pageA, 0)).role).toBe('prompt');

    await pageA.evaluate(() => (window as any)._exhibitTest.turns.deny());
    await expect.poll(async () => (await turnEl(pageB, 0)).role).toBe('notice');
    await expect.poll(async () => (await turnState(pageA)).pending).toBeNull();
    await expect.poll(async () => (await turnEl(pageA, 0)).hidden).toBe(true);
    expect((await turnState(pageB)).holder).toBe(0);

    // Inside the cooldown: B's re-tap marks the choice but puts nothing to A.
    await tap(pageB, 2, order[2]);
    await expect.poll(() => selectedIn(pageB, 0)).toEqual([order[2]]);
    await pageB.waitForTimeout(400);
    expect((await turnState(pageA)).pending).toBeNull();
    expect((await turnEl(pageA, 0)).hidden).toBe(true);
    expect((await turnEl(pageB, 0)).role).toBe('notice');
    expect(await tapsOf(pageB)).toEqual([]);
    await pageA.close();
    await pageB.close();
  });

  test("36.27 an auto-grant executes on the requester's window, and both windows' grant rings agree", async ({ context }) => {
    const { pageA, pageB, order } = await bootRoom(context, '&turnPolicy=request&turnGrantMs=3000');
    await tap(pageA, 0, order[0]);
    await expect.poll(async () => (await turnState(pageB)).holder).toBe(0);
    await makeAudible(pageA);
    await tap(pageB, 3, order[1]);
    await expect.poll(async () => (await turnEl(pageA, 0)).role).toBe('prompt');
    await expect.poll(async () => (await turnEl(pageB, 1)).role).toBe('waiting');
    // The ring (0.64.0) counts the same deadline down on both tables: the
    // machine's wall-clock stamp, read by both windows.
    await pageA.waitForTimeout(600);
    const fracA = await ringFrac(pageA, 0);
    const fracB = await ringFrac(pageB, 1);
    expect(fracA).not.toBeNull();
    expect(fracB).not.toBeNull();
    expect(fracA!).toBeLessThan(1);
    expect(Math.abs(fracA! - fracB!)).toBeLessThan(0.1);
    await expect.poll(async () => (await turnState(pageA)).holder, { timeout: 8_000 }).toBe(3);
    await expect.poll(() => tapsOf(pageB)).toEqual([order[1]]);
    expect(await tapsOf(pageA)).toEqual([order[0]]);
    await pageA.close();
    await pageB.close();
  });

  test("36.28 a requester that leaves the room withdraws its request: the holder's prompt goes, no denial, no cooldown", async ({
    context,
  }) => {
    const { pageA, pageB, order } = await bootRoom(context, '&turnPolicy=request&turnGrantMs=0&turnDenyCooldownMs=60000');
    await tap(pageA, 0, order[0]);
    await expect.poll(async () => (await turnState(pageB)).holder).toBe(0);
    await makeAudible(pageA);
    await tap(pageB, 2, order[1]);
    await expect.poll(async () => (await turnEl(pageA, 0)).role).toBe('prompt');
    // B navigates away: pagehide says bye to the worker.
    await pageB.goto('about:blank');
    await expect.poll(async () => (await turnState(pageA)).pending, { timeout: 5_000 }).toBeNull();
    await expect.poll(async () => (await turnEl(pageA, 0)).hidden).toBe(true);
    const s = await pageA.evaluate(() => (window as any)._exhibitTest.turns.state());
    expect(s.holder).toBe(0);
    expect(s.cooldownUntil, 'a withdrawal is not a denial').toEqual({});
    await expect.poll(async () => (await roomState(pageA)).snapshot?.windows?.length).toBe(1);
    await pageA.close();
    await pageB.close();
  });

  test("36.29 the room's arbiter is the worker's: a loop's claim cannot take the speakers from a person, a person's takes them from the loop", async ({
    context,
  }) => {
    const { pageA, pageB } = await bootRoom(context);
    // A person listens on A.
    await makeAudible(pageA);
    expect((await roomState(pageA)).snapshot.audible.kind).toBe('visitor');
    // The loop asks from B: refused — B alone is told, A holds on.
    await pageB.evaluate(() => {
      const T = (window as any)._exhibitTest;
      (window as any)._revoked = [];
      T.arbiter.onRevoked((_by: string, kind: string) => (window as any)._revoked.push(kind));
      T.arbiter.claim('loop');
    });
    await expect.poll(() => pageB.evaluate(() => (window as any)._revoked)).toEqual(['visitor']);
    expect(await pageB.evaluate(() => (window as any)._exhibitTest.arbiter.holding)).toBe(false);
    expect(await pageA.evaluate(() => (window as any)._exhibitTest.arbiter.holding)).toBe(true);
    const idA = await pageA.evaluate(() => (window as any)._exhibitTest.room.id);
    expect((await roomState(pageB)).snapshot.audible.id).toBe(idA);
    // The other way round: A's speakers become the loop's; a person on B takes them.
    await pageA.evaluate(() => (window as any)._exhibitTest.arbiter.claim('loop'));
    await expect.poll(async () => (await roomState(pageA)).snapshot.audible.kind).toBe('loop');
    await makeAudible(pageB);
    await expect.poll(() => pageA.evaluate(() => (window as any)._exhibitTest.arbiter.holding), { timeout: 5_000 }).toBe(false);
    expect(await pageB.evaluate(() => (window as any)._exhibitTest.arbiter.kind)).toBe('visitor');
    await pageA.close();
    await pageB.close();
  });

  test('36.30 without SharedWorker the room falls back to per-screen turns with a warning; room ids still name the viewports', async ({
    context,
  }) => {
    const page = await context.newPage();
    const warnings: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'warning') warnings.push(m.text());
    });
    await page.addInitScript(() => {
      (window as any).SharedWorker = undefined;
    });
    const { order } = await boot(page, 'debug=1&room=shared&screen=1');
    const s = await roomState(page);
    expect(s.universal).toBe(true);
    expect(s.worker).toBe(false);
    expect(await page.evaluate(() => (window as any)._exhibitTest.turns.shared)).toBe(false);
    expect(warnings.some((w) => w.includes('SharedWorker unavailable'))).toBe(true);
    await armQuietTransport(page);
    await tap(page, 2, order[0]);
    expect((await turnState(page)).holder).toBe(2);
    expect(await tapsOf(page)).toEqual([order[0]]);
    expect(await selectedIn(page, 0)).toEqual([order[0]]);
    await page.close();
  });

  // 36.31 THE GRANT RING (user, 2026-09-15: the auto-grant "feels a bit of a
  // rug-pull"; 0.64.0). While a request stands with a deadline, the holder's
  // prompt AND the requester's waiting note carry a depleting ring — the
  // "Keep reading…" ring's twin — driven from the machine's `pending.expiresAt`;
  // both go with the grant. With explicit grants only (turnGrantMs=0) there is
  // no deadline and no ring. The prompt is rebuilt only when the request
  // changes, so the ring's tick never recreates the buttons under a finger.
  test('36.31 a pending request shows a depleting grant ring on the prompt and on the wait; none without a deadline', async ({
    context,
  }) => {
    const page = await context.newPage();
    const { order } = await boot(page, 'debug=1&turnPolicy=request&turnGrantMs=3000');
    await armQuietTransport(page);
    await tap(page, 0, order[0]);
    await setPlaying(page, true);
    await tap(page, 1, order[1]);
    await expect.poll(async () => (await turnEl(page, 0)).role).toBe('prompt');
    expect((await turnEl(page, 1)).role).toBe('waiting');
    expect(await page.locator('.vp[data-viewport="0"] .vp-turn .turn-ring').count()).toBe(1);
    expect(await page.locator('.vp[data-viewport="1"] .vp-turn .turn-ring').count()).toBe(1);
    // A mark on the button: if the ring's tick rebuilt the prompt, it would be gone.
    await page.evaluate(() => ((document.querySelector('.vp[data-viewport="0"] .turn-grant') as HTMLElement).dataset.mark = 'same'));
    // Half way through the window the ring is below half, and the buttons are the same elements.
    await page.waitForTimeout(1500);
    const f0 = await ringFrac(page, 0);
    const f1 = await ringFrac(page, 1);
    expect(f0!).toBeLessThan(0.55);
    expect(f0!).toBeGreaterThan(0.2);
    expect(Math.abs(f0! - f1!)).toBeLessThan(0.1);
    expect(
      await page.evaluate(() => (document.querySelector('.vp[data-viewport="0"] .turn-grant') as HTMLElement).dataset.mark),
      'the prompt was not rebuilt under the finger',
    ).toBe('same');
    // The grant: both rings go with the prompt and the wait.
    await expect.poll(async () => (await turnState(page)).holder, { timeout: 5_000 }).toBe(1);
    await expect.poll(() => page.locator('.vp-turn .turn-ring').count()).toBe(0);
    expect((await turnEl(page, 0)).hidden).toBe(true);
    expect((await turnEl(page, 1)).hidden).toBe(true);

    // No deadline, no ring.
    await boot(page, 'debug=1&turnPolicy=request&turnGrantMs=0');
    await armQuietTransport(page);
    await tap(page, 0, order[0]);
    await setPlaying(page, true);
    await tap(page, 1, order[1]);
    await expect.poll(async () => (await turnEl(page, 0)).role).toBe('prompt');
    expect((await turnEl(page, 1)).role).toBe('waiting');
    expect(await page.locator('.vp-turn .turn-ring').count()).toBe(0);
    await page.close();
  });
});

/** The grant ring's fraction on one viewport's turn element, or null without a ring. */
async function ringFrac(page: Page, viewport: number) {
  return page.evaluate((v) => {
    const ring = document.querySelector(`.vp[data-viewport="${v}"] .vp-turn .turn-ring`) as HTMLElement | null;
    if (!ring) return null;
    const raw = ring.style.getPropertyValue('--turn-frac');
    return raw === '' ? null : Number(raw);
  }, viewport);
}
