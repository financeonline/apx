/**
 * The condition rules, behind the shared `dataSuppressed` filter (FINANCIAL_ENGINE.md §8.3).
 *
 * This is the entry point the health engine calls for K3 and B3. Going through one function means
 * suppression is applied identically for both consumers: a rule the alert job would not have
 * evaluated cannot quietly move a health score, and a rule that fired for the alert job cannot be
 * missing from the score.
 *
 * Pure.
 */

import { evaluateExpenseSpikeAccount, evaluateExpenseSpikeCategory } from './expense-spike';
import { evaluateBankUnusualTransaction } from './bank-unusual';
import { evaluateDuplicateTransaction } from './duplicate-transaction';
import {
  evaluateRecurringAmountChanged, evaluateRecurringMissed, evaluateRecurringNew,
} from './recurring-anomaly';
import {
  evaluateMarginDeterioration, evaluateRevenueDecline, evaluateVarianceSignificant,
} from './pnl';
import { evaluateCashDecline, evaluateCashRunwayLow } from './cash';
import {
  evaluatePayablesDeterioration, evaluateReceivablesDeterioration,
} from './working-capital';
import {
  evaluateCustomerConcentration, evaluateSupplierConcentration,
} from './concentration';
import { evaluateLargeTransactionDeviation } from './deviation';
import { dataSuppression, type SuppressionReason } from '../suppression';
import type { RuleContext } from '../context';
import { CONDITION_RULE_KEYS, type AlertRuleKey, type RuleOutcome } from '../types';

export { evaluateExpenseSpikeAccount, evaluateExpenseSpikeCategory } from './expense-spike';
export {
  MARGIN_GROSS_TRAILING, MARGIN_NET_PREV, REVENUE_DECLINE_HIGH, REVENUE_DECLINE_MOM,
  REVENUE_DECLINE_YOY, VARIANCE_PCT, VARIANCE_REVENUE_SHARE, VARIANCE_WATCHED,
  evaluateMarginDeterioration, evaluateRevenueDecline, evaluateVarianceSignificant,
} from './pnl';
export {
  CASH_CONSECUTIVE_FALLS, CASH_DECLINE_FLOOR, CASH_DECLINE_OUTFLOW_DIVISOR, CASH_DECLINE_SHARE,
  RUNWAY_CRITICAL, RUNWAY_LOW, consecutiveFalls,
  evaluateCashDecline, evaluateCashRunwayLow,
} from './cash';
export {
  DAYS_INCREASE, OVERDUE_SHARE, OVERDUE_SHARE_HIGH, TOP_OVERDUE_LIMIT,
  evaluatePayablesDeterioration, evaluateReceivablesDeterioration,
} from './working-capital';
export {
  CONCENTRATION_MATERIAL_MOVE, CUSTOMER_CONCENTRATION_HIGH, CUSTOMER_CONCENTRATION_MEDIUM,
  SUPPLIER_CONCENTRATION_LOW, SUPPLIER_CONCENTRATION_MEDIUM,
  evaluateCustomerConcentration, evaluateSupplierConcentration, largestCounterparty,
} from './concentration';
export {
  DEVIATION_FLOOR, DEVIATION_MULTIPLE, accountMedians, evaluateLargeTransactionDeviation,
} from './deviation';
export {
  evaluateBankUnusualTransaction, unusualThreshold,
  UNUSUAL_ABSOLUTE_FLOOR, UNUSUAL_MAD_MULTIPLE, UNUSUAL_NEW_COUNTERPARTY_SHARE,
  UNUSUAL_HIGH_OUTFLOW_SHARE,
} from './bank-unusual';
export {
  evaluateDuplicateTransaction, monthlyOutflows,
  DUPLICATE_MIN_AMOUNT, DUPLICATE_CRITICAL_AMOUNT, DUPLICATE_CRITICAL_OUTFLOW_SHARE,
  DUPLICATE_MAX_DAY_GAP,
} from './duplicate-transaction';
export {
  evaluateRecurringAmountChanged, evaluateRecurringMissed, evaluateRecurringNew,
  RECURRING_MIN_DEVIATION, RECURRING_MEDIUM_DEVIATION, RECURRING_MEDIUM_ABSOLUTE,
  RECURRING_MISSED_MIN_OCCURRENCES, RECURRING_NEW_MIN_AMOUNT, RECURRING_NEW_OCCURRENCES,
} from './recurring-anomaly';
export {
  SPIKE_PCT_THRESHOLD, SPIKE_REVENUE_SHARE, SPIKE_HIGH_PCT, SPIKE_HIGH_REVENUE_SHARE,
  SPIKE_ABSOLUTE_FLOOR,
} from './expense-spike';

type Evaluator = (ctx: RuleContext) => readonly RuleOutcome[];

/**
 * Every rule in §8.2, by key.
 *
 * A `Record<AlertRuleKey, Evaluator>` rather than a list: adding a key to the catalogue without
 * writing the rule is then a type error, which is the only way to keep "seventeen rules" a fact
 * rather than a claim.
 */
export const EVALUATORS: Readonly<Record<AlertRuleKey, Evaluator>> = {
  'expense.spike_category': evaluateExpenseSpikeCategory,
  'expense.spike_account': evaluateExpenseSpikeAccount,
  'revenue.decline': evaluateRevenueDecline,
  'margin.deterioration': evaluateMarginDeterioration,
  'cash.decline': evaluateCashDecline,
  'cash.runway_low': evaluateCashRunwayLow,
  'receivables.deterioration': evaluateReceivablesDeterioration,
  'payables.deterioration': evaluatePayablesDeterioration,
  'concentration.customer': evaluateCustomerConcentration,
  'concentration.supplier': evaluateSupplierConcentration,
  'recurring.amount_changed': evaluateRecurringAmountChanged,
  'recurring.missed': (ctx) => evaluateRecurringMissed(ctx, 'outflow'),
  'recurring.inflow_missed': (ctx) => evaluateRecurringMissed(ctx, 'inflow'),
  'recurring.new': evaluateRecurringNew,
  'duplicate.transaction': evaluateDuplicateTransaction,
  'bank.unusual_transaction': evaluateBankUnusualTransaction,
  'deviation.large_transaction': evaluateLargeTransactionDeviation,
  'variance.significant': evaluateVarianceSignificant,
};

/** What one rule produced for one period, and — when it produced nothing — whether it even ran. */
export interface RuleEvaluation {
  readonly ruleKey: AlertRuleKey;
  readonly outcomes: readonly RuleOutcome[];
  readonly suppression: SuppressionReason;
}

/**
 * Evaluate every condition rule for one period.
 *
 * Returned in `CONDITION_RULE_KEYS` order, which is fixed, so a breakdown written by two runs over
 * identical data is byte-identical.
 */
export function evaluateConditions(ctx: RuleContext): readonly RuleEvaluation[] {
  return CONDITION_RULE_KEYS.map((ruleKey) => {
    const suppression = dataSuppression(ruleKey, ctx);
    return {
      ruleKey,
      outcomes: suppression.suppressed ? [] : EVALUATORS[ruleKey](ctx),
      suppression,
    };
  });
}

/** Outcomes for a named subset of rules — how K3 asks for one rule and B3 for five. */
export function conditionsFor(
  evaluations: readonly RuleEvaluation[],
  ruleKeys: readonly AlertRuleKey[],
): readonly RuleOutcome[] {
  return evaluations
    .filter((e) => ruleKeys.includes(e.ruleKey))
    .flatMap((e) => e.outcomes);
}
