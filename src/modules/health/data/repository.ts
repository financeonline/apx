import 'server-only';
import { accessibleOrgRoles } from '@/db/app/access';
import {
  readRows, readRowsIn, readsDetail, redactHealthBreakdown,
} from '@/db/app/engine-reads';
import { uidOf, type Db } from '@/db/types';
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

/** A stored decimal (FIRESTORE_DATA_MODEL.md §3) as the string the domain reads. */
const dec = (v: unknown): string => (v === null || v === undefined ? '0' : String(v));

/** `created_at <= at`, compared as instants (stored ISO strings and a caller's timestamp may differ in form). */
const visibleAt = (createdAt: unknown, at: string): boolean => Date.parse(String(createdAt)) <= Date.parse(at);

// ---------------------------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------------------------

interface CurrentRow {
  metric_key: string;
  period_id: string;
  dimension_type: MetricObservation['dimensionType'];
  dimension_id: string | null;
  dimension_key: string | null;
  snapshot_id: string;
}

interface SnapshotDoc {
  id: string;
  value: string | null;
  unit: MetricObservation['unit'];
  basis: MetricObservation['basis'];
  assurance_level: MetricObservation['assurance'];
  data_quality: MetricObservation['dataQuality'];
  evidence_query?: unknown;
  components: Record<string, unknown> | null;
}

/**
 * The shape `newCounterpartyIdsIn` needs — a subset of `RecordObservation`, named so the service
 * does not have to depend on the whole record type to walk a list of ids.
 */
export type RecordObservationLike = Pick<RecordObservation, 'counterpartyId' | 'periodId'>;

/**
 * PostgREST's `max_rows` (1,000) used to truncate this read SILENTLY — the ADR-120 fixture
 * organisation has 1,848 current snapshots in a window — so a dimension could lose a required metric
 * with nothing failing (ADR-114). Firestore returns every row; the pointer's own key still orders
 * them, so the rules see the same sequence they were written against.
 */
const cmp = (a: string | null, b: string | null): number => {
  if (a === b) return 0;
  if (a === null) return -1; // nulls first, as the paged read ordered them
  if (b === null) return 1;
  return a < b ? -1 : 1;
};

/**
 * Every current snapshot for a set of periods — the period being scored and its lookback.
 *
 * SERVICE ROLE ONLY (the score run and the alert pass, both inside `withOrgScope`): it reads
 * `components` and `evidence_query` whole, which a person reads only through the redaction of
 * `metric_snapshot_payloads` (ADR-172 hardening).
 */
