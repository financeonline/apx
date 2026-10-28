import { createHash } from 'node:crypto';
import { Decimal } from '@/core/money/decimal';
import type { Firestore } from 'firebase-admin/firestore';
import { ensurePeriods, monthStart, normalizeName, periodId, writeStandardChart } from '@/db/app/shared';
import { metricCellId, newId, nowIso, orgCollection, orgRow, uniqueGuard } from '@/db/schema';
import { createAuthUser, fs } from '../integration/setup';

/**
 * Fixture writers for the Firestore emulator (FIRESTORE_DATA_MODEL.md §3, §9).
 *
 * The PostgreSQL fixtures inserted rows with `adminSql` and let the column defaults and triggers
 * fill in the rest (`period_assign`, `derive_normalized_name`, `mask_description`,
 * `open_bank_category_history`, the generated `balance_due`). Firestore has neither, so each writer
 * here stores the WHOLE row — every column, NULL as `null`, money as a decimal string — with what
 * those defaults and triggers would have produced. What the engine and the pages read is therefore
 * the same document an import commit writes.
 *
 * Fixtures only: a test asserts through `clientFor` and the real `api.*` functions, never through
 * these.
 */

const money = (v: string | number | null | undefined): string | null =>
  (v === null || v === undefined ? null : new Decimal(v).toFixed(2));

export interface SeededOrg {
  readonly orgId: string;
  readonly ownerId: string;
  /** standard_category → the system account's id. */
  readonly accounts: Readonly<Record<string, string>>;
}

/**
 * What `api.create_organization` leaves: the organisation, the owner's membership, the standard
 * chart, and fiscal periods twelve months back and eleven forward of `around` (default: now).
 */
export async function seedOrg(input: {
  name: string;
  ownerEmail?: string;
  ownerId?: string;
  fiscalYearStartMonth?: number;
  features?: Record<string, unknown>;
  timezone?: string;
  baseCurrency?: string;
  status?: string;
  around?: string;
}): Promise<SeededOrg> {
  const f = fs();
  const ownerId = input.ownerId ?? await createAuthUser(input.ownerEmail ?? `owner-${newId()}@seed.itest.motion`);
  const orgId = newId();
  const now = nowIso();
  const slug = `itest-${orgId.slice(0, 8)}`;
  await f.collection('organizations').doc(orgId).set({
    id: orgId, slug, name: input.name, legal_name: null, country_code: 'GB',
    base_currency: input.baseCurrency ?? 'GBP', fiscal_year_start_month: input.fiscalYearStartMonth ?? 1,
    industry: null, kind: 'customer', status: input.status ?? 'active', plan: 'trial',
    features: input.features ?? {}, settings: {}, timezone: input.timezone ?? 'Europe/London',
    deletion_requested_at: null, created_by: ownerId, deleted_at: null, created_at: now, updated_at: now,
  });
  await seedMember(orgId, ownerId, 'owner');
  await f.runTransaction(async (tx) => { writeStandardChart(tx, f, orgId); });
  const around = input.around ? new Date(`${input.around}T00:00:00Z`) : new Date();
  const from = new Date(Date.UTC(around.getUTCFullYear(), around.getUTCMonth() - 12, 1)).toISOString().slice(0, 10);
  const to = new Date(Date.UTC(around.getUTCFullYear(), around.getUTCMonth() + 11, 1)).toISOString().slice(0, 10);
  await ensurePeriods(f, orgId, from, to);
  const chart = await orgCollection(f, orgId, 'accounts').where('is_system', '==', true).get();
  const accounts: Record<string, string> = {};
  for (const d of chart.docs) accounts[String(d.get('standard_category'))] = d.id;
  return { orgId, ownerId, accounts };
}

/** An active membership (the document id is the user's id). */
export async function seedMember(orgId: string, userId: string, role: string, status = 'active'): Promise<void> {
  const now = nowIso();
  await orgRow(fs(), orgId, 'organization_memberships', userId).set({
    id: newId(), organization_id: orgId, user_id: userId, role, status, invited_by: null,
    joined_at: now, created_at: now, updated_at: now, departments: null, departments_set_by_owner: false,
  });
}

