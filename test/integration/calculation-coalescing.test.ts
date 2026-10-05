import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { claimJob, finishJob } from '@/core/db';
import { drainJobs } from '@/modules/jobs';
import { adminSql, clientFor, createAuthUser, drainUntilFinished } from './setup';

/**
 * FU-16 (ADR-132): recalculations that coalesce, retry or wait behind a running one compute the UNION
 * of every period any trigger changed.
 *
 * Before: one calculation could wait per organisation and a second trigger was dropped into it — a
 * January import arriving while a March import waited was never recomputed; an account remap arriving
 * after an import recomputed only from the import's month; and a calculation could be claimed while
 * another for the same organisation was running.
 */

const TAG = `co${Date.now().toString(36)}`;
let org = '';
let june = '';
let august = '';

const one = (sql: string): string => adminSql(`with q as (${sql}) select * from q`).split('\n')[0]!.trim();
const enqueue = (trigger: string, ref: string | null) =>
  one(`select app.enqueue_recalculation('${org}', '${trigger}', ${ref === null ? 'null' : `'${ref}'`})`);
const queuedJobs = () => adminSql(`select id from public.jobs where organization_id = '${org}'
  and job_type = 'calculation.run' and status = 'queued'`).split('\n').map((l) => l.trim()).filter(Boolean);
const payloadOf = (job: string) => JSON.parse(one(`select payload::text from public.jobs where id = '${job}'`)) as {
  trigger: string; triggerRefId: string | null; refs?: Array<{ trigger: string; triggerRefId: string | null }>;
};
const periodStartOf = (periodId: string) => one(`select period_start::text from public.fiscal_periods where id = '${periodId}'`);

function seedBatch(month: string): string {
  const doc = one(`insert into public.source_documents (organization_id, storage_path, original_filename, mime_type, byte_size, sha256, status, document_kind)
    values ('${org}', '${org}/${month}.csv', '${month}.csv', 'text/csv', 10, digest('${org}${month}', 'sha256'), 'ready', 'general_ledger') returning id`);
  const batch = one(`insert into public.import_batches (organization_id, source_document_id, import_type, target_table, status, extraction_method, period_start, period_end, committed_at)
    values ('${org}', '${doc}', 'general_ledger', 'ledger_entries', 'committed', 'csv', '${month}-01', (date '${month}-01' + interval '1 month - 1 day')::date, now()) returning id`);
  const account = (c: string) => one(`select id from public.accounts where organization_id = '${org}' and standard_category = '${c}' order by is_system desc, id limit 1`);
  for (const [category, direction] of [['cash', 'debit'], ['revenue', 'credit']] as const) {
    adminSql(`insert into public.ledger_entries (organization_id, entry_date, account_id, direction, amount, period_id, record_status, source_document_id, import_batch_id, source_ref)
      values ('${org}', '${month}-15', '${account(category)}', '${direction}', 1000, '00000000-0000-0000-0000-000000000000', 'accepted', '${doc}', '${batch}', '${category}')`);
  }
  return batch;
}

/** Runs one queued job of THIS organisation to completion, as the worker would. */
async function runToEnd(job: string): Promise<string> {
  return drainUntilFinished(drainJobs, job, 20);
}

beforeAll(async () => {
  const owner = createAuthUser(`o@${TAG}.itest`);
  const r = await clientFor(owner).schema('api').rpc('create_organization', { p_name: `Coalesce ${TAG}` });
  if (r.error) throw new Error(r.error.message);
  org = r.data as unknown as string;
  june = seedBatch('2026-06');
  august = seedBatch('2026-08');
}, 120_000);

beforeEach(() => {
  adminSql(`delete from public.jobs where organization_id = '${org}' and status in ('queued', 'running')`);
});

afterAll(() => {
  adminSql(`delete from public.organizations where id = '${org}'; delete from auth.users where email like '%@${TAG}.itest';`);
});

