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
import {
  computeCash, weakerAssurance, type BankAggregateCell, type CashPeriodInput, type CashSeriesOptions,
} from './cash';
import type { AccountPeriodState } from './cash-history';
import type { TransferKind } from '@/modules/banking';
import { computeConcentration, type ConcentrationPeriodInput } from './concentration';
import { computeReceivables } from './receivables';
import { receivablesPeriodInput, type ReceivablesComposeInput } from './receivables-input';
import {
  bankDirectedPart, bankLineDirection, commercialPopulation, commercialSelection,
} from './commercial-population';
import { computePnl, type AccountAmount, type PnlInput, type SnapshotIdResolver } from './pnl';
import { choosePrecedence } from './coverage';
import { isCashLikeBankAccount } from './categories';
import type { InvoiceType, StandardCategory } from '@/modules/financials';
import type {
  AggregateCell, AssuranceLevel, BasisChoice, CounterpartyRef, EngineContext, MetricResult, PeriodCoverage,
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
  /**
   * The receivables family's inputs beyond the period's cells (ADR-120). The calculation run always
   * supplies it; a caller that omits it gets no receivables, payables or working-capital figures.
   */
  readonly receivables?: ReceivablesComposeInput;
  /**
   * Every cash-like account's state in this period, from the per-account history the run builds
   * (`buildCashHistory`, ADR-124): scope, coverage, the balance at each end and the cross-checks.
   * Omitted, no account is in scope, so cash is unknown — never a guess, and never the old default
   * under which a month with no statement reported a known 0.00 movement (ADR-120).
   */
  readonly cashAccounts?: readonly AccountPeriodState[];
  /**
   * ADR-130: the weakest assurance commit stamped on the bank rows that can feed P
   * (`bankRecordAssuranceFor`). A figure is never firmer than the records under it, so every
   * bank-sourced figure — cash, and the P&L and customer figures when the bank is their basis — is
   * weakened to it. Values are unchanged. Absent means the rows are all `verified`.
   */
  readonly bankRecordAssurance?: AssuranceLevel;
}

