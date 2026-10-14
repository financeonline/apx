import Link from 'next/link';
import {
  getAccessContext, listAccessRequests, mayRequestAccess, moduleOn, type AccessContext,
} from '@/modules/tenancy';
import { can } from '@/core/permissions';
import { systemClock, todayInTimeZone } from '@/core/periods';
import { getActionsSummary, type ActionsSummary } from '@/modules/actions';
import {
  loadHome, loadTopRisks, loadTrend, type AlertView, type HomeView, type MetricCardView,
} from '@/modules/dashboard';
import { loadDataCompliance, type DataComplianceView } from '@/modules/departments';
import { listAvailable } from '@/modules/reporting';
import { fundingEnabled } from '@/modules/funding';
import { marketingEnabled } from '@/modules/marketing';
import { investmentEnabled } from '@/modules/investment';
import { PageHeader, Card, CardBody, Banner, IconBadge, type IconTint } from '@/components/ui/surfaces';
import { formatDate } from '@/components/labels';
import type { ReactNode } from 'react';
import {
  ArrowDownLeft, ArrowLeftRight, ArrowUpRight, ChartColumn, ChevronRight, ClipboardCheck, Database, FileText,
  HandCoins, KeyRound, Megaphone, Percent, PiggyBank, Receipt, TrendingUp, Wallet,
} from 'lucide-react';
import { ButtonLink } from '@/components/ui/button';
import { ABOVE_CARD_LINK, CLICKABLE_CARD, CardLink } from '@/components/ui/clickable-card';
import { AlertCard, WidgetCards, HealthScoreCard, NO_ALERTS_BODY, NO_ALERTS_TITLE } from '@/components/dashboard';
import { requirePermission } from '@/app/_lib/authz';
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/shadcn';

export const dynamic = 'force-dynamic';

/**
 * Home (UX_ARCHITECTURE.md §4).
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

/** One status badge, or none. Basis and warnings go in the tooltip, never as a second badge (§4). */
function StatusBadge({ card }: { card: MetricCardView }) {
  const { status } = card;
  if (status.kind === 'none' || status.label === null) return null;

  const tone =
    status.kind === 'check' ? 'bg-warn-soft text-warn'
    : status.kind === 'estimate' ? 'bg-surface-sunken text-ink-muted'
    : status.kind === 'partial' ? 'bg-warn-soft text-warn'
    : 'bg-surface-sunken text-ink-muted';

  // Above the card's link layer, so its tooltip still shows (see `MetricCard`).
  return (
    <span
      className={`${ABOVE_CARD_LINK} inline-flex shrink-0 items-center rounded-[0.375rem] px-2 py-0.5 text-xs ${tone}`}
      title={status.tooltip}
    >
      {status.label}
    </span>
  );
}

/**
 * The change line.
 *
 * Colour carries meaning here and only here: green for a favourable movement, rust for an
 * unfavourable one, and neutral ink when the direction has no inherent meaning. Direction is
 * metric-aware and arrives on the view model — a fall in costs is good news (§4).
 */
function ChangeLine({ card }: { card: MetricCardView }) {
  if (!card.change) {
    return <p className="mt-1 text-sm text-ink-faint">no comparison yet</p>;
  }
  if (card.change.basisDiffers) {
    // ADR-030: the two months were computed from different sources, so a percentage would compare
    // two different things. The amount is shown, greyed, with the caveat instead.
    return (
      <p className="mt-1 text-sm text-ink-faint">
        <span className="font-mono">{card.change.amount}</span>{' '}
        <span>compared on a different basis</span>
      </p>
    );
  }

  const tone = card.change.favourable === null ? 'text-ink-muted'
    : card.change.favourable ? 'text-good' : 'text-danger';

  return <p className={`mt-1 text-sm ${tone}`}>{card.change.text}</p>;
}

