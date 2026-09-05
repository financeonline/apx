/**
 * Sign conventions (FINANCIAL_ENGINE.md §3, ADR-027, ADR-047.3–5).
 *
 * This file is where a P&L gets inverted if anybody is careless, so every rule §3 states is written
 * here once and nowhere else. Four different sources describe the same money four different ways:
 *
 *  - `ledger_entries` carries a magnitude plus a side (`debit`/`credit`);
 *  - `period_balances.closing_balance` carries NATURAL sign, `debit − credit`, always — a file that
 *    presents income as a positive number is declared `transforms.balanceSign = reporting` at
 *    mapping and negated at commit, so the engine never sees reporting sign (ADR-047.3);
 *  - `invoices` carry four positive money fields and a type that decides whether they add or
 *    subtract (ADR-047.5);
 *  - `bank_transactions.amount` is signed, positive in.
 *
 * Everything here converts one of those into the ONE convention the metrics are defined in:
 * REPORTING sign, where a normal month's revenue is positive and a normal month's expense is
 * positive. Nothing in this file reads a clock, a database or a random number.
 */

import {
  Decimal,
  ZERO,
  abs,
  add,
  cashDirection,
  divide,
  parseDecimal,
  parseDecimalOrNull,
  signedFromEntry,
  subtract,
  sum,
  type CashDirection,
  type EntryDirection,
} from '@/core/money';
import {
  CATEGORY_ACCOUNT_TYPE,
  type AccountType,
  type BalanceBasis,
  type InvoiceStatus,
  type InvoiceType,
  type StandardCategory,
} from '@/modules/financials';
import type { DataQualityMissing, DataQualityWarning } from './types';

// ---------------------------------------------------------------------------------------------
// The one result shape a signed figure comes back in
// ---------------------------------------------------------------------------------------------

/**
 * A figure the sign step produced, with what it learned on the way.
 *
 * `amount === null` always arrives with a reason in `missing` (§1.5). A non-null amount may still
 * carry a `warning` — `account_absent_prior` is exactly that case: the value is a real 0, and the
 * note says the zero came from an absent prior row rather than from a stated one.
 */
export interface SignedAmount {
  readonly amount: Decimal | null;
  readonly warnings: readonly DataQualityWarning[];
  readonly missing: readonly DataQualityMissing[];
}

function ok(amount: Decimal, warnings: readonly DataQualityWarning[] = []): SignedAmount {
  return { amount, warnings, missing: [] };
}

function unavailable(
  missing: readonly DataQualityMissing[],
  warnings: readonly DataQualityWarning[] = [],
): SignedAmount {
  return { amount: null, warnings, missing };
}

// ---------------------------------------------------------------------------------------------
// §3: the account-type sign rule
// ---------------------------------------------------------------------------------------------

/**
 * +1 when natural sign (`debit − credit`) already reads as the statement reads, −1 when it must be
 * flipped.
 *
 * §3: "for `income`/`liability`/`equity`-type accounts, amount = Σcredit − Σdebit; for
 * `expense`/`asset`-type accounts, amount = Σdebit − Σcredit". Since `Σcredit − Σdebit` is exactly
 * `−(Σdebit − Σcredit)`, the whole rule is one multiplier — and being a multiplier is what makes
 * cumulative differencing safe: negating and subtracting commute, so `closing(P) − closing(P−1)`
 * may be differenced in natural sign and converted once at the end.
 */
export function reportingSignFor(accountType: AccountType): 1 | -1 {
  return accountType === 'income' || accountType === 'liability' || accountType === 'equity'
    ? -1
    : 1;
}

/**
 * The same rule keyed by standard category.
 *
 * `CATEGORY_ACCOUNT_TYPE` is the pairing the database enforces as a CHECK constraint, so a category
 * can never be signed one way here and another way in SQL. This is also why
 * `expense_by_category[other_income]` is signed as income even though §3.1's formula column says
 * "Σ debit − credit": that column is shorthand for the dominant, expense-typed case, and §3's
 * account-type rule is the one stated as holding "throughout".
 */
export function reportingSignForCategory(category: StandardCategory): 1 | -1 {
  return reportingSignFor(CATEGORY_ACCOUNT_TYPE[category]);
}

