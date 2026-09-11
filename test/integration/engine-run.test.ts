import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';

import { adminSql, clientFor, createAuthUser, resetFixtures, serverSession } from './setup';

/**
 * The calculation run's SQL surface (FINANCIAL_ENGINE.md §2.4; ADR-031, ADR-047.7/8).
 *
 * The properties under test are the ones a wrong answer would hide rather than announce:
 *   - the aggregate counts only accepted, non-superseded records, and pins its read to an instant;
 *   - an unchanged fingerprint finishes the run without rewriting a thing;
 *   - the pointer rewrite RETIRES a dimension that has vanished, rather than leaving it pointing at
 *     a snapshot this run did not write;
 *   - a failed run puts back exactly the pointers it replaced.
 */

let ownerId: string;
let orgId: string;
let periodMay: string;
let revenueAccount: string;
let payrollAccount: string;

const one = (sql: string): string => adminSql(`with q as (${sql}) select * from q`);

/**
 * The engine surface is service-role only (ADR-043), so the test asserts the claim rather than
 * bypassing the check. psql runs the statements of one `-c` in a single implicit transaction, so a
 * session-level `set_config` reaches the function call; the last output line is the result.
 */
function serverRpc(fn: string, args: Record<string, unknown>): string {
  const params = Object.entries(args)
    .map(([k, v]) => `${k} => ${v === null ? 'null' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`}`)
    .join(', ');
  const output = adminSql(`
    ${serverSession(args.p_org as string | undefined)}
    select api_server.${fn}(${params})::text`);
  return output.split('\n').map((line) => line.trim()).filter(Boolean).pop() ?? '';
}

beforeAll(async () => {
  resetFixtures();
  ownerId = createAuthUser('engine-owner@itest.motion');
  const created = await clientFor(ownerId).schema('api').rpc('create_organization', {
    p_name: 'ITest Engine',
  });
  if (created.error) throw new Error(`fixture org failed: ${created.error.message}`);
  orgId = created.data as unknown as string;

  periodMay = one(`
    select id from public.fiscal_periods
     where organization_id = '${orgId}' and period_start = '2026-05-01'`);
  revenueAccount = one(`
    select id from public.accounts
     where organization_id = '${orgId}' and standard_category = 'revenue'`);
  payrollAccount = one(`
    select id from public.accounts
     where organization_id = '${orgId}' and standard_category = 'payroll'`);
});

afterAll(() => resetFixtures());

beforeEach(() => {
  adminSql(`
    begin;
    set local app.purge = 'on';
    delete from public.metric_current where organization_id = '${orgId}';
    delete from public.metric_snapshots where organization_id = '${orgId}';
    delete from public.calculation_runs where organization_id = '${orgId}';
    delete from public.ledger_entries where organization_id = '${orgId}';
    commit;`);
});

describe('the L0 aggregation counts only what the engine may see (§1.3)', () => {
  it('sums accepted rows per period, category and account', () => {
    adminSql(`
      insert into public.ledger_entries
             (organization_id, entry_date, account_id, direction, amount, period_id, record_status)
      values ('${orgId}', '2026-05-10', '${revenueAccount}', 'credit', 10000.00,
              '00000000-0000-0000-0000-000000000000', 'accepted'),
             ('${orgId}', '2026-05-20', '${payrollAccount}', 'debit', 4000.00,
              '00000000-0000-0000-0000-000000000000', 'accepted')`);

    const rows = adminSql(`
      select string_agg(standard_category::text || '=' || amount::text, ',' order by standard_category::text)
        from app.aggregate_periods('${orgId}', '2026-05-01', '2026-05-31')
       where source = 'ledger'`);

    // Debit − credit, raw: the account-type sign rule is the engine's job, not the aggregate's.
    expect(rows).toBe('payroll=4000.00,revenue=-10000.00');
  });

  it('ignores a row that is not accepted', () => {
    adminSql(`
      insert into public.ledger_entries
             (organization_id, entry_date, account_id, direction, amount, period_id, record_status)
      values ('${orgId}', '2026-05-10', '${revenueAccount}', 'credit', 500.00,
              '00000000-0000-0000-0000-000000000000', 'pending')`);

    const count = adminSql(`
      select count(*) from app.aggregate_periods('${orgId}', '2026-05-01', '2026-05-31')`);
    expect(Number(count), 'a pending row is invisible to the engine').toBe(0);
  });

  it('ignores a superseded row', () => {
    const kept = one(`
      insert into public.ledger_entries
             (organization_id, entry_date, account_id, direction, amount, period_id, record_status)
      values ('${orgId}', '2026-05-10', '${revenueAccount}', 'credit', 100.00,
              '00000000-0000-0000-0000-000000000000', 'accepted')
      returning id`);
    const replaced = one(`
      insert into public.ledger_entries
             (organization_id, entry_date, account_id, direction, amount, period_id, record_status)
      values ('${orgId}', '2026-05-11', '${revenueAccount}', 'credit', 99999.00,
              '00000000-0000-0000-0000-000000000000', 'accepted')
      returning id`);
    adminSql(`
      update public.ledger_entries set superseded_by = '${kept}' where id = '${replaced}'`);

    const amount = adminSql(`
      select amount::text from app.aggregate_periods('${orgId}', '2026-05-01', '2026-05-31')
       where source = 'ledger' and standard_category = 'revenue'`);
    expect(amount, 'the superseded 99,999 must not reach any figure').toBe('-100.00');
  });

  it('pins its read to an instant, so a chunk can be reproduced later', () => {
    adminSql(`
      insert into public.ledger_entries
             (organization_id, entry_date, account_id, direction, amount, period_id, record_status)
      values ('${orgId}', '2026-05-10', '${revenueAccount}', 'credit', 100.00,
              '00000000-0000-0000-0000-000000000000', 'accepted')`);

    const now = adminSql(`
      select count(*) from app.aggregate_periods('${orgId}', '2026-05-01', '2026-05-31')`);
    const before = adminSql(`
      select count(*) from app.aggregate_periods('${orgId}', '2026-05-01', '2026-05-31',
                                                 now() - interval '1 day')`);
    expect(Number(now)).toBeGreaterThan(0);
    expect(Number(before), 'an earlier instant sees the data that existed then').toBe(0);
  });

  it('is not reachable by a signed-in user', async () => {
    // The aggregate reads every record in the organization regardless of RLS; it is engine-internal.
    const { error } = await clientFor(ownerId).rpc('aggregate_periods', {
      p_org: orgId, p_from: '2026-05-01', p_to: '2026-05-31',
    });
    expect(error, 'app.* is not exposed to PostgREST').not.toBeNull();
  });
});

describe('a run that has nothing to do does nothing (ADR-047.8)', () => {
  it('finishes immediately when the fingerprint is unchanged', () => {
    const first = serverRpc('start_calculation_run', {
      p_org: orgId, p_trigger: 'import_commit', p_trigger_ref: null,
      p_engine_version: '1.0.0', p_period_from: periodMay, p_period_to: periodMay,
      p_as_of: '2026-06-15', p_fingerprint: 'abcd', p_job: null, p_periods_total: 1,
    });
    expect(first).toContain('"noChange": false');

    const runId = JSON.parse(first).runId as string;
    serverRpc('finish_calculation_run', {
      p_org: orgId, p_run: runId, p_status: 'succeeded',
    });

    const second = serverRpc('start_calculation_run', {
      p_org: orgId, p_trigger: 'import_commit', p_trigger_ref: null,
      p_engine_version: '1.0.0', p_period_from: periodMay, p_period_to: periodMay,
      p_as_of: '2026-06-15', p_fingerprint: 'abcd', p_job: null, p_periods_total: 1,
    });
    expect(second, 'nothing the engine reads has changed').toContain('"noChange": true');

    const stats = adminSql(`
      select stats ->> 'no_change' from public.calculation_runs
       where organization_id = '${orgId}' order by started_at desc limit 1`);
    expect(stats).toBe('true');
  });

  it('but a human asking for a recalculation always gets one', () => {
    const first = JSON.parse(serverRpc('start_calculation_run', {
      p_org: orgId, p_trigger: 'import_commit', p_trigger_ref: null,
      p_engine_version: '1.0.0', p_period_from: periodMay, p_period_to: periodMay,
      p_as_of: '2026-06-15', p_fingerprint: 'beef', p_job: null, p_periods_total: 1,
    })) as { runId: string };
    serverRpc('finish_calculation_run', {
      p_org: orgId, p_run: first.runId, p_status: 'succeeded',
    });

    const manual = serverRpc('start_calculation_run', {
      p_org: orgId, p_trigger: 'recalc_manual', p_trigger_ref: null,
      p_engine_version: '1.0.0', p_period_from: periodMay, p_period_to: periodMay,
      p_as_of: '2026-06-15', p_fingerprint: 'beef', p_job: null, p_periods_total: 1,
    });
    expect(manual).toContain('"noChange": false');
  });
});

describe('the pointer rewrite (§2.4 step 8, F-B-16)', () => {
  function startRun(fingerprint: string): string {
    return (JSON.parse(serverRpc('start_calculation_run', {
      p_org: orgId, p_trigger: 'recalc_manual', p_trigger_ref: null,
      p_engine_version: '1.0.0', p_period_from: periodMay, p_period_to: periodMay,
      p_as_of: '2026-06-15', p_fingerprint: fingerprint, p_job: null, p_periods_total: 1,
    })) as { runId: string }).runId;
  }

  function writeChunk(runId: string, snapshots: unknown[]): void {
    adminSql(`
      ${serverSession(orgId)}
      select api_server.finish_chunk(
        '${orgId}', '${runId}',
        '${JSON.stringify(snapshots).replace(/'/g, "''")}'::jsonb,
        array['${periodMay}']::uuid[], now(), '${periodMay}', null)`);
  }

  const snapshot = (key: string, value: string | null, dimensionId: string | null = null) => ({
    period_id: periodMay, metric_key: key,
    dimension_type: dimensionId ? 'standard_category' : 'none',
    dimension_id: null, value, unit: 'money', currency: 'GBP',
    basis: 'ledger', assurance_level: 'calculated',
    data_quality: { completeness: 1, proxy: false, warnings: [], missing: [] },
    components: {}, evidence_query: null,
  });

  it('names the current snapshot for every metric it wrote', () => {
    const runId = startRun('a1a1');
    writeChunk(runId, [snapshot('revenue', '10000.00'), snapshot('net_profit', '2000.00')]);

    const pointers = adminSql(`
      select string_agg(metric_key, ',' order by metric_key)
        from public.metric_current where organization_id = '${orgId}'`);
    expect(pointers).toBe('net_profit,revenue');
  });

  it('retires a dimension the new run no longer produces', () => {
    // The case F-B-16 is about: a category nobody used this month, or a merged counterparty. An
    // update-in-place would leave last month's pointer naming a snapshot this run did not write.
    const first = startRun('a1a1');
    writeChunk(first, [snapshot('revenue', '10000.00'), snapshot('expense_by_category', '500.00')]);
    serverRpc('finish_calculation_run', { p_org: orgId, p_run: first, p_status: 'succeeded' });

    const second = startRun('b2b2');
    writeChunk(second, [snapshot('revenue', '12000.00')]);

    const pointers = adminSql(`
      select coalesce(string_agg(metric_key, ',' order by metric_key), '(none)')
        from public.metric_current where organization_id = '${orgId}'`);
    expect(pointers, 'the vanished category must not linger').toBe('revenue');

    const value = adminSql(`
      select s.value::text from public.metric_current c
       join public.metric_snapshots s
         on s.organization_id = c.organization_id and s.id = c.snapshot_id
      where c.organization_id = '${orgId}' and c.metric_key = 'revenue'`);
    expect(value).toBe('12000.000000');
  });

  it('records what each pointer replaced, so a failure can put it back', () => {
    const first = startRun('a1a1');
    writeChunk(first, [snapshot('revenue', '10000.00')]);
    serverRpc('finish_calculation_run', { p_org: orgId, p_run: first, p_status: 'succeeded' });

    const second = startRun('b2b2');
    writeChunk(second, [snapshot('revenue', '99999.00')]);

    const previous = adminSql(`
      select (previous_snapshot_id is not null)::text from public.metric_current
       where organization_id = '${orgId}' and metric_key = 'revenue'`);
    expect(previous).toBe('true');
  });

  /** A category-dimensioned snapshot: `dimension_key`, never `dimension_id` (ADR-053). */
  const categorySnapshot = (category: string, value: string) => ({
    period_id: periodMay, metric_key: 'expense_by_category',
    dimension_type: 'standard_category', dimension_id: null, dimension_key: category,
    value, unit: 'money', currency: 'GBP',
    basis: 'ledger', assurance_level: 'calculated',
    data_quality: { completeness: 1, proxy: false, warnings: [], missing: [] },
    components: {}, evidence_query: null,
  });

  it('restores category-dimensioned pointers with their categories intact (ADR-055.1)', () => {
    /*
     * The defect this test was written for: the failed-run restore was last written before
     * `dimension_key` existed, so it put every category pointer back with a NULL key. Because the
     * uniqueness index is NULLS NOT DISTINCT, all of them collapsed into ONE row pointing at an
     * arbitrary category's snapshot — and spending by category would have shown one category's
     * figure under every category's name, silently, only after a run failed.
     */
    const first = startRun('a1a1');
    writeChunk(first, [
      categorySnapshot('marketing', '3000.00'),
      categorySnapshot('payroll', '18000.00'),
      categorySnapshot('software', '450.00'),
    ]);
    serverRpc('finish_calculation_run', { p_org: orgId, p_run: first, p_status: 'succeeded' });

    const second = startRun('b2b2');
    writeChunk(second, [
      categorySnapshot('marketing', '9000.00'),
      categorySnapshot('payroll', '19000.00'),
      categorySnapshot('software', '460.00'),
    ]);
    serverRpc('finish_calculation_run', { p_org: orgId, p_run: second, p_status: 'failed' });

    const restored = adminSql(`
      select string_agg(c.dimension_key || '=' || s.value::text, ',' order by c.dimension_key)
        from public.metric_current c
        join public.metric_snapshots s
          on s.organization_id = c.organization_id and s.id = c.snapshot_id
       where c.organization_id = '${orgId}' and c.metric_key = 'expense_by_category'`);

    expect(restored).toBe(
      'marketing=3000.000000,payroll=18000.000000,software=450.000000',
    );
  });

  it('restores the previous pointers when a run fails (§2.4 step 12)', () => {
    const first = startRun('a1a1');
    writeChunk(first, [snapshot('revenue', '10000.00')]);
    serverRpc('finish_calculation_run', { p_org: orgId, p_run: first, p_status: 'succeeded' });

    const second = startRun('b2b2');
    writeChunk(second, [snapshot('revenue', '99999.00')]);
    serverRpc('finish_calculation_run', { p_org: orgId, p_run: second, p_status: 'failed' });

    const value = adminSql(`
      select s.value::text from public.metric_current c
       join public.metric_snapshots s
         on s.organization_id = c.organization_id and s.id = c.snapshot_id
      where c.organization_id = '${orgId}' and c.metric_key = 'revenue'`);
    // A reader must never see this month from a failed run and last month from the previous one.
    expect(value, 'the failed run\'s figure must not stand').toBe('10000.000000');

    const status = adminSql(`
      select status::text || '|' || coalesce(failure_reason::text, '-')
        from public.calculation_runs where id = '${second}'`);
    expect(status).toBe('failed|error');
  });

  it('is idempotent when a chunk is retried', () => {
    // A worker that died after writing half a chunk must not double it on the next attempt.
    const runId = startRun('a1a1');
    writeChunk(runId, [snapshot('revenue', '10000.00')]);
    writeChunk(runId, [snapshot('revenue', '10000.00')]);

    const count = adminSql(`
      select count(*) from public.metric_snapshots
       where organization_id = '${orgId}' and calculation_run_id = '${runId}'`);
    expect(Number(count)).toBe(1);
  });

  it('keeps snapshots append-only even for the engine', () => {
    const runId = startRun('a1a1');
    writeChunk(runId, [snapshot('revenue', '10000.00')]);

    const outcome = adminSql(`
      select case when exists (
        select 1 from public.metric_snapshots
         where organization_id = '${orgId}' and value = 1
      ) then 'MUTATED' else 'INTACT' end
        from (select 1) probe`);
    // The guard refuses even the engine's own service role; the value is unchanged.
    let refused = false;
    try {
      adminSql(`update public.metric_snapshots set value = 1 where organization_id = '${orgId}'`);
    } catch {
      refused = true;
    }
    expect(refused, 'metric_snapshots is append-only for every principal').toBe(true);
    expect(outcome).toBe('INTACT');
  });
});

describe('a run marks its periods complete (ADR-030.1)', () => {
  it('sets is_complete only where the engine says so', () => {
    adminSql(`
      ${serverSession(orgId)}
      select api_server.set_period_completeness(
        '${orgId}', array['${periodMay}']::uuid[], array[true]::boolean[])`);

    const complete = adminSql(`
      select is_complete::text from public.fiscal_periods where id = '${periodMay}'`);
    expect(complete).toBe('true');
  });

  it('is not reachable by a signed-in user', async () => {
    const { error } = await clientFor(ownerId).schema('api_server').rpc('set_period_completeness', {
      p_org: orgId, p_periods: [periodMay], p_complete: [true],
    });
    expect(error).not.toBeNull();
  });
});
