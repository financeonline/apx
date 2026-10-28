import { createHash } from 'node:crypto';
import Decimal from 'decimal.js';
import { newId, nowIso, orgCollection, orgRow, uniqueGuard } from '@/db/schema';
import { ensurePeriods, normalizeName, periodId } from '@/db/app/shared';
import { fs } from './setup';

/**
 * Financial-record fixtures for the evidence suites, written straight into Firestore in the shapes
 * FIRESTORE_DATA_MODEL.md §3 gives (numeric = decimal string, bytea = lowercase hex, explicit nulls).
 * What the old triggers did on insert is done here too, so a fixture looks like a committed row:
 * `period_assign` (the record's month, created if missing), `derive_normalized_name`, and the
 * generated `invoices.balance_due`. Fixtures only — assertions go through the services.
 */

const money = (v: string | number): string => new Decimal(v).toFixed(2);
const sha = (seed: string): string => createHash('sha256').update(seed).digest('hex');

/** The fiscal period a date falls in, created (as `period_assign` did) when missing. */
export async function periodFor(orgId: string, date: string): Promise<string> {
  await ensurePeriods(fs(), orgId, date, date);
  return periodId(orgId, `${date.slice(0, 7)}-01`);
}

/** The organisation's seeded system account for a standard category. */
export async function accountFor(orgId: string, category: string): Promise<string> {
  const snap = await orgCollection(fs(), orgId, 'accounts').where('standard_category', '==', category)
    .where('is_system', '==', true).limit(1).get();
  if (snap.empty) throw new Error(`no ${category} account in ${orgId}`);
  return snap.docs[0]!.id;
}

/** Any account of the organisation (the old `select id from accounts limit 1`). */
export async function anyAccount(orgId: string): Promise<string> {
  const snap = await orgCollection(fs(), orgId, 'accounts').limit(1).get();
  return snap.docs[0]!.id;
}

export async function seedAccount(orgId: string, input: {
  name: string; category: string; accountType: string; source?: string; isSystem?: boolean; code?: string | null;
}): Promise<string> {
  const id = newId();
  const now = nowIso();
  // The `open_category_history` trigger: the account's category from the moment it exists.
  const historyId = newId();
  await orgRow(fs(), orgId, 'account_category_history', historyId).set({
    id: historyId, organization_id: orgId, account_id: id, standard_category: input.category,
    valid_from: now, valid_to: null, changed_by: null, created_at: now,
  });
  await orgRow(fs(), orgId, 'accounts', id).set({
    id, organization_id: orgId, code: input.code ?? null, name: input.name, normalized_name: normalizeName(input.name),
    account_type: input.accountType, standard_category: input.category, is_system: input.isSystem ?? false,
    is_active: true, source: input.source ?? 'imported', external_ref: null, mapping_confidence: 'confirmed',
    loan_security: null, created_at: now, updated_at: now,
  });
  return id;
}

export async function seedCounterparty(orgId: string, input: {
  name: string; kind?: string; defaultExpenseCategory?: string | null; mergedIntoId?: string | null; isActive?: boolean;
}): Promise<string> {
  const id = newId();
  const now = nowIso();
  await orgRow(fs(), orgId, 'counterparties', id).set({
    id, organization_id: orgId, name: input.name, normalized_name: normalizeName(input.name),
    kind: input.kind ?? 'unknown', default_expense_category: input.defaultExpenseCategory ?? null,
    external_ref: null, email: null, notes: null, is_active: input.isActive ?? true,
    merged_into_id: input.mergedIntoId ?? null, created_at: now, updated_at: now,
  });
  return id;
}

export async function seedDocument(orgId: string, input: {
  name: string; kind?: string; mime?: string; status?: string;
}): Promise<string> {
  const id = newId();
  const now = nowIso();
  await orgRow(fs(), orgId, 'source_documents', id).set({
    id, organization_id: orgId, storage_bucket: 'source-documents',
    storage_path: `${orgId}/${id}/${input.name}`, original_filename: input.name, mime_type: input.mime ?? 'text/csv',
    byte_size: 42, sha256: sha(`${orgId}:${id}`), document_kind: input.kind ?? 'general_ledger', page_count: null,
    has_text_layer: null, extracted_text_path: null, status: input.status ?? 'ready', scan_result: {},
    uploaded_by: null, deleted_at: null, created_at: now, updated_at: now,
  });
  return id;
}

