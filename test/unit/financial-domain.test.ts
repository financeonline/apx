import { describe, expect, it } from 'vitest';

import {
  CATEGORY_ACCOUNT_TYPE, PNL_CATEGORIES, STANDARD_CATEGORIES,
  MergeCounterpartiesInput, RemapAccountInput, SetOpeningBalanceInput, MoneyStringSchema,
  IsoDateSchema, type StandardCategory,
} from '@/modules/financials';
import { CASH_NEUTRAL_TRANSFER_KINDS, transferKindFor } from '@/modules/banking';
import { IMPORT_TARGET, DecideImportRowsInput, StartImportBatchInput } from '@/modules/imports';

/**
 * These maps and schemas each have a twin in SQL. The integration suite asserts the two agree; these
 * unit tests assert the TypeScript side is internally coherent and rejects what it should.
 */

describe('the standard category model (ADR-004)', () => {
  it('has exactly the 26 categories the enum declares', () => {
    expect(STANDARD_CATEGORIES).toHaveLength(26);
    expect(new Set(STANDARD_CATEGORIES).size).toBe(26);
  });

  it('assigns every category exactly one account type', () => {
    for (const category of STANDARD_CATEGORIES) {
      expect(CATEGORY_ACCOUNT_TYPE[category], `${category} has no account type`).toBeDefined();
    }
    expect(Object.keys(CATEGORY_ACCOUNT_TYPE)).toHaveLength(26);
  });

  it('keeps the two holding categories out of income and expense', () => {
    // A transfer or an unmapped movement classed as income or expense would silently move profit.
    expect(CATEGORY_ACCOUNT_TYPE.transfer).toBe('asset');
    expect(CATEGORY_ACCOUNT_TYPE.uncategorised).toBe('asset');
  });

  it('builds the P&L only from income and expense categories', () => {
    for (const category of PNL_CATEGORIES) {
      expect(['income', 'expense'], `${category} is not a P&L line`)
        .toContain(CATEGORY_ACCOUNT_TYPE[category]);
    }
  });

  it('puts every income and expense category on the P&L', () => {
    const statementLines = STANDARD_CATEGORIES.filter(
      (c) => CATEGORY_ACCOUNT_TYPE[c] === 'income' || CATEGORY_ACCOUNT_TYPE[c] === 'expense',
    );
    expect([...PNL_CATEGORIES].sort()).toEqual([...statementLines].sort());
  });
});

describe('transfer kinds (ADR-028, ADR-047.12)', () => {
  it('treats only a current/savings pairing as cash-neutral', () => {
    expect(transferKindFor('current', 'savings')).toBe('cash_transfer');
    expect(transferKindFor('savings', 'current')).toBe('cash_transfer');
    expect(transferKindFor('current', 'current')).toBe('cash_transfer');
  });

  it('keeps a card repayment and a loan repayment in the cash figures', () => {
    // These move real money out of the business. Excluding them would understate cash outflow.
    expect(transferKindFor('current', 'credit_card')).toBe('card_repayment');
    expect(transferKindFor('current', 'loan')).toBe('loan_repayment');
    expect(CASH_NEUTRAL_TRANSFER_KINDS).not.toContain('card_repayment');
    expect(CASH_NEUTRAL_TRANSFER_KINDS).not.toContain('loan_repayment');
  });

  it('names exactly one cash-neutral kind', () => {
    expect(CASH_NEUTRAL_TRANSFER_KINDS).toEqual(['cash_transfer']);
  });

  it('is symmetric in its two arguments', () => {
    const types = ['current', 'savings', 'credit_card', 'loan', 'other'] as const;
    for (const a of types) {
      for (const b of types) {
        expect(transferKindFor(a, b), `${a}/${b}`).toBe(transferKindFor(b, a));
      }
    }
  });
});

describe('import targets', () => {
  it('routes every import type to a record table', () => {
    const types = Object.keys(IMPORT_TARGET);
    expect(types).toHaveLength(10);
    expect(IMPORT_TARGET.bank_statement).toBe('bank_transactions');
    expect(IMPORT_TARGET.trial_balance).toBe('period_balances');
    expect(IMPORT_TARGET.general_ledger).toBe('ledger_entries');
    // SOW §6: a sales or purchase REPORT is a list of invoices, not a ledger.
    expect(IMPORT_TARGET.sales_report).toBe('invoices');
    expect(IMPORT_TARGET.purchase_report).toBe('invoices');
  });
});

