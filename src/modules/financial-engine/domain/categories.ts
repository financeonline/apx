/**
 * The category sets the engine is defined over (FINANCIAL_ENGINE.md §3, "Category sets").
 *
 * A metric is a sum over a set of standard categories. Writing those sets down once, here, is what
 * stops `operating_expenses` and `expense_by_category` drifting apart: both read the same set, so a
 * category added to one is added to the other by construction.
 *
 * The sets also form a PARTITION of `STANDARD_CATEGORIES` — P&L, balance sheet, holding — and
 * `assertCategoryPartition` proves it. That matters because a 27th category added later would
 * otherwise land in no set at all and silently disappear from every statement rather than failing a
 * test (`test/unit/engine-pnl.test.ts` runs the assertion).
 */

import {
  CATEGORY_ACCOUNT_TYPE,
  PNL_CATEGORIES,
  STANDARD_CATEGORIES,
  type StandardCategory,
} from '@/modules/financials';

/** A bank account's kind (`bank_accounts.account_type`), mirrored from `@/modules/banking`. */
export type BankAccountType = 'current' | 'savings' | 'credit_card' | 'loan' | 'other';

/** Build a readonly set without letting a caller mutate the engine's definition of a statement. */
function frozenSet(categories: readonly StandardCategory[]): ReadonlySet<StandardCategory> {
  return new Set(categories);
}

/**
 * Operating expenses (§3): the four categories `operating_expenses` sums, and the four whose
 * variance the cost-control health dimension reads. `cost_of_sales` is deliberately NOT here — it
 * sits above the gross-profit line, and including it would double-count it in `operating_profit`.
 */
export const OPEX_CATEGORIES: readonly StandardCategory[] = [
  'operating_expense', 'payroll', 'marketing', 'depreciation',
];
export const OPEX_SET: ReadonlySet<StandardCategory> = frozenSet(OPEX_CATEGORIES);

/**
 * Below the operating-profit line (§3): the four categories `net_profit` applies AFTER
 * `operating_profit`. `other_income` is an income category and the other three are expenses; they
 * are grouped because they share a position on the statement, not a sign.
 */
export const BELOW_LINE_CATEGORIES: readonly StandardCategory[] = [
  'other_income', 'other_expense', 'interest_expense', 'tax_expense',
];
export const BELOW_LINE: ReadonlySet<StandardCategory> = frozenSet(BELOW_LINE_CATEGORIES);

/** Cash-carrying categories (§3). Used by the cash family and by `working_capital`. */
export const CASH_CATEGORIES: readonly StandardCategory[] = ['cash'];
export const CASH_SET: ReadonlySet<StandardCategory> = frozenSet(CASH_CATEGORIES);

/**
 * Bank account types that count as cash (§3, ADR-028).
 *
 * A credit card or a loan account holds a liability, not cash: including one would report borrowed
 * money as a cash balance. The cash-like LEG of a payment to such an account is still an outflow —
 * that rule lives in the banking module, not here.
 */
export const CASH_LIKE_BANK_ACCOUNT_TYPES: ReadonlySet<BankAccountType> =
  new Set<BankAccountType>(['current', 'savings']);

export function isCashLikeBankAccount(accountType: BankAccountType): boolean {
  return CASH_LIKE_BANK_ACCOUNT_TYPES.has(accountType);
}

/**
 * The profit-and-loss categories, in statement order (`PNL_CATEGORIES`, ADR-004).
 *
 * Re-exported through a set rather than redefined: a second list would be a second place for the
 * statement to be wrong.
 */
export const PNL_SET: ReadonlySet<StandardCategory> = frozenSet(PNL_CATEGORIES);

/**
 * Balance-sheet categories: every asset, liability and equity category EXCEPT the two holding
 * categories. These are the ones stated as a closing position rather than a period flow, which is
 * why §3 differences them differently under `cumulative` and `movement` bases.
 */
export const BALANCE_SHEET_CATEGORIES: readonly StandardCategory[] = [
  'cash', 'receivables', 'inventory', 'other_current_asset', 'fixed_asset', 'other_asset',
  'payables', 'credit_card', 'loan', 'tax_liability', 'other_current_liability',
  'long_term_liability', 'equity', 'drawings',
];
export const BALANCE_SHEET_SET: ReadonlySet<StandardCategory> = frozenSet(BALANCE_SHEET_CATEGORIES);

/**
 * The two holding categories (ADR-004). Neither is a statement line: `transfer` is money moving
 * between the organization's own accounts and `uncategorised` is work not yet done. Both are typed
 * `asset` precisely so that a mis-set category can never move a profit figure.
 */
export const HOLDING_CATEGORIES: readonly StandardCategory[] = ['transfer', 'uncategorised'];
export const HOLDING_SET: ReadonlySet<StandardCategory> = frozenSet(HOLDING_CATEGORIES);

