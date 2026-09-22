'use server';

import { revalidatePath } from 'next/cache';
import { getAccessContext } from '@/modules/tenancy';
import { assertCan } from '@/core/permissions';
import {
  setCampaignSpend, setInvoiceLines, upsertCampaign, upsertChannel, upsertOpportunity, upsertProduct,
} from '@/modules/commercial';
import { fail, done, optionalText, text } from '@/app/_lib/server-action';
import type { ActionResult } from '@/components/action-result';

/**
 * Commercial edits (Phase 14, ADR-102). The shape every action follows (SERVICE_ARCHITECTURE.md
 * §8.9): context from the slug in the form, `assertCan(customers.edit)` before the service, and the
 * `api.*` function re-checks the permission and every referenced row's organisation in SQL.
 */
type Handler = (form: FormData, ctx: Awaited<ReturnType<typeof getAccessContext>>) => Promise<string>;

async function run(name: string, form: FormData, handler: Handler, paths: (slug: string) => string[]): Promise<ActionResult> {
  const orgSlug = text(form, 'org_slug');
  let requestId: string | undefined;
  try {
    const ctx = await getAccessContext(orgSlug);
    requestId = ctx.requestId;
    assertCan(ctx, 'customers.edit');
    const message = await handler(form, ctx);
    for (const path of paths(orgSlug)) revalidatePath(path);
    return done(message);
  } catch (error) {
    return fail(error, { requestId, action: name });
  }
}

const blank = (v: string | undefined) => (v === undefined || v === '' ? undefined : v);

export async function createProductAction(_p: ActionResult | null, form: FormData): Promise<ActionResult> {
  return run('commercial.createProduct', form, async (f, ctx) => {
    await upsertProduct(ctx.db, ctx.orgId!, {
      ...(blank(optionalText(f, 'product_id')) ? { id: text(f, 'product_id') } : {}),
      name: text(f, 'name'), kind: text(f, 'kind') || 'service',
      ...(blank(optionalText(f, 'code')) ? { code: text(f, 'code') } : {}),
      ...(blank(optionalText(f, 'notes')) ? { notes: text(f, 'notes') } : {}),
    }, ctx.requestId);
    return 'Saved.';
  }, (s) => [`/app/${s}/customers/products`, `/app/${s}/customers`]);
}

export async function createChannelAction(_p: ActionResult | null, form: FormData): Promise<ActionResult> {
  return run('commercial.createChannel', form, async (f, ctx) => {
    await upsertChannel(ctx.db, ctx.orgId!, { name: text(f, 'name') }, ctx.requestId);
    return 'Channel added.';
  }, (s) => [`/app/${s}/customers/marketing`]);
}

export async function createCampaignAction(_p: ActionResult | null, form: FormData): Promise<ActionResult> {
  return run('commercial.createCampaign', form, async (f, ctx) => {
    await upsertCampaign(ctx.db, ctx.orgId!, {
      name: text(f, 'name'),
      channelId: blank(optionalText(f, 'channel_id')) ?? null,
      startsOn: blank(optionalText(f, 'starts_on')) ?? null,
      endsOn: blank(optionalText(f, 'ends_on')) ?? null,
    }, ctx.requestId);
    return 'Campaign added.';
  }, (s) => [`/app/${s}/customers/marketing`, `/app/${s}/customers`]);
}

export async function setSpendAction(_p: ActionResult | null, form: FormData): Promise<ActionResult> {
  return run('commercial.setSpend', form, async (f, ctx) => {
    await setCampaignSpend(ctx.db, ctx.orgId!, {
      campaignId: text(f, 'campaign_id'), periodId: text(f, 'period_id'), amount: text(f, 'amount'),
      ...(blank(optionalText(f, 'note')) ? { note: text(f, 'note') } : {}),
    }, ctx.requestId);
    return 'Spend recorded.';
  }, (s) => [`/app/${s}/customers/marketing`, `/app/${s}/customers/marketing/${text(form, 'campaign_id')}`, `/app/${s}/customers`]);
}

export async function upsertOpportunityAction(_p: ActionResult | null, form: FormData): Promise<ActionResult> {
  return run('commercial.upsertOpportunity', form, async (f, ctx) => {
    const id = blank(optionalText(f, 'opportunity_id'));
    const stage = blank(optionalText(f, 'stage'));
    await upsertOpportunity(ctx.db, ctx.orgId!, {
      ...(id ? { id } : {}),
      ...(blank(optionalText(f, 'name')) ? { name: text(f, 'name') } : {}),
      ...(stage ? { stage } : {}),
      ...(f.has('counterparty_id') ? { counterpartyId: blank(optionalText(f, 'counterparty_id')) ?? null } : {}),
      ...(f.has('campaign_id') ? { campaignId: blank(optionalText(f, 'campaign_id')) ?? null } : {}),
      ...(f.has('estimated_value') ? { estimatedValue: blank(optionalText(f, 'estimated_value')) ?? null } : {}),
      ...(blank(optionalText(f, 'created_on')) ? { createdOn: text(f, 'created_on') } : {}),
      ...(blank(optionalText(f, 'won_on')) ? { wonOn: text(f, 'won_on') } : {}),
    }, ctx.requestId);
    return id ? 'Updated.' : 'Added to the pipeline.';
  }, (s) => [`/app/${s}/customers/sales`, `/app/${s}/customers/marketing`, `/app/${s}/customers`]);
}

/** Lines arrive as parallel arrays `product_id[]` / `amount[]` / `description[]` from the split form. */
export async function setInvoiceLinesAction(_p: ActionResult | null, form: FormData): Promise<ActionResult> {
  return run('commercial.setInvoiceLines', form, async (f, ctx) => {
    const products = f.getAll('product_id').map(String);
    const amounts = f.getAll('amount').map(String);
    const descriptions = f.getAll('description').map(String);
    const lines = amounts
      .map((amount, i) => ({ productId: blank(products[i]) ?? null, amount: amount.trim(), ...(blank(descriptions[i]) ? { description: descriptions[i]!.trim() } : {}) }))
      .filter((l) => l.amount !== '' && l.amount !== '0' && l.amount !== '0.00');
    const count = await setInvoiceLines(ctx.db, { invoiceId: text(f, 'invoice_id'), lines }, ctx.requestId);
    return count === 0 ? 'Lines cleared.' : `Saved ${count} line${count === 1 ? '' : 's'}.`;
  }, (s) => [`/app/${s}/customers/${text(form, 'counterparty_id')}`, `/app/${s}/customers/products`, `/app/${s}/customers`]);
}
