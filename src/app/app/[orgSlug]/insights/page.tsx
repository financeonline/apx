import { BellRing, CalendarDays, ChartColumn, ChevronRight, CircleAlert, TrendingUp } from 'lucide-react';
import { getAccessContext } from '@/modules/tenancy';
import { can } from '@/core/permissions';
import { labelFor, loadAlertsPage, loadInsights, type MovementView } from '@/modules/dashboard';
import { PageHeader, Card, CardBody, EmptyState, IconBadge } from '@/components/ui/surfaces';
import { ButtonLink } from '@/components/ui/button';
import { CLICKABLE_ROW, CardLink, TOUCH_TARGET } from '@/components/ui/clickable-card';
import {
  AlertCard, NO_ALERTS_BODY, NO_ALERTS_FILTERED_BODY, NO_ALERTS_FILTERED_TITLE, NO_ALERTS_TITLE,
  bySeverity,
} from '@/components/dashboard';
import { AlertActions, AlertButtonsGuide } from './alerts/alert-actions';
import { AlertFilters, parseAlertFilters } from './alerts/filters';
import { requirePermission } from '@/app/_lib/authz';

export const dynamic = 'force-dynamic';

/**
 * Insights (UX_ARCHITECTURE.md §3.1, §6).
 *
 * "What changed, why, and open alerts." Movements are ranked by MONEY, not by percentage: a
 * category that doubled from £40 to £80 is not news, and one that rose 12% on £90,000 is. Ranking
 * by percentage would put the noise at the top of the page every month.
 *
 * The open alerts sit ABOVE the movements. A movement is something a reader has to interpret; an
 * alert is something the engine has already interpreted and thinks needs a decision. Putting the
 * interpreted things first is the difference between a page you scan and a page you act on.
 */


/** One movement. The whole row opens its evidence (owner, 2026-10-14): "Why?" is stretched over it. */
function MovementRow({ movement }: { movement: MovementView }) {
  const tone = movement.favourable ? 'text-good' : 'text-danger';
  const name = movement.dimensionLabel === null
    ? movement.label
    : movement.metricKey === 'expense_by_category'
      // A standard category arrives as its key ("operating_expense"); `labelFor` names it, or makes
      // an unknown one readable, rather than showing the key.
      ? labelFor(movement.dimensionLabel).plain
      : movement.dimensionLabel;

  return (
    <li className={`${CLICKABLE_ROW} -mx-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 rounded-lg border-b border-line/60 px-2 py-3 last:border-0`}>
      <div className="min-w-0">
        <p className="text-ink">
          {name}
          {/* "Spending by account" or "Spending by type", so a reader can tell the two lists apart. */}
          {movement.dimensionLabel ? (
            <span className="ml-2 text-sm text-ink-faint">{movement.label}</span>
          ) : null}
        </p>
        <p className="text-sm text-ink-muted">
          <span className="font-mono tabular-nums">{movement.comparison}</span>
          {' → '}
          <span className="font-mono tabular-nums">{movement.current}</span>
        </p>
      </div>

      <div className="flex flex-wrap items-baseline gap-3">
        <span className={`font-mono tabular-nums ${tone}`}>{movement.change}</span>
        {movement.basisDiffers ? (
          // ADR-030: the two months came from different sources, so a percentage would compare two
          // different things.
          <span className="text-sm text-ink-faint">compared on a different basis</span>
        ) : movement.percent ? (
          <span className={`text-sm ${tone}`}>{movement.percent}</span>
        ) : null}
        <CardLink
          href={movement.whyHref}
          className={`inline-flex items-center gap-0.5 self-center rounded-xl border border-accent/45 bg-surface px-2.5 py-0.5 text-sm font-medium text-accent transition-colors after:rounded-lg hover:border-accent hover:bg-accent-soft group-hover:border-accent group-hover:bg-accent-soft ${TOUCH_TARGET}`}
        >
          Why?
          <ChevronRight aria-hidden="true" className="size-4" />
        </CardLink>
      </div>
    </li>
  );
}

