import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isMotionError } from '@/core/errors';
import type { EffectiveRole } from '@/core/permissions';
import { auth } from '@/db/firestore';
import { globalRow, newId, nowIso, orgRow } from '@/db/schema';
import {
  agreedPermissions,
  createMemberLogin,
  enabledModules,
  isDepartmentKey,
  listMemberDepartments,
  narrowToDepartments,
  passwordSignIn,
  setMemberDepartments,
  type AccessContext,
} from '@/modules/tenancy';
import { clientFor, createAuthUser, fs, rpc as call, sqlstate } from './setup';
import { addMember, dropOrg, slugOf } from './tenancy-fixtures';

/**
 * ADR-173 against the data layer: a company creates its team members' logins (email and password),
 * with the departments and permissions it ticked; and a member's departments can be changed.
 *
 * Every "cannot" is asserted at the `api.*` function with the person's own handle — the service
 * checks first for a plain message, but the functions are the authority. The one claim this suite
 * exists for: no existing account can be pulled into a company, and only the owner adds anyone
 * (ADR-174).
 */

const RUN = `t${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.logins.itest.motion`;

type Who = 'owner' | 'admin' | 'admin2' | 'client' | 'outsider';
const ids = {} as Record<Who, string>;
let org: string;

const email = (who: string) => `${who}@${DOMAIN}`;
const db = (who: Who) => clientFor(ids[who], { email: email(who) });
const rpc = (who: Who, fn: string, args: Record<string, unknown>) => call(db(who), fn, args);

async function ctxFor(who: Who): Promise<AccessContext> {
  const slug = await slugOf(org);
  const { data, error } = await rpc(who, 'my_access', { p_slug: slug });
  if (error) throw error;
  const row = (data as Array<{
    role: EffectiveRole; overrides: unknown; permissions: string[]; features: Record<string, unknown>; departments: string[] | null;
  }>)[0];
  if (!row) throw new Error(`${who} has no access`);
  const departments = Array.isArray(row.departments) ? row.departments.filter(isDepartmentKey) : null;
  return {
    userId: ids[who], orgId: org, orgSlug: slug, effectiveRole: row.role,
    permissions: agreedPermissions(row.role, row.overrides, row.permissions).agreed,
    actorType: 'user', db: db(who), requestId: `itest-${RUN}`, now: () => new Date(),
    organizationStatus: 'active',
    modules: narrowToDepartments(enabledModules(row.features), departments),
    departments,
  };
}

async function outcome(work: Promise<unknown>): Promise<string> {
  try {
    await work;
    return 'ok';
  } catch (error) {
    return isMotionError(error) ? error.code : `thrown: ${String(error)}`;
  }
}

async function membership(userId: string): Promise<string> {
  const m = (await orgRow(fs(), org, 'organization_memberships', userId).get()).data();
  if (!m) return '';
  return `${m.role}|${Array.isArray(m.departments) ? m.departments.join(',') : 'ALL'}`;
}

beforeAll(async () => {
  for (const who of ['owner', 'admin', 'admin2', 'client', 'outsider'] as Who[]) ids[who] = await createAuthUser(email(who));
  const created = await rpc('owner', 'create_organization', { p_name: `ITest Logins ${RUN}` });
  if (created.error) throw created.error;
  org = created.data as string;
  await addMember(org, ids.admin, 'admin');
  await addMember(org, ids.admin2, 'admin');
  await addMember(org, ids.client, 'client');
});

afterAll(async () => {
  if (org) await dropOrg(org);
  // Every login this suite made, whether by createAuthUser or by createMemberLogin.
  let page = await auth().listUsers(1000);
  for (;;) {
    const mine = page.users.filter((u) => u.email?.endsWith(`@${DOMAIN}`));
    for (const u of mine) {
      await auth().deleteUser(u.uid).catch(() => undefined);
      await globalRow(fs(), 'profiles', u.uid).delete();
    }
    if (!page.pageToken) break;
    page = await auth().listUsers(1000, page.pageToken);
  }
});

