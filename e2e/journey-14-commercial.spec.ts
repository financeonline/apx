import { expect, test, type Page } from '@playwright/test';
import { cleanUpOwn, drainQueue, onboard, seedUser, signIn, sql, uniqueName } from './fixtures';

/**
 * Journey 14 — Commercial Intelligence (Phase 14, ADR-102; REQ-CI).
 *
 * An owner whose August sales the engine already knows records a service, splits Acme's invoice
 * into lines, adds a channel and a campaign, records the campaign's spend, and marks the Acme
 * opportunity as won through it. Marketing then credits Acme's revenue to the campaign — from the
 * month it was won, at MOTION's customer_revenue figure — and states the cost per customer with its
 * denominator. Contribution stays "unavailable" because no cost line exists. A client reads every
 * page with no form on it. Nothing on any page is a guess: each figure names its rule.
 */
const ORG = uniqueName('Commercial Ltd');

test.afterAll(() => cleanUpOwn([ORG], ['journey14-owner', 'journey14-client']));

async function mainText(page: Page): Promise<string> {
  return (await page.locator('main').innerText()).replace(/\s+/g, ' ');
}
const first = (s: string): string => s.split('\n')[0]!.trim();

test('an owner records products, lines, a campaign and a won deal; marketing credits revenue by rule; a client reads it all with no controls', async ({ page }) => {
  const owner = seedUser('journey14-owner');
  const client = seedUser('journey14-client');
  await signIn(page, owner);
  const slug = await onboard(page, ORG);
  const orgId = sql(`select id from public.organizations where slug = '${slug}'`).trim();
  sql(`insert into public.organization_memberships (organization_id, user_id, role, status) values ('${orgId}', '${client.userId}', 'client', 'active')`);

  // ---- 0. What the engine already knows: one customer, one August invoice, a covering batch. ----
  const acme = first(sql(`insert into public.counterparties (organization_id, name, kind) values ('${orgId}', 'Acme Ltd', 'customer') returning id`));
  sql(`insert into public.invoices (organization_id, invoice_type, counterparty_id, invoice_number, issue_date, due_date, period_id, subtotal, tax_amount, total_amount, amount_paid, status, record_status, assurance_level)
       values ('${orgId}', 'sales', '${acme}', 'A-100', '2026-08-10', '2026-09-09', '00000000-0000-0000-0000-000000000000', 6000, 1200, 7200, 0, 'open', 'accepted', 'verified')`);
  const doc = first(sql(`insert into public.source_documents (organization_id, storage_path, original_filename, mime_type, byte_size, sha256, status, document_kind)
       values ('${orgId}', '${orgId}/j14/sales.csv', 'sales.csv', 'text/csv', 10, decode('14','hex'), 'ready', 'invoice') returning id`));
  sql(`insert into public.import_batches (organization_id, source_document_id, import_type, target_table, status, extraction_method, period_start, period_end, committed_at, invoice_list_kind)
       values ('${orgId}', '${doc}', 'sales_invoices', 'invoices', 'committed', 'csv', '2026-06-01', '2026-08-31', now(), 'full')`);
  const firstPeriod = sql(`select id from public.fiscal_periods where organization_id = '${orgId}' order by period_start limit 1`).trim();
  sql(`insert into public.jobs (organization_id, job_type, payload, max_attempts) values ('${orgId}', 'calculation.run', '{"trigger":"banking_edit","period_ids":["${firstPeriod}"],"as_of":"2026-09-15"}'::jsonb, 3)`);
  await drainQueue(page, slug);
  const aug = sql(`select id from public.fiscal_periods where organization_id = '${orgId}' and period_start = '2026-08-01'`).trim();

  // ---- 1. A service, on the Products tab. ------------------------------------------------------
  await page.goto(`/app/${slug}/customers/products?period=${aug}`);
  await expect(page.getByRole('heading', { name: /products and services/i }).first()).toBeVisible();
  await page.getByLabel(/what is it called/i).fill('Consulting');
  await page.getByRole('button', { name: /add this product or service/i }).click();
  await expect(page.getByText(/^saved\.$/i)).toBeVisible({ timeout: 15_000 });
  await page.reload();
  await expect(page.getByRole('link', { name: 'Consulting' })).toBeVisible();

  // ---- 2. Split Acme's invoice: 4,000 to Consulting, 2,000 left unattributed. ------------------
  await page.goto(`/app/${slug}/customers/${acme}?period=${aug}`);
  await expect(page.getByRole('heading', { name: 'Acme Ltd' })).toBeVisible();
  await expect(page.getByTestId('customer-contribution-note')).toContainText(/shared overhead/i);
  await page.locator('summary', { hasText: /split into lines/i }).first().click();
  await page.getByLabel('Line 1 product').selectOption({ label: 'Consulting' });
  await page.getByLabel('Line 1 amount').fill('4000');
  await page.getByRole('button', { name: /save lines/i }).click();
  await expect(page.getByText(/saved 1 line/i)).toBeVisible({ timeout: 15_000 });
  await page.reload();
  await expect(page.getByTestId('lines-A-100')).toContainText('Consulting');
  await expect(page.getByTestId('lines-A-100')).toContainText('4,000');
  await expect(page.getByTestId('customer-products')).toContainText('Consulting');

  // Products now reconcile: 4,000 attributed, 2,000 not, and contribution honestly unavailable.
  await page.goto(`/app/${slug}/customers/products?period=${aug}`);
  const products = await mainText(page);
  expect(products).toContain('4,000');
  expect(products).toContain('Contribution unavailable — cost data is insufficient.');
  await expect(page.getByTestId('products-unattributed')).toContainText('2,000');

  // ---- 3. A channel and a campaign, then its August spend. -------------------------------------
  await page.goto(`/app/${slug}/customers/marketing?period=${aug}`);
  await page.getByLabel(/channel name/i).fill('Instagram');
  await page.getByRole('button', { name: /add channel/i }).click();
  await expect(page.getByText(/channel added/i)).toBeVisible({ timeout: 15_000 });
  await page.reload();
  await page.getByLabel(/campaign name/i).fill('Summer reels');
  await page.getByLabel(/which channel/i).selectOption({ label: 'Instagram' });
  await page.getByRole('button', { name: /add campaign/i }).click();
  await expect(page.getByText(/campaign added/i)).toBeVisible({ timeout: 15_000 });
  await page.reload();
  // Before any deal is won: no revenue is credited, and the page says why.
  await expect(page.getByText(/no revenue attributed/i).first()).toBeVisible();
  await page.getByRole('link', { name: 'Summer reels' }).click();
  await page.waitForURL(/\/customers\/marketing\/[0-9a-f-]{36}/);
  const campaignUrl = page.url();
  await page.locator('#spend_period').selectOption(aug);
  await page.locator('#spend_amount').fill('300');
  await page.getByRole('button', { name: /record spend/i }).click();
  await expect(page.getByText(/spend recorded/i)).toBeVisible({ timeout: 15_000 });

  // ---- 4. The Acme opportunity, won through the campaign in August. ----------------------------
  await page.goto(`/app/${slug}/customers/sales?period=${aug}`);
  await page.locator('#opp_name').fill('Acme retainer');
  await page.locator('#opp_stage').selectOption('won');
  await page.locator('#opp_value').fill('6000');
  await page.locator('#opp_customer').selectOption({ label: 'Acme Ltd' });
  await page.locator('#opp_campaign').selectOption({ label: 'Summer reels' });
  await page.locator('#opp_created').fill('2026-07-20');
  await page.locator('#opp_won').fill('2026-08-05');
  await page.getByRole('button', { name: /add to the pipeline/i }).click();
  await expect(page.getByText(/added to the pipeline\./i)).toBeVisible({ timeout: 15_000 });
  await page.reload();
  await expect(page.getByRole('cell', { name: 'Acme retainer' })).toBeVisible();
  // Conversion names its cohort and its rates.
  await expect(page.getByTestId('sales-opp-to-customer')).toContainText('100');

  // ---- 5. Marketing credits Acme's revenue to the campaign — by rule, from the won month. -------
  await page.goto(campaignUrl.replace(/\?.*$/, '') + `?period=${aug}`);
  await expect(page.getByTestId('campaign-customers-won')).toContainText('1');
  await expect(page.getByTestId('campaign-attributed')).toContainText('6,000');
  await expect(page.getByTestId('campaign-cac')).toContainText('300');
  const campaign = await mainText(page);
  expect(campaign).toMatch(/attributed through won opportunities/i);
  expect(campaign).toMatch(/only revenue invoiced from the month an opportunity was won is credited/i);
  await page.goto(`/app/${slug}/customers/marketing?period=${aug}`);
  await expect(page.getByTestId('marketing-totals')).toContainText('300');
  await expect(page.getByTestId('marketing-totals')).toContainText('6,000');

  // The overview ties it together.
  await page.goto(`/app/${slug}/customers?period=${aug}`);
  await expect(page.getByTestId('commercial-top-products')).toContainText('Consulting');
  await expect(page.getByTestId('commercial-marketing')).toContainText('Summer reels');
  await expect(page.getByTestId('commercial-pipeline')).toContainText(/1 won/);
  expect(await mainText(page)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i);

  // ---- 6. A client reads the same pages and is offered nothing to change. ----------------------
  await page.context().clearCookies();
  await signIn(page, client);
  await page.goto(`/app/${slug}/customers/products?period=${aug}`);
  const clientProducts = await mainText(page);
  expect(clientProducts).toContain('4,000');
  expect(clientProducts).not.toMatch(/add a product or service/i);
  await page.goto(`/app/${slug}/customers/sales?period=${aug}`);
  const clientSales = await mainText(page);
  expect(clientSales).toContain('Acme retainer');
  expect(clientSales).not.toMatch(/add an opportunity/i);
  expect(await page.locator('select').count()).toBe(0);
  await page.goto(campaignUrl.replace(/\?.*$/, '') + `?period=${aug}`);
  const clientCampaign = await mainText(page);
  expect(clientCampaign).toContain('6,000');
  expect(clientCampaign).not.toMatch(/record spend/i);
  await page.goto(`/app/${slug}/customers/${acme}?period=${aug}`);
  expect(await page.locator('summary', { hasText: /split into lines/i }).count()).toBe(0);

  // A malformed or foreign id is the uniform 404.
  const malformed = await page.goto(`/app/${slug}/customers/marketing/not-an-id`);
  expect(malformed?.status()).toBe(404);
  const foreign = await page.goto(`/app/${slug}/customers/products/00000000-0000-4000-8000-000000000000`);
  expect(foreign?.status()).toBe(404);
});
