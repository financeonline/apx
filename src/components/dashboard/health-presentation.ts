import type { BadgeTone } from '@/components/ui/surfaces';
import {
  BANDS, HEALTH_DISCLAIMER, PROXY_CAP_NOTE, bandLabel,
  type DimensionBreakdown, type ExclusionReason, type HealthBand, type HealthDimensionKey,
} from '@/modules/health';

/**
 * Everything about presenting a health score that is a decision rather than markup
 * (UX_ARCHITECTURE.md §Level 1, §8.3, DESIGN.md).
 *
 * Pure, so the wording and the colour semantics can be asserted without a DOM — including the one
 * that matters most: red, amber and green mean a band and nothing else here, and no dimension,
 * rule or note may borrow them decoratively (§4 "colour semantics").
 */

export { HEALTH_DISCLAIMER, PROXY_CAP_NOTE };

/** §7.2's four bands, in the reader's language rather than the config's. */
export const BAND_TONES: Readonly<Record<HealthBand, BadgeTone>> = {
  at_risk: 'danger',
  needs_attention: 'warn',
  stable: 'neutral',
  strong: 'accent',
};

export function bandTone(band: HealthBand | null): BadgeTone {
  return band === null ? 'neutral' : BAND_TONES[band];
}

export function bandText(band: HealthBand | null): string | null {
  return bandLabel(band);
}

/** The band scale, for the legend under the card. */
export const BAND_SCALE = BANDS.map((b) => ({ band: b.band, label: b.label, min: b.min }));

/**
 * Plain-language names for the six dimensions.
 *
 * "Cost control" and "customer quality" are the config's words; these are the words a business owner
 * uses. The panel is meant to be readable by the person whose business it describes, not only by
 * the accountant who reads the config.
 */
export const DIMENSION_LABELS: Readonly<Record<HealthDimensionKey, string>> = {
  profitability: 'Profitability',
  cash_flow: 'Cash',
  revenue_growth: 'Sales growth',
  cost_control: 'Costs',
  customer_quality: 'Customers',
  banking_health: 'Banking',
};

/** What each dimension is measuring, for the "what is this?" line in the panel. */
export const DIMENSION_DESCRIPTIONS: Readonly<Record<HealthDimensionKey, string>> = {
  profitability: 'How much of your sales you keep, and which way your margins are moving.',
  cash_flow: 'How much cash you hold, how long it would last, and which way it is going.',
  revenue_growth: 'How your sales compare with last year, and how steady they are.',
  cost_control: 'How your costs compare with your sales, and whether any category jumped.',
  customer_quality: 'How spread your sales are across customers, and how fast they pay.',
  banking_health: 'What your bank statements show about your balance and anything unusual in them.',
};

/** §7.2 requires an excluded dimension to say why. These are those reasons, in plain words. */
export const EXCLUSION_TEXT: Readonly<Record<ExclusionReason, string>> = {
  required_metric_missing: 'Not scored — we do not have the figures this needs yet.',
  insufficient_completeness: 'Not scored — we can see too little of this month to judge it.',
  no_bank_coverage: 'Not scored — no bank statement covers this month.',
};

/**
 * What each rule looked at.
 *
 * Every rule in §7.3 appears here, including the five that are not banded, because the panel has to
 * explain the arithmetic line by line — "P3 +10" tells a reader nothing.
 */
export const RULE_LABELS: Readonly<Record<string, string>> = {
  P1: 'Net margin',
  P2: 'Gross margin',
  P3: 'Margin trend against the 3-month average',
  P4: 'Profit against last month',
  C1: 'Cash balance',
  C2: 'How long cash would last',
  C3: 'Cash direction over three months',
  C4: 'Cash against a month of spending',
  G1: 'Sales growth',
  G2: 'How steady sales are',
  G3: 'Reliance on the largest customer',
  K1: 'Costs as a share of sales',
  K2: 'Cost growth against sales growth',
  K3: 'Categories where spending jumped',
  Q1: 'Largest customer share',
  Q2: 'Top five customer share',
  Q3: 'How long customers take to pay',
  B1: 'Bank balance over three months',
  B2: 'Money in against money out',
  B3: 'Unusual items in your bank data',
  B4: 'How much of your banking we can see',
};