/** Convert a naturally-signed figure (`debit − credit`) into reporting sign. */
export function naturalToReporting(accountType: AccountType, natural: Decimal | string): Decimal {
  const value = parseDecimal(natural);
  return reportingSignFor(accountType) === 1 ? value : value.negated();
}

// ---------------------------------------------------------------------------------------------
// Ledger (§3)
// ---------------------------------------------------------------------------------------------

/**
 * The reporting-sign amount of an aggregated ledger cell.
 *
 * Revenue comes out positive in a normal month and NEGATIVE in a month whose refunds exceeded its
 * sales — that is a real result the engine reports with a `negative_revenue` warning, never an
 * absolute value and never a zero (§3.1).
 */
export function ledgerAmount(cell: {
  readonly accountType: AccountType;
  readonly debit: Decimal | string;
  readonly credit: Decimal | string;
}): Decimal {
  const natural = subtract(cell.debit, cell.credit);
  return naturalToReporting(cell.accountType, natural);
}

/** A single ledger line, for the rare caller that has lines rather than sums. */
export function ledgerLineAmount(line: {
  readonly accountType: AccountType;
  readonly direction: EntryDirection;
  readonly amount: Decimal | string;
}): Decimal {
  return naturalToReporting(line.accountType, signedFromEntry(line));
}

// ---------------------------------------------------------------------------------------------
// Period balances (§3, ADR-047.4) — cumulative differencing
// ---------------------------------------------------------------------------------------------

/**
 * One account's balance row for period P, plus the pinned prior row the difference needs.
 *
 * `priorRow` is deliberately three-valued, because the three cases mean three different things and
 * §3 gives each a different answer:
 *
 *   'same_kind_and_basis'  — the previous fiscal month's winning batch of the SAME `balance_kind`
 *                            and SAME `balance_basis` exists AND states this account. Difference.
 *   'account_absent'       — that batch exists but does not mention this account. The account had
 *                            no year-to-date position, so the prior figure is a genuine 0; the
 *                            result carries the `account_absent_prior` note.
 *   'no_batch'             — no such batch. NOTHING may stand in for it: not a movement-basis month,
 *                            not an earlier month, not zero. A trial balance is year-to-date, so
 *                            differencing March against January would report two months of trading
 *                            as one. The value is NULL with `no_prior_trial_balance`.
 */
export type PriorBalanceState = 'same_kind_and_basis' | 'account_absent' | 'no_batch';

export interface CumulativeBalanceInput {
  readonly accountType: AccountType;
  /** `closing_balance` for P, natural sign. */
  readonly closing: Decimal | string;
  /**
   * True when P is the first month of the fiscal year FROZEN ON THE BATCH
   * (`fiscal_year_start_month_at_commit`), not of the organization's current setting — the year
   * resets there and `closing(P)` is already just this month (`core/periods.isFirstFiscalMonth`).
   */
  readonly isFirstFiscalMonth: boolean;
  readonly priorState: PriorBalanceState;
  /** `closing_balance` for the pinned prior month, natural sign. Read only for 'same_kind_and_basis'. */
  readonly priorClosing?: Decimal | string | null;
}

/**
 * A P&L category's amount for P from a `period_balances` row (§3).
 *
 * `movement` basis: the row already IS the month, so the amount is `closing_balance`.
 * `cumulative` basis: the row is year-to-date, so the month is `closing(P) − closing(P_prev)`.
 */
export function periodBalancePnlAmount(
  input: CumulativeBalanceInput & { readonly balanceBasis: BalanceBasis },
): SignedAmount {
  if (input.balanceBasis === 'movement') {
    return ok(naturalToReporting(input.accountType, parseDecimal(input.closing)));
  }
  return differenceCumulativeBalance(input);
}

