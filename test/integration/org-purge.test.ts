import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { withOrgScope } from '@/core/db';
import { putObject, REPORTS_BUCKET, SOURCE_DOCUMENTS_BUCKET } from '@/core/storage/signer';
import { storage, storageBucketName, auth } from '@/db/firestore';
import { periodId as periodIdOf } from '@/db/app/shared';
import { metricCellId, newId, nowIso, orgRow, uniqueGuard, type OrgTable } from '@/db/schema';
import { drainJobs, runOrgPurgeJob, type ClaimedJob } from '@/modules/jobs';
import { clientFor, createAuthUser, deleteOrg, drainUntilFinished, fs, rpc } from './setup';

/**
 * `org.purge` — the deletion an owner was promised (TENANCY_MODEL.md §2 lifecycle;
 * SERVICE_ARCHITECTURE.md §7; ADR-038.9, ADR-067; PRODUCTION_AUDIT.md C3).
 *
 * Until this handler existed, "delete this organisation" queued a job that died thirty days later
 * with "No handler is registered", and nothing showed it. So the suite is written from the
 * customer's side of the promise: after the purge, is there ANY row of theirs left in ANY table,
 * ANY object under either prefix, ANY audit payload that still carries their data — and, just as
 * important, does the purge refuse to run one day early, or while something else of theirs is still
 * running, or for an organisation somebody quietly reactivated.
 *
 * The organisation is seeded with a row in every family of tenant table the old FK graph made hard
 * to delete in the wrong order (records, runs, snapshots, evidence, alerts, actions, files), so a
 * table the purge does not know fails here rather than in production. On Firestore "every tenant
 * table" is every sub-collection of the organisation's document (FIRESTORE_DATA_MODEL.md §3).
 * Run-unique fixtures on the shared emulators (ADR-052.12).
 */

const RUN = `p${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.purge.itest.motion`;
const SOURCE = SOURCE_DOCUMENTS_BUCKET;
const REPORTS = REPORTS_BUCKET;

let ownerId: string;
let orgId: string;
let orgSlug: string;
let periodId: string;
let documentKey: string;
let textKey: string;
let reportKey: string;
let storedReportKey: string;
const createdOrgs: string[] = [];

const claimed = (organizationId: string, jobId: string): ClaimedJob => ({
  jobId, organizationId, jobType: 'org.purge', payload: {}, requestedBy: null, attempts: 1, maxAttempts: 3,
});

/** A job document in a given state (the worker puts a job `running` before calling its handler). */
async function jobRow(organizationId: string, jobType: string, status: string): Promise<string> {
  const id = newId();
  const now = nowIso();
  await fs().collection('jobs').doc(id).set({
    id, organization_id: organizationId, job_type: jobType, idempotency_key: null, payload: {},
    requested_by: null, status, attempts: 1, max_attempts: 3, run_after: now, locked_at: now,
    locked_by: `itest-${RUN}`, last_error: null, result: null, finished_at: null, created_at: now, updated_at: now,
  });
  return id;
}

const object = (bucket: string, key: string) => storage().bucket(storageBucketName()).file(`${bucket}/${key}`);

async function stored(bucket: string, key: string): Promise<boolean> {
  const [exists] = await object(bucket, key).exists();
  return exists;
}

async function put(organizationId: string, bucket: string, key: string): Promise<void> {
  const type = bucket === REPORTS ? 'application/pdf' : 'text/csv';
  await putObject({ orgId: organizationId, userId: ownerId }, bucket, key, new TextEncoder().encode('fixture'), type);
}

/** Every sub-collection of the organisation that still holds a document — the SQL guard's walk. */
async function rowsLeft(organizationId: string): Promise<Record<string, number>> {
  const left: Record<string, number> = {};
  for (const sub of await fs().collection('organizations').doc(organizationId).listCollections()) {
    if (sub.id === '_unique') continue;
    const n = (await sub.count().get()).data().count;
    if (n > 0) left[sub.id] = n;
  }
  return left;
}

const orgStatus = async (id: string) => String((await fs().collection('organizations').doc(id).get()).get('status'));

async function seed(table: OrgTable, row: Record<string, unknown>, docId?: string): Promise<string> {
  const id = (row.id as string | undefined) ?? newId();
  await orgRow(fs(), orgId, table, docId ?? id).set({ id, organization_id: orgId, created_at: nowIso(), ...row });
  return id;
}

