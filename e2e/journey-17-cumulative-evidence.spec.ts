import { expect, test, type Page } from '@playwright/test';
import { cleanUpOwn, drainQueue, onboard, seedUser, signIn, sql, uniqueName } from './fixtures';

/**
 * Journey 17 — a year-to-date trial balance, through the upload form, to the evidence page (Step 0F).
 *
 * N-1: the reviewer is asked whether the report lists every account, and nothing is pre-selected —
 * "complete" turns every missing line into a zero, so it has to be the reviewer's answer.
 *
 * N-2: August's revenue is year to date (3,310) less July's (2,100) = 1,210. The evidence page shows
 * that subtraction, each side reconciled to what the calculation used for it, with a link to that
 * side's rows; net profit shows every subtraction it rests on. And when a July row is changed behind
 * the engine's back, the page says so — on that side, and in the formula.
 */

const ORGS = { ask: uniqueName('Completeness Question'), show: uniqueName('Cumulative Evidence'), fault: uniqueName('Cumulative Fault') };
const OWNERS = { ask: 'journey17-ask', show: 'journey17-show', fault: 'journey17-fault' };

// Year to date, natural sign, balancing through Cash; Debit / Credit columns so no sign question.
const TB: Record<string, string> = {
  '2026-07': 'Account,Debit,Credit\nRevenue,,2100.00\nCost of Sales,840.00,\nOperating Expenses,600.00,\nCash,660.00,\n',
  '2026-08': 'Account,Debit,Credit\nRevenue,,3310.00\nCost of Sales,1324.00,\nOperating Expenses,900.00,\nCash,1086.00,\n',
};
const END: Record<string, string> = { '2026-07': '2026-07-31', '2026-08': '2026-08-31' };

test.afterAll(() => cleanUpOwn(Object.values(ORGS), Object.values(OWNERS)));

async function importTrialBalance(page: Page, slug: string, ym: string): Promise<void> {
  await page.goto(`/app/${slug}/data/imports/new`);
  await page.getByLabel(/what kind of file/i).selectOption('trial_balance');
  await page.getByLabel(/covers from/i).fill(`${ym}-01`);
  await page.getByLabel(/covers to/i).fill(END[ym]!);
  await page.getByLabel(/the file/i).setInputFiles({ name: `tb-${ym}.csv`, mimeType: 'text/csv', buffer: Buffer.from(TB[ym]!, 'utf8') });
  await page.getByRole('button', { name: /upload and check/i }).click();
  await page.waitForURL(/\/data\/imports\/[0-9a-f-]{36}/, { timeout: 60_000 });

  // N-1: answered as the reviewer would, where the question is asked (its own test checks it is).
  const completeness = page.getByLabel('Every account listed');
  if (await completeness.count() > 0) await completeness.selectOption('complete');
  // Year to date is the basis (the first choice); the remaining questions are confirmations.
  await page.getByLabel('Balance basis').selectOption('cumulative');

  const question = page.getByRole('button', { name: /yes, that is right|save this answer/i });
  for (let remaining = await question.count(); remaining > 0; remaining -= 1) {
    await question.first().click();
    await expect(question).toHaveCount(remaining - 1, { timeout: 15_000 });
  }
  await page.getByRole('button', { name: /^import \d+ rows?$/i }).click();
  await expect(page.getByText(/this file has already been imported/i)).toBeVisible({ timeout: 30_000 });
}

function snapshot(slug: string, key: string): string {
  return sql(`
    select c.snapshot_id from public.metric_current c
      join public.organizations o on o.id = c.organization_id
      join public.fiscal_periods p on p.id = c.period_id and p.organization_id = c.organization_id
     where o.slug = '${slug}' and c.metric_key = '${key}' and c.dimension_type = 'none' and p.period_start = '2026-08-01'`);
}

async function twoMonths(page: Page, key: keyof typeof ORGS): Promise<string> {
  await signIn(page, seedUser(OWNERS[key]));
  const slug = await onboard(page, ORGS[key]);
  await importTrialBalance(page, slug, '2026-07');
  await importTrialBalance(page, slug, '2026-08');
  await drainQueue(page, slug);
  return slug;
}

