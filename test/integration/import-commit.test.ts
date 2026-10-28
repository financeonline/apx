import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { API_FUNCTIONS } from '@/db/api';
import { orgRow } from '@/db/schema';
import { clientFor, createAuthUser, deleteOrg, fs, rpc as call, sqlstate } from './setup';
import { addMember, makeOrg, seedBankAccount, seedCounterparty } from './f-fixtures';
import { clearTables, seedBatch, seedDocument, seedRows, where } from './i-fixtures';

/**
 * The import commit gate (IMPORT_ENGINE.md §9.3, §11, §12), on the Firestore port.
 *
 * The property under test throughout: **the review screen's opinion that a batch is ready is a
 * suggestion; this function is the decision.** Every precondition is re-checked by
 * `api.commit_import_batch`, so a caller who forged the request still cannot commit a batch with an
 * unresolved error, a missing confirmation, or rows that duplicate data committed thirty seconds ago
 * by somebody else.
 *
 * And the property the whole phase rests on: nothing is silently discarded. A row that does not
 * commit is still there, with a status and a reason.
 */

const VALIDATION = '22023';
// The SQL raised 40001 for these; a CONFLICT reads as 23505 through the port's `sqlstate`.
const CONFLICT = '23505';
const NOT_FOUND = 'P0002';

const RUN = `ic${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.imports.itest.motion`;

let ownerId: string;
let clientUserId: string;
let strangerId: string;
let orgId: string;
let strangerOrg: string;
let bankAccountId: string;
let counterpartyId: string;

const rpc = (userId: string, fn: string, args: Record<string, unknown> = {}) => call(clientFor(userId), fn, args);

interface RowSpec {
  readonly rowNumber: number;
  readonly mapped: Record<string, unknown> | null;
  readonly status: string;
  readonly hash?: string;
  readonly decision?: string;
  readonly duplicateOf?: string;
}

async function makeBatch(rows: readonly RowSpec[], opts: {
  confirmations?: string[]; periodStart?: string | null; periodEnd?: string | null; method?: string; batchIssues?: unknown[];
} = {}): Promise<string> {
  const batchId = await seedBatch(orgId, {
    importType: 'bank_statement', bankAccountId, method: opts.method ?? 'csv', required: opts.confirmations ?? [],
    periodStart: opts.periodStart, periodEnd: opts.periodEnd, batchIssues: opts.batchIssues ?? [],
  });
  await seedRows(orgId, batchId, rows.map((r) => ({
    rowNumber: r.rowNumber, mapped: r.mapped, status: r.status, hash: r.hash ?? null, decision: r.decision,
    duplicateOf: r.duplicateOf ?? null, duplicateOfTable: 'bank_transactions',
  })));
  return batchId;
}

/** An invoice batch: the same shape as `makeBatch`, aimed at `invoices` (ADR-029.1, ADR-073). */
async function makeInvoiceBatch(rows: readonly { rowNumber: number; number: string; total: string; hash: string; duplicateOf?: string }[]): Promise<string> {
  const batchId = await seedBatch(orgId, { importType: 'sales_invoices' });
  await seedRows(orgId, batchId, rows.map((row) => ({
    rowNumber: row.rowNumber, status: 'valid', hash: row.hash,
    mapped: {
      invoice_type: 'sales', counterparty_id: counterpartyId, invoice_number: row.number,
      issue_date: '2026-05-05', due_date: '2026-06-04', subtotal: row.total, tax_amount: '0', total_amount: row.total,
    },
    duplicateOf: row.duplicateOf ?? null, duplicateOfTable: 'invoices',
  })));
  return batchId;
}

/** The one current (accepted, not superseded) invoice with this number, and its total. */
async function currentInvoice(number: string): Promise<{ id: string; total: string } | null> {
  const rows = (await where(orgId, 'invoices', { invoice_number: number, record_status: 'accepted', superseded_by: null }));
  return rows[0] ? { id: String(rows[0].id), total: String(rows[0].total_amount) } : null;
}

