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
const DOMAIN = `${RUN}.merged.itest`;
const one = (sql: string): string => adminSql(`with q as (${sql}) select * from q`).trim();

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

const descriptorOf = (org: string, period: string, key: string, dimensionId: string | null = null): unknown => {
  const raw = one(`select coalesce(s.evidence_query::text, '') from public.metric_current c
     join public.metric_snapshots s on s.id = c.snapshot_id
    where c.organization_id = '${org}' and c.period_id = '${period}' and c.metric_key = '${key}'
      and ${dimensionId === null ? "c.dimension_type = 'none'" : `c.dimension_id = '${dimensionId}'`}`);
  if (raw === '' || raw === 'null') return null;
  return (JSON.parse(raw) as { descriptor: unknown }).descriptor;
};
const figure = (org: string, period: string, key: string, dimensionId: string | null = null): string =>
  new Decimal(one(`select s.value::text from public.metric_current c
     join public.metric_snapshots s on s.id = c.snapshot_id
    where c.organization_id = '${org}' and c.period_id = '${period}' and c.metric_key = '${key}'
      and ${dimensionId === null ? "c.dimension_type = 'none'" : `c.dimension_id = '${dimensionId}'`}`)).toFixed(2);

const counterparty = (org: string, name: string, kind: string, category: string | null = null): string =>
  one(`insert into public.counterparties (organization_id, name, kind, default_expense_category)
       values ('${org}', '${name}', '${kind}', ${category === null ? 'null' : `'${category}'`}) returning id`);
const invoice = (org: string, type: string, cp: string, number: string, subtotal: string, tax: string, total: string): string =>
  one(`insert into public.invoices
      (organization_id, invoice_type, counterparty_id, invoice_number, issue_date, due_date, period_id,
       subtotal, tax_amount, total_amount, amount_paid, status, record_status, assurance_level)
    values ('${org}', '${type}', '${cp}', '${number}', '2026-08-14', '2026-09-13', '00000000-0000-0000-0000-000000000000',
            ${subtotal}, ${tax}, ${total}, 0, 'open', 'accepted', 'verified') returning id`);
