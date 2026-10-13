import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withOrgScope } from '@/core/db';
/*
 * A relative import: the Marketing barrel (`@/modules/marketing`) is written alongside this feature,
 * and `motion/no-deep-module-import` (correctly) refuses `@/modules/marketing/services/financials`.
 */
import { loadMarketingFinancials } from '../../src/modules/marketing/services/financials';
import { adminSql, clientFor, createAuthUser } from './setup';

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
 * The snapshots are written exactly as a run writes them (`metric_current` → `metric_snapshots`), in
 * one statement per organisation, as `money-pages.test.ts` does one at a time; the job queue is not
 * drained, so nothing else on a shared local instance is touched. The fixtures are run-unique and only
 * they are removed.
 */

const SUITE = randomUUID().slice(0, 8);
const EMAIL_DOMAIN = 'mktfin.test';
const NAME = `Mktfin ${SUITE}`;

let orgId: string;
let otherOrgId: string;
const period = new Map<string, string>(); // 'YYYY-MM' → period id (orgId)
const account = new Map<string, string>();

const one = (sql: string): string => adminSql(`with q as (${sql}) select * from q`);

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
function writeRun(org: string, periods: ReadonlyMap<string, string>, snaps: readonly Snap[]): void {
  const first = periods.get(snaps[0]!.ym)!;
  const quality = JSON.stringify({ completeness: 1, proxy: false, warnings: [], missing: [] });
  const rows = snaps.map((s) => `('${periods.get(s.ym)}'::uuid, '${s.key}', '${s.dimensionType ?? 'none'}'::metric_dimension_enum, `
    + `${s.dimensionId ? `'${s.dimensionId}'::uuid` : 'null::uuid'}, ${s.dimensionKey ? `'${s.dimensionKey}'` : 'null::text'}, `
    + `${s.value === null ? 'null::numeric' : `${s.value}::numeric`}, '${JSON.stringify(s.components ?? {})}'::jsonb)`).join(',\n');
  adminSql(`
    with run as (
      insert into public.calculation_runs (organization_id, trigger, engine_version, period_from, period_to, as_of, status)
      values ('${org}', 'recalc_manual', '1.0.0', '${first}', '${first}', '2026-10-01', 'succeeded') returning id
    ), v (period_id, metric_key, dimension_type, dimension_id, dimension_key, value, components) as (values ${rows}),
    snaps as (
      insert into public.metric_snapshots (organization_id, calculation_run_id, period_id, metric_key, dimension_type, dimension_id,
                                           dimension_key, value, unit, currency, basis, assurance_level, data_quality, components)
      select '${org}', run.id, v.period_id, v.metric_key, v.dimension_type, v.dimension_id, v.dimension_key, v.value,
             'money', 'GBP', 'ledger', 'verified', '${quality}'::jsonb, v.components
        from run, v
      returning id, period_id, metric_key, dimension_type, dimension_id, dimension_key, calculation_run_id
    )
    insert into public.metric_current (organization_id, period_id, metric_key, dimension_type, dimension_id, dimension_key, snapshot_id, calculation_run_id)
    select '${org}', period_id, metric_key, dimension_type, dimension_id, dimension_key, id, calculation_run_id from snaps`);
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

function cleanup(): void {
  adminSql(`
    select set_config('app.purge', 'on', false);
    delete from public.organizations where name like '${NAME}%';
    delete from public.organizations where name like 'Mktfin %' and created_at < now() - interval '1 hour';
    delete from auth.users where email like '%-${SUITE}@${EMAIL_DOMAIN}';
    delete from auth.users where email like '%@${EMAIL_DOMAIN}' and created_at < now() - interval '1 hour';`);
}

async function createOrg(ownerId: string, name: string): Promise<string> {
  const created = await clientFor(ownerId).schema('api').rpc('create_organization', { p_name: name, p_fiscal_year_start_month: 10 });
  if (created.error) throw new Error(`fixture org failed: ${created.error.message}`);
  const id = created.data as unknown as string;
  adminSql(`select app.ensure_periods('${id}', '2024-10-01', '2026-04-01')`);
  return id;
}

beforeAll(async () => {
  cleanup();
  const ownerId = createAuthUser(`owner-${SUITE}@${EMAIL_DOMAIN}`);
  orgId = await createOrg(ownerId, NAME);
  otherOrgId = await createOrg(ownerId, `${NAME} other`);

  for (const ym of [...COMPLETE, IN_PROGRESS]) {
    period.set(ym, one(`select id from public.fiscal_periods where organization_id = '${orgId}' and period_start = '${ym}-01'`));
  }
  adminSql(`update public.fiscal_periods set is_complete = (period_start < '2026-04-01') where organization_id in ('${orgId}', '${otherOrgId}')`);

  for (const [name, category] of [
    ['Freight', 'cost_of_sales'], ['Rent', 'operating_expense'], ['Advertising', 'marketing'], ['Wages', 'payroll'], ['Corporation tax', 'tax_expense'],
  ] as const) {
    account.set(name, one(`insert into public.accounts (organization_id, name, account_type, standard_category, source, mapping_confidence)
      values ('${orgId}', '${name}', 'expense', '${category}', 'imported', 'confirmed') returning id`));
  }

  // April is in progress: its figures exist and must not be counted.
  writeRun(orgId, period, [...COMPLETE.flatMap(statement), { ym: IN_PROGRESS, key: 'revenue', value: '999999' }]);

  // Another organisation, the same months, figures nobody could mistake.
  const otherPeriods = new Map(COMPLETE.map((ym) => [ym, one(`select id from public.fiscal_periods where organization_id = '${otherOrgId}' and period_start = '${ym}-01'`)]));
  writeRun(otherOrgId, otherPeriods, COMPLETE.flatMap((ym) => (['revenue', 'cost_of_sales', 'operating_expenses', 'net_profit'] as const)
    .map((key) => ({ ym, key, value: '7777777' }))));

  // Campaign spend is recorded too, but the accounts show marketing, so it must not be added.
  const campaign = one(`insert into public.campaigns (organization_id, name) values ('${orgId}', 'Autumn') returning id`);
  adminSql(`insert into public.campaign_spend (organization_id, campaign_id, period_id, amount, currency)
            values ('${orgId}', '${campaign}', '${period.get('2025-11')}', 999.00, 'GBP')`);

  // Products, attributed by invoice lines (ADR-102).
  const customer = one(`insert into public.counterparties (organization_id, name, kind) values ('${orgId}', 'Shopper', 'customer') returning id`);
  const handbags = one(`insert into public.products (organization_id, name) values ('${orgId}', 'Handbags') returning id`);
  const wallets = one(`insert into public.products (organization_id, name) values ('${orgId}', 'Wallets') returning id`);
  const invoice = (type: string, number: string, date: string, total: string, status = 'open') => one(`
    insert into public.invoices (organization_id, invoice_type, counterparty_id, invoice_number, issue_date, due_date, period_id,
                                 subtotal, tax_amount, total_amount, amount_paid, status, record_status, assurance_level)
    values ('${orgId}', '${type}', '${customer}', '${number}', '${date}', '${date}', '00000000-0000-0000-0000-000000000000',
            ${total}, 0, ${total}, 0, '${status}', 'accepted', 'verified') returning id`);
  const line = (invoiceId: string, product: string, amount: string) => adminSql(`
    insert into public.invoice_lines (organization_id, invoice_id, product_id, amount) values ('${orgId}', '${invoiceId}', '${product}', ${amount})`);

  const nov24 = invoice('sales', 'S-1', '2024-11-10', '1200.00');
  line(nov24, handbags, '1000.00');
  line(nov24, wallets, '200.00');
  // June 2025 is outside the like-for-like months (Oct–Mar), so it is not in the previous column.
  line(invoice('sales', 'S-2', '2025-06-10', '5000.00'), handbags, '5000.00');
  line(invoice('sales', 'S-3', '2025-11-10', '1500.00'), handbags, '1500.00');
  line(invoice('sales', 'S-4', '2025-12-10', '300.00'), wallets, '300.00');
  line(invoice('sales_credit_note', 'C-1', '2025-12-20', '50.00'), wallets, '50.00');
  // A void invoice counts for nothing; neither does one in the month still in progress.
  line(invoice('sales', 'S-5', '2026-01-10', '7777.00', 'void'), handbags, '7777.00');
  line(invoice('sales', 'S-6', '2026-04-10', '8888.00'), handbags, '8888.00');
});

afterAll(() => cleanup());

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
    const ownerId = createAuthUser(`empty-${SUITE}@${EMAIL_DOMAIN}`);
    const empty = await createOrg(ownerId, `${NAME} empty`);
    expect(await withOrgScope(empty, (scope) => loadMarketingFinancials(scope.db, empty))).toBeNull();
  });
});