describe('triggers that coalesce keep the union', () => {
  it('an earlier-period import arriving while a later one waits is kept, and the run starts at June', async () => {
    const first = enqueue('import_commit', august);
    const second = enqueue('import_commit', june);
    expect(second).toBe(first);
    expect(queuedJobs()).toEqual([first]);
    const payload = payloadOf(first);
    expect((payload.refs ?? []).map((r) => r.triggerRefId).sort()).toEqual([august, june].sort());

    expect(await runToEnd(first)).toBe('succeeded');
    const from = one(`select period_from from public.calculation_runs where organization_id = '${org}' and job_id = '${first}'`);
    expect(periodStartOf(from)).toBe('2026-06-01');
  });

  it('a full-range trigger coalescing into an import makes the whole history recompute', () => {
    const job = enqueue('import_commit', august);
    enqueue('account_remapped', null);
    expect(payloadOf(job).trigger).toBe('account_remapped');
  });

  it('the same trigger twice is one job and one ref', () => {
    const job = enqueue('import_commit', august);
    enqueue('import_commit', august);
    expect(queuedJobs()).toHaveLength(1);
    expect(payloadOf(job).refs ?? [{ triggerRefId: august }]).toHaveLength(1);
  });
});

describe('an import arriving while a calculation is RUNNING', () => {
  it('waits for it, is never claimed beside it, then computes its own (earlier) periods', async () => {
    const running = enqueue('import_commit', august);
    adminSql(`update public.jobs set status = 'running', locked_at = now(), locked_by = 'itest', attempts = 1 where id = '${running}'`);
    const waiting = enqueue('import_commit', june);
    expect(waiting).not.toBe(running);

    // Claim until nothing is claimable; every job of OTHER organisations is put back untouched.
    const claimedHere: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      const claimed = await claimJob(`itest-${TAG}`);
      if (claimed === null) break;
      if (claimed.organizationId === org) claimedHere.push(claimed.jobId);
      else adminSql(`update public.jobs set status = 'queued', locked_at = null, locked_by = null, attempts = attempts - 1 where id = '${claimed.jobId}'`);
    }
    expect(claimedHere, 'a second calculation of the organisation must not start beside the running one').toEqual([]);

    // The running one finishes; the waiting one now runs, from June.
    await finishJob(running, 'succeeded', {});
    expect(await runToEnd(waiting)).toBe('succeeded');
    const from = one(`select period_from from public.calculation_runs where organization_id = '${org}' and job_id = '${waiting}'`);
    expect(periodStartOf(from)).toBe('2026-06-01');
  });
});

describe('a retry or a lost worker with a queued twin', () => {
  it('a failed run is coalesced into the waiting job, which carries both ranges', async () => {
    const failing = enqueue('import_commit', august);
    adminSql(`update public.jobs set status = 'running', locked_at = now(), attempts = 1 where id = '${failing}'`);
    const twin = enqueue('import_commit', june);
    await finishJob(failing, 'failed', {}, 'itest failure');
    expect(one(`select status from public.jobs where id = '${failing}'`)).toBe('cancelled');
    expect((payloadOf(twin).refs ?? []).map((r) => r.triggerRefId).sort()).toEqual([august, june].sort());
  });

  it('a lost worker is coalesced the same way, and claiming never raises', async () => {
    const lost = enqueue('import_commit', august);
    adminSql(`update public.jobs set status = 'running', locked_at = now() - interval '1 hour', attempts = 1 where id = '${lost}'`);
    const twin = enqueue('import_commit', june);
    adminSql(`select app.reclaim_stale_jobs()`);
    expect(one(`select status from public.jobs where id = '${lost}'`)).toBe('cancelled');
    expect((payloadOf(twin).refs ?? []).map((r) => r.triggerRefId).sort()).toEqual([august, june].sort());
  });
});

describe('a recalculation whose trigger names a row its run may not record (ADR-132)', () => {
  it.each([
    // What override_bank_category / mark_transfer, supersede_record and the opening-balance flag enqueue.
    ['banking_edit'], ['record_superseded'], ['import_commit'],
  ])('a %s carrying a ledger-entry id runs to success', async (trigger) => {
    const entry = one(`select id from public.ledger_entries where organization_id = '${org}' limit 1`);
    const job = enqueue(trigger, entry);
    expect(await runToEnd(job)).toBe('succeeded');
    const ref = one(`select coalesce(trigger_ref_id::text, 'null') from public.calculation_runs where job_id = '${job}'`);
    expect(ref).toBe('null');
  });
});
