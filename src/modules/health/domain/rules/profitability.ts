/**
 * Profitability (FINANCIAL_ENGINE.md §7.3, weight 25).
 *
 * The one substitution in §7.1 lives here: an organisation with no cost-of-sales accounts has no
 * gross margin to read — not a gross margin of zero — so the level rule reads operating margin
 * instead. Scoring a missing gross margin as 0 would put every service business that never coded a
 * cost of sale into the worst band of P2, which is a statement about their chart of accounts rather
 * than about their profitability.
 *
 * Pure.
 */

import { observationOf, type MetricObservation } from '@/modules/alerts';
import { PROFITABILITY_RULES as R } from '../config';
import { applyRule, metricComponent, metricValue, reference, skippedRule } from '../apply';
import { sentence } from '../sentences';
import type { DimensionEvaluation, RequirementGroup } from '../dimension';
import type { FactorSentence, HealthInput, RuleApplication } from '../types';

const TRAILING_MARGIN_KEY = 'gross_margin.variance.trailing_3m_avg';
const PROFIT_MOMENTUM_KEY = 'net_profit.variance.prev_period';

/**
 * True when the organisation has no cost-of-sales accounts at all (§7.1).
 *
 * Read from the engine's own reason for the NULL rather than re-derived from the chart of accounts:
 * the engine already decided, and a second derivation could disagree with the figure on screen.
 */
export function hasNoCostOfSales(
  snapshots: readonly MetricObservation[], periodId: string,
): boolean {
  const observation = observationOf(snapshots, periodId, 'gross_margin');
  return observation !== undefined
    && observation.dataQuality.missing.includes('no_cost_of_sales_accounts');
}

export function evaluateProfitability(input: HealthInput): DimensionEvaluation {
  const { snapshots, periodId, currency } = input;
  const noCostOfSales = hasNoCostOfSales(snapshots, periodId);
  const marginKey = noCostOfSales ? 'operating_margin' : 'gross_margin';

  const requirements: readonly RequirementGroup[] = [
    { keys: ['net_margin'] },
    { keys: [marginKey] },
  ];

  const netMargin = metricValue(snapshots, periodId, 'net_margin');
  const margin = metricValue(snapshots, periodId, marginKey);
  const marginTrend = metricValue(snapshots, periodId, TRAILING_MARGIN_KEY);
  const momentum = metricComponent(snapshots, periodId, PROFIT_MOMENTUM_KEY, 'pct_change');
  const netProfit = metricValue(snapshots, periodId, 'net_profit');

  const rules: RuleApplication[] = [
    applyRule(R.P1, netMargin),
    applyRule(R.P2, margin),
    // P3 and P4 read variances, and `metricValue`/`metricComponent` already return NULL for one
    // carrying `basis_differs` (§7.2). A skipped rule scores nothing rather than scoring zero.
    marginTrend === null
      ? skippedRule(R.P3.rule, 'no_comparable_trend') : applyRule(R.P3, marginTrend),
    momentum === null
      ? skippedRule(R.P4.rule, 'no_comparable_prior_period') : applyRule(R.P4, momentum),
  ];

  const positives: FactorSentence[] = [];
  const negatives: FactorSentence[] = [];

  const netMarginRef = reference(snapshots, periodId, 'net_margin');
  if (netMargin !== null && rules[0]!.points > 0) {
    positives.push(sentence('net_margin_healthy', { net_margin: netMargin.toString() }, currency,
      [netMarginRef.snapshot_id]));
  }
  if (netProfit !== null && netProfit.isNegative()) {
    // The magnitude, not the signed figure: the sentence already says "a loss of", and the typed
    // value must match what the reader sees (ADR-032.1) or the AI's allowed set disagrees with it.
    negatives.push(sentence('made_a_loss', { net_profit: netProfit.abs().toString() }, currency,
      [reference(snapshots, periodId, 'net_profit').snapshot_id]));
  }
  if (marginTrend !== null) {
    const trendRef = reference(snapshots, periodId, TRAILING_MARGIN_KEY);
    if (rules[2]!.points > 0) {
      positives.push(sentence('gross_margin_improved', { delta: marginTrend.toString() },
        currency, [trendRef.snapshot_id]));
    } else if (rules[2]!.points < 0) {
      negatives.push(sentence('gross_margin_fell', { delta: marginTrend.toString() },
        currency, [trendRef.snapshot_id]));
    }
  }

  return {
    key: 'profitability',
    rules,
    metrics: [
      netMarginRef,
      reference(snapshots, periodId, marginKey),
      reference(snapshots, periodId, TRAILING_MARGIN_KEY),
      reference(snapshots, periodId, PROFIT_MOMENTUM_KEY),
      reference(snapshots, periodId, 'net_profit'),
    ],
    conditions: [],
    requirements,
    coverageSatisfied: null,
    positives,
    negatives,
  };
}
