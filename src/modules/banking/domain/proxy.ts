/**
 * Bank data → cash accounts, and the bank-basis P&L proxy (FINANCIAL_ENGINE.md §4.4;
 * ADR-028, ADR-047.12, CD-33).
 *
 * Pure. Two different account sets are used here and confusing them is the defect ADR-028 was
 * written to fix, so they are named separately and never derived from each other:
 *
 *  - CASH accounts are `{current, savings}` only. Nothing else feeds `opening_cash`/`closing_cash`.
 *    A credit-card or loan account holds a debt balance; adding it to cash would report borrowed
 *    money as money in the bank.
 *  - PROXY accounts are ALL active accounts, liability accounts included. A card purchase IS an
 *    expense of the business and appears only on the card statement; leaving the card out would
 *    understate expenses by every card purchase. The repayment leg is not an expense, which is why
 *    the proxy excludes `is_transfer` rows of every kind rather than only the cash-neutral one.
 */

import { Decimal, abs, cashDirection, roundRatio, toMoneyString, toRatioString } from '@/core/money';
import { PNL_CATEGORIES, STANDARD_CATEGORIES, type StandardCategory } from '@/modules/financials';
import { uncategorisedShare } from './categorisation';
import { isCashLikeAccountType } from './transfers';
import type { BankAccountType, TransferKind } from './types';

/**
 * `NON_PNL` (§3): "never counted in P&L".
 *
 * Derived from `PNL_CATEGORIES` rather than listed by hand, so the two sets cannot drift apart. The
 * result is exactly §3's enumeration — `{transfer, drawings, equity, loan, credit_card,
 * tax_liability, …asset/liability categories}` — plus `uncategorised`, which belongs here for the
 * same reason: an unclassified movement is not evidence of profit.
 */
export const NON_PNL_CATEGORIES: readonly StandardCategory[] = STANDARD_CATEGORIES.filter(
  (category) => !PNL_CATEGORIES.includes(category),
);

export function isNonPnlCategory(category: StandardCategory): boolean {
  return NON_PNL_CATEGORIES.includes(category);
}

// ---------------------------------------------------------------------------------------------
// Account sets (§4.4 sentence 1)
// ---------------------------------------------------------------------------------------------

/** A subset of the engine's `BankAccountRef`, so one can be passed straight in. */
export interface ProxyBankAccount {
  readonly id: string;
  readonly accountType: BankAccountType;
  readonly isActive: boolean;
}

/** The accounts that feed `opening_cash` and `closing_cash`: active, `{current, savings}` only. */
export function cashAccountIds(accounts: readonly ProxyBankAccount[]): string[] {
  return accounts
    .filter((a) => a.isActive && isCashLikeAccountType(a.accountType))
    .map((a) => a.id)
    .sort();
}

/**
 * The accounts the proxy reads: every ACTIVE account, liability accounts included (§4.4).
 *
 * Sorted, because this list is written verbatim into the evidence descriptor and a descriptor whose
 * array order wobbled would hash differently on two runs over identical data.
 */
export function proxyBankAccountIds(accounts: readonly ProxyBankAccount[]): string[] {
  return accounts.filter((a) => a.isActive).map((a) => a.id).sort();
}

// ---------------------------------------------------------------------------------------------
// The proxy
// ---------------------------------------------------------------------------------------------

/** A subset of `BankTransaction` plus its resolved standard category. */
export interface ProxyTransaction {
  readonly id: string;
  readonly bankAccountId: string;
  /** Signed: positive is an inflow. */
  readonly amount: string;
  /** `null` when nothing categorised it — counted for completeness, never for a figure. */
  readonly standardCategory: StandardCategory | null;
  readonly categoryAccountId: string | null;
  readonly isTransfer: boolean;
  readonly transferKind: TransferKind;
}

