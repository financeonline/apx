import 'server-only';
import type { Db } from '@/db/types';
import { orgCollection, type OrgTable } from '@/db/schema';
import { pruneRateLimits, recordStorageCleanup } from '@/core/db';
import { log } from '@/core/logging';
import {
  listObjectsForOrganization, listOrganizationPrefixes, removeObjectsForOrganization,
  REPORTS_BUCKET, SOURCE_DOCUMENTS_BUCKET, type StoredObject,
} from '@/core/storage/signer';
import type { ClaimedJob, JobOutcome } from '../domain/types';

/**
 * `storage.cleanup_orphans` (SERVICE_ARCHITECTURE.md §7; TENANCY_MODEL.md §8; SECURITY_MODEL.md §5b;
 * ADR-043.4, ADR-062.2).
 *
 * Two places in the product already promise this job exists. `api.delete_document` marks the row and
 * returns the path for the signer to remove, and a failed removal is deliberately not fatal because
 * "cleanup_orphans finishes the job". `report.render` writes the PDF object BEFORE recording the
 * `report_files` row, because a row naming an object that is not there is worse than an object no
 * row names — on the stated understanding that the object gets collected. Until this handler existed
 * neither was true, and the job type itself failed with "No handler is registered".
 *
 * ## Why this is written the way it is
 *
 * This is the only job in MOTION that destroys customer data, and it does it from the wrong end: it
 * starts with the objects rather than with a row that asked for something. Every other job can be
 * wrong and be re-run. This one cannot. So the design question is not "how do I find every orphan",
 * it is "what has to be true before I delete anything", and the answer is three independent things,
 * any ONE of which failing must leave the file alone:
 *
 *   1. **Age.** Nothing younger than {@link ORPHAN_GRACE_MS} is touched, because the upload order is
 *      signer-write → register → finalize (ADR-043.4): a young object with no row is not an orphan,
 *      it is an upload in flight. Same for `report.render`, whose object precedes its row.
 *   2. **A complete read of what is claimed.** The claimed set is paged to exhaustion and a query
 *      error THROWS. An error swallowed into an empty result would read as "this organization owns
 *      nothing", and that single lie is the whole catastrophe.
 *   3. **The organization prefix.** Objects are enumerated and removed one organization at a time,
 *      through a signer surface that asserts `${orgId}/` on every key. A sweep cannot cross a tenant
 *      boundary any more than an upload can.
 *
 * On top of those, {@link MAX_REMOVALS_PER_RUN} bounds the blast radius of a bug none of the three
 * caught: whatever a sweep believes, it stops after that many objects and says so, and the rest waits
 * for tomorrow night. A nightly job has no need to be in a hurry, and a cap turns "a bug emptied the
 * bucket" into "a bug removed a bounded number of files and left a loud result".
 */

/**
 * Twenty-four hours, which is what SERVICE_ARCHITECTURE.md §7 already specifies for this job
 * ("delete objects with no `source_documents`/`report_files` row older than 24 h").
 *
 * The figure is not arbitrary and it is not tight. The window it has to cover is the gap between the
 * object write and the row write: inside one HTTP request for an upload, and inside one job attempt
 * for a render — both bounded by the platform's function timeout, which is minutes at the very most.
 * Twenty-four hours is that window several hundred times over, and it also survives the case nobody
 * thinks of until it happens: a worker that dies between the two writes, whose job is reclaimed after
 * `max_runtime × 3` (ADR-044.6) and retried, and whose first object should not be collected while its
 * retry is still in the queue. Buying that much margin costs one extra night before a genuine orphan
 * is collected, and orphans are not urgent — nobody is waiting for one to disappear.
 */
export const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;

/** The blast-radius cap: what one sweep may remove before it stops and reports. */
export const MAX_REMOVALS_PER_RUN = 1000;

/** PostgREST's `max_rows` is 1000; asking for more would silently truncate the claimed set. */
const CLAIM_PAGE_SIZE = 1000;

