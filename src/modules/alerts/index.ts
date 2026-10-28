/**
 * The alert engine (FINANCIAL_ENGINE.md §8).
 *
 * Phase 8 ships the six condition rules the health score counts (§7.3 K3/B3) and the data-only
 * suppression they share with it. The alert job, the other eleven rules, revisions, dedupe keys and
 * the per-run cap arrive in Phase 9; nothing here reads or writes an `alerts` row, and nothing here
 * can see a status, which is what keeps a dismissal out of the health score (R2-B-11).
 *
 * `domain/` is pure: no database, no Next.js, no clock.
 */

export {
  ALERT_RULE_KEYS,
  BANKING_ANOMALY_RULE_KEYS,
  CONDITION_RULE_KEYS,
  OVERFLOW_RULE_KEY,
  SEVERITY_ORDER,
  NO_SUBJECT,
  type AccountObservation,
  type AlertRuleClass,
  type AlertRuleKey,
  type AlertSeverity,
  type AlertSubject,
  type AlertSubjectType,
  type ConditionRuleKey,
  type EvidencePin,
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
  type OpenInvoiceObservation,
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

export {
  RULES,
  RULE_ORDER,
  dedupeKey,
  familyOf,
  overflowDedupeKey,
  type RuleDefinition,
} from './domain/catalogue';

export * from './domain/rules';

export {
  TEMPLATES,
  renderAlert,
  renderOverflow,
  thresholdNoteFor,
  whyItMattersFor,
  displayCopyFor,
  type RenderedAlert,
} from './domain/templates';

export {
  DISMISSAL_COOLDOWN_DAYS,
  dismissalHolds,
  isMaterialChange,
  statusOnAbsence,
  statusOnRecurrence,
  userSuppressed,
  type AlertStatus,
  type ExistingAlert,
  type StatusDecision,
  type StatusReasonCode,
} from './domain/lifecycle';

export {
  PER_RUN_CAP,
  planEvaluation,
  type EvaluateInput,
  type EvaluationPlan,
  type Evaluator,
  type PeriodPlanInput,
  type PlannedChange,
  type PlannedInsert,
  type PlannedResolve,
  type PlannedRevision,
  type PlannedTouch,
} from './domain/evaluate';

// ---------------------------------------------------------------------------------------------
// Data and services. Server-only; components never call these (SERVICE_ARCHITECTURE.md §8).
// ---------------------------------------------------------------------------------------------

export {
  loadAlertHistory,
  loadAlerts,
  loadExistingAlerts,
  loadInvoiceRecords,
  loadLedgerRecords,
  setAlertStatus,
  type AlertListRow,
  type AlertQuery,
  type AlertRevisionRow,
} from './data/repository';

export {
  evaluateAlerts,
  type AlertEvaluationDeps,
  type AlertEvaluationOutcome,
  type AlertEvaluationRequest,
} from './services/evaluate';
