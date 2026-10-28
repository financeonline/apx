import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { loadHealthDimension } from '@/modules/health';
import { periodId } from '@/db/app/shared';
import { orgRows } from '@/db/rls';
import { orgCollection } from '@/db/schema';
import { clientFor, createAuthUser, fs, rpc, serviceClientScoped, sqlstate } from './setup';
import { clearTables, removeSeeded, seedOrg, setComplete as markComplete } from '../fixtures/seed';

/**
 * The health score's write surface (FINANCIAL_ENGINE.md §7; ADR-030.4, ADR-031.5, ADR-051.4, ADR-055).
 *
 * The properties under test are the ones a wrong answer would hide rather than announce:
 *   - no score row is ever written for an incomplete period;
 *   - `health_current` names exactly one score per period, and repointing is atomic;
 *   - a failed run puts back the health pointer it replaced, in step with the metric pointers;
 *   - a running run may redo its own chunk; a finished run's scores are never rewritten;
 *   - the whole surface is unreachable from a browser, and one tenant never sees another's score.
 *
 * The suite owns run-unique organisations and removes exactly what it created (ADR-052.12), so a
 * concurrent suite cannot delete its fixtures mid-test. PostgreSQL's append-only trigger on
 * `health_scores` has no Firestore counterpart to probe: no function offers an UPDATE or a DELETE of
 * a finished run's score, which is what the two former IMMUTABLE assertions now check.
 */

const RUN = `h${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.health.itest.motion`;

let ownerId: string;
let otherOwnerId: string;
let orgId: string;
let otherOrgId: string;
let periodMar: string;
let periodApr: string;

/** An `api_server` call as the job's scoped server, throwing what the function raised. */
async function serverRpc(fn: string, args: Record<string, unknown>, org = orgId): Promise<unknown> {
  const { data, error } = await rpc(serviceClientScoped(org), fn, args, { server: true });
  if (error) throw error;
  return data;
}

/** The fingerprint is `bytea`, stored as hex, so a fixture value has to be hexadecimal, not a label. */
async function startRun(fingerprint: string, org = orgId, from = periodMar, to = periodMar): Promise<string> {
  return ((await serverRpc('start_calculation_run', {
    p_org: org, p_trigger: 'recalc_manual', p_trigger_ref: null,
    p_engine_version: '1.0.0', p_period_from: from, p_period_to: to,
    p_as_of: '2026-06-15', p_fingerprint: fingerprint, p_job: null, p_periods_total: 1,
  }, org)) as { runId: string }).runId;
}

function score(period: string, value: number | null, used = 6): Record<string, unknown> {
  return {
    period_id: period,
    score: value,
    dimensions_used: used,
    dimensions_total: 6,
    config_version: 'health.config.v1',
    breakdown: [{ key: 'profitability', score: value, weight_config: 25, weight_applied: 25 }],
  };
}

async function finishHealth(runId: string, scores: Record<string, unknown>[], periodIds: string[], org = orgId): Promise<number> {
  return Number(await serverRpc('finish_health', {
    p_org: org, p_run: runId, p_scores: scores, p_period_ids: periodIds,
  }, org));
}

async function setComplete(period: string, complete: boolean): Promise<void> {
  const start = period === periodMar ? '2026-03-01' : '2026-04-01';
  await markComplete(orgId, [start], complete);
}

/** The current score of a period, joined (the old `health_current join health_scores`). */
async function current(period: string, org = orgId): Promise<{ score: number | null; previous: string | null; run: string | null; id: string } | null> {
  const pointer = (await orgCollection(fs(), org, 'health_current').doc(period).get()).data();
  if (!pointer) return null;
  const sc = (await orgCollection(fs(), org, 'health_scores').doc(String(pointer.health_score_id)).get()).data();
  return {
    score: (sc?.score as number | null) ?? null, previous: (pointer.previous_health_score_id as string | null) ?? null,
    run: (pointer.calculation_run_id as string | null) ?? null, id: String(pointer.health_score_id),
  };
}

