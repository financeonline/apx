/**
 * Alert copy (FINANCIAL_ENGINE.md §8.2 templates, UX_ARCHITECTURE.md §8.3).
 *
 * §8.3 requires every alert to be rendered in three labelled parts — **What happened**, **Why it
 * matters**, **What you can do**. §8.2 supplies two of them per rule: an "Explanation template" and
 * a "Next step template". It supplies no "why it matters" line for any rule, and the middle part is
 * the one that turns a number into a reason to act ("That's a third of March's profit"). Those
 * eighteen sentences are written here and flagged for the copy audit (ADR-056.2) rather than left
 * blank, because an alert that says what happened and what to do without saying why is an
 * instruction rather than an explanation.
 *
 * **Placeholders come only from `threshold_summary`** (§8.2, ADR-032.7). A template may not reach
 * for a figure the outcome did not record, which is what stops the prose and the typed fields the AI
 * reads from ever disagreeing. `{customer}` and `{signature}` render stored names and are treated as
 * untrusted text by the AI layer.
 *
 * Pure: rendering is a function of the outcome and the currency, and of nothing else.
 */

import { formatMoney, formatPercent, tryParseDecimal } from '@/core/money';
import type { AlertRuleKey, RuleOutcome } from './types';
import { OVERFLOW_RULE_KEY } from './types';

export interface RenderedAlert {
  readonly title: string;
  /** §8.3 part 1, and the `alerts.explanation` column. */
  readonly whatHappened: string;
  /** §8.3 part 2. */
  readonly whyItMatters: string;
  /** §8.3 part 3, and the `alerts.recommended_next_step` column. */
  readonly whatYouCanDo: string;
  /** The threshold, for the tooltip §8.3 asks for ("We flag expense categories that rise…"). */
  readonly thresholdNote: string;
}

type Values = Readonly<Record<string, string | null>>;

interface Template {
  readonly title: (v: Values, c: Currency) => string;
  readonly whatHappened: (v: Values, c: Currency) => string;
  readonly whyItMatters: (v: Values, c: Currency) => string;
  readonly whatYouCanDo: (v: Values, c: Currency) => string;
  readonly thresholdNote: (v: Values, c: Currency) => string;
}

type Currency = string;

// ---------------------------------------------------------------------------------------------
// Formatting helpers. Every one of them handles a missing value, because a template that renders
// "undefined" into a customer-facing sentence is worse than one that renders nothing.
// ---------------------------------------------------------------------------------------------

function money(value: string | null | undefined, currency: Currency): string {
  const parsed = tryParseDecimal(value ?? null);
  return parsed === null ? 'an amount we could not read' : formatMoney(parsed, { currency });
}

/** A magnitude: templates that already say "fell" must not also print a minus sign. */
function amount(value: string | null | undefined, currency: Currency): string {
  const parsed = tryParseDecimal(value ?? null);
  return parsed === null ? 'an amount we could not read' : formatMoney(parsed.abs(), { currency });
}

function percent(value: string | null | undefined): string {
  const parsed = tryParseDecimal(value ?? null);
  return parsed === null ? 'an amount we could not work out' : formatPercent(parsed.abs());
}

/** Percentage POINTS: a margin that moved 0.031 moved 3.1 points, not 3.1 per cent of itself. */
function points(value: string | null | undefined): string {
  const parsed = tryParseDecimal(value ?? null);
  return parsed === null ? 'an amount we could not work out'
    : `${parsed.abs().times(100).toDecimalPlaces(1).toString()} pts`;
}

function text(value: string | null | undefined, fallback: string): string {
  return value === null || value === undefined || value.trim() === '' ? fallback : value;
}

function count(value: string | null | undefined): string {
  return value ?? 'several';
}

/** A money value that is present and above zero — a clause about it is only worth saying then. */
function isPositiveMoney(value: string | null | undefined): boolean {
  const parsed = tryParseDecimal(value ?? null);
  return parsed !== null && parsed.greaterThan(0);
}

