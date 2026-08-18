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

async function pickFiles(page: Page, files: string[]) {
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.click('#file-picker-files-btn'),
  ]);
  await chooser.setFiles(files);
  await expect(page.locator('#file-picker-continue')).toBeVisible({ timeout: 15_000 });
  await page.click('#file-picker-continue');
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

/** Load another alignment over the loaded one via "Manage recordings". */
async function loadOver(page: Page, json: string, audioKeys: string[] = B_KEYS) {
  await page.click('#manage-files-btn');
  await pickFiles(page, [json, ...audioKeys.map((k) => path.join(FIXTURES_DIR, k))]);
}

const readState = (page: Page) =>
  page.evaluate(() => {
    const t: any = (window as any)._listenTest;
    return {
      wavesurfers: Object.keys(t.wavesurfers),
      grids: Object.keys(t.alignmentGrids),
      loaded: t.loaded,
      currentAudioIx: t.currentAudioIx,
    };
  });

test.describe('25. Replacing the loaded piece (#32)', () => {
  // 25.1 confirming replaces the piece outright — no state from the old one
  test('25.1 accepting the prompt tears the previous piece down', async ({ page }) => {
    const bJson = makePieceB();
    const typeErrors: string[] = [];
    page.on('pageerror', (e) => typeErrors.push(e.message));

    await loadPieceA(page);
    page.on('dialog', (d) => d.accept());
    await loadOver(page, bJson);

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
    expect(typeErrors).toEqual([]);
  });

  // 25.2 declining leaves the loaded piece exactly as it was
  test('25.2 dismissing the prompt abandons the load', async ({ page }) => {
    const bJson = makePieceB();
    const typeErrors: string[] = [];
    page.on('pageerror', (e) => typeErrors.push(e.message));

    await loadPieceA(page);
    const before = await readState(page);
    page.on('dialog', (d) => d.dismiss());
    await loadOver(page, bJson);
    await page.waitForTimeout(2000);

    const after = await readState(page);
    expect(after.grids.sort()).toEqual(before.grids.sort());
    for (const k of B_KEYS) expect(after.grids).not.toContain(k);
    expect(after.currentAudioIx).toBe(before.currentAudioIx);
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

    page.on('dialog', (d) => d.accept());
    await loadOver(page, bJson);
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
    let prompted = false;

    await loadPieceA(page);
    page.on('dialog', (d) => {
      prompted = true;
      d.accept();
    });
    await loadOver(page, other, A_KEYS);
    await page.waitForTimeout(4000);

    expect(prompted).toBe(true);
    expect(errors).toEqual([]);
  });

  // 25.5 same piece with one recording dropped: no prompt, but the waveform
  // whose grid disappeared must not survive (it would throw on projection)
  test('25.5 a recording missing from the new alignment is torn down', async ({ page }) => {
    const subset = makeSamePieceFewerRecordings('audio-c.mp3');
    const errors = collectErrors(page);
    let prompted = false;

    await loadPieceA(page);
    await expect
      .poll(() => page.evaluate(() => Object.keys((window as any)._listenTest.wavesurfers)), {
        timeout: 30_000,
      })
      .toContain('audio-c.mp3');

    page.on('dialog', (d) => {
      prompted = true;
      d.accept();
    });
    await loadOver(page, subset, A_KEYS);

    await expect
      .poll(() => page.evaluate(() => Object.keys((window as any)._listenTest.wavesurfers)), {
        timeout: 20_000,
      })
      .not.toContain('audio-c.mp3');

    const state = await readState(page);
    expect(prompted).toBe(false); // same piece — managing its recordings
    expect(state.grids).not.toContain('audio-c.mp3');
    expect(state.loaded).not.toContain('audio-c.mp3');
    expect(state.grids).toContain('audio-a.mp3');
    expect(errors).toEqual([]);
  });

  // 25.6 audio-only alignments have no score to compare, so piece identity
  // rests on the warped time sequence (user's case: album filenames collide)
  test('25.6 audio-only, same recordings, different times reads as a different piece', async ({ page }) => {
    const errors = collectErrors(page);
    let prompted = false;

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

    page.on('dialog', (d) => {
      prompted = true;
      d.accept();
    });
    await loadOver(page, makeAudioOnly({ warp: 0.87 }), A_KEYS);
    await page.waitForTimeout(4000);

    expect(prompted).toBe(true);
    expect(errors).toEqual([]);
  });

  // 25.7 the same audio-only piece with fewer recordings must NOT prompt —
  // guards the fingerprint against false positives
  test('25.7 audio-only, identical times, fewer recordings does not prompt', async ({ page }) => {
    const errors = collectErrors(page);
    let prompted = false;

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

    page.on('dialog', (d) => {
      prompted = true;
      d.accept();
    });
    await loadOver(page, makeAudioOnly({ keep: ['audio-a.mp3', 'audio-b.mp3'] }), ['audio-a.mp3', 'audio-b.mp3']);

    // the dropped recording is pruned, the kept ones stay, and no prompt fires
    await expect
      .poll(() => page.evaluate(() => Object.keys((window as any)._listenTest.wavesurfers)), {
        timeout: 20_000,
      })
      .not.toContain('audio-c.mp3');
    const state = await readState(page);
    expect(prompted).toBe(false);
    expect(state.grids).toContain('audio-a.mp3');
    expect(errors).toEqual([]);
  });

});
