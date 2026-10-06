import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { withOrgScope } from '@/core/db';
import { drainJobs, runOrgPurgeJob, type ClaimedJob } from '@/modules/jobs';
import { adminSql, clientFor, createAuthUser, drainUntilFinished, serviceStorage } from './setup';

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
 * The organisation is seeded with a row in every family of tenant table the FK graph makes hard to
 * delete in the wrong order (records, runs, snapshots, evidence, alerts, actions, files), so a wrong
 * order fails here rather than in production. Run-unique fixtures (ADR-052.12).
 */

const RUN = `p${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.purge.itest`;
const SOURCE = 'source-documents';
const REPORTS = 'reports';

let ownerId: string;
let orgId: string;
let orgSlug: string;
let periodId: string;
let documentKey: string;
let reportKey: string;

const one = (sql: string): string => adminSql(`with q as (${sql}) select * from q`);

const claimed = (organizationId: string, jobId: string): ClaimedJob => ({
  jobId, organizationId, jobType: 'org.purge', payload: {}, requestedBy: null, attempts: 1, maxAttempts: 3,
});

/** A `running` purge row, the state the worker puts a job in before calling its handler. */
function runningPurgeRow(organizationId: string): string {
  return one(`
    insert into public.jobs (organization_id, job_type, payload, status, locked_at, locked_by, attempts)
    values ('${organizationId}', 'org.purge', '{}'::jsonb, 'running', now(), 'itest-${RUN}', 1)
    returning id`);
}

function stored(bucket: string, key: string): boolean {
  return one(`select count(*) from storage.objects where bucket_id = '${bucket}' and name = '${key}'`) === '1';
}

async function put(bucket: string, key: string): Promise<void> {
  const type = bucket === REPORTS ? 'application/pdf' : 'text/csv';
  const { error } = await serviceStorage().storage
    .from(bucket).upload(key, new Blob(['fixture'], { type }), { contentType: type, upsert: true });
  if (error) throw new Error(`fixture object ${key} could not be stored: ${error.message}`);
}

/** Every base table carrying organization_id — the same set the SQL guard walks. */
function tenantTables(): string[] {
  return adminSql(`
    select string_agg(c.table_name, ',')
      from information_schema.columns c
      join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
     where c.table_schema = 'public' and c.column_name = 'organization_id' and t.table_type = 'BASE TABLE'
       and c.table_name not in ('organizations', 'audit_events', 'jobs')
       and c.table_name not like 'audit_events_%' and c.table_name not like 'metric_snapshots_p%'`)
    .split(',');
}

function rowsLeft(organizationId: string): Record<string, number> {
  const left: Record<string, number> = {};
  for (const table of tenantTables()) {
    const n = Number(one(`select count(*) from public.${table} where organization_id = '${organizationId}'`));
    if (n > 0) left[table] = n;
  }
  return left;
}

