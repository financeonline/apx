import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { recordReport } from '@/core/db';
import { log } from '@/core/logging';
import { composeStoredReport, type ComposableKind } from '@/modules/reporting';
import type { ClaimedJob, JobOutcome } from '../domain/types';

/**
 * `report.compose` (Phase 17, ADR-141): composes a report and stores what it said.
 *
 * Two ways in. The hourly sweep (`api_server.enqueue_scheduled_reports`) queues yesterday's brief
 * and, on a local Monday, last week's report, with no actor; a person with `reports.generate` may
 * ask for a past day or week, or the adviser report, through `api.enqueue_job`, which validated the
 * window and the permission. Either way this runs with the job's scoped client.
 *
 * Whether it was scheduled is read from the JOB ROW (`requested_by`), never from the payload: a
 * payload is data the database merged, and "nobody asked" is a fact about who enqueued it.
 */

const KINDS: readonly ComposableKind[] = ['daily_brief', 'weekly_intelligence', 'adviser', 'funding_readiness'];

export async function runReportComposeJob(
  job: ClaimedJob,
  scope: { db: unknown },
): Promise<JobOutcome> {
  const orgId = job.organizationId;
  if (orgId === null) return { status: 'failed', error: 'report.compose has no organization to scope to' };

  const kind = job.payload.kind;
  if (typeof kind !== 'string' || !(KINDS as readonly string[]).includes(kind)) {
    return { status: 'failed', error: `report.compose cannot compose "${String(kind)}"` };
  }
  const windowStart = typeof job.payload.windowStart === 'string' ? job.payload.windowStart : null;
  if (kind !== 'adviser' && kind !== 'funding_readiness' && windowStart === null) {
    return { status: 'failed', error: 'report.compose needs a windowStart' };
  }

  const composed = await composeStoredReport({
    db: scope.db as SupabaseClient,
    orgId,
    kind: kind as ComposableKind,
    windowStart,
    now: new Date(),
    periodId: typeof job.payload.periodId === 'string' ? job.payload.periodId : null,
  });
  if (composed === null) {
    // The adviser report needs a complete month with figures, and the Funding Readiness Report an
    // assessment while the feature is on; failing rather than storing an empty report, for the reason
    // the monthly render gives: a stored report says it was reported on.
    return { status: 'failed', error: kind === 'funding_readiness'
      ? 'there is no Funding Readiness assessment to report on, or it is switched off'
      : 'there is no complete month with figures to report on' };
  }

  const origin = job.requestedBy === null ? 'scheduled' : 'requested';
  const reportId = await recordReport(
    job.requestedBy === null ? null : { userId: job.requestedBy, requestId: job.jobId },
    {
      organizationId: orgId,
      kind: kind as ComposableKind,
      windowStart: composed.window.start,
      windowEnd: composed.window.end,
      periodId: composed.periodId,
      jobId: job.jobId,
      origin,
      content: composed.content,
      contentVersion: composed.contentVersion,
    },
  );

  log.info('report composed', { organizationId: orgId, reportId, kind, origin });
  return { status: 'succeeded', result: { reportId } };
}
