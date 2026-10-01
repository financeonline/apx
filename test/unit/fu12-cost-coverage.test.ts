import { describe, expect, it } from 'vitest';

import {
  composePeriod, computeCoverage, denominatorInputsFor, ENGINE_VERSION, invoiceCostCoverage, invoiceRevenueCoverage,
  invoiceSideCoverage,
  type AccountRef, type AggregateCell, type BankAccountRef, type CounterpartyRef, type CoverageBatch,
  type EngineContext, type MetricResult, type PeriodRef,
} from '@/modules/financial-engine';

/**
 * ADR-122 FU-12 — the cost-side twin of FU-1: an invoice list must never state COSTS for a month it
 * does not cover.
 *
 * FU-1 lets a full SALES list hand the P&L to the invoices source. Before FU-12 that P&L then summed
 * whatever purchase invoices sat in the month — none, when only a sales list had been uploaded — and
 * stated cost of sales and every expense category 0.00: gross, operating and net profit equal to
 * revenue, margins 100%. Phase 16's Funding Readiness reads net_margin, operating_profit and
 * net_profit, so the owner approved fixing it first.
 *
 * The rule (C1–C3): on the INVOICE basis, the cost side is stated only where committed FULL PURCHASE
 * lists establish P, by FU-1's own rules (effective range declared start → min(declared end, commit
 * date); lists that meet combine; a completed P needs every day; the current P is covered to date,
 * `partial_month`; a P not yet begun never). Uncovered, every expense-side figure, every figure derived
 * from one and the supplier figures are NULL `no_source_covers_period` — never 0.00. Revenue, the
 * customer side and the ledger / balance / bank bases are untouched.
 */

const month = (ym: string): PeriodRef => {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return {
    id: `p-${ym}`, periodStart: `${ym}-01`, periodEnd: `${ym}-${String(last).padStart(2, '0')}`,
    fiscalYear: y, fiscalQuarter: Math.floor((m - 1) / 3) + 1, label: ym, isComplete: false,
  };
};
const MAR = month('2026-03');
const JUL = month('2026-07');
const SEP = month('2026-09');
const OCT = month('2026-10');

/** The run's as-of: 15 September 2026, so September is the CURRENT period. */
const AS_OF = '2026-09-15';

const account = (id: string, category: AccountRef['standardCategory'], type: AccountRef['accountType']): AccountRef =>
  ({ id, code: null, name: id, standardCategory: category, accountType: type, isSystem: true });
const CHART: AccountRef[] = [
  account('a-rev', 'revenue', 'income'),
  account('a-cos', 'cost_of_sales', 'expense'),
  account('a-opex', 'operating_expense', 'expense'),
  account('a-mkt', 'marketing', 'expense'),
  account('a-unc', 'uncategorised', 'asset'),
];
const BANK: BankAccountRef = {
  id: 'ba-1', name: 'Current', accountType: 'current', openingBalance: '1000.00', openingBalanceDate: '2026-01-31', isActive: true,
};
const ACME: CounterpartyRef = { id: 'cp-acme', name: 'Acme', kind: 'customer', mergedIntoId: null, defaultExpenseCategory: null };
const PARTS: CounterpartyRef = { id: 'cp-parts', name: 'Parts', kind: 'supplier', mergedIntoId: null, defaultExpenseCategory: 'cost_of_sales' };
const ADS: CounterpartyRef = { id: 'cp-ads', name: 'Ads', kind: 'supplier', mergedIntoId: null, defaultExpenseCategory: 'marketing' };

const context = (over: Partial<EngineContext> = {}): EngineContext => ({
  organizationId: 'org-1', calculationRunId: 'run-1', aggregatedAt: `${AS_OF}T00:00:00.000Z`, asOf: AS_OF,
  engineVersion: ENGINE_VERSION,
  settings: {
    baseCurrency: 'GBP', fiscalYearStartMonth: 1, timezone: 'Europe/London', vatRegistered: false, defaultVatRate: null,
    taxableCategories: ['revenue', 'cost_of_sales', 'operating_expense', 'marketing'],
  },
  costOfSalesEverUsed: true, costOfSalesInInvoices: false,
  accounts: CHART, counterparties: [ACME, PARTS, ADS], bankAccounts: [], periods: [JUL, SEP],
  ...over,
});

