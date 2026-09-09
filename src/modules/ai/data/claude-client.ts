import 'server-only';
import Anthropic from '@anthropic-ai/sdk';
import type {
  ContentBlock, MessageParam, Tool, ToolChoice, Usage,
} from '@anthropic-ai/sdk/resources/messages';
import { UpstreamError } from '@/core/errors';
import { log } from '@/core/logging';

/**
 * The one file that imports the Anthropic SDK (AI_ARCHITECTURE.md §1.2, §11; ADR-023).
 *
 * It owns the API key, the model ids, the timeouts and the retry, and it reports token usage.
 * Nothing above it — the loop, the tools, the route — ever sees a key or the SDK; the ESLint
 * `no-restricted-imports` pattern on `@anthropic-ai/*` fails the build for any other file.
 *
 * What it deliberately does NOT do is decide anything about the answer. It returns the content
 * blocks and lets the loop discard text blocks (F-C-08) and validate the `submit_answer` input
 * (§5). A client that "helpfully" extracted the answer would be a second place the contract lived.
 *
 * Injectable for tests: `callModel` takes an optional transport so the loop, the grounding path and
 * the route are exercised end to end against recorded responses with no network and no key.
 */

/** §11: a Sonnet-class default; overridable by configuration, never by the browser. */
export const DEFAULT_ANALYST_MODEL = 'claude-sonnet-4-5';

/** §11: `temperature = 0`, `max_tokens = 1500` for answers. */
export const ANALYST_MAX_TOKENS = 1500;

/** §2: the model call uses a 30 s timeout with one retry on transient errors. */
const MODEL_TIMEOUT_MS = 30_000;

/** Bumped whenever the system prompt, the tool schemas or the model changes (§11, §12). */
export const PROMPT_VERSION = 'analyst-v3.0';

export interface ModelCall {
  readonly system: readonly { readonly text: string; readonly cached: boolean }[];
  readonly messages: readonly MessageParam[];
  readonly tools: readonly Tool[];
  readonly toolChoice: ToolChoice;
  readonly model?: string;
  readonly maxTokens?: number;
  readonly signal?: AbortSignal;
}

export interface ModelResponse {
  readonly content: readonly ContentBlock[];
  readonly stopReason: string | null;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  readonly model: string;
}

/** The seam a test replaces: one function, one response. */
export type ModelTransport = (call: ModelCall) => Promise<ModelResponse>;

let cached: Anthropic | null = null;

function client(): Anthropic {
  if (cached) return cached;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // Fail closed and loudly: an unconfigured key must never look like a model that said nothing.
    throw new UpstreamError('The analyst is not configured on this deployment.');
  }
  cached = new Anthropic({ apiKey, timeout: MODEL_TIMEOUT_MS, maxRetries: 0 });
  return cached;
}

function usageOf(usage: Usage): ModelResponse['usage'] {
  return {
    // Cached reads are still tokens the organisation is billed for under its ceiling (§11).
    inputTokens: usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
    outputTokens: usage.output_tokens,
  };
}

function isTransient(error: unknown): boolean {
  if (error instanceof Anthropic.APIError) {
    return error.status === undefined || error.status === 429 || error.status >= 500;
  }
  return error instanceof Anthropic.APIConnectionError || error instanceof Anthropic.APIConnectionTimeoutError;
}

/** The real transport: prompt caching on the stable prefix (§9, §11), one retry on a transient error. */
export const liveTransport: ModelTransport = async (call) => {
  const attempt = async (): Promise<ModelResponse> => {
    const response = await client().messages.create({
      model: call.model ?? DEFAULT_ANALYST_MODEL,
      max_tokens: call.maxTokens ?? ANALYST_MAX_TOKENS,
      temperature: 0,
      system: call.system.map((part) => ({
        type: 'text' as const,
        text: part.text,
        ...(part.cached ? { cache_control: { type: 'ephemeral' as const } } : {}),
      })),
      tools: [...call.tools],
      tool_choice: call.toolChoice,
      messages: [...call.messages],
    }, { signal: call.signal });
    return {
      content: response.content,
      stopReason: response.stop_reason,
      usage: usageOf(response.usage),
      model: response.model,
    };
  };

  try {
    return await attempt();
  } catch (first) {
    if (!isTransient(first) || call.signal?.aborted) throw first;
    log.warn('model call failed transiently; retrying once', {
      service: 'ai.claude-client',
      error: first instanceof Error ? first.message : String(first),
    });
    return attempt();
  }
};

/**
 * Calls the model. Errors are normalised to `UpstreamError` so the loop's "retry once, then
 * `failed`" rule (§7.8) has one thing to catch; the original is logged, never shown.
 */
export async function callModel(
  call: ModelCall,
  transport: ModelTransport = liveTransport,
): Promise<ModelResponse> {
  try {
    return await transport(call);
  } catch (cause) {
    if (cause instanceof UpstreamError) throw cause;
    log.error('the model could not be called', {
      service: 'ai.claude-client',
      error: cause instanceof Error ? cause.message : String(cause),
    });
    throw new UpstreamError('The analyst is unavailable right now.');
  }
}