/** The fiscal period a date falls in, created when missing (the `period_assign` trigger). */
export async function periodFor(orgId: string, date: string): Promise<string> {
  await ensurePeriods(fs(), orgId, date, date);
  return periodId(orgId, monthStart(date));
}

/** Marks months complete or not, as `set_period_completeness` would. */
export async function setComplete(orgId: string, starts: readonly string[], complete = true): Promise<void> {
  for (const s of starts) {
    await orgRow(fs(), orgId, 'fiscal_periods', periodId(orgId, monthStart(s))).update({ is_complete: complete, updated_at: nowIso() });
  }
}

export async function seedAccount(orgId: string, input: {
  name: string; standardCategory: string; accountType: string; code?: string | null; loanSecurity?: string | null;
}): Promise<string> {
  const f = fs();
  const id = newId();
  const now = nowIso();
  const normalized = normalizeName(input.name);
  await f.runTransaction(async (tx) => {
    const claim = await uniqueGuard(f, { orgId }, 'accounts_org_normalized_unique', [normalized]).read(tx);
    claim.take(tx, id);
    tx.set(orgRow(f, orgId, 'accounts', id), {
      id, organization_id: orgId, code: input.code ?? null, name: input.name, normalized_name: normalized,
      account_type: input.accountType, standard_category: input.standardCategory, is_system: false,
      is_active: true, source: 'imported', external_ref: null, mapping_confidence: 'confirmed',
      loan_security: input.loanSecurity ?? null, created_at: now, updated_at: now,
    });
  });
  return id;
}

export async function seedCounterparty(orgId: string, input: {
  name: string; kind?: string; defaultExpenseCategory?: string | null; mergedIntoId?: string | null;
}): Promise<string> {
  const id = newId();
  const now = nowIso();
  await orgRow(fs(), orgId, 'counterparties', id).set({
    id, organization_id: orgId, name: input.name, normalized_name: normalizeName(input.name),
    kind: input.kind ?? 'customer', default_expense_category: input.defaultExpenseCategory ?? null,
    external_ref: null, email: null, notes: null, is_active: true, merged_into_id: input.mergedIntoId ?? null,
    created_at: now, updated_at: now,
  });
  return id;
}

export async function seedBankAccount(orgId: string, input: {
  name?: string; accountType?: string; openingBalance?: string | null; openingBalanceDate?: string | null;
  ledgerAccountId?: string | null; currency?: string;
} = {}): Promise<string> {
  const id = newId();
  const now = nowIso();
  await orgRow(fs(), orgId, 'bank_accounts', id).set({
    id, organization_id: orgId, name: input.name ?? 'Main', bank_name: 'Test Bank', account_number_masked: null,
    sort_code_masked: null, currency: input.currency ?? 'GBP', account_type: input.accountType ?? 'current',
    ledger_account_id: input.ledgerAccountId ?? null, opening_balance: money(input.openingBalance),
    opening_balance_date: input.openingBalance == null ? null : (input.openingBalanceDate ?? null),
    is_active: true, created_at: now, updated_at: now,
  });
  return id;
}

export async function seedDocument(orgId: string, tag: string, kind = 'unknown'): Promise<string> {
  const id = newId();
  const now = nowIso();
  await orgRow(fs(), orgId, 'source_documents', id).set({
    id, organization_id: orgId, storage_bucket: 'source-documents', storage_path: `${orgId}/${id}/${tag}`,
    original_filename: tag, mime_type: 'text/csv', byte_size: 10,
    sha256: createHash('sha256').update(`${orgId}${tag}${id}`).digest('hex'), document_kind: kind,
    page_count: null, has_text_layer: null, extracted_text_path: null, status: 'ready', scan_result: {},
    uploaded_by: null, deleted_at: null, created_at: now, updated_at: now,
  });
  return id;
}

export interface BatchSeed {
  importType: string; target: string; start: string | null; end: string | null;
  status?: string; committedAt?: string | null; bankAccountId?: string | null; listKind?: string | null;
  balanceBasis?: string | null; confirmations?: Record<string, unknown>; documentId?: string;
  statementOpening?: string | null; statementClosing?: string | null; extractionMethod?: string;
  fiscalYearStartMonthAtCommit?: number | null; batchIssues?: unknown[]; createdBy?: string | null;
}

