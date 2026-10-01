/**
 * Coverage and source precedence (FINANCIAL_ENGINE.md §2.2, §2.3).
 *
 * This decides which record source is allowed to answer for a family of metrics in a period, and
 * therefore what basis and assurance every figure carries. Two properties matter:
 *
 *   - **Coverage uses the DECLARED export range, never the last posting date** (ADR-047.6). A month
 *     whose last working day is the 28th is fully covered by an export declared to the 31st. The
 *     old last-N-days heuristic is deleted; reviving it would mark quiet months incomplete.
 *
 *   - **Sources are never summed across for one metric-period.** The first covering source wins the
 *     whole family. Adding a bank figure to a trial-balance figure would double-count, and choosing
 *     per-metric would let gross profit come from one source and revenue from another.
 *
 * Pure: no I/O, no clock. The batches, periods and accounts are supplied by the caller.
 */

import { bankCoverageFromRatio, completenessHolds } from '@/core/periods';
import { bankCoverageFor, coveredRuns, runsCover } from './cash-history';

import type {
  BankAccountRef, BasisChoice, DataQualityWarning, PeriodCoverage, PeriodRef, SourceCoverage,
  SourceKind,
} from './types';

/** A committed import batch, as far as coverage needs to know (§2.2). */
export interface CoverageBatch {
  readonly id: string;
  readonly targetTable: 'ledger_entries' | 'period_balances' | 'bank_transactions' | 'invoices';
  readonly balanceKind: 'trial_balance' | 'pnl_report' | 'balance_sheet' | null;
  readonly balanceBasis: 'cumulative' | 'movement' | null;
  readonly bankAccountId: string | null;
  readonly invoiceListKind: 'full' | 'open_items' | null;
  /**
   * What was imported (`import_batches.import_type`). A sales list and a purchase list are both
   * `invoices`, and only this says which side was covered: the AR/AP test reads it per side, and the
   * invoices P&L source needs a SALES list (FU-1). Optional for the other tables; an invoice batch
   * without it is a list of unknown side and establishes no revenue.
   */
  readonly importType?: string | null;
  /** The DECLARED range the reviewer confirmed, not the min/max posting date. */
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly committedAt: string;
}

export interface CoverageInput {
  readonly period: PeriodRef;
  readonly batches: readonly CoverageBatch[];
  readonly bankAccounts: readonly BankAccountRef[];
  /** Periods that actually carry accepted rows, per source, so an empty declared range is caught. */
  readonly rowCounts: Readonly<Partial<Record<SourceKind, number>>>;
  /**
   * Today, to tell the CURRENT period (the one containing it) for the invoices source's revenue-to-date
   * rule (FU-1). Explicit, never read from a clock (§1.1).
   */
  readonly asOf: string;
  /**
   * Every committed statement of the organisation, all history (ADR-124). An account's scope — when
   * it starts, when a closed one ends — is a fact about ALL its statements, not the window's.
   * Omitted, the bank batches among `batches` stand in.
   */
  readonly statements?: ReadonlyArray<{ readonly bankAccountId: string; readonly periodStart: string; readonly periodEnd: string }>;
}

const NO_COVERAGE: SourceCoverage = { covers: false, warnings: [], completeness: 0 };