let seq = 0;
/** A committed full list: by default SALES, declared 1 June – 31 August, committed 10 September. */
const list = (over: Partial<CoverageBatch>): CoverageBatch => ({
  id: `b-${(seq += 1)}`, targetTable: 'invoices', balanceKind: null, balanceBasis: null, bankAccountId: null,
  invoiceListKind: 'full', importType: 'sales_invoices',
  periodStart: '2026-06-01', periodEnd: '2026-08-31', committedAt: '2026-09-10T10:00:00Z', ...over,
});
const purchases = (over: Partial<CoverageBatch> = {}): CoverageBatch => list({ importType: 'purchase_invoices', ...over });
const SALES = list({});
const PURCHASES = purchases();

const invoiceCell = (p: PeriodRef, invoiceType: string, counterpartyId: string, net: string): AggregateCell => ({
  periodId: p.id, source: 'invoices', standardCategory: null, accountId: null, counterpartyId, bankAccountId: null,
  balanceKind: null, balanceBasis: null, invoiceType, transferKind: null, unpairedTransferCandidate: false,
  debit: '0', credit: '0', amount: net, rowCount: 1, fallbackRows: 0, minDate: p.periodStart, maxDate: p.periodEnd,
});

/*
 * July: £4,000 of sales to Acme; £900 of purchases from Parts (cost of sales) and £300 from Ads
 * (marketing). Covered, the P&L is:
 *   revenue 4,000.00 · cost_of_sales 900.00 · gross_profit 3,100.00 · gross_margin 0.775
 *   operating_expenses 300.00 (marketing) · operating_profit 2,800.00 · operating_margin 0.7
 *   net_profit 2,800.00 · net_margin 0.7 · contribution 4,000 − 900 − 300 = 2,800.00 (ratio 0.7)
 */
const CELLS: AggregateCell[] = [
  invoiceCell(JUL, 'sales', ACME.id, '4000.00'),
  invoiceCell(JUL, 'purchase', PARTS.id, '900.00'),
  invoiceCell(JUL, 'purchase', ADS.id, '300.00'),
];
const SALES_ONLY_CELLS = CELLS.slice(0, 1);

const coverageFor = (period: PeriodRef, batches: CoverageBatch[], opts: { asOf?: string; bank?: boolean; rowCounts?: Record<string, number> } = {}) =>
  computeCoverage({ period, batches, bankAccounts: opts.bank ? [BANK] : [], rowCounts: opts.rowCounts ?? {}, asOf: opts.asOf ?? AS_OF });

const compose = (
  period: PeriodRef, batches: CoverageBatch[], cells: AggregateCell[],
  opts: { asOf?: string; bank?: boolean; rowCounts?: Record<string, number>; ctx?: Partial<EngineContext> } = {},
) => composePeriod({
  period, coverage: coverageFor(period, batches, opts), cells, transferLegs: [],
  context: context({ bankAccounts: opts.bank ? [BANK] : [], ...opts.ctx }),
});

const headline = (results: readonly MetricResult[], key: string): MetricResult => {
  const found = results.find((r) => r.key === key && r.dimensionType === 'none');
  if (found === undefined) throw new Error(`no ${key}`);
  return found;
};
const value = (results: readonly MetricResult[], key: string): string | null => headline(results, key).value;
const category = (results: readonly MetricResult[], name: string): MetricResult | undefined =>
  results.find((r) => r.key === 'expense_by_category' && r.dimensionKey === name);

