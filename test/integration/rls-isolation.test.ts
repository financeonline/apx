import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { canReadGlobal, orgRows } from '@/db/rls';
import { organizationDoc } from '@/modules/tenancy';
import { anonClient, clientFor, createAuthUser, fs, rpc, sqlstate } from './setup';
import {
  assign, clientFirestoreRequest, dropAuditOf, dropOrg, dropUsers, idTokenFor, makePlatformUser, rawCount, slugOf,
} from './tenancy-fixtures';

/**
 * The adversarial suite (TEST_STRATEGY.md §4). Everything here runs as a real signed-in person —
 * `clientFor(uid)` through the read policies of `src/db/rls.ts` and the `api.*` guards, or a real
 * Firebase ID token straight at Firestore — so the tenant boundary is the thing actually under
 * test. `fs()` builds fixtures only, never asserts what a user can see.
 */

const RUN = `ri${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.isolation.itest.motion`;
const PASSWORD = 'itest-password-1';
const emailA = `owner-a@${DOMAIN}`;
const emailB = `owner-b@${DOMAIN}`;

let ownerA: string;
let ownerB: string;
let orgA: string;
let orgB: string;
let slugB: string;
let employee: string;

beforeAll(async () => {
  ownerA = await createAuthUser(emailA, PASSWORD);
  ownerB = await createAuthUser(emailB, PASSWORD);

  const created = await rpc<string>(clientFor(ownerA, { email: emailA }), 'create_organization', { p_name: `ITest Alpha ${RUN}` });
  expect(created.error).toBeNull();
  orgA = created.data!;

  const createdB = await rpc<string>(clientFor(ownerB, { email: emailB }), 'create_organization', { p_name: `ITest Beta ${RUN}` });
  expect(createdB.error).toBeNull();
  orgB = createdB.data!;
  slugB = await slugOf(orgB);

  // Something in every table B's owner could leak: an invitation, besides the membership.
  const invited = await rpc(clientFor(ownerB, { email: emailB }), 'invite_member', {
    p_org: orgB, p_email: `someone-b@${DOMAIN}`, p_role: 'client',
  });
  expect(invited.error).toBeNull();
});

afterAll(async () => {
  for (const org of [orgA, orgB]) {
    if (!org) continue;
    await dropAuditOf(org);
    await dropOrg(org);
  }
  await dropUsers([ownerA, ownerB, employee].filter(Boolean));
});

describe('a member sees their own organization and nothing else', () => {
  it('api.my_organizations returns exactly one organization for each owner', async () => {
    const { data, error } = await rpc<Array<{ organization_id: string; role: string }>>(clientFor(ownerA), 'my_organizations');
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data![0]!.organization_id).toBe(orgA);
    expect(data![0]!.role).toBe('owner');
  });

  it('owner A reads nothing of organization B on every tenant table', async () => {
    const a = clientFor(ownerA);
    // The rows exist (so "nothing" is a refusal, not an empty table).
    expect(await rawCount(orgB, 'organization_memberships')).toBe(1);
    expect(await rawCount(orgB, 'invitations')).toBe(1);

    expect(await organizationDoc(a, orgB), 'organizations must expose nothing of B').toBeNull();
    for (const table of ['organization_memberships', 'invitations', 'fiscal_periods', 'accounts'] as const) {
      expect(await orgRows(a, orgB, table), `${table} must expose nothing of organization B`).toHaveLength(0);
    }
    // The trail is served by api.org_audit_events only (ADR-172 hardening): B's is NOT_FOUND to A.
    const trail = await rpc(a, 'org_audit_events', { p_org: orgB });
    expect(sqlstate(trail.error)).toBe('P0002');
  });

  it('platform-class tables expose nothing to a tenant owner', async () => {
    const a = clientFor(ownerA);
    for (const table of ['jobs', 'platform_settings', 'api_rate_limits'] as const) {
      expect(await canReadGlobal(a, table), `${table} must be invisible to a tenant`).toBe(false);
    }
    expect(await orgRows(a, orgA, 'platform_org_settings'), 'even of their own organisation').toHaveLength(0);
  });

  it('profiles is own-row only', async () => {
    const { data } = await rpc<Array<{ user_id: string }>>(clientFor(ownerA), 'my_profile');
    expect(data).toHaveLength(1);
    expect(data![0]!.user_id).toBe(ownerA);
  });
});

