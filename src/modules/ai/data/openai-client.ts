import 'server-only';
import { UpstreamError } from '@/core/errors';
import { log } from '@/core/logging';
import type { ModelCall, ModelResponse } from './claude-client';

/**
 * OpenAI as a second provider (ADR-164), behind the same transport seam as Anthropic.
 *
 * MOTION's AI layer speaks Anthropic's message shape: system parts, messages of text / image /
 * document / tool_use / tool_result blocks, tools with an `input_schema`, and a tool choice. This file
 * translates one such call into OpenAI's Chat Completions request and the reply back into the same
 * content blocks, so the loop, the tools and the grounding (§5, §7) are untouched — the answer must
 * still arrive through the submit tool and every figure in it is still checked.
 *
 * No SDK: one `fetch`. The key never leaves the server, and nothing here decides anything about the
 * answer.
 */

type Block = ModelResponse['content'][number];
type MessageParam = ModelCall['messages'][number];

/** The reasoning levels OpenAI accepts (`reasoning_effort`), offered only on its reasoning models. */
export const OPENAI_EFFORTS = ['low', 'medium', 'high'] as const;

/** Reasoning models take `reasoning_effort`: the o-series and GPT-5. */
export function isOpenAiReasoningModel(model: string): boolean {
  return /^(o\d|gpt-5)/.test(model);
}

/**
 * The models worth offering: the chat models that call tools. Embeddings, audio, image, moderation,
 * realtime, search and legacy completion models are left out.
 */
export function isOpenAiChatModel(model: string): boolean {
  if (!/^(gpt-|o\d|chatgpt-)/.test(model)) return false;
  return !/(audio|realtime|transcribe|tts|image|search|embedding|moderation|instruct|codex|computer-use|-mini-tts|dall-e|whisper|davinci|babbage|gpt-3\.5)/.test(model);
}

interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | Array<Record<string, unknown>> | null;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c) => (c && typeof c === 'object' && (c as { type?: string }).type === 'text' ? String((c as { text?: unknown }).text ?? '') : '')).join('');
  }
  return '';
}

function userPart(block: Record<string, unknown>): Record<string, unknown> | null {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: String(block.text ?? '') };
    case 'image': {
      const source = block.source as { media_type?: string; data?: string };
      return { type: 'image_url', image_url: { url: `data:${source.media_type};base64,${source.data}` } };
    }
    case 'document': {
      const source = block.source as { media_type?: string; data?: string };
      return { type: 'file', file: { filename: 'document.pdf', file_data: `data:${source.media_type ?? 'application/pdf'};base64,${source.data}` } };
    }
    default:
      return null;
  }
}

/** One Anthropic-shaped message → one or more OpenAI messages (tool results become `tool` messages). */
function toOpenAiMessages(message: MessageParam): OpenAiMessage[] {
  if (typeof message.content === 'string') return [{ role: message.role, content: message.content }];
  const blocks = message.content as unknown as Array<Record<string, unknown>>;

  if (message.role === 'assistant') {
    const text = blocks.filter((b) => b.type === 'text').map((b) => String(b.text ?? '')).join('');
    const calls = blocks.filter((b) => b.type === 'tool_use').map((b) => ({
      id: String(b.id), type: 'function' as const,
      function: { name: String(b.name), arguments: JSON.stringify(b.input ?? {}) },
    }));
    return [{ role: 'assistant', content: text || null, ...(calls.length > 0 ? { tool_calls: calls } : {}) }];
  }

  const out: OpenAiMessage[] = [];
  for (const b of blocks.filter((x) => x.type === 'tool_result')) {
    const body = textOf(b.content);
    out.push({ role: 'tool', tool_call_id: String(b.tool_use_id), content: b.is_error ? `ERROR: ${body}` : body });
  }
  const parts = blocks.filter((x) => x.type !== 'tool_result').map(userPart).filter((p): p is Record<string, unknown> => p !== null);
  if (parts.length > 0) out.push({ role: 'user', content: parts });
  return out;
}

