import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enqueueEngineUpgrade } from '@/core/db';
import { Decimal } from '@/core/money';
import { permissionsFor } from '@/core/permissions';
import { resolveDescriptor } from '@/modules/evidence';
import { loadPeriodScope, loadProfitAndLoss } from '@/modules/dashboard';
import { ENGINE_VERSION } from '@/modules/financial-engine';
import { drainJobs } from '@/modules/jobs';
import type { AccessContext } from '@/modules/tenancy';
import { AS_OF, calculateAndAlert, headline, type Headline } from '../fixtures/adr120-orgs';
import { FU12_KEYS, seedFu12Orgs, type Fu12Key } from '../fixtures/fu12-orgs';
import { adminSql, clientFor, drainUntilFinished } from './setup';

/**
 * ADR-122 FU-12 — an invoice-basis P&L must never state costs 0.00 (and profit = revenue) for a month
 * no full purchase list covers.
 *
 * Seven organisations (test/fixtures/fu12-orgs.ts, seeded from nothing) computed through the real
 * queue at as-of 2026-09-15. On the invoice basis the cost side of a month is stated only when FULL
 * PURCHASE lists establish it under FU-1's rules (ADR-125): spanned by the effective ranges, or — in
 * the current month — reached from the 1st (costs to date, `partial_month`). Otherwise every expense
 * figure and everything derived from one is NULL with `no_source_covers_period`, and the supplier
 * family states nothing; revenue and the customer family are unchanged. A full purchase list that
 * spans a month with no purchase in it still states a genuine 0.00. Then the stale-engine sweep:
 * figures a 4.0.0 engine wrote (July net profit = revenue) are recomputed to NULL.
 */

const TAG = `g${Date.now().toString(36)}`;
const KEYS: readonly Fu12Key[] = FU12_KEYS;
let org: Partial<Record<Fu12Key, string>>;
const o = (k: Fu12Key): string => org[k]!;

const money = (value: string | null | undefined): string | null =>
  value === null || value === undefined ? null : new Decimal(value).toFixed(2);
const ratio = (value: string | null | undefined): string | null =>
  value === null || value === undefined ? null : new Decimal(value).toFixed(6);
const one = (sql: string): string => adminSql(sql).split('\n')[0]!.trim();
const start = (ym: string): string => `${ym}-01`;

const fig = (k: Fu12Key, ym: string, key: string): Headline | undefined => headline(o(k), start(ym), key);

/**
 * Every expense-side figure FU-12 governs, and every figure derived from one (C2). Not revenue and not
 * other_income: no purchase can reach either.
 */
const COST_MONEY_KEYS = [
  'cost_of_sales', 'operating_expenses', 'other_expense', 'interest_expense', 'tax_expense',
  'gross_profit', 'operating_profit', 'net_profit', 'contribution_margin',
] as const;
const COST_RATIO_KEYS = ['gross_margin', 'operating_margin', 'net_margin', 'contribution_margin_ratio'] as const;

/** A stated money figure: its value and its basis (the invoice basis unless given). */
function expectMoney(k: Fu12Key, ym: string, key: string, value: string, basis = 'invoices'): Headline {
  const h = fig(k, ym, key);
  expect(h, `${k} ${ym} ${key} snapshot`).toBeDefined();
  expect(money(h!.value), `${k} ${ym} ${key}`).toBe(value);
  expect(h!.basis, `${k} ${ym} ${key} basis`).toBe(basis);
  return h!;
}

/** A stated ratio, compared at the engine's six decimal places (`toRatioString`). */
function expectRatio(k: Fu12Key, ym: string, key: string, value: string): Headline {
  const h = fig(k, ym, key);
  expect(h, `${k} ${ym} ${key} snapshot`).toBeDefined();
  expect(ratio(h!.value), `${k} ${ym} ${key}`).toBe(value);
  return h!;
}

/** Not stated: a NULL with the honest reason — never 0.00, and never revenue standing in for profit. */
function expectUnstated(k: Fu12Key, ym: string, key: string): void {
  const h = fig(k, ym, key);
  expect(h, `${k} ${ym} ${key} snapshot`).toBeDefined();
  expect(h!.value, `${k} ${ym} ${key} must be NULL, not a manufactured figure`).toBeNull();
  expect(h!.missing, `${k} ${ym} ${key} missing`).toContain('no_source_covers_period');
}