describe('money and date validation (ADR-006)', () => {
  it('accepts what NUMERIC(18,2) can hold', () => {
    for (const value of ['0', '0.00', '-12.34', '1234567890.99', '10']) {
      expect(MoneyStringSchema.safeParse(value).success, value).toBe(true);
    }
  });

  it('rejects over-precise and non-numeric amounts rather than rounding them silently', () => {
    for (const value of ['1.234', '1e5', 'NaN', 'Infinity', '', '1,234.00', '0x10', '--1']) {
      expect(MoneyStringSchema.safeParse(value).success, value).toBe(false);
    }
  });

  it('rejects a date that matches the pattern but does not exist', () => {
    expect(IsoDateSchema.safeParse('2026-03-31').success).toBe(true);
    expect(IsoDateSchema.safeParse('2026-02-30').success).toBe(false);
    expect(IsoDateSchema.safeParse('2026-13-01').success).toBe(false);
  });
});

describe('write-input validation', () => {
  // Valid v4 UUIDs: zod 4 checks the RFC 4122 version and variant nibbles, and every real id in the
  // system comes from Postgres `gen_random_uuid()`, which is v4.
  it('refuses a merge of a counterparty into itself', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    expect(MergeCounterpartiesInput.safeParse({ fromId: id, intoId: id }).success).toBe(false);
  });

  it('refuses an opening balance with an amount but no date', () => {
    const base = { bankAccountId: '11111111-1111-4111-8111-111111111111' };
    expect(SetOpeningBalanceInput.safeParse({ ...base, amount: '10.00', date: null }).success)
      .toBe(false);
    expect(SetOpeningBalanceInput.safeParse({ ...base, amount: null, date: null }).success)
      .toBe(true);
  });

  it('refuses an unknown standard category', () => {
    const result = RemapAccountInput.safeParse({
      accountId: '11111111-1111-4111-8111-111111111111',
      standardCategory: 'made_up' as StandardCategory,
    });
    expect(result.success).toBe(false);
  });

  it('requires a bank account for a statement import', () => {
    const base = { documentId: '11111111-1111-4111-8111-111111111111', importType: 'bank_statement' };
    expect(StartImportBatchInput.safeParse(base).success).toBe(false);
    expect(StartImportBatchInput.safeParse({
      ...base, bankAccountId: '22222222-2222-4222-8222-222222222222',
    }).success).toBe(true);
  });

  it('refuses a declared range that ends before it starts', () => {
    const result = StartImportBatchInput.safeParse({
      documentId: '11111111-1111-4111-8111-111111111111',
      importType: 'general_ledger',
      periodStart: '2026-03-01',
      periodEnd: '2026-02-01',
    });
    expect(result.success).toBe(false);
  });

  it('demands a reason for keeping a duplicate and for skipping a valid row', () => {
    const rowId = '33333333-3333-4333-8333-333333333333';
    const batchId = '44444444-4444-4444-8444-444444444444';

    expect(DecideImportRowsInput.safeParse({
      batchId, decisions: [{ rowId, decision: 'keep', currentStatus: 'duplicate' }],
    }).success, 'keeping a duplicate without a reason').toBe(false);

    expect(DecideImportRowsInput.safeParse({
      batchId, decisions: [{ rowId, decision: 'skip', currentStatus: 'valid' }],
    }).success, 'skipping a valid row without a reason').toBe(false);

    expect(DecideImportRowsInput.safeParse({
      batchId,
      decisions: [{ rowId, decision: 'keep', currentStatus: 'duplicate', reason: 'Genuine repeat charge' }],
    }).success, 'keeping a duplicate with a reason').toBe(true);

    // Skipping a row that already failed validation needs no explanation: the issue is the reason.
    expect(DecideImportRowsInput.safeParse({
      batchId, decisions: [{ rowId, decision: 'skip', currentStatus: 'error' }],
    }).success, 'skipping an error row').toBe(true);
  });
});