describe('no collection is readable or writable by a browser (ADR-026; firebase/firestore.rules)', () => {
  // The Firestore equivalent of "authenticated holds no table privilege": the client SDK's own
  // credential, an ID token, sent straight to Firestore. Every path is refused, own data included.
  const paths = (): Record<string, string> => ({
    organizations: `organizations/${orgA}`,
    profiles: `profiles/${ownerA}`,
    platform_users: `platform_users/${ownerA}`,
    organization_memberships: `organizations/${orgA}/organization_memberships/${ownerA}`,
    organization_assignments: `organizations/${orgA}/organization_assignments/${ownerA}`,
    invitations: `organizations/${orgA}/invitations/probe-${RUN}`,
    ownership_transfers: `organizations/${orgA}/ownership_transfers/probe-${RUN}`,
    audit_events: `audit_events/probe-${RUN}`,
    jobs: `jobs/probe-${RUN}`,
    api_rate_limits: `api_rate_limits/probe-${RUN}`,
    platform_settings: `platform_settings/probe-${RUN}`,
    platform_org_settings: `organizations/${orgA}/platform_org_settings/current`,
  });
  const TABLES = [
    'organizations', 'profiles', 'platform_users', 'organization_memberships', 'organization_assignments',
    'invitations', 'ownership_transfers', 'audit_events', 'jobs', 'api_rate_limits', 'platform_settings',
    'platform_org_settings',
  ];
  let token: string;
  beforeAll(async () => {
    token = await idTokenFor(emailA, PASSWORD);
  });

  it.each(TABLES)('a write to %s is refused', async (table) => {
    expect(await clientFirestoreRequest(token, 'PATCH', paths()[table]!, { name: 'hijacked', role: 'owner' }))
      .toBe(403);
  });

  it.each(TABLES)('a read of %s is refused', async (table) => {
    expect(await clientFirestoreRequest(token, 'GET', paths()[table]!)).toBe(403);
  });

  it('DELETE of a membership is refused', async () => {
    expect(await clientFirestoreRequest(token, 'DELETE', paths().organization_memberships!)).toBe(403);
  });

  it('the membership and the organisation survived every attempt', async () => {
    expect(await rawCount(orgA, 'organization_memberships')).toBe(1);
    expect((await fs().collection('organizations').doc(orgA).get()).get('name')).toBe(`ITest Alpha ${RUN}`);
    expect((await fs().collection('audit_events').doc(`probe-${RUN}`).get()).exists).toBe(false);
  });
});

describe('cross-tenant access is NOT FOUND, never FORBIDDEN (SECURITY_MODEL.md §14)', () => {
  it('api.my_context for another organization returns no row and no error', async () => {
    const { data, error } = await rpc(clientFor(ownerA), 'my_context', { p_slug: slugB });
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('api.update_organization on another organization raises NOT_FOUND, not PERMISSION_DENIED', async () => {
    const { error } = await rpc(clientFor(ownerA), 'update_organization', { p_org: orgB, p_patch: { name: 'hijacked' } });
    expect(error).not.toBeNull();
    expect(sqlstate(error)).toBe('P0002');
    expect((await fs().collection('organizations').doc(orgB).get()).get('name')).toBe(`ITest Beta ${RUN}`);
  });

  it('an invented organization id is indistinguishable from someone else’s', async () => {
    const a = clientFor(ownerA);
    const invented = '00000000-0000-4000-8000-000000000000';
    const real = await rpc(a, 'update_organization', { p_org: orgB, p_patch: { name: 'x' } });
    const fake = await rpc(a, 'update_organization', { p_org: invented, p_patch: { name: 'x' } });
    expect(sqlstate(real.error)).toBe(sqlstate(fake.error));
    expect(real.error?.message).toBe(fake.error?.message);
  });
});

describe('the server-asserted surface is unreachable from a browser (ADR-043)', () => {
  it('api_server.record_access_event cannot be executed as a user', async () => {
    const { error } = await rpc(clientFor(ownerA), 'record_access_event', {
      p_actor: ownerA, p_org: orgA, p_action: 'org.data_viewed',
    }, { server: true });
    expect(sqlstate(error)).toBe('42501');
  });

  it('nor by nobody at all', async () => {
    const { error } = await rpc(anonClient(), 'record_access_event', {
      p_actor: ownerA, p_org: orgA, p_action: 'auth.sign_in',
    }, { server: true });
    expect(sqlstate(error)).toBe('42501');
  });

  it('api_server.enqueue_job cannot be executed as a user', async () => {
    const { error } = await rpc(clientFor(ownerA), 'enqueue_job', {
      p_actor: ownerA, p_org: orgA, p_job_type: 'calculation.run',
    }, { server: true });
    expect(error).not.toBeNull();
    expect(sqlstate(error)).toBe('42501');
  });

  it('a user cannot enqueue org.purge through the user-intent surface', async () => {
    const { error } = await rpc(clientFor(ownerA), 'enqueue_job', { p_org: orgA, p_job_type: 'org.purge', p_payload: {} });
    expect(sqlstate(error)).toBe('42501');
  });
});

describe('platform staff reach only what they are assigned', () => {
  beforeAll(async () => {
    employee = await createAuthUser(`employee@${DOMAIN}`, PASSWORD);
    await makePlatformUser(employee, 'employee');
    await assign(orgA, employee);
  });

  it('an assigned employee sees exactly the assigned organization, as employee', async () => {
    const { data } = await rpc<Array<{ organization_id: string; role: string }>>(clientFor(employee), 'my_organizations');
    expect(data).toHaveLength(1);
    expect(data![0]!.organization_id).toBe(orgA);
    expect(data![0]!.role).toBe('employee');
  });

  it('an employee cannot govern the organization they advise', async () => {
    const { error } = await rpc(clientFor(employee), 'invite_member', {
      p_org: orgA, p_email: `someone@${DOMAIN}`, p_role: 'client',
    });
    expect(sqlstate(error)).toBe('42501');
  });
});
