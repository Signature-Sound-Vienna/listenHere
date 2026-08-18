// 25. Replacing the loaded piece (issue #32)
//
// Loading an alignment whose recordings don't overlap the loaded ones is a
// different *piece*. It used to be layered on top, leaving stale renderers whose
// alignment grids had been replaced (TypeErrors on alignmentGrids[staleKey]).
// Now it asks first, then either tears the previous piece down or abandons the
// load.
import { test, expect, Page } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { stubExternalMei, FIXTURES_DIR } from '../support/helpers';

const A_KEYS = ['audio-a.mp3', 'audio-b.mp3', 'audio-c.mp3'];
const B_KEYS = ['audio-1.mp3', 'audio-2.mp3', 'audio-3.mp3'];
const SYNTH = 'Score (synthesised from MEI)';

/**
 * Piece B: the alignment fixture with its audio keys renamed, so it shares no
 * recording with piece A. Generated rather than committed — alignment.json is
 * 2 MB of inline peaks.
 */
function makePieceB(): string {
  const a = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, 'alignment.json'), 'utf8'));
  const audio = a.body.audio;
  a.body.audio = {
    'audio-1.mp3': audio['audio-a.mp3'],
    'audio-2.mp3': audio['audio-b.mp3'],
    'audio-3.mp3': audio['audio-c.mp3'],
  };
  a.header.ref = 'audio-2.mp3';
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lh-piece-b-')), 'alignment-B.json');
  fs.writeFileSync(out, JSON.stringify(a));
  return out;
}

/** Page errors plus TypeError-ish console errors; ignores unrelated 404 noise. */
function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/TypeError|undefined|is not a function/i.test(t)) errors.push('console: ' + t);
  });
  return errors;
}

/** Variant of the fixture with a different score, so it is a different piece. */
function makeOtherPieceSameRecordings(): string {
  const a = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, 'alignment.json'), 'utf8'));
  a.header.meiUri = a.header.meiUri.replace(/[^/]+\.mei$/, 'Some-Other-Piece.mei');
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lh-other-')), 'alignment-other.json');
  fs.writeFileSync(out, JSON.stringify(a));
  return out;
}

/** Same piece and score, but one recording fewer. */
function makeSamePieceFewerRecordings(dropKey: string): string {
  const a = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, 'alignment.json'), 'utf8'));
  delete a.body.audio[dropKey];
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lh-subset-')), 'alignment-subset.json');
  fs.writeFileSync(out, JSON.stringify(a));
  return out;
}

/**
 * Audio-only variant (no score at all), optionally warped and/or reduced to a
 * subset of recordings. Mirrors the real corpus, where recordings are named
 * after the album, so two pieces share filenames and only the alignment times
 * distinguish them.
 */
function makeAudioOnly(opts: { warp?: number; keep?: string[] } = {}): string {
  const a = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, 'alignment.json'), 'utf8'));
  delete a.header.meiUri;
  delete a.body.score;
  for (const [k, v] of Object.entries<any>(a.body.audio)) {
    if (opts.keep && !opts.keep.includes(k)) {
      delete a.body.audio[k];
      continue;
    }
    if (opts.warp) v.times = v.times.map((t: number) => +(t * opts.warp!).toFixed(4));
  }
  const tag = opts.warp ? 'warped' : 'same';
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), `lh-audioonly-${tag}-`)), 'alignment-ao.json');
  fs.writeFileSync(out, JSON.stringify(a));
  return out;
}

const CONFIRM = '.lh-v6-confirm-overlay';

/** Answer the styled replacement prompt (shares the annotation dialogs' shell). */
async function answerReplacePrompt(page: Page, action: 'replace' | 'keep') {
  await expect(page.locator(CONFIRM)).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.lh-v6-confirm-title')).toHaveText('Replace the loaded piece?');
  await page
    .locator(action === 'replace' ? '.lh-v6-confirm-ok' : '.lh-v6-confirm-cancel')
    .click();
  await expect(page.locator(CONFIRM)).toHaveCount(0);
}

/** Assert the prompt does NOT appear (the incoming alignment is the same piece). */
async function expectNoReplacePrompt(page: Page) {
  await page.waitForTimeout(1500);
  await expect(page.locator(CONFIRM)).toHaveCount(0);
}

/** Choose files in the picker. The replacement prompt (if any) fires on read. */
async function setPickerFiles(page: Page, files: string[]) {
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.click('#file-picker-files-btn'),
  ]);
  await chooser.setFiles(files);
}

async function clickContinue(page: Page) {
  await expect(page.locator('#file-picker-continue')).toBeVisible({ timeout: 15_000 });
  await page.click('#file-picker-continue');
}

async function pickFiles(page: Page, files: string[]) {
  await setPickerFiles(page, files);
  await clickContinue(page);
}

async function loadPieceA(page: Page) {
  await stubExternalMei(page);
  await page.goto('/?useFiles');
  await pickFiles(page, [
    path.join(FIXTURES_DIR, 'alignment.json'),
    ...A_KEYS.map((k) => path.join(FIXTURES_DIR, k)),
  ]);
  await page.waitForSelector('#audios input[type="checkbox"]', { state: 'visible', timeout: 20_000 });
  await expect
    .poll(() => page.evaluate(() => Object.keys((window as any)._listenTest.wavesurfers).length), {
      timeout: 20_000,
    })
    .toBeGreaterThan(0);
}

