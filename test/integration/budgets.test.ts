import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { permissionsFor } from '@/core/permissions';
import { toolNamed } from '@/modules/ai';
import { getBudgetView } from '@/modules/budgets';
import { startImport } from '@/modules/imports';
import { drainJobs } from '@/modules/jobs';
import type { AccessContext } from '@/modules/tenancy';
import { ensurePeriods, writeRecordStatusEvent } from '@/db/app/shared';
import { orgRow } from '@/db/schema';
import { clientFor, createAuthUser, drainUntilFinished, fs, rpc } from './setup';
import {
  addMember, dropFixtures, makeOrg, periodFor, queueCalculation, rowOf, rowsOf, seedBatch, seedDocument, seedLedgerEntry,
  systemAccount,
} from './f-fixtures';

/**
 * Budgets (ADR-142): a budget through the real import wizard and commit, set beside the engine's
 * actual figures, replaced month by month, rolled back, and read by the analyst's tool.
 * Every expected figure is worked by hand. Run-unique fixtures (ADR-052.12).
 */

const RUN = `b${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.budgets.itest.motion`;

let ownerId: string;
let clientId: string;
let strangerId: string;
let orgId: string;
let otherOrgId: string;
let september: string;
let october: string;

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
  const batch = (await rowOf(orgId, 'import_batches', batchId))!;
  const required = ((batch.required_confirmations as string[] | null | undefined) ?? []).filter(Boolean);
  for (const code of required) {
    const value = code === 'IMP-RANGE-015' ? { period_start: batch.period_start, period_end: batch.period_end } : { answer: 'yes' };
    const { error } = await rpc(ownerDb(), 'record_batch_confirmation', { p_batch: batchId, p_code: code, p_value: value });
    expect(error, `${code}: ${error?.message}`).toBeNull();
  }
  const { data, error } = await rpc(ownerDb(), 'commit_import_batch', { p_batch: batchId });
  expect(error, error?.message).toBeNull();
  return data as { status: string; committed: number; superseded: number };
}

beforeAll(async () => {
  ownerId = await createAuthUser(`owner@${DOMAIN}`);
  clientId = await createAuthUser(`client@${DOMAIN}`);
  strangerId = await createAuthUser(`stranger@${DOMAIN}`);
  orgId = await makeOrg(ownerId, `ITest Budgets ${RUN}`);
  otherOrgId = await makeOrg(strangerId, `ITest Budgets Other ${RUN}`);
  await addMember(orgId, clientId, 'client');
  september = await periodFor(orgId, '2026-09-01');
  october = await periodFor(orgId, '2026-10-01');

  // September's actuals: revenue 13,200, payroll 2,900 — a ledger declared for the month, calculated.
  const doc = await seedDocument(orgId, { filename: 'gl.csv', kind: 'general_ledger' });
  const batch = await seedBatch(orgId, {
    documentId: doc, importType: 'general_ledger', targetTable: 'ledger_entries', status: 'committed',
    periodStart: '2026-09-01', periodEnd: '2026-09-30',
  });
  for (const [category, direction, amount] of [['revenue', 'credit', '13200.00'], ['payroll', 'debit', '2900.00']] as const) {
    const id = await seedLedgerEntry(orgId, {
      accountId: await systemAccount(orgId, category), date: '2026-09-15', direction, amount, importBatchId: batch,
      sourceDocumentId: doc,
    });
    await fs().runTransaction(async (tx) => {
      writeRecordStatusEvent(tx, fs(), { orgId, table: 'ledger_entries', recordId: id, event: 'accepted', actorId: null });
    });
  }
  const job = await queueCalculation(orgId, { trigger: 'recalc_manual' });
  expect(await drainUntilFinished(drainJobs, job)).toBe('succeeded');
}, 180_000);

afterAll(async () => {
  await dropFixtures([orgId, otherOrgId], DOMAIN);
}, 60_000);

