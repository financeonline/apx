import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { drainJobs } from '@/modules/jobs';
import { adminSql, clientFor, createAuthUser } from './setup';

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
const DOMAIN = `${RUN}.pipeline.itest`;

let ownerId: string;
let orgId: string;
let mayPeriodId: string;

const one = (sql: string): string => adminSql(`with q as (${sql}) select * from q`);

function accountId(category: string): string {
  return one(`
    select id from public.accounts
     where organization_id = '${orgId}' and standard_category = '${category}' and is_system`);
}

function enqueue(type: string, payload: Record<string, unknown> = {}): string {
  return one(`
    insert into public.jobs (organization_id, job_type, payload, max_attempts)
    values ('${orgId}', '${type}', '${JSON.stringify(payload)}'::jsonb, 3)
    returning id`);
}

beforeAll(async () => {
  ownerId = createAuthUser(`owner@${DOMAIN}`);
  const created = await clientFor(ownerId).schema('api').rpc('create_organization', {
    p_name: `ITest Pipeline ${RUN}`,
  });
  if (created.error) throw new Error(`fixture org failed: ${created.error.message}`);
  orgId = created.data as unknown as string;

  mayPeriodId = one(`
    select id from public.fiscal_periods
     where organization_id = '${orgId}' and period_start = '2026-05-01'`);

  const post = (category: string, direction: string, amount: string, day: string) => adminSql(`
    insert into public.ledger_entries
           (organization_id, entry_date, account_id, direction, amount, period_id, record_status)
    values ('${orgId}', '2026-05-${day}', '${accountId(category)}', '${direction}', ${amount},
            '00000000-0000-0000-0000-000000000000', 'accepted')`);

  post('revenue', 'credit', '20000.00', '10');
  post('cost_of_sales', 'debit', '6000.00', '12');
  post('payroll', 'debit', '5000.00', '25');
  post('marketing', 'debit', '1000.00', '20');

  // A committed general-ledger batch declaring the whole month, so the period is covered (§2.2)
  // and can therefore be marked complete and scored.
  const doc = one(`
    insert into public.source_documents
           (organization_id, storage_path, original_filename, mime_type, byte_size, sha256,
            status, document_kind)
    values ('${orgId}', '${orgId}/pipeline/gl.csv', 'gl.csv', 'text/csv', 10, decode('e5','hex'),
            'ready', 'general_ledger')
    returning id`);
  adminSql(`
    insert into public.import_batches
           (organization_id, source_document_id, import_type, target_table, status,
            extraction_method, period_start, period_end, committed_at)
    values ('${orgId}', '${doc}', 'general_ledger', 'ledger_entries', 'committed',
            'csv', '2026-05-01', '2026-05-31', now())`);
});

afterAll(() => {
  adminSql(`
    delete from public.organizations where name like 'ITest Pipeline%${RUN}';
    delete from auth.users where email like '%@${DOMAIN}';
    delete from public.organizations where name like 'ITest Pipeline %' and created_at < now() - interval '1 hour';
    delete from auth.users where email like '%.pipeline.itest' and created_at < now() - interval '1 hour';`);
});

