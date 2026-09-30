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
import { observationOf, usableValue, type OpenInvoiceObservation, type RuleContext } from '../context';
import { invoiceOutstandingAt, varianceKey } from '@/modules/financial-engine';
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
  readonly creditNoteType: string;
  readonly baseSeverity: 'medium';
}>> = {
  receivables: {
    ruleKey: 'receivables.deterioration',
    daysMetric: 'receivables_days',
    totalMetric: 'receivables',
    overdueMetric: 'receivables_overdue',
    invoiceTypes: ['sales'],
    creditNoteType: 'sales_credit_note',
    baseSeverity: 'medium',
  },
  payables: {
    ruleKey: 'payables.deterioration',
    daysMetric: 'payables_days',
    totalMetric: 'payables',
    overdueMetric: 'payables_overdue',
    invoiceTypes: ['purchase'],
    creditNoteType: 'purchase_credit_note',
    baseSeverity: 'medium',
  },
};

interface OverdueInvoice {
  readonly id: string;
  readonly outstanding: Decimal;
  readonly label: string;
}

/**
 * The largest invoices overdue at `asOf` — the date the overdue FIGURE was aged at (its
 * `components.as_of`) — valued by the engine's own rule (`invoiceOutstandingAt`: paid after the date
 * counts at its total; credit notes subtract), so the list agrees with the figure it explains
 * (ADR-120 hardening). Void invoices never reach `openInvoices`.
 */
function topOverdueOpen(
  invoices: readonly OpenInvoiceObservation[], invoiceTypes: readonly string[], asOf: string,
): OverdueInvoice[] {
  return invoices
    .filter((i) => invoiceTypes.includes(i.invoiceType) && i.issueDate <= asOf
      && i.dueDate !== null && i.dueDate < asOf)
    .map((i) => ({ id: i.id, outstanding: invoiceOutstandingAt(i, asOf), label: i.description ?? 'Overdue invoice' }))
    .filter((x) => x.outstanding.greaterThan(0))
    .sort((a, b) => b.outstanding.comparedTo(a.outstanding) || a.id.localeCompare(b.id));
}

/**
 * The invoice population the headline sentence names (ADR-124 D-5, audit N-7): every invoice of the
 * side still open at `asOf`, the overdue part of it, and the open credit notes — kept apart.
 *
 * The share used to be net overdue ÷ net total. A credit note not yet due lowers the total and not
 * the overdue part, so one overdue invoice of 1,000.00 beside a credit note of 800.00 read "1,000.00
 * of the 200.00 owed to you is overdue (500%)". Over the invoices themselves the share is a share —
 * never above 100% — and the credit notes are stated, not hidden.
 */
function openPopulation(
  invoices: readonly OpenInvoiceObservation[], invoiceTypes: readonly string[], creditNoteType: string, asOf: string,
): { open: Decimal; overdue: Decimal; credits: Decimal } {
  let open = new Decimal(0);
  let overdue = new Decimal(0);
  let credits = new Decimal(0);
  for (const i of invoices) {
    if (i.issueDate > asOf) continue;
    const outstanding = invoiceOutstandingAt(i, asOf);
    if (i.invoiceType === creditNoteType) {
      credits = credits.plus(outstanding.abs());
      continue;
    }
    if (!invoiceTypes.includes(i.invoiceType) || !outstanding.greaterThan(0)) continue;
    open = open.plus(outstanding);
    if (i.dueDate !== null && i.dueDate < asOf) overdue = overdue.plus(outstanding);
  }
  return { open, overdue, credits };
}

/** The pre-ADR-120 selection from this period's own records, for callers without `openInvoices`. */
function topOverdueFromRecords(ctx: RuleContext, invoiceTypes: readonly string[]): OverdueInvoice[] {
  return topOverdue(ctx, invoiceTypes).map((r) => ({
    id: r.id, outstanding: new Decimal(r.outstanding!).abs(), label: r.descriptionNormalized ?? 'Overdue invoice',
  }));
}

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

  /*
   * Nothing owed, nothing to deteriorate (ADR-123, audit F-10). A total at or below zero means the
   * credit notes outweigh the invoices: the business owes ITS customers (or suppliers owe it). Taking
   * magnitudes here raised a HIGH alert telling the owner 700.00 was owed and overdue on a net
   * credit of −700.00.
   */
  if (total === null || !total.greaterThan(0)) return [];

  const asOf = typeof overdueObservation?.components.as_of === 'string'
    ? overdueObservation.components.as_of : ctx.periodEnd;
  /*
   * The share of the OPEN INVOICES that is overdue (ADR-124 D-5). Without the invoice population
   * (a caller that supplies no `openInvoices`) the figures are all there is, and a net share above
   * 100% is not a share at all: it is withheld rather than stated.
   */
  const population = ctx.openInvoices !== undefined
    ? openPopulation(ctx.openInvoices, config.invoiceTypes, config.creditNoteType, asOf)
    : null;
  const shareOf = (part: Decimal | null, whole: Decimal | null): Decimal | null =>
    part !== null && whole !== null && part.greaterThan(0) && whole.greaterThan(0) && !part.greaterThan(whole)
      ? part.dividedBy(whole) : null;
  const share = population !== null ? shareOf(population.overdue, population.open) : shareOf(overdue, total);

  const slowing = slowedBy !== null && slowedBy.greaterThanOrEqualTo(DAYS_INCREASE);
  const overdueHeavy = share !== null && share.greaterThanOrEqualTo(OVERDUE_SHARE);
  if (!slowing && !overdueHeavy) return [];

  const everyOverdue = ctx.openInvoices !== undefined
    ? topOverdueOpen(ctx.openInvoices, config.invoiceTypes, asOf)
    : topOverdueFromRecords(ctx, config.invoiceTypes);
  const invoices = everyOverdue.slice(0, TOP_OVERDUE_LIMIT);
  const top3 = invoices.slice(0, 3).reduce((sum, r) => sum.plus(r.outstanding), new Decimal(0));
  /*
   * `top3_share` is the top three's share of the overdue INVOICES the sentence is about ("the top
   * three account for …"), not of the net overdue figure: credit notes reduce the net, so dividing by
   * it gave "the top three account for 133%" (ADR-123, audit F-10). Never above 100%.
   */
  const grossOverdue = everyOverdue.reduce((sum, r) => sum.plus(r.outstanding), new Decimal(0));

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
      label: invoice.label,
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
      // Signed as the figures are: a net-credit overdue balance is shown as the credit it is.
      overdue: overdue === null ? null : toMoneyString(overdue),
      total: toMoneyString(total),
      // The population the sentence and the share are about (ADR-124 D-5): open invoices, the
      // overdue part of them, and open credit notes stated on their own.
      overdue_invoices: population === null ? null : toMoneyString(population.overdue),
      open_invoices: population === null ? null : toMoneyString(population.open),
      open_credits: population === null ? null : toMoneyString(population.credits),
      share: share === null ? null : toRatioString(share),
      days_increase: slowedBy === null ? null : slowedBy.toDecimalPlaces(1).toString(),
      overdue_count: String(invoices.length),
      top3_share: grossOverdue.greaterThan(0) ? toRatioString(top3.dividedBy(grossOverdue)) : null,
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
