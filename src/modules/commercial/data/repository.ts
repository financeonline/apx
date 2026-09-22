import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { callApi } from '@/core/db';
import { Decimal } from '@/core/money';
import { toMotionError } from '@/core/errors';
import type {
  Campaign, CampaignSpend, InvoiceLine, MarketingChannel, OpportunityRow, Product, ProductPeriodSummary,
} from '../domain/types';

/** Commercial reads, on the caller's client so RLS applies (ADR-013). Every query is org-scoped. */

function unwrap<T>(data: T[] | null, error: unknown, requestId?: string): T[] {
  if (error) throw toMotionError(error, requestId);
  return data ?? [];
}

export async function listProducts(db: SupabaseClient, orgId: string, requestId?: string): Promise<Product[]> {
  const { data, error } = await db.from('products').select('id, name, kind, code, is_active, notes')
    .eq('organization_id', orgId).order('name');
  return unwrap(data, error, requestId).map((r) => ({
    id: r.id, name: r.name, kind: r.kind, code: r.code, isActive: r.is_active, notes: r.notes,
  }));
}

export async function listChannels(db: SupabaseClient, orgId: string, requestId?: string): Promise<MarketingChannel[]> {
  const { data, error } = await db.from('marketing_channels').select('id, name, is_active')
    .eq('organization_id', orgId).order('name');
  return unwrap(data, error, requestId).map((r) => ({ id: r.id, name: r.name, isActive: r.is_active }));
}

export async function listCampaigns(db: SupabaseClient, orgId: string, requestId?: string): Promise<Campaign[]> {
  const { data, error } = await db.from('campaigns').select('id, name, channel_id, starts_on, ends_on, status, notes')
    .eq('organization_id', orgId).order('name');
  return unwrap(data, error, requestId).map((r) => ({
    id: r.id, name: r.name, channelId: r.channel_id, startsOn: r.starts_on, endsOn: r.ends_on, status: r.status, notes: r.notes,
  }));
}

export async function listCampaignSpend(
  db: SupabaseClient, orgId: string, filter: { readonly periodIds?: readonly string[]; readonly campaignId?: string }, requestId?: string,
): Promise<CampaignSpend[]> {
  let query = db.from('campaign_spend').select('id, campaign_id, period_id, amount, currency, note').eq('organization_id', orgId);
  if (filter.periodIds) query = query.in('period_id', [...filter.periodIds]);
  if (filter.campaignId) query = query.eq('campaign_id', filter.campaignId);
  const { data, error } = await query.order('period_id');
  return unwrap(data, error, requestId).map((r) => ({
    id: r.id, campaignId: r.campaign_id, periodId: r.period_id, amount: String(r.amount), currency: r.currency, note: r.note,
  }));
}

/**
 * Bounded: the pipeline is hundreds of rows, not thousands; the page and the tools cap further.
 *
 * The customer is returned as the SURVIVING counterparty. Merging is a pointer, not a rewrite
 * (`api.merge_counterparties`), and the engine keys `customer_revenue` by the survivor — so an
 * opportunity still naming the merged-away row would match no revenue, and the campaign that won
 * that customer would silently lose its attribution the day somebody tidied a duplicate (ADR-103).
 * Both ids are returned: the survivor is what every figure is keyed by, the recorded one is what
 * the row actually says.
 */
export async function listOpportunities(
  db: SupabaseClient, orgId: string, filter: { readonly campaignId?: string; readonly counterpartyId?: string } = {}, requestId?: string,
): Promise<OpportunityRow[]> {
  let query = db.from('opportunities')
    .select(`id, name, stage, counterparty_id, campaign_id, channel_id, estimated_value,
             created_on, stage_changed_on, won_on, lost_on,
             counterparties!opportunities_counterparty_fk(merged_into_id)`)
    .eq('organization_id', orgId);
  if (filter.campaignId) query = query.eq('campaign_id', filter.campaignId);
  if (filter.counterpartyId) {
    /*
     * Asking for a customer's opportunities means the customer as they are NOW: the rows merged
     * into them name the old id, and filtering on the survivor alone would drop the history the
     * merge was supposed to consolidate (ADR-103).
     */
    const { data: merged, error: mergedError } = await db.from('counterparties')
      .select('id').eq('organization_id', orgId).eq('merged_into_id', filter.counterpartyId);
    const ids = [filter.counterpartyId, ...unwrap(merged, mergedError, requestId).map((c) => c.id as string)];
    query = query.in('counterparty_id', ids);
  }
  const { data, error } = await query.order('created_on', { ascending: false }).order('id').limit(2000);
  return unwrap(data, error, requestId).map((r) => {
    // PostgREST types a to-one embed as an array; the FK is single-valued, so at most one row.
    const linked = ([] as Array<{ merged_into_id: string | null }>)
      .concat((r.counterparties ?? []) as Array<{ merged_into_id: string | null }>)[0] ?? null;
    return {
      id: r.id, name: r.name, stage: r.stage,
      counterpartyId: linked?.merged_into_id ?? r.counterparty_id,
      recordedCounterpartyId: r.counterparty_id,
      campaignId: r.campaign_id,
      channelId: r.channel_id, estimatedValue: r.estimated_value === null ? null : String(r.estimated_value),
      createdOn: r.created_on, stageChangedOn: r.stage_changed_on, wonOn: r.won_on, lostOn: r.lost_on,
    };
  });
}

