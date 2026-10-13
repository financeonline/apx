/**
 * The shared resolution fixture (TENANCY_MODEL.md §4, TEST_STRATEGY.md §3, finding F-A-06).
 *
 * One table drives two suites:
 *   - test/unit/resolve-effective-role.test.ts       → the TypeScript twin, resolveEffectiveRole()
 *   - test/integration/resolution-parity.test.ts     → app.org_role() / api.my_context() in SQL
 *
 * If the two ever disagree, the parity suite fails. Nothing here may be weakened to make a case
 * pass: a disagreement is the finding.
 *
 * Time is expressed as an offset in minutes from "now" so the same row can be materialised as a
 * timestamptz in Postgres (`now() + interval 'N minutes'`) and as a Date in Node.
 */

import type { EffectiveRole } from '@/core/permissions';
import type { ResolutionInput } from '@/modules/tenancy';

export type FixtureOrgStatus =
  | 'active'
  | 'suspended'
  | 'pending_deletion'
  | 'deleted'
  /** The organization row does not exist at all (slug swap onto an invented org). */
  | 'missing';

export interface FixturePlatformUser {
  readonly role: 'super_admin' | 'employee';
  readonly status: 'active' | 'suspended';
}

export interface FixtureMembership {
  readonly role: 'owner' | 'admin' | 'accountant' | 'client' | 'third_party';
  readonly status: 'active' | 'suspended';
}

export interface FixtureAssignment {
  readonly status: 'active' | 'revoked' | 'expired';
  /** Minutes from now; null means the column is NULL (assignment has always been in force). */
  readonly startsAtMinutes: number | null;
  /** Minutes from now; null means the column is NULL — NOT storable, see `dbRepresentable`. */
  readonly endsAtMinutes: number | null;
}

export interface ResolutionScenario {
  readonly id: string;
  readonly description: string;
  readonly platformUser: FixturePlatformUser | null;
  readonly membership: FixtureMembership | null;
  readonly assignment: FixtureAssignment | null;
  readonly organizationStatus: FixtureOrgStatus;
  readonly expected: EffectiveRole;
  /**
   * False when the row combination cannot be created in Postgres because a constraint forbids it
   * (so the scenario exercises the TypeScript twin only). Every `false` carries a reason.
   */
  readonly dbRepresentable: boolean;
  readonly dbSkipReason?: string;
}

const YEAR = 525_600; // minutes
const DAY = 1_440;

/** An assignment that is live right now: no start bound, ends in a year. */
const LIVE: FixtureAssignment = { status: 'active', startsAtMinutes: null, endsAtMinutes: YEAR };

