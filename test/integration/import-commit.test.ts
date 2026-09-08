import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';

import { adminSql, clientFor, createAuthUser, resetFixtures, sqlstate } from './setup';

/**
 * The import commit gate, over the real wire (IMPORT_ENGINE.md §9.3, §11, §12).
 *
 * The property under test throughout: **the review screen's opinion that a batch is ready is a
 * suggestion; this function is the decision.** Every precondition is re-checked in SQL, so a caller
 * who forged the request still cannot commit a batch with an unresolved error, a missing
 * confirmation, or rows that duplicate data committed thirty seconds ago by somebody else.
 *
 * And the property the whole phase rests on: nothing is silently discarded. A row that does not
 * commit is still there, with a status and a reason.
 */

const VALIDATION = '22023';
const CONFLICT = '40001';
const NOT_FOUND = 'P0002';

let ownerId: string;
let clientUserId: string;
let orgId: string;
let bankAccountId: string;
let counterpartyId: string;
let documentSeq = 0;

const rpc = (userId: string, fn: string, args: Record<string, unknown> = {}) =>
  clientFor(userId).schema('api').rpc(fn, args);

const one = (sql: string): string => adminSql(`with q as (${sql}) select * from q`);

function makeDocument(): string {
  documentSeq += 1;
  return one(`
    insert into public.source_documents
           (organization_id, storage_path, original_filename, mime_type, byte_size, sha256, status, document_kind)
    values ('${orgId}', '${orgId}/doc${documentSeq}/f.csv', 'f.csv', 'text/csv', 10,
            decode('${(documentSeq + 16).toString(16).padStart(2, '0')}', 'hex'), 'ready', 'bank_statement')
    returning id`);
}

interface RowSpec {
  readonly rowNumber: number;
  readonly mapped: Record<string, unknown> | null;
  readonly status: string;
  readonly hash?: string;
  readonly decision?: string;
  readonly duplicateOf?: string;
}

function makeBatch(rows: readonly RowSpec[], opts: {
  confirmations?: readonly string[];
  periodStart?: string | null;
  periodEnd?: string | null;
  method?: string;
  batchIssues?: unknown[];
} = {}): string {
  const doc = makeDocument();
  const required = `array[${(opts.confirmations ?? []).map((c) => `'${c}'`).join(',') || ''}]::text[]`;
  const batchId = one(`
    insert into public.import_batches
           (organization_id, source_document_id, import_type, target_table, bank_account_id,
            status, extraction_method, required_confirmations, period_start, period_end, batch_issues)
    values ('${orgId}', '${doc}', 'bank_statement', 'bank_transactions', '${bankAccountId}',
            'awaiting_review', '${opts.method ?? 'csv'}', ${required},
            ${opts.periodStart === null ? 'null' : `'${opts.periodStart ?? '2026-05-01'}'`},
            ${opts.periodEnd === null ? 'null' : `'${opts.periodEnd ?? '2026-05-31'}'`},
            '${JSON.stringify(opts.batchIssues ?? [])}'::jsonb)
    returning id`);

  for (const row of rows) {
    adminSql(`
      insert into public.import_rows
             (organization_id, batch_id, row_number, source_ref, raw_data, mapped_data, status,
              dedupe_hash, reviewer_decision, duplicate_of_table, duplicate_of_id)
      values ('${orgId}', '${batchId}', ${row.rowNumber}, 'csv:row:${row.rowNumber}',
              '{"source":"line"}'::jsonb,
              ${row.mapped === null ? 'null' : `'${JSON.stringify(row.mapped)}'::jsonb`},
              '${row.status}',
              ${row.hash ? `decode('${row.hash}','hex')` : 'null'},
              '${row.decision ?? 'none'}',
              ${row.duplicateOf ? `'bank_transactions'` : 'null'},
              ${row.duplicateOf ? `'${row.duplicateOf}'` : 'null'})`);
  }
  return batchId;
}

