import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { permissionsFor } from '@/core/permissions';
import { resolvePeriodContext, TOOLS } from '@/modules/ai';
import { loadPeriods, loadPeriodsWithData } from '@/modules/dashboard';
import { resolveDescriptor } from '@/modules/evidence';
import type { AccessContext } from '@/modules/tenancy';
import { periodId } from '@/db/app/shared';
import { orgRow } from '@/db/schema';
import { clientFor, createAuthUser, deleteOrg, drainUntilFinished, fs } from './setup';
import { createOrgFixture } from './r-fixtures';
import {
  accountFor, drainShared, currentCells, deleteAuthUsers, deleteJobsOf, descriptorOfFigure, figureOf, queueCalculation,
  seedBatch, seedCounterparty, seedDocument, seedImportRow, seedInvoice, seedLedgerEntry, seedStatusEvent,
} from './evidence-fixtures';

/**
 * A merged counterparty's rows are in the survivor's figure, so they are in the survivor's
 * evidence (ADR-108).
 *
 * The fold attributes every row of a merged party to its survivor; a merge is a pointer and the
 * rows keep their original ids. Until ADR-108 the descriptor behind a survivor's figure named only
 * the survivor, so the drill-down behind a merged customer's revenue, a merged supplier's spend and
 * a cost-of-sales figure fed by a merged supplier each understated by the absorbed party's rows —
 * on every basis, because the same builder writes all of them. Measured before the fix: customer
 * revenue 8,000 with evidence 5,000; supplier spend 3,750 with evidence 1,500; ledger-basis customer
 * revenue 5,000 with evidence 4,000.
 *
 * Two organisations: one on the invoice basis with a merged customer AND a merged supplier, one on
 * the ledger basis with a merged customer. Amounts are deliberately unlike the earlier probes.
 */

const RUN = `mc${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.merged.itest.motion`;

let owner: string;
let invOrg: string; let invAug: string;
let survivorCustomer: string; let absorbedCustomer: string;
let survivorSupplier: string; let absorbedSupplier: string;
let absorbedSale: string; let absorbedPurchase: string;
let ledOrg: string; let ledAug: string;
let ledSurvivor: string; let ledAbsorbedEntry: string;

const ctxFor = (org: string): AccessContext => ({
  userId: owner, orgId: org, orgSlug: 'merged', effectiveRole: 'owner', permissions: permissionsFor('owner'),
  actorType: 'user', db: clientFor(owner), requestId: `itest-${RUN}`,
  now: () => new Date('2026-09-15T00:00:00Z'), organizationStatus: 'active',
});

const descriptorOf = descriptorOfFigure;
const figure = figureOf;

const counterparty = (org: string, name: string, kind: string, category: string | null = null) =>
  seedCounterparty(org, { name, kind, defaultExpenseCategory: category });
const invoice = (org: string, type: string, cp: string, number: string, subtotal: string, tax: string, total: string) =>
  seedInvoice(org, {
    type, counterpartyId: cp, number, issueDate: '2026-08-14', dueDate: '2026-09-13', subtotal, tax, total,
    paid: '0', status: 'open', recordStatus: 'accepted', assurance: 'verified',
  });
/** The merge as api.merge_counterparties records it: a pointer, and the absorbed party inactive. */
const merge = (org: string, absorbed: string, survivor: string) =>
  orgRow(fs(), org, 'counterparties', absorbed).update({ merged_into_id: survivor, is_active: false });
async function calculate(org: string): Promise<string> {
  const jobId = await queueCalculation(org, { trigger: 'counterparty_merged', as_of: '2026-09-15' });
  expect(await drainUntilFinished(drainShared, jobId)).toBe('succeeded');
  return periodId(org, '2026-08-01');
}
async function callContext(org: string) {
  const rows = await loadPeriods(clientFor(owner), org, `itest-${RUN}`);
  const withData = await loadPeriodsWithData(clientFor(owner), org, `itest-${RUN}`);
  const periodContext = resolvePeriodContext({
    question: 'how did Aug 2026 go?', fiscalYearStartMonth: 1,
    periods: rows.map((p) => ({ id: p.id, label: p.label, periodStart: p.periodStart, isComplete: p.isComplete, hasData: withData.has(p.id) })),
  });
  return { ctx: ctxFor(org), periodContext, knownPeriods: [], now: new Date('2026-09-15T00:00:00Z') };
}

