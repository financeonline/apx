import { describe, expect, it } from 'vitest';
import { Decimal } from '@/core/money';

import {
  composePeriod, computeCoverage, ENGINE_VERSION,
  type AggregateCell, type AccountRef, type CounterpartyRef, type EngineContext, type PeriodRef,
} from '@/modules/financial-engine';

/**
 * The invoice basis, golden (FINANCIAL_ENGINE.md §2.1, §3, §3.5; ADR-103).
 *
 * An invoice header has no account. The aggregate says so — `account_id` and `standard_category`
 * arrive NULL — and until this fold existed the P&L walked accounts, found none, and reported a
 * COVERED ZERO: revenue £0 with every penny of the month counted as uncategorised, while
 * `customer_revenue` (which reads `invoice_type` directly) stayed correct. Every assertion below
 * fails against that behaviour, which is what makes this a golden test rather than a restatement.
 *
 * The numbers are hand-computed in the case comments, to the penny.
 */

const may: PeriodRef = {
  id: 'p-may', periodStart: '2026-05-01', periodEnd: '2026-05-31',
  fiscalYear: 2026, fiscalQuarter: 2, label: 'May 2026', isComplete: true,
};

const account = (
  id: string, category: AccountRef['standardCategory'], type: AccountRef['accountType'],
): AccountRef => ({ id, code: null, name: id, standardCategory: category, accountType: type, isSystem: true });

/** The system chart every organisation is created with, trimmed to the categories in play. */
const CHART: AccountRef[] = [
  account('a-rev', 'revenue', 'income'),
  account('a-cos', 'cost_of_sales', 'expense'),
  account('a-opex', 'operating_expense', 'expense'),
  account('a-unc', 'uncategorised', 'asset'),
];

const customer = (id: string): CounterpartyRef =>
  ({ id, name: id, kind: 'customer', mergedIntoId: null, defaultExpenseCategory: null });
const supplier = (id: string, category: CounterpartyRef['defaultExpenseCategory']): CounterpartyRef =>
  ({ id, name: id, kind: 'supplier', mergedIntoId: null, defaultExpenseCategory: category });

const context = (over: Partial<EngineContext> = {}): EngineContext => ({
  organizationId: 'org-1',
  calculationRunId: 'run-1',
  aggregatedAt: '2026-06-01T00:00:00.000Z',
  asOf: '2026-06-15',
  engineVersion: ENGINE_VERSION,
  settings: {
    baseCurrency: 'GBP', fiscalYearStartMonth: 1, timezone: 'Europe/London',
    vatRegistered: true, defaultVatRate: '0.20',
    taxableCategories: ['revenue', 'cost_of_sales', 'operating_expense', 'marketing'],
  },
  costOfSalesEverUsed: true,
  accounts: CHART,
  counterparties: [],
  bankAccounts: [],
  periods: [may],
  ...over,
});

/**
 * One aggregate cell as `app.aggregate_periods` emits it for invoices: no account, no category, the
 * net already computed by `app.invoice_net` and POSITIVE whatever the type (ADR-047.5).
 */
const invoiceCell = (
  invoiceType: string, counterpartyId: string | null, net: string,
  over: { rowCount?: number; fallbackRows?: number; tax?: string } = {},
): AggregateCell => ({
  periodId: may.id, source: 'invoices', standardCategory: null, accountId: null,
  counterpartyId, bankAccountId: null, balanceKind: null, balanceBasis: null,
  invoiceType, transferKind: null, unpairedTransferCandidate: false,
  debit: over.tax ?? '0', credit: '0', amount: net,
  rowCount: over.rowCount ?? 1, fallbackRows: over.fallbackRows ?? 0,
  minDate: '2026-05-04', maxDate: '2026-05-28',
});

/** A committed FULL sales-invoice list spanning the month — what §2.2 requires of the revenue family. */
const invoiceCoverage = () => computeCoverage({
  period: may,
  batches: [{
    id: 'b-inv', targetTable: 'invoices', balanceKind: null, balanceBasis: null,
    bankAccountId: null, invoiceListKind: 'full',
    periodStart: '2026-05-01', periodEnd: '2026-05-31', committedAt: '2026-06-02T00:00:00Z',
  }],
  bankAccounts: [], rowCounts: { invoices: 6 }, asOf: '2026-06-15',
});

const find = (results: ReturnType<typeof composePeriod>, key: string) =>
  results.find((r) => r.key === key && r.dimensionType === 'none') ?? null;
const valueOf = (results: ReturnType<typeof composePeriod>, key: string) => find(results, key)?.value ?? null;
const customerRevenue = (results: ReturnType<typeof composePeriod>, id: string | null) =>
  results.find((r) => r.key === 'customer_revenue' && r.dimensionId === id)?.value ?? null;