/** ADR-130: a bank basis is no firmer than the bank rows it reads. */
function withBankRecords(choice: BasisChoice, bankRecords: AssuranceLevel): BasisChoice {
  return choice.basis === 'bank' ? { ...choice, assurance: weakerAssurance(choice.assurance, bankRecords) } : choice;
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
 * Revenue and spend per counterparty, for the concentration module, on the INVOICE basis. The bank and
 * ledger bases do not come here: they read `commercial-population.ts` (ADR-110, ADR-111).
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
 * A derived metric names the snapshots it was worked out from (ADR-059). The receivables module
 * builds its component list before any snapshot exists, so the ids are filled here from the same
 * resolver the P&L uses. A component that is not a metric of this period (a balance-sheet term such
 * as `inventory`) resolves to nothing and stays null — honestly unlinked, never invented.
 */
function withDerivedIds(result: MetricResult, resolve: SnapshotIdResolver): MetricResult {
  const query = result.evidenceQuery;
  if (query === null || query.kind !== 'derived') return result;
  return {
    ...result,
    evidenceQuery: {
      kind: 'derived',
      components: query.components.map((c) => ({
        name: c.name,
        snapshot_id: c.snapshot_id ?? resolve(c.name, null, null),
      })),
    },
  };
}

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
  const bankRecords = input.bankRecordAssurance ?? 'verified';
  const pnlBasis = withBankRecords(choosePrecedence(coverage, 'pnl'), bankRecords);
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

  /*
   * FU-12: purchases no purchase list establishes for P are not P's purchases to report. They are left
   * out of the invoice-basis fold entirely — not only out of the cost lines (which `computePnl` states
   * NULL) but out of every category a supplier's default could put them in (`other_income`, even
   * `revenue`) and out of the uncategorised share and VAT counts that qualify revenue (review finding).
   */
  const pnlCells = pnlSource === 'invoices' && coverage.invoiceCosts?.covers !== true
    ? cells.filter((cell) => !(cell.source === 'invoices'
      && (cell.invoiceType === 'purchase' || cell.invoiceType === 'purchase_credit_note')))
    : cells;

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
      ? invoiceCounterpartiesByCategory(pnlCells, period.id, context.accounts, byCounterparty)
      : undefined,
    accountAmounts: pnlSource === 'invoices'
      ? invoiceAccountAmounts(pnlCells, period.id, context.accounts, byCounterparty)
      : pnlSource
        ? accountAmounts(cells, period.id, pnlSource, context.accounts)
        : [],
    uncategorised: pnlSource
      ? uncategorisedExposure(pnlCells, period.id, pnlSource, pnlCategoryOf)
      : { absoluteAmount: '0', totalAbsoluteAmount: '0' },
    invoiceVat: pnlSource === 'invoices' ? invoiceVatExposure(pnlCells, period.id) : null,
    // FU-12: a sales list hands the P&L to the invoices source; only purchase lists state its costs.
    purchaseCoverage: pnlSource === 'invoices' ? coverage.invoiceCosts : undefined,
  };
  results.push(...computePnl(pnlInput, context, resolve));

  // ---- Cash ----
  const cashInput: CashPeriodInput = {
    period,
    movements: bankMovements(cells, period.id, context.bankAccounts),
    accounts: input.cashAccounts ?? [],
  };
  const cashSeries = computeCash(context, [cashInput], input.cashOptions ?? {});
  for (const periodMetrics of cashSeries) {
    if (periodMetrics.periodId !== period.id) continue;
    // Cash is stated from the bank alone (ADR-124): its figures are as firm as those rows (ADR-130).
    // The two balances already carry exactly the records they rest on, per account (Step 0D): the
    // opening does not rest on this month's rows, and the closing counts them in its own chain.
    results.push(...periodMetrics.metrics.map((m) => (m.basis === 'bank' && m.key !== 'opening_cash' && m.key !== 'closing_cash'
      ? { ...m, assurance: weakerAssurance(m.assurance, bankRecords) }
      : m)));
  }

  // ---- Customers and suppliers ----
  const counterpartyBasis = withBankRecords(choosePrecedence(coverage, 'counterparty'), bankRecords);
  const counterpartySource = sourceForBasis(counterpartyBasis.basis);
  const revenueResult = results.find((r) => r.key === 'revenue' && r.dimensionType === 'none') ?? null;

  /*
   * ADR-110 / ADR-111: on the bank and ledger bases the figure and the descriptor are both read off
   * one population value, so neither can select rows the other does not. The invoice basis keeps its
   * own rule, unchanged.
   */
  const populations = counterpartySource === 'bank' || counterpartySource === 'ledger'
    ? {
        customer: commercialPopulation(context.accounts, counterpartySource, 'customer'),
        supplier: commercialPopulation(context.accounts, counterpartySource, 'supplier'),
      }
    : undefined;

  const concentrationInput: ConcentrationPeriodInput = {
    period,
    basis: counterpartyBasis,
    customerRevenue: populations
      ? commercialSelection(cells, period.id, populations.customer)
      : counterpartySource
        ? counterpartyAmounts(cells, period.id, counterpartySource, context.accounts, 'revenue')
        : [],
    supplierSpend: populations
      ? commercialSelection(cells, period.id, populations.supplier)
      : counterpartySource
        ? counterpartyAmounts(cells, period.id, counterpartySource, context.accounts, 'expense')
        : [],
    populations,
    revenue: revenueResult,
    // FU-12: on the invoice basis the supplier side is stated only where purchase lists establish P.
    supplierCoverage: counterpartySource === 'invoices' ? coverage.invoiceCosts : undefined,
  };
  for (const periodMetrics of computeConcentration(context, [concentrationInput])) {
    if (periodMetrics.periodId === period.id) results.push(...periodMetrics.metrics);
  }

  // ---- Receivables, payables, working capital (§3.4, ADR-120) ----
  // Last, because it reads what came before: revenue and the expense categories for the days
  // denominators, and closing cash for working capital.
  if (input.receivables !== undefined) {
    const receivablesInput = receivablesPeriodInput(context, period, coverage, cells, results, input.receivables);
    const series = computeReceivables(context, [receivablesInput], {
      priorDenominators: input.receivables.priorDenominators,
    });
    for (const periodMetrics of series) {
      if (periodMetrics.periodId === period.id) {
        results.push(...periodMetrics.metrics.map((m) => withDerivedIds(m, resolve)));
      }
    }
  }

  // A stable order makes two runs over identical data write byte-identical snapshots, which is the
  // guarantee §1.1 makes and TEST_STRATEGY asserts.
  return results.sort(
    (a, b) => a.key.localeCompare(b.key)
      || (a.dimensionId ?? '').localeCompare(b.dimensionId ?? ''),
  );
}
