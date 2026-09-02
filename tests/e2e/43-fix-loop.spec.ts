// 43. Alignment-correction increment 3 (plan §14 D2) — the interaction loop
// on the fix-mode screen: the L/R audition (left ear = the reference
// recording, right ear = the score synth rendered through the live corrected
// map, one sample-locked stereo buffer), playback-following sounding-onset
// selection with page turns, seek-to-selected-note, tick DRAGS that lay hard
// anchors (auto-realign of the flanking segments on release + auto-replay
// from just before the previous anchor), the Enter APPROVE (zero-drag
// anchor), session MARKS (M / N), fix-anchor entries on listen.js's unified
// undo stack (snapshot semantics, off-screen hops announce themselves), the
// header.corrections durable record, and Revert-all integration.
//
// The worker is STUBBED via _listenTest.fixWorkerFactory (the spec-42 seam):
// fix_ready echoes the app's own event count and fix_realign refills the
// interior LINEARLY between the posted anchor times — deterministic values
// the assertions can predict. The real realign path is spec 41's Python
// ground truth; here the contract under test is the JS loop around it.
import { test, expect } from '../support/fixtures';
import { stubExternalMei } from '../support/helpers';
import { env } from '../support/env';
import type { Page } from '@playwright/test';

const REF_ROW = 'audio-b.mp3';

/** Navigate with ?fixMode (the spec-42 helper, plus its alignment patch). */
async function gotoFixMode(page: Page, patch?: (json: any) => void) {
  await stubExternalMei(page);
  if (patch) {
    // Predicate matcher, deliberately not a glob: the navigation URL carries
    // /static/test/ inside its ?align= query and a glob would intercept the
    // navigation itself (the spec-39 trap).
    await page.route(
      (url) => url.pathname === '/static/test/alignment.json',
      async (route) => {
        const resp = await route.fetch();
        const json = await resp.json();
        patch(json);
        await route.fulfill({ response: resp, json });
      },
    );
  }
  const params =
    `?align=${env.baseUrl}/static/test/alignment.json` +
    `&useLocal=${env.baseUrl}/static/test&fixMode`;
  await page.goto(`/${params}`);
  await page.waitForFunction(
    () => ((window as any)._listenTest?.loadGeneration ?? 0) > 0,
  );
}

/**
 * Worker stub: fix_ready echoes the live event count; fix_realign refills the
 * segment interior linearly between (tA, tB) with offsets +0.05 and remaps
 * the left anchor's own offset to tA + 0.02 — all recorded on __fixStub.
 */
async function installWorkerStub(
  page: Page,
  opts: {
    realignError?: string;
    realignShort?: boolean;
    /** Hold fix_ready back until __fixStub.releaseReady() — the arming state
     *  is otherwise 5 ms wide and cannot be asserted. */
    deferReady?: boolean;
    /** Answer fix_lanes at once with synthetic lanes carrying these onset
     *  peaks (perceived attacks = peaks + patShift); without it the test
     *  calls __fixStub.sendLanes(peaks, opts) itself. */
    lanes?: { peaks: number[]; patShift?: number };
  } = {},
) {
  await page.evaluate((o) => {
    const lt = (window as any)._listenTest;
    lt.fixWorkerFactory = (url: string) => {
      const w: any = {
        url,
        onmessage: null,
        onerror: null,
        posted: [] as any[],
        terminated: false,
      };
      // Synthetic v2 lanes (the real worker's fix_lanes reply shape): a mel
      // gradient at the requested resolution, a near-silent onset curve with
      // a spike per given peak, and a perceived-attack time per peak.
      w.sendLanes = (peaks: number[], opts: any = {}) => {
        const sr = 22050;
        const onsetHop = 512;
        const melHop = opts.melHop ?? 512;
        const nMels = opts.nMels ?? 64;
        const nFft = opts.nFft ?? 2048;
        const what = opts.what ?? 'all';
        const dur = 200;
        const melFrames = Math.floor((dur * sr) / melHop);
        const onsetFrames = Math.floor((dur * sr) / onsetHop);
        const mel = new Uint8Array(nMels * melFrames);
        for (let m = 0; m < nMels; m++) {
          for (let i = 0; i < melFrames; i++) mel[m * melFrames + i] = (i * 3 + m * 4) & 255;
        }
        const onsetT0 = 1024 / 2 / sr;
        let onset: Float32Array | null = null;
        if (what !== 'mel') {
          onset = new Float32Array(onsetFrames).fill(0.01);
          for (const t of peaks) {
            const i = Math.round(((t - onsetT0) * sr) / onsetHop);
            if (i >= 0 && i < onsetFrames) onset[i] = 1;
          }
        }
        const sorted = peaks.slice().sort((a, b) => a - b);
        const bandHz = Array.from({ length: nMels }, (_, m) => 30 * Math.pow(11025 / 30, (m + 0.5) / nMels));
        w.onmessage?.({
          data: {
            type: 'fix_lanes',
            what,
            sr,
            n_mels: nMels,
            n_fft: nFft,
            window: opts.window ?? 'hann',
            scale: opts.scale ?? 'mel',
            band_hz: bandHz,
            mel_hop: melHop,
            mel_frames: melFrames,
            mel_t0: nFft / 2 / sr,
            mel,
            onset_hop: onsetHop,
            onset_frames: onsetFrames,
            onset_t0: onsetT0,
            onset,
            peaks: what === 'mel' ? null : sorted,
            pat: what === 'mel' ? null : sorted.map((t) => t + (opts.patShift ?? 0)),
          },
        });
      };
      w.postMessage = (msg: any) => {
        const rec: any = { type: msg.type };
        if (msg.type === 'fix_realign') {
          rec.iA = msg.iA;
          rec.tA = msg.tA;
          rec.iB = msg.iB;
          rec.tB = msg.tB;
          rec.priorLen = msg.priorRef?.length ?? null;
        }
        if (msg.type === 'fix_lanes') {
          rec.hop = msg.hop;
          rec.nMels = msg.nMels;
          rec.nFft = msg.nFft;
          rec.window = msg.window;
          rec.melHop = msg.melHop;
          rec.what = msg.what;
          if (o.lanes) {
            setTimeout(
              () =>
                w.sendLanes(o.lanes!.peaks ?? [], {
                  nFft: msg.nFft,
                  window: msg.window,
                  melHop: msg.melHop,
                  nMels: msg.nMels,
                  what: msg.what,
                  patShift: o.lanes!.patShift,
                }),
              5,
            );
          }
        }
        w.posted.push(rec);
        if (msg.type === 'fix_begin') {
          const sendReady = () =>
            w.onmessage?.({
              data: {
                type: 'fix_ready',
                events: { n_events: lt.fix?.nEvents },
                timing: { bootMs: 0, beginMs: 1, boot: null },
              },
            });
          if (o.deferReady) w.releaseReady = sendReady;
          else setTimeout(sendReady, 5);
        } else if (msg.type === 'fix_realign') {
          setTimeout(() => {
            if (o.realignShort) {
              // The real worker's refusal for a span with < 2 analysis
              // frames (message shape as Pyodide surfaces it).
              w.onmessage?.({
                data: {
                  type: 'error',
                  message:
                    'PythonError: Traceback (most recent call last):\n' +
                    'ValueError: fix_realign_segment: segment too short to align',
                },
              });
              return;
            }
            if (o.realignError) {
              w.onmessage?.({
                data: { type: 'error', message: o.realignError },
              });
              return;
            }
            const n = msg.priorRef.length;
            const on: number[] = [];
            const off: number[] = [];
            for (let k = 0; k < n; k++) {
              const t = msg.tA + ((k + 1) * (msg.tB - msg.tA)) / (n + 1);
              on.push(t);
              off.push(t + 0.05);
            }
            w.onmessage?.({
              data: {
                type: 'fix_segment',
                iA: msg.iA,
                iB: msg.iB,
                result: {
                  ref_onset: on,
                  ref_offset: off,
                  anchor_a_offset: msg.iA >= 0 ? msg.tA + 0.02 : null,
                  hop: 512,
                },
              },
            });
          }, 5);
        }
      };
      w.terminate = () => {
        w.terminated = true;
      };
      (window as any).__fixStub = w;
      return w;
    };
  }, opts);
}

/** Enter fix mode on the reference row and wait for the drawn screen. */
async function enterFix(page: Page) {
  await page.click(`.waveform[data-ix="${REF_ROW}"] .wf-fix-btn`);
  await page.waitForFunction(() => (window as any)._listenTest.fix.active);
  await page.waitForFunction(
    () => (window as any)._listenTest.fix.ticksOnPage > 0,
  );
}

/** Wait for the correction engine (stubbed) AND the audition (real decode +
 *  synth render — allow real time). */
async function waitLoopReady(page: Page) {
  await page.waitForFunction(
    () => {
      const f = (window as any)._listenTest.fix;
      return f.chipState === 'ready' && f.aud?.ready;
    },
    undefined,
    { timeout: 45_000 },
  );
}

const fixState = (page: Page) =>
  page.evaluate(() => (window as any)._listenTest.fix);

/** Order-weighted checksum of the live ref tables (exact-restore witness). */
const refChecksum = (page: Page) =>
  page.evaluate(() => {
    const sc = (window as any)._listenTest.session.scoreAlignment;
    const sum = (a: number[]) => a.reduce((s, v, i) => s + v * (i + 1), 0);
    return { on: sum(sc.ref_onset), off: sum(sc.ref_offset) };
  });