/** The VAT settings the proxy nets down with (ADR-047.5, CD-33). */
export interface ProxyVatSettings {
  readonly vatRegistered: boolean;
  /** e.g. `'0.20'`. `null` means no rate is configured, so nothing is netted. */
  readonly defaultVatRate: string | null;
  /** `platform_settings.taxable_categories`; default `{revenue, cost_of_sales, operating_expense, marketing}`. */
  readonly taxableCategories: readonly StandardCategory[];
}

export interface BankProxyInput {
  readonly periodId: string;
  /** Accepted rows in the period, on the proxy account set. */
  readonly transactions: readonly ProxyTransaction[];
  readonly bankAccounts: readonly ProxyBankAccount[];
  /**
   * Whether ANY credit-card statement covers this period (§2.2's bank coverage test applied to
   * `account_type = 'credit_card'`). Supplied by the caller because coverage is computed from
   * declared batch ranges, which are not visible to `domain/`.
   */
  readonly cardStatementCoversPeriod: boolean;
  readonly vat: ProxyVatSettings;
}

/**
 * The warnings this module can raise. Every member is also a member of the engine's
 * `DATA_QUALITY_WARNINGS`, so the result is assignable to `DataQuality` without a cast; it is spelt
 * locally because `financial-engine` has no public index yet and `domain/` may not deep-import
 * another module (ADR-022).
 */
export type ProxyWarning =
  | 'cash_basis_proxy' | 'vat_inclusive' | 'card_spend_unclassified' | 'uncategorised_amounts';

export type ProxyMissing = 'uncategorised_amounts_exceed_threshold';

/** §3.1's thresholds on the uncategorised share, applied to the bank basis. */
export const UNCATEGORISED_WARNING_THRESHOLD = '0.05';
export const UNCATEGORISED_MISSING_THRESHOLD = '0.25';

/**
 * The descriptor filters a proxy P&L metric carries (ADR-047.12).
 *
 * `exclude_transfers: 'all'` — not a boolean — because the proxy drops `is_transfer` rows of EVERY
 * kind, while the cash metrics drop only the cash-neutral ones. The evidence drawer must reconcile
 * to the same set the figure was computed from, so the two filters cannot share a spelling.
 *
 * KNOWN CONTRADICTION, unresolved in the documents (recorded at ADR-048.7 as needing a product
 * decision before this phase): `EVIDENCE_MODEL.md §3` and the Phase-2 descriptor schema define
 * `exclude_cash_transfers: boolean`, and carry no `exclude_transfers` key at all. A descriptor built
 * from this shape will be REJECTED by the v1 schema until that decision is taken. This module
 * follows ADR-047.12 as instructed and keeps the shape in its own type rather than claiming to be a
 * `LeafDescriptor`.
 */
export interface ProxyDescriptorFilters {
  readonly period_ids: readonly string[];
  readonly bank_account_ids: readonly string[];
  readonly exclude_transfers: 'all';
}

export interface ProxyCategoryAmount {
  readonly category: StandardCategory;
  /** Positive, 2 dp. */
  readonly amount: string;
}

export interface BankProxyResult {
  readonly periodId: string;
  /** Σ inflows categorised `revenue`, 2 dp. */
  readonly revenue: string;
  /** One entry per expense category with rows, sorted by category. Absence ≠ zero (§3.1). */
  readonly expensesByCategory: readonly ProxyCategoryAmount[];
  readonly totalExpenses: string;
  /** Σ|amount| with no category, and the resulting completeness (§5). */
  readonly uncategorisedAmount: string;
  readonly uncategorisedShare: string;
  readonly completeness: number;
  /** Always true: the proxy stands in for an accrual figure it is not (§2.3). */
  readonly proxy: true;
  readonly assurance: 'estimated';
  readonly warnings: readonly ProxyWarning[];
  readonly missing: readonly ProxyMissing[];
  /** Named inputs, so a reader can redo the arithmetic by hand (§1.7). */
  readonly components: {
    readonly vat_rate_applied: string | null;
    readonly taxable_categories: readonly StandardCategory[];
    readonly bank_account_ids: readonly string[];
    readonly excluded_transfer_rows: number;
    readonly excluded_non_pnl_rows: number;
    /**
     * Inflows sitting in an expense category — a supplier refund, say. §4.4 maps only `revenue`
     * inflows and only outflows to expenses, so these enter no figure; the total is recorded here so
     * a movement the proxy could not place is visible rather than invisible.
     */
    readonly inflows_in_expense_categories: string;
  };
  readonly descriptor: ProxyDescriptorFilters;
}