/** A committed (by default) import batch with its own source document. */
export async function seedBatch(orgId: string, input: BatchSeed): Promise<string> {
  const id = newId();
  const now = nowIso();
  const documentId = input.documentId ?? await seedDocument(orgId, `${input.importType}-${id}.csv`);
  await orgRow(fs(), orgId, 'import_batches', id).set({
    id, organization_id: orgId, source_document_id: documentId, import_type: input.importType,
    target_table: input.target, bank_account_id: input.bankAccountId ?? null, mapping_id: null, mapping_snapshot: null,
    status: input.status ?? 'committed', row_counts: {}, period_start: input.start, period_end: input.end,
    statement_opening_balance: money(input.statementOpening), statement_closing_balance: money(input.statementClosing),
    balance_sign: 'natural', fiscal_year_start_month_at_commit: input.fiscalYearStartMonthAtCommit ?? null,
    invoice_list_kind: input.listKind ?? null, balance_basis: input.balanceBasis ?? null,
    extraction_method: input.extractionMethod ?? 'csv', pages_extracted: null, pages_failed: null,
    created_by: input.createdBy ?? null, reviewed_by: null,
    committed_at: (input.status ?? 'committed') === 'committed' ? (input.committedAt ?? now) : (input.committedAt ?? null),
    rolled_back_at: null, rolled_back_reason: null, replaced_batch_id: null, error_summary: null,
    calculation_job_id: null, calculation_run_id: null, created_at: now, updated_at: now,
    batch_issues: input.batchIssues ?? [], confirmations: input.confirmations ?? {}, required_confirmations: [],
    page_confirmations: {}, review_token: newId(), extraction_stats: {},
  });
  return id;
}

let rowNumber = 0;

/** A committed import row naming the record it became. */
export async function seedImportRow(orgId: string, batchId: string, committed?: { table: string; id: string }): Promise<string> {
  rowNumber += 1;
  const id = newId();
  const now = nowIso();
  await orgRow(fs(), orgId, 'import_rows', id).set({
    id, organization_id: orgId, batch_id: batchId, row_number: rowNumber, source_ref: `r${rowNumber}`,
    raw_data: {}, mapped_data: {}, status: 'committed', issues: [], dedupe_hash: null, duplicate_of_table: null,
    duplicate_of_id: null, duplicate_within_batch_row_id: null, reviewer_decision: 'none', reviewer_reason: null,
    committed_table: committed?.table ?? null, committed_record_id: committed?.id ?? null,
    created_at: now, updated_at: now, fixed_by: null, fixed_at: null, source_page: null,
  });
  return id;
}

/** The `accepted` lifecycle event a commit writes; the evidence resolver reads it (EVIDENCE_MODEL.md §3). */
export async function seedAccepted(orgId: string, table: string, recordId: string, batchId: string | null, at?: string): Promise<void> {
  const id = newId();
  await orgRow(fs(), orgId, 'record_status_events', id).set({
    id, organization_id: orgId, record_table: table, record_id: recordId, event: 'accepted',
    related_record_id: null, import_batch_id: batchId, actor_user_id: null, at: at ?? nowIso(),
  });
}

interface Provenance {
  batchId?: string | null; documentId?: string | null; importRowId?: string | null; sourceRef?: string | null;
  recordStatus?: string; assurance?: string; createdAt?: string; supersededBy?: string | null;
}

const provenance = (p: Provenance) => ({
  source_document_id: p.documentId ?? null, import_batch_id: p.batchId ?? null, import_row_id: p.importRowId ?? null,
  source_ref: p.sourceRef ?? null, record_status: p.recordStatus ?? 'accepted', assurance_level: p.assurance ?? 'verified',
  duplicate_reviewed: false, superseded_by: p.supersededBy ?? null, superseded_at: p.supersededBy ? nowIso() : null,
  promoted_from_batch_id: null, rejected_reason: null,
});

