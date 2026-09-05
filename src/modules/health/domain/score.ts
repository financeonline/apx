/**
 * Assembling the score (FINANCIAL_ENGINE.md §7.2).
 *
 * Four decisions live here, and each one is about refusing to publish a number rather than about
 * computing one:
 *
 *   - **The gate.** No score at all for an incomplete period (ADR-030.4). A month with a week of
 *     data would score as a month with no sales.
 *   - **Exclusion.** A dimension whose required metrics are missing or thin is left OUT and says so,
 *     rather than scoring 50 and pretending the middle is a finding.
 *   - **The cap.** A dimension resting on bank-proxy figures is capped at 70 (ADR-035), so a
 *     bank-only organisation gets a real score that cannot claim more certainty than a statement
 *     carries.
 *   - **Renormalisation.** The surviving weights scale to 100, and the score says "based on 4 of 6".
 *
 * The stored breakdown is AUTHORITATIVE: the overall score is computed from the same rounded
 * `weight_applied` values that are written to the row, so the reproduction test in TEST_STRATEGY.md
 * §7 — re-derive the score from the breakdown JSON alone — is exact rather than approximate. A panel
 * that explains a number to one decimal place away from the number is a panel nobody trusts twice.
 *
 * Pure.
 */

import { Decimal, ROUND_HALF_UP } from '@/core/money';
import {
  DIMENSION_BASELINE, DIMENSION_WEIGHTS, HEALTH_CONFIG_VERSION, HEALTH_DIMENSION_KEYS,
  MIN_DIMENSIONS_FOR_SCORE, MIN_REQUIRED_COMPLETENESS, PROXY_CAP, PROXY_CAP_NOTE, bandFor,
} from './config';
import { scoreFromRules } from './apply';
import { testRequirements, type DimensionEvaluation } from './dimension';
import { evaluateProfitability } from './rules/profitability';
import { evaluateCashFlow } from './rules/cash-flow';
import { evaluateRevenueGrowth } from './rules/revenue-growth';
import { evaluateCostControl } from './rules/cost-control';
import { evaluateCustomerQuality } from './rules/customer-quality';
import { evaluateBankingHealth } from './rules/banking-health';
import type {
  DimensionBreakdown, ExclusionReason, HealthInput, HealthScore,
} from './types';
import type { DataQualityWarning } from '@/modules/financial-engine';

/** Fixed order, so two runs over identical data write byte-identical breakdowns. */
const EVALUATORS: ReadonlyArray<(input: HealthInput) => DimensionEvaluation> = [
  evaluateProfitability,
  evaluateCashFlow,
  evaluateRevenueGrowth,
  evaluateCostControl,
  evaluateCustomerQuality,
  evaluateBankingHealth,
];

interface Assessed {
  readonly evaluation: DimensionEvaluation;
  readonly included: boolean;
  readonly exclusionReason: ExclusionReason | null;
  readonly rawScore: number;
  readonly capped: boolean;
  readonly completeness: number;
  readonly warnings: readonly DataQualityWarning[];
}

function assess(input: HealthInput, evaluation: DimensionEvaluation): Assessed {
  const verdict = testRequirements(input.snapshots, input.periodId, evaluation.requirements);

  // banking_health's requirement is coverage, not a metric (§7.1).
  if (evaluation.coverageSatisfied === false) {
    return {
      evaluation, included: false, exclusionReason: 'no_bank_coverage',
      rawScore: DIMENSION_BASELINE, capped: false, completeness: 0, warnings: [],
    };
  }

  if (!verdict.satisfied) {
    return {
      evaluation, included: false, exclusionReason: 'required_metric_missing',
      rawScore: DIMENSION_BASELINE, capped: false,
      completeness: verdict.minCompleteness,
      warnings: verdict.warnings as readonly DataQualityWarning[],
    };
  }

  if (verdict.minCompleteness < MIN_REQUIRED_COMPLETENESS) {
    return {
      evaluation, included: false, exclusionReason: 'insufficient_completeness',
      rawScore: DIMENSION_BASELINE, capped: false,
      completeness: verdict.minCompleteness,
      warnings: verdict.warnings as readonly DataQualityWarning[],
    };
  }

  const scored = scoreFromRules(evaluation.rules, DIMENSION_BASELINE);
  const capped = verdict.proxy && scored > PROXY_CAP;

  return {
    evaluation,
    included: true,
    exclusionReason: null,
    rawScore: capped ? PROXY_CAP : scored,
    capped: verdict.proxy,
    completeness: verdict.minCompleteness,
    warnings: verdict.warnings as readonly DataQualityWarning[],
  };
}

