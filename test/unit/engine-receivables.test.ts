import { describe, expect, it } from 'vitest';

import { parseQueryDescriptor } from '@/modules/evidence';
import {
  DAYS_PER_QUARTER,
  computeReceivables,
  type AgingInvoice,
  type BasisChoice,
  type CategoryBalanceFallback,
  type EngineContext,
  type MetricResult,
  type PeriodMetrics,
  type PeriodRef,
  type ReceivablesPeriodInput,
} from '@/modules/financial-engine';

/**
 * Receivables, payables and working capital (FINANCIAL_ENGINE.md §3.4).
 *
 * Every edge case §3.4 lists has a test named after the behaviour it defends, because each of them
 * is a way a plausible-looking number can be wrong: an invoice paid next month counted as paid this
 * month, a DSO computed against a VAT-exclusive denominator, a working capital figure that quietly
 * treats an unseen inventory balance as nil.
 */

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

const RUN_ID = uuid(9001);
const AGGREGATED_AT = '2026-09-05T09:00:00Z';
const AR_ACCOUNT = uuid(51);
const AP_ACCOUNT = uuid(52);

function period(index: number): PeriodRef {
  const month = index % 12;
  const year = 2025 + Math.floor(index / 12);
  const mm = String(month + 1).padStart(2, '0');
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return {
    id: uuid(200 + index),
    periodStart: `${year}-${mm}-01`,
    periodEnd: `${year}-${mm}-${String(lastDay).padStart(2, '0')}`,
    fiscalYear: year,
    fiscalQuarter: Math.floor(month / 3) + 1,
    label: `M${index}`,
    isComplete: true,
  };
}

function context(overrides: Partial<EngineContext['settings']> = {}): EngineContext {
  return {
    organizationId: uuid(1000),
    calculationRunId: RUN_ID,
    aggregatedAt: AGGREGATED_AT,
    asOf: '2026-09-05',
    engineVersion: '1.0.0',
    settings: {
      baseCurrency: 'GBP',
      fiscalYearStartMonth: 4,
      timezone: 'Europe/London',
      vatRegistered: false,
      defaultVatRate: null,
      taxableCategories: [],
      ...overrides,
    },
    accounts: [],
    costOfSalesEverUsed: true,
    costOfSalesInInvoices: false,
    counterparties: [],
    bankAccounts: [],
    periods: [],
  };
}

const INVOICE_BASIS: BasisChoice = { basis: 'invoices', assurance: 'verified', warnings: [], proxy: false };

function invoice(overrides: Partial<AgingInvoice> & { id: string }): AgingInvoice {
  return {
    invoiceType: 'sales',
    counterpartyId: uuid(300),
    issueDate: '2025-01-05',
    dueDate: '2025-02-04',
    totalAmount: '1000.00',
    amountPaid: '0.00',
    balanceDue: '1000.00',
    paidDate: null,
    status: 'open',
    ...overrides,
  };
}

const NO_FALLBACK: CategoryBalanceFallback = { accountIds: [] };

function periodInput(index: number, overrides: Partial<ReceivablesPeriodInput> = {}): ReceivablesPeriodInput {
  return {
    period: period(index),
    basis: INVOICE_BASIS,
    asOfIsPeriodEnd: true,
    invoices: [],
    receivablesFallback: { ...NO_FALLBACK, accountIds: [AR_ACCOUNT] },
    payablesFallback: { ...NO_FALLBACK, accountIds: [AP_ACCOUNT] },
    balanceSheetClosings: {},
    closingCash: null,
    revenue: null,
    invoiceSalesTotal: null,
    payablesExpenseBase: null,
    hasOpenItemsList: false,
    ...overrides,
  };
}

function cashMetric(value: string | null, missing: MetricResult['dataQuality']['missing'] = []): MetricResult {
  return {
    key: 'closing_cash',
    value,
    unit: 'money',
    basis: 'bank',
    assurance: 'verified',
    dimensionType: 'none',
    dimensionId: null,
    currency: 'GBP',
    components: {},
    dataQuality: { completeness: 1, proxy: false, warnings: [], missing },
    evidenceQuery: null,
  };
}

