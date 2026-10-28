import type { BandedRule, ScoreBand } from '@/modules/health';

/**
 * Funding Readiness, rules `funding_readiness.v1` (PHASE_16_IMPLEMENTATION.md §4–§6; D-7, D-16–D-18;
 * A-1…A-5 confirmed 2026-10-06, ADR-140). Every number here is an APPROVED threshold; the banded
 * shape and the band semantics are Health's own (`BandedRule`, `bandOf`), reused unchanged (K-7).
 */

export const FUNDING_RULES_VERSION = 'funding_readiness.v1';

export type FactorKey = 'F1' | 'F2' | 'F3' | 'F4' | 'F5' | 'F6' | 'F7';
export const FACTOR_KEYS: readonly FactorKey[] = ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7'];
export const SUBSTANTIVE: readonly FactorKey[] = ['F1', 'F2', 'F3', 'F4', 'F5', 'F6'];

/** D-7: 20 / 20 / 15 / 15 / 10 / 10 / 10. */
export const FACTOR_WEIGHTS: Readonly<Record<FactorKey, number>> = {
  F1: 20, F2: 20, F3: 15, F4: 15, F5: 10, F6: 10, F7: 10,
};

/** Each area's name, for a reader with no accounting training (presentation only). */
export const FACTOR_NAMES: Readonly<Record<FactorKey, string>> = {
  F1: 'Sales and profit',
  F2: 'Cash flow',
  F3: 'How your bank account is run',
  F4: 'Existing debt',
  F5: 'Money owed to you and by you',
  F6: 'Financial consistency',
  F7: 'Data completeness',
};

/** §4.2 */
export const FACTOR_BASELINE = 50;
/** §4.6 (b), EXISTING */
export const MIN_COMPLETENESS = 0.6;
/** §4.7, EXISTING ADR-035 (and, with D-2, AI-read figures) */
export const PROXY_CAP = 70;
/** §6.1 */
export const SUBSTANTIVE_WEIGHT_TOTAL = 90;
export const GATE_MIN_WEIGHT = 72;
export const GATE_MIN_FACTORS = 5;

/** What the page and the report say in place of a score when there is not enough to score (§6.1). */
export const NOT_SCORED_LABEL = 'Not enough data to score yet';

/** §6.4 — presentation only; never a lender classification. */
export const READINESS_BANDS: ReadonlyArray<{ readonly min: number; readonly label: string }> = [
  { min: 90, label: 'High indicative readiness' },
  { min: 75, label: 'Strong indicative readiness' },
  { min: 60, label: 'Moderate indicative readiness' },
  { min: 40, label: 'Developing indicative readiness' },
  { min: 0, label: 'Low indicative readiness' },
];

export function readinessBand(score: number | null): string | null {
  if (score === null) return null;
  return READINESS_BANDS.find((b) => score >= b.min)?.label ?? 'Low indicative readiness';
}

/** §6.5, U-6 — word for word. */
export const FUNDING_DISCLAIMER =
  'Funding Readiness is an indicative financial-readiness assessment based on the data available in this '
  + 'organisation. It is not a lender, credit, investment or funding approval rating. Missing or incomplete '
  + 'information can reduce the assessment’s coverage and reliability.';

const higher = (rule: string, description: string, bands: readonly ScoreBand[]): BandedRule =>
  ({ rule, description, direction: 'higher_is_better', bands });
const lower = (rule: string, description: string, bands: readonly ScoreBand[]): BandedRule =>
  ({ rule, description, direction: 'lower_is_better', bands });

