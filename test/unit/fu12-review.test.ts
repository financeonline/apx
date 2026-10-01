import { describe, expect, it } from 'vitest';

import {
  composePeriod, computeCoverage, denominatorInputsFor, ENGINE_VERSION, variancesForPeriod,
  type AccountRef, type AggregateCell, type CounterpartyRef, type CoverageBatch,
  type EngineContext, type MetricResult, type PeriodRef, type StoredFigure,
} from '@/modules/financial-engine';

/**
 * ADR-122 FU-12 — the adversarial review's fixes (F1, F3, F4). F2 (equal reach in the current month)
 * is pinned in `fu12-cost-coverage.test.ts` and the engine golden corpus.
 *
 *  F1  a period whose expense side no source establishes (`operating_expenses` NULL with
 *      `no_source_covers_period`) writes no expense category — an ABSENT category there is unknown,
 *      not a known zero. Its variances are NULL `no_source_covers_period`, never −100% / "new".
 *  F3  purchases no purchase list establishes are out of the whole invoice-basis P&L fold.
 *  F4  costs stated only to date (`partial_month` on the invoices basis) are no expense base.
 */

const month = (ym: string): PeriodRef => {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return {
    id: `p-${ym}`, periodStart: `${ym}-01`, periodEnd: `${ym}-${String(last).padStart(2, '0')}`,
    fiscalYear: y, fiscalQuarter: Math.floor((m - 1) / 3) + 1, label: ym, isComplete: true,
  };
};
const MAY = month('2026-05');
const JUN = month('2026-06');
const JUL = month('2026-07');
const AUG = month('2026-08');
const SEP = month('2026-09');
const ALL = [MAY, JUN, JUL, AUG, SEP];

/** As of 15 October: every period here is completed. */
const AS_OF = '2026-10-15';

const account = (id: string, category: AccountRef['standardCategory'], type: AccountRef['accountType']): AccountRef =>
  ({ id, code: null, name: id, standardCategory: category, accountType: type, isSystem: true });
const CHART: AccountRef[] = [
  account('a-rev', 'revenue', 'income'),
  account('a-oi', 'other_income', 'income'),
  account('a-cos', 'cost_of_sales', 'expense'),
  account('a-opex', 'operating_expense', 'expense'),
  account('a-mkt', 'marketing', 'expense'),
  account('a-unc', 'uncategorised', 'asset'),
];
const supplier = (id: string, category: CounterpartyRef['defaultExpenseCategory']): CounterpartyRef =>
  ({ id, name: id, kind: 'supplier', mergedIntoId: null, defaultExpenseCategory: category });
const ACME: CounterpartyRef = { id: 'cp-acme', name: 'Acme', kind: 'customer', mergedIntoId: null, defaultExpenseCategory: null };
const PARTS = supplier('cp-parts', 'cost_of_sales');
const ADS = supplier('cp-ads', 'marketing');
/** A supplier whose default puts its invoices into OTHER INCOME (e.g. a rebate / commission payer). */
const REBATES = supplier('cp-rebates', 'other_income');
/** A supplier with no default: its invoices are uncategorised. */
const MISC = supplier('cp-misc', null);

const context = (over: Partial<EngineContext> = {}): EngineContext => ({
  organizationId: 'org-1', calculationRunId: 'run-1', aggregatedAt: `${AS_OF}T00:00:00.000Z`, asOf: AS_OF,
  engineVersion: ENGINE_VERSION,
  settings: {
    baseCurrency: 'GBP', fiscalYearStartMonth: 1, timezone: 'Europe/London', vatRegistered: false, defaultVatRate: null,
    taxableCategories: ['revenue', 'cost_of_sales', 'operating_expense', 'marketing'],
  },
  costOfSalesEverUsed: true, costOfSalesInInvoices: false,
  accounts: CHART, counterparties: [ACME, PARTS, ADS, REBATES, MISC], bankAccounts: [], periods: ALL,
  ...over,
});

let seq = 0;
const list = (over: Partial<CoverageBatch>): CoverageBatch => ({
  id: `b-${(seq += 1)}`, targetTable: 'invoices', balanceKind: null, balanceBasis: null, bankAccountId: null,
  invoiceListKind: 'full', importType: 'sales_invoices',
  periodStart: '2026-05-01', periodEnd: '2026-09-30', committedAt: '2026-10-05T10:00:00Z', ...over,
});
const purchases = (periodStart: string, periodEnd: string): CoverageBatch =>
  list({ importType: 'purchase_invoices', periodStart, periodEnd });