export async function listInvoiceLines(
  db: SupabaseClient, orgId: string, invoiceIds: readonly string[], requestId?: string,
): Promise<InvoiceLine[]> {
  if (invoiceIds.length === 0) return [];
  const { data, error } = await db.from('invoice_lines').select('id, invoice_id, product_id, description, quantity, amount, sort_order')
    .eq('organization_id', orgId).in('invoice_id', [...invoiceIds]).order('sort_order');
  return unwrap(data, error, requestId).map((r) => ({
    id: r.id, invoiceId: r.invoice_id, productId: r.product_id, description: r.description,
    quantity: r.quantity === null ? null : String(r.quantity), amount: String(r.amount), sortOrder: r.sort_order,
  }));
}

/**
 * The net (ex-tax) amount of each invoice, by the same rule the engine and `api.set_invoice_lines`
 * apply: `subtotal`, else `total − tax`, else `total`. What the line-split form shows as the ceiling.
 */
export async function listInvoiceNets(
  db: SupabaseClient, orgId: string, invoiceIds: readonly string[], requestId?: string,
): Promise<ReadonlyMap<string, string>> {
  if (invoiceIds.length === 0) return new Map();
  const { data, error } = await db.from('invoices').select('id, subtotal, tax_amount, total_amount')
    .eq('organization_id', orgId).in('id', [...invoiceIds]);
  return new Map(unwrap(data, error, requestId).map((r) => {
    const total = new Decimal(String(r.total_amount));
    const subtotal = r.subtotal === null ? null : new Decimal(String(r.subtotal));
    const net = subtotal !== null && !(subtotal.isZero() && total.greaterThan(0)) ? subtotal
      : r.tax_amount !== null ? total.minus(new Decimal(String(r.tax_amount))) : total;
    return [r.id as string, net.toFixed(2)];
  }));
}

export async function productPeriodSummary(
  db: SupabaseClient, orgId: string, periodIds: readonly string[], requestId?: string,
): Promise<ProductPeriodSummary> {
  if (periodIds.length === 0) return { products: [], unattributed: [], customer_mix: [] };
  return callApi<ProductPeriodSummary>(db, 'product_period_summary', { p_org: orgId, p_period_ids: [...periodIds] }, requestId);
}

export interface ProductLineRow {
  readonly lineId: string;
  readonly invoiceId: string;
  readonly amount: string;
  readonly quantity: string | null;
  readonly description: string | null;
  readonly invoiceNumber: string;
  readonly invoiceType: 'sales' | 'purchase' | 'sales_credit_note' | 'purchase_credit_note';
  readonly issueDate: string;
  readonly periodId: string;
  readonly counterpartyId: string;
  readonly counted: boolean;
}

/** The lines naming one product, with the invoice each sits on — the rows behind a product figure. */
export async function listLinesForProduct(
  db: SupabaseClient, orgId: string, productId: string, limit = 200, requestId?: string,
): Promise<ProductLineRow[]> {
  const { data, error } = await db
    .from('invoice_lines')
    .select('id, invoice_id, amount, quantity, description, invoices!invoice_lines_invoice_fk(invoice_number, invoice_type, issue_date, period_id, counterparty_id, record_status, superseded_by, status)')
    .eq('organization_id', orgId)
    .eq('product_id', productId)
    .order('created_at', { ascending: false })
    .limit(limit);
  return unwrap(data, error, requestId).map((r) => {
    const inv = (Array.isArray(r.invoices) ? r.invoices[0] : r.invoices) as {
      invoice_number: string; invoice_type: ProductLineRow['invoiceType']; issue_date: string; period_id: string;
      counterparty_id: string; record_status: string; superseded_by: string | null; status: string;
    };
    return {
      lineId: r.id, invoiceId: r.invoice_id, amount: String(r.amount),
      quantity: r.quantity === null ? null : String(r.quantity), description: r.description,
      invoiceNumber: inv.invoice_number, invoiceType: inv.invoice_type, issueDate: inv.issue_date, periodId: inv.period_id,
      counterpartyId: inv.counterparty_id,
      counted: inv.record_status === 'accepted' && inv.superseded_by === null && inv.status !== 'void',
    };
  });
}
