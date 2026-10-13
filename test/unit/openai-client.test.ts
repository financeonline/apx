import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const { callOpenAi, fromOpenAiResponse, isOpenAiChatModel, isOpenAiReasoningModel, toOpenAiRequest } = await import('@/modules/ai/data/openai-client');

/**
 * ADR-164: an Anthropic-shaped call becomes an OpenAI Chat Completions request, and the reply comes
 * back as the content blocks the loop reads — so the submit tool and the grounding are unchanged.
 */

const tool = { name: 'submit_answer', description: 'Submit.', input_schema: { type: 'object', properties: { a: { type: 'string' } } } };

describe('the request', () => {
  it('joins the system parts, maps the tools, and forces the named tool', () => {
    const req = toOpenAiRequest({
      system: [{ text: 'Rules.', cached: true }, { text: 'Data.', cached: false }],
      messages: [{ role: 'user', content: 'How was May?' }],
      tools: [tool as never], toolChoice: { type: 'tool', name: 'submit_answer' },
    }, 'gpt-4.1', null, 8000);
    expect(req.messages).toEqual([{ role: 'system', content: 'Rules.\n\nData.' }, { role: 'user', content: 'How was May?' }]);
    expect(req.tools).toEqual([{ type: 'function', function: { name: 'submit_answer', description: 'Submit.', parameters: tool.input_schema } }]);
    expect(req.tool_choice).toEqual({ type: 'function', function: { name: 'submit_answer' } });
    expect(req.max_completion_tokens).toBe(8000);
    expect(req).not.toHaveProperty('reasoning_effort');
  });

  it('carries a tool call and its result as an assistant tool call and a tool message', () => {
    const req = toOpenAiRequest({
      system: [], tools: [tool as never], toolChoice: { type: 'auto' },
      messages: [
        { role: 'user', content: 'Q' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'get_metric', input: { metric_key: 'revenue' } }] as never },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '{"seq":1}', is_error: false }] as never },
      ],
    }, 'gpt-4.1', null, 100);
    const messages = req.messages as Array<Record<string, unknown>>;
    expect(messages[1]).toEqual({ role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_metric', arguments: '{"metric_key":"revenue"}' } }] });
    expect(messages[2]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: '{"seq":1}' });
    expect(req.tool_choice).toBe('auto');
  });

  it('marks a failed tool result, and sends images and PDFs as data URLs', () => {
    const req = toOpenAiRequest({
      system: [], tools: [], toolChoice: { type: 'auto' },
      messages: [
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c', content: [{ type: 'text', text: 'NO_DATA' }], is_error: true }] as never },
        { role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } },
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'BBB' } },
          { type: 'text', text: 'Read it.' },
        ] as never },
      ],
    }, 'gpt-4.1', null, 100);
    const messages = req.messages as Array<{ role: string; content: unknown }>;
    expect(messages[0]).toEqual({ role: 'tool', tool_call_id: 'c', content: 'ERROR: NO_DATA' });
    expect(messages[1]!.content).toEqual([
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
      { type: 'file', file: { filename: 'document.pdf', file_data: 'data:application/pdf;base64,BBB' } },
      { type: 'text', text: 'Read it.' },
    ]);
    expect(req).not.toHaveProperty('tools');
  });

  it('sends effort only to a reasoning model', () => {
    const call = { system: [], messages: [{ role: 'user' as const, content: 'Q' }], tools: [], toolChoice: { type: 'auto' as const } };
    expect(toOpenAiRequest(call, 'o4-mini', 'high', 10).reasoning_effort).toBe('high');
    expect(toOpenAiRequest(call, 'gpt-5', 'low', 10).reasoning_effort).toBe('low');
    expect(toOpenAiRequest(call, 'gpt-4.1', 'high', 10)).not.toHaveProperty('reasoning_effort');
  });
});

describe('the reply', () => {
  it('becomes text and tool_use blocks with the stop reason the loop knows', () => {
    const res = fromOpenAiResponse({
      model: 'gpt-4.1-2025-04-14',
      choices: [{ finish_reason: 'tool_calls', message: { content: 'thinking', tool_calls: [{ id: 'call_9', function: { name: 'submit_answer', arguments: '{"mode":"answer"}' } }] } }],
      usage: { prompt_tokens: 120, completion_tokens: 30 },
    }, 'gpt-4.1');
    expect(res.content).toEqual([
      { type: 'text', text: 'thinking', citations: null },
      { type: 'tool_use', id: 'call_9', name: 'submit_answer', input: { mode: 'answer' } },
    ]);
    expect(res.stopReason).toBe('tool_use');
    expect(res.usage).toEqual({ inputTokens: 120, outputTokens: 30 });
    expect(res.model).toBe('gpt-4.1-2025-04-14');
  });

  it('turns arguments that are not JSON into an empty input, for the contract to refuse', () => {
    const res = fromOpenAiResponse({ choices: [{ finish_reason: 'length', message: { tool_calls: [{ id: 'x', function: { name: 'submit_answer', arguments: '{"mode":' } }] } }] }, 'gpt-4.1');
    expect(res.content).toEqual([{ type: 'tool_use', id: 'x', name: 'submit_answer', input: {} }]);
    expect(res.stopReason).toBe('max_tokens');
    expect(res.model).toBe('gpt-4.1');
  });
});

describe('which models are offered', () => {
  it('offers chat models that call tools, not audio, image, embedding or legacy ones', () => {
    for (const m of ['gpt-4.1', 'gpt-4o', 'gpt-5', 'gpt-5-mini', 'o3', 'o4-mini']) expect(isOpenAiChatModel(m)).toBe(true);
    for (const m of ['text-embedding-3-large', 'whisper-1', 'dall-e-3', 'gpt-4o-audio-preview', 'gpt-4o-realtime-preview', 'gpt-image-1', 'gpt-3.5-turbo', 'gpt-4o-mini-tts', 'omni-moderation-latest'])
      expect(isOpenAiChatModel(m)).toBe(false);
    expect(isOpenAiReasoningModel('o3')).toBe(true);
    expect(isOpenAiReasoningModel('gpt-4.1')).toBe(false);
  });
});

describe('running out of time (ADR-170)', () => {
  const call = { system: [{ text: 'Rules.', cached: false }], messages: [{ role: 'user' as const, content: 'Hi.' }], tools: [], toolChoice: { type: 'auto' as const } };
  /** A fetch that never answers until its signal gives up, as a request that runs out of time does. */
  const hangingFetch = () => vi.fn((_url: string, init: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason));
  }));

  it('sends a request that ran out of time once more by default, as before', async () => {
    const fetch = hangingFetch();
    vi.stubGlobal('fetch', fetch);
    await expect(callOpenAi(call, 'sk-test', 'gpt-4.1', null, 100, { timeoutMs: 10 })).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it('never sends a report request twice after it ran out of time', async () => {
    const fetch = hangingFetch();
    vi.stubGlobal('fetch', fetch);
    await expect(callOpenAi(call, 'sk-test', 'gpt-4.1', null, 100, { timeoutMs: 10, retryOnTimeout: false })).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});