/** Every non-NULL row of a dimensioned metric in a month, as `dimension|value`. */
const statedRows = (k: Fu12Key, ym: string, key: string): string[] => adminSql(`select
      coalesce(c.dimension_key, c.dimension_id::text, '-') || '|' || s.value::text
    from public.metric_current c join public.metric_snapshots s on s.id = c.snapshot_id and s.organization_id = c.organization_id
    join public.fiscal_periods p on p.id = c.period_id and p.organization_id = c.organization_id
   where c.organization_id = '${o(k)}' and p.period_start = '${start(ym)}' and c.metric_key = '${key}'
     and c.dimension_type <> 'none' and s.value is not null
   order by 1`)
  .split('\n').map((l) => l.trim()).filter(Boolean);

/** Per-supplier spend actually attributed to a supplier (the Unattributed row has no dimension id). */
const attributedSupplierSpend = (k: Fu12Key, ym: string): string[] => adminSql(`select s.value::text
    from public.metric_current c join public.metric_snapshots s on s.id = c.snapshot_id and s.organization_id = c.organization_id
    join public.fiscal_periods p on p.id = c.period_id and p.organization_id = c.organization_id
   where c.organization_id = '${o(k)}' and p.period_start = '${start(ym)}' and c.metric_key = 'supplier_spend'
     and c.dimension_id is not null and s.value is not null`)
  .split('\n').map((l) => l.trim()).filter(Boolean).map((v) => money(v)!).sort();

/**
 * One dimensioned row of a metric in a month (e.g. `expense_by_category.variance.prev_period` for
 * `cost_of_sales`), with its value and missing reasons; undefined when no row was written.
 */
function dimensionRow(k: Fu12Key, ym: string, key: string, dimensionKey: string): { value: string | null; missing: string[] } | undefined {
  const raw = one(`select json_build_object('value', s.value::text, 'missing', s.data_quality->'missing')::text
    from public.metric_current c join public.metric_snapshots s on s.id = c.snapshot_id and s.organization_id = c.organization_id
    join public.fiscal_periods p on p.id = c.period_id and p.organization_id = c.organization_id
   where c.organization_id = '${o(k)}' and p.period_start = '${start(ym)}' and c.metric_key = '${key}'
     and c.dimension_type <> 'none' and c.dimension_key = '${dimensionKey}'`);
  if (raw === '') return undefined;
  const parsed = JSON.parse(raw) as { value: string | null; missing: string[] | null };
  return { value: parsed.value, missing: parsed.missing ?? [] };
}

/**
 * The whole cost side of a month no full purchase list covers (C2, C3): every expense and profit
 * figure NULL with `no_source_covers_period`, no expense row stated (absent or NULL, never 0.00), and
 * no supplier figure — neither a spend of 0.00 nor a 100% share of it.
 */
function expectNoCostSide(k: Fu12Key, ym: string): void {
  for (const key of COST_MONEY_KEYS) expectUnstated(k, ym, key);
  for (const key of COST_RATIO_KEYS) expectUnstated(k, ym, key);
  expect(statedRows(k, ym, 'expense_by_category').filter((r) => !r.startsWith('other_income|')), `${k} ${ym} expense_by_category`).toEqual([]);
  expect(statedRows(k, ym, 'expense_by_account'), `${k} ${ym} expense_by_account`).toEqual([]);
  expect(statedRows(k, ym, 'supplier_spend'), `${k} ${ym} supplier_spend`).toEqual([]);
  for (const key of ['supplier_concentration_top1', 'supplier_concentration_top5']) {
    expect(fig(k, ym, key)?.value ?? null, `${k} ${ym} ${key}`).toBeNull();
  }
}

const owner = (id: string): string =>
  one(`select user_id from public.organization_memberships where organization_id = '${id}' and role = 'owner' limit 1`);
