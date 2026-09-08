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
  });

  // 47.2 Idle → sweep → band → the first recording from the top; then the
  // first annotation's moment switches to the recording it targets.
  test('47.2 after the idle window the table sweeps itself, raises the band, plays from the top, and switches at the first annotation', async ({
    page,
  }) => {
    const { order } = await boot(page, `${IDLE}&turnPolicy=request&viewSwitch=1`);
    await armQuietTransport(page);
    // Something to sweep: one half in an explorer, a holder on the clock.
    await page.evaluate(() => (window as any)._exhibitTest.setView(0, 'years'));
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

  // 47.8 The room: two screens agree on idleness, one leader plays, both
  // raise their band; a touch on the OTHER screen ends the loop for both.
  test('47.8 two screens: one leader plays, both raise the band, and a touch on either ends the loop for both', async ({
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

    // A visitor at B: B's band goes, A's loop stops scheduling, A's band stays.
    await pageB.mouse.click(512, 683);
    await expect.poll(async () => (await attract(pageB))?.phase).toBe('idle-wait');
    await expect.poll(async () => (await attract(pageA))?.phase).toBe('idle-wait');
    await expect.poll(() => bandUp(pageB)).toBe(false);
    expect(await bandUp(pageA)).toBe(true);

    await pageA.close();
    await pageB.close();
  });

  // 47.9 The study panel offers the loop on its own tab, and the staff preset
  // carries the 90 s (35.25 pins the pair too).
  test('47.9 the study panel has an Attract tab with the six parameters', async ({ page }) => {
    await boot(page, 'debug=1&studyPanel=true');
    await page.click('.study-cog');
    await page.click('.study-tab[data-tab="attract"]');
    const labels = await page.locator('.study-row .study-label').allTextContents();
    expect(labels).toEqual([
      'Start after idle (ms; 0 = off)',
      'Take over during playback after (ms; 0 = off)',
      'Silence between passes (ms)',
      'Reload in the silence',
      'Annotations shown',
      'Logo language',
    ]);
    await expect(page.locator('.study-row').first().locator('.study-option.is-on')).toHaveText(/^0 •$/);
  });

  // 47.10 The second timer (user, 2026-09-07): music playing and the room
  // untouched for Y — the loop TAKES OVER from the playhead: band up, table
  // tidied, no restart from the top, the audience as it was, and only the
  // annotations still ahead are switch points.
  test('47.10 during playback the loop takes over from the current playhead instead of restarting', async ({ page }) => {
    const { order } = await boot(page, `${IDLE}&attractDuringPlaybackMs=1200&viewSwitch=1`);
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

  // 47.11 The primary timer waits while music plays: a listener who touches
  // nothing for eight minutes is not idle.
  test('47.11 the idle timer does not fire while music is playing', async ({ page }) => {
    const { order } = await boot(page, IDLE);
    await armQuietTransport(page);
    await page.evaluate((f) => (window as any)._exhibitTest.turns.request(0, f), order[1]);
    await page.evaluate(() => ((window as any)._playing = true));
    await page.waitForTimeout(2600);
    expect((await attract(page)).phase).toBe('idle-wait');
    expect(await bandUp(page)).toBe(false);
  });
});
