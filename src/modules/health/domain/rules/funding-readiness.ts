/**
 * Funding readiness, the Health dimension (health.config.v5, weight 8; ADR-147, REQ-BH-10).
 *
 * Only the Funding Readiness signals no other dimension already scores (ADR-119's double-counting
 * question): what the business owes and which way it moved (R1, R2 — Funding Readiness F4), how much
 * of what customers and suppliers are owed is overdue (R3, R4 — F5.2, F5.3), and how many of the last
 * six months have complete figures (R5 — F6.1). Every rule reads the figures, the population and the
 * thresholds the standalone assessment reads, so the two never disagree about a fact.
 *
 * Required: any ONE of debt, receivables or payables. A business with none of the three established
 * is excluded, never scored as owing nothing.
 *
 * Pure.
 */

import { Decimal, toRatioString } from '@/core/money';
import { observationOf, usableValue, type MetricObservation } from '@/modules/alerts';
import { invoiceOutstandingAt } from '@/modules/financial-engine';
import {
  FUNDING_READINESS_RULES as R, R1_NO_DEBT_POINTS, R1_NO_PROFIT_POINTS, R1_PERIODS, R2_NEW_DEBT_POINTS, R2_OFFSET,
  R5_ALL_POINTS, R5_FEW_POINTS, R5_MOST_POINTS, R5_PERIODS, R_NOTHING_OUTSTANDING_POINTS,
} from '../config';
import { applyRule, flatRule, metricValue, reference, skippedRule } from '../apply';
import { sentence } from '../sentences';
import type { DimensionEvaluation, RequirementGroup } from '../dimension';
import type { FactorSentence, HealthInput, MetricReference, RuleApplication } from '../types';

const REQUIREMENTS: readonly RequirementGroup[] = [
  { keys: ['debt_balance', 'receivables', 'payables'] },
];

/** Funding Readiness §4.10: revenue and operating profit usable, a basis, not a partial month. */
function pnlComplete(snapshots: readonly MetricObservation[], periodId: string): boolean {
  for (const key of ['revenue', 'operating_profit']) {
    const o = observationOf(snapshots, periodId, key);
    if (o === undefined || usableValue(o) === null) return false;
    if (o.basis === 'none' || o.dataQuality.warnings.includes('partial_month')) return false;
  }
  return true;
}

/** The period `offset` months before P in the loaded window, or NULL before the window starts. */
function offset(periodIds: readonly string[], periodId: string, by: number): string | null {
  const index = periodIds.indexOf(periodId);
  return index - by >= 0 ? periodIds[index - by] ?? null : null;
}

/** F5.2/F5.3's population: gross open invoices on one side and their overdue part, credits apart. */
function overdueShare(input: HealthInput, side: 'sales' | 'purchase', asOf: string): { open: Decimal; overdue: Decimal } {
  let open = new Decimal(0);
  let overdue = new Decimal(0);
  for (const invoice of input.invoices ?? []) {
    if (invoice.invoiceType !== side || invoice.issueDate > asOf) continue;
    const outstanding = invoiceOutstandingAt(invoice, asOf);
    if (!outstanding.greaterThan(0)) continue;
    open = open.plus(outstanding);
    if (invoice.dueDate !== null && invoice.dueDate < asOf) overdue = overdue.plus(outstanding);
  }
  return { open, overdue };
}

function shareRule(
  input: HealthInput, rule: typeof R.R3 | typeof R.R4, side: 'sales' | 'purchase', totalKey: string, overdueKey: string,
): { application: RuleApplication; share: Decimal | null } {
  const { snapshots, periodId } = input;
  if (metricValue(snapshots, periodId, totalKey) === null) return { application: skippedRule(rule.rule, 'value_unavailable'), share: null };
  const overdueObs = observationOf(snapshots, periodId, overdueKey);
  if (usableValue(overdueObs) === null || input.invoices === undefined) {
    return { application: skippedRule(rule.rule, 'aging_unavailable'), share: null };
  }
  const asOf = typeof overdueObs?.components.as_of === 'string'
    ? overdueObs.components.as_of
    : input.periodEnds?.get(periodId) ?? null;
  if (asOf === null) return { application: skippedRule(rule.rule, 'aging_unavailable'), share: null };
  const population = overdueShare(input, side, asOf);
  if (!population.open.greaterThan(0)) {
    return { application: flatRule(rule.rule, 'nothing_outstanding', R_NOTHING_OUTSTANDING_POINTS, '0'), share: null };
  }
  const share = Decimal.min(population.overdue.dividedBy(population.open), new Decimal(1));
  return { application: applyRule(rule, share), share };
}