function metric(results: readonly PeriodMetrics[], index: number, key: string): MetricResult {
  const found = results[index]?.metrics.find((m) => m.key === key);
  if (found === undefined) throw new Error(`no metric ${key} at period ${index}`);
  return found;
}

// ---------------------------------------------------------------------------------------------
// Balances from invoices
// ---------------------------------------------------------------------------------------------

describe('receivables and payables from invoices (§3.4, ADR-047.5)', () => {
  it('sums outstanding sales invoices and subtracts sales credit notes', () => {
    const results = computeReceivables(context(), [
      periodInput(1, {
        invoices: [
          invoice({ id: uuid(1), balanceDue: '1000.00' }),
          invoice({ id: uuid(2), balanceDue: '400.00', totalAmount: '400.00' }),
          invoice({ id: uuid(3), invoiceType: 'sales_credit_note', balanceDue: '150.00', totalAmount: '150.00' }),
          invoice({ id: uuid(4), invoiceType: 'purchase', balanceDue: '900.00', totalAmount: '900.00' }),
          invoice({ id: uuid(5), invoiceType: 'purchase_credit_note', balanceDue: '100.00', totalAmount: '100.00' }),
        ],
      }),
    ]);
    expect(metric(results, 0, 'receivables').value).toBe('1250.00');
    expect(metric(results, 0, 'payables').value).toBe('800.00');
    expect(metric(results, 0, 'receivables').basis).toBe('invoices');
  });

  it('excludes void invoices and invoices not yet issued at asOf', () => {
    const results = computeReceivables(context(), [
      periodInput(1, {
        invoices: [
          invoice({ id: uuid(1), status: 'void', balanceDue: '5000.00' }),
          invoice({ id: uuid(2), issueDate: '2025-11-01', balanceDue: '7000.00' }),
          invoice({ id: uuid(3), balanceDue: '25.00' }),
        ],
      }),
    ]);
    expect(metric(results, 0, 'receivables').value).toBe('25.00');
    expect(metric(results, 0, 'receivables').components).toMatchObject({ invoice_count: 1 });
  });

  it('treats an invoice paid after asOf as unpaid at asOf', () => {
    // The money had not arrived on 28 February. Reading `balance_due` alone would say it had.
    const results = computeReceivables(context(), [
      periodInput(1, {
        invoices: [
          invoice({
            id: uuid(1),
            totalAmount: '1000.00',
            amountPaid: '1000.00',
            balanceDue: '0.00',
            paidDate: '2025-05-10',
            status: 'paid',
          }),
        ],
      }),
    ]);
    expect(metric(results, 0, 'receivables').value).toBe('1000.00');
  });

  it('treats a partial payment with no paid_date as paid at asOf, and says so', () => {
    const results = computeReceivables(context(), [
      periodInput(1, {
        invoices: [
          invoice({
            id: uuid(1),
            totalAmount: '1000.00',
            amountPaid: '400.00',
            balanceDue: '600.00',
            paidDate: null,
            status: 'partially_paid',
          }),
        ],
      }),
    ]);
    const receivables = metric(results, 0, 'receivables');
    expect(receivables.value).toBe('600.00');
    expect(receivables.dataQuality.warnings).toContain('payment_date_unknown');
    expect(receivables.components).toMatchObject({ invoices_with_unknown_payment_date: 1 });
  });

  it('uses the current invoice row, so a corrected total flows to every period (ADR-047.10)', () => {
    // The same corrected invoice is presented to two historical periods; both see the new total.
    const corrected = invoice({ id: uuid(1), totalAmount: '2500.00', balanceDue: '2500.00' });
    const results = computeReceivables(context(), [
      periodInput(1, { invoices: [corrected] }),
      periodInput(2, { invoices: [corrected] }),
    ]);
    expect(metric(results, 0, 'receivables').value).toBe('2500.00');
    expect(metric(results, 1, 'receivables').value).toBe('2500.00');
  });
});

