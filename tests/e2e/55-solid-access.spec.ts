import { test, expect } from '../support/fixtures';
import type { Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Section 55 — Where an annotation lives in the pod, and making it public
// ---------------------------------------------------------------------------
// An annotation's resources sit in one folder per type
// (…/mao/selection/<ann>/<slug>), so access is set once per folder with Web
// Access Control and covers every resource, including ones a later update
// adds. No real pod: page.route() mocks one that keeps what is PUT, serves the
// Link: rel="acl" and WAC-Allow headers from the ACLs it holds (a folder's
// `acl:default` reaching its members), and can pose as an ACP pod.

const POD = 'https://pod.example/';
const FRIEND = POD + 'at.ac.mdw.mei-friend/';
const DISC = FRIEND + 'discovery/';
const WEBID = POD + 'profile/card#me';
const ACP_REL = 'http://www.w3.org/ns/solid/acp#accessControl';

interface WacPod {
  log: string[];
  resources: Map<string, string>;
  acls: Map<string, string>;
}

async function wacPod(page: Page, opts: { acp?: boolean } = {}): Promise<WacPod> {
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': '*',
    'Access-Control-Expose-Headers': 'ETag, Link, WAC-Allow',
  };
  const pod: WacPod = { log: [], resources: new Map(), acls: new Map() };
  const aclUrlOf = (u: string) => u + '.acl';
  const publicReadVia = (acl: string | undefined) =>
    !!acl && /foaf:Agent/.test(acl) && /acl:Read/.test(acl) && /<#public>/.test(acl);
  // A resource's own ACL, else the nearest folder's, whose `default` is inherited.
  const isPublic = (u: string) => {
    if (pod.acls.has(aclUrlOf(u))) return publicReadVia(pod.acls.get(aclUrlOf(u)));
    let parent = u.endsWith('/') ? u.slice(0, -1) : u;
    while (parent.lastIndexOf('/') > POD.length - 1) {
      parent = parent.slice(0, parent.lastIndexOf('/'));
      const f = parent + '/';
      if (pod.acls.has(aclUrlOf(f))) return publicReadVia(pod.acls.get(aclUrlOf(f)));
    }
    return false;
  };
  const folderExists = (u: string) => [...pod.resources.keys()].some((k) => k.startsWith(u));

  await page.route(POD + '**', async (route) => {
    const req = route.request();
    const method = req.method();
    const url = req.url();
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    pod.log.push(method + ' ' + url);
    const ok = (status: number, extra: Record<string, string> = {}, body = '') =>
      route.fulfill({ status, headers: { ...CORS, ...extra }, body });

    if (url === POD + 'profile/card') {
      return ok(200, { 'Content-Type': 'application/ld+json' }, JSON.stringify([
        { '@id': WEBID, 'http://www.w3.org/ns/pim/space#storage': [{ '@id': POD }] },
      ]));
    }
    if (url.endsWith('.acl')) {
      if (method === 'PUT') { pod.acls.set(url, req.postData() || ''); return ok(201); }
      if (method === 'DELETE') { pod.acls.delete(url); return ok(204); }
      return pod.acls.has(url) ? ok(200, { 'Content-Type': 'text/turtle' }, pod.acls.get(url)) : ok(404);
    }
    if (method === 'PUT') { pod.resources.set(url, req.postData() || ''); return ok(201); }
    if (method === 'DELETE') {
      if (url.endsWith('/')) {
        if (folderExists(url)) return ok(409);
        pod.acls.delete(aclUrlOf(url));
        return ok(204);
      }
      pod.resources.delete(url);
      return ok(204);
    }
    // GET / HEAD of a document or a folder
    const isFolder = url.endsWith('/');
    const exists = pod.resources.has(url) || (isFolder && (folderExists(url) || url === FRIEND || url === DISC || url === POD));
    if (!exists) return ok(404);
    const link = opts.acp
      ? `<${aclUrlOf(url)}>; rel="acl", <https://pod.example/acr>; rel="${ACP_REL}"`
      : `<${aclUrlOf(url)}>; rel="acl"`;
    const headers: Record<string, string> = { Link: link, ETag: '"1"', 'Content-Type': 'application/ld+json' };
    if (!opts.acp) headers['WAC-Allow'] = `user="read write append control",public="${isPublic(url) ? 'read' : ''}"`;
    if (method === 'HEAD' || isFolder) return ok(200, headers);
    return ok(200, headers, pod.resources.get(url) || '{}');
  });
  return pod;
}

