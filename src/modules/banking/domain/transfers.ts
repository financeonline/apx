/**
 * Transfer detection (FINANCIAL_ENGINE.md §4.2; CD-28, ADR-028, ADR-047.12).
 *
 * Pure and order-independent. Every list is sorted explicitly before it is walked, because pairing
 * decides which movements disappear from the cash figures — and a pairing that depended on the order
 * rows came back from Postgres would make `closing_cash` change between two identical runs.
 *
 * The description gate is the point of this module. Amount, date and account alone are not evidence
 * of a transfer: a £4,800 customer receipt on the 10th and a £4,800 supplier payment on the 12th
 * satisfy all three, and pairing them would cancel both out of cash — the receipt and the payment
 * would each vanish, and nobody would ever see a line explaining where they went. So a candidate
 * that clears amount, date and account but fails the gate is NOT paired. It stays in the sums and is
 * flagged `unpaired_transfer_candidate` for a reviewer to confirm.
 */

import { abs, cashDirection, equals } from '@/core/money';
import type { StandardCategory } from '@/modules/financials';
import { CASH_NEUTRAL_TRANSFER_KINDS, transferKindFor, type BankAccountType, type TransferKind } from './types';

/** §4.2's window: legs of one transfer land at most three days apart. */
export const TRANSFER_MAX_DAYS_APART = 3;

/**
 * ADR-047.12's gate pattern, verbatim. Tested against `description_normalized` (already masked of
 * account numbers and sort codes, ADR-038.4).
 *
 * No `g` flag: a global regex keeps `lastIndex` between calls and would answer differently for the
 * same string on a second test.
 */
export const TRANSFER_DESCRIPTION_PATTERN =
  /transfer|tfr|to savings|from current|own account/;

/** Cash-like account types (§4.4, ADR-028). Only these feed `opening_cash`/`closing_cash`. */
export const CASH_LIKE_ACCOUNT_TYPES: readonly BankAccountType[] = ['current', 'savings'];

export function isCashLikeAccountType(accountType: BankAccountType): boolean {
  return CASH_LIKE_ACCOUNT_TYPES.includes(accountType);
}

// ---------------------------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------------------------

/**
 * Whole days between two ISO dates, ignoring sign.
 *
 * Parsed as UTC midnight so a daylight-saving boundary cannot turn a 3-day gap into 2.96 and round
 * the wrong way. Shared with §4.3's cadence arithmetic.
 */
