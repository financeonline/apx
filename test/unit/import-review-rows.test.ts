import { describe, expect, it } from 'vitest';
import { rowsNotShownSentence, rowsReadable } from '@/app/app/[orgSlug]/data/imports/[batchId]/rows-view';
import type { ImportBatchStatus } from '@/modules/imports';

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
    expect(rowsNotShownSentence('rolled_back')).toMatch(/rolled back, so none of its rows are in your figures/);
    expect(rowsNotShownSentence('rejected')).toMatch(/not imported, so none of its rows are in your figures/);
    expect(rowsNotShownSentence('committing')).toMatch(/being imported now/);
  });
});
