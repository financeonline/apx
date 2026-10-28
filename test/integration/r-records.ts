import Decimal from 'decimal.js';
import { hashKey, newId, nowIso, orgRow } from '@/db/schema';
import { monthStart, normalizeName, periodId } from '@/db/app/shared';
import { fs } from './setup';

/**
 * Financial-record fixtures for Team R's reporting suites, written straight into Firestore in the
 * shapes FIRESTORE_DATA_MODEL.md §3 gives: what an import commit, the engine and the alert and action
 * functions leave behind. Each writer also does what the row's triggers did (`period_assign` →
 * `period_id` from the date; the generated `balance_due`; `derive_normalized_name`). The months must
 * exist first (`ensureMonths`).
 */

const base = () => {
  const now = nowIso();
  return { created_at: now, updated_at: now };
};

const recordColumns = {
  source_document_id: null, import_batch_id: null, import_row_id: null, source_ref: null,
  assurance_level: 'verified', dedupe_hash: null, duplicate_reviewed: false, superseded_by: null,
  superseded_at: null, promoted_from_batch_id: null, rejected_reason: null,
};

export async function writeSourceDocument(orgId: string, input: {
  path: string; filename: string; mime?: string; kind: string; status?: string; sha256?: string;
}): Promise<string> {
  const id = newId();
  await orgRow(fs(), orgId, 'source_documents', id).set({
    id, organization_id: orgId, storage_bucket: 'source-documents', storage_path: input.path,
    original_filename: input.filename, mime_type: input.mime ?? 'text/csv', byte_size: 10,
    sha256: input.sha256 ?? 'e5', document_kind: input.kind, page_count: null, has_text_layer: null,
    extracted_text_path: null, status: input.status ?? 'ready', scan_result: {}, uploaded_by: null,
    deleted_at: null, ...base(),
  });
  return id;
}

export async function writeImportBatch(orgId: string, input: {
  documentId: string; importType: string; targetTable: string; status: string; bankAccountId?: string | null;
  periodStart?: string | null; periodEnd?: string | null; committedAt?: string | null; rowCounts?: Record<string, unknown>;
}): Promise<string> {
  const id = newId();
  await orgRow(fs(), orgId, 'import_batches', id).set({
    id, organization_id: orgId, source_document_id: input.documentId, import_type: input.importType,
    target_table: input.targetTable, bank_account_id: input.bankAccountId ?? null, mapping_id: null,
    mapping_snapshot: null, status: input.status, row_counts: input.rowCounts ?? {},
    period_start: input.periodStart ?? null, period_end: input.periodEnd ?? null,
    statement_opening_balance: null, statement_closing_balance: null, balance_sign: 'natural',
    fiscal_year_start_month_at_commit: null, invoice_list_kind: null, balance_basis: null,
    extraction_method: 'csv', pages_extracted: null, pages_failed: null, created_by: null, reviewed_by: null,
    committed_at: input.committedAt === undefined ? (input.status === 'committed' ? nowIso() : null) : input.committedAt,
    rolled_back_at: null, rolled_back_reason: null, replaced_batch_id: null, error_summary: null,
    calculation_job_id: null, calculation_run_id: null, batch_issues: [], confirmations: {},
    required_confirmations: [], page_confirmations: {}, review_token: newId(), extraction_stats: {}, ...base(),
  });
  return id;
}

export async function writeBankAccount(orgId: string, input: { name: string; type?: string; masked?: string }): Promise<string> {
  const id = newId();
  await orgRow(fs(), orgId, 'bank_accounts', id).set({
    id, organization_id: orgId, name: input.name, bank_name: 'Test Bank', account_number_masked: input.masked ?? null,
    sort_code_masked: null, currency: 'GBP', account_type: input.type ?? 'current', ledger_account_id: null,
    opening_balance: null, opening_balance_date: null, is_active: true, ...base(),
  });
  return id;
}

export async function writeBankTransaction(orgId: string, input: {
  accountId: string; date: string; amount: string; transferKind?: string;
}): Promise<string> {
  const id = newId();
  const kind = input.transferKind ?? 'none';
  await orgRow(fs(), orgId, 'bank_transactions', id).set({
    id, organization_id: orgId, bank_account_id: input.accountId, transaction_date: input.date, posted_date: null,
    period_id: periodId(orgId, monthStart(input.date)), amount: input.amount, currency: 'GBP',
    description_raw: `fixture ${input.date} ${input.amount}`, description_normalized: `fixture ${input.date} ${input.amount}`,
    counterparty_name_raw: null, counterparty_id: null, category_account_id: null, category_source: 'none',
    balance_after: null, reference: null, is_transfer: kind === 'cash_transfer', transfer_pair_id: null,
    transfer_kind: kind, recurring_group_id: null, matched_ledger_entry_id: null, record_status: 'accepted',
    ...recordColumns, ...base(),
  });
  return id;
}

export async function writeCounterparty(orgId: string, name: string, kind = 'customer'): Promise<string> {
  const id = newId();
  await orgRow(fs(), orgId, 'counterparties', id).set({
    id, organization_id: orgId, name, normalized_name: normalizeName(name), kind, default_expense_category: null,
    external_ref: null, email: null, notes: null, is_active: true, merged_into_id: null, ...base(),
  });
  return id;
}

