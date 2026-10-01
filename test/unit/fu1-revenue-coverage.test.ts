import { describe, expect, it } from 'vitest';

import {
  choosePrecedence, composePeriod, computeCoverage, denominatorInputsFor, ENGINE_VERSION, invoiceSideCoverage, isPeriodComplete,
  type AccountRef, type AggregateCell, type BankAccountRef, type CounterpartyRef, type CoverageBatch,
  type EngineContext, type MetricResult, type PeriodRef,
} from '@/modules/financial-engine';

/**
 * ADR-122 FU-1 — an invoice list must never state revenue for a month it does not cover.
 *
 * The rule: the `invoices` source covers P (P&L and customer families, `is_complete`) only when a
 * committed FULL list of SALES invoices ESTABLISHES P — its declared range spans P, or, when P is the
 * current period, starts on or before P's first day and reaches into it (revenue to date,
 * `partial_month`). Everything else falls through §2.3 unchanged: to the bank (a cash proxy), else
 * NULL with `no_source_covers_period`. Never a zero no list states.
 *
 * Before FU-1, an "AR/AP" branch let ANY invoice batch cover P when it was committed no more than 45
 * days after P's end — which a batch committed BEFORE P also satisfies (the gap is negative), as does
 * every future month. Each such month stated revenue 0.00, calculated and complete. Every NULL
 * asserted below was a 0.00 before this change.
 */

const month = (ym: string): PeriodRef => {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return {
    id: `p-${ym}`, periodStart: `${ym}-01`, periodEnd: `${ym}-${String(last).padStart(2, '0')}`,
    fiscalYear: y, fiscalQuarter: Math.floor((m - 1) / 3) + 1, label: ym, isComplete: false,
  };
};
const FEB = month('2026-02');
const MAR = month('2026-03');
const APR = month('2026-04');
const MAY = month('2026-05');
const JUN = month('2026-06');
const JUL = month('2026-07');
const AUG = month('2026-08');
const SEP = month('2026-09');
const OCT = month('2026-10');
const AUG27 = month('2027-08');

/** The run's as-of: 15 September 2026, so September is the CURRENT period. */
const AS_OF = '2026-09-15';

const account = (id: string, category: AccountRef['standardCategory'], type: AccountRef['accountType']): AccountRef =>
  ({ id, code: null, name: id, standardCategory: category, accountType: type, isSystem: true });
const CHART: AccountRef[] = [
  account('a-rev', 'revenue', 'income'),
  account('a-cos', 'cost_of_sales', 'expense'),
  account('a-opex', 'operating_expense', 'expense'),
  account('a-unc', 'uncategorised', 'asset'),
];
const BANK: BankAccountRef = {
  id: 'ba-1', name: 'Current', accountType: 'current', openingBalance: '1000.00', openingBalanceDate: '2026-01-31', isActive: true,
};
const ACME: CounterpartyRef = { id: 'cp-acme', name: 'Acme', kind: 'customer', mergedIntoId: null, defaultExpenseCategory: null };
const PARTS: CounterpartyRef = { id: 'cp-parts', name: 'Parts', kind: 'supplier', mergedIntoId: null, defaultExpenseCategory: 'cost_of_sales' };

const context = (periods: PeriodRef[], bankAccounts: BankAccountRef[] = []): EngineContext => ({
  organizationId: 'org-1', calculationRunId: 'run-1', aggregatedAt: `${AS_OF}T00:00:00.000Z`, asOf: AS_OF,
  engineVersion: ENGINE_VERSION,
  settings: {
    baseCurrency: 'GBP', fiscalYearStartMonth: 1, timezone: 'Europe/London', vatRegistered: false, defaultVatRate: null,
    taxableCategories: ['revenue', 'cost_of_sales', 'operating_expense', 'marketing'],
  },
  costOfSalesEverUsed: true, costOfSalesInInvoices: false,
  accounts: CHART, counterparties: [ACME, PARTS], bankAccounts, periods,
});

let seq = 0;
const list = (over: Partial<CoverageBatch>): CoverageBatch => ({
  id: `b-${(seq += 1)}`, targetTable: 'invoices', balanceKind: null, balanceBasis: null, bankAccountId: null,
  invoiceListKind: 'full', importType: 'sales_invoices',
  periodStart: '2026-06-01', periodEnd: '2026-08-31', committedAt: '2026-09-10T10:00:00Z', ...over,
});
const statement = (p: PeriodRef): CoverageBatch => ({
  id: `st-${p.id}`, targetTable: 'bank_transactions', balanceKind: null, balanceBasis: null, bankAccountId: BANK.id,
  invoiceListKind: null, importType: 'bank_statement', periodStart: p.periodStart, periodEnd: p.periodEnd,
  committedAt: '2026-09-01T00:00:00Z',
});

