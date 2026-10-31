import { test, expect } from '../support/fixtures';
import { env } from '../support/env';

// ---------------------------------------------------------------------------
// Section 57 — An ?align= URL is fetched by the browser only
// ---------------------------------------------------------------------------
// The server used to download the ?align= URL itself to validate it: any URL,
// file: and internal hosts included (a security pass, 2026-10-31, read
// file:///etc/hosts through it). Now it serves the page without looking at
// the URL; the browser fetches and validates the alignment
// (alignment-validate.js) and goes back to the landing page with the reason
// when it can't.

const landing = (u: string) => `/?align=${encodeURIComponent(u)}`;

test.describe('57. ?align= is fetched by the browser only', () => {

  test('57.1 the server serves the page without reading the URL, whatever it is', async ({ page }) => {
    for (const u of ['file:///etc/hosts', 'http://127.0.0.1:9/nothing.json', 'http://169.254.169.254/latest/meta-data/']) {
      const t0 = Date.now();
      const resp = await page.request.get(landing(u), { maxRedirects: 0 });
      const html = await resp.text();
      expect(resp.status(), u).toBe(200);
      expect(html, 'the listen page, not an error from fetching ' + u).toContain('var alignmentData = ' + JSON.stringify(u));
      expect(html).not.toContain('error-banner');
      expect(Date.now() - t0, 'no 15 s fetch attempt').toBeLessThan(5000);
    }
  });

  test('57.2 a file: URL ends on the landing page with a fetch error, and nothing throws', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(landing('file:///etc/hosts'));
    await expect(page.locator('#error-banner')).toContainText('Could not fetch alignment data');
    expect(errors).toEqual([]);
  });

  test('57.3 a missing alignment ends on the landing page with the server\'s status', async ({ page }) => {
    await page.goto(landing(`${env.baseUrl}/static/test/does-not-exist.json`));
    await expect(page.locator('#error-banner')).toContainText('the server answered 404');
  });

  test('57.4 something that isn\'t JSON ends on the landing page saying so', async ({ page }) => {
    await page.goto(landing(`${env.baseUrl}/static/test/audio-short.mp3`));
    await expect(page.locator('#error-banner')).toContainText('The URL did not return valid JSON');
  });

  test('57.5 an invalid alignment ends on the landing page with the validator\'s reason', async ({ page }) => {
    await page.goto(landing(`${env.baseUrl}/static/test/alignment-malformed.json`));
    await expect(page.locator('#error-banner')).toContainText("Invalid alignment data: Missing required 'body' field");
  });

  test('57.6 the browser\'s validator: the fixture passes, and its checks match the server\'s former ones', async ({ listenPage: page }) => {
    const r = await page.evaluate(async () => {
      const m = await import('/static/js/alignment-validate.js');
      const good = await (await fetch('/static/test/alignment.json')).json();
      const clone = () => JSON.parse(JSON.stringify(good));
      const noRef = clone(); noRef.header.ref = 'not-an-entry.mp3';
      const badTimes = clone(); const k = Object.keys(badTimes.body.audio)[0];
      const entry = badTimes.body.audio[k];
      if (Array.isArray(entry)) entry[0] = 'x'; else entry.times[0] = 'x';
      const scoreNoMei = clone(); delete scoreNoMei.header.meiUri; scoreNoMei.body.score = scoreNoMei.body.score || {};
      return {
        good: m.alignmentJsonProblem(good),
        array: m.alignmentJsonProblem([]),
        noRef: m.alignmentJsonProblem(noRef),
        badTimes: m.alignmentJsonProblem(badTimes),
        scoreNoMei: m.alignmentJsonProblem(scoreNoMei),
        key: k,
      };
    });
    expect(r.good).toBeNull();
    expect(r.array).toBe('Alignment data must be a JSON object');
    expect(r.noRef).toBe("'ref' must reference one of the audio entries");
    expect(r.badTimes).toMatch(new RegExp(`^Audio entry '${r.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`));
    expect(r.scoreNoMei).toBe("If 'score' is provided, 'meiUri' must also be provided (and vice versa)");
  });
});
