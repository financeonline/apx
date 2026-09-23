import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { Decimal } from '@/core/money';
import { permissionsFor } from '@/core/permissions';
import { resolveDescriptor } from '@/modules/evidence';
import { drainJobs } from '@/modules/jobs';
import type { AccessContext } from '@/modules/tenancy';
import { adminSql, clientFor, createAuthUser, drainUntilFinished } from './setup';

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
const DOMAIN = `${RUN}.evidence.itest`;
const one = (sql: string): string => adminSql(`with q as (${sql}) select * from q`).trim();

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

const descriptorOf = (key: string): unknown => {
  const raw = one(`select coalesce(s.evidence_query::text, '') from public.metric_current c
     join public.metric_snapshots s on s.id = c.snapshot_id
    where c.organization_id = '${org}' and c.period_id = '${aug}' and c.metric_key = '${key}' and c.dimension_type = 'none'`);
  // The engine writes JSON null where a figure has no descriptor (a category nobody's purchases went into).
  if (raw === '' || raw === 'null') return null;
  return (JSON.parse(raw) as { descriptor: unknown }).descriptor;
};
const figure = (key: string): string => new Decimal(one(`select s.value::text from public.metric_current c
     join public.metric_snapshots s on s.id = c.snapshot_id
    where c.organization_id = '${org}' and c.period_id = '${aug}' and c.metric_key = '${key}' and c.dimension_type = 'none'`)).toFixed(2);

beforeAll(async () => {
  owner = createAuthUser(`owner@${DOMAIN}`);
  const created = await clientFor(owner).schema('api').rpc('create_organization', { p_name: `ITest Evidence ${RUN}` });
  if (created.error) throw new Error(created.error.message);
  org = created.data as unknown as string;

  const counterparty = (name: string, kind: string, category: string | null): string =>
    one(`insert into public.counterparties (organization_id, name, kind, default_expense_category)
         values ('${org}', '${name}', '${kind}', ${category === null ? 'null' : `'${category}'`}) returning id`);
  const invoice = (type: string, cp: string, number: string, subtotal: string, tax: string, total: string, paid: string): string =>
    one(`insert into public.invoices
        (organization_id, invoice_type, counterparty_id, invoice_number, issue_date, due_date, period_id,
         subtotal, tax_amount, total_amount, amount_paid, status, record_status, assurance_level)
      values ('${org}', '${type}', '${cp}', '${number}', '2026-08-10', '2026-09-09', '00000000-0000-0000-0000-000000000000',
              ${subtotal}, ${tax}, ${total}, ${paid}, '${paid === total ? 'paid' : 'open'}', 'accepted', 'verified') returning id`);

  /*
   *   Sale      Big Client   net 10,000  gross 12,000  FULLY PAID  (balance_due 0)
   *   Purchase  Stock A      net  1,800  gross  2,160  unpaid      (balance_due 2,160)
   *   Purchase  Stock B      net  1,200  gross  1,440  paid 700    (balance_due   740)
   *   Purchase  Stock C      net    500  gross    600  FULLY PAID  (balance_due     0)
   *   Purchase  Ads          net  1,000  gross  1,200  unpaid      (marketing, not cost of sales)
   *
   *   cost_of_sales = 1,800 + 1,200 + 500 = 3,500 · revenue = 10,000 · payables = 2,160 + 740 + 1,200 = 4,100
   */
  const customer = counterparty('Big Client', 'customer', null);
  stockA = counterparty('Stock A', 'supplier', 'cost_of_sales');
  stockB = counterparty('Stock B', 'supplier', 'cost_of_sales');
  stockC = counterparty('Stock C', 'supplier', 'cost_of_sales');
  const ads = counterparty('Ads', 'supplier', 'marketing');
  invoice('sales', customer, 'S-1', '10000.00', '2000.00', '12000.00', '12000.00');
  invoice('purchase', stockA, 'P-A', '1800.00', '360.00', '2160.00', '0');
  invoice('purchase', stockB, 'P-B', '1200.00', '240.00', '1440.00', '700.00');
  invoice('purchase', stockC, 'P-C', '500.00', '100.00', '600.00', '600.00');
  invoice('purchase', ads, 'P-D', '1000.00', '200.00', '1200.00', '0');
  // The lifecycle events a real commit writes; the as-of projection reads them (ADR-034).
  adminSql(`insert into public.record_status_events (organization_id, record_table, record_id, event)
            select organization_id, 'invoices', id, 'accepted' from public.invoices where organization_id = '${org}'`);
  const doc = one(`insert into public.source_documents
      (organization_id, storage_path, original_filename, mime_type, byte_size, sha256, status, document_kind)
    values ('${org}', '${org}/evidence/inv.csv', 'inv.csv', 'text/csv', 10, digest('${org}ev', 'sha256'), 'ready', 'invoice') returning id`);
  adminSql(`insert into public.import_batches
      (organization_id, source_document_id, import_type, target_table, status, extraction_method, period_start, period_end, committed_at, invoice_list_kind)
    values ('${org}', '${doc}', 'sales_invoices', 'invoices', 'committed', 'csv', '2026-08-01', '2026-08-31', now(), 'full')`);

  const jobId = adminSql(`insert into public.jobs (organization_id, job_type, payload, max_attempts)
    values ('${org}', 'calculation.run', '{"trigger":"recalc_manual","as_of":"2026-09-15"}'::jsonb, 3) returning id`).split('\n')[0]!.trim();
  expect(await drainUntilFinished(drainJobs, jobId)).toBe('succeeded');
  aug = one(`select id from public.fiscal_periods where organization_id = '${org}' and period_start = '2026-08-01'`);
}, 300_000);

afterAll(() => {
  adminSql(`delete from public.organizations where id = '${org}'; delete from auth.users where email like '%@${DOMAIN}';`);
});

describe('the rows behind an invoice-basis figure add up to the figure (ADR-105)', () => {
  it('cost of sales: unpaid, partly paid and fully paid supplier invoices each show their net, and sum to 3,500', async () => {
    expect(figure('cost_of_sales')).toBe('3500.00');
    const selection = await resolveDescriptor(ctx(), descriptorOf('cost_of_sales'));
    const byCounterparty = new Map(selection.rows.map((r) => [r.counterpartyId, r.amount]));
    expect(byCounterparty.get(stockA), 'unpaid: net, not the 2,160 owed').toBe('1800.00');
    expect(byCounterparty.get(stockB), 'partly paid: net, not the 740 still owed').toBe('1200.00');
    expect(byCounterparty.get(stockC), 'fully paid: net, not 0').toBe('500.00');
    expect(selection.count).toBe(3);
    expect(selection.total).toBe(figure('cost_of_sales'));
  });

  it('revenue: a fully paid sale is still the 10,000 it invoiced, not 0', async () => {
    expect(figure('revenue')).toBe('10000.00');
    const selection = await resolveDescriptor(ctx(), descriptorOf('revenue'));
    expect(selection.rows.map((r) => r.amount)).toEqual(['10000.00']);
    expect(selection.total).toBe('10000.00');
  });

  it('operating expenses: only the marketing supplier, and its net', async () => {
    const selection = await resolveDescriptor(ctx(), descriptorOf('operating_expenses'));
    expect(selection.rows.map((r) => r.amount)).toEqual(['1000.00']);
    expect(selection.total).toBe(figure('operating_expenses'));
  });

  it('a category nobody’s purchases went into has no descriptor at all', () => {
    expect(descriptorOf('other_expense')).toBeNull();
    expect(descriptorOf('interest_expense')).toBeNull();
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
