/**
 * Revenue growth (FINANCIAL_ENGINE.md §7.3, weight 15).
 *
 * G1 prefers the year-on-year figure and falls back to month-on-month, because for a seasonal
 * business — most of them — December against November says almost nothing and December against last
 * December says almost everything. The fallback exists only so a business with less than a year of
 * history is scored at all.
 *
 * Pure.
 */

import { Decimal } from '@/core/money';
import {
  G2_HIGH_CV, G2_HIGH_POINTS, G2_LOW_CV, G2_LOW_POINTS, G2_PERIODS,
  G3_POINTS, G3_TOP1_THRESHOLD, REVENUE_GROWTH_RULES as R,
} from '../config';
import {
  applyRule, flatRule, metricValue, reference, seriesOf, skippedRule, trailingPeriodIds,
} from '../apply';
import { sentence } from '../sentences';
import type { DimensionEvaluation, RequirementGroup } from '../dimension';
import type { FactorSentence, HealthInput, RuleApplication } from '../types';

const REQUIREMENTS: readonly RequirementGroup[] = [
  { keys: ['revenue'] },
  // §7.1: either growth figure satisfies the requirement; G1 prefers the first that has a value.
  { keys: ['revenue_growth_yoy', 'revenue_growth_mom'] },
];

/**
 * The coefficient of variation of a series: population standard deviation over the mean.
 *
 * POPULATION rather than sample, because the six months are the whole of what is being described —
 * the question is "how much did this business's revenue vary over these six months", not "what is
 * the variance of the process that generated them" (ADR-054.5). A non-positive mean yields NULL:
 * a ratio against zero or negative revenue is not a volatility measure.
 */
export function coefficientOfVariation(values: readonly Decimal[]): Decimal | null {
  if (values.length === 0) return null;
  const count = new Decimal(values.length);
  const mean = values.reduce((total, v) => total.plus(v), new Decimal(0)).dividedBy(count);
  if (mean.lessThanOrEqualTo(0)) return null;
  const variance = values
    .reduce((total, v) => total.plus(v.minus(mean).pow(2)), new Decimal(0))
    .dividedBy(count);
  return variance.sqrt().dividedBy(mean);
}

export function evaluateRevenueGrowth(input: HealthInput): DimensionEvaluation {
  const { snapshots, periodId, currency } = input;

  const yoy = metricValue(snapshots, periodId, 'revenue_growth_yoy');
  const mom = metricValue(snapshots, periodId, 'revenue_growth_mom');
  const growth = yoy ?? mom;
  const growthKey = yoy !== null ? 'revenue_growth_yoy' : 'revenue_growth_mom';
  const comparison = yoy !== null ? 'the same month last year' : 'last month';

  // G2 needs six periods (§7.3). Fewer is a young business, not a stable one; scoring it as stable
  // would flatter every organisation in its first half-year.
  const g2Periods = trailingPeriodIds(input.periodIds, periodId, G2_PERIODS);
  const revenueSeries = seriesOf(snapshots, g2Periods, 'revenue');
  const knownRevenue = revenueSeries.filter((v): v is Decimal => v !== null);
  const cv = knownRevenue.length === G2_PERIODS ? coefficientOfVariation(knownRevenue) : null;

  let g2: RuleApplication;
  if (cv === null) {
    g2 = skippedRule('G2', knownRevenue.length === G2_PERIODS ? 'revenue_not_positive' : 'insufficient_history');
  } else if (cv.lessThanOrEqualTo(new Decimal(G2_LOW_CV))) {
    g2 = flatRule('G2', `<= ${G2_LOW_CV}`, G2_LOW_POINTS, cv.toDecimalPlaces(6).toString());
  } else if (cv.greaterThanOrEqualTo(new Decimal(G2_HIGH_CV))) {
    g2 = flatRule('G2', `>= ${G2_HIGH_CV}`, G2_HIGH_POINTS, cv.toDecimalPlaces(6).toString());
  } else {
    g2 = flatRule('G2', `${G2_LOW_CV} to ${G2_HIGH_CV}`, 0, cv.toDecimalPlaces(6).toString());
  }

  const top1 = metricValue(snapshots, periodId, 'customer_concentration_top1');
  const g3 = top1 === null
    ? skippedRule('G3', 'no_counterparty_data')
    : top1.greaterThanOrEqualTo(new Decimal(G3_TOP1_THRESHOLD))
      ? flatRule('G3', `>= ${G3_TOP1_THRESHOLD}`, G3_POINTS, top1.toString())
      : flatRule('G3', `< ${G3_TOP1_THRESHOLD}`, 0, top1.toString());

  const rules: RuleApplication[] = [
    growth === null ? skippedRule(R.G1.rule, 'no_comparable_period') : applyRule(R.G1, growth),
    g2,
    g3,
  ];

  const positives: FactorSentence[] = [];
  const negatives: FactorSentence[] = [];

  if (growth !== null) {
    const pin = reference(snapshots, periodId, growthKey).snapshot_id;
    if (rules[0]!.points > 0) {
      positives.push(sentence('revenue_up_yoy',
        { pct: growth.toString(), comparison }, currency, [pin]));
    } else if (rules[0]!.points < 0) {
      negatives.push(sentence('revenue_down',
        { pct: growth.abs().toString(), comparison }, currency, [pin]));
    }
  }
  if (g2.points < 0) {
    negatives.push(sentence('revenue_volatile', {}, currency,
      [reference(snapshots, periodId, 'revenue').snapshot_id]));
  }

  return {
    key: 'revenue_growth',
    rules,
    metrics: [
      reference(snapshots, periodId, 'revenue'),
      reference(snapshots, periodId, growthKey),
      reference(snapshots, periodId, 'customer_concentration_top1'),
    ],
    conditions: [],
    requirements: REQUIREMENTS,
    coverageSatisfied: null,
    positives,
    negatives,
  };
}
