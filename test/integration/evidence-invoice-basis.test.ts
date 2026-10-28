import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { Decimal } from '@/core/money';
import { permissionsFor } from '@/core/permissions';
import { resolveDescriptor } from '@/modules/evidence';
import type { AccessContext } from '@/modules/tenancy';
import { periodId } from '@/db/app/shared';
import { clientFor, createAuthUser, deleteOrg, drainUntilFinished } from './setup';
import { createOrgFixture } from './r-fixtures';
import {
  currentSnapshot, deleteAuthUsers, drainShared, deleteJobsOf, queueCalculation, seedBatch, seedCounterparty, seedDocument,
  seedInvoice, seedStatusEvent,
} from './evidence-fixtures';

/**
 * Evidence behind an invoice-basis P&L figure reconciles to the figure (ADR-105).
 *
 * The rows were already the right rows (ADR-104 scoped them by supplier). What they SUMMED to was
 * `balance_due` — the receivables column — so "Cost of sales £3,000" listed rows totalling the gross
 * still owed, and a paid sale sat under "Revenue" as £0. The amount is now the engine's net-of-tax
 * figure per row, signed by type, which is what the P&L added up. Receivables and payables keep
 * `balance_due`, because Σ balance_due IS those figures.
 *
 * One organisation, one month, with every payment state the brief names.
 */

const RUN = `ev${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.evidence.itest.motion`;

let owner: string;
let org: string;
let aug: string;
let stockA: string;
let stockB: string;
let stockC: string;

const ctx = (): AccessContext => ({
  userId: owner, orgId: org, orgSlug: 'evidence', effectiveRole: 'owner', permissions: permissionsFor('owner'),
  actorType: 'user', db: clientFor(owner), requestId: `itest-${RUN}`, now: () => new Date('2026-09-15T00:00:00Z'), organizationStatus: 'active',
});

const descriptorOf = async (key: string): Promise<unknown> => {
  const s = await currentSnapshot(org, aug, key);
  // The engine writes JSON null where a figure has no descriptor (a category nobody's purchases went into).
  const q = (s?.evidence_query ?? null) as { descriptor: unknown } | null;
  return q === null ? null : q.descriptor;
};
const figure = async (key: string): Promise<string> =>
  new Decimal(String((await currentSnapshot(org, aug, key))?.value)).toFixed(2);

beforeAll(async () => {
  owner = await createAuthUser(`owner@${DOMAIN}`);
  org = (await createOrgFixture({ name: `ITest Evidence ${RUN}`, ownerId: owner })).id;

  const counterparty = (name: string, kind: string, category: string | null) =>
    seedCounterparty(org, { name, kind, defaultExpenseCategory: category });
  const invoice = (type: string, cp: string, number: string, subtotal: string, tax: string, total: string, paid: string) =>
    seedInvoice(org, {
      type, counterpartyId: cp, number, issueDate: '2026-08-10', dueDate: '2026-09-09',
      subtotal, tax, total, paid, recordStatus: 'accepted', assurance: 'verified',
    });

  /*
   *   Sale      Big Client   net 10,000  gross 12,000  FULLY PAID  (balance_due 0)
   *   Purchase  Stock A      net  1,800  gross  2,160  unpaid      (balance_due 2,160)
   *   Purchase  Stock B      net  1,200  gross  1,440  paid 700    (balance_due   740)
   *   Purchase  Stock C      net    500  gross    600  FULLY PAID  (balance_due     0)
   *   Purchase  Ads          net  1,000  gross  1,200  unpaid      (marketing, not cost of sales)
   *
   *   cost_of_sales = 1,800 + 1,200 + 500 = 3,500 · revenue = 10,000 · payables = 2,160 + 740 + 1,200 = 4,100
   */
  const customer = await counterparty('Big Client', 'customer', null);
  stockA = await counterparty('Stock A', 'supplier', 'cost_of_sales');
  stockB = await counterparty('Stock B', 'supplier', 'cost_of_sales');
  stockC = await counterparty('Stock C', 'supplier', 'cost_of_sales');
  const ads = await counterparty('Ads', 'supplier', 'marketing');
  const ids = [
    await invoice('sales', customer, 'S-1', '10000.00', '2000.00', '12000.00', '12000.00'),
    await invoice('purchase', stockA, 'P-A', '1800.00', '360.00', '2160.00', '0'),
    await invoice('purchase', stockB, 'P-B', '1200.00', '240.00', '1440.00', '700.00'),
    await invoice('purchase', stockC, 'P-C', '500.00', '100.00', '600.00', '600.00'),
    await invoice('purchase', ads, 'P-D', '1000.00', '200.00', '1200.00', '0'),
  ];
  // The lifecycle events a real commit writes; the as-of projection reads them (ADR-034).
  for (const id of ids) await seedStatusEvent(org, { table: 'invoices', recordId: id, event: 'accepted' });
  const doc = await seedDocument(org, { name: 'inv.csv', kind: 'invoice' });
  await seedBatch(org, {
    documentId: doc, importType: 'sales_invoices', targetTable: 'invoices', status: 'committed',
    periodStart: '2026-08-01', periodEnd: '2026-08-31', invoiceListKind: 'full',
  });
  // FU-12: costs need a full purchase list (ADR-126).
  await seedBatch(org, {
    documentId: doc, importType: 'purchase_invoices', targetTable: 'invoices', status: 'committed',
    periodStart: '2026-08-01', periodEnd: '2026-08-31', invoiceListKind: 'full',
  });

  const jobId = await queueCalculation(org, { trigger: 'recalc_manual', as_of: '2026-09-15' });
  expect(await drainUntilFinished(drainShared, jobId)).toBe('succeeded');
  aug = periodId(org, '2026-08-01');
}, 300_000);

