import { test, expect } from '../support/fixtures';
import type { Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Section 54 — Staying within a pod host's request limit
// ---------------------------------------------------------------------------
// solidcommunity.net answers over-limit requests with 429 and NO CORS header,
// so the browser reports them as a bare TypeError. app/static/js/solid-fetch.js
// keeps the limit in advance (per host, sliding window) and retries what
// failed after a cool-down; the post prewarm no longer fires a request per
// recording after login.
//
// 54.1–54.8 drive the limiter directly in the page with a fake clock and a
// fake `sleep` that advances it, so a 10 s window costs no wall-clock time.
// 54.9 checks the prewarm against a mocked pod, and 54.10–54.11 count the
// requests of a post to one. None needs a real pod.

const LIMITED = 'https://listenhere.solidcommunity.net/at.ac.mdw.mei-friend/';
const FREE = 'https://pod.example/';

/** Run `body` in the page with { createLimitedFetch, clock, ... } in scope. */
async function inPage<T>(page: Page, body: string, arg?: unknown): Promise<T> {
  return page.evaluate(
    async ({ body, arg }) => {
      const mod = await import('/static/js/solid-fetch.js');
      let t = 0;
      const clock = {
        now: () => t,
        sleep: async (ms: number) => { t += ms; },
        advance: (ms: number) => { t += ms; },
      };
      const calls: { url: string; method: string; t: number }[] = [];
      const ok = (status = 200, headers: Record<string, string> = {}) =>
        new Response('', { status, headers });
      // eslint-disable-next-line no-new-func
      const fn = new Function('mod', 'clock', 'calls', 'ok', 'arg', `return (async () => { ${body} })();`);
      return fn(mod, clock, calls, ok, arg);
    },
    { body, arg },
  ) as Promise<T>;
}

test.describe('54. Request limit for pod hosts', () => {

  test('54.1 a host without a limit passes straight through', async ({ loadedPage: page }) => {
    const r = await inPage<{ calls: number; slept: number }>(page, `
      let slept = 0;
      const f = mod.createLimitedFetch(async (u) => { calls.push({ url: u, t: clock.now() }); return ok(); },
        { now: clock.now, sleep: async (ms) => { slept += ms; await clock.sleep(ms); } });
      await Promise.all(Array.from({ length: 30 }, (_, i) => f('${FREE}x' + i, { method: 'HEAD' })));
      return { calls: calls.length, slept };
    `);
    expect(r).toEqual({ calls: 30, slept: 0 });
  });

  test('54.2 a limited host gets at most 8 requests in any 10 s, and all 20 are answered', async ({ loadedPage: page }) => {
    const r = await inPage<{ n: number; maxInWindow: number; ts: number[] }>(page, `
      const f = mod.createLimitedFetch(async (u, o) => { calls.push({ url: u, t: clock.now() }); return ok(); },
        { now: clock.now, sleep: clock.sleep });
      const res = await Promise.all(Array.from({ length: 20 }, (_, i) => f('${LIMITED}d' + i, { method: 'HEAD' })));
      const ts = calls.map((c) => c.t);
      let maxInWindow = 0;
      for (const t0 of ts) maxInWindow = Math.max(maxInWindow, ts.filter((t) => t >= t0 && t < t0 + 10000).length);
      return { n: res.filter((x) => x.ok).length, maxInWindow, ts };
    `);
    expect(r.n).toBe(20);
    expect(r.maxInWindow).toBeLessThanOrEqual(8);
    // 20 requests at 8 per 10 s need two full windows: the last waits for the third.
    expect(Math.max(...r.ts)).toBeGreaterThanOrEqual(20000);
  });

  test('54.3 a readable 429 waits for Retry-After and tries again', async ({ loadedPage: page }) => {
    const r = await inPage<{ status: number; ts: number[] }>(page, `
      let first = true;
      const f = mod.createLimitedFetch(async (u) => {
        calls.push({ url: u, t: clock.now() });
        if (first) { first = false; return ok(429, { 'Retry-After': '3' }); }
        return ok();
      }, { now: clock.now, sleep: clock.sleep });
      const resp = await f('${LIMITED}a', { method: 'HEAD' });
      return { status: resp.status, ts: calls.map((c) => c.t) };
    `);
    expect(r.status).toBe(200);
    expect(r.ts).toHaveLength(2);
    expect(r.ts[1] - r.ts[0]).toBeGreaterThanOrEqual(3000);
  });

  test('54.4 a bare TypeError (a CORS-hidden 429) is retried after the window, then succeeds', async ({ loadedPage: page }) => {
    const r = await inPage<{ status: number; ts: number[] }>(page, `
      let n = 0;
      const f = mod.createLimitedFetch(async (u) => {
        calls.push({ url: u, t: clock.now() });
        if (n++ < 1) throw new TypeError('NetworkError when attempting to fetch resource.');
        return ok();
      }, { now: clock.now, sleep: clock.sleep });
      const resp = await f('${LIMITED}a', { method: 'PUT', body: '{}' });
      return { status: resp.status, ts: calls.map((c) => c.t) };
    `);
    expect(r.status).toBe(200);
    expect(r.ts).toHaveLength(2);
    expect(r.ts[1] - r.ts[0]).toBeGreaterThanOrEqual(10000);
  });

  test('54.5 a persistent TypeError is rethrown after 3 attempts', async ({ loadedPage: page }) => {
    const r = await inPage<{ name: string; attempts: number }>(page, `
      const f = mod.createLimitedFetch(async (u) => { calls.push({ url: u, t: clock.now() }); throw new TypeError('down'); },
        { now: clock.now, sleep: clock.sleep });
      try { await f('${LIMITED}a', { method: 'HEAD' }); } catch (e) { return { name: e.name, attempts: calls.length }; }
      return { name: 'none', attempts: calls.length };
    `);
    expect(r).toEqual({ name: 'TypeError', attempts: 3 });
  });

  test('54.6 a POST is never repeated', async ({ loadedPage: page }) => {
    const r = await inPage<{ name: string; attempts: number }>(page, `
      const f = mod.createLimitedFetch(async (u) => { calls.push({ url: u, t: clock.now() }); throw new TypeError('down'); },
        { now: clock.now, sleep: clock.sleep });
      try { await f('${LIMITED}a', { method: 'POST', body: '{}' }); } catch (e) { return { name: e.name, attempts: calls.length }; }
      return { name: 'none', attempts: calls.length };
    `);
    expect(r).toEqual({ name: 'TypeError', attempts: 1 });
  });

  test('54.7 something that is not a URL is left to the real fetch', async ({ loadedPage: page }) => {
    const r = await inPage<{ msg: string }>(page, `
      const f = mod.createLimitedFetch(async (u) => { throw new Error('base saw ' + u); },
        { now: clock.now, sleep: clock.sleep });
      try { await f('undefinedhttps%3A%2F%2Fexample', { method: 'HEAD' }); } catch (e) { return { msg: e.message }; }
      return { msg: 'none' };
    `);
    expect(r.msg).toBe('base saw undefinedhttps%3A%2F%2Fexample');
  });

  test('54.8 withLimitedFetch limits fetch only; the rest of the library passes through', async ({ loadedPage: page }) => {
    const r = await inPage<{ sameSession: boolean; fetchLimited: boolean }>(page, `
      const lib = { fetch: async (u) => { calls.push({ url: u, t: clock.now() }); return ok(); }, getDefaultSession: () => 'S' };
      const w = mod.withLimitedFetch(lib, { now: clock.now, sleep: clock.sleep });
      await Promise.all(Array.from({ length: 9 }, (_, i) => w.fetch('${LIMITED}x' + i, { method: 'HEAD' })));
      return { sameSession: w.getDefaultSession() === 'S', fetchLimited: calls[8].t >= 10000 };
    `);
    expect(r).toEqual({ sameSession: true, fetchLimited: true });
  });

  // 54.9 Signing in prewarms the containers, and no discovery resource per recording.
  test('54.9 the post prewarm after login asks for the containers only', async ({ loadedPage: page }) => {
    const POD = 'https://pod.example/';
    const WEBID_DOC = POD + 'profile/card';
    const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' };
    const seen: string[] = [];
    await page.route(POD + '**', async (route) => {
      const req = route.request();
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
      seen.push(req.method() + ' ' + req.url());
      if (req.url() === WEBID_DOC) {
        return route.fulfill({
          status: 200, contentType: 'application/ld+json', headers: CORS,
          body: JSON.stringify([{ '@id': POD + 'profile/card#me', 'http://www.w3.org/ns/pim/space#storage': [{ '@id': POD }] }]),
        });
      }
      return route.fulfill({ status: 200, headers: CORS, body: '' });
    });

    // The old prewarm asked for one discovery resource per http(s) recording.
    const recordings = await page.evaluate(async () => {
      const m = await import('/static/js/listen.js');
      const audio = (m.loadedAlignmentJSON as any)?.body?.audio ?? {};
      return Object.keys(audio).filter((f) => /^https?:\/\//i.test(m.getAudioLinkedDataUri(f) || '')).length;
    });
    expect(recordings, 'the fixture has recordings with web URIs, so this test can tell').toBeGreaterThan(1);

    await page.evaluate(() => {
      const sca = (window as any).solidClientAuthentication;
      const s = (sca.default || sca).getDefaultSession();
      s.info.isLoggedIn = true;
      s.info.webId = 'https://pod.example/profile/card#me';
      document.dispatchEvent(new CustomEvent('solid-auth-changed'));
    });
    await expect.poll(() => seen.filter((s) => s.startsWith('HEAD ')).length, { timeout: 10_000 }).toBeGreaterThan(0);
    await page.waitForTimeout(500);

    const heads = seen.filter((s) => s.startsWith('HEAD '));
    expect(heads.filter((s) => s.includes('/discovery/') && !s.endsWith('/discovery/'))).toEqual([]);
  });

  // 54.10 / 54.11 Posting costs no HEAD per recording: a discovery resource's
  // URI is derived, and the GET that patches it creates it when it is missing.
  const POD2 = 'https://pod.example/';
  const DISC = POD2 + 'at.ac.mdw.mei-friend/discovery/';

  /** A mocked pod that records requests and keeps what is PUT. */
  async function podWithDiscovery(page: Page, existingDiscovery: boolean) {
    const CORS = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': '*',
      'Access-Control-Expose-Headers': 'ETag',
    };
    const log: string[] = [];
    const store = new Map<string, any>();
    await page.route(POD2 + '**', async (route) => {
      const req = route.request();
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
      const url = req.url();
      log.push(req.method() + ' ' + url);
      const json = (body: unknown, status = 200) =>
        route.fulfill({ status, contentType: 'application/ld+json', headers: { ...CORS, ETag: '"1"' }, body: JSON.stringify(body) });
      if (url === POD2 + 'profile/card') {
        return json([{ '@id': POD2 + 'profile/card#me', 'http://www.w3.org/ns/pim/space#storage': [{ '@id': POD2 }] }]);
      }
      const isDiscoveryResource = url.startsWith(DISC) && url !== DISC;
      if (req.method() === 'PUT') {
        store.set(url, JSON.parse(req.postData() || '{}'));
        return route.fulfill({ status: 201, headers: CORS, body: '' });
      }
      if (req.method() === 'GET' && isDiscoveryResource) {
        if (store.has(url)) return json(store.get(url));
        if (existingDiscovery) {
          return json({ '@id': url, '@type': 'https://schema.org/DataCatalog', 'https://schema.org/dataset': [] });
        }
        return route.fulfill({ status: 404, headers: CORS, body: '' });
      }
      if (req.method() === 'HEAD' && isDiscoveryResource && !existingDiscovery && !store.has(url)) {
        return route.fulfill({ status: 404, headers: CORS, body: '' });
      }
      return route.fulfill({ status: 200, headers: CORS, body: '' });
    });
    return { log, store };
  }

  async function postToTwoRecordings(page: Page) {
    return page.evaluate(async () => {
      const sca = (window as any).solidClientAuthentication;
      const s = (sca.default || sca).getDefaultSession();
      s.info.isLoggedIn = true;
      s.info.webId = 'https://pod.example/profile/card#me';
      const v6 = (window as any).__annotationV6;
      const files = Object.keys(((await import('/static/js/listen.js')) as any).loadedAlignmentJSON.body.audio).slice(0, 2);
      const id = v6.state.createAnnotation({ label: 'rate test' });
      v6.state.addRegion(id, files[0], 1, 2);
      v6.state.addTarget(id, files[1]);
      await v6.postAnnotationToSolid(id);
      return files.length;
    });
  }

  test('54.10 a post to two recordings whose discovery resources are new: no HEAD per recording; each is created by one GET and one PUT', async ({ loadedPage: page }) => {
    const { log, store } = await podWithDiscovery(page, false);
    expect(await postToTwoRecordings(page)).toBe(2);

    const perRecording = log.filter((r) => r.includes(DISC + 'https'));
    expect(perRecording.filter((r) => r.startsWith('HEAD '))).toEqual([]);
    expect(perRecording.filter((r) => r.startsWith('GET ')), 'one GET per recording').toHaveLength(2);
    expect(perRecording.filter((r) => r.startsWith('PUT ')), 'one creating PUT per recording').toHaveLength(2);
    // The discovery container is checked once (with the other containers), not once per recording.
    expect(log.filter((r) => r === 'HEAD ' + DISC)).toHaveLength(1);
    // What was created is a discovery catalogue that lists the new annotation.
    const created = [...store.entries()].filter(([u]) => u.startsWith(DISC + 'https'));
    expect(created).toHaveLength(2);
    for (const [, doc] of created) {
      expect(doc['@type']).toBe('https://schema.org/DataCatalog');
      expect(JSON.stringify(doc['https://schema.org/dataset'])).toContain('MusicalMaterial');
    }
  });

  test('54.11 a post to two recordings whose discovery resources exist: one GET and one PUT each, and no HEAD', async ({ loadedPage: page }) => {
    const { log, store } = await podWithDiscovery(page, true);
    expect(await postToTwoRecordings(page)).toBe(2);

    const perRecording = log.filter((r) => r.includes(DISC + 'https'));
    expect(perRecording.filter((r) => r.startsWith('HEAD '))).toEqual([]);
    expect(perRecording.filter((r) => r.startsWith('GET '))).toHaveLength(2);
    expect(perRecording.filter((r) => r.startsWith('PUT '))).toHaveLength(2);
    const patched = [...store.entries()].filter(([u]) => u.startsWith(DISC + 'https'));
    expect(patched).toHaveLength(2);
    for (const [, doc] of patched) {
      expect(JSON.stringify(doc['https://schema.org/dataset'])).toContain('MusicalMaterial');
    }
  });
});
