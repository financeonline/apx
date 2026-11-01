/** `modules/departments` — the Departmental Dashboard (Agreement §4; ADR-143). */
export { loadDepartments, type DepartmentTile, type DepartmentsView, type SystemOverview, type TileTone } from './services';
/** Home's "Data & compliance" strip, composed by permission (ADR-172 follow-up). */
export { loadDataCompliance, type DataComplianceView } from './services/data-compliance';
/** Data progress (`/data/progress`), opened from the dashboard's Compliance View card (owner, 2026-11-02). */
export {
  loadDataProgress, type CoverageMonthView, type CoverageRowView, type DataProgressView, type ProgressBatchView, type ProgressSourceView,
} from './services/data-progress';
export {
  PIPELINE_STEPS, type Blocker, type ComplianceCardView, type CoverageCell, type ComplianceRowView, type Headline, type MonthCoverage, type PipelineView, type StepState,
} from './domain/data-progress';

/** The department dashboard (ADR-180; docs/DEPARTMENT_DASHBOARD_PLAN.md): the contract and its loader. */
export * from './domain/dashboard';
export { loadDepartmentDashboard, parseDashboardParams } from './services/dashboard';
export { loadWindow } from './services/dashboard/window';
export { clientReviewTitle, reviewRequestTitle } from './services/dashboard/review-requests';