async function count(table: 'health_scores' | 'health_current', where: [string, unknown][] = []): Promise<number> {
  let q: FirebaseFirestore.Query = orgCollection(fs(), orgId, table);
  for (const [k, v] of where) q = q.where(k, '==', v);
  return (await q.get()).size;
}

beforeAll(async () => {
  ownerId = await createAuthUser(`owner@${DOMAIN}`);
  otherOwnerId = await createAuthUser(`other@${DOMAIN}`);
  orgId = (await seedOrg({ name: `ITest Health ${RUN}`, ownerId, around: '2026-06-15' })).orgId;
  otherOrgId = (await seedOrg({ name: `ITest Health Other ${RUN}`, ownerId: otherOwnerId, around: '2026-06-15' })).orgId;
  periodMar = periodId(orgId, '2026-03-01');
  periodApr = periodId(orgId, '2026-04-01');
});

afterAll(async () => {
  await removeSeeded([orgId, otherOrgId], `@${DOMAIN}`);
});

beforeEach(async () => {
  for (const org of [orgId, otherOrgId]) {
    await clearTables(org, ['health_current', 'health_scores', 'calculation_runs', 'evidence_bundles', 'evidence_items']);
  }
  await setComplete(periodMar, true);
  await setComplete(periodApr, false);
});

describe('no score for an incomplete period (ADR-030.4)', () => {
  it('refuses a score offered for a period that is not complete', async () => {
    const run = await startRun('a1');
    await expect(finishHealth(run, [score(periodApr, 70)], [periodApr])).rejects.toThrow(/ADR-030\.4/);
  });

  it('writes nothing at all when the offer is refused', async () => {
    const run = await startRun('a2');
    await finishHealth(run, [score(periodApr, 70)], [periodApr]).catch(() => undefined);
    expect(await count('health_scores')).toBe(0);
  });

  it('accepts the same score once the period is complete', async () => {
    await setComplete(periodApr, true);
    const run = await startRun('a3');
    expect(await finishHealth(run, [score(periodApr, 70)], [periodApr])).toBe(1);
  });
});

describe('health_current names exactly one score per period (ADR-031.5)', () => {
  it('writes the score and points at it', async () => {
    const run = await startRun('b1');
    expect(await finishHealth(run, [score(periodMar, 62)], [periodMar])).toBe(1);

    expect(await count('health_current', [['period_id', periodMar]])).toBe(1);
    expect((await current(periodMar))?.score).toBe(62);
  });

  it('repoints to the newer run and remembers the pointer it replaced', async () => {
    const first = await startRun('b2');
    await finishHealth(first, [score(periodMar, 62)], [periodMar]);
    const firstScoreId = (await current(periodMar))!.id;
    await serverRpc('finish_calculation_run', { p_org: orgId, p_run: first, p_status: 'succeeded' });

    const second = await startRun('b3');
    await finishHealth(second, [score(periodMar, 71)], [periodMar]);

    const row = await current(periodMar);
    expect(`${row!.score}|${row!.previous}`).toBe(`71|${firstScoreId}`);

    // Still exactly one current score for the period — never two, never none.
    expect(await count('health_current', [['period_id', periodMar]])).toBe(1);
  });

  it('keeps a NULL score as NULL rather than turning it into a zero', async () => {
    const run = await startRun('b4');
    await finishHealth(run, [score(periodMar, null, 2)], [periodMar]);
    expect((await current(periodMar))!.score).toBeNull();
  });
});