export async function loadObservations(
  db: Db, orgId: string, periodIds: readonly string[], requestId?: string,
): Promise<MetricObservation[]> {
  void requestId;
  if (periodIds.length === 0) return [];
  const pointers = (await readRowsIn(db, orgId, 'metric_current', 'period_id', periodIds)) as CurrentRow[];
  const snapshots = await readRowsIn(db, orgId, 'metric_snapshots', 'id', pointers.map((p) => p.snapshot_id));
  const byId = new Map(snapshots.map((s) => [String(s.id), s as SnapshotDoc]));
  const whole = await readsDetail(db, orgId, 'financials.view');
  pointers.sort((a, b) => cmp(a.period_id, b.period_id) || cmp(a.metric_key, b.metric_key)
    || cmp(a.dimension_type, b.dimension_type) || cmp(a.dimension_id, b.dimension_id)
    || cmp(a.dimension_key, b.dimension_key));

  return pointers.flatMap((row) => {
    const snapshot = byId.get(row.snapshot_id);
    if (!snapshot) return [];
    return [{
      snapshotId: snapshot.id,
      periodId: row.period_id,
      metricKey: row.metric_key,
      dimensionType: row.dimension_type,
      dimensionId: row.dimension_id ?? null,
      dimensionKey: row.dimension_key ?? null,
      value: snapshot.value === null || snapshot.value === undefined ? null : String(snapshot.value),
      unit: snapshot.unit,
      basis: snapshot.basis,
      assurance: snapshot.assurance_level,
      components: (whole ? snapshot.components : null) ?? {},
      dataQuality: snapshot.data_quality,
      evidenceQuery: whole ? (snapshot.evidence_query ?? null) : null,
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
  superseded_by: string | null;
  created_at: string;
}

/**
 * Accepted, un-superseded bank transactions for a set of periods.
 *
 * `created_at <= aggregatedAt` pins the read to the instant the chunk aggregated (§2.4), so the
 * condition rules see exactly the rows the metrics were computed from.
 */
export async function loadBankRecords(
  db: Db, orgId: string, periodIds: readonly string[], aggregatedAt: string,
  requestId?: string,
): Promise<RecordObservation[]> {
  void requestId;
  if (periodIds.length === 0) return [];
  // Equality filters only (no composite index); the instant and supersession are judged here.
  const rows = (await readRowsIn(db, orgId, 'bank_transactions', 'period_id', periodIds,
    (q) => q.where('record_status', '==', 'accepted')) as BankRow[])
    .filter((row) => row.superseded_by === null && visibleAt(row.created_at, aggregatedAt));

  return rows.map((row) => ({
    id: row.id,
    table: 'bank_transactions' as const,
    periodId: row.period_id,
    date: row.transaction_date,
    amount: dec(row.amount),
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
  db: Db, orgId: string, requestId?: string,
): Promise<RecurringGroupObservation[]> {
  const rows = (await readRows(db, orgId, 'recurring_payment_groups')) as GroupRow[];
  if (rows.length === 0) return [];

  const lastAmounts = await loadLastAmounts(db, orgId, rows.map((row) => row.id), requestId);

  return rows.map((row) => ({
    id: row.id,
    groupKey: row.counterparty_key,
    direction: row.direction,
    signature: row.counterparty_key,
    status: row.status,
    occurrences: row.occurrence_count,
    expectedAmount: dec(row.expected_amount),
    // Falls back to the expected amount rather than to zero: a group with no readable transaction
    // has not "changed by its whole value", it simply has nothing newer to compare.
    lastAmount: lastAmounts.get(row.id) ?? dec(row.expected_amount),
    amountToleranceRatio: dec(row.amount_tolerance_ratio),
    lastSeen: row.last_seen,
    cadence: row.cadence,
    nextExpected: row.next_expected,
  }));
}

/** The most recent accepted transaction amount per group. */
async function loadLastAmounts(
  db: Db, orgId: string, groupIds: readonly string[], requestId?: string,
): Promise<Map<string, string>> {
  void requestId;
  const rows = (await readRowsIn(db, orgId, 'bank_transactions', 'recurring_group_id', groupIds,
    (q) => q.where('record_status', '==', 'accepted')))
    .filter((r) => r.superseded_by === null)
    .sort((a, b) => (String(a.transaction_date) < String(b.transaction_date) ? 1 : String(a.transaction_date) > String(b.transaction_date) ? -1 : 0));

  const out = new Map<string, string>();
  for (const row of rows) {
    const group = (row.recurring_group_id as string | null) ?? null;
    if (group === null) continue;
    // Ordered newest first, so the first one seen for a group is the latest.
    if (!out.has(group)) out.set(group, dec(row.amount));
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
  health_score_id: string;
  health_scores: {
    id: string;
    score: number | null;
    dimensions_used: number;
    dimensions_total: number;
    config_version: string;
  } | null;
}

/*
 * `breakdown`'s conditions name the bank descriptions (customers, suppliers) a rule counted, and a
 * 3rd party reads the score (ADR-172 hardening). On PostgreSQL it was read from the definer view
 * `health_score_breakdowns`: WHOLE for a `financials.view` reader (or the same under the underlying
 * role in a suspended organisation), REDACTED — the same shape, with every subject, record and
 * snapshot id removed — for a reader of the overview alone; the service role read it whole. The
 * decision is `readsDetail`, the redaction `redactHealthBreakdown`.
 */

/** The current pointers, joined to their scores (the old `health_scores!inner`). */
async function loadCurrent(db: Db, orgId: string, periodIds: readonly string[]): Promise<{
  rows: HealthCurrentRow[]; breakdowns: ReadonlyMap<string, DimensionBreakdown[]>;
}> {
  const pointers = await readRowsIn(db, orgId, 'health_current', 'period_id', periodIds);
  const scores = await readRowsIn(db, orgId, 'health_scores', 'id', pointers.map((p) => p.health_score_id as string));
  const byId = new Map(scores.map((sc) => [String(sc.id), sc]));
  const whole = await readsDetail(db, orgId, 'financials.view');
  const breakdowns = new Map<string, DimensionBreakdown[]>();
  for (const sc of scores) {
    breakdowns.set(String(sc.id), (whole ? (sc.breakdown ?? []) : redactHealthBreakdown(sc.breakdown)) as DimensionBreakdown[]);
  }
  const rows = pointers.flatMap((p) => {
    const sc = byId.get(String(p.health_score_id));
    if (!sc) return [];
    return [{
      period_id: String(p.period_id), updated_at: String(p.updated_at), health_score_id: String(p.health_score_id),
      health_scores: {
        id: String(sc.id), score: (sc.score as number | null) ?? null, dimensions_used: sc.dimensions_used as number,
        dimensions_total: sc.dimensions_total as number, config_version: String(sc.config_version),
      },
    }];
  });
  return { rows, breakdowns };
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
  db: Db, orgId: string, periodId: string,
  band: (score: number | null) => HealthBand | null, requestId?: string,
): Promise<StoredHealthScore | null> {
  void requestId;
  const { rows, breakdowns } = await loadCurrent(db, orgId, [periodId]);
  const row = rows[0];
  if (row === undefined) return null;
  return toStored(row, band, breakdowns);
}

/** The score history, for the monthly chart. Ordered by the caller's period list, not by id. */
export async function loadHealthHistory(
  db: Db, orgId: string, periodIds: readonly string[],
  band: (score: number | null) => HealthBand | null, requestId?: string,
): Promise<StoredHealthScore[]> {
  void requestId;
  if (periodIds.length === 0) return [];
  const { rows, breakdowns } = await loadCurrent(db, orgId, periodIds);
  return rows.flatMap((row) => {
    const stored = toStored(row, band, breakdowns);
    return stored === null ? [] : [stored];
  });
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
 * The organisations are the caller's accessible set (`accessible_org_roles`), and each one's
 * pointers and periods are read through its own policies — the per-tenant collections make one
 * statement over every organisation impossible, so the reads run side by side rather than in a
 * loop, which keeps "forty clients load as fast as four" true.
 */
export async function loadPortfolioScores(
  db: Db, requestId?: string,
): Promise<PortfolioScoreRow[]> {
  void requestId;
  const orgs = await accessibleOrgRoles(db.fs, uidOf(db));
  const perOrg = await Promise.all(orgs.map(async ({ organization_id: orgId }) => {
    const [pointers, periods] = await Promise.all([
      readRows(db, orgId, 'health_current'),
      readRows(db, orgId, 'fiscal_periods', (q) => q.where('is_complete', '==', true)),
    ]);
    if (pointers.length === 0) return null;
    const periodById = new Map(periods.map((p) => [String(p.id), p]));
    const scores = await readRowsIn(db, orgId, 'health_scores', 'id', pointers.map((p) => p.health_score_id as string));
    const scoreById = new Map(scores.map((sc) => [String(sc.id), sc]));
    let held: PortfolioScoreRow | null = null;
    for (const row of pointers) {
      const period = periodById.get(String(row.period_id));
      const sc = scoreById.get(String(row.health_score_id));
      if (period === undefined || sc === undefined) continue;
      const candidate: PortfolioScoreRow = {
        organizationId: orgId,
        periodId: String(row.period_id),
        periodStart: String(period.period_start),
        score: (sc.score as number | null) ?? null,
        dimensionsUsed: sc.dimensions_used as number,
        dimensionsTotal: sc.dimensions_total as number,
      };
      // The most recent complete month wins; a card must never show an older month than the one the
      // organisation's own Home opens on.
      if (held === null || candidate.periodStart > held.periodStart) held = candidate;
    }
    return held;
  }));
  return perOrg.filter((row): row is PortfolioScoreRow => row !== null);
}

/**
 * The label of each period a score was written for.
 *
 * Only ever used to NAME an evidence item (`EVIDENCE_MODEL.md` §2.2) — a label is generated from the
 * object it points at, and "Revenue, Mar 2026" needs the month. Nothing scores on it.
 */
export async function loadPeriodLabels(
  db: Db,
  orgId: string,
  periodIds: readonly string[],
): Promise<Map<string, string>> {
  if (periodIds.length === 0) return new Map();
  const rows = await readRowsIn(db, orgId, 'fiscal_periods', 'id', periodIds);
  return new Map(
    rows.filter((row) => typeof row.label === 'string').map((row) => [String(row.id), String(row.label)]),
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
  db: Db, orgId: string, scoreId: string,
): Promise<string | null> {
  const rows = (await readRows(db, orgId, 'evidence_bundles', (q) => q.where('origin_id', '==', scoreId)))
    .filter((b) => b.kind === 'health_score' && b.origin_table === 'health_scores');
  return rows[0] ? String(rows[0].id) : null;
}

/**
 * health.config.v5 (ADR-147): live invoices issued by `issuedBy`, for funding readiness's overdue
 * shares — the same population the standalone Funding Readiness assessment reads (accepted, not
 * superseded, not void). Paged: an invoice list is not bounded the way a pipeline is.
 */
export async function loadInvoicesForHealth(
  db: Db, orgId: string, issuedBy: string, requestId?: string,
): Promise<HealthInvoice[]> {
  void requestId;
  const rows = (await readRows(db, orgId, 'invoices', (q) => q.where('record_status', '==', 'accepted')
    .where('superseded_by', '==', null)))
    .filter((r) => r.status !== 'void' && String(r.issue_date) <= issuedBy)
    .sort((a, b) => (String(a.id) < String(b.id) ? -1 : 1));
  return rows.map((r) => ({
    invoiceType: r.invoice_type as HealthInvoice['invoiceType'], issueDate: r.issue_date as string,
    dueDate: (r.due_date as string | null) ?? null, totalAmount: dec(r.total_amount),
    balanceDue: dec(r.balance_due), paidDate: (r.paid_date as string | null) ?? null,
  }));
}

/**
 * health.config.v5 (ADR-147): the Commercial records marketing efficiency reads — campaign spend for
 * the window's periods and the opportunities, each naming its SURVIVING customer, as the Customers
 * pages read them (ADR-103): `customer_revenue` is keyed by the survivor.
 */
export async function loadCommercialForHealth(
  db: Db, orgId: string, periodIds: readonly string[], requestId?: string,
): Promise<HealthCommercial> {
  void requestId;
  const [spend, won] = await Promise.all([
    readRowsIn(db, orgId, 'campaign_spend', 'period_id', periodIds),
    readRows(db, orgId, 'opportunities', (q) => q.where('stage', '==', 'won')),
  ]);
  const spendRows = spend.sort((a, b) => (String(a.period_id) < String(b.period_id) ? -1 : String(a.period_id) > String(b.period_id) ? 1
    : String(a.campaign_id) < String(b.campaign_id) ? -1 : String(a.campaign_id) > String(b.campaign_id) ? 1 : 0));
  const oppRows = won.sort((a, b) => (String(a.id) < String(b.id) ? -1 : 1)).slice(0, 5000);
  // The opportunity's customer as the Customers pages name it: the SURVIVOR of a merge (ADR-103).
  const parties = await readRowsIn(db, orgId, 'counterparties', 'id', oppRows.map((r) => r.counterparty_id as string | null));
  const mergedInto = new Map(parties.map((c) => [String(c.id), (c.merged_into_id as string | null) ?? null]));
  return {
    spend: spendRows.map((r) => ({ campaignId: String(r.campaign_id), periodId: String(r.period_id), amount: dec(r.amount) })),
    opportunities: oppRows.map((r) => {
      const counterparty = (r.counterparty_id as string | null) ?? null;
      return {
        id: r.id as string, stage: r.stage as HealthCommercial['opportunities'][number]['stage'],
        counterpartyId: (counterparty ? mergedInto.get(counterparty) : null) ?? counterparty,
        campaignId: (r.campaign_id as string | null) ?? null, wonOn: (r.won_on as string | null) ?? null,
      };
    }),
  };
}
