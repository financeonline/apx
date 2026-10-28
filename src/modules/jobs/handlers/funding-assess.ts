import 'server-only';
import type { Db } from '@/db/types';
import { runFundingAssessment, type FundingTrigger } from '@/modules/funding';
import type { ClaimedJob, JobOutcome } from '../domain/types';

/**
 * `funding.assess` (Phase 16; ADR-121, ADR-145). Queued by enabling the flag (same transaction), after
 * every successful calculation while it is on, and by the nightly backstop. Assesses every complete
 * month whose current assessment does not cite that month's current run; writes nothing while off.
 */
const TRIGGERS: readonly FundingTrigger[] = ['enablement_backfill', 'calculation_run', 'nightly_backstop'];

export async function runFundingAssessJob(job: ClaimedJob, scope: { db: unknown }): Promise<JobOutcome> {
  const orgId = job.organizationId;
  if (orgId === null) return { status: 'failed', error: 'funding.assess has no organization to scope to' };
  const raw = job.payload.trigger;
  const trigger = typeof raw === 'string' && (TRIGGERS as readonly string[]).includes(raw) ? raw as FundingTrigger : 'nightly_backstop';
  const result = await runFundingAssessment(scope.db as Db, orgId, trigger);
  return { status: 'succeeded', result };
}