/** An invoice batch: the same shape as `makeBatch`, aimed at `invoices` (ADR-029.1, ADR-073). */
function makeInvoiceBatch(rows: readonly {
  rowNumber: number; number: string; total: string; hash: string; duplicateOf?: string;
}[]): string {
  const doc = makeDocument();
  const batchId = one(`
    insert into public.import_batches
           (organization_id, source_document_id, import_type, target_table, status,
            extraction_method, required_confirmations, period_start, period_end, batch_issues)
    values ('${orgId}', '${doc}', 'sales_invoices', 'invoices', 'awaiting_review', 'csv',
            array[]::text[], '2026-05-01', '2026-05-31', '[]'::jsonb)
    returning id`);
  for (const row of rows) {
    adminSql(`
      insert into public.import_rows
             (organization_id, batch_id, row_number, source_ref, raw_data, mapped_data, status,
              dedupe_hash, reviewer_decision, duplicate_of_table, duplicate_of_id)
      values ('${orgId}', '${batchId}', ${row.rowNumber}, 'csv:row:${row.rowNumber}',
              '{"source":"line"}'::jsonb,
              '${JSON.stringify({
                invoice_type: 'sales', counterparty_id: counterpartyId, invoice_number: row.number,
                issue_date: '2026-05-05', due_date: '2026-06-04',
                subtotal: row.total, tax_amount: '0', total_amount: row.total,
              })}'::jsonb,
              'valid', decode('${row.hash}', 'hex'), 'none',
              ${row.duplicateOf ? `'invoices'` : 'null'},
              ${row.duplicateOf ? `'${row.duplicateOf}'` : 'null'})`);
  }
  return batchId;
}

/** The one current (accepted, not superseded) invoice with this number, and its total. */
const currentInvoice = (number: string): { id: string; total: string } | null => {
  const row = adminSql(`
    select id::text || '|' || total_amount::text from public.invoices
     where organization_id = '${orgId}' and invoice_number = '${number}'
       and record_status = 'accepted' and superseded_by is null`);
  if (!row) return null;
  const [id, total] = row.split('|') as [string, string];
  return { id, total };
};

const txn = (date: string, amount: string, description: string) => ({
  transaction_date: date, amount, description,
});

beforeAll(async () => {
  resetFixtures();
  ownerId = createAuthUser('imp-owner@itest.motion');
  clientUserId = createAuthUser('imp-client@itest.motion');

  const created = await rpc(ownerId, 'create_organization', { p_name: 'ITest Imports' });
  if (created.error) throw new Error(`fixture org failed: ${created.error.message}`);
  orgId = created.data as unknown as string;

  adminSql(`
    set local app.bootstrap = 'on';
    insert into public.organization_memberships (organization_id, user_id, role)
    values ('${orgId}', '${clientUserId}', 'client');`);

  bankAccountId = one(`
    insert into public.bank_accounts (organization_id, name, bank_name, account_type)
    values ('${orgId}', 'Current', 'Barclays', 'current') returning id`);
  counterpartyId = one(`
    insert into public.counterparties (organization_id, name, normalized_name)
    values ('${orgId}', 'Acme Customer', 'acme customer') returning id`);
});

afterAll(() => resetFixtures());

beforeEach(() => {
  // Each test builds its own batch; clear committed records so hashes cannot collide across tests.
  //
  // `record_status_events` is append-only and its guard refuses a plain DELETE — correctly, and the
  // first run of this suite proved it. Test teardown therefore uses the same escape hatch the purge
  // job does (`app.purge`), inside a transaction so the setting is local to it. Nothing here is a
  // path production code can take.
  adminSql(`
    begin;
    set local app.purge = 'on';
    delete from public.record_status_events where organization_id = '${orgId}';
    delete from public.bank_transactions where organization_id = '${orgId}';
    delete from public.invoices where organization_id = '${orgId}';
    delete from public.import_rows where organization_id = '${orgId}';
    delete from public.import_batches where organization_id = '${orgId}';
    delete from public.source_documents where organization_id = '${orgId}';
    commit;`);
});

