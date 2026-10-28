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
  currentCells, deleteAuthUsers, drainShared, deleteJobsOf, descriptorOfFigure, figureOf, queueCalculation, seedBatch,
  seedCounterparty, seedDocument, seedInvoice, seedStatusEvent,
} from './evidence-fixtures';

/**
 * A voided invoice is not evidence of anything (ADR-107).
 *
 * `app.aggregate_periods` reads invoices under `record_status = 'accepted' and superseded_by is null
 * and status <> 'void'`. Evidence carried the first two clauses and not the third, because the
 * lifecycle pair lives in the shared block while `status <> 'void'` sat inside the helper that
 * builds the receivables shape. So the drill-down behind revenue, cost of sales, an expense category
 * and a customer's revenue listed voided invoices, and from ADR-105 each contributed its full net.
 *
 * Supersession was never broken and is asserted here beside the void, because they are different
 * concepts reached by different mechanisms: supersession through `record_status_events`, a void
 * through the invoice's own business status, which has no lifecycle event.
 */

const RUN = `vd${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.void.itest.motion`;

let owner: string;
let org: string;
let aug: string;
let stock: string;
let customer: string;
let voidedSale: string;
let voidedPurchase: string;
let supersededPurchase: string;

const ctx = (): AccessContext => ({
  userId: owner, orgId: org, orgSlug: 'void', effectiveRole: 'owner', permissions: permissionsFor('owner'),
  actorType: 'user', db: clientFor(owner), requestId: `itest-${RUN}`,
  now: () => new Date('2026-09-15T00:00:00Z'), organizationStatus: 'active',
});

const descriptorOf = (key: string, dimensionId: string | null = null) => descriptorOfFigure(org, aug, key, dimensionId);
const figure = (key: string, dimensionId: string | null = null) => figureOf(org, aug, key, dimensionId);