const txn = (date: string, amount: string, description: string) => ({ transaction_date: date, amount, description });

const batchStatus = async (id: string) => String((await orgRow(fs(), orgId, 'import_batches', id).get()).get('status'));

beforeAll(async () => {
  ownerId = await createAuthUser(`owner@${DOMAIN}`);
  clientUserId = await createAuthUser(`client@${DOMAIN}`);
  strangerId = await createAuthUser(`stranger@${DOMAIN}`);
  orgId = await makeOrg(ownerId, `ITest Imports ${RUN}`);
  strangerOrg = await makeOrg(strangerId, `ITest Import Stranger ${RUN}`);
  await addMember(orgId, clientUserId, 'client');
  bankAccountId = await seedBankAccount(orgId, { name: 'Current', bankName: 'Barclays' });
  counterpartyId = await seedCounterparty(orgId, { name: 'Acme Customer' });
}, 60_000);

afterAll(async () => {
  for (const id of [orgId, strangerOrg]) {
    if (!id) continue;
    const jobs = await fs().collection('jobs').where('organization_id', '==', id).get();
    await Promise.all(jobs.docs.map((d) => d.ref.delete()));
    await deleteOrg(id);
  }
});

beforeEach(async () => {
  // Each test builds its own batch; clear committed records so hashes cannot collide across tests.
  await clearTables(orgId, [
    'record_status_events', 'bank_transactions', 'invoices', 'import_rows', 'import_batches', 'source_documents',
    'category_history', 'notifications',
  ]);
});

describe('the commit gate refuses what the review screen might have missed', () => {
  it('refuses while a row still has an unresolved error', async () => {
    const batch = await makeBatch([
      { rowNumber: 2, mapped: txn('2026-05-04', '-10.00', 'A'), status: 'valid', hash: 'a1' },
      { rowNumber: 3, mapped: null, status: 'error', hash: 'a2' },
    ]);
    const { error } = await rpc(ownerId, 'commit_import_batch', { p_batch: batch });
    expect(sqlstate(error)).toBe(VALIDATION);
    expect(error?.message).toContain('errors');
  });

  it('refuses while a row edited by a reviewer has not been re-validated', async () => {
    const batch = await makeBatch([{ rowNumber: 2, mapped: txn('2026-05-04', '-10.00', 'A'), status: 'pending', hash: 'b1' }]);
    const { error } = await rpc(ownerId, 'commit_import_batch', { p_batch: batch });
    expect(sqlstate(error)).toBe(VALIDATION);
    expect(error?.message).toContain('re-validated');
  });

  it('refuses while a batch-level error stands', async () => {
    const batch = await makeBatch(
      [{ rowNumber: 2, mapped: txn('2026-05-04', '-10.00', 'A'), status: 'valid', hash: 'c1' }],
      { batchIssues: [{ code: 'IMP-BAL-006', severity: 'error', message: 'does not reconcile' }] },
    );
    const { error } = await rpc(ownerId, 'commit_import_batch', { p_batch: batch });
    expect(sqlstate(error)).toBe(VALIDATION);
  });

  it('refuses while a required confirmation is unrecorded', async () => {
    const batch = await makeBatch(
      [{ rowNumber: 2, mapped: txn('2026-05-04', '-10.00', 'A'), status: 'valid', hash: 'd1' }],
      { confirmations: ['IMP-TB-012'] },
    );
    const { error } = await rpc(ownerId, 'commit_import_batch', { p_batch: batch });
    expect(sqlstate(error)).toBe(VALIDATION);
    expect(error?.message).toContain('IMP-TB-012');
  });

  it('refuses while the declared export range is unconfirmed (ADR-047.6)', async () => {
    const batch = await makeBatch(
      [{ rowNumber: 2, mapped: txn('2026-05-04', '-10.00', 'A'), status: 'valid', hash: 'e1' }],
      { periodStart: null, periodEnd: null },
    );
    const { error } = await rpc(ownerId, 'commit_import_batch', { p_batch: batch });
    expect(sqlstate(error)).toBe(VALIDATION);
    expect(error?.message).toContain('period');
  });

  it('refuses a caller without imports.review', async () => {
    const batch = await makeBatch([{ rowNumber: 2, mapped: txn('2026-05-04', '-10.00', 'A'), status: 'valid', hash: 'f1' }]);
    const { error } = await rpc(clientUserId, 'commit_import_batch', { p_batch: batch });
    expect(sqlstate(error)).toBe('42501');
  });

  it('refuses a batch belonging to another organization with NOT FOUND', async () => {
    const batch = await makeBatch([{ rowNumber: 2, mapped: txn('2026-05-04', '-10.00', 'A'), status: 'valid', hash: 'c1' }]);
    const { error } = await rpc(strangerId, 'commit_import_batch', { p_batch: batch });
    expect(sqlstate(error), 'a 42501 would confirm the batch exists').toBe(NOT_FOUND);
  });
});

