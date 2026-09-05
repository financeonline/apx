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

import { evaluateExpenseSpikeCategory } from './expense-spike';
import { evaluateBankUnusualTransaction } from './bank-unusual';
import { evaluateDuplicateTransaction } from './duplicate-transaction';
import { evaluateRecurringAmountChanged, evaluateRecurringMissed } from './recurring-anomaly';
import { dataSuppression, type SuppressionReason } from '../suppression';
import type { RuleContext } from '../context';
import { CONDITION_RULE_KEYS, type ConditionRuleKey, type RuleOutcome } from '../types';

export { evaluateExpenseSpikeCategory } from './expense-spike';
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
  evaluateRecurringAmountChanged, evaluateRecurringMissed,
  RECURRING_MIN_DEVIATION, RECURRING_MEDIUM_DEVIATION, RECURRING_MEDIUM_ABSOLUTE,
  RECURRING_MISSED_MIN_OCCURRENCES,
} from './recurring-anomaly';
export {
  SPIKE_PCT_THRESHOLD, SPIKE_REVENUE_SHARE, SPIKE_HIGH_PCT, SPIKE_HIGH_REVENUE_SHARE,
  SPIKE_ABSOLUTE_FLOOR,
} from './expense-spike';

type Evaluator = (ctx: RuleContext) => readonly RuleOutcome[];

const EVALUATORS: Readonly<Record<ConditionRuleKey, Evaluator>> = {
  'expense.spike_category': evaluateExpenseSpikeCategory,
  'bank.unusual_transaction': evaluateBankUnusualTransaction,
  'recurring.amount_changed': evaluateRecurringAmountChanged,
  'recurring.missed': (ctx) => evaluateRecurringMissed(ctx, 'outflow'),
  'recurring.inflow_missed': (ctx) => evaluateRecurringMissed(ctx, 'inflow'),
  'duplicate.transaction': evaluateDuplicateTransaction,
};

/** What one rule produced for one period, and — when it produced nothing — whether it even ran. */
export interface RuleEvaluation {
  readonly ruleKey: ConditionRuleKey;
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
  ruleKeys: readonly ConditionRuleKey[],
): readonly RuleOutcome[] {
  return evaluations
    .filter((e) => ruleKeys.includes(e.ruleKey))
    .flatMap((e) => e.outcomes);
}