/** Seeds one row in every family the deletion has to cover. */
async function seedTenantData(): Promise<void> {
  const accounts = await fs().collection('organizations').doc(orgId).collection('accounts')
    .where('standard_category', '==', 'revenue').where('is_system', '==', true).get();
  const account = String(accounts.docs[0]!.get('id'));
  const documentId = newId();
  const reportId = newId();
  documentKey = `${orgId}/${documentId}/statement.csv`;
  textKey = `${orgId}/${documentId}/text.json`;
  reportKey = `${orgId}/2026-05/${reportId}.pdf`;
  storedReportKey = `${orgId}/r/${reportId}/fixture.pdf`;
  await put(orgId, SOURCE, documentKey);
  await put(orgId, SOURCE, textKey);
  await put(orgId, REPORTS, reportKey);

  await seed('source_documents', {
    id: documentId, storage_bucket: SOURCE, storage_path: documentKey, original_filename: 'statement.csv',
    mime_type: 'text/csv', byte_size: 7, status: 'ready', document_kind: 'bank_statement',
    extracted_text_path: textKey, deleted_at: null,
  });
  await seed('ledger_entries', {
    entry_date: '2026-05-10', period_id: periodId, account_id: account, direction: 'credit', amount: '250.00',
    currency: 'GBP', description: 'fixture sale', source_document_id: documentId, record_status: 'accepted',
    assurance_level: 'verified',
  });
  await seed('bank_accounts', { name: 'Current', account_type: 'current', bank_name: 'Test Bank', is_active: true });
  await seed('calculation_runs', {
    id: reportId, trigger: 'recalc_manual', status: 'succeeded', engine_version: '1.0.0',
    period_from: periodId, period_to: periodId, as_of: '2026-06-15',
  });
  await seed('metric_snapshots', {
    id: documentId, period_id: periodId, calculation_run_id: reportId, metric_key: 'revenue',
    dimension_type: 'none', value: '250.00', unit: 'money', basis: 'ledger', assurance_level: 'verified',
  });
  const cell = { period_id: periodId, metric_key: 'revenue', dimension_type: 'none', dimension_id: null, dimension_key: null };
  await seed('metric_current', { ...cell, snapshot_id: documentId, calculation_run_id: reportId }, metricCellId(cell));
  await seed('health_scores', {
    id: reportId, period_id: periodId, calculation_run_id: reportId, score: 70, dimensions_used: 5,
    dimensions_total: 5, breakdown: [], config_version: '1',
  });
  await seed('health_current', { period_id: periodId, health_score_id: reportId, calculation_run_id: reportId }, periodId);
  await seed('evidence_bundles', {
    id: documentId, kind: 'metric', origin_table: 'metric_snapshots', origin_id: documentId,
    calculation_run_id: reportId, created_by_type: 'system',
  });
  await seed('evidence_items', {
    bundle_id: documentId, sort_order: 0, item_type: 'metric_snapshot', ref_id: documentId, label: 'Revenue',
    assurance_level: 'verified',
  });
  const actionId = await seed('actions', { title: 'Chase the invoice', source_type: 'user', status: 'open', evidence_bundle_id: documentId });
  await seed('alerts', {
    rule_key: 'revenue.decline', rule_version: '1', severity: 'medium', metric_key: 'revenue', period_id: periodId,
    subject_type: 'none', subject_id: null, title: 'Revenue fell', explanation: 'fixture', dedupe_key: `d-${RUN}`,
    key_kind: 'event', calculation_run_id: reportId, status: 'open',
  });
  await seed('report_files', {
    id: reportId, period_id: periodId, report_kind: 'monthly_management', storage_bucket: REPORTS,
    storage_path: reportKey, byte_size: 7, report_id: null, deleted_at: null,
  });

  // The tables added after the deletion order was first written (Phases 11–14, Step 0F).
  await seed('forecast_runs', { id: reportId, method: 'fixture', config_version: '1', horizon_months: 3 });
  await seed('forecast_values', { forecast_run_id: reportId, period_id: periodId, metric_key: 'revenue', value: '250.00', derivation: 'baseline' });
  await seed('scenario_runs', { id: reportId, name: 'Fixture scenario', forecast_run_id: reportId, method: 'fixture', config_version: '1', horizon_months: 3 });
  await seed('scenario_values', {
    scenario_run_id: reportId, period_id: periodId, metric_key: 'revenue', baseline_value: '250.00',
    scenario_value: '275.00', derivation: 'baseline',
  });
  await seed('counterparties', { id: reportId, name: `Fixture Customer ${RUN}`, kind: 'customer' });
  await seed('invoices', {
    id: reportId, invoice_type: 'sales', counterparty_id: reportId, invoice_number: 'INV-1', issue_date: '2026-05-10',
    period_id: periodId, total_amount: '250.00', currency: 'GBP', record_status: 'accepted', assurance_level: 'verified',
  });
  await seed('products', { id: reportId, name: 'Fixture product' });
  await seed('invoice_lines', { invoice_id: reportId, product_id: reportId, amount: '250.00' });
  await seed('marketing_channels', { id: reportId, name: 'Fixture channel' });
  await seed('campaigns', { id: reportId, name: 'Fixture campaign', channel_id: reportId });
  await seed('campaign_spend', { campaign_id: reportId, period_id: periodId, amount: '10.00', currency: 'GBP' });
  await seed('opportunities', { name: 'Fixture opportunity', currency: 'GBP', campaign_id: reportId, channel_id: reportId });
  await seed('import_batches', {
    id: reportId, source_document_id: documentId, import_type: 'trial_balance', target_table: 'period_balances',
    balance_basis: 'cumulative', status: 'committed', period_start: '2026-05-01', period_end: '2026-05-31',
  });
  await seed('report_completeness_attestations', {
    import_batch_id: reportId, period_start: '2026-05-01', coverage: 'complete', scope: 'all_accounts',
    reason: 'fixture', attested_by: ownerId, attested_role: 'owner',
  });
  // ADR-145: a funding assessment and its pointer.
  await seed('funding_assessments', {
    id: reportId, calculation_run_id: reportId, period_id: periodId, overall_status: 'insufficient_data',
    breakdown: {}, rules_version: 'funding_readiness.v1', engine_version: '15.1.0', trigger: 'enablement_backfill',
  });
  await seed('funding_current', { period_id: periodId, assessment_id: reportId, calculation_run_id: reportId }, periodId);
  // ADR-144: an action comment, a request with its event, and a notification.
  await seed('action_comments', { action_id: actionId, author_id: ownerId, body: 'fixture' });
  await seed('engagement_items', { id: reportId, kind: 'request', title: 'Fixture request', created_by: ownerId });
  await seed('engagement_events', { item_id: reportId, actor_id: ownerId, event: 'created', to_status: 'open' });
  await seed('notifications', { user_id: ownerId, kind: 'data_added', title: 'Fixture', read_at: null });
  // Phase 17: a stored report and its PDF row (the PDF references the report).
  await seed('reports', {
    id: reportId, report_kind: 'daily_brief', window_start: '2026-05-10', window_end: '2026-05-10',
    origin: 'scheduled', content: {}, content_version: 'brief.v1',
  });
  await seed('report_files', {
    report_id: reportId, report_kind: 'daily_brief', storage_bucket: REPORTS, storage_path: storedReportKey,
    byte_size: 7, deleted_at: null,
  });
}