beforeAll(async () => {
  owner = await createAuthUser(`owner@${DOMAIN}`);

  // ---- Invoice basis: Northwind (survivor) absorbs "Northwind Traders"; Stock Co absorbs "Stock Co Ltd".
  //   Sales:     Northwind 6,400 · Northwind Traders 2,150   → customer revenue (Northwind) 8,550 · revenue 8,550
  //   Purchases: Stock Co 1,275  · Stock Co Ltd 985          → supplier spend (Stock Co) 2,260 · cost of sales 2,260
  invOrg = (await createOrgFixture({ name: `ITest Merged Inv ${RUN}`, ownerId: owner })).id;
  survivorCustomer = await counterparty(invOrg, 'Northwind', 'customer');
  absorbedCustomer = await counterparty(invOrg, 'Northwind Traders', 'customer');
  survivorSupplier = await counterparty(invOrg, 'Stock Co', 'supplier', 'cost_of_sales');
  absorbedSupplier = await counterparty(invOrg, 'Stock Co Ltd', 'supplier', 'cost_of_sales');
  const invoices = [
    await invoice(invOrg, 'sales', survivorCustomer, 'S-1', '6400.00', '1280.00', '7680.00'),
    absorbedSale = await invoice(invOrg, 'sales', absorbedCustomer, 'S-2', '2150.00', '430.00', '2580.00'),
    await invoice(invOrg, 'purchase', survivorSupplier, 'P-1', '1275.00', '255.00', '1530.00'),
    absorbedPurchase = await invoice(invOrg, 'purchase', absorbedSupplier, 'P-2', '985.00', '197.00', '1182.00'),
  ];
  await merge(invOrg, absorbedCustomer, survivorCustomer);
  await merge(invOrg, absorbedSupplier, survivorSupplier);
  for (const id of invoices) await seedStatusEvent(invOrg, { table: 'invoices', recordId: id, event: 'accepted' });
  const doc = await seedDocument(invOrg, { name: 'inv.csv', kind: 'invoice' });
  await seedBatch(invOrg, {
    documentId: doc, importType: 'sales_invoices', targetTable: 'invoices', status: 'committed',
    periodStart: '2026-08-01', periodEnd: '2026-08-31', invoiceListKind: 'full',
  });
  // FU-12: costs need a full purchase list (ADR-126).
  await seedBatch(invOrg, {
    documentId: doc, importType: 'purchase_invoices', targetTable: 'invoices', status: 'committed',
    periodStart: '2026-08-01', periodEnd: '2026-08-31', invoiceListKind: 'full',
  });
  invAug = await calculate(invOrg);

  // ---- Ledger basis: Harbour (survivor) absorbs "Harbour (old)"; revenue entries 3,300 + 725 → 4,025.
  ledOrg = (await createOrgFixture({ name: `ITest Merged Led ${RUN}`, ownerId: owner })).id;
  ledSurvivor = await counterparty(ledOrg, 'Harbour', 'customer');
  const ledAbsorbed = await counterparty(ledOrg, 'Harbour (old)', 'customer');
  await merge(ledOrg, ledAbsorbed, ledSurvivor);
  const revenueAccount = await accountFor(ledOrg, 'revenue');
  const gdoc = await seedDocument(ledOrg, { name: 'gl.csv', kind: 'general_ledger' });
  const batch = await seedBatch(ledOrg, {
    documentId: gdoc, importType: 'general_ledger', targetTable: 'ledger_entries', status: 'committed',
    periodStart: '2026-08-01', periodEnd: '2026-08-31',
  });
  const entry = async (n: number, cp: string, amount: string): Promise<string> => {
    const row = await seedImportRow(ledOrg, { batchId: batch, rowNumber: n, sourceRef: `r${n}` });
    const id = await seedLedgerEntry(ledOrg, {
      date: '2026-08-21', accountId: revenueAccount, direction: 'credit', amount, status: 'accepted',
      documentId: gdoc, batchId: batch, importRowId: row, sourceRef: `r${n}`, counterpartyId: cp,
    });
    await seedStatusEvent(ledOrg, { table: 'ledger_entries', recordId: id, event: 'accepted', batchId: batch });
    return id;
  };
  await entry(1, ledSurvivor, '3300.00');
  ledAbsorbedEntry = await entry(2, ledAbsorbed, '725.00');
  ledAug = await calculate(ledOrg);
}, 300_000);

