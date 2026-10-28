import 'server-only';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { File } from '@google-cloud/storage';
import { InternalError, NotFound, PermissionDenied, ValidationError } from '@/core/errors';
import { log } from '@/core/logging';
import { db as firestore, storage, storageBucketName, usingEmulators } from '@/db/firestore';
import { sanitiseFilename } from './filenames';

/**
 * The Storage signer — the ONLY reader and writer of object storage in APX
 * (TENANCY_MODEL.md §8, SECURITY_MODEL.md §5b, ADR-038.1, ADR-043.4/5; FIRESTORE_DATA_MODEL.md §1).
 *
 * Files live in Firebase Storage, reached only through the Admin SDK: `firebase/storage.rules`
 * refuses every client request, so a browser can neither list nor fetch an object at all. The Admin
 * SDK bypasses those rules, which makes this module the one place where the tenant boundary is NOT
 * enforced by anything below it. Every guarantee therefore has to be made here, explicitly:
 *
 *   1. Every key must begin with `${orgId}/`. A key that does not is refused before any call.
 *   2. Nothing is disclosed without the id of an audit event written in the same request, which is
 *      re-read (`audit_events/{id}`) and verified — right actor, right organisation, right target,
 *      written within the last 30 seconds (ADR-043.5; R2-A-02). A download that is not audited does
 *      not happen. (That the key is the target's own object is the caller's to get right; see
 *      `signDownloadUrl`.)
 *   3. Download links live 60 seconds and the bytes are served as attachments.
 *
 * Rule 2 governs DISCLOSURE and so applies to signing and to serving the bytes; writing, deleting
 * and listing hand nobody any bytes and have never carried it. Rule 1 governs everything without
 * exception.
 *
 * Layout. The two Supabase buckets became one Firebase bucket (`storageBucketName()`); an object's
 * name is `${logicalBucket}/${key}`, where the logical bucket is `source-documents` or `reports` and
 * the key is the same `${orgId}/…` key as before — so every stored `storage_bucket` / `storage_path`
 * pair still names its object, unchanged.
 *
 * Downloads go THROUGH the APX server. A Firebase signed URL needs service-account credentials the
 * emulator does not have, and a bucket URL would leave this process at the moment of disclosure. So
 * `signDownloadUrl` keeps its contract — verify the audit event, return a 60-second URL — but the
 * URL is an APX route (`/api/storage/download?grant=…`) carrying an HMAC-signed grant bound to the
 * object, the actor and the audit event. Redeeming it (`redeemDownloadGrant`) re-checks the session
 * is that actor and re-reads the audit event before a single byte is read.
 */

export { sanitiseFilename };

export const SOURCE_DOCUMENTS_BUCKET = 'source-documents';
export const REPORTS_BUCKET = 'reports';
const LOGICAL_BUCKETS: readonly string[] = [SOURCE_DOCUMENTS_BUCKET, REPORTS_BUCKET];

/** 60 seconds: long enough for a browser to follow the link, short enough not to be shareable. */
const SIGNED_URL_TTL_SECONDS = 60;
/** The audit event must be from this request, not an old one replayed (ADR-043.5). */
const AUDIT_MAX_AGE_SECONDS = 30;
/**
 * How far the database's clock may run ahead of this process's before a just-written event looks
 * like it came from the future (ADR-095). `created_at` is stamped by whichever server instance wrote
 * the event; the age is measured here. The check that does the real work is the UPPER bound.
 */
const AUDIT_CLOCK_SKEW_SECONDS = 5;

/** The download route a grant is redeemed at. */
export const DOWNLOAD_ROUTE = '/api/storage/download';

function bucket() {
  return storage().bucket(storageBucketName());
}

/** The Firebase object behind a logical bucket and key. Only after the key has been asserted. */
function objectFor(logicalBucket: string, key: string): File {
  if (!LOGICAL_BUCKETS.includes(logicalBucket)) {
    throw new ValidationError('That storage bucket is not valid.');
  }
  return bucket().file(`${logicalBucket}/${key}`);
}

