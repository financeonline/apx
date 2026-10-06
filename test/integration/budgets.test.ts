import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { permissionsFor } from '@/core/permissions';
import { toolNamed } from '@/modules/ai';
import { getBudgetView } from '@/modules/budgets';
import { startImport } from '@/modules/imports';
import { drainJobs } from '@/modules/jobs';
import type { AccessContext } from '@/modules/tenancy';
import { adminSql, clientFor, createAuthUser, drainUntilFinished } from './setup';

/**
 * Budgets (ADR-142): a budget through the real import wizard and commit, set beside the engine's
 * actual figures, replaced month by month, rolled back, and read by the analyst's tool.
 * Every expected figure is worked by hand. Run-unique fixtures (ADR-052.12).
 */

const RUN = `b${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.budgets.itest`;

let ownerId: string;
let clientId: string;
let strangerId: string;
let orgId: string;
let otherOrgId: string;
let september: string;
let october: string;

const one = (sql: string): string => adminSql(`with q as (${sql}) select * from q`);
const ownerDb = () => clientFor(ownerId, { email: `owner@${DOMAIN}` });

function contextFor(userId: string, role: 'owner' | 'client', org = orgId): AccessContext {
  return {
    userId, orgId: org, orgSlug: 'budgets', effectiveRole: role, permissions: permissionsFor(role),
    actorType: 'user', db: clientFor(userId, { email: `${role}@${DOMAIN}` }),
    requestId: `itest-${RUN}`, now: () => new Date(), organizationStatus: 'active',
  };
}

async function importBudget(csv: string, from: string, to: string): Promise<string> {
  const result = await startImport({
    organizationId: orgId, userId: ownerId, requestId: `itest-${RUN}`, db: ownerDb(),
    file: new File([csv], 'budget.csv', { type: 'text/csv' }),
    importType: 'budget', periodStart: from, periodEnd: to, bankAccountId: null,
  });
  return result.batchId;
}

async function commit(batchId: string): Promise<{ status: string; committed: number; superseded: number }> {
  const required = adminSql(`
    select coalesce(string_agg(c, ','), '') from public.import_batches b, unnest(b.required_confirmations) c
     where b.organization_id = '${orgId}' and b.id = '${batchId}'`).split(',').filter(Boolean);
  for (const code of required) {
    const range = one(`select period_start || '|' || period_end from public.import_batches where id = '${batchId}'`).split('|');
    const value = code === 'IMP-RANGE-015' ? { period_start: range[0], period_end: range[1] } : { answer: 'yes' };
    const { error } = await ownerDb().schema('api').rpc('record_batch_confirmation', { p_batch: batchId, p_code: code, p_value: value });
    expect(error, `${code}: ${error?.message}`).toBeNull();
  }
  const { data, error } = await ownerDb().schema('api').rpc('commit_import_batch', { p_batch: batchId });
  expect(error, error?.message).toBeNull();
  return data as { status: string; committed: number; superseded: number };
}

