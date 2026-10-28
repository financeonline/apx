import 'server-only';
import Decimal from 'decimal.js';
import type { DocumentData } from 'firebase-admin/firestore';
import { arg, type DbFunctions } from '../registry';
import { raise } from '../raise';
import { newId, nowIso, orgCollection, orgRow, uniqueGuard } from '../schema';
import { runTx } from '../tx';
import { readerOf, uidOf, type Db } from '../types';
import { requireOrg, requirePermission } from '../app/access';
import { prepareAudit } from '../app/audit';
import {
  boolValue, btrim, charLength, checkViolation, dateValue, decimalOf, has, locateOrNotFound, nonEmpty,
  prepareName, readOrganization, readRow, requireCommercialEdit, scaled, textOf, todayIn, uuidValue,
} from '../app/financials-helpers';

/**
 * `api.*` functions of Commercial Intelligence (Phase 14, ADR-102), ported from PostgreSQL
 * (FIRESTORE_DATA_MODEL.md §8): products, channels, campaigns and their spend, the pipeline, an
 * invoice's product lines, and the product summary — an aggregation computed here in Decimal over
 * the months' invoices and lines (§5), returning the rows the SQL returned in the SQL's order.
 *
 * Every write is `app.require_commercial_edit` (`customers.edit`) and checks each referenced row
 * exists in the same organisation. None queues a calculation: a product, a campaign or an
 * opportunity changes no financial figure. Names keep `derive_normalized_name` and their
 * `*_name_unique` keys (`prepareName`).
 */

type Row = DocumentData;
const toText = (a: string | null, b: string | null): number => {
  // ORDER BY … ASC: NULLs last, as PostgreSQL sorts them.
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
};

/** `app.invoice_net(subtotal, tax, total)`: subtotal, else total − tax, else total. */
export function invoiceNet(subtotal: unknown, tax: unknown, total: unknown): Decimal {
  const t = new Decimal(String(total ?? 0));
  const s = subtotal === null || subtotal === undefined ? null : new Decimal(String(subtotal));
  if (s !== null && !(s.isZero() && t.gt(0))) return s;
  if (tax !== null && tax !== undefined) return t.minus(new Decimal(String(tax)));
  return t;
}

async function mustExist(db: Db, tx: FirebaseFirestore.Transaction, org: string, table: 'marketing_channels' | 'counterparties' | 'campaigns' | 'products' | 'fiscal_periods', id: string | null): Promise<void> {
  if (id !== null && !(await tx.get(orgRow(db.fs, org, table, id))).exists) raise.notFound();
}

/** `api.upsert_product(p_org, p_input)` → the id. */
async function upsert_product(db: Db, args: Record<string, unknown>): Promise<string> {
  const org = arg.str(args, 'p_org');
  await requireCommercialEdit(db, org);
  const input = arg.obj(args, 'p_input');
  const name = btrim(textOf(input, 'name') ?? '');
  if (name === '') raise.invalid('a name is required');
  const given = uuidValue(nonEmpty(textOf(input, 'id')));
  const conflict = 'a product or service with that name already exists';

  return runTx(db, async (tx) => {
    const orgId = org!;
    const id = given ?? newId();
    const before = given ? await readRow(tx, db.fs, orgId, 'products', given) : null;
    const kind = nonEmpty(textOf(input, 'kind')) ?? (before ? String(before.kind) : 'service');
    if (kind !== 'product' && kind !== 'service') checkViolation('products', 'products_kind');
    if (charLength(name) > 200) checkViolation('products', 'products_name_len');
    const named = await prepareName(db.fs, tx, {
      orgId, table: 'products', constraint: 'products_name_unique', rowId: id, name,
      previousNormalized: before ? String(before.normalized_name) : null, conflictMessage: conflict,
    });
    const code = (v: string | null) => nonEmpty(btrim(v ?? ''));
    const event = await prepareAudit(db, {
      organizationId: orgId, action: before ? 'product.updated' : 'product.created', targetTable: 'products',
      targetId: id, before, after: input,
    }, tx);
    const now = nowIso();
    if (before) {
      tx.update(orgRow(db.fs, orgId, 'products', id), {
        name, normalized_name: named.normalized, kind,
        code: has(input, 'code') ? code(textOf(input, 'code')) : before.code ?? null,
        notes: has(input, 'notes') ? nonEmpty(textOf(input, 'notes')) : before.notes ?? null,
        is_active: boolValue(input.is_active) ?? before.is_active,
        updated_at: now,
      });
    } else {
      tx.set(orgRow(db.fs, orgId, 'products', id), {
        id, organization_id: orgId, name, normalized_name: named.normalized, kind,
        code: code(textOf(input, 'code')), is_active: true, notes: nonEmpty(textOf(input, 'notes')),
        created_at: now, updated_at: now,
      });
    }
    named.write(tx);
    event.write(tx);
    return id;
  });
}

