import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { Decimal } from '@/core/money';
import { permissionsFor } from '@/core/permissions';
import { resolvePeriodContext, TOOLS } from '@/modules/ai';
import { loadPeriods, loadPeriodsWithData } from '@/modules/dashboard';
import { resolveDescriptor } from '@/modules/evidence';
import { drainJobs } from '@/modules/jobs';
import type { AccessContext } from '@/modules/tenancy';
import { adminSql, clientFor, createAuthUser, drainUntilFinished } from './setup';

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
const DOMAIN = `${RUN}.void.itest`;
const one = (sql: string): string => adminSql(`with q as (${sql}) select * from q`).trim();

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

const descriptorOf = (key: string, dimensionId: string | null = null): unknown => {
  const raw = one(`select coalesce(s.evidence_query::text, '') from public.metric_current c
     join public.metric_snapshots s on s.id = c.snapshot_id
    where c.organization_id = '${org}' and c.period_id = '${aug}' and c.metric_key = '${key}'
      and ${dimensionId === null ? "c.dimension_type = 'none'" : `c.dimension_id = '${dimensionId}'`}`);
  if (raw === '' || raw === 'null') return null;
  return (JSON.parse(raw) as { descriptor: unknown }).descriptor;
};

const figure = (key: string, dimensionId: string | null = null): string =>
  new Decimal(one(`select s.value::text from public.metric_current c
     join public.metric_snapshots s on s.id = c.snapshot_id
    where c.organization_id = '${org}' and c.period_id = '${aug}' and c.metric_key = '${key}'
      and ${dimensionId === null ? "c.dimension_type = 'none'" : `c.dimension_id = '${dimensionId}'`}`)).toFixed(2);

beforeAll(async () => {
  owner = createAuthUser(`owner@${DOMAIN}`);
  const created = await clientFor(owner).schema('api').rpc('create_organization', { p_name: `ITest Void ${RUN}` });
  if (created.error) throw new Error(created.error.message);
  org = created.data as unknown as string;

  const counterparty = (name: string, kind: string, category: string | null): string =>
    one(`insert into public.counterparties (organization_id, name, kind, default_expense_category)
         values ('${org}', '${name}', '${kind}', ${category === null ? 'null' : `'${category}'`}) returning id`);
  const invoice = (
    type: string, cp: string, number: string, subtotal: string, tax: string, total: string, status: string,
  ): string =>
    one(`insert into public.invoices
        (organization_id, invoice_type, counterparty_id, invoice_number, issue_date, due_date, period_id,
         subtotal, tax_amount, total_amount, amount_paid, status, record_status, assurance_level)
      values ('${org}', '${type}', '${cp}', '${number}', '2026-08-10', '2026-09-09', '00000000-0000-0000-0000-000000000000',
              ${subtotal}, ${tax}, ${total}, 0, '${status}', 'accepted', 'verified') returning id`);

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
  customer = counterparty('Big Client', 'customer', null);
  stock = counterparty('Stock Co', 'supplier', 'cost_of_sales');
  const ads = counterparty('Ads Co', 'supplier', 'marketing');

  invoice('sales', customer, 'S-1', '20000.00', '4000.00', '24000.00', 'open');
  voidedSale = invoice('sales', customer, 'S-VOID', '12345.00', '2469.00', '14814.00', 'void');
  invoice('purchase', stock, 'P-1', '3300.00', '660.00', '3960.00', 'open');
  voidedPurchase = invoice('purchase', stock, 'P-VOID', '9999.00', '1999.80', '11998.80', 'void');
  supersededPurchase = invoice('purchase', stock, 'P-OLD', '1111.00', '222.20', '1333.20', 'open');
  const replacement = invoice('purchase', stock, 'P-NEW', '2222.00', '444.40', '2666.40', 'open');
  adminSql(`update public.invoices set superseded_by = '${replacement}' where id = '${supersededPurchase}'`);
  invoice('purchase', ads, 'P-ADS', '750.00', '150.00', '900.00', 'open');

  // The lifecycle events a real commit writes; the as-of projection reads them (ADR-034).
  adminSql(`insert into public.record_status_events (organization_id, record_table, record_id, event)
            select organization_id, 'invoices', id, 'accepted' from public.invoices where organization_id = '${org}'`);
  adminSql(`insert into public.record_status_events (organization_id, record_table, record_id, event)
            values ('${org}', 'invoices', '${supersededPurchase}', 'superseded')`);

  const doc = one(`insert into public.source_documents
      (organization_id, storage_path, original_filename, mime_type, byte_size, sha256, status, document_kind)
    values ('${org}', '${org}/void/inv.csv', 'inv.csv', 'text/csv', 10, digest('${org}void', 'sha256'), 'ready', 'invoice') returning id`);
  adminSql(`insert into public.import_batches
      (organization_id, source_document_id, import_type, target_table, status, extraction_method, period_start, period_end, committed_at, invoice_list_kind)
    values ('${org}', '${doc}', 'sales_invoices', 'invoices', 'committed', 'csv', '2026-08-01', '2026-08-31', now(), 'full')`);
  // FU-12: costs need a full purchase list (ADR-126).
  adminSql(`insert into public.import_batches
      (organization_id, source_document_id, import_type, target_table, status, extraction_method, period_start, period_end, committed_at, invoice_list_kind)
    values ('${org}', '${doc}', 'purchase_invoices', 'invoices', 'committed', 'csv', '2026-08-01', '2026-08-31', now(), 'full')`);

  const jobId = adminSql(`insert into public.jobs (organization_id, job_type, payload, max_attempts)
    values ('${org}', 'calculation.run', '{"trigger":"recalc_manual","as_of":"2026-09-15"}'::jsonb, 3) returning id`).split('\n')[0]!.trim();
  expect(await drainUntilFinished(drainJobs, jobId)).toBe('succeeded');
  aug = one(`select id from public.fiscal_periods where organization_id = '${org}' and period_start = '2026-08-01'`);
}, 300_000);

