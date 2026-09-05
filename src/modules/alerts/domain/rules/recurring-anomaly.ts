/**
 * The recurring-payment conditions (FINANCIAL_ENGINE.md §8.2) health rule B3 counts:
 * `recurring.amount_changed`, `recurring.missed` and `recurring.inflow_missed`.
 *
 * A missed inflow and a missed outflow are separate rules because they mean opposite things. A
 * standing order that stopped going out may be a cancelled subscription — mildly interesting. A
 * standing order that stopped coming IN is a customer who stopped paying, which is why §8.2 gives it
 * a higher severity.
 *
 * Nothing here re-detects a group: detection happens once, inside the run, in `banking/domain`
 * (§4.3). These rules read the groups that run produced, so an alert and a score can never disagree
 * about whether a payment recurs.
 *
 * Pure.
 */

import { Decimal, tryParseDecimal, toMoneyString, toRatioString } from '@/core/money';
import type { RecurringGroupObservation, RuleContext } from '../context';
import type { RuleOutcome } from '../types';

/** Defaults, CD-18. */
export const RECURRING_MIN_DEVIATION = new Decimal('0.10');
export const RECURRING_MEDIUM_DEVIATION = new Decimal('0.25');
export const RECURRING_MEDIUM_ABSOLUTE = new Decimal('250');
/** A stopped group is only a finding once it has a history worth trusting (§8.2). */
export const RECURRING_MISSED_MIN_OCCURRENCES = 6;

function orderedGroups(
  groups: readonly RecurringGroupObservation[],
): readonly RecurringGroupObservation[] {
  return [...groups].sort((a, b) => a.groupKey.localeCompare(b.groupKey));
}

/**
 * `recurring.amount_changed`: the last payment deviates from the group's usual size by more than the
 * group's own tolerance, or 10%, whichever is larger.
 *
 * The group's tolerance is `max(0.10, MAD/median)` — a payment that varies naturally, like a
 * quarterly utility bill, carries a wider band than a fixed subscription, so the same absolute
 * change is a finding for one and not for the other.
 */
export function evaluateRecurringAmountChanged(ctx: RuleContext): readonly RuleOutcome[] {
  const outcomes: RuleOutcome[] = [];

  for (const group of orderedGroups(ctx.recurringGroups)) {
    if (group.status !== 'changed') continue;

    const expected = tryParseDecimal(group.expectedAmount)?.abs() ?? null;
    const actual = tryParseDecimal(group.lastAmount)?.abs() ?? null;
    if (expected === null || actual === null || expected.isZero()) continue;

    const difference = actual.minus(expected);
    const deviation = difference.abs().dividedBy(expected);

    const tolerance = tryParseDecimal(group.amountToleranceRatio) ?? RECURRING_MIN_DEVIATION;
    const band = tolerance.greaterThan(RECURRING_MIN_DEVIATION)
      ? tolerance : RECURRING_MIN_DEVIATION;
    if (deviation.lessThanOrEqualTo(band)) continue;

    const isMedium = deviation.greaterThanOrEqualTo(RECURRING_MEDIUM_DEVIATION)
      || difference.abs().greaterThanOrEqualTo(RECURRING_MEDIUM_ABSOLUTE);

    outcomes.push({
      ruleKey: 'recurring.amount_changed',
      severity: isMedium ? 'medium' : 'low',
      subject: { type: 'recurring_group', id: group.id, key: group.groupKey },
      periodId: ctx.periodId,
      thresholdSummary: {
        signature: group.signature,
        expected: toMoneyString(expected),
        actual: toMoneyString(actual),
        difference: toMoneyString(difference),
        deviation: toRatioString(deviation),
        tolerance: toRatioString(band),
        cadence: group.cadence,
      },
      snapshotIds: [],
      recordIds: [],
    });
  }

  return outcomes;
}

/** `recurring.missed` (outflow) and `recurring.inflow_missed` (inflow), §8.2. */
export function evaluateRecurringMissed(
  ctx: RuleContext,
  direction: 'inflow' | 'outflow',
): readonly RuleOutcome[] {
  const outcomes: RuleOutcome[] = [];

  for (const group of orderedGroups(ctx.recurringGroups)) {
    if (group.status !== 'stopped') continue;
    if (group.direction !== direction) continue;
    if (group.occurrences < RECURRING_MISSED_MIN_OCCURRENCES) continue;

    outcomes.push({
      ruleKey: direction === 'outflow' ? 'recurring.missed' : 'recurring.inflow_missed',
      severity: direction === 'outflow' ? 'low' : 'medium',
      subject: { type: 'recurring_group', id: group.id, key: group.groupKey },
      periodId: ctx.periodId,
      thresholdSummary: {
        signature: group.signature,
        expected: toMoneyString(tryParseDecimal(group.expectedAmount)?.abs() ?? new Decimal(0)),
        cadence: group.cadence,
        last_seen: group.lastSeen,
        next_expected: group.nextExpected,
        occurrences: String(group.occurrences),
      },
      snapshotIds: [],
      recordIds: [],
    });
  }

  return outcomes;
}
