import 'server-only';
import type { DocumentData, Firestore, Transaction } from 'firebase-admin/firestore';
import { raise } from '../raise';
import { arg, type DbFunctions } from '../registry';
import {
  acrossOrgs, globalRow, metricCellId, newId, nowIso, orgCollection, orgRow, uniqueGuard,
} from '../schema';
import { runTx } from '../tx';
import type { Db } from '../types';
import { hasPermissionOf } from './access';
import { prepareAudit } from './audit';
import { intOrNull, numericText, textOrNull, writeBundle, writeBundleAt, type ItemInput } from './engine-evidence';
import {
  checkSameOrgRef, getAllChunked, hexOrNull, jsonb, missingReference, uuidOrNull, WritePlan,
} from './engine-writes';
import { requireScope, requireServer } from './scope';

/**
 * The calculation run's writes (FINANCIAL_ENGINE.md §2.4; ADR-031, ADR-047, ADR-051, ADR-057):
 * `api_server.start_calculation_run`, `finish_chunk`, `finish_calculation_run`,
 * `set_period_completeness`, `finish_health` and `build_metric_bundle_as`, ported from PL/pgSQL.
 *
 * What changes with Firestore, and what does not:
 *
 *  - Every refusal is the SQL's: a caller that is not the server, a scope that is not the
 *    organisation (ADR-090), a run that is not running, a score for an incomplete period.
 *  - The append-only guards (`metric_snapshot_guard`, `health_score_guard`) become simply never
 *    offering an update: the only deletes are a running run redoing its own chunk, which is exactly
 *    what the guards permitted.
 *  - A chunk writes more documents than one transaction holds, so `finish_chunk` and a failed run's
 *    restore commit in batches (`WritePlan`): the snapshots first (invisible until pointed at), the
 *    `metric_current` pointers after, and the run's progress last. The pointer flip of one chunk is
 *    therefore no longer a single atomic step; each cell's pointer is replaced in one write, so a
 *    reader never finds a cell with no pointer, but may for a moment see some cells of a period from
 *    the new run and some from the previous one. A crash part-way leaves the run `running`, and the
 *    retried chunk (or the failed run's restore) repairs it, as a retried SQL chunk did.
 *  - The cascades the foreign keys did (`metric_current_snapshot_fk`, `health_current_score_fk` ON
 *    DELETE CASCADE, `health_current_previous_fk` ON DELETE SET NULL) are done here explicitly.
 */

type Row = Record<string, unknown>;

const DIMENSION_TABLES = {
  none: '-', standard_category: '-', account: 'accounts', counterparty: 'counterparties', bank_account: 'bank_accounts',
} as const;

export const TRIGGER_TABLES = {
  import_commit: 'import_batches', import_rollback: 'import_batches', account_remapped: 'accounts',
  counterparty_merged: 'counterparties', recalc_manual: '-', scheduled: '-', settings_changed: '-',
  banking_edit: '-', record_superseded: '-',
} as const;

/** The cell a snapshot or pointer occupies (`metric_*_cell_unique`, NULLS NOT DISTINCT). */
const cellKey = (r: Row): string => JSON.stringify([
  r.period_id, r.metric_key, r.dimension_type, r.dimension_id ?? null, r.dimension_key ?? null,
]);

const cellId = (r: Row): string => metricCellId({
  period_id: String(r.period_id), metric_key: String(r.metric_key), dimension_type: (r.dimension_type as string) ?? null,
  dimension_id: (r.dimension_id as string | null) ?? null, dimension_key: (r.dimension_key as string | null) ?? null,
});

function inChunks<T>(items: readonly T[], size = 30): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** `p_x uuid[]`. */
function uuidArray(args: Record<string, unknown>, name: string): string[] {
  return (arg.arr<unknown>(args, name) ?? []).map((v) => uuidOrNull(v)!).filter(Boolean);
}

/** Rows of one org table whose `field` is any of `values` (`= any(...)`), 30 per query. */
async function rowsWhereIn(
  fs: Firestore, orgId: string, table: Parameters<typeof orgCollection>[2],
  equals: ReadonlyArray<readonly [string, unknown]>, field: string, values: readonly string[], tx?: Transaction,
): Promise<DocumentData[]> {
  const out: DocumentData[] = [];
  for (const chunk of inChunks([...new Set(values)])) {
    let q: FirebaseFirestore.Query = orgCollection(fs, orgId, table);
    for (const [f, v] of equals) q = q.where(f, '==', v);
    q = q.where(field, 'in', chunk);
    const snap = tx ? await tx.get(q) : await q.get();
    out.push(...snap.docs.map((d) => d.data()));
  }
  return out;
}