describe('the commit gate refuses what the review screen might have missed', () => {
  it('refuses while a row still has an unresolved error', async () => {
    const batch = makeBatch([
      { rowNumber: 2, mapped: txn('2026-05-04', '-10.00', 'A'), status: 'valid', hash: 'a1' },
      { rowNumber: 3, mapped: null, status: 'error', hash: 'a2' },
    ]);
    const { error } = await rpc(ownerId, 'commit_import_batch', { p_batch: batch });
    expect(sqlstate(error)).toBe(VALIDATION);
    expect(error?.message).toContain('errors');
  });

  it('refuses while a row edited by a reviewer has not been re-validated', async () => {
    const batch = makeBatch([
      { rowNumber: 2, mapped: txn('2026-05-04', '-10.00', 'A'), status: 'pending', hash: 'b1' },
    ]);
    const { error } = await rpc(ownerId, 'commit_import_batch', { p_batch: batch });
    expect(sqlstate(error)).toBe(VALIDATION);
    expect(error?.message).toContain('re-validated');
  });

  it('refuses while a batch-level error stands', async () => {
    const batch = makeBatch(
      [{ rowNumber: 2, mapped: txn('2026-05-04', '-10.00', 'A'), status: 'valid', hash: 'c1' }],
      { batchIssues: [{ code: 'IMP-BAL-006', severity: 'error', message: 'does not reconcile' }] },
    );
    const { error } = await rpc(ownerId, 'commit_import_batch', { p_batch: batch });
    expect(sqlstate(error)).toBe(VALIDATION);
  });

  it('refuses while a required confirmation is unrecorded', async () => {
    const batch = makeBatch(
      [{ rowNumber: 2, mapped: txn('2026-05-04', '-10.00', 'A'), status: 'valid', hash: 'd1' }],
      { confirmations: ['IMP-TB-012'] },
    );
    const { error } = await rpc(ownerId, 'commit_import_batch', { p_batch: batch });
    expect(sqlstate(error)).toBe(VALIDATION);
    expect(error?.message).toContain('IMP-TB-012');
  });

  it('refuses while the declared export range is unconfirmed (ADR-047.6)', async () => {
    const batch = makeBatch(
      [{ rowNumber: 2, mapped: txn('2026-05-04', '-10.00', 'A'), status: 'valid', hash: 'e1' }],
      { periodStart: null, periodEnd: null },
    );
    const { error } = await rpc(ownerId, 'commit_import_batch', { p_batch: batch });
    expect(sqlstate(error)).toBe(VALIDATION);
    expect(error?.message).toContain('period');
  });

  it('refuses a caller without imports.review', async () => {
    const batch = makeBatch([
      { rowNumber: 2, mapped: txn('2026-05-04', '-10.00', 'A'), status: 'valid', hash: 'f1' },
    ]);
    const { error } = await rpc(clientUserId, 'commit_import_batch', { p_batch: batch });
    expect(sqlstate(error)).toBe('42501');
  });

  it('refuses a batch belonging to another organization with NOT FOUND', async () => {
    const stranger = createAuthUser('imp-stranger@itest.motion');
    const other = await rpc(stranger, 'create_organization', { p_name: 'ITest Import Stranger' });
    const batch = makeBatch([
      { rowNumber: 2, mapped: txn('2026-05-04', '-10.00', 'A'), status: 'valid', hash: 'c1' },
    ]);
    void other;
    const { error } = await rpc(stranger, 'commit_import_batch', { p_batch: batch });
    expect(sqlstate(error), 'a 42501 would confirm the batch exists').toBe(NOT_FOUND);
  });
});

describe('a clean batch commits, and nothing is discarded', () => {
  it('writes records, links them both ways and leaves every row accounted for', async () => {
    const batch = makeBatch([
      { rowNumber: 2, mapped: txn('2026-05-04', '-125.50', 'ACME LTD 12345678'), status: 'valid', hash: '11' },
      { rowNumber: 3, mapped: txn('2026-05-06', '2000.00', 'CUSTOMER PAYMENT'), status: 'valid', hash: '12' },
      { rowNumber: 4, mapped: null, status: 'skipped', hash: undefined },
      { rowNumber: 5, mapped: txn('2026-05-07', '-9.99', 'BAD'), status: 'error', decision: 'skip', hash: '13' },
    ]);

    const { data, error } = await rpc(ownerId, 'commit_import_batch', { p_batch: batch });
    expect(error, error?.message).toBeNull();
    expect((data as { committed: number }).committed).toBe(2);

    const committed = adminSql(`
      select count(*) from public.bank_transactions
       where organization_id = '${orgId}' and record_status = 'accepted'`);
    expect(Number(committed)).toBe(2);

    // §13: both directions. A reviewer asks "what did this row become?"; a reader asks "where did
    // this figure come from?". Neither question may be unanswerable.
    const linked = adminSql(`
      select count(*) from public.bank_transactions t
       join public.import_rows r on r.id = t.import_row_id
      where t.organization_id = '${orgId}' and r.committed_record_id = t.id`);
    expect(Number(linked)).toBe(2);

    const sourceRefs = adminSql(`
      select string_agg(source_ref, ',' order by source_ref) from public.bank_transactions
       where organization_id = '${orgId}'`);
    expect(sourceRefs).toBe('csv:row:2,csv:row:3');

    // Every parsed line still exists, with a status explaining itself.
    const statuses = adminSql(`
      select string_agg(status::text || '=' || c::text, ',' order by status::text)
        from (select status, count(*) c from public.import_rows
               where organization_id = '${orgId}' group by status) s`);
    expect(statuses).toBe('committed=2,skipped=2');

    const parsedLines = adminSql(`
      select count(*) from public.import_rows where organization_id = '${orgId}'`);
    expect(Number(parsedLines), 'every parsed line is still recorded').toBe(4);
  });

  it('writes an accepted lifecycle event per record (ADR-034)', async () => {
    const batch = makeBatch([
      { rowNumber: 2, mapped: txn('2026-05-04', '-10.00', 'A'), status: 'valid', hash: '21' },
    ]);
    await rpc(ownerId, 'commit_import_batch', { p_batch: batch });

    const events = adminSql(`
      select count(*) from public.record_status_events
       where organization_id = '${orgId}' and event = 'accepted' and record_table = 'bank_transactions'`);
    expect(Number(events)).toBe(1);
  });

  it('queues a recalculation, because the figures must catch up with the data', async () => {
    const batch = makeBatch([
      { rowNumber: 2, mapped: txn('2026-05-04', '-10.00', 'A'), status: 'valid', hash: '31' },
    ]);
    await rpc(ownerId, 'commit_import_batch', { p_batch: batch });

    const job = adminSql(`
      select calculation_job_id is not null from public.import_batches where id = '${batch}'`);
    expect(job).toBe('t');
  });

  it('masks the stored description, never the raw text (ADR-038.4)', async () => {
    const batch = makeBatch([
      { rowNumber: 2, mapped: txn('2026-05-04', '-10.00', 'PAY 20-45-67 12345678'), status: 'valid', hash: '41' },
    ]);
    await rpc(ownerId, 'commit_import_batch', { p_batch: batch });

    const pair = adminSql(`
      select description_raw || ' || ' || description_normalized
        from public.bank_transactions where organization_id = '${orgId}'`);
    const [raw, masked] = pair.split(' || ') as [string, string];
    expect(raw, 'the raw text is kept verbatim for evidence').toBe('PAY 20-45-67 12345678');
    expect(masked).toBe('PAY ****4567 ****5678');
  });
});

