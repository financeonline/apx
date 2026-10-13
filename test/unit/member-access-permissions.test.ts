import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PERMISSIONS, type Permission } from '@/core/permissions/catalogue';
import { ROLE_MATRIX, type EffectiveRole } from '@/core/permissions/matrix';
import { can } from '@/core/permissions/check';
import {
  SWITCHABLE_PERMISSIONS,
  TENANT_ROLES,
  ROLE_NAMES,
  PERMISSION_WORDS,
  agreedPermissions,
  isSwitchable,
  mayRequestAccess,
  parseOverrides,
  resolvePermissions,
  switchableDefaults,
  switchableEffective,
  takesSwitches,
  withinOwnRights,
} from '@/modules/tenancy';

/**
 * Effective permissions in TypeScript (ADR-172): role defaults, then the person's switches — the
 * twin of `app.effective_permission`. The integration suite drives both against the same rows; this
 * file pins the rule itself, and pins the SQL switchable list to the contract's.
 */

const ALL_ROLES: readonly EffectiveRole[] = [
  'super_admin', 'employee', 'owner', 'admin', 'accountant', 'client', 'third_party', 'suspended_member', 'none',
];

describe('the contract and the code agree', () => {
  it('every tenant role has a matrix row and a name', () => {
    for (const role of TENANT_ROLES) {
      expect(ROLE_MATRIX[role], role).toBeDefined();
      expect(ROLE_NAMES[role]).toMatch(/\S/);
    }
    expect(ROLE_NAMES.employee).toBe('Financial Analyst');
  });

  it('every switchable permission is a real permission with plain words', () => {
    for (const p of SWITCHABLE_PERMISSIONS) {
      expect(PERMISSIONS).toContain(p);
      expect(PERMISSION_WORDS[p].title).toMatch(/\S/);
    }
  });

  it('nothing that governs the team, the company or the platform is switchable', () => {
    for (const p of PERMISSIONS) {
      if (/^(users|assignments|platform)\.|^(settings\.manage|billing\.manage|org\.delete|system\.manage)$/.test(p)) {
        expect(isSwitchable(p), p).toBe(false);
      }
    }
  });

  it('the SQL switchable list (app.switchable_permissions) equals the contract, in order', () => {
    const sql = readFileSync(resolve(process.cwd(), 'supabase/migrations/20261018000019_member_access.sql'), 'utf8');
    const body = sql.slice(sql.indexOf('create function app.switchable_permissions()'));
    const array = body.slice(body.indexOf('array['), body.indexOf(']::text[]'));
    const listed = [...array.matchAll(/'([a-z_.]+)'/g)].map((m) => m[1]);
    expect(listed).toEqual([...SWITCHABLE_PERMISSIONS]);
  });

  it('the SQL overridable roles (app.overridable_role) are exactly the roles that take switches', () => {
    const sql = readFileSync(resolve(process.cwd(), 'supabase/migrations/20261018000019_member_access.sql'), 'utf8');
    const body = sql.slice(sql.indexOf('create function app.overridable_role'));
    const listed = [...body.slice(0, body.indexOf('$$;')).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
    expect(listed).toEqual(ALL_ROLES.filter(takesSwitches).sort());
  });
});

describe('the new roles’ defaults (RBAC_MATRIX.md §2.1)', () => {
  it('a 3rd party holds the overview and the reports, nothing else', () => {
    expect([...ROLE_MATRIX.third_party].sort()).toEqual(['dashboard.view', 'reports.view']);
  });

  it('an accountant captures data and keeps compliance, without AI, team, settings or assigning', () => {
    const acc = ROLE_MATRIX.accountant;
    for (const p of ['imports.create', 'imports.review', 'financials.edit', 'banking.reconcile', 'documents.view',
      'data.export', 'reports.generate', 'intelligence.recompute', 'alerts.manage'] as Permission[]) {
      expect(acc.has(p), p).toBe(true);
    }
    for (const p of ['ai.use', 'users.view', 'users.invite', 'users.manage', 'assignments.view', 'assignments.manage',
      'audit.view', 'settings.manage', 'billing.manage', 'org.delete', 'actions.assign'] as Permission[]) {
      expect(acc.has(p), p).toBe(false);
    }
  });
});

describe('who takes switches', () => {
  it('only admin, accountant, client and 3rd party', () => {
    expect(ALL_ROLES.filter(takesSwitches).sort()).toEqual(['accountant', 'admin', 'client', 'third_party']);
  });

  it('only they may ask for more access', () => {
    for (const role of ALL_ROLES) expect(mayRequestAccess(role), role).toBe(takesSwitches(role));
  });

  it('an unknown role takes none (allow-list)', () => {
    expect(takesSwitches('root')).toBe(false);
  });
});

describe('resolvePermissions', () => {
  it('with no switches it is the role’s defaults, for every role', () => {
    for (const role of ALL_ROLES) {
      const expected = role === 'none' ? [] : [...ROLE_MATRIX[role]];
      expect([...resolvePermissions(role, [])].sort()).toEqual(expected.sort());
    }
  });

  it('a switch adds and takes away for a member', () => {
    const p = resolvePermissions('client', [
      { permission: 'documents.view', granted: true },
      { permission: 'financials.view', granted: false },
    ]);
    expect(p.has('documents.view')).toBe(true);
    expect(p.has('financials.view')).toBe(false);
    expect(p.has('banking.view')).toBe(true);
  });

  it('opens the detail for a 3rd party, one permission at a time', () => {
    const p = resolvePermissions('third_party', [{ permission: 'financials.view', granted: true }]);
    expect([...p].sort()).toEqual(['dashboard.view', 'financials.view', 'reports.view']);
  });

  it('is ignored for an owner, APX staff, a suspended member and `none`', () => {
    const off = [{ permission: 'financials.view', granted: false }] as const;
    const on = [{ permission: 'documents.view', granted: true }] as const;
    for (const role of ['owner', 'super_admin', 'employee'] as const) {
      expect(resolvePermissions(role, off).has('financials.view'), role).toBe(true);
    }
    expect(resolvePermissions('suspended_member', on).has('documents.view')).toBe(false);
    expect(resolvePermissions('none', on).size).toBe(0);
  });

  it('can never add a permission that is not switchable', () => {
    const forged = [{ permission: 'users.manage', granted: true }] as unknown as Parameters<typeof resolvePermissions>[1];
    expect(resolvePermissions('client', forged).has('users.manage')).toBe(false);
  });

  it('`can` still denies everything to `none`, whatever the set says', () => {
    expect(can({ effectiveRole: 'none', permissions: resolvePermissions('admin', []) }, 'dashboard.view')).toBe(false);
  });
});

describe('parseOverrides — the database’s JSON, never trusted', () => {
  it('keeps well-formed switchable rows, once each', () => {
    expect(parseOverrides([
      { permission: 'ai.use', granted: false },
      { permission: 'ai.use', granted: true },
      { permission: 'users.manage', granted: true },
      { permission: 'documents.view', granted: 'yes' },
      null,
      'x',
      { permission: 'documents.view', granted: true },
    ])).toEqual([
      { permission: 'ai.use', granted: false },
      { permission: 'documents.view', granted: true },
    ]);
  });

  it('anything that is not an array is no switches', () => {
    expect(parseOverrides(null)).toEqual([]);
    expect(parseOverrides({ permission: 'ai.use', granted: true })).toEqual([]);
  });
});

describe('the team page’s view of one person', () => {
  it('defaults and effective are in the contract’s order', () => {
    expect(switchableDefaults('third_party')).toEqual(['dashboard.view', 'reports.view']);
    expect(switchableEffective('third_party', [{ permission: 'documents.view', granted: true }]))
      .toEqual(['dashboard.view', 'reports.view', 'documents.view']);
    expect(switchableEffective('owner', [{ permission: 'ai.use', granted: false }])).toContain('ai.use');
  });
});

describe('withinOwnRights — the copy of the SQL “never beyond your own rights”', () => {
  const base = { targetRole: 'client' as const, permission: 'ai.use' as const };
  it('a viewer who holds the permission may do anything with it', () => {
    expect(withinOwnRights({ ...base, viewerHolds: true, current: null, next: true })).toBe(true);
  });
  it('a viewer who lacks it may not switch it on', () => {
    expect(withinOwnRights({ ...base, viewerHolds: false, current: null, next: true })).toBe(false);
  });
  it('… may switch it off', () => {
    expect(withinOwnRights({ ...base, viewerHolds: false, current: null, next: false })).toBe(true);
  });
  it('… may not reset to a default that grants it after it was switched off', () => {
    expect(withinOwnRights({ ...base, viewerHolds: false, current: false, next: null })).toBe(false);
  });
  it('… may reset a switch-on back to a default that lacks it', () => {
    expect(withinOwnRights({ targetRole: 'third_party', permission: 'ai.use', viewerHolds: false, current: true, next: null }))
      .toBe(true);
  });
});

describe('agreedPermissions — the resolver keeps only what both twins grant', () => {
  it('equal answers pass through', () => {
    const db = [...ROLE_MATRIX.client];
    const r = agreedPermissions('client', [], db);
    expect([...r.agreed].sort()).toEqual(db.sort());
    expect(r.onlyComputed).toEqual([]);
    expect(r.onlyDatabase).toEqual([]);
  });

  it('a permission only the database grants is NOT given', () => {
    const r = agreedPermissions('third_party', [], ['dashboard.view', 'reports.view', 'financials.view']);
    expect(r.agreed.has('financials.view')).toBe(false);
    expect(r.onlyDatabase).toEqual(['financials.view']);
  });

  it('a permission only TypeScript grants is NOT given', () => {
    const r = agreedPermissions('third_party', [{ permission: 'documents.view', granted: true }], ['dashboard.view', 'reports.view']);
    expect(r.agreed.has('documents.view')).toBe(false);
    expect(r.onlyComputed).toEqual(['documents.view']);
  });

  it('unknown strings from the database are dropped; no database answer means nothing', () => {
    expect([...agreedPermissions('owner', [], ['dashboard.view', 'root.everything']).agreed]).toEqual(['dashboard.view']);
    expect(agreedPermissions('owner', [], null).agreed.size).toBe(0);
  });
});
