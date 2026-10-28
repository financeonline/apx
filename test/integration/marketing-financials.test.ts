import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withOrgScope } from '@/core/db';
/*
 * A relative import: the Marketing barrel (`@/modules/marketing`) is written alongside this feature,
 * and `motion/no-deep-module-import` (correctly) refuses `@/modules/marketing/services/financials`.
 */
import { loadMarketingFinancials } from '../../src/modules/marketing/services/financials';
import { ensurePeriods, periodId } from '@/db/app/shared';
import { orgRow } from '@/db/schema';
import { clientFor, createAuthUser, fs, rpc } from './setup';
import {
  dropFixtures, ok, parkQueuedJobs, rowsOf, seedAccount, seedCounterparty, seedInvoice, writeRun as writeEngineRun,
} from './f-fixtures';

/**
 * Section 03 of the Marketing report (ADR-170) against the database: what `loadMarketingFinancials`
 * reads, on the job's scoped service client, from the snapshots a calculation run writes.
 *
 * The organisation's year starts in OCTOBER, so a financial year straddles two calendar years — the
 * case a January default would hide. It holds eighteen complete months (Oct 2024 – Mar 2026, i.e. the
 * year ended 30 September 2025 and six months of the next) and one month still in progress whose
 * figures must not be counted. A second organisation carries enormous figures for the same months, so
 * any query that forgot to name the organisation would show at once.
 *
 * The snapshots are written exactly as a run writes them (`metric_current` → `metric_snapshots`); the
 * job queue is not drained, so nothing else on the shared emulator is touched. The fixtures are
 * run-unique and only they are removed.
 */

const SUITE = randomUUID().slice(0, 8);
const EMAIL_DOMAIN = `${SUITE}.mktfin.itest.motion`;
const NAME = `Mktfin ${SUITE}`;

let orgId: string;
let otherOrgId: string;
const period = new Map<string, string>(); // 'YYYY-MM' → period id (orgId)
const account = new Map<string, string>();

const orgs: string[] = [];

/** Eighteen complete months, Oct 2024 – Mar 2026, then April 2026 in progress. */
const COMPLETE: string[] = [];
for (let i = 0; i < 18; i += 1) {
  const y = 2024 + Math.floor((9 + i) / 12);
  const m = ((9 + i) % 12) + 1;
  COMPLETE.push(`${y}-${String(m).padStart(2, '0')}`);
}
const IN_PROGRESS = '2026-04';
const inLatestYear = (ym: string) => ym >= '2025-10';

interface Snap {
  readonly ym: string;
  readonly key: string;
  readonly value: string | null;
  readonly dimensionType?: 'none' | 'standard_category' | 'account';
  readonly dimensionId?: string;
  readonly dimensionKey?: string;
  readonly components?: Record<string, unknown>;
}

/** One calculation run and every snapshot and pointer in it, as the engine writes them. */
async function writeRun(org: string, periods: ReadonlyMap<string, string>, snaps: readonly Snap[]): Promise<void> {
  await writeEngineRun(org, snaps.map((s) => ({
    periodId: periods.get(s.ym)!, key: s.key, value: s.value, dimensionType: s.dimensionType ?? 'none',
    dimensionId: s.dimensionId ?? null, dimensionKey: s.dimensionKey ?? null, components: s.components ?? {},
  })));
}

/**
 * The statement for one month. The year ended Sep 2025: revenue 10,000, cost of sales 4,000, running
 * costs 3,000 (rent 1,300, marketing 250, payroll 1,450), tax 500, net profit 2,500. The six months
 * since: revenue 12,000, cost of sales 5,000, running costs 3,500 (rent 1,500, marketing 400, payroll
 * 1,600), tax 500, net profit 3,000.
 */
