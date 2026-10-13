import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withOrgScope } from '@/core/db';
import { permissionsFor, type EffectiveRole } from '@/core/permissions';
import { runInvestmentGenerateJob } from '@/modules/jobs';
import { enabledModules, type AccessContext } from '@/modules/tenancy';
import {
  INVESTMENT_FAILURES, INVESTMENT_REPORT_VERSION, getInvestmentView, getLatestInvestmentReport,
  requestInvestmentReport, runInvestmentReport, type InvestmentReportDeps,
} from '@/modules/investment';
import { SAMPLE_INVESTMENT_REPORT } from '../fixtures/investment/sample-report';
import { adminSql, clientFor, createAuthUser, serviceClientScoped, sqlstate } from './setup';

/**
 * ADR-171 over the real wire: asking for the Investment Pack (who may spend AI on it, the amount to
 * allocate and its bounds, a company with nothing to allocate, one at a time, three an hour, the
 * monthly allowance, the system switch) and the job's writes (ready, failed, an attempt whose job ends
 * without finishing, what an attempt was asked for never changing, the purge).
 *
 * NO MODEL IS CALLED. The base year and the narrative are fakes handed to `runInvestmentReport` (the
 * client's own example); the one test that drives the registered handler runs on a company with no
 * figures, which the job fails before any model is reached — and the writer is offline anyway
 * (`MOTION_AI_OFFLINE=1`). No worker can take a job this file queues: every request that creates one
 * runs inside a transaction that also moves the job's `run_after` a month out before it commits
 * (`requestParked`), so another suite draining the shared queue never sees it as due. A request made
 * any other way is one the database refuses, or one that returns the attempt already in flight.
 *
 * Run-unique fixtures under a name no other suite's `resetFixtures()` deletes; cleaned up by name.
 */

process.env.MOTION_AI_OFFLINE = '1';

const RUN = `i${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.investment.itest`;
const PREFIX = `InvTest ${RUN}`;
const SAMPLE = SAMPLE_INVESTMENT_REPORT;

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
  userId, orgId: org, orgSlug: 'inv', effectiveRole: role, permissions: permissionsFor(role), actorType: 'user',
  db: clientFor(userId, { email: `${role}-${userId.slice(0, 4)}@${DOMAIN}` }), requestId: `itest-${RUN}`, now: () => new Date(),
  organizationStatus: 'active', modules: enabledModules(features(org)),
});
const owner = (org = orgA) => ctxFor(ownerId, 'owner', org);
const client = () => ctxFor(clientId, 'client');
const adviser = () => ctxFor(adviserId, 'employee');
const rpcAs = (userId: string, fn: string, args: Record<string, unknown>) => clientFor(userId).schema('api').rpc(fn, args);
const countReports = (org: string) => one(`select count(*) from public.investment_reports where organization_id = '${org}'`);

/**
 * `api.request_investment_report` as the user would call it — same function, same JWT claims, same
 * role — inside one transaction that parks the job it queued before anyone else can see it.
 */
function requestParked(userId: string, org: string, surplus: string | null = null): { report_id: string; created: boolean } {
  const claims = JSON.stringify({ sub: userId, role: 'authenticated', email: `parked@${DOMAIN}` });
  const out = adminSql(`
    begin;
    select set_config('request.jwt.claims', '${claims}', true);
    set local role authenticated;
    select api.request_investment_report('${org}', ${surplus === null ? 'null' : surplus})::text;
    reset role;
    update public.jobs set run_after = now() + interval '30 days'
     where organization_id = '${org}' and job_type = 'investment.generate' and status = 'queued';
    commit;`);
  const line = out.split('\n').map((l) => l.trim()).find((l) => l.startsWith('{') && l.includes('"report_id"'));
  if (!line) throw new Error(`the request returned nothing: ${out}`);
  return JSON.parse(line) as { report_id: string; created: boolean };
}

