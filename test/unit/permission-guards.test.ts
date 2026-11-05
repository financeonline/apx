import { describe, it, expect } from 'vitest';
import {
  ceilingAllows,
  canInviteRole,
  canChangeRole,
  canRevokeAssignment,
  canSetAlertStatus,
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

  it('a Financial Analyst has the owner\'s reach in their companies (ADR-187)', () => {
    expect(ceilingAllows('employee', 'owner')).toBe(true);
    expect(ceilingAllows('employee', 'client')).toBe(true);
    expect(ceilingAllows('employee', 'super_admin')).toBe(false);
    expect(ceilingAllows('employee', 'employee')).toBe(false);
  });

  it('a client, a suspended member and `none` may act on nobody', () => {
    for (const actor of ['client', 'suspended_member', 'none'] as const) {
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

  it('a Financial Analyst may invite into their companies, an owner included (ADR-187)', () => {
    expect(canInviteRole('employee', 'client')).toBe(true);
    expect(canInviteRole('employee', 'owner')).toBe(true);
    expect(canInviteRole('client', 'client')).toBe(false);
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

describe('ADR-172: the accountant and the 3rd party under the ceiling', () => {
  it('both rank with the client, below admin — exactly as app.role_rank', () => {
    expect(roleRank('accountant')).toBe(1);
    expect(roleRank('third_party')).toBe(1);
    expect(roleRank('client')).toBe(1);
    expect(roleRank('admin')).toBeGreaterThan(roleRank('accountant'));
  });

  it('an owner and an admin may invite, move and remove them', () => {
    for (const actor of ['owner', 'admin', 'super_admin'] as const) {
      expect(canInviteRole(actor, 'accountant')).toBe(true);
      expect(canInviteRole(actor, 'third_party')).toBe(true);
      expect(canChangeRole(actor, 'client', 'third_party')).toBe(true);
      expect(canChangeRole(actor, 'third_party', 'accountant')).toBe(true);
      expect(ceilingAllows(actor, 'third_party')).toBe(true);
    }
  });

  it('an admin still cannot make one of them an owner', () => {
    expect(canChangeRole('admin', 'accountant', 'owner')).toBe(false);
    expect(canChangeRole('admin', 'third_party', 'owner')).toBe(false);
  });

  it('neither governs anybody', () => {
    for (const actor of ['accountant', 'third_party'] as const) {
      for (const subject of ['owner', 'admin', 'accountant', 'client', 'third_party']) {
        expect(ceilingAllows(actor, subject)).toBe(false);
      }
    }
  });

  it('moving between client, accountant and 3rd party is never self-elevation, and becoming admin is', () => {
    expect(isSelfElevation(true, 'client', 'accountant')).toBe(false);
    expect(isSelfElevation(true, 'third_party', 'client')).toBe(false);
    expect(isSelfElevation(true, 'accountant', 'admin')).toBe(true);
  });
});

describe('canSetAlertStatus — an allow-list (R2-A-07; ADR-172)', () => {
  it('the owner, admins, the Financial Analyst and the super admin decide', () => {
    for (const role of ['owner', 'admin', 'employee', 'super_admin'] as const) {
      for (const status of ['acknowledged', 'resolved', 'dismissed']) {
        expect(canSetAlertStatus(role, status)).toBe(true);
      }
    }
  });

  it('a client, an accountant and a 3rd party may acknowledge only', () => {
    for (const role of ['client', 'accountant', 'third_party'] as const) {
      expect(canSetAlertStatus(role, 'acknowledged')).toBe(true);
      expect(canSetAlertStatus(role, 'resolved')).toBe(false);
      expect(canSetAlertStatus(role, 'dismissed')).toBe(false);
    }
  });

  it('a suspended member and `none` may do nothing', () => {
    for (const role of ['suspended_member', 'none'] as const) {
      expect(canSetAlertStatus(role, 'acknowledged')).toBe(false);
    }
  });
});
