import { test, expect, type Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Section 47 — The attract loop (plan §4.4; design ruled 2026-09-07; 0.56.0)
//
// How an unattended table behaves. Four contracts worth pinning:
//
//   1. OFF BY DEFAULT: without ?attractAfterIdleMs the loop is not even created
//      — no band in the DOM, no idle listener, no channel (the A/B rule).
//   2. IDLE → SWEEP → BAND → PLAY: the table tidies itself (explorers closed,
//      nobody holding the clock), raises the band, and asks the transport for
//      the first recording from 0:00; at an annotation's moment it switches to
//      the recording that annotation targets (the table's own aligned switch).
//   3. THE VISITOR WALKS INTO A LIVE TABLE (ruling R7): a touch lowers the band
//      and stops the SCHEDULING, never the music; the loop re-arms on quiet.
//   4. THE ROOM: two screens agree on idleness; one leader plays, the other
//      raises its band and rests; a touch on either ends the loop for both.
//   5. THE MIRROR (v2, 0.60.0): the idle screen plays what the room hears,
//      muted and in step; a tap there hands the speakers over with the other
//      screen mirroring on; the loop's claim never outranks a person's; the
//      silence between passes is the room's (47.13–47.16, 36b's ranking test).
//
// The transport is the quiet stand-in of spec 36 (select records, never
// plays; `playing` is a flag the test flips), and idle windows are seconds.
// ---------------------------------------------------------------------------

const IDLE = 'debug=1&attractAfterIdleMs=1200';

async function boot(page: Page, qs = 'debug=1') {
  await page.goto(`/exhibit?${qs}`);
  const ok = await page.evaluate(() => (window as any)._exhibitTest.ready);
  expect(ok, 'exhibit boot promise resolved falsy — see console for the error').toBe(true);
  return page.evaluate(() => {
    const T = (window as any)._exhibitTest;
    return {
      order: T.exhibit.order as string[],
      ref: T.exhibit.piece.ref as string,
      durations: T.exhibit.durations as Record<string, number>,
    };
  });
}

/** select() records its calls and never starts audio; `playing` reads a test flag. */
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

async function attract(page: Page) {
  return page.evaluate(() => (window as any)._exhibitTest.attract?.state() ?? null);
}

async function bandUp(page: Page) {
  return page.evaluate(() => {
    const el = document.querySelector('.attract-band') as HTMLElement | null;
    return !!el && !el.hidden && el.classList.contains('is-up');
  });
}

async function taps(page: Page) {
  return page.evaluate(() => (window as any)._taps as { file: string; time: number }[]);
}

test.describe('47. The attract loop', () => {
  test.use({ viewport: { width: 1024, height: 1366 } });

  // 47.1 The A/B rule: the shipped exhibit has no loop at all.
  test('47.1 without ?attractAfterIdleMs there is no loop, no band, and nothing listening', async ({ page }) => {
    await boot(page);
    expect(await attract(page)).toBeNull();
    expect(await page.locator('.attract-band').count()).toBe(0);
    expect(await page.evaluate(() => (window as any)._exhibitTest.config.attractAfterIdleMs)).toBe(0);
    // The room (room.js) is inert too: no channel, no listeners, no sync.
    expect(await page.evaluate(() => (window as any)._exhibitTest.room.state().active)).toBe(false);
  });

  // 47.2 Idle → sweep → band → the first recording from the top; then the
  // first annotation's moment switches to the recording it targets.
  test('47.2 after the idle window the table sweeps itself, raises the band, plays from the top, and switches at the first annotation', async ({
    page,
  }) => {
    // A wider window than IDLE: the things to sweep must be in place before the
    // loop's tick fires (Firefox under parallel workers took over 2 s to get there).
    const { order } = await boot(page, `debug=1&attractAfterIdleMs=2500&turnPolicy=request&viewSwitch=1`);
    await armQuietTransport(page);
    // Something to sweep: one half in an explorer, a holder on the clock.
    await page.evaluate(() => (window as any)._exhibitTest.setView(0, 'years'));
    expect((await attract(page)).phase, 'the loop has not fired yet').toBe('idle-wait');
    await page.evaluate((f) => (window as any)._exhibitTest.turns.request(0, f), order[1]);
    expect(await page.evaluate(() => (window as any)._exhibitTest.turns.state().holder)).toBe(0);
    (await taps(page)).length = 0;
    await page.evaluate(() => ((window as any)._taps = []));

    await expect.poll(async () => (await attract(page))?.phase, { timeout: 8_000 }).toBe('attract');
    expect(await bandUp(page)).toBe(true);
    // Swept.
    expect(await page.evaluate(() => (window as any)._exhibitTest.view(0))).toBe('listen');
    expect(await page.evaluate(() => (window as any)._exhibitTest.turns.state().holder)).toBeNull();
    // Playing from the top of the first recording, on the pass's audience. The
    // first select builds a player (a nine-megabyte fetch), so `started` follows
    // the phase by a moment.
    await expect.poll(async () => (await attract(page))?.started, { timeout: 15_000 }).toBe(true);
    const s = await attract(page);
    expect(s.leader).toBe(true);
    const t0 = await taps(page);
    expect(t0[0]).toEqual({ file: order[0], time: 0 });
    expect(s.audience).not.toBeNull();
    expect(await page.evaluate(() => (window as any)._exhibitTest.audience.get(0))).toBe(s.audience);
    expect(await page.evaluate(() => (window as any)._exhibitTest.audience.get(1))).toBe(s.audience);
    // The band carries the words and the marks.
    await expect(page.locator('.attract-band .ab-copy')).toHaveCount(2);
    await expect(page.locator('.attract-band .ab-copy[data-copy="0"] .ab-title')).toContainText('Same Procedure');
    expect(await page.locator('.attract-band .ab-copy[data-copy="0"] .ab-logos .ab-mark').count()).toBe(3);
    // One language per copy, the viewport's (English by default): no German line.
    await expect(page.locator('.attract-band .ab-copy[data-copy="0"] .ab-fwf p[lang="en"]')).toContainText('FWF');
    expect(await page.locator('.attract-band .ab-copy[data-copy="0"] p[lang="de"]').count()).toBe(0);

    // The switch at the next step: seek just past its moment in the current
    // recording and the loop asks for the recording that annotation targets.
    expect(s.steps.length).toBeGreaterThan(0);
    const next = s.steps[s.pointer];
    expect(next, 'a step is still ahead').toBeTruthy();
    expect(s.nextAt).not.toBeNull();
    await page.evaluate((t) => (window as any)._exhibitTest.transport.seek(t), s.nextAt + 0.05);
    const after = await attract(page);
    expect(after.pointer).toBeGreaterThan(s.pointer);
    if (next.file !== order[0]) {
      const t1 = await taps(page);
      expect(t1[t1.length - 1].file).toBe(next.file);
    }
  });

  // 47.3 A touch lowers the band and stops the scheduling, not the music (R7);
  // quiet again, the loop re-arms.
  test('47.3 a touch lowers the band into a live table without pausing, and the loop re-arms on quiet', async ({ page }) => {
    const { order } = await boot(page, IDLE);
    await armQuietTransport(page);
    await page.evaluate(() => (window as any)._exhibitTest.attract.force());
    await expect.poll(async () => (await attract(page))?.phase).toBe('attract');
    expect(await bandUp(page)).toBe(true);
    const before = (await taps(page)).length;
    await page.evaluate(() => ((window as any)._paused = 0));
    await page.evaluate(() => {
      const T = (window as any)._exhibitTest;
      const orig = T.transport.pause.bind(T.transport);
      T.transport.pause = () => { (window as any)._paused += 1; return orig(); };
    });

    await page.mouse.click(512, 683); // the band itself, mid-screen
    await expect.poll(async () => (await attract(page))?.phase).toBe('idle-wait');
    await expect.poll(() => bandUp(page)).toBe(false);
    expect(await page.evaluate(() => (window as any)._paused)).toBe(0);
    expect((await taps(page)).length).toBe(before);
    expect(await page.evaluate(() => (window as any)._exhibitTest.transport.activeFile)).toBe(order[0]);

    // Quiet for the idle window again: the band comes back.
    await expect.poll(async () => (await attract(page))?.phase, { timeout: 8_000 }).toBe('attract');
    expect(await bandUp(page)).toBe(true);
  });

  // 47.4 Refused playback (no activation, a browser at default policy): the
  // band stays with the tap line emphasised, until the first touch.
  test('47.4 refused playback leaves the band up as “tap to start” until the first touch', async ({ page }) => {
    await boot(page, IDLE);
    await page.evaluate(() => {
      const T = (window as any)._exhibitTest;
      T.transport.select = () => Promise.reject(Object.assign(new Error('gesture required'), { name: 'NotAllowedError' }));
    });
    await page.evaluate(() => (window as any)._exhibitTest.attract.force());
    await expect.poll(async () => (await attract(page))?.phase).toBe('locked');
    expect(await bandUp(page)).toBe(true);
    await expect(page.locator('.attract-band')).toHaveClass(/is-locked/);
    await expect(page.locator('.attract-band .ab-copy[data-copy="0"] .ab-tap')).toBeVisible();
    // The locked tap line pulses (user, 2026-09-15) — CSS only, and not under reduced motion.
    const pulse = () =>
      page.evaluate(() => {
        const tap = document.querySelector('.attract-band .ab-copy[data-copy="0"] .ab-tap') as HTMLElement;
        const ring = document.querySelector('.attract-band .ab-copy[data-copy="0"] .ab-tap-ring') as SVGElement;
        return { tap: getComputedStyle(tap).animationName, ring: getComputedStyle(ring).animationDuration };
      });
    expect(await pulse()).toEqual({ tap: 'ab-tap-pulse', ring: '1.2s' });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect((await pulse()).tap).toBe('none');
    await page.emulateMedia({ reducedMotion: null });
    await page.mouse.click(512, 683);
    await expect.poll(async () => (await attract(page))?.phase).toBe('idle-wait');
    await expect.poll(() => bandUp(page)).toBe(false);
  });

  // 47.5 The silence between passes, without a reload: the next pass starts
  // by itself after the gap, from the top again.
  test('47.5 after the piece ends the loop falls silent for the gap, then plays again from the top', async ({ page }) => {
    const { order, durations } = await boot(page, `${IDLE}&attractGapMs=900&attractReload=0`);
    await armQuietTransport(page);
    await page.evaluate(() => (window as any)._exhibitTest.attract.force());
    await expect.poll(async () => (await attract(page))?.started).toBe(true);
    // The end of the recording, and not playing: the pass is over.
    await page.evaluate((t) => (window as any)._exhibitTest.transport.seek(t), durations[order[0]] - 0.1);
    await expect.poll(async () => (await attract(page))?.phase).toBe('gap');
    const inGap = await attract(page);
    expect(inGap.passCount).toBe(1);
    expect(inGap.gapEndsAt).toBeGreaterThan(Date.now() - 100);
    const before = (await taps(page)).length;
    await expect.poll(async () => (await attract(page))?.phase, { timeout: 5_000 }).toBe('attract');
    await expect.poll(async () => (await taps(page)).length).toBeGreaterThan(before);
    const t = await taps(page);
    expect(t[t.length - 1]).toEqual({ file: order[0], time: 0 });
    expect(await bandUp(page)).toBe(true);
  });

  // 47.6 With the reload on, the page reloads itself in the middle of the
  // silence and resumes the loop at once — no second idle wait, the band
  // straight up, the rest of the gap honoured.
  test('47.6 with attractReload the page reloads in the silence and resumes the loop without a new idle wait', async ({ page }) => {
    const { order, durations } = await boot(page, `${IDLE}&attractGapMs=1600&attractReload=1`);
    await armQuietTransport(page);
    await page.evaluate(() => (window as any)._exhibitTest.attract.force());
    await expect.poll(async () => (await attract(page))?.started).toBe(true);
    const reloaded = page.waitForEvent('load');
    await page.evaluate((t) => (window as any)._exhibitTest.transport.seek(t), durations[order[0]] - 0.1);
    await expect.poll(async () => (await attract(page))?.phase).toBe('gap');
    await reloaded;
    expect(await page.evaluate(() => (window as any)._exhibitTest.ready)).toBe(true);
    const s = await attract(page);
    expect(s.resumed).toBe(true);
    expect(s.passCount).toBe(1);
    expect(s.bandUp).toBe(true);
    expect(['gap', 'attract', 'locked']).toContain(s.phase);
    // The rest of the gap, then a pass is asked for (whether the browser lets
    // it sound is the autoplay policy's business — see attract.js).
    await expect
      .poll(async () => (await attract(page))?.phase, { timeout: 5_000 })
      .not.toBe('gap');
  });

  // 47.7 A held audience.
  test('47.7 attractAudience holds one audience for every pass', async ({ page }) => {
    const mode = await (async () => {
      await boot(page, IDLE);
      return page.evaluate(() => {
        const set = new Set(((window as any)._exhibitTest.exhibit.annotations as any[]).map((a) => a.audience));
        return [...set].sort().pop() as string;
      });
    })();
    await boot(page, `${IDLE}&attractAudience=${mode}`);
    await armQuietTransport(page);
    await page.evaluate(() => (window as any)._exhibitTest.attract.force());
    await expect.poll(async () => (await attract(page))?.started).toBe(true);
    expect((await attract(page)).audience).toBe(mode);
    expect(await page.evaluate(() => (window as any)._exhibitTest.audience.get(0))).toBe(mode);
    expect(await page.evaluate(() => (window as any)._exhibitTest.audience.get(1))).toBe(mode);
  });

  // 47.8 The room: two screens each pass their own idle window, the room is
  // idle when the later one does, one leader plays, both raise their band; a
  // touch on the OTHER screen ends the scheduling and leaves this one RESTING
  // (band up, mirroring — the rest phase, 0.64.0), never a live table.
  test('47.8 two screens: one leader plays, both raise the band, and a touch on one leaves the other resting', async ({
    context,
  }) => {
    const pageA = await context.newPage();
    const pageB = await context.newPage();
    await boot(pageA, IDLE);
    await boot(pageB, IDLE);
    await armQuietTransport(pageA);
    await armQuietTransport(pageB);
    await expect.poll(async () => (await attract(pageA))?.peers).toBe(1);
    await expect.poll(async () => (await attract(pageB))?.peers).toBe(1);
    await expect.poll(async () => (await attract(pageA))?.phase, { timeout: 8_000 }).toBe('attract');
    await expect.poll(async () => (await attract(pageB))?.phase, { timeout: 8_000 }).toBe('attract');
    await expect
      .poll(async () => (await attract(pageA)).started || (await attract(pageB)).started, { timeout: 15_000 })
      .toBe(true);
    const [a, b] = [await attract(pageA), await attract(pageB)];
    expect([a.leader, b.leader].filter(Boolean)).toHaveLength(1);
    expect(a.started && b.started, 'only the leader plays').toBe(false);
    expect(a.leader ? a.started : b.started, 'the leader is the one playing').toBe(true);
    expect(await bandUp(pageA)).toBe(true);
    expect(await bandUp(pageB)).toBe(true);

    // A visitor at B: B's band goes and B is live; A stops scheduling and RESTS
    // — band up, nothing scheduled, the other screen in use. Both presence
    // paths are the channel's here (room=off).
    expect(a.presence).toBe('channel');
    await pageB.mouse.click(512, 683);
    await expect.poll(async () => (await attract(pageB))?.phase).toBe('idle-wait');
    await expect.poll(async () => (await attract(pageA))?.phase).toBe('rest');
    await expect.poll(() => bandUp(pageB)).toBe(false);
    expect(await bandUp(pageA)).toBe(true);
    expect((await attract(pageA)).started).toBe(false);
    expect((await attract(pageA)).roomIdle).toBe(false);
    // A stays resting while B is in use: its own window passed long ago, the room is B's.
    await pageB.waitForTimeout(600);
    await pageB.mouse.click(512, 683);
    await pageB.waitForTimeout(600);
    expect((await attract(pageA)).phase).toBe('rest');
    expect((await attract(pageB)).phase).toBe('idle-wait');
    // B untouched for its window: the room is idle again — B's band rises, the loop resumes.
    await expect.poll(async () => (await attract(pageB))?.phase, { timeout: 8_000 }).toBe('attract');
    await expect.poll(async () => (await attract(pageA))?.phase, { timeout: 5_000 }).toBe('attract');
    expect(await bandUp(pageB)).toBe(true);

    await pageA.close();
    await pageB.close();
  });

  // 47.9 The study panel offers the loop on its own tab: the demo button and
  // five parameters, the one idle timer first (35.25 pins the preset's 3 min).
  test('47.9 the study panel has an Attract tab with the demo button and five parameters', async ({ page }) => {
    await boot(page, 'debug=1&studyPanel=true');
    await page.click('.study-cog');
    await page.click('.study-tab[data-tab="attract"]');
    const labels = await page.locator('.study-row .study-label').allTextContents();
    expect(labels).toEqual([
      'Demo',
      'Screen idle after (ms; 0 = off)',
      'Silence between passes (ms)',
      'Reload in the silence',
      'Annotations shown',
      'Logo language',
    ]);
    await expect(page.locator('.study-row').nth(1).locator('.study-option.is-on')).toHaveText(/^0 •$/);
    expect(await page.evaluate(() => 'attractDuringPlaybackMs' in (window as any)._exhibitTest.config)).toBe(false);
  });

  // 47.10 THE TAKE-OVER (user, 2026-09-07; the one timer since 2026-09-16):
  // music playing and the screen untouched for T — the loop TAKES OVER from
  // the playhead: band up, table tidied, no restart from the top, the audience
  // as it was, and only the annotations still ahead are switch points.
  test('47.10 a playing table untouched for the idle window is taken over from the current playhead, not restarted', async ({
    page,
  }) => {
    const { order } = await boot(page, `${IDLE}&viewSwitch=1`);
    await armQuietTransport(page);
    await page.evaluate((f) => (window as any)._exhibitTest.turns.request(0, f), order[2]);
    await page.evaluate(() => (window as any)._exhibitTest.setView(1, 'years'));
    await page.evaluate(() => (window as any)._exhibitTest.transport.seek(30));
    await page.evaluate(() => ((window as any)._playing = true));
    const audienceBefore = await page.evaluate(() => (window as any)._exhibitTest.audience.get(0));
    const tapsBefore = (await taps(page)).length;
    await expect.poll(async () => (await attract(page))?.phase, { timeout: 8_000 }).toBe('attract');
    const s = await attract(page);
    expect(s.takenOver).toBe(true);
    expect(s.started).toBe(true);
    expect((await taps(page)).length, 'no select: the music plays on from where it was').toBe(tapsBefore);
    expect(await page.evaluate(() => (window as any)._exhibitTest.transport.activeFile)).toBe(order[2]);
    expect(await page.evaluate(() => (window as any)._exhibitTest.audience.get(0))).toBe(audienceBefore);
    expect(await bandUp(page)).toBe(true);
    expect(await page.evaluate(() => (window as any)._exhibitTest.view(1)), 'swept').toBe('listen');
    if (s.nextAt != null) expect(s.nextAt).toBeGreaterThan(30);
  });

  // 47.12 Each copy speaks its reader's language (config.languages, per
  // viewport): a German half gets the German eyebrow, intro, and funder's
  // line, the English title by design; the English half is unchanged.
  test('47.12 each copy of the band speaks its own viewport\'s language', async ({ page }) => {
    await boot(page, `${IDLE}&languages=de,en`);
    await armQuietTransport(page);
    await page.evaluate(() => (window as any)._exhibitTest.attract.force());
    await expect.poll(async () => (await attract(page))?.phase).toBe('attract');
    const de = page.locator('.attract-band .ab-copy[data-copy="0"]');
    const en = page.locator('.attract-band .ab-copy[data-copy="1"]');
    await expect(de.locator('.ab-eyebrow')).toHaveText('Die Wiener Neujahrskonzerte');
    await expect(de.locator('.ab-intro p[lang="de"]')).toContainText('Neujahrstag');
    await expect(de.locator('.ab-fwf p[lang="de"]')).toContainText('Wissenschaftsfond');
    await expect(de.locator('.ab-title')).toHaveText('Same Procedure as Every Year?');
    await expect(de.locator('.ab-tap span[lang="de"]')).toContainText('Tippen Sie, um loszulegen');
    await expect(en.locator('.ab-tap span[lang="en"]')).toContainText('Tap to get started');
    await expect(en.locator('.ab-eyebrow')).toHaveText("Vienna's New Year's Concerts");
    await expect(en.locator('.ab-intro p[lang="en"]')).toContainText('New Year');
    expect(await en.locator('p[lang="de"]').count()).toBe(0);
  });

  // 47.11 The timer counts TOUCHES only (user, 2026-09-16; inverted from v1,
  // where the music stopping restarted the count): music that plays and then
  // stops does not postpone the band — it rises T after the last touch, and
  // the room being silent by then, the leader plays from the top.
  test('47.11 the idle window counts touches only: music stopping does not postpone the band', async ({ page }) => {
    const T = 2500;
    const { order } = await boot(page, `debug=1&attractAfterIdleMs=${T}`);
    const booted = Date.now();
    await armQuietTransport(page);
    await page.evaluate((f) => (window as any)._exhibitTest.turns.request(0, f), order[1]);
    await page.evaluate(() => ((window as any)._playing = true));
    await page.evaluate(() => (window as any)._exhibitTest.transport.seek(30));
    // Still counting, band down, while the music plays…
    await page.waitForTimeout(1800);
    expect((await attract(page)).phase).toBe('idle-wait');
    expect(await bandUp(page)).toBe(false);
    // …the music stops (the flag, then a seek so the transport emits): no restart of the count.
    await page.evaluate(() => ((window as any)._playing = false));
    await page.evaluate(() => (window as any)._exhibitTest.transport.seek(31));
    // The band rises at T from boot (+ the one-second tick), not T from the stop.
    const deadline = booted + T + 1500;
    await expect.poll(async () => (await attract(page))?.phase, { timeout: Math.max(500, deadline - Date.now()) }).toBe('attract');
    expect(await bandUp(page)).toBe(true);
    const s = await attract(page);
    expect(s.takenOver, 'the room was silent: a pass from the top, not a take-over').toBe(false);
    await expect.poll(async () => (await attract(page))?.started, { timeout: 15_000 }).toBe(true);
    const t = await taps(page);
    expect(t[t.length - 1]).toEqual({ file: order[0], time: 0 });
  });

  // 47.13 THE MIRROR (ruling R7 in full; v2, 0.60.0). The idle screen plays what
  // the room hears — the same file, muted, within a second of the audible one —
  // and a tap there is the hand-off: this copy unmutes and claims the speakers,
  // the other screen mutes and keeps mirroring the new audible table. Nothing
  // goes silent on touch. Both pages run the quiet stand-in, so "playing" is a
  // flag and the sync is what carries the moment.
  test('47.13 the idle screen mirrors the leader muted and in step; a tap hands the speakers over and the other screen mirrors on', async ({
    context,
  }) => {
    const pageA = await context.newPage();
    const pageB = await context.newPage();
    const { order } = await boot(pageA, `${IDLE}&arbiter=broadcast`);
    await boot(pageB, `${IDLE}&arbiter=broadcast`);
    await armQuietTransport(pageA);
    await armQuietTransport(pageB);
    await expect.poll(async () => (await attract(pageA))?.peers).toBe(1);
    await expect.poll(async () => (await attract(pageB))?.peers).toBe(1);
    await expect.poll(async () => (await attract(pageA))?.phase, { timeout: 8_000 }).toBe('attract');
    await expect.poll(async () => (await attract(pageB))?.phase, { timeout: 8_000 }).toBe('attract');
    await expect
      .poll(async () => (await attract(pageA)).started || (await attract(pageB)).started, { timeout: 15_000 })
      .toBe(true);
    const [leader, follower] = (await attract(pageA)).leader ? [pageA, pageB] : [pageB, pageA];
    const fileOf = (p: Page) => p.evaluate(() => (window as any)._exhibitTest.transport.activeFile as string);
    const timeOf = (p: Page) => p.evaluate(() => (window as any)._exhibitTest.transport.time as number);
    const mutedOf = (p: Page) => p.evaluate(() => (window as any)._exhibitTest.transport.muted as boolean);
    const holding = (p: Page) => p.evaluate(() => (window as any)._exhibitTest.arbiter.holding as boolean);

    // The leader's music "plays" from 40 s (the flag, then a seek so the transport
    // emits and the arbiter hears the audible edge): once a second it says where it is.
    await leader.evaluate(() => ((window as any)._playing = true));
    await leader.evaluate(() => (window as any)._exhibitTest.transport.seek(40));
    await expect.poll(() => holding(leader)).toBe(true);
    // The follower follows: same file, muted, within a second, driving nothing itself.
    await expect.poll(async () => (await attract(follower)).mirroring, { timeout: 5_000 }).toBe(true);
    expect(await mutedOf(follower)).toBe(true);
    await expect.poll(() => fileOf(follower), { timeout: 10_000 }).toBe(order[0]);
    await expect.poll(() => timeOf(follower), { timeout: 5_000 }).toBeGreaterThan(39);
    expect(await timeOf(follower)).toBeLessThan(45);
    expect((await attract(follower)).started).toBe(false);
    expect(await holding(follower), 'a muted mirror claims nothing').toBe(false);
    // A seek on the leader is followed.
    await leader.evaluate(() => (window as any)._exhibitTest.transport.seek(120));
    await expect.poll(() => timeOf(follower), { timeout: 5_000 }).toBeGreaterThan(119);

    // The hand-off: the follower's muted copy is running; a visitor taps it.
    await follower.evaluate(() => ((window as any)._playing = true));
    await follower.mouse.click(512, 683);
    await expect.poll(async () => (await attract(follower)).phase).toBe('idle-wait');
    await expect.poll(() => bandUp(follower)).toBe(false);
    expect(await mutedOf(follower)).toBe(false);
    expect((await attract(follower)).mirroring).toBe(false);
    await expect.poll(() => holding(follower)).toBe(true);
    // The leader yielded — muted, not paused — with its band up, RESTING and
    // mirroring the new audible table (the other screen is in use).
    await expect.poll(() => mutedOf(leader), { timeout: 5_000 }).toBe(true);
    const l = await attract(leader);
    expect(l.mirroring).toBe(true);
    expect(l.bandUp).toBe(true);
    expect(l.phase).toBe('rest');
    expect(await leader.evaluate(() => (window as any)._exhibitTest.transport.playing), 'nothing goes silent on touch').toBe(true);
    expect(await holding(leader)).toBe(false);
    // The visitor switches recordings: the mirroring screen switches with them.
    await follower.evaluate((f) => (window as any)._exhibitTest.turns.request(0, f), order[2]);
    await expect.poll(() => fileOf(follower)).toBe(order[2]);
    await expect.poll(() => fileOf(leader), { timeout: 10_000 }).toBe(order[2]);
    expect(await mutedOf(leader)).toBe(true);

    await pageA.close();
    await pageB.close();
  });

  // 47.14 The silence is the room's: when the audible pass ends, the mirroring
  // screen falls into the same gap (and would reload in it), then waits for
  // the leader's next pass rather than starting one of its own.
  test("47.14 the leader's pass ending puts the mirroring screen into the same silence", async ({ context }) => {
    const pageA = await context.newPage();
    const pageB = await context.newPage();
    const qs = `${IDLE}&arbiter=broadcast&attractGapMs=1500&attractReload=0`;
    const { order, durations } = await boot(pageA, qs);
    await boot(pageB, qs);
    await armQuietTransport(pageA);
    await armQuietTransport(pageB);
    await expect.poll(async () => (await attract(pageA))?.peers).toBe(1);
    await expect.poll(async () => (await attract(pageB))?.phase, { timeout: 8_000 }).toBe('attract');
    await expect.poll(async () => (await attract(pageA))?.phase, { timeout: 8_000 }).toBe('attract');
    await expect
      .poll(async () => (await attract(pageA)).started || (await attract(pageB)).started, { timeout: 15_000 })
      .toBe(true);
    const [leader, follower] = (await attract(pageA)).leader ? [pageA, pageB] : [pageB, pageA];
    await leader.evaluate(() => ((window as any)._playing = true));
    await leader.evaluate(() => (window as any)._exhibitTest.transport.seek(5));
    await expect.poll(async () => (await attract(follower)).mirroring, { timeout: 5_000 }).toBe(true);
    // The end of the recording, not playing: the leader's pass is over.
    await leader.evaluate(() => ((window as any)._playing = false));
    await leader.evaluate((t) => (window as any)._exhibitTest.transport.seek(t), durations[order[0]] - 0.1);
    await expect.poll(async () => (await attract(leader)).phase).toBe('gap');
    await expect.poll(async () => (await attract(follower)).phase, { timeout: 3_000 }).toBe('gap');
    const [l, f] = [await attract(leader), await attract(follower)];
    expect(Math.abs(l.gapEndsAt - f.gapEndsAt)).toBeLessThan(300);
    expect(f.mirroring).toBe(false);
    // After the gap the leader plays again from the top; the follower only waits.
    const before = (await taps(leader)).length;
    await expect.poll(async () => (await attract(leader)).phase, { timeout: 5_000 }).toBe('attract');
    await expect.poll(async () => (await taps(leader)).length).toBeGreaterThan(before);
    await expect.poll(async () => (await attract(follower)).phase, { timeout: 5_000 }).toBe('attract');
    expect((await attract(follower)).started).toBe(false);
    await pageA.close();
    await pageB.close();
  });

  // 47.15 THE BAND PER SCREEN over a visitor's music (0.64.0): B, untouched,
  // RESTS under A's visitor's music — band up, mirroring, no pass. When A's
  // visitor has been gone T, both screens are past their window and the room
  // is idle: the AUDIBLE window, A, is TAKEN OVER from its playhead — never
  // restarted, whoever the leader is — and B follows it. When A's music ends,
  // the room falls into the gap and the leader's next pass starts from the top.
  test('47.15 the loop never plays over an audible table: the untouched screen rests, the audible one is taken over at T, and the gap follows', async ({
    context,
  }) => {
    const pageA = await context.newPage();
    const pageB = await context.newPage();
    const qs = `${IDLE}&arbiter=broadcast&attractGapMs=1500&attractReload=0`;
    const { order, durations } = await boot(pageA, qs);
    await boot(pageB, qs);
    await armQuietTransport(pageA);
    await armQuietTransport(pageB);
    await expect.poll(async () => (await attract(pageA))?.peers).toBe(1);
    await expect.poll(async () => (await attract(pageB))?.peers).toBe(1);
    // A visitor at A: the touch, a take, "playing" (the flag, then a seek so the room hears the audible edge).
    await pageA.evaluate(() => (window as any)._exhibitTest.room.touch());
    await pageA.evaluate((f) => (window as any)._exhibitTest.turns.request(0, f), order[1]);
    await pageA.evaluate(() => ((window as any)._playing = true));
    await pageA.evaluate(() => (window as any)._exhibitTest.transport.seek(10));
    const tapsA = (await taps(pageA)).length;
    // B goes untouched past T while A is in use — the visitor keeps touching A
    // (the idle window is 1.2 s here): B RESTS — band up, mirroring A, no pass.
    for (let i = 0; i < 12 && (await attract(pageB)).phase !== 'rest'; i++) {
      await pageA.evaluate(() => (window as any)._exhibitTest.room.touch());
      await pageA.waitForTimeout(400);
    }
    expect((await attract(pageB)).phase).toBe('rest');
    expect(await bandUp(pageB)).toBe(true);
    expect((await attract(pageB)).started).toBe(false);
    expect((await attract(pageB)).peerAudible).toBe(true);
    await expect.poll(() => pageB.evaluate(() => (window as any)._exhibitTest.transport.activeFile), { timeout: 10_000 }).toBe(order[1]);
    expect((await attract(pageA)).phase, 'A is live').toBe('idle-wait');
    expect(await bandUp(pageA)).toBe(false);
    // A's visitor has been gone T: A's band rises and A is TAKEN OVER from its
    // playhead — no select, the same recording — and B follows as the loop's.
    await expect.poll(async () => (await attract(pageA))?.phase, { timeout: 8_000 }).toBe('attract');
    const a = await attract(pageA);
    expect(a.takenOver).toBe(true);
    expect(a.started).toBe(true);
    expect((await taps(pageA)).length, 'never restarted').toBe(tapsA);
    expect(await pageA.evaluate(() => (window as any)._exhibitTest.transport.activeFile)).toBe(order[1]);
    expect(await bandUp(pageA)).toBe(true);
    await expect.poll(async () => (await attract(pageB))?.phase, { timeout: 5_000 }).toBe('attract');
    expect((await attract(pageB)).started).toBe(false);
    // A's music ends: the room's gap, then the leader's pass from the top.
    await pageA.evaluate(() => ((window as any)._playing = false));
    await pageA.evaluate((t) => (window as any)._exhibitTest.transport.seek(t), durations[order[1]] - 0.1);
    await expect.poll(async () => (await attract(pageA))?.phase).toBe('gap');
    await expect.poll(async () => (await attract(pageB))?.phase, { timeout: 3_000 }).toBe('gap');
    const [leader, follower] = (await attract(pageA)).leader ? [pageA, pageB] : [pageB, pageA];
    await expect.poll(async () => (await attract(leader)).started, { timeout: 8_000 }).toBe(true);
    const t = await taps(leader);
    expect(t[t.length - 1]).toEqual({ file: order[0], time: 0 });
    expect((await attract(follower)).started).toBe(false);
    await pageA.close();
    await pageB.close();
  });

  // 47.16 The autoplay policy made visible (audio.js `_awaitRunning`): Web Audio
  // never rejects play(), so a context the browser keeps suspended is reported
  // as a NotAllowedError from select(), which is what locks the loop (47.4).
  // The wait itself is stubbed: headless browsers start every context (measured
  // 2026-09-10), so the refusal is only observable headed, or on the iPad.
  test('47.16 a context that never runs makes select() reject with NotAllowedError, and the loop locks', async ({ page }) => {
    const { order } = await boot(page, IDLE);
    await page.evaluate(() => {
      const T = (window as any)._exhibitTest;
      T.transport._awaitRunning = () =>
        Promise.reject(Object.assign(new Error('suspended'), { name: 'NotAllowedError' }));
    });
    const rejected = await page.evaluate(
      (f) => (window as any)._exhibitTest.transport.select(f, 0).then(() => null, (e: any) => e.name),
      order[0],
    );
    expect(rejected).toBe('NotAllowedError');
    // The probe's play() resolved before the wait rejected, so the (silent) transport
    // reports playing; paused, or the loop would take the "playing" table over
    // rather than start its own pass (47.10) — the pass is what locks.
    await page.evaluate(() => (window as any)._exhibitTest.transport.pause());
    await page.evaluate(() => (window as any)._exhibitTest.attract.force());
    await expect.poll(async () => (await attract(page))?.phase, { timeout: 15_000 }).toBe('locked');
    expect(await bandUp(page)).toBe(true);
    await expect(page.locator('.attract-band')).toHaveClass(/is-locked/);
  });

  // 47.17 THE SECOND PIECE (ruling R6; 0.60.0). `?piece=kaiserwalzer` boots the
  // Kaiserwalzer payload (tools/prep_exhibit_data.py --piece kaiserwalzer — a
  // GENERATED, gitignored file like fledermaus.json and concerts.json, so a
  // tree that runs this spec needs it built or copied): ten recordings, no
  // annotations, and the band names the piece WITH its opus for the first
  // time. With `attractPieces` the reload in the silence moves to the next piece.
  // 47.18 THE ROOM MACHINE, increment 1 (plan §4.4, planned 2026-09-11): under
  // ?room=shared the mirror is UNIVERSAL. A LIVE table — no loop configured, no
  // band anywhere — follows the audible screen muted and in step; a take there
  // fades it in; and the screen that loses the speakers mutes and FOLLOWS
  // instead of pausing. A live table's audience is its own: the sync never
  // touches it. The room's silence is everyone's: the audible table pausing
  // pauses the mirror within a second.
  test('47.18 ?room=shared: a live table mirrors the audible screen muted and in step; a take there fades it in and the loser mutes and follows instead of pausing', async ({
    context,
  }) => {
    const pageA = await context.newPage();
    const pageB = await context.newPage();
    const { order } = await boot(pageA, 'debug=1&room=shared&screen=0');
    await boot(pageB, 'debug=1&room=shared&screen=1');
    await armQuietTransport(pageA);
    await armQuietTransport(pageB);
    const room = (p: Page) => p.evaluate(() => (window as any)._exhibitTest.room.state());
    const fileOf = (p: Page) => p.evaluate(() => (window as any)._exhibitTest.transport.activeFile as string);
    const timeOf = (p: Page) => p.evaluate(() => (window as any)._exhibitTest.transport.time as number);
    const mutedOf = (p: Page) => p.evaluate(() => (window as any)._exhibitTest.transport.muted as boolean);
    const holding = (p: Page) => p.evaluate(() => (window as any)._exhibitTest.arbiter.holding as boolean);
    const audienceOf = (p: Page) => p.evaluate(() => (window as any)._exhibitTest.audience.get(0) as string);
    const pauses = (p: Page) => p.evaluate(() => (window as any)._paused as number);
    for (const p of [pageA, pageB]) {
      expect((await room(p)).universal).toBe(true);
      expect(await p.locator('.attract-band').count(), 'no loop, no band: the mirror is the room\'s').toBe(0);
      await p.evaluate(() => {
        const T = (window as any)._exhibitTest;
        (window as any)._paused = 0;
        const orig = T.transport.pause.bind(T.transport);
        T.transport.pause = () => { (window as any)._paused += 1; return orig(); };
      });
    }
    expect((await room(pageA)).screen).toBe(0);
    expect((await room(pageB)).screen).toBe(1);
    expect(await pageB.evaluate(() => (window as any)._exhibitTest.viewports.map((v: any) => v.roomId))).toEqual([2, 3]);

    // A visitor at A chooses a recording and it "plays" from 40 s (the flag, then a
    // seek so the transport emits). B, a live table reading another audience,
    // follows muted — the file and the moment, never the audience.
    await pageB.evaluate(() => (window as any)._exhibitTest.audience.set(0, 'kids'));
    await pageA.evaluate(() => (window as any)._exhibitTest.audience.set(0, 'expert'));
    await pageA.evaluate((f) => (window as any)._exhibitTest.turns.request(0, f), order[1]);
    await pageA.evaluate(() => ((window as any)._playing = true));
    await pageA.evaluate(() => (window as any)._exhibitTest.transport.seek(40));
    await expect.poll(() => holding(pageA)).toBe(true);
    await expect.poll(async () => (await room(pageB)).mirroring, { timeout: 5_000 }).toBe(true);
    expect(await mutedOf(pageB)).toBe(true);
    await expect.poll(() => fileOf(pageB), { timeout: 10_000 }).toBe(order[1]);
    await expect.poll(() => timeOf(pageB), { timeout: 5_000 }).toBeGreaterThan(39);
    expect(await timeOf(pageB)).toBeLessThan(45);
    expect(await holding(pageB), 'a muted mirror claims nothing').toBe(false);
    expect(await audienceOf(pageB), "a live table's audience is its own").toBe('kids');

    // The take at B: the touch is the hand-off (this copy fades in and claims the
    // speakers); a tap then switches recordings. A loses the speakers and — the
    // universal mirror — mutes and FOLLOWS: nothing pauses, nothing goes silent.
    await pageB.evaluate(() => ((window as any)._playing = true));
    await pageB.evaluate(() => (window as any)._exhibitTest.room.touch());
    await expect.poll(() => holding(pageB)).toBe(true);
    expect(await mutedOf(pageB)).toBe(false);
    expect((await room(pageB)).mirroring).toBe(false);
    await expect.poll(() => mutedOf(pageA), { timeout: 5_000 }).toBe(true);
    expect(await pauses(pageA), 'the loser mutes, never pauses').toBe(0);
    expect((await room(pageA)).mirroring).toBe(true);
    expect(await holding(pageA)).toBe(false);
    // B's near reader is ROOM viewport 2: the machine is the room's (spec 36c).
    await pageB.evaluate((f) => (window as any)._exhibitTest.turns.request(2, f), order[2]);
    await expect.poll(() => fileOf(pageB)).toBe(order[2]);
    await expect.poll(() => fileOf(pageA), { timeout: 10_000 }).toBe(order[2]);
    expect(await audienceOf(pageA), "nor is the loser's").toBe('expert');

    // The audible table stops (the flag, then a seek so the transport emits its
    // falling edge): the sync says so at once, and the mirror pauses with it.
    await pageB.evaluate(() => ((window as any)._playing = false));
    await pageB.evaluate(() => (window as any)._exhibitTest.transport.seek(41));
    await expect.poll(async () => (await room(pageA)).mirroring, { timeout: 5_000 }).toBe(false);
    expect(await pauses(pageA)).toBe(1);

    await pageA.close();
    await pageB.close();
  });

  // 47.20 The sweep clears the marker in BOTH senses: the glass back on its
  // hook (marker.js reset) AND the anchored moment main.js keeps — a v1 gap,
  // where a bare switch after the sweep still snapped to the invisible marker.
  test('47.20 the sweep clears the anchored marker, so a bare switch afterwards carries the moment instead of snapping', async ({
    page,
  }) => {
    const { order, ref } = await boot(page, `${IDLE}&marker=glass`);
    await armQuietTransport(page);
    await page.evaluate((ref) => (window as any)._exhibitTest.placeMarker(0, ref, 120), ref);
    expect(await page.evaluate(() => (window as any)._exhibitTest.viewports[0].markerIx)).not.toBeNull();
    await page.evaluate(() => (window as any)._exhibitTest.attract.force());
    await expect.poll(async () => (await attract(page))?.phase).toBe('attract');
    expect(await page.evaluate(() => (window as any)._exhibitTest.marker(0).ix)).toBeNull();
    expect(await page.evaluate(() => (window as any)._exhibitTest.viewports[0].markerIx)).toBeNull();
    expect(await page.evaluate(() => (window as any)._exhibitTest.marker(1).ghosts)).toEqual([]);
    // A bare switch now carries the moment (no time), rather than snapping.
    const before = (await taps(page)).length;
    const other = order.find((f) => f !== ref)!;
    await page.evaluate((f) => (window as any)._exhibitTest.turns.request(0, f), other);
    const last = (await taps(page)).at(-1)!;
    expect((await taps(page)).length).toBe(before + 1);
    expect(last.file).toBe(other);
    expect(last.time).toBeUndefined();
  });

  // 47.21 THE ROOM MACHINE, increment 4 (minimal, agreed 2026-09-11): with the
  // worker the LEADER is the lowest screen (deterministic: screen 0, whatever
  // the tabs' ids), and the two windows' reloads in the silence are STAGGERED
  // — the leader at the midpoint, the follower at three quarters — so the
  // worker, which dies with its last window, always keeps one.
  test('47.21 ?room=shared: screen 0 leads, and the follower reloads later in the silence than the leader', async ({
    context,
  }) => {
    const pageA = await context.newPage();
    const pageB = await context.newPage();
    const GAP = 20_000;
    const { order, durations } = await boot(pageB, `${IDLE}&room=shared&screen=1&attractGapMs=${GAP}&attractReload=1`);
    await boot(pageA, `${IDLE}&room=shared&screen=0&attractGapMs=${GAP}&attractReload=1`);
    await armQuietTransport(pageA);
    await armQuietTransport(pageB);
    await expect.poll(async () => (await attract(pageA))?.peers).toBe(1);
    await expect.poll(async () => (await attract(pageB))?.peers).toBe(1);
    await expect.poll(async () => (await attract(pageA))?.phase, { timeout: 8_000 }).toBe('attract');
    await expect.poll(async () => (await attract(pageB))?.phase, { timeout: 8_000 }).toBe('attract');
    // Screen 0 leads although screen 1 was there first.
    await expect.poll(async () => (await attract(pageA)).started, { timeout: 15_000 }).toBe(true);
    expect((await attract(pageA)).leader).toBe(true);
    expect((await attract(pageB)).leader).toBe(false);
    expect((await attract(pageB)).started).toBe(false);
    // The pass ends: both enter the room's gap and schedule their reloads.
    await pageA.evaluate((t) => (window as any)._exhibitTest.transport.seek(t), durations[order[0]] - 0.1);
    await expect.poll(async () => (await attract(pageA))?.phase).toBe('gap');
    await expect.poll(async () => (await attract(pageB))?.phase, { timeout: 5_000 }).toBe('gap');
    const a = await attract(pageA);
    const b = await attract(pageB);
    expect(a.reloadAt).not.toBeNull();
    expect(b.reloadAt).not.toBeNull();
    // A quarter of the gap apart (5 s here), give or take the message round trips.
    const apart = b.reloadAt - a.reloadAt;
    expect(apart).toBeGreaterThan(GAP * 0.25 - 1500);
    expect(apart).toBeLessThan(GAP * 0.25 + 1500);
    await pageA.close();
    await pageB.close();
  });

  // 47.22 PRESENCE IN THE WORKER (0.64.0, increment 1): a window that crashes
  // without saying bye — no heartbeat, no sync, no bye — is expired by the
  // room's worker within 15 s: it leaves the registry, its claim on the
  // speakers dies with it (the 0.62.0 hole: a stale visitor claim outranked the
  // loop's for ever), and the leader is recomputed among the LIVE windows. The
  // survivor's loop then runs its pass. `room.detach()` is the crash.
  test('47.22 ?room=shared: a window that falls silent is expired by the worker — its speakers claim dies, the survivor leads and plays', async ({
    context,
  }) => {
    test.setTimeout(60_000);
    const pageA = await context.newPage();
    const pageB = await context.newPage();
    await boot(pageA, `${IDLE}&room=shared&screen=0`);
    await boot(pageB, `${IDLE}&room=shared&screen=1`);
    await armQuietTransport(pageA);
    await armQuietTransport(pageB);
    const room = (p: Page) => p.evaluate(() => (window as any)._exhibitTest.room.state());
    const idA = await pageA.evaluate(() => (window as any)._exhibitTest.room.id as string);
    const idB = await pageB.evaluate(() => (window as any)._exhibitTest.room.id as string);
    await expect.poll(async () => (await room(pageA)).snapshot?.windows?.length, { timeout: 5_000 }).toBe(2);
    expect((await room(pageA)).snapshot.leader, 'screen 0 leads').toBe(idA);

    // A visitor at B: the touch (the hand-off), the flag, a seek — B claims the speakers.
    await pageB.evaluate(() => (window as any)._exhibitTest.room.touch());
    await pageB.evaluate(() => ((window as any)._playing = true));
    await pageB.evaluate(() => (window as any)._exhibitTest.transport.seek(10));
    await expect.poll(async () => (await room(pageA)).snapshot?.audible?.id, { timeout: 5_000 }).toBe(idB);
    expect((await room(pageA)).snapshot.audible.kind).toBe('visitor');
    await expect.poll(async () => (await attract(pageA))?.phase).toBe('idle-wait');

    // B crashes: silent on every channel, no bye at pagehide.
    await pageB.evaluate(() => (window as any)._exhibitTest.room.detach());
    expect((await room(pageB)).detached).toBe(true);
    await pageB.close();
    // Within the TTL and a sweep: one window, nobody audible, A the leader.
    await expect.poll(async () => (await room(pageA)).snapshot?.windows?.length, { timeout: 25_000 }).toBe(1);
    const s = (await room(pageA)).snapshot;
    expect(s.windows[0].id).toBe(idA);
    expect(s.audible, 'the stale claim died with the window').toBeNull();
    expect(s.leader).toBe(idA);
    // The room is A's alone and long idle: its loop runs the pass.
    await expect.poll(async () => (await attract(pageA))?.phase, { timeout: 10_000 }).toBe('attract');
    await expect.poll(async () => (await attract(pageA))?.started, { timeout: 15_000 }).toBe(true);
    expect((await attract(pageA)).leader).toBe(true);
    await pageA.close();
  });

  // 47.23 THE GAP IN THE WORKER (0.64.0, increment 4): the silence between
  // passes is ROOM state. The leader's pass ends, both windows enter the gap,
  // and the leader REALLY reloads at its midpoint: back, its welcome snapshot
  // carries the gap, so it resumes IN the silence with the room's end time and
  // pass count (`resumedFrom: "room"`, the storage record unused), and plays
  // again when the gap ends while the follower — reloaded later, resumed the
  // same way — waits. The room's touch clock survives the reloads: no window's
  // return counts as a visitor.
  test("47.23 ?room=shared: the leader reloads in the silence and resumes the room's gap from the worker, then plays again", async ({
    context,
  }) => {
    test.setTimeout(90_000);
    const pageA = await context.newPage();
    const pageB = await context.newPage();
    const GAP = 20_000;
    const qs = `${IDLE}&room=shared&attractGapMs=${GAP}&attractReload=1`;
    const { order, durations } = await boot(pageA, `${qs}&screen=0`);
    await boot(pageB, `${qs}&screen=1`);
    await armQuietTransport(pageA);
    await armQuietTransport(pageB);
    const room = (p: Page) => p.evaluate(() => (window as any)._exhibitTest.room.state());
    await expect.poll(async () => (await attract(pageA))?.peers).toBe(1);
    await expect.poll(async () => (await attract(pageA))?.phase, { timeout: 8_000 }).toBe('attract');
    await expect.poll(async () => (await attract(pageB))?.phase, { timeout: 8_000 }).toBe('attract');
    await expect.poll(async () => (await attract(pageA)).started, { timeout: 15_000 }).toBe(true);
    expect((await attract(pageA)).leader).toBe(true);

    // The pass ends on A: the room's gap, reported to the worker.
    const reloadedA = pageA.waitForEvent('load');
    await pageA.evaluate((t) => (window as any)._exhibitTest.transport.seek(t), durations[order[0]] - 0.1);
    await expect.poll(async () => (await attract(pageA))?.phase).toBe('gap');
    await expect.poll(async () => (await attract(pageB))?.phase, { timeout: 5_000 }).toBe('gap');
    const before = await attract(pageA);
    expect(before.passCount).toBe(1);
    const roomGap = (await room(pageB)).snapshot.loop;
    expect(roomGap.passCount).toBe(1);
    expect(Math.abs(roomGap.gap.endsAt - before.gapEndsAt)).toBeLessThan(300);
    expect(before.reloadAt).toBeLessThan((await attract(pageB)).reloadAt);

    // A reloads at the midpoint and comes back IN the gap, from the room.
    await reloadedA;
    expect(await pageA.evaluate(() => (window as any)._exhibitTest.ready)).toBe(true);
    await armQuietTransport(pageA);
    await expect.poll(async () => (await attract(pageA))?.resumed, { timeout: 5_000 }).toBe(true);
    const after = await attract(pageA);
    expect(after.resumedFrom).toBe('room');
    expect(after.phase).toBe('gap');
    expect(after.bandUp).toBe(true);
    expect(after.passCount).toBe(1);
    expect(Math.abs(after.gapEndsAt - before.gapEndsAt)).toBeLessThan(300);
    expect(after.presence).toBe('worker');
    // Its return is not a touch: the room stays idle for the loop (its welcome
    // snapshot says so already; a tick may separate the two windows' views).
    await expect.poll(async () => (await room(pageA)).snapshot?.loop?.idle, { timeout: 3_000 }).toBe(true);
    expect((await room(pageB)).snapshot.loop.idle).toBe(true);

    // B reloads later (0.75 of the gap) and resumes the same way.
    await pageB.waitForEvent('load');
    expect(await pageB.evaluate(() => (window as any)._exhibitTest.ready)).toBe(true);
    await armQuietTransport(pageB);
    await expect.poll(async () => (await attract(pageB))?.resumed, { timeout: 5_000 }).toBe(true);
    expect((await attract(pageB)).resumedFrom).toBe('room');
    expect((await attract(pageB)).phase).toBe('gap');

    // After the gap the leader plays from the top; the follower waits.
    await expect.poll(async () => (await attract(pageA))?.phase, { timeout: 15_000 }).toBe('attract');
    await expect.poll(async () => (await attract(pageA))?.started, { timeout: 15_000 }).toBe(true);
    const t = await taps(pageA);
    expect(t[t.length - 1]).toEqual({ file: order[0], time: 0 });
    await expect.poll(async () => (await attract(pageB))?.phase, { timeout: 5_000 }).toBe('attract');
    expect((await attract(pageB)).started).toBe(false);
    expect((await attract(pageB)).leader).toBe(false);
    await pageA.close();
    await pageB.close();
  });

  // 47.24 THE LOOP AS THE MACHINE'S IDLE CASE (0.64.0, increment 3): 47.8's
  // twin under ?room=shared. The idle verdict is the worker's — one fact both
  // windows read from the same snapshot — the leader is screen 0, and a touch
  // on either screen makes that screen live and leaves the other RESTING.
  test('47.24 ?room=shared: the room idles by the worker, screen 0 plays, and a touch on either screen leaves the other resting', async ({
    context,
  }) => {
    const pageA = await context.newPage();
    const pageB = await context.newPage();
    await boot(pageA, `${IDLE}&room=shared&screen=0`);
    await boot(pageB, `${IDLE}&room=shared&screen=1`);
    await armQuietTransport(pageA);
    await armQuietTransport(pageB);
    const room = (p: Page) => p.evaluate(() => (window as any)._exhibitTest.room.state());
    await expect.poll(async () => (await attract(pageA))?.peers).toBe(1);
    await expect.poll(async () => (await attract(pageB))?.peers).toBe(1);
    expect((await attract(pageA)).presence).toBe('worker');
    expect((await attract(pageB)).presence).toBe('worker');
    await expect.poll(async () => (await attract(pageA))?.phase, { timeout: 8_000 }).toBe('attract');
    await expect.poll(async () => (await attract(pageB))?.phase, { timeout: 8_000 }).toBe('attract');
    // The verdict is the room's: both snapshots say idle.
    expect((await room(pageA)).snapshot.loop.idle).toBe(true);
    expect((await room(pageB)).snapshot.loop.idle).toBe(true);
    expect((await attract(pageA)).roomIdle).toBe(true);
    await expect.poll(async () => (await attract(pageA)).started, { timeout: 15_000 }).toBe(true);
    expect((await attract(pageA)).leader, 'screen 0 leads').toBe(true);
    expect((await attract(pageB)).leader).toBe(false);
    expect((await attract(pageB)).started).toBe(false);
    expect(await bandUp(pageA)).toBe(true);
    expect(await bandUp(pageB)).toBe(true);

    // A visitor at B: the wake reaches A at once — B live, A RESTING with its band up.
    await pageB.mouse.click(512, 683);
    await expect.poll(async () => (await attract(pageB))?.phase).toBe('idle-wait');
    await expect.poll(async () => (await attract(pageA))?.phase).toBe('rest');
    await expect.poll(() => bandUp(pageB)).toBe(false);
    expect(await bandUp(pageA)).toBe(true);
    expect((await room(pageA)).snapshot.loop.idle).toBe(false);
    // …and at A: A live too, B (untouched since) still live — nobody rests over an empty room.
    await pageA.mouse.click(512, 683);
    await expect.poll(async () => (await attract(pageA))?.phase).toBe('idle-wait');
    await expect.poll(() => bandUp(pageA)).toBe(false);
    // B untouched for its window while A is in use: B's band rises and B rests;
    // a touch on A keeps A live under it.
    for (let i = 0; i < 12 && (await attract(pageB)).phase !== 'rest'; i++) {
      await pageA.mouse.click(512, 683);
      await pageA.waitForTimeout(400);
    }
    expect((await attract(pageB)).phase).toBe('rest');
    expect(await bandUp(pageB)).toBe(true);
    await pageA.mouse.click(512, 683);
    expect((await attract(pageA)).phase).toBe('idle-wait');
    expect(await bandUp(pageA)).toBe(false);
    await pageA.close();
    await pageB.close();
  });

  // 47.25 THE BAND PER SCREEN (0.64.0): B, untouched for T while A's visitor is
  // active, raises ITS band and sweeps ITS table — mirroring A muted, taking A's
  // audience along (an idle screen does) — while A's band stays down and A's
  // holder, choice, and glass SURVIVE B's sweep (the scoped `reset {viewports}`;
  // a room-wide reset would have wiped them). When A's visitor pauses and is
  // gone T, the room is idle and silent: the leader's pass from the top.
  test("47.25 ?room=shared: an untouched screen's band rises and its sweep spares the other table; the leader plays once that table is quiet too", async ({
    context,
  }) => {
    const pageA = await context.newPage();
    const pageB = await context.newPage();
    const { order } = await boot(pageA, `${IDLE}&room=shared&screen=0&marker=glass&turnPolicy=request`);
    await boot(pageB, `${IDLE}&room=shared&screen=1&marker=glass&turnPolicy=request`);
    await armQuietTransport(pageA);
    await armQuietTransport(pageB);
    await expect.poll(async () => (await attract(pageA))?.peers).toBe(1);
    await expect.poll(async () => (await attract(pageB))?.peers).toBe(1);
    const turnsOf = (p: Page) => p.evaluate(() => (window as any)._exhibitTest.turns.state());
    const audienceOf = (p: Page) => p.evaluate(() => (window as any)._exhibitTest.audience.get(0) as string);
    // A visitor at A: touch, a take (room 0 holds and chose), a glass at 120 s, "expert", playing.
    await pageB.evaluate(() => (window as any)._exhibitTest.audience.set(0, 'kids'));
    await pageA.evaluate(() => (window as any)._exhibitTest.audience.set(0, 'expert'));
    await pageA.evaluate(() => (window as any)._exhibitTest.room.touch());
    await pageA.evaluate((f) => (window as any)._exhibitTest.turns.request(0, f), order[1]);
    // The glass on the recording A is playing (placing one selects that file and moment).
    await pageA.evaluate((f) => (window as any)._exhibitTest.placeMarker(0, f, 120), order[1]);
    await pageA.evaluate(() => ((window as any)._playing = true));
    await pageA.evaluate(() => (window as any)._exhibitTest.transport.seek(10));
    await expect.poll(async () => (await turnsOf(pageB)).holder).toBe(0);
    expect(await pageA.evaluate(() => (window as any)._exhibitTest.viewports[0].markerIx)).not.toBeNull();
    const tapsA = (await taps(pageA)).length;
    // B goes untouched past T while the visitor keeps touching A: B's band rises, B rests.
    for (let i = 0; i < 12 && (await attract(pageB)).phase !== 'rest'; i++) {
      await pageA.evaluate(() => (window as any)._exhibitTest.room.touch());
      await pageA.waitForTimeout(400);
    }
    expect((await attract(pageB)).phase).toBe('rest');
    expect(await bandUp(pageB)).toBe(true);
    expect((await attract(pageA)).phase, 'A is live').toBe('idle-wait');
    expect(await bandUp(pageA)).toBe(false);
    // B mirrors A with A's audience; A's table is untouched by B's sweep.
    await expect.poll(() => pageB.evaluate(() => (window as any)._exhibitTest.transport.activeFile), { timeout: 10_000 }).toBe(order[1]);
    await expect.poll(() => audienceOf(pageB), { timeout: 5_000 }).toBe('expert');
    const s = await turnsOf(pageA);
    expect(s.holder, "A's holder survives B's sweep").toBe(0);
    expect(s.selected[0], "A's choice survives").toBe(order[1]);
    expect(await pageA.evaluate(() => (window as any)._exhibitTest.viewports[0].markerIx), "A's glass survives").not.toBeNull();
    expect(await pageA.evaluate(() => (window as any)._exhibitTest.marker(0).ix)).not.toBeNull();
    expect((await taps(pageA)).length, 'nothing executed on A').toBe(tapsA);
    // A's visitor pauses and leaves: T later A's band rises, the room is idle
    // and silent, and the leader (screen 0 = A) plays from the top.
    await pageA.evaluate(() => ((window as any)._playing = false));
    await pageA.evaluate(() => (window as any)._exhibitTest.transport.seek(11));
    await expect.poll(async () => (await attract(pageA))?.phase, { timeout: 8_000 }).toBe('attract');
    expect((await attract(pageA)).takenOver).toBe(false);
    await expect.poll(async () => (await attract(pageA))?.started, { timeout: 15_000 }).toBe(true);
    const t = await taps(pageA);
    expect(t[t.length - 1]).toEqual({ file: order[0], time: 0 });
    expect((await turnsOf(pageA)).holder, "A's own sweep").toBeNull();
    await expect.poll(async () => (await attract(pageB))?.phase, { timeout: 5_000 }).toBe('attract');
    expect((await attract(pageB)).started).toBe(false);
    await pageA.close();
    await pageB.close();
  });

  // 47.19 …and on an IDLE screen (band up) the sync carries the AUDIENCE too —
  // the loop's pass sets it on both screens, the one case the room may.
  test("47.19 ?room=shared: an idle screen takes the audible pass's audience along with the mirror", async ({ context }) => {
    const pageA = await context.newPage();
    const pageB = await context.newPage();
    await boot(pageA, `${IDLE}&room=shared&screen=0`);
    await boot(pageB, `${IDLE}&room=shared&screen=1`);
    await armQuietTransport(pageA);
    await armQuietTransport(pageB);
    await expect.poll(async () => (await attract(pageA))?.peers).toBe(1);
    await expect.poll(async () => (await attract(pageB))?.peers).toBe(1);
    await expect.poll(async () => (await attract(pageA))?.phase, { timeout: 8_000 }).toBe('attract');
    await expect.poll(async () => (await attract(pageB))?.phase, { timeout: 8_000 }).toBe('attract');
    await expect
      .poll(async () => (await attract(pageA)).started || (await attract(pageB)).started, { timeout: 15_000 })
      .toBe(true);
    const [leader, follower] = (await attract(pageA)).leader ? [pageA, pageB] : [pageB, pageA];
    const audience = (await attract(leader)).audience as string;
    expect(audience).not.toBeNull();
    // The follower reads something else until the sync arrives.
    const other = audience === 'kids' ? 'adults' : 'kids';
    await follower.evaluate((a) => (window as any)._exhibitTest.audience.set(0, a), other);
    expect(await follower.evaluate(() => (window as any)._exhibitTest.audience.get(0))).toBe(other);
    await leader.evaluate(() => ((window as any)._playing = true));
    await leader.evaluate(() => (window as any)._exhibitTest.transport.seek(40));
    await expect.poll(async () => (await attract(follower)).mirroring, { timeout: 5_000 }).toBe(true);
    await expect
      .poll(() => follower.evaluate(() => (window as any)._exhibitTest.audience.get(0)), { timeout: 5_000 })
      .toBe(audience);
    expect(await follower.evaluate(() => (window as any)._exhibitTest.audience.get(1))).toBe(audience);
    expect(await follower.evaluate(() => (window as any)._exhibitTest.transport.muted)).toBe(true);
    await pageA.close();
    await pageB.close();
  });

  test('47.17 ?piece=kaiserwalzer boots the second piece with its opus, and attractPieces cycles to it in the silence', async ({
    page,
  }) => {
    const kw = await boot(page, 'debug=1&piece=kaiserwalzer');
    expect(kw.order).toHaveLength(10);
    expect(kw.ref).toBe('VPO-2021.wav');
    const piece = await page.evaluate(() => (window as any)._exhibitTest.exhibit.piece);
    expect(piece.id).toBe('kaiserwalzer');
    expect(piece.opus).toBe('op. 437');
    expect(await page.evaluate(() => (window as any)._exhibitTest.exhibit.annotations.length)).toBe(0);
    await expect(page.locator('.mb-piece-title').first()).toHaveText('Kaiser-Walzer, op. 437');
    // A recording the metadata sidecar has never met still gets a strip and a strap button.
    await expect(page.locator('.vp').first().locator('.strip')).toHaveCount(10);

    // The cycle: Die Fledermaus first, the reload in the silence lands on Kaiserwalzer.
    const { order, durations } = await boot(
      page,
      `${IDLE}&attractGapMs=1600&attractReload=1&attractPieces=fledermaus,kaiserwalzer`,
    );
    expect(await page.evaluate(() => (window as any)._exhibitTest.config.piece)).toBe('fledermaus');
    await armQuietTransport(page);
    await page.evaluate(() => (window as any)._exhibitTest.attract.force());
    await expect.poll(async () => (await attract(page))?.started).toBe(true);
    const reloaded = page.waitForEvent('load');
    await page.evaluate((t) => (window as any)._exhibitTest.transport.seek(t), durations[order[0]] - 0.1);
    await expect.poll(async () => (await attract(page))?.phase).toBe('gap');
    await reloaded;
    expect(await page.evaluate(() => (window as any)._exhibitTest.ready)).toBe(true);
    expect(await page.evaluate(() => (window as any)._exhibitTest.config.piece)).toBe('kaiserwalzer');
    expect(await page.evaluate(() => (window as any)._exhibitTest.exhibit.piece.opus)).toBe('op. 437');
    const s = await attract(page);
    expect(s.resumed).toBe(true);
    expect(s.bandUp).toBe(true);
  });
});
