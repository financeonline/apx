import 'server-only';
import type { ContentBlockParam, MessageParam, ToolUseBlock } from '@anthropic-ai/sdk/resources/messages';
import { persistAssistantTurn, persistUserTurn, type PersistedBundleItem, type PersistedToolCall } from '@/core/db';
import { QuotaExceeded, UpstreamError, toMotionError } from '@/core/errors';
import { log } from '@/core/logging';
import { assertCan } from '@/core/permissions';
import { loadPeriods, loadPeriodsWithData } from '@/modules/dashboard';
import type { AccessContext } from '@/modules/tenancy';
import { callModel, PROMPT_VERSION, type ModelResponse, type ModelTransport } from '../data/claude-client';
import type { ToolResult } from '../domain/allowed-set';
import { SubmitAnswerSchema, type EvidenceRef, type SubmitAnswer } from '../domain/contract';
import { ground, modeAdmissible, unsupportedTopicsClean, type GroundingContext, type GroundingStatus, type Mismatch } from '../domain/grounding';
import { resolvePeriodContext, type PeriodContext, type PeriodRow as PeriodRowInput } from '../domain/periods';
import { replayHistory, SUBMIT_ANSWER_TOOL, submitAnswerTool, systemPrompt, toSdkTool } from '../domain/prompt';
import { MAX_TOOL_CALLS, REGENERATION_EXTRA_CALLS, TOOLS } from '../domain/tools/registry';
import { applyKinds, buildGroundingContext, degrade } from '../domain/turn-context';
import { untrusted, userQuestion } from '../domain/untrusted';
import { findConversation, loadHistory } from './conversations';
import { ContextChanged, runTool, snapshotAccess } from './run-tool';

/**
 * The analyst turn (AI_ARCHITECTURE.md §2, steps 1–12; §7.8; §14).
 *
 * The shape of this file is the shape of §2's numbered list, deliberately: anyone auditing the
 * analyst should be able to read the flow top to bottom against the document. The pieces it
 * composes are each tested on their own — the client, the tools, the runner, the context builder,
 * degradation, the prompt, persistence — so what this file adds is ORDER, and order is what the
 * security properties rest on: the user turn is charged before the model is called; access is
 * re-resolved before every tool; text blocks are discarded before anything is validated; grounding
 * runs before a bundle exists; the bundle is built from derived refs before anything is persisted.
 *
 * Streaming (§2 step 13): `onStatus` receives tool-name status events during the loop; the ONE
 * `answer` event is what the caller emits after this returns. Nothing the model wrote outside
 * `submit_answer` reaches the caller (F-C-08).
 */

export interface AnswerInput {
  readonly ctx: AccessContext;
  readonly conversationId: string;
  readonly message: string;
  /** Re-resolves the caller's access, uncached (§4). */
  readonly resolveAccess: () => Promise<AccessContext>;
  readonly onStatus?: (event: { readonly tool: string; readonly label: string }) => void;
  /** Injectable for tests and evals; production passes nothing and gets the live transport. */
  readonly transport?: ModelTransport;
  readonly now?: Date;
}

export interface AnswerOutput {
  readonly messageId: string;
  readonly evidenceBundleId: string | null;
  readonly groundingStatus: GroundingStatus;
  /** The validated, kind-corrected, possibly degraded answer — or null when `failed`. */
  readonly answer: SubmitAnswer | null;
  readonly periodContext: PeriodContext;
  readonly toolCalls: number;
}

/** §10: the fallback the user sees when the analyst cannot answer. */
export const FALLBACK_MESSAGE = 'The analyst is unavailable right now. Your data and dashboard are unaffected.';

/** §2: the whole turn's budget. */
const TURN_BUDGET_MS = 45_000;

