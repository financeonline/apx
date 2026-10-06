import { expect, test } from '@playwright/test';
import {
  GL_CSV, addBankAccount, cleanUpOwn, drainQueue, importLedger, importStatement, onboard, seedUser, signIn, sql, uniqueName,
} from './fixtures';

/**
 * Journey 18 — Intelligent Reporting (Phase 17, ADR-141).
 *
 * An owner imports yesterday's bank statement, reads today's brief so far, has yesterday's brief
 * produced and kept, drills a figure to the transaction behind it, and produces its PDF. A second
 * owner builds a Custom AI Report from the analyst's own answers. Every report type the agreement
 * lists has a place on the Reports page — the Funding Readiness Report saying it is not available
 * yet rather than being hidden.
 */

const ORGS = { brief: uniqueName('Reports Brief'), custom: uniqueName('Reports Custom') };
const OWNERS = { brief: 'journey18-brief', custom: 'journey18-custom' };

test.afterAll(() => cleanUpOwn(Object.values(ORGS), Object.values(OWNERS)));

/** Yesterday in London, the default organisation timezone. */
function londonDate(offsetDays: number): string {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
  const [y, m, d] = today.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + offsetDays)).toISOString().slice(0, 10);
}

test('a daily brief is produced, kept, drilled to its records and printed', async ({ page }) => {
  test.setTimeout(240_000);
  await signIn(page, seedUser(OWNERS.brief));
  const slug = await onboard(page, ORGS.brief);

  const yesterday = londonDate(-1);
  await addBankAccount(page, slug, 'Current');
  await importStatement(page, slug, [
    'Date,Description,Paid Out,Paid In,Balance',
    `${yesterday},FPS CREDIT INVOICE 2001,,1200.00,11200.00`,
    `${yesterday},OFFICE RENT,400.25,,10799.75`,
  ].join('\n'), 'yesterday.csv', yesterday, yesterday);
  await drainQueue(page, slug);

  await page.goto(`/app/${slug}/reports`);
  for (const heading of ['Daily Executive Brief', 'Weekly Intelligence Report', 'Monthly Management Report',
    'Accountant/CFO Report', 'Custom AI Report', 'Funding Readiness Report']) {
    await expect(page.getByRole('heading', { name: heading })).toBeVisible();
  }
  await expect(page.getByText(/arrives with the Funding Readiness assessment, which is not available yet/)).toBeVisible();

  // Today so far: shown, and said to be unfinished.
  await page.getByRole('link', { name: 'Today so far' }).click();
  await expect(page.getByText('This day is not over')).toBeVisible();
  await page.getByRole('link', { name: 'Back to reports' }).click();

  // Yesterday's brief, produced on request (the first day offered is yesterday).
  const daily = page.locator('form').filter({ has: page.getByRole('button', { name: 'Produce a brief' }) });
  await expect(daily.getByLabel('Day')).toHaveValue(yesterday);
  await daily.getByRole('button', { name: 'Produce a brief' }).click();
  await expect(page.getByText(/we are producing the report/i)).toBeVisible({ timeout: 15_000 });
  await drainQueue(page, slug);
  await page.reload();

  const reportId = sql(`
    select r.id from public.reports r join public.organizations o on o.id = r.organization_id
     where o.slug = '${slug}' and r.report_kind = 'daily_brief' and r.window_start = '${yesterday}'`).trim();
  expect(reportId).toMatch(/^[0-9a-f-]{36}$/);
  await page.goto(`/app/${slug}/reports/r/${reportId}`);

  await expect(page.getByRole('heading', { name: 'Key movements' })).toBeVisible();
  // Interim figures are shown to the penny.
  await expect(page.getByRole('definition').filter({ hasText: /^£1,200\.00$/ })).toBeVisible();
  await expect(page.getByRole('definition').filter({ hasText: /^£400\.25$/ })).toBeVisible();

  // The figure drills to the transaction behind it (SOW §14).
  await page.getByText('What this is made of (1 record)').first().click();
  await page.getByRole('link', { name: /FPS CREDIT INVOICE 2001/i }).first().click();
  await expect(page).toHaveURL(/\/evidence\/record\/bank\/[0-9a-f-]{36}$/);

  // And the PDF: produced by the queue, then offered.
  await page.goto(`/app/${slug}/reports/r/${reportId}`);
  await page.getByRole('button', { name: 'Produce a PDF' }).click();
  await expect(page.getByText(/we are producing the pdf/i)).toBeVisible({ timeout: 15_000 });
  await drainQueue(page, slug);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Open the PDF' })).toBeVisible();
});

test('a custom report is built from the analyst\'s own answers and kept for its author', async ({ page }) => {
  test.setTimeout(300_000);
  await signIn(page, seedUser(OWNERS.custom));
  const slug = await onboard(page, ORGS.custom);
  await importLedger(page, slug, GL_CSV);
  await drainQueue(page, slug);

  await page.goto(`/app/${slug}/reports/custom/new`);
  await expect(page.getByRole('combobox', { name: 'Month' })).toBeVisible();
  await page.getByLabel('Cash', { exact: true }).check();
  await page.getByLabel('What changed this month?', { exact: true }).check();
  await page.getByRole('button', { name: /ask the analyst and build the report/i }).click();

  // Whether or not a model is reachable in this environment, the turn is recorded and the report is
  // saved: an unanswered question stays in the report as unanswered.
  await page.waitForURL(/\/reports\/r\/[0-9a-f-]{36}$/, { timeout: 120_000 });
  await expect(page.getByRole('heading', { name: /^Custom AI Report — / })).toBeVisible();
  await expect(page.getByRole('heading', { name: /1\. For .+, looking at cash: What changed this month\?/ })).toBeVisible();
  await expect(page.getByText('Looking at: Cash.')).toBeVisible();

  const reportId = page.url().match(/\/reports\/r\/([0-9a-f-]{36})$/)![1]!;
  expect(sql(`select report_kind || '|' || origin from public.reports where id = '${reportId}'`).trim()).toBe('custom_ai|requested');
});