async function runningRun(fs: Firestore, orgId: string, runId: string | null, tx?: Transaction): Promise<DocumentData | null> {
  if (!runId) return null;
  const ref = orgRow(fs, orgId, 'calculation_runs', runId);
  const snap = tx ? await tx.get(ref) : await ref.get();
  return snap.exists && snap.get('status') === 'running' ? snap.data()! : null;
}

// ── start_calculation_run ────────────────────────────────────────────────────────────────────────

async function startCalculationRun(db: Db, args: Record<string, unknown>): Promise<unknown> {
  requireServer(db);
  const orgId = arg.req(args, 'p_org');
  // ADR-090: this function only ever runs inside a job, and a job is always scoped.
  requireScope(db, orgId);
  const fs = db.fs;
  const trigger = arg.req(args, 'p_trigger');
  const triggerRef = uuidOrNull(args.p_trigger_ref);
  const periodFrom = uuidOrNull(arg.req(args, 'p_period_from'))!;
  const periodTo = uuidOrNull(arg.req(args, 'p_period_to'))!;
  const jobId = uuidOrNull(args.p_job);
  const fingerprint = hexOrNull(arg.str(args, 'p_fingerprint'));
  const run = {
    trigger, trigger_ref_id: triggerRef, engine_version: arg.req(args, 'p_engine_version'),
    period_from: periodFrom, period_to: periodTo, as_of: arg.req(args, 'p_as_of'),
  };

  // The foreign keys and `same_org_ref_trigger_ref`, checked before anything is written.
  await checkSameOrgRef(fs, orgId, 'calculation_runs', 'trigger_ref_id', 'trigger', TRIGGER_TABLES, [run]);
  const [from, to] = await fs.getAll(
    orgRow(fs, orgId, 'fiscal_periods', periodFrom), orgRow(fs, orgId, 'fiscal_periods', periodTo),
  );
  if (!from!.exists) missingReference('calculation_runs', 'period_from');
  if (!to!.exists) missingReference('calculation_runs', 'period_to');
  if (jobId) {
    const job = await globalRow(fs, 'jobs', jobId).get();
    if (!job.exists || job.get('organization_id') !== orgId) missingReference('calculation_runs', 'job_id');
  }

  // ADR-047.8: an unchanged fingerprint finishes the run at once — except for a human's request.
  const last = await orgCollection(fs, orgId, 'calculation_runs').where('status', '==', 'succeeded')
    .orderBy('finished_at', 'desc').limit(1).get();
  const lastFingerprint = last.empty ? null : ((last.docs[0]!.get('input_fingerprint') as string | null) ?? null);

  const id = newId();
  const now = nowIso();
  const base = {
    id, organization_id: orgId, job_id: jobId, ...run, as_of_ts: now, failure_reason: null, stale: false,
    input_fingerprint: fingerprint, chunks: [], error: null, created_at: now, updated_at: now,
  };
  if (lastFingerprint !== null && lastFingerprint === fingerprint && trigger !== 'recalc_manual') {
    await orgRow(fs, orgId, 'calculation_runs', id).set({
      ...base, status: 'succeeded', progress: {}, started_at: now, finished_at: now, duration_ms: 0,
      stats: { no_change: true },
    });
    return { runId: id, noChange: true };
  }
  await orgRow(fs, orgId, 'calculation_runs', id).set({
    ...base, status: 'running', started_at: now, finished_at: null, duration_ms: null, stats: {},
    progress: { periods_done: 0, periods_total: intOrNull(args.p_periods_total) ?? 0 },
  });
  return { runId: id, noChange: false };
}

// ── finish_chunk ─────────────────────────────────────────────────────────────────────────────────

