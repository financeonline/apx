/**
 * The context a condition rule reads, and the lens it reads through (§8.3).
 *
 * The lens exists because "read a metric" is not a lookup. A snapshot may be present and still not
 * usable: a variance carrying `basis_differs` compares a trial balance against a bank statement and
 * can move a figure by tens of thousands without a penny changing hands, so §7.2 and ADR-030.3
 * require every consumer to treat it AS NULL. Written once here, that rule cannot be forgotten by
 * one rule out of seventeen — which is exactly how a dashboard comes to fire an alert nobody can
 * explain.
 *
 * Pure.
 */

import { Decimal, tryParseDecimal } from '@/core/money';
import type { MetricObservation, RecordObservation } from './types';

/** A recurring group as the recurring rules see it (a subset of `banking`'s `RecurringGroup`). */
export interface RecurringGroupObservation {
  readonly id: string | null;
  readonly groupKey: string;
  readonly direction: 'inflow' | 'outflow';
  readonly signature: string;
  readonly status: 'active' | 'changed' | 'stopped';
  readonly occurrences: number;
  readonly expectedAmount: string;
  readonly lastAmount: string;
  readonly amountToleranceRatio: string;
  readonly lastSeen: string;
  readonly cadence: string;
  readonly nextExpected: string | null;
}

/**
 * Everything the condition rules for one period may read.
 *
 * `snapshots` covers the period and its lookback; `records` and `groups` cover the period only,
 * except `trailingRecords`, which the unusual-transaction rule needs over six months. Nothing here
 * is an `alerts` row or a status: a rule that could see a dismissal would make the health score
 * depend on what a user clicked (R2-B-11).
 */
export interface RuleContext {
  readonly organizationId: string;
  readonly periodId: string;
  readonly isComplete: boolean;
  /** True when no earlier period has data — the first-period gate (§8.1). */
  readonly isFirstPeriodWithData: boolean;
  /** The period and its lookback, in one flat list. */
  readonly snapshots: readonly MetricObservation[];
  /** Accepted records of this period. */
  readonly records: readonly RecordObservation[];
  /**
   * Accepted bank records of the COMPLETE months before this one — at most six, newest last.
   *
   * §8.2 gives `bank.unusual_transaction` a six-month window for its median and MAD; §8.1 says
   * every median-based threshold reads complete months only, never the partial current one
   * (ADR-047.6). Read together that is six complete months, and the two constraints are about
   * different things — how far back, and which months count (ADR-054.3).
   */
  readonly trailingRecords: readonly RecordObservation[];
  readonly recurringGroups: readonly RecurringGroupObservation[];
  /**
   * Period ids of the complete months before this one, oldest first, at most six. The last three
   * are what "monthly outflows" means in §8.2 (ADR-054.3).
   */
  readonly trailingCompletePeriodIds: readonly string[];
  /** Counterparty ids first seen in this period; the unusual-transaction rule needs "new". */
  readonly newCounterpartyIds: readonly string[];
}

// ---------------------------------------------------------------------------------------------
// The lens
// ---------------------------------------------------------------------------------------------

/** True when a variance snapshot must be treated as NULL (§7.2, ADR-030.3). */
export function basisDiffers(observation: MetricObservation): boolean {
  return observation.dataQuality.warnings.includes('basis_differs');
}

/**
 * The undimensioned observation of a metric in a period, or `undefined`.
 *
 * A snapshot whose value is NULL is still returned: the caller usually needs the reason in
 * `data_quality.missing`, and "no row at all" and "a row that says we could not work it out" are
 * different facts.
 */
export function observationOf(
  snapshots: readonly MetricObservation[],
  periodId: string,
  metricKey: string,
): MetricObservation | undefined {
  return snapshots.find(
    (s) => s.periodId === periodId && s.metricKey === metricKey && s.dimensionId === null
      && (s.dimensionKey ?? null) === null,
  );
}

/** Every dimensioned observation of a metric in a period, in the order supplied. */
export function dimensionsOf(
  snapshots: readonly MetricObservation[],
  periodId: string,
  metricKey: string,
): readonly MetricObservation[] {
  return snapshots.filter(
    (s) => s.periodId === periodId && s.metricKey === metricKey
      && (s.dimensionId !== null || (s.dimensionKey ?? null) !== null),
  );
}

/**
 * A metric's value as a `Decimal`, or NULL.
 *
 * NULL covers all three ways a figure can be unusable: no snapshot, a snapshot the engine could not
 * compute, and a variance measured across two different bases.
 */
export function valueOf(
  snapshots: readonly MetricObservation[],
  periodId: string,
  metricKey: string,
): Decimal | null {
  const observation = observationOf(snapshots, periodId, metricKey);
  return observation === undefined ? null : usableValue(observation);
}

/** The usable value of one observation: NULL when absent, uncomputable or `basis_differs`. */
export function usableValue(observation: MetricObservation | undefined): Decimal | null {
  if (observation === undefined) return null;
  if (basisDiffers(observation)) return null;
  return tryParseDecimal(observation.value);
}

/** A named component of a snapshot (`pct_change`, `current`, …) as a `Decimal`, or NULL. */
export function componentOf(
  observation: MetricObservation | undefined,
  name: string,
): Decimal | null {
  if (observation === undefined) return null;
  if (basisDiffers(observation)) return null;
  const raw = observation.components[name];
  return typeof raw === 'string' ? tryParseDecimal(raw) : null;
}

/** Median of a list of `Decimal`s, exact. Empty list yields NULL. */
export function median(values: readonly Decimal[]): Decimal | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a.comparedTo(b));
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : sorted[middle - 1]!.plus(sorted[middle]!).dividedBy(2);
}

/**
 * Median absolute deviation.
 *
 * MAD rather than a standard deviation because one £40,000 VAT payment would inflate a standard
 * deviation enough to hide every other unusual payment that month — which is the opposite of what
 * the rule is for.
 */
export function medianAbsoluteDeviation(values: readonly Decimal[]): Decimal | null {
  const centre = median(values);
  if (centre === null) return null;
  return median(values.map((v) => v.minus(centre).abs()));
}
