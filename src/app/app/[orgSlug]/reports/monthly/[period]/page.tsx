import Link from 'next/link';
import { notFound } from 'next/navigation';
import { can } from '@/core/permissions';
import {
  REPORT_PRIORITY_LABELS, REPORT_SEVERITY_LABELS, getMonthlyReport, getMonthlySummary, listAvailable, readsFullMonthlyReport,
} from '@/modules/reporting';
import { formatDate } from '@/components/labels';
import { getAccessContext } from '@/modules/tenancy';
import { HealthScoreInline, StatusBadgeView } from '@/components/dashboard';
import { ChartColumn, ClipboardCheck, FileDown, FileText, TriangleAlert } from 'lucide-react';
import { Badge, Card, CardBody, IconBadge, PageHeader } from '@/components/ui/surfaces';
import { PdfControl } from './pdf-control';
import { requirePermission } from '@/app/_lib/authz';
import { SummaryEditionScreen, provenanceLine, summaryPdfHref } from '../../_components/summary-view';
import { REPORT_PURPOSE } from '../../_components/report-guide';

export const dynamic = 'force-dynamic';

/**
 * The Monthly Management Report on screen (ROUTE_ARCHITECTURE.md §119; ADR-024).
 *
 * Every figure here is the same `metric_current` snapshot Home shows, built through the same
 * `buildHeadlineCards`. `ARCHITECTURE.md` names metric drift — the same metric computed differently
 * in two places — as a top risk, and a report is where it would hurt most: this is the page somebody
 * prints and takes to a meeting, and it must not disagree with the screen it came from.
 *
 * Two editions (ADR-172 addendum). A reader with `financials.view` reads the FULL report — alerts and
 * open actions included — and may produce and open its stored PDF. A reader without it (a 3rd party
 * by default) reads the SUMMARY EDITION at the same address: built from the overview alone, never
 * from the full report, and offering only its own PDF. The service refuses the full report to them
 * as well (`getMonthlyReport`), and the database hides its stored file (`report_files_select`).
 */
