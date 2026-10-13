import { parseDecimal } from '@/core/money';

/**
 * The amount to allocate, as the analyst types it (ADR-171). Pure.
 *
 * The Investment Pack allocates a distributable surplus. By default that is the base year's net profit;
 * the analyst may instead enter the amount — the surplus after tax, reserves and committed obligations,
 * which only they know. What they type is read here, once, for the form and the service alike, and
 * crosses to the database as a decimal string (`api.request_investment_report` checks the same bounds
 * again, for a caller that came straight there).
 *
 *   ""           → not given: APX uses the base year's net profit
 *   "95,000"     → "95000.00"   (thousands separated by commas, in threes)
 *   "95000.50"   → "95000.50"
 *   "£95,000"    → "95000.00"   (a leading currency sign is ignored)
 *
 * Refused: anything that is not a plain amount, more than two decimal places, less than 1, and more
 * than 1,000,000,000,000 (the database's own bounds for the field). At least 1 because the pack's
 * figures are whole currency units (`buildInvestmentFigures` rounds the surplus to whole units), so a
 * smaller amount would round to nothing to allocate.
 */

export const SURPLUS_MIN = '1';
export const SURPLUS_MAX = '1000000000000';

const PLAIN = /^\d+(?:\.\d{1,2})?$/;
const GROUPED = /^\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?$/;

export type SurplusParse =
  | { readonly ok: true; readonly surplus: string | null }
  | { readonly ok: false; readonly message: string };

export function parseSurplusInput(raw: string | null | undefined): SurplusParse {
  const text = (raw ?? '').replace(/\s+/g, '').replace(/^[£$€]/, '');
  if (text.length === 0) return { ok: true, surplus: null };
  if (!PLAIN.test(text) && !GROUPED.test(text)) {
    return { ok: false, message: 'Enter the amount to allocate as a number, like 95,000 or 95000.50.' };
  }
  const amount = parseDecimal(text.replace(/,/g, ''), 'surplus');
  if (amount.lt(SURPLUS_MIN)) return { ok: false, message: 'Enter an amount of at least 1.' };
  if (amount.gt(SURPLUS_MAX)) return { ok: false, message: 'The amount to allocate must be 1,000,000,000,000 or less.' };
  return { ok: true, surplus: amount.toFixed(2) };
}
