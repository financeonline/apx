import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { toMotionError } from '@/core/errors';
import { signedFromEntry, toMoneyString } from '@/core/money';
import type { AlertSeverity, AlertSubjectType, RecordObservation } from '../domain/types';
import type { ExistingAlert } from '../domain/lifecycle';

/**
 * Alert reads and writes (DATABASE_ARCHITECTURE.md §6).
 *
 * The one that needs explaining is `loadExistingAlerts`. §8.1 decides whether to write a revision by
 * asking whether the SAME rows are still pinned, so the previous run's pinned ids have to come back
 * with the alert. They live on the current revision's evidence bundle, which is where they were
 * written — rather than being copied onto the alert row, where the two could drift.
 */

function unwrap<T>(data: T[] | null, error: unknown, requestId?: string): T[] {
  if (error) throw toMotionError(error, requestId);
  return data ?? [];
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
  alert_revisions: {
    revision_no: number;
    evidence_bundle_id: string | null;
  } | null;
}

/**
 * Every alert that could still be affected by a re-evaluation.
 *
 * `resolved` rows are included deliberately: R2-B-02 requires a resolved state alert whose condition
 * returns to RE-OPEN rather than to start again as a new row with a new `first_seen_at`. Loading
 * only the open ones would quietly break that, and the break would look like correct behaviour.
 */
export async function loadExistingAlerts(
  db: SupabaseClient, orgId: string, requestId?: string,
): Promise<Map<string, ExistingAlert>> {
  const { data, error } = await db
    .from('alerts')
    .select(`id, dedupe_key, rule_key, status, severity, threshold_summary, dismissed_at,
             first_seen_at, current_revision_id,
             alert_revisions!alerts_current_revision_fk (revision_no, evidence_bundle_id)`)
    .eq('organization_id', orgId);

  const rows = unwrap(data as unknown as AlertRow[] | null, error, requestId);

  const bundleIds = rows
    .map((row) => row.alert_revisions?.evidence_bundle_id)
    .filter((id): id is string => id != null);
  const pinsByBundle = await loadPins(db, orgId, bundleIds, requestId);

  const out = new Map<string, ExistingAlert>();
  for (const row of rows) {
    const bundleId = row.alert_revisions?.evidence_bundle_id ?? null;
    const pins = bundleId === null
      ? { snapshotIds: [], recordIds: [] }
      : pinsByBundle.get(bundleId) ?? { snapshotIds: [], recordIds: [] };
    out.set(row.dedupe_key, {
      id: row.id,
      dedupeKey: row.dedupe_key,
      ruleKey: row.rule_key,
      status: row.status,
      severity: row.severity,
      revisionNo: row.alert_revisions?.revision_no ?? 0,
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
  db: SupabaseClient, orgId: string, bundleIds: readonly string[], requestId?: string,
): Promise<Map<string, { snapshotIds: string[]; recordIds: string[] }>> {
  const out = new Map<string, { snapshotIds: string[]; recordIds: string[] }>();
  if (bundleIds.length === 0) return out;

  const { data, error } = await db
    .from('evidence_items')
    .select('bundle_id, item_type, ref_id')
    .eq('organization_id', orgId)
    .in('bundle_id', [...new Set(bundleIds)]);

  for (const row of unwrap(data as unknown as PinRow[] | null, error, requestId)) {
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
  db: SupabaseClient, orgId: string, periodIds: readonly string[], aggregatedAt: string,
  requestId?: string,
): Promise<RecordObservation[]> {
  if (periodIds.length === 0) return [];
  const { data, error } = await db
    .from('ledger_entries')
    .select(`id, period_id, entry_date, direction, amount, description, counterparty_id,
             account_id, dedupe_hash, duplicate_reviewed`)
    .eq('organization_id', orgId)
    .in('period_id', [...periodIds])
    .eq('record_status', 'accepted')
    .is('superseded_by', null)
    .lte('created_at', aggregatedAt);

  return unwrap(data as unknown as LedgerRow[] | null, error, requestId).map((row) => ({
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
  db: SupabaseClient, orgId: string, periodIds: readonly string[], aggregatedAt: string,
  requestId?: string,
): Promise<RecordObservation[]> {
  if (periodIds.length === 0) return [];
  const { data, error } = await db
    .from('invoices')
    .select(`id, period_id, issue_date, due_date, total_amount, balance_due, invoice_type,
             counterparty_id, description, invoice_number, dedupe_hash, duplicate_reviewed`)
    .eq('organization_id', orgId)
    .in('period_id', [...periodIds])
    .eq('record_status', 'accepted')
    .is('superseded_by', null)
    .lte('created_at', aggregatedAt);

  return unwrap(data as unknown as InvoiceRow[] | null, error, requestId).map((row) => ({
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
  alert_revisions: { evidence_bundle_id: string | null } | null;
}

const LIST_SELECT = `
  id, rule_key, severity, status, title, explanation, recommended_next_step, threshold_summary,
  metric_key, period_id, subject_type, subject_id, first_seen_at, last_evaluated_at,
  status_reason_code, action_id,
  alert_revisions!alerts_current_revision_fk (evidence_bundle_id)`;

function toListRow(row: ListRow): AlertListRow {
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
    evidenceBundleId: row.alert_revisions?.evidence_bundle_id ?? null,
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

/** The alert list, filtered. RLS decides which organisation's rows come back. */
export async function loadAlerts(
  db: SupabaseClient, orgId: string, query: AlertQuery = {}, requestId?: string,
): Promise<AlertListRow[]> {
  let builder = db.from('alerts').select(LIST_SELECT).eq('organization_id', orgId);

  if (query.statuses && query.statuses.length > 0) builder = builder.in('status', [...query.statuses]);
  if (query.severities && query.severities.length > 0) {
    builder = builder.in('severity', [...query.severities]);
  }
  if (query.periodId !== undefined) builder = builder.eq('period_id', query.periodId);

  const { data, error } = await builder
    .order('severity', { ascending: false })
    .order('last_evaluated_at', { ascending: false })
    .limit(query.limit ?? 200);

  return unwrap(data as unknown as ListRow[] | null, error, requestId).map(toListRow);
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
  db: SupabaseClient, orgId: string, alertId: string, requestId?: string,
): Promise<AlertRevisionRow[]> {
  const { data, error } = await db
    .from('alert_revisions')
    .select('revision_no, severity, explanation, threshold_summary, evidence_bundle_id, created_at')
    .eq('organization_id', orgId)
    .eq('alert_id', alertId)
    .order('revision_no', { ascending: false });

  return unwrap(data as unknown as Array<{
    revision_no: number; severity: AlertSeverity; explanation: string;
    threshold_summary: Record<string, string | null> | null;
    evidence_bundle_id: string | null; created_at: string;
  }> | null, error, requestId).map((row) => ({
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
 * client may acknowledge and nothing else. The call is made through the CALLER's client, never the
 * service role, so RLS and that check are the things actually deciding.
 */
export async function setAlertStatus(
  db: SupabaseClient,
  input: { alertId: string; status: string; reason: string | null },
  requestId?: string,
): Promise<void> {
  const { error } = await db.schema('api').rpc('set_alert_status', {
    p_alert: input.alertId,
    p_status: input.status,
    p_reason: input.reason,
  });
  if (error) throw toMotionError(error, requestId);
}
