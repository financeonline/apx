import Link from 'next/link';
import {
  DEPARTMENTS_PERMISSION, getAccessContext, listAccessRequests, mayRequestAccess, moduleOn, type AccessContext,
} from '@/modules/tenancy';
import { can } from '@/core/permissions';
import { callApi } from '@/core/db';
import { systemClock, todayInTimeZone } from '@/core/periods';
import { getActionsSummary } from '@/modules/actions';
import { loadHome, loadOrganizationFacts, loadTopRisks, loadTrend } from '@/modules/dashboard';
import { loadDataCompliance, type DataComplianceView } from '@/modules/departments';
import { listAvailable } from '@/modules/reporting';
import { fundingEnabled } from '@/modules/funding';
import { marketingEnabled } from '@/modules/marketing';
import { investmentEnabled } from '@/modules/investment';
import { Card, CardBody, Banner, IconBadge, type IconTint } from '@/components/ui/surfaces';
import { formatDate } from '@/components/labels';
import type { ReactNode } from 'react';
import {
  Bell, ChartColumn, ChevronRight, ClipboardCheck, FileText, HandCoins, HeartPulse, KeyRound, Landmark, ListChecks,
  Megaphone, MessageCircleQuestion, PiggyBank, ShieldCheck, Sparkles, TrendingUp,
} from 'lucide-react';
import { ButtonLink } from '@/components/ui/button';
import { CLICKABLE_CARD, CardLink } from '@/components/ui/clickable-card';
import { TrendChart } from '@/components/dashboard';
import { dataLinks, sectionLinks } from '@/components/dashboard/nav';
import { chartSeriesFrom } from '@/components/dashboard/presentation';
import {
  ActionQueue, ArrowLink, BandHeading, Chip, DepartmentStrip, Eyebrow, HealthRing, LobbyFigure,
  LobbyFooter, LobbyHero, LobbyPanel, NextMovePanel, RiskPoints, LOBBY_CARD, SERIF_TITLE,
  type LobbyDepartment, type NextMove,
} from '@/components/dashboard/lobby';
import { requirePermission } from '@/app/_lib/authz';

export const dynamic = 'force-dynamic';

/**
 * Home (UX_ARCHITECTURE.md §4) — the client lobby (ADR-176).
 *
 * The owner's second reference: a light page under the unchanged APX bar. The departments the reader
 * may open head it as a row, then the greeting, then the analysis in three numbered bands — the
 * headline figures; the risks, the trend and the score; the actions and the workspace's state.
 *
 * ADR-172 follow-up — one Home for every role, composed by PERMISSION, never a dashboard per role
 * (SOW "Client/Analyst specific dashboards"):
 *   - everyone with `dashboard.view`: the health line, the headline figures, what is moving;
 *   - `financials.view` adds what sits beneath them — "Why?" on every figure, the top risks and the
 *     partial month's cash link (each opens a detail page);
 *   - `actions.view` adds what is being done about it;
 *   - `imports.review` adds "Data & compliance": uploads waiting, last data added, the VAT and
 *     Corporation Tax dates, one's own open actions — the accountant's working view;
 *   - without `financials.view` (a 3rd party), Home is where they land: their reports are listed here
 *     and, for a member who may ask, "Request more information" heads the page.
 * A section the reader cannot open is absent — never an empty "nothing here" that only means "you
 * cannot see it".
 *
 * Read top to bottom in bands. A reader should be able to stop after any band and still have a
 * complete picture at that depth: the health line, then the headline numbers, then what is moving,
 * then the supporting detail.
 *
 * Every figure on this page is a snapshot the engine wrote, read through the `metric_current`
 * pointer and formatted by `core/money`. Nothing here computes a number, and the
 * `no-arithmetic-in-components` lint rule fails the build if that ever changes.
 */

/**
 * §6, exact copy. A first-run page says what to do next, not that something is missing.
 *
 * The upload copy is for someone who can upload. A reader who cannot (a client, a 3rd party) is told
 * plainly that the company has not added its figures yet — "upload a bank statement" is not a next
 * step they can take.
 */