function snapshotRow(orgId: string, runId: string, s: Row, now: string): Row {
  const dimensionType = (s.dimension_type as string | null | undefined) ?? 'none';
  const row: Row = {
    id: uuidOrNull(s.id) ?? newId(),
    organization_id: orgId,
    calculation_run_id: runId,
    period_id: uuidOrNull(s.period_id),
    metric_key: textOrNull(s.metric_key),
    dimension_type: dimensionType,
    dimension_id: uuidOrNull(s.dimension_id),
    dimension_key: textOrNull(s.dimension_key),
    value: numericText(s.value, 6),
    unit: textOrNull(s.unit),
    currency: textOrNull(s.currency),
    basis: textOrNull(s.basis),
    assurance_level: textOrNull(s.assurance_level),
    // `coalesce(s -> 'x', '{}')`: absent is `{}`, an explicit JSON null stays null.
    data_quality: 'data_quality' in s ? jsonb(s.data_quality) : {},
    components: 'components' in s ? jsonb(s.components) : {},
    evidence_query: jsonb(s.evidence_query ?? null),
    created_at: now,
  };
  for (const column of ['period_id', 'metric_key', 'unit', 'basis', 'assurance_level'] as const) {
    if (row[column] === null) raise.invalid(`null value in column "${column}" of relation "metric_snapshots" violates not-null constraint`);
  }
  if (!(dimensionType in DIMENSION_TABLES)) {
    raise.invalid(`invalid input value for enum metric_dimension_enum: "${dimensionType}"`);
  }
  return row;
}