/** Sales lists establish May–September. */
const SALES = list({});

const invoiceCell = (p: PeriodRef, invoiceType: string, counterpartyId: string, net: string, vat = '0'): AggregateCell => ({
  periodId: p.id, source: 'invoices', standardCategory: null, accountId: null, counterpartyId, bankAccountId: null,
  balanceKind: null, balanceBasis: null, invoiceType, transferKind: null, unpairedTransferCandidate: false,
  debit: vat, credit: '0', amount: net, rowCount: 1, fallbackRows: 0, minDate: p.periodStart, maxDate: p.periodEnd,
});

const compose = (period: PeriodRef, batches: CoverageBatch[], cells: AggregateCell[]): MetricResult[] => composePeriod({
  period,
  coverage: computeCoverage({ period, batches, bankAccounts: [], rowCounts: {}, asOf: AS_OF }),
  cells, transferLegs: [], context: context(),
}).map((r, i) => ({ ...r, id: `${period.id}-${i}` }));

const headline = (results: readonly MetricResult[], key: string): MetricResult => {
  const found = results.find((r) => r.key === key && r.dimensionType === 'none');
  if (found === undefined) throw new Error(`no ${key}`);
  return found;
};
const categoryRow = (results: readonly MetricResult[], key: string, name: string): MetricResult | undefined =>
  results.find((r) => r.key === key && r.dimensionKey === name);

let minted = 0;
const mint = () => `v-${(minted += 1)}`;
const variances = (period: PeriodRef, results: MetricResult[], computed: Map<string, MetricResult[]>, stored: StoredFigure[] = []) =>
  variancesForPeriod({ period, allPeriods: ALL, results, computed, stored, currency: 'GBP', mint });

/** The stored-figure shape the repository hands the pass, from a result. */
const toStored = (periodId: string, results: readonly MetricResult[]): StoredFigure[] => results.map((r) => ({
  periodId, metricKey: r.key, dimensionType: r.dimensionType, dimensionId: r.dimensionId, dimensionKey: r.dimensionKey ?? null,
  snapshotId: r.id ?? `stored-${periodId}-${r.key}`, value: r.value, basis: r.basis, assurance: r.assurance,
  dataQuality: { completeness: r.dataQuality.completeness, warnings: [...r.dataQuality.warnings], missing: [...r.dataQuality.missing] },
}));

// ---------------------------------------------------------------------------------------------
// F1 — variance of an absent dimension in a period whose side nothing establishes
// ---------------------------------------------------------------------------------------------

