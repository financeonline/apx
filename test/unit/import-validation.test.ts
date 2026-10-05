import { describe, expect, it } from 'vitest';

import {
  REQUIRED_FIELDS, checkBatch, looksLikeOpenItems, requiredConfirmations, satisfiedFieldSet,
  statusForIssues, validateRow,
} from '@/modules/imports';

/**
 * Row and batch validation (IMPORT_ENGINE.md §8).
 *
 * The property every test here defends: **an invalid record is surfaced, never discarded.** A row
 * that cannot be read becomes an `error` a human must resolve; a row that is merely odd becomes a
 * warning that follows the figures downstream. Nothing is coerced to zero, nothing is dropped, and
 * no default is applied where the document says a human must choose.
 */

const ctx = {
  importType: 'bank_statement' as const,
  targetTable: 'bank_transactions' as const,
  baseCurrency: 'GBP',
  declaredPeriodStart: '2026-05-01',
  declaredPeriodEnd: '2026-05-31',
  today: '2026-06-15',
};

const codes = (issues: ReturnType<typeof validateRow>) => issues.map((i) => i.code);
const row = (mapped: Record<string, string | null>, over = {}) =>
  ({ rowNumber: 2, mapped, ...over });

describe('required fields (§6.1)', () => {
  it('accepts either of the alternative field sets for a bank statement', () => {
    expect(satisfiedFieldSet('bank_statement', new Set(['transaction_date', 'description', 'amount'])))
      .toEqual(['transaction_date', 'description', 'amount']);
    expect(satisfiedFieldSet('bank_statement',
      new Set(['transaction_date', 'description', 'money_in', 'money_out'])))
      .toEqual(['transaction_date', 'description', 'money_in', 'money_out']);
  });

  it('returns null when neither set is satisfied, so the mapping step cannot be skipped', () => {
    // §15 row 1: MOTION never guesses a column or imports with blanks.
    expect(satisfiedFieldSet('bank_statement', new Set(['transaction_date']))).toBeNull();
  });

  it('defines an alternative set for every import type', () => {
    for (const [type, alternatives] of Object.entries(REQUIRED_FIELDS)) {
      expect(alternatives.length, `${type} has no required fields`).toBeGreaterThan(0);
    }
  });

  it('reports each missing required field individually', () => {
    const issues = validateRow(row({ transaction_date: '2026-05-04' }), ctx,
      ['transaction_date', 'description', 'amount']);
    const required = issues.filter((i) => i.code === 'IMP-REQ-003');
    expect(required).toHaveLength(2);
    expect(required.map((i) => i.field).sort()).toEqual(['amount', 'description']);
  });
});

describe('paired money columns are either-or, not both', () => {
  // The commonest bank statement layout has separate in and out columns and every row fills exactly
  // one. Requiring both would fail every such file entirely — which an end-to-end run found.
  const pairCtx = { ...ctx };
  const required = ['transaction_date', 'description', 'money_in', 'money_out'];

  it('accepts a row with money out only', () => {
    const issues = validateRow(
      row({ transaction_date: '2026-05-04', description: 'TESCO', money_out: '24.10', money_in: null }),
      pairCtx, required);
    expect(codes(issues)).not.toContain('IMP-REQ-003');
  });

  it('accepts a row with money in only', () => {
    const issues = validateRow(
      row({ transaction_date: '2026-05-04', description: 'SALARY', money_in: '2500.00', money_out: null }),
      pairCtx, required);
    expect(codes(issues)).not.toContain('IMP-REQ-003');
  });

  it('rejects a row with neither, once rather than twice', () => {
    const issues = validateRow(
      row({ transaction_date: '2026-05-04', description: 'X', money_in: null, money_out: null }),
      pairCtx, required);
    const missing = issues.filter((i) => i.code === 'IMP-REQ-003');
    expect(missing).toHaveLength(1);
    expect(missing[0]!.message).toContain('neither');
  });

  it('still requires the unpaired fields individually', () => {
    const issues = validateRow(
      row({ transaction_date: null, description: 'X', money_out: '1.00' }), pairCtx, required);
    expect(issues.filter((i) => i.code === 'IMP-REQ-003').map((i) => i.field)).toEqual(['transaction_date']);
  });

  it('applies the same rule to a ledger debit and credit pair', () => {
    const glCtx = { ...ctx, importType: 'general_ledger' as const, targetTable: 'ledger_entries' as const };
    const issues = validateRow(
      row({ entry_date: '2026-05-04', account: 'Sales', debit: null, credit: '100.00' }),
      glCtx, ['entry_date', 'account', 'debit', 'credit']);
    expect(codes(issues)).not.toContain('IMP-REQ-003');
  });
});

