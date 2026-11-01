import 'server-only';
import { reviewsAsAnalyst } from './reviewer';
import { NotFound } from '@/core/errors';
import { Decimal } from '@/core/money';
import { dimensionKeyOf, loadAlertsPage, loadDimensioned, loadMetricSeries, type AlertView, type SnapshotRow } from '@/modules/dashboard';
import type { AccessContext } from '@/modules/tenancy';
import * as repo from '../../data/dashboard-repository';
import { compactMoney, departmentHeading } from '../../domain/dashboard-ops';
import {
  alertQueue, alertQueueItems, minusEach, moneyChart, moneySpark, percentOf, revenueMix, sumKnown, valuesFor, yearOnYear,
} from '../../domain/dashboard-money';
import type { DepartmentView, Metric, MonthWindow, WindowMonth } from '../../domain/dashboard';
import { engagementItemsFor, reviewRequestTitle, titleSet } from './review-requests';

/**
 * Financial Analysis (the prototype's `analysis` department) with the company's own figures: the
 * engine's monthly `revenue`, `operating_profit` and `other_income` (`metric_current`, the rows Home
 * and the Money pages read), revenue by customer (`customer_revenue`), and the company's alerts as
 * the priorities queue. Operating costs are revenue less operating profit, as the prototype states
 * them. One series read covers the window, the same months a year earlier and the spark months.
 */

const SERIES_KEYS = ['revenue', 'operating_profit', 'other_income'] as const;

/** `metric -> period -> value` from undimensioned snapshot rows. */
export function seriesMap(rows: readonly SnapshotRow[]): Map<string, Map<string, string | null>> {
  const out = new Map<string, Map<string, string | null>>();
  for (const row of rows) {
    if (row.dimensionType !== 'none') continue;
    const byPeriod = out.get(row.metricKey) ?? new Map<string, string | null>();
    byPeriod.set(row.periodId, row.value);
    out.set(row.metricKey, byPeriod);
  }
  return out;
}

/** The window, the year-earlier months and the spark months: every period id one read needs. */
export function seriesPeriodIds(window: MonthWindow): string[] {
  const ids = [
    ...window.months.map((m) => m.periodId),
    ...window.months.map((m) => m.yearEarlierPeriodId).filter((id): id is string => id !== null),
    ...(window.recent ?? []).map((m) => m.periodId),
  ];
  return [...new Set(ids)];
}

/** The open and acknowledged alerts the reader can see (the Insights page's own reader). */
export async function queueAlerts(ctx: AccessContext, orgId: string): Promise<readonly AlertView[]> {
  const page = await loadAlertsPage(ctx.db, orgId, ctx.orgSlug ?? '', { statuses: ['open', 'acknowledged'] }, ctx.requestId);
  return page.alerts;
}

export async function loadAnalysisView(ctx: AccessContext, window: MonthWindow): Promise<DepartmentView> {
  const orgId = ctx.orgId;
  if (!orgId) throw new NotFound();
  const currency = window.currency;
  const months = window.months;
  const recent: readonly WindowMonth[] = (window.recent ?? months).slice(-3);
  const ids = months.map((m) => m.periodId);
  const money = (v: Decimal | null) => compactMoney(v, currency);

  const [series, customerRows, alerts, engagement] = await Promise.all([
    loadMetricSeries(ctx.db, orgId, SERIES_KEYS, seriesPeriodIds(window), ctx.requestId),
    loadDimensioned(ctx.db, orgId, 'customer_revenue', ids, ctx.requestId),
    queueAlerts(ctx, orgId),
    engagementItemsFor(ctx),
  ]);

  const byKey = seriesMap(series);
  const of = (key: string, periodIds: readonly (string | null)[]) => valuesFor(byKey.get(key) ?? new Map(), periodIds);
  const revenue = of('revenue', ids);
  const profit = of('operating_profit', ids);
  const costs = minusEach(revenue, profit);
  const earlierRevenue = of('revenue', months.map((m) => m.yearEarlierPeriodId));

  const totalRevenue = sumKnown(revenue);
  const totalProfit = sumKnown(profit);
  const totalCosts = sumKnown(costs);
  const margin = percentOf(totalProfit, totalRevenue);
  const change = yearOnYear(revenue, earlierRevenue);
  const recentIds = recent.map((m) => m.periodId);

  const metrics: Metric[] = [
    {
      label: 'Revenue', value: money(totalRevenue),
      change: change ?? '—', note: change === null ? 'no earlier year' : 'vs last year',
      spark: moneySpark(recent, of('revenue', recentIds), currency, true),
    },
    {
      label: 'Operating Profit', value: money(totalProfit),
      change: margin ?? '—', note: 'operating margin',
      spark: moneySpark(recent, of('operating_profit', recentIds), currency, true),
    },
    {
      label: 'Operating Costs', value: money(totalCosts),
      change: percentOf(totalCosts, totalRevenue) ?? '—', note: 'of revenue',
      spark: moneySpark(months, costs, currency, false),
    },
  ];

  const chart = moneyChart({
    dept: 'analysis', window, first: revenue, second: costs, baseline: earlierRevenue, baselineWhat: 'revenue',
    insight: margin === null ? 'Operating profit cannot be worked out for these months yet.' : `Operating profit is ${margin} of revenue.`,
    figure: money(totalProfit),
  });

  // Revenue mix: customers over the window, largest first, named from their own rows.
  const byCustomer = new Map<string, Decimal>();
  for (const row of customerRows) {
    const key = dimensionKeyOf(row);
    if (key === null || row.value === null) continue;
    byCustomer.set(key, (byCustomer.get(key) ?? new Decimal(0)).plus(new Decimal(row.value)));
  }
  const ranked = [...byCustomer.entries()].sort((a, b) => b[1].comparedTo(a[1]) || a[0].localeCompare(b[0])).slice(0, 2);
  const names = ranked.length === 0 ? new Map<string, string>() : await repo.counterpartyNames(ctx.db, orgId, ranked.map(([id]) => id));
  const mix = revenueMix({
    revenue: totalRevenue,
    otherIncome: sumKnown(of('other_income', ids)),
    customers: ranked.map(([id, value]) => ({ name: names.get(id) ?? 'Unnamed customer', value })),
    currency,
  });

  const items = alertQueueItems(alerts, titleSet(engagement), reviewRequestTitle);
  return {
    ...departmentHeading('analysis', window),
    metrics,
    chart,
    mix,
    queue: alertQueue(items, reviewsAsAnalyst(ctx)),
    clients: null,
    empty: totalRevenue === null && totalProfit === null
      ? 'No sales or profit figures for these months yet. Add a ledger, trial balance or profit and loss report to see them.'
      : null,
  };
}
