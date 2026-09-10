import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { callApi } from '@/core/db/api-rpc';
import { NotFound, toMotionError } from '@/core/errors';
import { log } from '@/core/logging';
import { assertCan } from '@/core/permissions';
import { removeObject, SOURCE_DOCUMENTS_BUCKET } from '@/core/storage/signer';
import type { AccessContext } from '@/modules/tenancy';

/**
 * The document library (ROUTE_ARCHITECTURE.md §127–128; SERVICE_ARCHITECTURE.md §documents;
 * ADR-043.4; R2-A-09). Reads run under the caller's client — `source_documents` is an allow-list of
 * owner/admin/employee/super_admin, never a client (R2-A-07). Deleting is `api.delete_document`,
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

const SELECT = 'id, original_filename, document_kind, mime_type, byte_size, status, page_count, has_text_layer, created_at, deleted_at, import_batches(id, status, import_type, created_at)';

function toSummary(row: Record<string, unknown>): DocumentSummary {
  const batches = ((row.import_batches ?? []) as Array<Record<string, unknown>>)
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
  const db: SupabaseClient = ctx.db;
  let query = db.from('source_documents').select(SELECT).eq('organization_id', ctx.orgId).order('created_at', { ascending: false }).limit(500);
  if (scope === 'current') query = query.is('deleted_at', null);
  const { data, error } = await query;
  if (error) throw toMotionError(error, ctx.requestId);
  return ((data ?? []) as unknown as Record<string, unknown>[]).map(toSummary);
}

export async function getDocument(ctx: AccessContext, documentId: string): Promise<DocumentSummary> {
  assertCan(ctx, 'documents.view');
  if (!ctx.orgId) throw new NotFound();
  const { data, error } = await ctx.db.from('source_documents').select(SELECT).eq('organization_id', ctx.orgId).eq('id', documentId).maybeSingle();
  if (error) throw toMotionError(error, ctx.requestId);
  if (!data) throw new NotFound();
  return toSummary(data as unknown as Record<string, unknown>);
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
