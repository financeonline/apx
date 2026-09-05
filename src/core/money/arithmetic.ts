import { Decimal } from './decimal';
import { parseDecimal, type DecimalInput } from './parse';

/**
 * Exact arithmetic (ADR-006, FINANCIAL_ENGINE.md §1.4).
 *
 * Every helper parses its arguments through `parseDecimal`, so a raw NUMERIC string from a
 * repository can be added without a separate parse step and a rubbish value fails at the point it
 * enters the sum rather than several operations later.
 */

export function add(a: DecimalInput, b: DecimalInput): Decimal {
  return parseDecimal(a).plus(parseDecimal(b));
}

export function subtract(a: DecimalInput, b: DecimalInput): Decimal {
  return parseDecimal(a).minus(parseDecimal(b));
}

export function multiply(a: DecimalInput, b: DecimalInput): Decimal {
  return parseDecimal(a).times(parseDecimal(b));
}

/**
 * Divide, or `null` when the denominator is zero.
 *
 * Null, never `Infinity` and never a thrown error: a ratio whose denominator is zero is a *missing*
 * value, and the engine writes it as NULL with a reason rather than zero-filling
 * (FINANCIAL_ENGINE.md §1.5). §3.2 is the canonical instance — `pct_change` is NULL with
 * `comparison_is_zero` when the comparison is 0. The caller decides which reason code to record;
 * this function only refuses to invent a number.
 */
export function divide(numerator: DecimalInput, denominator: DecimalInput): Decimal | null {
  const d = parseDecimal(denominator);
  if (d.isZero()) return null;
  return parseDecimal(numerator).dividedBy(d);
}

/** Sum a list. An empty list is 0 — "we summed nothing" is genuinely zero, unlike a missing input. */
export function sum(values: Iterable<DecimalInput>): Decimal {
  let total = new Decimal(0);
  for (const value of values) total = total.plus(parseDecimal(value));
  return total;
}

export function negate(value: DecimalInput): Decimal {
  return parseDecimal(value).negated();
}

export function abs(value: DecimalInput): Decimal {
  return parseDecimal(value).abs();
}

/** −1, 0 or 1. */
export function compare(a: DecimalInput, b: DecimalInput): number {
  return parseDecimal(a).comparedTo(parseDecimal(b));
}

export function equals(a: DecimalInput, b: DecimalInput): boolean {
  return compare(a, b) === 0;
}

export function isZero(value: DecimalInput): boolean {
  return parseDecimal(value).isZero();
}

/** Strictly below zero. `-0` is not negative money; `lessThan` says so, `isNegative()` would not. */
export function isNegative(value: DecimalInput): boolean {
  return parseDecimal(value).lessThan(0);
}

export function isPositive(value: DecimalInput): boolean {
  return parseDecimal(value).greaterThan(0);
}

export const ZERO = new Decimal(0);
