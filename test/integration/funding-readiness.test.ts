import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { permissionsFor, type EffectiveRole } from '@/core/permissions';
import { getBundle } from '@/modules/evidence';
import { getFundingView } from '@/modules/funding';
import { drainJobs } from '@/modules/jobs';
import { getStoredReport, requestCompose, requestStoredPdf, type FundingReportContent } from '@/modules/reporting';
import type { AccessContext } from '@/modules/tenancy';
import { prepareEnqueue } from '@/db/app/jobs';
import { periodId } from '@/db/app/shared';
import { orgRows } from '@/db/rls';
import { globalRow, orgCollection, uniqueGuard } from '@/db/schema';
import { clientFor, createAuthUser, drainUntilFinished, fs, rpc, serviceClientScoped, sqlstate } from './setup';
import {
  jobsOf, removeSeeded, seedAccepted, seedBatch, seedDocument, seedJob, seedLedgerEntry, seedMember, seedOrg,
} from '../fixtures/seed';

/**
 * Funding Readiness (Phase 16; ADR-121, ADR-145): the flag's whole lifecycle and its security, against
 * figures a real calculation run produced. The organisation keeps a ledger and no bank account and no
 * balance sheet, so the honest result is "Insufficient data" — F2 and F3 unknown (never cash 0), F4
 * unknown (never "no debt") — which is exactly what must be shown. Run-unique fixtures.
 */

const RUN = `f${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.funding.itest.motion`;
let ownerId: string;
let clientId: string;
let strangerId: string;
let orgId: string;
let otherOrgId: string;
let august: string;

const ctxFor = (userId: string, role: EffectiveRole, org = orgId): AccessContext => ({
  userId, orgId: org, orgSlug: 'fund', effectiveRole: role, permissions: permissionsFor(role), actorType: 'user',
  db: clientFor(userId, { email: `${role}@${DOMAIN}` }), requestId: `itest-${RUN}`, now: () => new Date(), organizationStatus: 'active',
});

/**
 * The switch, as `api.set_org_module` throws it: the feature, and on the off→on edge the
 * `funding_enablement` backfill job in the same transaction (`on conflict do nothing`). That function
 * needs THE super admin, which this suite cannot create on an emulator other suites share (there is
 * one super admin), so the fixture does exactly what the function's transaction does.
 */
async function setFlag(on: boolean): Promise<void> {
  const f = fs();
  await f.runTransaction(async (tx) => {
    const ref = globalRow(f, 'organizations', orgId);
    const before = ((await tx.get(ref)).get('features') as Record<string, unknown> | undefined) ?? {};
    let job: Awaited<ReturnType<typeof prepareEnqueue>> | null = null;
    if (on && before.funding_readiness !== true) {
      const key = `funding.assess:${orgId}`;
      const claim = await uniqueGuard(f, 'global', 'jobs_idempotency_queued', ['funding.assess', key]).read(tx);
      const holder = claim.owner ? await tx.get(f.collection('jobs').doc(claim.owner)) : null;
      if (!(holder?.exists && holder.get('status') === 'queued')) {
        job = await prepareEnqueue(f, {
          organizationId: orgId, jobType: 'funding.assess', payload: { trigger: 'enablement_backfill' },
          requestedBy: null, idempotencyKey: key,
        }, tx);
      }
    }
    tx.update(ref, { features: { ...before, funding_readiness: on } });
    job?.write(tx);
  });
}

/** The newest assessment job created since `since` (any state: the drain may already have run it). */
async function fundingJob(since = ''): Promise<string> {
  const jobs = (await jobsOf(orgId, { jobType: 'funding.assess' })).filter((j) => String(j.created_at) > since);
  return jobs[0] ? String(jobs[0].id) : '';
}
const now = () => new Date().toISOString();
/** A real calculation through the shared queue: the drain may run other suites' jobs first. */
const CALC_TIMEOUT = 240_000;
const jobPayload = async (id: string) => ((await fs().collection('jobs').doc(id).get()).get('payload') as Record<string, unknown>);
const assessments = async (where: Array<[string, unknown]> = []) => {
  let q: FirebaseFirestore.Query = orgCollection(fs(), orgId, 'funding_assessments');
  for (const [k, v] of where) q = q.where(k, '==', v);
  return (await q.get()).docs.map((d) => d.data());
};
const pointer = async () => (await orgCollection(fs(), orgId, 'funding_current').doc(august).get()).data();

