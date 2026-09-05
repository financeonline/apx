import { ValidationError } from '@/core/errors';
import type { Decimal } from './decimal';
import { parseDecimal, type DecimalInput } from './parse';

/**
 * Direction (DATABASE_ARCHITECTURE.md §3, FINANCIAL_ENGINE.md §3.3).
 *
 * The schema records the sign of an amount two different ways, and mixing them up is the classic
 * way to invert a P&L, so each has its own type and the conversions between them live here.
 *
 *  - `ledger_entries.direction {debit, credit}` with `amount NUMERIC(18,2) CHECK (amount >= 0)`:
 *    magnitude plus a side.
 *  - `bank_transactions.amount NUMERIC(18,2)` signed, "positive inflow, negative outflow", and
 *    `recurring_payment_groups.direction {inflow, outflow}` naming the same two cases.
 */

/** The accounting side of a ledger line. */
export type EntryDirection = 'debit' | 'credit';

/** The cash sense of a bank movement. */
export type CashDirection = 'inflow' | 'outflow';

export interface DirectedAmount {
  direction: EntryDirection;
  /** Always ≥ 0, as the column's CHECK constraint requires. */
  amount: Decimal;
}

/**
 * Natural sign, i.e. `debit − credit`.
 *
 * This is the convention `period_balances.closing_balance` is stored in
 * ("natural sign `debit − credit`", DATABASE_ARCHITECTURE.md §3), so a ledger line converted here
 * can be summed directly against a balance row.
 */
export function signedFromEntry(entry: {
  direction: EntryDirection;
  amount: DecimalInput;
}): Decimal {
  const amount = parseDecimal(entry.amount, 'amount');
  if (amount.lessThan(0)) {
    throw new ValidationError('A ledger amount cannot be negative.', [
      { path: 'amount', message: 'Direction carries the sign; the amount is a magnitude.' },
    ]);
  }
  return entry.direction === 'credit' ? amount.negated() : amount;
}

/**
 * Split a naturally-signed value back into a side and a magnitude.
 *
 * Zero maps to `debit`: under `debit − credit` zero sits on the non-negative side, and a
 * zero-amount line is identical either way.
 */
export function entryFromSigned(value: DecimalInput): DirectedAmount {
  const signed = parseDecimal(value);
  return signed.lessThan(0)
    ? { direction: 'credit', amount: signed.negated() }
    : { direction: 'debit', amount: signed };
}

/**
 * The cash direction of a signed bank amount, or `null` at exactly zero.
 *
 * FINANCIAL_ENGINE.md §3.3 defines inflows as `amount > 0` and outflows as `amount < 0` — both
 * strict — so a zero-value movement is in neither set. Returning `null` keeps it out of both rather
 * than quietly adding it to one.
 */
export function cashDirection(value: DecimalInput): CashDirection | null {
  const signed = parseDecimal(value);
  if (signed.isZero()) return null;
  return signed.greaterThan(0) ? 'inflow' : 'outflow';
}

/**
 * The magnitude of a signed movement. `cash_outflows` is "Σ |amount| (stored positive)"
 * (FINANCIAL_ENGINE.md §3.3), so outflow sums go through here.
 */
export function magnitude(value: DecimalInput): Decimal {
  return parseDecimal(value).abs();
}

/** Re-apply a cash direction to a magnitude, giving the signed form the bank column stores. */
export function signedFromCash(amount: DecimalInput, direction: CashDirection): Decimal {
  const value = parseDecimal(amount, 'amount');
  if (value.lessThan(0)) {
    throw new ValidationError('A directed cash amount cannot be negative.', [
      { path: 'amount', message: 'Direction carries the sign; the amount is a magnitude.' },
    ]);
  }
  return direction === 'outflow' ? value.negated() : value;
}

/** `credit ↔ debit`. Used when a reversing entry is written (ADR-012). */
export function oppositeEntryDirection(direction: EntryDirection): EntryDirection {
  return direction === 'debit' ? 'credit' : 'debit';
}
