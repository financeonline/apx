import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withOrgScope } from '@/core/db';
import { auth } from '@/db/firestore';
import { releaseQueuedGuard } from '@/db/app/jobs';
import { globalRow, nowIso, orgCollection, orgRow } from '@/db/schema';
import { runOrgPurgeJob } from '@/modules/jobs';
import { clientFor, createAuthUser, deleteOrg, fs, rpc, sqlstate } from './setup';

/**
 * ADR-158 over the real wire: only a super admin (recent sign-in) switches a company's systems,
 * creates a company (without becoming its member; the owner is invited) and lists the staff.
 */

const RUN = `pc${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.platform.itest.motion`;
let adminId: string;
let ownerId: string;
let orgId: string;
const users: string[] = [];
const orgs: string[] = [];

const asAdmin = (fn: string, args: Record<string, unknown> = {}) => rpc(clientFor(adminId), fn, args);
const stale = () => clientFor(adminId, { authTime: Math.floor(Date.now() / 1000) - 3600 });
const user = async (local: string) => {
  const id = await createAuthUser(`${local}@${DOMAIN}`);
  users.push(id);
  return id;
};
const orgDocOf = async (id: string) => (await globalRow(fs(), 'organizations', id).get()).data()!;

/** `platform_create_organization`, returning its one row. */
async function platformCreate(name: string, email: string, extra: Record<string, unknown> = {}) {
  const { data, error } = await asAdmin('platform_create_organization', {
    p_name: `ITest Platform ${name} ${RUN}`, p_country_code: 'GB', p_base_currency: 'GBP',
    p_fiscal_year_start_month: 1, p_timezone: '', p_owner_email: email, ...extra,
  });
  expect(error).toBeNull();
  const row = (data as Array<{ organization_id: string; slug: string; invitation_token: string }>)[0]!;
  orgs.push(row.organization_id);
  return row;
}

beforeAll(async () => {
  adminId = await user('admin');
  ownerId = await user('owner');
  const now = nowIso();
  await fs().collection('platform_users').doc(adminId).set({
    user_id: adminId, platform_role: 'super_admin', status: 'active', granted_by: null, notes: null,
    created_at: now, updated_at: now,
  });
  const created = await rpc<string>(clientFor(ownerId), 'create_organization', { p_name: `ITest Platform Modules ${RUN}` });
  if (created.error) throw created.error;
  orgId = created.data!;
  orgs.push(orgId);
});

afterAll(async () => {
  for (const id of orgs) await deleteOrg(id);
  for (const id of orgs) {
    const jobs = await fs().collection('jobs').where('organization_id', '==', id).get();
    for (const j of jobs.docs) {
      await fs().runTransaction(async (tx) => {
        releaseQueuedGuard(fs(), tx, { job_type: String(j.get('job_type')), idempotency_key: (j.get('idempotency_key') as string | null) ?? null });
        tx.delete(j.ref);
      });
    }
  }
  for (const id of users) {
    await fs().collection('platform_users').doc(id).delete();
    await fs().collection('profiles').doc(id).delete();
  }
  await auth().deleteUsers(users);
});

describe('api.set_org_module', () => {
  it('switches one system off, merging only that key', async () => {
    await globalRow(fs(), 'organizations', orgId).update({ features: { funding_readiness: false, other: 1 } });
    const { error } = await asAdmin('set_org_module', { p_org: orgId, p_feature_key: 'module_banking', p_on: false });
    expect(error).toBeNull();
    expect((await orgDocOf(orgId)).features).toEqual({ funding_readiness: false, other: 1, module_banking: false });
  });

  it('refuses a switch APX does not know, and anyone but a super admin', async () => {
    expect(sqlstate((await asAdmin('set_org_module', { p_org: orgId, p_feature_key: 'everything', p_on: true })).error)).toBe('22023');
    const owner = await rpc(clientFor(ownerId), 'set_org_module', { p_org: orgId, p_feature_key: 'module_banking', p_on: true });
    expect(sqlstate(owner.error)).toBe('42501');
  });
});

describe('api.platform_create_organization', () => {
  it('creates and sets up the company without making the super admin a member, and invites the owner', async () => {
    const row = await platformCreate('Dubai Trading', `boss@${DOMAIN}`, { p_country_code: 'AE', p_base_currency: 'AED' });
    expect(row.invitation_token.length).toBeGreaterThan(10);
    const org = await orgDocOf(row.organization_id);
    expect({ c: org.country_code, cur: org.base_currency, tz: org.timezone }).toEqual({ c: 'AE', cur: 'AED', tz: 'Asia/Dubai' });
    expect((await orgCollection(fs(), row.organization_id, 'organization_memberships').get()).size).toBe(0);
    expect((await orgCollection(fs(), row.organization_id, 'accounts').get()).size).toBeGreaterThan(10);
    const invitations = await orgCollection(fs(), row.organization_id, 'invitations').get();
    expect(invitations.docs.map((d) => d.get('role'))).toEqual(['owner']);
  });

  it('refuses a company owner', async () => {
    const { error } = await rpc(clientFor(ownerId), 'platform_create_organization', {
      p_name: 'Nope', p_country_code: 'GB', p_base_currency: 'GBP', p_fiscal_year_start_month: 1, p_timezone: '', p_owner_email: `x@${DOMAIN}`,
    });
    expect(sqlstate(error)).toBe('42501');
  });
});

