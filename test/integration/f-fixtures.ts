import { expect } from 'vitest';
import type { DocumentData } from 'firebase-admin/firestore';
import { auth } from '@/db/firestore';
import { ensurePeriods, monthStart, normalizeName, periodId } from '@/db/app/shared';
import { Decimal } from '@/core/money';
import { globalRow, metricCellId, newId, nowIso, orgCollection, orgRow, uniqueGuard, type OrgTable } from '@/db/schema';
import { clientFor, deleteOrg, drainUntilFinished, fs, rpc } from './setup';

/**
 * Fixtures for the Financials, Banking, Commercial, Marketing, Engagement and Budgets suites (Team F),
 * written in the shapes FIRESTORE_DATA_MODEL.md §3 gives: every column present (NULL as null) with
 * the defaults the PostgreSQL tables had, and what their insert triggers did (the fiscal period of a
 * dated row, the derived normalised name, the opening `category_history` row of a bank transaction).
 *
 * Organisations are made by the real `api.create_organization`; the suites assert through
 * `clientFor` and the real `api.*` functions. Each suite deletes exactly what it created.
 */

type Row = DocumentData;

export async function ok<T>(p: Promise<{ data: T | null; error: unknown }>): Promise<T> {
  const r = await p;
  expect(r.error, r.error ? String((r.error as Error).message ?? r.error) : undefined).toBeNull();
  return r.data as T;
}

/** `api.create_organization` for `ownerId`: the organisation, its owner, the standard chart, the months. */
export async function makeOrg(
  ownerId: string, name: string, options: { baseCurrency?: string; countryCode?: string; timezone?: string } = {},
): Promise<string> {
  const args: Record<string, unknown> = { p_name: name };
  if (options.baseCurrency) args.p_base_currency = options.baseCurrency;
  if (options.countryCode) args.p_country_code = options.countryCode;
  if (options.timezone) args.p_timezone = options.timezone;
  const { data, error } = await rpc<string>(clientFor(ownerId), 'create_organization', args);
  if (error) throw new Error(`create_organization: ${error.message}`);
  const id = data as string;
  // The suites post into 2026 months the rolling window may not reach in every year they run.
  await ensurePeriods(fs(), id, '2026-01-01', '2026-12-31');
  return id;
}

export async function addMember(orgId: string, userId: string, role: string, status = 'active'): Promise<void> {
  const now = nowIso();
  await orgRow(fs(), orgId, 'organization_memberships', userId).set({
    id: newId(), organization_id: orgId, user_id: userId, role, status, invited_by: null,
    joined_at: now, created_at: now, updated_at: now, departments: null, departments_set_by_owner: false,
  });
}

export async function addPlatformUser(userId: string, role: 'super_admin' | 'employee'): Promise<void> {
  const now = nowIso();
  await globalRow(fs(), 'platform_users', userId).set({
    user_id: userId, platform_role: role, status: 'active', granted_by: null, notes: null, created_at: now, updated_at: now,
  });
}

export async function assign(orgId: string, employeeId: string): Promise<void> {
  const now = nowIso();
  await orgRow(fs(), orgId, 'organization_assignments', employeeId).set({
    id: newId(), organization_id: orgId, employee_user_id: employeeId, status: 'active', assigned_by: null,
    starts_at: null, ends_at: null, revoked_at: null, revoked_by: null, notes: null, created_at: now, updated_at: now,
  });
}

/** The fiscal period a date falls in (`app.period_assign`), created when missing. */
export async function periodFor(orgId: string, date: string): Promise<string> {
  await ensurePeriods(fs(), orgId, date, date);
  return periodId(orgId, monthStart(date));
}

/** The system account of a standard category (`app.seed_standard_chart`). */
export async function systemAccount(orgId: string, category: string): Promise<string> {
  const snap = await orgCollection(fs(), orgId, 'accounts').where('standard_category', '==', category)
    .where('is_system', '==', true).limit(1).get();
  if (snap.empty) throw new Error(`no system ${category} account in ${orgId}`);
  return snap.docs[0]!.id;
}

