import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { adminSql, clientFor, createAuthUser, resetFixtures, sqlstate } from './setup';

/**
 * ADR-158 over the real wire: only a super admin (aal2, recent sign-in) switches a company's systems,
 * creates a company (without becoming its member; the owner is invited) and lists the staff.
 */

const DOMAIN = `plat-${Date.now()}.itest.motion`;
let adminId: string;
let ownerId: string;
let orgId: string;

const asAdmin = (fn: string, args: Record<string, unknown> = {}) =>
  clientFor(adminId, { aal: 'aal2' }).schema('api').rpc(fn, args);

beforeAll(async () => {
  resetFixtures();
  adminId = createAuthUser(`admin@${DOMAIN}`);
  ownerId = createAuthUser(`owner@${DOMAIN}`);
  adminSql(`insert into public.platform_users (user_id, platform_role, status) values ('${adminId}', 'super_admin', 'active');
            update public.profiles set mfa_enrolled_at = now() where id = '${adminId}';`);
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
    const owner = await clientFor(ownerId, { aal: 'aal2' }).schema('api').rpc('set_org_module', { p_org: orgId, p_feature_key: 'module_banking', p_on: true });
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
    const { error } = await clientFor(ownerId, { aal: 'aal2' }).schema('api').rpc('platform_create_organization', {
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
    expect(sqlstate((await clientFor(ownerId, { aal: 'aal2' }).schema('api').rpc('platform_users_list')).error)).toBe('42501');
  });
});
