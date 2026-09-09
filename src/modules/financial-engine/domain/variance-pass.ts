import { metricDefinition } from './registry';
import {
  COMPARISON_PERIOD_COUNT, VARIANCE_BASE_METRICS, VARIANCE_SUFFIXES, computeRevenueGrowth, computeVariance,
  type VarianceObservation, type VariancePeriodInput, type VarianceSuffix,
} from './variance';
import type { AssuranceLevel, DataQualityMissing, DataQualityWarning, MetricBasis, MetricResult, PeriodRef } from './types';

/**
 * The variance pass (FINANCIAL_ENGINE.md §3.2; ADR-080).
 *
 * `computeVariance` and `computeRevenueGrowth` existed, were tested, and were never called: the run
 * wrote levels and no `B.variance.{suffix}` for any B, so every consumer of a change — health P3/P4/
 * G1/K2, the expense-spike, revenue-decline, margin and cash alert rules, the MetricCard's change
 * line and the analyst's change tools — has been reading a row that was never there. This is the
 * one place the run turns a period's levels into its comparisons.
 *
 * Comparisons come from two places, in order: this run's own results for a period it has already
 * computed (a chunk is oldest-first, so P−1 is usually in memory), else the stored current figure
 * of a period an earlier run wrote. A comparison period that does not exist for the organisation is
 * `periodId = null`, which the variance domain reports as `comparison_period_missing` rather than as
 * zero.
 */

/** A stored comparison figure, in the shape the pass needs (the repository maps rows to this). */
export interface StoredFigure {
  readonly periodId: string;
  readonly metricKey: string;
  readonly dimensionType: string;
  readonly dimensionId: string | null;
  readonly dimensionKey: string | null;
  readonly snapshotId: string;
  readonly value: string | null;
  readonly basis: string;
  readonly assurance: string;
  readonly dataQuality: { completeness?: number; warnings?: string[]; missing?: string[] };
}

export interface VariancePassInput {
  readonly period: PeriodRef;
  /** Every period of the organisation, oldest first — the calendar the offsets are read from. */
  readonly allPeriods: readonly PeriodRef[];
  /** This period's level results, ids already minted. */
  readonly results: readonly MetricResult[];
  /** Results of periods this run has already computed, by period id. */
  readonly computed: ReadonlyMap<string, readonly MetricResult[]>;
  /** Stored current figures of comparison periods this run did not compute. */
  readonly stored: readonly StoredFigure[];
  readonly currency: string | null;
  /** Mints a snapshot id, so growth can name the variance it came from before either is written. */
  readonly mint: () => string;
}

/** The months each suffix looks back, in the order the domain requires them. */
export function comparisonOffsets(suffix: VarianceSuffix): readonly number[] {
  switch (suffix) {
    case 'prev_period': return [1];
    case 'same_period_last_year': return [12];
    case 'trailing_3m_avg': return [1, 2, 3];
  }
}

/** `YYYY-MM-DD` of the first day `months` before a period start. */
export function monthsBefore(periodStart: string, months: number): string {
  const [y, m] = periodStart.split('-').map(Number) as [number, number];
  const index = y * 12 + (m - 1) - months;
  const year = Math.floor(index / 12);
  const month = index - year * 12 + 1;
  return `${year}-${String(month).padStart(2, '0')}-01`;
}

/** The comparison period ids a period needs, existing or not, for every suffix. */
export function comparisonPeriodIds(period: PeriodRef, allPeriods: readonly PeriodRef[]): string[] {
  const byStart = new Map(allPeriods.map((p) => [p.periodStart, p.id]));
  const ids = new Set<string>();
  for (const suffix of VARIANCE_SUFFIXES) {
    for (const offset of comparisonOffsets(suffix)) {
      const id = byStart.get(monthsBefore(period.periodStart, offset));
      if (id !== undefined) ids.add(id);
    }
  }
  return [...ids];
}