async function createOrg(owner: string, name: string): Promise<string> {
  const created = await rpc<string>(clientFor(owner), 'create_organization', { p_name: name });
  if (created.error) throw new Error(`fixture org failed: ${created.error.message}`);
  createdOrgs.push(created.data!);
  return created.data!;
}

beforeAll(async () => {
  ownerId = await createAuthUser(`owner@${DOMAIN}`);
  orgId = await createOrg(ownerId, `ITest Purge ${RUN}`);
  orgSlug = String((await fs().collection('organizations').doc(orgId).get()).get('slug'));
  // A month inside the window `create_organization` creates (twelve back, twelve forward).
  const now = new Date();
  const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 10);
  periodId = periodIdOf(orgId, month);

  // A second member, so memberships and an invitation are among the rows that have to go.
  const invited = await rpc(clientFor(ownerId, { email: `owner@${DOMAIN}` }), 'invite_member', {
    p_org: orgId, p_email: `admin@${DOMAIN}`, p_role: 'admin',
  });
  if (invited.error) throw new Error(`fixture invitation failed: ${invited.error.message}`);

  await seedTenantData();
}, 60_000);

afterAll(async () => {
  const bucket = storage().bucket(storageBucketName());
  for (const [b, k] of [[SOURCE, documentKey], [SOURCE, textKey], [REPORTS, reportKey]] as const) {
    if (k) await bucket.file(`${b}/${k}`).delete({ ignoreNotFound: true });
  }
  for (const org of createdOrgs) {
    for (const table of ['jobs', 'audit_events'] as const) {
      const rows = await fs().collection(table).where('organization_id', '==', org).get();
      const writer = fs().bulkWriter();
      for (const d of rows.docs) void writer.delete(d.ref);
      await writer.close();
    }
    // The global guards these organisations claimed: the queued purge's key, and the slug.
    const slug = String((await fs().collection('organizations').doc(org).get()).get('slug'));
    await uniqueGuard(fs(), 'global', 'jobs_idempotency_queued', ['org.purge', `org.purge:${org}`]).ref.delete();
    await uniqueGuard(fs(), 'global', 'organizations_slug_key', [slug]).ref.delete();
    await deleteOrg(org);
  }
  const users = await auth().listUsers(1000);
  const mine = users.users.filter((u) => u.email?.endsWith(`@${DOMAIN}`));
  if (mine.length > 0) await auth().deleteUsers(mine.map((u) => u.uid));
  for (const u of mine) await fs().collection('profiles').doc(u.uid).delete();
}, 60_000);