export function evaluateFundingReadiness(input: HealthInput): DimensionEvaluation {
  const { snapshots, periodId, periodIds, currency } = input;
  const positives: FactorSentence[] = [];
  const negatives: FactorSentence[] = [];
  const metrics: MetricReference[] = [
    reference(snapshots, periodId, 'debt_balance'),
    reference(snapshots, periodId, 'receivables'),
    reference(snapshots, periodId, 'receivables_overdue'),
    reference(snapshots, periodId, 'payables'),
    reference(snapshots, periodId, 'payables_overdue'),
  ];
  const scoredInputs: Array<{ periodId: string; metricKey: string }> = [];
  const debtPin = reference(snapshots, periodId, 'debt_balance').snapshot_id;

  // R1 / R2 — what is owed (F4). Unknown debt is skipped, never "no debt".
  const debt = metricValue(snapshots, periodId, 'debt_balance');
  let r1: RuleApplication;
  let r2: RuleApplication;
  if (debt === null) {
    r1 = skippedRule(R.R1.rule, 'value_unavailable');
    r2 = skippedRule(R.R2.rule, 'value_unavailable');
  } else {
    scoredInputs.push({ periodId, metricKey: 'debt_balance' });
    const window = Array.from({ length: R1_PERIODS }, (_, i) => offset(periodIds, periodId, R1_PERIODS - 1 - i));
    let capacity: Decimal | null = null;
    if (window.every((p) => p !== null && pnlComplete(snapshots, p))) {
      capacity = window.reduce((sum, p) => sum.plus(metricValue(snapshots, p!, 'operating_profit')!), new Decimal(0));
      for (const p of window) scoredInputs.push({ periodId: p!, metricKey: 'operating_profit' });
    }
    if (!debt.greaterThan(0)) {
      r1 = flatRule(R.R1.rule, 'no_debt', R1_NO_DEBT_POINTS, toRatioString(debt));
      positives.push(sentence('no_debt', {}, currency, [debtPin]));
    } else if (capacity === null) {
      r1 = skippedRule(R.R1.rule, 'capacity_unavailable');
    } else if (!capacity.greaterThan(0)) {
      r1 = flatRule(R.R1.rule, 'no_operating_profit', R1_NO_PROFIT_POINTS, null);
    } else {
      const multiple = debt.dividedBy(capacity);
      r1 = applyRule(R.R1, multiple);
      const shown = { multiple: multiple.toDecimalPlaces(1).toString() };
      if (r1.points > 0) positives.push(sentence('debt_light', shown, currency, [debtPin]));
      else if (r1.points < 0) negatives.push(sentence('debt_heavy', shown, currency, [debtPin]));
    }

    const priorPeriod = offset(periodIds, periodId, R2_OFFSET);
    const prior = priorPeriod === null ? null : metricValue(snapshots, priorPeriod, 'debt_balance');
    if (priorPeriod !== null) metrics.push(reference(snapshots, priorPeriod, 'debt_balance'));
    if (prior === null) {
      r2 = skippedRule(R.R2.rule, 'no_prior_debt');
    } else {
      scoredInputs.push({ periodId: priorPeriod!, metricKey: 'debt_balance' });
      if (!prior.greaterThan(0)) {
        r2 = debt.greaterThan(0) ? flatRule(R.R2.rule, 'new_debt', R2_NEW_DEBT_POINTS, null) : flatRule(R.R2.rule, 'none either side', 0, null);
      } else {
        const change = debt.minus(prior).dividedBy(prior);
        r2 = applyRule(R.R2, change);
        if (r2.points > 0) positives.push(sentence('debt_fell', { pct: change.abs().toString() }, currency, [debtPin]));
        else if (r2.points < 0) negatives.push(sentence('debt_rose', { pct: change.abs().toString() }, currency, [debtPin]));
      }
    }
  }

  // R3 / R4 — the overdue shares (F5.2 / F5.3), from the same gross invoice population.
  const r3 = shareRule(input, R.R3, 'sales', 'receivables', 'receivables_overdue');
  const r4 = shareRule(input, R.R4, 'purchase', 'payables', 'payables_overdue');
  if (r3.share !== null) {
    scoredInputs.push({ periodId, metricKey: 'receivables' });
    if (r3.application.points < 0) {
      negatives.push(sentence('receivables_overdue_high', { share: r3.share.toString() }, currency,
        [reference(snapshots, periodId, 'receivables_overdue').snapshot_id]));
    }
  }
  if (r4.share !== null) {
    scoredInputs.push({ periodId, metricKey: 'payables' });
    if (r4.application.points < 0) {
      negatives.push(sentence('payables_overdue_high', { share: r4.share.toString() }, currency,
        [reference(snapshots, periodId, 'payables_overdue').snapshot_id]));
    }
  }

  // R5 — continuity (F6.1): complete months among the last six, P included.
  let r5: RuleApplication;
  if (!pnlComplete(snapshots, periodId)) {
    r5 = skippedRule('R5', 'value_unavailable');
  } else {
    const months = Array.from({ length: R5_PERIODS }, (_, i) => offset(periodIds, periodId, R5_PERIODS - 1 - i));
    const count = months.filter((p) => p !== null && pnlComplete(snapshots, p)).length;
    r5 = count === R5_PERIODS ? flatRule('R5', '6', R5_ALL_POINTS, '6')
      : count >= 4 ? flatRule('R5', '4-5', R5_MOST_POINTS, String(count))
        : flatRule('R5', '1-3', R5_FEW_POINTS, String(count));
    if (r5.points > 0) positives.push(sentence('figures_complete', {}, currency));
    else if (r5.points < 0) negatives.push(sentence('figures_gaps', { months: String(count) }, currency));
  }

  return {
    key: 'funding_readiness',
    rules: [r1, r2, r3.application, r4.application, r5],
    metrics,
    conditions: [],
    requirements: REQUIREMENTS,
    coverageSatisfied: null,
    scoredInputs,
    positives,
    negatives,
  };
}
