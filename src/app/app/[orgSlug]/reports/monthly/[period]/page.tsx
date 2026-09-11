import Link from 'next/link';
import { notFound } from 'next/navigation';
import { can } from '@/core/permissions';
import { getMonthlyReport, listAvailable } from '@/modules/reporting';
import { getAccessContext } from '@/modules/tenancy';
import { HealthScoreInline, StatusBadgeView } from '@/components/dashboard';
import { Badge, Card, CardBody, PageHeader } from '@/components/ui/surfaces';
import { PdfControl } from './pdf-control';
import { requirePermission } from '@/app/_lib/authz';

export const dynamic = 'force-dynamic';

/**
 * The Monthly Management Report on screen (ROUTE_ARCHITECTURE.md §119; ADR-024).
 *
 * Every figure here is the same `metric_current` snapshot Home shows, built through the same
 * `buildHeadlineCards`. `ARCHITECTURE.md` names metric drift — the same metric computed differently
 * in two places — as a top risk, and a report is where it would hurt most: this is the page somebody
 * prints and takes to a meeting, and it must not disagree with the screen it came from.
 */
export default async function MonthlyReportPage({
  params,
}: {
  params: Promise<{ orgSlug: string; period: string }>;
}) {
  const { orgSlug, period } = await params;
  const ctx = await getAccessContext(orgSlug);
  requirePermission(ctx, 'reports.view');

  // A month with no figures, or one that has not finished, has no report — NOT FOUND rather than an
  // empty page that looks like a fault (§119).
  const report = await getMonthlyReport(ctx, period);
  if (report === null) notFound();

  const available = await listAvailable(ctx);
  const file = available.find((entry) => entry.periodId === period)?.file ?? null;

  return (
    <>
      <p className="mb-2 text-sm print:hidden">
        <Link href={`/app/${orgSlug}/reports`} className="text-accent underline underline-offset-2">
          Back to reports
        </Link>
      </p>

      <PageHeader
        eyebrow={report.organisationName}
        title={`Monthly Management Report — ${report.period.label}`}
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

      <div className="mt-8 flex flex-col gap-6">
        <Card>
          <CardBody>
            <h2 className="font-serif text-lg text-ink">{report.summary}</h2>
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
            <h2 className="font-serif text-lg text-ink">The headline numbers</h2>
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
              <h2 className="font-serif text-lg text-ink">What needs attention</h2>
              <ul className="mt-4 flex flex-col gap-4">
                {report.alerts.map((alert) => (
                  <li key={alert.id} className="border-b border-line pb-3 last:border-0">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <Badge tone={alert.severity === 'critical' ? 'danger' : 'warn'}>
                        {alert.severity}
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
              <h2 className="font-serif text-lg text-ink">What we are doing about it</h2>
              <ul className="mt-4 flex flex-col gap-2">
                {report.openActions.map((action) => (
                  <li key={action.id} className="flex flex-wrap justify-between gap-2 text-sm">
                    <span className="text-ink">{action.title}</span>
                    <span className="text-ink-muted">
                      {action.priority} · {action.dueDate ?? 'no date set'}
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
        <p className="text-xs text-ink-faint">
          {report.asOf.finishedAt === null
            ? 'Figures as last calculated by MOTION.'
            : `Figures as calculated on ${report.asOf.finishedAt.slice(0, 10)}`
              + `${report.asOf.engineVersion === null ? '' : ` by engine ${report.asOf.engineVersion}`}.`}
        </p>
      </div>
    </>
  );
}
