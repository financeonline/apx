import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { Decimal } from '@/core/money';
import { drainJobs } from '@/modules/jobs';
import { adminSql, clientFor, createAuthUser, drainUntilFinished } from './setup';

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
const DOMAIN = `${RUN}.invoice.itest`;
const one = (sql: string): string => adminSql(`with q as (${sql}) select * from q`);

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

function seedInvoices(org: string, rows: readonly InvoiceInput[]): void {
  for (const r of rows) {
    adminSql(`insert into public.invoices
        (organization_id, invoice_type, counterparty_id, invoice_number, issue_date, due_date,
         period_id, subtotal, tax_amount, total_amount, amount_paid, status, record_status, assurance_level)
      values ('${org}', '${r.type}', '${r.counterparty}', '${r.number}', '${r.date}', '${r.date}',
              '00000000-0000-0000-0000-000000000000',
              ${r.subtotal ?? 'null'}, ${r.tax ?? 'null'}, ${r.total}, 0, 'open', 'accepted', 'verified')`);
  }
}

/** A committed, FULL sales-invoice list spanning the quarter — what §2.2 asks of the revenue family. */
function seedInvoiceBatch(org: string, tag: string): void {
  const doc = one(`insert into public.source_documents
      (organization_id, storage_path, original_filename, mime_type, byte_size, sha256, status, document_kind)
    values ('${org}', '${org}/golden/${tag}.csv', 'invoices-${tag}.csv', 'text/csv', 10,
            digest('${org}${tag}', 'sha256'), 'ready', 'invoice') returning id`);
  adminSql(`insert into public.import_batches
      (organization_id, source_document_id, import_type, target_table, status, extraction_method,
       period_start, period_end, committed_at, invoice_list_kind)
    values ('${org}', '${doc}', 'sales_invoices', 'invoices', 'committed', 'csv',
            '2026-06-01', '2026-08-31', now(), 'full')`);
}

async function calculate(org: string): Promise<void> {
  const jobId = adminSql(`insert into public.jobs (organization_id, job_type, payload, max_attempts)
    values ('${org}', 'calculation.run', '{"trigger":"recalc_manual","as_of":"2026-09-15"}'::jsonb, 3)
    returning id`).split('\n')[0]!.trim();
  expect(await drainUntilFinished(drainJobs, jobId), `the calculation for ${org} must succeed`).toBe('succeeded');
}

const metric = (org: string, period: string, key: string): string | null => {
  const raw = one(`select coalesce(s.value::text, '<null>') from public.metric_current c
     join public.metric_snapshots s on s.id = c.snapshot_id
    where c.organization_id = '${org}' and c.period_id = '${period}'
      and c.metric_key = '${key}' and c.dimension_type = 'none'`).trim();
  return raw === '' || raw === '<null>' ? null : raw;
};
const money = (value: string | null): string | null => (value === null ? null : new Decimal(value).toFixed(2));
const snapshotField = (org: string, period: string, key: string, field: string): string =>
  one(`select s.${field}::text from public.metric_current c
     join public.metric_snapshots s on s.id = c.snapshot_id
    where c.organization_id = '${org}' and c.period_id = '${period}'
      and c.metric_key = '${key}' and c.dimension_type = 'none'`).trim();
const customerRevenue = (org: string, period: string): Array<{ id: string | null; value: string }> =>
  adminSql(`select coalesce(c.dimension_id::text, 'null') || '|' || s.value::text
     from public.metric_current c join public.metric_snapshots s on s.id = c.snapshot_id
    where c.organization_id = '${org}' and c.period_id = '${period}' and c.metric_key = 'customer_revenue'`)
    .split('\n').filter(Boolean)
    .map((line) => {
      const [id, value] = line.trim().split('|') as [string, string];
      return { id: id === 'null' ? null : id, value: new Decimal(value).toFixed(2) };
    });

