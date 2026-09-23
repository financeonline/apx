/**
 * Composition: aggregate cells in, one period's metrics out (FINANCIAL_ENGINE.md §2.4 step 6).
 *
 * The metric modules each take a shaped input; this maps the single SQL aggregation onto those
 * shapes and runs them in registry order. It is the only place that knows both the aggregate's
 * layout and the modules' inputs, which is what keeps each module ignorant of where its numbers
 * came from — and therefore unit-testable against a golden number.
 *
 * Pure. No I/O, no clock: `asOf` arrives on the context.
 */

import { Decimal, parseDecimalOrNull } from '@/core/money';
import { invoiceSignFor, ledgerAmount, naturalToReporting } from './sign';
import { computeCash, type BankAggregateCell, type CashPeriodInput, type CashSeriesOptions } from './cash';
import type { TransferKind } from '@/modules/banking';
import { computeConcentration, type ConcentrationPeriodInput } from './concentration';
import {
  bankCommercialPopulation, bankCommercialSelection, bankDirectedPart, bankLineDirection,
} from './bank-commercial';
import { computePnl, type AccountAmount, type PnlInput, type SnapshotIdResolver } from './pnl';
import { choosePrecedence } from './coverage';
import { isCashLikeBankAccount } from './categories';
import type { InvoiceType, StandardCategory } from '@/modules/financials';
import type {
  AggregateCell, BasisChoice, CounterpartyRef, EngineContext, MetricResult, PeriodCoverage,
  PeriodRef,
} from './types';

export interface TransferLegCell {
  readonly periodId: string;
  readonly bankAccountId: string;
  readonly transferKind: string;
  readonly inflow: string;
  readonly outflow: string;
}

export interface ComposeInput {
  readonly period: PeriodRef;
  readonly coverage: PeriodCoverage;
  readonly cells: readonly AggregateCell[];
  readonly transferLegs: readonly TransferLegCell[];
  readonly context: EngineContext;
  /** Cash carries forward from the previous period; supplied by the run loop. */
  readonly cashOptions?: CashSeriesOptions;
  readonly resolveSnapshotId?: SnapshotIdResolver;
}

/** The aggregate source each basis reads from. */
function sourceForBasis(basis: BasisChoice['basis']): AggregateCell['source'] | null {
  switch (basis) {
    case 'period_balances': return 'period_balances';
    case 'ledger': return 'ledger';
    case 'invoices': return 'invoices';
    case 'bank': return 'bank';
    default: return null;
  }
}

/**
 * Folds the aggregate into per-account amounts for the P&L, IN REPORTING SIGN.
 *
 * The aggregate deliberately carries debit and credit separately and leaves `amount` in natural sign
 * (debit − credit), because the account-type rule is a property of the chart, not of the sum. This
 * is where that rule is applied — once, through `sign.ts`, so the engine and the SQL cannot disagree
 * about whether revenue is positive (§3).
 *
 * A bank cell is already signed by the statement, so it is converted from its category's account
 * type rather than from a debit/credit pair.
 */
function accountAmounts(
  cells: readonly AggregateCell[],
  periodId: string,
  source: AggregateCell['source'],
  accounts: EngineContext['accounts'],
): AccountAmount[] {
  const byAccount = new Map(accounts.map((a) => [a.id, a]));
  const totals = new Map<string, { amount: Decimal; rowCount: number }>();

  for (const cell of cells) {
    if (cell.periodId !== periodId || cell.source !== source) continue;
    if (!cell.accountId) continue;
    /*
     * §4.4 / ADR-047.12: the bank-basis P&L excludes `is_transfer` rows of EVERY kind. The banking
     * pass recategorises the legs it pairs into a non-P&L category, but a pair marked by hand
     * (`api.mark_transfer`) keeps its category, so the kind is checked here rather than trusted to
     * the category (ADR-110). The descriptor carries `exclude_transfers: 'all'` to match.
     */
    if (source === 'bank' && (cell.transferKind ?? 'none') !== 'none') continue;
    const account = byAccount.get(cell.accountId);
    if (!account) continue;

    const direction = source === 'bank' ? bankLineDirection(account.accountType) : null;
    const reporting = source !== 'bank'
      ? ledgerAmount({ accountType: account.accountType, debit: cell.debit, credit: cell.credit })
      : direction !== null
        /*
         * §4.4: "maps inflows in `revenue` category to `revenue` and outflows by category to
         * expenses". A P&L category counts its own side only; a refund on the other side enters no
         * figure, as in `banking/domain/proxy.ts`. It also means every bank P&L descriptor can carry
         * a `direction` and total as the positive figure it sits behind (ADR-110).
         */
        ? bankDirectedPart(cell, direction)
        // Not a P&L line: a bank amount is already signed, and the account-type rule turns it into
        // the reporting sign for its category.
        : naturalToReporting(account.accountType, new Decimal(cell.amount).negated());

    const existing = totals.get(cell.accountId);
    totals.set(cell.accountId, {
      amount: (existing?.amount ?? new Decimal(0)).plus(reporting),
      rowCount: (existing?.rowCount ?? 0) + cell.rowCount,
    });
  }

  const out: AccountAmount[] = [];
  for (const [accountId, total] of totals) {
    const account = byAccount.get(accountId);
    if (!account) continue;
    out.push({
      accountId,
      category: account.standardCategory,
      amount: total.amount.toFixed(2),
      rowCount: total.rowCount,
    });
  }
  // Sorted so the written snapshot order — and therefore the run's output — is deterministic.
  return out.sort((a, b) => a.accountId.localeCompare(b.accountId));
}

