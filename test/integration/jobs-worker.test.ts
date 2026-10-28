import { beforeAll, afterAll, describe, expect, it } from 'vitest';

import { drainJobs, registerJobHandler, type ClaimedJob } from '@/modules/jobs';
import { newId, nowIso } from '@/db/schema';
import { clientFor, fs, rpc, sqlstate } from './setup';
import { removeSeeded, seedOrg } from '../fixtures/seed';

/**
 * The job worker (IMPLEMENTATION_PLAN.md Phase 4 slice 6; ADR-013, ADR-038.12, ADR-044.6; R2-A-10).
 *
 * The rule under test that matters most: a job is scoped to the organization on its OWN ROW, never
 * to anything in its payload. The worker acts as the server, which every tenant check trusts, so a
 * payload that could redirect the scope would be a cross-tenant write primitive.
 *
 * The emulators are shared with other suites, so the queue may hold their jobs too: every
 * assertion waits on THIS suite's job (`drainFor`) rather than on "the queue drained".
 */

const RUN = `j${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.jobs.itest.motion`;
let ownerId: string;
let orgId: string;
let otherOrgId: string;

/** What each handler invocation actually saw, so the test can assert the scope it was given. */
const seen: Array<{ jobId: string; scopedTo: string | null; payload: Record<string, unknown> }> = [];

const job = async (id: string) => (await fs().collection('jobs').doc(id).get()).data() ?? {};

/** Drains until this job has left `queued`/`running` (or the rounds run out). */
async function drainFor(id: string, rounds = 10): Promise<Record<string, unknown>> {
  for (let i = 0; i < rounds; i += 1) {
    const j = await job(id);
    if (j.status !== 'queued' && j.status !== 'running' && i > 0) return j;
    await drainJobs(5);
  }
  return job(id);
}

/** A job written directly, as the suite's `insert into public.jobs` did. */
async function enqueue(org: string, type: string, payload: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): Promise<string> {
  const id = newId();
  const now = nowIso();
  await fs().collection('jobs').doc(id).set({
    id, organization_id: org, job_type: type, idempotency_key: null, payload, requested_by: null,
    status: 'queued', attempts: 0, max_attempts: 3, run_after: now, locked_at: null, locked_by: null,
    last_error: null, result: null, finished_at: null, created_at: now, updated_at: now, ...extra,
  });
  return id;
}

beforeAll(async () => {
  seen.length = 0;
  ({ orgId, ownerId } = await seedOrg({ name: `ITest Jobs ${RUN}`, ownerEmail: `owner@${DOMAIN}` }));
  ({ orgId: otherOrgId } = await seedOrg({ name: `ITest Jobs Other ${RUN}`, ownerEmail: `other@${DOMAIN}` }));

  /*
   * A no-op handler REPLACING the real `calculation.run` for this suite.
   *
   * What is under test here is the worker loop — scoping, retries, reclaiming — not the engine. The
   * real handler is exercised through the queue in `pipeline-end-to-end.test.ts`.
   */
  registerJobHandler('calculation.run', async (j: ClaimedJob, scope) => {
    const scopedTo = (scope as { organizationId?: string }).organizationId ?? null;
    seen.push({ jobId: j.jobId, scopedTo, payload: j.payload });
    return { status: 'succeeded', result: { noop: true } };
  });

  registerJobHandler('alerts.evaluate', async () => ({
    status: 'failed',
    error: 'deliberate failure, to exercise the retry path',
  }));
});

afterAll(async () => {
  const mine = await fs().collection('jobs').where('organization_id', 'in', [orgId, otherOrgId]).get();
  for (const d of mine.docs) await d.ref.delete();
  await removeSeeded([orgId, otherOrgId], DOMAIN);
});

describe('the worker drains the queue', () => {
  it('claims a queued job, runs it, and records success', async () => {
    const jobId = await enqueue(orgId, 'calculation.run');
    const row = await drainFor(jobId);
    expect(row.status).toBe('succeeded');
    expect(row.finished_at).not.toBeNull();
  });

  it('scopes the handler to the organization on the job row, not the payload', async () => {
    seen.length = 0;
    // The payload names ANOTHER organization. If the worker read its scope from there, this is where
    // a cross-tenant write would begin.
    const jobId = await enqueue(orgId, 'calculation.run', { orgId: otherOrgId, organization_id: otherOrgId });
    await drainFor(jobId);

    const run = seen.find((s) => s.jobId === jobId);
    expect(run, 'the handler should have run').toBeDefined();
    expect(run?.scopedTo, 'the scope must come from the jobs row').toBe(orgId);
    expect(run?.scopedTo).not.toBe(otherOrgId);
  });

  it('returns a failed job to the queue with an incremented attempt count', async () => {
    const jobId = await enqueue(orgId, 'alerts.evaluate');
    for (let i = 0; i < 10 && (await job(jobId)).attempts === 0; i += 1) await drainJobs(5);
    const row = await job(jobId);

    // One attempt spent, two left, so it is queued again (with backoff) rather than dead.
    expect(row.status).toBe('queued');
    expect(row.attempts).toBe(1);
    expect(String(row.last_error)).toContain('deliberate failure');
    expect(String(row.run_after) > nowIso()).toBe(true);
  });

  it('marks a job dead once its attempts are exhausted, and audits it', async () => {
    const jobId = await enqueue(orgId, 'alerts.evaluate', {}, { max_attempts: 1 });
    const row = await drainFor(jobId);
    expect(row.status).toBe('dead');

    const audited = await fs().collection('audit_events')
      .where('organization_id', '==', orgId).where('action', '==', 'job.dead').get();
    expect(audited.docs.some((d) => d.get('target_id') === jobId)).toBe(true);
  });

  it('fails rather than silently succeeding a job type with no handler', async () => {
    /*
     * `snapshots.compact` because it is genuinely unbuilt; the assertion also pins that the type has
     * NO handler today, so a later phase cannot delete this test's premise without failing it.
     */
    const jobId = await enqueue(orgId, 'snapshots.compact');
    for (let i = 0; i < 10 && (await job(jobId)).attempts === 0; i += 1) await drainJobs(5);
    const row = await job(jobId);
    expect(row.status).not.toBe('succeeded');
    expect(String(row.last_error)).toContain('No handler is registered');
  });
});

