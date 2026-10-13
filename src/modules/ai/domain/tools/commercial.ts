import { z } from 'zod';
import { loadMarketing, loadPeriodScope, loadProducts, loadSales, type PeriodScope } from '@/modules/dashboard';
import type { PeriodRef } from '../periods';
import { untrusted } from '../untrusted';
import { count, fail, money, noData, ok, ratio, resolvePeriodArg, subject } from './envelope';
import type { ToolCallContext, ToolDefinition, ToolOutcome } from './types';

/**
 * Tools 24–26 (AI_ARCHITECTURE.md §3; Phase 14, ADR-102): commercial intelligence, read through the
 * same services the Customers pages render. The model never attributes revenue to a campaign, never
 * computes an acquisition cost or a conversion rate, and never decides what a product cost — each
 * figure below is MOTION's, with its rule and its denominator stated, and each gap is reported as a
 * gap ("contribution unavailable", "no won opportunities") rather than filled.
 *
 * The organisation is `call.ctx.orgId`, resolved from the session; no tool takes one.
 */

const ref = (p: { id: string; label: string }): PeriodRef => ({ id: p.id, label: p.label });

type Scoped = { ok: true; scope: PeriodScope; period: PeriodRef } | { ok: false; outcome: ToolOutcome<never> };

/** Resolve the period label the model gave into the page scope the Customers services read. */
async function scopeFor(input: { period?: string }, call: ToolCallContext): Promise<Scoped> {
  const r = resolvePeriodArg(input.period, call);
  if (!r.ok) return { ok: false, outcome: fail(r.error) };
  const scope = await loadPeriodScope(call.ctx.db, call.ctx.orgId!, r.period.id, call.ctx.requestId);
  if (!scope) return { ok: false, outcome: noData('complete month') };
  return { ok: true, scope, period: r.period };
}

// -----------------------------------------------------------------------------------------------
// 24. get_product_contribution
// -----------------------------------------------------------------------------------------------
export const getProductContribution: ToolDefinition<{ period?: string; limit?: number }, unknown> = {
  name: 'get_product_contribution',
  description: 'Revenue by product or service for one month, from the invoice lines a person attributed, with cost and contribution only where a purchase invoice line names the product. Also reports how much of the month’s sales is not yet attributed to any product. Contribution is never estimated: where a product has no cost line the tool says "unavailable", and you report that.',
  permission: 'customers.view',
  input: z.object({ period: z.string().optional(), limit: z.number().int().min(1).max(50).optional() }),
  async run(input, call) {
    const s = await scopeFor(input, call); if (!s.ok) return s.outcome;
    const { ctx } = call;
    const view = await loadProducts(ctx.db, ctx.orgId!, ctx.orgSlug ?? '', s.scope, ctx.requestId);
    if (view.products.length === 0) return noData('product');
    const currency = view.currency;
    return ok({
      period: ref(s.period),
      rule: 'Revenue per product is the sum of invoice lines a person attributed to it; cost is the sum of purchase invoice lines naming it; contribution = revenue − cost only when at least one cost line exists.',
      products: view.products.slice(0, input.limit ?? 20).map((p) => ({
        product: { type: 'product', id: p.id, name: untrusted('name', p.name) },
        kind: p.kind,
        revenue: money(p.revenueRaw, currency),
        cost_recorded: p.cost !== null,
        contribution: p.contributionRaw === null ? null : money(p.contributionRaw, currency),
        contribution_status: p.contributionRaw === null ? 'unavailable' : 'available',
        contribution_note: p.contributionRaw === null ? p.note : null,
        invoices: count(p.invoices),
      })),
      not_attributed_to_any_product: view.unattributed
        ? { amount: money(view.unattributed.amountRaw, currency), invoices_without_lines: count(view.unattributed.invoicesWithoutLines), invoices: count(view.unattributed.invoices) }
        : null,
    }, { periods: [ref(s.period)], basis: 'invoices', calculation_run_id: null }, call);
  },
};

