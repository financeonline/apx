import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { recordReportFile } from '@/core/db';
import { log } from '@/core/logging';
import { putObject, REPORTS_BUCKET, reportKey } from '@/core/storage/signer';
import { listOpenActionsForJob } from '@/modules/actions';
import { buildMonthlyReport, renderReportPdf } from '@/modules/reporting';
import type { ClaimedJob, JobOutcome } from '../domain/types';

/**
 * `report.render` (ADR-024; IMPLEMENTATION_PLAN.md Phase 13 slice 2).
 *
 * Renders the Monthly Management Report a user asked for and stores it. The permission was checked
 * when they asked — `api.enqueue_job` requires `reports.generate` — and this runs that already
 * authorised work with a scoped client.
 *
 * The order is object first, row second (ADR-043.4). A crash between them leaves an orphan object,
 * which `storage.cleanup_orphans` removes; the reverse would leave a `report_files` row the product
 * offers for download and Storage cannot serve.
 */
export async function runReportRenderJob(
  job: ClaimedJob,
  scope: { db: unknown },
): Promise<JobOutcome> {
  const orgId = job.organizationId;
  if (orgId === null) {
    return { status: 'failed', error: 'report.render has no organization to scope to' };
  }
  const scoped = scope.db as SupabaseClient;

  const periodId = typeof job.payload.periodId === 'string' ? job.payload.periodId : null;
  if (periodId === null) {
    return { status: 'failed', error: 'report.render needs a periodId' };
  }

  const report = await buildMonthlyReport({
    db: scoped,
    orgId,
    orgSlug: '',
    periodId,
    now: new Date(),
    openActions: () => listOpenActionsForJob(scoped, orgId),
  });
  if (report === null) {
    /*
     * No report for a month with no figures, or one that has not finished. Failing rather than
     * writing an empty PDF: a document that exists says the month was reported on, and a blank one
     * is worse than none.
     */
    return { status: 'failed', error: 'that month has no complete figures to report on' };
  }

  const bytes = await renderReportPdf(report);
  const fileId = randomUUID();
  const key = reportKey(orgId, periodId, fileId);

  await putObject(
    { orgId, userId: job.requestedBy ?? orgId },
    REPORTS_BUCKET,
    key,
    bytes,
    'application/pdf',
  );

  const reportFileId = await recordReportFile(
    job.requestedBy === null ? null : { userId: job.requestedBy, requestId: job.jobId },
    {
      organizationId: orgId,
      periodId,
      jobId: job.jobId,
      fileId,
      sha256: createHash('sha256').update(bytes).digest(),
      byteSize: bytes.byteLength,
    },
  );

  log.info('report rendered', {
    organizationId: orgId, periodId, reportFileId, bytes: bytes.byteLength,
  });
  return { status: 'succeeded', result: { reportFileId, byteSize: bytes.byteLength } };
}
