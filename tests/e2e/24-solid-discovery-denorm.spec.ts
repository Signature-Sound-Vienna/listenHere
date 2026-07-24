import { test, expect } from '../support/fixtures';
import type { Page, Route } from '@playwright/test';

// ---------------------------------------------------------------------------
// Section 24 — Discovery denormalisation (§3), pod-free network assertion
// ---------------------------------------------------------------------------
// §3 denormalises schema:name + schema:dateCreated onto each MusicalMaterial
// discovery entry at post/update time, so the "Load from Solid" list renders
// with ONE GET per recording (the discovery resource) instead of one extra
// GET per annotation (each MusicalMaterial). These tests prove that:
//
//   • when the discovery entries carry the inline fields, listing performs
//     ZERO GETs to the MusicalMaterial URIs; and
//   • when they don't (old Listen Here data, or mei-friend data, which never
//     denormalises), listing falls back to fetching each MM — so back-compat
//     is preserved.
//
// Like Section 23, this needs NO real pod: the Solid HTTP layer is mocked with
// page.route(), and the logged-in session is faked by flipping the (stable)
// default-session info singleton — the same seam 23.6 exercises. It therefore
// runs in the default 'functional' project.

// Namespaces — mirror app/static/js/linked-data.js. Discovery docs are written
// in EXPANDED JSON-LD (full-IRI keys, no @context), exactly as LH/mei-friend
// emit them, so jsonld.expand on the read side is a no-op.
const SCHEMA = 'https://schema.org/';
const MAO = 'https://domestic-beethoven.eu/ontology/1.0/music-annotation-ontology.ttl#';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
const DCT = 'http://purl.org/dc/terms/';
const PIM = 'http://www.w3.org/ns/pim/space#';

// Fake pod topology. The discovery URI is derived exactly as
// solid-load.js `_discoveryUriFor` does: storage + friendContainer +
// discoveryFragment + encodeURIComponent(audioUri).
const POD = 'https://pod.example/';
const WEBID = POD + 'profile/card#me';
const WEBID_DOC = POD + 'profile/card'; // fetch() strips the #fragment
const AUDIO_URI = POD + 'audio/rec1';
const DISCOVERY_URI =
  POD + 'at.ac.mdw.mei-friend/' + 'discovery/' + encodeURIComponent(AUDIO_URI);
const MM1 = POD + 'at.ac.mdw.mei-friend/mm/mm-0001';
const MM2 = POD + 'at.ac.mdw.mei-friend/mm/mm-0002';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
};

const PROFILE = [
  { '@id': WEBID, [PIM + 'storage']: [{ '@id': POD }] },
];

/** A denormalised MM discovery entry (current LH output). */
function mmEntryDenorm(url: string, name: string, created: string) {
  return {
    '@type': SCHEMA + 'Dataset',
    [SCHEMA + 'additionalType']: { '@id': MAO + 'MusicalMaterial' },
    [SCHEMA + 'url']: { '@id': url },
    [SCHEMA + 'name']: name,
    [SCHEMA + 'dateCreated']: created,
  };
}

/** A legacy MM discovery entry (old LH / mei-friend — no inline fields). */
function mmEntryLegacy(url: string) {
  return {
    '@type': SCHEMA + 'Dataset',
    [SCHEMA + 'additionalType']: { '@id': MAO + 'MusicalMaterial' },
    [SCHEMA + 'url']: { '@id': url },
  };
}

function discoveryDoc(entries: object[]) {
  return { '@id': DISCOVERY_URI, [SCHEMA + 'dataset']: entries };
}

/** A MusicalMaterial resource, as the fallback path expects to read it. */
function mmResource(url: string, label: string, created: string) {
  return {
    '@id': url,
    [RDFS + 'label']: [{ '@value': label }],
    [DCT + 'created']: [{ '@value': created }],
  };
}

/**
 * Mock the fake pod: profile (for storage resolution), the audio's discovery
 * resource, and any MusicalMaterial resources. Returns the list of MM URLs
 * actually fetched, so tests can assert the fast path issues none.
 */
