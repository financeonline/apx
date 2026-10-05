import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startImport } from '@/modules/imports';
import { adminSql, clientFor, createAuthUser } from './setup';

/**
 * Every import type the upload form offers, through the real wizard AND commit
 * (IMPORT_ENGINE.md §2–§11, §6.1, §6.6).
 *
 * Before this file only `bank_statement` ever went through `startImport`; every invoice in the
 * suite was inserted by SQL. So nothing saw that an invoice list could not be uploaded (its import
 * type was sent as a `document_kind_enum` value), that no row carried `invoice_type`, that no path
 * created a customer, or that receipts and both reports were validated against a different table
 * from the one their batch recorded. Each journey below is upload → validate → confirm → commit →
 * the records, read back under the owner's own token.
 *
 * Run-unique fixtures (ADR-052.12).
 */

const RUN = `t${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.wizardtypes.itest`;

let ownerId: string;
let clientId: string;
let outsiderId: string;
let orgId: string;
let otherOrgId: string;
let bankAccountId: string;

const one = (sql: string): string => adminSql(`with q as (${sql}) select * from q`);
const ownerDb = () => clientFor(ownerId, { email: `owner@${DOMAIN}` });
const rpc = (fn: string, args: Record<string, unknown>) => ownerDb().schema('api').rpc(fn, args);

function fixture(name: string, mime = 'text/csv'): File {
  return new File([new Uint8Array(readFileSync(`fixtures/imports/${name}`))], name, { type: mime });
}

async function upload(name: string, importType: string, opts: { bank?: string | null; userId?: string; mime?: string } = {}) {
  const userId = opts.userId ?? ownerId;
  return startImport({
    organizationId: orgId,
    userId,
    requestId: `itest-${RUN}`,
    db: clientFor(userId, { email: `${userId === ownerId ? 'owner' : 'other'}@${DOMAIN}` }),
    file: fixture(name, opts.mime),
    importType: importType as never,
    periodStart: '2026-08-01',
    periodEnd: '2026-08-31',
    bankAccountId: opts.bank ?? null,
  });
}

/** Answers every confirmation the batch raised, as the review screen would, then commits. */
async function confirmAndCommit(batchId: string) {
  const required = adminSql(`
    select coalesce(string_agg(c, ','), '') from public.import_batches b, unnest(b.required_confirmations) c
     where b.organization_id = '${orgId}' and b.id = '${batchId}'`).split(',').filter(Boolean);
  for (const code of required) {
    const value = code === 'IMP-RANGE-015' ? { period_start: '2026-08-01', period_end: '2026-08-31' }
      : code === 'IMP-TB-012' ? { balance_basis: 'cumulative' }
      : code === 'IMP-TB-013' ? { balance_sign: 'natural' }
      : code === 'IMP-TB-016' ? { report_complete: 'partial' }
      : code === 'IMP-INV-013' ? { opening: 'complete' }
      : { answer: 'yes' };
    const { error } = await rpc('record_batch_confirmation', { p_batch: batchId, p_code: code, p_value: value });
    expect(error, `${code}: ${error?.message}`).toBeNull();
  }
  const { data, error } = await rpc('commit_import_batch', { p_batch: batchId });
  expect(error, error?.message).toBeNull();
  return data as { status: string; committed: number };
}

const documentKindOf = (documentId: string) => one(`
  select document_kind::text from public.source_documents where organization_id = '${orgId}' and id = '${documentId}'`);
const batchOf = (batchId: string) => one(`
  select import_type || ':' || target_table || ':' || status from public.import_batches
   where organization_id = '${orgId}' and id = '${batchId}'`);
const countOf = (sql: string) => Number(one(sql));

beforeAll(async () => {
  ownerId = createAuthUser(`owner@${DOMAIN}`);
  clientId = createAuthUser(`client@${DOMAIN}`);
  outsiderId = createAuthUser(`outsider@${DOMAIN}`);
  const created = await clientFor(ownerId).schema('api').rpc('create_organization', { p_name: `ITest WizardTypes ${RUN}` });
  if (created.error) throw new Error(`fixture org failed: ${created.error.message}`);
  orgId = created.data as unknown as string;
  const other = await clientFor(outsiderId).schema('api').rpc('create_organization', { p_name: `ITest WizardTypes Other ${RUN}` });
  if (other.error) throw new Error(`fixture org failed: ${other.error.message}`);
  otherOrgId = other.data as unknown as string;

  adminSql(`
    set local app.bootstrap = 'on';
    insert into public.organization_memberships (organization_id, user_id, role)
    values ('${orgId}', '${clientId}', 'client');`);
  bankAccountId = one(`
    insert into public.bank_accounts (organization_id, name, account_type, bank_name, account_number_masked, is_active)
    values ('${orgId}', 'Business Current', 'current', 'Test Bank', '****4321', true) returning id`);
});