export async function seedLedgerEntry(orgId: string, input: Provenance & {
  date: string; accountId: string; direction: 'debit' | 'credit'; amount: string | number;
  counterpartyId?: string | null; description?: string | null; isOpeningBalance?: boolean; journalRef?: string | null;
  currency?: string;
}): Promise<string> {
  const id = newId();
  const now = input.createdAt ?? nowIso();
  await orgRow(fs(), orgId, 'ledger_entries', id).set({
    id, organization_id: orgId, entry_date: input.date, period_id: await periodFor(orgId, input.date),
    account_id: input.accountId, direction: input.direction, amount: money(input.amount), currency: input.currency ?? 'GBP',
    description: input.description ?? null, reference: null, counterparty_id: input.counterpartyId ?? null,
    journal_ref: input.journalRef ?? null, dedupe_hash: null, is_opening_balance: input.isOpeningBalance ?? false,
    ...provenance(input), created_at: now, updated_at: now,
  });
  return id;
}

/** `app.mask_description`: card and sort-code-like digit runs masked, whitespace collapsed. */
export function maskDescription(raw: string | null): string | null {
  let v = raw ?? '';
  v = v.replace(/\b(\d{2})-(\d{2})-(\d{2})\b/g, '****$2$3');
  v = v.replace(/\b\d{2,4}(\d{4})\b/g, '****$1');
  const out = v.replace(/\s+/g, ' ').trim();
  return out === '' ? null : out;
}

export async function seedBankTransaction(orgId: string, input: Provenance & {
  bankAccountId: string; date: string; amount: string | number; description?: string | null;
  counterpartyId?: string | null; categoryAccountId?: string | null; categorySource?: string;
  isTransfer?: boolean; transferKind?: string; transferPairId?: string | null; currency?: string;
  counterpartyNameRaw?: string | null; balanceAfter?: string | null;
}): Promise<string> {
  const f = fs();
  const id = newId();
  const now = input.createdAt ?? nowIso();
  const description = input.description ?? null;
  const transferKind = input.transferKind ?? 'none';
  const row = {
    id, organization_id: orgId, bank_account_id: input.bankAccountId, transaction_date: input.date, posted_date: null,
    period_id: await periodFor(orgId, input.date), amount: money(input.amount), currency: input.currency ?? 'GBP',
    description_raw: description, description_normalized: maskDescription(description),
    counterparty_name_raw: input.counterpartyNameRaw ?? null, counterparty_id: input.counterpartyId ?? null,
    category_account_id: input.categoryAccountId ?? null, category_source: input.categorySource ?? 'none',
    balance_after: money(input.balanceAfter), reference: null, is_transfer: input.isTransfer ?? transferKind !== 'none',
    transfer_pair_id: input.transferPairId ?? null, transfer_kind: transferKind, recurring_group_id: null,
    matched_ledger_entry_id: null, dedupe_hash: null, ...provenance(input), created_at: now, updated_at: now,
  };
  const historyId = newId();
  const batch = f.batch();
  batch.set(orgRow(f, orgId, 'bank_transactions', id), row);
  // `open_category_history`: every transaction starts with an open history row.
  batch.set(orgRow(f, orgId, 'category_history', historyId), {
    id: historyId, organization_id: orgId, bank_transaction_id: id, category_account_id: row.category_account_id,
    is_transfer: row.is_transfer, transfer_kind: row.transfer_kind, source: row.category_source,
    valid_from: now, valid_to: null, changed_by: null, created_at: now,
  });
  await batch.commit();
  return id;
}

export async function seedInvoice(orgId: string, input: Provenance & {
  type: string; counterpartyId: string; number: string; issue: string; due?: string | null;
  subtotal?: string | number | null; tax?: string | number | null; total: string | number;
  paid?: string | number; paidDate?: string | null; status?: string; currency?: string; description?: string | null;
}): Promise<string> {
  const id = newId();
  const now = input.createdAt ?? nowIso();
  const total = money(input.total)!;
  const paid = money(input.paid ?? 0)!;
  await orgRow(fs(), orgId, 'invoices', id).set({
    id, organization_id: orgId, invoice_type: input.type, counterparty_id: input.counterpartyId,
    invoice_number: input.number, issue_date: input.issue, due_date: input.due ?? null,
    period_id: await periodFor(orgId, input.issue), subtotal: money(input.subtotal), tax_amount: money(input.tax),
    total_amount: total, amount_paid: paid, balance_due: new Decimal(total).minus(paid).toFixed(2),
    currency: input.currency ?? 'GBP', status: input.status ?? 'open', paid_date: input.paidDate ?? null,
    description: input.description ?? null, dedupe_hash: null, ...provenance(input), created_at: now, updated_at: now,
  });
  return id;
}