/** The cumulative case on its own, so the differencing rule can be read and tested in isolation. */
export function differenceCumulativeBalance(input: CumulativeBalanceInput): SignedAmount {
  const closing = parseDecimal(input.closing);

  // The fiscal year has just reset: the year-to-date figure IS this month's figure. Reaching back
  // into the previous fiscal year here would subtract a full prior year from a single month.
  if (input.isFirstFiscalMonth) {
    return ok(naturalToReporting(input.accountType, closing));
  }

  if (input.priorState === 'no_batch') {
    return unavailable(['no_prior_trial_balance']);
  }

  if (input.priorState === 'account_absent') {
    // The batch covered the month and simply had no line for this account: nothing accumulated, so
    // the prior year-to-date figure is a known zero and the whole year-to-date figure is this
    // month's. The note records that the zero was inferred from absence rather than stated.
    return ok(naturalToReporting(input.accountType, closing), ['account_absent_prior']);
  }

  const prior = parseDecimalOrNull(input.priorClosing ?? null);
  if (prior === null) {
    // 'same_kind_and_basis' promises a figure. Its absence is a caller bug, and guessing a zero
    // here would be exactly the silent misstatement 'account_absent' exists to make explicit.
    return unavailable(['no_prior_trial_balance']);
  }
  // Difference in natural sign, convert once: the sign rule is a multiplier, so the two orders
  // agree, and doing it this way keeps a single conversion point.
  return ok(naturalToReporting(input.accountType, closing.minus(prior)));
}

/**
 * A balance-sheet category's position at the end of P from `period_balances` (§3).
 *
 * `cumulative` states the position directly. `movement` states only the change, so the position is
 * the prior balance-sheet closing plus every movement since; with no prior closing there is no
 * position to report and the answer is NULL with `no_opening_balance` — the balances family never
 * reports movements-since-import as if they were a balance.
 */
export function periodBalanceBalanceSheetAmount(input: {
  readonly accountType: AccountType;
  readonly balanceBasis: BalanceBasis;
  /** Natural-sign `closing_balance` for P; used by the `cumulative` basis. */
  readonly closing?: Decimal | string | null;
  /** Natural-sign balance-sheet closing for the period before the movements begin. */
  readonly priorClosing?: Decimal | string | null;
  /** Natural-sign movements from the prior closing up to and including P. */
  readonly movements?: readonly (Decimal | string)[];
}): SignedAmount {
  if (input.balanceBasis === 'cumulative') {
    const closing = parseDecimalOrNull(input.closing ?? null);
    if (closing === null) return unavailable(['no_opening_balance']);
    return ok(naturalToReporting(input.accountType, closing));
  }
  const prior = parseDecimalOrNull(input.priorClosing ?? null);
  if (prior === null) return unavailable(['no_opening_balance']);
  const moved = sum(input.movements ?? []);
  return ok(naturalToReporting(input.accountType, add(prior, moved)));
}

// ---------------------------------------------------------------------------------------------
// Invoices (§3, ADR-047.5)
// ---------------------------------------------------------------------------------------------

/**
 * +1 for a sale or a purchase, −1 for the credit note that reverses one.
 *
 * Credit notes are stored with all four money fields POSITIVE — `subtotal`, `tax_amount`,
 * `total_amount` and `amount_paid` are negated together at conversion — so the sign lives entirely
 * in the type. A credit note stored negative and subtracted by type would ADD to revenue.
 */
export function invoiceSignFor(invoiceType: InvoiceType): 1 | -1 {
  return invoiceType === 'sales_credit_note' || invoiceType === 'purchase_credit_note' ? -1 : 1;
}

/** `void` invoices are excluded from every figure (§3): a voided document is not a transaction. */
export function invoiceContributes(status: InvoiceStatus): boolean {
  return status !== 'void';
}

/** The four money fields of one invoice header, as strings straight from the columns. */
export interface InvoiceAmountRow {
  readonly invoiceType: InvoiceType;
  readonly status: InvoiceStatus;
  readonly subtotal: string | null;
  readonly taxAmount: string | null;
  readonly totalAmount: string;
}

export interface InvoiceNetAmount {
  /** Net of tax, UNSIGNED by type — the magnitude the row states. */
  readonly net: Decimal;
  /** True when the row had neither a usable subtotal nor a tax amount, so the total stands in. */
  readonly usedTotalFallback: boolean;
}

