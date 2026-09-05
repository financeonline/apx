import { describe, expect, it } from 'vitest';

import {
  DEDUPE_VERSION, absoluteAmountKey, dedupeHash, detectDuplicates, detectReExport,
  normalizeBankName, normalizeDescription, scopeKey,
} from '@/modules/imports';

/**
 * Duplicate detection (IMPORT_ENGINE.md §9).
 *
 * Two failure modes matter and they pull in opposite directions. Missing a duplicate double-counts
 * revenue. Over-detecting one silently deletes a real payment — a payroll run of eight identical
 * salaries, or rent for several units on one day. Every test below pins one side or the other.
 */

const ORG = '11111111-1111-4111-8111-111111111111';

const bankKey = {
  targetTable: 'bank_transactions' as const,
  bankName: 'HSBC UK', sortCodeMasked: '12-34-56', accountNumberMasked: '4321',
};

describe('the scope key is a stable identity, never a uuid (F-B-12)', () => {
  it('keys a ledger row on the account code when there is one', () => {
    expect(scopeKey({ targetTable: 'ledger_entries', accountCode: '4000', accountNormalizedName: 'sales' }))
      .toBe('code:4000');
  });

  it('falls back to the normalised name when there is no code', () => {
    expect(scopeKey({ targetTable: 'ledger_entries', accountCode: null, accountNormalizedName: 'sales' }))
      .toBe('name:sales');
  });

  it('survives an account being renamed between exports, when it has a code', () => {
    // "4000 Sales" becomes "4000 Sales Revenue" (fixture 23). The code did not change, so the
    // re-export is still recognised as the same rows.
    const before = scopeKey({ targetTable: 'ledger_entries', accountCode: '4000', accountNormalizedName: 'sales' });
    const after = scopeKey({ targetTable: 'ledger_entries', accountCode: '4000', accountNormalizedName: 'sales revenue' });
    expect(after).toBe(before);
  });

  it('treats "HSBC UK" and "HSBC" as one bank (ADR-047.12)', () => {
    expect(normalizeBankName('HSBC UK')).toBe(normalizeBankName('HSBC'));
    expect(normalizeBankName('Barclays Bank PLC')).toBe(normalizeBankName('Barclays'));
  });

  it('keys a bank row on the masked identity, so a re-created account record still matches', () => {
    const a = scopeKey({ ...bankKey });
    const b = scopeKey({ ...bankKey, bankName: 'HSBC' });
    expect(b).toBe(a);
  });
});

describe('the normalised description identifies the payment, not the export', () => {
  it('strips transaction ids that change between exports', () => {
    expect(normalizeDescription('CARD PAYMENT TO ACME 123456789'))
      .toBe(normalizeDescription('CARD PAYMENT TO ACME 987654321'));
  });

  it('strips card-terminal and reference suffixes', () => {
    expect(normalizeDescription('TESCO STORES *1234')).toBe('tesco stores');
    expect(normalizeDescription('ACME LTD REF 000123')).toBe('acme ltd');
  });

  it('keeps short digit runs, which are part of the name', () => {
    // "7-Eleven" and "Studio 54" are names, not references.
    expect(normalizeDescription('STUDIO 54')).toBe('studio 54');
  });

  it('is insensitive to case, punctuation and spacing but not to the payee', () => {
    expect(normalizeDescription('  ACME,  LTD.  ')).toBe(normalizeDescription('acme ltd'));
    expect(normalizeDescription('ACME LTD')).not.toBe(normalizeDescription('BETA LTD'));
  });
});

