import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { Decimal } from '@/core/money';
import { loadHome } from '@/modules/dashboard';
import { drainJobs } from '@/modules/jobs';
import type { DocumentData } from 'firebase-admin/firestore';
import { invoiceNet } from '@/db/app/engine-aggregate';
import { periodId } from '@/db/app/shared';
import { orgCollection, orgRow } from '@/db/schema';
import { clientFor, createAuthUser, deleteOrg, drainUntilFinished, fs } from './setup';
import {
  seedAccepted, seedBankAccount, seedBankTransaction, seedBatch, seedCounterparty, seedDocument, seedImportRow,
  seedInvoice, seedLedgerEntry, seedOrg,
} from '../fixtures/seed';
import { deleteJobsOf, seedJob } from '../fixtures/engine-helpers';

/**
 * The invoice basis, end to end (FINANCIAL_ENGINE.md §2.1, §2.3, §3, §3.5; ADR-103).
 *
 * Two golden organisations, both driven through the real queue and the real aggregate:
 *
 *   A — a business that uploads a FULL sales-invoice list and a purchase list, and nothing else.
 *       Until ADR-103 its headline revenue was £0 with every penny counted as uncategorised, while
 *       its per-customer revenue was right — the shape Phase 14's reconciliation test surfaced.
 *   B — the same, plus bank statements. Invoices outrank bank for the P&L (§2.3), so the accrual
 *       figures must stay the invoices' and cash must stay the bank's, with neither double-counted.
 *
 * Every expected number is hand-computed in the comments. Amounts are compared as strings through
 * `Decimal`, never as floats (ADR-006).
 */

const RUN = `g${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.invoice.itest.motion`;

let owner: string;
let ownerTwo: string;
let orgA: string;
let orgB: string;
let orgC: string;
let orgD: string;
let augA: string;
let augB: string;
let augC: string;
let parts: string;
let acme: string;
let beta: string;

interface InvoiceInput {
  readonly type: 'sales' | 'sales_credit_note' | 'purchase';
  readonly counterparty: string;
  readonly number: string;
  readonly date: string;
  readonly subtotal: string | null;
  readonly tax: string | null;
  readonly total: string;
}

async function seedInvoices(org: string, rows: readonly InvoiceInput[]): Promise<void> {
  for (const r of rows) {
    await seedInvoice(org, {
      type: r.type, counterpartyId: r.counterparty, number: r.number, issue: r.date, due: r.date,
      subtotal: r.subtotal, tax: r.tax, total: r.total, paid: '0', status: 'open',
    });
  }
}

/**
 * A committed, FULL sales-invoice list spanning the quarter — what §2.2 asks of the revenue family —
 * and the purchase list beside it (FU-12: costs need a full purchase list (ADR-126)), over the same
 * range, so the invoice-basis cost lines are established: A's 900 cost of sales, and B's genuine
 * 0.00 operating expenses (its purchase list has nothing in August).
 */
async function seedInvoiceBatch(org: string, tag: string): Promise<void> {
  const doc = await seedDocument(org, `invoices-${tag}.csv`, 'invoice');
  await seedBatch(org, {
    importType: 'sales_invoices', target: 'invoices', start: '2026-06-01', end: '2026-08-31', listKind: 'full', documentId: doc,
  });
  // FU-12: costs need a full purchase list (ADR-126).
  await seedBatch(org, {
    importType: 'purchase_invoices', target: 'invoices', start: '2026-06-01', end: '2026-08-31', listKind: 'full', documentId: doc,
  });
}

async function calculate(org: string): Promise<void> {
  const jobId = await seedJob(org, 'calculation.run', { trigger: 'recalc_manual', as_of: '2026-09-15' }, { maxAttempts: 3 });
  expect(await drainUntilFinished(drainJobs, jobId), `the calculation for ${org} must succeed`).toBe('succeeded');
}

/** The current headline snapshot of a cell, by the period's id. */
async function snapshotOf(org: string, period: string, key: string): Promise<DocumentData | null> {
  const pointers = await orgCollection(fs(), org, 'metric_current').where('period_id', '==', period).where('metric_key', '==', key).get();
  const pointer = pointers.docs.map((d) => d.data()).find((c) => c.dimension_type === 'none');
  if (!pointer) return null;
  const snap = await orgRow(fs(), org, 'metric_snapshots', String(pointer.snapshot_id)).get();
  return snap.exists ? snap.data()! : null;
}

