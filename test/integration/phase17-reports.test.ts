import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { permissionsFor } from '@/core/permissions';
import { loadHome } from '@/modules/dashboard';
import { drainJobs } from '@/modules/jobs';
import {
  composeBrief, finishCustomReport, getStoredReport, listStoredReports, requestCompose, requestStoredPdf,
  type AdviserContent, type BriefContent, type CustomReportContent,
} from '@/modules/reporting';
import type { AccessContext } from '@/modules/tenancy';
import {
  adminSql, clientFor, createAuthUser, drainUntilFinished, serviceStorage, sqlstate,
} from './setup';

/**
 * Phase 17 — Intelligent Reporting (ADR-141; PHASE_17_IMPLEMENTATION.md).
 *
 * The organisation is seeded with a week (Monday 7 – Sunday 13 September 2026, London) of bank
 * transactions, invoices, alerts and actions whose every expected figure is worked by hand below,
 * plus an August ledger so there is a complete month. Run-unique fixtures (ADR-052.12).
 */

const RUN = `p17${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.reports.itest`;
const WEEK = '2026-09-07';

let ownerId: string;
let adminId: string;
let clientId: string;
let strangerId: string;
let orgId: string;
let orgSlug: string;
let otherOrgId: string;

const one = (sql: string): string => adminSql(`with q as (${sql}) select * from q`);

function contextFor(userId: string, role: 'owner' | 'admin' | 'client', org = orgId): AccessContext {
  return {
    userId, orgId: org, orgSlug, effectiveRole: role, permissions: permissionsFor(role),
    actorType: 'user', db: clientFor(userId, { email: `${role}@${DOMAIN}` }),
    requestId: `itest-${RUN}`, now: () => new Date(), organizationStatus: 'active',
  };
}
const ownerCtx = () => contextFor(ownerId, 'owner');

function bank(account: string, date: string, amount: string, extra: { kind?: string } = {}): string {
  return one(`
    insert into public.bank_transactions
           (organization_id, bank_account_id, transaction_date, amount, period_id, currency,
            description_raw, description_normalized, record_status, assurance_level, transfer_kind, is_transfer)
    values ('${orgId}', '${account}', '${date}', ${amount}, '00000000-0000-0000-0000-000000000000', 'GBP',
            'fixture ${date} ${amount}', 'fixture ${date} ${amount}', 'accepted', 'verified',
            '${extra.kind ?? 'none'}', ${extra.kind === 'cash_transfer'})
    returning id`);
}

function invoice(fields: {
  type: string; number: string; issue: string; due: string | null; total: string; paid: string;
  status: string; paidDate: string | null; counterparty: string;
}): string {
  return one(`
    insert into public.invoices
           (organization_id, invoice_type, counterparty_id, invoice_number, issue_date, due_date, period_id,
            total_amount, amount_paid, status, paid_date, currency, record_status, assurance_level)
    values ('${orgId}', '${fields.type}', '${fields.counterparty}', '${fields.number}', '${fields.issue}',
            ${fields.due === null ? 'null' : `'${fields.due}'`}, '00000000-0000-0000-0000-000000000000',
            ${fields.total}, ${fields.paid}, '${fields.status}',
            ${fields.paidDate === null ? 'null' : `'${fields.paidDate}'`}, 'GBP', 'accepted', 'verified')
    returning id`);
}

let overdueActionId: string;
let dueSoonActionId: string;
let completedActionId: string;
let midnightAlertId: string;

