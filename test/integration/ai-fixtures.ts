import { auth } from '@/db/firestore';
import { Decimal } from '@/core/money';
import { runTx } from '@/db/tx';
import { prepareEnqueue } from '@/db/app/jobs';
import { ensurePeriods, monthStart, normalizeName, periodId, writeStandardChart } from '@/db/app/shared';
import { globalRow, newId, nowIso, orgCollection, orgRow, ORG_SINGLETON_ID } from '@/db/schema';
import { fs, serviceClientScoped } from './setup';

/**
 * Fixtures for the AI Analyst's suites, written in the shapes FIRESTORE_DATA_MODEL.md §3 gives — the
 * rows `api.create_organization`, an import commit and the platform pages leave behind, with every
 * column present (NULL as null) so equality filters behave as the application's own writes do.
 *
 * The suites assert through `clientFor` and the real `api.*` / `api_server.*` functions; these only
 * set the stage, and each suite deletes exactly what it created (`deleteOrg`, `dropUser`).
 */

/** What `api.create_organization` makes: the organisation, its owner, the standard chart and 24 months. */
export async function makeOrg(ownerId: string, name: string, options: { fiscalYearStartMonth?: number } = {}): Promise<string> {
  const id = newId();
  const now = nowIso();
  const slug = `itest-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`.slice(0, 40).replace(/-+$/, '');
  await fs().runTransaction(async (tx) => {
    tx.set(globalRow(fs(), 'organizations', id), {
      id, slug, name, legal_name: null, country_code: 'GB', base_currency: 'GBP',
      fiscal_year_start_month: options.fiscalYearStartMonth ?? 1, industry: null, kind: 'customer',
      status: 'active', plan: 'trial', features: {}, settings: {}, timezone: 'Europe/London',
      deletion_requested_at: null, created_by: ownerId, deleted_at: null, created_at: now, updated_at: now,
    });
    writeStandardChart(tx, fs(), id);
  });
  await addMember(id, ownerId, 'owner');
  const today = new Date();
  const from = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 12, 1)).toISOString().slice(0, 10);
  const to = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 11, 1)).toISOString().slice(0, 10);
  await ensurePeriods(fs(), id, from, to);
  // The fixtures post into 2026 months the rolling window may not reach in every year this runs.
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

export async function addPlatformUser(userId: string, role: 'super_admin' | 'employee', status = 'active'): Promise<void> {
  const now = nowIso();
  await globalRow(fs(), 'platform_users', userId).set({
    user_id: userId, platform_role: role, status, granted_by: null, notes: null, created_at: now, updated_at: now,
  });
}

export async function dropPlatformUser(userId: string): Promise<void> {
  await globalRow(fs(), 'platform_users', userId).delete();
}

/** An assignment of a platform employee to an organisation; re-assigning overwrites the status. */
export async function assign(orgId: string, employeeId: string, status: 'active' | 'revoked' = 'active', assignedBy: string | null = null): Promise<void> {
  const now = nowIso();
  const ref = orgRow(fs(), orgId, 'organization_assignments', employeeId);
  const existing = await ref.get();
  await ref.set({
    id: existing.exists ? existing.get('id') : newId(), organization_id: orgId, employee_user_id: employeeId,
    assigned_by: assignedBy, grantor_organization_id: null, status, starts_at: null,
    ends_at: new Date(Date.now() + 365 * 86_400_000).toISOString(), revoked_by: null, revoked_reason: null,
    created_at: existing.exists ? existing.get('created_at') : now, updated_at: now,
  });
}

/** `platform_org_settings` for one organisation; null clears the override. */
export async function setOrgQuota(orgId: string, values: Partial<Record<'ai_quota_daily' | 'ai_token_ceiling_monthly', number | null>> | null): Promise<void> {
  const ref = orgRow(fs(), orgId, 'platform_org_settings', ORG_SINGLETON_ID);
  if (values === null) { await ref.delete(); return; }
  const now = nowIso();
  await ref.set({
    organization_id: orgId, ai_quota_daily: null, ai_token_ceiling_monthly: null,
    ai_extraction_pages_per_day: null, model_overrides: {}, notes: null, updated_by: null,
    created_at: now, updated_at: now, ...values,
  });
}

export const periodOf = (orgId: string, date: string): string => periodId(orgId, monthStart(date));

