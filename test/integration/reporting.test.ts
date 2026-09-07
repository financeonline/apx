import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { permissionsFor } from '@/core/permissions';
import { recordAccessEvent } from '@/core/db';
import { loadHome } from '@/modules/dashboard';
import { drainJobs } from '@/modules/jobs';
import { getMonthlyReport, getReportFile, listAvailable, requestPdf } from '@/modules/reporting';
import type { AccessContext } from '@/modules/tenancy';
import {
  adminSql, clientFor, createAuthUser, drainUntilFinished, serviceStorage, sqlstate,
} from './setup';

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
 * Run-unique fixtures (ADR-052.12).
 */

const RUN = `r${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.reporting.itest`;

let ownerId: string;
let clientId: string;
let strangerId: string;
let orgId: string;
let orgSlug: string;
let otherOrgId: string;
let mayPeriodId: string;
let junePeriodId: string;

const one = (sql: string): string => adminSql(`with q as (${sql}) select * from q`);

function contextFor(userId: string, role: 'owner' | 'client', org = orgId): AccessContext {
  return {
    userId, orgId: org, orgSlug, effectiveRole: role, permissions: permissionsFor(role),
    actorType: 'user', db: clientFor(userId, { email: `${role}@${DOMAIN}` }),
    requestId: `itest-${RUN}`, now: () => new Date('2026-06-15T00:00:00Z'),
    organizationStatus: 'active',
  };
}
const ownerCtx = () => contextFor(ownerId, 'owner');

function accountId(category: string): string {
  return one(`
    select id from public.accounts
     where organization_id = '${orgId}' and standard_category = '${category}' and is_system`);
}

beforeAll(async () => {
  ownerId = createAuthUser(`owner@${DOMAIN}`);
  clientId = createAuthUser(`client@${DOMAIN}`);
  strangerId = createAuthUser(`stranger@${DOMAIN}`);

  const created = await clientFor(ownerId).schema('api').rpc('create_organization', {
    p_name: `ITest Reporting ${RUN}`,
  });
  if (created.error) throw new Error(`fixture org failed: ${created.error.message}`);
  orgId = created.data as unknown as string;
  orgSlug = one(`select slug from public.organizations where id = '${orgId}'`);

  const other = await clientFor(strangerId).schema('api').rpc('create_organization', {
    p_name: `ITest Reporting Other ${RUN}`,
  });
  otherOrgId = other.data as unknown as string;

  adminSql(`
    insert into public.organization_memberships (organization_id, user_id, role, status)
    values ('${orgId}', '${clientId}', 'client', 'active')`);

  mayPeriodId = one(`
    select id from public.fiscal_periods
     where organization_id = '${orgId}' and period_start = '2026-05-01'`);
  junePeriodId = one(`
    select id from public.fiscal_periods
     where organization_id = '${orgId}' and period_start = '2026-06-01'`);

  const post = (category: string, direction: string, amount: string, day: string) => {
    const id = one(`
      insert into public.ledger_entries
             (organization_id, entry_date, account_id, direction, amount, period_id, record_status)
      values ('${orgId}', '2026-05-${day}', '${accountId(category)}', '${direction}', ${amount},
              '00000000-0000-0000-0000-000000000000', 'accepted')
      returning id`);
    adminSql(`
      insert into public.record_status_events (organization_id, record_table, record_id, event)
      values ('${orgId}', 'ledger_entries', '${id}', 'accepted')`);
  };

  post('revenue', 'credit', '40000.00', '10');
  post('cost_of_sales', 'debit', '9000.00', '12');
  post('payroll', 'debit', '12000.00', '25');

  const doc = one(`
    insert into public.source_documents
           (organization_id, storage_path, original_filename, mime_type, byte_size, sha256,
            status, document_kind)
    values ('${orgId}', '${orgId}/report/gl.csv', 'gl.csv', 'text/csv', 10, decode('e5','hex'),
            'ready', 'general_ledger')
    returning id`);
  adminSql(`
    insert into public.import_batches
           (organization_id, source_document_id, import_type, target_table, status,
            extraction_method, period_start, period_end, committed_at)
    values ('${orgId}', '${doc}', 'general_ledger', 'ledger_entries', 'committed',
            'csv', '2026-05-01', '2026-05-31', now())`);

  const jobId = adminSql(`
    insert into public.jobs (organization_id, job_type, payload, max_attempts)
    values ('${orgId}', 'calculation.run',
            '{"trigger":"recalc_manual","as_of":"2026-06-15"}'::jsonb, 3)
    returning id`).split('\n')[0]!.trim();
  expect(await drainUntilFinished(drainJobs, jobId), 'the figures must exist').toBe('succeeded');
});

