/**
 * Cost control (FINANCIAL_ENGINE.md §7.3, weight 15).
 *
 * K3 is the rule R2-B-11 exists for. It counts CONDITIONS — categories where the spike rule's test
 * holds over this run's snapshots — never `alerts` rows. If it counted alerts, dismissing one would
 * raise the score, and the number a business is judged by would move because somebody clicked a
 * button rather than because anything changed. The count comes from the same pure function the alert
 * job calls, behind the same `dataSuppressed` filter (§8.3), so the score and the alert list can
 * never disagree about whether marketing spend spiked.
 *
 * Pure.
 */

import { Decimal } from '@/core/money';
import {
  conditionsFor, dataSuppression, evaluateConditions, type RuleOutcome,
} from '@/modules/alerts';
import { COST_CONTROL_RULES as R } from '../config';
import { applyRule, metricComponent, metricValue, reference, skippedRule } from '../apply';
import { sentence } from '../sentences';
import type { DimensionEvaluation, RequirementGroup } from '../dimension';
import type {
  ConditionReference, FactorSentence, HealthInput, RuleApplication,
} from '../types';

const REQUIREMENTS: readonly RequirementGroup[] = [
  { keys: ['operating_expenses'] },
  { keys: ['revenue'] },
];

const OPEX_VARIANCE_KEY = 'operating_expenses.variance.prev_period';
const REVENUE_VARIANCE_KEY = 'revenue.variance.prev_period';

/** The spike conditions for this period, and the rows behind each one (§7.3, §7.4). */
export function spikeConditions(input: HealthInput): {
  readonly outcomes: readonly RuleOutcome[];
  readonly suppressed: boolean;
  readonly suppressionReason: string | null;
} {
  if (input.conditions === null) {
    return { outcomes: [], suppressed: true, suppressionReason: 'no_record_data' };
  }
  const suppression = dataSuppression('expense.spike_category', input.conditions);
  if (suppression.suppressed) {
    return { outcomes: [], suppressed: true, suppressionReason: suppression.reason };
  }
  const evaluations = evaluateConditions(input.conditions);
  return {
    outcomes: conditionsFor(evaluations, ['expense.spike_category']),
    suppressed: false,
    suppressionReason: null,
  };
}

export function evaluateCostControl(input: HealthInput): DimensionEvaluation {
  const { snapshots, periodId, currency } = input;

  const opex = metricValue(snapshots, periodId, 'operating_expenses');
  const revenue = metricValue(snapshots, periodId, 'revenue');

  // K1 is a ratio of costs to revenue; without revenue there is no ratio, and a business with no
  // sales this month is not a business whose costs are infinitely out of control.
  const opexRatio = opex !== null && revenue !== null && revenue.greaterThan(0)
    ? opex.abs().dividedBy(revenue)
    : null;

  const opexGrowth = metricComponent(snapshots, periodId, OPEX_VARIANCE_KEY, 'pct_change');
  const revenueGrowth = metricComponent(snapshots, periodId, REVENUE_VARIANCE_KEY, 'pct_change');
  const growthGap = opexGrowth !== null && revenueGrowth !== null
    ? opexGrowth.minus(revenueGrowth)
    : null;

  const spikes = spikeConditions(input);
  const k3 = spikes.suppressed
    ? skippedRule(R.K3.rule, spikes.suppressionReason ?? 'suppressed')
    : applyRule(R.K3, new Decimal(spikes.outcomes.length));

  const rules: RuleApplication[] = [
    opexRatio === null ? skippedRule(R.K1.rule, 'no_revenue_to_compare') : applyRule(R.K1, opexRatio),
    growthGap === null ? skippedRule(R.K2.rule, 'no_comparable_prior_period') : applyRule(R.K2, growthGap),
    k3,
  ];

  const conditions: readonly ConditionReference[] = spikes.outcomes.map((outcome) => ({
    rule_key: outcome.ruleKey,
    subject_id: outcome.subject.id,
    subject_key: outcome.subject.key,
    snapshot_ids: outcome.snapshotIds,
    record_ids: outcome.recordIds,
  }));

  const positives: FactorSentence[] = [];
  const negatives: FactorSentence[] = [];

  if (rules[1]!.points > 0) {
    positives.push(sentence('costs_grew_slower', {}, currency,
      [reference(snapshots, periodId, OPEX_VARIANCE_KEY).snapshot_id]));
  }
  for (const outcome of spikes.outcomes) {
    const pct = outcome.thresholdSummary.pct_change;
    const category = outcome.thresholdSummary.category;
    if (pct === null || pct === undefined || category === null || category === undefined) continue;
    negatives.push(sentence('category_spend_jumped', { category, pct }, currency,
      outcome.snapshotIds));
  }

  return {
    key: 'cost_control',
    rules,
    metrics: [
      reference(snapshots, periodId, 'operating_expenses'),
      reference(snapshots, periodId, 'revenue'),
      reference(snapshots, periodId, OPEX_VARIANCE_KEY),
      reference(snapshots, periodId, REVENUE_VARIANCE_KEY),
    ],
    conditions,
    requirements: REQUIREMENTS,
    coverageSatisfied: null,
    positives,
    negatives,
  };
}
