import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { PageHeader, Card, CardHeader, CardBody } from '@/components/ui/surfaces';
import { Button } from '@/components/ui/button';
import { permissionsFor, type AuthzContext } from '@/core/permissions';
import {
  ActionsNoneEmpty,
  AlertsNoneEmpty,
  AnalystNoConversationsEmpty,
  AnalystNoDataEmpty,
  CustomersNoneEmpty,
  DataQualityBadge,
  DeniedState,
  ErrorState,
  HomeAwaitingReviewEmpty,
  HomeBankDataOnlyEmpty,
  HomeFirstRunEmpty,
  InsightsNeedsTwoPeriodsEmpty,
  InsightsNoAdjacentMonthEmpty,
  LoadingCard,
  MetricCard,
  MoneyNoInvoicesEmpty,
  NotFoundState,
  PeriodPicker,
  PermissionGate,
  PlatformNoOrganisationsEmpty,
  PortfolioNoAssignmentsEmpty,
  RecalculatingBanner,
  ReportsBeforeFirstMonthEmpty,
  SlowLoadingNotice,
  StaleFigure,
  SuspendedBanner,
  TrendChart,
} from '@/components/dashboard';
import type { ErrorVariant } from '@/components/dashboard';
import {
  CARDS,
  DEV_PERIODS,
  TREND_ARIA_SUMMARY,
  TREND_SERIES,
} from './fixtures';

/**
 * The fixture page (UX_ARCHITECTURE.md §5 "component rules", IMPLEMENTATION_PLAN.md Phase 7).
 *
 * Every state in §6 and §7 rendered at once, from fixed data, so the states can be looked at and
 * argued about before any of them can occur for real. This is where a wrong badge, a missing empty
 * state or a skeleton that shifts the layout is caught — none of which is visible in a test that
 * asserts strings.
 *
 * NOT A PRODUCTION ROUTE. It is rendered dynamically and refuses to exist outside development, so a
 * deployed build has no such page whatever links to it.
 */
export const dynamic = 'force-dynamic';

const CLIENT_CTX: AuthzContext = {
  effectiveRole: 'client',
  permissions: permissionsFor('client'),
};