const metric = async (org: string, period: string, key: string): Promise<string | null> => {
  const s = await snapshotOf(org, period, key);
  return s?.value === null || s?.value === undefined ? null : String(s.value);
};
const money = (value: string | null): string | null => (value === null ? null : new Decimal(value).toFixed(2));
/** A snapshot column as its SQL text cast read: jsonb as JSON text, everything else as a string. */
const snapshotField = async (org: string, period: string, key: string, field: string): Promise<string> => {
  const v = (await snapshotOf(org, period, key))?.[field];
  if (v === null || v === undefined) return '';
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
};
const customerRevenue = async (org: string, period: string): Promise<Array<{ id: string | null; value: string }>> => {
  const pointers = await orgCollection(fs(), org, 'metric_current').where('period_id', '==', period)
    .where('metric_key', '==', 'customer_revenue').get();
  const out: Array<{ id: string | null; value: string }> = [];
  for (const p of pointers.docs) {
    const s = await orgRow(fs(), org, 'metric_snapshots', String(p.get('snapshot_id'))).get();
    out.push({ id: (p.get('dimension_id') as string | null) ?? null, value: new Decimal(String(s.get('value'))).toFixed(2) });
  }
  return out;
};

beforeAll(async () => {
  owner = await createAuthUser(`owner@${DOMAIN}`);
  ownerTwo = await createAuthUser(`owner-two@${DOMAIN}`);
  const create = async (by: string, name: string): Promise<string> => (await seedOrg({ name, ownerId: by })).orgId;
  orgA = await create(owner, `ITest Invoice A ${RUN}`);
  orgB = await create(owner, `ITest Invoice B ${RUN}`);
  orgC = await create(ownerTwo, `ITest Invoice C ${RUN}`);
  orgD = await create(ownerTwo, `ITest Invoice D ${RUN}`);

  const counterparty = (org: string, name: string, kind: string, category: string | null): Promise<string> =>
    seedCounterparty(org, { name, kind, defaultExpenseCategory: category });
  const systemAccount = async (org: string, category: string): Promise<string> =>
    (await orgCollection(fs(), org, 'accounts').where('standard_category', '==', category).where('is_system', '==', true).get()).docs[0]!.id;

  acme = await counterparty(orgA, 'Acme Ltd', 'customer', null);
  beta = await counterparty(orgA, 'Beta plc', 'customer', null);
  parts = await counterparty(orgA, 'Parts Co', 'supplier', 'cost_of_sales');
  await seedInvoices(orgA, [
    { type: 'sales', counterparty: acme, number: 'A-001', date: '2026-08-05', subtotal: '6000.00', tax: '1200.00', total: '7200.00' },
    { type: 'sales_credit_note', counterparty: acme, number: 'A-C01', date: '2026-08-19', subtotal: '500.00', tax: '100.00', total: '600.00' },
    { type: 'sales', counterparty: beta, number: 'B-001', date: '2026-08-11', subtotal: '2000.00', tax: '400.00', total: '2400.00' },
    { type: 'sales', counterparty: beta, number: 'B-002', date: '2026-08-21', subtotal: '0', tax: '210.00', total: '1260.00' },
    { type: 'purchase', counterparty: parts, number: 'P-001', date: '2026-08-14', subtotal: '900.00', tax: '180.00', total: '1080.00' },
  ]);
  await seedInvoiceBatch(orgA, 'a');

  /*
   * Organisation B — the same sales, plus a bank statement for August.
   *
   *   invoices: Northwind net 4,000.00 (+800.00 VAT)
   *   bank:     +4,800.00 receipt categorised as revenue, −1,000.00 rent, closing 8,800.00
   *
   *   The receipt is the SAME money as the invoice, arriving. Invoices outrank bank for the P&L, so
   *   revenue must be 4,000.00 — never 8,800.00, and never the bank's 4,800.00 gross.
   */
  const northwind = await counterparty(orgB, 'Northwind Ltd', 'customer', null);
  await seedInvoices(orgB, [
    { type: 'sales', counterparty: northwind, number: 'N-001', date: '2026-08-06', subtotal: '4000.00', tax: '800.00', total: '4800.00' },
  ]);
  await seedInvoiceBatch(orgB, 'b');
  const bankAccount = await seedBankAccount(orgB, { name: 'Current', accountType: 'current', openingBalance: '5000.00', openingBalanceDate: '2026-07-31' });
  const bankDoc = await seedDocument(orgB, 'aug.csv', 'bank_statement');
  await seedBatch(orgB, {
    importType: 'bank_statement', target: 'bank_transactions', start: '2026-08-01', end: '2026-08-31',
    bankAccountId: bankAccount, documentId: bankDoc,
  });
  const revenueAccount = await systemAccount(orgB, 'revenue');
  const opexAccount = await systemAccount(orgB, 'operating_expense');
  await seedBankTransaction(orgB, {
    bankAccountId: bankAccount, date: '2026-08-09', amount: '4800.00', description: 'FPS CREDIT NORTHWIND',
    balanceAfter: '9800.00', categoryAccountId: revenueAccount, categorySource: 'user', counterpartyId: northwind,
  });
  await seedBankTransaction(orgB, {
    bankAccountId: bankAccount, date: '2026-08-29', amount: '-1000.00', description: 'RENT PAYMENT',
    balanceAfter: '8800.00', categoryAccountId: opexAccount, categorySource: 'rule',
  });

  /*
   * Organisation C — a GENERAL LEDGER covering August that states revenue and no cost of sales,
   * plus purchase invoices from a cost-of-sales supplier the ledger does not contain. The ledger is
   * the P&L basis; the invoices are evidence it is not reading (ADR-104).
   */
  const glCustomer = await counterparty(orgC, 'GL Customer', 'customer', null);
  const glStock = await counterparty(orgC, 'GL Stock', 'supplier', 'cost_of_sales');
  const glDoc = await seedDocument(orgC, 'gl.csv', 'general_ledger');
  const glBatch = await seedBatch(orgC, {
    importType: 'general_ledger', target: 'ledger_entries', start: '2026-08-01', end: '2026-08-31', documentId: glDoc,
  });
  const glRevenue = await systemAccount(orgC, 'revenue');
  const glRow = await seedImportRow(orgC, glBatch);
  const glEntry = await seedLedgerEntry(orgC, {
    date: '2026-08-31', accountId: glRevenue, direction: 'credit', amount: '9000.00', documentId: glDoc,
    batchId: glBatch, importRowId: glRow, sourceRef: 'csv:row:1', counterpartyId: glCustomer,
  });
  await seedAccepted(orgC, 'ledger_entries', glEntry, glBatch);
  await seedInvoices(orgC, [
    { type: 'purchase', counterparty: glStock, number: 'GP-1', date: '2026-08-10', subtotal: '2500.00', tax: '500.00', total: '3000.00' },
  ]);

  // Organisation D — nothing at all: no accounts, no invoices, no statements.

  await calculate(orgA);
  await calculate(orgB);
  await calculate(orgC);
  await calculate(orgD);
  const aug = (org: string) => periodId(org, '2026-08-01');
  augA = aug(orgA); augB = aug(orgB); augC = aug(orgC);
}, 300_000);

