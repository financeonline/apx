import { ValidationError } from '@/core/errors';
import {
  Decimal,
  MONEY_DECIMAL_PLACES,
  RATIO_DECIMAL_PLACES,
  ROUND_HALF_UP,
} from './decimal';

/**
 * The data-access boundary (ADR-006).
 *
 * Money and ratios leave Postgres as strings and enter the application as `Decimal` here. Nothing
 * else in the codebase may turn a money field into a JS number — `motion/no-money-parsefloat`
 * enforces that mechanically, and this module is the only sanctioned way across the boundary.
 */

/** What a caller may hand us. `number` is for literals and settings, never for a NUMERIC column. */
export type DecimalInput = string | number | Decimal;

/**
 * A plain decimal literal, optionally signed, optionally with an exponent.
 *
 * decimal.js on its own would happily accept `0xff`, `Infinity` and `NaN`; a NUMERIC column never
 * produces any of those, so a value that looks like one is corrupt input and must be refused rather
 * than parsed into something plausible.
 */
const DECIMAL_LITERAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

function reject(field: string | undefined, raw: unknown): never {
  const shown = typeof raw === 'string' ? raw : String(raw);
  throw new ValidationError(
    'That amount could not be read.',
    [{ path: field ?? 'value', message: `"${shown}" is not a valid decimal number.` }],
  );
}

function isDecimal(value: unknown): value is Decimal {
  return value instanceof Decimal;
}

/**
 * Parse a value into a `Decimal` exactly, or throw `ValidationError`.
 *
 * No rounding happens here. ADR-006 rounds once, at storage or display, so that a chain of
 * intermediate results keeps all 20 significant digits.
 */
export function parseDecimal(value: DecimalInput, field?: string): Decimal {
  if (isDecimal(value)) {
    if (!value.isFinite()) reject(field, value.toString());
    return value;
  }
  if (typeof value === 'number') {
    // Numbers are allowed for literals (`0`, a VAT rate from settings). A non-finite one is a bug
    // upstream, not a value; it is never silently coerced to zero.
    if (!Number.isFinite(value)) reject(field, value);
    return new Decimal(value);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || !DECIMAL_LITERAL.test(trimmed)) reject(field, value);
  try {
    return new Decimal(trimmed);
  } catch {
    // Unreachable for anything matching DECIMAL_LITERAL, but a swallowed decimal.js error would
    // hide a real regression, so it is re-raised in MOTION's own error model.
    reject(field, value);
  }
}

/**
 * Parse a nullable NUMERIC column. NULL means "we do not know", which is not zero
 * (FINANCIAL_ENGINE.md §1.5), so it is preserved as `null` rather than defaulted.
 */
export function parseDecimalOrNull(
  value: DecimalInput | null | undefined,
  field?: string,
): Decimal | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.trim().length === 0) return null;
  return parseDecimal(value, field);
}

/**
 * Parse a value that MIGHT be rubbish, without raising.
 *
 * `parseDecimalOrNull` returns null for a MISSING value and raises for an unreadable one, which is
 * right at a data-access boundary where rubbish is a bug. It is exactly wrong wherever unreadable
 * input is the ordinary case the caller exists to handle: the import validator, which must attach an
 * error to the row rather than abandon it (SOW §23), and the alert condition rules, which must not
 * bring down a whole calculation run because one value could not be read.
 *
 * Both had grown their own private copy of this function. One copy, here, so the distinction between
 * "absent" and "unreadable" is drawn in one place.
 */
export function tryParseDecimal(value: DecimalInput | null | undefined): Decimal | null {
  try {
    return parseDecimalOrNull(value);
  } catch {
    return null;
  }
}

/** Parse a money column (`NUMERIC(18,2)`). Same rules; the name records the intent at the call site. */
export function parseMoney(value: DecimalInput, field?: string): Decimal {
  return parseDecimal(value, field);
}

export function parseMoneyOrNull(
  value: DecimalInput | null | undefined,
  field?: string,
): Decimal | null {
  return parseDecimalOrNull(value, field);
}

/** Round to money precision. ADR-006: `ROUND_HALF_UP`, applied once. */
export function roundMoney(value: DecimalInput, field?: string): Decimal {
  return parseDecimal(value, field).toDecimalPlaces(MONEY_DECIMAL_PLACES, ROUND_HALF_UP);
}

/** Round to metric precision (`NUMERIC(20,6)`) — ratios, scores, HHI. */
export function roundRatio(value: DecimalInput, field?: string): Decimal {
  return parseDecimal(value, field).toDecimalPlaces(RATIO_DECIMAL_PLACES, ROUND_HALF_UP);
}

/**
 * Serialise back to the string a NUMERIC(18,2) column expects.
 *
 * `toFixed` (not `toString`) so the scale is always exactly 2: the database would accept `12.5`,
 * but a fingerprint or a golden-file comparison over `'12.50'` and `'12.5'` would not.
 */
export function toMoneyString(value: DecimalInput, field?: string): string {
  return roundMoney(value, field).toFixed(MONEY_DECIMAL_PLACES);
}

/** Serialise to the string a NUMERIC(20,6) column expects. */
export function toRatioString(value: DecimalInput, field?: string): string {
  return roundRatio(value, field).toFixed(RATIO_DECIMAL_PLACES);
}

/** Serialise a nullable value; `null` stays `null` all the way to the column. */
export function toMoneyStringOrNull(
  value: DecimalInput | null | undefined,
  field?: string,
): string | null {
  const parsed = parseDecimalOrNull(value, field);
  return parsed === null ? null : toMoneyString(parsed, field);
}

export function toRatioStringOrNull(
  value: DecimalInput | null | undefined,
  field?: string,
): string | null {
  const parsed = parseDecimalOrNull(value, field);
  return parsed === null ? null : toRatioString(parsed, field);
}
