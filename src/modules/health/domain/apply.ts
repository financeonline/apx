/**
 * Applying a banded rule, and reading the series a trailing rule needs (§7.3).
 *
 * One implementation of "which band does this value fall in", used by all fourteen banded rules, so
 * an inclusive bound cannot be inclusive in one rule and exclusive in another. §7.3 has boundaries
 * on both sides — "0.05–0.15" is closed below and open above, "cash > 0" is open — and getting one
 * of them backwards moves a real business into the wrong band without failing anything.
 *
 * Pure.
 */

import { Decimal, toRatioString } from '@/core/money';
import { componentOf, observationOf, usableValue, type MetricObservation } from '@/modules/alerts';
import {
  DIMENSION_MAX, DIMENSION_MIN, type BandedRule, type ScoreBand,
} from './config';
import type { MetricReference, RuleApplication } from './types';

/** The band a value falls in. The final band has `bound: null` and always matches. */
export function bandOf(rule: BandedRule, value: Decimal): ScoreBand {
  for (const band of rule.bands) {
    if (band.bound === null) return band;
    const bound = new Decimal(band.bound);
    const matches = rule.direction === 'higher_is_better'
      ? (band.exclusive === true ? value.greaterThan(bound) : value.greaterThanOrEqualTo(bound))
      : (band.exclusive === true ? value.lessThan(bound) : value.lessThanOrEqualTo(bound));
    if (matches) return band;
  }
  // Unreachable while every rule ends in a `bound: null` band, which a config test asserts. Throwing
  // rather than returning zero points: a rule that scored nothing silently would be invisible.
  throw new Error(`health rule ${rule.rule} has no catch-all band`);
}

/** Apply a banded rule to a value, or record why it was skipped. */
export function applyRule(rule: BandedRule, value: Decimal | null): RuleApplication {
  if (value === null) {
    return { rule: rule.rule, result: 'skipped', points: 0, value: null, skipped_reason: 'value_unavailable' };
  }
  const band = bandOf(rule, value);
  return {
    rule: rule.rule,
    result: band.result,
    points: band.points,
    value: toRatioString(value),
    skipped_reason: null,
  };
}

/** A rule that did not run, for a reason worth showing (§7.2: excluded dimensions say why). */
export function skippedRule(rule: string, reason: string): RuleApplication {
  return { rule, result: 'skipped', points: 0, value: null, skipped_reason: reason };
}

/** A rule outside the banded shape — C3, G2, G3, B1, B4 — stated in the same vocabulary. */
export function flatRule(
  rule: string, result: string, points: number, value: string | null,
): RuleApplication {
  return { rule, result, points, value, skipped_reason: null };
}

/** §7.3: each dimension starts at 50, rules add and subtract, the total is clamped to 0-100. */
export function scoreFromRules(rules: readonly RuleApplication[], baseline: number): number {
  const total = rules.reduce((sum, r) => sum + r.points, baseline);
  return Math.min(DIMENSION_MAX, Math.max(DIMENSION_MIN, total));
}

// ---------------------------------------------------------------------------------------------
// Reading the snapshots
// ---------------------------------------------------------------------------------------------

/** A metric's usable value in a period — NULL when absent, uncomputable or `basis_differs`. */
export function metricValue(
  snapshots: readonly MetricObservation[], periodId: string, metricKey: string,
): Decimal | null {
  return usableValue(observationOf(snapshots, periodId, metricKey));
}

/** A named component of a metric — `pct_change` on a variance, for instance. */
export function metricComponent(
  snapshots: readonly MetricObservation[], periodId: string, metricKey: string, component: string,
): Decimal | null {
  return componentOf(observationOf(snapshots, periodId, metricKey), component);
}

/**
 * The last `count` periods ending at `periodId`, newest last.
 *
 * Returns fewer than `count` when the history is shorter, and the caller decides whether that is
 * enough — G2 needs six and scores nothing without them, C3 needs three. Padding a short history
 * with zeroes would turn a new business into one whose cash fell every month.
 */
export function trailingPeriodIds(
  periodIds: readonly string[], periodId: string, count: number,
): readonly string[] {
  const index = periodIds.indexOf(periodId);
  if (index < 0) return [];
  return periodIds.slice(Math.max(0, index - count + 1), index + 1);
}

/** The values of one metric over a run of periods; a period with no usable value yields NULL. */
export function seriesOf(
  snapshots: readonly MetricObservation[],
  periodIds: readonly string[],
  metricKey: string,
): readonly (Decimal | null)[] {
  return periodIds.map((periodId) => metricValue(snapshots, periodId, metricKey));
}

/** Pin a metric into the breakdown, whether or not it had a value (§7.4). */
export function reference(
  snapshots: readonly MetricObservation[], periodId: string, metricKey: string,
): MetricReference {
  const observation = observationOf(snapshots, periodId, metricKey);
  return {
    metric_key: metricKey,
    value: observation?.value ?? null,
    snapshot_id: observation?.snapshotId ?? null,
  };
}
