import 'server-only';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { InternalError, NotFound, PermissionDenied, ValidationError } from '@/core/errors';

/**
 * The Storage signer — the ONLY reader and writer of object storage in MOTION
 * (TENANCY_MODEL.md §8, SECURITY_MODEL.md §5b, ADR-038.1, ADR-043.4/5).
 *
 * There are no `storage.objects` policies for `authenticated` or `anon`, so a user JWT cannot list
 * or fetch an object at all. This module holds the service role instead, which means it is the one
 * place where the tenant boundary is NOT enforced by the database. Every guarantee therefore has to
 * be made here, explicitly:
 *
 *   1. Every key must begin with `${orgId}/`. A key that does not is refused before any call.
 *   2. Nothing is signed without the id of an audit event written in the same request, which is
 *      re-read and verified — right actor, right target, written within the last 30 seconds
 *      (ADR-043.5; R2-A-02). A download that is not audited does not happen.
 *   3. Signed URLs live 60 seconds and are returned as attachments.
 *
 * This is one of exactly three files permitted to read `SUPABASE_SERVICE_ROLE_KEY`; the ESLint rule
 * `motion/no-service-role-outside-sanctioned-files` fails the build anywhere else.
 */

export const SOURCE_DOCUMENTS_BUCKET = 'source-documents';
export const REPORTS_BUCKET = 'reports';

/** 60 seconds: long enough for a browser to follow the redirect, short enough not to be shareable. */
const SIGNED_URL_TTL_SECONDS = 60;
/** The audit event must be from this request, not an old one replayed (ADR-043.5). */
const AUDIT_MAX_AGE_SECONDS = 30;

let cached: SupabaseClient | null = null;

function storageClient(): SupabaseClient {
  if (cached) return cached;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    // Fail closed and loudly. A signer that silently degrades to "no URL" would look like a
    // permission problem and send somebody hunting in the wrong place.
    throw new InternalError('Storage is not configured on this deployment.');
  }

  cached = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}

export interface SignerContext {
  readonly orgId: string;
  readonly userId: string;
}

/**
 * The tenant assertion. Called before every operation, including deletes, because the service role
 * would happily act on another organization's prefix.
 */
function assertKeyBelongsTo(orgId: string, key: string): void {
  if (!key || key.includes('..') || key.startsWith('/')) {
    throw new ValidationError('That storage key is not valid.');
  }
  if (!key.startsWith(`${orgId}/`)) {
    // NotFound, not PermissionDenied: a 403 would confirm that the object exists for somebody
    // (SECURITY_MODEL.md §14).
    throw new NotFound('That file could not be found.');
  }
}

/**
 * Re-reads the audit event the caller says it wrote and checks it really describes THIS access.
 *
 * Taking the id on trust would make the audit requirement decorative: any caller could pass the id
 * of an event written for a different document, or one from an hour ago, and still get a URL.
 */
async function assertAuditEvent(
  ctx: SignerContext,
  auditEventId: number,
  targetTable: string,
  targetId: string,
): Promise<void> {
  const db = storageClient();
  const { data, error } = await db
    .from('audit_events')
    .select('id, organization_id, actor_user_id, target_table, target_id, created_at')
    .eq('id', auditEventId)
    .maybeSingle();

  if (error) throw new InternalError('The access record could not be verified.');
  if (!data) throw new PermissionDenied('This download was not recorded, so it cannot proceed.');

  const ageSeconds = (Date.now() - new Date(data.created_at as string).getTime()) / 1000;
  const matches =
    data.organization_id === ctx.orgId &&
    data.actor_user_id === ctx.userId &&
    data.target_table === targetTable &&
    data.target_id === targetId &&
    ageSeconds >= 0 &&
    ageSeconds <= AUDIT_MAX_AGE_SECONDS;

  if (!matches) {
    throw new PermissionDenied('This download was not recorded, so it cannot proceed.');
  }
}

