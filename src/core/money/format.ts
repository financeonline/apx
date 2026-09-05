import { ValidationError } from '@/core/errors';
import {
  MONEY_DECIMAL_PLACES,
  PERCENT_DISPLAY_DECIMAL_PLACES,
  ROUND_HALF_UP,
  type Decimal,
} from './decimal';
import { parseDecimal, type DecimalInput } from './parse';
import type { CashDirection, EntryDirection } from './direction';
import { signedFromCash, signedFromEntry } from './direction';

/**
 * Display formatting (UX_ARCHITECTURE.md §8.2, §11).
 *
 * `formatMoney`, `formatPercent` and `formatChange` are the only number formatters in MOTION:
 * "Formatting comes only from `core/money` … components never format numbers themselves"
 * (UX_ARCHITECTURE.md §11). The document's language attribute is `en-GB`, which is the default
 * locale here; the currency always comes from `organizations.base_currency` and is never assumed.
 */

/** UX_ARCHITECTURE.md §14: the document is `en-GB`. */
export const DEFAULT_LOCALE = 'en-GB';

/** U+2212. §8.2: "Negative money as '−£1,200' (true minus sign)". */
const MINUS = '−';

/**
 * `Intl.NumberFormat.prototype.format` has accepted decimal *strings* since ES2023
 * ("Intl.NumberFormat V3"); `tsconfig.lib` is ES2022, whose declaration says `number` only.
 * Formatting the string keeps money out of JS floats entirely (ADR-006), which is worth one
 * narrowly-scoped assertion.
 */
interface StringNumberFormat {
  format(value: string): string;
}
function forStrings(formatter: Intl.NumberFormat): StringNumberFormat {
  return formatter as unknown as StringNumberFormat;
}

export interface MoneyFormatOptions {
  /** ISO 4217, from `organizations.base_currency`. */
  currency: string;
  locale?: string;
  /**
   * §8.2: "pence shown only on Money sub-pages, evidence and reports". Headline figures round to
   * whole units, so this is off by default.
   */
  showMinorUnits?: boolean;
  /** `'always'` prefixes `+` on positive values, for changes. */
  signDisplay?: 'auto' | 'always';
  /**
   * §8.2: "never parentheses in headline UI; parentheses allowed in report tables". Opt-in, and
   * only report table code should opt in.
   */
  parentheses?: boolean;
}

function localeOf(options: { locale?: string }): string {
  return options.locale ?? DEFAULT_LOCALE;
}

/**
 * Intl formats the *magnitude*; the sign is attached by hand.
 *
 * Two reasons: `Intl` emits an ASCII hyphen for en-GB where §8.2 requires a true minus, and the
 * parenthesised report form needs the sign removed from the number entirely.
 *
 * The value is rounded to its display precision first and handed to `Intl` as a string, so no
 * money value is ever converted to a JS `number` (ADR-006). `Intl.NumberFormat.prototype.format`
 * has accepted decimal strings since ES2023; the cast is only because `tsconfig.lib` is ES2022.
 */
