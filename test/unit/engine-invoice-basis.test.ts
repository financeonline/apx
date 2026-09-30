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
  costOfSalesInInvoices: false,
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
    // FU-1: only a list of SALES invoices establishes revenue, so the fixture says what its docstring
    // always meant. Without the side the list states no revenue and every figure below would be NULL.
    importType: 'sales_invoices',
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
        costOfSalesInInvoices: false,
        counterparties: [customer('cp-beta'), supplier('cp-parts', 'cost_of_sales')],
      }),
    });
    expect(valueOf(results, 'revenue')).toBe('3000.00');
    expect(find(results, 'revenue')!.dataQuality.warnings).toContain('uncategorised_amounts');
  });
});

describe('evidence on the invoice basis re-selects the rows behind THAT figure (ADR-104)', () => {
  /*
   * Two suppliers in two categories. Before ADR-104 every expense figure carried the same
   * descriptor — "all purchases this period" — so drilling into cost of sales listed marketing too.
   */
  const results = composePeriod({
    period: may,
    coverage: invoiceCoverage(),
    cells: [
      invoiceCell('sales', 'cp-beta', '10000.00'),
      invoiceCell('purchase', 'cp-stock', '3000.00'),
      invoiceCell('purchase', 'cp-ads', '1000.00'),
    ],
    transferLegs: [],
    context: context({
      accounts: [...CHART, account('a-mkt', 'marketing', 'expense')],
      counterparties: [customer('cp-beta'), supplier('cp-stock', 'cost_of_sales'), supplier('cp-ads', 'marketing')],
    }),
  });
  const descriptorOf = (key: string, dimensionKey: string | null = null) => {
    const row = results.find((r) => r.key === key && (dimensionKey === null ? r.dimensionType === 'none' : r.dimensionKey === dimensionKey));
    const q = row?.evidenceQuery;
    return q && q.kind === 'leaf' ? q.descriptor.filters : q ?? null;
  };

  it('names only the cost-of-sales suppliers behind cost of sales', () => {
    expect(descriptorOf('cost_of_sales')).toEqual({
      period_ids: [may.id], invoice_types: ['purchase', 'purchase_credit_note'], counterparty_ids: ['cp-stock'],
    });
  });

  it('names only the marketing suppliers behind the marketing category', () => {
    expect(descriptorOf('expense_by_category', 'marketing')).toMatchObject({ counterparty_ids: ['cp-ads'] });
    expect(descriptorOf('operating_expenses')).toMatchObject({ counterparty_ids: ['cp-ads'] });
  });

  it('leaves revenue on the sales types, which are exactly the figure', () => {
    expect(descriptorOf('revenue')).toEqual({ period_ids: [may.id], invoice_types: ['sales', 'sales_credit_note'] });
  });

  it('gives a figure nobody’s purchases went into no descriptor rather than one that re-selects every purchase', () => {
    const onlySales = composePeriod({
      period: may, coverage: invoiceCoverage(), transferLegs: [],
      cells: [invoiceCell('sales', 'cp-beta', '10000.00')],
      context: context({ counterparties: [customer('cp-beta')], costOfSalesEverUsed: true }),
    });
    const cos = onlySales.find((r) => r.key === 'cost_of_sales' && r.dimensionType === 'none')!;
    expect(cos.value).toBe('0.00');
    expect(cos.evidenceQuery).toBeNull();
  });
});

describe('cost of sales that lives only in invoices does not become a zero on another basis (ADR-104)', () => {
  const ledgerCoverage = () => computeCoverage({
    period: may,
    batches: [{
      id: 'b-gl', targetTable: 'ledger_entries', balanceKind: null, balanceBasis: null,
      bankAccountId: null, invoiceListKind: null,
      periodStart: '2026-05-01', periodEnd: '2026-05-31', committedAt: '2026-06-02T00:00:00Z',
    }],
    bankAccounts: [], rowCounts: { ledger: 1 }, asOf: '2026-06-15',
  });
  const ledgerRevenue: AggregateCell = {
    periodId: may.id, source: 'ledger', standardCategory: 'revenue', accountId: 'a-rev',
    counterpartyId: null, bankAccountId: null, balanceKind: null, balanceBasis: null,
    invoiceType: null, transferKind: null, unpairedTransferCandidate: false,
    debit: '0', credit: '9000.00', amount: '-9000.00', rowCount: 1, fallbackRows: 0,
    minDate: '2026-05-31', maxDate: '2026-05-31',
  };

  it('on the ledger basis, reports cost of sales as unavailable with the reason, and no 100% margin', () => {
    const results = composePeriod({
      period: may, coverage: ledgerCoverage(), transferLegs: [],
      cells: [ledgerRevenue, invoiceCell('purchase', 'cp-stock', '2500.00')],
      context: context({
        costOfSalesEverUsed: false, costOfSalesInInvoices: true,
        counterparties: [supplier('cp-stock', 'cost_of_sales')],
      }),
    });
    const cos = find(results, 'cost_of_sales')!;
    expect(cos.value).toBeNull();
    expect(cos.dataQuality.missing).toEqual(['cost_of_sales_in_other_source']);
    expect(valueOf(results, 'gross_margin')).toBeNull();
    expect(find(results, 'gross_profit')!.dataQuality.warnings).toContain('no_cost_of_sales');
  });

  it('on the invoice basis, the same evidence IS the cost of sales', () => {
    const results = composePeriod({
      period: may, coverage: invoiceCoverage(), transferLegs: [],
      cells: [invoiceCell('sales', 'cp-beta', '9000.00'), invoiceCell('purchase', 'cp-stock', '2500.00')],
      context: context({
        costOfSalesEverUsed: false, costOfSalesInInvoices: true,
        counterparties: [customer('cp-beta'), supplier('cp-stock', 'cost_of_sales')],
      }),
    });
    expect(valueOf(results, 'cost_of_sales')).toBe('2500.00');
    expect(valueOf(results, 'gross_profit')).toBe('6500.00');
  });

  it('with no cost-of-sales evidence anywhere, still says there are no such accounts', () => {
    const results = composePeriod({
      period: may, coverage: ledgerCoverage(), transferLegs: [],
      cells: [ledgerRevenue],
      context: context({ costOfSalesEverUsed: false, costOfSalesInInvoices: false }),
    });
    expect(find(results, 'cost_of_sales')!.dataQuality.missing).toEqual(['no_cost_of_sales_accounts']);
  });
});