const STATUS_LABELS: Readonly<Record<string, string>> = {
  get_business_summary: 'looking at the overall picture',
  get_metric: 'looking up a figure',
  get_metric_trend: 'following a figure over time',
  get_expense_changes: 'comparing spending',
  get_customer_profitability: 'looking at customers',
  get_cash_analysis: 'looking at cash',
  get_receivables: 'checking what is owed to you',
  get_payables: 'checking what you owe',
  get_alerts: 'reading the alerts',
  get_health_score: 'reading the health score',
  get_evidence: 'opening the evidence',
  get_source_document_reference: 'finding the source file',
  get_transactions_for_evidence: 'reading the transactions',
  get_data_coverage: 'checking what data there is',
  get_actions: 'checking open actions',
};

interface TurnState {
  results: ToolResult[];
  persisted: PersistedToolCall[];
  messages: MessageParam[];
  inputTokens: number;
  outputTokens: number;
  model: string | null;
}

export async function answer(input: AnswerInput): Promise<AnswerOutput> {
  const { ctx } = input;
  const startedAt = Date.now();
  const actor = { userId: ctx.userId, requestId: ctx.requestId };
  const orgId = ctx.orgId!;

  // 1. Session and permission.
  assertCan(ctx, 'ai.use');

  // 3. The conversation is the caller's, in this organisation, or it does not exist (F-C-11).
  await findConversation(ctx, input.conversationId);

  // 2 & 4. Quota, throttle, and the user turn — charged BEFORE any model call. QuotaExceeded is
  // thrown straight through: the route answers 429 with the reset time.
  await persistUserTurn(actor, { organizationId: orgId, conversationId: input.conversationId, message: input.message });

  // 5. Period resolution, before the model sees anything (§8).
  const [periods, withData, organisation, history] = await Promise.all([
    loadPeriods(ctx.db, orgId, ctx.requestId),
    loadPeriodsWithData(ctx.db, orgId, ctx.requestId),
    organisationOf(ctx, orgId),
    loadHistory(ctx, input.conversationId),
  ]);
  const periodContext = resolvePeriodContext({
    question: input.message,
    periods: periods.map((p): PeriodRowInput => ({
      id: p.id, label: p.label, periodStart: p.periodStart, isComplete: p.isComplete, hasData: withData.has(p.id),
    })),
    fiscalYearStartMonth: organisation.fiscalYearStartMonth,
  });

  // 6. The prompt. The tenant section sits after the cache breakpoint (§9).
  const prompt = systemPrompt({ organisationName: organisation.name, baseCurrency: organisation.baseCurrency, periodContext });
  const tools = [...TOOLS.map(toSdkTool), submitAnswerTool()];
  const state: TurnState = {
    results: [], persisted: [],
    // History excludes the turn just persisted; the question is appended once, wrapped.
    messages: [...replayHistory(history.slice(0, -1)), { role: 'user', content: userQuestion(input.message) }],
    inputTokens: 0, outputTokens: 0, model: null,
  };
  const started = snapshotAccess(ctx);
  const deadline = () => Date.now() - startedAt > TURN_BUDGET_MS;

  const finish = async (
    status: GroundingStatus,
    validated: SubmitAnswer | null,
    report: unknown,
    bundle: { calculation_run_id: string | null; items: PersistedBundleItem[] } | null,
    contextChanged = false,
  ): Promise<AnswerOutput> => {
    const persisted = await persistAssistantTurn(actor, {
      organizationId: orgId, conversationId: input.conversationId,
      assistant: {
        structured_response: validated, grounding_status: status, grounding_report: report,
        period_context: periodContext, prompt_version: PROMPT_VERSION, model: state.model,
        input_tokens: state.inputTokens, output_tokens: state.outputTokens,
        latency_ms: Date.now() - startedAt, title: titleOf(input.message), context_changed: contextChanged,
      },
      toolCalls: state.persisted,
      bundle,
    });
    return {
      messageId: persisted.messageId, evidenceBundleId: persisted.evidenceBundleId,
      groundingStatus: status, answer: validated, periodContext, toolCalls: state.persisted.length,
    };
  };

  const fail = (reason: string, detail?: unknown) =>
    finish('failed', null, { reason, detail: detail ?? null, tool_calls: state.persisted.length }, null);

  try {
    // 7 & 8. The tool loop, then the forced final call.
    const first = await runLoop(input, state, prompt, tools, periodContext, started, deadline, MAX_TOOL_CALLS);
    if (first.kind === 'context_changed') return finish('failed', null, { reason: 'context_changed' }, null, true);
    if (first.kind === 'budget') return fail('budget_exhausted');
    if (first.kind === 'model_error') return fail('model_error', first.detail);

    let candidate = validate(first.submission);
    let context = buildGroundingContext({ periodContext, results: state.results });
    let verdict: Verdict = candidate.ok ? judge(candidate.answer, context) : candidate;

    // 9. One regeneration with the reasons, then degrade or fail (§7.8).
    if (!verdict.ok) {
      state.messages.push({ role: 'user', content: regenerationMessage(verdict.reasons) });
      const second = await runLoop(input, state, prompt, tools, periodContext, started, deadline, REGENERATION_EXTRA_CALLS);
      if (second.kind === 'context_changed') return finish('failed', null, { reason: 'context_changed' }, null, true);
      if (second.kind === 'budget') return fail('budget_exhausted');
      if (second.kind === 'model_error') return fail('model_error', second.detail);
      candidate = validate(second.submission);
      context = buildGroundingContext({ periodContext, results: state.results });
      if (!candidate.ok) return fail('invalid_after_retry', candidate.reasons);
      verdict = judge(candidate.answer, context);
      if (!verdict.ok && verdict.kind !== 'grounding') return fail(`inadmissible_after_retry`, verdict.reasons);
    }
    if (!candidate.ok) return fail('invalid', candidate.reasons);

    const answerIn = candidate.answer;
    // Modes other than `answer` carry no figures to ground: not_applicable (§7.7).
    if (answerIn.mode !== 'answer') {
      const kept = applyKinds(answerIn, {});
      return finish('not_applicable', kept, { mode: answerIn.mode }, null);
    }

    const result = ground(answerIn, context);
    let finalAnswer = applyKinds(answerIn, result.kinds);
    let status: GroundingStatus = result.status;
    let removed: readonly Mismatch[] = [];
    if (result.status !== 'passed') {
      const degraded = degrade(finalAnswer, result, context);
      finalAnswer = degraded.answer;
      removed = degraded.removed;
      status = 'degraded';
    }

    // 10. The bundle, from derived refs first (§7.6, ADR-045.5), surviving statements only.
    const bundle = bundleFor(finalAnswer, result.derivedRefs, context, state.results);
    return finish(status, finalAnswer, { mismatches: removed, kinds: result.kinds }, bundle);
  } catch (cause) {
    if (cause instanceof QuotaExceeded) throw cause;
    if (cause instanceof ContextChanged) return finish('failed', null, { reason: 'context_changed' }, null, true);
    const error = toMotionError(cause, ctx.requestId);
    log.error('the analyst turn failed', { requestId: ctx.requestId, organizationId: orgId, errorCode: error.code, error: error.message });
    return fail(error instanceof UpstreamError ? 'upstream' : 'internal', error.code);
  }
}