beforeAll(async () => {
  ownerId = createAuthUser(`owner@${DOMAIN}`);
  clientId = createAuthUser(`client@${DOMAIN}`);
  strangerId = createAuthUser(`stranger@${DOMAIN}`);
  const created = await clientFor(ownerId).schema('api').rpc('create_organization', { p_name: `ITest Budgets ${RUN}` });
  if (created.error) throw new Error(created.error.message);
  orgId = created.data as unknown as string;
  const other = await clientFor(strangerId).schema('api').rpc('create_organization', { p_name: `ITest Budgets Other ${RUN}` });
  otherOrgId = other.data as unknown as string;
  adminSql(`
    insert into public.organization_memberships (organization_id, user_id, role, status) values ('${orgId}', '${clientId}', 'client', 'active');
    select app.ensure_periods('${orgId}', '2026-09-01', '2026-10-31');`);
  september = one(`select id from public.fiscal_periods where organization_id = '${orgId}' and period_start = '2026-09-01'`);
  october = one(`select id from public.fiscal_periods where organization_id = '${orgId}' and period_start = '2026-10-01'`);

  // September's actuals: revenue 13,200, payroll 2,900 — a ledger declared for the month, calculated.
  const account = (category: string) => one(`select id from public.accounts where organization_id = '${orgId}' and standard_category = '${category}' and is_system`);
  for (const [category, direction, amount] of [['revenue', 'credit', '13200.00'], ['payroll', 'debit', '2900.00']] as const) {
    const id = one(`insert into public.ledger_entries (organization_id, entry_date, account_id, direction, amount, period_id, record_status)
                    values ('${orgId}', '2026-09-15', '${account(category)}', '${direction}', ${amount}, '00000000-0000-0000-0000-000000000000', 'accepted') returning id`);
    adminSql(`insert into public.record_status_events (organization_id, record_table, record_id, event) values ('${orgId}', 'ledger_entries', '${id}', 'accepted')`);
  }
  const doc = one(`insert into public.source_documents (organization_id, storage_path, original_filename, mime_type, byte_size, sha256, status, document_kind)
                   values ('${orgId}', '${orgId}/b/gl.csv', 'gl.csv', 'text/csv', 10, decode('e5','hex'), 'ready', 'general_ledger') returning id`);
  adminSql(`insert into public.import_batches (organization_id, source_document_id, import_type, target_table, status, extraction_method, period_start, period_end, committed_at)
            values ('${orgId}', '${doc}', 'general_ledger', 'ledger_entries', 'committed', 'csv', '2026-09-01', '2026-09-30', now())`);
  const job = adminSql(`insert into public.jobs (organization_id, job_type, payload, max_attempts)
                        values ('${orgId}', 'calculation.run', '{"trigger":"recalc_manual"}'::jsonb, 3) returning id`).split('\n')[0]!.trim();
  expect(await drainUntilFinished(drainJobs, job)).toBe('succeeded');
});

afterAll(() => {
  adminSql(`
    select set_config('app.purge', 'on', false);
    delete from public.organizations where name like 'ITest Budgets%${RUN}';
    delete from auth.users where email like '%@${DOMAIN}';`);
});

describe('a budget through the import wizard', () => {
  let firstBatch: string;

  it('uploads as a budget into budget_lines, reading year-month cells and the plan column', async () => {
    firstBatch = await importBudget(
      'Month,Account,Budget\n2026-09,Sales,12000.00\n2026-09,Salaries,3000.00\n2026-10,Sales,12500.00\n',
      '2026-09-01', '2026-10-31');
    expect(one(`select import_type || ':' || target_table || ':' || status from public.import_batches where id = '${firstBatch}'`))
      .toBe('budget:budget_lines:awaiting_review');
    expect(one(`select document_kind::text from public.source_documents d join public.import_batches b on b.source_document_id = d.id where b.id = '${firstBatch}'`)).toBe('budget');
    // The months were read as the first of each month.
    expect(one(`select string_agg(distinct mapped_data ->> 'period_start', ',' order by mapped_data ->> 'period_start') from public.import_rows where batch_id = '${firstBatch}' and status in ('valid','warning')`))
      .toBe('2026-09-01,2026-10-01');
  });

  it('commits one line per account and month, each assigned to its fiscal month', async () => {
    const result = await commit(firstBatch);
    expect(result).toMatchObject({ status: 'committed', committed: 3, superseded: 0 });
    expect(one(`select count(*) from public.budget_lines where organization_id = '${orgId}' and record_status = 'accepted' and period_id = '${september}'`)).toBe('2');
    expect(one(`select count(*) from public.record_status_events where organization_id = '${orgId}' and record_table = 'budget_lines'`)).toBe('3');
  });

  it('sets the budget beside the month\'s actual figures', async () => {
    // The accounts were created from their names; their categories decide the lines. Make them
    // explicit so the expectation does not rest on the keyword guess.
    adminSql(`
      update public.accounts set standard_category = 'revenue' where organization_id = '${orgId}' and name = 'Sales';
      update public.accounts set standard_category = 'payroll' where organization_id = '${orgId}' and name = 'Salaries';`);
    const view = await getBudgetView(contextFor(ownerId, 'owner'), september);
    const row = (key: string) => view.variance?.rows.find((r) => r.key === key);
    // Revenue: actual 13,200 − budget 12,000 = +1,200, favourable.
    expect(row('revenue')).toMatchObject({ budget: '12000.00', actual: '13200.00', variance: '1200.00', favourable: true });
    // Payroll: 2,900 − 3,000 = −100, favourable for a cost.
    expect(row('payroll')).toMatchObject({ budget: '3000.00', actual: '2900.00', variance: '-100.00', favourable: true });
    expect(view.months.map((m) => m.id)).toEqual(expect.arrayContaining([september, october]));
  });

  it('refuses two lines for one account and month in a file, rather than adding them up', async () => {
    const batch = await importBudget('Month,Account,Budget\n2026-10,Sales,100.00\n2026-10,Sales,200.00\n', '2026-10-01', '2026-10-31');
    expect(one(`select string_agg(status::text, ',' order by row_number) from public.import_rows where batch_id = '${batch}' and row_number > 1`))
      .toBe('valid,error');
    expect(one(`select issues::text from public.import_rows where batch_id = '${batch}' and status = 'error'`)).toContain('IMP-BUD-001');
    await ownerDb().schema('api').rpc('reject_import_batch', { p_batch: batch, p_reason: 'test' });
  });

  describe('a revised budget for October', () => {
    let revision: string;

    it('replaces October only — the old line is superseded, not deleted', async () => {
      revision = await importBudget('Month,Account,Budget\n2026-10,Sales,14000.00\n', '2026-10-01', '2026-10-31');
      const result = await commit(revision);
      expect(result).toMatchObject({ committed: 1, superseded: 1 });
      expect(one(`select amount::text from public.budget_lines where organization_id = '${orgId}' and period_id = '${october}' and record_status = 'accepted' and superseded_by is null`)).toBe('14000.00');
      expect(one(`select count(*) from public.budget_lines where organization_id = '${orgId}' and period_id = '${september}' and superseded_by is null and record_status = 'accepted'`)).toBe('2');
    });

    it('and rolling the revision back restores the earlier October budget', async () => {
      const { error } = await ownerDb().schema('api').rpc('rollback_import_batch', { p_batch: revision, p_reason: 'wrong file' });
      expect(error, error?.message).toBeNull();
      expect(one(`select amount::text from public.budget_lines where organization_id = '${orgId}' and period_id = '${october}' and record_status = 'accepted' and superseded_by is null`)).toBe('12500.00');
    });
  });
});

