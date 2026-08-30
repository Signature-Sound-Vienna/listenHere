import { type Page, expect } from '@playwright/test';
import * as path from 'path';

export const FIXTURES_DIR = path.resolve(__dirname, '../fixtures');

// ---------------------------------------------------------------------------
// Navigation helpers
// ---------------------------------------------------------------------------

/**
 * Navigate to the listen interface with a local alignment JSON served by
 * the Flask dev server from tests/fixtures/.
 */
/**
 * Safety net: nothing in the suite should reach raw.githubusercontent.com.
 *
 * `alignment.json`'s `header.meiUri` now points at the MEI fixture this server
 * already serves at /static/test/, so the score loads locally by default. This
 * route stays as a backstop, so a fixture or spec that reintroduces a GitHub URL
 * is served the local file rather than hammering GitHub: the suite loads the
 * page ~150× per run (× browsers, × reruns), which used to trip GitHub's
 * anti-scraping limit (HTTP 429) — and the 429 body was then handed to Verovio
 * as "XML", breaking score synthesis.
 *
 * Test 29.5 fails if a fixture points off-machine, so this net should stay idle.
 * Idempotent-safe to call before each navigation.
 */
export async function stubExternalMei(page: Page) {
  await page.route('**/raw.githubusercontent.com/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/xml; charset=utf-8',
      path: path.join(FIXTURES_DIR, 'Schumann-Clara_Romanze-ohne-Opuszahl_a-Moll.mei'),
    }),
  );
}

/**
 * Serve every `lazy-NN.mp3` the 20-recording fixture names from one small audio
 * file. The lazy-waveform specs need many ROWS, not many distinct recordings,
 * and 20 copies of a 105 KB fixture would be 2 MB of binaries in the repo for
 * no extra coverage.
 */
export async function stubManyRecordingAudio(page: Page) {
  await page.route('**/static/test/lazy-*.mp3', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'audio/mpeg',
      path: path.join(FIXTURES_DIR, 'audio-short.mp3'),
    }),
  );
}

export async function loadLocalAlignment(page: Page, filename = 'alignment.json') {
  // Backstop against off-machine MEI fetches, registered BEFORE navigating.
  await stubExternalMei(page);
  // useLocal overrides the audio base URL so that relative filenames in the
  // alignment JSON resolve to /static/test/ (where test fixtures are served).
  await page.goto(`/?align=http://localhost:5001/static/test/${filename}&useLocal=http://localhost:5001/static/test`);
}

/**
 * Navigate to the listen interface in ?useFiles mode and provide files
 * via the Playwright file-chooser API.
 */
export async function loadViaFilePicker(
  page: Page,
  files: string[], // absolute paths or filenames relative to FIXTURES_DIR
) {
  const resolved = files.map((f) =>
    path.isAbsolute(f) ? f : path.join(FIXTURES_DIR, f),
  );
  await page.goto('/?useFiles');
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.click('#file-picker-files-btn'),
  ]);
  await chooser.setFiles(resolved);
}

/**
 * Navigate to the alignment wizard.
 */
export async function goToAlignMode(page: Page) {
  await page.goto('/?mode=align');
}

// ---------------------------------------------------------------------------
// Waveform helpers
// ---------------------------------------------------------------------------

/**
 * Click the nav sidebar checkbox to show a waveform, then wait for it
 * to be visible in the content pane.
 */
export async function showWaveform(page: Page, filename: string) {
  // The checkbox value attribute contains the filename key.
  // Use evaluate to click directly — the nav layout can overlap checkboxes
  // at small viewport sizes, preventing normal Playwright clicks.
  await page.evaluate((fn) => {
    const cb = document.querySelector(`#audios input[type="checkbox"][value="${fn}"]`) as HTMLInputElement;
    if (cb && !cb.checked) cb.click();
  }, filename);
  await page.waitForSelector(
    `#waveforms .waveform[data-ix="${filename}"]`,
    { state: 'visible', timeout: 15_000 },
  );
}

/**
 * Resolve once every waveform's geometry has stopped moving after a zoom.
 *
 * Zoom re-renders asynchronously — WaveSurfer redraws off its own
 * ResizeObserver — so anything that reads zoom geometry right after setting
 * the slider is racing it. Two identical width readings 100 ms apart rather
 * than a guessed duration; same shape as spec 28's settled(). This wait fixed
 * the 25.3 flake (a zoom re-render rejecting an unawaited play()) and the
 * 20.3 flake (a region-nav jump computing its target against a stale zoomed
 * width under load, landing short, and honestly leaving the arrow visible).
 */
export async function zoomSettled(page: Page, timeout = 15_000) {
  let previous = '';
  await expect
    .poll(
      async () => {
        const now = await page.evaluate(() => {
          const t: any = (window as any)._listenTest;
          return Object.keys(t.wavesurfers)
            .map((fn) => {
              const sc = t.wavesurfers[fn].getWrapper().parentElement as HTMLElement;
              return `${fn}:${sc.scrollWidth}:${sc.clientWidth}`;
            })
            .join('|');
        });
        const stable = now === previous;
        previous = now;
        return stable;
      },
      { timeout, intervals: [100] },
    )
    .toBe(true);
}

/**
 * Hide a waveform via its sidebar checkbox.
 */
export async function hideWaveform(page: Page, filename: string) {
  await page.evaluate((fn) => {
    const cb = document.querySelector(`#audios input[type="checkbox"][value="${fn}"]`) as HTMLInputElement;
    if (cb && cb.checked) cb.click();
  }, filename);
}