beforeAll(async () => {
  ownerId = createAuthUser(`owner@${DOMAIN}`);
  adminId = createAuthUser(`admin@${DOMAIN}`);
  clientId = createAuthUser(`client@${DOMAIN}`);
  strangerId = createAuthUser(`stranger@${DOMAIN}`);

  const created = await clientFor(ownerId).schema('api').rpc('create_organization', { p_name: `ITest Reports ${RUN}` });
  if (created.error) throw new Error(`fixture org failed: ${created.error.message}`);
  orgId = created.data as unknown as string;
  orgSlug = one(`select slug from public.organizations where id = '${orgId}'`);
  const other = await clientFor(strangerId).schema('api').rpc('create_organization', { p_name: `ITest Reports Other ${RUN}` });
  otherOrgId = other.data as unknown as string;

  adminSql(`
    insert into public.organization_memberships (organization_id, user_id, role, status)
    values ('${orgId}', '${adminId}', 'admin', 'active'), ('${orgId}', '${clientId}', 'client', 'active');
    select app.ensure_periods('${orgId}', '2026-07-01', '2026-10-31');`);

  // ---- August ledger, so there is a complete month with figures ---------------------------------
  const revenue = one(`select id from public.accounts where organization_id = '${orgId}' and standard_category = 'revenue' and is_system`);
  const payroll = one(`select id from public.accounts where organization_id = '${orgId}' and standard_category = 'payroll' and is_system`);
  for (const [account, direction, amount] of [[revenue, 'credit', '20000.00'], [payroll, 'debit', '8000.00']] as const) {
    const id = one(`
      insert into public.ledger_entries (organization_id, entry_date, account_id, direction, amount, period_id, record_status)
      values ('${orgId}', '2026-08-15', '${account}', '${direction}', ${amount}, '00000000-0000-0000-0000-000000000000', 'accepted')
      returning id`);
    adminSql(`insert into public.record_status_events (organization_id, record_table, record_id, event)
              values ('${orgId}', 'ledger_entries', '${id}', 'accepted')`);
  }

  // A committed general-ledger import declaring August is what makes the month complete (ADR-030).
  const doc = one(`
    insert into public.source_documents
           (organization_id, storage_path, original_filename, mime_type, byte_size, sha256, status, document_kind)
    values ('${orgId}', '${orgId}/p17/gl.csv', 'gl.csv', 'text/csv', 10, decode('e5','hex'), 'ready', 'general_ledger')
    returning id`);
  adminSql(`
    insert into public.import_batches
           (organization_id, source_document_id, import_type, target_table, status, extraction_method,
            period_start, period_end, committed_at)
    values ('${orgId}', '${doc}', 'general_ledger', 'ledger_entries', 'committed', 'csv',
            '2026-08-01', '2026-08-31', now())`);

  // ---- The week ---------------------------------------------------------------------------------
  const current = one(`
    insert into public.bank_accounts (organization_id, name, bank_name, account_number_masked, account_type, currency)
    values ('${orgId}', 'Current', 'Test Bank', '****0001', 'current', 'GBP') returning id`);
  const savings = one(`
    insert into public.bank_accounts (organization_id, name, bank_name, account_number_masked, account_type, currency)
    values ('${orgId}', 'Savings', 'Test Bank', '****0002', 'savings', 'GBP') returning id`);

  // Committed statements covering August and September for both accounts: a month is complete only
  // when every active cash account's statements cover it (ADR-047.6).
  for (const account of [current, savings]) {
    adminSql(`
      insert into public.import_batches
             (organization_id, source_document_id, import_type, target_table, status, extraction_method,
              bank_account_id, period_start, period_end, committed_at)
      values ('${orgId}', '${doc}', 'bank_statement', 'bank_transactions', 'committed', 'csv',
              '${account}', '2026-08-01', '2026-09-30', now())`);
  }

  bank(current, '2026-09-02', '50.00');                               // the week before
  bank(current, '2026-09-07', '1200.00');
  bank(current, '2026-09-08', '-400.25');
  bank(current, '2026-09-09', '-1000.00', { kind: 'cash_transfer' }); // own-account transfer: excluded
  bank(savings, '2026-09-09', '1000.00', { kind: 'cash_transfer' });
  bank(current, '2026-09-13', '300.50');
  bank(current, '2026-09-14', '-9999.00');                            // the week after
  bank(savings, '2026-09-20', '1.00');                                // both accounts reach past the week

  const customer = one(`insert into public.counterparties (organization_id, name, kind) values ('${orgId}', 'Acme ${RUN}', 'customer') returning id`);
  invoice({ type: 'sales', number: 'INV-1', issue: '2026-09-08', due: '2026-09-10', total: '1000.00', paid: '0', status: 'open', paidDate: null, counterparty: customer });
  invoice({ type: 'sales_credit_note', number: 'CN-1', issue: '2026-09-09', due: null, total: '150.00', paid: '0', status: 'open', paidDate: null, counterparty: customer });
  invoice({ type: 'sales', number: 'INV-2', issue: '2026-08-20', due: '2026-09-03', total: '300.00', paid: '300.00', status: 'paid', paidDate: '2026-09-12', counterparty: customer });

  // ---- The figures, so the latest complete month exists -----------------------------------------
  const jobId = adminSql(`
    insert into public.jobs (organization_id, job_type, payload, max_attempts)
    values ('${orgId}', 'calculation.run', '{"trigger":"recalc_manual"}'::jsonb, 3)
    returning id`).split('\n')[0]!.trim();
  expect(await drainUntilFinished(drainJobs, jobId), 'the figures must exist').toBe('succeeded');
  const runId = one(`select id from public.calculation_runs where organization_id = '${orgId}' and status = 'succeeded' order by finished_at desc limit 1`);
  const august = one(`select id from public.fiscal_periods where organization_id = '${orgId}' and period_start = '2026-08-01'`);

  // ---- Alerts and actions at known instants ----------------------------------------------------
  const alert = (title: string, severity: string, firstSeen: string, status = 'open', changedAt: string | null = null) => one(`
    insert into public.alerts
           (organization_id, period_id, rule_key, rule_version, severity, key_kind, calculation_run_id, title,
            explanation, status, first_seen_at, status_changed_at, dedupe_key, recommended_next_step)
    values ('${orgId}', '${august}', 'fixture.${title.replace(/\W/g, '')}', '1', '${severity}', 'event', '${runId}',
            '${title}', '${title} explained.', '${status}', '${firstSeen}', ${changedAt === null ? 'null' : `'${changedAt}'`},
            'fixture-${RUN}-${title.replace(/\W/g, '')}', 'Look at it.')
    returning id`);
  alert('Raised Tuesday morning', 'high', '2026-09-08T10:00:00Z');
  // 23:30 UTC on Monday 7 September is 00:30 on Tuesday 8 September in London (BST).
  midnightAlertId = alert('Raised just after London midnight', 'critical', '2026-09-07T23:30:00Z');
  alert('Resolved Wednesday', 'medium', '2026-08-30T09:00:00Z', 'resolved', '2026-09-09T12:00:00Z');

  const action = (title: string, due: string | null, status = 'open', completedAt: string | null = null) => one(`
    insert into public.actions (organization_id, title, priority, due_date, status, source_type, completed_at, owner_user_id)
    values ('${orgId}', '${title}', 'high', ${due === null ? 'null' : `'${due}'`}, '${status}', 'user',
            ${completedAt === null ? 'null' : `'${completedAt}'`}, '${ownerId}')
    returning id`);
  overdueActionId = action('Chase INV-1', '2026-09-10');
  dueSoonActionId = action('Review payroll', '2026-09-15');
  completedActionId = action('Call the bank', '2026-09-11', 'completed', '2026-09-11T14:00:00Z');
});