/** Every C2 figure: the expense lines and every figure derived from one. */
const COST_LEAVES = ['cost_of_sales', 'operating_expenses', 'other_expense', 'interest_expense', 'tax_expense'] as const;
const COST_DERIVED = [
  'gross_profit', 'gross_margin', 'operating_profit', 'operating_margin', 'net_profit', 'net_margin',
  'contribution_margin', 'contribution_margin_ratio',
] as const;
const EXPENSE_CATEGORIES = [
  'cost_of_sales', 'operating_expense', 'payroll', 'marketing', 'depreciation', 'other_expense', 'interest_expense', 'tax_expense',
] as const;

/** Asserts the cost side is unknown for want of a purchase list — never 0.00 — and revenue is not. */
function expectCostsUnknown(results: readonly MetricResult[]): void {
  for (const key of COST_LEAVES) {
    const metric = headline(results, key);
    expect(metric.value, `${key} must not be stated without a purchase list`).toBeNull();
    expect(metric.basis, key).toBe('invoices');
    expect(metric.dataQuality.missing, key).toEqual(['no_source_covers_period']);
    expect(metric.evidenceQuery, key).toBeNull();
  }
  for (const key of COST_DERIVED) {
    const metric = headline(results, key);
    expect(metric.value, `${key} must not be stated without a purchase list`).toBeNull();
    expect(metric.dataQuality.missing, key).toContain('no_source_covers_period');
    expect(metric.dataQuality.warnings, key).not.toContain('no_cost_of_sales');
  }
  // No expense category is written — neither as 0.00 nor as the purchases no list established.
  for (const name of EXPENSE_CATEGORIES) expect(category(results, name), name).toBeUndefined();
}

describe('C2 · a sales list alone states revenue, never costs', () => {
  it('a sales-only spanning list: revenue stated, every cost and profit figure NULL no_source_covers_period', () => {
    // Pre-FU-12: cost_of_sales 0.00, operating_expenses 0.00, gross = operating = net profit = 4,000.00,
    // and every margin 1.000000.
    const results = compose(JUL, [SALES], SALES_ONLY_CELLS);
    expect(value(results, 'revenue')).toBe('4000.00');
    expect(headline(results, 'revenue').basis).toBe('invoices');
    expect(headline(results, 'revenue').dataQuality.missing).toEqual([]);
    expectCostsUnknown(results);
    // Other income is not a cost: unchanged, the stated zero no invoice can reach.
    expect(value(results, 'other_income')).toBe('0.00');
    expect(headline(results, 'other_income').dataQuality.missing).toEqual([]);
  });

  it('even purchase invoices in the month are not costs no list establishes', () => {
    // Pre-FU-12 these summed to cost_of_sales 900.00 and marketing 300.00 — stated, calculated and
    // complete — though no purchase list says they are the month's purchases.
    const results = compose(JUL, [SALES], CELLS);
    expect(value(results, 'revenue')).toBe('4000.00');
    expectCostsUnknown(results);
  });

  it('gross profit is NOT revenue when costs are uncovered, even with no cost-of-sales account', () => {
    // An organisation that never used cost of sales. Pre-FU-12 its gross profit fell back to revenue
    // (4,000.00, `no_cost_of_sales`) and its operating and net profit to 4,000.00 as well.
    const noCos = { costOfSalesEverUsed: false, costOfSalesInInvoices: false };
    const results = compose(JUL, [SALES], SALES_ONLY_CELLS, { ctx: noCos });
    expect(value(results, 'revenue')).toBe('4000.00');
    expect(value(results, 'gross_profit')).toBeNull();
    expect(value(results, 'gross_profit')).not.toBe(value(results, 'revenue'));
    expect(headline(results, 'cost_of_sales').dataQuality.missing).toEqual(['no_source_covers_period']);
    expectCostsUnknown(results);
    // With a purchase list covering July, the no-cost-of-sales-account path stands as it always did.
    const covered = compose(JUL, [SALES, PURCHASES], SALES_ONLY_CELLS, { ctx: noCos });
    expect(value(covered, 'cost_of_sales')).toBeNull();
    expect(headline(covered, 'cost_of_sales').dataQuality.missing).toEqual(['no_cost_of_sales_accounts']);
    expect(value(covered, 'gross_profit')).toBe('4000.00');
    expect(headline(covered, 'gross_profit').dataQuality.warnings).toContain('no_cost_of_sales');
    expect(value(covered, 'gross_margin')).toBeNull();
  });
});