export interface SignRequest {
  readonly bucket: string;
  readonly key: string;
  /** The `audit_events.id` returned by `api_server.record_access_event` in this same request. */
  readonly auditEventId: number;
  readonly targetTable: string;
  readonly targetId: string;
  /** Filename offered to the browser. */
  readonly downloadAs?: string;
}

/**
 * Mints a short-lived download URL. Permission (`documents.view` / `reports.view`) is checked by the
 * caller *and* by `api_server.record_access_event`, whose audit row this function then verifies —
 * so an unauthorised caller cannot obtain the audit id in the first place.
 */
export async function signDownloadUrl(
  ctx: SignerContext,
  request: SignRequest,
): Promise<{ url: string; expiresInSeconds: number }> {
  assertKeyBelongsTo(ctx.orgId, request.key);
  await assertAuditEvent(ctx, request.auditEventId, request.targetTable, request.targetId);

  const { data, error } = await storageClient()
    .storage
    .from(request.bucket)
    .createSignedUrl(request.key, SIGNED_URL_TTL_SECONDS, {
      download: request.downloadAs ?? true,
    });

  if (error || !data?.signedUrl) {
    throw new NotFound('That file could not be found.');
  }
  return { url: data.signedUrl, expiresInSeconds: SIGNED_URL_TTL_SECONDS };
}

/**
 * Writes an uploaded object. Step two of the upload order: validate → signer writes → register →
 * finalize (ADR-043.4). The key is built by the caller from the id `api_server.register_document`
 * generated, never from anything the browser supplied.
 */
export async function putObject(
  ctx: SignerContext,
  bucket: string,
  key: string,
  body: ArrayBuffer | Uint8Array | Blob,
  contentType: string,
): Promise<void> {
  assertKeyBelongsTo(ctx.orgId, key);

  const { error } = await storageClient()
    .storage
    .from(bucket)
    .upload(key, body, { contentType, upsert: false });

  if (error) {
    throw new InternalError('That file could not be stored.');
  }
}

/**
 * Removes one object, and only one.
 *
 * Called after `api.delete_document` has marked the row and returned its path, and on the failure
 * path of an upload — where it must delete THAT key alone (ADR-043.4). A failure here is not fatal:
 * the row is already marked `deleted` and `storage.cleanup_orphans` will finish the job, which is
 * why the outcome is returned rather than thrown.
 */
export async function removeObject(
  ctx: SignerContext,
  bucket: string,
  key: string,
): Promise<{ removed: boolean }> {
  assertKeyBelongsTo(ctx.orgId, key);

  const { error } = await storageClient().storage.from(bucket).remove([key]);
  return { removed: !error };
}

/**
 * Sanitises a user-supplied filename into one path segment.
 *
 * Replacing the disallowed characters is not enough on its own: `.` is a legal filename character,
 * so `../../etc/passwd` becomes `.._.._etc_passwd`, and a filename of exactly `..` would become a
 * traversal segment. Runs of dots are therefore collapsed and leading dots stripped, which also
 * removes the dotfile case. A name that sanitises away entirely falls back rather than producing an
 * empty segment.
 */
export function sanitiseFilename(filename: string): string {
  const collapsed = filename
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/\.{2,}/g, '.')
    .replace(/^[._-]+/, '');
  const trimmed = collapsed.slice(0, 120).replace(/[._-]+$/, '');
  return trimmed === '' ? 'upload' : trimmed;
}

/** The object key for a source document, built only from server-generated parts. */
export function sourceDocumentKey(orgId: string, documentId: string, filename: string): string {
  return `${orgId}/${documentId}/${sanitiseFilename(filename)}`;
}

/** The extracted-text sidecar for a document (TENANCY_MODEL.md §8). */
export function extractedTextKey(orgId: string, documentId: string): string {
  return `${orgId}/${documentId}/text.json`;
}

export function reportKey(orgId: string, period: string, jobId: string): string {
  return `${orgId}/${period}/${jobId}.pdf`;
}

/** Exported for tests: the key rules are the tenant boundary and must be directly assertable. */
export const __testing = { assertKeyBelongsTo, AUDIT_MAX_AGE_SECONDS, SIGNED_URL_TTL_SECONDS };
