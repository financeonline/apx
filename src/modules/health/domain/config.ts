/**
 * `health.config.v1` — the weights, thresholds and bands of the Business Health Score
 * (FINANCIAL_ENGINE.md §7.1–§7.3, CD-19).
 *
 * Every number the score depends on is declared here, once, and stamped onto every row the engine
 * writes as `config_version`. That is not tidiness: the score is the first number a user sees and
 * the one an adviser or a lender will challenge, so "why is it 62?" has to be answerable line by
 * line, months later, against the config that was in force at the time. A threshold inlined in a
 * rule would be a number nobody could recover from a stored breakdown.
 *
 * **These thresholds require product-owner sign-off (CD-19).** They are implemented exactly as
 * `FINANCIAL_ENGINE.md §7.3` states them; approving them is a separate act from implementing them.
 *
 * Bumping any value here is a config-version bump, never an in-place edit — two scores computed
 * under different rules must never be comparable by accident.
 *
 * Pure.
 */

import { HEALTH_CONFIG_VERSION } from '@/modules/financial-engine';

export { HEALTH_CONFIG_VERSION };

export const HEALTH_DIMENSION_KEYS = [
  'profitability', 'cash_flow', 'revenue_growth', 'cost_control',
  'customer_quality', 'banking_health',
] as const;
export type HealthDimensionKey = (typeof HEALTH_DIMENSION_KEYS)[number];

/**
 * §7.1. Marketing Efficiency and Funding Readiness are reserved at 10 each and land post-MVP, at
 * which point every weight is rescaled to sum to 100 again and the config version bumps.
 */
export const DIMENSION_WEIGHTS: Readonly<Record<HealthDimensionKey, number>> = {
  profitability: 25,
  cash_flow: 25,
  revenue_growth: 15,
  cost_control: 15,
  customer_quality: 10,
  banking_health: 10,
};

/** The six MVP weights sum to 100. Asserted by a test, because a silent 99 would skew every score. */
export const TOTAL_WEIGHT = HEALTH_DIMENSION_KEYS
  .reduce((total, key) => total + DIMENSION_WEIGHTS[key], 0);

/** Every dimension starts here; rules move it (§7.3). */
export const DIMENSION_BASELINE = 50;
export const DIMENSION_MIN = 0;
export const DIMENSION_MAX = 100;

/** §7.2: a dimension whose required metrics are thinner than this is excluded, not guessed at. */
export const MIN_REQUIRED_COMPLETENESS = 0.6;

/**
 * §7.2, ADR-035: a dimension resting on estimated or proxy figures is capped rather than excluded,
 * so a bank-only organisation gets a real score on its first import instead of "not enough data".
 * The cap is what stops that score claiming more certainty than a bank statement can carry.
 */
export const PROXY_CAP = 70;
export const PROXY_CAP_NOTE = 'based on bank data only';

/** §7.2: fewer than three dimensions cannot describe a business, so the score is NULL. */
export const MIN_DIMENSIONS_FOR_SCORE = 3;

export type HealthBand = 'at_risk' | 'needs_attention' | 'stable' | 'strong';

/** §7.2. Inclusive lower bounds, checked highest-first. */
export const BANDS: ReadonlyArray<{ band: HealthBand; min: number; label: string }> = [
  { band: 'strong', min: 80, label: 'Strong' },
  { band: 'stable', min: 60, label: 'Stable' },
  { band: 'needs_attention', min: 40, label: 'Needs attention' },
  { band: 'at_risk', min: 0, label: 'At risk' },
];

export function bandFor(score: number | null): HealthBand | null {
  if (score === null) return null;
  return BANDS.find((b) => score >= b.min)?.band ?? 'at_risk';
}

export function bandLabel(band: HealthBand | null): string | null {
  return band === null ? null : BANDS.find((b) => b.band === band)?.label ?? null;
}

/**
 * SOW §9. Carried on every screen that shows the score, and stored with the row so an exported
 * report cannot lose it.
 */
export const HEALTH_DISCLAIMER =
  'This score is an indicative summary of your own financial data. It is not a credit rating and not a lending decision.';

// ---------------------------------------------------------------------------------------------
// Thresholds, §7.3
// ---------------------------------------------------------------------------------------------

