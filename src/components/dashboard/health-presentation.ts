import type { BadgeTone } from '@/components/ui/surfaces';
import { tryParseDecimal } from '@/core/money';
import { isMetricKey, metricDefinition } from '@/modules/financial-engine';
import { METRIC_LABELS, labelFor } from '@/modules/financials';
import {
  BANDS, HEALTH_DISCLAIMER, PROXY_CAP_NOTE, bandLabel,
  type DimensionBreakdown, type ExclusionReason, type HealthBand, type HealthDimensionKey,
  type MetricReference,
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
 * Plain-language names for the eight dimensions.
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
  marketing_efficiency: 'Marketing',
  funding_readiness: 'Funding readiness',
};

/** What each dimension is measuring, for the "what is this?" line in the panel. */
export const DIMENSION_DESCRIPTIONS: Readonly<Record<HealthDimensionKey, string>> = {
  profitability: 'How much of your sales you keep, and which way your margins are moving.',
  cash_flow: 'How much cash you hold, how long it would last, and which way it is going.',
  revenue_growth: 'How your sales compare with last year, and how steady they are.',
  cost_control: 'How your costs compare with your sales, and whether any category jumped.',
  customer_quality: 'How spread your sales are across customers, and how fast they pay.',
  banking_health: 'What your bank statements show about your balance and anything unusual in them.',
  marketing_efficiency: 'What your recorded campaigns cost, against the sales from the customers they won.',
  funding_readiness: 'What you owe and which way it is moving, how much of what is owed is overdue, and how complete recent months are.',
};

/** §7.2 requires an excluded dimension to say why. These are those reasons, in plain words. */
export const EXCLUSION_TEXT: Readonly<Record<ExclusionReason, string>> = {
  required_metric_missing: 'Not scored — we do not have the figures this needs yet.',
  insufficient_completeness: 'Not scored — we can see too little of this month to judge it.',
  no_bank_coverage: 'Not scored — no bank statement covers this month.',
  no_campaign_data: 'Not scored — no campaign spend is recorded for the last three months.',
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
  M1: 'Sales from customers campaigns won, against campaign spend',
  M2: 'Cost of each customer won, against the three months before',
  R1: 'Debt against a year of operating profit',
  R2: 'Debt over three months',
  R3: 'Overdue share of what customers owe',
  R4: 'Overdue share of what you owe suppliers',
  R5: 'Months with complete figures, of the last six',
};

/**
 * A rule's result, in words (presentation only — the band itself is the engine's).
 *
 * The config states a band the way the rule compares it: "0.20 to 0.35", "> 0.85", ">= 1.1". A
 * business owner reads a share as a percentage and an operator as a word, so the panel prints "20%
 * to 35%", "more than 85%" and "at least 1.1×". Nothing here changes which band a value fell in.
 *
 * `percent` rules compare a share, a margin or a growth rate; `times` a multiple; `count` a number of
 * things. A result this does not recognise is printed as it is, rather than guessed at.
 */
const RESULT_SCALE: Readonly<Record<string, 'percent' | 'times' | 'count'>> = {
  P1: 'percent', P2: 'percent', P4: 'percent',
  G1: 'percent', G2: 'percent', G3: 'percent',
  K1: 'percent', Q1: 'percent', Q2: 'percent',
  B2: 'times', C4: 'times', M1: 'times', R1: 'times',
  K3: 'count', B3: 'count', R5: 'count',
};

/** Results that read better rewritten whole than translated piece by piece. */
const RESULT_PHRASES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  // P3 and K2 compare two percentages, so their difference is in percentage points, not per cent.
  P3: {
    '>= +0.02': 'up 2 percentage points or more',
    'between -0.02 and +0.02': 'within 2 percentage points',
    '<= -0.02': 'down 2 percentage points or more',
  },
  K2: {
    '<= 0': 'costs grew no faster than sales',
    '0 to +0.10': 'costs grew up to 10 points faster than sales',
    '> +0.10': 'costs grew more than 10 points faster than sales',
  },
  C1: { '> 0': 'above zero', '<= 0': 'zero or below' },
  C2: { 'cash generative': 'cash is growing, so it is not running down' },
  B4: { full: 'all of it', partial: 'only part of it' },
  K3: { '0': 'none' },
  B3: { '0': 'none' },
  R5: { '6': 'all 6' },
};

const OPERATOR_WORDS: Readonly<Record<string, string>> = {
  '>=': 'at least', '>': 'more than', '<=': 'at most', '<': 'less than',
};

/** "0.20" → "20%", "+0.05" → "+5%", "-0.05" → "−5%"; anything that is not a number is left alone. */
function scaledNumber(token: string, scale: 'percent' | 'times' | 'count' | undefined): string {
  if (scale === 'percent') {
    const parsed = tryParseDecimal(token);
    if (parsed === null) return token;
    const value = parsed.abs().times(100).toDecimalPlaces(1).toString();
    const sign = parsed.isNegative() ? '−' : token.startsWith('+') ? '+' : '';
    return `${sign}${value}%`;
  }
  if (scale === 'times') return token.replace(/^([0-9.]+)x?$/, '$1×');
  return token.replace(/^-/, '−');
}

/** G2 measures how much sales vary month to month, so its percentage needs saying what of. */
const RESULT_PREFIX: Readonly<Record<string, string>> = { G2: 'sales vary by ' };