afterAll(() => {
  adminSql(`
    delete from public.organizations where name like 'ITest Reporting%${RUN}';
    delete from auth.users where email like '%@${DOMAIN}';
    delete from public.organizations where name like 'ITest Reporting %' and created_at < now() - interval '1 hour';
    delete from auth.users where email like '%.reporting.itest' and created_at < now() - interval '1 hour';`);
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
    const foreignPeriod = one(`
      select id from public.fiscal_periods
       where organization_id = '${otherOrgId}' and period_start = '2026-05-01'`);
    expect(await getMonthlyReport(ownerCtx(), foreignPeriod)).toBeNull();
  });
});

describe('the PDF job renders, stores and records (Phase 13 slice 2)', () => {
  let reportFileId: string;

  it('runs end to end and leaves a file behind', async () => {
    const jobId = await requestPdf(ownerCtx(), mayPeriodId);
    expect(await drainUntilFinished(drainJobs, jobId)).toBe('succeeded');

    reportFileId = one(`
      select id::text from public.report_files
       where organization_id = '${orgId}' and period_id = '${mayPeriodId}'`);
    expect(reportFileId).toMatch(/^[0-9a-f-]{36}$/);

    const row = one(`
      select report_kind::text || '|' || storage_bucket || '|' || storage_path
             || '|' || byte_size::text
        from public.report_files where id = '${reportFileId}'`);
    // The path is derived by the function, never supplied: `{org}/{period}/{id}.pdf` (R2-A-09).
    expect(row).toBe(
      `monthly_management|reports|${orgId}/${mayPeriodId}/${reportFileId}.pdf`
      + `|${one(`select byte_size::text from public.report_files where id = '${reportFileId}'`)}`,
    );
  });

  it('the object is really in the bucket, and is a PDF', async () => {
    const path = one(`select storage_path from public.report_files where id = '${reportFileId}'`);
    const { data, error } = await serviceStorage().storage.from('reports').download(path);
    expect(error).toBeNull();

    const bytes = new Uint8Array(await data!.arrayBuffer());
    // A row that names an object Storage cannot serve is the failure mode ADR-043.4's ordering
    // exists to prevent; this is the assertion that the ordering held.
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-');
    expect(bytes.byteLength).toBeGreaterThan(1000);
  });

  it('and the audit says who produced it', () => {
    expect(Number(one(`
      select count(*) from public.audit_events
       where organization_id = '${orgId}' and action = 'report.generated'
         and target_id = '${reportFileId}'`))).toBe(1);
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

  beforeAll(() => {
    const foreignPeriod = one(`
      select id from public.fiscal_periods
       where organization_id = '${otherOrgId}' and period_start = '2026-05-01'`);
    foreignReportId = one(`
      insert into public.report_files
             (organization_id, period_id, report_kind, storage_bucket, storage_path)
      values ('${otherOrgId}', '${foreignPeriod}', 'monthly_management', 'reports',
              '${otherOrgId}/${foreignPeriod}/theirs.pdf')
      returning id`);
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

    expect(Number(one(`
      select count(*) from public.audit_events
       where action = 'report.downloaded' and target_id = '${foreignReportId}'`))).toBe(0);
  });
});

describe('a browser cannot write a report row (ADR-043)', () => {
  it('api_server.record_report_file is not executable with a user JWT', async () => {
    const { error } = await clientFor(ownerId, { email: `owner@${DOMAIN}` })
      .schema('api_server').rpc('record_report_file', {
        p_actor: ownerId, p_org: orgId, p_period: mayPeriodId, p_job: null,
        p_file: null, p_sha256: null, p_bytes: 1,
      });
    expect(error).not.toBeNull();
  });

  it('and no authenticated role can insert into report_files directly (ADR-026)', async () => {
    const { error } = await clientFor(ownerId, { email: `owner@${DOMAIN}` })
      .from('report_files').insert({
        organization_id: orgId, period_id: mayPeriodId, storage_path: 'x',
      });
    expect(sqlstate(error)).toBe('42501');
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
