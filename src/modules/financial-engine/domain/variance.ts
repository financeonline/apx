/**
 * Growth and variance (FINANCIAL_ENGINE.md §3.2).
 *
 * A variance is a comparison, and a comparison is only meaningful when both sides mean the same
 * thing. Most of this file is therefore about REFUSING to compute one:
 *
 *  - a percentage across zero is meaningless, so `pct_change` is NULL when the comparison is 0;
 *  - a percentage across a sign change ("−£2,000 became +£3,000, so costs fell 250%") is worse than
 *    meaningless, so it is NULL too, with a `sign_change` warning;
 *  - a trailing average of three months needs three months;
 *  - and two periods measured on different bases are not comparable at all.
 *
 * CONSUMERS MUST TREAT A `basis_differs` VARIANCE AS NULL. The absolute value is still written, so
 * a reader who understands both bases can look at it, but every variance-based alert rule (§8.1) is
 * suppressed and health rules P4, G1 and K2 skip it (ADR-030.3). A trial balance last month against
 * a bank statement this month can move a "figure" by tens of thousands without a penny changing
 * hands; firing an alert on that would train people to ignore alerts.
 *
 * Pure: no clock, no randomness, no iteration-order dependence.
 */

import { ZERO, abs, divide, parseDecimal, subtract, sum, toMoneyString, toRatioString } from '@/core/money';
import type { Decimal } from '@/core/money';
import type {
  AssuranceLevel,
  DataQualityMissing,
  DataQualityWarning,
  DimensionType,
  EvidenceQuery,
  MetricBasis,
  MetricResult,
  MetricUnit,
} from './types';

// ---------------------------------------------------------------------------------------------
// The comparison set (§3.2)
// ---------------------------------------------------------------------------------------------

/**
 * The suffixes and the key format come from the registry, which is the single declaration of every
 * metric key (§3.6). Defining them twice would let the two drift, and a variance key nobody declared
 * cannot be labelled, grounded or rolled up.
 */
export { VARIANCE_SUFFIXES, varianceKey, type VarianceSuffix } from './registry';
import { varianceKey, type VarianceSuffix } from './registry';

/** How many comparison periods each suffix consumes, in the order the caller must supply them. */
export const COMPARISON_PERIOD_COUNT: Readonly<Record<VarianceSuffix, number>> = {
  prev_period: 1,
  same_period_last_year: 1,
  trailing_3m_avg: 3,
};

/** The base metrics §3.2 writes a variance for. */
export const VARIANCE_BASE_METRICS = [
  'revenue', 'gross_profit', 'gross_margin', 'operating_expenses', 'operating_profit',
  'net_profit', 'net_margin', 'closing_cash', 'net_cash_movement', 'receivables', 'payables',
  'expense_by_category', 'expense_by_account',
] as const;
export type VarianceBaseMetric = (typeof VARIANCE_BASE_METRICS)[number];

// ---------------------------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------------------------

/** One dimension's figure in one period, as it was written to `metric_snapshots`. */
export interface VarianceObservation {
  readonly dimensionId: string | null;
  readonly value: string | null;
  readonly basis: MetricBasis;
  readonly assurance: AssuranceLevel;
  readonly completeness: number;
  readonly missing?: readonly DataQualityMissing[];
  readonly warnings?: readonly DataQualityWarning[];
}

/**
 * One comparison period. `periodId === null` means the period does not exist for this organization
 * at all — there is nothing to compare against, which is a different thing from a period that
 * exists and simply had no rows for a dimension.
 */
export interface VariancePeriodInput {
  readonly periodId: string | null;
  readonly observations: readonly VarianceObservation[];
}

