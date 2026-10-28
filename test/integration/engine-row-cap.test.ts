import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drainJobs } from '@/modules/jobs';
import { ensurePeriods } from '@/db/app/shared';
import { orgCollection, orgRow } from '@/db/schema';
import { deleteOrg, drainUntilFinished, fs, serviceClientScoped, rpc } from './setup';
import { seedBatch, seedCounterparty, seedOrg } from '../fixtures/seed';
import {
  bulkWrite, counterpartyRow, currentMoney, deleteJobsOf, invoiceRow, latestJob, seedJob,
} from '../fixtures/engine-helpers';

/**
 * ADR-120 hardening — PostgREST's `max_rows` (1,000) truncated silently, for a FUNCTION's result as
 * for a table's. An organisation with 1,200 customers produced 1,200 aggregate cells and the engine
 * was handed 1,000 of them: revenue 100,000.00 for a month that sold 120,000.00. The Firestore reads
 * have no such cap, and this organisation still sits above 1,000 on each of them, so a cap
 * reintroduced anywhere on the receivables path fails here.
 *
 *   1,200 customers, one sales invoice each: issued 06-05, total 100.00 (no VAT), due 06-20, unpaid
 *   one supplier, created LAST (row 1,201 of counterparties), default category cost_of_sales,
 *     one purchase invoice net 500.00
 *
 *   revenue June            = 1,200 × 100 = 120,000.00
 *   receivables at 06-30    = 120,000.00, all overdue → receivables.deterioration, high
 *   cost_of_sales June      = 500.00 (the supplier's category is found although it is row 1,201)
 */

const TAG = `cap${Date.now().toString(36)}`;
let org: string;

const metric = (key: string): Promise<string | null> => currentMoney(org, '2026-06-01', key);

beforeAll(async () => {
  org = (await seedOrg({ name: `ITest Row cap ${TAG}`, ownerEmail: `owner@${TAG}.cap.itest.motion` })).orgId;
  await ensurePeriods(fs(), org, '2026-06-01', '2026-06-30');

  const list = (importType: string) => seedBatch(org, {
    importType, target: 'invoices', start: '2026-06-01', end: '2026-06-30', listKind: 'full',
    // R-2: a complete export.
    confirmations: { 'IMP-INV-013': { by: null, at: '2026-09-01T00:00:00Z', value: { opening: 'complete' } } },
  });
  const customers = Array.from({ length: 1200 }, (_, g) =>
    counterpartyRow(org, { name: `Customer ${String(g + 1).padStart(4, '0')}`, kind: 'customer' }));
  await bulkWrite(org, 'counterparties', customers);
  const supplier = await seedCounterparty(org, { name: 'Zeta Supplies', kind: 'supplier', defaultExpenseCategory: 'cost_of_sales' });
  await bulkWrite(org, 'invoices', customers.map((c) => invoiceRow(org, {
    type: 'sales', counterpartyId: String(c.id), number: `S${String(c.name)}`, issue: '2026-06-05', due: '2026-06-20',
    subtotal: '100', tax: '0', total: '100', paid: '0', status: 'open',
  })));
  await bulkWrite(org, 'invoices', [invoiceRow(org, {
    type: 'purchase', counterpartyId: supplier, number: 'P1', issue: '2026-06-10', due: '2026-07-10',
    subtotal: '500', tax: '0', total: '500', paid: '0', status: 'open',
  })]);
  await list('sales_invoices');
  await list('purchase_invoices');

  const job = await seedJob(org, 'calculation.run', { trigger: 'recalc_manual', as_of: '2026-09-15' }, { maxAttempts: 3 });
  expect(await drainUntilFinished(drainJobs, job)).toBe('succeeded');
  const alerts = await latestJob(org, 'alerts.evaluate');
  expect(await drainUntilFinished(drainJobs, String(alerts?.id))).toBe('succeeded');
}, 600_000);

afterAll(async () => {
  if (!org) return;
  await deleteJobsOf(org);
  await deleteOrg(org);
});

describe('reads above PostgREST\'s 1,000-row cap are complete (ADR-120 hardening)', () => {
  it('the fixture really is above the cap', async () => {
    const { data } = await rpc<unknown[]>(serviceClientScoped(org), 'aggregate_periods', {
      p_org: org, p_from: '2026-06-01', p_to: '2026-06-30', p_aggregated_at: new Date().toISOString(),
    }, { server: true });
    expect(data?.length).toBeGreaterThan(1000);
  });

  it('revenue counts every invoice, not the first thousand cells', async () => {
    expect(await metric('revenue')).toBe('120000.00');
  });

  it('receivables age every open invoice', async () => {
    expect(await metric('receivables')).toBe('120000.00');
    expect(await metric('receivables_overdue')).toBe('120000.00');
  });

  it('a supplier past the thousandth counterparty still categorises its purchases', async () => {
    expect(await metric('cost_of_sales')).toBe('500.00');
  });

  it('the receivables alert states its facts over the whole population', async () => {
    const alert = (await orgCollection(fs(), org, 'alerts').where('rule_key', '==', 'receivables.deterioration').get()).docs[0]!;
    const revision = await orgRow(fs(), org, 'alert_revisions', String(alert.get('current_revision_id'))).get();
    const summary = revision.get('threshold_summary') as Record<string, string>;
    expect(summary.overdue).toBe('120000.00');
    expect(summary.overdue_count).toBe('10'); // the ten largest are named (TOP_OVERDUE_LIMIT)
    expect(summary.top3_share).toBe('0.002500'); // 300 / 120,000
  });
});
