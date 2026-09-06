/**
 * The Business Health Score (FINANCIAL_ENGINE.md §7).
 *
 * A deterministic, weighted summary of six dimensions of an organisation's own financial data. It
 * is an analytical indicator and nothing more — every screen that shows it carries the SOW §9
 * disclaimer, which is exported here so no screen can forget it.
 *
 * `domain/` is pure: no Supabase, no Next.js, no clock, no randomness, and — the property the whole
 * design rests on — no `alerts` row and no user status anywhere in its inputs.
 */

export {
  BANDS,
  B1_FALLING_POINTS,
  B1_PERIODS,
  B1_RISING_POINTS,
  B4_FULL_POINTS,
  B4_PARTIAL_POINTS,
  BANKING_HEALTH_RULES,
  CASH_FLOW_RULES,
  CASH_POSITIVE_POINTS,
  CASH_POSITIVE_RESULT,
  COST_CONTROL_RULES,
  CUSTOMER_QUALITY_RULES,
  C3_NEGATIVE_POINTS,
  C3_PERIODS,
  C3_POSITIVE_PERIODS,
  C3_POSITIVE_POINTS,
  DIMENSION_BASELINE,
  DIMENSION_MAX,
  DIMENSION_MIN,
  DIMENSION_WEIGHTS,
  G2_HIGH_CV,
  G2_HIGH_POINTS,
  G2_LOW_CV,
  G2_LOW_POINTS,
  G2_PERIODS,
  G3_POINTS,
  G3_TOP1_THRESHOLD,
  HEALTH_CONFIG_VERSION,
  HEALTH_DIMENSION_KEYS,
  HEALTH_DISCLAIMER,
  MIN_DIMENSIONS_FOR_SCORE,
  MIN_REQUIRED_COMPLETENESS,
  PROFITABILITY_RULES,
  PROXY_CAP,
  PROXY_CAP_NOTE,
  REVENUE_GROWTH_RULES,
  TOTAL_WEIGHT,
  bandFor,
  bandLabel,
  type BandedRule,
  type HealthBand,
  type HealthDimensionKey,
  type RuleDirection,
  type ScoreBand,
} from './domain/config';

export {
  applyRule,
  bandOf,
  flatRule,
  metricComponent,
  metricValue,
  reference,
  scoreFromRules,
  seriesOf,
  skippedRule,
  trailingPeriodIds,
} from './domain/apply';

export {
  satisfyingObservation,
  testRequirements,
  type DimensionEvaluation,
  type RequirementGroup,
  type RequirementVerdict,
} from './domain/dimension';

export {
  TEMPLATE_IDS,
  sentence,
  type TemplateId,
} from './domain/sentences';

export {
  computeHealthScore,
  dimensionScoreFromRules,
  scoreFromBreakdown,
} from './domain/score';

export {
  attentionCount,
  summarySentence,
  type ScoreSummaryInput,
  type SummaryClauseId,
  type SummaryInput,
  type SummarySentence,
} from './domain/summary-templates';

export { evaluateProfitability, hasNoCostOfSales } from './domain/rules/profitability';
export { evaluateCashFlow } from './domain/rules/cash-flow';
export { coefficientOfVariation, evaluateRevenueGrowth } from './domain/rules/revenue-growth';
export { evaluateCostControl, spikeConditions } from './domain/rules/cost-control';
export { evaluateCustomerQuality } from './domain/rules/customer-quality';
export { balanceTrendRule, bankingAnomalies, evaluateBankingHealth } from './domain/rules/banking-health';

export type {
  ConditionReference,
  DimensionBreakdown,
  ExclusionReason,
  FactorSentence,
  HealthInput,
  HealthScore,
  MetricReference,
  RuleApplication,
} from './domain/types';

// ---------------------------------------------------------------------------------------------
// Services. Server-only; the components below never call them directly (SERVICE_ARCHITECTURE.md).
// ---------------------------------------------------------------------------------------------

export {
  loadBankRecords,
  loadObservations,
  loadRecurringGroups,
} from './data/repository';

export {
  isNotEnoughData,
  loadHealthCard,
  loadHealthHistory,
  loadPortfolioScores,
  type HealthCardView,
  type HealthHistoryPoint,
  type PortfolioScore,
} from './services/read';

export {
  healthStep,
  newCounterpartyIdsIn,
  scoreChunk,
  type HealthChunkRequest,
  type HealthRunDeps,
} from './services/score-run';