const ctxFor = (id: string, userId = owner(id)): AccessContext => ({
  userId, orgId: id, orgSlug: 'x', effectiveRole: 'owner', permissions: permissionsFor('owner'),
  actorType: 'user', db: clientFor(userId), requestId: TAG, now: () => new Date(`${AS_OF}T00:00:00Z`),
  organizationStatus: 'active',
});
const descriptorOf = (k: Fu12Key, ym: string, key: string): unknown => {
  const snapshot = fig(k, ym, key)!;
  return (JSON.parse(one(`select evidence_query::text from public.metric_snapshots where id = '${snapshot.snapshotId}'`)) as { descriptor: unknown }).descriptor;
};
const latestVersion = (id: string): string => one(`select engine_version from public.calculation_runs
  where organization_id = '${id}' and status = 'succeeded' order by finished_at desc nulls last limit 1`);

beforeAll(async () => {
  org = await seedFu12Orgs(TAG, KEYS);
  for (const k of KEYS) await calculateAndAlert(o(k));
}, 900_000);

afterAll(() => {
  if (!org) return;
  adminSql(`delete from public.organizations where id in (${Object.values(org).map((id) => `'${id}'`).join(',')});
            delete from auth.users where email like '%@${TAG}.%';`);
});

describe('a sales list alone states revenue — and nothing about costs or profit (SALESONLY)', () => {
  it('June, July and August: revenue 2,000 on the invoice basis, unchanged by FU-12', () => {
    for (const ym of ['2026-06', '2026-07', '2026-08']) {
      const revenue = expectMoney('SALESONLY', ym, 'revenue', '2000.00');
      expect(revenue.missing, `SALESONLY ${ym} revenue missing`).toEqual([]);
    }
  });

  it('every cost, profit and margin is NULL with no_source_covers_period — gross profit is NOT 2,000', () => {
    // 4.0.0 stated gross = operating = net profit 2,000.00 and a 100% net margin for these months.
    for (const ym of ['2026-06', '2026-07', '2026-08']) {
      expectNoCostSide('SALESONLY', ym);
      // Uncovered costs take precedence over the "no cost-of-sales account" path (C2): gross profit
      // does not fall back to revenue, whatever the chart of accounts says.
      expect(money(fig('SALESONLY', ym, 'gross_profit')?.value), `SALESONLY ${ym} gross_profit`).not.toBe('2000.00');
    }
  });

  it('the customer family and receivables are unchanged (C3, C4)', () => {
    expect(ratio(fig('SALESONLY', '2026-07', 'customer_concentration_top1')?.value)).toBe('1.000000');
    // Three unpaid 2,000 sales by 31 August: AR comes from the sales list's own coverage, not FU-12's.
    expect(money(fig('SALESONLY', '2026-08', 'receivables')?.value)).toBe('6000.00');
  });
});

