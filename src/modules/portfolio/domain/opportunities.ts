/**
 * Advisory opportunities (SOW §20, REQ-AD-10; ADR-148). Pure.
 *
 * The attention queue's mirror image: "which clients could I help do MORE?", answered from facts
 * MOTION already established — the client's latest complete Health Score breakdown, dimension by
 * dimension and rule by rule — in one fixed order. No model, no new figure, no estimate: every
 * opportunity names the scores and rule results that triggered it, and the same breakdown always
 * produces the same list.
 *
 * `opportunities.v1`. The six rules and their thresholds were chosen by the product owner on
 * 2026-10-06 from a proposal; the thresholds are proposals and can change (a version bump).
 */

import { Decimal, formatPercent, parseDecimalOrNull } from '@/core/money';
import { bandLabel, type HealthBand } from '@/modules/health';
import type { PortfolioHealth } from './types';

export const OPPORTUNITY_RULES_VERSION = 'opportunities.v1';

export const OPPORTUNITY_KINDS = [
  'ready_to_fund_growth', 'surplus_cash', 'campaigns_paying_back',
  'growing_on_thin_margins', 'collections', 'momentum',
] as const;
export type OpportunityKind = (typeof OPPORTUNITY_KINDS)[number];

/** Thresholds, declared once. */
export const OPPORTUNITY_THRESHOLDS = {
  surplusCashProfitability: 60,
  fundGrowthDimension: 70,
  thinMarginsGrowth: 65,
  thinMarginsProfitability: 50,
  collectionsDays: 60,
  collectionsOverdueShare: 0.3,
  momentumPoints: 10,
  campaignsMarketing: 70,
} as const;

/** One dimension of the latest breakdown, as `api.portfolio_health_breakdowns` returns it. */
export interface BreakdownDimension {
  readonly key: string;
  readonly included: boolean;
  readonly score: number | null;
  readonly rules: ReadonlyArray<{
    readonly rule: string; readonly points: number | null; readonly result: string | null;
    readonly value: string | null; readonly skipped: string | null;
  }>;
}

export interface ClientBreakdown {
  readonly organizationId: string;
  readonly healthScoreId: string;
  readonly periodLabel: string;
  readonly configVersion: string;
  readonly evidenceBundleId: string | null;
  readonly dimensions: readonly BreakdownDimension[];
}

export interface Opportunity {
  readonly kind: OpportunityKind;
  readonly title: string;
  /** The facts that triggered it, in words, each one a stored score or rule result. */
  readonly because: readonly string[];
  readonly suggestion: string;
}

export interface OpportunityEntry {
  readonly organizationId: string;
  readonly periodLabel: string;
  readonly healthScoreId: string;
  readonly evidenceBundleId: string | null;
  readonly opportunities: readonly Opportunity[];
}

const T = OPPORTUNITY_THRESHOLDS;

const NAMES: Readonly<Record<string, string>> = {
  profitability: 'Profitability', cash_flow: 'Cash', revenue_growth: 'Sales growth', cost_control: 'Costs',
  customer_quality: 'Customers', banking_health: 'Banking', marketing_efficiency: 'Marketing',
  funding_readiness: 'Funding readiness',
};

function dimension(b: ClientBreakdown, key: string): BreakdownDimension | null {
  const d = b.dimensions.find((x) => x.key === key);
  return d !== undefined && d.included && d.score !== null ? d : null;
}

function rule(d: BreakdownDimension | null, id: string) {
  const r = d?.rules.find((x) => x.rule === id);
  return r === undefined || r.skipped !== null ? null : r;
}

const scored = (d: BreakdownDimension) => `${NAMES[d.key] ?? d.key} scores ${d.score}`;

function bandRank(band: HealthBand): number {
  return ['at_risk', 'needs_attention', 'stable', 'strong'].indexOf(band);
}

/**
 * The opportunities in one client's latest month, in `OPPORTUNITY_KINDS` order. `health` is the
 * summary's view of the same month and the one before it — a previous month only when both were
 * scored under the same config (ADR-147), so momentum is never a rules change.
 */
