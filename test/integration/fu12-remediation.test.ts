import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enqueueEngineUpgrade } from '@/core/db';
import { Decimal } from '@/core/money';
import { permissionsFor } from '@/core/permissions';
import { resolveDescriptor } from '@/modules/evidence';
import { loadPeriodScope, loadProfitAndLoss } from '@/modules/dashboard';
import { ENGINE_VERSION } from '@/modules/financial-engine';
import type { AccessContext } from '@/modules/tenancy';
import { AS_OF, calculateAndAlert, headline, untilFinished, type Headline } from '../fixtures/adr120-orgs';
import { FU12_KEYS, seedFu12Orgs, type Fu12Key } from '../fixtures/fu12-orgs';
import {
  currentFigure, currentFigures, latestVersion, ownerOf, plantStale, queuedCalculation, runsOf,
} from '../fixtures/engine-reads';
import { removeSeeded } from '../fixtures/seed';
import { periodId } from '@/db/app/shared';
import { clientFor } from './setup';

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
const start = (ym: string): string => `${ym}-01`;

const fig = (k: Fu12Key, ym: string, key: string): Promise<Headline | undefined> => headline(o(k), start(ym), key);

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
async function expectMoney(k: Fu12Key, ym: string, key: string, value: string, basis = 'invoices'): Promise<Headline> {
  const h = await fig(k, ym, key);
  expect(h, `${k} ${ym} ${key} snapshot`).toBeDefined();
  expect(money(h!.value), `${k} ${ym} ${key}`).toBe(value);
  expect(h!.basis, `${k} ${ym} ${key} basis`).toBe(basis);
  return h!;
}

/** A stated ratio, compared at the engine's six decimal places (`toRatioString`). */
async function expectRatio(k: Fu12Key, ym: string, key: string, value: string): Promise<Headline> {
  const h = await fig(k, ym, key);
  expect(h, `${k} ${ym} ${key} snapshot`).toBeDefined();
  expect(ratio(h!.value), `${k} ${ym} ${key}`).toBe(value);
  return h!;
}

/** Not stated: a NULL with the honest reason — never 0.00, and never revenue standing in for profit. */
async function expectUnstated(k: Fu12Key, ym: string, key: string): Promise<void> {
  const h = await fig(k, ym, key);
  expect(h, `${k} ${ym} ${key} snapshot`).toBeDefined();
  expect(h!.value, `${k} ${ym} ${key} must be NULL, not a manufactured figure`).toBeNull();
  expect(h!.missing, `${k} ${ym} ${key} missing`).toContain('no_source_covers_period');
}

/** Every non-NULL row of a dimensioned metric in a month, as `dimension|value`. */
const statedRows = async (k: Fu12Key, ym: string, key: string): Promise<string[]> =>
  (await currentFigures(o(k), { start: start(ym), keys: [key], dimension: 'dimensioned' }))
    .filter((f) => f.value !== null)
    .map((f) => `${f.dimensionKey ?? f.dimensionId ?? '-'}|${f.value}`)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

/** Per-supplier spend actually attributed to a supplier (the Unattributed row has no dimension id). */
const attributedSupplierSpend = async (k: Fu12Key, ym: string): Promise<string[]> =>
  (await currentFigures(o(k), { start: start(ym), keys: ['supplier_spend'], dimension: 'any' }))
    .filter((f) => f.dimensionId !== null && f.value !== null)
    .map((f) => money(f.value)!).sort();

/**
 * One dimensioned row of a metric in a month (e.g. `expense_by_category.variance.prev_period` for
 * `cost_of_sales`), with its value and missing reasons; undefined when no row was written.
 */
async function dimensionRow(k: Fu12Key, ym: string, key: string, dimensionKey: string): Promise<{ value: string | null; missing: string[] } | undefined> {
  const row = (await currentFigures(o(k), { start: start(ym), keys: [key], dimension: 'dimensioned' }))
    .find((f) => f.dimensionKey === dimensionKey);
  if (row === undefined) return undefined;
  return { value: row.value, missing: (row.dataQuality.missing as string[] | null | undefined) ?? [] };
}

