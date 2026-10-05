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
import type { AccountPeriodState } from './cash-history';
import type {
  AggregateCell,
  AssuranceLevel,
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

export interface CashPeriodInput {
  readonly period: PeriodRef;
  readonly movements: readonly BankAggregateCell[];
  /**
   * Every cash-like account's state in this period — in scope or not — from the per-account history
   * (`cash-history.ts`, ADR-124). The balances, the coverage and the cross-checks all come from it;
   * this module only sums them and states what is missing.
   */
  readonly accounts: readonly AccountPeriodState[];
}

export interface CashSeriesOptions {
  /**
   * `net_cash_movement` of the periods immediately before the first input, oldest first; NULL for a
   * month whose movement was not stated. Runway needs three consecutive months, so a chunk boundary
   * would otherwise lose two of them.
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
  /**
   * Every in-scope cash-like account's statements cover every day of the period, so its net movement
   * was STATED. A month with an uncovered day shows only a fragment of what moved, and runway's burn
   * window must treat it as unknown rather than as a quiet month (ADR-120, ADR-124).
   */
  readonly movementKnown: boolean;
}

/** NULL is a real answer, not a zero; it is never `verified` and it is never complete (audit N-12). */
const UNKNOWN_ASSURANCE: AssuranceLevel = 'calculated';

/**
 * Compute the six cash metrics for every input period (§3.3, ADR-124).
 *
 * The balances are the per-account histories summed: `opening_cash(P)` is Σ each in-scope account's
 * balance at the close of the day before P, `closing_cash(P)` Σ each account's opening plus its rows
 * of P — published only when EVERY in-scope account's value is known, because a partial sum of
 * balances is a wrong balance, not an approximate one (§1.5). The movements are the bank cells of P
 * with ADR-028's transfer rule, published only when every in-scope account's statements cover every
 * day of P: a month stated for the 1st to the 15th has no stated movement, and 0.00 or the half that
 * was uploaded would both be inventions (audit N-1). Cash is bank data: a ledger or balance-sheet
 * basis never lends a month a figure computed from bank rows.
 *
 * Nothing here carries anything from one period to the next except runway's burn window. The
 * history already did the carrying, per account, from what the statements state.
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
  const anyActiveCashLike = ctx.bankAccounts.some((account) => account.isActive && isCashLike(account.accountType));
  const currency = ctx.settings.baseCurrency;

  const perPeriod: Array<{ state: PeriodState; metrics: MetricResult[] }> = [];

  for (const input of ordered) {
    const { period } = input;
    const inScope = [...input.accounts]
      .filter((a) => a.inScope)
      .sort((a, b) => a.bankAccountId.localeCompare(b.bankAccountId));
    const inScopeIds = inScope.map((a) => a.bankAccountId);
    const known = inScope.filter((a) => a.movementKnown);

    // §2.2: bank coverage is per in-scope cash-like account.
    const coverageRatio = inScope.length === 0 ? (anyActiveCashLike ? 0 : 1) : known.length / inScope.length;
    const movementKnown = inScope.length > 0 && known.length === inScope.length;

    const warnings: DataQualityWarning[] = [];
    if (inScope.length > 0 && !movementKnown && inScope.some((a) => a.anyDayCovered)) warnings.push('bank_coverage_partial');
    if (inScope.some((a) => a.unreconciled)) warnings.push('unreconciled_statement');

    /*
     * §1.5, §2.3, ADR-104: an organisation with no cash-like bank account has no source from which
     * cash can be established. A sum over zero accounts is not a known zero — it is nothing. Every
     * metric of the family is NULL with `no_bank_accounts`. An organisation whose accounts all start
     * after P (D-2) has accounts, just none yet: nothing covers P. An account IN scope about which
     * nothing is stated goes through the ordinary path below, so the reason names it.
     */
    if (inScope.length === 0) {
      const noAccounts = !anyActiveCashLike;
      const missing: DataQualityMissing[] = noAccounts ? ['no_bank_accounts'] : ['no_source_covers_period'];
      const quality = metricQuality(0, warnings, missing);
      const unavailable = (key: string): MetricResult => ({
        key, value: null, unit: 'money', basis: 'none', assurance: UNKNOWN_ASSURANCE,
        dimensionType: 'none', dimensionId: null, currency,
        components: { bank_accounts: inScope.length, covered_bank_account_ids: [] },
        dataQuality: quality, evidenceQuery: null,
      });
      perPeriod.push({
        state: {
          period, netMovement: new Decimal(0), closing: null, closingBasis: 'none',
          closingAssurance: UNKNOWN_ASSURANCE, closingMissing: missing, completeness: 0, warnings,
          movementKnown: false,
        },
        metrics: ['cash_inflows', 'cash_outflows', 'net_cash_movement', 'opening_cash', 'closing_cash'].map(unavailable),
      });
      continue;
    }

    const inScopeSet = new Set(inScopeIds);
    // Only in-scope accounts' rows count. A cell naming an account the run did not load stays in, so
    // `totalMovements` can count it into `unresolved_bank_account_cells` rather than lose it silently.
    const totals = totalMovements(
      input.movements.filter((cell) => inScopeSet.has(cell.bankAccountId) || !accountTypeById.has(cell.bankAccountId)),
      accountTypeById,
    );
    if (totals.unpairedCandidates > 0) warnings.push('unpaired_transfer_candidate');
    const netMovement = totals.inflows.minus(totals.outflows);

    // ---- movements ----------------------------------------------------------------------------
    const movementMissing: DataQualityMissing[] = movementKnown ? [] : ['no_source_covers_period'];
    const movementQuality = metricQuality(movementKnown ? 1 : 0, warnings, movementMissing);
    const movementBase = {
      unit: 'money',
      basis: movementKnown ? 'bank' : 'none',
      assurance: movementKnown ? 'verified' : UNKNOWN_ASSURANCE,
      dimensionType: 'none',
      dimensionId: null,
      currency,
      dataQuality: movementQuality,
    } as const;
    const accountsComponent = inScope.map((a) => ({ account_id: a.bankAccountId, movement_known: a.movementKnown }));

    const inflows: MetricResult = {
      ...movementBase,
      key: 'cash_inflows',
      value: movementKnown ? toMoneyString(totals.inflows) : null,
      components: {
        by_category: totals.byCategory,
        excluded_cash_transfer_legs: totals.excludedTransferLegs,
        unpaired_transfer_candidates: totals.unpairedCandidates,
        unresolved_bank_account_cells: totals.unresolvedAccounts,
        covered_bank_account_ids: known.map((a) => a.bankAccountId),
        bank_coverage_ratio: coverageRatio,
        accounts: accountsComponent,
      },
      evidenceQuery: movementKnown ? leafEvidence(ctx, 'bank_transactions', {
        period_ids: [period.id],
        bank_account_ids: inScopeIds,
        direction: 'inflow',
        exclude_cash_transfers: true,
      }) : null,
    };

    const outflows: MetricResult = {
      ...inflows,
      key: 'cash_outflows',
      value: movementKnown ? toMoneyString(totals.outflows) : null,
      evidenceQuery: movementKnown ? leafEvidence(ctx, 'bank_transactions', {
        period_ids: [period.id],
        bank_account_ids: inScopeIds,
        direction: 'outflow',
        exclude_cash_transfers: true,
      }) : null,
    };

    const net: MetricResult = {
      ...movementBase,
      key: 'net_cash_movement',
      value: movementKnown ? toMoneyString(netMovement) : null,
      components: movementKnown
        ? { cash_inflows: toMoneyString(totals.inflows), cash_outflows: toMoneyString(totals.outflows) }
        : { accounts: accountsComponent },
      evidenceQuery: movementKnown ? derivedEvidence(['cash_inflows', 'cash_outflows']) : null,
    };

    // ---- opening cash ---------------------------------------------------------------------------
    // Σ each in-scope account's balance at the close of the day before P. One unknown account makes
    // the sum unknown, and names that account: "add a statement or an opening balance for …" (D-2).
    const withoutOpening = inScope.filter((a) => a.opening === null);
    const openingKnown = withoutOpening.length === 0;
    const openingValue = openingKnown ? sum(inScope.map((a) => a.opening!.value)) : null;
    const openingAssurance = openingKnown
      ? inScope.reduce<AssuranceLevel>((acc, a) => weakerAssurance(acc, a.opening!.assurance), 'verified')
      : UNKNOWN_ASSURANCE;
    const missingAccounts = withoutOpening.map((a) => ({ account_id: a.bankAccountId, name: a.name }));
    // Why: an account nobody ever stated a balance for needs an opening balance; one that WAS stated
    // before and is unknown now has a stretch no statement covers since (a gap, or a month after its
    // last statement) — the same reason §2.3 gives a month nothing covers.
    const openingMissing: DataQualityMissing[] = [];
    if (withoutOpening.some((a) => !a.everStated)) openingMissing.push('no_opening_cash');
    if (withoutOpening.some((a) => a.everStated)) openingMissing.push('no_source_covers_period');
    const perAccount = inScope.map((a) => ({
      account_id: a.bankAccountId,
      source: a.opening?.source ?? 'none',
      as_at: a.opening?.anchorDate ?? null,
      value: a.opening?.value ?? null,
      // Step 0D: how firm this account's opening is, and the AI-read or unreconciled statements it
      // was carried through — the evidence for a "please check" on a month with no such statement.
      assurance: a.opening?.assurance ?? null,
      rests_on_statements: a.opening?.weakenedBy ?? [],
    }));
    const openingRestsOn = [...new Set(inScope.flatMap((a) => a.opening?.weakenedBy ?? []))].sort();

    const openingResult: MetricResult = {
      key: 'opening_cash',
      value: openingValue === null ? null : toMoneyString(openingValue),
      unit: 'money',
      basis: openingKnown ? 'bank' : 'none',
      assurance: openingAssurance,
      dimensionType: 'none',
      dimensionId: null,
      currency,
      components: {
        accounts: perAccount,
        accounts_without_opening_balance: missingAccounts.map((a) => a.account_id),
        missing_bank_accounts: missingAccounts,
        ...(openingRestsOn.length > 0 ? { rests_on_statements: openingRestsOn } : {}),
      },
      dataQuality: metricQuality(openingKnown ? 1 : 0, warnings, openingMissing),
      evidenceQuery: null,
    };

    // ---- closing cash ---------------------------------------------------------------------------
    const closingKnown = inScope.every((a) => a.closing !== null);
    const closingValue = closingKnown ? sum(inScope.map((a) => a.closing!.value)) : null;
    const closingMissing: DataQualityMissing[] = [...openingMissing];
    if (!movementKnown) closingMissing.push('no_source_covers_period');
    // Each account's closing is as firm as its chain at the period's end (Step 0D): the opening's
    // weakness carries unless a verified printed balance that agrees attests the end.
    const closingAssurance = closingKnown
      ? inScope.reduce<AssuranceLevel>((acc, a) => weakerAssurance(acc, a.closing!.assurance), 'verified')
      : UNKNOWN_ASSURANCE;
    const closingRestsOn = [...new Set(inScope.flatMap((a) => a.closing?.weakenedBy ?? []))].sort();

    // Cross-checks (§3.3): a printed balance inside P that disagrees with an account's chain, or the
    // printed closings of statements ending on P's last day that disagree with the computed sum. The
    // computed value is what is stored; a mismatch is a fact to show, not a licence to overwrite.
    const statementWarnings: DataQualityWarning[] = [];
    const statementComponents: Record<string, unknown> = {};
    if (inScope.some((a) => a.balanceMismatch)) statementWarnings.push('statement_balance_mismatch');
    if (closingValue !== null && inScope.every((a) => a.statementClosing !== null)) {
      const stated = sum(inScope.map((a) => a.statementClosing!));
      const delta = subtract(stated, closingValue);
      statementComponents.statement_closing_cash = toMoneyString(stated);
      statementComponents.statement_delta = toMoneyString(delta);
      if (abs(delta).greaterThan(ONE_PENNY)) statementWarnings.push('statement_balance_mismatch');
    }
    // A transfer between two of the organisation's own accounts moves both balances but no cash
    // (ADR-028). When its legs fall in different months the money is in transit: the balances say so,
    // and the gap between them and opening + net movement is shown rather than hidden.
    if (closingValue !== null && openingValue !== null && movementKnown) {
      const inTransit = closingValue.minus(openingValue.plus(netMovement));
      if (!inTransit.isZero()) statementComponents.cash_transfers_in_transit = toMoneyString(inTransit);
    }

    const closingResult: MetricResult = {
      key: 'closing_cash',
      value: closingValue === null ? null : toMoneyString(closingValue),
      unit: 'money',
      basis: closingKnown ? 'bank' : 'none',
      assurance: closingAssurance,
      dimensionType: 'none',
      dimensionId: null,
      currency,
      components: {
        opening_cash: openingValue === null ? null : toMoneyString(openingValue),
        net_cash_movement: movementKnown ? toMoneyString(netMovement) : null,
        // Read by the next run as the carry-free record of each account's balance (ADR-124).
        per_account: inScope.map((a) => ({
          account_id: a.bankAccountId, value: a.closing?.value ?? null,
          assurance: a.closing?.assurance ?? null, rests_on_statements: a.closing?.weakenedBy ?? [],
        })),
        missing_bank_accounts: missingAccounts,
        ...(closingRestsOn.length > 0 ? { rests_on_statements: closingRestsOn } : {}),
        ...statementComponents,
      },
      dataQuality: metricQuality(closingKnown ? 1 : 0, [...warnings, ...statementWarnings], closingKnown ? [] : closingMissing),
      evidenceQuery: derivedEvidence(['opening_cash', 'net_cash_movement']),
    };

    perPeriod.push({
      state: {
        period,
        netMovement,
        movementKnown,
        closing: closingValue,
        closingBasis: closingKnown ? 'bank' : 'none',
        closingAssurance,
        closingMissing: closingKnown ? [] : closingMissing,
        completeness: closingKnown ? 1 : 0,
        warnings: [...warnings, ...statementWarnings],
      },
      metrics: [inflows, outflows, net, openingResult, closingResult],
    });
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
      if (!state.movementKnown) return null;
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
      if (states[at]?.movementKnown === true) available += 1;
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