/**
 * Offer another alignment via "Manage recordings" — stops after the files are
 * read, which is when a different piece triggers the prompt. Callers answer it
 * (answerReplacePrompt / expectNoReplacePrompt), then clickContinue.
 */
async function offerOver(page: Page, json: string, audioKeys: string[] = B_KEYS) {
  await page.click('#manage-files-btn');
  await setPickerFiles(page, [json, ...audioKeys.map((k) => path.join(FIXTURES_DIR, k))]);
}

const readState = (page: Page) =>
  page.evaluate(() => {
    const t: any = (window as any)._listenTest;
    return {
      wavesurfers: Object.keys(t.wavesurfers),
      grids: Object.keys(t.alignmentGrids),
      loaded: t.loaded,
      currentAudioIx: t.currentAudioIx,
      headerRef: t.alignmentHeaderRef,
      expectedAudioKeys: t.expectedAudioKeys,
      retiredBlobUrlCount: t.retiredBlobUrlCount,
    };
  });

test.describe('25. Replacing the loaded piece (#32)', () => {
  // 25.1 confirming replaces the piece outright — no state from the old one
  test('25.1 accepting the prompt tears the previous piece down', async ({ page }) => {
    const bJson = makePieceB();
    const typeErrors: string[] = [];
    page.on('pageerror', (e) => typeErrors.push(e.message));

    await loadPieceA(page);
    // Remember the outgoing piece's object URLs so we can prove they are
    // revoked rather than stranded in the document's object-URL store.
    const outgoingUrls: string[] = await page.evaluate(
      () => (window as any)._listenTest.fileBlobUrlValues,
    );
    expect(outgoingUrls.length).toBeGreaterThan(0);

    await offerOver(page, bJson);
    await answerReplacePrompt(page, 'replace');
    await clickContinue(page);

    await expect
      .poll(async () => (await readState(page)).grids.filter((k) => k !== SYNTH).sort().join(), {
        timeout: 20_000,
      })
      .toBe(B_KEYS.join());

    const state = await readState(page);
    // No key from piece A survives, in grids or as a live renderer
    for (const k of A_KEYS) {
      expect(state.grids).not.toContain(k);
      expect(state.wavesurfers).not.toContain(k);
      expect(state.loaded).not.toContain(k);
    }
    // The active recording points at the new piece (or nothing yet)
    if (state.currentAudioIx) {
      expect([...B_KEYS, SYNTH]).toContain(state.currentAudioIx);
    }
    // The outgoing piece's object URLs were revoked, not stranded in the
    // document's object-URL store with no handle left to revoke them. A revoked
    // blob URL no longer resolves, so fetching it must fail.
    expect(state.retiredBlobUrlCount).toBe(0);
    const stillResolvable = await page.evaluate(async (urls: string[]) => {
      const alive: string[] = [];
      for (const u of urls) {
        try {
          const r = await fetch(u);
          if (r.ok) alive.push(u);
        } catch {
          /* revoked — expected */
        }
      }
      return alive;
    }, outgoingUrls);
    expect(stillResolvable).toEqual([]);
    expect(typeErrors).toEqual([]);
  });

  // 25.2 declining leaves the loaded piece exactly as it was
  test('25.2 dismissing the prompt abandons the load', async ({ page }) => {
    const bJson = makePieceB();
    const typeErrors: string[] = [];
    page.on('pageerror', (e) => typeErrors.push(e.message));

    await loadPieceA(page);
    const before = await readState(page);
    await offerOver(page, bJson);
    await answerReplacePrompt(page, 'keep');
    await page.waitForTimeout(2000);

    const after = await readState(page);
    expect(after.grids.sort()).toEqual(before.grids.sort());
    for (const k of B_KEYS) expect(after.grids).not.toContain(k);
    expect(after.currentAudioIx).toBe(before.currentAudioIx);

    // The app and the "Manage recordings" dialog must still describe the SAME
    // piece: declining used to leave loadedAlignmentJSON and the picker's
    // expected keys pointing at the piece that was never loaded.
    expect(after.headerRef).toBe(before.headerRef);
    expect(after.expectedAudioKeys.sort()).toEqual(before.expectedAudioKeys.sort());
    for (const k of B_KEYS) expect(after.expectedAudioKeys).not.toContain(k);
    await expect(page.locator('#file-picker-json-status')).toContainText('Kept the loaded piece');

    // …and closing the dialog afterwards must not apply it either
    await page.click('#file-picker-continue');
    await page.waitForTimeout(1500);
    const closed = await readState(page);
    expect(closed.grids.sort()).toEqual(before.grids.sort());
    expect(closed.headerRef).toBe(before.headerRef);
    expect(typeErrors).toEqual([]);
  });
  // 25.3 replacement while zoomed and playing — the cross-waveform scroll sync
  // runs only in that state, and it projects through the alignment grids
  test('25.3 replacing while zoomed and playing stays error-free', async ({ page }) => {
    const bJson = makePieceB();
    const errors = collectErrors(page);

    await loadPieceA(page);
    // every waveform up, so the sync loop has several targets to project onto
    await expect
      .poll(() => page.evaluate(() => (window as any)._listenTest.loaded.length), { timeout: 30_000 })
      .toBeGreaterThan(1);
    const zoom = page.locator('#zoom-slider');
    await zoom.fill('2');
    await zoom.dispatchEvent('input');
    await page.click('#playpause');
    await page.waitForTimeout(1500);

    await offerOver(page, bJson);
    await answerReplacePrompt(page, 'replace');
    await clickContinue(page);
    await page.waitForTimeout(6000);

    const state = await readState(page);
    console.log('STATE AFTER REPLACE:', JSON.stringify(state));
    console.log('ERRORS:', JSON.stringify(errors, null, 1));
    expect(errors).toEqual([]);
  });

  // 25.4 recordings overlap but the score differs — a shared key set is NOT
  // evidence of the same piece (corpora align several pieces over one corpus)
  test('25.4 same recordings, different score, is treated as a different piece', async ({ page }) => {
    const other = makeOtherPieceSameRecordings();
    const errors = collectErrors(page);

    await loadPieceA(page);
    await offerOver(page, other, A_KEYS);
    await answerReplacePrompt(page, 'replace');
    await clickContinue(page);
    await page.waitForTimeout(3000);

    expect(errors).toEqual([]);
  });

  // 25.5 same piece with one recording dropped: no prompt, but the waveform
  // whose grid disappeared must not survive (it would throw on projection)
  test('25.5 a recording missing from the new alignment is torn down', async ({ page }) => {
    const subset = makeSamePieceFewerRecordings('audio-c.mp3');
    const errors = collectErrors(page);

    await loadPieceA(page);
    await expect
      .poll(() => page.evaluate(() => Object.keys((window as any)._listenTest.wavesurfers)), {
        timeout: 30_000,
      })
      .toContain('audio-c.mp3');

    await offerOver(page, subset, A_KEYS);
    await expectNoReplacePrompt(page);
    await clickContinue(page);

    await expect
      .poll(() => page.evaluate(() => Object.keys((window as any)._listenTest.wavesurfers)), {
        timeout: 20_000,
      })
      .not.toContain('audio-c.mp3');

    const state = await readState(page);
    expect(state.grids).not.toContain('audio-c.mp3');
    expect(state.loaded).not.toContain('audio-c.mp3');
    expect(state.grids).toContain('audio-a.mp3');
    expect(errors).toEqual([]);
  });

  // 25.6 audio-only alignments have no score to compare, so piece identity
  // rests on the warped time sequence (user's case: album filenames collide)
  test('25.6 audio-only, same recordings, different times reads as a different piece', async ({ page }) => {
    const errors = collectErrors(page);

    // load an audio-only piece first, so neither side has a score
    await stubExternalMei(page);
    await page.goto('/?useFiles');
    await pickFiles(page, [
      makeAudioOnly(),
      ...A_KEYS.map((k) => path.join(FIXTURES_DIR, k)),
    ]);
    await page.waitForSelector('#audios input[type="checkbox"]', { state: 'visible', timeout: 20_000 });
    await expect
      .poll(() => page.evaluate(() => Object.keys((window as any)._listenTest.wavesurfers).length), {
        timeout: 20_000,
      })
      .toBeGreaterThan(0);

    await offerOver(page, makeAudioOnly({ warp: 0.87 }), A_KEYS);
    await answerReplacePrompt(page, 'replace');
    await clickContinue(page);
    await page.waitForTimeout(3000);

    expect(errors).toEqual([]);
  });

  // 25.7 the same audio-only piece with fewer recordings must NOT prompt —
  // guards the fingerprint against false positives
  test('25.7 audio-only, identical times, fewer recordings does not prompt', async ({ page }) => {
    const errors = collectErrors(page);

    await stubExternalMei(page);
    await page.goto('/?useFiles');
    await pickFiles(page, [
      makeAudioOnly(),
      ...A_KEYS.map((k) => path.join(FIXTURES_DIR, k)),
    ]);
    await page.waitForSelector('#audios input[type="checkbox"]', { state: 'visible', timeout: 20_000 });
    await expect
      .poll(() => page.evaluate(() => Object.keys((window as any)._listenTest.wavesurfers)), {
        timeout: 20_000,
      })
      .toContain('audio-c.mp3');

    await offerOver(page, makeAudioOnly({ keep: ['audio-a.mp3', 'audio-b.mp3'] }), ['audio-a.mp3', 'audio-b.mp3']);
    await expectNoReplacePrompt(page);
    await clickContinue(page);

    // the dropped recording is pruned, the kept ones stay, and no prompt fires
    await expect
      .poll(() => page.evaluate(() => Object.keys((window as any)._listenTest.wavesurfers)), {
        timeout: 20_000,
      })
      .not.toContain('audio-c.mp3');
    const state = await readState(page);
    expect(state.grids).toContain('audio-a.mp3');
    expect(errors).toEqual([]);
  });

});
