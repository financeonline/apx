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
    adminSql(`delete from public.platform_settings where key = 'ai_model'`);
    expect((await asAdmin({ p_model: 'claude-sonnet-4-6', p_effort: 'low' })).error).toBeNull();
    const server = await serviceClientScoped().schema('api_server').rpc('ai_model');
    expect(server.data).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4-6', effort: 'low' });
  });

  it('remembers an OpenAI model without making it active (ADR-165), and refuses an effort OpenAI does not take', async () => {
    expect((await asAdmin({ p_model: 'gpt-4.1', p_effort: null, p_provider: 'openai' })).error).toBeNull();
    const server = await serviceClientScoped().schema('api_server').rpc('ai_model');
    expect(server.data).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4-6', effort: 'low' });
    expect(JSON.parse(adminSql(`select value::text from public.platform_settings where key = 'ai_model'`)))
      .toEqual({ active: 'anthropic', anthropic: { model: 'claude-sonnet-4-6', effort: 'low' }, openai: { model: 'gpt-4.1', effort: null } });
    expect(sqlstate((await asAdmin({ p_model: 'o3', p_effort: 'max', p_provider: 'openai' })).error)).toBe('22023');
    expect(sqlstate((await asAdmin({ p_model: 'gpt-4.1', p_effort: null, p_provider: 'mistral' })).error)).toBe('22023');
    expect(sqlstate((await asAdmin({ p_model: 'gpt-4.1', p_effort: null, p_provider: 'anthropic' })).error)).toBe('22023');
  });

  it('clears Anthropic back to the default model, keeping OpenAI\'s choice', async () => {
    expect((await asAdmin({ p_model: null, p_effort: null })).error).toBeNull();
    expect((await serviceClientScoped().schema('api_server').rpc('ai_model')).data).toBeNull();
    expect(adminSql(`select value -> 'openai' ->> 'model' from public.platform_settings where key = 'ai_model'`)).toBe('gpt-4.1');
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

describe('the OpenAI key (ADR-164)', () => {
  const KEY = `sk-proj-${'q'.repeat(40)}LMNO`;
  let savedKey: { secret: string; description: string } | null = null;

  beforeAll(() => {
    const existing = adminSql(`select coalesce(json_build_object('secret', decrypted_secret, 'description', description)::text, '')
                                 from vault.decrypted_secrets where name = 'openai_api_key'`);
    savedKey = existing ? (JSON.parse(existing) as { secret: string; description: string }) : null;
    adminSql(`delete from vault.secrets where name = 'openai_api_key'`);
  });

  afterAll(() => {
    adminSql(`delete from vault.secrets where name = 'openai_api_key'`);
    if (savedKey) {
      const q = (v: string) => `'${v.replace(/'/g, "''")}'`;
      adminSql(`select vault.create_secret(${q(savedKey.secret)}, 'openai_api_key', ${q(savedKey.description)})`);
    }
  });

  it('is stored encrypted, shown by its last four characters, and read in clear by the server alone', async () => {
    const api = clientFor(adminId).schema('api');
    expect((await api.rpc('set_openai_api_key', { p_key: KEY })).data).toBe('LMNO');
    expect(adminSql(`select count(*) from vault.secrets where name = 'openai_api_key' and secret like '%qqqq%'`)).toBe('0');
    const status = (await api.rpc('openai_api_key_status')).data as Array<{ configured: boolean; ending: string }>;
    expect(status[0]).toMatchObject({ configured: true, ending: 'LMNO' });
    expect((await serviceClientScoped().schema('api_server').rpc('openai_api_key')).data).toBe(KEY);
    expect((await clientFor(adminId).schema('api_server').rpc('openai_api_key')).error).not.toBeNull();
  });

  it('refuses an Anthropic key, a malformed key, an owner and a stale sign-in; and is removed', async () => {
    const api = clientFor(adminId).schema('api');
    expect(sqlstate((await api.rpc('set_openai_api_key', { p_key: `sk-ant-${'a'.repeat(30)}` })).error)).toBe('22023');
    expect(sqlstate((await api.rpc('set_openai_api_key', { p_key: 'hello' })).error)).toBe('22023');
    expect(sqlstate((await clientFor(ownerId).schema('api').rpc('set_openai_api_key', { p_key: KEY })).error)).toBe('42501');
    const stale = clientFor(adminId, { amrTimestamp: Math.floor(Date.now() / 1000) - 3600 });
    expect(sqlstate((await stale.schema('api').rpc('clear_openai_api_key')).error)).toBe('42501');
    expect((await api.rpc('clear_openai_api_key')).data).toBe(true);
    expect(adminSql(`select count(*) from vault.secrets where name = 'openai_api_key'`)).toBe('0');
  });
});

describe('one provider is active (ADR-165)', () => {
  const KEY = `sk-proj-${'r'.repeat(40)}WXYZ`;
  const activate = (provider: string) => clientFor(adminId).schema('api').rpc('set_ai_active_provider', { p_provider: provider });
  let savedKey: string | null = null;

  beforeAll(() => {
    savedKey = adminSql(`select coalesce((select decrypted_secret from vault.decrypted_secrets where name = 'openai_api_key'), '')`) || null;
    adminSql(`delete from vault.secrets where name = 'openai_api_key'; delete from public.platform_settings where key = 'ai_model';`);
  });

  afterAll(() => {
    adminSql(`delete from vault.secrets where name = 'openai_api_key'`);
    if (savedKey) adminSql(`select vault.create_secret('${savedKey.replace(/'/g, "''")}', 'openai_api_key', 'ending ${savedKey.slice(-4)}')`);
  });

  it('refuses OpenAI without its key, then without a model', async () => {
    expect(sqlstate((await activate('openai')).error)).toBe('22023');
    expect((await clientFor(adminId).schema('api').rpc('set_openai_api_key', { p_key: KEY })).error).toBeNull();
    expect(sqlstate((await activate('openai')).error)).toBe('22023');
  });

  it('makes OpenAI active and Anthropic inactive, and back', async () => {
    expect((await asAdmin({ p_model: 'gpt-4.1', p_effort: null, p_provider: 'openai' })).error).toBeNull();
    expect((await activate('openai')).error).toBeNull();
    expect((await serviceClientScoped().schema('api_server').rpc('ai_model')).data).toEqual({ provider: 'openai', model: 'gpt-4.1', effort: null });
    expect(sqlstate((await asAdmin({ p_model: null, p_effort: null, p_provider: 'openai' })).error)).toBe('23505');
    expect((await activate('anthropic')).error).toBeNull();
    expect((await serviceClientScoped().schema('api_server').rpc('ai_model')).data).toBeNull();
  });

  it('falls back to Anthropic when the OpenAI key is removed while OpenAI is active', async () => {
    expect((await activate('openai')).error).toBeNull();
    expect((await clientFor(adminId).schema('api').rpc('clear_openai_api_key')).data).toBe(true);
    expect(adminSql(`select value ->> 'active' from public.platform_settings where key = 'ai_model'`)).toBe('anthropic');
  });

  it('refuses an owner and a stale sign-in', async () => {
    expect(sqlstate((await clientFor(ownerId).schema('api').rpc('set_ai_active_provider', { p_provider: 'anthropic' })).error)).toBe('42501');
    const stale = clientFor(adminId, { amrTimestamp: Math.floor(Date.now() / 1000) - 3600 });
    expect(sqlstate((await stale.schema('api').rpc('set_ai_active_provider', { p_provider: 'anthropic' })).error)).toBe('42501');
  });
});

