/**
 * The alert engine (FINANCIAL_ENGINE.md §8).
 *
 * Phase 8 ships the six condition rules the health score counts (§7.3 K3/B3) and the data-only
 * suppression they share with it. The alert job, the other eleven rules, revisions, dedupe keys and
 * the per-run cap arrive in Phase 9; nothing here reads or writes an `alerts` row, and nothing here
 * can see a status, which is what keeps a dismissal out of the health score (R2-B-11).
 *
 * `domain/` is pure: no Supabase, no Next.js, no clock.
 */

export {
  BANKING_ANOMALY_RULE_KEYS,
  CONDITION_RULE_KEYS,
  NO_SUBJECT,
  SEVERITY_ORDER,
  type AlertSeverity,
  type AlertSubject,
  type AlertSubjectType,
  type ConditionRuleKey,
  type MetricObservation,
  type RecordObservation,
  type RuleOutcome,
} from './domain/types';

export {
  basisDiffers,
  componentOf,
  dimensionsOf,
  median,
  medianAbsoluteDeviation,
  observationOf,
  usableValue,
  valueOf,
  type RecurringGroupObservation,
  type RuleContext,
} from './domain/context';

export {
  COMPLETENESS_METRIC,
  INCOMPLETE_PERIOD_RULES,
  MIN_ABS_FLOOR,
  MIN_ABS_REVENUE_SHARE,
  MIN_COMPLETENESS,
  VARIANCE_RULES,
  dataSuppressed,
  dataSuppression,
  minAbsThreshold,
  type SuppressionReason,
} from './domain/suppression';

export * from './domain/rules';
