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
import type { EvidencePin, RuleOutcome } from '../types';

/** Defaults, CD-18. */
export const RECURRING_MIN_DEVIATION = new Decimal('0.10');
export const RECURRING_MEDIUM_DEVIATION = new Decimal('0.25');
export const RECURRING_MEDIUM_ABSOLUTE = new Decimal('250');
/** A stopped group is only a finding once it has a history worth trusting (§8.2). */
export const RECURRING_MISSED_MIN_OCCURRENCES = 6;
/** §8.2 `recurring.new`: a group is worth mentioning once it has happened three times. */
export const RECURRING_NEW_OCCURRENCES = 3;
export const RECURRING_NEW_MIN_AMOUNT = new Decimal('50');

function orderedGroups(
  groups: readonly RecurringGroupObservation[],
): readonly RecurringGroupObservation[] {
  return [...groups].sort((a, b) => a.groupKey.localeCompare(b.groupKey));
}

/**
 * The group's own transactions, as a descriptor.
 *
 * Every recurring rule pins the same thing: the payments that make the group a group. A reader told
 * "this usually costs about £40" needs to see the run of £40 payments rather than take it on trust.
 */
function groupEvidence(
  ctx: RuleContext, group: RecurringGroupObservation,
  label: string, claim: string, limit: number,
): EvidencePin[] {
  if (group.id === null) return [];
  /*
   * The member transactions, pinned by id.
   *
   * The v1 descriptor vocabulary has no `recurring_group_ids` filter, and adding one would be a
   * schema decision rather than an alert decision. The rows are already loaded, so they are pinned
   * directly — which also means the evidence shows the payments that made the group a group at the
   * moment the alert was raised, rather than however the detector regroups them later (ADR-056.4).
   */
  const members = [...ctx.records, ...ctx.trailingRecords]
    .filter((r) => r.table === 'bank_transactions' && r.recurringGroupId === group.id)
    .sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id))
    .slice(0, limit);

  return members.map((member) => ({
    itemType: 'bank_transaction' as const,
    refId: member.id,
    queryDescriptor: null,
    label: `${label} — ${member.date}`,
    claim,
    assuranceLevel: 'verified' as const,
  }));
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
        // Recorded so the copy can tell money coming in from money going out: "check with the
        // provider" is the wrong advice about a customer whose payment changed. Not a threshold.
        direction: group.direction,
      },
      snapshotIds: [],
      recordIds: [],
      evidence: groupEvidence(ctx, group, `Recent payments to ${group.signature}`,
        'The payments this amount is compared against', 6),
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
      evidence: groupEvidence(ctx, group, `The last payments for ${group.signature}`,
        'The run that stopped', 3),
    });
  }

  return outcomes;
}

/**
 * `recurring.new` (§8.2): a new regular outflow has established itself.
 *
 * `info`, not a warning. A new standing order is usually something the business set up on purpose;
 * the alert exists so an UNEXPECTED one is visible, not so an expected one is alarming.
 *
 * It fires at exactly the third occurrence rather than at three or more, because a state alert that
 * kept firing as the group grew would say "a new regular payment has started" about a payment that
 * started a year ago.
 */
export function evaluateRecurringNew(ctx: RuleContext): readonly RuleOutcome[] {
  const outcomes: RuleOutcome[] = [];

  for (const group of orderedGroups(ctx.recurringGroups)) {
    if (group.direction !== 'outflow') continue;
    if (group.occurrences !== RECURRING_NEW_OCCURRENCES) continue;

    const expected = tryParseDecimal(group.expectedAmount)?.abs() ?? null;
    if (expected === null || expected.lessThan(RECURRING_NEW_MIN_AMOUNT)) continue;

    outcomes.push({
      ruleKey: 'recurring.new',
      severity: 'info',
      subject: { type: 'recurring_group', id: group.id, key: group.groupKey },
      periodId: ctx.periodId,
      thresholdSummary: {
        signature: group.signature,
        expected: toMoneyString(expected),
        cadence: group.cadence,
        occurrences: String(group.occurrences),
        threshold_amount: toMoneyString(RECURRING_NEW_MIN_AMOUNT),
      },
      snapshotIds: [],
      recordIds: [],
      evidence: groupEvidence(ctx, group, `The first payments to ${group.signature}`,
        'The payments that made this a regular one', RECURRING_NEW_OCCURRENCES),
    });
  }

  return outcomes;
}