/** An invoice aggregate cell: no account, net positive whatever the type (ADR-047.5). */
const invoiceCell = (p: PeriodRef, invoiceType: string, counterpartyId: string, net: string): AggregateCell => ({
  periodId: p.id, source: 'invoices', standardCategory: null, accountId: null, counterpartyId, bankAccountId: null,
  balanceKind: null, balanceBasis: null, invoiceType, transferKind: null, unpairedTransferCandidate: false,
  debit: '0', credit: '0', amount: net, rowCount: 1, fallbackRows: 0, minDate: p.periodStart, maxDate: p.periodEnd,
});
/** A bank receipt categorised as revenue — what a bank-basis (cash proxy) P&L reads. */
const bankReceipt = (p: PeriodRef, inflow: string): AggregateCell => ({
  periodId: p.id, source: 'bank', standardCategory: 'revenue', accountId: 'a-rev', counterpartyId: 'cp-acme',
  bankAccountId: BANK.id, balanceKind: null, balanceBasis: null, invoiceType: null, transferKind: 'none',
  unpairedTransferCandidate: false, debit: inflow, credit: '0', amount: inflow, rowCount: 1, fallbackRows: 0,
  minDate: p.periodStart, maxDate: p.periodEnd,
});

const coverageFor = (
  period: PeriodRef, batches: CoverageBatch[], opts: { asOf?: string; bank?: boolean; rowCounts?: Record<string, number> } = {},
) => computeCoverage({
  period, batches, bankAccounts: opts.bank ? [BANK] : [], rowCounts: opts.rowCounts ?? {}, asOf: opts.asOf ?? AS_OF,
});

const compose = (period: PeriodRef, batches: CoverageBatch[], cells: AggregateCell[], opts: { asOf?: string; bank?: boolean } = {}) =>
  composePeriod({
    period, coverage: coverageFor(period, batches, opts), cells, transferLegs: [],
    context: context([period], opts.bank ? [BANK] : []),
  });

const headline = (results: readonly MetricResult[], key: string): MetricResult | undefined =>
  results.find((r) => r.key === key && r.dimensionType === 'none');
const customerRevenue = (results: readonly MetricResult[]): MetricResult[] =>
  results.filter((r) => r.key === 'customer_revenue');

/** Asserts P's revenue is NULL for want of a source — not 0.00. */
function expectNoRevenue(results: readonly MetricResult[]): void {
  const revenue = headline(results, 'revenue');
  expect(revenue?.value, 'a month no source covers must not state revenue 0.00').toBeNull();
  expect(revenue?.basis).toBe('none');
  expect(revenue?.dataQuality.missing).toContain('no_source_covers_period');
  expect(revenue?.dataQuality.warnings).not.toContain('open_items_only');
  // The whole family goes with it (§2.3): no profit, no cost line from a list that states no month.
  expect(headline(results, 'net_profit')?.value ?? null).toBeNull();
  expect(headline(results, 'operating_expenses')?.value ?? null).toBeNull();
  // And the customer family: no customer figure, no concentration of nothing.
  expect(customerRevenue(results).every((r) => r.value === null)).toBe(true);
  expect(headline(results, 'customer_concentration_top1')?.value ?? null).toBeNull();
}

// A full SALES list declared 1 June – 31 August, committed 10 September; July carries £4,000 of sales
// and £900 of purchases, August none at all.
const SALES_JUN_AUG = list({});
const CELLS = [
  invoiceCell(JUL, 'sales', ACME.id, '4000.00'),
  invoiceCell(JUL, 'purchase', PARTS.id, '900.00'),
];