/** `api.upsert_channel(p_org, p_input)` → the id. */
async function upsert_channel(db: Db, args: Record<string, unknown>): Promise<string> {
  const org = arg.str(args, 'p_org');
  await requireCommercialEdit(db, org);
  const input = arg.obj(args, 'p_input');
  const name = btrim(textOf(input, 'name') ?? '');
  if (name === '') raise.invalid('a name is required');
  const given = uuidValue(nonEmpty(textOf(input, 'id')));

  return runTx(db, async (tx) => {
    const orgId = org!;
    const id = given ?? newId();
    const before = given ? await readRow(tx, db.fs, orgId, 'marketing_channels', given) : null;
    if (charLength(name) > 120) checkViolation('marketing_channels', 'channels_name_len');
    const named = await prepareName(db.fs, tx, {
      orgId, table: 'marketing_channels', constraint: 'channels_name_unique', rowId: id, name,
      previousNormalized: before ? String(before.normalized_name) : null,
      conflictMessage: 'a channel with that name already exists',
    });
    const event = await prepareAudit(db, {
      organizationId: orgId, action: before ? 'channel.updated' : 'channel.created', targetTable: 'marketing_channels',
      targetId: id, before, after: input,
    }, tx);
    const now = nowIso();
    if (before) {
      tx.update(orgRow(db.fs, orgId, 'marketing_channels', id), {
        name, normalized_name: named.normalized, is_active: boolValue(input.is_active) ?? before.is_active, updated_at: now,
      });
    } else {
      tx.set(orgRow(db.fs, orgId, 'marketing_channels', id), {
        id, organization_id: orgId, name, normalized_name: named.normalized, is_active: true, created_at: now, updated_at: now,
      });
    }
    named.write(tx);
    event.write(tx);
    return id;
  });
}

/** `api.upsert_campaign(p_org, p_input)` → the id. */
async function upsert_campaign(db: Db, args: Record<string, unknown>): Promise<string> {
  const org = arg.str(args, 'p_org');
  await requireCommercialEdit(db, org);
  const input = arg.obj(args, 'p_input');
  const name = btrim(textOf(input, 'name') ?? '');
  if (name === '') raise.invalid('a name is required');
  const channel = uuidValue(nonEmpty(textOf(input, 'channel_id')));
  const given = uuidValue(nonEmpty(textOf(input, 'id')));

  return runTx(db, async (tx) => {
    const orgId = org!;
    await mustExist(db, tx, orgId, 'marketing_channels', channel);
    const id = given ?? newId();
    const before = given ? await readRow(tx, db.fs, orgId, 'campaigns', given) : null;
    const date = (key: string, fallback: unknown) => (has(input, key) ? dateValue(nonEmpty(textOf(input, key))) : (fallback ?? null));
    const row = {
      name,
      channel_id: before && !has(input, 'channel_id') ? before.channel_id ?? null : channel,
      starts_on: before ? date('starts_on', before.starts_on) : dateValue(nonEmpty(textOf(input, 'starts_on'))),
      ends_on: before ? date('ends_on', before.ends_on) : dateValue(nonEmpty(textOf(input, 'ends_on'))),
      status: nonEmpty(textOf(input, 'status')) ?? (before ? String(before.status) : 'active'),
      notes: before && !has(input, 'notes') ? before.notes ?? null : nonEmpty(textOf(input, 'notes')),
    };
    if (charLength(name) > 200) checkViolation('campaigns', 'campaigns_name_len');
    if (!['planned', 'active', 'ended'].includes(row.status)) checkViolation('campaigns', 'campaigns_status');
    if (row.starts_on !== null && row.ends_on !== null && String(row.ends_on) < String(row.starts_on)) {
      checkViolation('campaigns', 'campaigns_dates');
    }
    const named = await prepareName(db.fs, tx, {
      orgId, table: 'campaigns', constraint: 'campaigns_name_unique', rowId: id, name,
      previousNormalized: before ? String(before.normalized_name) : null,
      conflictMessage: 'a campaign with that name already exists',
    });
    const event = await prepareAudit(db, {
      organizationId: orgId, action: before ? 'campaign.updated' : 'campaign.created', targetTable: 'campaigns',
      targetId: id, before, after: input,
    }, tx);
    const now = nowIso();
    if (before) {
      tx.update(orgRow(db.fs, orgId, 'campaigns', id), { ...row, normalized_name: named.normalized, updated_at: now });
    } else {
      tx.set(orgRow(db.fs, orgId, 'campaigns', id), {
        id, organization_id: orgId, ...row, normalized_name: named.normalized, created_at: now, updated_at: now,
      });
    }
    named.write(tx);
    event.write(tx);
    return id;
  });
}

