import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UpstreamError } from '@/core/errors';
import type { ModelCall, ModelResponse } from '@/modules/ai';

/**
 * ADR-170: the report transport always calls OpenAI — the stored OpenAI key and the OpenAI card's own
 * model and effort — whichever provider is active, and fails closed with a message naming the fix.
 * The database reads and the HTTP call are mocked: no network, no key, no cost.
 */

const db = vi.hoisted(() => ({ aiModelFor: vi.fn(), openAiApiKeyFromVault: vi.fn() }));
const openai = vi.hoisted(() => ({ callOpenAi: vi.fn() }));

vi.mock('@/core/db/server-rpc', async (importOriginal) => ({ ...(await importOriginal<object>()), ...db }));
vi.mock('@/modules/ai/data/openai-client', async (importOriginal) => ({ ...(await importOriginal<object>()), ...openai }));

const { openAiReportTransport, reportOutputCeiling, NO_OPENAI_KEY, NO_OPENAI_MODEL, REPORT_MAX_TOKENS, REPORT_TIMEOUT_MS } = await import('@/modules/ai/data/openai-report-transport');

/** A report's request: up to 3.5 minutes, never resent after running out of time. */
const REPORT_CALL = { timeoutMs: REPORT_TIMEOUT_MS, retryOnTimeout: false };

const call: ModelCall = {
  system: [{ text: 'Rules.', cached: true }],
  messages: [{ role: 'user', content: 'Write the report.' }],
  tools: [],
  toolChoice: { type: 'auto' },
};
const reply: ModelResponse = { content: [], stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 }, model: 'gpt-4.1-2025-04-14' };

beforeEach(() => {
  vi.stubEnv('MOTION_AI_OFFLINE', '');
  vi.stubEnv('OPENAI_API_KEY', '');
  db.openAiApiKeyFromVault.mockResolvedValue('sk-stored');
  db.aiModelFor.mockResolvedValue({ provider: 'openai', model: 'gpt-4.1', effort: null });
  openai.callOpenAi.mockResolvedValue(reply);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('openAiReportTransport', () => {
  it('calls OpenAI with the stored key and the OpenAI card\'s model, asking for the OpenAI choice by name', async () => {
    expect(await openAiReportTransport(call)).toBe(reply);
    expect(db.aiModelFor).toHaveBeenCalledWith('openai');
    expect(openai.callOpenAi).toHaveBeenCalledWith(call, 'sk-stored', 'gpt-4.1', null, REPORT_MAX_TOKENS, REPORT_CALL);
  });

  it('passes the card\'s effort, and ignores a model named by the caller', async () => {
    db.aiModelFor.mockResolvedValue({ provider: 'openai', model: 'gpt-5', effort: 'high' });
    await openAiReportTransport({ ...call, model: 'claude-sonnet-4-6', maxTokens: 8000 });
    expect(openai.callOpenAi).toHaveBeenCalledWith(expect.anything(), 'sk-stored', 'gpt-5', 'high', 8000, REPORT_CALL);
  });

  it('clamps the output budget to what the model accepts', async () => {
    db.aiModelFor.mockResolvedValue({ provider: 'openai', model: 'gpt-4o', effort: null });
    await openAiReportTransport({ ...call, maxTokens: 32_000 });
    expect(openai.callOpenAi).toHaveBeenCalledWith(expect.anything(), 'sk-stored', 'gpt-4o', null, 16_000, REPORT_CALL);
  });

  it('falls back to the server\'s key when the stored one cannot be read', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-server');
    db.openAiApiKeyFromVault.mockRejectedValue(new Error('vault down'));
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await openAiReportTransport(call);
    spy.mockRestore();
    expect(openai.callOpenAi).toHaveBeenCalledWith(call, 'sk-server', 'gpt-4.1', null, REPORT_MAX_TOKENS, REPORT_CALL);
  });

  it('refuses with the key message when there is no OpenAI key, before reading the model or calling out', async () => {
    db.openAiApiKeyFromVault.mockResolvedValue(null);
    await expect(openAiReportTransport(call)).rejects.toThrow(new UpstreamError('openai', NO_OPENAI_KEY));
    await expect(openAiReportTransport(call)).rejects.toBeInstanceOf(UpstreamError);
    expect(db.aiModelFor).not.toHaveBeenCalled();
    expect(openai.callOpenAi).not.toHaveBeenCalled();
  });

  it('refuses with the model message when the OpenAI card has no model chosen', async () => {
    db.aiModelFor.mockResolvedValue(null);
    await expect(openAiReportTransport(call)).rejects.toThrow(new UpstreamError('openai', NO_OPENAI_MODEL));
    await expect(openAiReportTransport(call)).rejects.toBeInstanceOf(UpstreamError);
    expect(NO_OPENAI_MODEL).toContain('model drop-down on the OpenAI card');
    expect(openai.callOpenAi).not.toHaveBeenCalled();
  });

  it('has no key at all under MOTION_AI_OFFLINE, whatever the server holds', async () => {
    vi.stubEnv('MOTION_AI_OFFLINE', '1');
    vi.stubEnv('OPENAI_API_KEY', 'sk-server');
    await expect(openAiReportTransport(call)).rejects.toThrow(NO_OPENAI_KEY);
    expect(db.openAiApiKeyFromVault).not.toHaveBeenCalled();
  });

  it('lets OpenAI\'s own refusal through unchanged', async () => {
    const refusal = new UpstreamError('OpenAI refused the call: Incorrect API key provided');
    openai.callOpenAi.mockRejectedValue(refusal);
    await expect(openAiReportTransport(call)).rejects.toBe(refusal);
  });
});

describe('reportOutputCeiling', () => {
  it.each([
    ['gpt-5', 32_000], ['gpt-5-mini', 32_000], ['o3', 32_000], ['o4-mini', 32_000], ['gpt-4.1', 32_000], ['gpt-4.1-mini', 32_000],
    ['gpt-4o', 16_000], ['gpt-4o-mini', 16_000], ['chatgpt-4o-latest', 16_000], ['gpt-4-turbo', 4_096], ['gpt-4', 4_096], ['gpt-6', 16_000],
  ])('%s → %i', (model, ceiling) => {
    expect(reportOutputCeiling(model)).toBe(ceiling);
  });
});
