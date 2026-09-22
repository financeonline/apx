import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { Decimal, formatMoney, formatPercent } from '@/core/money';
import {
  type ConcentrationPoint,
  acquisitionCost, attributeCampaignRevenue, concentrationTrend, conversion, listCampaignSpend,
  listCampaigns, listChannels, listInvoiceLines, listInvoiceNets, listLinesForProduct, listOpportunities, listProducts,
  pipelineByStage, productContribution, productPeriodSummary, salesByPeriod, wonCustomers,
  type AcquisitionCost, type Campaign, type CampaignAttribution, type Conversion, type MarketingChannel,
  type OpportunityRow, type OpportunityStage, type Product, type ProductContribution, type ProductPeriodSummary,
  type SalesPeriodPoint, type StageSummary,
} from '@/modules/commercial';
import { listCounterparties, listInvoices, type Counterparty } from '@/modules/financials';
import { varianceKey } from '@/modules/financial-engine';
import type { MetricCardView, PeriodLabel, SnapshotRow } from '../domain/view-models';
import * as repo from '../data/repository';
import { dimensionKeyOf, toFigure, type PeriodScope } from './money';

/**
 * Commercial Intelligence view models (Phase 14, ADR-102; REQ-CI-01…12; UX brief §20–24).
 *
 * Two sources and no third: figures the engine computed (`metric_current`: revenue, customer
 * revenue/share/contribution, concentration) and rows a person recorded (products, lines, campaigns,
 * spend, opportunities), combined by the pure rules in `modules/commercial`. Where a rule cannot
 * answer, the view carries the reason in words, and the page prints it instead of a number.
 */

// ---------------------------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------------------------

export const STAGE_LABELS: Readonly<Record<OpportunityStage, string>> = {
  lead: 'Lead', qualified: 'Qualified', proposal: 'Proposal', won: 'Won', lost: 'Lost',
};

export const CONTRIBUTION_UNAVAILABLE = 'Contribution unavailable — cost data is insufficient.';
export const CUSTOMER_CONTRIBUTION_NOTE =
  'Contribution is revenue less directly attributable costs. No cost has been attributed to a customer yet, so this equals revenue; shared overheads are never allocated.';
export const ATTRIBUTION_NOTE =
  'Revenue is credited to a campaign only through an opportunity marked won for a customer, from the month it was won. Nothing is assumed from timing alone.';

const ATTRIBUTION_STATUS_TEXT = {
  attributed_via_won_opportunities: 'Attributed through won opportunities',
  no_won_opportunities: 'No revenue attributed — no opportunity has been won through this campaign',
} as const;

const CAC_REASON_TEXT = {
  no_spend_recorded: 'No spend recorded, so acquisition cost cannot be worked out.',
  no_customers_won: 'No customer was won through this campaign in the period, so acquisition cost cannot be worked out.',
} as const;

const CONVERSION_REASON_TEXT = {
  no_leads_in_window: 'No leads were created in this window.',
  no_opportunities_in_window: 'No lead in this window has moved past the lead stage yet.',
} as const;

const money = (value: string, currency: string, signed = false) =>
  formatMoney(value, { currency, showMinorUnits: false, ...(signed ? { signDisplay: 'always' as const } : {}) });
const pct = (ratio: string | null) => (ratio === null ? null : formatPercent(ratio));

// ---------------------------------------------------------------------------------------------
// Shared loaders
// ---------------------------------------------------------------------------------------------

/** Trailing months of the scope, oldest first (the scope lists newest first). */
function trailing(scope: PeriodScope, months: number): PeriodLabel[] {
  return [...scope.periods.filter((p) => p.periodStart <= scope.period.periodStart).slice(0, months)].reverse();
}

const windowOf = (periods: readonly PeriodLabel[]) => ({
  periodIds: periods.map((p) => p.id),
  from: periods[0]?.periodStart ?? '0000-01-01',
  to: periods[periods.length - 1]?.periodEnd ?? '9999-12-31',
});

async function baseCurrency(db: SupabaseClient, orgId: string): Promise<string> {
  const { data } = await db.from('organizations').select('base_currency').eq('id', orgId).maybeSingle();
  return ((data as { base_currency?: string } | null)?.base_currency) ?? 'GBP';
}

