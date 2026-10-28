import 'server-only';
import type { DocumentData, Query } from 'firebase-admin/firestore';
import { callApi } from '@/core/db';
import { signedFromEntry, toMoneyString } from '@/core/money';
import { orgRows } from '@/db/rls';
import { orgCollection, type OrgTable } from '@/db/schema';
import type { Db } from '@/db/types';
import type { AlertSeverity, AlertSubjectType, RecordObservation } from '../domain/types';
import type { ExistingAlert } from '../domain/lifecycle';
import type { OpenInvoiceObservation } from '../domain/context';

/**
 * Alert reads and writes (DATABASE_ARCHITECTURE.md §6).
 *
 * The one that needs explaining is `loadExistingAlerts`. §8.1 decides whether to write a revision by
 * asking whether the SAME rows are still pinned, so the previous run's pinned ids have to come back
 * with the alert. They live on the current revision's evidence bundle, which is where they were
 * written — rather than being copied onto the alert row, where the two could drift.
 */

/**
 * The rows of one organisation's table, as the caller may read them.
 *
 * A USER handle reads through the ported row policies (`src/db/rls.ts`), as the caller's JWT read
 * through RLS. The SERVICE handle is the `alerts.evaluate` job, which read with the service role on
 * PostgreSQL and so saw every row; it reads the collection directly — but only the organisation its
 * job is scoped to (ADR-090), so a handler naming the wrong organisation reads nothing.
 */
async function rowsOf<T>(db: Db, orgId: string, table: OrgTable, refine?: (q: Query) => Query): Promise<T[]> {
  if (db.actor.kind === 'service') {
    if (db.actor.scope !== null && db.actor.scope !== orgId) return [];
    const base: Query = orgCollection(db.fs, orgId, table);
    const snap = await (refine ? refine(base) : base).get();
    return snap.docs.map((d) => d.data() as T);
  }
  return orgRows<T>(db, orgId, table, refine);
}

/** `where(field, 'in', ids)` in chunks of 30 (Firestore's limit), the results concatenated. */
async function rowsIn<T>(
  db: Db, orgId: string, table: OrgTable, field: string, ids: readonly string[],
  refine: (q: Query) => Query = (q) => q,
): Promise<T[]> {
  const unique = [...new Set(ids)];
  const out: T[] = [];
  for (let i = 0; i < unique.length; i += 30) {
    const chunk = unique.slice(i, i + 30);
    out.push(...await rowsOf<T>(db, orgId, table, (q) => refine(q.where(field, 'in', chunk))));
  }
  return out;
}

/** The current revision of each alert (the old `alerts_current_revision_fk` embed), by its id. */
async function currentRevisions<T extends DocumentData>(
  db: Db, orgId: string, revisionIds: ReadonlyArray<string | null>,
): Promise<Map<string, T>> {
  const ids = revisionIds.filter((id): id is string => id != null);
  const rows = ids.length === 0 ? [] : await rowsIn<T>(db, orgId, 'alert_revisions', 'id', ids);
  return new Map(rows.map((row) => [String(row.id), row]));
}

interface AlertRow {
  id: string;
  dedupe_key: string;
  rule_key: string;
  status: ExistingAlert['status'];
  severity: AlertSeverity;
  threshold_summary: Record<string, string | null> | null;
  dismissed_at: string | null;
  first_seen_at: string;
  current_revision_id: string | null;
}

interface RevisionRef { id: string; revision_no: number; evidence_bundle_id: string | null }

/**
 * Every alert that could still be affected by a re-evaluation.
 *
 * `resolved` rows are included deliberately: R2-B-02 requires a resolved state alert whose condition
 * returns to RE-OPEN rather than to start again as a new row with a new `first_seen_at`. Loading
 * only the open ones would quietly break that, and the break would look like correct behaviour.
 */