describe('the asOf date used for aging (§3.4)', () => {
  it('ages a historical period at its period end', () => {
    const results = computeReceivables(context(), [periodInput(1)]);
    expect(metric(results, 0, 'receivables').components).toMatchObject({
      as_of: period(1).periodEnd,
      as_of_source: 'period_end',
    });
  });

  it("ages the current period at the run's asOf, never at a clock", () => {
    const results = computeReceivables(context(), [periodInput(1, { asOfIsPeriodEnd: false })]);
    expect(metric(results, 0, 'receivables').components).toMatchObject({
      as_of: '2026-09-05',
      as_of_source: 'run_as_of',
    });
  });
});

describe('overdue (§3.4)', () => {
  const invoices = [
    invoice({ id: uuid(1), dueDate: '2025-01-20', balanceDue: '300.00' }),
    invoice({ id: uuid(2), dueDate: '2025-12-31', balanceDue: '500.00' }),
    invoice({ id: uuid(3), dueDate: null, balanceDue: '900.00' }),
  ];

  it('counts only invoices whose due date has passed', () => {
    const results = computeReceivables(context(), [periodInput(1, { invoices })]);
    expect(metric(results, 0, 'receivables').value).toBe('1700.00');
    expect(metric(results, 0, 'receivables_overdue').value).toBe('300.00');
  });

  it('excludes invoices without a due date and warns, rather than calling them not overdue', () => {
    const results = computeReceivables(context(), [periodInput(1, { invoices })]);
    const overdue = metric(results, 0, 'receivables_overdue');
    expect(overdue.dataQuality.warnings).toContain('no_due_dates');
    expect(overdue.components).toMatchObject({ invoices_without_due_date: 1 });
    // §5, AR/AP (invoices): completeness = 1 − (invoices without due_date / invoices).
    expect(overdue.dataQuality.completeness).toBeCloseTo(2 / 3, 10);
  });
});

// ---------------------------------------------------------------------------------------------
// Fallbacks
// ---------------------------------------------------------------------------------------------

describe('the balance fallbacks when the invoice basis is unavailable (§3.4, §2.3)', () => {
  it('falls back to the period_balances closing balance, with aging unavailable', () => {
    const results = computeReceivables(context(), [
      periodInput(1, {
        invoices: null,
        basis: { basis: 'period_balances', assurance: 'verified', warnings: [], proxy: false },
        receivablesFallback: { accountIds: [AR_ACCOUNT], periodBalanceClosing: '8200.00' },
      }),
    ]);
    const receivables = metric(results, 0, 'receivables');
    expect(receivables.value).toBe('8200.00');
    expect(receivables.basis).toBe('period_balances');
    expect(receivables.assurance).toBe('calculated');
    expect(receivables.dataQuality.completeness).toBe(0.7);
    expect(metric(results, 0, 'receivables_overdue').value).toBeNull();
    expect(metric(results, 0, 'receivables_days').value).toBeNull();
  });

  it('falls back to a ledger balance only when an opening balance exists (ADR-027.3)', () => {
    const results = computeReceivables(context(), [
      periodInput(1, {
        invoices: null,
        receivablesFallback: {
          accountIds: [AR_ACCOUNT],
          ledger: { openingBalance: '5000.00', movements: '1200.00' },
        },
      }),
    ]);
    const receivables = metric(results, 0, 'receivables');
    expect(receivables.value).toBe('6200.00');
    expect(receivables.basis).toBe('ledger');
  });

  it('never reports movements-since-import as a balance', () => {
    // The classic wrong answer: a GL exported from March summed to "receivables of £1,200".
    const results = computeReceivables(context(), [
      periodInput(1, {
        invoices: null,
        receivablesFallback: {
          accountIds: [AR_ACCOUNT],
          ledger: { openingBalance: null, movements: '1200.00' },
        },
      }),
    ]);
    const receivables = metric(results, 0, 'receivables');
    expect(receivables.value).toBeNull();
    expect(receivables.value).not.toBe('0.00');
    expect(receivables.dataQuality.missing).toContain('no_opening_balance');
    expect(receivables.components).toMatchObject({ ledger_movements_seen: '1200.00' });
  });

  it('records the caller’s reason when the invoice basis was stale rather than absent', () => {
    const results = computeReceivables(context(), [
      periodInput(1, { invoices: null, invoiceBasisUnavailableReason: 'stale_invoice_data' }),
    ]);
    expect(metric(results, 0, 'receivables').dataQuality.missing).toContain('stale_invoice_data');
  });
});