describe('a sales list and a purchase list covering the month state the whole P&L (BOTH)', () => {
  it('June, July and August: revenue 2,000 · cost of sales 800 · gross 1,200 · opex 300 · operating 900 · net 900', () => {
    for (const ym of ['2026-06', '2026-07', '2026-08']) {
      expectMoney('BOTH', ym, 'revenue', '2000.00');
      const cos = expectMoney('BOTH', ym, 'cost_of_sales', '800.00');
      expect(cos.missing, `BOTH ${ym} cost_of_sales missing`).toEqual([]);
      expectMoney('BOTH', ym, 'gross_profit', '1200.00');
      expectMoney('BOTH', ym, 'operating_expenses', '300.00');
      expectMoney('BOTH', ym, 'operating_profit', '900.00');
      expectMoney('BOTH', ym, 'other_expense', '0.00');
      expectMoney('BOTH', ym, 'interest_expense', '0.00');
      expectMoney('BOTH', ym, 'tax_expense', '0.00');
      const net = expectMoney('BOTH', ym, 'net_profit', '900.00');
      expect(net.missing, `BOTH ${ym} net_profit missing`).toEqual([]);
      expectRatio('BOTH', ym, 'gross_margin', '0.600000');
      expectRatio('BOTH', ym, 'operating_margin', '0.450000');
      expectRatio('BOTH', ym, 'net_margin', '0.450000');
      expectMoney('BOTH', ym, 'contribution_margin', '1200.00');
      expectRatio('BOTH', ym, 'contribution_margin_ratio', '0.600000');
    }
  });

  it('the expense breakdown and the supplier family are stated: 800 + 300, top supplier 800 / 1,100', () => {
    for (const ym of ['2026-06', '2026-07', '2026-08']) {
      expect(statedRows('BOTH', ym, 'expense_by_category').map((r) => {
        const [category, value] = r.split('|');
        return `${category}|${money(value)}`;
      }), `BOTH ${ym} expense_by_category`).toEqual(['cost_of_sales|800.00', 'operating_expense|300.00']);
      expect(attributedSupplierSpend('BOTH', ym), `BOTH ${ym} supplier_spend`).toEqual(['300.00', '800.00']);
      expect(ratio(fig('BOTH', ym, 'supplier_concentration_top1')?.value), `BOTH ${ym} top supplier`)
        .toBe(new Decimal(800).dividedBy(1100).toFixed(6));
    }
  });

  it('payables and the payables-days base are unchanged (C4, C5)', () => {
    // Every purchase is unpaid: 3 × (800 + 300) owed at 31 August.
    expect(money(fig('BOTH', '2026-08', 'payables')?.value)).toBe('3300.00');
    // June – August all carry a stated cost base, so the days figure is computed from it.
    expect(fig('BOTH', '2026-08', 'payables_days')?.value ?? null, 'BOTH Aug payables_days').not.toBeNull();
  });
});

describe('a purchase list that stops short states only the months it establishes (PURCHSHORT)', () => {
  it('June, which the list spans: cost of sales 800, gross 1,200, net 1,200', () => {
    expectMoney('PURCHSHORT', '2026-06', 'revenue', '2000.00');
    expectMoney('PURCHSHORT', '2026-06', 'cost_of_sales', '800.00');
    expectMoney('PURCHSHORT', '2026-06', 'gross_profit', '1200.00');
    expectMoney('PURCHSHORT', '2026-06', 'operating_expenses', '0.00');
    expectMoney('PURCHSHORT', '2026-06', 'operating_profit', '1200.00');
    expectMoney('PURCHSHORT', '2026-06', 'net_profit', '1200.00');
    expectRatio('PURCHSHORT', '2026-06', 'net_margin', '0.600000');
  });

  it('July (seen to the 20th) and August (not at all): every cost and profit NULL — not 800, not 0.00', () => {
    for (const ym of ['2026-07', '2026-08']) {
      expectMoney('PURCHSHORT', ym, 'revenue', '2000.00');
      expectNoCostSide('PURCHSHORT', ym);
    }
  });

  it('the payables-days figure is not computed on an unknown cost base (C5)', () => {
    expect(fig('PURCHSHORT', '2026-08', 'payables_days')?.value ?? null).toBeNull();
  });

  it('FU-12 review (F1): the cost-of-sales category variance into and out of uncovered months is unknown, never −800', () => {
    // June states cost of sales 800; July and August write no expense category (costs uncovered).
    // Read as a known zero, July's prev_period would be −800.00 (−100%): a cost "falling to nothing"
    // that nothing stated. July → August compares two unknowns.
    for (const ym of ['2026-07', '2026-08']) {
      const row = dimensionRow('PURCHSHORT', ym, 'expense_by_category.variance.prev_period', 'cost_of_sales');
      if (row !== undefined) {
        expect(row.value, `PURCHSHORT ${ym} cost_of_sales prev_period`).toBeNull();
        expect(row.missing, `PURCHSHORT ${ym} cost_of_sales prev_period missing`).toContain('no_source_covers_period');
      }
      expect(money(row?.value), `PURCHSHORT ${ym} cost_of_sales prev_period`).not.toBe('-800.00');
    }
    // July's row must exist: June has a cost_of_sales row, so the dimension is in "either" period.
    expect(dimensionRow('PURCHSHORT', '2026-07', 'expense_by_category.variance.prev_period', 'cost_of_sales')).toBeDefined();
    // August's trailing average has June's 800 in its window (June, July, May): read as known zeros it
    // would be a stated average; with July unknown it is NULL. This row must exist too.
    const trailing = dimensionRow('PURCHSHORT', '2026-08', 'expense_by_category.variance.trailing_3m_avg', 'cost_of_sales');
    expect(trailing, 'PURCHSHORT 2026-08 cost_of_sales trailing_3m_avg').toBeDefined();
    expect(trailing!.value).toBeNull();
    expect(trailing!.missing).toContain('no_source_covers_period');
  });
});