describe('api.platform_users_list', () => {
  it('lists staff with emails for a super admin only', async () => {
    const { data, error } = await asAdmin('platform_users_list');
    expect(error).toBeNull();
    expect((data as Array<{ email: string }>).map((r) => r.email)).toContain(`admin@${DOMAIN}`);
    expect(sqlstate((await rpc(clientFor(ownerId), 'platform_users_list')).error)).toBe('42501');
  });
});

describe('the owner of a company the super admin created (ADR-160)', () => {
  it('joins through the invitation link the super admin sent', async () => {
    const email = `invited@${DOMAIN}`;
    const row = await platformCreate('Invited Owner Co', email, { p_fiscal_year_start_month: 4 });
    const invitedId = await user('invited');
    const { error } = await rpc(clientFor(invitedId, { email }), 'accept_invitation', { p_token: row.invitation_token });
    expect(error).toBeNull();
    expect((await orgRow(fs(), row.organization_id, 'organization_memberships', invitedId).get()).get('role')).toBe('owner');
  });

  it('is set directly by the super admin once, accepting the pending invitation, and never by anyone else', async () => {
    const email = `direct@${DOMAIN}`;
    const row = await platformCreate('Direct Owner Co', email, { p_fiscal_year_start_month: 4 });
    const directId = await user('direct');

    const refused = await rpc(clientFor(ownerId), 'platform_set_company_owner', { p_org: row.organization_id, p_user: directId });
    expect(sqlstate(refused.error)).toBe('42501');

    const set = await asAdmin('platform_set_company_owner', { p_org: row.organization_id, p_user: directId });
    expect(set.error?.message ?? null).toBeNull();
    expect((await orgRow(fs(), row.organization_id, 'organization_memberships', directId).get()).get('role')).toBe('owner');
    const invitations = await orgCollection(fs(), row.organization_id, 'invitations').get();
    expect(invitations.docs.map((d) => d.get('status'))).toEqual(['accepted']);

    // A company that has an owner is never re-owned this way.
    const again = await asAdmin('platform_set_company_owner', { p_org: row.organization_id, p_user: ownerId });
    expect(sqlstate(again.error)).toBe('23505');
  });

  it('refuses the super admin a stale sign-in', async () => {
    const row = await platformCreate('Stale Owner Co', `stale@${DOMAIN}`, { p_fiscal_year_start_month: 4 });
    const { error } = await rpc(stale(), 'platform_set_company_owner', { p_org: row.organization_id, p_user: ownerId });
    expect(sqlstate(error)).toBe('42501');
  });
});

describe('editing and deleting a company from the list (ADR-166)', () => {
  const queuedPurges = async (org: string) => (await fs().collection('jobs').where('organization_id', '==', org)
    .where('job_type', '==', 'org.purge').where('status', '==', 'queued').get()).size;

  it('lets the super admin edit, delete (scheduled, purge queued) and restore a company', async () => {
    const org = (await platformCreate('Edit Delete Co', `ed@${DOMAIN}`)).organization_id;

    expect((await asAdmin('update_organization', { p_org: org, p_patch: { name: `ITest Platform Edited ${RUN}`, plan: 'professional', fiscal_year_start_month: 4 } })).error).toBeNull();
    expect((await asAdmin('set_currency_and_country', { p_org: org, p_currency: 'AED', p_country: 'AE' })).error).toBeNull();
    const o = await orgDocOf(org);
    expect({ n: o.name, p: o.plan, f: o.fiscal_year_start_month, c: o.base_currency, k: o.country_code })
      .toEqual({ n: `ITest Platform Edited ${RUN}`, p: 'professional', f: 4, c: 'AED', k: 'AE' });

    expect((await asAdmin('request_deletion', { p_org: org })).error).toBeNull();
    expect((await orgDocOf(org)).status).toBe('pending_deletion');
    expect(await queuedPurges(org)).toBe(1);

    expect((await asAdmin('cancel_deletion', { p_org: org })).error).toBeNull();
    expect((await orgDocOf(org)).status).toBe('active');
    expect(await queuedPurges(org)).toBe(0);
  });

  it('refuses deletion to anyone but the super admin and the owner', async () => {
    const org = (await platformCreate('Not Yours Co', `ny@${DOMAIN}`)).organization_id;
    const refused = await rpc(clientFor(ownerId), 'request_deletion', { p_org: org });
    expect(refused.error).not.toBeNull();
    expect((await orgDocOf(org)).status).toBe('active');
  });
});

