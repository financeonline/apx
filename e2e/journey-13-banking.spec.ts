import { expect, test, type Page } from '@playwright/test';
import { cleanUpOwn, drainQueue, onboard, seedUser, signIn, sql, uniqueName } from './fixtures';

/**
 * Journey 13 — Banking Intelligence (Phase 13, ADR-101; REQ-BK-01…11).
 *
 * An owner with no bank account adds one, uploads a statement, and reads the Banking page in the
 * order a non-accountant asks the questions: how much is there, what moved, what should I notice,
 * which accounts. They open a transaction, see where it came from and who categorised it, and
 * change a category. A client then reads the same pages with no controls. On every page the words
 * "connected", "live" and "synced" never appear: the data is imported statements, and says so.
 */
const ORG = uniqueName('Banking Ltd');
// Paid out / paid in columns: the shape most banks export, and the one the wizard can read without
// asking which way round a single signed column runs.
const STATEMENT = [
  'Date,Description,Paid Out,Paid In,Balance',
  '2026-08-02,TESCO STORES 3456,24.10,,9975.90',
  '2026-08-05,FPS CREDIT NORTHWIND,,9000.00,18975.90',
  '2026-08-10,TRANSFER TO SAVINGS,1000.00,,17975.90',
  '2026-08-11,BRITISH GAS DD,88.40,,17887.50',
  '2026-08-19,RENT PAYMENT,950.00,,16937.50',
  '2026-08-28,PAYROLL ACME LTD,2500.00,,14437.50',
].join('\n');

const FORBIDDEN = /\b(connected|synced|live feed|real[- ]time)\b/i;

test.afterAll(() => cleanUpOwn([ORG], ['journey13-owner', 'journey13-client']));

async function mainText(page: Page): Promise<string> {
  return (await page.locator('main').innerText()).replace(/\s+/g, ' ');
}

/** The page's own "not connected to your bank" sentence is the one permitted use of the word. */
function claimsLiveBank(text: string): boolean {
  return FORBIDDEN.test(text.replace(/not connected to your bank/gi, ''));
}