async function calculate(org: string): Promise<string> {
  const jobId = adminSql(`insert into public.jobs (organization_id, job_type, payload, max_attempts)
    values ('${org}', 'calculation.run', '{"trigger":"counterparty_merged","as_of":"2026-09-15"}'::jsonb, 3) returning id`).split('\n')[0]!.trim();
  expect(await drainUntilFinished(drainJobs, jobId)).toBe('succeeded');
  return one(`select id from public.fiscal_periods where organization_id = '${org}' and period_start = '2026-08-01'`);
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
  owner = createAuthUser(`owner@${DOMAIN}`);

  // ---- Invoice basis: Northwind (survivor) absorbs "Northwind Traders"; Stock Co absorbs "Stock Co Ltd".
  //   Sales:     Northwind 6,400 · Northwind Traders 2,150   → customer revenue (Northwind) 8,550 · revenue 8,550
  //   Purchases: Stock Co 1,275  · Stock Co Ltd 985          → supplier spend (Stock Co) 2,260 · cost of sales 2,260
  let created = await clientFor(owner).schema('api').rpc('create_organization', { p_name: `ITest Merged Inv ${RUN}` });
  if (created.error) throw new Error(created.error.message);
  invOrg = created.data as unknown as string;
  survivorCustomer = counterparty(invOrg, 'Northwind', 'customer');
  absorbedCustomer = counterparty(invOrg, 'Northwind Traders', 'customer');
  survivorSupplier = counterparty(invOrg, 'Stock Co', 'supplier', 'cost_of_sales');
  absorbedSupplier = counterparty(invOrg, 'Stock Co Ltd', 'supplier', 'cost_of_sales');
  invoice(invOrg, 'sales', survivorCustomer, 'S-1', '6400.00', '1280.00', '7680.00');
  absorbedSale = invoice(invOrg, 'sales', absorbedCustomer, 'S-2', '2150.00', '430.00', '2580.00');
  invoice(invOrg, 'purchase', survivorSupplier, 'P-1', '1275.00', '255.00', '1530.00');
  absorbedPurchase = invoice(invOrg, 'purchase', absorbedSupplier, 'P-2', '985.00', '197.00', '1182.00');
  // The merge as api.merge_counterparties records it: a pointer, and the absorbed party inactive.
  adminSql(`update public.counterparties set merged_into_id = '${survivorCustomer}', is_active = false where id = '${absorbedCustomer}'`);
  adminSql(`update public.counterparties set merged_into_id = '${survivorSupplier}', is_active = false where id = '${absorbedSupplier}'`);
  adminSql(`insert into public.record_status_events (organization_id, record_table, record_id, event)
            select organization_id, 'invoices', id, 'accepted' from public.invoices where organization_id = '${invOrg}'`);
  const doc = one(`insert into public.source_documents
      (organization_id, storage_path, original_filename, mime_type, byte_size, sha256, status, document_kind)
    values ('${invOrg}', '${invOrg}/m/inv.csv', 'inv.csv', 'text/csv', 10, digest('${invOrg}m', 'sha256'), 'ready', 'invoice') returning id`);
  adminSql(`insert into public.import_batches
      (organization_id, source_document_id, import_type, target_table, status, extraction_method, period_start, period_end, committed_at, invoice_list_kind)
    values ('${invOrg}', '${doc}', 'sales_invoices', 'invoices', 'committed', 'csv', '2026-08-01', '2026-08-31', now(), 'full')`);
  // FU-12: costs need a full purchase list (ADR-126).
  adminSql(`insert into public.import_batches
      (organization_id, source_document_id, import_type, target_table, status, extraction_method, period_start, period_end, committed_at, invoice_list_kind)
    values ('${invOrg}', '${doc}', 'purchase_invoices', 'invoices', 'committed', 'csv', '2026-08-01', '2026-08-31', now(), 'full')`);
  invAug = await calculate(invOrg);

  // ---- Ledger basis: Harbour (survivor) absorbs "Harbour (old)"; revenue entries 3,300 + 725 → 4,025.
  created = await clientFor(owner).schema('api').rpc('create_organization', { p_name: `ITest Merged Led ${RUN}` });
  if (created.error) throw new Error(created.error.message);
  ledOrg = created.data as unknown as string;
  ledSurvivor = counterparty(ledOrg, 'Harbour', 'customer');
  const ledAbsorbed = counterparty(ledOrg, 'Harbour (old)', 'customer');
  adminSql(`update public.counterparties set merged_into_id = '${ledSurvivor}', is_active = false where id = '${ledAbsorbed}'`);
  const revenueAccount = one(`select id from public.accounts where organization_id = '${ledOrg}' and standard_category = 'revenue' and is_system`);
  const gdoc = one(`insert into public.source_documents
      (organization_id, storage_path, original_filename, mime_type, byte_size, sha256, status, document_kind)
    values ('${ledOrg}', '${ledOrg}/m/gl.csv', 'gl.csv', 'text/csv', 10, digest('${ledOrg}gl', 'sha256'), 'ready', 'general_ledger') returning id`);
  const batch = one(`insert into public.import_batches
      (organization_id, source_document_id, import_type, target_table, status, extraction_method, period_start, period_end, committed_at)
    values ('${ledOrg}', '${gdoc}', 'general_ledger', 'ledger_entries', 'committed', 'csv', '2026-08-01', '2026-08-31', now()) returning id`);
  const entry = (n: number, cp: string, amount: string): string => {
    const row = one(`insert into public.import_rows (organization_id, batch_id, row_number, source_ref, raw_data, mapped_data, status)
      values ('${ledOrg}', '${batch}', ${n}, 'r${n}', '{}'::jsonb, '{}'::jsonb, 'committed') returning id`);
    const id = one(`insert into public.ledger_entries
        (organization_id, entry_date, account_id, direction, amount, period_id, record_status, source_document_id, import_batch_id, import_row_id, source_ref, counterparty_id)
      values ('${ledOrg}', '2026-08-21', '${revenueAccount}', 'credit', ${amount}, '00000000-0000-0000-0000-000000000000', 'accepted', '${gdoc}', '${batch}', '${row}', 'r${n}', '${cp}') returning id`);
    adminSql(`insert into public.record_status_events (organization_id, record_table, record_id, event, import_batch_id)
              values ('${ledOrg}', 'ledger_entries', '${id}', 'accepted', '${batch}')`);
    return id;
  };
  entry(1, ledSurvivor, '3300.00');
  ledAbsorbedEntry = entry(2, ledAbsorbed, '725.00');
  ledAug = await calculate(ledOrg);
}, 300_000);

afterAll(() => {
  adminSql(`delete from public.organizations where id in ('${invOrg}', '${ledOrg}'); delete from auth.users where email like '%@${DOMAIN}';`);
});