// ---------------------------------------------------------------------------------------------
// The invoice basis (§2.1, ADR-103)
// ---------------------------------------------------------------------------------------------

/**
 * An invoice header has no account, so the aggregate cannot carry one and does not pretend to:
 * invoice cells arrive with `account_id` and `standard_category` NULL. `accountAmounts` above walks
 * accounts, so on the invoice basis it found nothing to walk and every P&L line came out a covered
 * zero while `customer_revenue` — which reads `invoice_type` directly — stayed right. That is the
 * defect this fold repairs (ADR-103).
 *
 * §2.1 states the mapping: sales and their credit notes are `revenue`; a purchase follows the
 * counterparty's `default_expense_category`, and `uncategorised` when nobody has set one — which is
 * then reported as uncategorised rather than guessed into a bucket.
 */
function invoiceCategoryOf(
  cell: AggregateCell,
  counterparties: ReadonlyMap<string, CounterpartyRef>,
): StandardCategory {
  if (cell.invoiceType === 'sales' || cell.invoiceType === 'sales_credit_note') return 'revenue';
  const counterparty = cell.counterpartyId === null ? undefined : counterparties.get(cell.counterpartyId);
  return counterparty?.defaultExpenseCategory ?? 'uncategorised';
}

/**
 * The reporting-sign amount of one invoice cell.
 *
 * The aggregate's `amount` is already net of tax (`app.invoice_net`, the one rule) and POSITIVE for
 * every type, because ADR-047.5 stores a credit note's money fields positive and puts the sign in
 * the type. Applying `invoiceSignFor` here is therefore the whole of the sign rule for this source,
 * and it is applied exactly once — the same guarantee `ledgerAmount` gives the ledger.
 */
function invoiceCellAmount(cell: AggregateCell): Decimal {
  const net = parseDecimalOrNull(cell.amount) ?? new Decimal(0);
  return invoiceSignFor(cell.invoiceType as InvoiceType) === 1 ? net : net.negated();
}

/**
 * Where an invoice-basis category reports: the organisation's system account for it.
 *
 * Invoice amounts are real money in a real category with no account of their own, and the system
 * chart exists precisely to hold such amounts — it is where a categorised bank line without an
 * account of its own already reports. Falling back to `uncategorised` keeps the money visible when
 * a chart is missing the category entirely, which is honest: we know what was spent, not where.
 */
function homeAccountFor(
  accounts: EngineContext['accounts'],
  category: StandardCategory,
): { accountId: string; category: StandardCategory } | null {
  const pick = (want: StandardCategory) => {
    const ofCategory = accounts.filter((a) => a.standardCategory === want);
    return ofCategory.find((a) => a.isSystem) ?? ofCategory[0] ?? null;
  };
  const exact = pick(category);
  if (exact) return { accountId: exact.id, category };
  const fallback = pick('uncategorised');
  return fallback ? { accountId: fallback.id, category: 'uncategorised' } : null;
}

