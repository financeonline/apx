import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DocumentData } from 'firebase-admin/firestore';
import { auth } from '@/db/firestore';
import { SECRETS_COLLECTION } from '@/db/app/secrets';
import { nowIso } from '@/db/schema';
import { clientFor, createAuthUser, fs, rpc, serviceClientScoped, sqlstate } from './setup';

/**
 * ADR-163 over the real wire: only the super admin (recent sign-in) chooses the AI model and its
 * effort; the shapes are checked; the server reads the choice through `api_server` alone.
 *
 * The `platform_settings/ai_model` document and the OpenAI secret are platform-wide and shared with
 * other suites on the same emulator, so each is saved before and put back after.
 */

const RUN = `am${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.aimodel.itest.motion`;
let adminId: string;
let ownerId: string;
let savedSetting: DocumentData | null = null;

const settingRef = () => fs().collection('platform_settings').doc('ai_model');
const openAiRef = () => fs().collection(SECRETS_COLLECTION).doc('openai_api_key');
const setting = async () => (await settingRef().get()).get('value') as Record<string, unknown> | undefined;
const asAdmin = (args: Record<string, unknown>) => rpc(clientFor(adminId), 'set_ai_model', args);
const serverModel = () => rpc(serviceClientScoped(), 'ai_model', {}, { server: true });
const stale = () => clientFor(adminId, { authTime: Math.floor(Date.now() / 1000) - 3600 });

beforeAll(async () => {
  const s = await settingRef().get();
  savedSetting = s.exists ? s.data()! : null;
  adminId = await createAuthUser(`admin@${DOMAIN}`);
  ownerId = await createAuthUser(`owner@${DOMAIN}`);
  const now = nowIso();
  await fs().collection('platform_users').doc(adminId).set({
    user_id: adminId, platform_role: 'super_admin', status: 'active', granted_by: null, notes: null,
    created_at: now, updated_at: now,
  });
});

afterAll(async () => {
  if (savedSetting) await settingRef().set(savedSetting);
  else await settingRef().delete();
  for (const id of [adminId, ownerId]) {
    await fs().collection('platform_users').doc(id).delete();
    await fs().collection('profiles').doc(id).delete();
  }
  await auth().deleteUsers([adminId, ownerId]);
});

describe('api.set_ai_model', () => {
  it('stores a model and effort, and the server reads them', async () => {
    await settingRef().delete();
    expect((await asAdmin({ p_model: 'claude-sonnet-4-6', p_effort: 'low' })).error).toBeNull();
    expect((await serverModel()).data).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4-6', effort: 'low' });
  });

  it('remembers an OpenAI model without making it active (ADR-165), and refuses an effort OpenAI does not take', async () => {
    expect((await asAdmin({ p_model: 'gpt-4.1', p_effort: null, p_provider: 'openai' })).error).toBeNull();
    expect((await serverModel()).data).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4-6', effort: 'low' });
    expect(await setting())
      .toEqual({ active: 'anthropic', anthropic: { model: 'claude-sonnet-4-6', effort: 'low' }, openai: { model: 'gpt-4.1', effort: null } });
    expect(sqlstate((await asAdmin({ p_model: 'o3', p_effort: 'max', p_provider: 'openai' })).error)).toBe('22023');
    expect(sqlstate((await asAdmin({ p_model: 'gpt-4.1', p_effort: null, p_provider: 'mistral' })).error)).toBe('22023');
    expect(sqlstate((await asAdmin({ p_model: 'gpt-4.1', p_effort: null, p_provider: 'anthropic' })).error)).toBe('22023');
  });

  it('clears Anthropic back to the default model, keeping OpenAI\'s choice', async () => {
    expect((await asAdmin({ p_model: null, p_effort: null })).error).toBeNull();
    expect((await serverModel()).data).toBeNull();
    expect((await setting())?.openai).toMatchObject({ model: 'gpt-4.1' });
  });

  it('refuses a malformed model, an unknown effort, and an effort without a model', async () => {
    expect(sqlstate((await asAdmin({ p_model: 'gpt-4', p_effort: null })).error)).toBe('22023');
    expect(sqlstate((await asAdmin({ p_model: 'claude-sonnet-4-6', p_effort: 'turbo' })).error)).toBe('22023');
    expect(sqlstate((await asAdmin({ p_model: null, p_effort: 'low' })).error)).toBe('22023');
  });

  it('refuses an owner, a stale sign-in, and a browser reading the server function', async () => {
    expect(sqlstate((await rpc(clientFor(ownerId), 'set_ai_model', { p_model: 'claude-sonnet-4-6', p_effort: null })).error)).toBe('42501');
    expect(sqlstate((await rpc(stale(), 'set_ai_model', { p_model: 'claude-sonnet-4-6', p_effort: null })).error)).toBe('42501');
    expect((await rpc(clientFor(adminId), 'ai_model', {}, { server: true })).error).not.toBeNull();
  });

  it('records each change in the audit log', async () => {
    const events = await fs().collection('audit_events').where('actor_user_id', '==', adminId)
      .where('action', '==', 'platform.ai_model_changed').get();
    expect(events.size).toBeGreaterThan(0);
  });
});

