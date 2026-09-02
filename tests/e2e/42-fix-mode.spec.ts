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
  opts: { nEvents?: number; silent?: boolean; error?: string } = {},
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
      w.postMessage = (msg: any) => {
        w.posted.push({
          type: msg.type,
          refLen: msg.refSamples?.length ?? null,
          refIsF32: msg.refSamples instanceof Float32Array,
          midiLen: msg.meiMidi?.length ?? null,
          midiIsU8: msg.meiMidi instanceof Uint8Array,
          options: msg.options ?? null,
        });
        if (msg.type !== 'fix_begin' || o.silent) return;
        setTimeout(() => {
          if (o.error) {
            w.onmessage?.({ data: { type: 'error', message: o.error } });
          } else {
            const n = o.nEvents ?? lt.fix?.nEvents;
            w.onmessage?.({
              data: { type: 'fix_ready', events: { n_events: n } },
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
    // Decode of the reference recording runs first; allow it real time.
    await page.waitForFunction(
      () => ((window as any).__fixStub?.posted?.length ?? 0) > 0,
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
});
