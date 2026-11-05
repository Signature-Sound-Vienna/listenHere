import { test, expect } from '../support/fixtures';
import type { Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Section 55 — Where an annotation lives in the pod, and making it public
// ---------------------------------------------------------------------------
// An annotation's resources sit in one folder per type
// (…/mao/selection/<ann>/<slug>), so access is set once per folder with Web
// Access Control and covers every resource, including ones a later update
// adds. Resources in the older flat layout (…/mao/selection/<slug>, as
// mei-friend posts them) get one ACL each. No real pod: page.route() mocks one
// that keeps what is PUT, serves the
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

/**
 * Sign in (faked), then post a new annotation to two recordings; returns what was posted.
 * `withNote: false` leaves out the note, so the annotation's one oa:Annotation is the bodiless oa/top.
 * Returns once the card has read the new annotation's access (one HEAD of its
 * MusicalMaterial), so that read never lands in a log a test clears after posting.
 */
async function postAnnotation(
  page: Page,
  { withNote = true }: { withNote?: boolean } = {},
): Promise<{ id: string; uris: Record<string, string>; files: string[] }> {
  const posted = await _post(page, withNote);
  await page.locator('.lh-v6-access-btn').first().waitFor(); // drawn when the card's read is done
  return posted;
}

async function _post(page: Page, withNote: boolean): Promise<{ id: string; uris: Record<string, string>; files: string[] }> {
  return page.evaluate(async (withNote) => {
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
    if (withNote) v6.state.updateTargetNote(id, files[0], 'a note on the first recording'); // makes an oa:Annotation
    await v6.postAnnotationToSolid(id);
    return { id, uris: v6.state.getById(id).lastPostedUris, files };
  }, withNote);
}

/** Set the note on `file` (empty removes it), update, and return the new lastPostedUris. */
async function updateNote(page: Page, id: string, file: string, text: string): Promise<Record<string, string>> {
  return page.evaluate(async ({ id, file, text }) => {
    const v6 = (window as any).__annotationV6;
    v6.state.updateTargetNote(id, file, text);
    await v6.updateAnnotationOnSolid(id);
    return v6.state.getById(id).lastPostedUris;
  }, { id, file, text });
}

/** Whether the pod lets anyone read `uri`, from its WAC-Allow header. */
async function publiclyReadable(page: Page, uri: string): Promise<boolean> {
  return page.evaluate(async (u) => {
    const m = await import('/static/js/annotation/solid-access.js');
    return (await m.discoverAccessControl(u)).wacAllow.public.has('read');
  }, uri);
}

/** The note's oa:Annotation (a per-recording one), if any. */
const oaUriOf = (uris: Record<string, string>) =>
  Object.entries(uris).find(([k]) => k.startsWith('oa/track/'))?.[1];
const folderOf = (uri: string) => uri.slice(0, uri.lastIndexOf('/') + 1);

const resourcePuts = (pod: WacPod) =>
  pod.log
    .filter((r) => r.startsWith('PUT '))
    .map((r) => r.slice(4))
    .filter((u) => !u.endsWith('.acl') && !u.endsWith('/') && !u.startsWith(DISC));

const aclPuts = (pod: WacPod) => pod.log.filter((r) => r.startsWith('PUT ') && r.endsWith('.acl'));

/**
 * Move a posted annotation into the older flat layout (<type container>/<slug>)
 * and give it a score Selection that is not in lastPostedUris: a mei-friend
 * annotation as Listen Here has it after loading. Returns the flat URIs and
 * the score Selection.
 */
async function flatten(
  page: Page,
  pod: WacPod,
  id: string,
  uris: Record<string, string>,
): Promise<{ flat: Record<string, string>; scoreSel: string }> {
  const flat: Record<string, string> = {};
  for (const [k, u] of Object.entries(uris)) {
    const m = /^(.*\/)[^/]+\/([^/]+)$/.exec(u)!;
    flat[k] = m[1] + m[2];
  }
  for (const [k, u] of Object.entries(uris)) {
    let body = pod.resources.get(u) || '{}';
    for (const [k2, u2] of Object.entries(uris)) body = body.split(u2).join(flat[k2]);
    pod.resources.delete(u);
    pod.resources.set(flat[k], body);
  }
  const scoreSel = FRIEND + 'mao/selection/20261030T195705-dd67efd0-0004';
  pod.resources.set(scoreSel, '{}');
  await page.evaluate(({ id, flat, scoreSel }) => {
    const a = (window as any).__annotationV6.state.getById(id);
    a.lastPostedUris = flat;
    a.lastPostedHashes = {};
    a.preservedSelections = [scoreSel];
  }, { id, flat, scoreSel });
  return { flat, scoreSel };
}

const FLAT_RE = /^https:\/\/pod\.example\/at\.ac\.mdw\.mei-friend\/(oa|mao\/musicalMaterial|mao\/extract|mao\/selection)\/[^/]+$/;

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

  test('55.7 an annotation in the older flat layout gets one ACL per resource, its score Selections included, the MusicalMaterial\'s last', async ({ loadedPage: page }) => {
    const pod = await wacPod(page);
    const { id, uris } = await postAnnotation(page);
    const { flat, scoreSel } = await flatten(page, pod, id, uris);
    const setAccess = (isPublic: boolean) =>
      page.evaluate(({ flat, scoreSel, isPublic }) =>
        (window as any).__annotationV6.setAnnotationAccess(flat, isPublic, { otherUris: [scoreSel] }),
      { flat, scoreSel, isPublic });
    pod.log.length = 0;
    const got = await page.evaluate((u) => (window as any).__annotationV6.getAnnotationAccess(u), flat);
    expect(got.state).toBe('private');

    pod.log.length = 0;
    expect((await setAccess(true)).state).toBe('public');
    const resources = [...Object.values(flat), scoreSel];
    const acls = aclPuts(pod);
    expect([...acls].sort()).toEqual(resources.map((u) => 'PUT ' + u + '.acl').sort());
    expect(acls[acls.length - 1], 'MusicalMaterial last').toBe('PUT ' + flat.mm + '.acl');
    expect([...pod.acls.keys()].filter((k) => k.endsWith('/.acl')), 'no folder or container ACL').toEqual([]);
    for (const u of resources) {
      const body = pod.acls.get(u + '.acl')!;
      expect(body).toContain('<' + WEBID + '>');
      expect(body).toMatch(/acl:mode acl:Read, acl:Write, acl:Control/);
      expect(body).not.toContain('acl:default');
      const publicRule = body.slice(body.indexOf('<#public>'));
      expect(publicRule).toContain('acl:agentClass foaf:Agent');
      expect(publicRule).toContain('acl:accessTo <' + u + '>');
      expect(await publiclyReadable(page, u)).toBe(true);
    }

    pod.log.length = 0;
    expect((await setAccess(false)).state).toBe('private');
    expect(aclPuts(pod)[0], 'MusicalMaterial first').toBe('PUT ' + flat.mm + '.acl');
    for (const u of resources) expect(pod.acls.get(u + '.acl')).not.toContain('foaf:Agent');
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

  // 55.12 Annotations posted before oa/top was always written (0.108.0) have no
  // oa:Annotation until there is text, so an update can add the first one, in
  // an oa/ folder the annotation did not have when its access was set. That
  // folder gets the annotation's access.
  test('55.12 the first text an update adds to an older public annotation without one is public too', async ({ loadedPage: page }) => {
    const pod = await wacPod(page);
    const { id, uris, files } = await postAnnotation(page, { withNote: false });
    // As posted before 0.108.0: no oa/top, so no oa/ folder.
    expect(uris['oa/top'], 'oa/top is written without any text').toBeTruthy();
    pod.resources.delete(uris['oa/top']);
    await page.evaluate((id) => {
      const a = (window as any).__annotationV6.state.getById(id);
      delete a.lastPostedUris['oa/top'];
      if (a.lastPostedHashes) delete a.lastPostedHashes['oa/top'];
    }, id);
    const { 'oa/top': _gone, ...older } = uris;
    await page.evaluate((u) => (window as any).__annotationV6.setAnnotationAccess(u, true), older);
    pod.log.length = 0;

    const newUris = await updateNote(page, id, files[0], 'written after it was made public');
    const oaUri = oaUriOf(newUris)!;
    expect(oaUri, 'the update created an oa:Annotation').toBeTruthy();
    expect(folderOf(newUris['oa/top']), 'the restored oa/top shares its folder').toBe(folderOf(oaUri));
    expect(aclPuts(pod), 'one ACL, for the new oa/ folder').toEqual(['PUT ' + folderOf(oaUri) + '.acl']);
    expect(await publiclyReadable(page, oaUri)).toBe(true);
    const r = await page.evaluate((u) => (window as any).__annotationV6.getAnnotationAccess(u), newUris);
    expect(r.state).toBe('public');
  });

  test('55.13 removing the last note keeps the oa/ folder, so access changes still reach text re-added later', async ({ loadedPage: page }) => {
    const pod = await wacPod(page);
    const { id, uris, files } = await postAnnotation(page);
    const v6Access = (u: Record<string, string>, isPublic: boolean) =>
      page.evaluate(({ u, isPublic }) => (window as any).__annotationV6.setAnnotationAccess(u, isPublic), { u, isPublic });
    await v6Access(uris, true);
    const oaFolder = folderOf(oaUriOf(uris)!);

    // Removing the note deletes its oa:Annotation; the bodiless oa/top stays in
    // the same folder, so making the annotation private reaches that folder.
    const noNote = await updateNote(page, id, files[0], '');
    expect(oaUriOf(noNote)).toBeUndefined();
    expect(folderOf(noNote['oa/top'])).toBe(oaFolder);
    await v6Access(noNote, false);
    expect(pod.acls.get(oaFolder + '.acl'), 'the oa/ folder is private again').not.toMatch(/<#public>/);

    const again = await updateNote(page, id, files[0], 'written again while private');
    const oaUri = oaUriOf(again)!;
    expect(folderOf(oaUri)).toBe(oaFolder);
    expect(await publiclyReadable(page, oaUri), 'the new text is not public').toBe(false);
  });

  test('55.14 an update that adds no folder makes no access request', async ({ loadedPage: page }) => {
    const pod = await wacPod(page);
    const { id, files } = await postAnnotation(page);
    pod.log.length = 0;
    await updateNote(page, id, files[0], 'an edited note');
    // (The update establishes each recording's discovery resource with a HEAD; those aren't access requests.)
    const access = pod.log.filter((r) => (r.startsWith('HEAD ') && !r.startsWith('HEAD ' + DISC)) || r.endsWith('.acl'));
    expect(access, 'no access HEAD, no ACL').toEqual([]);
  });

  // What a reader without the audio (Primal, opened at oa/top) depends on.
  test('55.15 each Selection carries its recording\'s peaks, and oa/top is posted without a body when there is no text', async ({ loadedPage: page }) => {
    const pod = await wacPod(page);
    const { uris, files } = await postAnnotation(page, { withNote: false });
    const doc = (u: string) => {
      const d = JSON.parse(pod.resources.get(u) || 'null');
      return Array.isArray(d) ? d[0] : d;
    };
    const OA = 'http://www.w3.org/ns/oa#';

    const top = doc(uris['oa/top']);
    expect(top, 'oa/top is posted').toBeTruthy();
    expect(top[OA + 'hasBody']).toBeUndefined();
    expect(top[OA + 'motivatedBy']).toEqual([{ '@id': 'https://w3id.org/sda#commenting' }]);
    expect(top[OA + 'hasTarget']).toEqual([{ '@id': uris.mm }]);

    const expected = await page.evaluate(async (files) => {
      const listen = (await import('/static/js/listen.js')) as any;
      return files.map((f: string) => listen.getWaveformPeaks(f));
    }, files.slice(0, 2));
    files.slice(0, 2).forEach((f, i) => {
      const lit = doc(uris['sel/' + f])['https://w3id.org/ssv/vocab#peaks'];
      expect(lit, 'ssv:peaks on the Selection for ' + f).toHaveLength(1);
      const { peaks, duration } = JSON.parse(lit[0]['@value']);
      expect(duration).toBe(expected[i].duration);
      expect(peaks).toHaveLength(expected[i].peaks.length);
      const maxDiff = Math.max(...peaks.map((v: number, j: number) => Math.abs(v - expected[i].peaks[j])));
      expect(maxDiff, 'peaks rounded to 4 decimals').toBeLessThanOrEqual(5e-5);
    });
  });

  test('55.16 ↗ Primal shows only while the annotation is public, opening Primal on its oa/top', async ({ loadedPage: page }) => {
    await wacPod(page);
    await page.locator('.lh-v6-pull-tab').click();
    await expect(page.locator('.lh-v6-drawer')).toHaveClass(/open/);
    const { uris } = await postAnnotation(page);

    const bar = page.locator('.lh-v6-publish-bar');
    const primal = bar.locator('.lh-v6-primal-link');
    const toggle = bar.locator('.lh-v6-access-btn');
    await expect(bar.locator('.lh-v6-access-status')).toHaveText('Private');
    await expect(primal).toHaveCount(0);

    await toggle.click();
    await page.getByRole('button', { name: 'Make public' }).last().click();
    await expect(bar.locator('.lh-v6-access-status')).toHaveText('Public', { timeout: 15_000 });
    await expect(primal).toHaveText('↗ Primal');
    await expect(primal).toHaveAttribute(
      'href',
      'https://primal.mdw.ac.at/?obj=' + encodeURIComponent(uris['oa/top']),
    );
    await expect(primal).toHaveAttribute('target', '_blank');

    await toggle.click();
    await expect(bar.locator('.lh-v6-access-status')).toHaveText('Private', { timeout: 15_000 });
    await expect(primal).toHaveCount(0);
  });

  test('55.17 an update keeps a flat annotation flat; its new resources get an ACL while it is public, none while private', async ({ loadedPage: page }) => {
    const pod = await wacPod(page);
    const { id, uris, files } = await postAnnotation(page);
    const { flat, scoreSel } = await flatten(page, pod, id, uris);
    await page.evaluate(({ flat, scoreSel }) =>
      (window as any).__annotationV6.setAnnotationAccess(flat, true, { otherUris: [scoreSel] }),
    { flat, scoreSel });
    pod.log.length = 0;

    const newUris: Record<string, string> = await page.evaluate(async ({ id, second, third }) => {
      const v6 = (window as any).__annotationV6;
      v6.state.addTarget(id, third);
      v6.state.updateTargetNote(id, second, 'a note added to the flat annotation');
      await v6.updateAnnotationOnSolid(id);
      return v6.state.getById(id).lastPostedUris;
    }, { id, second: files[1], third: files[2] });
    const added = Object.values(newUris).filter((u) => !Object.values(flat).includes(u));
    expect(added.length, 'a Selection and an oa:Annotation').toBeGreaterThanOrEqual(2);
    for (const u of added) expect(u).toMatch(FLAT_RE);
    expect([...aclPuts(pod)].sort()).toEqual(added.map((u) => 'PUT ' + u + '.acl').sort());
    for (const u of added) expect(await publiclyReadable(page, u)).toBe(true);
    const r = await page.evaluate((u) => (window as any).__annotationV6.getAnnotationAccess(u), newUris);
    expect(r.state).toBe('public');

    await page.evaluate(({ u, scoreSel }) =>
      (window as any).__annotationV6.setAnnotationAccess(u, false, { otherUris: [scoreSel] }),
    { u: newUris, scoreSel });
    pod.log.length = 0;
    const again = await updateNote(page, id, files[2], 'written while private');
    const fresh = Object.values(again).filter((u) => !Object.values(newUris).includes(u));
    expect(fresh.length, 'the note made an oa:Annotation').toBeGreaterThan(0);
    expect(aclPuts(pod), 'no ACL while private').toEqual([]);
    for (const u of fresh) expect(await publiclyReadable(page, u)).toBe(false);
  });

  test('55.18 the card makes a flat annotation public, the score Selections from mei-friend with it', async ({ loadedPage: page }) => {
    const pod = await wacPod(page);
    const alerts: string[] = [];
    page.on('dialog', (d) => { alerts.push(d.message()); d.dismiss(); });
    // Flattened before the drawer opens, so the card is drawn from the flat state.
    const { id, uris } = await _post(page, true);
    const { flat, scoreSel } = await flatten(page, pod, id, uris);
    await page.locator('.lh-v6-pull-tab').click();
    await expect(page.locator('.lh-v6-drawer')).toHaveClass(/open/);

    const bar = page.locator('.lh-v6-publish-bar');
    const toggle = bar.locator('.lh-v6-access-btn');
    await expect(bar.locator('.lh-v6-access-status')).toHaveText('Private');
    await expect(toggle).toBeEnabled();
    await toggle.click();
    await page.getByRole('button', { name: 'Make public' }).last().click();
    await expect(bar.locator('.lh-v6-access-status'), alerts.join(' | ')).toHaveText('Public', { timeout: 15_000 });
    expect(await publiclyReadable(page, scoreSel)).toBe(true);
    for (const u of Object.values(flat)) expect(await publiclyReadable(page, u)).toBe(true);
    await expect(bar.locator('.lh-v6-primal-link')).toHaveAttribute(
      'href',
      'https://primal.mdw.ac.at/?obj=' + encodeURIComponent(flat['oa/top']),
    );
  });

  // Reported 2026-11-04 (on a train): a change that died with the connection
  // left a greyed-out Make public whose tooltip was the network error, and only
  // a reload brought the button back.
  test('55.19 when the connection drops during a change, the card says access is unknown and Try again reads it afresh', async ({ loadedPage: page }) => {
    const pod = await wacPod(page);
    let offline = false;
    await page.route(POD + '**', (route) => (offline ? route.abort('failed') : route.fallback()));
    await page.locator('.lh-v6-pull-tab').click();
    await expect(page.locator('.lh-v6-drawer')).toHaveClass(/open/);
    await postAnnotation(page);
    const bar = page.locator('.lh-v6-publish-bar');
    await expect(bar.locator('.lh-v6-access-status')).toHaveText('Private');

    offline = true;
    const alerted = new Promise<string>((resolve) => page.once('dialog', (d) => { resolve(d.message()); d.accept(); }));
    await bar.locator('.lh-v6-access-btn').click();
    await page.getByRole('button', { name: 'Make public' }).last().click();
    expect(await alerted).toMatch(/^Making public failed/);
    // The read-back after the failure fails too: no dead button.
    await expect(bar.locator('.lh-v6-access-status')).toHaveText('Access unknown');
    const retry = bar.locator('.lh-v6-access-retry');
    await expect(retry).toBeEnabled();
    await expect(retry).toHaveText('Try again');

    offline = false;
    pod.log.length = 0;
    await retry.click();
    await expect(bar.locator('.lh-v6-access-status')).toHaveText('Private', { timeout: 15_000 });
    await expect(bar.locator('.lh-v6-access-btn')).toHaveText('Make public');
    await expect(bar.locator('.lh-v6-access-btn')).toBeEnabled();
    expect(aclPuts(pod)).toEqual([]);
  });
});