describe('a duplicate commits only on an explicit decision (§9)', () => {
  it('skips a duplicate by default and keeps it on an explicit keep with a reason', async () => {
    const first = makeBatch([
      { rowNumber: 2, mapped: txn('2026-05-04', '-50.00', 'RENT'), status: 'valid', hash: '51' },
    ]);
    await rpc(ownerId, 'commit_import_batch', { p_batch: first });

    const existing = adminSql(`select id from public.bank_transactions where organization_id = '${orgId}'`);

    const second = makeBatch([
      { rowNumber: 2, mapped: txn('2026-05-04', '-50.00', 'RENT'), status: 'duplicate', hash: '51', duplicateOf: existing },
      { rowNumber: 3, mapped: txn('2026-05-04', '-50.00', 'RENT UNIT 2'), status: 'duplicate', hash: '52', duplicateOf: existing, decision: 'keep' },
    ]);
    const { data, error } = await rpc(ownerId, 'commit_import_batch', { p_batch: second });
    expect(error, error?.message).toBeNull();
    // Only the explicitly-kept one commits; the undecided duplicate does not.
    expect((data as { committed: number }).committed).toBe(1);

    const kept = adminSql(`
      select duplicate_reviewed from public.bank_transactions
       where organization_id = '${orgId}' and description_raw = 'RENT UNIT 2'`);
    // The flag the duplicate alert rule excludes on (FINANCIAL_ENGINE.md §8).
    expect(kept).toBe('t');
  });
});

describe('the commit-time duplicate re-check (§9.3, F-D-13)', () => {
  it('aborts and returns the batch to review when another batch committed the same rows first', async () => {
    // Two batches validated against the same empty month, as two reviewers in two tabs.
    const batchA = makeBatch([
      { rowNumber: 2, mapped: txn('2026-05-10', '-77.00', 'SHARED'), status: 'valid', hash: '61' },
    ]);
    const batchB = makeBatch([
      { rowNumber: 2, mapped: txn('2026-05-10', '-77.00', 'SHARED'), status: 'valid', hash: '61' },
    ]);

    const first = await rpc(ownerId, 'commit_import_batch', { p_batch: batchA });
    expect(first.error, first.error?.message).toBeNull();

    const second = await rpc(ownerId, 'commit_import_batch', { p_batch: batchB });
    // It returns a conflict rather than raising: raising would roll back the re-flagging the
    // reviewer needs to see (§9.3).
    expect(second.error, second.error?.message).toBeNull();
    expect((second.data as { status: string }).status).toBe('conflict');
    expect((second.data as { collisions: number }).collisions).toBe(1);

    // The batch is back in review with the offending row re-flagged, not left in `committing`.
    const status = adminSql(`select status from public.import_batches where id = '${batchB}'`);
    expect(status).toBe('awaiting_review');

    const flagged = adminSql(`
      select status from public.import_rows where batch_id = '${batchB}' and row_number = 2`);
    expect(flagged).toBe('duplicate');

    const acceptedRows = adminSql(`
      select count(*) from public.bank_transactions
       where organization_id = '${orgId}' and record_status = 'accepted'`);
    expect(Number(acceptedRows), 'nothing was written twice').toBe(1);
  });
});