/**
 * `card_spend_unclassified` (§4.4 last sentence, ADR-047.12).
 *
 * When a cash-like account shows outflows categorised `credit_card` the business is paying down a
 * card — so card SPEND exists — and if no card statement covers the period the engine has never seen
 * what that spend was on. Proxy expenses are then understated by exactly the unseen card purchases,
 * and the flag says so on every proxy P&L metric for the period rather than letting the figure look
 * merely small.
 */
export function hasUnclassifiedCardSpend(input: {
  readonly transactions: readonly ProxyTransaction[];
  readonly bankAccounts: readonly ProxyBankAccount[];
  readonly cardStatementCoversPeriod: boolean;
}): boolean {
  if (input.cardStatementCoversPeriod) return false;
  const cashLike = new Set(
    input.bankAccounts.filter((a) => isCashLikeAccountType(a.accountType)).map((a) => a.id),
  );
  return input.transactions.some(
    (t) =>
      cashLike.has(t.bankAccountId) &&
      t.standardCategory === 'credit_card' &&
      cashDirection(t.amount) === 'outflow',
  );
}

/**
 * Net a VAT-inclusive figure down to its VAT-exclusive equivalent.
 *
 * `gross / (1 + rate)`, not `gross × (1 − rate)`: a 20%-inclusive £120 is £100 plus £20, and the
 * second formula would give £96.
 */
export function netOfVat(gross: Decimal, rate: Decimal): Decimal {
  const divisor = new Decimal(1).plus(rate);
  return divisor.isZero() ? gross : gross.dividedBy(divisor);
}

/**
 * Build the bank-basis P&L proxy for one period (§4.4).
 *
 * Order of operations, and each step's reason:
 *  1. Drop every `is_transfer` row of EVERY kind (ADR-047.12) — a transfer is not trade.
 *  2. Drop every `NON_PNL` category — a drawing, an equity injection or a loan repayment is not a
 *     cost, and `transfer` is a holding category rather than a statement line.
 *  3. Inflows in `revenue` → revenue; outflows by category → expenses.
 *  4. Net the taxable categories down by the VAT rate when the organization is registered.
 *
 * Uncategorised amounts are measured over the rows that SURVIVED step 1 — a transfer nobody
 * categorised is not a hole in the P&L — and drive `completeness` (§5).
 */
