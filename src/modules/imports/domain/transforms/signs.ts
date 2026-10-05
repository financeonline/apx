/**
 * Sign transforms (IMPORT_ENGINE.md §6.4: "Bank sign convention", "GL direction", "Balance sign",
 * "Liability bank accounts"; ADR-047.3, ADR-028).
 *
 * Three different files can hold the same figure with three different signs, and every one of them
 * has to reach storage as the same natural-sign number. Nothing here guesses: where the document
 * requires a human answer — "Are payments out shown as negative?" (`transforms.bankSign`), and the
 * balance-sign confirmation (`IMP-TB-013`) — these functions return the question, not an answer.
 */

import { Decimal, negate, parseMoney, toMoneyString, tryParseDecimal, ZERO } from '@/core/money';
import { CATEGORY_ACCOUNT_TYPE, type StandardCategory } from '@/modules/financials';
import type { BalanceSign, BankSign, GlSign, RowIssue } from '../pipeline-types';

// -----------------------------------------------------------------------------------------------
// Bank sign (§6.4, ADR-028)
// -----------------------------------------------------------------------------------------------

/** The bank-account types `bank_accounts.account_type` holds. */
export type BankAccountType = 'current' | 'savings' | 'credit_card' | 'loan' | 'other';

/** ADR-028: on a card or a loan a purchase or drawdown INCREASES the balance owed. */
export function isLiabilityBankAccount(accountType: BankAccountType): boolean {
  return accountType === 'credit_card' || accountType === 'loan';
}

/**
 * The bank sign for a single signed amount column, or `null` when the reviewer must answer.
 *
 * §6.4 gives a default only for the liability accounts; for a current account the mapping step asks
 * with three sample rows, and reading a current account's column the wrong way round would invert
 * every cash movement in the file.
 */
export function resolveBankSign(
  explicit: BankSign | undefined,
  accountType: BankAccountType,
): BankSign | null {
  if (explicit !== undefined) return explicit;
  return isLiabilityBankAccount(accountType) ? 'positive_out' : null;
}

export interface BankAmountResult {
  /** Signed money string: positive is money into the account. */
  readonly amount: string | null;
  readonly issue: RowIssue | null;
}

/** Reads a money cell, or reports it as unreadable. Never throws (ADR-058.5). */
function readMoneyCell(
  value: string | null | undefined, field: 'debit' | 'credit' | 'amount' | 'money_in' | 'money_out',
): { value: Decimal | null; issue: RowIssue | null } {
  if (value === null || value === undefined || value === '') return { value: null, issue: null };
  const parsed = tryParseDecimal(value);
  if (parsed === null) {
    return {
      value: null,
      issue: {
        code: 'IMP-AMT-002',
        severity: 'error',
        field,
        message: `"${value}" is not an amount MOTION can read.`,
      },
    };
  }
  return { value: parsed, issue: null };
}

/**
 * `amount = money_in − money_out` (§6.4).
 *
 * Both columns populated is `IMP-AMT-002` (error, §8.1): a row that is both a payment and a receipt
 * is not a row anyone can net, and netting it silently would hide half of it.
 */
export function bankAmountFromInOut(
  moneyIn: string | null | undefined,
  moneyOut: string | null | undefined,
): BankAmountResult {
  /*
   * Unreadable input is REPORTED, not thrown — the same contract, and the same trap, as
   * `glFromDebitCredit`. A header row reaching this as data ("Paid Out" in the money-out column)
   * used to take down the whole import instead of becoming one flagged row (ADR-058.5).
   */
  const inRead = readMoneyCell(moneyIn, 'money_in');
  if (inRead.issue !== null) return { amount: null, issue: inRead.issue };
  const outRead = readMoneyCell(moneyOut, 'money_out');
  if (outRead.issue !== null) return { amount: null, issue: outRead.issue };

  const inValue = inRead.value;
  const outValue = outRead.value;

  if (inValue !== null && outValue !== null && !inValue.isZero() && !outValue.isZero()) {
    return {
      amount: null,
      issue: {
        code: 'IMP-AMT-002',
        severity: 'error',
        message: 'This row has both a money-in and a money-out amount',
        suggestion: 'Split the row, or map only the column that carries the movement.',
      },
    };
  }

  if (inValue === null && outValue === null) return { amount: null, issue: null };

  const credit = inValue ?? ZERO;
  const debit = outValue ?? ZERO;
  return { amount: toMoneyString(credit.minus(debit)), issue: null };
}

/**
 * A single signed column read under the confirmed `transforms.bankSign`.
 *
 * `negative_out`: the file already writes payments out as negative, so the column is kept as it is.
 * `positive_out`: the file writes payments out as positive (the credit-card convention), so the
 * whole column is negated — which also turns the card's repayments and refunds back into inflows.
 */
export function bankAmountFromSigned(amount: string, bankSign: BankSign): BankAmountResult {
  // Reports rather than throws, for the reason given on `bankAmountFromInOut` (ADR-058.5).
  const read = readMoneyCell(amount, 'amount');
  if (read.issue !== null) return { amount: null, issue: read.issue };
  if (read.value === null) return { amount: null, issue: null };
  return {
    amount: toMoneyString(bankSign === 'positive_out' ? negate(read.value) : read.value),
    issue: null,
  };
}