describe('F1 · an absent expense category in an uncovered month is unknown, not zero', () => {
  /*
   * Invoice basis throughout; sales lists establish May–September. Purchase lists establish June–July
   * and September — AUGUST has none, so its costs are NULL `no_source_covers_period` and no expense
   * category is written. July: Ads (marketing) 300; September: Ads 200; June: Parts (cost of sales) 100.
   */
  const PURCHASES = [purchases('2026-06-01', '2026-07-31'), purchases('2026-09-01', '2026-09-30')];
  const BATCHES = [SALES, ...PURCHASES];
  const jun = compose(JUN, BATCHES, [invoiceCell(JUN, 'sales', ACME.id, '1000.00'), invoiceCell(JUN, 'purchase', PARTS.id, '100.00')]);
  const jul = compose(JUL, BATCHES, [invoiceCell(JUL, 'sales', ACME.id, '1000.00'), invoiceCell(JUL, 'purchase', ADS.id, '300.00')]);
  // August's purchases are on no purchase list: they are not August's costs to report.
  const aug = compose(AUG, BATCHES, [invoiceCell(AUG, 'sales', ACME.id, '1000.00'), invoiceCell(AUG, 'purchase', ADS.id, '250.00')]);
  const sep = compose(SEP, BATCHES, [invoiceCell(SEP, 'sales', ACME.id, '1000.00'), invoiceCell(SEP, 'purchase', ADS.id, '200.00')]);
  const variance = (out: readonly MetricResult[], suffix: string, name: string) =>
    out.find((r) => r.key === `expense_by_category.variance.${suffix}` && r.dimensionKey === name);

  it('the fixture: July and September covered with marketing; August uncovered with no category row', () => {
    expect(categoryRow(jul, 'expense_by_category', 'marketing')?.value).toBe('300.00');
    expect(categoryRow(sep, 'expense_by_category', 'marketing')?.value).toBe('200.00');
    expect(headline(aug, 'operating_expenses').value).toBeNull();
    expect(headline(aug, 'operating_expenses').dataQuality.missing).toEqual(['no_source_covers_period']);
    expect(aug.filter((r) => r.key === 'expense_by_category')).toEqual([]);
    expect(headline(aug, 'revenue').value).toBe('1000.00');
  });

  it('covered July (marketing 300) → uncovered August: prev_period NULL no_source_covers_period, not −300.00', () => {
    const out = variances(AUG, aug, new Map([[JUL.id, jul]]));
    const mk = variance(out, 'prev_period', 'marketing');
    expect(mk).toBeDefined();
    expect(mk?.value).toBeNull();
    expect(mk?.value).not.toBe('-300.00');
    expect(mk?.dataQuality.missing).toContain('no_source_covers_period');
    expect(mk?.components.current).toBeNull();
    expect(mk?.components.pct_change).toBeNull();
    expect(mk?.components.pct_change).not.toBe('-1.000000');
    // The comparison side (July) is known.
    expect(mk?.components.comparison).toBe('300.00');
  });

  it('uncovered August → covered September (marketing 200): prev_period NULL, comparison null, never new_in_period', () => {
    const out = variances(SEP, sep, new Map([[AUG.id, aug]]));
    const mk = variance(out, 'prev_period', 'marketing');
    expect(mk).toBeDefined();
    expect(mk?.value).toBeNull();
    expect(mk?.value).not.toBe('200.00');
    expect(mk?.components.current).toBe('200.00');
    expect(mk?.components.comparison).toBeNull();
    expect(mk?.dataQuality.missing).toContain('no_source_covers_period');
    expect(mk?.dataQuality.warnings).not.toContain('new_in_period');
  });

  it('trailing_3m_avg with one uncovered month in the window: NULL no_source_covers_period', () => {
    // September's window is August (uncovered), July (300) and June (no marketing — a known zero).
    const out = variances(SEP, sep, new Map([[JUN.id, jun], [JUL.id, jul], [AUG.id, aug]]));
    const mk = variance(out, 'trailing_3m_avg', 'marketing');
    expect(mk).toBeDefined();
    expect(mk?.value).toBeNull();
    expect(mk?.components.comparison).toBeNull();
    expect(mk?.dataQuality.missing).toContain('no_source_covers_period');
    // Not (0 + 300 + 0) / 3 = 100 → 200 − 100 = 100.00.
    expect(mk?.value).not.toBe('100.00');
  });

  it('control: covered month with no marketing row after a covered month with 300 — still −300.00 (known zero)', () => {
    // Purchase lists now establish August too: its absent marketing is "nothing spent".
    const covered = [SALES, purchases('2026-06-01', '2026-09-30')];
    const julC = compose(JUL, covered, [invoiceCell(JUL, 'sales', ACME.id, '1000.00'), invoiceCell(JUL, 'purchase', ADS.id, '300.00')]);
    const augC = compose(AUG, covered, [invoiceCell(AUG, 'sales', ACME.id, '1000.00'), invoiceCell(AUG, 'purchase', PARTS.id, '50.00')]);
    expect(headline(augC, 'operating_expenses').value).toBe('0.00');
    expect(categoryRow(augC, 'expense_by_category', 'marketing')).toBeUndefined();
    const mk = variance(variances(AUG, augC, new Map([[JUL.id, julC]])), 'prev_period', 'marketing');
    expect(mk?.value).toBe('-300.00');
    expect(mk?.components.current).toBe('0.00');
    expect(mk?.components.pct_change).toBe('-1.000000');
    expect(mk?.dataQuality.missing).toEqual([]);
    // And the reverse, a covered month before: a category new this month — a real zero comparison.
    const sepC = compose(SEP, covered, [invoiceCell(SEP, 'sales', ACME.id, '1000.00'), invoiceCell(SEP, 'purchase', ADS.id, '200.00')]);
    const fresh = variance(variances(SEP, sepC, new Map([[AUG.id, augC]])), 'prev_period', 'marketing');
    expect(fresh?.value).toBe('200.00');
    expect(fresh?.components.comparison).toBe('0.00');
    expect(fresh?.dataQuality.warnings).toContain('new_in_period');
  });

  it('stored comparisons (observationsFromStored): the same rule for a period an earlier run wrote', () => {
    // August read from storage, uncovered: September's marketing has no comparison.
    const fromStoredAug = variance(variances(SEP, sep, new Map(), toStored(AUG.id, aug)), 'prev_period', 'marketing');
    expect(fromStoredAug?.value).toBeNull();
    expect(fromStoredAug?.components.comparison).toBeNull();
    expect(fromStoredAug?.dataQuality.missing).toContain('no_source_covers_period');
    expect(fromStoredAug?.dataQuality.warnings).not.toContain('new_in_period');
    // July read from storage, August current and uncovered: the current side is unknown.
    const fromStoredJul = variance(variances(AUG, aug, new Map(), toStored(JUL.id, jul)), 'prev_period', 'marketing');
    expect(fromStoredJul?.value).toBeNull();
    expect(fromStoredJul?.components.current).toBeNull();
    expect(fromStoredJul?.components.comparison).toBe('300.00');
    expect(fromStoredJul?.dataQuality.missing).toContain('no_source_covers_period');
  });

  it('income categories follow revenue, expense categories follow operating_expenses — side by side', () => {
    // Hand-built levels: May states its expense side (operating_expenses 0.00) but NOT its revenue
    // side (revenue NULL no_source_covers_period). April's other_income 50 and marketing 80 are absent
    // from May: other_income is unknown; marketing is a known zero.
    const level = (key: string, value: string | null, over: Partial<MetricResult> = {}): MetricResult => ({
      id: `l-${key}-${over.dimensionKey ?? ''}`, key, value, unit: 'money', basis: 'invoices', assurance: 'calculated',
      dimensionType: 'none', dimensionId: null, currency: 'GBP', components: {}, evidenceQuery: null,
      dataQuality: { completeness: 1, proxy: false, warnings: [], missing: value === null ? ['no_source_covers_period'] : [] }, ...over,
    });
    const cat = (name: string, value: string) => level('expense_by_category', value, { dimensionType: 'standard_category', dimensionKey: name });
    const APR = month('2026-04');
    const april = [level('revenue', '1000.00'), level('operating_expenses', '80.00'), cat('other_income', '50.00'), cat('marketing', '80.00')];
    const may = [level('revenue', null), level('operating_expenses', '0.00')];
    const out = variancesForPeriod({
      period: MAY, allPeriods: [APR, MAY], results: may, computed: new Map([[APR.id, april]]), stored: [], currency: 'GBP', mint,
    });
    const oi = variance(out, 'prev_period', 'other_income');
    expect(oi?.value).toBeNull();
    expect(oi?.components.current).toBeNull();
    expect(oi?.dataQuality.missing).toContain('no_source_covers_period');
    const mk = variance(out, 'prev_period', 'marketing');
    expect(mk?.value).toBe('-80.00');
    expect(mk?.components.current).toBe('0.00');
  });
});