describe("changing a company owner's login (ADR-167)", () => {
  let org: string;
  let owner: string;

  beforeAll(async () => {
    org = (await platformCreate('Owner Login Co', `login-owner@${DOMAIN}`)).organization_id;
    owner = await user('login-owner');
  });

  it('refuses while the company has no owner yet', async () => {
    // 23514 (a check, not a duplicate) — both are CONFLICT now, which `sqlstate` reports as 23505.
    const { error } = await asAdmin('platform_owner_login_change', { p_org: org, p_new_email: null, p_password: true });
    expect(error).toMatchObject({ code: 'CONFLICT' });
  });

  it('lists the owner, then authorises and records an email and password change', async () => {
    expect((await asAdmin('platform_set_company_owner', { p_org: org, p_user: owner })).error).toBeNull();
    const listed = (await asAdmin('platform_company_owners', { p_orgs: [org] })).data as Array<{ email: string }>;
    expect(listed.map((r) => r.email)).toEqual([`login-owner@${DOMAIN}`]);

    const { data, error } = await asAdmin('platform_owner_login_change', { p_org: org, p_new_email: ` New-Owner@${DOMAIN} `, p_password: true });
    expect(error).toBeNull();
    expect((data as Array<{ user_id: string; email: string }>)[0]).toEqual({ user_id: owner, email: `new-owner@${DOMAIN}` });
    const events = await fs().collection('audit_events').where('organization_id', '==', org)
      .where('action', '==', 'platform.owner_login_changed').get();
    const latest = events.docs.map((d) => d.data()).sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0]!;
    expect(latest.after).toEqual({ email: `new-owner@${DOMAIN}`, password_changed: true });
  });

  it("refuses another login's email, a malformed one, nothing to change, a stale sign-in and anyone else", async () => {
    await user('taken');
    expect(sqlstate((await asAdmin('platform_owner_login_change', { p_org: org, p_new_email: `taken@${DOMAIN}`, p_password: false })).error)).toBe('23505');
    expect(sqlstate((await asAdmin('platform_owner_login_change', { p_org: org, p_new_email: 'not-an-email', p_password: false })).error)).toBe('22023');
    expect(sqlstate((await asAdmin('platform_owner_login_change', { p_org: org, p_new_email: null, p_password: false })).error)).toBe('22023');
    expect(sqlstate((await rpc(stale(), 'platform_owner_login_change', { p_org: org, p_new_email: null, p_password: true })).error)).toBe('42501');
    expect(sqlstate((await rpc(clientFor(owner), 'platform_owner_login_change', { p_org: org, p_new_email: null, p_password: true })).error)).toBe('42501');
    expect(sqlstate((await rpc(clientFor(owner), 'platform_company_owners', { p_orgs: [org] })).error)).toBe('42501');
  });
});

describe('deleting a company for good, now (ADR-168)', () => {
  it('refuses a company that is not scheduled, then purges one that is — rows gone, status deleted', async () => {
    const org = (await platformCreate('Purge Now Co', `purge@${DOMAIN}`)).organization_id;
    expect((await orgCollection(fs(), org, 'accounts').get()).size).toBeGreaterThan(0);

    expect((await asAdmin('platform_purge_now', { p_org: org })).error).toMatchObject({ code: 'CONFLICT' });
    expect((await asAdmin('request_deletion', { p_org: org })).error).toBeNull();

    expect(sqlstate((await rpc(stale(), 'platform_purge_now', { p_org: org })).error)).toBe('42501');
    expect(sqlstate((await rpc(clientFor(ownerId), 'platform_purge_now', { p_org: org })).error)).toBe('42501');

    const { data: job, error } = await asAdmin('platform_purge_now', { p_org: org });
    expect(error).toBeNull();
    const jobId = job as string;
    const queued = (await fs().collection('jobs').doc(jobId).get()).data()!;
    // Due now: the request's thirty-day wait is over by the super admin's decision.
    expect(queued).toMatchObject({ job_type: 'org.purge', status: 'queued', organization_id: org });
    expect(new Date(String(queued.run_after)).getTime()).toBeLessThanOrEqual(Date.now());

    // Run THIS job the way the worker would (claimed, scoped), rather than draining a queue the
    // other suites on this emulator share.
    await fs().runTransaction(async (tx) => {
      releaseQueuedGuard(fs(), tx, { job_type: 'org.purge', idempotency_key: (queued.idempotency_key as string | null) ?? null });
      tx.update(fs().collection('jobs').doc(jobId), { status: 'running', attempts: 1, locked_at: nowIso(), locked_by: `itest-${RUN}` });
    });
    const outcome = await withOrgScope(org, () => runOrgPurgeJob({
      jobId, organizationId: org, jobType: 'org.purge', payload: {}, requestedBy: null, attempts: 1, maxAttempts: 3,
    }));
    expect(outcome.status, JSON.stringify(outcome)).toBe('succeeded');
    expect((await orgDocOf(org)).status).toBe('deleted');
    expect((await orgCollection(fs(), org, 'accounts').get()).size).toBe(0);
    expect((await orgCollection(fs(), org, 'invitations').get()).size).toBe(0);
  }, 120_000);
});