describe('invoice basis: the survivor’s evidence names the parties merged into it (ADR-108)', () => {
  it('a merged customer: the survivor’s revenue includes the absorbed sale, and so does its drill-down', async () => {
    expect(figure(invOrg, invAug, 'customer_revenue', survivorCustomer), '6,400 + 2,150').toBe('8550.00');
    const descriptor = descriptorOf(invOrg, invAug, 'customer_revenue', survivorCustomer) as { filters: { counterparty_ids: string[] } };
    expect(descriptor.filters.counterparty_ids.sort()).toEqual([survivorCustomer, absorbedCustomer].sort());
    const selection = await resolveDescriptor(ctxFor(invOrg), descriptor);
    expect(selection.rows.map((r) => r.id)).toContain(absorbedSale);
    expect(selection.count).toBe(2);
    expect(selection.total).toBe(figure(invOrg, invAug, 'customer_revenue', survivorCustomer));
    // The absorbed party has no figure of its own: it is not a customer any more (ADR-046.2).
    expect(one(`select count(*)::text from public.metric_current c where c.organization_id = '${invOrg}' and c.period_id = '${invAug}'
                 and c.metric_key = 'customer_revenue' and c.dimension_id = '${absorbedCustomer}'`)).toBe('0');
  });

  it('a merged supplier: spend and cost of sales both include the absorbed purchase, and both drill-downs reconcile', async () => {
    expect(figure(invOrg, invAug, 'supplier_spend', survivorSupplier), '1,275 + 985').toBe('2260.00');
    const spend = await resolveDescriptor(ctxFor(invOrg), descriptorOf(invOrg, invAug, 'supplier_spend', survivorSupplier));
    expect(spend.rows.map((r) => r.id)).toContain(absorbedPurchase);
    expect(spend.total).toBe(figure(invOrg, invAug, 'supplier_spend', survivorSupplier));

    // The P&L side: the expense descriptor (ADR-104) is scoped by supplier and must name both too.
    expect(figure(invOrg, invAug, 'cost_of_sales')).toBe('2260.00');
    const cos = descriptorOf(invOrg, invAug, 'cost_of_sales') as { filters: { counterparty_ids: string[] } };
    expect(cos.filters.counterparty_ids.sort()).toEqual([survivorSupplier, absorbedSupplier].sort());
    const cosSel = await resolveDescriptor(ctxFor(invOrg), cos);
    expect(cosSel.rows.map((r) => r.id)).toContain(absorbedPurchase);
    expect(cosSel.count).toBe(2);
    expect(cosSel.total).toBe(figure(invOrg, invAug, 'cost_of_sales'));
  });

  it('the analyst’s evidence tool cites the absorbed rows and the same total', async () => {
    const snapshotId = one(`select c.snapshot_id::text from public.metric_current c where c.organization_id = '${invOrg}'
      and c.period_id = '${invAug}' and c.metric_key = 'customer_revenue' and c.dimension_id = '${survivorCustomer}'`);
    const outcome = await TOOLS.find((t) => t.name === 'get_transactions_for_evidence')!.run(
      { metric_snapshot_id: snapshotId }, await callContext(invOrg),
    ) as { ok: boolean; data: { records?: Array<{ id: string }>; sum?: { value: string }; total_count?: { value: string } } };
    expect(outcome.ok).toBe(true);
    expect((outcome.data.records ?? []).map((r) => r.id)).toContain(absorbedSale);
    expect(outcome.data.total_count?.value).toBe('2');
    expect(outcome.data.sum?.value).toBe(figure(invOrg, invAug, 'customer_revenue', survivorCustomer));
  });
});

describe('ledger basis: the same rule, on a different table', () => {
  it('a merged customer’s ledger entries are in the survivor’s drill-down', async () => {
    expect(figure(ledOrg, ledAug, 'customer_revenue', ledSurvivor), '3,300 + 725').toBe('4025.00');
    const descriptor = descriptorOf(ledOrg, ledAug, 'customer_revenue', ledSurvivor) as { table: string };
    expect(descriptor.table).toBe('ledger_entries');
    const selection = await resolveDescriptor(ctxFor(ledOrg), descriptor);
    expect(selection.rows.map((r) => r.id)).toContain(ledAbsorbedEntry);
    expect(selection.count).toBe(2);
    expect(selection.total).toBe(figure(ledOrg, ledAug, 'customer_revenue', ledSurvivor));
  });
});