/** The dimension identity a variance observation carries: a row id, or a category name. */
function dimensionOf(result: { dimensionType: string; dimensionId: string | null; dimensionKey?: string | null }): string | null {
  return result.dimensionType === 'standard_category' ? (result.dimensionKey ?? null) : result.dimensionId;
}

function observationsFromResults(results: readonly MetricResult[], baseKey: string): VarianceObservation[] {
  return results.filter((r) => r.key === baseKey).map((r) => ({
    dimensionId: dimensionOf(r),
    value: r.value,
    basis: r.basis,
    assurance: r.assurance,
    completeness: r.dataQuality.completeness,
    missing: r.dataQuality.missing,
    warnings: r.dataQuality.warnings,
  }));
}

function observationsFromStored(stored: readonly StoredFigure[], periodId: string, baseKey: string): VarianceObservation[] {
  return stored.filter((s) => s.periodId === periodId && s.metricKey === baseKey).map((s) => ({
    dimensionId: dimensionOf(s),
    value: s.value,
    basis: s.basis as MetricBasis,
    assurance: s.assurance as AssuranceLevel,
    completeness: s.dataQuality.completeness ?? 1,
    missing: (s.dataQuality.missing ?? []) as DataQualityMissing[],
    warnings: (s.dataQuality.warnings ?? []) as DataQualityWarning[],
  }));
}

export function variancesForPeriod(input: VariancePassInput): MetricResult[] {
  const byStart = new Map(input.allPeriods.map((p) => [p.periodStart, p]));
  const minted: MetricResult[] = [];

  /** Snapshot id of `(period, key, dimension)`: this period, an earlier computed period, or a stored row. */
  const resolve = (periodId: string, key: string, dimensionId: string | null): string | null => {
    const pool = periodId === input.period.id
      ? [...input.results, ...minted]
      : input.computed.get(periodId) ?? [];
    const hit = pool.find((r) => r.key === key && dimensionOf(r) === dimensionId);
    if (hit?.id) return hit.id;
    const stored = input.stored.find((s) => s.periodId === periodId && s.metricKey === key && dimensionOf(s) === dimensionId);
    return stored?.snapshotId ?? null;
  };

  const comparison = (offset: number, baseKey: string): VariancePeriodInput => {
    const ref = byStart.get(monthsBefore(input.period.periodStart, offset));
    if (ref === undefined) return { periodId: null, observations: [] };
    const computed = input.computed.get(ref.id);
    return {
      periodId: ref.id,
      observations: computed !== undefined
        ? observationsFromResults(computed, baseKey)
        : observationsFromStored(input.stored, ref.id, baseKey),
    };
  };

  for (const baseKey of VARIANCE_BASE_METRICS) {
    const definition = metricDefinition(baseKey);
    const current = observationsFromResults(input.results, baseKey);
    for (const suffix of VARIANCE_SUFFIXES) {
      const comparisons = comparisonOffsets(suffix).map((offset) => comparison(offset, baseKey));
      if (comparisons.length !== COMPARISON_PERIOD_COUNT[suffix]) continue;
      // Nothing to compare when neither side has a figure for this base metric.
      if (current.length === 0 && comparisons.every((c) => c.observations.length === 0)) continue;
      const results = computeVariance({
        baseKey, suffix,
        unit: definition.unit,
        dimensionType: definition.dimensionType,
        currency: definition.unit === 'money' ? input.currency : null,
        current: { periodId: input.period.id, observations: current },
        comparisons,
      }, resolve);
      for (const r of results) {
        // A category is a name, not a row: it lives in `dimension_key` (ADR-053).
        const categorised = r.dimensionType === 'standard_category'
          ? { ...r, dimensionId: null, dimensionKey: r.dimensionId }
          : r;
        minted.push({ ...categorised, id: input.mint() });
      }
    }
  }

  const growth = computeRevenueGrowth(minted, input.period.id, resolve).map((r) => ({ ...r, id: input.mint() }));
  return [...minted, ...growth];
}