function statusOf(error: unknown): number | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? code : null;
}

export interface SignerContext {
  readonly orgId: string;
  readonly userId: string;
}

/**
 * The tenant assertion. Called before every operation, including deletes, because the Admin SDK
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
 * of an event written for a different document, or one from an hour ago, and still get the bytes.
 */
async function assertAuditEvent(
  ctx: SignerContext,
  auditEventId: string,
  targetTable: string,
  targetId: string,
  maxAgeSeconds: number = AUDIT_MAX_AGE_SECONDS,
): Promise<void> {
  if (!auditEventId) throw new PermissionDenied('This download was not recorded, so it cannot proceed.');
  let data: Record<string, unknown> | undefined;
  try {
    const snap = await firestore().collection('audit_events').doc(auditEventId).get();
    data = snap.exists ? snap.data() : undefined;
  } catch {
    throw new InternalError('The access record could not be verified.');
  }
  if (!data) throw new PermissionDenied('This download was not recorded, so it cannot proceed.');

  const ageSeconds = (Date.now() - new Date(String(data.created_at)).getTime()) / 1000;
  const matches =
    data.organization_id === ctx.orgId &&
    data.actor_user_id === ctx.userId &&
    data.target_table === targetTable &&
    data.target_id === targetId &&
    ageSeconds >= -AUDIT_CLOCK_SKEW_SECONDS &&
    ageSeconds <= maxAgeSeconds;

  if (!matches) {
    throw new PermissionDenied('This download was not recorded, so it cannot proceed.');
  }
}

export interface SignRequest {
  readonly bucket: string;
  readonly key: string;
  /**
   * The `audit_events` id returned by `api_server.record_access_event` in this same request — a
   * uuid string now (it was a bigint on PostgreSQL; a number is accepted while callers' types catch up).
   */
  readonly auditEventId: string | number;
  readonly targetTable: string;
  readonly targetId: string;
  /** Filename offered to the browser. */
  readonly downloadAs?: string;
}

// ── The download grant ──────────────────────────────────────────────────────────────────────────

/**
 * The key grants are signed with. `APX_DOWNLOAD_GRANT_KEY` when set; otherwise derived from
 * `APX_SECRETS_KEY` (already required off the emulators, `src/db/app/secrets.ts`), so a deployment
 * needs no new secret; on the emulators a fixed development key. Never a silent default elsewhere.
 */
function grantKey(): Buffer {
  const own = process.env.APX_DOWNLOAD_GRANT_KEY;
  if (own) return createHash('sha256').update(`apx-download-grant:${own}`).digest();
  const secrets = process.env.APX_SECRETS_KEY;
  if (secrets) return createHash('sha256').update(`apx-download-grant:${secrets}`).digest();
  if (usingEmulators()) return createHash('sha256').update('apx-local-emulator-download-grant').digest();
  throw new InternalError('Storage downloads are not configured on this deployment.');
}

interface GrantPayload {
  /** logical bucket, key, organisation, actor, audit event, target table, target id, filename, expiry (ms) */
  readonly b: string; readonly k: string; readonly o: string; readonly u: string; readonly a: string;
  readonly t: string; readonly i: string; readonly n: string | null; readonly e: number;
}