describe('a covering purchase list with no purchase in the month states a genuine zero (ZEROCOST)', () => {
  it('July: cost of sales 0.00 stated with nothing missing, so profit = revenue legitimately', () => {
    expectMoney('ZEROCOST', '2026-07', 'revenue', '2000.00');
    const cos = expectMoney('ZEROCOST', '2026-07', 'cost_of_sales', '0.00');
    expect(cos.missing).toEqual([]);
    expect(cos.warnings).not.toContain('no_cost_of_sales');
    expectMoney('ZEROCOST', '2026-07', 'operating_expenses', '0.00');
    const gross = expectMoney('ZEROCOST', '2026-07', 'gross_profit', '2000.00');
    expect(gross.missing).toEqual([]);
    expectMoney('ZEROCOST', '2026-07', 'operating_profit', '2000.00');
    expectMoney('ZEROCOST', '2026-07', 'net_profit', '2000.00');
    expectRatio('ZEROCOST', '2026-07', 'gross_margin', '1.000000');
    expectRatio('ZEROCOST', '2026-07', 'net_margin', '1.000000');
  });

  it('June and August carry their 800', () => {
    for (const ym of ['2026-06', '2026-08']) {
      expectMoney('ZEROCOST', ym, 'cost_of_sales', '800.00');
      expectMoney('ZEROCOST', ym, 'gross_profit', '1200.00');
      expectMoney('ZEROCOST', ym, 'net_profit', '1200.00');
    }
  });
});

describe('the current month: lists reaching into it state costs TO DATE (CURRENTCOST)', () => {
  it('August is whole: revenue 1,500, cost of sales 600, gross 900, no partial_month', () => {
    expectMoney('CURRENTCOST', '2026-08', 'revenue', '1500.00');
    const cos = expectMoney('CURRENTCOST', '2026-08', 'cost_of_sales', '600.00');
    expect(cos.warnings).not.toContain('partial_month');
    expectMoney('CURRENTCOST', '2026-08', 'gross_profit', '900.00');
    expectMoney('CURRENTCOST', '2026-08', 'net_profit', '900.00');
  });

  it('September to date: revenue 700, cost of sales 200, gross 500 — every one flagged partial_month', () => {
    // FU-12 review (F2): current-month costs are stated only when the purchase lists reach exactly as
    // far as the sales lists. Here both are declared to 10 September and committed that day — equal
    // reach — so nothing changes: costs to date, flagged partial_month.
    const revenue = expectMoney('CURRENTCOST', '2026-09', 'revenue', '700.00');
    expect(revenue.warnings).toContain('partial_month');
    const cos = expectMoney('CURRENTCOST', '2026-09', 'cost_of_sales', '200.00');
    expect(cos.warnings).toContain('partial_month');
    expect(cos.missing).not.toContain('no_source_covers_period');
    const gross = expectMoney('CURRENTCOST', '2026-09', 'gross_profit', '500.00');
    expect(gross.warnings).toContain('partial_month');
    const opex = expectMoney('CURRENTCOST', '2026-09', 'operating_expenses', '0.00');
    expect(opex.warnings).toContain('partial_month');
    const net = expectMoney('CURRENTCOST', '2026-09', 'net_profit', '500.00');
    expect(net.warnings).toContain('partial_month');
  });

  it('October, which neither list reaches, states no revenue and no cost', () => {
    expect(fig('CURRENTCOST', '2026-10', 'revenue')?.value ?? null).toBeNull();
    for (const key of [...COST_MONEY_KEYS, ...COST_RATIO_KEYS]) {
      expect(fig('CURRENTCOST', '2026-10', key)?.value ?? null, `CURRENTCOST Oct ${key}`).toBeNull();
    }
  });
});