// ---------------------------------------------------------------------------------------------
// F3 — unestablished purchases are out of the whole invoice-basis fold
// ---------------------------------------------------------------------------------------------

describe('F3 · purchases no purchase list establishes never reach other_income, revenue or its quality', () => {
  /*
   * July: a sales list, no purchase list. Sales to Acme 1,000 (VAT 200). Purchase-only cells from a
   * supplier defaulting to OTHER INCOME (Rebates 400) and an uncategorised supplier (Misc 5,000 — five
   * times revenue, far past the uncategorised threshold), both carrying VAT.
   */
  const SALES_CELLS = [invoiceCell(JUL, 'sales', ACME.id, '1000.00', '200.00')];
  const PURCHASE_CELLS = [
    invoiceCell(JUL, 'purchase', REBATES.id, '400.00', '80.00'),
    invoiceCell(JUL, 'purchase', MISC.id, '5000.00', '1000.00'),
  ];
  const strip = (r: MetricResult) => ({ ...r, id: '' });

  it('uncovered: other_income and revenue are exactly what they are without those purchase cells', () => {
    const withPurchases = compose(JUL, [SALES], [...SALES_CELLS, ...PURCHASE_CELLS]);
    const without = compose(JUL, [SALES], SALES_CELLS);
    // other_income stated as it would be without them — the stated zero no sales invoice reaches.
    expect(headline(withPurchases, 'other_income').value).toBe(headline(without, 'other_income').value);
    expect(headline(withPurchases, 'other_income').value).toBe('0.00');
    expect(strip(headline(withPurchases, 'other_income'))).toEqual(strip(headline(without, 'other_income')));
    // Revenue: value, completeness, warnings, missing — identical.
    expect(headline(withPurchases, 'revenue').value).toBe('1000.00');
    expect(strip(headline(withPurchases, 'revenue'))).toEqual(strip(headline(without, 'revenue')));
    expect(headline(withPurchases, 'revenue').dataQuality).toEqual(headline(without, 'revenue').dataQuality);
    // No category row from them either.
    expect(categoryRow(withPurchases, 'expense_by_category', 'other_income')).toEqual(categoryRow(without, 'expense_by_category', 'other_income'));
    // The whole period is as if they were not there.
    expect(withPurchases.map(strip)).toEqual(without.map(strip));
  });

  it('control: with a covering purchase list the same purchases ARE folded', () => {
    const covered = [SALES, purchases('2026-07-01', '2026-07-31')];
    const withPurchases = compose(JUL, covered, [...SALES_CELLS, ...PURCHASE_CELLS]);
    const without = compose(JUL, covered, SALES_CELLS);
    // They move other_income and revenue's quality — the fold F3 must keep for established purchases.
    expect(headline(withPurchases, 'other_income').value).not.toBe(headline(without, 'other_income').value);
    expect(headline(withPurchases, 'revenue').dataQuality).not.toEqual(headline(without, 'revenue').dataQuality);
  });
});