/** Sign in (faked), then post a new annotation to two recordings; returns what was posted. */
async function postAnnotation(page: Page): Promise<{ id: string; uris: Record<string, string>; files: string[] }> {
  return page.evaluate(async () => {
    const sca = (window as any).solidClientAuthentication;
    const s = (sca.default || sca).getDefaultSession();
    s.info.isLoggedIn = true;
    s.info.webId = 'https://pod.example/profile/card#me';
    const v6 = (window as any).__annotationV6;
    const listen = (await import('/static/js/listen.js')) as any;
    const files = Object.keys(listen.loadedAlignmentJSON.body.audio).slice(0, 3);
    const id = v6.state.createAnnotation({ label: 'access test' });
    v6.state.addRegion(id, files[0], 1, 2);
    v6.state.addTarget(id, files[1]);
    v6.state.updateTargetNote(id, files[0], 'a note on the first recording'); // makes an oa:Annotation
    await v6.postAnnotationToSolid(id);
    return { id, uris: v6.state.getById(id).lastPostedUris, files };
  });
}

const resourcePuts = (pod: WacPod) =>
  pod.log
    .filter((r) => r.startsWith('PUT '))
    .map((r) => r.slice(4))
    .filter((u) => !u.endsWith('.acl') && !u.endsWith('/') && !u.startsWith(DISC));

const aclPuts = (pod: WacPod) => pod.log.filter((r) => r.startsWith('PUT ') && r.endsWith('.acl'));

