/**
 * Data-only suppression (FINANCIAL_ENGINE.md §8.1, ADR-047.11).
 *
 * Suppression is split in two on purpose. `dataSuppressed` depends on DATA and nothing else, and is
 * shared by the alert job and by health rules K3/B3. `userSuppressed` — the dismissal cooldown —
 * depends on what somebody clicked, applies only when persisting an alert, and arrives in Phase 9.
 *
 * The split is the whole point of R2-B-11: if a dismissal could reach this function, dismissing an
 * alert would raise the health score, and the score would measure user behaviour rather than the
 * business. The test for that asserts K3/B3 counts are identical before and after dismissing every
 * alert; it can only pass while this file cannot see a status.
 *
 * Pure.
 */

import { Decimal } from '@/core/money';
import { observationOf, type RuleContext } from './context';
import type { ConditionRuleKey } from './types';

/** Below this, the engine has seen too little of the period to judge it (§8.1). */
export const MIN_COMPLETENESS = 0.5;

/**
 * The rules that survive an incomplete period (§8.1, ADR-030.4).
 *
 * A duplicate payment, an unusual payment and a missed direct debit are facts about transactions
 * that already happened; they do not become truer at month end. Everything comparative does, which
 * is why nothing else is evaluated on a partial month.
 */
export const INCOMPLETE_PERIOD_RULES: readonly ConditionRuleKey[] = [
  'duplicate.transaction',
  'bank.unusual_transaction',
  'recurring.amount_changed',
  'recurring.missed',
  'recurring.inflow_missed',
];

/** Rules whose condition reads a variance, and which the first-period gate therefore silences. */
export const VARIANCE_RULES: readonly ConditionRuleKey[] = ['expense.spike_category'];

/**
 * The metric whose completeness decides whether a rule can see enough of the period.
 *
 * §8.1 gives the threshold ("completeness < 0.5") without naming the figure it is measured on.
 * Each rule names the figure it actually depends on: the spike rule cannot judge spending it has
 * not seen, and the three bank-record rules cannot judge payments from a statement that covers half
 * the month. Recorded as ADR-054.2 rather than defaulted silently.
 */
export const COMPLETENESS_METRIC: Readonly<Record<ConditionRuleKey, string>> = {
  'expense.spike_category': 'operating_expenses',
  'bank.unusual_transaction': 'cash_outflows',
  'recurring.amount_changed': 'cash_outflows',
  'recurring.missed': 'cash_outflows',
  'recurring.inflow_missed': 'cash_inflows',
  'duplicate.transaction': 'cash_outflows',
};

/**
 * The floor under every money-valued condition: `max(£100, 0.5% of revenue)` (§8.1).
 *
 * Without it, a £12 duplicate subscription and a £12,000 duplicate payroll run are the same alert,
 * and the small one arrives far more often. Revenue NULL leaves the flat floor standing.
 */
export const MIN_ABS_FLOOR = new Decimal('100');
export const MIN_ABS_REVENUE_SHARE = new Decimal('0.005');

export function minAbsThreshold(revenue: Decimal | null): Decimal {
  if (revenue === null || revenue.lessThanOrEqualTo(0)) return MIN_ABS_FLOOR;
  const share = revenue.times(MIN_ABS_REVENUE_SHARE);
  return share.greaterThan(MIN_ABS_FLOOR) ? share : MIN_ABS_FLOOR;
}

export interface SuppressionReason {
  readonly suppressed: boolean;
  /** Why, for the health breakdown and for the alert job's log. NULL when not suppressed. */
  readonly reason: 'incomplete_period' | 'low_completeness' | 'first_period' | null;
}

/**
 * Should this rule be evaluated for this period at all?
 *
 * Returns the reason as well as the verdict, because "we did not look" and "we looked and found
 * nothing" are different things, and a health breakdown that cannot tell them apart would report a
 * clean month for an organisation whose data never arrived.
 */
export function dataSuppression(rule: ConditionRuleKey, ctx: RuleContext): SuppressionReason {
  if (!ctx.isComplete && !INCOMPLETE_PERIOD_RULES.includes(rule)) {
    return { suppressed: true, reason: 'incomplete_period' };
  }

  if (ctx.isFirstPeriodWithData && VARIANCE_RULES.includes(rule)) {
    return { suppressed: true, reason: 'first_period' };
  }

  const observation = observationOf(ctx.snapshots, ctx.periodId, COMPLETENESS_METRIC[rule]);
  if (observation !== undefined && observation.dataQuality.completeness < MIN_COMPLETENESS) {
    return { suppressed: true, reason: 'low_completeness' };
  }

  return { suppressed: false, reason: null };
}

/** The boolean form, for callers that only branch on it (§8.3 writes it this way). */
export function dataSuppressed(rule: ConditionRuleKey, ctx: RuleContext): boolean {
  return dataSuppression(rule, ctx).suppressed;
}
