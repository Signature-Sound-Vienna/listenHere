import { test, expect, AUDIO_A, AUDIO_B } from '../support/fixtures';
import { play, pause } from '../support/helpers';
import { type Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Section 7 — Close Listening Mode
// ---------------------------------------------------------------------------

// --- Helpers shared by the active-jump-target tests (7.10+) ----------------

/** Current playback time on the active waveform. */
const playhead = (page: Page) =>
  page.evaluate(() => {
    const t = (window as any)._listenTest;
    return t.wavesurfers[t.currentAudioIx]?.getCurrentTime() ?? 0;
  });

/**
 * The inline left-border the active-jump-target indicator paints on the active
 * annotation's region (empty string when that region is not the active target).
 */
const regionBorder = (page: Page) =>
  page.evaluate((file) => {
    const v = (window as any).__annotationV6;
    const ann = v.state.getById(v.state.getActiveId());
    const plugin = v.regionsPlugins[file];
    const r = plugin?.getRegions().find((x: any) => x._v6Meta && x._v6Meta.annId === ann.id);
    return r ? r.element.style.borderLeft : null;
  }, AUDIO_A);

/**
 * Create a fresh annotation and draw one region on AUDIO_A, then close the
 * editor drawer (the annotation stays active). Returns the region's start time
 * on AUDIO_A as recorded in V6 state.
 */
async function newAnnotationWithRegion(page: Page): Promise<number> {
  const wfA = page.locator(`#waveforms .waveform[data-ix="${AUDIO_A}"]`);
  await wfA.click({ position: { x: 10, y: 10 }, force: true });
  await page.waitForTimeout(150);
  await page.locator('.lh-v6-ribbon-new').click();
  await page.waitForSelector('body.lh-v6-edit-active');
  // Drag across the middle third of the waveform to draw a region.
  const box = (await wfA.boundingBox())!;
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * 0.3, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, y, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const start = await page.evaluate((file) => {
    const v = (window as any).__annotationV6;
    const ann = v.state.getById(v.state.getActiveId());
    const target = ann.targets.find((t: any) => t.file === file);
    return target.regionTimes[ann.regions[0].id].start;
  }, AUDIO_A);
  // Close the editor drawer; the annotation remains active.
  await page.locator('#v6-annotation-drawer-btn').click();
  await page.waitForTimeout(250);
  return start;
}

/**
 * As newAnnotationWithRegion, but then overrides the region to a short, known
 * [start, end] span on AUDIO_A so playback reaches the loop point quickly.
 */
async function newAnnotationWithShortRegion(page: Page, start = 1.0, end = 2.5) {
  await newAnnotationWithRegion(page);
  await page.evaluate(
    ({ file, s, e }) => {
      const v = (window as any).__annotationV6;
      const id = v.state.getActiveId();
      const rid = v.state.getById(id).regions[0].id;
      v.state.updateRegionTime(id, file, rid, { start: s, end: e });
    },
    { file: AUDIO_A, s: start, e: end },
  );
  return { start, end };
}

/** Current playback time on the active waveform (terse, for loop assertions). */
const ct = (page: Page) =>
  page.evaluate(() => {
    const t = (window as any)._listenTest;
    return t.wavesurfers[t.currentAudioIx].getCurrentTime();
  });

/** Force the active waveform's playhead to a given time. */
const seekTo = (page: Page, time: number) =>
  page.evaluate((s) => {
    const t = (window as any)._listenTest;
    t.wavesurfers[t.currentAudioIx].setTime(s);
  }, time);

/** The currently-active waveform index (filename). */
const currentIx = (page: Page) =>
  page.evaluate(() => (window as any)._listenTest.currentAudioIx);

test.describe('7. Close Listening Mode', () => {

  // Helper: place a marker at current position
  async function placeMarker(page: import('@playwright/test').Page) {
    await page.keyboard.press('m');
    await page.waitForTimeout(200);
  }

  // 7.1 Enter close listening — active marker highlighted
  test('7.1 close listening checkbox activates mode', async ({ loadedPage: page }) => {
    // Place a marker first
    await play(page);
    await page.waitForTimeout(500);
    await pause(page);
    await placeMarker(page);

    // Enable close listening
    const cb = page.locator('#close-listening-cb');
    await cb.check({ force: true });
    await page.waitForTimeout(300);

    // Should have an active marker (darker red / highlighted)
    const activeMarkers = await page.evaluate(() => {
      const markers = document.querySelectorAll('.ws-marker');
      // Active marker gets a darker color (#8b0000)
      return [...markers].filter(m => (m as HTMLElement).style.color === 'rgb(139, 0, 0)').length;
    });
    expect(activeMarkers).toBeGreaterThan(0);
  });

  // 7.2 Enter close listening via C key
  test('7.2 C key toggles close listening mode', async ({ loadedPage: page }) => {
    await play(page);
    await page.waitForTimeout(500);
    await pause(page);
    await placeMarker(page);

    // Press C to enter
    await page.keyboard.press('c');
    await page.waitForTimeout(300);
    const cbChecked = await page.locator('#close-listening-cb').isChecked();
    expect(cbChecked).toBe(true);

    // Press Escape to exit
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    const cbUnchecked = await page.locator('#close-listening-cb').isChecked();
    expect(cbUnchecked).toBe(false);
  });

  // 7.3 Arrow navigation between markers in close listening
  test('7.3 ArrowRight advances to next marker in close listening', async ({ loadedPage: page }) => {
    // Place two markers well apart: one near start, one ~30s further
    await play(page);
    await page.waitForTimeout(500);
    await pause(page);
    await placeMarker(page);

    // Seek forward several times to get a clearly different position
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => (document.getElementById('seek-fwd') as HTMLElement).click());
    }
    await page.waitForTimeout(200);
    await placeMarker(page);

    // Seek back to start so close listening activates on the first marker
    await page.evaluate(() => (document.getElementById('skip-back') as HTMLElement).click());
    await page.waitForTimeout(200);

    // Enter close listening — activates closest marker (the first one near start)
    const cb = page.locator('#close-listening-cb');
    await cb.check({ force: true });
    await page.waitForTimeout(300);

    // Get initial playback time (should be at first marker)
    const t1 = await page.evaluate(() => {
      const t = (window as any)._listenTest;
      return t?.wavesurfers[t.currentAudioIx]?.getCurrentTime() ?? 0;
    });

    // Arrow right to advance to the second marker
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(300);

    const t2 = await page.evaluate(() => {
      const t = (window as any)._listenTest;
      return t?.wavesurfers[t.currentAudioIx]?.getCurrentTime() ?? 0;
    });

    // Playhead should have jumped to the second marker (>5s apart)
    expect(Math.abs(t2 - t1)).toBeGreaterThan(5);
  });

  // 7.7 Delete marker with Delete key
  test('7.7 Delete key removes marker in close listening', async ({ loadedPage: page }) => {
    await play(page);
    await page.waitForTimeout(500);
    await pause(page);
    await placeMarker(page);

    const cb = page.locator('#close-listening-cb');
    await cb.check({ force: true });
    await page.waitForTimeout(300);

    const markersBefore = await page.locator('.ws-marker').count();
    expect(markersBefore).toBeGreaterThan(0);

    await page.keyboard.press('Delete');
    await page.waitForTimeout(300);

    const markersAfter = await page.locator('.ws-marker').count();
    expect(markersAfter).toBeLessThan(markersBefore);
  });

  // 7.8 Undo marker deletion
  test('7.8 Ctrl+Z undoes marker deletion', async ({ loadedPage: page }) => {
    await play(page);
    await page.waitForTimeout(500);
    await pause(page);
    await placeMarker(page);

    const cb = page.locator('#close-listening-cb');
    await cb.check({ force: true });
    await page.waitForTimeout(300);

    const markersBefore = await page.locator('.ws-marker').count();
    await page.keyboard.press('Delete');
    await page.waitForTimeout(300);
    expect(await page.locator('.ws-marker').count()).toBeLessThan(markersBefore);

    // Undo
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(300);
    const markersAfterUndo = await page.locator('.ws-marker').count();
    expect(markersAfterUndo).toBe(markersBefore);
  });

  // 7.9 Undo marker addition
  test('7.9 Ctrl+Z undoes marker addition', async ({ loadedPage: page }) => {
    const markersBefore = await page.locator('.ws-marker').count();

    await play(page);
    await page.waitForTimeout(500);
    await pause(page);
    await placeMarker(page);

    const markersAfterAdd = await page.locator('.ws-marker').count();
    expect(markersAfterAdd).toBeGreaterThan(markersBefore);

    // Undo
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(300);
    const markersAfterUndo = await page.locator('.ws-marker').count();
    expect(markersAfterUndo).toBe(markersBefore);
  });

  // -------------------------------------------------------------------------
  // Active jump target rework: the close-listening "active target" can be a
  // marker OR the start of an active-annotation region. Entering close
  // listening activates the closest such target; region starts are navigable
  // stops and carry a left-border indicator; exiting keeps the playhead put.
  // -------------------------------------------------------------------------

  // 7.10 Entering with no markers activates an active-annotation region start
  test('7.10 entering close listening activates a region start (border + seek)', async ({ loadedPage: page }) => {
    const regionStart = await newAnnotationWithRegion(page);
    // Park the playhead at the very start so the region start is the only
    // target and lies ahead of the cursor.
    await page.evaluate(() => (document.getElementById('skip-back') as HTMLElement)?.click());
    await page.waitForTimeout(200);

    // No indicator before entering.
    expect(await regionBorder(page)).toBe('');

    await page.locator('#close-listening-cb').check({ force: true });
    await page.waitForTimeout(300);

    // The region now carries the active left-border indicator...
    expect(await regionBorder(page)).toMatch(/2px solid/);
    // ...and the playhead jumped to the region's start.
    expect(Math.abs((await playhead(page)) - regionStart)).toBeLessThan(1.0);
  });

  // 7.11 A region start is a navigation stop alongside markers
  test('7.11 ArrowRight steps from a marker to a region start', async ({ loadedPage: page }) => {
    const regionStart = await newAnnotationWithRegion(page);
    // Marker near the start, well before the region.
    await page.evaluate(() => (document.getElementById('skip-back') as HTMLElement)?.click());
    await page.waitForTimeout(200);
    await placeMarker(page);

    // Enter at the start → the marker (closest target at/before the playhead)
    // is active, so the region is not yet the active target.
    await page.locator('#close-listening-cb').check({ force: true });
    await page.waitForTimeout(300);
    expect(await regionBorder(page)).toBe('');

    // ArrowRight advances to the next stop — the region start.
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(300);
    expect(Math.abs((await playhead(page)) - regionStart)).toBeLessThan(1.0);
    // The region is now the active target (indicator shown).
    expect(await regionBorder(page)).toMatch(/2px solid/);
  });

  // 7.12 Disabling close listening keeps the playhead where it is
  test('7.12 disabling close listening does not move the playhead', async ({ loadedPage: page }) => {
    await newAnnotationWithRegion(page);
    await page.evaluate(() => (document.getElementById('skip-back') as HTMLElement)?.click());
    await page.waitForTimeout(200);

    // Enter → parks the playhead at the region start (a non-zero position).
    await page.locator('#close-listening-cb').check({ force: true });
    await page.waitForTimeout(300);
    const tBefore = await playhead(page);
    expect(tBefore).toBeGreaterThan(1);

    // Exit → playhead stays put (it used to reset to 0) and the indicator clears.
    await page.locator('#close-listening-cb').uncheck({ force: true });
    await page.waitForTimeout(300);
    expect(Math.abs((await playhead(page)) - tBefore)).toBeLessThan(0.5);
    expect(await regionBorder(page)).toBe('');
  });

  // 7.13 Clicking a card plays from its first region; no per-card play buttons
  test('7.13 clicking an annotation card plays from its first region', async ({ loadedPage: page }) => {
    const { start } = await newAnnotationWithShortRegion(page);
    // The old per-card play/pause overlay no longer exists.
    expect(await page.locator('.lh-v6-chip-play').count()).toBe(0);

    await page.locator('.lh-v6-chip').first().click();
    await page.waitForTimeout(400);
    const t = await ct(page);
    const playing = await page.evaluate(() => {
      const x = (window as any)._listenTest;
      return x.wavesurfers[x.currentAudioIx].isPlaying();
    });
    expect(playing).toBe(true);
    // Jumped to (near) the region start, then advanced a little.
    expect(t).toBeGreaterThan(start - 0.2);
    expect(t).toBeLessThan(start + 1.0);
  });

  // 7.14 In close-listening, the active region loops back at its end
  test('7.14 close-listening loops the active region at its end', async ({ loadedPage: page }) => {
    const { start, end } = await newAnnotationWithShortRegion(page);
    await page.locator('#close-listening-cb').check({ force: true });
    await page.waitForTimeout(150);
    await page.locator('.lh-v6-chip').first().click();
    await page.waitForTimeout(300);
    // Jump just past the region end while playing → next audioprocess loops it.
    await seekTo(page, end + 0.05);
    await page.waitForTimeout(500);
    const t = await ct(page);
    expect(t).toBeLessThan(end);          // wrapped back into the region...
    expect(t).toBeGreaterThan(start - 0.2); // ...near its start, not past the end
  });

  // 7.15 Turning close-listening off mid-playback stops the loop
  test('7.15 disabling close-listening lets playback continue past the region end', async ({ loadedPage: page }) => {
    const { end } = await newAnnotationWithShortRegion(page);
    await page.locator('#close-listening-cb').check({ force: true });
    await page.waitForTimeout(150);
    await page.locator('.lh-v6-chip').first().click();
    await page.waitForTimeout(300);
    // Switch close-listening OFF, then play through the region end.
    await page.locator('#close-listening-cb').uncheck({ force: true });
    await seekTo(page, end - 0.1);
    await page.waitForTimeout(700);
    expect(await ct(page)).toBeGreaterThan(end); // continued past the end, no loop
  });

  // 7.16 Every annotation's region starts are navigable stops, not just the
  // active annotation's. Two annotations; the SECOND is active, but entering
  // close-listening at the start activates the FIRST (non-active) annotation's
  // region start (the earliest stop), and ArrowRight steps to the second.
  test('7.16 a non-active annotation region start is a navigable stop', async ({ loadedPage: page }) => {
    await newAnnotationWithRegion(page); // ann1
    await newAnnotationWithRegion(page); // ann2 (active)
    const { ann1Start, ann2Start } = await page.evaluate((file) => {
      const v = (window as any).__annotationV6;
      const anns = v.state.getAll();
      const [a1, a2] = anns;
      v.state.updateRegionTime(a1.id, file, a1.regions[0].id, { start: 1.0, end: 2.0 });
      v.state.updateRegionTime(a2.id, file, a2.regions[0].id, { start: 3.0, end: 4.0 });
      v.state.setActiveAnnotation(a2.id); // ann2 is the active annotation
      return { ann1Start: 1.0, ann2Start: 3.0 };
    }, AUDIO_A);

    // Park at the start; entering activates the earliest stop — ann1's region
    // start — even though ann1 is not the active annotation.
    await page.evaluate(() => (document.getElementById('skip-back') as HTMLElement)?.click());
    await page.waitForTimeout(200);
    await page.locator('#close-listening-cb').check({ force: true });
    await page.waitForTimeout(300);
    expect(Math.abs((await playhead(page)) - ann1Start)).toBeLessThan(1.0);

    // ArrowRight steps to the active annotation's region start.
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(300);
    expect(Math.abs((await playhead(page)) - ann2Start)).toBeLessThan(1.0);
  });

  // 7.17 Annotation cards highlight while a region of theirs plays, distinct
  // from the "active" card shown in the editor.
  test('7.17 annotation cards highlight while their region plays', async ({ loadedPage: page }) => {
    await newAnnotationWithShortRegion(page, 1.0, 2.5);
    const chip = page.locator('.lh-v6-chip').first();
    // Not playing yet — no playing highlight.
    expect(await chip.evaluate((el) => el.classList.contains('playing'))).toBe(false);

    // Click to play from the region start; the playhead enters the region.
    await chip.click();
    await page.waitForTimeout(400);
    expect(await chip.evaluate((el) => el.classList.contains('playing'))).toBe(true);
    // The playing cue is separate from (and coexists with) the active cue.
    expect(await chip.evaluate((el) => el.classList.contains('active'))).toBe(true);

    // Pausing clears the playing highlight.
    await pause(page);
    await page.waitForTimeout(250);
    expect(await chip.evaluate((el) => el.classList.contains('playing'))).toBe(false);
  });

  // 7.18 Switching waveforms with a region start as the active jump target
  // restarts at the equivalent region start on the new waveform — mirroring how
  // a marker jump target re-seeks on switch, rather than carrying the playhead
  // across "seamlessly". Regression test for the region-start swap bug.
  test('7.18 switching waveforms restarts at the equivalent region start', async ({ loadedPage: page }) => {
    await newAnnotationWithRegion(page); // active annotation, region on AUDIO_A
    // Known extents on both waveforms. AUDIO_B's start (1.0) is far from where
    // carrying the AUDIO_A playhead (~6s) across via the alignment grid (~6.5s)
    // would land, so the two behaviours are clearly distinguishable.
    await page.evaluate(
      ({ a, b }) => {
        const v = (window as any).__annotationV6;
        const id = v.state.getActiveId();
        const rid = v.state.getById(id).regions[0].id;
        v.state.updateRegionTime(id, a, rid, { start: 3.0, end: 8.0 });
        v.state.addTarget(id, b, { regionTimes: { [rid]: { start: 1.0, end: 5.0 } } });
      },
      { a: AUDIO_A, b: AUDIO_B },
    );

    // Park at the start, enter close-listening → the AUDIO_A region start is the
    // active jump target (playhead jumps to ~3.0; indicator shown).
    await page.evaluate(() => (document.getElementById('skip-back') as HTMLElement)?.click());
    await page.waitForTimeout(200);
    await page.locator('#close-listening-cb').check({ force: true });
    await page.waitForTimeout(300);
    expect(await regionBorder(page)).toMatch(/2px solid/);

    // Move the playhead to the RIGHT of the region start (still on AUDIO_A).
    await seekTo(page, 6.0);
    await page.waitForTimeout(100);

    // Switch to the next waveform (AUDIO_B).
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(300);
    expect(await currentIx(page)).toBe(AUDIO_B);

    // Restarted at AUDIO_B's equivalent region start (~1.0), NOT the carried
    // playhead position (~6.5 via the alignment grid).
    expect(Math.abs((await playhead(page)) - 1.0)).toBeLessThan(0.5);
  });

  // 7.19 When the region has no extent on the new waveform, switching falls back
  // to carrying the playhead position across (no spurious region seek).
  test('7.19 switching carries the playhead when the region is absent on the new waveform', async ({ loadedPage: page }) => {
    await newAnnotationWithRegion(page);
    await page.evaluate(
      ({ a }) => {
        const v = (window as any).__annotationV6;
        const id = v.state.getActiveId();
        const rid = v.state.getById(id).regions[0].id;
        v.state.updateRegionTime(id, a, rid, { start: 3.0, end: 8.0 });
        // No AUDIO_B target: the region does not exist on the next waveform.
      },
      { a: AUDIO_A },
    );

    await page.evaluate(() => (document.getElementById('skip-back') as HTMLElement)?.click());
    await page.waitForTimeout(200);
    await page.locator('#close-listening-cb').check({ force: true });
    await page.waitForTimeout(300);
    await seekTo(page, 6.0);
    await page.waitForTimeout(100);

    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(300);
    expect(await currentIx(page)).toBe(AUDIO_B);
    // No equivalent region on AUDIO_B → playhead carries across (~6.5s via the
    // alignment grid) rather than snapping back to a region start.
    expect(await playhead(page)).toBeGreaterThan(3.0);
  });

});
