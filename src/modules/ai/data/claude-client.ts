import 'server-only';
import Anthropic from '@anthropic-ai/sdk';
import type {
  ContentBlock, MessageParam, Tool, ToolChoice, Usage,
} from '@anthropic-ai/sdk/resources/messages';
import { UpstreamError } from '@/core/errors';
import { log } from '@/core/logging';
import { anthropicApiKeyFromVault } from '@/core/db';

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

/**
 * §11: the default model; overridable by configuration (`ANTHROPIC_MODEL`), never by the browser.
 * 2026-10-07: claude-sonnet-4-5 is no longer offered to the owner's key. The owner chose Claude
 * Haiku 4.5 as the default (faster, cheaper). claude-sonnet-4-6 had the fewest grounding (§7)
 * rejections in trials and claude-sonnet-5-5 also works; either is one setting away.
 */
export const DEFAULT_ANALYST_MODEL = process.env.ANTHROPIC_MODEL?.trim() || 'claude-haiku-4-5-20251001';

/**
 * §11: `max_tokens = 8000` for answers (1500, then 4000, until 2026-10-07: the current model's
 * structured answers to broad questions ran past both and arrived cut off, failing validation). `temperature = 0` was dropped on 2026-10-07: current models
 * refuse the parameter ("`temperature` is deprecated for this model"). The answer's shape is still
 * forced (the submit tool) and every figure in it is grounded against the tool results (§5).
 */
export const ANALYST_MAX_TOKENS = 8000;

/** §2: the model call uses a 90 s timeout (30 s until 2026-10-07) with one retry on transient errors. */
const MODEL_TIMEOUT_MS = 90_000;

/** Bumped whenever the system prompt, the tool schemas or the model changes (§11, §12). */
export const PROMPT_VERSION = 'analyst-v3.8';

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

let cached: { readonly key: string; readonly client: Anthropic } | null = null;
let keyRead: { readonly key: string | null; readonly at: number } | null = null;
/** How long a key read from the Vault is reused before it is read again (a changed key takes effect within it). */
const KEY_TTL_MS = 60_000;

/**
 * The key the model is called with (ADR-157): the one the app's owner stored in Platform → Settings
 * (encrypted in Vault), else the deployment's ANTHROPIC_API_KEY. Read at most once a minute.
 */
async function currentKey(): Promise<string | null> {
  // The automated test server runs with no model at all, whatever key this machine holds (ADR-157).
  if (process.env.MOTION_AI_OFFLINE === '1') return null;
  if (keyRead && Date.now() - keyRead.at < KEY_TTL_MS) return keyRead.key ?? process.env.ANTHROPIC_API_KEY ?? null;
  let stored: string | null = null;
  try {
    stored = await anthropicApiKeyFromVault();
  } catch (error) {
    // The Vault being unreachable must not take the analyst down when the server has its own key.
    log.warn('the stored AI key could not be read; using the server setting', { service: 'ai.claude-client', error: String(error) });
  }
  keyRead = { key: stored, at: Date.now() };
  return stored ?? process.env.ANTHROPIC_API_KEY ?? null;
}

/** Called after the owner changes the key, so this server uses the new one at once. */
export function forgetAiKey(): void {
  keyRead = null;
  cached = null;
}

async function client(): Promise<Anthropic> {
  const apiKey = await currentKey();
  if (!apiKey) {
    // Fail closed and loudly: an unconfigured key must never look like a model that said nothing.
    throw new UpstreamError('The analyst is not configured on this deployment.');
  }
  if (cached && cached.key === apiKey) return cached.client;
  cached = { key: apiKey, client: new Anthropic({ apiKey, timeout: MODEL_TIMEOUT_MS, maxRetries: 0 }) };
  return cached.client;
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
    const response = await (await client()).messages.create({
      model: call.model ?? DEFAULT_ANALYST_MODEL,
      max_tokens: call.maxTokens ?? ANALYST_MAX_TOKENS,
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