async function finishChunk(db: Db, args: Record<string, unknown>): Promise<unknown> {
  requireServer(db);
  const orgId = arg.req(args, 'p_org');
  requireScope(db, orgId);
  const fs = db.fs;
  const runId = uuidOrNull(arg.req(args, 'p_run'))!;
  const periodIds = uuidArray(args, 'p_period_ids');
  const asOfKeys = arg.arr<string>(args, 'p_as_of_keys');
  const aggregatedAt = arg.req(args, 'p_aggregated_at');
  const cursor = arg.str(args, 'p_cursor');

  if (!(await runningRun(fs, orgId, runId))) raise.conflict('this run is not running');

  const now = nowIso();
  const snapshots = (arg.arr<Row>(args, 'p_snapshots') ?? []).map((s) => snapshotRow(orgId, runId, s ?? {}, now));
  await checkSameOrgRef(fs, orgId, 'metric_snapshots', 'dimension_id', 'dimension_type', DIMENSION_TABLES, snapshots);

  // This run's snapshots of the chunk's periods: redone, so deleted first (the guard allows it while running).
  const replaced = await rowsWhereIn(fs, orgId, 'metric_snapshots', [['calculation_run_id', runId]], 'period_id', periodIds);
  const replacedIds = new Set(replaced.map((r) => String(r.id)));

  /*
   * `metric_snapshots_cell_unique` and the primary key, checked in memory: after the delete, this
   * run holds no cell of the chunk's periods, so a clash is two payload rows on one cell, or a cell
   * this run already wrote for a period outside the chunk, or an id another row already has.
   */
  const cells = new Set<string>();
  const outside = [...new Set(snapshots.map((s) => String(s.period_id)).filter((p) => !periodIds.includes(p)))];
  for (const r of await rowsWhereIn(fs, orgId, 'metric_snapshots', [['calculation_run_id', runId]], 'period_id', outside)) {
    cells.add(cellKey(r));
  }
  const ids = new Set<string>();
  for (const s of snapshots) {
    const key = cellKey(s);
    if (cells.has(key)) raise.conflict('duplicate key value violates unique constraint "metric_snapshots_cell_unique"');
    cells.add(key);
    if (ids.has(String(s.id))) raise.conflict('duplicate key value violates unique constraint "metric_snapshots_pkey"');
    ids.add(String(s.id));
  }
  const existing = await getAllChunked(fs, snapshots.map((s) => orgRow(fs, orgId, 'metric_snapshots', String(s.id))));
  if (existing.some((snap) => snap.exists && !replacedIds.has(snap.id))) {
    raise.conflict('duplicate key value violates unique constraint "metric_snapshots_pkey"');
  }

  // 1. The snapshots: deletes and inserts, not yet current.
  const writes = new WritePlan();
  for (const r of replaced) writes.delete(orgRow(fs, orgId, 'metric_snapshots', String(r.id)));
  for (const s of snapshots) writes.set(orgRow(fs, orgId, 'metric_snapshots', String(s.id)), s);
  await writes.commit(fs);

  // 2. The pointers, period by period.
  const runs = await orgCollection(fs, orgId, 'calculation_runs').select('started_at').get();
  const startedAt = new Map(runs.docs.map((d) => [d.id, (d.get('started_at') as string | null) ?? null]));
  // `pr.started_at desc` puts NULL first, as PostgreSQL's DESC does.
  const rank = (run: string): number => {
    const s = startedAt.get(run);
    return s === null || s === undefined ? Number.POSITIVE_INFINITY : Date.parse(s);
  };
  const periodSnaps = await getAllChunked(fs, periodIds.map((p) => orgRow(fs, orgId, 'fiscal_periods', p)));
  const periodExists = new Map(periodSnaps.map((s) => [s.id, s.exists]));

  for (const period of periodIds) {
    const plan = new WritePlan();
    const current = (await orgCollection(fs, orgId, 'metric_current').where('period_id', '==', period).get()).docs;
    for (const c of current) {
      const cascaded = replacedIds.has(String(c.get('snapshot_id')));
      if (cascaded || asOfKeys === null || asOfKeys.includes(String(c.get('metric_key')))) plan.delete(c.ref);
    }

    const mine = snapshots.filter((s) => s.period_id === period && (asOfKeys === null || asOfKeys.includes(String(s.metric_key))));
    if (mine.length > 0) {
      if (!periodExists.get(period)) missingReference('metric_current', 'period_id');
      // The newest earlier run's snapshot of every cell of this period, picked once.
      const earlier = await orgCollection(fs, orgId, 'metric_snapshots').where('period_id', '==', period)
        .select('id', 'calculation_run_id', 'metric_key', 'dimension_type', 'dimension_id', 'dimension_key').get();
      const previous = new Map<string, { id: string; rank: number }>();
      for (const d of earlier.docs) {
        const run = String(d.get('calculation_run_id'));
        if (run === runId || !startedAt.has(run)) continue;
        const r = { period_id: period, ...d.data() };
        const key = cellKey(r);
        const best = previous.get(key);
        const score = rank(run);
        if (!best || score > best.rank) previous.set(key, { id: String(d.get('id') ?? d.id), rank: score });
      }
      for (const s of mine) {
        plan.set(orgRow(fs, orgId, 'metric_current', cellId(s)), {
          organization_id: orgId, period_id: period, metric_key: s.metric_key, dimension_type: s.dimension_type,
          dimension_id: s.dimension_id, dimension_key: s.dimension_key, snapshot_id: s.id,
          calculation_run_id: runId, previous_snapshot_id: previous.get(cellKey(s))?.id ?? null, updated_at: nowIso(),
        });
      }
    }
    await plan.commit(fs);
  }

  // 3. The run's own record of the chunk, last.
  await runTx(db, async (tx) => {
    const ref = orgRow(fs, orgId, 'calculation_runs', runId);
    const run = await tx.get(ref);
    const progress = (run.get('progress') as Row | null) ?? {};
    const chunks = (run.get('chunks') as unknown[] | null) ?? [];
    tx.update(ref, {
      chunks: [...chunks, { cursor, aggregated_at: new Date(aggregatedAt).toISOString(), finished_at: nowIso() }],
      progress: {
        periods_done: (intOrNull(progress.periods_done) ?? 0) + periodIds.length,
        periods_total: intOrNull(progress.periods_total) ?? 0,
      },
      updated_at: nowIso(),
    });
  });

  return { written: snapshots.length, periods: periodIds.length === 0 ? null : periodIds.length };
}

// ── finish_calculation_run ───────────────────────────────────────────────────────────────────────