afterAll(async () => {
  for (const org of [orgA, orgB, orgC, orgD]) {
    if (!org) continue;
    await deleteJobsOf(org);
    await deleteOrg(org);
  }
});

describe('golden: an organisation with invoices and nothing else has a profit and loss', () => {
  it('reports revenue net of tax and credit notes, on the invoice basis', async () => {
    expect(money(await metric(orgA, augA, 'revenue'))).toBe('8550.00');
    expect(await snapshotField(orgA, augA, 'revenue', 'basis')).toBe('invoices');
  });

  it('reads a subtotal of 0 beside a positive total as absent — the one rule, in the aggregation', async () => {
    // B-002 contributes 1,260.00 − 210.00 = 1,050.00, not 0.00.
    const betaRevenue = (await customerRevenue(orgA, augA)).find((r) => r.id === beta);
    expect(betaRevenue?.value).toBe('3050.00');
    expect(invoiceNet('0', '210.00', '1260.00').toFixed(2)).toBe('1050.00');
    expect(invoiceNet(null, null, '1260.00').toFixed(2)).toBe('1260.00');
    expect(invoiceNet('1000.00', '200.00', '1200.00').toFixed(2)).toBe('1000.00');
  });

  it('places purchases in the supplier’s category and profits follow', async () => {
    expect(money(await metric(orgA, augA, 'cost_of_sales'))).toBe('900.00');
    expect(money(await metric(orgA, augA, 'gross_profit'))).toBe('7650.00');
    expect(money(await metric(orgA, augA, 'net_profit'))).toBe('7650.00');
  });

  it('reconciles Σ customer_revenue + unattributed to revenue, to the penny', async () => {
    const rows = (await customerRevenue(orgA, augA));
    expect(rows.find((r) => r.id === acme)?.value).toBe('5500.00');
    expect(rows.find((r) => r.id === null)?.value).toBe('0.00');
    const total = rows.reduce((acc, r) => acc.plus(r.value), new Decimal(0));
    expect(total.toFixed(2)).toBe(money(await metric(orgA, augA, 'revenue')));
  });

  it('measures concentration, because there is a revenue to measure it against', async () => {
    // 5,500 / 8,550 = 0.643275
    expect(await metric(orgA, augA, 'customer_concentration_top1')).toBe('0.643275');
    expect(await snapshotField(orgA, augA, 'revenue', 'data_quality')).not.toMatch(/uncategorised_amounts_exceed_threshold/);
  });
});

