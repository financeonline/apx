import type { EffectiveRole } from './matrix';

/**
 * The `◐` restrictions from RBAC_MATRIX.md §2.1 that a permission bit cannot express.
 * Each is mirrored by the same rule inside the api.* function that performs the write
 * (ADR-026), so a bug here cannot become a privilege escalation.
 */

/**
 * Every company role (ADR-172 adds `accountant` and `third_party`). The same five strings as
 * `TENANT_ROLES` in the tenancy contract; spelled here because core must not import modules (ADR-022).
 */
export type MembershipRole = 'owner' | 'admin' | 'accountant' | 'client' | 'third_party';

/**
 * The ceiling ranks, mirrored exactly by `app.role_rank` (20261018000019).
 *
 * `accountant` and `third_party` rank with `client` at 1: none of the three governs anything (no
 * `users.*` — and `users.*` cannot be switched on per person), so the ceiling only needs them BELOW
 * admin. That is what lets an owner or an admin invite them, move a member between them and remove
 * them, and what keeps self-elevation impossible: nobody at rank 1 holds `users.manage`.
 */
const RANK: Record<string, number> = {
  super_admin: 4,
  owner: 3,
  admin: 2,
  accountant: 1,
  client: 1,
  third_party: 1,
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
  // ADR-187: a Financial Analyst has the owner's reach in the companies they created or were given.
  if (actorRole === 'owner' || actorRole === 'employee') return subject <= 3;
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
  return actorRole === 'super_admin' || actorRole === 'owner' || actorRole === 'employee';
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
   *
   * ADR-172: the accountant's `alerts.manage` is the client's — acknowledge only — and so is a 3rd
   * party's when the owner switches it on for them. Deciding that a concern is dealt with stays with
   * the organisation's owner, its admins and its Financial Analyst.
   */
  if (['owner', 'admin', 'employee', 'super_admin'].includes(actorRole)) return true;
  if (['accountant', 'client', 'third_party'].includes(actorRole)) return status === 'acknowledged';
  return false;
}