afterAll(() => {
  adminSql(`
    select set_config('app.purge', 'on', false);
    delete from public.report_files where organization_id in (select id from public.organizations where name like 'ITest Reports%${RUN}');
    delete from public.reports where organization_id in (select id from public.organizations where name like 'ITest Reports%${RUN}');
    delete from public.organizations where name like 'ITest Reports%${RUN}';
    delete from auth.users where email like '%@${DOMAIN}';`);
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
    reportId = one(`select id from public.reports where organization_id = '${orgId}' and report_kind = 'weekly_intelligence' and window_start = '${WEEK}'`);
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
    expect(Number(one(`select count(*) from public.reports where organization_id = '${orgId}' and window_start = '${WEEK}'`))).toBe(2);
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
    const id = one(`select id from public.reports where organization_id = '${orgId}' and report_kind = 'adviser'`);
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
    const { error } = await ownerCtx().db.schema('api').rpc('enqueue_job', {
      p_org: orgId, p_job_type: 'report.compose', p_payload: { kind: 'weekly_intelligence', windowStart: '2026-09-08' },
    });
    expect(error?.message).toMatch(/Monday/);
  });

  it('refuses a kind the queue does not compose', async () => {
    const { error } = await ownerCtx().db.schema('api').rpc('enqueue_job', {
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
    const id = one(`select id from public.reports where organization_id = '${orgId}' limit 1`);
    const stranger: AccessContext = { ...contextFor(strangerId, 'owner', otherOrgId), orgSlug: 'other' };
    expect(await getStoredReport(stranger, id)).toBeNull();
    await expect(requestStoredPdf(stranger, id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('nobody can write a report row from a browser, or change one at all', async () => {
    const { error } = await ownerCtx().db.from('reports').insert({
      organization_id: orgId, report_kind: 'daily_brief', window_start: '2026-09-01', window_end: '2026-09-01',
      origin: 'requested', content: {}, content_version: 'x',
    });
    expect(sqlstate(error)).toBe('42501');
    const rpc = await ownerCtx().db.schema('api_server').rpc('record_report', {
      p_actor: ownerId, p_org: orgId, p_kind: 'daily_brief', p_window_start: '2026-09-01', p_window_end: '2026-09-01',
      p_period: null, p_job: null, p_origin: 'requested', p_content: {}, p_content_version: 'x',
    });
    expect(rpc.error).not.toBeNull();
    expect(() => adminSql(`update public.reports set content = '{}'::jsonb where organization_id = '${orgId}'`)).toThrow(/IMMUTABLE/);
    expect(() => adminSql(`delete from public.reports where organization_id = '${orgId}'`)).toThrow(/IMMUTABLE/);
  });
});

describe('the PDF of a stored report', () => {
  it('renders the stored content, stores it under the report, and the client can see it exists', async () => {
    const reportId = one(`select id from public.reports where organization_id = '${orgId}' and report_kind = 'weekly_intelligence' order by created_at desc limit 1`);
    const jobId = await requestStoredPdf(ownerCtx(), reportId);
    expect(await drainUntilFinished(drainJobs, jobId)).toBe('succeeded');

    const row = one(`select id || '|' || report_kind || '|' || storage_path from public.report_files where report_id = '${reportId}'`);
    const [fileId, kind, path] = row.split('|');
    expect(kind).toBe('weekly_intelligence');
    expect(path).toBe(`${orgId}/r/${reportId}/${fileId}.pdf`);

    const { data, error } = await serviceStorage().storage.from('reports').download(path!);
    expect(error).toBeNull();
    const bytes = new Uint8Array(await data!.arrayBuffer());
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-');

    const stored = await getStoredReport(contextFor(clientId, 'client'), reportId);
    expect(stored?.file?.id).toBe(fileId);
  });
});

describe('the Custom AI Report', () => {
  let conversationId: string;
  let answerId: string;
  let otherAnswerId: string;

  beforeAll(() => {
    conversationId = one(`insert into public.ai_conversations (organization_id, user_id, title) values ('${orgId}', '${ownerId}', 'custom') returning id`);
    const answer = JSON.stringify({
      mode: 'answer',
      direct_answer: { statement: 'Profit rose.', kind: 'inference', period: 'August 2026', evidence_refs: [], numbers: [], entity_refs: [] },
      key_findings: [], causes: [], risks: [], opportunities: [], recommended_actions: [],
      confidence: { data_quality_notes: [] }, evidence: [], unsupported: [],
    }).replace(/'/g, "''");
    adminSql(`insert into public.ai_messages (organization_id, conversation_id, role, content, created_at)
              values ('${orgId}', '${conversationId}', 'user', 'For August 2026: Why did profit increase or decrease?', now() - interval '2 seconds')`);
    answerId = one(`insert into public.ai_messages (organization_id, conversation_id, role, structured_response, grounding_status, created_at)
              values ('${orgId}', '${conversationId}', 'assistant', '${answer}'::jsonb, 'passed', now() - interval '1 second') returning id`);
    const elsewhere = one(`insert into public.ai_conversations (organization_id, user_id, title) values ('${orgId}', '${ownerId}', 'other') returning id`);
    adminSql(`insert into public.ai_messages (organization_id, conversation_id, role, content) values ('${orgId}', '${elsewhere}', 'user', 'q')`);
    otherAnswerId = one(`insert into public.ai_messages (organization_id, conversation_id, role, structured_response, grounding_status)
              values ('${orgId}', '${elsewhere}', 'assistant', '${answer}'::jsonb, 'passed') returning id`);
  });

  const august = () => one(`select id from public.fiscal_periods where organization_id = '${orgId}' and period_start = '2026-08-01'`);

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
    const id = one(`select id from public.reports where organization_id = '${orgId}' and report_kind = 'custom_ai' limit 1`);
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
    const october = one(`select id from public.fiscal_periods where organization_id = '${orgId}' and period_start = '2026-10-01'`);
    await expect(finishCustomReport(ownerCtx(), {
      conversationId, periodId: october, dimensions: [], assistantMessageIds: [answerId],
    })).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});

describe('the hourly schedule', () => {
  const sweep = async (now: string): Promise<number> => {
    const { data, error } = await serviceStorage().schema('api_server').rpc('enqueue_scheduled_reports', { p_now: now });
    if (error) throw new Error(error.message);
    return data as number;
  };
  const ours = (from: string) => adminSql(`
    select coalesce(string_agg(payload ->> 'kind' || ':' || (payload ->> 'windowStart'), ',' order by payload ->> 'kind'), '')
      from public.jobs where organization_id = '${orgId}' and job_type = 'report.compose'
       and requested_by is null and created_at >= '${from}'`).trim();
  // Other organisations in the shared database are queued too; their jobs are removed at once so no
  // other suite meets them.
  const tidy = (from: string) => adminSql(`
    delete from public.jobs where job_type = 'report.compose' and requested_by is null
       and organization_id <> '${orgId}' and created_at >= '${from}'`);

  it('queues yesterday\'s brief after local midnight, and last week\'s report on a Monday — once', async () => {
    const from = one(`select now()::text`);
    // 23:30 UTC on Sunday 4 October 2026 is 00:30 on Monday 5 October in London.
    await sweep('2026-10-04T23:30:00Z');
    tidy(from);
    expect(ours(from)).toBe('daily_brief:2026-10-04,weekly_intelligence:2026-09-28');

    await sweep('2026-10-05T00:30:00Z');
    tidy(from);
    expect(ours(from), 'the same window is never queued twice').toBe('daily_brief:2026-10-04,weekly_intelligence:2026-09-28');
  });

  it('the scheduled brief is stored with no actor, as scheduled', async () => {
    const jobId = one(`select id from public.jobs where organization_id = '${orgId}' and job_type = 'report.compose'
                        and payload ->> 'windowStart' = '2026-10-04' and requested_by is null`);
    expect(await drainUntilFinished(drainJobs, jobId)).toBe('succeeded');
    expect(one(`select origin || '|' || coalesce(requested_by::text, 'none') from public.reports
                 where organization_id = '${orgId}' and report_kind = 'daily_brief' and window_start = '2026-10-04'`))
      .toBe('scheduled|none');
  });
});
