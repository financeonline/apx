import 'server-only';
import type { Db } from '@/db/types';
import { runMarketingReport } from '@/modules/marketing';
import type { ClaimedJob, JobOutcome } from '../domain/types';

/**
 * `marketing.generate` (ADR-170). Queued by `api.request_marketing_report` with the attempt it fills
 * (`payload.reportId`) and ONE attempt: each is a paid model call, so the queue never retries it.
 *
 * A report the model could not write is recorded on its row in plain words, and the job is `failed`
 * (with one attempt, `dead`) so /platform/jobs shows it too. Nothing to do — the attempt already
 * finished, or Marketing was switched off after it was asked for — is a success that did nothing.
 */
export async function runMarketingGenerateJob(job: ClaimedJob, scope: { db: unknown }): Promise<JobOutcome> {
  const orgId = job.organizationId;
  if (orgId === null) return { status: 'failed', error: 'marketing.generate has no organization to scope to' };
  const reportId = typeof job.payload.reportId === 'string' ? job.payload.reportId : undefined;

  const outcome = await runMarketingReport(scope.db as Db, orgId, reportId);
  switch (outcome.status) {
    case 'ready':
      return {
        status: 'succeeded',
        result: { reportId: outcome.reportId, model: outcome.model, inputTokens: outcome.inputTokens, outputTokens: outcome.outputTokens },
      };
    case 'skipped':
      return { status: 'succeeded', result: { reportId: outcome.reportId, skipped: outcome.reason } };
    case 'failed':
      return { status: 'failed', error: `${outcome.failure} (${outcome.detail})`.slice(0, 1000) };
  }
}
