// 30. Pane-level loading indicator
//
// Between accepting an alignment and creating the first waveform element there
// is no waveform to hang a per-waveform overlay on, so the content pane sat
// blank — several seconds on a long piece with many recordings, spent fetching
// the alignment, rendering MIDI from the score, and interpolating the synth
// grid. A pane-level indicator covers exactly that window and hands over to the
// per-waveform overlays as soon as the first waveform exists.
//
// The risk these tests guard is a STUCK indicator: one that outlives the load,
// or survives a failure with nothing downstream left to clear it, is worse than
// the blank pane it replaced.
import { test, expect } from '../support/fixtures';
import { loadLocalAlignment } from '../support/helpers';

const SEL = '#waveforms > .wf-pane-loading';

type SpinEvent = { t: number; what: string; txt: string };

/**
 * Record the indicator's appearances and removals from before navigation.
 *
 * Polling from the test side is unreliable here: the whole window can be a few
 * hundred milliseconds, and each round trip costs a slice of it. A
 * MutationObserver installed via addInitScript sees every transition.
 */
async function observeIndicator(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    (window as any).__spin = [];
    const t0 = Date.now();
    let last = '';
    const obs = new MutationObserver(() => {
      const el = document.querySelector('#waveforms > .wf-pane-loading');
      if (el) {
        const txt = (el.querySelector('.wf-overlay-status') as HTMLElement)?.textContent ?? '';
        if (last !== 'present:' + txt) {
          (window as any).__spin.push({ t: Date.now() - t0, what: 'shown', txt });
          last = 'present:' + txt;
        }
      } else if (last && last !== 'gone') {
        const n = document.querySelectorAll('#waveforms .waveform').length;
        (window as any).__spin.push({ t: Date.now() - t0, what: 'gone', txt: 'waveforms=' + n });
        last = 'gone';
      }
    });
    document.addEventListener('DOMContentLoaded', () =>
      obs.observe(document.body, { childList: true, subtree: true, characterData: true }));
  });
}

const spinLog = (page: import('@playwright/test').Page): Promise<SpinEvent[]> =>
  page.evaluate(() => (window as any).__spin ?? []);

test.describe('30. Pane loading indicator', () => {
  // 30.1 It covers the gap and then gets out of the way.
  test('30.1 the indicator shows during load and is gone once a waveform exists', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await observeIndicator(page);
    await loadLocalAlignment(page);
    await page.waitForSelector('#waveforms .waveform', { timeout: 60_000 });

    const log = await spinLog(page);
    expect(log.some((e) => e.what === 'shown'), `never appeared: ${JSON.stringify(log)}`).toBe(true);

    // Whatever it said, it must name a phase rather than spin silently.
    expect(log.find((e) => e.what === 'shown')!.txt.trim().length).toBeGreaterThan(0);

    // And it must be gone now that the pane has content.
    await expect(page.locator(SEL)).toHaveCount(0);
  });

  // 30.2 A late phase update must not resurrect it over a populated pane. This
  // passes before the feature too (nothing to resurrect) — a guard, not a control.
  test('30.2 the indicator does not come back after the waveforms arrive', async ({
    loadedPage: page,
  }) => {
    test.setTimeout(120_000);
    await expect(page.locator(SEL)).toHaveCount(0);
    await page.waitForTimeout(3000);
    await expect(page.locator(SEL)).toHaveCount(0);
    // Sanity: the pane really is populated, so the check above means something.
    expect(await page.locator('#waveforms .waveform').count()).toBeGreaterThan(0);
  });

  // 30.3 The failure that would strand it: the alignment fetch never succeeds,
  // so setGrids never runs and nothing downstream is left to clear it. Also
  // passes before the feature — a guard against the stuck-spinner regression,
  // not a fail-before control. Only 30.1 is.
  test('30.3 a failed alignment fetch does not leave the indicator spinning', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.route('**/static/test/alignment.json', (route) =>
      route.fulfill({ status: 500, contentType: 'text/plain', body: 'boom' }),
    );
    await loadLocalAlignment(page);
    await page.waitForLoadState('networkidle');

    await expect
      .poll(() => page.locator(SEL).count(), { timeout: 20_000 })
      .toBe(0);
    // No waveforms either — this is the failure path, not a silent success.
    expect(await page.locator('#waveforms .waveform').count()).toBe(0);
  });

  // 30.4 A row that is loading must be legible. This passes without the reserved
  // height too — once WaveSurfer is created it sizes the row itself — so it is a
  // guard on the loading state, not a control for the CSS. 30.5 is the control.
  //
  // Needs an alignment WITHOUT peaks: with peaks WaveSurfer reaches "ready" from
  // them alone and hides the overlay immediately, so no row stays pending.
  test('30.4 a waveform still loading shows a full-height row with a visible spinner', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.route('**/static/test/audio-*.mp3', async (route) => {
      await new Promise((r) => setTimeout(r, 15_000)); // outlive the assertions
      await route.abort();
    });
    loadLocalAlignment(page, 'alignment-no-peaks.json').catch(() => {});
    await page.waitForSelector('#waveforms .waveform', { timeout: 60_000 });

    const rows = await page.evaluate(() =>
      [...document.querySelectorAll('#waveforms .waveform')].slice(0, 3).map((r) => {
        const ov = r.querySelector('.wf-resize-overlay') as HTMLElement | null;
        return {
          rowH: Math.round(r.getBoundingClientRect().height),
          overlayH: ov ? Math.round(ov.getBoundingClientRect().height) : 0,
        };
      }),
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      // Reserved height, not the ~2px a bare bordered div collapses to.
      expect(r.rowH, `row collapsed: ${JSON.stringify(r)}`).toBeGreaterThan(100);
      // And the overlay has room, so its spinner is actually on screen.
      expect(r.overlayH, `overlay collapsed: ${JSON.stringify(r)}`).toBeGreaterThan(100);
    }
  });

  // 30.5 The control for the reserved height, and the state that actually caused
  // the reported jarring: a row is appended BEFORE its WaveSurfer exists (creation
  // waits on an await, and with 55 recordings that queue is long). In that window
  // the row has no content of its own, so without a reserved height it collapsed
  // to its border — measured at 2px — and dozens of them popped to full height one
  // by one as their turn came. Asserted directly on a bare row so there is no race.
  test('30.5 a waveform row reserves its height before any content exists', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await loadLocalAlignment(page);
    const bareHeight = await page.evaluate(() => {
      const d = document.createElement('div');
      d.className = 'waveform';
      document.getElementById('waveforms')!.appendChild(d);
      const h = Math.round(d.getBoundingClientRect().height);
      d.remove();
      return h;
    });
    expect(bareHeight, 'an empty .waveform row must hold its space').toBeGreaterThan(100);
  });
});