describe('a queued calculation actually runs (ADR-057.1)', () => {
  it('succeeds rather than failing for want of a handler', async () => {
    const jobId = enqueue('calculation.run', { trigger: 'recalc_manual', as_of: '2026-06-15' });

    const result = await drainJobs(5);
    expect(result.claimed).toBeGreaterThan(0);

    const row = one(`
      select status || '|' || coalesce(last_error, '-') from public.jobs where id = '${jobId}'`);
    expect(row, 'the calculation must not fail for want of a handler').not.toContain('No handler');
    expect(row).toContain('succeeded');
  });

  it('wrote figures, and pointed metric_current at them', () => {
    const revenue = one(`
      select s.value::text
        from public.metric_current c
        join public.metric_snapshots s
          on s.organization_id = c.organization_id and s.id = c.snapshot_id
       where c.organization_id = '${orgId}' and c.metric_key = 'revenue'
         and c.period_id = '${mayPeriodId}'`);
    expect(revenue).toBe('20000.000000');

    const grossProfit = one(`
      select s.value::text
        from public.metric_current c
        join public.metric_snapshots s
          on s.organization_id = c.organization_id and s.id = c.snapshot_id
       where c.organization_id = '${orgId}' and c.metric_key = 'gross_profit'
         and c.period_id = '${mayPeriodId}'`);
    expect(grossProfit).toBe('14000.000000');
  });

  it('marked the covered period complete (ADR-030.1)', () => {
    expect(one(`
      select is_complete::text from public.fiscal_periods where id = '${mayPeriodId}'`)).toBe('true');
  });

  it('wrote a health score for it, pointed at by health_current (§7)', () => {
    const score = one(`
      select coalesce(h.score::text, 'NULL') || '|' || h.dimensions_total::text || '|' || h.config_version
        from public.health_current c
        join public.health_scores h
          on h.organization_id = c.organization_id and h.id = c.health_score_id
       where c.organization_id = '${orgId}' and c.period_id = '${mayPeriodId}'`);
    expect(score).toContain('|6|health.config.v1');

    // The breakdown is what the explainability panel reads; an empty one would render nothing.
    const dimensions = one(`
      select jsonb_array_length(h.breakdown)::text
        from public.health_current c
        join public.health_scores h
          on h.organization_id = c.organization_id and h.id = c.health_score_id
       where c.organization_id = '${orgId}' and c.period_id = '${mayPeriodId}'`);
    expect(dimensions).toBe('6');
  });

  it('queued the alert pass, rather than running it inside the calculation (§8.1)', () => {
    const queued = one(`
      select count(*)::text from public.jobs
       where organization_id = '${orgId}' and job_type = 'alerts.evaluate'`);
    expect(Number(queued)).toBeGreaterThan(0);
  });
});

describe('the alert pass runs from the queue too', () => {
  it('evaluates without failing', async () => {
    await drainJobs(5);

    const row = one(`
      select status || '|' || coalesce(last_error, '-')
        from public.jobs
       where organization_id = '${orgId}' and job_type = 'alerts.evaluate'
       order by created_at desc limit 1`);
    expect(row, 'the alert pass must not fail for want of a handler').not.toContain('No handler');
    expect(row).toContain('succeeded');
  });

  it('records what it did, in the audit trail (§8.3)', () => {
    const audited = one(`
      select count(*)::text from public.audit_events
       where organization_id = '${orgId}' and action = 'alerts.evaluated'`);
    expect(Number(audited)).toBeGreaterThan(0);
  });

  it('leaves every alert it did write complete enough to render', () => {
    // Whether this organisation's one quiet month trips a rule is not the point; if any alert was
    // written, it must have the three things the card needs and a bundle behind it.
    const broken = one(`
      select count(*)::text from public.alerts a
       where a.organization_id = '${orgId}'
         and (a.title is null or a.explanation is null or a.current_revision_id is null)`);
    expect(broken).toBe('0');
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
    enqueue('calculation.run', { trigger: 'scheduled', as_of: '2026-06-15' });
    await drainJobs(5);

    const before = one(`
      select count(*)::text from public.metric_snapshots where organization_id = '${orgId}'`);

    enqueue('calculation.run', { trigger: 'scheduled', as_of: '2026-06-15' });
    await drainJobs(5);

    const after = one(`
      select count(*)::text from public.metric_snapshots where organization_id = '${orgId}'`);
    expect(after, 'an unchanged fingerprint must finish the run without rewriting').toBe(before);

    const noChange = one(`
      select coalesce((stats->>'no_change')::text, 'false') from public.calculation_runs
       where organization_id = '${orgId}' order by started_at desc limit 1`);
    expect(noChange).toBe('true');
  });

  it('but a manual recalculation is honoured even when nothing changed', async () => {
    /*
     * Deliberate, and worth a test of its own so nobody "fixes" it: `recalc_manual` is exempt from
     * the fingerprint gate. Somebody who presses Recalculate because they distrust a figure is
     * entitled to a real run, not a silent no-op that leaves them pressing it again.
     */
    enqueue('calculation.run', { trigger: 'recalc_manual', as_of: '2026-06-15' });
    await drainJobs(5);

    const latest = one(`
      select trigger::text || '|' || coalesce((stats->>'no_change')::text, 'false')
        from public.calculation_runs
       where organization_id = '${orgId}' order by started_at desc limit 1`);
    expect(latest).toBe('recalc_manual|false');
  });
});