describe('a run may redo its own chunk, and never anyone else’s (ADR-051.4)', () => {
  it('replaces its own rows while it is still running', async () => {
    const run = await startRun('c1');
    await finishHealth(run, [score(periodMar, 40)], [periodMar]);
    await finishHealth(run, [score(periodMar, 55)], [periodMar]);

    expect(await count('health_scores', [['calculation_run_id', run]])).toBe(1);
    expect((await current(periodMar))!.score).toBe(55);
  });

  it('a finished run’s score is never replaced by a later chunk', async () => {
    const run = await startRun('c2');
    await finishHealth(run, [score(periodMar, 62)], [periodMar]);
    await serverRpc('finish_calculation_run', { p_org: orgId, p_run: run, p_status: 'succeeded' });

    // The only path that removes a score is a RUNNING run redoing its own chunk.
    await expect(finishHealth(run, [score(periodMar, 99)], [periodMar])).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const kept = (await orgCollection(fs(), orgId, 'health_scores').where('calculation_run_id', '==', run).get()).docs;
    expect(kept.map((d) => d.get('score'))).toEqual([62]);
  });

  it('refuses a chunk offered against a run that is not running', async () => {
    const run = await startRun('c4');
    await serverRpc('finish_calculation_run', { p_org: orgId, p_run: run, p_status: 'succeeded' });
    await expect(finishHealth(run, [score(periodMar, 62)], [periodMar])).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('a failed run restores the health pointer it replaced (§2.4 step 12)', () => {
  it('puts back the previous run’s score', async () => {
    const first = await startRun('d1');
    await finishHealth(first, [score(periodMar, 62)], [periodMar]);
    await serverRpc('finish_calculation_run', { p_org: orgId, p_run: first, p_status: 'succeeded' });

    const second = await startRun('d2');
    await finishHealth(second, [score(periodMar, 12)], [periodMar]);
    await serverRpc('finish_calculation_run', { p_org: orgId, p_run: second, p_status: 'failed' });

    const row = await current(periodMar);
    expect(row!.score).toBe(62);
    expect(row!.run).toBe(first);
  });

  it('leaves no pointer at all when the failed run was the first to score the period', async () => {
    // Better than pointing at a score from a run that failed: Home then says "not scored yet",
    // which is true, rather than showing a number nobody stands behind.
    const run = await startRun('d3');
    await finishHealth(run, [score(periodMar, 12)], [periodMar]);
    await serverRpc('finish_calculation_run', { p_org: orgId, p_run: run, p_status: 'failed' });

    expect(await count('health_current', [['period_id', periodMar]])).toBe(0);
  });
});

describe('the surface is unreachable from a browser (ADR-043)', () => {
  it('api_server.finish_health refuses a user handle', async () => {
    const run = await startRun('e1');
    const { error } = await rpc(clientFor(ownerId), 'finish_health', {
      p_org: orgId, p_run: run, p_scores: [], p_period_ids: [periodMar],
    }, { server: true });
    expect(error).not.toBeNull();
    expect(sqlstate(error)).toBe('42501');
  });

  it('a server call scoped to another organisation is refused', async () => {
    const run = await startRun('e3');
    const { error } = await rpc(serviceClientScoped(otherOrgId), 'finish_health', {
      p_org: orgId, p_run: run, p_scores: [score(periodMar, 62)], p_period_ids: [periodMar],
    }, { server: true });
    expect(sqlstate(error)).toBe('42501');
  });

  it('no user-callable function writes a health score', async () => {
    const { API_FUNCTIONS } = await import('@/db/api');
    // Reads (`portfolio_health_breakdowns`) are user-callable; nothing that writes a score is.
    expect(Object.keys(API_FUNCTIONS).filter((n) => /^(finish|write|set|record|upsert)_.*health/.test(n))).toEqual([]);
  });
});

describe('one tenant never sees another’s score', () => {
  it('reads its own score and zero rows of the other organisation', async () => {
    const run = await startRun('e2');
    await finishHealth(run, [score(periodMar, 62)], [periodMar]);
    await serverRpc('finish_calculation_run', { p_org: orgId, p_run: run, p_status: 'succeeded' });

    expect(await orgRows(clientFor(ownerId), orgId, 'health_current')).toHaveLength(1);
    expect(await orgRows(clientFor(otherOwnerId), orgId, 'health_current')).toHaveLength(0);
    expect(await orgRows(clientFor(otherOwnerId), orgId, 'health_scores')).toHaveLength(0);
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
  const detailScore = (period: string): Record<string, unknown> => ({
    period_id: period,
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

  beforeEach(async () => {
    // The fingerprint is stored as bytea: hex only.
    const run = await startRun(Date.now().toString(16).slice(-8));
    await finishHealth(run, [detailScore(periodMar)], [periodMar]);
    await serverRpc('finish_calculation_run', { p_org: orgId, p_run: run, p_status: 'succeeded' });
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