describe('a line that is not data is recorded, not dropped', () => {
  it('marks a non-tabular line as skipped with IMP-ROW-005', () => {
    const issues = validateRow(row({}, { nonTabular: true }), ctx, []);
    expect(codes(issues)).toEqual(['IMP-ROW-005']);
    expect(statusForIssues(issues)).toBe('skipped');
  });

  it('records a blank row rather than removing it', () => {
    const issues = validateRow(row({ amount: null, description: null }), ctx, []);
    expect(codes(issues)).toEqual(['IMP-ROW-002']);
    expect(statusForIssues(issues)).toBe('warning');
  });

  it('keeps a row whose column count is wrong, as an error to resolve', () => {
    const issues = validateRow(
      row({ transaction_date: '2026-05-04', amount: '-1.00', description: 'X' },
          { fieldCountMismatch: true }), ctx, []);
    expect(codes(issues)).toContain('IMP-ROW-001');
    expect(statusForIssues(issues), 'a malformed row blocks commit until a human decides').toBe('error');
  });
});

describe('dates', () => {
  const full = { transaction_date: '2026-05-04', description: 'X', amount: '-1.00' };

  it('rejects an unreadable date rather than guessing', () => {
    const issues = validateRow(row({ ...full, transaction_date: 'not a date' }), ctx, []);
    expect(codes(issues)).toContain('IMP-DATE-001');
  });

  it('rejects a date that looks valid but does not exist', () => {
    const issues = validateRow(row({ ...full, transaction_date: '2026-02-30' }), ctx, []);
    expect(codes(issues)).toContain('IMP-DATE-001');
  });

  it('warns on a date more than five years old, and one far in the future', () => {
    expect(codes(validateRow(row({ ...full, transaction_date: '2015-01-01' }), ctx, [])))
      .toContain('IMP-DATE-002');
    expect(codes(validateRow(row({ ...full, transaction_date: '2027-01-01' }), ctx, [])))
      .toContain('IMP-DATE-002');
  });

  it('errors on a date outside the declared export range (ADR-047.6)', () => {
    // The declared range is the contract for what the file covers. A row outside it means one of
    // the two is wrong, and a human has to say which.
    const issues = validateRow(row({ ...full, transaction_date: '2026-04-30' }), ctx, []);
    expect(codes(issues)).toContain('IMP-PERIOD-004');
    expect(statusForIssues(issues)).toBe('error');
  });

  it('flags a row whose reading changes under the other day/month order', () => {
    const issues = validateRow(row(full), { ...ctx, ambiguousDateRows: new Set([2]) }, []);
    expect(codes(issues)).toContain('IMP-DATE-003');
  });
});

describe('amounts', () => {
  const full = { transaction_date: '2026-05-04', description: 'X' };

  it('rejects an unreadable amount rather than coercing it to zero', () => {
    // §15: MOTION never coerces to zero or "strips and hopes".
    const issues = validateRow(row({ ...full, amount: '12,,34' }), ctx, []);
    expect(codes(issues)).toContain('IMP-AMT-002');
    expect(statusForIssues(issues)).toBe('error');
  });

  it('rejects a row carrying both money in and money out', () => {
    const issues = validateRow(row({ ...full, money_in: '10.00', money_out: '5.00' }), ctx, []);
    expect(codes(issues)).toContain('IMP-AMT-002');
  });

  it('warns on a zero amount but does not block it', () => {
    const issues = validateRow(row({ ...full, amount: '0.00' }), ctx, []);
    expect(codes(issues)).toContain('IMP-AMT-003');
    expect(statusForIssues(issues)).toBe('warning');
  });

  it('warns on a hundredfold outlier, which is usually a decimal error', () => {
    const issues = validateRow(row({ ...full, amount: '50000.00' }),
      { ...ctx, amountMedian: '100.00' }, []);
    expect(codes(issues)).toContain('IMP-AMT-004');
  });

  it('does not warn on an ordinary large payment', () => {
    const issues = validateRow(row({ ...full, amount: '500.00' }),
      { ...ctx, amountMedian: '100.00' }, []);
    expect(codes(issues)).not.toContain('IMP-AMT-004');
  });

  it('rejects a foreign currency rather than importing it as sterling (CD-10)', () => {
    const issues = validateRow(row({ ...full, amount: '-1.00', currency: 'EUR' }), ctx, []);
    expect(codes(issues)).toContain('IMP-CUR-007');
    expect(statusForIssues(issues)).toBe('error');
  });
});

