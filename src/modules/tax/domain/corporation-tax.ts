import { Decimal } from '@/core/money';
import { addDays, addMonths, monthEnd, parseIsoDate, yearMonth, type IsoDate } from '@/core/periods';

/**
 * The indicative Corporation Tax estimate (ADR-156; owner decision 2026-10-07). Pure.
 *
 * On ACCOUNTING profit before tax — the profit MOTION calculated for the accounting period, with the
 * tax already booked added back. Taxable profit can differ (capital allowances instead of
 * depreciation, disallowed expenses, losses brought forward), so the estimate is indicative and says
 * so; it is not a tax computation.
 *
 * UK (GB), accounting periods starting on or after 1 April 2023:
 *   lower limit £50,000 and upper limit £250,000, each divided by (1 + associated companies) and
 *   reduced in proportion for a period shorter than a year (days / 365);
 *     profit ≤ lower  → 19% (small profits rate)
 *     profit ≥ upper  → 25% (main rate)
 *     in between      → 25% less marginal relief 3/200 × (upper − profit)
 *   due 9 months and 1 day after the period ends (not a large company paying by instalments).
 *
 * UAE (AE), tax periods starting on or after 1 June 2023:
 *   0% on the first AED 375,000, 9% above it; due 9 months after the period ends. Small Business
 *   Relief (revenue ≤ AED 3m) is an election the business makes, so it is noted, not applied.
 *
 * Elsewhere, or for an earlier period, no estimate is made.
 */

export type CtCountry = 'GB' | 'AE';

export type CorporationTaxEstimate =
  | {
      readonly kind: 'estimate';
      readonly country: CtCountry;
      readonly profitBeforeTax: string;
      readonly estimatedTax: string;
      /** The band the profit falls in, in words. */
      readonly band: string;
      /** Estimated tax ÷ profit, as a ratio string (e.g. "0.2125"), or null when there is no profit. */
      readonly effectiveRate: string | null;
      readonly thresholds: { readonly lower: string; readonly upper: string | null };
      readonly marginalRelief: string | null;
      readonly dueDate: IsoDate;
      readonly days: number;
    }
  | { readonly kind: 'not_estimated'; readonly reason: 'country' | 'period_before_rules' };

const two = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);

/** Calendar days from `start` to `end`, both included. */
export function daysInclusive(start: IsoDate, end: IsoDate): number {
  const a = Date.UTC(parseIsoDate(start).year, parseIsoDate(start).month - 1, parseIsoDate(start).day);
  const b = Date.UTC(parseIsoDate(end).year, parseIsoDate(end).month - 1, parseIsoDate(end).day);
  return Math.round((b - a) / 86_400_000) + 1;
}

/** The same day `months` later, clamped to the month's end (31 Dec + 9 months = 30 Sep). */
export function addMonthsToDate(date: IsoDate, months: number): IsoDate {
  const { year, month, day } = parseIsoDate(date);
  const target = addMonths(yearMonth(year, month), months);
  const last = parseIsoDate(monthEnd(target)).day;
  return `${target.year}-${String(target.month).padStart(2, '0')}-${String(Math.min(day, last)).padStart(2, '0')}`;
}

export function estimateCorporationTax(input: {
  readonly country: string | null;
  readonly periodStart: IsoDate;
  readonly periodEnd: IsoDate;
  readonly profitBeforeTax: string;
  readonly associatedCompanies: number;
}): CorporationTaxEstimate {
  const profit = new Decimal(input.profitBeforeTax);
  const days = daysInclusive(input.periodStart, input.periodEnd);
  const taxable = Decimal.max(profit, new Decimal(0));

  if (input.country === 'GB') {
    if (input.periodStart < '2023-04-01') return { kind: 'not_estimated', reason: 'period_before_rules' };
    const share = new Decimal(Math.min(days, 365)).dividedBy(365).dividedBy(1 + input.associatedCompanies);
    const lower = new Decimal(50_000).times(share);
    const upper = new Decimal(250_000).times(share);
    let tax: Decimal;
    let band: string;
    let relief: Decimal | null = null;
    if (taxable.lessThanOrEqualTo(lower)) {
      tax = taxable.times('0.19');
      band = taxable.isZero() ? 'No profit, no tax' : 'Small profits rate (19%)';
    } else if (taxable.greaterThanOrEqualTo(upper)) {
      tax = taxable.times('0.25');
      band = 'Main rate (25%)';
    } else {
      relief = upper.minus(taxable).times(3).dividedBy(200);
      tax = taxable.times('0.25').minus(relief);
      band = 'Main rate with marginal relief';
    }
    return {
      kind: 'estimate', country: 'GB', profitBeforeTax: two(profit), estimatedTax: two(tax), band,
      effectiveRate: taxable.isZero() ? null : tax.dividedBy(taxable).toDecimalPlaces(4).toString(),
      thresholds: { lower: two(lower), upper: two(upper) },
      marginalRelief: relief === null ? null : two(relief),
      dueDate: addDays(addMonthsToDate(input.periodEnd, 9), 1),
      days,
    };
  }

  if (input.country === 'AE') {
    if (input.periodStart < '2023-06-01') return { kind: 'not_estimated', reason: 'period_before_rules' };
    const threshold = new Decimal(375_000);
    const tax = Decimal.max(taxable.minus(threshold), new Decimal(0)).times('0.09');
    return {
      kind: 'estimate', country: 'AE', profitBeforeTax: two(profit), estimatedTax: two(tax),
      band: taxable.lessThanOrEqualTo(threshold) ? 'Within the AED 375,000 0% band' : '9% above AED 375,000',
      effectiveRate: taxable.isZero() ? null : tax.dividedBy(taxable).toDecimalPlaces(4).toString(),
      thresholds: { lower: two(threshold), upper: null },
      marginalRelief: null,
      dueDate: addMonthsToDate(input.periodEnd, 9),
      days,
    };
  }

  return { kind: 'not_estimated', reason: 'country' };
}
