import type { EffectiveRole } from '@/core/permissions';
import { globalRow, metricCellId, newId, nowIso, orgRow, uniqueGuard } from '@/db/schema';
import { agreedPermissions, type AccessContext } from '@/modules/tenancy';
import { clientFor, fs, rpc } from './setup';

/**
 * Fixtures for the tenancy suites (FIRESTORE_DATA_MODEL.md §3), in the shapes `src/db/api/tenancy.ts`
 * writes: an organisation document, memberships keyed by the user id, platform accounts keyed by the
 * user id. They seed state directly, as the SQL fixtures did with `adminSql`; every assertion still
 * goes through `clientFor(uid)` and the real `api.*` functions.
 */

export interface OrgFixture {
  name: string;
  slug: string;
  status?: 'active' | 'suspended' | 'pending_deletion' | 'deleted';
  plan?: string;
  features?: Record<string, unknown>;
  settings?: Record<string, unknown>;
  fiscalYearStartMonth?: number;
  timezone?: string;
  baseCurrency?: string;
  countryCode?: string | null;
}

/** An organisation document (and its slug guard). Returns its id. */
export async function makeOrg(o: OrgFixture): Promise<string> {
  const id = newId();
  const now = nowIso();
  await globalRow(fs(), 'organizations', id).set({
    id, slug: o.slug.toLowerCase(), name: o.name, legal_name: null, country_code: o.countryCode ?? 'GB',
    base_currency: o.baseCurrency ?? 'GBP', fiscal_year_start_month: o.fiscalYearStartMonth ?? 1, industry: null,
    kind: 'customer', status: o.status ?? 'active', plan: o.plan ?? 'trial', features: o.features ?? {},
    settings: o.settings ?? {}, timezone: o.timezone ?? 'Europe/London', deletion_requested_at: null,
    created_by: null, deleted_at: null, created_at: now, updated_at: now,
  });
  await uniqueGuard(fs(), 'global', 'organizations_slug_key', [o.slug.toLowerCase()]).ref.set({
    owner_id: id, constraint: 'organizations_slug_key', created_at: now,
  });
  return id;
}

/** Removes an organisation and its slug guard. */
export async function dropOrg(orgId: string): Promise<void> {
  const snap = await globalRow(fs(), 'organizations', orgId).get();
  if (snap.exists) {
    await uniqueGuard(fs(), 'global', 'organizations_slug_key', [String(snap.get('slug'))]).ref.delete();
  }
  await fs().recursiveDelete(globalRow(fs(), 'organizations', orgId));
}

/** A membership, keyed by the user id as the data model says. */
export async function addMember(
  orgId: string, userId: string, role: string,
  extra: { status?: 'active' | 'suspended'; departments?: string[] | null; departmentsSetByOwner?: boolean; invitedBy?: string | null } = {},
): Promise<void> {
  const now = nowIso();
  await orgRow(fs(), orgId, 'organization_memberships', userId).set({
    id: newId(), organization_id: orgId, user_id: userId, role, status: extra.status ?? 'active',
    invited_by: extra.invitedBy ?? null, joined_at: now, created_at: now, updated_at: now,
    departments: extra.departments ?? null, departments_set_by_owner: extra.departmentsSetByOwner ?? false,
  });
}

/** A platform account (`platform_users/{uid}`). */
export async function makePlatformUser(userId: string, role: 'super_admin' | 'employee', status: 'active' | 'suspended' = 'active'): Promise<void> {
  const now = nowIso();
  await globalRow(fs(), 'platform_users', userId).set({
    user_id: userId, platform_role: role, status, granted_by: null, notes: null, created_at: now, updated_at: now,
  });
}

export async function dropPlatformUser(userId: string): Promise<void> {
  await globalRow(fs(), 'platform_users', userId).delete();
}

/** An active adviser assignment of a platform employee. */
export async function assign(orgId: string, employeeId: string, extra: { startsAt?: string | null; endsAt?: string | null; status?: string } = {}): Promise<string> {
  const id = newId();
  const now = nowIso();
  await orgRow(fs(), orgId, 'organization_assignments', employeeId).set({
    id, organization_id: orgId, employee_user_id: employeeId, status: extra.status ?? 'active',
    starts_at: extra.startsAt ?? null, ends_at: extra.endsAt ?? null, assigned_by: null, revoked_at: null,
    revoked_by: null, revoke_reason: null, created_at: now, updated_at: now,
  });
  return id;
}