/** A batch's declared range spans the whole period. */
function spans(batch: CoverageBatch, period: PeriodRef): boolean {
  return batch.periodStart <= period.periodStart && batch.periodEnd >= period.periodEnd;
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/**
 * The winning balance batch for a period and kind: the latest committed, non-rolled-back batch of
 * that kind whose declared range spans the period (ADR-029.2). "Latest" breaks ties by commit time,
 * then by id, so the choice is deterministic under any input order.
 */
export function winningBalanceBatch(
  batches: readonly CoverageBatch[],
  period: PeriodRef,
  kind: 'trial_balance' | 'pnl_report' | 'balance_sheet',
): CoverageBatch | null {
  const candidates = batches
    .filter((b) => b.targetTable === 'period_balances' && b.balanceKind === kind && spans(b, period))
    .sort((a, b) => b.committedAt.localeCompare(a.committedAt) || b.id.localeCompare(a.id));
  return candidates[0] ?? null;
}

/**
 * Kind precedence per family (ADR-047.4): a trial balance beats a P&L report for P&L families, and
 * beats a balance sheet for balance families. A trial balance is the more complete statement, so
 * preferring it means a customer who uploads both does not get two different revenue figures
 * depending on which the engine happened to pick.
 */
export function chooseBalanceKind(
  batches: readonly CoverageBatch[],
  period: PeriodRef,
  family: 'pnl' | 'balance',
): { kind: 'trial_balance' | 'pnl_report' | 'balance_sheet'; batch: CoverageBatch } | null {
  const order: Array<'trial_balance' | 'pnl_report' | 'balance_sheet'> =
    family === 'pnl' ? ['trial_balance', 'pnl_report'] : ['trial_balance', 'balance_sheet'];

  for (const kind of order) {
    const batch = winningBalanceBatch(batches, period, kind);
    if (batch) return { kind, batch };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Receivables and payables (§2.2, ADR-120)
// ---------------------------------------------------------------------------------------------

export type InvoiceSide = 'sales' | 'purchase';

const SIDE_IMPORT_TYPES: Readonly<Record<InvoiceSide, readonly string[]>> = {
  sales: ['sales_invoices', 'sales_report'],
  purchase: ['purchase_invoices', 'purchase_report'],
};

/** §2.2's AR/AP freshness gate, in days after the period ends. */
export const AR_AP_FRESHNESS_DAYS = 45;

export interface InvoiceSideCoverage {
  /** A batch of this side covers P under §2.2's AR/AP test. */
  readonly covers: boolean;
  /** Any committed batch of this side exists at all; `covers = false` with this true is `stale_invoice_data`. */
  readonly anyBatch: boolean;
  /** A `full` list of this side spans P — only a full list states the sales history DSO divides by. */
  readonly fullListSpans: boolean;
  /** An `open_items` list of this side spans P (ADR-047.10: it makes the DSO denominator meaningless). */
  readonly openItemsSpans: boolean;
}

/**
 * §2.2, "`invoices` (AR/AP families)", per SIDE (ADR-120), as decided in ADR-124 D-3 — which replaces
 * ADR-123's freshness rule.
 *
 * A receivables or payables figure for a COMPLETED month is a position at that month's END. A list
 * can state it only if it knows what was open on that day. So a batch of the side covers P when:
 *
 *   (a) its declared range SPANS P — a full list (every invoice, with its payment dates) spanning
 *       P can reconstruct the position on any day inside it; an open-items (aged-debtors) list states
 *       the position only on its own as-at date, its range's end, so it must end ON `P.period_end`; or
 *
 *   (b) P is COMPLETED and the batch is FRESH for it: committed AFTER `P.period_end`, no more than 45
 *       days after it (§2.2's freshness gate), and it states the position AT `P.period_end`:
 *         - a full list whose range reaches `P.period_end` (starts on or before it, ends on or after it);
 *         - an open-items list whose as-at date (its range's end) is exactly `P.period_end`.
 *       An open-items list dated after P's end cannot state P: the invoices paid in between are not
 *       on it, so it would under-state P (audit N-10). A list committed DURING a completed month
 *       knew nothing after the day it was committed, so it states nothing about the month's end — it
 *       used to outrank that month's own balance sheet with a verified figure (audit N-4, BSLIST); or
 *
 *   (c) P is the CURRENT period (the one containing the run's as-of date) and the batch was committed
 *       on or after `P.period_start` with a range overlapping P — unchanged from ADR-123: a list
 *       uploaded on the 10th ages the month it was uploaded in (audit F-9), and the figure is dated
 *       at the run's as-of, not at a month end nobody has reached.
 *
 * When no batch of the side covers P the family falls through to `period_balances` / `ledger` (§2.3),
 * so recency of upload alone never overrides a more authoritative source.
 */
export function invoiceSideCoverage(
  batches: readonly CoverageBatch[],
  period: PeriodRef,
  side: InvoiceSide,
  current = false,
): InvoiceSideCoverage {
  const ofSide = batches.filter(
    (b) => b.targetTable === 'invoices' && SIDE_IMPORT_TYPES[side].includes(b.importType ?? ''),
  );
  const openItems = (b: CoverageBatch): boolean => b.invoiceListKind === 'open_items';
  /** The batch states the position at the close of `P.period_end`. */
  const statesMonthEnd = (b: CoverageBatch): boolean => (openItems(b)
    ? b.periodEnd === period.periodEnd
    : b.periodStart <= period.periodEnd && b.periodEnd >= period.periodEnd);
  const spanning = (b: CoverageBatch): boolean => spans(b, period) && (current || !openItems(b) || statesMonthEnd(b));
  const fresh = (b: CoverageBatch): boolean => {
    const committed = b.committedAt.slice(0, 10);
    if (current) {
      return committed >= period.periodStart && b.periodStart <= period.periodEnd && b.periodEnd >= period.periodStart;
    }
    return committed > period.periodEnd
      && daysBetween(period.periodEnd, committed) <= AR_AP_FRESHNESS_DAYS
      && statesMonthEnd(b);
  };
  return {
    covers: ofSide.some((b) => spanning(b) || fresh(b)),
    anyBatch: ofSide.length > 0,
    fullListSpans: ofSide.some((b) => b.invoiceListKind === 'full' && spans(b, period)),
    openItemsSpans: ofSide.some((b) => openItems(b) && spans(b, period)),
  };
}

/**
 * A committed FULL list of one SIDE's invoices. A full SALES list is the only list that states a
 * month's revenue (FU-1); a full PURCHASE list is the only list that states its invoice-basis costs
 * (FU-12). An `open_items` list states what is owed, never a month's flow (ADR-047.10).
 */
function isFullList(b: CoverageBatch, side: InvoiceSide): boolean {
  return b.targetTable === 'invoices'
    && b.invoiceListKind === 'full'
    && SIDE_IMPORT_TYPES[side].includes(b.importType ?? '');
}

/** Whole days from `a` to `b`, both inclusive. */
function daysInclusive(a: string, b: string): number {
  return daysBetween(a, b) + 1;
}

/**
 * The days a side's full lists can state, as runs of consecutive days (FU-1, FU-12). A list knows the
 * invoices of its declared range only up to the day it was COMMITTED: a range a reviewer declared past
 * that day — the upload form lets any end date be typed, and a new batch defaults to the whole current
 * month — describes days the list had not seen. So a list's effective range is its declared start to
 * the earlier of its declared end and its commit date, and lists that meet or overlap combine, as a
 * month's statements do (ADR-124 D-1).
 */
function listRuns(
  batches: readonly CoverageBatch[],
  side: InvoiceSide,
): ReadonlyArray<{ readonly start: string; readonly end: string }> {
  return coveredRuns(batches.filter((b) => isFullList(b, side)).flatMap((b) => {
    const committed = b.committedAt.slice(0, 10);
    const end = b.periodEnd < committed ? b.periodEnd : committed;
    return end >= b.periodStart ? [{ periodStart: b.periodStart, periodEnd: end }] : [];
  }));
}

/**
 * Whether one side's committed FULL lists establish P (FU-1 for sales, FU-12 for purchases): their
 * effective ranges (`listRuns`) contain every day of a COMPLETED P; for the CURRENT P, its first day
 * and on, to date (`partial_month`, completeness = days reached ÷ days in P); never a P not yet begun.
 */
function invoiceListCoverage(
  batches: readonly CoverageBatch[],
  period: PeriodRef,
  asOf: string,
  side: InvoiceSide,
): SourceCoverage {
  const today = asOf.slice(0, 10);
  if (period.periodStart > today) return NO_COVERAGE;
  const runs = listRuns(batches, side);

  if (today > period.periodEnd) {
    return runsCover(runs, period.periodStart, period.periodEnd)
      ? { covers: true, warnings: [], completeness: 1 }
      : NO_COVERAGE;
  }

  // The current period: the run holding P's first day, never past today.
  const run = runs.find((r) => r.start <= period.periodStart && r.end >= period.periodStart);
  if (run === undefined) return NO_COVERAGE;
  const reach = run.end < today ? run.end : today;
  if (reach >= period.periodEnd) return { covers: true, warnings: [], completeness: 1 };
  const covered = daysInclusive(period.periodStart, reach);
  const days = daysInclusive(period.periodStart, period.periodEnd);
  return { covers: true, warnings: ['partial_month'], completeness: covered / days };
}

/**
 * §2.2, "`invoices` (P&L and customer families)", as decided for ADR-122 FU-1 (ADR-125).
 *
 * A source that does not cover a period must never manufacture a financial zero for it: once the
 * invoices source "covers" P, precedence hands it the whole P&L (§2.3) and a month with no invoice
 * cells reads as revenue 0.00, calculated and complete. So the invoices source covers P ONLY when
 * committed `full` lists of SALES invoices (`sales_invoices` / `sales_report`) ESTABLISH P's revenue —
 * when their effective ranges (`listRuns`: declared start to the earlier of declared end and
 * commit date, lists that meet combined) contain:
 *
 *   - every day of P, for a COMPLETED period. When a list was committed matters only as the last day
 *     it can know: a list committed on 10 September states nothing about 11–30 September, whatever
 *     range was declared, and a list committed before a month states nothing about it at all.
 *
 *   - for the CURRENT period (it contains the run's as-of date), P's first day and on: revenue TO
 *     DATE, through the earlier of that run's end and the as-of date. The figure carries
 *     `partial_month`, and its completeness is the share of P's days it reaches. It is complete only
 *     once it reaches P's last day.
 *
 * Never covers P:
 *   - a period that has not begun (after the as-of date) — nothing can state its revenue yet;
 *   - an `open_items` (aged-debtors) list — it defines what is owed, never revenue (ADR-047.10);
 *   - a PURCHASE-only list — revenue would be a zero no list states;
 *   - any list merely committed near P. The AR/AP freshness gate (45 days, ADR-124 D-3) is a rule
 *     about a month-END POSITION and belongs to `invoiceSideCoverage` alone. Here it used to hand the
 *     P&L to lists committed BEFORE P (a negative gap is "within 45 days") and to months far in the
 *     future, each stating revenue 0.00 with `open_items_only` (FU-1).
 *
 * A batch's `invoice_list_kind` is `full` unless the reviewer confirmed it as open items (IMP-INV-012):
 * the import pipeline writes it at commit (migration 20260930000004, FU-13).
 *
 * When the invoices source does not cover P, the families fall through their §2.3 order unchanged:
 * the P&L to the bank (a cash proxy), else NULL with `no_source_covers_period` — never zero. Lists
 * covering P with no sales in P still state a genuine, stated 0.00.
 */
export function invoiceRevenueCoverage(
  batches: readonly CoverageBatch[],
  period: PeriodRef,
  asOf: string,
): SourceCoverage {
  return invoiceListCoverage(batches, period, asOf, 'sales');
}

/**
 * ADR-122 FU-12, the cost-side twin of FU-1: whether committed FULL PURCHASE lists
 * (`purchase_invoices` / `purchase_report`) establish P's invoice-basis COSTS, by exactly the rules
 * `invoiceRevenueCoverage` applies to sales — effective range declared start → min(declared end,
 * commit date), lists that meet combine, a completed P needs every day, the current P is covered to
 * date (`partial_month`), a P not yet begun never.
 *
 * It decides nothing about which source wins (a purchase-only list still does not make the invoices
 * source cover P: costs alone are no P&L). Once a sales list has handed the P&L to the invoices source,
 * it decides whether that P&L may state its cost lines and supplier figures: a sales list alone says
 * nothing about purchases, and summing the purchase invoices nobody established for P stated costs
 * 0.00 and profit = revenue. Uncovered, every expense-side figure is NULL `no_source_covers_period`.
 */
export function invoiceCostCoverage(
  batches: readonly CoverageBatch[],
  period: PeriodRef,
  asOf: string,
): SourceCoverage {
  return invoiceListCoverage(batches, period, asOf, 'purchase');
}

/** The last day full sales lists state revenue for, never past the as-of date (`isPeriodComplete`). */
function revenueDataDate(batches: readonly CoverageBatch[], asOf: string): string | null {
  const today = asOf.slice(0, 10);
  const ends = listRuns(batches, 'sales').map((r) => (r.end < today ? r.end : today)).sort();
  return ends[ends.length - 1] ?? null;
}

/** Cash-like account types. Credit-card and loan accounts are tracked but are not cash (§4.4). */
const CASH_LIKE = new Set(['current', 'savings']);

export function computeCoverage(input: CoverageInput): PeriodCoverage {
  const { period, batches, bankAccounts, rowCounts, asOf } = input;

  // ---- period_balances ----
  const pnlBalance = chooseBalanceKind(batches, period, 'pnl');
  const balances: SourceCoverage = pnlBalance
    ? {
        covers: true,
        warnings: [],
        completeness: 1,
        balanceKind: pnlBalance.kind,
        balanceBasis: pnlBalance.batch.balanceBasis ?? 'movement',
      }
    : NO_COVERAGE;

  // ---- ledger ----
  // Both conditions are required: rows in the period AND a batch whose declared range spans it. Rows
  // alone would let a half-uploaded month look complete; a range alone would let an empty declared
  // month claim coverage it has no data for.
  const ledgerBatch = batches.find((b) => b.targetTable === 'ledger_entries' && spans(b, period));
  const ledgerRows = rowCounts.ledger ?? 0;
  const ledger: SourceCoverage = ledgerBatch && ledgerRows > 0
    ? { covers: true, warnings: [], completeness: 1 }
    : ledgerRows > 0
      // Rows exist but no declared range covers the month: the month is beyond what the export
      // claimed, so it is partial rather than complete (§2.2).
      ? { covers: true, warnings: ['partial_month'], completeness: 0.5 }
      : NO_COVERAGE;

  // ---- invoices ----
  const invoices = invoiceRevenueCoverage(batches, period, asOf);
  // FU-12: whether purchase lists establish P's invoice-basis costs. Not a source of its own — it
  // never makes the invoices source cover P — but the cost lines and supplier figures of an invoice
  // basis read it.
  //
  // In the CURRENT period both sides are stated to date, and a profit is revenue minus costs over the
  // SAME days: sales reaching the 25th against purchases reaching the 3rd is 25 days of revenue less
  // 3 days of costs — profit ≈ revenue again, with nothing to show the windows differ. So current-
  // period costs are established only when the purchase lists reach exactly as far as the sales lists
  // (equal reach ⇔ equal completeness: both are days reached ÷ days in P); otherwise they are NULL.
  // A completed period is covered by both sides only in full, so the windows agree by construction.
  const purchases = invoiceCostCoverage(batches, period, asOf);
  const invoiceCosts = purchases.covers && invoices.covers && purchases.completeness !== invoices.completeness
    ? NO_COVERAGE
    : purchases;

  // ---- bank ----
  // EVERY in-scope cash-like account needs its statements to cover every day of the period it
  // exists for — one statement or several that meet (ADR-124 D-1: a 5th-to-4th cycle covers a month
  // between two statements). An account that has not started yet, or a closed one after its last
  // statement, is not in scope (D-2). A covered month with no transactions is fine; an uncovered
  // account is not, because its movements are simply invisible.
  const statementRanges = input.statements ?? batches
    .filter((b) => b.targetTable === 'bank_transactions' && b.bankAccountId !== null)
    .map((b) => ({ bankAccountId: b.bankAccountId!, periodStart: b.periodStart, periodEnd: b.periodEnd }));
  const bankScope = bankCoverageFor(bankAccounts, statementRanges, period);
  const hasActiveCashLike = bankAccounts.some((a) => a.isActive && CASH_LIKE.has(a.accountType));

  const bankRatio = bankScope.inScope.length === 0
    ? (hasActiveCashLike ? 0 : 1)
    : bankScope.covered.length / bankScope.inScope.length;

  const bankWarnings: DataQualityWarning[] = [];
  if (bankRatio > 0 && bankRatio < 1) bankWarnings.push('bank_coverage_partial');

  const bank: SourceCoverage = bankScope.covered.length > 0 || (rowCounts.bank ?? 0) > 0
    ? { covers: true, warnings: bankWarnings, completeness: bankRatio }
    : NO_COVERAGE;

  const latestDataDate: Partial<Record<SourceKind, string>> = {};
  for (const source of ['period_balances', 'ledger', 'invoices', 'bank'] as const) {
    const table = source === 'period_balances' ? 'period_balances'
      : source === 'ledger' ? 'ledger_entries'
      : source === 'invoices' ? 'invoices' : 'bank_transactions';
    // FU-1: the invoices source's data reaches only as far as a FULL SALES list can state revenue —
    // no further than it was committed, and never past the as-of date, so a current month stated to
    // date is not complete (`isPeriodComplete`). An open-items or purchase list states no revenue.
    if (source === 'invoices') {
      const reach = revenueDataDate(batches, asOf);
      if (reach) latestDataDate.invoices = reach;
      continue;
    }
    const dates = batches.filter((b) => b.targetTable === table).map((b) => b.periodEnd).sort();
    const latest = dates[dates.length - 1];
    if (latest) latestDataDate[source] = latest;
  }

  return {
    periodId: period.id,
    bySource: { period_balances: balances, ledger, invoices, bank },
    invoiceCosts,
    bankCoverageRatio: bankRatio,
    latestDataDate,
  };
}

// ---------------------------------------------------------------------------------------------
// Precedence (§2.3)
// ---------------------------------------------------------------------------------------------

export type MetricFamilyKey = 'pnl' | 'cash' | 'receivables_payables' | 'counterparty';

/** The ordered sources per family, exactly as §2.3 states them. */
export const FAMILY_PRECEDENCE: Readonly<Record<MetricFamilyKey, readonly SourceKind[]>> = {
  pnl: ['period_balances', 'ledger', 'invoices', 'bank'],
  cash: ['bank', 'ledger', 'period_balances'],
  receivables_payables: ['invoices', 'period_balances', 'ledger'],
  counterparty: ['invoices', 'ledger', 'bank'],
};

/** The assurance each source confers on each family (§2.3, the "Assurance when chosen" column). */
function assuranceFor(family: MetricFamilyKey, source: SourceKind): BasisChoice['assurance'] {
  if (family === 'pnl') {
    // A bank figure standing in for an accrual figure is an estimate, however exact the arithmetic.
    if (source === 'bank') return 'estimated';
    if (source === 'period_balances') return 'verified';
    return 'calculated';
  }
  if (family === 'cash') {
    if (source === 'bank') return 'verified';
    if (source === 'ledger') return 'calculated';
    return 'estimated';
  }
  if (family === 'receivables_payables') {
    return source === 'invoices' ? 'verified' : 'calculated';
  }
  return source === 'bank' ? 'estimated' : 'calculated';
}

/**
 * The first covering source wins the family. When nothing covers it, the caller writes every metric
 * of the family as NULL with `no_source_covers_period` — never zero (§2.3).
 */
export function choosePrecedence(
  coverage: PeriodCoverage,
  family: MetricFamilyKey,
): BasisChoice {
  for (const source of FAMILY_PRECEDENCE[family]) {
    const sourceCoverage = coverage.bySource[source];
    if (!sourceCoverage.covers) continue;

    const warnings = [...sourceCoverage.warnings];
    const proxy = family === 'pnl' && source === 'bank';
    if (proxy) {
      // §2.3: a bank-basis P&L is a cash proxy and says so on every figure it produces.
      warnings.push('cash_basis_proxy', 'vat_inclusive');
    }

    return {
      basis: source,
      assurance: assuranceFor(family, source),
      warnings,
      proxy,
      balanceKind: sourceCoverage.balanceKind,
      balanceBasis: sourceCoverage.balanceBasis,
    };
  }

  return { basis: 'none', assurance: 'calculated', warnings: [], proxy: false };
}

/**
 * `fiscal_periods.is_complete` (ADR-030.1, ADR-047.6, ADR-093).
 *
 * The chosen P&L source's latest data date reaches the period end, AND bank coverage is full or
 * there is no active cash-like account. Partial bank coverage is a data-quality warning rather than
 * incompleteness, so a ledger-based organization with quarterly statements still gets complete
 * months — which is the case the rule exists to allow.
 *
 * **This function resolves; it does not decide.** ADR-030.1 puts the rule in `core/periods`, and
 * this used to be a second copy of it — one that asked about bank coverage as a ratio while the
 * other asked about a three-valued enum. What is left here is the engine's own work: choosing the
 * P&L source by §2.3 precedence, finding that source's latest data date, and deciding which bank
 * accounts count as cash-like. The verdict itself is `completenessHolds`, and this is the only
 * caller that supplies it from engine coverage.
 */
export function isPeriodComplete(
  coverage: PeriodCoverage,
  period: PeriodRef,
  bankAccounts: readonly BankAccountRef[],
): boolean {
  const pnlBasis = choosePrecedence(coverage, 'pnl');
  const source = pnlBasis.basis === 'none' ? null : (pnlBasis.basis as SourceKind);

  return completenessHolds({
    pnlLatestDataDate: source === null ? null : coverage.latestDataDate[source] ?? null,
    periodEnd: period.periodEnd,
    bankCoverage: bankCoverageFromRatio(coverage.bankCoverageRatio),
    hasActiveCashLikeAccount: bankAccounts.some((a) => a.isActive && CASH_LIKE.has(a.accountType)),
  });
}
