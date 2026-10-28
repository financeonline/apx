import { expect, test } from '@playwright/test';
import { GL_CSV, cleanUpOwn, drainQueue, importLedger, onboard, seedUser, signIn, uniqueName } from './fixtures';

/**
 * Journey 19 — a budget, through the upload form, beside the month's actual figures (ADR-142).
 *
 * The owner imports May's ledger (sales 40,000; payroll 12,000), then a budget naming the standard
 * accounts for May, and reads budget against actual: sales 40,000 against a budget of 38,000 is
 * +2,000; payroll 12,000 against 12,500 is −500, which is below budget and so favourable for a cost.
 */

const ORG = uniqueName('Budget Journey');
const OWNER = 'journey19-budget';

test.afterAll(() => cleanUpOwn([ORG], [OWNER]));

test('a budget is imported and set beside the month\'s actual figures', async ({ page }) => {
  test.setTimeout(240_000);
  await signIn(page, seedUser(OWNER));
  const slug = await onboard(page, ORG);
  await importLedger(page, slug, GL_CSV);
  await drainQueue(page, slug);

  await page.goto(`/app/${slug}/data/imports/new`);
  await page.getByLabel(/what kind of file/i).selectOption('budget');
  await page.getByLabel(/covers from/i).fill('2026-05-01');
  await page.getByLabel(/covers to/i).fill('2026-05-31');
  await page.getByLabel(/the file/i).setInputFiles({
    name: 'budget.csv', mimeType: 'text/csv',
    buffer: Buffer.from('Month,Account,Budget\n2026-05,Revenue,38000.00\n2026-05,Payroll,12500.00\n', 'utf8'),
  });
  await page.getByRole('button', { name: /upload and check/i }).click();
  await page.waitForURL(/\/data\/imports\/[0-9a-f-]{36}/, { timeout: 60_000 });
  const question = page.getByRole('button', { name: /yes, that is right|save this answer/i });
  for (let remaining = await question.count(); remaining > 0; remaining -= 1) {
    await question.first().click();
    await expect(question).toHaveCount(remaining - 1, { timeout: 15_000 });
  }
  await page.getByRole('button', { name: /^import \d+ rows?$/i }).click();
  await expect(page.getByText(/this file has already been imported/i)).toBeVisible({ timeout: 30_000 });

  await page.goto(`/app/${slug}/money/budget`);
  await expect(page.getByRole('heading', { name: /budget against actual — may 2026/i })).toBeVisible();
  // Named as Profit & loss names it: "Sales", not "Revenue".
  const revenue = page.getByRole('row', { name: /^Sales/ });
  await expect(revenue).toContainText('£38,000.00');
  await expect(revenue).toContainText('£40,000.00');
  await expect(revenue).toContainText('+£2,000.00');
  const payroll = page.getByRole('row', { name: /^Payroll/ });
  await expect(payroll).toContainText('−£500.00');
  await expect(payroll).toContainText('better than budget');
  // The lines link back to the import they came from.
  await expect(page.getByRole('link', { name: 'see the import' }).first()).toBeVisible();
});