/** The slug of an organisation. */
export async function slugOf(orgId: string): Promise<string> {
  return String((await globalRow(fs(), 'organizations', orgId).get()).get('slug'));
}

/**
 * The context a page hands a service, built from the same `api.my_access` the resolver calls —
 * what the SQL suites built from `rpc('my_access')`.
 */
export async function ctxFor(userId: string, orgId: string, options: { email?: string; requestId?: string } = {}): Promise<AccessContext> {
  const slug = await slugOf(orgId);
  const db = clientFor(userId, { email: options.email });
  const { data, error } = await rpc<Array<{ role: EffectiveRole; overrides: unknown; permissions: string[]; status: string; departments: string[] | null }>>(
    db, 'my_access', { p_slug: slug },
  );
  if (error) throw error;
  const row = data?.[0];
  if (!row) throw new Error(`${userId} has no access to ${slug}`);
  return {
    userId, orgId, orgSlug: slug, effectiveRole: row.role,
    permissions: agreedPermissions(row.role, row.overrides, row.permissions).agreed,
    actorType: 'user', db, requestId: options.requestId ?? `itest-${slug}`, now: () => new Date(),
    organizationStatus: row.status as AccessContext['organizationStatus'],
    departments: row.departments as AccessContext['departments'],
  };
}

/** Count of an organisation table's documents, as the server sees them (the old `rawRows`). */
export async function rawCount(orgId: string, table: Parameters<typeof orgRow>[2], where?: [string, unknown]): Promise<number> {
  let q = fs().collection('organizations').doc(orgId).collection(table) as FirebaseFirestore.Query;
  if (where) q = q.where(where[0], '==', where[1]);
  return (await q.count().get()).data().count;
}

// ── Seeding financial rows (member-access, role-follow-ups) ─────────────────────────────────────

/**
 * Every column of the tables the access suites seed, with the table's default (`now`, `uuid`, a
 * literal) or null — so a seeded document carries every field the readers expect, as an INSERT
 * filled the defaults in (FIRESTORE_DATA_MODEL.md §3: NULL is stored, never omitted).
 */
const NOW = Symbol('now');
const UUID = Symbol('uuid');
type ColumnDefault = typeof NOW | typeof UUID | string | number | boolean | Record<string, unknown> | unknown[] | null;
const C = (spec: string, defaults: Record<string, ColumnDefault> = {}): Record<string, ColumnDefault> => {
  const out: Record<string, ColumnDefault> = {};
  for (const col of spec.split(/\s+/).filter(Boolean)) out[col] = col in defaults ? defaults[col]! : null;
  if ('id' in out && !('id' in defaults)) out.id = UUID;
  for (const ts of ['created_at', 'updated_at']) if (ts in out && !(ts in defaults)) out[ts] = NOW;
  return out;
};
const RECORD = { record_status: 'pending', assurance_level: 'verified', duplicate_reviewed: false };

