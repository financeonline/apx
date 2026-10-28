import type { Permission } from './catalogue';
import { ROLE_MATRIX, type EffectiveRole } from './matrix';
import { PermissionDenied } from '@/core/errors';

/**
 * The minimum a caller must carry to be authorised. The full AccessContext satisfies it.
 * Kept structural so core/permissions stays free of the database and Next.
 */
export interface AuthzContext {
  readonly effectiveRole: EffectiveRole;
  readonly permissions: ReadonlySet<Permission>;
}

/** Deny by default. `none` holds nothing, ever. */
export function can(ctx: AuthzContext, permission: Permission): boolean {
  if (ctx.effectiveRole === 'none') return false;
  return ctx.permissions.has(permission);
}

export function assertCan(ctx: AuthzContext, permission: Permission): void {
  if (!can(ctx, permission)) {
    throw new PermissionDenied(permission);
  }
}

/** Permissions granted to a role, straight from the matrix. */
export function permissionsFor(role: EffectiveRole): ReadonlySet<Permission> {
  if (role === 'none') return new Set<Permission>();
  return ROLE_MATRIX[role];
}

/**
 * Identity predicates.
 *
 * Authorisation asks `can(ctx, permission)`. A few decisions are genuinely about WHO the caller is
 * rather than what they may do — writing the CD-13 staff-access audit row, showing the "you are
 * MOTION staff" banner — and those belong here, in the one module where comparing an effective-role
 * name is allowed, so the comparison exists in exactly one audited place (R2-A-07).
 */
export function isSuperAdmin(ctx: AuthzContext): boolean {
  return ctx.effectiveRole === 'super_admin';
}

export function isPlatformStaff(ctx: AuthzContext): boolean {
  return ctx.effectiveRole === 'super_admin' || ctx.effectiveRole === 'employee';
}