describe('a month of invoices produces a profit and loss (§2.1, ADR-103)', () => {
  /*
   * Acme  £6,000 sales, less a £500 credit note  → £5,500
   * Beta  £2,000 sales                           → £2,000
   * Parts £900 purchase, supplier's default category is cost_of_sales
   *
   * revenue        = 6,000 − 500 + 2,000 = 7,500.00
   * cost_of_sales  =                         900.00
   * gross_profit   = 7,500 − 900         = 6,600.00
   * net_profit     =                       6,600.00   (nothing below the line)
   */
  const cells = [
    invoiceCell('sales', 'cp-acme', '6000.00', { rowCount: 2, tax: '1200.00' }),
    invoiceCell('sales_credit_note', 'cp-acme', '500.00', { tax: '100.00' }),
    invoiceCell('sales', 'cp-beta', '2000.00', { tax: '400.00' }),
    invoiceCell('purchase', 'cp-parts', '900.00', { tax: '180.00' }),
  ];
  const ctx = context({
    counterparties: [customer('cp-acme'), customer('cp-beta'), supplier('cp-parts', 'cost_of_sales')],
  });
  const results = composePeriod({
    period: may, coverage: invoiceCoverage(), cells, transferLegs: [], context: ctx,
  });

  it('reports revenue net of tax and of credit notes, not a covered zero', () => {
    expect(valueOf(results, 'revenue')).toBe('7500.00');
    expect(find(results, 'revenue')?.basis).toBe('invoices');
  });

  it('puts a purchase in the supplier’s own expense category, and profits follow', () => {
    expect(valueOf(results, 'cost_of_sales')).toBe('900.00');
    expect(valueOf(results, 'gross_profit')).toBe('6600.00');
    expect(valueOf(results, 'net_profit')).toBe('6600.00');
  });

  it('raises no uncategorised warning when every invoice has a home', () => {
    const revenue = find(results, 'revenue')!;
    expect(revenue.dataQuality.warnings).not.toContain('uncategorised_amounts');
    expect(revenue.dataQuality.missing).not.toContain('uncategorised_amounts_exceed_threshold');
    expect(revenue.assurance).toBe('calculated');
  });

  it('reconciles: Σ customer_revenue + unattributed = revenue, with credit notes subtracted', () => {
    expect(customerRevenue(results, 'cp-acme')).toBe('5500.00');
    expect(customerRevenue(results, 'cp-beta')).toBe('2000.00');
    expect(customerRevenue(results, null)).toBe('0.00');
    const sum = ['cp-acme', 'cp-beta', null]
      .reduce((acc, id) => acc.plus(customerRevenue(results, id) ?? '0'), new Decimal(0));
    expect(sum.toFixed(2)).toBe(valueOf(results, 'revenue'));
  });

  it('measures concentration against a revenue that exists', () => {
    // 5,500 / 7,500 = 0.733333 for the top customer; both customers are the top five.
    expect(valueOf(results, 'customer_concentration_top1')).toBe('0.733333');
    expect(valueOf(results, 'customer_concentration_top5')).toBe('1.000000');
  });
});

describe('what nobody has categorised is reported as uncategorised, never guessed (§3.1)', () => {
  /*
   * revenue 2,000; purchases 1,000 from a supplier with NO default expense category.
   * uncategorised share of |revenue| = 1,000 / 2,000 = 50% → past both thresholds.
   */
  const results = composePeriod({
    period: may,
    coverage: invoiceCoverage(),
    cells: [
      invoiceCell('sales', 'cp-beta', '2000.00'),
      invoiceCell('purchase', 'cp-misc', '1000.00'),
    ],
    transferLegs: [],
    context: context({ counterparties: [customer('cp-beta'), supplier('cp-misc', null)] }),
  });

  it('still reports the revenue it knows', () => {
    expect(valueOf(results, 'revenue')).toBe('2000.00');
  });

  it('parks the purchase in uncategorised and says the figure is only an estimate', () => {
    const revenue = find(results, 'revenue')!;
    expect(revenue.dataQuality.warnings).toContain('uncategorised_amounts');
    expect(revenue.dataQuality.missing).toContain('uncategorised_amounts_exceed_threshold');
    expect(revenue.assurance).toBe('estimated');
    expect(valueOf(results, 'cost_of_sales')).toBe('0.00');
  });
});

describe('a VAT-inclusive list is flagged, not silently believed (§3)', () => {
  it('warns when any row fell back to the gross total, and estimates past a tenth of rows', () => {
    const results = composePeriod({
      period: may,
      coverage: invoiceCoverage(),
      cells: [invoiceCell('sales', 'cp-beta', '2400.00', { rowCount: 4, fallbackRows: 1 })],
      transferLegs: [],
      context: context({ counterparties: [customer('cp-beta')] }),
    });
    const revenue = find(results, 'revenue')!;
    expect(valueOf(results, 'revenue')).toBe('2400.00');
    expect(revenue.dataQuality.warnings).toContain('vat_inclusive');
    expect(revenue.assurance).toBe('estimated');
  });

  it('says nothing when every row carried its own tax', () => {
    const results = composePeriod({
      period: may,
      coverage: invoiceCoverage(),
      cells: [invoiceCell('sales', 'cp-beta', '2400.00', { rowCount: 4, fallbackRows: 0 })],
      transferLegs: [],
      context: context({ counterparties: [customer('cp-beta')] }),
    });
    expect(find(results, 'revenue')!.dataQuality.warnings).not.toContain('vat_inclusive');
    expect(find(results, 'revenue')!.assurance).toBe('calculated');
  });
});

describe('a chart missing the category still reports the money', () => {
  it('falls back to uncategorised rather than dropping a purchase out of the P&L', () => {
    const chartWithoutCostOfSales = CHART.filter((a) => a.standardCategory !== 'cost_of_sales');
    const results = composePeriod({
      period: may,
      coverage: invoiceCoverage(),
      cells: [
        invoiceCell('sales', 'cp-beta', '3000.00'),
        invoiceCell('purchase', 'cp-parts', '400.00'),
      ],
      transferLegs: [],
      context: context({
        accounts: chartWithoutCostOfSales,
        costOfSalesEverUsed: false,
        counterparties: [customer('cp-beta'), supplier('cp-parts', 'cost_of_sales')],
      }),
    });
    expect(valueOf(results, 'revenue')).toBe('3000.00');
    expect(find(results, 'revenue')!.dataQuality.warnings).toContain('uncategorised_amounts');
  });
});