/** One row by id, read as the server (fixture checks only — never what a user can see). */
export async function rowOf(orgId: string, table: OrgTable, id: string): Promise<Row | null> {
  const snap = await orgRow(fs(), orgId, table, id).get();
  return snap.exists ? snap.data()! : null;
}

/** Rows of a table, optionally filtered by equality, read as the server. */
export async function rowsOf(orgId: string, table: OrgTable, where: Record<string, unknown> = {}): Promise<Row[]> {
  let q: FirebaseFirestore.Query = orgCollection(fs(), orgId, table);
  for (const [k, v] of Object.entries(where)) q = q.where(k, '==', v);
  return (await q.get()).docs.map((d) => d.data());
}

export async function orgOf(orgId: string): Promise<Row> {
  return (await globalRow(fs(), 'organizations', orgId).get()).data()!;
}

/** Audit events of an organisation with one action, read as the server. */
export async function auditsOf(orgId: string, action: string): Promise<Row[]> {
  const snap = await fs().collection('audit_events').where('organization_id', '==', orgId).where('action', '==', action).get();
  return snap.docs.map((d) => d.data());
}

export async function seedCounterparty(orgId: string, input: {
  name: string; kind?: string; normalizedName?: string; mergedIntoId?: string | null; defaultExpenseCategory?: string | null;
}): Promise<string> {
  const id = newId();
  const now = nowIso();
  const normalized = input.normalizedName ?? normalizeName(input.name);
  await fs().runTransaction(async (tx) => {
    tx.set(orgRow(fs(), orgId, 'counterparties', id), {
      id, organization_id: orgId, name: input.name, normalized_name: normalized, kind: input.kind ?? 'unknown',
      default_expense_category: input.defaultExpenseCategory ?? null, external_ref: null, email: null, notes: null,
      is_active: true, merged_into_id: input.mergedIntoId ?? null, created_at: now, updated_at: now,
    });
    tx.set(uniqueGuard(fs(), { orgId }, 'counterparties_org_normalized_unique', [normalized]).ref, {
      owner_id: id, constraint: 'counterparties_org_normalized_unique', created_at: now,
    });
  });
  return id;
}

/** An imported account, with its guard and its first `account_category_history` interval (the insert trigger). */
export async function seedAccount(orgId: string, input: { name: string; category: string; accountType: string; code?: string | null }): Promise<string> {
  const id = newId();
  const historyId = newId();
  const now = nowIso();
  const normalized = normalizeName(input.name);
  const batch = fs().batch();
  batch.set(orgRow(fs(), orgId, 'accounts', id), {
    id, organization_id: orgId, code: input.code ?? null, name: input.name, normalized_name: normalized,
    account_type: input.accountType, standard_category: input.category, is_system: false, is_active: true,
    source: 'imported', external_ref: null, mapping_confidence: 'unmapped', loan_security: null, created_at: now, updated_at: now,
  });
  batch.set(uniqueGuard(fs(), { orgId }, 'accounts_org_normalized_unique', [normalized]).ref, {
    owner_id: id, constraint: 'accounts_org_normalized_unique', created_at: now,
  });
  batch.set(orgRow(fs(), orgId, 'account_category_history', historyId), {
    id: historyId, organization_id: orgId, account_id: id, standard_category: input.category,
    valid_from: now, valid_to: null, changed_by: null, created_at: now,
  });
  await batch.commit();
  return id;
}

export async function seedImportRow(orgId: string, input: {
  batchId: string; rowNumber: number; status: string; duplicateOfTable?: string | null; duplicateOfId?: string | null;
  sourceRef?: string | null;
}): Promise<string> {
  const id = newId();
  const now = nowIso();
  await orgRow(fs(), orgId, 'import_rows', id).set({
    id, organization_id: orgId, batch_id: input.batchId, row_number: input.rowNumber, source_ref: input.sourceRef ?? null,
    raw_data: {}, mapped_data: {}, status: input.status, issues: [], dedupe_hash: null,
    duplicate_of_table: input.duplicateOfTable ?? null, duplicate_of_id: input.duplicateOfId ?? null,
    duplicate_within_batch_row_id: null, reviewer_decision: 'none', reviewer_reason: null, committed_table: null,
    committed_record_id: null, created_at: now, updated_at: now, fixed_by: null, fixed_at: null, source_page: null,
  });
  return id;
}