describe('creating a team member with a login', () => {
  it('makes a login that signs in with the password, with exactly what was ticked', async () => {
    const ctx = await ctxFor('owner');
    const { userId } = await createMemberLogin(ctx, {
      fullName: 'Rita Reports', email: email('rita'), password: 'Reports-only-1',
      role: 'client', permissions: ['dashboard.view', 'reports.view', 'data.export'], departments: ['reports'],
    });
    expect(await membership(userId)).toBe('client|reports');

    // Signs in with the password the owner typed.
    const signIn = await passwordSignIn(email('rita'), 'Reports-only-1');
    expect(signIn?.uid).toBe(userId);

    // Her access is exactly the ticks: what the role gives but was not ticked is off.
    const { data } = await call(clientFor(userId, { email: email('rita') }), 'my_access', { p_slug: await slugOf(org) });
    const row = (data as Array<{ role: string; permissions: string[]; departments: string[] | null }>)[0]!;
    expect(row.role).toBe('client');
    expect(row.departments).toEqual(['reports']);
    expect(row.permissions).toEqual(expect.arrayContaining(['dashboard.view', 'reports.view', 'data.export']));
    for (const off of ['financials.view', 'banking.view', 'customers.view', 'ai.use', 'actions.view']) {
      expect(row.permissions).not.toContain(off);
    }
  });

  it('a team member who manages the team is the admin role; all departments are stored as all', async () => {
    const ctx = await ctxFor('owner');
    const { userId } = await createMemberLogin(ctx, {
      fullName: 'Manny Manager', email: email('manny'), password: 'Manager-pass-1',
      role: 'admin', permissions: ['dashboard.view', 'financials.view'],
      departments: ['banking', 'planning', 'tax', 'analyst', 'actions', 'customers', 'marketing', 'investment', 'reports'],
    });
    expect(await membership(userId)).toBe('admin|ALL');
  });

  it('refuses an email that already has a login: nobody\'s password is set for them', async () => {
    const ctx = await ctxFor('owner');
    expect(await outcome(createMemberLogin(ctx, {
      fullName: 'Outsider', email: email('outsider'), password: 'Whatever-123',
      role: 'client', permissions: ['dashboard.view'], departments: [],
    }))).toBe('CONFLICT');
    const begin = await rpc('owner', 'begin_member_login', {
      p_org: org, p_email: email('outsider'), p_role: 'client', p_permissions: [], p_departments: null,
    });
    expect(sqlstate(begin.error)).toBe('23505');
    // The existing account's password still works: nothing was set for it.
    expect(await passwordSignIn(email('outsider'), 'itest-password-1')).not.toBeNull();
  });

  it('never attaches an existing account, a login older than the claim, or another person\'s claim', async () => {
    const begin = await rpc('owner', 'begin_member_login', {
      p_org: org, p_email: email('newcomer'), p_role: 'client', p_permissions: ['dashboard.view'], p_departments: null,
    });
    expect(begin.error).toBeNull();
    const claim = begin.data as string;

    // An existing account (another email) is refused.
    const existing = await rpc('owner', 'finish_member_login', { p_claim: claim, p_user: ids.outsider });
    expect(sqlstate(existing.error)).toBe('42501');

    // Another manager cannot use the owner's claim.
    const fresh = await createAuthUser(email('newcomer'));
    const stolen = await rpc('admin', 'finish_member_login', { p_claim: claim, p_user: fresh });
    expect(sqlstate(stolen.error)).toBe('P0002');

    // A login made BEFORE the claim (same email, the claim made afterwards) is refused.
    const early = await createAuthUser(email('early'));
    await globalRow(fs(), 'profiles', early).update({ created_at: new Date(Date.now() - 60_000).toISOString() });
    const earlyClaim = newId();
    await orgRow(fs(), org, 'member_login_claims', earlyClaim).set({
      id: earlyClaim, organization_id: org, email: email('early'), role: 'client', permissions: [], departments: null,
      created_by: ids.owner, created_at: nowIso(), used_at: null, used_user_id: null,
    });
    const old = await rpc('owner', 'finish_member_login', { p_claim: earlyClaim, p_user: early });
    expect(sqlstate(old.error)).toBe('42501');

    // The real one goes through, once.
    expect((await rpc('owner', 'finish_member_login', { p_claim: claim, p_user: fresh })).error).toBeNull();
    const again = await rpc('owner', 'finish_member_login', { p_claim: claim, p_user: fresh });
    expect(sqlstate(again.error)).toBe('P0002');
  });

  it('only the owner creates logins: an admin, a client and a stranger are refused (ADR-174)', async () => {
    // Through the service: a plain refusal before anything is made.
    for (const who of ['admin', 'client'] as Who[]) {
      const ctx = await ctxFor(who);
      for (const role of ['client', 'accountant', 'third_party', 'admin'] as const) {
        expect(await outcome(createMemberLogin(ctx, {
          fullName: 'Nobody', email: email(`by-${who}-${role}`), password: 'Whatever-123',
          role, permissions: [], departments: [],
        }))).toBe('PERMISSION_DENIED');
      }
    }
    // At the function, which is the authority: every role, with or without permissions ticked.
    for (const who of ['admin', 'admin2', 'client', 'outsider'] as Who[]) {
      for (const role of ['client', 'accountant', 'third_party', 'admin']) {
        const begin = await rpc(who, 'begin_member_login', {
          p_org: org, p_email: email(`db-${who}-${role}`), p_role: role, p_permissions: [], p_departments: null,
        });
        expect(['42501', 'P0002']).toContain(sqlstate(begin.error));
      }
    }
    const claims = await orgRow(fs(), org, 'member_login_claims', 'x').parent.get();
    expect(claims.docs.filter((d) => d.get('created_by') !== ids.owner)).toHaveLength(0);
    // Nobody's login was made for a refused attempt.
    expect(await auth().getUserByEmail(email('by-admin-client')).catch(() => null)).toBeNull();

    // A claim the owner started cannot be finished by an admin either (the claim is the owner's).
    const begin = await rpc('owner', 'begin_member_login', {
      p_org: org, p_email: email('late'), p_role: 'client', p_permissions: [], p_departments: null,
    });
    expect(begin.error).toBeNull();
    const fresh = await createAuthUser(email('late'));
    const stolen = await rpc('admin', 'finish_member_login', { p_claim: begin.data as string, p_user: fresh });
    expect(sqlstate(stolen.error)).toBe('P0002');

    // Never an owner this way, even by the owner.
    const owner = await rpc('owner', 'begin_member_login', {
      p_org: org, p_email: email('x3'), p_role: 'owner', p_permissions: [], p_departments: null,
    });
    expect(sqlstate(owner.error)).toBe('22023');
  });

  it('a second owner of the company may create logins too', async () => {
    await addMember(org, ids.outsider, 'owner');
    try {
      const ctx = await ctxFor('outsider');
      const { userId } = await createMemberLogin(ctx, {
        fullName: 'Second Owner Hire', email: email('second-hire'), password: 'Second-owner-1',
        role: 'accountant', permissions: ['dashboard.view'], departments: [],
      });
      expect(await membership(userId)).toMatch(/^accountant\|/);
    } finally {
      await orgRow(fs(), org, 'organization_memberships', ids.outsider).delete();
    }
  });
});

