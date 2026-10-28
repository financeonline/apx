import 'server-only';
import { callApi } from '@/core/db';
import { Decimal } from '@/core/money';
import type { Db } from '@/db/types';
import { readRows, readRowsByIds } from '@/db/app/financials-reads';
import type {
  Campaign, CampaignSpend, InvoiceLine, MarketingChannel, OpportunityRow, Product, ProductPeriodSummary,
} from '../domain/types';

/**
 * Commercial reads, made as the caller (`readRows`: the table's policy for a person, the job's own
 * organisation for a job — ADR-013). Every read names one organisation. Name orders follow the
 * database's en_US collation, applied here (Firestore orders by code unit).
 */

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const byName = new Intl.Collator('en-US', { sensitivity: 'variant' }).compare;
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const named = (rows: Row[]): Row[] => rows.sort((a, b) => byName(a.name, b.name));

export async function listProducts(db: Db, orgId: string, requestId?: string): Promise<Product[]> {
  void requestId;
  return named(await readRows<Row>(db, orgId, 'products')).map((r) => ({
    id: r.id, name: r.name, kind: r.kind, code: r.code ?? null, isActive: r.is_active, notes: r.notes ?? null,
  }));
}

export async function listChannels(db: Db, orgId: string, requestId?: string): Promise<MarketingChannel[]> {
  void requestId;
  return named(await readRows<Row>(db, orgId, 'marketing_channels')).map((r) => ({ id: r.id, name: r.name, isActive: r.is_active }));
}

export async function listCampaigns(db: Db, orgId: string, requestId?: string): Promise<Campaign[]> {
  void requestId;
  return named(await readRows<Row>(db, orgId, 'campaigns')).map((r) => ({
    id: r.id, name: r.name, channelId: r.channel_id ?? null, startsOn: r.starts_on ?? null, endsOn: r.ends_on ?? null,
    status: r.status, notes: r.notes ?? null,
  }));
}

