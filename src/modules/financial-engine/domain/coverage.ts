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
  /** Today, for the invoice freshness gate. Explicit, never read from a clock (§1.1). */
  readonly asOf: string;
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
  // The revenue family needs a `full` list: an aged-debtors list never defines revenue (ADR-047.10).
  const fullInvoiceBatch = batches.find(
    (b) => b.targetTable === 'invoices' && b.invoiceListKind === 'full' && spans(b, period),
  );
  // The AR/AP families accept any kind, and also accept a batch committed within 45 days after the
  // period ends — the freshness gate, so last month's receivables are not answered from a list
  // uploaded a year later.
  const arApBatch = batches.find(
    (b) => b.targetTable === 'invoices'
      && (spans(b, period) || daysBetween(period.periodEnd, b.committedAt.slice(0, 10)) <= 45),
  );

  const invoices: SourceCoverage = fullInvoiceBatch
    ? { covers: true, warnings: [], completeness: 1 }
    : arApBatch
      ? { covers: true, warnings: ['open_items_only'], completeness: 0.7 }
      : NO_COVERAGE;

  // ---- bank ----
  // EVERY active cash-like account needs a statement whose declared range spans the period. A
  // covered month with no transactions is fine; an uncovered account is not, because its movements
  // are simply invisible and the cash figure would be wrong without saying so.
  const activeCashLike = bankAccounts.filter((a) => a.isActive && CASH_LIKE.has(a.accountType));
  const coveredAccounts = activeCashLike.filter((account) =>
    batches.some((b) => b.targetTable === 'bank_transactions'
      && b.bankAccountId === account.id && spans(b, period)));

  const bankRatio = activeCashLike.length === 0
    ? 1
    : coveredAccounts.length / activeCashLike.length;

  const bankWarnings: DataQualityWarning[] = [];
  if (bankRatio > 0 && bankRatio < 1) bankWarnings.push('bank_coverage_partial');

  const bank: SourceCoverage = coveredAccounts.length > 0 || (rowCounts.bank ?? 0) > 0
    ? { covers: true, warnings: bankWarnings, completeness: bankRatio }
    : NO_COVERAGE;

  const latestDataDate: Partial<Record<SourceKind, string>> = {};
  for (const source of ['period_balances', 'ledger', 'invoices', 'bank'] as const) {
    const table = source === 'period_balances' ? 'period_balances'
      : source === 'ledger' ? 'ledger_entries'
      : source === 'invoices' ? 'invoices' : 'bank_transactions';
    const dates = batches.filter((b) => b.targetTable === table).map((b) => b.periodEnd).sort();
    const latest = dates[dates.length - 1];
    if (latest) latestDataDate[source] = latest;
  }

  void asOf;

  return {
    periodId: period.id,
    bySource: { period_balances: balances, ledger, invoices, bank },
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