export async function seedBankAccount(orgId: string, input: {
  name: string; type?: string; currency?: string; sortCode?: string | null; accountNumber?: string | null;
  openingBalance?: string | null; openingBalanceDate?: string | null; bankName?: string;
}): Promise<string> {
  const id = newId();
  const now = nowIso();
  const currency = input.currency ?? String((await orgOf(orgId)).base_currency ?? 'GBP');
  await orgRow(fs(), orgId, 'bank_accounts', id).set({
    id, organization_id: orgId, name: input.name, bank_name: input.bankName ?? 'Test Bank',
    account_number_masked: input.accountNumber ?? null, sort_code_masked: input.sortCode ?? null,
    currency, account_type: input.type ?? 'current', ledger_account_id: null,
    opening_balance: input.openingBalance ?? null, opening_balance_date: input.openingBalanceDate ?? null,
    is_active: true, created_at: now, updated_at: now,
  });
  return id;
}

export interface Provenance {
  readonly importBatchId?: string | null;
  readonly sourceDocumentId?: string | null;
  readonly recordStatus?: string;
}

/** A bank row, with the period it falls in and its opening `category_history` row. */
export async function seedBankTxn(orgId: string, input: Provenance & {
  bankAccountId: string; date: string; amount: string; description: string; currency?: string;
  categoryAccountId?: string | null; categorySource?: string; balanceAfter?: string | null;
  isTransfer?: boolean; transferKind?: string; counterpartyId?: string | null; descriptionRaw?: string | null;
  importRowId?: string | null; sourceRef?: string | null; duplicateReviewed?: boolean; currencyCode?: string;
}): Promise<string> {
  const id = newId();
  const now = nowIso();
  const period = await periodFor(orgId, input.date);
  const currency = input.currency ?? String((await orgOf(orgId)).base_currency ?? 'GBP');
  const historyId = newId();
  const batch = fs().batch();
  batch.set(orgRow(fs(), orgId, 'bank_transactions', id), {
    id, organization_id: orgId, bank_account_id: input.bankAccountId, transaction_date: input.date, posted_date: null,
    period_id: period, amount: input.amount, currency, description_raw: input.descriptionRaw ?? input.description,
    description_normalized: input.description, counterparty_name_raw: null, counterparty_id: input.counterpartyId ?? null,
    category_account_id: input.categoryAccountId ?? null, category_source: input.categorySource ?? 'none',
    balance_after: input.balanceAfter ?? null, reference: null, is_transfer: input.isTransfer ?? false,
    transfer_pair_id: null, transfer_kind: input.transferKind ?? 'none', recurring_group_id: null,
    matched_ledger_entry_id: null, source_document_id: input.sourceDocumentId ?? null,
    import_batch_id: input.importBatchId ?? null, import_row_id: input.importRowId ?? null, source_ref: input.sourceRef ?? null,
    record_status: input.recordStatus ?? 'accepted', assurance_level: 'verified', dedupe_hash: null,
    duplicate_reviewed: input.duplicateReviewed ?? false, superseded_by: null, superseded_at: null, promoted_from_batch_id: null,
    rejected_reason: null, created_at: now, updated_at: now,
  });
  batch.set(orgRow(fs(), orgId, 'category_history', historyId), {
    id: historyId, organization_id: orgId, bank_transaction_id: id, category_account_id: input.categoryAccountId ?? null,
    is_transfer: input.isTransfer ?? false, transfer_kind: input.transferKind ?? 'none',
    source: input.categorySource ?? 'none', valid_from: now, valid_to: null, changed_by: null, created_at: now,
  });
  await batch.commit();
  return id;
}

