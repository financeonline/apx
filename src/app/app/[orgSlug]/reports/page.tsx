import type { ReactNode } from 'react';
import Link from 'next/link';
import {
  Building2, CalendarDays, CalendarRange, ChevronRight, FileText, HandCoins, Sparkles,
} from 'lucide-react';
import { can } from '@/core/permissions';
import { addDays } from '@/core/periods';
import {
  KIND_LABELS, latestCompletedWindows, listAvailable, listStoredReports, windowLabel,
  type StoredKind, type StoredReportSummary,
} from '@/modules/reporting';
import { fundingEnabled } from '@/modules/funding';
import { getAccessContext, moduleOn } from '@/modules/tenancy';
import { ReportsBeforeFirstMonthEmpty } from '@/components/dashboard';
import { Badge, Card, CardBody, IconBadge, PageHeader, type IconTint } from '@/components/ui/surfaces';
import { requirePermission } from '@/app/_lib/authz';
import { ComposeForm } from './_components/report-controls';

export const dynamic = 'force-dynamic';

/**
 * Reports (ROUTE_ARCHITECTURE.md §118; ADR-024; Phase 17, ADR-141).
 *
 * Every report the agreement lists for Phase 1, each in its own section. The daily and weekly
 * reports are produced on a schedule and kept; a day or week still in progress has a live preview
 * instead, because a stored report says the period was reported on. The Funding Readiness Report
 * follows the Funding Readiness feature (Phase 16, ADR-145): while it is switched off the section
 * says so rather than hiding it, and the database hides any earlier such report (`reports_select`).
 */

/** The row's main link, as the reference's outlined "Open ›" button (ADR-155). */
const OPEN_PILL = 'inline-flex items-center gap-1 rounded-xl border border-accent/45 bg-surface px-3 py-1 text-sm font-medium text-accent transition-colors hover:border-accent hover:bg-accent-soft';

/** A secondary link in a section, as a soft pill. */
const SOFT_PILL = 'inline-flex w-fit items-center gap-1 rounded-full bg-accent-soft px-3 py-1 text-sm font-medium text-accent transition-colors hover:bg-accent/20';

const DAYS_OFFERED = 14;
const WEEKS_OFFERED = 8;