export const SEED_COLUMNS: Record<string, Record<string, ColumnDefault>> = {
  accounts: C('id organization_id code name normalized_name account_type standard_category is_system is_active source external_ref mapping_confidence created_at updated_at loan_security',
    { standard_category: 'uncategorised', is_system: false, is_active: true, source: 'imported', mapping_confidence: 'unmapped' }),
  counterparties: C('id organization_id name normalized_name kind default_expense_category external_ref email notes is_active merged_into_id created_at updated_at',
    { kind: 'unknown', is_active: true }),
  bank_accounts: C('id organization_id name bank_name account_number_masked sort_code_masked currency account_type ledger_account_id opening_balance opening_balance_date is_active created_at updated_at',
    { currency: 'GBP', account_type: 'current', is_active: true }),
  ledger_entries: C('id organization_id entry_date period_id account_id direction amount currency description reference counterparty_id journal_ref source_document_id import_batch_id import_row_id source_ref record_status assurance_level dedupe_hash duplicate_reviewed is_opening_balance rejected_reason superseded_by superseded_at promoted_from_batch_id created_at updated_at',
    { currency: 'GBP', ...RECORD, is_opening_balance: false }),
  period_balances: C('id organization_id period_start period_id account_id opening_balance debit_total credit_total closing_balance currency balance_kind balance_basis source_document_id import_batch_id import_row_id source_ref record_status assurance_level duplicate_reviewed superseded_by superseded_at promoted_from_batch_id created_at updated_at rejected_reason',
    { currency: 'GBP', ...RECORD }),
  invoices: C('id organization_id invoice_type counterparty_id invoice_number issue_date due_date period_id subtotal tax_amount total_amount amount_paid balance_due currency status paid_date description source_document_id import_batch_id import_row_id source_ref record_status assurance_level dedupe_hash duplicate_reviewed superseded_by superseded_at promoted_from_batch_id created_at updated_at rejected_reason',
    { amount_paid: '0', currency: 'GBP', status: 'open', ...RECORD }),
  products: C('id organization_id name normalized_name kind code is_active notes created_at updated_at', { kind: 'service', is_active: true }),
  invoice_lines: C('id organization_id invoice_id product_id description quantity amount sort_order created_by created_at updated_at', { sort_order: 0 }),
  bank_transactions: C('id organization_id bank_account_id transaction_date posted_date period_id amount currency description_raw description_normalized counterparty_name_raw counterparty_id category_account_id category_source balance_after reference is_transfer transfer_pair_id transfer_kind recurring_group_id matched_ledger_entry_id source_document_id import_batch_id import_row_id source_ref record_status assurance_level dedupe_hash duplicate_reviewed superseded_by superseded_at promoted_from_batch_id created_at updated_at rejected_reason',
    { currency: 'GBP', category_source: 'none', is_transfer: false, transfer_kind: 'none', ...RECORD }),
  calculation_runs: C('id organization_id job_id trigger trigger_ref_id engine_version period_from period_to as_of as_of_ts status failure_reason stale input_fingerprint chunks progress started_at finished_at duration_ms error stats created_at updated_at',
    { as_of_ts: NOW, status: 'queued', stale: false, chunks: [], progress: {}, stats: {} }),
  metric_snapshots: C('id organization_id calculation_run_id period_id metric_key dimension_type dimension_id value unit currency basis assurance_level data_quality components evidence_query created_at dimension_key',
    { dimension_type: 'none', data_quality: {}, components: {} }),
  metric_current: C('organization_id period_id metric_key dimension_type dimension_id snapshot_id calculation_run_id previous_snapshot_id updated_at dimension_key',
    { dimension_type: 'none' }),
  health_scores: C('id organization_id calculation_run_id period_id score dimensions_used dimensions_total breakdown config_version created_at', { breakdown: [] }),
  health_current: C('organization_id period_id health_score_id updated_at calculation_run_id previous_health_score_id'),
  alerts: C('id organization_id rule_key rule_version severity metric_key period_id subject_type subject_id title explanation threshold_summary recommended_next_step current_revision_id status status_changed_by status_changed_at status_reason_code status_reason action_id dedupe_key key_kind calculation_run_id first_seen_at reopened_at dismissed_at last_evaluated_at created_at updated_at',
    { subject_type: 'none', threshold_summary: {}, status: 'open', status_reason_code: 'user', first_seen_at: NOW, last_evaluated_at: NOW }),
  actions: C('id organization_id title issue recommendation priority owner_user_id due_date status source_type source_id evidence_bundle_id outcome_notes outcome_value outcome_currency completed_at dismissed_reason created_by created_at updated_at',
    { priority: 'medium', status: 'open', source_type: 'user' }),
  source_documents: C('id organization_id storage_bucket storage_path original_filename mime_type byte_size sha256 document_kind page_count has_text_layer extracted_text_path status scan_result uploaded_by deleted_at created_at updated_at',
    { storage_bucket: 'source-documents', document_kind: 'unknown', status: 'uploaded', scan_result: {} }),
  import_batches: C('id organization_id source_document_id import_type target_table bank_account_id mapping_id mapping_snapshot status row_counts period_start period_end statement_opening_balance statement_closing_balance balance_sign fiscal_year_start_month_at_commit invoice_list_kind balance_basis extraction_method pages_extracted pages_failed created_by reviewed_by committed_at rolled_back_at rolled_back_reason replaced_batch_id error_summary calculation_job_id calculation_run_id created_at updated_at batch_issues confirmations required_confirmations page_confirmations review_token extraction_stats',
    { status: 'created', row_counts: {}, balance_sign: 'natural', extraction_method: 'csv', batch_issues: [], confirmations: {}, required_confirmations: [], page_confirmations: {}, review_token: UUID, extraction_stats: {} }),
  import_rows: C('id organization_id batch_id row_number source_ref raw_data mapped_data status issues dedupe_hash duplicate_of_table duplicate_of_id duplicate_within_batch_row_id reviewer_decision reviewer_reason committed_table committed_record_id created_at updated_at fixed_by fixed_at source_page',
    { raw_data: {}, status: 'pending', issues: [], reviewer_decision: 'none' }),
  evidence_bundles: C('id organization_id kind origin_table origin_id calculation_run_id created_by_type created_by created_at origin_message_id', { created_by_type: 'system' }),
  reports: C('id organization_id report_kind window_start window_end period_id origin requested_by job_id content content_version created_at'),
  notifications: C('id organization_id user_id kind title body href read_at created_at'),
};