describe('a clean batch commits, and nothing is discarded', () => {
  it('writes records, links them both ways and leaves every row accounted for', async () => {
    const batch = await makeBatch([
      { rowNumber: 2, mapped: txn('2026-05-04', '-125.50', 'ACME LTD 12345678'), status: 'valid', hash: '11' },
      { rowNumber: 3, mapped: txn('2026-05-06', '2000.00', 'CUSTOMER PAYMENT'), status: 'valid', hash: '12' },
      { rowNumber: 4, mapped: null, status: 'skipped' },
      { rowNumber: 5, mapped: txn('2026-05-07', '-9.99', 'BAD'), status: 'error', decision: 'skip', hash: '13' },
    ]);

    const { data, error } = await rpc(ownerId, 'commit_import_batch', { p_batch: batch });
    expect(error, error?.message).toBeNull();
    expect((data as { committed: number }).committed).toBe(2);

    const accepted = await where(orgId, 'bank_transactions', { record_status: 'accepted' });
    expect(accepted).toHaveLength(2);

    // §13: both directions. "What did this row become?" and "where did this figure come from?".
    const rows = await where(orgId, 'import_rows', { batch_id: batch });
    for (const t of accepted) {
      const row = rows.find((r) => r.id === t.import_row_id);
      expect(row?.committed_record_id).toBe(t.id);
    }
    expect(accepted.map((t) => t.source_ref).sort()).toEqual(['csv:row:2', 'csv:row:3']);
    // The fiscal period every record lands in (`period_assign`).
    expect(accepted.every((t) => typeof t.period_id === 'string' && t.period_id.length === 36)).toBe(true);

    // Every parsed line still exists, with a status explaining itself.
    const counts: Record<string, number> = {};
    for (const r of rows) counts[String(r.status)] = (counts[String(r.status)] ?? 0) + 1;
    expect(counts).toEqual({ committed: 2, skipped: 2 });
    expect(rows, 'every parsed line is still recorded').toHaveLength(4);
  });

  it('writes an accepted lifecycle event per record (ADR-034)', async () => {
    const batch = await makeBatch([{ rowNumber: 2, mapped: txn('2026-05-04', '-10.00', 'A'), status: 'valid', hash: '21' }]);
    await rpc(ownerId, 'commit_import_batch', { p_batch: batch });
    const events = await where(orgId, 'record_status_events', { event: 'accepted', record_table: 'bank_transactions' });
    expect(events).toHaveLength(1);
  });

  it('queues a recalculation, because the figures must catch up with the data', async () => {
    const batch = await makeBatch([{ rowNumber: 2, mapped: txn('2026-05-04', '-10.00', 'A'), status: 'valid', hash: '31' }]);
    const { data } = await rpc(ownerId, 'commit_import_batch', { p_batch: batch });
    const jobId = (await orgRow(fs(), orgId, 'import_batches', batch).get()).get('calculation_job_id');
    expect(jobId).toBeTruthy();
    expect((data as { job: string }).job).toBe(jobId);
    const job = (await fs().collection('jobs').doc(String(jobId)).get()).data();
    expect(job?.job_type).toBe('calculation.run');
  });

  it('masks the stored description, never the raw text (ADR-038.4)', async () => {
    const batch = await makeBatch([{ rowNumber: 2, mapped: txn('2026-05-04', '-10.00', 'PAY 20-45-67 12345678'), status: 'valid', hash: '41' }]);
    await rpc(ownerId, 'commit_import_batch', { p_batch: batch });
    const [t] = await where(orgId, 'bank_transactions', {});
    expect(t?.description_raw, 'the raw text is kept verbatim for evidence').toBe('PAY 20-45-67 12345678');
    expect(t?.description_normalized).toBe('PAY ****4567 ****5678');
    // `open_bank_category_history`: the transaction's first category entry.
    expect(await where(orgId, 'category_history', { bank_transaction_id: t?.id })).toHaveLength(1);
  });
});

