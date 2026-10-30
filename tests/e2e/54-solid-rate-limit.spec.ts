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

  // 54.12–54.13 A request that waits for its turn must not be timed out, or kept
  // in the queue, as if it were being sent: a long queue made the loader's 15 s
  // timeout abort requests that had never left it, so a listing of 20 sources
  // failed for all of them.
  test('54.12 a queued request whose signal aborts leaves the queue without sending or taking a slot', async ({ loadedPage: page }) => {
    const r = await page.evaluate(async (limited) => {
      const mod = await import('/static/js/solid-fetch.js');
      const sent: string[] = [];
      const pending: (() => void)[] = [];
      let t = 0;
      const f = mod.createLimitedFetch(async (u: string) => { sent.push(u); return new Response('', { status: 200 }); },
        { now: () => t, sleep: () => new Promise<void>((res) => pending.push(res)) });
      const first = Array.from({ length: 8 }, (_, i) => f(limited + 'a' + i, { method: 'HEAD' }));
      await Promise.all(first);
      const ctrl = new AbortController();
      const queued = f(limited + 'aborted', { method: 'HEAD', signal: ctrl.signal }).then(() => 'sent', (e: any) => e.name);
      await new Promise((r) => setTimeout(r, 20));
      ctrl.abort();
      const outcome = await queued; // settles at once, without the window opening
      t += 10000;
      pending.splice(0).forEach((res) => res());
      await f(limited + 'next', { method: 'HEAD' });
      return { outcome, sent: sent.length, abortedSent: sent.includes(limited + 'aborted') };
    }, LIMITED);
    expect(r).toEqual({ outcome: 'AbortError', sent: 9, abortedSent: false });
  });

  test('54.13 timeoutMs counts from the send: a request still waiting is not timed out, one that was sent is', async ({ loadedPage: page }) => {
    const r = await page.evaluate(async (limited) => {
      const mod = await import('/static/js/solid-fetch.js');
      const pending: (() => void)[] = [];
      let t = 0;
      let sentAt = 0;
      const base = (u: string, init: any) => new Promise<Response>((res, rej) => {
        if (u.endsWith('slow')) {
          sentAt = Date.now();
          init.signal.addEventListener('abort', () => rej(init.signal.reason));
          return; // never answers
        }
        res(new Response('', { status: 200 }));
      });
      const f = mod.createLimitedFetch(base as any,
        { now: () => t, sleep: () => new Promise<void>((res) => pending.push(res)) });
      await Promise.all(Array.from({ length: 8 }, (_, i) => f(limited + 'a' + i, { method: 'HEAD' })));
      const slow = f(limited + 'slow', { method: 'GET', timeoutMs: 80 }).then(() => 'answered', (e: any) => e.name);
      let settledEarly = false;
      slow.then(() => { settledEarly = true; });
      await new Promise((res) => setTimeout(res, 250)); // three times the timeout, still in the queue
      const whileQueued = settledEarly;
      t += 10000;
      pending.splice(0).forEach((res) => res());
      const outcome = await slow;
      return { whileQueued, outcome, afterSend: Date.now() - sentAt };
    }, LIMITED);
    expect(r.whileQueued, 'not timed out while queued').toBe(false);
    expect(r.outcome).toBe('TimeoutError');
    expect(r.afterSend).toBeGreaterThanOrEqual(70);
  });

  test('54.14 a host without a limit also gets its timeoutMs', async ({ loadedPage: page }) => {
    const outcome = await page.evaluate(async (free) => {
      const mod = await import('/static/js/solid-fetch.js');
      const f = mod.createLimitedFetch(((u: string, init: any) => new Promise((_, rej) => {
        init.signal.addEventListener('abort', () => rej(init.signal.reason));
      })) as any);
      return f(free + 'x', { timeoutMs: 50 }).then(() => 'answered', (e: any) => e.name);
    }, FREE);
    expect(outcome).toBe('TimeoutError');
  });

  // 54.15 A listing fans out one call per recording, each needing the profile.
  test('54.15 twenty concurrent callers share one fetch of the profile card', async ({ loadedPage: page }) => {
    const POD = 'https://pod.example/';
    const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' };
    const cards: string[] = [];
    await page.route(POD + '**', async (route) => {
      const req = route.request();
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
      if (req.url() === POD + 'profile/card') {
        cards.push(req.method());
        await new Promise((r) => setTimeout(r, 100)); // slow enough that all callers arrive first
        return route.fulfill({ status: 200, contentType: 'application/ld+json', headers: CORS, body: JSON.stringify([
          { '@id': POD + 'profile/card#me', 'http://www.w3.org/ns/pim/space#storage': [{ '@id': POD }] },
        ]) });
      }
      return route.fulfill({ status: 404, headers: CORS, body: '' });
    });
    const storages = await page.evaluate(async () => {
      const sca = (window as any).solidClientAuthentication;
      const s = (sca.default || sca).getDefaultSession();
      s.info.isLoggedIn = true;
      s.info.webId = 'https://pod.example/profile/card#me';
      const m = await import('/static/js/solid.js');
      return Promise.all(Array.from({ length: 20 }, () => m.getSolidStorage()));
    });
    expect(storages.every((s: string) => s === POD)).toBe(true);
    expect(cards, 'one GET of the card').toEqual(['GET']);
  });

  // 54.16 / 54.17 Listing asks the pod which discovery resources exist (one
  // request) instead of GETting one per recording to learn that most are 404.
  const LPOD = 'https://pod.example/';
  const LDISC = LPOD + 'at.ac.mdw.mei-friend/discovery/';
  const LDP_CONTAINS = 'http://www.w3.org/ns/ldp#contains';

  async function listingPod(page: Page, listing: 'ok' | 'error' | 'unrelated', existsFor: string[]) {
    const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' };
    const log: string[] = [];
    const MM = LPOD + 'at.ac.mdw.mei-friend/mao/musicalMaterial/ann1/mm1';
    await page.route(LPOD + '**', async (route) => {
      const req = route.request();
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
      const url = req.url();
      log.push(req.method() + ' ' + url);
      const json = (body: unknown, status = 200) =>
        route.fulfill({ status, contentType: 'application/ld+json', headers: CORS, body: JSON.stringify(body) });
      if (url === LPOD + 'profile/card') {
        return json([{ '@id': LPOD + 'profile/card#me', 'http://www.w3.org/ns/pim/space#storage': [{ '@id': LPOD }] }]);
      }
      if (url === LDISC) {
        if (listing === 'error') return route.fulfill({ status: 500, headers: CORS, body: '' });
        // As Community Solid Server writes it: the container is TWO nodes with one @id (its types, and
        // its ldp:contains), and a child is named in another percent-encoding from the one it was PUT
        // under (`https%3A` is listed as `https%253A`), though the server resolves either.
        const named = listing === 'unrelated' ? ['https://example.org/unrelated.wav'] : existsFor;
        return json([
          { '@id': LDISC, '@type': ['http://www.w3.org/ns/ldp#Container', 'http://www.w3.org/ns/ldp#BasicContainer'] },
          { '@id': LDISC, [LDP_CONTAINS]: named.map((u) => ({ '@id': LDISC + encodeURIComponent(u).replace(/%3A/g, '%253A') })) },
        ]);
      }
      const hit = existsFor.find((u) => url === LDISC + encodeURIComponent(u));
      if (hit) {
        return json([{
          '@id': url,
          'https://schema.org/dataset': [{
            '@type': ['https://schema.org/Dataset'],
            'https://schema.org/additionalType': [{ '@id': 'https://domestic-beethoven.eu/ontology/1.0/music-annotation-ontology.ttl#MusicalMaterial' }],
            'https://schema.org/url': [{ '@id': MM }],
            'https://schema.org/name': 'listed annotation',
            'https://schema.org/dateCreated': '2026-10-30T10:00:00.000Z',
          }],
        }]);
      }
      return route.fulfill({ status: 404, headers: CORS, body: '' });
    });
    return { log, MM };
  }

  async function sourcesOf(page: Page): Promise<string[]> {
    return page.evaluate(async () => {
      const m = (await import('/static/js/listen.js')) as any;
      return Object.keys(m.loadedAlignmentJSON.body.audio).map((f: string) => m.getAudioLinkedDataUri(f)).filter(Boolean);
    });
  }

  async function listAll(page: Page) {
    return page.evaluate(async () => {
      const sca = (window as any).solidClientAuthentication;
      const s = (sca.default || sca).getDefaultSession();
      s.info.isLoggedIn = true;
      s.info.webId = 'https://pod.example/profile/card#me';
      return (window as any).__annotationV6.listAnnotationsForLoadedAudios();
    });
  }

  test('54.16 listing reads the discovery container once and fetches only the discovery resources it names', async ({ loadedPage: page }) => {
    const sources = await sourcesOf(page);
    expect(sources.length).toBeGreaterThan(2);
    const { log, MM } = await listingPod(page, 'ok', [sources[0]]);
    const r = await listAll(page);

    expect(r.errors).toEqual([]);
    expect(r.entries.map((e: any) => e.mmUri)).toEqual([MM]);
    const gets = log.filter((l) => l.startsWith('GET '));
    expect(gets.filter((l) => l === 'GET ' + LDISC), 'the container, once').toHaveLength(1);
    expect(gets.filter((l) => l.startsWith('GET ' + LDISC + 'http')), 'only the one it lists').toHaveLength(1);
  });

  test('54.19 a non-empty listing that names none of the sources is not believed: every source is read', async ({ loadedPage: page }) => {
    const sources = await sourcesOf(page);
    const { log, MM } = await listingPod(page, 'unrelated', [sources[0]]);
    const r = await listAll(page);

    // The listing could be a naming mismatch as easily as a pod with nothing for these, so each is asked for.
    expect(r.errors).toEqual([]);
    expect(r.entries.map((e: any) => e.mmUri)).toEqual([MM]);
    const perSource = log.filter((l) => l.startsWith('GET ' + LDISC + 'http'));
    expect(perSource.length).toBeGreaterThanOrEqual(sources.length);
  });

  test('54.17 if the container cannot be listed, listing falls back to one request per recording', async ({ loadedPage: page }) => {
    const sources = await sourcesOf(page);
    const { log, MM } = await listingPod(page, 'error', [sources[0]]);
    const r = await listAll(page);

    expect(r.errors).toEqual([]);
    expect(r.entries.map((e: any) => e.mmUri)).toEqual([MM]);
    const perSource = log.filter((l) => l.startsWith('GET ' + LDISC + 'http'));
    expect(perSource.length).toBeGreaterThanOrEqual(sources.length);
  });

  // 54.18 The failure as it was seen: 30 reads queue behind the limiter for far
  // longer than the loader's 15 s read timeout, and all must still be answered.
  // The clock is faked, so a minute of waiting takes a couple of seconds.
  test('54.18 reads queued behind the limiter for longer than the loader\'s read timeout all complete', async ({ loadedPage: page }) => {
    const HOST = 'https://listenhere.solidcommunity.net/';
    const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' };
    let gets = 0;
    await page.route(HOST + '**', async (route) => {
      const req = route.request();
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
      if (req.url() === HOST + 'profile/card') {
        return route.fulfill({ status: 200, contentType: 'application/ld+json', headers: CORS, body: JSON.stringify([
          { '@id': HOST + 'profile/card#me', 'http://www.w3.org/ns/pim/space#storage': [{ '@id': HOST }] },
        ]) });
      }
      gets++;
      return route.fulfill({ status: 404, headers: CORS, body: '' });
    });
    await page.clock.install();
    const done = page.evaluate(async () => {
      const sca = (window as any).solidClientAuthentication;
      const s = (sca.default || sca).getDefaultSession();
      s.info.isLoggedIn = true;
      s.info.webId = 'https://listenhere.solidcommunity.net/profile/card#me';
      const m = await import('/static/js/annotation/solid-load.js');
      const results = await Promise.allSettled(
        Array.from({ length: 30 }, (_, i) => m.listAnnotationsForAudio('https://example.org/recording-' + i + '.wav')),
      );
      return results.map((r) => (r.status === 'fulfilled' ? 'ok' : String((r as any).reason?.name || r.reason)));
    });
    let finished = false;
    done.then(() => { finished = true; });
    for (let i = 0; i < 400 && !finished; i++) {
      await page.clock.runFor(1000);
      await page.waitForTimeout(25);
    }
    const outcomes = await done;
    expect(outcomes.filter((o) => o !== 'ok'), 'every source answered').toEqual([]);
    expect(gets, 'one GET per recording').toBe(30);
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
