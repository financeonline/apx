import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { toMotionError } from '@/core/errors';
import type { ImportBatch, ImportRow, SourceDocument } from '../domain/types';

/**
 * Import reads. Every one of these tables is gated on `imports.review` (or, for documents, on an
 * owner/admin/employee/super-admin allow-list) rather than on plain membership, because the raw file
 * and the mapping expose more than the finished figures do (ADR-038.4). A client role therefore gets
 * zero rows here, not an error — which is the right answer to a question they may not ask.
 */

interface Page { readonly limit: number; readonly offset: number }

function unwrap<T>(data: T[] | null, error: unknown, requestId?: string): T[] {
  if (error) throw toMotionError(error, requestId);
  return data ?? [];
}

export async function listDocuments(
  db: SupabaseClient, orgId: string, page: Page, requestId?: string,
): Promise<SourceDocument[]> {
  const { data, error } = await db
    .from('source_documents')
    .select(`id, original_filename, mime_type, byte_size, document_kind, status,
             page_count, has_text_layer, uploaded_by, created_at`)
    .eq('organization_id', orgId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .range(page.offset, page.offset + page.limit - 1);

  return unwrap(data, error, requestId).map((r) => ({
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
  db: SupabaseClient, orgId: string, page: Page, requestId?: string,
): Promise<ImportBatch[]> {
  const { data, error } = await db
    .from('import_batches')
    .select(`id, source_document_id, import_type, target_table, bank_account_id, status,
             row_counts, period_start, period_end, balance_basis, committed_at, rolled_back_at,
             extraction_method, error_summary, extraction_stats, page_confirmations, source_document_id`)
    .eq('organization_id', orgId)
    .order('created_at', { ascending: false })
    .range(page.offset, page.offset + page.limit - 1);

  return unwrap(data, error, requestId).map((r) => ({
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
 * `raw_data` and `mapped_data` (the same text, verbatim and unmasked) are not selectable on
 * `import_rows` since the ADR-172 hardening (migration 20261018000033). They come from the definer
 * view `import_rows_review`, which returns them while the batch is IN REVIEW (not yet in the books)
 * to whoever holds `imports.review` and reads the lines (`banking.view` or `financials.view`). It is
 * read with the same filters, order and page as the rows, so the two line up row for row; a committed
 * batch's rows come back with no payload (the review page does not list them, and the committed
 * records are read through their own tables, masked).
 */
export async function listBatchRows(
  db: SupabaseClient,
  orgId: string,
  batchId: string,
  filter: { readonly status?: ImportRow['status'] },
  page: Page,
  requestId?: string,
): Promise<ImportRow[]> {
  let query = db
    .from('import_rows')
    .select(`id, row_number, source_ref, source_page, status, issues,
             reviewer_decision, reviewer_reason, committed_table, committed_record_id`)
    .eq('organization_id', orgId)
    .eq('batch_id', batchId);
  let payloadQuery = db
    .from('import_rows_review')
    .select('id, raw_data, mapped_data')
    .eq('organization_id', orgId)
    .eq('batch_id', batchId);

  if (filter.status) {
    query = query.eq('status', filter.status);
    payloadQuery = payloadQuery.eq('status', filter.status);
  }

  const [{ data, error }, payload] = await Promise.all([
    query.order('row_number').range(page.offset, page.offset + page.limit - 1),
    payloadQuery.order('row_number').range(page.offset, page.offset + page.limit - 1),
  ]);
  const payloads = new Map(
    unwrap(payload.data, payload.error, requestId).map((r) => [
      r.id as string,
      { raw: (r.raw_data as Record<string, unknown> | null) ?? {}, mapped: r.mapped_data as ImportRow['mappedData'] },
    ]),
  );

  return unwrap(data, error, requestId).map((r) => ({
    id: r.id,
    rowNumber: r.row_number,
    sourceRef: r.source_ref,
    sourcePage: (r.source_page as number | null) ?? null,
    rawData: payloads.get(r.id as string)?.raw ?? {},
    mappedData: payloads.get(r.id as string)?.mapped ?? null,
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
  db: SupabaseClient, orgId: string, batchId: string, requestId?: string,
): Promise<Record<string, number>> {
  const { data, error } = await db
    .from('import_rows')
    .select('status')
    .eq('organization_id', orgId)
    .eq('batch_id', batchId);

  const rows = unwrap(data, error, requestId);
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.status] = (counts[row.status] ?? 0) + 1;
  return counts;
}
