import { metricCellId, newId, nowIso, orgCollection, orgRow } from '@/db/schema';
import { ensurePeriods, periodId } from '@/db/app/shared';
import { fs } from './setup';

/**
 * Engine-output fixtures for Team R's suites (Home, reports, investment): fiscal months, calculation
 * runs, metric snapshots and their `metric_current` pointers, written straight into Firestore in the
 * shapes FIRESTORE_DATA_MODEL.md §3 gives — what a calculation run leaves behind (numeric values as
 * decimal strings, NULL as null, ISO timestamps). They replace the suites' `adminSql` inserts; every
 * assertion still reads through the real services and `src/db/rls.ts`.
 */

/** Makes sure every month from `from` to `to` exists; returns `YYYY-MM` → period id. */
export async function ensureMonths(orgId: string, from: string, to: string): Promise<Map<string, string>> {
  await ensurePeriods(fs(), orgId, from, to);
  const out = new Map<string, string>();
  for (let s = `${from.slice(0, 7)}-01`; s <= `${to.slice(0, 7)}-01`;) {
    out.set(s.slice(0, 7), periodId(orgId, s));
    const y = Number(s.slice(0, 4)); const m = Number(s.slice(5, 7));
    s = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  }
  return out;
}

/** The period id of one month (`YYYY-MM`) — deterministic, so it exists only after `ensureMonths`. */
export const monthId = (orgId: string, ym: string): string => periodId(orgId, `${ym}-01`);

export async function setComplete(orgId: string, period: string, complete: boolean): Promise<void> {
  await orgRow(fs(), orgId, 'fiscal_periods', period).update({ is_complete: complete, updated_at: nowIso() });
}

export interface RunInput {
  readonly periodFrom: string;
  readonly periodTo?: string;
  readonly engineVersion?: string;
  readonly asOf?: string;
  readonly status?: string;
  readonly trigger?: string;
  readonly startedAt?: string | null;
  readonly finishedAt?: string | null;
  readonly jobId?: string | null;
}

export async function writeRun(orgId: string, input: RunInput): Promise<string> {
  const id = newId();
  const now = nowIso();
  const status = input.status ?? 'succeeded';
  await orgRow(fs(), orgId, 'calculation_runs', id).set({
    id, organization_id: orgId, job_id: input.jobId ?? null, trigger: input.trigger ?? 'recalc_manual',
    trigger_ref_id: null, engine_version: input.engineVersion ?? '1.0.0', period_from: input.periodFrom,
    period_to: input.periodTo ?? input.periodFrom, as_of: input.asOf ?? '2026-06-15', as_of_ts: now, status,
    failure_reason: null, stale: false, input_fingerprint: null, chunks: [], progress: {},
    started_at: input.startedAt === undefined ? now : input.startedAt,
    finished_at: input.finishedAt === undefined ? (status === 'succeeded' ? now : null) : input.finishedAt,
    duration_ms: null, error: null, stats: {}, created_at: now, updated_at: now,
  });
  return id;
}

export interface SnapshotInput {
  readonly runId: string;
  readonly periodId: string;
  readonly key: string;
  readonly value: string | null;
  readonly unit?: string;
  readonly currency?: string | null;
  readonly basis?: string;
  readonly assurance?: string;
  readonly quality?: Record<string, unknown>;
  readonly components?: Record<string, unknown>;
  readonly dimensionType?: string;
  readonly dimensionId?: string | null;
  readonly dimensionKey?: string | null;
  readonly evidenceQuery?: unknown;
}

const QUALITY = { completeness: 1, proxy: false, warnings: [], missing: [] };

/** One snapshot; with `point` (default true) its `metric_current` pointer too, unless one exists. */
export async function writeSnapshot(orgId: string, s: SnapshotInput, point: 'first' | 'replace' | 'none' = 'first'): Promise<string> {
  const id = newId();
  const dimensionType = s.dimensionType ?? 'none';
  const dimensionId = s.dimensionId ?? null;
  const dimensionKey = s.dimensionKey ?? null;
  await orgRow(fs(), orgId, 'metric_snapshots', id).set({
    id, organization_id: orgId, calculation_run_id: s.runId, period_id: s.periodId, metric_key: s.key,
    dimension_type: dimensionType, dimension_id: dimensionId, dimension_key: dimensionKey, value: s.value,
    unit: s.unit ?? 'money', currency: s.currency === undefined ? 'GBP' : s.currency, basis: s.basis ?? 'ledger',
    assurance_level: s.assurance ?? 'verified', data_quality: s.quality ?? QUALITY, components: s.components ?? {},
    evidence_query: s.evidenceQuery ?? null, created_at: nowIso(),
  });
  if (point !== 'none') {
    const ref = orgRow(fs(), orgId, 'metric_current', metricCellId({
      period_id: s.periodId, metric_key: s.key, dimension_type: dimensionType, dimension_id: dimensionId,
      dimension_key: dimensionKey,
    }));
    const existing = await ref.get();
    if (!existing.exists || point === 'replace') {
      await ref.set({
        organization_id: orgId, period_id: s.periodId, metric_key: s.key, dimension_type: dimensionType,
        dimension_id: dimensionId, dimension_key: dimensionKey, snapshot_id: id, calculation_run_id: s.runId,
        previous_snapshot_id: existing.exists ? (existing.get('snapshot_id') ?? null) : null, updated_at: nowIso(),
      });
    }
  }
  return id;
}