export async function seedBatch(orgId: string, input: {
  documentId: string; importType: string; targetTable: string; status?: string;
  periodStart?: string | null; periodEnd?: string | null; committedAt?: string | null; rolledBackAt?: string | null;
  rowCounts?: Record<string, unknown>; invoiceListKind?: string | null; bankAccountId?: string | null;
  confirmations?: Record<string, unknown>; createdBy?: string | null; extractionMethod?: string;
}): Promise<string> {
  const id = newId();
  const now = nowIso();
  const status = input.status ?? 'committed';
  await orgRow(fs(), orgId, 'import_batches', id).set({
    id, organization_id: orgId, source_document_id: input.documentId, import_type: input.importType,
    target_table: input.targetTable, bank_account_id: input.bankAccountId ?? null, mapping_id: null,
    mapping_snapshot: null, status, row_counts: input.rowCounts ?? {}, period_start: input.periodStart ?? null,
    period_end: input.periodEnd ?? null, statement_opening_balance: null, statement_closing_balance: null,
    balance_sign: 'natural', fiscal_year_start_month_at_commit: null, invoice_list_kind: input.invoiceListKind ?? null,
    balance_basis: null, extraction_method: input.extractionMethod ?? 'csv', pages_extracted: null, pages_failed: null,
    created_by: input.createdBy ?? null, reviewed_by: null,
    committed_at: input.committedAt !== undefined ? input.committedAt : (status === 'committed' ? now : null),
    rolled_back_at: input.rolledBackAt ?? null, rolled_back_reason: null, replaced_batch_id: null,
    error_summary: null, calculation_job_id: null, calculation_run_id: null, created_at: now, updated_at: now,
    batch_issues: [], confirmations: input.confirmations ?? {}, required_confirmations: [], page_confirmations: {},
    review_token: newId(), extraction_stats: {},
  });
  return id;
}

export async function seedImportRow(orgId: string, input: {
  batchId: string; rowNumber: number; sourceRef?: string | null; status?: string;
  committedTable?: string | null; committedRecordId?: string | null;
}): Promise<string> {
  const id = newId();
  const now = nowIso();
  await orgRow(fs(), orgId, 'import_rows', id).set({
    id, organization_id: orgId, batch_id: input.batchId, row_number: input.rowNumber,
    source_ref: input.sourceRef ?? null, raw_data: {}, mapped_data: {}, status: input.status ?? 'committed',
    issues: [], dedupe_hash: null, duplicate_of_table: null, duplicate_of_id: null,
    duplicate_within_batch_row_id: null, reviewer_decision: 'none', reviewer_reason: null,
    committed_table: input.committedTable ?? null, committed_record_id: input.committedRecordId ?? null,
    created_at: now, updated_at: now, fixed_by: null, fixed_at: null, source_page: null,
  });
  return id;
}

interface Provenance {
  documentId?: string | null; batchId?: string | null; importRowId?: string | null; sourceRef?: string | null;
}

export async function seedLedgerEntry(orgId: string, input: Provenance & {
  date: string; accountId: string; direction: 'debit' | 'credit'; amount: string | number;
  description?: string | null; counterpartyId?: string | null; status?: string; rejectedReason?: string | null;
  assurance?: string; supersededBy?: string | null; isOpeningBalance?: boolean;
}): Promise<string> {
  const id = newId();
  const now = nowIso();
  await orgRow(fs(), orgId, 'ledger_entries', id).set({
    id, organization_id: orgId, entry_date: input.date, period_id: await periodFor(orgId, input.date),
    account_id: input.accountId, direction: input.direction, amount: money(input.amount), currency: 'GBP',
    description: input.description ?? null, reference: null, counterparty_id: input.counterpartyId ?? null,
    journal_ref: null, source_document_id: input.documentId ?? null, import_batch_id: input.batchId ?? null,
    import_row_id: input.importRowId ?? null, source_ref: input.sourceRef ?? null,
    record_status: input.status ?? 'accepted', assurance_level: input.assurance ?? 'verified', dedupe_hash: null,
    duplicate_reviewed: false, is_opening_balance: input.isOpeningBalance ?? false,
    rejected_reason: input.rejectedReason ?? null, superseded_by: input.supersededBy ?? null,
    superseded_at: input.supersededBy ? now : null, promoted_from_batch_id: null, created_at: now, updated_at: now,
  });
  return id;
}

