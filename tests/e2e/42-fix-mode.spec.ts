// 42. Alignment-correction increment 2 (plan §14) — the fix-mode correction
// screen in listen.js: the ?fixMode-gated per-row entry affordance, the
// item-T entry guard (Verovio stamps + exact quarters match, honest refusals),
// the 85/15 score-over-strip layout with page-fit rendering and page turns,
// onset ticks + score-to-strip connectors, onset-skip selection, and the
// correction-engine bootstrap wiring (ref-audio decode + the worker's
// fix_begin) — the worker JS fix-message plumbing spec 41 deferred to here.
//
// The worker is STUBBED via the _listenTest.fixWorkerFactory seam in every
// test that enters fix mode: the real worker loads Pyodide from a CDN, which
// a hermetic suite must never reach. The stub records the messages the app
// posts (42.13 asserts the fix_begin payload shape) and replies like the real
// worker would. The real-worker path was verified manually end to end
// (Pyodide boot → fix_begin → fix_ready) during the increment's build.
import { test, expect } from '../support/fixtures';
import { stubExternalMei } from '../support/helpers';
import { env } from '../support/env';
import type { Page } from '@playwright/test';

const SYNTH_ROW = 'Score (synthesised from MEI)';
const REF_ROW = 'audio-b.mp3';