// ---------------------------------------------------------------------------------------------
// Days
// ---------------------------------------------------------------------------------------------

describe('receivables_days (§3.4, ADR-027.4)', () => {
  function threeMonths(overrides: Partial<ReceivablesPeriodInput>[]): ReceivablesPeriodInput[] {
    return [0, 1, 2].map((index) =>
      periodInput(index, {
        invoices: [invoice({ id: uuid(1), balanceDue: '1200.00', totalAmount: '1200.00' })],
        ...overrides[index],
      }),
    );
  }

  it('uses gross invoice totals as the denominator on the invoice basis', () => {
    const results = computeReceivables(
      context(),
      threeMonths([
        { invoiceSalesTotal: '1200.00' },
        { invoiceSalesTotal: '1200.00' },
        { invoiceSalesTotal: '1200.00' },
      ]),
    );
    const days = metric(results, 2, 'receivables_days');
    expect(days.components).toMatchObject({
      denominator_basis: 'invoice_total_gross',
      denominator: '3600.00',
      numerator: '1200.00',
      days_in_window: DAYS_PER_QUARTER,
    });
    // 1200 / 3600 × 91.25 = 30.4 → 30 days.
    expect(days.value).toBe('30');
    expect(days.unit).toBe('days');
  });

  it('nets the receivable down by the VAT rate when the denominator is net revenue', () => {
    const inputs = [0, 1, 2].map((index) =>
      periodInput(index, {
        invoices: null,
        receivablesFallback: { accountIds: [AR_ACCOUNT], periodBalanceClosing: '1200.00' },
        revenue: '1000.00',
      }),
    );
    const results = computeReceivables(context({ vatRegistered: true, defaultVatRate: '0.20' }), inputs);
    const days = metric(results, 2, 'receivables_days');
    expect(days.components).toMatchObject({
      denominator_basis: 'revenue_net_of_vat',
      denominator: '3000.00',
      numerator: '1000.00',
      vat_rate_applied: '0.20',
    });
    expect(days.value).toBe('30');
  });

  it('still writes the figure when the VAT rate is unknown, carrying vat_inclusive', () => {
    const inputs = [0, 1, 2].map((index) =>
      periodInput(index, {
        invoices: null,
        receivablesFallback: { accountIds: [AR_ACCOUNT], periodBalanceClosing: '1200.00' },
        revenue: '1000.00',
      }),
    );
    const results = computeReceivables(context(), inputs);
    const days = metric(results, 2, 'receivables_days');
    expect(days.components).toMatchObject({ denominator_basis: 'revenue_vat_unknown' });
    expect(days.dataQuality.warnings).toContain('vat_inclusive');
    expect(days.value).toBe('37');
  });

  it('is NULL with open_items_only when an aged-debtors list covers the window (ADR-047.10)', () => {
    const results = computeReceivables(
      context(),
      threeMonths([
        { invoiceSalesTotal: '1200.00' },
        { invoiceSalesTotal: '1200.00', hasOpenItemsList: true },
        { invoiceSalesTotal: '1200.00' },
      ]),
    );
    const days = metric(results, 2, 'receivables_days');
    expect(days.value).toBeNull();
    expect(days.dataQuality.missing).toContain('open_items_only');
  });

  it('is NULL with open_items_only on the revenue denominator too', () => {
    const inputs = [0, 1, 2].map((index) =>
      periodInput(index, {
        invoices: null,
        receivablesFallback: { accountIds: [AR_ACCOUNT], periodBalanceClosing: '1200.00' },
        revenue: '1000.00',
        hasOpenItemsList: index === 0,
      }),
    );
    const days = metric(computeReceivables(context(), inputs), 2, 'receivables_days');
    expect(days.value).toBeNull();
    expect(days.dataQuality.missing).toContain('open_items_only');
    expect(days.components).toMatchObject({ denominator_basis: 'revenue_net_of_vat' });
  });

  it('is NULL when a month of the revenue window has no revenue figure', () => {
    const inputs = [0, 1, 2].map((index) =>
      periodInput(index, {
        invoices: null,
        receivablesFallback: { accountIds: [AR_ACCOUNT], periodBalanceClosing: '1200.00' },
        revenue: index === 1 ? null : '1000.00',
      }),
    );
    const days = metric(computeReceivables(context(), inputs), 2, 'receivables_days');
    expect(days.value).toBeNull();
    expect(days.dataQuality.missing).toContain('insufficient_history');
  });

  it('is NULL with insufficient_history before three months exist', () => {
    const results = computeReceivables(
      context(),
      threeMonths([
        { invoiceSalesTotal: '1200.00' },
        { invoiceSalesTotal: '1200.00' },
        { invoiceSalesTotal: '1200.00' },
      ]),
    );
    expect(metric(results, 0, 'receivables_days').dataQuality.missing).toContain('insufficient_history');
    expect(metric(results, 1, 'receivables_days').dataQuality.missing).toContain('insufficient_history');
  });

  it('is NULL with insufficient_history when one month of the window has no sales figure', () => {
    const results = computeReceivables(
      context(),
      threeMonths([
        { invoiceSalesTotal: '1200.00' },
        { invoiceSalesTotal: null },
        { invoiceSalesTotal: '1200.00' },
      ]),
    );
    expect(metric(results, 2, 'receivables_days').value).toBeNull();
    expect(metric(results, 2, 'receivables_days').dataQuality.missing).toContain('insufficient_history');
  });

  it('is NULL when the three months sold nothing', () => {
    const results = computeReceivables(
      context(),
      threeMonths([
        { invoiceSalesTotal: '0.00' },
        { invoiceSalesTotal: '0.00' },
        { invoiceSalesTotal: '0.00' },
      ]),
    );
    expect(metric(results, 2, 'receivables_days').value).toBeNull();
    expect(metric(results, 2, 'receivables_days').dataQuality.missing).toContain('comparison_is_zero');
  });

  it('takes the window across a chunk boundary from the carried denominators', () => {
    const results = computeReceivables(
      context(),
      [periodInput(5, { invoices: [invoice({ id: uuid(1), balanceDue: '1200.00' })], invoiceSalesTotal: '1200.00' })],
      {
        priorDenominators: [
          { revenue: null, invoiceSalesTotal: '1200.00', payablesExpenseBase: null, hasOpenItemsList: false },
          { revenue: null, invoiceSalesTotal: '1200.00', payablesExpenseBase: null, hasOpenItemsList: false },
        ],
      },
    );
    expect(metric(results, 0, 'receivables_days').value).toBe('30');
  });

  it('refuses the window when the three periods are not consecutive months', () => {
    const results = computeReceivables(context(), [
      periodInput(0, { invoices: [invoice({ id: uuid(1) })], invoiceSalesTotal: '1200.00' }),
      periodInput(1, { invoices: [invoice({ id: uuid(1) })], invoiceSalesTotal: '1200.00' }),
      periodInput(6, { invoices: [invoice({ id: uuid(1) })], invoiceSalesTotal: '1200.00' }),
    ]);
    expect(metric(results, 2, 'receivables_days').dataQuality.missing).toContain('insufficient_history');
  });
});

