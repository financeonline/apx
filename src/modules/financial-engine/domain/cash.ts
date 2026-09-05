/**
 * Cash metrics (FINANCIAL_ENGINE.md §3.3, ADR-028, CD-06 / ADR-027.3).
 *
 * Six keys: `cash_inflows`, `cash_outflows`, `net_cash_movement`, `opening_cash`, `closing_cash`
 * and `cash_runway_months`.
 *
 * Two rules in here are the ones that go wrong in practice, so they are stated once, here:
 *
 *  1. **A transfer is cash-neutral only between cash-like accounts** (ADR-028). A £3,000 payment
 *     from the current account to the credit card is `is_transfer = true` for P&L purposes — it is
 *     not an expense, the card purchases were — but it is real money leaving the business, so the
 *     cash-like leg counts as an outflow, reported under category `credit_card`. Cancelling it
 *     would overstate closing cash by every repayment ever made, cumulatively.
 *  2. **Opening cash is never assumed.** When no source states it, `opening_cash` and every later
 *     `closing_cash` are NULL with `no_opening_cash` (CD-06, §1.5). Zero would tell a healthy
 *     business it has no money.
 *
 * Pure: no clock, no I/O. Every balance and `asOf` arrive as inputs, and the series is computed from
 * a deterministically sorted copy of them, so two runs over the same records produce byte-identical
 * results whatever order the caller assembled the input in (§1.1).
 */

import {
  Decimal,
  abs,
  divide,
  isPositive,
  parseDecimal,
  subtract,
  sum,
  toMoneyString,
  toRatioString,
} from '@/core/money';
import { monthsBetween, yearMonthOf } from '@/core/periods';
import type { BankAccountType, TransferKind } from '@/modules/banking';
import type {
  AggregateCell,
  AssuranceLevel,
  BasisChoice,
  DataQuality,
  DataQualityMissing,
  DataQualityWarning,
  EngineContext,
  EvidenceQuery,
  LeafDescriptor,
  MetricBasis,
  MetricResult,
  PeriodRef,
} from './types';

// ---------------------------------------------------------------------------------------------
// Helpers shared by the three metric families of §3.3–§3.5
//
// These belong in a `metrics.ts` next to the registry once that file exists; until then they live
// with the first family that needed them and `receivables.ts` / `concentration.ts` import them, so
// that "how a MetricResult is assembled" has exactly one definition.
// ---------------------------------------------------------------------------------------------

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** First-seen order, so a warning list is a function of the data and not of a Set's iteration. */
export function dedupeCodes<T>(values: readonly T[]): readonly T[] {
  const seen: T[] = [];
  for (const value of values) if (!seen.includes(value)) seen.push(value);
  return seen;
}

export function metricQuality(
  completeness: number,
  warnings: readonly DataQualityWarning[],
  missing: readonly DataQualityMissing[],
  proxy = false,
): DataQuality {
  return {
    completeness: clamp01(completeness),
    proxy,
    warnings: dedupeCodes(warnings),
    missing: dedupeCodes(missing),
  };
}

const ASSURANCE_STRENGTH: Readonly<Record<AssuranceLevel, number>> = {
  verified: 3, calculated: 2, estimated: 1, inferred: 0,
};

/** §5: a figure is never firmer than its weakest input. */
export function weakerAssurance(a: AssuranceLevel, b: AssuranceLevel): AssuranceLevel {
  return ASSURANCE_STRENGTH[a] <= ASSURANCE_STRENGTH[b] ? a : b;
}

/** `basis = 'mixed'` whenever a derived figure's inputs disagree (§2.3). */
export function combineBasis(bases: readonly MetricBasis[]): MetricBasis {
  const distinct = dedupeCodes(bases.filter((basis) => basis !== 'none'));
  if (distinct.length === 0) return 'none';
  return distinct.length === 1 ? (distinct[0] ?? 'none') : 'mixed';
}

export function leafEvidence(
  ctx: EngineContext,
  table: LeafDescriptor['table'],
  filters: LeafDescriptor['filters'],
): EvidenceQuery {
  return {
    kind: 'leaf',
    descriptor: {
      v: 1,
      table,
      filters,
      as_of: { calculation_run_id: ctx.calculationRunId, aggregated_at: ctx.aggregatedAt },
    },
  };
}

