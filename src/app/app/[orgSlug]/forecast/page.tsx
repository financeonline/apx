import Link from 'next/link';
import { formatMoney } from '@/core/money';
import {
  BASIS_LABEL, BASIS_TEXT, FORECAST_DISCLAIMER, FORECAST_HEADLINE_KEYS, basisSentence, hasForecast,
  loadForecast, metricLabel, unavailableText, type ForecastMetricView, type ForecastView,
} from '@/modules/forecast';
import { getAccessContext } from '@/modules/tenancy';
import type { ReactNode } from 'react';
import {
  CalendarRange, CircleHelp, HandCoins, Landmark, PiggyBank, Receipt, TrendingUp, Wallet,
} from 'lucide-react';
import {
  Badge, Banner, Card, CardBody, CardHeader, IconBadge, PageHeader, type IconTint,
} from '@/components/ui/surfaces';
import { requirePermission } from '@/app/_lib/authz';
import { RegenerateControl } from './regenerate-control';

export const dynamic = 'force-dynamic';

/** Each headline figure's decorative tile (ADR-155), alternating violet and pink as the reference. */
const FIGURE_TILE: Readonly<Record<string, { icon: ReactNode; tint: IconTint }>> = {
  revenue: { icon: <TrendingUp />, tint: 'violet' },
  operating_expenses: { icon: <Receipt />, tint: 'pink' },
  operating_profit: { icon: <PiggyBank />, tint: 'violet' },
  closing_cash: { icon: <Landmark />, tint: 'pink' },
  receivables: { icon: <HandCoins />, tint: 'violet' },
  payables: { icon: <Wallet />, tint: 'pink' },
};

/**
 * What is expected (REQ-FC-01/02/05; ADR-099).
 *
 * One question, answered once: what do the finished months suggest the next three will look like?
 * §15's whole instruction is simplicity, so the page is six figures, one sentence about what they
 * rest on, and progressive disclosure for anyone who wants the working.
 *
 * **A forecast never looks like a result.** Every figure carries the word "Forecast", the actual it
 * is compared against is labelled and shown beside it, and the disclaimer is on the page rather than
 * in a tooltip — §14's rule is that the two must not be confusable, and colour or position alone
 * would not do it for somebody scanning.
 *
 * Nothing here computes. Every number is a `forecast_values` row the deterministic engine's figures
 * produced through `modules/forecast`, and every actual is a `metric_snapshots` figure.
 */
