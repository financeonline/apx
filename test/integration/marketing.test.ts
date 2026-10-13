import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withOrgScope } from '@/core/db';
import { permissionsFor, type EffectiveRole } from '@/core/permissions';
import { runMarketingGenerateJob } from '@/modules/jobs';
import { enabledModules, type AccessContext } from '@/modules/tenancy';
import {
  MARKETING_FAILURES, MARKETING_REPORT_VERSION, getCompanyProfile, getLatestMarketingReport, getMarketingView,
  requestMarketingReport, runMarketingReport, setCompanyProfile, type MarketingReportDeps,
} from '@/modules/marketing';
import { SAMPLE_MARKETING_REPORT } from '../fixtures/marketing/sample-report';
import { adminSql, clientFor, createAuthUser, serviceClientScoped, sqlstate } from './setup';

/**
 * ADR-170 over the real wire: the company profile (who may write it, what the database refuses), asking
 * for the marketing report (who may spend AI on it, the profile it needs, one at a time, three an hour,
 * the monthly allowance, the system switch) and the job's writes (ready, failed, a job that ends
 * without finishing, the purge).
 *
 * NO MODEL IS CALLED. The narrative is a fake handed to `runMarketingReport`, or — for the one test
 * that drives the registered handler — the writer's offline template (`MOTION_AI_OFFLINE=1`). And no
 * worker can take a job this file queues: every request that creates one runs inside a transaction
 * that also moves the job's `run_after` a month out before it commits (`requestParked`), so another
 * suite draining the shared queue never sees it as due.
 *
 * Run-unique fixtures under a name no other suite's `resetFixtures()` deletes; cleaned up by name.
 */

process.env.MOTION_AI_OFFLINE = '1';

const RUN = `m${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.marketing.itest`;
const PREFIX = `MktTest ${RUN}`;

let ownerId: string;
let adminId: string;
let clientId: string;
let adviserId: string;
let strangerId: string;
let orgA: string;
let orgE: string;
let orgM: string;
let orgT: string;
let slugA: string;

const one = (sql: string): string => adminSql(`with q as (${sql}) select * from q`);
const features = (org: string) => JSON.parse(one(`select features::text from public.organizations where id = '${org}'`)) as Record<string, unknown>;
const ctxFor = (userId: string, role: EffectiveRole, org = orgA): AccessContext => ({
  userId, orgId: org, orgSlug: 'mkt', effectiveRole: role, permissions: permissionsFor(role), actorType: 'user',
  db: clientFor(userId, { email: `${role}-${userId.slice(0, 4)}@${DOMAIN}` }), requestId: `itest-${RUN}`, now: () => new Date(),
  organizationStatus: 'active', modules: enabledModules(features(org)),
});
const owner = (org = orgA) => ctxFor(ownerId, 'owner', org);
const admin = () => ctxFor(adminId, 'admin');
const client = () => ctxFor(clientId, 'client');
const adviser = () => ctxFor(adviserId, 'employee');
const rpcAs = (userId: string, fn: string, args: Record<string, unknown>) => clientFor(userId).schema('api').rpc(fn, args);

/**
 * `api.request_marketing_report` as the user would call it — same function, same JWT claims, same
 * role — inside one transaction that parks the job it queued before anyone else can see it.
 */
function requestParked(userId: string, org: string): { report_id: string; created: boolean } {
  const claims = JSON.stringify({ sub: userId, role: 'authenticated', email: `parked@${DOMAIN}` });
  const out = adminSql(`
    begin;
    select set_config('request.jwt.claims', '${claims}', true);
    set local role authenticated;
    select api.request_marketing_report('${org}')::text;
    reset role;
    update public.jobs set run_after = now() + interval '30 days'
     where organization_id = '${org}' and job_type = 'marketing.generate' and status = 'queued';
    commit;`);
  const line = out.split('\n').map((l) => l.trim()).find((l) => l.startsWith('{') && l.includes('"report_id"'));
  if (!line) throw new Error(`the request returned nothing: ${out}`);
  return JSON.parse(line) as { report_id: string; created: boolean };
}

/** The job's failure write, as the job makes it: service role, scoped to the organisation. */
async function failAsJob(org: string, reportId: string, tokens = 0): Promise<void> {
  const { error } = await serviceClientScoped(org).schema('api_server').rpc('fail_marketing_report', {
    p_org: org, p_report: reportId, p_failure: 'Fixture failure.', p_input_tokens: tokens, p_output_tokens: 0,
  });
  if (error) throw new Error(error.message);
}