// -----------------------------------------------------------------------------------------------
// The loop (§2 step 7–8)
// -----------------------------------------------------------------------------------------------

type LoopOutcome =
  | { kind: 'submitted'; submission: unknown }
  | { kind: 'context_changed' }
  | { kind: 'budget' }
  | { kind: 'model_error'; detail: string };

async function runLoop(
  input: AnswerInput, state: TurnState,
  prompt: ReturnType<typeof systemPrompt>, tools: ReturnType<typeof toSdkTool>[],
  periodContext: PeriodContext, started: ReturnType<typeof snapshotAccess>,
  deadline: () => boolean, callBudget: number,
): Promise<LoopOutcome> {
  let calls = 0;
  for (;;) {
    if (deadline()) return { kind: 'budget' };
    const force = calls >= callBudget;
    let response: ModelResponse;
    try {
      response = await callModel({
        system: prompt.system, messages: state.messages, tools,
        toolChoice: force ? { type: 'tool', name: SUBMIT_ANSWER_TOOL } : { type: 'auto' },
      }, input.transport);
    } catch (cause) {
      return { kind: 'model_error', detail: cause instanceof Error ? cause.message : String(cause) };
    }
    state.inputTokens += response.usage.inputTokens;
    state.outputTokens += response.usage.outputTokens;
    state.model = response.model;

    // F-C-08: text blocks are discarded here — never streamed, never stored. Only tool_use survives.
    const uses = response.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
    const submission = uses.find((u) => u.name === SUBMIT_ANSWER_TOOL);
    if (submission) return { kind: 'submitted', submission: submission.input };

    if (uses.length === 0) {
      // The model stopped without a tool or an answer: ask for the answer explicitly, once.
      if (force) return { kind: 'model_error', detail: 'no submit_answer when forced' };
      state.messages.push({ role: 'assistant', content: [{ type: 'text', text: '[no tool call]' }] });
      state.messages.push({ role: 'user', content: `Call ${SUBMIT_ANSWER_TOOL} now.` });
      calls = callBudget;
      continue;
    }

    // Replay exactly what the model asked for, then answer each with the tool's result.
    state.messages.push({ role: 'assistant', content: uses.map((u) => ({ type: 'tool_use' as const, id: u.id, name: u.name, input: u.input })) });
    const replies: ContentBlockParam[] = [];
    for (const use of uses) {
      calls += 1;
      const seq = state.results.length + 1;
      input.onStatus?.({ tool: use.name, label: STATUS_LABELS[use.name] ?? 'looking that up' });
      let ran;
      try {
        ran = await runTool({
          seq, name: use.name, rawInput: use.input,
          resolveAccess: input.resolveAccess, started,
          call: { periodContext, knownPeriods: state.results.flatMap((r) => r.meta?.periods ?? []), now: input.now ?? new Date() },
        });
      } catch (cause) {
        if (cause instanceof ContextChanged) return { kind: 'context_changed' };
        throw cause;
      }
      state.results.push(ran.result);
      state.persisted.push(ran.persisted);
      replies.push({
        type: 'tool_result', tool_use_id: use.id, is_error: !ran.result.ok,
        content: JSON.stringify(ran.result.ok
          ? { ok: true, data: ran.result.data, meta: ran.result.meta }
          : { ok: false, error: ran.result.data }),
      });
    }
    state.messages.push({ role: 'user', content: replies });
  }
}

