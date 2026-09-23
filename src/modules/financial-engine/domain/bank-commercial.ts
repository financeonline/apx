/**
 * The bank-basis commercial population: which bank rows are a customer's revenue or a supplier's
 * spend (FINANCIAL_ENGINE.md §3.5, §4.4; ADR-110).
 *
 * Pure. This file is the ONE place that answers "is this bank row part of a counterparty's figure?".
 * The figure (`bankCommercialSelection`) and the evidence descriptor
 * (`bankCommercialFilters()`) are both read off the same `BankCommercialPopulation` value, so they
 * cannot select different rows. Before ADR-110 they were two unrelated rules: the figure summed the
 * magnitude of every non-revenue cell a party had — uncategorised rows, transfer legs and inflows
 * included — while the descriptor selected expense-category, non-transfer outflows. A supplier could
 * show 8,850.00 of spend over a drill-down of 0.00 (HIGH-3).
 *
 * The rule, from the contract rather than invented here:
 *
 *  - CUSTOMER revenue: INFLOWS categorised `revenue` (§3.5: "bank basis: inflows with
 *    `counterparty_id`"). These are a subset of the rows the bank-basis `revenue` line sums (§4.4:
 *    "maps inflows in `revenue` category to `revenue`"), so §3.5's identity
 *    `Σ customer_revenue + unattributed = revenue` holds with Unattributed being revenue inflows that
 *    name no customer. A revenue-categorised OUTFLOW (a refund) is in neither: §4.4 maps only inflows
 *    to revenue and leaves refunds to the accrual bases rather than netting them on an assumption the
 *    document does not make (`banking/domain/proxy.ts`). `other_income` is not a customer's revenue.
 *  - SUPPLIER spend: OUTFLOWS categorised in an expense category, i.e. `cost_of_sales ∪ OPEX_SET`
 *    (§3.5: "bank outflows with `counterparty_id`"; §4.4: "outflows by category to expenses"). Every
 *    expense category maps to an `expense` account type and nothing else does, so the account type
 *    is the set. An expense-categorised INFLOW (a supplier refund) enters no figure, as in the proxy.
 *  - TRANSFERS of EVERY kind are excluded (§4.4, ADR-047.12). A transfer moves money between the
 *    business's own accounts, or repays its own debt; it is nobody's revenue and nobody's spend,
 *    whatever category it happens to carry. `is_transfer ⇔ transfer_kind <> 'none'` is a table
 *    constraint, so the cell's kind and the descriptor's `exclude_transfers: 'all'` (which filters
 *    `is_transfer`) name the same rows.
 *  - UNCATEGORISED rows are excluded. §4.4 counts them "for completeness, never for a figure" and
 *    `NON_PNL_CATEGORIES` includes `uncategorised`: an unclassified movement is not evidence of
 *    revenue or of spend, and the bank-basis P&L already leaves it out and flags it
 *    (`uncategorised_amounts`). A payment with a supplier's name on it is not spend until someone
 *    says what it was for.
 *  - `other_income`, equity (owner funding), loans, drawings and every other non-P&L category are
 *    outside both sides by the category sets above, whoever the counterparty is.
 *
 * DIRECTION is one rule for the whole bank basis, `bankLineDirection`: an income-type category counts
 * its inflows and an expense-type category its outflows. The P&L fold, the P&L descriptors and the
 * two populations here all take it from that function, which is also what lets every bank descriptor
 * carry a `direction` and so total as the positive magnitude the figure states (ADR-109).
 */

import { Decimal, parseDecimalOrNull } from '@/core/money';
import type { AccountRef, AggregateCell, LeafDescriptor } from './types';

export type CommercialSide = 'customer' | 'supplier';

/**
 * Which side of a bank row an account's figure counts on the bank basis (§4.4), or `null` for a
 * category that is not a P&L line and so has no bank-basis figure to direct.
 */
export function bankLineDirection(accountType: AccountRef['accountType']): 'inflow' | 'outflow' | null {
  if (accountType === 'income') return 'inflow';
  if (accountType === 'expense') return 'outflow';
  return null;
}

