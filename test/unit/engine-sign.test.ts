import { describe, expect, it } from 'vitest';

import {
  VAT_FALLBACK_ESTIMATED_THRESHOLD,
  bankDirection,
  bankOutflowMagnitude,
  differenceCumulativeBalance,
  foldInvoiceRows,
  invoiceContributes,
  invoiceNetOfTax,
  invoiceSignFor,
  ledgerAmount,
  ledgerLineAmount,
  naturalToReporting,
  periodBalanceBalanceSheetAmount,
  periodBalancePnlAmount,
  reportingSignFor,
  reportingSignForCategory,
  type InvoiceAmountRow,
} from '@/modules/financial-engine';
import { STANDARD_CATEGORIES, CATEGORY_ACCOUNT_TYPE } from '@/modules/financials';

/**
 * FINANCIAL_ENGINE.md §3, sign conventions. These are the tests that stop a P&L being published
 * upside down, so each one is named after the misstatement it prevents rather than the function it
 * calls.
 */

const invoice = (over: Partial<InvoiceAmountRow> = {}): InvoiceAmountRow => ({
  invoiceType: 'sales',
  status: 'open',
  subtotal: '100.00',
  taxAmount: '20.00',
  totalAmount: '120.00',
  ...over,
});

describe('the account-type sign rule (§3)', () => {
  it('flips income, liability and equity, and leaves asset and expense alone', () => {
    expect(reportingSignFor('income')).toBe(-1);
    expect(reportingSignFor('liability')).toBe(-1);
    expect(reportingSignFor('equity')).toBe(-1);
    expect(reportingSignFor('asset')).toBe(1);
    expect(reportingSignFor('expense')).toBe(1);
  });

  it('gives every standard category the sign of its account type', () => {
    for (const category of STANDARD_CATEGORIES) {
      expect(reportingSignForCategory(category), category)
        .toBe(reportingSignFor(CATEGORY_ACCOUNT_TYPE[category]));
    }
  });

  it('is a multiplier, so differencing and converting commute', () => {
    // This is what makes cumulative differencing safe: −(a) − −(b) === −(a − b).
    const a = naturalToReporting('income', '-500.00');
    const b = naturalToReporting('income', '-300.00');
    expect(a.minus(b).toFixed(2)).toBe(naturalToReporting('income', '-200.00').toFixed(2));
  });
});

describe('ledger amounts (§3)', () => {
  it('reports credit-heavy revenue as a positive figure', () => {
    expect(ledgerAmount({ accountType: 'income', debit: '0', credit: '5000.00' }).toFixed(2))
      .toBe('5000.00');
  });

  it('reports debit-heavy expenses as a positive figure', () => {
    expect(ledgerAmount({ accountType: 'expense', debit: '900.00', credit: '0' }).toFixed(2))
      .toBe('900.00');
  });

  it('reports revenue as NEGATIVE when refunds exceeded sales, rather than hiding them', () => {
    expect(ledgerAmount({ accountType: 'income', debit: '7000.00', credit: '5000.00' }).toFixed(2))
      .toBe('-2000.00');
  });

  it('signs a single line by its direction', () => {
    expect(ledgerLineAmount({ accountType: 'income', direction: 'credit', amount: '250.00' }).toFixed(2))
      .toBe('250.00');
    expect(ledgerLineAmount({ accountType: 'expense', direction: 'credit', amount: '250.00' }).toFixed(2))
      .toBe('-250.00');
  });
});

describe('period balances under the movement basis (§3)', () => {
  it('takes the closing balance as the month, converting natural to reporting sign', () => {
    const result = periodBalancePnlAmount({
      accountType: 'income', balanceBasis: 'movement', closing: '-4000.00',
      isFirstFiscalMonth: false, priorState: 'no_batch',
    });
    expect(result.amount?.toFixed(2)).toBe('4000.00');
    expect(result.missing).toEqual([]);
  });
});

