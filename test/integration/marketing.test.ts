import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withOrgScope } from '@/core/db';
import { permissionsFor, type EffectiveRole } from '@/core/permissions';
import { runMarketingGenerateJob } from '@/modules/jobs';
import { enabledModules, type AccessContext } from '@/modules/tenancy';
import {
  MARKETING_FAILURES, MARKETING_REPORT_VERSION, getCompanyProfile, getLatestMarketingReport, getMarketingView,
  requestMarketingReport, runMarketingReport, setCompanyProfile, type MarketingReportDeps,
} from '@/modules/marketing';
import { aiTokensUsedThisMonth } from '@/db/app/ai-quota';
import { prepareMarketingJobEnded } from '@/db/app/marketing-reports';
import { orgRows } from '@/db/rls';
import { globalRow, nowIso, ORG_SINGLETON_ID, orgRow } from '@/db/schema';
import { runTx } from '@/db/tx';
import { SAMPLE_MARKETING_REPORT } from '../fixtures/marketing/sample-report';
import { clientFor, createAuthUser, fs, rpc, serviceClientScoped, sqlstate } from './setup';
import { addMember, addPlatformUser, assign, auditsOf, dropFixtures, makeOrg, orgOf, rowOf, rowsOf } from './f-fixtures';

/**
 * ADR-170 over the real wire: the company profile (who may write it, what the database refuses), asking
 * for the marketing report (who may spend AI on it, the profile it needs, one at a time, three an hour,
 * the monthly allowance, the system switch) and the job's writes (ready, failed, a job that ends
 * without finishing, the purge).
 *
 * NO MODEL IS CALLED. The narrative is a fake handed to `runMarketingReport`, or — for the one test
 * that drives the registered handler — the writer's offline template (`MOTION_AI_OFFLINE=1`). And no
 * worker should take a job this file queues: every request that creates one moves the job's
 * `run_after` a month out straight after (`requestParked`), so another suite draining the shared
 * queue does not see it as due.
 *
 * Run-unique fixtures; each organisation this file made is deleted with everything under it.
 */

process.env.MOTION_AI_OFFLINE = '1';

const RUN = `m${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.marketing.itest.motion`;
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

const featuresOf = new Map<string, Record<string, unknown>>();
const ctxFor = (userId: string, role: EffectiveRole, org = orgA): AccessContext => ({
  userId, orgId: org, orgSlug: 'mkt', effectiveRole: role, permissions: permissionsFor(role), actorType: 'user',
  db: clientFor(userId, { email: `${role}-${userId.slice(0, 4)}@${DOMAIN}` }), requestId: `itest-${RUN}`, now: () => new Date(),
  organizationStatus: 'active', modules: enabledModules(featuresOf.get(org) ?? {}),
});
/** The organisation's features as the context would load them (read fresh before a switch test). */
async function loadFeatures(org: string): Promise<void> {
  featuresOf.set(org, ((await orgOf(org)).features as Record<string, unknown> | undefined) ?? {});
}
const owner = (org = orgA) => ctxFor(ownerId, 'owner', org);
const admin = () => ctxFor(adminId, 'admin');
const client = () => ctxFor(clientId, 'client');
const adviser = () => ctxFor(adviserId, 'employee');
const rpcAs = (userId: string, fn: string, args: Record<string, unknown>) => rpc(clientFor(userId), fn, args);
const reportsOf = (org: string) => rowsOf(org, 'marketing_reports');
const jobsOf = async (org: string) => (await fs().collection('jobs').where('organization_id', '==', org)
  .where('job_type', '==', 'marketing.generate').get()).docs.map((d) => d.data());

/**
 * `api.request_marketing_report` as the user would call it, then the job it queued parked a month
 * out before any worker on the shared emulator takes it.
 */
async function requestParked(userId: string, org: string): Promise<{ report_id: string; created: boolean }> {
  const { data, error } = await rpcAs(userId, 'request_marketing_report', { p_org: org });
  if (error) throw new Error(`the request failed: ${error.message}`);
  const out = data as { report_id: string; created: boolean };
  const report = await rowOf(org, 'marketing_reports', out.report_id);
  if (report?.job_id) {
    await globalRow(fs(), 'jobs', String(report.job_id)).update({ run_after: new Date(Date.now() + 30 * 86_400_000).toISOString() });
  }
  return out;
}

