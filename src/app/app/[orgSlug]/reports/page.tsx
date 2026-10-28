import type { ReactNode } from 'react';
import Link from 'next/link';
import {
  Building2, CalendarDays, CalendarRange, ChevronRight, FileDown, FileText, HandCoins, Sparkles,
} from 'lucide-react';
import { can } from '@/core/permissions';
import { addDays } from '@/core/periods';
import {
  KIND_LABELS, SUMMARY_EDITION_LEFT_OUT, SUMMARY_EDITION_TITLE, latestCompletedWindows, listAvailable,
  listStoredReports, readsFullMonthlyReport, summaryEditionNotice, windowLabel,
  type StoredKind, type StoredReportSummary,
} from '@/modules/reporting';
import { fundingEnabled } from '@/modules/funding';
import { getAccessContext, moduleOn } from '@/modules/tenancy';
import { ReportsBeforeFirstMonthEmpty } from '@/components/dashboard';
import { formatDate } from '@/components/labels';
import { Badge, Card, CardBody, IconBadge, PageHeader, type IconTint } from '@/components/ui/surfaces';
import { ABOVE_CARD_LINK, CardLink, TOUCH_TARGET } from '@/components/ui/clickable-card';
import { requirePermission } from '@/app/_lib/authz';
import { ComposeForm } from './_components/report-controls';
import { summaryPdfHref } from './_components/summary-view';
import { REPORT_PURPOSE, originLabel } from './_components/report-guide';

export const dynamic = 'force-dynamic';

/**
 * Reports (ROUTE_ARCHITECTURE.md §118; ADR-024; Phase 17, ADR-141).
 *
 * Every report the agreement lists for Phase 1, each in its own section. The daily and weekly
 * reports are produced on a schedule and kept; a day or week still in progress has a live preview
 * instead, because a stored report says the period was reported on. The Funding Readiness Report
 * follows the Funding Readiness feature (Phase 16, ADR-145): while it is switched off the section
 * says so rather than hiding it, and the database hides any earlier such report (`reports_select`).
 *
 * The Monthly Management Report comes first, with a short "which report?" guide above everything:
 * it is the one an owner should read, and six equal-weight cards did not say so (client-friendliness
 * pass, 2026-10-28).
 */

/** The row's main link, as the reference's outlined "Open ›" button (ADR-155). */
const OPEN_PILL = `inline-flex shrink-0 items-center gap-1 rounded-xl border border-accent/45 bg-surface px-3 py-1 text-sm font-medium text-accent transition-colors group-hover:border-accent group-hover:bg-accent-soft ${TOUCH_TARGET}`;

/** A secondary link in a section, as a soft pill; a full 40px tap target on a touch screen. */
const SOFT_PILL = `inline-flex w-fit items-center gap-1 rounded-full bg-accent-soft px-3 py-1 text-sm font-medium text-accent transition-colors hover:bg-accent/20 ${TOUCH_TARGET}`;

/**
 * A report row opens from anywhere on it (owner, 2026-10-14), as a clickable card does
 * (`ui/clickable-card`): its one link is stretched over the row, which highlights on hover and on
 * keyboard focus.
 */
const ROW = 'group relative -mx-2 rounded-xl px-2 transition-colors hover:bg-accent-soft/40 focus-within:ring-2 focus-within:ring-accent/50';

const DAYS_OFFERED = 14;
const WEEKS_OFFERED = 8;