describe('a full sales list establishes the months its range spans (R1, R3)', () => {
  it('states the month’s revenue from the list', () => {
    const coverage = coverageFor(JUL, [SALES_JUN_AUG]);
    expect(coverage.bySource.invoices).toEqual({ covers: true, warnings: [], completeness: 1 });

    const results = compose(JUL, [SALES_JUN_AUG], CELLS);
    const revenue = headline(results, 'revenue')!;
    expect(revenue.value).toBe('4000.00');
    expect(revenue.basis).toBe('invoices');
    expect(revenue.assurance).toBe('calculated');
    expect(revenue.dataQuality.missing).toEqual([]);
    expect(revenue.dataQuality.warnings).not.toContain('partial_month');
    // FU-12: a sales list states the month's revenue and nothing about its purchases, so with no
    // purchase list the cost side is unknown — not the £900 of purchase invoices nobody established.
    expect(headline(results, 'cost_of_sales')?.value).toBeNull();
    expect(headline(results, 'cost_of_sales')?.dataQuality.missing).toEqual(['no_source_covers_period']);
    expect(headline(results, 'net_profit')?.value).toBeNull();
    expect(results.find((r) => r.key === 'customer_revenue' && r.dimensionId === ACME.id)?.value).toBe('4000.00');
    // With a full purchase list over the same range, the costs and profit are stated exactly.
    const withPurchases = [SALES_JUN_AUG, list({ importType: 'purchase_invoices' })];
    const stated = compose(JUL, withPurchases, CELLS);
    expect(headline(stated, 'cost_of_sales')?.value).toBe('900.00');
    expect(headline(stated, 'net_profit')?.value).toBe('3100.00');
  });

  it('keeps a genuine £0: a spanned month with no sales states 0.00, with nothing missing', () => {
    // The list says every invoice from June to August is on it, and none is dated August. That IS a
    // statement that August's sales were nil — the one zero FU-1 must keep.
    const results = compose(AUG, [SALES_JUN_AUG], CELLS);
    const revenue = headline(results, 'revenue')!;
    expect(revenue.value).toBe('0.00');
    expect(revenue.basis).toBe('invoices');
    expect(revenue.dataQuality.missing).toEqual([]);
    expect(revenue.dataQuality.warnings).not.toContain('open_items_only');
  });

  it('an upload date is not coverage — but a list knows nothing after the day it was committed', () => {
    // Committed after the month (days or a year later): its range states the month.
    for (const committedAt of ['2026-08-02T00:00:00Z', '2026-09-10T10:00:00Z', '2027-09-30T00:00:00Z']) {
      expect(coverageFor(JUL, [list({ committedAt })]).bySource.invoices.covers, committedAt).toBe(true);
    }
    // Committed BEFORE July, or partway through it: the declared range reaches past what the list could
    // have seen, so July is not stated (review blocker: once the month was over, such a list "spanned"
    // it and stated its first days — or 0.00 — as the whole month).
    for (const committedAt of ['2026-05-02T00:00:00Z', '2026-07-20T00:00:00Z']) {
      expect(coverageFor(JUL, [list({ committedAt })]).bySource.invoices.covers, committedAt).toBe(false);
      expectNoRevenue(compose(JUL, [list({ committedAt })], CELLS));
    }
    // A sales REPORT is a sales list too.
    expect(coverageFor(JUL, [list({ importType: 'sales_report' })]).bySource.invoices.covers).toBe(true);
  });

  it('lists that meet combine, as statements do: 1–15 July and 16–31 July state July', () => {
    const halves = [list({ periodStart: '2026-07-01', periodEnd: '2026-07-15' }), list({ periodStart: '2026-07-16', periodEnd: '2026-07-31' })];
    expect(coverageFor(JUL, halves).bySource.invoices).toEqual({ covers: true, warnings: [], completeness: 1 });
    // A day missing between them: July is not stated.
    const holed = [list({ periodStart: '2026-07-01', periodEnd: '2026-07-14' }), list({ periodStart: '2026-07-16', periodEnd: '2026-07-31' })];
    expect(coverageFor(JUL, holed).bySource.invoices.covers).toBe(false);
  });

  it('makes a spanned completed month complete from the list alone', () => {
    const coverage = coverageFor(JUL, [SALES_JUN_AUG]);
    expect(coverage.latestDataDate.invoices).toBe('2026-08-31');
    expect(isPeriodComplete(coverage, JUL, [])).toBe(true);
  });
});