async function finishCalculationRun(db: Db, args: Record<string, unknown>): Promise<unknown> {
  requireServer(db);
  const orgId = arg.req(args, 'p_org');
  requireScope(db, orgId);
  const fs = db.fs;
  const runId = uuidOrNull(arg.req(args, 'p_run'))!;
  const status = arg.req(args, 'p_status');
  const runRef = orgRow(fs, orgId, 'calculation_runs', runId);
  const run = await runRef.get();
  const started = run.exists ? (run.get('started_at') as string | null) : null;
  if (!started) raise.notFound();

  if (status === 'failed') {
    /*
     * Capture first, delete second. A reader must never be left with this month from a failed run
     * and last month from the previous one — nor with no pointer at all: each restored cell is one
     * write over this run's pointer.
     */
    const plan = new WritePlan();
    const mine = (await orgCollection(fs, orgId, 'metric_current').where('calculation_run_id', '==', runId).get()).docs;
    const previousIds = mine.map((c) => c.get('previous_snapshot_id') as string | null).filter((id): id is string => !!id);
    const prevSnaps = await getAllChunked(fs, [...new Set(previousIds)].map((id) => orgRow(fs, orgId, 'metric_snapshots', id)));
    const prevById = new Map(prevSnaps.filter((s) => s.exists).map((s) => [s.id, s.data()!]));
    for (const c of mine) plan.delete(c.ref);
    const restoreTargets: Row[] = [];
    for (const c of mine) {
      const prev = prevById.get(String(c.get('previous_snapshot_id')));
      if (prev) restoreTargets.push(prev);
    }
    // `on conflict do nothing`: a cell already pointed at by another run is left as it is.
    const targetRefs = restoreTargets.map((p) => orgRow(fs, orgId, 'metric_current', cellId(p)));
    const targetSnaps = await getAllChunked(fs, targetRefs);
    restoreTargets.forEach((p, i) => {
      const ref = targetRefs[i]!;
      const taken = targetSnaps[i]!.exists && !plan.has(ref);
      if (taken || plan.isSet(ref)) return;
      plan.set(ref, {
        organization_id: orgId, period_id: p.period_id, metric_key: p.metric_key, dimension_type: p.dimension_type,
        dimension_id: p.dimension_id ?? null, dimension_key: p.dimension_key ?? null, snapshot_id: p.id,
        calculation_run_id: p.calculation_run_id, previous_snapshot_id: null, updated_at: nowIso(),
      });
    });

    const health = (await orgCollection(fs, orgId, 'health_current').where('calculation_run_id', '==', runId).get()).docs;
    const prevScoreIds = health.map((h) => h.get('previous_health_score_id') as string | null).filter((id): id is string => !!id);
    const prevScores = await getAllChunked(fs, [...new Set(prevScoreIds)].map((id) => orgRow(fs, orgId, 'health_scores', id)));
    const scoreById = new Map(prevScores.filter((s) => s.exists).map((s) => [s.id, s.data()!]));
    for (const h of health) {
      const prev = scoreById.get(String(h.get('previous_health_score_id')));
      if (prev) {
        plan.set(h.ref, {
          organization_id: orgId, period_id: h.get('period_id'), health_score_id: prev.id,
          calculation_run_id: prev.calculation_run_id, previous_health_score_id: null, updated_at: nowIso(),
        });
      } else {
        plan.delete(h.ref);
      }
    }
    await plan.commit(fs);
  }

  const finished = new Date();
  await runRef.update({
    status,
    finished_at: nowIso(finished),
    duration_ms: Math.round(finished.getTime() - Date.parse(started)),
    stats: jsonb(args.p_stats ?? {}) ?? {},
    error: jsonb(args.p_error ?? null),
    failure_reason: status === 'failed' ? 'error' : null,
    updated_at: nowIso(finished),
  });
  return runId;
}

// ── set_period_completeness ──────────────────────────────────────────────────────────────────────

async function setPeriodCompleteness(db: Db, args: Record<string, unknown>): Promise<unknown> {
  requireServer(db);
  const orgId = arg.req(args, 'p_org');
  requireScope(db, orgId);
  const fs = db.fs;
  const periods = (arg.arr<unknown>(args, 'p_periods') ?? []).map((p) => uuidOrNull(p));
  const complete = arg.arr<unknown>(args, 'p_complete') ?? [];

  return runTx(db, async (tx) => {
    const refs = periods.map((p) => (p ? orgRow(fs, orgId, 'fiscal_periods', p) : null));
    const snaps = await Promise.all(refs.map((r) => (r ? tx.get(r) : Promise.resolve(null))));
    const now = nowIso();
    periods.forEach((p, i) => {
      const flag = complete[i] === undefined || complete[i] === null ? null : Boolean(complete[i]);
      const snap = snaps[i];
      if (snap?.exists && snap.get('is_complete') !== flag) {
        if (flag === null) raise.invalid('null value in column "is_complete" of relation "fiscal_periods" violates not-null constraint');
      }
    });
    periods.forEach((p, i) => {
      const flag = complete[i] === undefined || complete[i] === null ? null : Boolean(complete[i]);
      const snap = snaps[i];
      if (snap?.exists && snap.get('is_complete') !== flag) tx.update(snap.ref, { is_complete: flag, updated_at: now });
      // FU-14: an incomplete period has no Health score shown; its `health_scores` row stays.
      if (p && flag !== true) tx.delete(orgRow(fs, orgId, 'health_current', p));
    });
    return periods.length;
  });
}