/** Seeds one row in every family the deletion order has to get right. */
async function seedTenantData(organizationId: string, period: string): Promise<void> {
  const account = one(`
    select id from public.accounts where organization_id = '${organizationId}'
       and standard_category = 'revenue' and is_system`);
  const documentId = one(`select gen_random_uuid()`);
  const reportId = one(`select gen_random_uuid()`);
  documentKey = `${organizationId}/${documentId}/statement.csv`;
  reportKey = `${organizationId}/2026-05/${reportId}.pdf`;
  await put(SOURCE, documentKey);
  await put(SOURCE, `${organizationId}/${documentId}/text.json`);
  await put(REPORTS, reportKey);

  adminSql(`
    insert into public.source_documents
           (id, organization_id, storage_bucket, storage_path, original_filename, mime_type, byte_size,
            sha256, status, document_kind, extracted_text_path)
    values ('${documentId}', '${organizationId}', '${SOURCE}', '${documentKey}', 'statement.csv',
            'text/csv', 7, decode(md5('${documentId}'), 'hex'), 'ready', 'bank_statement',
            '${organizationId}/${documentId}/text.json');

    insert into public.ledger_entries
           (organization_id, entry_date, period_id, account_id, direction, amount, currency,
            description, source_document_id, record_status, assurance_level)
    values ('${organizationId}', '2026-05-10', '${period}', '${account}', 'credit', 250.00, 'GBP',
            'fixture sale', '${documentId}', 'accepted', 'verified');

    insert into public.bank_accounts
           (organization_id, name, account_type, bank_name, account_number_masked, is_active)
    values ('${organizationId}', 'Current', 'current', 'Test Bank', '****0001', true);

    insert into public.calculation_runs
           (id, organization_id, trigger, status, started_at, finished_at, engine_version,
            period_from, period_to, as_of)
    values ('${reportId}', '${organizationId}', 'recalc_manual', 'succeeded', now(), now(), '1.0.0',
            '${period}', '${period}', '2026-06-15');

    insert into public.metric_snapshots
           (id, organization_id, period_id, calculation_run_id, metric_key, dimension_type, value,
            unit, basis, assurance_level)
    values ('${documentId}', '${organizationId}', '${period}', '${reportId}', 'revenue', 'none',
            250.00, 'money', 'ledger', 'verified');
    insert into public.metric_current
           (organization_id, period_id, metric_key, dimension_type, snapshot_id, calculation_run_id)
    values ('${organizationId}', '${period}', 'revenue', 'none', '${documentId}', '${reportId}');

    insert into public.health_scores
           (id, organization_id, period_id, calculation_run_id, score, dimensions_used,
            dimensions_total, breakdown, config_version)
    values ('${reportId}', '${organizationId}', '${period}', '${reportId}', 70, 5, 5, '{}'::jsonb, '1');
    insert into public.health_current (organization_id, period_id, health_score_id, calculation_run_id)
    values ('${organizationId}', '${period}', '${reportId}', '${reportId}');

    insert into public.evidence_bundles
           (id, organization_id, kind, origin_table, origin_id, calculation_run_id, created_by_type)
    values ('${documentId}', '${organizationId}', 'metric', 'metric_snapshots', '${documentId}',
            '${reportId}', 'system');
    insert into public.evidence_items
           (organization_id, bundle_id, sort_order, item_type, ref_id, label, assurance_level)
    values ('${organizationId}', '${documentId}', 0, 'metric_snapshot', '${documentId}', 'Revenue',
            'verified');

    insert into public.actions (organization_id, title, source_type, evidence_bundle_id)
    values ('${organizationId}', 'Chase the invoice', 'user', '${documentId}');

    insert into public.alerts
           (organization_id, rule_key, rule_version, severity, metric_key, period_id, subject_type,
            subject_id, title, explanation, dedupe_key, key_kind, calculation_run_id)
    values ('${organizationId}', 'revenue.decline', '1', 'medium', 'revenue', '${period}', 'none',
            -- ADR-092: subject_type 'none' names no table, so it names no row either. This used to
            -- be an all-zero uuid: a reference to nothing, in a column nothing resolves. That is
            -- what the guard now refuses, and it is a shape the alert engine never writes --
            -- NO_SUBJECT is type none with a null id and a null key.
            null, 'Revenue fell', 'fixture', 'd-${RUN}', 'event',
            '${reportId}');

    insert into public.report_files
           (id, organization_id, period_id, report_kind, storage_bucket, storage_path, byte_size)
    values ('${reportId}', '${organizationId}', '${period}', 'monthly_management', '${REPORTS}',
            '${reportKey}', 7);`);

  /*
   * The tables added after the deletion order was first written: forecasts and scenarios (Phases
   * 11–12), the commercial records (Phase 14) and completeness attestations (Step 0F). None of them
   * was in the order, so the guard refused the purge of any organisation that had used one — the
   * customer's data stayed, and the job failed on every attempt. One row in each, so a table added
   * later without its place in the order fails here first.
   */
  adminSql(`
    insert into public.forecast_runs
           (id, organization_id, method, config_version, horizon_months)
    values ('${reportId}', '${organizationId}', 'fixture', '1', 3);
    insert into public.forecast_values
           (organization_id, forecast_run_id, period_id, metric_key, value, derivation)
    values ('${organizationId}', '${reportId}', '${period}', 'revenue', 250.00, 'baseline');
    insert into public.scenario_runs
           (id, organization_id, name, forecast_run_id, method, config_version, horizon_months)
    values ('${reportId}', '${organizationId}', 'Fixture scenario', '${reportId}', 'fixture', '1', 3);
    insert into public.scenario_values
           (organization_id, scenario_run_id, period_id, metric_key, baseline_value, scenario_value,
            derivation)
    values ('${organizationId}', '${reportId}', '${period}', 'revenue', 250.00, 275.00, 'baseline');

    insert into public.counterparties (id, organization_id, name, kind)
    values ('${reportId}', '${organizationId}', 'Fixture Customer ${RUN}', 'customer');
    insert into public.invoices
           (id, organization_id, invoice_type, counterparty_id, invoice_number, issue_date, period_id,
            total_amount, currency, record_status, assurance_level)
    values ('${reportId}', '${organizationId}', 'sales', '${reportId}', 'INV-1', '2026-05-10',
            '${period}', 250.00, 'GBP', 'accepted', 'verified');
    insert into public.products (id, organization_id, name)
    values ('${reportId}', '${organizationId}', 'Fixture product');
    insert into public.invoice_lines (organization_id, invoice_id, product_id, amount)
    values ('${organizationId}', '${reportId}', '${reportId}', 250.00);
    insert into public.marketing_channels (id, organization_id, name)
    values ('${reportId}', '${organizationId}', 'Fixture channel');
    insert into public.campaigns (id, organization_id, name, channel_id)
    values ('${reportId}', '${organizationId}', 'Fixture campaign', '${reportId}');
    insert into public.campaign_spend (organization_id, campaign_id, period_id, amount, currency)
    values ('${organizationId}', '${reportId}', '${period}', 10.00, 'GBP');
    insert into public.opportunities (organization_id, name, currency, campaign_id, channel_id)
    values ('${organizationId}', 'Fixture opportunity', 'GBP', '${reportId}', '${reportId}');

    insert into public.import_batches
           (id, organization_id, source_document_id, import_type, target_table, balance_basis, status,
            period_start, period_end)
    values ('${reportId}', '${organizationId}', '${documentId}', 'trial_balance', 'period_balances', 'cumulative', 'committed',
            '2026-05-01', '2026-05-31');
    insert into public.report_completeness_attestations
           (organization_id, import_batch_id, period_start, coverage, scope, reason, attested_by,
            attested_role)
    values ('${organizationId}', '${reportId}', '2026-05-01', 'complete', 'all_accounts',
            'fixture', '${ownerId}', 'owner');

    -- ADR-145: a funding assessment and its pointer.
    insert into public.funding_assessments
           (id, organization_id, calculation_run_id, period_id, overall_status, factors_used, substantive_weight_scored,
            data_coverage_percent, breakdown, rules_version, engine_version, trigger, disclaimer)
    values ('${reportId}', '${organizationId}', '${reportId}', '${period}', 'insufficient_data', 1, 20, 22,
            '{}'::jsonb, 'funding_readiness.v1', '15.1.0', 'enablement_backfill', 'fixture');
    insert into public.funding_current (organization_id, period_id, assessment_id, calculation_run_id)
    values ('${organizationId}', '${period}', '${reportId}', '${reportId}');

    -- ADR-144: an action comment, a request with its event, and a notification.
    insert into public.action_comments (organization_id, action_id, author_id, body)
    select '${organizationId}', a.id, '${ownerId}', 'fixture' from public.actions a where a.organization_id = '${organizationId}' limit 1;
    insert into public.engagement_items (id, organization_id, kind, title, created_by)
    values ('${reportId}', '${organizationId}', 'request', 'Fixture request', '${ownerId}');
    insert into public.engagement_events (organization_id, item_id, actor_id, event, to_status)
    values ('${organizationId}', '${reportId}', '${ownerId}', 'created', 'open');
    insert into public.notifications (organization_id, user_id, kind, title)
    values ('${organizationId}', '${ownerId}', 'data_added', 'Fixture');

    -- Phase 17: a stored report and its PDF row (the PDF references the report).
    insert into public.reports
           (id, organization_id, report_kind, window_start, window_end, origin, content, content_version)
    values ('${reportId}', '${organizationId}', 'daily_brief', '2026-05-10', '2026-05-10', 'scheduled',
            '{}'::jsonb, 'brief.v1');
    insert into public.report_files
           (organization_id, report_id, report_kind, storage_bucket, storage_path, byte_size)
    values ('${organizationId}', '${reportId}', 'daily_brief', '${REPORTS}',
            '${organizationId}/r/${reportId}/fixture.pdf', 7);`);
}

