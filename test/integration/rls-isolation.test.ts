import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  adminSql,
  clientFor,
  createAuthUser,
  resetFixtures,
  sqlstate,
  PHASE1_TABLES,
} from './setup';

/**
 * The adversarial suite (TEST_STRATEGY.md §4). Everything here runs through a real user JWT so RLS
 * and the api.* guards are the things actually under test; the service key is used only to build
 * fixtures, never to assert what a user can see.
 */

let ownerA: string;
let ownerB: string;
let orgA: string;
let orgB: string;
let slugB: string;

beforeAll(async () => {
  resetFixtures();
  ownerA = createAuthUser('owner-a@itest.motion');
  ownerB = createAuthUser('owner-b@itest.motion');

  const a = clientFor(ownerA, { email: 'owner-a@itest.motion' });
  const b = clientFor(ownerB, { email: 'owner-b@itest.motion' });

  const created = await a.schema('api').rpc('create_organization', { p_name: 'ITest Alpha' });
  expect(created.error).toBeNull();
  orgA = created.data as string;

  const createdB = await b.schema('api').rpc('create_organization', { p_name: 'ITest Beta' });
  expect(createdB.error).toBeNull();
  orgB = createdB.data as string;

  slugB = adminSql(`select slug from public.organizations where id = '${orgB}'`);
});

afterAll(() => resetFixtures());

describe('a member sees their own organization and nothing else', () => {
  it('api.my_organizations returns exactly one organization for each owner', async () => {
    const a = clientFor(ownerA);
    const { data, error } = await a.schema('api').rpc('my_organizations');
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect((data as Array<{ organization_id: string; role: string }>)[0]!.organization_id).toBe(orgA);
    expect((data as Array<{ role: string }>)[0]!.role).toBe('owner');
  });

  it('owner A reads zero rows of organization B on every tenant table', async () => {
    const a = clientFor(ownerA);
    for (const table of ['organizations', 'organization_memberships', 'invitations', 'audit_events'] as const) {
      const column = table === 'organizations' ? 'id' : 'organization_id';
      const { data, error } = await a.from(table).select('*').eq(column, orgB);
      expect(error, `${table} should read cleanly`).toBeNull();
      expect(data, `${table} must expose nothing of organization B`).toHaveLength(0);
    }
  });

  it('platform-class tables expose nothing to a tenant owner', async () => {
    const a = clientFor(ownerA);
    for (const table of ['jobs', 'platform_settings', 'platform_org_settings', 'api_rate_limits'] as const) {
      const { data } = await a.from(table).select('*');
      expect(data ?? [], `${table} must be invisible to a tenant`).toHaveLength(0);
    }
  });

  it('profiles is own-row only', async () => {
    const a = clientFor(ownerA);
    const { data } = await a.from('profiles').select('id');
    expect(data).toHaveLength(1);
    expect(data![0]!.id).toBe(ownerA);
  });
});

describe('no table is writable by an authenticated user (ADR-026)', () => {
  // A real column per table: an empty patch is a no-op and would not exercise the privilege.
  // Each probe carries its own filter VALUE too. A uuid column given the text 'anything' is
  // rejected as 22P02 (invalid input syntax) during parsing, before the privilege check ever
  // runs — which would make the test pass for the wrong reason, or fail for the wrong one.
  // Built lazily: the fixture ids only exist after beforeAll, and a describe body runs at
  // collection time.
  const probes = (): Record<string, { patch: Record<string, unknown>; filter: string; value: string }> => ({
    organizations: { patch: { name: 'hijacked' }, filter: 'id', value: orgA },
    profiles: { patch: { full_name: 'hijacked' }, filter: 'id', value: ownerA },
    platform_users: { patch: { notes: 'hijacked' }, filter: 'user_id', value: ownerA },
    organization_memberships: { patch: { role: 'owner' }, filter: 'organization_id', value: orgA },
    organization_assignments: { patch: { revoked_reason: 'x' }, filter: 'organization_id', value: orgA },
    invitations: { patch: { status: 'revoked' }, filter: 'organization_id', value: orgA },
    ownership_transfers: { patch: { status: 'cancelled' }, filter: 'organization_id', value: orgA },
    audit_events: { patch: { action: 'tampered' }, filter: 'organization_id', value: orgA },
    jobs: { patch: { status: 'cancelled' }, filter: 'organization_id', value: orgA },
    api_rate_limits: { patch: { count: 0 }, filter: 'bucket', value: 'anything' },
    role_permissions: { patch: { permission: 'system.manage' }, filter: 'role', value: 'owner' },
    platform_settings: { patch: { value: 1 }, filter: 'key', value: 'anything' },
    platform_org_settings: { patch: { notes: 'x' }, filter: 'organization_id', value: orgA },
  });

  it.each(PHASE1_TABLES)('UPDATE on %s is refused with 42501', async (table) => {
    const probe = probes()[table]!;
    const a = clientFor(ownerA);
    const { error } = await a
      .from(table)
      .update(probe.patch)
      .eq(probe.filter, probe.value);
    expect(error, `${table} must refuse the write`).not.toBeNull();
    expect(sqlstate(error), `${table} must refuse with a privilege error`).toBe('42501');
  });

  it.each(PHASE1_TABLES)('INSERT into %s is refused with 42501', async (table) => {
    const a = clientFor(ownerA);
    const { error } = await a.from(table).insert(probes()[table]!.patch);
    expect(error, `${table} must refuse the insert`).not.toBeNull();
    expect(sqlstate(error), `${table} must refuse with a privilege error`).toBe('42501');
  });

  it('DELETE on organization_memberships is refused', async () => {
    const a = clientFor(ownerA);
    const { error } = await a.from('organization_memberships').delete().eq('organization_id', orgA);
    expect(error).not.toBeNull();
    expect(sqlstate(error)).toBe('42501');
  });

  it('INSERT into audit_events is refused (F-A-05)', async () => {
    const a = clientFor(ownerA);
    const { error } = await a.from('audit_events').insert({ action: 'forged', actor_type: 'user' });
    expect(error).not.toBeNull();
    expect(sqlstate(error)).toBe('42501');
  });

  it('the membership row survived every attempt', () => {
    expect(adminSql(`select count(*) from public.organization_memberships where organization_id = '${orgA}'`)).toBe('1');
  });
});