describe('payables_days (§3.4, ADR-027.5)', () => {
  it('divides by cost of sales, operating expense and marketing only', () => {
    // `payablesExpenseBase` is 6,000 a month while total costs including payroll are far higher:
    // payroll and depreciation never pass through accounts payable, so they never reach here.
    const inputs = [0, 1, 2].map((index) =>
      periodInput(index, {
        invoices: [invoice({ id: uuid(9), invoiceType: 'purchase', balanceDue: '6000.00', totalAmount: '6000.00' })],
        payablesExpenseBase: '6000.00',
        revenue: '90000.00',
      }),
    );
    const results = computeReceivables(context(), inputs);
    const days = metric(results, 2, 'payables_days');
    expect(days.components).toMatchObject({
      denominator_basis: 'expense_categories',
      denominator: '18000.00',
      numerator: '6000.00',
    });
    // 6000 / 18000 × 91.25 = 30.4 → 30 days, not the ~20 a payroll-inclusive denominator would give.
    expect(days.value).toBe('30');
  });

  it('is NULL when the denominator is zero or negative', () => {
    const inputs = [0, 1, 2].map((index) =>
      periodInput(index, {
        invoices: [invoice({ id: uuid(9), invoiceType: 'purchase', balanceDue: '600.00' })],
        payablesExpenseBase: '0.00',
      }),
    );
    const results = computeReceivables(context(), inputs);
    expect(metric(results, 2, 'payables_days').value).toBeNull();
    expect(metric(results, 2, 'payables_days').dataQuality.missing).toContain('comparison_is_zero');
  });
});