function signGrant(payload: GrantPayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = createHmac('sha256', grantKey()).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function readGrant(token: string): GrantPayload {
  const refused = () => new NotFound('That download link has expired. Open the file again.');
  const [body, mac, extra] = token.split('.');
  if (!body || !mac || extra !== undefined) throw refused();
  const expected = createHmac('sha256', grantKey()).update(body).digest();
  const given = Buffer.from(mac, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw refused();
  let payload: GrantPayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as GrantPayload;
  } catch {
    throw refused();
  }
  if (typeof payload.e !== 'number' || payload.e < Date.now()) throw refused();
  return payload;
}

/**
 * Mints a short-lived download link.
 *
 * What is checked, and where — precisely, because this is the one place the database does not stand
 * behind the read:
 *   - the CALLER (the route) checks the permission and resolves the file row under the user's read
 *     policy (`src/db/rls.ts`), and takes `key` from that row;
 *   - `api_server.record_access_event` re-checks the ACTOR before writing the audit row:
 *     `document.downloaded` needs `documents.view` and a document of this organisation;
 *     `report.downloaded` needs `reports.view` and — for a stored report file — that the actor may
 *     read that report. Without the right, no audit id is issued;
 *   - THIS function checks that `key` lies under the caller's organisation, that the object exists,
 *     and that the audit row it is handed exists and names this actor, this organisation, this
 *     target table and id, and was written within the last 30 seconds;
 *   - redeeming the link checks it again (`redeemDownloadGrant`).
 * It does NOT check that `key` is the storage path of that target, nor which access event the row
 * records: those rest on the caller passing the key of the row it just audited.
 */
export async function signDownloadUrl(
  ctx: SignerContext,
  request: SignRequest,
): Promise<{ url: string; expiresInSeconds: number }> {
  assertKeyBelongsTo(ctx.orgId, request.key);
  const auditEventId = String(request.auditEventId);
  await assertAuditEvent(ctx, auditEventId, request.targetTable, request.targetId);

  const [exists] = await objectFor(request.bucket, request.key).exists().catch(() => [false] as const);
  if (!exists) throw new NotFound('That file could not be found.');

  const grant = signGrant({
    b: request.bucket, k: request.key, o: ctx.orgId, u: ctx.userId, a: auditEventId,
    t: request.targetTable, i: request.targetId, n: request.downloadAs ?? null,
    e: Date.now() + SIGNED_URL_TTL_SECONDS * 1000,
  });
  return { url: `${DOWNLOAD_ROUTE}?grant=${encodeURIComponent(grant)}`, expiresInSeconds: SIGNED_URL_TTL_SECONDS };
}

export interface AuditedObject {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  /** The filename to offer in `Content-Disposition: attachment`. */
  readonly filename: string;
}

/**
 * Reads an object for disclosure, after the same two checks `signDownloadUrl` makes: the key is the
 * caller's organisation's, and a fresh audit event names this actor and this target.
 * `maxAgeSeconds` widens the audit window only for redeeming a link minted inside it.
 */
export async function readAuditedObject(
  ctx: SignerContext,
  request: SignRequest,
  maxAgeSeconds: number = AUDIT_MAX_AGE_SECONDS,
): Promise<AuditedObject> {
  assertKeyBelongsTo(ctx.orgId, request.key);
  await assertAuditEvent(ctx, String(request.auditEventId), request.targetTable, request.targetId, maxAgeSeconds);

  const file = objectFor(request.bucket, request.key);
  try {
    const [[bytes], [metadata]] = await Promise.all([file.download(), file.getMetadata()]);
    return {
      bytes: new Uint8Array(bytes),
      contentType: String(metadata.contentType ?? 'application/octet-stream'),
      filename: request.downloadAs ?? request.key.split('/').pop() ?? 'download',
    };
  } catch (error) {
    if (statusOf(error) === 404) throw new NotFound('That file could not be found.');
    throw new InternalError('That file could not be read from storage.');
  }
}

/**
 * Redeems a link `signDownloadUrl` minted. The session's user must be the actor it was minted for,
 * and the audit event is re-read: within the link's own 60 seconds it may be up to 90 seconds old.
 */
export async function redeemDownloadGrant(token: string, sessionUserId: string | null): Promise<AuditedObject> {
  const g = readGrant(token);
  // Somebody else's link is not somebody else's file to them: NotFound, as for a foreign key.
  if (!sessionUserId || g.u !== sessionUserId) throw new NotFound('That file could not be found.');
  return readAuditedObject(
    { orgId: g.o, userId: g.u },
    { bucket: g.b, key: g.k, auditEventId: g.a, targetTable: g.t, targetId: g.i, downloadAs: g.n ?? undefined },
    AUDIT_MAX_AGE_SECONDS + SIGNED_URL_TTL_SECONDS,
  );
}

/** `Content-Disposition: attachment` for a filename, ASCII fallback plus RFC 5987 UTF-8 form. */
export function attachmentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]+/g, '_').replace(/["\\]/g, '_') || 'download';
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

// ── Writes and job reads ────────────────────────────────────────────────────────────────────────

function toBuffer(body: ArrayBuffer | Uint8Array | Buffer): Buffer {
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  return Buffer.from(body);
}

/**
 * Writes an uploaded object. Step two of the upload order: validate → signer writes → register →
 * finalize (ADR-043.4). The key is built by the caller from the id `api_server.register_document`
 * generated, never from anything the browser supplied. Never overwrites: an object already at the
 * key is a failure (`ifGenerationMatch: 0`), as `upsert: false` was.
 */
export async function putObject(
  ctx: SignerContext,
  logicalBucket: string,
  key: string,
  body: ArrayBuffer | Uint8Array | Blob,
  contentType: string,
): Promise<void> {
  assertKeyBelongsTo(ctx.orgId, key);
  const bytes = body instanceof Blob ? Buffer.from(await body.arrayBuffer()) : toBuffer(body);
  const file = objectFor(logicalBucket, key);
  // The Storage emulator ignores `ifGenerationMatch`, so the refusal is also checked first; the
  // precondition is what closes the race against a real bucket.
  const [exists] = await file.exists().catch(() => [false] as const);
  if (exists) throw new InternalError('That file could not be stored.');
  try {
    await file.save(bytes, {
      contentType,
      resumable: false,
      preconditionOpts: { ifGenerationMatch: 0 },
    });
  } catch {
    throw new InternalError('That file could not be stored.');
  }
}

/**
 * Reads a stored object for a job that has to see its bytes — the extraction job reading a PDF's
 * text layer (IMPORT_ENGINE.md §5.4). Same guard as every other key: it must belong to the
 * organisation the caller is scoped to.
 */
export async function getObject(ctx: SignerContext, logicalBucket: string, key: string): Promise<Uint8Array> {
  assertKeyBelongsTo(ctx.orgId, key);
  try {
    const [bytes] = await objectFor(logicalBucket, key).download();
    return new Uint8Array(bytes);
  } catch {
    throw new InternalError('That file could not be read from storage.');
  }
}

/**
 * Removes one object, and only one.
 *
 * Called after `api.delete_document` has marked the row and returned its path, and on the failure
 * path of an upload — where it must delete THAT key alone (ADR-043.4). A failure here is not fatal:
 * the row is already marked `deleted` and `storage.cleanup_orphans` will finish the job, which is
 * why the outcome is returned rather than thrown. An object already gone counts as removed.
 */
export async function removeObject(
  ctx: SignerContext,
  logicalBucket: string,
  key: string,
): Promise<{ removed: boolean }> {
  assertKeyBelongsTo(ctx.orgId, key);
  try {
    await objectFor(logicalBucket, key).delete({ ignoreNotFound: true });
    return { removed: true };
  } catch {
    return { removed: false };
  }
}

// ---------------------------------------------------------------------------------------------
// The sweep surface, for `storage.cleanup_orphans` and `org.purge` alone
// (SERVICE_ARCHITECTURE.md §7 job table; ADR-043.4; ADR-062.2).
//
// Nothing else in the product ever needs to know what is IN a bucket: every read resolves a path
// from a row. The orphan sweep is the one job that has to start from the objects, because the
// object it is looking for is precisely the one no row names. That inversion is why these functions
// exist, and why they are written to be dull.
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

/** How many entries one listing page asks for. */
const LIST_PAGE_SIZE = 1000;
/**
 * How far below the organization prefix an object may sit. Both buckets are `{org}/{a}/{b}` (reports
 * `{org}/r/{report}/{file}`), so three levels is the whole shape; an object deeper than that is
 * skipped — and said so, in the log (ADR-075) — so a bucket that somehow grew a deeper tree is never
 * swept blind. Skipping is the safe direction: nothing unvisited can be deleted.
 */
const MAX_PREFIX_DEPTH = 3;
/** The marker some storage tools leave for an empty directory; never an object, kept out of every listing. */
const EMPTY_FOLDER_PLACEHOLDER = '.emptyFolderPlaceholder';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface StoredObject {
  readonly key: string;
  /**
   * The later of the object's creation and last update.
   *
   * The sweep's grace period asks "could a row for this still be on its way?", and the safest answer
   * comes from the most recent time Storage wrote these bytes, not the first. Taking the maximum can
   * only ever spare an object for longer; taking the minimum could delete one that was just written.
   */
  readonly lastWrittenAt: Date;
  readonly byteSize: number | null;
}

/** Every page of a listing, or a throw. A listing that half-worked must never look like an empty bucket. */
async function listAll(prefix: string, delimiter?: string): Promise<{ files: File[]; prefixes: string[] }> {
  const files: File[] = [];
  const prefixes: string[] = [];
  let pageToken: string | undefined;
  try {
    for (;;) {
      const [page, next, response] = await bucket().getFiles({
        prefix, delimiter, autoPaginate: false, maxResults: LIST_PAGE_SIZE, pageToken,
      });
      files.push(...page);
      const found = (response as { prefixes?: string[] } | undefined)?.prefixes;
      if (found) prefixes.push(...found);
      pageToken = (next as { pageToken?: string } | null)?.pageToken;
      if (!pageToken) return { files, prefixes };
    }
  } catch (error) {
    // Loud, because the caller deletes what it does not find. An error swallowed into `[]` here
    // would read to a sweep as "this organization owns nothing", which is the one lie that turns
    // this job into a data-loss incident.
    throw new InternalError(`The storage prefix ${prefix} could not be listed: ${(error as Error).message}`);
  }
}

/**
 * The organization prefixes present in a logical bucket, and the top-level entries that are not one.
 *
 * The sweep needs the organizations that have objects, not the organizations that have rows: an
 * organization purged from the database but whose objects survived a failed `org.purge` has no row
 * left to enumerate, and its leftover objects are exactly what wants collecting.
 */
export async function listOrganizationPrefixes(
  logicalBucket: string,
): Promise<{ organizationIds: string[]; ignored: string[] }> {
  objectFor(logicalBucket, 'x'); // validates the logical bucket
  const root = `${logicalBucket}/`;
  const { files, prefixes } = await listAll(root, '/');
  const organizationIds: string[] = [];
  const ignored: string[] = [];

  for (const p of prefixes) {
    const name = p.slice(root.length).replace(/\/$/, '');
    (UUID_PATTERN.test(name) ? organizationIds : ignored).push(name);
  }
  // A bare object at the bucket root belongs to no organization, so no row can claim it and no
  // context may legally delete it — it is reported, never swept.
  for (const f of files) {
    const name = f.name.slice(root.length);
    if (name && name !== EMPTY_FOLDER_PLACEHOLDER) ignored.push(name);
  }
  return { organizationIds, ignored };
}

/** Every object under `${orgId}/` in one logical bucket, within the depth budget. */
export async function listObjectsForOrganization(
  orgId: string,
  logicalBucket: string,
): Promise<StoredObject[]> {
  assertKeyBelongsTo(orgId, `${orgId}/`);
  objectFor(logicalBucket, `${orgId}/x`); // validates the logical bucket
  const root = `${logicalBucket}/`;
  const { files } = await listAll(`${root}${orgId}/`);

  const objects: StoredObject[] = [];
  const tooDeep: string[] = [];
  for (const f of files) {
    const key = f.name.slice(root.length);
    if (key.endsWith('/') || key.endsWith(`/${EMPTY_FOLDER_PLACEHOLDER}`)) continue;
    // Defence in depth: Storage returning a key outside the prefix it was asked for would be a bug
    // in Storage, and this sweep must not turn a bug in Storage into a deleted file.
    assertKeyBelongsTo(orgId, key);
    if (key.split('/').length - 1 > MAX_PREFIX_DEPTH) { tooDeep.push(key); continue; }
    const created = Date.parse(String(f.metadata.timeCreated ?? ''));
    const updated = Date.parse(String(f.metadata.updated ?? ''));
    const size = f.metadata.size === undefined ? null : Number(f.metadata.size);
    objects.push({
      key,
      // An object with no readable timestamp is treated as written NOW, which puts it inside every
      // grace period and therefore out of reach of this job.
      lastWrittenAt: new Date(Math.max(
        Number.isNaN(created) ? Date.now() : created,
        Number.isNaN(updated) ? Date.now() : updated,
      )),
      byteSize: size === null || Number.isNaN(size) ? null : size,
    });
  }
  if (tooDeep.length > 0) {
    // Not an error — nothing skipped can be deleted by this walk, which is the safe direction — but
    // a silence here would let a bucket grow a tree the sweep never sees.
    log.warn('storage walk skipped objects beyond its depth budget', {
      bucket: logicalBucket, orgId, depth: MAX_PREFIX_DEPTH, unvisited: tooDeep.slice(0, 50),
    });
  }
  return objects;
}

/** How many deletes run at once. */
const REMOVE_BATCH_SIZE = 100;

/**
 * Removes objects under one organization's prefix, and reports exactly which ones went.
 *
 * Every key is asserted individually before anything is sent, so a list that had somehow acquired a
 * foreign key is refused rather than partially honoured. What is reported removed is what Storage
 * confirmed deleting; an object that was not there is reported failed, as Supabase's `remove`
 * answered — a sweep that logged its intentions rather than its effects would be a record of nothing.
 */
export async function removeObjectsForOrganization(
  orgId: string,
  logicalBucket: string,
  keys: readonly string[],
): Promise<{ removed: string[]; failed: string[] }> {
  for (const key of keys) assertKeyBelongsTo(orgId, key);

  const removed: string[] = [];
  const failed: string[] = [];
  for (let start = 0; start < keys.length; start += REMOVE_BATCH_SIZE) {
    const batch = keys.slice(start, start + REMOVE_BATCH_SIZE);
    const outcomes = await Promise.all(batch.map(async (key) => {
      try {
        await objectFor(logicalBucket, key).delete();
        return true;
      } catch {
        return false;
      }
    }));
    batch.forEach((key, i) => (outcomes[i] ? removed : failed).push(key));
  }
  return { removed, failed };
}

/**
 * Every object an organisation has, in BOTH logical buckets, removed — the object half of
 * `org.purge` (TENANCY_MODEL.md §2). Built from the two functions above, so each key still passes
 * the tenant assertion on its own.
 */
export async function removeAllObjectsForOrganization(
  orgId: string,
): Promise<Record<string, { removed: number; failed: string[] }>> {
  const out: Record<string, { removed: number; failed: string[] }> = {};
  for (const logical of LOGICAL_BUCKETS) {
    const objects = await listObjectsForOrganization(orgId, logical);
    const { removed, failed } = await removeObjectsForOrganization(orgId, logical, objects.map((o) => o.key));
    out[logical] = { removed: removed.length, failed };
  }
  return out;
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

/** Phase 17: the PDF of a stored report — the path `api_server.record_report_pdf` derives. */
export function storedReportKey(orgId: string, reportId: string, fileId: string): string {
  return `${orgId}/r/${reportId}/${fileId}.pdf`;
}

/** Exported for tests: the key rules are the tenant boundary and must be directly assertable. */
export const __testing = {
  assertKeyBelongsTo, AUDIT_MAX_AGE_SECONDS, SIGNED_URL_TTL_SECONDS, signGrant, readGrant,
};