// ── finish_health ────────────────────────────────────────────────────────────────────────────────

async function finishHealth(db: Db, args: Record<string, unknown>): Promise<unknown> {
  requireServer(db);
  const orgId = arg.req(args, 'p_org');
  requireScope(db, orgId);
  const fs = db.fs;
  const runId = uuidOrNull(arg.req(args, 'p_run'))!;
  const periodIds = uuidArray(args, 'p_period_ids');
  const scores = (arg.arr<Row>(args, 'p_scores') ?? []).map((s) => s ?? {});

  return runTx(db, async (tx) => {
    if (!(await runningRun(fs, orgId, runId, tx))) raise.notFound();

    // ADR-030.4: no score for an incomplete period.
    const scorePeriods = scores.map((s) => uuidOrNull(s.period_id));
    const periodRefs = [...new Set(scorePeriods.filter((p): p is string => !!p))].map((p) => orgRow(fs, orgId, 'fiscal_periods', p));
    const periodSnaps = await getAllChunked(fs, periodRefs, tx);
    if (periodSnaps.some((s) => s.exists && s.get('is_complete') !== true)) {
      raise.conflict('a health score was offered for an incomplete period (ADR-030.4)');
    }
    if (periodSnaps.some((s) => !s.exists) || scorePeriods.some((p) => p === null)) {
      missingReference('health_scores', 'period_id');
    }

    // Idempotent retry of this run's own chunk (ADR-051.4): its scores for these periods go first.
    const replaced = await rowsWhereIn(fs, orgId, 'health_scores', [['calculation_run_id', runId]], 'period_id', periodIds, tx);
    const replacedIds = new Set(replaced.map((r) => String(r.id)));
    const guardOf = (period: unknown) => uniqueGuard(fs, { orgId }, 'health_scores_run_period_unique', [period as string, runId]);
    const claims = await Promise.all(scorePeriods.map((p) => guardOf(p).read(tx)));

    const pointerPeriods = [...new Set([...periodIds, ...replaced.map((r) => String(r.period_id))])];
    const pointerSnaps = await getAllChunked(fs, pointerPeriods.map((p) => orgRow(fs, orgId, 'health_current', p)), tx);
    const pointers = new Map(pointerSnaps.filter((s) => s.exists).map((s) => [s.id, s.data()!]));
    const forgetting = replacedIds.size === 0 ? [] : await rowsWhereIn(
      fs, orgId, 'health_current', [], 'previous_health_score_id', [...replacedIds], tx);

    // ── writes (one plan, so no document is written twice) ──
    const now = nowIso();
    const plan = new WritePlan();
    for (const r of replaced) {
      plan.delete(orgRow(fs, orgId, 'health_scores', String(r.id)));
      plan.delete(guardOf(r.period_id).ref);
    }
    /*
     * The foreign keys' cascades: a pointer AT a deleted score goes (health_current_score_fk ON
     * DELETE CASCADE); one naming it as its previous forgets it (health_current_previous_fk SET NULL).
     */
    for (const p of forgetting) {
      if (!replacedIds.has(String(p.health_score_id))) {
        plan.update(orgRow(fs, orgId, 'health_current', String(p.period_id)), { previous_health_score_id: null });
      }
    }
    for (const [period, p] of [...pointers.entries()]) {
      if (replacedIds.has(String(p.health_score_id))) {
        pointers.delete(period);
        plan.delete(orgRow(fs, orgId, 'health_current', period));
      } else if (replacedIds.has(String(p.previous_health_score_id))) {
        p.previous_health_score_id = null;
      }
    }

    const written: Array<{ id: string; period: string }> = [];
    scores.forEach((s, i) => {
      const period = scorePeriods[i]!;
      const owner = claims[i]!.owner;
      if (written.some((w) => w.period === period) || (owner && !replacedIds.has(owner))) {
        raise.conflict('duplicate key value violates unique constraint "health_scores_run_period_unique"');
      }
      const id = newId();
      plan.set(guardOf(period).ref, { owner_id: id, constraint: 'health_scores_run_period_unique', created_at: now });
      plan.set(orgRow(fs, orgId, 'health_scores', id), {
        id, organization_id: orgId, calculation_run_id: runId, period_id: period,
        score: intOrNull(s.score), dimensions_used: intOrNull(s.dimensions_used),
        dimensions_total: intOrNull(s.dimensions_total), breakdown: 'breakdown' in s ? jsonb(s.breakdown) : [],
        config_version: textOrNull(s.config_version), created_at: now,
      });
      written.push({ id, period });
    });

    // Repoint; the previous pointer is captured in the same write that replaces it (ADR-051.3).
    for (const w of written) {
      if (!periodIds.includes(w.period)) continue;
      const existing = pointers.get(w.period);
      plan.set(orgRow(fs, orgId, 'health_current', w.period), {
        organization_id: orgId, period_id: w.period, health_score_id: w.id, calculation_run_id: runId,
        previous_health_score_id: existing
          ? (existing.calculation_run_id !== runId ? existing.health_score_id : (existing.previous_health_score_id ?? null))
          : null,
        updated_at: now,
      });
    }
    plan.applyTo(tx);

    // §8.6: no orphan claims — a score with nothing behind it gets no bundle rather than an empty one.
    scores.forEach((s, i) => {
      const evidence = Array.isArray(s.evidence) ? (s.evidence as Row[]) : [];
      if (evidence.length === 0) return;
      writeBundle(tx, fs, {
        orgId, kind: 'health_score', originTable: 'health_scores', originId: written[i]!.id, calculationRunId: runId, createdBy: null,
      }, evidence.map((item): ItemInput => ({
        item_type: String(item.item_type), ref_id: uuidOrNull(item.ref_id), label: String(item.label ?? ''),
        assurance_level: String(item.assurance_level),
      })));
    });
    return written.length;
  });
}

