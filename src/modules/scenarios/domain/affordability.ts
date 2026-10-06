import { Decimal, ROUND_HALF_UP, parseDecimalOrNull, toMoneyString } from '@/core/money';
import { composeFromLevels, type HorizonPeriod, type LeafLevels } from '@/modules/forecast';
import { MAX_AMOUNT } from './config';
import type { ScenarioBasis } from './types';

/**
 * "Can the business afford a proposed expenditure?" (SOW §12; ADR-146).
 *
 * A cash question, answered the way a what-if is: the expenditure is a delta on the forecast's
 * `cash_outflows` leaf, and BOTH columns — cash as expected, and cash after the expenditure — are
 * composed by `composeFromLevels`, the forecast's own function, from the same real opening balance.
 * Nothing here is a second way of working cash out.
 *
 * `affordability.v1`, declared once:
 *
 *   - **The buffer** is one month of the forecast's own money out (`cash_outflows`). It is the
 *     smallest cushion that still says "a normal month could be paid for after this"; it is not
 *     advice about how much cash a business should hold.
 *   - **Affordable**: the lowest closing cash over the horizon, after the expenditure, is at least
 *     the buffer. **Tight**: it stays at or above zero but dips below the buffer. **Not affordable**:
 *     it goes below zero in some month.
 *   - The same rule is applied to the expected cash WITHOUT the expenditure, so a reader can see
 *     when cash is already tight before anything is spent.
 *   - It looks only as far as the forecast does. A monthly cost is counted in every month of the
 *     horizon from its start; nothing beyond the horizon is assumed.
 *   - It is about cash only. Whether the spend is a running cost or an asset in the accounts, and
 *     what it would do to profit, is not assessed — the What-if page does profit.
 *
 * A missing input is a refusal with its reason, never a zero (§7 of the scenario design).
 *
 * Pure: no clock, no I/O.
 */

export const AFFORDABILITY_METHOD = 'affordability.v1';
export const AFFORDABILITY_BUFFER_MONTHS = 1;

export const RECURRENCES = ['one_off', 'monthly'] as const;
export type Recurrence = (typeof RECURRENCES)[number];

export type AffordabilityVerdict = 'affordable' | 'tight' | 'not_affordable';

export const AFFORDABILITY_UNAVAILABLE = [
  'no_forecast',
  /** The forecast could not state closing cash: no bank balance to start from, or no money out. */
  'no_cash_forecast',
  'starts_after_horizon',
  'invalid_amount',
] as const;
export type AffordabilityUnavailable = (typeof AFFORDABILITY_UNAVAILABLE)[number];

export interface AffordabilityMonth {
  readonly periodId: string;
  readonly periodLabel: string;
  /** Closing cash as the forecast expects it. */
  readonly expectedCash: string;
  /** Closing cash after the expenditure. */
  readonly cashAfter: string;
}

export interface AffordabilityResult {
  readonly method: typeof AFFORDABILITY_METHOD;
  readonly amount: string;
  readonly recurrence: Recurrence;
  readonly startsInMonth: number;
  readonly unavailable: AffordabilityUnavailable | null;
  readonly verdict: AffordabilityVerdict | null;
  /** The same rule, applied to cash as expected without the expenditure. */
  readonly verdictWithout: AffordabilityVerdict | null;
  readonly months: readonly AffordabilityMonth[];
  /** What the expenditure takes out of cash over the horizon in total. */
  readonly totalSpent: string | null;
  readonly lowest: { readonly periodLabel: string; readonly cashAfter: string } | null;
  readonly lowestWithout: { readonly periodLabel: string; readonly expectedCash: string } | null;
  /** One month of the forecast's money out. */
  readonly buffer: string | null;
  /** Lowest cash after the expenditure, less the buffer. Negative means below the buffer. */
  readonly headroom: string | null;
}

export interface AffordabilityInput {
  readonly amount: string;
  readonly recurrence: Recurrence;
  readonly startsInMonth: number;
  readonly basis: ScenarioBasis;
  readonly horizon: readonly HorizonPeriod[];
}

const ZERO = new Decimal(0);
const money = (value: Decimal): string => toMoneyString(value.toDecimalPlaces(2, ROUND_HALF_UP));

function verdictOf(lowest: Decimal, buffer: Decimal): AffordabilityVerdict {
  if (lowest.lessThan(0)) return 'not_affordable';
  return lowest.lessThan(buffer) ? 'tight' : 'affordable';
}