export default async function InsightsPage({
  params, searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { orgSlug } = await params;
  const filters = parseAlertFilters(await searchParams);
  const ctx = await getAccessContext(orgSlug);

  // The section is hidden in the navigation for a role that lacks it; a deep link gets the uniform
  // not-found rather than a page describing what it cannot show (§7.4).
  requirePermission(ctx, 'financials.view');

  const [state, alerts] = await Promise.all([
    loadInsights(ctx.db, ctx.orgId!, orgSlug, ctx.requestId),
    loadAlertsPage(ctx.db, ctx.orgId!, orgSlug, filters.query, ctx.requestId),
  ]);
  const canManageAlerts = can(ctx, 'alerts.manage');

  if (state.kind === 'needs_two_periods') {
    return (
      <>
        <PageHeader title="What changed" />
        <div className="mt-8">
          <Card>
            <CardBody className="p-8">
              <IconBadge tint="violet" size="lg"><ChartColumn /></IconBadge>
              {/* §6, exact copy. */}
              <h2 className="mt-4 font-serif text-2xl text-ink">
                We need two months to show what changed.
              </h2>
              <p className="mt-3 max-w-prose text-ink-muted">
                Insights compares this month with last month. Add another month of data and this
                page will show you the biggest movements and why they happened.
              </p>
              {can(ctx, 'imports.create') ? (
                <div className="mt-6">
                  <ButtonLink href={`/app/${orgSlug}/data/imports/new`}>Add data</ButtonLink>
                </div>
              ) : null}
            </CardBody>
          </Card>
        </div>
      </>
    );
  }

  const { view } = state;

  return (
    <>
      <PageHeader
        title="What changed"
        description={
          view.comparison
            ? `${view.period.label} compared with ${view.comparison.label}: what we spotted, then the biggest changes in your figures.`
            : view.period.label
        }
      />

      <div className="mt-8 flex flex-col gap-6">
        <section aria-labelledby="alerts-heading">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <IconBadge tint="violet" size="sm"><BellRing /></IconBadge>
              <h2 id="alerts-heading" className="font-serif text-lg text-ink">
                Alerts{alerts.openCount > 0 ? ` (${alerts.openCount} open)` : null}
              </h2>
            </div>
            <AlertFilters orgSlug={orgSlug} active={filters} />
          </div>
          <p className="mt-2 text-sm text-ink-muted">
            Things we spotted in your figures that may need a decision. Each one says what happened,
            why it matters and what you can do.
          </p>
          {canManageAlerts ? <AlertButtonsGuide role={ctx.effectiveRole} /> : null}

          {alerts.alerts.length === 0 ? (
            <div className="mt-3">
              <EmptyState title={filters.any ? NO_ALERTS_FILTERED_TITLE : NO_ALERTS_TITLE}>
                {filters.any ? NO_ALERTS_FILTERED_BODY : NO_ALERTS_BODY}
              </EmptyState>
            </div>
          ) : (
            <ul className="mt-3 grid gap-3">
              {bySeverity(alerts.alerts.map((a) => ({ ...a, lastEvaluatedAt: a.firstSeenLabel })))
                .map((alert) => (
                  <li key={alert.id}>
                    <AlertCard
                      alert={alert}
                      actions={canManageAlerts ? (
                        <AlertActions
                          orgSlug={orgSlug}
                          alertId={alert.id}
                          status={alert.status}
                          role={ctx.effectiveRole}
                        />
                      ) : undefined}
                    />
                  </li>
                ))}
            </ul>
          )}
        </section>

        {/* §6 "no adjacent month": say so, rather than presenting a two-month change as one. */}
        {view.comparison && !view.comparisonIsAdjacent ? (
          <Card>
            <CardBody className="flex min-w-0 gap-3.5 p-4">
              <IconBadge tint="pink" size="sm"><CalendarDays /></IconBadge>
              <div className="min-w-0">
                <p className="text-ink">
                  Comparing {view.period.label} with {view.comparison.label}.
                </p>
                <p className="mt-1 text-sm text-ink-muted">
                  We don’t have the month in between yet, so changes are shown against the nearest
                  earlier month we do have. Add it to compare month to month.
                </p>
              </div>
            </CardBody>
          </Card>
        ) : null}

        <Card>
          <CardBody className="p-4">
            <div className="flex items-center gap-3">
              <IconBadge tint="pink" size="sm"><CircleAlert /></IconBadge>
              <h2 className="font-serif text-lg text-ink">What moved against you</h2>
            </div>
            <p className="mt-1 text-sm text-ink-muted">
              The changes that work against you, the biggest amounts first. “Why?” shows the figures
              behind each one.
            </p>
            {view.unfavourable.length === 0 ? (
              <p className="mt-3 text-ink-muted">Nothing moved against you this month.</p>
            ) : (
              <ul className="mt-2">
                {/* A standard category has no dimension id (its name is its key, ADR-053): the label keeps its row apart. */}
                {view.unfavourable.slice(0, 10).map((movement) => (
                  <MovementRow
                    key={`${movement.metricKey}|${movement.dimensionId ?? movement.dimensionLabel ?? ''}`}
                    movement={movement}
                  />
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardBody className="p-4">
            <div className="flex items-center gap-3">
              <IconBadge tint="violet" size="sm"><TrendingUp /></IconBadge>
              <h2 className="font-serif text-lg text-ink">What went well</h2>
            </div>
            <p className="mt-1 text-sm text-ink-muted">
              The changes in your favour, the biggest amounts first.
            </p>
            {view.favourable.length === 0 ? (
              <p className="mt-3 text-ink-muted">Nothing moved in your favour this month.</p>
            ) : (
              <ul className="mt-2">
                {view.favourable.slice(0, 10).map((movement) => (
                  <MovementRow
                    key={`${movement.metricKey}|${movement.dimensionId ?? movement.dimensionLabel ?? ''}`}
                    movement={movement}
                  />
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>
    </>
  );
}