describe('C1 · full purchase lists establish the costs by FU-1’s rules', () => {
  it('sales + purchase full lists spanning the month: costs and profit stated exactly', () => {
    expect(coverageFor(JUL, [SALES, PURCHASES]).invoiceCosts).toEqual({ covers: true, warnings: [], completeness: 1 });
    const results = compose(JUL, [SALES, PURCHASES], CELLS);
    expect(value(results, 'revenue')).toBe('4000.00');
    expect(value(results, 'cost_of_sales')).toBe('900.00');
    expect(value(results, 'gross_profit')).toBe('3100.00');
    expect(value(results, 'gross_margin')).toBe('0.775000');
    expect(value(results, 'operating_expenses')).toBe('300.00');
    expect(value(results, 'operating_profit')).toBe('2800.00');
    expect(value(results, 'operating_margin')).toBe('0.700000');
    expect(value(results, 'other_expense')).toBe('0.00');
    expect(value(results, 'interest_expense')).toBe('0.00');
    expect(value(results, 'tax_expense')).toBe('0.00');
    expect(value(results, 'net_profit')).toBe('2800.00');
    expect(value(results, 'net_margin')).toBe('0.700000');
    expect(value(results, 'contribution_margin')).toBe('2800.00');
    expect(value(results, 'contribution_margin_ratio')).toBe('0.700000');
    expect(category(results, 'cost_of_sales')?.value).toBe('900.00');
    expect(category(results, 'marketing')?.value).toBe('300.00');
    for (const key of [...COST_LEAVES, ...COST_DERIVED]) {
      expect(headline(results, key).dataQuality.missing, key).toEqual([]);
    }
    // A purchase REPORT is a purchase list too.
    expect(value(compose(JUL, [SALES, purchases({ importType: 'purchase_report' })], CELLS), 'cost_of_sales')).toBe('900.00');
  });

  it('a purchase list committed mid-month knows nothing after its commit date: NULL', () => {
    const midMonth = purchases({ committedAt: '2026-07-20T12:00:00Z' });
    expect(invoiceCostCoverage([midMonth], JUL, AS_OF)).toEqual({ covers: false, warnings: [], completeness: 0 });
    expectCostsUnknown(compose(JUL, [SALES, midMonth], CELLS));
  });

  it('a purchase list whose range stops short of the month end: NULL', () => {
    const stopsShort = purchases({ periodEnd: '2026-07-20', committedAt: '2026-07-21T12:00:00Z' });
    expect(coverageFor(JUL, [SALES, stopsShort]).invoiceCosts?.covers).toBe(false);
    expectCostsUnknown(compose(JUL, [SALES, stopsShort], CELLS));
  });

  it('a purchase list committed BEFORE the month: NULL', () => {
    const march = purchases({ periodStart: '2026-03-01', periodEnd: '2026-03-31', committedAt: '2026-04-05T09:00:00Z' });
    expect(coverageFor(JUL, [SALES, march]).invoiceCosts?.covers).toBe(false);
    expectCostsUnknown(compose(JUL, [SALES, march], CELLS));
    // It still establishes March's costs.
    expect(invoiceCostCoverage([march], MAR, AS_OF).covers).toBe(true);
  });

  it('two contiguous purchase halves combine and cover the month; a gap does not', () => {
    const halves = [purchases({ periodStart: '2026-07-01', periodEnd: '2026-07-15' }), purchases({ periodStart: '2026-07-16', periodEnd: '2026-07-31' })];
    expect(coverageFor(JUL, [SALES, ...halves]).invoiceCosts).toEqual({ covers: true, warnings: [], completeness: 1 });
    const results = compose(JUL, [SALES, ...halves], CELLS);
    expect(value(results, 'cost_of_sales')).toBe('900.00');
    expect(value(results, 'net_profit')).toBe('2800.00');
    const holed = [purchases({ periodStart: '2026-07-01', periodEnd: '2026-07-14' }), purchases({ periodStart: '2026-07-16', periodEnd: '2026-07-31' })];
    expectCostsUnknown(compose(JUL, [SALES, ...holed], CELLS));
  });

  it('a sales list, an open-items purchase list or a month not yet begun never establish the costs', () => {
    expect(invoiceCostCoverage([SALES], JUL, AS_OF).covers).toBe(false);
    expect(invoiceCostCoverage([purchases({ invoiceListKind: 'open_items' })], JUL, AS_OF).covers).toBe(false);
    expect(invoiceCostCoverage([purchases({ periodEnd: '2026-12-31' })], OCT, AS_OF).covers).toBe(false);
  });

  it('genuine zero: a covering purchase list with no purchases states 0.00, with nothing missing', () => {
    // The list says every purchase of June–August is on it, and none is dated July. That IS a
    // statement that July's costs were nil — the zero FU-12 must keep.
    const results = compose(JUL, [SALES, PURCHASES], SALES_ONLY_CELLS);
    for (const key of COST_LEAVES) {
      expect(value(results, key), key).toBe('0.00');
      expect(headline(results, key).dataQuality.missing, key).toEqual([]);
    }
    expect(value(results, 'gross_profit')).toBe('4000.00');
    expect(value(results, 'net_profit')).toBe('4000.00');
    expect(value(results, 'net_margin')).toBe('1.000000');
  });
});