/** Why a rule did not run. A skipped rule shows this instead of a score, never a silent zero. */
export const SKIP_TEXT: Readonly<Record<string, string>> = {
  value_unavailable: 'We do not have this figure for this month.',
  no_comparable_trend: 'There is no comparable three-month average.',
  no_comparable_prior_period: 'There is no comparable previous month.',
  no_comparable_period: 'There is no comparable earlier period.',
  runway_unavailable: 'We could not work out how long cash would last.',
  insufficient_history: 'There is not enough history yet.',
  no_outflows_to_compare: 'There was no spending to compare against.',
  no_revenue_to_compare: 'There were no sales to compare against.',
  no_counterparty_data: 'We do not have customer-level data for this month.',
  no_invoice_data: 'We do not have invoice data for this month.',
  no_bank_coverage: 'No bank statement covers this month.',
  no_record_data: 'We could not read the underlying transactions.',
  revenue_not_positive: 'Sales were not positive, so there is no ratio to take.',
  incomplete_period: 'This month is not complete yet.',
  low_completeness: 'We can see too little of this month to judge it.',
  first_period: 'This is your earliest month, so there is nothing to compare with.',
  suppressed: 'This check could not run on this month’s data.',
};

export function skipText(reason: string | null): string | null {
  if (reason === null) return null;
  return SKIP_TEXT[reason] ?? 'This check could not run on this month’s data.';
}

/** §Level 1: "based on N of 6 areas", shown only when something is missing. */
export function dimensionsNote(used: number, total: number): string | null {
  return used === total ? null : `Based on ${used} of ${total} areas`;
}

/**
 * The change line.
 *
 * A missing comparison says so rather than showing 0 — a score that did not move and a score with
 * nothing to move from are different facts, and only one of them is reassuring (§4).
 */
export function changeText(change: number | null, comparisonLabel: string | null): string {
  if (change === null) return 'no comparison yet';
  const sign = change > 0 ? '+' : change < 0 ? '−' : '';
  const magnitude = Math.abs(change);
  const body = change === 0 ? 'no change' : `${sign}${magnitude}`;
  return comparisonLabel === null ? body : `${body} vs ${comparisonLabel}`;
}

/** Favourable direction for the score: rising is good, so the tone follows the sign. */
export function changeTone(change: number | null): 'up' | 'down' | 'flat' | 'none' {
  if (change === null) return 'none';
  if (change > 0) return 'up';
  if (change < 0) return 'down';
  return 'flat';
}

export const CHANGE_TONE_CLASS: Readonly<Record<'up' | 'down' | 'flat' | 'none', string>> = {
  up: 'text-accent',
  down: 'text-danger',
  flat: 'text-ink-muted',
  none: 'text-ink-faint',
};

/** §7.2: fewer than three dimensions means no score, and the card says exactly that. */
export const NOT_ENOUGH_DATA_TITLE = 'Not enough data yet';
export const NOT_ENOUGH_DATA_BODY =
  'We need at least three areas of your finances before a score means anything. Add more data and it will appear here.';

/** The card for a month that was never scored, because it is not finished (ADR-030.4). */
export const NO_SCORE_FOR_PARTIAL_MONTH =
  'This month is not complete yet, so it has no score. The score below is for your latest complete month.';

/** Points, as the panel prints them: always signed, so the arithmetic reads as arithmetic. */
export function pointsText(points: number): string {
  if (points > 0) return `+${points}`;
  if (points < 0) return `−${Math.abs(points)}`;
  return '0';
}

/** The dimensions in the order the panel lists them: included first, worst score first. */
export function orderedDimensions(
  breakdown: readonly DimensionBreakdown[],
): readonly DimensionBreakdown[] {
  return [...breakdown].sort((a, b) => {
    if (a.included !== b.included) return a.included ? -1 : 1;
    if (!a.included) return 0;
    return (a.score ?? 0) - (b.score ?? 0);
  });
}


/**
 * The sentence under a capped dimension (ADR-134): the cap and its stored reason — bank data only,
 * figures an AI read from a PDF, or both. Null for a dimension that is not capped.
 */
export function capNote(dimension: Pick<DimensionBreakdown, 'capped' | 'cap_reason'>): string | null {
  if (!dimension.capped) return null;
  return `Capped at 70 — ${dimension.cap_reason ?? PROXY_CAP_NOTE}.`;
}
