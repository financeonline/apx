import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withOrgScope } from '@/core/db';
import { permissionsFor, type EffectiveRole } from '@/core/permissions';
import { runInvestmentGenerateJob } from '@/modules/jobs';
import { enabledModules, type AccessContext } from '@/modules/tenancy';
import {
  INVESTMENT_FAILURES, INVESTMENT_REPORT_VERSION, getInvestmentView, getLatestInvestmentReport,
  requestInvestmentReport, runInvestmentReport, type InvestmentReportDeps,
} from '@/modules/investment';
import { auth } from '@/db/firestore';
import { aiTokensUsedThisMonth, prepareInvestmentJobEnded } from '@/db/app/investment-quota';
import { ORG_SINGLETON_ID, orgCollection, orgRow } from '@/db/schema';
import { orgRows } from '@/db/rls';
import { SAMPLE_INVESTMENT_REPORT } from '../fixtures/investment/sample-report';
import { clientFor, createAuthUser, deleteOrg, fs, rpc, serviceClientScoped, sqlstate } from './setup';
import { addMember, assignEmployee, auditEvents, createOrgFixture, deletePlatformUser } from './r-fixtures';

/**
 * ADR-171 over the real functions: asking for the Investment Pack (who may spend AI on it, the amount
 * to allocate and its bounds, a company with nothing to allocate, one at a time, three an hour, the
 * monthly allowance, the system switch) and the job's writes (ready, failed, an attempt whose job ends
 * without finishing, the purge).
 *
 * NO MODEL IS CALLED. The base year and the narrative are fakes handed to `runInvestmentReport` (the
 * client's own example); the one test that drives the registered handler runs on a company with no
 * figures, which the job fails before any model is reached — and the writer is offline anyway
 * (`MOTION_AI_OFFLINE=1`). A job this file queues is parked a month out the moment the request
 * returns (`requestParked`), so another suite draining the shared queue does not take it.
 *
 * Run-unique fixtures (`ITest Investment ${RUN}`); only they are removed.
 */

process.env.MOTION_AI_OFFLINE = '1';

const RUN = `i${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.investment.itest.motion`;
const PREFIX = `ITest Investment ${RUN}`;
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
let orgS: string;
let slugA: string;
const users: string[] = [];

const features = async (org: string) => ((await fs().collection('organizations').doc(org).get()).get('features') ?? {}) as Record<string, unknown>;
const ctxFor = async (userId: string, role: EffectiveRole, org = orgA): Promise<AccessContext> => ({
  userId, orgId: org, orgSlug: 'inv', effectiveRole: role, permissions: permissionsFor(role), actorType: 'user',
  db: clientFor(userId, { email: `${role}-${userId.slice(0, 4)}@${DOMAIN}` }), requestId: `itest-${RUN}`, now: () => new Date(),
  organizationStatus: 'active', modules: enabledModules(await features(org)),
});
const owner = (org = orgA) => ctxFor(ownerId, 'owner', org);
const client = () => ctxFor(clientId, 'client');
const adviser = () => ctxFor(adviserId, 'employee');
const rpcAs = (userId: string, fn: string, args: Record<string, unknown>) => rpc(clientFor(userId), fn, args);
const reportsOf = async (org: string) => (await orgCollection(fs(), org, 'investment_reports').get()).docs.map((d) => d.data());
const countReports = async (org: string) => String((await reportsOf(org)).length);
const reportRow = async (org: string, id: string) => (await orgRow(fs(), org, 'investment_reports', id).get()).data()!;
const jobsOf = async (org: string) => (await fs().collection('jobs').where('organization_id', '==', org)
  .where('job_type', '==', 'investment.generate').get()).docs;

/**
 * `api.request_investment_report` as the user would call it — same function, same caller — and then
 * the job it queued is parked a month out, so no worker on the shared queue takes it.
 */
async function requestParked(userId: string, org: string, surplus: string | null = null): Promise<{ report_id: string; created: boolean }> {
  const { data, error } = await rpcAs(userId, 'request_investment_report', { p_org: org, p_surplus: surplus });
  if (error) throw error;
  const out = data as { report_id: string; created: boolean };
  const parked = new Date(Date.now() + 30 * 86_400_000).toISOString();
  for (const j of await jobsOf(org)) {
    if (j.get('status') === 'queued') await j.ref.update({ run_after: parked });
  }
  return out;
}

