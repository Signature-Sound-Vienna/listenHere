// 40. engine/time-map.js — the composed quarters ↔ recording-seconds map
//
// The one module that owns the chain quarters → reference seconds → any
// recording's seconds (plan §13: the MIDI stand-in warp; plan §12: the
// score-time and pinned-note axis modes). These tests hold it to the
// contracts its consumers stand on:
//
//   * KNOT EXACTNESS — at every deduplicated onset quarter, the map returns
//     the alignment's own ref_onset verbatim (no smoothing, no drift). The
//     stand-in tool's onset targets are exactly the alignment's claims.
//   * FIRST-PAIR DEDUPE — chord onsets duplicate quarters; the first pair per
//     quarter wins (in real data duplicates carry identical ref_onset, so
//     this is defensive determinism, verified on the corpus 2026-08-28).
//   * GRID HALF ALONE — both grids share the alignment frame index
//     (align-core's contract), so (refGrid[i], targetGrid[i]) are the knots
//     directly; a score-less alignment still gets refSecToSec/secToRefSec.
//   * EDGE SEMANTICS — outside the knots, edge-slope extrapolation, and NO
//     clamping anywhere: the fixture's audio-short grid genuinely starts
//     negative (-0.060 s), and a partial clamp (interpAlignmentGrid's
//     left-edge floor was tried first) breaks monotonicity where clamped and
//     unclamped evaluations meet. Playable-time clamping is the consumer's
//     concern; the map's own contract is monotonic and exactly invertible.
//
// Pure math over the hermetic fixture: no app boot — the page.goto target is
// the module file itself, same-origin for the dynamic import (39.3 pattern).
import { test, expect } from '../support/fixtures';
import * as fs from 'fs';
import * as path from 'path';

const fixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'alignment.json'), 'utf8'),
);
const score = fixture.body.score;
const refName = fixture.header.ref as string; // audio-b.mp3
const grids: Record<string, number[]> = Object.fromEntries(
  Object.entries(fixture.body.audio).map(([k, v]: [string, any]) => [k, v.times]),
);

/** First-pair-wins dedupe, the spec-side mirror of the module's one-liner. */
function dedupeExpected(): { qs: number[]; refs: number[] } {
  const qs: number[] = [];
  const refs: number[] = [];
  for (let i = 0; i < score.score_onset.length; i++) {
    if (qs.length && score.score_onset[i] === qs[qs.length - 1]) continue;
    qs.push(score.score_onset[i]);
    refs.push(score.ref_onset[i]);
  }
  return { qs, refs };
}

const MODULE_URL = '/static/js/engine/time-map.js';

