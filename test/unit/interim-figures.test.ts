import { describe, expect, it } from 'vitest';
import {
  computeInterimFigures, INTERIM_RECORD_CAP, INTERIM_RULES_VERSION,
  type InterimBankRow, type InterimInput, type InterimInvoiceRow,
} from '@/modules/financial-engine';

/**
 * Interim figures (Phase 17, R17-1b). Every expected value below is worked by hand from the rows
 * listed beside it; none is read back from the implementation.
 */

const WEEK = { start: '2026-09-07', end: '2026-09-13' };

const bank = (id: string, date: string, amount: string, extra: Partial<InterimBankRow> = {}): InterimBankRow => ({
  id, bankAccountId: 'acc-1', date, amount, currency: 'GBP', transferKind: null, description: id, ...extra,
});

const invoice = (id: string, extra: Partial<InterimInvoiceRow>): InterimInvoiceRow => ({
  id, type: 'sales', number: id, counterparty: 'Acme', issueDate: '2026-08-01', dueDate: null, paidDate: null,
  total: '0.00', balanceDue: '0.00', status: 'open', currency: 'GBP', ...extra,
});

const base = (over: Partial<InterimInput> = {}): InterimInput => ({
  window: WEEK,
  baseCurrency: 'GBP',
  bank: [],
  invoices: [],
  accounts: [{ bankAccountId: 'acc-1', name: 'Current', latestDate: '2026-09-30' }],
  hasInvoiceData: true,
  ...over,
});

const value = (figures: ReturnType<typeof computeInterimFigures>, key: string) =>
  [...(figures.cash ?? []), ...(figures.invoicing ?? [])].find((f) => f.key === key);

describe('cash in the window', () => {
  it('sums money in and out by transaction date, and nets them', () => {
    // In: 1200.00 + 300.50 = 1500.50. Out: 400.25 + 99.75 = 500.00. Net: 1000.50.
    const figures = computeInterimFigures(base({
      bank: [
        bank('b1', '2026-09-07', '1200.00'),
        bank('b2', '2026-09-13', '300.50'),
        bank('b3', '2026-09-08', '-400.25'),
        bank('b4', '2026-09-10', '-99.75'),
        bank('outside', '2026-09-14', '-5000.00'),
      ],
    }));
    expect(figures.version).toBe(INTERIM_RULES_VERSION);
    expect(value(figures, 'cash_in')).toMatchObject({ value: '1500.50', recordCount: 2, status: 'calculated' });
    expect(value(figures, 'cash_out')).toMatchObject({ value: '500.00', recordCount: 2 });
    expect(value(figures, 'net_cash_movement')).toMatchObject({ value: '1000.50', recordCount: 4 });
  });

  it('leaves transfers between the organisation\'s own accounts out, as the monthly engine does (ADR-028)', () => {
    // Only cash_transfer is excluded; a loan repayment is real money out.
    const figures = computeInterimFigures(base({
      bank: [
        bank('t1', '2026-09-08', '-1000.00', { transferKind: 'cash_transfer' }),
        bank('t2', '2026-09-08', '1000.00', { transferKind: 'cash_transfer', bankAccountId: 'acc-2' }),
        bank('loan', '2026-09-09', '-250.00', { transferKind: 'loan_repayment' }),
      ],
    }));
    expect(value(figures, 'cash_in')).toMatchObject({ value: '0.00', recordCount: 0 });
    expect(value(figures, 'cash_out')).toMatchObject({ value: '250.00', recordCount: 1 });
  });

  it('marks cash incomplete when an account\'s data stops before the window ends, and names it', () => {
    const figures = computeInterimFigures(base({
      bank: [bank('b1', '2026-09-08', '100.00')],
      accounts: [
        { bankAccountId: 'acc-1', name: 'Current', latestDate: '2026-09-30' },
        { bankAccountId: 'acc-2', name: 'Savings', latestDate: '2026-09-10' },
      ],
    }));
    expect(value(figures, 'cash_in')?.status).toBe('incomplete');
    expect(figures.coverage.accountsShort).toEqual([{ bankAccountId: 'acc-2', name: 'Savings', latestDate: '2026-09-10' }]);
    expect(figures.coverage.bankThrough).toBe('2026-09-10');
  });

  it('says nothing — not zero — when no account has data reaching into the window', () => {
    const figures = computeInterimFigures(base({
      accounts: [{ bankAccountId: 'acc-1', name: 'Current', latestDate: '2026-08-31' }],
    }));
    expect(figures.cash).toBeNull();
    expect(figures.unavailable).toContain('no_bank_data_in_window');
  });

  it('says there are no bank accounts rather than reporting zero cash', () => {
    const figures = computeInterimFigures(base({ accounts: [] }));
    expect(figures.cash).toBeNull();
    expect(figures.unavailable).toContain('no_bank_accounts');
    expect(figures.coverage.bankThrough).toBeNull();
  });

  it('a quiet week whose data does reach the end is a real zero', () => {
    const figures = computeInterimFigures(base());
    expect(value(figures, 'net_cash_movement')).toMatchObject({ value: '0.00', recordCount: 0, status: 'calculated' });
  });

  it('counts, and leaves out, records in another currency (CD-10)', () => {
    const figures = computeInterimFigures(base({
      bank: [bank('eur', '2026-09-08', '500.00', { currency: 'EUR' }), bank('gbp', '2026-09-08', '20.00')],
    }));
    expect(value(figures, 'cash_in')?.value).toBe('20.00');
    expect(figures.coverage.otherCurrencyRecords).toBe(1);
  });

  it('lists the largest records first, capped, and always the exact count', () => {
    const rows = Array.from({ length: INTERIM_RECORD_CAP + 5 }, (_, i) =>
      bank(`r${String(i).padStart(2, '0')}`, '2026-09-08', `${i + 1}.00`));
    const cashIn = value(computeInterimFigures(base({ bank: rows })), 'cash_in');
    expect(cashIn?.recordCount).toBe(INTERIM_RECORD_CAP + 5);
    expect(cashIn?.records).toHaveLength(INTERIM_RECORD_CAP);
    expect(cashIn?.records[0]).toMatchObject({ kind: 'bank', id: `r${INTERIM_RECORD_CAP + 4}`, amount: `${INTERIM_RECORD_CAP + 5}.00` });
  });
});

