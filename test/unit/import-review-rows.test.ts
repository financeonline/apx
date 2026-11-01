import { describe, expect, it } from 'vitest';
import { rowsNotShownSentence, rowsReadable, summariseRow } from '@/app/app/[orgSlug]/data/imports/[batchId]/rows-view';
import { blockingReasonFor, rowsRead, type ImportBatchStatus } from '@/modules/imports';

/**
 * The import review page draws a batch's rows as the file wrote them only while the batch is in
 * review — the statuses `app.import_batch_in_review` admits, the only ones for which
 * `import_rows_review` returns `raw_data`/`mapped_data` (ADR-172 hardening, migration
 * 20261018000033). Afterwards the rows come back empty and the page says what became of them.
 */

const IN_REVIEW: readonly ImportBatchStatus[] = ['created', 'parsing', 'mapping', 'validating', 'awaiting_review', 'failed'];
const AFTER_REVIEW: readonly ImportBatchStatus[] = ['committing', 'committed', 'rolled_back', 'rejected'];

describe('rows are drawn only while the batch is in review', () => {
  it.each(IN_REVIEW)('draws the rows of a %s batch', (status) => {
    expect(rowsReadable(status)).toBe(true);
    expect(rowsNotShownSentence(status)).toBeNull();
  });

  it.each(AFTER_REVIEW)('draws a sentence, not empty rows, for a %s batch', (status) => {
    expect(rowsReadable(status)).toBe(false);
    const sentence = rowsNotShownSentence(status);
    expect(sentence).toBeTruthy();
    expect(sentence).not.toMatch(/undefined|null|empty row/i);
  });

  it('says what became of the rows', () => {
    expect(rowsNotShownSentence('committed')).toMatch(/part of your figures/);
    expect(rowsNotShownSentence('rolled_back')).toMatch(/removed, so none of its rows are in your figures/);
    expect(rowsNotShownSentence('rejected')).toMatch(/not imported, so none of its rows are in your figures/);
    expect(rowsNotShownSentence('committing')).toMatch(/being imported now/);
  });
});

describe('a row in the reviewer\'s words', () => {
  it('names the column a figure came from, so money in and money out read differently', () => {
    const out = { Date: '2026-01-01', Description: 'RENT WAREHOUSE LTD', 'Paid Out': '2500.00', 'Paid In': '', Balance: '15500.00' };
    const into = { Date: '2026-01-30', Description: 'FPS CREDIT ACME', 'Paid Out': '', 'Paid In': '14399.46', Balance: '26992.34' };
    expect(summariseRow(out)).toBe('2026-01-01 · RENT WAREHOUSE LTD · Paid Out 2500.00 · Balance 15500.00');
    expect(summariseRow(into)).toBe('2026-01-30 · FPS CREDIT ACME · Paid In 14399.46 · Balance 26992.34');
  });

  it('leaves dates, text and a heading line as the file wrote them', () => {
    expect(summariseRow({ Date: 'Date', Amount: 'Amount' })).toBe('Date · Amount');
    expect(summariseRow({ Date: '01.02.2026', Amount: '-1,234.56' })).toBe('01.02.2026 · Amount -1,234.56');
    expect(summariseRow({ '3': '12.00' })).toBe('12.00');
  });

  it('says so when the row is empty', () => {
    expect(summariseRow({ a: '', b: null })).toBe('(empty row)');
  });
});

describe('how many rows a batch read (the Imports list)', () => {
  it('is the stored total, not the total plus every per-status count', () => {
    expect(rowsRead({ valid: 108, skipped: 1, total: 109 })).toBe(109);
    expect(rowsRead({ committed: 108, skipped: 1, total: 109 })).toBe(109);
  });

  it('falls back to adding the statuses when a batch has no total', () => {
    expect(rowsRead({ valid: 5, skipped: 1 })).toBe(6);
    expect(rowsRead(null)).toBe(0);
  });
});

describe('the Import button and file-level errors', () => {
  type Args = Parameters<typeof blockingReasonFor>;
  const batch = { status: 'awaiting_review' } as unknown as Args[0];
  const meta = (batchIssues: Args[2]['batchIssues']): Args[2] => ({
    filename: 'tb_march_off.xlsx', openingBalance: null, closingBalance: null,
    batchIssues, requiredConfirmations: [], confirmedCodes: [],
  });

  it('names the problem when the database would refuse the file (fixtures/imports/tb_march_off.xlsx)', () => {
    const reason = blockingReasonFor(batch, 13, meta([{ code: 'IMP-TB-011', severity: 'error', message: 'This trial balance does not balance.' }]), [], []);
    expect(reason).toMatch(/cannot be imported until .*does not balance/);
  });

  it('lets a warning through, as the database does', () => {
    expect(blockingReasonFor(batch, 5, meta([{ code: 'IMP-BAL-007', severity: 'warning', message: 'not reconciled' }]), [], [])).toBeNull();
  });
});
