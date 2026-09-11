import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { loadHealthDimension } from '@/modules/health';
import { adminSql, clientFor, createAuthUser, serverSession, sqlstate } from './setup';

/**
 * The health score's SQL surface (FINANCIAL_ENGINE.md §7; ADR-030.4, ADR-031.5, ADR-051.4, ADR-055).
 *
 * The properties under test are the ones a wrong answer would hide rather than announce:
 *   - no score row is ever written for an incomplete period;
 *   - `health_current` names exactly one score per period, and repointing is atomic;
 *   - a failed run puts back the health pointer it replaced, in step with the metric pointers;
 *   - a running run may redo its own chunk; a finished run's scores are immutable forever;
 *   - the whole surface is unreachable from a browser, and one tenant never sees another's score.
 *
 * The suite owns a run-unique organisation and removes exactly what it created (ADR-052.12), so a
 * concurrent suite cannot delete its fixtures mid-test.
 */

const RUN = `h${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.health.itest`;

let ownerId: string;
let otherOwnerId: string;
let orgId: string;
let otherOrgId: string;
let periodMar: string;
let periodApr: string;

const one = (sql: string): string => adminSql(`with q as (${sql}) select * from q`);

function serverRpc(fn: string, args: Record<string, unknown>): string {
  const params = Object.entries(args)
    .map(([k, v]) => `${k} => ${v === null ? 'null'
      : typeof v === 'number' ? String(v)
      : `${`'${String(v).replace(/'/g, "''")}'`}`}`)
    .join(', ');
  const output = adminSql(`
    ${serverSession(args.p_org as string | undefined)}
    select api_server.${fn}(${params})::text`);
  return output.split('\n').map((line) => line.trim()).filter(Boolean).pop() ?? '';
}

/** The fingerprint column is `bytea`, so a fixture value has to be hexadecimal, not a label. */
function startRun(fingerprint: string, org = orgId, from = periodMar, to = periodMar): string {
  return (JSON.parse(serverRpc('start_calculation_run', {
    p_org: org, p_trigger: 'recalc_manual', p_trigger_ref: null,
    p_engine_version: '1.0.0', p_period_from: from, p_period_to: to,
    p_as_of: '2026-06-15', p_fingerprint: fingerprint, p_job: null, p_periods_total: 1,
  })) as { runId: string }).runId;
}

function score(periodId: string, value: number | null, used = 6): Record<string, unknown> {
  return {
    period_id: periodId,
    score: value,
    dimensions_used: used,
    dimensions_total: 6,
    config_version: 'health.config.v1',
    breakdown: [{ key: 'profitability', score: value, weight_config: 25, weight_applied: 25 }],
  };
}

function finishHealth(runId: string, scores: Record<string, unknown>[], periodIds: string[], org = orgId): string {
  const output = adminSql(`
    ${serverSession(org)}
    select api_server.finish_health(
      '${org}', '${runId}',
      '${JSON.stringify(scores).replace(/'/g, "''")}'::jsonb,
      array[${periodIds.map((id) => `'${id}'`).join(',')}]::uuid[])::text`);
  return output.split('\n').map((line) => line.trim()).filter(Boolean).pop() ?? '';
}

function setComplete(periodId: string, complete: boolean): void {
  adminSql(`update public.fiscal_periods set is_complete = ${complete}
             where organization_id = '${orgId}' and id = '${periodId}'`);
}

beforeAll(async () => {
  ownerId = createAuthUser(`owner@${DOMAIN}`);
  otherOwnerId = createAuthUser(`other@${DOMAIN}`);

  const created = await clientFor(ownerId).schema('api').rpc('create_organization', {
    p_name: `ITest Health ${RUN}`,
  });
  if (created.error) throw new Error(`fixture org failed: ${created.error.message}`);
  orgId = created.data as unknown as string;

  const other = await clientFor(otherOwnerId).schema('api').rpc('create_organization', {
    p_name: `ITest Health Other ${RUN}`,
  });
  if (other.error) throw new Error(`second fixture org failed: ${other.error.message}`);
  otherOrgId = other.data as unknown as string;

  periodMar = one(`select id from public.fiscal_periods
                    where organization_id = '${orgId}' and period_start = '2026-03-01'`);
  periodApr = one(`select id from public.fiscal_periods
                    where organization_id = '${orgId}' and period_start = '2026-04-01'`);
});