describe('who may see a budget', () => {
  it('a client reads it, as they read the profit and loss', async () => {
    const view = await getBudgetView(contextFor(clientId, 'client'), september);
    expect(view.variance?.rows.length).toBeGreaterThan(0);
  });

  it('another organisation sees no budget of this one, and its month id is not found', async () => {
    await expect(getBudgetView(contextFor(strangerId, 'owner', otherOrgId), september)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('no authenticated role can write a budget line directly', async () => {
    const { error } = await ownerDb().from('budget_lines').insert({ organization_id: orgId, period_start: '2026-09-01', account_id: orgId, amount: 1 });
    expect(error).not.toBeNull();
  });
});

describe('the analyst reads budget against actual (tool 27)', () => {
  const getBudgetVariance = toolNamed('get_budget_variance')!;
  const call = (ctx: AccessContext, label: string) => ({
    ctx, now: new Date(), knownPeriods: [],
    periodContext: { default: { id: september, label }, mentioned: [], resolved: [], fiscalYearStartMonth: 1, latestComplete: null, notes: [] } as never,
  });

  it('returns each line with its actual snapshot, and the difference the service computed', async () => {
    const label = one(`select label from public.fiscal_periods where id = '${september}'`);
    const outcome = await getBudgetVariance.run({}, call(contextFor(ownerId, 'owner'), label)) as { ok: true; data: { lines: Array<{ line: string; snapshot_id: string | null; difference: { value: string } | null }> } };
    expect(outcome.ok).toBe(true);
    const revenue = outcome.data.lines.find((l) => l.line === 'revenue')!;
    expect(revenue.snapshot_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(revenue.difference)).toContain('1200');
  });

  it('says plainly when no budget was imported for the month', async () => {
    adminSql(`select app.ensure_periods('${orgId}', '2026-11-01', '2026-11-30')`);
    const november = one(`select id from public.fiscal_periods where organization_id = '${orgId}' and period_start = '2026-11-01'`);
    const outcome = await getBudgetVariance.run({}, {
      ...call(contextFor(ownerId, 'owner'), 'Nov 2026'),
      periodContext: { default: { id: november, label: 'Nov 2026' }, mentioned: [], resolved: [], fiscalYearStartMonth: 1, latestComplete: null, notes: [] } as never,
    });
    expect(outcome).toMatchObject({ ok: false, error: { code: 'NO_DATA' } });
  });
});
