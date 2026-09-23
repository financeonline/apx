/**
 * The commercial population: which bank rows or ledger lines are a customer's revenue or a supplier's
 * spend (FINANCIAL_ENGINE.md §3.5, §4.4; ADR-110, ADR-111).
 *
 * Pure. This file is the ONE place that answers "is this row part of a counterparty's figure?" on the
 * bank and ledger bases. The figure (`commercialSelection`) and the evidence descriptor
 * (`commercialFilters`) are both read off the same `CommercialPopulation` value, so they cannot select
 * different rows. Before ADR-110 and ADR-111 they were two unrelated rules on both bases: the figure
 * summed the magnitude of every non-revenue cell a party had, while the descriptor selected expense
 * accounts. A bank supplier could show 8,850.00 over a drill-down of 0.00 (HIGH-3); a ledger supplier
 * whose contact sat on its payables and bank lines showed 11,300.00 over 6,100.00 (HIGH-5).
 *
 * The invoice basis does not come here. Its population is invoice types, with `app.invoice_net` as the
 * amount, and it already reconciles (ADR-103 to ADR-108).
 *
 * The rule, from the contract rather than invented here:
 *
 *  - CUSTOMER revenue: rows in `revenue` accounts (§3.5: "ledger basis: revenue-account entries with
 *    `counterparty_id`"; its descriptor is `standard_categories: [revenue]`). That is the population the
 *    `revenue` line sums, so §3.5's identity `Σ customer_revenue + unattributed = revenue` holds with
 *    Unattributed being revenue that names no customer. `other_income` is not a customer's revenue:
 *    `revenue` does not contain it.
 *  - SUPPLIER spend: rows in expense accounts, `cost_of_sales ∪ OPEX_SET` (§3.5). Every expense
 *    category maps to an `expense` account type and nothing else does, so the account type is the set.
 *    A payables control, bank, receivables or any other balance-sheet line is never spend, whatever
 *    contact a general-ledger export printed on it (HIGH-5).
 *
 * How each basis reads its rows:
 *
 *  - LEDGER: the reporting-sign net of the lines — credits less debits for revenue, debits less
 *    credits for an expense — which is the engine's account-type rule (`ledgerAmount`) and exactly how
 *    the P&L line is summed. A refund or a supplier credit reduces the party's figure, as a credit note
 *    does on the invoice basis. The descriptor is `account_ids`, and the evidence service totals a
 *    ledger selection in the same reporting sign (ADR-111).
 *  - BANK (ADR-110): the population's own side only — revenue INFLOWS, expense OUTFLOWS (§3.5 "inflows
 *    with `counterparty_id`", "bank outflows"; §4.4). TRANSFERS of every kind are excluded (§4.4,
 *    ADR-047.12; `is_transfer ⇔ transfer_kind <> 'none'` is a table constraint, so the cell's kind and
 *    the descriptor's `exclude_transfers: 'all'` name the same rows). UNCATEGORISED rows are excluded
 *    (§4.4: "for completeness, never for a figure"). A refund on the other side enters no bank figure,
 *    as in `banking/domain/proxy.ts`.
 *
 * DIRECTION on the bank basis is one rule, `bankLineDirection`: an income-type category counts its
 * inflows and an expense-type category its outflows. The bank P&L fold and the bank populations both
 * take it from that function, which is also what lets every bank descriptor carry a `direction` and so
 * total as the positive magnitude the figure states (ADR-109).
 */

import { Decimal, parseDecimalOrNull } from '@/core/money';
import { ledgerAmount } from './sign';
import type { AccountRef, AggregateCell, LeafDescriptor } from './types';

export type CommercialSide = 'customer' | 'supplier';
export type CommercialBasis = 'bank' | 'ledger';

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
 * The selection contract for one side on one basis. A class with a private constructor, so it is
 * nominal: the only way to obtain one is `commercialPopulation`, and a descriptor cannot be assembled
 * from some other account list and still type-check.
 */