describe('a list does not state a month its range does not span (R1, R2)', () => {
  it('a month BEFORE the list’s range: NULL, not 0.00', () => {
    // Pre-FU-1: committed 10 Sep, 102 days after May's end — rejected by the gate, as it should be.
    expectNoRevenue(compose(MAY, [SALES_JUN_AUG], CELLS));
  });

  it('a month AFTER the list’s range: NULL, not 0.00', () => {
    // Pre-FU-1: October's end is 31 Oct; the list was committed 10 Sep, a gap of −51 days, "within
    // 45" — so October stated revenue 0.00 with open_items_only.
    const coverage = coverageFor(OCT, [SALES_JUN_AUG]);
    expect(coverage.bySource.invoices).toEqual({ covers: false, warnings: [], completeness: 0 });
    expectNoRevenue(compose(OCT, [SALES_JUN_AUG], CELLS));
  });

  it('a month a year out: NULL, not 0.00', () => {
    // Pre-FU-1: every future month was "within 45 days" of a list committed before it.
    expectNoRevenue(compose(AUG27, [SALES_JUN_AUG], CELLS));
  });

  it('falls through to the bank when a statement covers the month (a cash proxy, as §2.3 says)', () => {
    const batches = [SALES_JUN_AUG, statement(OCT)];
    const coverage = coverageFor(OCT, batches, { bank: true });
    expect(choosePrecedence(coverage, 'pnl').basis).toBe('bank');
    expect(choosePrecedence(coverage, 'counterparty').basis).toBe('bank');

    const results = compose(OCT, batches, [...CELLS, bankReceipt(OCT, '2500.00')], { bank: true });
    const revenue = headline(results, 'revenue')!;
    expect(revenue.value).toBe('2500.00');
    expect(revenue.basis).toBe('bank');
    expect(revenue.assurance).toBe('estimated');
    expect(revenue.dataQuality.warnings).toEqual(expect.arrayContaining(['cash_basis_proxy', 'vat_inclusive']));
    expect(revenue.dataQuality.warnings).not.toContain('open_items_only');
  });

  it('a list committed DURING a completed month whose range stops short of its end: NULL', () => {
    // Declared 1 June – 20 July, committed 20 July; July is completed on 15 September. The list knows
    // nothing after the 20th. Pre-FU-1: gap −11 days → July stated the first 20 days as the month.
    const stopsShort = list({ periodEnd: '2026-07-20', committedAt: '2026-07-20T12:00:00Z' });
    const coverage = coverageFor(JUL, [stopsShort]);
    expect(coverage.bySource.invoices.covers).toBe(false);
    expectNoRevenue(compose(JUL, [stopsShort], CELLS));
    // June, which it spans, is still stated.
    expect(coverageFor(JUN, [stopsShort]).bySource.invoices.covers).toBe(true);
  });

  it('a list committed BEFORE the month (the negative-gap bug, BSREV): NULL', () => {
    // Declared for March, committed 5 April. Pre-FU-1: April (gap −25), May, June … (all negative or
    // within 45) and February (gap 36) all stated revenue 0.00 with open_items_only.
    const march = list({ periodStart: '2026-03-01', periodEnd: '2026-03-31', committedAt: '2026-04-05T09:00:00Z' });
    const marchSales = [invoiceCell(MAR, 'sales', ACME.id, '3000.00')];
    for (const p of [FEB, APR, MAY, JUN, AUG]) {
      expect(coverageFor(p, [march]).bySource.invoices.covers, p.label).toBe(false);
      expectNoRevenue(compose(p, [march], marchSales));
    }
    expect(headline(compose(MAR, [march], marchSales), 'revenue')?.value).toBe('3000.00');
  });

  it('a month the invoices source does not cover is not complete on its account', () => {
    const coverage = coverageFor(OCT, [SALES_JUN_AUG]);
    expect(choosePrecedence(coverage, 'pnl').basis).toBe('none');
    expect(isPeriodComplete(coverage, OCT, [])).toBe(false);
  });
});

