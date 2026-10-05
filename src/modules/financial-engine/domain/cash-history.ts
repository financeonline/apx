/**
 * Per-account cash balance histories (FINANCIAL_ENGINE.md §3.3; ADR-124 D-1, D-2).
 *
 * Every cash-like bank account is solved on its own, day by day, and only then summed. The engine
 * used to carry ONE organisation-level closing figure from month to month and decide "carry or
 * restart" for every account together, judging a month covered only when a single statement spanned
 * it. The second independent audit of ADR-120 found every shape where one of those shortcuts is
 * wrong: a month only partly stated (N-1), a first month split across two statements (N-2), an
 * account joining later (N-3), statements that run from the 5th to the 4th (P-2). ADR-124 replaces
 * the shortcuts with one rule, stated here.
 *
 * **Coverage.** A day is covered for account A when one of A's committed statements declares a
 * range containing it. Statements combine: two that meet or overlap cover their union.
 *
 * **Anchors** are balances that something STATES, each at the close of a day D:
 *   - a statement's printed opening balance — the close of the day before its first day;
 *   - a statement's printed closing balance — the close of its last day;
 *   - the balance typed on the account (`opening_balance` at `opening_balance_date`) — the close of
 *     that day, which is what "balance at 31 May" means.
 * A statement superseded by a later-committed statement of the same account whose range contains
 * it states nothing (ADR-029.2; audit N-8).
 *
 * **The chain.** Within a run of consecutive covered days [s, e], the balance starts at the
 * EARLIEST anchor dated in [s − 1, e] and moves by the account's rows. Every later anchor in the run
 * is a cross-check: a disagreement is `statement_balance_mismatch`, and the computed value stands
 * (§3.3 — the figure is the arithmetic; a printed number that disagrees is a fact to show). Nothing
 * crosses an uncovered day, so an anchor can only open the run it is dated in; a typed balance from
 * months ago cannot open a run that starts later (audit N-2). Outside any run a balance is known
 * only on the exact day an anchor states it.
 *
 * **Scope (D-2).** An account exists from its start — the first day any source states something
 * about it: its first statement's first day, or the day after its typed balance. An active account
 * about which nothing is stated at all is in scope everywhere, and makes cash unknown, naming it —
 * it is never quietly left out of the total. A closed (inactive) account exists up to its last
 * statement's last day; one that was never stated is out of scope entirely.
 *
 * **Per period.** For P and an in-scope account, the days it must cover are P ∩ [start, end]. Its
 * movement is KNOWN when every one of them is covered; its opening is the balance at the close of
 * the day before the first of them; its closing is opening + those days' rows, known only when both
 * are. An unknown closing never carries: the next period's opening comes from the chain or from an
 * anchor dated exactly at its boundary, never from a guess.
 *
 * Pure: no I/O, no clock, no order dependence.
 */

import { Decimal, parseDecimal, toMoneyString } from '@/core/money';

import type { AssuranceLevel, BankAccountRef, PeriodRef } from './types';

/** Cash-like account types (§4.4): the only accounts whose balance is cash. */
const CASH_LIKE = new Set<BankAccountRef['accountType']>(['current', 'savings']);

export function isCashLikeAccount(account: Pick<BankAccountRef, 'accountType'>): boolean {
  return CASH_LIKE.has(account.accountType);
}

/** A committed bank statement batch, as the history needs it. */
export interface StatementRef {
  readonly batchId: string;
  readonly bankAccountId: string;
  /** The declared range (ADR-047.6), inclusive. */
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly committedAt: string;
  /** Printed balances — parsed or reviewer-typed only, never an AI reading (migration 20260905000032). */
  readonly openingBalance: string | null;
  readonly closingBalance: string | null;
  /** The rows did not add up to the printed balances at import (IMP-BAL-006/007). */
  readonly unreconciled: boolean;
  /**
   * The assurance commit stamped on every row of this statement (`statementRecordAssurance`). Absent
   * means `verified` — a CSV or Excel statement, which is what every caller before ADR-130 loaded.
   */
  readonly assurance?: AssuranceLevel;
}