describe('requesting deletion', () => {
  it('schedules the purge thirty days out, and the data is untouched meanwhile', async () => {
    const { error } = await rpc(clientFor(ownerId, { email: `owner@${DOMAIN}` }), 'request_deletion', { p_org: orgId });
    expect(error).toBeNull();

    const jobs = await fs().collection('jobs').where('organization_id', '==', orgId).where('job_type', '==', 'org.purge').get();
    expect(jobs.size).toBe(1);
    const job = jobs.docs[0]!.data();
    expect(job.status).toBe('queued');
    expect(new Date(job.run_after).getTime()).toBeGreaterThan(Date.now() + 29 * 86_400_000);
    expect(Object.keys(await rowsLeft(orgId)).length).toBeGreaterThan(5);
    expect(await stored(SOURCE, documentKey)).toBe(true);
  });
});

/**
 * Runs the handler the way the worker runs it (ADR-090).
 *
 * `runOne` in `services/worker.ts` wraps every organisation-scoped handler in `withOrgScope`, and
 * `api_server.purge_organization` refuses a call that arrives with no scope. Driving the handler
 * bare would be testing a path production never takes.
 */
const runPurge = (organizationId: string, job: ClaimedJob) =>
  withOrgScope(organizationId, () => runOrgPurgeJob(job));

/*
 * A refusal is THROWN by the handler: the worker records a thrown error as a failed attempt, and
 * three of those make the job dead and visible on /platform/jobs. The running row is always removed
 * afterwards, because a purge row left `running` would make every later purge of the organisation
 * wait for it — which is correct behaviour, and exactly why the cleanup is in `finally`.
 */
async function refused(organizationId: string, pattern: RegExp): Promise<void> {
  const jobId = await jobRow(organizationId, 'org.purge', 'running');
  try {
    await expect(runPurge(organizationId, claimed(organizationId, jobId))).rejects.toThrow(pattern);
  } finally {
    await fs().collection('jobs').doc(jobId).delete();
  }
}

const setRequestedDaysAgo = (org: string, days: number) => fs().collection('organizations').doc(org)
  .update({ deletion_requested_at: new Date(Date.now() - days * 86_400_000).toISOString() });

describe('the purge refuses to run when it should not', () => {
  it('fails, and deletes nothing, while the thirty days have not passed', async () => {
    await refused(orgId, /less than 30 days ago/);
    expect((await rowsLeft(orgId)).ledger_entries).toBe(1);
    expect(await stored(SOURCE, documentKey)).toBe(true);
  });

  it('waits — defers rather than fails — while another job of the organisation is running', async () => {
    await setRequestedDaysAgo(orgId, 31);
    const other = await jobRow(orgId, 'calculation.run', 'running');
    const jobId = await jobRow(orgId, 'org.purge', 'running');
    let outcome;
    try {
      outcome = await runPurge(orgId, claimed(orgId, jobId));
    } finally {
      await fs().collection('jobs').doc(jobId).delete();
      await fs().collection('jobs').doc(other).delete();
    }

    expect(outcome.status).toBe('deferred_upstream');
    expect((await rowsLeft(orgId)).ledger_entries).toBe(1);
    expect(await stored(REPORTS, reportKey)).toBe(true);
  });

  it('refuses an organisation that was reactivated after the job was queued', async () => {
    const otherOwner = await createAuthUser(`owner2@${DOMAIN}`);
    const activeOrg = await createOrg(otherOwner, `ITest Purge Active ${RUN}`);
    await refused(activeOrg, /not scheduled for deletion/);
    expect(await orgStatus(activeOrg)).toBe('active');
    expect(Object.keys(await rowsLeft(activeOrg)).length).toBeGreaterThan(0);
  });
});