export async function loadExistingAlerts(
  db: Db, orgId: string, _requestId?: string,
): Promise<Map<string, ExistingAlert>> {
  const rows = await rowsOf<AlertRow>(db, orgId, 'alerts');
  const revisions = await currentRevisions<RevisionRef>(db, orgId, rows.map((row) => row.current_revision_id));
  const revisionOf = (row: AlertRow) => (row.current_revision_id ? revisions.get(row.current_revision_id) ?? null : null);

  const bundleIds = rows
    .map((row) => revisionOf(row)?.evidence_bundle_id)
    .filter((id): id is string => id != null);
  const pinsByBundle = await loadPins(db, orgId, bundleIds);

  const out = new Map<string, ExistingAlert>();
  for (const row of rows) {
    const revision = revisionOf(row);
    const bundleId = revision?.evidence_bundle_id ?? null;
    const pins = bundleId === null
      ? { snapshotIds: [], recordIds: [] }
      : pinsByBundle.get(bundleId) ?? { snapshotIds: [], recordIds: [] };
    out.set(row.dedupe_key, {
      id: row.id,
      dedupeKey: row.dedupe_key,
      ruleKey: row.rule_key,
      status: row.status,
      severity: row.severity,
      revisionNo: revision?.revision_no ?? 0,
      thresholdSummary: row.threshold_summary ?? {},
      snapshotIds: pins.snapshotIds,
      recordIds: pins.recordIds,
      dismissedAt: row.dismissed_at,
      firstSeenAt: row.first_seen_at,
    });
  }
  return out;
}

interface PinRow {
  bundle_id: string;
  item_type: string;
  ref_id: string | null;
}

