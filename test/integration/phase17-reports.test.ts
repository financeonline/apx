import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { callApi } from '@/core/db';
import { permissionsFor } from '@/core/permissions';
import { getObject } from '@/core/storage/signer';
import { loadHome } from '@/modules/dashboard';
import { drainJobs } from '@/modules/jobs';
import {
  composeBrief, finishCustomReport, getStoredReport, listStoredReports, requestCompose, requestStoredPdf,
  type AdviserContent, type BriefContent, type CustomReportContent,
} from '@/modules/reporting';
import type { AccessContext } from '@/modules/tenancy';
import { auth } from '@/db/firestore';
import { orgCollection } from '@/db/schema';
import {
  clientFor, createAuthUser, deleteOrg, drainUntilFinished, fs, rpc, serviceClientScoped,
} from './setup';
import { addMember, createOrgFixture } from './r-fixtures';
import { ensureMonths, monthId, systemAccountId } from './r-metrics';
import {
  writeAction, writeAlert, writeBankAccount, writeBankTransaction, writeConversation, writeCounterparty,
  writeImportBatch, writeInvoice, writeLedgerEntry, writeMessage, writeSourceDocument,
} from './r-records';
import { writeJob } from './r-metrics';

/**
 * Phase 17 — Intelligent Reporting (ADR-141; PHASE_17_IMPLEMENTATION.md).
 *
 * The organisation is seeded with a week (Monday 7 – Sunday 13 September 2026, London) of bank
 * transactions, invoices, alerts and actions whose every expected figure is worked by hand below,
 * plus an August ledger so there is a complete month. Run-unique fixtures (ADR-052.12), written into
 * Firestore in the shapes an import, the engine and the alert and action functions leave
 * (`r-records.ts`); the figures come from the real calculation job.
 */

const RUN = `p17${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.reports.itest.motion`;
const WEEK = '2026-09-07';

let ownerId: string;
let adminId: string;
let clientId: string;
let strangerId: string;
let orgId: string;
let orgSlug: string;
let otherOrgId: string;
const users: string[] = [];

function contextFor(userId: string, role: 'owner' | 'admin' | 'client', org = orgId): AccessContext {
  return {
    userId, orgId: org, orgSlug, effectiveRole: role, permissions: permissionsFor(role),
    actorType: 'user', db: clientFor(userId, { email: `${role}@${DOMAIN}` }),
    requestId: `itest-${RUN}`, now: () => new Date(), organizationStatus: 'active',
  };
}
const ownerCtx = () => contextFor(ownerId, 'owner');

const reportsWhere = async (filter: Record<string, unknown>) => {
  const docs = (await orgCollection(fs(), orgId, 'reports').get()).docs.map((d) => d.data());
  return docs.filter((r) => Object.entries(filter).every(([k, v]) => r[k] === v))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
};

let overdueActionId: string;
let dueSoonActionId: string;
let completedActionId: string;
let midnightAlertId: string;

async function user(label: string): Promise<string> {
  const id = await createAuthUser(`${label}@${DOMAIN}`);
  users.push(id);
  return id;
}