afterAll(() => {
  adminSql(`
    -- Both fixture organisations, not only the one whose name starts with the run tag: deleting an
    -- owner whose organisation still exists trips the last-owner guard, and the teardown fails.
    delete from public.organizations where name like 'ITest Health%${RUN}';
    delete from auth.users where email like '%@${DOMAIN}';
    -- Sweep anything a killed run left behind more than an hour ago.
    delete from public.organizations where name like 'ITest Health %' and created_at < now() - interval '1 hour';
    delete from auth.users where email like '%.health.itest' and created_at < now() - interval '1 hour';`);
});

beforeEach(() => {
  adminSql(`
    begin;
    set local app.purge = 'on';
    delete from public.health_current where organization_id in ('${orgId}','${otherOrgId}');
    delete from public.health_scores where organization_id in ('${orgId}','${otherOrgId}');
    delete from public.calculation_runs where organization_id in ('${orgId}','${otherOrgId}');
    commit;`);
  setComplete(periodMar, true);
  setComplete(periodApr, false);
});

describe('no score for an incomplete period (ADR-030.4)', () => {
  it('refuses a score offered for a period that is not complete', () => {
    const run = startRun('a1');
    expect(() => finishHealth(run, [score(periodApr, 70)], [periodApr])).toThrow(/ADR-030\.4/);
  });

  it('writes nothing at all when the offer is refused', () => {
    const run = startRun('a2');
    try { finishHealth(run, [score(periodApr, 70)], [periodApr]); } catch { /* expected */ }
    expect(one(`select count(*) from public.health_scores where organization_id = '${orgId}'`)).toBe('0');
  });

  it('accepts the same score once the period is complete', () => {
    setComplete(periodApr, true);
    const run = startRun('a3');
    expect(finishHealth(run, [score(periodApr, 70)], [periodApr])).toBe('1');
  });
});

describe('health_current names exactly one score per period (ADR-031.5)', () => {
  it('writes the score and points at it', () => {
    const run = startRun('b1');
    expect(finishHealth(run, [score(periodMar, 62)], [periodMar])).toBe('1');

    expect(one(`select count(*) from public.health_current
                 where organization_id = '${orgId}' and period_id = '${periodMar}'`)).toBe('1');
    expect(one(`select h.score::text
                  from public.health_current c
                  join public.health_scores h
                    on h.organization_id = c.organization_id and h.id = c.health_score_id
                 where c.organization_id = '${orgId}' and c.period_id = '${periodMar}'`)).toBe('62');
  });

  it('repoints to the newer run and remembers the pointer it replaced', () => {
    const first = startRun('b2');
    finishHealth(first, [score(periodMar, 62)], [periodMar]);
    const firstScoreId = one(`select health_score_id::text from public.health_current
                               where organization_id = '${orgId}' and period_id = '${periodMar}'`);
    serverRpc('finish_calculation_run', { p_org: orgId, p_run: first, p_status: 'succeeded' });

    const second = startRun('b3');
    finishHealth(second, [score(periodMar, 71)], [periodMar]);

    const row = one(`select h.score || '|' || c.previous_health_score_id::text
                       from public.health_current c
                       join public.health_scores h
                         on h.organization_id = c.organization_id and h.id = c.health_score_id
                      where c.organization_id = '${orgId}' and c.period_id = '${periodMar}'`);
    expect(row).toBe(`71|${firstScoreId}`);

    // Still exactly one current score for the period — never two, never none.
    expect(one(`select count(*) from public.health_current
                 where organization_id = '${orgId}' and period_id = '${periodMar}'`)).toBe('1');
  });

  it('keeps a NULL score as NULL rather than turning it into a zero', () => {
    const run = startRun('b4');
    finishHealth(run, [score(periodMar, null, 2)], [periodMar]);
    expect(one(`select coalesce(h.score::text, 'NULL')
                  from public.health_current c
                  join public.health_scores h
                    on h.organization_id = c.organization_id and h.id = c.health_score_id
                 where c.organization_id = '${orgId}'`)).toBe('NULL');
  });
});