export async function seedPeriodBalance(orgId: string, input: Provenance & {
  periodStart: string; accountId: string; closing: string | number; kind: string; basis: string;
  opening?: string | number | null; debit?: string | number | null; credit?: string | number | null; currency?: string;
}): Promise<string> {
  const id = newId();
  const now = input.createdAt ?? nowIso();
  const start = monthStart(input.periodStart);
  await orgRow(fs(), orgId, 'period_balances', id).set({
    id, organization_id: orgId, period_start: start, period_id: await periodFor(orgId, start),
    account_id: input.accountId, opening_balance: money(input.opening), debit_total: money(input.debit),
    credit_total: money(input.credit), closing_balance: money(input.closing), currency: input.currency ?? 'GBP',
    balance_kind: input.kind, balance_basis: input.basis, ...provenance(input), created_at: now, updated_at: now,
  });
  return id;
}

/** An owner's completeness attestation for one month of a balance batch (or an invoice list's opening). */
export async function seedAttestation(orgId: string, input: {
  batchId: string; periodStart: string; coverage: 'complete' | 'partial'; attestedBy: string; at?: string;
}): Promise<string> {
  const id = newId();
  await orgRow(fs(), orgId, 'report_completeness_attestations', id).set({
    id, organization_id: orgId, import_batch_id: input.batchId, period_start: monthStart(input.periodStart),
    coverage: input.coverage, scope: 'report', origin: 'owner_review', reason: 'fixture', attested_by: input.attestedBy,
    attested_role: 'owner', attested_at: input.at ?? nowIso(), supersedes_id: null,
  });
  return id;
}

/** Deletes every document of the named org tables (a suite's `beforeEach` reset). */
export async function clearTables(orgId: string, tables: readonly Parameters<typeof orgCollection>[2][]): Promise<void> {
  const f: Firestore = fs();
  for (const t of tables) await f.recursiveDelete(orgCollection(f, orgId, t));
}

/**
 * Teardown for a suite that seeded whole organisations: deletes each organisation (and everything
 * under it) and the sign-in accounts whose email contains `emailFragment` (with their profiles) —
 * what `delete from organizations …; delete from auth.users where email like …` did.
 */
export async function removeSeeded(orgIds: readonly string[], emailFragment: string): Promise<void> {
  const f = fs();
  for (const id of orgIds) if (id) await f.recursiveDelete(f.collection('organizations').doc(id));
  if (!emailFragment) return;
  const { auth } = await import('@/db/firestore');
  let page = await auth().listUsers(1000);
  for (;;) {
    const doomed = page.users.filter((u) => u.email?.includes(emailFragment));
    if (doomed.length > 0) {
      await auth().deleteUsers(doomed.map((u) => u.uid));
      for (const u of doomed) await f.collection('profiles').doc(u.uid).delete();
    }
    if (!page.pageToken) break;
    page = await auth().listUsers(1000, page.pageToken);
  }
}