// ---------------------------------------------------------------------------------------------
// Working capital
// ---------------------------------------------------------------------------------------------

describe('working_capital (§3.4)', () => {
  const fullBalanceSheet = {
    inventory: { value: '1000.00', basis: 'period_balances' as const },
    other_current_asset: { value: '500.00', basis: 'period_balances' as const },
    credit_card: { value: '300.00', basis: 'period_balances' as const },
    tax_liability: { value: '200.00', basis: 'period_balances' as const },
    other_current_liability: { value: '100.00', basis: 'period_balances' as const },
  };

  const withEverything = periodInput(1, {
    invoices: [
      invoice({ id: uuid(1), balanceDue: '2000.00' }),
      invoice({ id: uuid(2), invoiceType: 'purchase', balanceDue: '1500.00' }),
    ],
    balanceSheetClosings: fullBalanceSheet,
    closingCash: cashMetric('5000.00'),
  });

  it('adds the current assets and subtracts the current liabilities', () => {
    const results = computeReceivables(context(), [withEverything]);
    // 5,000 + 2,000 + 1,000 + 500 − 1,500 − 300 − 200 − 100
    expect(metric(results, 0, 'working_capital').value).toBe('6400.00');
  });

  it('is mixed-basis whenever its inputs come from different sources', () => {
    const wc = metric(computeReceivables(context(), [withEverything]), 0, 'working_capital');
    expect(wc.basis).toBe('mixed');
    expect(wc.components).toMatchObject({
      bases: { closing_cash: 'bank', receivables: 'invoices', inventory: 'period_balances' },
    });
  });

  it('still writes a figure when balance-sheet terms are absent, naming what is missing', () => {
    const results = computeReceivables(context(), [
      periodInput(1, {
        invoices: [invoice({ id: uuid(1), balanceDue: '2000.00' })],
        closingCash: cashMetric('5000.00'),
      }),
    ]);
    const wc = metric(results, 0, 'working_capital');
    expect(wc.value).toBe('7000.00');
    expect(wc.dataQuality.warnings).toContain('partial_working_capital');
    expect(wc.components).toMatchObject({
      missing_terms: ['credit_card', 'inventory', 'other_current_asset', 'other_current_liability', 'tax_liability'],
    });
    expect(wc.dataQuality.completeness).toBeLessThan(1);
  });

  it('is NULL when closing cash is unknown, and says why', () => {
    const results = computeReceivables(context(), [
      periodInput(1, {
        invoices: [invoice({ id: uuid(1), balanceDue: '2000.00' })],
        balanceSheetClosings: fullBalanceSheet,
        closingCash: cashMetric(null, ['no_opening_cash']),
      }),
    ]);
    const wc = metric(results, 0, 'working_capital');
    expect(wc.value).toBeNull();
    expect(wc.dataQuality.missing).toContain('no_opening_cash');
  });

  it('is NULL when no cash metric was produced at all', () => {
    const results = computeReceivables(context(), [periodInput(1, { closingCash: null })]);
    expect(metric(results, 0, 'working_capital').value).toBeNull();
    expect(metric(results, 0, 'working_capital').dataQuality.missing).toContain('no_opening_cash');
  });

  it('treats an unknown receivables balance as a missing term rather than nil', () => {
    const results = computeReceivables(context(), [
      periodInput(1, {
        invoices: null,
        balanceSheetClosings: fullBalanceSheet,
        closingCash: cashMetric('5000.00'),
      }),
    ]);
    const wc = metric(results, 0, 'working_capital');
    expect(wc.components).toMatchObject({ missing_terms: ['payables', 'receivables'] });
    expect(wc.dataQuality.warnings).toContain('partial_working_capital');
    // 5,000 + 1,000 + 500 − 300 − 200 − 100, with the two unknown terms left out entirely.
    expect(wc.value).toBe('5900.00');
  });
});