/** The job's failure write, as the job makes it: service role, scoped to the organisation. */
async function failAsJob(org: string, reportId: string, tokens = 0): Promise<void> {
  const { error } = await rpc(serviceClientScoped(org), 'fail_marketing_report', {
    p_org: org, p_report: reportId, p_failure: 'Fixture failure.', p_input_tokens: tokens, p_output_tokens: 0,
  }, { server: true });
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
  const founder = name === 'Main' ? ownerId : await createAuthUser(`founder-${name.toLowerCase()}@${DOMAIN}`);
  const org = await makeOrg(founder, `${PREFIX} ${name}`);
  if (founder !== ownerId) await addMember(org, ownerId, 'owner');
  await loadFeatures(org);
  return org;
}

beforeAll(async () => {
  ownerId = await createAuthUser(`owner@${DOMAIN}`);
  adminId = await createAuthUser(`admin@${DOMAIN}`);
  clientId = await createAuthUser(`client@${DOMAIN}`);
  adviserId = await createAuthUser(`adviser@${DOMAIN}`);
  strangerId = await createAuthUser(`stranger@${DOMAIN}`);
  orgA = await createOrg('Main');
  orgE = await createOrg('Empty');
  orgM = await createOrg('Switch');
  orgT = await createOrg('Throttle');
  slugA = String((await orgOf(orgA)).slug);
  await addMember(orgA, adminId, 'admin');
  await addMember(orgA, clientId, 'client');
  await addPlatformUser(adviserId, 'employee');
  await assign(orgA, adviserId);
  for (const org of [orgM, orgT]) await setCompanyProfile(owner(org), READY_PROFILE);
}, 120_000);

afterAll(async () => {
  for (const org of [orgA, orgE, orgM, orgT]) {
    if (!org) continue;
    const limits = await fs().collection('api_rate_limits').where('actor_user_id', '==', org).get();
    for (const d of limits.docs) await d.ref.delete();
  }
  await dropFixtures([orgA, orgE, orgM, orgT], DOMAIN);
}, 120_000);

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
    expect((await orgOf(orgA)).industry).toBe('Luxury leather accessories');
    expect(await auditsOf(orgA, 'company_profile.updated')).toHaveLength(1);
  });

  it('may be edited by an admin and the assigned adviser, and not by a client or a stranger', async () => {
    await setCompanyProfile(admin(), { ...READY_PROFILE, description: 'Edited by the admin.' });
    await setCompanyProfile(adviser(), { ...READY_PROFILE, description: 'Edited by the adviser.' });
    expect((await rowOf(orgA, 'organization_profiles', ORG_SINGLETON_ID))?.description).toBe('Edited by the adviser.');

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

  it('is read only by the organisation', async () => {
    // Written through the function only: the browser cannot reach Firestore at all (the rules deny
    // every client request), so there is no direct insert left to refuse.
    expect(await orgRows(clientFor(strangerId), orgA, 'organization_profiles')).toEqual([]);
    expect(await orgRows(clientFor(clientId), orgA, 'organization_profiles')).toHaveLength(1);
  });
});