/** The jobs an organisation has, newest first (fixture reads; `created_at` is an ISO string). */
export async function jobsOf(orgId: string, filter: { jobType?: string; status?: string } = {}): Promise<Array<Record<string, unknown>>> {
  let q: FirebaseFirestore.Query = fs().collection('jobs').where('organization_id', '==', orgId);
  if (filter.jobType) q = q.where('job_type', '==', filter.jobType);
  if (filter.status) q = q.where('status', '==', filter.status);
  const snap = await q.get();
  return snap.docs.map((d) => d.data()).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

/** A queued job written directly, as a fixture's `insert into public.jobs` did (no idempotency key). */
export async function seedJob(orgId: string | null, jobType: string, payload: Record<string, unknown>, maxAttempts = 3): Promise<string> {
  const id = newId();
  const now = nowIso();
  await fs().collection('jobs').doc(id).set({
    id, organization_id: orgId, job_type: jobType, idempotency_key: null, payload, requested_by: null,
    status: 'queued', attempts: 0, max_attempts: maxAttempts, run_after: now, locked_at: null, locked_by: null,
    last_error: null, result: null, finished_at: null, created_at: now, updated_at: now,
  });
  return id;
}

/** Platform staff (`platform_users`, keyed by the uid). Never a second super admin: tests share one emulator. */
export async function seedPlatformUser(userId: string, role: 'employee' | 'super_admin' = 'employee'): Promise<void> {
  const now = nowIso();
  await fs().collection('platform_users').doc(userId).set({
    user_id: userId, platform_role: role, status: 'active', granted_by: null, notes: null, created_at: now, updated_at: now,
  });
}

/** An active, in-window assignment of an employee to an organisation (document id: the employee's uid). */
export async function seedAssignment(orgId: string, employeeId: string, assignedBy: string): Promise<void> {
  const now = Date.now();
  await orgRow(fs(), orgId, 'organization_assignments', employeeId).set({
    id: newId(), organization_id: orgId, employee_user_id: employeeId, assigned_by: assignedBy, grantor_organization_id: null,
    status: 'active', starts_at: new Date(now - 86_400_000).toISOString(), ends_at: new Date(now + 30 * 86_400_000).toISOString(),
    revoked_by: null, revoked_reason: null, created_at: nowIso(), updated_at: nowIso(),
  });
}

/**
 * A succeeded calculation run whose current figures are `values` (metric → value per period start),
 * written the way the engine writes them: one `metric_snapshots` row per figure and its
 * `metric_current` pointer (document id `metricCellId`). Returns the run id.
 */
export async function seedCurrentFigures(orgId: string, input: {
  periodStarts: readonly string[]; values: Readonly<Record<string, string>>; asOf: string;
  unit?: string; basis?: string; assurance?: string; complete?: boolean; currency?: string; warnings?: readonly string[];
  /** Dimensioned figures besides the undimensioned `values` (e.g. `expense_by_category` per standard category). */
  cells?: ReadonlyArray<{ metricKey: string; dimensionType: string; dimensionKey: string | null; dimensionId?: string | null; value: string }>;
}): Promise<string> {
  const f = fs();
  const runId = newId();
  const now = nowIso();
  const first = await periodFor(orgId, input.periodStarts[0]!);
  const last = await periodFor(orgId, input.periodStarts.at(-1)!);
  await orgRow(f, orgId, 'calculation_runs', runId).set({
    id: runId, organization_id: orgId, job_id: null, trigger: 'recalc_manual', trigger_ref_id: null, engine_version: '1.0.0',
    period_from: first, period_to: last, as_of: input.asOf, as_of_ts: now, status: 'succeeded', failure_reason: null,
    stale: false, input_fingerprint: null, chunks: [], progress: {}, started_at: now, finished_at: now, duration_ms: 0,
    error: null, stats: {}, created_at: now, updated_at: now,
  });
  const batch = f.batch();
  for (const start of input.periodStarts) {
    const period = await periodFor(orgId, start);
    if (input.complete !== false) batch.update(orgRow(f, orgId, 'fiscal_periods', period), { is_complete: true, updated_at: now });
    const all = [
      ...Object.entries(input.values).map(([metricKey, value]) => ({ metricKey, dimensionType: 'none', dimensionKey: null, dimensionId: null, value })),
      ...(input.cells ?? []),
    ];
    for (const { metricKey, dimensionType, dimensionKey, dimensionId, value } of all) {
      const id = newId();
      const cell = {
        period_id: period, metric_key: metricKey, dimension_type: dimensionType,
        dimension_id: dimensionId ?? null, dimension_key: dimensionKey,
      };
      batch.set(orgRow(f, orgId, 'metric_snapshots', id), {
        id, organization_id: orgId, calculation_run_id: runId, ...cell,
        value: value === null ? null : new Decimal(value).toFixed(6), unit: input.unit ?? 'money', currency: input.currency ?? 'GBP',
        basis: input.basis ?? 'ledger', assurance_level: input.assurance ?? 'verified',
        data_quality: { completeness: 1, proxy: false, warnings: [...(input.warnings ?? [])], missing: [] }, components: {}, evidence_query: null,
        created_at: now,
      });
      batch.set(orgRow(f, orgId, 'metric_current', metricCellId(cell)), {
        organization_id: orgId, ...cell, snapshot_id: id, calculation_run_id: runId, previous_snapshot_id: null, updated_at: now,
      });
    }
  }
  await batch.commit();
  return runId;
}
