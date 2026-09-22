/**
 * Commercial Intelligence rules (Phase 14, ADR-102; SOW §16; CD-08).
 *
 * Pure. Every function below turns rows a person recorded (products, lines, campaigns, spend,
 * opportunities) and figures the engine computed (customer revenue per period) into a stated,
 * deterministic result — or into a stated reason why there is none. Nothing here estimates,
 * allocates or infers:
 *
 *  - product revenue and cost come ONLY from invoice lines; a product with no purchase lines has
 *    no cost and therefore no contribution — "unavailable", never "zero";
 *  - revenue is attributed to a campaign ONLY through a WON opportunity that names the customer and
 *    the campaign, from the month it was won, and a customer won through two campaigns is counted
 *    for the earliest win only (no double counting);
 *  - CAC divides recorded campaign spend by customers WON through that campaign in the same window
 *    — never marketing spend by all customers;
 *  - conversion names its cohort and its denominators, and a zero denominator yields null with a
 *    reason, not a division.
 *
 * Money is a string, never a number (ADR-006).
 */
import { Decimal } from '@/core/money';

export type OpportunityStage = 'lead' | 'qualified' | 'proposal' | 'won' | 'lost';
export const OPPORTUNITY_STAGES: readonly OpportunityStage[] = ['lead', 'qualified', 'proposal', 'won', 'lost'];
export const OPEN_STAGES: readonly OpportunityStage[] = ['lead', 'qualified', 'proposal'];

export interface OpportunityRow {
  readonly id: string;
  readonly name: string;
  readonly stage: OpportunityStage;
  /** The SURVIVING counterparty: what every engine figure is keyed by, merges followed (ADR-103). */
  readonly counterpartyId: string | null;
  /** The counterparty the row itself names, before a merge was followed. */
  readonly recordedCounterpartyId?: string | null;
  readonly campaignId: string | null;
  readonly channelId: string | null;
  readonly estimatedValue: string | null;
  readonly createdOn: string;
  readonly stageChangedOn: string;
  readonly wonOn: string | null;
  readonly lostOn: string | null;
}

export interface PeriodRef {
  readonly id: string;
  readonly label: string;
  readonly periodStart: string;
  readonly periodEnd: string;
}