export interface ReconciliationInput {
  /** Σ of the batch's signed amounts, after `bankAmountFrom*`. */
  readonly sumAmount: string;
  readonly openingBalance: string;
  readonly closingBalance: string;
  readonly accountType: BankAccountType;
}

export interface ReconciliationResult {
  readonly expected: string;
  readonly actual: string;
  readonly difference: string;
  readonly reconciled: boolean;
}

/**
 * The `IMP-BAL-006` gate (§8.2): `Σ amount = closing − opening`, and for a liability account
 * `−Σ amount = closing − opening` (ADR-028) — a card's spending raises the balance owed, so the
 * movement and the balance run in opposite directions.
 */
export function bankReconciliation(input: ReconciliationInput): ReconciliationResult {
  const sum = parseMoney(input.sumAmount);
  const actual = isLiabilityBankAccount(input.accountType) ? negate(sum) : sum;
  const expected = parseMoney(input.closingBalance).minus(parseMoney(input.openingBalance));
  const difference = actual.minus(expected);
  return {
    expected: toMoneyString(expected),
    actual: toMoneyString(actual),
    difference: toMoneyString(difference),
    reconciled: difference.abs().lessThanOrEqualTo(new Decimal('0.01')),
  };
}

// -----------------------------------------------------------------------------------------------
// GL direction (§6.4)
// -----------------------------------------------------------------------------------------------

export type EntryDirection = 'debit' | 'credit';

export interface DirectedAmountResult {
  readonly direction: EntryDirection | null;
  /** Unsigned; `ledger_entries.amount` never carries the sign (the direction does). */
  readonly amount: string | null;
  readonly issue: RowIssue | null;
}

/**
 * Debit/credit columns → `direction` + a positive amount (§6.4).
 *
 * A row with figures in both columns is not a journal line, it is two; netting it would post a
 * single line for the difference and lose both originals.
 */
export function glFromDebitCredit(
  debit: string | null | undefined,
  credit: string | null | undefined,
): DirectedAmountResult {
  /*
   * Unreadable input is REPORTED, not thrown.
   *
   * This function's own return type carries an `issue` for exactly this case, and it could not
   * honour that contract while parsing with something that raises: a header row reaching it as data
   * — "Debit" in the debit column — took down the whole import rather than becoming one flagged row
   * (ADR-058.5).
   */
  const debitRead = readMoneyCell(debit, 'debit');
  if (debitRead.issue !== null) return { direction: null, amount: null, issue: debitRead.issue };
  const creditRead = readMoneyCell(credit, 'credit');
  if (creditRead.issue !== null) return { direction: null, amount: null, issue: creditRead.issue };

  const debitValue = debitRead.value;
  const creditValue = creditRead.value;
  const debitPosted = debitValue !== null && !debitValue.isZero();
  const creditPosted = creditValue !== null && !creditValue.isZero();

  if (debitPosted && creditPosted) {
    return {
      direction: null,
      amount: null,
      issue: {
        code: 'IMP-AMT-002',
        severity: 'error',
        message: 'This row has both a debit and a credit amount',
        suggestion: 'Split the row into one line per side of the journal.',
      },
    };
  }
  if (debitPosted) return { direction: 'debit', amount: toMoneyString(debitValue.abs()), issue: null };
  if (creditPosted) return { direction: 'credit', amount: toMoneyString(creditValue.abs()), issue: null };
  if (debitValue !== null || creditValue !== null) {
    // A posted zero is a real line in some exports; it keeps the side it was written on.
    const direction: EntryDirection = debitValue !== null ? 'debit' : 'credit';
    return { direction, amount: toMoneyString(ZERO), issue: null };
  }
  return { direction: null, amount: null, issue: null };
}

/** What a balance report row's money columns state, in natural sign (§3, ADR-047.3). */
export interface BalanceFromColumns {
  /** debit − credit; NULL when neither column holds a figure (the row states no balance). */
  readonly closing: string | null;
  readonly debitTotal: string | null;
  readonly creditTotal: string | null;
}

/**
 * H-2 (Step 0E): a trial balance's Debit / Credit columns → its natural-sign balance.
 *
 * Unlike a journal line (`glFromDebitCredit`), a balance row may carry BOTH: a movement trial
 * balance states the period's debit and credit totals per account. The balance is their difference,
 * natural sign by construction (§6.1), so no sign question is asked of it. A blank column is a side
 * with no figure; BOTH blank is a row that states nothing — left NULL for validation to report
 * (the "neither debit nor credit" required-field error), never a 0.00. Unreadable cells are left for
 * the column's own number check (IMP-AMT-002).
 */
