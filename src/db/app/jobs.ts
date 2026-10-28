import 'server-only';
import type { DocumentReference, Firestore, Transaction } from 'firebase-admin/firestore';
import { globalRow, newId, nowIso, uniqueGuard } from '../schema';

/**
 * The job queue's write side (JOB_ARCHITECTURE.md, ADR-013): the one place a `jobs` document is
 * created, shared by every area that enqueues work.
 *
 * `jobs_idempotency_queued_unique` — at most one QUEUED job per (job_type, idempotency_key) — is a
 * global guard document (`_unique/jobs_idempotency_queued__…`) held by the queued job. Enqueueing
 * again while it is queued MERGES the payload into that job instead of adding a second one, as the
 * SQL `on conflict … do update` did. The claimer must call `releaseQueuedGuard` when it moves the
 * job out of `queued`, so the next enqueue starts a new job.
 */

export type PayloadMerge = 'shallow' | 'calculation';

export interface EnqueueInput {
  readonly organizationId: string | null;
  readonly jobType: string;
  readonly payload: Record<string, unknown>;
  readonly requestedBy: string | null;
  /** Null for a job that is never merged. */
  readonly idempotencyKey: string | null;
  readonly merge?: PayloadMerge;
  readonly runAfter?: string;
  readonly maxAttempts?: number;
}

export interface PreparedEnqueue {
  /** The queued job's id: an existing one when the payload merges into it. */
  readonly id: string;
  readonly merged: boolean;
  write(tx: Transaction): void;
}

function guardFor(fs: Firestore, jobType: string, key: string) {
  return uniqueGuard(fs, 'global', 'jobs_idempotency_queued', [jobType, key]);
}

/** Reads the queue for an existing queued job; `write` inserts or merges. Reads only until `write`. */
export async function prepareEnqueue(fs: Firestore, input: EnqueueInput, tx: Transaction): Promise<PreparedEnqueue> {
  const now = nowIso();
  if (input.idempotencyKey) {
    const guard = guardFor(fs, input.jobType, input.idempotencyKey);
    const claim = await guard.read(tx);
    if (claim.owner) {
      const ref = globalRow(fs, 'jobs', claim.owner);
      const existing = await tx.get(ref);
      if (existing.exists && existing.get('status') === 'queued') {
        const current = (existing.get('payload') as Record<string, unknown> | undefined) ?? {};
        const payload = input.merge === 'calculation'
          ? mergedCalculationPayload(current, input.payload)
          : { ...current, ...input.payload };
        return { id: claim.owner, merged: true, write: (t) => { t.update(ref, { payload, updated_at: now }); } };
      }
    }
  }
  const id = newId();
  const row = {
    id,
    organization_id: input.organizationId,
    job_type: input.jobType,
    idempotency_key: input.idempotencyKey,
    payload: input.payload,
    requested_by: input.requestedBy,
    status: 'queued',
    attempts: 0,
    max_attempts: input.maxAttempts ?? 3,
    run_after: input.runAfter ?? now,
    locked_at: null,
    locked_by: null,
    last_error: null,
    result: null,
    finished_at: null,
    created_at: now,
    updated_at: now,
  };
  return {
    id,
    merged: false,
    write(t) {
      t.set(globalRow(fs, 'jobs', id), row);
      if (input.idempotencyKey) {
        t.set(guardFor(fs, input.jobType, input.idempotencyKey).ref, {
          owner_id: id, constraint: 'jobs_idempotency_queued', created_at: now,
        });
      }
    },
  };
}

/** Releases the "one queued job per key" guard when a job leaves `queued` (claimed, cancelled). */
export function releaseQueuedGuard(fs: Firestore, tx: Transaction, job: { job_type: string; idempotency_key: string | null }): void {
  if (job.idempotency_key) tx.delete(guardFor(fs, job.job_type, job.idempotency_key).ref);
}

/**
 * `app.enqueue_recalculation(org, trigger, ref)`: ask for the organisation's figures to be
 * recalculated. Every write that changes an input to the engine calls this, inside its own
 * transaction, so the request is never lost and concurrent requests merge into one queued run.
 */
export async function prepareRecalculation(
  fs: Firestore, orgId: string, trigger: string, refId: string | null, requestedBy: string | null, tx: Transaction,
): Promise<PreparedEnqueue> {
  return prepareEnqueue(fs, {
    organizationId: orgId,
    jobType: 'calculation.run',
    payload: { trigger, triggerRefId: refId },
    requestedBy,
    idempotencyKey: `calculation.run:${orgId}`,
    merge: 'calculation',
  }, tx);
}

/** `app.merged_calculation_payload`: how two queued recalculation requests combine. */
export function mergedCalculationPayload(
  queued: Record<string, unknown> | null, other: Record<string, unknown> | null,
): Record<string, unknown> {
  if (!queued) return other ?? {};
  if (!other) return queued;
  const strong = new Set(['recalc_manual', 'account_remapped', 'settings_changed']);
  if (queued.trigger === 'scheduled') return other;
  if (other.trigger === 'scheduled') return queued;
  if (strong.has(String(queued.trigger))) return queued;
  if (strong.has(String(other.trigger))) return other;
  if (JSON.stringify(queued) === JSON.stringify(other)) return queued;
  const refsOf = (p: Record<string, unknown>) => (Array.isArray(p.refs)
    ? (p.refs as unknown[])
    : [{ trigger: p.trigger ?? null, triggerRefId: p.triggerRefId ?? null }]);
  const seen = new Map<string, unknown>();
  for (const r of [...refsOf(queued), ...refsOf(other)]) seen.set(JSON.stringify(r), r);
  const refs = [...seen.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, r]) => r);
  return { trigger: queued.trigger ?? null, triggerRefId: queued.triggerRefId ?? null, refs };
}

/** `app.job_max_runtime`: how long a claimed job may run before it is reclaimed. */
export function jobMaxRuntimeSeconds(jobType: string): number {
  switch (jobType) {
    case 'calculation.run':
    case 'import.commit_large':
    case 'marketing.generate':
    case 'investment.generate':
      return 300;
    case 'document.extract':
      return 600;
    case 'org.purge':
      return 1800;
    default:
      return 120;
  }
}

/** The job document, for areas that read one by id. */
export function jobRef(fs: Firestore, id: string): DocumentReference {
  return globalRow(fs, 'jobs', id);
}
