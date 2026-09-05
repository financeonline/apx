/**
 * Every permission key in the system. Nothing else compiles.
 * Source of truth: RBAC_MATRIX.md §2.1 (ADR-003).
 */
export const PERMISSIONS = [
  // Intelligence
  'dashboard.view',
  'financials.view',
  'financials.edit',
  // Imports
  'imports.create',
  'imports.review',
  // Banking
  'banking.view',
  'banking.reconcile',
  // Commercial
  'customers.view',
  'customers.edit',
  // Reporting
  'reports.view',
  'reports.generate',
  // AI
  'ai.use',
  // Actions
  'actions.view',
  'actions.create',
  'actions.assign',
  'actions.update_own',
  // Alerts and recomputation
  'alerts.manage',
  'intelligence.recompute',
  // Tenancy governance
  'users.view',
  'users.invite',
  'users.manage',
  'assignments.view',
  'assignments.manage',
  // Documents and export
  'documents.view',
  'data.export',
  // Audit and settings
  'audit.view',
  'settings.manage',
  'billing.manage',
  'org.delete',
  // Platform
  'system.manage',
  'platform.orgs.manage',
  'platform.users.manage',
  'platform.ai_feedback.review',
  'platform.jobs.view',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const PERMISSION_SET: ReadonlySet<string> = new Set(PERMISSIONS);

export function isPermission(value: string): value is Permission {
  return PERMISSION_SET.has(value);
}