describe('a duplicate commits only on an explicit decision (§9)', () => {
  it('skips a duplicate by default and keeps it on an explicit keep with a reason', async () => {
    const first = await makeBatch([{ rowNumber: 2, mapped: txn('2026-05-04', '-50.00', 'RENT'), status: 'valid', hash: '51' }]);
    await rpc(ownerId, 'commit_import_batch', { p_batch: first });
    const [existing] = await where(orgId, 'bank_transactions', {});

    const second = await makeBatch([
      { rowNumber: 2, mapped: txn('2026-05-04', '-50.00', 'RENT'), status: 'duplicate', hash: '51', duplicateOf: String(existing!.id) },
      { rowNumber: 3, mapped: txn('2026-05-04', '-50.00', 'RENT UNIT 2'), status: 'duplicate', hash: '52', duplicateOf: String(existing!.id), decision: 'keep' },
    ]);
    const { data, error } = await rpc(ownerId, 'commit_import_batch', { p_batch: second });
    expect(error, error?.message).toBeNull();
    // Only the explicitly-kept one commits; the undecided duplicate does not.
    expect((data as { committed: number }).committed).toBe(1);
    const [kept] = await where(orgId, 'bank_transactions', { description_raw: 'RENT UNIT 2' });
    // The flag the duplicate alert rule excludes on (FINANCIAL_ENGINE.md §8).
    expect(kept?.duplicate_reviewed).toBe(true);
  });
});

describe('the commit-time duplicate re-check (§9.3, F-D-13)', () => {
  it('aborts and returns the batch to review when another batch committed the same rows first', async () => {
    const batchA = await makeBatch([{ rowNumber: 2, mapped: txn('2026-05-10', '-77.00', 'SHARED'), status: 'valid', hash: '61' }]);
    const batchB = await makeBatch([{ rowNumber: 2, mapped: txn('2026-05-10', '-77.00', 'SHARED'), status: 'valid', hash: '61' }]);

    const first = await rpc(ownerId, 'commit_import_batch', { p_batch: batchA });
    expect(first.error, first.error?.message).toBeNull();

    const second = await rpc(ownerId, 'commit_import_batch', { p_batch: batchB });
    // It returns a conflict rather than raising: raising would undo the re-flagging (§9.3).
    expect(second.error, second.error?.message).toBeNull();
    expect((second.data as { status: string }).status).toBe('conflict');
    expect((second.data as { collisions: number }).collisions).toBe(1);

    expect(await batchStatus(batchB)).toBe('awaiting_review');
    const [flagged] = await where(orgId, 'import_rows', { batch_id: batchB, row_number: 2 });
    expect(flagged?.status).toBe('duplicate');
    expect(await where(orgId, 'bank_transactions', { record_status: 'accepted' }), 'nothing was written twice').toHaveLength(1);
  });
});