// ---------------------------------------------------------------------------------------------
// F4 — payablesExpenseBase is no base when costs are stated only to date
// ---------------------------------------------------------------------------------------------

describe('F4 · denominatorInputsFor: costs to date are no expense base', () => {
  const BATCHES = [SALES, purchases('2026-07-01', '2026-07-31')];
  const CELLS = [
    invoiceCell(JUL, 'sales', ACME.id, '4000.00'),
    invoiceCell(JUL, 'purchase', PARTS.id, '900.00'),
    invoiceCell(JUL, 'purchase', ADS.id, '300.00'),
  ];
  const results = compose(JUL, BATCHES, CELLS);
  /** The results with `partial_month` added to one headline on the given basis. */
  const toDate = (key: string, basis: MetricResult['basis'] = 'invoices') => results.map((r) => (
    r.key === key && r.dimensionType === 'none'
      ? { ...r, basis, dataQuality: { ...r.dataQuality, warnings: [...r.dataQuality.warnings, 'partial_month' as const] } }
      : r));

  it('control: whole revenue and whole costs — the base is cost of sales + operating expense + marketing', () => {
    expect(headline(results, 'revenue').dataQuality.warnings).not.toContain('partial_month');
    expect(denominatorInputsFor(JUL, results, CELLS, BATCHES).payablesExpenseBase).toBe('1200.00');
  });

  it('revenue whole but cost_of_sales partial_month on the invoices basis: NULL', () => {
    const inputs = denominatorInputsFor(JUL, toDate('cost_of_sales'), CELLS, BATCHES);
    expect(inputs.payablesExpenseBase).toBeNull();
    // Revenue is whole, so it is still stated.
    expect(inputs.revenue).toBe('4000.00');
  });

  it('revenue whole but operating_expenses partial_month on the invoices basis: NULL', () => {
    expect(denominatorInputsFor(JUL, toDate('operating_expenses'), CELLS, BATCHES).payablesExpenseBase).toBeNull();
  });

  it('control: partial_month on another basis does not void the invoice-basis base', () => {
    expect(denominatorInputsFor(JUL, toDate('cost_of_sales', 'ledger'), CELLS, BATCHES).payablesExpenseBase).toBe('1200.00');
  });
});