/**
 * The assurance `app.commit_import_batch` writes on each row of a statement batch (ADR-033; migration
 * 20260908000006, the `v_assurance` CASE): rows an AI read are `inferred`; rows the deterministic PDF
 * reader produced are `verified` only when they reconcile to the printed balances, else `calculated`;
 * a CSV or Excel statement is `verified`. One value per batch, so the batch states the records' level.
 */
export function statementRecordAssurance(extractionMethod: string | null, unreconciled: boolean): AssuranceLevel {
  if (extractionMethod === 'pdf_claude') return 'inferred';
  if (extractionMethod === 'pdf_text') return unreconciled ? 'calculated' : 'verified';
  return 'verified';
}

const RECORD_STRENGTH: Readonly<Record<AssuranceLevel, number>> = {
  verified: 3, calculated: 2, estimated: 1, inferred: 0,
};

function weakerOf(a: AssuranceLevel, b: AssuranceLevel): AssuranceLevel {
  return RECORD_STRENGTH[b] < RECORD_STRENGTH[a] ? b : a;
}

/**
 * ADR-130: the weakest assurance of the bank rows that can feed P — those of every statement whose
 * declared range overlaps P. Bank figures used to be badged by their SOURCE alone, so a month read
 * from a PDF by AI showed its cash and its bank-proxy P&L as verified; only the evidence drawer,
 * which reads the rows, said "please check". Conservative across accounts: one AI-read statement in
 * the month marks the month's bank figures.
 */
export function bankRecordAssuranceFor(statements: readonly StatementRef[], period: PeriodRef): AssuranceLevel {
  let weakest: AssuranceLevel = 'verified';
  for (const statement of statements) {
    if (statement.periodStart > period.periodEnd || statement.periodEnd < period.periodStart) continue;
    const level = statement.assurance ?? 'verified';
    if (RECORD_STRENGTH[level] < RECORD_STRENGTH[weakest]) weakest = level;
  }
  return weakest;
}

/** The sum of one account's accepted, current rows on one day — every row, transfers included. */
export interface DailyMovement {
  readonly bankAccountId: string;
  readonly date: string;
  readonly amount: string;
}

export type AnchorSource =
  | 'statement_opening_balance'
  | 'statement_closing_balance'
  | 'bank_account_opening_balance';

/** Printed beats typed on the same day; the statement is `verified`, the typed figure `calculated`. */
const ANCHOR_RANK: Readonly<Record<AnchorSource, number>> = {
  statement_opening_balance: 0,
  statement_closing_balance: 1,
  bank_account_opening_balance: 2,
};
export const ANCHOR_ASSURANCE: Readonly<Record<AnchorSource, AssuranceLevel>> = {
  statement_opening_balance: 'verified',
  statement_closing_balance: 'verified',
  bank_account_opening_balance: 'calculated',
};

interface Anchor {
  /** The balance at the CLOSE of this day. */
  readonly date: string;
  readonly value: Decimal;
  readonly source: AnchorSource;
  readonly committedAt: string;
  readonly batchId: string | null;
  /**
   * How firm the stated balance is: the source's level, no firmer than the statement it is printed
   * on (Step 0D). A balance on an AI-read statement is a reviewer's typing or a copy of the model's
   * reading; it is `inferred` like the statement's rows.
   */
  readonly assurance: AssuranceLevel;
}

/** A known balance at the close of a day, and where it came from. */
export interface BalanceFact {
  readonly value: string;
  /** The anchor the chain started from. */
  readonly source: AnchorSource;
  /**
   * The balance is no firmer than what it rests on (Step 0D): the anchor that attests it and the
   * rows of every statement the chain crossed since. An AI-read month therefore marks every later
   * balance carried from it, until a verified printed balance that agrees with the chain attests it
   * again. Before, it was the anchor's SOURCE alone, so cash carried out of an AI-read month was
   * badged verified.
   */
  readonly assurance: AssuranceLevel;
  readonly anchorDate: string;
  /** The statements (batch ids) weaker than verified whose balance or rows this figure rests on. */
  readonly weakenedBy: readonly string[];
}