describe('cumulative differencing (§3, ADR-047.4)', () => {
  it('takes the closing balance whole in the first fiscal month, because the year has reset', () => {
    const result = differenceCumulativeBalance({
      accountType: 'expense', closing: '1200.00',
      isFirstFiscalMonth: true, priorState: 'no_batch',
    });
    expect(result.amount?.toFixed(2)).toBe('1200.00');
    expect(result.missing).toEqual([]);
  });

  it('subtracts the pinned previous fiscal month', () => {
    const result = differenceCumulativeBalance({
      accountType: 'expense', closing: '3000.00',
      isFirstFiscalMonth: false, priorState: 'same_kind_and_basis', priorClosing: '1800.00',
    });
    expect(result.amount?.toFixed(2)).toBe('1200.00');
  });

  it('differences income in natural sign then converts once', () => {
    // Year-to-date revenue of 10,000 (natural −10,000) against 6,000 is 4,000 for the month.
    const result = differenceCumulativeBalance({
      accountType: 'income', closing: '-10000.00',
      isFirstFiscalMonth: false, priorState: 'same_kind_and_basis', priorClosing: '-6000.00',
    });
    expect(result.amount?.toFixed(2)).toBe('4000.00');
  });

  it('treats an account absent from the prior batch as a real zero, with a note', () => {
    const result = differenceCumulativeBalance({
      accountType: 'expense', closing: '450.00',
      isFirstFiscalMonth: false, priorState: 'account_absent',
    });
    expect(result.amount?.toFixed(2)).toBe('450.00');
    expect(result.warnings).toContain('account_absent_prior');
    expect(result.missing).toEqual([]);
  });

  it('refuses to difference when no prior batch of the same kind and basis exists', () => {
    // Differencing March against January would report two months of trading as one.
    const result = differenceCumulativeBalance({
      accountType: 'expense', closing: '3000.00',
      isFirstFiscalMonth: false, priorState: 'no_batch',
    });
    expect(result.amount).toBeNull();
    expect(result.missing).toEqual(['no_prior_trial_balance']);
  });

  it('refuses rather than guessing when the promised prior figure is not supplied', () => {
    const result = differenceCumulativeBalance({
      accountType: 'expense', closing: '3000.00',
      isFirstFiscalMonth: false, priorState: 'same_kind_and_basis', priorClosing: null,
    });
    expect(result.amount).toBeNull();
    expect(result.missing).toEqual(['no_prior_trial_balance']);
  });

  it('routes the cumulative basis through the differencing rule from the P&L entry point', () => {
    const result = periodBalancePnlAmount({
      accountType: 'expense', balanceBasis: 'cumulative', closing: '3000.00',
      isFirstFiscalMonth: false, priorState: 'same_kind_and_basis', priorClosing: '2000.00',
    });
    expect(result.amount?.toFixed(2)).toBe('1000.00');
  });
});

describe('balance-sheet positions (§3)', () => {
  it('states the cumulative closing balance directly', () => {
    const result = periodBalanceBalanceSheetAmount({
      accountType: 'liability', balanceBasis: 'cumulative', closing: '-8000.00',
    });
    expect(result.amount?.toFixed(2)).toBe('8000.00');
  });

  it('has no position at all when a cumulative row is missing', () => {
    const result = periodBalanceBalanceSheetAmount({
      accountType: 'asset', balanceBasis: 'cumulative', closing: null,
    });
    expect(result.amount).toBeNull();
    expect(result.missing).toEqual(['no_opening_balance']);
  });

  it('adds movements to a prior closing balance', () => {
    const result = periodBalanceBalanceSheetAmount({
      accountType: 'asset', balanceBasis: 'movement',
      priorClosing: '1000.00', movements: ['250.00', '-100.00'],
    });
    expect(result.amount?.toFixed(2)).toBe('1150.00');
  });

  it('treats an omitted movement list as no movement, not as a missing balance', () => {
    const result = periodBalanceBalanceSheetAmount({
      accountType: 'asset', balanceBasis: 'movement', priorClosing: '1000.00',
    });
    expect(result.amount?.toFixed(2)).toBe('1000.00');
  });

  it('never reports movements-since-import as if they were a balance', () => {
    const result = periodBalanceBalanceSheetAmount({
      accountType: 'asset', balanceBasis: 'movement', priorClosing: null, movements: ['250.00'],
    });
    expect(result.amount).toBeNull();
    expect(result.missing).toEqual(['no_opening_balance']);
  });
});