describe('the OpenAI key (ADR-164)', () => {
  const KEY = `sk-proj-${'q'.repeat(40)}LMNO`;
  let savedKey: DocumentData | null = null;

  beforeAll(async () => {
    const existing = await openAiRef().get();
    savedKey = existing.exists ? existing.data()! : null;
    await openAiRef().delete();
  });

  afterAll(async () => {
    await openAiRef().delete();
    if (savedKey) await openAiRef().set(savedKey);
  });

  it('is stored encrypted, shown by its last four characters, and read in clear by the server alone', async () => {
    const admin = clientFor(adminId);
    expect((await rpc(admin, 'set_openai_api_key', { p_key: KEY })).data).toBe('LMNO');
    expect(JSON.stringify((await openAiRef().get()).data())).not.toContain('qqqq');
    const status = (await rpc(admin, 'openai_api_key_status')).data as Array<{ configured: boolean; ending: string }>;
    expect(status[0]).toMatchObject({ configured: true, ending: 'LMNO' });
    expect((await rpc(serviceClientScoped(), 'openai_api_key', {}, { server: true })).data).toBe(KEY);
    expect((await rpc(admin, 'openai_api_key', {}, { server: true })).error).not.toBeNull();
  });

  it('refuses an Anthropic key, a malformed key, an owner and a stale sign-in; and is removed', async () => {
    const admin = clientFor(adminId);
    expect(sqlstate((await rpc(admin, 'set_openai_api_key', { p_key: `sk-ant-${'a'.repeat(30)}` })).error)).toBe('22023');
    expect(sqlstate((await rpc(admin, 'set_openai_api_key', { p_key: 'hello' })).error)).toBe('22023');
    expect(sqlstate((await rpc(clientFor(ownerId), 'set_openai_api_key', { p_key: KEY })).error)).toBe('42501');
    expect(sqlstate((await rpc(stale(), 'clear_openai_api_key')).error)).toBe('42501');
    expect((await rpc(admin, 'clear_openai_api_key')).data).toBe(true);
    expect((await openAiRef().get()).exists).toBe(false);
  });
});

describe('one provider is active (ADR-165)', () => {
  const KEY = `sk-proj-${'r'.repeat(40)}WXYZ`;
  const activate = (provider: string) => rpc(clientFor(adminId), 'set_ai_active_provider', { p_provider: provider });
  let savedKey: DocumentData | null = null;

  beforeAll(async () => {
    const existing = await openAiRef().get();
    savedKey = existing.exists ? existing.data()! : null;
    await openAiRef().delete();
    await settingRef().delete();
  });

  afterAll(async () => {
    await openAiRef().delete();
    if (savedKey) await openAiRef().set(savedKey);
  });

  it('refuses OpenAI without its key, then without a model', async () => {
    expect(sqlstate((await activate('openai')).error)).toBe('22023');
    expect((await rpc(clientFor(adminId), 'set_openai_api_key', { p_key: KEY })).error).toBeNull();
    expect(sqlstate((await activate('openai')).error)).toBe('22023');
  });

  it('makes OpenAI active and Anthropic inactive, and back', async () => {
    expect((await asAdmin({ p_model: 'gpt-4.1', p_effort: null, p_provider: 'openai' })).error).toBeNull();
    expect((await activate('openai')).error).toBeNull();
    expect((await serverModel()).data).toEqual({ provider: 'openai', model: 'gpt-4.1', effort: null });
    expect(sqlstate((await asAdmin({ p_model: null, p_effort: null, p_provider: 'openai' })).error)).toBe('23505');
    expect((await activate('anthropic')).error).toBeNull();
    expect((await serverModel()).data).toBeNull();
  });

  it('falls back to Anthropic when the OpenAI key is removed while OpenAI is active', async () => {
    expect((await activate('openai')).error).toBeNull();
    expect((await rpc(clientFor(adminId), 'clear_openai_api_key')).data).toBe(true);
    expect((await setting())?.active).toBe('anthropic');
  });

  it('refuses an owner and a stale sign-in', async () => {
    expect(sqlstate((await rpc(clientFor(ownerId), 'set_ai_active_provider', { p_provider: 'anthropic' })).error)).toBe('42501');
    expect(sqlstate((await rpc(stale(), 'set_ai_active_provider', { p_provider: 'anthropic' })).error)).toBe('42501');
  });
});
