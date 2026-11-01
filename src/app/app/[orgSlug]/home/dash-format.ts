import 'server-only';
import { Decimal, ROUND_HALF_UP, formatMoney } from '@/core/money';

/**
 * The prototype's compact money ("£1.69m", "£234.7k", "£950") — the same rules as the dashboard
 * services' `compactMoney` (modules/departments), for the figures this page's server actions format.
 */
export function compactMoney(value: Decimal | string | null, currency: string): string {
  if (value === null) return '—';
  const d = new Decimal(value);
  const symbol = formatMoney(0, { currency }).replace(/[\d.,\s]/g, '');
  const sign = d.isNegative() ? '−' : '';
  const a = d.abs();
  const trim = (s: string) => s.replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1');
  // The unit is chosen AFTER rounding (as the services' `compactMoney`): £999,960 reads "£1m", never
  // "£1000k", and £999.60 reads "£1k", never "£1000".
  const thousands = a.dividedBy(1_000).toDecimalPlaces(1, ROUND_HALF_UP);
  if (thousands.greaterThanOrEqualTo(1_000)) return `${sign}${symbol}${trim(a.dividedBy(1_000_000).toDecimalPlaces(2, ROUND_HALF_UP).toFixed(2))}m`;
  const whole = a.toDecimalPlaces(0, ROUND_HALF_UP);
  if (whole.greaterThanOrEqualTo(1_000)) return `${sign}${symbol}${trim(thousands.toFixed(1))}k`;
  return `${sign}${symbol}${whole.toFixed(0)}`;
}

/** Whole units, "£278,000". */
export function fullMoney(value: Decimal | string, currency: string): string {
  return formatMoney(value, { currency });
}