test.describe('55. Annotation folders and public access', () => {

  test('55.1 a new post puts every resource in its annotation\'s folder inside its type container', async ({ loadedPage: page }) => {
    const pod = await wacPod(page);
    const { uris } = await postAnnotation(page);

    const puts = resourcePuts(pod);
    expect(puts.length).toBeGreaterThanOrEqual(4);
    const re = /^https:\/\/pod\.example\/at\.ac\.mdw\.mei-friend\/(oa|mao\/musicalMaterial|mao\/extract|mao\/selection)\/([^/]+)\/([^/]+)$/;
    const parsed = puts.map((u) => re.exec(u));
    expect(parsed.every(Boolean), 'every resource matches <type>/<ann>/<slug>: ' + puts.join(', ')).toBe(true);
    expect(new Set(parsed.map((m) => m![2])).size, 'one folder name for the whole annotation').toBe(1);
    expect(new Set(parsed.map((m) => m![1]))).toEqual(new Set(['oa', 'mao/musicalMaterial', 'mao/extract', 'mao/selection']));
    expect(uris.mm).toMatch(re);
  });

  test('55.2 a freshly posted annotation reads as private, from one HEAD', async ({ loadedPage: page }) => {
    const pod = await wacPod(page);
    const { uris } = await postAnnotation(page);
    pod.log.length = 0;
    const r = await page.evaluate((u) => (window as any).__annotationV6.getAnnotationAccess(u), uris);
    expect(r.state).toBe('private');
    expect(pod.log).toEqual(['HEAD ' + uris.mm]);
  });

  test('55.3 making it public writes one ACL per folder (4 HEAD + 4 PUT + 1 read-back), the MusicalMaterial\'s last', async ({ loadedPage: page }) => {
    const pod = await wacPod(page);
    const { uris } = await postAnnotation(page);
    pod.log.length = 0;
    const r = await page.evaluate((u) => (window as any).__annotationV6.setAnnotationAccess(u, true), uris);

    expect(r.state).toBe('public');
    expect(pod.log.filter((l) => l.startsWith('HEAD '))).toHaveLength(5);
    const acls = aclPuts(pod);
    expect(acls).toHaveLength(4);
    expect(acls[acls.length - 1], 'MusicalMaterial folder last').toContain('/mao/musicalMaterial/');
    for (const [url, body] of pod.acls) {
      const folder = url.slice(0, -'.acl'.length);
      expect(url.endsWith('/.acl')).toBe(true);
      // The owner keeps everything, restated on the folder itself and its members.
      expect(body).toContain('<' + WEBID + '>');
      expect(body).toMatch(/acl:mode acl:Read, acl:Write, acl:Control/);
      expect(body).toContain('acl:accessTo <' + folder + '>');
      // The public rule reaches the members only, so listing the folder stays private.
      const publicRule = body.slice(body.indexOf('<#public>'));
      expect(publicRule).toContain('acl:agentClass foaf:Agent');
      expect(publicRule).toContain('acl:default <' + folder + '>');
      expect(publicRule).not.toContain('acl:accessTo');
      expect(publicRule).toMatch(/acl:mode acl:Read\./);
    }
  });

  test('55.4 making it private again replaces the ACLs with the owner\'s alone, the MusicalMaterial\'s first', async ({ loadedPage: page }) => {
    const pod = await wacPod(page);
    const { uris } = await postAnnotation(page);
    await page.evaluate((u) => (window as any).__annotationV6.setAnnotationAccess(u, true), uris);
    pod.log.length = 0;
    const r = await page.evaluate((u) => (window as any).__annotationV6.setAnnotationAccess(u, false), uris);

    expect(r.state).toBe('private');
    const acls = aclPuts(pod);
    expect(acls).toHaveLength(4);
    expect(acls[0], 'MusicalMaterial folder first').toContain('/mao/musicalMaterial/');
    for (const body of pod.acls.values()) {
      expect(body).toContain('acl:Control');
      expect(body).not.toContain('foaf:Agent');
    }
  });

  test('55.5 a resource an update adds joins the existing folder and is covered without any ACL request', async ({ loadedPage: page }) => {
    const pod = await wacPod(page);
    const { id, uris, files } = await postAnnotation(page);
    await page.evaluate((u) => (window as any).__annotationV6.setAnnotationAccess(u, true), uris);
    pod.log.length = 0;

    const newUris = await page.evaluate(async ({ id, third }) => {
      const v6 = (window as any).__annotationV6;
      v6.state.addTarget(id, third);
      await v6.updateAnnotationOnSolid(id);
      return v6.state.getById(id).lastPostedUris;
    }, { id, third: files[2] });

    const folderId = /mei-friend\/mao\/musicalMaterial\/([^/]+)\//.exec(uris.mm)![1];
    const added = Object.values(newUris as Record<string, string>).filter((u) => !Object.values(uris).includes(u));
    expect(added.length, 'the update created a Selection for the third recording').toBeGreaterThan(0);
    for (const u of added) expect(u).toContain('/' + folderId + '/');
    expect(aclPuts(pod), 'no ACL written by an update').toEqual([]);
    const r = await page.evaluate((u) => (window as any).__annotationV6.getAnnotationAccess(u), newUris);
    expect(r.state).toBe('public');
  });

  test('55.6 an ACP pod is recognised and refused, with nothing written', async ({ loadedPage: page }) => {
    const pod = await wacPod(page, { acp: true });
    const { uris } = await postAnnotation(page);
    pod.log.length = 0;
    const got = await page.evaluate((u) => (window as any).__annotationV6.getAnnotationAccess(u), uris);
    expect(got.state).toBe('unsupported');
    const err = await page.evaluate(async (u) => {
      try { await (window as any).__annotationV6.setAnnotationAccess(u, true); return 'no error'; }
      catch (e: any) { return e.message; }
    }, uris);
    expect(err).toContain('Access Control Policies');
    expect(aclPuts(pod)).toEqual([]);
  });

  test('55.7 an annotation posted in the older flat layout is reported as legacy and left alone', async ({ loadedPage: page }) => {
    const pod = await wacPod(page);
    await postAnnotation(page); // signs in
    pod.log.length = 0;
    const flat = { mm: FRIEND + 'mao/musicalMaterial/20261030T195705-dd67efd0-0005', extract: FRIEND + 'mao/extract/20261030T195705-dd67efd0-0006' };
    const got = await page.evaluate((u) => (window as any).__annotationV6.getAnnotationAccess(u), flat);
    expect(got.state).toBe('legacy');
    const err = await page.evaluate(async (u) => {
      try { await (window as any).__annotationV6.setAnnotationAccess(u, true); return 'no error'; }
      catch (e: any) { return e.message; }
    }, flat);
    expect(err).toContain('older flat layout');
    expect(pod.log).toEqual([]);
  });

  test('55.8 removing an annotation\'s folders deletes one folder per type, and only for the new layout', async ({ loadedPage: page }) => {
    const pod = await wacPod(page);
    const { uris } = await postAnnotation(page);
    pod.log.length = 0;
    // The delete flow removes the resources first; here they are simply gone.
    for (const u of Object.values(uris)) pod.resources.delete(u);
    const removed = await page.evaluate(async (u) => {
      const m = await import('/static/js/annotation/solid-access.js');
      return m.removeEmptiedAnnotationFolders(Object.values(u));
    }, uris);
    expect(removed).toHaveLength(4);
    expect(pod.log.filter((l) => l.startsWith('DELETE ') && l.endsWith('/'))).toHaveLength(4);

    pod.log.length = 0;
    const flatRemoved = await page.evaluate(async (u) => {
      const m = await import('/static/js/annotation/solid-access.js');
      return m.removeEmptiedAnnotationFolders(u);
    }, [FRIEND + 'mao/extract/20261030T195705-dd67efd0-0006']);
    expect(flatRemoved).toEqual([]);
    expect(pod.log).toEqual([]);
  });

  test('55.10 the card shows Private with a Make public button, asks first, then shows Public with Make private', async ({ loadedPage: page }) => {
    const pod = await wacPod(page);
    await page.locator('.lh-v6-pull-tab').click();
    await expect(page.locator('.lh-v6-drawer')).toHaveClass(/open/);
    await postAnnotation(page);

    const bar = page.locator('.lh-v6-publish-bar');
    await expect(bar.locator('.lh-v6-access-status')).toHaveText('Private');
    const toggle = bar.locator('.lh-v6-access-btn');
    await expect(toggle).toHaveText('Make public');

    // Cancelling leaves the pod untouched.
    pod.log.length = 0;
    await toggle.click();
    await expect(page.getByRole('button', { name: 'Make public' }).last()).toBeVisible();
    await page.getByRole('button', { name: 'Cancel' }).click();
    expect(aclPuts(pod)).toEqual([]);
    await expect(bar.locator('.lh-v6-access-status')).toHaveText('Private');

    // Confirming makes it public.
    await toggle.click();
    await page.getByRole('button', { name: 'Make public' }).last().click();
    await expect(bar.locator('.lh-v6-access-status')).toHaveText('Public', { timeout: 15_000 });
    await expect(toggle).toHaveText('Make private');
    expect(aclPuts(pod)).toHaveLength(4);

    // Making private again needs no confirmation.
    await toggle.click();
    await expect(bar.locator('.lh-v6-access-status')).toHaveText('Private', { timeout: 15_000 });
    await expect(toggle).toHaveText('Make public');
  });

  // Firefox answers a HEAD from a heuristically fresh cached copy, and an ACL change
  // leaves the resource's own validators alone: reading back right after a change
  // that had worked showed the old WAC-Allow and was reported as a failure.
  test('55.11 access is always read past the browser cache', async ({ loadedPage: page }) => {
    await wacPod(page);
    const { uris } = await postAnnotation(page);
    const caches = await page.evaluate(async (u) => {
      const seen: { method: string; cache: string | undefined }[] = [];
      const real = window.fetch;
      window.fetch = ((input: any, init?: any) => {
        seen.push({ method: ((init && init.method) || 'GET').toUpperCase(), cache: init && init.cache });
        return real.call(window, input, init);
      }) as typeof fetch;
      try {
        await (window as any).__annotationV6.getAnnotationAccess(u);
        await (window as any).__annotationV6.setAnnotationAccess(u, true);
      } finally {
        window.fetch = real;
      }
      return seen.filter((x) => x.method === 'HEAD');
    }, uris);

    expect(caches.length, 'the HEADs were seen').toBeGreaterThanOrEqual(1 + 4 + 1);
    for (const c of caches) expect(c.cache, 'every HEAD of the access flow skips the HTTP cache').toBe('no-store');
  });

  test('55.9 Link and WAC-Allow headers are read the way servers write them', async ({ loadedPage: page }) => {
    const r = await page.evaluate(async () => {
      const m = await import('/static/js/annotation/solid-access.js');
      const links = m.parseLinkHeader(
        '<http://www.w3.org/ns/ldp#Resource>; rel="type", <res.acl>; rel="acl", <https://x.example/.well-known/solid>; rel="http://www.w3.org/ns/solid/terms#storageDescription"',
        'https://pod.example/a/res',
      );
      return {
        acl: links.find((l: any) => l.rel === 'acl')?.url,
        n: links.length,
        wac: [...m.parseWacAllow('user="read write append control",public="read"').public],
        none: [...m.parseWacAllow('user="read write",public=""').public],
        absent: m.parseWacAllow(null).user.size,
      };
    });
    expect(r.acl).toBe('https://pod.example/a/res.acl');
    expect(r.n).toBe(3);
    expect(r.wac).toEqual(['read']);
    expect(r.none).toEqual([]);
    expect(r.absent).toBe(0);
  });
});
