/**
 * Receivables and payables (FINANCIAL_ENGINE.md §8.2): `receivables.deterioration` and
 * `payables.deterioration`.
 *
 * Both are STATE rules, and both have two independent triggers — collection is getting slower, OR a
 * large share of what is owed is already overdue. They are separate tests because they fail
 * separately: a business whose customers all pay on day 89 has terrible days-to-pay and nothing
 * overdue, and a business with one ancient unpaid invoice has fine days-to-pay and a real problem.
 *
 * Pure.
 */

import { Decimal, toMoneyString, toRatioString } from '@/core/money';
import { observationOf, usableValue, type RuleContext } from '../context';
import { varianceKey } from '@/modules/financial-engine';
import { NO_SUBJECT, type EvidencePin, type RecordObservation, type RuleOutcome } from '../types';

/** Defaults, CD-18. */
export const DAYS_INCREASE = new Decimal('10');
export const OVERDUE_SHARE = new Decimal('0.30');
export const OVERDUE_SHARE_HIGH = new Decimal('0.50');
export const TOP_OVERDUE_LIMIT = 10;

type Side = 'receivables' | 'payables';

const SIDE: Readonly<Record<Side, {
  readonly ruleKey: 'receivables.deterioration' | 'payables.deterioration';
  readonly daysMetric: string;
  readonly totalMetric: string;
  readonly overdueMetric: string;
  readonly invoiceTypes: readonly string[];
  readonly baseSeverity: 'medium';
}>> = {
  receivables: {
    ruleKey: 'receivables.deterioration',
    daysMetric: 'receivables_days',
    totalMetric: 'receivables',
    overdueMetric: 'receivables_overdue',
    invoiceTypes: ['sales'],
    baseSeverity: 'medium',
  },
  payables: {
    ruleKey: 'payables.deterioration',
    daysMetric: 'payables_days',
    totalMetric: 'payables',
    overdueMetric: 'payables_overdue',
    invoiceTypes: ['purchase'],
    baseSeverity: 'medium',
  },
};

/** The largest overdue invoices this period, pinned by id (§8.2). */
function topOverdue(ctx: RuleContext, invoiceTypes: readonly string[]): RecordObservation[] {
  return ctx.records
    .filter((r) => r.table === 'invoices'
      && r.invoiceType !== undefined && r.invoiceType !== null
      && invoiceTypes.includes(r.invoiceType)
      && r.outstanding != null
      && r.dueDate != null && r.dueDate < ctx.periodEnd)
    .map((r) => ({ r, amount: new Decimal(r.outstanding!).abs() }))
    .filter((x) => x.amount.greaterThan(0))
    .sort((a, b) => b.amount.comparedTo(a.amount) || a.r.id.localeCompare(b.r.id))
    .slice(0, TOP_OVERDUE_LIMIT)
    .map((x) => x.r);
}

function evaluateSide(ctx: RuleContext, side: Side): readonly RuleOutcome[] {
  const config = SIDE[side];

  const daysVariance = observationOf(
    ctx.snapshots, ctx.periodId, varianceKey(config.daysMetric, 'prev_period'));
  const slowedBy = usableValue(daysVariance);

  const totalObservation = observationOf(ctx.snapshots, ctx.periodId, config.totalMetric);
  const overdueObservation = observationOf(ctx.snapshots, ctx.periodId, config.overdueMetric);
  const total = usableValue(totalObservation);
  const overdue = usableValue(overdueObservation);

  const share = total !== null && overdue !== null && total.abs().greaterThan(0)
    ? overdue.abs().dividedBy(total.abs())
    : null;

  const slowing = slowedBy !== null && slowedBy.greaterThanOrEqualTo(DAYS_INCREASE);
  const overdueHeavy = share !== null && share.greaterThanOrEqualTo(OVERDUE_SHARE);
  if (!slowing && !overdueHeavy) return [];

  const invoices = topOverdue(ctx, config.invoiceTypes);
  const top3 = invoices.slice(0, 3)
    .reduce((sum, r) => sum.plus(new Decimal(r.outstanding!).abs()), new Decimal(0));

  const evidence: EvidencePin[] = [];
  for (const observation of [overdueObservation, totalObservation, daysVariance]) {
    if (observation?.snapshotId == null) continue;
    evidence.push({
      itemType: 'metric_snapshot',
      refId: observation.snapshotId,
      queryDescriptor: null,
      label: observation.metricKey,
      claim: 'A figure this alert rests on',
      assuranceLevel: observation.assurance,
    });
  }
  for (const invoice of invoices) {
    evidence.push({
      itemType: 'invoice',
      refId: invoice.id,
      queryDescriptor: null,
      label: invoice.descriptionNormalized ?? 'Overdue invoice',
      claim: 'An overdue invoice behind this alert',
      assuranceLevel: 'verified',
    });
  }

  return [{
    ruleKey: config.ruleKey,
    severity: share !== null && share.greaterThanOrEqualTo(OVERDUE_SHARE_HIGH)
      ? 'high' : config.baseSeverity,
    subject: NO_SUBJECT,
    periodId: ctx.periodId,
    metricKey: config.overdueMetric,
    thresholdSummary: {
      trigger: overdueHeavy ? 'overdue_share' : 'days_increase',
      overdue: overdue === null ? null : toMoneyString(overdue.abs()),
      total: total === null ? null : toMoneyString(total.abs()),
      share: share === null ? null : toRatioString(share),
      days_increase: slowedBy === null ? null : slowedBy.toDecimalPlaces(1).toString(),
      overdue_count: String(invoices.length),
      top3_share: overdue !== null && overdue.abs().greaterThan(0)
        ? toRatioString(top3.dividedBy(overdue.abs())) : null,
      threshold_share: toRatioString(OVERDUE_SHARE),
      threshold_days: DAYS_INCREASE.toString(),
    },
    snapshotIds: [overdueObservation?.snapshotId, daysVariance?.snapshotId]
      .filter((id): id is string => id != null),
    recordIds: invoices.map((r) => r.id),
    evidence,
  }];
}

export function evaluateReceivablesDeterioration(ctx: RuleContext): readonly RuleOutcome[] {
  return evaluateSide(ctx, 'receivables');
}

export function evaluatePayablesDeterioration(ctx: RuleContext): readonly RuleOutcome[] {
  return evaluateSide(ctx, 'payables');
}
