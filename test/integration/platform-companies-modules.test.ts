import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { drainJobs } from '@/modules/jobs';
import { adminSql, clientFor, createAuthUser, drainUntilFinished, resetFixtures, sqlstate } from './setup';

/**
 * ADR-158 over the real wire: only a super admin (recent sign-in) switches a company's systems,
 * creates a company (without becoming its member; the owner is invited) and lists the staff.
 */

const DOMAIN = `plat-${Date.now()}.itest.motion`;
let adminId: string;
let ownerId: string;
let orgId: string;

const asAdmin = (fn: string, args: Record<string, unknown> = {}) =>
  clientFor(adminId).schema('api').rpc(fn, args);

beforeAll(async () => {
  resetFixtures();
  adminId = createAuthUser(`admin@${DOMAIN}`);
  ownerId = createAuthUser(`owner@${DOMAIN}`);
  adminSql(`insert into public.platform_users (user_id, platform_role, status) values ('${adminId}', 'super_admin', 'active');`);
  const created = await clientFor(ownerId).schema('api').rpc('create_organization', { p_name: 'ITest Modules Co' });
  if (created.error) throw new Error(created.error.message);
  orgId = created.data as unknown as string;
});

afterAll(() => {
  adminSql(`delete from public.platform_users where user_id in (select id from auth.users where email like '%@${DOMAIN}');`);
  resetFixtures();
});

describe('api.set_org_module', () => {
  it('switches one system off, merging only that key', async () => {
    adminSql(`update public.organizations set features = '{"funding_readiness": false, "other": 1}' where id = '${orgId}'`);
    const { error } = await asAdmin('set_org_module', { p_org: orgId, p_feature_key: 'module_banking', p_on: false });
    expect(error).toBeNull();
    expect(JSON.parse(adminSql(`select features::text from public.organizations where id = '${orgId}'`)))
      .toEqual({ funding_readiness: false, other: 1, module_banking: false });
  });

  it('refuses a switch MOTION does not know, and anyone but a super admin', async () => {
    expect(sqlstate((await asAdmin('set_org_module', { p_org: orgId, p_feature_key: 'everything', p_on: true })).error)).toBe('22023');
    const owner = await clientFor(ownerId).schema('api').rpc('set_org_module', { p_org: orgId, p_feature_key: 'module_banking', p_on: true });
    expect(sqlstate(owner.error)).toBe('42501');
  });
});