/** One account in one period. */
export interface AccountPeriodState {
  readonly bankAccountId: string;
  readonly name: string;
  /** The account exists during P under D-2 and counts towards P's cash. */
  readonly inScope: boolean;
  /** Every day of P the account must cover is covered by one of its statements. */
  readonly movementKnown: boolean;
  /** At least one day of P is covered. */
  readonly anyDayCovered: boolean;
  /** Balance at the close of the day before P's first required day; null when unknown. */
  readonly opening: BalanceFact | null;
  /** opening + the required days' rows; null unless both are known. */
  readonly closing: BalanceFact | null;
  /** The rows of the required days (all of them, transfers included). */
  readonly movement: string;
  /** The printed closing balance of a statement ending on P's last day, for §3.3's cross-check. */
  readonly statementClosing: string | null;
  /** An anchor dated inside P disagrees with the chain by more than a penny. */
  readonly balanceMismatch: boolean;
  /** A current (not superseded) statement overlapping P did not reconcile at import. */
  readonly unreconciled: boolean;
  /** Why the opening (or, with it, the closing) is unknown. */
  readonly openingMissing: boolean;
  /**
   * Something has stated this account's balance at some point (a printed or a typed balance). An
   * unknown opening is then a gap in coverage since — a statement missing — not an opening balance
   * nobody ever gave (`no_source_covers_period`, not `no_opening_cash`).
   */
  readonly everStated: boolean;
}

export interface CashHistoryInput {
  readonly bankAccounts: readonly BankAccountRef[];
  readonly statements: readonly StatementRef[];
  readonly movements: readonly DailyMovement[];
  readonly periods: readonly PeriodRef[];
}

/** period id → the state of every cash-like account in it (in scope or not), ordered by account id. */
export type CashHistory = ReadonlyMap<string, readonly AccountPeriodState[]>;

const ONE_PENNY = new Decimal('0.01');

// ---------------------------------------------------------------------------------------------
// Dates (ISO yyyy-mm-dd, UTC arithmetic; no clock)
// ---------------------------------------------------------------------------------------------

export function addDays(date: string, days: number): string {
  const t = Date.parse(`${date}T00:00:00Z`) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

const maxDate = (a: string, b: string): string => (a > b ? a : b);
const minDate = (a: string, b: string): string => (a < b ? a : b);

// ---------------------------------------------------------------------------------------------
// Coverage and scope — shared with `coverage.ts`, so the bank test and the history agree
// ---------------------------------------------------------------------------------------------

/** Merge inclusive date ranges into maximal runs of consecutive covered days. */
export function coveredRuns(
  ranges: ReadonlyArray<{ readonly periodStart: string; readonly periodEnd: string }>,
): ReadonlyArray<{ readonly start: string; readonly end: string }> {
  const sorted = [...ranges]
    .map((r) => ({ start: r.periodStart, end: r.periodEnd }))
    .sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));
  const runs: Array<{ start: string; end: string }> = [];
  for (const range of sorted) {
    const last = runs[runs.length - 1];
    if (last !== undefined && range.start <= addDays(last.end, 1)) {
      last.end = maxDate(last.end, range.end);
    } else {
      runs.push({ ...range });
    }
  }
  return runs;
}

/** Every day of [from, to] lies inside one run. */
export function runsCover(
  runs: ReadonlyArray<{ readonly start: string; readonly end: string }>,
  from: string,
  to: string,
): boolean {
  return runs.some((run) => run.start <= from && run.end >= to);
}

/**
 * When the account exists, under D-2. `start` null = an active account nothing states: it is in
 * scope everywhere (and unknown everywhere). `excluded` = a closed account nothing states.
 */
export interface AccountScope {
  readonly start: string | null;
  readonly end: string | null;
  readonly excluded: boolean;
}

export function accountScope(
  account: BankAccountRef,
  statements: ReadonlyArray<{ readonly bankAccountId: string; readonly periodStart: string; readonly periodEnd: string }>,
): AccountScope {
  const own = statements.filter((s) => s.bankAccountId === account.id);
  const starts = own.map((s) => s.periodStart);
  if (account.openingBalance !== null && account.openingBalanceDate !== null) {
    starts.push(addDays(account.openingBalanceDate, 1));
  }
  const start = starts.length === 0 ? null : starts.sort()[0]!;
  if (account.isActive) return { start, end: null, excluded: false };
  // Closed: it counts for the days its statements cover and no further. Never stated → out.
  const end = own.map((s) => s.periodEnd).sort().at(-1) ?? null;
  return { start, end, excluded: end === null };
}

