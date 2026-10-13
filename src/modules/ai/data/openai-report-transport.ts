import 'server-only';
import { UpstreamError } from '@/core/errors';
import { log } from '@/core/logging';
import { aiModelFor, openAiApiKeyFromVault } from '@/core/db/server-rpc';
import type { ModelTransport } from './claude-client';
import { callOpenAi, isOpenAiReasoningModel } from './openai-client';

/**
 * The transport for the written reports — Marketing now, Investment later (ADR-170).
 *
 * Owner, 2026-10-13: these reports are written by ChatGPT through the OpenAI key, WHICHEVER provider
 * is active for the rest of the app. So this transport never consults the active provider
 * (`api_server.ai_model`, ADR-165): it always calls OpenAI, with the stored OpenAI key and the model
 * and effort chosen on the OpenAI card (`api_server.ai_model_for('openai')`). The analyst, the
 * statement and receipt readers and the evaluation keep `liveTransport` and the active provider.
 *
 * It goes through `callOpenAi` (ADR-164) — the one place that speaks OpenAI's wire format, with its
 * translation of the forced tool, its one retry on a transient failure and its error wording — so
 * nothing about the request differs from the analyst's OpenAI calls except the model it names and the
 * output ceiling below.
 *
 * Fail closed and loudly, in words the super admin can act on: no key, or no model chosen on the
 * OpenAI card, is an `UpstreamError` naming the fix, never an empty report. Under `MOTION_AI_OFFLINE`
 * there is no key at all, exactly as for the analyst (ADR-157); the generator does not reach this
 * transport offline (it writes the report from the industry template instead).
 *
 * `call.model` is ignored: the report's model is the OpenAI card's, not a caller's.
 *
 * Nothing is cached between calls: a report is written rarely, in a background job, and reading the
 * key and the model fresh means a change on the Account page applies to the very next report without
 * `forgetAiKey`.
 */

export const NO_OPENAI_KEY = 'The marketing report is written by ChatGPT and needs an OpenAI key. The super admin adds it on the Account page.';
export const NO_OPENAI_MODEL = 'The marketing report is written by ChatGPT and needs an OpenAI model. The super admin chooses one in the model drop-down on the OpenAI card on the Account page.';

/** What a report asks for when the caller names no limit: a long report, plus a reasoning model's thinking. */
/** One report request's time limit (ADR-170). */
export const REPORT_TIMEOUT_MS = 210_000;

export const REPORT_MAX_TOKENS = 32_000;

/**
 * The most output a model will accept (`max_completion_tokens`): asking for more than a model's
 * ceiling is refused outright by OpenAI, so the report's generous budget is clamped per model. The
 * reasoning models (GPT-5, the o-series) and GPT-4.1 take at least 32k; GPT-4o and its relatives 16k;
 * the legacy GPT-4 models 4k (too little for a whole report — it fails as cut off, and says so).
 */
export function reportOutputCeiling(model: string): number {
  if (isOpenAiReasoningModel(model) || /^gpt-4\.1/.test(model)) return 32_000;
  if (/^(gpt-4o|chatgpt-4o)/.test(model)) return 16_000;
  if (/^gpt-4(-|$)/.test(model)) return 4_096;
  return 16_000;
}

/** The stored OpenAI key, else the deployment's OPENAI_API_KEY; none at all under MOTION_AI_OFFLINE. */
async function openAiKey(): Promise<string | null> {
  if (process.env.MOTION_AI_OFFLINE === '1') return null;
  let stored: string | null = null;
  try {
    stored = await openAiApiKeyFromVault();
  } catch (error) {
    // The Vault being unreachable must not stop a report when the server has its own key.
    log.warn('the stored OpenAI key could not be read; using the server setting', { service: 'ai.openai-report-transport', error: String(error) });
  }
  return stored ?? process.env.OPENAI_API_KEY ?? null;
}

export const openAiReportTransport: ModelTransport = async (call) => {
  const key = await openAiKey();
  if (!key) throw new UpstreamError('openai', NO_OPENAI_KEY);
  const choice = await aiModelFor('openai');
  if (!choice) throw new UpstreamError('openai', NO_OPENAI_MODEL);
  const maxTokens = Math.min(call.maxTokens ?? REPORT_MAX_TOKENS, reportOutputCeiling(choice.model));
  // A whole report can take minutes on a reasoning model: up to 3.5 minutes, inside the job's four
  // (MARKETING_TIMEOUT_MS), and never sent twice after running out of time.
  return callOpenAi(call, key, choice.model, choice.effort, maxTokens, { timeoutMs: REPORT_TIMEOUT_MS, retryOnTimeout: false });
};
