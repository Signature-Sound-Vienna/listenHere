import { test, expect } from '../support/fixtures';
import type { Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Section 56 — Signed-in requests go only to the user's own pod
// ---------------------------------------------------------------------------
// The auth library signs every request it is given, wherever it goes, and an
// annotation loaded from a link (?loadMM=) may name any address: someone
// else's server, or resources in the user's own pod. A security pass
// (2026-10-31) found that such an annotation drew a signed HEAD to its server
// as soon as it loaded, and that updating it gave the user's reply, in their
// own pod, the access its server reported (public). Two mocked pods here:
// the user's (pod.example) and someone else's (elsewhere.example).

const POD = 'https://pod.example/';
const ELSE = 'https://elsewhere.example/';
const FRIEND = 'at.ac.mdw.mei-friend/';
const DISC = POD + FRIEND + 'discovery/';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': '*',
  'Access-Control-Expose-Headers': 'ETag, Link, WAC-Allow',
};

interface Pods {
  log: string[];
  store: Map<string, string>;
}

/** Both pods; the other one says its resources are public and lets anyone write. */
async function twoPods(page: Page): Promise<Pods> {
  const pods: Pods = { log: [], store: new Map() };
  for (const origin of [POD, ELSE]) {
    await page.route(origin + '**', async (route) => {
      const req = route.request();
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
      const url = req.url();
      pods.log.push(req.method() + ' ' + url);
      if (url === POD + 'profile/card') {
        return route.fulfill({ status: 200, contentType: 'application/ld+json', headers: CORS,
          body: JSON.stringify([{ '@id': POD + 'profile/card#me', 'http://www.w3.org/ns/pim/space#storage': [{ '@id': POD }] }]) });
      }
      if (req.method() === 'PUT') { pods.store.set(url, req.postData() || ''); return route.fulfill({ status: 201, headers: CORS, body: '' }); }
      if (req.method() === 'DELETE') { pods.store.delete(url); return route.fulfill({ status: 204, headers: CORS, body: '' }); }
      const headers = {
        ...CORS, ETag: '"1"', Link: `<${url}.acl>; rel="acl"`,
        'WAC-Allow': url.startsWith(ELSE) ? 'user="read write",public="read"' : 'user="read write control",public=""',
      };
      if (pods.store.has(url)) {
        return route.fulfill({ status: 200, contentType: 'application/ld+json', headers, body: req.method() === 'HEAD' ? '' : pods.store.get(url)! });
      }
      if (url.endsWith('/')) return route.fulfill({ status: 200, headers, body: '' });
      return route.fulfill({ status: 404, headers: CORS, body: '' });
    });
  }
  return pods;
}

async function signIn(page: Page) {
  await page.evaluate(() => {
    const sca = (window as any).solidClientAuthentication;
    const s = (sca.default || sca).getDefaultSession();
    s.info.isLoggedIn = true;
    s.info.webId = 'https://pod.example/profile/card#me';
  });
}

/**
 * Post an annotation (with a note) to the user's pod, then host a copy of its
 * chain on the other server and forget the local one: what a shared link to
 * someone else's annotation would load. Returns the other server's MM URI.
 */
async function hostElsewhere(page: Page, pods: Pods): Promise<{ mm: string; files: string[] }> {
  await signIn(page);
  const own = await page.evaluate(async () => {
    const v6 = (window as any).__annotationV6;
    const files = Object.keys(((await import('/static/js/listen.js')) as any).loadedAlignmentJSON.body.audio).slice(0, 2);
    const id = v6.state.createAnnotation({ label: 'shared with you' });
    v6.state.addRegion(id, files[0], 1, 2);
    v6.state.addTarget(id, files[1]);
    v6.state.updateTargetNote(id, files[0], 'a note');
    await v6.postAnnotationToSolid(id);
    const uris = v6.state.getById(id).lastPostedUris;
    v6.state.removeAnnotation(id);
    return { uris, files };
  });
  const move = (s: string) => s.split(POD + FRIEND).join(ELSE + FRIEND);
  for (const u of Object.values(own.uris) as string[]) pods.store.set(move(u), move(pods.store.get(u)!));
  return { mm: move(own.uris.mm), files: own.files };
}

/** Load the other server's annotation, recording every request with whether the auth library sent it. */
async function loadElsewhere(page: Page, mm: string): Promise<string> {
  return page.evaluate(async (mm) => {
    const seen: { url: string; method: string; signed: boolean }[] = [];
    (window as any).__seen = seen;
    const real = window.fetch;
    window.fetch = ((input: any, init?: any) => {
      const url = typeof input === 'string' ? input : input.url;
      seen.push({ url, method: ((init && init.method) || 'GET').toUpperCase(), signed: /solid-client-authn/.test(new Error().stack || '') });
      return real.call(window, input, init);
    }) as typeof fetch;
    const v6 = (window as any).__annotationV6;
    return v6.loadAnnotationFromMM(mm);
  }, mm);
}

