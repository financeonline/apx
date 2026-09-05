/**
 * `expense.spike_category` (FINANCIAL_ENGINE.md §8.2), the condition health rule K3 counts.
 *
 * Two thresholds must BOTH hold: a rise of at least 25%, and a rise worth at least 2% of revenue.
 * Either alone produces noise nobody reads — a category that went from £40 to £90 more than doubled,
 * and a 3% rise in the largest cost line is normal. Requiring both is what makes the count in K3 a
 * statement about the business rather than about how many categories the chart of accounts has.
 *
 * Pure.
 */

import { Decimal, toMoneyString, toRatioString } from '@/core/money';
import { componentOf, dimensionsOf, usableValue, type RuleContext } from '../context';
import { minAbsThreshold } from '../suppression';
import { varianceKey } from '@/modules/financial-engine';
import type { MetricObservation, RuleOutcome } from '../types';

/** Defaults, CD-18. */
export const SPIKE_PCT_THRESHOLD = new Decimal('0.25');
export const SPIKE_REVENUE_SHARE = new Decimal('0.02');
export const SPIKE_HIGH_PCT = new Decimal('0.50');
export const SPIKE_HIGH_REVENUE_SHARE = new Decimal('0.05');
/** The floor that stands in for the revenue test when revenue is NULL (§8.2). */
export const SPIKE_ABSOLUTE_FLOOR = new Decimal('500');

const VARIANCE_KEY = varianceKey('expense_by_category', 'prev_period');

/** The category a dimensioned observation is about; `dimension_key`, never `dimension_id` (ADR-053). */
function categoryOf(observation: MetricObservation): string | null {
  return observation.dimensionKey ?? null;
}

/**
 * Every category whose spend spiked in this period.
 *
 * Deterministic order: categories are sorted by key, so two runs over identical data produce the
 * same outcomes in the same order — which is what makes the reproduction test in §7 meaningful.
 */
export function evaluateExpenseSpikeCategory(ctx: RuleContext): readonly RuleOutcome[] {
  const revenue = usableValue(
    ctx.snapshots.find(
      (s) => s.periodId === ctx.periodId && s.metricKey === 'revenue' && s.dimensionId === null,
    ),
  );
  const floor = minAbsThreshold(revenue);
  const materialRise = revenue === null
    ? SPIKE_ABSOLUTE_FLOOR
    : revenue.times(SPIKE_REVENUE_SHARE);
  const highRise = revenue === null ? null : revenue.times(SPIKE_HIGH_REVENUE_SHARE);

  const outcomes: RuleOutcome[] = [];

  const variances = [...dimensionsOf(ctx.snapshots, ctx.periodId, VARIANCE_KEY)]
    .sort((a, b) => (categoryOf(a) ?? '').localeCompare(categoryOf(b) ?? ''));

  for (const variance of variances) {
    const category = categoryOf(variance);
    if (category === null) continue;

    // `usableValue` returns NULL for a `basis_differs` variance, so a trial balance compared with a
    // bank statement can never fire this rule (§7.2, ADR-030.3).
    const rise = usableValue(variance);
    const pctChange = componentOf(variance, 'pct_change');
    if (rise === null || pctChange === null) continue;

    if (pctChange.lessThan(SPIKE_PCT_THRESHOLD)) continue;
    if (rise.lessThan(materialRise)) continue;
    // §8.1's absolute floor. A 30% rise on a £60 category is not a finding.
    if (rise.abs().lessThan(floor)) continue;

    const isHigh = pctChange.greaterThanOrEqualTo(SPIKE_HIGH_PCT)
      || (highRise !== null && rise.greaterThanOrEqualTo(highRise));

    outcomes.push({
      ruleKey: 'expense.spike_category',
      severity: isHigh ? 'high' : 'medium',
      subject: { type: 'standard_category', id: null, key: category },
      periodId: ctx.periodId,
      thresholdSummary: {
        category,
        current: typeof variance.components.current === 'string' ? variance.components.current : null,
        previous: typeof variance.components.comparison === 'string'
          ? variance.components.comparison : null,
        value: toMoneyString(rise),
        pct_change: toRatioString(pctChange),
        revenue: revenue === null ? null : toMoneyString(revenue),
        threshold_pct: toRatioString(SPIKE_PCT_THRESHOLD),
        threshold_value: toMoneyString(materialRise),
      },
      snapshotIds: variance.snapshotId === null ? [] : [variance.snapshotId],
      recordIds: [],
    });
  }

  return outcomes;
}