test('N-1: the completeness question is asked with nothing pre-selected, and the answer is stored', async ({ page }) => {
  await signIn(page, seedUser(OWNERS.ask));
  const slug = await onboard(page, ORGS.ask);
  await page.goto(`/app/${slug}/data/imports/new`);
  await page.getByLabel(/what kind of file/i).selectOption('trial_balance');
  await page.getByLabel(/covers from/i).fill('2026-07-01');
  await page.getByLabel(/covers to/i).fill('2026-07-31');
  await page.getByLabel(/the file/i).setInputFiles({ name: 'tb.csv', mimeType: 'text/csv', buffer: Buffer.from(TB['2026-07']!, 'utf8') });
  await page.getByRole('button', { name: /upload and check/i }).click();
  await page.waitForURL(/\/data\/imports\/[0-9a-f-]{36}/, { timeout: 60_000 });
  await expect(page.getByText('Does this report list every account for the period, including accounts with nothing in them?')).toBeVisible();
  const completeness = page.getByLabel('Every account listed');
  await expect(completeness).toHaveValue('');
  await completeness.selectOption('complete');
  const form = page.locator('form').filter({ has: completeness });
  await form.getByRole('button', { name: /save this answer/i }).click();
  await expect(completeness).toHaveCount(0, { timeout: 15_000 });
  const batch = page.url().match(/imports\/([0-9a-f-]{36})/)![1]!;
  expect(sql(`select confirmations -> 'IMP-TB-016' -> 'value' ->> 'report_complete' from public.import_batches where id = '${batch}'`)).toBe('complete');
});

test('N-2: a cumulative month shows year to date less the prior year to date, each side reconciled and linked', async ({ page }) => {
  const slug = await twoMonths(page, 'show');

  // ---- Revenue, August ----
  await page.goto(`/app/${slug}/evidence?snapshot=${snapshot(slug, 'revenue')}`);
  await page.waitForURL(/\/evidence\/[0-9a-f-]{36}/, { timeout: 30_000 });
  const panel = page.getByTestId('difference-panel').first();
  await expect(panel).toContainText(/Year to date to .*: £3,310\.00 from 1 row — matches the £3,310\.00 the calculation used/);
  await expect(panel).toContainText(/Less: year to date to .*: £2,100\.00 from 1 row — matches the £2,100\.00 the calculation used/);
  await expect(panel.getByTestId('difference-formula')).toHaveText('£3,310.00 − £2,100.00 = £1,210.00, which is this month’s figure.');

  // Both sides link to their own rows, and each block reconciles to its side, never to the figure.
  const links = panel.getByRole('link', { name: /see these rows/i });
  await expect(links).toHaveCount(2);
  for (const index of [0, 1]) {
    const href = await links.nth(index).getAttribute('href');
    expect(href).toMatch(/^#records-[0-9a-f-]{36}$/);
    const block = page.locator(href!);
    await expect(block).toBeVisible();
    await expect(block).toContainText(/which is the year-to-date amount the calculation used/);
    await expect(block).not.toContainText(/does not match/);
  }
  await links.nth(1).click();
  expect(page.url()).toMatch(/#records-[0-9a-f-]{36}$/);
  await expect(page.getByText(/does not match/)).toHaveCount(0);

  // ---- Net profit, August: every subtraction it rests on ----
  await page.goto(`/app/${slug}/evidence?snapshot=${snapshot(slug, 'net_profit')}`);
  await page.waitForURL(/\/evidence\/[0-9a-f-]{36}/, { timeout: 30_000 });
  await expect(page.getByRole('heading', { name: /worked out from year-to-date reports/i })).toBeVisible();
  const formulas = page.getByTestId('difference-formula');
  await expect(formulas.filter({ hasText: '£3,310.00 − £2,100.00 = £1,210.00' })).toHaveCount(1);
  await expect(formulas.filter({ hasText: '£1,324.00 − £840.00 = £484.00' })).toHaveCount(1);
  await expect(formulas.filter({ hasText: '£900.00 − £600.00 = £300.00' })).toHaveCount(1);
  await expect(page.getByText(/does not match/)).toHaveCount(0);
});

test('N-2: a July row changed behind the engine\'s back is stated on that side and in the formula', async ({ page }) => {
  const slug = await twoMonths(page, 'fault');
  sql(`set session_replication_role = replica;
    update public.period_balances b set closing_balance = -2000 from public.accounts a, public.organizations o
     where a.id = b.account_id and a.organization_id = b.organization_id and o.id = b.organization_id
       and o.slug = '${slug}' and a.name = 'Revenue' and b.period_start = '2026-07-01'`);
  await page.goto(`/app/${slug}/evidence?snapshot=${snapshot(slug, 'revenue')}`);
  await page.waitForURL(/\/evidence\/[0-9a-f-]{36}/, { timeout: 30_000 });
  const broken = page.getByTestId('difference-panel').first();
  await expect(broken).toContainText(/£2,000\.00 from 1 row — does not match the £2,100\.00 the calculation used/);
  await expect(broken.getByTestId('difference-formula'))
    .toHaveText('£3,310.00 − £2,000.00 = £1,310.00, which does not match the figure of £1,210.00. Please tell us — a figure that does not reconcile is a fault.');
});
