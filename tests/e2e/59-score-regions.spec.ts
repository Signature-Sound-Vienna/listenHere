import { type Page } from '@playwright/test';
import path from 'path';
import { test, expect, AUDIO_A, AUDIO_B } from '../support/fixtures';
import { FIXTURES_DIR, loadLocalAlignment, showWaveform, waitForWaveformsReady } from '../support/helpers';

// ---------------------------------------------------------------------------
// Section 59 — Score regions (0.111.0)
// ---------------------------------------------------------------------------
// An annotation with a score Selection (mei-friend's: frbr:parts
// `${meiUri}#elementId`) has one score region, from the earliest onset to the
// latest offset of its elements in Verovio's timemap. It loads with no
// recordings: the user picks them, and each pick projects the region onto that
// recording. The synthesised score row shows that region only, nailed to the
// elements' times; it is never a target. On a recording the score region only
// moves for that recording (Shift+drag), a plain drag is refused with a note,
// and it can't be deleted. On the pod it is position 1 of every audio
// Selection, which is how a reload finds it again. No real pod: page.route()
// serves the chain from another server.

const ELSE = 'https://elsewhere.example/mf/';
const SYNTH = 'Score (synthesised from MEI)';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': '*',
};

/** Serve `chain` (URI → expanded JSON-LD node) from ELSE; the user's pod is empty. */
async function serveChain(page: Page, chain: Record<string, object>) {
  await page.route('https://elsewhere.example/**', (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const body = chain[req.url()];
    return body
      ? route.fulfill({ status: 200, contentType: 'application/ld+json', headers: CORS, body: JSON.stringify(body) })
      : route.fulfill({ status: 404, headers: CORS, body: '' });
  });
  await page.route('https://pod.example/**', (route) =>
    route.request().method() === 'OPTIONS'
      ? route.fulfill({ status: 204, headers: CORS })
      : route.fulfill({ status: 404, headers: CORS, body: '' }),
  );
}

async function signIn(page: Page) {
  await page.evaluate(() => {
    const sca = (window as any).solidClientAuthentication;
    const s = (sca.default || sca).getDefaultSession();
    s.info.isLoggedIn = true;
    s.info.webId = 'https://pod.example/profile/card#me';
  });
}

/** Element ids from the fixture score (the Schumann Romanze), by timemap position. */
const SCORE_IDS = {
  measure: 'measure-0000000466961048', // bar 3: stands for the notes inside it
  note: 'note-0000001853359237', // a later note, ending the span
};

/** A mei-friend chain: MM → Extract → one score Selection; plus audio Selections if given. */
function chain(meiUri: string, nsp: Record<string, string>, audio: { uri: string; parts: string[] }[] = []) {
  const sel = (u: string, about: string, parts: string[]) => ({
    '@id': u,
    '@type': [nsp.MAO + 'Selection'],
    [nsp.SCHEMA + 'about']: [{ '@id': about }],
    [nsp.FRBR + 'part']: parts.map((p) => ({ '@id': p })),
  });
  const audioSels = audio.map((a, i) => sel(ELSE + 'sel-' + i, a.uri, a.parts.map((t) => a.uri + '#t=' + t)));
  const scoreSel = sel(ELSE + 'score', meiUri, [meiUri + '#' + SCORE_IDS.measure, meiUri + '#' + SCORE_IDS.note]);
  const nodes = [
    { '@id': ELSE + 'mm', '@type': [nsp.MAO + 'MusicalMaterial'], [nsp.MAO + 'setting']: [{ '@id': ELSE + 'ex' }] },
    {
      '@id': ELSE + 'ex',
      '@type': [nsp.MAO + 'Extract'],
      [nsp.FRBR + 'embodiment']: [...audioSels, scoreSel].map((s) => ({ '@id': s['@id'] })),
    },
    ...audioSels,
    scoreSel,
  ];
  return Object.fromEntries(nodes.map((n) => [n['@id'], n]));
}

/** The page's MEI URI, namespaces, and audio Linked Data URIs, once the alignment has named them. */
async function pageContext(page: Page) {
  await page.waitForFunction(async () => !!(await import('/static/js/listen.js' as any)).meiUri);
  return page.evaluate(async ([A, B]) => {
    const L = await import('/static/js/listen.js' as any);
    const { nsp } = await import('/static/js/linked-data.js' as any);
    return { meiUri: L.meiUri, nsp, ua: L.getAudioLinkedDataUri(A), ub: L.getAudioLinkedDataUri(B) };
  }, [AUDIO_A, AUDIO_B]);
}