/** Each headline figure's icon tile, as the reference's cards (ADR-155). Decorative. */
const METRIC_ICON: Readonly<Record<string, { icon: ReactNode; tint: IconTint }>> = {
  revenue: { icon: <ChartColumn />, tint: 'violet' },
  gross_profit: { icon: <Percent />, tint: 'pink' },
  operating_profit: { icon: <TrendingUp />, tint: 'violet' },
  closing_cash: { icon: <Wallet />, tint: 'pink' },
  receivables: { icon: <HandCoins />, tint: 'violet' },
  payables: { icon: <Receipt />, tint: 'pink' },
  cash_inflows: { icon: <ArrowDownLeft />, tint: 'violet' },
  cash_outflows: { icon: <ArrowUpRight />, tint: 'pink' },
  net_cash_movement: { icon: <ArrowLeftRight />, tint: 'violet' },
};

/**
 * A card's content. The widget grid supplies its surface, ring and shadow.
 *
 * The whole card opens the figure's evidence (owner, 2026-10-14): "Why?" is its one link, stretched
 * over the card (`ui/clickable-card`). The tile clips anything drawn outside it, so the hover and
 * focus ring is drawn inside its edge. The accountant's term and the basis, which were hover text on
 * the label and the figure, are the link's hover text now that the link covers them; the badge sits
 * above the link and keeps its own. The figure steps down a size in a narrow tile rather than
 * running out of it.
 */
function MetricCard({ card, showWhy }: { card: MetricCardView; showWhy: boolean }) {
  const look = METRIC_ICON[card.metricKey] ?? { icon: <ChartColumn />, tint: 'violet' as const };
  // Without `financials.view` the evidence page behind "Why?" is closed to the reader (ADR-172), so
  // the card is drawn whole but not clickable — never a link into a refusal.
  return (
    <div className={showWhy
      ? 'group @container relative h-full rounded-[var(--widget-radius)] p-5 transition-[box-shadow,background-color] duration-200 hover:bg-accent-soft/30 hover:shadow-[inset_0_0_0_2px_rgb(255_45_85/0.5)] focus-within:shadow-[inset_0_0_0_2px_rgb(255_45_85/0.65)]'
      : '@container relative h-full rounded-[var(--widget-radius)] p-5'}
    >
      <div>
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-3">
            <IconBadge tint={look.tint} size="sm">{look.icon}</IconBadge>
            <h3 className="min-w-0 text-sm font-semibold text-ink">{card.label}</h3>
          </div>
          <StatusBadge card={card} />
        </div>

        <p className="mt-3 font-mono text-2xl break-words text-ink tabular-nums @[15rem]:text-3xl">
          {card.value}
        </p>

        {card.secondaryLine ? (
          <p className="mt-1 text-sm text-ink-muted">
            {card.secondaryLine.label}:{' '}
            <span className="font-mono tabular-nums">{card.secondaryLine.value}</span>
          </p>
        ) : null}

        <ChangeLine card={card} />

        {/* Every number carries a "Why?" affordance opening the evidence drawer (§4) — for a reader who may open it. */}
        {showWhy ? (
          <CardLink
            href={card.whyHref}
            title={[card.technicalLabel, card.basisText].filter(Boolean).join(' · ') || undefined}
            className="mt-3 inline-flex items-center gap-1 rounded-xl border border-accent/45 bg-surface px-3 py-1 text-sm font-medium text-accent transition-colors after:rounded-[var(--widget-radius)] hover:border-accent hover:bg-accent-soft group-hover:border-accent group-hover:bg-accent-soft"
          >
            Why? <ChevronRight aria-hidden="true" className="size-4" />
          </CardLink>
        ) : card.basisText ? (
          <p className="mt-3 text-xs text-ink-faint">{card.basisText}</p>
        ) : null}
      </div>
    </div>
  );
}

