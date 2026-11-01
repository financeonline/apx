import { defineConfig, devices } from '@playwright/test';

/**
 * Loads the sample business into a RUNNING local APX (on the Firebase emulators, `npm run db:start`)
 * and walks every page with it. Not part of the test suite: it signs in as a real local account and
 * writes to that account. See README.md.
 *
 *   MOTION_SAMPLE_EMAIL=… MOTION_SAMPLE_PASSWORD=… CRON_SECRET=… \
 *     npx playwright test -c scripts/sample-data/playwright.config.ts
 */
export default defineConfig({
  testDir: '.',
  testMatch: /\d+-.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 15 * 60_000,
  expect: { timeout: 30_000 },
  reporter: [['list']],
  outputDir: '../../logs/sample-data/results',
  use: {
    ...devices['Desktop Chrome'],
    // `localhost`, not 127.0.0.1: the dev server serves its scripts and accepts Server Actions only on
    // the origin it names (`serverActions.allowedOrigins`, Next's dev-origin check), so on 127.0.0.1
    // the pages never hydrate and the sign-in form submits as a plain GET.
    baseURL: process.env.MOTION_SAMPLE_URL ?? 'http://localhost:3000',
    screenshot: 'only-on-failure',
  },
});