afterAll(() => {
  adminSql(`
    delete from public.organizations where name like 'ITest WizardTypes%${RUN}';
    delete from auth.users where email like '%@${DOMAIN}';`);
});

describe('a sales invoice list, upload to commit', () => {
  let batchId: string;

  it('uploads as an invoice document into an invoices batch, creating its customers', async () => {
    const result = await upload('sales_invoices.csv', 'sales_invoices');
    batchId = result.batchId;
    expect(documentKindOf(result.documentId)).toBe('invoice');
    expect(batchOf(batchId)).toBe('sales_invoices:invoices:awaiting_review');
    expect(result.counterpartiesCreated).toBe(3);
    expect(one(`select string_agg(distinct kind::text, ',') from public.counterparties where organization_id = '${orgId}'`)).toBe('customer');
    expect(countOf(`select count(*) from public.audit_events where organization_id = '${orgId}' and action = 'counterparty.created'`)).toBe(3);
  });

  it('commits every row as an invoice, the credit note stored positive and subtracted by type', async () => {
    const result = await confirmAndCommit(batchId);
    expect(result.status).toBe('committed');
    expect(result.committed).toBe(4);
    expect(one(`
      select string_agg(invoice_number || '=' || invoice_type || '/' || status || '/' || total_amount, ',' order by invoice_number)
        from public.invoices where organization_id = '${orgId}' and import_batch_id = '${batchId}' and record_status = 'accepted'`))
      .toBe('CN-1003=sales_credit_note/paid/300.00,INV-1001=sales/paid/1200.00,INV-1002=sales/open/600.00,INV-1004=sales/partially_paid/2400.00');
    // §13: every invoice names its document, batch, row and line.
    expect(countOf(`
      select count(*) from public.invoices where organization_id = '${orgId}' and import_batch_id = '${batchId}'
         and source_document_id is not null and import_row_id is not null and source_ref like 'csv:row:%'`)).toBe(4);
    // A recalculation was queued, as for every commit.
    expect(one(`select (calculation_job_id is not null)::text from public.import_batches where id = '${batchId}'`)).toBe('true');
  });

  it('flags the same invoices uploaded again in another file as duplicates, not new invoices', async () => {
    const again = new File([readFileSync('fixtures/imports/sales_invoices.csv', 'utf8') + '\n'], 'sales_invoices_again.csv', { type: 'text/csv' });
    const result = await startImport({
      organizationId: orgId, userId: ownerId, requestId: `itest-${RUN}`, db: ownerDb(), file: again,
      importType: 'sales_invoices', periodStart: '2026-08-01', periodEnd: '2026-08-31', bankAccountId: null,
    });
    expect(result.counterpartiesCreated).toBe(0);
    expect(result.counts.duplicate ?? 0).toBe(4);
  });

  it('rolls back cleanly: the invoices leave the figures, the customers remain', async () => {
    const { error } = await rpc('rollback_import_batch', { p_batch: batchId, p_reason: 'itest rollback' });
    expect(error, error?.message).toBeNull();
    expect(countOf(`select count(*) from public.invoices where organization_id = '${orgId}' and import_batch_id = '${batchId}' and record_status = 'accepted'`)).toBe(0);
    expect(countOf(`select count(*) from public.counterparties where organization_id = '${orgId}'`)).toBe(3);
  });
});

