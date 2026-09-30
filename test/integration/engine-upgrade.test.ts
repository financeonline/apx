import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enqueueEngineUpgrade } from '@/core/db';
import { ENGINE_VERSION } from '@/modules/financial-engine';
import { drainJobs } from '@/modules/jobs';
import { adminSql, clientFor, createAuthUser, drainUntilFinished } from './setup';

/**
 * ADR-120 — every organisation is recomputed on a new engine version, through the existing path.
 *
 * Five organisations, each with one month of ledger data computed for real; the engine version of a
 * run is then set back to 1.0.0 where the case needs an organisation "still on the old engine" —
 * which is exactly the state a deploy leaves every organisation in.
 *
 *   OLD_A, OLD_B    succeeded run on 1.0.0 only         → queued
 *   CURRENT         succeeded run on ENGINE_VERSION     → not queued
 *   NEVER           no run at all                       → not queued (no old figures to replace)
 *   LEAVING         1.0.0, status pending_deletion      → not queued
 */

const TAG = `up${Date.now().toString(36)}`;
const org: Record<'OLD_A' | 'OLD_B' | 'CURRENT' | 'NEVER' | 'LEAVING', string> = {
  OLD_A: '', OLD_B: '', CURRENT: '', NEVER: '', LEAVING: '',
};
const one = (sql: string): string => adminSql(`with q as (${sql}) select * from q`).split('\n')[0]!.trim();

const queued = (o: string): string[] => adminSql(`select id from public.jobs where organization_id = '${o}'
  and job_type = 'calculation.run' and status = 'queued'`).split('\n').map((l) => l.trim()).filter(Boolean);

async function seedAndRun(o: string, run: boolean): Promise<void> {
  const doc = one(`insert into public.source_documents (organization_id, storage_path, original_filename, mime_type, byte_size, sha256, status, document_kind)
    values ('${o}', '${o}/gl.csv', 'gl.csv', 'text/csv', 10, digest('${o}gl', 'sha256'), 'ready', 'general_ledger') returning id`);
  const batch = one(`insert into public.import_batches (organization_id, source_document_id, import_type, target_table, status, extraction_method, period_start, period_end, committed_at)
    values ('${o}', '${doc}', 'general_ledger', 'ledger_entries', 'committed', 'csv', '2026-06-01', '2026-06-30', now()) returning id`);
  const account = (c: string) => one(`select id from public.accounts where organization_id = '${o}' and standard_category = '${c}' order by is_system desc, id limit 1`);
  for (const [category, direction] of [['cash', 'debit'], ['revenue', 'credit']] as const) {
    adminSql(`insert into public.ledger_entries (organization_id, entry_date, account_id, direction, amount, period_id, record_status, source_document_id, import_batch_id, source_ref)
      values ('${o}', '2026-06-30', '${account(category)}', '${direction}', 1000, '00000000-0000-0000-0000-000000000000', 'accepted', '${doc}', '${batch}', '${category}')`);
  }
  if (!run) return;
  const job = one(`insert into public.jobs (organization_id, job_type, payload, max_attempts)
    values ('${o}', 'calculation.run', '{"trigger":"recalc_manual","as_of":"2026-09-15"}'::jsonb, 3) returning id`);
  expect(await drainUntilFinished(drainJobs, job)).toBe('succeeded');
}

beforeAll(async () => {
  const owners = [createAuthUser(`a@${TAG}.itest`), createAuthUser(`b@${TAG}.itest`), createAuthUser(`c@${TAG}.itest`)];
  let n = 0;
  for (const key of Object.keys(org) as Array<keyof typeof org>) {
    const r = await clientFor(owners[Math.floor(n++ / 2)]!).schema('api').rpc('create_organization', { p_name: `Upgrade ${key} ${TAG}` });
    if (r.error) throw new Error(r.error.message);
    org[key] = r.data as unknown as string;
    await seedAndRun(org[key], key !== 'NEVER');
  }
  // What a deploy leaves behind: their figures were written by the previous engine.
  adminSql(`update public.calculation_runs set engine_version = '1.0.0'
              where organization_id in ('${org.OLD_A}', '${org.OLD_B}', '${org.LEAVING}');
            update public.organizations set status = 'pending_deletion', deletion_requested_at = now() where id = '${org.LEAVING}';`);
  // Anything the fixture runs left queued (their alert passes) is not what this suite measures.
  adminSql(`delete from public.jobs where organization_id in (${Object.values(org).map((o) => `'${o}'`).join(',')}) and status = 'queued'`);
}, 600_000);

afterAll(() => {
  adminSql(`delete from public.organizations where id in (${Object.values(org).map((o) => `'${o}'`).join(',')});
            delete from auth.users where email like '%@${TAG}.itest';`);
});

describe('the engine-upgrade recalculation (ADR-120)', () => {
  it('queues every organisation still on an older engine, and no other', async () => {
    const count = await enqueueEngineUpgrade(ENGINE_VERSION);
    expect(count).toBeGreaterThanOrEqual(2); // other suites' organisations may also be behind
    expect(queued(org.OLD_A)).toHaveLength(1);
    expect(queued(org.OLD_B)).toHaveLength(1);
    expect(queued(org.CURRENT)).toEqual([]);
    expect(queued(org.NEVER)).toEqual([]);
    expect(queued(org.LEAVING)).toEqual([]);
  });

  it('is idempotent: calling again queues nothing twice', async () => {
    const before = queued(org.OLD_A);
    await enqueueEngineUpgrade(ENGINE_VERSION);
    expect(queued(org.OLD_A)).toEqual(before);
  });

  it('audits each enqueue with its reason and version', () => {
    const audited = one(`select count(*) from public.audit_events where organization_id = '${org.OLD_A}'
      and action = 'job.enqueued' and after ->> 'reason' = 'engine_upgrade' and after ->> 'engine_version' = '${ENGINE_VERSION}'`);
    expect(Number(audited)).toBeGreaterThanOrEqual(1);
  });

  it('one organisation\'s failure neither stops the others nor goes unseen, and it is queued again', async () => {
    // Make OLD_B's run fail (an impossible as-of date) and give it one attempt.
    const failing = queued(org.OLD_B)[0]!;
    adminSql(`update public.jobs set payload = payload || '{"as_of":"not-a-date"}'::jsonb, max_attempts = 1 where id = '${failing}'`);
    const good = queued(org.OLD_A)[0]!;

    expect(await drainUntilFinished(drainJobs, good)).toBe('succeeded');
    expect(['failed', 'dead']).toContain(await drainUntilFinished(drainJobs, failing));

    // OLD_A now has a run on this engine, and recomputed its history on it.
    expect(one(`select engine_version from public.calculation_runs where organization_id = '${org.OLD_A}' and status = 'succeeded'
      order by finished_at desc limit 1`)).toBe(ENGINE_VERSION);

    // The failure is visible, and the next sweep queues OLD_B again — and only OLD_B of the two.
    await enqueueEngineUpgrade(ENGINE_VERSION);
    expect(queued(org.OLD_B)).toHaveLength(1);
    expect(queued(org.OLD_A)).toEqual([]);
  });

  it('is callable only by the server', async () => {
    const outsider = createAuthUser(`x@${TAG}.itest`);
    const { error } = await clientFor(outsider).schema('api_server').rpc('enqueue_engine_upgrade', { p_engine_version: ENGINE_VERSION });
    expect(error).not.toBeNull();
  });

  it('refuses something that is not a version', async () => {
    await expect(enqueueEngineUpgrade('latest')).rejects.toThrow();
  });
});
