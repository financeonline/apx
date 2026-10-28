import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { drainJobs } from '@/modules/jobs';
import type { DocumentData } from 'firebase-admin/firestore';
import { periodId } from '@/db/app/shared';
import { globalCollection, globalRow, orgCollection, orgRow } from '@/db/schema';
import { deleteOrg, drainUntilFinished, fs } from './setup';
import { seedBatch, seedDocument, seedLedgerEntry, seedOrg } from '../fixtures/seed';
import { deleteJobsOf, latestJob, seedJob } from '../fixtures/engine-helpers';

/**
 * The whole chain, driven by the QUEUE (ADR-013, ADR-057.1).
 *
 * Every other suite exercises a layer directly: the run loop with stubbed dependencies, the health
 * engine over fixtures, the alert planner over a context built by hand. Each of those passed while
 * the system as a whole did nothing, because no handler was ever registered and every job the cron
 * claimed failed with "No handler is registered".
 *
 * This suite is the one that would have caught that. It enqueues a `calculation.run` the way the
 * product does and asserts, through the queue and nothing else:
 *
 *   - figures are written and pointed at by `metric_current`;
 *   - the period is marked complete;
 *   - a health score exists for it;
 *   - an `alerts.evaluate` job is queued, and running it evaluates alerts.
 *
 * Run-unique fixtures (ADR-052.12), so a concurrent suite cannot delete them mid-test.
 */

const RUN = `p${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.pipeline.itest.motion`;

let orgId: string;
let mayPeriodId: string;
let chart: Readonly<Record<string, string>>;

const accountId = (category: string): string => chart[category]!;

function enqueue(type: string, payload: Record<string, unknown> = {}): Promise<string> {
  return seedJob(orgId, type, payload, { maxAttempts: 3 });
}

const job = async (id: string): Promise<DocumentData> => (await globalRow(fs(), 'jobs', id).get()).data()!;

/** The current snapshot value of a headline cell, as the SQL `value::text` printed it. */
async function currentValue(metricKey: string): Promise<string | null> {
  const pointers = await orgCollection(fs(), orgId, 'metric_current')
    .where('period_id', '==', mayPeriodId).where('metric_key', '==', metricKey).get();
  const pointer = pointers.docs.find((d) => d.get('dimension_type') === 'none');
  if (!pointer) return null;
  const snap = await orgRow(fs(), orgId, 'metric_snapshots', String(pointer.get('snapshot_id'))).get();
  return (snap.get('value') as string | null | undefined) ?? null;
}

/** The newest calculation run (`order by started_at desc limit 1`). */
async function latestRun(): Promise<DocumentData> {
  const runs = (await orgCollection(fs(), orgId, 'calculation_runs').get()).docs.map((d) => d.data());
  return runs.sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)))[0]!;
}

const snapshotCount = async (): Promise<number> =>
  (await orgCollection(fs(), orgId, 'metric_snapshots').count().get()).data().count;

beforeAll(async () => {
  const seeded = await seedOrg({ name: `ITest Pipeline ${RUN}`, ownerEmail: `owner@${DOMAIN}` });
  orgId = seeded.orgId;
  chart = seeded.accounts;
  mayPeriodId = periodId(orgId, '2026-05-01');

  const post = (category: string, direction: 'debit' | 'credit', amount: string, day: string) =>
    seedLedgerEntry(orgId, { date: `2026-05-${day}`, accountId: accountId(category), direction, amount });

  await post('revenue', 'credit', '20000.00', '10');
  await post('cost_of_sales', 'debit', '6000.00', '12');
  await post('payroll', 'debit', '5000.00', '25');
  await post('marketing', 'debit', '1000.00', '20');

  // A committed general-ledger batch declaring the whole month, so the period is covered (§2.2)
  // and can therefore be marked complete and scored.
  const doc = await seedDocument(orgId, 'gl.csv', 'general_ledger');
  await seedBatch(orgId, {
    importType: 'general_ledger', target: 'ledger_entries', start: '2026-05-01', end: '2026-05-31', documentId: doc,
  });
});

afterAll(async () => {
  if (!orgId) return;
  await deleteJobsOf(orgId);
  await deleteOrg(orgId);
});