/** The invoice source folded into per-account amounts, in reporting sign, for the P&L. */
function invoiceAccountAmounts(
  cells: readonly AggregateCell[],
  periodId: string,
  accounts: EngineContext['accounts'],
  counterparties: ReadonlyMap<string, CounterpartyRef>,
): AccountAmount[] {
  const totals = new Map<string, { category: StandardCategory; amount: Decimal; rowCount: number }>();

  for (const cell of cells) {
    if (cell.periodId !== periodId || cell.source !== 'invoices' || cell.invoiceType === null) continue;
    const home = homeAccountFor(accounts, invoiceCategoryOf(cell, counterparties));
    if (home === null) continue;
    const existing = totals.get(home.accountId);
    totals.set(home.accountId, {
      category: home.category,
      amount: (existing?.amount ?? new Decimal(0)).plus(invoiceCellAmount(cell)),
      rowCount: (existing?.rowCount ?? 0) + cell.rowCount,
    });
  }

  return [...totals.entries()]
    .map(([accountId, total]) => ({
      accountId, category: total.category, amount: total.amount.toFixed(2), rowCount: total.rowCount,
    }))
    .sort((a, b) => a.accountId.localeCompare(b.accountId));
}

/**
 * Which suppliers' purchases went into each category this period — the invoice basis's answer to
 * "what rows are behind this expense figure" (ADR-104). Built from the same cells and the same
 * category rule as the fold, so the descriptor re-selects exactly what the figure summed.
 */
function invoiceCounterpartiesByCategory(
  cells: readonly AggregateCell[],
  periodId: string,
  accounts: EngineContext['accounts'],
  counterparties: ReadonlyMap<string, CounterpartyRef>,
): ReadonlyMap<StandardCategory, readonly string[]> {
  const byCategory = new Map<StandardCategory, Set<string>>();
  for (const cell of cells) {
    if (cell.periodId !== periodId || cell.source !== 'invoices' || cell.counterpartyId === null) continue;
    if (cell.invoiceType !== 'purchase' && cell.invoiceType !== 'purchase_credit_note') continue;
    const home = homeAccountFor(accounts, invoiceCategoryOf(cell, counterparties));
    if (home === null) continue;
    const set = byCategory.get(home.category) ?? new Set<string>();
    set.add(cell.counterpartyId);
    byCategory.set(home.category, set);
  }
  return new Map([...byCategory.entries()].map(([category, ids]) => [category, [...ids].sort()]));
}

/** §3's VAT-fallback counts for the period: rows that had no tax to remove from a gross total. */
function invoiceVatExposure(
  cells: readonly AggregateCell[],
  periodId: string,
): { contributingRows: number; fallbackRows: number } {
  let contributingRows = 0;
  let fallbackRows = 0;
  for (const cell of cells) {
    if (cell.periodId !== periodId || cell.source !== 'invoices') continue;
    contributingRows += cell.rowCount;
    fallbackRows += cell.fallbackRows;
  }
  return { contributingRows, fallbackRows };
}

/** Rows the source could not attribute to a category, for the completeness haircut (§3.1). */
function uncategorisedExposure(
  cells: readonly AggregateCell[],
  periodId: string,
  source: AggregateCell['source'],
  categoryOf: (cell: AggregateCell) => StandardCategory | null,
): { absoluteAmount: string; totalAbsoluteAmount: string } {
  let uncategorised = new Decimal(0);
  let total = new Decimal(0);
  for (const cell of cells) {
    if (cell.periodId !== periodId || cell.source !== source) continue;
    const magnitude = (parseDecimalOrNull(cell.amount) ?? new Decimal(0)).abs();
    total = total.plus(magnitude);
    const category = categoryOf(cell);
    if (category === null || category === 'uncategorised') {
      uncategorised = uncategorised.plus(magnitude);
    }
  }
  return { absoluteAmount: uncategorised.toFixed(2), totalAbsoluteAmount: total.toFixed(2) };
}