/** `customer_revenue` per period per counterparty, from `metric_current`. */
async function customerRevenueByPeriod(
  db: SupabaseClient, orgId: string, periodIds: readonly string[], requestId?: string,
): Promise<{ rows: SnapshotRow[]; byPeriod: Map<string, Map<string, string>> }> {
  const rows = await repo.loadDimensioned(db, orgId, 'customer_revenue', periodIds, requestId);
  const byPeriod = new Map<string, Map<string, string>>();
  for (const r of rows) {
    const key = dimensionKeyOf(r);
    if (!key || r.value === null) continue;
    if (!byPeriod.has(r.periodId)) byPeriod.set(r.periodId, new Map());
    byPeriod.get(r.periodId)!.set(key, r.value);
  }
  return { rows, byPeriod };
}

// ---------------------------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------------------------

export interface ProductRowView {
  readonly id: string;
  readonly name: string;
  readonly kind: Product['kind'];
  readonly code: string | null;
  readonly isActive: boolean;
  readonly revenue: string;
  readonly revenueRaw: string;
  readonly cost: string | null;
  readonly contribution: string | null;
  readonly contributionRaw: string | null;
  readonly margin: string | null;
  readonly note: string | null;
  readonly invoices: number;
  readonly href: string;
}

export interface ProductsView {
  readonly scope: PeriodScope;
  readonly currency: string;
  readonly products: readonly ProductRowView[];
  /** Sales revenue in the month no line attributes to any product. */
  readonly unattributed: { readonly amount: string; readonly amountRaw: string; readonly invoicesWithoutLines: number; readonly invoices: number } | null;
}

function figuresFor(summary: ProductPeriodSummary, productId: string, periodIds: readonly string[]) {
  const mine = summary.products.filter((p) => p.product_id === productId && periodIds.includes(p.period_id));
  const sum = (key: 'sales' | 'cost') => mine.reduce((acc, p) => acc.plus(p[key]), new Decimal(0)).toFixed(2);
  return {
    sales: sum('sales'), cost: sum('cost'),
    salesLines: mine.reduce((acc, p) => acc + p.sales_lines, 0),
    costLines: mine.reduce((acc, p) => acc + p.cost_lines, 0),
    invoices: mine.reduce((acc, p) => acc + p.invoices, 0),
  };
}

function productRow(orgSlug: string, product: Product, figures: ReturnType<typeof figuresFor>, currency: string): ProductRowView {
  const c: ProductContribution = productContribution(figures);
  return {
    id: product.id, name: product.name, kind: product.kind, code: product.code, isActive: product.isActive,
    revenue: money(c.revenue, currency), revenueRaw: c.revenue,
    cost: c.cost === null ? null : money(c.cost, currency),
    contribution: c.contribution === null ? null : money(c.contribution, currency, true),
    contributionRaw: c.contribution,
    margin: pct(c.marginRatio),
    note: c.reason === 'no_cost_lines' ? CONTRIBUTION_UNAVAILABLE
      : c.reason === 'no_sales_lines' ? 'No sales have been attributed to this yet.' : null,
    invoices: figures.invoices,
    href: `/app/${orgSlug}/customers/products/${product.id}`,
  };
}

export async function loadProducts(
  db: SupabaseClient, orgId: string, orgSlug: string, scope: PeriodScope, requestId?: string,
): Promise<ProductsView> {
  const [products, summary, currency] = await Promise.all([
    listProducts(db, orgId, requestId),
    productPeriodSummary(db, orgId, [scope.period.id], requestId),
    baseCurrency(db, orgId),
  ]);
  const rows = products
    .map((p) => productRow(orgSlug, p, figuresFor(summary, p.id, [scope.period.id]), currency))
    .sort((a, b) => new Decimal(b.revenueRaw).comparedTo(new Decimal(a.revenueRaw)) || a.name.localeCompare(b.name));
  const u = summary.unattributed.find((x) => x.period_id === scope.period.id);
  const unattributedRaw = u ? new Decimal(u.sales_net).minus(u.attributed).toFixed(2) : null;
  return {
    scope, currency, products: rows,
    unattributed: u && unattributedRaw ? { amount: money(unattributedRaw, currency), amountRaw: unattributedRaw, invoicesWithoutLines: u.invoices_without_lines, invoices: u.invoices } : null,
  };
}

export interface ProductDetailView {
  readonly scope: PeriodScope;
  readonly currency: string;
  readonly product: Product;
  readonly thisMonth: ProductRowView;
  readonly trend: ReadonlyArray<{ periodId: string; label: string; revenue: string; contribution: string | null }>;
  readonly customers: ReadonlyArray<{ counterpartyId: string | null; name: string; href: string | null; revenue: string; share: string | null }>;
  readonly lines: ReadonlyArray<{ invoiceId: string; number: string; date: string; customer: string; amount: string; kind: 'sale' | 'cost'; counted: boolean; recordHref: string }>;
}

