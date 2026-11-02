// 29. Honest reporting when the score MEI cannot be loaded
//
// The score-synthesis path used to hand whatever the MEI fetch returned straight
// to Verovio. An HTTP error page, a rate-limit notice, or a 404 from a mistyped
// path all parse to a document with no MEI root, produce zero notes, and finally
// surfaced as "⚠ Synthesis failed: synthesis produced no audio" — blaming the
// last step for the first one's failure and sending debugging to the wrong place.
// Nothing upstream could raise instead: parseFromString does not throw on
// malformed input and Verovio's loadData only logs.
//
// Prompted by a real incident (a ~9h GitHub outage served 429s for the MEI). The
// deliberate decision was NOT to add a CDN or proxy — museum alignments will point
// at locally-hosted MEIs — so what remains is that the message must tell the truth.
// It matters just as much for local hosting: a wrong local path fails identically.
import { test, expect } from '../support/fixtures';
import { loadLocalAlignment, waitForWaveformsReady, FIXTURES_DIR as FIXTURES } from '../support/helpers';
import fs from 'fs';
import path from 'path';

const SCORE_KEY = 'Score (synthesised from MEI)';
// The score fixture is served locally (see tests/fixtures/alignment.json);
// intercept that URL to simulate a failing score source.
const MEI_GLOB = '**/static/test/*.mei';

/** Overlay status text on the score waveform. */
async function scoreOverlayText(page: import('@playwright/test').Page): Promise<string> {
  return page.evaluate((key: string) => {
    const wfEl = document.querySelector(`.waveform[data-ix='${key}']`);
    const status = wfEl?.querySelector('.wf-overlay-status');
    return status?.textContent ?? '';
  }, SCORE_KEY);
}

/**
 * Serve `body`/`status` for the score MEI, then load the alignment.
 *
 * The route must be registered before navigating, because the fetch happens
 * during load — and after loadLocalAlignment's own stub, since Playwright
 * prefers the most recently registered matching handler.
 */
async function loadWithMei(
  page: import('@playwright/test').Page,
  status: number,
  body: string,
  contentType = 'text/plain',
) {
  await loadLocalAlignment(page);
  await page.route(MEI_GLOB, (route) => route.fulfill({ status, contentType, body }));
  await page.reload();
  await page.waitForLoadState('networkidle');
}

test.describe('29. Score source failures are reported honestly', () => {
  // 29.1 The incident itself: an HTTP error must be named as one.
  test('29.1 an HTTP error from the score source is reported, not blamed on synthesis', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await loadWithMei(page, 429, '429: Too Many Requests');

    await expect
      .poll(() => scoreOverlayText(page), { timeout: 30_000 })
      .toContain('Score unavailable');

    const text = await scoreOverlayText(page);
    expect(text).toContain('429');
    expect(text).not.toContain('produced no audio');
  });

  // 29.2 A 200 that is not MEI (a proxy login page, an HTML 404 served as 200)
  // has to be caught by sniffing the body, since the status looks fine.
  test('29.2 a non-XML 200 response is reported as not-MEI', async ({ page }) => {
    test.setTimeout(120_000);
    await loadWithMei(
      page,
      200,
      '<!DOCTYPE html><html><head><title>Not Found</title></head><body>nope</body></html>',
      'text/html',
    );

    await expect
      .poll(() => scoreOverlayText(page), { timeout: 30_000 })
      .toContain('Score unavailable');

    const text = await scoreOverlayText(page);
    expect(text).toContain('did not return MEI XML');
    expect(text).not.toContain('produced no audio');
  });

  // 29.3 The guard must not fire on a good MEI: the score waveform still
  // synthesises and reports no error. Without this, 29.1/29.2 could be satisfied
  // by a change that simply broke score synthesis outright.
  test('29.3 a valid MEI still synthesises, with no error reported', async ({
    loadedPage: page,
  }) => {
    test.setTimeout(120_000);
    await waitForWaveformsReady(page);

    await expect(page.locator(`.waveform[data-ix="${SCORE_KEY}"]`)).toBeAttached();

    // Synthesis must actually finish — the score key reaching `loaded` means its
    // WaveSurfer instance fired "ready" on real synthesised audio. Checking only
    // for the absence of an error string would also pass if synthesis silently
    // stopped happening at all.
    await expect
      .poll(
        () => page.evaluate(() => (window as any)._listenTest.loaded),
        { timeout: 60_000 },
      )
      .toContain(SCORE_KEY);

    const text = await scoreOverlayText(page);
    expect(text).not.toContain('Score unavailable');
    expect(text).not.toContain('produced no audio');
  });

  // 29.4 The structural half of the bug. tk.renderToMIDI() was the last unguarded
  // call in setGrids, so when Verovio was not ready the throw skipped the auto-load
  // below it and NO waveform appeared — the score's problem cost every recording.
  // Firefox lost that race routinely (Chrome happened to win it), which is why
  // scenario 2.1 was red there. Losing the score must cost only the score.
  test('29.4 recordings still load when Verovio is unavailable', async ({ page }) => {
    test.setTimeout(120_000);
    await page.route('**/js/verovio-toolkit-wasm.js', (route) =>
      route.fulfill({ status: 404, contentType: 'text/plain', body: 'gone' }),
    );
    await loadLocalAlignment(page);
    await page.waitForLoadState('networkidle');

    // The recordings are what must survive.
    await expect
      .poll(
        () => page.evaluate(() => (window as any)._listenTest.loaded.length),
        { timeout: 45_000 },
      )
      .toBeGreaterThan(0);

    const loaded = await page.evaluate(() => (window as any)._listenTest.loaded);
    expect(loaded).toContain('audio-a.mp3');

    // And the score entry, if it rendered at all, must not claim synthesis failed.
    expect(await scoreOverlayText(page)).not.toContain('produced no audio');
  });
  // 29.5 Source invariant, no browser: the suite must not fetch anything
  //      off-machine. Fixtures used to point `meiUri` at raw.githubusercontent.com,
  //      and ~150 page loads per run tripped GitHub's rate limit (see 29.1). The
  //      MEI now ships in tests/fixtures/ and is served at /static/test/, so this
  //      guards the arrangement rather than trusting everyone to remember it.
  test('29.5 no test fixture fetches a resource from outside localhost', () => {
    // Fields whose value the app actually FETCHES. `linkedDataUriPrefix` is
    // deliberately excluded: it mints annotation identifiers and is never
    // dereferenced, so it legitimately carries a public https:// namespace.
    const FETCHED_FIELDS = ['meiUri', 'url', 'src', 'audioUri'];
    const offenders: string[] = [];

    const visit = (node: unknown, file: string, keyPath: string) => {
      if (Array.isArray(node)) {
        node.forEach((v, i) => visit(v, file, `${keyPath}[${i}]`));
      } else if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) {
          if (
            typeof v === 'string' &&
            FETCHED_FIELDS.includes(k) &&
            /^https?:\/\//.test(v) &&
            !/^https?:\/\/(localhost|127\.0\.0\.1)([:/]|$)/.test(v)
          ) {
            offenders.push(`${file}: ${keyPath}.${k} = ${v}`);
          }
          visit(v, file, `${keyPath}.${k}`);
        }
      }
    };

    for (const name of fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.json'))) {
      const raw = fs.readFileSync(path.join(FIXTURES, name), 'utf8');
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue; // alignment-malformed.json is unparseable on purpose
      }
      visit(parsed, name, '');
    }

    expect(offenders, `fixtures must be served locally:\n${offenders.join('\n')}`).toEqual([]);
  });
});