/** The days of P the account must cover, or null when it is out of scope for P. */
export function requiredDays(
  scope: AccountScope,
  period: Pick<PeriodRef, 'periodStart' | 'periodEnd'>,
): { readonly from: string; readonly to: string } | null {
  if (scope.excluded) return null;
  const from = scope.start === null ? period.periodStart : maxDate(period.periodStart, scope.start);
  const to = scope.end === null ? period.periodEnd : minDate(period.periodEnd, scope.end);
  return from <= to ? { from, to } : null;
}

/**
 * The accounts that count for P's bank coverage (§2.2), and those of them whose statements cover
 * every day they must. Shared by `computeCoverage` so `is_complete` and the cash figures agree.
 */
export function bankCoverageFor(
  bankAccounts: readonly BankAccountRef[],
  statements: ReadonlyArray<{ readonly bankAccountId: string; readonly periodStart: string; readonly periodEnd: string }>,
  period: Pick<PeriodRef, 'periodStart' | 'periodEnd'>,
): { readonly inScope: readonly string[]; readonly covered: readonly string[] } {
  const inScope: string[] = [];
  const covered: string[] = [];
  for (const account of [...bankAccounts].filter(isCashLikeAccount).sort((a, b) => a.id.localeCompare(b.id))) {
    const own = statements.filter((s) => s.bankAccountId === account.id);
    const days = requiredDays(accountScope(account, own), period);
    if (days === null) continue;
    inScope.push(account.id);
    if (runsCover(coveredRuns(own), days.from, days.to)) covered.push(account.id);
  }
  return { inScope, covered };
}

// ---------------------------------------------------------------------------------------------
// The history
// ---------------------------------------------------------------------------------------------

/** A statement another later-committed statement of the same account contains states nothing. */
export function currentStatements(statements: readonly StatementRef[]): readonly StatementRef[] {
  return statements.filter((s) => !statements.some((t) => t !== s
    && t.bankAccountId === s.bankAccountId
    && t.periodStart <= s.periodStart && t.periodEnd >= s.periodEnd
    && (t.committedAt > s.committedAt || (t.committedAt === s.committedAt && t.batchId > s.batchId))));
}

function anchorsOf(account: BankAccountRef, statements: readonly StatementRef[]): Anchor[] {
  const anchors: Anchor[] = [];
  for (const st of statements) {
    const printed = (source: AnchorSource) => weakerOf(ANCHOR_ASSURANCE[source], st.assurance ?? 'verified');
    if (st.openingBalance !== null) {
      anchors.push({ date: addDays(st.periodStart, -1), value: parseDecimal(st.openingBalance, 'statement_opening_balance'),
        source: 'statement_opening_balance', committedAt: st.committedAt, batchId: st.batchId,
        assurance: printed('statement_opening_balance') });
    }
    if (st.closingBalance !== null) {
      anchors.push({ date: st.periodEnd, value: parseDecimal(st.closingBalance, 'statement_closing_balance'),
        source: 'statement_closing_balance', committedAt: st.committedAt, batchId: st.batchId,
        assurance: printed('statement_closing_balance') });
    }
  }
  if (account.openingBalance !== null && account.openingBalanceDate !== null) {
    anchors.push({ date: account.openingBalanceDate, value: parseDecimal(account.openingBalance, 'opening_balance'),
      source: 'bank_account_opening_balance', committedAt: '', batchId: null,
      assurance: ANCHOR_ASSURANCE.bank_account_opening_balance });
  }
  // Earliest first; on one day printed before typed, then the latest committed (a re-upload wins).
  return anchors.sort((a, b) => a.date.localeCompare(b.date)
    || ANCHOR_RANK[a.source] - ANCHOR_RANK[b.source]
    || b.committedAt.localeCompare(a.committedAt)
    || (b.batchId ?? '').localeCompare(a.batchId ?? ''));
}

/** Prefix sums of one account's rows, for Σ rows over (a, b]. */
class Ledger {
  private readonly dates: string[];
  private readonly cumulative: Decimal[];

  constructor(movements: readonly DailyMovement[]) {
    const byDate = new Map<string, Decimal>();
    for (const m of movements) {
      byDate.set(m.date, (byDate.get(m.date) ?? new Decimal(0)).plus(parseDecimal(m.amount, 'bank_movement')));
    }
    this.dates = [...byDate.keys()].sort();
    this.cumulative = [];
    let running = new Decimal(0);
    for (const date of this.dates) {
      running = running.plus(byDate.get(date)!);
      this.cumulative.push(running);
    }
  }