export const PRODUCT_TREND_MONTHS = 12;

export async function loadProductDetail(
  db: SupabaseClient, orgId: string, orgSlug: string, scope: PeriodScope, productId: string, requestId?: string,
): Promise<ProductDetailView | null> {
  const products = await listProducts(db, orgId, requestId);
  const product = products.find((p) => p.id === productId);
  if (!product) return null; // RLS returned nothing: the uniform 404 (§8.4)
  const window = trailing(scope, PRODUCT_TREND_MONTHS);
  const [summary, currency, counterparties, lines] = await Promise.all([
    productPeriodSummary(db, orgId, window.map((p) => p.id), requestId),
    baseCurrency(db, orgId),
    listCounterparties(db, orgId, { limit: 500, offset: 0 }, requestId),
    listLinesForProduct(db, orgId, productId, 200, requestId),
  ]);
  const names = new Map(counterparties.map((c) => [c.id, c.name]));
  const mix = summary.customer_mix.filter((m) => m.product_id === productId);
  const mixTotal = mix.reduce((acc, m) => acc.plus(m.sales), new Decimal(0));
  return {
    scope, currency, product,
    thisMonth: productRow(orgSlug, product, figuresFor(summary, productId, [scope.period.id]), currency),
    trend: window.map((p) => {
      const c = productContribution(figuresFor(summary, productId, [p.id]));
      return { periodId: p.id, label: p.label, revenue: money(c.revenue, currency), contribution: c.contribution === null ? null : money(c.contribution, currency, true) };
    }),
    customers: [...mix]
      .sort((a, b) => new Decimal(b.sales).comparedTo(new Decimal(a.sales)))
      .map((m) => ({
        counterpartyId: m.counterparty_id,
        name: m.counterparty_id ? names.get(m.counterparty_id) ?? 'Unknown customer' : 'Unattributed',
        href: m.counterparty_id ? `/app/${orgSlug}/customers/${m.counterparty_id}` : null,
        revenue: money(m.sales, currency),
        share: mixTotal.greaterThan(0) ? formatPercent(new Decimal(m.sales).dividedBy(mixTotal).toFixed(6)) : null,
      })),
    lines: lines.map((l) => ({
      invoiceId: l.invoiceId, number: l.invoiceNumber, date: l.issueDate,
      customer: names.get(l.counterpartyId) ?? 'Unknown',
      amount: money(l.amount, currency),
      kind: l.invoiceType === 'purchase' || l.invoiceType === 'purchase_credit_note' ? 'cost' : 'sale',
      counted: l.counted,
      recordHref: `/app/${orgSlug}/evidence/record/invoice/${l.invoiceId}`,
    })),
  };
}

// ---------------------------------------------------------------------------------------------
// Marketing
// ---------------------------------------------------------------------------------------------

export interface CampaignRowView {
  readonly id: string;
  readonly name: string;
  readonly channelName: string | null;
  readonly status: Campaign['status'];
  readonly spend: string;
  readonly spendRaw: string;
  readonly customersWon: number;
  readonly attributedRevenue: string;
  readonly attributedRevenueRaw: string;
  readonly attributionStatus: CampaignAttribution['status'];
  readonly attributionText: string;
  readonly cac: string | null;
  readonly cacRaw: string | null;
  readonly cacNote: string | null;
  /** attributed revenue − spend (no direct costs are attributable today; stated on the page). */
  readonly contribution: string | null;
  readonly href: string;
}

export interface MarketingView {
  readonly scope: PeriodScope;
  readonly currency: string;
  /** The window every campaign figure below is measured over. */
  readonly window: { readonly from: PeriodLabel; readonly to: PeriodLabel; readonly months: number };
  readonly channels: readonly MarketingChannel[];
  readonly campaigns: readonly CampaignRowView[];
  readonly totals: { readonly spend: string; readonly spendRaw: string; readonly attributedRevenue: string; readonly attributedRevenueRaw: string; readonly customersWon: number };
  readonly note: string;
}

export const MARKETING_WINDOW_MONTHS = 12;

