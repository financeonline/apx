/**
 * The profit-and-loss rules (FINANCIAL_ENGINE.md §8.2): `revenue.decline`, `margin.deterioration`
 * and `variance.significant`.
 *
 * All three read variances, and all three are therefore silent whenever the comparison crosses a
 * basis change. That is not caution for its own sake: a trial balance last month against a bank
 * statement this month can move revenue by tens of thousands without a penny changing hands, and an
 * alert that fires on it teaches people to ignore alerts (F-B-07, ADR-030.3). `usableValue` and
 * `componentOf` return NULL for a `basis_differs` variance, so the suppression is structural rather
 * than a check each rule has to remember.
 *
 * Pure.
 */

import { Decimal, toMoneyString, toRatioString } from '@/core/money';
import { componentOf, observationOf, usableValue, valueOf, type RuleContext } from '../context';
import { minAbsThreshold } from '../suppression';
import { varianceKey } from '@/modules/financial-engine';
import { NO_SUBJECT, type EvidencePin, type MetricObservation, type RuleOutcome } from '../types';

/** Defaults, CD-18. */
export const REVENUE_DECLINE_MOM = new Decimal('-0.15');
export const REVENUE_DECLINE_YOY = new Decimal('-0.20');
export const REVENUE_DECLINE_HIGH = new Decimal('-0.30');
export const MARGIN_GROSS_TRAILING = new Decimal('-0.03');
export const MARGIN_NET_PREV = new Decimal('-0.05');
export const VARIANCE_PCT = new Decimal('0.30');
export const VARIANCE_REVENUE_SHARE = new Decimal('0.05');

/** The metrics `variance.significant` watches (§8.2). */
export const VARIANCE_WATCHED = ['operating_profit', 'net_profit', 'net_cash_movement'] as const;