// ── build_metric_bundle_as ───────────────────────────────────────────────────────────────────────

/** jsonb equality: deep, key order irrelevant. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const obj = value as Row;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`;
}

/** `(d - 'order') || {filters: coalesce(d -> 'filters', '{}')}`. */
function descriptorShape(d: unknown): string {
  const obj = d && typeof d === 'object' && !Array.isArray(d) ? { ...(d as Row) } : {};
  delete obj.order;
  obj.filters = obj.filters ?? {};
  return canonical(obj);
}

const METRIC_ITEM_TYPES = new Set(['metric_snapshot', 'calculation_run', 'query', 'counterparty', 'account']);

async function buildMetricBundleAs(db: Db, args: Record<string, unknown>): Promise<unknown> {
  requireServer(db);
  // A Firebase Auth uid, not a uuid.
  const actor = arg.str(args, 'p_actor');
  if (!actor) raise.denied('an actor is required');
  const fs = db.fs;
  const snapshotId = uuidOrNull(arg.req(args, 'p_snapshot'))!;

  const found = await acrossOrgs(fs, 'metric_snapshots').where('id', '==', snapshotId).limit(1).get();
  const root = found.empty ? null : found.docs[0]!.data();
  const orgId = root ? String(root.organization_id) : null;
  // An actor with no standing learns nothing, not even that the snapshot exists (SECURITY_MODEL.md §14).
  if (!root || !orgId || !(await hasPermissionOf(fs, actor, orgId, 'financials.view'))) raise.notFound();
  const runId = (root.calculation_run_id as string | null) ?? null;
  const dimensionId = (root.dimension_id as string | null) ?? null;

  // The snapshot's own evidence tree (ADR-034): bounded in depth and cycle-checked. Snapshots are
  // append-only, so the walk can run before the transaction.
  const treeIds: string[] = [];
  const leaves: unknown[] = [];
  let frontier: Array<{ row: DocumentData; depth: number; path: string[] }> = [{ row: root, depth: 0, path: [snapshotId] }];
  while (frontier.length > 0) {
    const next: typeof frontier = [];
    for (const node of frontier) {
      treeIds.push(String(node.row.id));
      const q = (node.row.evidence_query ?? null) as Row | null;
      if (q?.kind === 'leaf') leaves.push(q.descriptor ?? null);
      if (q?.kind === 'difference' && Array.isArray(q.terms)) {
        for (const term of q.terms as Row[]) if (term?.descriptor !== null && term?.descriptor !== undefined) leaves.push(term.descriptor);
      }
      if (q?.kind === 'derived' && node.depth < 32 && Array.isArray(q.components)) {
        const ids = (q.components as Row[]).map((c) => c?.snapshot_id).filter((id): id is string => typeof id === 'string');
        const snaps = await getAllChunked(fs, ids.map((id) => orgRow(fs, orgId, 'metric_snapshots', id)));
        for (const s of snaps) {
          if (!s.exists || node.path.includes(s.id)) continue;
          next.push({ row: s.data()!, depth: node.depth + 1, path: [...node.path, s.id] });
        }
      }
    }
    frontier = next;
  }
  const leafShapes = new Set(leaves.map(descriptorShape));

  return runTx(db, async (tx) => {
    // `evidence_bundles_metric_origin_unique`: the guard serialises two first clicks.
    const guard = await uniqueGuard(fs, { orgId }, 'evidence_bundles_metric_origin_unique', ['metric_snapshots', snapshotId]).read(tx);
    if (guard.owner) return guard.owner;
    const prior = await tx.get(orgCollection(fs, orgId, 'evidence_bundles').where('origin_id', '==', snapshotId));
    const existing = prior.docs.find((d) => d.get('kind') === 'metric' && d.get('origin_table') === 'metric_snapshots');
    if (existing) return existing.id;

    const items = arg.arr<Row>(args, 'p_items');
    // §8.6: no orphan claims. An empty bundle is never created.
    if (!items || items.length === 0) raise.invalid('a metric bundle needs at least one item');

    const prepared: ItemInput[] = items.map((raw) => {
      const item = raw ?? {};
      const type = String(item.item_type);
      const ref = uuidOrNull(item.ref_id);
      const desc = item.query_descriptor === null || item.query_descriptor === undefined ? null : jsonb(item.query_descriptor);
      if (!METRIC_ITEM_TYPES.has(type)) raise.invalid(`${type} is not an item type a metric bundle may carry`);
      if (textOrNull(item.claim) !== null) raise.invalid('a metric bundle carries figures, not claims');
      if (type === 'metric_snapshot' && (ref === null || !treeIds.includes(ref))) {
        raise.invalid(`${ref ?? '<NULL>'} is not a snapshot in this figure's evidence tree`);
      }
      if (type === 'calculation_run' && ref !== runId) raise.invalid(`${ref ?? '<NULL>'} is not the run that produced this figure`);
      if ((type === 'counterparty' || type === 'account') && (dimensionId === null || ref !== dimensionId)) {
        raise.invalid(`${ref ?? '<NULL>'} is not the dimension this figure is about`);
      }
      if (type === 'query') {
        if (desc === null || textOrNull(item.descriptor_hash) === null) raise.invalid('a query item needs a descriptor and its hash');
        if (!leafShapes.has(descriptorShape(desc))) raise.invalid('that descriptor is not a leaf of this figure\'s evidence tree');
      } else if (desc !== null) {
        raise.invalid('only a query item carries a descriptor');
      }
      return {
        item_type: type, ref_id: ref, query_descriptor: desc, descriptor_hash: hexOrNull(item.descriptor_hash ?? null),
        label: String(item.label ?? ''), claim: null, assurance_level: String(item.assurance_level),
      };
    });

    const bundleId = newId();
    const audit = await prepareAudit(db, {
      organizationId: orgId, action: 'evidence.bundle_built', targetTable: 'evidence_bundles', targetId: bundleId,
      before: null, after: { snapshot_id: snapshotId, items: prepared.length }, metadata: {}, actorId: actor,
    }, tx);
    guard.take(tx, bundleId);
    writeBundleAt(tx, fs, bundleId, {
      orgId, kind: 'metric', originTable: 'metric_snapshots', originId: snapshotId, calculationRunId: runId, createdBy: null,
    }, prepared);
    audit.write(tx);
    return bundleId;
  });
}

export const runFunctions: DbFunctions = {
  start_calculation_run: startCalculationRun,
  finish_chunk: finishChunk,
  finish_calculation_run: finishCalculationRun,
  set_period_completeness: setPeriodCompleteness,
  finish_health: finishHealth,
  build_metric_bundle_as: buildMetricBundleAs,
};