async function campaignRows(
  db: SupabaseClient, orgId: string, orgSlug: string, scope: PeriodScope, requestId?: string,
): Promise<{ rows: CampaignRowView[]; window: PeriodLabel[]; channels: MarketingChannel[]; campaigns: Campaign[]; opportunities: OpportunityRow[]; currency: string; revenueRows: SnapshotRow[] }> {
  const window = trailing(scope, MARKETING_WINDOW_MONTHS);
  const [campaigns, channels, spend, opportunities, currency, revenue] = await Promise.all([
    listCampaigns(db, orgId, requestId),
    listChannels(db, orgId, requestId),
    listCampaignSpend(db, orgId, { periodIds: window.map((p) => p.id) }, requestId),
    listOpportunities(db, orgId, {}, requestId),
    baseCurrency(db, orgId),
    customerRevenueByPeriod(db, orgId, window.map((p) => p.id), requestId),
  ]);
  const ids = campaigns.map((c) => c.id);
  const attribution = attributeCampaignRevenue({ campaignIds: ids, opportunities, periods: window, customerRevenue: revenue.byPeriod });
  const cac = acquisitionCost({ campaignIds: ids, spend, opportunities, window: windowOf(window) });
  const channelName = new Map(channels.map((c) => [c.id, c.name]));
  const rows = campaigns.map((c) => {
    const a = attribution.find((x) => x.campaignId === c.id)!;
    const k: AcquisitionCost = cac.find((x) => x.campaignId === c.id)!;
    const contribution = a.status === 'attributed_via_won_opportunities' || !new Decimal(k.spend).isZero()
      ? new Decimal(a.revenue).minus(k.spend).toFixed(2) : null;
    return {
      id: c.id, name: c.name, channelName: c.channelId ? channelName.get(c.channelId) ?? null : null, status: c.status,
      spend: money(k.spend, currency), spendRaw: k.spend,
      customersWon: a.customers.length,
      attributedRevenue: money(a.revenue, currency), attributedRevenueRaw: a.revenue,
      attributionStatus: a.status, attributionText: ATTRIBUTION_STATUS_TEXT[a.status],
      cac: k.cac === null ? null : money(k.cac, currency), cacRaw: k.cac,
      cacNote: k.reason === null ? null : CAC_REASON_TEXT[k.reason],
      contribution: contribution === null ? null : money(contribution, currency, true),
      href: `/app/${orgSlug}/customers/marketing/${c.id}`,
    };
  }).sort((a, b) => new Decimal(b.attributedRevenueRaw).comparedTo(new Decimal(a.attributedRevenueRaw)) || a.name.localeCompare(b.name));
  return { rows, window, channels, campaigns, opportunities, currency, revenueRows: revenue.rows };
}

export async function loadMarketing(
  db: SupabaseClient, orgId: string, orgSlug: string, scope: PeriodScope, requestId?: string,
): Promise<MarketingView> {
  const { rows, window, channels, currency } = await campaignRows(db, orgId, orgSlug, scope, requestId);
  const sum = (key: 'spendRaw' | 'attributedRevenueRaw') => rows.reduce((acc, r) => acc.plus(r[key]), new Decimal(0)).toFixed(2);
  return {
    scope, currency,
    window: { from: window[0] ?? scope.period, to: window[window.length - 1] ?? scope.period, months: window.length },
    channels, campaigns: rows,
    totals: { spend: money(sum('spendRaw'), currency), spendRaw: sum('spendRaw'), attributedRevenue: money(sum('attributedRevenueRaw'), currency), attributedRevenueRaw: sum('attributedRevenueRaw'), customersWon: rows.reduce((a, r) => a + r.customersWon, 0) },
    note: ATTRIBUTION_NOTE,
  };
}

export interface CampaignDetailView {
  readonly scope: PeriodScope;
  readonly currency: string;
  readonly campaign: Campaign;
  readonly channelName: string | null;
  readonly row: CampaignRowView;
  readonly window: MarketingView['window'];
  readonly spendByPeriod: ReadonlyArray<{ periodId: string; label: string; amount: string; attributed: string }>;
  readonly customers: ReadonlyArray<{ counterpartyId: string; name: string; wonOn: string; href: string }>;
  readonly conversion: Conversion;
  /** The two rates as percentages, or null where the cohort is empty. */
  readonly conversionRates: { readonly leadToOpportunity: string | null; readonly opportunityToCustomer: string | null };
  readonly conversionNotes: readonly string[];
  readonly opportunities: ReadonlyArray<{ id: string; name: string; stage: OpportunityStage; stageLabel: string; customer: string | null; value: string | null; createdOn: string }>;
  readonly periods: readonly PeriodLabel[];
}