async function loadPins(
  db: Db, orgId: string, bundleIds: readonly string[],
): Promise<Map<string, { snapshotIds: string[]; recordIds: string[] }>> {
  const out = new Map<string, { snapshotIds: string[]; recordIds: string[] }>();
  if (bundleIds.length === 0) return out;

  // In `sort_order`, the order the bundle was written in (the SQL read had no order; this is stable).
  const items = await rowsIn<PinRow & { sort_order: number }>(db, orgId, 'evidence_items', 'bundle_id', bundleIds);
  items.sort((a, b) => (a.bundle_id < b.bundle_id ? -1 : a.bundle_id > b.bundle_id ? 1 : a.sort_order - b.sort_order));
  for (const row of items) {
    if (row.ref_id === null) continue;
    const entry = out.get(row.bundle_id) ?? { snapshotIds: [], recordIds: [] };
    if (row.item_type === 'metric_snapshot') entry.snapshotIds.push(row.ref_id);
    else entry.recordIds.push(row.ref_id);
    out.set(row.bundle_id, entry);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Condition inputs
// ---------------------------------------------------------------------------------------------

interface LedgerRow {
  id: string;
  period_id: string;
  entry_date: string;
  direction: 'debit' | 'credit';
  amount: string;
  description: string | null;
  counterparty_id: string | null;
  account_id: string | null;
  dedupe_hash: string | null;
  duplicate_reviewed: boolean | null;
}

/** Accepted ledger entries for a set of periods, pinned to the run's instant (§2.4). */
export async function loadLedgerRecords(
  db: Db, orgId: string, periodIds: readonly string[], aggregatedAt: string,
  _requestId?: string,
): Promise<RecordObservation[]> {
  if (periodIds.length === 0) return [];
  // Equalities in the query (single-field indexes merge); the instant bound is applied here.
  const rows = (await rowsIn<LedgerRow & { created_at: string }>(db, orgId, 'ledger_entries', 'period_id', periodIds,
    (q) => q.where('record_status', '==', 'accepted').where('superseded_by', '==', null)))
    .filter((row) => notAfter(row.created_at, aggregatedAt));

  return rows.map((row) => ({
    id: row.id,
    table: 'ledger_entries' as const,
    periodId: row.period_id,
    date: row.entry_date,
    /*
     * A ledger entry is a magnitude plus a side; the rules speak SIGNED amounts, where a payment out
     * is negative. `signedFromEntry` is the one place that conversion is defined (`core/money`), so
     * the alert rules and the engine cannot disagree about which way a debit points.
     */
    amount: toMoneyString(signedFromEntry({ direction: row.direction, amount: row.amount })),
    descriptionNormalized: row.description,
    counterpartyId: row.counterparty_id,
    bankAccountId: null,
    dedupeHash: row.dedupe_hash,
    duplicateReviewed: row.duplicate_reviewed === true,
    isTransfer: false,
    recurringGroupId: null,
    accountId: row.account_id,
  }));
}

interface InvoiceRow {
  id: string;
  period_id: string;
  issue_date: string;
  due_date: string | null;
  total_amount: string;
  balance_due: string | null;
  invoice_type: string;
  counterparty_id: string | null;
  description: string | null;
  invoice_number: string | null;
  dedupe_hash: string | null;
  duplicate_reviewed: boolean | null;
}

export async function loadInvoiceRecords(
  db: Db, orgId: string, periodIds: readonly string[], aggregatedAt: string,
  _requestId?: string,
): Promise<RecordObservation[]> {
  if (periodIds.length === 0) return [];
  const rows = (await rowsIn<InvoiceRow & { created_at: string }>(db, orgId, 'invoices', 'period_id', periodIds,
    (q) => q.where('record_status', '==', 'accepted').where('superseded_by', '==', null)))
    .filter((row) => notAfter(row.created_at, aggregatedAt));

  return rows.map((row) => ({
    id: row.id,
    table: 'invoices' as const,
    periodId: row.period_id,
    date: row.issue_date,
    amount: String(row.total_amount),
    descriptionNormalized: row.description ?? row.invoice_number,
    counterpartyId: row.counterparty_id,
    bankAccountId: null,
    dedupeHash: row.dedupe_hash,
    duplicateReviewed: row.duplicate_reviewed === true,
    isTransfer: false,
    recurringGroupId: null,
    accountId: null,
    outstanding: row.balance_due === null ? null : String(row.balance_due),
    dueDate: row.due_date,
    invoiceType: row.invoice_type,
  }));
}

/**
 * Every invoice the receivables and payables deterioration rules may name (ADR-120 hardening): the
 * current row of each accepted, non-superseded, non-void invoice issued by `issuedBy`, visible at
 * the run's aggregation instant — the set the engine aged. Read whole (PostgreSQL paged around
 * PostgREST's 1,000-row cap): a business with a thousand open invoices is exactly the one these
 * rules are for.
 */
export async function loadOpenInvoices(
  db: Db, orgId: string, issuedBy: string, aggregatedAt: string, _requestId?: string,
): Promise<OpenInvoiceObservation[]> {
  // The equalities in the query; `status <> 'void'`, the two bounds and the order by id here.
  const rows = (await rowsOf<Record<string, unknown>>(db, orgId, 'invoices',
    (q) => q.where('record_status', '==', 'accepted').where('superseded_by', '==', null)))
    .filter((row) => row.status !== 'void' && notAfter(String(row.created_at), aggregatedAt)
      && String(row.issue_date) <= issuedBy)
    .sort((x, y) => (String(x.id) < String(y.id) ? -1 : String(x.id) > String(y.id) ? 1 : 0));
  return rows.map((row) => ({
    id: row.id as string,
    invoiceType: row.invoice_type as OpenInvoiceObservation['invoiceType'],
    issueDate: row.issue_date as string,
    dueDate: (row.due_date as string | null) ?? null,
    totalAmount: String(row.total_amount),
    balanceDue: String(row.balance_due),
    paidDate: (row.paid_date as string | null) ?? null,
    description: (row.description as string | null) ?? (row.invoice_number as string | null) ?? null,
  }));
}

/** `created_at <= instant`, compared as instants (stored ISO strings may differ in precision). */
function notAfter(createdAt: string, instant: string): boolean {
  return new Date(createdAt).getTime() <= new Date(instant).getTime();
}

// ---------------------------------------------------------------------------------------------
// Reads for the interface
// ---------------------------------------------------------------------------------------------

export interface AlertListRow {
  readonly id: string;
  readonly ruleKey: string;
  readonly severity: AlertSeverity;
  readonly status: ExistingAlert['status'];
  readonly title: string;
  readonly explanation: string;
  readonly recommendedNextStep: string | null;
  readonly thresholdSummary: Record<string, string | null>;
  readonly metricKey: string | null;
  readonly periodId: string;
  readonly subjectType: AlertSubjectType;
  readonly subjectId: string | null;
  readonly firstSeenAt: string;
  readonly lastEvaluatedAt: string;
  readonly statusReasonCode: string;
  readonly evidenceBundleId: string | null;
  /** The action somebody already made from this alert, if any (§8 convert row). */
  readonly actionId: string | null;
}

interface ListRow {
  id: string;
  rule_key: string;
  severity: AlertSeverity;
  status: ExistingAlert['status'];
  title: string;
  explanation: string;
  recommended_next_step: string | null;
  threshold_summary: Record<string, string | null> | null;
  metric_key: string | null;
  period_id: string;
  subject_type: AlertSubjectType;
  subject_id: string | null;
  first_seen_at: string;
  last_evaluated_at: string;
  status_reason_code: string;
  action_id: string | null;
  dedupe_key: string;
  current_revision_id: string | null;
}

function toListRow(row: ListRow, revision: { evidence_bundle_id: string | null } | null): AlertListRow {
  return {
    id: row.id,
    ruleKey: row.rule_key,
    severity: row.severity,
    status: row.status,
    title: row.title,
    explanation: row.explanation,
    recommendedNextStep: row.recommended_next_step,
    thresholdSummary: row.threshold_summary ?? {},
    metricKey: row.metric_key,
    periodId: row.period_id,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    firstSeenAt: row.first_seen_at,
    lastEvaluatedAt: row.last_evaluated_at,
    statusReasonCode: row.status_reason_code,
    evidenceBundleId: revision?.evidence_bundle_id ?? null,
    // §8's convert row: an alert names the action somebody already made from it, so the interface
    // offers the button once rather than inviting two people to do the same work.
    actionId: row.action_id ?? null,
  };
}

export interface AlertQuery {
  readonly statuses?: readonly ExistingAlert['status'][];
  readonly severities?: readonly AlertSeverity[];
  readonly periodId?: string;
  readonly limit?: number;
}

/**
 * `severity_enum`'s declaration order (critical … info): the list sorted on the enum's position,
 * as PostgreSQL sorted an enum, not on its label.
 */
const SEVERITY_RANK: Readonly<Record<AlertSeverity, number>> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

/** The alert list, filtered. The row policies decide which rows come back. */
export async function loadAlerts(
  db: Db, orgId: string, query: AlertQuery = {}, _requestId?: string,
): Promise<AlertListRow[]> {
  // The status filter in the query; severity, period, the order and the limit here (no composite index).
  const rows = (await rowsOf<ListRow>(db, orgId, 'alerts', (q) => (
    query.statuses && query.statuses.length > 0 ? q.where('status', 'in', [...query.statuses]) : q)))
    .filter((row) => (!query.severities || query.severities.length === 0 || query.severities.includes(row.severity))
      && (query.periodId === undefined || row.period_id === query.periodId));

  /*
   * N-7 (Step 0F): one run evaluates every alert at the same instant, so severity and recency tie
   * between, say, a cost spike and a concentration alert of the same severity — and the order (and,
   * past the limit, the membership) of the list was whatever the plan returned. Ties are broken by
   * the rule, then by the alert's identity (`dedupe_key`, unique per organisation): a total order, so
   * the same alerts always come back in the same order. The keys are the SQL's:
   * `severity desc, last_evaluated_at desc, rule_key, dedupe_key`.
   */
  const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
  rows.sort((a, b) => (SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity])
    || (new Date(b.last_evaluated_at).getTime() - new Date(a.last_evaluated_at).getTime())
    || cmp(a.rule_key, b.rule_key)
    || cmp(a.dedupe_key, b.dedupe_key));
  const page = rows.slice(0, query.limit ?? 200);

  const revisions = await currentRevisions<{ id: string; evidence_bundle_id: string | null }>(
    db, orgId, page.map((row) => row.current_revision_id));
  return page.map((row) => toListRow(row, row.current_revision_id ? revisions.get(row.current_revision_id) ?? null : null));
}

export interface AlertRevisionRow {
  readonly revisionNo: number;
  readonly severity: AlertSeverity;
  readonly explanation: string;
  readonly thresholdSummary: Record<string, string | null>;
  readonly evidenceBundleId: string | null;
  readonly createdAt: string;
}

/** The history of what an alert said, newest first (ADR-034, F-C-16). */
export async function loadAlertHistory(
  db: Db, orgId: string, alertId: string, _requestId?: string,
): Promise<AlertRevisionRow[]> {
  const rows = await rowsOf<{
    revision_no: number; severity: AlertSeverity; explanation: string;
    threshold_summary: Record<string, string | null> | null;
    evidence_bundle_id: string | null; created_at: string;
  }>(db, orgId, 'alert_revisions', (q) => q.where('alert_id', '==', alertId));
  rows.sort((a, b) => b.revision_no - a.revision_no);

  return rows.map((row) => ({
    revisionNo: row.revision_no,
    severity: row.severity,
    explanation: row.explanation,
    thresholdSummary: row.threshold_summary ?? {},
    evidenceBundleId: row.evidence_bundle_id,
    createdAt: row.created_at,
  }));
}

// ---------------------------------------------------------------------------------------------
// The one user-facing write
// ---------------------------------------------------------------------------------------------

/**
 * `api.set_alert_status` (DATABASE_ARCHITECTURE.md §14.2).
 *
 * The function enforces the permission itself, including the client's partial `alerts.manage` — a
 * client may acknowledge and nothing else. The call is made for the CALLER's handle, never the
 * server's, so the row policies and that check are the things actually deciding.
 */
export async function setAlertStatus(
  db: Db,
  input: { alertId: string; status: string; reason: string | null },
  requestId?: string,
): Promise<void> {
  await callApi(db, 'set_alert_status', {
    p_alert: input.alertId,
    p_status: input.status,
    p_reason: input.reason,
  }, requestId);
}