  /** Σ rows dated on or before `date`. */
  private upTo(date: string): Decimal {
    let lo = 0;
    let hi = this.dates.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.dates[mid]! <= date) lo = mid + 1; else hi = mid;
    }
    return lo === 0 ? new Decimal(0) : this.cumulative[lo - 1]!;
  }

  /** Σ rows dated after `from` and on or before `to`. */
  between(from: string, to: string): Decimal {
    return to <= from ? new Decimal(0) : this.upTo(to).minus(this.upTo(from));
  }
}

interface Chain {
  readonly from: string;
  readonly to: string;
  readonly anchor: Anchor;
}

/** The chains of one account: one per covered run that has an anchor, from its earliest anchor. */
function chainsOf(runs: ReadonlyArray<{ start: string; end: string }>, anchors: readonly Anchor[]): Chain[] {
  const chains: Chain[] = [];
  for (const run of runs) {
    const first = anchors.find((a) => a.date >= addDays(run.start, -1) && a.date <= run.end);
    if (first !== undefined) chains.push({ from: first.date, to: run.end, anchor: first });
  }
  return chains;
}

/**
 * The rows the chain adds between the close of `after` and the close of `upTo` come from the
 * statements covering those days. Every statement of the account counts, superseded or not: a
 * containing re-upload whose rows were skipped as duplicates leaves the earlier statement's rows in
 * place, and only a rollback (or a Replace, which rolls back) removes them.
 */
function rowsAssurance(
  statements: readonly StatementRef[], after: string, upTo: string,
): { readonly level: AssuranceLevel; readonly batches: readonly string[] } {
  let level: AssuranceLevel = 'verified';
  const batches: string[] = [];
  if (upTo <= after) return { level, batches };
  for (const st of statements) {
    if (st.periodEnd <= after || st.periodStart > upTo) continue;
    const own = st.assurance ?? 'verified';
    if (own === 'verified') continue;
    level = weakerOf(level, own);
    batches.push(st.batchId);
  }
  return { level, batches };
}

/**
 * How firm the chain's balance at the close of `date` is (Step 0D). Every anchor of the chain dated
 * on or before `date` that AGREES with the chain (to the penny) attests the value from its day on;
 * the balance is as firm as the best of them, each no firmer than the rows crossed since it. An
 * anchor that disagrees attests nothing (§3.3: the computed value stands, and the mismatch is shown).
 */
function chainAssurance(
  date: string, chain: Chain, anchors: readonly Anchor[], ledger: Ledger, statements: readonly StatementRef[],
): { readonly assurance: AssuranceLevel; readonly weakenedBy: readonly string[] } {
  let best: { assurance: AssuranceLevel; weakenedBy: readonly string[] } | null = null;
  for (const anchor of anchors) {
    if (anchor.date < chain.from || anchor.date > date) continue;
    if (anchor !== chain.anchor) {
      const computed = chain.anchor.value.plus(ledger.between(chain.from, anchor.date));
      if (computed.minus(anchor.value).abs().greaterThan(ONE_PENNY)) continue;
    }
    const rows = rowsAssurance(statements, anchor.date, date);
    const assurance = weakerOf(anchor.assurance, rows.level);
    const weakenedBy = [
      ...(anchor.assurance !== 'verified' && anchor.batchId !== null ? [anchor.batchId] : []),
      ...rows.batches,
    ];
    if (best === null || RECORD_STRENGTH[assurance] >= RECORD_STRENGTH[best.assurance]) {
      best = { assurance, weakenedBy: [...new Set(weakenedBy)].sort() };
    }
  }
  return best ?? { assurance: chain.anchor.assurance, weakenedBy: [] };
}