describe('the hash', () => {
  const base = {
    organizationId: ORG, ...bankKey,
    date: '2026-05-04', amount: '-125.50', direction: 'outflow', description: 'ACME LTD',
  };

  it('is stable across runs', () => {
    expect(dedupeHash(base)).toBe(dedupeHash(base));
  });

  it('ignores the sign, because direction already carries it', () => {
    expect(absoluteAmountKey('-125.50')).toBe('125.50');
    expect(absoluteAmountKey('125.5')).toBe('125.50');
    expect(dedupeHash({ ...base, amount: '125.50' })).toBe(dedupeHash(base));
  });

  it('changes with the date, the amount, the direction and the payee', () => {
    expect(dedupeHash({ ...base, date: '2026-05-05' })).not.toBe(dedupeHash(base));
    expect(dedupeHash({ ...base, amount: '-125.51' })).not.toBe(dedupeHash(base));
    expect(dedupeHash({ ...base, direction: 'inflow' })).not.toBe(dedupeHash(base));
    expect(dedupeHash({ ...base, description: 'BETA LTD' })).not.toBe(dedupeHash(base));
  });

  it('never collides across organizations', () => {
    expect(dedupeHash({ ...base, organizationId: '22222222-2222-4222-8222-222222222222' }))
      .not.toBe(dedupeHash(base));
  });

  it('is versioned, so the recipe cannot change unnoticed', () => {
    expect(DEDUPE_VERSION).toBe('dedupe.v1');
  });
});

const row = (rowNumber: number, over: Partial<Parameters<typeof detectDuplicates>[0]['rows'][number]> = {}) => ({
  rowNumber,
  dedupeHash: `hash-${rowNumber}`,
  date: '2026-05-04',
  amount: '-100.00',
  scopeKey: 'bank:hsbc:123456:4321',
  normalizedDescription: 'acme ltd',
  ...over,
});

describe('the passes, in order (§9.2)', () => {
  it('flags a cross-batch exact duplicate and defaults to skipping it', () => {
    const [outcome] = detectDuplicates({
      targetTable: 'bank_transactions',
      rows: [row(2, { dedupeHash: 'h1' })],
      existingRecords: [{
        id: 'rec-1', dedupeHash: 'h1', date: '2026-05-04', amount: '-100.00',
        scopeKey: 'bank:hsbc:123456:4321', normalizedDescription: 'acme ltd',
      }],
    });
    expect(outcome!.status).toBe('duplicate');
    expect(outcome!.issues[0]!.code).toBe('IMP-DUP-001');
    expect(outcome!.suggestedDecision).toBe('skip');
    expect(outcome!.duplicateOfId).toBe('rec-1');
  });

  it('KEEPS eight identical payroll rows on one day (F-B-17)', () => {
    // The failure this prevents: defaulting to skip would silently halve a payroll run.
    const rows = Array.from({ length: 8 }, (_, i) =>
      row(i + 2, { dedupeHash: 'payroll', normalizedDescription: 'payroll june' }));
    const outcomes = detectDuplicates({
      targetTable: 'bank_transactions', rows, existingRecords: [],
    });

    const flagged = outcomes.filter((o) => o.status === 'duplicate');
    expect(flagged).toHaveLength(7);
    for (const outcome of flagged) {
      expect(outcome.suggestedDecision, 'a payroll run must not default to skip').toBe('keep');
      expect(outcome.suggestedReason).toBe('batch payment');
    }
  });

  it('keeps three or more identical rows on one day even without a payroll description', () => {
    const rows = Array.from({ length: 3 }, (_, i) => row(i + 2, { dedupeHash: 'rent', normalizedDescription: 'rent' }));
    const outcomes = detectDuplicates({ targetTable: 'bank_transactions', rows, existingRecords: [] });
    expect(outcomes.filter((o) => o.suggestedDecision === 'keep')).toHaveLength(2);
  });

  it('but defaults to skip for a plain pair of identical rows', () => {
    const rows = [row(2, { dedupeHash: 'twice' }), row(3, { dedupeHash: 'twice' })];
    const outcomes = detectDuplicates({ targetTable: 'bank_transactions', rows, existingRecords: [] });
    expect(outcomes[1]!.suggestedDecision).toBe('skip');
    expect(outcomes[1]!.issues[0]!.code).toBe('IMP-DUP-002');
    expect(outcomes[1]!.duplicateWithinBatchRow).toBe(2);
  });

  it('warns on a fuzzy match a day apart and defaults to KEEPING it', () => {
    // A payment a day apart is more often a second real payment than a re-dated duplicate, and
    // skipping it would take money out of the figures.
    const [outcome] = detectDuplicates({
      targetTable: 'bank_transactions',
      rows: [row(2, { dedupeHash: 'unique', date: '2026-05-05' })],
      existingRecords: [{
        id: 'rec-9', dedupeHash: 'other', date: '2026-05-04', amount: '-100.00',
        scopeKey: 'bank:hsbc:123456:4321', normalizedDescription: 'acme ltd',
      }],
    });
    expect(outcome!.status).toBe('warning');
    expect(outcome!.issues[0]!.code).toBe('IMP-DUP-003');
    expect(outcome!.suggestedDecision).toBe('keep');
  });

  it('does not treat a row two days apart as fuzzy', () => {
    const [outcome] = detectDuplicates({
      targetTable: 'bank_transactions',
      rows: [row(2, { dedupeHash: 'unique', date: '2026-05-06' })],
      existingRecords: [{
        id: 'rec-9', dedupeHash: 'other', date: '2026-05-04', amount: '-100.00',
        scopeKey: 'bank:hsbc:123456:4321', normalizedDescription: 'acme ltd',
      }],
    });
    expect(outcome!.status).toBe('valid');
  });
});

