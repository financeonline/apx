/**
 * Marketing efficiency (health.config.v5, weight 8; ADR-147; SOW §11 "CAC, revenue/contribution per
 * acquisition where available").
 *
 * From the Commercial records, under ADR-102's rules and no others:
 *
 *   - a customer belongs to a campaign only through a WON opportunity naming both, and to the
 *     EARLIEST such campaign only (no double counting);
 *   - revenue reaches campaigns only from customers they won, and only from the month of the win —
 *     the engine's own `customer_revenue`, never an estimate;
 *   - acquisition cost is recorded campaign spend over customers won through campaigns in the same
 *     window — never marketing spend over all customers.
 *
 * Over the three months ending in the scored month (`MARKETING_WINDOW_MONTHS`). A business that
 * recorded no campaign spend in that window is EXCLUDED (`no_campaign_data`): having no campaigns is
 * not inefficiency. The dimension is capped like any other when the revenue it reads is estimated.
 *
 * The thresholds are PROPOSED, not approved (CD-19; see config).
 *
 * Pure.
 */

import { Decimal } from '@/core/money';
import { MARKETING_EFFICIENCY_RULES as R, MARKETING_WINDOW_MONTHS } from '../config';
import { applyRule, skippedRule, trailingPeriodIds } from '../apply';
import { sentence } from '../sentences';
import type { DimensionEvaluation } from '../dimension';
import type { FactorSentence, HealthInput, MetricReference, RuleApplication } from '../types';

type Opportunity = NonNullable<HealthInput['commercial']>['opportunities'][number];

/** First win per customer, through a campaign; the earliest win counts, ties by id (ADR-102). */
function firstWins(opportunities: readonly Opportunity[]): Array<{ counterpartyId: string; wonOn: string }> {
  const won = opportunities
    .filter((o): o is Opportunity & { counterpartyId: string; campaignId: string; wonOn: string } =>
      o.stage === 'won' && o.counterpartyId !== null && o.campaignId !== null && o.wonOn !== null)
    .sort((a, b) => (a.wonOn < b.wonOn ? -1 : a.wonOn > b.wonOn ? 1 : a.id < b.id ? -1 : 1));
  const first = new Map<string, string>();
  for (const o of won) if (!first.has(o.counterpartyId)) first.set(o.counterpartyId, o.wonOn);
  return [...first.entries()].map(([counterpartyId, wonOn]) => ({ counterpartyId, wonOn }));
}

interface Window { readonly periodIds: readonly string[]; readonly from: string; readonly to: string }

function windowEnding(input: HealthInput, periodId: string): Window | null {
  const periodIds = trailingPeriodIds(input.periodIds, periodId, MARKETING_WINDOW_MONTHS);
  if (periodIds.length < MARKETING_WINDOW_MONTHS) return null;
  const from = input.periodStarts?.get(periodIds[0]!);
  const to = input.periodEnds?.get(periodId);
  return from === undefined || to === undefined ? null : { periodIds, from, to };
}

function spendIn(input: HealthInput, window: Window): Decimal {
  const inWindow = new Set(window.periodIds);
  return (input.commercial?.spend ?? [])
    .filter((s) => inWindow.has(s.periodId))
    .reduce((sum, s) => sum.plus(s.amount), new Decimal(0));
}

export function evaluateMarketingEfficiency(input: HealthInput): DimensionEvaluation {
  const { snapshots, periodId, currency } = input;
  const positives: FactorSentence[] = [];
  const negatives: FactorSentence[] = [];
  const metrics: MetricReference[] = [];
  const base = {
    key: 'marketing_efficiency' as const, conditions: [], requirements: [], coverageSatisfied: null,
  };

  const window = windowEnding(input, periodId);
  const spend = window === null ? new Decimal(0) : spendIn(input, window);
  if (window === null || input.commercial === undefined || !spend.greaterThan(0)) {
    return { ...base, unavailable: 'no_campaign_data', rules: [], metrics, positives, negatives };
  }

  const wins = firstWins(input.commercial.opportunities);
  // Revenue in the window from every customer campaigns ever won, from the month of the win on.
  const starts = input.periodStarts!;
  let revenue = new Decimal(0);
  for (const p of window.periodIds) {
    const start = starts.get(p)!;
    for (const win of wins) {
      if (start < `${win.wonOn.slice(0, 7)}-01`) continue;
      const observation = snapshots.find((s) => s.periodId === p && s.metricKey === 'customer_revenue'
        && s.dimensionType === 'counterparty' && s.dimensionId === win.counterpartyId);
      if (observation?.value != null) {
        revenue = revenue.plus(observation.value);
        if (observation.snapshotId !== null) metrics.push({ metric_key: 'customer_revenue', value: observation.value, snapshot_id: observation.snapshotId });
      }
    }
  }

  // M1 — what campaign-won customers brought in, against what the campaigns cost.
  const multiple = revenue.dividedBy(spend);
  const m1 = applyRule(R.M1, multiple);
  const shownMultiple = multiple.toDecimalPlaces(1).toString();
  if (wins.length === 0) {
    negatives.push(sentence('campaigns_won_nobody', { spend: spend.toFixed(2) }, currency));
  } else if (m1.points > 0) {
    positives.push(sentence('campaigns_pay_back', { multiple: shownMultiple }, currency));
  } else if (m1.points < 0) {
    negatives.push(sentence('campaigns_below_cost', { multiple: shownMultiple }, currency));
  }

  // M2 — the cost of each customer won, against the three months before.
  const wonIn = (w: Window) => wins.filter((x) => x.wonOn >= w.from && x.wonOn <= w.to).length;
  const prior = (() => {
    const index = input.periodIds.indexOf(periodId);
    const priorEnd = index - MARKETING_WINDOW_MONTHS >= 0 ? input.periodIds[index - MARKETING_WINDOW_MONTHS] : undefined;
    return priorEnd === undefined ? null : windowEnding(input, priorEnd);
  })();
  const wonNow = wonIn(window);
  let m2: RuleApplication;
  if (wonNow === 0) {
    m2 = skippedRule(R.M2.rule, 'no_customers_won');
  } else {
    const priorSpend = prior === null ? new Decimal(0) : spendIn(input, prior);
    const wonBefore = prior === null ? 0 : wonIn(prior);
    if (prior === null || !priorSpend.greaterThan(0) || wonBefore === 0) {
      m2 = skippedRule(R.M2.rule, 'no_prior_window');
    } else {
      const cac = spend.dividedBy(wonNow);
      const cacBefore = priorSpend.dividedBy(wonBefore);
      const change = cac.minus(cacBefore).dividedBy(cacBefore);
      m2 = applyRule(R.M2, change);
      if (m2.points > 0) positives.push(sentence('cac_fell', { pct: change.abs().toString() }, currency));
      else if (m2.points < 0) negatives.push(sentence('cac_rose', { pct: change.abs().toString() }, currency));
    }
  }

  return {
    ...base,
    rules: [m1, m2],
    metrics,
    // The cap reads the organisation's own revenue figures for the window: customer revenue is a
    // breakdown of them, so an estimated revenue makes this an estimate too.
    scoredInputs: window.periodIds.map((p) => ({ periodId: p, metricKey: 'revenue' })),
    positives,
    negatives,
  };
}
