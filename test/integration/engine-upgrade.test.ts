import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enqueueEngineUpgrade } from '@/core/db';
import { nowIso, orgCollection, uniqueGuard } from '@/db/schema';
import { ENGINE_VERSION } from '@/modules/financial-engine';
import { drainJobs } from '@/modules/jobs';
import { clientFor, createAuthUser, drainUntilFinished, fs, rpc } from './setup';
import { removeSeeded, seedBatch, seedJob, seedLedgerEntry, seedOrg } from '../fixtures/seed';

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

const RUN = `up${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.upgrade.itest.motion`;
const org: Record<'OLD_A' | 'OLD_B' | 'CURRENT' | 'NEVER' | 'LEAVING', string> = {
  OLD_A: '', OLD_B: '', CURRENT: '', NEVER: '', LEAVING: '',
};

const queued = async (o: string): Promise<string[]> => (await fs().collection('jobs').where('organization_id', '==', o)
  .where('job_type', '==', 'calculation.run').where('status', '==', 'queued').get()).docs.map((d) => d.id);

async function seedAndRun(o: string, accounts: Readonly<Record<string, string>>, run: boolean): Promise<void> {
  const batch = await seedBatch(o, { importType: 'general_ledger', target: 'ledger_entries', start: '2026-06-01', end: '2026-06-30' });
  for (const [category, direction] of [['cash', 'debit'], ['revenue', 'credit']] as const) {
    await seedLedgerEntry(o, { date: '2026-06-30', accountId: accounts[category]!, direction, amount: '1000', batchId: batch, sourceRef: category });
  }
  if (!run) return;
  const job = await seedJob(o, 'calculation.run', { trigger: 'recalc_manual', as_of: '2026-09-15' });
  expect(await drainUntilFinished(drainJobs, job)).toBe('succeeded');
}

/** Removes an organisation's queued jobs and the key they hold (`delete from jobs where … queued`). */
async function dropQueued(o: string): Promise<void> {
  const snap = await fs().collection('jobs').where('organization_id', '==', o).where('status', '==', 'queued').get();
  for (const d of snap.docs) {
    const key = d.get('idempotency_key') as string | null;
    if (key) await uniqueGuard(fs(), 'global', 'jobs_idempotency_queued', [String(d.get('job_type')), key]).ref.delete();
    await d.ref.delete();
  }
}

beforeAll(async () => {
  const owners = [
    await createAuthUser(`a@${DOMAIN}`), await createAuthUser(`b@${DOMAIN}`), await createAuthUser(`c@${DOMAIN}`),
  ];
  let n = 0;
  for (const key of Object.keys(org) as Array<keyof typeof org>) {
    const seeded = await seedOrg({ name: `ITest Upgrade ${key} ${RUN}`, ownerId: owners[Math.floor(n++ / 2)]!, around: '2026-09-15' });
    org[key] = seeded.orgId;
    await seedAndRun(seeded.orgId, seeded.accounts, key !== 'NEVER');
  }
  // What a deploy leaves behind: their figures were written by the previous engine.
  for (const o of [org.OLD_A, org.OLD_B, org.LEAVING]) {
    const runs = await orgCollection(fs(), o, 'calculation_runs').get();
    for (const r of runs.docs) await r.ref.update({ engine_version: '1.0.0' });
  }
  await fs().collection('organizations').doc(org.LEAVING).update({
    status: 'pending_deletion', deletion_requested_at: nowIso(),
  });
  // Anything the fixture runs left queued (their alert passes) is not what this suite measures.
  for (const o of Object.values(org)) await dropQueued(o);
}, 600_000);

afterAll(async () => {
  const ids = Object.values(org).filter(Boolean);
  for (const o of ids) {
    await dropQueued(o);
    const rest = await fs().collection('jobs').where('organization_id', '==', o).get();
    for (const d of rest.docs) await d.ref.delete();
  }
  await removeSeeded(ids, DOMAIN);
});