beforeAll(async () => {
  owner = createAuthUser(`owner@${DOMAIN}`);
  ownerTwo = createAuthUser(`owner-two@${DOMAIN}`);
  // `create_organization` is throttled per person, so four golden organisations take two owners.
  const create = async (by: string, name: string): Promise<string> => {
    const r = await clientFor(by).schema('api').rpc('create_organization', { p_name: name });
    if (r.error) throw new Error(r.error.message);
    return r.data as unknown as string;
  };
  orgA = await create(owner, `ITest Invoice A ${RUN}`);
  orgB = await create(owner, `ITest Invoice B ${RUN}`);
  orgC = await create(ownerTwo, `ITest Invoice C ${RUN}`);
  orgD = await create(ownerTwo, `ITest Invoice D ${RUN}`);

  const counterparty = (org: string, name: string, kind: string, category: string | null): string =>
    one(`insert into public.counterparties (organization_id, name, kind, default_expense_category)
         values ('${org}', '${name}', '${kind}', ${category === null ? 'null' : `'${category}'`}) returning id`);

  /*
   * Organisation A — invoices only, August 2026.
   *
   *   Acme   A-001  net 6,000.00 (+1,200.00 VAT)
   *   Acme   A-C01  credit note, net 500.00 (+100.00 VAT)   → subtracts
   *   Beta   B-001  net 2,000.00 (+400.00 VAT)
   *   Beta   B-002  subtotal recorded as 0 beside a 1,260.00 gross with 210.00 VAT
   *                 → the one rule (`app.invoice_net`) reads the 0 as ABSENT: net 1,050.00
   *   Parts  P-001  purchase net 900.00, supplier's default category is cost_of_sales
   *
   *   revenue       = 6,000 − 500 + 2,000 + 1,050 = 8,550.00
   *   cost_of_sales =                                 900.00
   *   gross_profit  = 8,550 − 900                 =  7,650.00
   *   customers: Acme 5,500.00 · Beta 3,050.00 · unattributed 0.00
   */
  acme = counterparty(orgA, 'Acme Ltd', 'customer', null);
  beta = counterparty(orgA, 'Beta plc', 'customer', null);
  parts = counterparty(orgA, 'Parts Co', 'supplier', 'cost_of_sales');
  seedInvoices(orgA, [
    { type: 'sales', counterparty: acme, number: 'A-001', date: '2026-08-05', subtotal: '6000.00', tax: '1200.00', total: '7200.00' },
    { type: 'sales_credit_note', counterparty: acme, number: 'A-C01', date: '2026-08-19', subtotal: '500.00', tax: '100.00', total: '600.00' },
    { type: 'sales', counterparty: beta, number: 'B-001', date: '2026-08-11', subtotal: '2000.00', tax: '400.00', total: '2400.00' },
    { type: 'sales', counterparty: beta, number: 'B-002', date: '2026-08-21', subtotal: '0', tax: '210.00', total: '1260.00' },
    { type: 'purchase', counterparty: parts, number: 'P-001', date: '2026-08-14', subtotal: '900.00', tax: '180.00', total: '1080.00' },
  ]);
  seedInvoiceBatch(orgA, 'a');

  /*
   * Organisation B — the same sales, plus a bank statement for August.
   *
   *   invoices: Northwind net 4,000.00 (+800.00 VAT)
   *   bank:     +4,800.00 receipt categorised as revenue, −1,000.00 rent, closing 8,800.00
   *
   *   The receipt is the SAME money as the invoice, arriving. Invoices outrank bank for the P&L, so
   *   revenue must be 4,000.00 — never 8,800.00, and never the bank's 4,800.00 gross.
   */
  const northwind = counterparty(orgB, 'Northwind Ltd', 'customer', null);
  seedInvoices(orgB, [
    { type: 'sales', counterparty: northwind, number: 'N-001', date: '2026-08-06', subtotal: '4000.00', tax: '800.00', total: '4800.00' },
  ]);
  seedInvoiceBatch(orgB, 'b');
  const bankAccount = one(`insert into public.bank_accounts
      (organization_id, name, bank_name, account_number_masked, account_type, currency, opening_balance, opening_balance_date)
    values ('${orgB}', 'Current', 'Test Bank', '****4242', 'current', 'GBP', 5000.00, '2026-07-31') returning id`);
  const bankDoc = one(`insert into public.source_documents
      (organization_id, storage_path, original_filename, mime_type, byte_size, sha256, status, document_kind)
    values ('${orgB}', '${orgB}/golden/bank.csv', 'aug.csv', 'text/csv', 10, digest('${orgB}bank', 'sha256'), 'ready', 'bank_statement') returning id`);
  adminSql(`insert into public.import_batches
      (organization_id, source_document_id, import_type, target_table, status, extraction_method,
       period_start, period_end, committed_at, bank_account_id)
    values ('${orgB}', '${bankDoc}', 'bank_statement', 'bank_transactions', 'committed', 'csv',
            '2026-08-01', '2026-08-31', now(), '${bankAccount}')`);
  const revenueAccount = one(`select id from public.accounts where organization_id = '${orgB}' and standard_category = 'revenue' and is_system`);
  const opexAccount = one(`select id from public.accounts where organization_id = '${orgB}' and standard_category = 'operating_expense' and is_system`);
  adminSql(`insert into public.bank_transactions
      (organization_id, bank_account_id, transaction_date, amount, period_id, currency,
       description_raw, description_normalized, balance_after, record_status, assurance_level,
       category_account_id, category_source, counterparty_id)
    values ('${orgB}', '${bankAccount}', '2026-08-09', 4800.00, '00000000-0000-0000-0000-000000000000', 'GBP',
            'FPS CREDIT NORTHWIND', 'FPS CREDIT NORTHWIND', 9800.00, 'accepted', 'verified',
            '${revenueAccount}', 'user', '${northwind}'),
           ('${orgB}', '${bankAccount}', '2026-08-29', -1000.00, '00000000-0000-0000-0000-000000000000', 'GBP',
            'RENT PAYMENT', 'RENT PAYMENT', 8800.00, 'accepted', 'verified',
            '${opexAccount}', 'rule', null)`);

  /*
   * Organisation C — a GENERAL LEDGER covering August that states revenue and no cost of sales,
   * plus purchase invoices from a cost-of-sales supplier the ledger does not contain. The ledger is
   * the P&L basis; the invoices are evidence it is not reading (ADR-104).
   */
  const glCustomer = counterparty(orgC, 'GL Customer', 'customer', null);
  const glStock = counterparty(orgC, 'GL Stock', 'supplier', 'cost_of_sales');
  const glDoc = one(`insert into public.source_documents
      (organization_id, storage_path, original_filename, mime_type, byte_size, sha256, status, document_kind)
    values ('${orgC}', '${orgC}/golden/gl.csv', 'gl.csv', 'text/csv', 10, digest('${orgC}gl', 'sha256'), 'ready', 'general_ledger') returning id`);
  const glBatch = one(`insert into public.import_batches
      (organization_id, source_document_id, import_type, target_table, status, extraction_method, period_start, period_end, committed_at)
    values ('${orgC}', '${glDoc}', 'general_ledger', 'ledger_entries', 'committed', 'csv', '2026-08-01', '2026-08-31', now()) returning id`);
  const glRevenue = one(`select id from public.accounts where organization_id = '${orgC}' and standard_category = 'revenue' and is_system`);
  const glRow = one(`insert into public.import_rows (organization_id, batch_id, row_number, source_ref, raw_data, mapped_data, status)
    values ('${orgC}', '${glBatch}', 1, 'csv:row:1', '{}'::jsonb, '{}'::jsonb, 'committed') returning id`);
  const glEntry = one(`insert into public.ledger_entries
      (organization_id, entry_date, account_id, direction, amount, period_id, record_status, source_document_id, import_batch_id, import_row_id, source_ref, counterparty_id)
    values ('${orgC}', '2026-08-31', '${glRevenue}', 'credit', 9000.00, '00000000-0000-0000-0000-000000000000', 'accepted', '${glDoc}', '${glBatch}', '${glRow}', 'csv:row:1', '${glCustomer}') returning id`);
  adminSql(`insert into public.record_status_events (organization_id, record_table, record_id, event, import_batch_id)
            values ('${orgC}', 'ledger_entries', '${glEntry}', 'accepted', '${glBatch}')`);
  seedInvoices(orgC, [
    { type: 'purchase', counterparty: glStock, number: 'GP-1', date: '2026-08-10', subtotal: '2500.00', tax: '500.00', total: '3000.00' },
  ]);

  // Organisation D — nothing at all: no accounts, no invoices, no statements.

  await calculate(orgA);
  await calculate(orgB);
  await calculate(orgC);
  await calculate(orgD);
  const aug = (org: string) => one(`select id from public.fiscal_periods where organization_id = '${org}' and period_start = '2026-08-01'`);
  augA = aug(orgA); augB = aug(orgB); augC = aug(orgC);
}, 300_000);

