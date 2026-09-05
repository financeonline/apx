import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { toMotionError } from '@/core/errors';
import type {
  MetricObservation, RecordObservation, RecurringGroupObservation,
} from '@/modules/alerts';
import type { DimensionBreakdown, HealthBand } from '../domain/types';

/**
 * Health reads and writes (FINANCIAL_ENGINE.md §7; DATABASE_ARCHITECTURE.md §6).
 *
 * The score is read through `health_current` joined to `health_scores`, exactly as every figure is
 * read through `metric_current` — a period whose score is being recomputed never shows two, and a
 * failed run's score is never the one on screen.
 *
 * The condition inputs (records, recurring groups) are read at the SAME instant the chunk pinned, so
 * a score and the metrics beside it describe the same set of rows. Reading them "now" would let a
 * transaction that arrived mid-run count towards a score computed from figures that predate it.
 */

function unwrap<T>(data: T[] | null, error: unknown, requestId?: string): T[] {
  if (error) throw toMotionError(error, requestId);
  return data ?? [];
}

// ---------------------------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------------------------

interface CurrentRow {
  metric_key: string;
  period_id: string;
  dimension_type: MetricObservation['dimensionType'];
  dimension_id: string | null;
  dimension_key: string | null;
  metric_snapshots: {
    id: string;
    value: string | null;
    unit: MetricObservation['unit'];
    basis: MetricObservation['basis'];
    assurance_level: MetricObservation['assurance'];
    data_quality: MetricObservation['dataQuality'];
    components: Record<string, unknown> | null;
  } | null;
}

const SNAPSHOT_SELECT = `
  metric_key, period_id, dimension_type, dimension_id, dimension_key,
  metric_snapshots!inner (
    id, value, unit, basis, assurance_level, data_quality, components
  )`;

/**
 * The shape `newCounterpartyIdsIn` needs — a subset of `RecordObservation`, named so the service
 * does not have to depend on the whole record type to walk a list of ids.
 */
export type RecordObservationLike = Pick<RecordObservation, 'counterpartyId' | 'periodId'>;

/** Every current snapshot for a set of periods — the period being scored and its lookback. */
export async function loadObservations(
  db: SupabaseClient, orgId: string, periodIds: readonly string[], requestId?: string,
): Promise<MetricObservation[]> {
  if (periodIds.length === 0) return [];
  const { data, error } = await db
    .from('metric_current')
    .select(SNAPSHOT_SELECT)
    .eq('organization_id', orgId)
    .in('period_id', [...periodIds]);

  return unwrap(data as unknown as CurrentRow[] | null, error, requestId)
    .flatMap((row) => {
      const snapshot = row.metric_snapshots;
      if (!snapshot) return [];
      return [{
        snapshotId: snapshot.id,
        periodId: row.period_id,
        metricKey: row.metric_key,
        dimensionType: row.dimension_type,
        dimensionId: row.dimension_id,
        dimensionKey: row.dimension_key,
        value: snapshot.value === null ? null : String(snapshot.value),
        unit: snapshot.unit,
        basis: snapshot.basis,
        assurance: snapshot.assurance_level,
        components: snapshot.components ?? {},
        dataQuality: snapshot.data_quality,
      } satisfies MetricObservation];
    });
}

interface BankRow {
  id: string;
  period_id: string;
  transaction_date: string;
  amount: string;
  description_normalized: string | null;
  counterparty_id: string | null;
  bank_account_id: string;
  dedupe_hash: string | null;
  duplicate_reviewed: boolean | null;
  is_transfer: boolean;
  recurring_group_id: string | null;
}

/**
 * Accepted, un-superseded bank transactions for a set of periods.
 *
 * `created_at <= aggregatedAt` pins the read to the instant the chunk aggregated (§2.4), so the
 * condition rules see exactly the rows the metrics were computed from.
 */
