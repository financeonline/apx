import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setImportLimits, LIMITS } from '@/db/app/imports-exec';
import { orgDoc, orgRow } from '@/db/schema';
import { clientFor, createAuthUser, deleteOrg, fs, rpc as call, sqlstate } from './setup';
import { makeOrg, seedBankAccount, systemAccount } from './f-fixtures';
import { clearTables, seedBatch, seedRows, where } from './i-fixtures';

/**
 * A commit too large for one Firestore transaction (src/db/app/imports-exec.ts): planned durably,
 * applied in chunks, and resumable after a crash — so the new state is always reachable, nothing is
 * applied twice, and nobody else can commit or roll back in the organisation while a plan is open.
 *
 * The limits are shrunk so a forty-row file takes the path a five-thousand-row one would.
 */

const RUN = `il${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.imports.itest.motion`;
let ownerId: string;
let orgId: string;
let bankAccountId: string;
let saved: typeof LIMITS;

const rpc = (fn: string, args: Record<string, unknown>) => call(clientFor(ownerId), fn, args);
const status = async (id: string) => String((await orgRow(fs(), orgId, 'import_batches', id).get()).get('status'));
const lock = async () => (await orgDoc(fs(), orgId).collection('_locks').doc('imports').get()).data() ?? {};

async function bankBatch(n: number, tag: string): Promise<string> {
  const batch = await seedBatch(orgId, { importType: 'bank_statement', bankAccountId });
  await seedRows(orgId, batch, Array.from({ length: n }, (_, i) => ({
    rowNumber: i + 2, status: 'valid', hash: `${tag}${String(i).padStart(4, '0')}`,
    mapped: { transaction_date: `2026-05-${String((i % 28) + 1).padStart(2, '0')}`, amount: `-${i + 1}.00`, description: `${tag} ${i}` },
  })));
  return batch;
}

beforeAll(async () => {
  ownerId = await createAuthUser(`owner@${DOMAIN}`);
  orgId = await makeOrg(ownerId, `ITest Imports Large ${RUN}`);
  bankAccountId = await seedBankAccount(orgId, { name: 'Current' });
}, 60_000);

afterAll(async () => {
  const jobs = await fs().collection('jobs').where('organization_id', '==', orgId).get();
  await Promise.all(jobs.docs.map((d) => d.ref.delete()));
  await deleteOrg(orgId);
});

beforeEach(async () => {
  saved = setImportLimits({ largeRows: 5, chunkWrites: 25 });
  await clearTables(orgId, ['record_status_events', 'bank_transactions', 'period_balances', 'import_rows', 'import_batches', 'source_documents', 'category_history']);
});

afterEach(() => { setImportLimits(saved); });

describe('a large commit is planned, applied in chunks, and finished', () => {
  it('commits every row exactly once and releases the organisation', async () => {
    const batch = await bankBatch(40, 'aa');
    const { data, error } = await rpc('commit_import_batch', { p_batch: batch });
    expect(error, error?.message).toBeNull();
    expect(data).toMatchObject({ status: 'committed', committed: 40, superseded: 0 });
    expect((data as { job: string | null }).job).toBeTruthy();
    expect(await where(orgId, 'bank_transactions', { record_status: 'accepted' })).toHaveLength(40);
    expect(await status(batch)).toBe('committed');
    expect((await lock()).holder_batch_id ?? null).toBeNull();
    expect((await orgDoc(fs(), orgId).collection('_import_plans').get()).size, 'the plan is cleaned up').toBe(0);
    expect((await orgRow(fs(), orgId, 'import_batches', batch).get()).get('calculation_job_id')).toBe((data as { job: string }).job);
  });

  it('survives a crash between chunks: others are held off, and the retry finishes the same plan', async () => {
    const batch = await bankBatch(40, 'bb');
    const other = await bankBatch(2, 'cc');
    setImportLimits({ crashAfterChunks: 2 });
    const crashed = await rpc('commit_import_batch', { p_batch: batch });
    expect(crashed.error?.message).toContain('simulated crash');
    setImportLimits({ crashAfterChunks: null });

    expect(await status(batch)).toBe('committing');
    expect((await lock()).holder_batch_id).toBe(batch);
    // While the plan is open nobody else commits, rolls back or rejects it.
    const blocked = await rpc('commit_import_batch', { p_batch: other });
    expect(sqlstate(blocked.error)).toBe('23505');
    const reject = await rpc('reject_import_batch', { p_batch: batch, p_reason: 'x' });
    expect(sqlstate(reject.error)).toBe('23505');

    const resumed = await rpc('commit_import_batch', { p_batch: batch });
    expect(resumed.error, resumed.error?.message).toBeNull();
    expect(resumed.data).toMatchObject({ status: 'committed', committed: 40 });
    const accepted = await where(orgId, 'bank_transactions', { import_batch_id: batch });
    expect(accepted, 'no row applied twice').toHaveLength(40);
    expect(new Set(accepted.map((t) => t.import_row_id)).size).toBe(40);
    expect(await where(orgId, 'record_status_events', { import_batch_id: batch, event: 'accepted' })).toHaveLength(40);
    expect((await lock()).holder_batch_id ?? null).toBeNull();

    // And the organisation is free again.
    const after = await rpc('commit_import_batch', { p_batch: other });
    expect(after.error, after.error?.message).toBeNull();
  });

  it('rolls a large batch back the same way', async () => {
    const batch = await bankBatch(30, 'dd');
    expect((await rpc('commit_import_batch', { p_batch: batch })).error).toBeNull();
    const { data, error } = await rpc('rollback_import_batch', { p_batch: batch, p_reason: 'wrong file' });
    expect(error, error?.message).toBeNull();
    expect(data).toMatchObject({ rejected: 30, promoted: 0, restored: 0 });
    expect(await where(orgId, 'bank_transactions', { record_status: 'accepted' })).toHaveLength(0);
    expect(await status(batch)).toBe('rolled_back');
  });

  it('a large balance report supersedes the one before it, one current line per cell', async () => {
    const accounts = await Promise.all(['revenue', 'operating_expense', 'cash', 'payables', 'equity', 'payroll', 'marketing']
      .map((c) => systemAccount(orgId, c)));
    const report = async (factor: number) => {
      const b = await seedBatch(orgId, { importType: 'trial_balance', balanceBasis: 'cumulative', confirmations: { 'IMP-COV-013': { value: {} } } });
      await seedRows(orgId, b, accounts.flatMap((a, i) => ['2026-03-01', '2026-04-01'].map((m, j) => ({
        rowNumber: 2 + i * 2 + j, status: 'valid', hash: null,
        mapped: { period_start: m, account_id: a, closing_balance: String((i + 1) * factor) },
      }))));
      return b;
    };
    const first = await report(100);
    expect((await rpc('commit_import_batch', { p_batch: first })).error).toBeNull();
    const second = await report(200);
    const { data, error } = await rpc('commit_import_batch', { p_batch: second });
    expect(error, error?.message).toBeNull();
    expect(data).toMatchObject({ status: 'committed', committed: 14, superseded: 14 });
    const current = await where(orgId, 'period_balances', { record_status: 'accepted', superseded_by: null });
    expect(current).toHaveLength(14);
    expect(current.every((c) => c.import_batch_id === second)).toBe(true);
  });
});