beforeAll(async () => {
  ownerId = createAuthUser(`owner@${DOMAIN}`);
  const created = await clientFor(ownerId).schema('api').rpc('create_organization', {
    p_name: `ITest Purge ${RUN}`,
  });
  if (created.error) throw new Error(`fixture org failed: ${created.error.message}`);
  orgId = created.data as unknown as string;
  orgSlug = one(`select slug from public.organizations where id = '${orgId}'`);
  periodId = one(`
    select id from public.fiscal_periods where organization_id = '${orgId}' and period_start = '2026-05-01'`);

  // A second member, so memberships and an invitation are among the rows that have to go.
  const invited = await clientFor(ownerId, { email: `owner@${DOMAIN}` }).schema('api')
    .rpc('invite_member', { p_org: orgId, p_email: `admin@${DOMAIN}`, p_role: 'admin' });
  if (invited.error) throw new Error(`fixture invitation failed: ${invited.error.message}`);

  await seedTenantData(orgId, periodId);
});

afterAll(async () => {
  const storage = serviceStorage();
  await storage.storage.from(SOURCE).remove([documentKey, documentKey.replace('statement.csv', 'text.json')]);
  await storage.storage.from(REPORTS).remove([reportKey]);
  adminSql(`
    select set_config('app.purge', 'on', true);
    delete from public.organizations where name like 'ITest Purge%${RUN}';
    delete from auth.users where email like '%@${DOMAIN}';
    delete from public.organizations where name like 'ITest Purge %' and created_at < now() - interval '1 hour';
    delete from auth.users where email like '%.purge.itest' and created_at < now() - interval '1 hour';`);
});

