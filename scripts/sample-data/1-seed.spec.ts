import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import {
  callApiAs, drainQueue, enqueueJob, orgCount, orgIdBySlug, orgRowId, orgRows, organizationsOf,
  switchFeaturesOn, userIdByEmail,
} from './firestore';

/**
 * Loads the sample business (generate.py; every figure invented) into the local account, through the
 * product's own screens wherever a screen exists: a bank account, a general ledger, a bank statement,
 * sales and purchase invoices, a budget and two balance sheets. Commercial records (a campaign, its
 * spend and won customers) go through the app's own functions as the owner, and the Funding
 * Readiness switch is set directly — those are an adviser's and a platform admin's screens. A second,
 * smaller company gives the Command Centre a portfolio. Ids and counts are read from the local
 * Firebase emulators (./firestore.ts).
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
  const orgId = await orgIdBySlug(slug);
  const batches = (status: string) => orgRows(orgId, 'import_batches', [
    ['import_type', '==', type], ['status', '==', status], ['period_start', '==', from], ['period_end', '==', to],
  ]);
  if ((await batches('committed')).length > 0) return;
  // An earlier run uploaded it but stopped at the review: carry on there (the same file again is a duplicate).
  const latest = (await batches('awaiting_review'))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
  const pending = latest ? String(latest.id) : '';
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
  const orgId = await orgIdBySlug(SLUG);
  const owner = { uid: await userIdByEmail(EMAIL), email: EMAIL };
  // A bank account, the way the Banking page adds one (once).
  const bankId = () => orgRowId(orgId, 'bank_accounts', [['name', '==', 'Business Current']]);
  if ((await bankId()) === '') {
    await page.goto(`/app/${SLUG}/money/banking`);
    await page.getByLabel(/what do you call this account/i).fill('Business Current');
    await page.getByLabel(/which bank is it with/i).fill('Sample Bank');
    await page.getByLabel(/last four digits/i).fill('4821');
    await page.getByRole('button', { name: /add this account/i }).click();
    await expect(page.getByText(/account added/i)).toBeVisible();
  }

  await importFile(page, SLUG, 'general_ledger', 'gl.csv', '2026-01-01', '2026-09-30');
  // The statement's printed balances (generate.py: opening 18,000.00; closing 35,873.26).
  await importFile(page, SLUG, 'bank_statement', 'bank.csv', '2026-01-01', '2026-09-30', await bankId(), { opening: '18000.00', closing: '35873.26' });
  await importFile(page, SLUG, 'sales_invoices', 'sales_invoices.csv', '2026-01-01', '2026-09-30');
  await importFile(page, SLUG, 'purchase_invoices', 'purchase_invoices.csv', '2026-01-01', '2026-09-30');
  await importFile(page, SLUG, 'budget', 'budget.csv', '2026-01-01', '2026-09-30');
  await importFile(page, SLUG, 'balance_sheet', 'balance_sheet_jun.csv', '2026-06-01', '2026-06-30');
  await importFile(page, SLUG, 'balance_sheet', 'balance_sheet_sep.csv', '2026-09-01', '2026-09-30');
  await drainQueue(page, SLUG);

  // Commercial records: a campaign with monthly spend that won two customers (ADR-102 attribution).
  // Written with the app's own functions as the owner; amounts in the company's currency (GBP).
  const hasCampaign = (await orgCount(orgId, 'campaigns')) > 0;
  const customer = async (name: string) => {
    const id = await orgRowId(orgId, 'counterparties', [['name', '==', name]]);
    expect(id, `the sales invoices name a customer ${name}`).not.toBe('');
    return id;
  };
  if (!hasCampaign) {
  const campaign = String(await callApiAs(owner, 'upsert_campaign', {
    p_org: orgId, p_input: { name: 'Summer trade promotion', starts_on: '2026-06-01', status: 'active' },
  }));
  for (const [month, amount] of [['06', 1800], ['07', 2100], ['08', 2400], ['09', 2200]] as const) {
    const period = await orgRowId(orgId, 'fiscal_periods', [['period_start', '==', `2026-${month}-01`]]);
    expect(period, `a fiscal period for 2026-${month}`).not.toBe('');
    await callApiAs(owner, 'set_campaign_spend', { p_org: orgId, p_campaign: campaign, p_period: period, p_amount: String(amount), p_note: null });
  }
  const opportunities = [
    { name: 'Delta Offices supply contract', stage: 'won', counterparty_id: await customer('Delta Offices'), campaign_id: campaign, estimated_value: '60000', created_on: '2026-05-20', stage_changed_on: '2026-06-10', won_on: '2026-06-10' },
    { name: 'Epsilon Events season', stage: 'won', counterparty_id: await customer('Epsilon Events'), campaign_id: campaign, estimated_value: '40000', created_on: '2026-07-01', stage_changed_on: '2026-08-03', won_on: '2026-08-03' },
    { name: 'Zeta Bistro trial order', stage: 'qualified', estimated_value: '8000', created_on: '2026-09-02', stage_changed_on: '2026-09-12' },
    { name: 'Theta Hotel group', stage: 'proposal', estimated_value: '25000', created_on: '2026-08-15', stage_changed_on: '2026-09-20' },
  ];
  for (const input of opportunities) await callApiAs(owner, 'upsert_opportunity', { p_org: orgId, p_input: input });
  }

  // Funding Readiness on (a platform admin's switch); the switch queues the assessment of every month.
  await switchFeaturesOn(orgId, ['funding_readiness', 'ai_pdf_extraction']);
  // A full recalculation, so the Health Score reads the campaign records too.
  await enqueueJob(orgId, 'calculation.run', { trigger: 'recalc_manual' }, 3);
  await drainQueue(page, SLUG);

  // A forecast, the way the Forecast page asks for one.
  await page.goto(`/app/${SLUG}/forecast`);
  await page.getByRole('button', { name: /try to work one out|work it out again/i }).click();
  await expect(page.getByText(/based on the last \d+ finished months/i).first()).toBeVisible({ timeout: 60_000 });

  // A second company for the Command Centre: smaller, three months, thinner margins.
  const existingB = (await organizationsOf(owner.uid)).find((o) => o.name === 'b' && o.status !== 'deleted');
  let slugB = existingB ? String(existingB.slug) : '';
  if (slugB === '') {
    // Created the way the product creates one (`api.create_organization`), with the owner as its owner.
    const idB = String(await callApiAs(owner, 'create_organization', { p_name: 'b' }));
    slugB = String((await organizationsOf(owner.uid)).find((o) => o.id === idB)?.slug ?? '');
    expect(slugB, 'company b was created').not.toBe('');
  }
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

  // Each month's current Health Score, in month order: `Jan 2026=71, Feb 2026=NULL, …`.
  const periods = new Map((await orgRows(orgId, 'fiscal_periods')).map((p) => [String(p.id), p]));
  const scores = new Map((await orgRows(orgId, 'health_scores')).map((h) => [String(h.id), h]));
  const health = (await orgRows(orgId, 'health_current'))
    .map((hc) => ({ period: periods.get(String(hc.period_id)), score: scores.get(String(hc.health_score_id))?.score ?? null }))
    .filter((r) => r.period !== undefined)
    .sort((a, b) => String(a.period!.period_start).localeCompare(String(b.period!.period_start)))
    .map((r) => `${String(r.period!.label)}=${r.score === null ? 'NULL' : String(r.score)}`)
    .join(', ');
  console.log('SAMPLE', JSON.stringify({
    slugs: [SLUG, slugB],
    health,
    funding: String(await orgCount(orgId, 'funding_current')),
    reports: String(await orgCount(orgId, 'reports')),
  }));
});
