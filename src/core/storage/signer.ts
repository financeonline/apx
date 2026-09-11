import 'server-only';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { InternalError, NotFound, PermissionDenied, ValidationError } from '@/core/errors';
import { log } from '@/core/logging';
import { sanitiseFilename } from './filenames';

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
 * Rule 2 governs DISCLOSURE and so applies to signing alone; writing, deleting and listing hand
 * nobody any bytes and have never carried it (`putObject` and `removeObject` predate the sweep
 * surface below and take no audit id either). Rule 1 governs everything without exception.
 *
 * This is one of exactly three files permitted to read `SUPABASE_SERVICE_ROLE_KEY`; the ESLint rule
 * `motion/no-service-role-outside-sanctioned-files` fails the build anywhere else.
 */

export { sanitiseFilename };

export const SOURCE_DOCUMENTS_BUCKET = 'source-documents';
export const REPORTS_BUCKET = 'reports';

/** 60 seconds: long enough for a browser to follow the redirect, short enough not to be shareable. */
const SIGNED_URL_TTL_SECONDS = 60;
/** The audit event must be from this request, not an old one replayed (ADR-043.5). */
const AUDIT_MAX_AGE_SECONDS = 30;
/**
 * How far the database's clock may run ahead of this process's before a just-written event looks
 * like it came from the future (ADR-095).
 *
 * `created_at` is Postgres's `now()`; the age is measured against Node's `Date.now()`, on a
 * different host. A few hundred milliseconds of NTP skew between two machines is ordinary, and the
 * check that does the real work is the UPPER bound — that is what stops an old event being replayed
 * to authorise a fresh download. Refusing a legitimate download because the database's clock is
 * 200 ms ahead is a fail-closed that protects nothing and breaks the product.
 */
const AUDIT_CLOCK_SKEW_SECONDS = 5;

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
    ageSeconds >= -AUDIT_CLOCK_SKEW_SECONDS &&
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
/**
 * Reads a stored object for a job that has to see its bytes — the extraction job reading a PDF's
 * text layer (IMPORT_ENGINE.md §5.4). Same guard as every other key: it must belong to the
 * organisation the caller is scoped to.
 */
export async function getObject(ctx: SignerContext, bucket: string, key: string): Promise<Uint8Array> {
  assertKeyBelongsTo(ctx.orgId, key);
  const { data, error } = await storageClient().storage.from(bucket).download(key);
  if (error || !data) {
    throw new InternalError('That file could not be read from storage.');
  }
  return new Uint8Array(await data.arrayBuffer());
}

export async function removeObject(
  ctx: SignerContext,
  bucket: string,
  key: string,
): Promise<{ removed: boolean }> {
  assertKeyBelongsTo(ctx.orgId, key);

  const { error } = await storageClient().storage.from(bucket).remove([key]);
  return { removed: !error };
}

// ---------------------------------------------------------------------------------------------
// The sweep surface, for `storage.cleanup_orphans` alone
// (SERVICE_ARCHITECTURE.md §7 job table; ADR-043.4; ADR-062.2).
//
// Nothing else in the product ever needs to know what is IN a bucket: every read resolves a path
// from a row. The orphan sweep is the one job that has to start from the objects, because the
// object it is looking for is precisely the one no row names. That inversion is why these three
// functions exist, and why they are written to be dull.
//
// The tenant assertion is unchanged. `listObjectsForOrganization` and `removeObjectsForOrganization`
// take the organization explicitly and run every key through `assertKeyBelongsTo`, so the sweep
// deletes under one organization's prefix at a time and can no more reach across the boundary than
// an upload can. `listOrganizationPrefixes` is the single call with no organization — and it returns
// FOLDER NAMES ONLY, never an object key and never any bytes, and only those that parse as a uuid,
// because every legitimate top-level entry in these buckets IS an organization id (TENANCY_MODEL.md
// §8). Anything else is handed back separately so the caller can report it, and can never become a
// prefix something is deleted under.
// ---------------------------------------------------------------------------------------------

/** How many entries one `list` page asks for. Storage caps a page well above this. */
const LIST_PAGE_SIZE = 1000;
/**
 * How far below the organization prefix the walk descends. Both buckets are `{org}/{a}/{b}`, so two
 * levels is the whole shape; the budget exists so a bucket that somehow grew a deeper tree makes the
 * walk stop — and say so, in the log, naming the prefixes it did not descend into (ADR-075) —
 * rather than recurse for as long as Storage keeps answering.
 */
const MAX_PREFIX_DEPTH = 3;
/** Storage's own marker for a directory that exists with nothing in it. Not an object. */
const EMPTY_FOLDER_PLACEHOLDER = '.emptyFolderPlaceholder';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface StoredObject {
  readonly key: string;
  /**
   * The later of the object's `created_at` and `updated_at`.
   *
   * The sweep's grace period asks "could a row for this still be on its way?", and the safest answer
   * comes from the most recent time Storage wrote these bytes, not the first. Taking the maximum can
   * only ever spare an object for longer; taking the minimum could delete one that was just written.
   */
  readonly lastWrittenAt: Date;
  readonly byteSize: number | null;
}

interface ListedEntry {
  name: string;
  id: string | null;
  created_at: string | null;
  updated_at: string | null;
  metadata: { size?: number } | null;
}