function StoredList({ orgSlug, reports, empty }: { orgSlug: string; reports: readonly StoredReportSummary[]; empty: string }) {
  if (reports.length === 0) return <p className="text-sm text-ink-muted">{empty}</p>;
  return (
    <ul className="flex flex-col divide-y divide-line">
      {reports.map((report) => (
        <li key={report.id} className={`${ROW} flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm`}>
          <CardLink href={`/app/${orgSlug}/reports/r/${report.id}`} className="min-w-0 font-medium text-ink underline-offset-2 after:rounded-xl group-hover:text-accent group-hover:underline">
            {windowLabel(report.windowStart, report.windowEnd)}
          </CardLink>
          <span className="flex flex-wrap items-center gap-2 text-ink-muted">
            {originLabel(report.origin)}
            {report.versions > 1 ? <Badge>{report.versions} versions</Badge> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Section({
  id, title, description, icon, tint, children,
}: { id: string; title: string; description: string; icon: ReactNode; tint: IconTint; children: ReactNode }) {
  return (
    // `scroll-mt` keeps a section's heading clear of the top bar when the guide jumps to it.
    <Card id={id} className="scroll-mt-20">
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
  /*
   * ADR-172: the Daily Executive Brief, the Weekly Intelligence Report and the Accountant/CFO Report
   * are internal — the database lets only `financials.view` read them (`reports_select`). A reader
   * without it (a 3rd party) is not shown their sections: an empty list there would say "no brief
   * yet" about briefs that exist. What they can open — the Monthly Management Report and Funding
   * Readiness — is listed as for everyone.
   */
  const seesInternal = can(ctx, 'financials.view');
  /*
   * ADR-172 addendum: the full Monthly Management Report (alerts, open actions) is `financials.view`
   * too. A reader without it is offered the SUMMARY EDITION — its own title, its own PDF — and no
   * link to the full report or its stored file, which the database hides from them anyway.
   */
  const readsFullMonthly = readsFullMonthlyReport(ctx);
  const [monthly, stored, windows, funding] = await Promise.all([
    listAvailable(ctx),
    listStoredReports(ctx, seesInternal
      ? ['daily_brief', 'weekly_intelligence', 'adviser', 'custom_ai', 'funding_readiness']
      : ['custom_ai', 'funding_readiness']),
    latestCompletedWindows(ctx),
    fundingEnabled(ctx),
  ]);
  // A custom report is its author's own; the section is for whoever may write one, or has.
  const showsCustom = canAsk || stored.some((r) => r.kind === 'custom_ai');
  const of = (kind: StoredKind, limit: number) => stored.filter((r) => r.kind === kind).slice(0, limit);

  const days = Array.from({ length: DAYS_OFFERED }, (_, i) => addDays(windows.yesterday, -i))
    .map((day) => ({ value: day, label: windowLabel(day, day) }));
  const weeks = Array.from({ length: WEEKS_OFFERED }, (_, i) => addDays(windows.lastWeekStart, -7 * i))
    .map((start) => ({ value: start, label: windowLabel(start, addDays(start, 6)) }));

  // The guide lists only the reports this reader is shown below, in the same order.
  const guide: { id: string; name: string; when: string }[] = [
    readsFullMonthly
      ? { id: 'monthly', name: 'Monthly Management Report', when: 'the main report: how last month went. Start here.' }
      : { id: 'monthly', name: SUMMARY_EDITION_TITLE, when: 'the headline figures for each finished month.' },
    ...(seesInternal ? [
      { id: 'daily', name: KIND_LABELS.daily_brief, when: 'a quick look at one day.' },
      { id: 'weekly', name: KIND_LABELS.weekly_intelligence, when: 'last week compared with the week before.' },
      { id: 'adviser', name: KIND_LABELS.adviser, when: 'to send to your accountant or adviser.' },
    ] : []),
    ...(showsCustom ? [{ id: 'custom', name: KIND_LABELS.custom_ai, when: 'your own questions, answered by the AI Analyst.' }] : []),
    { id: 'funding', name: KIND_LABELS.funding_readiness, when: 'before you talk to a lender.' },
  ];

  return (
    <>
      <PageHeader
        eyebrow="Reports"
        title="Reports"
        description="Reports on your business, made from the figures APX has already worked out. Not sure where to start? Read the latest Monthly Management Report."
      />

      {/* A readable width on a very wide screen: a row's details stay near its title. */}
      <div className="flex max-w-5xl flex-col gap-6">
        <Card>
          <CardBody>
            <h2 className="font-serif text-lg text-ink">Which report do I need?</h2>
            <ul className="mt-3 flex flex-col gap-2 text-sm">
              {guide.map((item) => (
                <li key={item.id} className="text-ink-muted">
                  <a href={`#${item.id}`} className="font-medium text-accent underline underline-offset-2 pointer-coarse:inline-flex pointer-coarse:min-h-10 pointer-coarse:items-center">
                    {item.name}
                  </a>
                  {' '}— {item.when}
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>

        {readsFullMonthly ? (
        <Section id="monthly" title="Monthly Management Report" icon={<FileText />} tint="violet" description={REPORT_PURPOSE.monthly}>
          {monthly.length === 0 ? (
            <ReportsBeforeFirstMonthEmpty addDataHref={can(ctx, 'imports.create') ? `/app/${orgSlug}/data/imports/new` : undefined} />
          ) : (
            <ul className="flex flex-col divide-y divide-line">
              {monthly.map((report, index) => (
                <li key={report.periodId} className={`${ROW} flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm`}>
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 font-medium text-ink">
                      {report.periodLabel}
                      {/* The list is newest first: the top row is the one to read. */}
                      {index === 0 ? <Badge tone="accent">Latest</Badge> : null}
                    </p>
                    <p className="mt-1 text-ink-muted">
                      {report.file === null
                        ? 'Read it on screen, or make a PDF to print or send.'
                        : `Read it on screen. A PDF was made on ${formatDate(report.file.createdAt)}.`}
                    </p>
                  </div>
                  {/* The link text is the monthly report's since ADR-024; journeys and screen readers rely on it. */}
                  <CardLink href={`/app/${orgSlug}/reports/monthly/${report.periodId}`} className={`${OPEN_PILL} after:rounded-xl`}>
                    Open the report
                    <span className="sr-only"> for {report.periodLabel}</span>
                    <ChevronRight aria-hidden="true" className="size-4" />
                  </CardLink>
                </li>
              ))}
            </ul>
          )}
        </Section>
        ) : (
        <Section
          id="monthly"
          title={SUMMARY_EDITION_TITLE}
          icon={<FileText />}
          tint="violet"
          description={`${summaryEditionNotice()}. ${SUMMARY_EDITION_LEFT_OUT}`}
        >
          {monthly.length === 0 ? (
            <p className="text-sm text-ink-muted">No month has finished with figures yet.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-line">
              {monthly.map((report) => (
                <li key={report.periodId} className={`${ROW} flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm`}>
                  <div className="min-w-0">
                    <p className="font-medium text-ink">{report.periodLabel}</p>
                    <p className="mt-1 text-ink-muted">The headline figures and the Business Health Score for the month.</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {/* Rendered now, never stored: a plain download, above the row's link layer. */}
                    <a href={summaryPdfHref(orgSlug, report.periodId)} download className={`${SOFT_PILL} ${ABOVE_CARD_LINK}`}>
                      <FileDown aria-hidden="true" className="size-4" />
                      Download the PDF
                      <span className="sr-only"> of the summary edition for {report.periodLabel}</span>
                    </a>
                    <CardLink href={`/app/${orgSlug}/reports/monthly/${report.periodId}`} className={`${OPEN_PILL} after:rounded-xl`}>
                      Open the summary
                      <span className="sr-only"> for {report.periodLabel}</span>
                      <ChevronRight aria-hidden="true" className="size-4" />
                    </CardLink>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Section>
        )}

        {seesInternal ? (<>
        <Section
          id="daily"
          title={KIND_LABELS.daily_brief}
          icon={<CalendarDays />}
          tint="violet"
          description={REPORT_PURPOSE.daily_brief}
        >
          <Link href={`/app/${orgSlug}/reports/preview/daily_brief`} className={SOFT_PILL}>
            Today so far
          </Link>
          <StoredList orgSlug={orgSlug} reports={of('daily_brief', DAYS_OFFERED)}
            empty="No brief yet. Each day's brief is made shortly after midnight once APX has figures." />
          {canGenerate ? (
            <div className="flex flex-col gap-1">
              <p className="text-xs text-ink-faint">Missing a day, or added data since? Choose the day and make its brief again.</p>
              <ComposeForm orgSlug={orgSlug} kind="daily_brief" label="Produce a brief" windows={days} />
            </div>
          ) : null}
        </Section>

        <Section
          id="weekly"
          title={KIND_LABELS.weekly_intelligence}
          icon={<CalendarRange />}
          tint="pink"
          description={REPORT_PURPOSE.weekly_intelligence}
        >
          <Link href={`/app/${orgSlug}/reports/preview/weekly_intelligence`} className={SOFT_PILL}>
            This week so far
          </Link>
          <StoredList orgSlug={orgSlug} reports={of('weekly_intelligence', WEEKS_OFFERED)}
            empty="No weekly report yet. Each week's report is made early on Monday." />
          {canGenerate ? (
            <div className="flex flex-col gap-1">
              <p className="text-xs text-ink-faint">Missing a week, or added data since? Choose the week and make its report again.</p>
              <ComposeForm orgSlug={orgSlug} kind="weekly_intelligence" label="Produce a weekly report" windows={weeks} />
            </div>
          ) : null}
        </Section>

        <Section
          id="adviser"
          title={KIND_LABELS.adviser}
          icon={<Building2 />}
          tint="pink"
          description={REPORT_PURPOSE.adviser}
        >
          <StoredList orgSlug={orgSlug} reports={of('adviser', 6)} empty="No Accountant/CFO Report yet." />
          {canGenerate ? <ComposeForm orgSlug={orgSlug} kind="adviser" label="Produce one now" /> : null}
        </Section>
        </>) : null}

        {showsCustom ? (
        <Section
          id="custom"
          title={KIND_LABELS.custom_ai}
          icon={<Sparkles />}
          tint="violet"
          description={REPORT_PURPOSE.custom_ai}
        >
          <StoredList orgSlug={orgSlug} reports={of('custom_ai', 10)} empty="You have no custom reports yet." />
          {canAsk ? (
            <div className="flex flex-col gap-1">
              <Link href={`/app/${orgSlug}/reports/custom/new`} className={SOFT_PILL}>
                Create a custom report
              </Link>
              <p className="text-xs text-ink-faint">Each question you add uses one of today&apos;s AI Analyst questions.</p>
            </div>
          ) : null}
        </Section>
        ) : null}

        <Section
          id="funding"
          title={KIND_LABELS.funding_readiness}
          icon={<HandCoins />}
          tint="pink"
          description={REPORT_PURPOSE.funding_readiness}
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