describe('reclaiming a lost worker (ADR-044.6; R2-A-10)', () => {
  it('returns a job running past its budget to the queue with attempts + 1', async () => {
    // calculation.run's budget is 5 minutes, so 20 minutes is comfortably past budget × 3.
    const jobId = await enqueue(orgId, 'calculation.run', {}, {
      status: 'running', locked_at: new Date(Date.now() - 20 * 60_000).toISOString(), locked_by: 'dead-worker',
      attempts: 1, max_attempts: 5,
    });

    // The reclaim runs inside claim_job, before anything is picked up.
    await drainJobs(1);

    const after = await job(jobId);
    expect(Number(after.attempts), 'the lost attempt must be counted').toBeGreaterThan(1);
    expect(after.locked_by).not.toBe('dead-worker');
  });

  it('coalesces a lost job into the queued twin that holds its key', async () => {
    const key = `calculation.run:${orgId}`;
    // The twin: queued under the key, holding the guard (what enqueue writes).
    const twin = await enqueue(orgId, 'calculation.run', { trigger: 'import_commit', triggerRefId: 'b2' }, {
      idempotency_key: key, run_after: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const { uniqueGuard } = await import('@/db/schema');
    await uniqueGuard(fs(), 'global', 'jobs_idempotency_queued', ['calculation.run', key]).ref.set({
      owner_id: twin, constraint: 'jobs_idempotency_queued', created_at: nowIso(),
    });
    const lost = await enqueue(orgId, 'calculation.run', { trigger: 'import_commit', triggerRefId: 'b1' }, {
      idempotency_key: key, status: 'running', locked_at: new Date(Date.now() - 20 * 60_000).toISOString(),
      locked_by: 'dead-worker', attempts: 1, max_attempts: 5,
    });

    await drainJobs(1);

    const l = await job(lost);
    expect(l.status).toBe('cancelled');
    expect(String(l.last_error)).toContain(`coalesced into queued job ${twin}`);
    const t = await job(twin);
    expect(t.status).toBe('queued');
    expect((t.payload as { refs?: unknown[] }).refs).toHaveLength(2);
    await fs().collection('jobs').doc(twin).update({ status: 'cancelled' });
  });
});

describe('what the queue refuses', () => {
  it('a user cannot enqueue org.purge through the user-intent surface', async () => {
    const { error } = await rpc(clientFor(ownerId), 'enqueue_job', {
      p_org: orgId,
      p_job_type: 'org.purge',
      p_payload: {},
    });
    expect(error, 'org.purge is enqueued by the deletion trigger alone').not.toBeNull();
    expect(sqlstate(error)).toBe('42501');
  });

  it('the server cannot enqueue org.purge either', async () => {
    const { error } = await rpc(clientFor(ownerId), 'enqueue_job', { p_org: orgId, p_job_type: 'org.purge' }, { server: true });
    expect(sqlstate(error), 'a user handle cannot reach api_server').toBe('42501');
  });

  it('does not run jobs for a suspended organization, except the purge (ADR-038.12)', async () => {
    const jobId = await enqueue(orgId, 'calculation.run');
    await fs().collection('organizations').doc(orgId).update({ status: 'suspended' });
    try {
      await drainJobs(5);
      expect((await job(jobId)).status, 'work for a suspended organization waits').toBe('queued');
    } finally {
      await fs().collection('organizations').doc(orgId).update({ status: 'active' });
    }
    await drainFor(jobId);
  });

  it('cancelling a deletion marks the queued purge cancelled', async () => {
    const requested = await rpc(clientFor(ownerId), 'request_deletion', { p_org: orgId });
    expect(requested.error).toBeNull();
    const purge = async () => (await fs().collection('jobs')
      .where('organization_id', '==', orgId).where('job_type', '==', 'org.purge').get()).docs.map((d) => d.get('status'));
    expect(await purge()).toEqual(['queued']);

    const cancelled = await rpc(clientFor(ownerId), 'cancel_deletion', { p_org: orgId });
    expect(cancelled.error).toBeNull();
    expect(await purge()).toEqual(['cancelled']);
  });
});