// -----------------------------------------------------------------------------------------------
// 25. get_campaign_performance
// -----------------------------------------------------------------------------------------------
export const getCampaignPerformance: ToolDefinition<{ period?: string; limit?: number }, unknown> = {
  name: 'get_campaign_performance',
  description: 'Marketing campaigns over the twelve months to a given month: spend a person recorded, customers won through the campaign (an opportunity marked won that names it), revenue credited (APX’s customer revenue for those customers from the month they were won), and cost per customer won = spend ÷ customers won. A campaign with no won opportunity has no revenue credited and no cost per customer — report that, never spread revenue across campaigns or channels.',
  permission: 'customers.view',
  input: z.object({ period: z.string().optional(), limit: z.number().int().min(1).max(50).optional() }),
  async run(input, call) {
    const s = await scopeFor(input, call); if (!s.ok) return s.outcome;
    const { ctx } = call;
    const view = await loadMarketing(ctx.db, ctx.orgId!, ctx.orgSlug ?? '', s.scope, ctx.requestId);
    if (view.campaigns.length === 0) return noData('campaign');
    const currency = view.currency;
    const periods = [ref(view.window.from), ref(view.window.to)];
    return ok({
      window: { from: ref(view.window.from), to: ref(view.window.to), months: count(view.window.months) },
      rule: view.note,
      campaigns: view.campaigns.slice(0, input.limit ?? 20).map((c) => ({
        campaign: { type: 'campaign', id: c.id, name: untrusted('name', c.name) },
        channel: c.channelName === null ? null : untrusted('channel', c.channelName),
        status: c.status,
        spend: money(c.spendRaw, currency),
        customers_won: count(c.customersWon),
        revenue_credited: c.attributionStatus === 'attributed_via_won_opportunities' ? money(c.attributedRevenueRaw, currency) : null,
        attribution_status: c.attributionStatus,
        attribution_note: c.attributionText,
        cost_per_customer_won: c.cac === null ? null : money(c.cacRaw ?? null, currency),
        cost_per_customer_note: c.cacNote,
      })),
      totals: { spend: money(view.totals.spendRaw, currency), customers_won: count(view.totals.customersWon), revenue_credited: money(view.totals.attributedRevenueRaw, currency) },
    }, { periods, basis: 'invoices', calculation_run_id: null }, call);
  },
};

// -----------------------------------------------------------------------------------------------
// 26. get_sales_pipeline
// -----------------------------------------------------------------------------------------------
export const getSalesPipeline: ToolDefinition<{ period?: string; limit?: number }, unknown> = {
  name: 'get_sales_pipeline',
  description: 'The sales pipeline as recorded: opportunities by stage with their estimated values (entered by a person, not forecasts), the open total, and conversion over the last three months with its cohort named — of opportunities created in the window, how many progressed past lead and how many were won. When there are no leads in the window the rates are null; report that rather than a rate.',
  permission: 'customers.view',
  input: z.object({ period: z.string().optional(), limit: z.number().int().min(1).max(50).optional() }),
  async run(input, call) {
    const s = await scopeFor(input, call); if (!s.ok) return s.outcome;
    const { ctx } = call;
    const view = await loadSales(ctx.db, ctx.orgId!, ctx.orgSlug ?? '', s.scope, ctx.requestId);
    if (view.total === 0) return noData('opportunity');
    const currency = view.currency;
    return ok({
      period: ref(s.period),
      stages: view.stages.map((st) => ({ stage: st.stage, label: st.label, opportunities: count(st.count), estimated_value: money(st.value, currency) })),
      open: { opportunities: count(view.openCount), estimated_value: money(view.openValueRaw, currency) },
      conversion: {
        window: { from: ref(view.conversionWindow.from), to: ref(view.conversionWindow.to) },
        cohort: 'opportunities created in the window',
        created: count(view.conversion.leadsCreated),
        progressed_past_lead: count(view.conversion.progressed),
        won_from_cohort: count(view.conversion.wonFromCohort),
        lost_from_cohort: count(view.conversion.lostFromCohort),
        lead_to_opportunity: view.conversion.leadToOpportunity === null ? null : ratio(view.conversion.leadToOpportunity),
        opportunity_to_customer: view.conversion.opportunityToCustomer === null ? null : ratio(view.conversion.opportunityToCustomer),
        notes: view.conversionNotes,
      },
      recent: view.opportunities.slice(0, input.limit ?? 10).map((o) => ({
        id: o.id, type: 'opportunity', name: untrusted('name', o.name), stage: o.stage,
        customer: o.customerId ? subject('counterparty', o.customerId, o.customer) : null,
        campaign: o.campaign === null ? null : untrusted('campaign', o.campaign),
        estimated_value: o.valueRaw === null ? null : money(o.valueRaw, currency),
        created_on: o.createdOn, won_on: o.wonOn,
      })),
    }, { periods: [ref(s.period)], basis: 'invoices', calculation_run_id: null }, call);
  },
};
