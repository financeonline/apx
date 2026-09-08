import 'server-only';
import { purgeOrganization } from '@/core/db';
import { log } from '@/core/logging';
import {
  listObjectsForOrganization, removeObjectsForOrganization,
  REPORTS_BUCKET, SOURCE_DOCUMENTS_BUCKET,
} from '@/core/storage/signer';
import type { ClaimedJob, JobOutcome } from '../domain/types';

/**
 * `org.purge` (TENANCY_MODEL.md §2 lifecycle; SERVICE_ARCHITECTURE.md §7; ADR-038.9, ADR-038.12,
 * ADR-067).
 *
 * Thirty days after an owner confirms deletion, this is what makes it true. Until it existed the
 * trigger queued the job, `claim_job` let it through for the closing organisation, the worker found
 * no handler, and the job died after three attempts — invisibly, because nothing listed dead jobs.
 * The product told the customer their data would be gone; it stayed (PRODUCTION_AUDIT.md C3).
 *
 * Two halves, in this order and no other:
 *
 *   1. **Rows, in one transaction** — `api_server.purge_organization` re-verifies that the
 *      organisation is still `pending_deletion` and has been for thirty days, waits (by deferring
 *      this job) while any other job of the organisation is running, deletes every tenant row,
 *      redacts the audit trail, and marks the organisation `deleted`. After that commit nothing can
 *      bring the organisation back.
 *   2. **Objects** — both Storage prefixes, through the signer's per-organisation surface, which
 *      asserts `${orgId}/` on every key it lists and every key it removes.
 *
 * Rows before objects, because a cancellation between the two steps must find an organisation whose
 * files are still there. A retry after the rows went finds `already_deleted` in step 1 and just
 * finishes step 2. And if step 2 fails for good, the job dies (`job.dead`, visible on
 * `/platform/jobs`) and the nightly `storage.cleanup_orphans` still collects objects no row claims.
 *
 * The organisation comes from `jobs.organization_id`, never from the payload (SECURITY_MODEL.md §9).
 */

interface RowPurgeResult {
  readonly status: 'purged' | 'already_deleted' | 'waiting';
  readonly rows?: Record<string, number>;
  readonly audit_events_redacted?: number;
  readonly running_jobs?: number;
}

interface BucketPurge {
  readonly bucket: string;
  readonly examined: number;
  readonly removed: number;
  readonly failed: number;
}

export async function runOrgPurgeJob(job: ClaimedJob): Promise<JobOutcome> {
  const orgId = job.organizationId;
  if (orgId === null) {
    return { status: 'failed', error: 'org.purge needs an organisation; this job has none.' };
  }

  // A CONFLICT from the function — not scheduled, scheduled too recently, a table left behind — is
  // thrown, not caught: the worker records a thrown error as a failed attempt, three of which make
  // the job `dead` and visible on /platform/jobs, which is exactly where a refused purge belongs.
  const rows = (await purgeOrganization(orgId, job.jobId)) as unknown as RowPurgeResult;
  if (rows.status === 'waiting') {
    log.info('org.purge is waiting for the organisation’s other jobs to finish', {
      jobId: job.jobId, organizationId: orgId, runningJobs: rows.running_jobs ?? null,
    });
    return { status: 'deferred_upstream', result: { rows } };
  }

  const buckets: BucketPurge[] = [];
  for (const bucket of [SOURCE_DOCUMENTS_BUCKET, REPORTS_BUCKET]) {
    const objects = await listObjectsForOrganization(orgId, bucket);
    const { removed, failed } = await removeObjectsForOrganization(
      orgId, bucket, objects.map((object) => object.key),
    );
    buckets.push({ bucket, examined: objects.length, removed: removed.length, failed: failed.length });
    if (failed.length > 0) {
      // Not fatal to the rows — they are already gone — but this attempt is not finished, and the
      // objects that stayed are named in the log rather than assumed collected.
      log.error('org.purge could not remove every object', {
        jobId: job.jobId, organizationId: orgId, bucket, failed,
      });
      return {
        status: 'failed',
        error: `${failed.length} object(s) in ${bucket} could not be removed`,
        result: { rows, buckets },
      };
    }
  }

  log.info('organisation purged', { jobId: job.jobId, organizationId: orgId, rows, buckets });
  return { status: 'succeeded', result: { rows, buckets } };
}