export function assessAffordability(input: AffordabilityInput): AffordabilityResult {
  const empty = (unavailable: AffordabilityUnavailable): AffordabilityResult => ({
    method: AFFORDABILITY_METHOD, amount: input.amount, recurrence: input.recurrence,
    startsInMonth: input.startsInMonth, unavailable, verdict: null, verdictWithout: null, months: [],
    totalSpent: null, lowest: null, lowestWithout: null, buffer: null, headroom: null,
  });

  // The form is checked first: `parseDecimalOrNull` throws on text that is not a number at all.
  const amount = /^-?\d{1,13}(\.\d{1,2})?$/.test(input.amount.trim()) ? parseDecimalOrNull(input.amount.trim()) : null;
  if (amount === null || !amount.greaterThan(0) || amount.greaterThan(MAX_AMOUNT)) return empty('invalid_amount');
  if (input.horizon.length === 0) return empty('no_forecast');
  if (!Number.isInteger(input.startsInMonth) || input.startsInMonth < 1 || input.startsInMonth > input.horizon.length) {
    return empty('starts_after_horizon');
  }
  const outflows = input.basis.leafLevels.cash_outflows;
  if (outflows === undefined || outflows === null || input.basis.lastActualClosingCash === null) {
    return empty('no_cash_forecast');
  }

  const flat: Record<string, string | null> = { ...input.basis.leafLevels };
  const appliesIn = (month: number): boolean =>
    input.recurrence === 'one_off' ? month === input.startsInMonth : month >= input.startsInMonth;
  const levelsAt = (index: number): LeafLevels => {
    if (!appliesIn(index + 1)) return flat;
    return { ...flat, cash_outflows: money(new Decimal(outflows).plus(amount)) };
  };

  const closing = (points: ReturnType<typeof composeFromLevels>) =>
    new Map(points.filter((p) => p.metricKey === 'closing_cash').map((p) => [p.periodId, p.value]));
  const expected = closing(composeFromLevels({ horizon: input.horizon, levelsAt: () => flat, lastActualClosingCash: input.basis.lastActualClosingCash }));
  const after = closing(composeFromLevels({ horizon: input.horizon, levelsAt, lastActualClosingCash: input.basis.lastActualClosingCash }));

  const months: AffordabilityMonth[] = [];
  for (const period of input.horizon) {
    const e = expected.get(period.periodId);
    const a = after.get(period.periodId);
    if (e === undefined || a === undefined) return empty('no_cash_forecast');
    months.push({ periodId: period.periodId, periodLabel: period.periodLabel, expectedCash: e, cashAfter: a });
  }

  // The first month in horizon order wins a tie, so the same input always names the same month.
  const lowestOf = (pick: (m: AffordabilityMonth) => string) => months.reduce((low, m) =>
    new Decimal(pick(m)).lessThan(new Decimal(pick(low))) ? m : low);
  const low = lowestOf((m) => m.cashAfter);
  const lowWithout = lowestOf((m) => m.expectedCash);
  const buffer = new Decimal(outflows).times(AFFORDABILITY_BUFFER_MONTHS);
  const applied = input.horizon.filter((_, i) => appliesIn(i + 1)).length;

  return {
    method: AFFORDABILITY_METHOD,
    amount: money(amount),
    recurrence: input.recurrence,
    startsInMonth: input.startsInMonth,
    unavailable: null,
    verdict: verdictOf(new Decimal(low.cashAfter), buffer.lessThan(0) ? ZERO : buffer),
    verdictWithout: verdictOf(new Decimal(lowWithout.expectedCash), buffer.lessThan(0) ? ZERO : buffer),
    months,
    totalSpent: money(amount.times(applied)),
    lowest: { periodLabel: low.periodLabel, cashAfter: low.cashAfter },
    lowestWithout: { periodLabel: lowWithout.periodLabel, expectedCash: lowWithout.expectedCash },
    buffer: money(buffer),
    headroom: money(new Decimal(low.cashAfter).minus(buffer)),
  };
}

/**
 * The amount as the person wrote it, parsed — or NULL when it is not unambiguously an amount.
 *
 * Accepted: an optional currency symbol or code, digits with optional comma thousands separators
 * in groups of three, an optional two-place decimal part, and an optional `k` (thousand) or `m`
 * (million) suffix. `1,50`, `1.234,56`, ranges and words are refused rather than guessed (the
 * scenario form's rule 1: nothing bad becomes a figure).
 */
export function parseWrittenAmount(written: string): string | null {
  const match = /^\s*(?:[£$€₹]|AED|GBP|USD|EUR|INR)?\s*(\d{1,3}(?:,\d{3})+|\d+)(\.\d{1,2})?\s*(k|m|thousand|million)?\s*$/i.exec(written);
  if (match === null) return null;
  const whole = match[1]!.replace(/,/g, '');
  const value = new Decimal(`${whole}${match[2] ?? ''}`);
  const suffix = (match[3] ?? '').toLowerCase();
  const scaled = suffix === 'k' || suffix === 'thousand' ? value.times(1000)
    : suffix === 'm' || suffix === 'million' ? value.times(1_000_000) : value;
  return money(scaled);
}

/** Whether `written` appears in the question, ignoring case and runs of spaces. */
export function writtenInQuestion(written: string, question: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const needle = norm(written);
  return needle.length > 0 && norm(question).includes(needle);
}

/** The words the page uses; the analyst uses the tool's own fields. */
export const AFFORDABILITY_VERDICT_LABEL: Readonly<Record<AffordabilityVerdict, string>> = {
  affordable: 'Affordable',
  tight: 'Tight',
  not_affordable: 'Not affordable',
};

export const AFFORDABILITY_VERDICT_TEXT: Readonly<Record<AffordabilityVerdict, string>> = {
  affordable: 'Cash stays above one month of normal money out in every forecast month.',
  tight: 'Cash stays at or above zero, but dips below one month of normal money out.',
  not_affordable: 'Cash goes below zero in at least one forecast month.',
};

export const AFFORDABILITY_UNAVAILABLE_TEXT: Readonly<Record<AffordabilityUnavailable, string>> = {
  no_forecast: 'There is no forecast to check against yet.',
  no_cash_forecast: 'The forecast cannot state closing cash for the months ahead — there is no bank balance to start from, or no money out to forecast — so this cannot be checked.',
  starts_after_horizon: 'That month is beyond the months the forecast covers.',
  invalid_amount: 'Enter an amount more than zero and less than a billion, for example 25000 or 25,000.',
};

export const AFFORDABILITY_RULE_TEXT =
  'This is about cash only, over the forecast months, against the forecast MOTION already holds. It does not look at profit, at how the spend is treated in the accounts, or beyond the last forecast month, and it is not financial advice.';