describe('an invoice re-export updates by supersession, at commit (ADR-029.1, ADR-073)', () => {
  /*
   * PRODUCTION_AUDIT.md M3, and what it turned out to be. The commit loop inserted the new invoice
   * as `accepted` and then superseded the old one; `invoices_identity_unique` is partial on exactly
   * that state, so the insert collided with the row it was replacing — on EVERY re-exported invoice,
   * not only the concurrent case. Executed with the real function before the fix: "duplicate key
   * value violates unique constraint invoices_identity_unique". Nothing tested the path.
   */
  it('commits a validated update candidate: the new row is current, the old one superseded', async () => {
    const first = makeInvoiceBatch([{ rowNumber: 2, number: 'INV-100', total: '1000.00', hash: 'a1' }]);
    expect((await rpc(ownerId, 'commit_import_batch', { p_batch: first })).error).toBeNull();
    const before = currentInvoice('INV-100');
    expect(before?.total).toBe('1000.00');

    // The re-export, with payment applied: same identity, different figures, flagged at validation.
    const second = makeInvoiceBatch([
      { rowNumber: 2, number: 'INV-100', total: '1200.00', hash: 'a2', duplicateOf: before!.id },
    ]);
    const result = await rpc(ownerId, 'commit_import_batch', { p_batch: second });
    expect(result.error, result.error?.message).toBeNull();
    expect((result.data as { status: string; superseded: number }).status).toBe('committed');
    expect((result.data as { superseded: number }).superseded).toBe(1);

    const after = currentInvoice('INV-100');
    expect(after?.total).toBe('1200.00');
    expect(adminSql(`select superseded_by::text from public.invoices where id = '${before!.id}'`))
      .toBe(after!.id);
    // Never two current rows for one identity, and never a row left `pending`.
    expect(adminSql(`
      select count(*) from public.invoices where organization_id = '${orgId}'
         and invoice_number = 'INV-100' and record_status = 'accepted' and superseded_by is null`)).toBe('1');
    expect(adminSql(`
      select count(*) from public.invoices where organization_id = '${orgId}' and record_status = 'pending'`)).toBe('0');
    expect(adminSql(`
      select string_agg(event::text, ',' order by event::text) from public.record_status_events
       where organization_id = '${orgId}' and record_id = '${before!.id}'`)).toBe('accepted,superseded');
  });

  it('turns a re-export committed by somebody else since validation into an update, not a crash (§9.3 pass 1)', async () => {
    // Two batches validated against the same empty month: neither knows about the other.
    const batchA = makeInvoiceBatch([{ rowNumber: 2, number: 'INV-200', total: '100.00', hash: 'b1' }]);
    const batchB = makeInvoiceBatch([{ rowNumber: 2, number: 'INV-200', total: '120.00', hash: 'b2' }]);

    expect((await rpc(ownerId, 'commit_import_batch', { p_batch: batchA })).error).toBeNull();
    const result = await rpc(ownerId, 'commit_import_batch', { p_batch: batchB });
    expect(result.error, result.error?.message).toBeNull();
    expect((result.data as { status: string }).status).toBe('committed');
    expect((result.data as { superseded: number }).superseded).toBe(1);

    expect(currentInvoice('INV-200')?.total).toBe('120.00');
    const issues = adminSql(`
      select string_agg(i ->> 'code', ',') from public.import_rows r, jsonb_array_elements(r.issues) i
       where r.batch_id = '${batchB}' and r.row_number = 2`);
    expect(issues).toContain('IMP-INV-010');
  });

  it('still sends the byte-identical invoice back to review rather than updating it (pass 2 before pass 1)', async () => {
    const batchA = makeInvoiceBatch([{ rowNumber: 2, number: 'INV-300', total: '50.00', hash: 'c1' }]);
    const batchB = makeInvoiceBatch([{ rowNumber: 2, number: 'INV-300', total: '50.00', hash: 'c1' }]);
    expect((await rpc(ownerId, 'commit_import_batch', { p_batch: batchA })).error).toBeNull();
    const result = await rpc(ownerId, 'commit_import_batch', { p_batch: batchB });
    expect(result.error).toBeNull();
    expect((result.data as { status: string }).status).toBe('conflict');
    expect(adminSql(`select status from public.import_rows where batch_id = '${batchB}' and row_number = 2`))
      .toBe('duplicate');
    expect(adminSql(`
      select count(*) from public.invoices where organization_id = '${orgId}' and invoice_number = 'INV-300'`)).toBe('1');
  });

  it('follows the chain when the row it meant to update was itself updated meanwhile', async () => {
    const v1 = makeInvoiceBatch([{ rowNumber: 2, number: 'INV-400', total: '10.00', hash: 'd1' }]);
    expect((await rpc(ownerId, 'commit_import_batch', { p_batch: v1 })).error).toBeNull();
    const first = currentInvoice('INV-400')!;

    // Two re-exports both validated against v1; the first to commit supersedes it.
    const v2 = makeInvoiceBatch([{ rowNumber: 2, number: 'INV-400', total: '20.00', hash: 'd2', duplicateOf: first.id }]);
    const v3 = makeInvoiceBatch([{ rowNumber: 2, number: 'INV-400', total: '30.00', hash: 'd3', duplicateOf: first.id }]);
    expect((await rpc(ownerId, 'commit_import_batch', { p_batch: v2 })).error).toBeNull();
    const result = await rpc(ownerId, 'commit_import_batch', { p_batch: v3 });
    expect(result.error, result.error?.message).toBeNull();
    expect((result.data as { status: string }).status).toBe('committed');
    expect(currentInvoice('INV-400')?.total).toBe('30.00');
    // v1 → v2 → v3: one current row, two superseded, a chain and not a fork.
    expect(adminSql(`
      select count(*) from public.invoices where organization_id = '${orgId}'
         and invoice_number = 'INV-400' and superseded_by is not null`)).toBe('2');
  });
});

