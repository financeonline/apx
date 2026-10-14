/** `modules/departments` — the Departmental Dashboard (Agreement §4; ADR-143). */
export { loadDepartments, type DepartmentTile, type DepartmentsView, type SystemOverview, type TileTone } from './services';
/** Home's "Data & compliance" strip, composed by permission (ADR-172 follow-up). */
export { loadDataCompliance, type DataComplianceView } from './services/data-compliance';
