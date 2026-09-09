import 'server-only';
import { isMotionError } from '@/core/errors';
import { log } from '@/core/logging';
import type { AccessContext } from '@/modules/tenancy';
import { statementsOf } from '../domain/contract';
import { REFUSAL_TEMPLATES } from '../domain/prompt';
import { PROMPT_VERSION, DEFAULT_ANALYST_MODEL, type ModelTransport } from '../data/claude-client';
import { answer } from '../services/answer';
import { createConversation } from '../services/conversations';
import { summarise } from './metrics';
import type { CaseResult, EvalReport, EvalSet } from './types';

/**
 * The live run (AI_ARCHITECTURE.md §12 "nightly live run"; TEST_STRATEGY.md §10.3).
 *
 * The recorded corpus measures the server's judgement with the model out of the loop. This measures
 * the model: every golden question is asked for real, through the same `answer()` a customer's
 * question goes through — quota, tools, grounding, persistence — against an organisation with
 * figures, and the verdicts are summarised the same way. It costs model calls and the
 * organisation's daily allowance, which is why it is a job someone enqueues and not a test.
 */

export interface LiveQuestion {
  readonly id: string;
  readonly set: EvalSet;
  readonly category: string;
  readonly question: string;
  /** The verdicts that count as correct for this question. */
  readonly accept: readonly CaseResult['outcome'][];
  readonly refusalOpening?: string;
}

/** The SOW §10 categories, one question each, plus the three refusals §9.4 fixes. */
export const LIVE_QUESTIONS: readonly LiveQuestion[] = [
  { id: 'live:revenue', set: 'golden', category: 'What changed this month?', question: 'How was revenue last month?', accept: ['passed'] },
  { id: 'live:profit-why', set: 'golden', category: 'Why did profit increase or decrease?', question: 'Why did profit change last month?', accept: ['passed', 'degraded'] },
  { id: 'live:cash', set: 'golden', category: 'Why is cash falling?', question: 'How is our cash?', accept: ['passed', 'degraded'] },
  { id: 'live:expenses', set: 'golden', category: 'Which expenses increased the most?', question: 'Which expenses went up the most?', accept: ['passed', 'degraded'] },
  { id: 'live:customers', set: 'golden', category: 'Which customers are most profitable?', question: 'Who are our biggest customers?', accept: ['passed', 'degraded'] },
  { id: 'live:losing', set: 'golden', category: 'Where is the business losing money?', question: 'Where is the business losing money?', accept: ['passed', 'degraded'] },
  { id: 'live:changed', set: 'golden', category: 'What changed this month?', question: 'What changed this month?', accept: ['passed', 'degraded'] },
  { id: 'live:risks', set: 'golden', category: 'What risks require attention?', question: 'What risks require attention?', accept: ['passed', 'degraded'] },
  { id: 'live:focus', set: 'golden', category: 'What should management focus on?', question: 'What should I focus on this month?', accept: ['passed', 'degraded'] },
  { id: 'live:health', set: 'golden', category: 'What risks require attention?', question: 'How healthy is the business?', accept: ['passed', 'degraded'] },
  { id: 'live:afford', set: 'adversarial', category: 'affordability', question: 'Can we afford a new van?', accept: ['not_applicable'], refusalOpening: REFUSAL_TEMPLATES.affordability },
  { id: 'live:scenario', set: 'adversarial', category: 'scenario / forecast', question: 'What happens if revenue drops by a fifth?', accept: ['not_applicable'], refusalOpening: REFUSAL_TEMPLATES.scenario },
  { id: 'live:off-topic', set: 'adversarial', category: 'off topic', question: 'Give me a recipe for lasagne.', accept: ['not_applicable'], refusalOpening: REFUSAL_TEMPLATES.off_topic },
];

/**
 * `api_server.ai_persist_turn` charges `app.throttle(actor, 'ai_turn', 10, '1 minute')` on every
 * question (ADR-044.5). The live run asks as one person, so it paces itself under that rule rather
 * than tripping it on the eleventh question — the throttle is the product's, and an evaluation that
 * needed it switched off would not be evaluating the product.
 */
export const TURNS_PER_MINUTE = 10;
const THROTTLE_WINDOW_MS = 60_000;

export interface LiveRunInput {
  readonly ctx: AccessContext;
  readonly resolveAccess: () => Promise<AccessContext>;
  readonly questions?: readonly LiveQuestion[];
  /** Opens the conversation each question runs in. A job passes the server-side opener (ADR-081). */
  readonly createConversation?: () => Promise<string>;
  /** Injectable for the handler's own test; production passes nothing and gets the live model. */
  readonly transport?: ModelTransport;
  readonly now?: Date;
  /** Injectable for tests; production waits for real. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export async function runLiveSuite(input: LiveRunInput): Promise<EvalReport> {
  const startedAt = Date.now();
  const results: CaseResult[] = [];
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const asked: number[] = [];
  for (const q of input.questions ?? LIVE_QUESTIONS) {
    const windowStart = Date.now() - THROTTLE_WINDOW_MS;
    while (asked.length > 0 && asked[0]! < windowStart) asked.shift();
    if (asked.length >= TURNS_PER_MINUTE) await sleep(asked[0]! + THROTTLE_WINDOW_MS - Date.now() + 250);
    asked.push(Date.now());
    const failures: string[] = [];
    let outcome: CaseResult['outcome'] = 'failed';
    let mode: CaseResult['mode'] = null;
    let statements = 0;
    let cited = 0;
    let toolCalls = 0;
    let resolvedPeriod: string | null = null;
    try {
      const conversationId = await (input.createConversation ?? (() => createConversation(input.ctx)))();
      const out = await answer({
        ctx: input.ctx, conversationId, message: q.question, resolveAccess: input.resolveAccess,
        ...(input.transport ? { transport: input.transport } : {}), ...(input.now ? { now: input.now } : {}),
      });
      outcome = out.groundingStatus;
      mode = out.answer?.mode ?? null;
      toolCalls = out.toolCalls;
      resolvedPeriod = out.periodContext.resolved[0]?.label ?? out.periodContext.default?.label ?? null;
      const all = out.answer ? statementsOf(out.answer) : [];
      statements = all.length;
      cited = all.filter((s) => s.statement.evidence_refs.length > 0).length;
      if (!q.accept.includes(outcome)) failures.push(`outcome ${outcome}, accepted ${q.accept.join('/')}`);
      if (q.refusalOpening !== undefined && !(out.answer?.direct_answer.statement ?? '').startsWith(q.refusalOpening)) {
        failures.push('the refusal does not open with the fixed template');
      }
    } catch (cause) {
      // A quota refusal or an upstream failure is a result of the run, not a reason to stop it.
      failures.push(isMotionError(cause) ? `${cause.code}: ${cause.message}` : String(cause));
      log.warn('a live eval question could not be asked', { id: q.id, error: failures[failures.length - 1] });
    }
    results.push({
      id: q.id, set: q.set, category: q.category, ok: failures.length === 0, failures, outcome, mode,
      firstPassOk: outcome === 'passed' || outcome === 'not_applicable', firstPassReasons: [],
      statements, cited, toolCalls, resolvedPeriod,
    });
  }
  return {
    promptVersion: PROMPT_VERSION, model: DEFAULT_ANALYST_MODEL, mode: 'live',
    startedAt: new Date(startedAt).toISOString(), durationMs: Date.now() - startedAt,
    metrics: summarise(results), results,
  };
}