describe('only a FULL SALES list establishes revenue (R1, ADR-047.10)', () => {
  it('a purchase-only full list spanning the month does not cover it', () => {
    // It states costs, never sales: revenue from it would be a zero no list states.
    const purchases = list({ importType: 'purchase_invoices' });
    const coverage = coverageFor(JUL, [purchases]);
    expect(coverage.bySource.invoices).toEqual({ covers: false, warnings: [], completeness: 0 });
    expect(coverage.latestDataDate.invoices).toBeUndefined();
    expectNoRevenue(compose(JUL, [purchases], CELLS));
  });

  it('an open-items (aged-debtors) sales list spanning the month does not cover it', () => {
    const openItems = list({ invoiceListKind: 'open_items' });
    const coverage = coverageFor(JUL, [openItems]);
    expect(coverage.bySource.invoices).toEqual({ covers: false, warnings: [], completeness: 0 });
    expect(coverage.latestDataDate.invoices).toBeUndefined();
    expectNoRevenue(compose(JUL, [openItems], CELLS));
  });

  it('a list of unknown side or kind does not cover it', () => {
    expect(coverageFor(JUL, [list({ importType: null })]).bySource.invoices.covers).toBe(false);
    expect(coverageFor(JUL, [list({ importType: undefined })]).bySource.invoices.covers).toBe(false);
    expect(coverageFor(JUL, [list({ invoiceListKind: null })]).bySource.invoices.covers).toBe(false);
  });

  it('dates the invoices source by its full sales lists only', () => {
    const coverage = coverageFor(JUL, [
      SALES_JUN_AUG,
      list({ importType: 'purchase_invoices', periodEnd: '2026-11-30' }),
      list({ invoiceListKind: 'open_items', periodEnd: '2026-12-31' }),
    ]);
    expect(coverage.latestDataDate.invoices).toBe('2026-08-31');
  });

  it('leaves the AR/AP side coverage exactly as it was (ADR-124 D-3 is not FU-1’s to change)', () => {
    // An open-items sales list dated at July's end, committed 2 August: it states July's receivables
    // (fresh, at the month end) while stating no revenue at all.
    const openItems = list({ invoiceListKind: 'open_items', periodStart: '2026-07-31', periodEnd: '2026-07-31', committedAt: '2026-08-02T00:00:00Z' });
    expect(invoiceSideCoverage([openItems], JUL, 'sales').covers).toBe(true);
    expect(coverageFor(JUL, [openItems]).bySource.invoices.covers).toBe(false);
    // And a purchase list still covers payables.
    expect(invoiceSideCoverage([list({ importType: 'purchase_invoices' })], JUL, 'purchase').covers).toBe(true);
  });
});

