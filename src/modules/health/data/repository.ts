import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { toMotionError } from '@/core/errors';
import type {
  MetricObservation, RecordObservation, RecurringGroupObservation,
} from '@/modules/alerts';
import type { DimensionBreakdown, HealthBand, HealthCommercial, HealthInvoice } from '../domain/types';

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
    evidence_query?: unknown;
    components: Record<string, unknown> | null;
  } | null;
}

const SNAPSHOT_SELECT = `
  metric_key, period_id, dimension_type, dimension_id, dimension_key,
  metric_snapshots!inner (
    id, value, unit, basis, assurance_level, data_quality, components, evidence_query
  )`;

/**
 * The shape `newCounterpartyIdsIn` needs — a subset of `RecordObservation`, named so the service
 * does not have to depend on the whole record type to walk a list of ids.
 */
export type RecordObservationLike = Pick<RecordObservation, 'counterpartyId' | 'periodId'>;

/**
 * PostgREST's `max_rows` (1,000) truncates a response SILENTLY. A window of thirteen to twenty-four
 * months holds far more current snapshots than that — the ADR-120 fixture organisation has 1,848 —
 * so a single read handed the health step and the alert pass an arbitrary subset: a dimension could
 * lose a required metric and be excluded, and a rule could find its input missing, with nothing
 * failing anywhere (the Phase 15 lesson, ADR-114). Paged, ordered on the pointer's own key.
 */
const OBSERVATION_PAGE = 1000;

/**
 * Every current snapshot for a set of periods — the period being scored and its lookback.
 *
 * SERVICE ROLE ONLY (the score run and the alert pass, both inside `withOrgScope`): it selects
 * `components` and `evidence_query`, which `authenticated` cannot select since the ADR-172 hardening
 * (migration 20261018000033). A user-facing reader goes through `metric_snapshot_payloads`.
 */
export async function loadObservations(
  db: SupabaseClient, orgId: string, periodIds: readonly string[], requestId?: string,
): Promise<MetricObservation[]> {
  if (periodIds.length === 0) return [];
  const rows: CurrentRow[] = [];
  for (let from = 0; ; from += OBSERVATION_PAGE) {
    const { data, error } = await db
      .from('metric_current')
      .select(SNAPSHOT_SELECT)
      .eq('organization_id', orgId)
      .in('period_id', [...periodIds])
      .order('period_id').order('metric_key').order('dimension_type')
      .order('dimension_id', { nullsFirst: true }).order('dimension_key', { nullsFirst: true })
      .range(from, from + OBSERVATION_PAGE - 1);
    const page = unwrap(data as unknown as CurrentRow[] | null, error, requestId);
    rows.push(...page);
    if (page.length < OBSERVATION_PAGE) break;
  }

  return rows
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
        evidenceQuery: snapshot.evidence_query ?? null,
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
  counterparty_key: string;
  direction: 'inflow' | 'outflow';
  status: 'active' | 'changed' | 'stopped';
  occurrence_count: number;
  expected_amount: string;
  amount_tolerance_ratio: string;
  last_seen: string;
  cadence: string;
  next_expected: string | null;
}

/**
 * The detected recurring groups (DATABASE_ARCHITECTURE.md §5).
 *
 * Two mappings worth stating, because the rules speak a different vocabulary from the table.
 *
 * `counterparty_key` IS the signature — the doc calls it "normalised description signature" — so it
 * serves as both the group's stable key and the name a sentence renders.
 *
 * `last_amount` does not exist as a column, and inventing one would be a schema change made to suit
 * a sentence. The last amount is a fact already recorded: it is the amount of the group's most
 * recent accepted transaction, read here in one further query rather than stored twice and allowed
 * to drift (ADR-057.3).
 */
export async function loadRecurringGroups(
  db: SupabaseClient, orgId: string, requestId?: string,
): Promise<RecurringGroupObservation[]> {
  const { data, error } = await db
    .from('recurring_payment_groups')
    .select(`id, counterparty_key, direction, status, occurrence_count, expected_amount,
             amount_tolerance_ratio, last_seen, cadence, next_expected`)
    .eq('organization_id', orgId);

  const rows = unwrap(data as unknown as GroupRow[] | null, error, requestId);
  if (rows.length === 0) return [];

  const lastAmounts = await loadLastAmounts(db, orgId, rows.map((row) => row.id), requestId);

  return rows.map((row) => ({
    id: row.id,
    groupKey: row.counterparty_key,
    direction: row.direction,
    signature: row.counterparty_key,
    status: row.status,
    occurrences: row.occurrence_count,
    expectedAmount: String(row.expected_amount),
    // Falls back to the expected amount rather than to zero: a group with no readable transaction
    // has not "changed by its whole value", it simply has nothing newer to compare.
    lastAmount: lastAmounts.get(row.id) ?? String(row.expected_amount),
    amountToleranceRatio: String(row.amount_tolerance_ratio),
    lastSeen: row.last_seen,
    cadence: row.cadence,
    nextExpected: row.next_expected,
  }));
}