function snapshotPin(
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

// ---------------------------------------------------------------------------------------------
// revenue.decline (event)
// ---------------------------------------------------------------------------------------------

export function evaluateRevenueDecline(ctx: RuleContext): readonly RuleOutcome[] {
  const momKey = varianceKey('revenue', 'prev_period');
  const yoyKey = varianceKey('revenue', 'same_period_last_year');

  const mom = observationOf(ctx.snapshots, ctx.periodId, momKey);
  const yoy = observationOf(ctx.snapshots, ctx.periodId, yoyKey);
  const momPct = componentOf(mom, 'pct_change');
  const yoyPct = componentOf(yoy, 'pct_change');

  const momFires = momPct !== null && momPct.lessThanOrEqualTo(REVENUE_DECLINE_MOM);
  const yoyFires = yoyPct !== null && yoyPct.lessThanOrEqualTo(REVENUE_DECLINE_YOY);
  if (!momFires && !yoyFires) return [];

  // Whichever comparison actually tripped is the one the sentence names. Reporting a year-on-year
  // fall as "since last month" would be a wrong statement about a real number.
  const source = momFires ? mom : yoy;
  const pct = momFires ? momPct! : yoyPct!;
  const comparison = momFires ? 'the previous month' : 'the same month last year';

  const revenue = observationOf(ctx.snapshots, ctx.periodId, 'revenue');
  const current = usableValue(revenue);
  // §8.1's absolute floor: a 20% fall on £300 of revenue is not a finding.
  const change = usableValue(source);
  if (change !== null && change.abs().lessThan(minAbsThreshold(current))) return [];

  const evidence: EvidencePin[] = [
    ...snapshotPin(revenue, 'Revenue this period', 'The revenue figure that fell'),
    ...snapshotPin(source, 'The comparison', 'The comparison the fall is measured against'),
  ];
  // §8.2: the five customers that fell most, so the reader can see where the drop came from.
  for (const customer of topNegativeCustomers(ctx, 5)) {
    evidence.push({
      itemType: 'metric_snapshot',
      refId: customer.snapshotId!,
      queryDescriptor: null,
      label: nameOf(ctx, customer.dimensionId),
      claim: 'A customer whose revenue fell this period',
      assuranceLevel: customer.assurance,
    });
  }

  return [{
    ruleKey: 'revenue.decline',
    severity: pct.lessThanOrEqualTo(REVENUE_DECLINE_HIGH) ? 'high' : 'medium',
    subject: NO_SUBJECT,
    periodId: ctx.periodId,
    metricKey: 'revenue',
    thresholdSummary: {
      pct_change: toRatioString(pct),
      current: typeof source?.components.current === 'string' ? source.components.current : null,
      comparison: typeof source?.components.comparison === 'string'
        ? source.components.comparison : null,
      comparison_period: comparison,
      threshold: toRatioString(momFires ? REVENUE_DECLINE_MOM : REVENUE_DECLINE_YOY),
    },
    snapshotIds: source?.snapshotId == null ? [] : [source.snapshotId],
    recordIds: [],
    evidence,
  }];
}

function nameOf(ctx: RuleContext, counterpartyId: string | null): string {
  if (counterpartyId === null) return 'A customer';
  return ctx.counterpartyNames.get(counterpartyId) ?? 'A customer';
}

function topNegativeCustomers(ctx: RuleContext, limit: number): MetricObservation[] {
  const key = varianceKey('customer_revenue', 'prev_period');
  return ctx.snapshots
    .filter((s) => s.periodId === ctx.periodId && s.metricKey === key
      && s.dimensionId !== null && s.snapshotId !== null)
    .map((s) => ({ s, value: usableValue(s) }))
    .filter((x): x is { s: MetricObservation; value: Decimal } =>
      x.value !== null && x.value.isNegative())
    .sort((a, b) => a.value.comparedTo(b.value) || a.s.dimensionId!.localeCompare(b.s.dimensionId!))
    .slice(0, limit)
    .map((x) => x.s);
}

// ---------------------------------------------------------------------------------------------
// margin.deterioration (event)
// ---------------------------------------------------------------------------------------------

export function evaluateMarginDeterioration(ctx: RuleContext): readonly RuleOutcome[] {
  const grossKey = varianceKey('gross_margin', 'trailing_3m_avg');
  const netKey = varianceKey('net_margin', 'prev_period');

  const grossTrend = observationOf(ctx.snapshots, ctx.periodId, grossKey);
  const netTrend = observationOf(ctx.snapshots, ctx.periodId, netKey);
  const grossValue = usableValue(grossTrend);
  const netValue = usableValue(netTrend);

  const grossFires = grossValue !== null && grossValue.lessThanOrEqualTo(MARGIN_GROSS_TRAILING);
  const netFires = netValue !== null && netValue.lessThanOrEqualTo(MARGIN_NET_PREV);
  if (!grossFires && !netFires) return [];

  const netMargin = valueOf(ctx.snapshots, ctx.periodId, 'net_margin');
  const grossMargin = observationOf(ctx.snapshots, ctx.periodId, 'gross_margin');
  const revenue = observationOf(ctx.snapshots, ctx.periodId, 'revenue');
  const costOfSales = observationOf(ctx.snapshots, ctx.periodId, 'cost_of_sales');

  const onGross = grossFires;
  const drop = onGross ? grossValue! : netValue!;

  return [{
    ruleKey: 'margin.deterioration',
    // §8.2: high when the business is now making a loss on every sale, whichever test tripped.
    severity: netMargin !== null && netMargin.isNegative() ? 'high' : 'medium',
    subject: NO_SUBJECT,
    periodId: ctx.periodId,
    metricKey: onGross ? 'gross_margin' : 'net_margin',
    thresholdSummary: {
      margin: onGross ? 'gross' : 'net',
      current: onGross
        ? (grossMargin?.value ?? null)
        : (observationOf(ctx.snapshots, ctx.periodId, 'net_margin')?.value ?? null),
      value: toRatioString(drop),
      comparison_period: onGross ? 'the 3-month average' : 'the previous month',
      threshold: toRatioString(onGross ? MARGIN_GROSS_TRAILING : MARGIN_NET_PREV),
      net_margin: netMargin === null ? null : toRatioString(netMargin),
    },
    snapshotIds: [grossTrend?.snapshotId, netTrend?.snapshotId]
      .filter((id): id is string => id != null),
    recordIds: [],
    evidence: [
      ...snapshotPin(onGross ? grossMargin : observationOf(ctx.snapshots, ctx.periodId, 'net_margin'),
        onGross ? 'Gross margin' : 'Net margin', 'The margin that fell'),
      ...snapshotPin(revenue, 'Revenue', 'One half of the margin'),
      ...snapshotPin(costOfSales, 'Cost of sales', 'The other half of the margin'),
      ...snapshotPin(onGross ? grossTrend : netTrend, 'The comparison',
        'The comparison the fall is measured against'),
    ],
  }];
}

// ---------------------------------------------------------------------------------------------
// variance.significant (event) — the catch-all, evaluated last (§8.3)
// ---------------------------------------------------------------------------------------------

/**
 * A large movement in profit or cash that no more specific rule already explains.
 *
 * The "no more specific rule" test is NOT applied here: §8.3 evaluates this rule after the others of
 * the same period, and the evaluator drops an outcome whose period already carries an outcome from
 * one of the rules listed in `RULES['variance.significant'].supersededBy`. Keeping the test in the
 * evaluator means it is applied once, uniformly, rather than reimplemented per rule.
 */
export function evaluateVarianceSignificant(ctx: RuleContext): readonly RuleOutcome[] {
  const revenue = valueOf(ctx.snapshots, ctx.periodId, 'revenue');
  const materiality = revenue === null ? null : revenue.abs().times(VARIANCE_REVENUE_SHARE);
  const floor = minAbsThreshold(revenue);

  const outcomes: RuleOutcome[] = [];

  for (const metricKey of VARIANCE_WATCHED) {
    const key = varianceKey(metricKey, 'prev_period');
    const observation = observationOf(ctx.snapshots, ctx.periodId, key);
    const change = usableValue(observation);
    const pct = componentOf(observation, 'pct_change');
    if (change === null || pct === null) continue;

    if (pct.abs().lessThan(VARIANCE_PCT)) continue;
    if (materiality !== null && change.abs().lessThan(materiality)) continue;
    if (change.abs().lessThan(floor)) continue;

    outcomes.push({
      ruleKey: 'variance.significant',
      // §8.2: a favourable movement is worth saying, but it is not a problem.
      severity: change.isPositive() ? 'info' : 'medium',
      subject: NO_SUBJECT,
      periodId: ctx.periodId,
      metricKey,
      thresholdSummary: {
        metric_key: metricKey,
        value: toMoneyString(change),
        pct_change: toRatioString(pct),
        current: typeof observation?.components.current === 'string'
          ? observation.components.current : null,
        comparison: typeof observation?.components.comparison === 'string'
          ? observation.components.comparison : null,
        comparison_period: 'the previous month',
        threshold_pct: toRatioString(VARIANCE_PCT),
      },
      snapshotIds: observation?.snapshotId == null ? [] : [observation.snapshotId],
      recordIds: [],
      evidence: [
        ...snapshotPin(observationOf(ctx.snapshots, ctx.periodId, metricKey),
          'The figure that moved', 'The metric this variance is about'),
        ...snapshotPin(observation, 'The comparison', 'What it is compared with'),
      ],
    });
  }

  return outcomes;
}