export const RESOLUTION_SCENARIOS: readonly ResolutionScenario[] = [
  // ---------------------------------------------------------------------------
  // A. Tenant membership only (no platform role). 
  // ---------------------------------------------------------------------------
  {
    id: 'member-owner-active-org-active',
    description: 'active owner of an active organization',
    platformUser: null,
    membership: { role: 'owner', status: 'active' },
    assignment: null,
    organizationStatus: 'active',
    expected: 'owner',
    dbRepresentable: true,
  },
  {
    id: 'member-admin-active-org-active',
    description: 'active admin of an active organization',
    platformUser: null,
    membership: { role: 'admin', status: 'active' },
    assignment: null,
    organizationStatus: 'active',
    expected: 'admin',
    dbRepresentable: true,
  },
  {
    id: 'member-client-active-org-active',
    description: 'active client of an active organization',
    platformUser: null,
    membership: { role: 'client', status: 'active' },
    assignment: null,
    organizationStatus: 'active',
    expected: 'client',
    dbRepresentable: true,
  },
  // ADR-172: the two new company roles resolve to themselves, and freeze and vanish exactly as a
  // client does — neither is a widening of anything.
  {
    id: 'member-accountant-active-org-active',
    description: 'active accountant of an active organization',
    platformUser: null,
    membership: { role: 'accountant', status: 'active' },
    assignment: null,
    organizationStatus: 'active',
    expected: 'accountant',
    dbRepresentable: true,
  },
  {
    id: 'member-third-party-active-org-active',
    description: 'active 3rd party of an active organization',
    platformUser: null,
    membership: { role: 'third_party', status: 'active' },
    assignment: null,
    organizationStatus: 'active',
    expected: 'third_party',
    dbRepresentable: true,
  },
  {
    id: 'member-third-party-suspended-org-active',
    description: 'a deactivated 3rd party resolves to none',
    platformUser: null,
    membership: { role: 'third_party', status: 'suspended' },
    assignment: null,
    organizationStatus: 'active',
    expected: 'none',
    dbRepresentable: true,
  },
  {
    id: 'member-accountant-org-suspended',
    description: 'a suspended organization freezes its accountant to suspended_member',
    platformUser: null,
    membership: { role: 'accountant', status: 'active' },
    assignment: null,
    organizationStatus: 'suspended',
    expected: 'suspended_member',
    dbRepresentable: true,
  },
  {
    id: 'member-third-party-org-suspended',
    description: 'a suspended organization freezes its 3rd party to suspended_member',
    platformUser: null,
    membership: { role: 'third_party', status: 'active' },
    assignment: null,
    organizationStatus: 'suspended',
    expected: 'suspended_member',
    dbRepresentable: true,
  },
  {
    id: 'member-owner-suspended-org-active',
    description: 'suspended owner membership resolves to nothing at all (ADR-044.4)',
    platformUser: null,
    membership: { role: 'owner', status: 'suspended' },
    assignment: null,
    organizationStatus: 'active',
    expected: 'none',
    dbRepresentable: true,
  },
  {
    id: 'member-admin-suspended-org-active',
    description: 'suspended admin membership resolves to none',
    platformUser: null,
    membership: { role: 'admin', status: 'suspended' },
    assignment: null,
    organizationStatus: 'active',
    expected: 'none',
    dbRepresentable: true,
  },
  {
    id: 'member-client-suspended-org-active',
    description: 'suspended client membership resolves to none, never to a widened role (R2-A-07)',
    platformUser: null,
    membership: { role: 'client', status: 'suspended' },
    assignment: null,
    organizationStatus: 'active',
    expected: 'none',
    dbRepresentable: true,
  },
  {
    id: 'member-owner-org-suspended',
    description: 'a suspended organization freezes its owner to suspended_member',
    platformUser: null,
    membership: { role: 'owner', status: 'active' },
    assignment: null,
    organizationStatus: 'suspended',
    expected: 'suspended_member',
    dbRepresentable: true,
  },
  {
    id: 'member-admin-org-suspended',
    description: 'a suspended organization freezes its admin to suspended_member',
    platformUser: null,
    membership: { role: 'admin', status: 'active' },
    assignment: null,
    organizationStatus: 'suspended',
    expected: 'suspended_member',
    dbRepresentable: true,
  },
  {
    id: 'member-client-org-suspended',
    description: 'a suspended organization freezes its client to suspended_member',
    platformUser: null,
    membership: { role: 'client', status: 'active' },
    assignment: null,
    organizationStatus: 'suspended',
    expected: 'suspended_member',
    dbRepresentable: true,
  },
  {
    id: 'member-owner-suspended-org-suspended',
    description: 'suspended membership in a suspended organization is still none',
    platformUser: null,
    membership: { role: 'owner', status: 'suspended' },
    assignment: null,
    organizationStatus: 'suspended',
    expected: 'none',
    dbRepresentable: true,
  },
  {
    id: 'member-owner-org-pending-deletion',
    description: 'pending_deletion keeps the organization reachable so the owner can cancel',
    platformUser: null,
    membership: { role: 'owner', status: 'active' },
    assignment: null,
    organizationStatus: 'pending_deletion',
    expected: 'owner',
    dbRepresentable: true,
  },
  {
    id: 'member-admin-org-pending-deletion',
    description: 'admin of an organization scheduled for deletion keeps their role',
    platformUser: null,
    membership: { role: 'admin', status: 'active' },
    assignment: null,
    organizationStatus: 'pending_deletion',
    expected: 'admin',
    dbRepresentable: true,
  },
  {
    id: 'member-client-org-pending-deletion',
    description: 'client of an organization scheduled for deletion keeps their role',
    platformUser: null,
    membership: { role: 'client', status: 'active' },
    assignment: null,
    organizationStatus: 'pending_deletion',
    expected: 'client',
    dbRepresentable: true,
  },
  {
    id: 'member-owner-org-deleted',
    description: 'a deleted organization is invisible to its own owner',
    platformUser: null,
    membership: { role: 'owner', status: 'active' },
    assignment: null,
    organizationStatus: 'deleted',
    expected: 'none',
    dbRepresentable: true,
  },
  {
    id: 'member-admin-org-deleted',
    description: 'a deleted organization is invisible to its admin',
    platformUser: null,
    membership: { role: 'admin', status: 'active' },
    assignment: null,
    organizationStatus: 'deleted',
    expected: 'none',
    dbRepresentable: true,
  },
  {
    id: 'member-client-org-deleted',
    description: 'a deleted organization is invisible to its client',
    platformUser: null,
    membership: { role: 'client', status: 'active' },
    assignment: null,
    organizationStatus: 'deleted',
    expected: 'none',
    dbRepresentable: true,
  },
  {
    id: 'stranger-org-active',
    description: 'no membership at all: a stranger to an existing organization',
    platformUser: null,
    membership: null,
    assignment: null,
    organizationStatus: 'active',
    expected: 'none',
    dbRepresentable: true,
  },
  {
    id: 'stranger-org-missing',
    description: 'slug swap onto an organization that does not exist',
    platformUser: null,
    membership: null,
    assignment: null,
    organizationStatus: 'missing',
    expected: 'none',
    dbRepresentable: true,
  },

  // ---------------------------------------------------------------------------
  // B. Super admin (ADR-161: a password sign-in counts; there is no two-step).
  // ---------------------------------------------------------------------------
  {
    id: 'super-admin-org-active',
    description: 'active super admin reaches every live organization',
    platformUser: { role: 'super_admin', status: 'active' },
    membership: null,
    assignment: null,
    organizationStatus: 'active',
    expected: 'super_admin',
    dbRepresentable: true,
  },
  {
    id: 'super-admin-org-suspended',
    description: 'a super admin is not frozen by organization suspension',
    platformUser: { role: 'super_admin', status: 'active' },
    membership: null,
    assignment: null,
    organizationStatus: 'suspended',
    expected: 'super_admin',
    dbRepresentable: true,
  },
  {
    id: 'super-admin-org-pending-deletion',
    description: 'a super admin can still reach an organization scheduled for deletion',
    platformUser: { role: 'super_admin', status: 'active' },
    membership: null,
    assignment: null,
    organizationStatus: 'pending_deletion',
    expected: 'super_admin',
    dbRepresentable: true,
  },
  {
    id: 'super-admin-org-deleted',
    description: 'a deleted organization is invisible even to a super admin',
    platformUser: { role: 'super_admin', status: 'active' },
    membership: null,
    assignment: null,
    organizationStatus: 'deleted',
    expected: 'none',
    dbRepresentable: true,
  },
  {
    id: 'super-admin-org-missing',
    description: 'a super admin gets nothing for an organization that does not exist',
    platformUser: { role: 'super_admin', status: 'active' },
    membership: null,
    assignment: null,
    organizationStatus: 'missing',
    expected: 'none',
    dbRepresentable: true,
  },
  {
    id: 'super-admin-suspended-org-active',
    description: 'a suspended platform grant is worth nothing',
    platformUser: { role: 'super_admin', status: 'suspended' },
    membership: null,
    assignment: null,
    organizationStatus: 'active',
    expected: 'none',
    dbRepresentable: true,
  },
  {
    id: 'super-admin-with-assignment',
    description: 'super admin wins over the employee branch when both could match',
    platformUser: { role: 'super_admin', status: 'active' },
    membership: null,
    assignment: LIVE,
    organizationStatus: 'active',
    expected: 'super_admin',
    dbRepresentable: true,
  },
  {
    id: 'super-admin-org-suspended-with-assignment',
    description: 'a suspended organization does not degrade a super admin to suspended_member',
    platformUser: { role: 'super_admin', status: 'active' },
    membership: null,
    assignment: LIVE,
    organizationStatus: 'suspended',
    expected: 'super_admin',
    dbRepresentable: true,
  },

  // ---------------------------------------------------------------------------
  // C. Platform employee — the assignment window.
  // ---------------------------------------------------------------------------
  {
    id: 'employee-live-assignment-org-active',
    description: 'assigned employee on an active organization',
    platformUser: { role: 'employee', status: 'active' },
    membership: null,
    assignment: LIVE,
    organizationStatus: 'active',
    expected: 'employee',
    dbRepresentable: true,
  },
  {
    id: 'employee-live-assignment-org-suspended',
    description: 'an assigned employee is frozen with everyone else when the org is suspended',
    platformUser: { role: 'employee', status: 'active' },
    membership: null,
    assignment: LIVE,
    organizationStatus: 'suspended',
    expected: 'suspended_member',
    dbRepresentable: true,
  },
  {
    id: 'employee-live-assignment-org-pending-deletion',
    description: 'an assigned employee keeps their role while the organization winds down',
    platformUser: { role: 'employee', status: 'active' },
    membership: null,
    assignment: LIVE,
    organizationStatus: 'pending_deletion',
    expected: 'employee',
    dbRepresentable: true,
  },
  {
    id: 'employee-live-assignment-org-deleted',
    description: 'a deleted organization is invisible to an assigned employee',
    platformUser: { role: 'employee', status: 'active' },
    membership: null,
    assignment: LIVE,
    organizationStatus: 'deleted',
    expected: 'none',
    dbRepresentable: true,
  },
  {
    id: 'employee-revoked-assignment',
    description: 'a revoked assignment is worth nothing',
    platformUser: { role: 'employee', status: 'active' },
    membership: null,
    assignment: { status: 'revoked', startsAtMinutes: null, endsAtMinutes: YEAR },
    organizationStatus: 'active',
    expected: 'none',
    dbRepresentable: true,
  },
  {
    id: 'employee-expired-status-assignment',
    description: 'an assignment marked expired is worth nothing',
    platformUser: { role: 'employee', status: 'active' },
    membership: null,
    assignment: { status: 'expired', startsAtMinutes: null, endsAtMinutes: YEAR },
    organizationStatus: 'active',
    expected: 'none',
    dbRepresentable: true,
  },
  {
    id: 'employee-assignment-ended',
    description: 'an active assignment whose ends_at has passed yields nothing, with no cleanup job',
    platformUser: { role: 'employee', status: 'active' },
    membership: null,
    assignment: { status: 'active', startsAtMinutes: -DAY, endsAtMinutes: -60 },
    organizationStatus: 'active',
    expected: 'none',
    dbRepresentable: true,
  },
  {
    id: 'employee-assignment-not-started',
    description: 'an assignment whose starts_at is in the future is not yet live',
    platformUser: { role: 'employee', status: 'active' },
    membership: null,
    assignment: { status: 'active', startsAtMinutes: DAY, endsAtMinutes: YEAR },
    organizationStatus: 'active',
    expected: 'none',
    dbRepresentable: true,
  },
  {
    id: 'employee-assignment-started-in-past',
    description: 'an assignment that started yesterday is live',
    platformUser: { role: 'employee', status: 'active' },
    membership: null,
    assignment: { status: 'active', startsAtMinutes: -DAY, endsAtMinutes: YEAR },
    organizationStatus: 'active',
    expected: 'employee',
    dbRepresentable: true,
  },
  {
    id: 'employee-no-assignment',
    description: 'an employee with no assignment is identical to a stranger',
    platformUser: { role: 'employee', status: 'active' },
    membership: null,
    assignment: null,
    organizationStatus: 'active',
    expected: 'none',
    dbRepresentable: true,
  },
  {
    id: 'employee-suspended-live-assignment',
    description: 'a suspended platform employee loses the assignment branch',
    platformUser: { role: 'employee', status: 'suspended' },
    membership: null,
    assignment: LIVE,
    organizationStatus: 'active',
    expected: 'none',
    dbRepresentable: true,
  },
  {
    id: 'employee-revoked-assignment-org-suspended',
    description: 'a revoked assignment gets nothing even from a suspended organization',
    platformUser: { role: 'employee', status: 'active' },
    membership: null,
    assignment: { status: 'revoked', startsAtMinutes: null, endsAtMinutes: YEAR },
    organizationStatus: 'suspended',
    expected: 'none',
    dbRepresentable: true,
  },
  {
    id: 'employee-live-assignment-org-missing',
    description: 'an assignment cannot outlive the organization it points at',
    platformUser: { role: 'employee', status: 'active' },
    membership: null,
    assignment: LIVE,
    organizationStatus: 'missing',
    expected: 'none',
    dbRepresentable: false,
    dbSkipReason:
      'organization_assignments.organization_id is a foreign key: an assignment to a non-existent organization cannot be stored.',
  },
  {
    id: 'employee-assignment-open-ended',
    description: 'an assignment with no end date is live indefinitely',
    platformUser: { role: 'employee', status: 'active' },
    membership: null,
    assignment: { status: 'active', startsAtMinutes: null, endsAtMinutes: null },
    organizationStatus: 'active',
    expected: 'employee',
    dbRepresentable: false,
    dbSkipReason:
      'organization_assignments.ends_at is NOT NULL (defaults to now() + 12 months), so a NULL end date cannot be stored.',
  },

  // ---------------------------------------------------------------------------
  // D. Combinations Postgres forbids — the TypeScript twin must still be correct,
  //    because it is what a service would compute if a constraint were ever dropped.
  // ---------------------------------------------------------------------------
  {
    id: 'no-platform-user-but-live-assignment',
    description: 'an assignment without a platform grant confers nothing',
    platformUser: null,
    membership: null,
    assignment: LIVE,
    organizationStatus: 'active',
    expected: 'none',
    dbRepresentable: false,
    dbSkipReason:
      'organization_assignments.employee_user_id references platform_users(user_id): the row cannot exist without a platform grant.',
  },
  {
    id: 'member-owner-plus-live-assignment',
    description: 'membership still wins for a non-platform user carrying a stray assignment',
    platformUser: null,
    membership: { role: 'owner', status: 'active' },
    assignment: LIVE,
    organizationStatus: 'active',
    expected: 'owner',
    dbRepresentable: false,
    dbSkipReason:
      'organization_assignments.employee_user_id references platform_users(user_id), and the platform_user_exclusivity trigger forbids a platform user holding a membership.',
  },
  {
    id: 'employee-live-assignment-plus-membership',
    description: 'the assignment branch precedes the membership branch',
    platformUser: { role: 'employee', status: 'active' },
    membership: { role: 'client', status: 'active' },
    assignment: LIVE,
    organizationStatus: 'active',
    expected: 'employee',
    dbRepresentable: false,
    dbSkipReason:
      'the platform_user_exclusivity trigger forbids a platform user holding an organization membership.',
  },
  {
    id: 'super-admin-plus-membership',
    description: 'the super-admin branch precedes the membership branch',
    platformUser: { role: 'super_admin', status: 'active' },
    membership: { role: 'client', status: 'active' },
    assignment: null,
    organizationStatus: 'active',
    expected: 'super_admin',
    dbRepresentable: false,
    dbSkipReason:
      'the platform_user_exclusivity trigger forbids a platform user holding an organization membership.',
  },
  {
    id: 'suspended-platform-user-falls-back-to-membership',
    description: 'a suspended platform grant does not shadow an ordinary membership',
    platformUser: { role: 'employee', status: 'suspended' },
    membership: { role: 'admin', status: 'active' },
    assignment: null,
    organizationStatus: 'active',
    expected: 'admin',
    dbRepresentable: false,
    dbSkipReason:
      'the platform_user_exclusivity trigger forbids a platform user holding an organization membership.',
  },
];

function offsetToDate(minutes: number | null, now: Date): Date | null {
  return minutes === null ? null : new Date(now.getTime() + minutes * 60_000);
}

/** Materialise a scenario as the input the pure resolver takes. */
export function toResolutionInput(
  scenario: ResolutionScenario,
  now: Date = new Date(),
): ResolutionInput {
  return {
    platformUser: scenario.platformUser,
    organizationStatus:
      scenario.organizationStatus === 'missing' ? null : scenario.organizationStatus,
    membership: scenario.membership,
    assignment: scenario.assignment
      ? {
          status: scenario.assignment.status,
          startsAt: offsetToDate(scenario.assignment.startsAtMinutes, now),
          endsAt: offsetToDate(scenario.assignment.endsAtMinutes, now),
        }
      : null,
    now,
  };
}

/** The subset the database can actually hold, replayed by the parity suite. */
export const DB_REPRESENTABLE_SCENARIOS: readonly ResolutionScenario[] =
  RESOLUTION_SCENARIOS.filter((s) => s.dbRepresentable);