describe('invoicing in the window', () => {
  it('nets credit notes against invoices issued, per side', () => {
    // Sales: 1000.00 − 150.00 = 850.00. Purchases: 400.00 − 40.00 = 360.00.
    const figures = computeInterimFigures(base({
      invoices: [
        invoice('s1', { issueDate: '2026-09-08', total: '1000.00' }),
        invoice('sc', { type: 'sales_credit_note', issueDate: '2026-09-09', total: '150.00' }),
        invoice('p1', { type: 'purchase', issueDate: '2026-09-10', total: '400.00' }),
        invoice('pc', { type: 'purchase_credit_note', issueDate: '2026-09-11', total: '40.00' }),
        invoice('before', { issueDate: '2026-09-06', total: '999.00' }),
      ],
    }));
    expect(value(figures, 'sales_invoiced')).toMatchObject({ value: '850.00', recordCount: 2 });
    expect(value(figures, 'purchases_invoiced')).toMatchObject({ value: '360.00', recordCount: 2 });
  });

  it('counts an invoice as collected only when it was fully paid on a date in the window', () => {
    const figures = computeInterimFigures(base({
      invoices: [
        invoice('paid-in', { status: 'paid', paidDate: '2026-09-12', total: '300.00' }),
        invoice('paid-out', { status: 'paid', paidDate: '2026-09-20', total: '700.00' }),
        // A partial payment carries no date; it cannot be placed in a week.
        invoice('partial', { status: 'partially_paid', total: '500.00', balanceDue: '200.00' }),
      ],
    }));
    expect(value(figures, 'sales_collected')).toMatchObject({ value: '300.00', recordCount: 1 });
  });

  it('counts what fell due in the window and still had a balance, by that balance', () => {
    // 600.00 open + 250.00 still owed on a part-paid one; the paid one owes nothing.
    const figures = computeInterimFigures(base({
      invoices: [
        invoice('due-open', { dueDate: '2026-09-09', total: '600.00', balanceDue: '600.00' }),
        invoice('due-part', { dueDate: '2026-09-13', status: 'partially_paid', total: '900.00', balanceDue: '250.00' }),
        invoice('due-paid', { dueDate: '2026-09-10', status: 'paid', paidDate: '2026-09-01', total: '100.00' }),
        invoice('bill-due', { type: 'purchase', dueDate: '2026-09-07', total: '80.00', balanceDue: '80.00' }),
      ],
    }));
    expect(value(figures, 'sales_fell_due_unpaid')).toMatchObject({ value: '850.00', recordCount: 2 });
    expect(value(figures, 'purchases_fell_due_unpaid')).toMatchObject({ value: '80.00', recordCount: 1 });
  });

  it('ignores void invoices', () => {
    const figures = computeInterimFigures(base({
      invoices: [invoice('v', { status: 'void', issueDate: '2026-09-08', total: '500.00' })],
    }));
    expect(value(figures, 'sales_invoiced')).toMatchObject({ value: '0.00', recordCount: 0 });
  });

  it('says there is no invoice data rather than reporting zero invoicing', () => {
    const figures = computeInterimFigures(base({ hasInvoiceData: false }));
    expect(figures.invoicing).toBeNull();
    expect(figures.unavailable).toContain('no_invoice_data');
  });
});

describe('determinism', () => {
  it('gives the same output for the same rows in any order', () => {
    const rows = [bank('a', '2026-09-08', '10.00'), bank('b', '2026-09-08', '10.00'), bank('c', '2026-09-09', '-3.00')];
    const one = computeInterimFigures(base({ bank: rows }));
    const two = computeInterimFigures(base({ bank: [...rows].reverse() }));
    expect(two).toEqual(one);
  });
});
