/**
 * `scenario.config.v1` — every number and every rule a what-if depends on, declared once (ADR-100).
 *
 * The same discipline as `forecast.config.v1` and `health.config.v1`: a bound inlined in a
 * validator is a bound nobody can recover from a scenario stored months ago, and "why did it say
 * that?" is the question a saved scenario exists to answer. Bumping any value here is a version
 * bump, never an in-place edit — two scenarios worked out under different rules must not be
 * comparable by accident.
 *
 * Pure.
 */

export const SCENARIO_METHOD = 'scenario.v1';
export const SCENARIO_CONFIG_VERSION = 'scenario.config.v1';

/**
 * The eight changes SOW §14 names (REQ-SC-02…08), as the product's own vocabulary.
 *
 * "Debt" is split from "repayment" because they are opposite cash movements with different
 * evidence: borrowing is money arriving once, a repayment is money leaving every month. The SOW
 * lists them on one line; treating them as one kind would have made the form ask for a signed
 * number, which is exactly the kind of question §15 forbids.
 */
export const ASSUMPTION_KINDS = [
  'revenue_change',
  'payroll_change',
  'supplier_cost_change',
  'marketing_change',
  'hiring',
  'pricing_change',
  'debt_drawdown',
  'debt_repayment',
] as const;
export type AssumptionKind = (typeof ASSUMPTION_KINDS)[number];

/** How a change is expressed: a share of what is there now, or an amount of money. */
export const CHANGE_MODES = ['percent', 'amount'] as const;
export type ChangeMode = (typeof CHANGE_MODES)[number];

/**
 * Whether a change is also assumed to move cash in the month it happens.
 *
 * §7 forbids inventing payment timing, so this is never implied — it is a field on the assumption,
 * carried into the stored scenario and rendered in the assumptions list, so a reader can see the
 * answer that was given rather than guess what the engine assumed.
 */
export const CASH_EFFECTS = ['same_month', 'none'] as const;
export type CashEffect = (typeof CASH_EFFECTS)[number];

/**
 * The cash answer the form offers first, per kind.
 *
 * A default is not a hidden assumption: every one of these is displayed beside the figure it
 * applies to and is stored with the scenario. Costs default to moving cash because a payroll run
 * and a supplier invoice are paid in the period they belong to far more often than not; revenue
 * defaults to NOT moving cash because when a sale is collected depends on terms MOTION does not
 * hold (§7, §10). Debt is cash by definition and has no choice to make.
 */
export const DEFAULT_CASH_EFFECT: Readonly<Record<AssumptionKind, CashEffect>> = {
  revenue_change: 'none',
  pricing_change: 'none',
  payroll_change: 'same_month',
  supplier_cost_change: 'same_month',
  marketing_change: 'same_month',
  hiring: 'same_month',
  debt_drawdown: 'same_month',
  debt_repayment: 'same_month',
};

/** The two kinds whose cash effect is not a choice: they ARE cash movements. */
export const CASH_ONLY_KINDS: ReadonlySet<AssumptionKind> = new Set([
  'debt_drawdown', 'debt_repayment',
]);

/**
 * Bounds on a percentage change.
 *
 * `-100` is the floor because a cost or a revenue cannot fall by more than all of it; below that
 * the arithmetic would turn a cost into an income. `500` is the ceiling: a six-fold rise in one
 * month is already past anything a three-month level-carried baseline can speak about, and a
 * scenario that accepted 100,000% would return a number with no meaning rather than an error.
 */
export const MIN_PERCENT = -100;
export const MAX_PERCENT = 500;

/**
 * Bounds on a money amount, in the organisation's own currency units.
 *
 * A billion is not a business limit, it is an arithmetic one: past it a figure stops being a
 * statement about a small business and starts being a typing mistake nobody caught.
 */
export const MAX_AMOUNT = 1_000_000_000;

/** Nobody hires a thousand people into a three-month what-if; past this it is a mistyped field. */
export const MAX_HEADCOUNT = 1000;

/** A scenario must change something, and a form with forty rows is not the §15 experience. */
export const MIN_ASSUMPTIONS = 1;
export const MAX_ASSUMPTIONS = 8;

/**
 * Why a scenario could not be worked out. Each is a real condition the server checked, rendered in
 * words by the presentation layer and never shown raw (§7, §20).
 */
export const UNAVAILABLE_REASONS = [
  'no_forecast',
  'metric_not_forecast',
  'no_category_baseline',
  'no_direct_costs',
  'no_revenue_baseline',
] as const;
export type UnavailableReason = (typeof UNAVAILABLE_REASONS)[number];

/**
 * The metrics a scenario reports, in the order §14 names them.
 *
 * The same keys the forecast and the actuals use, so BASELINE and SCENARIO are a join rather than a
 * mapping, and the identities hold across all three.
 */
export const SCENARIO_HEADLINE_KEYS = [
  'revenue', 'operating_expenses', 'operating_profit', 'closing_cash', 'receivables', 'payables',
] as const;

/**
 * The `expense_by_category` dimensions a percentage assumption needs a baseline for.
 *
 * `+₹50,000 of payroll` needs nothing: it is an amount. `+5% of payroll` needs to know what payroll
 * has been running at, and that lives in `expense_by_category` with `dimension_key = 'payroll'` —
 * the engine's own breakdown, not a second definition of the word (FINANCIAL_ENGINE.md §3.1).
 */
export const CATEGORY_FOR_KIND: Readonly<Partial<Record<AssumptionKind, string>>> = {
  payroll_change: 'payroll',
  marketing_change: 'marketing',
};