export async function loadBankRecords(
  db: SupabaseClient, orgId: string, periodIds: readonly string[], aggregatedAt: string,
  requestId?: string,
): Promise<RecordObservation[]> {
  if (periodIds.length === 0) return [];
  const { data, error } = await db
    .from('bank_transactions')
    .select(`id, period_id, transaction_date, amount, description_normalized, counterparty_id,
             bank_account_id, dedupe_hash, duplicate_reviewed, is_transfer, recurring_group_id`)
    .eq('organization_id', orgId)
    .in('period_id', [...periodIds])
    .eq('record_status', 'accepted')
    .is('superseded_by', null)
    .lte('created_at', aggregatedAt);

  return unwrap(data as unknown as BankRow[] | null, error, requestId).map((row) => ({
    id: row.id,
    table: 'bank_transactions' as const,
    periodId: row.period_id,
    date: row.transaction_date,
    amount: String(row.amount),
    descriptionNormalized: row.description_normalized,
    counterpartyId: row.counterparty_id,
    bankAccountId: row.bank_account_id,
    dedupeHash: row.dedupe_hash,
    duplicateReviewed: row.duplicate_reviewed === true,
    isTransfer: row.is_transfer,
    recurringGroupId: row.recurring_group_id,
  }));
}

interface GroupRow {
  id: string;
  group_key: string;
  direction: 'inflow' | 'outflow';
  signature: string;
  status: 'active' | 'changed' | 'stopped';
  occurrences: number;
  expected_amount: string;
  last_amount: string;
  amount_tolerance_ratio: string;
  last_seen: string;
  cadence: string;
  next_expected: string | null;
}

export async function loadRecurringGroups(
  db: SupabaseClient, orgId: string, requestId?: string,
): Promise<RecurringGroupObservation[]> {
  const { data, error } = await db
    .from('recurring_payment_groups')
    .select(`id, group_key, direction, signature, status, occurrences, expected_amount,
             last_amount, amount_tolerance_ratio, last_seen, cadence, next_expected`)
    .eq('organization_id', orgId);

  return unwrap(data as unknown as GroupRow[] | null, error, requestId).map((row) => ({
    id: row.id,
    groupKey: row.group_key,
    direction: row.direction,
    signature: row.signature,
    status: row.status,
    occurrences: row.occurrences,
    expectedAmount: String(row.expected_amount),
    lastAmount: String(row.last_amount),
    amountToleranceRatio: String(row.amount_tolerance_ratio),
    lastSeen: row.last_seen,
    cadence: row.cadence,
    nextExpected: row.next_expected,
  }));
}

// ---------------------------------------------------------------------------------------------
// The score itself
// ---------------------------------------------------------------------------------------------

export interface StoredHealthScore {
  readonly periodId: string;
  readonly score: number | null;
  readonly band: HealthBand | null;
  readonly dimensionsUsed: number;
  readonly dimensionsTotal: number;
  readonly configVersion: string;
  readonly breakdown: readonly DimensionBreakdown[];
  readonly updatedAt: string;
}

interface HealthCurrentRow {
  period_id: string;
  updated_at: string;
  health_scores: {
    score: number | null;
    dimensions_used: number;
    dimensions_total: number;
    config_version: string;
    breakdown: DimensionBreakdown[] | null;
  } | null;
}

const HEALTH_SELECT = `
  period_id, updated_at,
  health_scores!health_current_score_fk!inner (
    score, dimensions_used, dimensions_total, config_version, breakdown
  )`;

function toStored(row: HealthCurrentRow, band: (score: number | null) => HealthBand | null): StoredHealthScore | null {
  const stored = row.health_scores;
  if (!stored) return null;
  return {
    periodId: row.period_id,
    score: stored.score,
    band: band(stored.score),
    dimensionsUsed: stored.dimensions_used,
    dimensionsTotal: stored.dimensions_total,
    configVersion: stored.config_version,
    breakdown: stored.breakdown ?? [],
    updatedAt: row.updated_at,
  };
}