/**
 * Which table claims which bucket, and by which columns.
 *
 * `source_documents` claims through TWO columns. `storage_path` is the uploaded file;
 * `extracted_text_path` is the `text.json` sidecar that TENANCY_MODEL.md §8 puts under the same
 * document prefix, and which has no row of its own. Sweeping on `storage_path` alone would read the
 * sidecar of a perfectly live document as an orphan and delete the extracted text out from under it.
 *
 * The invariant that falls out, and that a future `document.extract` must keep: **anything written
 * under a document's prefix has to be named by a column of that document's row, or this job will
 * eventually remove it.**
 */
const SWEEPS = [
  {
    bucket: SOURCE_DOCUMENTS_BUCKET,
    table: 'source_documents',
    columns: ['storage_path', 'extracted_text_path'],
  },
  {
    bucket: REPORTS_BUCKET,
    table: 'report_files',
    columns: ['storage_path'],
  },
] as const;

export interface BucketSweepResult {
  readonly bucket: string;
  readonly organisations: number;
  readonly examined: number;
  readonly orphans: number;
  readonly removed: number;
  readonly failed: number;
  /** Top-level entries that are not an organization prefix, so nothing may be deleted under them. */
  readonly ignoredPrefixes: readonly string[];
}

/**
 * Every path an organization's live rows currently claim in one bucket.
 *
 * Keyset pagination on `storage_path` rather than `offset`, because rows can be inserted while the
 * sweep is walking and an offset would then skip one — and a path missing from this set is a file
 * that gets deleted. A row soft-deleted mid-sweep goes the other way and is simply collected on the
 * next run, which is the direction it is safe to be wrong in.
 */
async function claimedPaths(
  db: Db,
  table: OrgTable,
  columns: readonly string[],
  orgId: string,
  bucket: string,
): Promise<Set<string>> {
  const claimed = new Set<string>();
  let after = '';

  for (;;) {
    // Not a swallowed error. The rest of this file treats "not in the set" as "delete it", so a
    // failed read must stop the sweep for this organization rather than become an empty answer —
    // `get()` rejects, and the rejection propagates.
    const snap = await orgCollection(db.fs, orgId, table)
      .where('storage_bucket', '==', bucket)
      .where('deleted_at', '==', null)
      .where('storage_path', '>', after)
      .orderBy('storage_path', 'asc')
      .limit(CLAIM_PAGE_SIZE)
      .get()
      .catch((error: unknown) => {
        throw new Error(`${table} could not be read for ${orgId}: ${error instanceof Error ? error.message : String(error)}`);
      });
    const rows = snap.docs.map((d) => d.data() as Record<string, string | null>);

    for (const row of rows) {
      for (const column of columns) {
        const value = row[column];
        if (typeof value === 'string' && value.length > 0) claimed.add(value);
      }
    }

    if (rows.length < CLAIM_PAGE_SIZE) return claimed;
    after = rows[rows.length - 1]?.storage_path ?? '';
    if (after === '') return claimed;
  }
}

function isOrphan(object: StoredObject, claimed: ReadonlySet<string>, before: number): boolean {
  if (claimed.has(object.key)) return false;
  return object.lastWrittenAt.getTime() <= before;
}

/** Sweeps one bucket for one organization and returns what it did. */
async function sweepOrganization(
  db: Db,
  job: ClaimedJob,
  sweep: (typeof SWEEPS)[number],
  orgId: string,
  budget: number,
  now: number,
): Promise<{ examined: number; orphans: number; removed: number; failed: number }> {
  const objects = await listObjectsForOrganization(orgId, sweep.bucket);
  if (objects.length === 0) return { examined: 0, orphans: 0, removed: 0, failed: 0 };

  const claimed = await claimedPaths(db, sweep.table, sweep.columns, orgId, sweep.bucket);
  const before = now - ORPHAN_GRACE_MS;
  const orphans = objects.filter((object) => isOrphan(object, claimed, before)).map((o) => o.key);
  if (orphans.length === 0) {
    return { examined: objects.length, orphans: 0, removed: 0, failed: 0 };
  }

  const outcome = await removeObjectsForOrganization(orgId, sweep.bucket, orphans.slice(0, budget));

  /*
   * The keys, not the counts, and at info rather than debug: "which file did the sweep take?" is the
   * question an operator turns up with, and it has to be answerable from the logs alone because the
   * audit row deliberately carries no paths (ADR-038.9).
   */
  if (outcome.removed.length > 0) {
    log.info('storage sweep removed orphaned objects', {
      jobId: job.jobId,
      organizationId: orgId,
      bucket: sweep.bucket,
      removed: outcome.removed,
    });
  }
  if (outcome.failed.length > 0) {
    log.warn('storage sweep could not remove some objects', {
      jobId: job.jobId, organizationId: orgId, bucket: sweep.bucket, failed: outcome.failed,
    });
  }

  if (outcome.removed.length > 0 || outcome.failed.length > 0) {
    await recordStorageCleanup({
      organizationId: orgId,
      jobId: job.jobId,
      bucket: sweep.bucket,
      examined: objects.length,
      removed: outcome.removed.length,
      failed: outcome.failed.length,
    });
  }

  return {
    examined: objects.length,
    orphans: orphans.length,
    removed: outcome.removed.length,
    failed: outcome.failed.length,
  };
}

