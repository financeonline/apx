import { writeFileSync } from 'node:fs';
import { expect, test as setup } from '@playwright/test';
import {
  AUTH_STATE, GL_CSV, SEEDED_ORG, drainQueue, importLedger, onboard, seedUser, signIn,
  sweepOldFixtures, uniqueName,
} from './fixtures';

/**
 * Signs in once and seeds an organisation with real figures (TEST_STRATEGY.md §11).
 *
 * Every test gets a fresh browser context, so a `beforeAll` that signs in on its own page leaves the
 * tests themselves signed OUT — and a sweep that lands on the sign-in page nine times passes every
 * check while examining nothing. Playwright's own answer is a setup project whose storage state the
 * other projects reuse, and that is what this is (ADR-058.10).
 */
setup('sign in and seed an organisation with figures', async ({ page }) => {
  // Once, before anything else runs: fixtures a killed run left behind, and nothing live.
  sweepOldFixtures();

  const owner = seedUser('a11y-owner');
  await signIn(page, owner);

  const slug = await onboard(page, uniqueName('Accessible Ltd'));
  await importLedger(page, slug, GL_CSV, 'gl-may.csv');
  await drainQueue(page, slug);

  // The figures must actually be there, or every check downstream is vacuous.
  await page.goto(`/app/${slug}/home`);
  await expect(page.getByText('£40,000').first()).toBeVisible({ timeout: 30_000 });

  await page.context().storageState({ path: AUTH_STATE });
  writeFileSync(SEEDED_ORG, JSON.stringify({ slug }), 'utf8');
});
