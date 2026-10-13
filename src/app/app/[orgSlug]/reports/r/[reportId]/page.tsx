import Link from 'next/link';
import { notFound } from 'next/navigation';
import { can } from '@/core/permissions';
import {
  ADVISER_CONTENT_VERSION, BRIEF_CONTENT_VERSION, CUSTOM_CONTENT_VERSION, FUNDING_REPORT_VERSION, KIND_LABELS,
  getStoredReport, windowLabel,
  type AdviserContent, type BriefContent, type CustomReportContent, type FundingReportContent,
} from '@/modules/reporting';
import { getAccessContext } from '@/modules/tenancy';
import { Banner, PageHeader } from '@/components/ui/surfaces';
import { requirePermission } from '@/app/_lib/authz';
import { BriefView } from '../../_components/brief-view';
import { AdviserView } from '../../_components/adviser-view';
import { CustomView } from '../../_components/custom-view';
import { FundingReportView } from '../../_components/funding-view';
import { StoredPdfControl } from '../../_components/report-controls';

export const dynamic = 'force-dynamic';

/**
 * A stored report (Phase 17). It shows what the report SAID when it was produced — the stored
 * content, never a recomposition — so a brief read next month still says what that day looked like.
 * Another organisation's report, or another person's Custom AI Report, is NOT FOUND.
 */
export default async function StoredReportPage({ params }: { params: Promise<{ orgSlug: string; reportId: string }> }) {
  const { orgSlug, reportId } = await params;
  const ctx = await getAccessContext(orgSlug);
  requirePermission(ctx, 'reports.view');

  const report = await getStoredReport(ctx, reportId);
  if (report === null) notFound();

  const body = (() => {
    if ((report.kind === 'daily_brief' || report.kind === 'weekly_intelligence') && report.contentVersion === BRIEF_CONTENT_VERSION) {
      const content = report.content as BriefContent;
      return { name: content.organisationName, view: <BriefView content={content} orgSlug={orgSlug} /> };
    }
    if (report.kind === 'adviser' && report.contentVersion === ADVISER_CONTENT_VERSION) {
      const content = report.content as AdviserContent;
      return { name: content.organisationName, view: <AdviserView content={content} orgSlug={orgSlug} /> };
    }
    if (report.kind === 'custom_ai' && report.contentVersion === CUSTOM_CONTENT_VERSION) {
      const content = report.content as CustomReportContent;
      return {
        name: content.organisationName,
        view: <CustomView content={content} orgSlug={orgSlug} canCreateAction={can(ctx, 'actions.create')} />,
      };
    }
    if (report.kind === 'funding_readiness' && report.contentVersion === FUNDING_REPORT_VERSION) {
      const content = report.content as FundingReportContent;
      return { name: content.organisationName, view: <FundingReportView content={content} orgSlug={orgSlug} /> };
    }
    return null;
  })();

  const title = `${KIND_LABELS[report.kind]} — ${windowLabel(report.windowStart, report.windowEnd)}`;

  return (
    <>
      <p className="mb-2 text-sm print:hidden">
        <Link href={`/app/${orgSlug}/reports`} className="text-accent underline underline-offset-2">Back to reports</Link>
      </p>
      <PageHeader eyebrow={body?.name ?? 'Report'} title={title} />
      <p className="text-sm text-ink-muted">
        {report.origin === 'scheduled' ? 'Produced on schedule' : 'Produced on request'} on {report.createdAt.slice(0, 10)}.
        {report.versions > 1 ? ` This is the latest of ${report.versions} versions; earlier ones are kept as they were.` : ''}
      </p>
      <div className="mt-4">
        <StoredPdfControl
          orgSlug={orgSlug} reportId={report.id} fileId={report.file?.id ?? null}
          renderedAt={report.file?.createdAt ?? null} canGenerate={can(ctx, 'reports.generate')}
        />
      </div>
      <div className="mt-8">
        {body === null ? (
          <Banner tone="warn" title="This report was produced by a newer or older version of APX">
            It cannot be shown here. Produce it again to read it.
          </Banner>
        ) : body.view}
      </div>
    </>
  );
}