describe('an invoice re-export updates by supersession, at commit (ADR-029.1, ADR-073)', () => {
  it('commits a validated update candidate: the new row is current, the old one superseded', async () => {
    const first = await makeInvoiceBatch([{ rowNumber: 2, number: 'INV-100', total: '1000.00', hash: 'a1' }]);
    expect((await rpc(ownerId, 'commit_import_batch', { p_batch: first })).error).toBeNull();
    const before = await currentInvoice('INV-100');
    expect(before?.total).toBe('1000.00');

    const second = await makeInvoiceBatch([{ rowNumber: 2, number: 'INV-100', total: '1200.00', hash: 'a2', duplicateOf: before!.id }]);
    const result = await rpc(ownerId, 'commit_import_batch', { p_batch: second });
    expect(result.error, result.error?.message).toBeNull();
    expect((result.data as { status: string }).status).toBe('committed');
    expect((result.data as { superseded: number }).superseded).toBe(1);

    const after = await currentInvoice('INV-100');
    expect(after?.total).toBe('1200.00');
    const old = (await orgRow(fs(), orgId, 'invoices', before!.id).get()).data();
    expect(old?.superseded_by).toBe(after!.id);
    expect(old?.superseded_at).toBeTruthy();
    // Never two current rows for one identity, and never a row left `pending`.
    expect(await where(orgId, 'invoices', { invoice_number: 'INV-100', record_status: 'accepted', superseded_by: null })).toHaveLength(1);
    expect(await where(orgId, 'invoices', { record_status: 'pending' })).toHaveLength(0);
    const events = (await where(orgId, 'record_status_events', { record_id: before!.id })).map((e) => e.event).sort();
    expect(events).toEqual(['accepted', 'superseded']);
  });

  it('turns a re-export committed by somebody else since validation into an update, not a crash (§9.3 pass 1)', async () => {
    const batchA = await makeInvoiceBatch([{ rowNumber: 2, number: 'INV-200', total: '100.00', hash: 'b1' }]);
    const batchB = await makeInvoiceBatch([{ rowNumber: 2, number: 'INV-200', total: '120.00', hash: 'b2' }]);
    expect((await rpc(ownerId, 'commit_import_batch', { p_batch: batchA })).error).toBeNull();
    const result = await rpc(ownerId, 'commit_import_batch', { p_batch: batchB });
    expect(result.error, result.error?.message).toBeNull();
    expect((result.data as { status: string }).status).toBe('committed');
    expect((result.data as { superseded: number }).superseded).toBe(1);
    expect((await currentInvoice('INV-200'))?.total).toBe('120.00');
    const [row] = await where(orgId, 'import_rows', { batch_id: batchB, row_number: 2 });
    expect((row?.issues as Array<{ code: string }>).map((i) => i.code)).toContain('IMP-INV-010');
  });

  it('still sends the byte-identical invoice back to review rather than updating it (pass 2 before pass 1)', async () => {
    const batchA = await makeInvoiceBatch([{ rowNumber: 2, number: 'INV-300', total: '50.00', hash: 'c1' }]);
    const batchB = await makeInvoiceBatch([{ rowNumber: 2, number: 'INV-300', total: '50.00', hash: 'c1' }]);
    expect((await rpc(ownerId, 'commit_import_batch', { p_batch: batchA })).error).toBeNull();
    const result = await rpc(ownerId, 'commit_import_batch', { p_batch: batchB });
    expect(result.error).toBeNull();
    expect((result.data as { status: string }).status).toBe('conflict');
    const [row] = await where(orgId, 'import_rows', { batch_id: batchB, row_number: 2 });
    expect(row?.status).toBe('duplicate');
    expect(await where(orgId, 'invoices', { invoice_number: 'INV-300' })).toHaveLength(1);
  });

  it('follows the chain when the row it meant to update was itself updated meanwhile', async () => {
    const v1 = await makeInvoiceBatch([{ rowNumber: 2, number: 'INV-400', total: '10.00', hash: 'd1' }]);
    expect((await rpc(ownerId, 'commit_import_batch', { p_batch: v1 })).error).toBeNull();
    const first = (await currentInvoice('INV-400'))!;
    const v2 = await makeInvoiceBatch([{ rowNumber: 2, number: 'INV-400', total: '20.00', hash: 'd2', duplicateOf: first.id }]);
    const v3 = await makeInvoiceBatch([{ rowNumber: 2, number: 'INV-400', total: '30.00', hash: 'd3', duplicateOf: first.id }]);
    expect((await rpc(ownerId, 'commit_import_batch', { p_batch: v2 })).error).toBeNull();
    const result = await rpc(ownerId, 'commit_import_batch', { p_batch: v3 });
    expect(result.error, result.error?.message).toBeNull();
    expect((result.data as { status: string }).status).toBe('committed');
    expect((await currentInvoice('INV-400'))?.total).toBe('30.00');
    // v1 → v2 → v3: one current row, two superseded, a chain and not a fork.
    const all = await where(orgId, 'invoices', { invoice_number: 'INV-400' });
    expect(all.filter((i) => i.superseded_by !== null)).toHaveLength(2);
  });
});