test.describe('40. time-map', () => {
  test('40.1 chord duplicates dedupe to strictly increasing knots, first pair wins', async ({ page }) => {
    const expected = dedupeExpected();
    await page.goto(MODULE_URL); // any same-origin page
    const got = await page.evaluate(
      async (a: any) => {
        const m: any = await import('/static/js/engine/time-map.js');
        const map = m.buildTimeMap(a);
        const qs: number[] = map.onsetQuarters;
        return {
          n: qs.length,
          increasing: qs.every((q, i) => i === 0 || q > qs[i - 1]),
          qs,
        };
      },
      { scoreOnset: score.score_onset, refOnset: score.ref_onset, refGrid: grids[refName], targetGrid: grids[refName] },
    );
    expect(got.n).toBe(expected.qs.length); // 555 unique of 725 (real chords)
    expect(got.increasing).toBe(true);
    expect(got.qs).toEqual(expected.qs);
  });

  test('40.2 at every onset knot the map returns the alignment ref_onset verbatim', async ({ page }) => {
    const expected = dedupeExpected();
    await page.goto(MODULE_URL);
    const got = await page.evaluate(
      async (a: any) => {
        const m: any = await import('/static/js/engine/time-map.js');
        const map = m.buildTimeMap(a);
        let maxFwd = 0,
          maxInv = 0;
        for (let i = 0; i < a.expectQ.length; i++) {
          maxFwd = Math.max(maxFwd, Math.abs(map.quartersToRefSec(a.expectQ[i]) - a.expectRef[i]));
          maxInv = Math.max(maxInv, Math.abs(map.refSecToQuarters(a.expectRef[i]) - a.expectQ[i]));
        }
        return { maxFwd, maxInv };
      },
      {
        scoreOnset: score.score_onset,
        refOnset: score.ref_onset,
        refGrid: grids[refName],
        targetGrid: grids[refName],
        expectQ: expected.qs,
        expectRef: expected.refs,
      },
    );
    expect(got.maxFwd).toBe(0); // knot hits are exact, not approximate
    expect(got.maxInv).toBe(0);
  });

  test('40.3 grid half: exact at interior knots, identity onto the reference, negative knots pass through', async ({ page }) => {
    await page.goto(MODULE_URL);
    const got = await page.evaluate(
      async (a: any) => {
        const m: any = await import('/static/js/engine/time-map.js');
        const onto = m.buildTimeMap({ refGrid: a.refGrid, targetGrid: a.targetGrid });
        let maxKnot = 0;
        for (let i = 1; i < a.refGrid.length; i++)
          maxKnot = Math.max(maxKnot, Math.abs(onto.refSecToSec(a.refGrid[i]) - a.targetGrid[i]));
        const self = m.buildTimeMap({ refGrid: a.refGrid, targetGrid: a.refGrid });
        let maxIdentity = 0;
        const last = a.refGrid[a.refGrid.length - 1];
        for (let t = 0; t <= last; t += last / 997)
          maxIdentity = Math.max(maxIdentity, Math.abs(self.refSecToSec(t) - t));
        const short = m.buildTimeMap({ refGrid: a.refGrid, targetGrid: a.shortGrid });
        return {
          maxKnot,
          maxIdentity,
          shortAtZero: short.refSecToSec(0),
          shortFirstKnot: a.shortGrid[0],
        };
      },
      { refGrid: grids[refName], targetGrid: grids['audio-a.mp3'], shortGrid: grids['audio-short.mp3'] },
    );
    expect(got.maxKnot).toBe(0);
    expect(got.maxIdentity).toBeLessThan(1e-9);
    // audio-short's grid really starts at -0.060 s, and the map hands that
    // through verbatim — clamping is the playback layer's job, and a partial
    // clamp is exactly how monotonicity broke in the first version.
    expect(got.shortFirstKnot).toBeLessThan(0);
    expect(got.shortAtZero).toBe(got.shortFirstKnot);
  });

  test('40.4 composed map is monotonic and round-trips through its inverse', async ({ page }) => {
    await page.goto(MODULE_URL);
    for (const target of ['audio-a.mp3', 'audio-c.mp3', 'audio-short.mp3']) {
      const got = await page.evaluate(
        async (a: any) => {
          const m: any = await import('/static/js/engine/time-map.js');
          const map = m.buildTimeMap(a);
          const lastQ = map.onsetQuarters[map.onsetQuarters.length - 1];
          let monotonic = true,
            maxRoundTrip = 0,
            prev = -Infinity;
          for (let q = -5; q <= lastQ + 5; q += 0.1) {
            const s = map.quartersToSec(q);
            if (s < prev) monotonic = false;
            prev = s;
            if (q >= 0 && q <= lastQ)
              maxRoundTrip = Math.max(maxRoundTrip, Math.abs(map.secToQuarters(s) - q));
          }
          return { monotonic, maxRoundTrip };
        },
        { scoreOnset: score.score_onset, refOnset: score.ref_onset, refGrid: grids[refName], targetGrid: grids[target] },
      );
      expect(got.monotonic, `${target} must be monotonic`).toBe(true);
      // audio-short compresses 304 s onto 5.45 s, the worst inverse
      // conditioning in the fixture — still far inside 1e-6 quarters.
      expect(got.maxRoundTrip, `${target} round-trip`).toBeLessThan(1e-6);
    }
  });

  test('40.5 score-less alignments get the grid half alone', async ({ page }) => {
    await page.goto(MODULE_URL);
    const got = await page.evaluate(
      async (a: any) => {
        const m: any = await import('/static/js/engine/time-map.js');
        const map = m.buildTimeMap({ refGrid: a.refGrid, targetGrid: a.targetGrid });
        return {
          nulls: [map.quartersToSec, map.secToQuarters, map.quartersToRefSec, map.refSecToQuarters, map.onsetQuarters].map((f: unknown) => f === null),
          mapped: map.refSecToSec(a.refGrid[1000]),
        };
      },
      { refGrid: grids[refName], targetGrid: grids['audio-a.mp3'] },
    );
    expect(got.nulls).toEqual([true, true, true, true, true]);
    expect(got.mapped).toBe(grids['audio-a.mp3'][1000]);
  });
});
