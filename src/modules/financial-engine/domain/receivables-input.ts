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
import {
  balanceReportCompleteness, invoiceSideCoverage, winningBalanceBatch, type CoverageBatch, type InvoiceSide,
} from './coverage';
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
  /** The fiscal period the journal is posted in. */
  readonly periodId: string;
  /**
   * The journal's effective date — the balances it states are those at the START of this day (an
   * export's opening journal is dated on the export's first day). ADR-124 D-4, audit N-5.
   */
  readonly entryDate: string;
  readonly debit: string;
  readonly credit: string;
}

/** A ledger line dated before a mid-month opening journal, in the journal's own period (D-4). */
export interface PreJournalLine {
  /** The journal date this line precedes. */
  readonly journalDate: string;
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
    /**
     * For each opening journal dated INSIDE a month, every ledger line of that month dated before it
     * (ADR-124 D-4). The cells sum a month at a time; these are what the journal already contains.
     */
    readonly preJournal?: readonly PreJournalLine[];
  } | null;
}

const INVOICE_BASIS: BasisChoice = { basis: 'invoices', assurance: 'verified', warnings: [], proxy: false };

const SALES = new Set(['sales', 'sales_credit_note']);
const PURCHASES = new Set(['purchase', 'purchase_credit_note']);

/** The balance family's cumulative cells for P, or null when no cumulative TB/BS states P. */
/** The chosen balance statement for P: its cells and its kind, which its evidence must pin (ADR-123 F-6). */
interface BalanceStatement {
  readonly kind: 'trial_balance' | 'balance_sheet';
  readonly cells: readonly AggregateCell[];
}

/**
 * The balance family's statement for P, or null when no cumulative TB/BS states P.
 *
 * Kind precedence is ADR-047.4's (trial balance, then balance sheet), taken among the kinds that can
 * STATE a balance: a statement with no rows, or one stated as movements, says nothing about what was
 * owed at the period end (ADR-027.1), so it gives way to the next kind rather than hiding it
 * (ADR-123, audit L-3: a movement-basis trial balance used to hide a cumulative balance sheet).
 */