/**
 * The whole cost side of a month no full purchase list covers (C2, C3): every expense and profit
 * figure NULL with `no_source_covers_period`, no expense row stated (absent or NULL, never 0.00), and
 * no supplier figure — neither a spend of 0.00 nor a 100% share of it.
 */
async function expectNoCostSide(k: Fu12Key, ym: string): Promise<void> {
  for (const key of COST_MONEY_KEYS) (await expectUnstated(k, ym, key));
  for (const key of COST_RATIO_KEYS) (await expectUnstated(k, ym, key));
  expect((await statedRows(k, ym, 'expense_by_category')).filter((r) => !r.startsWith('other_income|')), `${k} ${ym} expense_by_category`).toEqual([]);
  expect(await statedRows(k, ym, 'expense_by_account'), `${k} ${ym} expense_by_account`).toEqual([]);
  expect(await statedRows(k, ym, 'supplier_spend'), `${k} ${ym} supplier_spend`).toEqual([]);
  for (const key of ['supplier_concentration_top1', 'supplier_concentration_top5']) {
    expect((await fig(k, ym, key))?.value ?? null, `${k} ${ym} ${key}`).toBeNull();
  }
}

const owners = new Map<string, string>();
const owner = (id: string): string => owners.get(id)!;
const ctxFor = (id: string, userId = owner(id)): AccessContext => ({
  userId, orgId: id, orgSlug: 'x', effectiveRole: 'owner', permissions: permissionsFor('owner'),
  actorType: 'user', db: clientFor(userId), requestId: TAG, now: () => new Date(`${AS_OF}T00:00:00Z`),
  organizationStatus: 'active',
});
const descriptorOf = async (k: Fu12Key, ym: string, key: string): Promise<unknown> =>
  ((await currentFigure(o(k), start(ym), key))!.evidenceQuery as { descriptor: unknown }).descriptor;

beforeAll(async () => {
  org = await seedFu12Orgs(TAG, KEYS);
  for (const k of KEYS) owners.set(o(k), await ownerOf(o(k)));
  for (const k of KEYS) await calculateAndAlert(o(k));
}, 2_400_000);

afterAll(async () => {
  if (!org) return;
  await removeSeeded(Object.values(org), `@${TAG}.`);
}, 600_000);

describe('a sales list alone states revenue — and nothing about costs or profit (SALESONLY)', () => {
  it('June, July and August: revenue 2,000 on the invoice basis, unchanged by FU-12', async () => {
    for (const ym of ['2026-06', '2026-07', '2026-08']) {
      const revenue = await expectMoney('SALESONLY', ym, 'revenue', '2000.00');
      expect(revenue.missing, `SALESONLY ${ym} revenue missing`).toEqual([]);
    }
  });

  it('every cost, profit and margin is NULL with no_source_covers_period — gross profit is NOT 2,000', async () => {
    // 4.0.0 stated gross = operating = net profit 2,000.00 and a 100% net margin for these months.
    for (const ym of ['2026-06', '2026-07', '2026-08']) {
      await expectNoCostSide('SALESONLY', ym);
      // Uncovered costs take precedence over the "no cost-of-sales account" path (C2): gross profit
      // does not fall back to revenue, whatever the chart of accounts says.
      expect(money((await fig('SALESONLY', ym, 'gross_profit'))?.value), `SALESONLY ${ym} gross_profit`).not.toBe('2000.00');
    }
  });

  it('the customer family and receivables are unchanged (C3, C4)', async () => {
    expect(ratio((await fig('SALESONLY', '2026-07', 'customer_concentration_top1'))?.value)).toBe('1.000000');
    // Three unpaid 2,000 sales by 31 August: AR comes from the sales list's own coverage, not FU-12's.
    expect(money((await fig('SALESONLY', '2026-08', 'receivables'))?.value)).toBe('6000.00');
  });
});

