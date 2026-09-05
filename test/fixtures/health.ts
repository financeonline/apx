/**
 * Fixture builders for the health engine (TEST_STRATEGY.md §7).
 *
 * A health input is a bundle of snapshots, so the tests need a terse way to say "net margin was
 * 0.14 and everything else is fine". These builders default every required metric to a value that
 * scores in the middle, so a test that sets ONE metric is asserting about that metric alone — which
 * is what makes a threshold table readable as a table.
 */

import { PERFECT_QUALITY } from '@/modules/financial-engine';
import type {
  DataQualityMissing, DataQualityWarning, MetricUnit,
} from '@/modules/financial-engine';
import type { MetricObservation, RecordObservation, RuleContext } from '@/modules/alerts';
import type { HealthInput } from '@/modules/health';

export const ORG = '00000000-0000-4000-8000-000000000001';
export const PERIODS = [
  'p-2025-10', 'p-2025-11', 'p-2025-12', 'p-2026-01', 'p-2026-02', 'p-2026-03',
] as const;
export const CURRENT = 'p-2026-03';

export interface SnapshotSpec {
  readonly key: string;
  readonly value: string | null;
  readonly periodId?: string;
  readonly unit?: MetricUnit;
  readonly assurance?: MetricObservation['assurance'];
  readonly basis?: MetricObservation['basis'];
  readonly completeness?: number;
  readonly proxy?: boolean;
  readonly warnings?: readonly DataQualityWarning[];
  readonly missing?: readonly DataQualityMissing[];
  readonly components?: Readonly<Record<string, unknown>>;
  readonly dimensionKey?: string | null;
  readonly dimensionId?: string | null;
  readonly snapshotId?: string | null;
}

/**
 * Snapshot ids are derived from the cell they describe, never from a counter.
 *
 * A counter makes two calls to `baselineSnapshots()` produce different ids, which would make the
 * determinism test fail on the fixture rather than on the engine — and, worse, could make it PASS
 * for the wrong reason if the counter happened to line up.
 */
function snapshotIdFor(periodId: string, key: string, dimension: string): string {
  return `snap-${periodId}-${key}${dimension === '' ? '' : `-${dimension}`}`;
}

export function snapshot(spec: SnapshotSpec): MetricObservation {
  const dimensionKey = spec.dimensionKey ?? null;
  const dimensionId = spec.dimensionId ?? null;
  return {
    snapshotId: spec.snapshotId
      ?? snapshotIdFor(spec.periodId ?? CURRENT, spec.key, dimensionKey ?? dimensionId ?? ''),
    periodId: spec.periodId ?? CURRENT,
    metricKey: spec.key,
    dimensionType: dimensionKey !== null ? 'standard_category'
      : dimensionId !== null ? 'counterparty' : 'none',
    dimensionId,
    dimensionKey,
    value: spec.value,
    unit: spec.unit ?? 'ratio',
    basis: spec.basis ?? 'ledger',
    assurance: spec.assurance ?? 'calculated',
    components: spec.components ?? {},
    dataQuality: {
      ...PERFECT_QUALITY,
      completeness: spec.completeness ?? 1,
      proxy: spec.proxy ?? false,
      warnings: spec.warnings ?? [],
      missing: spec.missing ?? [],
    },
  };
}

/** A variance snapshot, whose `pct_change` component is what most rules actually read. */
export function variance(spec: SnapshotSpec & { pctChange?: string | null }): MetricObservation {
  return snapshot({
    ...spec,
    components: {
      pct_change: spec.pctChange ?? null,
      current: null,
      comparison: null,
      ...(spec.components ?? {}),
    },
  });
}

/**
 * A complete, unremarkable organisation: every required metric present, every dimension included.
 *
 * The numbers are deliberately mid-band, so a test that overrides one metric moves exactly one rule.
 */