describe('requesting deletion', () => {
  it('schedules the purge thirty days out, and the data is untouched meanwhile', async () => {
    const { error } = await clientFor(ownerId, { email: `owner@${DOMAIN}` }).schema('api')
      .rpc('request_deletion', { p_org: orgId });
    expect(error).toBeNull();

    const job = one(`
      select job_type || '|' || status || '|' || (run_after > now() + interval '29 days')::text
        from public.jobs where organization_id = '${orgId}' and job_type = 'org.purge'`);
    expect(job).toBe('org.purge|queued|true');
    expect(Object.keys(rowsLeft(orgId)).length).toBeGreaterThan(5);
    expect(stored(SOURCE, documentKey)).toBe(true);
  });
});

/*
 * A refusal is THROWN by the handler: the worker records a thrown error as a failed attempt, and
 * three of those make the job dead and visible on /platform/jobs. The running row is always removed
 * afterwards, because a purge row left `running` would make every later purge of the organisation
 * wait for it — which is correct behaviour, and exactly why the cleanup is in `finally`.
 */
/**
 * Runs the handler the way the worker runs it (ADR-090).
 *
 * `runOne` in `services/worker.ts` wraps every organisation-scoped handler in `withOrgScope`, and
 * `api_server.purge_organization` now refuses a call that arrives with no scope. Driving the
 * handler bare would be testing a path production never takes.
 */
const runPurge = (organizationId: string, job: ClaimedJob) =>
  withOrgScope(organizationId, () => runOrgPurgeJob(job));

async function refused(organizationId: string, pattern: RegExp): Promise<void> {
  const jobId = runningPurgeRow(organizationId);
  try {
    await expect(runPurge(organizationId, claimed(organizationId, jobId))).rejects.toThrow(pattern);
  } finally {
    adminSql(`delete from public.jobs where id = '${jobId}'`);
  }
}

describe('the purge refuses to run when it should not', () => {
  it('fails, and deletes nothing, while the thirty days have not passed', async () => {
    await refused(orgId, /less than 30 days ago/);
    expect(rowsLeft(orgId).ledger_entries).toBe(1);
    expect(stored(SOURCE, documentKey)).toBe(true);
  });

  it('waits — defers rather than fails — while another job of the organisation is running', async () => {
    adminSql(`
      update public.organizations set deletion_requested_at = now() - interval '31 days' where id = '${orgId}'`);
    const other = one(`
      insert into public.jobs (organization_id, job_type, payload, status, locked_at, locked_by, attempts)
      values ('${orgId}', 'calculation.run', '{}'::jsonb, 'running', now(), 'itest-${RUN}', 1)
      returning id`);
    const jobId = runningPurgeRow(orgId);
    let outcome;
    try {
      outcome = await runPurge(orgId, claimed(orgId, jobId));
    } finally {
      adminSql(`delete from public.jobs where id in ('${jobId}', '${other}')`);
    }

    expect(outcome.status).toBe('deferred_upstream');
    expect(rowsLeft(orgId).ledger_entries).toBe(1);
    expect(stored(REPORTS, reportKey)).toBe(true);
  });

  it('refuses an organisation that was reactivated after the job was queued', async () => {
    const otherOwner = createAuthUser(`owner2@${DOMAIN}`);
    const created = await clientFor(otherOwner).schema('api').rpc('create_organization', {
      p_name: `ITest Purge Active ${RUN}`,
    });
    const activeOrg = created.data as unknown as string;
    await refused(activeOrg, /not scheduled for deletion/);
    expect(one(`select status from public.organizations where id = '${activeOrg}'`)).toBe('active');
    expect(Object.keys(rowsLeft(activeOrg)).length).toBeGreaterThan(0);
  });
});