describe('C2 · the current month: costs to date, flagged as revenue is', () => {
  // Run as of 15 September. FU-12 review: costs to date are stated only when the purchase lists reach
  // EXACTLY as far as the sales lists (equal completeness) — a profit is revenue less costs over the
  // SAME days. Before the review, sales to the 10th with purchases to the 12th were "covered".
  const to = (day: string) => ({ periodEnd: `2026-09-${day}`, committedAt: `2026-09-${day}T18:00:00Z` });
  const salesTo10 = list({ periodEnd: '2026-09-10' });
  const salesTo12 = list(to('12'));
  const purchasesTo12 = purchases(to('12'));
  const sepCells = [
    invoiceCell(SEP, 'sales', ACME.id, '500.00'),
    invoiceCell(SEP, 'purchase', PARTS.id, '120.00'),
  ];

  it('covers the current month to date: partial_month, 12 of 30 days', () => {
    // FU-12 review: both sides reach the 12th — equal reach, so the costs are the same 12 days' costs.
    expect(coverageFor(SEP, [salesTo12, purchasesTo12]).bySource.invoices)
      .toEqual({ covers: true, warnings: ['partial_month'], completeness: 12 / 30 });
    expect(coverageFor(SEP, [salesTo12, purchasesTo12]).invoiceCosts)
      .toEqual({ covers: true, warnings: ['partial_month'], completeness: 12 / 30 });
    const results = compose(SEP, [salesTo12, purchasesTo12], sepCells);
    expect(value(results, 'revenue')).toBe('500.00');
    expect(value(results, 'cost_of_sales')).toBe('120.00');
    expect(value(results, 'gross_profit')).toBe('380.00');
    expect(value(results, 'operating_expenses')).toBe('0.00');
    expect(value(results, 'net_profit')).toBe('380.00');
    expect(value(results, 'net_margin')).toBe('0.760000');
    for (const key of ['cost_of_sales', 'operating_expenses', 'gross_profit', 'net_profit']) {
      expect(headline(results, key).dataQuality.warnings, key).toContain('partial_month');
      expect(headline(results, key).dataQuality.missing, key).toEqual([]);
    }
    expect(category(results, 'cost_of_sales')?.value).toBe('120.00');
    expect(category(results, 'cost_of_sales')?.dataQuality.warnings).toContain('partial_month');
  });

  it('FU-12 review: purchases reaching FURTHER than sales (12th vs 10th): costs and profit NULL', () => {
    // Pre-review this was "covered", completeness 12/30: cost_of_sales 120.00, net_profit 380.00 —
    // 10 days of revenue less 12 days of costs.
    const coverage = coverageFor(SEP, [salesTo10, purchasesTo12]);
    expect(coverage.bySource.invoices).toEqual({ covers: true, warnings: ['partial_month'], completeness: 10 / 30 });
    expect(coverage.invoiceCosts).toEqual({ covers: false, warnings: [], completeness: 0 });
    // The purchase list on its own does establish September to the 12th — it is the mismatch that fails.
    expect(invoiceCostCoverage([purchasesTo12], SEP, AS_OF)).toEqual({ covers: true, warnings: ['partial_month'], completeness: 12 / 30 });
    const results = compose(SEP, [salesTo10, purchasesTo12], sepCells);
    expect(value(results, 'revenue')).toBe('500.00');
    expect(headline(results, 'revenue').dataQuality.warnings).toContain('partial_month');
    expectCostsUnknown(results);
    expect(value(results, 'net_profit')).not.toBe('380.00');
  });

  it('FU-12 review: purchases falling SHORT of sales (3rd vs 25th): costs and profit NULL, never revenue less 3 days', () => {
    const asOf = '2026-09-26';
    const salesTo25 = list(to('25'));
    const purchasesTo3 = purchases(to('03'));
    const coverage = coverageFor(SEP, [salesTo25, purchasesTo3], { asOf });
    expect(coverage.bySource.invoices).toEqual({ covers: true, warnings: ['partial_month'], completeness: 25 / 30 });
    expect(coverage.invoiceCosts).toEqual({ covers: false, warnings: [], completeness: 0 });
    const results = compose(SEP, [salesTo25, purchasesTo3], sepCells, { asOf, ctx: { asOf, aggregatedAt: `${asOf}T00:00:00.000Z` } });
    expect(value(results, 'revenue')).toBe('500.00');
    expectCostsUnknown(results);
    // Not 25 days of revenue less 3 days of costs.
    expect(value(results, 'net_profit')).not.toBe('380.00');
    expect(value(results, 'gross_profit')).not.toBe('380.00');
  });

  it('a sales list to date with a purchase list ending before the month: costs NULL', () => {
    expect(coverageFor(SEP, [salesTo10, PURCHASES]).invoiceCosts?.covers).toBe(false);
    const results = compose(SEP, [salesTo10, PURCHASES], sepCells);
    expect(value(results, 'revenue')).toBe('500.00');
    expectCostsUnknown(results);
  });
});

