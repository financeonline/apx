import Link from 'next/link';
import { ChartColumn, FileDown, FileText, HeartPulse } from 'lucide-react';
import type { SummaryEditionView } from '@/modules/reporting';
import { HealthScoreInline } from '@/components/dashboard';
import { buttonClass } from '@/components/ui/button';
import { formatDate } from '@/components/labels';
import { Card, CardBody, IconBadge, PageHeader } from '@/components/ui/surfaces';

/** Where the summary edition's PDF is downloaded: rendered now, never stored (ADR-172 addendum). */
export function summaryPdfHref(orgSlug: string, periodId: string): string {
  return `/api/reports/summary/${periodId}?org=${encodeURIComponent(orgSlug)}`;
}

/**
 * The provenance line under a monthly report, full or summary edition. It still names the run's
 * date and calculation version — a printed page must tie back to the figures it came from
 * (EVIDENCE_MODEL.md §1) — but in words an owner reads: "24 Oct 2026", not an ISO date, and
 * "calculation version", not "engine".
 */
export function provenanceLine(asOf: { readonly finishedAt: string | null; readonly engineVersion: string | null }): string {
  if (asOf.finishedAt === null) return 'Figures as last worked out by APX.';
  return `Figures as worked out by APX on ${formatDate(asOf.finishedAt)}`
    + `${asOf.engineVersion === null ? '' : ` (calculation version ${asOf.engineVersion})`}.`;
}

/**
 * The Monthly Management Report's summary edition on screen (ADR-172 addendum).
 *
 * What a reader without `financials.view` — a 3rd party by default — sees at
 * `/reports/monthly/[period]`: the edition's own title and cover line, the headline figures, the
 * Business Health Score area by area, and its PDF. It draws only the composed view, which holds no
 * alert, action, name or per-account line (`modules/reporting/domain/summary.ts`), and it links to
 * nothing of the full report: no "Open the PDF", no evidence ("Why?" is `financials.view`), no
 * Insights.
 */
export function SummaryEditionScreen({ orgSlug, summary }: { orgSlug: string; summary: SummaryEditionView }) {
  const health = summary.health;
  return (
    <>
      <p className="mb-2 text-sm print:hidden">
        <Link href={`/app/${orgSlug}/reports`} className="inline-flex items-center text-accent underline underline-offset-2 pointer-coarse:min-h-10">
          Back to reports
        </Link>
      </p>

      <PageHeader eyebrow={summary.organisationName} title={`${summary.title} — ${summary.period.label}`} />

      <p className="mt-2 text-sm font-medium text-ink">{summary.notice}.</p>
      <p className="mt-1 max-w-3xl text-sm text-ink-muted">{summary.leftOut}</p>
      <p className="mt-2 text-sm text-ink-muted">{summary.basisLine}</p>

      <div className="mt-4 print:hidden">
        <a href={summaryPdfHref(orgSlug, summary.period.id)} download className={buttonClass('secondary')}>
          <FileDown aria-hidden="true" /> Download the PDF
        </a>
      </div>

      <div className="mt-8 flex max-w-5xl flex-col gap-6">
        <Card>
          <CardBody>
            <div className="flex min-w-0 items-center gap-3">
              <IconBadge tint="violet" size="sm"><FileText /></IconBadge>
              <h2 className="min-w-0 font-serif text-lg text-ink">{summary.summary}</h2>
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardBody>
            <div className="flex min-w-0 items-center gap-3">
              <IconBadge tint="pink" size="sm"><ChartColumn /></IconBadge>
              <h2 className="min-w-0 font-serif text-lg text-ink">The headline numbers</h2>
            </div>
            <dl className="mt-4 grid gap-4 sm:grid-cols-2">
              {summary.figures.map((figure) => (
                <div key={figure.metricKey} className="border-b border-line pb-3">
                  <dt className="flex flex-wrap items-center gap-2 text-sm text-ink-muted">
                    {figure.label}
                    {figure.status === null || figure.status === '—' ? null : (
                      <span className="text-xs text-ink-faint">{figure.status}</span>
                    )}
                  </dt>
                  <dd className="mt-1 font-serif text-2xl text-ink">{figure.value}</dd>
                  {figure.secondary === null ? null : (
                    <dd className="mt-1 text-sm text-ink-muted">{figure.secondary.label}: {figure.secondary.value}</dd>
                  )}
                  {figure.change === null ? null : <dd className="mt-1 text-sm text-ink-muted">{figure.change}</dd>}
                </div>
              ))}
            </dl>
          </CardBody>
        </Card>

        <Card>
          <CardBody>
            <div className="flex min-w-0 items-center gap-3">
              <IconBadge tint="violet" size="sm"><HeartPulse /></IconBadge>
              <h2 className="min-w-0 font-serif text-lg text-ink">Business Health Score</h2>
            </div>
            {health === null ? (
              <p className="mt-3 text-sm text-ink-muted">No Business Health Score is available for this month.</p>
            ) : (
              <>
                <div className="mt-3 flex flex-wrap items-baseline gap-3">
                  <HealthScoreInline
                    score={health.score}
                    band={health.bandKey}
                    dimensionsUsed={health.dimensionsUsed}
                    dimensionsTotal={health.dimensionsTotal}
                  />
                  {health.changeText === null ? null : <span className="text-sm text-ink-muted">{health.changeText}</span>}
                </div>
                <ul className="mt-4 flex flex-col divide-y divide-line">
                  {health.areas.map((area) => (
                    <li key={area.key} className="py-2.5 text-sm">
                      <div className="flex flex-wrap justify-between gap-2">
                        <span className="text-ink">{area.label}</span>
                        <span className="tabular text-ink">{area.score === null ? 'not scored' : area.score}</span>
                      </div>
                      {area.note === null ? null : <p className="mt-1 text-xs text-ink-muted">{area.note}</p>}
                      {area.helped.length === 0 && area.heldBack.length === 0 ? null : (
                        <ul className="mt-1 flex flex-col gap-0.5 text-xs text-ink-muted">
                          {area.helped.map((line) => <li key={`+${line}`}>+ {line}</li>)}
                          {area.heldBack.map((line) => <li key={`-${line}`}>− {line}</li>)}
                        </ul>
                      )}
                    </li>
                  ))}
                </ul>
                <p className="mt-3 text-xs text-ink-faint">{health.disclaimer}</p>
              </>
            )}
          </CardBody>
        </Card>

        <p className="text-xs text-ink-faint">{provenanceLine(summary.asOf)}</p>
      </div>
    </>
  );
}