describe('asking for the report', () => {
  let firstId: string;

  it('is refused until the profile says what the company sells or its industry', async () => {
    const { error } = await rpcAs(ownerId, 'request_marketing_report', { p_org: orgE });
    expect(sqlstate(error)).toBe('22023');
    expect(error?.message).toMatch(/company profile/);
    expect(await reportsOf(orgE)).toHaveLength(0);
  });

  it('is refused to a client and to a stranger', async () => {
    await expect(requestMarketingReport(client())).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(sqlstate((await rpcAs(clientId, 'request_marketing_report', { p_org: orgA })).error)).toBe('42501');
    expect(sqlstate((await rpcAs(strangerId, 'request_marketing_report', { p_org: orgA })).error)).toBe('P0002');
  });

  it('queues one attempt and one single-attempt job; a second press returns the same attempt and spends nothing', async () => {
    const first = await requestParked(ownerId, orgA);
    expect(first.created).toBe(true);
    firstId = first.report_id;

    const again = await requestMarketingReport(adviser());
    expect(again).toEqual({ reportId: firstId, created: false });

    const jobs = await jobsOf(orgA);
    expect(jobs.map((j) => ({ max: j.max_attempts, report: j.payload.reportId, by: j.requested_by })))
      .toEqual([{ max: 1, report: firstId, by: ownerId }]);
    const attempt = await rowOf(orgA, 'marketing_reports', firstId);
    expect(attempt!.job_id !== null && attempt!.status === 'queued').toBe(true);

    const view = await getMarketingView(owner());
    expect(view).toMatchObject({ status: 'queued', report: null, failure: null, profileReady: true, canRefresh: true, canEditProfile: true });
    expect(await getMarketingView(client())).toMatchObject({ status: 'queued', canRefresh: false, canEditProfile: false });
  });

  it('is written by the job: ready, with what it cost, counted under the monthly ceiling, and the requester is told', async () => {
    const outcome = await withOrgScope(orgA, (scope) => runMarketingReport(scope.db, orgA, firstId, FAKES()));
    expect(outcome).toMatchObject({ status: 'ready', reportId: firstId });

    const r = (await rowOf(orgA, 'marketing_reports', firstId))!;
    expect({ status: r.status, version: r.report_version, model: r.model, prompt: r.prompt_version, in: r.input_tokens, out: r.output_tokens, finished: r.finished_at !== null })
      .toEqual({ status: 'ready', version: MARKETING_REPORT_VERSION, model: 'gpt-fixture', prompt: 'marketing-prompt-fixture', in: 1200, out: 3400, finished: true });
    expect(await aiTokensUsedThisMonth(fs(), orgA)).toBeGreaterThanOrEqual(4600);

    const view = await getMarketingView(client());
    expect(view.status).toBe('ready');
    expect(view.report).toMatchObject({ organisationName: `${PREFIX} Main`, version: MARKETING_REPORT_VERSION, model: 'gpt-fixture' });
    expect(view.report?.sources[0]).toEqual({ label: `${PREFIX} Main website`, url: 'https://bearabeara.co.uk' });
    expect(await getLatestMarketingReport(client())).toEqual(view.report);

    expect((await rowsOf(orgA, 'notifications', { user_id: ownerId })).map((n) => `${n.kind}|${n.title}|${n.href}`))
      .toEqual([`report_ready|Your marketing report is ready|/app/${slugA}/marketing`]);
    expect(await auditsOf(orgA, 'marketing.report_ready')).toHaveLength(1);
  });

  it('keeps a finished report as it was: the job\'s writes refuse or pass over it', async () => {
    // `marketing_report_guard` refused any change to a finished row; here no function offers one.
    const finish = await rpc(serviceClientScoped(orgA), 'finish_marketing_report', {
      p_org: orgA, p_report: firstId, p_content: { version: 'marketing-v1' }, p_model: 'other', p_prompt_version: 'p',
      p_input_tokens: 0, p_output_tokens: 0,
    }, { server: true });
    expect(sqlstate(finish.error)).toBe('23505');
    const fail = await rpc(serviceClientScoped(orgA), 'fail_marketing_report', { p_org: orgA, p_report: firstId, p_failure: 'x' }, { server: true });
    expect(fail).toEqual({ data: null, error: null });
    expect((await rowOf(orgA, 'marketing_reports', firstId))?.model).toBe('gpt-fixture');
  });

  it('keeps the last report on the page when a refresh fails, and says why', async () => {
    const refresh = await requestParked(ownerId, orgA);
    expect(refresh.created).toBe(true);
    const outcome = await withOrgScope(orgA, (scope) => runMarketingReport(scope.db, orgA, refresh.report_id, FAKES({
      generateNarrative: async () => ({ ok: false as const, reason: 'fixture refusal', model: 'gpt-fixture', promptVersion: 'p', inputTokens: 10, outputTokens: 5 }),
    })));
    expect(outcome).toMatchObject({ status: 'failed', failure: MARKETING_FAILURES.draftRefused });

    const view = await getMarketingView(owner());
    expect(view).toMatchObject({ status: 'failed', failure: MARKETING_FAILURES.draftRefused });
    expect(view.report?.model).toBe('gpt-fixture');
    const refreshed = (await rowOf(orgA, 'marketing_reports', refresh.report_id))!;
    expect(refreshed.input_tokens + refreshed.output_tokens).toBe(15);
  });

  it('runs end to end through the registered handler (the writer offline, so no model is called)', async () => {
    expect(process.env.MOTION_AI_OFFLINE).toBe('1');
    const parked = await requestParked(ownerId, orgA);
    const jobId = String((await jobsOf(orgA)).find((j) => j.payload.reportId === parked.report_id)!.id);
    const outcome = await withOrgScope(orgA, (scope) => runMarketingGenerateJob({
      jobId, organizationId: orgA, jobType: 'marketing.generate', payload: { reportId: parked.report_id },
      requestedBy: ownerId, attempts: 1, maxAttempts: 1,
    }, scope));
    expect(outcome).toMatchObject({ status: 'succeeded', result: { reportId: parked.report_id, model: 'offline-template' } });
    expect((await rowOf(orgA, 'marketing_reports', parked.report_id))?.status).toBe('ready');
    await globalRow(fs(), 'jobs', jobId).update({ status: 'succeeded', finished_at: nowIso() });
  });
});

