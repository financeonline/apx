/**
 * Banking health (FINANCIAL_ENGINE.md §7.3, weight 10).
 *
 * The dimension a bank-only organisation always has. Its requirement is bank COVERAGE rather than a
 * metric (§7.1): an organisation with a statement for the period can be scored on how its balance
 * moved and what was unusual in it, whether or not it has ever uploaded a ledger. That is what makes
 * ADR-035's promise real — a score on the first import, rather than "not enough data yet".
 *
 * B3, like K3, counts CONDITIONS from the shared rule functions, never `alerts` rows, so no
 * dismissal can move it (R2-B-11).
 *
 * Pure.
 */

import { Decimal } from '@/core/money';
import {
  BANKING_ANOMALY_RULE_KEYS, conditionsFor, dataSuppression, evaluateConditions,
  type RuleOutcome,
} from '@/modules/alerts';
import {
  B1_FALLING_POINTS, B1_PERIODS, B1_RISING_POINTS, B4_FULL_POINTS, B4_PARTIAL_POINTS,
  BANKING_HEALTH_RULES as R,
} from '../config';
import {
  applyRule, flatRule, metricValue, reference, seriesOf, skippedRule, trailingPeriodIds,
} from '../apply';
import { sentence } from '../sentences';
import type { DimensionEvaluation } from '../dimension';
import type {
  ConditionReference, FactorSentence, HealthInput, RuleApplication,
} from '../types';

/**
 * B1: the direction of the closing balance over the last three periods.
 *
 * "Rising over the last 3" is read as three values in strictly increasing order, and "falling all 3"
 * as three in strictly decreasing order — two comparisons over three months, matching C3's "last 3"
 * (ADR-054.6). Anything in between scores nothing: a balance that went up, down and up again has no
 * trend worth points either way.
 */
export function balanceTrendRule(input: HealthInput): {
  rule: RuleApplication; direction: 'rising' | 'falling' | 'flat';
} {
  const periods = trailingPeriodIds(input.periodIds, input.periodId, B1_PERIODS);
  const series = seriesOf(input.snapshots, periods, 'closing_cash');
  const known = series.filter((v): v is Decimal => v !== null);

  if (known.length < B1_PERIODS) {
    return { rule: skippedRule('B1', 'insufficient_history'), direction: 'flat' };
  }

  const rising = known.every((v, i) => i === 0 || v.greaterThan(known[i - 1]!));
  const falling = known.every((v, i) => i === 0 || v.lessThan(known[i - 1]!));

  if (rising) {
    return { rule: flatRule('B1', 'rising for 3 months', B1_RISING_POINTS, null), direction: 'rising' };
  }
  if (falling) {
    return { rule: flatRule('B1', 'falling for 3 months', B1_FALLING_POINTS, null), direction: 'falling' };
  }
  return { rule: flatRule('B1', 'no clear trend', 0, null), direction: 'flat' };
}

/** The banking anomaly conditions for this period (§7.3 B3). */
export function bankingAnomalies(input: HealthInput): {
  readonly outcomes: readonly RuleOutcome[];
  readonly suppressed: boolean;
  readonly suppressionReason: string | null;
} {
  if (input.conditions === null) {
    return { outcomes: [], suppressed: true, suppressionReason: 'no_record_data' };
  }
  const evaluations = evaluateConditions(input.conditions);
  /*
   * B3 counts five rules, and it is scored ONLY when all five could run.
   *
   * The alternative — count whatever ran — awards +10 for "no anomalies found" on a month where
   * four of the five rules never looked, because the statement covering the outflows arrived half
   * empty. That is the score rewarding missing data, which is the one failure mode §5's whole data
   * quality model exists to prevent. A partial count is not a smaller count; it is a different
   * question (ADR-054.8).
   */
  const suppressed = BANKING_ANOMALY_RULE_KEYS
    .map((key) => dataSuppression(key, input.conditions!))
    .find((verdict) => verdict.suppressed);
  if (suppressed !== undefined) {
    return { outcomes: [], suppressed: true, suppressionReason: suppressed.reason };
  }
  return {
    outcomes: conditionsFor(evaluations, BANKING_ANOMALY_RULE_KEYS),
    suppressed: false,
    suppressionReason: null,
  };
}

export function evaluateBankingHealth(input: HealthInput): DimensionEvaluation {
  const { snapshots, periodId, currency } = input;

  const inflows = metricValue(snapshots, periodId, 'cash_inflows');
  const outflows = metricValue(snapshots, periodId, 'cash_outflows');
  const ratio = inflows !== null && outflows !== null && !outflows.abs().isZero()
    ? inflows.abs().dividedBy(outflows.abs())
    : null;

  const trend = balanceTrendRule(input);
  const anomalies = bankingAnomalies(input);

  const coverage = input.bankCoverageRatio;
  const b4 = coverage >= 1
    ? flatRule('B4', 'full', B4_FULL_POINTS, String(coverage))
    : coverage > 0
      ? flatRule('B4', 'partial', B4_PARTIAL_POINTS, String(coverage))
      : skippedRule('B4', 'no_bank_coverage');

  const rules: RuleApplication[] = [
    trend.rule,
    ratio === null ? skippedRule(R.B2.rule, 'no_outflows_to_compare') : applyRule(R.B2, ratio),
    anomalies.suppressed
      ? skippedRule(R.B3.rule, anomalies.suppressionReason ?? 'suppressed')
      : applyRule(R.B3, new Decimal(anomalies.outcomes.length)),
    b4,
  ];

  const conditions: readonly ConditionReference[] = anomalies.outcomes.map((outcome) => ({
    rule_key: outcome.ruleKey,
    subject_id: outcome.subject.id,
    subject_key: outcome.subject.key,
    snapshot_ids: outcome.snapshotIds,
    record_ids: outcome.recordIds,
  }));

  const positives: FactorSentence[] = [];
  const negatives: FactorSentence[] = [];

  if (trend.direction === 'rising') {
    positives.push(sentence('bank_balance_rising', {}, currency,
      [reference(snapshots, periodId, 'closing_cash').snapshot_id]));
  } else if (trend.direction === 'falling') {
    negatives.push(sentence('bank_balance_falling', {}, currency,
      [reference(snapshots, periodId, 'closing_cash').snapshot_id]));
  }
  if (!anomalies.suppressed && anomalies.outcomes.length > 0) {
    negatives.push(sentence('bank_anomalies',
      { count: String(anomalies.outcomes.length) }, currency, []));
  }

  return {
    key: 'banking_health',
    rules,
    metrics: [
      reference(snapshots, periodId, 'closing_cash'),
      reference(snapshots, periodId, 'cash_inflows'),
      reference(snapshots, periodId, 'cash_outflows'),
    ],
    conditions,
    requirements: [],
    coverageSatisfied: coverage > 0,
    positives,
    negatives,
  };
}
