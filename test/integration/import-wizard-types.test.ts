import { readFileSync } from 'node:fs';
import Decimal from 'decimal.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startImport } from '@/modules/imports';
import { orgRow } from '@/db/schema';
import { clientFor, createAuthUser, deleteOrg, fs, rpc as call } from './setup';
import { addMember, auditsOf, makeOrg, seedBankAccount } from './f-fixtures';
import { where } from './i-fixtures';

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
const DOMAIN = `${RUN}.wizardtypes.itest.motion`;

let ownerId: string;
let clientId: string;
let outsiderId: string;
let orgId: string;
let otherOrgId: string;
let bankAccountId: string;

const ownerDb = () => clientFor(ownerId, { email: `owner@${DOMAIN}` });
const rpc = (fn: string, args: Record<string, unknown>) => call(ownerDb(), fn, args);

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
  const required = ((await orgRow(fs(), orgId, 'import_batches', batchId).get()).get('required_confirmations') as string[]) ?? [];
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

const documentKindOf = async (documentId: string) => String((await orgRow(fs(), orgId, 'source_documents', documentId).get()).get('document_kind'));
const batchOf = async (batchId: string) => {
  const b = (await orgRow(fs(), orgId, 'import_batches', batchId).get()).data()!;
  return `${b.import_type}:${b.target_table}:${b.status}`;
};
/** Batches started from documents with this file name. */
async function batchesFor(filename: string): Promise<number> {
  let n = 0;
  for (const d of await where(orgId, 'source_documents', { original_filename: filename })) {
    n += (await where(orgId, 'import_batches', { source_document_id: d.id })).length;
  }
  return n;
}

beforeAll(async () => {
  ownerId = await createAuthUser(`owner@${DOMAIN}`);
  clientId = await createAuthUser(`client@${DOMAIN}`);
  outsiderId = await createAuthUser(`outsider@${DOMAIN}`);
  orgId = await makeOrg(ownerId, `ITest WizardTypes ${RUN}`);
  otherOrgId = await makeOrg(outsiderId, `ITest WizardTypes Other ${RUN}`);
  await addMember(orgId, clientId, 'client');
  bankAccountId = await seedBankAccount(orgId, { name: 'Business Current', bankName: 'Test Bank', accountNumber: '****4321' });
}, 60_000);

afterAll(async () => {
  for (const id of [orgId, otherOrgId]) {
    const jobs = await fs().collection('jobs').where('organization_id', '==', id).get();
    await Promise.all(jobs.docs.map((d) => d.ref.delete()));
    await deleteOrg(id);
  }
});

describe('a sales invoice list, upload to commit', () => {
  let batchId: string;

  it('uploads as an invoice document into an invoices batch, creating its customers', async () => {
    const result = await upload('sales_invoices.csv', 'sales_invoices');
    batchId = result.batchId;
    expect(await documentKindOf(result.documentId)).toBe('invoice');
    expect(await batchOf(batchId)).toBe('sales_invoices:invoices:awaiting_review');
    expect(result.counterpartiesCreated).toBe(3);
    expect([...new Set((await where(orgId, 'counterparties', {})).map((c) => c.kind))].join(',')).toBe('customer');
    expect(await auditsOf(orgId, 'counterparty.created')).toHaveLength(3);
  });

  it('commits every row as an invoice, the credit note stored positive and subtracted by type', async () => {
    const result = await confirmAndCommit(batchId);
    expect(result.status).toBe('committed');
    expect(result.committed).toBe(4);
    expect((await where(orgId, 'invoices', { import_batch_id: batchId, record_status: 'accepted' }))
      .sort((a, b) => String(a.invoice_number).localeCompare(String(b.invoice_number)))
      .map((i) => `${i.invoice_number}=${i.invoice_type}/${i.status}/${i.total_amount}`).join(','))
      .toBe('CN-1003=sales_credit_note/paid/300.00,INV-1001=sales/paid/1200.00,INV-1002=sales/open/600.00,INV-1004=sales/partially_paid/2400.00');
    // §13: every invoice names its document, batch, row and line.
    expect((await where(orgId, 'invoices', { import_batch_id: batchId }))
      .filter((i) => i.source_document_id && i.import_row_id && String(i.source_ref).startsWith('csv:row:'))).toHaveLength(4);
    // A recalculation was queued, as for every commit.
    expect((await orgRow(fs(), orgId, 'import_batches', batchId).get()).get('calculation_job_id')).toBeTruthy();
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
    expect(await where(orgId, 'invoices', { import_batch_id: batchId, record_status: 'accepted' })).toHaveLength(0);
    expect(await where(orgId, 'counterparties', {})).toHaveLength(3);
  });
});