/**
 * `api.set_campaign_spend(p_org, p_campaign, p_period, p_amount, p_note)` → the spend row's id.
 * One row per campaign and month (`campaign_spend_once`): a second call replaces the amount.
 */
async function set_campaign_spend(db: Db, args: Record<string, unknown>): Promise<string> {
  const org = arg.str(args, 'p_org');
  await requireCommercialEdit(db, org);
  const campaign = arg.str(args, 'p_campaign');
  const periodId = arg.str(args, 'p_period');
  const orgId = org!;

  return runTx(db, async (tx) => {
    if (!campaign || !periodId) raise.notFound();
    await mustExist(db, tx, orgId, 'campaigns', campaign);
    await mustExist(db, tx, orgId, 'fiscal_periods', periodId);
    const amount = decimalOf(args.p_amount);
    if (amount === null || amount.lt(0)) raise.invalid('spend must be zero or more');
    const organization = await readOrganization(db.fs, orgId, readerOf(tx));
    const once = uniqueGuard(db.fs, { orgId }, 'campaign_spend_once', [campaign, periodId]);
    const guard = await once.read(tx);
    const existing = guard.owner ? await tx.get(orgRow(db.fs, orgId, 'campaign_spend', guard.owner)) : null;
    const id = existing?.exists ? guard.owner! : newId();
    const note = nonEmpty(arg.str(args, 'p_note'));
    const stored = scaled(amount, 2);
    const event = await prepareAudit(db, {
      organizationId: orgId, action: 'campaign.spend_set', targetTable: 'campaign_spend', targetId: id,
      after: { campaign_id: campaign, period_id: periodId, amount: amount.toString() },
    }, tx);
    const now = nowIso();
    if (existing?.exists) {
      tx.update(existing.ref, { amount: stored, note, updated_at: now });
    } else {
      tx.set(orgRow(db.fs, orgId, 'campaign_spend', id), {
        id, organization_id: orgId, campaign_id: campaign, period_id: periodId, amount: stored,
        currency: organization.base_currency ?? null, note, created_at: now, updated_at: now,
      });
      // A guard left by a row that is gone is simply re-pointed.
      tx.set(once.ref, { owner_id: id, constraint: 'campaign_spend_once', created_at: now });
    }
    event.write(tx);
    return id;
  });
}

/**
 * `api.set_invoice_lines(p_invoice, p_lines)` → how many lines were written. Replaces the invoice's
 * product lines; their sum may not exceed the invoice's net amount.
 */
