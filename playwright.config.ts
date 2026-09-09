import { config as loadEnv } from 'dotenv';
import { defineConfig, devices } from '@playwright/test';

// The journeys drive the same local stack the integration suite uses, and need the same secrets —
// the cron token above all, without which the queue cannot be drained and no figure ever appears.
loadEnv({ path: '.env.local', quiet: true });

// One tag for every project in the run, so the setup project's fixtures and the sweep's clean-up
// agree about what belongs to this run.
process.env.E2E_RUN_TAG ??= `e2e${Date.now().toString(36)}`;

/**
 * Playwright (TEST_STRATEGY.md §11, §12).
 *
 * The journeys run against the SAME local Supabase the integration suite uses, with the app served
 * from a production build. A dev server would test a different bundle from the one that ships, and
 * §12's whole purpose is to exercise what a person actually gets.
 *
 * Serial, single worker: the journeys create organisations and drain the shared job queue, and two
 * running at once would drain each other's work — the same lesson `resetFixtures` taught the
 * integration suite (ADR-052.12).
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  timeout: 90_000,
  expect: { timeout: 15_000 },

  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3100',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    // §11: the default viewport is the one most customers use; the responsive sweep sets its own.
    viewport: { width: 1280, height: 900 },
  },

  projects: [
    /*
     * `setup` signs in once and seeds an organisation with real figures; the sweep reuses both.
     *
     * The journeys deliberately do NOT reuse it: each is about a person arriving with nothing, and
     * sharing a signed-in state would skip the half of the journey that matters.
     */
    { name: 'setup', testMatch: /auth\.setup\.ts/, use: { ...devices['Desktop Chrome'] } },
    {
      name: 'journeys',
      testMatch: /journey-.*\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
    /*
     * The evidence drawer reads an organisation that already has figures, so it reuses the setup
     * project's — journey 3's evidence steps begin at a number on the screen, and re-importing a
     * ledger to reach one would be testing journey 1 again.
     */
    {
      name: 'evidence',
      testMatch: /evidence-.*\.spec\.ts/,
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'], storageState: 'e2e/.auth/owner.json' },
    },
    /*
     * The API routes are exercised with the setup project's session and organisation: what is
     * under test is the status code and the shape of the response, which need a signed-in caller
     * and an organisation with figures, not a fresh journey.
     */
    {
      name: 'api',
      testMatch: /api-.*\.spec\.ts/,
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'], storageState: 'e2e/.auth/owner.json' },
    },
    {
      name: 'sweep',
      testMatch: /accessibility\.spec\.ts/,
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'], storageState: 'e2e/.auth/owner.json' },
    },
  ],

  webServer: {
    command: 'npm run start -- --port 3100',
    url: 'http://127.0.0.1:3100/api/health',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