function statement(ym: string): Snap[] {
  const latest = inLatestYear(ym);
  const [rev, cos, gp, opex, np] = latest ? ['12000', '5000', '7000', '3500', '3000'] : ['10000', '4000', '6000', '3000', '2500'];
  const [rent, marketing, payroll] = latest ? ['1500', '400', '1600'] : ['1300', '250', '1450'];
  const snaps: Snap[] = [
    { ym, key: 'revenue', value: rev }, { ym, key: 'cost_of_sales', value: cos }, { ym, key: 'gross_profit', value: gp },
    { ym, key: 'operating_expenses', value: opex }, { ym, key: 'net_profit', value: np },
    { ym, key: 'other_income', value: '0' }, { ym, key: 'tax_expense', value: '500' },
    ...([['cost_of_sales', cos], ['operating_expense', rent], ['marketing', marketing], ['payroll', payroll], ['tax_expense', '500']] as const)
      .map(([category, value]) => ({ ym, key: 'expense_by_category', value, dimensionType: 'standard_category' as const, dimensionKey: category, components: { category } })),
  ];
  if (latest) {
    for (const [name, category, value] of [
      ['Freight', 'cost_of_sales', cos], ['Rent', 'operating_expense', rent], ['Advertising', 'marketing', marketing],
      ['Wages', 'payroll', payroll], ['Corporation tax', 'tax_expense', '500'],
    ] as const) {
      snaps.push({ ym, key: 'expense_by_account', value, dimensionType: 'account', dimensionId: account.get(name)!, components: { category } });
    }
  }
  return snaps;
}

async function createOrg(ownerId: string, name: string): Promise<string> {
  const id = await ok(rpc<string>(clientFor(ownerId), 'create_organization', { p_name: name, p_fiscal_year_start_month: 10 }));
  orgs.push(id);
  // The snapshots here are written by hand: no real calculation may run for this organisation.
  await parkQueuedJobs(id);
  await ensurePeriods(fs(), id, '2024-10-01', '2026-04-01');
  return id;
}

beforeAll(async () => {
  const ownerId = await createAuthUser(`owner-${SUITE}@${EMAIL_DOMAIN}`);
  orgId = await createOrg(ownerId, NAME);
  otherOrgId = await createOrg(ownerId, `${NAME} other`);

  for (const ym of [...COMPLETE, IN_PROGRESS]) period.set(ym, periodId(orgId, `${ym}-01`));
  for (const org of [orgId, otherOrgId]) {
    for (const p of await rowsOf(org, 'fiscal_periods')) {
      await orgRow(fs(), org, 'fiscal_periods', String(p.id)).update({ is_complete: String(p.period_start) < '2026-04-01' });
    }
  }

  for (const [name, category] of [
    ['Freight', 'cost_of_sales'], ['Rent', 'operating_expense'], ['Advertising', 'marketing'], ['Wages', 'payroll'], ['Corporation tax', 'tax_expense'],
  ] as const) {
    account.set(name, await seedAccount(orgId, { name, category, accountType: 'expense' }));
  }

  // April is in progress: its figures exist and must not be counted.
  await writeRun(orgId, period, [...COMPLETE.flatMap(statement), { ym: IN_PROGRESS, key: 'revenue', value: '999999' }]);

  // Another organisation, the same months, figures nobody could mistake.
  const otherPeriods = new Map(COMPLETE.map((ym) => [ym, periodId(otherOrgId, `${ym}-01`)]));
  await writeRun(otherOrgId, otherPeriods, COMPLETE.flatMap((ym) => (['revenue', 'cost_of_sales', 'operating_expenses', 'net_profit'] as const)
    .map((key) => ({ ym, key, value: '7777777' }))));

  // Campaign spend is recorded too, but the accounts show marketing, so it must not be added.
  const owner = clientFor(ownerId);
  const campaign = await ok(rpc<string>(owner, 'upsert_campaign', { p_org: orgId, p_input: { name: 'Autumn' } }));
  await ok(rpc(owner, 'set_campaign_spend', { p_org: orgId, p_campaign: campaign, p_period: period.get('2025-11'), p_amount: '999.00', p_note: null }));

  // Products, attributed by invoice lines (ADR-102).
  const customer = await seedCounterparty(orgId, { name: 'Shopper', kind: 'customer' });
  const handbags = await ok(rpc<string>(owner, 'upsert_product', { p_org: orgId, p_input: { name: 'Handbags' } }));
  const wallets = await ok(rpc<string>(owner, 'upsert_product', { p_org: orgId, p_input: { name: 'Wallets' } }));
  const invoice = (type: string, number: string, date: string, total: string, status = 'open') => seedInvoice(orgId, {
    counterpartyId: customer, type, number, issueDate: date, dueDate: date, subtotal: total, tax: '0', total, status,
  });
  const lines = async (invoiceId: string, items: Array<[string, string]>) => {
    // Lines are written by `api.set_invoice_lines`, which accepts any current, accepted invoice —
    // a void one included — so every invoice here is lined the same way.
    await ok(rpc(owner, 'set_invoice_lines', { p_invoice: invoiceId, p_lines: items.map(([product_id, amount]) => ({ product_id, amount })) }));
  };

  await lines(await invoice('sales', 'S-1', '2024-11-10', '1200.00'), [[handbags, '1000.00'], [wallets, '200.00']]);
  // June 2025 is outside the like-for-like months (Oct–Mar), so it is not in the previous column.
  await lines(await invoice('sales', 'S-2', '2025-06-10', '5000.00'), [[handbags, '5000.00']]);
  await lines(await invoice('sales', 'S-3', '2025-11-10', '1500.00'), [[handbags, '1500.00']]);
  await lines(await invoice('sales', 'S-4', '2025-12-10', '300.00'), [[wallets, '300.00']]);
  await lines(await invoice('sales_credit_note', 'C-1', '2025-12-20', '50.00'), [[wallets, '50.00']]);
  // A void invoice counts for nothing; neither does one in the month still in progress.
  await lines(await invoice('sales', 'S-5', '2026-01-10', '7777.00', 'void'), [[handbags, '7777.00']]);
  await lines(await invoice('sales', 'S-6', '2026-04-10', '8888.00'), [[handbags, '8888.00']]);
}, 120_000);

