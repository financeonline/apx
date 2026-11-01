import 'server-only';
import type { DocumentData, Query } from 'firebase-admin/firestore';
import { callApi } from '@/core/db';
import { toMotionError } from '@/core/errors';
import type { Permission } from '@/core/permissions';
import { orgRoleOf } from '@/db/app/access';
import { orgRows, orgRowsByIds, readCtx } from '@/db/rls';
import { globalRow, inChunks, orgCollection, type OrgTable } from '@/db/schema';
import { uidOf, type Db } from '@/db/types';
import type { SnapshotRow, PeriodLabel } from '../domain/view-models';

/**
 * Dashboard reads (UX_ARCHITECTURE.md §4; ADR-031.5).
 *
 * **Every figure comes from `metric_current` joined to `metric_snapshots`, and from nowhere else.**
 * The pointer table names the current snapshot per period, metric and dimension; reading the
 * snapshots directly would risk showing a figure from a superseded run, and computing anything here
 * would put a second definition of a metric outside the engine.
 *
 * Reads for a person go through `src/db/rls.ts` (FIRESTORE_DATA_MODEL.md §5), the port of the RLS
 * policies these reads ran under. A suspended organisation still resolves `metric_current` — it is
 * one of the five frozen-Home tables (ADR-044.4) — which is what lets the banner and the frozen
 * figures render rather than an empty page. Since the ADR-172 hardening the frozen Home shows each
 * person the figures their real role showed them before the suspension, never more.
 *
 * A SERVICE handle (a job composing a brief, assessing funding) reads the organisation's collections
 * directly, as the service role read the tables — but only the organisation its scope names, when it
 * has one (ADR-090).
 */

/** The caller's rows of one table: the policy for a person, the whole (scoped) table for the server. */
async function readRows(
  db: Db, orgId: string, table: OrgTable, refine?: (q: Query) => Query, requestId?: string,
): Promise<DocumentData[]> {
  try {
    if (db.actor.kind === 'service') {
      if (db.actor.scope && db.actor.scope !== orgId) return [];
      const base: Query = orgCollection(db.fs, orgId, table);
      const snap = await (refine ? refine(base) : base).get();
      return snap.docs.map((d) => d.data());
    }
    return await orgRows(db, orgId, table, refine);
  } catch (error) {
    throw toMotionError(error, requestId);
  }
}

/**
 * Rows by their own id, read directly (`getAll`) rather than queried — every org table keeps a row
 * under its `id` as the document id (`orgRow`). The caller's access is the same as `orgRows`
 * (`orgRowsByIds` re-applies the table's policy). One batched read instead of a `where('id', 'in')`
 * query per 30 ids: on the emulator, which has no indexes, each such query scans the whole
 * collection, and a Home with a few thousand figure pointers ran hundreds of them at once and
 * exhausted its memory.
 */
async function readRowsByIds(
  db: Db, orgId: string, table: OrgTable, ids: readonly string[], requestId?: string,
): Promise<DocumentData[]> {
  // `orgRowsByIds` treats a service caller as `readRows` does: its own organisation (or unscoped)
  // reads everything, any other reads nothing.
  try {
    return await inChunks([...new Set(ids)].filter(Boolean), 300, (chunk) => orgRowsByIds(db, orgId, table, chunk));
  } catch (error) {
    throw toMotionError(error, requestId);
  }
}

/**
 * `where(field, 'in', values)` in chunks of 30 (Firestore's limit), the results concatenated. A
 * lookup by `id` alone is a direct read (`readRowsByIds`).
 */
async function readRowsIn(
  db: Db, orgId: string, table: OrgTable, field: string, values: readonly string[],
  refine?: (q: Query) => Query, requestId?: string,
): Promise<DocumentData[]> {
  if (field === 'id' && !refine) return readRowsByIds(db, orgId, table, values, requestId);
  return inChunks([...new Set(values)], 30, (chunk) => readRows(db, orgId, table, (q) => {
    const narrowed = q.where(field, 'in', chunk);
    return refine ? refine(narrowed) : narrowed;
  }, requestId));
}

/**
 * The organisation's own row — its name and base currency — for a caller who can reach it. The
 * `organizations_select` policy admitted exactly the organisations in `accessible_org_roles`; a
 * caller who cannot reach this one reads nothing, as before.
 */