/** The current score for one period, or NULL when none has been written (an incomplete month). */
export async function loadHealthScore(
  db: SupabaseClient, orgId: string, periodId: string,
  band: (score: number | null) => HealthBand | null, requestId?: string,
): Promise<StoredHealthScore | null> {
  const { data, error } = await db
    .from('health_current')
    .select(HEALTH_SELECT)
    .eq('organization_id', orgId)
    .eq('period_id', periodId)
    .limit(1);

  const rows = unwrap(data as unknown as HealthCurrentRow[] | null, error, requestId);
  const row = rows[0];
  return row === undefined ? null : toStored(row, band);
}

/** The score history, for the monthly chart. Ordered by the caller's period list, not by id. */
export async function loadHealthHistory(
  db: SupabaseClient, orgId: string, periodIds: readonly string[],
  band: (score: number | null) => HealthBand | null, requestId?: string,
): Promise<StoredHealthScore[]> {
  if (periodIds.length === 0) return [];
  const { data, error } = await db
    .from('health_current')
    .select(HEALTH_SELECT)
    .eq('organization_id', orgId)
    .in('period_id', [...periodIds]);

  return unwrap(data as unknown as HealthCurrentRow[] | null, error, requestId)
    .flatMap((row) => {
      const stored = toStored(row, band);
      return stored === null ? [] : [stored];
    });
}

interface PortfolioRow {
  organization_id: string;
  period_id: string;
  health_scores: { score: number | null; dimensions_used: number; dimensions_total: number } | null;
}

interface PortfolioPeriodRow {
  id: string;
  organization_id: string;
  period_start: string;
  is_complete: boolean;
}

export interface PortfolioScoreRow {
  readonly organizationId: string;
  readonly periodId: string;
  readonly periodStart: string;
  readonly score: number | null;
  readonly dimensionsUsed: number;
  readonly dimensionsTotal: number;
}

/**
 * The latest complete month's score for every organisation the caller can see (UX §9, ADR-038.13).
 *
 * TWO statements over the whole accessible set, never one per card: "forty clients load as fast as
 * four" is a requirement, and a loop over organisations would make the page slower for exactly the
 * advisers the page exists for. RLS decides which rows come back, so nothing here filters by
 * organisation — the caller's grants do.
 */
export async function loadPortfolioScores(
  db: SupabaseClient, requestId?: string,
): Promise<PortfolioScoreRow[]> {
  const [scores, periods] = await Promise.all([
    db.from('health_current').select(
      `organization_id, period_id,
       health_scores!health_current_score_fk!inner (score, dimensions_used, dimensions_total)`,
    ),
    db.from('fiscal_periods').select('id, organization_id, period_start, is_complete'),
  ]);

  const periodById = new Map(
    unwrap(periods.data as unknown as PortfolioPeriodRow[] | null, periods.error, requestId)
      .map((row) => [row.id, row]),
  );

  const latest = new Map<string, PortfolioScoreRow>();
  for (const row of unwrap(scores.data as unknown as PortfolioRow[] | null, scores.error, requestId)) {
    const period = periodById.get(row.period_id);
    if (period === undefined || !period.is_complete || !row.health_scores) continue;

    const candidate: PortfolioScoreRow = {
      organizationId: row.organization_id,
      periodId: row.period_id,
      periodStart: period.period_start,
      score: row.health_scores.score,
      dimensionsUsed: row.health_scores.dimensions_used,
      dimensionsTotal: row.health_scores.dimensions_total,
    };
    const held = latest.get(row.organization_id);
    // The most recent complete month wins; a card must never show an older month than the one the
    // organisation's own Home opens on.
    if (held === undefined || candidate.periodStart > held.periodStart) {
      latest.set(row.organization_id, candidate);
    }
  }

  return [...latest.values()];
}