describe('a sales list and a purchase list covering the month state the whole P&L (BOTH)', () => {
  it('June, July and August: revenue 2,000 · cost of sales 800 · gross 1,200 · opex 300 · operating 900 · net 900', async () => {
    for (const ym of ['2026-06', '2026-07', '2026-08']) {
      await expectMoney('BOTH', ym, 'revenue', '2000.00');
      const cos = await expectMoney('BOTH', ym, 'cost_of_sales', '800.00');
      expect(cos.missing, `BOTH ${ym} cost_of_sales missing`).toEqual([]);
      await expectMoney('BOTH', ym, 'gross_profit', '1200.00');
      await expectMoney('BOTH', ym, 'operating_expenses', '300.00');
      await expectMoney('BOTH', ym, 'operating_profit', '900.00');
      await expectMoney('BOTH', ym, 'other_expense', '0.00');
      await expectMoney('BOTH', ym, 'interest_expense', '0.00');
      await expectMoney('BOTH', ym, 'tax_expense', '0.00');
      const net = await expectMoney('BOTH', ym, 'net_profit', '900.00');
      expect(net.missing, `BOTH ${ym} net_profit missing`).toEqual([]);
      await expectRatio('BOTH', ym, 'gross_margin', '0.600000');
      await expectRatio('BOTH', ym, 'operating_margin', '0.450000');
      await expectRatio('BOTH', ym, 'net_margin', '0.450000');
      await expectMoney('BOTH', ym, 'contribution_margin', '1200.00');
      await expectRatio('BOTH', ym, 'contribution_margin_ratio', '0.600000');
    }
  });

  it('the expense breakdown and the supplier family are stated: 800 + 300, top supplier 800 / 1,100', async () => {
    for (const ym of ['2026-06', '2026-07', '2026-08']) {
      expect((await statedRows('BOTH', ym, 'expense_by_category')).map((r) => {
        const [category, value] = r.split('|');
        return `${category}|${money(value)}`;
      }), `BOTH ${ym} expense_by_category`).toEqual(['cost_of_sales|800.00', 'operating_expense|300.00']);
      expect(await attributedSupplierSpend('BOTH', ym), `BOTH ${ym} supplier_spend`).toEqual(['300.00', '800.00']);
      expect(ratio((await fig('BOTH', ym, 'supplier_concentration_top1'))?.value), `BOTH ${ym} top supplier`)
        .toBe(new Decimal(800).dividedBy(1100).toFixed(6));
    }
  });

  it('payables and the payables-days base are unchanged (C4, C5)', async () => {
    // Every purchase is unpaid: 3 × (800 + 300) owed at 31 August.
    expect(money((await fig('BOTH', '2026-08', 'payables'))?.value)).toBe('3300.00');
    // June – August all carry a stated cost base, so the days figure is computed from it.
    expect((await fig('BOTH', '2026-08', 'payables_days'))?.value ?? null, 'BOTH Aug payables_days').not.toBeNull();
  });
});