/** Bank movements for the cash module, with transfer legs kept so ADR-028 can be applied there. */
function bankMovements(
  cells: readonly AggregateCell[],
  periodId: string,
  bankAccounts: EngineContext['bankAccounts'],
): BankAggregateCell[] {
  const cashLike = new Set(
    bankAccounts.filter((a) => isCashLikeBankAccount(a.accountType)).map((a) => a.id),
  );

  void cashLike;
  return cells
    .filter((c) => c.periodId === periodId && c.source === 'bank' && c.bankAccountId !== null)
    .map((c) => ({
      ...c,
      source: 'bank' as const,
      bankAccountId: c.bankAccountId!,
      transferKind: (c.transferKind ?? 'none') as TransferKind,
      unpairedTransferCandidate: c.unpairedTransferCandidate === true,
    }))
    .sort((a, b) => a.bankAccountId.localeCompare(b.bankAccountId)
      || a.transferKind.localeCompare(b.transferKind));
}

/**
 * Revenue and spend per counterparty, for the concentration module, on the ledger and invoice bases.
 * The bank basis does not come here: it reads `bank-commercial.ts` (ADR-110).
 */
function counterpartyAmounts(
  cells: readonly AggregateCell[],
  periodId: string,
  source: AggregateCell['source'],
  accounts: EngineContext['accounts'],
  want: 'revenue' | 'expense',
) {
  const categoryOf = new Map(accounts.map((a) => [a.id, a.standardCategory]));
  const totals = new Map<string | null, Decimal>();

  for (const cell of cells) {
    if (cell.periodId !== periodId || cell.source !== source) continue;
    const category = cell.standardCategory
      ?? (cell.accountId ? categoryOf.get(cell.accountId) : undefined)
      ?? null;

    const isRevenue = category === 'revenue' || category === 'other_income'
      || cell.invoiceType === 'sales' || cell.invoiceType === 'sales_credit_note';
    if (want === 'revenue' ? !isRevenue : isRevenue) continue;

    const key = cell.counterpartyId;
    /*
     * An invoice cell is already net and positive whatever its type, so the sign lives in the type
     * (ADR-047.5): a credit note must SUBTRACT from the customer's revenue. Taking its magnitude —
     * which is right for a ledger or bank cell, where the sign is the account's — made a refund
     * look like a sale and broke `Σ customer_revenue + unattributed = revenue` (ADR-103).
     */
    const contribution = cell.source === 'invoices' && cell.invoiceType !== null
      ? invoiceCellAmount(cell)
      : (parseDecimalOrNull(cell.amount) ?? new Decimal(0)).abs();
    totals.set(key, (totals.get(key) ?? new Decimal(0)).plus(contribution));
  }

  return [...totals.entries()]
    .map(([counterpartyId, amount]) => ({ counterpartyId, amount: amount.toFixed(2) }))
    // NULL — the "Unattributed" bucket — sorts last so the output order is stable.
    .sort((a, b) => (a.counterpartyId ?? '￿').localeCompare(b.counterpartyId ?? '￿'));
}

const NO_SNAPSHOT: SnapshotIdResolver = () => null;

/**
 * Runs one period's metrics.
 *
 * The families are computed independently and each takes its own basis from precedence, which is
 * why a period can legitimately have an accrual P&L from a trial balance and cash from the bank.
 * `basis = 'mixed'` on a derived metric records that.
 */