export function opportunitiesFor(b: ClientBreakdown, health: PortfolioHealth | null): Opportunity[] {
  const out: Opportunity[] = [];
  const profitability = dimension(b, 'profitability');
  const cash = dimension(b, 'cash_flow');
  const growth = dimension(b, 'revenue_growth');
  const funding = dimension(b, 'funding_readiness');
  const marketing = dimension(b, 'marketing_efficiency');
  const band = health?.band ?? null;

  if (band !== null && (band === 'stable' || band === 'strong') && funding !== null && cash !== null
      && funding.score! >= T.fundGrowthDimension && cash.score! >= T.fundGrowthDimension) {
    out.push({
      kind: 'ready_to_fund_growth', title: 'Ready to fund growth',
      because: [`Health is ${bandLabel(band)}`, scored(funding), scored(cash)],
      suggestion: 'A conversation about expansion, investment or the funding that could support it.',
    });
  }

  const runway = rule(cash, 'C2');
  if (runway !== null && runway.result === '>= 6 months' && profitability !== null
      && profitability.score! >= T.surplusCashProfitability) {
    out.push({
      kind: 'surplus_cash', title: 'Surplus cash',
      because: ['Cash would last 6 months or more', scored(profitability)],
      suggestion: 'Review how surplus cash is used: repaying debt, a deposit, or investing in the business.',
    });
  }

  if (marketing !== null && marketing.score! >= T.campaignsMarketing) {
    const m1 = rule(marketing, 'M1');
    out.push({
      kind: 'campaigns_paying_back', title: 'Campaigns paying back',
      because: [scored(marketing), ...(m1?.result ? [`Customers won by campaigns brought in ${m1.result} what the campaigns cost`] : [])],
      suggestion: 'Consider more campaign spend where campaigns are winning customers.',
    });
  }

  if (growth !== null && profitability !== null
      && growth.score! >= T.thinMarginsGrowth && profitability.score! < T.thinMarginsProfitability) {
    out.push({
      kind: 'growing_on_thin_margins', title: 'Growing on thin margins',
      because: [scored(growth), scored(profitability)],
      suggestion: 'A pricing and cost review, so more of the growth is kept.',
    });
  }

  // Stored rule values are exact decimal strings; read them as Decimals (ADR-006).
  const asDecimal = (value: string | null): Decimal | null => {
    if (value === null || !/^-?\d+(\.\d+)?$/.test(value)) return null;
    return parseDecimalOrNull(value);
  };
  const days = asDecimal(rule(dimension(b, 'customer_quality'), 'Q3')?.value ?? null);
  const overdue = asDecimal(rule(funding, 'R3')?.value ?? null);
  const slowDays = days !== null && days.greaterThan(T.collectionsDays);
  const highOverdue = overdue !== null && overdue.greaterThanOrEqualTo(T.collectionsOverdueShare);
  if (slowDays || highOverdue) {
    out.push({
      kind: 'collections', title: 'Collections and working capital',
      because: [
        ...(slowDays ? [`Customers take about ${days!.toDecimalPlaces(0).toString()} days to pay`] : []),
        ...(highOverdue ? [`${formatPercent(overdue!)} of what customers owe is overdue`] : []),
      ],
      suggestion: 'Tighten collections — terms, reminders, chasing — to free up cash.',
    });
  }

  const previous = health?.previous ?? null;
  if (health !== null && health.score !== null && previous !== null && previous.score !== null) {
    const rose = health.score - previous.score;
    const bandRose = health.band !== null && previous.band !== null && bandRank(health.band) > bandRank(previous.band);
    if (rose >= T.momentumPoints || bandRose) {
      out.push({
        kind: 'momentum', title: 'Momentum',
        because: [bandRose
          ? `Health rose from ${bandLabel(previous.band)} to ${bandLabel(health.band)} since ${previous.periodLabel}`
          : `Health score rose ${rose} points since ${previous.periodLabel}`],
        suggestion: 'A review to understand what is working and keep it going.',
      });
    }
  }

  return out;
}

export function opportunityEntry(b: ClientBreakdown, health: PortfolioHealth | null): OpportunityEntry | null {
  const opportunities = opportunitiesFor(b, health);
  if (opportunities.length === 0) return null;
  return {
    organizationId: b.organizationId, periodLabel: b.periodLabel, healthScoreId: b.healthScoreId,
    evidenceBundleId: b.evidenceBundleId, opportunities,
  };
}