describe('a purchase list that stops short states only the months it establishes (PURCHSHORT)', () => {
  it('June, which the list spans: cost of sales 800, gross 1,200, net 1,200', async () => {
    await expectMoney('PURCHSHORT', '2026-06', 'revenue', '2000.00');
    await expectMoney('PURCHSHORT', '2026-06', 'cost_of_sales', '800.00');
    await expectMoney('PURCHSHORT', '2026-06', 'gross_profit', '1200.00');
    await expectMoney('PURCHSHORT', '2026-06', 'operating_expenses', '0.00');
    await expectMoney('PURCHSHORT', '2026-06', 'operating_profit', '1200.00');
    await expectMoney('PURCHSHORT', '2026-06', 'net_profit', '1200.00');
    await expectRatio('PURCHSHORT', '2026-06', 'net_margin', '0.600000');
  });

  it('July (seen to the 20th) and August (not at all): every cost and profit NULL — not 800, not 0.00', async () => {
    for (const ym of ['2026-07', '2026-08']) {
      await expectMoney('PURCHSHORT', ym, 'revenue', '2000.00');
      await expectNoCostSide('PURCHSHORT', ym);
    }
  });

  it('the payables-days figure is not computed on an unknown cost base (C5)', async () => {
    expect((await fig('PURCHSHORT', '2026-08', 'payables_days'))?.value ?? null).toBeNull();
  });

  it('FU-12 review (F1): the cost-of-sales category variance into and out of uncovered months is unknown, never −800', async () => {
    // June states cost of sales 800; July and August write no expense category (costs uncovered).
    // Read as a known zero, July's prev_period would be −800.00 (−100%): a cost "falling to nothing"
    // that nothing stated. July → August compares two unknowns.
    for (const ym of ['2026-07', '2026-08']) {
      const row = await dimensionRow('PURCHSHORT', ym, 'expense_by_category.variance.prev_period', 'cost_of_sales');
      if (row !== undefined) {
        expect(row.value, `PURCHSHORT ${ym} cost_of_sales prev_period`).toBeNull();
        expect(row.missing, `PURCHSHORT ${ym} cost_of_sales prev_period missing`).toContain('no_source_covers_period');
      }
      expect(money(row?.value), `PURCHSHORT ${ym} cost_of_sales prev_period`).not.toBe('-800.00');
    }
    // July's row must exist: June has a cost_of_sales row, so the dimension is in "either" period.
    expect(await dimensionRow('PURCHSHORT', '2026-07', 'expense_by_category.variance.prev_period', 'cost_of_sales')).toBeDefined();
    // August's trailing average has June's 800 in its window (June, July, May): read as known zeros it
    // would be a stated average; with July unknown it is NULL. This row must exist too.
    const trailing = await dimensionRow('PURCHSHORT', '2026-08', 'expense_by_category.variance.trailing_3m_avg', 'cost_of_sales');
    expect(trailing, 'PURCHSHORT 2026-08 cost_of_sales trailing_3m_avg').toBeDefined();
    expect(trailing!.value).toBeNull();
    expect(trailing!.missing).toContain('no_source_covers_period');
  });
});

describe('a covering purchase list with no purchase in the month states a genuine zero (ZEROCOST)', () => {
  it('July: cost of sales 0.00 stated with nothing missing, so profit = revenue legitimately', async () => {
    await expectMoney('ZEROCOST', '2026-07', 'revenue', '2000.00');
    const cos = await expectMoney('ZEROCOST', '2026-07', 'cost_of_sales', '0.00');
    expect(cos.missing).toEqual([]);
    expect(cos.warnings).not.toContain('no_cost_of_sales');
    await expectMoney('ZEROCOST', '2026-07', 'operating_expenses', '0.00');
    const gross = await expectMoney('ZEROCOST', '2026-07', 'gross_profit', '2000.00');
    expect(gross.missing).toEqual([]);
    await expectMoney('ZEROCOST', '2026-07', 'operating_profit', '2000.00');
    await expectMoney('ZEROCOST', '2026-07', 'net_profit', '2000.00');
    await expectRatio('ZEROCOST', '2026-07', 'gross_margin', '1.000000');
    await expectRatio('ZEROCOST', '2026-07', 'net_margin', '1.000000');
  });

  it('June and August carry their 800', async () => {
    for (const ym of ['2026-06', '2026-08']) {
      await expectMoney('ZEROCOST', ym, 'cost_of_sales', '800.00');
      await expectMoney('ZEROCOST', ym, 'gross_profit', '1200.00');
      await expectMoney('ZEROCOST', ym, 'net_profit', '1200.00');
    }
  });
});