const FAKES = (overrides: Partial<MarketingReportDeps> = {}): Partial<MarketingReportDeps> => ({
  loadFinancials: async () => SAMPLE_MARKETING_REPORT.financials,
  generateNarrative: async () => ({
    ok: true as const, narrative: SAMPLE_MARKETING_REPORT.narrative,
    model: 'gpt-fixture', promptVersion: 'marketing-prompt-fixture', inputTokens: 1200, outputTokens: 3400,
  }),
  ...overrides,
});

const READY_PROFILE = {
  website: 'bearabeara.co.uk',
  socialLinks: [{ label: '', url: 'instagram.com/beara_beara' }],
  productsServices: 'Luxury leather bags',
  industry: 'Luxury leather accessories',
  description: 'Vintage-inspired British design, made by leather craftspeople in Bolivia.',
};

/**
 * Each organisation is founded by its own throwaway user (a person may create three a day), and the
 * one owner of the suite is made an owner of every one.
 */
async function createOrg(name: string): Promise<string> {
  const founder = name === 'Main' ? ownerId : createAuthUser(`founder-${name.toLowerCase()}@${DOMAIN}`);
  const created = await clientFor(founder).schema('api').rpc('create_organization', { p_name: `${PREFIX} ${name}` });
  if (created.error) throw new Error(`fixture org failed: ${created.error.message}`);
  const org = created.data as unknown as string;
  if (founder !== ownerId) {
    adminSql(`insert into public.organization_memberships (organization_id, user_id, role, status)
              values ('${org}', '${ownerId}', 'owner', 'active')`);
  }
  return org;
}

beforeAll(async () => {
  ownerId = createAuthUser(`owner@${DOMAIN}`);
  adminId = createAuthUser(`admin@${DOMAIN}`);
  clientId = createAuthUser(`client@${DOMAIN}`);
  adviserId = createAuthUser(`adviser@${DOMAIN}`);
  strangerId = createAuthUser(`stranger@${DOMAIN}`);
  orgA = await createOrg('Main');
  orgE = await createOrg('Empty');
  orgM = await createOrg('Switch');
  orgT = await createOrg('Throttle');
  slugA = one(`select slug::text from public.organizations where id = '${orgA}'`);
  adminSql(`
    insert into public.organization_memberships (organization_id, user_id, role, status)
    values ('${orgA}', '${adminId}', 'admin', 'active'), ('${orgA}', '${clientId}', 'client', 'active');
    insert into public.platform_users (user_id, platform_role, status) values ('${adviserId}', 'employee', 'active');
    insert into public.organization_assignments (organization_id, employee_user_id, status) values ('${orgA}', '${adviserId}', 'active');`);
  for (const org of [orgM, orgT]) await setCompanyProfile(owner(org), READY_PROFILE);
});

afterAll(() => {
  adminSql(`
    select set_config('app.purge', 'on', false);
    delete from public.api_rate_limits where actor_user_id in (select id from public.organizations where name like '${PREFIX}%')
       or actor_user_id in (select id from auth.users where email like '%@${DOMAIN}');
    delete from public.notifications where organization_id in (select id from public.organizations where name like '${PREFIX}%');
    delete from public.marketing_reports where organization_id in (select id from public.organizations where name like '${PREFIX}%');
    delete from public.organizations where name like '${PREFIX}%';
    delete from public.platform_users where user_id in (select id from auth.users where email like '%@${DOMAIN}');
    delete from auth.users where email like '%@${DOMAIN}';`);
});