const ZERO = new Decimal(0);
const money = (d: Decimal): string => d.toFixed(2);
const ratio = (num: Decimal, den: Decimal): string | null => (den.isZero() ? null : num.dividedBy(den).toFixed(6));
const byId = <T extends { readonly id: string }>(a: T, b: T): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The calendar month a date falls in, as `YYYY-MM-01` — what a period starts on. */
export function monthOf(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

// -----------------------------------------------------------------------------------------------
// Products
// -----------------------------------------------------------------------------------------------

export interface ProductFigures {
  /** Net sales attributed by lines, credit notes subtracted. */
  readonly sales: string;
  /** Net cost attributed by purchase lines. */
  readonly cost: string;
  readonly salesLines: number;
  readonly costLines: number;
}

export type ContributionReason = 'no_cost_lines' | 'no_sales_lines';

export interface ProductContribution {
  readonly revenue: string;
  readonly cost: string | null;
  readonly contribution: string | null;
  readonly marginRatio: string | null;
  readonly reason: ContributionReason | null;
}

/**
 * Contribution = attributed revenue − attributed cost, ONLY when at least one purchase line names
 * the product. A product nobody has recorded a cost against has an unknown cost, not a zero one.
 */
export function productContribution(figures: ProductFigures): ProductContribution {
  const revenue = new Decimal(figures.sales);
  if (figures.salesLines === 0) {
    return { revenue: money(revenue), cost: null, contribution: null, marginRatio: null, reason: 'no_sales_lines' };
  }
  if (figures.costLines === 0) {
    return { revenue: money(revenue), cost: null, contribution: null, marginRatio: null, reason: 'no_cost_lines' };
  }
  const cost = new Decimal(figures.cost);
  const contribution = revenue.minus(cost);
  return {
    revenue: money(revenue),
    cost: money(cost),
    contribution: money(contribution),
    marginRatio: revenue.greaterThan(0) ? ratio(contribution, revenue) : null,
    reason: null,
  };
}

// -----------------------------------------------------------------------------------------------
// Campaign attribution
// -----------------------------------------------------------------------------------------------

export interface WonCustomer {
  readonly counterpartyId: string;
  readonly campaignId: string;
  readonly wonOn: string;
  readonly opportunityId: string;
}

/**
 * The customers each campaign won: one row per (customer, campaign), dated by the EARLIEST win, and
 * a customer won through several campaigns belongs to the earliest of them only. Deterministic in
 * any input order.
 */
export function wonCustomers(opportunities: readonly OpportunityRow[]): WonCustomer[] {
  const won = [...opportunities]
    .filter((o): o is OpportunityRow & { counterpartyId: string; campaignId: string; wonOn: string } =>
      o.stage === 'won' && o.counterpartyId !== null && o.campaignId !== null && o.wonOn !== null)
    .sort((a, b) => (a.wonOn < b.wonOn ? -1 : a.wonOn > b.wonOn ? 1 : byId(a, b)));
  const first = new Map<string, WonCustomer>();
  for (const o of won) {
    if (!first.has(o.counterpartyId)) {
      first.set(o.counterpartyId, { counterpartyId: o.counterpartyId, campaignId: o.campaignId, wonOn: o.wonOn, opportunityId: o.id });
    }
  }
  return [...first.values()].sort((a, b) => (a.counterpartyId < b.counterpartyId ? -1 : 1));
}

export type AttributionStatus = 'attributed_via_won_opportunities' | 'no_won_opportunities';

export interface CampaignAttribution {
  readonly campaignId: string;
  readonly status: AttributionStatus;
  readonly customers: readonly WonCustomer[];
  /** Σ `customer_revenue` of the won customers, in periods starting on or after the won month. */
  readonly revenueByPeriod: ReadonlyMap<string, string>;
  readonly revenue: string;
}

/**
 * Revenue a campaign can be credited with: the engine's `customer_revenue` for the customers it won,
 * from the month each was won. Revenue from a customer before their win is NOT the campaign's, and
 * revenue from customers with no won opportunity is nobody's.
 */
export function attributeCampaignRevenue(input: {
  readonly campaignIds: readonly string[];
  readonly opportunities: readonly OpportunityRow[];
  readonly periods: readonly PeriodRef[];
  /** `customer_revenue` per period per counterparty (money strings), from `metric_current`. */
  readonly customerRevenue: ReadonlyMap<string, ReadonlyMap<string, string>>;
}): CampaignAttribution[] {
  const won = wonCustomers(input.opportunities);
  return [...input.campaignIds].sort().map((campaignId) => {
    const customers = won.filter((w) => w.campaignId === campaignId);
    const revenueByPeriod = new Map<string, string>();
    let total = ZERO;
    for (const period of [...input.periods].sort((a, b) => (a.periodStart < b.periodStart ? -1 : 1))) {
      let sum = ZERO;
      const inPeriod = input.customerRevenue.get(period.id);
      for (const c of customers) {
        if (period.periodStart < monthOf(c.wonOn)) continue;
        const value = inPeriod?.get(c.counterpartyId);
        if (value !== undefined) sum = sum.plus(value);
      }
      revenueByPeriod.set(period.id, money(sum));
      total = total.plus(sum);
    }
    return {
      campaignId,
      status: customers.length === 0 ? 'no_won_opportunities' : 'attributed_via_won_opportunities',
      customers,
      revenueByPeriod,
      revenue: money(total),
    };
  });
}

// -----------------------------------------------------------------------------------------------
// Acquisition cost
// -----------------------------------------------------------------------------------------------

export type CacReason = 'no_spend_recorded' | 'no_customers_won';

export interface AcquisitionCost {
  readonly campaignId: string;
  readonly spend: string;
  readonly customersWon: number;
  readonly cac: string | null;
  readonly reason: CacReason | null;
}

/**
 * CAC for one campaign over one window = Σ spend recorded for the campaign in the window's periods ÷
 * customers first won through the campaign with a `won_on` inside the window. Both halves are
 * scoped to the same campaign and window; a zero of either yields null with the reason.
 */
export function acquisitionCost(input: {
  readonly campaignIds: readonly string[];
  readonly spend: ReadonlyArray<{ campaignId: string; periodId: string; amount: string }>;
  readonly opportunities: readonly OpportunityRow[];
  readonly window: { readonly periodIds: readonly string[]; readonly from: string; readonly to: string };
}): AcquisitionCost[] {
  const won = wonCustomers(input.opportunities);
  const inWindow = new Set(input.window.periodIds);
  return [...input.campaignIds].sort().map((campaignId) => {
    const spend = input.spend
      .filter((s) => s.campaignId === campaignId && inWindow.has(s.periodId))
      .reduce((acc, s) => acc.plus(s.amount), ZERO);
    const customersWon = won.filter((w) => w.campaignId === campaignId && w.wonOn >= input.window.from && w.wonOn <= input.window.to).length;
    const reason: CacReason | null = spend.isZero() ? 'no_spend_recorded' : customersWon === 0 ? 'no_customers_won' : null;
    return {
      campaignId,
      spend: money(spend),
      customersWon,
      cac: reason === null ? money(spend.dividedBy(customersWon)) : null,
      reason,
    };
  });
}

// -----------------------------------------------------------------------------------------------
// Conversion and the pipeline
// -----------------------------------------------------------------------------------------------

export interface Conversion {
  /** Opportunities created in the window (every one starts as a lead). */
  readonly leadsCreated: number;
  /** Of those, how many have left the lead stage (qualified, proposal, won — not lost, not still a lead). */
  readonly progressed: number;
  /** Of those created in the window, how many are won. */
  readonly wonFromCohort: number;
  readonly lostFromCohort: number;
  /** Won in the window, whenever created. */
  readonly wonInWindow: number;
  readonly leadToOpportunity: string | null;
  readonly opportunityToCustomer: string | null;
  readonly reasons: readonly ('no_leads_in_window' | 'no_opportunities_in_window')[];
}

export function conversion(opportunities: readonly OpportunityRow[], window: { from: string; to: string }): Conversion {
  const cohort = opportunities.filter((o) => o.createdOn >= window.from && o.createdOn <= window.to);
  const progressedRows = cohort.filter((o) => o.stage === 'qualified' || o.stage === 'proposal' || o.stage === 'won');
  const wonFromCohort = cohort.filter((o) => o.stage === 'won').length;
  const lostFromCohort = cohort.filter((o) => o.stage === 'lost').length;
  const wonInWindow = opportunities.filter((o) => o.stage === 'won' && o.wonOn !== null && o.wonOn >= window.from && o.wonOn <= window.to).length;
  const reasons: Array<Conversion['reasons'][number]> = [];
  if (cohort.length === 0) reasons.push('no_leads_in_window');
  else if (progressedRows.length === 0) reasons.push('no_opportunities_in_window');
  return {
    leadsCreated: cohort.length,
    progressed: progressedRows.length,
    wonFromCohort,
    lostFromCohort,
    wonInWindow,
    leadToOpportunity: ratio(new Decimal(progressedRows.length), new Decimal(cohort.length)),
    opportunityToCustomer: ratio(new Decimal(wonFromCohort), new Decimal(progressedRows.length)),
    reasons,
  };
}

export interface StageSummary {
  readonly stage: OpportunityStage;
  readonly count: number;
  readonly value: string;
  readonly valued: number;
}

/** The pipeline as it stands: count and stated value per stage (unvalued opportunities counted, not summed). */
export function pipelineByStage(opportunities: readonly OpportunityRow[]): StageSummary[] {
  return OPPORTUNITY_STAGES.map((stage) => {
    const rows = opportunities.filter((o) => o.stage === stage);
    const valued = rows.filter((o) => o.estimatedValue !== null);
    return {
      stage,
      count: rows.length,
      value: money(valued.reduce((acc, o) => acc.plus(o.estimatedValue!), ZERO)),
      valued: valued.length,
    };
  });
}

export interface SalesPeriodPoint {
  readonly periodId: string;
  readonly label: string;
  readonly created: number;
  readonly won: number;
  readonly wonValue: string;
  readonly lost: number;
}

/** Sales activity per period: created, won (by won date, stated value), lost. */
export function salesByPeriod(opportunities: readonly OpportunityRow[], periods: readonly PeriodRef[]): SalesPeriodPoint[] {
  return [...periods].sort((a, b) => (a.periodStart < b.periodStart ? -1 : 1)).map((p) => {
    const within = (d: string | null) => d !== null && d >= p.periodStart && d <= p.periodEnd;
    const won = opportunities.filter((o) => o.stage === 'won' && within(o.wonOn));
    return {
      periodId: p.id,
      label: p.label,
      created: opportunities.filter((o) => within(o.createdOn)).length,
      won: won.length,
      wonValue: money(won.reduce((acc, o) => acc.plus(o.estimatedValue ?? '0'), ZERO)),
      lost: opportunities.filter((o) => o.stage === 'lost' && within(o.lostOn)).length,
    };
  });
}

// -----------------------------------------------------------------------------------------------
// Concentration, measured not judged
// -----------------------------------------------------------------------------------------------

export interface ConcentrationPoint {
  readonly periodId: string;
  readonly label: string;
  readonly top1: string | null;
  readonly top5: string | null;
}

/** The trend of the engine's shares over periods — the measurement, for the reader to interpret. */
export function concentrationTrend(
  periods: readonly PeriodRef[],
  shares: ReadonlyMap<string, { top1: string | null; top5: string | null }>,
): ConcentrationPoint[] {
  return [...periods].sort((a, b) => (a.periodStart < b.periodStart ? -1 : 1)).map((p) => ({
    periodId: p.id,
    label: p.label,
    top1: shares.get(p.id)?.top1 ?? null,
    top5: shares.get(p.id)?.top5 ?? null,
  }));
}