afterAll(async () => {
  for (const org of [invOrg, ledOrg]) {
    if (!org) continue;
    await deleteJobsOf(org);
    await deleteOrg(org);
  }
  await deleteAuthUsers(DOMAIN);
});

describe('invoice basis: the survivor’s evidence names the parties merged into it (ADR-108)', () => {
  it('a merged customer: the survivor’s revenue includes the absorbed sale, and so does its drill-down', async () => {
    expect(await figure(invOrg, invAug, 'customer_revenue', survivorCustomer), '6,400 + 2,150').toBe('8550.00');
    const descriptor = await descriptorOf(invOrg, invAug, 'customer_revenue', survivorCustomer) as { filters: { counterparty_ids: string[] } };
    expect(descriptor.filters.counterparty_ids.sort()).toEqual([survivorCustomer, absorbedCustomer].sort());
    const selection = await resolveDescriptor(ctxFor(invOrg), descriptor);
    expect(selection.rows.map((r) => r.id)).toContain(absorbedSale);
    expect(selection.count).toBe(2);
    expect(selection.total).toBe(await figure(invOrg, invAug, 'customer_revenue', survivorCustomer));
    // The absorbed party has no figure of its own: it is not a customer any more (ADR-046.2).
    expect(await currentCells(invOrg, invAug, 'customer_revenue', absorbedCustomer)).toHaveLength(0);
  });

  it('a merged supplier: spend and cost of sales both include the absorbed purchase, and both drill-downs reconcile', async () => {
    expect(await figure(invOrg, invAug, 'supplier_spend', survivorSupplier), '1,275 + 985').toBe('2260.00');
    const spend = await resolveDescriptor(ctxFor(invOrg), await descriptorOf(invOrg, invAug, 'supplier_spend', survivorSupplier));
    expect(spend.rows.map((r) => r.id)).toContain(absorbedPurchase);
    expect(spend.total).toBe(await figure(invOrg, invAug, 'supplier_spend', survivorSupplier));

    // The P&L side: the expense descriptor (ADR-104) is scoped by supplier and must name both too.
    expect(await figure(invOrg, invAug, 'cost_of_sales')).toBe('2260.00');
    const cos = await descriptorOf(invOrg, invAug, 'cost_of_sales') as { filters: { counterparty_ids: string[] } };
    expect(cos.filters.counterparty_ids.sort()).toEqual([survivorSupplier, absorbedSupplier].sort());
    const cosSel = await resolveDescriptor(ctxFor(invOrg), cos);
    expect(cosSel.rows.map((r) => r.id)).toContain(absorbedPurchase);
    expect(cosSel.count).toBe(2);
    expect(cosSel.total).toBe(await figure(invOrg, invAug, 'cost_of_sales'));
  });

  it('the analyst’s evidence tool cites the absorbed rows and the same total', async () => {
    const snapshotId = String((await currentCells(invOrg, invAug, 'customer_revenue', survivorCustomer))[0]?.snapshot_id);
    const outcome = await TOOLS.find((t) => t.name === 'get_transactions_for_evidence')!.run(
      { metric_snapshot_id: snapshotId }, await callContext(invOrg),
    ) as { ok: boolean; data: { records?: Array<{ id: string }>; sum?: { value: string }; total_count?: { value: string } } };
    expect(outcome.ok).toBe(true);
    expect((outcome.data.records ?? []).map((r) => r.id)).toContain(absorbedSale);
    expect(outcome.data.total_count?.value).toBe('2');
    expect(outcome.data.sum?.value).toBe(await figure(invOrg, invAug, 'customer_revenue', survivorCustomer));
  });
});

describe('ledger basis: the same rule, on a different table', () => {
  it('a merged customer’s ledger entries are in the survivor’s drill-down', async () => {
    expect(await figure(ledOrg, ledAug, 'customer_revenue', ledSurvivor), '3,300 + 725').toBe('4025.00');
    const descriptor = await descriptorOf(ledOrg, ledAug, 'customer_revenue', ledSurvivor) as { table: string };
    expect(descriptor.table).toBe('ledger_entries');
    const selection = await resolveDescriptor(ctxFor(ledOrg), descriptor);
    expect(selection.rows.map((r) => r.id)).toContain(ledAbsorbedEntry);
    expect(selection.count).toBe(2);
    expect(selection.total).toBe(await figure(ledOrg, ledAug, 'customer_revenue', ledSurvivor));
  });
});