describe('rollback and replace (§12)', () => {
  it('soft-rejects records and never deletes them (ADR-012)', async () => {
    const batch = await makeBatch([{ rowNumber: 2, mapped: txn('2026-05-04', '-10.00', 'ONE'), status: 'valid', hash: '71' }]);
    await rpc(ownerId, 'commit_import_batch', { p_batch: batch });
    const { error } = await rpc(ownerId, 'rollback_import_batch', { p_batch: batch, p_reason: 'wrong file' });
    expect(error, error?.message).toBeNull();
    const [t] = await where(orgId, 'bank_transactions', {});
    expect(`${t?.record_status}|${t?.rejected_reason ?? ''}`).toBe('rejected|wrong file');
    expect(await where(orgId, 'record_status_events', { event: 'rejected' })).toHaveLength(1);
    expect(await batchStatus(batch)).toBe('rolled_back');
  });

  it('requires a reason', async () => {
    const batch = await makeBatch([{ rowNumber: 2, mapped: txn('2026-05-04', '-10.00', 'ONE'), status: 'valid', hash: '81' }]);
    await rpc(ownerId, 'commit_import_batch', { p_batch: batch });
    const { error } = await rpc(ownerId, 'rollback_import_batch', { p_batch: batch, p_reason: '  ' });
    expect(sqlstate(error)).toBe(VALIDATION);
  });

  it('refuses to roll back a batch that was never committed', async () => {
    const batch = await makeBatch([{ rowNumber: 2, mapped: txn('2026-05-04', '-10.00', 'ONE'), status: 'valid', hash: '91' }]);
    const { error } = await rpc(ownerId, 'rollback_import_batch', { p_batch: batch, p_reason: 'x' });
    expect(sqlstate(error)).toBe(CONFLICT);
  });

  it('promotes a dependant row rather than losing it (ADR-047.9)', async () => {
    const batchA = await makeBatch([
      { rowNumber: 2, mapped: txn('2026-05-04', '-100.00', 'SHARED ROW'), status: 'valid', hash: 'a1a1' },
      { rowNumber: 3, mapped: txn('2026-05-05', '-200.00', 'A ONLY'), status: 'valid', hash: 'a2a2' },
    ]);
    await rpc(ownerId, 'commit_import_batch', { p_batch: batchA });
    const [shared] = await where(orgId, 'bank_transactions', { description_raw: 'SHARED ROW' });

    const batchB = await makeBatch([
      { rowNumber: 2, mapped: txn('2026-05-04', '-100.00', 'SHARED ROW'), status: 'duplicate', hash: 'a1a1', decision: 'skip', duplicateOf: String(shared!.id) },
      { rowNumber: 3, mapped: txn('2026-06-02', '-300.00', 'B ONLY'), status: 'valid', hash: 'b1b1' },
    ]);
    await rpc(ownerId, 'commit_import_batch', { p_batch: batchB });

    const { data, error } = await rpc(ownerId, 'rollback_import_batch', { p_batch: batchA, p_reason: 'corrected statement' });
    expect(error, error?.message).toBeNull();
    expect((data as { promoted: number }).promoted, 'the shared row must be rescued').toBe(1);

    const survivors = await where(orgId, 'bank_transactions', { description_raw: 'SHARED ROW', record_status: 'accepted' });
    expect(survivors, 'the row is kept and re-owned, not lost').toHaveLength(1);
    expect(survivors[0]?.import_batch_id).toBe(batchB);
    expect(survivors[0]?.promoted_from_batch_id).toBe(batchA);

    const remaining = (await where(orgId, 'bank_transactions', { record_status: 'accepted' })).map((t) => t.description_raw).sort();
    expect(remaining).toEqual(['B ONLY', 'SHARED ROW']);
  });

  it('replaces a batch in one transaction, of the same type only', async () => {
    const oldBatch = await makeBatch([{ rowNumber: 2, mapped: txn('2026-05-04', '-10.00', 'OLD'), status: 'valid', hash: 'c1c1' }]);
    await rpc(ownerId, 'commit_import_batch', { p_batch: oldBatch });
    const newBatch = await makeBatch([{ rowNumber: 2, mapped: txn('2026-05-04', '-12.00', 'CORRECTED'), status: 'valid', hash: 'c2c2' }]);

    const { data, error } = await rpc(ownerId, 'replace_import_batch', { p_old_batch: oldBatch, p_new_batch: newBatch, p_reason: 'corrected export' });
    expect(error, error?.message).toBeNull();
    expect((data as { committed: { job: string | null } }).committed.job).toBeTruthy();

    const accepted = (await where(orgId, 'bank_transactions', { record_status: 'accepted' })).map((t) => t.description_raw);
    expect(accepted).toEqual(['CORRECTED']);
    expect(`${await batchStatus(oldBatch)}|${await batchStatus(newBatch)}`).toBe('rolled_back|committed');
    const replaced = (await orgRow(fs(), orgId, 'import_batches', newBatch).get()).get('replaced_batch_id');
    expect(replaced).toBe(oldBatch);
  });

  it('refuses to replace a batch with one of a different type', async () => {
    const oldBatch = await makeBatch([{ rowNumber: 2, mapped: txn('2026-05-04', '-10.00', 'OLD'), status: 'valid', hash: 'd1d1' }]);
    await rpc(ownerId, 'commit_import_batch', { p_batch: oldBatch });
    const glBatch = await seedBatch(orgId, { importType: 'general_ledger', documentId: await seedDocument(orgId) });
    const { error } = await rpc(ownerId, 'replace_import_batch', { p_old_batch: oldBatch, p_new_batch: glBatch, p_reason: 'wrong' });
    expect(sqlstate(error)).toBe(VALIDATION);
  });
});