function HeadlineNumbers({ view, showWhy }: { view: HomeView; showWhy: boolean }) {
  return (
    <section aria-labelledby="headline-numbers">
      <h2 id="headline-numbers" className="sr-only">The headline numbers</h2>
      <WidgetCards
        cards={view.cards.map((card) => ({
          id: card.metricKey, label: card.label, node: <MetricCard card={card} showWhy={showWhy} />,
        }))}
      />
      {view.grossProfitNote ? (
        <p className="mt-3 text-xs text-ink-muted" data-testid="gross-profit-note">
          Profit after direct costs isn’t shown: {view.grossProfitNote}
        </p>
      ) : null}
    </section>
  );
}

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

  const [state, ask, reports] = await Promise.all([
    loadHome(ctx.db, ctx.orgId!, orgSlug, ctx.requestId, {
      suspended: ctx.organizationStatus === 'suspended',
    }),
    // "Request more information" heads Home for a member who may ask and lacks the detail.
    mayRequestAccess(ctx.effectiveRole) && !seesDetail ? waitingRequest(ctx) : Promise.resolve(null),
    // Someone without `financials.view` lands here rather than on Departments, so their reports are
    // listed here (Departments carries everyone else's).
    can(ctx, 'reports.view') && !seesDetail ? homeReports(ctx, base) : Promise.resolve(null),
  ]);

  const askCard = ask === null ? null : <RequestMoreCard href={`${base}/access`} waitingSince={ask.waitingSince} />;
  const reportsBand = reports === null || reports.length === 0 ? null : <YourReports links={reports} allHref={moduleOn(ctx, 'reports') ? `${base}/reports` : null} />;

  if (state.kind === 'first_run') {
    return (
      <>
        <PageHeader title="How is my business doing?" />
        <div className="mt-8 flex flex-col gap-6">
          {askCard}
          <FirstRun orgSlug={orgSlug} canImport={canImport} />
          {reportsBand}
        </div>
      </>
    );
  }

  if (state.kind === 'awaiting_review') {
    return (
      <>
        <PageHeader title="How is my business doing?" />
        <div className="mt-8 flex flex-col gap-6">
          {askCard}
          <Card>
            <CardBody className="p-6 sm:p-8">
              <h2 className="font-serif text-2xl text-ink">Your import is waiting for review.</h2>
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
          {reportsBand}
        </div>
      </>
    );
  }

  const { view } = state;
  // Passed down rather than read inside each widget, so every "overdue" on the page agrees.
  const today = todayInTimeZone(systemClock, 'UTC');
  // Each band is asked for only by someone who may open it: `listActions` refuses without
  // `actions.view`, and the alerts behind "Top risks" are `financials.view` reading (ADR-172).
  const showsActions = can(ctx, 'actions.view') && moduleOn(ctx, 'actions');
  const keepsData = can(ctx, 'imports.review');

  const [trend, topRisks, actionsSummary, compliance] = await Promise.all([
    loadTrend(ctx.db, ctx.orgId!, view.periods, ctx.requestId, view.period.id),
    seesDetail ? loadTopRisks(ctx.db, ctx.orgId!, orgSlug, 3, ctx.requestId) : Promise.resolve(null),
    showsActions ? getActionsSummary(ctx, today, 3) : Promise.resolve(null),
    keepsData ? loadDataCompliance(ctx, today) : Promise.resolve(null),
  ]);

  return (
    <>
      <PageHeader title="How is my business doing?" description={view.period.label} />

      <div className="mt-8 flex flex-col gap-6">
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

        {state.kind === 'bank_only' ? (
          <BankOnlyIntro orgSlug={orgSlug} canImport={canImport} />
        ) : null}

        {/*
          Level 1 (§4): the score, one plain sentence, then the basis and freshness line.
          The sentence comes from `modules/health` templates, not from the AI — it is the first
          thing an owner reads about their own month and has to be reproducible from the snapshots.
        */}
        {view.health ? (
          <HealthScoreCard
            view={view.health}
            periodLabel={view.period.label}
            comparisonLabel={view.comparisonLabel}
            explainHref={`/app/${orgSlug}/home/health`}
          />
        ) : null}

        {view.summary.text ? (
          <p className="text-base text-ink">{view.summary.text}</p>
        ) : null}

        <p className="text-sm text-ink-muted">{view.basisLine}</p>

        {/*
          §4: a month that is not finished gets one slim line and nothing more — no score, no
          comparisons, no alerts. A part-month compared with a whole one misleads. The cash page it
          links to is detail (`financials.view`); without it the line stands alone.
        */}
        {view.partialMonth ? (
          <p className="text-sm text-ink-muted">
            <span className="text-ink">{view.partialMonth.label}:</span>{' '}
            {view.partialMonth.summary}{' '}
            {seesDetail ? (
              <Link
                href={view.partialMonth.href}
                className="text-accent underline underline-offset-2"
              >
                See cash
              </Link>
            ) : null}
          </p>
        ) : null}

        <HeadlineNumbers view={view} showWhy={seesDetail} />

        {reportsBand}

        {/* The accountant's working view, for whoever keeps the data (`imports.review`). */}
        {compliance === null ? null : <DataCompliance orgSlug={orgSlug} view={compliance} today={today} canAddData={canImport} />}

        {/* Level 3: what is moving. The trend table is the accessible form (§11). */}
        {/*
          Level 3 (§4): up to three OPEN alerts, highest severity first, in the compact variant.
          Acknowledged ones are excluded — somebody has already said they have seen it, and putting
          it back at the top of Home every morning is how people stop reading Home.
        */}
        {topRisks === null ? null : <TopRisks orgSlug={orgSlug} risks={topRisks} />}

        {/*
          Level 3 (§4): what this business has decided to do about any of it. Beneath the risks
          deliberately — the risks are what the product found, and the actions are what people chose
          in response, which is the order the conversation happens in.
        */}
        {actionsSummary === null ? null : <OutstandingActions orgSlug={orgSlug} summary={actionsSummary} today={today} />}

        <Card>
          <CardBody className="p-4">
            <h2 className="font-serif text-lg text-ink">What is moving</h2>
            <Table className="mt-4 min-w-0">
              <TableCaption className="sr-only">
                Revenue, profit and cash over the last twelve months
              </TableCaption>
              <TableHeader>
                <TableRow className="border-b border-line text-left text-ink-muted">
                  <TableHead scope="col" className="py-2 pl-0 pr-4 font-normal">Month</TableHead>
                  {trend.map((series) => (
                    <TableHead key={series.key} scope="col" className="py-2 pl-0 pr-4 font-normal">
                      {series.label}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {(trend[0]?.points ?? []).map((point, index) => (
                  <TableRow key={point.period} className="border-b border-line/60">
                    <TableHead scope="row" className="py-2 pl-0 pr-4 font-normal text-sm normal-case tracking-normal text-ink-muted">
                      {point.label}
                    </TableHead>
                    {trend.map((series) => {
                      const display = series.points[index]?.display ?? '—';
                      return (
                        <TableCell key={series.key} className="py-2 pl-0 pr-4 font-mono tabular-nums text-ink">
                          {/* A month with no figure is a gap, never a zero (§4). */}
                          {display}
                        </TableCell>
                      );
                    })}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardBody>
        </Card>
      </div>
    </>
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

/**
 * "Data & compliance" (ADR-172 follow-up): uploads waiting, last data added, the VAT and Corporation
 * Tax dates, and one's own open actions. A line the reader may not see is null and left out.
 */
function DataCompliance({
  orgSlug, view, today, canAddData,
}: { orgSlug: string; view: DataComplianceView; today: string; canAddData: boolean }) {
  const base = `/app/${orgSlug}`;
  return (
    <section aria-labelledby="data-compliance-heading" className="panel rounded-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 gap-3">
          <IconBadge tint="violet" size="sm"><Database /></IconBadge>
          <div className="min-w-0">
            <h2 id="data-compliance-heading" className="font-serif text-lg text-ink">Data &amp; compliance</h2>
            <p className="text-sm text-ink-muted">What is waiting, how fresh the data is, and the dates ahead.</p>
          </div>
        </div>
        <Link href={`${base}/data/imports`} className="inline-flex items-center text-sm font-medium text-accent hover:underline pointer-coarse:min-h-10">
          Data capture →
        </Link>
      </div>
      <ul className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {view.imports === null ? null : (
          <ComplianceTile
            href={`${base}/data/imports`}
            title="Uploads waiting for review"
            value={String(view.imports.awaitingReview)}
            line={view.imports.failed > 0 ? `${view.imports.failed} failed` : view.imports.awaitingReview === 0 ? 'Nothing to check' : 'Check and confirm them'}
            tone={view.imports.awaitingReview > 0 || view.imports.failed > 0 ? 'attention' : 'calm'}
            icon={<Database />}
          />
        )}
        {view.imports === null ? null : (
          <ComplianceTile
            href={canAddData ? `${base}/data/imports/new` : `${base}/data/imports`}
            title="Last data added"
            value={view.lastDataAdded === null ? 'Nothing yet' : formatDate(view.lastDataAdded)}
            line={canAddData ? 'Add a statement, ledger or invoice list' : 'Every import, newest first'}
            tone="calm"
            icon={<FileText />}
          />
        )}
        {view.tax === null ? null : (
          <ComplianceTile
            href={`${base}/money/tax`}
            title="VAT"
            value={view.tax.vatQuarter === null ? 'Not set up' : `Quarter ends ${formatDate(view.tax.vatQuarter.end)}`}
            line={view.tax.vatQuarter === null
              ? (view.tax.vatRegistered === true ? 'Say which months your quarters end in' : 'Not VAT registered in APX')
              : view.tax.lastVatQuarter === null ? view.tax.vatQuarter.label : `Last quarter: ${view.tax.lastVatQuarter.label}`}
            tone="calm"
            icon={<Receipt />}
          />
        )}
        {view.tax === null ? null : (
          <ComplianceTile
            href={`${base}/money/tax`}
            title="Corporation Tax"
            value={view.tax.corporationTax === null ? 'No date yet' : `Due ${formatDate(view.tax.corporationTax.dueDate)}`}
            line={view.tax.corporationTax === null
              ? 'Shown once a month is complete (UK and UAE)'
              : `For the year to ${formatDate(view.tax.corporationTax.yearEnd)}`}
            tone={view.tax.corporationTax !== null && view.tax.corporationTax.dueDate < today ? 'attention' : 'calm'}
            icon={<Receipt />}
          />
        )}
      </ul>
      {view.myActions === null ? null : (
        <div className="mt-4 border-t border-line pt-4">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
              <ClipboardCheck aria-hidden="true" className="size-4 text-accent" /> Your open actions
            </h3>
            <Link href={`${base}/actions?show=mine`} className="text-sm text-accent underline underline-offset-2">Open yours</Link>
          </div>
          {view.myActions.open === 0 ? (
            <p className="mt-2 text-sm text-ink-muted">Nothing is given to you at the moment.</p>
          ) : (
            <>
              <p className="mt-2 text-sm text-ink">
                {view.myActions.open} open
                {view.myActions.overdue > 0 ? <span className="text-danger">, {view.myActions.overdue} overdue</span> : null}
              </p>
              <ul className="mt-2 flex flex-col gap-2">
                {view.myActions.top.map((action) => (
                  <li key={action.id} className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                    <Link href={`${base}/actions/${action.id}`} className="min-w-0 text-ink underline-offset-2 [overflow-wrap:anywhere] hover:underline">
                      {action.title}
                    </Link>
                    <span className={action.dueDate !== null && action.dueDate < today ? 'text-danger' : 'text-ink-muted'}>
                      {action.dueDate ?? 'No date'}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </section>
  );
}

function ComplianceTile({
  href, title, value, line, tone, icon,
}: { href: string; title: string; value: string; line: string; tone: 'attention' | 'calm'; icon: ReactNode }) {
  return (
    <li className="min-w-0">
      <div className={`relative h-full rounded-2xl border border-line bg-surface p-4 ${CLICKABLE_CARD}`}>
        <div className="flex min-w-0 items-center gap-2">
          <span aria-hidden="true" className="text-accent [&_svg]:size-4">{icon}</span>
          <CardLink href={href} className="min-w-0 text-sm font-medium text-ink after:rounded-2xl">{title}</CardLink>
        </div>
        <p className={`mt-2 text-lg tabular-nums [overflow-wrap:anywhere] ${tone === 'attention' ? 'text-warn' : 'text-ink'}`}>{value}</p>
        <p className="mt-0.5 text-xs text-ink-muted">{line}</p>
      </div>
    </li>
  );
}

/**
 * Level 3's outstanding actions (§4; SOW §17).
 *
 * Counts first, then the few a person would pick up next. A widget that listed everything would be
 * a second Action Centre on Home; what somebody needs here is whether anything is late and whether
 * any of it is theirs.
 */
function OutstandingActions({
  orgSlug,
  summary,
  today,
}: {
  orgSlug: string;
  summary: ActionsSummary;
  today: string;
}) {
  return (
    <section aria-labelledby="actions-heading">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 id="actions-heading" className="font-serif text-lg text-ink">What we are doing about it</h2>
        <Link href={`/app/${orgSlug}/actions`} className="text-sm text-accent underline underline-offset-2">
          Open the Action Centre
        </Link>
      </div>

      {summary.open === 0 ? (
        <Card className="mt-3">
          <CardBody className="p-4">
            <p className="text-ink">Nothing outstanding.</p>
            <p className="mt-1 text-sm text-ink-muted">
              When you decide to act on something, it will show here until it is done.
            </p>
          </CardBody>
        </Card>
      ) : (
        <Card className="mt-3">
          <CardBody className="p-4">
            <p className="text-sm text-ink">
              {summary.open} outstanding
              {summary.overdue > 0 ? <span className="text-danger">, {summary.overdue} overdue</span> : null}
              {summary.mine > 0 ? `, ${summary.mine} yours` : ''}
            </p>
            <ul className="mt-3 flex flex-col gap-2">
              {summary.top.map((action) => (
                <li key={action.id} className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                  <Link
                    href={`/app/${orgSlug}/actions/${action.id}`}
                    className="text-ink underline-offset-2 hover:underline"
                  >
                    {action.title}
                  </Link>
                  <span className={action.dueDate !== null && action.dueDate < today ? 'text-danger' : 'text-ink-muted'}>
                    {action.dueDate ?? 'No date'}
                  </span>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      )}
    </section>
  );
}

/** Level 3's top risks band (§4). Compact cards; the full text lives on Insights. */
function TopRisks({ orgSlug, risks }: { orgSlug: string; risks: readonly AlertView[] }) {
  return (
    <section aria-labelledby="top-risks-heading">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 id="top-risks-heading" className="font-serif text-lg text-ink">Top risks</h2>
        <Link href={`/app/${orgSlug}/insights`} className="text-sm text-accent underline underline-offset-2">
          See all alerts
        </Link>
      </div>

      {risks.length === 0 ? (
        <Card className="mt-3">
          <CardBody className="p-4">
            <p className="text-ink">{NO_ALERTS_TITLE}</p>
            <p className="mt-1 text-sm text-ink-muted">{NO_ALERTS_BODY}</p>
          </CardBody>
        </Card>
      ) : (
        <ul className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {risks.map((risk) => (
            <li key={risk.id}><AlertCard alert={risk} variant="compact" /></li>
          ))}
        </ul>
      )}
    </section>
  );
}
