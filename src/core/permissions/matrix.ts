import { PERMISSIONS, type Permission } from './catalogue';

/**
 * Effective role inside one organization (RBAC_MATRIX.md §1).
 * `suspended_member` is a first-class value: leaving it out of the type is how a `<> 'client'`
 * branch silently widens a suspended client's access (R2-A-07).
 */
export type EffectiveRole =
  | 'super_admin'
  | 'employee'
  | 'owner'
  | 'admin'
  | 'client'
  | 'suspended_member'
  | 'none';

export type GrantedRole = Exclude<EffectiveRole, 'none'>;

/**
 * The matrix, transcribed from RBAC_MATRIX.md §2.1. Deny by default: a permission absent from a
 * role's row is denied. `◐` in the document means granted with a named guard (see guards.ts) —
 * the bit is granted here and the restriction is enforced next to it.
 *
 * A unit test regenerates this table from the markdown and fails on any drift, so the document and
 * the code cannot diverge (TEST_STRATEGY.md §2).
 */
const GRANTS: Record<Exclude<GrantedRole, 'suspended_member'>, readonly Permission[]> = {
  super_admin: [...PERMISSIONS],

  employee: [
    'dashboard.view',
    'financials.view',
    'financials.edit',
    'imports.create',
    'imports.review',
    'banking.view',
    'banking.reconcile',
    'customers.view',
    'customers.edit',
    'reports.view',
    'reports.generate',
    'ai.use',
    'actions.view',
    'actions.create',
    'actions.assign',
    'actions.update_own',
    'alerts.manage',
    'intelligence.recompute',
    'assignments.view', // ◐ own assignments only, served by /portfolio
    'documents.view',
    'data.export',
    'platform.ai_feedback.review', // ◐ assigned organizations only
  ],

  owner: [
    'dashboard.view',
    'financials.view',
    'financials.edit',
    'imports.create',
    'imports.review',
    'banking.view',
    'banking.reconcile',
    'customers.view',
    'customers.edit',
    'reports.view',
    'reports.generate',
    'ai.use',
    'actions.view',
    'actions.create',
    'actions.assign',
    'actions.update_own',
    'alerts.manage',
    'intelligence.recompute',
    'users.view',
    'users.invite',
    'users.manage',
    'assignments.view',
    'assignments.manage', // ◐ revoke only; only a super admin creates
    'documents.view',
    'data.export',
    'audit.view',
    'settings.manage',
    'billing.manage',
    'org.delete',
  ],

  admin: [
    'dashboard.view',
    'financials.view',
    'financials.edit',
    'imports.create',
    'imports.review',
    'banking.view',
    'banking.reconcile',
    'customers.view',
    'customers.edit',
    'reports.view',
    'reports.generate',
    'ai.use',
    'actions.view',
    'actions.create',
    'actions.assign',
    'actions.update_own',
    'alerts.manage',
    'intelligence.recompute',
    'users.view',
    'users.invite', // ◐ admin/client only
    'users.manage', // ◐ admin/client only, never owners
    'assignments.view',
    'documents.view',
    'data.export',
    'audit.view',
    'settings.manage',
  ],

  client: [
    'dashboard.view',
    'financials.view',
    'banking.view',
    'customers.view',
    'reports.view',
    'ai.use',
    'actions.view',
    'actions.update_own',
    'alerts.manage', // ◐ acknowledge only
  ],
};

export const ROLE_MATRIX: Record<GrantedRole, ReadonlySet<Permission>> = {
  super_admin: new Set(GRANTS.super_admin),
  employee: new Set(GRANTS.employee),
  owner: new Set(GRANTS.owner),
  admin: new Set(GRANTS.admin),
  client: new Set(GRANTS.client),
  // A suspended organization freezes every member to the Home page (ADR-044.4).
  suspended_member: new Set<Permission>(['dashboard.view']),
};

/** Flat rows for the generated `role_permissions` mirror (ADR-003). */
export function matrixRows(): Array<{ role: GrantedRole; permission: Permission }> {
  const rows: Array<{ role: GrantedRole; permission: Permission }> = [];
  for (const role of Object.keys(ROLE_MATRIX) as GrantedRole[]) {
    for (const permission of PERMISSIONS) {
      if (ROLE_MATRIX[role].has(permission)) rows.push({ role, permission });
    }
  }
  return rows;
}
