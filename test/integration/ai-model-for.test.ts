import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DocumentData } from 'firebase-admin/firestore';
import { globalRow, nowIso } from '@/db/schema';
import { clientFor, fs, rpc, serviceClientScoped, sqlstate } from './setup';

/**
 * ADR-170 over the real wire: the server reads ONE provider's own model choice — the OpenAI card's,
 * for the Marketing report — whichever provider is active, with the service actor alone. The platform
 * setting is saved first and restored after, so the machine's real choice is untouched.
 */

const { aiModelFor } = await import('@/core/db/server-rpc');

const setting = () => globalRow(fs(), 'platform_settings', 'ai_model');
let saved: DocumentData | null = null;

async function setChoice(value: object): Promise<void> {
  const now = nowIso();
  await setting().set({ key: 'ai_model', value, updated_by: null, created_at: now, updated_at: now });
}

const forProvider = (provider: string) => rpc(serviceClientScoped(), 'ai_model_for', { p_provider: provider }, { server: true });

beforeAll(async () => {
  const snap = await setting().get();
  saved = snap.exists ? snap.data()! : null;
});

afterAll(async () => {
  if (saved) await setting().set(saved);
  else await setting().delete();
});

describe('api_server.ai_model_for', () => {
  it('returns the OpenAI card\'s choice while Anthropic is active, and leaves the active read alone', async () => {
    await setChoice({ active: 'anthropic', anthropic: { model: 'claude-sonnet-4-6', effort: 'low' }, openai: { model: 'gpt-4.1', effort: null } });
    expect((await forProvider('openai')).data).toEqual({ provider: 'openai', model: 'gpt-4.1', effort: null });
    expect((await forProvider('anthropic')).data).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4-6', effort: 'low' });
    expect((await rpc(serviceClientScoped(), 'ai_model', {}, { server: true })).data)
      .toEqual({ provider: 'anthropic', model: 'claude-sonnet-4-6', effort: 'low' });
    // The server's wrapper reads the same.
    expect(await aiModelFor('openai')).toEqual({ provider: 'openai', model: 'gpt-4.1', effort: null });
  });

  it('returns the choice with its effort while OpenAI is active too', async () => {
    await setChoice({ active: 'openai', anthropic: null, openai: { model: 'gpt-5', effort: 'high' } });
    expect((await forProvider('openai')).data).toEqual({ provider: 'openai', model: 'gpt-5', effort: 'high' });
    expect((await forProvider('anthropic')).data).toBeNull();
    expect(await aiModelFor('openai')).toEqual({ provider: 'openai', model: 'gpt-5', effort: 'high' });
  });

  it('returns null when that provider has no model chosen, or there is no setting at all', async () => {
    await setChoice({ active: 'anthropic', anthropic: null, openai: null });
    expect((await forProvider('openai')).data).toBeNull();
    expect(await aiModelFor('openai')).toBeNull();
    await setting().delete();
    expect((await forProvider('openai')).data).toBeNull();
    expect(await aiModelFor('anthropic')).toBeNull();
  });

  it('refuses a provider it does not know', async () => {
    expect(sqlstate((await forProvider('mistral')).error)).toBe('22023');
  });

  it('is the server\'s alone: a signed-in browser cannot read it', async () => {
    const browser = clientFor(randomUUID());
    expect((await rpc(browser, 'ai_model_for', { p_provider: 'openai' }, { server: true })).error).not.toBeNull();
    expect((await rpc(browser, 'ai_model', {}, { server: true })).error).not.toBeNull();
    expect((await rpc(browser, 'anthropic_api_key', {}, { server: true })).error).not.toBeNull();
  });
});