describe('cross-tenant access is NOT FOUND, never FORBIDDEN (SECURITY_MODEL.md §14)', () => {
  it('api.my_context for another organization returns no row and no error', async () => {
    const a = clientFor(ownerA);
    const { data, error } = await a.schema('api').rpc('my_context', { p_slug: slugB });
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('api.update_organization on another organization raises NOT_FOUND, not PERMISSION_DENIED', async () => {
    const a = clientFor(ownerA);
    const { error } = await a.schema('api').rpc('update_organization', {
      p_org: orgB,
      p_patch: { name: 'hijacked' },
    });
    expect(error).not.toBeNull();
    expect(sqlstate(error)).toBe('P0002');
    expect(adminSql(`select name from public.organizations where id = '${orgB}'`)).toBe('ITest Beta');
  });

  it('an invented organization id is indistinguishable from someone else’s', async () => {
    const a = clientFor(ownerA);
    const invented = '00000000-0000-4000-8000-000000000000';
    const real = await a.schema('api').rpc('update_organization', { p_org: orgB, p_patch: { name: 'x' } });
    const fake = await a.schema('api').rpc('update_organization', { p_org: invented, p_patch: { name: 'x' } });
    expect(sqlstate(real)).toBe(sqlstate(fake));
  });
});

describe('the server-asserted surface is unreachable from a browser (ADR-043)', () => {
  it('api_server.record_access_event cannot be executed with a user JWT', async () => {
    const a = clientFor(ownerA);
    const { error } = await a.schema('api_server').rpc('record_access_event', {
      p_actor: ownerA,
      p_org: orgA,
      p_action: 'org.data_viewed',
    });
    expect(error).not.toBeNull();
  });

  it('api_server.enqueue_job cannot be executed with a user JWT', async () => {
    const a = clientFor(ownerA);
    const { error } = await a.schema('api_server').rpc('enqueue_job', {
      p_actor: ownerA,
      p_org: orgA,
      p_job_type: 'calculation.run',
    });
    expect(error).not.toBeNull();
  });

  it('a user cannot enqueue org.purge through the user-intent surface', async () => {
    const a = clientFor(ownerA);
    const { error } = await a.schema('api').rpc('enqueue_job', {
      p_org: orgA,
      p_job_type: 'org.purge',
      p_payload: {},
    });
    expect(sqlstate(error)).toBe('42501');
  });
});

describe('platform staff reach only what they are assigned, at the database', () => {
  let employee: string;

  beforeAll(async () => {
    employee = createAuthUser('employee@itest.motion');
    adminSql(`insert into public.platform_users (user_id, platform_role) values ('${employee}','employee')`);
    adminSql(`insert into public.organization_assignments (organization_id, employee_user_id)
              values ('${orgA}','${employee}')`);
  });

  it('an assigned employee sees exactly the assigned organization, as employee', async () => {
    const e = clientFor(employee);
    const { data } = await e.schema('api').rpc('my_organizations');
    expect(data).toHaveLength(1);
    const row = (data as Array<{ organization_id: string; role: string }>)[0]!;
    expect(row.organization_id).toBe(orgA);
    expect(row.role).toBe('employee');
  });

  it('an employee cannot govern the organization they advise', async () => {
    const e = clientFor(employee);
    const { error } = await e.schema('api').rpc('invite_member', {
      p_org: orgA,
      p_email: 'someone@itest.motion',
      p_role: 'client',
    });
    expect(sqlstate(error)).toBe('42501');
  });
});
