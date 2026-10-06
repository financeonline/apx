/**
 * The deterministic financial calculation engine (FINANCIAL_ENGINE.md §1–§6).
 *
 * Produces numbers, comparisons and rule outcomes. It produces no narrative, no causation and no
 * recommendation — that boundary is a type boundary (§1.1), and it is what makes every figure here
 * unit-testable against a golden number.
 *
 * `domain/` is pure: no Supabase, no Next.js, no clock, no randomness. "Today" is an explicit
 * `asOf` input used only for aging and runway.
 */

export type {
  AggregateCell,
  AccountRef,
  AssuranceLevel,
  BankAccountRef,
  BasisChoice,
  CounterpartyRef,
  DataQuality,
  DataQualityMissing,
  DataQualityWarning,
  DimensionType,
  EngineContext,
  EvidenceQuery,
  LeafDescriptor,
  MetricBasis,
  MetricFamily,
  MetricResult,
  MetricUnit,
  OrganizationSettings,
  PeriodCoverage,
  PeriodRef,
  SourceCoverage,
  SourceKind,
} from './domain/types';

export { DATA_QUALITY_MISSING, DATA_QUALITY_WARNINGS, PERFECT_QUALITY } from './domain/types';

export {
  AS_OF_DEPENDENT_KEYS,
  COMPUTATION_ORDER,
  METRIC_DEFINITIONS,
  VARIANCE_BASES,
  VARIANCE_SUFFIXES,
  isMetricKey,
  metricDefinition,
  varianceKey,
  type Aggregation,
  type MetricDefinition,
  type VarianceSuffix,
} from './domain/registry';

export {
  ALERT_RULE_VERSION,
  CHUNK_PERIODS,
  COMPARISON_LOOKBACK_MONTHS,
  ENGINE_VERSION,
  HEALTH_CONFIG_VERSION,
} from './domain/version';

export {
  FAMILY_PRECEDENCE,
  choosePrecedence,
  chooseBalanceKind,
  computeCoverage,
  isPeriodComplete,
  winningBalanceBatch,
  invoiceSideCoverage,
  invoiceRevenueCoverage,
  invoiceCostCoverage,
  AR_AP_FRESHNESS_DAYS,
  balancePnlContext,
  balanceRowsByKind,
  type InvoiceSide,
  type InvoiceSideCoverage,
  type CoverageBatch,
  type CoverageInput,
  type MetricFamilyKey,
} from './domain/coverage';

export { __canonical, computeFingerprint, type FingerprintInput } from './domain/fingerprint';

export {
  affectedRange,
  chunkPeriods,
  chunkWindow,
  type AffectedPeriodsInput,
  type CalculationTrigger,
  type RunRange,
} from './domain/chunking';

// ---------------------------------------------------------------------------------------------
// The metric modules. Exported through the barrel because the run service, the tests and any future
// consumer all speak these; `motion/no-deep-module-import` correctly refuses a path into `domain/`.
// ---------------------------------------------------------------------------------------------
export * from './domain/sign';
export * from './domain/merged';
export * from './domain/categories';
export * from './domain/pnl';
export * from './domain/variance';
export * from './domain/cash';
export * from './domain/cash-history';
export * from './domain/receivables';
export * from './domain/receivables-input';
export * from './domain/concentration';
export * from './domain/commercial-population';

export { composePeriod, type BalancePnlContext, type ComposeInput, type TransferLegCell } from './domain/compose';

/**
 * The calculation run itself (§2.4).
 *
 * Server-only. It was never exported: the run loop existed, was correct and was unreachable, which
 * is how the job queue came to have no handler for `calculation.run` (ADR-057.1).
 */
export {
  runCalculation,
  type HealthChunkInput,
  type PeriodComputer,
  type RunDeps,
  type RunOutcome,
  type RunRequest,
} from './services/run';

export { comparisonPeriodIds, monthsBefore, variancesForPeriod, type StoredFigure, type VariancePassInput } from './domain/variance-pass';

/** Phase 17 (R17-1b): day- and week-level figures, kept apart from the monthly engine. */
export {
  INTERIM_RECORD_CAP,
  INTERIM_RULES_VERSION,
  computeInterimFigures,
  interimChange,
  type InterimAccountCoverage,
  type InterimBankRow,
  type InterimFigure,
  type InterimFigureKey,
  type InterimFigures,
  type InterimInput,
  type InterimInvoiceRow,
  type InterimInvoiceType,
  type InterimRecordRef,
  type InterimStatus,
  type InterimUnavailable,
  type InterimWindow,
} from './domain/interim';
