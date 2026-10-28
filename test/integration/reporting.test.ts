import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { permissionsFor } from '@/core/permissions';
import { callApi, recordAccessEvent } from '@/core/db';
import { getObject } from '@/core/storage/signer';
import { loadHome } from '@/modules/dashboard';
import { drainJobs } from '@/modules/jobs';
import { getMonthlyReport, getReportFile, listAvailable, requestPdf } from '@/modules/reporting';
import type { AccessContext } from '@/modules/tenancy';
import { auth } from '@/db/firestore';
import { newId, nowIso, orgCollection, orgRow } from '@/db/schema';
import { clientFor, createAuthUser, deleteOrg, drainUntilFinished, fs, rpc } from './setup';
import { addMember, auditEvents, createOrgFixture } from './r-fixtures';
import { ensureMonths, monthId, systemAccountId, writeJob } from './r-metrics';
import { writeImportBatch, writeLedgerEntry, writeSourceDocument } from './r-records';

/**
 * The Monthly Management Report (ADR-024; IMPLEMENTATION_PLAN.md Phase 13;
 * TEST_STRATEGY.md §15 "Monthly report snapshot test equals Home figures; PDF job test").
 *
 * The gate is one sentence and it is the whole phase: **every figure in the report equals its Home
 * counterpart for the same month.** `ARCHITECTURE.md` names metric drift — the same metric computed
 * differently in two places — as a top risk, and the report is where it would do the most damage,
 * because it is the artefact somebody prints and takes to a meeting. A report that disagreed with
 * the screen would not be caught by anyone until it had already been believed.
 *
 * Run-unique fixtures (ADR-052.12), written into Firestore as an import would leave them; the
 * figures come from the real calculation job.
 */

const RUN = `r${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.reporting.itest.motion`;

let ownerId: string;
let clientId: string;
let strangerId: string;
let orgId: string;
let orgSlug: string;
let otherOrgId: string;
let mayPeriodId: string;
let junePeriodId: string;
const users: string[] = [];

function contextFor(userId: string, role: 'owner' | 'client', org = orgId): AccessContext {
  return {
    userId, orgId: org, orgSlug, effectiveRole: role, permissions: permissionsFor(role),
    actorType: 'user', db: clientFor(userId, { email: `${role}@${DOMAIN}` }),
    requestId: `itest-${RUN}`, now: () => new Date('2026-06-15T00:00:00Z'),
    organizationStatus: 'active',
  };
}
const ownerCtx = () => contextFor(ownerId, 'owner');

async function user(label: string): Promise<string> {
  const id = await createAuthUser(`${label}@${DOMAIN}`);
  users.push(id);
  return id;
}

beforeAll(async () => {
  ownerId = await user('owner');
  clientId = await user('client');
  strangerId = await user('stranger');

  const org = await createOrgFixture({ name: `ITest Reporting ${RUN}`, ownerId });
  orgId = org.id;
  orgSlug = org.slug;
  otherOrgId = (await createOrgFixture({ name: `ITest Reporting Other ${RUN}`, ownerId: strangerId })).id;
  await ensureMonths(orgId, '2026-01-01', '2026-12-31');
  await ensureMonths(otherOrgId, '2026-01-01', '2026-12-31');

  await addMember(orgId, clientId, 'client');

  mayPeriodId = monthId(orgId, '2026-05');
  junePeriodId = monthId(orgId, '2026-06');

  const post = async (category: string, direction: 'debit' | 'credit', amount: string, day: string) =>
    writeLedgerEntry(orgId, { accountId: await systemAccountId(orgId, category), date: `2026-05-${day}`, direction, amount });

  await post('revenue', 'credit', '40000.00', '10');
  await post('cost_of_sales', 'debit', '9000.00', '12');
  await post('payroll', 'debit', '12000.00', '25');

  const doc = await writeSourceDocument(orgId, { path: `${orgId}/report/gl.csv`, filename: 'gl.csv', kind: 'general_ledger' });
  await writeImportBatch(orgId, {
    documentId: doc, importType: 'general_ledger', targetTable: 'ledger_entries', status: 'committed',
    periodStart: '2026-05-01', periodEnd: '2026-05-31',
  });

  const jobId = await writeJob(orgId, { jobType: 'calculation.run', payload: { trigger: 'recalc_manual', as_of: '2026-06-15' } });
  expect(await drainUntilFinished(drainJobs, jobId), 'the figures must exist').toBe('succeeded');
}, 180_000);