describe('confirmations are recorded facts, not client claims', () => {
  it('refuses a confirmation the batch does not require', async () => {
    const batch = await makeBatch([{ rowNumber: 2, mapped: txn('2026-05-04', '-10.00', 'A'), status: 'valid', hash: 'e1e1' }], { confirmations: ['IMP-RANGE-015'] });
    const { error } = await rpc(ownerId, 'record_batch_confirmation', { p_batch: batch, p_code: 'IMP-TB-012', p_value: { balance_basis: 'cumulative' } });
    expect(sqlstate(error)).toBe(VALIDATION);
  });

  it('sets the declared range from the confirmation, and records who confirmed it', async () => {
    const batch = await makeBatch(
      [{ rowNumber: 2, mapped: txn('2026-05-04', '-10.00', 'A'), status: 'valid', hash: 'f1f1' }],
      { confirmations: ['IMP-RANGE-015'], periodStart: null, periodEnd: null },
    );
    const { error } = await rpc(ownerId, 'record_batch_confirmation', {
      p_batch: batch, p_code: 'IMP-RANGE-015', p_value: { period_start: '2026-05-01', period_end: '2026-05-31' },
    });
    expect(error, error?.message).toBeNull();
    const b = (await orgRow(fs(), orgId, 'import_batches', batch).get()).data()!;
    expect(`${b.period_start}..${b.period_end}|${(b.confirmations as Record<string, { by: string }>)['IMP-RANGE-015']!.by}`)
      .toBe(`2026-05-01..2026-05-31|${ownerId}`);
  });

  it('refuses an export range confirmation missing either end', async () => {
    const batch = await makeBatch(
      [{ rowNumber: 2, mapped: txn('2026-05-04', '-10.00', 'A'), status: 'valid', hash: 'ac01' }],
      { confirmations: ['IMP-RANGE-015'], periodStart: null, periodEnd: null },
    );
    const { error } = await rpc(ownerId, 'record_batch_confirmation', { p_batch: batch, p_code: 'IMP-RANGE-015', p_value: { period_start: '2026-05-01' } });
    expect(sqlstate(error)).toBe(VALIDATION);
  });
});

