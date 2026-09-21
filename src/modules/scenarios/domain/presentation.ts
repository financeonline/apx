import type { Assumption } from './types';
import type { AssumptionKind, CashEffect, UnavailableReason } from './config';

/**
 * The words a reader sees (UX_ARCHITECTURE.md §7–§8, §15; ADR-100).
 *
 * Separate from the engine because §15 is emphatic that no database terminology, metric key or
 * internal state reaches the page. Every string a reader could see is here, so a new assumption
 * kind cannot ship as a raw enum by accident. UK English, second person, no jargon.
 *
 * Pure.
 */

/** The question each assumption answers, as the form asks it. */
export const ASSUMPTION_QUESTION: Readonly<Record<AssumptionKind, string>> = {
  revenue_change: 'What if sales change?',
  payroll_change: 'What if wages change?',
  supplier_cost_change: 'What if your suppliers change their prices?',
  marketing_change: 'What if you spend more, or less, on marketing?',
  hiring: 'What if you take someone on?',
  pricing_change: 'What if you change your prices?',
  debt_drawdown: 'What if you borrow money?',
  debt_repayment: 'What if you start repaying a loan?',
};

/** The short name the assumptions list uses. */
export const ASSUMPTION_LABEL: Readonly<Record<AssumptionKind, string>> = {
  revenue_change: 'Sales',
  payroll_change: 'Wages',
  supplier_cost_change: 'Direct costs',
  marketing_change: 'Marketing',
  hiring: 'New people',
  pricing_change: 'Prices',
  debt_drawdown: 'Borrowing',
  debt_repayment: 'Loan repayments',
};

/** One line of help under each question, saying what MOTION will and will not do with the answer. */
export const ASSUMPTION_NOTE: Readonly<Record<AssumptionKind, string>> = {
  revenue_change:
    'This changes your sales figure. It does not change what those sales cost you unless you say so below.',
  payroll_change: 'This changes your running costs.',
  supplier_cost_change: 'This changes the direct cost of what you sell, so it changes your profit after direct costs.',
  marketing_change:
    'This changes your running costs. It does not add any sales: MOTION has no figure that says what your marketing brings in, so it will not invent one.',
  hiring: 'Give the full monthly cost of each person, including everything you pay on top of their wage.',
  pricing_change:
    'A price change on its own is not a sales change. Say what you think happens to the number of sales — nothing is assumed.',
  debt_drawdown: 'The money arrives once, in the month you choose. It changes your cash, not your profit.',
  debt_repayment:
    'Repayments change your cash, not your operating profit. Interest sits below operating profit, so it is counted in cash only.',
};

export const CASH_EFFECT_LABEL: Readonly<Record<CashEffect, string>> = {
  same_month: 'Counts as cash in the same month',
  none: 'Does not change cash',
};

/** Why a scenario could not be worked out. Always a real condition, never "unknown" (§7). */
export const UNAVAILABLE_TEXT: Readonly<Record<UnavailableReason, string>> = {
  no_forecast:
    'There is no forecast to change yet. Work one out on the forecast page first, and this will be able to use it.',
  metric_not_forecast:
    'MOTION cannot forecast the figure this change would move, so it cannot say what the change would do to it.',
  no_category_baseline:
    'MOTION does not know what this has been running at, so it cannot work out a percentage of it. Give an amount instead.',
  no_direct_costs:
    'Your books have no direct costs, so there is nothing here for this change to move.',
  no_revenue_baseline:
    'Your forecast sales are zero, so MOTION cannot work out what share of them this amount is.',
};

export function unavailableText(reason: string): string {
  return UNAVAILABLE_TEXT[reason as UnavailableReason]
    ?? 'MOTION cannot work this one out from the figures it has.';
}

/** The headline sentence shown whenever a scenario is refused (§7). */
export const UNAVAILABLE_HEADLINE =
  'This cannot be worked out, because something it needs is missing.';

/**
 * The one line that must appear beside every scenario figure.
 *
 * §16: a scenario result is not an actual and not even a forecast — it is what MOTION expects IF
 * the assumptions hold. The three words are kept apart deliberately.
 */
export const SCENARIO_DISCLAIMER =
  'These are not results and not a forecast. They are what MOTION expects if the changes below '
  + 'turn out to be true, worked out from your own finished months.';

/**
 * One assumption in words, for the assumptions list and for anything that has to restate it.
 *
 * `formatAmount` is passed in rather than imported so this file stays free of a currency decision
 * it has no business making; the caller already knows the organisation's currency.
 */
export function assumptionSentence(
  assumption: Assumption,
  formatAmount: (value: string) => string,
): string {
  const from = assumption.startsInMonth === 1 ? '' : ` from month ${assumption.startsInMonth}`;
  const split = (value: string): { down: boolean; bare: string } => {
    const trimmed = value.trim();
    const down = trimmed.startsWith('-');
    return { down, bare: down ? trimmed.slice(1) : trimmed };
  };
  const signed = (value: string): string => {
    const { down, bare } = split(value);
    return `${down ? 'down' : 'up'} by ${bare}`;
  };
  const sizedText = (label: string, mode: string, value: string): string => {
    const { down, bare } = split(value);
    const amount = mode === 'percent' ? `${bare}%` : `${formatAmount(bare)} a month`;
    return `${label} ${down ? 'down' : 'up'} by ${amount}`;
  };

  switch (assumption.kind) {
    case 'revenue_change':
      return `${sizedText('Sales', assumption.mode, assumption.value)}${from}`
        + (assumption.directCostsFollow ? ', with direct costs moving at your current rate' : ', with direct costs unchanged');
    case 'payroll_change':
      return `${sizedText('Wages', assumption.mode, assumption.value)}${from}`;
    case 'supplier_cost_change':
      return `${sizedText('Direct costs', assumption.mode, assumption.value)}${from}`;
    case 'marketing_change':
      return `${sizedText('Marketing', assumption.mode, assumption.value)}${from}`;
    case 'hiring':
      return `${assumption.headcount} ${assumption.headcount === 1 ? 'new person' : 'new people'} at `
        + `${formatAmount(assumption.monthlyCostPerPerson)} each a month${from || ' from month 1'}`;
    case 'pricing_change':
      return `Prices ${signed(assumption.pricePercent)}%, with the number of sales `
        + `${signed(assumption.volumePercent)}%${from}`
        + (assumption.directCostsFollow ? ', and direct costs moving with the number of sales' : ', and direct costs unchanged');
    case 'debt_drawdown':
      return `Borrow ${formatAmount(assumption.amount)} in month ${assumption.startsInMonth}`;
    case 'debt_repayment':
      return `Repay ${formatAmount(assumption.monthlyAmount)} a month${from || ' from month 1'}`
        + (assumption.monthlyInterest === null
          ? ', with no interest given, so none is counted'
          : `, plus ${formatAmount(assumption.monthlyInterest)} a month of interest`);
  }
}