async function installPod(
  page: Page,
  opts: { entries: object[]; resources?: Record<string, object> },
): Promise<string[]> {
  const resources = opts.resources ?? {};
  const mmFetched: string[] = [];
  page.on('request', (req) => {
    const u = req.url();
    if (u === MM1 || u === MM2) mmFetched.push(u);
  });

  await page.route(POD + '**', async (route: Route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') {
      return route.fulfill({ status: 204, headers: CORS });
    }
    const url = req.url();
    const json = (body: unknown) =>
      route.fulfill({
        status: 200,
        contentType: 'application/ld+json',
        headers: CORS,
        body: JSON.stringify(body),
      });

    if (url === WEBID_DOC) return json(PROFILE);
    if (url === DISCOVERY_URI) return json(discoveryDoc(opts.entries));
    if (resources[url]) return json(resources[url]);
    return route.fulfill({ status: 404, headers: CORS, body: '' });
  });

  return mmFetched;
}

/** Flip the default session to logged-in and list annotations for the audio. */
async function listForAudio(page: Page) {
  return page.evaluate(async (audioUri) => {
    const s = (window as any).solidClientAuthentication.default.getDefaultSession();
    s.info.isLoggedIn = true;
    s.info.webId = 'https://pod.example/profile/card#me';
    return await (window as any).__annotationV6.listAnnotationsForAudio(audioUri);
  }, AUDIO_URI);
}

test.describe('24. Discovery denormalisation (§3)', () => {

  // 24.1 Denormalised entries → list renders from the single discovery GET,
  // with no per-MusicalMaterial fetches.
  test('24.1 inline schema:name/dateCreated → zero per-MM GETs', async ({ loadedPage: page }) => {
    const mmFetched = await installPod(page, {
      entries: [
        mmEntryDenorm(MM1, 'Denorm one', '2026-01-02T03:04:05.000Z'),
        mmEntryDenorm(MM2, 'Denorm two', '2026-03-04T05:06:07.000Z'),
      ],
      // Deliberately provide NO MM resources: a fallback fetch would 404 and
      // surface as "(unreadable)", making an accidental regression loud.
    });

    const rows = await listForAudio(page);

    expect(rows).toHaveLength(2);
    const byUri = Object.fromEntries(rows.map((r: any) => [r.mmUri, r]));
    expect(byUri[MM1].label).toBe('Denorm one');
    expect(byUri[MM1].created).toBe('2026-01-02T03:04:05.000Z');
    expect(byUri[MM2].label).toBe('Denorm two');
    expect(byUri[MM2].created).toBe('2026-03-04T05:06:07.000Z');

    // The whole point of §3: the MusicalMaterials were never fetched.
    expect(mmFetched).toEqual([]);
  });

  // 24.2 Legacy entries (no inline fields) → fall back to fetching each MM.
  test('24.2 legacy entries → per-MM fetch fallback (back-compat)', async ({ loadedPage: page }) => {
    const mmFetched = await installPod(page, {
      entries: [mmEntryLegacy(MM1), mmEntryLegacy(MM2)],
      resources: {
        [MM1]: mmResource(MM1, 'Legacy one', '2025-05-05T05:05:05.000Z'),
        [MM2]: mmResource(MM2, 'Legacy two', '2025-06-06T06:06:06.000Z'),
      },
    });

    const rows = await listForAudio(page);

    expect(rows).toHaveLength(2);
    const byUri = Object.fromEntries(rows.map((r: any) => [r.mmUri, r]));
    expect(byUri[MM1].label).toBe('Legacy one');
    expect(byUri[MM1].created).toBe('2025-05-05T05:05:05.000Z');
    expect(byUri[MM2].label).toBe('Legacy two');

    // Fallback fired: both MusicalMaterials were fetched.
    expect(mmFetched.sort()).toEqual([MM1, MM2].sort());
  });

  // 24.3 Mixed dataset → only the legacy entry triggers a fetch.
  test('24.3 mixed dataset → only the legacy entry is fetched', async ({ loadedPage: page }) => {
    const mmFetched = await installPod(page, {
      entries: [
        mmEntryDenorm(MM1, 'Denorm one', '2026-01-02T03:04:05.000Z'),
        mmEntryLegacy(MM2),
      ],
      resources: { [MM2]: mmResource(MM2, 'Legacy two', '2025-06-06T06:06:06.000Z') },
    });

    const rows = await listForAudio(page);

    expect(rows).toHaveLength(2);
    const byUri = Object.fromEntries(rows.map((r: any) => [r.mmUri, r]));
    expect(byUri[MM1].label).toBe('Denorm one');
    expect(byUri[MM2].label).toBe('Legacy two');

    // Only the legacy MM was fetched; the denormalised one was not.
    expect(mmFetched).toEqual([MM2]);
  });

});
