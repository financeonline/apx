import 'server-only';
import type { Firestore, Transaction } from 'firebase-admin/firestore';
import { globalRow, newId, nowIso, uniqueGuard } from '../schema';
import { mergedCalculationPayload, prepareRecalculation, type PreparedEnqueue } from './jobs';

/**
 * `app.enqueue_recalculation`, called more than once in ONE transaction.
 *
 * `api.replace_import_batch` rolls one batch back and commits another in a single transaction, and
 * each half asks for a recalculation. On PostgreSQL the second `insert … on conflict do update`
 * found the first one's queued job and merged into it. Here the second request cannot see the
 * first (both are still unwritten), so the requests are folded into one payload before the single
 * write — `mergedCalculationPayload` applied in order, exactly what the two statements produced.
 *
 * One request is `prepareRecalculation` itself (src/db/app/jobs.ts); the job row written for several
 * is the one `prepareEnqueue` writes.
 */
export async function prepareRecalcRequests(
  fs: Firestore, orgId: string, requests: ReadonlyArray<{ trigger: string; refId: string | null }>,
  requestedBy: string | null, tx: Transaction,
): Promise<PreparedEnqueue> {
  if (requests.length === 1) {
    return prepareRecalculation(fs, orgId, requests[0]!.trigger, requests[0]!.refId, requestedBy, tx);
  }
  const key = `calculation.run:${orgId}`;
  const guard = uniqueGuard(fs, 'global', 'jobs_idempotency_queued', ['calculation.run', key]);
  const claim = await guard.read(tx);
  const now = nowIso();
  const payloads = requests.map((r) => ({ trigger: r.trigger, triggerRefId: r.refId }));
  if (claim.owner) {
    const ref = globalRow(fs, 'jobs', claim.owner);
    const existing = await tx.get(ref);
    if (existing.exists && existing.get('status') === 'queued') {
      let payload = (existing.get('payload') as Record<string, unknown> | undefined) ?? {};
      for (const p of payloads) payload = mergedCalculationPayload(payload, p);
      return { id: claim.owner, merged: true, write: (t) => { t.update(ref, { payload, updated_at: now }); } };
    }
  }
  let payload: Record<string, unknown> = payloads[0]!;
  for (const p of payloads.slice(1)) payload = mergedCalculationPayload(payload, p);
  const id = newId();
  const row = {
    id, organization_id: orgId, job_type: 'calculation.run', idempotency_key: key, payload,
    requested_by: requestedBy, status: 'queued', attempts: 0, max_attempts: 3, run_after: now,
    locked_at: null, locked_by: null, last_error: null, result: null, finished_at: null,
    created_at: now, updated_at: now,
  };
  return {
    id,
    merged: false,
    write(t) {
      t.set(globalRow(fs, 'jobs', id), row);
      t.set(guard.ref, { owner_id: id, constraint: 'jobs_idempotency_queued', created_at: now });
    },
  };
}