export async function loadOrganizationFacts(
  db: Db, orgId: string,
): Promise<{ name: string | null; baseCurrency: string | null } | null> {
  if (db.actor.kind === 'service') {
    if (db.actor.scope && db.actor.scope !== orgId) return null;
  } else if (!(await orgRoleOf(db.fs, uidOf(db), orgId))) {
    return null;
  }
  const snap = await globalRow(db.fs, 'organizations', orgId).get();
  if (!snap.exists) return null;
  return {
    name: (snap.get('name') as string | null | undefined) ?? null,
    baseCurrency: (snap.get('base_currency') as string | null | undefined) ?? null,
  };
}

interface PointerRow {
  metric_key: string;
  period_id: string;
  dimension_type: string;
  dimension_id: string | null;
  dimension_key: string | null;
  snapshot_id: string;
}

/*
 * `components` used to be read from the definer view `metric_snapshot_payloads` (ADR-172 hardening,
 * migration 20261018000033): it carries per-account balances, bank account names and counterparty
 * ids, which a 3rd party reading the overview must not see. The view handed each reader the WHOLE
 * payload when they read the detail behind it (`financials.view`; `customers.view` for a
 * per-customer figure; the same, judged by the underlying role, in a suspended organisation) and a
 * REDACTED one — numbers and dates only, no ids or names — when they read only the overview
 * (`dashboard.view`). The service role got the whole payload. `payloadReader` is that decision.
 */
type PayloadReader = (dimensionType: string, components: unknown) => Record<string, unknown>;

async function payloadReader(db: Db, orgId: string): Promise<PayloadReader> {
  const whole = (c: unknown) => (c && typeof c === 'object' && !Array.isArray(c) ? (c as Record<string, unknown>) : {});
  if (db.actor.kind === 'service') return (_, c) => whole(c);
  const ctx = await readCtx(db, orgId);
  if (!ctx) return (_, c) => redactMetricComponents(c);
  const perm = (p: string) => p as Permission;
  // Every snapshot read here is a CURRENT one, so the view's "is_current and frozen" arms apply.
  const financials = (await ctx.has(perm('financials.view'))) || (await ctx.frozenAny(perm('financials.view')));
  const customers = (await ctx.has(perm('customers.view'))) || (await ctx.frozenAny(perm('customers.view')));
  return (dimensionType, c) => (financials || (dimensionType === 'counterparty' && customers)
    ? whole(c)
    : redactMetricComponents(c));
}

/**
 * `app.redact_metric_components`: keep only keys that do not name ids (`id`, `ids`, `…_id`,
 * `…_ids`) and whose values are numbers, booleans, null, decimal strings or ISO dates.
 */
