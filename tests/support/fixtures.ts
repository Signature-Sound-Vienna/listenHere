import { test as base, expect, type Page } from '@playwright/test';
import { loadLocalAlignment, showWaveform, waitForWaveformsReady } from './helpers';

export { expect };

// ---------------------------------------------------------------------------
// Test fixture file/name constants
// ---------------------------------------------------------------------------

export const AUDIO_A = 'audio-a.mp3';
export const AUDIO_B = 'audio-b.mp3';
export const AUDIO_C = 'audio-c.mp3';
export const AUDIO_SHORT = 'audio-short.mp3';
export const ALIGNMENT_JSON = 'alignment.json';
export const ALIGNMENT_MALFORMED = 'alignment-malformed.json';
// Alignment with 6 recordings and NO precalculated peaks — exercises the
// "auto-load only the first 5 waveforms" default path.
export const ALIGNMENT_NO_PEAKS = 'alignment-no-peaks.json';
/** 20 recordings with precalculated peaks — exercises lazy waveform creation. */
export const ALIGNMENT_MANY = 'alignment-many.json';
/**
 * alignment.json plus two grouping tabs, the active one deliberately DEFECTIVE:
 * "First" and "Second" both list audio-b.mp3 explicitly, and "Pattern" claims it
 * (and the score) by regex. Exercises the load-time overlap repair — a recording
 * belongs to exactly one group per grouping context. The second tab is clean and
 * gives audio-b.mp3 to a different group, so a tab switch legitimately changes
 * its affiliation. See roadmap item U.
 */
export const ALIGNMENT_OVERLAP = 'alignment-overlap.json';

// ---------------------------------------------------------------------------
// Custom fixture types
// ---------------------------------------------------------------------------

type AppFixtures = {
  /** Navigated to listen mode with local alignment; no waveforms shown yet. */
  listenPage: Page;
  /** listenPage + audio-a and audio-b shown and ready. */
  loadedPage: Page;
};

// ---------------------------------------------------------------------------
// Extended test object with common setup
// ---------------------------------------------------------------------------

export const test = base.extend<AppFixtures>({
  listenPage: async ({ page }, use) => {
    await loadLocalAlignment(page, ALIGNMENT_JSON);
    await page.waitForLoadState('networkidle');
    await use(page);
  },

  loadedPage: async ({ page }, use) => {
    await loadLocalAlignment(page, ALIGNMENT_JSON);
    await page.waitForLoadState('networkidle');
    await showWaveform(page, AUDIO_A);
    await showWaveform(page, AUDIO_B);
    await waitForWaveformsReady(page);
    // Click first waveform to make it active (sets currentAudioIx)
    const wf = page.locator(`#waveforms .waveform[data-ix="${AUDIO_A}"]`);
    await wf.click({ position: { x: 10, y: 10 }, force: true });
    await page.waitForTimeout(200);
    await use(page);
  },
});
