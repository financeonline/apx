import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { claimJob, finishJob } from '@/core/db';
import { prepareRecalculation } from '@/db/app/jobs';
import { periodId } from '@/db/app/shared';
import { nowIso, orgCollection, uniqueGuard } from '@/db/schema';
import { runTx } from '@/db/tx';
import { drainJobs } from '@/modules/jobs';
import { drainUntilFinished, fs, serviceClientScoped } from './setup';
import { removeSeeded, seedBatch, seedLedgerEntry, seedOrg } from '../fixtures/seed';

/**
 * FU-16 (ADR-132): recalculations that coalesce, retry or wait behind a running one compute the UNION
 * of every period any trigger changed.
 *
 * Before: one calculation could wait per organisation and a second trigger was dropped into it — a
 * January import arriving while a March import waited was never recomputed; an account remap arriving
 * after an import recomputed only from the import's month; and a calculation could be claimed while
 * another for the same organisation was running.
 */

const RUN = `co${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.coalesce.itest.motion`;
let org = '';
let accounts: Readonly<Record<string, string>> = {};
let june = '';
let august = '';

interface Payload { trigger: string; triggerRefId: string | null; refs?: Array<{ trigger: string; triggerRefId: string | null }> }

const jobs = () => fs().collection('jobs');
const guardRef = () => uniqueGuard(fs(), 'global', 'jobs_idempotency_queued', ['calculation.run', `calculation.run:${org}`]).ref;

/** `app.enqueue_recalculation(org, trigger, ref)`. */
async function enqueue(trigger: string, ref: string | null): Promise<string> {
  return runTx(serviceClientScoped(org), async (tx) => {
    const job = await prepareRecalculation(fs(), org, trigger, ref, null, tx);
    job.write(tx);
    return job.id;
  });
}

const queuedJobs = async () => (await jobs().where('organization_id', '==', org)
  .where('job_type', '==', 'calculation.run').where('status', '==', 'queued').get()).docs.map((d) => d.id);
const payloadOf = async (job: string) => (await jobs().doc(job).get()).get('payload') as Payload;
const statusOf = async (job: string) => String((await jobs().doc(job).get()).get('status'));

/** What claiming does to a job, written directly: running, and its queued key released. */
async function markRunning(job: string, lockedAt = nowIso()): Promise<void> {
  await jobs().doc(job).update({ status: 'running', locked_at: lockedAt, locked_by: 'itest', attempts: 1 });
  const g = await guardRef().get();
  if (g.exists && g.get('owner_id') === job) await guardRef().delete();
}

async function runFor(job: string): Promise<{ period_from: string; trigger_ref_id: string | null } | null> {
  const runs = await orgCollection(fs(), org, 'calculation_runs').where('job_id', '==', job).get();
  return (runs.docs[0]?.data() as { period_from: string; trigger_ref_id: string | null } | undefined) ?? null;
}

async function batchFor(month: string): Promise<string> {
  const end = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
  const batch = await seedBatch(org, { importType: 'general_ledger', target: 'ledger_entries', start: `${month}-01`, end });
  for (const [category, direction] of [['cash', 'debit'], ['revenue', 'credit']] as const) {
    await seedLedgerEntry(org, {
      date: `${month}-15`, accountId: accounts[category]!, direction, amount: '1000', batchId: batch, sourceRef: category,
    });
  }
  return batch;
}

/** Runs one queued job of THIS organisation to completion, as the worker would. */
async function runToEnd(job: string): Promise<string> {
  return drainUntilFinished(drainJobs, job, 20);
}

beforeAll(async () => {
  ({ orgId: org, accounts } = await seedOrg({ name: `ITest Coalesce ${RUN}`, ownerEmail: `o@${DOMAIN}` }));
  june = await batchFor('2026-06');
  august = await batchFor('2026-08');
}, 120_000);

beforeEach(async () => {
  const open = await jobs().where('organization_id', '==', org).where('status', 'in', ['queued', 'running']).get();
  for (const d of open.docs) await d.ref.delete();
  await guardRef().delete();
});

afterAll(async () => {
  const mine = await jobs().where('organization_id', '==', org).get();
  for (const d of mine.docs) await d.ref.delete();
  await guardRef().delete();
  await removeSeeded([org], DOMAIN);
});

