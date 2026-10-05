import { describe, expect, it } from 'vitest';

import {
  denominatorInputsFor, expenseBaseFooting,
  type AggregateCell, type CoverageBatch, type MetricResult, type PeriodRef,
} from '@/modules/financial-engine';

/**
 * FU-9 (ADR-129): the purchase side's gross base, from recorded tax only.
 *
 * An invoice cell's `amount` is net of tax (`app.invoice_net`) and its `debit` the recorded tax, so
 * amount + debit is what the supplier billed at whatever rate — or none — the invoice carried. The
 * payables balance is VAT-inclusive, so this is the base it is comparable with.
 */

const aug: PeriodRef = {
  id: 'p-aug', periodStart: '2026-08-01', periodEnd: '2026-08-31', fiscalYear: 2026, fiscalQuarter: 3, label: 'Aug', isComplete: true,
};
const purchaseList: CoverageBatch = {
  id: 'b-p', targetTable: 'invoices', balanceKind: null, balanceBasis: null, bankAccountId: null,
  invoiceListKind: 'full', importType: 'purchase_invoices', periodStart: '2026-08-01', periodEnd: '2026-08-31',
  committedAt: '2026-09-05T00:00:00Z',
};
const cell = (invoiceType: string, net: string, tax: string): AggregateCell => ({
  periodId: aug.id, source: 'invoices', standardCategory: null, accountId: null, counterpartyId: 'cp', bankAccountId: null,
  balanceKind: null, balanceBasis: null, invoiceType, debit: tax, credit: '0', amount: net, rowCount: 1,
  fallbackRows: 0, minDate: null, maxDate: null,
} as AggregateCell);

describe('purchaseInvoiceGross', () => {
  const cells = [
    cell('purchase', '1000.00', '200.00'),        // standard rate
    cell('purchase', '1000.00', '50.00'),         // reduced rate
    cell('purchase', '1000.00', '0.00'),          // zero-rated (or no tax recorded: net = total)
    cell('purchase_credit_note', '100.00', '20.00'),
    cell('sales', '9999.00', '1999.80'),          // the other side never counts
  ];

  it('sums what each supplier billed, at its own rate, credit notes subtracted', () => {
    expect(denominatorInputsFor(aug, [], cells, [purchaseList]).purchaseInvoiceGross).toBe('3130.00');
  });

  it('is unknown without a full purchase list establishing the month', () => {
    expect(denominatorInputsFor(aug, [], cells, []).purchaseInvoiceGross).toBeNull();
    const midMonth = { ...purchaseList, committedAt: '2026-08-10T00:00:00Z' };
    expect(denominatorInputsFor(aug, [], cells, [midMonth]).purchaseInvoiceGross).toBeNull();
  });

  it('records the P&L basis the expense base was stated on', () => {
    const cos = { key: 'cost_of_sales', dimensionType: 'none', basis: 'ledger', value: '500.00' } as MetricResult;
    expect(denominatorInputsFor(aug, [cos], [], []).payablesExpenseBasis).toBe('ledger');
  });
});

describe('expenseBaseFooting', () => {
  const settings = (vatRegistered: boolean, vatStatusKnown?: boolean) => ({
    baseCurrency: 'GBP', fiscalYearStartMonth: 1, timezone: 'Europe/London', vatRegistered,
    defaultVatRate: null, taxableCategories: [], ...(vatStatusKnown === undefined ? {} : { vatStatusKnown }),
  });

  it.each([
    ['bank', settings(true, true), 'gross'],
    ['invoices', settings(false, true), 'net'],
    ['ledger', settings(false, true), 'gross'],
    ['ledger', settings(true, true), 'net'],
    ['period_balances', settings(false, false), 'unknown'],
    ['mixed', settings(false, true), 'unknown'],
    [null, settings(false, true), 'unknown'],
  ] as const)('%s costs for %o are %s', (basis, s, footing) => {
    expect(expenseBaseFooting(basis, s)).toBe(footing);
  });
});
