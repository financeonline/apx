import { periodId } from '@/db/app/shared';
import { globalRow, nowIso, orgCollection, orgRow, uniqueGuard } from '@/db/schema';
import { fs } from '../integration/setup';
import { metricValueText } from './engine-dump';

/**
 * The engine suites' fixture READS, on Firestore (FIRESTORE_DATA_MODEL.md §3, §5): what the
 * PostgreSQL suites asked `adminSql` — a current figure joined to its snapshot and period, an
 * organisation's owner, its latest run. Admin reads, for asserting what the ENGINE wrote; what a
 * person may see is asserted through `clientFor` and the real reads, never through these.
 */

export interface CurrentFigure {
  readonly periodStart: string;
  readonly metricKey: string;
  readonly dimensionType: string;
  readonly dimensionId: string | null;
  readonly dimensionKey: string | null;
  readonly snapshotId: string;
  /** `value::text`: six places, or null. */
  readonly value: string | null;
  readonly basis: string;
  readonly assurance: string;
  readonly dataQuality: Record<string, unknown>;
  readonly evidenceQuery: Record<string, unknown> | null;
}

/**
 * Every current figure of an organisation (`metric_current` ⋈ `metric_snapshots` ⋈ `fiscal_periods`),
 * narrowed by period start, metric keys and dimension: `'none'`, `'dimensioned'` (`<> 'none'`) or any.
 */
export async function currentFigures(org: string, filter: {
  start?: string; keys?: readonly string[]; dimension?: 'none' | 'dimensioned' | 'any';
} = {}): Promise<CurrentFigure[]> {
  const f = fs();
  let q: FirebaseFirestore.Query = orgCollection(f, org, 'metric_current');
  if (filter.start) q = q.where('period_id', '==', periodId(org, filter.start));
  if (filter.keys && filter.keys.length === 1) q = q.where('metric_key', '==', filter.keys[0]);
  if ((filter.dimension ?? 'none') === 'none') q = q.where('dimension_type', '==', 'none');
  const pointers = (await q.get()).docs.map((d) => d.data()).filter((c) =>
    (!filter.keys || filter.keys.includes(String(c.metric_key)))
    && (filter.dimension !== 'dimensioned' || c.dimension_type !== 'none'));
  if (pointers.length === 0) return [];
  const [snaps, periods] = await Promise.all([
    f.getAll(...pointers.map((c) => orgRow(f, org, 'metric_snapshots', String(c.snapshot_id)))),
    orgCollection(f, org, 'fiscal_periods').get(),
  ]);
  const startOf = new Map(periods.docs.map((d) => [d.id, String(d.get('period_start'))]));
  const out: CurrentFigure[] = [];
  pointers.forEach((c, i) => {
    const s = snaps[i];
    const start = startOf.get(String(c.period_id));
    if (!s?.exists || start === undefined) return;
    out.push({
      periodStart: start, metricKey: String(c.metric_key), dimensionType: String(c.dimension_type),
      dimensionId: (c.dimension_id ?? null) as string | null, dimensionKey: (c.dimension_key ?? null) as string | null,
      snapshotId: s.id, value: metricValueText(s.get('value')), basis: String(s.get('basis')),
      assurance: String(s.get('assurance_level')), dataQuality: (s.get('data_quality') ?? {}) as Record<string, unknown>,
      evidenceQuery: (s.get('evidence_query') ?? null) as Record<string, unknown> | null,
    });
  });
  return out;
}

/** One headline figure of a month, or undefined. */
export async function currentFigure(org: string, start: string, key: string): Promise<CurrentFigure | undefined> {
  return (await currentFigures(org, { start, keys: [key] }))[0];
}

/** `fiscal_periods.is_complete::text` of the month starting `start` ('' when there is no such month). */
export async function isComplete(org: string, start: string): Promise<string> {
  const p = await orgRow(fs(), org, 'fiscal_periods', periodId(org, start)).get();
  return p.exists ? String(p.get('is_complete') === true) : '';
}

/** The organisation's owner (the first active owner membership). */
export async function ownerOf(org: string): Promise<string> {
  const m = await orgCollection(fs(), org, 'organization_memberships').where('role', '==', 'owner').limit(1).get();
  return m.empty ? '' : String(m.docs[0]!.get('user_id'));
}

/** Every calculation run of an organisation, newest finish first (nulls last). */
export async function runsOf(org: string, status?: string): Promise<Array<Record<string, unknown>>> {
  let q: FirebaseFirestore.Query = orgCollection(fs(), org, 'calculation_runs');
  if (status) q = q.where('status', '==', status);
  const rows = (await q.get()).docs.map((d) => d.data());
  return rows.sort((a, b) => {
    if (a.finished_at == null) return b.finished_at == null ? 0 : 1;
    if (b.finished_at == null) return -1;
    return String(b.finished_at).localeCompare(String(a.finished_at));
  });
}

/** The engine version of the latest succeeded run ('' when none). */
export async function latestVersion(org: string): Promise<string> {
  return String((await runsOf(org, 'succeeded'))[0]?.engine_version ?? '');
}

/** The id of the queued `calculation.run` of an organisation ('' when none). */
export async function queuedCalculation(org: string): Promise<string> {
  const snap = await fs().collection('jobs').where('organization_id', '==', org)
    .where('job_type', '==', 'calculation.run').where('status', '==', 'queued').get();
  return snap.empty ? '' : snap.docs[0]!.id;
}

/**
 * Plants what an OLDER engine left, for a stale-figure sweep test: every run re-labelled
 * `oldVersion`, one current headline snapshot's value overwritten, and the organisation's queued jobs
 * removed (with their "one queued job per key" guards). Fixture only: snapshots are append-only to
 * the application; this is the state a past engine wrote, not an app write.
 */
export async function plantStale(org: string, input: { oldVersion: string; start: string; key: string; value: string }): Promise<void> {
  const f = fs();
  const runs = await orgCollection(f, org, 'calculation_runs').get();
  const batch = f.batch();
  for (const r of runs.docs) batch.update(r.ref, { engine_version: input.oldVersion, updated_at: nowIso() });
  const figure = await currentFigure(org, input.start, input.key);
  if (figure) batch.update(orgRow(f, org, 'metric_snapshots', figure.snapshotId), { value: input.value });
  await batch.commit();
  await dropQueuedJobs(org);
}

/** Removes an organisation's queued jobs and their "one queued job per key" guards (fixture only). */
export async function dropQueuedJobs(org: string): Promise<void> {
  const f = fs();
  const queued = await f.collection('jobs').where('organization_id', '==', org).where('status', '==', 'queued').get();
  const batch = f.batch();
  for (const j of queued.docs) {
    batch.delete(j.ref);
    const key = j.get('idempotency_key') as string | null;
    if (key) batch.delete(uniqueGuard(f, 'global', 'jobs_idempotency_queued', [String(j.get('job_type')), key]).ref);
  }
  await batch.commit();
}

/** A job document by id (fixture read). */
export async function jobById(id: string): Promise<Record<string, unknown> | null> {
  const s = await globalRow(fs(), 'jobs', id).get();
  return s.exists ? s.data()! : null;
}