/**
 * Wait for all currently checked waveforms to finish loading
 * (WaveSurfer fires 'redrawcomplete' which we detect via a data attribute
 * set in the ready handler).
 */
export async function waitForWaveformsReady(page: Page, timeout = 30_000) {
  // The app adds .ready to the checkbox label when a waveform finishes loading.
  // Wait until all checked checkboxes have a .ready label sibling.
  await page.waitForFunction(
    () => {
      const checked = document.querySelectorAll('#audios input[type="checkbox"]:checked');
      if (checked.length === 0) return true;
      return [...checked].every((cb) => {
        const label = cb.parentElement?.querySelector('label');
        // "queued" is settled, not in-flight: above the lazy threshold a
        // recording sits in the pane with its waveform deliberately not built
        // until the user scrolls to it, so waiting for it to turn ready would
        // just burn the timeout.
        return label?.classList.contains('ready') || label?.classList.contains('queued');
      });
    },
    { timeout },
  );
}

/**
 * Wait until a waveform's own width has stopped changing.
 *
 * Opening or closing the V6 annotation drawer animates `body`'s padding-right
 * over 200ms (`body.lh-v6-active` in default.css), so the waveform pane narrows
 * frame by frame — measured, 1047px to 667px in ~215ms — and WaveSurfer
 * re-renders each waveform on every one of those frames via its own
 * ResizeObserver. `body.lh-v6-edit-active` lands on frame 0 of that ramp, so
 * waiting for the class is not waiting for the layout: a bounding box measured
 * straight afterwards is stale before the mouse events based on it arrive, and
 * the resulting pixel coordinates vary run to run with machine load.
 *
 * Settling is deliberately "no change for longer than the transition lasts"
 * rather than "a few identical frames": the latter is also satisfied by
 * sampling before the animation has started, which would let this return
 * immediately and silently do nothing.
 */
export async function waitForWaveformWidthSettled(
  page: Page,
  filename: string,
  timeout = 10_000,
) {
  const STABLE_MS = 220; // just over the 200ms padding-right transition
  // Drop any state left by an earlier call on this page, so a previous settle
  // cannot satisfy this one instantly.
  await page.evaluate(() => {
    delete (window as unknown as Record<string, unknown>).__wfWidthSettle;
  });
  await page.waitForFunction(
    ({ fn, stableMs }) => {
      const el = document.querySelector(`#waveforms .waveform[data-ix="${fn}"]`);
      if (!el) return false;
      const width = el.getBoundingClientRect().width;
      const store = ((window as any).__wfWidthSettle ||= {});
      const prev = store[fn];
      const now = performance.now();
      if (!prev || Math.abs(prev.width - width) >= 0.5) {
        store[fn] = { width, since: now };
        return false;
      }
      return now - prev.since >= stableMs;
    },
    { fn: filename, stableMs: STABLE_MS },
    // Interval rather than 'raf': rAF can be throttled, and a plain clock is
    // all this needs.
    { polling: 50, timeout },
  );
}

// ---------------------------------------------------------------------------
// HTML5 drag-and-drop helper
// ---------------------------------------------------------------------------

/**
 * Simulate a native HTML5 drag-and-drop by dispatching the dragstart →
 * dragenter → dragover → drop → dragend sequence with a single shared
 * DataTransfer. Playwright's mouse-based dragTo does not reliably trigger
 * HTML5 DnD, so we drive the events directly. Both selectors are resolved in
 * the page; if `fireDrop` is false the drop is skipped (dragend still fires) —
 * useful for asserting hover-only behaviour such as drop previews.
 */
export async function htmlDragTo(
  page: Page,
  sourceSelector: string,
  targetSelector: string,
  opts: { fireDrop?: boolean; fireDragEnd?: boolean } = {},
) {
  const { fireDrop = true, fireDragEnd = true } = opts;
  await page.evaluate(
    ({ src, tgt, fireDrop, fireDragEnd }) => {
      const source = document.querySelector(src);
      const target = document.querySelector(tgt);
      if (!source || !target) throw new Error(`DnD: missing ${!source ? src : tgt}`);
      const dt = new DataTransfer();
      const fire = (el: Element, type: string) =>
        el.dispatchEvent(
          new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }),
        );
      fire(source, 'dragstart');
      fire(target, 'dragenter');
      fire(target, 'dragover');
      if (fireDrop) fire(target, 'drop');
      if (fireDragEnd) fire(source, 'dragend');
    },
    { src: sourceSelector, tgt: targetSelector, fireDrop, fireDragEnd },
  );
}

// ---------------------------------------------------------------------------
// Playback helpers
// ---------------------------------------------------------------------------

export async function play(page: Page) {
  await page.evaluate(() => (document.getElementById('playpause') as HTMLElement).click());
  await expect(page.locator('#playpause .icon-pause')).toBeVisible();
}

export async function pause(page: Page) {
  await page.evaluate(() => (document.getElementById('playpause') as HTMLElement).click());
  await expect(page.locator('#playpause .icon-play')).toBeVisible();
}

export async function skipToStart(page: Page) {
  await page.evaluate(() => (document.getElementById('skip-back') as HTMLElement).click());
}

// ---------------------------------------------------------------------------
// Timing / performance helper
// ---------------------------------------------------------------------------

/**
 * Measures wall-clock time (ms) for an async action in the browser context.
 */
export async function measureMs(page: Page, action: () => Promise<void>): Promise<number> {
  const t0 = await page.evaluate(() => performance.now());
  await action();
  return await page.evaluate(() => performance.now()) - t0;
}