/** The span the timemap gives the score region's elements, computed here independently. */
const timemapSpan = (page: Page) =>
  page.evaluate(async ({ measure, note }) => {
    const L = await import('/static/js/listen.js' as any);
    const dom = L.getMeiDOM();
    const m = [...dom.getElementsByTagName('measure')].find((e: Element) => e.getAttribute('xml:id') === measure);
    const ids = new Set([...m.getElementsByTagName('note')].map((e: Element) => e.getAttribute('xml:id')).concat(note));
    let start = Infinity;
    let end = -Infinity;
    for (const e of L.timemap) {
      for (const id of e.on || []) if (ids.has(id)) start = Math.min(start, e.tstamp / 1000);
      for (const id of e.off || []) if (ids.has(id)) end = Math.max(end, e.tstamp / 1000);
    }
    return { start, end };
  }, SCORE_IDS);

const v6 = (page: Page, fn: (a: any, arg: any) => any, arg?: any) =>
  page.evaluate(({ src, arg }) => {
    // eslint-disable-next-line no-new-func
    const f = new Function('a', 'arg', `return (${src})(a, arg);`);
    return f((window as any).__annotationV6, arg);
  }, { src: fn.toString(), arg });

const activeAnn = (page: Page) => v6(page, (a) => JSON.parse(JSON.stringify(a.state.getById(a.state.getActiveId()))));

/** The V6 regions a waveform shows: times plus how the score region looks there. */
const shownRegions = (page: Page, file: string) =>
  page.evaluate(async (file) => {
    const L = await import('/static/js/listen.js' as any);
    return L.waveformViews[file].regions.getRegions()
      .filter((r: any) => r.id.startsWith('v6_'))
      .map((r: any) => ({
        start: r.start,
        end: r.end,
        dashed: (r.element.style.outline || '').includes('dashed'),
        title: r.element.title,
        handleCursors: [...r.element.querySelectorAll('[part~="region-handle"], .lh-v6-pinned-handle')]
          .map((h: HTMLElement) => h.style.cursor),
      }));
  }, file);

/** A waveform's V6 region box in page coordinates. */
const regionBox = (page: Page, file: string) =>
  page.evaluate(async (file) => {
    const L = await import('/static/js/listen.js' as any);
    const r = L.waveformViews[file].regions.getRegions().find((x: any) => x.id.startsWith('v6_'));
    const b = r.element.getBoundingClientRect();
    return { x: b.x, y: b.y, width: b.width, height: b.height };
  }, file);

/** A waveform's V6 region's right resize handle, once the row has stopped
 *  redrawing: a click makes a row active, and the redraws that follow rebuild
 *  its regions, so a press during one lands on nothing that can resize. */
async function rightHandleBox(page: Page, file: string) {
  await page.evaluate(async (file) => {
    const L = await import('/static/js/listen.js' as any);
    const w = window as any;
    w.__redraws = 0;
    L.wavesurfers[file].on('redrawcomplete', () => w.__redraws++);
  }, file);
  let seen = -1;
  await expect.poll(async () => {
    const now = await page.evaluate(() => (window as any).__redraws);
    const quiet = now === seen;
    seen = now;
    return quiet;
  }, { intervals: [700, 700, 700, 700, 700, 700] }).toBe(true);
  const measure = () =>
    page.evaluate(async (file) => {
      const L = await import('/static/js/listen.js' as any);
      const r = L.waveformViews[file].regions.getRegions().find((x: any) => x.id.startsWith('v6_'));
      const h = r.element.querySelector('[part~="region-handle-right"]');
      const b = h.getBoundingClientRect();
      return { x: b.x, y: b.y, width: b.width, height: b.height };
    }, file);
  let last = await measure();
  await expect.poll(async () => {
    const now = await measure();
    const still = now.x === last.x && now.y === last.y;
    last = now;
    return still;
  }, { intervals: [100, 100, 200, 200, 400] }).toBe(true);
  return last;
}

/** Open the drawer on the active annotation in Edit mode with draw mode on. */
const editMode = (page: Page) =>
  v6(page, (a) => {
    a.uiState.setDrawerOpen(true);
    a.uiState.setMode('edit');
    a.uiState.setDrawMode(true);
  });

/** Pick a recording the way a user does: a click on its waveform in Edit mode. */
async function pick(page: Page, file: string) {
  await page.locator(`#waveforms .waveform[data-ix="${file}"]`).click({ position: { x: 600, y: 60 }, force: true });
}