/** The most recent accepted transaction amount per group. */
async function loadLastAmounts(
  db: SupabaseClient, orgId: string, groupIds: readonly string[], requestId?: string,
): Promise<Map<string, string>> {
  const { data, error } = await db
    .from('bank_transactions')
    .select('recurring_group_id, amount, transaction_date')
    .eq('organization_id', orgId)
    .in('recurring_group_id', [...groupIds])
    .eq('record_status', 'accepted')
    .is('superseded_by', null)
    .order('transaction_date', { ascending: false });

  const out = new Map<string, string>();
  for (const row of unwrap(data as unknown as Array<{
    recurring_group_id: string | null; amount: string;
  }> | null, error, requestId)) {
    if (row.recurring_group_id === null) continue;
    // Ordered newest first, so the first one seen for a group is the latest.
    if (!out.has(row.recurring_group_id)) out.set(row.recurring_group_id, String(row.amount));
  }
  return out;
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
  /** `health_scores.id` — the origin of this score's evidence bundle (EVIDENCE_MODEL.md §5). */
  readonly scoreId: string;
}

interface HealthCurrentRow {
  period_id: string;
  updated_at: string;
  health_scores: {
    id: string;
    score: number | null;
    dimensions_used: number;
    dimensions_total: number;
    config_version: string;
  } | null;
}

/*
 * `breakdown` is NOT in this select. Since the ADR-172 hardening (migration 20261018000033) the column
 * is not selectable on `health_scores`: its conditions name the bank descriptions (customers,
 * suppliers) a rule counted, and a 3rd party reads the score. It is read from the definer view
 * `health_score_breakdowns`: WHOLE for a `financials.view` reader, REDACTED — the same shape, with
 * every subject, record and snapshot id removed — for a reader of the overview alone. The service role
 * (a job composing a brief) reads it whole.
 */
const HEALTH_SELECT = `
  period_id, updated_at,
  health_scores!health_current_score_fk!inner (
    id, score, dimensions_used, dimensions_total, config_version
  )`;

/** The stored breakdowns, by score id, as the caller may read them (see above). */
async function loadBreakdowns(
  db: SupabaseClient, orgId: string, scoreIds: readonly string[], requestId?: string,
): Promise<ReadonlyMap<string, DimensionBreakdown[]>> {
  const ids = [...new Set(scoreIds)];
  const out = new Map<string, DimensionBreakdown[]>();
  // Ids travel in the URL: a hundred at a time stays far inside any proxy's request-line limit.
  for (let from = 0; from < ids.length; from += 100) {
    const { data, error } = await db
      .from('health_score_breakdowns')
      .select('id, breakdown')
      .eq('organization_id', orgId)
      .in('id', ids.slice(from, from + 100));
    for (const r of unwrap(data as Array<{ id: string; breakdown: DimensionBreakdown[] | null }> | null, error, requestId)) {
      out.set(r.id, r.breakdown ?? []);
    }
  }
  return out;
}

