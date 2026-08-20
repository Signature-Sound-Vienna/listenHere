import { test, expect, type Page } from '@playwright/test';
import { ALIGNMENT_MANY, AUDIO_A } from '../support/fixtures';
import { loadLocalAlignment, stubManyRecordingAudio } from '../support/helpers';

// ---------------------------------------------------------------------------
// Section 31 — Lazy waveform creation for off-screen recordings (roadmap L)
//
// With enough recordings, creating every WaveSurfer up front means dozens of
// instances and dozens of long audio fetches on one thread. Above the
// threshold the pane instead lays out every ROW (so scroll height and
// ordering are right from the start) and creates a recording's renderer only
// when it comes near the viewport, or when the user asks for it directly.
//
// The fixture has 20 recordings, all with precalculated peaks — the path that
// would otherwise auto-load all 20 at once. Their audio is stubbed from one
// small file (see stubManyRecordingAudio).
// ---------------------------------------------------------------------------

const ALL = Array.from({ length: 20 }, (_, i) => `lazy-${String(i + 1).padStart(2, '0')}.mp3`);
const FIRST = ALL[0];
const LAST = ALL[ALL.length - 1];

/** Filenames that currently have a rendered waveform. */
const rendered = (page: Page) =>
  page.evaluate(() => (window as any)._listenTest.renderedWaveforms as string[]);

/** Filenames with a row in the pane but no renderer yet. */
const deferred = (page: Page) =>
  page.evaluate(() => (window as any)._listenTest.deferredWaveforms as string[]);

/** Every filename with a row in the pane, renderer or not. */
const workingSet = (page: Page) =>
  page.evaluate(() => (window as any)._listenTest.waveformWorkingSet as string[]);

async function loadMany(page: Page) {
  await stubManyRecordingAudio(page);
  await loadLocalAlignment(page, ALIGNMENT_MANY);
  // Every row is laid out synchronously during the auto-load, so this settles
  // quickly and does not wait on any audio.
  await page.waitForFunction(
    (n) => ((window as any)._listenTest?.waveformWorkingSet?.length ?? 0) >= n,
    ALL.length,
    { timeout: 30_000 },
  );
}