/** A snapshot in a run of its own, as Home's suites write one figure at a time. */
export async function writeMetric(
  orgId: string, period: string, key: string, value: string | null,
  over: Omit<Partial<SnapshotInput>, 'periodId' | 'key' | 'value'> & { engineVersion?: string } = {},
): Promise<string> {
  const runId = over.runId ?? await writeRun(orgId, { periodFrom: period, engineVersion: over.engineVersion });
  return writeSnapshot(orgId, { ...over, runId, periodId: period, key, value });
}

/** One accepted ledger record, so Home's first-run gate sees an organisation with data. */
export async function seedLedgerEntry(orgId: string, input: {
  accountId: string; period: string; entryDate: string; direction: 'debit' | 'credit'; amount: string;
  id?: string; recordStatus?: string;
}): Promise<string> {
  const id = input.id ?? newId();
  const now = nowIso();
  await orgRow(fs(), orgId, 'ledger_entries', id).set({
    id, organization_id: orgId, entry_date: input.entryDate, period_id: input.period, account_id: input.accountId,
    direction: input.direction, amount: input.amount, currency: 'GBP', description: null, reference: null,
    counterparty_id: null, journal_ref: null, source_document_id: null, import_batch_id: null, import_row_id: null,
    source_ref: null, record_status: input.recordStatus ?? 'accepted', assurance_level: 'verified', dedupe_hash: null,
    duplicate_reviewed: false, is_opening_balance: false, rejected_reason: null, superseded_by: null,
    superseded_at: null, promoted_from_batch_id: null, created_at: now, updated_at: now,
  });
  return id;
}

/** The system account of one standard category (seeded by the chart of accounts). */
export async function systemAccountId(orgId: string, category: string): Promise<string> {
  const snap = await orgCollection(fs(), orgId, 'accounts').where('standard_category', '==', category)
    .where('is_system', '==', true).limit(1).get();
  if (snap.empty) throw new Error(`no system account for ${category}`);
  return snap.docs[0]!.id;
}

/** Deletes every document of these org tables (between tests; never another suite's organisation). */
export async function clearTables(orgId: string, tables: readonly string[]): Promise<void> {
  for (const t of tables) {
    await fs().recursiveDelete(orgCollection(fs(), orgId, t as never));
  }
}

/** The organisation's jobs, removed (jobs are a top-level collection). */
export async function clearJobs(orgId: string): Promise<void> {
  const snap = await fs().collection('jobs').where('organization_id', '==', orgId).get();
  for (const d of snap.docs) await d.ref.delete();
  // The "one queued job per key" guards of the deleted jobs.
  const guards = await fs().collection('_unique').where('owner_id', 'in', snap.docs.length ? snap.docs.map((d) => d.id).slice(0, 30) : ['-']).get();
  for (const g of guards.docs) await g.ref.delete();
}

/** A job document in the queue's shape (`src/db/app/jobs.ts`). */
export async function writeJob(orgId: string | null, input: {
  jobType: string; payload?: Record<string, unknown>; status?: string; idempotencyKey?: string | null;
  requestedBy?: string | null; maxAttempts?: number;
}): Promise<string> {
  const id = newId();
  const now = nowIso();
  await fs().collection('jobs').doc(id).set({
    id, organization_id: orgId, job_type: input.jobType, idempotency_key: input.idempotencyKey ?? null,
    payload: input.payload ?? {}, requested_by: input.requestedBy ?? null, status: input.status ?? 'queued',
    attempts: 0, max_attempts: input.maxAttempts ?? 3, run_after: now, locked_at: null, locked_by: null,
    last_error: null, result: null, finished_at: null, created_at: now, updated_at: now,
  });
  return id;
}