// ---------------------------------------------------------------------------------------------
// Shape and determinism
// ---------------------------------------------------------------------------------------------

describe('the shape of an AR/AP snapshot', () => {
  const results = computeReceivables(context(), [
    periodInput(1, { invoices: [invoice({ id: uuid(1) })] }),
  ]);

  it('writes all seven keys once per period', () => {
    expect(results[0]?.metrics.map((m) => m.key)).toEqual([
      'receivables', 'receivables_overdue', 'receivables_days',
      'payables', 'payables_overdue', 'payables_days', 'working_capital',
    ]);
  });

  it('writes a v1 invoice descriptor the evidence schema accepts', () => {
    const evidence = metric(results, 0, 'receivables').evidenceQuery;
    if (evidence?.kind !== 'leaf') throw new Error('expected a leaf');
    const parsed = parseQueryDescriptor(evidence.descriptor);
    expect(parsed.table).toBe('invoices');
    expect(parsed.filters.invoice_types).toEqual(['sales', 'sales_credit_note']);
    expect(parsed.filters.open_as_of).toBe(period(1).periodEnd);
  });

  it('gives the overdue metric its own overdue_as_of descriptor', () => {
    const evidence = metric(results, 0, 'receivables_overdue').evidenceQuery;
    if (evidence?.kind !== 'leaf') throw new Error('expected a leaf');
    expect(parseQueryDescriptor(evidence.descriptor).filters.overdue_as_of).toBe(period(1).periodEnd);
  });

  it('falls back to a period filter alone when no account carries the category', () => {
    const fallbackResults = computeReceivables(context(), [
      periodInput(1, { invoices: null, receivablesFallback: { accountIds: [], periodBalanceClosing: '10.00' } }),
    ]);
    const evidence = metric(fallbackResults, 0, 'receivables').evidenceQuery;
    if (evidence?.kind !== 'leaf') throw new Error('expected a leaf');
    const parsed = parseQueryDescriptor(evidence.descriptor);
    expect(parsed.filters.account_ids).toBeUndefined();
    expect(parsed.filters.period_ids).toEqual([period(1).id]);
  });

  it('resolves the fallback descriptor to concrete account ids, never a category name', () => {
    const fallbackResults = computeReceivables(context(), [
      periodInput(1, {
        invoices: null,
        receivablesFallback: { accountIds: [AR_ACCOUNT], periodBalanceClosing: '10.00' },
      }),
    ]);
    const evidence = metric(fallbackResults, 0, 'receivables').evidenceQuery;
    if (evidence?.kind !== 'leaf') throw new Error('expected a leaf');
    const parsed = parseQueryDescriptor(evidence.descriptor);
    expect(parsed.table).toBe('period_balances');
    expect(parsed.filters.account_ids).toEqual([AR_ACCOUNT]);
  });
});

describe('determinism (§1.1)', () => {
  const inputs = [0, 1, 2].map((index) =>
    periodInput(index, {
      invoices: [
        invoice({ id: uuid(3), balanceDue: '300.00' }),
        invoice({ id: uuid(1), balanceDue: '100.00', dueDate: null }),
        invoice({ id: uuid(2), invoiceType: 'purchase', balanceDue: '200.00' }),
      ],
      invoiceSalesTotal: '400.00',
      payablesExpenseBase: '200.00',
      balanceSheetClosings: { inventory: { value: '50.00', basis: 'period_balances' } },
      closingCash: cashMetric('900.00'),
    }),
  );

  it('produces byte-identical results when run twice', () => {
    const ctx = context();
    expect(JSON.stringify(computeReceivables(ctx, inputs))).toBe(
      JSON.stringify(computeReceivables(ctx, inputs)),
    );
  });

  it('produces the same results whatever order the periods and invoices arrive in', () => {
    const ctx = context();
    const shuffled = [...inputs]
      .reverse()
      .map((input) => ({ ...input, invoices: input.invoices === null ? null : [...input.invoices].reverse() }));
    expect(JSON.stringify(computeReceivables(ctx, shuffled))).toBe(
      JSON.stringify(computeReceivables(ctx, inputs)),
    );
  });
});
