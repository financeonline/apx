import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { adminSql, clientFor, serviceClientScoped, sqlstate } from './setup';

/**
 * ADR-170 over the real wire: the server reads ONE provider's own model choice — the OpenAI card's,
 * for the Marketing report — whichever provider is active, with the service role alone. The platform
 * setting is saved first and restored after, so the machine's real choice is untouched.
 */

const { aiModelFor } = await import('@/core/db/server-rpc');

let saved: string | null = null;

function setChoice(value: object): void {
  const json = JSON.stringify(value).replace(/'/g, "''");
  adminSql(`insert into public.platform_settings (key, value) values ('ai_model', '${json}'::jsonb)
            on conflict (key) do update set value = excluded.value`);
}

const forProvider = (provider: string) => serviceClientScoped().schema('api_server').rpc('ai_model_for', { p_provider: provider });

beforeAll(() => {
  saved = adminSql(`select value::text from public.platform_settings where key = 'ai_model'`) || null;
});

afterAll(() => {
  adminSql(saved
    ? `insert into public.platform_settings (key, value) values ('ai_model', '${saved.replace(/'/g, "''")}'::jsonb) on conflict (key) do update set value = excluded.value`
    : `delete from public.platform_settings where key = 'ai_model'`);
});

describe('api_server.ai_model_for', () => {
  it('returns the OpenAI card\'s choice while Anthropic is active, and leaves the active read alone', async () => {
    setChoice({ active: 'anthropic', anthropic: { model: 'claude-sonnet-4-6', effort: 'low' }, openai: { model: 'gpt-4.1', effort: null } });
    expect((await forProvider('openai')).data).toEqual({ provider: 'openai', model: 'gpt-4.1', effort: null });
    expect((await forProvider('anthropic')).data).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4-6', effort: 'low' });
    expect((await serviceClientScoped().schema('api_server').rpc('ai_model')).data)
      .toEqual({ provider: 'anthropic', model: 'claude-sonnet-4-6', effort: 'low' });
    // The server's wrapper reads the same.
    expect(await aiModelFor('openai')).toEqual({ provider: 'openai', model: 'gpt-4.1', effort: null });
  });

  it('returns the choice with its effort while OpenAI is active too', async () => {
    setChoice({ active: 'openai', anthropic: null, openai: { model: 'gpt-5', effort: 'high' } });
    expect((await forProvider('openai')).data).toEqual({ provider: 'openai', model: 'gpt-5', effort: 'high' });
    expect((await forProvider('anthropic')).data).toBeNull();
    expect(await aiModelFor('openai')).toEqual({ provider: 'openai', model: 'gpt-5', effort: 'high' });
  });

  it('returns null when that provider has no model chosen, or there is no setting at all', async () => {
    setChoice({ active: 'anthropic', anthropic: null, openai: null });
    expect((await forProvider('openai')).data).toBeNull();
    expect(await aiModelFor('openai')).toBeNull();
    adminSql(`delete from public.platform_settings where key = 'ai_model'`);
    expect((await forProvider('openai')).data).toBeNull();
    expect(await aiModelFor('anthropic')).toBeNull();
  });

  it('refuses a provider it does not know', async () => {
    expect(sqlstate((await forProvider('mistral')).error)).toBe('22023');
  });

  it('is the service role\'s alone: a signed-in browser cannot read it', async () => {
    const browser = clientFor(randomUUID()).schema('api_server');
    expect((await browser.rpc('ai_model_for', { p_provider: 'openai' })).error).not.toBeNull();
  });
});