/** The job's failure write, as the job makes it: the server, scoped to the organisation. */
async function failAsJob(org: string, reportId: string, tokens = 0): Promise<void> {
  const { error } = await rpc(serviceClientScoped(org), 'fail_investment_report', {
    p_org: org, p_report: reportId, p_failure: 'Fixture failure.', p_input_tokens: tokens, p_output_tokens: 0,
  }, { server: true });
  if (error) throw error;
}

/**
 * The job ends without finishing (dead): what `api_server.finish_job` does now that the
 * `investment_job_ended` trigger is gone — the job's own update and `prepareInvestmentJobEnded` in
 * one transaction.
 */
async function endJob(org: string, jobId: string): Promise<void> {
  await fs().runTransaction(async (tx) => {
    const ended = await prepareInvestmentJobEnded(fs(), org, jobId, tx);
    tx.update(fs().collection('jobs').doc(jobId), { status: 'dead', finished_at: new Date().toISOString() });
    ended.write(tx);
  });
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

async function user(label: string): Promise<string> {
  const id = await createAuthUser(`${label}@${DOMAIN}`);
  users.push(id);
  return id;
}

async function createOrg(name: string): Promise<{ id: string; slug: string }> {
  return createOrgFixture({ name: `${PREFIX} ${name}`, ownerId });
}

beforeAll(async () => {
  ownerId = await user('owner');
  adminId = await user('admin');
  clientId = await user('client');
  adviserId = await user('adviser');
  strangerId = await user('stranger');
  const a = await createOrg('Main');
  orgA = a.id;
  slugA = a.slug;
  orgE = (await createOrg('Empty')).id;
  orgM = (await createOrg('Switch')).id;
  orgT = (await createOrg('Throttle')).id;
  orgS = (await createOrg('Stale')).id;
  await addMember(orgA, adminId, 'admin');
  await addMember(orgA, clientId, 'client');
  await assignEmployee(orgA, adviserId);
});

afterAll(async () => {
  for (const org of [orgA, orgE, orgM, orgT, orgS]) {
    if (!org) continue;
    for (const j of (await fs().collection('jobs').where('organization_id', '==', org).get()).docs) await j.ref.delete();
    await deleteOrg(org);
  }
  await deletePlatformUser(adviserId);
  for (const id of users) {
    await fs().collection('profiles').doc(id).delete();
    await auth().deleteUser(id).catch(() => undefined);
  }
});

describe('asking for the pack', () => {
  let firstId: string;

  it('is refused to a client and to a stranger', async () => {
    await expect(requestInvestmentReport(await client(), { surplus: null })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(sqlstate((await rpcAs(clientId, 'request_investment_report', { p_org: orgA })).error)).toBe('42501');
    expect(sqlstate((await rpcAs(strangerId, 'request_investment_report', { p_org: orgA })).error)).toBe('P0002');
    expect(await countReports(orgA)).toBe('0');
  });

  it('refuses an amount below 1 or beyond any company\'s means — at the database and in the service', async () => {
    for (const bad of [0.5, 0.99, 0, -10, 1_000_000_000_000.01, 'NaN', 'Infinity', '-Infinity']) {
      const { error } = await rpcAs(ownerId, 'request_investment_report', { p_org: orgA, p_surplus: bad });
      expect(sqlstate(error), String(bad)).toBe('22023');
    }
    const { error } = await rpcAs(ownerId, 'request_investment_report', { p_org: orgA, p_surplus: 0.4 });
    expect(error?.message).toBe('Enter an amount of at least 1.');

    await expect(requestInvestmentReport(await owner(), { surplus: '0.40' }))
      .rejects.toMatchObject({ code: 'VALIDATION', message: 'Enter an amount of at least 1.', issues: [{ path: 'surplus' }] });
    await expect(requestInvestmentReport(await owner(), { surplus: 'ninety thousand' })).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(await countReports(orgA)).toBe('0');
  });

  it('is refused by the service, in the job\'s own words, when APX holds no figures for the company', async () => {
    await expect(requestInvestmentReport(await owner(), { surplus: null }))
      .rejects.toMatchObject({ code: 'VALIDATION', message: INVESTMENT_FAILURES.noFigures });
    await expect(requestInvestmentReport(await owner(), { surplus: '95,000' }))
      .rejects.toMatchObject({ code: 'VALIDATION', message: INVESTMENT_FAILURES.noFigures });
    expect(await countReports(orgA)).toBe('0');
  });

  it('queues one attempt, with the amount entered, and one single-attempt job; a second press returns the same attempt and spends nothing', async () => {
    const first = await requestParked(ownerId, orgA, '95000.5');
    expect(first.created).toBe(true);
    firstId = first.report_id;
    expect((await reportRow(orgA, firstId)).assumptions).toEqual({ surplus: '95000.50' });

    // Another person, another amount: the attempt under way is returned, unchanged, and nothing is queued.
    const { data, error } = await rpcAs(adviserId, 'request_investment_report', { p_org: orgA, p_surplus: 1234 });
    expect(error).toBeNull();
    expect(data).toEqual({ report_id: firstId, created: false });
    expect((await reportRow(orgA, firstId)).assumptions.surplus).toBe('95000.50');

    const jobs = await jobsOf(orgA);
    expect(jobs.map((j) => ({ max: j.get('max_attempts'), report: j.get('payload').reportId, by: j.get('requested_by') })))
      .toEqual([{ max: 1, report: firstId, by: ownerId }]);
    const row = await reportRow(orgA, firstId);
    expect(row.job_id !== null && row.status === 'queued').toBe(true);
    const requested = await auditEvents(orgA, 'investment.report_requested');
    expect(requested.filter((e) => e.target_id === firstId).map((e) => e.after.assumptions.surplus)).toEqual(['95000.50']);

    const view = await getInvestmentView(await owner());
    expect(view).toMatchObject({
      organisationName: `${PREFIX} Main`, status: 'queued', report: null, failure: null, base: null, defaultSurplus: null,
      canRefresh: true, canEditProfile: true,
    });
    expect(await getInvestmentView(await client())).toMatchObject({ status: 'queued', canRefresh: false, canEditProfile: false });
    // The assigned adviser may refresh the pack and edit the profile it reads.
    expect(await getInvestmentView(await adviser())).toMatchObject({ status: 'queued', canRefresh: true, canEditProfile: true });
  });

  it('is written by the job: ready, built on the amount entered, with what it cost, counted under the monthly ceiling, and the requester is told', async () => {
    const outcome = await withOrgScope(orgA, (scope) => runInvestmentReport(scope.db, orgA, firstId, FAKES()));
    expect(outcome).toMatchObject({ status: 'ready', reportId: firstId });

    const r = await reportRow(orgA, firstId);
    expect({ status: r.status, version: r.report_version, model: r.model, prompt: r.prompt_version, in: r.input_tokens, out: r.output_tokens, finished: r.finished_at !== null })
      .toEqual({ status: 'ready', version: INVESTMENT_REPORT_VERSION, model: 'gpt-fixture', prompt: 'investment-prompt-fixture', in: 1200, out: 3400, finished: true });
    expect(await aiTokensUsedThisMonth(fs(), orgA)).toBeGreaterThanOrEqual(4600);

    const view = await getInvestmentView(await client());
    expect(view.status).toBe('ready');
    expect(view.report).toMatchObject({ organisationName: `${PREFIX} Main`, version: INVESTMENT_REPORT_VERSION, model: 'gpt-fixture' });
    expect(view.report?.figures.assumptions.surplusSource).toBe('analyst');
    expect(view.report?.portfolio.map((p) => p.assetClass)).toEqual(SAMPLE.narrative.portfolio.map((p) => p.assetClass));
    expect(await getLatestInvestmentReport(await client())).toEqual(view.report);

    const notes = (await orgCollection(fs(), orgA, 'notifications').where('user_id', '==', ownerId).get()).docs.map((d) => d.data());
    expect(notes.map((n) => `${n.kind}|${n.title}|${n.href}`)).toEqual([`report_ready|Your investment pack is ready|/app/${slugA}/investment`]);
    expect((await auditEvents(orgA, 'investment.report_ready')).length).toBe(1);
  });

  it('only an investment-v1 document is stored as a pack', async () => {
    // The finished pack is never rewritten (no write surface reaches it); the job's own write refuses
    // anything but an investment-v1 document.
    const wrong = await rpc(serviceClientScoped(orgA), 'finish_investment_report', {
      p_org: orgA, p_report: firstId, p_content: { version: 'marketing-v1' }, p_model: 'm', p_prompt_version: 'p',
      p_input_tokens: 0, p_output_tokens: 0,
    }, { server: true });
    expect(sqlstate(wrong.error)).toBe('22023');
    // And a finished pack is not finished again.
    const again = await rpc(serviceClientScoped(orgA), 'finish_investment_report', {
      p_org: orgA, p_report: firstId, p_content: { version: 'investment-v1' }, p_model: 'm', p_prompt_version: 'p',
      p_input_tokens: 0, p_output_tokens: 0,
    }, { server: true });
    expect(sqlstate(again.error)).toBe('23505');
    expect((await reportRow(orgA, firstId)).model).toBe('gpt-fixture');
  });

  it('keeps the last pack on the page when a refresh fails, and says why', async () => {
    const refresh = await requestParked(ownerId, orgA);
    expect(refresh.created).toBe(true);
    expect((await reportRow(orgA, refresh.report_id)).assumptions).toEqual({});

    const outcome = await withOrgScope(orgA, (scope) => runInvestmentReport(scope.db, orgA, refresh.report_id, FAKES({
      generateNarrative: async () => ({ ok: false as const, reason: 'fixture refusal', model: 'gpt-fixture', promptVersion: 'p', inputTokens: 10, outputTokens: 5 }),
    })));
    expect(outcome).toMatchObject({ status: 'failed', failure: INVESTMENT_FAILURES.draftRefused });

    const view = await getInvestmentView(await owner());
    expect(view).toMatchObject({ status: 'failed', failure: INVESTMENT_FAILURES.draftRefused });
    expect(view.report?.model).toBe('gpt-fixture');
    const r = await reportRow(orgA, refresh.report_id);
    expect(r.input_tokens + r.output_tokens).toBe(15);
    expect((await auditEvents(orgA, 'investment.report_failed')).length).toBe(1);
  });

  it('runs end to end through the registered handler: a company with no figures is failed before any model is reached', async () => {
    const parked = await requestParked(ownerId, orgA);
    const jobId = (await jobsOf(orgA)).find((j) => j.get('payload').reportId === parked.report_id)!.id;
    const outcome = await withOrgScope(orgA, (scope) => runInvestmentGenerateJob({
      jobId, organizationId: orgA, jobType: 'investment.generate', payload: { reportId: parked.report_id },
      requestedBy: ownerId, attempts: 1, maxAttempts: 1,
    }, scope));
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toContain(INVESTMENT_FAILURES.noFigures);
    const r = await reportRow(orgA, parked.report_id);
    expect(`${r.status}|${r.failure}|${r.input_tokens + r.output_tokens}`).toBe(`failed|${INVESTMENT_FAILURES.noFigures}|0`);
    await endJob(orgA, jobId);
    // The job's end changes nothing about an attempt that already finished.
    expect((await reportRow(orgA, parked.report_id)).failure).toBe(INVESTMENT_FAILURES.noFigures);
  });
});

describe('an attempt never outlives its job', () => {
  it('is failed when its job ends without finishing it', async () => {
    const parked = await requestParked(ownerId, orgM);
    const jobId = (await jobsOf(orgM)).find((j) => j.get('payload').reportId === parked.report_id)!.id;
    await endJob(orgM, jobId);
    const r = await reportRow(orgM, parked.report_id);
    expect(`${r.status}|${r.failure}`).toBe('failed|The pack could not be finished. Refresh it to try again.');
    // …so it no longer holds the slot.
    const next = await requestParked(ownerId, orgM);
    expect(next.created).toBe(true);
    await failAsJob(orgM, next.report_id);
  });

  it('is failed by the next request when its job has gone without ending it', async () => {
    const parked = await requestParked(ownerId, orgS);
    const job = (await jobsOf(orgS)).find((j) => j.get('payload').reportId === parked.report_id)!;
    await job.ref.update({ status: 'dead' });
    const next = await requestParked(ownerId, orgS);
    expect(next.created).toBe(true);
    expect((await reportRow(orgS, parked.report_id)).status).toBe('failed');
    await failAsJob(orgS, next.report_id);
  });
});

describe('Investment switched off', () => {
  it('is absent: no request, no pack read, and an attempt already queued is failed when its job starts', async () => {
    const queued = await requestParked(ownerId, orgM);
    const orgRef = fs().collection('organizations').doc(orgM);
    await orgRef.update({ 'features.module_investment': false });
    try {
      expect(sqlstate((await rpcAs(ownerId, 'request_investment_report', { p_org: orgM })).error)).toBe('P0002');
      await expect(getInvestmentView(await owner(orgM))).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(requestInvestmentReport(await owner(orgM), { surplus: '1000' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(await orgRows(clientFor(ownerId), orgM, 'investment_reports')).toEqual([]);

      const outcome = await withOrgScope(orgM, (scope) => runInvestmentReport(scope.db, orgM, queued.report_id, FAKES()));
      expect(outcome.status).toBe('skipped');
      const r = await reportRow(orgM, queued.report_id);
      expect(`${r.status}|${r.failure}`).toBe('failed|Investment is switched off for this company.');
    } finally {
      const f = await features(orgM);
      delete f.module_investment;
      await orgRef.update({ features: f });
    }
    expect((await orgRows(clientFor(ownerId), orgM, 'investment_reports')).length).toBeGreaterThan(0);
  });
});

describe('limits', () => {
  it('allows three packs an hour per organisation, and their tokens count under the monthly ceiling', async () => {
    for (let i = 0; i < 3; i += 1) {
      const r = await requestParked(ownerId, orgT, i === 0 ? '5000' : null);
      expect(r.created).toBe(true);
      await failAsJob(orgT, r.report_id, 10);
    }
    const { error } = await rpcAs(ownerId, 'request_investment_report', { p_org: orgT });
    expect(sqlstate(error)).toBe('53400');
    expect(await countReports(orgT)).toBe('3');
    expect(await aiTokensUsedThisMonth(fs(), orgT)).toBeGreaterThanOrEqual(30);
  });

  it('stops at the organisation\'s monthly AI allowance', async () => {
    await orgRow(fs(), orgE, 'platform_org_settings', ORG_SINGLETON_ID).set({ organization_id: orgE, ai_token_ceiling_monthly: 0 }, { merge: true });
    const { error } = await rpcAs(ownerId, 'request_investment_report', { p_org: orgE, p_surplus: 1000 });
    expect(sqlstate(error)).toBe('53400');
    expect(error?.message).toMatch(/allowance/);
    expect(await countReports(orgE)).toBe('0');
  });
});

describe('the purge', () => {
  it('removes every pack with the organisation', async () => {
    expect(Number(await countReports(orgM))).toBeGreaterThan(0);
    for (const j of (await fs().collection('jobs').where('organization_id', '==', orgM).get()).docs) {
      if (['queued', 'running'].includes(String(j.get('status')))) await j.ref.update({ status: 'cancelled', finished_at: new Date().toISOString() });
    }
    await fs().collection('organizations').doc(orgM).update({
      status: 'pending_deletion', deletion_requested_at: new Date(Date.now() - 31 * 86_400_000).toISOString(),
    });
    const { data, error } = await rpc(serviceClientScoped(orgM), 'purge_organization', { p_org: orgM, p_job: null }, { server: true });
    expect(error).toBeNull();
    expect((data as { status: string; rows: Record<string, number> }).status).toBe('purged');
    expect((data as { rows: Record<string, number> }).rows.investment_reports).toBeGreaterThan(0);
    expect(await countReports(orgM)).toBe('0');
  });
});