/**
 * The part of a bank aggregate cell a P&L line counts: its inflows for an income category, its
 * outflows for an expense category, as a positive magnitude.
 *
 * A bank cell carries the two separately — `debit` is Σ of the positive amounts and `credit` is Σ of
 * the magnitudes of the negative ones (`app.aggregate_periods`) — which is exactly the row-level
 * `amount > 0` / `amount < 0` split a descriptor's `direction` compiles to.
 */
export function bankDirectedPart(cell: AggregateCell, direction: 'inflow' | 'outflow'): Decimal {
  return parseDecimalOrNull(direction === 'inflow' ? cell.debit : cell.credit) ?? new Decimal(0);
}

/**
 * The selection contract for one side. A class with a private constructor, so it is nominal: the only
 * way to obtain one is `bankCommercialPopulation`, and a descriptor cannot be assembled from some
 * other account list and still type-check.
 */
export class BankCommercialPopulation {
  private constructor(
    readonly side: CommercialSide,
    /** The category accounts that qualify, sorted: the descriptor stores it verbatim. */
    readonly categoryAccountIds: readonly string[],
    readonly direction: 'inflow' | 'outflow',
  ) {}

  /** @internal Use `bankCommercialPopulation`. */
  static of(accounts: readonly AccountRef[], side: CommercialSide): BankCommercialPopulation {
    const categoryAccountIds = accounts
      .filter((a) => (side === 'customer' ? a.standardCategory === 'revenue' : a.accountType === 'expense'))
      .map((a) => a.id)
      .sort();
    return new BankCommercialPopulation(side, categoryAccountIds, bankLineDirection(side === 'customer' ? 'income' : 'expense')!);
  }
}

/** Build the population for one side from the chart as it stood when the run executed (ADR-034). */
export function bankCommercialPopulation(
  accounts: readonly AccountRef[],
  side: CommercialSide,
): BankCommercialPopulation {
  return BankCommercialPopulation.of(accounts, side);
}

/**
 * The part of one aggregate cell that belongs to the population, as a positive magnitude, or `null`
 * when none of it does.
 */
export function bankCommercialCellAmount(
  cell: AggregateCell,
  population: BankCommercialPopulation,
): Decimal | null {
  if (cell.source !== 'bank') return null;
  if ((cell.transferKind ?? 'none') !== 'none') return null;
  if (cell.accountId === null || !population.categoryAccountIds.includes(cell.accountId)) return null;
  const part = bankDirectedPart(cell, population.direction);
  // A cell with no rows on the population's side names nothing to re-select.
  return part.isZero() ? null : part;
}

/**
 * The figure: Σ of the population per counterparty for one period. `counterpartyId = null` is the
 * rows with no party, which the concentration family folds into Unattributed.
 */
export function bankCommercialSelection(
  cells: readonly AggregateCell[],
  periodId: string,
  population: BankCommercialPopulation,
): ReadonlyArray<{ counterpartyId: string | null; amount: string }> {
  const totals = new Map<string | null, Decimal>();
  for (const cell of cells) {
    if (cell.periodId !== periodId) continue;
    const amount = bankCommercialCellAmount(cell, population);
    if (amount === null) continue;
    totals.set(cell.counterpartyId, (totals.get(cell.counterpartyId) ?? new Decimal(0)).plus(amount));
  }
  return [...totals.entries()]
    .map(([counterpartyId, amount]) => ({ counterpartyId, amount: amount.toFixed(2) }))
    .sort((a, b) => (a.counterpartyId ?? '￿').localeCompare(b.counterpartyId ?? '￿'));
}

/**
 * The evidence: the descriptor filters that re-select the population. Together with the period and
 * the counterparty ids the caller adds, these are the rows the figure summed, and the compiler's
 * directional amount basis (ADR-109) totals them as the same positive magnitudes.
 */
export function bankCommercialFilters(
  population: BankCommercialPopulation,
): Pick<LeafDescriptor['filters'], 'category_account_ids' | 'direction' | 'exclude_transfers'> {
  return {
    category_account_ids: [...population.categoryAccountIds],
    direction: population.direction,
    exclude_transfers: 'all',
  };
}
