import 'server-only';
import { orgRows } from '@/db/rls';
import type { Db } from '@/db/types';
import { Decimal, formatMoney, formatPercent, parseDecimalOrNull } from '@/core/money';
import { varianceKey } from '@/modules/financial-engine';
import * as repo from '../data/repository';
import { formatValue, labelFor, type PeriodLabel, type SnapshotRow } from '../domain/view-models';
import { statusFor, type StatusBadge } from '../domain/status';

/**
 * Insights (UX_ARCHITECTURE.md §3.1, IMPLEMENTATION_PLAN.md Phase 7 slice 5).
 *
 * "What changed, why, and open alerts." The ranking is by MONEY, not by percentage: a category that
 * doubled from £40 to £80 is not news, and a category that rose 12% on £90,000 is. Sorting by
 * percentage would put the noise at the top of the page every month.
 *
 * The drivers come from dimensioned snapshots the engine already wrote — spending by category and
 * by account. Nothing here computes a figure or a difference; the engine wrote the variances.
 */

export interface MovementView {
  readonly metricKey: string;
  readonly label: string;
  /** The dimension's own name, where the movement is a category or an account. */
  readonly dimensionLabel: string | null;
  readonly dimensionId: string | null;
  /** "+£2,900" — formatted, signed. */
  readonly change: string;
  /** The absolute size, for ranking. Kept as a string; never a JS number (ADR-006). */
  readonly magnitude: string;
  readonly percent: string | null;
  /** True when the movement is good news for this metric. */
  readonly favourable: boolean;
  readonly current: string;
  readonly comparison: string;
  readonly status: StatusBadge;
  readonly whyHref: string;
  /** ADR-030: a variance across two bases is reported without a percentage. */
  readonly basisDiffers: boolean;
}

export interface InsightsView {
  readonly period: PeriodLabel;
  readonly comparison: PeriodLabel | null;
  /** Set when the comparison is not the immediately preceding month (§6 "no adjacent month"). */
  readonly comparisonIsAdjacent: boolean;
  readonly periods: readonly PeriodLabel[];
  readonly unfavourable: readonly MovementView[];
  readonly favourable: readonly MovementView[];
}

export type InsightsState =
  | { readonly kind: 'needs_two_periods' }
  | { readonly kind: 'ready'; readonly view: InsightsView };

/** Which direction is good news. Absent means the direction carries no inherent meaning. */
const FAVOURABLE_WHEN_RISING: Readonly<Record<string, boolean>> = {
  revenue: true, gross_profit: true, operating_profit: true, net_profit: true,
  closing_cash: true, net_cash_movement: true,
  operating_expenses: false, cost_of_sales: false, expense_by_category: false,
  expense_by_account: false, receivables: false, payables: false,
};

/** The metrics Insights ranks. Scalars first, then the two dimensioned families (slice 5). */
const RANKED_SCALARS = [
  'revenue', 'gross_profit', 'operating_profit', 'net_profit',
  'operating_expenses', 'cost_of_sales', 'closing_cash', 'receivables', 'payables',
] as const;

const RANKED_DIMENSIONED = ['expense_by_category', 'expense_by_account'] as const;

function movementFrom(
  variance: SnapshotRow,
  baseKey: string,
  orgSlug: string,
  periodId: string,
  dimensionLabel: string | null,
): MovementView | null {
  if (variance.value === null) return null;

  const change = parseDecimalOrNull(variance.value);
  if (change === null || change.isZero()) return null;

  const pct = variance.components.pct_change;
  const basisDiffers = variance.dataQuality.warnings.includes('basis_differs');
  const favourableWhenRising = FAVOURABLE_WHEN_RISING[baseKey] ?? true;
  const currency = variance.currency ?? 'GBP';

  const componentValue = (name: string): string => {
    const raw = variance.components[name];
    if (raw === null || raw === undefined) return '—';
    return formatMoney(String(raw), { currency });
  };

  return {
    metricKey: baseKey,
    label: labelFor(baseKey).plain,
    dimensionLabel,
    dimensionId: variance.dimensionId,
    change: formatMoney(variance.value, { currency, signDisplay: 'always' }),
    magnitude: change.abs().toFixed(2),
    // Formatting comes only from core/money (§4): one decimal place, a true minus, and never a
    // raw decimal (§8.2).
    percent: basisDiffers || pct === null || pct === undefined
      ? null
      : formatPercent(String(pct), { signDisplay: 'always' }),
    favourable: change.greaterThan(new Decimal(0)) === favourableWhenRising,
    current: componentValue('current'),
    comparison: componentValue('comparison'),
    status: statusFor(variance),
    whyHref: `/app/${orgSlug}/evidence?metric=${encodeURIComponent(baseKey)}&period=${periodId}`,
    basisDiffers,
  };
}