describe('rollback and replace (§12)', () => {
  it('soft-rejects records and never deletes them (ADR-012)', async () => {
    const batch = makeBatch([
      { rowNumber: 2, mapped: txn('2026-05-04', '-10.00', 'ONE'), status: 'valid', hash: '71' },
    ]);
    await rpc(ownerId, 'commit_import_batch', { p_batch: batch });

    const { error } = await rpc(ownerId, 'rollback_import_batch', {
      p_batch: batch, p_reason: 'wrong file',
    });
    expect(error, error?.message).toBeNull();

    const row = adminSql(`
      select record_status || '|' || coalesce(rejected_reason, '')
        from public.bank_transactions where organization_id = '${orgId}'`);
    expect(row).toBe('rejected|wrong file');

    const events = adminSql(`
      select count(*) from public.record_status_events
       where organization_id = '${orgId}' and event = 'rejected'`);
    expect(Number(events)).toBe(1);
  });

  it('requires a reason', async () => {
    const batch = makeBatch([
      { rowNumber: 2, mapped: txn('2026-05-04', '-10.00', 'ONE'), status: 'valid', hash: '81' },
    ]);
    await rpc(ownerId, 'commit_import_batch', { p_batch: batch });
    const { error } = await rpc(ownerId, 'rollback_import_batch', { p_batch: batch, p_reason: '  ' });
    expect(sqlstate(error)).toBe(VALIDATION);
  });

  it('refuses to roll back a batch that was never committed', async () => {
    const batch = makeBatch([
      { rowNumber: 2, mapped: txn('2026-05-04', '-10.00', 'ONE'), status: 'valid', hash: '91' },
    ]);
    const { error } = await rpc(ownerId, 'rollback_import_batch', { p_batch: batch, p_reason: 'x' });
    expect(sqlstate(error)).toBe(CONFLICT);
  });

  it('promotes a dependant row rather than losing it (ADR-047.9)', async () => {
    const batchA = makeBatch([
      { rowNumber: 2, mapped: txn('2026-05-04', '-100.00', 'SHARED ROW'), status: 'valid', hash: 'a1a1' },
      { rowNumber: 3, mapped: txn('2026-05-05', '-200.00', 'A ONLY'), status: 'valid', hash: 'a2a2' },
    ]);
    await rpc(ownerId, 'commit_import_batch', { p_batch: batchA });

    const sharedId = adminSql(`
      select id from public.bank_transactions
       where organization_id = '${orgId}' and description_raw = 'SHARED ROW'`);

    // Batch B overlaps and skipped the shared row BECAUSE batch A already held it.
    const batchB = makeBatch([
      { rowNumber: 2, mapped: txn('2026-05-04', '-100.00', 'SHARED ROW'), status: 'duplicate', hash: 'a1a1', decision: 'skip', duplicateOf: sharedId },
      { rowNumber: 3, mapped: txn('2026-06-02', '-300.00', 'B ONLY'), status: 'valid', hash: 'b1b1' },
    ]);
    await rpc(ownerId, 'commit_import_batch', { p_batch: batchB });

    const { data, error } = await rpc(ownerId, 'rollback_import_batch', {
      p_batch: batchA, p_reason: 'corrected statement',
    });
    expect(error, error?.message).toBeNull();
    expect((data as { promoted: number }).promoted, 'the shared row must be rescued').toBe(1);

    // The shared row still exists, now belonging to the batch that had skipped it.
    const survivor = adminSql(`
      select import_batch_id = '${batchB}' and promoted_from_batch_id = '${batchA}'
        from public.bank_transactions
       where organization_id = '${orgId}' and description_raw = 'SHARED ROW'
         and record_status = 'accepted'`);
    expect(survivor, 'the row is kept and re-owned, not lost').toBe('t');

    const remaining = adminSql(`
      select string_agg(description_raw, ',' order by description_raw)
        from public.bank_transactions
       where organization_id = '${orgId}' and record_status = 'accepted'`);
    expect(remaining).toBe('B ONLY,SHARED ROW');
  });

  it('replaces a batch in one transaction, of the same type only', async () => {
    const oldBatch = makeBatch([
      { rowNumber: 2, mapped: txn('2026-05-04', '-10.00', 'OLD'), status: 'valid', hash: 'c1c1' },
    ]);
    await rpc(ownerId, 'commit_import_batch', { p_batch: oldBatch });

    const newBatch = makeBatch([
      { rowNumber: 2, mapped: txn('2026-05-04', '-12.00', 'CORRECTED'), status: 'valid', hash: 'c2c2' },
    ]);

    const { error } = await rpc(ownerId, 'replace_import_batch', {
      p_old_batch: oldBatch, p_new_batch: newBatch, p_reason: 'corrected export',
    });
    expect(error, error?.message).toBeNull();

    const accepted = adminSql(`
      select string_agg(description_raw, ',') from public.bank_transactions
       where organization_id = '${orgId}' and record_status = 'accepted'`);
    expect(accepted).toBe('CORRECTED');

    const states = adminSql(`
      select (select status from public.import_batches where id = '${oldBatch}')::text || '|' ||
             (select status from public.import_batches where id = '${newBatch}')::text`);
    expect(states).toBe('rolled_back|committed');
  });

  it('refuses to replace a batch with one of a different type', async () => {
    const oldBatch = makeBatch([
      { rowNumber: 2, mapped: txn('2026-05-04', '-10.00', 'OLD'), status: 'valid', hash: 'd1d1' },
    ]);
    await rpc(ownerId, 'commit_import_batch', { p_batch: oldBatch });

    const doc = makeDocument();
    const glBatch = one(`
      insert into public.import_batches
             (organization_id, source_document_id, import_type, target_table, status,
              extraction_method, period_start, period_end)
      values ('${orgId}', '${doc}', 'general_ledger', 'ledger_entries', 'awaiting_review',
              'csv', '2026-05-01', '2026-05-31')
      returning id`);

    const { error } = await rpc(ownerId, 'replace_import_batch', {
      p_old_batch: oldBatch, p_new_batch: glBatch, p_reason: 'wrong',
    });
    expect(sqlstate(error)).toBe(VALIDATION);
  });
});