/**
 * A derived metric points at the snapshots it was computed from (§3, ADR-034).
 *
 * `snapshot_id` is null at compute time — the ids exist only after the insert of step 8, and the run
 * fills them in as it writes. Naming the components is what lets the drawer descend.
 */
export function derivedEvidence(names: readonly string[]): EvidenceQuery {
  return { kind: 'derived', components: names.map((name) => ({ name, snapshot_id: null })) };
}

/** One period's output. The run turns each `MetricResult` into a `metric_snapshots` row. */
export interface PeriodMetrics {
  readonly periodId: string;
  readonly metrics: readonly MetricResult[];
}

// ---------------------------------------------------------------------------------------------
// The cash-like set
// ---------------------------------------------------------------------------------------------

/**
 * §3: "cash-like bank account types `{current, savings}`". Credit-card and loan accounts are
 * liabilities: they are tracked for balances and reach `working_capital` through their categories,
 * never through cash (§4.4).
 */
export const CASH_LIKE_ACCOUNT_TYPES: readonly BankAccountType[] = ['current', 'savings'];

export function isCashLike(accountType: BankAccountType): boolean {
  return CASH_LIKE_ACCOUNT_TYPES.includes(accountType);
}

/**
 * Whether one leg of a movement belongs in `cash_inflows` / `cash_outflows` (ADR-028).
 *
 * The leg must sit on a cash-like account, and the pair must not be cash-like ↔ cash-like.
 * `card_repayment`, `loan_repayment` and `loan_drawdown` all pass, which is ADR-028's whole point;
 * an `other_transfer` leg never sits on a cash-like account, and the account test rejects it anyway.
 */
export function countsInCashMetrics(
  accountType: BankAccountType,
  transferKind: TransferKind,
): boolean {
  return isCashLike(accountType) && transferKind !== 'cash_transfer';
}

// ---------------------------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------------------------

/**
 * One `AggregateCell` of the `bank` source, carrying the transfer dimension cash metrics need.
 *
 * `app.aggregate_periods` groups by period × source × category × account × counterparty × bank
 * account (§2.4 step 4); cash adds `transfer_kind` to that grouping, because the exclusion in
 * ADR-028 is a property of the pair, not of the category. The engine still never iterates raw rows —
 * the cell count is periods × accounts × categories × kinds.
 *
 * For the `bank` source the two side columns carry the two directions, in the natural sign of the
 * cash account they describe (`debit − credit`, `core/money/direction.ts`):
 *   `debit`  = Σ amount where amount > 0   (money in)
 *   `credit` = Σ |amount| where amount < 0 (money out)
 * so `amount = debit − credit` exactly as for a ledger cell, and `cash_outflows` is "Σ |amount|
 * (stored positive)" as §3.3 requires.
 */
export interface BankAggregateCell extends AggregateCell {
  readonly source: 'bank';
  readonly bankAccountId: string;
  readonly transferKind: TransferKind;
  /**
   * ADR-047.12: the row looks like a transfer but no pair was detected. It stays in the sums — the
   * alternative is making a real movement vanish on a description match — and raises a warning.
   */
  readonly unpairedTransferCandidate: boolean;
}

/** Where an opening balance came from, in CD-06 precedence order. */
export const OPENING_CASH_SOURCES = [
  'statement_opening_balance',
  'bank_account_opening_balance',
  'balance_sheet_prior_period',
  'opening_balance_journal',
] as const;
export type OpeningCashSource = (typeof OPENING_CASH_SOURCES)[number];

/**
 * A stated opening balance for one cash-like account.
 *
 * `statement_opening_balance` is `import_batches.statement_opening_balance` — the figure captured
 * deterministically from the statement at import, **never** an AI-read value on its own (CD-06). The
 * loader is responsible for not offering one that came from an unconfirmed extraction.
 */
