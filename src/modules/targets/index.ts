/**
 * `modules/targets` — the department dashboard's monthly targets (docs/DEPARTMENT_DASHBOARD_PLAN.md):
 * one record per company per `YYYY-MM` (`monthly_targets`), checked against the month's actuals by
 * the pure `assessTargets`.
 */
export {
  DEFAULT_TARGETS,
  TARGET_LIMITS,
  assessTargets,
  isTargetMonth,
  parseExpectedRevision,
  parseMonthlyTargets,
  parseTargetMonth,
  type MonthlyTargets,
  type TargetActuals,
  type TargetAssessment,
  type TargetItem,
  type TargetKey,
  type TargetStatus,
} from './domain/targets';
export { canManageTargets, getMonthlyTargets, saveMonthlyTargets, type MonthlyTargetsRecord } from './services';
