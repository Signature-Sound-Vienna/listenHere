import * as fs from 'fs';
import { test, expect } from '../support/fixtures';
import type { Page } from '@playwright/test';
import {
  ALIGNMENT_JSON, ALIGNMENT_MANY, AUDIO_A, AUDIO_B,
} from '../support/fixtures';
import {
  loadLocalAlignment, showWaveform, waitForWaveformsReady, play, pause,
  stubManyRecordingAudio, loadViaFilePicker, readFixtureJson, FIXTURES_DIR,
} from '../support/helpers';
import { env } from '../support/env';

// ---------------------------------------------------------------------------
// Section 49 — Session recovery: unsaved work survives losing the tab.
//
// Two layers. A beforeunload guard asks before a tab with unsaved work is
// closed, reloaded, or navigated away from. Behind it, the editable part of the
// alignment (header: markers, grouping tabs; and the annotations) is
// snapshotted into localStorage a moment after each change, keyed by a
// per-load session id, and offered back when the same piece is loaded again.
// The grids (body) are NOT snapshotted: ~12 MB for a real piece, against
// localStorage's ~5 MB.
// ---------------------------------------------------------------------------

const PREFIX = 'lh-recovery:';
const PICKED_AUDIO = ['audio-a.mp3', 'audio-b.mp3', 'audio-c.mp3', 'audio-short.mp3'];

async function waitForLoad(page: Page, after = 0) {
  await page.waitForFunction(
    (n) => ((window as any)._listenTest?.loadGeneration ?? 0) > n,
    after,
    { timeout: 40_000 },
  );
}

/** The fixture's own setup, repeatable after a reload. */
async function loadPiece(page: Page) {
  await loadLocalAlignment(page, ALIGNMENT_JSON);
  await waitForLoad(page);
  await showWaveform(page, AUDIO_A);
  await showWaveform(page, AUDIO_B);
  await waitForWaveformsReady(page);
  await page
    .locator(`#waveforms .waveform[data-ix="${AUDIO_A}"]`)
    .click({ position: { x: 10, y: 10 }, force: true });
  await page.waitForTimeout(200);
}

async function addMarker(page: Page) {
  await play(page);
  await page.waitForTimeout(400);
  await pause(page);
  await page.keyboard.press('m');
  await page.waitForTimeout(200);
}

async function newAnnotation(page: Page): Promise<string> {
  await page.locator('.lh-v6-ribbon-new').click();
  return page.evaluate(() => (window as any).__annotationV6.state.getActiveId());
}

/** Every recovery snapshot in localStorage, parsed. */
function snapshots(page: Page): Promise<any[]> {
  return page.evaluate((prefix) => {
    const out: any[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)!;
      if (k.startsWith(prefix)) out.push(JSON.parse(localStorage.getItem(k)!));
    }
    return out;
  }, PREFIX);
}

async function waitForDirtySnapshot(page: Page) {
  await expect
    .poll(async () => (await snapshots(page)).filter((s) => s.dirty).length, {
      timeout: 6_000,
    })
    .toBe(1);
}

/** Reload, accepting the beforeunload prompt if one appears; returns its type. */
async function reloadAccepting(page: Page): Promise<string | null> {
  let seen: string | null = null;
  const onDialog = (d: any) => {
    seen = d.type();
    void d.accept();
  };
  page.on('dialog', onDialog);
  await page.reload();
  page.off('dialog', onDialog);
  return seen;
}

