import { expect, test } from '@playwright/test';
import {
  GL_CSV, cleanUpOwn, drainQueue, importLedger, onboard, seedUser, signIn, uniqueName,
} from './fixtures';
import { auditEvents, orgIdByName, orgRows } from './firestore';

/**
 * Journey 8 — roll back an import (TEST_STRATEGY.md §12).
 *
 * The journey that makes the product safe to use. Somebody imports the wrong month, realises, and
 * undoes it — and the figures go back to what they were, with a record of who did it and why.
 * Without this, a mistaken import is permanent, and a product whose mistakes are permanent is one
 * people stop putting data into.
 */



const ORG_NAME = uniqueName('Rollback Ltd');

test.afterAll(() => cleanUpOwn([ORG_NAME], ['journey8-owner']));

test('an owner rolls back an import and the figures go with it', async ({ page }) => {
  const owner = await seedUser('journey8-owner');
  const orgName = ORG_NAME;

  await signIn(page, owner);
  const slug = await onboard(page, orgName);
  await importLedger(page, slug, GL_CSV, 'gl-may.csv');
  await drainQueue(page, slug);

  // ---- The figures exist ----------------------------------------------------------------------
  const orgId = await orgIdByName(orgName);
  const accepted = async (): Promise<number> =>
    (await orgRows(orgId, 'ledger_entries', (l) => l.record_status === 'accepted')).length;
  expect(await accepted(), 'the import put rows in the ledger').toBe(5);

  await page.goto(`/app/${slug}/home`);
  await expect(page.getByText('£40,000').first()).toBeVisible({ timeout: 30_000 });

  // ---- Roll it back ---------------------------------------------------------------------------
  await page.goto(`/app/${slug}/data/imports`);
  await expect(page.getByText(/imported/i).first()).toBeVisible();

  await page.getByRole('group').filter({ hasText: /remove import/i }).first().click();
  await page.getByPlaceholder(/why are you removing it/i).fill('Wrong month');
  await page.getByRole('button', { name: /remove it from my figures/i }).click();

  /*
   * The status badge, not a message: the control lives in a `<details>` that closes when the page
   * revalidates, taking its own confirmation with it. What a person actually sees afterwards is the
   * row saying "Removed" (a rollback, in the owner's words), and that is what the journey should depend on.
   */
  await expect(page.getByText(/^Removed$/).first()).toBeVisible({ timeout: 30_000 });

  // ---- Nothing of it is left in the figures ----------------------------------------------------
  expect(await accepted(), 'the rolled-back rows leave the accepted set').toBe(0);

  const status = (await orgRows(orgId, 'import_batches'))
    .map((b) => `${String(b.status)}|${b.rolled_back_reason == null ? '-' : String(b.rolled_back_reason)}`)
    .join('\n');
  expect(status, 'the batch says it was rolled back, and why').toBe('rolled_back|Wrong month');

  /*
   * §12: the reason is not decoration. A rollback removes rows other figures were computed from,
   * and six months later the only account of why will be this sentence.
   */
  const audited = (await auditEvents(orgId)).filter((a) => String(a.action).startsWith('import.')).length;
  expect(audited).toBeGreaterThan(0);

  // ---- And the dashboard goes back to asking for data ------------------------------------------
  await drainQueue(page, slug);
  await page.goto(`/app/${slug}/home`);
  await expect(
    page.getByText(/let’s get your first numbers on screen|add your first/i),
    'Home returns to its empty state rather than showing figures nothing supports',
  ).toBeVisible({ timeout: 30_000 });
});
