import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { permissionsFor, type EffectiveRole } from '@/core/permissions';
import { loadHome } from '@/modules/dashboard';
import { loadDepartments } from '@/modules/departments';
import { drainJobs } from '@/modules/jobs';
import type { AccessContext } from '@/modules/tenancy';
import { auth } from '@/db/firestore';
import { prepareEnqueue } from '@/db/app/jobs';
import { periodId } from '@/db/app/shared';
import { globalRow, newId, nowIso, orgCollection, orgRow } from '@/db/schema';
import { runTx } from '@/db/tx';
import { clientFor, createAuthUser, drainUntilFinished, fs, rpc, serviceClientScoped } from './setup';
import { addMember, dropOrg, slugOf } from './tenancy-fixtures';

/**
 * The Departmental Dashboard (ADR-143): each tile is shown only to someone who may open its
 * section, its figures are the ones the section shows, and a suspended member sees none of it.
 */

const RUN = `d${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.departments.itest.motion`;
let ownerId: string;
let clientId: string;
let orgId: string;
let orgSlug: string;

const contextFor = (userId: string, role: EffectiveRole): AccessContext => ({
  userId, orgId, orgSlug, effectiveRole: role, permissions: permissionsFor(role), actorType: 'user',
  db: clientFor(userId, { email: `${role}@${DOMAIN}` }), requestId: `itest-${RUN}`, now: () => new Date(), organizationStatus: 'active',
});

async function systemAccount(category: string): Promise<string> {
  const snap = await orgCollection(fs(), orgId, 'accounts')
    .where('standard_category', '==', category).where('is_system', '==', true).limit(1).get();
  return snap.docs[0]!.id;
}

beforeAll(async () => {
  ownerId = await createAuthUser(`owner@${DOMAIN}`);
  clientId = await createAuthUser(`client@${DOMAIN}`);
  const created = await rpc(clientFor(ownerId), 'create_organization', { p_name: `ITest Departments ${RUN}` });
  if (created.error) throw created.error;
  orgId = created.data as string;
  orgSlug = await slugOf(orgId);
  await addMember(orgId, clientId, 'client');

  const now = nowIso();
  const august = periodId(orgId, '2026-08-01');
  for (const [c, d, a] of [['revenue', 'credit', '20000.00'], ['payroll', 'debit', '25000.00']] as const) {
    const id = newId();
    await orgRow(fs(), orgId, 'ledger_entries', id).set({
      id, organization_id: orgId, entry_date: '2026-08-10', period_id: august, account_id: await systemAccount(c),
      direction: d, amount: a, currency: 'GBP', description: null, reference: null, counterparty_id: null,
      journal_ref: null, source_document_id: null, import_batch_id: null, import_row_id: null, source_ref: null,
      record_status: 'accepted', assurance_level: 'verified', dedupe_hash: null, duplicate_reviewed: false,
      is_opening_balance: false, rejected_reason: null, superseded_by: null, superseded_at: null,
      promoted_from_batch_id: null, created_at: now, updated_at: now,
    });
    const event = newId();
    await orgRow(fs(), orgId, 'record_status_events', event).set({
      id: event, organization_id: orgId, record_table: 'ledger_entries', record_id: id, event: 'accepted',
      related_record_id: null, import_batch_id: null, actor_user_id: null, at: now,
    });
  }
  const doc = newId();
  await orgRow(fs(), orgId, 'source_documents', doc).set({
    id: doc, organization_id: orgId, storage_bucket: 'source-documents', storage_path: `${orgId}/d/gl.csv`,
    original_filename: 'gl.csv', mime_type: 'text/csv', byte_size: 10, sha256: 'e5', document_kind: 'general_ledger',
    page_count: null, has_text_layer: null, extracted_text_path: null, status: 'ready', scan_result: {},
    uploaded_by: null, deleted_at: null, created_at: now, updated_at: now,
  });
  const batch = newId();
  await orgRow(fs(), orgId, 'import_batches', batch).set({
    id: batch, organization_id: orgId, source_document_id: doc, import_type: 'general_ledger', target_table: 'ledger_entries',
    bank_account_id: null, mapping_id: null, mapping_snapshot: null, status: 'committed', row_counts: {},
    period_start: '2026-08-01', period_end: '2026-08-31', statement_opening_balance: null, statement_closing_balance: null,
    balance_sign: 'natural', fiscal_year_start_month_at_commit: null, invoice_list_kind: null, balance_basis: null,
    extraction_method: 'csv', pages_extracted: null, pages_failed: null, created_by: null, reviewed_by: null,
    committed_at: now, rolled_back_at: null, rolled_back_reason: null, replaced_batch_id: null, error_summary: null,
    calculation_job_id: null, calculation_run_id: null, created_at: now, updated_at: now, batch_issues: [],
    confirmations: {}, required_confirmations: [], page_confirmations: {}, review_token: newId(), extraction_stats: {},
  });
  const action = newId();
  await orgRow(fs(), orgId, 'actions', action).set({
    id: action, organization_id: orgId, title: 'Overdue thing', issue: null, recommendation: null, priority: 'high',
    owner_user_id: null, due_date: '2026-01-01', status: 'open', source_type: 'user', source_id: null,
    evidence_bundle_id: null, outcome_notes: null, outcome_value: null, outcome_currency: null, completed_at: null,
    dismissed_reason: null, created_by: null, created_at: now, updated_at: now,
  });
  const job = await runTx(serviceClientScoped(orgId), async (tx) => {
    const prepared = await prepareEnqueue(fs(), {
      organizationId: orgId, jobType: 'calculation.run', payload: { trigger: 'recalc_manual' },
      requestedBy: null, idempotencyKey: `calculation.run:${orgId}`, merge: 'calculation', maxAttempts: 3,
    }, tx);
    prepared.write(tx);
    return prepared.id;
  });
  // The queue is shared with every suite running against the emulators, so the drain may run other
  // organisations' jobs first.
  // A job of another suite whose organisation was cleaned up mid-drain must not fail this one.
  const drain = (max: number) => drainJobs(max).catch(() => undefined);
  expect(await drainUntilFinished(drain, job, 200)).toBe('succeeded');
}, 900_000);