export default async function MonthlyReportPage({
  params,
}: {
  params: Promise<{ orgSlug: string; period: string }>;
}) {
  const { orgSlug, period } = await params;
  const ctx = await getAccessContext(orgSlug);
  requirePermission(ctx, 'reports.view');

  if (!readsFullMonthlyReport(ctx)) {
    // The summary edition; NOT FOUND exactly where the full report would be (§119).
    const summary = await getMonthlySummary(ctx, period);
    if (summary === null) notFound();
    return <SummaryEditionScreen orgSlug={orgSlug} summary={summary} />;
  }

  // A month with no figures, or one that has not finished, has no report — NOT FOUND rather than an
  // empty page that looks like a fault (§119).
  const report = await getMonthlyReport(ctx, period);
  if (report === null) notFound();

  const available = await listAvailable(ctx);
  const file = available.find((entry) => entry.periodId === period)?.file ?? null;

  return (
    <>
      <p className="mb-2 text-sm print:hidden">
        <Link href={`/app/${orgSlug}/reports`} className="inline-flex items-center text-accent underline underline-offset-2 pointer-coarse:min-h-10">
          Back to reports
        </Link>
      </p>

      <PageHeader
        eyebrow={report.organisationName}
        title={`Monthly Management Report — ${report.period.label}`}
        description={REPORT_PURPOSE.monthly}
      />

      <p className="mt-2 text-sm text-ink-muted">{report.basisLine}</p>

      {can(ctx, 'reports.generate') ? (
        <div className="mt-4 print:hidden">
          <PdfControl
            orgSlug={orgSlug}
            periodId={period}
            reportFileId={file?.id ?? null}
            renderedAt={file?.createdAt ?? null}
          />
        </div>
      ) : null}

      {/* The edition a lender, investor or partner reads — for a full reader to send on (ADR-172 addendum). */}
      <p className="mt-3 text-sm print:hidden">
        <a href={summaryPdfHref(orgSlug, period)} download className="inline-flex items-center gap-1 text-accent underline underline-offset-2 pointer-coarse:min-h-10">
          <FileDown aria-hidden="true" className="size-4" />
          Download a short version to share with a lender, investor or partner (headline figures and Business Health Score only)
        </a>
      </p>

      {/* A readable measure on a very wide screen. */}
      <div className="mt-8 flex max-w-5xl flex-col gap-6">
        <Card>
          <CardBody>
            <div className="flex min-w-0 items-center gap-3">
              <IconBadge tint="violet" size="sm"><FileText /></IconBadge>
              <h2 className="min-w-0 font-serif text-lg text-ink">{report.summary}</h2>
            </div>
            {report.health === null || report.health.score === null ? null : (
              <div className="mt-3">
                <HealthScoreInline
                  score={report.health.score}
                  band={report.health.band}
                  dimensionsUsed={report.health.dimensionsUsed}
                  dimensionsTotal={report.health.dimensionsTotal}
                />
              </div>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardBody>
            <div className="flex min-w-0 items-center gap-3">
              <IconBadge tint="pink" size="sm"><ChartColumn /></IconBadge>
              <h2 className="min-w-0 font-serif text-lg text-ink">The headline numbers</h2>
            </div>
            <dl className="mt-4 grid gap-4 sm:grid-cols-2">
              {report.cards.map((card) => (
                <div key={card.metricKey} className="border-b border-line pb-3">
                  <dt className="flex flex-wrap items-center gap-2 text-sm text-ink-muted">
                    {card.label}
                    {/* The card already carries its one badge (§4, §8.1); it is not re-derived. */}
                    <StatusBadgeView status={card.status} size="sm" />
                  </dt>
                  <dd className="mt-1 font-serif text-2xl text-ink">{card.value}</dd>
                  {card.change === null ? null : (
                    <dd className="mt-1 text-sm text-ink-muted">{card.change.text}</dd>
                  )}
                </div>
              ))}
            </dl>
          </CardBody>
        </Card>

        {report.alerts.length === 0 ? null : (
          <Card>
            <CardBody>
              <div className="flex min-w-0 items-center gap-3">
              <IconBadge tint="violet" size="sm"><TriangleAlert /></IconBadge>
              <h2 className="min-w-0 font-serif text-lg text-ink">What needs attention</h2>
            </div>
              <ul className="mt-4 flex flex-col gap-4">
                {report.alerts.map((alert) => (
                  <li key={alert.id} className="border-b border-line pb-3 last:border-0">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <Badge tone={alert.severity === 'critical' ? 'danger' : 'warn'}>
                        {REPORT_SEVERITY_LABELS[alert.severity as keyof typeof REPORT_SEVERITY_LABELS] ?? alert.severity}
                      </Badge>
                      <span className="text-ink">{alert.title}</span>
                    </div>
                    <p className="mt-1 text-sm text-ink-muted">{alert.explanation}</p>
                    {alert.recommendedNextStep === null ? null : (
                      <p className="mt-1 text-sm text-ink">Next step: {alert.recommendedNextStep}</p>
                    )}
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>
        )}

        {report.openActions.length === 0 ? null : (
          <Card>
            <CardBody>
              <div className="flex min-w-0 items-center gap-3">
              <IconBadge tint="pink" size="sm"><ClipboardCheck /></IconBadge>
              <h2 className="min-w-0 font-serif text-lg text-ink">What we are doing about it</h2>
            </div>
              <ul className="mt-4 flex flex-col gap-2">
                {report.openActions.map((action) => (
                  <li key={action.id} className="flex flex-wrap justify-between gap-2 text-sm">
                    <span className="text-ink">{action.title}</span>
                    <span className="text-ink-muted">
                      {REPORT_PRIORITY_LABELS[action.priority as keyof typeof REPORT_PRIORITY_LABELS] ?? action.priority}
                      {' · '}{action.dueDate === null ? 'no due date' : `due ${formatDate(action.dueDate)}`}
                    </span>
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>
        )}

        {/*
          The provenance line. A printed page outlives the screen it came from, so it says which run
          produced these figures — otherwise a report found in a drawer in six months cannot be tied
          back to anything (EVIDENCE_MODEL.md §1).
        */}
        <p className="text-xs text-ink-faint">{provenanceLine(report.asOf)}</p>
      </div>
    </>
  );
}
