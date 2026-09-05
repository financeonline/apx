/**
 * The Home summary sentence (UX_ARCHITECTURE.md §Level 1; moved here from Phase 7 by ADR-039).
 *
 * "March was profitable, cash went up by £4,200, and two things need your attention."
 *
 * Deterministic templates, never the AI. This sentence is the first thing a business owner reads
 * about their own month, and it appears above the numbers rather than beside them — so it has to be
 * reproducible from the snapshots alone, defensible clause by clause, and incapable of asserting
 * anything the engine did not compute. A generated sentence would be a narrative claim on the most
 * prominent line of the product, which is exactly the boundary §1.1 draws.
 *
 * Every clause is omitted rather than guessed. A month with no profit figure says nothing about
 * profit; it does not say "broke even".
 *
 * Pure.
 */

import { Decimal, formatMoney } from '@/core/money';
import type { DimensionBreakdown, HealthScore } from './types';

/**
 * What the sentence needs of a score: the number and the breakdown.
 *
 * Structural rather than the whole `HealthScore`, so the Home service can pass the view it already
 * read back from storage instead of reassembling an engine output it does not have.
 */
export type ScoreSummaryInput = Pick<HealthScore, 'score'> & {
  readonly breakdown: readonly DimensionBreakdown[];
};

export interface SummaryInput {
  /** "March 2026" — from `core/periods`, never built here. */
  readonly periodLabel: string;
  readonly currency: string;
  /** NULL when the organisation has no profit-and-loss source at all (ADR-035). */
  readonly netProfit: string | null;
  readonly netCashMovement: string | null;
  readonly cashInflows: string | null;
  readonly cashOutflows: string | null;
  /** False when no ledger, trial balance or invoice source covers the period (ADR-035). */
  readonly hasPnlSource: boolean;
  readonly score: ScoreSummaryInput | null;
}

export type SummaryClauseId =
  | 'profitable' | 'made_loss' | 'broke_even'
  | 'bank_only_movement'
  | 'cash_up' | 'cash_down' | 'cash_flat'
  | 'attention_some' | 'attention_none'
  | 'bank_only_next_step';

export interface SummarySentence {
  readonly text: string;
  /** Which clauses fired, in order — what the determinism test asserts on (TEST_STRATEGY.md §7). */
  readonly clauses: readonly SummaryClauseId[];
  readonly values: Readonly<Record<string, string>>;
}

const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

/** Small counts read better as words in a sentence; larger ones as digits. */
function count(n: number): string {
  return n <= 10 ? WORDS[n]! : String(n);
}

/** The negative factors this run found, across every included dimension. */
export function attentionCount(score: ScoreSummaryInput | null): number {
  if (score === null) return 0;
  return score.breakdown
    .filter((d) => d.included)
    .reduce((total, d) => total + d.negatives.length, 0);
}

/**
 * Build the sentence.
 *
 * Clause selection is a function of the inputs alone — no ordering by chance, no random choice
 * between synonyms — so the same snapshots always produce the same sentence.
 */
export function summarySentence(input: SummaryInput): SummarySentence {
  const { currency, periodLabel } = input;
  const clauses: SummaryClauseId[] = [];
  const values: Record<string, string> = { period: periodLabel };
  const parts: string[] = [];

  const money = (value: string) => formatMoney(new Decimal(value), { currency });

  // 1. What the month did.
  if (!input.hasPnlSource) {
    /*
     * ADR-035: with bank data and no P&L source there is no profit to report, so the sentence says
     * what the bank shows. Saying "March broke even" from a bank statement would be an assertion the
     * engine cannot support.
     */
    if (input.cashInflows !== null && input.cashOutflows !== null) {
      values.inflows = input.cashInflows;
      values.outflows = input.cashOutflows;
      parts.push(
        `In ${periodLabel}, ${money(input.cashInflows)} came in and ${money(input.cashOutflows)} went out`,
      );
      clauses.push('bank_only_movement');
    }
  } else if (input.netProfit !== null) {
    const profit = new Decimal(input.netProfit);
    values.net_profit = input.netProfit;
    if (profit.greaterThan(0)) {
      parts.push(`${periodLabel} was profitable`);
      clauses.push('profitable');
    } else if (profit.lessThan(0)) {
      parts.push(`${periodLabel} made a loss of ${money(profit.abs().toString())}`);
      clauses.push('made_loss');
    } else {
      parts.push(`${periodLabel} broke even`);
      clauses.push('broke_even');
    }
  }

  // 2. What cash did.
  if (input.netCashMovement !== null) {
    const movement = new Decimal(input.netCashMovement);
    values.net_cash_movement = input.netCashMovement;
    if (movement.greaterThan(0)) {
      parts.push(`cash went up by ${money(movement.toString())}`);
      clauses.push('cash_up');
    } else if (movement.lessThan(0)) {
      parts.push(`cash fell by ${money(movement.abs().toString())}`);
      clauses.push('cash_down');
    } else {
      parts.push('cash was unchanged');
      clauses.push('cash_flat');
    }
  }

  // 3. What needs a look.
  const attention = attentionCount(input.score);
  values.attention = String(attention);
  if (attention > 0) {
    parts.push(`${count(attention)} thing${attention === 1 ? '' : 's'} need${attention === 1 ? 's' : ''} your attention`);
    clauses.push('attention_some');
  } else if (input.score !== null && input.score.score !== null) {
    parts.push('nothing needs your attention');
    clauses.push('attention_none');
  }

  if (parts.length === 0) {
    return { text: '', clauses: [], values };
  }

  let text = joinClauses(parts);

  // 4. The one upload that would unlock profit figures (ADR-035).
  if (!input.hasPnlSource) {
    text = `${text}. Add a ledger, trial balance or sales invoices to see profit figures`;
    clauses.push('bank_only_next_step');
  }

  return { text: `${text}.`, clauses, values };
}

/**
 * "a, b, and c".
 *
 * The serial comma is not a style preference here: §Level 1's worked example is "March was
 * profitable, cash went up by £4,200, and two things need your attention", and the copy in the spec
 * is the copy that ships.
 */
function joinClauses(parts: readonly string[]): string {
  if (parts.length === 1) return parts[0]!;
  if (parts.length === 2) return `${parts[0]!} and ${parts[1]!}`;
  const head = parts.slice(0, -1).join(', ');
  return `${head}, and ${parts[parts.length - 1]!}`;
}