export async function loadCampaignDetail(
  db: SupabaseClient, orgId: string, orgSlug: string, scope: PeriodScope, campaignId: string, requestId?: string,
): Promise<CampaignDetailView | null> {
  const { rows, window, channels, campaigns, opportunities, currency, revenueRows } = await campaignRows(db, orgId, orgSlug, scope, requestId);
  const campaign = campaigns.find((c) => c.id === campaignId);
  const row = rows.find((r) => r.id === campaignId);
  if (!campaign || !row) return null;
  const [spend, counterparties] = await Promise.all([
    listCampaignSpend(db, orgId, { campaignId, periodIds: window.map((p) => p.id) }, requestId),
    listCounterparties(db, orgId, { limit: 500, offset: 0 }, requestId),
  ]);
  const names = new Map(counterparties.map((c) => [c.id, c.name]));
  const byPeriod = new Map<string, Map<string, string>>();
  for (const r of revenueRows) {
    const key = dimensionKeyOf(r); if (!key || r.value === null) continue;
    if (!byPeriod.has(r.periodId)) byPeriod.set(r.periodId, new Map());
    byPeriod.get(r.periodId)!.set(key, r.value);
  }
  const [attribution] = attributeCampaignRevenue({ campaignIds: [campaignId], opportunities, periods: window, customerRevenue: byPeriod });
  const mine = opportunities.filter((o) => o.campaignId === campaignId);
  const conv = conversion(mine, { from: windowOf(window).from, to: windowOf(window).to });
  return {
    scope, currency, campaign,
    channelName: campaign.channelId ? channels.find((c) => c.id === campaign.channelId)?.name ?? null : null,
    row,
    window: { from: window[0] ?? scope.period, to: window[window.length - 1] ?? scope.period, months: window.length },
    spendByPeriod: window.map((p) => ({
      periodId: p.id, label: p.label,
      amount: money(spend.find((s) => s.periodId === p.id)?.amount ?? '0', currency),
      attributed: money(attribution!.revenueByPeriod.get(p.id) ?? '0', currency),
    })),
    customers: attribution!.customers.map((c) => ({
      counterpartyId: c.counterpartyId, name: names.get(c.counterpartyId) ?? 'Unknown customer', wonOn: c.wonOn,
      href: `/app/${orgSlug}/customers/${c.counterpartyId}`,
    })),
    conversion: conv,
    conversionRates: { leadToOpportunity: pct(conv.leadToOpportunity), opportunityToCustomer: pct(conv.opportunityToCustomer) },
    conversionNotes: conv.reasons.map((r) => CONVERSION_REASON_TEXT[r]),
    opportunities: mine.map((o) => ({
      id: o.id, name: o.name, stage: o.stage, stageLabel: STAGE_LABELS[o.stage],
      customer: o.counterpartyId ? names.get(o.counterpartyId) ?? null : null,
      value: o.estimatedValue === null ? null : money(o.estimatedValue, currency), createdOn: o.createdOn,
    })),
    periods: window,
  };
}

// ---------------------------------------------------------------------------------------------
// Sales
// ---------------------------------------------------------------------------------------------

export interface SalesView {
  readonly scope: PeriodScope;
  readonly currency: string;
  readonly stages: ReadonlyArray<StageSummary & { label: string; valueText: string }>;
  readonly openValue: string;
  readonly openValueRaw: string;
  readonly openCount: number;
  readonly conversion: Conversion;
  readonly conversionRates: { readonly leadToOpportunity: string | null; readonly opportunityToCustomer: string | null };
  readonly conversionNotes: readonly string[];
  readonly conversionWindow: { readonly from: PeriodLabel; readonly to: PeriodLabel };
  readonly byPeriod: ReadonlyArray<SalesPeriodPoint & { wonValueText: string; revenue: string | null }>;
  readonly opportunities: ReadonlyArray<{ id: string; name: string; stage: OpportunityStage; stageLabel: string; customer: string | null; customerId: string | null; campaign: string | null; value: string | null; valueRaw: string | null; createdOn: string; wonOn: string | null }>;
  readonly customers: ReadonlyArray<{ id: string; name: string }>;
  readonly campaigns: ReadonlyArray<{ id: string; name: string }>;
  readonly channels: readonly MarketingChannel[];
  readonly total: number;
}

export const SALES_WINDOW_MONTHS = 3;
export const SALES_LIST_LIMIT = 100;

