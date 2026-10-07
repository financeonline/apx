import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { adminSql, clientFor, createAuthUser, resetFixtures, serviceClientScoped, sqlstate } from './setup';

/**
 * ADR-157 over the real wire: the AI provider key is set and removed only by a super admin at aal2
 * with a fresh sign-in, is stored encrypted in Vault (never in a table), is shown only as its last
 * four characters, and is readable in clear by the service role alone.
 */

const DOMAIN = `aikey-${Date.now()}.itest.motion`;
const KEY_A = `sk-ant-test-${'a'.repeat(30)}WXYZ`;
const KEY_B = `sk-ant-test-${'b'.repeat(30)}PQRS`;

let adminId: string;
let ownerId: string;
/** A key the owner stored on this machine, put back after the tests (they share the local database). */
let saved: { secret: string; description: string } | null = null;

const asAdmin = (fn: string, args: Record<string, unknown> = {}) =>
  clientFor(adminId, { aal: 'aal2' }).schema('api').rpc(fn, args);

beforeAll(() => {
  resetFixtures();
  const existing = adminSql(`select coalesce(json_build_object('secret', decrypted_secret, 'description', description)::text, '')
                               from vault.decrypted_secrets where name = 'anthropic_api_key'`);
  saved = existing ? (JSON.parse(existing) as { secret: string; description: string }) : null;
  adminSql(`delete from vault.secrets where name = 'anthropic_api_key'`);
  adminId = createAuthUser(`admin@${DOMAIN}`);
  ownerId = createAuthUser(`owner@${DOMAIN}`);
  adminSql(`
    insert into public.platform_users (user_id, platform_role, status) values ('${adminId}', 'super_admin', 'active');
    update public.profiles set mfa_enrolled_at = now() where id = '${adminId}';`);
});

afterAll(() => {
  adminSql(`delete from vault.secrets where name = 'anthropic_api_key';
            delete from public.platform_users where user_id in (select id from auth.users where email like '%@${DOMAIN}');`);
  if (saved) {
    const q = (v: string) => `'${v.replace(/'/g, "''")}'`;
    adminSql(`select vault.create_secret(${q(saved.secret)}, 'anthropic_api_key', ${q(saved.description)})`);
  }
  resetFixtures();
});

describe('api.set_ai_api_key / ai_api_key_status / clear_ai_api_key', () => {
  it('stores the key encrypted and reports only its last four characters', async () => {
    const set = await asAdmin('set_ai_api_key', { p_key: KEY_A });
    expect(set.error).toBeNull();
    expect(set.data).toBe('WXYZ');

    // Encrypted at rest: the stored secret column is not the key.
    expect(adminSql(`select secret from vault.secrets where name = 'anthropic_api_key'`)).not.toContain('sk-ant-');
    const status = await asAdmin('ai_api_key_status');
    expect(status.error).toBeNull();
    expect(status.data).toEqual([expect.objectContaining({ configured: true, ending: 'WXYZ' })]);
    expect(JSON.stringify(status.data)).not.toContain('sk-ant-');
  });

  it('replaces the stored key with a new one', async () => {
    expect((await asAdmin('set_ai_api_key', { p_key: KEY_B })).data).toBe('PQRS');
    expect(adminSql(`select count(*) from vault.secrets where name = 'anthropic_api_key'`)).toBe('1');
  });

  it('only the service role reads it in clear', async () => {
    const server = await serviceClientScoped().schema('api_server').rpc('anthropic_api_key');
    expect(server.error).toBeNull();
    expect(server.data).toBe(KEY_B);
    const user = await clientFor(adminId, { aal: 'aal2' }).schema('api_server').rpc('anthropic_api_key');
    expect(user.error).not.toBeNull();
  });

  it('refuses a value that is not an Anthropic key', async () => {
    expect(sqlstate((await asAdmin('set_ai_api_key', { p_key: 'hello' })).error)).toBe('22023');
  });

  it('refuses an organisation owner, and an admin without two-step sign-in', async () => {
    const owner = clientFor(ownerId, { aal: 'aal2' }).schema('api');
    expect(sqlstate((await owner.rpc('set_ai_api_key', { p_key: KEY_A })).error)).toBe('42501');
    expect(sqlstate((await owner.rpc('ai_api_key_status')).error)).toBe('42501');
    expect(sqlstate((await owner.rpc('clear_ai_api_key')).error)).toBe('42501');
    const aal1 = clientFor(adminId, { aal: 'aal1' }).schema('api');
    expect(sqlstate((await aal1.rpc('set_ai_api_key', { p_key: KEY_A })).error)).toBe('42501');
  });

  it('records the change in the audit log without the key', () => {
    const audited = adminSql(`select string_agg(action || ':' || coalesce(after::text, ''), ' | ')
                                from public.audit_events where action like 'platform.ai_key_%'`);
    expect(audited).toContain('platform.ai_key_set');
    expect(audited).not.toContain('sk-ant-');
  });

  it('removes the key', async () => {
    expect((await asAdmin('clear_ai_api_key')).data).toBe(true);
    expect((await asAdmin('ai_api_key_status')).data).toEqual([expect.objectContaining({ configured: false, ending: null })]);
    expect((await asAdmin('clear_ai_api_key')).data).toBe(false);
  });
});
