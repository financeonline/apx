import { parseDecimalOrNull } from '@/core/money';

/**
 * N-2 (Step 0F): how a figure that is a DIFFERENCE of two periods' records reconciles.
 *
 * A cumulative report's month is year-to-date(P) − year-to-date(P−1) (FINANCIAL_ENGINE §3). Neither
 * side's records total to the figure, so reconciling either selection against the figure always
 * "fails" — which is what the drawer used to print. The reconciliation is in two steps instead:
 *
 *   1. each term's records against that term's OWN expected value (what the engine read for it);
 *   2. the formula: Σ sign × records total = the figure, to the cent.
 *
 * Both are stated. A term that does not match its expected value is a fault even when the formula
 * happens to balance (two offsetting errors), and the formula is a fault even when each term matches
 * (the engine's arithmetic). `null` means there is nothing to compare: an unavailable term or figure,
 * or a term written before engine 11 stated its expected value.
 */
export interface DifferenceTermInput {
  readonly sign: 1 | -1;
  /** Σ of the term's records as resolved now; NULL when the term is unavailable. */
  readonly total: string | null;
  /** The engine's own reading of the term; `undefined` when the figure predates it. */
  readonly expected?: string | null;
}

export interface DifferenceReconciliation {
  /** Per term, in order: records total = expected value. */
  readonly terms: ReadonlyArray<boolean | null>;
  /** Σ sign × records total, to the cent — what the records make the figure. NULL if a side is missing. */
  readonly recordsResult: string | null;
  /** Σ sign × records total = the figure. */
  readonly formula: boolean | null;
  /** Σ sign × expected = the figure: the engine's arithmetic. */
  readonly arithmetic: boolean | null;
  /** Every comparison that could be made held, and at least the formula could be made. */
  readonly reconciles: boolean | null;
}

const CENT = '0.005';

function same(a: string | null | undefined, b: string | null | undefined): boolean | null {
  const left = parseDecimalOrNull(a ?? null);
  const right = parseDecimalOrNull(b ?? null);
  if (left === null || right === null) return null;
  return left.minus(right).abs().lessThan(CENT);
}

function signedSum(values: ReadonlyArray<{ sign: 1 | -1; value: string | null | undefined }>): string | null {
  let total = parseDecimalOrNull('0')!;
  for (const { sign, value } of values) {
    const amount = parseDecimalOrNull(value ?? null);
    if (amount === null) return null;
    total = total.plus(sign === 1 ? amount : amount.negated());
  }
  return total.toFixed(2);
}

export function reconcileDifference(terms: readonly DifferenceTermInput[], figure: string | null): DifferenceReconciliation {
  const perTerm = terms.map((t) => (t.expected === undefined ? null : same(t.total, t.expected)));
  const recordsResult = signedSum(terms.map((t) => ({ sign: t.sign, value: t.total })));
  const formula = same(recordsResult, figure);
  const arithmetic = terms.some((t) => t.expected === undefined)
    ? null
    : same(signedSum(terms.map((t) => ({ sign: t.sign, value: t.expected }))), figure);
  const checks = [...perTerm, formula, arithmetic].filter((c): c is boolean => c !== null);
  const reconciles = formula === null ? null : checks.every(Boolean);
  return { terms: perTerm, recordsResult, formula, arithmetic, reconciles };
}
