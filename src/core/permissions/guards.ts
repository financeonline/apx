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

/**
 * Removing a member ends their access on the next request regardless; when the remover is an
 * owner (or a super admin), their sessions are ended as well — the defence against a long-lived
 * tab (SECURITY_MODEL.md §4; ADR-075). An admin removing a client does not reach into sessions.
 */
export function endsSessionsOnRemoval(actorRole: EffectiveRole): boolean {
  return actorRole === 'super_admin' || actorRole === 'owner';
}

/**
 * `alerts.manage` is `◐` for a client: acknowledge only (RBAC_MATRIX.md §2.1).
 *
 * The bit says "may manage alerts", and it cannot say "may say I have seen this, but not decide it
 * is dealt with" — which is the actual rule. Resolving or dismissing is a judgement the
 * organisation's own staff make about their own figures.
 *
 * Mirrored exactly inside `api.set_alert_status` (ADR-026), so a forged request achieves nothing.
 * This copy exists only so the interface can HIDE the buttons a role may not use rather than draw
 * them and refuse (§7.4).
 */
export function canSetAlertStatus(actorRole: EffectiveRole, status: string): boolean {
  /*
   * An ALLOW-LIST, never `role !== 'client'`.
   *
   * The negation reads correctly and is wrong: `suspended_member` is not `client`, so it would fall
   * through to full access — precisely the failure R2-A-07 and ADR-003 are about. Written this way,
   * a role nobody thought of gets nothing.
   */
  if (actorRole === 'client') return status === 'acknowledged';
  return ['owner', 'admin', 'employee', 'super_admin'].includes(actorRole);
}