/** Ranks by money moved, descending. Ties break on the key so the order is stable. */
function byMagnitude(a: MovementView, b: MovementView): number {
  const difference = new Decimal(b.magnitude).minus(new Decimal(a.magnitude));
  if (!difference.isZero()) return difference.greaterThan(0) ? 1 : -1;
  return `${a.metricKey}|${a.dimensionId ?? ''}`.localeCompare(`${b.metricKey}|${b.dimensionId ?? ''}`);
}

export async function loadInsights(
  db: Db,
  orgId: string,
  orgSlug: string,
  requestId?: string,
): Promise<InsightsState> {
  const [periods, withData] = await Promise.all([
    repo.loadPeriods(db, orgId, requestId),
    repo.loadPeriodsWithData(db, orgId, requestId),
  ]);

  const available = periods.filter((p) => withData.has(p.id));
  // §6: "We need two months to show what changed."
  if (available.length < 2) return { kind: 'needs_two_periods' };

  const period = available.find((p) => p.isComplete) ?? available[0]!;
  const comparison = available.find((p) => p.periodStart < period.periodStart) ?? null;

  // §6 "no adjacent month": when February is missing, March is compared with January and the page
  // says so, rather than presenting a two-month change as a one-month one.
  const adjacentStart = new Date(`${period.periodStart}T00:00:00Z`);
  adjacentStart.setUTCMonth(adjacentStart.getUTCMonth() - 1);
  const expectedAdjacent = adjacentStart.toISOString().slice(0, 10);
  const comparisonIsAdjacent = comparison?.periodStart === expectedAdjacent;

  const snapshots = await repo.loadPeriodSnapshots(db, orgId, period.id, requestId);
  const scalarByKey = new Map(
    snapshots.filter((s) => s.dimensionType === 'none').map((s) => [s.metricKey, s]),
  );

  const movements: MovementView[] = [];

  for (const key of RANKED_SCALARS) {
    const variance = scalarByKey.get(varianceKey(key, 'prev_period'));
    if (!variance) continue;
    const movement = movementFrom(variance, key, orgSlug, period.id, null);
    if (movement) movements.push(movement);
  }

  // The drivers: which category or account moved, from the dimensioned snapshots the engine wrote.
  const accountNames = new Map<string, string>();
  const accountRows = await orgRows<{ id: string; name: string }>(db, orgId, 'accounts');
  for (const row of accountRows) accountNames.set(row.id, row.name);

  for (const key of RANKED_DIMENSIONED) {
    const dimensioned = await repo.loadDimensioned(
      db, orgId, varianceKey(key, 'prev_period'), [period.id], requestId,
    );
    for (const variance of dimensioned) {
      // An account dimension is a row and is named by looking it up; a standard category is not a
      // row and carries its own name in `dimension_key` (ADR-053).
      const label = variance.dimensionType === 'account'
        ? accountNames.get(variance.dimensionId ?? '') ?? 'Unnamed account'
        : variance.dimensionKey ?? variance.dimensionId ?? 'Uncategorised';
      const movement = movementFrom(variance, key, orgSlug, period.id, label);
      if (movement) movements.push(movement);
    }
  }

  const ranked = [...movements].sort(byMagnitude);

  return {
    kind: 'ready',
    view: {
      period,
      comparison,
      comparisonIsAdjacent,
      periods: available,
      unfavourable: ranked.filter((m) => !m.favourable),
      favourable: ranked.filter((m) => m.favourable),
    },
  };
}

export { formatValue };
