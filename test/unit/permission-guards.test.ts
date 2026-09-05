import { describe, it, expect } from 'vitest';
import {
  ceilingAllows,
  canInviteRole,
  canChangeRole,
  canRevokeAssignment,
  isSelfElevation,
  roleRank,
} from '@/core/permissions/guards';

/**
 * The `◐` restrictions from RBAC_MATRIX.md §2.1 that a permission bit cannot express (§3.2, §3.3).
 * Each is mirrored inside the api.* function that performs the write, so these tests describe the
 * friendly-error path; the pgTAP suite proves the authoritative path.
 */

describe('role ceiling (RBAC_MATRIX.md §3.2)', () => {
  it('ranks roles owner > admin > client', () => {
    expect(roleRank('owner')).toBeGreaterThan(roleRank('admin'));
    expect(roleRank('admin')).toBeGreaterThan(roleRank('client'));
    expect(roleRank('nonsense')).toBe(0);
  });

  it('an admin may act on admins and clients, never on owners', () => {
    expect(ceilingAllows('admin', 'client')).toBe(true);
    expect(ceilingAllows('admin', 'admin')).toBe(true);
    expect(ceilingAllows('admin', 'owner')).toBe(false);
  });

  it('an owner may act on any tenant role', () => {
    expect(ceilingAllows('owner', 'owner')).toBe(true);
    expect(ceilingAllows('owner', 'admin')).toBe(true);
    expect(ceilingAllows('owner', 'client')).toBe(true);
  });

  it('a super admin may act on anything', () => {
    expect(ceilingAllows('super_admin', 'owner')).toBe(true);
  });

  it('a client, an employee, a suspended member and `none` may act on nobody', () => {
    for (const actor of ['client', 'employee', 'suspended_member', 'none'] as const) {
      expect(ceilingAllows(actor, 'client')).toBe(false);
      expect(ceilingAllows(actor, 'owner')).toBe(false);
    }
  });

  it('an unknown subject role is never actionable', () => {
    expect(ceilingAllows('owner', 'root')).toBe(false);
  });
});

describe('canInviteRole', () => {
  it('an admin may invite admins and clients but never an owner', () => {
    expect(canInviteRole('admin', 'client')).toBe(true);
    expect(canInviteRole('admin', 'admin')).toBe(true);
    expect(canInviteRole('admin', 'owner')).toBe(false);
  });

  it('an owner and a super admin may invite an owner', () => {
    expect(canInviteRole('owner', 'owner')).toBe(true);
    expect(canInviteRole('super_admin', 'owner')).toBe(true);
  });

  it('an employee may never invite (governance is not theirs)', () => {
    expect(canInviteRole('employee', 'client')).toBe(false);
  });
});

describe('canChangeRole — the ceiling applies to BOTH the current and the target role (F-A-02)', () => {
  it('an admin cannot promote a client to owner', () => {
    expect(canChangeRole('admin', 'client', 'owner')).toBe(false);
  });

  it('an admin cannot demote an owner, even to client', () => {
    expect(canChangeRole('admin', 'owner', 'client')).toBe(false);
  });

  it('an admin may move a client to admin and back', () => {
    expect(canChangeRole('admin', 'client', 'admin')).toBe(true);
    expect(canChangeRole('admin', 'admin', 'client')).toBe(true);
  });

  it('an owner may promote an admin to owner', () => {
    expect(canChangeRole('owner', 'admin', 'owner')).toBe(true);
  });
});

describe('no self-elevation (RBAC_MATRIX.md §3.3)', () => {
  it('flags raising your own role', () => {
    expect(isSelfElevation(true, 'admin', 'owner')).toBe(true);
    expect(isSelfElevation(true, 'client', 'admin')).toBe(true);
  });

  it('allows lowering your own role and changing someone else', () => {
    expect(isSelfElevation(true, 'admin', 'client')).toBe(false);
    expect(isSelfElevation(true, 'admin', 'admin')).toBe(false);
    expect(isSelfElevation(false, 'admin', 'owner')).toBe(false);
  });
});

describe('canRevokeAssignment (TENANCY_MODEL.md §5.4)', () => {
  it('an owner of the organization and a super admin may revoke adviser access', () => {
    expect(canRevokeAssignment('owner')).toBe(true);
    expect(canRevokeAssignment('super_admin')).toBe(true);
  });

  it('nobody else may, including an admin and the employee themselves', () => {
    for (const role of ['admin', 'client', 'employee', 'suspended_member', 'none'] as const) {
      expect(canRevokeAssignment(role)).toBe(false);
    }
  });
});
