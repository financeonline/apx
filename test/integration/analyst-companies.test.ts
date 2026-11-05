import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auth } from '@/db/firestore';
import { globalRow, orgRow } from '@/db/schema';
import { createCompany } from '@/modules/platform';
import { createMemberLogin } from '@/modules/tenancy';
import { clientFor, createAuthUser, fs, rpc } from './setup';
import { assign, ctxFor, dropOrg, dropPlatformUser, makeOrg, makePlatformUser, slugOf } from './tenancy-fixtures';

/**
 * ADR-187 (owner, 2026-11-05) against the data layer: a Financial Analyst creates companies and
 * manages the ones they created or were given — people, what each person sees, settings, the owner's
 * login and the active switch — within the access the super admin sets for them per company. Every
 * "cannot" is asserted at the `api.*` function with the person's own handle.
 */

const RUN = `t${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.analyst.itest.motion`;
const email = (who: string) => `${who}@${DOMAIN}`;

type Who = 'analyst' | 'other' | 'boss';
const ids = {} as Record<Who, string>;
const db = (who: Who) => clientFor(ids[who], { email: email(who) });
const call = (who: Who, fn: string, args: Record<string, unknown> = {}) => rpc(db(who), fn, args);
const orgs: string[] = [];
let created: string;
let ownerId: string;
let given: string;

async function access(who: Who, org: string) {
  const { data } = await call(who, 'my_access', { p_slug: await slugOf(org) });
  return (data as Array<{ role: string; permissions: string[]; departments: string[] | null }>)[0] ?? null;
}

beforeAll(async () => {
  for (const who of ['analyst', 'other', 'boss'] as Who[]) ids[who] = await createAuthUser(email(who));
  await makePlatformUser(ids.analyst, 'employee');
  await makePlatformUser(ids.other, 'employee');
  await makePlatformUser(ids.boss, 'super_admin');

  const result = await createCompany({ db: db('analyst'), requestId: `itest-${RUN}` }, {
    name: `ITest Analyst Co ${RUN}`, countryCode: 'GB', baseCurrency: 'GBP', fiscalYearStartMonth: '4',
    ownerEmail: email('owner'), ownerPassword: 'Owner-pass-123',
  });
  created = result.organizationId;
  orgs.push(created);
  ownerId = (await auth().getUserByEmail(email('owner'))).uid;

  given = await makeOrg({ name: `ITest Given Co ${RUN}`, slug: `itest-given-${RUN}` });
  orgs.push(given);
  await assign(given, ids.analyst);
});

afterAll(async () => {
  for (const org of orgs) await dropOrg(org);
  for (const who of ['analyst', 'other', 'boss'] as Who[]) if (ids[who]) await dropPlatformUser(ids[who]);
  let page = await auth().listUsers(1000);
  for (;;) {
    for (const u of page.users.filter((x) => x.email?.endsWith(`@${DOMAIN}`))) {
      await auth().deleteUser(u.uid).catch(() => undefined);
      await globalRow(fs(), 'profiles', u.uid).delete();
    }
    if (!page.pageToken) break;
    page = await auth().listUsers(1000, page.pageToken);
  }
});

describe('an analyst creates a company', () => {
  it('is linked to it with no end date and reaches it as its analyst; the owner is its owner', async () => {
    const link = (await orgRow(fs(), created, 'organization_assignments', ids.analyst).get()).data()!;
    expect(link).toMatchObject({ status: 'active', ends_at: null, created_by_analyst: true });
    expect((await access('analyst', created))?.role).toBe('employee');
    const owner = (await orgRow(fs(), created, 'organization_memberships', ownerId).get()).data()!;
    expect(owner).toMatchObject({ role: 'owner', status: 'active' });
  });

  it('lists the companies they created and were given — and nobody else’s', async () => {
    const { data } = await call('analyst', 'analyst_companies');
    const listed = (data as Array<{ organization_id: string }>).map((r) => r.organization_id);
    expect(listed).toEqual(expect.arrayContaining([created, given]));
    const { data: others } = await call('other', 'analyst_companies');
    expect((others as Array<{ organization_id: string }>).map((r) => r.organization_id)).not.toContain(created);
  });
});

describe('an analyst manages their companies', () => {
  let memberId: string;

  it('creates a team member login with the departments and permissions ticked', async () => {
    const ctx = await ctxFor(ids.analyst, created, { email: email('analyst') });
    ({ userId: memberId } = await createMemberLogin(ctx, {
      fullName: 'Tina Team', email: email('tina'), password: 'Team-pass-123',
      role: 'client', permissions: ['dashboard.view', 'reports.view'], departments: ['reports'],
    }));
    const m = (await orgRow(fs(), created, 'organization_memberships', memberId).get()).data()!;
    expect(m).toMatchObject({ role: 'client', departments: ['reports'], departments_set_by_owner: true });
  });

  it('switches a member’s permission and departments, and edits the company’s settings', async () => {
    expect((await call('analyst', 'set_member_permission', { p_org: created, p_user: memberId, p_permission: 'financials.view', p_granted: true })).error).toBeNull();
    expect((await call('analyst', 'set_member_departments', { p_org: created, p_user: memberId, p_departments: ['reports', 'banking'] })).error).toBeNull();
    expect((await call('analyst', 'update_organization', { p_org: created, p_patch: { legal_name: 'Analyst Co Ltd' } })).error).toBeNull();
    // …but never the platform's fields.
    expect((await call('analyst', 'update_organization', { p_org: created, p_patch: { plan: 'enterprise' } })).error?.code).toBe('VALIDATION');
  });

  it('changes the owner’s login, but never removes the last owner', async () => {
    const { data, error } = await call('analyst', 'platform_owner_login_change', { p_org: created, p_new_email: '', p_password: true });
    expect(error).toBeNull();
    expect((data as Array<{ user_id: string }>)[0]?.user_id).toBe(ownerId);
    expect((await call('analyst', 'remove_member', { p_org: created, p_user: ownerId })).error?.code).toBe('CONFLICT');
  });

  it('deactivates the company and switches it back on', async () => {
    expect((await call('analyst', 'set_company_status', { p_org: created, p_status: 'suspended' })).error).toBeNull();
    expect((await access('analyst', created))?.role).toBe('suspended_member');
    expect((await call('analyst', 'set_company_status', { p_org: created, p_status: 'active' })).error).toBeNull();
    expect((await access('analyst', created))?.role).toBe('employee');
  });
});

