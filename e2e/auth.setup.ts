import { writeFileSync } from 'node:fs';
import { expect, test as setup } from '@playwright/test';
import {
  ADVISER_STATE, AUTH_STATE, GL_CSV, SEEDED_ORG, STATEMENT_MAY_CSV, addBankAccount, drainQueue, importLedger, importStatement,
  onboard, seedUser, signIn, sql, sweepOldFixtures, uniqueName,
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
  // Real bank data for the same month: Banking Health is scored only on bank evidence (Step 0E, H-1).
  await addBankAccount(page, slug, 'Main current account');
  await importStatement(page, slug, STATEMENT_MAY_CSV, 'statement-may.csv', '2026-05-01', '2026-05-31');
  await drainQueue(page, slug);

  // The figures must actually be there, or every check downstream is vacuous.
  await page.goto(`/app/${slug}/home`);
  await expect(page.getByText('£40,000').first()).toBeVisible({ timeout: 30_000 });

  await page.context().storageState({ path: AUTH_STATE });
  writeFileSync(SEEDED_ORG, JSON.stringify({ slug }), 'utf8');

  // A Financial Analyst assigned to the same organisation, for the Command Centre's sweep: it is
  // APX staff only (owner, 2026-10-14; ADR-112 addendum), and the owner above has none.
  const adviser = seedUser('a11y-adviser');
  sql(`insert into public.platform_users (user_id, platform_role) values ('${adviser.userId}', 'employee')`);
  sql(`insert into public.organization_assignments (organization_id, employee_user_id)
       select id, '${adviser.userId}' from public.organizations where slug = '${slug}'`);
  await page.context().clearCookies();
  await signIn(page, adviser);
  const portfolio = await page.goto('/portfolio');
  expect(portfolio?.status(), 'the assigned employee has a Command Centre').toBe(200);
  await page.context().storageState({ path: ADVISER_STATE });
});