export async function seedInvoice(orgId: string, input: Provenance & {
  counterpartyId: string; type: string; number: string; issueDate: string; dueDate?: string | null;
  subtotal?: string | null; tax?: string | null; total: string; amountPaid?: string; status?: string; currency?: string;
}): Promise<string> {
  const id = newId();
  const now = nowIso();
  const period = await periodFor(orgId, input.issueDate);
  const paid = input.amountPaid ?? '0.00';
  await orgRow(fs(), orgId, 'invoices', id).set({
    id, organization_id: orgId, invoice_type: input.type, counterparty_id: input.counterpartyId,
    invoice_number: input.number, issue_date: input.issueDate, due_date: input.dueDate === undefined ? input.issueDate : input.dueDate,
    period_id: period, subtotal: input.subtotal ?? null, tax_amount: input.tax ?? null, total_amount: input.total,
    amount_paid: paid, balance_due: new Decimal(input.total).minus(paid).toFixed(2),
    currency: input.currency ?? String((await orgOf(orgId)).base_currency ?? 'GBP'), status: input.status ?? 'open',
    paid_date: null, description: null, source_document_id: input.sourceDocumentId ?? null,
    import_batch_id: input.importBatchId ?? null, import_row_id: null, source_ref: null,
    record_status: input.recordStatus ?? 'accepted', assurance_level: 'verified', dedupe_hash: null,
    duplicate_reviewed: false, superseded_by: null, superseded_at: null, promoted_from_batch_id: null,
    rejected_reason: null, created_at: now, updated_at: now,
  });
  return id;
}

export async function seedLedgerEntry(orgId: string, input: Provenance & {
  accountId: string; date: string; direction: 'debit' | 'credit'; amount: string; journalRef?: string | null;
  description?: string | null; counterpartyId?: string | null; isOpeningBalance?: boolean;
  importRowId?: string | null; sourceRef?: string | null;
}): Promise<string> {
  const id = newId();
  const now = nowIso();
  const period = await periodFor(orgId, input.date);
  await orgRow(fs(), orgId, 'ledger_entries', id).set({
    id, organization_id: orgId, entry_date: input.date, period_id: period, account_id: input.accountId,
    direction: input.direction, amount: input.amount, currency: String((await orgOf(orgId)).base_currency ?? 'GBP'),
    description: input.description ?? null, reference: null, counterparty_id: input.counterpartyId ?? null,
    journal_ref: input.journalRef ?? null, source_document_id: input.sourceDocumentId ?? null,
    import_batch_id: input.importBatchId ?? null, import_row_id: input.importRowId ?? null, source_ref: input.sourceRef ?? null,
    record_status: input.recordStatus ?? 'accepted', assurance_level: 'verified', dedupe_hash: null,
    duplicate_reviewed: false, is_opening_balance: input.isOpeningBalance ?? false, rejected_reason: null,
    superseded_by: null, superseded_at: null, promoted_from_batch_id: null, created_at: now, updated_at: now,
  });
  return id;
}

export async function seedDocument(orgId: string, input: { filename: string; kind: string; mime?: string }): Promise<string> {
  const id = newId();
  const now = nowIso();
  await orgRow(fs(), orgId, 'source_documents', id).set({
    id, organization_id: orgId, storage_bucket: 'documents', storage_path: `${orgId}/${id}/${input.filename}`,
    original_filename: input.filename, mime_type: input.mime ?? 'text/csv', byte_size: 10, sha256: id.replace(/-/g, ''),
    status: 'ready', document_kind: input.kind, uploaded_by: null, page_count: null, deleted_at: null,
    created_at: now, updated_at: now,
  });
  return id;
}

export async function seedBatch(orgId: string, input: {
  documentId: string | null; importType: string; targetTable: string; status?: string; method?: string;
  periodStart?: string | null; periodEnd?: string | null; bankAccountId?: string | null; invoiceListKind?: string | null;
  openingBalance?: string | null; closingBalance?: string | null; issues?: unknown[]; committedAt?: string | null;
  reviewedBy?: string | null;
}): Promise<string> {
  const id = newId();
  const now = nowIso();
  const status = input.status ?? 'committed';
  await orgRow(fs(), orgId, 'import_batches', id).set({
    id, organization_id: orgId, source_document_id: input.documentId, import_type: input.importType,
    target_table: input.targetTable, bank_account_id: input.bankAccountId ?? null, mapping_id: null, mapping_snapshot: null,
    status, row_counts: {}, period_start: input.periodStart ?? null, period_end: input.periodEnd ?? null,
    statement_opening_balance: input.openingBalance ?? null, statement_closing_balance: input.closingBalance ?? null,
    balance_sign: 'natural', fiscal_year_start_month_at_commit: null, invoice_list_kind: input.invoiceListKind ?? null,
    balance_basis: null, extraction_method: input.method ?? 'csv', pages_extracted: null, pages_failed: null,
    created_by: null, reviewed_by: input.reviewedBy ?? null,
    committed_at: input.committedAt !== undefined ? input.committedAt : (status === 'committed' ? now : null),
    rolled_back_at: null, rolled_back_reason: null, replaced_batch_id: null, error_summary: null,
    calculation_job_id: null, calculation_run_id: null, created_at: now, updated_at: now,
    batch_issues: input.issues ?? [], confirmations: {}, required_confirmations: [], page_confirmations: {},
    review_token: newId(), extraction_stats: {},
  });
  return id;
}

