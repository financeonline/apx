import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { toMotionError } from '@/core/errors';
import type { SnapshotRow, PeriodLabel } from '../domain/view-models';

/**
 * Dashboard reads (UX_ARCHITECTURE.md §4; ADR-031.5).
 *
 * **Every figure comes from `metric_current` joined to `metric_snapshots`, and from nowhere else.**
 * The pointer table names the current snapshot per period, metric and dimension; reading the
 * snapshots directly would risk showing a figure from a superseded run, and computing anything here
 * would put a second definition of a metric outside the engine.
 *
 * Reads run on the caller's client under RLS. A suspended organisation still resolves `metric_current`
 * — it is one of the five frozen-Home tables (ADR-044.4) — which is what lets the banner and the
 * frozen figures render rather than an empty page.
 */

function unwrap<T>(data: T[] | null, error: unknown, requestId?: string): T[] {
  if (error) throw toMotionError(error, requestId);
  return data ?? [];
}

interface CurrentRow {
  metric_key: string;
  period_id: string;
  dimension_type: string;
  dimension_id: string | null;
  dimension_key: string | null;
  snapshot_id: string;
  metric_snapshots: {
    id: string;
    value: string | null;
    unit: SnapshotRow['unit'];
    currency: string | null;
    basis: SnapshotRow['basis'];
    assurance_level: SnapshotRow['assurance'];
    data_quality: SnapshotRow['dataQuality'];
    components: Record<string, unknown>;
  } | null;
}

const SNAPSHOT_SELECT = `
  metric_key, period_id, dimension_type, dimension_id, dimension_key, snapshot_id,
  metric_snapshots!inner (
    id, value, unit, currency, basis, assurance_level, data_quality, components
  )`;

function toSnapshot(row: CurrentRow): SnapshotRow | null {
  const snapshot = row.metric_snapshots;
  if (!snapshot) return null;
  return {
    snapshotId: snapshot.id,
    metricKey: row.metric_key,
    periodId: row.period_id,
    dimensionType: row.dimension_type,
    dimensionId: row.dimension_id,
    dimensionKey: row.dimension_key,
    value: snapshot.value === null ? null : String(snapshot.value),
    unit: snapshot.unit,
    currency: snapshot.currency,
    basis: snapshot.basis,
    assurance: snapshot.assurance_level,
    dataQuality: snapshot.data_quality,
    components: snapshot.components ?? {},
  };
}

/** Every current metric for one period. One round trip; Home needs most of them. */
export async function loadPeriodSnapshots(
  db: SupabaseClient, orgId: string, periodId: string, requestId?: string,
): Promise<SnapshotRow[]> {
  const { data, error } = await db
    .from('metric_current')
    .select(SNAPSHOT_SELECT)
    .eq('organization_id', orgId)
    .eq('period_id', periodId);

  return unwrap(data as unknown as CurrentRow[] | null, error, requestId)
    .map(toSnapshot)
    .filter((s): s is SnapshotRow => s !== null);
}

/** One metric across several periods, for the trend chart (§4 level 3). */
export async function loadMetricSeries(
  db: SupabaseClient,
  orgId: string,
  metricKeys: readonly string[],
  periodIds: readonly string[],
  requestId?: string,
): Promise<SnapshotRow[]> {
  if (metricKeys.length === 0 || periodIds.length === 0) return [];

  const { data, error } = await db
    .from('metric_current')
    .select(SNAPSHOT_SELECT)
    .eq('organization_id', orgId)
    .in('metric_key', [...metricKeys])
    .in('period_id', [...periodIds])
    .eq('dimension_type', 'none');

  return unwrap(data as unknown as CurrentRow[] | null, error, requestId)
    .map(toSnapshot)
    .filter((s): s is SnapshotRow => s !== null);
}

/** Dimensioned snapshots for a period — spending by category, revenue by customer (§4 level 4). */
export async function loadDimensioned(
  db: SupabaseClient,
  orgId: string,
  metricKey: string,
  periodIds: readonly string[],
  requestId?: string,
): Promise<SnapshotRow[]> {
  if (periodIds.length === 0) return [];

  const { data, error } = await db
    .from('metric_current')
    .select(SNAPSHOT_SELECT)
    .eq('organization_id', orgId)
    .eq('metric_key', metricKey)
    .in('period_id', [...periodIds])
    .neq('dimension_type', 'none');

  return unwrap(data as unknown as CurrentRow[] | null, error, requestId)
    .map(toSnapshot)
    .filter((s): s is SnapshotRow => s !== null);
}