describe('a queued calculation actually runs (ADR-057.1)', () => {
  it('succeeds rather than failing for want of a handler', async () => {
    const jobId = await enqueue('calculation.run', { trigger: 'recalc_manual', as_of: '2026-06-15' });

    // Waited on by its own row: `drainJobs(n)` shares a queue with every other suite, so a fixed
    // count can spend its claims on somebody else's work and leave this one queued.
    expect(await drainUntilFinished(drainJobs, jobId)).toBe('succeeded');

    const j = await job(jobId);
    const row = `${String(j.status)}|${String(j.last_error ?? '-')}`;
    expect(row, 'the calculation must not fail for want of a handler').not.toContain('No handler');
    expect(row).toContain('succeeded');
  });

  it('wrote figures, and pointed metric_current at them', async () => {
    expect(await currentValue('revenue')).toBe('20000.000000');
    expect(await currentValue('gross_profit')).toBe('14000.000000');
  });

  it('marked the covered period complete (ADR-030.1)', async () => {
    expect((await orgRow(fs(), orgId, 'fiscal_periods', mayPeriodId).get()).get('is_complete')).toBe(true);
  });

  it('wrote a health score for it, pointed at by health_current (§7)', async () => {
    const pointer = (await orgRow(fs(), orgId, 'health_current', mayPeriodId).get()).data()!;
    const h = (await orgRow(fs(), orgId, 'health_scores', String(pointer.health_score_id)).get()).data()!;
    const score = `${h.score === null ? 'NULL' : String(h.score)}|${String(h.dimensions_total)}|${String(h.config_version)}`;
    // The run stamps the CURRENT config (health.config.v5 since ADR-147: eight dimensions).
    expect(score).toContain('|8|health.config.v5');

    // The breakdown is what the explainability panel reads; an empty one would render nothing.
    expect((h.breakdown as unknown[]).length).toBe(8);
  });

  it('queued the alert pass, rather than running it inside the calculation (§8.1)', async () => {
    expect(await latestJob(orgId, 'alerts.evaluate')).not.toBeNull();
  });
});

describe('the alert pass runs from the queue too', () => {
  it('evaluates without failing', async () => {
    const pass = await latestJob(orgId, 'alerts.evaluate');
    await drainUntilFinished(drainJobs, String(pass?.id));

    const j = await job(String(pass?.id));
    const row = `${String(j.status)}|${String(j.last_error ?? '-')}`;
    expect(row, 'the alert pass must not fail for want of a handler').not.toContain('No handler');
    expect(row).toContain('succeeded');
  });

  it('records what it did, in the audit trail (§8.3)', async () => {
    const audited = await globalCollection(fs(), 'audit_events').where('organization_id', '==', orgId)
      .where('action', '==', 'alerts.evaluated').count().get();
    expect(audited.data().count).toBeGreaterThan(0);
  });

  it('leaves every alert it did write complete enough to render', async () => {
    // Whether this organisation's one quiet month trips a rule is not the point; if any alert was
    // written, it must have the three things the card needs and a bundle behind it.
    const alerts = (await orgCollection(fs(), orgId, 'alerts').get()).docs.map((d) => d.data());
    const broken = alerts.filter((a) => a.title == null || a.explanation == null || a.current_revision_id == null);
    expect(broken).toHaveLength(0);
  });
});

describe('re-running changes nothing (§2.4 idempotence, ADR-047.8)', () => {
  it('a scheduled run refreshes only the as-of-dependent keys, then stops changing anything', async () => {
    /*
     * The FIRST scheduled run after a manual one is not a no-op, and should not be: it covers a
     * different range — only the current period's aging and runway keys (ADR-047.8) — so its
     * fingerprint is legitimately different from the full run's.
     *
     * The SECOND scheduled run is the one that must do nothing, and it is what the fingerprint gate
     * exists for: a nightly job over unchanged data must not rewrite a year of identical snapshots.
     */
    await drainUntilFinished(drainJobs, await enqueue('calculation.run', { trigger: 'scheduled', as_of: '2026-06-15' }));

    const before = await snapshotCount();

    await drainUntilFinished(drainJobs, await enqueue('calculation.run', { trigger: 'scheduled', as_of: '2026-06-15' }));

    const after = await snapshotCount();
    expect(after, 'an unchanged fingerprint must finish the run without rewriting').toBe(before);

    const stats = (await latestRun()).stats as Record<string, unknown> | null;
    expect(String(stats?.no_change ?? false)).toBe('true');
  });

  it('but a manual recalculation is honoured even when nothing changed', async () => {
    /*
     * Deliberate, and worth a test of its own so nobody "fixes" it: `recalc_manual` is exempt from
     * the fingerprint gate. Somebody who presses Recalculate because they distrust a figure is
     * entitled to a real run, not a silent no-op that leaves them pressing it again.
     */
    await drainUntilFinished(drainJobs, await enqueue('calculation.run', { trigger: 'recalc_manual', as_of: '2026-06-15' }));

    const run = await latestRun();
    const latest = `${String(run.trigger)}|${String((run.stats as Record<string, unknown> | null)?.no_change ?? false)}`;
    expect(latest).toBe('recalc_manual|false');
  });
});