export function balanceFromDebitCredit(
  debit: string | null | undefined,
  credit: string | null | undefined,
): BalanceFromColumns {
  const debitRead = readMoneyCell(debit, 'debit');
  const creditRead = readMoneyCell(credit, 'credit');
  if (debitRead.issue !== null || creditRead.issue !== null) return { closing: null, debitTotal: null, creditTotal: null };
  if (debitRead.value === null && creditRead.value === null) return { closing: null, debitTotal: null, creditTotal: null };
  const d = debitRead.value ?? ZERO;
  const c = creditRead.value ?? ZERO;
  return {
    closing: toMoneyString(d.minus(c)),
    debitTotal: debitRead.value === null ? null : toMoneyString(debitRead.value),
    creditTotal: creditRead.value === null ? null : toMoneyString(creditRead.value),
  };
}

/**
 * A signed single column: "positive = debit unless the user overrides in `transforms.glSign`"
 * (§6.4). Unlike the bank sign this one HAS a stated default, so it does not ask.
 */
export function glFromSigned(amount: string, glSign: GlSign = 'positive_debit'): DirectedAmountResult {
  const read = readMoneyCell(amount, 'amount');
  if (read.issue !== null) return { direction: null, amount: null, issue: read.issue };
  if (read.value === null) return { direction: null, amount: null, issue: null };

  const value = read.value;
  const positiveIsDebit = glSign === 'positive_debit';
  const isDebit = value.isNegative() ? !positiveIsDebit : positiveIsDebit;
  return { direction: isDebit ? 'debit' : 'credit', amount: toMoneyString(value.abs()), issue: null };
}

// -----------------------------------------------------------------------------------------------
// Balance sign (§6.4, ADR-047.3)
// -----------------------------------------------------------------------------------------------

/** One mapped TB / P&L / balance-sheet row, as the detector needs it. */
export interface BalanceSignRow {
  /** The signed value from the file's single balance column. */
  readonly amount: string;
  /** The category suggested for the row's account (`mapping/category-keywords.ts`). */
  readonly category: StandardCategory;
  /** The account label, so the confirmation can quote two real rows. */
  readonly label?: string;
}

export interface BalanceSignSample {
  readonly label: string | null;
  readonly amount: string;
  readonly category: StandardCategory;
}

export interface BalanceSignDetection {
  /** What the mapping step proposes; `IMP-TB-013` records the reviewer's confirmation. */
  readonly proposed: BalanceSign;
  readonly incomeTotal: string;
  readonly expenseTotal: string;
  readonly incomeRows: number;
  readonly expenseRows: number;
  /** The two sample rows §6.4 shows: "Sales 10,000 will be read as income; Rent 2,000 as an expense". */
  readonly incomeSample: BalanceSignSample | null;
  readonly expenseSample: BalanceSignSample | null;
}

/**
 * Propose `natural` or `reporting` for a single signed balance column (§6.4, ADR-047.3).
 *
 * "Both positive → propose `reporting`": every P&L from Xero, QuickBooks or Sage prints income and
 * expenses as positive numbers, which cannot both be natural sign — in natural sign (debit − credit)
 * income is negative. If either side comes back negative or zero the file is already natural and is
 * left alone.
 *
 * A file with separate debit and credit columns never reaches here: §6.1 makes that `natural` by
 * construction.
 */
export function detectBalanceSign(rows: readonly BalanceSignRow[]): BalanceSignDetection {
  let incomeTotal = ZERO;
  let expenseTotal = ZERO;
  let incomeRows = 0;
  let expenseRows = 0;
  let incomeSample: BalanceSignSample | null = null;
  let expenseSample: BalanceSignSample | null = null;

  for (const row of rows) {
    const type = CATEGORY_ACCOUNT_TYPE[row.category];
    const value = parseMoney(row.amount);
    if (type === 'income') {
      incomeTotal = incomeTotal.plus(value);
      incomeRows += 1;
      incomeSample = incomeSample ?? { label: row.label ?? null, amount: toMoneyString(value), category: row.category };
    } else if (type === 'expense') {
      expenseTotal = expenseTotal.plus(value);
      expenseRows += 1;
      expenseSample = expenseSample ?? { label: row.label ?? null, amount: toMoneyString(value), category: row.category };
    }
  }

  const bothPositive = incomeTotal.greaterThan(ZERO) && expenseTotal.greaterThan(ZERO);
  return {
    proposed: bothPositive ? 'reporting' : 'natural',
    incomeTotal: toMoneyString(incomeTotal),
    expenseTotal: toMoneyString(expenseTotal),
    incomeRows,
    expenseRows,
    incomeSample,
    expenseSample,
  };
}

/**
 * Apply the confirmed balance sign at commit (§6.4, ADR-047.3).
 *
 * `reporting` negates income-, liability- and equity-type lines so that what is stored is always
 * natural sign (debit − credit). "The engine never sees reporting sign": every reader downstream
 * assumes natural, so this is the last point at which the two conventions exist.
 */
export function applyBalanceSign(
  amount: string,
  category: StandardCategory,
  balanceSign: BalanceSign,
): string {
  const value = parseMoney(amount);
  if (balanceSign === 'natural') return toMoneyString(value);
  const type = CATEGORY_ACCOUNT_TYPE[category];
  const negated = type === 'income' || type === 'liability' || type === 'equity';
  return toMoneyString(negated ? negate(value) : value);
}