export interface SnapshotInput {
  readonly periodId: string;
  readonly key: string;
  readonly value: string | null;
  readonly dimensionType?: string;
  readonly dimensionId?: string | null;
  readonly dimensionKey?: string | null;
  readonly components?: Record<string, unknown>;
  readonly unit?: string;
  readonly basis?: string;
  readonly currency?: string | null;
  readonly dataQuality?: Record<string, unknown>;
}

/**
 * One succeeded calculation run and every snapshot and `metric_current` pointer in it, written as
 * the engine writes them. Returns the run id and each snapshot's id, in input order.
 */
export async function writeRun(orgId: string, snaps: readonly SnapshotInput[], options: { asOf?: string } = {}): Promise<{ runId: string; snapshotIds: string[] }> {
  const runId = newId();
  const now = nowIso();
  const first = snaps[0]!.periodId;
  const writer = fs().bulkWriter();
  void writer.set(orgRow(fs(), orgId, 'calculation_runs', runId), {
    id: runId, organization_id: orgId, job_id: null, trigger: 'recalc_manual', trigger_ref_id: null, engine_version: '1.0.0',
    period_from: first, period_to: first, as_of: options.asOf ?? '2026-10-01', as_of_ts: now, status: 'succeeded',
    failure_reason: null, stale: false, input_fingerprint: null, chunks: [], progress: {}, started_at: now, finished_at: now,
    duration_ms: 1, error: null, stats: {}, created_at: now, updated_at: now,
  });
  const snapshotIds: string[] = [];
  for (const s of snaps) {
    const id = newId();
    snapshotIds.push(id);
    const dimensionType = s.dimensionType ?? 'none';
    void writer.set(orgRow(fs(), orgId, 'metric_snapshots', id), {
      id, organization_id: orgId, calculation_run_id: runId, period_id: s.periodId, metric_key: s.key,
      dimension_type: dimensionType, dimension_id: s.dimensionId ?? null, value: s.value, unit: s.unit ?? 'money',
      currency: s.currency === undefined ? 'GBP' : s.currency, basis: s.basis ?? 'ledger', assurance_level: 'verified',
      data_quality: s.dataQuality ?? { completeness: 1, proxy: false, warnings: [], missing: [] },
      components: s.components ?? {}, evidence_query: null, created_at: now, dimension_key: s.dimensionKey ?? null,
    });
    const cell = metricCellId({
      period_id: s.periodId, metric_key: s.key, dimension_type: dimensionType,
      dimension_id: s.dimensionId ?? null, dimension_key: s.dimensionKey ?? null,
    });
    void writer.set(orgRow(fs(), orgId, 'metric_current', cell), {
      organization_id: orgId, period_id: s.periodId, metric_key: s.key, dimension_type: dimensionType,
      dimension_id: s.dimensionId ?? null, snapshot_id: id, calculation_run_id: runId, previous_snapshot_id: null,
      updated_at: now, dimension_key: s.dimensionKey ?? null,
    });
  }
  await writer.close();
  return { runId, snapshotIds };
}

