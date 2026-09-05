import DecimalJs from 'decimal.js';

/**
 * The one configured Decimal constructor (ADR-006, FINANCIAL_ENGINE.md §1.4).
 *
 * `clone()` rather than `Decimal.set()`: mutating the global constructor would let any other package
 * that imports decimal.js change MOTION's rounding underneath the engine, and would let MOTION
 * change theirs. Precision and rounding are stated here rather than inherited, so that a change to
 * a library default can never silently move a number.
 *
 * `toExpNeg`/`toExpPos` are pushed to the ends of their permitted range so `toString()` never
 * produces exponential notation: these strings are written straight into NUMERIC columns and
 * `1e+21` is not a NUMERIC literal we want to depend on.
 */
export const Decimal = DecimalJs.clone({
  precision: 20, // "20 significant digits" (ADR-006)
  rounding: DecimalJs.ROUND_HALF_UP,
  toExpNeg: -9e15,
  toExpPos: 9e15,
});

/** The value type. A `const` and a `type` of the same name coexist; both mean "a MOTION Decimal". */
export type Decimal = DecimalJs;

/** Money columns are `NUMERIC(18,2)` (ADR-006). */
export const MONEY_DECIMAL_PLACES = 2;

/** Ratios, scores and metric values are `NUMERIC(20,6)` (ADR-006). */
export const RATIO_DECIMAL_PLACES = 6;

/** Ratios are displayed to one decimal place as a percentage (UX_ARCHITECTURE.md §8.2). */
export const PERCENT_DISPLAY_DECIMAL_PLACES = 1;

/** The single rounding mode. Named so call sites read as the ADR does. */
export const ROUND_HALF_UP = DecimalJs.ROUND_HALF_UP;