describe('the current month is stated to date, never as a whole month (R1)', () => {
  // The CURRENT audit org: a full sales list declared 1 June – 10 September, committed 10 September,
  // run as of 15 September. September's sales so far are £500.
  const toSep10 = list({ periodEnd: '2026-09-10' });
  const sepCells = [invoiceCell(SEP, 'sales', ACME.id, '500.00')];

  it('covers the current month as revenue to date: partial_month, 10 of 30 days', () => {
    const coverage = coverageFor(SEP, [toSep10]);
    expect(coverage.bySource.invoices).toEqual({ covers: true, warnings: ['partial_month'], completeness: 10 / 30 });

    const results = compose(SEP, [toSep10], sepCells);
    const revenue = headline(results, 'revenue')!;
    expect(revenue.value).toBe('500.00');
    expect(revenue.basis).toBe('invoices');
    expect(revenue.dataQuality.warnings).toContain('partial_month');
    expect(revenue.dataQuality.warnings).not.toContain('open_items_only');
  });

  it('measures the share from the furthest-reaching list', () => {
    const at15 = { committedAt: '2026-09-15T08:00:00Z' };
    const coverage = coverageFor(SEP, [list({ ...at15, periodEnd: '2026-09-03' }), list({ ...at15, periodEnd: '2026-09-12' })]);
    expect(coverage.bySource.invoices.completeness).toBe(12 / 30);
    // In either order.
    expect(coverageFor(SEP, [list({ ...at15, periodEnd: '2026-09-12' }), list({ ...at15, periodEnd: '2026-09-03' })]).bySource.invoices.completeness).toBe(12 / 30);
    // A list committed on the 10th has seen ten days, whatever it declares.
    expect(coverageFor(SEP, [list({ periodEnd: '2026-09-12' })]).bySource.invoices.completeness).toBe(10 / 30);
    // A list ending on the month's first day reaches one day into it.
    expect(coverageFor(SEP, [list({ periodEnd: '2026-09-01' })]).bySource.invoices.completeness).toBe(1 / 30);
  });

  it('is not complete: the list reaches the 10th, not the month end', () => {
    const coverage = coverageFor(SEP, [toSep10]);
    expect(coverage.latestDataDate.invoices).toBe('2026-09-10');
    expect(isPeriodComplete(coverage, SEP, [])).toBe(false);
  });

  it('a list declared to the current month\'s end still states it only to date — days not yet lived are in no list', () => {
    // As of 15 September a list "declared" to 30 September has seen fifteen days (review finding: a
    // declared range past the as-of stated revenue for days that had not happened, as complete).
    const coverage = coverageFor(SEP, [list({ periodEnd: '2026-09-30', committedAt: '2026-09-15T08:00:00Z' })]);
    expect(coverage.bySource.invoices).toEqual({ covers: true, warnings: ['partial_month'], completeness: 15 / 30 });
    // And the month is not complete on it: the list's data reaches today, not the month's end (review).
    expect(coverage.latestDataDate.invoices).toBe('2026-09-15');
    expect(isPeriodComplete(coverage, SEP, [])).toBe(false);
    // Once the as-of and the list both reach the month's last day, the month is covered as a whole.
    const lastDay = coverageFor(SEP, [list({ periodEnd: '2026-09-30', committedAt: '2026-09-30T18:00:00Z' })], { asOf: '2026-09-30' });
    expect(lastDay.bySource.invoices).toEqual({ covers: true, warnings: [], completeness: 1 });
  });

  it('never covers a month that has not begun, whatever range a list declares (no future zeros)', () => {
    const intoTheFuture = list({ periodEnd: '2026-12-31' });
    expect(coverageFor(OCT, [intoTheFuture]).bySource.invoices.covers).toBe(false);
    expectNoRevenue(compose(OCT, [intoTheFuture], CELLS));
  });

  it('does not cover the current month from a list that starts inside it, or ends before it', () => {
    // Revenue from the 5th only would under-state the month to date without saying so.
    expect(coverageFor(SEP, [list({ periodStart: '2026-09-05', periodEnd: '2026-09-12' })]).bySource.invoices.covers).toBe(false);
    // Pre-FU-1: a list ending 31 August, committed 10 September, "covered" September with 0.00.
    expect(coverageFor(SEP, [SALES_JUN_AUG]).bySource.invoices.covers).toBe(false);
    expectNoRevenue(compose(SEP, [SALES_JUN_AUG], CELLS));
    // Nor from a purchase list reaching into it.
    expect(coverageFor(SEP, [list({ importType: 'purchase_invoices', periodEnd: '2026-09-10' })]).bySource.invoices.covers).toBe(false);
  });

  it('does not treat the same month as current once the as-of has left it', () => {
    // Run as of 5 October, September is completed: a list reaching only the 10th does not state it.
    const coverage = coverageFor(SEP, [toSep10], { asOf: '2026-10-05' });
    expect(coverage.bySource.invoices.covers).toBe(false);
    expectNoRevenue(compose(SEP, [toSep10], sepCells, { asOf: '2026-10-05' }));
    // And a month before the as-of's month is never "current", however close.
    expect(coverageFor(AUG, [list({ periodEnd: '2026-08-20' })], { asOf: '2026-09-01' }).bySource.invoices.covers).toBe(false);
    // The as-of on the current month's first and last day both count.
    expect(coverageFor(SEP, [toSep10], { asOf: '2026-09-01' }).bySource.invoices.covers).toBe(true);
    expect(coverageFor(SEP, [toSep10], { asOf: '2026-09-30' }).bySource.invoices.covers).toBe(true);
  });

  it('keeps revenue to date out of the DSO denominator (receivables_days)', () => {
    // A few days of sales divided into a quarter's receivables would overstate the days; before FU-1
    // this month's revenue was a flagged 0.00 and equally unknown here.
    const results = compose(SEP, [toSep10], sepCells);
    expect(denominatorInputsFor(SEP, results, sepCells, [toSep10]).revenue).toBeNull();
    // Nor the other flows of that month to date: the list's own sales total and the expense base
    // (a list declared to the month's end, so the AR/AP "full list spans" test would otherwise pass).
    const toSep30 = list({ periodEnd: '2026-09-30', committedAt: '2026-09-15T08:00:00Z' });
    const toDate = denominatorInputsFor(SEP, compose(SEP, [toSep30], sepCells), sepCells, [toSep30]);
    expect([toDate.revenue, toDate.invoiceSalesTotal, toDate.payablesExpenseBase]).toEqual([null, null, null]);
    // A month the list spans still feeds its revenue in.
    const july = compose(JUL, [SALES_JUN_AUG], CELLS);
    expect(denominatorInputsFor(JUL, july, CELLS, [SALES_JUN_AUG]).revenue).toBe('4000.00');
  });
});