export interface OpeningCashCandidate {
  readonly bankAccountId: string;
  readonly source: OpeningCashSource;
  readonly value: string;
  /** The date the balance is stated as at; a candidate later than `P.period_start` is not eligible. */
  readonly asAtDate: string | null;
}

/** `balance_after` on the last transaction of P for one account, for the closing cross-check. */
export interface StatementClosingBalance {
  readonly bankAccountId: string;
  readonly balanceAfter: string;
}

export interface CashPeriodInput {
  readonly period: PeriodRef;
  /** The cash family's precedence outcome for this period (§2.3). */
  readonly basis: BasisChoice;
  readonly movements: readonly BankAggregateCell[];
  /** Every opening balance available for this period, in any order. */
  readonly openingCandidates: readonly OpeningCashCandidate[];
  /** Active cash-like accounts with a statement covering P (§2.2). */
  readonly coveredBankAccountIds: readonly string[];
  /** Present only when every covered account's last transaction carries `balance_after`. */
  readonly statementClosing?: readonly StatementClosingBalance[];
  /** A statement batch that could not be reconciled at import (`IMP-BAL-007`). */
  readonly unreconciledStatement?: boolean;
}

/** `closing_cash` of the period before the first input — chunked runs read it from `metric_current`. */
export interface CashCarry {
  readonly value: string | null;
  readonly basis: MetricBasis;
  readonly assurance: AssuranceLevel;
  readonly missing: readonly DataQualityMissing[];
  /** Accounts already covered before the first input period, so mid-history joiners are detected. */
  readonly coveredBankAccountIds?: readonly string[];
}

export interface CashSeriesOptions {
  readonly openingCarry?: CashCarry | null;
  /**
   * `net_cash_movement` of the periods immediately before the first input, oldest first. Runway
   * needs three consecutive months, so a chunk boundary would otherwise lose two of them.
   */
  readonly priorNetMovements?: readonly (string | null)[];
}

// ---------------------------------------------------------------------------------------------
// One period's movements
// ---------------------------------------------------------------------------------------------

interface MovementTotals {
  readonly inflows: Decimal;
  readonly outflows: Decimal;
  /** The `expense_by_category`-style cash breakdown of §3.3, where a debt leg shows its category. */
  readonly byCategory: ReadonlyArray<{ category: string; inflow: string; outflow: string }>;
  readonly excludedTransferLegs: number;
  readonly unpairedCandidates: number;
  readonly unresolvedAccounts: number;
}

/** Sort key for a cell, so sums and component lists never depend on the loader's row order. */
function cellOrder(a: BankAggregateCell, b: BankAggregateCell): number {
  return (
    a.bankAccountId.localeCompare(b.bankAccountId) ||
    (a.standardCategory ?? '').localeCompare(b.standardCategory ?? '') ||
    a.transferKind.localeCompare(b.transferKind) ||
    (a.accountId ?? '').localeCompare(b.accountId ?? '')
  );
}

function totalMovements(
  cells: readonly BankAggregateCell[],
  accountTypeById: ReadonlyMap<string, BankAccountType>,
): MovementTotals {
  const byCategory = new Map<string, { inflow: Decimal; outflow: Decimal }>();
  let inflows = new Decimal(0);
  let outflows = new Decimal(0);
  let excludedTransferLegs = 0;
  let unpairedCandidates = 0;
  let unresolvedAccounts = 0;

  for (const cell of [...cells].sort(cellOrder)) {
    const accountType = accountTypeById.get(cell.bankAccountId);
    if (accountType === undefined) {
      // A cell naming an account the run did not load. Skipping it silently would move money out of
      // the figures without saying so, so it is counted into `components` instead.
      unresolvedAccounts += 1;
      continue;
    }
    if (!isCashLike(accountType)) continue;
    if (!countsInCashMetrics(accountType, cell.transferKind)) {
      excludedTransferLegs += 1;
      continue;
    }
    if (cell.unpairedTransferCandidate) unpairedCandidates += 1;

    const inflow = parseDecimal(cell.debit, 'debit');
    const outflow = parseDecimal(cell.credit, 'credit');
    inflows = inflows.plus(inflow);
    outflows = outflows.plus(outflow);

    const category = cell.standardCategory ?? 'uncategorised';
    const running = byCategory.get(category) ?? { inflow: new Decimal(0), outflow: new Decimal(0) };
    byCategory.set(category, {
      inflow: running.inflow.plus(inflow),
      outflow: running.outflow.plus(outflow),
    });
  }

  return {
    inflows,
    outflows,
    byCategory: [...byCategory.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([category, totals]) => ({
        category,
        inflow: toMoneyString(totals.inflow),
        outflow: toMoneyString(totals.outflow),
      })),
    excludedTransferLegs,
    unpairedCandidates,
    unresolvedAccounts,
  };
}

