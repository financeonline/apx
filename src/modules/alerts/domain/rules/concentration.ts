/**
 * Concentration (FINANCIAL_ENGINE.md §8.2): `concentration.customer` and `concentration.supplier`.
 *
 * Both are STATE rules, and the customer rule carries the re-fire condition §8.2 states explicitly:
 * "only re-fires when share changes ≥ 0.05 or crosses a band". That is not a rule about when to
 * fire — the condition either holds or it does not — it is a rule about when a re-evaluation counts
 * as MATERIALLY CHANGED and therefore earns a new revision. It is implemented in `lifecycle.ts`
 * beside the other materiality tests, because that is the question it answers.
 *
 * A business whose largest customer is 55% of revenue is in the same position in November as it was
 * in March. Six months of trial balances therefore produce ONE alert, dated from the first month
 * (F-D-12).
 *
 * Pure.
 */

import { Decimal, toRatioString } from '@/core/money';
import { observationOf, queryPin, usableValue, type RuleContext } from '../context';
import type { EvidencePin, MetricObservation, RuleOutcome } from '../types';

/** Defaults, CD-18. */
export const CUSTOMER_CONCENTRATION_MEDIUM = new Decimal('0.35');
export const CUSTOMER_CONCENTRATION_HIGH = new Decimal('0.50');
export const SUPPLIER_CONCENTRATION_LOW = new Decimal('0.40');
export const SUPPLIER_CONCENTRATION_MEDIUM = new Decimal('0.60');
/** §8.2: a state alert re-fires when the share moves this far, or crosses a band. */
export const CONCENTRATION_MATERIAL_MOVE = new Decimal('0.05');

/**
 * The largest counterparty by a dimensioned metric, and its share.
 *
 * The top-1 CONCENTRATION metric is a number with no name attached; the subject of the alert has to
 * be the counterparty itself, so the reader can open it. That identity comes from the dimensioned
 * revenue or spend snapshots, ordered deterministically so two runs name the same customer when two
 * are tied.
 */
export function largestCounterparty(
  ctx: RuleContext, metricKey: string,
): { id: string; snapshot: MetricObservation; value: Decimal } | null {
  const candidates = ctx.snapshots
    .filter((s) => s.periodId === ctx.periodId && s.metricKey === metricKey && s.dimensionId !== null)
    .map((s) => ({ id: s.dimensionId!, snapshot: s, value: usableValue(s) }))
    .filter((x): x is { id: string; snapshot: MetricObservation; value: Decimal } =>
      x.value !== null);
  if (candidates.length === 0) return null;

  return candidates.sort(
    (a, b) => b.value.abs().comparedTo(a.value.abs()) || a.id.localeCompare(b.id),
  )[0]!;
}

function pin(
  observation: MetricObservation | undefined, label: string, claim: string,
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

export function evaluateCustomerConcentration(ctx: RuleContext): readonly RuleOutcome[] {
  const observation = observationOf(ctx.snapshots, ctx.periodId, 'customer_concentration_top1');
  const share = usableValue(observation);
  if (share === null || share.lessThan(CUSTOMER_CONCENTRATION_MEDIUM)) return [];

  const top = largestCounterparty(ctx, 'customer_revenue');
  const name = top === null ? 'Your largest customer'
    : ctx.counterpartyNames.get(top.id) ?? 'Your largest customer';

  return [{
    ruleKey: 'concentration.customer',
    severity: share.greaterThanOrEqualTo(CUSTOMER_CONCENTRATION_HIGH) ? 'high' : 'medium',
    subject: { type: 'counterparty', id: top?.id ?? null, key: null },
    periodId: ctx.periodId,
    metricKey: 'customer_concentration_top1',
    thresholdSummary: {
      customer: name,
      share: toRatioString(share),
      revenue: top === null ? null : top.value.toString(),
      threshold: toRatioString(CUSTOMER_CONCENTRATION_MEDIUM),
      band: share.greaterThanOrEqualTo(CUSTOMER_CONCENTRATION_HIGH) ? 'high' : 'medium',
    },
    snapshotIds: observation?.snapshotId == null ? [] : [observation.snapshotId],
    recordIds: [],
    evidence: [
      ...pin(observation, 'Largest customer share', 'The concentration figure'),
      ...pin(top?.snapshot, `Revenue from ${name}`, 'What that customer is worth'),
      ...(top === null ? [] : queryPin(ctx, 'invoices', {
        period_ids: [ctx.periodId],
        counterparty_ids: [top.id],
        invoice_types: ['sales'],
      }, {
        label: `Invoices to ${name} this period`,
        claim: 'The sales behind that share',
      })),
    ],
  }];
}

export function evaluateSupplierConcentration(ctx: RuleContext): readonly RuleOutcome[] {
  const observation = observationOf(ctx.snapshots, ctx.periodId, 'supplier_concentration_top1');
  const share = usableValue(observation);
  if (share === null || share.lessThan(SUPPLIER_CONCENTRATION_LOW)) return [];

  const top = largestCounterparty(ctx, 'supplier_spend');
  const name = top === null ? 'Your largest supplier'
    : ctx.counterpartyNames.get(top.id) ?? 'Your largest supplier';

  return [{
    ruleKey: 'concentration.supplier',
    severity: share.greaterThanOrEqualTo(SUPPLIER_CONCENTRATION_MEDIUM) ? 'medium' : 'low',
    subject: { type: 'counterparty', id: top?.id ?? null, key: null },
    periodId: ctx.periodId,
    metricKey: 'supplier_concentration_top1',
    thresholdSummary: {
      supplier: name,
      share: toRatioString(share),
      spend: top === null ? null : top.value.abs().toString(),
      threshold: toRatioString(SUPPLIER_CONCENTRATION_LOW),
      band: share.greaterThanOrEqualTo(SUPPLIER_CONCENTRATION_MEDIUM) ? 'medium' : 'low',
    },
    snapshotIds: observation?.snapshotId == null ? [] : [observation.snapshotId],
    recordIds: [],
    evidence: [
      ...pin(observation, 'Largest supplier share', 'The concentration figure'),
      ...pin(top?.snapshot, `Spending with ${name}`, 'What that supplier receives'),
    ],
  }];
}