afterAll(() => {
  adminSql(`delete from public.organizations where id in ('${orgA}', '${orgB}', '${orgC}', '${orgD}');
            delete from auth.users where email like '%@${DOMAIN}';`);
});

describe('golden: an organisation with invoices and nothing else has a profit and loss', () => {
  it('reports revenue net of tax and credit notes, on the invoice basis', () => {
    expect(money(metric(orgA, augA, 'revenue'))).toBe('8550.00');
    expect(snapshotField(orgA, augA, 'revenue', 'basis')).toBe('invoices');
  });

  it('reads a subtotal of 0 beside a positive total as absent — the one rule, in SQL', () => {
    // B-002 contributes 1,260.00 − 210.00 = 1,050.00, not 0.00.
    const betaRevenue = customerRevenue(orgA, augA).find((r) => r.id === beta);
    expect(betaRevenue?.value).toBe('3050.00');
    expect(one(`select app.invoice_net(0, 210.00, 1260.00)::text`)).toBe('1050.00');
    expect(one(`select app.invoice_net(null, null, 1260.00)::text`)).toBe('1260.00');
    expect(one(`select app.invoice_net(1000.00, 200.00, 1200.00)::text`)).toBe('1000.00');
  });

  it('places purchases in the supplier’s category and profits follow', () => {
    expect(money(metric(orgA, augA, 'cost_of_sales'))).toBe('900.00');
    expect(money(metric(orgA, augA, 'gross_profit'))).toBe('7650.00');
    expect(money(metric(orgA, augA, 'net_profit'))).toBe('7650.00');
  });

  it('reconciles Σ customer_revenue + unattributed to revenue, to the penny', () => {
    const rows = customerRevenue(orgA, augA);
    expect(rows.find((r) => r.id === acme)?.value).toBe('5500.00');
    expect(rows.find((r) => r.id === null)?.value).toBe('0.00');
    const total = rows.reduce((acc, r) => acc.plus(r.value), new Decimal(0));
    expect(total.toFixed(2)).toBe(money(metric(orgA, augA, 'revenue')));
  });

  it('measures concentration, because there is a revenue to measure it against', () => {
    // 5,500 / 8,550 = 0.643275
    expect(metric(orgA, augA, 'customer_concentration_top1')).toBe('0.643275');
    expect(snapshotField(orgA, augA, 'revenue', 'data_quality')).not.toMatch(/uncategorised_amounts_exceed_threshold/);
  });
});