test('an owner adds an account, imports a statement, and reads their banking; a client reads it with no controls', async ({ page }) => {
  const owner = seedUser('journey13-owner');
  const client = seedUser('journey13-client');
  await signIn(page, owner);
  const slug = await onboard(page, ORG);
  const orgId = sql(`select id from public.organizations where slug = '${slug}'`).trim();
  sql(`insert into public.organization_memberships (organization_id, user_id, role, status)
       values ('${orgId}', '${client.userId}', 'client', 'active')`);

  // ---- 1. Nothing yet: the page asks for an account first, and offers the form. ---------------
  await page.goto(`/app/${slug}/money/banking`);
  await expect(page.getByText(/add a bank account, then upload its statement/i)).toBeVisible();
  expect(claimsLiveBank(await mainText(page))).toBe(false);
  await page.getByLabel(/what do you call this account/i).fill('Main current account');
  await page.getByLabel(/which bank is it with/i).fill('Test Bank');
  await page.getByLabel(/last four digits/i).fill('1234');
  await page.getByRole('button', { name: /add this account/i }).click();
  await expect(page.getByText(/account added/i)).toBeVisible({ timeout: 15_000 });

  // ---- 2. A statement, through the real wizard. ------------------------------------------------
  await page.goto(`/app/${slug}/data/imports/new`);
  await page.getByLabel(/what kind of file/i).selectOption('bank_statement');
  await expect(page.getByLabel(/which account is it for/i)).toContainText('Main current account');
  await page.getByLabel(/covers from/i).fill('2026-08-01');
  await page.getByLabel(/covers to/i).fill('2026-08-31');
  await page.getByLabel(/the file/i).setInputFiles({ name: 'aug-statement.csv', mimeType: 'text/csv', buffer: Buffer.from(STATEMENT, 'utf8') });
  await page.getByRole('button', { name: /upload and check/i }).click();
  await page.waitForURL(/\/data\/imports\/[0-9a-f-]{36}/, { timeout: 60_000 });
  const question = page.getByRole('button', { name: /yes, that is right|save this answer/i });
  for (let remaining = await question.count(); remaining > 0; remaining -= 1) {
    await question.first().click();
    await expect(question).toHaveCount(remaining - 1, { timeout: 15_000 });
  }
  const skip = page.getByRole('button', { name: /^skip \d+ rows?$/i });
  if (await skip.count() > 0) { await skip.click(); await expect(skip).toHaveCount(0, { timeout: 15_000 }); }
  await page.getByRole('button', { name: /^import \d+ rows?$/i }).click();
  await expect(page.getByText(/this file has already been imported/i)).toBeVisible({ timeout: 30_000 });
  await drainQueue(page, slug);

  // ---- 3. The Banking page, in the reader's order. ---------------------------------------------
  const august = sql(`select id from public.fiscal_periods where organization_id = '${orgId}' and period_start = '2026-08-01'`).trim();
  await page.goto(`/app/${slug}/money/banking?period=${august}`);
  await expect(page.getByRole('heading', { name: /^banking/i })).toBeVisible();
  const overview = await mainText(page);
  expect(overview).toContain('MOTION is not connected to your bank');
  expect(overview).toMatch(/based on imported statements/i);
  expect(overview).toMatch(/last statement imported/i);
  expect(claimsLiveBank(overview)).toBe(false);
  // Level 2: the month's money out is the statement's outflows, in the organisation's currency.
  await expect(page.getByTestId('banking-month')).toContainText('4,562.50');
  // Things to notice: the one-legged "TRANSFER TO SAVINGS" is called out, not silently paired.
  await expect(page.getByTestId('banking-notices')).toContainText(/looks like a transfer between your own accounts/i);
  // Accounts: the statement's closing balance is shown as the statement's, not as a calculation.
  await expect(page.getByTestId('banking-accounts')).toContainText('Main current account');
  await expect(page.getByTestId('banking-accounts')).toContainText('14,437.50');
  await expect(page.getByTestId('banking-accounts')).toContainText(/balance on the statement at/i);
  // Where the money went: payroll categorised by rule; the categories are bank movement, not P&L.
  await page.getByTestId('banking-categories').locator('summary').click();
  await expect(page.getByTestId('banking-categories')).toContainText('Payroll');
  await expect(page.getByTestId('banking-categories')).toContainText('2,500.00');
  await page.getByTestId('banking-reconciliation').locator('summary').click();
  await expect(page.getByTestId('banking-reconciliation')).toContainText(/never marked reconciled just because it was imported/i);

  // ---- 4. Transactions, then one transaction. --------------------------------------------------
  await page.getByRole('link', { name: /all transactions/i }).click();
  await expect(page.getByRole('heading', { level: 1, name: /transactions/i })).toBeVisible();
  expect(claimsLiveBank(await mainText(page))).toBe(false);
  await page.getByRole('link', { name: /not yet categorised/i }).click();
  await expect(page.getByText(/FPS CREDIT NORTHWIND/)).toBeVisible();
  await page.getByRole('link', { name: /^All$/ }).first().click();
  await page.getByRole('link', { name: 'PAYROLL ACME LTD' }).click();
  await expect(page.getByRole('heading', { name: 'PAYROLL ACME LTD' })).toBeVisible();
  await expect(page.getByTestId('txn-amount')).toContainText('2,500.00');
  const detail = await mainText(page);
  expect(detail).toMatch(/set by motion.s rules/i);
  expect(detail).toMatch(/counted in your figures/i);
  expect(detail).toMatch(/where this line came from/i);
  expect(detail).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i); // no ids on screen
  expect(claimsLiveBank(detail)).toBe(false);
  const transactionUrl = page.url();
  // The source link works: the record page renders the line's standing and its import.
  await page.getByRole('link', { name: /where this line came from/i }).click();
  await page.waitForURL(/\/evidence\/record\/bank\//);
  await expect(page.getByRole('heading', { name: 'PAYROLL ACME LTD' })).toBeVisible();
  await expect(page.getByText(/is it counted\?/i)).toBeVisible();
  await page.goBack();

  // ---- 5. The owner changes a category; their choice is recorded as theirs. --------------------
  const marketing = await page.locator('#category_account_id option', { hasText: /marketing/i }).first().getAttribute('value');
  expect(marketing, 'the organisation has a marketing account to choose').toBeTruthy();
  await page.getByLabel(/which category does this belong to/i).selectOption(marketing!);
  await page.getByRole('button', { name: /save category/i }).click();
  await expect(page.getByText(/category saved/i)).toBeVisible({ timeout: 15_000 });
  await page.reload();
  expect(await mainText(page)).toMatch(/chosen by you/i);

  // ---- 6. A client reads the same pages and is offered nothing to change. ----------------------
  await page.context().clearCookies();
  await signIn(page, client);
  const response = await page.goto(`/app/${slug}/money/banking?period=${august}`);
  expect(response?.status()).toBe(200);
  const clientView = await mainText(page);
  expect(clientView).toContain('MOTION is not connected to your bank');
  expect(clientView).not.toMatch(/add a bank account/i);
  await page.goto(transactionUrl);
  const clientDetail = await mainText(page);
  expect(clientDetail).not.toMatch(/change the category/i);
  expect(clientDetail).not.toMatch(/is this a transfer/i);
  expect(clientDetail).toMatch(/can see what the figures rest on but not the uploaded file/i);
  // A client reaches the record page too, and stops at the document (RBAC: documents.view).
  await page.getByRole('link', { name: /where this line came from/i }).click();
  await page.waitForURL(/\/evidence\/record\/bank\//);
  await expect(page.getByRole('heading', { name: 'PAYROLL ACME LTD' })).toBeVisible();
  const clientRecord = await mainText(page);
  expect(clientRecord).toMatch(/is it counted\?/i);
  expect(clientRecord).not.toMatch(/aug-statement\.csv/i);
});