/**
 * Writes one row of an organisation table with every column (defaults filled, the rest null).
 * Returns the stored row. Keyed tables use their data-model document id.
 */
export async function seedRow(orgId: string, table: keyof typeof SEED_COLUMNS & Parameters<typeof orgRow>[2], values: Record<string, unknown>): Promise<Record<string, unknown>> {
  const now = nowIso();
  const row: Record<string, unknown> = {};
  for (const [col, def] of Object.entries(SEED_COLUMNS[table]!)) {
    row[col] = def === NOW ? now : def === UUID ? newId() : (def && typeof def === 'object' ? structuredClone(def) : def);
  }
  Object.assign(row, values, { organization_id: orgId });
  for (const [k, v] of Object.entries(row)) if (v === undefined) row[k] = null;
  let docId = row.id as string | undefined;
  if (table === 'health_current') docId = String(row.period_id);
  if (table === 'metric_current') {
    docId = metricCellId({
      period_id: String(row.period_id), metric_key: String(row.metric_key), dimension_type: (row.dimension_type as string | null) ?? null,
      dimension_id: (row.dimension_id as string | null) ?? null, dimension_key: (row.dimension_key as string | null) ?? null,
    });
  }
  await orgRow(fs(), orgId, table, docId!).set(row);
  return row;
}

// ── Added by the isolation suites (append-only) ──────────────────────────────────────────────────

/** Deletes sign-in accounts and their profile / platform documents. Fixture teardown only. */
export async function dropUsers(uids: Iterable<string>): Promise<void> {
  const { auth } = await import('@/db/firestore');
  for (const uid of uids) {
    await auth().deleteUser(uid).catch(() => undefined);
    await globalRow(fs(), 'profiles', uid).delete();
    await globalRow(fs(), 'platform_users', uid).delete();
  }
}

/** Deletes the audit events an organisation's fixtures produced (`audit_events` is global). */
export async function dropAuditOf(orgId: string): Promise<void> {
  const snap = await fs().collection('audit_events').where('organization_id', '==', orgId).get();
  const writer = fs().bulkWriter();
  for (const d of snap.docs) void writer.delete(d.ref);
  await writer.close();
}

/** A real Firebase ID token for an account (the browser's credential), from the Auth emulator. */
export async function idTokenFor(email: string, password: string): Promise<string> {
  const { passwordSignIn } = await import('@/modules/tenancy');
  const signedIn = await passwordSignIn(email, password);
  if (!signedIn) throw new Error(`could not sign ${email} in`);
  return signedIn.idToken;
}

/**
 * A browser's direct request to Firestore (the client SDK's REST surface on the emulator), with a
 * user's ID token: what `firebase/firestore.rules` must refuse. Returns the HTTP status.
 */
export async function clientFirestoreRequest(
  idToken: string, method: 'GET' | 'PATCH' | 'DELETE', path: string, fields: Record<string, unknown> = {},
): Promise<number> {
  const host = process.env.FIRESTORE_EMULATOR_HOST;
  const project = process.env.FIREBASE_PROJECT_ID;
  const url = `http://${host}/v1/projects/${project}/databases/(default)/documents/${path}`;
  const body = method === 'PATCH'
    ? JSON.stringify({ fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, { stringValue: String(v) }])) })
    : undefined;
  const response = await fetch(url, {
    method, body, headers: { authorization: `Bearer ${idToken}`, 'content-type': 'application/json' },
  });
  return response.status;
}