async function calculate(): Promise<string> {
  const job = await seedJob(orgId, 'calculation.run', { trigger: 'recalc_manual' });
  expect(await drainUntilFinished(drainJobs, job)).toBe('succeeded');
  const runs = (await orgCollection(fs(), orgId, 'calculation_runs').where('status', '==', 'succeeded').get()).docs
    .map((d) => d.data()).sort((a, b) => String(b.finished_at).localeCompare(String(a.finished_at)));
  return String(runs[0]!.id);
}

beforeAll(async () => {
  ownerId = await createAuthUser(`owner@${DOMAIN}`);
  clientId = await createAuthUser(`client@${DOMAIN}`);
  strangerId = await createAuthUser(`stranger@${DOMAIN}`);
  const seeded = await seedOrg({ name: `ITest Funding ${RUN}`, ownerId, around: '2026-09-15' });
  orgId = seeded.orgId;
  otherOrgId = (await seedOrg({ name: `ITest Funding Other ${RUN}`, ownerId: strangerId, around: '2026-09-15' })).orgId;
  await seedMember(orgId, clientId, 'client');
  const doc = await seedDocument(orgId, 'gl.csv', 'general_ledger');
  const batch = await seedBatch(orgId, {
    importType: 'general_ledger', target: 'ledger_entries', start: '2026-08-01', end: '2026-08-31', documentId: doc,
  });
  for (const [c, d, a] of [['revenue', 'credit', '20000.00'], ['payroll', 'debit', '12000.00']] as const) {
    const id = await seedLedgerEntry(orgId, { date: '2026-08-10', accountId: seeded.accounts[c]!, direction: d, amount: a });
    await seedAccepted(orgId, 'ledger_entries', id, null);
  }
  void batch;
  august = periodId(orgId, '2026-08-01');
}, 120_000);

afterAll(async () => {
  await removeSeeded([orgId, otherOrgId], `@${DOMAIN}`);
});

describe('switched off (the default)', () => {
  it('a calculation writes no assessment and queues no assessment job', async () => {
    const since = now();
    await calculate();
    expect(await assessments()).toHaveLength(0);
    expect(await fundingJob(since)).toBe('');
  }, CALC_TIMEOUT);

  it('the page is NOT FOUND for every role', async () => {
    for (const [id, role] of [[ownerId, 'owner'], [clientId, 'client']] as const) {
      await expect(getFundingView(ctxFor(id, role))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    }
  });
});

describe('switching it on', () => {
  it('queues the backfill in the same transaction, and assesses every complete month', async () => {
    await setFlag(true);
    const job = await fundingJob();
    expect(job).toMatch(/^[0-9a-f-]{36}$/);
    expect((await jobPayload(job)).trigger).toBe('enablement_backfill');
    expect(await drainUntilFinished(drainJobs, job)).toBe('succeeded');
    const current = await pointer();
    expect((await assessments([['id', current!.assessment_id]]))[0]!.trigger).toBe('enablement_backfill');
  }, CALC_TIMEOUT);

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
    expect(await orgRows(clientFor(strangerId, { email: `owner@${DOMAIN}` }), orgId, 'funding_assessments')).toEqual([]);
  });

  it('the next successful calculation re-assesses, citing the new run', async () => {
    const since = now();
    const run = await calculate();
    const job = await fundingJob(since);
    expect((await jobPayload(job)).trigger).toBe('calculation_run');
    expect(await drainUntilFinished(drainJobs, job)).toBe('succeeded');
    expect((await pointer())!.calculation_run_id).toBe(run);
    // The earlier assessment is kept, not replaced.
    expect(await assessments([['period_id', august]])).toHaveLength(2);
  }, CALC_TIMEOUT);

  it('the nightly backstop queues an organisation whose latest month has no current assessment', async () => {
    await fs().recursiveDelete(orgCollection(fs(), orgId, 'funding_current'));
    const since = now();
    const { error } = await rpc(serviceClientScoped(), 'enqueue_funding_backstop', {}, { server: true });
    expect(error).toBeNull();
    const job = await fundingJob(since);
    expect((await jobPayload(job)).trigger).toBe('nightly_backstop');
    expect(await drainUntilFinished(drainJobs, job)).toBe('succeeded');
    expect((await orgCollection(fs(), orgId, 'funding_current').get()).size).toBeGreaterThan(0);
  }, CALC_TIMEOUT);
});

let fundingReportId: string;

