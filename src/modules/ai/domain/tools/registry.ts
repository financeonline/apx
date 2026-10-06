import type { ToolDefinition } from './types';
import { getBusinessSummary, getDataCoverage, getExpenseChanges, getMetric, getMetricTrend } from './metrics';
import { getActions, getCashAnalysis, getCustomerProfitability, getPayables, getReceivables } from './money';
import {
  getAlerts, getDocumentEvidenceTool, getEvidence, getForecast, getHealthScore, getRecordEvidence,
  getScenario, getSourceDocumentReference, getTransactionsForEvidence,
} from './intelligence';
import { getBankAccounts, getBankCategories, getRecurringPayments, getUnusualTransactions } from './banking';
import { getCampaignPerformance, getProductContribution, getSalesPipeline } from './commercial';
import { getBudgetVariance } from './budget';

/**
 * The closed registry (AI_ARCHITECTURE.md §3): the twenty-seven tools, and no way to add another
 * without a code change here, a permission, a Zod schema with branded numbers, and a test.
 *
 * The last two were added in Phase 9 (ADR-097). They give the analyst the two ends of the evidence
 * chain Phase 8 built for the interface — one record's own history, and what rests on one file — so
 * that "is that payment real?" and "what is this file behind?" are answerable from the same services
 * the drawer uses rather than from anything the model knows.
 *
 * Tool 19 (Phase 12, ADR-100) READS a saved what-if and takes no assumptions, so there is no tool
 * on which a model-invented assumption could become a stored figure — the structural half of §18.
 *
 * Tools 20–23 (Phase 13, ADR-101) read banking through the Banking page's own services. Each
 * result states `source: 'imported_statements'` and `connected: false`, because no live provider
 * exists and an answer that said otherwise must contradict its own evidence.
 *
 * Tools 24–26 (Phase 14, ADR-102) read commercial intelligence through the Customers pages' own
 * services: product contribution only from attributed lines, campaign revenue only through won
 * opportunities, conversion with its cohort named. Each gap is returned as a gap, never filled.
 *
 * Tool 27 (ADR-142) reads budget against actual through the Budget page's own service; the actual
 * figures carry their snapshot ids, the plan is labelled as imported.
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
  getRecordEvidence,
  getDocumentEvidenceTool,
  getForecast,
  getScenario,
  getBankAccounts,
  getRecurringPayments,
  getUnusualTransactions,
  getBankCategories,
  getProductContribution,
  getCampaignPerformance,
  getSalesPipeline,
  getBudgetVariance,
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
