import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { adminSql, clientFor, createAuthUser, resetFixtures, serviceClientScoped, sqlstate } from './setup';

/**
 * ADR-163 over the real wire: only the super admin (recent sign-in) chooses the AI model and its
 * effort; the shapes are checked; the server reads the choice with the service role alone.
 */

const DOMAIN = `aimodel-${Date.now()}.itest.motion`;
let adminId: string;
let ownerId: string;
let saved: string | null = null;

const asAdmin = (args: Record<string, unknown>) => clientFor(adminId).schema('api').rpc('set_ai_model', args);

beforeAll(() => {
  resetFixtures();
  saved = adminSql(`select value::text from public.platform_settings where key = 'ai_model'`) || null;
  adminId = createAuthUser(`admin@${DOMAIN}`);
  ownerId = createAuthUser(`owner@${DOMAIN}`);
  adminSql(`insert into public.platform_users (user_id, platform_role, status) values ('${adminId}', 'super_admin', 'active');`);
});

afterAll(() => {
  adminSql(saved
    ? `insert into public.platform_settings (key, value) values ('ai_model', '${saved}'::jsonb) on conflict (key) do update set value = excluded.value`
    : `delete from public.platform_settings where key = 'ai_model'`);
  adminSql(`delete from public.platform_users where user_id in (select id from auth.users where email like '%@${DOMAIN}');`);
  resetFixtures();
});

describe('api.set_ai_model', () => {
  it('stores a model and effort, and the server reads them', async () => {
    expect((await asAdmin({ p_model: 'claude-sonnet-4-6', p_effort: 'low' })).error).toBeNull();
    const server = await serviceClientScoped().schema('api_server').rpc('ai_model');
    expect(server.data).toEqual({ model: 'claude-sonnet-4-6', effort: 'low' });
  });

  it('clears the choice back to the default', async () => {
    expect((await asAdmin({ p_model: null, p_effort: null })).error).toBeNull();
    expect(adminSql(`select count(*) from public.platform_settings where key = 'ai_model'`)).toBe('0');
  });

  it('refuses a malformed model, an unknown effort, and an effort without a model', async () => {
    expect(sqlstate((await asAdmin({ p_model: 'gpt-4', p_effort: null })).error)).toBe('22023');
    expect(sqlstate((await asAdmin({ p_model: 'claude-sonnet-4-6', p_effort: 'turbo' })).error)).toBe('22023');
    expect(sqlstate((await asAdmin({ p_model: null, p_effort: 'low' })).error)).toBe('22023');
  });

  it('refuses an owner, a stale sign-in, and a browser reading the server function', async () => {
    expect(sqlstate((await clientFor(ownerId).schema('api').rpc('set_ai_model', { p_model: 'claude-sonnet-4-6', p_effort: null })).error)).toBe('42501');
    const stale = clientFor(adminId, { amrTimestamp: Math.floor(Date.now() / 1000) - 3600 });
    expect(sqlstate((await stale.schema('api').rpc('set_ai_model', { p_model: 'claude-sonnet-4-6', p_effort: null })).error)).toBe('42501');
    expect((await clientFor(adminId).schema('api_server').rpc('ai_model')).error).not.toBeNull();
  });

  it('records each change in the audit log', () => {
    expect(Number(adminSql(`select count(*) from public.audit_events where action = 'platform.ai_model_changed' and actor_user_id = '${adminId}'`))).toBeGreaterThan(0);
  });
});