// ---------------------------------------------------------------------------------------------
// Opening cash
// ---------------------------------------------------------------------------------------------

interface OpeningResolution {
  readonly value: Decimal | null;
  readonly basis: MetricBasis;
  readonly assurance: AssuranceLevel;
  readonly perAccount: ReadonlyArray<{ account_id: string; source: string; value: string | null }>;
  readonly missingAccounts: readonly string[];
}

const OPENING_SOURCE_BASIS: Readonly<Record<OpeningCashSource, MetricBasis>> = {
  statement_opening_balance: 'bank',
  bank_account_opening_balance: 'bank',
  balance_sheet_prior_period: 'period_balances',
  opening_balance_journal: 'ledger',
};

/**
 * §2.3 rates the cash family `verified` on bank data. Only the statement's own opening balance is
 * bank data; a figure somebody typed, a prior balance sheet or an opening journal are all a step
 * removed, so they degrade the balance to `calculated`.
 */
const OPENING_SOURCE_ASSURANCE: Readonly<Record<OpeningCashSource, AssuranceLevel>> = {
  statement_opening_balance: 'verified',
  bank_account_opening_balance: 'calculated',
  balance_sheet_prior_period: 'calculated',
  opening_balance_journal: 'calculated',
};

/**
 * The CD-06 / ADR-027.3 chain, per account, in the order the document states it.
 *
 * A candidate stated later than the period start is not eligible: `bank_accounts.opening_balance` is
 * an opening balance only for a period starting on or after its `opening_balance_date`.
 */
function pickCandidate(
  candidates: readonly OpeningCashCandidate[],
  bankAccountId: string,
  periodStart: string,
): OpeningCashCandidate | null {
  const eligible = candidates.filter(
    (candidate) =>
      candidate.bankAccountId === bankAccountId &&
      (candidate.asAtDate === null || candidate.asAtDate <= periodStart),
  );
  for (const source of OPENING_CASH_SOURCES) {
    // Two candidates of the same source for the same account is a loader bug; sorting makes the
    // choice deterministic rather than dependent on which row the database returned first.
    const hits = [...eligible]
      .filter((candidate) => candidate.source === source)
      .sort((a, b) => a.value.localeCompare(b.value));
    const first = hits[0];
    if (first !== undefined) return first;
  }
  return null;
}

/**
 * Σ opening balance over the named accounts.
 *
 * If any of them has no stated opening balance the sum is NOT partially reported: an incomplete sum
 * of balances is a wrong balance, and §1.5 forbids filling the gap with zero. The accounts that are
 * missing are named in `components`, so "enter your opening balance" can name them.
 */
function openingFor(
  bankAccountIds: readonly string[],
  candidates: readonly OpeningCashCandidate[],
  periodStart: string,
): OpeningResolution {
  const perAccount: Array<{ account_id: string; source: string; value: string | null }> = [];
  const missingAccounts: string[] = [];
  const bases: MetricBasis[] = [];
  let assurance: AssuranceLevel = 'verified';
  let total = new Decimal(0);

  for (const bankAccountId of [...bankAccountIds].sort()) {
    const candidate = pickCandidate(candidates, bankAccountId, periodStart);
    if (candidate === null) {
      missingAccounts.push(bankAccountId);
      perAccount.push({ account_id: bankAccountId, source: 'none', value: null });
      continue;
    }
    total = total.plus(parseDecimal(candidate.value, 'opening_balance'));
    bases.push(OPENING_SOURCE_BASIS[candidate.source]);
    assurance = weakerAssurance(assurance, OPENING_SOURCE_ASSURANCE[candidate.source]);
    perAccount.push({
      account_id: bankAccountId,
      source: candidate.source,
      value: toMoneyString(candidate.value),
    });
  }

  return {
    value: missingAccounts.length > 0 ? null : total,
    basis: combineBasis(bases),
    assurance,
    perAccount,
    missingAccounts,
  };
}