/**
 * A banded rule.
 *
 * Bands are declared as DATA rather than as an `if` chain so the test suite can walk every threshold
 * in §7.3 and assert a fixture at it, just below it and just above it, without a second copy of the
 * numbers living in the tests (TEST_STRATEGY.md §7). A threshold that exists only inside a
 * conditional is a threshold no test can enumerate.
 *
 * `direction` decides how `bound` reads:
 *   - `higher_is_better`: bands descend; `bound` is the band's LOWER limit.
 *   - `lower_is_better`: bands ascend; `bound` is the band's UPPER limit.
 * `exclusive` makes that limit strict, which §7.3 needs in four places — "cash > 0" and the
 * margin-trend bands are open at one end, and an inclusive bound there would score a business on
 * the wrong side of its own threshold.
 * The final band carries `bound: null` and catches everything left.
 */
export interface ScoreBand {
  readonly bound: string | null;
  readonly exclusive?: true;
  readonly points: number;
  /** The band label stored in `breakdown[].rules[].result`, and shown in the explainability panel. */
  readonly result: string;
}

export type RuleDirection = 'higher_is_better' | 'lower_is_better';

export interface BandedRule {
  readonly rule: string;
  readonly description: string;
  readonly direction: RuleDirection;
  readonly bands: readonly ScoreBand[];
}

function higher(rule: string, description: string, bands: readonly ScoreBand[]): BandedRule {
  return { rule, description, direction: 'higher_is_better', bands };
}

function lower(rule: string, description: string, bands: readonly ScoreBand[]): BandedRule {
  return { rule, description, direction: 'lower_is_better', bands };
}

export const PROFITABILITY_RULES = {
  /** P1 net margin level. */
  P1: higher('P1', 'Net margin level', [
    { bound: '0.15', points: 30, result: '>= 0.15' },
    { bound: '0.05', points: 15, result: '0.05 to 0.15' },
    { bound: '0', points: 0, result: '0 to 0.05' },
    { bound: null, points: -30, result: '< 0' },
  ]),
  /** P2 gross margin level. Note the deliberate gap: 0.20-0.30 scores nothing either way. */
  P2: higher('P2', 'Gross margin level', [
    { bound: '0.50', points: 10, result: '>= 0.50' },
    { bound: '0.30', points: 5, result: '0.30 to 0.50' },
    { bound: '0.20', points: 0, result: '0.20 to 0.30' },
    { bound: null, points: -10, result: '< 0.20' },
  ]),
  /** P3 margin trend, on `gross_margin.variance.trailing_3m_avg`. */
  P3: higher('P3', 'Gross margin trend against the 3-month average', [
    { bound: '0.02', points: 10, result: '>= +0.02' },
    { bound: '-0.02', exclusive: true, points: 0, result: 'between -0.02 and +0.02' },
    { bound: null, points: -15, result: '<= -0.02' },
  ]),
  /** P4 profit momentum, on `net_profit.variance.prev_period.pct_change`. */
  P4: higher('P4', 'Profit momentum against last month', [
    { bound: '0.10', points: 5, result: '>= +0.10' },
    { bound: '-0.20', exclusive: true, points: 0, result: 'between -0.20 and +0.10' },
    { bound: null, points: -10, result: '<= -0.20' },
  ]),
} as const;

export const CASH_FLOW_RULES = {
  C1: higher('C1', 'Closing cash sign', [
    { bound: '0', exclusive: true, points: 10, result: '> 0' },
    { bound: null, points: -40, result: '<= 0' },
  ]),
  C2: higher('C2', 'Cash runway', [
    { bound: '6', points: 20, result: '>= 6 months' },
    { bound: '3', points: 5, result: '3 to 6 months' },
    { bound: '1', points: -15, result: '1 to 3 months' },
    { bound: null, points: -30, result: '< 1 month' },
  ]),
  C4: higher('C4', 'Cash against monthly outflows', [
    { bound: '2', points: 5, result: '>= 2x' },
    { bound: '0.5', points: 0, result: '0.5x to 2x' },
    { bound: null, points: -10, result: '< 0.5x' },
  ]),
} as const;