export async function writeInvoice(orgId: string, f: {
  type: string; number: string; issue: string; due: string | null; total: string; paid: string;
  status: string; paidDate: string | null; counterparty: string;
}): Promise<string> {
  const id = newId();
  await orgRow(fs(), orgId, 'invoices', id).set({
    id, organization_id: orgId, invoice_type: f.type, counterparty_id: f.counterparty, invoice_number: f.number,
    issue_date: f.issue, due_date: f.due, period_id: periodId(orgId, monthStart(f.issue)), subtotal: null,
    tax_amount: null, total_amount: f.total, amount_paid: f.paid,
    balance_due: new Decimal(f.total).minus(f.paid).toFixed(2), currency: 'GBP', status: f.status,
    paid_date: f.paidDate, description: null, record_status: 'accepted', ...recordColumns, ...base(),
  });
  return id;
}

export async function writeLedgerEntry(orgId: string, input: {
  accountId: string; date: string; direction: 'debit' | 'credit'; amount: string;
}): Promise<string> {
  const id = newId();
  await orgRow(fs(), orgId, 'ledger_entries', id).set({
    id, organization_id: orgId, entry_date: input.date, period_id: periodId(orgId, monthStart(input.date)),
    account_id: input.accountId, direction: input.direction, amount: input.amount, currency: 'GBP',
    description: null, reference: null, counterparty_id: null, journal_ref: null, record_status: 'accepted',
    is_opening_balance: false, ...recordColumns, ...base(),
  });
  const ev = newId();
  await orgRow(fs(), orgId, 'record_status_events', ev).set({
    id: ev, organization_id: orgId, record_table: 'ledger_entries', record_id: id, event: 'accepted',
    related_record_id: null, import_batch_id: null, actor_user_id: null, at: nowIso(),
  });
  return id;
}

/** An alert row as `api_server.persist_alerts` leaves one (no revision: the reports read alerts only). */
export async function writeAlert(orgId: string, input: {
  periodId: string; runId: string; title: string; severity: string; firstSeen: string; status?: string;
  changedAt?: string | null; dedupeKey: string;
}): Promise<string> {
  const id = newId();
  await orgRow(fs(), orgId, 'alerts', id).set({
    id, organization_id: orgId, rule_key: `fixture.${input.title.replace(/\W/g, '')}`, rule_version: '1',
    severity: input.severity, metric_key: null, period_id: input.periodId, subject_type: 'none', subject_id: null,
    title: input.title, explanation: `${input.title} explained.`, threshold_summary: {},
    recommended_next_step: 'Look at it.', current_revision_id: null, status: input.status ?? 'open',
    status_changed_by: null, status_changed_at: input.changedAt ?? null, status_reason_code: 'user',
    status_reason: null, action_id: null, dedupe_key: input.dedupeKey, key_kind: 'event',
    calculation_run_id: input.runId, first_seen_at: input.firstSeen, reopened_at: null, dismissed_at: null,
    last_evaluated_at: input.firstSeen, ...base(),
  });
  await fs().collection('organizations').doc(orgId).collection('_unique')
    .doc(`alert_dedupe__${hashKey([input.dedupeKey])}`)
    .set({ owner_id: id, constraint: 'alert_dedupe', created_at: nowIso() });
  return id;
}

export async function writeAction(orgId: string, input: {
  title: string; due: string | null; status?: string; completedAt?: string | null; ownerId: string | null;
}): Promise<string> {
  const id = newId();
  await orgRow(fs(), orgId, 'actions', id).set({
    id, organization_id: orgId, title: input.title, issue: null, recommendation: null, priority: 'high',
    owner_user_id: input.ownerId, due_date: input.due, status: input.status ?? 'open', source_type: 'user',
    source_id: null, evidence_bundle_id: null, outcome_notes: null, outcome_value: null, outcome_currency: null,
    completed_at: input.completedAt ?? null, dismissed_reason: null, created_by: input.ownerId, ...base(),
  });
  return id;
}

export async function writeConversation(orgId: string, userId: string, title: string): Promise<string> {
  const id = newId();
  await orgRow(fs(), orgId, 'ai_conversations', id).set({
    id, organization_id: orgId, user_id: userId, title, status: 'active', last_message_at: null, ...base(),
  });
  return id;
}

export async function writeMessage(orgId: string, input: {
  conversationId: string; role: 'user' | 'assistant'; content?: string | null; structured?: unknown;
  grounding?: string; createdAt?: string; evidenceBundleId?: string | null;
}): Promise<string> {
  const id = newId();
  await orgRow(fs(), orgId, 'ai_messages', id).set({
    id, organization_id: orgId, conversation_id: input.conversationId, role: input.role,
    content: input.content ?? null, structured_response: input.structured ?? null, prompt_version: null,
    model: null, input_tokens: null, output_tokens: null, latency_ms: null,
    grounding_status: input.grounding ?? 'not_applicable', grounding_report: null,
    evidence_bundle_id: input.evidenceBundleId ?? null, period_context: {}, flagged: false,
    created_at: input.createdAt ?? nowIso(),
  });
  return id;
}