// ---------------------------------------------------------------------------------------------
// The series
// ---------------------------------------------------------------------------------------------

interface PeriodState {
  readonly period: PeriodRef;
  readonly netMovement: Decimal;
  readonly closing: Decimal | null;
  readonly closingBasis: MetricBasis;
  readonly closingAssurance: AssuranceLevel;
  readonly closingMissing: readonly DataQualityMissing[];
  readonly completeness: number;
  readonly warnings: readonly DataQualityWarning[];
}

/**
 * Compute the six cash metrics for every input period.
 *
 * The whole series is computed at once because three of the six are cross-period: `opening_cash(P)`
 * is `closing_cash(P−1)`, a missing opening balance has to poison every later closing balance, and
 * runway needs three consecutive months of movement. Computing a period at a time would either
 * re-derive that chain or, worse, silently restart it at zero.
 *
 * Inputs may arrive in any order; they are sorted by `period_start` before anything is computed.
 */
export function computeCash(
  ctx: EngineContext,
  inputs: readonly CashPeriodInput[],
  options: CashSeriesOptions = {},
): readonly PeriodMetrics[] {
  const ordered = [...inputs].sort(
    (a, b) =>
      a.period.periodStart.localeCompare(b.period.periodStart) || a.period.id.localeCompare(b.period.id),
  );

  const accountTypeById = new Map<string, BankAccountType>(
    ctx.bankAccounts.map((account) => [account.id, account.accountType]),
  );
  const activeCashLikeIds = ctx.bankAccounts
    .filter((account) => account.isActive && isCashLike(account.accountType))
    .map((account) => account.id)
    .sort();

  const carry = options.openingCarry ?? null;
  const everCovered = new Set<string>(carry?.coveredBankAccountIds ?? []);
  const currency = ctx.settings.baseCurrency;

  const perPeriod: Array<{ state: PeriodState; metrics: MetricResult[] }> = [];

  let previousClosing: Decimal | null = carry === null || carry.value === null
    ? null
    : parseDecimal(carry.value);
  let previousBasis: MetricBasis = carry?.basis ?? 'none';
  let previousAssurance: AssuranceLevel = carry?.assurance ?? 'verified';
  let previousMissing: readonly DataQualityMissing[] = carry?.missing ?? [];
  let isFirstPeriod = carry === null;

  for (const input of ordered) {
    const { period } = input;
    const coveredCashLike = [...input.coveredBankAccountIds]
      .filter((id) => {
        const type = accountTypeById.get(id);
        return type !== undefined && isCashLike(type);
      })
      .sort();

    // §2.2: bank coverage is per ACTIVE cash-like account. With none active there is nothing to
    // cover, so the ratio is 1 rather than 0/0.
    const coveredActive = activeCashLikeIds.filter((id) => coveredCashLike.includes(id));
    const coverageRatio =
      activeCashLikeIds.length === 0 ? 1 : coveredActive.length / activeCashLikeIds.length;

    const warnings: DataQualityWarning[] = [...input.basis.warnings];
    if (coverageRatio < 1) warnings.push('bank_coverage_partial');
    if (input.unreconciledStatement === true) warnings.push('unreconciled_statement');

    const totals = totalMovements(input.movements, accountTypeById);
    if (totals.unpairedCandidates > 0) warnings.push('unpaired_transfer_candidate');
    const netMovement = totals.inflows.minus(totals.outflows);

    // ---- opening cash -----------------------------------------------------------------------
    // The first period states the balance of every account it covers; afterwards the prior closing
    // carries them, and only an account covered for the FIRST time brings a new balance with it
    // (§3.3, "New account mid-history"). Where the first period covers nothing but the organization
    // does have active cash-like accounts, their own opening balances are the only thing that can
    // state the position — and if they have none, the position is unknown rather than zero.
    const firstPeriodAccounts = coveredCashLike.length > 0 ? coveredCashLike : activeCashLikeIds;
    const joiners = coveredCashLike.filter((id) => !everCovered.has(id));
    const opening = isFirstPeriod
      ? openingFor(firstPeriodAccounts, input.openingCandidates, period.periodStart)
      : openingFor(joiners, input.openingCandidates, period.periodStart);
    for (const id of isFirstPeriod ? firstPeriodAccounts : coveredCashLike) everCovered.add(id);

    const carried = isFirstPeriod ? new Decimal(0) : previousClosing;
    const openingValue = carried === null || opening.value === null ? null : carried.plus(opening.value);

    const openingMissing: DataQualityMissing[] = [];
    if (opening.value === null) openingMissing.push('no_opening_cash');
    if (carried === null) openingMissing.push(...previousMissing);
    if (openingValue === null && openingMissing.length === 0) openingMissing.push('no_opening_cash');

    const openingBasis = isFirstPeriod
      ? opening.basis
      : combineBasis(opening.perAccount.length === 0 ? [previousBasis] : [previousBasis, opening.basis]);
    const openingAssurance = isFirstPeriod
      ? opening.assurance
      : opening.perAccount.length === 0
        ? previousAssurance
        : weakerAssurance(previousAssurance, opening.assurance);

    // ---- closing cash -----------------------------------------------------------------------
    const closingValue = openingValue === null ? null : openingValue.plus(netMovement);
    const closingMissing = openingValue === null ? dedupeCodes(openingMissing) : [];
    const closingBasis =
      openingValue === null ? openingBasis : combineBasis([openingBasis, input.basis.basis]);
    const closingAssurance = weakerAssurance(openingAssurance, input.basis.assurance);

    // Cross-check against the statement, when every covered account supplies a closing figure.
    const statementWarnings: DataQualityWarning[] = [];
    const statementComponents: Record<string, unknown> = {};
    const statementRows = input.statementClosing ?? [];
    const statementComplete =
      coveredCashLike.length > 0 &&
      coveredCashLike.every((id) => statementRows.some((row) => row.bankAccountId === id));
    if (statementComplete && closingValue !== null) {
      const stated = sum(
        [...statementRows]
          .filter((row) => coveredCashLike.includes(row.bankAccountId))
          .sort((a, b) => a.bankAccountId.localeCompare(b.bankAccountId))
          .map((row) => row.balanceAfter),
      );
      const delta = subtract(stated, closingValue);
      statementComponents.statement_closing_cash = toMoneyString(stated);
      statementComponents.statement_delta = toMoneyString(delta);
      // The computed value is still what is stored: the statement figure is a cross-check, and a
      // mismatch is a data-quality fact to show, not a licence to overwrite the arithmetic (§3.3).
      if (abs(delta).greaterThan(ONE_PENNY)) statementWarnings.push('statement_balance_mismatch');
    }

    // §5: the cash family's completeness is the coverage ratio, halved while opening cash is unknown.
    const completeness = coverageRatio * (openingValue === null ? 0.5 : 1);
    const movementQuality = metricQuality(completeness, warnings, [], input.basis.proxy);

    const inflows: MetricResult = {
      key: 'cash_inflows',
      value: toMoneyString(totals.inflows),
      unit: 'money',
      basis: input.basis.basis,
      assurance: input.basis.assurance,
      dimensionType: 'none',
      dimensionId: null,
      currency,
      components: {
        by_category: totals.byCategory,
        excluded_cash_transfer_legs: totals.excludedTransferLegs,
        unpaired_transfer_candidates: totals.unpairedCandidates,
        unresolved_bank_account_cells: totals.unresolvedAccounts,
        covered_bank_account_ids: coveredCashLike,
        bank_coverage_ratio: coverageRatio,
      },
      dataQuality: movementQuality,
      evidenceQuery: leafEvidence(ctx, 'bank_transactions', {
        period_ids: [period.id],
        bank_account_ids: activeCashLikeIds,
        direction: 'inflow',
        exclude_cash_transfers: true,
      }),
    };

    const outflows: MetricResult = {
      ...inflows,
      key: 'cash_outflows',
      value: toMoneyString(totals.outflows),
      evidenceQuery: leafEvidence(ctx, 'bank_transactions', {
        period_ids: [period.id],
        bank_account_ids: activeCashLikeIds,
        direction: 'outflow',
        exclude_cash_transfers: true,
      }),
    };

    const net: MetricResult = {
      key: 'net_cash_movement',
      value: toMoneyString(netMovement),
      unit: 'money',
      basis: input.basis.basis,
      assurance: input.basis.assurance,
      dimensionType: 'none',
      dimensionId: null,
      currency,
      components: {
        cash_inflows: toMoneyString(totals.inflows),
        cash_outflows: toMoneyString(totals.outflows),
      },
      dataQuality: movementQuality,
      evidenceQuery: derivedEvidence(['cash_inflows', 'cash_outflows']),
    };

    const openingResult: MetricResult = {
      key: 'opening_cash',
      value: openingValue === null ? null : toMoneyString(openingValue),
      unit: 'money',
      basis: openingBasis,
      assurance: openingAssurance,
      dimensionType: 'none',
      dimensionId: null,
      currency,
      components: {
        source: isFirstPeriod ? 'opening_balances' : 'previous_closing_cash',
        previous_closing_cash:
          isFirstPeriod || previousClosing === null ? null : toMoneyString(previousClosing),
        accounts: opening.perAccount,
        accounts_without_opening_balance: opening.missingAccounts,
        new_accounts_this_period: joiners,
      },
      dataQuality: metricQuality(
        completeness,
        warnings,
        openingValue === null ? dedupeCodes(openingMissing) : [],
        input.basis.proxy,
      ),
      evidenceQuery: isFirstPeriod ? null : derivedEvidence(['closing_cash']),
    };

    const closingResult: MetricResult = {
      key: 'closing_cash',
      value: closingValue === null ? null : toMoneyString(closingValue),
      unit: 'money',
      basis: closingBasis,
      assurance: closingAssurance,
      dimensionType: 'none',
      dimensionId: null,
      currency,
      components: {
        opening_cash: openingValue === null ? null : toMoneyString(openingValue),
        net_cash_movement: toMoneyString(netMovement),
        ...statementComponents,
      },
      dataQuality: metricQuality(
        completeness,
        [...warnings, ...statementWarnings],
        closingMissing,
        input.basis.proxy,
      ),
      evidenceQuery: derivedEvidence(['opening_cash', 'net_cash_movement']),
    };

    perPeriod.push({
      state: {
        period,
        netMovement,
        closing: closingValue,
        closingBasis,
        closingAssurance,
        closingMissing,
        completeness,
        warnings: [...warnings, ...statementWarnings],
      },
      metrics: [inflows, outflows, net, openingResult, closingResult],
    });

    previousClosing = closingValue;
    previousBasis = closingBasis;
    previousAssurance = closingAssurance;
    previousMissing = closingMissing;
    isFirstPeriod = false;
  }

  // Runway needs P, P−1 and P−2, so it is computed once the movement series exists.
  const states = perPeriod.map((entry) => entry.state);
  return perPeriod.map((entry, index) => ({
    periodId: entry.state.period.id,
    metrics: [...entry.metrics, runway(states, index, options.priorNetMovements ?? [])],
  }));
}