export function composePeriod(input: ComposeInput): MetricResult[] {
  const { period, coverage, cells, context } = input;
  const resolve = input.resolveSnapshotId ?? NO_SNAPSHOT;
  const results: MetricResult[] = [];

  // ---- P&L ----
  const pnlBasis = choosePrecedence(coverage, 'pnl');
  const pnlSource = sourceForBasis(pnlBasis.basis);

  const byCounterparty = new Map(context.counterparties.map((c) => [c.id, c]));
  /*
   * What the figure REPORTS the money as, which is what §3.1's uncategorised share must measure.
   * On the invoice basis that is the home account's category, not the counterparty's stated one: a
   * purchase whose category has no account in the chart is reported under `uncategorised`, and
   * counting it as categorised here would hide exactly the gap the share exists to surface.
   */
  const pnlCategoryOf = (cell: AggregateCell): StandardCategory | null =>
    (pnlSource === 'invoices'
      ? homeAccountFor(context.accounts, invoiceCategoryOf(cell, byCounterparty))?.category ?? null
      : cell.standardCategory);

  const pnlInput: PnlInput = {
    period,
    basis: pnlBasis,
    currency: context.settings.baseCurrency,
    accounts: context.accounts,
    /*
     * ADR-104: invoice evidence of cost of sales counts only when the invoices ARE the basis. On a
     * ledger or balance basis it is a fact about a source this figure is not reading, and the
     * figure reports that mismatch rather than a zero the ledger never stated.
     */
    costOfSalesEverUsed: context.costOfSalesEverUsed
      || (pnlSource === 'invoices' && context.costOfSalesInInvoices),
    costOfSalesInOtherSource: pnlSource !== 'invoices' && !context.costOfSalesEverUsed && context.costOfSalesInInvoices,
    invoiceCounterparties: pnlSource === 'invoices'
      ? invoiceCounterpartiesByCategory(cells, period.id, context.accounts, byCounterparty)
      : undefined,
    accountAmounts: pnlSource === 'invoices'
      ? invoiceAccountAmounts(cells, period.id, context.accounts, byCounterparty)
      : pnlSource
        ? accountAmounts(cells, period.id, pnlSource, context.accounts)
        : [],
    uncategorised: pnlSource
      ? uncategorisedExposure(cells, period.id, pnlSource, pnlCategoryOf)
      : { absoluteAmount: '0', totalAbsoluteAmount: '0' },
    invoiceVat: pnlSource === 'invoices' ? invoiceVatExposure(cells, period.id) : null,
  };
  results.push(...computePnl(pnlInput, context, resolve));

  // ---- Cash ----
  const cashBasis = choosePrecedence(coverage, 'cash');
  const cashInput: CashPeriodInput = {
    period,
    basis: cashBasis,
    movements: bankMovements(cells, period.id, context.bankAccounts),
    openingCandidates: context.bankAccounts
      .filter((a) => a.openingBalance !== null && isCashLikeBankAccount(a.accountType))
      .map((a) => ({
        bankAccountId: a.id,
        source: 'bank_account_opening_balance' as const,
        value: a.openingBalance!,
        asAtDate: a.openingBalanceDate,
      })),
    coveredBankAccountIds: context.bankAccounts
      .filter((a) => a.isActive && isCashLikeBankAccount(a.accountType))
      .map((a) => a.id),
  };
  const cashSeries = computeCash(context, [cashInput], input.cashOptions ?? {});
  for (const periodMetrics of cashSeries) {
    if (periodMetrics.periodId === period.id) results.push(...periodMetrics.metrics);
  }

  // ---- Customers and suppliers ----
  const counterpartyBasis = choosePrecedence(coverage, 'counterparty');
  const counterpartySource = sourceForBasis(counterpartyBasis.basis);
  const revenueResult = results.find((r) => r.key === 'revenue' && r.dimensionType === 'none') ?? null;

  /*
   * ADR-110: on the bank basis the figure and the descriptor are both read off one population value,
   * so neither can select rows the other does not. Other bases keep their own rule unchanged.
   */
  const bankPopulations = counterpartySource === 'bank'
    ? {
        customer: bankCommercialPopulation(context.accounts, 'customer'),
        supplier: bankCommercialPopulation(context.accounts, 'supplier'),
      }
    : undefined;

  const concentrationInput: ConcentrationPeriodInput = {
    period,
    basis: counterpartyBasis,
    customerRevenue: bankPopulations
      ? bankCommercialSelection(cells, period.id, bankPopulations.customer)
      : counterpartySource
        ? counterpartyAmounts(cells, period.id, counterpartySource, context.accounts, 'revenue')
        : [],
    supplierSpend: bankPopulations
      ? bankCommercialSelection(cells, period.id, bankPopulations.supplier)
      : counterpartySource
        ? counterpartyAmounts(cells, period.id, counterpartySource, context.accounts, 'expense')
        : [],
    bankPopulations,
    revenue: revenueResult,
    revenueAccountIds: context.accounts
      .filter((a) => a.standardCategory === 'revenue' || a.standardCategory === 'other_income')
      .map((a) => a.id),
    expenseAccountIds: context.accounts
      .filter((a) => a.accountType === 'expense')
      .map((a) => a.id),
  };
  for (const periodMetrics of computeConcentration(context, [concentrationInput])) {
    if (periodMetrics.periodId === period.id) results.push(...periodMetrics.metrics);
  }

  // A stable order makes two runs over identical data write byte-identical snapshots, which is the
  // guarantee §1.1 makes and TEST_STRATEGY asserts.
  return results.sort(
    (a, b) => a.key.localeCompare(b.key)
      || (a.dimensionId ?? '').localeCompare(b.dimensionId ?? ''),
  );
}