describe('the current month: lists reaching into it state costs TO DATE (CURRENTCOST)', () => {
  it('August is whole: revenue 1,500, cost of sales 600, gross 900, no partial_month', async () => {
    await expectMoney('CURRENTCOST', '2026-08', 'revenue', '1500.00');
    const cos = await expectMoney('CURRENTCOST', '2026-08', 'cost_of_sales', '600.00');
    expect(cos.warnings).not.toContain('partial_month');
    await expectMoney('CURRENTCOST', '2026-08', 'gross_profit', '900.00');
    await expectMoney('CURRENTCOST', '2026-08', 'net_profit', '900.00');
  });

  it('September to date: revenue 700, cost of sales 200, gross 500 — every one flagged partial_month', async () => {
    // FU-12 review (F2): current-month costs are stated only when the purchase lists reach exactly as
    // far as the sales lists. Here both are declared to 10 September and committed that day — equal
    // reach — so nothing changes: costs to date, flagged partial_month.
    const revenue = await expectMoney('CURRENTCOST', '2026-09', 'revenue', '700.00');
    expect(revenue.warnings).toContain('partial_month');
    const cos = await expectMoney('CURRENTCOST', '2026-09', 'cost_of_sales', '200.00');
    expect(cos.warnings).toContain('partial_month');
    expect(cos.missing).not.toContain('no_source_covers_period');
    const gross = await expectMoney('CURRENTCOST', '2026-09', 'gross_profit', '500.00');
    expect(gross.warnings).toContain('partial_month');
    const opex = await expectMoney('CURRENTCOST', '2026-09', 'operating_expenses', '0.00');
    expect(opex.warnings).toContain('partial_month');
    const net = await expectMoney('CURRENTCOST', '2026-09', 'net_profit', '500.00');
    expect(net.warnings).toContain('partial_month');
  });

  it('October, which neither list reaches, states no revenue and no cost', async () => {
    expect((await fig('CURRENTCOST', '2026-10', 'revenue'))?.value ?? null).toBeNull();
    for (const key of [...COST_MONEY_KEYS, ...COST_RATIO_KEYS]) {
      expect((await fig('CURRENTCOST', '2026-10', key))?.value ?? null, `CURRENTCOST Oct ${key}`).toBeNull();
    }
  });
});

describe('the supplier family follows purchase coverage (SUPPLIERS, C3)', () => {
  it('June and July: Anchor holds 75% of supplier spend, and the spend reconciles to the costs', async () => {
    await expectMoney('SUPPLIERS', '2026-06', 'cost_of_sales', '600.00');
    await expectMoney('SUPPLIERS', '2026-06', 'operating_expenses', '200.00');
    expect(await attributedSupplierSpend('SUPPLIERS', '2026-06')).toEqual(['200.00', '600.00']);
    await expectRatio('SUPPLIERS', '2026-06', 'supplier_concentration_top1', '0.750000');
    await expectMoney('SUPPLIERS', '2026-07', 'cost_of_sales', '300.00');
    await expectMoney('SUPPLIERS', '2026-07', 'operating_expenses', '100.00');
    expect(await attributedSupplierSpend('SUPPLIERS', '2026-07')).toEqual(['100.00', '300.00']);
    await expectRatio('SUPPLIERS', '2026-07', 'supplier_concentration_top1', '0.750000');
  });

  it('August, which only an aged-creditors list touches: no supplier figure and no cost — never 1.0 of a share', async () => {
    await expectMoney('SUPPLIERS', '2026-08', 'revenue', '2000.00');
    await expectNoCostSide('SUPPLIERS', '2026-08');
    // The payables-days base for August is unknown, so the days figure is too (C5).
    expect((await fig('SUPPLIERS', '2026-08', 'payables_days'))?.value ?? null).toBeNull();
  });

  it('the customer family is unchanged in August: one customer, 100% of a revenue the sales list states', async () => {
    expect(ratio((await fig('SUPPLIERS', '2026-08', 'customer_concentration_top1'))?.value)).toBe('1.000000');
  });
});