/** The Chat Completions request for one call. */
export function toOpenAiRequest(call: ModelCall, model: string, effort: string | null, maxTokens: number): Record<string, unknown> {
  const system = call.system.map((p) => p.text).join('\n\n');
  const choice = call.toolChoice as { type: string; name?: string };
  const toolChoice = choice.type === 'tool'
    ? { type: 'function', function: { name: choice.name } }
    : choice.type === 'any' ? 'required' : choice.type === 'none' ? 'none' : 'auto';
  return {
    model,
    max_completion_tokens: maxTokens,
    messages: [
      ...(system ? [{ role: 'system', content: system }] : []),
      ...call.messages.flatMap(toOpenAiMessages),
    ],
    ...(call.tools.length > 0 ? {
      tools: call.tools.map((t) => {
        const tool = t as unknown as { name: string; description?: string; input_schema: unknown };
        return { type: 'function', function: { name: tool.name, description: tool.description ?? '', parameters: tool.input_schema } };
      }),
      tool_choice: toolChoice,
    } : {}),
    ...(effort && isOpenAiReasoningModel(model) ? { reasoning_effort: effort } : {}),
  };
}

interface OpenAiReply {
  model?: string;
  choices?: Array<{
    finish_reason?: string | null;
    message?: { content?: string | null; tool_calls?: Array<{ id: string; function?: { name?: string; arguments?: string } }> };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

const STOP_REASONS: Record<string, string> = { tool_calls: 'tool_use', stop: 'end_turn', length: 'max_tokens', content_filter: 'refusal' };

/** The reply as the content blocks the loop reads. Arguments that are not JSON become `{}` — the contract then refuses them. */
export function fromOpenAiResponse(reply: OpenAiReply, fallbackModel: string): ModelResponse {
  const choice = reply.choices?.[0];
  const content: Block[] = [];
  const text = choice?.message?.content;
  if (text) content.push({ type: 'text', text, citations: null } as unknown as Block);
  for (const call of choice?.message?.tool_calls ?? []) {
    let input: unknown = {};
    try {
      input = JSON.parse(call.function?.arguments ?? '{}');
    } catch {
      input = {};
    }
    content.push({ type: 'tool_use', id: call.id, name: call.function?.name ?? '', input } as unknown as Block);
  }
  const finish = choice?.finish_reason ?? null;
  return {
    content,
    stopReason: finish ? (STOP_REASONS[finish] ?? finish) : null,
    usage: { inputTokens: reply.usage?.prompt_tokens ?? 0, outputTokens: reply.usage?.completion_tokens ?? 0 },
    model: reply.model ?? fallbackModel,
  };
}

const TIMEOUT_MS = 90_000;

/** One call to OpenAI, one retry on a transient error (429, 5xx, network), as for Anthropic. */
export async function callOpenAi(
  call: ModelCall, key: string, model: string, effort: string | null, maxTokens: number,
): Promise<ModelResponse> {
  const body = JSON.stringify(toOpenAiRequest(call, model, effort, maxTokens));
  const attempt = async (): Promise<{ transient: boolean; response?: ModelResponse; error?: string }> => {
    const signals = [AbortSignal.timeout(TIMEOUT_MS), ...(call.signal ? [call.signal] : [])];
    let res: Response;
    try {
      res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body,
        signal: AbortSignal.any(signals),
      });
    } catch (error) {
      return { transient: !call.signal?.aborted, error: error instanceof Error ? error.message : String(error) };
    }
    if (!res.ok) {
      const detail = ((await res.json().catch(() => null)) as { error?: { message?: string } } | null)?.error?.message ?? `HTTP ${res.status}`;
      return { transient: res.status === 429 || res.status >= 500, error: detail };
    }
    return { transient: false, response: fromOpenAiResponse((await res.json()) as OpenAiReply, model) };
  };

  let result = await attempt();
  if (!result.response && result.transient && !call.signal?.aborted) {
    log.warn('OpenAI call failed transiently; retrying once', { service: 'ai.openai-client', error: result.error });
    result = await attempt();
  }
  if (!result.response) throw new UpstreamError(`OpenAI refused the call: ${result.error ?? 'unknown error'}`);
  return result.response;
}