const ONE_PENNY = new Decimal('0.01');

/** §3.3: the runway figure the UI shows as "36+". Stored uncapped; the cap is a display rule. */
export const RUNWAY_DISPLAY_CAP = 36;

/**
 * `cash_runway_months` (§3.3).
 *
 * `avg_burn = −mean(net_cash_movement over P, P−1, P−2)`; runway is `closing_cash / avg_burn` only
 * while the business is burning. A profitable quarter makes the denominator zero or negative, and a
 * negative runway is not a longer runway but a meaningless one, so the value is NULL.
 */
function runway(
  states: readonly PeriodState[],
  index: number,
  priorNetMovements: readonly (string | null)[],
): MetricResult {
  const state = states[index];
  const window = movementWindow(states, index, priorNetMovements);
  const base = {
    key: 'cash_runway_months',
    unit: 'count',
    basis: state?.closingBasis ?? 'none',
    assurance: state?.closingAssurance ?? 'calculated',
    dimensionType: 'none',
    dimensionId: null,
    currency: null,
    evidenceQuery: derivedEvidence(['closing_cash', 'net_cash_movement']),
  } as const;
  const completeness = state?.completeness ?? 0;
  const warnings = state?.warnings ?? [];

  if (window === null) {
    return {
      ...base,
      value: null,
      components: {
        months_required: 3,
        months_available: countWindow(states, index, priorNetMovements),
      },
      dataQuality: metricQuality(completeness, warnings, ['insufficient_history']),
    };
  }

  const movements = window.map((value) => toMoneyString(value));
  const avgBurn = sum(window).dividedBy(3).negated();

  if (state === undefined || state.closing === null) {
    return {
      ...base,
      value: null,
      components: { avg_burn: toMoneyString(avgBurn), net_cash_movements: movements },
      dataQuality: metricQuality(
        completeness,
        warnings,
        state?.closingMissing.length ? state.closingMissing : ['no_opening_cash'],
      ),
    };
  }

  const components = {
    closing_cash: toMoneyString(state.closing),
    avg_burn: toMoneyString(avgBurn),
    net_cash_movements: movements,
  };

  // No cash left is a fact, not a gap: the runway is zero however slow the burn.
  if (!state.closing.greaterThan(0)) {
    return { ...base, value: toRatioString(0), components, dataQuality: metricQuality(completeness, warnings, []) };
  }

  if (!isPositive(avgBurn)) {
    return {
      ...base,
      value: null,
      components,
      // `cash_positive` says what happened; the NULL still needs a machine-readable reason, and the
      // reason is that the denominator is not a positive number (§1.5, §3.2 `comparison_is_zero`).
      dataQuality: metricQuality(completeness, [...warnings, 'cash_positive'], ['comparison_is_zero']),
    };
  }

  const months = divide(state.closing, avgBurn);
  return {
    ...base,
    value: months === null ? null : toRatioString(months),
    components: {
      ...components,
      display_cap: RUNWAY_DISPLAY_CAP,
      capped_for_display: months !== null && months.greaterThan(RUNWAY_DISPLAY_CAP),
    },
    dataQuality: metricQuality(completeness, warnings, months === null ? ['comparison_is_zero'] : []),
  };
}