export async function loadSales(
  db: SupabaseClient, orgId: string, orgSlug: string, scope: PeriodScope, requestId?: string,
): Promise<SalesView> {
  void orgSlug;
  const window = trailing(scope, SALES_WINDOW_MONTHS);
  const twelve = trailing(scope, 12);
  const [opportunities, counterparties, campaigns, channels, currency, snapshots] = await Promise.all([
    listOpportunities(db, orgId, {}, requestId),
    listCounterparties(db, orgId, { limit: 500, offset: 0 }, requestId),
    listCampaigns(db, orgId, requestId),
    listChannels(db, orgId, requestId),
    baseCurrency(db, orgId),
    repo.loadMetricSeries(db, orgId, ['revenue'], twelve.map((p) => p.id), requestId),
  ]);
  const names = new Map(counterparties.map((c) => [c.id, c.name]));
  const campaignNames = new Map(campaigns.map((c) => [c.id, c.name]));
  const stages = pipelineByStage(opportunities);
  const open = stages.filter((s) => s.stage === 'lead' || s.stage === 'qualified' || s.stage === 'proposal');
  const conv = conversion(opportunities, { from: windowOf(window).from, to: windowOf(window).to });
  const openValueRaw = open.reduce((acc, s) => acc.plus(s.value), new Decimal(0)).toFixed(2);
  return {
    scope, currency,
    stages: stages.map((s) => ({ ...s, label: STAGE_LABELS[s.stage], valueText: money(s.value, currency) })),
    openValue: money(openValueRaw, currency), openValueRaw,
    openCount: open.reduce((acc, s) => acc + s.count, 0),
    conversion: conv,
    conversionRates: { leadToOpportunity: pct(conv.leadToOpportunity), opportunityToCustomer: pct(conv.opportunityToCustomer) },
    conversionNotes: conv.reasons.map((r) => CONVERSION_REASON_TEXT[r]),
    conversionWindow: { from: window[0] ?? scope.period, to: window[window.length - 1] ?? scope.period },
    byPeriod: salesByPeriod(opportunities, twelve).map((p) => {
      const rev = snapshots.find((s) => s.periodId === p.periodId && s.metricKey === 'revenue' && s.dimensionType === 'none');
      return { ...p, wonValueText: money(p.wonValue, currency), revenue: rev && rev.value !== null ? money(rev.value, currency) : null };
    }),
    opportunities: opportunities.slice(0, SALES_LIST_LIMIT).map((o) => ({
      id: o.id, name: o.name, stage: o.stage, stageLabel: STAGE_LABELS[o.stage],
      customer: o.counterpartyId ? names.get(o.counterpartyId) ?? null : null, customerId: o.counterpartyId,
      campaign: o.campaignId ? campaignNames.get(o.campaignId) ?? null : null,
      value: o.estimatedValue === null ? null : money(o.estimatedValue, currency), valueRaw: o.estimatedValue, createdOn: o.createdOn, wonOn: o.wonOn,
    })),
    customers: counterparties.filter((c) => c.mergedIntoId === null && c.isActive).map((c) => ({ id: c.id, name: c.name })),
    campaigns: campaigns.map((c) => ({ id: c.id, name: c.name })),
    channels,
    total: opportunities.length,
  };
}

// ---------------------------------------------------------------------------------------------
// Overview and customer extension
// ---------------------------------------------------------------------------------------------

export interface CommercialOverview {
  readonly scope: PeriodScope;
  readonly currency: string;
  readonly revenue: MetricCardView | null;
  readonly concentration: readonly MetricCardView[];
  readonly concentrationTrend: ReadonlyArray<ConcentrationPoint & { readonly top5Text: string | null }>;
  /** Real customers only, biggest first. The unattributed remainder is `unattributedRevenue`. */
  readonly topCustomers: ReadonlyArray<{ id: string; name: string; href: string; revenue: string; share: string | null; whyHref: string | null }>;
  readonly topProducts: readonly ProductRowView[];
  readonly unattributedProducts: ProductsView['unattributed'];
  readonly topCampaigns: readonly CampaignRowView[];
  readonly pipeline: { readonly openCount: number; readonly openValue: string; readonly wonThisMonth: number; readonly conversionNote: string | null; readonly leadToOpportunity: string | null; readonly opportunityToCustomer: string | null };
  readonly counts: { readonly products: number; readonly campaigns: number; readonly opportunities: number; readonly customers: number };
  readonly customerContributionNote: string;
  /**
   * Revenue the engine could not attribute to any customer — a data-quality state, NOT a customer
   * (ADR-103). It is reported beside the ranking, never inside it.
   */
  readonly unattributedRevenue: { readonly amount: string; readonly share: string | null } | null;
}