/**
 * The organisation's periods, newest first.
 *
 * The period picker offers only months with accepted data, and marks the latest complete one
 * (§5 `PeriodPicker`), so a user cannot select a month the engine has never computed.
 */
export async function loadPeriods(
  db: SupabaseClient, orgId: string, requestId?: string,
): Promise<PeriodLabel[]> {
  const { data, error } = await db
    .from('fiscal_periods')
    .select('id, label, period_start, period_end, is_complete')
    .eq('organization_id', orgId)
    .order('period_start', { ascending: false });

  return unwrap(data, error, requestId).map((r) => ({
    id: r.id as string,
    label: r.label as string,
    periodStart: r.period_start as string,
    periodEnd: r.period_end as string,
    isComplete: Boolean(r.is_complete),
  }));
}

/** Periods that actually carry a computed figure, so the picker never offers an empty month. */
export async function loadPeriodsWithData(
  db: SupabaseClient, orgId: string, requestId?: string,
): Promise<Set<string>> {
  /*
   * A period has data when a figure has a VALUE, not merely when a pointer exists.
   *
   * A run over an organisation whose records were all rolled back still writes a full set of
   * snapshots — every one of them NULL with a reason. Counting pointers made Home treat that as
   * "ready" and show six dashed cards; the honest state is the first-run one, which asks for a file
   * (ADR-058.8).
   */
  const { data, error } = await db
    .from('metric_current')
    .select('period_id, metric_snapshots!inner (value)')
    .eq('organization_id', orgId)
    .not('metric_snapshots.value', 'is', null);

  return new Set(unwrap(data, error, requestId).map((r) => r.period_id as string));
}

/**
 * Does this organisation hold any figures of its own?
 *
 * "Has data" cannot be answered from `metric_current`: the engine writes a KNOWN ZERO for cash in
 * every period, covered or not, so an organisation whose only import was rolled back still has
 * hundreds of non-null snapshots — all of them zero. Home read that as "ready" and offered a
 * dashboard built on nothing (ADR-058.8).
 *
 * The honest question is whether any accepted record exists, and that is what this asks.
 */
export async function hasAcceptedRecords(
  db: SupabaseClient, orgId: string, requestId?: string,
): Promise<boolean> {
  const tables = ['ledger_entries', 'bank_transactions', 'invoices', 'period_balances'] as const;

  for (const table of tables) {
    const { count, error } = await db
      .from(table)
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .eq('record_status', 'accepted')
      .is('superseded_by', null);
    if (error) throw toMotionError(error, requestId);
    if ((count ?? 0) > 0) return true;
  }
  return false;
}

/** Whether a recalculation is in flight, for the "Updating your numbers" banner (§7.1, F-D-03). */
export async function isRecalculating(
  db: SupabaseClient, orgId: string, requestId?: string,
): Promise<boolean> {
  // Through a function, not a table read: `jobs` is readable by platform staff only, and widening
  // that policy to show a banner would expose payloads, worker state and queue depth to a tenant.
  // The function returns one boolean and nothing else (§14.3).
  //
  // It keys off the JOB, never off `calculation_runs.status`: an orphaned run row would otherwise
  // leave the banner up forever (F-D-03).
  const { data, error } = await db.schema('api').rpc('is_recalculating', { p_org: orgId });
  if (error) throw toMotionError(error, requestId);
  return data === true;
}

/** The last time any data was committed, for the freshness line (§4 level 1). */
export async function loadLastDataDate(
  db: SupabaseClient, orgId: string, requestId?: string,
): Promise<string | null> {
  const { data, error } = await db
    .from('import_batches')
    .select('committed_at')
    .eq('organization_id', orgId)
    .eq('status', 'committed')
    .order('committed_at', { ascending: false })
    .limit(1);

  const rows = unwrap(data, error, requestId);
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
  db: SupabaseClient, orgId: string, requestId?: string,
): Promise<PendingBatch | null> {
  const { data, error } = await db
    .from('import_batches')
    .select('id, row_counts, source_documents!inner (original_filename)')
    .eq('organization_id', orgId)
    .eq('status', 'awaiting_review')
    .order('created_at', { ascending: false })
    .limit(1);

  const rows = unwrap(data as unknown as Array<Record<string, unknown>> | null, error, requestId);
  const row = rows[0];
  if (!row) return null;

  const counts = (row.row_counts ?? {}) as Record<string, number>;
  const document = row.source_documents as { original_filename?: string } | null;

  return {
    id: row.id as string,
    filename: document?.original_filename ?? 'your file',
    rowCount: counts.total ?? 0,
    issueCount: (counts.error ?? 0) + (counts.warning ?? 0) + (counts.duplicate ?? 0),
  };
}