/** The banded rules (§5). Each ends in a catch-all band, as `bandOf` requires. */
export const RULES = {
  'F1.1': higher('F1.1', 'Margin after interest and tax', [
    { bound: '0.15', points: 30, result: '>= 15%' },
    { bound: '0.05', points: 15, result: '5% to 15%' },
    { bound: '0', points: 0, result: '0% to 5%' },
    { bound: null, points: -30, result: 'below 0%' },
  ]),
  'F1.2': higher('F1.2', 'Sales growth', [
    { bound: '0.20', points: 30, result: '>= 20%' },
    { bound: '0.05', points: 15, result: '5% to 20%' },
    { bound: '-0.05', points: 0, result: '-5% to 5%' },
    { bound: '-0.20', points: -15, result: '-20% to -5%' },
    { bound: null, points: -30, result: 'below -20%' },
  ]),
  'F1.3': higher('F1.3', 'Margin after direct costs', [
    { bound: '0.50', points: 10, result: '>= 50%' },
    { bound: '0.30', points: 5, result: '30% to 50%' },
    { bound: '0.20', points: 0, result: '20% to 30%' },
    { bound: null, points: -10, result: 'below 20%' },
  ]),
  'F2.2': higher('F2.2', 'Months of cash', [
    { bound: '6', points: 20, result: '>= 6 months' },
    { bound: '3', points: 5, result: '3 to 6 months' },
    { bound: '1', points: -15, result: '1 to 3 months' },
    { bound: null, points: -30, result: 'below 1 month' },
  ]),
  'F2.4': higher('F2.4', 'Cash against a month of spending', [
    { bound: '2', points: 5, result: '>= 2x' },
    { bound: '0.5', points: 0, result: '0.5x to 2x' },
    { bound: null, points: -10, result: 'below 0.5x' },
  ]),
  'F3.1': higher('F3.1', 'Money in against money out', [
    { bound: '1.1', points: 15, result: '>= 1.1' },
    { bound: '0.9', points: 0, result: '0.9 to 1.1' },
    { bound: null, points: -15, result: 'below 0.9' },
  ]),
  'F4.1': lower('F4.1', 'Borrowing against a year of profit', [
    { bound: '1.0', points: 25, result: '<= 1.0x' },
    { bound: '2.0', points: 10, result: '1.0x to 2.0x' },
    { bound: '3.0', points: 0, result: '2.0x to 3.0x' },
    { bound: '4.0', points: -15, result: '3.0x to 4.0x' },
    { bound: null, points: -30, result: 'above 4.0x' },
  ]),
  'F4.2': lower('F4.2', 'Change in borrowing over three months', [
    { bound: '-0.10', points: 10, result: 'down 10% or more' },
    { bound: '0.10', exclusive: true, points: 0, result: 'within 10%' },
    { bound: null, points: -10, result: 'up 10% or more' },
  ]),
  'F5.1': lower('F5.1', 'Days to get paid', [
    { bound: '30', points: 15, result: '<= 30 days' },
    { bound: '60', points: 0, result: '30 to 60 days' },
    { bound: '90', points: -10, result: '60 to 90 days' },
    { bound: null, points: -20, result: 'above 90 days' },
  ]),
  'F5.2': lower('F5.2', 'Share of what customers owe that is overdue', [
    { bound: '0.30', exclusive: true, points: 10, result: 'below 30%' },
    { bound: '0.50', exclusive: true, points: -10, result: '30% to 50%' },
    { bound: null, points: -20, result: '50% or more' },
  ]),
  'F5.3': lower('F5.3', 'Share of what you owe suppliers that is overdue', [
    { bound: '0.30', exclusive: true, points: 10, result: 'below 30%' },
    { bound: '0.50', exclusive: true, points: -10, result: '30% to 50%' },
    { bound: null, points: -20, result: '50% or more' },
  ]),
  'F6.2': lower('F6.2', 'How steady sales are', [
    { bound: '0.15', points: 10, result: 'steady' },
    { bound: '0.40', exclusive: true, points: 0, result: 'variable' },
    { bound: null, points: -10, result: 'volatile' },
  ]),
  'F7.1': higher('F7.1', 'How complete the scored figures are', [
    { bound: '0.95', points: 20, result: '>= 95%' },
    { bound: '0.80', points: 5, result: '80% to 95%' },
    { bound: null, points: -10, result: 'below 80%' },
  ]),
} as const satisfies Readonly<Record<string, BandedRule>>;

/**
 * The plain name of each flat rule (one fixed result, not a band), for a reader with no accounting
 * training. The banded rules carry theirs in `RULES`; presentation only, never scoring.
 */
export const FLAT_RULE_DESCRIPTIONS: Readonly<Record<string, string>> = {
  'F2.1': 'Cash at the month end',
  'F2.3': 'Months with more money in than out, of the last three',
  'F3.2': 'Unusual bank patterns',
  'F3.3': 'How much of the month bank statements cover',
  'F3.4': 'Bank statements matching their balances',
  'F3.5': 'Previous five months covered by statements',
  'F6.1': 'Months with complete figures, of the last six',
  'F6.3': 'Profitable months, of the last six',
  'F7.2': 'Profit figure',
  'F7.3': 'Data-quality warnings on the scored figures',
};

/** Any rule's plain name, banded or flat; the code itself only for a rule with no name. */
export function ruleDescription(rule: string): string {
  return (RULES as Readonly<Record<string, BandedRule>>)[rule]?.description ?? FLAT_RULE_DESCRIPTIONS[rule] ?? rule;
}

/** A-2: cash-family metrics, whose completeness IS bank coverage (scored by F3.3). */
export const CASH_FAMILY = new Set([
  'opening_cash', 'closing_cash', 'net_cash_movement', 'cash_inflows', 'cash_outflows', 'cash_runway_months',
]);

/** W7 (§5.7): the warnings F7.3 counts. */
export const W7_WARNINGS = new Set([
  'statement_balance_mismatch', 'unpaired_transfer_candidate', 'no_due_dates', 'payment_date_unknown',
  'high_unattributed_share', 'vat_inclusive',
]);