export interface VarianceInput {
  readonly baseKey: string;
  readonly unit: MetricUnit;
  readonly dimensionType: DimensionType;
  readonly currency: string | null;
  readonly suffix: VarianceSuffix;
  readonly current: {
    readonly periodId: string;
    readonly observations: readonly VarianceObservation[];
  };
  /**
   * `prev_period` and `same_period_last_year` take exactly one; `trailing_3m_avg` takes P−1, P−2,
   * P−3 IN THAT ORDER. Supplying the wrong number yields NULL variances rather than a silent
   * average of whatever arrived.
   */
  readonly comparisons: readonly VariancePeriodInput[];
}

/** Resolves the snapshot id of `(period, key, dimension)`, for derived evidence (ADR-034). */
export type VarianceSnapshotIdResolver =
  (periodId: string, key: string, dimensionId: string | null) => string | null;

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

const ASSURANCE_ORDER: Readonly<Record<AssuranceLevel, number>> = {
  verified: 3, calculated: 2, estimated: 1, inferred: 0,
};

function weakest(levels: readonly AssuranceLevel[]): AssuranceLevel {
  return levels.reduce((low, l) => (ASSURANCE_ORDER[l] <= ASSURANCE_ORDER[low] ? l : low), 'verified');
}

function uniqueInOrder<T>(items: Iterable<T>): T[] {
  return [...new Set(items)];
}

/** Dimension ids in a fixed order: the undimensioned figure first, then id-sorted. */
function orderedDimensionIds(
  current: readonly VarianceObservation[],
  comparisons: readonly VariancePeriodInput[],
): Array<string | null> {
  const ids = new Set<string | null>();
  for (const o of current) ids.add(o.dimensionId);
  for (const period of comparisons) for (const o of period.observations) ids.add(o.dimensionId);
  const withNull = ids.has(null);
  const named = [...ids].filter((id): id is string => id !== null).sort();
  return withNull ? [null, ...named] : named;
}

function observationFor(
  observations: readonly VarianceObservation[],
  dimensionId: string | null,
): VarianceObservation | undefined {
  return observations.find((o) => o.dimensionId === dimensionId);
}

function strictSign(value: Decimal): -1 | 0 | 1 {
  if (value.greaterThan(0)) return 1;
  if (value.lessThan(0)) return -1;
  return 0;
}

interface ComparisonResolution {
  readonly value: Decimal | null;
  readonly bases: readonly MetricBasis[];
  readonly assurances: readonly AssuranceLevel[];
  readonly completeness: number;
  readonly warnings: readonly DataQualityWarning[];
  readonly missing: readonly DataQualityMissing[];
  readonly periodIds: readonly string[];
}

/**
 * Work out what a dimension is being compared against.
 *
 * The three-way distinction matters and is easy to lose:
 *  - the comparison PERIOD is missing  → nothing to compare (`comparison_period_missing`);
 *  - the period exists but this DIMENSION is not in it → the category is new, so the comparison is
 *    a real 0 and only the percentage is refused (`new_in_period`);
 *  - the dimension is there but its value is NULL → the comparison was never computed, so this
 *    variance cannot be either.
 */
function resolveComparison(
  input: VarianceInput,
  dimensionId: string | null,
): ComparisonResolution {
  const expected = COMPARISON_PERIOD_COUNT[input.suffix];
  const trailing = input.suffix === 'trailing_3m_avg';
  const insufficient: DataQualityMissing = trailing ? 'insufficient_history' : 'comparison_period_missing';

  if (input.comparisons.length !== expected) {
    return empty(insufficient);
  }

  const values: Decimal[] = [];
  const bases: MetricBasis[] = [];
  const assurances: AssuranceLevel[] = [];
  const periodIds: string[] = [];
  const warnings: DataQualityWarning[] = [];
  let completeness = 1;
  let absentEverywhere = true;

  for (const period of input.comparisons) {
    if (period.periodId === null) return empty(insufficient);
    periodIds.push(period.periodId);
    const observation = observationFor(period.observations, dimensionId);
    if (observation === undefined) {
      // An undimensioned metric that was never written for the comparison period has no comparison
      // at all. A DIMENSION missing from a period that WAS written is different: the period is
      // covered and this category simply had nothing in it, so zero is what happened.
      if (dimensionId === null) return empty(insufficient, periodIds);
      values.push(ZERO);
      continue;
    }
    absentEverywhere = false;
    if (observation.value === null) return empty(insufficient, periodIds);
    values.push(parseDecimal(observation.value));
    bases.push(observation.basis);
    assurances.push(observation.assurance);
    completeness = Math.min(completeness, observation.completeness);
  }

  if (absentEverywhere && dimensionId !== null) warnings.push('new_in_period');

  const total = sum(values);
  const value = trailing ? total.dividedBy(values.length) : total;
  return { value, bases, assurances, completeness, warnings, missing: [], periodIds };

  function empty(reason: DataQualityMissing, ids: readonly string[] = []): ComparisonResolution {
    return {
      value: null, bases: [], assurances: [], completeness: 0,
      warnings: [], missing: [reason], periodIds: ids,
    };
  }
}