/** C2's special case (§7.3): runway is NULL because the business is cash-generative, not unknown. */
export const CASH_POSITIVE_POINTS = 20;
export const CASH_POSITIVE_RESULT = 'cash generative';
/** C3: positive net movement in at least this many of the last three periods. */
export const C3_POSITIVE_PERIODS = 2;
export const C3_PERIODS = 3;
export const C3_POSITIVE_POINTS = 15;
export const C3_NEGATIVE_POINTS = -20;

export const REVENUE_GROWTH_RULES = {
  G1: higher('G1', 'Revenue growth', [
    { bound: '0.20', points: 30, result: '>= +0.20' },
    { bound: '0.05', points: 15, result: '+0.05 to +0.20' },
    { bound: '-0.05', points: 0, result: '-0.05 to +0.05' },
    { bound: '-0.20', points: -15, result: '-0.20 to -0.05' },
    { bound: null, points: -30, result: '< -0.20' },
  ]),
} as const;

/** G2 volatility, on the coefficient of variation of revenue over the trailing six periods. */
export const G2_PERIODS = 6;
export const G2_LOW_CV = '0.15';
export const G2_HIGH_CV = '0.40';
export const G2_LOW_POINTS = 10;
export const G2_HIGH_POINTS = -10;
/** G3 concentration drag. */
export const G3_TOP1_THRESHOLD = '0.50';
export const G3_POINTS = -10;

export const COST_CONTROL_RULES = {
  K1: lower('K1', 'Operating expenses against revenue', [
    { bound: '0.60', points: 20, result: '<= 0.60' },
    { bound: '0.85', points: 5, result: '0.60 to 0.85' },
    { bound: '1.0', points: -10, result: '0.85 to 1.0' },
    { bound: null, points: -25, result: '> 1.0' },
  ]),
  K2: lower('K2', 'Cost growth against revenue growth', [
    { bound: '0', points: 15, result: '<= 0' },
    { bound: '0.10', points: 0, result: '0 to +0.10' },
    { bound: null, points: -15, result: '> +0.10' },
  ]),
  K3: lower('K3', 'Categories with a spending spike', [
    { bound: '0', points: 10, result: '0' },
    { bound: '2', points: -5, result: '1-2' },
    { bound: null, points: -15, result: '>= 3' },
  ]),
} as const;

export const CUSTOMER_QUALITY_RULES = {
  Q1: lower('Q1', 'Largest customer share of revenue', [
    { bound: '0.20', points: 25, result: '<= 0.20' },
    { bound: '0.35', points: 10, result: '0.20 to 0.35' },
    { bound: '0.50', points: -10, result: '0.35 to 0.50' },
    { bound: null, points: -25, result: '> 0.50' },
  ]),
  Q2: lower('Q2', 'Top five customer share of revenue', [
    { bound: '0.60', points: 10, result: '<= 0.60' },
    { bound: '0.85', points: 0, result: '0.60 to 0.85' },
    { bound: null, points: -10, result: '> 0.85' },
  ]),
  Q3: lower('Q3', 'Days to get paid', [
    { bound: '30', points: 15, result: '<= 30 days' },
    { bound: '60', points: 0, result: '30 to 60 days' },
    { bound: '90', points: -10, result: '60 to 90 days' },
    { bound: null, points: -20, result: '> 90 days' },
  ]),
} as const;

export const BANKING_HEALTH_RULES = {
  B2: higher('B2', 'Money in against money out', [
    { bound: '1.1', points: 15, result: '>= 1.1' },
    { bound: '0.9', points: 0, result: '0.9 to 1.1' },
    { bound: null, points: -15, result: '< 0.9' },
  ]),
  B3: lower('B3', 'Banking anomalies detected', [
    { bound: '0', points: 10, result: '0' },
    { bound: '2', points: -5, result: '1-2' },
    { bound: null, points: -15, result: '>= 3' },
  ]),
} as const;

/** B1 balance trend over the last three periods. */
export const B1_PERIODS = 3;
export const B1_RISING_POINTS = 15;
export const B1_FALLING_POINTS = -15;
/** B4 bank coverage. */
export const B4_FULL_POINTS = 10;
export const B4_PARTIAL_POINTS = -5;
