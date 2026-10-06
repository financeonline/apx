import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { permissionsFor, type EffectiveRole } from '@/core/permissions';
import { loadHome } from '@/modules/dashboard';
import { loadDepartments } from '@/modules/departments';
import { drainJobs } from '@/modules/jobs';
import type { AccessContext } from '@/modules/tenancy';
import { adminSql, clientFor, createAuthUser, drainUntilFinished } from './setup';

/**
 * The Departmental Dashboard (ADR-143): each tile is shown only to someone who may open its
 * section, its figures are the ones the section shows, and a suspended member sees none of it.
 */

const RUN = `d${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.departments.itest`;
let ownerId: string;
let clientId: string;
let orgId: string;
let orgSlug: string;

const one = (sql: string): string => adminSql(`with q as (${sql}) select * from q`);
const contextFor = (userId: string, role: EffectiveRole): AccessContext => ({
  userId, orgId, orgSlug, effectiveRole: role, permissions: permissionsFor(role), actorType: 'user',
  db: clientFor(userId, { email: `${role}@${DOMAIN}` }), requestId: `itest-${RUN}`, now: () => new Date(), organizationStatus: 'active',
});

beforeAll(async () => {
  ownerId = createAuthUser(`owner@${DOMAIN}`);
  clientId = createAuthUser(`client@${DOMAIN}`);
  const created = await clientFor(ownerId).schema('api').rpc('create_organization', { p_name: `ITest Departments ${RUN}` });
  if (created.error) throw new Error(created.error.message);
  orgId = created.data as unknown as string;
  orgSlug = one(`select slug from public.organizations where id = '${orgId}'`);
  adminSql(`insert into public.organization_memberships (organization_id, user_id, role, status) values ('${orgId}', '${clientId}', 'client', 'active')`);
  const account = (c: string) => one(`select id from public.accounts where organization_id = '${orgId}' and standard_category = '${c}' and is_system`);
  for (const [c, d, a] of [['revenue', 'credit', '20000.00'], ['payroll', 'debit', '25000.00']] as const) {
    const id = one(`insert into public.ledger_entries (organization_id, entry_date, account_id, direction, amount, period_id, record_status)
                    values ('${orgId}', '2026-08-10', '${account(c)}', '${d}', ${a}, '00000000-0000-0000-0000-000000000000', 'accepted') returning id`);
    adminSql(`insert into public.record_status_events (organization_id, record_table, record_id, event) values ('${orgId}', 'ledger_entries', '${id}', 'accepted')`);
  }
  const doc = one(`insert into public.source_documents (organization_id, storage_path, original_filename, mime_type, byte_size, sha256, status, document_kind)
                   values ('${orgId}', '${orgId}/d/gl.csv', 'gl.csv', 'text/csv', 10, decode('e5','hex'), 'ready', 'general_ledger') returning id`);
  adminSql(`insert into public.import_batches (organization_id, source_document_id, import_type, target_table, status, extraction_method, period_start, period_end, committed_at)
            values ('${orgId}', '${doc}', 'general_ledger', 'ledger_entries', 'committed', 'csv', '2026-08-01', '2026-08-31', now())`);
  adminSql(`insert into public.actions (organization_id, title, priority, due_date, status, source_type) values ('${orgId}', 'Overdue thing', 'high', '2026-01-01', 'open', 'user')`);
  const job = adminSql(`insert into public.jobs (organization_id, job_type, payload, max_attempts) values ('${orgId}', 'calculation.run', '{"trigger":"recalc_manual"}'::jsonb, 3) returning id`).split('\n')[0]!.trim();
  expect(await drainUntilFinished(drainJobs, job)).toBe('succeeded');
});

afterAll(() => {
  adminSql(`delete from public.organizations where name like 'ITest Departments%${RUN}'; delete from auth.users where email like '%@${DOMAIN}';`);
});

describe('the departmental dashboard', () => {
  it('shows an owner every department, and how the system is running', async () => {
    const view = await loadDepartments(contextFor(ownerId, 'owner'));
    expect(view.tiles.map((t) => t.key)).toEqual(['finance', 'banking', 'customers', 'actions', 'alerts', 'reports', 'analyst', 'planning']);
    expect(view.system.imports).toMatch(/waiting for review/);
    expect(view.system.team).toMatch(/team/);
    expect(view.system.lastCalculation).toMatch(/^Last calculation finished/);
  });

  it('states the month as Home does — revenue and a loss flagged for attention', async () => {
    const view = await loadDepartments(contextFor(ownerId, 'owner'));
    const home = await loadHome(contextFor(ownerId, 'owner').db, orgId, orgSlug, `itest-${RUN}`);
    if (home.kind !== 'ready') throw new Error('Home must have figures');
    const finance = view.tiles.find((t) => t.key === 'finance')!;
    expect(finance.headline).toContain(home.view.period.label);
    // 20,000 revenue − 25,000 payroll: a loss, so the department needs attention.
    expect(finance.tone).toBe('attention');
    expect(view.tiles.find((t) => t.key === 'actions')).toMatchObject({ tone: 'attention', lines: ['1 overdue, 0 due in the next 7 days.'] });
  });

  it('shows a client only the departments a client may open, and no import or team detail', async () => {
    const view = await loadDepartments(contextFor(clientId, 'client'));
    expect(view.system.imports).toBeNull();
    expect(view.system.team).toBeNull();
    for (const tile of view.tiles) expect(['finance', 'banking', 'customers', 'actions', 'alerts', 'reports', 'analyst', 'planning']).toContain(tile.key);
  });

  it('refuses a suspended member, who keeps only the frozen Home (ADR-044.4)', async () => {
    await expect(loadDepartments(contextFor(clientId, 'suspended_member'))).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });
});