/** The three consecutive months ending at `index`, or null when they are not all available. */
function movementWindow(
  states: readonly PeriodState[],
  index: number,
  priorNetMovements: readonly (string | null)[],
): readonly Decimal[] | null {
  const values: Decimal[] = [];
  for (let offset = 0; offset < 3; offset += 1) {
    const at = index - offset;
    if (at >= 0) {
      const state = states[at];
      if (state === undefined) return null;
      const next = states[at + 1];
      if (next !== undefined && !isPreviousMonth(state.period, next.period)) return null;
      values.push(state.netMovement);
      continue;
    }
    // Before the first input period: the caller's carry-in list, oldest first, so index −1 is its last.
    const carried = priorNetMovements[priorNetMovements.length + at];
    if (carried === undefined || carried === null) return null;
    values.push(parseDecimal(carried));
  }
  return values;
}

function countWindow(
  states: readonly PeriodState[],
  index: number,
  priorNetMovements: readonly (string | null)[],
): number {
  let available = 0;
  for (let offset = 0; offset < 3; offset += 1) {
    const at = index - offset;
    if (at >= 0) {
      if (states[at] !== undefined) available += 1;
    } else if (priorNetMovements[priorNetMovements.length + at] != null) {
      available += 1;
    }
  }
  return available;
}

/** Adjacency by calendar month; a gap in the series is not three consecutive months. */
function isPreviousMonth(earlier: PeriodRef, later: PeriodRef): boolean {
  return monthsBetween(yearMonthOf(earlier.periodStart), yearMonthOf(later.periodStart)) === 1;
}
