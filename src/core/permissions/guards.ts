import type { EffectiveRole } from './matrix';

/**
 * The `◐` restrictions from RBAC_MATRIX.md §2.1 that a permission bit cannot express.
 * Each is mirrored by the same rule inside the api.* function that performs the write
 * (ADR-026), so a bug here cannot become a privilege escalation.
 */

export type MembershipRole = 'owner' | 'admin' | 'client';

const RANK: Record<string, number> = {
  super_admin: 4,
  owner: 3,
  admin: 2,
  client: 1,
};

export function roleRank(role: string): number {
  return RANK[role] ?? 0;
}

/**
 * A user may never grant a role above their own, nor act on a member whose current role is above
 * their own. Admin ceiling is admin (RBAC_MATRIX.md §3.2).
 */
export function ceilingAllows(actorRole: EffectiveRole, subjectRole: string): boolean {
  if (actorRole === 'super_admin') return true;
  const subject = roleRank(subjectRole);
  if (subject === 0) return false;
  if (actorRole === 'owner') return subject <= 3;
  if (actorRole === 'admin') return subject <= 2;
  return false;
}

export function canInviteRole(actorRole: EffectiveRole, targetRole: MembershipRole): boolean {
  return ceilingAllows(actorRole, targetRole);
}

/** Both the current role and the target role must be within the actor's ceiling. */
export function canChangeRole(
  actorRole: EffectiveRole,
  fromRole: MembershipRole,
  toRole: MembershipRole,
): boolean {
  return ceilingAllows(actorRole, fromRole) && ceilingAllows(actorRole, toRole);
}

/** No user may raise their own role, whatever their ceiling (RBAC_MATRIX.md §3.3). */
export function isSelfElevation(
  isSelf: boolean,
  fromRole: MembershipRole,
  toRole: MembershipRole,
): boolean {
  return isSelf && roleRank(toRole) > roleRank(fromRole);
}

/**
 * A super admin creates assignments; an owner of that organization may revoke one
 * (TENANCY_MODEL.md §5.4).
 */
export function canRevokeAssignment(actorRole: EffectiveRole): boolean {
  return actorRole === 'super_admin' || actorRole === 'owner';
}
