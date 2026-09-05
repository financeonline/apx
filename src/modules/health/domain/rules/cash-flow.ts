/**
 * Cash flow (FINANCIAL_ENGINE.md §7.3, weight 25).
 *
 * C2 carries the one rule in §7.3 that treats a NULL as good news. `cash_runway_months` is NULL for
 * two opposite reasons: the engine could not work it out, or the business is generating cash and has
 * no burn to divide by. The engine distinguishes them with the `cash_positive` warning, and this
 * rule reads that distinction. Without it, every profitable, cash-generative organisation would be
 * scored as though its runway were unknown.
 *
 * Pure.
 */

import { Decimal } from '@/core/money';
import { observationOf } from '@/modules/alerts';
import {
  C3_NEGATIVE_POINTS, C3_PERIODS, C3_POSITIVE_PERIODS, C3_POSITIVE_POINTS,
  CASH_FLOW_RULES as R, CASH_POSITIVE_POINTS, CASH_POSITIVE_RESULT,
} from '../config';
import {
  applyRule, flatRule, metricValue, reference, seriesOf, skippedRule, trailingPeriodIds,
} from '../apply';
import { sentence } from '../sentences';
import type { DimensionEvaluation, RequirementGroup } from '../dimension';
import type { FactorSentence, HealthInput, RuleApplication } from '../types';

const REQUIREMENTS: readonly RequirementGroup[] = [
  { keys: ['closing_cash'] },
  { keys: ['net_cash_movement'] },
];

/** C2: NULL runway is +20 only when the engine says the business is cash generative (§7.3). */
function runwayRule(input: HealthInput): RuleApplication {
  const runway = metricValue(input.snapshots, input.periodId, 'cash_runway_months');
  if (runway !== null) return applyRule(R.C2, runway);

  const observation = observationOf(input.snapshots, input.periodId, 'cash_runway_months');
  const cashPositive = observation?.dataQuality.warnings.includes('cash_positive') === true;
  return cashPositive
    ? flatRule(R.C2.rule, CASH_POSITIVE_RESULT, CASH_POSITIVE_POINTS, null)
    : skippedRule(R.C2.rule, 'runway_unavailable');
}

/** C3: the direction of net cash movement over the last three periods (§7.3). */
function movementTrendRule(input: HealthInput): { rule: RuleApplication; fallingMonths: number } {
  const periods = trailingPeriodIds(input.periodIds, input.periodId, C3_PERIODS);
  const series = seriesOf(input.snapshots, periods, 'net_cash_movement');
  const known = series.filter((v): v is Decimal => v !== null);

  if (known.length < C3_PERIODS) {
    return {
      rule: skippedRule('C3', 'insufficient_history'),
      fallingMonths: 0,
    };
  }

  const positive = known.filter((v) => v.greaterThan(0)).length;
  const nonPositive = known.filter((v) => v.lessThanOrEqualTo(0)).length;

  if (positive >= C3_POSITIVE_PERIODS) {
    return {
      rule: flatRule('C3', `positive in ${positive} of ${C3_PERIODS}`, C3_POSITIVE_POINTS, String(positive)),
      fallingMonths: 0,
    };
  }
  if (nonPositive === C3_PERIODS) {
    return {
      rule: flatRule('C3', `negative in all ${C3_PERIODS}`, C3_NEGATIVE_POINTS, String(nonPositive)),
      fallingMonths: nonPositive,
    };
  }
  return {
    rule: flatRule('C3', `positive in ${positive} of ${C3_PERIODS}`, 0, String(positive)),
    fallingMonths: 0,
  };
}

export function evaluateCashFlow(input: HealthInput): DimensionEvaluation {
  const { snapshots, periodId, currency } = input;

  const closingCash = metricValue(snapshots, periodId, 'closing_cash');
  const outflows = metricValue(snapshots, periodId, 'cash_outflows');
  const movement = metricValue(snapshots, periodId, 'net_cash_movement');
  const runway = metricValue(snapshots, periodId, 'cash_runway_months');

  const runwayApplication = runwayRule(input);
  const trend = movementTrendRule(input);

  // C4 divides by outflows; a month with no outflows has no ratio to score, and treating it as
  // infinitely healthy would reward an organisation whose statement simply did not arrive.
  const cover = closingCash !== null && outflows !== null && !outflows.abs().isZero()
    ? closingCash.dividedBy(outflows.abs())
    : null;

  const rules: RuleApplication[] = [
    applyRule(R.C1, closingCash),
    runwayApplication,
    trend.rule,
    cover === null ? skippedRule(R.C4.rule, 'no_outflows_to_compare') : applyRule(R.C4, cover),
  ];

  const positives: FactorSentence[] = [];
  const negatives: FactorSentence[] = [];

  if (runway !== null) {
    const text = sentence('runway_months',
      { runway: runway.toDecimalPlaces(1).toString() }, currency,
      [reference(snapshots, periodId, 'cash_runway_months').snapshot_id]);
    if (runwayApplication.points > 0) positives.push(text); else negatives.push(text);
  }
  if (trend.fallingMonths > 0) {
    negatives.push(sentence('cash_fell_months', { n: String(trend.fallingMonths) }, currency,
      [reference(snapshots, periodId, 'net_cash_movement').snapshot_id]));
  } else if (movement !== null && movement.greaterThan(0)) {
    positives.push(sentence('cash_grew', { net_cash_movement: movement.toString() }, currency,
      [reference(snapshots, periodId, 'net_cash_movement').snapshot_id]));
  }

  return {
    key: 'cash_flow',
    rules,
    metrics: [
      reference(snapshots, periodId, 'closing_cash'),
      reference(snapshots, periodId, 'net_cash_movement'),
      reference(snapshots, periodId, 'cash_runway_months'),
      reference(snapshots, periodId, 'cash_outflows'),
    ],
    conditions: [],
    requirements: REQUIREMENTS,
    coverageSatisfied: null,
    positives,
    negatives,
  };
}