export function baselineSnapshots(): MetricObservation[] {
  const history = PERIODS.flatMap((periodId) => [
    snapshot({ key: 'revenue', value: '100000', unit: 'money', periodId }),
    snapshot({ key: 'closing_cash', value: '50000', unit: 'money', periodId }),
    snapshot({ key: 'net_cash_movement', value: '1000', unit: 'money', periodId }),
    snapshot({ key: 'cash_outflows', value: '80000', unit: 'money', periodId }),
    snapshot({ key: 'cash_inflows', value: '81000', unit: 'money', periodId }),
  ]);

  return [
    ...history,
    // Profitability: net margin 0.08 (+15), gross margin 0.35 (+5), no trend, no momentum.
    snapshot({ key: 'net_margin', value: '0.08' }),
    snapshot({ key: 'gross_margin', value: '0.35' }),
    snapshot({ key: 'net_profit', value: '8000', unit: 'money' }),
    // Cash: runway 8 months (+20).
    snapshot({ key: 'cash_runway_months', value: '8', unit: 'days' }),
    // Revenue growth: +0.10 year on year (+15).
    snapshot({ key: 'revenue_growth_yoy', value: '0.10' }),
    snapshot({ key: 'revenue_growth_mom', value: '0.02' }),
    // Cost control: opex 70% of revenue (+5).
    snapshot({ key: 'operating_expenses', value: '70000', unit: 'money' }),
    // Customer quality: top1 0.25 (+10), top5 0.55 (+10), 28 days (+15).
    snapshot({ key: 'customer_concentration_top1', value: '0.25' }),
    snapshot({ key: 'customer_concentration_top5', value: '0.55' }),
    snapshot({ key: 'receivables_days', value: '28', unit: 'days' }),
  ];
}

export function emptyRuleContext(overrides: Partial<RuleContext> = {}): RuleContext {
  return {
    organizationId: ORG,
    periodId: CURRENT,
    isComplete: true,
    isFirstPeriodWithData: false,
    snapshots: [],
    records: [],
    trailingRecords: [],
    recurringGroups: [],
    trailingCompletePeriodIds: PERIODS.slice(0, -1),
    newCounterpartyIds: [],
    ...overrides,
  };
}

export function healthInput(overrides: Partial<HealthInput> = {}): HealthInput {
  const snapshots = overrides.snapshots ?? baselineSnapshots();
  return {
    organizationId: ORG,
    periodId: CURRENT,
    periodIds: [...PERIODS],
    isComplete: true,
    currency: 'GBP',
    snapshots,
    bankCoverageRatio: 1,
    conditions: emptyRuleContext({ snapshots }),
    ...overrides,
  };
}

/** Replace one metric in a snapshot set, or add it when it is not there. */
export function withMetric(
  snapshots: readonly MetricObservation[],
  spec: SnapshotSpec,
): MetricObservation[] {
  const replacement = spec.key.includes('.variance.')
    ? variance(spec as SnapshotSpec & { pctChange?: string | null })
    : snapshot(spec);
  const periodId = spec.periodId ?? CURRENT;
  const rest = snapshots.filter(
    (s) => !(s.metricKey === spec.key && s.periodId === periodId
      && s.dimensionId === (spec.dimensionId ?? null)
      && s.dimensionKey === (spec.dimensionKey ?? null)),
  );
  return [...rest, replacement];
}

/** Remove every observation of a metric, in every period. */
export function withoutMetric(
  snapshots: readonly MetricObservation[],
  metricKey: string,
): MetricObservation[] {
  return snapshots.filter((s) => s.metricKey !== metricKey);
}

let recordCounter = 0;

/** Records are identified by explicit ids in every test that compares two runs. */
export function record(spec: Partial<RecordObservation> = {}): RecordObservation {
  recordCounter += 1;
  return {
    id: `rec-${recordCounter}`,
    table: 'bank_transactions',
    periodId: CURRENT,
    date: '2026-03-12',
    amount: '-500.00',
    descriptionNormalized: 'acme supplies',
    counterpartyId: null,
    bankAccountId: 'bank-1',
    dedupeHash: null,
    duplicateReviewed: false,
    isTransfer: false,
    recurringGroupId: null,
    ...spec,
  };
}
