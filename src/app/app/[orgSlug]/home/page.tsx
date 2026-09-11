import Link from 'next/link';
import { getAccessContext } from '@/modules/tenancy';
import { can } from '@/core/permissions';
import { systemClock, todayInTimeZone } from '@/core/periods';
import { getActionsSummary, type ActionsSummary } from '@/modules/actions';
import {
  loadHome, loadTopRisks, loadTrend, type AlertView, type HomeView, type MetricCardView,
} from '@/modules/dashboard';
import { PageHeader, Card, CardBody, Banner } from '@/components/ui/surfaces';
import { ButtonLink } from '@/components/ui/button';
import { AlertCard, HealthScoreCard, NO_ALERTS_BODY, NO_ALERTS_TITLE } from '@/components/dashboard';
import { requirePermission } from '@/app/_lib/authz';

export const dynamic = 'force-dynamic';

/**
 * Home (UX_ARCHITECTURE.md §4).
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

  return (
    <span
      className={`inline-flex items-center rounded-[0.375rem] px-2 py-0.5 text-xs ${tone}`}
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
    : card.change.favourable ? 'text-accent' : 'text-danger';

  return <p className={`mt-1 text-sm ${tone}`}>{card.change.text}</p>;
}

function MetricCard({ card }: { card: MetricCardView }) {
  return (
    <Card>
      <CardBody className="p-4">
        <div className="flex items-start justify-between gap-2">
          <h3 className="text-sm text-ink-muted" title={card.technicalLabel}>{card.label}</h3>
          <StatusBadge card={card} />
        </div>

        <p className="mt-2 font-mono text-2xl text-ink tabular-nums" title={card.basisText}>
          {card.value}
        </p>

        {card.secondaryLine ? (
          <p className="mt-1 text-sm text-ink-muted">
            {card.secondaryLine.label}:{' '}
            <span className="font-mono tabular-nums">{card.secondaryLine.value}</span>
          </p>
        ) : null}

        <ChangeLine card={card} />

        {/* Every number carries a "Why?" affordance opening the evidence drawer (§4). */}
        <Link
          href={card.whyHref}
          className="mt-3 inline-block text-sm text-accent underline underline-offset-2"
        >
          Why?
        </Link>
      </CardBody>
    </Card>
  );
}

function HeadlineNumbers({ view }: { view: HomeView }) {
  return (
    <section aria-labelledby="headline-numbers">
      <h2 id="headline-numbers" className="sr-only">The headline numbers</h2>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
        {view.cards.map((card) => <MetricCard key={card.metricKey} card={card} />)}
      </div>
    </section>
  );
}

/** §6, exact copy. A first-run page says what to do next, not that something is missing. */
function FirstRun({ orgSlug, canImport }: { orgSlug: string; canImport: boolean }) {
  return (
    <Card>
      <CardBody className="p-8">
        <h2 className="font-serif text-2xl text-ink">Let’s get your first numbers on screen.</h2>
        <p className="mt-3 max-w-prose text-ink-muted">
          MOTION works from files you already have. Upload a bank statement (CSV or PDF) or an export
          from your accounting software and we’ll show you how the business is doing, what’s changed
          and what needs attention.
        </p>
        <p className="mt-3 max-w-prose text-sm italic text-ink-faint">
          Start with a bank statement to see your cash position. Add a ledger export, trial balance
          or invoice list when you can, and we’ll add profit and customer figures.
        </p>
        {canImport ? (
          <div className="mt-6 flex items-center gap-4">
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
          <div className="mt-4 flex items-center gap-4">
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

  const state = await loadHome(ctx.db, ctx.orgId!, orgSlug, ctx.requestId, {
    suspended: ctx.organizationStatus === 'suspended',
  });

  if (state.kind === 'first_run') {
    return (
      <>
        <PageHeader title="How is my business doing?" />
        <div className="mt-8"><FirstRun orgSlug={orgSlug} canImport={canImport} /></div>
      </>
    );
  }

  if (state.kind === 'awaiting_review') {
    return (
      <>
        <PageHeader title="How is my business doing?" />
        <div className="mt-8">
          <Card>
            <CardBody className="p-8">
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
        </div>
      </>
    );
  }

  const { view } = state;
  // Passed down rather than read inside each widget, so every "overdue" on the page agrees.
  const today = todayInTimeZone(systemClock, 'UTC');

  const [trend, topRisks, actionsSummary] = await Promise.all([
    loadTrend(ctx.db, ctx.orgId!, view.periods, ctx.requestId, view.period.id),
    loadTopRisks(ctx.db, ctx.orgId!, orgSlug, 3, ctx.requestId),
    getActionsSummary(ctx, today, 3),
  ]);

  return (
    <>
      <PageHeader title="How is my business doing?" description={view.period.label} />

      <div className="mt-8 flex flex-col gap-6">
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
          comparisons, no alerts. A part-month compared with a whole one misleads.
        */}
        {view.partialMonth ? (
          <p className="text-sm text-ink-muted">
            <span className="text-ink">{view.partialMonth.label}:</span>{' '}
            {view.partialMonth.summary}{' '}
            <Link
              href={view.partialMonth.href}
              className="text-accent underline underline-offset-2"
            >
              See cash
            </Link>
          </p>
        ) : null}

        <HeadlineNumbers view={view} />

        {/* Level 3: what is moving. The trend table is the accessible form (§11). */}
        {/*
          Level 3 (§4): up to three OPEN alerts, highest severity first, in the compact variant.
          Acknowledged ones are excluded — somebody has already said they have seen it, and putting
          it back at the top of Home every morning is how people stop reading Home.
        */}
        <TopRisks orgSlug={orgSlug} risks={topRisks} />

        {/*
          Level 3 (§4): what this business has decided to do about any of it. Beneath the risks
          deliberately — the risks are what the product found, and the actions are what people chose
          in response, which is the order the conversation happens in.
        */}
        <OutstandingActions orgSlug={orgSlug} summary={actionsSummary} today={today} />

        <Card>
          <CardBody className="p-4">
            <h2 className="font-serif text-lg text-ink">What is moving</h2>
            <table className="mt-4 w-full text-sm">
              <caption className="sr-only">
                Revenue, profit and cash over the last twelve months
              </caption>
              <thead>
                <tr className="border-b border-line text-left text-ink-muted">
                  <th scope="col" className="py-2 pr-4 font-normal">Month</th>
                  {trend.map((series) => (
                    <th key={series.key} scope="col" className="py-2 pr-4 font-normal">
                      {series.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(trend[0]?.points ?? []).map((point, index) => (
                  <tr key={point.period} className="border-b border-line/60">
                    <th scope="row" className="py-2 pr-4 font-normal text-ink-muted">
                      {point.label}
                    </th>
                    {trend.map((series) => {
                      const value = series.points[index]?.value ?? null;
                      return (
                        <td key={series.key} className="py-2 pr-4 font-mono tabular-nums text-ink">
                          {/* A month with no figure is a gap, never a zero (§4). */}
                          {value === null ? '—' : value}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </CardBody>
        </Card>
      </div>
    </>
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
        <ul className="mt-3 grid gap-3 sm:grid-cols-3">
          {risks.map((risk) => (
            <li key={risk.id}><AlertCard alert={risk} variant="compact" /></li>
          ))}
        </ul>
      )}
    </section>
  );
}
