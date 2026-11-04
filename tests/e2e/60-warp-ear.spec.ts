import { test, expect } from '../support/fixtures';
import { env } from '../support/env';
import type { Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Section 60 — The warped reference ear (score-less correction C, 0.113.0)
// ---------------------------------------------------------------------------
// The fix-mode stretch worklet, rendered in an OfflineAudioContext at the
// aligner's rate (so one output sample is one source sample) and loaded
// through processorOptions. Synthetic signals with known answers: channel 1
// plays the REFERENCE through the grids, pitch kept, its bursts landing where
// the map sends them; beyond a 4× local ratio it fades out; channel 0 stays
// the recording, untouched, and without warp channel 1 is played as given.

const SR = 22050;

type Render = { ch0: number[]; ch1: number[] };

/** Render `seconds` of the worklet with the given sources and optional warp;
 *  returns both output channels (as plain arrays). */
async function renderWorklet(
  page: Page,
  o: { seconds: number; ch0: 'sine220' | 'silence'; ref?: 'bursts440'; rg?: number[]; tg?: number[] },
): Promise<Render> {
  return page.evaluate(
    async ({ o, SR, url }) => {
      const n = Math.round(o.seconds * SR);
      const ch0 = new Float32Array(n);
      if (o.ch0 === 'sine220') for (let i = 0; i < n; i++) ch0[i] = 0.5 * Math.sin((2 * Math.PI * 220 * i) / SR);
      const ch1 = new Float32Array(n); // the (silent) synth ear
      let warp = null;
      if (o.ref) {
        // Reference: 440 Hz bursts at 0.5 s and 1.5 s, 0.2 s each, in 2.5 s.
        const ref = new Float32Array(Math.round(2.5 * SR));
        for (const t0 of [0.5, 1.5]) {
          for (let i = Math.round(t0 * SR); i < Math.round((t0 + 0.2) * SR); i++) {
            ref[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / SR);
          }
        }
        warp = { ref, rg: Float64Array.from(o.rg!), tg: Float64Array.from(o.tg!), gain: 1 };
      }
      const ctx = new OfflineAudioContext(2, n, SR);
      await ctx.audioWorklet.addModule(url);
      const node = new AudioWorkletNode(ctx, 'fix-stretch', {
        numberOfInputs: 0,
        outputChannelCount: [2],
        processorOptions: { ch0, ch1, srcRate: SR, warp, playing: true },
      });
      node.connect(ctx.destination);
      const buf = await ctx.startRendering();
      return { ch0: Array.from(buf.getChannelData(0)), ch1: Array.from(buf.getChannelData(1)) };
    },
    { o, SR, url: `${env.baseUrl}/static/js/fix-stretch-worklet.js` },
  );
}

/** Start times (s) of the stretches where |x| stays above `thr`, merged over
 *  gaps shorter than 20 ms (a sine's zero crossings). */
function burstStarts(x: number[], thr = 0.05): number[] {
  const starts: number[] = [];
  let last = -Infinity;
  for (let i = 0; i < x.length; i++) {
    if (Math.abs(x[i]) < thr) continue;
    if (i - last > 0.02 * SR) starts.push(i / SR);
    last = i;
  }
  return starts;
}

/** Upward zero crossings per second over [t0, t1). */
function frequency(x: number[], t0: number, t1: number): number {
  let n = 0;
  for (let i = Math.round(t0 * SR) + 1; i < Math.round(t1 * SR); i++) if (x[i - 1] < 0 && x[i] >= 0) n++;
  return n / (t1 - t0);
}

function rms(x: number[], t0: number, t1: number): number {
  let s = 0;
  const a = Math.round(t0 * SR);
  const b = Math.round(t1 * SR);
  for (let i = a; i < b; i++) s += x[i] * x[i];
  return Math.sqrt(s / (b - a));
}

test.describe('60: the warped reference ear (stretch worklet)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`${env.baseUrl}/`);
  });

  test('60.1 the reference plays through the grids: at half speed its bursts land at twice their times, at their own pitch', async ({
    page,
  }) => {
    // Target 0–5 s ↔ reference 0–2.5 s: the reference stretched by two.
    const r = await renderWorklet(page, { seconds: 5, ch0: 'sine220', ref: 'bursts440', rg: [0, 2.5], tg: [0, 5] });
    const starts = burstStarts(r.ch1);
    expect(starts).toHaveLength(2);
    // Grain centres are mapped, so a burst starts within 15 ms of its mapped
    // time (measured 8 ms; mapping grain starts instead put it 31 ms late).
    expect(Math.abs(starts[0] - 1.0)).toBeLessThan(0.015);
    expect(Math.abs(starts[1] - 3.0)).toBeLessThan(0.015);
    // The bursts last twice as long, and keep 440 Hz (varispeed would give 220).
    expect(rms(r.ch1, 1.1, 1.3)).toBeGreaterThan(0.2);
    expect(Math.abs(frequency(r.ch1, 1.05, 1.35) - 440)).toBeLessThan(440 * 0.03);
    expect(rms(r.ch1, 1.5, 2.9)).toBeLessThan(0.01); // silence between them stays silence
  });

  test('60.2 the recording ear is untouched by the warp: sample for sample what it is without one', async ({
    page,
  }) => {
    const plain = await renderWorklet(page, { seconds: 2, ch0: 'sine220' });
    const warped = await renderWorklet(page, { seconds: 2, ch0: 'sine220', ref: 'bursts440', rg: [0, 2.5], tg: [0, 5] });
    let maxDiff = 0;
    for (let i = 0; i < plain.ch0.length; i++) {
      maxDiff = Math.max(maxDiff, Math.abs(plain.ch0[i] - warped.ch0[i]));
    }
    expect(maxDiff).toBe(0);
    // Without warp the second channel is the (silent) channel it was given.
    expect(rms(plain.ch1, 0, 2)).toBe(0);
  });

  test('60.3 beyond a 4× ratio either way over the 2 s around a grain the warped ear fades out; inside it, it sounds; a 20 ms step of the path does not count', async ({
    page,
  }) => {
    // Reference 2.5 s squeezed into target 0.5 s: a ratio of 5.
    const fast = await renderWorklet(page, { seconds: 2, ch0: 'silence', ref: 'bursts440', rg: [0, 2.5], tg: [0, 0.5] });
    expect(rms(fast.ch1, 0, 2)).toBeLessThan(1e-6);
    // A DTW-like staircase at ratio 1 overall: 20 ms rows (the reference holds)
    // alternating with 20 ms columns (the target holds) — ratios 0 and ∞ step
    // by step, 1 over any window. The bursts must sound (0.5 s → 0.5 s).
    const rgS = [0];
    const tgS = [0];
    for (let k = 0, r = 0, t = 0; k < 150; k++) {
      t += 0.02; // a row: the target moves, the reference holds
      rgS.push(r);
      tgS.push(t);
      r += 0.02; // a column: the reference moves, the target holds
      rgS.push(r);
      tgS.push(t);
    }
    const stair = await renderWorklet(page, { seconds: 2.5, ch0: 'silence', ref: 'bursts440', rg: rgS, tg: tgS });
    expect(rms(stair.ch1, 0.55, 0.65)).toBeGreaterThan(0.1);
    // Reference 2.5 s stretched over target 12.5 s: a ratio of 1/5.
    const slow = await renderWorklet(page, { seconds: 4, ch0: 'silence', ref: 'bursts440', rg: [0, 2.5], tg: [0, 12.5] });
    expect(rms(slow.ch1, 0, 4)).toBeLessThan(1e-6);
    // A ratio of 3 is inside the band: the bursts are there (0.5 s → 0.167 s).
    const three = await renderWorklet(page, { seconds: 2, ch0: 'silence', ref: 'bursts440', rg: [0, 2.5], tg: [0, 2.5 / 3] });
    expect(rms(three.ch1, 0.15, 0.25)).toBeGreaterThan(0.1);
  });
});
