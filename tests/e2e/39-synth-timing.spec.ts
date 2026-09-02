// 39. Synth timing correction
//
// align-worker.js's embedded Python seeded tempo_changes with (0, 500000) and
// sorted TUPLES, so a real tempo event at tick 0 lost the tie to the seeded
// 120 BPM default (the tie broke by tempo VALUE, and _tick_to_sec lets the
// last same-tick entry win). Every synth_onset/synth_offset in an alignment
// JSON generated that way carries the skew — Fledermaus opens 20% slow,
// +4.000 s by quarter 48 — and so did the synthesised audio the DTW aligned
// against. The worker sort is fixed (sort by tick only, stable), but
// already-generated JSONs keep the skewed tables and regeneration cannot be
// assumed, so listen.js now derives corrected tables from the MIDI Verovio
// actually renders (matching alignment-event score quarters against note
// ticks) and prefers those over the stored values.
//
// 39.1 guards the derivation and the defence: stored synth tables are ignored
// even when deliberately skewed by the historical +4 s. 39.2 guards the
// fallback: when score_onset cannot be matched, the stored tables still apply
// and the load survives. 39.3 guards the worker fix itself, running the
// worker's own embedded Python on a synthetic MIDI whose real tempo event
// sits at tick 0 — and checks the engine's JS parser agrees on the same bytes.
import { test, expect } from '../support/fixtures';
import {
  loadLocalAlignment,
  FIXTURES_DIR,
  readFixtureJson,
  localiseFixtureText,
} from '../support/helpers';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

const SYNTH_SEL = '#waveforms .waveform[data-ix="Score (synthesised from MEI)"]';

const readFixture = () => readFixtureJson('alignment.json');

/**
 * Serve every /static/test/ fixture from THIS checkout's tests/fixtures/,
 * so the spec is hermetic: what the page loads is exactly the tree under
 * test's fixtures, whatever server answers on the base URL. JSON is
 * localised the way the Flask fixture route localises it (the fixtures'
 * absolute URLs follow APP_BASE_URL), so the MEI is fetched from the same
 * server as everything else.
 */
async function serveFixturesFromDisk(page: import('@playwright/test').Page) {
  // Match on the PATH, not a '**/static/test/**' glob: the listen page's own
  // navigation URL carries '/static/test/' inside its ?align= query, and the
  // glob would intercept (and break) the navigation itself.
  await page.route(
    (url) => url.pathname.startsWith('/static/test/'),
    (route) => {
      const name = decodeURIComponent(
        new URL(route.request().url()).pathname.split('/').pop()!,
      );
      const file = path.join(FIXTURES_DIR, name);
      if (!fs.existsSync(file) || !fs.statSync(file).isFile())
        return route.fulfill({ status: 404, body: 'no fixture' });
      if (name.endsWith('.json')) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: localiseFixtureText(fs.readFileSync(file, 'utf8')),
        });
      }
      const contentType = name.endsWith('.mei')
        ? 'application/xml; charset=utf-8'
        : name.endsWith('.mp3')
          ? 'audio/mpeg'
          : 'application/octet-stream';
      return route.fulfill({ status: 200, contentType, path: file });
    },
  );
}

/** Serve a modified alignment.json (registered last, so it wins the route). */
async function serveAlignment(page: import('@playwright/test').Page, fixture: unknown) {
  await page.route(
    (url) => url.pathname === '/static/test/alignment.json',
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(fixture),
      }),
  );
}

/** Corrected tables, stored tables, and a synth-grid fingerprint from the page. */
async function synthState(page: import('@playwright/test').Page) {
  return page.evaluate(async () => {
    const m: any = await import('/static/js/listen.js');
    const grid: number[] | undefined = m.alignmentGrids?.[m.SYNTH_MEI_KEY];
    const sample = (a?: number[] | null) =>
      a && a.length ? [a[0], a[Math.floor(a.length / 2)], a[a.length - 1]] : null;
    return {
      correctedLen: m.correctedSynthOnsets?.length ?? null,
      correctedSample: sample(m.correctedSynthOnsets),
      correctedOffsetsLen: m.correctedSynthOffsets?.length ?? null,
      storedFirstOnset: m.scoreAlignment?.synth_onset?.[0] ?? null,
      gridLen: grid?.length ?? null,
      gridSample: sample(grid),
    };
  });
}