describe('golden: invoices outrank bank for the P&L, and cash stays the bank’s (§2.3)', () => {
  it('takes revenue from the invoices, not from the bank receipt, and never from both', async () => {
    expect(money(await metric(orgB, augB, 'revenue'))).toBe('4000.00');
    expect(await snapshotField(orgB, augB, 'revenue', 'basis')).toBe('invoices');
    // The receipt is the invoice arriving: 4,800.00 gross must not be added to the 4,000.00 net.
    expect(money(await metric(orgB, augB, 'revenue'))).not.toBe('8800.00');
    expect(money(await metric(orgB, augB, 'revenue'))).not.toBe('4800.00');
  });

  it('keeps cash on the bank basis, at the balance the statement printed', async () => {
    expect(money(await metric(orgB, augB, 'closing_cash'))).toBe('8800.00');
    expect(await snapshotField(orgB, augB, 'closing_cash', 'basis')).toBe('bank');
    expect(money(await metric(orgB, augB, 'cash_inflows'))).toBe('4800.00');
    expect(money(await metric(orgB, augB, 'cash_outflows'))).toBe('1000.00');
  });

  it('does not let a bank-categorised expense enter the accrual P&L that the invoices define', async () => {
    // Rent was paid from the bank, but the P&L for this month is the invoice list's, which has no
    // purchase in it. Reporting the bank's rent here would mix two bases in one figure (§2.3).
    expect(money(await metric(orgB, augB, 'operating_expenses'))).toBe('0.00');
    expect(money(await metric(orgB, augB, 'net_profit'))).toBe('4000.00');
  });

  it('reconciles the customer family to the same revenue', async () => {
    const total = (await customerRevenue(orgB, augB)).reduce((acc, r) => acc.plus(r.value), new Decimal(0));
    expect(total.toFixed(2)).toBe('4000.00');
  });
});

