import 'server-only';
import { z } from 'zod';
import type { Db } from '@/db/types';
import { callApi } from '@/core/db';
import { ValidationError } from '@/core/errors';

/**
 * Commercial writes (Phase 14, ADR-102). Zod at the boundary, then `api.*` under `customers.edit`,
 * which re-checks the permission and every referenced row's organisation in SQL (ADR-026). None of
 * these queues a calculation: a product, a campaign or an opportunity changes no financial figure.
 */

const Money = z.string().trim().regex(/^\d{1,16}(\.\d{1,2})?$/, 'Enter an amount with at most two decimal places');
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter a date as YYYY-MM-DD');
const uuid = z.string().uuid();

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ValidationError('Some details need fixing.',
      result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  }
  return result.data;
}

export const ProductInput = z.object({
  id: uuid.optional(),
  name: z.string().trim().min(1).max(200),
  kind: z.enum(['product', 'service']).default('service'),
  code: z.string().trim().max(60).optional(),
  notes: z.string().trim().max(2000).optional(),
  isActive: z.boolean().optional(),
});

export async function upsertProduct(db: Db, orgId: string, input: unknown, requestId?: string): Promise<string> {
  const p = parse(ProductInput, input);
  return callApi<string>(db, 'upsert_product', { p_org: orgId, p_input: {
    ...(p.id ? { id: p.id } : {}), name: p.name, kind: p.kind,
    ...(p.code !== undefined ? { code: p.code } : {}), ...(p.notes !== undefined ? { notes: p.notes } : {}),
    ...(p.isActive !== undefined ? { is_active: p.isActive } : {}),
  } }, requestId);
}

export const ChannelInput = z.object({ id: uuid.optional(), name: z.string().trim().min(1).max(120), isActive: z.boolean().optional() });

export async function upsertChannel(db: Db, orgId: string, input: unknown, requestId?: string): Promise<string> {
  const p = parse(ChannelInput, input);
  return callApi<string>(db, 'upsert_channel', { p_org: orgId, p_input: {
    ...(p.id ? { id: p.id } : {}), name: p.name, ...(p.isActive !== undefined ? { is_active: p.isActive } : {}),
  } }, requestId);
}

export const CampaignInput = z.object({
  id: uuid.optional(),
  name: z.string().trim().min(1).max(200),
  channelId: uuid.nullable().optional(),
  startsOn: IsoDate.nullable().optional(),
  endsOn: IsoDate.nullable().optional(),
  status: z.enum(['planned', 'active', 'ended']).optional(),
  notes: z.string().trim().max(2000).optional(),
});

export async function upsertCampaign(db: Db, orgId: string, input: unknown, requestId?: string): Promise<string> {
  const p = parse(CampaignInput, input);
  return callApi<string>(db, 'upsert_campaign', { p_org: orgId, p_input: {
    ...(p.id ? { id: p.id } : {}), name: p.name,
    ...(p.channelId !== undefined ? { channel_id: p.channelId } : {}),
    ...(p.startsOn !== undefined ? { starts_on: p.startsOn } : {}),
    ...(p.endsOn !== undefined ? { ends_on: p.endsOn } : {}),
    ...(p.status !== undefined ? { status: p.status } : {}),
    ...(p.notes !== undefined ? { notes: p.notes } : {}),
  } }, requestId);
}

export const SpendInput = z.object({ campaignId: uuid, periodId: uuid, amount: Money, note: z.string().trim().max(500).optional() });

export async function setCampaignSpend(db: Db, orgId: string, input: unknown, requestId?: string): Promise<string> {
  const p = parse(SpendInput, input);
  return callApi<string>(db, 'set_campaign_spend', {
    p_org: orgId, p_campaign: p.campaignId, p_period: p.periodId, p_amount: p.amount, p_note: p.note ?? null,
  }, requestId);
}

export const OpportunityInput = z.object({
  id: uuid.optional(),
  name: z.string().trim().min(1).max(200).optional(),
  stage: z.enum(['lead', 'qualified', 'proposal', 'won', 'lost']).optional(),
  counterpartyId: uuid.nullable().optional(),
  campaignId: uuid.nullable().optional(),
  channelId: uuid.nullable().optional(),
  estimatedValue: Money.nullable().optional(),
  createdOn: IsoDate.optional(),
  wonOn: IsoDate.optional(),
  lostOn: IsoDate.optional(),
  notes: z.string().trim().max(2000).optional(),
}).refine((o) => o.id !== undefined || (o.name !== undefined && o.name.length > 0), { message: 'A name is required', path: ['name'] });

export async function upsertOpportunity(db: Db, orgId: string, input: unknown, requestId?: string): Promise<string> {
  const p = parse(OpportunityInput, input);
  return callApi<string>(db, 'upsert_opportunity', { p_org: orgId, p_input: {
    ...(p.id ? { id: p.id } : {}),
    ...(p.name !== undefined ? { name: p.name } : {}),
    ...(p.stage !== undefined ? { stage: p.stage } : {}),
    ...(p.counterpartyId !== undefined ? { counterparty_id: p.counterpartyId } : {}),
    ...(p.campaignId !== undefined ? { campaign_id: p.campaignId } : {}),
    ...(p.channelId !== undefined ? { channel_id: p.channelId } : {}),
    ...(p.estimatedValue !== undefined ? { estimated_value: p.estimatedValue } : {}),
    ...(p.createdOn !== undefined ? { created_on: p.createdOn } : {}),
    ...(p.wonOn !== undefined ? { won_on: p.wonOn } : {}),
    ...(p.lostOn !== undefined ? { lost_on: p.lostOn } : {}),
    ...(p.notes !== undefined ? { notes: p.notes } : {}),
  } }, requestId);
}

export const InvoiceLinesInput = z.object({
  invoiceId: uuid,
  lines: z.array(z.object({
    productId: uuid.nullable(),
    description: z.string().trim().max(300).optional(),
    quantity: z.string().trim().regex(/^\d{1,14}(\.\d{1,4})?$/).nullable().optional(),
    amount: Money,
  })).max(200),
});

/** Replaces an invoice's product lines. Σ lines ≤ the invoice's net amount is enforced in SQL. */
export async function setInvoiceLines(db: Db, input: unknown, requestId?: string): Promise<number> {
  const p = parse(InvoiceLinesInput, input);
  return callApi<number>(db, 'set_invoice_lines', {
    p_invoice: p.invoiceId,
    p_lines: p.lines.map((l) => ({ product_id: l.productId, description: l.description ?? null, quantity: l.quantity ?? null, amount: l.amount })),
  }, requestId);
}