describe('a run may redo its own chunk, and never anyone else’s (ADR-051.4)', () => {
  it('replaces its own rows while it is still running', () => {
    const run = startRun('c1');
    finishHealth(run, [score(periodMar, 40)], [periodMar]);
    finishHealth(run, [score(periodMar, 55)], [periodMar]);

    expect(one(`select count(*) from public.health_scores
                 where organization_id = '${orgId}' and calculation_run_id = '${run}'`)).toBe('1');
    expect(one(`select h.score::text from public.health_current c
                  join public.health_scores h
                    on h.organization_id = c.organization_id and h.id = c.health_score_id
                 where c.organization_id = '${orgId}'`)).toBe('55');
  });

  it('a finished run’s score can never be changed or removed', () => {
    const run = startRun('c2');
    finishHealth(run, [score(periodMar, 62)], [periodMar]);
    serverRpc('finish_calculation_run', { p_org: orgId, p_run: run, p_status: 'succeeded' });

    expect(() => adminSql(`update public.health_scores set score = 99
                            where organization_id = '${orgId}'`)).toThrow(/IMMUTABLE/);
    expect(() => adminSql(`delete from public.health_scores
                            where organization_id = '${orgId}'`)).toThrow(/IMMUTABLE/);
  });

  it('a running run cannot UPDATE its own score either', () => {
    const run = startRun('c3');
    finishHealth(run, [score(periodMar, 62)], [periodMar]);
    expect(() => adminSql(`update public.health_scores set score = 99
                            where organization_id = '${orgId}' and calculation_run_id = '${run}'`))
      .toThrow(/IMMUTABLE/);
  });

  it('refuses a chunk offered against a run that is not running', () => {
    const run = startRun('c4');
    serverRpc('finish_calculation_run', { p_org: orgId, p_run: run, p_status: 'succeeded' });
    expect(() => finishHealth(run, [score(periodMar, 62)], [periodMar]))
      .toThrow(/no running calculation run/);
  });
});

describe('a failed run restores the health pointer it replaced (§2.4 step 12)', () => {
  it('puts back the previous run’s score', () => {
    const first = startRun('d1');
    finishHealth(first, [score(periodMar, 62)], [periodMar]);
    serverRpc('finish_calculation_run', { p_org: orgId, p_run: first, p_status: 'succeeded' });

    const second = startRun('d2');
    finishHealth(second, [score(periodMar, 12)], [periodMar]);
    serverRpc('finish_calculation_run', { p_org: orgId, p_run: second, p_status: 'failed' });

    expect(one(`select h.score::text from public.health_current c
                  join public.health_scores h
                    on h.organization_id = c.organization_id and h.id = c.health_score_id
                 where c.organization_id = '${orgId}' and c.period_id = '${periodMar}'`)).toBe('62');
    expect(one(`select c.calculation_run_id::text from public.health_current c
                 where c.organization_id = '${orgId}' and c.period_id = '${periodMar}'`)).toBe(first);
  });

  it('leaves no pointer at all when the failed run was the first to score the period', () => {
    // Better than pointing at a score from a run that failed: Home then says "not scored yet",
    // which is true, rather than showing a number nobody stands behind.
    const run = startRun('d3');
    finishHealth(run, [score(periodMar, 12)], [periodMar]);
    serverRpc('finish_calculation_run', { p_org: orgId, p_run: run, p_status: 'failed' });

    expect(one(`select count(*) from public.health_current
                 where organization_id = '${orgId}' and period_id = '${periodMar}'`)).toBe('0');
  });
});

describe('the surface is unreachable from a browser (ADR-043)', () => {
  it('api_server.finish_health cannot be executed with a user JWT', async () => {
    const run = startRun('e1');
    const { error } = await clientFor(ownerId).schema('api_server').rpc('finish_health', {
      p_org: orgId, p_run: run, p_scores: [], p_period_ids: [periodMar],
    });
    expect(error).not.toBeNull();
  });

  it('no authenticated user can write a health score directly', async () => {
    const db = clientFor(ownerId);
    for (const table of ['health_scores', 'health_current'] as const) {
      const { error } = await db.from(table).insert({ organization_id: orgId });
      expect(error, `${table} must refuse the insert`).not.toBeNull();
      expect(sqlstate(error)).toBe('42501');
    }
  });
});