function FirstRun({ orgSlug, canImport }: { orgSlug: string; canImport: boolean }) {
  if (!canImport) {
    return (
      <Card>
        <CardBody className="p-6 sm:p-8">
          <h2 className="font-serif text-2xl text-ink">No figures yet.</h2>
          <p className="mt-3 max-w-prose text-ink-muted">
            This company has not added its figures to APX yet. Its health score and headline numbers will
            appear here once it has.
          </p>
        </CardBody>
      </Card>
    );
  }
  return (
    <Card>
      <CardBody className="p-6 sm:p-8">
        <h2 className="font-serif text-2xl text-ink">Let’s get your first numbers on screen.</h2>
        <p className="mt-3 max-w-prose text-ink-muted">
          APX works from files you already have. Upload a bank statement (CSV or PDF) or an export
          from your accounting software and we’ll show you how the business is doing, what’s changed
          and what needs attention.
        </p>
        <p className="mt-3 max-w-prose text-sm italic text-ink-faint">
          Start with a bank statement to see your cash position. Add a ledger export, trial balance
          or invoice list when you can, and we’ll add profit and customer figures.
        </p>
        {canImport ? (
          <div className="mt-6 flex flex-wrap items-center gap-4">
            <ButtonLink href={`/app/${orgSlug}/data/imports/new`}>Add data</ButtonLink>
            <Link href="/legal/terms" className="text-sm text-accent underline underline-offset-2">
              What files can I upload?
            </Link>
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}

/** §6, exact copy. Bank data only: say what it shows, and name the one upload that adds profit. */
function BankOnlyIntro({ orgSlug, canImport }: { orgSlug: string; canImport: boolean }) {
  if (!canImport) {
    // The instructions are for whoever adds the data; anyone else is told what the figures rest on.
    return (
      <Card>
        <CardBody className="p-6">
          <h2 className="font-serif text-xl text-ink">These figures come from the company’s bank statements.</h2>
          <p className="mt-2 max-w-prose text-ink-muted">
            Money in, money out and the change in cash. Profit and customer figures appear once the company adds
            its accounts or invoice lists.
          </p>
        </CardBody>
      </Card>
    );
  }
  return (
    <Card>
      <CardBody className="p-6">
        <h2 className="font-serif text-xl text-ink">Here’s what your bank statement tells us.</h2>
        <p className="mt-2 max-w-prose text-ink-muted">
          Money in, money out and the change in cash. To see your cash balance, enter the balance at
          the start of the statement. To see profit and customers, add a ledger export or your
          invoice lists.
        </p>
        {canImport ? (
          <div className="mt-4 flex flex-wrap items-center gap-4">
            <ButtonLink href={`/app/${orgSlug}/money/cash`}>Enter opening balance</ButtonLink>
            <Link
              href={`/app/${orgSlug}/data/imports/new`}
              className="text-sm text-accent underline underline-offset-2"
            >
              Add data
            </Link>
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}

export default async function HomePage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params;
  const ctx = await getAccessContext(orgSlug);
  /*
   * Home was the one tenant page with no explicit gate (ADR-094). It was correct — every effective
   * role that resolves holds `dashboard.view`, and `suspended_member`'s entire grant is that one
   * bit — but it was correct by a property of the matrix rather than by anything this page said,
   * and the matrix is the thing most likely to change.
   */
  requirePermission(ctx, 'dashboard.view');
  const canImport = can(ctx, 'imports.create');
  // The detail beneath the overview: evidence ("Why?"), Insights' alerts, the Money pages (ADR-172).
  const seesDetail = can(ctx, 'financials.view');
  const base = `/app/${orgSlug}`;
  // Each band is asked for only by someone who may open it: `listActions` refuses without
  // `actions.view`, and the alerts behind "Top risks" are `financials.view` reading (ADR-172).
  const showsActions = can(ctx, 'actions.view') && moduleOn(ctx, 'actions');
  const keepsData = can(ctx, 'imports.review');

  const [state, ask, reports, profile, org] = await Promise.all([
    loadHome(ctx.db, ctx.orgId!, orgSlug, ctx.requestId, {
      suspended: ctx.organizationStatus === 'suspended',
    }),
    // "Request more information" heads Home for a member who may ask and lacks the detail.
    mayRequestAccess(ctx.effectiveRole) && !seesDetail ? waitingRequest(ctx) : Promise.resolve(null),
    // Someone without `financials.view` sees their reports here (Departments carries everyone else's).
    can(ctx, 'reports.view') && !seesDetail ? homeReports(ctx, base) : Promise.resolve(null),
    callApi<Array<{ full_name: string | null }>>(ctx.db, 'my_profile', {}, ctx.requestId),
    loadOrganizationFacts(ctx.db, ctx.orgId!),
  ]);

  const askCard = ask === null ? null : <RequestMoreCard href={`${base}/access`} waitingSince={ask.waitingSince} />;
  const reportsBand = reports === null || reports.length === 0 ? null : <YourReports links={reports} allHref={moduleOn(ctx, 'reports') ? `${base}/reports` : null} />;

  /*
   * ADR-176: Home is the client lobby. The departments the reader may open head it, as a row — each
   * gated as its own section is, so a tile never leads to a refusal — and "More apps" opens the
   * workspace window (owner's reference, 2026-10-29) for a reader who may see Departments.
   */
  const departments: LobbyDepartment[] = [
    { key: 'analysis', title: 'Financial Analysis', line: 'Understand performance', href: `${base}/home`, icon: <ChartColumn /> },
    ...(seesDetail && moduleOn(ctx, 'banking')
      ? [{ key: 'banking', title: 'Banking', line: 'Control cash & funding', href: `${base}/money/banking`, icon: <Landmark /> }] : []),
    ...(dataLinks(ctx).length > 0
      ? [{ key: 'data', title: 'Data Capture', line: 'Build reliable foundations', href: `${base}/data/imports`, icon: <FileText /> }] : []),
    ...(showsActions
      ? [{ key: 'actions', title: 'Manage Workflow', line: 'Assign, track & review', href: `${base}/actions`, icon: <ListChecks /> }] : []),
  ];
  const showMore = can(ctx, DEPARTMENTS_PERMISSION);

  const orgName = org?.name ?? 'Your company';
  const currency = org?.baseCurrency ?? 'GBP';
  const firstName = profile?.[0]?.full_name?.trim().split(/\s+/)[0];
  const greeting = `Welcome back${firstName ? `, ${firstName}` : ''}. Your business, in perspective.`;

  const top = (orgLine: string) => (
    <>
      <DepartmentStrip departments={departments} currentKey="analysis" showMore={showMore} />
      <LobbyHero section="Financial Analysis" greeting={greeting} orgName={orgName} orgLine={orgLine} />
    </>
  );

  if (state.kind === 'first_run' || state.kind === 'awaiting_review') {
    return (
      <>
        {top(`Workspace · ${currency}`)}
        <div className="mt-8 flex flex-col gap-6">
          {askCard}
          {state.kind === 'first_run' ? <FirstRun orgSlug={orgSlug} canImport={canImport} /> : (
            <Card>
              <CardBody className="p-6 sm:p-8">
                <h2 className="text-2xl text-ink">Your import is waiting for review.</h2>
                <p className="mt-3 max-w-prose text-ink-muted">
                  We found {state.rowCount} rows in{' '}
                  <span className="font-mono">{state.filename}</span>. Check the {state.issueCount}{' '}
                  {state.issueCount === 1 ? 'item' : 'items'} we flagged, then confirm, and your
                  numbers will appear here.
                </p>
                <div className="mt-6">
                  <ButtonLink href={`/app/${orgSlug}/data/imports/${state.batchId}`}>
                    Review import
                  </ButtonLink>
                </div>
              </CardBody>
            </Card>
          )}
          {reportsBand}
        </div>
        <LobbyFooter line="Your figures appear here once they are added" />
      </>
    );
  }

  const { view } = state;
  // Passed down rather than read inside each widget, so every "overdue" on the page agrees.
  const today = todayInTimeZone(systemClock, 'UTC');

  const [trend, topRisks, actionsSummary, compliance] = await Promise.all([
    loadTrend(ctx.db, ctx.orgId!, view.periods, ctx.requestId, view.period.id),
    seesDetail ? loadTopRisks(ctx.db, ctx.orgId!, orgSlug, 3, ctx.requestId) : Promise.resolve(null),
    showsActions ? getActionsSummary(ctx, today, 4) : Promise.resolve(null),
    keepsData ? loadDataCompliance(ctx, today) : Promise.resolve(null),
  ]);
  const series = chartSeriesFrom(trend);
  const seriesFor = new Map(series.map((one) => [one.key, one]));
  const latestLabel = series[0]?.points.at(-1)?.periodLabel;
  const firstLabel = series[0]?.points[0]?.periodLabel;
  const showsWhatIf = seesDetail && moduleOn(ctx, 'planning');
  const showsAnalyst = sectionLinks(ctx).some((link) => link.path === 'analyst');
  // "Make the next move" (ADR-179): each workspace the reader may open, gated as its own page is.
  const nextMoves: NextMove[] = [
    ...(showsActions ? [{
      key: 'workflow', eyebrow: 'Improve the way you work', title: 'Manage Systems and Workflow.',
      line: 'Assign, track and review what needs doing, with the evidence behind each step.',
      href: `${base}/actions`, cta: 'Open the Action Centre', icon: <ListChecks />,
    }] : []),
    ...(seesDetail ? [{
      key: 'insights', eyebrow: 'An APX perspective', title: 'AI Insights.',
      line: 'What moved this month and why, read from the figures APX calculated.',
      href: `${base}/insights`, cta: 'Open Insights', icon: <Sparkles />,
    }] : []),
    ...(ctx.organizationStatus !== 'suspended' ? [{
      key: 'notifications', eyebrow: 'Set · Track · Improve', title: 'Monthly Notifications.',
      line: 'Your inbox: alerts, answers to your requests and updates from your adviser.',
      href: `${base}/notifications`, cta: 'Open notifications', icon: <Bell />,
    }] : []),
    ...(moduleOn(ctx, 'reports') && can(ctx, 'reports.view') ? [{
      key: 'reports', eyebrow: 'Reports & packs', title: 'Analyse your Reports.',
      line: 'Monthly management reports, ready to read on screen or download.',
      href: `${base}/reports`, cta: 'Open Reports', icon: <FileText />,
    }] : []),
  ];

  return (
    <>
      {top(`${view.period.label} · ${currency}`)}

      <div className="mt-6 flex flex-col gap-6">
        {askCard}

        {/*
          §7.1: the banner keys off a queued or running job, never off a run row, so an orphaned run
          cannot leave it up forever (F-D-03). Stale figures stay visible and tagged rather than
          being hidden — a reader with an old number and a warning is better served than one with
          a blank page.
        */}
        {view.recalculating ? (
          <Banner tone="info" title="Updating your numbers…">
            The figures below are from the last completed calculation and may change shortly.
          </Banner>
        ) : null}

        {state.kind === 'bank_only' ? <BankOnlyIntro orgSlug={orgSlug} canImport={canImport} /> : null}
      </div>

      {/* 01 — the headline numbers (§4 level 2), each with its last twelve months at the right. */}
      <section aria-labelledby="lobby-performance" className="mt-6">
        <BandHeading
          id="lobby-performance"
          number="01"
          eyebrow="Understand your performance"
          title="Financial Analysis"
          end={<>
            <Chip>{view.period.label}</Chip>
            {seesDetail ? <ArrowLink href={`${base}/money`}>All figures</ArrowLink> : null}
            {moduleOn(ctx, 'reports') && can(ctx, 'reports.view') ? <ArrowLink href={`${base}/reports`}>Reports</ArrowLink> : null}
          </>}
        />
        <p className="mt-3 text-[0.6875rem] text-ink-muted">{view.basisLine}</p>
        {/*
          §4: a month that is not finished gets one slim line and nothing more — no score, no
          comparisons, no alerts. A part-month compared with a whole one misleads. The cash page it
          links to is detail (`financials.view`); without it the line stands alone.
        */}
        {view.partialMonth ? (
          <p className="mt-1 text-[0.6875rem] text-ink-muted">
            <span className="text-ink">{view.partialMonth.label}:</span> {view.partialMonth.summary}{' '}
            {seesDetail ? <Link href={view.partialMonth.href} className="text-blue-ink underline underline-offset-2">See cash</Link> : null}
          </p>
        ) : null}
        <h3 className="sr-only">The headline numbers</h3>
        <ul className="mt-5 grid gap-[1.125rem] md:grid-cols-3" data-testid="headline-figures">
          {view.cards.map((card) => (
            <li key={card.metricKey} className="min-w-0">
              <LobbyFigure card={card} trend={seriesFor.get(card.metricKey) ?? null} showWhy={seesDetail} />
            </li>
          ))}
        </ul>
        {view.grossProfitNote ? (
          <p className="mt-3 text-[0.6875rem] text-ink-muted" data-testid="gross-profit-note">
            Profit after direct costs isn’t shown: {view.grossProfitNote}
          </p>
        ) : null}

        {/*
          Level 3 (§4): up to three OPEN alerts, highest severity first, as the reference's "Key Report
          Indicators". Acknowledged ones are excluded — putting a seen alert back at the top every
          morning is how people stop reading.
        */}
        {topRisks === null ? null : <div className="mt-5"><RiskPoints risks={topRisks} allHref={`${base}/insights`} periodLabel={view.period.label} /></div>}
      </section>

      {reportsBand ? <div className="mt-8">{reportsBand}</div> : null}

      {/* What is moving: the year in a line beside the score and the scenario, as the reference's visual grid. */}
      <section aria-label="Performance over time" className="mt-5 grid items-start gap-5 lg:grid-cols-[minmax(0,1.8fr)_minmax(19.375rem,1fr)]">
        <div className="flex min-w-0 flex-col gap-5">
          <LobbyPanel
            id="lobby-trend"
            eyebrow="Performance over time"
            title="Sales, profit & cash"
            end={firstLabel && latestLabel ? <span className="text-[0.6875rem] whitespace-nowrap text-ink-muted">{firstLabel} – {latestLabel}</span> : null}
          >
            {/* The table behind "Show as table" is always in the document: the accessible form (§11). */}
            <TrendChart
              series={series}
              ariaSummary={`Sales, profit and cash by month${firstLabel && latestLabel ? `, ${firstLabel} to ${latestLabel}` : ''}. Every figure is in the table.`}
              tableFallbackId="lobby-trend-table"
              highlightPeriodId={view.period.id}
            />
          </LobbyPanel>
          {/*
            Level 1 (§4): the one plain sentence. It comes from `modules/health` templates, not from
            the AI — it has to be reproducible from the snapshots.
          */}
          {view.summary.text ? (
            <LobbyPanel
              id="lobby-perspective"
              tone="tinted"
              serif
              eyebrow="APX perspective"
              title={`${view.period.label}, in a sentence.`}
              end={<Sparkles aria-hidden="true" className="size-[1.0625rem] shrink-0 text-accent" />}
            >
              <p className="text-[0.75rem] leading-[1.8] text-ink-muted">{view.summary.text}</p>
              {seesDetail ? <ArrowLink href={`${base}/insights`} className="mt-3">Explore the insights</ArrowLink> : null}
            </LobbyPanel>
          ) : null}
        </div>

        <div className="flex min-w-0 flex-col gap-5">
          {view.health ? (
            <LobbyPanel id="lobby-health" eyebrow="The bigger picture" title="Business health" end={<HeartPulse aria-hidden="true" className="size-[1.0625rem] shrink-0 text-[#aa92a2]" />}>
              <HealthRing view={view.health} comparisonLabel={view.comparisonLabel} explainHref={`${base}/home/health`} />
            </LobbyPanel>
          ) : null}
          {showsWhatIf ? (
            <LobbyPanel
              id="lobby-scenario"
              tone="growth"
              serif
              eyebrow="Turn insight into opportunity"
              title={<>How could things change<span className="text-accent">?</span></>}
              end={<TrendingUp aria-hidden="true" className="size-[1.0625rem] shrink-0 text-accent" />}
            >
              <p className="text-[0.75rem] leading-[1.8] text-ink-muted">
                Change sales, costs or hiring and see how the outlook moves — your recorded figures stay as they are.
              </p>
              <ButtonLink href={`${base}/what-if`} className="mt-4 w-full justify-center">Open What if</ButtonLink>
              <ArrowLink href={`${base}/forecast`} className="mt-3">See the forecast</ArrowLink>
            </LobbyPanel>
          ) : null}
        </div>
      </section>

      {/* What is being done about it (§4 level 3), and the workspace's state: the reference's row of three. */}
      <section aria-label="Priorities and workspace" className="mt-5 grid items-stretch gap-5 md:grid-cols-2 xl:grid-cols-[1fr_1.12fr_1.06fr]">
        {actionsSummary === null ? null : (
          <LobbyPanel
            id="lobby-actions"
            serif
            eyebrow="Your next moves"
            title="Priorities & observations."
            end={<ArrowLink href={`${base}/actions`}>Open all</ArrowLink>}
          >
            {actionsSummary.open === 0 ? (
              <p className="text-[0.75rem] leading-[1.8] text-ink-muted">Nothing outstanding. When you decide to act on something, it will show here until it is done.</p>
            ) : (
              <>
                <p className="text-[0.75rem] text-ink">
                  {actionsSummary.open} outstanding
                  {actionsSummary.overdue > 0 ? <span className="text-danger">, {actionsSummary.overdue} overdue</span> : null}
                  {actionsSummary.mine > 0 ? `, ${actionsSummary.mine} yours` : ''}
                </p>
                <div className="mt-1">
                  <ActionQueue actions={actionsSummary.top} today={today} actionHref={(id) => `${base}/actions/${id}`} icon={<ClipboardCheck />} />
                </div>
                <p className="mt-3 text-[0.6875rem] leading-[1.8] text-ink-muted">Open an action to see its evidence, its owner and what was decided.</p>
              </>
            )}
          </LobbyPanel>
        )}

        <WorkspaceStatus base={base} compliance={compliance} recalculating={view.recalculating} basisLine={view.basisLine} canAddData={canImport} today={today} />

        {showsAnalyst ? (
          <LobbyPanel id="lobby-analyst" tone="blush" serif eyebrow="Ask APX" title="Ask about your figures." end={<MessageCircleQuestion aria-hidden="true" className="size-[1.0625rem] shrink-0 text-accent" />}>
            <p className="text-[0.75rem] leading-[1.8] text-ink-muted">The AI Financial Analyst answers from your calculated figures only, with the evidence behind each answer.</p>
            <ButtonLink href={`${base}/analyst`} className="mt-4">Ask the analyst</ButtonLink>
          </LobbyPanel>
        ) : null}
      </section>

      {/* The reference's operations panel: each workspace the reader may open, one button each. */}
      <div className="mt-6">
        <NextMovePanel moves={nextMoves} />
      </div>

      <LobbyFooter line={view.basisLine} />
    </>
  );
}

/**
 * "Workspace status": the calculation, and for whoever keeps the data (`imports.review`) the
 * accountant's working lines — uploads waiting, last data added, the VAT and Corporation Tax dates,
 * one's own open actions (ADR-172 follow-up). A line the reader may not see is left out.
 */
function WorkspaceStatus({
  base, compliance, recalculating, basisLine, canAddData, today,
}: {
  base: string; compliance: DataComplianceView | null; recalculating: boolean; basisLine: string; canAddData: boolean; today: string;
}) {
  const lines: Array<{ key: string; title: string; value: string; href: string; attention: boolean }> = [];
  if (compliance?.imports) {
    lines.push({
      key: 'uploads', title: 'Uploads waiting for review', href: `${base}/data/imports`,
      value: compliance.imports.failed > 0 ? `${compliance.imports.awaitingReview} · ${compliance.imports.failed} failed` : String(compliance.imports.awaitingReview),
      attention: compliance.imports.awaitingReview > 0 || compliance.imports.failed > 0,
    });
    lines.push({
      key: 'last', title: 'Last data added', href: canAddData ? `${base}/data/imports/new` : `${base}/data/imports`,
      value: compliance.lastDataAdded === null ? 'Nothing yet' : formatDate(compliance.lastDataAdded), attention: false,
    });
  }
  if (compliance?.tax) {
    lines.push({
      key: 'vat', title: 'VAT', href: `${base}/money/tax`, attention: false,
      value: compliance.tax.vatQuarter === null
        ? (compliance.tax.vatRegistered === true ? 'Set your quarter months' : 'Not set up')
        : `Quarter ends ${formatDate(compliance.tax.vatQuarter.end)}`,
    });
    lines.push({
      key: 'ct', title: 'Corporation Tax', href: `${base}/money/tax`,
      value: compliance.tax.corporationTax === null ? 'No date yet' : `Due ${formatDate(compliance.tax.corporationTax.dueDate)}`,
      attention: compliance.tax.corporationTax !== null && compliance.tax.corporationTax.dueDate < today,
    });
  }
  return (
    <section aria-labelledby="lobby-workspace" className={`flex min-w-0 flex-col p-5 sm:p-6 ${LOBBY_CARD}`}>
      <div className="flex items-start justify-between gap-3">
        <Eyebrow>Completeness & connections</Eyebrow>
        <ShieldCheck aria-hidden="true" className="size-[1.0625rem] shrink-0 text-[#3e87c8]" />
      </div>
      <h2 id="lobby-workspace" className={`mt-3 text-[1.5rem] leading-[1.25] sm:text-[1.625rem] ${SERIF_TITLE}`}>
        Compliance view<span className="text-accent">.</span>
      </h2>
      <p className="mt-1 flex items-center gap-2 pb-3 text-[0.75rem] text-ink">
        <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${recalculating ? 'bg-warn-dot' : 'bg-good-dot'}`} />
        {recalculating ? 'Updating your numbers' : 'Figures up to date'}
      </p>
      <p className="text-[0.6875rem] leading-[1.7] text-ink-muted">{basisLine}</p>
      {lines.length > 0 ? (
        <ul className="mt-3">
          {lines.map((line) => (
            <li key={line.key} className="border-t border-[#edf1f6]">
              <Link href={line.href} className="flex items-center gap-2.5 py-3 hover:text-accent">
                <span
                  aria-hidden="true"
                  className={`flex size-[1.4375rem] shrink-0 items-center justify-center rounded-full border text-[0.75rem] font-semibold ${line.attention ? 'border-[#efd4e6] bg-[#fff8fc] text-accent' : 'border-[#d6e7f6] bg-[#f4faff] text-blue-ink'}`}
                >
                  {line.attention ? '!' : '✓'}
                </span>
                <span className="min-w-0 flex-1 text-[0.75rem] font-medium text-ink">{line.title}</span>
                <span className={`text-right text-[0.6875rem] tabular-nums ${line.attention ? 'font-semibold text-danger' : 'text-blue-ink'}`}>{line.value}</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
      {compliance?.myActions && compliance.myActions.open > 0 ? (
        <p className="mt-2 text-[0.75rem] text-ink">
          <Link href={`${base}/actions?show=mine`} className="hover:text-accent">
            {compliance.myActions.open} of your actions open
            {compliance.myActions.overdue > 0 ? <span className="text-danger">, {compliance.myActions.overdue} overdue</span> : null}
          </Link>
        </p>
      ) : null}
      {compliance ? <ArrowLink href={`${base}/data/imports`} className="mt-auto pt-3">Add or check your data</ArrowLink> : null}
    </section>
  );
}

/** The reader's own waiting request, if any — the card says so rather than inviting a second one. */
async function waitingRequest(ctx: AccessContext): Promise<{ waitingSince: string | null }> {
  const waiting = (await listAccessRequests(ctx, { status: 'pending' }))
    .find((request) => request.requesterId === ctx.userId);
  return { waitingSince: waiting ? formatDate(waiting.createdAt) : null };
}

/**
 * "Request more information" (ADR-172; SOW: a 3rd party may "request access for additional
 * information if needed"), at the top of Home for a member who may ask and does not hold the detail.
 */
function RequestMoreCard({ href, waitingSince }: { href: string; waitingSince: string | null }) {
  return (
    <Card className={CLICKABLE_CARD}>
      <CardBody className="flex min-w-0 flex-wrap items-start justify-between gap-4 p-5 sm:p-6">
        <div className="flex min-w-0 flex-1 gap-4">
          <IconBadge tint="pink"><KeyRound /></IconBadge>
          <div className="min-w-0">
            <h2 className="font-serif text-lg text-ink">
              <CardLink href={href} className="after:rounded-[inherit]">Request more information</CardLink>
            </h2>
            <p className="mt-1 max-w-prose text-sm text-ink-muted">
              {waitingSince === null
                ? 'You can see this company’s overview — its headline figures, Business Health Score and reports. If you need more, such as the figures behind them or its documents, ask the owner or an admin.'
                : `You asked for more access on ${waitingSince}. Your request is waiting for the owner or an admin to answer.`}
            </p>
          </div>
        </div>
        <span aria-hidden="true" className="inline-flex shrink-0 items-center gap-1 rounded-xl border border-accent/45 bg-surface px-3 py-1 text-sm font-medium text-accent group-hover:border-accent group-hover:bg-accent-soft">
          {waitingSince === null ? 'Ask for more' : 'See your request'} <ChevronRight className="size-4" />
        </span>
      </CardBody>
    </Card>
  );
}

interface ReportLink {
  readonly key: string;
  readonly label: string;
  readonly line: string;
  readonly href: string;
  readonly icon: ReactNode;
  readonly tint: IconTint;
}

/**
 * The reports a reader without `financials.view` can open (RBAC_MATRIX §8.3): the Monthly Management
 * Reports, Funding Readiness while it is on, Marketing and Investment while their systems are on.
 * Each is a page the reader may open; none is listed that would refuse them.
 */
async function homeReports(ctx: AccessContext, base: string): Promise<ReportLink[]> {
  const reportsOn = moduleOn(ctx, 'reports');
  const [monthly, funding] = await Promise.all([
    reportsOn ? listAvailable(ctx) : Promise.resolve([]),
    fundingEnabled(ctx),
  ]);
  const links: ReportLink[] = monthly.slice(0, 3).map((report) => ({
    key: `monthly-${report.periodId}`,
    label: `Monthly Management Report — ${report.periodLabel}`,
    line: 'Figures, health and what changed in the month',
    href: `${base}/reports/monthly/${report.periodId}`,
    icon: <FileText />,
    tint: 'violet',
  }));
  if (funding) {
    links.push({ key: 'funding', label: 'Funding Readiness', line: 'An indicative assessment, not a lending decision', href: `${base}/funding`, icon: <HandCoins />, tint: 'pink' });
  }
  if (marketingEnabled(ctx)) {
    links.push({ key: 'marketing', label: 'Marketing', line: 'The marketing strategy report', href: `${base}/marketing`, icon: <Megaphone />, tint: 'violet' });
  }
  if (investmentEnabled(ctx)) {
    links.push({ key: 'investment', label: 'Investment', line: 'The investment pack', href: `${base}/investment`, icon: <PiggyBank />, tint: 'pink' });
  }
  return links;
}

function YourReports({ links, allHref }: { links: readonly ReportLink[]; allHref: string | null }) {
  return (
    <section aria-labelledby="your-reports-heading">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 id="your-reports-heading" className="font-serif text-lg text-ink">Reports</h2>
        {allHref ? (
          <Link href={allHref} className="text-sm text-accent underline underline-offset-2">All reports</Link>
        ) : null}
      </div>
      <ul className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {links.map((link) => (
          <li key={link.key} className="min-w-0">
            <Card className={`h-full ${CLICKABLE_CARD}`}>
              <CardBody className="flex min-w-0 items-start gap-3 p-4">
                <IconBadge tint={link.tint} size="sm">{link.icon}</IconBadge>
                <div className="min-w-0">
                  <CardLink href={link.href} className="block font-medium text-ink [overflow-wrap:anywhere] after:rounded-[inherit]">
                    {link.label}
                  </CardLink>
                  <p className="mt-0.5 text-sm text-ink-muted">{link.line}</p>
                </div>
              </CardBody>
            </Card>
          </li>
        ))}
      </ul>
    </section>
  );
}