beforeAll(async () => {
  owner = await createAuthUser(`owner@${DOMAIN}`);
  org = (await createOrgFixture({ name: `ITest Void ${RUN}`, ownerId: owner })).id;

  const counterparty = (name: string, kind: string, category: string | null) =>
    seedCounterparty(org, { name, kind, defaultExpenseCategory: category });
  const ids: string[] = [];
  const invoice = async (
    type: string, cp: string, number: string, subtotal: string, tax: string, total: string, status: string,
  ): Promise<string> => {
    const id = await seedInvoice(org, {
      type, counterpartyId: cp, number, issueDate: '2026-08-10', dueDate: '2026-09-09', subtotal, tax, total,
      paid: '0', status, recordStatus: 'accepted', assurance: 'verified',
    });
    ids.push(id);
    return id;
  };

  /*
   * Deliberately loud amounts: a wrongly included row cannot be mistaken for a rounding difference.
   *
   *   Sale      Big Client  net 20,000  open      -> revenue, customer revenue
   *   Sale      Big Client  net 12,345  VOID      -> in NEITHER
   *   Purchase  Stock Co    net  3,300  open      -> cost of sales
   *   Purchase  Stock Co    net  9,999  VOID      -> in neither, and the SAME supplier, so the
   *                                                  supplier scoping of ADR-104 cannot hide it
   *   Purchase  Stock Co    net  1,111  SUPERSEDED by the 2,222 below
   *   Purchase  Stock Co    net  2,222  open      -> cost of sales
   *   Purchase  Ads Co      net    750  open      -> operating expenses (marketing)
   *
   *   revenue 20,000 · cost_of_sales 5,522 · operating_expenses 750 · customer revenue 20,000
   */
  customer = await counterparty('Big Client', 'customer', null);
  stock = await counterparty('Stock Co', 'supplier', 'cost_of_sales');
  const ads = await counterparty('Ads Co', 'supplier', 'marketing');

  await invoice('sales', customer, 'S-1', '20000.00', '4000.00', '24000.00', 'open');
  voidedSale = await invoice('sales', customer, 'S-VOID', '12345.00', '2469.00', '14814.00', 'void');
  await invoice('purchase', stock, 'P-1', '3300.00', '660.00', '3960.00', 'open');
  voidedPurchase = await invoice('purchase', stock, 'P-VOID', '9999.00', '1999.80', '11998.80', 'void');
  supersededPurchase = await invoice('purchase', stock, 'P-OLD', '1111.00', '222.20', '1333.20', 'open');
  const replacement = await invoice('purchase', stock, 'P-NEW', '2222.00', '444.40', '2666.40', 'open');
  await orgRow(fs(), org, 'invoices', supersededPurchase).update({ superseded_by: replacement, superseded_at: new Date().toISOString() });
  await invoice('purchase', ads, 'P-ADS', '750.00', '150.00', '900.00', 'open');

  // The lifecycle events a real commit writes; the as-of projection reads them (ADR-034).
  for (const id of ids) await seedStatusEvent(org, { table: 'invoices', recordId: id, event: 'accepted' });
  await seedStatusEvent(org, { table: 'invoices', recordId: supersededPurchase, event: 'superseded' });

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

describe('a voided invoice is in no figure, so it is in no evidence either (ADR-107)', () => {
  it('cost of sales: the void is absent, the superseding invoice is present, and the rows sum to the figure', async () => {
    expect(await figure('cost_of_sales'), '3,300 + 2,222; the 9,999 void and the 1,111 superseded are in neither').toBe('5522.00');
    const selection = await resolveDescriptor(ctx(), await descriptorOf('cost_of_sales'));
    const ids = selection.rows.map((r) => r.id);
    expect(ids, 'the voided purchase contributes nothing').not.toContain(voidedPurchase);
    expect(ids, 'the superseded purchase is still excluded').not.toContain(supersededPurchase);
    expect(selection.count, 'two rows: the 3,300 and the 2,222 that replaced the 1,111').toBe(2);
    expect(selection.rows.map((r) => r.amount).sort()).toEqual(['2222.00', '3300.00']);
    expect(selection.total).toBe(await figure('cost_of_sales'));
  });

  it('revenue: a voided sale is neither in the figure nor in the rows behind it', async () => {
    expect(await figure('revenue')).toBe('20000.00');
    const selection = await resolveDescriptor(ctx(), await descriptorOf('revenue'));
    expect(selection.rows.map((r) => r.id), 'the 12,345 void').not.toContain(voidedSale);
    expect(selection.count).toBe(1);
    expect(selection.total).toBe(await figure('revenue'));
  });

  it('customer revenue: the same customer’s voided sale is out of their drill-down too', async () => {
    expect(await figure('customer_revenue', customer)).toBe('20000.00');
    const selection = await resolveDescriptor(ctx(), await descriptorOf('customer_revenue', customer));
    expect(selection.rows.map((r) => r.id)).not.toContain(voidedSale);
    expect(selection.total).toBe(await figure('customer_revenue', customer));
  });

  it('operating expenses: unaffected, and still the marketing supplier only', async () => {
    expect(await figure('operating_expenses')).toBe('750.00');
    const selection = await resolveDescriptor(ctx(), await descriptorOf('operating_expenses'));
    expect(selection.rows.map((r) => r.amount)).toEqual(['750.00']);
    expect(selection.total).toBe(await figure('operating_expenses'));
  });

  it('the analyst’s evidence tool cannot return a voided invoice as supporting evidence', async () => {
    const rows = await loadPeriods(clientFor(owner), org, `itest-${RUN}`);
    const withData = await loadPeriodsWithData(clientFor(owner), org, `itest-${RUN}`);
    const periodContext = resolvePeriodContext({
      question: 'how did Aug 2026 go?',
      fiscalYearStartMonth: 1,
      periods: rows.map((p) => ({
        id: p.id, label: p.label, periodStart: p.periodStart, isComplete: p.isComplete, hasData: withData.has(p.id),
      })),
    });
    const snapshotId = String((await currentCells(org, aug, 'cost_of_sales'))[0]?.snapshot_id);
    const outcome = await TOOLS.find((t) => t.name === 'get_transactions_for_evidence')!.run(
      { metric_snapshot_id: snapshotId },
      { ctx: ctx(), periodContext, knownPeriods: [], now: new Date('2026-09-15T00:00:00Z') },
    );
    const data = (outcome as {
      ok: boolean;
      data: { records?: Array<{ id: string }>; sum?: { value: string }; total_count?: { value: string } };
    }).data;
    expect((outcome as { ok: boolean }).ok).toBe(true);
    expect((data.records ?? []).map((r) => r.id)).not.toContain(voidedPurchase);
    expect(data.total_count?.value).toBe('2');
    expect(data.sum?.value, 'what the analyst cites must be the figure it sits behind').toBe(await figure('cost_of_sales'));
  });
});
