import { defineConfig, devices } from '@playwright/test';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, 'tests/.env') });

const BASE_URL = process.env.APP_BASE_URL ?? 'http://localhost:5001';

export default defineConfig({
  testDir: './tests/e2e',
  // Files run in parallel; tests WITHIN a file stay serial and in order, which is
  // what the audio/state tests actually depend on. The Flask dev server is
  // threaded and holds no per-request state, and each worker gets its own
  // browser context, so there is nothing shared to serialise on.
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  workers: 4,
  reporter: [['html', { outputFolder: 'tests/report' }], ['list']],

  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'on-first-retry',
  },

  // Start the Flask dev server automatically before running tests. FLASK_DEBUG is
  // required, not cosmetic: tests/fixtures/ is only served at /static/test/<file>
  // when app.debug is true (see app/routes.py).
  webServer: {
    command: 'flask run --port=5001',
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    env: {
      FLASK_APP: 'wsgi.py',
      FLASK_DEBUG: '1',
    },
  },

  // --mute-audio / media.volume_scale keep the suite silent: several specs start
  // real playback, which is disruptive when a run happens in the background.
  projects: [
    {
      name: 'functional',
      // Anchored: an unanchored negative lookahead excludes nothing, which is why
      // the perf specs used to run here too (and their budgets break under parallel
      // workers). Perf lives in its own project: npx playwright test --project=perf
      // --workers=1, so budgets are measured without CPU contention.
      testMatch: /^(?!.*\.(perf|solid)\.spec\.).*\.spec\.ts$/,
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: { args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] },
      },
    },
    {
      name: 'functional-firefox',
      testMatch: /^(?!.*\.(perf|solid)\.spec\.).*\.spec\.ts$/,
      use: {
        ...devices['Desktop Firefox'],
        // media.volume_scale silences the output stage only — decoding, currentTime
        // and the play/pause events the tests assert on are unaffected.
        launchOptions: { firefoxUserPrefs: { 'media.volume_scale': '0.0' } },
      },
    },
    {
      name: 'perf',
      testMatch: /.*\.perf\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: { args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] },
      },
      timeout: 120_000,
    },
    {
      name: 'solid',
      testMatch: /.*\.solid\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
      // Solid tests require a configured test pod — skip in CI unless env is set
      grep: process.env.SOLID_POD_URL ? undefined : /^$/, // skip all if no pod configured
    },
  ],
});