export class CommercialPopulation {
  private constructor(
    readonly basis: CommercialBasis,
    readonly side: CommercialSide,
    /** The accounts that qualify, sorted: the descriptor stores it verbatim. */
    readonly accountIds: readonly string[],
  ) {}

  /** @internal Use `commercialPopulation`. */
  static of(accounts: readonly AccountRef[], basis: CommercialBasis, side: CommercialSide): CommercialPopulation {
    const accountIds = accounts
      .filter((a) => (side === 'customer' ? a.standardCategory === 'revenue' : a.accountType === 'expense'))
      .map((a) => a.id)
      .sort();
    return new CommercialPopulation(basis, side, accountIds);
  }

  /** The account type every account in the population has, which fixes the sign of its amounts. */
  get accountType(): 'income' | 'expense' {
    return this.side === 'customer' ? 'income' : 'expense';
  }

  /** The bank side the population counts (ADR-110). */
  get direction(): 'inflow' | 'outflow' {
    return bankLineDirection(this.accountType)!;
  }
}

/** Build the population for one side from the chart as it stood when the run executed (ADR-034). */
export function commercialPopulation(
  accounts: readonly AccountRef[],
  basis: CommercialBasis,
  side: CommercialSide,
): CommercialPopulation {
  return CommercialPopulation.of(accounts, basis, side);
}

/**
 * The part of one aggregate cell that belongs to the population, in reporting sign, or `null` when
 * none of it does.
 */
export function commercialCellAmount(
  cell: AggregateCell,
  population: CommercialPopulation,
): Decimal | null {
  if (cell.source !== population.basis) return null;
  if (cell.accountId === null || !population.accountIds.includes(cell.accountId)) return null;
  if (population.basis === 'ledger') {
    // The engine's account-type rule, applied once — the same call the P&L fold makes.
    return ledgerAmount({ accountType: population.accountType, debit: cell.debit, credit: cell.credit });
  }
  if ((cell.transferKind ?? 'none') !== 'none') return null;
  const part = bankDirectedPart(cell, population.direction);
  // A cell with no rows on the population's side names nothing to re-select.
  return part.isZero() ? null : part;
}

/**
 * The figure: Σ of the population per counterparty for one period. `counterpartyId = null` is the
 * rows with no party, which the concentration family folds into Unattributed.
 */
export function commercialSelection(
  cells: readonly AggregateCell[],
  periodId: string,
  population: CommercialPopulation,
): ReadonlyArray<{ counterpartyId: string | null; amount: string }> {
  const totals = new Map<string | null, Decimal>();
  for (const cell of cells) {
    if (cell.periodId !== periodId) continue;
    const amount = commercialCellAmount(cell, population);
    if (amount === null) continue;
    totals.set(cell.counterpartyId, (totals.get(cell.counterpartyId) ?? new Decimal(0)).plus(amount));
  }
  return [...totals.entries()]
    .map(([counterpartyId, amount]) => ({ counterpartyId, amount: amount.toFixed(2) }))
    .sort((a, b) => (a.counterpartyId ?? '￿').localeCompare(b.counterpartyId ?? '￿'));
}

/**
 * The evidence: the descriptor filters that re-select the population. Together with the period and
 * the counterparty ids the caller adds, these are the rows the figure summed. A bank outflow or
 * inflow selection is totalled on the column's magnitude (ADR-109); a ledger selection in reporting
 * sign (ADR-111) — the two amounts `commercialCellAmount` takes.
 */
export function commercialFilters(
  population: CommercialPopulation,
): Pick<LeafDescriptor['filters'], 'account_ids' | 'category_account_ids' | 'direction' | 'exclude_transfers'> {
  if (population.basis === 'ledger') return { account_ids: [...population.accountIds] };
  return {
    category_account_ids: [...population.accountIds],
    direction: population.direction,
    exclude_transfers: 'all',
  };
}
