/**
 * The department dashboard (docs/DEPARTMENT_DASHBOARD_PLAN.md): the client's prototype
 * (`~/Downloads/apx-prototype`) markup, class names and behaviour, rendering the
 * `DepartmentDashboard` view model. Styles: `app/app/[orgSlug]/home/apx-dashboard.css` (`.apx-dash`).
 */
export { DashProvider, useDash, type DashActions, type FeedbackContext } from './dash-context';
export { IdentityStrip, FeedbackButton } from './buttons';
export { DepartmentNav } from './department-nav';
export { Welcome, SectionHeading, ControlBar } from './heading';
export { Metrics } from './metrics';
export { KeyReportIndicators } from './key-report-indicators';
export { MainChart } from './main-chart';
export { MarketingVsRevenue } from './marketing-vs-revenue';
export { RevenueMix } from './revenue-mix';
export { GrowthCard } from './growth-card';
export { ClientWorkspace } from './client-workspace';
export { ComparativeFinancials } from './comparative-financials';
export { PrioritiesQueue } from './priorities-queue';
export { ComplianceView } from './compliance-view';
export { OperationsPanel } from './operations-panel';
export { DashFooter } from './footer';
export type { ExportMeta } from './export-csv';
export type { GrowthRowsView, TargetsCheckView, TargetsRecord } from './types';