export async function listCampaignSpend(
  db: Db, orgId: string, filter: { readonly periodIds?: readonly string[]; readonly campaignId?: string }, requestId?: string,
): Promise<CampaignSpend[]> {
  void requestId;
  const where = (q: FirebaseFirestore.Query) => (filter.campaignId ? q.where('campaign_id', '==', filter.campaignId) : q);
  let rows: Row[];
  if (filter.periodIds) {
    const ids = [...new Set(filter.periodIds)];
    rows = [];
    for (let i = 0; i < ids.length; i += 30) {
      rows.push(...await readRows<Row>(db, orgId, 'campaign_spend', (q) => where(q.where('period_id', 'in', ids.slice(i, i + 30)))));
    }
  } else {
    rows = await readRows<Row>(db, orgId, 'campaign_spend', where);
  }
  rows.sort((a, b) => byText(a.period_id, b.period_id));
  return rows.map((r) => ({
    id: r.id, campaignId: r.campaign_id, periodId: r.period_id, amount: String(r.amount), currency: r.currency, note: r.note ?? null,
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
  db: Db, orgId: string, filter: { readonly campaignId?: string; readonly counterpartyId?: string } = {}, requestId?: string,
): Promise<OpportunityRow[]> {
  void requestId;
  let ids: string[] | null = null;
  if (filter.counterpartyId) {
    /*
     * Asking for a customer's opportunities means the customer as they are NOW: the rows merged
     * into them name the old id, and filtering on the survivor alone would drop the history the
     * merge was supposed to consolidate (ADR-103).
     */
    const merged = await readRows<Row>(db, orgId, 'counterparties', (q) => q.where('merged_into_id', '==', filter.counterpartyId));
    ids = [filter.counterpartyId, ...merged.map((c) => c.id as string)];
  }
  const campaign = (q: FirebaseFirestore.Query) => (filter.campaignId ? q.where('campaign_id', '==', filter.campaignId) : q);
  let rows: Row[] = [];
  if (ids) {
    for (let i = 0; i < ids.length; i += 30) {
      rows.push(...await readRows<Row>(db, orgId, 'opportunities', (q) => campaign(q.where('counterparty_id', 'in', ids!.slice(i, i + 30)))));
    }
  } else {
    rows = await readRows<Row>(db, orgId, 'opportunities', campaign);
  }
  rows.sort((a, b) => byText(String(b.created_on), String(a.created_on)) || byText(a.id, b.id));
  rows = rows.slice(0, 2000);
  // The embedded `counterparties(merged_into_id)`, as a second read joined here.
  const linked = new Map((await readRowsByIds<Row>(db, orgId, 'counterparties',
    rows.map((r) => r.counterparty_id).filter((id): id is string => typeof id === 'string')))
    .map((c) => [c.id as string, (c.merged_into_id as string | null | undefined) ?? null]));
  return rows.map((r) => {
    const survivor = r.counterparty_id ? linked.get(r.counterparty_id) ?? null : null;
    return {
      id: r.id, name: r.name, stage: r.stage,
      counterpartyId: survivor ?? r.counterparty_id ?? null,
      recordedCounterpartyId: r.counterparty_id ?? null,
      campaignId: r.campaign_id ?? null,
      channelId: r.channel_id ?? null,
      estimatedValue: r.estimated_value === null || r.estimated_value === undefined ? null : String(r.estimated_value),
      createdOn: r.created_on, stageChangedOn: r.stage_changed_on, wonOn: r.won_on ?? null, lostOn: r.lost_on ?? null,
    };
  });
}

export async function listInvoiceLines(
  db: Db, orgId: string, invoiceIds: readonly string[], requestId?: string,
): Promise<InvoiceLine[]> {
  void requestId;
  if (invoiceIds.length === 0) return [];
  const ids = [...new Set(invoiceIds)];
  const rows: Row[] = [];
  for (let i = 0; i < ids.length; i += 30) {
    rows.push(...await readRows<Row>(db, orgId, 'invoice_lines', (q) => q.where('invoice_id', 'in', ids.slice(i, i + 30))));
  }
  rows.sort((a, b) => Number(a.sort_order) - Number(b.sort_order));
  return rows.map((r) => ({
    id: r.id, invoiceId: r.invoice_id, productId: r.product_id ?? null, description: r.description ?? null,
    quantity: r.quantity === null || r.quantity === undefined ? null : String(r.quantity), amount: String(r.amount), sortOrder: r.sort_order,
  }));
}

/**
 * The net (ex-tax) amount of each invoice, by the same rule the engine and `api.set_invoice_lines`
 * apply: `subtotal`, else `total − tax`, else `total`. What the line-split form shows as the ceiling.
 */
export async function listInvoiceNets(
  db: Db, orgId: string, invoiceIds: readonly string[], requestId?: string,
): Promise<ReadonlyMap<string, string>> {
  void requestId;
  if (invoiceIds.length === 0) return new Map();
  return new Map((await readRowsByIds<Row>(db, orgId, 'invoices', invoiceIds)).map((r) => {
    const total = new Decimal(String(r.total_amount));
    const subtotal = r.subtotal === null || r.subtotal === undefined ? null : new Decimal(String(r.subtotal));
    const net = subtotal !== null && !(subtotal.isZero() && total.greaterThan(0)) ? subtotal
      : r.tax_amount !== null && r.tax_amount !== undefined ? total.minus(new Decimal(String(r.tax_amount))) : total;
    return [r.id as string, net.toFixed(2)];
  }));
}

export async function productPeriodSummary(
  db: Db, orgId: string, periodIds: readonly string[], requestId?: string,
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
  db: Db, orgId: string, productId: string, limit = 200, requestId?: string,
): Promise<ProductLineRow[]> {
  void requestId;
  const lines = await readRows<Row>(db, orgId, 'invoice_lines', (q) => q.where('product_id', '==', productId));
  lines.sort((a, b) => byText(String(b.created_at), String(a.created_at)));
  const kept = lines.slice(0, limit);
  // The embedded invoice, as a second read joined here.
  const invoices = new Map((await readRowsByIds<Row>(db, orgId, 'invoices', kept.map((l) => String(l.invoice_id))))
    .map((i) => [i.id as string, i]));
  return kept.flatMap((r) => {
    const inv = invoices.get(String(r.invoice_id));
    if (!inv) return [];
    return [{
      lineId: r.id, invoiceId: r.invoice_id, amount: String(r.amount),
      quantity: r.quantity === null || r.quantity === undefined ? null : String(r.quantity), description: r.description ?? null,
      invoiceNumber: inv.invoice_number, invoiceType: inv.invoice_type, issueDate: inv.issue_date, periodId: inv.period_id,
      counterpartyId: inv.counterparty_id,
      counted: inv.record_status === 'accepted' && (inv.superseded_by ?? null) === null && inv.status !== 'void',
    }];
  });
}
