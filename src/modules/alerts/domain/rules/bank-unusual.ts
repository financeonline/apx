/**
 * `bank.unusual_transaction` (FINANCIAL_ENGINE.md §8.2), a condition health rule B3 counts.
 *
 * "Unusual" is defined against the organisation's own history, not against a fixed number: a £3,000
 * payment is routine for one business and alarming for another. The statistic is a median plus three
 * median absolute deviations, because a single quarterly VAT payment would inflate a standard
 * deviation enough to hide every genuinely unusual payment that month.
 *
 * Recurring payments and transfers are excluded before the statistic is applied. A £4,000 rent
 * standing order is large and entirely expected, and money moved between an organisation's own
 * accounts never left the business at all.
 *
 * Pure.
 */

import { Decimal, tryParseDecimal, toMoneyString, toRatioString } from '@/core/money';
import { medianAbsoluteDeviation, median, type RuleContext } from '../context';
import { monthlyOutflows } from './duplicate-transaction';
import type { RecordObservation, RuleOutcome } from '../types';

/** Defaults, CD-18. */
export const UNUSUAL_ABSOLUTE_FLOOR = new Decimal('1000');
export const UNUSUAL_MAD_MULTIPLE = new Decimal('3');
export const UNUSUAL_NEW_COUNTERPARTY_SHARE = new Decimal('0.10');
export const UNUSUAL_HIGH_OUTFLOW_SHARE = new Decimal('0.25');

/** Outflow magnitude, or NULL for anything that is not an outflow. */
function outflowMagnitude(record: RecordObservation): Decimal | null {
  const amount = tryParseDecimal(record.amount);
  if (amount === null || !amount.isNegative() || amount.isZero()) return null;
  return amount.abs();
}

/**
 * The size a single outflow must reach to count as unusual: `max(£1,000, median + 3 × MAD)`.
 *
 * Exported because the health breakdown shows the threshold that was applied, and a threshold a
 * reader cannot see is a threshold they cannot argue with.
 */
export function unusualThreshold(ctx: RuleContext): { threshold: Decimal; median: Decimal | null; mad: Decimal | null } {
  const history = ctx.trailingRecords
    .map(outflowMagnitude)
    .filter((v): v is Decimal => v !== null);

  const centre = median(history);
  const mad = medianAbsoluteDeviation(history);
  if (centre === null || mad === null) {
    return { threshold: UNUSUAL_ABSOLUTE_FLOOR, median: centre, mad };
  }
  const statistical = centre.plus(mad.times(UNUSUAL_MAD_MULTIPLE));
  return {
    threshold: statistical.greaterThan(UNUSUAL_ABSOLUTE_FLOOR)
      ? statistical : UNUSUAL_ABSOLUTE_FLOOR,
    median: centre,
    mad,
  };
}

export function evaluateBankUnusualTransaction(ctx: RuleContext): readonly RuleOutcome[] {
  const { threshold, median: centre, mad } = unusualThreshold(ctx);
  const outflows = monthlyOutflows(ctx);
  const newCounterpartyFloor = outflows === null
    ? null : outflows.times(UNUSUAL_NEW_COUNTERPARTY_SHARE);

  const outcomes: RuleOutcome[] = [];

  const candidates = [...ctx.records]
    .filter((r) => r.table === 'bank_transactions')
    .sort((a, b) => (a.date === b.date ? a.id.localeCompare(b.id) : a.date.localeCompare(b.date)));

  for (const record of candidates) {
    const amount = outflowMagnitude(record);
    if (amount === null) continue;
    // §8.2: neither a recurring payment nor a transfer can be an unusual transaction.
    if (record.isTransfer) continue;
    if (record.recurringGroupId !== null) continue;

    const isLarge = amount.greaterThanOrEqualTo(threshold);
    const isNewCounterparty = record.counterpartyId !== null
      && ctx.newCounterpartyIds.includes(record.counterpartyId)
      && newCounterpartyFloor !== null
      && amount.greaterThanOrEqualTo(newCounterpartyFloor);

    if (!isLarge && !isNewCounterparty) continue;

    const share = outflows !== null && outflows.greaterThan(0)
      ? amount.dividedBy(outflows) : null;
    const isHigh = share !== null && share.greaterThanOrEqualTo(UNUSUAL_HIGH_OUTFLOW_SHARE);

    outcomes.push({
      ruleKey: 'bank.unusual_transaction',
      severity: isHigh ? 'high' : 'medium',
      subject: { type: 'bank_transaction', id: record.id, key: null },
      periodId: ctx.periodId,
      thresholdSummary: {
        amount: toMoneyString(amount),
        date: record.date,
        signature: record.descriptionNormalized,
        trigger: isLarge ? 'size' : 'new_counterparty',
        threshold: toMoneyString(threshold),
        median_outflow: centre === null ? null : toMoneyString(centre),
        mad: mad === null ? null : toMoneyString(mad),
        monthly_outflows: outflows === null ? null : toMoneyString(outflows),
        share_of_outflows: share === null ? null : toRatioString(share),
      },
      snapshotIds: [],
      recordIds: [record.id],
    });
  }

  return outcomes;
}
