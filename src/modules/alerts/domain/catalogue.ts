/**
 * The rule catalogue (FINANCIAL_ENGINE.md §8.2) and the dedupe keys it implies (ADR-018, ADR-036).
 *
 * One declaration per rule, listing the things the persistence layer needs to know without asking
 * the rule: its class, the metric it is about, the kind of subject it names, and the family it
 * belongs to. Keeping this beside the rules rather than inside them is what lets the evaluator sort,
 * cap and dedupe outcomes without a switch statement on rule keys — and what lets a test assert that
 * every rule in the document has an implementation, rather than only that every implementation runs.
 *
 * Pure.
 */

import {
  ALERT_RULE_KEYS, OVERFLOW_RULE_KEY,
  type AlertRuleClass, type AlertRuleKey, type AlertSubject, type AlertSubjectType,
} from './types';

export interface RuleDefinition {
  readonly key: AlertRuleKey;
  readonly klass: AlertRuleClass;
  /** The §8.2 family, for grouping in the interface. */
  readonly family: string;
  /** `alerts.metric_key`, or NULL for the record-level rules that are about a row, not a figure. */
  readonly metricKey: string | null;
  readonly subjectType: AlertSubjectType;
  /**
   * Rules whose outcome, in the same period, makes this one redundant.
   *
   * §8.2 gives two such suppressions: an account spike inside a category that already fired, and
   * `variance.significant` where a more specific rule already explains the move. Declared as data so
   * the evaluator applies them uniformly, in one place, after every rule has run.
   */
  readonly supersededBy: readonly AlertRuleKey[];
}

function rule(
  key: AlertRuleKey,
  klass: AlertRuleClass,
  family: string,
  metricKey: string | null,
  subjectType: AlertSubjectType,
  supersededBy: readonly AlertRuleKey[] = [],
): RuleDefinition {
  return { key, klass, family, metricKey, subjectType, supersededBy };
}

export const RULES: Readonly<Record<AlertRuleKey, RuleDefinition>> = {
  'expense.spike_category': rule(
    'expense.spike_category', 'event', 'Expense spike', 'expense_by_category', 'standard_category'),
  'expense.spike_account': rule(
    'expense.spike_account', 'event', 'Expense spike', 'expense_by_account', 'account',
    ['expense.spike_category']),
  'revenue.decline': rule('revenue.decline', 'event', 'Revenue decline', 'revenue', 'none'),
  'margin.deterioration': rule(
    'margin.deterioration', 'event', 'Margin deterioration', 'gross_margin', 'none'),
  'cash.decline': rule('cash.decline', 'event', 'Cash deterioration', 'closing_cash', 'none'),
  'cash.runway_low': rule(
    'cash.runway_low', 'state', 'Cash deterioration', 'cash_runway_months', 'none'),
  'receivables.deterioration': rule(
    'receivables.deterioration', 'state', 'Receivables deterioration', 'receivables_overdue', 'none'),
  'payables.deterioration': rule(
    'payables.deterioration', 'state', 'Payables deterioration', 'payables_overdue', 'none'),
  'concentration.customer': rule(
    'concentration.customer', 'state', 'Customer concentration',
    'customer_concentration_top1', 'counterparty'),
  'concentration.supplier': rule(
    'concentration.supplier', 'state', 'Supplier concentration',
    'supplier_concentration_top1', 'counterparty'),
  'recurring.amount_changed': rule(
    'recurring.amount_changed', 'state', 'Recurring-payment anomaly', null, 'recurring_group'),
  'recurring.missed': rule(
    'recurring.missed', 'state', 'Recurring-payment anomaly', null, 'recurring_group'),
  'recurring.inflow_missed': rule(
    'recurring.inflow_missed', 'state', 'Recurring-payment anomaly', null, 'recurring_group'),
  'recurring.new': rule(
    'recurring.new', 'state', 'Recurring-payment anomaly', null, 'recurring_group'),
  'duplicate.transaction': rule(
    'duplicate.transaction', 'event', 'Duplicate transaction', null, 'bank_transaction'),
  'bank.unusual_transaction': rule(
    'bank.unusual_transaction', 'event', 'Unusual bank transaction', null, 'bank_transaction'),
  'deviation.large_transaction': rule(
    'deviation.large_transaction', 'event', 'Large transaction deviation',
    'expense_by_account', 'none'),
  'variance.significant': rule(
    'variance.significant', 'event', 'Significant period variance', null, 'none',
    ['revenue.decline', 'expense.spike_category', 'expense.spike_account',
      'cash.decline', 'cash.runway_low', 'margin.deterioration']),
};

/** Fixed evaluation order. §8.3: `variance.significant` runs last so it can see what already explains P. */
export const RULE_ORDER: readonly AlertRuleKey[] = [
  ...ALERT_RULE_KEYS.filter((key) => key !== 'variance.significant'),
  'variance.significant',
];

// ---------------------------------------------------------------------------------------------
// Dedupe keys (ADR-018, ADR-036)
// ---------------------------------------------------------------------------------------------

/**
 * The subject part of a key.
 *
 * A standard category has no row id (ADR-053), so its NAME is what identifies it. Using `-` for
 * both "no subject" and "a subject whose id we lost" would merge two different alerts into one.
 */
function subjectPart(subject: AlertSubject): string {
  const identity = subject.id ?? subject.key;
  return `${subject.type}|${identity ?? '-'}`;
}

/**
 * `{rule_key}|{period_id}|{subject}` for an event, `{rule_key}|state|{subject}` for a state (§8.1).
 *
 * The period is deliberately absent from a state key. That single difference is what makes six
 * months of a persistent 55% customer ONE alert rather than six, and it is asserted directly by
 * TEST_STRATEGY.md §8 (F-D-12).
 */
export function dedupeKey(
  ruleKey: AlertRuleKey | typeof OVERFLOW_RULE_KEY,
  klass: AlertRuleClass,
  periodId: string,
  subject: AlertSubject,
): string {
  return klass === 'event'
    ? `${ruleKey}|${periodId}|${subjectPart(subject)}`
    : `${ruleKey}|state|${subjectPart(subject)}`;
}

/** The overflow summary is keyed per period: each run's remainder is its own row (§8.1). */
export function overflowDedupeKey(periodId: string): string {
  return dedupeKey(OVERFLOW_RULE_KEY, 'event', periodId, { type: 'none', id: null, key: null });
}

/** The §8.2 family an alert belongs to, for grouping a list. */
export function familyOf(ruleKey: string): string {
  return RULES[ruleKey as AlertRuleKey]?.family ?? 'Other';
}