afterAll(async () => {
  await deleteJobsOf(org);
  await deleteOrg(org);
  await deleteAuthUsers(DOMAIN);
});

describe('the rows behind an invoice-basis figure add up to the figure (ADR-105)', () => {
  it('cost of sales: unpaid, partly paid and fully paid supplier invoices each show their net, and sum to 3,500', async () => {
    expect(await figure('cost_of_sales')).toBe('3500.00');
    const selection = await resolveDescriptor(ctx(), await descriptorOf('cost_of_sales'));
    const byCounterparty = new Map(selection.rows.map((r) => [r.counterpartyId, r.amount]));
    expect(byCounterparty.get(stockA), 'unpaid: net, not the 2,160 owed').toBe('1800.00');
    expect(byCounterparty.get(stockB), 'partly paid: net, not the 740 still owed').toBe('1200.00');
    expect(byCounterparty.get(stockC), 'fully paid: net, not 0').toBe('500.00');
    expect(selection.count).toBe(3);
    expect(selection.total).toBe(await figure('cost_of_sales'));
  });

  it('revenue: a fully paid sale is still the 10,000 it invoiced, not 0', async () => {
    expect(await figure('revenue')).toBe('10000.00');
    const selection = await resolveDescriptor(ctx(), await descriptorOf('revenue'));
    expect(selection.rows.map((r) => r.amount)).toEqual(['10000.00']);
    expect(selection.total).toBe('10000.00');
  });

  it('operating expenses: only the marketing supplier, and its net', async () => {
    const selection = await resolveDescriptor(ctx(), await descriptorOf('operating_expenses'));
    expect(selection.rows.map((r) => r.amount)).toEqual(['1000.00']);
    expect(selection.total).toBe(await figure('operating_expenses'));
  });

  it('a category nobody’s purchases went into has no descriptor at all', async () => {
    expect(await descriptorOf('other_expense')).toBeNull();
    expect(await descriptorOf('interest_expense')).toBeNull();
  });

  it('a receivables/payables-shaped descriptor keeps the balance still owed, which IS that figure', async () => {
    // The as-of shape the AR/AP families write: open items at a date. Σ balance_due is the figure,
    // so the projection stays on balance_due — 2,160 + 740 + 0 + 1,200 = 4,100, and the paid one is 0.
    const selection = await resolveDescriptor(ctx(), {
      v: 1, table: 'invoices',
      filters: { period_ids: [aug], invoice_types: ['purchase', 'purchase_credit_note'], open_as_of: '2026-09-15' },
    });
    expect(selection.total).toBe('4100.00');
    const owed = (id: string) => new Decimal(selection.rows.find((r) => r.counterpartyId === id)?.amount ?? '0').toFixed(2);
    expect(owed(stockC)).toBe('0.00');
    expect(owed(stockA)).toBe('2160.00');
  });
});