afterAll(async () => {
  for (const org of [orgId, otherOrgId]) {
    if (!org) continue;
    for (const j of (await fs().collection('jobs').where('organization_id', '==', org).get()).docs) await j.ref.delete();
    await deleteOrg(org);
  }
  for (const id of users) {
    await fs().collection('profiles').doc(id).delete();
    await auth().deleteUser(id).catch(() => undefined);
  }
});

describe('the report says exactly what Home says (§15, ARCHITECTURE risk 7)', () => {
  it('every headline figure equals its Home counterpart, card for card', async () => {
    const ctx = ownerCtx();
    const home = await loadHome(ctx.db, orgId, orgSlug, ctx.requestId);
    expect(home.kind, 'Home must have figures for this to compare against').toBe('ready');
    if (home.kind !== 'ready') throw new Error('expected figures');

    const report = await getMonthlyReport(ctx, home.view.period.id);
    expect(report).not.toBeNull();

    /*
     * Compared as a whole card, not figure by figure: the label, the badge, the change line and the
     * secondary line are all things a reader takes from the page, and any one of them differing
     * between the screen and the printed report is the same defect.
     */
    expect(report!.cards.map((card) => ({
      key: card.metricKey, label: card.label, value: card.value,
      change: card.change?.text ?? null, status: card.status.label,
      secondary: card.secondaryLine?.value ?? null,
    }))).toEqual(home.view.cards.map((card) => ({
      key: card.metricKey, label: card.label, value: card.value,
      change: card.change?.text ?? null, status: card.status.label,
      secondary: card.secondaryLine?.value ?? null,
    })));
  });

  it('names the same month and the same comparison month as Home', async () => {
    const ctx = ownerCtx();
    const home = await loadHome(ctx.db, orgId, orgSlug, ctx.requestId);
    if (home.kind !== 'ready') throw new Error('expected figures');
    const report = (await getMonthlyReport(ctx, home.view.period.id))!;

    expect(report.period.label).toBe(home.view.period.label);
    expect(report.comparisonLabel).toBe(home.view.comparisonLabel);
    expect(report.basisLine, 'and says where the figures came from in the same words')
      .toBe(home.view.basisLine);
  });

  it('carries the run that produced the figures, so a printed page can be traced', async () => {
    const report = (await getMonthlyReport(ownerCtx(), mayPeriodId))!;
    expect(report.asOf.engineVersion).not.toBeNull();
    expect(report.asOf.finishedAt).not.toBeNull();
  });
});

describe('a report exists only for a month that has finished (ADR-030.4)', () => {
  it('offers May and not June', async () => {
    const available = await listAvailable(ownerCtx());
    expect(available.map((entry) => entry.periodId)).toContain(mayPeriodId);
    expect(available.map((entry) => entry.periodId)).not.toContain(junePeriodId);
  });

  it('returns nothing for a month with no figures', async () => {
    expect(await getMonthlyReport(ownerCtx(), junePeriodId)).toBeNull();
  });

  it('returns nothing for another organisation’s period', async () => {
    const foreignPeriod = monthId(otherOrgId, '2026-05');
    expect(await getMonthlyReport(ownerCtx(), foreignPeriod)).toBeNull();
  });
});