/**
 * The whole score for one period, or NULL when the period is incomplete.
 *
 * NULL here means "do not write a row", which is what ADR-030.4 requires; a score of NULL INSIDE a
 * returned object means something different — the period was scoreable but fewer than three
 * dimensions survived, and Home says "Not enough data yet".
 */
export function computeHealthScore(input: HealthInput): HealthScore | null {
  if (!input.isComplete) return null;

  const assessed = EVALUATORS.map((evaluate) => assess(input, evaluate(input)));
  const included = assessed.filter((a) => a.included);

  const totalWeight = included.reduce(
    (total, a) => total.plus(DIMENSION_WEIGHTS[a.evaluation.key]), new Decimal(0),
  );

  // Renormalised weights, rounded once, to 1 dp — the same values the row stores.
  const applied = new Map<string, Decimal>();
  for (const a of included) {
    const weight = new Decimal(DIMENSION_WEIGHTS[a.evaluation.key]);
    applied.set(
      a.evaluation.key,
      totalWeight.isZero()
        ? new Decimal(0)
        : weight.dividedBy(totalWeight).times(100).toDecimalPlaces(1, ROUND_HALF_UP),
    );
  }

  const appliedTotal = [...applied.values()].reduce((t, w) => t.plus(w), new Decimal(0));

  let score: number | null = null;
  if (included.length >= MIN_DIMENSIONS_FOR_SCORE && appliedTotal.greaterThan(0)) {
    const weighted = included.reduce(
      (total, a) => total.plus(new Decimal(a.rawScore).times(applied.get(a.evaluation.key)!)),
      new Decimal(0),
    );
    score = weighted.dividedBy(appliedTotal).toDecimalPlaces(0, ROUND_HALF_UP).toNumber();
  }

  const breakdown: DimensionBreakdown[] = assessed.map((a) => ({
    key: a.evaluation.key,
    score: a.included ? a.rawScore : null,
    weight_config: DIMENSION_WEIGHTS[a.evaluation.key],
    weight_applied: (applied.get(a.evaluation.key) ?? new Decimal(0)).toNumber(),
    included: a.included,
    exclusion_reason: a.exclusionReason,
    metrics: a.evaluation.metrics,
    rules: a.evaluation.rules,
    conditions: a.evaluation.conditions,
    capped: a.capped,
    cap_reason: a.capped ? PROXY_CAP_NOTE : null,
    positives: a.evaluation.positives.map((p) => p.text),
    negatives: a.evaluation.negatives.map((n) => n.text),
    positives_structured: a.evaluation.positives,
    negatives_structured: a.evaluation.negatives,
    data_quality: { completeness: a.completeness, warnings: a.warnings },
  }));

  return {
    organizationId: input.organizationId,
    periodId: input.periodId,
    score,
    band: bandFor(score),
    dimensionsUsed: included.length,
    dimensionsTotal: HEALTH_DIMENSION_KEYS.length,
    configVersion: HEALTH_CONFIG_VERSION,
    breakdown,
    capped: included.some((a) => a.capped),
  };
}

/**
 * Re-derive the overall score from a stored breakdown alone.
 *
 * This is the explainability guarantee expressed as code (TEST_STRATEGY.md §7): if the panel shows
 * the dimensions, their weights and their rules, a reader with a calculator must reach the number on
 * the card. The test asserts this equals the stored `score` for every fixture and every golden org.
 */
export function scoreFromBreakdown(breakdown: readonly DimensionBreakdown[]): number | null {
  const included = breakdown.filter((d) => d.included && d.score !== null);
  if (included.length < MIN_DIMENSIONS_FOR_SCORE) return null;

  const appliedTotal = included.reduce(
    (total, d) => total.plus(d.weight_applied), new Decimal(0),
  );
  if (appliedTotal.isZero()) return null;

  const weighted = included.reduce(
    (total, d) => total.plus(new Decimal(d.score!).times(d.weight_applied)), new Decimal(0),
  );
  return weighted.dividedBy(appliedTotal).toDecimalPlaces(0, ROUND_HALF_UP).toNumber();
}

/**
 * Re-derive one dimension's score from its stored rules alone: baseline plus points, clamped, then
 * capped. Proves the explainability panel's arithmetic adds up to the dimension figure beside it.
 */
export function dimensionScoreFromRules(dimension: DimensionBreakdown): number {
  const scored = scoreFromRules(dimension.rules, DIMENSION_BASELINE);
  return dimension.capped && scored > PROXY_CAP ? PROXY_CAP : scored;
}
