/**
 * Customer quality (FINANCIAL_ENGINE.md §7.3, weight 10).
 *
 * Concentration and collection speed, which are the two ways a profitable business gets into
 * trouble without its profit figure changing: one customer who can leave, and invoices nobody pays.
 *
 * Q3 is skipped rather than scored when `receivables_days` is NULL, because a NULL there usually
 * means the organisation has no invoice data at all — a bank-only business — and "we do not know how
 * fast you get paid" must never be scored as "you get paid slowly".
 *
 * Pure.
 */

import { CUSTOMER_QUALITY_RULES as R } from '../config';
import { applyRule, metricValue, reference, skippedRule } from '../apply';
import { sentence } from '../sentences';
import type { DimensionEvaluation, RequirementGroup } from '../dimension';
import type { FactorSentence, HealthInput, RuleApplication } from '../types';

const REQUIREMENTS: readonly RequirementGroup[] = [
  { keys: ['customer_concentration_top1'] },
];

export function evaluateCustomerQuality(input: HealthInput): DimensionEvaluation {
  const { snapshots, periodId, currency } = input;

  const top1 = metricValue(snapshots, periodId, 'customer_concentration_top1');
  const top5 = metricValue(snapshots, periodId, 'customer_concentration_top5');
  const days = metricValue(snapshots, periodId, 'receivables_days');

  const rules: RuleApplication[] = [
    applyRule(R.Q1, top1),
    top5 === null ? skippedRule(R.Q2.rule, 'no_counterparty_data') : applyRule(R.Q2, top5),
    days === null ? skippedRule(R.Q3.rule, 'no_invoice_data') : applyRule(R.Q3, days),
  ];

  const positives: FactorSentence[] = [];
  const negatives: FactorSentence[] = [];

  if (top1 !== null) {
    const pin = reference(snapshots, periodId, 'customer_concentration_top1').snapshot_id;
    if (rules[0]!.points > 0) {
      positives.push(sentence('no_customer_dominant', { share: top1.toString() }, currency, [pin]));
    } else if (rules[0]!.points < 0) {
      negatives.push(sentence('customer_concentration', { share: top1.toString() }, currency, [pin]));
    }
  }
  if (days !== null && rules[2]!.points < 0) {
    negatives.push(sentence('collections_slow',
      { days: days.toDecimalPlaces(0).toString() }, currency,
      [reference(snapshots, periodId, 'receivables_days').snapshot_id]));
  }

  return {
    key: 'customer_quality',
    rules,
    metrics: [
      reference(snapshots, periodId, 'customer_concentration_top1'),
      reference(snapshots, periodId, 'customer_concentration_top5'),
      reference(snapshots, periodId, 'revenue_concentration_hhi'),
      reference(snapshots, periodId, 'receivables_days'),
    ],
    conditions: [],
    requirements: REQUIREMENTS,
    coverageSatisfied: null,
    positives,
    negatives,
  };
}
