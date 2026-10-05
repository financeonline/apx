import { expect, test } from '@playwright/test';
import { cleanUpOwn, drainQueue, seedOrganization, seedUser, signIn, sql, uniqueName } from './fixtures';

/**
 * Journey 16 — customers named in five scripts, through the upload form (ADR-136, Step 0D).
 *
 * Before Step 0D an organisation could hold ONE customer whose name had no letter A–Z (they all had
 * the key ''), and "Möller GmbH" was booked to "Müller GmbH". Here a person uploads a sales list
 * naming customers in Japanese, Arabic, Greek (in two cases), Cyrillic and accented Latin, reviews
 * it, imports it, and sees every customer under the name the file gave — distinct names apart, the
 * same name in another case as one.
 */

const ORG_NAME = uniqueName('Unicode Names');

const CSV = [
  'Invoice Number,Customer,Invoice Date,Due Date,Total',
  'U-01,株式会社トヨタ,2026-08-03,2026-09-02,100.00',
  'U-02,شركة الأمل,2026-08-04,2026-09-03,200.00',
  'U-03,ΟΔΟΣ Α.Ε.,2026-08-05,2026-09-04,300.00',
  'U-04,οδος α.ε.,2026-08-06,2026-09-05,400.00',
  'U-05,ООО «Ромашка»,2026-08-07,2026-09-06,500.00',
  'U-06,Müller GmbH,2026-08-08,2026-09-07,600.00',
  'U-07,Möller GmbH,2026-08-09,2026-09-08,700.00',
].join('\n');

test.afterAll(() => cleanUpOwn([ORG_NAME], ['journey16-owner']));

test('a sales list with customers in five scripts imports each under its own name', async ({ page }) => {
  const owner = seedUser('journey16-owner');
  const { slug } = seedOrganization(ORG_NAME, owner.userId);
  await signIn(page, owner);

  await page.goto(`/app/${slug}/data/imports/new`);
  await expect(page.getByRole('heading', { name: /add data/i })).toBeVisible();
  await page.getByLabel(/what kind of file/i).selectOption('sales_invoices');
  await page.getByLabel(/covers from/i).fill('2026-08-01');
  await page.getByLabel(/covers to/i).fill('2026-08-31');
  await page.getByLabel(/the file/i).setInputFiles({ name: 'unicode-sales.csv', mimeType: 'text/csv', buffer: Buffer.from(CSV, 'utf8') });
  await page.getByRole('button', { name: /upload and check/i }).click();

  await page.waitForURL(/\/data\/imports\/[0-9a-f-]{36}/, { timeout: 60_000 });
  // No row is refused for its name.
  await expect(page.getByText(/cannot import/i)).toHaveCount(0);

  const question = page.getByRole('button', { name: /yes, that is right|save this answer/i });
  for (let remaining = await question.count(); remaining > 0; remaining -= 1) {
    await question.first().click();
    await expect(question).toHaveCount(remaining - 1, { timeout: 15_000 });
  }
  const commit = page.getByRole('button', { name: /^import \d+ rows?$/i });
  await expect(commit).toBeVisible({ timeout: 15_000 });
  await commit.click();
  await expect(page.getByText(/this file has already been imported/i)).toBeVisible({ timeout: 30_000 });
  await drainQueue(page, slug);

  // The database: six customers, display names exactly as the file had them.
  const stored = sql(`
    select string_agg(c.name, ' | ' order by c.name collate "C") from public.counterparties c
      join public.organizations o on o.id = c.organization_id where o.slug = '${slug}'`);
  expect(stored).toBe('Möller GmbH | Müller GmbH | ΟΔΟΣ Α.Ε. | ООО «Ромашка» | شركة الأمل | 株式会社トヨタ');

  // The screen: each customer under its own name.
  await page.goto(`/app/${slug}/customers`);
  await expect(page.getByRole('heading').first()).toBeVisible();
  for (const name of ['株式会社トヨタ', 'شركة الأمل', 'ΟΔΟΣ Α.Ε.', 'ООО «Ромашка»', 'Müller GmbH', 'Möller GmbH']) {
    await expect(page.getByText(name, { exact: true }).first(), name).toBeVisible({ timeout: 30_000 });
  }
});
