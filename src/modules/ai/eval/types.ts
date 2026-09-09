import type { ToolResult } from '../domain/allowed-set';
import type { ResponseMode } from '../domain/contract';
import type { GroundingStatus } from '../domain/grounding';
import type { PeriodRow } from '../domain/periods';

/**
 * The evaluation harness's vocabulary (AI_ARCHITECTURE.md §12; TEST_STRATEGY.md §10.3).
 *
 * A case is a recorded turn: the tool outputs the model saw and the `submit_answer` it produced,
 * plus what the server must make of them. Running a case is pure — no model, no database — so a
 * recorded run is deterministic and free, and a regression in the contract, the grounding check or
 * the prompt's version stamp shows up on every push.
 */

export type EvalSet = 'golden' | 'adversarial' | 'trap';

export interface RecordedToolCall {
  readonly seq: number;
  readonly name: string;
  readonly input: unknown;
  readonly result: ToolResult;
}

export interface EvalExpectation {
  /** The verdict the server must reach after regeneration and degradation. */
  readonly outcome: GroundingStatus;
  readonly mode?: ResponseMode;
  /** Golden: the first pass must be accepted. Trap: it must NOT be (R2-C-01..08). */
  readonly firstPass?: boolean;
  /** Metric keys the recorded turn called (§12 "the expected metric keys were called"). */
  readonly metricKeys?: readonly string[];
  /** The label period resolution must produce for the question. */
  readonly resolvedPeriod?: string;
  /** Figures that must appear in the final answer's text. */
  readonly numbers?: readonly string[];
  /** Text that must NOT appear anywhere in the final answer — a removed fabrication, a leaked instruction. */
  readonly absent?: readonly string[];
  /** A refusal must open with this exact template (§9.4). */
  readonly refusalOpening?: string;
  /** A first-pass reason (schema, mode or grounding) must match. */
  readonly reason?: string;
}

export interface EvalCase {
  readonly id: string;
  readonly set: EvalSet;
  /** SOW §10 category, or the adversarial / trap family. */
  readonly category: string;
  readonly role: 'owner' | 'admin' | 'employee' | 'client';
  readonly question: string;
  readonly periods: readonly PeriodRow[];
  readonly fiscalYearStartMonth: number;
  readonly toolCalls: readonly RecordedToolCall[];
  /** What the recorded model submitted first. */
  readonly submission: unknown;
  /** What it submitted after the regeneration message; the first submission again when absent. */
  readonly regenerated?: unknown;
  readonly expect: EvalExpectation;
}

export interface CaseResult {
  readonly id: string;
  readonly set: EvalSet;
  readonly category: string;
  readonly ok: boolean;
  readonly failures: readonly string[];
  readonly outcome: GroundingStatus;
  readonly mode: ResponseMode | null;
  readonly firstPassOk: boolean;
  readonly firstPassReasons: readonly string[];
  readonly statements: number;
  readonly cited: number;
  readonly toolCalls: number;
  readonly resolvedPeriod: string | null;
}

export interface EvalMetrics {
  readonly cases: number;
  readonly failures: number;
  /** Golden cases accepted on the first pass (target ≥ 0.98). */
  readonly groundingFirstPassRate: number;
  /** Statements with ≥ 1 evidence ref over every final `answer` (target 1.0). */
  readonly evidenceCoverage: number;
  /** Adversarial cases handled as expected (target 1.0). */
  readonly refusalCorrectness: number;
  /** Trap cases refused on the first pass and settled as expected (target 1.0). */
  readonly trapCatchRate: number;
  readonly clarificationRate: number;
  readonly meanToolCalls: number;
}

export interface EvalReport {
  readonly promptVersion: string;
  readonly model: string | null;
  readonly mode: 'recorded' | 'live';
  readonly startedAt: string;
  readonly durationMs: number;
  readonly metrics: EvalMetrics;
  readonly results: readonly CaseResult[];
}