export default function DevComponentsPage() {
  if (process.env.NODE_ENV === 'production') notFound();

  return (
    <main className="mx-auto max-w-6xl px-6 py-12 md:px-8">
      <PageHeader
        eyebrow="Development only"
        title="Dashboard components"
        description="Every state in UX_ARCHITECTURE.md §6 and §7, rendered from fixed data. This route does not exist in production."
      />

      <Section title="Metric cards (§4 level 2, §5)" note="Value, plain label with the technical term in the tooltip, one status badge, the change line and a Why? link.">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {CARDS.map((card) => (
            <div key={card.metricKey}>
              <p className="mb-2 text-xs uppercase tracking-[0.08em] text-ink-faint">{card.metricKey}</p>
              <MetricCard card={card} />
            </div>
          ))}
        </div>
      </Section>

      <Section title="Metric cards — compact variant" note="The only other variant §5 allows.">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {CARDS.slice(0, 4).map((card) => (
            <MetricCard key={card.metricKey} card={card} variant="compact" />
          ))}
        </div>
      </Section>

      <Section title="Status badges (§8.1)" note="The canonical table. A verified, complete figure carries no badge at all.">
        <Card>
          <CardBody className="flex flex-wrap items-center gap-6">
            <BadgeRow label="verified, complete" size="md" />
            <div className="flex flex-wrap items-center gap-3">
              <DataQualityBadge completeness={1} warnings={[]} assurance="calculated" />
              <DataQualityBadge completeness={0.4} warnings={[]} assurance="verified" />
              <DataQualityBadge completeness={1} warnings={[]} assurance="estimated" />
              <DataQualityBadge completeness={1} warnings={[]} assurance="inferred" />
              <DataQualityBadge
                completeness={0}
                warnings={[]}
                assurance="verified"
                available={false}
                missing={['no_opening_cash']}
              />
            </div>
          </CardBody>
          <CardBody className="flex flex-wrap items-center gap-3 border-t border-line">
            <span className="text-xs text-ink-faint">size sm</span>
            <DataQualityBadge completeness={1} warnings={[]} assurance="calculated" size="sm" />
            <DataQualityBadge completeness={0.4} warnings={[]} assurance="verified" size="sm" />
            <DataQualityBadge completeness={1} warnings={[]} assurance="estimated" size="sm" />
            <DataQualityBadge completeness={1} warnings={[]} assurance="inferred" size="sm" />
          </CardBody>
        </Card>
      </Section>

      <Section title="Trend chart (§4 level 3, §5, §11)" note="Three toggleable series over twelve months. A month with no figure is a gap, not a zero. Show as table reveals the same data; it is in the accessibility tree either way.">
        <Card>
          <CardHeader title="Sales, profit and cash" description="Twelve months to March 2026" />
          <CardBody>
            <TrendChart
              series={TREND_SERIES}
              ariaSummary={TREND_ARIA_SUMMARY}
              tableFallbackId="dev-trend-table"
              highlightPeriodId="2026-03"
            />
          </CardBody>
        </Card>
      </Section>

      <Section title="Trend chart — nothing to plot" note="Every month is a gap.">
        <Card>
          <CardBody>
            <TrendChart
              series={TREND_SERIES.map((one) => ({
                ...one,
                points: one.points.map((point) => ({ ...point, value: null, display: '—' })),
              }))}
              ariaSummary="No figures for these months yet."
              tableFallbackId="dev-trend-table-empty"
            />
          </CardBody>
        </Card>
      </Section>

      <Section title="Period picker (§5)" note="Monthly only. Only months with data, and the latest complete one is marked.">
        <Card>
          <CardBody>
            <PeriodPicker
              periods={DEV_PERIODS}
              value="2026-03"
              hrefFor={(id) => `/dev/components?period=${id}`}
            />
          </CardBody>
        </Card>
      </Section>

      <Section title="Permission gate (§5, §7.4)" note="An action the role lacks is hidden, not disabled. The denied state is for a whole page reached by a deep link.">
        <Card>
          <CardBody className="space-y-4">
            <div>
              <p className="text-sm text-ink-muted">
                With <span className="tabular">ai.use</span> (granted): the button is on the page.
              </p>
              <div className="mt-2">
                <PermissionGate ctx={CLIENT_CTX} permission="ai.use">
                  <Button tone="secondary">Ask the analyst</Button>
                </PermissionGate>
              </div>
            </div>
            <div>
              <p className="text-sm text-ink-muted">
                With <span className="tabular">settings.manage</span> (not granted): nothing renders
                below this line.
              </p>
              <div className="mt-2 border-t border-dashed border-line pt-2">
                <PermissionGate ctx={CLIENT_CTX} permission="settings.manage">
                  <Button tone="danger">Delete organisation</Button>
                </PermissionGate>
              </div>
            </div>
          </CardBody>
        </Card>
        <div className="mt-4">
          <Card>
            <PermissionGate
              ctx={CLIENT_CTX}
              permission="settings.manage"
              fallback="denied-state"
              organisationName="Acme Ltd"
              homeHref="/dev/components"
            >
              <CardBody>You should never see this.</CardBody>
            </PermissionGate>
          </Card>
        </div>
      </Section>

      <Section title="Loading (§7.1)" note="Skeletons hold the dimensions of the loaded card, so nothing moves when the figure arrives. The slow notice appears after three seconds; here it is forced on.">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <LoadingCard />
          <LoadingCard secondaryLine />
          <LoadingCard compact />
          <div className="flex flex-col justify-between">
            <LoadingCard compact />
            <SlowLoadingNotice delayMs={0} />
          </div>
        </div>
      </Section>

      <Section title="Recalculating and stale figures (§7.1, ADR-047.7)" note="Keyed off a queued or running calculation job, never off a run row. Stale figures are greyed and tagged, never hidden.">
        <div className="space-y-4">
          <RecalculatingBanner active monthsDone={3} monthsTotal={12} />
          <RecalculatingBanner active />
          <Card>
            <CardBody>
              <p className="text-sm text-ink-muted">Cash</p>
              <p className="tabular mt-1 text-3xl">
                <StaleFigure stale>£18,400</StaleFigure>
              </p>
            </CardBody>
          </Card>
        </div>
      </Section>

      <Section title="Errors (§7.2)" note="Plain words, whether the data is safe, and what to do next. Never a stack trace.">
        <div className="space-y-3">
          {ERROR_VARIANTS.map((variant) => (
            <ErrorState
              key={variant}
              variant={variant}
              requestId={variant === 'unknown' ? 'req_7f3a91c4' : undefined}
              actions={
                variant === 'calculation_failed' ? <Button tone="secondary">Retry</Button> : undefined
              }
            />
          ))}
          <ErrorState
            variant="duplicate_at_confirm"
            body="Another import added 12 of these rows while you were reviewing."
          />
          <SuspendedBanner />
        </div>
      </Section>

      <Section title="Denied and not found (§7.4)" note="A page the role cannot view says nothing about what it contains, and a missing organisation is indistinguishable from one that is not yours.">
        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <DeniedState organisationName="Acme Ltd" homeHref="/dev/components" />
          </Card>
          <Card>
            <NotFoundState backHref="/dev/components" />
          </Card>
        </div>
      </Section>

      <Section title="Empty states (§6)" note="Copy exactly as written in the specification.">
        <div className="space-y-6">
          <Fixture label="Home, first run">
            <HomeFirstRunEmpty addDataHref="/dev/components" helpHref="/dev/components" />
          </Fixture>
          <Fixture label="Home, bank data only">
            <HomeBankDataOnlyEmpty
              periodLabel="March"
              openingBalanceHref="/dev/components"
              addDataHref="/dev/components"
            />
          </Fixture>
          <Fixture label="Home, awaiting review">
            <HomeAwaitingReviewEmpty
              rowCount={312}
              filename="march-statement.csv"
              issueCount={4}
              reviewHref="/dev/components"
            />
          </Fixture>
          <Fixture label="Insights, fewer than two periods">
            <InsightsNeedsTwoPeriodsEmpty addDataHref="/dev/components" />
          </Fixture>
          <Fixture label="Insights, no adjacent month">
            <InsightsNoAdjacentMonthEmpty
              period="March"
              comparison="January"
              missing="February"
              addDataHref="/dev/components"
            />
          </Fixture>
          <Fixture label="Money → Owed to you / You owe, no invoices">
            <MoneyNoInvoicesEmpty addDataHref="/dev/components" />
          </Fixture>
          <Fixture label="Customers, none">
            <CustomersNoneEmpty addDataHref="/dev/components" />
          </Fixture>
          <Fixture label="Actions, none">
            <ActionsNoneEmpty createHref="/dev/components" />
          </Fixture>
          <Fixture label="Actions, none — role that cannot create one">
            <ActionsNoneEmpty createHref="/dev/components" canCreate={false} />
          </Fixture>
          <Fixture label="AI Analyst, no committed data">
            <AnalystNoDataEmpty addDataHref="/dev/components" />
          </Fixture>
          <Fixture label="AI Analyst, no conversations">
            <AnalystNoConversationsEmpty askHrefBase="/dev/components" />
          </Fixture>
          <Fixture label="Reports, before the first full month">
            <ReportsBeforeFirstMonthEmpty addDataHref="/dev/components" />
          </Fixture>
          <Fixture label="Insights → Alerts filter, no open alerts">
            <AlertsNoneEmpty />
          </Fixture>
          <Fixture label="Portfolio, no assignments">
            <PortfolioNoAssignmentsEmpty />
          </Fixture>
          <Fixture label="Platform → Organizations, none">
            <PlatformNoOrganisationsEmpty createHref="/dev/components" />
          </Fixture>
        </div>
      </Section>
    </main>
  );
}

const ERROR_VARIANTS: readonly ErrorVariant[] = [
  'upload_rejected',
  'import_failed',
  'commit_interrupted',
  'calculation_failed',
  'ai_unavailable',
  'ai_grounding_failed',
  'offline',
  'session_expired',
  'unknown',
];

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="mt-10 border-t border-line pt-8 first:mt-0 first:border-0 first:pt-0">
      <h2 className="text-xl">{title}</h2>
      {note ? <p className="mt-2 max-w-3xl text-sm text-ink-muted">{note}</p> : null}
      <div className="mt-5">{children}</div>
    </section>
  );
}

function Fixture({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <p className="mb-2 text-xs uppercase tracking-[0.08em] text-ink-faint">{label}</p>
      {children}
    </div>
  );
}

function BadgeRow({ label, size }: { label: string; size: 'sm' | 'md' }) {
  return (
    <span className="text-xs text-ink-faint">
      {label}: no badge
      <DataQualityBadge completeness={1} warnings={[]} assurance="verified" size={size} />
    </span>
  );
}
