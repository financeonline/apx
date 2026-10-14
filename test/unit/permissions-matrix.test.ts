import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PERMISSIONS, type Permission } from '@/core/permissions/catalogue';
import { ROLE_MATRIX, type GrantedRole } from '@/core/permissions/matrix';
import { can } from '@/core/permissions/check';

/**
 * THE DRIFT GUARD (TEST_STRATEGY.md §2, ADR-003).
 *
 * The fixture is generated from docs/RBAC_MATRIX.md §2.1 at run time, so the document and the code
 * cannot diverge: adding a permission to one without the other fails this suite, and so does
 * flipping a single cell.
 */

const DOC = resolve(process.cwd(), 'docs/RBAC_MATRIX.md');
const COLUMNS = ['super_admin', 'employee', 'owner', 'admin', 'accountant', 'client', 'third_party'] as const;
type Column = (typeof COLUMNS)[number];

interface DocRow {
  permission: string;
  grants: Record<Column, boolean>;
}

function parseMatrix(): DocRow[] {
  const lines = readFileSync(DOC, 'utf8').split('\n');
  const headerIndex = lines.findIndex(
    (l) =>
      l.includes('| Permission |') &&
      COLUMNS.every((c) => l.includes(`| ${c} |`) || l.includes(`| ${c} `)),
  );
  if (headerIndex === -1) throw new Error('Could not find the §2.1 matrix table in RBAC_MATRIX.md');

  const rows: DocRow[] = [];
  for (const line of lines.slice(headerIndex + 2)) {
    if (!line.trimStart().startsWith('|')) break; // table ended
    const cells = line.split('|').map((c) => c.trim());
    // cells[0] is empty (leading pipe); cells[1] is the permission
    const nameCell = cells[1] ?? '';
    const match = nameCell.match(/^`([a-z._]+)`$/);
    if (!match) continue; // separator or a note row
    const permission = match[1]!;
    const grants = {} as Record<Column, boolean>;
    COLUMNS.forEach((col, i) => {
      const cell = cells[2 + i] ?? '';
      // ✓ and ◐ both mean granted; ◐ marks a restriction enforced by a named guard.
      grants[col] = cell.includes('✓') || cell.includes('◐');
    });
    rows.push({ permission, grants });
  }
  return rows;
}

const docRows = parseMatrix();

describe('RBAC_MATRIX.md §2.1 is the source of truth', () => {
  it('parses a non-trivial table', () => {
    expect(docRows.length).toBeGreaterThan(30);
  });

  it('the documented permission set equals the code catalogue, in both directions', () => {
    const documented = new Set(docRows.map((r) => r.permission));
    const coded = new Set<string>(PERMISSIONS);

    const missingFromCode = [...documented].filter((p) => !coded.has(p));
    const missingFromDoc = [...coded].filter((p) => !documented.has(p));

    expect(missingFromCode, 'documented but not in catalogue.ts').toEqual([]);
    expect(missingFromDoc, 'in catalogue.ts but not documented').toEqual([]);
  });

  it.each(COLUMNS)('every cell of the %s column matches ROLE_MATRIX', (role) => {
    for (const row of docRows) {
      const permission = row.permission as Permission;
      const granted = ROLE_MATRIX[role as GrantedRole].has(permission);
      expect(
        granted,
        `${role} × ${permission}: document says ${row.grants[role]}, code says ${granted}`,
      ).toBe(row.grants[role]);
    }
  });

  it.each(COLUMNS)('can() agrees with the document for every %s permission', (role) => {
    const ctx = { effectiveRole: role, permissions: ROLE_MATRIX[role as GrantedRole] } as const;
    for (const row of docRows) {
      expect(can(ctx, row.permission as Permission)).toBe(row.grants[role]);
    }
  });
});

describe('deny by default', () => {
  it('`none` is granted nothing at all', () => {
    const ctx = { effectiveRole: 'none', permissions: new Set<Permission>() } as const;
    for (const permission of PERMISSIONS) {
      expect(can(ctx, permission)).toBe(false);
    }
  });

  it('`none` is denied even if a permission set is somehow attached (R2-A-07)', () => {
    // A defensive case: an inconsistent context must still resolve to denied.
    const ctx = { effectiveRole: 'none', permissions: new Set<Permission>(PERMISSIONS) } as const;
    expect(can(ctx, 'dashboard.view')).toBe(false);
    expect(can(ctx, 'system.manage')).toBe(false);
  });

  it('`suspended_member` holds exactly dashboard.view (ADR-044.4)', () => {
    expect([...ROLE_MATRIX.suspended_member]).toEqual(['dashboard.view']);
    const ctx = { effectiveRole: 'suspended_member', permissions: ROLE_MATRIX.suspended_member } as const;
    expect(can(ctx, 'dashboard.view')).toBe(true);
    expect(can(ctx, 'financials.view')).toBe(false);
    expect(can(ctx, 'settings.manage')).toBe(false);
  });
});

describe('the answers the brief asked for (RBAC_MATRIX.md §2.2)', () => {
  const holds = (role: GrantedRole, p: Permission) => ROLE_MATRIX[role].has(p);

  it('only owner and super admin can invite users; an admin cannot (ADR-174)', () => {
    expect(holds('owner', 'users.invite')).toBe(true);
    expect(holds('admin', 'users.invite')).toBe(false);
    expect(holds('super_admin', 'users.invite')).toBe(true);
    expect(holds('employee', 'users.invite')).toBe(false);
    expect(holds('client', 'users.invite')).toBe(false);
  });

  it('employees operate but never govern (CD-16)', () => {
    for (const p of ['imports.review', 'financials.edit', 'ai.use', 'documents.view'] as Permission[]) {
      expect(holds('employee', p)).toBe(true);
    }
    for (const p of [
      'users.view', 'users.invite', 'users.manage', 'settings.manage',
      'audit.view', 'billing.manage', 'org.delete', 'system.manage',
    ] as Permission[]) {
      expect(holds('employee', p)).toBe(false);
    }
  });

  it('clients read and participate but never write financial data (CD-15)', () => {
    for (const p of ['dashboard.view', 'financials.view', 'ai.use', 'actions.update_own'] as Permission[]) {
      expect(holds('client', p)).toBe(true);
    }
    for (const p of [
      'financials.edit', 'imports.create', 'imports.review', 'documents.view',
      'data.export', 'audit.view', 'settings.manage',
    ] as Permission[]) {
      expect(holds('client', p)).toBe(false);
    }
  });

  it('only a super admin holds platform administration', () => {
    for (const p of [
      'system.manage', 'platform.orgs.manage', 'platform.users.manage', 'platform.jobs.view',
    ] as Permission[]) {
      expect(holds('super_admin', p)).toBe(true);
      expect(holds('owner', p)).toBe(false);
      expect(holds('admin', p)).toBe(false);
      expect(holds('employee', p)).toBe(false);
      expect(holds('client', p)).toBe(false);
    }
  });
});