describe('the engine-upgrade recalculation (ADR-120)', () => {
  it('queues every organisation still on an older engine, and no other', async () => {
    const count = await enqueueEngineUpgrade(ENGINE_VERSION);
    expect(count).toBeGreaterThanOrEqual(2); // other suites' organisations may also be behind
    expect(await queued(org.OLD_A)).toHaveLength(1);
    expect(await queued(org.OLD_B)).toHaveLength(1);
    expect(await queued(org.CURRENT)).toEqual([]);
    expect(await queued(org.NEVER)).toEqual([]);
    expect(await queued(org.LEAVING)).toEqual([]);
  });

  it('is idempotent: calling again queues nothing twice', async () => {
    const before = await queued(org.OLD_A);
    await enqueueEngineUpgrade(ENGINE_VERSION);
    expect(await queued(org.OLD_A)).toEqual(before);
  });

  it('audits each enqueue with its reason and version', async () => {
    const audited = await fs().collection('audit_events').where('organization_id', '==', org.OLD_A)
      .where('action', '==', 'job.enqueued').get();
    const matching = audited.docs.filter((d) => {
      const after = (d.get('after') ?? {}) as Record<string, unknown>;
      return after.reason === 'engine_upgrade' && after.engine_version === ENGINE_VERSION;
    });
    // Once: the second sweep merged into the waiting job and audited nothing.
    expect(matching).toHaveLength(1);
  });

  it('one organisation\'s failure neither stops the others nor goes unseen, and it is queued again', async () => {
    // The emulators are shared: another suite's worker may have drained the two queued jobs since the
    // first test. Put both organisations back on the old engine and queue them afresh.
    for (const o of [org.OLD_A, org.OLD_B]) {
      await dropQueued(o);
      for (const r of (await orgCollection(fs(), o, 'calculation_runs').get()).docs) await r.ref.update({ engine_version: '1.0.0' });
    }
    await enqueueEngineUpgrade(ENGINE_VERSION);
    // Make OLD_B's run fail (an impossible as-of date) and give it one attempt.
    const failing = (await queued(org.OLD_B))[0]!;
    const job = fs().collection('jobs').doc(failing);
    await job.update({ payload: { ...((await job.get()).get('payload') as object), as_of: 'not-a-date' }, max_attempts: 1 });
    const good = (await queued(org.OLD_A))[0]!;

    expect(await drainUntilFinished(drainJobs, good)).toBe('succeeded');
    expect(['failed', 'dead']).toContain(await drainUntilFinished(drainJobs, failing));

    // OLD_A now has a run on this engine, and recomputed its history on it.
    const runs = (await orgCollection(fs(), org.OLD_A, 'calculation_runs').where('status', '==', 'succeeded').get())
      .docs.map((d) => d.data()).sort((a, b) => String(b.finished_at).localeCompare(String(a.finished_at)));
    expect(runs[0]?.engine_version).toBe(ENGINE_VERSION);

    // The failure is visible, and the next sweep queues OLD_B again — and only OLD_B of the two.
    await dropQueued(org.OLD_A); // its alert pass
    await enqueueEngineUpgrade(ENGINE_VERSION);
    expect(await queued(org.OLD_B)).toHaveLength(1);
    expect((await fs().collection('jobs').where('organization_id', '==', org.OLD_A)
      .where('job_type', '==', 'calculation.run').where('status', '==', 'queued').get()).size).toBe(0);
  }, 600_000); // two real recalculations run inside this test

  it('is callable only by the server', async () => {
    const outsider = await createAuthUser(`x@${DOMAIN}`);
    const { error } = await rpc(clientFor(outsider), 'enqueue_engine_upgrade', { p_engine_version: ENGINE_VERSION }, { server: true });
    expect(error).not.toBeNull();
  });

  it('refuses something that is not a version', async () => {
    await expect(enqueueEngineUpgrade('latest')).rejects.toThrow();
  });
});