test.describe('31. Lazy waveform creation', () => {

  // 31.1 The whole pane is laid out up front, but only a fraction of the
  // recordings get a renderer — that is the entire point of the feature.
  test('31.1 all rows exist but only near-viewport recordings are rendered', async ({ page }) => {
    await loadMany(page);
    expect((await workingSet(page)).sort()).toEqual([...ALL].sort());
    await expect(page.locator('#waveforms .waveform')).toHaveCount(ALL.length);

    // Wait for the build queue to drain rather than guessing a duration: the
    // app reports how many deferred waveforms are queued or mid-build.
    await page.waitForFunction(
      () => {
        const t = (window as any)._listenTest;
        return t.renderedWaveforms.length > 0 && t.materializePending === 0;
      },
      undefined,
      { timeout: 30_000 },
    );

    const live = await rendered(page);
    expect(live.length).toBeGreaterThan(0);
    // The pane fits ~4 rows; even with a generous prefetch margin this must be
    // far short of all 20, or nothing has actually been deferred.
    expect(live.length).toBeLessThan(ALL.length);
    expect(await deferred(page)).toContain(LAST);
  });

  // 31.2 A deferred row is honest about itself: it reserves its height and says
  // it is waiting, rather than showing a spinner that will never resolve.
  test('31.2 deferred rows show a quiet placeholder, not a spinner', async ({ page }) => {
    await loadMany(page);
    const lastRow = page.locator(`#waveforms .waveform[data-ix="${LAST}"]`);
    await expect(lastRow).toHaveClass(/wf-deferred/);
    await expect(lastRow.locator('.wf-deferred-note')).toBeVisible();
    // The reserved height keeps the scroll extent honest before anything loads.
    expect((await lastRow.boundingBox())!.height).toBeGreaterThan(100);
    // No spinner: the "Preparing…" overlay belongs to rows actually being built.
    await expect(lastRow.locator('.wf-resize-overlay')).toBeHidden();
  });

  // 31.3 Scrolling the pane brings deferred rows into range, and they render.
  test('31.3 scrolling into view materialises a deferred recording', async ({ page }) => {
    await loadMany(page);
    expect(await deferred(page)).toContain(LAST);

    await page.locator('#waveforms').evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });

    await page.waitForFunction(
      (fn) => ((window as any)._listenTest.renderedWaveforms as string[]).includes(fn),
      LAST,
      { timeout: 30_000 },
    );
    await expect(page.locator(`#waveforms .waveform[data-ix="${LAST}"]`)).not.toHaveClass(/wf-deferred/);
  });

  // 31.4 A deferred recording is already checked and on show — its row is in
  // the pane, just unbuilt. Hiding and re-showing it via the sidebar checkbox
  // must not claim it became ready, and must leave it able to build later.
  test('31.4 hiding and re-showing a deferred recording keeps it honest', async ({ page }) => {
    await loadMany(page);
    expect(await deferred(page)).toContain(LAST);
    const cb = page.locator(`#audios input[type="checkbox"][value="${LAST}"]`);
    const label = page.locator(`#audios li[id="${LAST}"] label`).first();
    const row = page.locator(`#waveforms .waveform[data-ix="${LAST}"]`);
    await expect(cb).toBeChecked();

    await cb.evaluate((el: HTMLInputElement) => el.click()); // hide
    await expect(row).toBeHidden();
    await expect(label).not.toHaveClass(/ready/);

    await cb.evaluate((el: HTMLInputElement) => el.click()); // show again
    await expect(row).toBeVisible();
    // Still unbuilt, so it must still say so rather than reporting ready.
    await expect(label).toHaveClass(/queued/);
    await expect(label).not.toHaveClass(/ready/);
    expect(await deferred(page)).toContain(LAST);

    // …and it still builds when it finally comes into view.
    await page.locator('#waveforms').evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await page.waitForFunction(
      (fn) => ((window as any)._listenTest.renderedWaveforms as string[]).includes(fn),
      LAST,
      { timeout: 30_000 },
    );
  });

  // 31.5 The sidebar distinguishes "queued behind the viewport" from "loading
  // right now", so a deferred recording is not reported as perpetually loading.
  test('31.5 sidebar marks deferred recordings queued, then ready once built', async ({ page }) => {
    await loadMany(page);
    const label = page.locator(`#audios li[id="${LAST}"] label`).first();
    await expect(label).toHaveClass(/queued/);

    await page.locator('#waveforms').evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect(label).toHaveClass(/ready/, { timeout: 30_000 });
    await expect(label).not.toHaveClass(/queued/);
  });

  // 31.6 Below the threshold nothing changes: the ordinary fixture must still
  // build every one of its recordings eagerly, with no deferred rows at all.
  test('31.6 a small alignment is unaffected — nothing is deferred', async ({ page }) => {
    await loadLocalAlignment(page);
    // Wait on this recording actually being rendered, not on waitForWaveformsReady:
    // that helper returns immediately while no checkbox is checked yet, which on a
    // loaded machine happens before the auto-load has even started.
    await page.waitForFunction(
      (fn) => ((window as any)._listenTest?.renderedWaveforms ?? []).includes(fn),
      AUDIO_A,
      { timeout: 30_000 },
    );
    expect(await deferred(page)).toEqual([]);
  });

  // 31.7 Arrow-key navigation reaches deferred recordings: they are in the
  // pane, so stepping onto one must build it and make it active rather than
  // skipping over it as though it were not there.
  test('31.7 arrow-down onto a deferred recording builds it and activates it', async ({ page }) => {
    await loadMany(page);
    await page.waitForFunction(
      (fn) => ((window as any)._listenTest.renderedWaveforms as string[]).includes(fn),
      FIRST,
      { timeout: 30_000 },
    );
    // Make the first recording active, then step down until we cross into a
    // recording that had been deferred.
    await page.evaluate((fn) => {
      (window as any)._listenTest.swapCurrentAudio(fn);
      (document.activeElement as HTMLElement)?.blur();
    }, FIRST);

    const wasDeferred = await deferred(page);
    const target = ALL.find((f) => wasDeferred.includes(f))!;
    expect(target).toBeTruthy();

    const steps = ALL.indexOf(target) - ALL.indexOf(FIRST);
    for (let i = 0; i < steps; i++) {
      const expected = ALL[ALL.indexOf(FIRST) + i + 1];
      await page.keyboard.press('ArrowDown');
      // Each step may have to build a waveform before it can activate it, so
      // wait for the active recording to actually change rather than sleeping.
      await page.waitForFunction(
        (fn) => (window as any)._listenTest.currentAudioIx === fn,
        expected,
        { timeout: 30_000 },
      );
    }

    await page.waitForFunction(
      (fn) => ((window as any)._listenTest.renderedWaveforms as string[]).includes(fn),
      target,
      { timeout: 30_000 },
    );
    expect(await page.evaluate(() => (window as any)._listenTest.currentAudioIx)).toBe(target);
  });

  // 31.8 Applying a grouping rebuilds the whole pane (reloadWaveforms) and
  // re-parents every row. Both used to walk the RENDERER set, which under lazy
  // mode omits the deferred majority — so applying a group would have dropped
  // them from the pane entirely, and left the ones that survived in the wrong
  // container. Covers both reclassified sites in one pass, since applying a
  // grouping is the only thing that calls reloadWaveforms.
  test('31.8 applying a grouping keeps deferred rows and moves them into the group', async ({ page }) => {
    await loadMany(page);
    expect(await deferred(page)).toContain(LAST);

    await page.evaluate(() => (document.getElementById('group-files-btn') as HTMLElement).click());
    await page.waitForSelector('.gm-modal', { state: 'visible' });
    await page.locator('.gm-add-group').click();
    // Add by filename rather than dragging: the gesture is irrelevant here, the
    // rebuild that follows is what is under test.
    await page.locator('.gm-group-card .gm-addby-input').fill(LAST);
    await page.locator('.gm-group-card .gm-addby-btn').click();
    await page.locator('.gm-apply').click();
    await page.waitForSelector('.gm-modal', { state: 'detached' });

    // Nothing fell out of the pane during the rebuild.
    await expect(page.locator('#waveforms .waveform')).toHaveCount(ALL.length);

    // …and the deferred recording landed in the new group, not in ungrouped.
    const row = page.locator(`#waveforms .waveform[data-ix="${LAST}"]`);
    await expect(row).toHaveCount(1);
    const inUngrouped = await row.evaluate(
      (el) => !!el.closest('.file-group-ungrouped'),
    );
    expect(inUngrouped).toBe(false);
    expect(await row.evaluate((el) => !!el.closest('.file-group'))).toBe(true);
  });
});
