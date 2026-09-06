/**
 * The cash rules (FINANCIAL_ENGINE.md §8.2): `cash.decline` and `cash.runway_low`.
 *
 * `cash.decline` carries the one threshold in §8.2 with an explicit absolute floor written into it,
 * and the reason is in the document: the proportional test is `≤ −0.20 × |opening_cash|`, which is
 * meaningless when opening cash is zero or overdrawn — every business starting a month at nil would
 * trip it on the first pound out. The floor is what makes the rule mean something for the businesses
 * most likely to need it.
 *
 * `cash.runway_low` is a STATE rule: a business that has been three months from empty since March is
 * one alert in November, not nine. That is the whole of ADR-036 in one example.
 *
 * Pure.
 */

import { Decimal, toMoneyString, toRatioString } from '@/core/money';
import { observationOf, queryPin, usableValue, valueOf, type RuleContext } from '../context';
import { varianceKey } from '@/modules/financial-engine';
import { NO_SUBJECT, type EvidencePin, type MetricObservation, type RuleOutcome } from '../types';

/** Defaults, CD-18. */
export const CASH_DECLINE_SHARE = new Decimal('-0.20');
export const CASH_DECLINE_FLOOR = new Decimal('1000');
/** The floor's other half: a quarter of a month's average outflows (§8.2). */
export const CASH_DECLINE_OUTFLOW_DIVISOR = new Decimal('4');
export const CASH_CONSECUTIVE_FALLS = 3;
export const RUNWAY_LOW = new Decimal('3');
export const RUNWAY_CRITICAL = new Decimal('1.5');

function pin(
  observation: MetricObservation | undefined, label: string, claim: string | null,
): EvidencePin[] {
  if (observation?.snapshotId == null) return [];
  return [{
    itemType: 'metric_snapshot',
    refId: observation.snapshotId,
    queryDescriptor: null,
    label,
    claim,
    assuranceLevel: observation.assurance,
  }];
}

/** The average monthly outflow over the trailing complete months (§8.1, ADR-047.6). */
function averageOutflows(ctx: RuleContext): Decimal | null {
  const values = ctx.trailingCompletePeriodIds.slice(-3)
    .map((periodId) => valueOf(ctx.snapshots, periodId, 'cash_outflows'))
    .filter((v): v is Decimal => v !== null)
    .map((v) => v.abs());
  if (values.length === 0) return null;
  return values.reduce((total, v) => total.plus(v), new Decimal(0)).dividedBy(values.length);
}

/** Net cash movement was negative in every one of the last N COMPLETE periods (§8.2). */
export function consecutiveFalls(ctx: RuleContext, count: number): number {
  const periods = [...ctx.trailingCompletePeriodIds, ctx.periodId].slice(-count);
  if (periods.length < count) return 0;
  let falls = 0;
  for (const periodId of periods) {
    const movement = valueOf(ctx.snapshots, periodId, 'net_cash_movement');
    if (movement === null || !movement.isNegative()) return 0;
    falls += 1;
  }
  return falls;
}