describe('an attempt never outlives its job', () => {
  it('is failed when its job ends without finishing it', async () => {
    const parked = await requestParked(ownerId, orgM);
    const job = (await jobsOf(orgM)).find((j) => j.payload.reportId === parked.report_id)!;
    // What the queue does when a job ends (the `marketing_job_ended` trigger, ported for the job's
    // terminal writes): the job goes dead and its attempt is failed in the same transaction.
    await runTx(serviceClientScoped(orgM), async (tx) => {
      const ended = await prepareMarketingJobEnded(fs(), orgM, String(job.id), tx);
      tx.update(globalRow(fs(), 'jobs', String(job.id)), { status: 'dead', finished_at: nowIso() });
      ended.write(tx);
    });
    const failed = (await rowOf(orgM, 'marketing_reports', parked.report_id))!;
    expect(`${failed.status}|${failed.failure}`).toBe('failed|The report could not be finished. Refresh it to try again.');
    // …so it no longer holds the slot.
    const next = await requestParked(ownerId, orgM);
    expect(next.created).toBe(true);
    await failAsJob(orgM, next.report_id);
  });
});

describe('Marketing switched off', () => {
  it('is absent: no request, no report read, and an attempt already queued is failed when its job starts', async () => {
    const queued = await requestParked(ownerId, orgM);
    const before = ((await orgOf(orgM)).features as Record<string, unknown> | undefined) ?? {};
    await globalRow(fs(), 'organizations', orgM).update({ features: { ...before, module_marketing: false } });
    await loadFeatures(orgM);
    try {
      expect(sqlstate((await rpcAs(ownerId, 'request_marketing_report', { p_org: orgM })).error)).toBe('P0002');
      await expect(getMarketingView(owner(orgM))).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(await orgRows(clientFor(ownerId), orgM, 'marketing_reports')).toEqual([]);

      const outcome = await withOrgScope(orgM, (scope) => runMarketingReport(scope.db, orgM, queued.report_id, FAKES()));
      expect(outcome.status).toBe('skipped');
      const off = (await rowOf(orgM, 'marketing_reports', queued.report_id))!;
      expect(`${off.status}|${off.failure}`).toBe('failed|Marketing is switched off for this company.');
    } finally {
      await globalRow(fs(), 'organizations', orgM).update({ features: before });
      await loadFeatures(orgM);
    }
    expect((await orgRows(clientFor(ownerId), orgM, 'marketing_reports')).length).toBeGreaterThan(0);
  });
  // The PostgreSQL suite also read `api.set_org_module`'s definition for 'module_marketing' from the
  // catalogue; that is a statement about SQL source, not behaviour, and has no Firestore equivalent.
});

describe('limits', () => {
  it('allows three reports an hour per organisation', async () => {
    for (let i = 0; i < 3; i += 1) {
      const r = await requestParked(ownerId, orgT);
      expect(r.created).toBe(true);
      await failAsJob(orgT, r.report_id, 10);
    }
    const { error } = await rpcAs(ownerId, 'request_marketing_report', { p_org: orgT });
    expect(sqlstate(error)).toBe('53400');
    expect(await reportsOf(orgT)).toHaveLength(3);
  });

  it('stops at the organisation\'s monthly AI allowance', async () => {
    await setCompanyProfile(owner(orgE), { productsServices: 'Garden design' });
    await orgRow(fs(), orgE, 'platform_org_settings', ORG_SINGLETON_ID).set({ organization_id: orgE, ai_token_ceiling_monthly: 0 }, { merge: true });
    const { error } = await rpcAs(ownerId, 'request_marketing_report', { p_org: orgE });
    expect(sqlstate(error)).toBe('53400');
    expect(error?.message).toMatch(/allowance/);
  });
});

describe('the purge', () => {
  it('removes the profile and every report with the organisation', async () => {
    const open = await fs().collection('jobs').where('organization_id', '==', orgM).where('status', 'in', ['queued', 'running']).get();
    for (const d of open.docs) await d.ref.update({ status: 'cancelled', finished_at: nowIso() });
    await globalRow(fs(), 'organizations', orgM).update({
      status: 'pending_deletion', deletion_requested_at: new Date(Date.now() - 31 * 86_400_000).toISOString(),
    });
    const { data, error } = await rpc(serviceClientScoped(orgM), 'purge_organization', { p_org: orgM, p_job: null }, { server: true });
    expect(error).toBeNull();
    expect((data as { status: string }).status).toBe('purged');
    expect((await reportsOf(orgM)).length + (await rowsOf(orgM, 'organization_profiles')).length).toBe(0);
  });
});