describe('invoices', () => {
  const invoiceCtx = { ...ctx, importType: 'sales_invoices' as const, targetTable: 'invoices' as const };
  const base = { issue_date: '2026-05-04', invoice_number: 'INV-1', total_amount: '1200.00' };

  it('errors when more has been paid than was invoiced', () => {
    const issues = validateRow(row({ ...base, amount_paid: '1300.00' }), invoiceCtx, []);
    expect(codes(issues)).toContain('IMP-INV-008');
  });

  it('errors when subtotal and tax do not add up to the total', () => {
    const issues = validateRow(
      row({ ...base, subtotal: '1000.00', tax_amount: '150.00' }), invoiceCtx, []);
    expect(codes(issues)).toContain('IMP-INV-011');
  });

  it('accepts a rounding difference within a penny', () => {
    const issues = validateRow(
      row({ ...base, subtotal: '1000.00', tax_amount: '200.005' }), invoiceCtx, []);
    expect(codes(issues)).not.toContain('IMP-INV-011');
  });

  it('treats a zero subtotal as absent rather than as a contradiction (ADR-047.5)', () => {
    // Many exports leave the subtotal blank as zero; failing those would block every such file.
    const issues = validateRow(
      row({ ...base, subtotal: '0', tax_amount: '200.00' }), invoiceCtx, []);
    expect(codes(issues)).not.toContain('IMP-INV-011');
  });

  it('warns when the due date precedes the issue date', () => {
    const issues = validateRow(
      row({ ...base, due_date: '2026-05-01' }), invoiceCtx, []);
    expect(codes(issues)).toContain('IMP-INV-009');
  });
});

describe('accounts', () => {
  const glCtx = { ...ctx, importType: 'general_ledger' as const, targetTable: 'ledger_entries' as const };

  it('errors on a ledger row with no account', () => {
    const issues = validateRow(row({ entry_date: '2026-05-04', amount: '1.00' }), glCtx, []);
    expect(codes(issues)).toContain('IMP-ACCT-006');
  });

  it('warns, but does not block, an account that maps to nothing yet', () => {
    const issues = validateRow(
      row({ entry_date: '2026-05-04', amount: '1.00', account: 'Mystery' }),
      { ...glCtx, uncategorisedAccounts: new Set(['Mystery']) }, []);
    expect(codes(issues)).toContain('IMP-ACCT-005');
    expect(statusForIssues(issues), 'unmapped accounts are allowed, and marked incomplete downstream')
      .toBe('warning');
  });
});

describe('batch-level checks (§8.2)', () => {
  it('errors when a statement does not reconcile to its balances', () => {
    const issues = checkBatch({
      targetTable: 'bank_transactions', importType: 'bank_statement',
      amounts: ['-100.00', '50.00'], openingBalance: '1000.00', closingBalance: '900.00',
    });
    // Movement is −50, expected is −100.
    expect(issues.map((i) => i.code)).toContain('IMP-BAL-006');
  });

  it('passes when it does reconcile', () => {
    const issues = checkBatch({
      targetTable: 'bank_transactions', importType: 'bank_statement',
      amounts: ['-100.00', '50.00'], openingBalance: '1000.00', closingBalance: '950.00',
    });
    expect(issues.map((i) => i.code)).not.toContain('IMP-BAL-006');
  });

  it('reconciles a liability account the other way round (ADR-028)', () => {
    // On a credit card a purchase increases what is owed, so the movement is negated.
    const issues = checkBatch({
      targetTable: 'bank_transactions', importType: 'bank_statement',
      amounts: ['-100.00'], openingBalance: '500.00', closingBalance: '600.00',
      liabilityAccount: true,
    });
    expect(issues.map((i) => i.code)).not.toContain('IMP-BAL-006');
  });

  it('warns rather than blocking when the balances could not be captured', () => {
    const issues = checkBatch({
      targetTable: 'bank_transactions', importType: 'bank_statement',
      amounts: ['-100.00'], openingBalance: null, closingBalance: null,
    });
    const codes = issues.map((i) => i.code);
    expect(codes).toContain('IMP-BAL-007');
    expect(codes, 'an unreconciled statement still imports, flagged').not.toContain('IMP-BAL-006');
  });

  it('locates a break in the running balance chain', () => {
    const issues = checkBatch({
      targetTable: 'bank_transactions', importType: 'bank_statement',
      amounts: ['-100.00', '-50.00'], openingBalance: '1000.00', closingBalance: '850.00',
      balanceChain: ['900.00', '800.00'],
    });
    const chainIssue = issues.find((i) => i.code === 'IMP-BAL-006' && i.detail && 'atRow' in i.detail);
    expect(chainIssue, 'the reviewer must be told WHERE it broke').toBeDefined();
  });

  it('errors when a trial balance does not balance', () => {
    const issues = checkBatch({
      targetTable: 'period_balances', importType: 'trial_balance',
      amounts: [], debits: ['100.00'], credits: ['90.00'],
    });
    expect(issues.map((i) => i.code)).toContain('IMP-TB-011');
  });

  it('only warns on an unbalanced journal, because partial exports are common', () => {
    const issues = checkBatch({
      targetTable: 'ledger_entries', importType: 'general_ledger', amounts: [],
      journals: [
        { ref: 'J1', debit: '100.00', credit: '0' },
        { ref: 'J1', debit: '0', credit: '99.99' },
      ],
    });
    const issue = issues.find((i) => i.code === 'IMP-GL-010');
    expect(issue?.severity).toBe('warning');
  });

  it('errors when a total row does not equal its block', () => {
    // An error, because a mis-detected block would double revenue or expenses.
    const issues = checkBatch({
      targetTable: 'period_balances', importType: 'pnl_report', amounts: [],
      totalsBlocks: [{ label: 'Total income', total: '1000.00', blockSum: '900.00' }],
    });
    const issue = issues.find((i) => i.code === 'IMP-TOT-014');
    expect(issue?.severity).toBe('error');
  });
});