function toStored(
  row: HealthCurrentRow,
  band: (score: number | null) => HealthBand | null,
  breakdowns: ReadonlyMap<string, DimensionBreakdown[]>,
): StoredHealthScore | null {
  const stored = row.health_scores;
  if (!stored) return null;
  return {
    scoreId: stored.id,
    periodId: row.period_id,
    score: stored.score,
    band: band(stored.score),
    dimensionsUsed: stored.dimensions_used,
    dimensionsTotal: stored.dimensions_total,
    configVersion: stored.config_version,
    breakdown: breakdowns.get(stored.id) ?? [],
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
  if (row === undefined) return null;
  const breakdowns = await loadBreakdowns(db, orgId, row.health_scores ? [row.health_scores.id] : [], requestId);
  return toStored(row, band, breakdowns);
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

  const rows = unwrap(data as unknown as HealthCurrentRow[] | null, error, requestId);
  const breakdowns = await loadBreakdowns(
    db, orgId, rows.flatMap((row) => (row.health_scores ? [row.health_scores.id] : [])), requestId,
  );
  return rows.flatMap((row) => {
    const stored = toStored(row, band, breakdowns);
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

/**
 * The label of each period a score was written for.
 *
 * Only ever used to NAME an evidence item (`EVIDENCE_MODEL.md` §2.2) — a label is generated from the
 * object it points at, and "Revenue, Mar 2026" needs the month. Nothing scores on it.
 */
export async function loadPeriodLabels(
  db: SupabaseClient,
  orgId: string,
  periodIds: readonly string[],
): Promise<Map<string, string>> {
  if (periodIds.length === 0) return new Map();
  const { data, error } = await db
    .from('fiscal_periods')
    .select('id, label')
    .eq('organization_id', orgId)
    .in('id', [...periodIds]);
  if (error) throw toMotionError(error);
  return new Map(
    ((data ?? []) as Array<{ id: string; label: string | null }>)
      .filter((row): row is { id: string; label: string } => row.label !== null)
      .map((row) => [row.id, row.label]),
  );
}

/**
 * The bundle a score's evidence lives in (EVIDENCE_MODEL.md §5).
 *
 * Reached through the bundle's `origin_id`, not through a column on `health_scores`: §2.1 is where
 * a bundle records what it is about, and a second pointer back would be a second thing to keep in
 * step. NULL when the score predates the bundle being written, which the panel renders as no link
 * rather than a link to nothing.
 */
export async function loadHealthBundleId(
  db: SupabaseClient, orgId: string, scoreId: string,
): Promise<string | null> {
  const { data, error } = await db
    .from('evidence_bundles')
    .select('id')
    .eq('organization_id', orgId)
    .eq('kind', 'health_score')
    .eq('origin_table', 'health_scores')
    .eq('origin_id', scoreId)
    .maybeSingle();
  if (error) throw toMotionError(error);
  return (data as { id?: string } | null)?.id ?? null;
}

/**
 * health.config.v5 (ADR-147): live invoices issued by `issuedBy`, for funding readiness's overdue
 * shares — the same population the standalone Funding Readiness assessment reads (accepted, not
 * superseded, not void). Paged: an invoice list is not bounded the way a pipeline is.
 */
export async function loadInvoicesForHealth(
  db: SupabaseClient, orgId: string, issuedBy: string, requestId?: string,
): Promise<HealthInvoice[]> {
  const out: HealthInvoice[] = [];
  for (let from = 0; ; from += OBSERVATION_PAGE) {
    const { data, error } = await db.from('invoices')
      .select('id, invoice_type, issue_date, due_date, total_amount, balance_due, paid_date')
      .eq('organization_id', orgId).eq('record_status', 'accepted').is('superseded_by', null).neq('status', 'void')
      .lte('issue_date', issuedBy).order('id').range(from, from + OBSERVATION_PAGE - 1);
    const page = unwrap(data as unknown as Array<Record<string, unknown>> | null, error, requestId);
    for (const r of page) {
      out.push({
        invoiceType: r.invoice_type as HealthInvoice['invoiceType'], issueDate: r.issue_date as string,
        dueDate: (r.due_date as string | null) ?? null, totalAmount: String(r.total_amount),
        balanceDue: String(r.balance_due ?? '0'), paidDate: (r.paid_date as string | null) ?? null,
      });
    }
    if (page.length < OBSERVATION_PAGE) break;
  }
  return out;
}

/**
 * health.config.v5 (ADR-147): the Commercial records marketing efficiency reads — campaign spend for
 * the window's periods and the opportunities, each naming its SURVIVING customer, as the Customers
 * pages read them (ADR-103): `customer_revenue` is keyed by the survivor.
 */
export async function loadCommercialForHealth(
  db: SupabaseClient, orgId: string, periodIds: readonly string[], requestId?: string,
): Promise<HealthCommercial> {
  const [spend, opportunities] = await Promise.all([
    db.from('campaign_spend').select('campaign_id, period_id, amount')
      .eq('organization_id', orgId).in('period_id', [...periodIds]).order('period_id').order('campaign_id'),
    db.from('opportunities')
      .select('id, stage, counterparty_id, campaign_id, won_on, counterparties!opportunities_counterparty_fk(merged_into_id)')
      .eq('organization_id', orgId).eq('stage', 'won').order('id').limit(5000),
  ]);
  const spendRows = unwrap(spend.data as unknown as Array<{ campaign_id: string; period_id: string; amount: unknown }> | null, spend.error, requestId);
  const oppRows = unwrap(opportunities.data as unknown as Array<Record<string, unknown>> | null, opportunities.error, requestId);
  return {
    spend: spendRows.map((r) => ({ campaignId: r.campaign_id, periodId: r.period_id, amount: String(r.amount) })),
    opportunities: oppRows.map((r) => {
      const linked = ([] as Array<{ merged_into_id: string | null }>)
        .concat((r.counterparties ?? []) as Array<{ merged_into_id: string | null }>)[0] ?? null;
      return {
        id: r.id as string, stage: r.stage as HealthCommercial['opportunities'][number]['stage'],
        counterpartyId: linked?.merged_into_id ?? (r.counterparty_id as string | null),
        campaignId: (r.campaign_id as string | null) ?? null, wonOn: (r.won_on as string | null) ?? null,
      };
    }),
  };
}