const seen = (page: Page) =>
  page.evaluate(() => (window as any).__seen.slice() as { url: string; method: string; signed: boolean }[]);

test.describe('56. Signed-in requests go only to the user\'s own pod', () => {

  test('56.1 a ?loadMM link asks first; Cancel fetches nothing, Load fetches it unsigned', async ({ listenPage: page }) => {
    const pods = await twoPods(page);
    const mm = ELSE + FRIEND + 'mao/musicalMaterial/f/s';
    await page.goto(page.url() + '&loadMM=' + encodeURIComponent(mm));
    await page.waitForFunction(() => ((window as any)._listenTest?.loadGeneration ?? 0) > 0, null, { timeout: 40_000 });
    await signIn(page);
    await page.evaluate(() => document.dispatchEvent(new CustomEvent('solid-auth-changed')));

    const dialog = page.locator('.lh-v6-confirm-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('elsewhere.example');
    await expect(dialog).toContainText(mm);
    expect(pods.log.filter((r) => r.includes(ELSE)), 'nothing fetched while asking').toEqual([]);

    await dialog.locator('.lh-v6-confirm-cancel').click();
    await page.waitForTimeout(300);
    expect(pods.log.filter((r) => r.includes(ELSE)), 'nothing fetched after Cancel').toEqual([]);
  });

  test('56.2 Load on a ?loadMM link fetches the annotation', async ({ listenPage: page }) => {
    const pods = await twoPods(page);
    const mm = ELSE + FRIEND + 'mao/musicalMaterial/f/s';
    await page.goto(page.url() + '&loadMM=' + encodeURIComponent(mm));
    await page.waitForFunction(() => ((window as any)._listenTest?.loadGeneration ?? 0) > 0, null, { timeout: 40_000 });
    await signIn(page);
    await page.evaluate(() => document.dispatchEvent(new CustomEvent('solid-auth-changed')));
    await page.locator('.lh-v6-confirm-dialog .lh-v6-confirm-caution-ok').click();
    await expect.poll(() => pods.log.filter((r) => r === 'GET ' + mm).length).toBeGreaterThan(0);
  });

  test('56.3 another pod\'s annotation draws no request to its server once loaded; its card says so', async ({ loadedPage: page }) => {
    const pods = await twoPods(page);
    const { mm } = await hostElsewhere(page, pods);
    pods.log.length = 0;
    await loadElsewhere(page, mm);
    await expect(page.locator('.lh-v6-access-status')).toHaveText('Not in your pod');
    await page.waitForTimeout(300);

    const requests = await seen(page);
    expect(requests.filter((r) => r.url.startsWith(ELSE) && r.signed), 'no signed request to that server').toEqual([]);
    expect(pods.log.filter((r) => r.startsWith('HEAD ' + ELSE)), 'no access check there').toEqual([]);
    expect(await page.evaluate((m) => (window as any).__annotationV6.getAnnotationAccess({ mm: m }), mm))
      .toMatchObject({ state: 'foreign' });
  });

  test('56.4 updating another pod\'s annotation is refused before any request; the user\'s pod gets no reply and no ACL', async ({ loadedPage: page }) => {
    const pods = await twoPods(page);
    const { mm, files } = await hostElsewhere(page, pods);
    const id = await loadElsewhere(page, mm);
    pods.log.length = 0;
    const err = await page.evaluate(async ({ id, file }) => {
      (window as any).__seen.length = 0;
      const v6 = (window as any).__annotationV6;
      v6.state.updateTargetNote(id, file, 'my reply');
      try { await v6.updateAnnotationOnSolid(id); return 'updated'; } catch (e: any) { return e.message; }
    }, { id, file: files[0] });

    expect(err).toContain('isn\'t in your pod (elsewhere.example)');
    expect(pods.log.filter((r) => !r.startsWith('GET ') && !r.startsWith('HEAD ')), 'no write anywhere').toEqual([]);
    expect([...pods.store.keys()].filter((u) => u.endsWith('.acl')), 'no ACL').toEqual([]);
  });

  test('56.5 access is neither set on another pod nor copied from it into the user\'s', async ({ loadedPage: page }) => {
    const pods = await twoPods(page);
    const { mm } = await hostElsewhere(page, pods);
    await loadElsewhere(page, mm);
    pods.log.length = 0;
    const r = await page.evaluate(async (mm) => {
      const v6 = (window as any).__annotationV6;
      const a = v6.state.getAll().find((x: any) => x.lastPostedUris && x.lastPostedUris.mm === mm);
      let set = 'set';
      try { await v6.setAnnotationAccess(a.lastPostedUris, true); } catch (e: any) { set = e.message; }
      // An update's new folder in the user's own pod, for an annotation whose MM is elsewhere.
      const acc = await import('/static/js/annotation/solid-access.js');
      const ownFolder = 'https://pod.example/at.ac.mdw.mei-friend/oa/f/';
      const matched = await acc.matchNewFolderAccess(a.lastPostedUris, { ...a.lastPostedUris, 'oa/x': ownFolder + 'reply' });
      return { set, matched };
    }, mm);

    expect(r.set).toContain('isn\'t in your pod');
    expect(r.matched).toEqual([]);
    expect(pods.log, 'no request at all').toEqual([]);
  });

  test('56.6 deleting another pod\'s annotation from the list deletes nothing there, but drops it from the user\'s discovery', async ({ loadedPage: page }) => {
    const pods = await twoPods(page);
    const { mm, files } = await hostElsewhere(page, pods);
    // As an update before this fix left it: the other annotation listed in the user's discovery.
    const disc = await page.evaluate(async (file) => {
      const listen = (await import('/static/js/listen.js')) as any;
      const m = await import('/static/js/solid.js');
      return m.discoveryUriFor(listen.getAudioLinkedDataUri(file));
    }, files[0]);
    pods.store.set(disc, JSON.stringify({
      '@id': disc, '@type': 'https://schema.org/DataCatalog',
      'https://schema.org/dataset': [{ '@type': 'https://schema.org/Dataset',
        'https://schema.org/additionalType': { '@id': 'http://purl.org/ontology/mao/MusicalMaterial' },
        'https://schema.org/url': { '@id': mm } }],
    }));
    pods.log.length = 0;
    const res = await page.evaluate((mm) => (window as any).__annotationV6.deleteAnnotationFromPod(mm), mm);

    expect(pods.log.filter((r) => r.startsWith('DELETE ')), 'no DELETE at all').toEqual([]);
    expect(res.deletedUris).toEqual([]);
    expect(res.skippedUris.length).toBeGreaterThan(0);
    expect(pods.store.get(mm), 'left in its owner\'s pod').toBeTruthy();
    expect(pods.store.get(disc)).not.toContain(mm);
  });

  test('56.7 an access rule refuses an address that could end its <…> early', async ({ loadedPage: page }) => {
    const r = await page.evaluate(async () => {
      const acc = await import('/static/js/annotation/solid-access.js');
      const tryBuild = (folderUri: string) => {
        try { acc.buildFolderAcl({ webId: 'https://pod.example/profile/card#me', folderUri, isPublic: true }); return 'built'; } catch (e: any) { return 'refused'; }
      };
      return {
        normal: tryBuild('https://pod.example/at.ac.mdw.mei-friend/oa/f/'),
        injected: tryBuild('https://pod.example/x>; acl:mode acl:Write. <#y'),
        space: tryBuild('https://pod.example/a b/'),
        notHttp: tryBuild('javascript:alert(1)'),
      };
    });
    expect(r).toEqual({ normal: 'built', injected: 'refused', space: 'refused', notHttp: 'refused' });
  });

  test('56.8 "in the user\'s own pod" means under their storage root, after the URL parser resolves dot segments', async ({ loadedPage: page }) => {
    await page.route('https://pods.example/**', (route) => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
      return route.fulfill({ status: 200, contentType: 'application/ld+json', headers: CORS,
        body: JSON.stringify([{ '@id': 'https://pods.example/alice/profile/card#me', 'http://www.w3.org/ns/pim/space#storage': [{ '@id': 'https://pods.example/alice/' }] }]) });
    });
    const r = await page.evaluate(async () => {
      const sca = (window as any).solidClientAuthentication;
      const s = (sca.default || sca).getDefaultSession();
      s.info.isLoggedIn = true;
      s.info.webId = 'https://pods.example/alice/profile/card#me';
      const m = await import('/static/js/solid.js');
      const cases = [
        'https://pods.example/alice/at.ac.mdw.mei-friend/x',
        'https://pods.example/bob/x',
        'https://pods.example/alice/../bob/x',
        'https://pods.example/alice/%2e%2e/bob/x',
        'https://pods.example/aliceandbob/x',
        'https://user:pw@pods.example/alice/x',
        'http://pods.example:8443/alice/x',
        'https://elsewhere.example/alice/x',
        'local:score-projected/1',
      ];
      const out: Record<string, boolean> = {};
      for (const c of cases) out[c] = await m.isInOwnStorage(c);
      out['within friend: x'] = await m.isInOwnStorage('https://pods.example/alice/x', m.friendContainer);
      return out;
    });
    expect(r).toEqual({
      'https://pods.example/alice/at.ac.mdw.mei-friend/x': true,
      'https://pods.example/bob/x': false,
      'https://pods.example/alice/../bob/x': false,
      'https://pods.example/alice/%2e%2e/bob/x': false,
      'https://pods.example/aliceandbob/x': false,
      'https://user:pw@pods.example/alice/x': false,
      'http://pods.example:8443/alice/x': false,
      'https://elsewhere.example/alice/x': false,
      'local:score-projected/1': false,
      'within friend: x': false,
    });
  });
});