/** The engine's current value of one figure (`metric_current` → its snapshot), or null. */
export async function currentValue(orgId: string, periodId: string, key: string, where: { dimensionType?: string; dimensionId?: string; dimensionKey?: string } = {}): Promise<string | null> {
  let q: FirebaseFirestore.Query = orgCollection(fs(), orgId, 'metric_current').where('period_id', '==', periodId).where('metric_key', '==', key);
  q = q.where('dimension_type', '==', where.dimensionType ?? 'none');
  if (where.dimensionId) q = q.where('dimension_id', '==', where.dimensionId);
  if (where.dimensionKey) q = q.where('dimension_key', '==', where.dimensionKey);
  const cell = (await q.limit(1).get()).docs[0];
  if (!cell) return null;
  const snap = await orgRow(fs(), orgId, 'metric_snapshots', String(cell.get('snapshot_id'))).get();
  return snap.exists ? ((snap.get('value') as string | null) ?? null) : null;
}

/** A queued `calculation.run`, as the suites' `insert into public.jobs` made one; returns its id. */
export async function queueCalculation(orgId: string, payload: Record<string, unknown>): Promise<string> {
  const id = newId();
  const now = nowIso();
  await globalRow(fs(), 'jobs', id).set({
    id, organization_id: orgId, job_type: 'calculation.run', idempotency_key: null, payload,
    requested_by: null, status: 'queued', attempts: 0, max_attempts: 3, run_after: now, locked_at: null,
    locked_by: null, last_error: null, result: null, finished_at: null, created_at: now, updated_at: now,
  });
  return id;
}

/** The earliest fiscal period of an organisation. */
export async function earliestPeriod(orgId: string): Promise<string> {
  const snap = await orgCollection(fs(), orgId, 'fiscal_periods').orderBy('period_start').limit(1).get();
  return snap.docs[0]!.id;
}

/**
 * A full calculation from the organisation's earliest month (`banking_edit`, which never
 * short-circuits on a changed input), drained until it finishes.
 */
export async function calculate(orgId: string, drain: (max: number) => Promise<unknown>, asOf = '2026-09-15'): Promise<string> {
  const jobId = await queueCalculation(orgId, { trigger: 'banking_edit', period_ids: [await earliestPeriod(orgId)], as_of: asOf });
  expect(await drainUntilFinished(drain, jobId), 'the calculation job must succeed').toBe('succeeded');
  return jobId;
}

/**
 * Moves every queued job of the organisation a month out, so no worker on the shared emulator runs
 * it: for a suite that writes the engine's snapshots by hand and must not have a real run (the one
 * `api.create_organization` queues, or a remap's) replace them mid-test.
 */
export async function parkQueuedJobs(orgId: string): Promise<void> {
  const queued = await fs().collection('jobs').where('organization_id', '==', orgId).where('status', '==', 'queued').get();
  const later = new Date(Date.now() + 30 * 86_400_000).toISOString();
  for (const d of queued.docs) await d.ref.update({ run_after: later });
}

/** Drains until the organisation has no queued or running job left. */
export async function drainUntilQuiet(orgId: string, drain: (max: number) => Promise<unknown>, rounds = 10): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    const open = await fs().collection('jobs').where('organization_id', '==', orgId)
      .where('status', 'in', ['queued', 'running']).get();
    if (open.empty) return;
    await drain(20);
  }
}

/** Deletes the organisations, their jobs and audit events, and the sign-in accounts of a domain. */
export async function dropFixtures(orgIds: ReadonlyArray<string | undefined>, domain: string): Promise<void> {
  for (const orgId of orgIds) {
    if (!orgId) continue;
    for (const table of ['jobs', 'audit_events'] as const) {
      const snap = await fs().collection(table).where('organization_id', '==', orgId).get();
      const writer = fs().bulkWriter();
      for (const d of snap.docs) void writer.delete(d.ref);
      await writer.close();
    }
    await deleteOrg(orgId);
  }
  let page = await auth().listUsers(1000);
  for (;;) {
    const doomed = page.users.filter((u) => u.email?.endsWith(`@${domain}`));
    if (doomed.length > 0) {
      await auth().deleteUsers(doomed.map((u) => u.uid));
      for (const u of doomed) {
        await fs().collection('profiles').doc(u.uid).delete();
        await fs().collection('platform_users').doc(u.uid).delete();
      }
    }
    if (!page.pageToken) break;
    page = await auth().listUsers(1000, page.pageToken);
  }
}
