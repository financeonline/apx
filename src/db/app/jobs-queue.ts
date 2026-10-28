import 'server-only';
import type { DocumentData, Firestore, Transaction } from 'firebase-admin/firestore';
import { globalRow, nowIso, orgCollection, uniqueGuard } from '../schema';
import { mergedCalculationPayload, jobMaxRuntimeSeconds, jobRef } from './jobs';

/**
 * The queue's read side and its state changes, used only by the job area (`api_server.claim_job`,
 * `finish_job` and `app.reclaim_stale_jobs`; JOB_ARCHITECTURE.md, ADR-013, ADR-044.6).
 *
 * Firestore has no partial unique index, so `jobs_idempotency_queued_unique` is a guard document the
 * QUEUED job holds (`src/db/app/jobs.ts`). Every transition here keeps it true: a job leaving
 * `queued` releases it, a job coming BACK to `queued` (a failure retry, a lost worker) takes it
 * again — and when another queued job already holds it, that job is the twin the SQL looked up with
 * `where status = 'queued' and job_type = … and idempotency_key = …`, and the returning job is
 * coalesced into it instead, exactly as the SQL coalesced rather than violate the index.
 *
 * The two `AFTER UPDATE OF status` triggers on `jobs` (`marketing_job_ended`,
 * `investment_job_ended`) are done by the transition itself: `prepareJobEnded` reads the attempt rows
 * with the other reads, and its `write` marks them failed with the trigger's sentence.
 */

export const GUARD = 'jobs_idempotency_queued';

export function queuedGuard(fs: Firestore, jobType: string, key: string) {
  return uniqueGuard(fs, 'global', GUARD, [jobType, key]);
}

export interface JobDoc extends DocumentData {
  id: string;
  organization_id: string | null;
  job_type: string;
  idempotency_key: string | null;
  payload: Record<string, unknown> | null;
  requested_by: string | null;
  status: string;
  attempts: number;
  max_attempts: number;
  run_after: string;
  locked_at: string | null;
  created_at: string;
}

/**
 * The queued job holding a key, or null — `select q.id from jobs q where q.status = 'queued' and
 * q.job_type = … and q.idempotency_key = …`. A guard whose owner is no longer queued (a job a
 * platform path moved on without releasing it) names nobody.
 */
export async function queuedTwin(
  fs: Firestore, tx: Transaction, jobType: string, key: string | null, self: string,
): Promise<JobDoc | null> {
  if (!key) return null;
  const snap = await tx.get(queuedGuard(fs, jobType, key).ref);
  const owner = snap.exists ? (snap.get('owner_id') as string | undefined) ?? null : null;
  if (!owner || owner === self) return null;
  const twin = await tx.get(jobRef(fs, owner));
  if (!twin.exists || twin.get('status') !== 'queued') return null;
  return twin.data() as JobDoc;
}

/** The payload a twin ends with when `other` coalesces into it (the SQL's `case` on the job type). */
export function coalescedPayload(jobType: string, twin: Record<string, unknown> | null, other: Record<string, unknown> | null) {
  return jobType === 'calculation.run'
    ? mergedCalculationPayload(twin ?? {}, other ?? {})
    : { ...(other ?? {}), ...(twin ?? {}) };
}

const ENDED: Record<string, { table: 'marketing_reports' | 'investment_reports'; failure: string }> = {
  'marketing.generate': {
    table: 'marketing_reports', failure: 'The report could not be finished. Refresh it to try again.',
  },
  'investment.generate': {
    table: 'investment_reports', failure: 'The pack could not be finished. Refresh it to try again.',
  },
};

const ENDED_STATUSES: ReadonlySet<string> = new Set(['succeeded', 'dead', 'cancelled']);

/**
 * `app.marketing_job_ended` / `app.investment_job_ended`: a report job that ended (succeeded, dead
 * or cancelled) leaves no attempt `queued` or `running`. Reads now; `write(tx, newStatus)` applies
 * the trigger's effect when `newStatus` is one it fires on.
 */
export async function prepareJobEnded(
  fs: Firestore, tx: Transaction, job: Pick<JobDoc, 'id' | 'job_type' | 'organization_id'>,
): Promise<{ write(t: Transaction, newStatus: string): void }> {
  const rule = ENDED[job.job_type];
  if (!rule || !job.organization_id) return { write() {} };
  const rows = await tx.get(orgCollection(fs, job.organization_id, rule.table).where('job_id', '==', job.id));
  const open = rows.docs.filter((d) => d.get('status') === 'queued' || d.get('status') === 'running');
  return {
    write(t, newStatus) {
      if (!ENDED_STATUSES.has(newStatus)) return;
      const now = nowIso();
      for (const d of open) t.update(d.ref, { status: 'failed', failure: rule.failure, finished_at: now, updated_at: now });
    },
  };
}

/** The organisation's status, for the claim's "work for a suspended organisation waits" rule. */
export async function orgStatuses(fs: Firestore, tx: Transaction, ids: readonly string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const snaps = await tx.getAll(...unique.map((id) => globalRow(fs, 'organizations', id)));
  return new Map(snaps.filter((s) => s.exists).map((s) => [s.id, String(s.get('status'))]));
}

/** `locked_at < now() - app.job_max_runtime(job_type) * 3`. */
export function isStale(job: JobDoc, now: number): boolean {
  if (!job.locked_at) return false;
  return new Date(job.locked_at).getTime() < now - jobMaxRuntimeSeconds(job.job_type) * 3 * 1000;
}

/** Total order the SQL used: `order by created_at, id`. */
export function byCreated(a: JobDoc, b: JobDoc): number {
  return a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
