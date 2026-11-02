import { type Page } from '@playwright/test';
import { test, expect, AUDIO_A, AUDIO_B } from '../support/fixtures';

// ---------------------------------------------------------------------------
// Section 58 — Annotation region sources (0.107.0)
// ---------------------------------------------------------------------------
// A region remembers where it was placed by hand: `sourceFile` (the recording
// it was drawn or dragged on) or `sourceScore` (the MEI element ids it was
// projected from at Solid load). A Shift+drag on one recording marks that
// recording's times `local`. These ride in the alignment JSON, and an
// alignment correction recasts every other target from the source (spec 43
// covers the recast through real correction sessions). Regions without a
// source — every annotation from before — are never recast.

const v6 = (page: Page, fn: (a: any, arg: any) => any, arg?: any) =>
  page.evaluate(({ src, arg }) => {
    // eslint-disable-next-line no-new-func
    const f = new Function('a', 'arg', `return (${src})(a, arg);`);
    return f((window as any).__annotationV6, arg);
  }, { src: fn.toString(), arg });

/** A fresh annotation on A and B with one region drawn on A; returns ids. */
async function annotationWithRegion(page: Page) {
  return v6(
    page,
    (a, { A, B }) => {
      const s = a.state;
      const annId = s.createAnnotation({ label: 'sources' });
      s.addTarget(annId, A);
      s.addTarget(annId, B);
      const rid = s.addRegion(annId, A, 1, 2, { [A]: { start: 1, end: 2 }, [B]: { start: 3, end: 4 } });
      return { annId, rid };
    },
    { A: AUDIO_A, B: AUDIO_B },
  );
}

const regionState = (page: Page, annId: string, rid: string) =>
  v6(
    page,
    (a, { annId, rid }) => {
      const ann = a.state.getById(annId);
      const r = ann.regions.find((x: any) => x.id === rid);
      return {
        sourceFile: r.sourceFile,
        sourceScore: r.sourceScore,
        times: Object.fromEntries(ann.targets.map((t: any) => [t.file, { ...t.regionTimes[rid] }])),
      };
    },
    { annId, rid },
  );

