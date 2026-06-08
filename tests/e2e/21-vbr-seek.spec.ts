import { test, expect } from '@playwright/test';

// Tests for the accurate-seek path for frame-stream audio formats (VBR MP3 /
// ADTS AAC), whose native <audio> seeking is inaccurate. Covered:
//   - audio-seek-index.js   : format detection + frame index (pure logic)
//   - windowed-audio-player.js : sample-accurate windowed seeking (Web Audio)
//
// The accuracy test is a regression guard for the two bugs found during
// development: a wrong AAC priming constant (~44 ms off) and a calibration
// off-by-one frame (~17-21 ms off). It cross-correlates what the windowed
// player decodes at a given time against the full-file decode (the ground
// truth / peaks timeline) and asserts ~0 lag.
//
// Fixtures (tests/fixtures/, served at /static/test/ in debug mode):
//   audio-a-vbr.mp3, audio-short-vbr.mp3  - VBR MP3   (-> windowed path)
//   audio-a.aac,     audio-short.aac      - ADTS AAC  (-> windowed path)
//   audio-short-cbr.mp3                   - CBR MP3   (-> native path / null)

const BASE = 'http://localhost:5001/static/test';

test.describe('VBR / ADTS accurate seeking', () => {
  test.beforeEach(async ({ page }) => {
    // Any same-origin page gives us a module + fetch context.
    await page.goto('/');
  });

  test('classifies frame-stream formats and ignores natively-seekable ones', async ({ page }) => {
    const r = await page.evaluate(async (base) => {
      const { analyzeAudio } = await import('/static/js/audio-seek-index.js');
      const classify = async (f: string) => {
        const ab = await (await fetch(`${base}/${f}`)).arrayBuffer();
        const a = (analyzeAudio as any)(ab);
        return a ? { format: a.format, vbr: a.vbr, frames: a.frameCount, dur: a.duration } : null;
      };
      const files = [
        'audio-a-vbr.mp3', 'audio-b-vbr.mp3', 'audio-short-vbr.mp3',
        'audio-a.aac', 'audio-b.aac', 'audio-short.aac',
        'audio-short-cbr.mp3',
      ];
      const out: Record<string, any> = {};
      for (const f of files) out[f] = await classify(f);
      return out;
    }, BASE);

    // VBR MP3 → mp3 index
    for (const f of ['audio-a-vbr.mp3', 'audio-b-vbr.mp3', 'audio-short-vbr.mp3']) {
      expect(r[f], f).toMatchObject({ format: 'mp3', vbr: true });
      expect(r[f].frames, f).toBeGreaterThan(0);
      expect(r[f].dur, f).toBeGreaterThan(0);
    }
    // ADTS AAC → aac-adts index
    for (const f of ['audio-a.aac', 'audio-b.aac', 'audio-short.aac']) {
      expect(r[f], f).toMatchObject({ format: 'aac-adts', vbr: true });
      expect(r[f].frames, f).toBeGreaterThan(0);
    }
    // CBR seeks fine natively → no index built.
    expect(r['audio-short-cbr.mp3']).toBeNull();
  });

  test('frame index is monotonic and lookup() maps time to bytes', async ({ page }) => {
    const r = await page.evaluate(async (base) => {
      const { analyzeAudio } = await import('/static/js/audio-seek-index.js');
      const ab = await (await fetch(`${base}/audio-a-vbr.mp3`)).arrayBuffer();
      const a = (analyzeAudio as any)(ab);
      let monotonic = true;
      for (let i = 1; i < a.frameCount; i++) {
        if (a.frameOffsets[i] <= a.frameOffsets[i - 1]) { monotonic = false; break; }
      }
      const l0 = a.lookup(0);
      const lMid = a.lookup(a.duration / 2);
      return {
        monotonic,
        frameCount: a.frameCount,
        firstByte: a.frameOffsets[0],
        l0,
        lMid,
      };
    }, BASE);

    expect(r.monotonic).toBe(true);
    // lookup(0) resolves to the first frame.
    expect(r.l0.byteOffset).toBe(r.firstByte);
    // A mid-file time resolves to a later, in-bounds frame/byte.
    expect(r.lMid.frameIndex).toBeGreaterThan(0);
    expect(r.lMid.frameIndex).toBeLessThan(r.frameCount);
    expect(r.lMid.byteOffset).toBeGreaterThan(r.l0.byteOffset);
  });

  // The core regression guard: windowed decode must land on the same audio the
  // full decode (peaks/marker timeline) has at that time.
  for (const file of ['audio-a-vbr.mp3', 'audio-a.aac']) {
    test(`windowed seek is sample-accurate: ${file}`, async ({ page }) => {
      const results = await page.evaluate(async ({ base, file }) => {
        const { analyzeAudio } = await import('/static/js/audio-seek-index.js');
        const { WindowedAudioPlayer } = await import('/static/js/windowed-audio-player.js');
        const xcorr = (a: Float32Array, b: Float32Array, maxLag: number) => {
          let best = { lag: 0, c: -2 };
          const n = Math.min(a.length, b.length) - maxLag;
          for (let lag = -maxLag; lag <= maxLag; lag++) {
            let d = 0, na = 0, nb = 0;
            for (let i = maxLag; i < n; i += 4) {
              const x = a[i], y = b[i + lag] || 0;
              d += x * y; na += x * x; nb += y * y;
            }
            const c = d / (Math.sqrt(na * nb) || 1);
            if (c > best.c) best = { lag, c };
          }
          return best;
        };
        const ctx = new AudioContext();
        const ab = await (await fetch(`${base}/${file}`)).arrayBuffer();
        const index = (analyzeAudio as any)(ab.slice(0));
        const full = await ctx.decodeAudioData(ab.slice(0));
        const SR = full.sampleRate;
        const player = new (WindowedAudioPlayer as any)(new Blob([ab]), index, {
          audioContext: ctx,
          duration: full.duration,
        });
        await player.init(); // calibrate gapless offset
        const out: { t: number; lagMs: number; corr: number }[] = [];
        for (const t of [30, 90, 180]) {
          const w = await player.decodeContentAt(t, 0.4);
          const gt = full.getChannelData(0).slice(Math.round(t * SR), Math.round((t + 0.4) * SR));
          const m = xcorr(gt, w.data, 2400); // +/- ~50 ms search
          out.push({ t, lagMs: (m.lag / SR) * 1000, corr: m.c });
        }
        await ctx.close();
        return out;
      }, { base: BASE, file });

      for (const { t, lagMs, corr } of results) {
        expect(corr, `correlation at ${t}s for ${file}`).toBeGreaterThan(0.98);
        expect(Math.abs(lagMs), `|lag| ms at ${t}s for ${file}`).toBeLessThan(3);
      }
    });
  }
});