/** Plain-language names for the metrics `variance.significant` can be about. */
const METRIC_NAMES: Readonly<Record<string, string>> = {
  operating_profit: 'Profit before interest and tax',
  net_profit: 'Net profit',
  net_cash_movement: 'The change in cash',
};

// ---------------------------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------------------------

export const TEMPLATES: Readonly<Record<AlertRuleKey | typeof OVERFLOW_RULE_KEY, Template>> = {
  'expense.spike_category': {
    title: (v) => `${text(v.category, 'A category')} spending jumped`,
    whatHappened: (v, c) =>
      `${text(v.category, 'A category')} spending was ${money(v.current, c)} this period, up ${amount(v.value, c)} (${percent(v.pct_change)}) on the month before.`,
    whyItMatters: (v, c) =>
      `That is ${amount(v.value, c)} of profit gone unless the extra spend brought something back.`,
    whatYouCanDo: (v) =>
      `Review the largest ${text(v.category, '')} transactions and confirm they are expected.`.replace('  ', ' '),
    thresholdNote: (v, c) =>
      `We flag a category that rises at least ${percent(v.threshold_pct)} and ${money(v.threshold_value, c)} month on month.`,
  },
  'expense.spike_account': {
    title: (v) => `${text(v.account, 'An account')} rose sharply`,
    whatHappened: (v, c) =>
      `${text(v.account, 'An account')} rose ${percent(v.pct_change)} to ${money(v.current, c)}.`,
    whyItMatters: (v, c) =>
      `A single account moving ${amount(v.value, c)} usually has one cause, and it is usually findable.`,
    whatYouCanDo: (v) =>
      `Review the largest entries on ${text(v.account, 'this account')} and confirm they are expected.`,
    thresholdNote: (v, c) =>
      `We flag an account that rises at least ${percent(v.threshold_pct)} and ${money(v.threshold_value, c)} month on month.`,
  },
  'revenue.decline': {
    title: () => 'Revenue fell',
    whatHappened: (v, c) =>
      `Revenue fell ${percent(v.pct_change)} to ${money(v.current, c)}, compared with ${text(v.comparison_period, 'the previous period')}.`,
    whyItMatters: () =>
      'Revenue is the figure every other one depends on; a fall this size changes profit and cash within a month or two.',
    whatYouCanDo: () =>
      'Check whether the drop is timing — late invoicing — or lost customers; see the customers that fell most.',
    thresholdNote: () =>
      'We flag revenue down more than 15% on the previous month, or more than 20% on the same month last year.',
  },
  'margin.deterioration': {
    title: (v) => `${v.margin === 'net' ? 'Net' : 'Gross'} margin fell`,
    whatHappened: (v) =>
      `${v.margin === 'net' ? 'Net' : 'Gross'} margin is ${percent(v.current)}, down ${points(v.value)} from ${text(v.comparison_period, 'the comparison period')}.`,
    whyItMatters: () =>
      'Margin is what every sale leaves behind; when it falls, the same revenue buys less of everything else.',
    whatYouCanDo: () =>
      'Compare pricing and supplier costs; margin usually moves because one of them did.',
    thresholdNote: () =>
      'We flag gross margin down more than 3 points on its 3-month average, or net margin down more than 5 points on the previous month.',
  },
  'cash.decline': {
    title: (v) => v.trigger === 'consecutive_months' ? 'More money went out than came in' : 'Cash fell',
    // R-4: the consecutive trigger is NET MOVEMENT below zero for N months. It is not the balance:
    // an account joining the scope can lift the balance while money keeps flowing out, and "cash has
    // fallen … to 9,100" beside a balance that rose from 7,500 contradicted itself.
    whatHappened: (v, c) => v.trigger === 'consecutive_months'
      ? `More money has gone out than come in for ${count(v.consecutive_months)} months in a row. Cash now stands at ${money(v.current, c)}.`
      : `Cash fell from ${money(v.comparison, c)} to ${money(v.current, c)} this period.`,
    whyItMatters: () =>
      'Cash is the only figure that decides whether the business can pay what it owes next month.',
    whatYouCanDo: () =>
      'Look at the largest outflows this period and confirm they were planned.',
    thresholdNote: (v, c) =>
      `We flag a fall of more than a fifth of opening cash and at least ${money(v.threshold_floor, c)}, or three consecutive months of falling cash.`,
  },
  'cash.runway_low': {
    title: () => 'Cash would not last long at this rate',
    whatHappened: (v) =>
      `At the current rate of spending, cash would last about ${count(v.runway)} months.`,
    whyItMatters: () =>
      'This is the figure a lender, a landlord and a payroll run all depend on, and it is the one that gives least warning.',
    whatYouCanDo: (v, c) => v.receivables_overdue === null
      ? 'Defer non-essential spending and bring forward what you can collect.'
      : `Prioritise collecting ${money(v.receivables_overdue, c)} of overdue invoices and defer non-essential spending.`,
    thresholdNote: () => 'We flag a runway under 3 months, and treat under 1.5 months as critical.',
  },
  'receivables.deterioration': {
    title: () => 'More of what you are owed is overdue',
    // ADR-124 D-5: the sentence is about the open invoices, whose share of overdue is a share; credit
    // notes are stated beside it rather than netted into it. An alert stored before ADR-124 has no
    // invoice figures and keeps its original sentence.
    whatHappened: (v, c) => (v.open_invoices == null
      ? `${money(v.overdue, c)} of the ${money(v.total, c)} owed to you is overdue (${percent(v.share)}).`
      : `${money(v.overdue_invoices, c)} of the ${money(v.open_invoices, c)} owed to you on open invoices is overdue`
        + (v.share == null ? '.' : ` (${percent(v.share)}).`)
        + (isPositiveMoney(v.open_credits)
          ? ` Open credit notes of ${money(v.open_credits, c)} bring what you are owed to ${money(v.total, c)}.`
          : '')),
    whyItMatters: () =>
      'Money owed to you is not money you have; every week it sits there is a week you are lending it for nothing.',
    whatYouCanDo: (v) => v.top3_share === null
      ? `Chase the ${count(v.overdue_count)} largest overdue invoices.`
      : `Chase the ${count(v.overdue_count)} largest overdue invoices; the top three account for ${percent(v.top3_share)}.`,
    thresholdNote: () =>
      'We flag when at least 30% of what you are owed is overdue, or collection slowed by 10 days or more.',
  },
  'payables.deterioration': {
    title: () => 'You owe money that is past due',
    whatHappened: (v, c) => `You owe ${money(v.overdue_invoices ?? v.overdue, c)} that is past due.`,
    whyItMatters: () =>
      'Suppliers who are not paid on time tighten terms, and tighter terms cost more than the invoice did.',
    whatYouCanDo: () =>
      'Agree payment plans with the largest overdue suppliers before they affect supply.',
    thresholdNote: () =>
      'We flag when at least 30% of what you owe is past due, or you slowed by 10 days or more.',
  },
  'concentration.customer': {
    title: (v) => `${text(v.customer, 'One customer')} is a large share of revenue`,
    whatHappened: (v) =>
      `${text(v.customer, 'One customer')} makes up ${percent(v.share)} of revenue this period.`,
    whyItMatters: () =>
      'If that customer leaves or pays late, the business feels it immediately and has nothing to absorb it.',
    whatYouCanDo: (v) =>
      `Reduce reliance on ${text(v.customer, 'this customer')}: protect the account and grow the next tier.`,
    thresholdNote: () => 'We flag a single customer at 35% of revenue, and 50% as high.',
  },
  'concentration.supplier': {
    title: (v) => `${text(v.supplier, 'One supplier')} takes a large share of spend`,
    whatHappened: (v) => `${text(v.supplier, 'One supplier')} received ${percent(v.share)} of spend.`,
    whyItMatters: () =>
      'A single supplier at this share sets your costs, and a price rise from them is a price rise for you.',
    whatYouCanDo: (v) =>
      `Check contract terms and alternatives for ${text(v.supplier, 'this supplier')}.`,
    thresholdNote: () => 'We flag a single supplier at 40% of spend, and 60% as higher.',
  },
  'recurring.amount_changed': {
    title: (v) => `${text(v.signature, 'A regular payment')} changed amount`,
    whatHappened: (v, c) =>
      `${text(v.signature, 'A regular payment')} was ${money(v.actual, c)}, usually about ${money(v.expected, c)}.`,
    whyItMatters: () =>
      'A regular payment that changes quietly is one nobody agreed to; the difference repeats every period.',
    whatYouCanDo: () => 'Confirm the new amount is correct with the provider.',
    thresholdNote: () =>
      'We flag a regular payment that moves more than its usual variation, or more than 10%.',
  },
  'recurring.missed': {
    title: (v) => `${text(v.signature, 'A regular payment')} did not happen`,
    whatHappened: (v) =>
      `${text(v.signature, 'A regular payment')} did not occur this period; it usually happens every ${text(v.cadence, 'month')}.`,
    whyItMatters: () =>
      'Either it was cancelled and the saving is real, or it failed and is now overdue. Those are opposite situations.',
    whatYouCanDo: () => 'Check whether the payment was cancelled or is overdue.',
    thresholdNote: () =>
      'We flag a regular payment with at least six occurrences that stops happening.',
  },
  'recurring.inflow_missed': {
    title: (v) => `${text(v.signature, 'A regular payment in')} did not arrive`,
    whatHappened: (v) =>
      `${text(v.signature, 'A regular payment in')} did not arrive this period; it usually does every ${text(v.cadence, 'month')}.`,
    whyItMatters: () =>
      'A regular payment in that stops is usually a customer who stopped, and that shows up in cash before it shows up anywhere else.',
    whatYouCanDo: () => 'Check whether the customer has stopped, or whether the payment is late.',
    thresholdNote: () =>
      'We flag a regular payment in with at least six occurrences that stops arriving.',
  },
  'recurring.new': {
    title: (v) => `A new regular payment to ${text(v.signature, 'a supplier')}`,
    whatHappened: (v, c) =>
      `A new regular payment of about ${money(v.expected, c)} to ${text(v.signature, 'a supplier')} has started.`,
    whyItMatters: () =>
      'Subscriptions are easy to start and easy to forget; this one will now repeat until somebody stops it.',
    whatYouCanDo: () => 'Confirm this subscription or standing order is intended.',
    thresholdNote: (v, c) =>
      `We mention a new regular payment of at least ${money(v.threshold_amount, c)} once it has happened three times.`,
  },
  'duplicate.transaction': {
    title: () => 'Two payments look like duplicates',
    whatHappened: (v, c) =>
      `Two payments of ${money(v.amount, c)} to ${text(v.signature, 'the same payee')} on ${text(v.first_date, 'two dates')} and ${text(v.second_date, '')} look like duplicates.`.replace(' and .', '.'),
    whyItMatters: (v, c) =>
      `If this was paid twice, ${money(v.amount, c)} is sitting with somebody else and will not come back on its own.`,
    whatYouCanDo: () => 'Confirm with the supplier or bank; request a refund if it was paid twice.',
    thresholdNote: () =>
      'We flag two records with the same identity, or the same amount to the same payee within a day.',
  },
  'bank.unusual_transaction': {
    title: () => 'An unusually large payment',
    whatHappened: (v, c) =>
      `A payment of ${money(v.amount, c)} to ${text(v.signature, 'a payee')} on ${text(v.date, 'this period')} is much larger than usual.`,
    whyItMatters: () =>
      'Payments this far outside the usual pattern are where mistakes and unauthorised spending show up.',
    whatYouCanDo: () => 'Verify this payment was authorised.',
    thresholdNote: (v, c) =>
      `We flag a single payment above ${money(v.threshold, c)}, based on your own spending over the last six complete months.`,
  },
  'deviation.large_transaction': {
    title: (v) => `An unusually large entry on ${text(v.account, 'an account')}`,
    whatHappened: (v, c) =>
      `${text(v.description, 'An entry')} of ${money(v.amount, c)} is far above the usual size for ${text(v.account, 'this account')}.`,
    whyItMatters: (v, c) =>
      `${text(v.account, 'This account')} usually sees about ${money(v.account_median, c)}; an entry this size is either real and worth knowing about, or miscoded.`,
    whatYouCanDo: () =>
      'Check the invoice or entry is correct and coded to the right account.',
    thresholdNote: (v, c) =>
      `We flag an entry at least three times an account's usual size and above ${money(v.threshold_floor, c)}.`,
  },
  'variance.significant': {
    title: (v) => `${METRIC_NAMES[v.metric_key ?? ''] ?? 'A figure'} moved sharply`,
    whatHappened: (v, c) =>
      `${METRIC_NAMES[v.metric_key ?? ''] ?? 'A figure'} changed by ${amount(v.value, c)} (${percent(v.pct_change)}) against ${text(v.comparison_period, 'the previous period')}.`,
    whyItMatters: () =>
      'A movement this large usually has one or two causes rather than many, and they are worth naming.',
    whatYouCanDo: () => 'Open the analysis to see which categories moved.',
    thresholdNote: () =>
      'We flag profit or cash moving more than 30%, where the movement is also worth more than 5% of revenue.',
  },
  [OVERFLOW_RULE_KEY]: {
    title: (v) => `${count(v.count)} further items need attention`,
    whatHappened: (v) =>
      `${count(v.count)} more items were found this period than fit in the list above.`,
    whyItMatters: () =>
      'They are lower priority than what is shown, not unimportant; a first import often finds a lot at once.',
    whatYouCanDo: () => 'Open Insights to see the full list.',
    thresholdNote: () => 'We show at most 25 new items per calculation, most serious first.',
  },
};