describe('purchase invoices and reports', () => {
  it('a purchase list creates suppliers and makes a known customer both', async () => {
    const result = await upload('purchase_invoices.csv', 'purchase_invoices');
    expect(await documentKindOf(result.documentId)).toBe('invoice');
    expect((await confirmAndCommit(result.batchId)).committed).toBe(2);
    expect((await where(orgId, 'counterparties', { normalized_name: 'acme ltd' }))[0]?.kind).toBe('both');
    expect([...new Set((await where(orgId, 'invoices', { import_batch_id: result.batchId })).map((i) => i.invoice_type))].join(',')).toBe('purchase');
  });

  it('a sales report commits into invoices under its own document kind', async () => {
    const result = await upload('sales_report.csv', 'sales_report');
    expect(await documentKindOf(result.documentId)).toBe('sales_report');
    expect(await batchOf(result.batchId)).toBe('sales_report:invoices:awaiting_review');
    expect((await confirmAndCommit(result.batchId)).committed).toBe(2);
  });

  it('a purchase report commits into invoices as purchases', async () => {
    const result = await upload('purchase_report.csv', 'purchase_report');
    expect(await documentKindOf(result.documentId)).toBe('purchase_report');
    expect((await confirmAndCommit(result.batchId)).committed).toBe(1);
    expect((await where(orgId, 'invoices', { import_batch_id: result.batchId })).map((i) => i.invoice_type).join(',')).toBe('purchase');
  });
});

describe('receipts', () => {
  it('commit as ledger entries against the expense accounts they name, with no bank account', async () => {
    const result = await upload('receipts.csv', 'receipts');
    expect(await documentKindOf(result.documentId)).toBe('receipt');
    expect(await batchOf(result.batchId)).toBe('receipts:ledger_entries:awaiting_review');
    expect((await confirmAndCommit(result.batchId)).committed).toBe(2);
    expect((await where(orgId, 'ledger_entries', { import_batch_id: result.batchId }))
      .sort((a, b) => new Decimal(String(a.amount)).comparedTo(String(b.amount))).map((e) => `${e.direction} ${e.amount}`).join(','))
      .toBe('debit 18.99,debit 42.50');
  });
});

describe('balance sheets', () => {
  it('commit into period balances as balance_sheet rows', async () => {
    const result = await upload('balance_sheet.csv', 'balance_sheet');
    expect(await documentKindOf(result.documentId)).toBe('balance_sheet');
    expect(await batchOf(result.batchId)).toBe('balance_sheet:period_balances:awaiting_review');
    expect((await confirmAndCommit(result.batchId)).committed).toBe(4);
    expect([...new Set((await where(orgId, 'period_balances', { import_batch_id: result.batchId })).map((b) => b.balance_kind))].join(','))
      .toBe('balance_sheet');
  });
});

describe('refusals and fences', () => {
  it('row errors stop only their rows: an unknown status and a name carrying an amount', async () => {
    const result = await upload('sales_invoices_problems.csv', 'sales_invoices');
    expect(result.counts.error).toBe(2);
    expect((await where(orgId, 'counterparties', {})).filter((c) => String(c.name).includes('45000'))).toHaveLength(0);
  });

  it('stores an invoice PDF as a source document, starting no batch and importing no figures', async () => {
    await expect(upload('bank_text.pdf', 'purchase_invoices', { mime: 'application/pdf' }))
      .rejects.toThrow(/stored as a source document/);
    expect((await where(orgId, 'source_documents', { original_filename: 'bank_text.pdf' })).map((d) => `${d.document_kind}:${d.status}`).join(','))
      .toBe('invoice:ready');
    expect(await batchesFor('bank_text.pdf')).toBe(0);
  });

  it('refuses a bank account on an invoice import', async () => {
    await expect(upload('sales_report.csv', 'sales_report', { bank: bankAccountId })).rejects.toThrow(/not imported into a bank account/);
  });

  it('a client cannot import at all', async () => {
    await expect(upload('purchase_report.csv', 'purchase_report', { userId: clientId })).rejects.toThrow();
  });

  it('an outsider cannot add counterparties to this organisation\'s batch', async () => {
    const [batch] = await where(orgId, 'import_batches', { import_type: 'sales_report' });
    const { error } = await call(clientFor(outsiderId), 'create_import_counterparties', { p_batch: batch!.id, p_names: ['Intruder'] });
    expect(error?.code).toBe('NOT_FOUND');
    expect([...await where(orgId, 'counterparties', { name: 'Intruder' }), ...await where(otherOrgId, 'counterparties', { name: 'Intruder' })]).toHaveLength(0);
  });
});

describe('a blank optional date is no date', () => {
  it('an unpaid invoice with an empty Paid Date imports, with no paid date (found loading sample data)', async () => {
    const csv = [
      'Invoice Number,Customer,Invoice Date,Due Date,Total,Amount Paid,Paid Date,Status',
      'BL-1,Blank Date Ltd,2026-08-05,2026-09-04,500.00,500.00,2026-08-20,Paid',
      'BL-2,Blank Date Ltd,2026-08-12,2026-09-11,300.00,0.00,,Unpaid',
    ].join('\n');
    const result = await startImport({
      organizationId: orgId, userId: ownerId, requestId: `itest-${RUN}`, db: ownerDb(),
      file: new File([csv], 'blank_paid_date.csv', { type: 'text/csv' }), importType: 'sales_invoices',
      periodStart: '2026-08-01', periodEnd: '2026-08-31', bankAccountId: null,
    });
    const committed = await confirmAndCommit(result.batchId);
    expect(committed.committed).toBe(2);
    expect((await where(orgId, 'invoices', { invoice_number: 'BL-2' }))[0]?.paid_date ?? 'NULL').toBe('NULL');
    expect((await where(orgId, 'invoices', { invoice_number: 'BL-1' }))[0]?.paid_date).toBe('2026-08-20');
  });
});