export async function accountId(orgId: string, category: string): Promise<string> {
  const snap = await orgCollection(fs(), orgId, 'accounts')
    .where('standard_category', '==', category).where('is_system', '==', true).limit(1).get();
  if (snap.empty) throw new Error(`no system account for ${category}`);
  return snap.docs[0]!.id;
}

export async function addCounterparty(orgId: string, name: string, kind = 'unknown', defaultExpenseCategory: string | null = null): Promise<string> {
  const id = newId();
  const now = nowIso();
  await orgRow(fs(), orgId, 'counterparties', id).set({
    id, organization_id: orgId, name, normalized_name: normalizeName(name), kind,
    default_expense_category: defaultExpenseCategory, external_ref: null, email: null, notes: null,
    is_active: true, merged_into_id: null, created_at: now, updated_at: now,
  });
  return id;
}

/** A source document and one committed batch over it — the shape a real import leaves. */
export async function addCommittedBatch(orgId: string, input: {
  importType: string; targetTable: string; periodStart: string; periodEnd: string; filename: string;
  documentKind: string; invoiceListKind?: string | null; documentId?: string;
}): Promise<{ documentId: string; batchId: string }> {
  const now = nowIso();
  const documentId = input.documentId ?? newId();
  if (!input.documentId) {
    await orgRow(fs(), orgId, 'source_documents', documentId).set({
      id: documentId, organization_id: orgId, storage_bucket: 'source-documents',
      storage_path: `${orgId}/itest/${input.filename}`, original_filename: input.filename, mime_type: 'text/csv',
      byte_size: 10, sha256: documentId.replace(/-/g, '').padEnd(64, '0'), document_kind: input.documentKind,
      page_count: null, has_text_layer: null, extracted_text_path: null, status: 'ready', scan_result: {},
      uploaded_by: null, deleted_at: null, created_at: now, updated_at: now,
    });
  }
  const batchId = newId();
  await orgRow(fs(), orgId, 'import_batches', batchId).set({
    id: batchId, organization_id: orgId, source_document_id: documentId, import_type: input.importType,
    target_table: input.targetTable, bank_account_id: null, mapping_id: null, mapping_snapshot: null,
    status: 'committed', row_counts: {}, period_start: input.periodStart, period_end: input.periodEnd,
    statement_opening_balance: null, statement_closing_balance: null, balance_sign: 'natural',
    fiscal_year_start_month_at_commit: null, invoice_list_kind: input.invoiceListKind ?? null,
    balance_basis: null, extraction_method: 'csv', pages_extracted: null, pages_failed: null,
    created_by: null, reviewed_by: null, committed_at: now, rolled_back_at: null, rolled_back_reason: null,
    replaced_batch_id: null, error_summary: null, calculation_job_id: null, calculation_run_id: null,
    created_at: now, updated_at: now, batch_issues: [], confirmations: {}, required_confirmations: [],
    page_confirmations: {}, review_token: newId(), extraction_stats: {},
  });
  return { documentId, batchId };
}

function statusEvent(orgId: string, table: string, recordId: string, batchId: string | null) {
  const id = newId();
  return orgRow(fs(), orgId, 'record_status_events', id).set({
    id, organization_id: orgId, record_table: table, record_id: recordId, event: 'accepted',
    related_record_id: null, import_batch_id: batchId, actor_user_id: null, at: nowIso(),
  });
}

/** One accepted ledger line, with its import row and its `accepted` status event. */
export async function postLedger(orgId: string, batch: { documentId: string; batchId: string }, input: {
  category: string; direction: 'debit' | 'credit'; amount: string; date: string; line: number; counterpartyId?: string | null;
}): Promise<string> {
  const now = nowIso();
  const rowId = newId();
  const entryId = newId();
  const sourceRef = `csv:row:${input.line}`;
  await orgRow(fs(), orgId, 'import_rows', rowId).set({
    id: rowId, organization_id: orgId, batch_id: batch.batchId, row_number: input.line, source_ref: sourceRef,
    raw_data: {}, mapped_data: {}, status: 'committed', issues: [], dedupe_hash: null, duplicate_of_table: null,
    duplicate_of_id: null, duplicate_within_batch_row_id: null, reviewer_decision: 'none', reviewer_reason: null,
    committed_table: 'ledger_entries', committed_record_id: entryId, created_at: now, updated_at: now,
    fixed_by: null, fixed_at: null, source_page: null,
  });
  await orgRow(fs(), orgId, 'ledger_entries', entryId).set({
    id: entryId, organization_id: orgId, entry_date: input.date, period_id: periodOf(orgId, input.date),
    account_id: await accountId(orgId, input.category), direction: input.direction,
    amount: new Decimal(input.amount).toFixed(2), currency: 'GBP', description: null, reference: null,
    counterparty_id: input.counterpartyId ?? null, journal_ref: null, source_document_id: batch.documentId,
    import_batch_id: batch.batchId, import_row_id: rowId, source_ref: sourceRef, record_status: 'accepted',
    assurance_level: 'verified', dedupe_hash: null, duplicate_reviewed: false, is_opening_balance: false,
    rejected_reason: null, superseded_by: null, superseded_at: null, promoted_from_batch_id: null,
    created_at: now, updated_at: now,
  });
  await statusEvent(orgId, 'ledger_entries', entryId, batch.batchId);
  return entryId;
}