describe('an AI-read document needs every page confirmed (§5.4)', () => {
  const onPage = async (batch: string, page: number) => {
    for (const r of await where(orgId, 'import_rows', { batch_id: batch })) {
      await orgRow(fs(), orgId, 'import_rows', String(r.id)).update({ source_page: page });
    }
  };

  it('refuses to commit while a page carrying rows is unconfirmed', async () => {
    const batch = await makeBatch([{ rowNumber: 2, mapped: txn('2026-05-04', '-10.00', 'A'), status: 'warning', hash: 'ad01' }], { method: 'pdf_claude' });
    await onPage(batch, 3);
    const refused = await rpc(ownerId, 'commit_import_batch', { p_batch: batch });
    expect(sqlstate(refused.error)).toBe(VALIDATION);
    expect(refused.error?.message).toContain('page');
    const confirmed = await rpc(ownerId, 'confirm_pdf_page', { p_batch: batch, p_page: 3 });
    expect(confirmed.error, confirmed.error?.message).toBeNull();
    const committed = await rpc(ownerId, 'commit_import_batch', { p_batch: batch });
    expect(committed.error, committed.error?.message).toBeNull();
  });

  it('stamps AI-read rows as inferred, so the figures are labelled downstream', async () => {
    const batch = await makeBatch([{ rowNumber: 2, mapped: txn('2026-05-04', '-10.00', 'A'), status: 'warning', hash: 'ae01' }], { method: 'pdf_claude' });
    await onPage(batch, 1);
    await rpc(ownerId, 'confirm_pdf_page', { p_batch: batch, p_page: 1 });
    await rpc(ownerId, 'commit_import_batch', { p_batch: batch });
    const levels = [...new Set((await where(orgId, 'bank_transactions', { record_status: 'accepted' })).map((t) => t.assurance_level))];
    expect(levels).toEqual(['inferred']);
  });

  it('stamps a positionally-parsed PDF as calculated when it did not reconcile (§5.3)', async () => {
    const batch = await makeBatch(
      [{ rowNumber: 2, mapped: txn('2026-05-04', '-10.00', 'A'), status: 'valid', hash: 'af01' }],
      { method: 'pdf_text', batchIssues: [{ code: 'IMP-BAL-007', severity: 'warning', message: 'unreconciled' }] },
    );
    await rpc(ownerId, 'commit_import_batch', { p_batch: batch });
    const levels = [...new Set((await where(orgId, 'bank_transactions', { record_status: 'accepted' })).map((t) => t.assurance_level))];
    expect(levels, 'positional parsing is heuristic until the statement reconciles').toEqual(['calculated']);
  });
});

describe('a reviewer edit is absent until it can be re-validated (ADR-075)', () => {
  it('has no fix_import_row to call, rather than one that parks the batch', async () => {
    // Dropped, not merely revoked: a function nobody may call has no place in the API.
    expect(API_FUNCTIONS.fix_import_row).toBeUndefined();
  });
});