function balanceAt(
  date: string, chains: readonly Chain[], anchors: readonly Anchor[], ledger: Ledger, statements: readonly StatementRef[],
): BalanceFact | null {
  const chain = chains.find((c) => c.from <= date && c.to >= date);
  if (chain !== undefined) {
    return {
      value: toMoneyString(chain.anchor.value.plus(ledger.between(chain.from, date))),
      source: chain.anchor.source,
      ...chainAssurance(date, chain, anchors, ledger, statements),
      anchorDate: chain.anchor.date,
    };
  }
  const exact = anchors.find((a) => a.date === date);
  return exact === undefined ? null : {
    value: toMoneyString(exact.value),
    source: exact.source,
    assurance: exact.assurance,
    anchorDate: exact.date,
    weakenedBy: exact.assurance !== 'verified' && exact.batchId !== null ? [exact.batchId] : [],
  };
}

/**
 * The history of every cash-like account over every period. Deterministic in its inputs, whatever
 * order they arrive in.
 */
export function buildCashHistory(input: CashHistoryInput): CashHistory {
  const accounts = [...input.bankAccounts].filter(isCashLikeAccount).sort((a, b) => a.id.localeCompare(b.id));
  const periods = [...input.periods].sort((a, b) => a.periodStart.localeCompare(b.periodStart) || a.id.localeCompare(b.id));
  const out = new Map<string, AccountPeriodState[]>(periods.map((p) => [p.id, []]));

  for (const account of accounts) {
    const own = input.statements.filter((s) => s.bankAccountId === account.id);
    const current = currentStatements(own);
    const scope = accountScope(account, own);
    const runs = coveredRuns(own);
    const anchors = anchorsOf(account, current);
    const ledger = new Ledger(input.movements.filter((m) => m.bankAccountId === account.id));
    const chains = chainsOf(runs, anchors);

    for (const period of periods) {
      const days = requiredDays(scope, period);
      if (days === null) {
        out.get(period.id)!.push({
          bankAccountId: account.id, name: account.name, inScope: false, movementKnown: false, anyDayCovered: false,
          opening: null, closing: null, movement: '0.00', statementClosing: null, balanceMismatch: false,
          unreconciled: false, openingMissing: false, everStated: anchors.length > 0,
        });
        continue;
      }

      const movementKnown = runsCover(runs, days.from, days.to);
      const anyDayCovered = runs.some((r) => r.start <= days.to && r.end >= days.from);
      const movement = ledger.between(addDays(days.from, -1), days.to);
      const opening = balanceAt(addDays(days.from, -1), chains, anchors, ledger, own);
      // The closing is the opening plus the period's rows; it is as firm as the chain at the period's
      // last day — which counts this period's rows, and any printed balance that attests the end.
      const closingChain = chains.find((c) => c.from <= days.to && c.to >= days.to);
      const closing: BalanceFact | null = opening !== null && movementKnown
        ? {
            ...opening,
            value: toMoneyString(parseDecimal(opening.value).plus(movement)),
            ...(closingChain === undefined
              ? (() => {
                  const rows = rowsAssurance(own, addDays(days.from, -1), days.to);
                  return { assurance: weakerOf(opening.assurance, rows.level),
                    weakenedBy: [...new Set([...opening.weakenedBy, ...rows.batches])].sort() };
                })()
              : chainAssurance(days.to, closingChain, anchors, ledger, own)),
          }
        : null;

      // Every anchor dated inside P, other than a chain's own start, checks the chain it falls in.
      let balanceMismatch = false;
      for (const anchor of anchors) {
        if (anchor.date < period.periodStart || anchor.date > period.periodEnd) continue;
        const chain = chains.find((c) => c.from <= anchor.date && c.to >= anchor.date);
        if (chain === undefined || chain.anchor === anchor) continue;
        const computed = chain.anchor.value.plus(ledger.between(chain.from, anchor.date));
        if (computed.minus(anchor.value).abs().greaterThan(ONE_PENNY)) balanceMismatch = true;
      }

      const printedClose = anchors.find((a) => a.source === 'statement_closing_balance' && a.date === period.periodEnd);
      out.get(period.id)!.push({
        bankAccountId: account.id,
        name: account.name,
        inScope: true,
        movementKnown,
        anyDayCovered,
        opening,
        closing,
        movement: toMoneyString(movement),
        statementClosing: printedClose === undefined ? null : toMoneyString(printedClose.value),
        balanceMismatch,
        unreconciled: current.some((s) => s.unreconciled && s.periodStart <= period.periodEnd && s.periodEnd >= period.periodStart),
        openingMissing: opening === null,
        everStated: anchors.length > 0,
      });
    }
  }
  return out;
}