async function set_invoice_lines(db: Db, args: Record<string, unknown>): Promise<number> {
  const invoiceId = arg.str(args, 'p_invoice');
  const found = await locateOrNotFound(db.fs, 'invoices', invoiceId);
  const orgId = found.orgId;
  await requireCommercialEdit(db, orgId);
  const lines = (arg.arr<Record<string, unknown>>(args, 'p_lines') ?? []);

  return runTx(db, async (tx) => {
    const invoice = await readRow(tx, db.fs, orgId, 'invoices', invoiceId!);
    const net = invoiceNet(invoice.subtotal, invoice.tax_amount, invoice.total_amount);
    if (invoice.record_status !== 'accepted' || (invoice.superseded_by !== null && invoice.superseded_by !== undefined)) {
      raise.conflict('only a current, accepted invoice can be split into lines');
    }
    let sum = new Decimal(0);
    const parsed: Array<{ product: string | null; description: string | null; quantity: string | null; amount: string }> = [];
    for (const l of lines) {
      const product = uuidValue(nonEmpty(textOf(l, 'product_id')));
      await mustExist(db, tx, orgId, 'products', product);
      const amount = decimalOf(textOf(l, 'amount'));
      if (amount === null || amount.lt(0)) raise.invalid('every line needs an amount of zero or more');
      sum = sum.plus(amount);
      const quantity = decimalOf(nonEmpty(textOf(l, 'quantity')));
      if (quantity !== null && quantity.lt(0)) checkViolation('invoice_lines', 'invoice_lines_quantity_nonneg');
      parsed.push({
        product, description: nonEmpty(textOf(l, 'description')),
        quantity: quantity === null ? null : scaled(quantity, 4), amount: scaled(amount, 2),
      });
    }
    if (sum.gt(net.abs().plus('0.005'))) raise.invalid('the lines add up to more than the invoice');

    const existing = await tx.get(orgCollection(db.fs, orgId, 'invoice_lines').where('invoice_id', '==', invoiceId));
    const event = await prepareAudit(db, {
      organizationId: orgId, action: 'invoice.lines_set', targetTable: 'invoices', targetId: invoiceId,
      after: { lines: parsed.length, attributed: sum.toString(), net: net.toString() },
    }, tx);
    for (const d of existing.docs) tx.delete(d.ref);
    const now = nowIso();
    parsed.forEach((l, i) => {
      const id = newId();
      tx.set(orgRow(db.fs, orgId, 'invoice_lines', id), {
        id, organization_id: orgId, invoice_id: invoiceId, product_id: l.product, description: l.description,
        quantity: l.quantity, amount: l.amount, sort_order: i, created_by: uidOf(db), created_at: now, updated_at: now,
      });
    });
    event.write(tx);
    return parsed.length;
  });
}

const STAGES = ['lead', 'qualified', 'proposal', 'won', 'lost'];

/** `api.upsert_opportunity(p_org, p_input)` → the id. A won opportunity names its customer. */
async function upsert_opportunity(db: Db, args: Record<string, unknown>): Promise<string> {
  const org = arg.str(args, 'p_org');
  await requireCommercialEdit(db, org);
  const input = arg.obj(args, 'p_input');
  const given = uuidValue(nonEmpty(textOf(input, 'id')));
  if (given === null && btrim(textOf(input, 'name') ?? '') === '') raise.invalid('a name is required');
  const orgId = org!;
  const cpGiven = uuidValue(nonEmpty(textOf(input, 'counterparty_id')));
  const campaign = uuidValue(nonEmpty(textOf(input, 'campaign_id')));
  const channel = uuidValue(nonEmpty(textOf(input, 'channel_id')));
  const value = (): string | null => {
    const v = decimalOf(nonEmpty(textOf(input, 'estimated_value')));
    if (v !== null && v.lt(0)) checkViolation('opportunities', 'opportunities_value_nonneg');
    return v === null ? null : scaled(v, 2);
  };
  const date = (key: string) => dateValue(nonEmpty(textOf(input, key)));

  return runTx(db, async (tx) => {
    await mustExist(db, tx, orgId, 'counterparties', cpGiven);
    await mustExist(db, tx, orgId, 'campaigns', campaign);
    await mustExist(db, tx, orgId, 'marketing_channels', channel);
    const organization = await readOrganization(db.fs, orgId, readerOf(tx));
    const today = todayIn(organization.timezone as string | null);
    const now = nowIso();

    if (given === null) {
      const stage = nonEmpty(textOf(input, 'stage')) ?? 'lead';
      if (stage === 'won' && cpGiven === null) raise.invalid('a won opportunity needs the customer it was won with');
      if (!STAGES.includes(stage)) checkViolation('opportunities', 'opportunities_stage');
      const name = btrim(textOf(input, 'name') ?? '');
      if (charLength(name) > 200) checkViolation('opportunities', 'opportunities_name_len');
      const id = newId();
      const event = await prepareAudit(db, {
        organizationId: orgId, action: 'opportunity.created', targetTable: 'opportunities', targetId: id, after: input,
      }, tx);
      tx.set(orgRow(db.fs, orgId, 'opportunities', id), {
        id, organization_id: orgId, name, stage, counterparty_id: cpGiven, campaign_id: campaign, channel_id: channel,
        estimated_value: value(), currency: organization.base_currency ?? null,
        created_on: date('created_on') ?? today, stage_changed_on: date('stage_changed_on') ?? today,
        won_on: stage === 'won' ? date('won_on') ?? today : null,
        lost_on: stage === 'lost' ? date('lost_on') ?? today : null,
        notes: nonEmpty(textOf(input, 'notes')), created_by: uidOf(db), created_at: now, updated_at: now,
      });
      event.write(tx);
      return id;
    }

    const before = await readRow(tx, db.fs, orgId, 'opportunities', given);
    const stage = nonEmpty(textOf(input, 'stage')) ?? String(before.stage);
    const cp = has(input, 'counterparty_id') ? cpGiven : ((before.counterparty_id as string | null | undefined) ?? null);
    if (stage === 'won' && cp === null) raise.invalid('a won opportunity needs the customer it was won with');
    if (!STAGES.includes(stage)) checkViolation('opportunities', 'opportunities_stage');
    const name = nonEmpty(btrim(textOf(input, 'name') ?? '')) ?? String(before.name);
    if (charLength(name) > 200) checkViolation('opportunities', 'opportunities_name_len');
    const event = await prepareAudit(db, {
      organizationId: orgId, action: 'opportunity.updated', targetTable: 'opportunities', targetId: given,
      before, after: input, metadata: { stage_from: before.stage, stage_to: stage },
    }, tx);
    tx.update(orgRow(db.fs, orgId, 'opportunities', given), {
      name,
      stage,
      counterparty_id: cp,
      campaign_id: has(input, 'campaign_id') ? campaign : before.campaign_id ?? null,
      channel_id: has(input, 'channel_id') ? channel : before.channel_id ?? null,
      estimated_value: has(input, 'estimated_value') ? value() : before.estimated_value ?? null,
      stage_changed_on: stage !== before.stage ? date('stage_changed_on') ?? today : before.stage_changed_on,
      won_on: stage === 'won' ? date('won_on') ?? before.won_on ?? today : null,
      lost_on: stage === 'lost' ? date('lost_on') ?? before.lost_on ?? today : null,
      notes: has(input, 'notes') ? nonEmpty(textOf(input, 'notes')) : before.notes ?? null,
      updated_at: now,
    });
    event.write(tx);
    return given;
  });
}

