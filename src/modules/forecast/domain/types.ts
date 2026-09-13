import type { AssuranceLevel } from '@/core/assurance';
import type { ForecastBasis, InsufficiencyReason } from './config';

/**
 * The shapes the forecast works in (REQ-FC-01, REQ-FC-05; ADR-099).
 *
 * Money is a STRING everywhere, as it is everywhere else in MOTION (ADR-006). A forecast is still a
 * money figure and gets no exemption for being about the future.
 *
 * Pure.
 */

/** One month of one metric, as the engine actually computed it. */
export interface ActualPoint {
  readonly periodId: string;
  readonly periodStart: string;
  readonly periodLabel: string;
  /** NUMERIC as a string. `null` means "not computable", never zero (§1.5). */
  readonly value: string | null;
  readonly isComplete: boolean;
  readonly assurance: AssuranceLevel | null;
  /** `metric_snapshots.data_quality`, carried so the forecast can inherit its warnings. */
  readonly warnings: readonly string[];
}

/** A period the forecast will speak about. Always a real `fiscal_periods` row. */
export interface HorizonPeriod {
  readonly periodId: string;
  readonly periodStart: string;
  readonly periodLabel: string;
}

/** A period the baseline used, and what it contributed. */
export interface BasisPoint {
  readonly periodId: string;
  readonly periodLabel: string;
  readonly value: string;
  /** Linear recency weight; 0 when the period was excluded as a one-off. */
  readonly weight: number;
  readonly excluded: boolean;
  /** Set only on an excluded period, so the reason survives into the explanation. */
  readonly exclusionReason: 'one_off' | null;
}

/** What the baseline is, and what it was built from. */
export interface Baseline {
  readonly metricKey: string;
  /** The weighted average, as a money/number string. */
  readonly value: string;
  readonly points: readonly BasisPoint[];
  readonly periodsUsed: number;
  readonly periodsExcluded: number;
  /** True when any period in the window was incomplete or rested on estimated figures. */
  readonly anyIncomplete: boolean;
  readonly anyEstimated: boolean;
  readonly basis: ForecastBasis;
  readonly warnings: readonly string[];
}

/** A metric MOTION will not forecast, and the reason, which is always a real condition. */
export interface Unforecastable {
  readonly metricKey: string;
  readonly reason: InsufficiencyReason;
  readonly periodsFound: number;
}

/** One forecast figure for one future month. */
export interface ForecastPoint {
  readonly metricKey: string;
  readonly periodId: string;
  readonly periodLabel: string;
  /** NUMERIC as a string. Never null: a metric that cannot be forecast is absent, not zero (§20). */
  readonly value: string;
  /**
   * REQ-FC-05: every forecast figure is `estimated`, without exception and regardless of how firm
   * the history behind it was. A forecast of verified actuals is still a forecast.
   */
  readonly assurance: Extract<AssuranceLevel, 'estimated'>;
  /** Whether this figure was averaged from history or derived from other forecast figures. */
  readonly derivation: 'baseline' | 'identity';
  /** For an identity, the keys it was computed from — the engine's own dependency list. */
  readonly from: readonly string[];
}

export interface ForecastResult {
  readonly method: string;
  readonly configVersion: string;
  readonly horizon: readonly HorizonPeriod[];
  /** Baselines for the metrics that had enough history, keyed by metric. */
  readonly baselines: Readonly<Record<string, Baseline>>;
  readonly points: readonly ForecastPoint[];
  /** Metrics MOTION refused to forecast, each with its reason (§2, §20). */
  readonly unavailable: readonly Unforecastable[];
  /** The weakest basis across everything forecast — what the page leads with. */
  readonly basis: ForecastBasis | null;
}