function formatMagnitude(value: Decimal, options: MoneyFormatOptions): string {
  const digits = options.showMinorUnits ? MONEY_DECIMAL_PLACES : 0;
  const rounded = value.abs().toDecimalPlaces(digits, ROUND_HALF_UP);
  let formatter: Intl.NumberFormat;
  try {
    formatter = new Intl.NumberFormat(localeOf(options), {
      style: 'currency',
      currency: options.currency,
      currencyDisplay: 'narrowSymbol',
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
  } catch {
    // A bad currency or locale is a configuration error and must be visible, not rendered as a
    // plausible-looking number in the wrong units.
    throw new ValidationError('That currency or locale is not recognised.', [
      { path: 'currency', message: `${options.currency} / ${localeOf(options)}` },
    ]);
  }
  return forStrings(formatter).format(rounded.toFixed(digits));
}

/** "£12,400", "−£1,200", "+£2,100", "(£1,200)" in report tables. */
export function formatMoney(value: DecimalInput, options: MoneyFormatOptions): string {
  const parsed = parseDecimal(value);
  const body = formatMagnitude(parsed, options);
  const digits = options.showMinorUnits ? MONEY_DECIMAL_PLACES : 0;
  // Sign is decided on the *rounded* value: −£0.004 displayed to whole pounds is "£0", not "−£0".
  const negative = parsed.toDecimalPlaces(digits, ROUND_HALF_UP).lessThan(0);
  if (negative) return options.parentheses ? `(${body})` : `${MINUS}${body}`;
  return options.signDisplay === 'always' && !parsed.isZero() ? `+${body}` : body;
}

/** Money held as a magnitude plus a ledger side (`ledger_entries`), rendered with its natural sign. */
export function formatEntryAmount(
  entry: { direction: EntryDirection; amount: DecimalInput },
  options: MoneyFormatOptions,
): string {
  return formatMoney(signedFromEntry(entry), options);
}

/** Money held as a magnitude plus a cash direction (`recurring_payment_groups.direction`). */
export function formatCashAmount(
  amount: DecimalInput,
  direction: CashDirection,
  options: MoneyFormatOptions,
): string {
  return formatMoney(signedFromCash(amount, direction), options);
}

export interface PercentFormatOptions {
  locale?: string;
  signDisplay?: 'auto' | 'always';
}

/**
 * A ratio rendered as a percentage to one decimal place (§8.2: "Percentages to one decimal place
 * ('12.4%'). Ratios never shown as decimals").
 *
 * Percentages are stored as ratios (0.2534 → "25.3%"), per ADR-006.
 */
export function formatPercent(ratio: DecimalInput, options: PercentFormatOptions = {}): string {
  const parsed = parseDecimal(ratio);
  // Round the ratio to 3 dp so the percentage lands on exactly 1 dp under ROUND_HALF_UP, applied
  // once here rather than left to Intl (whose rounding mode is not ROUND_HALF_UP).
  const rounded = parsed.toDecimalPlaces(PERCENT_DISPLAY_DECIMAL_PLACES + 2, ROUND_HALF_UP);
  const formatter = new Intl.NumberFormat(options.locale ?? DEFAULT_LOCALE, {
    style: 'percent',
    minimumFractionDigits: PERCENT_DISPLAY_DECIMAL_PLACES,
    maximumFractionDigits: PERCENT_DISPLAY_DECIMAL_PLACES,
  });
  const body = forStrings(formatter).format(
    rounded.abs().toFixed(PERCENT_DISPLAY_DECIMAL_PLACES + 2),
  );
  if (rounded.lessThan(0)) return `${MINUS}${body}`;
  return options.signDisplay === 'always' && !rounded.isZero() ? `+${body}` : body;
}

export interface ChangeFormatOptions extends MoneyFormatOptions {
  /** e.g. "February". Rendered as " vs February" (§8.2). */
  comparisonLabel?: string;
}

/**
 * A period-over-period change: "+£2,100 (+8.3%) vs February" (§8.2).
 *
 * `value === null` is "Absent comparison: 'no comparison yet'". `pctChange === null` is a change we
 * can state in money but not as a percentage — the comparison was zero or the signs differ
 * (FINANCIAL_ENGINE.md §3.2) — so the amount is shown alone rather than with a fabricated
 * percentage.
 */
export function formatChange(
  value: DecimalInput | null,
  pctChange: DecimalInput | null,
  options: ChangeFormatOptions,
): string {
  if (value === null) return 'no comparison yet';
  const amount = formatMoney(value, { ...options, signDisplay: 'always' });
  const percent =
    pctChange === null ? null : formatPercent(pctChange, { locale: options.locale, signDisplay: 'always' });
  const head = percent === null ? amount : `${amount} (${percent})`;
  return options.comparisonLabel ? `${head} vs ${options.comparisonLabel}` : head;
}