describe('golden: invoices outrank bank for the P&L, and cash stays the bank’s (§2.3)', () => {
  it('takes revenue from the invoices, not from the bank receipt, and never from both', () => {
    expect(money(metric(orgB, augB, 'revenue'))).toBe('4000.00');
    expect(snapshotField(orgB, augB, 'revenue', 'basis')).toBe('invoices');
    // The receipt is the invoice arriving: 4,800.00 gross must not be added to the 4,000.00 net.
    expect(money(metric(orgB, augB, 'revenue'))).not.toBe('8800.00');
    expect(money(metric(orgB, augB, 'revenue'))).not.toBe('4800.00');
  });

  it('keeps cash on the bank basis, at the balance the statement printed', () => {
    expect(money(metric(orgB, augB, 'closing_cash'))).toBe('8800.00');
    expect(snapshotField(orgB, augB, 'closing_cash', 'basis')).toBe('bank');
    expect(money(metric(orgB, augB, 'cash_inflows'))).toBe('4800.00');
    expect(money(metric(orgB, augB, 'cash_outflows'))).toBe('1000.00');
  });

  it('does not let a bank-categorised expense enter the accrual P&L that the invoices define', () => {
    // Rent was paid from the bank, but the P&L for this month is the invoice list's, which has no
    // purchase in it. Reporting the bank's rent here would mix two bases in one figure (§2.3).
    expect(money(metric(orgB, augB, 'operating_expenses'))).toBe('0.00');
    expect(money(metric(orgB, augB, 'net_profit'))).toBe('4000.00');
  });

  it('reconciles the customer family to the same revenue', () => {
    const total = customerRevenue(orgB, augB).reduce((acc, r) => acc.plus(r.value), new Decimal(0));
    expect(total.toFixed(2)).toBe('4000.00');
  });
});