/** The job's failure write, as the job makes it: service role, scoped to the organisation. */
async function failAsJob(org: string, reportId: string, tokens = 0): Promise<void> {
  const { error } = await serviceClientScoped(org).schema('api_server').rpc('fail_investment_report', {
    p_org: org, p_report: reportId, p_failure: 'Fixture failure.', p_input_tokens: tokens, p_output_tokens: 0,
  });
  if (error) throw new Error(error.message);
}

/** The client's example as the base year and the narrative; APX's own arithmetic builds the figures. */
const FAKES = (overrides: Partial<InvestmentReportDeps> = {}): Partial<InvestmentReportDeps> => ({
  loadBase: async () => SAMPLE.figures.base,
  generateNarrative: async () => ({
    ok: true as const, narrative: SAMPLE.narrative,
    model: 'gpt-fixture', promptVersion: 'investment-prompt-fixture', inputTokens: 1200, outputTokens: 3400,
  }),
  ...overrides,
});

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
});

afterAll(() => {
  adminSql(`
    select set_config('app.purge', 'on', false);
    delete from public.api_rate_limits where actor_user_id in (select id from public.organizations where name like '${PREFIX}%')
       or actor_user_id in (select id from auth.users where email like '%@${DOMAIN}');
    delete from public.notifications where organization_id in (select id from public.organizations where name like '${PREFIX}%');
    delete from public.investment_reports where organization_id in (select id from public.organizations where name like '${PREFIX}%');
    delete from public.organizations where name like '${PREFIX}%';
    delete from public.platform_users where user_id in (select id from auth.users where email like '%@${DOMAIN}');
    delete from auth.users where email like '%@${DOMAIN}';`);
});

