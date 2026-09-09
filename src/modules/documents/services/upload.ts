import 'server-only';
import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  ConflictError, QuotaExceeded, ValidationError, toMotionError,
} from '@/core/errors';
import { putObject, removeObject, sanitiseFilename, SOURCE_DOCUMENTS_BUCKET } from '@/core/storage/signer';
import { log } from '@/core/logging';
import { validateFile, MAX_FILE_BYTES, type FileKind } from '../domain/validate-file';

/**
 * Upload (IMPORT_ENGINE.md §2, §3, §4; ADR-043.4).
 *
 * The order is fixed and each step exists because of what it prevents:
 *   1. permission, then the size cap — before a byte is read into memory;
 *   2. SHA-256 and the file-duplicate lookup — so the same statement uploaded twice is caught before
 *      it becomes a second batch, and the user is pointed at the first one (CD-12);
 *   3. file validation — a macro workbook, an encrypted PDF or a renamed executable never reaches a
 *      parser, and a file that fails is STORED as quarantined rather than dropped, so the reviewer
 *      and the platform can see what was refused (§4);
 *   4. `register_document` generates the id and the storage path — the browser never chooses where
 *      its own upload lands;
 *   5. the signer writes the object;
 *   6. `finalize_upload` verifies the object is really there at the declared size before the
 *      document becomes `ready`.
 *
 * Step 4 before step 5 is deliberate: the path must exist as a server-generated fact before anything
 * is written to it. On a failure after the write, the signer removes THAT key and nothing else.
 */

export interface UploadInput {
  readonly filename: string;
  readonly declaredMimeType: string;
  readonly bytes: Uint8Array;
  /** The user's choice from the upload form; the suggestion is only a default (§2.6). */
  readonly documentKind: string;
}

export interface UploadResult {
  readonly documentId: string;
  readonly suggestedImportType: string | null;
  readonly textLayer: boolean | null;
  readonly pageCount: number | null;
  readonly status: 'ready' | 'quarantined' | 'unreadable';
  readonly findings: ReadonlyArray<{ code: string; message: string }>;
}

/** §2.6: a filename heuristic that PROPOSES a type. The user's choice always wins. */
export function suggestImportType(filename: string, headers: readonly string[] = []): string | null {
  const name = filename.toLowerCase();
  const columns = headers.map((h) => h.toLowerCase()).join(' ');

  if (/statement|stmt/.test(name)) return 'bank_statement';
  if (/trial ?balance|\btb\b/.test(name)) return 'trial_balance';
  if (/ledger|journal|\bgl\b/.test(name)) return 'general_ledger';
  if (/balance ?sheet/.test(name)) return 'balance_sheet';
  if (/p&l|profit|income ?statement/.test(name)) return 'pnl_report';
  if (/invoice/.test(name)) return /supplier|purchase|bill/.test(name) || /supplier/.test(columns)
    ? 'purchase_invoices' : 'sales_invoices';
  if (/bill|supplier/.test(name)) return 'purchase_invoices';
  return null;
}

const KIND_TO_FILE_KIND: Readonly<Record<string, FileKind>> = {
  'text/csv': 'csv',
  'text/plain': 'csv',
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
};

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export interface UploadContext {
  readonly orgId: string;
  readonly userId: string;
  readonly db: SupabaseClient;
  /** Service-role RPC surface, from core/db/server-rpc.ts. */
  readonly registerDocument: (meta: Record<string, unknown>) => Promise<string>;
  readonly finalizeUpload: (
    documentId: string, byteSize: number, scanResult: unknown, status: string,
  ) => Promise<void>;
  readonly requestId?: string;
}

export async function uploadDocument(ctx: UploadContext, input: UploadInput): Promise<UploadResult> {
  if (input.bytes.byteLength === 0) {
    throw new ValidationError('That file is empty.');
  }
  if (input.bytes.byteLength > MAX_FILE_BYTES) {
    // QuotaExceeded rather than ValidationError: the file is not malformed, it is too big, and the
    // advice differs — split by period rather than fix the file.
    throw new QuotaExceeded(
      `That file is larger than the ${Math.floor(MAX_FILE_BYTES / 1_048_576)} MB limit. Split it by period and upload each part.`,
    );
  }

  const sha256 = sha256Hex(input.bytes);

  // CD-12: the same bytes twice. Caught BEFORE validation and storage, so a re-upload costs nothing
  // and the user is sent to the batch they already have rather than making a second one.
  const { data: existing, error: lookupError } = await ctx.db
    .from('source_documents')
    .select('id')
    .eq('organization_id', ctx.orgId)
    .eq('sha256', `\\x${sha256}`)
    .is('deleted_at', null)
    .maybeSingle();
  if (lookupError) throw toMotionError(lookupError, ctx.requestId);
  if (existing) {
    throw new ConflictError(
      'This exact file has already been uploaded. Open the earlier import instead of starting a new one.',
      { documentId: existing.id as string },
    );
  }

  // The validator sniffs the real kind from the magic bytes; the declared type is only cross-checked
  // against it, never trusted (§4).
  const validation = validateFile({
    filename: input.filename,
    declaredMimeType: input.declaredMimeType,
    bytes: input.bytes,
  });
  const fileKind = validation.detectedKind ?? KIND_TO_FILE_KIND[input.declaredMimeType] ?? 'unknown';

  // §4: a file that fails validation is STORED with status `quarantined` and its findings, never
  // silently rejected. The reviewer and the platform must be able to see what was refused and why.
  const status: UploadResult['status'] = validation.ok
    ? (fileKind === 'pdf' && validation.hasTextLayer === false ? 'unreadable' : 'ready')
    : (validation.quarantine ? 'quarantined' : 'unreadable');

  const documentId = await ctx.registerDocument({
    // §4: what the probe found, kept on the row — §5.4 reads `has_text_layer` (ADR-083).
    has_text_layer: validation.hasTextLayer ?? null,
    page_count: validation.pageCount ?? null,
    original_filename: input.filename,
    mime_type: input.declaredMimeType,
    byte_size: input.bytes.byteLength,
    sha256,
    document_kind: input.documentKind,
  });

  const key = `${ctx.orgId}/${documentId}/${sanitiseFilename(input.filename)}`;
  try {
    await putObject({ orgId: ctx.orgId, userId: ctx.userId }, SOURCE_DOCUMENTS_BUCKET, key,
      input.bytes, input.declaredMimeType);
  } catch (cause) {
    // ADR-043.4: on failure the signer deletes THAT key only, and the row stays behind as evidence
    // that an upload was attempted. `storage.cleanup_orphans` reconciles the rest.
    await removeObject({ orgId: ctx.orgId, userId: ctx.userId }, SOURCE_DOCUMENTS_BUCKET, key);
    log.error('the uploaded object could not be stored', {
      documentId, error: cause instanceof Error ? cause.message : String(cause),
    });
    throw cause;
  }

  await ctx.finalizeUpload(
    documentId, input.bytes.byteLength,
    { findings: validation.findings, encoding: validation.encoding, delimiter: validation.delimiter },
    status,
  );

  return {
    documentId,
    suggestedImportType: status === 'ready' ? suggestImportType(input.filename) : null,
    textLayer: validation.hasTextLayer ?? null,
    pageCount: validation.pageCount ?? null,
    status,
    findings: validation.findings,
  };
}