// -----------------------------------------------------------------------------------------------
// Validation and judgement (§5, §7.7)
// -----------------------------------------------------------------------------------------------

type Candidate = { ok: true; answer: SubmitAnswer } | { ok: false; kind: 'schema'; reasons: string[] };

function validate(submission: unknown): Candidate {
  const parsed = SubmitAnswerSchema.safeParse(submission);
  if (!parsed.success) {
    return { ok: false, kind: 'schema', reasons: parsed.error.issues.slice(0, 8).map((i) => `${i.path.join('.') || 'answer'}: ${i.message}`) };
  }
  const digits = unsupportedTopicsClean(parsed.data);
  if (digits) return { ok: false, kind: 'schema', reasons: [`unsupported: ${digits}`] };
  return { ok: true, answer: parsed.data };
}

type Verdict = { ok: true } | { ok: false; kind: 'mode' | 'grounding' | 'schema'; reasons: string[] };

function judge(candidate: SubmitAnswer, context: GroundingContext): Verdict {
  const inadmissible = modeAdmissible(candidate, context);
  if (inadmissible) return { ok: false, kind: 'mode', reasons: [`mode: ${inadmissible}`] };
  if (candidate.mode !== 'answer') return { ok: true };
  const result = ground(candidate, context);
  if (result.status === 'passed') return { ok: true };
  return { ok: false, kind: 'grounding', reasons: result.mismatches.map((m) => `"${m.statement}": ${m.reason}`) };
}