describe('confirmations block a commit until a human records them (§8.2)', () => {
  it('always requires the declared export range', () => {
    expect(requiredConfirmations({ targetTable: 'bank_transactions', importType: 'bank_statement' }))
      .toContain('IMP-RANGE-015');
  });

  it('requires the balance basis for a balance target', () => {
    expect(requiredConfirmations({ targetTable: 'period_balances', importType: 'trial_balance' }))
      .toContain('IMP-TB-012');
  });

  it('asks whether a trial balance or P&L report lists every account (IMP-TB-016, N-1); never of a balance sheet', () => {
    expect(requiredConfirmations({ targetTable: 'period_balances', importType: 'trial_balance' })).toContain('IMP-TB-016');
    expect(requiredConfirmations({ targetTable: 'period_balances', importType: 'pnl_report' })).toContain('IMP-TB-016');
    expect(requiredConfirmations({ targetTable: 'period_balances', importType: 'balance_sheet' })).not.toContain('IMP-TB-016');
    expect(requiredConfirmations({ targetTable: 'ledger_entries', importType: 'general_ledger' })).not.toContain('IMP-TB-016');
  });

  it('R-2: asks of every invoice list whether it holds every invoice unpaid at its start (IMP-INV-013), of nothing else', () => {
    expect(requiredConfirmations({ targetTable: 'invoices', importType: 'sales_invoices' })).toContain('IMP-INV-013');
    expect(requiredConfirmations({ targetTable: 'invoices', importType: 'purchase_invoices' })).toContain('IMP-INV-013');
    expect(requiredConfirmations({ targetTable: 'bank_transactions', importType: 'bank_statement' })).not.toContain('IMP-INV-013');
    expect(requiredConfirmations({ targetTable: 'period_balances', importType: 'trial_balance' })).not.toContain('IMP-INV-013');
  });

  it('requires the balance sign only for a single signed column', () => {
    expect(requiredConfirmations({
      targetTable: 'period_balances', importType: 'pnl_report', singleSignedBalanceColumn: true,
    })).toContain('IMP-TB-013');
    expect(requiredConfirmations({
      targetTable: 'period_balances', importType: 'pnl_report', singleSignedBalanceColumn: false,
    })).not.toContain('IMP-TB-013');
  });

  it('requires the open-items confirmation for an aged-debtors list', () => {
    expect(requiredConfirmations({
      targetTable: 'invoices', importType: 'sales_invoices', looksLikeOpenItems: true,
    })).toContain('IMP-INV-012');
  });
});

describe('open-items detection (ADR-047.10)', () => {
  it('recognises an aged-debtors list: few paid, spanning months', () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({
      paid: i === 0,
      issueDate: `2026-0${1 + (i % 4)}-1${i % 9}`,
    }));
    expect(looksLikeOpenItems(rows)).toBe(true);
  });

  it('does not mistake a normal month of sales for one', () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({ paid: i % 2 === 0, issueDate: '2026-05-04' }));
    expect(looksLikeOpenItems(rows)).toBe(false);
  });

  it('says no for an empty list rather than guessing', () => {
    expect(looksLikeOpenItems([])).toBe(false);
  });
});
