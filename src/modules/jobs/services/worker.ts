import 'server-only';
import { randomUUID } from 'node:crypto';
import { claimJob, createServiceClient, finishJob, withOrgScope } from '@/core/db';
import { log } from '@/core/logging';
import type { ClaimedJob, JobOutcome, JobType } from '../domain/types';

/**
 * The job worker (ADR-013, ADR-031.3, ADR-038.12, ADR-044.6).
 *
 * Two rules govern everything here.
 *
 * **The organization comes from the `jobs` row, never from the payload.** A payload is data; if the
 * scope were read from it, a job whose payload named another organization would run against that
 * organization with the service role, which bypasses RLS. `withOrgScope(job.organizationId)` is the
 * only scope used, and the handler receives that scope rather than the raw client.
 *
 * **Claiming and finishing are separate database calls.** If a worker dies mid-handler the job stays
 * `running` and is reclaimed by `app.reclaim_stale_jobs()` after its budget × 3 — delayed, not lost.
 * Wrapping both in one call would lose the job on any crash.
 */

export type JobHandler = (job: ClaimedJob, scope: { db: unknown }) => Promise<JobOutcome>;

/**
 * Handlers arrive with the phases that own them: `calculation.run` and `snapshots.compact` in
 * Phase 6, `document.extract` and `import.commit_large` in Phase 5, `alerts.evaluate` in Phase 9,
 * `report.render` in Phase 13, `org.purge` and `storage.cleanup_orphans` in Phase 15.
 *
 * A job type with no handler is NOT silently succeeded — that would let a queued calculation quietly
 * disappear and leave the dashboard stale with no trace. It fails with a clear reason and retries,
 * which is visible in `/platform/jobs`.
 */
const HANDLERS = new Map<JobType, JobHandler>();

export function registerJobHandler(type: JobType, handler: JobHandler): void {
  HANDLERS.set(type, handler);
}

/** Exported so tests can drive the loop deterministically. */
export const __handlers = HANDLERS;

async function claimOne(workerId: string): Promise<ClaimedJob | null> {
  const row = await claimJob(workerId);
  if (!row) return null;
  return { ...row, jobType: row.jobType as JobType };
}

async function runOne(job: ClaimedJob): Promise<JobOutcome> {
  const handler = HANDLERS.get(job.jobType);
  if (!handler) {
    return {
      status: 'failed',
      error: `No handler is registered for ${job.jobType}. It arrives with the phase that owns it.`,
    };
  }

  try {
    if (job.organizationId === null) {
      // Platform-level work (storage.cleanup_orphans, snapshots.compact) has no tenant to scope to.
      return await handler(job, { db: createServiceClient() });
    }
    // The scope is the row's organization. Nothing reads the payload for it.
    return await withOrgScope(job.organizationId, (scope) => handler(job, scope));
  } catch (cause) {
    return { status: 'failed', error: cause instanceof Error ? cause.message : String(cause) };
  }
}

export interface DrainResult {
  readonly claimed: number;
  readonly succeeded: number;
  readonly failed: number;
}

/**
 * Claims and runs up to `maxJobs` jobs. Bounded because a cron invocation has a wall-clock budget;
 * whatever is left is picked up by the next tick rather than risking a mid-job timeout.
 */
export async function drainJobs(maxJobs = 5): Promise<DrainResult> {
  const workerId = `worker-${randomUUID().slice(0, 8)}`;
  let claimed = 0;
  let succeeded = 0;
  let failed = 0;

  for (let i = 0; i < maxJobs; i += 1) {
    const job = await claimOne(workerId);
    if (!job) break;
    claimed += 1;

    const outcome = await runOne(job);
    await finishJob(job.jobId, outcome.status, outcome.result ?? {}, outcome.error ?? null);

    if (outcome.status === 'succeeded') {
      succeeded += 1;
    } else {
      failed += 1;
      log.warn('job did not succeed', {
        jobId: job.jobId,
        jobType: job.jobType,
        attempt: job.attempts,
        status: outcome.status,
        error: outcome.error,
      });
    }
  }

  return { claimed, succeeded, failed };
}