describe('the purge, thirty days on', () => {
  let purgeJobId: string;

  it('succeeds', async () => {
    purgeJobId = runningPurgeRow(orgId);
    const outcome = await runPurge(orgId, claimed(orgId, purgeJobId));
    expect(outcome.status, JSON.stringify(outcome)).toBe('succeeded');
    const rows = (outcome.result as { rows: { status: string; rows: Record<string, number> } }).rows;
    expect(rows.status).toBe('purged');
    expect(rows.rows.ledger_entries).toBe(1);
    expect(rows.rows.evidence_items).toBe(1);
    expect(rows.rows.organization_memberships).toBe(1);
  });

  it('leaves no row of the organisation in any tenant table', () => {
    expect(rowsLeft(orgId)).toEqual({});
    // Only the purge job itself survives among the organisation's jobs.
    expect(one(`select count(*) from public.jobs where organization_id = '${orgId}'`)).toBe('1');
  });

  it('leaves no object under either prefix', () => {
    expect(stored(SOURCE, documentKey)).toBe(false);
    expect(stored(SOURCE, documentKey.replace('statement.csv', 'text.json'))).toBe(false);
    expect(stored(REPORTS, reportKey)).toBe(false);
  });

  it('keeps the organisation row, marked deleted, and the owner can no longer reach it', async () => {
    expect(one(`
      select status || '|' || (deleted_at is not null)::text || '|' || name
        from public.organizations where id = '${orgId}'`)).toBe(`deleted|true|ITest Purge ${RUN}`);

    const db = clientFor(ownerId, { email: `owner@${DOMAIN}` });
    const context = await db.schema('api').rpc('my_context', { p_slug: orgSlug });
    expect(context.data).toEqual([]);
    const mine = await db.schema('api').rpc('my_organizations');
    expect((mine.data as Array<{ organization_id?: string; id?: string }>).map((o) => o.organization_id ?? o.id))
      .not.toContain(orgId);
    expect(one(`select coalesce(last_active_org_id::text, 'null') from public.profiles where id = '${ownerId}'`))
      .toBe('null');
  });

  it('keeps the audit events and strips what they carried (ADR-038.9)', () => {
    const total = Number(one(`select count(*) from public.audit_events where organization_id = '${orgId}'`));
    expect(total).toBeGreaterThan(2);

    const unredacted = one(`
      select string_agg(action, ',')
        from public.audit_events
       where organization_id = '${orgId}'
         and (before is not null or after is not null or metadata <> '{}'::jsonb
              or ip is not null or user_agent is not null)`);
    // The one event that keeps a payload is the purge itself, whose `after` is row counts and
    // nothing that was in the rows.
    expect(unredacted).toBe('org.purged');
    expect(one(`
      select (after -> 'rows' ->> 'ledger_entries')
        from public.audit_events where organization_id = '${orgId}' and action = 'org.purged'`)).toBe('1');
  });

  it('is idempotent: a retry after the rows went finds nothing to re-verify and finishes', async () => {
    const outcome = await runPurge(orgId, claimed(orgId, purgeJobId));
    expect(outcome.status).toBe('succeeded');
    expect((outcome.result as { rows: { status: string } }).rows.status).toBe('already_deleted');
    adminSql(`delete from public.jobs where id = '${purgeJobId}'`);
  });
});

describe('through the queue', () => {
  it('a purge the trigger queued actually runs, rather than failing for want of a handler', async () => {
    const owner = createAuthUser(`owner3@${DOMAIN}`);
    const created = await clientFor(owner).schema('api').rpc('create_organization', {
      p_name: `ITest Purge Queue ${RUN}`,
    });
    const org = created.data as unknown as string;
    const requested = await clientFor(owner, { email: `owner3@${DOMAIN}` }).schema('api')
      .rpc('request_deletion', { p_org: org });
    expect(requested.error).toBeNull();

    // Thirty-one days pass.
    adminSql(`
      update public.organizations set deletion_requested_at = now() - interval '31 days' where id = '${org}';
      update public.jobs set run_after = now() where organization_id = '${org}' and job_type = 'org.purge'`);
    const jobId = one(`select id from public.jobs where organization_id = '${org}' and job_type = 'org.purge'`);

    const status = await drainUntilFinished((max) => drainJobs(max), jobId);
    expect(status).toBe('succeeded');
    expect(one(`select status from public.organizations where id = '${org}'`)).toBe('deleted');
    expect(rowsLeft(org)).toEqual({});
  });
});