function regenerationMessage(reasons: readonly string[]): string {
  return [
    'Some statements could not be verified against the tool results. Fix each one, using only the figures and ids the tools returned, then call submit_answer again:',
    ...reasons.map((r) => `- ${untrusted('reason', r)}`),
  ].join('\n');
}

// -----------------------------------------------------------------------------------------------
// The bundle (§2 step 10)
// -----------------------------------------------------------------------------------------------

function bundleFor(
  finalAnswer: SubmitAnswer,
  derivedRefs: Readonly<Record<string, readonly EvidenceRef[]>>,
  context: GroundingContext,
  results: readonly ToolResult[],
): { calculation_run_id: string | null; items: PersistedBundleItem[] } | null {
  // Derived first, then the model's surviving refs that the turn returned.
  const refs = new Map<string, EvidenceRef>();
  const add = (r: EvidenceRef) => refs.set(`${r.type}:${r.id ?? ''}:${r.revision_no ?? ''}:${r.descriptor_hash ?? ''}`, r);
  for (const list of Object.values(derivedRefs)) list.forEach(add);
  finalAnswer.evidence.forEach(add);

  const items: PersistedBundleItem[] = [];
  for (const ref of refs.values()) {
    if (ref.type === 'query') {
      if (!ref.descriptor_hash || !context.descriptorHashes.includes(ref.descriptor_hash)) continue;
      items.push({ item_type: 'query', ref_id: null, ref_revision_no: null, query_descriptor: null,
        descriptor_hash: ref.descriptor_hash, label: 'Records selected by the calculation', claim: null,
        assurance_level: 'calculated' });
      continue;
    }
    if (!ref.id || context.assuranceById[ref.id] === undefined) continue;
    items.push({
      item_type: ref.type, ref_id: ref.id, ref_revision_no: ref.revision_no ?? null,
      query_descriptor: null, descriptor_hash: null,
      label: labelFor(ref, context), claim: null,
      assurance_level: context.assuranceById[ref.id]!,
    });
  }
  if (items.length === 0) return null;
  const runId = results.find((r) => r.ok && r.meta?.calculation_run_id)?.meta?.calculation_run_id ?? null;
  return { calculation_run_id: runId, items };
}

/** Server-generated labels (R2-C-08): from the referenced object's type and returned name. */
function labelFor(ref: EvidenceRef, context: GroundingContext): string {
  const name = ref.id ? context.entityNamesById[ref.id] : undefined;
  const base = ref.type.replace(/_/g, ' ');
  return name ? `${base}: ${name}` : base.charAt(0).toUpperCase() + base.slice(1);
}

// -----------------------------------------------------------------------------------------------
// Small helpers
// -----------------------------------------------------------------------------------------------

/**
 * The three organisation facts the prompt and period resolution need, on the caller's own client:
 * the `organizations` SELECT policy admits every member, so no wider client is needed.
 */
async function organisationOf(ctx: AccessContext, orgId: string): Promise<{ name: string; baseCurrency: string; fiscalYearStartMonth: number }> {
  const { data, error } = await ctx.db
    .from('organizations').select('name, base_currency, fiscal_year_start_month').eq('id', orgId).maybeSingle();
  if (error) throw toMotionError(error, ctx.requestId);
  const row = data as { name?: string; base_currency?: string; fiscal_year_start_month?: number } | null;
  return {
    name: row?.name ?? 'this organisation',
    baseCurrency: row?.base_currency ?? 'GBP',
    fiscalYearStartMonth: Number(row?.fiscal_year_start_month ?? 1),
  };
}

function titleOf(message: string): string {
  return message.replace(/\s+/g, ' ').trim().slice(0, 80);
}
