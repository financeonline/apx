import 'server-only';
import type { Db } from '@/db/types';
import { commitImportBatch } from '@/modules/imports';
import type { ClaimedJob, JobOutcome } from '../domain/types';

/**
 * `import.commit_large` (IMPORT_ENGINE.md §11, IMPLEMENTATION_PLAN.md Phase 5 slice 7).
 *
 * A batch of more than five thousand rows commits on the queue rather than in the request, because
 * the commit takes an advisory lock on the organisation and re-checks every duplicate; doing that
 * inside a browser request means a timeout mid-commit, and a timeout mid-commit is exactly the
 * situation the batch state machine exists to avoid.
 *
 * The commit itself is one SQL function, so a worker killed part-way leaves zero target rows and the
 * batch back in `awaiting_review` — the property the integration suite asserts.
 */
export async function commitLargeBatchJob(
  job: ClaimedJob,
  scope: { db: unknown },
): Promise<JobOutcome> {
  const batchId = typeof job.payload.batch_id === 'string' ? job.payload.batch_id : null;
  if (batchId === null) {
    return { status: 'failed', error: 'import.commit_large needs the batch it is committing' };
  }

  const result = await commitImportBatch(scope.db as Db, batchId);
  return { status: 'succeeded', result: { ...result } };
}