describe('confirmations are recorded facts, not client claims', () => {
  it('refuses a confirmation the batch does not require', async () => {
    const batch = makeBatch(
      [{ rowNumber: 2, mapped: txn('2026-05-04', '-10.00', 'A'), status: 'valid', hash: 'e1e1' }],
      { confirmations: ['IMP-RANGE-015'] },
    );
    const { error } = await rpc(ownerId, 'record_batch_confirmation', {
      p_batch: batch, p_code: 'IMP-TB-012', p_value: { balance_basis: 'cumulative' },
    });
    expect(sqlstate(error)).toBe(VALIDATION);
  });

  it('sets the declared range from the confirmation, and records who confirmed it', async () => {
    const batch = makeBatch(
      [{ rowNumber: 2, mapped: txn('2026-05-04', '-10.00', 'A'), status: 'valid', hash: 'f1f1' }],
      { confirmations: ['IMP-RANGE-015'], periodStart: null, periodEnd: null },
    );
    const { error } = await rpc(ownerId, 'record_batch_confirmation', {
      p_batch: batch, p_code: 'IMP-RANGE-015',
      p_value: { period_start: '2026-05-01', period_end: '2026-05-31' },
    });
    expect(error, error?.message).toBeNull();

    const range = adminSql(`
      select period_start::text || '..' || period_end::text || '|' || (confirmations -> 'IMP-RANGE-015' ->> 'by')
        from public.import_batches where id = '${batch}'`);
    expect(range).toBe(`2026-05-01..2026-05-31|${ownerId}`);
  });

  it('refuses an export range confirmation missing either end', async () => {
    const batch = makeBatch(
      [{ rowNumber: 2, mapped: txn('2026-05-04', '-10.00', 'A'), status: 'valid', hash: 'ac01' }],
      { confirmations: ['IMP-RANGE-015'], periodStart: null, periodEnd: null },
    );
    const { error } = await rpc(ownerId, 'record_batch_confirmation', {
      p_batch: batch, p_code: 'IMP-RANGE-015', p_value: { period_start: '2026-05-01' },
    });
    expect(sqlstate(error)).toBe(VALIDATION);
  });
});