export function evaluateCashDecline(ctx: RuleContext): readonly RuleOutcome[] {
  const key = varianceKey('closing_cash', 'prev_period');
  const variance = observationOf(ctx.snapshots, ctx.periodId, key);
  const change = usableValue(variance);
  const opening = valueOf(ctx.snapshots, ctx.periodId, 'opening_cash');
  const outflows = averageOutflows(ctx);

  const proportionalLimit = opening === null
    ? null : opening.abs().times(CASH_DECLINE_SHARE);
  const outflowFloor = outflows === null
    ? CASH_DECLINE_FLOOR
    : Decimal.max(CASH_DECLINE_FLOOR, outflows.dividedBy(CASH_DECLINE_OUTFLOW_DIVISOR));

  const droppedSharply = change !== null && proportionalLimit !== null
    && change.lessThanOrEqualTo(proportionalLimit)
    && change.lessThanOrEqualTo(outflowFloor.negated());

  const falls = consecutiveFalls(ctx, CASH_CONSECUTIVE_FALLS);
  const bledSteadily = falls === CASH_CONSECUTIVE_FALLS;

  if (!droppedSharply && !bledSteadily) return [];

  const closing = observationOf(ctx.snapshots, ctx.periodId, 'closing_cash');
  const outflowsNow = observationOf(ctx.snapshots, ctx.periodId, 'cash_outflows');

  return [{
    ruleKey: 'cash.decline',
    severity: 'high',
    subject: NO_SUBJECT,
    periodId: ctx.periodId,
    metricKey: 'closing_cash',
    thresholdSummary: {
      trigger: droppedSharply ? 'single_month' : 'consecutive_months',
      current: closing?.value ?? null,
      comparison: typeof variance?.components.comparison === 'string'
        ? variance.components.comparison : null,
      value: change === null ? null : toMoneyString(change),
      opening_cash: opening === null ? null : toMoneyString(opening),
      consecutive_months: bledSteadily ? String(falls) : null,
      threshold_share: toRatioString(CASH_DECLINE_SHARE),
      threshold_floor: toMoneyString(outflowFloor),
    },
    snapshotIds: [variance?.snapshotId, closing?.snapshotId]
      .filter((id): id is string => id != null),
    recordIds: [],
    evidence: [
      ...pin(closing, 'Cash at the end of the period', 'The balance that fell'),
      ...pin(variance, 'The change on the previous month', 'How far it fell'),
      ...pin(outflowsNow, 'Money out this period', 'What the cash went on'),
      // §8.2 pins the ten largest outflows; the descriptor resolves them as of this run, so the
      // list a reader opens in six months is the list the alert was raised on (ADR-034).
      ...largestOutflowsDescriptor(ctx),
    ],
  }];
}

/**
 * A descriptor rather than ten pinned ids.
 *
 * `EVIDENCE_MODEL.md §3` resolves a descriptor as of the run, so the ten largest outflows are the
 * ten that were largest THEN — even after a later import supersedes one of them. Pinning ids would
 * freeze the wrong thing: the rows, rather than the question they answer.
 */
function largestOutflowsDescriptor(ctx: RuleContext): EvidencePin[] {
  return queryPin(ctx, 'bank_transactions', {
    period_ids: [ctx.periodId],
    direction: 'outflow',
    exclude_transfers: 'cash_only',
  }, {
    label: 'The ten largest payments this period',
    claim: 'What the cash went on',
    order: [{ field: 'amount', dir: 'asc' }],
    limit: 10,
  });
}

export function evaluateCashRunwayLow(ctx: RuleContext): readonly RuleOutcome[] {
  const observation = observationOf(ctx.snapshots, ctx.periodId, 'cash_runway_months');
  const runway = usableValue(observation);
  if (runway === null || !runway.lessThan(RUNWAY_LOW)) return [];

  const overdue = observationOf(ctx.snapshots, ctx.periodId, 'receivables_overdue');
  const movements = ctx.trailingCompletePeriodIds.slice(-3)
    .map((periodId) => observationOf(ctx.snapshots, periodId, 'net_cash_movement'))
    .filter((o): o is MetricObservation => o !== undefined);

  return [{
    ruleKey: 'cash.runway_low',
    severity: runway.lessThan(RUNWAY_CRITICAL) ? 'critical' : 'high',
    subject: NO_SUBJECT,
    periodId: ctx.periodId,
    metricKey: 'cash_runway_months',
    thresholdSummary: {
      runway: runway.toDecimalPlaces(1).toString(),
      threshold: RUNWAY_LOW.toString(),
      receivables_overdue: overdue?.value ?? null,
      closing_cash: observationOf(ctx.snapshots, ctx.periodId, 'closing_cash')?.value ?? null,
    },
    snapshotIds: observation?.snapshotId == null ? [] : [observation.snapshotId],
    recordIds: [],
    evidence: [
      ...pin(observation, 'How long cash would last', 'The runway figure'),
      ...pin(observationOf(ctx.snapshots, ctx.periodId, 'closing_cash'),
        'Cash at the end of the period', 'What is left'),
      ...movements.flatMap((m, index) =>
        pin(m, `Net cash movement, ${movements.length - index} month(s) ago`,
          'The rate the runway is calculated from')),
      ...pin(overdue, 'Overdue invoices', 'Cash that could be collected'),
    ],
  }];
}