export async function seedInvoice(orgId: string, input: Provenance & {
  type: string; counterpartyId: string; number: string; issueDate: string; dueDate?: string | null;
  subtotal?: string | null; tax?: string | null; total: string; paid?: string; status?: string;
  recordStatus?: string; assurance?: string; paidDate?: string | null; supersededBy?: string | null;
}): Promise<string> {
  const id = newId();
  const now = nowIso();
  const paid = input.paid ?? '0';
  await orgRow(fs(), orgId, 'invoices', id).set({
    id, organization_id: orgId, invoice_type: input.type, counterparty_id: input.counterpartyId,
    invoice_number: input.number, issue_date: input.issueDate, due_date: input.dueDate ?? null,
    period_id: await periodFor(orgId, input.issueDate),
    subtotal: input.subtotal == null ? null : money(input.subtotal), tax_amount: input.tax == null ? null : money(input.tax),
    total_amount: money(input.total), amount_paid: money(paid),
    // The generated column `balance_due = total_amount - amount_paid`.
    balance_due: new Decimal(input.total).minus(paid).toFixed(2),
    currency: 'GBP', status: input.status ?? (new Decimal(paid).eq(input.total) ? 'paid' : 'open'),
    paid_date: input.paidDate ?? null, description: null, source_document_id: input.documentId ?? null,
    import_batch_id: input.batchId ?? null, import_row_id: input.importRowId ?? null, source_ref: input.sourceRef ?? null,
    record_status: input.recordStatus ?? 'accepted', assurance_level: input.assurance ?? 'verified', dedupe_hash: null,
    duplicate_reviewed: false, superseded_by: input.supersededBy ?? null, superseded_at: input.supersededBy ? now : null,
    promoted_from_batch_id: null, created_at: now, updated_at: now, rejected_reason: null,
  });
  return id;
}

export async function seedBankAccount(orgId: string, input: {
  name: string; accountType?: string; openingBalance?: string | null; openingBalanceDate?: string | null;
}): Promise<string> {
  const id = newId();
  const now = nowIso();
  await orgRow(fs(), orgId, 'bank_accounts', id).set({
    id, organization_id: orgId, name: input.name, bank_name: 'Test Bank', account_number_masked: null,
    sort_code_masked: null, currency: 'GBP', account_type: input.accountType ?? 'current', ledger_account_id: null,
    opening_balance: input.openingBalance == null ? null : money(input.openingBalance),
    opening_balance_date: input.openingBalanceDate ?? null, is_active: true, created_at: now, updated_at: now,
  });
  return id;
}

export async function seedBankTransaction(orgId: string, input: Provenance & {
  bankAccountId: string; date: string; amount: string | number; description?: string | null;
  counterpartyId?: string | null; categoryAccountId?: string | null; categorySource?: string;
  isTransfer?: boolean; transferKind?: string; status?: string;
}): Promise<string> {
  const id = newId();
  const now = nowIso();
  await orgRow(fs(), orgId, 'bank_transactions', id).set({
    id, organization_id: orgId, bank_account_id: input.bankAccountId, transaction_date: input.date, posted_date: null,
    period_id: await periodFor(orgId, input.date), amount: money(input.amount), currency: 'GBP',
    description_raw: input.description ?? null, description_normalized: input.description ?? null,
    counterparty_name_raw: null, counterparty_id: input.counterpartyId ?? null,
    category_account_id: input.categoryAccountId ?? null, category_source: input.categorySource ?? 'none',
    balance_after: null, reference: null, is_transfer: input.isTransfer ?? false, transfer_pair_id: null,
    transfer_kind: input.transferKind ?? 'none', recurring_group_id: null, matched_ledger_entry_id: null,
    source_document_id: input.documentId ?? null, import_batch_id: input.batchId ?? null,
    import_row_id: input.importRowId ?? null, source_ref: input.sourceRef ?? null,
    record_status: input.status ?? 'accepted', assurance_level: 'verified', dedupe_hash: null,
    duplicate_reviewed: false, superseded_by: null, superseded_at: null, promoted_from_batch_id: null,
    created_at: now, updated_at: now, rejected_reason: null,
  });
  // The `open_category_history` trigger (`app.open_bank_category_history`).
  const historyId = newId();
  await orgRow(fs(), orgId, 'category_history', historyId).set({
    id: historyId, organization_id: orgId, bank_transaction_id: id, category_account_id: input.categoryAccountId ?? null,
    is_transfer: input.isTransfer ?? false, transfer_kind: input.transferKind ?? 'none',
    source: input.categorySource ?? 'none', valid_from: now, valid_to: null, changed_by: null, created_at: now,
  });
  return id;
}

/** One lifecycle event, as `api.commit_import_batch` writes it (`app.record_status_event`). */
export async function seedStatusEvent(orgId: string, input: {
  table: string; recordId: string; event: string; batchId?: string | null; relatedId?: string | null;
}): Promise<void> {
  const id = newId();
  await orgRow(fs(), orgId, 'record_status_events', id).set({
    id, organization_id: orgId, record_table: input.table, record_id: input.recordId, event: input.event,
    related_record_id: input.relatedId ?? null, import_batch_id: input.batchId ?? null, actor_user_id: null,
    at: nowIso(),
  });
}

/** A queued `calculation.run` job, as the old fixture inserted into `jobs`. Returns its id. */
export async function queueCalculation(orgId: string, payload: Record<string, unknown>): Promise<string> {
  const id = newId();
  const now = nowIso();
  await fs().collection('jobs').doc(id).set({
    id, organization_id: orgId, job_type: 'calculation.run', idempotency_key: null, payload,
    requested_by: null, status: 'queued', attempts: 0, max_attempts: 3, run_after: now, locked_at: null,
    locked_by: null, last_error: null, result: null, finished_at: null, created_at: now, updated_at: now,
  });
  return id;
}