afterAll(async () => {
  await dropFixtures(orgs, EMAIL_DOMAIN);
}, 60_000);

describe('loadMarketingFinancials, on the job\'s scoped service client', () => {
  it('adds the engine\'s months into October-start financial years, leaving out the month in progress', async () => {
    const result = await withOrgScope(orgId, (scope) => loadMarketingFinancials(scope.db, orgId));
    expect(result).not.toBeNull();
    expect(result!.currency).toBe('GBP');
    expect(result!.years).toEqual([
      {
        label: '2025', periodStart: '2024-10-01', periodEnd: '2025-09-30', partial: false,
        turnover: '120000.00', costOfSales: '48000.00', costOfSalesPct: '40.0', grossProfit: '72000.00', grossProfitPct: '60.0',
        adminCosts: '36000.00', netProfit: '30000.00', netProfitPct: '25.0',
        // 250 × 12 = 3,000 from the accounts classified as Marketing; the campaign spend is not added.
        marketingSpend: '3000.00', marketingPct: '2.5',
      },
      {
        label: '2026 (6 months)', periodStart: '2025-10-01', periodEnd: '2026-03-31', partial: true,
        turnover: '72000.00', costOfSales: '30000.00', costOfSalesPct: '41.7', grossProfit: '42000.00', grossProfitPct: '58.3',
        adminCosts: '21000.00', netProfit: '18000.00', netProfitPct: '25.0',
        marketingSpend: '2400.00', marketingPct: '3.3',
      },
    ]);
  });

  it('names the latest year\'s four largest expense accounts, leaving out tax', async () => {
    const result = await withOrgScope(orgId, (scope) => loadMarketingFinancials(scope.db, orgId));
    expect(result!.costLines).toEqual([
      { name: 'Freight', amount: '30000.00' },
      { name: 'Wages', amount: '9600.00' },
      { name: 'Rent', amount: '9000.00' },
      { name: 'Advertising', amount: '2400.00' },
    ]);
  });

  it('compares product sales like for like, net of credit notes, ignoring void invoices', async () => {
    const result = await withOrgScope(orgId, (scope) => loadMarketingFinancials(scope.db, orgId));
    expect(result!.productSales).toEqual({
      previousLabel: '2025 (same 6 months)',
      currentLabel: '2026 (6 months)',
      rows: [
        { product: 'Handbags', previous: '1000.00', current: '1500.00', changePct: '50.0' },
        { product: 'Wallets', previous: '200.00', current: '250.00', changePct: '25.0' },
      ],
    });
  });

  it('writes a source note naming the years, the currency and the source', async () => {
    const result = await withOrgScope(orgId, (scope) => loadMarketingFinancials(scope.db, orgId));
    expect(result!.sourceNote).toMatch(/^Financial year ended 30 September 2025, and the six months to 31 March 2026 \(part of the financial year to 30 September 2026\)\. All figures GBP\. Source: the company's own records in APX/);
    expect(result!.sourceNote).toContain('Net profit is after interest and the tax recorded in the accounts.');
    expect(result!.sourceNote).toContain('Advertising and marketing is the spend on accounts classified as Marketing in APX.');
  });

  it('is null for an organisation with no figures', async () => {
    const ownerId = await createAuthUser(`empty-${SUITE}@${EMAIL_DOMAIN}`);
    const empty = await createOrg(ownerId, `${NAME} empty`);
    expect(await withOrgScope(empty, (scope) => loadMarketingFinancials(scope.db, empty))).toBeNull();
  });
});