describe('api.platform_create_organization', () => {
  it('creates and sets up the company without making the super admin a member, and invites the owner', async () => {
    const { data, error } = await asAdmin('platform_create_organization', {
      p_name: 'ITest Dubai Trading', p_country_code: 'AE', p_base_currency: 'AED',
      p_fiscal_year_start_month: 1, p_timezone: '', p_owner_email: `boss@${DOMAIN}`,
    });
    expect(error).toBeNull();
    const row = (data as Array<{ organization_id: string; slug: string; invitation_token: string }>)[0]!;
    expect(row.invitation_token.length).toBeGreaterThan(10);
    const org = JSON.parse(adminSql(`select json_build_object('c', country_code, 'cur', base_currency, 'tz', timezone)::text from public.organizations where id = '${row.organization_id}'`));
    expect(org).toEqual({ c: 'AE', cur: 'AED', tz: 'Asia/Dubai' });
    expect(adminSql(`select count(*) from public.organization_memberships where organization_id = '${row.organization_id}'`)).toBe('0');
    expect(Number(adminSql(`select count(*) from public.accounts where organization_id = '${row.organization_id}'`))).toBeGreaterThan(10);
    expect(adminSql(`select role from public.invitations where organization_id = '${row.organization_id}'`)).toBe('owner');
  });

  it('refuses a company owner', async () => {
    const { error } = await clientFor(ownerId).schema('api').rpc('platform_create_organization', {
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
    expect(sqlstate((await clientFor(ownerId).schema('api').rpc('platform_users_list')).error)).toBe('42501');
  });
});

describe('the owner of a company the super admin created (ADR-160)', () => {
  const create = async (name: string, email: string) => {
    const { data, error } = await asAdmin('platform_create_organization', {
      p_name: name, p_country_code: 'GB', p_base_currency: 'GBP',
      p_fiscal_year_start_month: 4, p_timezone: '', p_owner_email: email,
    });
    expect(error).toBeNull();
    return (data as Array<{ organization_id: string; invitation_token: string }>)[0]!;
  };

  it('joins through the invitation link the super admin sent', async () => {
    const email = `invited@${DOMAIN}`;
    const row = await create('ITest Invited Owner Co', email);
    const invitedId = createAuthUser(email);
    const { error } = await clientFor(invitedId, { email }).schema('api').rpc('accept_invitation', { p_token: row.invitation_token });
    expect(error).toBeNull();
    expect(adminSql(`select role from public.organization_memberships where organization_id = '${row.organization_id}' and user_id = '${invitedId}'`)).toBe('owner');
  });

  it('is set directly by the super admin once, accepting the pending invitation, and never by anyone else', async () => {
    const email = `direct@${DOMAIN}`;
    const row = await create('ITest Direct Owner Co', email);
    const directId = createAuthUser(email);

    const refused = await clientFor(ownerId).schema('api').rpc('platform_set_company_owner', { p_org: row.organization_id, p_user: directId });
    expect(sqlstate(refused.error)).toBe('42501');

    const set = await asAdmin('platform_set_company_owner', { p_org: row.organization_id, p_user: directId });
    expect(set.error?.message ?? null).toBeNull();
    expect(adminSql(`select role from public.organization_memberships where organization_id = '${row.organization_id}' and user_id = '${directId}'`)).toBe('owner');
    expect(adminSql(`select status from public.invitations where organization_id = '${row.organization_id}'`)).toBe('accepted');

    // A company that has an owner is never re-owned this way.
    const again = await asAdmin('platform_set_company_owner', { p_org: row.organization_id, p_user: ownerId });
    expect(sqlstate(again.error)).toBe('23505');
  });

  it('refuses the super admin a stale sign-in', async () => {
    const row = await create('ITest Stale Owner Co', `stale@${DOMAIN}`);
    const stale = clientFor(adminId, { amrTimestamp: Math.floor(Date.now() / 1000) - 3600 });
    const { error } = await stale.schema('api').rpc('platform_set_company_owner', { p_org: row.organization_id, p_user: ownerId });
    expect(sqlstate(error)).toBe('42501');
  });
});

describe('editing and deleting a company from the list (ADR-166)', () => {
  it('lets the super admin edit, delete (scheduled, purge queued) and restore a company', async () => {
    const { data } = await asAdmin('platform_create_organization', {
      p_name: 'ITest Edit Delete Co', p_country_code: 'GB', p_base_currency: 'GBP',
      p_fiscal_year_start_month: 1, p_timezone: '', p_owner_email: `ed@${DOMAIN}`,
    });
    const org = (data as Array<{ organization_id: string }>)[0]!.organization_id;

    expect((await asAdmin('update_organization', { p_org: org, p_patch: { name: 'ITest Edited Co', plan: 'professional', fiscal_year_start_month: 4 } })).error).toBeNull();
    expect((await asAdmin('set_currency_and_country', { p_org: org, p_currency: 'AED', p_country: 'AE' })).error).toBeNull();
    expect(JSON.parse(adminSql(`select json_build_object('n', name, 'p', plan, 'f', fiscal_year_start_month, 'c', base_currency, 'k', country_code)::text from public.organizations where id = '${org}'`)))
      .toEqual({ n: 'ITest Edited Co', p: 'professional', f: 4, c: 'AED', k: 'AE' });

    expect((await asAdmin('request_deletion', { p_org: org })).error).toBeNull();
    expect(adminSql(`select status from public.organizations where id = '${org}'`)).toBe('pending_deletion');
    expect(adminSql(`select count(*) from public.jobs where organization_id = '${org}' and job_type = 'org.purge' and status = 'queued'`)).toBe('1');

    expect((await asAdmin('cancel_deletion', { p_org: org })).error).toBeNull();
    expect(adminSql(`select status from public.organizations where id = '${org}'`)).toBe('active');
    expect(adminSql(`select count(*) from public.jobs where organization_id = '${org}' and job_type = 'org.purge' and status = 'queued'`)).toBe('0');
  });

  it('refuses deletion to anyone but the super admin and the owner', async () => {
    const stranger = clientFor(ownerId).schema('api');
    const { data } = await asAdmin('platform_create_organization', {
      p_name: 'ITest Not Yours Co', p_country_code: 'GB', p_base_currency: 'GBP',
      p_fiscal_year_start_month: 1, p_timezone: '', p_owner_email: `ny@${DOMAIN}`,
    });
    const org = (data as Array<{ organization_id: string }>)[0]!.organization_id;
    const refused = await stranger.rpc('request_deletion', { p_org: org });
    expect(refused.error).not.toBeNull();
    expect(adminSql(`select status from public.organizations where id = '${org}'`)).toBe('active');
  });
});

describe("changing a company owner's login (ADR-167)", () => {
  let org: string;
  let owner: string;

  beforeAll(async () => {
    const { data } = await asAdmin('platform_create_organization', {
      p_name: 'ITest Owner Login Co', p_country_code: 'GB', p_base_currency: 'GBP',
      p_fiscal_year_start_month: 1, p_timezone: '', p_owner_email: `login-owner@${DOMAIN}`,
    });
    org = (data as Array<{ organization_id: string }>)[0]!.organization_id;
    owner = createAuthUser(`login-owner@${DOMAIN}`);
  });

  it('refuses while the company has no owner yet', async () => {
    expect(sqlstate((await asAdmin('platform_owner_login_change', { p_org: org, p_new_email: null, p_password: true })).error)).toBe('23514');
  });

  it('lists the owner, then authorises and records an email and password change', async () => {
    expect((await asAdmin('platform_set_company_owner', { p_org: org, p_user: owner })).error).toBeNull();
    const listed = (await asAdmin('platform_company_owners', { p_orgs: [org] })).data as Array<{ email: string }>;
    expect(listed.map((r) => r.email)).toEqual([`login-owner@${DOMAIN}`]);

    const { data, error } = await asAdmin('platform_owner_login_change', { p_org: org, p_new_email: ` New-Owner@${DOMAIN} `, p_password: true });
    expect(error).toBeNull();
    expect((data as Array<{ user_id: string; email: string }>)[0]).toEqual({ user_id: owner, email: `new-owner@${DOMAIN}` });
    const audit = JSON.parse(adminSql(`select after::text from public.audit_events where action = 'platform.owner_login_changed' and organization_id = '${org}' order by created_at desc limit 1`));
    expect(audit).toEqual({ email: `new-owner@${DOMAIN}`, password_changed: true });
  });

  it("refuses another login's email, a malformed one, nothing to change, a stale sign-in and anyone else", async () => {
    createAuthUser(`taken@${DOMAIN}`);
    expect(sqlstate((await asAdmin('platform_owner_login_change', { p_org: org, p_new_email: `taken@${DOMAIN}`, p_password: false })).error)).toBe('23505');
    expect(sqlstate((await asAdmin('platform_owner_login_change', { p_org: org, p_new_email: 'not-an-email', p_password: false })).error)).toBe('22023');
    expect(sqlstate((await asAdmin('platform_owner_login_change', { p_org: org, p_new_email: null, p_password: false })).error)).toBe('22023');
    const stale = clientFor(adminId, { amrTimestamp: Math.floor(Date.now() / 1000) - 3600 });
    expect(sqlstate((await stale.schema('api').rpc('platform_owner_login_change', { p_org: org, p_new_email: null, p_password: true })).error)).toBe('42501');
    expect(sqlstate((await clientFor(owner).schema('api').rpc('platform_owner_login_change', { p_org: org, p_new_email: null, p_password: true })).error)).toBe('42501');
    expect(sqlstate((await clientFor(owner).schema('api').rpc('platform_company_owners', { p_orgs: [org] })).error)).toBe('42501');
  });
});

describe('deleting a company for good, now (ADR-168)', () => {
  it('refuses a company that is not scheduled, then purges one that is — rows gone, status deleted', async () => {
    const { data } = await asAdmin('platform_create_organization', {
      p_name: 'ITest Purge Now Co', p_country_code: 'GB', p_base_currency: 'GBP',
      p_fiscal_year_start_month: 1, p_timezone: '', p_owner_email: `purge@${DOMAIN}`,
    });
    const org = (data as Array<{ organization_id: string }>)[0]!.organization_id;
    expect(Number(adminSql(`select count(*) from public.accounts where organization_id = '${org}'`))).toBeGreaterThan(0);

    expect(sqlstate((await asAdmin('platform_purge_now', { p_org: org })).error)).toBe('23514');
    expect((await asAdmin('request_deletion', { p_org: org })).error).toBeNull();

    const stale = clientFor(adminId, { amrTimestamp: Math.floor(Date.now() / 1000) - 3600 });
    expect(sqlstate((await stale.schema('api').rpc('platform_purge_now', { p_org: org })).error)).toBe('42501');
    expect(sqlstate((await clientFor(ownerId).schema('api').rpc('platform_purge_now', { p_org: org })).error)).toBe('42501');

    const { data: job, error } = await asAdmin('platform_purge_now', { p_org: org });
    expect(error).toBeNull();
    expect(await drainUntilFinished((max) => drainJobs(max), job as unknown as string)).toBe('succeeded');
    expect(adminSql(`select status from public.organizations where id = '${org}'`)).toBe('deleted');
    expect(adminSql(`select count(*) from public.accounts where organization_id = '${org}'`)).toBe('0');
    expect(adminSql(`select count(*) from public.invitations where organization_id = '${org}'`)).toBe('0');
  }, 120_000);
});

