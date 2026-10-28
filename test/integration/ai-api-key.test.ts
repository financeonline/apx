import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DocumentData } from 'firebase-admin/firestore';
import { auth } from '@/db/firestore';
import { SECRETS_COLLECTION } from '@/db/app/secrets';
import { nowIso } from '@/db/schema';
import { clientFor, createAuthUser, fs, rpc, serviceClientScoped, sqlstate } from './setup';

/**
 * ADR-157 over the real wire: the AI provider key is set and removed only by the super admin
 * with a fresh sign-in, is stored encrypted (the `platform_secrets` store that replaced Vault, never
 * in a readable table), is shown only as its last four characters, and is readable in clear by the
 * server alone.
 */

const RUN = `ak${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.aikey.itest.motion`;
const KEY_A = `sk-ant-test-${'a'.repeat(30)}WXYZ`;
const KEY_B = `sk-ant-test-${'b'.repeat(30)}PQRS`;
const SECRET = 'anthropic_api_key';

let adminId: string;
let ownerId: string;
/** A key stored on this machine before the suite, put back after it (the emulator is shared). */
let saved: DocumentData | null = null;

const secretRef = () => fs().collection(SECRETS_COLLECTION).doc(SECRET);
const asAdmin = (fn: string, args: Record<string, unknown> = {}) => rpc(clientFor(adminId), fn, args);

beforeAll(async () => {
  const existing = await secretRef().get();
  saved = existing.exists ? existing.data()! : null;
  await secretRef().delete();
  adminId = await createAuthUser(`admin@${DOMAIN}`);
  ownerId = await createAuthUser(`owner@${DOMAIN}`);
  const now = nowIso();
  await fs().collection('platform_users').doc(adminId).set({
    user_id: adminId, platform_role: 'super_admin', status: 'active', granted_by: null, notes: null,
    created_at: now, updated_at: now,
  });
});

afterAll(async () => {
  await secretRef().delete();
  if (saved) await secretRef().set(saved);
  for (const id of [adminId, ownerId]) {
    await fs().collection('platform_users').doc(id).delete();
    await fs().collection('profiles').doc(id).delete();
  }
  await auth().deleteUsers([adminId, ownerId]);
});

describe('api.set_ai_api_key / ai_api_key_status / clear_ai_api_key', () => {
  it('stores the key encrypted and reports only its last four characters', async () => {
    const set = await asAdmin('set_ai_api_key', { p_key: KEY_A });
    expect(set.error).toBeNull();
    expect(set.data).toBe('WXYZ');

    // Encrypted at rest: the stored value is not the key.
    const stored = (await secretRef().get()).data()!;
    expect(JSON.stringify(stored)).not.toContain('sk-ant-');
    expect(stored.description).toBe('ending WXYZ');
    const status = await asAdmin('ai_api_key_status');
    expect(status.error).toBeNull();
    expect(status.data).toEqual([expect.objectContaining({ configured: true, ending: 'WXYZ' })]);
    expect(JSON.stringify(status.data)).not.toContain('sk-ant-');
  });

  it('replaces the stored key with a new one', async () => {
    expect((await asAdmin('set_ai_api_key', { p_key: KEY_B })).data).toBe('PQRS');
    expect((await secretRef().get()).get('description')).toBe('ending PQRS');
  });

  it('only the server reads it in clear', async () => {
    const server = await rpc(serviceClientScoped(), 'anthropic_api_key', {}, { server: true });
    expect(server.error).toBeNull();
    expect(server.data).toBe(KEY_B);
    const user = await rpc(clientFor(adminId), 'anthropic_api_key', {}, { server: true });
    expect(user.error).not.toBeNull();
  });

  it('refuses a value that is not an Anthropic key', async () => {
    expect(sqlstate((await asAdmin('set_ai_api_key', { p_key: 'hello' })).error)).toBe('22023');
  });

  it('refuses an organisation owner, and the super admin without a recent sign-in', async () => {
    const owner = clientFor(ownerId);
    expect(sqlstate((await rpc(owner, 'set_ai_api_key', { p_key: KEY_A })).error)).toBe('42501');
    expect(sqlstate((await rpc(owner, 'ai_api_key_status')).error)).toBe('42501');
    expect(sqlstate((await rpc(owner, 'clear_ai_api_key')).error)).toBe('42501');
    const stale = clientFor(adminId, { authTime: Math.floor(Date.now() / 1000) - 3600 });
    expect(sqlstate((await rpc(stale, 'set_ai_api_key', { p_key: KEY_A })).error)).toBe('42501');
  });

  it('shows the super admin, signed in with a password, the key status (ADR-161)', async () => {
    const { data, error } = await asAdmin('ai_api_key_status');
    expect(error).toBeNull();
    expect(data).toBeDefined();
  });

  it('records the change in the audit log without the key', async () => {
    const events = await fs().collection('audit_events').where('actor_user_id', '==', adminId).get();
    const audited = events.docs.map((d) => d.data()).filter((e) => String(e.action).startsWith('platform.ai_key_'));
    expect(audited.map((e) => e.action)).toContain('platform.ai_key_set');
    expect(JSON.stringify(audited)).not.toContain('sk-ant-');
  });

  it('removes the key', async () => {
    expect((await asAdmin('clear_ai_api_key')).data).toBe(true);
    expect((await asAdmin('ai_api_key_status')).data).toEqual([expect.objectContaining({ configured: false, ending: null })]);
    expect((await asAdmin('clear_ai_api_key')).data).toBe(false);
  });
});
