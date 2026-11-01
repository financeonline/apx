import type { ImportBatchStatus } from '@/modules/imports';

/**
 * Whether the review page may draw a batch's rows as the file wrote them (ADR-172 hardening,
 * 2026-10-14; migration 20261018000033).
 *
 * `import_rows.raw_data` and `mapped_data` — the file verbatim, unmasked — are served only by the
 * definer view `import_rows_review`, and only while the batch is IN REVIEW (`app.import_batch_in_review`:
 * created, parsing, mapping, validating, awaiting review, failed). Once a batch is committing,
 * committed, rolled back or rejected the view returns no payload, so `listBatchRows` hands the page
 * empty rows; drawn, they would read "(empty row)" four hundred times. This is the TypeScript copy of
 * that list, for drawing only — the view is the authority, and a status it adds later only ever
 * makes this page show a sentence where it could have shown rows, never the reverse.
 *
 * An allow-list of the in-review statuses, so a status the enum gains later is treated as "not in
 * review" (nothing drawn) rather than as rows the view would not return.
 */
const IN_REVIEW: ReadonlySet<ImportBatchStatus> = new Set<ImportBatchStatus>([
  'created', 'parsing', 'mapping', 'validating', 'awaiting_review', 'failed',
]);

export function rowsReadable(status: ImportBatchStatus): boolean {
  return IN_REVIEW.has(status);
}

/**
 * The short sentence drawn in place of the rows once the batch has left review — what became of
 * them, in the reader's words. Null while the rows are drawn.
 */
export function rowsNotShownSentence(status: ImportBatchStatus): string | null {
  if (rowsReadable(status)) return null;
  switch (status) {
    case 'committing':
      return 'These rows are being imported now. Once they are in, you will find them in the records they became.';
    case 'committed':
      return 'These rows are part of your figures now, in the records they became. A file’s own lines are shown only while it is in review.';
    case 'rolled_back':
      return 'This import was removed, so none of its rows are in your figures. A file’s own lines are shown only while it is in review.';
    case 'rejected':
      return 'This file was not imported, so none of its rows are in your figures. A file’s own lines are shown only while it is in review.';
    default:
      return 'A file’s own lines are shown only while it is in review.';
  }
}

/** A figure as a file writes one: `2500.00`, `-1,234.56`, `(75.00)`, `£12`. Not a date (`2026-01-01`, `01.02.2026`). */
const FIGURE = /^[-+(]?[£$€]?\s?\d[\d,]*(\.\d+)?\)?$/;

/**
 * One line of the file in a few words, for the review page ("What it says", unreadable rows,
 * possible duplicates). Empty cells are left out, so a figure carries its column's heading —
 * `Paid Out 2500.00`, not a bare `2500.00` that reads the same whether money went out or came in.
 */
export function summariseRow(raw: Readonly<Record<string, unknown>>): string {
  return Object.entries(raw)
    .filter(([, value]) => value !== null && value !== undefined && String(value).trim() !== '')
    .slice(0, 6)
    .map(([key, value]) => {
      const text = String(value).trim();
      const heading = key.trim();
      return FIGURE.test(text) && /[A-Za-z]/.test(heading) && heading !== text ? `${heading} ${text}` : text;
    })
    .join(' · ') || '(empty row)';
}