describe('golden: cash is unavailable where nothing can establish it (ADR-104)', () => {
  const cashKeys = ['closing_cash', 'opening_cash', 'cash_inflows', 'cash_outflows', 'net_cash_movement'];

  it('an invoice-only organisation has no cash figure, not a zero one, and says why', () => {
    for (const key of cashKeys) {
      expect(metric(orgA, augA, key), key).toBeNull();
      expect(snapshotField(orgA, augA, key, 'data_quality'), key).toMatch(/no_bank_accounts/);
      expect(snapshotField(orgA, augA, key, 'basis'), key).toBe('none');
    }
    // The P&L that was independently verified is untouched by the cash rule.
    expect(money(metric(orgA, augA, 'revenue'))).toBe('8550.00');
    expect(money(metric(orgA, augA, 'gross_profit'))).toBe('7650.00');
  });

  it('a bank organisation still has its cash, from the bank, with revenue from the invoices', () => {
    expect(money(metric(orgB, augB, 'closing_cash'))).toBe('8800.00');
    expect(snapshotField(orgB, augB, 'closing_cash', 'basis')).toBe('bank');
    expect(money(metric(orgB, augB, 'revenue'))).toBe('4000.00');
  });

  it('an organisation with nothing at all writes no zero anywhere', () => {
    const zeros = adminSql(`select c.metric_key || '=' || s.value::text
       from public.metric_current c join public.metric_snapshots s on s.id = c.snapshot_id
      where c.organization_id = '${orgD}' and s.value is not null`);
    expect(zeros, 'no metric carries a value on an organisation with no data').toBe('');
  });
});

describe('golden: evidence on the invoice basis reconciles to the figure it hangs off (ADR-104)', () => {
  it('cost of sales names the cost-of-sales supplier, not every purchase in the month', () => {
    const descriptor = JSON.parse(snapshotField(orgA, augA, 'cost_of_sales', 'evidence_query')) as { descriptor: { filters: Record<string, unknown> } };
    expect(descriptor.descriptor.filters).toEqual({
      period_ids: [augA], invoice_types: ['purchase', 'purchase_credit_note'], counterparty_ids: [parts],
    });
  });

  it('revenue stays on the sales types, which are exactly the figure', () => {
    const descriptor = JSON.parse(snapshotField(orgA, augA, 'revenue', 'evidence_query')) as { descriptor: { filters: Record<string, unknown> } };
    expect(descriptor.descriptor.filters).toEqual({ period_ids: [augA], invoice_types: ['sales', 'sales_credit_note'] });
  });
});

describe('golden: cost of sales that lives only in invoices is not a zero on the ledger basis (ADR-104)', () => {
  it('reports cost of sales as unavailable with the reason, and no gross margin', () => {
    expect(snapshotField(orgC, augC, 'revenue', 'basis')).toBe('ledger');
    expect(money(metric(orgC, augC, 'revenue'))).toBe('9000.00');
    expect(metric(orgC, augC, 'cost_of_sales')).toBeNull();
    expect(snapshotField(orgC, augC, 'cost_of_sales', 'data_quality')).toMatch(/cost_of_sales_in_other_source/);
    expect(metric(orgC, augC, 'gross_margin')).toBeNull();
    expect(snapshotField(orgC, augC, 'gross_profit', 'data_quality')).toMatch(/no_cost_of_sales/);
  });
});