describe('an invoice re-exported with a payment applied is an UPDATE, not a duplicate (§9.2 pass 1)', () => {
  const existing = {
    id: 'inv-1', invoiceType: 'sales', counterparteyKey: '', counterpartyKey: 'cp-1',
    invoiceNumber: 'INV-100', totalAmount: '1200.00', amountPaid: '0.00',
    paidDate: null, dueDate: '2026-06-01', status: 'open',
  };

  it('flags a changed payment as an update and defaults to keeping it', () => {
    const [outcome] = detectDuplicates({
      targetTable: 'invoices',
      rows: [{
        ...row(2), invoiceType: 'sales', counterpartyKey: 'cp-1', invoiceNumber: 'INV-100',
        totalAmount: '1200.00', amountPaid: '1200.00', paidDate: '2026-05-20',
        dueDate: '2026-06-01', status: 'paid',
      }],
      existingRecords: [],
      existingInvoices: [existing],
    });
    expect(outcome!.issues[0]!.code).toBe('IMP-INV-010');
    // Skipping it would leave receivables permanently overstated.
    expect(outcome!.suggestedDecision).toBe('keep');
    expect(outcome!.duplicateOfId).toBe('inv-1');
  });

  it('treats an unchanged re-export as a genuine duplicate', () => {
    const [outcome] = detectDuplicates({
      targetTable: 'invoices',
      rows: [{
        ...row(2), invoiceType: 'sales', counterpartyKey: 'cp-1', invoiceNumber: 'INV-100',
        totalAmount: '1200.00', amountPaid: '0.00', paidDate: null,
        dueDate: '2026-06-01', status: 'open',
      }],
      existingRecords: [],
      existingInvoices: [existing],
    });
    expect(outcome!.status).toBe('duplicate');
    expect(outcome!.issues[0]!.code).toBe('IMP-DUP-001');
    expect(outcome!.suggestedDecision).toBe('skip');
  });
});

describe('re-export detection (IMP-COV-014)', () => {
  it('fires when an overlapping month matched fewer than half its rows', () => {
    expect(detectReExport({
      overlappingMonths: 1, rowsInOverlap: 100, duplicatesInOverlap: 30, earlierBatchId: 'b1',
    })).toBe(true);
  });

  it('stays quiet when most rows matched, which is an ordinary overlap', () => {
    expect(detectReExport({
      overlappingMonths: 1, rowsInOverlap: 100, duplicatesInOverlap: 80, earlierBatchId: 'b1',
    })).toBe(false);
  });

  it('needs a full month of overlap, so two adjacent statements do not trip it', () => {
    expect(detectReExport({
      overlappingMonths: 0, rowsInOverlap: 100, duplicatesInOverlap: 0, earlierBatchId: 'b1',
    })).toBe(false);
  });
});
