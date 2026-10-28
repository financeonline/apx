import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auth } from '@/db/firestore';
import { globalRow } from '@/db/schema';
import { clientFor, createAuthUser, fs, rpc, sqlstate } from './setup';
import { dropPlatformUser, makePlatformUser } from './tenancy-fixtures';

/**
 * ADR-159: there is one super admin. The grant and revoke functions — the only paths to
 * platform_users — refuse a second super admin, a demotion and a removal; staff are unaffected.
 */

const RUN = `sa${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.one-sa.itest.motion`;
let adminId: string;
let staffId: string;
let personId: string;

const asAdmin = (fn: string, args: Record<string, unknown>) => rpc(clientFor(adminId), fn, args);

beforeAll(async () => {
  adminId = await createAuthUser(`admin@${DOMAIN}`);
  staffId = await createAuthUser(`staff@${DOMAIN}`);
  personId = await createAuthUser(`person@${DOMAIN}`);
  await makePlatformUser(adminId, 'super_admin');
});

afterAll(async () => {
  for (const id of [adminId, staffId, personId]) {
    await dropPlatformUser(id);
    await auth().deleteUser(id).catch(() => undefined);
    await globalRow(fs(), 'profiles', id).delete();
  }
});

const roleOf = async (id: string) =>
  ((await globalRow(fs(), 'platform_users', id).get()).get('platform_role') as string | undefined) ?? 'none';

describe('one super admin', () => {
  it('adds staff as before', async () => {
    const { error } = await asAdmin('grant_platform_role', { p_user: staffId, p_role: 'employee' });
    expect(error).toBeNull();
    expect(await roleOf(staffId)).toBe('employee');
  });

  it('refuses to make a second super admin, from a new person or from staff', async () => {
    expect(sqlstate((await asAdmin('grant_platform_role', { p_user: personId, p_role: 'super_admin' })).error)).toBe('23505');
    expect(await roleOf(personId)).toBe('none');
    expect(sqlstate((await asAdmin('grant_platform_role', { p_user: staffId, p_role: 'super_admin' })).error)).toBe('23505');
    expect(await roleOf(staffId)).toBe('employee');
  });

  it('refuses to demote or remove the super admin, and still removes staff', async () => {
    expect(sqlstate((await asAdmin('grant_platform_role', { p_user: adminId, p_role: 'employee' })).error)).toBe('23505');
    expect(sqlstate((await asAdmin('revoke_platform_role', { p_user: adminId })).error)).toBe('23505');
    expect(await roleOf(adminId)).toBe('super_admin');
    expect((await asAdmin('revoke_platform_role', { p_user: staffId })).error).toBeNull();
    expect(await roleOf(staffId)).toBe('none');
  });
});