// ---------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------

/**
 * One `B.variance.{suffix}` per dimension present in EITHER period (§3.2).
 *
 * "Either" is deliberate: a category that appeared this month and a category that disappeared this
 * month are both news, and writing only the intersection would hide exactly the changes a variance
 * exists to show.
 */
export function computeVariance(
  input: VarianceInput,
  resolve: VarianceSnapshotIdResolver,
): readonly MetricResult[] {
  const key = varianceKey(input.baseKey, input.suffix);
  const isMoney = input.unit === 'money';
  const results: MetricResult[] = [];

  for (const dimensionId of orderedDimensionIds(input.current.observations, input.comparisons)) {
    const currentObservation = observationFor(input.current.observations, dimensionId);
    const comparison = resolveComparison(input, dimensionId);

    const warnings: DataQualityWarning[] = [...comparison.warnings];
    const missing: DataQualityMissing[] = [...comparison.missing];

    // A dimension that exists only in the comparison period fell to nothing this month. The source
    // covers the period, so that nothing is a known zero rather than an absence.
    const currentValue = currentObservation === undefined
      ? (dimensionId === null ? null : ZERO)
      : currentObservation.value === null ? null : parseDecimal(currentObservation.value);

    if (currentObservation !== undefined && currentObservation.value === null) {
      const reasons = currentObservation.missing ?? [];
      missing.push(...(reasons.length > 0 ? reasons : ['no_source_covers_period' as DataQualityMissing]));
    } else if (currentObservation === undefined && dimensionId === null) {
      missing.push('comparison_period_missing');
    }

    const bases = uniqueInOrder([
      ...(currentObservation ? [currentObservation.basis] : []),
      ...comparison.bases,
    ]);
    const basisDiffers = bases.length > 1;
    if (basisDiffers) warnings.push('basis_differs');

    let value: Decimal | null = null;
    let pctChange: Decimal | null = null;
    if (currentValue !== null && comparison.value !== null) {
      value = subtract(currentValue, comparison.value);
      if (comparison.value.isZero()) {
        // §3.2: the absolute change is still written; only the percentage is refused.
        missing.push('comparison_is_zero');
      } else if (strictSign(currentValue) * strictSign(comparison.value) < 0) {
        warnings.push('sign_change');
      } else {
        pctChange = divide(value, abs(comparison.value));
      }
    }

    const assurance = basisDiffers
      ? 'estimated'
      : weakest([
        ...(currentObservation ? [currentObservation.assurance] : []),
        ...comparison.assurances,
      ]);

    const completeness = Math.min(
      currentObservation?.completeness ?? 0,
      comparison.value === null ? 0 : comparison.completeness,
    );

    results.push({
      key,
      value: value === null ? null : isMoney ? toMoneyString(value) : toRatioString(value),
      unit: input.unit,
      basis: basisDiffers ? 'mixed' : (bases[0] ?? 'none'),
      assurance,
      dimensionType: input.dimensionType,
      dimensionId,
      currency: isMoney ? input.currency : null,
      components: {
        current: currentValue === null
          ? null : isMoney ? toMoneyString(currentValue) : toRatioString(currentValue),
        comparison: comparison.value === null
          ? null : isMoney ? toMoneyString(comparison.value) : toRatioString(comparison.value),
        pct_change: pctChange === null ? null : toRatioString(pctChange),
        // A trailing average has three comparison periods, so the singular id is null and the list
        // carries them. Readers that only understand one comparison period see null, not a lie.
        comparison_period_id: comparison.periodIds.length === 1 ? comparison.periodIds[0] : null,
        comparison_period_ids: comparison.periodIds,
        comparison_basis: comparison.bases.length === 1 ? comparison.bases[0] : comparison.bases,
        current_period_id: input.current.periodId,
      },
      dataQuality: {
        completeness,
        proxy: false,
        warnings: uniqueInOrder(warnings),
        missing: uniqueInOrder(missing),
      },
      evidenceQuery: varianceEvidence(input, key, dimensionId, comparison.periodIds, resolve),
    });
  }

  return results;
}