describe('the supplier family follows purchase coverage (SUPPLIERS, C3)', () => {
  it('June and July: Anchor holds 75% of supplier spend, and the spend reconciles to the costs', () => {
    expectMoney('SUPPLIERS', '2026-06', 'cost_of_sales', '600.00');
    expectMoney('SUPPLIERS', '2026-06', 'operating_expenses', '200.00');
    expect(attributedSupplierSpend('SUPPLIERS', '2026-06')).toEqual(['200.00', '600.00']);
    expectRatio('SUPPLIERS', '2026-06', 'supplier_concentration_top1', '0.750000');
    expectMoney('SUPPLIERS', '2026-07', 'cost_of_sales', '300.00');
    expectMoney('SUPPLIERS', '2026-07', 'operating_expenses', '100.00');
    expect(attributedSupplierSpend('SUPPLIERS', '2026-07')).toEqual(['100.00', '300.00']);
    expectRatio('SUPPLIERS', '2026-07', 'supplier_concentration_top1', '0.750000');
  });

  it('August, which only an aged-creditors list touches: no supplier figure and no cost — never 1.0 of a share', () => {
    expectMoney('SUPPLIERS', '2026-08', 'revenue', '2000.00');
    expectNoCostSide('SUPPLIERS', '2026-08');
    // The payables-days base for August is unknown, so the days figure is too (C5).
    expect(fig('SUPPLIERS', '2026-08', 'payables_days')?.value ?? null).toBeNull();
  });

  it('the customer family is unchanged in August: one customer, 100% of a revenue the sales list states', () => {
    expect(ratio(fig('SUPPLIERS', '2026-08', 'customer_concentration_top1')?.value)).toBe('1.000000');
  });
});

describe('evidence and tenancy', () => {
  it('every leaf descriptor of revenue, cost and expense figures in these organisations totals to its figure', async () => {
    let checked = 0;
    for (const k of KEYS) {
      const rows = adminSql(`select p.period_start || '|' || c.metric_key || '|' || coalesce(c.dimension_key, c.dimension_id::text, '-')
          || '|' || s.value::text || '|' || s.evidence_query::text
        from public.metric_current c join public.metric_snapshots s on s.id = c.snapshot_id and s.organization_id = c.organization_id
        join public.fiscal_periods p on p.id = c.period_id and p.organization_id = c.organization_id
       where c.organization_id = '${o(k)}' and s.value is not null and s.evidence_query->>'kind' = 'leaf'
         and c.metric_key in ('revenue', 'customer_revenue', 'cost_of_sales', 'operating_expenses', 'other_expense',
           'interest_expense', 'tax_expense', 'expense_by_category', 'expense_by_account', 'supplier_spend')`)
        .split('\n').map((l) => l.trim()).filter(Boolean);
      for (const row of rows) {
        const [period, metric, dimension, value, ...rest] = row.split('|');
        const selection = await resolveDescriptor(ctxFor(o(k)), (JSON.parse(rest.join('|')) as { descriptor: unknown }).descriptor);
        expect(money(selection.total), `${k} ${period} ${metric} ${dimension}`).toBe(money(value));
        checked += 1;
      }
    }
    // Revenue and customer revenue in every stated month, plus the cost, category and supplier rows
    // of BOTH, PURCHSHORT (June), ZEROCOST, CURRENTCOST and SUPPLIERS — about ninety in all.
    expect(checked).toBeGreaterThan(60);
  });

  it('another organisation\'s owner resolves nothing from BOTH\'s July cost of sales', async () => {
    const mine = owner(o('BOTH'));
    const intruder = KEYS.map((k) => owner(o(k))).find((u) => u !== mine)!;
    const descriptor = descriptorOf('BOTH', '2026-07', 'cost_of_sales');
    expect(money((await resolveDescriptor(ctxFor(o('BOTH')), descriptor)).total)).toBe('800.00');
    const selection = await resolveDescriptor({ ...ctxFor(o('BOTH')), userId: intruder, db: clientFor(intruder) }, descriptor);
    expect(selection.count).toBe(0);
  });
});

