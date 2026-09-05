import type { EffectiveRole } from '@/core/permissions';
import type { MembershipRole, OrgStatus } from './types';

/**
 * The pure resolution order from RBAC_MATRIX.md §1. This is the TypeScript twin of
 * app.accessible_org_roles(); a shared fixture file drives both so they cannot disagree
 * (TENANCY_MODEL.md §4, TEST_STRATEGY.md §3).
 */
export interface ResolutionInput {
  readonly aal: 'aal1' | 'aal2';
  readonly platformUser: { role: 'super_admin' | 'employee'; status: 'active' | 'suspended' } | null;
  readonly organizationStatus: OrgStatus | null;
  readonly membership: { role: MembershipRole; status: 'active' | 'suspended' } | null;
  readonly assignment: {
    status: 'active' | 'revoked' | 'expired';
    startsAt: Date | null;
    endsAt: Date | null;
  } | null;
  readonly now: Date;
}

/** MFA is a database fact for every platform user, not only super admins (ADR-044.1; R2-A-03). */
function isActivePlatformUser(input: ResolutionInput): boolean {
  return input.platformUser?.status === 'active' && input.aal === 'aal2';
}

function assignmentIsLive(input: ResolutionInput): boolean {
  const a = input.assignment;
  if (!a || a.status !== 'active') return false;
  if (a.startsAt && a.startsAt > input.now) return false;
  if (a.endsAt && a.endsAt <= input.now) return false;
  return true;
}

export function resolveEffectiveRole(input: ResolutionInput): EffectiveRole {
  const orgStatus = input.organizationStatus;

  // A deleted organization, or one that does not exist, is invisible to everyone.
  if (orgStatus === null || orgStatus === 'deleted') return 'none';

  // 1. Super admin at aal2.
  if (isActivePlatformUser(input) && input.platformUser?.role === 'super_admin') {
    return 'super_admin';
  }

  // 2. Platform employee at aal2 with a live assignment.
  if (
    isActivePlatformUser(input) &&
    input.platformUser?.role === 'employee' &&
    assignmentIsLive(input)
  ) {
    return orgStatus === 'suspended' ? 'suspended_member' : 'employee';
  }

  // 3. Active membership. A suspended membership resolves to nothing at all.
  if (input.membership?.status === 'active') {
    return orgStatus === 'suspended' ? 'suspended_member' : input.membership.role;
  }

  // 4. No implicit access exists anywhere.
  return 'none';
}