export default async function ForecastPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const ctx = await getAccessContext(orgSlug);
  requirePermission(ctx, 'dashboard.view');

  const state = await loadForecast(ctx);

  if (!hasForecast(state)) {
    return (
      <>
        <PageHeader eyebrow="Forecast" title="What is expected" />
        <Card className="mt-6">
          <CardBody>
            <div className="mb-3"><IconBadge tint="violet"><CircleHelp /></IconBadge></div>
            <p className="text-sm text-ink">
              {state.reason === 'never_generated'
                ? 'No forecast has been worked out yet.'
                : 'There is not enough finished history to work out a forecast you could rely on.'}
            </p>
            {state.unavailable.length === 0 ? null : (
              <ul className="mt-3 flex flex-col gap-1 text-sm text-ink-muted">
                {state.unavailable.map((item) => (
                  <li key={item.metricKey}>
                    <span className="text-ink">{metricLabel(item.metricKey)}</span>
                    {' — '}
                    {unavailableText(item.reason)}
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-4 text-sm text-ink-muted">
              A forecast needs at least three finished months in a row. Add data for the months you
              are missing and it will appear here.
            </p>
            <div className="mt-4">
              <RegenerateControl orgSlug={orgSlug} label="Try to work one out" />
            </div>
          </CardBody>
        </Card>
      </>
    );
  }

  const first = state.periods[0];

  return (
    <>
      <PageHeader
        eyebrow="Forecast"
        title="What is expected"
        description={first === undefined ? undefined : `For ${first.periodLabel}`}
      />

      {state.stale ? (
        <div className="mt-6">
          <Banner tone="warn" title="Your figures have changed since this was worked out">
            This forecast rests on an earlier calculation. Work it out again to use the latest
            figures.
          </Banner>
        </div>
      ) : null}

      {/* §14: the disclaimer is on the page, not behind a tooltip. */}
      <p className="mt-6 text-sm text-ink-muted">{FORECAST_DISCLAIMER}</p>

      {first === undefined ? null : (
        <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FORECAST_HEADLINE_KEYS.map((key) => {
            const metric = first.metrics.find((m) => m.metricKey === key);
            const missing = state.unavailable.find((u) => u.metricKey === key);
            const tile = FIGURE_TILE[key];
            return (
              <Card key={key}>
                <CardBody>
                  <div className="flex min-w-0 items-center gap-3">
                    {tile === undefined ? null : <IconBadge tint={tile.tint} size="sm">{tile.icon}</IconBadge>}
                    <p className="min-w-0 text-xs font-medium uppercase tracking-[0.1em] text-ink-muted">{metricLabel(key)}</p>
                  </div>
                  {metric === undefined ? (
                    <p className="mt-2 text-sm text-ink-muted">
                      {missing === undefined
                        ? 'Not available from the figures we have.'
                        : unavailableText(missing.reason)}
                    </p>
                  ) : (
                    <ForecastFigure metric={metric} />
                  )}
                </CardBody>
              </Card>
            );
          })}
        </div>
      )}

      <p className="mt-6 text-sm text-ink-muted">
        {basisSentence(state.periodsUsed)}
        {state.basis === null ? null : (
          <>
            {' '}
            <span className="text-ink">{BASIS_LABEL[state.basis]}</span>
            {' — '}
            {BASIS_TEXT[state.basis].split('—')[1]?.trim()}
          </>
        )}
      </p>

      {state.periods.length <= 1 ? null : (
        <Card className="mt-6">
          <CardHeader title="The months ahead" icon={<CalendarRange />} tint="pink" />
          <CardBody>
            <div className="flex flex-col gap-4">
              {state.periods.map((period) => (
                <div key={period.periodId} className="rounded-xl bg-surface-sunken p-3">
                  <p className="text-sm font-medium text-ink">{period.periodLabel}</p>
                  <dl className="mt-1 flex flex-wrap gap-x-6 gap-y-1 text-sm">
                    {FORECAST_HEADLINE_KEYS.map((key) => {
                      const metric = period.metrics.find((m) => m.metricKey === key);
                      if (metric === undefined) return null;
                      return (
                        <div key={key} className="flex gap-1.5">
                          <dt className="text-ink-muted">{metricLabel(key)}</dt>
                          <dd className="tabular-nums text-ink">
                            {formatMoney(metric.value, { currency: metric.currency ?? 'GBP' })}
                          </dd>
                        </div>
                      );
                    })}
                  </dl>
                </div>
              ))}
            </div>
          </CardBody>
        </Card>
      )}

      <HowItWasWorkedOut state={state} orgSlug={orgSlug} />

      {/* Phase 12 (ADR-100): the forecast is what a what-if changes, so this is where it is offered. */}
      <p className="mt-6 text-sm text-ink-muted">
        Wondering what would happen if something changed?{' '}
        <Link href={`/app/${orgSlug}/what-if`} className="font-medium text-accent underline underline-offset-2">
          Try a what-if
        </Link>
        .
      </p>

      <div className="mt-6">
        <RegenerateControl orgSlug={orgSlug} label="Work it out again" />
      </div>
    </>
  );
}

/**
 * One figure, with the actual it is compared against.
 *
 * The word "Forecast" is on the badge and the word "Actual" is on the line beneath, because §14's
 * requirement is that a reader scanning cannot mistake one for the other. The change is stated in
 * money and never as a percentage of a forecast, which would be a ratio of two estimates.
 */
function ForecastFigure({ metric }: { metric: ForecastMetricView }) {
  const currency = metric.currency ?? 'GBP';
  return (
    <>
      <div className="mt-2 flex items-baseline gap-2">
        <span className="font-mono text-2xl tabular-nums text-ink">
          {formatMoney(metric.value, { currency })}
        </span>
        <Badge tone="neutral">Forecast</Badge>
      </div>
      {metric.lastActual === null ? (
        <p className="mt-2 text-sm text-ink-faint">No finished month to compare with.</p>
      ) : (
        <p className="mt-2 text-sm text-ink-muted">
          Actual {metric.lastActual.periodLabel}:{' '}
          <span className="tabular-nums text-ink">
            {formatMoney(metric.lastActual.value, { currency })}
          </span>
          {metric.change === null ? null : (
            <>
              {' · '}
              <span className="tabular-nums">
                {formatMoney(metric.change, { currency, signDisplay: 'always' })}
              </span>
            </>
          )}
        </p>
      )}
    </>
  );
}

/** Progressive disclosure (§15): the working, only for a reader who asks for it. */
function HowItWasWorkedOut({ state, orgSlug }: { state: ForecastView; orgSlug: string }) {
  return (
    <details className="panel mt-6 rounded-card p-4">
      <summary className="cursor-pointer text-sm font-medium text-accent">How was this worked out?</summary>
      <div className="mt-3 flex flex-col gap-3 text-sm text-ink-muted">
        <p>
          Each figure is the average of your last finished months, with the most recent months
          counting for more. A month that is far out of line with the others — a one-off bill, say —
          is left out so it does not become part of your running costs.
        </p>
        <p>
          Profit is not averaged on its own: it is worked out from the forecast revenue and costs, so
          the figures always add up the way they do on your other pages. Cash starts from your last
          real closing balance and adds each month&rsquo;s expected movement.
        </p>
        <p>{basisSentence(state.periodsUsed)}</p>
        {state.unavailable.length === 0 ? null : (
          <div>
            <p className="text-ink">Not forecast</p>
            <ul className="mt-1 flex flex-col gap-1">
              {state.unavailable.map((item) => (
                <li key={item.metricKey}>
                  {metricLabel(item.metricKey)} — {unavailableText(item.reason)}
                </li>
              ))}
            </ul>
          </div>
        )}
        {state.evidenceBundleId === null ? null : (
          <p>
            <Link
              href={`/app/${orgSlug}/evidence/${state.evidenceBundleId}`}
              className="text-accent underline underline-offset-2"
            >
              See the figures this rests on
            </Link>
          </p>
        )}
      </div>
    </details>
  );
}
