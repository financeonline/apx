/**
 * Shaping one period's receivables input (FINANCIAL_ENGINE.md §2.3, §3.4; ADR-120).
 *
 * `computeReceivables` (Phase 4) was complete and never called: `composePeriod` had no receivables
 * step, so no calculation run ever wrote `receivables`, `payables`, their overdue and days figures or
 * `working_capital`. This module is the missing seam. It decides nothing new — every rule here is
 * §2.2/§2.3/§3.4 or ADR-027.3 — it only maps what the run already holds (the period's aggregate
 * cells, the P&L and cash results it just computed, the invoice rows and batches) onto the input the
 * domain function was written to take.
 *
 * Per side, the source is the first that can state the balance:
 *   1. **invoices** — a batch of that side covers P under §2.2's AR/AP test (`invoiceSideCoverage`);
 *   2. **period_balances** — a cumulative trial balance or balance sheet covers P (the balance family's
 *      kind precedence, ADR-047.4). A covering statement with no receivables row states a zero;
 *   3. **ledger** — the ledger covers P AND an opening-balance journal exists (ADR-027.3 item 3):
 *      opening journal plus every movement to P;
 *   4. otherwise NULL with the reason — never zero.
 *
 * Pure.
 */

import { Decimal, parseDecimalOrNull, toMoneyString } from '@/core/money';
import { chooseBalanceKind, invoiceSideCoverage, type CoverageBatch, type InvoiceSide } from './coverage';
import { ledgerAmount, naturalToReporting } from './sign';
import {
  WORKING_CAPITAL_ASSETS, WORKING_CAPITAL_LIABILITIES,
  type AgingInvoice, type BalanceSheetTerm, type CategoryBalanceFallback, type DenominatorInputs,
  type ReceivablesPeriodInput,
} from './receivables';
import type { StandardCategory } from '@/modules/financials';
import type {
  AggregateCell, BasisChoice, DataQualityMissing, EngineContext, MetricResult, PeriodCoverage, PeriodRef,
} from './types';

/** One opening-balance journal line (`ledger_entries.is_opening_balance`, IMP-GL-011). */
export interface OpeningJournalLine {
  readonly accountId: string;
  readonly debit: string;
  readonly credit: string;
}

/** What the run holds for the receivables family, beyond the period's own cells. */
export interface ReceivablesComposeInput {
  /** Current rows of every accepted, non-superseded invoice the run may see (ADR-047.10). */
  readonly invoices: readonly AgingInvoice[];
  /** Every committed batch of the organisation (the AR/AP test needs batches outside the window). */
  readonly batches: readonly CoverageBatch[];
  /** `false` only for the current period, whose aging is as at the run's `asOf` (§3.4). */
  readonly asOfIsPeriodEnd: boolean;
  /** Denominator inputs for P−2 and P−1, oldest first, only when they are consecutive and known. */
  readonly priorDenominators: readonly DenominatorInputs[];
  /**
   * The ledger branch's inputs, or null when it cannot apply. `cells` are the ledger cells of every
   * period up to and including P; `openingJournal` is null when the organisation has no
   * opening-balance journal, which is what makes a ledger total a movement rather than a balance.
   */
  readonly ledger: {
    readonly cells: readonly AggregateCell[];
    readonly openingJournal: readonly OpeningJournalLine[] | null;
    /** `period_start` of EVERY fiscal period — the cells reach back past the chunk's window. */
    readonly periodStarts: ReadonlyMap<string, string>;
  } | null;
}

const INVOICE_BASIS: BasisChoice = { basis: 'invoices', assurance: 'verified', warnings: [], proxy: false };

const SALES = new Set(['sales', 'sales_credit_note']);
const PURCHASES = new Set(['purchase', 'purchase_credit_note']);

/** The balance family's cumulative cells for P, or null when no cumulative TB/BS states P. */
function balanceStatement(
  cells: readonly AggregateCell[],
  batches: readonly CoverageBatch[],
  period: PeriodRef,
): readonly AggregateCell[] | null {
  const chosen = chooseBalanceKind(batches, period, 'balance');
  if (chosen === null) return null;
  const ofKind = cells.filter(
    (c) => c.periodId === period.id && c.source === 'period_balances' && c.balanceKind === chosen.kind,
  );
  // A balance sheet states balances only on the cumulative basis (ADR-027.1). A statement with no
  // rows at all, or one stated as movements, says nothing about what was owed at the period end.
  if (ofKind.length === 0 || ofKind.some((c) => c.balanceBasis !== 'cumulative')) return null;
  return ofKind;
}