function StoredList({ orgSlug, reports, empty }: { orgSlug: string; reports: readonly StoredReportSummary[]; empty: string }) {
  if (reports.length === 0) return <p className="text-sm text-ink-muted">{empty}</p>;
  return (
    <ul className="flex flex-col divide-y divide-line">
      {reports.map((report) => (
        <li key={report.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
          <Link href={`/app/${orgSlug}/reports/r/${report.id}`} className="min-w-0 font-medium text-ink underline-offset-2 hover:text-accent hover:underline">
            {windowLabel(report.windowStart, report.windowEnd)}
          </Link>
          <span className="flex flex-wrap items-center gap-2 text-ink-muted">
            {report.origin === 'scheduled' ? 'Produced on schedule' : 'Produced on request'}
            {report.versions > 1 ? <Badge>{report.versions} versions</Badge> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Section({
  title, description, icon, tint, children,
}: { title: string; description: string; icon: ReactNode; tint: IconTint; children: ReactNode }) {
  return (
    <Card>
      <CardBody>
        {/* header/hgroup, not divs: the section stays the innermost div holding its heading. */}
        <header className="flex min-w-0 items-start gap-3.5">
          <IconBadge tint={tint}>{icon}</IconBadge>
          <hgroup className="min-w-0">
            <h2 className="font-serif text-lg text-ink">{title}</h2>
            <p className="mt-1 text-sm text-ink-muted">{description}</p>
          </hgroup>
        </header>
        <div className="mt-4 flex min-w-0 flex-col gap-4">{children}</div>
      </CardBody>
    </Card>
  );
}

export default async function ReportsPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params;
  const ctx = await getAccessContext(orgSlug);
  requirePermission(ctx, 'reports.view');

  const canGenerate = can(ctx, 'reports.generate');
  // ADR-158: a new custom report needs the AI Analyst system; reports already made stay listed.
  const canAsk = can(ctx, 'ai.use') && moduleOn(ctx, 'analyst');
  const [monthly, stored, windows, funding] = await Promise.all([
    listAvailable(ctx),
    listStoredReports(ctx, ['daily_brief', 'weekly_intelligence', 'adviser', 'custom_ai', 'funding_readiness']),
    latestCompletedWindows(ctx),
    fundingEnabled(ctx),
  ]);
  const of = (kind: StoredKind, limit: number) => stored.filter((r) => r.kind === kind).slice(0, limit);

  const days = Array.from({ length: DAYS_OFFERED }, (_, i) => addDays(windows.yesterday, -i))
    .map((day) => ({ value: day, label: windowLabel(day, day) }));
  const weeks = Array.from({ length: WEEKS_OFFERED }, (_, i) => addDays(windows.lastWeekStart, -7 * i))
    .map((start) => ({ value: start, label: windowLabel(start, addDays(start, 6)) }));

  return (
    <>
      <PageHeader
        eyebrow="Reports"
        title="Reports"
        description="Briefs and reports from the figures MOTION has already calculated. Nothing here is recalculated for the page."
      />

      <div className="flex flex-col gap-6">
        <Section
          title={KIND_LABELS.daily_brief}
          icon={<CalendarDays />}
          tint="violet"
          description="Key movements, risks, opportunities and actions for one day — with what needs attention today."
        >
          <Link href={`/app/${orgSlug}/reports/preview/daily_brief`} className={SOFT_PILL}>
            Today so far
          </Link>
          <StoredList orgSlug={orgSlug} reports={of('daily_brief', DAYS_OFFERED)}
            empty="No brief yet. Each day's brief is produced shortly after midnight once MOTION has figures." />
          {canGenerate ? <ComposeForm orgSlug={orgSlug} kind="daily_brief" label="Produce a brief" windows={days} /> : null}
        </Section>

        <Section
          title={KIND_LABELS.weekly_intelligence}
          icon={<CalendarRange />}
          tint="pink"
          description="Financial changes, their causes and unresolved issues for a Monday-to-Sunday week, compared with the week before."
        >
          <Link href={`/app/${orgSlug}/reports/preview/weekly_intelligence`} className={SOFT_PILL}>
            This week so far
          </Link>
          <StoredList orgSlug={orgSlug} reports={of('weekly_intelligence', WEEKS_OFFERED)}
            empty="No weekly report yet. Each week's report is produced early on Monday." />
          {canGenerate ? <ComposeForm orgSlug={orgSlug} kind="weekly_intelligence" label="Produce a weekly report" windows={weeks} /> : null}
        </Section>

        <Section title="Monthly Management Report" icon={<FileText />} tint="violet" description="One report a month, from the figures MOTION has already calculated.">
          {monthly.length === 0 ? (
            <ReportsBeforeFirstMonthEmpty addDataHref={`/app/${orgSlug}/data/imports/new`} />
          ) : (
            <ul className="flex flex-col divide-y divide-line">
              {monthly.map((report) => (
                <li key={report.periodId} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
                  <div className="min-w-0">
                    <p className="font-medium text-ink">{report.periodLabel}</p>
                    <p className="mt-1 text-ink-muted">
                      {report.file === null
                        ? 'Ready to read on screen. A PDF can be produced from the report.'
                        : `PDF produced ${report.file.createdAt.slice(0, 10)}`}
                    </p>
                  </div>
                  {/* The link text is the monthly report's since ADR-024; journeys and screen readers rely on it. */}
                  <Link href={`/app/${orgSlug}/reports/monthly/${report.periodId}`} className={OPEN_PILL}>
                    Open the report
                    <span className="sr-only"> for {report.periodLabel}</span>
                    <ChevronRight aria-hidden="true" className="size-4" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section
          title={KIND_LABELS.adviser}
          icon={<Building2 />}
          tint="pink"
          description="Adviser-ready intelligence on this business: the latest month, health area by area, what stands open, what was done, and how far the data goes."
        >
          <StoredList orgSlug={orgSlug} reports={of('adviser', 6)} empty="No Accountant/CFO Report yet." />
          {canGenerate ? <ComposeForm orgSlug={orgSlug} kind="adviser" label="Produce one now" /> : null}
        </Section>

        <Section
          title={KIND_LABELS.custom_ai}
          icon={<Sparkles />}
          tint="violet"
          description="Choose a month, the areas to look at and up to five questions; the AI Analyst answers each under its usual checks. Your custom reports are visible to you only."
        >
          <StoredList orgSlug={orgSlug} reports={of('custom_ai', 10)} empty="You have no custom reports yet." />
          {canAsk ? (
            <Link href={`/app/${orgSlug}/reports/custom/new`} className={SOFT_PILL}>
              Create a custom report
            </Link>
          ) : null}
        </Section>

        <Section
          title={KIND_LABELS.funding_readiness}
          icon={<HandCoins />}
          tint="pink"
          description="The latest month's indicative Funding Readiness assessment, as it stood when the report was produced. Not a lending decision."
        >
          {funding ? (
            <>
              <StoredList orgSlug={orgSlug} reports={of('funding_readiness', 6)} empty="No Funding Readiness Report yet." />
              {canGenerate ? <ComposeForm orgSlug={orgSlug} kind="funding_readiness" label="Produce one now" /> : null}
            </>
          ) : (
            <p className="text-sm text-ink-muted">
              Funding Readiness is switched off for this organisation, so this report is not available.
            </p>
          )}
        </Section>
      </div>
    </>
  );
}
