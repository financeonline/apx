/**
 * Exact money and ratio handling (ADR-006, FINANCIAL_ENGINE.md §1.4).
 *
 * Money is `NUMERIC(18,2)` in Postgres, crosses the wire as a string, and becomes a `Decimal` here
 * and nowhere else. Ratios and metric values are `NUMERIC(20,6)`. Rounding is `ROUND_HALF_UP`,
 * applied once — at storage (`toMoneyString`) or at display (`formatMoney`) — never in between.
 *
 * This module is pure: no I/O, no Supabase, no React, no clock.
 */

export {
  Decimal,
  MONEY_DECIMAL_PLACES,
  RATIO_DECIMAL_PLACES,
  PERCENT_DISPLAY_DECIMAL_PLACES,
  ROUND_HALF_UP,
} from './decimal';

export {
  parseDecimal,
  parseDecimalOrNull,
  parseMoney,
  parseMoneyOrNull,
  roundMoney,
  roundRatio,
  toMoneyString,
  toMoneyStringOrNull,
  toRatioString,
  toRatioStringOrNull,
  type DecimalInput,
} from './parse';

export {
  ZERO,
  abs,
  add,
  compare,
  divide,
  equals,
  isNegative,
  isPositive,
  isZero,
  multiply,
  negate,
  subtract,
  sum,
} from './arithmetic';

export {
  cashDirection,
  entryFromSigned,
  magnitude,
  oppositeEntryDirection,
  signedFromCash,
  signedFromEntry,
  type CashDirection,
  type DirectedAmount,
  type EntryDirection,
} from './direction';

export {
  DEFAULT_LOCALE,
  formatCashAmount,
  formatChange,
  formatEntryAmount,
  formatMoney,
  formatPercent,
  type ChangeFormatOptions,
  type MoneyFormatOptions,
  type PercentFormatOptions,
} from './format';