function varianceEvidence(
  input: VarianceInput,
  _key: string,
  dimensionId: string | null,
  comparisonPeriodIds: readonly string[],
  resolve: VarianceSnapshotIdResolver,
): EvidenceQuery {
  const components: Array<{ name: string; snapshot_id: string | null }> = [{
    name: 'current',
    snapshot_id: resolve(input.current.periodId, input.baseKey, dimensionId),
  }];
  comparisonPeriodIds.forEach((periodId, index) => {
    components.push({
      name: comparisonPeriodIds.length === 1 ? 'comparison' : `comparison_${index + 1}`,
      snapshot_id: resolve(periodId, input.baseKey, dimensionId),
    });
  });
  return { kind: 'derived', components };
}

// ---------------------------------------------------------------------------------------------
// revenue_growth_mom / revenue_growth_yoy (§3.2)
// ---------------------------------------------------------------------------------------------

const GROWTH_KEYS: Readonly<Record<string, VarianceSuffix>> = {
  revenue_growth_mom: 'prev_period',
  revenue_growth_yoy: 'same_period_last_year',
};

function pctChangeOf(result: MetricResult): string | null {
  const raw = result.components.pct_change;
  return typeof raw === 'string' ? raw : null;
}

/**
 * `revenue_growth_mom` and `revenue_growth_yoy` as ratio metrics of their own (§3.2).
 *
 * They are the `pct_change` of the corresponding revenue variance and inherit its NULL rules
 * exactly — including the `basis_differs` rule, so a growth figure carrying that warning must be
 * treated as NULL like the variance it came from. They exist because "revenue growth" is a number
 * people ask for by name, not because the engine needs a second definition of it.
 */
export function computeRevenueGrowth(
  varianceResults: readonly MetricResult[],
  currentPeriodId: string,
  resolve: VarianceSnapshotIdResolver,
): readonly MetricResult[] {
  const out: MetricResult[] = [];
  for (const growthKey of Object.keys(GROWTH_KEYS).sort()) {
    const suffix = GROWTH_KEYS[growthKey] as VarianceSuffix;
    const source = varianceResults.find(
      (r) => r.key === varianceKey('revenue', suffix) && r.dimensionId === null,
    );
    if (source === undefined) continue;
    const pct = pctChangeOf(source);
    out.push({
      key: growthKey,
      value: pct,
      unit: 'ratio',
      basis: source.basis,
      assurance: source.assurance,
      dimensionType: 'none',
      dimensionId: null,
      currency: null,
      components: {
        current: source.components.current,
        comparison: source.components.comparison,
        comparison_period_id: source.components.comparison_period_id,
        variance_key: source.key,
      },
      dataQuality: source.dataQuality,
      evidenceQuery: {
        kind: 'derived',
        components: [{
          name: source.key,
          snapshot_id: resolve(currentPeriodId, source.key, null),
        }],
      },
    });
  }
  return out;
}
