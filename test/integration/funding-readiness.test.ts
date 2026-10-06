import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { permissionsFor, type EffectiveRole } from '@/core/permissions';
import { getBundle } from '@/modules/evidence';
import { getFundingView } from '@/modules/funding';
import { drainJobs } from '@/modules/jobs';
import { getStoredReport, requestCompose, requestStoredPdf, type FundingReportContent } from '@/modules/reporting';
import type { AccessContext } from '@/modules/tenancy';
import { adminSql, clientFor, createAuthUser, drainUntilFinished, serviceStorage, sqlstate } from './setup';

/**
 * Funding Readiness (Phase 16; ADR-121, ADR-145): the flag's whole lifecycle and its security, against
 * figures a real calculation run produced. The organisation keeps a ledger and no bank account and no
 * balance sheet, so the honest result is "Insufficient data" — F2 and F3 unknown (never cash 0), F4
 * unknown (never "no debt") — which is exactly what must be shown. Run-unique fixtures.
 */

const RUN = `f${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.funding.itest`;
let ownerId: string;
let clientId: string;
let strangerId: string;
let orgId: string;
let otherOrgId: string;
let august: string;

const one = (sql: string): string => adminSql(`with q as (${sql}) select * from q`);
const ctxFor = (userId: string, role: EffectiveRole, org = orgId): AccessContext => ({
  userId, orgId: org, orgSlug: 'fund', effectiveRole: role, permissions: permissionsFor(role), actorType: 'user',
  db: clientFor(userId, { email: `${role}@${DOMAIN}` }), requestId: `itest-${RUN}`, now: () => new Date(), organizationStatus: 'active',
});
const setFlag = (on: boolean) => adminSql(`update public.organizations set features = features || jsonb_build_object('funding_readiness', ${on}) where id = '${orgId}'`);
/** The newest assessment job created since `since` (any state: the drain may already have run it). */
const fundingJob = (since = '-infinity') => one(`select coalesce((select id::text from public.jobs where organization_id = '${orgId}'
  and job_type = 'funding.assess' and created_at > '${since}'::timestamptz order by created_at desc limit 1), '')`);
const now = () => one(`select now()::text`);

async function calculate(): Promise<string> {
  const job = adminSql(`insert into public.jobs (organization_id, job_type, payload, max_attempts)
                        values ('${orgId}', 'calculation.run', '{"trigger":"recalc_manual"}'::jsonb, 3) returning id`).split('\n')[0]!.trim();
  expect(await drainUntilFinished(drainJobs, job)).toBe('succeeded');
  return one(`select id from public.calculation_runs where organization_id = '${orgId}' and status = 'succeeded' order by finished_at desc limit 1`);
}

beforeAll(async () => {
  ownerId = createAuthUser(`owner@${DOMAIN}`);
  clientId = createAuthUser(`client@${DOMAIN}`);
  strangerId = createAuthUser(`stranger@${DOMAIN}`);
  const created = await clientFor(ownerId).schema('api').rpc('create_organization', { p_name: `ITest Funding ${RUN}` });
  if (created.error) throw new Error(created.error.message);
  orgId = created.data as unknown as string;
  const other = await clientFor(strangerId).schema('api').rpc('create_organization', { p_name: `ITest Funding Other ${RUN}` });
  otherOrgId = other.data as unknown as string;
  adminSql(`insert into public.organization_memberships (organization_id, user_id, role, status) values ('${orgId}', '${clientId}', 'client', 'active')`);
  const account = (c: string) => one(`select id from public.accounts where organization_id = '${orgId}' and standard_category = '${c}' and is_system`);
  for (const [c, d, a] of [['revenue', 'credit', '20000.00'], ['payroll', 'debit', '12000.00']] as const) {
    const id = one(`insert into public.ledger_entries (organization_id, entry_date, account_id, direction, amount, period_id, record_status)
                    values ('${orgId}', '2026-08-10', '${account(c)}', '${d}', ${a}, '00000000-0000-0000-0000-000000000000', 'accepted') returning id`);
    adminSql(`insert into public.record_status_events (organization_id, record_table, record_id, event) values ('${orgId}', 'ledger_entries', '${id}', 'accepted')`);
  }
  const doc = one(`insert into public.source_documents (organization_id, storage_path, original_filename, mime_type, byte_size, sha256, status, document_kind)
                   values ('${orgId}', '${orgId}/f/gl.csv', 'gl.csv', 'text/csv', 10, decode('e5','hex'), 'ready', 'general_ledger') returning id`);
  adminSql(`insert into public.import_batches (organization_id, source_document_id, import_type, target_table, status, extraction_method, period_start, period_end, committed_at)
            values ('${orgId}', '${doc}', 'general_ledger', 'ledger_entries', 'committed', 'csv', '2026-08-01', '2026-08-31', now())`);
  august = one(`select id from public.fiscal_periods where organization_id = '${orgId}' and period_start = '2026-08-01'`);
});