describe('evidence and tenancy', () => {
  it('every leaf descriptor of revenue, cost and expense figures in these organisations totals to its figure', async () => {
    let checked = 0;
    for (const k of KEYS) {
      const keys = ['revenue', 'customer_revenue', 'cost_of_sales', 'operating_expenses', 'other_expense',
        'interest_expense', 'tax_expense', 'expense_by_category', 'expense_by_account', 'supplier_spend'];
      const rows = (await currentFigures(o(k), { keys, dimension: 'any' }))
        .filter((f) => f.value !== null && f.evidenceQuery?.kind === 'leaf');
      for (const row of rows) {
        const selection = await resolveDescriptor(ctxFor(o(k)), (row.evidenceQuery as { descriptor: unknown }).descriptor);
        expect(money(selection.total), `${k} ${row.periodStart} ${row.metricKey} ${row.dimensionKey ?? row.dimensionId ?? '-'}`)
          .toBe(money(row.value));
        checked += 1;
      }
    }
    // Revenue and customer revenue in every stated month, plus the cost, category and supplier rows
    // of BOTH, PURCHSHORT (June), ZEROCOST, CURRENTCOST and SUPPLIERS — about ninety in all.
    expect(checked).toBeGreaterThan(60);
  }, 600_000);

  it('another organisation\'s owner resolves nothing from BOTH\'s July cost of sales', async () => {
    const mine = owner(o('BOTH'));
    const intruder = KEYS.map((k) => owner(o(k))).find((u) => u !== mine)!;
    const descriptor = await descriptorOf('BOTH', '2026-07', 'cost_of_sales');
    expect(money((await resolveDescriptor(ctxFor(o('BOTH')), descriptor)).total)).toBe('800.00');
    const selection = await resolveDescriptor({ ...ctxFor(o('BOTH')), userId: intruder, db: clientFor(intruder) }, descriptor);
    expect(selection.count).toBe(0);
  });
});

describe('engine version and the stale-figure sweep', () => {
  it('every organisation\'s runs ran on the current engine', async () => {
    for (const k of KEYS) expect(await latestVersion(o(k)), k).toBe(ENGINE_VERSION);
    let stale = 0;
    for (const k of KEYS) stale += (await runsOf(o(k), 'succeeded')).filter((r) => r.engine_version !== ENGINE_VERSION).length;
    expect(stale).toBe(0);
  });

  it('STALE: a July net profit = revenue an older engine wrote is queued by the sweep and recomputed to NULL', async () => {
    // FU-12 changes existing values, so FINANCIAL_ENGINE.md §6 requires a MAJOR bump past 4.0.0 — the
    // bump is what makes the sweep re-queue every organisation. Pinned here, not only in the golden
    // file, which re-records itself.
    expect(Number(ENGINE_VERSION.split('.')[0])).toBeGreaterThanOrEqual(5);
    const id = o('STALE');
    await expectUnstated('STALE', '2026-07', 'net_profit');
    // Fixture only: the state a 4.0.0 run left (July net profit 2,000.00 = revenue), not an app write.
    await plantStale(id, { oldVersion: '4.0.0', start: '2026-07-01', key: 'net_profit', value: '2000.000000' });
    expect(money((await fig('STALE', '2026-07', 'net_profit'))?.value)).toBe('2000.00');

    expect(await enqueueEngineUpgrade(ENGINE_VERSION)).toBeGreaterThanOrEqual(1);
    const job = await queuedCalculation(id);
    expect(job).not.toBe('');
    expect(await untilFinished(job)).toBe('succeeded');
    expect(await latestVersion(id)).toBe(ENGINE_VERSION);
    await expectUnstated('STALE', '2026-07', 'net_profit');
    await expectNoCostSide('STALE', '2026-07');
    await expectMoney('STALE', '2026-07', 'revenue', '2000.00');
  }, 900_000);
});

describe('the Profit & loss page says a month\'s spending is unknown, not nothing (FU-12 review)', () => {
  const julyPnl = async (k: Fu12Key) => {
    const userId = owner(o(k));
    const scope = await loadPeriodScope(clientFor(userId), o(k), periodId(o(k), '2026-07-01'), `itest-${TAG}`);
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