describe('the purge, thirty days on', () => {
  let purgeJobId: string;

  it('succeeds', async () => {
    purgeJobId = await jobRow(orgId, 'org.purge', 'running');
    const outcome = await runPurge(orgId, claimed(orgId, purgeJobId));
    expect(outcome.status, JSON.stringify(outcome)).toBe('succeeded');
    const rows = (outcome.result as { rows: { status: string; rows: Record<string, number> } }).rows;
    expect(rows.status).toBe('purged');
    expect(rows.rows.ledger_entries).toBe(1);
    expect(rows.rows.evidence_items).toBe(1);
    expect(rows.rows.organization_memberships).toBe(1);
  }, 60_000);

  it('leaves no row of the organisation in any tenant table', async () => {
    expect(await rowsLeft(orgId)).toEqual({});
    // Only the purge job itself survives among the organisation's jobs.
    expect((await fs().collection('jobs').where('organization_id', '==', orgId).get()).size).toBe(1);
  });

  it('leaves no object under either prefix', async () => {
    expect(await stored(SOURCE, documentKey)).toBe(false);
    expect(await stored(SOURCE, textKey)).toBe(false);
    expect(await stored(REPORTS, reportKey)).toBe(false);
  });

  it('keeps the organisation row, marked deleted, and the owner can no longer reach it', async () => {
    const org = (await fs().collection('organizations').doc(orgId).get()).data()!;
    expect(`${org.status}|${org.deleted_at != null}|${org.name}`).toBe(`deleted|true|ITest Purge ${RUN}`);

    const db = clientFor(ownerId, { email: `owner@${DOMAIN}` });
    expect((await rpc(db, 'my_context', { p_slug: orgSlug })).data).toEqual([]);
    const mine = (await rpc<Array<{ organization_id?: string; id?: string }>>(db, 'my_organizations')).data ?? [];
    expect(mine.map((o) => o.organization_id ?? o.id)).not.toContain(orgId);
    expect((await fs().collection('profiles').doc(ownerId).get()).get('last_active_org_id')).toBeNull();
  });

  it('keeps the audit events and strips what they carried (ADR-038.9)', async () => {
    const events = (await fs().collection('audit_events').where('organization_id', '==', orgId).get()).docs.map((d) => d.data());
    expect(events.length).toBeGreaterThan(2);

    const unredacted = events.filter((e) => e.before != null || e.after != null
      || Object.keys((e.metadata as Record<string, unknown> | null) ?? {}).length > 0
      || e.ip != null || e.user_agent != null).map((e) => e.action);
    // The one event that keeps a payload is the purge itself, whose `after` is row counts and
    // nothing that was in the rows.
    expect(unredacted).toEqual(['org.purged']);
    const purged = events.find((e) => e.action === 'org.purged')!;
    expect(purged.after.rows.ledger_entries).toBe(1);
  });

  it('is idempotent: a retry after the rows went finds nothing to re-verify and finishes', async () => {
    const outcome = await runPurge(orgId, claimed(orgId, purgeJobId));
    expect(outcome.status).toBe('succeeded');
    expect((outcome.result as { rows: { status: string } }).rows.status).toBe('already_deleted');
    await fs().collection('jobs').doc(purgeJobId).delete();
  });
});

describe('through the queue', () => {
  it('a purge the trigger queued actually runs, rather than failing for want of a handler', async () => {
    const owner = await createAuthUser(`owner3@${DOMAIN}`);
    const org = await createOrg(owner, `ITest Purge Queue ${RUN}`);
    const requested = await rpc(clientFor(owner, { email: `owner3@${DOMAIN}` }), 'request_deletion', { p_org: org });
    expect(requested.error).toBeNull();

    // Thirty-one days pass.
    await setRequestedDaysAgo(org, 31);
    const jobs = await fs().collection('jobs').where('organization_id', '==', org).where('job_type', '==', 'org.purge').get();
    const jobId = jobs.docs[0]!.id;
    await jobs.docs[0]!.ref.update({ run_after: nowIso() });

    const status = await drainUntilFinished((max) => drainJobs(max), jobId, 40);
    expect(status).toBe('succeeded');
    expect(await orgStatus(org)).toBe('deleted');
    expect(await rowsLeft(org)).toEqual({});
  }, 120_000);
});
