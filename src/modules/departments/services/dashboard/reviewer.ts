import { can, isPlatformStaff } from '@/core/permissions';
import type { AccessContext } from '@/modules/tenancy';

/**
 * The prototype's "Analyst" view (ADR-180): the person who REVIEWS — APX staff (super admin, the
 * Financial Analyst). Everyone in the company (owner, admin, accountant, client) has the prototype's
 * "Client" side and REQUESTS a review instead — no permission separates an accountant from an owner,
 * and a role-name branch is forbidden (ADR-003). The real role decides it (owner, 2026-11-01: no Client/Analyst switch). The database still
 * checks every status change on its own (`set_alert_status`, `set_action_status`).
 */
export function reviewsAsAnalyst(ctx: AccessContext): boolean {
  return isPlatformStaff(ctx) && can(ctx, 'alerts.manage');
}