describe('C3 · the supplier side follows the purchase lists; the customer side does not', () => {
  const suppliers = (results: readonly MetricResult[]) => results.filter((r) => r.key === 'supplier_spend');

  it('uncovered: no supplier_spend row, supplier concentration NULL no_source_covers_period', () => {
    // Pre-FU-12: Parts 900.00 and Ads 300.00, top1 0.75 — from purchases no list establishes. With no
    // purchase cells at all: an Unattributed 0.00 and concentration NULL `no_counterparty_data`.
    for (const cells of [CELLS, SALES_ONLY_CELLS]) {
      const results = compose(JUL, [SALES], cells);
      expect(suppliers(results)).toEqual([]);
      for (const key of ['supplier_concentration_top1', 'supplier_concentration_top5']) {
        const metric = headline(results, key);
        expect(metric.value, key).toBeNull();
        expect(metric.dataQuality.missing, key).toEqual(['no_source_covers_period']);
      }
      // The customer side is the sales list's, unchanged.
      expect(results.find((r) => r.key === 'customer_revenue' && r.dimensionId === ACME.id)?.value).toBe('4000.00');
      expect(value(results, 'customer_concentration_top1')).toBe('1.000000');
    }
  });

  it('covered: supplier spend and concentration stated exactly', () => {
    const results = compose(JUL, [SALES, PURCHASES], CELLS);
    expect(results.find((r) => r.key === 'supplier_spend' && r.dimensionId === PARTS.id)?.value).toBe('900.00');
    expect(results.find((r) => r.key === 'supplier_spend' && r.dimensionId === ADS.id)?.value).toBe('300.00');
    expect(value(results, 'supplier_concentration_top1')).toBe('0.750000');
    expect(value(results, 'supplier_concentration_top5')).toBe('1.000000');
  });

  it('covered to date: the supplier figures carry partial_month', () => {
    // FU-12 review: sales and purchases both reach the 12th (equal reach).
    const sep = [invoiceCell(SEP, 'sales', ACME.id, '500.00'), invoiceCell(SEP, 'purchase', PARTS.id, '120.00')];
    const to12 = { periodEnd: '2026-09-12', committedAt: '2026-09-12T18:00:00Z' };
    const results = compose(SEP, [list(to12), purchases(to12)], sep);
    const parts = results.find((r) => r.key === 'supplier_spend' && r.dimensionId === PARTS.id);
    expect(parts?.value).toBe('120.00');
    expect(parts?.dataQuality.warnings).toContain('partial_month');
    expect(value(results, 'supplier_concentration_top1')).toBe('1.000000');
    expect(headline(results, 'supplier_concentration_top1').dataQuality.warnings).toContain('partial_month');
  });

  it('FU-12 review: unequal reach to date (either direction): supplier figures not stated', () => {
    const sep = [invoiceCell(SEP, 'sales', ACME.id, '500.00'), invoiceCell(SEP, 'purchase', PARTS.id, '120.00')];
    const asOf = '2026-09-26';
    const at = { asOf, ctx: { asOf, aggregatedAt: `${asOf}T00:00:00.000Z` } };
    const to = (day: string) => ({ periodEnd: `2026-09-${day}`, committedAt: `2026-09-${day}T18:00:00Z` });
    for (const [salesDay, purchaseDay] of [['10', '12'], ['25', '03']] as const) {
      const results = compose(SEP, [list(to(salesDay)), purchases(to(purchaseDay))], sep, at);
      expect(suppliers(results), `${salesDay}/${purchaseDay}`).toEqual([]);
      for (const key of ['supplier_concentration_top1', 'supplier_concentration_top5']) {
        expect(value(results, key), key).toBeNull();
        expect(headline(results, key).dataQuality.missing, key).toEqual(['no_source_covers_period']);
      }
      // The customer side is the sales list's, unchanged.
      expect(results.find((r) => r.key === 'customer_revenue' && r.dimensionId === ACME.id)?.value).toBe('500.00');
    }
  });
});