afterAll(() => {
  adminSql(`delete from public.organizations where id = '${org}'; delete from auth.users where email like '%@${DOMAIN}';`);
});

describe('a voided invoice is in no figure, so it is in no evidence either (ADR-107)', () => {
  it('cost of sales: the void is absent, the superseding invoice is present, and the rows sum to the figure', async () => {
    expect(figure('cost_of_sales'), '3,300 + 2,222; the 9,999 void and the 1,111 superseded are in neither').toBe('5522.00');
    const selection = await resolveDescriptor(ctx(), descriptorOf('cost_of_sales'));
    const ids = selection.rows.map((r) => r.id);
    expect(ids, 'the voided purchase contributes nothing').not.toContain(voidedPurchase);
    expect(ids, 'the superseded purchase is still excluded').not.toContain(supersededPurchase);
    expect(selection.count, 'two rows: the 3,300 and the 2,222 that replaced the 1,111').toBe(2);
    expect(selection.rows.map((r) => r.amount).sort()).toEqual(['2222.00', '3300.00']);
    expect(selection.total).toBe(figure('cost_of_sales'));
  });

  it('revenue: a voided sale is neither in the figure nor in the rows behind it', async () => {
    expect(figure('revenue')).toBe('20000.00');
    const selection = await resolveDescriptor(ctx(), descriptorOf('revenue'));
    expect(selection.rows.map((r) => r.id), 'the 12,345 void').not.toContain(voidedSale);
    expect(selection.count).toBe(1);
    expect(selection.total).toBe(figure('revenue'));
  });

  it('customer revenue: the same customer’s voided sale is out of their drill-down too', async () => {
    expect(figure('customer_revenue', customer)).toBe('20000.00');
    const selection = await resolveDescriptor(ctx(), descriptorOf('customer_revenue', customer));
    expect(selection.rows.map((r) => r.id)).not.toContain(voidedSale);
    expect(selection.total).toBe(figure('customer_revenue', customer));
  });

  it('operating expenses: unaffected, and still the marketing supplier only', async () => {
    expect(figure('operating_expenses')).toBe('750.00');
    const selection = await resolveDescriptor(ctx(), descriptorOf('operating_expenses'));
    expect(selection.rows.map((r) => r.amount)).toEqual(['750.00']);
    expect(selection.total).toBe(figure('operating_expenses'));
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
    const snapshotId = one(`select c.snapshot_id::text from public.metric_current c
      where c.organization_id = '${org}' and c.period_id = '${aug}'
        and c.metric_key = 'cost_of_sales' and c.dimension_type = 'none'`);
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
    expect(data.sum?.value, 'what the analyst cites must be the figure it sits behind').toBe(figure('cost_of_sales'));
  });
});