// ── The product summary ──────────────────────────────────────────────────────────────────────────

/**
 * `sum(coalesce(x, 0))::text` over numeric(18,2) values: `0` when no row had a value (the literal's
 * scale), `n.nn` once one did — PostgreSQL's sum keeps the larger scale.
 */
class ScaledSum {
  total = new Decimal(0);
  private scaled = false;
  add(v: Decimal | null): void {
    if (v === null) return;
    this.total = this.total.plus(v);
    this.scaled = true;
  }
  text(): string { return this.scaled ? this.total.toFixed(2) : '0'; }
}

/**
 * `api.product_period_summary(p_org, p_period_ids)`: per product and month (sales, cost, line and
 * invoice counts), the sales left unattributed to a product per month, and the customer mix of each
 * product. Counted: lines on accepted, live, un-voided invoices; a credit note's lines count
 * negatively; the customer is the merge survivor.
 */
async function product_period_summary(db: Db, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const org = arg.str(args, 'p_org');
  await requireOrg(db, org);
  await requirePermission(db, org, 'customers.view');
  const orgId = org!;
  const periodIds = [...new Set((arg.arr<string>(args, 'p_period_ids') ?? []).map(String))];

  const invoices: Row[] = [];
  for (let i = 0; i < periodIds.length; i += 30) {
    const snap = await orgCollection(db.fs, orgId, 'invoices').where('period_id', 'in', periodIds.slice(i, i + 30)).get();
    for (const d of snap.docs) {
      const r = d.data();
      if (r.record_status === 'accepted' && (r.superseded_by === null || r.superseded_by === undefined) && r.status !== 'void') invoices.push(r);
    }
  }
  const invoiceIds = invoices.map((r) => String(r.id));
  const lines: Row[] = [];
  for (let i = 0; i < invoiceIds.length; i += 30) {
    const snap = await orgCollection(db.fs, orgId, 'invoice_lines').where('invoice_id', 'in', invoiceIds.slice(i, i + 30)).get();
    for (const d of snap.docs) lines.push(d.data());
  }
  const cpIds = [...new Set(invoices.map((r) => r.counterparty_id).filter((id): id is string => typeof id === 'string'))];
  const cpSnaps = cpIds.length > 0 ? await db.fs.getAll(...cpIds.map((id) => orgRow(db.fs, orgId, 'counterparties', id))) : [];
  const survivor = new Map(cpSnaps.filter((s) => s.exists).map((s) => [s.id, (s.get('merged_into_id') as string | null) ?? null]));
  const invoiceById = new Map(invoices.map((r) => [String(r.id), r]));
  const isSales = (t: unknown) => t === 'sales' || t === 'sales_credit_note';
  const isPurchase = (t: unknown) => t === 'purchase' || t === 'purchase_credit_note';

  // Per product and month.
  const products = new Map<string, { product: string | null; period: string; sales: ScaledSum; cost: ScaledSum; salesLines: number; costLines: number; invoices: Set<string> }>();
  for (const l of lines) {
    const inv = invoiceById.get(String(l.invoice_id));
    if (!inv) continue;
    const amount = new Decimal(String(l.amount));
    const product = (l.product_id as string | null | undefined) ?? null;
    const key = JSON.stringify([product, inv.period_id]);
    const p = products.get(key) ?? {
      product, period: String(inv.period_id), sales: new ScaledSum(), cost: new ScaledSum(), salesLines: 0, costLines: 0, invoices: new Set<string>(),
    };
    if (isSales(inv.invoice_type)) { p.sales.add(inv.invoice_type === 'sales' ? amount : amount.neg()); p.salesLines += 1; }
    if (isPurchase(inv.invoice_type)) { p.cost.add(inv.invoice_type === 'purchase' ? amount : amount.neg()); p.costLines += 1; }
    p.invoices.add(String(l.invoice_id));
    products.set(key, p);
  }

  // Unattributed sales per month.
  const linesByInvoice = new Map<string, Row[]>();
  for (const l of lines) linesByInvoice.set(String(l.invoice_id), [...(linesByInvoice.get(String(l.invoice_id)) ?? []), l]);
  const periods = new Map<string, { net: Decimal; attributed: ScaledSum; invoices: number; withoutLines: number }>();
  for (const inv of invoices) {
    if (!isSales(inv.invoice_type)) continue;
    const period = String(inv.period_id);
    const u = periods.get(period) ?? { net: new Decimal(0), attributed: new ScaledSum(), invoices: 0, withoutLines: 0 };
    const sign = inv.invoice_type === 'sales' ? 1 : -1;
    u.net = u.net.plus(invoiceNet(inv.subtotal, inv.tax_amount, inv.total_amount).times(sign));
    u.invoices += 1;
    const own = linesByInvoice.get(String(inv.id)) ?? [];
    if (own.length === 0) u.withoutLines += 1;
    for (const l of own) {
      if (l.product_id !== null && l.product_id !== undefined) u.attributed.add(new Decimal(String(l.amount)).times(sign));
    }
    periods.set(period, u);
  }

  // The customer mix of each product.
  const mix = new Map<string, { product: string; counterparty: string | null; sales: Decimal; lines: number }>();
  for (const l of lines) {
    const inv = invoiceById.get(String(l.invoice_id));
    if (!inv || !isSales(inv.invoice_type) || l.product_id === null || l.product_id === undefined) continue;
    const cp = (inv.counterparty_id as string | null) ?? null;
    const counterparty = cp === null ? null : (survivor.get(cp) ?? null) ?? cp;
    const key = JSON.stringify([l.product_id, counterparty]);
    const m = mix.get(key) ?? { product: String(l.product_id), counterparty, sales: new Decimal(0), lines: 0 };
    const amount = new Decimal(String(l.amount));
    m.sales = m.sales.plus(inv.invoice_type === 'sales' ? amount : amount.neg());
    m.lines += 1;
    mix.set(key, m);
  }

  return {
    products: [...products.values()]
      .sort((a, b) => toText(a.product, b.product) || toText(a.period, b.period))
      .map((p) => ({
        product_id: p.product, period_id: p.period, sales: p.sales.text(), cost: p.cost.text(),
        sales_lines: p.salesLines, cost_lines: p.costLines, invoices: p.invoices.size,
      })),
    unattributed: [...periods.entries()].sort(([a], [b]) => toText(a, b)).map(([period, u]) => ({
      period_id: period, sales_net: u.net.toFixed(2), attributed: u.attributed.text(),
      invoices: u.invoices, invoices_without_lines: u.withoutLines,
    })),
    customer_mix: [...mix.values()]
      .sort((a, b) => toText(a.product, b.product) || b.sales.comparedTo(a.sales))
      .map((m) => ({ product_id: m.product, counterparty_id: m.counterparty, sales: m.sales.toFixed(2), lines: m.lines })),
  };
}

export const functions: DbFunctions = {
  product_period_summary,
  set_campaign_spend,
  set_invoice_lines,
  upsert_campaign,
  upsert_channel,
  upsert_opportunity,
  upsert_product,
};