function balanceStatement(
  cells: readonly AggregateCell[],
  batches: readonly CoverageBatch[],
  period: PeriodRef,
): BalanceStatement | null {
  for (const kind of ['trial_balance', 'balance_sheet'] as const) {
    if (winningBalanceBatch(batches, period, kind) === null) continue;
    const ofKind = cells.filter(
      (c) => c.periodId === period.id && c.source === 'period_balances' && c.balanceKind === kind,
    );
    if (ofKind.length > 0 && ofKind.every((c) => c.balanceBasis === 'cumulative')) return { kind, cells: ofKind };
  }
  return null;
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

/**
 * D-6 (owner decision; FU-5, ADR-027.3 (a)): a ledger with no opening journal effective by P still
 * states a balance when a STATEMENT anchors it — the latest month A before P whose cumulative trial
 * balance or balance sheet has a line for the category. The balance at P is that closing plus every
 * ledger movement of the months after A up to P; every one of those months must carry ledger rows, or
 * a month's movements would be missing and the balance with them. No anchor: NULL, as before.
 */
function anchoredLedger(
  period: PeriodRef,
  ledger: NonNullable<ReceivablesComposeInput['ledger']>,
  accounts: ReadonlyMap<string, EngineContext['accounts'][number]>,
): (NonNullable<CategoryBalanceFallback['ledger']> & {
  periodIds: readonly string[]; entryDateFrom: null;
  anchor: { readonly periodId: string; readonly kind: 'trial_balance' | 'balance_sheet' };
}) | null {
  const { periodStarts } = ledger;
  const statementCells = ledger.cells.filter((c) => c.source === 'period_balances' && c.balanceBasis === 'cumulative'
    && (c.balanceKind === 'trial_balance' || c.balanceKind === 'balance_sheet')
    && c.accountId !== null && accounts.has(c.accountId));
  const anchorStart = [...new Set(statementCells.map((c) => periodStarts.get(c.periodId)))]
    .filter((s): s is string => s !== undefined && s < period.periodStart)
    .sort()
    .at(-1);
  if (anchorStart === undefined) return null;
  const inMonth = statementCells.filter((c) => periodStarts.get(c.periodId) === anchorStart);
  const kind = inMonth.some((c) => c.balanceKind === 'trial_balance') ? 'trial_balance' : 'balance_sheet';
  const anchorCells = inMonth.filter((c) => c.balanceKind === kind);
  let opening = new Decimal(0);
  for (const c of anchorCells) opening = opening.plus(naturalToReporting(accounts.get(c.accountId!)!.accountType, c.amount));

  // Every month after the anchor up to P must have ledger rows; its movements are then known.
  const monthsAfter = [...new Set([...periodStarts.entries()]
    .filter(([, start]) => start > anchorStart && start <= period.periodStart).map(([id]) => id))];
  const ledgerMonths = new Set(ledger.cells.filter((c) => c.source === 'ledger').map((c) => c.periodId));
  if (monthsAfter.length === 0 || !monthsAfter.every((id) => ledgerMonths.has(id))) return null;

  let movements = new Decimal(0);
  for (const cell of ledger.cells) {
    if (cell.source !== 'ledger' || cell.accountId === null || !monthsAfter.includes(cell.periodId)) continue;
    const account = accounts.get(cell.accountId);
    if (account === undefined) continue;
    movements = movements.plus(ledgerAmount({ accountType: account.accountType, debit: cell.debit, credit: cell.credit }));
  }
  return {
    openingBalance: toMoneyString(opening),
    movements: toMoneyString(movements),
    periodIds: [...monthsAfter].sort(),
    entryDateFrom: null,
    anchor: { periodId: anchorCells[0]!.periodId, kind },
  };
}

function ledgerFallback(
  ctx: EngineContext,
  period: PeriodRef,
  coverage: PeriodCoverage,
  ledger: ReceivablesComposeInput['ledger'],
  category: 'receivables' | 'payables',
): CategoryBalanceFallback['ledger'] & {
  periodIds: readonly string[]; entryDateFrom: string | null;
  anchor?: { readonly periodId: string; readonly kind: 'trial_balance' | 'balance_sheet' };
} | null {
  if (ledger === null) return null;
  // A declared GL range must span P: a month the export only partly reaches (`partial_month`) has no
  // balance at its end that anybody stated.
  const ledgerCoverage = coverage.bySource.ledger;
  if (!ledgerCoverage.covers || ledgerCoverage.warnings.includes('partial_month')) return null;
  const accounts = new Map(accountsOf(ctx, [category]).map((a) => [a.id, a]));
  const { periodStarts } = ledger;

  /*
   * The balance starts AT the opening journal: its lines restate every balance as at the start of its
   * own DATE, so the rows posted before that date are already inside them — summing both counts them
   * twice. A period before the journal has no stated opening at all.
   *
   * The LATEST journal effective by P's end (ADR-123, audit F-3: each yearly export carries one, and
   * starting at the earliest added the later one's lines on top of the rows they already contain).
   * Its DATE, not its month (ADR-124 D-4, audit N-5): an export starting on 15 July carries a
   * journal dated 15 July, and the rows of 1–14 July from the export before it are inside that
   * journal's figures. Taking the journal's month as its start counted them again: 6,000 for a true
   * 5,000.
   */
  const journalDate = (ledger.openingJournal ?? [])
    .map((line) => line.entryDate)
    .filter((date) => date <= period.periodEnd)
    .sort()
    .at(-1);
  if (journalDate === undefined) return anchoredLedger(period, ledger, accounts);
  const journalLines = (ledger.openingJournal ?? []).filter((line) => line.entryDate === journalDate);
  const journalStart = periodStarts.get(journalLines[0]!.periodId);
  if (journalStart === undefined) return null;

  const amountOf = (accountId: string, debit: string, credit: string): Decimal | null => {
    const account = accounts.get(accountId);
    return account === undefined ? null : ledgerAmount({ accountType: account.accountType, debit, credit });
  };

  let cumulative = new Decimal(0);
  const periodIds = new Set<string>();
  for (const cell of ledger.cells) {
    if (cell.source !== 'ledger' || cell.accountId === null) continue;
    const start = periodStarts.get(cell.periodId);
    if (start === undefined || start > period.periodStart || start < journalStart) continue;
    const amount = amountOf(cell.accountId, cell.debit, cell.credit);
    if (amount === null) continue;
    cumulative = cumulative.plus(amount);
    periodIds.add(cell.periodId);
  }
  // The journal's own month sums from its first day; what was posted before the journal's date is
  // already inside the journal, so it comes out again.
  for (const line of ledger.preJournal ?? []) {
    if (line.journalDate !== journalDate) continue;
    const amount = amountOf(line.accountId, line.debit, line.credit);
    if (amount !== null) cumulative = cumulative.minus(amount);
  }

  let opening = new Decimal(0);
  for (const line of journalLines) {
    const amount = amountOf(line.accountId, line.debit, line.credit);
    if (amount !== null) opening = opening.plus(amount);
  }

  return {
    openingBalance: toMoneyString(opening),
    // The cells include the opening journal's lines, so the movements are what is left once it is out.
    movements: toMoneyString(cumulative.minus(opening)),
    periodIds: periodIds.size === 0 ? [period.id] : [...periodIds].sort(),
    // The drill-down starts on the same day, so it selects exactly the rows the figure summed.
    entryDateFrom: journalDate > journalStart ? journalDate : null,
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
  statement: BalanceStatement | null,
  input: ReceivablesComposeInput,
  side: InvoiceSide,
): SideResolution {
  const category = side === 'sales' ? 'receivables' : 'payables';
  // ADR-124 D-3: a completed month needs its END position; the current one is aged at the as-of.
  const sideCoverage = invoiceSideCoverage(input.batches, period, side, !input.asOfIsPeriodEnd);
  const types = side === 'sales' ? SALES : PURCHASES;
  const invoices = sideCoverage.covers ? input.invoices.filter((i) => types.has(i.invoiceType)) : null;

  /*
   * NF-2 (the balance-sheet side of N-1): a statement's absent receivables or payables line is a zero
   * only when the statement is complete for P — a trial balance answered complete and balancing, a
   * balance sheet answered complete (owner decision, 2026-10-06). Otherwise it is unknown: the next
   * source states it (ledger), else NULL with the completeness reason.
   */
  let fromStatement = statement === null ? null : statementTotal(statement.cells, ctx, [category]);
  let statementGap: DataQualityMissing | null = null;
  if (statement !== null && fromStatement !== null && fromStatement.accountIds.length === 0) {
    const completeness = balanceReportCompleteness(input.batches, cells, period, statement.kind);
    if (completeness !== 'complete') {
      statementGap = completeness === 'unconfirmed' ? 'report_completeness_unconfirmed'
        : completeness === 'unbalanced' ? 'trial_balance_not_balanced' : 'category_not_in_report';
      fromStatement = null;
    }
  }
  const ledger = fromStatement === null ? ledgerFallback(ctx, period, coverage, input.ledger, category) : null;

  const fallback: CategoryBalanceFallback = {
    accountIds: fromStatement?.accountIds.length
      ? fromStatement.accountIds
      : accountsOf(ctx, [category]).map((a) => a.id).sort(),
    periodBalanceClosing: fromStatement?.value ?? null,
    periodBalanceKind: statement?.kind,
    ledger: ledger === null ? null : { openingBalance: ledger.openingBalance, movements: ledger.movements },
    ledgerPeriodIds: ledger?.periodIds,
    ...(ledger?.entryDateFrom ? { ledgerEntryDateFrom: ledger.entryDateFrom } : {}),
    ...(ledger?.anchor ? { ledgerAnchor: ledger.anchor } : {}),
  };

  const unavailableReason: DataQualityMissing | undefined = sideCoverage.openingUnconfirmed
    ? 'opening_invoices_unconfirmed'
    : statementGap !== null ? statementGap
    : sideCoverage.anyBatch
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

  // FU-9: the purchase side's twin — the gross a full purchase list billed in P, so payables from
  // invoices divide by a base on their own VAT footing. `amount` is net of the recorded tax and
  // `debit` the tax, so their sum is the gross at whatever rate (or none) each invoice carried.
  const purchases = invoiceSideCoverage(batches, period, 'purchase');
  let purchaseInvoiceGross: string | null = null;
  if (purchases.fullListSpans) {
    let total = new Decimal(0);
    for (const cell of cells) {
      if (cell.periodId !== period.id || cell.source !== 'invoices' || cell.invoiceType === null) continue;
      if (!PURCHASES.has(cell.invoiceType)) continue;
      const gross = (parseDecimalOrNull(cell.amount) ?? new Decimal(0)).plus(parseDecimalOrNull(cell.debit) ?? new Decimal(0));
      total = cell.invoiceType === 'purchase_credit_note' ? total.minus(gross) : total.plus(gross);
    }
    purchaseInvoiceGross = toMoneyString(total);
  }

  // §3.4 / ADR-027.5: cost of sales + operating expense + marketing. A category the P&L emitted no
  // snapshot for is a known zero in a covered period; an uncovered P&L (cost of sales NULL) is not.
  // FU-12: on the invoice basis with no purchase list establishing P, cost of sales is NULL
  // `no_source_covers_period` (and no expense category is written), so the base is NULL here — the
  // absent categories are never read as zeros of a period whose costs nothing states.
  const costOfSales = resultValue(results, 'cost_of_sales');
  const costOfSalesResult = results.find((r) => r.key === 'cost_of_sales' && r.dimensionType === 'none');
  let payablesExpenseBase: string | null = null;
  // NF-1: a category the P&L WROTE as NULL (a report that does not establish it — N-1) is unknown,
  // not zero; one it wrote no snapshot for at all is the known zero above. Unknown → no base.
  const categoryUnknown = (category: string): boolean => results.some((r) => r.key === 'expense_by_category'
    && r.dimensionKey === category && r.value === null);
  if (costOfSales !== null && !categoryUnknown('operating_expense') && !categoryUnknown('marketing')) {
    const opex = resultValue(results, 'expense_by_category', 'operating_expense') ?? '0';
    const marketing = resultValue(results, 'expense_by_category', 'marketing') ?? '0';
    payablesExpenseBase = toMoneyString(new Decimal(costOfSales).plus(opex).plus(marketing));
  }

  /*
   * Revenue that is not the month's sales is no DSO denominator. ADR-123 (audit F-5) nulled the
   * `open_items_only` 0.00s the invoices source used to state for months no list covered; FU-1 removed
   * them at the source — such a month's revenue is now NULL, or a bank cash proxy as for any month
   * without a list. What FU-1 adds is the CURRENT month's invoice revenue TO DATE (`partial_month`):
   * a few days of sales, which would understate the window's flow and overstate the days, so it is
   * unknown here as the flagged 0.00 was before, and the days figure is too. The same holds for the
   * other two flows the days divide by — the sales list's own total and the expense base — since they
   * are that month's figures to date as well (review finding).
   */
  const revenueResult = results.find((r) => r.key === 'revenue' && r.dimensionType === 'none');
  const toDate = revenueResult !== undefined && revenueResult.basis === 'invoices'
    && revenueResult.dataQuality.warnings.includes('partial_month');
  const revenue = revenueResult === undefined || toDate ? null : revenueResult.value;
  // FU-12: the expense base is that month's costs; costs stated only to date are no base either.
  // Defence in depth: unreachable while coverage requires both sides to reach the same day (equal
  // reach below the month end means revenue carries `partial_month` too, and `toDate` holds).
  const costsToDate = results.some((r) => r.dimensionType === 'none'
    && (r.key === 'cost_of_sales' || r.key === 'operating_expenses')
    && r.basis === 'invoices' && r.dataQuality.warnings.includes('partial_month'));

  return {
    revenue,
    revenueBasis: revenueResult?.basis ?? null,
    invoiceSalesTotal: toDate ? null : invoiceSalesTotal,
    payablesExpenseBase: toDate || costsToDate ? null : payablesExpenseBase,
    payablesExpenseBasis: costOfSalesResult?.basis ?? null,
    purchaseInvoiceGross: toDate || costsToDate ? null : purchaseInvoiceGross,
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
    // NF-2: on an incomplete trial balance an absent working-capital line is unknown — left out, so
    // working capital says it is partial (`partial_working_capital`), never counts it as zero.
    const tbIncomplete = balanceReportCompleteness(input.batches, cells, period, statement.kind) !== 'complete';
    for (const category of [...WORKING_CAPITAL_ASSETS, ...WORKING_CAPITAL_LIABILITIES]) {
      const term = statementTotal(statement.cells, ctx, [category]);
      if (tbIncomplete && term.accountIds.length === 0) continue;
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