describe('an AI-read document needs every page confirmed (§5.4)', () => {
  it('refuses to commit while a page carrying rows is unconfirmed', async () => {
    const batch = makeBatch(
      [{ rowNumber: 2, mapped: txn('2026-05-04', '-10.00', 'A'), status: 'warning', hash: 'ad01' }],
      { method: 'pdf_claude' },
    );
    adminSql(`update public.import_rows set source_page = 3 where batch_id = '${batch}'`);

    const refused = await rpc(ownerId, 'commit_import_batch', { p_batch: batch });
    expect(sqlstate(refused.error)).toBe(VALIDATION);
    expect(refused.error?.message).toContain('page');

    const confirmed = await rpc(ownerId, 'confirm_pdf_page', { p_batch: batch, p_page: 3 });
    expect(confirmed.error, confirmed.error?.message).toBeNull();

    const committed = await rpc(ownerId, 'commit_import_batch', { p_batch: batch });
    expect(committed.error, committed.error?.message).toBeNull();
  });

  it('stamps AI-read rows as inferred, so the figures are labelled downstream', async () => {
    const batch = makeBatch(
      [{ rowNumber: 2, mapped: txn('2026-05-04', '-10.00', 'A'), status: 'warning', hash: 'ae01' }],
      { method: 'pdf_claude' },
    );
    adminSql(`update public.import_rows set source_page = 1 where batch_id = '${batch}'`);
    await rpc(ownerId, 'confirm_pdf_page', { p_batch: batch, p_page: 1 });
    await rpc(ownerId, 'commit_import_batch', { p_batch: batch });

    const assurance = adminSql(`
      select distinct assurance_level::text from public.bank_transactions
       where organization_id = '${orgId}' and record_status = 'accepted'`);
    expect(assurance).toBe('inferred');
  });

  it('stamps a positionally-parsed PDF as calculated when it did not reconcile (§5.3)', async () => {
    const batch = makeBatch(
      [{ rowNumber: 2, mapped: txn('2026-05-04', '-10.00', 'A'), status: 'valid', hash: 'af01' }],
      { method: 'pdf_text', batchIssues: [{ code: 'IMP-BAL-007', severity: 'warning', message: 'unreconciled' }] },
    );
    await rpc(ownerId, 'commit_import_batch', { p_batch: batch });

    const assurance = adminSql(`
      select distinct assurance_level::text from public.bank_transactions
       where organization_id = '${orgId}' and record_status = 'accepted'`);
    expect(assurance, 'positional parsing is heuristic until the statement reconciles').toBe('calculated');
  });
});

describe('a reviewer edit keeps the original', () => {
  it('changes mapped_data, leaves raw_data untouched, and forces re-validation', async () => {
    const batch = makeBatch([
      { rowNumber: 2, mapped: txn('2026-05-04', 'not-a-number', 'A'), status: 'error', hash: 'ba01' },
    ]);
    const rowId = adminSql(`select id from public.import_rows where batch_id = '${batch}'`);

    const { error } = await rpc(ownerId, 'fix_import_row', {
      p_batch: batch, p_row: rowId, p_patch: { amount: '-42.00' },
    });
    expect(error, error?.message).toBeNull();

    const after = adminSql(`
      select (mapped_data ->> 'amount') || '|' || (raw_data ->> 'source') || '|' || status::text
        from public.import_rows where id = '${rowId}'`);
    // The fix applies, the file as it arrived is untouched, and the row must be checked again.
    expect(after).toBe('-42.00|line|pending');
  });

  it('refuses an edit made against a stale view of the batch (§16)', async () => {
    const batch = makeBatch([
      { rowNumber: 2, mapped: txn('2026-05-04', '-1.00', 'A'), status: 'error', hash: 'bb01' },
    ]);
    const rowId = adminSql(`select id from public.import_rows where batch_id = '${batch}'`);

    const { error } = await rpc(ownerId, 'fix_import_row', {
      p_batch: batch, p_row: rowId, p_patch: { amount: '-2.00' },
      p_review_token: '00000000-0000-4000-8000-000000000000',
    });
    expect(sqlstate(error)).toBe(CONFLICT);
    expect(error?.message).toContain('reload');
  });
});