/** Drag the SELECTED onset's tick by dxPx and wait for the commit to land. */
async function dragSelectedTick(page: Page, dxPx: number) {
  const st = await fixState(page);
  const box = (await page.locator('.fix-ticks').boundingBox())!;
  const x0 = box.x + st.selTickX;
  const y = box.y + box.height / 2;
  await page.mouse.move(x0, y);
  await page.mouse.down();
  await page.mouse.move(x0 + dxPx, y, { steps: 5 });
  await page.mouse.up();
  await page.waitForFunction(
    () => {
      const f = (window as any)._listenTest.fix;
      return !f.realignBusy && f.chipState !== 'realign';
    },
    undefined,
    { timeout: 20_000 },
  );
}

test.describe('43: alignment-correction fix mode (increment 3 — the loop)', () => {
  test('43.1 the audition arms: stereo buffer with the recording left and real synth right', async ({
    page,
  }) => {
    await gotoFixMode(page);
    await installWorkerStub(page);
    await enterFix(page);
    await waitLoopReady(page);
    const st = await fixState(page);
    expect(st.aud.duration).toBeGreaterThan(60);
    expect(st.aud.playing).toBe(false);
    await expect(page.locator('#playpause')).toBeEnabled();
    // Both ears hold real signal over the piece's opening (first onset ~3 s).
    const rms = await page.evaluate(() => {
      const ctl = (window as any)._listenTest.fixCtl;
      return { left: ctl.channelRms(0, 0, 12), right: ctl.channelRms(1, 0, 12) };
    });
    expect(rms.left).toBeGreaterThan(0.005);
    expect(rms.right).toBeGreaterThan(0.005);
    // The right ear is the SYNTH, not a copy of the recording.
    const same = await page.evaluate(() => {
      const a = (window as any)._listenTest.fixCtl;
      return Math.abs(a.channelRms(0, 3, 10) - a.channelRms(1, 3, 10)) < 1e-6;
    });
    expect(same).toBe(false);
  });

  test('43.2 play, playhead advance, pause holds the position', async ({
    page,
  }) => {
    await gotoFixMode(page);
    await installWorkerStub(page);
    await enterFix(page);
    await waitLoopReady(page);
    await page.click('#playpause');
    await page.waitForFunction(
      () => (window as any)._listenTest.fix.aud.playing,
    );
    await page.waitForFunction(
      () => (window as any)._listenTest.fix.aud.time > 0.4,
      undefined,
      { timeout: 10_000 },
    );
    await page.click('#playpause');
    const st = await fixState(page);
    expect(st.aud.playing).toBe(false);
    const held = st.aud.time;
    expect(held).toBeGreaterThan(0.4);
    // The clock really stops.
    await page.waitForTimeout(300);
    expect((await fixState(page)).aud.time).toBeCloseTo(held, 3);
  });

  test('43.3 selecting an onset seeks the audition just before it', async ({
    page,
  }) => {
    await gotoFixMode(page);
    await installWorkerStub(page);
    await enterFix(page);
    await waitLoopReady(page);
    await page.click('.fix-onset-next');
    await page.click('.fix-onset-next');
    const st = await fixState(page);
    expect(st.selGroup).toBe(2);
    expect(st.aud.time).toBeCloseTo(Math.max(0, st.selT - 0.5), 3);
  });

  test('43.4 playback follows the sounding onset: selection advances, sounding state pulses', async ({
    page,
  }) => {
    await gotoFixMode(page);
    await installWorkerStub(page);
    await enterFix(page);
    await waitLoopReady(page);
    // Park just before group 5 and play; sample at frame rate so the short
    // sounding windows (inter-onset ~0.4 s here) cannot slip between polls.
    for (let k = 0; k < 5; k++) await page.click('.fix-onset-next');
    const t5 = (await fixState(page)).selT;
    await page.evaluate((t) => (window as any)._listenTest.fixCtl.seek(t), t5 - 0.2);
    await page.click('#playpause');
    const trace = await page.evaluate(
      () =>
        new Promise<any[]>((done) => {
          const out: any[] = [];
          const t0 = performance.now();
          const tick = () => {
            const f = (window as any)._listenTest.fix;
            out.push({
              sel: f.selGroup,
              sounding: f.soundingGroup,
              dom: !!document.querySelector('.fix-note-sounding'),
            });
            if (performance.now() - t0 < 2000) requestAnimationFrame(tick);
            else done(out);
          };
          requestAnimationFrame(tick);
        }),
    );
    await page.evaluate(() => (window as any)._listenTest.fixCtl.pause());
    // Selection followed playback forward, monotonically.
    for (let k = 1; k < trace.length; k++) {
      expect(trace[k].sel).toBeGreaterThanOrEqual(trace[k - 1].sel);
    }
    expect(trace[trace.length - 1].sel).toBeGreaterThan(5);
    // The sounding state lit up, always on the selected onset, and the score
    // highlight class tracked it.
    const lit = trace.filter((s) => s.sounding !== null);
    expect(lit.length).toBeGreaterThan(0);
    for (const s of lit) expect(s.sounding).toBe(s.sel);
    expect(lit.some((s) => s.dom)).toBe(true);
  });

  test('43.5 playback turns the page with the sounding onset', async ({
    page,
  }) => {
    await gotoFixMode(page);
    await installWorkerStub(page);
    await enterFix(page);
    await waitLoopReady(page);
    // Find page 2's first onset time, then play across the boundary from
    // 1 s before it: the follower first re-selects page 1's tail, then
    // crosses onto page 2.
    await page.click('#skip-end');
    await page.waitForFunction(
      () => (window as any)._listenTest.fix.page === 2,
    );
    const t2 = (await fixState(page)).selT;
    await page.evaluate((t) => (window as any)._listenTest.fixCtl.seek(t), t2 - 1.0);
    await page.click('#playpause');
    await page.waitForFunction(
      () => (window as any)._listenTest.fix.page === 1,
      undefined,
      { timeout: 10_000 },
    );
    await page.waitForFunction(
      () => (window as any)._listenTest.fix.page === 2,
      undefined,
      { timeout: 10_000 },
    );
    await page.evaluate(() => (window as any)._listenTest.fixCtl.pause());
    const st = await fixState(page);
    expect(st.selPage).toBe(2);
  });

  test('43.6 dragging a tick lays a hard anchor: realign, applied refill, undo entry, replay', async ({
    page,
  }) => {
    await gotoFixMode(page);
    await installWorkerStub(page);
    await enterFix(page);
    await waitLoopReady(page);
    for (let k = 0; k < 5; k++) await page.click('.fix-onset-next');
    const before = await fixState(page);
    const i = before.selEventIx;
    const neighboursBefore = await page.evaluate((ev) => {
      const sc = (window as any)._listenTest.session.scoreAlignment;
      return { prev: sc.ref_onset[ev - 1], next: sc.ref_onset[ev + 1] };
    }, i);
    await dragSelectedTick(page, 40);
    const st = await fixState(page);
    // One drag anchor at the selected event, at a genuinely moved time.
    expect(st.corrections.anchors).toHaveLength(1);
    const a = st.corrections.anchors[0];
    expect(a.i).toBe(i);
    expect(a.kind).toBe('drag');
    expect(a.t).toBeGreaterThan(before.selT + 0.2);
    expect(st.lastCommit).toMatchObject({ kind: 'drag', i, realigned: 2 });
    // The event itself moved to the anchor time and the flanking interiors
    // were refilled (the stub fills linearly — values must have changed).
    const after = await page.evaluate((ev) => {
      const sc = (window as any)._listenTest.session.scoreAlignment;
      return {
        self: sc.ref_onset[ev],
        selfOff: sc.ref_offset[ev],
        prev: sc.ref_onset[ev - 1],
        next: sc.ref_onset[ev + 1],
      };
    }, i);
    expect(after.self).toBeCloseTo(a.t, 6);
    expect(after.selfOff).toBeCloseTo(a.t + 0.02, 6); // stub's anchor_a_offset
    expect(after.prev).not.toBeCloseTo(neighboursBefore.prev, 6);
    expect(after.next).not.toBeCloseTo(neighboursBefore.next, 6);
    // The durable record and the unified undo stack both carry it.
    expect(st.corrections.headerPresent).toBe(true);
    await expect(page.locator('#undo-btn')).toHaveText('Undo: alignment anchor');
    // The audition re-rendered the changed span and auto-replay started at
    // the run-up ceiling: there is no anchor to the left here, so the
    // segment's left edge is the piece start and MAX_RUNUP_SEC is what
    // decides the start (see 43.27 for the clamp itself).
    expect(st.aud.renderWindow).not.toBeNull();
    expect(st.aud.renderWindow.t0).toBeLessThanOrEqual(0.1);
    expect(st.aud.playing).toBe(true);
    expect(st.aud.time).toBeGreaterThanOrEqual(a.t - 2 - 0.05);
    expect(st.aud.time).toBeLessThan(a.t - 2 + 1.5);
    await page.evaluate(() => (window as any)._listenTest.fixCtl.pause());
  });

  test('43.7 Enter approves the selected onset: zero-drag anchor, no realign, no data change', async ({
    page,
  }) => {
    await gotoFixMode(page);
    await installWorkerStub(page);
    await enterFix(page);
    await waitLoopReady(page);
    for (let k = 0; k < 3; k++) await page.click('.fix-onset-next');
    const before = await fixState(page);
    const sumBefore = await refChecksum(page);
    await page.keyboard.press('Enter');
    const st = await fixState(page);
    expect(st.corrections.anchors).toHaveLength(1);
    expect(st.corrections.anchors[0]).toMatchObject({
      i: before.selEventIx,
      kind: 'approve',
    });
    expect(st.corrections.anchors[0].t).toBeCloseTo(before.selT, 6);
    expect(st.corrections.headerPresent).toBe(true);
    expect(st.lastCommit).toMatchObject({ kind: 'approve', realigned: 0 });
    // No worker realign ran and no value moved.
    const posted = await page.evaluate(() =>
      (window as any).__fixStub.posted.map((p: any) => p.type),
    );
    expect(posted).not.toContain('fix_realign');
    expect(await refChecksum(page)).toEqual(sumBefore);
    await expect(page.locator('#undo-btn')).toHaveText('Undo: alignment anchor');
  });

  test('43.8 a drag clamps inside the neighbouring anchor (never crosses it)', async ({
    page,
  }) => {
    await gotoFixMode(page);
    await installWorkerStub(page);
    await enterFix(page);
    await waitLoopReady(page);
    // Approve group 2, then try to drag group 3 far left past it.
    await page.click('.fix-onset-next');
    await page.click('.fix-onset-next');
    await page.keyboard.press('Enter');
    const anchorT = (await fixState(page)).corrections.anchors[0].t;
    await page.click('.fix-onset-next');
    await dragSelectedTick(page, -300);
    const st = await fixState(page);
    expect(st.corrections.anchors).toHaveLength(2);
    const dragged = st.corrections.anchors.find((x: any) => x.kind === 'drag');
    expect(dragged.t).toBeGreaterThan(anchorT);
    // The two anchors stay strictly ordered in time.
    expect(st.corrections.anchors[0].t).toBeLessThan(st.corrections.anchors[1].t);
    await page.evaluate(() => (window as any)._listenTest.fixCtl.pause());
  });

  test('43.9 undo and redo of a drag are exact snapshot hops (no worker)', async ({
    page,
  }) => {
    await gotoFixMode(page);
    await installWorkerStub(page);
    await enterFix(page);
    await waitLoopReady(page);
    for (let k = 0; k < 4; k++) await page.click('.fix-onset-next');
    const pristine = await refChecksum(page);
    await dragSelectedTick(page, 35);
    await page.evaluate(() => (window as any)._listenTest.fixCtl.pause());
    const edited = await refChecksum(page);
    expect(edited).not.toEqual(pristine);
    const postedBefore = await page.evaluate(
      () => (window as any).__fixStub.posted.length,
    );
    await page.click('#undo-btn');
    expect(await refChecksum(page)).toEqual(pristine);
    expect((await fixState(page)).corrections.anchors).toHaveLength(0);
    await page.click('#redo-btn');
    expect(await refChecksum(page)).toEqual(edited);
    const st = await fixState(page);
    expect(st.corrections.anchors).toHaveLength(1);
    expect(st.corrections.headerPresent).toBe(true);
    // Snapshot semantics: the hops posted nothing to the worker.
    expect(
      await page.evaluate(() => (window as any).__fixStub.posted.length),
    ).toBe(postedBefore);
  });

  test('43.10 an undo with fix mode closed announces itself and still lands', async ({
    page,
  }) => {
    await gotoFixMode(page);
    await installWorkerStub(page);
    await enterFix(page);
    await waitLoopReady(page);
    await page.click('.fix-onset-next');
    await page.keyboard.press('Enter');
    expect((await fixState(page)).corrections.anchors).toHaveLength(1);
    await page.click('#fix-exit');
    await page.waitForFunction(
      () => !(window as any)._listenTest.fix.active,
    );
    await page.click('#undo-btn');
    const st = await fixState(page);
    expect(st.corrections.anchors).toHaveLength(0);
    expect(st.lastAnnounce).toMatch(/Undid alignment correction (near bar \d+|at event \d+)/);
    await expect(page.locator('#fix-toast')).toHaveClass(/fix-toast-show/);
  });

  test('43.11 marks: M lays and lifts them, N skips the loop through them', async ({
    page,
  }) => {
    await gotoFixMode(page);
    await installWorkerStub(page);
    await enterFix(page);
    await waitLoopReady(page);
    await page.evaluate(() => (window as any)._listenTest.fixCtl.seek(10));
    await page.keyboard.press('m');
    await page.evaluate(() => (window as any)._listenTest.fixCtl.seek(20));
    await page.keyboard.press('m');
    let st = await fixState(page);
    expect(st.marks).toEqual([10, 20]);
    // N from the top of the piece: first mark, selection lands at/before it,
    // playhead parks in its preroll.
    await page.evaluate(() => (window as any)._listenTest.fixCtl.seek(0));
    await page.keyboard.press('n');
    st = await fixState(page);
    expect(st.aud.time).toBeCloseTo(9.5, 3);
    expect(st.selT).toBeLessThanOrEqual(10.001);
    // N again steps to the SECOND mark (the preroll does not re-target the
    // first), and wraps from the end.
    await page.keyboard.press('n');
    st = await fixState(page);
    expect(st.aud.time).toBeCloseTo(19.5, 3);
    await page.keyboard.press('n');
    expect((await fixState(page)).aud.time).toBeCloseTo(9.5, 3);
    // M near an existing mark removes it.
    await page.evaluate(() => (window as any)._listenTest.fixCtl.seek(10.2));
    await page.keyboard.press('m');
    expect((await fixState(page)).marks).toEqual([20]);
  });

  test('43.12 a failed realign rolls the fix back wholesale', async ({
    page,
  }) => {
    await gotoFixMode(page);
    await installWorkerStub(page, { realignError: 'synthetic realign failure' });
    await enterFix(page);
    await waitLoopReady(page);
    for (let k = 0; k < 4; k++) await page.click('.fix-onset-next');
    const pristine = await refChecksum(page);
    await dragSelectedTick(page, 35);
    const st = await fixState(page);
    expect(st.chipState).toBe('error');
    await expect(page.locator('.fix-chip')).toContainText('rolled back');
    expect(st.corrections.anchors).toHaveLength(0);
    expect(st.corrections.headerPresent).toBe(false);
    expect(await refChecksum(page)).toEqual(pristine);
    // Nothing reached the undo stack.
    await expect(page.locator('#undo-btn')).toBeDisabled();
  });

  test('43.13 the fix_realign payload contract: both flanking segments, prior values along', async ({
    page,
  }) => {
    await gotoFixMode(page);
    await installWorkerStub(page);
    await enterFix(page);
    await waitLoopReady(page);
    for (let k = 0; k < 5; k++) await page.click('.fix-onset-next');
    const before = await fixState(page);
    const i = before.selEventIx;
    const dur = before.aud.duration;
    await dragSelectedTick(page, 40);
    await page.evaluate(() => (window as any)._listenTest.fixCtl.pause());
    const realigns = await page.evaluate(() =>
      (window as any).__fixStub.posted.filter(
        (p: any) => p.type === 'fix_realign',
      ),
    );
    expect(realigns).toHaveLength(2);
    const t = (await fixState(page)).corrections.anchors[0].t;
    // Left: piece-start corner → the anchor; interior = the events before it.
    expect(realigns[0]).toMatchObject({ iA: -1, tA: 0, iB: i });
    expect(realigns[0].tB).toBeCloseTo(t, 6);
    expect(realigns[0].priorLen).toBe(i);
    // Right: the anchor → the piece-end corner.
    expect(realigns[1]).toMatchObject({ iA: i, iB: before.nEvents });
    expect(realigns[1].tA).toBeCloseTo(t, 6);
    expect(realigns[1].tB).toBeCloseTo(dur, 1);
    expect(realigns[1].priorLen).toBe(before.nEvents - i - 1);
  });

  test('43.14 listen.js\'s global shortcuts stand down while fix mode is open', async ({
    page,
  }) => {
    await gotoFixMode(page);
    await installWorkerStub(page);
    // The main handler acts only when a recording is current; make one so the
    // after-exit half of this test asserts a real behaviour change.
    await page.evaluate(() =>
      (window as any)._listenTest.swapCurrentAudio('audio-a.mp3'),
    );
    await enterFix(page);
    const before = await page.evaluate(
      () => (window as any)._listenTest.currentAudioIx,
    );
    expect(before).toBe('audio-a.mp3');
    // In fix mode ArrowDown turns the page; the hidden pane's current
    // recording must not budge.
    await page.keyboard.press('ArrowDown');
    await page.waitForFunction(
      () => (window as any)._listenTest.fix.page === 2,
    );
    expect(
      await page.evaluate(() => (window as any)._listenTest.currentAudioIx),
    ).toBe(before);
    // After exit the main handler is back in charge.
    await page.click('#fix-exit');
    await page.waitForFunction(
      () => !(window as any)._listenTest.fix.active,
    );
    await page.keyboard.press('ArrowDown');
    await page.waitForFunction(
      (prev) => (window as any)._listenTest.currentAudioIx !== prev,
      before,
    );
  });

  test('43.17 a span too short for DTW falls back to a linear fill; the commit still lands', async ({
    page,
  }) => {
    await gotoFixMode(page);
    await installWorkerStub(page, { realignShort: true });
    await enterFix(page);
    await waitLoopReady(page);
    for (let k = 0; k < 5; k++) await page.click('.fix-onset-next');
    const before = await fixState(page);
    const i = before.selEventIx;
    await dragSelectedTick(page, 40);
    await page.evaluate(() => (window as any)._listenTest.fixCtl.pause());
    const st = await fixState(page);
    // The gesture succeeded despite the worker's refusal on both segments.
    expect(st.chipState).toBe('ready');
    expect(st.corrections.anchors).toHaveLength(1);
    expect(st.lastCommit).toMatchObject({ kind: 'drag', i, realigned: 0, linear: 2 });
    const t = st.corrections.anchors[0].t;
    const vals = await page.evaluate((ev) => {
      const sc = (window as any)._listenTest.session.scoreAlignment;
      return {
        self: sc.ref_onset[ev],
        prev: sc.ref_onset[ev - 1],
        next: sc.ref_onset[ev + 1],
        dur: (window as any)._listenTest.fix.aud.duration,
      };
    }, i);
    // The linear fill keeps the interior inside — and ordered around — the
    // anchor, and the undo entry is a real one.
    expect(vals.self).toBeCloseTo(t, 6);
    expect(vals.prev).toBeGreaterThan(0);
    expect(vals.prev).toBeLessThan(t);
    expect(vals.next).toBeGreaterThan(t);
    expect(vals.next).toBeLessThan(vals.dur);
    await expect(page.locator('#undo-btn')).toHaveText('Undo: alignment anchor');
  });

  test('43.18 a failed realign does not latch editing off — the next drag still tries', async ({
    page,
  }) => {
    await gotoFixMode(page);
    await installWorkerStub(page, { realignError: 'synthetic realign failure' });
    await enterFix(page);
    await waitLoopReady(page);
    for (let k = 0; k < 4; k++) await page.click('.fix-onset-next');
    const pristine = await refChecksum(page);
    await dragSelectedTick(page, 35);
    expect((await fixState(page)).chipState).toBe('error');
    const postedAfterFirst = await page.evaluate(
      () =>
        (window as any).__fixStub.posted.filter(
          (p: any) => p.type === 'fix_realign',
        ).length,
    );
    expect(postedAfterFirst).toBeGreaterThan(0);
    // The error chip stands, but the engine session is intact: a second drag
    // must reach the worker again instead of degrading to click-select.
    await dragSelectedTick(page, 35);
    const postedAfterSecond = await page.evaluate(
      () =>
        (window as any).__fixStub.posted.filter(
          (p: any) => p.type === 'fix_realign',
        ).length,
    );
    expect(postedAfterSecond).toBeGreaterThan(postedAfterFirst);
    // Both failures rolled back wholesale.
    expect((await fixState(page)).corrections.anchors).toHaveLength(0);
    expect(await refChecksum(page)).toEqual(pristine);
  });

  test('43.19 keyboard nudges accumulate and commit as ONE anchor (Shift coarse, Shift+Alt fine)', async ({
    page,
  }) => {
    await gotoFixMode(page);
    await installWorkerStub(page);
    await enterFix(page);
    await waitLoopReady(page);
    for (let k = 0; k < 5; k++) await page.click('.fix-onset-next');
    const before = await fixState(page);
    // Hold Shift across the presses — the nudge floats until full release.
    await page.keyboard.down('Shift');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.down('Alt');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.up('Alt');
    // While Shift is still down nothing can commit: the provisional state
    // floats (no anchor yet), 2×100 ms + 20 ms along.
    let st = await fixState(page);
    expect(st.corrections.anchors).toHaveLength(0);
    expect(st.pendingNudge).not.toBeNull();
    expect(st.pendingNudge.curT).toBeCloseTo(before.selT + 0.22, 6);
    // Full release IS the commit: one anchor, one realign pair, one undo entry.
    await page.keyboard.up('Shift');
    await page.waitForFunction(
      () => {
        const f = (window as any)._listenTest.fix;
        return f.corrections.anchors.length === 1 && !f.realignBusy;
      },
      undefined,
      { timeout: 20_000 },
    );
    await page.evaluate(() => (window as any)._listenTest.fixCtl.pause());
    st = await fixState(page);
    expect(st.corrections.anchors[0].t).toBeCloseTo(before.selT + 0.22, 6);
    expect(st.corrections.anchors[0].kind).toBe('drag');
    expect(st.lastCommit).toMatchObject({ kind: 'drag', realigned: 2 });
    expect(st.pendingNudge).toBeNull();
    // Three presses were ONE history entry: a single undo clears the anchor.
    await page.click('#undo-btn');
    expect((await fixState(page)).corrections.anchors).toHaveLength(0);
  });

  test('43.20 Escape cancels a pending nudge; only a bare Escape exits fix mode', async ({
    page,
  }) => {
    await gotoFixMode(page);
    await installWorkerStub(page);
    await enterFix(page);
    await waitLoopReady(page);
    for (let k = 0; k < 3; k++) await page.click('.fix-onset-next');
    const before = await fixState(page);
    // Shift stays held: the nudge floats, and Escape lands on it.
    await page.keyboard.down('Shift');
    await page.keyboard.press('ArrowLeft');
    expect((await fixState(page)).pendingNudge).not.toBeNull();
    await page.keyboard.press('Escape');
    const st = await fixState(page);
    // The nudge is dropped, nothing committed, and fix mode is still open.
    expect(st.active).toBe(true);
    expect(st.pendingNudge).toBeNull();
    expect(st.corrections.anchors).toHaveLength(0);
    expect(st.selT).toBeCloseTo(before.selT, 9);
    // Releasing Shift after the cancel must not resurrect a commit.
    await page.keyboard.up('Shift');
    expect((await fixState(page)).corrections.anchors).toHaveLength(0);
    await page.keyboard.press('Escape');
    await page.waitForFunction(
      () => !(window as any)._listenTest.fix.active,
    );
  });

  test('43.21 page-only mode clamps playback at the page boundary; play snaps back into the page', async ({
    page,
  }) => {
    await gotoFixMode(page);
    await installWorkerStub(page);
    await enterFix(page);
    await waitLoopReady(page);
    let st = await fixState(page);
    expect(st.pageOnly).toBe(false);
    const win = st.pageWindow;
    expect(win).not.toBeNull();
    expect(win.endT).toBeGreaterThan(win.startT);
    await page.click('#fix-page-only');
    await expect(page.locator('#fix-page-only')).toBeChecked();
    // Play into the boundary: the audition pauses there instead of turning
    // the page (paused-at-boundary is a stable state — polling is safe).
    await page.evaluate((t) => {
      const ct = (window as any)._listenTest.fixCtl;
      ct.seek(t);
      ct.play();
    }, win.endT - 0.4);
    await page.waitForFunction(
      () => !(window as any)._listenTest.fix.aud.playing,
      undefined,
      { timeout: 15_000 },
    );
    st = await fixState(page);
    expect(st.page).toBe(1);
    expect(st.aud.time).toBeGreaterThan(win.endT - 0.05);
    expect(st.aud.time).toBeLessThan(win.endT + 0.05);
    // Play again from the boundary: the position snaps back into the page.
    await page.click('#playpause');
    st = await fixState(page);
    expect(st.aud.playing).toBe(true);
    expect(st.aud.time).toBeLessThan(win.endT - 0.3);
    expect(st.aud.time).toBeGreaterThan(Math.max(0, win.startT - 0.6) - 0.01);
    await page.evaluate(() => (window as any)._listenTest.fixCtl.pause());
    // Mode off: the same approach crosses the boundary and turns the page.
    await page.click('#fix-page-only');
    await expect(page.locator('#fix-page-only')).not.toBeChecked();
    await page.evaluate((t) => {
      const ct = (window as any)._listenTest.fixCtl;
      ct.seek(t);
      ct.play();
    }, win.endT - 0.4);
    await page.waitForFunction(
      (endT) => {
        const f = (window as any)._listenTest.fix;
        return f.aud.playing && f.aud.time > endT + 0.2 && f.page === 2;
      },
      win.endT,
      { timeout: 15_000 },
    );
    await page.evaluate(() => (window as any)._listenTest.fixCtl.pause());
  });

  test('43.22 a drag beside an existing anchor still remaps the dragged event\'s own offset', async ({
    page,
  }) => {
    await gotoFixMode(page);
    await installWorkerStub(page);
    await enterFix(page);
    await waitLoopReady(page);
    // Find two adjacent groups holding CONSECUTIVE event indices, so the
    // flanking segment between them has no interior (no worker realign).
    let prev = await fixState(page);
    let leftEvent: number | null = null;
    for (let k = 0; k < 12 && leftEvent === null; k++) {
      await page.click('.fix-onset-next');
      const cur = await fixState(page);
      if (cur.selEventIx === prev.selEventIx + 1) leftEvent = prev.selEventIx;
      else prev = cur;
    }
    expect(leftEvent).not.toBeNull();
    const i = leftEvent!;
    // Anchor the RIGHT neighbour (approve: zero-drag, no data change) …
    await page.keyboard.press('Enter');
    await page.waitForFunction(
      () => (window as any)._listenTest.fix.corrections.anchors.length === 1,
    );
    // … then drag the event beside it rightward. Before the fix the skipped
    // interior-empty segment left the dragged event's offset STALE — it
    // could land at or before the new onset, a 20 ms blip in the audition.
    await page.click('.fix-onset-prev');
    const before = await page.evaluate((ev) => {
      const sc = (window as any)._listenTest.session.scoreAlignment;
      return {
        on: sc.ref_onset[ev],
        off: sc.ref_offset[ev],
        nextOn: sc.ref_onset[ev + 1],
      };
    }, i);
    await dragSelectedTick(page, 25);
    const st = await fixState(page);
    const a = st.corrections.anchors.find((x: any) => x.i === i);
    expect(a).toBeTruthy();
    const after = await page.evaluate((ev) => {
      const sc = (window as any)._listenTest.session.scoreAlignment;
      return { on: sc.ref_onset[ev], off: sc.ref_offset[ev] };
    }, i);
    // The offset followed the drag instead of staying stale: strictly after
    // its onset, clipped inside the span to the next anchor.
    expect(after.on).toBeCloseTo(a.t, 6);
    expect(after.off).not.toBeCloseTo(before.off, 6);
    expect(after.off).toBeGreaterThan(after.on);
    expect(after.off).toBeLessThanOrEqual(before.nextOn + 1e-9);
    // Undo restores the as-was pair exactly (snapshot semantics).
    await page.click('#undo-btn');
    const undone = await page.evaluate((ev) => {
      const sc = (window as any)._listenTest.session.scoreAlignment;
      return { on: sc.ref_onset[ev], off: sc.ref_offset[ev] };
    }, i);
    expect(undone.on).toBeCloseTo(before.on, 9);
    expect(undone.off).toBeCloseTo(before.off, 9);
  });

  test('43.25 a sustained note dragged beside an anchor keeps its length: the offset extends past the anchor, never clips onto it', async ({
    page,
  }) => {
    await gotoFixMode(page);
    // realignShort routes BOTH flanking segments through _linearFill, the
    // path a fix on closely spaced onsets takes for real.
    await installWorkerStub(page, { realignShort: true });
    await enterFix(page);
    await waitLoopReady(page);
    // Find the first group pair where the LEFT group's first event sustains
    // past the RIGHT group's onset — 134 of the fixture's 554 group pairs do
    // (24.2%), as 8.3% of the Fledermaus HQ corpus's do.
    let leftIx: number | null = null;
    let prev = await fixState(page);
    for (let k = 0; k < 20 && leftIx === null; k++) {
      await page.click('.fix-onset-next');
      const cur = await fixState(page);
      const overruns = await page.evaluate(
        ([a, b]) => {
          const sc = (window as any)._listenTest.session.scoreAlignment;
          return sc.score_offset[a] > sc.score_onset[b] + 1e-9;
        },
        [prev.selEventIx, cur.selEventIx],
      );
      if (overruns) leftIx = prev.selEventIx;
      else prev = cur;
    }
    expect(leftIx, 'no sustained-overlap pair in the first 20 groups').not.toBeNull();
    // Anchor the RIGHT group (approve: zero data change) …
    await page.keyboard.press('Enter');
    await page.waitForFunction(
      () => (window as any)._listenTest.fix.corrections.anchors.length === 1,
    );
    const anchorT = (await fixState(page)).corrections.anchors[0].t;
    // … then drag the sustained note beside it rightward.
    await page.click('.fix-onset-prev');
    const before = await page.evaluate((ev) => {
      const sc = (window as any)._listenTest.session.scoreAlignment;
      return { on: sc.ref_onset[ev], off: sc.ref_offset[ev] };
    }, leftIx);
    await dragSelectedTick(page, 25);
    await page.evaluate(() => (window as any)._listenTest.fixCtl.pause());
    const st = await fixState(page);
    const a = st.corrections.anchors.find((x: any) => x.i === leftIx);
    expect(a).toBeTruthy();
    const after = await page.evaluate((ev) => {
      const sc = (window as any)._listenTest.session.scoreAlignment;
      return { on: sc.ref_onset[ev], off: sc.ref_offset[ev] };
    }, leftIx);
    expect(after.on).toBeCloseTo(a.t, 6);
    expect(after.on).toBeGreaterThan(before.on);
    // The offset follows the drag PAST the next anchor, because that is where
    // the note ends. Clipping it into the span (the round-2 rule) collapsed a
    // sustained note onto the gap it was dropped into — at close spacing a
    // 20 ms blip, heard as the note vanishing.
    expect(after.off).toBeGreaterThan(anchorT + 1e-6);
    expect(after.off).toBeGreaterThan(after.on);
    // The commit's own canary: no event it touched ends at or before it starts.
    expect(st.lastCommit.degenerate).toBe(0);
    // Undo restores the as-was pair exactly (snapshot semantics).
    await page.click('#undo-btn');
    const undone = await page.evaluate((ev) => {
      const sc = (window as any)._listenTest.session.scoreAlignment;
      return { on: sc.ref_onset[ev], off: sc.ref_offset[ev] };
    }, leftIx);
    expect(undone.on).toBeCloseTo(before.on, 9);
    expect(undone.off).toBeCloseTo(before.off, 9);
  });

  test('43.26 a collapsed note still sounds: the renderer floors its length and the envelope reaches full amplitude', async ({
    page,
  }) => {
    let targetOn = -1;
    await gotoFixMode(page, (json) => {
      const sc = json.body?.score ?? json.score ?? json;
      const on: number[] = sc.ref_onset;
      const off: number[] = sc.ref_offset;
      // A note with quiet either side, so the measurement hears it alone —
      // then collapsed to zero length, the shape a fix can leave behind and
      // the shape 2.3% of the Fledermaus HQ events already hold.
      for (let k = 5; k < on.length; k++) {
        const t = on[k];
        if (!Number.isFinite(t)) continue;
        const busy = on.some(
          (o, j) => j !== k && o < t + 0.07 && off[j] > t - 0.02,
        );
        if (busy) continue;
        targetOn = t;
        off[k] = on[k];
        break;
      }
    });
    expect(targetOn, 'no quiet-neighbourhood note in the fixture').toBeGreaterThan(0);
    await installWorkerStub(page);
    await enterFix(page);
    await waitLoopReady(page);
    const rms = await page.evaluate((t) => {
      const c = (window as any)._listenTest.fixCtl;
      return {
        before: c.channelRms(1, t - 0.02, t - 0.005),
        early: c.channelRms(1, t, t + 0.02),
        late: c.channelRms(1, t + 0.045, t + 0.065),
      };
    }, targetOn);
    // Rendered at all, and still sounding past 45 ms — which the old 20 ms
    // floor could not do; it also never reached full amplitude, peaking at
    // 0.47 of the note's own, so the ratio below used to be ~0.
    expect(rms.early).toBeGreaterThan(0.002);
    expect(rms.late).toBeGreaterThan(0.002);
    expect(rms.late / rms.early).toBeGreaterThan(0.15);
    // The neighbourhood really is quiet, so the two windows measure this note.
    expect(rms.before).toBeLessThan(rms.early / 4);
  });

  test('43.23 N activates the jumped-to mark, Delete removes it, Escape deactivates first', async ({
    page,
  }) => {
    await gotoFixMode(page);
    await installWorkerStub(page);
    await enterFix(page);
    await waitLoopReady(page);
    // Two marks at different times; laying does NOT activate.
    await page.keyboard.press('m');
    for (let k = 0; k < 4; k++) await page.click('.fix-onset-next');
    await page.keyboard.press('m');
    let st = await fixState(page);
    expect(st.marks).toHaveLength(2);
    expect(st.activeMark).toBeNull();
    // N jumps to a mark and activates it; Delete removes exactly that one.
    await page.keyboard.press('n');
    st = await fixState(page);
    const victim = st.activeMark;
    expect(victim).not.toBeNull();
    expect(st.marks).toContain(victim);
    await page.keyboard.press('Delete');
    st = await fixState(page);
    expect(st.marks).toHaveLength(1);
    expect(st.marks).not.toContain(victim);
    expect(st.activeMark).toBeNull();
    // Delete with nothing active is inert.
    await page.keyboard.press('Delete');
    expect((await fixState(page)).marks).toHaveLength(1);
    // Escape deactivates before it exits: the first Escape only deselects.
    await page.keyboard.press('n');
    expect((await fixState(page)).activeMark).not.toBeNull();
    await page.keyboard.press('Escape');
    st = await fixState(page);
    expect(st.active).toBe(true);
    expect(st.activeMark).toBeNull();
    expect(st.marks).toHaveLength(1);
  });

  test('43.24 the speed slider slows playback pitch-preserved; the % button resets to 100', async ({
    page,
  }) => {
    await gotoFixMode(page);
    await installWorkerStub(page);
    await enterFix(page);
    await waitLoopReady(page);
    let st = await fixState(page);
    expect(st.aud.stretch).toBe(true);
    expect(st.aud.rate).toBe(1);
    await expect(page.locator('.fix-speed-reset')).toHaveText('100%');
    await page.locator('.fix-speed input').fill('50');
    st = await fixState(page);
    expect(st.aud.rate).toBe(0.5);
    await expect(page.locator('.fix-speed-reset')).toHaveText('50%');
    // Play ~1.2 s and compare the worklet's OWN head advance to wall time:
    // at rate 0.5 the head must move at roughly half real time (the reports
    // come from the worklet's process loop, so this proves real stretching).
    const meas = await page.evaluate(async () => {
      const lt = (window as any)._listenTest;
      lt.fixCtl.seek(0.5);
      lt.fixCtl.play();
      const t0 = performance.now();
      while (performance.now() - t0 < 4000) {
        const a = lt.fix.aud;
        if (a.workletPos !== null && a.workletPos >= 0.5) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      const p1 = lt.fix.aud.workletPos;
      const w1 = performance.now();
      await new Promise((r) => setTimeout(r, 1200));
      const p2 = lt.fix.aud.workletPos;
      const w2 = performance.now();
      lt.fixCtl.pause();
      return { p1, p2, ratio: (p2 - p1) / ((w2 - w1) / 1000) };
    });
    expect(meas.p2).toBeGreaterThan(meas.p1);
    expect(meas.ratio).toBeGreaterThan(0.25);
    expect(meas.ratio).toBeLessThan(0.75);
    // The % button is the way home: exactly 100% again, slider included.
    await page.click('.fix-speed-reset');
    st = await fixState(page);
    expect(st.aud.rate).toBe(1);
    await expect(page.locator('.fix-speed-reset')).toHaveText('100%');
    expect(await page.locator('.fix-speed input').inputValue()).toBe('100');
  });

  test('43.16 the balance slider trims each ear\'s gain in real time', async ({
    page,
  }) => {
    await gotoFixMode(page);
    await installWorkerStub(page);
    await enterFix(page);
    await waitLoopReady(page);
    let st = await fixState(page);
    expect(st.aud.gainL).toBe(1);
    expect(st.aud.gainR).toBe(1);
    // Toward the synth ear: the recording attenuates, the synth stays at 1 —
    // live on the gain nodes, playing or not.
    await page.click('#playpause');
    await page.locator('.fix-balance input').fill('60');
    st = await fixState(page);
    expect(st.aud.balance).toBeCloseTo(0.6, 6);
    expect(st.aud.gainL).toBeCloseTo(0.4, 6);
    expect(st.aud.gainR).toBe(1);
    await page.locator('.fix-balance input').fill('-50');
    st = await fixState(page);
    expect(st.aud.gainL).toBe(1);
    expect(st.aud.gainR).toBeCloseTo(0.5, 6);
    await page.evaluate(() => (window as any)._listenTest.fixCtl.pause());
  });

  test('43.15 Revert-all restores the as-loaded ref tables and clears the record', async ({
    page,
  }) => {
    await gotoFixMode(page);
    await installWorkerStub(page);
    await enterFix(page);
    await waitLoopReady(page);
    for (let k = 0; k < 4; k++) await page.click('.fix-onset-next');
    const pristine = await refChecksum(page);
    await dragSelectedTick(page, 35);
    await page.evaluate(() => (window as any)._listenTest.fixCtl.pause());
    expect(await refChecksum(page)).not.toEqual(pristine);
    await expect(page.locator('#revert-all-btn')).toBeEnabled();
    page.once('dialog', (d) => d.accept());
    await page.click('#revert-all-btn');
    await page.waitForFunction(
      () => (window as any)._listenTest.fix.corrections.anchors.length === 0,
    );
    expect(await refChecksum(page)).toEqual(pristine);
    const st = await fixState(page);
    expect(st.corrections.headerPresent).toBe(false);
    await expect(page.locator('#undo-btn')).toBeDisabled();
  });

  test('43.27 the replay start is clamped to the run-up ceiling, not the previous anchor', async ({
    page,
  }) => {
    await gotoFixMode(page);
    await installWorkerStub(page);
    await enterFix(page);
    await waitLoopReady(page);
    // The first fix of a session has NO anchor to its left, so the segment's
    // own left edge is 0 and the unclamped start would be the top of the
    // recording — a page and a half of run-up for a fix at ~3 s.
    await dragSelectedTick(page, 12);
    const st = await fixState(page);
    expect(st.lastReplay).not.toBeNull();
    expect(st.lastReplay.t0).toBeCloseTo(0, 6);
    // MAX_RUNUP_SEC = 2: the start sits exactly that far before the fix, and
    // strictly after the top of the recording (which is what proves the
    // ceiling bit rather than the preroll).
    expect(st.lastReplay.startT).toBeCloseTo(st.lastReplay.fixedT - 2, 6);
    expect(st.lastReplay.startT).toBeGreaterThan(0.5);
  });

  test('43.28 Replay off suppresses the auto-replay but still commits; R replays on demand', async ({
    page,
  }) => {
    await gotoFixMode(page);
    await installWorkerStub(page);
    await enterFix(page);
    await waitLoopReady(page);

    await page.click('#fix-replay-off');
    await expect(page.locator('#fix-replay-off')).toBeChecked();
    expect((await fixState(page)).replaySuppressed).toBe(true);

    const before = await refChecksum(page);
    await dragSelectedTick(page, 12);
    const st = await fixState(page);
    // The COMMIT still happened — only the replay is suppressed.
    expect(await refChecksum(page)).not.toEqual(before);
    expect(st.corrections.anchors.length).toBe(1);
    expect(st.aud.playing).toBe(false);
    // ...and the span was recorded, so R can still reach it.
    expect(st.lastReplay).not.toBeNull();

    await page.keyboard.press('r');
    await page.waitForFunction(
      () => (window as any)._listenTest.fix.aud?.playing === true,
      undefined,
      { timeout: 10_000 },
    );
    const playing = await fixState(page);
    expect(playing.aud.time).toBeGreaterThanOrEqual(st.lastReplay.startT - 0.05);
    expect(playing.aud.time).toBeLessThan(st.lastReplay.startT + 1.5);
  });

  test('43.29 before the engine arms, the strip reads not-yet-live and a refused drag says why', async ({
    page,
  }) => {
    await gotoFixMode(page);
    await installWorkerStub(page, { deferReady: true });
    await enterFix(page);

    // Dimmed ticks + a waiting cursor: the answer is where the hand is, not
    // only in the chip at the far corner of the screen.
    await expect(page.locator('.fix-ticks')).toHaveClass(/fix-ticks-pending/);
    await expect(page.locator('.fix-strip')).toHaveClass(/fix-strip-pending/);
    expect(
      await page
        .locator('.fix-ticks')
        .evaluate((el) => getComputedStyle(el).cursor),
    ).toBe('progress');

    // A drag that cannot land answers at the pointer instead of failing mute.
    const box = (await page.locator('.fix-ticks').boundingBox())!;
    const st = await fixState(page);
    const x0 = box.x + st.selTickX;
    const y = box.y + box.height / 2;
    await page.mouse.move(x0, y);
    await page.mouse.down();
    await page.mouse.move(x0 + 20, y, { steps: 5 });
    await page.mouse.up();
    expect((await fixState(page)).lastAnnounce).toMatch(/still preparing/i);
    // The keyboard route refuses the same way.
    await page.keyboard.press('Shift+ArrowRight');
    expect((await fixState(page)).lastAnnounce).toMatch(/still preparing/i);
    // Nothing moved.
    expect((await fixState(page)).corrections.anchors.length).toBe(0);

    // The stub only exists once the bootstrap's decode has handed the worker
    // its samples, which is well after the ticks are drawn.
    await page.waitForFunction(
      () => typeof (window as any).__fixStub?.releaseReady === 'function',
      undefined,
      { timeout: 45_000 },
    );
    await page.evaluate(() => (window as any).__fixStub.releaseReady());
    await page.waitForFunction(
      () => (window as any)._listenTest.fix.engineReady === true,
    );
    await expect(page.locator('.fix-ticks')).not.toHaveClass(
      /fix-ticks-pending/,
    );
    await expect(page.locator('.fix-strip')).not.toHaveClass(
      /fix-strip-pending/,
    );
  });

  test('43.30 the playhead is a bracket: arrowheads above and below, nothing across the waveform', async ({
    page,
  }) => {
    await gotoFixMode(page);
    await installWorkerStub(page);
    await enterFix(page);
    await waitLoopReady(page);
    // Park it exactly on the selected onset's tick — the hardest case for
    // telling playhead from tick, and the one the bracket exists for.
    const st = await fixState(page);
    await page.evaluate((t) => (window as any)._listenTest.fixCtl.seek(t), st.selT);
    await page.waitForFunction(
      (t) => Math.abs((window as any)._listenTest.fix.aud.time - t) < 1e-6,
      st.selT,
    );
    // One rAF for the paint the seek scheduled.
    await page.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
    );

    /** Painted rows of a strip canvas: extent and centre of ink per row. */
    const rows = (sel: string) =>
      page.evaluate((s) => {
        const c = document.querySelector(s) as HTMLCanvasElement;
        const { width: w, height: h } = c;
        const d = c.getContext('2d')!.getImageData(0, 0, w, h).data;
        const out: { y: number; n: number; minX: number; maxX: number }[] = [];
        for (let y = 0; y < h; y++) {
          let n = 0;
          let minX = -1;
          let maxX = -1;
          for (let x = 0; x < w; x++) {
            if (d[(y * w + x) * 4 + 3] > 10) {
              n++;
              if (minX < 0) minX = x;
              maxX = x;
            }
          }
          if (n) out.push({ y, n, minX, maxX });
        }
        return { h, w, out };
      }, sel);

    const geom = await page.evaluate(() => ({
      stripH: (document.querySelector('.fix-strip') as HTMLElement).clientHeight,
      lanesH: (document.querySelector('.fix-lanes') as HTMLElement).clientHeight,
    }));
    // The gutter the lower arrowhead lives in comes out of the STRIP's own
    // height (the score pane's must not move — it feeds the prewarm fit).
    const gutter = geom.stripH - geom.lanesH;
    expect(gutter).toBeGreaterThanOrEqual(8);

    const ph = await rows('.fix-playhead');
    expect(ph.out.length).toBeGreaterThan(0);
    const top = ph.out.filter((r) => r.y < ph.h / 2);
    const bot = ph.out.filter((r) => r.y >= ph.h / 2);
    // Two marks, one per side, and NOTHING between them: no line crossing the
    // waveform is the whole point — a vertical line is the tick's shape.
    expect(top.length).toBeGreaterThan(4);
    expect(bot.length).toBeGreaterThan(4);
    expect(Math.max(...top.map((r) => r.y))).toBeLessThan(14);
    expect(Math.min(...bot.map((r) => r.y))).toBeGreaterThan(ph.h - 14);
    const middle = ph.out.filter((r) => r.y >= 14 && r.y <= ph.h - 14);
    expect(middle).toEqual([]);
    // The top arrowhead is INSIDE the strip (the strip's top edge is where
    // every connector lands and the mark diamonds fly), and it tapers
    // downward: base at the edge, apex pointing at the position.
    expect(Math.min(...top.map((r) => r.y))).toBeGreaterThanOrEqual(0);
    expect(top[0].n).toBeGreaterThan(top[top.length - 1].n);
    // The bottom one is OUTSIDE the waveform, in the gutter, tapering up.
    expect(Math.min(...bot.map((r) => r.y))).toBeGreaterThanOrEqual(geom.lanesH);
    expect(bot[bot.length - 1].n).toBeGreaterThan(bot[0].n);
    // Both apexes sit on the position, and the position is the tick's x.
    const centre = (r: { minX: number; maxX: number }) => (r.minX + r.maxX) / 2;
    expect(Math.abs(centre(top[0]) - centre(bot[bot.length - 1]))).toBeLessThan(1.5);
    expect(Math.abs(centre(top[0]) - st.selTickX)).toBeLessThan(2);

    // The ticks keep out of the gutter: it belongs to the playhead alone.
    const tk = await rows('.fix-ticks');
    expect(tk.out.length).toBeGreaterThan(0);
    expect(Math.max(...tk.out.map((r) => r.y))).toBeLessThan(geom.lanesH);
  });

  test('43.31 a released drag snaps to the nearest detected onset; Alt while dragging, or Snap off, places it freely', async ({
    page,
  }) => {
    await gotoFixMode(page);
    await installWorkerStub(page);
    await enterFix(page);
    await waitLoopReady(page);
    for (let k = 0; k < 5; k++) await page.click('.fix-onset-next');
    const before = await fixState(page);
    const pps = before.stripPps;
    const dropT = before.selT + 40 / pps; // where a 40 px drag lands
    const peakT = dropT + 3 / pps; // 3 px past it: inside the snap radius
    await page.evaluate((peaks) => (window as any).__fixStub.sendLanes(peaks), [peakT, peakT + 5]);
    await page.waitForFunction(() => (window as any)._listenTest.fix.lanes?.peakCount === 2);

    // Snapped: the anchor lands EXACTLY on the detected onset.
    await dragSelectedTick(page, 40);
    let st = await fixState(page);
    expect(st.corrections.anchors).toHaveLength(1);
    expect(st.corrections.anchors[0].t).toBeCloseTo(peakT, 6);
    expect(st.lastDrag).toMatchObject({ snapped: true });
    expect(st.lastDrag.t).toBeCloseTo(peakT, 6);
    await page.evaluate(() => (window as any)._listenTest.fixCtl.pause());
    await page.click('#undo-btn');
    await page.waitForFunction(
      () => (window as any)._listenTest.fix.corrections.anchors.length === 0,
    );

    // Alt held through the release: the raw drop point, not the peak.
    await page.keyboard.down('Alt');
    await dragSelectedTick(page, 40);
    await page.keyboard.up('Alt');
    st = await fixState(page);
    expect(st.corrections.anchors).toHaveLength(1);
    expect(st.lastDrag.snapped).toBe(false);
    expect(Math.abs(st.corrections.anchors[0].t - peakT)).toBeGreaterThan(1 / pps);
    expect(Math.abs(st.corrections.anchors[0].t - dropT)).toBeLessThan(1.5 / pps);
    await page.evaluate(() => (window as any)._listenTest.fixCtl.pause());
    await page.click('#undo-btn');
    await page.waitForFunction(
      () => (window as any)._listenTest.fix.corrections.anchors.length === 0,
    );

    // Snap off (the sticky switch): free placement without any modifier.
    await page.click('#fix-snap-onsets');
    await dragSelectedTick(page, 40);
    st = await fixState(page);
    expect(st.snapOnsets).toBe(false);
    expect(st.corrections.anchors).toHaveLength(1);
    expect(st.lastDrag.snapped).toBe(false);
    expect(Math.abs(st.corrections.anchors[0].t - dropT)).toBeLessThan(1.5 / pps);
    await page.evaluate(() => (window as any)._listenTest.fixCtl.pause());
  });

  // --- Feedback round 1 (2026-09-02): multi-select and "move to nearest onset" ---

  /** Marquee-select the ticks whose x lies between two page ticks (inclusive). */
  async function marqueeSelect(page: Page, fromIx: number, toIx: number) {
    const st = await fixState(page);
    const ticks: { ix: number; x: number }[] = st.pageTicks;
    const xs = ticks.map((t) => t.x).sort((a, b) => a - b);
    const xa = ticks.find((t) => t.ix === fromIx)!.x;
    const xb = ticks.find((t) => t.ix === toIx)!.x;
    // Start and end a little outside the two ticks, but clear of any other.
    const gapBefore = xs.filter((x) => x < xa).pop() ?? -100;
    const gapAfter = xs.find((x) => x > xb) ?? xb + 100;
    const x0 = Math.max(xa - 10, (gapBefore + xa) / 2);
    const x1 = Math.min(xb + 10, (xb + gapAfter) / 2);
    const box = (await page.locator('.fix-ticks').boundingBox())!;
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + x0, y);
    await page.mouse.down();
    await page.mouse.move(box.x + (x0 + x1) / 2, y, { steps: 3 });
    await page.mouse.move(box.x + x1, y, { steps: 3 });
    await page.mouse.up();
  }

  test('43.32 marquee, Shift+click and A select several ticks; S moves them to the nearest detected onsets as ONE undo step; Escape clears; default is the selected onset', async ({
    page,
  }) => {
    await gotoFixMode(page);
    await installWorkerStub(page);
    await enterFix(page);
    await waitLoopReady(page);
    for (let k = 0; k < 5; k++) await page.click('.fix-onset-next');
    let st = await fixState(page);
    const sel = st.selGroup;
    expect(st.multiSel).toEqual([]);
    const ticksOf = (ixs: number[]) => st.pageTicks.filter((t: any) => ixs.includes(t.ix));
    // Marquee over three ticks starting at the selected one.
    await marqueeSelect(page, sel, sel + 2);
    st = await fixState(page);
    expect(st.multiSel).toEqual([sel, sel + 1, sel + 2]);
    // Shift+click toggles membership.
    const box = (await page.locator('.fix-ticks').boundingBox())!;
    const y = box.y + box.height / 2;
    const xSel3 = ticksOf([sel + 3])[0].x;
    await page.keyboard.down('Shift');
    await page.mouse.click(box.x + xSel3, y);
    await page.keyboard.up('Shift');
    st = await fixState(page);
    expect(st.multiSel).toEqual([sel, sel + 1, sel + 2, sel + 3]);
    await page.keyboard.down('Shift');
    await page.mouse.click(box.x + xSel3, y);
    await page.keyboard.up('Shift');
    st = await fixState(page);
    expect(st.multiSel).toEqual([sel, sel + 1, sel + 2]);
    // A selects every onset on the page; again clears; Escape clears too.
    await page.keyboard.press('a');
    st = await fixState(page);
    expect(st.multiSel).toHaveLength(st.pageGroupCount);
    await page.keyboard.press('a');
    expect((await fixState(page)).multiSel).toEqual([]);
    await marqueeSelect(page, sel, sel + 1);
    expect((await fixState(page)).multiSel).toHaveLength(2);
    await page.keyboard.press('Escape');
    st = await fixState(page);
    expect(st.multiSel).toEqual([]);
    expect(st.active).toBe(true); // Escape cleared the selection, not the session

    // The command: three selected, detected onsets near two of them (80 and
    // 100 ms off), none within the 250 ms radius of the third.
    const tOf = (ix: number) => st.pageTicks.find((t: any) => t.ix === ix)!.t;
    const targets = [tOf(sel) + 0.08, tOf(sel + 1) + 0.1];
    await page.evaluate((peaks) => (window as any).__fixStub.sendLanes(peaks), targets);
    await page.waitForFunction(() => (window as any)._listenTest.fix.lanes?.peakCount === 2);
    const checksumBefore = await refChecksum(page);
    await marqueeSelect(page, sel, sel + 2);
    await page.keyboard.press('s');
    await page.waitForFunction(
      () => {
        const f = (window as any)._listenTest.fix;
        return f.lastBatch && !f.realignBusy && f.chipState !== 'realign';
      },
      undefined,
      { timeout: 60_000 },
    );
    await page.evaluate(() => (window as any)._listenTest.fixCtl.pause());
    st = await fixState(page);
    expect(st.lastBatch).toMatchObject({ requested: 3, moved: 2, noTarget: 1, blocked: 0 });
    expect(st.corrections.anchors).toHaveLength(2);
    expect(st.corrections.anchors[0].t).toBeCloseTo(targets[0], 6);
    expect(st.corrections.anchors[1].t).toBeCloseTo(targets[1], 6);
    // ONE history entry for the batch: a single undo restores everything.
    await expect(page.locator('#undo-btn')).toHaveText(/Undo: alignment anchors \(2\)/);
    await page.click('#undo-btn');
    await page.waitForFunction(
      () => (window as any)._listenTest.fix.corrections.anchors.length === 0,
    );
    expect(await refChecksum(page)).toEqual(checksumBefore);
    await page.click('#redo-btn');
    await page.waitForFunction(
      () => (window as any)._listenTest.fix.corrections.anchors.length === 2,
    );
    await page.click('#undo-btn');
    await page.waitForFunction(
      () => (window as any)._listenTest.fix.corrections.anchors.length === 0,
    );

    // Default scope: with nothing multi-selected, S moves the SELECTED onset
    // alone, as a plain anchor (a single undo step named like any drag).
    await page.keyboard.press('Escape');
    await page.click('.fix-onset-prev');
    await page.click('.fix-onset-next'); // back on `sel`, multi-selection empty
    st = await fixState(page);
    expect(st.selGroup).toBe(sel);
    expect(st.multiSel).toEqual([]);
    await page.click('#fix-snap-sel');
    await page.waitForFunction(
      () => {
        const f = (window as any)._listenTest.fix;
        return f.corrections.anchors.length === 1 && !f.realignBusy;
      },
      undefined,
      { timeout: 60_000 },
    );
    await page.evaluate(() => (window as any)._listenTest.fixCtl.pause());
    st = await fixState(page);
    expect(st.corrections.anchors[0].t).toBeCloseTo(targets[0], 6);
    expect(st.lastBatch).toMatchObject({ requested: 1, moved: 1 });
    await expect(page.locator('#undo-btn')).toHaveText('Undo: alignment anchor');
  });

  test('43.33 the snap target can be the perceived attack instead of the detected onset — for the drag magnet and for S alike', async ({
    page,
  }) => {
    await gotoFixMode(page);
    await installWorkerStub(page);
    await enterFix(page);
    await waitLoopReady(page);
    for (let k = 0; k < 5; k++) await page.click('.fix-onset-next');
    const before = await fixState(page);
    const pps = before.stripPps;
    expect(before.snapTarget).toBe('flux');
    const dropT = before.selT + 40 / pps;
    const patT = dropT + 3 / pps; // the perceived attack sits 3 px past the drop
    const peakT = patT - 0.06; // …and the detected onset 60 ms before it
    // A second pair NEAR the selected onset, for the command (its radius is
    // 250 ms — the drop point is the best part of a second away).
    const peakNear = before.selT + 0.12;
    const patNear = peakNear + 0.06;
    await page.evaluate(
      ([p, q, shift]) => (window as any).__fixStub.sendLanes([p, q], { patShift: shift }),
      [peakT, peakNear, 0.06],
    );
    await page.waitForFunction(() => (window as any)._listenTest.fix.lanes?.patCount === 2);
    await page.check('#fix-snap-target-perceived');
    expect((await fixState(page)).snapTarget).toBe('perceived');
    // The magnet lands on the perceived attack, not the flux peak.
    await dragSelectedTick(page, 40);
    let st = await fixState(page);
    expect(st.lastDrag.snapped).toBe(true);
    expect(st.corrections.anchors[0].t).toBeCloseTo(patT, 6);
    await page.evaluate(() => (window as any)._listenTest.fixCtl.pause());
    await page.click('#undo-btn');
    await page.waitForFunction(
      () => (window as any)._listenTest.fix.corrections.anchors.length === 0,
    );
    // So does the command, on the near pair: the perceived attack, 180 ms on.
    await page.keyboard.press('s');
    await page.waitForFunction(
      () => {
        const f = (window as any)._listenTest.fix;
        return f.corrections.anchors.length === 1 && !f.realignBusy;
      },
      undefined,
      { timeout: 60_000 },
    );
    await page.evaluate(() => (window as any)._listenTest.fixCtl.pause());
    st = await fixState(page);
    expect(st.corrections.anchors[0].t).toBeCloseTo(patNear, 6);
    // Back to the flux peaks: the same command lands 60 ms earlier.
    await page.click('#undo-btn');
    await page.waitForFunction(
      () => (window as any)._listenTest.fix.corrections.anchors.length === 0,
    );
    await page.check('#fix-snap-target-flux');
    await page.keyboard.press('s');
    await page.waitForFunction(
      () => {
        const f = (window as any)._listenTest.fix;
        return f.corrections.anchors.length === 1 && !f.realignBusy;
      },
      undefined,
      { timeout: 60_000 },
    );
    await page.evaluate(() => (window as any)._listenTest.fixCtl.pause());
    expect((await fixState(page)).corrections.anchors[0].t).toBeCloseTo(peakNear, 6);
  });

  // --- Feedback round 2 (2026-09-02): one peak, one mark ---

  /** Shift+click the ticks of the given groups (adds them to the multi-selection). */
  async function shiftClickTicks(page: Page, ixs: number[]) {
    const st = await fixState(page);
    const box = (await page.locator('.fix-ticks').boundingBox())!;
    const y = box.y + box.height / 2;
    await page.keyboard.down('Shift');
    for (const ix of ixs) {
      const x = st.pageTicks.find((t: any) => t.ix === ix)!.x;
      await page.mouse.click(box.x + x, y);
    }
    await page.keyboard.up('Shift');
  }

  const waitBatch = (page: Page) =>
    page.waitForFunction(
      () => {
        const f = (window as any)._listenTest.fix;
        return f.lastBatch && !f.realignBusy && f.chipState !== 'realign';
      },
      undefined,
      { timeout: 60_000 },
    );

  test('43.34 one detected onset attracts ONE mark: the batch assigns peaks monotonically with score-time spacing, a claimed peak repels the drag magnet, and the losers are left to the realign', async ({
    page,
  }) => {
    await gotoFixMode(page);
    await installWorkerStub(page);
    await enterFix(page);
    await waitLoopReady(page);
    // Two consecutive onsets on the page close enough (< 450 ms apart) that
    // one peak between them lies within the command's 250 ms radius of BOTH.
    let st = await fixState(page);
    const ticks: { ix: number; t: number }[] = st.pageTicks;
    let a = -1;
    for (let k = 0; k + 1 < ticks.length; k++) {
      const d = ticks[k + 1].t - ticks[k].t;
      if (d > 0.2 && d < 0.45 && ticks[k].ix > st.selGroup) {
        a = k;
        break;
      }
    }
    expect(a, 'the fixture page has no suitable onset pair').toBeGreaterThan(-1);
    const tA = ticks[a].t;
    const tB = ticks[a + 1].t;
    const d = tB - tA;
    const ixA = ticks[a].ix;
    const ixB = ticks[a + 1].ix;
    const evA = st.pageTicks.find((t: any) => t.ix === ixA)!.eventIx;
    const evB = st.pageTicks.find((t: any) => t.ix === ixB)!.eventIx;
    const undoAll = async () => {
      while ((await fixState(page)).corrections.anchors.length) {
        await page.click('#undo-btn');
        await page.waitForTimeout(50);
      }
    };
    // (a) ONE peak between them, nearer to B (0.55 of the way): one mark takes
    // it — the nearer — and the other is left to the realign.
    const shared = tA + 0.55 * d;
    await page.evaluate((peaks) => (window as any).__fixStub.sendLanes(peaks), [shared]);
    await page.waitForFunction(() => (window as any)._listenTest.fix.lanes?.peakCount === 1);
    await shiftClickTicks(page, [ixA, ixB]);
    expect((await fixState(page)).multiSel).toEqual([ixA, ixB]);
    await page.keyboard.press('s');
    await waitBatch(page);
    await page.evaluate(() => (window as any)._listenTest.fixCtl.pause());
    st = await fixState(page);
    expect(st.corrections.anchors).toHaveLength(1);
    expect(st.corrections.anchors[0].i).toBe(evB);
    expect(st.corrections.anchors[0].t).toBeCloseTo(shared, 6);
    expect(st.lastBatch).toMatchObject({ requested: 2, moved: 1, shared: 1 });
    await expect(page.locator('#undo-btn')).toHaveText('Undo: alignment anchor');
    // The realign moved A (interior of the refilled segment), but not onto B.
    const tAfter = await page.evaluate(
      (ev) => (window as any)._listenTest.session.scoreAlignment.ref_onset[ev],
      evA,
    );
    expect(tAfter).toBeLessThan(shared - 0.01);

    // The drag magnet: a peak claimed by an anchor does not attract another
    // mark. Select A, drag it to within 3 px of B's peak: no snap.
    await page.keyboard.press('Escape');
    await page.evaluate((ix) => {
      const f = (window as any)._listenTest.fix;
      const box = document.querySelector('.fix-ticks') as HTMLCanvasElement;
      // Click A's tick to select it.
      const x = f.pageTicks.find((t: any) => t.ix === ix).x;
      const r = box.getBoundingClientRect();
      box.dispatchEvent(new MouseEvent('mousedown', { clientX: r.x + x, clientY: r.y + r.height / 2, button: 0, bubbles: true }));
      window.dispatchEvent(new MouseEvent('mouseup', { clientX: r.x + x, clientY: r.y + r.height / 2, button: 0, bubbles: true }));
    }, ixA);
    await page.waitForFunction((ix) => (window as any)._listenTest.fix.selGroup === ix, ixA);
    st = await fixState(page);
    const pps = st.stripPps;
    const dx = (shared - st.selT) * pps - 3; // land 3 px before B's peak
    await dragSelectedTick(page, dx);
    st = await fixState(page);
    expect(st.lastDrag.snapped).toBe(false);
    expect(st.corrections.anchors).toHaveLength(2);
    // It was clamped just short of B's anchor rather than snapped onto it.
    const aAnchor = st.corrections.anchors.find((x: any) => x.i === evA)!;
    expect(aAnchor.t).toBeLessThan(shared);
    expect(Math.abs(aAnchor.t - shared)).toBeGreaterThan(0.005);
    await page.evaluate(() => (window as any)._listenTest.fixCtl.pause());
    await undoAll();

    // (b) Two peaks, one near each mark, spaced like the marks: both move.
    await page.evaluate((peaks) => (window as any).__fixStub.sendLanes(peaks), [tA + 0.08, tB + 0.08]);
    await page.waitForFunction(() => (window as any)._listenTest.fix.lanes?.peakCount === 2);
    await shiftClickTicks(page, [ixA, ixB]);
    await page.keyboard.press('s');
    await waitBatch(page);
    await page.evaluate(() => (window as any)._listenTest.fixCtl.pause());
    st = await fixState(page);
    const qA = ticks[a].q;
    const qB = ticks[a + 1].q;
    expect(
      st.lastBatch,
      `batch ${JSON.stringify(st.lastBatch)} for d=${d.toFixed(3)} s, dq=${(qB - qA).toFixed(3)}`,
    ).toMatchObject({ requested: 2, moved: 2, shared: 0 });
    expect(st.corrections.anchors.map((x: any) => x.i)).toEqual([evA, evB]);
    expect(st.corrections.anchors[0].t).toBeCloseTo(tA + 0.08, 6);
    expect(st.corrections.anchors[1].t).toBeCloseTo(tB + 0.08, 6);
    await undoAll();

    // (c) A crowded pair — 90 ms apart, for a score interval the local tempo
    // puts at ~d: the two marks may not BOTH land there. Exactly one moves.
    await page.evaluate((peaks) => (window as any).__fixStub.sendLanes(peaks), [shared - 0.09, shared]);
    await page.waitForFunction(() => (window as any)._listenTest.fix.lanes?.peakCount === 2);
    await page.keyboard.press('Escape'); // drop (b)'s multi-selection first
    await shiftClickTicks(page, [ixA, ixB]);
    expect((await fixState(page)).multiSel).toEqual([ixA, ixB]);
    await page.keyboard.press('s');
    await waitBatch(page);
    await page.evaluate(() => (window as any)._listenTest.fixCtl.pause());
    st = await fixState(page);
    expect(st.corrections.anchors).toHaveLength(1);
    expect(st.lastBatch).toMatchObject({ requested: 2, moved: 1, shared: 1 });
  });
});