export function resultText(rule: string, result: string): string {
  const phrase = RESULT_PHRASES[rule]?.[result];
  if (phrase !== undefined) return phrase;
  // C3 counts months whose net cash movement was positive: "positive in 2 of 3".
  const months = /^positive in (\d+) of (\d+)$/.exec(result);
  if (rule === 'C3' && months) return `cash grew in ${months[1]} of the last ${months[2]} months`;
  if (rule === 'C3' && /^negative in all (\d+)$/.test(result)) {
    return `cash fell in each of the last ${result.replace(/^negative in all /, '')} months`;
  }

  const scale = RESULT_SCALE[rule];
  const n = (token: string) => scaledNumber(token, scale);
  let text = result;
  const compared = /^(>=|<=|>|<)\s*(\S+)(.*)$/.exec(result);
  const between = /^between (\S+) and (\S+)$/.exec(result);
  const range = /^(\S+) to (\S+)(.*)$/.exec(result);
  const counted = /^(\d+)-(\d+)$/.exec(result);
  if (compared) text = `${OPERATOR_WORDS[compared[1]!]} ${n(compared[2]!)}${compared[3]}`;
  else if (between) text = `between ${n(between[1]!)} and ${n(between[2]!)}`;
  else if (range) text = `${n(range[1]!)} to ${n(range[2]!)}${range[3]}`;
  else if (counted && scale === 'count') text = `${counted[1]} to ${counted[2]}`;
  // "above 4.0x" and the like: the multiplication sign, wherever a multiple is written.
  if (scale === 'times') text = text.replace(/(\d)x\b/g, '$1×');
  return `${RESULT_PREFIX[rule] ?? ''}${text}`;
}

/**
 * The name of a figure a dimension rested on, never its key.
 *
 * The plain §8.1 label when there is one; otherwise the engine's own definition label; and for a
 * composed variance key ("net_profit.variance.prev_period"), the figure's name and what it was
 * compared with. Only a key the engine does not know at all falls back to its words.
 */
const VARIANCE_COMPARISONS: Readonly<Record<string, string>> = {
  prev_period: 'change on last month',
  trailing_3m_avg: 'change on the 3-month average',
  same_period_last_year: 'change on the same month last year',
};

function baseFigureLabel(key: string): string {
  const plain = METRIC_LABELS[key]?.plain;
  if (plain !== undefined) return plain;
  if (isMetricKey(key)) return metricDefinition(key).label;
  return labelFor(key).plain;
}

export function figureLabel(key: string): string {
  const variance = /^(.+)\.variance\.([a-z0-9_]+)$/.exec(key);
  if (variance) {
    return `${baseFigureLabel(variance[1]!)} — ${VARIANCE_COMPARISONS[variance[2]!] ?? 'change'}`;
  }
  return baseFigureLabel(key);
}

/**
 * The pinned figures, one entry per figure name.
 *
 * A dimension can rest on the same figure several times — Marketing reads "sales from this
 * customer" once per customer and month — and five identical links side by side told a reader
 * nothing. They are listed once, with a numbered link to each; the evidence each opens names its
 * month and customer.
 */
export function figureGroups(
  metrics: readonly MetricReference[],
): readonly { readonly label: string; readonly snapshotIds: readonly string[] }[] {
  const groups = new Map<string, string[]>();
  for (const metric of metrics) {
    if (metric.snapshot_id === null) continue;
    const label = figureLabel(metric.metric_key);
    const ids = groups.get(label) ?? [];
    if (!ids.includes(metric.snapshot_id)) ids.push(metric.snapshot_id);
    groups.set(label, ids);
  }
  return [...groups].map(([label, snapshotIds]) => ({ label, snapshotIds }));
}

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
  capacity_unavailable: 'There are not twelve complete months of operating profit to compare debt with.',
  no_prior_debt: 'We do not know what was owed three months earlier.',
  aging_unavailable: 'We cannot tell how much of it is overdue.',
  no_customers_won: 'Campaigns spent money but won no customers in these months.',
  no_prior_window: 'There is no cost per customer for the three months before to compare with.',
};

export function skipText(reason: string | null): string | null {
  if (reason === null) return null;
  return SKIP_TEXT[reason] ?? 'This check could not run on this month’s data.';
}

/** §Level 1: "based on N of 8 areas" (health.config.v5), shown only when something is missing. */
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
  up: 'text-good',
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
export function capNote(dimension: Pick<DimensionBreakdown, 'capped' | 'cap_reason'> & { readonly score?: number | null }): string | null {
  if (!dimension.capped) return null;
  // H-4: `capped` means the cap APPLIES; it bound only when the dimension would have scored more.
  // "Capped at 70" beside a 65 told the reader the score had been cut when it had not.
  if (typeof dimension.score === 'number' && dimension.score < 70) {
    return `Can score at most 70 — ${dimension.cap_reason ?? PROXY_CAP_NOTE}.`;
  }
  return `Capped at 70 — ${dimension.cap_reason ?? PROXY_CAP_NOTE}.`;
}

/**
 * The lobby's score ring (ADR-176): the stroke's dash for a score out of 100 on a circle of this
 * radius. Pixel geometry only — the score itself is the engine's.
 */
export function scoreRingDash(score: number, radius: number): { readonly dash: string; readonly circumference: number } {
  const circumference = 2 * Math.PI * radius;
  const filled = (Math.min(100, Math.max(0, score)) / 100) * circumference;
  return { dash: `${filled.toFixed(2)} ${circumference.toFixed(2)}`, circumference };
}