test.describe('49. Session recovery', () => {

  // 49.1 The guard: unsaved work prompts on reload, a clean page does not.
  test('49.1 beforeunload asks only when there is unsaved work', async ({ loadedPage: page }) => {
    expect(await reloadAccepting(page)).toBeNull();
    await loadPiece(page);
    await addMarker(page);
    expect(await reloadAccepting(page)).toBe('beforeunload');
  });

  // 49.2 A change lands in localStorage without any save, with what is needed
  // to recognise the piece again and to describe it.
  test('49.2 a change is snapshotted shortly after it is made', async ({ loadedPage: page }) => {
    expect(await snapshots(page)).toHaveLength(0); // a clean load writes nothing
    await addMarker(page);
    await waitForDirtySnapshot(page);
    const [s] = await snapshots(page);
    expect(s.v).toBe(1);
    expect(s.header.markers).toHaveLength(1);
    expect(s.recordings).toBe(4);
    expect(typeof s.fingerprint).toBe('string');
    expect(s.source).toContain(ALIGNMENT_JSON);
    // The grids are not copied.
    expect(s.body).toBeUndefined();
  });

  // 49.3 Losing the tab and loading the same piece again offers the work back,
  // and restoring it brings back markers and annotations, still unsaved.
  test('49.3 restore after a reload brings markers and annotations back', async ({ loadedPage: page }) => {
    await addMarker(page);
    const annId = await newAnnotation(page);
    await waitForDirtySnapshot(page);
    // Let the annotation's own write land too (it follows the marker's).
    await expect
      .poll(async () => (await snapshots(page))[0]?.annotations?.length, { timeout: 6_000 })
      .toBe(1);

    await reloadAccepting(page);
    await loadPiece(page);
    const banner = page.locator('#recovery-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('1 marker');
    await expect(banner).toContainText('1 annotation');

    const gen = await page.evaluate(() => (window as any)._listenTest.loadGeneration);
    await banner.locator('.recovery-restore').first().click();
    await waitForLoad(page, gen);
    await expect(banner).toBeHidden();

    expect(await page.evaluate(() => (window as any)._listenTest.markers.length)).toBe(1);
    const ids = await page.evaluate(() =>
      (window as any).__annotationV6.state.getAll().map((a: any) => a.id),
    );
    expect(ids).toEqual([annId]);
    // Restored work is not on disk yet: still dirty, still guarded, and the
    // session carries on in the SAME snapshot rather than starting another.
    await expect(page.locator('#download-json-btn')).toHaveClass(/json-dirty/);
    await page.waitForTimeout(2_500);
    expect(await snapshots(page)).toHaveLength(1);
  });

  // 49.4 Saving retires the offer: a downloaded session is not offered back.
  test('49.4 after a download nothing is offered back', async ({ loadedPage: page }) => {
    await addMarker(page);
    await waitForDirtySnapshot(page);
    await Promise.all([
      page.waitForEvent('download'),
      page.locator('#download-json-btn').click(),
    ]);
    await expect
      .poll(async () => (await snapshots(page)).filter((s) => s.dirty).length, { timeout: 6_000 })
      .toBe(0);
    expect(await reloadAccepting(page)).toBeNull();
    await loadPiece(page);
    await page.waitForTimeout(500);
    await expect(page.locator('#recovery-banner')).toBeHidden();
  });

  // 49.5 Discard deletes the snapshot for good.
  test('49.5 discard removes the snapshot', async ({ loadedPage: page }) => {
    await addMarker(page);
    await waitForDirtySnapshot(page);
    await reloadAccepting(page);
    await loadPiece(page);
    const banner = page.locator('#recovery-banner');
    await expect(banner).toBeVisible();
    await banner.locator('.recovery-discard').first().click();
    await expect(banner).toBeHidden();
    expect(await snapshots(page)).toHaveLength(0);
    expect(await page.evaluate(() => (window as any)._listenTest.markers.length)).toBe(0);
  });

  // 49.6 A different piece is not offered someone else's work.
  test('49.6 a different piece shows no banner', async ({ loadedPage: page }) => {
    await addMarker(page);
    await waitForDirtySnapshot(page);
    await reloadAccepting(page);
    await stubManyRecordingAudio(page);
    await loadLocalAlignment(page, ALIGNMENT_MANY);
    await waitForLoad(page);
    await page.waitForTimeout(500);
    await expect(page.locator('#recovery-banner')).toBeHidden();
    expect(await snapshots(page)).toHaveLength(1); // kept, not touched
  });

  // 49.8 The pure rules, without an app boot (spec 40's pattern): identity,
  // matching, pruning, and which header fields a restore keeps as loaded.
  test('49.8 fingerprint, offers, pruning, and the restored header', async ({ page }) => {
    await page.goto('/static/js/engine/session-recovery.js'); // any same-origin page
    const r = await page.evaluate(async () => {
      const m: any = await import('/static/js/engine/session-recovery.js');
      localStorage.clear();
      const fp = m.pieceFingerprint('s.mei', ['b.wav', 'a.wav']);
      const now = Date.now();
      const snap = (id: string, o: any = {}) => ({
        v: 1, id, fingerprint: fp, source: id, recordings: 2, startedAt: now,
        updatedAt: now, dirty: true, header: { markers: [1] }, annotations: [], ...o,
      });
      m.writeSnapshot(localStorage, snap('match'));
      m.writeSnapshot(localStorage, snap('clean', { dirty: false }));
      m.writeSnapshot(localStorage, snap('other', { fingerprint: 'ffffffff' }));
      m.writeSnapshot(localStorage, snap('same', { header: { markers: [] } }));
      m.writeSnapshot(localStorage, snap('old', { updatedAt: now - 31 * 864e5 }));
      const offers = m
        .offersFor(localStorage, {
          fingerprint: fp, currentId: 'live',
          loadedSignature: m.contentSignature({ markers: [] }, []),
        })
        .map((s: any) => s.id)
        .sort();
      m.pruneSnapshots(localStorage, { now });
      const afterAge = m.listSnapshots(localStorage).map((s: any) => s.id).sort();
      m.pruneSnapshots(localStorage, { now, maxCount: 1, keepId: 'other' });
      const afterCount = m.listSnapshots(localStorage).map((s: any) => s.id);
      const header = m.restoredHeader(
        { ref: 'a.wav', meiUri: 's.mei', alignmentParams: { p: 1 }, markers: [] },
        { ref: 'b.wav', meiUri: 'x.mei', markers: [5], activeTab: 'T' },
      );
      const mei =
        '<mei xmlns="http://www.music-encoding.org/ns/mei"><meiHead><fileDesc><titleStmt>' +
        '<title>Die Fledermaus:\n   Ouvertüre</title></titleStmt></fileDesc></meiHead></mei>';
      return {
        names: [
          m.alignmentFileName('Fledermaus: expert/set'),
          m.alignmentFileName('  '),
          m.alignmentFileName(undefined),
          m.alignmentFileName('..hidden'),
        ],
        title: m.meiTitle(mei),
        noTitle: m.meiTitle('<mei/>'),
        orderFree: fp === m.pieceFingerprint('s.mei', ['a.wav', 'b.wav']),
        scoreMatters: fp !== m.pieceFingerprint('t.mei', ['a.wav', 'b.wav']),
        offers, afterAge, afterCount, header,
      };
    });
    expect(r.names).toEqual([
      'Fledermaus- expert-set.json', 'alignment.json', 'alignment.json', 'hidden.json',
    ]);
    expect(r.title).toBe('Die Fledermaus: Ouvertüre');
    expect(r.noTitle).toBe('');
    expect(r.orderFree).toBe(true);
    expect(r.scoreMatters).toBe(true);
    // Not the clean one, not another piece, not one identical to what loaded.
    expect(r.offers).toEqual(['match', 'old']);
    expect(r.afterAge).toEqual(['clean', 'match', 'other', 'same']);
    expect(r.afterCount).toHaveLength(2); // the newest one plus the kept id
    expect(r.afterCount).toContain('other');
    expect(r.header).toEqual({
      ref: 'a.wav', meiUri: 's.mei', alignmentParams: { p: 1 }, markers: [5], activeTab: 'T',
    });
  });

  // 49.9 The session label: prefilled from the file name, edited on the Manage
  // recordings screen, saved in the alignment's header, shown in recovery.
  test('49.9 the session label is prefilled, saved with the file, and shown when recovering', async ({ page }) => {
    await loadViaFilePicker(page, [ALIGNMENT_JSON, ...PICKED_AUDIO]);
    const label = page.locator('#file-picker-label');
    await expect(label).toBeVisible();
    await expect(label).toHaveValue('alignment');
    await label.fill('Fledermaus, expert set');
    await expect(page.locator('#file-picker-continue')).toBeVisible({ timeout: 15_000 });
    await page.click('#file-picker-continue');
    await waitForLoad(page);
    await waitForWaveformsReady(page);
    await page
      .locator(`#waveforms .waveform[data-ix="${AUDIO_A}"]`)
      .click({ position: { x: 10, y: 10 }, force: true });

    await addMarker(page);
    await waitForDirtySnapshot(page);
    expect((await snapshots(page))[0].header.label).toBe('Fledermaus, expert set');

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('#download-json-btn').click(),
    ]);
    // The file is named after the session.
    expect(download.suggestedFilename()).toBe('Fledermaus, expert set.json');
    const saved = JSON.parse(fs.readFileSync((await download.path())!, 'utf8'));
    expect(saved.header.label).toBe('Fledermaus, expert set');

    // Unsaved again, then renamed mid-session: the snapshot follows the rename.
    await addMarker(page);
    await waitForDirtySnapshot(page);
    await page.locator('#manage-files-btn').click();
    await page.locator('#file-picker-label').fill('Fledermaus expert, Desktop/FM');
    await expect
      .poll(async () => (await snapshots(page))[0].header.label, { timeout: 6_000 })
      .toBe('Fledermaus expert, Desktop/FM');
    await expect(page.locator('#download-json-btn')).toHaveAttribute(
      'title', /Kept in this browser as "Fledermaus expert, Desktop\/FM"/,
    );

    // Then lost: the picker's notice leads with the label.
    const onDialog = (d: any) => void d.accept();
    page.on('dialog', onDialog);
    await page.goto('/?useFiles');
    page.off('dialog', onDialog);
    const notice = page.locator('#file-picker-recovery');
    await expect(notice).toContainText('Fledermaus expert, Desktop/FM');
    // ...and names the file it was last saved as, not the one first loaded.
    await expect(notice).toContainText('Fledermaus, expert set.json');
  });

  // 49.10 A label already in the file wins over the file name.
  test('49.10 a file that carries a label prefills it', async ({ page }) => {
    const labelled = readFixtureJson(ALIGNMENT_JSON);
    labelled.header.label = 'Romanze, take 2';
    const file = test.info().outputPath('alignment (3).json');
    fs.writeFileSync(file, JSON.stringify(labelled));
    await loadViaFilePicker(page, [file, ...PICKED_AUDIO]);
    await expect(page.locator('#file-picker-label')).toHaveValue('Romanze, take 2');
  });

  // 49.11 Leaving through the app's own links gets the app's own dialog,
  // which can say what is unsaved and how to get it back; the browser's
  // generic prompt cannot, and is not shown on top of it.
  test('49.11 the logo link asks in full, and Leave skips the browser prompt', async ({ loadedPage: page }) => {
    await addMarker(page);
    await newAnnotation(page);
    await page.locator('.nav-logo').click();
    const dialog = page.locator('.lh-v6-confirm-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Leave this page?');
    await expect(dialog).toContainText('markers');
    await expect(dialog).toContainText('Kept in this browser');
    await expect(dialog).toContainText(ALIGNMENT_JSON);

    await dialog.locator('.lh-v6-confirm-cancel').click(); // Stay
    await expect(dialog).toBeHidden();
    expect(page.url()).toContain('align=');

    let browserPrompt = false;
    page.on('dialog', (d) => { browserPrompt = true; void d.accept(); });
    await page.locator('.nav-logo').click();
    await Promise.all([
      page.waitForURL((u) => !u.search.includes('align=')),
      page.locator('.lh-v6-confirm-dialog .lh-v6-confirm-ok').click(), // Leave
    ]);
    expect(browserPrompt).toBe(false);
  });

  // 49.12 The unsaved-changes tooltip says what is unsaved and where a copy is.
  test('49.12 the Save data tooltip names the unsaved work and its kept copy', async ({ loadedPage: page }) => {
    await addMarker(page);
    await waitForDirtySnapshot(page);
    const title = page.locator('#download-json-btn');
    await expect(title).toHaveAttribute('title', /markers, grouping, and\/or alignment/);
    await expect(title).toHaveAttribute('title', /Kept in this browser/);
  });

  // 49.13–49.14 run a real alignment in the wizard, on SHORT recordings only
  // (two copies of the 100 KB fixture under two names; ~10 s per test).
  async function alignShort(page: Page) {
    await page.goto('/?mode=align');
    await page.waitForLoadState('networkidle');
    const short = fs.readFileSync(`${FIXTURES_DIR}/audio-short.mp3`);
    await page.locator('#align-file-input').setInputFiles([
      { name: 'short-a.mp3', mimeType: 'audio/mpeg', buffer: short },
      { name: 'short-b.mp3', mimeType: 'audio/mpeg', buffer: short },
    ]);
    await expect(page.locator('#align-file-table tbody tr').first()).toBeVisible({ timeout: 20_000 });
    for (const _ of [1, 2]) {
      const before = await page.locator('.align-step.active').getAttribute('data-step');
      await page.click('#align-next-btn');
      await expect(page.locator('.align-step.active')).not.toHaveAttribute('data-step', before!);
    }
    await page.locator('#align-mei-input').fill(
      `${env.baseUrl}/static/test/Schumann-Clara_Romanze-ohne-Opuszahl_a-Moll.mei`,
    );
    await page.click('#align-next-btn');
    await expect(page.locator('#align-start-btn')).toBeVisible();
    await page.click('#align-start-btn');
    await expect(page.locator('#align-results')).toBeVisible({ timeout: 60_000 });
  }

  // 49.13 An alignment never saved is unsaved work, in the wizard and after.
  test('49.13 a wizard alignment never saved counts as unsaved', async ({ page }) => {
    await alignShort(page);
    await expect(page.locator('#align-label-input')).toHaveValue('Romanze'); // the score's title
    // The wizard page guards its result. Asked directly rather than through a
    // reload: dismissing the browser's prompt closes the page under Playwright.
    const guarded = () =>
      page.evaluate(() => {
        const e = new Event('beforeunload', { cancelable: true });
        window.dispatchEvent(e);
        return e.defaultPrevented;
      });
    expect(await guarded()).toBe(true);

    await page.click('#align-open-btn');
    await waitForLoad(page);
    await expect(page.locator('#download-json-btn')).toHaveClass(/json-dirty/);
    await expect(page.locator('#download-json-btn')).toHaveAttribute('title', /not been saved to a file/);
    // Save data clears it.
    await Promise.all([page.waitForEvent('download'), page.locator('#download-json-btn').click()]);
    await expect(page.locator('#download-json-btn')).not.toHaveClass(/json-dirty/);
    expect(await guarded()).toBe(false);
  });

  // 49.14 Saved in the wizard, the listen view knows: nothing is unsaved.
  test('49.14 a wizard alignment saved before Listen! is not unsaved', async ({ page }) => {
    await alignShort(page);
    await page.locator('#align-label-input').fill('Romanze, two takes');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#align-download-btn')]);
    expect(dl.suggestedFilename()).toBe('Romanze, two takes.json');
    await page.click('#align-open-btn');
    await waitForLoad(page);
    await expect(page.locator('#download-json-btn')).not.toHaveClass(/json-dirty/);
    // Its recovery notes name the saved file.
    await newAnnotation(page);
    await expect(page.locator('#download-json-btn')).toHaveAttribute('title', /Kept in this browser as "Romanze, two takes"/, { timeout: 6_000 });
  });

  // 49.7 The file picker names the files that unsaved work needs.
  test('49.7 the file picker lists unsaved work and the files it needs', async ({ loadedPage: page }) => {
    await addMarker(page);
    await waitForDirtySnapshot(page);
    await reloadAccepting(page);
    await page.goto('/?useFiles');
    const notice = page.locator('#file-picker-recovery');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText(ALIGNMENT_JSON);
    await expect(notice).toContainText('4 recordings');
  });
});