describe('triggers that coalesce keep the union', () => {
  it('an earlier-period import arriving while a later one waits is kept, and the run starts at June', async () => {
    const first = await enqueue('import_commit', august);
    const second = await enqueue('import_commit', june);
    expect(second).toBe(first);
    expect(await queuedJobs()).toEqual([first]);
    const payload = await payloadOf(first);
    expect((payload.refs ?? []).map((r) => r.triggerRefId).sort()).toEqual([august, june].sort());

    expect(await runToEnd(first)).toBe('succeeded');
    expect((await runFor(first))?.period_from).toBe(periodId(org, '2026-06-01'));
  }, 600_000);

  it('a full-range trigger coalescing into an import makes the whole history recompute', async () => {
    const job = await enqueue('import_commit', august);
    await enqueue('account_remapped', null);
    expect((await payloadOf(job)).trigger).toBe('account_remapped');
  });

  it('the same trigger twice is one job and one ref', async () => {
    const job = await enqueue('import_commit', august);
    await enqueue('import_commit', august);
    expect(await queuedJobs()).toHaveLength(1);
    expect((await payloadOf(job)).refs ?? [{ triggerRefId: august }]).toHaveLength(1);
  });
});

describe('an import arriving while a calculation is RUNNING', () => {
  it('waits for it, is never claimed beside it, then computes its own (earlier) periods', async () => {
    const running = await enqueue('import_commit', august);
    await markRunning(running);
    const waiting = await enqueue('import_commit', june);
    expect(waiting).not.toBe(running);

    // Claim until nothing is claimable; every job of OTHER organisations is put back untouched.
    const claimedHere: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      const claimed = await claimJob(`itest-${RUN}`);
      if (claimed === null) break;
      if (claimed.organizationId === org) {
        claimedHere.push(claimed.jobId);
      } else {
        const snap = await jobs().doc(claimed.jobId).get();
        await snap.ref.update({ status: 'queued', locked_at: null, locked_by: null, attempts: claimed.attempts - 1 });
        const key = snap.get('idempotency_key') as string | null;
        if (key) {
          await uniqueGuard(fs(), 'global', 'jobs_idempotency_queued', [claimed.jobType, key]).ref.set({
            owner_id: claimed.jobId, constraint: 'jobs_idempotency_queued', created_at: nowIso(),
          });
        }
      }
    }
    expect(claimedHere, 'a second calculation of the organisation must not start beside the running one').toEqual([]);

    // The running one finishes; the waiting one now runs, from June.
    await finishJob(running, 'succeeded', {});
    expect(await runToEnd(waiting)).toBe('succeeded');
    expect((await runFor(waiting))?.period_from).toBe(periodId(org, '2026-06-01'));
  }, 600_000);
});

describe('a retry or a lost worker with a queued twin', () => {
  it('a failed run is coalesced into the waiting job, which carries both ranges', async () => {
    const failing = await enqueue('import_commit', august);
    await markRunning(failing);
    const twin = await enqueue('import_commit', june);
    await finishJob(failing, 'failed', {}, 'itest failure');
    expect(await statusOf(failing)).toBe('cancelled');
    expect(((await payloadOf(twin)).refs ?? []).map((r) => r.triggerRefId).sort()).toEqual([august, june].sort());
  });

  it('a failed run with no twin goes back to the queue holding its key again', async () => {
    const failing = await enqueue('import_commit', august);
    await markRunning(failing);
    await finishJob(failing, 'failed', {}, 'itest failure');
    expect(await statusOf(failing)).toBe('queued');
    expect((await guardRef().get()).get('owner_id')).toBe(failing);
    // So the next trigger merges into it rather than queueing a second calculation.
    expect(await enqueue('import_commit', june)).toBe(failing);
  });

  it('a lost worker is coalesced the same way, and claiming never raises', async () => {
    const lost = await enqueue('import_commit', august);
    await markRunning(lost, new Date(Date.now() - 3_600_000).toISOString());
    const twin = await enqueue('import_commit', june);
    // The reclaim runs at the start of every claim.
    const claimed = await claimJob(`itest-${RUN}`);
    if (claimed && claimed.organizationId !== org) {
      await jobs().doc(claimed.jobId).update({ status: 'queued', locked_at: null, locked_by: null, attempts: claimed.attempts - 1 });
    }
    expect(await statusOf(lost)).toBe('cancelled');
    expect(((await payloadOf(twin)).refs ?? []).map((r) => r.triggerRefId).sort()).toEqual([august, june].sort());
  });
});

describe('a recalculation whose trigger names a row its run may not record (ADR-132)', () => {
  it.each([
    // What override_bank_category / mark_transfer, supersede_record and the opening-balance flag enqueue.
    ['banking_edit'], ['record_superseded'], ['import_commit'],
  ])('a %s carrying a ledger-entry id runs to success', async (trigger) => {
    const entry = (await orgCollection(fs(), org, 'ledger_entries').limit(1).get()).docs[0]!.id;
    const job = await enqueue(trigger, entry);
    expect(await runToEnd(job)).toBe('succeeded');
    expect((await runFor(job))?.trigger_ref_id ?? null).toBeNull();
  }, 600_000);
});