describe('the company profile', () => {
  it('is saved by the owner: a bare domain gains https://, a link is named, and the industry is the organisation\'s', async () => {
    await setCompanyProfile(owner(), READY_PROFILE);
    expect(await getCompanyProfile(client())).toEqual({
      website: 'https://bearabeara.co.uk',
      socialLinks: [{ label: 'Instagram', url: 'https://instagram.com/beara_beara' }],
      productsServices: 'Luxury leather bags',
      industry: 'Luxury leather accessories',
      description: 'Vintage-inspired British design, made by leather craftspeople in Bolivia.',
    });
    expect(one(`select industry from public.organizations where id = '${orgA}'`)).toBe('Luxury leather accessories');
    expect(one(`select count(*) from public.audit_events where organization_id = '${orgA}' and action = 'company_profile.updated'`)).toBe('1');
  });

  it('may be edited by an admin and the assigned adviser, and not by a client or a stranger', async () => {
    await setCompanyProfile(admin(), { ...READY_PROFILE, description: 'Edited by the admin.' });
    await setCompanyProfile(adviser(), { ...READY_PROFILE, description: 'Edited by the adviser.' });
    expect(one(`select description from public.organization_profiles where organization_id = '${orgA}'`)).toBe('Edited by the adviser.');

    await expect(setCompanyProfile(client(), READY_PROFILE)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    const args = { p_org: orgA, p_website: null, p_social_links: [], p_products_services: 'x', p_industry: null, p_description: null };
    expect(sqlstate((await rpcAs(clientId, 'set_company_profile', args)).error)).toBe('42501');
    expect(sqlstate((await rpcAs(strangerId, 'set_company_profile', args)).error)).toBe('P0002');
  });

  it('refuses, at the database, what is not a web address and what is too long', async () => {
    const base = { p_org: orgA, p_website: null, p_social_links: [], p_products_services: 'Bags', p_industry: null, p_description: null };
    const refused = async (patch: Record<string, unknown>) => sqlstate((await rpcAs(ownerId, 'set_company_profile', { ...base, ...patch })).error);
    expect(await refused({ p_website: 'javascript:alert(1)' })).toBe('22023');
    expect(await refused({ p_website: 'bearabeara.co.uk' })).toBe('22023');
    expect(await refused({ p_social_links: [{ label: 'Files', url: 'ftp://example.com' }] })).toBe('22023');
    expect(await refused({ p_social_links: [{ label: ' ', url: 'https://example.com' }] })).toBe('22023');
    expect(await refused({ p_social_links: Array.from({ length: 13 }, (_, i) => ({ label: `L${i}`, url: `https://example.com/${i}` })) })).toBe('22023');
    expect(await refused({ p_products_services: 'x'.repeat(2001) })).toBe('22023');
    expect(await refused({ p_industry: 'x'.repeat(121) })).toBe('22023');
    // The service says what is wrong before the database is asked.
    await expect(setCompanyProfile(owner(), { website: 'mailto:hello@example.com' })).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('is written through the function only, and read only by the organisation', async () => {
    const { error } = await clientFor(ownerId).from('organization_profiles').insert({ organization_id: orgA });
    expect(error).not.toBeNull();
    const { data } = await clientFor(strangerId).from('organization_profiles').select('organization_id').eq('organization_id', orgA);
    expect(data ?? []).toEqual([]);
  });
});

describe('asking for the report', () => {
  let firstId: string;

  it('is refused until the profile says what the company sells or its industry', async () => {
    const { error } = await rpcAs(ownerId, 'request_marketing_report', { p_org: orgE });
    expect(sqlstate(error)).toBe('22023');
    expect(error?.message).toMatch(/company profile/);
    expect(one(`select count(*) from public.marketing_reports where organization_id = '${orgE}'`)).toBe('0');
  });

  it('is refused to a client and to a stranger', async () => {
    await expect(requestMarketingReport(client())).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(sqlstate((await rpcAs(clientId, 'request_marketing_report', { p_org: orgA })).error)).toBe('42501');
    expect(sqlstate((await rpcAs(strangerId, 'request_marketing_report', { p_org: orgA })).error)).toBe('P0002');
  });

  it('queues one attempt and one single-attempt job; a second press returns the same attempt and spends nothing', async () => {
    const first = requestParked(ownerId, orgA);
    expect(first.created).toBe(true);
    firstId = first.report_id;

    const again = await requestMarketingReport(adviser());
    expect(again).toEqual({ reportId: firstId, created: false });

    const job = JSON.parse(one(`select json_build_object('n', count(*), 'max', max(max_attempts), 'report', max(payload ->> 'reportId'),
      'by', max(requested_by::text)) from public.jobs where organization_id = '${orgA}' and job_type = 'marketing.generate'`));
    expect(job).toEqual({ n: 1, max: 1, report: firstId, by: ownerId });
    expect(one(`select job_id is not null and status = 'queued' from public.marketing_reports where id = '${firstId}'`)).toBe('t');

    const view = await getMarketingView(owner());
    expect(view).toMatchObject({ status: 'queued', report: null, failure: null, profileReady: true, canRefresh: true, canEditProfile: true });
    expect(await getMarketingView(client())).toMatchObject({ status: 'queued', canRefresh: false, canEditProfile: false });
  });

  it('is written by the job: ready, with what it cost, counted under the monthly ceiling, and the requester is told', async () => {
    const outcome = await withOrgScope(orgA, (scope) => runMarketingReport(scope.db, orgA, firstId, FAKES()));
    expect(outcome).toMatchObject({ status: 'ready', reportId: firstId });

    const row = JSON.parse(one(`select json_build_object('status', status, 'version', report_version, 'model', model,
      'prompt', prompt_version, 'in', input_tokens, 'out', output_tokens, 'finished', finished_at is not null)
      from public.marketing_reports where id = '${firstId}'`));
    expect(row).toEqual({ status: 'ready', version: MARKETING_REPORT_VERSION, model: 'gpt-fixture', prompt: 'marketing-prompt-fixture', in: 1200, out: 3400, finished: true });
    expect(Number(one(`select app.ai_tokens_used_this_month('${orgA}')`))).toBeGreaterThanOrEqual(4600);

    const view = await getMarketingView(client());
    expect(view.status).toBe('ready');
    expect(view.report).toMatchObject({ organisationName: `${PREFIX} Main`, version: MARKETING_REPORT_VERSION, model: 'gpt-fixture' });
    expect(view.report?.sources[0]).toEqual({ label: `${PREFIX} Main website`, url: 'https://bearabeara.co.uk' });
    expect(await getLatestMarketingReport(client())).toEqual(view.report);

    expect(one(`select kind || '|' || title || '|' || href from public.notifications where organization_id = '${orgA}' and user_id = '${ownerId}'`))
      .toBe(`report_ready|Your marketing report is ready|/app/${slugA}/marketing`);
    expect(one(`select count(*) from public.audit_events where organization_id = '${orgA}' and action = 'marketing.report_ready'`)).toBe('1');
  });

  it('keeps a finished report as it was, and nobody writes the table directly', async () => {
    expect(() => adminSql(`update public.marketing_reports set model = 'other' where id = '${firstId}'`)).toThrow(/IMMUTABLE/);
    expect(() => adminSql(`delete from public.marketing_reports where id = '${firstId}'`)).toThrow(/IMMUTABLE/);
    const { error } = await clientFor(ownerId).from('marketing_reports').insert({ organization_id: orgA });
    expect(error).not.toBeNull();
  });

  it('keeps the last report on the page when a refresh fails, and says why', async () => {
    const refresh = requestParked(ownerId, orgA);
    expect(refresh.created).toBe(true);
    const outcome = await withOrgScope(orgA, (scope) => runMarketingReport(scope.db, orgA, refresh.report_id, FAKES({
      generateNarrative: async () => ({ ok: false as const, reason: 'fixture refusal', model: 'gpt-fixture', promptVersion: 'p', inputTokens: 10, outputTokens: 5 }),
    })));
    expect(outcome).toMatchObject({ status: 'failed', failure: MARKETING_FAILURES.draftRefused });

    const view = await getMarketingView(owner());
    expect(view).toMatchObject({ status: 'failed', failure: MARKETING_FAILURES.draftRefused });
    expect(view.report?.model).toBe('gpt-fixture');
    expect(one(`select input_tokens + output_tokens from public.marketing_reports where id = '${refresh.report_id}'`)).toBe('15');

    // A finished row admits one change: a link cleared by its foreign key (an account or a job removed).
    expect(() => adminSql(`update public.marketing_reports set requested_by = null, job_id = null where id = '${refresh.report_id}'`)).not.toThrow();
  });

  it('runs end to end through the registered handler (the writer offline, so no model is called)', async () => {
    expect(process.env.MOTION_AI_OFFLINE).toBe('1');
    const parked = requestParked(ownerId, orgA);
    const jobId = one(`select id::text from public.jobs where organization_id = '${orgA}' and job_type = 'marketing.generate'
      and payload ->> 'reportId' = '${parked.report_id}'`);
    const outcome = await withOrgScope(orgA, (scope) => runMarketingGenerateJob({
      jobId, organizationId: orgA, jobType: 'marketing.generate', payload: { reportId: parked.report_id },
      requestedBy: ownerId, attempts: 1, maxAttempts: 1,
    }, scope));
    expect(outcome).toMatchObject({ status: 'succeeded', result: { reportId: parked.report_id, model: 'offline-template' } });
    expect(one(`select status from public.marketing_reports where id = '${parked.report_id}'`)).toBe('ready');
    adminSql(`update public.jobs set status = 'succeeded', finished_at = now() where id = '${jobId}'`);
  });
});

describe('an attempt never outlives its job', () => {
  it('is failed when its job ends without finishing it', async () => {
    const parked = requestParked(ownerId, orgM);
    adminSql(`update public.jobs set status = 'dead', finished_at = now()
               where organization_id = '${orgM}' and payload ->> 'reportId' = '${parked.report_id}'`);
    expect(one(`select status || '|' || failure from public.marketing_reports where id = '${parked.report_id}'`))
      .toBe('failed|The report could not be finished. Refresh it to try again.');
    // …so it no longer holds the slot.
    const next = requestParked(ownerId, orgM);
    expect(next.created).toBe(true);
    await failAsJob(orgM, next.report_id);
  });
});

describe('Marketing switched off', () => {
  it('is absent: no request, no report read, and an attempt already queued is failed when its job starts', async () => {
    const queued = requestParked(ownerId, orgM);
    adminSql(`update public.organizations set features = features || '{"module_marketing": false}' where id = '${orgM}'`);
    try {
      expect(sqlstate((await rpcAs(ownerId, 'request_marketing_report', { p_org: orgM })).error)).toBe('P0002');
      await expect(getMarketingView(owner(orgM))).rejects.toMatchObject({ code: 'NOT_FOUND' });
      const { data } = await clientFor(ownerId).from('marketing_reports').select('id').eq('organization_id', orgM);
      expect(data ?? []).toEqual([]);

      const outcome = await withOrgScope(orgM, (scope) => runMarketingReport(scope.db, orgM, queued.report_id, FAKES()));
      expect(outcome.status).toBe('skipped');
      expect(one(`select status || '|' || failure from public.marketing_reports where id = '${queued.report_id}'`))
        .toBe('failed|Marketing is switched off for this company.');
    } finally {
      adminSql(`update public.organizations set features = features - 'module_marketing' where id = '${orgM}'`);
    }
    const { data } = await clientFor(ownerId).from('marketing_reports').select('id').eq('organization_id', orgM);
    expect((data ?? []).length).toBeGreaterThan(0);
  });

  it('is a switch the super admin\'s function accepts', () => {
    // Driving it needs the platform's one super admin (ADR-159), which a test never borrows; the
    // function's own allow-list is what api.set_org_module checks.
    expect(one(`select pg_get_functiondef('api.set_org_module(uuid,text,boolean)'::regprocedure) like '%''module_marketing''%'`)).toBe('t');
  });
});

describe('limits', () => {
  it('allows three reports an hour per organisation', async () => {
    for (let i = 0; i < 3; i += 1) {
      const r = requestParked(ownerId, orgT);
      expect(r.created).toBe(true);
      await failAsJob(orgT, r.report_id, 10);
    }
    const { error } = await rpcAs(ownerId, 'request_marketing_report', { p_org: orgT });
    expect(sqlstate(error)).toBe('53400');
    expect(one(`select count(*) from public.marketing_reports where organization_id = '${orgT}'`)).toBe('3');
  });

  it('stops at the organisation\'s monthly AI allowance', async () => {
    await setCompanyProfile(owner(orgE), { productsServices: 'Garden design' });
    adminSql(`insert into public.platform_org_settings (organization_id, ai_token_ceiling_monthly) values ('${orgE}', 0)
              on conflict (organization_id) do update set ai_token_ceiling_monthly = 0`);
    const { error } = await rpcAs(ownerId, 'request_marketing_report', { p_org: orgE });
    expect(sqlstate(error)).toBe('53400');
    expect(error?.message).toMatch(/allowance/);
  });
});

describe('the purge', () => {
  it('removes the profile and every report with the organisation', async () => {
    adminSql(`update public.jobs set status = 'cancelled', finished_at = now() where organization_id = '${orgM}' and status in ('queued', 'running');
              update public.organizations set status = 'pending_deletion', deletion_requested_at = now() - interval '31 days' where id = '${orgM}';`);
    const { data, error } = await serviceClientScoped(orgM).schema('api_server').rpc('purge_organization', { p_org: orgM, p_job: null });
    expect(error).toBeNull();
    expect((data as { status: string }).status).toBe('purged');
    expect(one(`select (select count(*) from public.marketing_reports where organization_id = '${orgM}')
                     + (select count(*) from public.organization_profiles where organization_id = '${orgM}')`)).toBe('0');
  });
});