describe('invoices (§3, ADR-047.5)', () => {
  it('adds sales and purchases and subtracts their credit notes', () => {
    expect(invoiceSignFor('sales')).toBe(1);
    expect(invoiceSignFor('purchase')).toBe(1);
    expect(invoiceSignFor('sales_credit_note')).toBe(-1);
    expect(invoiceSignFor('purchase_credit_note')).toBe(-1);
  });

  it('excludes void invoices and includes every other status', () => {
    expect(invoiceContributes('void')).toBe(false);
    for (const status of ['open', 'partially_paid', 'paid'] as const) {
      expect(invoiceContributes(status)).toBe(true);
    }
  });

  it('prefers the subtotal', () => {
    const { net, usedTotalFallback } = invoiceNetOfTax(invoice());
    expect(net.toFixed(2)).toBe('100.00');
    expect(usedTotalFallback).toBe(false);
  });

  it('treats a zero subtotal beside a positive total as absent, not as a zero invoice', () => {
    // Exporters without a subtotal column write a literal 0; taking it would delete the sale.
    const { net, usedTotalFallback } = invoiceNetOfTax(invoice({ subtotal: '0.00' }));
    expect(net.toFixed(2)).toBe('100.00');
    expect(usedTotalFallback).toBe(false);
  });

  it('keeps a genuinely zero invoice at zero', () => {
    const { net, usedTotalFallback } = invoiceNetOfTax(
      invoice({ subtotal: '0.00', taxAmount: '0.00', totalAmount: '0.00' }),
    );
    expect(net.toFixed(2)).toBe('0.00');
    expect(usedTotalFallback).toBe(false);
  });

  it('falls back to total minus tax when there is no subtotal', () => {
    const { net, usedTotalFallback } = invoiceNetOfTax(invoice({ subtotal: null }));
    expect(net.toFixed(2)).toBe('100.00');
    expect(usedTotalFallback).toBe(false);
  });

  it('falls back to the VAT-inclusive total only as a last resort, and says so', () => {
    const { net, usedTotalFallback } = invoiceNetOfTax(
      invoice({ subtotal: null, taxAmount: null }),
    );
    expect(net.toFixed(2)).toBe('120.00');
    expect(usedTotalFallback).toBe(true);
  });

  it('subtracts a positively-stored credit note instead of adding it', () => {
    const fold = foldInvoiceRows([
      invoice({ subtotal: '1000.00', taxAmount: '200.00', totalAmount: '1200.00' }),
      invoice({
        invoiceType: 'sales_credit_note',
        subtotal: '250.00', taxAmount: '50.00', totalAmount: '300.00',
      }),
    ]);
    expect(fold.amount.toFixed(2)).toBe('750.00');
    expect(fold.contributingRows).toBe(2);
  });

  it('leaves void invoices out of the sum entirely', () => {
    const fold = foldInvoiceRows([
      invoice({ subtotal: '100.00' }),
      invoice({ subtotal: '900.00', status: 'void' }),
    ]);
    expect(fold.amount.toFixed(2)).toBe('100.00');
    expect(fold.contributingRows).toBe(1);
  });

  it('flags vat_inclusive on a single fallback row without downgrading assurance', () => {
    const rows = [
      ...Array.from({ length: 19 }, () => invoice()),
      invoice({ subtotal: null, taxAmount: null }),
    ];
    const fold = foldInvoiceRows(rows);
    expect(fold.vatInclusive).toBe(true);
    expect(fold.warnings).toEqual(['vat_inclusive']);
    expect(fold.fallbackShare?.toFixed(2)).toBe('0.05');
    expect(fold.estimated).toBe(false);
  });

  it('downgrades to an estimate once more than a tenth of rows are VAT-inclusive', () => {
    const rows = [
      ...Array.from({ length: 8 }, () => invoice()),
      ...Array.from({ length: 2 }, () => invoice({ subtotal: null, taxAmount: null })),
    ];
    const fold = foldInvoiceRows(rows);
    expect(fold.fallbackShare?.toFixed(2)).toBe('0.20');
    expect(fold.estimated).toBe(true);
    expect(VAT_FALLBACK_ESTIMATED_THRESHOLD).toBe('0.10');
  });

  it('reports no share at all when nothing contributed', () => {
    const fold = foldInvoiceRows([invoice({ status: 'void' })]);
    expect(fold.fallbackShare).toBeNull();
    expect(fold.estimated).toBe(false);
    expect(fold.vatInclusive).toBe(false);
  });

  it('sits exactly on the threshold without downgrading', () => {
    const rows = [
      ...Array.from({ length: 9 }, () => invoice()),
      invoice({ subtotal: null, taxAmount: null }),
    ];
    expect(foldInvoiceRows(rows).estimated).toBe(false);
  });
});

describe('bank movements (§3)', () => {
  it('calls a positive amount an inflow and a negative one an outflow', () => {
    expect(bankDirection('120.00')).toBe('inflow');
    expect(bankDirection('-120.00')).toBe('outflow');
  });

  it('puts a zero movement in neither direction', () => {
    expect(bankDirection('0.00')).toBeNull();
  });

  it('stores an outflow as a positive magnitude', () => {
    expect(bankOutflowMagnitude('-99.99').toFixed(2)).toBe('99.99');
  });
});