/** Removes the jobs a suite queued for its organisations (jobs are top-level, not under the org). */
export async function deleteJobsOf(orgId: string): Promise<void> {
  const snap = await fs().collection('jobs').where('organization_id', '==', orgId).get();
  await Promise.all(snap.docs.map((d) => d.ref.delete()));
}

/**
 * The current cells of one figure (`metric_current` for a period and metric): the org-wide one when
 * `dimensionId` is null (`dimension_type = 'none'`), else the one for that dimension row.
 */
export async function currentCells(
  orgId: string, period: string, metricKey: string, dimensionId: string | null = null,
): Promise<FirebaseFirestore.DocumentData[]> {
  let q: FirebaseFirestore.Query = orgCollection(fs(), orgId, 'metric_current').where('period_id', '==', period)
    .where('metric_key', '==', metricKey);
  q = dimensionId === null ? q.where('dimension_type', '==', 'none') : q.where('dimension_id', '==', dimensionId);
  return (await q.get()).docs.map((d) => d.data());
}

/** The current snapshot behind one figure (`metric_current` ⋈ `metric_snapshots`), or null. */
export async function currentSnapshot(
  orgId: string, period: string, metricKey: string, dimensionId: string | null = null,
): Promise<FirebaseFirestore.DocumentData | null> {
  const cell = (await currentCells(orgId, period, metricKey, dimensionId))[0];
  if (!cell) return null;
  const snap = await orgRow(fs(), orgId, 'metric_snapshots', String(cell.snapshot_id)).get();
  return snap.exists ? snap.data()! : null;
}

/** The descriptor a figure's evidence query carries; null for no cell or a JSON-null query. */
export async function descriptorOfFigure(
  orgId: string, period: string, metricKey: string, dimensionId: string | null = null,
): Promise<unknown> {
  const q = ((await currentSnapshot(orgId, period, metricKey, dimensionId))?.evidence_query ?? null) as { descriptor: unknown } | null;
  return q === null ? null : q.descriptor;
}

/** The figure's value to the penny. */
export async function figureOf(
  orgId: string, period: string, metricKey: string, dimensionId: string | null = null,
): Promise<string> {
  return new Decimal(String((await currentSnapshot(orgId, period, metricKey, dimensionId))?.value)).toFixed(2);
}

/** Deletes the Auth accounts (and their profiles) under one run's email domain. */
export async function deleteAuthUsers(domain: string): Promise<void> {
  const { auth } = await import('@/db/firestore');
  let page = await auth().listUsers(1000);
  for (;;) {
    const doomed = page.users.filter((u) => u.email?.endsWith(`@${domain}`));
    if (doomed.length > 0) {
      await auth().deleteUsers(doomed.map((u) => u.uid));
      await Promise.all(doomed.map((u) => fs().collection('profiles').doc(u.uid).delete()));
    }
    if (!page.pageToken) break;
    page = await auth().listUsers(1000, page.pageToken);
  }
}

/**
 * `drainJobs` for a suite that shares the emulator's queue with other suites running at the same
 * time. A job another suite claimed-and-deleted (its teardown removing its own jobs) makes
 * `finishJob` report NOT_FOUND; that is the other suite's business, not a failure of this one, so it
 * is ignored here and the drain goes on. Anything else is still thrown.
 */
export async function drainShared(max: number): Promise<unknown> {
  const { drainJobs } = await import('@/modules/jobs');
  try {
    return await drainJobs(max);
  } catch (error) {
    if (/could not record the outcome of job .*Not found/i.test(String((error as Error)?.message ?? error))) return null;
    throw error;
  }
}

/**
 * Removes the recalculation a write queued for the organisation (`remap_account`,
 * `override_bank_category`, `rollback_import_batch` each ask for one). The evidence suites assert
 * what a PUBLISHED figure's evidence does after the data changes; on PostgreSQL the queued run waited
 * for this suite's next drain, but on the shared emulators another suite's drain would run it in the
 * middle, re-publishing every figure. Taking it out of the queue keeps the published figures fixed.
 */
export async function dropQueuedRecalculation(orgId: string): Promise<void> {
  const snap = await fs().collection('jobs').where('organization_id', '==', orgId).where('status', '==', 'queued').get();
  for (const d of snap.docs) {
    if (d.get('job_type') !== 'calculation.run') continue;
    const key = d.get('idempotency_key') as string | null;
    if (key) await uniqueGuard(fs(), 'global', 'jobs_idempotency_queued', ['calculation.run', key]).ref.delete();
    await d.ref.delete();
  }
}