/**
 * Never counted in the P&L (§3): the balance-sheet categories plus the two holding categories.
 *
 * §3 spells the set as "{transfer, drawings, equity, loan, credit_card, tax_liability, …asset /
 * liability categories}"; the ellipsis is expanded here to the complement of `PNL_SET`, and
 * `assertCategoryPartition` proves the expansion is exact.
 */
export const NON_PNL_CATEGORIES: readonly StandardCategory[] = [
  ...BALANCE_SHEET_CATEGORIES, ...HOLDING_CATEGORIES,
];
export const NON_PNL: ReadonlySet<StandardCategory> = frozenSet(NON_PNL_CATEGORIES);

/**
 * The input set of `expense_by_category` (§3.1): `OPEX_SET ∪ BELOW_LINE ∪ {cost_of_sales}`.
 *
 * Listed in `STANDARD_CATEGORIES` order so the dimensioned snapshots a run writes are in a fixed
 * order whatever order the aggregates arrived in — determinism is the product (§1.1).
 *
 * NOTE the set contains `other_income`, an INCOME category, because §3.1 says so. Its snapshot is
 * signed by account type like every other figure (§3's ledger rule), so
 * `expense_by_category[other_income]` equals the `other_income` metric rather than its negation.
 * See the comment on `reportingSignFor` in `sign.ts`.
 */
export const EXPENSE_BY_CATEGORY_CATEGORIES: readonly StandardCategory[] =
  STANDARD_CATEGORIES.filter(
    (c) => OPEX_SET.has(c) || BELOW_LINE.has(c) || c === 'cost_of_sales',
  );
export const EXPENSE_BY_CATEGORY_SET: ReadonlySet<StandardCategory> =
  frozenSet(EXPENSE_BY_CATEGORY_CATEGORIES);

/** Where a category sits in the partition. */
export type CategoryPlacement = 'pnl' | 'balance_sheet' | 'holding';

/** The three parts the engine divides the 26 categories into. */
export interface CategoryPartition {
  readonly pnl: ReadonlySet<StandardCategory>;
  readonly balanceSheet: ReadonlySet<StandardCategory>;
  readonly holding: ReadonlySet<StandardCategory>;
}

/** The partition the engine actually uses. */
export const ENGINE_PARTITION: CategoryPartition = {
  pnl: PNL_SET, balanceSheet: BALANCE_SHEET_SET, holding: HOLDING_SET,
};

export function placementOf(
  category: StandardCategory,
  partition: CategoryPartition = ENGINE_PARTITION,
): CategoryPlacement {
  if (partition.pnl.has(category)) return 'pnl';
  if (partition.balanceSheet.has(category)) return 'balance_sheet';
  return 'holding';
}

/**
 * Prove that every standard category is placed exactly once.
 *
 * Returns the offending categories rather than throwing, so the test can name them. A category in
 * two parts would be double-counted in `net_profit`; a category in none would vanish from the
 * statement without anything going red.
 *
 * The partition is a PARAMETER so the checker itself can be tested against a deliberately broken
 * one. A validator nobody has ever seen fail is a validator nobody knows works.
 */
export function categoryPartitionErrors(
  partition: CategoryPartition = ENGINE_PARTITION,
): readonly string[] {
  const errors: string[] = [];
  for (const category of STANDARD_CATEGORIES) {
    const memberships = [
      partition.pnl.has(category) ? 'pnl' : null,
      partition.balanceSheet.has(category) ? 'balance_sheet' : null,
      partition.holding.has(category) ? 'holding' : null,
    ].filter((m): m is string => m !== null);
    if (memberships.length !== 1) {
      errors.push(`${category} appears in ${memberships.length} sets (${memberships.join(', ') || 'none'})`);
    }
  }
  // The P&L sub-sets must themselves tile the P&L: revenue and cost_of_sales sit above the gross
  // line, OPEX between gross and operating profit, BELOW_LINE after it. Anything else would be a
  // P&L category no metric sums.
  for (const category of partition.pnl) {
    const inSubSet =
      category === 'revenue' || category === 'cost_of_sales'
      || OPEX_SET.has(category) || BELOW_LINE.has(category);
    if (!inSubSet) errors.push(`${category} is a P&L category no P&L metric sums`);
  }
  // A category typed `income` or `expense` that is not on the P&L, or a P&L category typed
  // otherwise, means the SQL CHECK constraint and this file disagree about what a statement is.
  for (const category of STANDARD_CATEGORIES) {
    const type = CATEGORY_ACCOUNT_TYPE[category];
    const isStatementType = type === 'income' || type === 'expense';
    if (isStatementType !== partition.pnl.has(category)) {
      errors.push(`${category} is typed ${type} but placement is ${placementOf(category, partition)}`);
    }
  }
  return errors;
}