describe('purchase invoices and reports', () => {
  it('a purchase list creates suppliers and makes a known customer both', async () => {
    const result = await upload('purchase_invoices.csv', 'purchase_invoices');
    expect(documentKindOf(result.documentId)).toBe('invoice');
    expect((await confirmAndCommit(result.batchId)).committed).toBe(2);
    expect(one(`select kind::text from public.counterparties where organization_id = '${orgId}' and normalized_name = 'acme ltd'`)).toBe('both');
    expect(one(`select string_agg(distinct invoice_type::text, ',') from public.invoices where import_batch_id = '${result.batchId}'`)).toBe('purchase');
  });

  it('a sales report commits into invoices under its own document kind', async () => {
    const result = await upload('sales_report.csv', 'sales_report');
    expect(documentKindOf(result.documentId)).toBe('sales_report');
    expect(batchOf(result.batchId)).toBe('sales_report:invoices:awaiting_review');
    expect((await confirmAndCommit(result.batchId)).committed).toBe(2);
  });

  it('a purchase report commits into invoices as purchases', async () => {
    const result = await upload('purchase_report.csv', 'purchase_report');
    expect(documentKindOf(result.documentId)).toBe('purchase_report');
    expect((await confirmAndCommit(result.batchId)).committed).toBe(1);
    expect(one(`select invoice_type::text from public.invoices where import_batch_id = '${result.batchId}'`)).toBe('purchase');
  });
});

describe('receipts', () => {
  it('commit as ledger entries against the expense accounts they name, with no bank account', async () => {
    const result = await upload('receipts.csv', 'receipts');
    expect(documentKindOf(result.documentId)).toBe('receipt');
    expect(batchOf(result.batchId)).toBe('receipts:ledger_entries:awaiting_review');
    expect((await confirmAndCommit(result.batchId)).committed).toBe(2);
    expect(one(`
      select string_agg(direction::text || ' ' || amount, ',' order by amount)
        from public.ledger_entries where organization_id = '${orgId}' and import_batch_id = '${result.batchId}'`))
      .toBe('debit 18.99,debit 42.50');
  });
});

describe('balance sheets', () => {
  it('commit into period balances as balance_sheet rows', async () => {
    const result = await upload('balance_sheet.csv', 'balance_sheet');
    expect(documentKindOf(result.documentId)).toBe('balance_sheet');
    expect(batchOf(result.batchId)).toBe('balance_sheet:period_balances:awaiting_review');
    expect((await confirmAndCommit(result.batchId)).committed).toBe(4);
    expect(one(`select string_agg(distinct balance_kind::text, ',') from public.period_balances where import_batch_id = '${result.batchId}'`))
      .toBe('balance_sheet');
  });
});

describe('refusals and fences', () => {
  it('row errors stop only their rows: an unknown status and a name carrying an amount', async () => {
    const result = await upload('sales_invoices_problems.csv', 'sales_invoices');
    expect(result.counts.error).toBe(2);
    expect(countOf(`select count(*) from public.counterparties where organization_id = '${orgId}' and name like '%45000%'`)).toBe(0);
  });

  it('stores an invoice PDF as a source document, starting no batch and importing no figures', async () => {
    await expect(upload('bank_text.pdf', 'purchase_invoices', { mime: 'application/pdf' }))
      .rejects.toThrow(/stored as a source document/);
    expect(one(`select document_kind::text || ':' || status::text from public.source_documents
                 where organization_id = '${orgId}' and original_filename = 'bank_text.pdf'`)).toBe('invoice:ready');
    expect(countOf(`select count(*) from public.import_batches b join public.source_documents d on d.id = b.source_document_id
                     where b.organization_id = '${orgId}' and d.original_filename = 'bank_text.pdf'`)).toBe(0);
  });

  it('refuses a bank account on an invoice import', async () => {
    await expect(upload('sales_report.csv', 'sales_report', { bank: bankAccountId })).rejects.toThrow(/not imported into a bank account/);
  });

  it('a client cannot import at all', async () => {
    await expect(upload('purchase_report.csv', 'purchase_report', { userId: clientId })).rejects.toThrow();
  });

  it('an outsider cannot add counterparties to this organisation\'s batch', async () => {
    const batch = one(`select id from public.import_batches where organization_id = '${orgId}' and import_type = 'sales_report' limit 1`);
    const { error } = await clientFor(outsiderId).schema('api').rpc('create_import_counterparties', { p_batch: batch, p_names: ['Intruder'] });
    expect(error?.code).toBe('P0002');
    expect(countOf(`select count(*) from public.counterparties where organization_id in ('${orgId}', '${otherOrgId}') and name = 'Intruder'`)).toBe(0);
  });
});