describe('departments', () => {
  it('the owner\'s choice is not an admin\'s to undo; nobody changes their own; an owner has none', async () => {
    expect((await rpc('owner', 'set_member_departments', { p_org: org, p_user: ids.client, p_departments: ['banking'] })).error).toBeNull();
    const undo = await rpc('admin2', 'set_member_departments', { p_org: org, p_user: ids.client, p_departments: null });
    expect(sqlstate(undo.error)).toBe('42501');
    const self = await rpc('admin2', 'set_member_departments', { p_org: org, p_user: ids.admin2, p_departments: ['reports'] });
    expect(sqlstate(self.error)).toBe('42501');
    const ofOwner = await rpc('admin2', 'set_member_departments', { p_org: org, p_user: ids.owner, p_departments: ['reports'] });
    expect(sqlstate(ofOwner.error)).toBe('42501');
    const unknown = await rpc('owner', 'set_member_departments', { p_org: org, p_user: ids.client, p_departments: ['payroll'] });
    expect(sqlstate(unknown.error)).toBe('22023');
  });

  it('narrows what the member can open, and the team page lists it', async () => {
    const ctx = await ctxFor('client');
    expect(ctx.departments).toEqual(['banking']);
    expect(ctx.modules?.has('banking')).toBe(true);
    expect(ctx.modules?.has('reports')).toBe(false);
    expect(ctx.modules?.has('customers')).toBe(false);

    const owner = await ctxFor('owner');
    await setMemberDepartments(owner, { userId: ids.client, role: 'client', departments: ['banking', 'reports'] });
    const listed = await listMemberDepartments(owner);
    expect(listed.find((d) => d.userId === ids.client)).toEqual({ userId: ids.client, departments: ['banking', 'reports'], setByOwner: true });
  });
});
