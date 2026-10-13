import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { drainQueue, sql } from '../../e2e/fixtures';

/**
 * Loads the sample business (generate.py; every figure invented) into the local account, through the
 * product's own screens wherever a screen exists: a bank account, a general ledger, a bank statement,
 * sales and purchase invoices, a budget and two balance sheets. Commercial records (a campaign, its
 * spend and won customers) and the Funding Readiness switch are set directly — those are an
 * adviser's and a platform admin's screens. A second, smaller company gives the Command Centre a
 * portfolio.
 */

const EMAIL = process.env.MOTION_SAMPLE_EMAIL ?? '';
const PASSWORD = process.env.MOTION_SAMPLE_PASSWORD ?? '';
const SLUG = process.env.MOTION_SAMPLE_SLUG ?? 'a-org';
const FILES = path.resolve('scripts/sample-data/files');
const file = (name: string) => readFileSync(path.join(FILES, name));

async function signIn(page: Page) {
  expect(EMAIL && PASSWORD, 'set MOTION_SAMPLE_EMAIL and MOTION_SAMPLE_PASSWORD').toBeTruthy();
  await page.goto('/sign-in');
  await page.getByLabel('Email', { exact: true }).fill(EMAIL);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: /log in/i }).click();
  await page.waitForURL(/\/(onboarding|app|select-organization|portfolio)/, { timeout: 30_000 });
}

/** One file through the wizard, answering its questions as the review screen offers them. */
async function importFile(
  page: Page, slug: string, type: string, name: string, from: string, to: string, bankAccountId?: string,
  balances?: { opening: string; closing: string },
) {
  // Resumable: a file already imported for this type and period is not imported twice.
  const done = sql(`select count(*) from public.import_batches b join public.organizations o on o.id = b.organization_id
    where o.slug = '${slug}' and b.import_type = '${type}' and b.status = 'committed' and b.period_start = '${from}' and b.period_end = '${to}'`).trim();
  if (done !== '0') return;
  // An earlier run uploaded it but stopped at the review: carry on there (the same file again is a duplicate).
  const pending = sql(`select b.id from public.import_batches b join public.organizations o on o.id = b.organization_id
    where o.slug = '${slug}' and b.import_type = '${type}' and b.status = 'awaiting_review' and b.period_start = '${from}' and b.period_end = '${to}'
    order by b.created_at desc limit 1`).trim();
  if (pending !== '') {
    await page.goto(`/app/${slug}/data/imports/${pending}`);
  } else {
  await page.goto(`/app/${slug}/data/imports/new`);
  await page.getByLabel('What kind of file is this?').selectOption(type);
  if (bankAccountId) await page.getByLabel('Which account is it for?').selectOption(bankAccountId);
  await page.getByLabel('Covers from').fill(from);
  await page.getByLabel('Covers to').fill(to);
  await page.getByLabel('The file').setInputFiles({ name, mimeType: 'text/csv', buffer: file(name) });
  await page.getByRole('button', { name: /upload and check/i }).click();
  await page.waitForURL(/\/data\/imports\/[0-9a-f-]{36}/, { timeout: 120_000 });
  }
  const question = page.getByRole('button', { name: /yes, that is right|save this answer/i });
  for (let remaining = await question.count(); remaining > 0; remaining -= 1) {
    // A question with a choice: the sample's answer is the complete / yes one (nothing came before
    // January, and the files are whole); otherwise the first real option.
    const select = question.first().locator('xpath=ancestor::form[1]').locator('select');
    if (await select.count() > 0 && (await select.first().inputValue()) === '') {
      const options = await select.first().locator('option').evaluateAll((os) => os.map((o) => ({ value: (o as HTMLOptionElement).value, text: o.textContent ?? '' })));
      const pick = options.find((o) => o.value !== '' && /\byes\b|complete|whole|cumulative|natural/i.test(o.text)) ?? options.find((o) => o.value !== '');
      if (pick) await select.first().selectOption(pick.value);
    }
    await question.first().click();
    await expect(question).toHaveCount(remaining - 1, { timeout: 30_000 });
  }
  // A CSV statement cannot vouch for its own balances: the reviewer types the printed ones (§5.3).
  if (balances) {
    await page.getByLabel('Opening balance printed on the statement').fill(balances.opening);
    await page.getByLabel('Closing balance printed on the statement').fill(balances.closing);
    await page.getByLabel('Closing balance printed on the statement').locator('xpath=ancestor::form[1]').getByRole('button').first().click();
    await expect(page.getByText(/IMP-BAL-007/)).toHaveCount(0, { timeout: 30_000 });
  }
  const skip = page.getByRole('button', { name: /^skip \d+ rows?$/i });
  if (await skip.count() > 0) { await skip.click(); await expect(skip).toHaveCount(0); }
  await page.getByRole('button', { name: /^import \d+ rows?$/i }).click();
  await expect(page.getByText(/this file has already been imported/i)).toBeVisible({ timeout: 120_000 });
}

