import 'server-only';
import { callApi } from '@/core/db/api-rpc';
import { NotFound } from '@/core/errors';
import { log } from '@/core/logging';
import { assertCan } from '@/core/permissions';
import { removeObject, SOURCE_DOCUMENTS_BUCKET } from '@/core/storage/signer';
import type { AccessContext } from '@/modules/tenancy';
import { orgRowById, orgRows } from '@/db/rls';
import type { Db } from '@/db/types';

/**
 * The document library (ROUTE_ARCHITECTURE.md §127–128; SERVICE_ARCHITECTURE.md §documents;
 * ADR-043.4; R2-A-09). Reads run under the caller's read policy (`src/db/rls.ts`) — `source_documents`
 * is an allow-list of owner/admin/employee/super_admin, never a client (R2-A-07). Deleting is `api.delete_document`,
 * which refuses a quarantined file and one an import still rests on, marks the row and returns the
 * path; the signer then removes the object, and `storage.cleanup_orphans` finishes the job if that
 * fails. The row is never removed: it is the record that a file existed.
 */

export interface DocumentSummary {
  readonly id: string;
  readonly filename: string;
  readonly kind: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly status: string;
  readonly pageCount: number | null;
  readonly hasTextLayer: boolean | null;
  readonly createdAt: string;
  readonly deletedAt: string | null;
  /** Imports that rest on this file, newest first. */
  readonly batches: ReadonlyArray<{ readonly id: string; readonly status: string; readonly importType: string; readonly createdAt: string }>;
}

type Row = Record<string, unknown>;

/**
 * The imports that rest on each document — the old embedded `import_batches(...)` select, now a
 * second read joined here (FIRESTORE_DATA_MODEL.md §5). Under the caller's own `import_batches`
 * policy, as the embed was: a reader without `imports.review` sees a document with no imports.
 */
async function batchesByDocument(db: Db, orgId: string, documentIds: readonly string[]): Promise<Map<string, Row[]>> {
  const out = new Map<string, Row[]>();
  const ids = [...new Set(documentIds)];
  for (let i = 0; i < ids.length; i += 30) {
    const chunk = ids.slice(i, i + 30);
    const rows = await orgRows<Row>(db, orgId, 'import_batches', (q) => q
      .where('source_document_id', 'in', chunk)
      .select('id', 'status', 'import_type', 'created_at', 'source_document_id'));
    for (const b of rows) {
      const key = String(b.source_document_id);
      out.set(key, [...(out.get(key) ?? []), b]);
    }
  }
  return out;
}

function toSummary(row: Row, batchRows: readonly Row[]): DocumentSummary {
  const batches = batchRows
    .map((b) => ({ id: b.id as string, status: b.status as string, importType: b.import_type as string, createdAt: b.created_at as string }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return {
    id: row.id as string,
    filename: row.original_filename as string,
    kind: row.document_kind as string,
    mimeType: row.mime_type as string,
    byteSize: Number(row.byte_size ?? 0),
    status: row.status as string,
    pageCount: (row.page_count as number | null) ?? null,
    hasTextLayer: (row.has_text_layer as boolean | null) ?? null,
    createdAt: row.created_at as string,
    deletedAt: (row.deleted_at as string | null) ?? null,
    batches,
  };
}

/** Every document the caller may see, newest first; deleted ones included when asked. */
export async function listDocuments(ctx: AccessContext, scope: 'current' | 'all' = 'current'): Promise<DocumentSummary[]> {
  assertCan(ctx, 'documents.view');
  if (!ctx.orgId) throw new NotFound();
  const orgId = ctx.orgId;
  const rows = await orgRows<Row>(ctx.db, orgId, 'source_documents', (q) => {
    const query = scope === 'current' ? q.where('deleted_at', '==', null) : q;
    return query.orderBy('created_at', 'desc').limit(500);
  });
  const batches = await batchesByDocument(ctx.db, orgId, rows.map((r) => String(r.id)));
  return rows.map((r) => toSummary(r, batches.get(String(r.id)) ?? []));
}

export async function getDocument(ctx: AccessContext, documentId: string): Promise<DocumentSummary> {
  assertCan(ctx, 'documents.view');
  if (!ctx.orgId) throw new NotFound();
  const row = await orgRowById<Row>(ctx.db, ctx.orgId, 'source_documents', documentId);
  if (!row) throw new NotFound();
  const batches = await batchesByDocument(ctx.db, ctx.orgId, [documentId]);
  return toSummary(row, batches.get(documentId) ?? []);
}

/**
 * Where a document's bytes are, for the download route (EVIDENCE_MODEL.md §6 level 4): resolved by
 * `(organisation, id)` under the caller's own read policy, so another organisation's id is simply
 * not there. Null for a document that does not exist, cannot be seen, or was deleted.
 */
export async function getDocumentObject(
  ctx: AccessContext, documentId: string,
): Promise<{ id: string; storageBucket: string; storagePath: string; originalFilename: string } | null> {
  if (!ctx.orgId) return null;
  const row = await orgRowById<Row>(ctx.db, ctx.orgId, 'source_documents', documentId);
  if (!row || row.deleted_at !== null) return null;
  return {
    id: String(row.id),
    storageBucket: String(row.storage_bucket ?? ''),
    storagePath: String(row.storage_path),
    originalFilename: String(row.original_filename),
  };
}

/** Whether "Delete" may be offered: the function refuses anyway; this keeps the button honest. */
export function deletable(document: DocumentSummary): boolean {
  return document.deletedAt === null && document.status !== 'quarantined'
    && !document.batches.some((b) => b.status !== 'rejected' && b.status !== 'rolled_back');
}

export async function deleteDocument(ctx: AccessContext, documentId: string): Promise<void> {
  assertCan(ctx, 'imports.review');
  if (!ctx.orgId) throw new NotFound();
  const path = await callApi<string>(ctx.db, 'delete_document', { p_document: documentId }, ctx.requestId);
  const removed = await removeObject({ orgId: ctx.orgId, userId: ctx.userId }, SOURCE_DOCUMENTS_BUCKET, path);
  if (!removed.removed) {
    // Not fatal: the row says `deleted`, and the nightly sweep removes an object no live row names.
    log.warn('a deleted document\'s object could not be removed now; cleanup_orphans will', { requestId: ctx.requestId, documentId });
  }
}