describe('C4 / C5 · what FU-12 does not change, and the days denominators', () => {
  it('payablesExpenseBase is NULL — not a zero base — when costs are uncovered', () => {
    const uncovered = compose(JUL, [SALES], CELLS);
    expect(denominatorInputsFor(JUL, uncovered, CELLS, [SALES]).payablesExpenseBase).toBeNull();
    // Covered: cost of sales 900 + operating expense 0 + marketing 300.
    const covered = compose(JUL, [SALES, PURCHASES], CELLS);
    expect(denominatorInputsFor(JUL, covered, CELLS, [SALES, PURCHASES]).payablesExpenseBase).toBe('1200.00');
  });

  it('a purchase-only list still does not make the invoices source cover the month (FU-1 mirror)', () => {
    const coverage = coverageFor(JUL, [PURCHASES]);
    expect(coverage.bySource.invoices.covers).toBe(false);
    expect(coverage.invoiceCosts?.covers).toBe(true);
    expect(invoiceRevenueCoverage([PURCHASES], JUL, AS_OF).covers).toBe(false);
    const results = compose(JUL, [PURCHASES], CELLS);
    expect(headline(results, 'revenue').basis).toBe('none');
    expect(value(results, 'cost_of_sales')).toBeNull();
  });

  it('AR/AP side coverage is unchanged', () => {
    expect(invoiceSideCoverage([SALES], JUL, 'purchase').covers).toBe(false);
    expect(invoiceSideCoverage([PURCHASES], JUL, 'purchase').covers).toBe(true);
  });

  it('the ledger basis states its costs whatever the purchase lists say', () => {
    const ledgerBatch: CoverageBatch = {
      id: 'b-gl', targetTable: 'ledger_entries', balanceKind: null, balanceBasis: null, bankAccountId: null,
      invoiceListKind: null, importType: 'general_ledger', periodStart: '2026-07-01', periodEnd: '2026-07-31',
      committedAt: '2026-08-05T00:00:00Z',
    };
    const ledger = (accountId: string, debit: string, credit: string): AggregateCell => ({
      ...invoiceCell(JUL, 'sales', ACME.id, '0'), source: 'ledger', invoiceType: null, counterpartyId: null, accountId,
      standardCategory: CHART.find((a) => a.id === accountId)!.standardCategory, debit, credit,
      amount: (Number(debit) - Number(credit)).toFixed(2),
    });
    const cells = [ledger('a-rev', '0', '5000'), ledger('a-cos', '700', '0'), ledger('a-opex', '250', '0')];
    // A sales-only invoice list is present too: the ledger outranks it, and no purchase list is needed.
    const results = compose(JUL, [ledgerBatch, SALES], cells, { rowCounts: { ledger: 3 } });
    expect(headline(results, 'cost_of_sales').basis).toBe('ledger');
    expect(value(results, 'cost_of_sales')).toBe('700.00');
    expect(value(results, 'operating_expenses')).toBe('250.00');
    expect(value(results, 'net_profit')).toBe('4050.00');
  });

  it('the balances basis states its costs whatever the purchase lists say', () => {
    const tb: CoverageBatch = {
      id: 'b-tb', targetTable: 'period_balances', balanceKind: 'trial_balance', balanceBasis: 'movement', bankAccountId: null,
      invoiceListKind: null, importType: 'trial_balance', periodStart: '2026-07-01', periodEnd: '2026-07-31',
      committedAt: '2026-08-05T00:00:00Z',
    };
    const balance = (accountId: string, debit: string, credit: string): AggregateCell => ({
      ...invoiceCell(JUL, 'sales', ACME.id, '0'), source: 'period_balances', invoiceType: null, counterpartyId: null, accountId,
      balanceKind: 'trial_balance', balanceBasis: 'movement',
      standardCategory: CHART.find((a) => a.id === accountId)!.standardCategory, debit, credit,
      amount: (Number(debit) - Number(credit)).toFixed(2),
    });
    const cells = [balance('a-rev', '0', '5000'), balance('a-cos', '700', '0')];
    const results = compose(JUL, [tb, SALES], cells, { rowCounts: { period_balances: 2 } });
    expect(headline(results, 'cost_of_sales').basis).toBe('period_balances');
    expect(value(results, 'cost_of_sales')).toBe('700.00');
    expect(value(results, 'net_profit')).toBe('4300.00');
  });

  it('the bank basis states its costs whatever the purchase lists say', () => {
    const statement: CoverageBatch = {
      id: 'st-jul', targetTable: 'bank_transactions', balanceKind: null, balanceBasis: null, bankAccountId: BANK.id,
      invoiceListKind: null, importType: 'bank_statement', periodStart: JUL.periodStart, periodEnd: JUL.periodEnd,
      committedAt: '2026-08-05T00:00:00Z',
    };
    const bankCell = (accountId: string, inflow: string, outflow: string): AggregateCell => ({
      ...invoiceCell(JUL, 'sales', ACME.id, '0'), source: 'bank', invoiceType: null, counterpartyId: null, accountId,
      bankAccountId: BANK.id, transferKind: 'none',
      standardCategory: CHART.find((a) => a.id === accountId)!.standardCategory, debit: inflow, credit: outflow,
      amount: (Number(inflow) - Number(outflow)).toFixed(2),
    });
    const cells = [bankCell('a-rev', '2500', '0'), bankCell('a-opex', '0', '400')];
    const results = compose(JUL, [statement], cells, { bank: true });
    expect(headline(results, 'operating_expenses').basis).toBe('bank');
    expect(value(results, 'operating_expenses')).toBe('400.00');
    expect(value(results, 'net_profit')).toBe('2100.00');
  });
});