/** Render one outcome into the three parts §8.3 requires. */
export function renderAlert(
  outcome: Pick<RuleOutcome, 'ruleKey' | 'thresholdSummary'>,
  currency: Currency,
): RenderedAlert {
  const template = TEMPLATES[outcome.ruleKey];
  const v = outcome.thresholdSummary;
  return {
    title: template.title(v, currency),
    whatHappened: template.whatHappened(v, currency),
    whyItMatters: template.whyItMatters(v, currency),
    whatYouCanDo: template.whatYouCanDo(v, currency),
    thresholdNote: template.thresholdNote(v, currency),
  };
}

/** The overflow summary's copy, which has no rule to produce an outcome for it. */
export function renderOverflow(count: number, currency: Currency): RenderedAlert {
  return renderAlert(
    {
      ruleKey: OVERFLOW_RULE_KEY as unknown as AlertRuleKey,
      thresholdSummary: { count: String(count) },
    },
    currency,
  );
}


/**
 * The threshold note §8.3 puts in an alert's tooltip, and the "why it matters" line.
 *
 * Both re-rendered from the STORED `threshold_summary`, so a tooltip states the rule using the same
 * figures the alert did. The `alerts` row holds parts one and three of §8.3 (`explanation` and
 * `recommended_next_step`) because those are what an export or an AI answer quotes; part two is
 * derived, so it cannot drift from the numbers beside it.
 */
export function thresholdNoteFor(
  ruleKey: string,
  thresholdSummary: Readonly<Record<string, string | null>>,
  currency: string,
): string | null {
  const template = TEMPLATES[ruleKey as AlertRuleKey];
  return template === undefined ? null : template.thresholdNote(thresholdSummary, currency);
}

export function whyItMattersFor(
  ruleKey: string,
  thresholdSummary: Readonly<Record<string, string | null>>,
  currency: string,
): string | null {
  const template = TEMPLATES[ruleKey as AlertRuleKey];
  return template === undefined ? null : template.whyItMatters(thresholdSummary, currency);
}