test('load the sample business', async ({ page }) => {
  await signIn(page);
  const orgId = sql(`select id from public.organizations where slug = '${SLUG}'`).trim();
  expect(orgId, `no company with slug ${SLUG}`).toMatch(/^[0-9a-f-]{36}$/);
  // A bank account, the way the Banking page adds one (once).
  const bankId = () => sql(`select id from public.bank_accounts where organization_id = '${orgId}' and name = 'Business Current'`).trim();
  if (bankId() === '') {
    await page.goto(`/app/${SLUG}/money/banking`);
    await page.getByLabel(/what do you call this account/i).fill('Business Current');
    await page.getByLabel(/which bank is it with/i).fill('Sample Bank');
    await page.getByLabel(/last four digits/i).fill('4821');
    await page.getByRole('button', { name: /add this account/i }).click();
    await expect(page.getByText(/account added/i)).toBeVisible();
  }

  await importFile(page, SLUG, 'general_ledger', 'gl.csv', '2026-01-01', '2026-09-30');
  // The statement's printed balances (generate.py: opening 18,000.00; closing 35,873.26).
  await importFile(page, SLUG, 'bank_statement', 'bank.csv', '2026-01-01', '2026-09-30', bankId(), { opening: '18000.00', closing: '35873.26' });
  await importFile(page, SLUG, 'sales_invoices', 'sales_invoices.csv', '2026-01-01', '2026-09-30');
  await importFile(page, SLUG, 'purchase_invoices', 'purchase_invoices.csv', '2026-01-01', '2026-09-30');
  await importFile(page, SLUG, 'budget', 'budget.csv', '2026-01-01', '2026-09-30');
  await importFile(page, SLUG, 'balance_sheet', 'balance_sheet_jun.csv', '2026-06-01', '2026-06-30');
  await importFile(page, SLUG, 'balance_sheet', 'balance_sheet_sep.csv', '2026-09-01', '2026-09-30');
  await drainQueue(page, SLUG);

  // Commercial records: a campaign with monthly spend that won two customers (ADR-102 attribution).
  const hasCampaign = sql(`select count(*) from public.campaigns where organization_id = '${orgId}'`).trim() !== '0';
  const customer = (name: string) => sql(`select id from public.counterparties where organization_id = '${orgId}' and name = '${name}'`).trim();
  if (!hasCampaign) {
  const campaign = sql(`with q as (insert into public.campaigns (organization_id, name, normalized_name, starts_on, status)
    values ('${orgId}', 'Summer trade promotion', 'summer trade promotion', '2026-06-01', 'active') returning id) select id from q`).trim();
  for (const [month, amount] of [['06', 1800], ['07', 2100], ['08', 2400], ['09', 2200]] as const) {
    sql(`insert into public.campaign_spend (organization_id, campaign_id, period_id, amount, currency)
      select '${orgId}', '${campaign}', id, ${amount}, 'GBP' from public.fiscal_periods where organization_id = '${orgId}' and period_start = '2026-${month}-01'`);
  }
  sql(`insert into public.opportunities (organization_id, name, stage, counterparty_id, campaign_id, estimated_value, currency, created_on, stage_changed_on, won_on)
    values ('${orgId}', 'Delta Offices supply contract', 'won', '${customer('Delta Offices')}', '${campaign}', 60000, 'GBP', '2026-05-20', '2026-06-10', '2026-06-10'),
           ('${orgId}', 'Epsilon Events season', 'won', '${customer('Epsilon Events')}', '${campaign}', 40000, 'GBP', '2026-07-01', '2026-08-03', '2026-08-03')`);
  sql(`insert into public.opportunities (organization_id, name, stage, estimated_value, currency, created_on, stage_changed_on)
    values ('${orgId}', 'Zeta Bistro trial order', 'qualified', 8000, 'GBP', '2026-09-02', '2026-09-12'),
           ('${orgId}', 'Theta Hotel group', 'proposal', 25000, 'GBP', '2026-08-15', '2026-09-20')`);
  }

  // Funding Readiness on (a platform admin's switch); the switch queues the assessment of every month.
  sql(`update public.organizations set features = features || '{"funding_readiness": true, "ai_pdf_extraction": true}'::jsonb where id = '${orgId}'`);
  // A full recalculation, so the Health Score reads the campaign records too.
  sql(`insert into public.jobs (organization_id, job_type, payload, max_attempts) values ('${orgId}', 'calculation.run', '{"trigger":"recalc_manual"}'::jsonb, 3)`);
  await drainQueue(page, SLUG);

  // A forecast, the way the Forecast page asks for one.
  await page.goto(`/app/${SLUG}/forecast`);
  await page.getByRole('button', { name: /try to work one out|work it out again/i }).click();
  await expect(page.getByText(/based on the last \d+ finished months/i).first()).toBeVisible({ timeout: 60_000 });

  // A second company for the Command Centre: smaller, three months, thinner margins.
  const owner = sql(`select id from auth.users where email = '${EMAIL}'`).trim();
  const existingB = sql(`select o.slug from public.organizations o join public.organization_memberships m on m.organization_id = o.id
    where m.user_id = '${owner}' and o.name = 'b'`).trim();
  const created = existingB !== '' ? existingB : sql(`select set_config('request.jwt.claims', json_build_object('sub', '${owner}', 'role', 'authenticated', 'email', '${EMAIL}')::text, false);
    with c as (select api.create_organization('b') as id) select o.slug from c join public.organizations o on o.id = c.id`);
  const slugB = created.split('\n').map((l) => l.trim()).filter(Boolean).pop()!;
  // The session was issued before "b" existed; a fresh sign-in carries it.
  await page.context().clearCookies();
  await signIn(page);
  await importFile(page, slugB, 'general_ledger', 'gl_b.csv', '2026-07-01', '2026-09-30');
  await drainQueue(page, slugB);

  // The scheduled reports (daily and weekly briefs) for both.
  const reports = await page.request.get('/api/jobs/scheduled', { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } });
  expect(reports.status()).toBe(200);
  await drainQueue(page, SLUG);
  await drainQueue(page, slugB);

  console.log('SAMPLE', JSON.stringify({
    slugs: [SLUG, slugB],
    health: sql(`select string_agg(p.label || '=' || coalesce(h.score::text, 'NULL'), ', ' order by p.period_start) from public.health_current hc
      join public.health_scores h on h.id = hc.health_score_id join public.fiscal_periods p on p.id = hc.period_id where hc.organization_id = '${orgId}'`).trim(),
    funding: sql(`select count(*) from public.funding_current where organization_id = '${orgId}'`).trim(),
    reports: sql(`select count(*) from public.reports where organization_id = '${orgId}'`).trim(),
  }));
});