describe('engine version and the stale-figure sweep', () => {
  it('every organisation\'s runs ran on the current engine', () => {
    for (const k of KEYS) expect(latestVersion(o(k)), k).toBe(ENGINE_VERSION);
    expect(one(`select count(*) from public.calculation_runs where organization_id in (${KEYS.map((k) => `'${o(k)}'`).join(',')})
      and status = 'succeeded' and engine_version <> '${ENGINE_VERSION}'`)).toBe('0');
  });

  it('STALE: a July net profit = revenue an older engine wrote is queued by the sweep and recomputed to NULL', async () => {
    // FU-12 changes existing values, so FINANCIAL_ENGINE.md §6 requires a MAJOR bump past 4.0.0 — the
    // bump is what makes the sweep re-queue every organisation. Pinned here, not only in the golden
    // file, which re-records itself.
    expect(Number(ENGINE_VERSION.split('.')[0])).toBeGreaterThanOrEqual(5);
    const id = o('STALE');
    expectUnstated('STALE', '2026-07', 'net_profit');
    adminSql(`update public.calculation_runs set engine_version = '4.0.0' where organization_id = '${id}';
      -- Fixture only: snapshots are append-only (a trigger), so the stale figure is planted with the
      -- triggers off for this one session — the state a 4.0.0 run left (July net profit 2,000.00 =
      -- revenue), not an app write.
      set session_replication_role = replica;
      update public.metric_snapshots s set value = 2000 from public.metric_current c join public.fiscal_periods p on p.id = c.period_id
       where c.organization_id = '${id}' and c.metric_key = 'net_profit' and c.dimension_type = 'none'
         and p.period_start = '2026-07-01' and s.id = c.snapshot_id;
      set session_replication_role = origin;
      delete from public.jobs where organization_id = '${id}' and status = 'queued';`);
    expect(money(fig('STALE', '2026-07', 'net_profit')?.value)).toBe('2000.00');

    expect(await enqueueEngineUpgrade(ENGINE_VERSION)).toBeGreaterThanOrEqual(1);
    const job = one(`select id from public.jobs where organization_id = '${id}' and job_type = 'calculation.run' and status = 'queued'`);
    expect(job).not.toBe('');
    expect(await drainUntilFinished(drainJobs, job)).toBe('succeeded');
    expect(latestVersion(id)).toBe(ENGINE_VERSION);
    expectUnstated('STALE', '2026-07', 'net_profit');
    expectNoCostSide('STALE', '2026-07');
    expectMoney('STALE', '2026-07', 'revenue', '2000.00');
  });
});

describe('the Profit & loss page says a month\'s spending is unknown, not nothing (FU-12 review)', () => {
  const julyPnl = async (k: Fu12Key) => {
    const userId = owner(o(k));
    const periodId = one(`select id from public.fiscal_periods
      where organization_id = '${o(k)}' and period_start = '2026-07-01'`);
    const scope = await loadPeriodScope(clientFor(userId), o(k), periodId, `itest-${TAG}`);
    expect(scope, `${k} July scope`).not.toBeNull();
    return loadProfitAndLoss(clientFor(userId), o(k), 'x', scope!, `itest-${TAG}`);
  };

  it('SALESONLY July: no spending breakdown, spending not known, gross profit "—"', async () => {
    const pnl = await julyPnl('SALESONLY');
    expect(pnl.spending).toHaveLength(0);
    expect(pnl.spendingKnown).toBe(false);
    const gross = pnl.above.find((f) => f.metricKey === 'gross_profit')!;
    expect(gross.rawValue).toBeNull();
    expect(gross.value).toBe('—');
  });

  it('BOTH July: the breakdown is stated and spending is known', async () => {
    const pnl = await julyPnl('BOTH');
    expect(pnl.spendingKnown).toBe(true);
    expect(pnl.spending.map((r) => r.key).sort()).toEqual(['cost_of_sales', 'operating_expense']);
    expect(money(pnl.above.find((f) => f.metricKey === 'gross_profit')!.rawValue)).toBe('1200.00');
  });
});
