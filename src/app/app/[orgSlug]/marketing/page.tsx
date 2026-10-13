import { notFound } from 'next/navigation';
import { FileDown, FileText, LoaderCircle } from 'lucide-react';
import { isMotionError } from '@/core/errors';
import { getMarketingView, presentMarketingReport, type MarketingView } from '@/modules/marketing';
import { getAccessContext } from '@/modules/tenancy';
import { buttonClass } from '@/components/ui/button';
import { Banner, Card, CardBody, EmptyState, IconBadge, PageHeader } from '@/components/ui/surfaces';
import { requireModulePage, requirePermission } from '@/app/_lib/authz';
import { AutoRefresh } from './_components/auto-refresh';
import { ReportView } from './_components/report-view';
import { RequestReportControl } from './_components/request-control';

export const dynamic = 'force-dynamic';

/**
 * Marketing (ADR-170). Opening it shows a ready-made marketing report — nobody types a question. The
 * report is written by ChatGPT in a background job from the company profile and the figures APX
 * holds, in the shape of the client's own example document, and downloads as Word or PDF.
 *
 * The page is a function of the report's state, one panel per state: the profile is not filled in
 * yet (the report is written from it); there is no report (create it); one is being written (the
 * previous report stays visible and the page refreshes itself); the last attempt failed (say why,
 * offer a retry, keep the previous report); and the report itself. `reports.view` reads it; switched
 * off for the company is NOT FOUND for every role (ADR-158).
 */

function ProfileNeeded({ base, view }: { base: string; view: MarketingView }) {
  return (
    <EmptyState
      title="Start with the company profile"
      actionHref={view.canEditProfile ? `${base}/settings/company-profile` : undefined}
      actionLabel={view.canEditProfile ? 'Fill in the company profile' : undefined}
      secondary={view.canEditProfile ? undefined : 'Ask your adviser to fill in the company profile.'}
    >
      The marketing report is written from the company profile: what {view.organisationName} sells, its industry, its
      website and social accounts. Once it says what the company sells or its industry, APX prepares the report — there
      is no question to write.
    </EmptyState>
  );
}

function Preparing({ hasPrevious }: { hasPrevious: boolean }) {
  return (
    <Card>
      <CardBody className="flex min-w-0 items-start gap-4">
        <IconBadge tint="pink"><LoaderCircle className="animate-spin" /></IconBadge>
        <div className="min-w-0" role="status">
          <h2 className="text-lg">Preparing your report — usually under a minute</h2>
          <p className="mt-1 text-sm text-ink-muted">
            {hasPrevious
              ? 'ChatGPT is writing a new report from the company profile and figures. The previous report stays below until it is ready.'
              : 'ChatGPT is writing the report from the company profile and figures.'}
          </p>
          <AutoRefresh />
        </div>
      </CardBody>
    </Card>
  );
}

export default async function MarketingPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params;
  const ctx = await getAccessContext(orgSlug);
  requirePermission(ctx, 'reports.view');
  requireModulePage(ctx, 'marketing');

  let view: MarketingView;
  try {
    view = await getMarketingView(ctx);
  } catch (error) {
    if (isMotionError(error) && error.code === 'NOT_FOUND') notFound();
    throw error;
  }

  const base = `/app/${orgSlug}`;
  const preparing = view.status === 'queued' || view.status === 'running';
  const presentation = view.report === null ? null : presentMarketingReport(view.report);
  const mayRequest = view.canRefresh && view.profileReady && !preparing;
  const download = (format: 'docx' | 'pdf') => `${base}/marketing/download?format=${format}`;

  return (
    <>
      <PageHeader
        eyebrow="Marketing"
        title="Marketing strategy"
        description={`A ready-made marketing and commercial growth report for ${view.organisationName}, from its company profile and figures.`}
      />

      <div className="flex flex-col gap-6">
        {!view.profileReady ? <ProfileNeeded base={base} view={view} /> : null}

        {view.profileReady && view.status === 'none' && presentation === null ? (
          <EmptyState
            title="No marketing report yet"
            secondary={view.canRefresh
              ? <div className="flex justify-center"><RequestReportControl orgSlug={orgSlug} label="Create the marketing report" /></div>
              : 'An owner or adviser can create it.'}
          >
            ChatGPT writes it from the company profile and the figures in APX: comparable competitors and customer sectors,
            a marketing and growth strategy with a first 90 days, and a review of the figures. It usually takes under a minute.
          </EmptyState>
        ) : null}

        {preparing ? <Preparing hasPrevious={presentation !== null} /> : null}

        {view.status === 'failed' ? (
          <Banner tone="danger" title="The report could not be prepared">
            <p>{view.failure ?? 'Something went wrong while the report was being written.'}</p>
            {presentation === null ? null : <p className="mt-1">The previous report is still below.</p>}
            {mayRequest ? <div className="mt-3"><RequestReportControl orgSlug={orgSlug} label="Try again" tone="secondary" /></div> : null}
          </Banner>
        ) : null}

        {presentation === null ? null : (
          <>
            <Card>
              <CardBody className="flex flex-wrap items-center justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-sm text-ink">
                    {preparing || view.status === 'failed' ? 'Previous report, generated ' : 'Generated '}
                    <span className="tabular">{presentation.generatedOn}</span>
                  </p>
                  <p className="text-xs text-ink-muted">{presentation.authorship}</p>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  {mayRequest && view.status !== 'failed' ? <RequestReportControl orgSlug={orgSlug} label="Refresh report" tone="secondary" /> : null}
                  <a href={download('docx')} download className={buttonClass('secondary')}>
                    <FileText aria-hidden="true" /> Download Word
                  </a>
                  <a href={download('pdf')} download className={buttonClass('secondary')}>
                    <FileDown aria-hidden="true" /> Download PDF
                  </a>
                </div>
              </CardBody>
            </Card>
            <ReportView presentation={presentation} />
          </>
        )}
      </div>
    </>
  );
}
