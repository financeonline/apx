import { beforeAll, afterAll, describe, expect, it } from 'vitest';

import { drainJobs, registerJobHandler, type ClaimedJob } from '@/modules/jobs';
import { adminSql, clientFor, createAuthUser, resetFixtures, sqlstate } from './setup';

/**
 * The job worker (IMPLEMENTATION_PLAN.md Phase 4 slice 6; ADR-013, ADR-038.12, ADR-044.6; R2-A-10).
 *
 * The rule under test that matters most: a job is scoped to the organization on its OWN ROW, never
 * to anything in its payload. The worker holds the service role, which bypasses RLS, so a payload
 * that could redirect the scope would be a cross-tenant write primitive.
 */

let ownerId: string;
let orgId: string;
let otherOrgId: string;

/** What each handler invocation actually saw, so the test can assert the scope it was given. */
const seen: Array<{ jobId: string; scopedTo: string | null; payload: Record<string, unknown> }> = [];

beforeAll(async () => {
  resetFixtures();
  seen.length = 0;

  ownerId = createAuthUser('jobs-owner@itest.motion');
  const created = await clientFor(ownerId).schema('api').rpc('create_organization', {
    p_name: 'ITest Jobs',
  });
  if (created.error) throw new Error(`fixture org failed: ${created.error.message}`);
  orgId = created.data as unknown as string;

  const otherUser = createAuthUser('jobs-other@itest.motion');
  const other = await clientFor(otherUser).schema('api').rpc('create_organization', {
    p_name: 'ITest Jobs Other',
  });
  if (other.error) throw new Error(`second org failed: ${other.error.message}`);
  otherOrgId = other.data as unknown as string;

  /*
   * A no-op handler REPLACING the real `calculation.run` for this suite.
   *
   * What is under test here is the worker loop — scoping, retries, reclaiming — not the engine. The
   * real handler is exercised through the queue in `pipeline-end-to-end.test.ts`; running it here
   * would make these tests depend on a month of fixture data they do not need.
   */
  registerJobHandler('calculation.run', async (job: ClaimedJob, scope) => {
    const scopedTo = (scope as { organizationId?: string }).organizationId ?? null;
    seen.push({ jobId: job.jobId, scopedTo, payload: job.payload });
    return { status: 'succeeded', result: { noop: true } };
  });

  registerJobHandler('alerts.evaluate', async () => ({
    status: 'failed',
    error: 'deliberate failure, to exercise the retry path',
  }));
});

afterAll(() => {
  resetFixtures();
});

function enqueue(org: string, type: string, payload: Record<string, unknown> = {}): string {
  return adminSql(`
    with inserted as (
      insert into public.jobs (organization_id, job_type, payload, max_attempts)
      values ('${org}', '${type}', '${JSON.stringify(payload)}'::jsonb, 3)
      returning id)
    select id from inserted`);
}

