/**
 * `modules/funding` — Funding Readiness (Phase 16; PHASE_16_IMPLEMENTATION.md; ADR-119, ADR-121,
 * ADR-145). An indicative, explainable readiness assessment. It is not a lending decision.
 */
export {
  CASH_FAMILY, FACTOR_KEYS, FACTOR_NAMES, FACTOR_WEIGHTS, FUNDING_DISCLAIMER, FUNDING_RULES_VERSION,
  READINESS_BANDS, RULES as FUNDING_RULES, readinessBand, type FactorKey,
} from './domain/config';
export { assessFundingReadiness } from './domain/assess';
export type {
  ActionPriority, FactorResult, FactorSentence, FundingAssessment, FundingInput, ImprovementAction, MetricUse,
  MissingLine, OpenInvoiceFact, RuleResult,
} from './domain/types';
export { runFundingAssessment, type FundingTrigger } from './services/assess';
export { fundingEnabled, getFundingView, type FundingView } from './services/read';
