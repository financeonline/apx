import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { recordReportFile, recordReportPdf } from '@/core/db';
import { log } from '@/core/logging';
import { putObject, REPORTS_BUCKET, reportKey, storedReportKey } from '@/core/storage/signer';
import { listOpenActionsForJob } from '@/modules/actions';
import {
  ADVISER_CONTENT_VERSION, BRIEF_CONTENT_VERSION, CUSTOM_CONTENT_VERSION, buildMonthlyReport,
  loadStoredReportForJob, renderAdviserPdf, renderBriefPdf, renderCustomPdf, renderReportPdf,
  type AdviserContent, type BriefContent, type CustomReportContent,
} from '@/modules/reporting';
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

  // Phase 17: the PDF of a stored report — the daily and weekly briefs, the adviser and custom
  // reports. It renders the content as STORED, so it says what the report said.
  if (typeof job.payload.reportId === 'string') {
    return renderStoredReport(job, scoped, orgId, job.payload.reportId);
  }

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

/** Renders the stored content with the renderer for its kind and version. */
async function renderStored(kind: string, version: string, content: unknown): Promise<Uint8Array | null> {
  if ((kind === 'daily_brief' || kind === 'weekly_intelligence') && version === BRIEF_CONTENT_VERSION) {
    return renderBriefPdf(content as BriefContent);
  }
  if (kind === 'adviser' && version === ADVISER_CONTENT_VERSION) return renderAdviserPdf(content as AdviserContent);
  if (kind === 'custom_ai' && version === CUSTOM_CONTENT_VERSION) return renderCustomPdf(content as CustomReportContent);
  return null;
}

async function renderStoredReport(
  job: ClaimedJob, scoped: SupabaseClient, orgId: string, reportId: string,
): Promise<JobOutcome> {
  const stored = await loadStoredReportForJob(scoped, orgId, reportId);
  if (stored === null) return { status: 'failed', error: 'that report does not exist' };

  const bytes = await renderStored(stored.kind, stored.contentVersion, stored.content);
  if (bytes === null) {
    // A content version this code cannot read is refused, not guessed at.
    return { status: 'failed', error: `no renderer for ${stored.kind} ${stored.contentVersion}` };
  }

  const fileId = randomUUID();
  await putObject(
    { orgId, userId: job.requestedBy ?? orgId },
    REPORTS_BUCKET,
    storedReportKey(orgId, reportId, fileId),
    bytes,
    'application/pdf',
  );
  const reportFileId = await recordReportPdf(
    job.requestedBy === null ? null : { userId: job.requestedBy, requestId: job.jobId },
    {
      organizationId: orgId,
      reportId,
      jobId: job.jobId,
      fileId,
      sha256: createHash('sha256').update(bytes).digest(),
      byteSize: bytes.byteLength,
    },
  );
  log.info('report rendered', { organizationId: orgId, reportId, reportFileId, bytes: bytes.byteLength });
  return { status: 'succeeded', result: { reportFileId, byteSize: bytes.byteLength } };
}