describe('the Funding Readiness Report (REQ-RP-05)', () => {
  it('stores the latest month\'s current assessment as it stands, with its disclaimer', async () => {
    const job = await requestCompose(ctxFor(ownerId, 'owner'), 'funding_readiness', null);
    expect(await drainUntilFinished(drainJobs, job)).toBe('succeeded');
    fundingReportId = String((await orgCollection(fs(), orgId, 'reports').where('report_kind', '==', 'funding_readiness').get()).docs[0]!.id);
    const report = await getStoredReport(ctxFor(ownerId, 'owner'), fundingReportId);
    expect(report).toMatchObject({ kind: 'funding_readiness', contentVersion: 'funding.v1', origin: 'requested', periodId: august });
    const content = report!.content as FundingReportContent;
    // The same row the Funding page shows for the month, not a recomposition.
    const current = (await pointer())!.assessment_id;
    expect(content.assessment.id).toBe(current);
    expect(content.assessment).toMatchObject({ status: 'insufficient_data', score: null, band: null });
    expect(content.assessment.disclaimer).toMatch(/^Funding Readiness is an indicative/);
    expect(content.assessment.factors).toHaveLength(7);
    expect(report!.windowStart).toBe('2026-08-01');
    expect(report!.windowEnd).toBe('2026-08-31');
  }, CALC_TIMEOUT);

  it('renders its PDF under the report', async () => {
    const job = await requestStoredPdf(ctxFor(ownerId, 'owner'), fundingReportId);
    expect(await drainUntilFinished(drainJobs, job)).toBe('succeeded');
    expect((await orgCollection(fs(), orgId, 'report_files').where('report_id', '==', fundingReportId).get()).size).toBe(1);
  }, CALC_TIMEOUT);

  it('a client may read it but not produce one', async () => {
    expect(await getStoredReport(ctxFor(clientId, 'client'), fundingReportId)).not.toBeNull();
    await expect(requestCompose(ctxFor(clientId, 'client'), 'funding_readiness', null)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });
});

describe('switching it off again', () => {
  it('hides the Funding Readiness Report and refuses a new one, keeping the stored row', async () => {
    await setFlag(false);
    expect(await getStoredReport(ctxFor(ownerId, 'owner'), fundingReportId)).toBeNull();
    await expect(requestCompose(ctxFor(ownerId, 'owner'), 'funding_readiness', null)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await orgCollection(fs(), orgId, 'reports').doc(fundingReportId).get()).exists).toBe(true);
  });

  it('hides it at every layer — page, evidence and RLS — and keeps the rows', async () => {
    const bundle = String((await orgCollection(fs(), orgId, 'evidence_bundles').where('kind', '==', 'funding_assessment').get()).docs[0]?.id ?? '');
    expect(bundle).toMatch(/^[0-9a-f-]{36}$/);
    await setFlag(false);
    await expect(getFundingView(ctxFor(ownerId, 'owner'))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(getBundle(ctxFor(ownerId, 'owner'), bundle)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await orgRows(ctxFor(ownerId, 'owner').db, orgId, 'funding_assessments')).toEqual([]);
    expect((await assessments()).length).toBeGreaterThan(0);
  });

  it('and nothing is calculated while it is off', async () => {
    const before = (await assessments()).length;
    const since = now();
    await calculate();
    expect(await fundingJob(since)).toBe('');
    expect(await assessments()).toHaveLength(before);
  }, CALC_TIMEOUT);
});

describe('only the server writes, and nothing is edited', () => {
  it('finish_funding is not callable with a user handle, and no user function writes an assessment', async () => {
    const owner = ctxFor(ownerId, 'owner').db;
    const call = await rpc(owner, 'finish_funding', { p_org: orgId, p_assessments: [], p_trigger: 'calculation_run' }, { server: true });
    expect(sqlstate(call.error)).toBe('42501');
    const { API_FUNCTIONS } = await import('@/db/api');
    expect(Object.keys(API_FUNCTIONS).filter((n) => /funding/.test(n))).toEqual([]);
  });

  it('an assessment is never rewritten: the same month and run, offered again, leaves the first standing', async () => {
    await setFlag(true);
    const first = (await assessments([['period_id', august]]))
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0]!;
    const again = await rpc(serviceClientScoped(orgId), 'finish_funding', {
      p_org: orgId, p_trigger: 'nightly_backstop',
      p_assessments: [{ ...first, overall_status: 'scored', overall_score: 99, band: 'strong', evidence: [] }],
    }, { server: true });
    expect(again.error).toBeNull();
    expect(again.data).toBe(0);
    const kept = (await assessments([['id', first.id]]))[0]!;
    expect(kept.overall_status).toBe(first.overall_status);
    expect(kept.overall_score).toBe(first.overall_score);
    await setFlag(false);
  });

  it('a stranger organisation\'s assessment pages are not found, whatever the id', async () => {
    void otherOrgId;
    await expect(getFundingView(ctxFor(strangerId, 'owner', otherOrgId))).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