beforeAll(async () => {
  ownerId = await user('owner');
  adminId = await user('admin');
  clientId = await user('client');
  strangerId = await user('stranger');

  const org = await createOrgFixture({ name: `ITest Reports ${RUN}`, ownerId });
  orgId = org.id;
  orgSlug = org.slug;
  otherOrgId = (await createOrgFixture({ name: `ITest Reports Other ${RUN}`, ownerId: strangerId })).id;

  await addMember(orgId, adminId, 'admin');
  await addMember(orgId, clientId, 'client');
  await ensureMonths(orgId, '2026-07-01', '2026-10-31');

  // ---- August ledger, so there is a complete month with figures ---------------------------------
  const revenue = await systemAccountId(orgId, 'revenue');
  const payroll = await systemAccountId(orgId, 'payroll');
  for (const [account, direction, amount] of [[revenue, 'credit', '20000.00'], [payroll, 'debit', '8000.00']] as const) {
    await writeLedgerEntry(orgId, { accountId: account, date: '2026-08-15', direction, amount });
  }

  // A committed general-ledger import declaring August is what makes the month complete (ADR-030).
  const doc = await writeSourceDocument(orgId, { path: `${orgId}/p17/gl.csv`, filename: 'gl.csv', kind: 'general_ledger' });
  await writeImportBatch(orgId, {
    documentId: doc, importType: 'general_ledger', targetTable: 'ledger_entries', status: 'committed',
    periodStart: '2026-08-01', periodEnd: '2026-08-31',
  });

  // ---- The week ---------------------------------------------------------------------------------
  const current = await writeBankAccount(orgId, { name: 'Current', type: 'current', masked: '****0001' });
  const savings = await writeBankAccount(orgId, { name: 'Savings', type: 'savings', masked: '****0002' });

  // Committed statements covering August and September for both accounts: a month is complete only
  // when every active cash account's statements cover it (ADR-047.6).
  for (const account of [current, savings]) {
    await writeImportBatch(orgId, {
      documentId: doc, importType: 'bank_statement', targetTable: 'bank_transactions', status: 'committed',
      bankAccountId: account, periodStart: '2026-08-01', periodEnd: '2026-09-30',
    });
  }

  const bank = (account: string, date: string, amount: string, extra: { kind?: string } = {}) =>
    writeBankTransaction(orgId, { accountId: account, date, amount, transferKind: extra.kind });
  await bank(current, '2026-09-02', '50.00');                               // the week before
  await bank(current, '2026-09-07', '1200.00');
  await bank(current, '2026-09-08', '-400.25');
  await bank(current, '2026-09-09', '-1000.00', { kind: 'cash_transfer' }); // own-account transfer: excluded
  await bank(savings, '2026-09-09', '1000.00', { kind: 'cash_transfer' });
  await bank(current, '2026-09-13', '300.50');
  await bank(current, '2026-09-14', '-9999.00');                            // the week after
  await bank(savings, '2026-09-20', '1.00');                                // both accounts reach past the week

  const customer = await writeCounterparty(orgId, `Acme ${RUN}`);
  await writeInvoice(orgId, { type: 'sales', number: 'INV-1', issue: '2026-09-08', due: '2026-09-10', total: '1000.00', paid: '0', status: 'open', paidDate: null, counterparty: customer });
  await writeInvoice(orgId, { type: 'sales_credit_note', number: 'CN-1', issue: '2026-09-09', due: null, total: '150.00', paid: '0', status: 'open', paidDate: null, counterparty: customer });
  await writeInvoice(orgId, { type: 'sales', number: 'INV-2', issue: '2026-08-20', due: '2026-09-03', total: '300.00', paid: '300.00', status: 'paid', paidDate: '2026-09-12', counterparty: customer });

  // ---- The figures, so the latest complete month exists -----------------------------------------
  const jobId = await writeJob(orgId, { jobType: 'calculation.run', payload: { trigger: 'recalc_manual' } });
  expect(await drainUntilFinished(drainJobs, jobId), 'the figures must exist').toBe('succeeded');
  const runs = (await orgCollection(fs(), orgId, 'calculation_runs').where('status', '==', 'succeeded').get()).docs
    .sort((a, b) => String(b.get('finished_at')).localeCompare(String(a.get('finished_at'))));
  const runId = runs[0]!.id;
  const august = monthId(orgId, '2026-08');

  // ---- Alerts and actions at known instants ----------------------------------------------------
  const alert = (title: string, severity: string, firstSeen: string, status = 'open', changedAt: string | null = null) =>
    writeAlert(orgId, {
      periodId: august, runId, title, severity, firstSeen, status, changedAt,
      dedupeKey: `fixture-${RUN}-${title.replace(/\W/g, '')}`,
    });
  await alert('Raised Tuesday morning', 'high', '2026-09-08T10:00:00.000Z');
  // 23:30 UTC on Monday 7 September is 00:30 on Tuesday 8 September in London (BST).
  midnightAlertId = await alert('Raised just after London midnight', 'critical', '2026-09-07T23:30:00.000Z');
  await alert('Resolved Wednesday', 'medium', '2026-08-30T09:00:00.000Z', 'resolved', '2026-09-09T12:00:00.000Z');

  const action = (title: string, due: string | null, status = 'open', completedAt: string | null = null) =>
    writeAction(orgId, { title, due, status, completedAt, ownerId });
  overdueActionId = await action('Chase INV-1', '2026-09-10');
  dueSoonActionId = await action('Review payroll', '2026-09-15');
  completedActionId = await action('Call the bank', '2026-09-11', 'completed', '2026-09-11T14:00:00.000Z');
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

const figure = (content: BriefContent, key: string) =>
  [...(content.interim.cash ?? []), ...(content.interim.invoicing ?? [])].find((f) => f.key === key);
const comparison = (content: BriefContent, key: string) => content.comparison.find((row) => row.key === key);

describe('the Weekly Intelligence Report, composed and stored', () => {
  let reportId: string;
  let content: BriefContent;

  it('is composed by the queue for a finished week, and stored', async () => {
    const jobId = await requestCompose(ownerCtx(), 'weekly_intelligence', WEEK);
    expect(await drainUntilFinished(drainJobs, jobId)).toBe('succeeded');
    reportId = String((await reportsWhere({ report_kind: 'weekly_intelligence', window_start: WEEK }))[0]!.id);
    const stored = await getStoredReport(ownerCtx(), reportId);
    expect(stored).toMatchObject({ kind: 'weekly_intelligence', windowStart: WEEK, windowEnd: '2026-09-13', origin: 'requested' });
    content = stored!.content as BriefContent;
    expect(content.version).toBe('brief.v1');
  });

  it('counts cash in the week by transaction date, leaving own-account transfers out', () => {
    // In: 1,200.00 + 300.50. Out: 400.25 (the 1,000.00 transfer pair is excluded). Net: 1,100.25.
    expect(figure(content, 'cash_in')).toMatchObject({ value: '1500.50', recordCount: 2, status: 'calculated' });
    expect(figure(content, 'cash_out')).toMatchObject({ value: '400.25', recordCount: 1 });
    expect(figure(content, 'net_cash_movement')).toMatchObject({ value: '1100.25' });
  });

  it('compares with the week before', () => {
    // The week before held one 50.00 receipt: 1,500.50 − 50.00 = 1,450.50.
    expect(comparison(content, 'cash_in')).toMatchObject({ change: '1450.50' });
    expect(comparison(content, 'cash_in')?.previous?.value).toBe('50.00');
  });

  it('nets the credit note against invoicing, and counts what was paid and what fell due', () => {
    expect(figure(content, 'sales_invoiced')).toMatchObject({ value: '850.00', recordCount: 2 });
    expect(figure(content, 'sales_collected')).toMatchObject({ value: '300.00', recordCount: 1 });
    expect(figure(content, 'sales_fell_due_unpaid')).toMatchObject({ value: '1000.00', recordCount: 1 });
  });

  it('lists what happened in the week, by London time', () => {
    const raised = content.events.alertsRaised.items.map((a) => a.title);
    expect(raised).toEqual(expect.arrayContaining(['Raised Tuesday morning', 'Raised just after London midnight']));
    expect(content.events.alertsResolved.items.map((a) => a.title)).toEqual(['Resolved Wednesday']);
    expect(content.events.actionsCompleted.items.map((a) => a.id)).toEqual([completedActionId]);
  });

  it('lists what is unresolved — overdue and due soon — as of composition', () => {
    expect(content.attention.overdueActions.items.map((a) => a.id)).toContain(overdueActionId);
    expect(content.attention.dueSoonActions.items.map((a) => a.id)).toContain(dueSoonActionId);
    expect(content.attention.standingBySeverity.critical).toBeGreaterThanOrEqual(1);
  });

  it('never stores a colleague\'s name — only whether an action is assigned', () => {
    const action = content.attention.overdueActions.items[0]!;
    expect(action.assigned).toBe(true);
    expect(JSON.stringify(content)).not.toContain(`owner@${DOMAIN}`);
  });

  it('carries the latest complete month exactly as Home shows it, card for card (ARCHITECTURE risk 7)', async () => {
    const home = await loadHome(ownerCtx().db, orgId, orgSlug, `itest-${RUN}`);
    if (home.kind !== 'ready') throw new Error('Home must have figures for this to compare against');
    expect(content.latestMonth?.periodId).toBe(home.view.period.id);
    expect(content.latestMonth?.label).toBe(home.view.period.label);
    expect(content.latestMonth?.basisLine).toBe(home.view.basisLine);
    expect(content.latestMonth?.cards.map((card) => [card.metricKey, card.label, card.value, card.change, card.statusLabel]))
      .toEqual(home.view.cards.map((card) => [card.metricKey, card.label, card.value, card.change?.text ?? null, card.status.label]));
  });

  it('is listed, and a second composition is a new version — the first is kept', async () => {
    const jobId = await requestCompose(ownerCtx(), 'weekly_intelligence', WEEK);
    expect(await drainUntilFinished(drainJobs, jobId)).toBe('succeeded');
    const listed = await listStoredReports(ownerCtx(), ['weekly_intelligence']);
    const week = listed.find((r) => r.windowStart === WEEK)!;
    expect(week.versions).toBe(2);
    expect(week.id).not.toBe(reportId);
    expect((await reportsWhere({ window_start: WEEK })).length).toBe(2);
  });
});

describe('the Daily Executive Brief follows the organisation\'s day, not UTC\'s', () => {
  it('puts an alert raised at 23:30 UTC on Monday into Tuesday in London', async () => {
    const monday = await composeBrief({ db: ownerCtx().db, orgId, kind: 'daily_brief', windowStart: '2026-09-07', now: new Date() });
    const tuesday = await composeBrief({ db: ownerCtx().db, orgId, kind: 'daily_brief', windowStart: '2026-09-08', now: new Date() });
    expect(monday.events.alertsRaised.items.map((a) => a.id)).not.toContain(midnightAlertId);
    expect(tuesday.events.alertsRaised.items.map((a) => a.id)).toContain(midnightAlertId);
  });

  it('a day\'s figures are that day\'s: Monday has the 1,200.00 receipt and nothing else', async () => {
    const monday = await composeBrief({ db: ownerCtx().db, orgId, kind: 'daily_brief', windowStart: '2026-09-07', now: new Date() });
    expect(figure(monday, 'cash_in')).toMatchObject({ value: '1200.00', recordCount: 1 });
    expect(figure(monday, 'cash_out')).toMatchObject({ value: '0.00', recordCount: 0 });
  });
});

describe('the Accountant/CFO Report', () => {
  it('is composed for the latest complete month, with the Command Centre\'s reasons', async () => {
    const jobId = await requestCompose(ownerCtx(), 'adviser', null);
    expect(await drainUntilFinished(drainJobs, jobId)).toBe('succeeded');
    const id = String((await reportsWhere({ report_kind: 'adviser' }))[0]!.id);
    const stored = await getStoredReport(ownerCtx(), id);
    const content = stored!.content as AdviserContent;
    expect(content.version).toBe('adviser.v1');
    const home = await loadHome(ownerCtx().db, orgId, orgSlug, `itest-${RUN}`);
    if (home.kind !== 'ready') throw new Error('expected figures');
    expect(content.month.periodId).toBe(home.view.period.id);
    expect(stored!.windowStart).toBe(home.view.period.periodStart);
    // A critical alert stands, so the first reason is the Command Centre's heaviest.
    expect(content.attention[0]).toMatch(/critical alert/);
    expect(content.actions.overdue.items.map((a) => a.id)).toContain(overdueActionId);
    expect(content.dataQuality.bankAccounts.map((a) => a.name)).toEqual(['Current', 'Savings']);
  });
});

describe('the window is validated by the database', () => {
  it('refuses a day that has not finished', async () => {
    const today = new Date().toISOString().slice(0, 10);
    await expect(requestCompose(ownerCtx(), 'daily_brief', '2099-01-01')).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(requestCompose(ownerCtx(), 'daily_brief', today)).rejects.toBeTruthy();
  });

  it('refuses a week that does not start on a Monday', async () => {
    await expect(requestCompose(ownerCtx(), 'weekly_intelligence', '2026-09-08')).rejects.toMatchObject({ code: 'VALIDATION' });
    const { error } = await rpc(ownerCtx().db, 'enqueue_job', {
      p_org: orgId, p_job_type: 'report.compose', p_payload: { kind: 'weekly_intelligence', windowStart: '2026-09-08' },
    });
    expect(error?.message).toMatch(/Monday/);
  });

  it('refuses a kind the queue does not compose', async () => {
    const { error } = await rpc(ownerCtx().db, 'enqueue_job', {
      p_org: orgId, p_job_type: 'report.compose', p_payload: { kind: 'custom_ai' },
    });
    expect(error?.message).toMatch(/not composed by a job/);
  });
});

describe('who may read and ask (RBAC_MATRIX)', () => {
  it('a client reads the stored brief but cannot ask for one', async () => {
    const listed = await listStoredReports(contextFor(clientId, 'client'), ['weekly_intelligence']);
    expect(listed.length).toBeGreaterThan(0);
    await expect(requestCompose(contextFor(clientId, 'client'), 'daily_brief', WEEK)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('another organisation\'s report id is simply absent', async () => {
    const id = String((await reportsWhere({}))[0]!.id);
    const stranger: AccessContext = { ...contextFor(strangerId, 'owner', otherOrgId), orgSlug: 'other' };
    expect(await getStoredReport(stranger, id)).toBeNull();
    await expect(requestStoredPdf(stranger, id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('nobody can write a report row from a browser', async () => {
    // There is no `api.*` function that writes a report, and the browser never reaches Firestore
    // (firebase/firestore.rules deny all); `api_server.record_report` refuses anything but the server.
    await expect(callApi(ownerCtx().db, 'record_report', {})).rejects.toMatchObject({ code: 'INTERNAL' });
    const refused = await rpc(ownerCtx().db, 'record_report', {
      p_actor: ownerId, p_org: orgId, p_kind: 'daily_brief', p_window_start: '2026-09-01', p_window_end: '2026-09-01',
      p_period: null, p_job: null, p_origin: 'requested', p_content: {}, p_content_version: 'x',
    }, { server: true });
    expect(refused.error).toMatchObject({ code: 'PERMISSION_DENIED' });
  });
});

describe('the PDF of a stored report', () => {
  it('renders the stored content, stores it under the report, and the client can see it exists', async () => {
    const reportId = String((await reportsWhere({ report_kind: 'weekly_intelligence' }))[0]!.id);
    const jobId = await requestStoredPdf(ownerCtx(), reportId);
    expect(await drainUntilFinished(drainJobs, jobId)).toBe('succeeded');

    const files = (await orgCollection(fs(), orgId, 'report_files').where('report_id', '==', reportId).get()).docs.map((d) => d.data());
    expect(files).toHaveLength(1);
    const { id: fileId, report_kind: kind, storage_path: path, sha256 } = files[0]!;
    // bytea is stored as lowercase hex without the `\x` prefix.
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(kind).toBe('weekly_intelligence');
    expect(path).toBe(`${orgId}/r/${reportId}/${fileId}.pdf`);

    const bytes = await getObject({ orgId, userId: ownerId }, 'reports', String(path));
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-');

    const stored = await getStoredReport(contextFor(clientId, 'client'), reportId);
    expect(stored?.file?.id).toBe(fileId);
  });
});

describe('the Custom AI Report', () => {
  let conversationId: string;
  let answerId: string;
  let otherAnswerId: string;

  beforeAll(async () => {
    conversationId = await writeConversation(orgId, ownerId, 'custom');
    const answer = {
      mode: 'answer',
      direct_answer: { statement: 'Profit rose.', kind: 'inference', period: 'August 2026', evidence_refs: [], numbers: [], entity_refs: [] },
      key_findings: [], causes: [], risks: [], opportunities: [], recommended_actions: [],
      confidence: { data_quality_notes: [] }, evidence: [], unsupported: [],
    };
    const ago = (s: number) => new Date(Date.now() - s * 1000).toISOString();
    await writeMessage(orgId, { conversationId, role: 'user', content: 'For August 2026: Why did profit increase or decrease?', createdAt: ago(2) });
    answerId = await writeMessage(orgId, { conversationId, role: 'assistant', structured: answer, grounding: 'passed', createdAt: ago(1) });
    const elsewhere = await writeConversation(orgId, ownerId, 'other');
    await writeMessage(orgId, { conversationId: elsewhere, role: 'user', content: 'q' });
    otherAnswerId = await writeMessage(orgId, { conversationId: elsewhere, role: 'assistant', structured: answer, grounding: 'passed' });
  });

  const august = () => monthId(orgId, '2026-08');

  it('is built from the STORED answers of the caller\'s own conversation', async () => {
    const reportId = await finishCustomReport(ownerCtx(), {
      conversationId, periodId: august(), dimensions: ['profitability'], assistantMessageIds: [answerId],
    });
    const stored = await getStoredReport(ownerCtx(), reportId);
    const content = stored!.content as CustomReportContent;
    expect(content.entries).toHaveLength(1);
    expect(content.entries[0]).toMatchObject({ asked: 'For August 2026: Why did profit increase or decrease?', groundingStatus: 'passed' });
    expect(content.entries[0]!.answer?.direct_answer.statement).toBe('Profit rose.');
  });

  it('is its author\'s alone: an admin of the same organisation cannot read it', async () => {
    const id = String((await reportsWhere({ report_kind: 'custom_ai' }))[0]!.id);
    expect(await getStoredReport(contextFor(adminId, 'admin'), id)).toBeNull();
    expect(await getStoredReport(ownerCtx(), id)).not.toBeNull();
  });

  it('refuses an answer from another conversation', async () => {
    await expect(finishCustomReport(ownerCtx(), {
      conversationId, periodId: august(), dimensions: [], assistantMessageIds: [otherAnswerId],
    })).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('refuses another person\'s conversation as not found', async () => {
    await expect(finishCustomReport(contextFor(adminId, 'admin'), {
      conversationId, periodId: august(), dimensions: [], assistantMessageIds: [answerId],
    })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses a month that is not complete', async () => {
    const october = monthId(orgId, '2026-10');
    await expect(finishCustomReport(ownerCtx(), {
      conversationId, periodId: october, dimensions: [], assistantMessageIds: [answerId],
    })).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});

describe('the hourly schedule', () => {
  const sweep = async (now: string): Promise<number> => {
    const { data, error } = await rpc<number>(serviceClientScoped(), 'enqueue_scheduled_reports', { p_now: now }, { server: true });
    if (error) throw error;
    return data as number;
  };
  const scheduled = async (from: string) => (await fs().collection('jobs').where('job_type', '==', 'report.compose').get()).docs
    .filter((d) => d.get('requested_by') === null && String(d.get('created_at')) >= from);
  const ours = async (from: string) => (await scheduled(from))
    .filter((d) => d.get('organization_id') === orgId)
    .map((d) => `${d.get('payload').kind}:${d.get('payload').windowStart}`).sort().join(',');
  // Other organisations in the shared emulator are queued too; their jobs (and the "one queued job
  // per key" guards they hold) are removed at once so no other suite meets them.
  const tidy = async (from: string) => {
    for (const d of await scheduled(from)) {
      if (d.get('organization_id') === orgId) continue;
      const guards = await fs().collection('_unique').where('owner_id', '==', d.id).get();
      for (const g of guards.docs) await g.ref.delete();
      await d.ref.delete();
    }
  };

  it('queues yesterday\'s brief after local midnight, and last week\'s report on a Monday — once', async () => {
    const from = new Date().toISOString();
    // 23:30 UTC on Sunday 4 October 2026 is 00:30 on Monday 5 October in London.
    await sweep('2026-10-04T23:30:00Z');
    await tidy(from);
    expect(await ours(from)).toBe('daily_brief:2026-10-04,weekly_intelligence:2026-09-28');

    await sweep('2026-10-05T00:30:00Z');
    await tidy(from);
    expect(await ours(from), 'the same window is never queued twice').toBe('daily_brief:2026-10-04,weekly_intelligence:2026-09-28');
  });

  it('the scheduled brief is stored with no actor, as scheduled', async () => {
    const job = (await fs().collection('jobs').where('organization_id', '==', orgId).where('job_type', '==', 'report.compose').get()).docs
      .find((d) => d.get('payload').windowStart === '2026-10-04' && d.get('requested_by') === null)!;
    expect(await drainUntilFinished(drainJobs, job.id)).toBe('succeeded');
    const stored = await reportsWhere({ report_kind: 'daily_brief', window_start: '2026-10-04' });
    expect(stored.map((r) => `${r.origin}|${r.requested_by ?? 'none'}`)).toEqual(['scheduled|none']);
  });
});