/** One accepted invoice (sales or purchase), with its `accepted` status event. */
export async function addInvoice(orgId: string, input: {
  type: 'sales' | 'purchase'; counterpartyId: string; number: string; issueDate: string; dueDate: string;
  subtotal: string; tax: string; total: string;
}): Promise<string> {
  const id = newId();
  const now = nowIso();
  await orgRow(fs(), orgId, 'invoices', id).set({
    id, organization_id: orgId, invoice_type: input.type, counterparty_id: input.counterpartyId,
    invoice_number: input.number, issue_date: input.issueDate, due_date: input.dueDate,
    period_id: periodOf(orgId, input.issueDate), subtotal: input.subtotal, tax_amount: input.tax,
    total_amount: input.total, amount_paid: '0.00', balance_due: new Decimal(input.total).toFixed(2),
    currency: 'GBP', status: 'open', paid_date: null, description: null, source_document_id: null,
    import_batch_id: null, import_row_id: null, source_ref: null, record_status: 'accepted',
    assurance_level: 'verified', dedupe_hash: null, duplicate_reviewed: false, superseded_by: null,
    superseded_at: null, promoted_from_batch_id: null, created_at: now, updated_at: now, rejected_reason: null,
  });
  await statusEvent(orgId, 'invoices', id, null);
  return id;
}

/** Queues one job for the organisation (what the SQL suites inserted into `public.jobs`). */
export async function enqueue(orgId: string, jobType: string, payload: Record<string, unknown>, maxAttempts = 3, requestedBy: string | null = null): Promise<string> {
  const db = serviceClientScoped(orgId);
  return runTx(db, async (tx) => {
    const job = await prepareEnqueue(fs(), {
      organizationId: orgId, jobType, payload, requestedBy, idempotencyKey: null, maxAttempts,
    }, tx);
    job.write(tx);
    return job.id;
  });
}

/** The engine's current snapshot id for one headline metric of one month. */
export async function currentSnapshot(orgId: string, period: string, metricKey: string): Promise<string> {
  const snap = await orgCollection(fs(), orgId, 'metric_current')
    .where('period_id', '==', period).where('metric_key', '==', metricKey).where('dimension_type', '==', 'none')
    .limit(1).get();
  return snap.empty ? '' : String(snap.docs[0]!.get('snapshot_id'));
}

/** Deletes the documents of one global collection that a suite wrote for its own users. */
export async function dropWhere(collection: 'portfolio_ai_turns' | 'audit_events' | 'jobs', field: string, values: readonly string[]): Promise<void> {
  for (let i = 0; i < values.length; i += 30) {
    const chunk = values.slice(i, i + 30);
    const snap = await fs().collection(collection).where(field, 'in', chunk).get();
    const writer = fs().bulkWriter();
    for (const d of snap.docs) void writer.delete(d.ref);
    await writer.close();
  }
}

/** Deletes the sign-in accounts of one suite's run-unique email domain, with their profiles. */
export async function dropUsers(domain: string): Promise<void> {
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

/**
 * Drains the shared queue until ONE organisation has nothing queued or running (at most `rounds`
 * rounds of five jobs); returns what is left. The queue is shared by every suite, so a suite waits
 * on its own organisation's jobs, never on the queue being empty.
 */
export async function drainJobsOf(drain: (max: number) => Promise<unknown>, orgId: string, rounds = 20): Promise<number> {
  const pending = async () => (await fs().collection('jobs').where('organization_id', '==', orgId)
    .where('status', 'in', ['queued', 'running']).get()).size;
  for (let round = 0; round < rounds; round += 1) {
    if ((await pending()) === 0) return 0;
    await drain(5);
  }
  return pending();
}