describe('a budget through the import wizard', () => {
  let firstBatch: string;

  it('uploads as a budget into budget_lines, reading year-month cells and the plan column', async () => {
    firstBatch = await importBudget(
      'Month,Account,Budget\n2026-09,Sales,12000.00\n2026-09,Salaries,3000.00\n2026-10,Sales,12500.00\n',
      '2026-09-01', '2026-10-31');
    const batch = (await rowOf(orgId, 'import_batches', firstBatch))!;
    expect(`${batch.import_type}:${batch.target_table}:${batch.status}`).toBe('budget:budget_lines:awaiting_review');
    expect((await rowOf(orgId, 'source_documents', String(batch.source_document_id)))?.document_kind).toBe('budget');
    // The months were read as the first of each month.
    const months = new Set((await rowsOf(orgId, 'import_rows', { batch_id: firstBatch }))
      .filter((r) => r.status === 'valid' || r.status === 'warning').map((r) => String(r.mapped_data?.period_start)));
    expect([...months].sort().join(',')).toBe('2026-09-01,2026-10-01');
  });

  it('commits one line per account and month, each assigned to its fiscal month', async () => {
    const result = await commit(firstBatch);
    expect(result).toMatchObject({ status: 'committed', committed: 3, superseded: 0 });
    expect(await rowsOf(orgId, 'budget_lines', { record_status: 'accepted', period_id: september })).toHaveLength(2);
    expect(await rowsOf(orgId, 'record_status_events', { record_table: 'budget_lines' })).toHaveLength(3);
  });

  it('sets the budget beside the month\'s actual figures', async () => {
    // The accounts were created from their names; their categories decide the lines. Make them
    // explicit so the expectation does not rest on the keyword guess.
    for (const [name, category, type] of [['Sales', 'revenue', 'income'], ['Salaries', 'payroll', 'expense']] as const) {
      for (const a of await rowsOf(orgId, 'accounts', { name })) {
        await orgRow(fs(), orgId, 'accounts', String(a.id)).update({ standard_category: category, account_type: type });
      }
    }
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
    const rows = (await rowsOf(orgId, 'import_rows', { batch_id: batch })).filter((r) => Number(r.row_number) > 1)
      .sort((a, b) => Number(a.row_number) - Number(b.row_number));
    expect(rows.map((r) => r.status).join(',')).toBe('valid,error');
    expect(JSON.stringify(rows.find((r) => r.status === 'error')?.issues)).toContain('IMP-BUD-001');
    await rpc(ownerDb(), 'reject_import_batch', { p_batch: batch, p_reason: 'test' });
  });

  describe('a revised budget for October', () => {
    let revision: string;

    it('replaces October only — the old line is superseded, not deleted', async () => {
      revision = await importBudget('Month,Account,Budget\n2026-10,Sales,14000.00\n', '2026-10-01', '2026-10-31');
      const result = await commit(revision);
      expect(result).toMatchObject({ committed: 1, superseded: 1 });
      expect((await rowsOf(orgId, 'budget_lines', { period_id: october, record_status: 'accepted', superseded_by: null })).map((r) => r.amount))
        .toEqual(['14000.00']);
      expect(await rowsOf(orgId, 'budget_lines', { period_id: september, record_status: 'accepted', superseded_by: null })).toHaveLength(2);
    });

    it('and rolling the revision back restores the earlier October budget', async () => {
      const { error } = await rpc(ownerDb(), 'rollback_import_batch', { p_batch: revision, p_reason: 'wrong file' });
      expect(error, error?.message).toBeNull();
      expect((await rowsOf(orgId, 'budget_lines', { period_id: october, record_status: 'accepted', superseded_by: null })).map((r) => r.amount))
        .toEqual(['12500.00']);
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

  // "No authenticated role can write a budget line directly" was a statement about SQL grants; the
  // browser cannot reach Firestore at all, and no `api.*` function writes a budget line outside an
  // import commit.
});

describe('the analyst reads budget against actual (tool 27)', () => {
  const getBudgetVariance = toolNamed('get_budget_variance')!;
  const call = (ctx: AccessContext, label: string) => ({
    ctx, now: new Date(), knownPeriods: [],
    periodContext: { default: { id: september, label }, mentioned: [], resolved: [], fiscalYearStartMonth: 1, latestComplete: null, notes: [] } as never,
  });

  it('returns each line with its actual snapshot, and the difference the service computed', async () => {
    const label = String((await rowOf(orgId, 'fiscal_periods', september))!.label);
    const outcome = await getBudgetVariance.run({}, call(contextFor(ownerId, 'owner'), label)) as { ok: true; data: { lines: Array<{ line: string; snapshot_id: string | null; difference: { value: string } | null }> } };
    expect(outcome.ok).toBe(true);
    const revenue = outcome.data.lines.find((l) => l.line === 'revenue')!;
    expect(revenue.snapshot_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(revenue.difference)).toContain('1200');
  });

  it('says plainly when no budget was imported for the month', async () => {
    await ensurePeriods(fs(), orgId, '2026-11-01', '2026-11-30');
    const november = await periodFor(orgId, '2026-11-01');
    const outcome = await getBudgetVariance.run({}, {
      ...call(contextFor(ownerId, 'owner'), 'Nov 2026'),
      periodContext: { default: { id: november, label: 'Nov 2026' }, mentioned: [], resolved: [], fiscalYearStartMonth: 1, latestComplete: null, notes: [] } as never,
    });
    expect(outcome).toMatchObject({ ok: false, error: { code: 'NO_DATA' } });
  });
});