test.describe('39. Synth timing correction', () => {
  // 39.1 The A/B control: one load with the pristine fixture, one with its
  // stored synth tables skewed the way the worker bug skewed them. The synth
  // alignment grid must come out identical, because both runs derive it from
  // the rendered MIDI and never read the stored tables.
  test('39.1 a planted skew in the stored synth tables does not move the synth grid', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const fixture = readFixture();
    const nEvents = fixture.body.score.ref_onset.length;

    await serveFixturesFromDisk(page);
    await loadLocalAlignment(page);
    await page.waitForSelector(SYNTH_SEL, { timeout: 60_000 });
    const pristine = await synthState(page);

    // The derivation matched every alignment event against the rendered MIDI.
    expect(pristine.correctedLen).toBe(nEvents);
    expect(pristine.correctedOffsetsLen).toBe(nEvents);
    expect(pristine.gridLen).toBeGreaterThan(0);

    // B: same piece, stored tables skewed by the historical +4 s.
    fixture.body.score.synth_onset = fixture.body.score.synth_onset.map((t: number) => t + 4);
    fixture.body.score.synth_offset = fixture.body.score.synth_offset.map((t: number) => t + 4);
    await serveAlignment(page, fixture);
    await loadLocalAlignment(page);
    await page.waitForSelector(SYNTH_SEL, { timeout: 60_000 });
    const skewed = await synthState(page);

    // Sanity: the plant landed — the page really was handed skewed tables.
    expect(skewed.storedFirstOnset).toBeCloseTo(pristine.storedFirstOnset + 4, 6);
    // The corrected tables and the synth alignment grid must not have moved.
    expect(skewed.correctedSample).toEqual(pristine.correctedSample);
    expect(skewed.gridSample).toEqual(pristine.gridSample);
  });

  // 39.2 Matching is all-or-nothing: nudge every score_onset off the tick grid
  // (0.0001 quarters ≪ the 1/TPQ spacing, ≫ the matcher's 1e-6 quantisation)
  // so no event can match. The load must fall back to the stored tables and
  // still produce a synth waveform and grid.
  test('39.2 unmatchable score_onset falls back to the stored tables and the load survives', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const fixture = readFixture();
    fixture.body.score.score_onset = fixture.body.score.score_onset.map(
      (q: number) => q + 0.0001,
    );
    await serveFixturesFromDisk(page);
    await serveAlignment(page, fixture);
    await loadLocalAlignment(page);
    await page.waitForSelector(SYNTH_SEL, { timeout: 60_000 });
    const st = await synthState(page);

    expect(st.correctedLen).toBeNull();
    expect(st.correctedOffsetsLen).toBeNull();
    // The grid was still interpolated — from the stored tables.
    expect(st.gridLen).toBeGreaterThan(0);
    expect(st.gridSample!.every((v: number) => Number.isFinite(v))).toBe(true);
  });

  // 39.3 The worker fix itself, tested on the worker's OWN embedded Python:
  // a synthetic MIDI with tempo 416667 µs/beat (≈144 BPM) at tick 0 and one
  // note held for 48 quarters. Buggy tuple sort → the seeded 120 BPM default
  // wins the tie and the note lasts 24 s; fixed sort → 20.000016 s. The
  // engine's JS parser (correct all along, by stable insertion order) must
  // agree on the same bytes.
  test('39.3 the embedded MIDI parser lets a real tick-0 tempo beat the seeded default', async ({
    page,
  }) => {
    const workerSrc = fs.readFileSync(
      path.resolve(__dirname, '../../app/static/js/align-worker.js'),
      'utf8',
    );
    const tpl = workerSrc.match(/const PYTHON_CODE = `([\s\S]*?)`;/);
    expect(tpl, 'PYTHON_CODE template literal not found in align-worker.js').toBeTruthy();
    // Evaluate as a template literal so JS escape sequences (\\x00) reach
    // Python exactly as Pyodide sees them. The blob has no ${} interpolation.
    // eslint-disable-next-line no-eval
    const python: string = eval('`' + tpl![1] + '`');

    // Slice out the self-contained MIDI helpers: _read_varlen → parse_midi →
    // _tick_to_sec (contiguous; everything else needs numpy/scipy).
    const defsStart = python.indexOf('def _read_varlen');
    const tickToSecAt = python.indexOf('def _tick_to_sec');
    const defsEnd = python.indexOf('\ndef ', tickToSecAt);
    expect(defsStart).toBeGreaterThan(-1);
    expect(tickToSecAt).toBeGreaterThan(defsStart);
    const defs = python.slice(defsStart, defsEnd > -1 ? defsEnd : undefined);

    // MThd: format 0, one track, TPQ 120. MTrk: Δ0 tempo 416667 (0x065B9B),
    // Δ0 note-on C4, Δ5760 (48 quarters) note-off, end-of-track.
    // prettier-ignore
    const midi = Buffer.from([
      0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0, 120,
      0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, 20,
      0x00, 0xff, 0x51, 0x03, 0x06, 0x5b, 0x9b,
      0x00, 0x90, 60, 64,
      0xad, 0x00, 0x80, 60, 0,
      0x00, 0xff, 0x2f, 0x00,
    ]);

    const harness = [
      'import base64, sys',
      defs,
      'midi = base64.b64decode(sys.argv[1])',
      'tpq, tcs, notes = parse_midi(midi)',
      'assert len(notes) == 1, notes',
      'print(_tick_to_sec(notes[0][1], tpq, tcs))',
    ].join('\n');
    const offsetSec = parseFloat(
      execFileSync('python3', ['-c', harness, midi.toString('base64')], {
        encoding: 'utf8',
      }).trim(),
    );
    // 48 quarters at 416667 µs/beat. The buggy sort gave 24.0 here.
    expect(offsetSec).toBeCloseTo(20.000016, 3);

    // The engine's JS twin on the same bytes.
    await page.goto('/static/js/engine/mei-synth.js'); // any same-origin page
    const jsOffsetSec = await page.evaluate(async (b64: string) => {
      const m: any = await import('/static/js/engine/mei-synth.js');
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const { tpq, tempoChanges, notes } = m.parseMidi(bytes);
      return m.tickToSec(notes[0].e, tpq, tempoChanges);
    }, midi.toString('base64'));
    expect(jsOffsetSec).toBeCloseTo(offsetSec, 6);
  });
});
