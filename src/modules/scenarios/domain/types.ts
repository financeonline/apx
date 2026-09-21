import type { ForecastBasis } from '@/modules/forecast';
import type {
  AssumptionKind, CashEffect, ChangeMode, UnavailableReason,
} from './config';

/**
 * The shapes a what-if works in (REQ-SC-01…10; ADR-100).
 *
 * Money is a STRING everywhere, as it is everywhere else in MOTION (ADR-006). A scenario figure is
 * still a money figure and gets no exemption for being about a future that was assumed rather than
 * expected.
 *
 * Every assumption is EXPLICIT: there is no field whose absence means "MOTION decided". A kind that
 * needs a number has the number; a kind whose cash treatment is a choice carries the choice.
 *
 * Pure.
 */

interface AssumptionBase {
  readonly kind: AssumptionKind;
  /** 1-based index into the horizon: the first month the change applies. */
  readonly startsInMonth: number;
  /** Whether the change is also assumed to move cash in the month it lands (§7). */
  readonly cashEffect: CashEffect;
}

/** A change expressed as a share of the baseline, or as an amount of money. */
interface SizedChange extends AssumptionBase {
  readonly mode: ChangeMode;
  /** A percentage (`percent`) or a money amount (`amount`), as a string. Signed. */
  readonly value: string;
}

export interface RevenueChange extends SizedChange {
  readonly kind: 'revenue_change';
  /**
   * Whether direct costs are assumed to move with revenue at the organisation's own current rate.
   *
   * Off by default and stated either way, because both answers are assumptions: costs that do not
   * move mean every extra pound is margin, and costs that do move mean a margin was applied. The
   * rate is never invented — it is the ratio of the forecast's own `cost_of_sales` to its own
   * `revenue` (§7).
   */
  readonly directCostsFollow: boolean;
}

export interface PayrollChange extends SizedChange { readonly kind: 'payroll_change' }
export interface SupplierCostChange extends SizedChange { readonly kind: 'supplier_cost_change' }
export interface MarketingChange extends SizedChange { readonly kind: 'marketing_change' }

export interface Hiring extends AssumptionBase {
  readonly kind: 'hiring';
  readonly headcount: number;
  /** What each new person costs the business per month, in full. Required — never assumed (§8). */
  readonly monthlyCostPerPerson: string;
}

export interface PricingChange extends AssumptionBase {
  readonly kind: 'pricing_change';
  /** The price change, as a percentage string. */
  readonly pricePercent: string;
  /**
   * What is assumed to happen to the number of sales. Required, and `0` is a real answer meaning
   * "the same number of sales" — §9 forbids a price rise silently becoming a revenue rise.
   */
  readonly volumePercent: string;
  /** As `RevenueChange.directCostsFollow`, but direct costs follow VOLUME, not price (§9). */
  readonly directCostsFollow: boolean;
}

export interface DebtDrawdown extends AssumptionBase {
  readonly kind: 'debt_drawdown';
  /** Money borrowed, once, in `startsInMonth`. Positive. */
  readonly amount: string;
}

export interface DebtRepayment extends AssumptionBase {
  readonly kind: 'debt_repayment';
  /** Capital repaid each month from `startsInMonth`. Positive. */
  readonly monthlyAmount: string;
  /**
   * Interest paid each month, when the user supplied it. `null` means they did not, and the
   * scenario says interest is not included rather than deriving a rate MOTION does not hold (§11).
   */
  readonly monthlyInterest: string | null;
}

export type Assumption =
  | RevenueChange | PayrollChange | SupplierCostChange | MarketingChange
  | Hiring | PricingChange | DebtDrawdown | DebtRepayment;

/** An assumption MOTION cannot apply, and the real condition that stopped it (§7). */
export interface ScenarioUnavailable {
  readonly kind: AssumptionKind;
  readonly reason: UnavailableReason;
  /** The metric whose absence caused it, when one did. */
  readonly metricKey: string | null;
}

/**
 * What the baselines and levels the scenario is computed against look like.
 *
 * All of it comes from the stored forecast and the engine's own snapshots; nothing here is derived
 * from the assumptions, and nothing is computed by this module that the engine has not computed
 * already.
 */
export interface ScenarioBasis {
  /** Leaf levels from the forecast, per metric key. `null` where the forecast refused the metric. */
  readonly leafLevels: Readonly<Record<string, string | null>>;
  /** `expense_by_category` levels for the dimensions a percentage assumption needs. */
  readonly categoryLevels: Readonly<Record<string, string | null>>;
  /** The actual closing balance the forecast's cash chain opened on. `null` when there is none. */
  readonly lastActualClosingCash: string | null;
}

/** One metric, one future month, baseline beside scenario. */
export interface ScenarioCell {
  readonly metricKey: string;
  readonly periodId: string;
  readonly periodLabel: string;
  readonly baselineValue: string;
  readonly scenarioValue: string;
  /** scenario − baseline. */
  readonly change: string;
  /**
   * `change / |baseline|`, as a ratio string, or `null` when the baseline is zero.
   *
   * The engine's own rule (FINANCIAL_ENGINE.md §3.2): a percentage across zero is meaningless, and
   * the absolute change is still written.
   */
  readonly changeRatio: string | null;
  readonly derivation: 'baseline' | 'identity';
  readonly derivedFrom: readonly string[];
}

export interface ScenarioResult {
  readonly method: string;
  readonly configVersion: string;
  readonly cells: readonly ScenarioCell[];
  /** Assumptions MOTION refused to apply. A non-empty list means there are no cells (§7). */
  readonly unavailable: readonly ScenarioUnavailable[];
  /** Inherited from the forecast: how much to lean on the baseline the scenario moves. */
  readonly basis: ForecastBasis | null;
}