function accountsOf(ctx: EngineContext, categories: readonly StandardCategory[]): readonly EngineContext['accounts'][number][] {
  return ctx.accounts.filter((a) => categories.includes(a.standardCategory));
}

/** Σ closing balance of the accounts in `categories`, in reporting sign; zero when the statement has no row. */
function statementTotal(
  statement: readonly AggregateCell[],
  ctx: EngineContext,
  categories: readonly StandardCategory[],
): { value: string; accountIds: readonly string[] } {
  const accounts = new Map(accountsOf(ctx, categories).map((a) => [a.id, a]));
  let total = new Decimal(0);
  const seen = new Set<string>();
  for (const cell of statement) {
    const account = cell.accountId === null ? undefined : accounts.get(cell.accountId);
    if (account === undefined) continue;
    total = total.plus(naturalToReporting(account.accountType, cell.amount));
    seen.add(account.id);
  }
  return { value: toMoneyString(total), accountIds: [...seen].sort() };
}

function ledgerFallback(
  ctx: EngineContext,
  period: PeriodRef,
  coverage: PeriodCoverage,
  ledger: ReceivablesComposeInput['ledger'],
  category: 'receivables' | 'payables',
): CategoryBalanceFallback['ledger'] & { periodIds: readonly string[] } | null {
  if (ledger === null || ledger.openingJournal === null || !coverage.bySource.ledger.covers) return null;
  const accounts = new Map(accountsOf(ctx, [category]).map((a) => [a.id, a]));
  const { periodStarts } = ledger;

  let cumulative = new Decimal(0);
  const periodIds = new Set<string>();
  for (const cell of ledger.cells) {
    if (cell.source !== 'ledger' || cell.accountId === null) continue;
    const account = accounts.get(cell.accountId);
    if (account === undefined) continue;
    const start = periodStarts.get(cell.periodId);
    if (start === undefined || start > period.periodStart) continue;
    cumulative = cumulative.plus(ledgerAmount({ accountType: account.accountType, debit: cell.debit, credit: cell.credit }));
    periodIds.add(cell.periodId);
  }

  let opening = new Decimal(0);
  for (const line of ledger.openingJournal) {
    const account = accounts.get(line.accountId);
    if (account === undefined) continue;
    opening = opening.plus(ledgerAmount({ accountType: account.accountType, debit: line.debit, credit: line.credit }));
  }

  return {
    openingBalance: toMoneyString(opening),
    // The cells include the opening journal's lines, so the movements are what is left once it is out.
    movements: toMoneyString(cumulative.minus(opening)),
    periodIds: periodIds.size === 0 ? [period.id] : [...periodIds].sort(),
  };
}

/** Whether ledger rows on the category's accounts exist up to P — the difference between "no opening balance" and "no source". */
function ledgerRowsExist(
  ctx: EngineContext, cells: readonly AggregateCell[], period: PeriodRef, category: StandardCategory,
): boolean {
  const ids = new Set(accountsOf(ctx, [category]).map((a) => a.id));
  return cells.some((c) => c.source === 'ledger' && c.accountId !== null && ids.has(c.accountId)
    && c.periodId === period.id);
}

interface SideResolution {
  readonly invoices: readonly AgingInvoice[] | null;
  readonly fallback: CategoryBalanceFallback;
  readonly unavailableReason: DataQualityMissing | undefined;
}

function resolveSide(
  ctx: EngineContext,
  period: PeriodRef,
  coverage: PeriodCoverage,
  cells: readonly AggregateCell[],
  statement: readonly AggregateCell[] | null,
  input: ReceivablesComposeInput,
  side: InvoiceSide,
): SideResolution {
  const category = side === 'sales' ? 'receivables' : 'payables';
  const sideCoverage = invoiceSideCoverage(input.batches, period, side);
  const types = side === 'sales' ? SALES : PURCHASES;
  const invoices = sideCoverage.covers ? input.invoices.filter((i) => types.has(i.invoiceType)) : null;

  const fromStatement = statement === null ? null : statementTotal(statement, ctx, [category]);
  const ledger = fromStatement === null ? ledgerFallback(ctx, period, coverage, input.ledger, category) : null;

  const fallback: CategoryBalanceFallback = {
    accountIds: fromStatement?.accountIds.length
      ? fromStatement.accountIds
      : accountsOf(ctx, [category]).map((a) => a.id).sort(),
    periodBalanceClosing: fromStatement?.value ?? null,
    ledger: ledger === null ? null : { openingBalance: ledger.openingBalance, movements: ledger.movements },
    ledgerPeriodIds: ledger?.periodIds,
  };

  const unavailableReason: DataQualityMissing | undefined = sideCoverage.anyBatch
    ? 'stale_invoice_data'
    : ledgerRowsExist(ctx, cells, period, category) ? 'no_opening_balance' : 'no_source_covers_period';

  return { invoices, fallback, unavailableReason };
}