export function redactMetricComponents(components: unknown): Record<string, unknown> {
  if (!components || typeof components !== 'object' || Array.isArray(components)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(components as Record<string, unknown>)) {
    if (/(^|_)ids?$/.test(key)) continue;
    if (value === null || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
    } else if (typeof value === 'string' && (/^-?[0-9]+(\.[0-9]+)?$/.test(value) || /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value))) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Joins pointer rows to their snapshots (the old `metric_snapshots!inner`): a pointer whose
 * snapshot the caller may not read is dropped, never shown empty.
 */
async function joinSnapshots(
  db: Db, orgId: string, pointers: readonly PointerRow[], requestId?: string,
): Promise<SnapshotRow[]> {
  if (pointers.length === 0) return [];
  const [snapshots, payload] = await Promise.all([
    readRowsIn(db, orgId, 'metric_snapshots', 'id', pointers.map((p) => p.snapshot_id), undefined, requestId),
    payloadReader(db, orgId),
  ]);
  const byId = new Map(snapshots.map((s) => [String(s.id), s]));
  const out: SnapshotRow[] = [];
  for (const row of pointers) {
    const s = byId.get(row.snapshot_id);
    if (!s) continue;
    out.push({
      snapshotId: String(s.id),
      metricKey: row.metric_key,
      periodId: row.period_id,
      dimensionType: row.dimension_type,
      dimensionId: row.dimension_id ?? null,
      dimensionKey: row.dimension_key ?? null,
      // NUMERIC is stored as a decimal string (FIRESTORE_DATA_MODEL.md §3) and stays one.
      value: s.value === null || s.value === undefined ? null : String(s.value),
      unit: s.unit as SnapshotRow['unit'],
      currency: (s.currency as string | null | undefined) ?? null,
      basis: s.basis as SnapshotRow['basis'],
      assurance: s.assurance_level as SnapshotRow['assurance'],
      dataQuality: s.data_quality as SnapshotRow['dataQuality'],
      components: payload(row.dimension_type, s.components),
    });
  }
  return out;
}

/** Every current metric for one period. Home needs most of them. */
export async function loadPeriodSnapshots(
  db: Db, orgId: string, periodId: string, requestId?: string,
): Promise<SnapshotRow[]> {
  const pointers = await readRows(db, orgId, 'metric_current', (q) => q.where('period_id', '==', periodId), requestId);
  return joinSnapshots(db, orgId, pointers as PointerRow[], requestId);
}

/** One metric across several periods, for the trend chart (§4 level 3). */
export async function loadMetricSeries(
  db: Db,
  orgId: string,
  metricKeys: readonly string[],
  periodIds: readonly string[],
  requestId?: string,
): Promise<SnapshotRow[]> {
  if (metricKeys.length === 0 || periodIds.length === 0) return [];
  const keys = new Set(metricKeys);
  // Chunked on the periods; the metric keys and the dimension are filtered here, so the read needs
  // only equality filters (no composite index).
  const pointers = (await readRowsIn(db, orgId, 'metric_current', 'period_id', periodIds,
    (q) => q.where('dimension_type', '==', 'none'), requestId) as PointerRow[])
    .filter((p) => keys.has(p.metric_key));
  return joinSnapshots(db, orgId, pointers, requestId);
}

/** Dimensioned snapshots for a period — spending by category, revenue by customer (§4 level 4). */
export async function loadDimensioned(
  db: Db,
  orgId: string,
  metricKey: string,
  periodIds: readonly string[],
  requestId?: string,
): Promise<SnapshotRow[]> {
  if (periodIds.length === 0) return [];
  const pointers = (await readRowsIn(db, orgId, 'metric_current', 'period_id', periodIds,
    (q) => q.where('metric_key', '==', metricKey), requestId) as PointerRow[])
    .filter((p) => p.dimension_type !== 'none');
  return joinSnapshots(db, orgId, pointers, requestId);
}

/**
 * The organisation's periods, newest first.
 *
 * The period picker offers only months with accepted data, and marks the latest complete one
 * (§5 `PeriodPicker`), so a user cannot select a month the engine has never computed.
 */
export async function loadPeriods(
  db: Db, orgId: string, requestId?: string,
): Promise<PeriodLabel[]> {
  const rows = await readRows(db, orgId, 'fiscal_periods', (q) => q.orderBy('period_start', 'desc'), requestId);
  return rows.map((r) => ({
    id: r.id as string,
    label: r.label as string,
    periodStart: r.period_start as string,
    periodEnd: r.period_end as string,
    isComplete: Boolean(r.is_complete),
  }));
}

/** Periods that actually carry a computed figure, so the picker never offers an empty month. */
export async function loadPeriodsWithData(
  db: Db, orgId: string, requestId?: string,
): Promise<Set<string>> {
  /*
   * A period has data when a figure has a VALUE, not merely when a pointer exists.
   *
   * A run over an organisation whose records were all rolled back still writes a full set of
   * snapshots — every one of them NULL with a reason. Counting pointers made Home treat that as
   * "ready" and show six dashed cards; the honest state is the first-run one, which asks for a file
   * (ADR-058.8).
   */
  const pointers = await readRows(db, orgId, 'metric_current', undefined, requestId) as PointerRow[];
  const snapshots = await readRowsIn(db, orgId, 'metric_snapshots', 'id', pointers.map((p) => p.snapshot_id), undefined, requestId);
  const valued = new Set(snapshots.filter((s) => s.value !== null && s.value !== undefined).map((s) => String(s.id)));
  return new Set(pointers.filter((p) => valued.has(p.snapshot_id)).map((p) => p.period_id));
}

/**
 * Does this organisation hold any figures of its own?
 *
 * "Has data" cannot be answered from `metric_current`: the engine writes a KNOWN ZERO for cash in
 * every period, covered or not, so an organisation whose only import was rolled back still has
 * hundreds of non-null snapshots — all of them zero. Home read that as "ready" and offered a
 * dashboard built on nothing (ADR-058.8).
 *
 * The honest question is whether any accepted record exists. It is asked of `api.has_accepted_records`
 * (ADR-172) rather than by counting the record tables here: those tables are readable only with
 * `financials.view` (or banking/customers), so a 3rd party — who holds the overview and nothing
 * beneath it — counted zero everywhere and was told to upload their first file. The function answers
 * one boolean to anyone with `dashboard.view`, over the same four tables and the same "accepted and
 * not superseded" this used to ask.
 */
export async function hasAcceptedRecords(
  db: Db, orgId: string, requestId?: string,
): Promise<boolean> {
  return (await callApi<boolean>(db, 'has_accepted_records', { p_org: orgId }, requestId)) === true;
}

/** Whether a recalculation is in flight, for the "Updating your numbers" banner (§7.1, F-D-03). */
export async function isRecalculating(
  db: Db, orgId: string, requestId?: string,
): Promise<boolean> {
  // Through a function, not a table read: `jobs` is readable by platform staff only, and widening
  // that policy to show a banner would expose payloads, worker state and queue depth to a tenant.
  // The function returns one boolean and nothing else (§14.3).
  //
  // It keys off the JOB, never off `calculation_runs.status`: an orphaned run row would otherwise
  // leave the banner up forever (F-D-03).
  return (await callApi<boolean>(db, 'is_recalculating', { p_org: orgId }, requestId)) === true;
}

/**
 * The engine version that produced the figures now on screen: the organisation's latest succeeded
 * run (ADR-124 D-6). Null before the first run.
 */
export async function loadFiguresEngineVersion(
  db: Db, orgId: string, requestId?: string,
): Promise<string | null> {
  const rows = await readRows(db, orgId, 'calculation_runs', (q) => q
    .where('status', '==', 'succeeded')
    .orderBy('finished_at', 'desc')
    .limit(1), requestId);
  return (rows[0]?.engine_version as string | undefined) ?? null;
}

/** The last time any data was committed, for the freshness line (§4 level 1). */
export async function loadLastDataDate(
  db: Db, orgId: string, requestId?: string,
): Promise<string | null> {
  const rows = await readRows(db, orgId, 'import_batches', (q) => q
    .where('status', '==', 'committed')
    .orderBy('committed_at', 'desc')
    .limit(1), requestId);
  return (rows[0]?.committed_at as string | undefined) ?? null;
}

export interface PendingBatch {
  readonly id: string;
  readonly filename: string;
  readonly rowCount: number;
  readonly issueCount: number;
}

/**
 * A batch waiting for review (§6 "Home, data uploaded but not yet committed").
 *
 * Home must distinguish "you have not added anything" from "you added something and it is waiting
 * for you", because the two need completely different sentences. Requires `imports.review`, so a
 * client role simply sees the first-run state.
 */
export async function loadPendingBatch(
  db: Db, orgId: string, requestId?: string,
): Promise<PendingBatch | null> {
  const batches = await readRows(db, orgId, 'import_batches', (q) => q
    .where('status', '==', 'awaiting_review')
    .orderBy('created_at', 'desc'), requestId);
  // `source_documents!inner`: the newest awaiting batch that has a document the caller can read.
  for (const row of batches) {
    const documentId = row.source_document_id as string | null | undefined;
    if (!documentId) continue;
    const [document] = await readRows(db, orgId, 'source_documents',
      (q) => q.where('id', '==', documentId).limit(1), requestId);
    if (!document) continue;
    const counts = (row.row_counts ?? {}) as Record<string, number>;
    return {
      id: row.id as string,
      filename: (document.original_filename as string | undefined) ?? 'your file',
      rowCount: counts.total ?? 0,
      issueCount: (counts.error ?? 0) + (counts.warning ?? 0) + (counts.duplicate ?? 0),
    };
  }
  return null;
}