describe('one tenant never sees another’s score', () => {
  it('reads its own score and zero rows of the other organisation', async () => {
    const run = startRun('e2');
    finishHealth(run, [score(periodMar, 62)], [periodMar]);
    serverRpc('finish_calculation_run', { p_org: orgId, p_run: run, p_status: 'succeeded' });

    const mine = await clientFor(ownerId).from('health_current')
      .select('period_id, health_scores!health_current_score_fk!inner (score)')
      .eq('organization_id', orgId);
    expect(mine.error).toBeNull();
    expect(mine.data).toHaveLength(1);

    const theirs = await clientFor(otherOwnerId).from('health_current')
      .select('period_id').eq('organization_id', orgId);
    expect(theirs.error).toBeNull();
    expect(theirs.data).toHaveLength(0);

    const scores = await clientFor(otherOwnerId).from('health_scores')
      .select('id').eq('organization_id', orgId);
    expect(scores.data ?? []).toHaveLength(0);
  });
});

/**
 * The dimension drill-down (`getHealthDimensionDetails` in the Phase 6 brief).
 *
 * It reads the stored breakdown and nothing else — the point of the assertions below is that what
 * the detail returns is exactly what the engine wrote, and that a reader from another organisation
 * gets nothing at all rather than a partly-filled shape.
 */
describe('one dimension of a stored score', () => {
  const detailScore = (periodId: string): Record<string, unknown> => ({
    period_id: periodId,
    score: 71,
    dimensions_used: 6,
    dimensions_total: 6,
    config_version: 'health.config.v1',
    breakdown: [
      {
        key: 'profitability', score: 62, weight_config: 25, weight_applied: 25, included: true,
        exclusion_reason: null,
        metrics: [{ metric_key: 'net_margin', value: '0.083', snapshot_id: '11111111-1111-4111-8111-111111111111' }],
        rules: [{ rule: 'P1', result: '0.05-0.15', points: 15 }],
        conditions: [], capped: false, cap_reason: null,
        positives: ['Net margin of 8.3% is healthy'], negatives: [],
        positives_structured: [], negatives_structured: [],
        data_quality: { completeness: 0.94, warnings: [] },
      },
      {
        key: 'customer_quality', score: null, weight_config: 10, weight_applied: 0, included: false,
        exclusion_reason: 'required_metric_missing', metrics: [], rules: [], conditions: [],
        capped: false, cap_reason: null, positives: [], negatives: [],
        positives_structured: [], negatives_structured: [],
        data_quality: { completeness: 0, warnings: [] },
      },
    ],
  });

  beforeEach(() => {
    // The fingerprint is stored as bytea: hex only.
    const run = startRun(Date.now().toString(16).slice(-8));
    finishHealth(run, [detailScore(periodMar)], [periodMar]);
    serverRpc('finish_calculation_run', { p_org: orgId, p_run: run, p_status: 'succeeded' });
  });

  it('returns the stored dimension whole: score, weight, metrics with their snapshots, rules, factors and data quality', async () => {
    const view = await loadHealthDimension(clientFor(ownerId), orgId, periodMar, 'profitability');
    expect(view).not.toBeNull();
    expect(view!.periodId).toBe(periodMar);
    expect(view!.configVersion).toBe('health.config.v1');

    const dimension = view!.dimension;
    expect(dimension.score).toBe(62);
    expect(dimension.weight_config).toBe(25);
    expect(dimension.included).toBe(true);
    // Each metric pins the snapshot the score rested on, which is what the evidence link opens (§7.4).
    expect(dimension.metrics.map((m) => m.snapshot_id)).toEqual(['11111111-1111-4111-8111-111111111111']);
    expect(dimension.rules.map((r) => r.rule)).toEqual(['P1']);
    expect(dimension.positives).toEqual(['Net margin of 8.3% is healthy']);
    expect(dimension.data_quality.completeness).toBe(0.94);
  });

  it('returns an excluded dimension with its reason rather than pretending it scored', async () => {
    const view = await loadHealthDimension(clientFor(ownerId), orgId, periodMar, 'customer_quality');
    expect(view!.dimension.included).toBe(false);
    expect(view!.dimension.score).toBeNull();
    expect(view!.dimension.exclusion_reason).toBe('required_metric_missing');
  });

  it('is NULL for a dimension the stored score does not carry, and for a period with no score', async () => {
    expect(await loadHealthDimension(clientFor(ownerId), orgId, periodMar, 'banking_health')).toBeNull();
    expect(await loadHealthDimension(clientFor(ownerId), orgId, periodApr, 'profitability')).toBeNull();
  });

  it('gives another organisation’s reader nothing at all', async () => {
    expect(await loadHealthDimension(clientFor(otherOwnerId), orgId, periodMar, 'profitability')).toBeNull();
  });
});