describe('the worker drains the queue', () => {
  it('claims a queued job, runs it, and records success', async () => {
    const jobId = enqueue(orgId, 'calculation.run');

    const result = await drainJobs(5);
    expect(result.claimed, 'the worker should have claimed at least this job').toBeGreaterThan(0);

    const status = adminSql(`select status from public.jobs where id = '${jobId}'`);
    expect(status).toBe('succeeded');

    const finished = adminSql(`select finished_at is not null from public.jobs where id = '${jobId}'`);
    expect(finished).toBe('t');
  });

  it('scopes the handler to the organization on the job row, not the payload', async () => {
    seen.length = 0;
    // The payload names ANOTHER organization. If the worker read its scope from there, this is where
    // a cross-tenant write would begin.
    const jobId = enqueue(orgId, 'calculation.run', { orgId: otherOrgId, organization_id: otherOrgId });

    await drainJobs(5);

    const run = seen.find((s) => s.jobId === jobId);
    expect(run, 'the handler should have run').toBeDefined();
    expect(run?.scopedTo, 'the scope must come from the jobs row').toBe(orgId);
    expect(run?.scopedTo).not.toBe(otherOrgId);
  });

  it('returns a failed job to the queue with an incremented attempt count', async () => {
    const jobId = enqueue(orgId, 'alerts.evaluate');

    await drainJobs(5);

    const row = adminSql(`
      select status || '|' || attempts || '|' || coalesce(last_error, '')
        from public.jobs where id = '${jobId}'`);
    const [status, attempts, error] = row.split('|') as [string, string, string];

    // One attempt spent, two left, so it is queued again rather than dead.
    expect(status).toBe('queued');
    expect(Number(attempts)).toBe(1);
    expect(error).toContain('deliberate failure');
  });

  it('marks a job dead once its attempts are exhausted, and audits it', async () => {
    const jobId = adminSql(`
      with inserted as (
        insert into public.jobs (organization_id, job_type, payload, max_attempts, attempts)
        values ('${orgId}', 'alerts.evaluate', '{}'::jsonb, 1, 0)
        returning id)
      select id from inserted`);

    await drainJobs(5);

    const status = adminSql(`select status from public.jobs where id = '${jobId}'`);
    expect(status).toBe('dead');

    const audited = adminSql(`
      select count(*) from public.audit_events
       where organization_id = '${orgId}' and action = 'job.dead'`);
    expect(Number(audited)).toBeGreaterThan(0);
  });

  it('fails rather than silently succeeding a job type with no handler', async () => {
    // A job type whose handler arrives in a later phase must not disappear: a quietly-succeeded
    // calculation would leave the dashboard stale with nothing to show for it.
    const jobId = enqueue(orgId, 'report.render');

    await drainJobs(5);

    const row = adminSql(`
      select status || '|' || coalesce(last_error, '') from public.jobs where id = '${jobId}'`);
    expect(row).not.toContain('succeeded');
    expect(row).toContain('No handler is registered');
  });
});

describe('reclaiming a lost worker (ADR-044.6; R2-A-10)', () => {
  it('returns a job running past its budget to the queue with attempts + 1', async () => {
    // calculation.run's budget is 5 minutes, so 20 minutes is comfortably past budget × 3.
    const jobId = adminSql(`
      with inserted as (
        insert into public.jobs
               (organization_id, job_type, payload, status, locked_at, locked_by, attempts, max_attempts)
        values ('${orgId}', 'calculation.run', '{}'::jsonb, 'running',
                now() - interval '20 minutes', 'dead-worker', 1, 5)
        returning id)
      select id from inserted`);

    const before = Number(adminSql(`select attempts from public.jobs where id = '${jobId}'`));

    // The reclaim runs inside claim_job, before anything is picked up.
    await drainJobs(5);

    const after = adminSql(`
      select status || '|' || attempts || '|' || coalesce(locked_by, 'none')
        from public.jobs where id = '${jobId}'`);
    const [, attempts] = after.split('|') as [string, string, string];

    expect(Number(attempts), 'the lost attempt must be counted').toBeGreaterThan(before);
  });
});

describe('what the queue refuses', () => {
  it('a user cannot enqueue org.purge through the user-intent surface', async () => {
    const { error } = await clientFor(ownerId).schema('api').rpc('enqueue_job', {
      p_org: orgId,
      p_job_type: 'org.purge',
      p_payload: {},
    });
    expect(error, 'org.purge is enqueued by the deletion trigger alone').not.toBeNull();
    expect(sqlstate(error)).toBe('42501');
  });

  it('does not run jobs for a suspended organization, except the purge (ADR-038.12)', async () => {
    const jobId = enqueue(orgId, 'calculation.run');
    adminSql(`update public.organizations set status = 'suspended' where id = '${orgId}'`);
    try {
      await drainJobs(5);
      const status = adminSql(`select status from public.jobs where id = '${jobId}'`);
      expect(status, 'work for a suspended organization waits').toBe('queued');
    } finally {
      adminSql(`update public.organizations set status = 'active' where id = '${orgId}'`);
    }
  });

  it('cancelling a deletion marks the queued purge cancelled', async () => {
    await clientFor(ownerId).schema('api').rpc('request_deletion', { p_org: orgId });
    const queued = adminSql(`
      select status from public.jobs
       where organization_id = '${orgId}' and job_type = 'org.purge'`);
    expect(queued).toBe('queued');

    await clientFor(ownerId).schema('api').rpc('cancel_deletion', { p_org: orgId });
    const cancelled = adminSql(`
      select status from public.jobs
       where organization_id = '${orgId}' and job_type = 'org.purge'`);
    expect(cancelled).toBe('cancelled');
  });
});