test.describe('58. Annotation region sources', () => {

  test('58.1 drawing records the source recording; a one-recording edit elsewhere is local, on the source it is not; a propagated edit takes the source and clears local; removing the source recording clears it', async ({ loadedPage: page }) => {
    const { annId, rid } = await annotationWithRegion(page);
    let st = await regionState(page, annId, rid);
    expect(st.sourceFile).toBe(AUDIO_A);
    expect(st.sourceScore).toBeNull();
    expect(st.times[AUDIO_A].local).toBeUndefined();
    expect(st.times[AUDIO_B].local).toBeUndefined();

    await v6(page, (a, { annId, rid, A, B }) => {
      a.state.updateRegionTime(annId, B, rid, { start: 3.5 });
      a.state.updateRegionTime(annId, A, rid, { start: 1.1 });
    }, { annId, rid, A: AUDIO_A, B: AUDIO_B });
    st = await regionState(page, annId, rid);
    expect(st.times[AUDIO_B]).toEqual({ start: 3.5, end: 4, local: true });
    expect(st.times[AUDIO_A]).toEqual({ start: 1.1, end: 2 });

    // A score-sourced region dragged normally becomes recording-sourced.
    await v6(page, (a, { annId, rid }) => a.state.setRegionSourceScore(annId, rid, ['n1', 'n2']), { annId, rid });
    expect((await regionState(page, annId, rid)).sourceScore).toEqual(['n1', 'n2']);
    await v6(page, (a, { annId, rid, A, B }) =>
      a.state.updateRegionTimeMulti(annId, rid, { [A]: { start: 1.2, end: 2 }, [B]: { start: 3.6, end: 4 } }, B),
    { annId, rid, A: AUDIO_A, B: AUDIO_B });
    st = await regionState(page, annId, rid);
    expect(st.sourceFile).toBe(AUDIO_B);
    expect(st.sourceScore).toBeNull();
    expect(st.times[AUDIO_B]).toEqual({ start: 3.6, end: 4 });

    await v6(page, (a, { annId, B }) => a.state.removeTarget(annId, B), { annId, B: AUDIO_B });
    expect((await regionState(page, annId, rid)).sourceFile).toBeNull();
  });

  test('58.2 a region dropped on a waveform takes that recording as its source; with Shift held it only marks that recording local', async ({ loadedPage: page }) => {
    const { annId, rid } = await annotationWithRegion(page);
    // The waveform bridge's drop handler: region-updated on the plugin.
    const drop = (shift: boolean) =>
      page.evaluate(({ annId, rid, B, shift }) => {
        const w = window as any;
        if (shift) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift' }));
        const plugin = w.__annotationV6.waveformViews[B].regions;
        const region = plugin.getRegions().find(
          (r: any) => r._v6Meta && r._v6Meta.annId === annId && r._v6Meta.regionId === rid,
        );
        region.setOptions({ start: region.start + 0.25, end: region.end + 0.25 });
        plugin.emit('region-updated', region);
        if (shift) document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift' }));
      }, { annId, rid, B: AUDIO_B, shift });
    await page.waitForFunction(
      ({ annId, rid, B }) => (window as any).__annotationV6.waveformViews[B]?.regions
        ?.getRegions().some((r: any) => r._v6Meta?.annId === annId && r._v6Meta?.regionId === rid),
      { annId, rid, B: AUDIO_B },
    );

    await drop(true);
    let st = await regionState(page, annId, rid);
    expect(st.sourceFile).toBe(AUDIO_A);
    expect(st.times[AUDIO_B].local).toBe(true);

    await drop(false);
    st = await regionState(page, annId, rid);
    expect(st.sourceFile).toBe(AUDIO_B);
    expect(st.times[AUDIO_B].local).toBeUndefined();
  });

  test('58.3 sources and local flags round-trip through the alignment JSON (schemaVersion 3, written only when set); an older annotation loads without a source, and a recast leaves it, and an unchanged alignment, alone', async ({ loadedPage: page }) => {
    const { annId, rid } = await annotationWithRegion(page);
    await v6(page, (a, { annId, rid, B }) => a.state.updateRegionTime(annId, B, rid, { end: 4.5 }), { annId, rid, B: AUDIO_B });
    const saved = await v6(page, (a) => {
      const json: any = {};
      a.commitAnnotationsToAlignment(json);
      return json.annotations;
    });
    const ann = saved.find((x: any) => x.id === annId);
    expect(ann.schemaVersion).toBe(3);
    expect(ann.regions).toEqual([{ id: rid, label: '', sourceFile: AUDIO_A }]);
    const byFile = Object.fromEntries(ann.targets.map((t: any) => [t.file, t.regionTimes[rid]]));
    expect(byFile[AUDIO_A]).toEqual({ start: 1, end: 2 });
    expect(byFile[AUDIO_B]).toEqual({ start: 3, end: 4.5, local: true });

    // Reload it, plus a v2 annotation (no sources) and a score-sourced one.
    const older = {
      id: 'ann_old', label: 'old', regions: [{ id: 'r_old', label: '' }],
      targets: [
        { file: AUDIO_A, regionTimes: { r_old: { start: 5, end: 6 } } },
        { file: AUDIO_B, regionTimes: { r_old: { start: 50, end: 60 } } },
      ],
      schemaVersion: 2,
    };
    const scored = {
      id: 'ann_score', label: 'score', regions: [{ id: 'r_s', label: '', sourceScore: ['n1'] }],
      targets: [{ file: AUDIO_A, regionTimes: { r_s: { start: 7, end: 8 } } }],
      schemaVersion: 3,
    };
    const loaded = await v6(page, (a, list) => {
      a.loadAnnotationsFromAlignment({ annotations: list });
      return a.state.getAll().map((x: any) => ({
        id: x.id,
        regions: x.regions,
        times: x.targets.map((t: any) => t.regionTimes),
        dirty: x.hasUnsavedChanges,
      }));
    }, [ann, older, scored]);
    const get = (id: string) => loaded.find((x: any) => x.id === id);
    expect(get(annId).regions[0]).toMatchObject({ sourceFile: AUDIO_A, sourceScore: null });
    expect(get(annId).times[1][rid]).toEqual({ start: 3, end: 4.5, local: true });
    expect(get('ann_old').regions[0]).toMatchObject({ sourceFile: null, sourceScore: null });
    expect(get('ann_score').regions[0]).toMatchObject({ sourceFile: null, sourceScore: ['n1'] });

    // With the alignment as it is, a recast changes nothing — the older
    // annotation's B times (deliberately not what A maps to) included.
    const n = await v6(page, (a) => a.recastAnnotationsToAlignment());
    expect(n).toBe(0);
    const after = await v6(page, (a) => a.state.getById('ann_old'));
    expect(after.targets.find((t: any) => t.file === 'audio-b.mp3').regionTimes.r_old).toEqual({ start: 50, end: 60 });
    expect(after.hasUnsavedChanges).toBe(false);
  });
});
