import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Decimal } from '@/core/money';
import { drainJobs } from '@/modules/jobs';
import { adminSql, clientFor, createAuthUser, drainUntilFinished } from './setup';

/**
 * ADR-120 hardening — PostgREST's `max_rows` (1,000) truncates silently, for a FUNCTION's result as
 * for a table's. An organisation with 1,200 customers produced 1,200 aggregate cells and the engine
 * was handed 1,000 of them: revenue 100,000.00 for a month that sold 120,000.00. Every read on the
 * receivables path now pages; this organisation sits above the cap on each of them.
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
let june: string;
const one = (sql: string): string => adminSql(`with q as (${sql}) select * from q`).split('\n')[0]!.trim();

const metric = (key: string): string | null => {
  const raw = one(`select coalesce(s.value::text, '<null>') from public.metric_current c join public.metric_snapshots s on s.id = c.snapshot_id
    where c.organization_id = '${org}' and c.period_id = '${june}' and c.metric_key = '${key}' and c.dimension_type = 'none'`);
  return raw === '' || raw === '<null>' ? null : new Decimal(raw).toFixed(2);
};

beforeAll(async () => {
  const owner = createAuthUser(`owner@${TAG}.itest`);
  const created = await clientFor(owner).schema('api').rpc('create_organization', { p_name: `Row cap ${TAG}` });
  if (created.error) throw new Error(created.error.message);
  org = created.data as unknown as string;

  const list = (importType: string) => {
    const doc = one(`insert into public.source_documents (organization_id, storage_path, original_filename, mime_type, byte_size, sha256, status, document_kind)
      values ('${org}', '${org}/${importType}.csv', '${importType}.csv', 'text/csv', 10, digest('${org}${importType}', 'sha256'), 'ready', 'invoice') returning id`);
    adminSql(`insert into public.import_batches (organization_id, source_document_id, import_type, target_table, status, extraction_method,
        period_start, period_end, committed_at, invoice_list_kind, confirmations)
      values ('${org}', '${doc}', '${importType}', 'invoices', 'committed', 'csv', '2026-06-01', '2026-06-30', now(), 'full',
        '{"IMP-INV-013": {"by": null, "at": "2026-09-01T00:00:00Z", "value": {"opening": "complete"}}}'::jsonb)`); // R-2: a complete export
  };
  adminSql(`insert into public.counterparties (organization_id, name, kind)
              select '${org}', 'Customer ' || lpad(g::text, 4, '0'), 'customer' from generate_series(1, 1200) g`);
  const supplier = one(`insert into public.counterparties (organization_id, name, kind, default_expense_category)
    values ('${org}', 'Zeta Supplies', 'supplier', 'cost_of_sales') returning id`);
  adminSql(`insert into public.invoices (organization_id, invoice_type, counterparty_id, invoice_number, issue_date, due_date, period_id,
              subtotal, tax_amount, total_amount, amount_paid, status, record_status, assurance_level)
            select '${org}', 'sales', c.id, 'S' || c.name, '2026-06-05', '2026-06-20', '00000000-0000-0000-0000-000000000000',
              100, 0, 100, 0, 'open', 'accepted', 'verified'
              from public.counterparties c where c.organization_id = '${org}' and c.kind = 'customer'`);
  adminSql(`insert into public.invoices (organization_id, invoice_type, counterparty_id, invoice_number, issue_date, due_date, period_id,
              subtotal, tax_amount, total_amount, amount_paid, status, record_status, assurance_level)
            values ('${org}', 'purchase', '${supplier}', 'P1', '2026-06-10', '2026-07-10', '00000000-0000-0000-0000-000000000000',
              500, 0, 500, 0, 'open', 'accepted', 'verified')`);
  list('sales_invoices');
  list('purchase_invoices');
  june = one(`select id from public.fiscal_periods where organization_id = '${org}' and period_start = '2026-06-01'`);

  const job = one(`insert into public.jobs (organization_id, job_type, payload, max_attempts)
    values ('${org}', 'calculation.run', '{"trigger":"recalc_manual","as_of":"2026-09-15"}'::jsonb, 3) returning id`);
  expect(await drainUntilFinished(drainJobs, job)).toBe('succeeded');
  const alerts = one(`select id from public.jobs where organization_id = '${org}' and job_type = 'alerts.evaluate' order by created_at desc limit 1`);
  expect(await drainUntilFinished(drainJobs, alerts)).toBe('succeeded');
}, 600_000);

afterAll(() => {
  adminSql(`delete from public.organizations where id = '${org}'; delete from auth.users where email like '%@${TAG}.itest';`);
});

describe('reads above PostgREST\'s 1,000-row cap are complete (ADR-120 hardening)', () => {
  it('the fixture really is above the cap', () => {
    const cells = Number(one(`select count(*) from app.aggregate_periods('${org}', '2026-06-01', '2026-06-30', now())`));
    expect(cells).toBeGreaterThan(1000);
  });

  it('revenue counts every invoice, not the first thousand cells', () => {
    expect(metric('revenue')).toBe('120000.00');
  });

  it('receivables age every open invoice', () => {
    expect(metric('receivables')).toBe('120000.00');
    expect(metric('receivables_overdue')).toBe('120000.00');
  });

  it('a supplier past the thousandth counterparty still categorises its purchases', () => {
    expect(metric('cost_of_sales')).toBe('500.00');
  });

  it('the receivables alert states its facts over the whole population', () => {
    const summary = JSON.parse(one(`select r.threshold_summary::text from public.alerts a
      join public.alert_revisions r on r.id = a.current_revision_id and r.organization_id = a.organization_id
      where a.organization_id = '${org}' and a.rule_key = 'receivables.deterioration'`)) as Record<string, string>;
    expect(summary.overdue).toBe('120000.00');
    expect(summary.overdue_count).toBe('10'); // the ten largest are named (TOP_OVERDUE_LIMIT)
    expect(summary.top3_share).toBe('0.002500'); // 300 / 120,000
  });
});
