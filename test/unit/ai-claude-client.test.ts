import { describe, expect, it, vi } from 'vitest';
import { UpstreamError } from '@/core/errors';
import { callModel, type ModelCall, type ModelResponse } from '@/modules/ai';

/**
 * The Claude client's one job beyond calling the model is normalising failure so the loop has ONE
 * thing to catch (AI_ARCHITECTURE.md §2, §7.8; ADR-023).
 */

const call: ModelCall = {
  system: [{ text: 'sys', cached: true }],
  messages: [{ role: 'user', content: 'q' }],
  tools: [],
  toolChoice: { type: 'auto' },
};

const response: ModelResponse = {
  content: [], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, model: 'm',
};

describe('callModel', () => {
  it('returns the transport’s response untouched', async () => {
    const transport = vi.fn(async () => response);
    expect(await callModel(call, transport)).toBe(response);
    expect(transport).toHaveBeenCalledWith(call);
  });

  it('normalises any transport failure to UpstreamError and never leaks the cause', async () => {
    const transport = vi.fn(async () => { throw new Error('ECONNRESET secret-host:443'); });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(callModel(call, transport)).rejects.toBeInstanceOf(UpstreamError);
    // The cause — host, port, whatever the transport said — is logged and never surfaces.
    await expect(callModel(call, transport)).rejects.not.toThrow(/secret-host/);
    spy.mockRestore();
  });

  it('passes an UpstreamError through as-is', async () => {
    const own = new UpstreamError('The analyst is not configured on this deployment.');
    const transport = vi.fn(async () => { throw own; });
    await expect(callModel(call, transport)).rejects.toBe(own);
  });
});
