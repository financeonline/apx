/**
 * What a dimension hands back, and the requirement test §7.2 applies to it uniformly.
 *
 * Exclusion and capping are decided in ONE place rather than inside each dimension, because they are
 * the two rules that decide whether a number is shown at all. "Excluded because a required metric is
 * missing" and "capped at 70 because the figures are a bank proxy" must mean the same thing in
 * profitability as in cost control, or "based on 4 of 6 areas" stops being a statement anyone can
 * check.
 *
 * Pure.
 */

import { observationOf, usableValue, type MetricObservation } from '@/modules/alerts';
import type {
  ConditionReference, FactorSentence, MetricReference, RuleApplication,
} from './types';
import type { HealthDimensionKey } from './config';

/**
 * A required input, as an OR of metric keys.
 *
 * Most requirements are one key. Two are not: revenue growth accepts the year-on-year figure OR the
 * month-on-month one, and profitability accepts gross margin OR — for an organisation with no
 * cost-of-sales accounts — operating margin. Modelling that as a group rather than as a special case
 * inside the exclusion test keeps "which metrics did this rest on" answerable from the config.
 */
export interface RequirementGroup {
  readonly keys: readonly string[];
}

export interface DimensionEvaluation {
  readonly key: HealthDimensionKey;
  readonly rules: readonly RuleApplication[];
  readonly metrics: readonly MetricReference[];
  readonly conditions: readonly ConditionReference[];
  readonly requirements: readonly RequirementGroup[];
  /**
   * For `banking_health`, whose requirement is "any bank coverage for P" rather than a metric
   * (§7.1). NULL for every other dimension, which is requirement-tested on metrics alone.
   */
  readonly coverageSatisfied: boolean | null;
  /**
   * H-3: every figure the dimension's rules actually SCORED — earlier months a trend rule read
   * included. The ADR-134 / ADR-035 cap looks at these as well as at the required metrics, so a score
   * resting on an AI-read or estimated figure is capped whichever rule read it.
   */
  readonly scoredInputs?: ReadonlyArray<{ readonly periodId: string; readonly metricKey: string }>;
  readonly positives: readonly FactorSentence[];
  readonly negatives: readonly FactorSentence[];
}

/** The observation that satisfies a requirement group, or `undefined` when none does. */
export function satisfyingObservation(
  snapshots: readonly MetricObservation[],
  periodId: string,
  group: RequirementGroup,
): MetricObservation | undefined {
  for (const key of group.keys) {
    const observation = observationOf(snapshots, periodId, key);
    if (observation !== undefined && usableValue(observation) !== null) return observation;
  }
  return undefined;
}

export interface RequirementVerdict {
  /** Every requirement group is satisfied. */
  readonly satisfied: boolean;
  /** The lowest completeness across the satisfying observations; 0 when a group is unsatisfied. */
  readonly minCompleteness: number;
  /** Any satisfying observation is `estimated` or carries `proxy: true` (§7.2, ADR-035). */
  readonly proxy: boolean;
  /**
   * ADR-134: any satisfying observation is `inferred` — read from a document by AI. Weaker than
   * `estimated` on the assurance ladder, so it takes the same cap, never less.
   */
  readonly inferred: boolean;
  /** The warnings carried by the satisfying observations, deduplicated, in first-seen order. */
  readonly warnings: readonly string[];
}

export function testRequirements(
  snapshots: readonly MetricObservation[],
  periodId: string,
  requirements: readonly RequirementGroup[],
): RequirementVerdict {
  let satisfied = true;
  let minCompleteness = 1;
  let proxy = false;
  let inferred = false;
  const warnings: string[] = [];

  for (const group of requirements) {
    const observation = satisfyingObservation(snapshots, periodId, group);
    if (observation === undefined) {
      satisfied = false;
      minCompleteness = 0;
      continue;
    }
    minCompleteness = Math.min(minCompleteness, observation.dataQuality.completeness);
    if (observation.assurance === 'estimated' || observation.dataQuality.proxy) proxy = true;
    if (observation.assurance === 'inferred') inferred = true;
    for (const warning of observation.dataQuality.warnings) {
      if (!warnings.includes(warning)) warnings.push(warning);
    }
  }

  // A dimension with no metric requirements (banking_health) is vacuously satisfied on metrics; its
  // coverage test is applied separately.
  if (requirements.length === 0) minCompleteness = 1;

  return { satisfied, minCompleteness, proxy, inferred, warnings };
}
