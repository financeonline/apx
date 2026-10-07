import Link from 'next/link';
import { getAccessContext } from '@/modules/tenancy';
import { can } from '@/core/permissions';
import { loadAlertsPage, loadInsights, type MovementView } from '@/modules/dashboard';
import { PageHeader, Card, CardBody, EmptyState } from '@/components/ui/surfaces';
import { ButtonLink } from '@/components/ui/button';
import {
  AlertCard, NO_ALERTS_BODY, NO_ALERTS_FILTERED_BODY, NO_ALERTS_FILTERED_TITLE, NO_ALERTS_TITLE,
  bySeverity,
} from '@/components/dashboard';
import { AlertActions } from './alerts/alert-actions';
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

function MovementRow({ movement }: { movement: MovementView }) {
  const tone = movement.favourable ? 'text-good' : 'text-danger';

  return (
    <li className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-line/60 py-3 last:border-0">
      <div className="min-w-0">
        <p className="text-ink">
          {movement.dimensionLabel ?? movement.label}
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

      <div className="flex items-baseline gap-3">
        <span className={`font-mono tabular-nums ${tone}`}>{movement.change}</span>
        {movement.basisDiffers ? (
          // ADR-030: the two months came from different sources, so a percentage would compare two
          // different things.
          <span className="text-sm text-ink-faint">compared on a different basis</span>
        ) : movement.percent ? (
          <span className={`text-sm ${tone}`}>{movement.percent}</span>
        ) : null}
        <Link href={movement.whyHref} className="text-sm text-accent underline underline-offset-2">
          Why?
        </Link>
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
              {/* §6, exact copy. */}
              <h2 className="font-serif text-2xl text-ink">
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
            ? `${view.period.label} compared with ${view.comparison.label}`
            : view.period.label
        }
      />

      <div className="mt-8 flex flex-col gap-6">
        <section aria-labelledby="alerts-heading">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h2 id="alerts-heading" className="font-serif text-lg text-ink">
              Alerts{alerts.openCount > 0 ? ` (${alerts.openCount} open)` : null}
            </h2>
            <AlertFilters orgSlug={orgSlug} active={filters} />
          </div>

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
            <CardBody className="p-4">
              <p className="text-ink">
                Comparing {view.period.label} with {view.comparison.label}.
              </p>
              <p className="mt-1 text-sm text-ink-muted">
                We don’t have the month in between yet, so changes are shown against the nearest
                earlier month we do have. Add it to compare month to month.
              </p>
            </CardBody>
          </Card>
        ) : null}

        <Card>
          <CardBody className="p-4">
            <h2 className="font-serif text-lg text-ink">What needs attention</h2>
            {view.unfavourable.length === 0 ? (
              <p className="mt-3 text-ink-muted">Nothing moved against you this month.</p>
            ) : (
              <ul className="mt-2">
                {view.unfavourable.slice(0, 10).map((movement) => (
                  <MovementRow
                    key={`${movement.metricKey}|${movement.dimensionId ?? ''}`}
                    movement={movement}
                  />
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardBody className="p-4">
            <h2 className="font-serif text-lg text-ink">What went well</h2>
            {view.favourable.length === 0 ? (
              <p className="mt-3 text-ink-muted">Nothing moved in your favour this month.</p>
            ) : (
              <ul className="mt-2">
                {view.favourable.slice(0, 10).map((movement) => (
                  <MovementRow
                    key={`${movement.metricKey}|${movement.dimensionId ?? ''}`}
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