/** A category's reporting-sign total from the P&L results, or null when the P&L did not state it. */
function resultValue(results: readonly MetricResult[], key: string, dimensionKey: string | null = null): string | null {
  const found = results.find((r) => r.key === key && (r.dimensionKey ?? null) === dimensionKey
    && (dimensionKey !== null || r.dimensionType === 'none'));
  return found?.value ?? null;
}

/**
 * The period's own denominator inputs (§3.4), from the results just computed and the period's cells.
 *
 * Exported because the run carries them forward: `receivables_days` divides by three months of flow,
 * and the two months before P may sit in an earlier chunk or an earlier run.
 */
export function denominatorInputsFor(
  period: PeriodRef,
  results: readonly MetricResult[],
  cells: readonly AggregateCell[],
  batches: readonly CoverageBatch[],
): DenominatorInputs {
  const sales = invoiceSideCoverage(batches, period, 'sales');

  let invoiceSalesTotal: string | null = null;
  if (sales.fullListSpans) {
    // An invoice cell's `amount` is net of tax (`app.invoice_net`) and `debit` its tax, so
    // `amount + debit` is the gross total the receivable carries; credit notes subtract (ADR-047.5).
    let total = new Decimal(0);
    for (const cell of cells) {
      if (cell.periodId !== period.id || cell.source !== 'invoices' || cell.invoiceType === null) continue;
      if (!SALES.has(cell.invoiceType)) continue;
      const gross = (parseDecimalOrNull(cell.amount) ?? new Decimal(0)).plus(parseDecimalOrNull(cell.debit) ?? new Decimal(0));
      total = cell.invoiceType === 'sales_credit_note' ? total.minus(gross) : total.plus(gross);
    }
    invoiceSalesTotal = toMoneyString(total);
  }

  // §3.4 / ADR-027.5: cost of sales + operating expense + marketing. A category the P&L emitted no
  // snapshot for is a known zero in a covered period; an uncovered P&L (cost of sales NULL) is not.
  const costOfSales = resultValue(results, 'cost_of_sales');
  let payablesExpenseBase: string | null = null;
  if (costOfSales !== null) {
    const opex = resultValue(results, 'expense_by_category', 'operating_expense') ?? '0';
    const marketing = resultValue(results, 'expense_by_category', 'marketing') ?? '0';
    payablesExpenseBase = toMoneyString(new Decimal(costOfSales).plus(opex).plus(marketing));
  }

  return {
    revenue: resultValue(results, 'revenue'),
    invoiceSalesTotal,
    payablesExpenseBase,
    hasOpenItemsList: sales.openItemsSpans,
  };
}

/** The complete `ReceivablesPeriodInput` for P. */
export function receivablesPeriodInput(
  ctx: EngineContext,
  period: PeriodRef,
  coverage: PeriodCoverage,
  cells: readonly AggregateCell[],
  results: readonly MetricResult[],
  input: ReceivablesComposeInput,
): ReceivablesPeriodInput {
  const statement = balanceStatement(cells, input.batches, period);
  const sales = resolveSide(ctx, period, coverage, cells, statement, input, 'sales');
  const purchases = resolveSide(ctx, period, coverage, cells, statement, input, 'purchase');

  const balanceSheetClosings: Partial<Record<StandardCategory, BalanceSheetTerm>> = {};
  if (statement !== null) {
    for (const category of [...WORKING_CAPITAL_ASSETS, ...WORKING_CAPITAL_LIABILITIES]) {
      const term = statementTotal(statement, ctx, [category]);
      balanceSheetClosings[category] = { value: term.value, basis: 'period_balances', accountIds: term.accountIds };
    }
  }

  return {
    ...denominatorInputsFor(period, results, cells, input.batches),
    period,
    basis: INVOICE_BASIS,
    asOfIsPeriodEnd: input.asOfIsPeriodEnd,
    invoices: null,
    salesInvoices: sales.invoices,
    purchaseInvoices: purchases.invoices,
    receivablesUnavailableReason: sales.unavailableReason,
    payablesUnavailableReason: purchases.unavailableReason,
    receivablesFallback: sales.fallback,
    payablesFallback: purchases.fallback,
    balanceSheetClosings,
    closingCash: results.find((r) => r.key === 'closing_cash' && r.dimensionType === 'none') ?? null,
  };
}