describe('the PDF job renders, stores and records (Phase 13 slice 2)', () => {
  let reportFileId: string;

  it('runs end to end and leaves a file behind', async () => {
    const jobId = await requestPdf(ownerCtx(), mayPeriodId);
    expect(await drainUntilFinished(drainJobs, jobId)).toBe('succeeded');

    const files = (await orgCollection(fs(), orgId, 'report_files').where('period_id', '==', mayPeriodId).get()).docs.map((d) => d.data());
    expect(files).toHaveLength(1);
    reportFileId = String(files[0]!.id);
    expect(reportFileId).toMatch(/^[0-9a-f-]{36}$/);

    const row = files[0]!;
    // The path is derived by the function, never supplied: `{org}/{period}/{id}.pdf` (R2-A-09).
    expect(`${row.report_kind}|${row.storage_bucket}|${row.storage_path}`)
      .toBe(`monthly_management|reports|${orgId}/${mayPeriodId}/${reportFileId}.pdf`);
    expect(row.byte_size).toBeGreaterThan(1000);
    // bytea is stored as lowercase hex without the `\x` prefix.
    expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('the object is really in the bucket, and is a PDF', async () => {
    const path = String((await orgRow(fs(), orgId, 'report_files', reportFileId).get()).get('storage_path'));
    const bytes = await getObject({ orgId, userId: ownerId }, 'reports', path);
    // A row that names an object Storage cannot serve is the failure mode ADR-043.4's ordering
    // exists to prevent; this is the assertion that the ordering held.
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-');
    expect(bytes.byteLength).toBeGreaterThan(1000);
  });

  it('and the audit says who produced it', async () => {
    const events = (await auditEvents(orgId, 'report.generated')).filter((e) => e.target_id === reportFileId);
    expect(events).toHaveLength(1);
    expect(events[0]!.actor_user_id).toBe(ownerId);
  });

  it('shows up in the list against its month', async () => {
    const available = await listAvailable(ownerCtx());
    const may = available.find((entry) => entry.periodId === mayPeriodId)!;
    expect(may.file?.id).toBe(reportFileId);
    expect(may.file?.periodLabel).toBe('May 2026');
  });
});

describe('isolation case 23 — another organisation’s report id (§4)', () => {
  let foreignReportId: string;

  beforeAll(async () => {
    const foreignPeriod = monthId(otherOrgId, '2026-05');
    foreignReportId = newId();
    await orgRow(fs(), otherOrgId, 'report_files', foreignReportId).set({
      id: foreignReportId, organization_id: otherOrgId, period_id: foreignPeriod, report_kind: 'monthly_management',
      job_id: null, storage_bucket: 'reports', storage_path: `${otherOrgId}/${foreignPeriod}/theirs.pdf`, sha256: null,
      byte_size: null, generated_by: null, evidence_bundle_id: null, deleted_at: null, created_at: nowIso(), report_id: null,
    });
  });

  it('does not resolve, so no URL can be minted', async () => {
    expect(await getReportFile(ownerCtx(), foreignReportId)).toBeNull();
  });

  /*
   * And the audit function refuses it too, which is the half that matters: ADR-043.5 makes the
   * audit row the INPUT the signer verifies, so a row naming another organisation's report would
   * have satisfied every check the signer makes.
   */
  it('and cannot be recorded as a download under this organisation', async () => {
    await expect(recordAccessEvent(
      { userId: ownerId, requestId: `itest-${RUN}` },
      {
        organizationId: orgId,
        action: 'report.downloaded',
        targetTable: 'report_files',
        targetId: foreignReportId,
      },
    )).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const downloads = await fs().collection('audit_events').where('target_id', '==', foreignReportId).get();
    expect(downloads.docs.filter((d) => d.get('action') === 'report.downloaded')).toHaveLength(0);
  });
});

describe('a browser cannot write a report row (ADR-043)', () => {
  it('api_server.record_report_file refuses a signed-in user', async () => {
    const { error } = await rpc(clientFor(ownerId, { email: `owner@${DOMAIN}` }), 'record_report_file', {
      p_actor: ownerId, p_org: orgId, p_period: mayPeriodId, p_job: null, p_file: null, p_sha256: null, p_bytes: 1,
    }, { server: true });
    expect(error).toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('and there is no api.* function that writes report_files (ADR-026)', async () => {
    // The browser never reaches Firestore (firebase/firestore.rules deny all); a user's only writes
    // are api.* functions, and none of them is named for this.
    await expect(callApi(clientFor(ownerId), 'record_report_file', {})).rejects.toMatchObject({ code: 'INTERNAL' });
  });
});

describe('a client may read a report but not ask for one (RBAC_MATRIX)', () => {
  it('reads it', async () => {
    expect(await getMonthlyReport(contextFor(clientId, 'client'), mayPeriodId)).not.toBeNull();
  });

  it('and cannot enqueue a render', async () => {
    await expect(requestPdf(contextFor(clientId, 'client'), mayPeriodId))
      .rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });
});
