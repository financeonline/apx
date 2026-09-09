import type { ToolDefinition } from './types';
import { getBusinessSummary, getDataCoverage, getExpenseChanges, getMetric, getMetricTrend } from './metrics';
import { getActions, getCashAnalysis, getCustomerProfitability, getPayables, getReceivables } from './money';
import {
  getAlerts, getEvidence, getHealthScore, getSourceDocumentReference, getTransactionsForEvidence,
} from './intelligence';

/**
 * The closed registry (AI_ARCHITECTURE.md §3): the fifteen tools, and no way to add a sixteenth
 * without a code change here, a permission, a Zod schema with branded numbers, and a test.
 *
 * Order is the order the model is shown them, broadest first. `submit_answer` is not a tool in this
 * sense — it is the response contract (§5) and is added by the loop as the forced final call.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTool = ToolDefinition<any, unknown>;

export const TOOLS: readonly AnyTool[] = [
  getBusinessSummary,
  getMetric,
  getMetricTrend,
  getExpenseChanges,
  getCustomerProfitability,
  getCashAnalysis,
  getReceivables,
  getPayables,
  getAlerts,
  getHealthScore,
  getEvidence,
  getSourceDocumentReference,
  getTransactionsForEvidence,
  getDataCoverage,
  getActions,
];

export const TOOL_NAMES: readonly string[] = TOOLS.map((t) => t.name);

export function toolNamed(name: string): AnyTool | null {
  return TOOLS.find((t) => t.name === name) ?? null;
}

/** §2 step 7: the hard cap on tool calls in one turn. */
export const MAX_TOOL_CALLS = 8;
/** §7.8: the extra calls a regeneration may make. */
export const REGENERATION_EXTRA_CALLS = 2;
/** §2: per-tool timeout. */
export const TOOL_TIMEOUT_MS = 10_000;
