import { labelFor } from '@/modules/financials';
import type { ForecastBasis, InsufficiencyReason } from './config';

/**
 * The words a reader sees (UX_ARCHITECTURE.md §7; ADR-099).
 *
 * Separate from the engine because §15 is emphatic that no database terminology, metric key or
 * internal state reaches the page. Every string a reader could see is here, so a new state cannot
 * ship as a raw enum by accident.
 *
 * Pure.
 */

/** The six figures §15 names, in the order it names them. Their names come from `metricLabel`. */
export const FORECAST_HEADLINE_KEYS = [
  'revenue', 'operating_expenses', 'operating_profit', 'closing_cash', 'receivables', 'payables',
] as const;

/**
 * How much to lean on it (§19). Words, from conditions the server checked — never a percentage
 * MOTION made up to look precise.
 */
export const BASIS_TEXT: Readonly<Record<ForecastBasis, string>> = {
  strong: 'Strong basis — six or more finished, confirmed months to work from.',
  limited: 'Limited basis — either only a few complete months, or some of the figures behind them are estimates.',
  weak: 'Weak basis — there are very few finished, confirmed months to work from.',
};

export const BASIS_LABEL: Readonly<Record<ForecastBasis, string>> = {
  strong: 'Strong basis',
  limited: 'Limited basis',
  weak: 'Weak basis',
};

/** Why a metric has no forecast. Always a real condition, never "unknown" (§20). */
export const UNAVAILABLE_TEXT: Readonly<Record<InsufficiencyReason, string>> = {
  no_history: 'We have no figures for this yet.',
  too_few_periods: 'There are not enough finished months to work from yet.',
  history_not_continuous: 'There is a gap in the recent months, so we cannot read a run rate from them.',
  no_complete_periods: 'No month is finished yet, so there is nothing confirmed to work from yet.',
  metric_not_computable: 'We do not have the bank balance this would have to start from.',
};

export function unavailableText(reason: string): string {
  return UNAVAILABLE_TEXT[reason as InsufficiencyReason]
    ?? 'We cannot work this one out from the figures we have.';
}

/**
 * A figure's name, in the same words Home and Insights use (§8.1): a forecast of "Sales" must not be
 * called "Revenue" one page over. The vocabulary lives in `financials`, so the two cannot drift.
 */
export function metricLabel(metricKey: string): string {
  return labelFor(metricKey).plain;
}

/**
 * "Based on the last 6 finished months."
 *
 * The sentence §15 asks for. It states the count and nothing else: how the average was weighted is
 * behind "How was this worked out?", because a reader deciding whether to trust the number needs to
 * know how much history there is, not the shape of the arithmetic.
 */
export function basisSentence(periodsUsed: number): string {
  if (periodsUsed === 0) return 'There are no finished months to work from yet.';
  return periodsUsed === 1
    ? 'Based on the last finished month.'
    : `Based on the last ${periodsUsed} finished months.`;
}

/** The one line that must appear beside every forecast figure (REQ-FC-05). */
export const FORECAST_DISCLAIMER =
  'These are expectations worked out from your own finished months, not results. '
  + 'They are not a guarantee of what will happen.';