describe('what an analyst cannot do', () => {
  it('reaches nothing of a company that is not theirs', async () => {
    expect(await access('other', created)).toBeNull();
    for (const [fn, args] of [
      ['set_company_status', { p_org: created, p_status: 'suspended' }],
      ['platform_owner_login_change', { p_org: created, p_new_email: '', p_password: true }],
      ['platform_company_owners', { p_orgs: [created] }],
    ] as const) {
      expect((await call('other', fn, args)).error?.code, fn).toBe('NOT_FOUND');
    }
    expect((await call('other', 'set_member_permission', { p_org: created, p_user: ownerId, p_permission: 'financials.view', p_granted: false })).error?.code).toBe('NOT_FOUND');
  });

  it('never gives companies, never sets their own or another analyst’s access', async () => {
    expect((await call('analyst', 'create_assignment', { p_org: created, p_employee: ids.other })).error?.code).toBe('PERMISSION_DENIED');
    expect((await call('analyst', 'set_analyst_access', { p_org: created, p_employee: ids.analyst, p_departments: null, p_switches: [] })).error?.code).toBe('PERMISSION_DENIED');
    expect((await call('analyst', 'analyst_access', { p_employee: ids.other })).error?.code).toBe('PERMISSION_DENIED');
  });
});

describe('the super admin sets an analyst’s access per company', () => {
  it('narrows the departments and switches a permission off — and the analyst can give no more', async () => {
    const set = await call('boss', 'set_analyst_access', {
      p_org: created, p_employee: ids.analyst, p_departments: ['reports'],
      p_switches: [{ permission: 'financials.view', granted: false }],
    });
    expect(set.error).toBeNull();
    const a = await access('analyst', created);
    expect(a?.departments).toEqual(['reports']);
    expect(a?.permissions).not.toContain('financials.view');
    // Management itself is not switchable.
    expect(a?.permissions).toEqual(expect.arrayContaining(['users.manage', 'users.invite', 'settings.manage']));

    const tina = (await auth().getUserByEmail(email('tina'))).uid;
    // Already on for Tina (an analyst switched it on above); a new switch-on of what they lack is refused.
    expect((await call('analyst', 'set_member_permission', { p_org: created, p_user: tina, p_permission: 'financials.view', p_granted: null })).error).toBeNull();
    expect((await call('analyst', 'set_member_permission', { p_org: created, p_user: tina, p_permission: 'financials.view', p_granted: true })).error?.code).toBe('PERMISSION_DENIED');
    expect((await call('analyst', 'set_member_departments', { p_org: created, p_user: tina, p_departments: ['banking'] })).error?.code).toBe('PERMISSION_DENIED');

    const { data } = await call('boss', 'analyst_access', { p_employee: ids.analyst });
    const row = (data as Array<{ organization_id: string; departments: string[] | null; switches: Array<{ permission: string; granted: boolean }> }>)
      .find((r) => r.organization_id === created)!;
    expect(row.departments).toEqual(['reports']);
    expect(row.switches).toEqual([{ permission: 'financials.view', granted: false }]);

    // Back to the default.
    expect((await call('boss', 'set_analyst_access', {
      p_org: created, p_employee: ids.analyst, p_departments: null, p_switches: [{ permission: 'financials.view', granted: null }],
    })).error).toBeNull();
    const back = await access('analyst', created);
    expect(back?.departments).toBeNull();
    expect(back?.permissions).toContain('financials.view');
  });

  it('can create a company’s team member logins too', async () => {
    const begin = await call('boss', 'begin_member_login', {
      p_org: created, p_email: email('sam'), p_role: 'accountant', p_permissions: [], p_departments: null,
    });
    expect(begin.error).toBeNull();
  });

  it('can take a company away from the analyst who created it', async () => {
    const link = (await orgRow(fs(), created, 'organization_assignments', ids.analyst).get()).data()!;
    expect((await call('boss', 'revoke_assignment', { p_assignment: link.id, p_reason: 'itest' })).error).toBeNull();
    expect(await access('analyst', created)).toBeNull();
    expect((await call('analyst', 'set_company_status', { p_org: created, p_status: 'suspended' })).error?.code).toBe('NOT_FOUND');
  });
});