export async function loadCommercialOverview(
  db: SupabaseClient, orgId: string, orgSlug: string, scope: PeriodScope, requestId?: string,
): Promise<CommercialOverview> {
  const twelve = trailing(scope, 12);
  const [headline, shares, revenueRows, products, marketing, sales, counterparties, concSeries] = await Promise.all([
    repo.loadPeriodSnapshots(db, orgId, scope.period.id, requestId),
    repo.loadDimensioned(db, orgId, 'customer_revenue_share', [scope.period.id], requestId),
    repo.loadDimensioned(db, orgId, 'customer_revenue', [scope.period.id], requestId),
    loadProducts(db, orgId, orgSlug, scope, requestId),
    loadMarketing(db, orgId, orgSlug, scope, requestId),
    loadSales(db, orgId, orgSlug, scope, requestId),
    listCounterparties(db, orgId, { limit: 500, offset: 0 }, requestId),
    repo.loadMetricSeries(db, orgId, ['customer_concentration_top1', 'customer_concentration_top5'], twelve.map((p) => p.id), requestId),
  ]);
  const byKey = new Map(headline.filter((r) => r.dimensionType === 'none').map((r) => [r.metricKey, r]));
  const options = { orgSlug, comparisonLabel: scope.previous?.label ?? 'the previous month' };
  const figure = (key: string) => { const row = byKey.get(key); return row ? toFigure(row, scope.period, byKey.get(varianceKey(key, 'prev_period')) ?? null, options) : null; };
  const names = new Map(counterparties.map((c) => [c.id, c.name]));
  const shareOf = new Map(shares.map((s) => [dimensionKeyOf(s) ?? '', s]));
  /*
   * The engine writes a synthetic `dimension_id = NULL` row so that Σ customer_revenue +
   * unattributed = revenue (§3.5). It is the revenue nobody could attribute — not a customer, and
   * never a rank in a list of them (ADR-103). It leaves the ranking here and is reported on its own
   * below, so the gap stays visible without pretending to be a business.
   */
  const attributedRows = revenueRows.filter((r) => r.value !== null && dimensionKeyOf(r) !== null);
  const unattributedRow = revenueRows.find((r) => dimensionKeyOf(r) === null && r.value !== null) ?? null;
  const topCustomers = [...attributedRows]
    .sort((a, b) => new Decimal(b.value!).comparedTo(new Decimal(a.value!)))
    .slice(0, 5)
    .map((r) => {
      const id = dimensionKeyOf(r)!;
      const share = shareOf.get(id);
      return {
        id, name: names.get(id) ?? 'Unknown customer',
        href: `/app/${orgSlug}/customers/${id}`,
        revenue: money(r.value!, products.currency),
        share: share && share.value !== null ? formatPercent(share.value) : null,
        whyHref: toFigure(r, scope.period, null, options).whyHref,
      };
    });
  const unattributedShare = unattributedRow === null ? undefined : shareOf.get('');
  const unattributedRevenue = unattributedRow === null || new Decimal(unattributedRow.value!).isZero()
    ? null
    : {
      amount: money(unattributedRow.value!, products.currency),
      share: unattributedShare && unattributedShare.value !== null ? formatPercent(unattributedShare.value) : null,
    };
  const shareSeries = new Map<string, { top1: string | null; top5: string | null }>();
  for (const p of twelve) {
    shareSeries.set(p.id, {
      top1: concSeries.find((s) => s.periodId === p.id && s.metricKey === 'customer_concentration_top1')?.value ?? null,
      top5: concSeries.find((s) => s.periodId === p.id && s.metricKey === 'customer_concentration_top5')?.value ?? null,
    });
  }
  return {
    scope, currency: products.currency,
    revenue: figure('revenue'),
    concentration: ['customer_concentration_top1', 'customer_concentration_top5'].map(figure).filter((f): f is MetricCardView => f !== null),
    concentrationTrend: concentrationTrend(twelve, shareSeries).map((p) => ({ ...p, top5Text: pct(p.top5) })),
    topCustomers,
    topProducts: products.products.slice(0, 5),
    unattributedProducts: products.unattributed,
    topCampaigns: marketing.campaigns.slice(0, 5),
    pipeline: {
      openCount: sales.openCount, openValue: sales.openValue,
      wonThisMonth: sales.byPeriod.find((p) => p.periodId === scope.period.id)?.won ?? 0,
      conversionNote: sales.conversionNotes[0] ?? null,
      leadToOpportunity: pct(sales.conversion.leadToOpportunity),
      opportunityToCustomer: pct(sales.conversion.opportunityToCustomer),
    },
    counts: { products: products.products.length, campaigns: marketing.campaigns.length, opportunities: sales.total, customers: counterparties.filter((c) => c.kind === 'customer' || c.kind === 'both').length },
    customerContributionNote: CUSTOMER_CONTRIBUTION_NOTE,
    unattributedRevenue,
  };
}