/** Navigate with ?fixMode, optionally patching the alignment JSON en route. */
async function gotoFixMode(
  page: Page,
  patch?: (json: any) => void,
  { fixMode = true }: { fixMode?: boolean } = {},
) {
  await stubExternalMei(page);
  if (patch) {
    // Predicate matcher, deliberately not a glob: the navigation URL carries
    // /static/test/ inside its ?align= query, and a glob would intercept the
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
    `&useLocal=${env.baseUrl}/static/test` +
    (fixMode ? '&fixMode' : '');
  await page.goto(`/${params}`);
  await page.waitForFunction(
    () => ((window as any)._listenTest?.loadGeneration ?? 0) > 0,
  );
}

/**
 * Install the worker stub. Replies to fix_begin with the app's own event
 * count (read from the live fix session) unless `nEvents` overrides it;
 * `silent` never replies (the error path is driven by the test instead).
 */
async function installWorkerStub(
  page: Page,
  opts: {
    nEvents?: number;
    silent?: boolean;
    error?: string;
    /** Answer fix_lanes at once with synthetic lanes carrying these onset
     *  peaks (perceived attacks = peaks + patShift), echoing the request's
     *  spectrogram parameters; without it the test calls
     *  __fixStub.sendLanes(peaks, opts) itself. */
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
        w.onmessage?.({
          data: {
            type: 'fix_lanes',
            what,
            sr,
            n_mels: nMels,
            n_fft: nFft,
            window: opts.window ?? 'hann',
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
        w.posted.push({
          type: msg.type,
          refLen: msg.refSamples?.length ?? null,
          refIsF32: msg.refSamples instanceof Float32Array,
          midiLen: msg.meiMidi?.length ?? null,
          midiIsU8: msg.meiMidi instanceof Uint8Array,
          options: msg.options ?? null,
          hop: msg.hop ?? null,
          nMels: msg.nMels ?? null,
          nFft: msg.nFft ?? null,
          window: msg.window ?? null,
          melHop: msg.melHop ?? null,
          what: msg.what ?? null,
        });
        if (msg.type === 'fix_lanes') {
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
          return;
        }
        if (msg.type !== 'fix_begin' || o.silent) return;
        setTimeout(() => {
          if (o.error) {
            w.onmessage?.({ data: { type: 'error', message: o.error } });
          } else {
            const n = o.nEvents ?? lt.fix?.nEvents;
            w.onmessage?.({
              data: {
                type: 'fix_ready',
                events: { n_events: n },
                timing: { bootMs: 0, beginMs: 1, boot: null },
              },
            });
          }
        }, 5);
      };
      w.terminate = () => {
        w.terminated = true;
      };
      (window as any).__fixStub = w;
      return w;
    };
  }, opts);
}

/** Click a row's fix button and wait for the screen (stub pre-installed). */
async function enterFix(page: Page, row: string) {
  await page.click(`.waveform[data-ix="${row}"] .wf-fix-btn`);
  await page.waitForFunction(() => (window as any)._listenTest.fix.active);
  // The first overlay paint is rAF-scheduled; wait for the ticks to land so
  // geometry assertions read a drawn screen, not a scheduled one.
  await page.waitForFunction(
    () => (window as any)._listenTest.fix.ticksOnPage > 0,
  );
}

const fixState = (page: Page) =>
  page.evaluate(() => (window as any)._listenTest.fix);

test.describe('42: alignment-correction fix mode (increment 2)', () => {
  test('42.1 without ?fixMode no entry affordance exists anywhere', async ({
    page,
  }) => {
    await gotoFixMode(page, undefined, { fixMode: false });
    // The score row arrives asynchronously; wait for it so its absence of a
    // button is meaningful rather than merely early.
    await page.waitForSelector(`.waveform[data-ix="${SYNTH_ROW}"]`);
    await page.waitForSelector(`.waveform[data-ix="${REF_ROW}"]`);
    expect(await page.locator('.wf-fix-btn').count()).toBe(0);
  });

  test('42.2 with ?fixMode the button appears on exactly the score and reference rows', async ({
    page,
  }) => {
    await gotoFixMode(page);
    await page.waitForSelector(
      `.waveform[data-ix="${SYNTH_ROW}"] .wf-fix-btn`,
    );
    await page.waitForSelector(`.waveform[data-ix="${REF_ROW}"] .wf-fix-btn`);
    const rows = await page.evaluate(() =>
      [...document.querySelectorAll('.wf-fix-btn')].map(
        (b) => (b.closest('.waveform') as HTMLElement).dataset.ix,
      ),
    );
    expect(rows.sort()).toEqual([SYNTH_ROW, REF_ROW].sort());
  });

  test('42.3 entry refused on a Verovio version-stamp mismatch, naming both versions', async ({
    page,
  }) => {
    await gotoFixMode(page, (json) => {
      json.header.verovioVersion = '5.11.0';
    });
    await installWorkerStub(page);
    await page.click(`.waveform[data-ix="${REF_ROW}"] .wf-fix-btn`);
    await page.waitForSelector('.lh-v6-confirm-dialog');
    const st = await fixState(page);
    expect(st.active).toBe(false);
    expect(st.lastRefusal).toContain('Verovio 5.11.0');
    expect(st.lastRefusal).toContain('runs Verovio');
    await page.click('.lh-v6-confirm-ok');
    // The app is untouched: the pane still shows the waveforms.
    await expect(page.locator('#waveforms')).toBeVisible();
    expect(await page.locator('#fix-mode').count()).toBe(0);
  });

  test('42.4 entry refused on an expansion-options stamp', async ({
    page,
  }) => {
    await gotoFixMode(page, (json) => {
      json.header.verovioOptions = { expand: 'expansion-default' };
    });
    await installWorkerStub(page);
    await page.click(`.waveform[data-ix="${REF_ROW}"] .wf-fix-btn`);
    await page.waitForSelector('.lh-v6-confirm-dialog');
    const st = await fixState(page);
    expect(st.active).toBe(false);
    expect(st.lastRefusal).toContain('expansion-default');
    expect(st.lastRefusal).toContain('expandNever');
  });

  test('42.5 entry refused when stored quarters differ from a fresh render', async ({
    page,
  }) => {
    await gotoFixMode(page, (json) => {
      json.body.score.score_onset[3] += 0.25;
    });
    await installWorkerStub(page);
    await page.click(`.waveform[data-ix="${REF_ROW}"] .wf-fix-btn`);
    await page.waitForSelector('.lh-v6-confirm-dialog');
    const st = await fixState(page);
    expect(st.active).toBe(false);
    expect(st.lastRefusal).toMatch(/1 of 725 score_onset quarters differ/);
    expect(st.lastRefusal).toContain('first at event 3');
    expect(st.lastRefusal).toContain('no Verovio version stamp');
  });

  test('42.6 entry replaces the content pane with the score over the strip', async ({
    page,
  }) => {
    await gotoFixMode(page);
    await installWorkerStub(page);
    await enterFix(page, REF_ROW);
    await expect(page.locator('#fix-mode')).toBeVisible();
    await expect(page.locator('#waveforms')).toBeHidden();
    // A real page-fit score render with notes, not an empty svg.
    expect(
      await page.locator('.fix-score-svg g.note').count(),
    ).toBeGreaterThan(20);
    await expect(page.locator('.fix-page-label')).toHaveText(/Page 1 \/ \d+/);
    const st = await fixState(page);
    expect(st.mode).toBe('score-ref');
    expect(st.refFile).toBe(REF_ROW);
    expect(st.nEvents).toBe(725);
    expect(st.pageCount).toBeGreaterThan(1);
    expect(st.stripHasWave).toBe(true);
    // The first onset is selected and its notes are highlighted in the score.
    expect(st.selGroup).toBe(0);
    expect(
      await page.locator('.fix-score-svg .fix-note-sel').count(),
    ).toBeGreaterThan(0);
    // The score pane dominates the layout (~85/15 ruling).
    const heights = await page.evaluate(() => ({
      score: document.querySelector('.fix-score')!.clientHeight,
      strip: document.querySelector('.fix-strip')!.clientHeight,
      root: document.getElementById('fix-mode')!.clientHeight,
    }));
    expect(heights.score).toBeGreaterThan(heights.strip * 3);
    expect(heights.score + heights.strip).toBeGreaterThan(heights.root * 0.7);
  });

  test('42.7 every onset of the current page draws a tick; connectors span to the strip', async ({
    page,
  }) => {
    await gotoFixMode(page);
    await installWorkerStub(page);
    await enterFix(page, SYNTH_ROW); // the score row enters the same mode
    const st = await fixState(page);
    expect(st.entryFile).toBe(SYNTH_ROW);
    expect(st.mode).toBe('score-ref');
    expect(st.pageGroupCount).toBeGreaterThan(10);
    expect(st.ticksOnPage).toBe(st.pageGroupCount);
    expect(st.connectorCount).toBeGreaterThan(0);
    expect(st.connectorCount).toBeLessThanOrEqual(st.pageGroupCount);
    // The strip viewport covers the page's onsets: a real sub-window of the
    // recording, not the whole piece.
    const dur = await page.evaluate(
      () =>
        (window as any)._listenTest.session.waveformPeaks['audio-b.mp3']
          .duration,
    );
    expect(st.stripWindow.t1 - st.stripWindow.t0).toBeLessThan(dur * 0.5);
  });

  test('42.8 onset-skip buttons move the selection and the highlight follows', async ({
    page,
  }) => {
    await gotoFixMode(page);
    await installWorkerStub(page);
    await enterFix(page, REF_ROW);
    const before = await page.evaluate(() =>
      [...document.querySelectorAll('.fix-note-sel')].map((n) => n.id),
    );
    await page.click('.fix-onset-next');
    await page.click('.fix-onset-next');
    let st = await fixState(page);
    expect(st.selGroup).toBe(2);
    await page.click('.fix-onset-prev');
    st = await fixState(page);
    expect(st.selGroup).toBe(1);
    const after = await page.evaluate(() =>
      [...document.querySelectorAll('.fix-note-sel')].map((n) => n.id),
    );
    expect(after.length).toBeGreaterThan(0);
    expect(after).not.toEqual(before);
  });

  test('42.9 clicking a score note selects its onset', async ({ page }) => {
    await gotoFixMode(page);
    await installWorkerStub(page);
    await enterFix(page, REF_ROW);
    // Click notes until one resolves to an onset group (a note without a
    // timemap entry is legal and simply not selectable); the fixture's page 1
    // resolves almost all, so this settles on the first or second try.
    const result = await page.evaluate(() => {
      const notes = [
        ...document.querySelectorAll('.fix-score-svg g.note'),
      ] as SVGGElement[];
      for (let i = 10; i < Math.min(notes.length, 60); i++) {
        notes[i].dispatchEvent(new MouseEvent('click', { bubbles: true }));
        if (notes[i].classList.contains('fix-note-sel')) {
          return {
            clicked: notes[i].id,
            sel: (window as any)._listenTest.fix.selGroup,
          };
        }
      }
      return null;
    });
    expect(result).not.toBeNull();
    expect(result!.sel).toBeGreaterThan(0);
  });

  test('42.10 page turn advances the score and the strip window follows', async ({
    page,
  }) => {
    await gotoFixMode(page);
    await installWorkerStub(page);
    await enterFix(page, REF_ROW);
    const before = await fixState(page);
    await page.click('#skip-end');
    await page.waitForFunction(
      () => (window as any)._listenTest.fix.page === 2,
    );
    const after = await fixState(page);
    expect(after.page).toBe(2);
    // Selection lands on the new page's first onset…
    expect(after.selPage).toBe(2);
    expect(after.selGroup).toBeGreaterThan(before.pageGroupCount - 1);
    // …and the strip viewport moved forward in reference time.
    expect(after.stripWindow.t0).toBeGreaterThan(before.stripWindow.t0);
    await expect(page.locator('.fix-page-label')).toHaveText(/Page 2 \/ \d+/);
  });

  test('42.21 the strip WAVEFORM gets the page window on first entry, not only after a page turn', async ({
    page,
  }) => {
    await gotoFixMode(page);
    await installWorkerStub(page);
    await enterFix(page, REF_ROW);
    // The decode rebuilds the strip with full-rate peaks; that rebuild is the
    // one the user hit, so wait for the engine (which the decode precedes).
    await page.waitForFunction(
      () => (window as any)._listenTest.fix.chipState === 'ready',
      undefined,
      { timeout: 45_000 },
    );
    const dur = await page.evaluate(
      () =>
        (window as any)._listenTest.session.waveformPeaks['audio-b.mp3']
          .duration,
    );
    // WaveSurfer decodes asynchronously even when handed peaks + duration at
    // construction, so the window applied synchronously in _buildStrip was
    // refused and the strip sat at WHOLE-PIECE zoom — with this page's ticks
    // drawn over a different stretch of audio. scrollWidth is the witness: it
    // equals clientWidth while the zoom has not landed, and duration × pps
    // once it has.
    const entry = await fixState(page);
    expect(entry.page).toBe(1);
    expect(entry.stripScroll.width).toBeGreaterThan(
      entry.stripScroll.client * 3,
    );
    expect(Math.abs(entry.stripScroll.width - dur * entry.stripPps)).toBeLessThan(3);
    expect(
      Math.abs(
        entry.stripScroll.left -
          Math.max(0, entry.stripWindow.t0 * entry.stripPps),
      ),
    ).toBeLessThan(2);

    // The user's repro as an assertion: page 1 must look the same on the way
    // back as it did on entry (it used to show the whole piece, then the page).
    await page.click('#skip-end');
    await page.waitForFunction(
      () => (window as any)._listenTest.fix.page === 2,
    );
    await page.click('#skip-back');
    await page.waitForFunction(
      () => (window as any)._listenTest.fix.page === 1,
    );
    const back = await fixState(page);
    expect(back.stripPps).toBeCloseTo(entry.stripPps, 6);
    expect(back.stripScroll.width).toBe(entry.stripScroll.width);
    expect(back.stripScroll.left).toBe(entry.stripScroll.left);
  });

  test('42.11 skipping back from a page\'s first onset turns the page back', async ({
    page,
  }) => {
    await gotoFixMode(page);
    await installWorkerStub(page);
    await enterFix(page, REF_ROW);
    await page.click('#skip-end');
    await page.waitForFunction(
      () => (window as any)._listenTest.fix.page === 2,
    );
    await page.click('.fix-onset-prev');
    await page.waitForFunction(
      () => (window as any)._listenTest.fix.page === 1,
    );
    const st = await fixState(page);
    expect(st.selPage).toBe(1);
  });

  test('42.12 exit restores the pane; the fix layout stays resident for a cheap re-entry', async ({
    page,
  }) => {
    await gotoFixMode(page);
    await installWorkerStub(page);
    const scaleBefore = await page.evaluate(
      () => (window as any)._listenTest.session.tk.getOptions().scale,
    );
    await enterFix(page, REF_ROW);
    // Fix mode re-lays the toolkit out for the pane…
    const scaleDuring = await page.evaluate(
      () => (window as any)._listenTest.session.tk.getOptions().scale,
    );
    expect(scaleDuring).not.toBe(scaleBefore);
    // Let the bootstrap reach the (stubbed) engine before exiting, so the
    // exit has a live worker session to dispose — the assertion below.
    await page.waitForFunction(
      () => (window as any)._listenTest.fix.chipState === 'ready',
      undefined,
      { timeout: 30_000 },
    );
    await page.click('#fix-exit');
    await page.waitForFunction(
      () => !(window as any)._listenTest.fix.active,
    );
    expect(await page.locator('#fix-mode').count()).toBe(0);
    await expect(page.locator('#waveforms')).toBeVisible();
    expect(await page.locator('#waveforms .waveform').count()).toBe(5);
    // …and deliberately KEEPS it at exit: under ?fixMode the fix layout is
    // resident (every remaining consumer is layout-independent), which is
    // what makes exit and re-entry cost milliseconds instead of a relayout
    // each way.
    const scaleAfter = await page.evaluate(
      () => (window as any)._listenTest.session.tk.getOptions().scale,
    );
    expect(scaleAfter).toBe(scaleDuring);
    // The worker outlives the session but its audio state is dropped.
    const disposed = await page.evaluate(() =>
      (window as any).__fixStub.posted.map((p: any) => p.type),
    );
    expect(disposed).toContain('fix_dispose');
    // Re-entry rides the derived cache the first entry built.
    await enterFix(page, REF_ROW);
    const st = await fixState(page);
    expect(st.lastEntry.usedPrewarm).toBe(true);
  });

  test('42.16 the load-idle prewarm makes the first entry instant', async ({
    page,
  }) => {
    await gotoFixMode(page);
    await installWorkerStub(page);
    // The prewarm runs ~2 s after the load settles, at idle; it applies the
    // fix layout (resident from then on) and caches the page model.
    await page.waitForFunction(
      () => (window as any)._listenTest.fix.prewarmReady,
      undefined,
      { timeout: 20_000 },
    );
    const scalePreEntry = await page.evaluate(
      () => (window as any)._listenTest.session.tk.getOptions().scale,
    );
    expect(scalePreEntry).toBe(40); // FIX_SCALE — the layout is already up
    await enterFix(page, REF_ROW);
    const st = await fixState(page);
    expect(st.lastEntry.usedPrewarm).toBe(true);
    expect(st.pageCount).toBeGreaterThan(1);
    expect(st.ticksOnPage).toBeGreaterThan(0);
  });

  test('42.17 a cold entry shows the loading overlay instead of appearing hung', async ({
    page,
  }) => {
    await gotoFixMode(page);
    await installWorkerStub(page);
    // Entering immediately beats the 2 s prewarm timer, so this is the slow
    // path: guard + layout run at entry, behind the painted overlay.
    await enterFix(page, REF_ROW);
    const st = await fixState(page);
    expect(st.lastEntry.usedPrewarm).toBe(false);
    expect(st.lastEntry.spinnerShown).toBe(true);
    // The overlay is gone once the screen is drawn.
    await expect(page.locator('.fix-loading')).toBeHidden();
  });

  test('42.18 one system per page, broken at the encoded breaks', async ({
    page,
  }) => {
    await gotoFixMode(page);
    await installWorkerStub(page);
    await enterFix(page, REF_ROW);
    // Several systems on one page make the connectors cross along x, so a
    // fix-mode "page" is exactly one system (the fixture MEI has 14 sb).
    expect(await page.locator('.fix-score-svg g.system').count()).toBe(1);
    expect((await fixState(page)).pageCount).toBeGreaterThanOrEqual(10);
    await page.click('#skip-end');
    await page.waitForFunction(
      () => (window as any)._listenTest.fix.page === 2,
    );
    expect(await page.locator('.fix-score-svg g.system').count()).toBe(1);
  });

  test('42.19 in-score connector halves paint beneath the score, emphasis follows selection', async ({
    page,
  }) => {
    await gotoFixMode(page);
    await installWorkerStub(page);
    await enterFix(page, REF_ROW);
    const read = () =>
      page.evaluate(() => {
        const outer = document.querySelector(
          '.fix-score-svg svg',
        ) as SVGSVGElement;
        const sel = outer.querySelector(
          '.fix-underlay line.fix-underlay-sel',
        ) as SVGLineElement | null;
        const vb = outer.viewBox?.baseVal;
        // Painted-position cross-check: the browser's OWN render of the
        // selected line must sit at the selected notes' x. This is the
        // assertion that catches coordinate-space bugs per engine — Firefox's
        // nested-svg getScreenCTM mapped every line to the far left of the
        // page on the first orchestral run.
        let paintedDx: number | null = null;
        if (sel) {
          const lineRect = sel.getBoundingClientRect();
          const notes = [
            ...document.querySelectorAll('.fix-score-svg .fix-note-sel'),
          ];
          if (notes.length) {
            const meanX =
              notes.reduce((s, n) => {
                const r = n.getBoundingClientRect();
                return s + r.x + r.width / 2;
              }, 0) / notes.length;
            paintedDx = Math.abs(lineRect.x + lineRect.width / 2 - meanX);
          }
        }
        return {
          // Beneath every score element = first-painted: the underlay must be
          // the page SVG's first child.
          firstIsUnderlay:
            outer.firstElementChild?.classList.contains('fix-underlay') ??
            false,
          lineCount: outer.querySelectorAll('.fix-underlay line').length,
          selCount: outer.querySelectorAll('.fix-underlay line.fix-underlay-sel')
            .length,
          selX: sel?.getAttribute('x1') ?? null,
          selY1: Number(sel?.getAttribute('y1')),
          selY2: Number(sel?.getAttribute('y2')),
          vbHeight: vb?.height ?? 0,
          paintedDx,
        };
      });
    const before = await read();
    expect(before.firstIsUnderlay).toBe(true);
    expect(before.lineCount).toBeGreaterThan(5);
    expect(before.selCount).toBe(1);
    // The line runs DOWNWARD from the onset's highest element to the page
    // box's bottom — the first orchestral run caught lines pointing up and
    // out of the page (a screen-space bottom read mid-transition).
    expect(before.selY2).toBeGreaterThan(before.selY1);
    expect(before.selY2).toBeGreaterThan(0);
    expect(before.selY2).toBeLessThanOrEqual(before.vbHeight + 1);
    // …and it PAINTS where the selected notes are.
    expect(before.paintedDx).not.toBeNull();
    expect(before.paintedDx!).toBeLessThan(3);
    // Every onset attaches to a score element: directly, or (tremolo strokes,
    // whose notes exist only in the expanded MIDI) via its generating note.
    const stats = (await fixState(page)).groupStats;
    expect(stats.orphaned).toBe(0);
    await page.click('.fix-onset-next');
    const after = await read();
    expect(after.selCount).toBe(1);
    expect(after.selX).not.toBe(before.selX);
  });

  test('42.20 the annotation chrome stands down while fix mode is open', async ({
    page,
  }) => {
    await gotoFixMode(page);
    await installWorkerStub(page);
    await expect(page.locator('.lh-v6-ribbon')).toBeVisible();
    await expect(page.locator('.lh-v6-pull-tab')).toBeVisible();
    await enterFix(page, REF_ROW);
    await expect(page.locator('.lh-v6-ribbon')).toBeHidden();
    await expect(page.locator('.lh-v6-pull-tab')).toBeHidden();
    // The point of it: the ribbon is FIXED to the viewport bottom, so it used
    // to cover the strip's lower 40 px — the anchor glyphs among them, and
    // now the playhead's lower arrowhead. The strip's own bottom edge must
    // be the thing under the cursor there.
    const atBottom = await page.evaluate(() => {
      const r = document.querySelector('.fix-strip')!.getBoundingClientRect();
      const el = document.elementFromPoint(r.x + r.width / 2, r.bottom - 3);
      return { cls: el?.className ?? null, inFix: !!el?.closest('#fix-mode') };
    });
    expect(atBottom.inFix).toBe(true);
    expect(atBottom.cls).toContain('fix-');
    // Exit gives the annotation UI back.
    await page.click('#fix-exit');
    await page.waitForFunction(() => !(window as any)._listenTest.fix.active);
    await expect(page.locator('.lh-v6-ribbon')).toBeVisible();
    await expect(page.locator('.lh-v6-pull-tab')).toBeVisible();
  });

  test('42.22 the nav consolidates: Controls and Waveforms stand down, the Correction region takes their place', async ({
    page,
  }) => {
    await gotoFixMode(page);
    await installWorkerStub(page);
    // Computed display, not toBeVisible: at this viewport the Waveforms
    // region is flex-squeezed to zero height by Controls above it, so it is
    // already "not visible" while being perfectly present — and it is the
    // display the consolidation actually changes.
    const shown = () =>
      page.evaluate(() =>
        ['region-controls', 'region-waveforms'].map(
          (id) => getComputedStyle(document.getElementById(id)!).display,
        ),
      );
    expect((await shown()).every((d) => d !== 'none')).toBe(true);
    expect(await page.locator('#region-fix').count()).toBe(0);
    await enterFix(page, REF_ROW);
    // Both regions drive things fix mode has hidden, so neither may sit there
    // inert: they go, and the correction controls arrive in their place.
    expect(await shown()).toEqual(['none', 'none']);
    await expect(page.locator('#region-fix')).toBeVisible();
    // Everything the header used to carry is in the region — and IN it, not
    // merely present somewhere on the page.
    for (const sel of [
      '#fix-exit',
      '#fix-page-only',
      '#fix-replay-off',
      '.fix-speed',
      '.fix-balance',
      '.fix-title',
      '.fix-page-label',
    ]) {
      await expect(page.locator(`#region-fix ${sel}`)).toHaveCount(1);
    }
    // No header over the score: the content pane is score + gap + strip, and
    // _measurePaneDims's skeleton has to agree with that or every entry
    // silently loses its prewarm.
    expect(await page.locator('.fix-header').count()).toBe(0);
    await page.click('#fix-exit');
    await page.waitForFunction(() => !(window as any)._listenTest.fix.active);
    expect((await shown()).every((d) => d !== 'none')).toBe(true);
    expect(await page.locator('#region-fix').count()).toBe(0);
  });

  test('42.23 the main transport drives the correction screen, and is given back at exit', async ({
    page,
  }) => {
    await gotoFixMode(page);
    await installWorkerStub(page);
    const titlesBefore = await page.evaluate(() =>
      ['skip-back', 'seek-back', 'playpause', 'seek-fwd', 'skip-end', 'mark'].map(
        (id) => document.getElementById(id)!.title,
      ),
    );
    await enterFix(page, REF_ROW);
    // Every button says what it now does; the outer pair also swap their
    // glyphs, since "to the start / to the end" would be a lie about a page.
    const titlesDuring = await page.evaluate(() =>
      ['skip-back', 'seek-back', 'playpause', 'seek-fwd', 'skip-end', 'mark'].map(
        (id) => document.getElementById(id)!.title,
      ),
    );
    expect(titlesDuring[0]).toContain('Previous page');
    expect(titlesDuring[1]).toContain('Previous onset');
    expect(titlesDuring[4]).toContain('Next page');
    // toBeVisible, not isVisible(): the glyph swap is a CSS class change on
    // <body>, and only the retrying assertion waits for it to resolve (the
    // one-shot read is green on Chromium and racy on Firefox).
    await expect(page.locator('#skip-end .icon-fix-mode')).toBeVisible();
    await expect(page.locator('#skip-end .icon-listen-mode')).toBeHidden();
    // The outer pair turn pages…
    const p0 = (await fixState(page)).page;
    await page.click('#skip-end');
    await page.waitForFunction(
      (p) => (window as any)._listenTest.fix.page > p,
      p0,
    );
    await page.click('#skip-back');
    await page.waitForFunction(
      (p) => (window as any)._listenTest.fix.page === p,
      p0,
    );
    // …and the inner pair step onsets.
    const sel0 = (await fixState(page)).selGroup;
    await page.click('#seek-fwd');
    await page.waitForFunction(
      (s) => (window as any)._listenTest.fix.selGroup !== s,
      sel0,
    );
    await page.click('#seek-back');
    expect((await fixState(page)).selGroup).toBe(sel0);
    // Exit hands the transport back, titles and glyphs included.
    await page.click('#fix-exit');
    await page.waitForFunction(() => !(window as any)._listenTest.fix.active);
    expect(
      await page.evaluate(() =>
        ['skip-back', 'seek-back', 'playpause', 'seek-fwd', 'skip-end', 'mark'].map(
          (id) => document.getElementById(id)!.title,
        ),
      ),
    ).toEqual(titlesBefore);
    await expect(page.locator('#skip-end .icon-listen-mode')).toBeVisible();
    await expect(page.locator('#skip-end .icon-fix-mode')).toBeHidden();
    await expect(page.locator('#playpause')).toBeEnabled();
  });

  test('42.13 the bootstrap posts fix_begin with decoded samples, the MIDI, and the stored params', async ({
    page,
  }) => {
    await gotoFixMode(page);
    await installWorkerStub(page);
    await enterFix(page, REF_ROW);
    // Decode of the reference recording runs first; allow it real time. (The
    // runtime warm-up's fix_boot lands before it, so wait for fix_begin itself.)
    await page.waitForFunction(
      () =>
        ((window as any).__fixStub?.posted ?? []).some((p: any) => p.type === 'fix_begin'),
      undefined,
      { timeout: 30_000 },
    );
    const { posted, duration } = await page.evaluate(() => ({
      posted: (window as any).__fixStub.posted,
      duration: (window as any)._listenTest.session.waveformPeaks[
        'audio-b.mp3'
      ].duration,
    }));
    const begin = posted.find((p: any) => p.type === 'fix_begin');
    expect(begin).toBeTruthy();
    // Mono Float32 at the aligner's 22050 Hz — the align.js decode contract.
    expect(begin.refIsF32).toBe(true);
    expect(begin.refLen).toBeGreaterThan((duration - 2) * 22050);
    expect(begin.refLen).toBeLessThan((duration + 2) * 22050);
    expect(begin.midiIsU8).toBe(true);
    expect(begin.midiLen).toBeGreaterThan(1000);
    // The STORED alignmentParams ride along — no "fast parameters" (§14).
    expect(begin.options).toEqual({
      coarse: 2,
      slack: 160,
      featureRate: 20,
      scoreDownsample: 1,
      onsetWeight: 2,
    });
    // The stub's fix_ready lands as engine readiness.
    await page.waitForFunction(
      () => (window as any)._listenTest.fix.chipState === 'ready',
    );
  });

  test('42.14 a worker error surfaces on the chip and the screen stays usable', async ({
    page,
  }) => {
    await gotoFixMode(page);
    await installWorkerStub(page, { error: 'synthetic engine failure' });
    await enterFix(page, REF_ROW);
    await page.waitForFunction(
      () => (window as any)._listenTest.fix.chipState === 'error',
      undefined,
      { timeout: 30_000 },
    );
    await expect(page.locator('.fix-chip')).toContainText(
      'synthetic engine failure',
    );
    // Still inspectable: paging works after the failure.
    await page.click('#skip-end');
    await page.waitForFunction(
      () => (window as any)._listenTest.fix.page === 2,
    );
  });

  test('42.15 an event-count disagreement from the engine is refused as an error', async ({
    page,
  }) => {
    await gotoFixMode(page);
    await installWorkerStub(page, { nEvents: 3 });
    await enterFix(page, REF_ROW);
    await page.waitForFunction(
      () => (window as any)._listenTest.fix.chipState === 'error',
      undefined,
      { timeout: 30_000 },
    );
    await expect(page.locator('.fix-chip')).toContainText('event count');
  });

  // --- v2 lanes (plan §14 Layout Q2): the strip is a LANE STACK ---

  test('42.24 the strip is a lane stack: waveform over spectrogram over onset curve; the toggles resize it and the prewarm fit follows', async ({
    page,
  }) => {
    await gotoFixMode(page);
    await installWorkerStub(page);
    await enterFix(page, REF_ROW);
    const geo = () =>
      page.evaluate(() => {
        const q = (s: string) => document.querySelector(s) as HTMLElement;
        return {
          score: q('.fix-score').clientHeight,
          strip: q('.fix-strip').clientHeight,
          lanes: q('.fix-lanes').clientHeight,
          wave: q('.fix-strip-ws').clientHeight,
          spec: q('.fix-lane-spec').clientHeight,
          onset: q('.fix-lane-onset').clientHeight,
          specHidden: q('.fix-lane-spec').hidden,
          onsetHidden: q('.fix-lane-onset').hidden,
          children: q('.fix-lanes').childElementCount,
        };
      });
    let g = await geo();
    // Three lanes, on by default, each with real height, filling the lane box
    // exactly; the playhead's gutter beneath them is untouched.
    expect(g.children).toBe(3);
    expect(g.specHidden).toBe(false);
    expect(g.onsetHidden).toBe(false);
    expect(g.wave).toBeGreaterThan(16);
    expect(g.spec).toBeGreaterThan(16);
    expect(g.onset).toBeGreaterThan(8);
    expect(g.wave + g.spec + g.onset).toBeGreaterThanOrEqual(g.lanes - 3);
    expect(g.wave + g.spec + g.onset).toBeLessThanOrEqual(g.lanes);
    expect(g.strip - g.lanes).toBeGreaterThanOrEqual(8);
    // The 85/15 ruling's pin (42.6) still holds with the lanes on.
    expect(g.score).toBeGreaterThan(g.strip * 3);
    const stripWithLanes = g.strip;
    await expect(page.locator('#fix-lane-spec')).toBeChecked();
    await expect(page.locator('#fix-lane-onset')).toBeChecked();
    await expect(page.locator('#fix-snap-onsets')).toBeChecked();
    // Both lanes off: the strip returns to the waveform-only height and the
    // score pane grows into it (a re-fit, so the loading overlay comes and goes).
    await page.click('#fix-lane-spec');
    await page.click('#fix-lane-onset');
    await page.waitForFunction(() => {
      const q = (s: string) => document.querySelector(s) as HTMLElement;
      return q('.fix-lane-spec').hidden && q('.fix-lane-onset').hidden && q('.fix-loading').hidden;
    });
    await page.waitForFunction(() => (window as any)._listenTest.fix.ticksOnPage > 0);
    g = await geo();
    expect(g.strip).toBeLessThan(stripWithLanes);
    expect(g.wave).toBe(g.lanes);
    // The prewarm probe honours the toggles: exit and re-entry still ride the
    // resident fit, and the choice is sticky across sessions.
    await page.waitForFunction(
      () => (window as any)._listenTest.fix.chipState === 'ready',
      undefined,
      { timeout: 30_000 },
    );
    await page.click('#fix-exit');
    await page.waitForFunction(() => !(window as any)._listenTest.fix.active);
    await enterFix(page, REF_ROW);
    const st = await fixState(page);
    expect(st.lastEntry.usedPrewarm).toBe(true);
    expect(st.laneSpec).toBe(false);
    expect(st.laneOnset).toBe(false);
    await expect(page.locator('#fix-lane-spec')).not.toBeChecked();
    expect((await geo()).wave).toBe((await geo()).lanes);
  });

  test('42.25 the lanes paint from the engine: spectrogram pixels, the onset curve, and its detected peaks as marks', async ({
    page,
  }) => {
    await gotoFixMode(page);
    await installWorkerStub(page);
    await enterFix(page, REF_ROW);
    await page.waitForFunction(
      () => (window as any)._listenTest.fix.chipState === 'ready',
      undefined,
      { timeout: 30_000 },
    );
    // The lanes are requested once the engine is ready, at the lane resolution;
    // arming does not wait for them.
    const req = await page.evaluate(() =>
      (window as any).__fixStub.posted.find((p: any) => p.type === 'fix_lanes'),
    );
    expect(req).toMatchObject({ hop: 512, nMels: 64 });
    let st = await fixState(page);
    expect(st.lanes).toBeNull();
    // Reply with one peak inside the current page's window and one far away.
    const mid = (Math.max(0, st.stripWindow.t0) + st.stripWindow.t1) / 2;
    await page.evaluate((peaks) => (window as any).__fixStub.sendLanes(peaks), [mid, mid + 40]);
    await page.waitForFunction(() => (window as any)._listenTest.fix.lanes?.peakCount === 2);
    await page.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
    );
    st = await fixState(page);
    expect(st.lanes).toMatchObject({ hop: 512, nMels: 64, peakCount: 2 });
    expect(st.lanes.nFrames).toBeGreaterThan(1000);
    const painted = await page.evaluate(() => {
      const scan = (sel: string) => {
        const c = document.querySelector(sel) as HTMLCanvasElement;
        const { width: w, height: h } = c;
        const d = c.getContext('2d')!.getImageData(0, 0, w, h).data;
        let n = 0;
        const topCols = new Array(w).fill(0);
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            if (d[(y * w + x) * 4 + 3] > 10) {
              n++;
              if (y < 6) topCols[x]++;
            }
          }
        }
        return { n, w, h, topCols };
      };
      return { spec: scan('.fix-lane-spec'), onset: scan('.fix-lane-onset') };
    });
    // The spectrogram: most of the lane carries colour (the stub's gradient).
    expect(painted.spec.w).toBeGreaterThan(100);
    expect(painted.spec.h).toBeGreaterThan(16);
    expect(painted.spec.n).toBeGreaterThan(painted.spec.w * painted.spec.h * 0.5);
    // The onset lane: the curve paints, and the detected onset is a mark
    // hanging from the lane's top at its time's x — while a column a little
    // to the right, where the curve is near-silent, has nothing at the top.
    expect(painted.onset.n).toBeGreaterThan(0);
    const x = Math.round(mid * st.stripPps - st.stripScroll.left);
    const sum = (a: number, b: number) => a + b;
    expect(painted.onset.topCols.slice(Math.max(0, x - 3), x + 4).reduce(sum, 0)).toBeGreaterThan(0);
    expect(painted.onset.topCols.slice(x + 20, x + 30).reduce(sum, 0)).toBe(0);
  });

  // --- Feedback round 1 (2026-09-02): configuration, resizing, warm-up ---

  test('42.26 the spectrogram is configurable: window size, type, overlap, bands — re-requested from the engine, sticky, hidden with the lane', async ({
    page,
  }) => {
    await gotoFixMode(page);
    await installWorkerStub(page, { lanes: { peaks: [10, 20] } });
    await enterFix(page, REF_ROW);
    await page.waitForFunction(() => (window as any)._listenTest.fix.lanes?.peakCount === 2);
    let st = await fixState(page);
    expect(st.specCfg).toEqual({ nFft: 2048, window: 'hann', overlap: 0.75, nMels: 64 });
    expect(st.lanes).toMatchObject({ melHop: 512, nFft: 2048, window: 'hann', nMels: 64 });
    const cfg = page.locator('.fix-spec-cfg');
    await expect(cfg).toBeVisible();
    const lastLanesReq = () =>
      page.evaluate(() => {
        const p = (window as any).__fixStub.posted.filter((m: any) => m.type === 'fix_lanes');
        return p[p.length - 1];
      });
    // The first request asked for everything; a configuration change asks for
    // the mel alone and keeps the onset curve and its peaks.
    expect(await lastLanesReq()).toMatchObject({ what: 'all', hop: 512, nMels: 64, nFft: 2048, melHop: 512 });
    await page.selectOption('#fix-spec-nfft', '1024');
    await page.waitForFunction(() => (window as any)._listenTest.fix.lanes?.melHop === 256);
    expect(await lastLanesReq()).toMatchObject({ what: 'mel', nFft: 1024, melHop: 256, window: 'hann', nMels: 64 });
    st = await fixState(page);
    expect(st.lanes).toMatchObject({ melHop: 256, nFft: 1024, peakCount: 2 });
    await page.selectOption('#fix-spec-window', 'blackman');
    await page.waitForFunction(() => (window as any)._listenTest.fix.lanes?.window === 'blackman');
    await page.selectOption('#fix-spec-overlap', '0.5');
    await page.waitForFunction(() => (window as any)._listenTest.fix.lanes?.melHop === 512);
    await page.selectOption('#fix-spec-mels', '32');
    await page.waitForFunction(() => (window as any)._listenTest.fix.lanes?.nMels === 32);
    expect(await lastLanesReq()).toMatchObject({ what: 'mel', nFft: 1024, melHop: 512, window: 'blackman', nMels: 32 });
    // It paints at the new resolution.
    await page.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
    );
    const painted = await page.evaluate(() => {
      const c = document.querySelector('.fix-lane-spec') as HTMLCanvasElement;
      const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 10) n++;
      return { n, total: c.width * c.height };
    });
    expect(painted.n).toBeGreaterThan(painted.total * 0.5);
    // The block hides with its lane and comes back with it.
    await page.click('#fix-lane-spec');
    await expect(cfg).toBeHidden();
    await page.click('#fix-lane-spec');
    await expect(cfg).toBeVisible();
    // Sticky: a new session asks for everything at the chosen configuration.
    await page.waitForFunction(
      () => (window as any)._listenTest.fix.chipState === 'ready',
      undefined,
      { timeout: 30_000 },
    );
    await page.click('#fix-exit');
    await page.waitForFunction(() => !(window as any)._listenTest.fix.active);
    await enterFix(page, REF_ROW);
    await page.waitForFunction(() => (window as any)._listenTest.fix.lanes?.peakCount === 2);
    expect(await lastLanesReq()).toMatchObject({ what: 'all', nFft: 1024, melHop: 512, window: 'blackman', nMels: 32 });
    await expect(page.locator('#fix-spec-nfft')).toHaveValue('1024');
    await expect(page.locator('#fix-spec-mels')).toHaveValue('32');
  });

  test('42.27 the lane stack is resizable: the gap drags it against the score, lane handles drag the lanes against each other, both sticky and both honoured by the prewarm fit', async ({
    page,
  }) => {
    await gotoFixMode(page);
    await installWorkerStub(page);
    await enterFix(page, REF_ROW);
    const geo = () =>
      page.evaluate(() => {
        const q = (s: string) => document.querySelector(s) as HTMLElement;
        return {
          score: q('.fix-score').clientHeight,
          strip: q('.fix-strip').clientHeight,
          lanes: q('.fix-lanes').clientHeight,
          wave: q('.fix-strip-ws').clientHeight,
          spec: q('.fix-lane-spec').clientHeight,
          onset: q('.fix-lane-onset').clientHeight,
          handles: Array.from(document.querySelectorAll('.fix-lane-handle')).filter(
            (h) => !(h as HTMLElement).hidden,
          ).length,
        };
      });
    const settled = async () => {
      await page.waitForFunction(() => (document.querySelector('.fix-loading') as HTMLElement).hidden);
      await page.waitForFunction(() => (window as any)._listenTest.fix.ticksOnPage > 0);
    };
    const g0 = await geo();
    expect(g0.handles).toBe(2);
    let st = await fixState(page);
    expect(st.stripHeightPx).toBeNull();
    expect(st.laneWeights).toBeNull();
    // Drag the gap UP by 60 px: the strip grows by 60, the score shrinks.
    const gap = (await page.locator('.fix-gap').boundingBox())!;
    const gx = gap.x + gap.width / 2;
    const gy = gap.y + gap.height / 2;
    await page.mouse.move(gx, gy);
    await page.mouse.down();
    await page.mouse.move(gx, gy - 30, { steps: 3 });
    await page.mouse.move(gx, gy - 60, { steps: 3 });
    await page.mouse.up();
    await settled();
    const g1 = await geo();
    expect(Math.abs(g1.strip - (g0.strip + 60))).toBeLessThanOrEqual(3);
    expect(g1.score).toBeLessThan(g0.score - 50);
    st = await fixState(page);
    expect(Math.abs(st.stripHeightPx - g1.strip)).toBeLessThanOrEqual(3);
    // Drag the first lane handle (waveform | spectrogram) DOWN by 15 px: the
    // waveform gains what the spectrogram loses; the stack's total is unmoved.
    const h = (await page.locator('.fix-lane-handle').first().boundingBox())!;
    const hx = h.x + h.width / 2;
    const hy = h.y + h.height / 2;
    await page.mouse.move(hx, hy);
    await page.mouse.down();
    await page.mouse.move(hx, hy + 15, { steps: 3 });
    await page.mouse.up();
    await page.waitForFunction(() => (window as any)._listenTest.fix.ticksOnPage > 0);
    const g2 = await geo();
    expect(Math.abs(g2.wave - (g1.wave + 15))).toBeLessThanOrEqual(2);
    expect(Math.abs(g2.spec - (g1.spec - 15))).toBeLessThanOrEqual(2);
    expect(g2.onset).toBe(g1.onset);
    expect(g2.lanes).toBe(g1.lanes);
    st = await fixState(page);
    expect(st.laneWeights).not.toBeNull();
    // Sticky, and the prewarm probe knows the new size: re-entry rides the fit.
    await page.waitForFunction(
      () => (window as any)._listenTest.fix.chipState === 'ready',
      undefined,
      { timeout: 30_000 },
    );
    await page.click('#fix-exit');
    await page.waitForFunction(() => !(window as any)._listenTest.fix.active);
    await enterFix(page, REF_ROW);
    st = await fixState(page);
    expect(st.lastEntry.usedPrewarm).toBe(true);
    const g3 = await geo();
    expect(Math.abs(g3.strip - g1.strip)).toBeLessThanOrEqual(2);
    expect(Math.abs(g3.wave - g2.wave)).toBeLessThanOrEqual(2);
    // Double-click on the gap resets the strip to its default height.
    await page.dblclick('.fix-gap');
    await settled();
    const g4 = await geo();
    expect(Math.abs(g4.strip - g0.strip)).toBeLessThanOrEqual(3);
    expect((await fixState(page)).stripHeightPx).toBeNull();
  });

  test('42.28 the Python runtime is warmed at load-idle and at entry, so arming does not wait for it; the arming trail is recorded', async ({
    page,
  }) => {
    await gotoFixMode(page);
    await installWorkerStub(page);
    await page.waitForFunction(
      () => (window as any)._listenTest.fix.prewarmReady,
      undefined,
      { timeout: 20_000 },
    );
    // The prewarm already booted the worker's runtime — before any entry.
    const types = () =>
      page.evaluate(() => (window as any).__fixStub.posted.map((p: any) => p.type));
    expect(await types()).toEqual(['fix_boot']);
    await enterFix(page, REF_ROW);
    await page.waitForFunction(
      () => (window as any)._listenTest.fix.chipState === 'ready',
      undefined,
      { timeout: 30_000 },
    );
    const t = await types();
    expect(t.indexOf('fix_begin')).toBeGreaterThan(t.indexOf('fix_boot'));
    const st = await fixState(page);
    expect(st.timing).toMatchObject({ worker: { bootMs: 0, beginMs: 1 } });
    expect(st.timing.decodeMs).toBeGreaterThanOrEqual(0);
    expect(st.timing.readyMs).toBeGreaterThan(0);
  });
});