describe('asking for the pack', () => {
  let firstId: string;

  it('is refused to a client and to a stranger', async () => {
    await expect(requestInvestmentReport(client(), { surplus: null })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(sqlstate((await rpcAs(clientId, 'request_investment_report', { p_org: orgA })).error)).toBe('42501');
    expect(sqlstate((await rpcAs(strangerId, 'request_investment_report', { p_org: orgA })).error)).toBe('P0002');
    expect(countReports(orgA)).toBe('0');
  });

  it('refuses an amount below 1 or beyond any company\'s means — at the database and in the service', async () => {
    for (const bad of [0.5, 0.99, 0, -10, 1_000_000_000_000.01, 'NaN', 'Infinity', '-Infinity']) {
      const { error } = await rpcAs(ownerId, 'request_investment_report', { p_org: orgA, p_surplus: bad });
      expect(sqlstate(error), String(bad)).toBe('22023');
    }
    const { error } = await rpcAs(ownerId, 'request_investment_report', { p_org: orgA, p_surplus: 0.4 });
    expect(error?.message).toBe('VALIDATION: Enter an amount of at least 1.');

    await expect(requestInvestmentReport(owner(), { surplus: '0.40' }))
      .rejects.toMatchObject({ code: 'VALIDATION', message: 'Enter an amount of at least 1.', issues: [{ path: 'surplus' }] });
    await expect(requestInvestmentReport(owner(), { surplus: 'ninety thousand' })).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(countReports(orgA)).toBe('0');
  });

  it('is refused by the service, in the job\'s own words, when APX holds no figures for the company', async () => {
    await expect(requestInvestmentReport(owner(), { surplus: null }))
      .rejects.toMatchObject({ code: 'VALIDATION', message: INVESTMENT_FAILURES.noFigures });
    await expect(requestInvestmentReport(owner(), { surplus: '95,000' }))
      .rejects.toMatchObject({ code: 'VALIDATION', message: INVESTMENT_FAILURES.noFigures });
    expect(countReports(orgA)).toBe('0');
  });

  it('queues one attempt, with the amount entered, and one single-attempt job; a second press returns the same attempt and spends nothing', async () => {
    const first = requestParked(ownerId, orgA, '95000.5');
    expect(first.created).toBe(true);
    firstId = first.report_id;
    expect(one(`select assumptions::text from public.investment_reports where id = '${firstId}'`)).toBe('{"surplus": "95000.50"}');

    // Another person, another amount: the attempt under way is returned, unchanged, and nothing is queued.
    const { data, error } = await rpcAs(adviserId, 'request_investment_report', { p_org: orgA, p_surplus: 1234 });
    expect(error).toBeNull();
    expect(data).toEqual({ report_id: firstId, created: false });
    expect(one(`select assumptions ->> 'surplus' from public.investment_reports where id = '${firstId}'`)).toBe('95000.50');

    const job = JSON.parse(one(`select json_build_object('n', count(*), 'max', max(max_attempts), 'report', max(payload ->> 'reportId'),
      'by', max(requested_by::text)) from public.jobs where organization_id = '${orgA}' and job_type = 'investment.generate'`));
    expect(job).toEqual({ n: 1, max: 1, report: firstId, by: ownerId });
    expect(one(`select job_id is not null and status = 'queued' from public.investment_reports where id = '${firstId}'`)).toBe('t');
    expect(one(`select after -> 'assumptions' ->> 'surplus' from public.audit_events
                 where organization_id = '${orgA}' and action = 'investment.report_requested' and target_id = '${firstId}'`)).toBe('95000.50');

    const view = await getInvestmentView(owner());
    expect(view).toMatchObject({
      organisationName: `${PREFIX} Main`, status: 'queued', report: null, failure: null, base: null, defaultSurplus: null,
      canRefresh: true, canEditProfile: true,
    });
    expect(await getInvestmentView(client())).toMatchObject({ status: 'queued', canRefresh: false, canEditProfile: false });
    // The assigned adviser may refresh the pack and edit the profile it reads.
    expect(await getInvestmentView(adviser())).toMatchObject({ status: 'queued', canRefresh: true, canEditProfile: true });
  });

  it('is written by the job: ready, built on the amount entered, with what it cost, counted under the monthly ceiling, and the requester is told', async () => {
    const outcome = await withOrgScope(orgA, (scope) => runInvestmentReport(scope.db, orgA, firstId, FAKES()));
    expect(outcome).toMatchObject({ status: 'ready', reportId: firstId });

    const row = JSON.parse(one(`select json_build_object('status', status, 'version', report_version, 'model', model,
      'prompt', prompt_version, 'in', input_tokens, 'out', output_tokens, 'finished', finished_at is not null)
      from public.investment_reports where id = '${firstId}'`));
    expect(row).toEqual({ status: 'ready', version: INVESTMENT_REPORT_VERSION, model: 'gpt-fixture', prompt: 'investment-prompt-fixture', in: 1200, out: 3400, finished: true });
    expect(Number(one(`select app.ai_tokens_used_this_month('${orgA}')`))).toBeGreaterThanOrEqual(4600);

    const view = await getInvestmentView(client());
    expect(view.status).toBe('ready');
    expect(view.report).toMatchObject({ organisationName: `${PREFIX} Main`, version: INVESTMENT_REPORT_VERSION, model: 'gpt-fixture' });
    expect(view.report?.figures.assumptions.surplusSource).toBe('analyst');
    expect(view.report?.portfolio.map((p) => p.assetClass)).toEqual(SAMPLE.narrative.portfolio.map((p) => p.assetClass));
    expect(await getLatestInvestmentReport(client())).toEqual(view.report);

    expect(one(`select kind || '|' || title || '|' || href from public.notifications where organization_id = '${orgA}' and user_id = '${ownerId}'`))
      .toBe(`report_ready|Your investment pack is ready|/app/${slugA}/investment`);
    expect(one(`select count(*) from public.audit_events where organization_id = '${orgA}' and action = 'investment.report_ready'`)).toBe('1');
  });

  it('keeps a finished pack as it was, and nobody writes the table directly', async () => {
    expect(() => adminSql(`update public.investment_reports set model = 'other' where id = '${firstId}'`)).toThrow(/IMMUTABLE/);
    expect(() => adminSql(`delete from public.investment_reports where id = '${firstId}'`)).toThrow(/IMMUTABLE/);
    const { error } = await clientFor(ownerId).from('investment_reports').insert({ organization_id: orgA });
    expect(error).not.toBeNull();
    // Only an investment-v1 document is stored as a pack.
    const wrong = await serviceClientScoped(orgA).schema('api_server').rpc('finish_investment_report', {
      p_org: orgA, p_report: firstId, p_content: { version: 'marketing-v1' }, p_model: 'm', p_prompt_version: 'p',
      p_input_tokens: 0, p_output_tokens: 0,
    });
    expect(sqlstate(wrong.error)).toBe('22023');
  });

  it('keeps the last pack on the page when a refresh fails, and says why; what an attempt was asked for never changes', async () => {
    const refresh = requestParked(ownerId, orgA);
    expect(refresh.created).toBe(true);
    expect(one(`select assumptions::text from public.investment_reports where id = '${refresh.report_id}'`)).toBe('{}');
    // Even in flight, the amount an attempt was asked for is fixed.
    expect(() => adminSql(`update public.investment_reports set assumptions = '{"surplus": "1.00"}' where id = '${refresh.report_id}'`))
      .toThrow(/IMMUTABLE/);

    const outcome = await withOrgScope(orgA, (scope) => runInvestmentReport(scope.db, orgA, refresh.report_id, FAKES({
      generateNarrative: async () => ({ ok: false as const, reason: 'fixture refusal', model: 'gpt-fixture', promptVersion: 'p', inputTokens: 10, outputTokens: 5 }),
    })));
    expect(outcome).toMatchObject({ status: 'failed', failure: INVESTMENT_FAILURES.draftRefused });

    const view = await getInvestmentView(owner());
    expect(view).toMatchObject({ status: 'failed', failure: INVESTMENT_FAILURES.draftRefused });
    expect(view.report?.model).toBe('gpt-fixture');
    expect(one(`select input_tokens + output_tokens from public.investment_reports where id = '${refresh.report_id}'`)).toBe('15');
    expect(one(`select count(*) from public.audit_events where organization_id = '${orgA}' and action = 'investment.report_failed'`)).toBe('1');

    // A finished row admits one change: a link cleared by its foreign key (an account or a job removed).
    expect(() => adminSql(`update public.investment_reports set requested_by = null, job_id = null where id = '${refresh.report_id}'`)).not.toThrow();
  });

  it('runs end to end through the registered handler: a company with no figures is failed before any model is reached', async () => {
    const parked = requestParked(ownerId, orgA);
    const jobId = one(`select id::text from public.jobs where organization_id = '${orgA}' and job_type = 'investment.generate'
      and payload ->> 'reportId' = '${parked.report_id}'`);
    const outcome = await withOrgScope(orgA, (scope) => runInvestmentGenerateJob({
      jobId, organizationId: orgA, jobType: 'investment.generate', payload: { reportId: parked.report_id },
      requestedBy: ownerId, attempts: 1, maxAttempts: 1,
    }, scope));
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toContain(INVESTMENT_FAILURES.noFigures);
    expect(one(`select status || '|' || failure || '|' || (input_tokens + output_tokens) from public.investment_reports where id = '${parked.report_id}'`))
      .toBe(`failed|${INVESTMENT_FAILURES.noFigures}|0`);
    adminSql(`update public.jobs set status = 'dead', finished_at = now() where id = '${jobId}'`);
    // The job's end changes nothing about an attempt that already finished.
    expect(one(`select failure from public.investment_reports where id = '${parked.report_id}'`)).toBe(INVESTMENT_FAILURES.noFigures);
  });
});

describe('an attempt never outlives its job', () => {
  it('is failed when its job ends without finishing it', async () => {
    const parked = requestParked(ownerId, orgM);
    adminSql(`update public.jobs set status = 'dead', finished_at = now()
               where organization_id = '${orgM}' and payload ->> 'reportId' = '${parked.report_id}'`);
    expect(one(`select status || '|' || failure from public.investment_reports where id = '${parked.report_id}'`))
      .toBe('failed|The pack could not be finished. Refresh it to try again.');
    // …so it no longer holds the slot.
    const next = requestParked(ownerId, orgM);
    expect(next.created).toBe(true);
    await failAsJob(orgM, next.report_id);
  });
});

describe('Investment switched off', () => {
  it('is absent: no request, no pack read, and an attempt already queued is failed when its job starts', async () => {
    const queued = requestParked(ownerId, orgM);
    adminSql(`update public.organizations set features = features || '{"module_investment": false}' where id = '${orgM}'`);
    try {
      expect(sqlstate((await rpcAs(ownerId, 'request_investment_report', { p_org: orgM })).error)).toBe('P0002');
      await expect(getInvestmentView(owner(orgM))).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(requestInvestmentReport(owner(orgM), { surplus: '1000' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      const { data } = await clientFor(ownerId).from('investment_reports').select('id').eq('organization_id', orgM);
      expect(data ?? []).toEqual([]);

      const outcome = await withOrgScope(orgM, (scope) => runInvestmentReport(scope.db, orgM, queued.report_id, FAKES()));
      expect(outcome.status).toBe('skipped');
      expect(one(`select status || '|' || failure from public.investment_reports where id = '${queued.report_id}'`))
        .toBe('failed|Investment is switched off for this company.');
    } finally {
      adminSql(`update public.organizations set features = features - 'module_investment' where id = '${orgM}'`);
    }
    const { data } = await clientFor(ownerId).from('investment_reports').select('id').eq('organization_id', orgM);
    expect((data ?? []).length).toBeGreaterThan(0);
  });

  it('is a switch the super admin\'s function accepts', () => {
    // Driving it needs the platform's one super admin (ADR-159), which a test never borrows; the
    // function's own allow-list is what api.set_org_module checks.
    expect(one(`select pg_get_functiondef('api.set_org_module(uuid,text,boolean)'::regprocedure) like '%''module_investment''%'`)).toBe('t');
    expect(one(`select pg_get_functiondef('api.set_org_module(uuid,text,boolean)'::regprocedure) like '%''module_marketing''%'`)).toBe('t');
  });
});

describe('limits', () => {
  it('allows three packs an hour per organisation, and their tokens count under the monthly ceiling', async () => {
    for (let i = 0; i < 3; i += 1) {
      const r = requestParked(ownerId, orgT, i === 0 ? '5000' : null);
      expect(r.created).toBe(true);
      await failAsJob(orgT, r.report_id, 10);
    }
    const { error } = await rpcAs(ownerId, 'request_investment_report', { p_org: orgT });
    expect(sqlstate(error)).toBe('53400');
    expect(countReports(orgT)).toBe('3');
    expect(Number(one(`select app.ai_tokens_used_this_month('${orgT}')`))).toBeGreaterThanOrEqual(30);
  });

  it('stops at the organisation\'s monthly AI allowance', async () => {
    adminSql(`insert into public.platform_org_settings (organization_id, ai_token_ceiling_monthly) values ('${orgE}', 0)
              on conflict (organization_id) do update set ai_token_ceiling_monthly = 0`);
    const { error } = await rpcAs(ownerId, 'request_investment_report', { p_org: orgE, p_surplus: 1000 });
    expect(sqlstate(error)).toBe('53400');
    expect(error?.message).toMatch(/allowance/);
    expect(countReports(orgE)).toBe('0');
  });
});

describe('the purge', () => {
  it('removes every pack with the organisation', async () => {
    expect(Number(countReports(orgM))).toBeGreaterThan(0);
    adminSql(`update public.jobs set status = 'cancelled', finished_at = now() where organization_id = '${orgM}' and status in ('queued', 'running');
              update public.organizations set status = 'pending_deletion', deletion_requested_at = now() - interval '31 days' where id = '${orgM}';`);
    const { data, error } = await serviceClientScoped(orgM).schema('api_server').rpc('purge_organization', { p_org: orgM, p_job: null });
    expect(error).toBeNull();
    expect((data as { status: string; rows: Record<string, number> }).status).toBe('purged');
    expect((data as { rows: Record<string, number> }).rows.investment_reports).toBeGreaterThan(0);
    expect(countReports(orgM)).toBe('0');
  });
});
