import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { adminSql, clientFor, createAuthUser, resetFixtures, sqlstate } from './setup';

/**
 * ADR-159 over the real wire: there is one super admin. The grant and revoke functions — the only
 * paths to platform_users — refuse a second super admin, a demotion and a removal; staff are
 * unaffected.
 */

const DOMAIN = `one-sa-${Date.now()}.itest.motion`;
let adminId: string;
let staffId: string;
let personId: string;

const asAdmin = (fn: string, args: Record<string, unknown>) =>
  clientFor(adminId, { aal: 'aal2' }).schema('api').rpc(fn, args);

beforeAll(() => {
  resetFixtures();
  adminId = createAuthUser(`admin@${DOMAIN}`);
  staffId = createAuthUser(`staff@${DOMAIN}`);
  personId = createAuthUser(`person@${DOMAIN}`);
  adminSql(`insert into public.platform_users (user_id, platform_role, status) values ('${adminId}', 'super_admin', 'active');
            update public.profiles set mfa_enrolled_at = now() where id = '${adminId}';`);
});

afterAll(() => {
  adminSql(`delete from public.platform_users where user_id in (select id from auth.users where email like '%@${DOMAIN}');`);
  resetFixtures();
});

const roleOf = (id: string) =>
  adminSql(`select coalesce((select platform_role::text from public.platform_users where user_id = '${id}'), 'none')`);

describe('one super admin', () => {
  it('adds staff as before', async () => {
    const { error } = await asAdmin('grant_platform_role', { p_user: staffId, p_role: 'employee' });
    expect(error).toBeNull();
    expect(roleOf(staffId)).toBe('employee');
  });

  it('refuses to make a second super admin, from a new person or from staff', async () => {
    expect(sqlstate((await asAdmin('grant_platform_role', { p_user: personId, p_role: 'super_admin' })).error)).toBe('23505');
    expect(roleOf(personId)).toBe('none');
    expect(sqlstate((await asAdmin('grant_platform_role', { p_user: staffId, p_role: 'super_admin' })).error)).toBe('23505');
    expect(roleOf(staffId)).toBe('employee');
  });

  it('refuses to demote or remove the super admin, and still removes staff', async () => {
    expect(sqlstate((await asAdmin('grant_platform_role', { p_user: adminId, p_role: 'employee' })).error)).toBe('23505');
    expect(sqlstate((await asAdmin('revoke_platform_role', { p_user: adminId })).error)).toBe('23505');
    expect(roleOf(adminId)).toBe('super_admin');
    expect((await asAdmin('revoke_platform_role', { p_user: staffId })).error).toBeNull();
    expect(roleOf(staffId)).toBe('none');
  });
});