/**
 * One invoice row's P&L amount, net of tax (§3): `subtotal`, else `total_amount − tax_amount`,
 * else `total_amount`.
 *
 * "A `subtotal` of 0 with `total_amount > 0` counts as absent": exporters that do not carry a
 * subtotal column write a literal zero rather than a null, and taking that zero at face value would
 * silently delete the invoice from revenue. A genuinely zero-value invoice has a zero total too, so
 * the pair is what distinguishes the two.
 *
 * The third branch puts a VAT-INCLUSIVE figure into an accrual metric. That is a real overstatement,
 * not a rounding detail, which is why the caller must surface it — see `foldInvoiceRows`.
 */
export function invoiceNetOfTax(row: InvoiceAmountRow): InvoiceNetAmount {
  const total = parseDecimal(row.totalAmount, 'total_amount');
  const subtotal = parseDecimalOrNull(row.subtotal, 'subtotal');
  if (subtotal !== null && !(subtotal.isZero() && total.greaterThan(0))) {
    return { net: subtotal, usedTotalFallback: false };
  }
  const tax = parseDecimalOrNull(row.taxAmount, 'tax_amount');
  if (tax !== null) {
    return { net: total.minus(tax), usedTotalFallback: false };
  }
  return { net: total, usedTotalFallback: true };
}

/** Share of contributing rows that fell back to `total_amount` above which the metric is estimated. */
export const VAT_FALLBACK_ESTIMATED_THRESHOLD = '0.10';

export interface InvoiceFold {
  /** Signed by type: sales and purchases add, their credit notes subtract. */
  readonly amount: Decimal;
  readonly contributingRows: number;
  readonly fallbackRows: number;
  /** `fallbackRows / contributingRows`, or null when nothing contributed. */
  readonly fallbackShare: Decimal | null;
  /** §3: set when ≥ 1 contributing row fell back to `total_amount`. */
  readonly vatInclusive: boolean;
  /** §3: set when the fallback share exceeds 10%, which downgrades assurance to `estimated`. */
  readonly estimated: boolean;
  readonly warnings: readonly DataQualityWarning[];
}

/**
 * Sum invoice rows into one P&L figure, carrying the VAT-fallback signals §3 requires.
 *
 * The fallback SHARE is counted in rows, not in money: §3 pairs it with "≥ 1 contributing row fell
 * back", so rows are the unit the sentence is written in. (Recorded here because a money-weighted
 * share would give a different answer on a file with one large VAT-inclusive invoice.)
 */
export function foldInvoiceRows(rows: Iterable<InvoiceAmountRow>): InvoiceFold {
  let amount = ZERO;
  let contributingRows = 0;
  let fallbackRows = 0;
  for (const row of rows) {
    if (!invoiceContributes(row.status)) continue;
    const { net, usedTotalFallback } = invoiceNetOfTax(row);
    const signed = invoiceSignFor(row.invoiceType) === 1 ? net : net.negated();
    amount = amount.plus(signed);
    contributingRows += 1;
    if (usedTotalFallback) fallbackRows += 1;
  }
  const fallbackShare = contributingRows === 0 ? null : divide(fallbackRows, contributingRows);
  const vatInclusive = fallbackRows > 0;
  const estimated =
    fallbackShare !== null && fallbackShare.greaterThan(VAT_FALLBACK_ESTIMATED_THRESHOLD);
  return {
    amount,
    contributingRows,
    fallbackRows,
    fallbackShare,
    vatInclusive,
    estimated,
    warnings: vatInclusive ? ['vat_inclusive'] : [],
  };
}

// ---------------------------------------------------------------------------------------------
// Bank (§3)
// ---------------------------------------------------------------------------------------------

/**
 * The cash sense of a signed bank amount: `> 0` inflow, `< 0` outflow, exactly zero neither.
 *
 * Delegated to `core/money` so the engine and the banking module cannot disagree about which way
 * the money went.
 */
export function bankDirection(amount: Decimal | string): CashDirection | null {
  return cashDirection(amount);
}

/** Bank inflows are stored as they arrive; outflows are stored positive (§3.3), hence the abs. */
export function bankOutflowMagnitude(amount: Decimal | string): Decimal {
  return abs(amount);
}