export function buildBankProxy(input: BankProxyInput): BankProxyResult {
  const accountIds = new Set(proxyBankAccountIds(input.bankAccounts));
  const inScope = [...input.transactions]
    .filter((t) => accountIds.has(t.bankAccountId))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const nonTransfer = inScope.filter((t) => !t.isTransfer);
  const excludedTransferRows = inScope.length - nonTransfer.length;

  const share = uncategorisedShare(
    nonTransfer.map((t) => ({ amount: t.amount, categoryAccountId: t.categoryAccountId })),
  );

  let revenue = new Decimal(0);
  let inflowsInExpenseCategories = new Decimal(0);
  let excludedNonPnlRows = 0;
  const expenses = new Map<StandardCategory, Decimal>();

  for (const transaction of nonTransfer) {
    const category = transaction.standardCategory;
    if (category === null) continue; // Uncategorised: counted above, never in a figure.
    if (isNonPnlCategory(category)) {
      excludedNonPnlRows += 1;
      continue;
    }
    const direction = cashDirection(transaction.amount);
    if (direction === null) continue; // Exactly zero is in neither set (§3.3).
    if (category === 'revenue') {
      if (direction === 'inflow') revenue = revenue.plus(abs(transaction.amount));
      // A revenue-category OUTFLOW is a refund; §4.4 maps only inflows to revenue, so it is left to
      // the accrual bases rather than netted here on an assumption the document does not make.
      else inflowsInExpenseCategories = inflowsInExpenseCategories.plus(abs(transaction.amount));
      continue;
    }
    if (direction === 'inflow') {
      inflowsInExpenseCategories = inflowsInExpenseCategories.plus(abs(transaction.amount));
      continue;
    }
    expenses.set(category, (expenses.get(category) ?? new Decimal(0)).plus(abs(transaction.amount)));
  }

  // ---- VAT netting (§2.3, ADR-027.4, CD-33) ----
  const rate =
    input.vat.vatRegistered && input.vat.defaultVatRate !== null
      ? new Decimal(input.vat.defaultVatRate)
      : null;
  const taxable = new Set(input.vat.taxableCategories);
  if (rate !== null) {
    if (taxable.has('revenue')) revenue = netOfVat(revenue, rate);
    for (const [category, amount] of expenses) {
      if (taxable.has(category)) expenses.set(category, netOfVat(amount, rate));
    }
  }

  const expensesByCategory = [...expenses.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([category, amount]) => ({ category, amount: toMoneyString(amount) }));
  const totalExpenses = [...expenses.values()].reduce((t, v) => t.plus(v), new Decimal(0));

  // ---- Data quality (§2.3, §3.1, §5) ----
  // §2.3: bank-basis P&L figures carry `cash_basis_proxy` and `vat_inclusive` as standing warnings.
  // `vat_inclusive` stays even after netting, because netting by a single default rate is itself an
  // estimate — it is not the per-row tax the accrual bases use (§3, ADR-047.5).
  const warnings: ProxyWarning[] = ['cash_basis_proxy', 'vat_inclusive'];
  const missing: ProxyMissing[] = [];
  const shareDecimal = new Decimal(share.share);
  if (shareDecimal.greaterThan(UNCATEGORISED_WARNING_THRESHOLD)) warnings.push('uncategorised_amounts');
  if (shareDecimal.greaterThan(UNCATEGORISED_MISSING_THRESHOLD)) {
    missing.push('uncategorised_amounts_exceed_threshold');
  }
  if (
    hasUnclassifiedCardSpend({
      transactions: nonTransfer,
      bankAccounts: input.bankAccounts,
      cardStatementCoversPeriod: input.cardStatementCoversPeriod,
    })
  ) {
    warnings.push('card_spend_unclassified');
  }

  const descriptorAccountIds = proxyBankAccountIds(input.bankAccounts);

  return {
    periodId: input.periodId,
    revenue: toMoneyString(revenue),
    expensesByCategory,
    totalExpenses: toMoneyString(totalExpenses),
    uncategorisedAmount: share.uncategorisedAmount,
    uncategorisedShare: share.share,
    completeness: share.completeness,
    proxy: true,
    // §2.3: the bank basis is a cash proxy for an accrual figure, so it is never better than
    // `estimated` — VAT netting does not improve it.
    assurance: 'estimated',
    warnings,
    missing,
    components: {
      vat_rate_applied: rate === null ? null : toRatioString(roundRatio(rate)),
      taxable_categories: [...input.vat.taxableCategories].sort(),
      bank_account_ids: descriptorAccountIds,
      excluded_transfer_rows: excludedTransferRows,
      excluded_non_pnl_rows: excludedNonPnlRows,
      inflows_in_expense_categories: toMoneyString(inflowsInExpenseCategories),
    },
    descriptor: {
      period_ids: [input.periodId],
      bank_account_ids: descriptorAccountIds,
      exclude_transfers: 'all',
    },
  };
}