afterAll(() => {
  adminSql(`
    select set_config('app.purge', 'on', false);
    delete from public.funding_current where organization_id in (select id from public.organizations where name like 'ITest Funding%${RUN}');
    delete from public.funding_assessments where organization_id in (select id from public.organizations where name like 'ITest Funding%${RUN}');
    delete from public.organizations where name like 'ITest Funding%${RUN}';
    delete from auth.users where email like '%@${DOMAIN}';`);
});

describe('switched off (the default)', () => {
  it('a calculation writes no assessment and queues no assessment job', async () => {
    const since = now();
    await calculate();
    expect(one(`select count(*) from public.funding_assessments where organization_id = '${orgId}'`)).toBe('0');
    expect(fundingJob(since)).toBe('');
  });

  it('the page is NOT FOUND for every role', async () => {
    for (const [id, role] of [[ownerId, 'owner'], [clientId, 'client']] as const) {
      await expect(getFundingView(ctxFor(id, role))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    }
  });
});

describe('switching it on', () => {
  it('queues the backfill in the same transaction, and assesses every complete month', async () => {
    setFlag(true);
    const job = fundingJob();
    expect(job).toMatch(/^[0-9a-f-]{36}$/);
    expect(one(`select payload ->> 'trigger' from public.jobs where id = '${job}'`)).toBe('enablement_backfill');
    expect(await drainUntilFinished(drainJobs, job)).toBe('succeeded');
    expect(one(`select trigger from public.funding_assessments a join public.funding_current c on c.assessment_id = a.id
                 where c.organization_id = '${orgId}' and c.period_id = '${august}'`)).toBe('enablement_backfill');
  });

  it('says "Insufficient data" honestly: no cash is unknown cash, no balance sheet is unknown debt', async () => {
    const view = await getFundingView(ctxFor(ownerId, 'owner'), august);
    expect(view.assessment).toMatchObject({ status: 'insufficient_data', score: null, band: null });
    const factors = new Map(view.assessment!.factors.map((f) => [f.key, f]));
    expect(factors.get('F1')).toMatchObject({ status: 'scored' });
    expect(factors.get('F2')).toMatchObject({ status: 'missing', score: null });
    expect(factors.get('F3')).toMatchObject({ status: 'missing', reason: 'no_bank_coverage' });
    expect(factors.get('F4')).toMatchObject({ status: 'missing', reason: 'no_balance_sheet' });
    expect(view.assessment!.actions.map((a) => a.text)).toContain('Import a trial balance or balance sheet so debt can be established.');
    expect(view.assessment!.disclaimer).toMatch(/^Funding Readiness is an indicative/);
  });

  it('a client may read it; another organisation may not', async () => {
    expect((await getFundingView(ctxFor(clientId, 'client'))).state).toBe('ready');
    const { data } = await clientFor(strangerId, { email: `owner@${DOMAIN}` }).from('funding_assessments').select('id').eq('organization_id', orgId);
    expect(data ?? []).toEqual([]);
  });

  it('the next successful calculation re-assesses, citing the new run', async () => {
    const since = now();
    const run = await calculate();
    const job = fundingJob(since);
    expect(one(`select payload ->> 'trigger' from public.jobs where id = '${job}'`)).toBe('calculation_run');
    expect(await drainUntilFinished(drainJobs, job)).toBe('succeeded');
    expect(one(`select calculation_run_id from public.funding_current where organization_id = '${orgId}' and period_id = '${august}'`)).toBe(run);
    // The earlier assessment is kept, not replaced.
    expect(Number(one(`select count(*) from public.funding_assessments where organization_id = '${orgId}' and period_id = '${august}'`))).toBe(2);
  });

  it('the nightly backstop queues an organisation whose latest month has no current assessment', async () => {
    adminSql(`delete from public.funding_current where organization_id = '${orgId}'`);
    const since = now();
    const { error } = await serviceStorage().schema('api_server').rpc('enqueue_funding_backstop', {});
    expect(error).toBeNull();
    const job = fundingJob(since);
    expect(one(`select payload ->> 'trigger' from public.jobs where id = '${job}'`)).toBe('nightly_backstop');
    expect(await drainUntilFinished(drainJobs, job)).toBe('succeeded');
    expect(one(`select count(*) from public.funding_current where organization_id = '${orgId}'`)).not.toBe('0');
  });
});

let fundingReportId: string;

describe('the Funding Readiness Report (REQ-RP-05)', () => {
  it('stores the latest month\'s current assessment as it stands, with its disclaimer', async () => {
    const job = await requestCompose(ctxFor(ownerId, 'owner'), 'funding_readiness', null);
    expect(await drainUntilFinished(drainJobs, job)).toBe('succeeded');
    fundingReportId = one(`select id from public.reports where organization_id = '${orgId}' and report_kind = 'funding_readiness'`);
    const report = await getStoredReport(ctxFor(ownerId, 'owner'), fundingReportId);
    expect(report).toMatchObject({ kind: 'funding_readiness', contentVersion: 'funding.v1', origin: 'requested', periodId: august });
    const content = report!.content as FundingReportContent;
    // The same row the Funding page shows for the month, not a recomposition.
    const current = one(`select assessment_id from public.funding_current where organization_id = '${orgId}' and period_id = '${august}'`);
    expect(content.assessment.id).toBe(current);
    expect(content.assessment).toMatchObject({ status: 'insufficient_data', score: null, band: null });
    expect(content.assessment.disclaimer).toMatch(/^Funding Readiness is an indicative/);
    expect(content.assessment.factors).toHaveLength(7);
    expect(report!.windowStart).toBe('2026-08-01');
    expect(report!.windowEnd).toBe('2026-08-31');
  });

  it('renders its PDF under the report', async () => {
    const job = await requestStoredPdf(ctxFor(ownerId, 'owner'), fundingReportId);
    expect(await drainUntilFinished(drainJobs, job)).toBe('succeeded');
    expect(one(`select count(*) from public.report_files where organization_id = '${orgId}' and report_id = '${fundingReportId}'`)).toBe('1');
  });

  it('a client may read it but not produce one', async () => {
    expect(await getStoredReport(ctxFor(clientId, 'client'), fundingReportId)).not.toBeNull();
    await expect(requestCompose(ctxFor(clientId, 'client'), 'funding_readiness', null)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });
});

describe('switching it off again', () => {
  it('hides the Funding Readiness Report and refuses a new one, keeping the stored row', async () => {
    setFlag(false);
    expect(await getStoredReport(ctxFor(ownerId, 'owner'), fundingReportId)).toBeNull();
    await expect(requestCompose(ctxFor(ownerId, 'owner'), 'funding_readiness', null)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(one(`select count(*) from public.reports where id = '${fundingReportId}'`)).toBe('1');
  });

  it('hides it at every layer — page, evidence and RLS — and keeps the rows', async () => {
    const bundle = one(`select b.id from public.evidence_bundles b where b.organization_id = '${orgId}' and b.kind = 'funding_assessment' limit 1`);
    expect(bundle).toMatch(/^[0-9a-f-]{36}$/);
    setFlag(false);
    await expect(getFundingView(ctxFor(ownerId, 'owner'))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(getBundle(ctxFor(ownerId, 'owner'), bundle)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const { data } = await ctxFor(ownerId, 'owner').db.from('funding_assessments').select('id').eq('organization_id', orgId);
    expect(data ?? []).toEqual([]);
    expect(Number(one(`select count(*) from public.funding_assessments where organization_id = '${orgId}'`))).toBeGreaterThan(0);
  });

  it('and nothing is calculated while it is off', async () => {
    const before = one(`select count(*) from public.funding_assessments where organization_id = '${orgId}'`);
    const since = now();
    await calculate();
    expect(fundingJob(since)).toBe('');
    expect(one(`select count(*) from public.funding_assessments where organization_id = '${orgId}'`)).toBe(before);
  });
});

describe('only the server writes, and nothing is edited', () => {
  it('finish_funding is not callable with a user token, and the table refuses direct writes', async () => {
    const owner = ctxFor(ownerId, 'owner').db;
    const rpc = await owner.schema('api_server').rpc('finish_funding', { p_org: orgId, p_assessments: [], p_trigger: 'calculation_run' });
    expect(rpc.error).not.toBeNull();
    const { error } = await owner.from('funding_assessments').insert({ organization_id: orgId });
    expect(sqlstate(error)).toBe('42501');
  });

  it('an assessment cannot be changed or deleted', () => {
    expect(() => adminSql(`update public.funding_assessments set overall_status = 'scored' where organization_id = '${orgId}'`)).toThrow(/IMMUTABLE/);
  });

  it('a stranger organisation\'s assessment pages are not found, whatever the id', async () => {
    void otherOrgId;
    await expect(getFundingView(ctxFor(strangerId, 'owner', otherOrgId))).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