/**
 * Sweeps both private buckets.
 *
 * Platform-level: the job normally carries no organization, and the worker hands a plain service
 * client for that case. An organization-scoped enqueue is honoured too and sweeps that organization
 * alone, which is what an operator re-running one tenant after a failed `org.purge` wants — and what
 * makes the boundary directly testable.
 */
export async function runStorageCleanupJob(
  job: ClaimedJob,
  scope: { db: unknown },
): Promise<JobOutcome> {
  const db = scope.db as Db;
  const now = Date.now();
  const buckets: BucketSweepResult[] = [];
  let budget = MAX_REMOVALS_PER_RUN;

  for (const sweep of SWEEPS) {
    const { organizationIds, ignored } = job.organizationId === null
      ? await listOrganizationPrefixes(sweep.bucket)
      : { organizationIds: [job.organizationId], ignored: [] as string[] };

    let examined = 0;
    let orphans = 0;
    let removed = 0;
    let failed = 0;

    for (const orgId of organizationIds) {
      const result = await sweepOrganization(db, job, sweep, orgId, budget, now);
      examined += result.examined;
      orphans += result.orphans;
      removed += result.removed;
      failed += result.failed;
      budget -= result.removed;
      if (budget <= 0) break;
    }

    if (ignored.length > 0) {
      // Not deleted, and deliberately so: an entry that is not an organization prefix cannot be
      // claimed by any row (every path starts with an organization id) and cannot be removed under
      // any organization's assertion either. Removing it would mean a delete with no tenant context,
      // which is the one thing this job refuses to own.
      log.warn('storage sweep found entries outside any organization prefix', {
        jobId: job.jobId, bucket: sweep.bucket, entries: ignored,
      });
    }

    buckets.push({
      bucket: sweep.bucket,
      organisations: organizationIds.length,
      examined,
      orphans,
      removed,
      failed,
      ignoredPrefixes: ignored,
    });
  }

  const removed = buckets.reduce((total, b) => total + b.removed, 0);
  const capped = budget <= 0;

  /*
   * Retention rides with the platform-wide sweep, whose job DATABASE_ARCHITECTURE.md §7 always said
   * it was (ADR-074): `app.throttle` upserts one `api_rate_limits` row per user, per bucket, per
   * minute and deletes none of them. Two days keeps every live window. A per-organisation sweep
   * leaves the counter alone — it is a platform table, and the platform run is the one that owns it.
   */
  const rateLimitRowsPruned = job.organizationId === null ? await pruneRateLimits() : null;

  log.info('storage sweep complete', {
    jobId: job.jobId,
    scope: job.organizationId ?? 'platform',
    graceHours: ORPHAN_GRACE_MS / 3_600_000,
    removed,
    capped,
    buckets: buckets.map((b) => ({ bucket: b.bucket, examined: b.examined, removed: b.removed })),
  });

  return {
    status: 'succeeded',
    result: {
      removed,
      // A capped run is not a failure, but it is not a clean sweep either, and the next one has work
      // waiting. An operator seeing this repeatedly is looking at something worth investigating.
      capped,
      graceHours: ORPHAN_GRACE_MS / 3_600_000,
      buckets: buckets.map((b) => ({ ...b, ignoredPrefixes: [...b.ignoredPrefixes] })),
      rateLimitRowsPruned,
    },
  };
}