afterAll(async () => {
  if (orgId) await dropOrg(orgId);
  const jobs = await fs().collection('jobs').where('organization_id', '==', orgId ?? '').get();
  for (const j of jobs.docs) await j.ref.delete();
  for (const id of [ownerId, clientId]) {
    await auth().deleteUser(id).catch(() => undefined);
    await globalRow(fs(), 'profiles', id).delete();
  }
});

describe('the departmental dashboard', { timeout: 180_000 }, () => {
  it('shows an owner every department, and how the system is running', async () => {
    const started = Date.now();
    const view = await loadDepartments(contextFor(ownerId, 'owner'));
    console.log('loadDepartments ms', Date.now() - started);
    expect(view.tiles.map((t) => t.key)).toEqual(['finance', 'banking', 'customers', 'actions', 'alerts', 'reports', 'analyst', 'planning']);
    expect(view.system.imports).toMatch(/waiting for review/);
    expect(view.system.team).toMatch(/team/);
    expect(view.system.lastCalculation).toMatch(/^Last calculation finished/);
  });

  it('states the month as Home does — revenue and a loss flagged for attention', async () => {
    const view = await loadDepartments(contextFor(ownerId, 'owner'));
    const home = await loadHome(contextFor(ownerId, 'owner').db, orgId, orgSlug, `itest-${RUN}`);
    if (home.kind !== 'ready') throw new Error('Home must have figures');
    const finance = view.tiles.find((t) => t.key === 'finance')!;
    expect(finance.headline).toContain(home.view.period.label);
    // 20,000 revenue − 25,000 payroll: a loss, so the department needs attention.
    expect(finance.tone).toBe('attention');
    expect(view.tiles.find((t) => t.key === 'actions')).toMatchObject({ tone: 'attention', lines: ['1 overdue, 0 due in the next 7 days.'] });
  });

  it('shows a client only the departments a client may open, and no import or team detail', async () => {
    const view = await loadDepartments(contextFor(clientId, 'client'));
    expect(view.system.imports).toBeNull();
    expect(view.system.team).toBeNull();
    for (const tile of view.tiles) expect(['finance', 'banking', 'customers', 'actions', 'alerts', 'reports', 'analyst', 'planning']).toContain(tile.key);
  });

  it('refuses a suspended member, who keeps only the frozen Home (ADR-044.4)', async () => {
    await expect(loadDepartments(contextFor(clientId, 'suspended_member'))).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });
});