export function daysBetween(a: string, b: string): number {
  const ms = Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`));
  return Math.round(ms / 86_400_000);
}

// ---------------------------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------------------------

/**
 * What pairing needs to know about a bank account. Structurally a subset of the engine's
 * `BankAccountRef` and of this module's `BankAccount`, so either can be passed straight in.
 */
export interface TransferBankAccount {
  readonly id: string;
  readonly name: string;
  readonly accountType: BankAccountType;
}

/** A subset of `BankTransaction`. The caller passes ACCEPTED rows of one organization only (§1.3). */
export interface TransferCandidateTransaction {
  readonly id: string;
  readonly bankAccountId: string;
  /** ISO `yyyy-mm-dd`. */
  readonly transactionDate: string;
  /** Signed: positive is an inflow. */
  readonly amount: string;
  readonly descriptionNormalized: string | null;
}

export interface TransferDetectionInput {
  readonly transactions: readonly TransferCandidateTransaction[];
  readonly bankAccounts: readonly TransferBankAccount[];
}

// ---------------------------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------------------------

export interface TransferPair {
  /** Deterministic id: the two transaction ids sorted and joined, so a re-run reproduces it. */
  readonly pairId: string;
  readonly outflowTransactionId: string;
  readonly inflowTransactionId: string;
  readonly outflowBankAccountId: string;
  readonly inflowBankAccountId: string;
  readonly transferKind: TransferKind;
  /** The system category account the §4.2 table assigns to both legs. */
  readonly categoryStandardCategory: StandardCategory;
  readonly daysApart: number;
  /** Why the gate passed, for the reviewer and for the test that this was never guessed. */
  readonly gateReason: 'description_pattern' | 'other_account_name';
}

/** Why a row is flagged `unpaired_transfer_candidate` (§4.2, ADR-047.12). */
export type UnpairedTransferReason =
  /** Amount, date and a different account all matched — only the description gate failed. */
  | 'description_gate_failed'
  /** The row reads like a transfer but nothing on any other account matches it. */
  | 'transfer_wording_unpaired';

export interface UnpairedTransferCandidate {
  readonly transactionId: string;
  readonly reason: UnpairedTransferReason;
  /** The row it would have been paired with, when the reason is a failed gate. */
  readonly counterpartTransactionId: string | null;
}

export interface TransferDetectionResult {
  readonly pairs: readonly TransferPair[];
  /**
   * Rows that stay in every figure, flagged for review. Nothing here is excluded from cash: a
   * candidate we could not confirm is a movement we could not explain, not a movement that did not
   * happen.
   */
  readonly unpairedCandidates: readonly UnpairedTransferCandidate[];
}

// ---------------------------------------------------------------------------------------------
// The §4.2 table, as data the cash module can use
// ---------------------------------------------------------------------------------------------

/**
 * `transfer_kind → category_account` (§4.2 table).
 *
 * `other_transfer` maps to `transfer` because the table's own row for it says "not cash, excluded
 * from P&L", which is exactly what the `transfer` holding category means; `credit_card` and `loan`
 * exist to keep a repayment visible as a repayment in the cash breakdown.
 */
export function transferCategoryFor(kind: TransferKind): StandardCategory | null {
  switch (kind) {
    case 'cash_transfer':
    case 'other_transfer':
      return 'transfer';
    case 'card_repayment':
      return 'credit_card';
    case 'loan_repayment':
    case 'loan_drawdown':
      return 'loan';
    case 'none':
      return null;
  }
}

/** One leg of a pair, as the cash-metric predicate needs it. */
export interface TransferLeg {
  readonly transferKind: TransferKind;
  readonly bankAccountType: BankAccountType;
}

/**
 * Does this leg still count in `cash_inflows` / `cash_outflows`? (§4.2 table, ADR-028.)
 *
 * The cash metrics themselves live in another engineer's file; this is the predicate they call, so
 * that the rule exists once. Two independent reasons a leg drops out:
 *
 *  1. It is not on a cash-like account at all — a credit-card or loan statement line is a balance
 *     movement, never a cash movement (§4.4).
 *  2. Its pair is cash-neutral. `CASH_NEUTRAL_TRANSFER_KINDS` holds exactly one kind,
 *     `cash_transfer`, deliberately (ADR-028): a card repayment or a loan drawdown really does move
 *     the company's money, and excluding it overstated closing cash by every repayment,
 *     cumulatively — the defect ADR-028 exists to fix.
 */
export function legCountsInCashMetrics(leg: TransferLeg): boolean {
  if (!isCashLikeAccountType(leg.bankAccountType)) return false;
  return !CASH_NEUTRAL_TRANSFER_KINDS.includes(leg.transferKind);
}

// ---------------------------------------------------------------------------------------------
// The description gate
// ---------------------------------------------------------------------------------------------

function normalisedText(description: string | null | undefined): string {
  return (description ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** An account name reduced for containment testing: "Barclays — Savings" contains "savings". */
function normalisedAccountName(name: string): string {
  return name.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

/** True when a leg's description names the OTHER account (ADR-047.12's second limb). */
function mentionsAccountName(description: string | null | undefined, accountName: string): boolean {
  const name = normalisedAccountName(accountName);
  if (name === '') return false;
  return normalisedText(description).includes(name);
}

/**
 * The gate: at least one leg says "transfer" in words, or names the other account.
 *
 * Returns the reason it passed, or `null`. A reason rather than a boolean because the reviewer
 * panel and the golden tests both need to see WHY two rows were allowed to cancel each other out.
 */
export function transferDescriptionGate(
  a: { readonly descriptionNormalized: string | null; readonly accountName: string },
  b: { readonly descriptionNormalized: string | null; readonly accountName: string },
): TransferPair['gateReason'] | null {
  if (
    TRANSFER_DESCRIPTION_PATTERN.test(normalisedText(a.descriptionNormalized)) ||
    TRANSFER_DESCRIPTION_PATTERN.test(normalisedText(b.descriptionNormalized))
  ) {
    return 'description_pattern';
  }
  if (
    mentionsAccountName(a.descriptionNormalized, b.accountName) ||
    mentionsAccountName(b.descriptionNormalized, a.accountName)
  ) {
    return 'other_account_name';
  }
  return null;
}

/** True when a lone row reads like a transfer (§4.2's second flagging rule). */
export function looksLikeTransfer(description: string | null | undefined): boolean {
  return TRANSFER_DESCRIPTION_PATTERN.test(normalisedText(description));
}

// ---------------------------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------------------------

function tokens(text: string): Set<string> {
  return new Set(text.split(' ').filter((t) => t.length > 0));
}

/**
 * Jaccard overlap of the two descriptions' word sets, 0–1.
 *
 * §4.2 says "prefer the closest date, then description similarity" without naming a measure. Token
 * Jaccard is chosen because it is symmetric (so the answer does not depend on which leg is asked
 * first) and integer-derived (so two candidates never tie by floating-point accident on inputs that
 * are genuinely different).
 */
export function descriptionSimilarity(a: string | null, b: string | null): number {
  const left = tokens(normalisedText(a));
  const right = tokens(normalisedText(b));
  if (left.size === 0 && right.size === 0) return 1;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ---------------------------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------------------------

function byDateThenId(
  a: TransferCandidateTransaction,
  b: TransferCandidateTransaction,
): number {
  if (a.transactionDate !== b.transactionDate) return a.transactionDate < b.transactionDate ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Pair transfers over one organization's accepted transactions (§4.2).
 *
 * The walk is greedy over outflows in (date, id) order, and each outflow takes the best inflow still
 * unpaired. Greedy is safe here because the window is three days and the amounts must match exactly,
 * so the candidate sets barely overlap; and it is the only formulation that is obviously stable —
 * an optimal global matching would have to break ties somewhere anyway, and would do it less
 * legibly.
 *
 * TIE-BREAK, in order, and every level is total:
 *   1. fewest days apart              (§4.2: "prefer the closest date")
 *   2. highest description similarity (§4.2: "then description similarity")
 *   3. earliest inflow date           (a stable third key, since 1 only compares distance)
 *   4. lowest inflow transaction id    (uuids are unique, so this can never tie)
 * Level 4 is what makes the result independent of input order: whatever sequence the rows arrive
 * in, the same inflow wins.
 */
export function detectTransfers(input: TransferDetectionInput): TransferDetectionResult {
  const accounts = new Map<string, TransferBankAccount>();
  for (const account of input.bankAccounts) accounts.set(account.id, account);

  const sorted = [...input.transactions].sort(byDateThenId);
  const outflows = sorted.filter((t) => cashDirection(t.amount) === 'outflow');
  const inflows = sorted.filter((t) => cashDirection(t.amount) === 'inflow');

  const paired = new Set<string>();
  const pairs: TransferPair[] = [];
  const gateFailures = new Map<string, string>();

  for (const outflow of outflows) {
    if (paired.has(outflow.id)) continue;
    const outflowAccount = accounts.get(outflow.bankAccountId);
    if (outflowAccount === undefined) continue;

    interface Candidate {
      readonly inflow: TransferCandidateTransaction;
      readonly account: TransferBankAccount;
      readonly daysApart: number;
      readonly similarity: number;
      readonly gateReason: TransferPair['gateReason'] | null;
    }

    const candidates: Candidate[] = [];
    for (const inflow of inflows) {
      if (paired.has(inflow.id)) continue;
      // A different `bank_accounts` ROW, not merely a different account type: two current accounts
      // at the same bank are two rows, and money genuinely moves between them.
      if (inflow.bankAccountId === outflow.bankAccountId) continue;
      const inflowAccount = accounts.get(inflow.bankAccountId);
      if (inflowAccount === undefined) continue;
      if (!equals(abs(inflow.amount), abs(outflow.amount))) continue;
      const gap = daysBetween(inflow.transactionDate, outflow.transactionDate);
      if (gap > TRANSFER_MAX_DAYS_APART) continue;

      candidates.push({
        inflow,
        account: inflowAccount,
        daysApart: gap,
        similarity: descriptionSimilarity(outflow.descriptionNormalized, inflow.descriptionNormalized),
        gateReason: transferDescriptionGate(
          { descriptionNormalized: outflow.descriptionNormalized, accountName: outflowAccount.name },
          { descriptionNormalized: inflow.descriptionNormalized, accountName: inflowAccount.name },
        ),
      });
    }

    if (candidates.length === 0) continue;

    candidates.sort((a, b) => {
      if (a.daysApart !== b.daysApart) return a.daysApart - b.daysApart;
      if (a.similarity !== b.similarity) return b.similarity - a.similarity;
      if (a.inflow.transactionDate !== b.inflow.transactionDate) {
        return a.inflow.transactionDate < b.inflow.transactionDate ? -1 : 1;
      }
      return a.inflow.id < b.inflow.id ? -1 : a.inflow.id > b.inflow.id ? 1 : 0;
    });

    const best = candidates.find((c) => c.gateReason !== null);
    if (best === undefined) {
      // Amount, date and account all matched and the gate refused. BOTH rows stay in every figure;
      // the flag asks a human, it does not remove anything (§4.2, ADR-047.12).
      const nearest = candidates[0]!;
      if (!gateFailures.has(outflow.id)) gateFailures.set(outflow.id, nearest.inflow.id);
      if (!gateFailures.has(nearest.inflow.id)) gateFailures.set(nearest.inflow.id, outflow.id);
      continue;
    }

    paired.add(outflow.id);
    paired.add(best.inflow.id);
    // The kind is DERIVED from the two account types by the shared helper, never asserted and never
    // re-derived here: `transferKindFor` has a SQL twin in `api.mark_transfer`, and a second copy of
    // the derivation would be a second thing to keep in step. Letting a caller assert
    // `cash_transfer` would let anyone make a real outflow vanish from the cash figures.
    const kind = transferKindFor(outflowAccount.accountType, best.account.accountType);
    const category = transferCategoryFor(kind);
    const ids = [outflow.id, best.inflow.id].sort();
    pairs.push({
      pairId: `${ids[0]}:${ids[1]}`,
      outflowTransactionId: outflow.id,
      inflowTransactionId: best.inflow.id,
      outflowBankAccountId: outflow.bankAccountId,
      inflowBankAccountId: best.inflow.bankAccountId,
      transferKind: kind,
      // `transferKindFor` never returns `none` for two real accounts, so the category is always set;
      // `transfer` is the safe fallback because it is the holding category, never a statement line.
      categoryStandardCategory: category ?? 'transfer',
      daysApart: best.daysApart,
      gateReason: best.gateReason!,
    });
  }

  // §4.2's second flagging rule: a row that reads like a transfer and found no partner at all.
  const unpaired: UnpairedTransferCandidate[] = [];
  for (const transaction of sorted) {
    if (paired.has(transaction.id)) continue;
    const counterpart = gateFailures.get(transaction.id);
    if (counterpart !== undefined) {
      unpaired.push({
        transactionId: transaction.id,
        reason: 'description_gate_failed',
        counterpartTransactionId: counterpart,
      });
      continue;
    }
    if (looksLikeTransfer(transaction.descriptionNormalized)) {
      unpaired.push({
        transactionId: transaction.id,
        reason: 'transfer_wording_unpaired',
        counterpartTransactionId: null,
      });
    }
  }

  pairs.sort((a, b) => (a.pairId < b.pairId ? -1 : a.pairId > b.pairId ? 1 : 0));
  unpaired.sort((a, b) => (a.transactionId < b.transactionId ? -1 : a.transactionId > b.transactionId ? 1 : 0));

  return { pairs, unpairedCandidates: unpaired };
}