describe('golden: cash is unavailable where nothing can establish it (ADR-104)', () => {
  const cashKeys = ['closing_cash', 'opening_cash', 'cash_inflows', 'cash_outflows', 'net_cash_movement'];

  it('an invoice-only organisation has no cash figure, not a zero one, and says why', async () => {
    for (const key of cashKeys) {
      expect(await metric(orgA, augA, key), key).toBeNull();
      expect(await snapshotField(orgA, augA, key, 'data_quality'), key).toMatch(/no_bank_accounts/);
      expect(await snapshotField(orgA, augA, key, 'basis'), key).toBe('none');
    }
    // The P&L that was independently verified is untouched by the cash rule.
    expect(money(await metric(orgA, augA, 'revenue'))).toBe('8550.00');
    expect(money(await metric(orgA, augA, 'gross_profit'))).toBe('7650.00');
  });

  it('a bank organisation still has its cash, from the bank, with revenue from the invoices', async () => {
    expect(money(await metric(orgB, augB, 'closing_cash'))).toBe('8800.00');
    expect(await snapshotField(orgB, augB, 'closing_cash', 'basis')).toBe('bank');
    expect(money(await metric(orgB, augB, 'revenue'))).toBe('4000.00');
  });

  it('an organisation with nothing at all writes no zero anywhere', async () => {
    const pointers = await orgCollection(fs(), orgD, 'metric_current').get();
    const zeros: string[] = [];
    for (const p of pointers.docs) {
      const s = await orgRow(fs(), orgD, 'metric_snapshots', String(p.get('snapshot_id'))).get();
      if (s.get('value') !== null && s.get('value') !== undefined) zeros.push(`${String(p.get('metric_key'))}=${String(s.get('value'))}`);
    }
    expect(zeros.join('\n'), 'no metric carries a value on an organisation with no data').toBe('');
  });
});

describe('golden: evidence on the invoice basis reconciles to the figure it hangs off (ADR-104)', () => {
  it('cost of sales names the cost-of-sales supplier, not every purchase in the month', async () => {
    const descriptor = JSON.parse(await snapshotField(orgA, augA, 'cost_of_sales', 'evidence_query')) as { descriptor: { filters: Record<string, unknown> } };
    expect(descriptor.descriptor.filters).toEqual({
      period_ids: [augA], invoice_types: ['purchase', 'purchase_credit_note'], counterparty_ids: [parts],
    });
  });

  it('revenue stays on the sales types, which are exactly the figure', async () => {
    const descriptor = JSON.parse(await snapshotField(orgA, augA, 'revenue', 'evidence_query')) as { descriptor: { filters: Record<string, unknown> } };
    expect(descriptor.descriptor.filters).toEqual({ period_ids: [augA], invoice_types: ['sales', 'sales_credit_note'] });
  });
});

describe('golden: cost of sales that lives only in invoices is not a zero on the ledger basis (ADR-104)', () => {
  it('reports cost of sales as unavailable with the reason, and no gross margin', async () => {
    expect(await snapshotField(orgC, augC, 'revenue', 'basis')).toBe('ledger');
    expect(money(await metric(orgC, augC, 'revenue'))).toBe('9000.00');
    expect(await metric(orgC, augC, 'cost_of_sales')).toBeNull();
    expect(await snapshotField(orgC, augC, 'cost_of_sales', 'data_quality')).toMatch(/cost_of_sales_in_other_source/);
    expect(await metric(orgC, augC, 'gross_margin')).toBeNull();
    expect(await snapshotField(orgC, augC, 'gross_profit', 'data_quality')).toMatch(/no_cost_of_sales/);
  });
});

describe('golden: Home shows gross profit only where the engine established cost of sales (CD-05, ADR-105)', () => {
  it('shows the card, with the figure, for the invoice-only organisation that has a cost line', async () => {
    const home = await loadHome(clientFor(owner), orgA, 'a');
    if (home.kind !== 'ready') throw new Error(`expected a ready Home, got ${home.kind}`);
    expect(home.view.hidesGrossProfit).toBe(false);
    expect(home.view.grossProfitNote).toBeNull();
    const card = home.view.cards.find((c) => c.metricKey === 'gross_profit');
    expect(card?.value).toContain('7,650');
  });

  it('omits the card and says why for the ledger organisation whose cost of sales lives only in invoices', async () => {
    const home = await loadHome(clientFor(ownerTwo), orgC, 'c');
    if (home.kind !== 'ready') throw new Error(`expected a ready Home, got ${home.kind}`);
    expect(home.view.hidesGrossProfit).toBe(true);
    expect(home.view.cards.map((c) => c.metricKey)).not.toContain('gross_profit');
    expect(home.view.grossProfitNote).toMatch(/purchase invoices show direct costs/);
  });
});