export interface CustomerCommercialView {
  readonly contribution: MetricCardView | null;
  readonly contributionNote: string;
  readonly products: ReadonlyArray<{ productId: string; name: string; href: string; revenue: string; share: string | null }>;
  readonly wonThrough: ReadonlyArray<{ campaignId: string; name: string; wonOn: string; href: string }>;
  readonly opportunities: ReadonlyArray<{ id: string; name: string; stageLabel: string; value: string | null }>;
  readonly invoiceLines: ReadonlyMap<string, ReadonlyArray<{ id: string; productId: string | null; productName: string | null; amount: string; amountRaw: string; description: string | null }>>;
  readonly productOptions: ReadonlyArray<{ id: string; name: string }>;
  /** Net (ex-tax) amount per invoice — the ceiling a line split may reach. */
  readonly invoiceNets: ReadonlyMap<string, string>;
}

/** What Commercial adds to the customer page: contribution, product mix, how they were won, line splits. */
export async function loadCustomerCommercial(
  db: SupabaseClient, orgId: string, orgSlug: string, scope: PeriodScope, counterparty: Counterparty, invoiceIds: readonly string[], requestId?: string,
): Promise<CustomerCommercialView> {
  const window = trailing(scope, 12);
  const [contributionRows, summary, products, opportunities, campaigns, lines, invoiceNets, currency] = await Promise.all([
    repo.loadDimensioned(db, orgId, 'customer_contribution', [scope.period.id], requestId),
    productPeriodSummary(db, orgId, window.map((p) => p.id), requestId),
    listProducts(db, orgId, requestId),
    listOpportunities(db, orgId, { counterpartyId: counterparty.id }, requestId),
    listCampaigns(db, orgId, requestId),
    listInvoiceLines(db, orgId, invoiceIds, requestId),
    listInvoiceNets(db, orgId, invoiceIds, requestId),
    baseCurrency(db, orgId),
  ]);
  const options = { orgSlug, comparisonLabel: scope.previous?.label ?? 'the previous month' };
  /*
   * Every engine figure and every commercial aggregation is keyed by the SURVIVING counterparty
   * (ADR-103): a merged row's revenue, product mix and win path live under the customer it was
   * merged into, and looking them up by the merged-away id would show an empty page.
   */
  const survivorId = counterparty.mergedIntoId ?? counterparty.id;
  const contribution = contributionRows.find((r) => dimensionKeyOf(r) === survivorId) ?? null;
  const productName = new Map(products.map((p) => [p.id, p.name]));
  const mine = summary.customer_mix.filter((m) => m.counterparty_id === survivorId);
  const total = mine.reduce((acc, m) => acc.plus(m.sales), new Decimal(0));
  const won = wonCustomers(opportunities).filter((w) => w.counterpartyId === survivorId);
  const byInvoice = new Map<string, Array<{ id: string; productId: string | null; productName: string | null; amount: string; amountRaw: string; description: string | null }>>();
  for (const l of lines) {
    if (!byInvoice.has(l.invoiceId)) byInvoice.set(l.invoiceId, []);
    byInvoice.get(l.invoiceId)!.push({ id: l.id, productId: l.productId, productName: l.productId ? productName.get(l.productId) ?? null : null, amount: money(l.amount, currency), amountRaw: l.amount, description: l.description });
  }
  return {
    contribution: contribution ? toFigure(contribution, scope.period, null, options) : null,
    contributionNote: CUSTOMER_CONTRIBUTION_NOTE,
    products: [...mine].sort((a, b) => new Decimal(b.sales).comparedTo(new Decimal(a.sales))).map((m) => ({
      productId: m.product_id, name: productName.get(m.product_id) ?? 'Unknown', href: `/app/${orgSlug}/customers/products/${m.product_id}`,
      revenue: money(m.sales, currency), share: total.greaterThan(0) ? formatPercent(new Decimal(m.sales).dividedBy(total).toFixed(6)) : null,
    })),
    wonThrough: won.map((w) => ({ campaignId: w.campaignId, name: campaigns.find((c) => c.id === w.campaignId)?.name ?? 'Unknown campaign', wonOn: w.wonOn, href: `/app/${orgSlug}/customers/marketing/${w.campaignId}` })),
    opportunities: opportunities.map((o) => ({ id: o.id, name: o.name, stageLabel: STAGE_LABELS[o.stage], value: o.estimatedValue === null ? null : money(o.estimatedValue, currency) })),
    invoiceLines: byInvoice,
    productOptions: products.filter((p) => p.isActive).map((p) => ({ id: p.id, name: p.name })),
    invoiceNets,
  };
}

export { listInvoices };
