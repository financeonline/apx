/**
 * `modules/scenarios` — What-If Scenarios (SOW §14, REQ-SC-01…10; Phase 12, ADR-100).
 *
 * A scenario is the only thing in MOTION that speaks about a future somebody CHOSE rather than one
 * the figures imply. That is why three separations run through the whole module:
 *
 *   * **Actual, forecast, scenario are three different claims** and are never flattened into one.
 *     An actual is a `metric_snapshots` row; a forecast is what the finished months suggest; a
 *     scenario is what would follow IF stated assumptions held. The tables are separate, the words
 *     on the page are separate, and every scenario figure is stored `estimated` by constraint.
 *   * **The assumptions are the answer.** Nothing is inferred — not a margin, not a payment date,
 *     not an interest rate, not a demand curve. Every number a scenario moves is either one the
 *     user gave or one the deterministic engine already computed, and the list of assumptions is on
 *     the page beside the figures rather than behind them.
 *   * **Claude is not the calculator.** The analyst can READ a saved scenario through one tool and
 *     can do nothing else with it. There is no tool that computes a scenario, so there is no path
 *     by which a model-invented assumption becomes a stored figure.
 */

export {
  ASSUMPTION_KINDS, CASH_EFFECTS, CASH_ONLY_KINDS, CATEGORY_FOR_KIND, CHANGE_MODES,
  DEFAULT_CASH_EFFECT, MAX_AMOUNT, MAX_ASSUMPTIONS, MAX_HEADCOUNT, MAX_PERCENT,
  MIN_ASSUMPTIONS, MIN_PERCENT, SCENARIO_CONFIG_VERSION, SCENARIO_HEADLINE_KEYS, SCENARIO_METHOD,
  type AssumptionKind, type CashEffect, type ChangeMode, type UnavailableReason,
} from './domain/config';

export type {
  Assumption, DebtDrawdown, DebtRepayment, Hiring, MarketingChange, PayrollChange, PricingChange,
  RevenueChange, ScenarioBasis, ScenarioCell, ScenarioResult, ScenarioUnavailable,
  SupplierCostChange,
} from './domain/types';

export {
  AssumptionSchema, boundIssues, conflictIssues, defaultCashEffect, isAssumptionKind,
  parseAssumptions, type AssumptionIssue,
} from './domain/assumptions';

export { applyScenario, sufficiency, type ApplyInput } from './domain/apply';

export {
  ASSUMPTION_LABEL, ASSUMPTION_NOTE, ASSUMPTION_QUESTION, CASH_EFFECT_LABEL,
  SCENARIO_DISCLAIMER, UNAVAILABLE_HEADLINE, UNAVAILABLE_TEXT,
  assumptionSentence, unavailableText,
} from './domain/presentation';

export {
  archiveScenario, basisFromForecast, hasScenario, listScenarios, loadScenario, runScenario,
  type NoScenario, type RunScenarioInput, type ScenarioMetricView, type ScenarioPeriodView,
  type ScenarioState, type ScenarioSummary, type ScenarioView,
} from './services';