test.describe('59. Score regions', () => {

  test('59.1 a score annotation loads while the score is still loading, with no recordings; picks project its timemap span; the score row shows only that span and never becomes a target', async ({ page }) => {
    // Hold the score back: the loader must not need it.
    let releaseMei!: () => void;
    const meiHeld = new Promise<void>((r) => (releaseMei = r));
    await page.route('**/Schumann-Clara_Romanze-ohne-Opuszahl_a-Moll.mei', async (route) => {
      await meiHeld;
      await route.fulfill({
        status: 200,
        contentType: 'application/xml; charset=utf-8',
        path: path.join(FIXTURES_DIR, 'Schumann-Clara_Romanze-ohne-Opuszahl_a-Moll.mei'),
      });
    });
    await loadLocalAlignment(page);
    const ctx = await pageContext(page);
    await serveChain(page, chain(ctx.meiUri, ctx.nsp));
    await signIn(page);

    const loaded = await v6(page, async (a, mm) => {
      const L = await import('/static/js/listen.js' as any);
      const before = L.timemap.length;
      try {
        const id = await a.loadAnnotationFromMM(mm);
        return { before, id };
      } catch (e) {
        return { before, error: String(e) };
      }
    }, ELSE + 'mm');
    expect(loaded.error).toBeUndefined();
    expect(loaded.before).toBe(0); // the score really wasn't there
    let ann = await activeAnn(page);
    expect(ann.targets).toEqual([]);
    expect(ann.regions).toHaveLength(1);
    expect(ann.regions[0].sourceScore).toEqual([SCORE_IDS.measure, SCORE_IDS.note]);
    expect(ann.preservedSelections).toEqual([ELSE + 'score']);
    // A palette colour, as a new annotation gets, not the adapter's grey.
    expect(ann.color).not.toBe('#94a3b8');
    expect(['#22c55e', '#3b82f6', '#a855f7', '#f59e0b', '#ef4444', '#14b8a6', '#ec4899', '#0ea5e9', '#84cc16', '#eab308']).toContain(ann.color);

    releaseMei();
    await page.waitForFunction(() => ((window as any)._listenTest?.loadGeneration ?? 0) > 0, null, { timeout: 40_000 });
    await showWaveform(page, AUDIO_A);
    await showWaveform(page, AUDIO_B);
    await waitForWaveformsReady(page);

    // The score row: one dashed region at the elements' own timemap span, with inert handles.
    const span = await timemapSpan(page);
    await expect.poll(() => shownRegions(page, SYNTH)).toHaveLength(1);
    const [onScore] = await shownRegions(page, SYNTH);
    expect(onScore.start).toBeCloseTo(span.start, 6);
    expect(onScore.end).toBeCloseTo(span.end, 6);
    expect(onScore.dashed).toBe(true);
    expect(onScore.title).toMatch(/nailed to the onset and offset times of the selected MEI elements/);
    expect(onScore.handleCursors).toEqual(['not-allowed', 'not-allowed']);

    await editMode(page);
    await expect(page.locator('.lh-v6-empty-hint', { hasText: 'comes from a score selection' })).toBeVisible();
    // Not dimmed or offered for selection like an unselected recording.
    const scoreRow = page.locator(`#waveforms .waveform[data-ix="${SYNTH}"]`);
    await expect(scoreRow).toHaveClass(/lh-v6-unselectable/);
    expect(await scoreRow.evaluate((el) => getComputedStyle(el).filter)).toBe('none');
    // The score row is neither picked nor drawn on.
    await pick(page, SYNTH);
    const synthBox = await page.locator(`#waveforms .waveform[data-ix="${SYNTH}"]`).boundingBox();
    await page.mouse.move(synthBox!.x + 300, synthBox!.y + 60);
    await page.mouse.down();
    await page.mouse.move(synthBox!.x + 420, synthBox!.y + 60, { steps: 8 });
    await page.mouse.up();
    ann = await activeAnn(page);
    expect(ann.targets).toEqual([]);
    expect(ann.regions).toHaveLength(1);

    await pick(page, AUDIO_A);
    await pick(page, AUDIO_B);
    ann = await activeAnn(page);
    expect(ann.targets.map((t: any) => t.file).sort()).toEqual([AUDIO_A, AUDIO_B]);
    // Each pick is the score span projected: on the reference (B) through the
    // score alignment, on A on from there through the grids.
    const expected = await page.evaluate(async ({ span, A }) => {
      const L = await import('/static/js/listen.js' as any);
      const ci = (t: number, tab: number[]) => tab.reduce((b, v, i) => (Math.abs(v - t) < Math.abs(tab[b] - t) ? i : b), 0);
      const on = L.correctedSynthOnsets || L.scoreAlignment.synth_onset;
      const off = L.correctedSynthOffsets || L.scoreAlignment.synth_offset;
      const ref = L.getReferenceAudioIx();
      const s = L.scoreAlignment.ref_onset[ci(span.start, on)];
      const e = L.scoreAlignment.ref_offset[ci(span.end, off)];
      const toA = (t: number) => L.getCorrespondingTime(A, L.getClosestAlignmentIx(t, ref));
      return { [ref]: { start: s, end: e }, [A]: { start: toA(s), end: toA(e) } };
    }, { span, A: AUDIO_A });
    for (const t of ann.targets) {
      expect(t.regionTimes[ann.regions[0].id].start).toBeCloseTo(expected[t.file].start, 6);
      expect(t.regionTimes[ann.regions[0].id].end).toBeCloseTo(expected[t.file].end, 6);
    }
    // Still only the score span on the score row.
    expect(await shownRegions(page, SYNTH)).toHaveLength(1);
  });

  test('59.2 on a recording the score region is dashed and locked: a plain drag is refused with a note and draws nothing, Shift+drag moves it there only, and it cannot be deleted', async ({ page }) => {
    test.setTimeout(60_000); // a load, two picks, three gestures, and waits for redraws to settle
    await loadLocalAlignment(page);
    const ctx = await pageContext(page);
    await serveChain(page, chain(ctx.meiUri, ctx.nsp));
    await page.waitForFunction(() => ((window as any)._listenTest?.loadGeneration ?? 0) > 0, null, { timeout: 40_000 });
    await showWaveform(page, AUDIO_A);
    await showWaveform(page, AUDIO_B);
    await waitForWaveformsReady(page);
    await signIn(page);
    await v6(page, (a, mm) => a.loadAnnotationFromMM(mm), ELSE + 'mm');
    await editMode(page);
    await pick(page, AUDIO_A);
    await pick(page, AUDIO_B);
    const before = await activeAnn(page);
    const rid = before.regions[0].id;
    const timesOf = (ann: any, f: string) => ({ start: ann.targets.find((t: any) => t.file === f).regionTimes[rid].start, end: ann.targets.find((t: any) => t.file === f).regionTimes[rid].end });

    await expect.poll(() => shownRegions(page, AUDIO_A)).toHaveLength(1);
    const [onA] = await shownRegions(page, AUDIO_A);
    expect(onA.dashed).toBe(true);
    expect(onA.title).toMatch(/Projected from a score selection/);
    expect(onA.handleCursors).toEqual(['not-allowed', 'not-allowed']);

    // A plain drag on the region: refused, explained, nothing drawn.
    const box = await regionBox(page, AUDIO_A);
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + box.width / 2, y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 80, y, { steps: 10 });
    await expect(page.locator('.lh-v6-score-drag-note')).toBeVisible();
    await expect(page.locator('.lh-v6-score-drag-note')).toContainText('correct it using ‘Correct alignment…’');
    await page.mouse.up();
    let ann = await activeAnn(page);
    expect(ann.regions).toHaveLength(1);
    expect(timesOf(ann, AUDIO_A)).toEqual(timesOf(before, AUDIO_A));
    // The release that ended the refused drag leaves the note; the next click anywhere dismisses it.
    await expect(page.locator('.lh-v6-score-drag-note')).toBeVisible();
    await page.mouse.click(5, 5);
    await expect(page.locator('.lh-v6-score-drag-note')).toBeHidden();

    // With Shift: the handles come alive, and a resize stays on this recording.
    // (The refused drag's click made A the active row, which moves it.)
    await page.keyboard.down('Shift');
    expect((await shownRegions(page, AUDIO_A))[0].handleCursors).toEqual(['ew-resize', 'ew-resize']);
    const handle = await rightHandleBox(page, AUDIO_A);
    const y2 = handle.y + handle.height / 2;
    const rightHandle = handle.x + handle.width / 2;
    await page.mouse.move(rightHandle, y2);
    await page.mouse.down();
    await page.mouse.move(rightHandle + 40, y2, { steps: 10 });
    await page.mouse.up();
    await page.keyboard.up('Shift');
    ann = await activeAnn(page);
    const movedA = ann.targets.find((t: any) => t.file === AUDIO_A).regionTimes[rid];
    expect(movedA.end).toBeGreaterThan(timesOf(before, AUDIO_A).end);
    expect(movedA.start).toBe(timesOf(before, AUDIO_A).start);
    expect(movedA.local).toBe(true);
    expect(timesOf(ann, AUDIO_B)).toEqual(timesOf(before, AUDIO_B));
    expect(ann.regions[0].sourceScore).toEqual([SCORE_IDS.measure, SCORE_IDS.note]);
    expect((await shownRegions(page, AUDIO_A))[0].handleCursors).toEqual(['not-allowed', 'not-allowed']);

    // Not deletable: the drawer's trash explains, and state refuses too.
    const trash = page.locator('.lh-v6-region-row--score .lh-v6-region-trash').first();
    await expect(trash).toHaveAttribute('aria-disabled', 'true');
    const said = new Promise<string>((resolve) => page.once('dialog', (d) => { resolve(d.message()); d.accept(); }));
    await trash.click({ force: true }); // aria-disabled: Playwright won't click it unforced; a user can
    expect(await said).toMatch(/can't be removed\. To annotate without the score, start a new annotation/);
    await v6(page, (a, rid) => a.state.removeRegion(a.state.getActiveId(), rid), rid);
    expect((await activeAnn(page)).regions).toHaveLength(1);
  });

  test('59.3 a reload finds the score region at position 1, marks a recording moved off the projection local, and an Update keeps the score Selection with the score region first', async ({ loadedPage: page }) => {
    const ctx = await pageContext(page);
    const span = await timemapSpan(page);
    // The projection on each recording, as a pick would make it.
    const proj = await page.evaluate(async ({ A, B, span }) => {
      const L = await import('/static/js/listen.js' as any);
      const ci = (t: number, tab: number[]) => tab.reduce((b, v, i) => (Math.abs(v - t) < Math.abs(tab[b] - t) ? i : b), 0);
      const on = L.correctedSynthOnsets || L.scoreAlignment.synth_onset;
      const off = L.correctedSynthOffsets || L.scoreAlignment.synth_offset;
      const ref = L.getReferenceAudioIx();
      const s = L.scoreAlignment.ref_onset[ci(span.start, on)];
      const e = L.scoreAlignment.ref_offset[ci(span.end, off)];
      const other = ref === A ? B : A;
      const to = (t: number) => L.getCorrespondingTime(other, L.getClosestAlignmentIx(t, ref));
      return { [ref]: [s, e], [other]: [to(s), to(e)] };
    }, { A: AUDIO_A, B: AUDIO_B, span });
    const ms = (t: number) => Math.round(t * 1000) / 1000;
    // As an Update left it: the score region first on every audio Selection
    // (moved by 5 s on A by hand), a hand-drawn region second.
    await serveChain(page, chain(ctx.meiUri, ctx.nsp, [
      { uri: ctx.ua, parts: [`${ms(proj[AUDIO_A][0] + 5)},${ms(proj[AUDIO_A][1] + 5)}`, '40,45'] },
      { uri: ctx.ub, parts: [`${ms(proj[AUDIO_B][0])},${ms(proj[AUDIO_B][1])}`, '41,46'] },
    ]));
    await signIn(page);
    await v6(page, (a, mm) => a.loadAnnotationFromMM(mm), ELSE + 'mm');

    await expect.poll(async () => {
      const ann = await activeAnn(page);
      return ann.targets.find((t: any) => t.file === AUDIO_A).regionTimes[ann.regions[0].id].local;
    }).toBe(true);
    const ann = await activeAnn(page);
    expect(ann.regions.map((r: any) => r.sourceScore)).toEqual([[SCORE_IDS.measure, SCORE_IDS.note], null]);
    expect(ann.targets.find((t: any) => t.file === AUDIO_B).regionTimes[ann.regions[0].id].local).toBeUndefined();
    expect(ann.hasUnsavedChanges).toBe(false);
    expect(ann.color).not.toBe('#94a3b8'); // every Solid load takes a palette colour

    // An Update writes the score Selection back, and the score region first.
    const written = await v6(page, async (a) => {
      const L = await import('/static/js/listen.js' as any);
      const { nsp } = await import('/static/js/linked-data.js' as any);
      const ann = a.state.getById(a.state.getActiveId());
      const { templates } = a.adapter.serialize(ann, { resolveAudioUri: (f: string) => L.getAudioLinkedDataUri(f) });
      const ex = templates.find((t: any) => t.localKey === 'extract');
      return {
        embodiment: ex.body[nsp.FRBR + 'embodiment'].map((x: any) => x['@id']),
        firstParts: templates
          .filter((t: any) => t.kind === 'mao:Selection')
          .map((t: any) => t.body[nsp.FRBR + 'part'][0]['@id'].split('#t=')[1]),
      };
    });
    expect(written.embodiment).toContain(ELSE + 'score');
    expect(written.firstParts.sort()).toEqual(
      [`${ms(proj[AUDIO_A][0] + 5)},${ms(proj[AUDIO_A][1] + 5)}`, `${ms(proj[AUDIO_B][0])},${ms(proj[AUDIO_B][1])}`].sort(),
    );
  });
});
