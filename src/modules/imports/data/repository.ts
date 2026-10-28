import 'server-only';
import { orgRowById, orgRows } from '@/db/rls';
import type { Db } from '@/db/types';
import type { ImportBatch, ImportRow, SourceDocument } from '../domain/types';

/**
 * Import reads. Every one of these tables is gated on `imports.review` (or, for documents, on an
 * owner/admin/employee/super-admin allow-list) rather than on plain membership, because the raw file
 * and the mapping expose more than the finished figures do (ADR-038.4). A client role therefore gets
 * zero rows here, not an error — which is the right answer to a question they may not ask.
 *
 * Reads go through `src/db/rls.ts` (FIRESTORE_DATA_MODEL.md §5), which applies each table's policy.
 */

interface Page { readonly limit: number; readonly offset: number }

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- a stored document, read field by field below

/** `app.import_batch_in_review`: the states in which a batch's file payload is still readable. */
const IN_REVIEW: ReadonlySet<string> = new Set(['created', 'parsing', 'mapping', 'validating', 'awaiting_review', 'failed']);

export async function listDocuments(
  db: Db, orgId: string, page: Page, _requestId?: string,
): Promise<SourceDocument[]> {
  const rows = await orgRows<Row>(db, orgId, 'source_documents', (q) => q
    .where('deleted_at', '==', null)
    .orderBy('created_at', 'desc')
    .offset(page.offset)
    .limit(page.limit));

  return rows.map((r) => ({
    id: r.id,
    originalFilename: r.original_filename,
    mimeType: r.mime_type,
    byteSize: Number(r.byte_size),
    documentKind: r.document_kind,
    status: r.status,
    pageCount: r.page_count,
    hasTextLayer: r.has_text_layer,
    uploadedBy: r.uploaded_by,
    createdAt: r.created_at,
  }));
}

export async function listBatches(
  db: Db, orgId: string, page: Page, _requestId?: string,
): Promise<ImportBatch[]> {
  const rows = await orgRows<Row>(db, orgId, 'import_batches', (q) => q
    .orderBy('created_at', 'desc')
    .offset(page.offset)
    .limit(page.limit));

  return rows.map((r) => ({
    id: r.id,
    sourceDocumentId: r.source_document_id,
    importType: r.import_type,
    targetTable: r.target_table,
    bankAccountId: r.bank_account_id,
    status: r.status,
    rowCounts: r.row_counts ?? {},
    periodStart: r.period_start,
    periodEnd: r.period_end,
    balanceBasis: r.balance_basis,
    committedAt: r.committed_at,
    rolledBackAt: r.rolled_back_at,
    extractionMethod: (r.extraction_method as ImportBatch['extractionMethod']) ?? 'csv',
    errorSummary: (r.error_summary as ImportBatch['errorSummary']) ?? null,
    extractionStats: (r.extraction_stats as ImportBatch['extractionStats']) ?? {},
    pageConfirmations: (r.page_confirmations as ImportBatch['pageConfirmations']) ?? {},
  }));
}

/**
 * Rows of one batch, optionally filtered to a review status. `raw_data` is returned verbatim: it is
 * the file as it arrived, including columns nobody mapped, and level-4 evidence highlighting depends
 * on it still being there (DATABASE_ARCHITECTURE.md §5).
 *
 * `raw_data` and `mapped_data` (the same text, verbatim and unmasked) are returned only while the
 * batch is IN REVIEW (not yet in the books), to whoever holds `imports.review` and reads the lines
 * (`banking.view` or `financials.view`) — the rule of the PostgreSQL view `import_rows_review`
 * (ADR-172 hardening). The `import_rows` read policy already requires those permissions; the
 * in-review rule is applied here from the batch's own status. A committed batch's rows come back
 * with no payload (the review page does not list them, and the committed records are read through
 * their own tables, masked).
 */
export async function listBatchRows(
  db: Db,
  orgId: string,
  batchId: string,
  filter: { readonly status?: ImportRow['status'] },
  page: Page,
  _requestId?: string,
): Promise<ImportRow[]> {
  const [rows, batch] = await Promise.all([
    orgRows<Row>(db, orgId, 'import_rows', (q) => {
      let query = q.where('batch_id', '==', batchId);
      if (filter.status) query = query.where('status', '==', filter.status);
      return query.orderBy('row_number').offset(page.offset).limit(page.limit);
    }),
    orgRowById<Row>(db, orgId, 'import_batches', batchId),
  ]);
  const payloadReadable = batch !== null && IN_REVIEW.has(String(batch.status));

  return rows.map((r) => ({
    id: r.id,
    rowNumber: r.row_number,
    sourceRef: r.source_ref,
    sourcePage: (r.source_page as number | null) ?? null,
    rawData: payloadReadable ? ((r.raw_data as Record<string, unknown> | null) ?? {}) : {},
    mappedData: payloadReadable ? ((r.mapped_data as ImportRow['mappedData']) ?? null) : null,
    status: r.status,
    issues: r.issues ?? [],
    reviewerDecision: r.reviewer_decision,
    reviewerReason: r.reviewer_reason,
    committedTable: r.committed_table,
    committedRecordId: r.committed_record_id,
  }));
}

/** Counts by status for the review header, without pulling every row across the wire. */
export async function countRowsByStatus(
  db: Db, orgId: string, batchId: string, _requestId?: string,
): Promise<Record<string, number>> {
  const rows = await orgRows<Row>(db, orgId, 'import_rows', (q) => q
    .where('batch_id', '==', batchId)
    .select('status'));
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.status] = (counts[row.status] ?? 0) + 1;
  return counts;
}