/** One page of `list`, or a throw. A listing that half-worked must never look like an empty bucket. */
async function listPage(bucket: string, prefix: string, offset: number): Promise<ListedEntry[]> {
  const { data, error } = await storageClient()
    .storage
    .from(bucket)
    .list(prefix, { limit: LIST_PAGE_SIZE, offset, sortBy: { column: 'name', order: 'asc' } });

  if (error || !data) {
    // Loud, because the caller deletes what it does not find. An error swallowed into `[]` here
    // would read to a sweep as "this organization owns nothing", which is the one lie that turns
    // this job into a data-loss incident.
    throw new InternalError(`The bucket ${bucket} could not be listed: ${error?.message ?? 'no data'}`);
  }
  return data as unknown as ListedEntry[];
}

async function listAll(bucket: string, prefix: string): Promise<ListedEntry[]> {
  const entries: ListedEntry[] = [];
  for (let offset = 0; ; offset += LIST_PAGE_SIZE) {
    const page = await listPage(bucket, prefix, offset);
    entries.push(...page);
    if (page.length < LIST_PAGE_SIZE) return entries;
  }
}

/**
 * The organization prefixes present in a bucket, and the top-level entries that are not one.
 *
 * The sweep needs the organizations that have objects, not the organizations that have rows: an
 * organization purged from the database but whose objects survived a failed `org.purge` has no row
 * left to enumerate, and its leftover objects are exactly what wants collecting.
 */
export async function listOrganizationPrefixes(
  bucket: string,
): Promise<{ organizationIds: string[]; ignored: string[] }> {
  const entries = await listAll(bucket, '');
  const organizationIds: string[] = [];
  const ignored: string[] = [];

  for (const entry of entries) {
    // `id === null` marks a folder. A bare object at the bucket root belongs to no organization, so
    // no row can claim it and no context may legally delete it — it is reported, never swept.
    if (entry.id !== null || !UUID_PATTERN.test(entry.name)) {
      if (entry.name !== EMPTY_FOLDER_PLACEHOLDER) ignored.push(entry.name);
      continue;
    }
    organizationIds.push(entry.name);
  }
  return { organizationIds, ignored };
}

/** Every object under `${orgId}/`, walked breadth-first within the depth budget. */
export async function listObjectsForOrganization(
  orgId: string,
  bucket: string,
): Promise<StoredObject[]> {
  assertKeyBelongsTo(orgId, `${orgId}/`);

  const objects: StoredObject[] = [];
  let frontier = [orgId];

  for (let depth = 1; depth <= MAX_PREFIX_DEPTH && frontier.length > 0; depth += 1) {
    const next: string[] = [];
    for (const prefix of frontier) {
      for (const entry of await listAll(bucket, prefix)) {
        const key = `${prefix}/${entry.name}`;
        if (entry.id === null) {
          next.push(key);
          continue;
        }
        if (entry.name === EMPTY_FOLDER_PLACEHOLDER) continue;
        // Defence in depth: Storage returning a key outside the prefix it was asked for would be a
        // bug in Storage, and this sweep must not turn a bug in Storage into a deleted file.
        assertKeyBelongsTo(orgId, key);
        const created = Date.parse(entry.created_at ?? '');
        const updated = Date.parse(entry.updated_at ?? '');
        objects.push({
          key,
          // An object with no readable timestamp is treated as written NOW, which puts it inside
          // every grace period and therefore out of reach of this job.
          lastWrittenAt: new Date(Math.max(
            Number.isNaN(created) ? Date.now() : created,
            Number.isNaN(updated) ? Date.now() : updated,
          )),
          byteSize: entry.metadata?.size ?? null,
        });
      }
    }
    frontier = next;
  }
  if (frontier.length > 0) {
    // Not an error — nothing under an unvisited prefix can be deleted by this walk, which is the
    // safe direction — but a silence here would let a bucket grow a tree the sweep never sees.
    log.warn('storage walk stopped at its depth budget with prefixes unvisited', {
      bucket, orgId, depth: MAX_PREFIX_DEPTH, unvisited: frontier,
    });
  }
  return objects;
}

/** How many keys go into one `remove` call. */
const REMOVE_BATCH_SIZE = 100;

/**
 * Removes objects under one organization's prefix, and reports exactly which ones went.
 *
 * Every key is asserted individually before the batch is sent, so a list that had somehow acquired a
 * foreign key is refused rather than partially honoured. What came back deleted is what is reported:
 * Storage answers a `remove` with the objects it actually removed, and a sweep that logged its
 * intentions rather than its effects would be a record of nothing.
 */
export async function removeObjectsForOrganization(
  orgId: string,
  bucket: string,
  keys: readonly string[],
): Promise<{ removed: string[]; failed: string[] }> {
  for (const key of keys) assertKeyBelongsTo(orgId, key);

  const removed: string[] = [];
  const failed: string[] = [];

  for (let start = 0; start < keys.length; start += REMOVE_BATCH_SIZE) {
    const batch = keys.slice(start, start + REMOVE_BATCH_SIZE);
    const { data, error } = await storageClient().storage.from(bucket).remove([...batch]);
    if (error || !data) {
      failed.push(...batch);
      continue;
    }
    const gone = new Set((data as Array<{ name?: string }>).map((row) => row.name));
    for (const key of batch) (gone.has(key) ? removed : failed).push(key);
  }
  return { removed, failed };
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
