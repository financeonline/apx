import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { orgCollection, orgRow } from '@/db/schema';
import { clearTables, removeSeeded, seedBankAccount, seedBankTransaction, seedCounterparty, seedLedgerEntry, seedOrg, periodFor, setComplete } from '../fixtures/seed';
import { clientFor, fs, rpc, serviceClientScoped } from './setup';

/**
 * The calculation run's server surface (FINANCIAL_ENGINE.md §2.4; ADR-031, ADR-047.7/8), on the
 * Firestore emulator.
 *
 * The properties under test are the ones a wrong answer would hide rather than announce:
 *   - the aggregate counts only accepted, non-superseded records, and pins its read to an instant;
 *   - an unchanged fingerprint finishes the run without rewriting a thing;
 *   - the pointer rewrite RETIRES a dimension that has vanished, rather than leaving it pointing at
 *     a snapshot this run did not write;
 *   - a failed run puts back exactly the pointers it replaced.
 *
 * The engine surface is server-only (ADR-043): every call goes through a service handle scoped to
 * the organisation, as a job's `withOrgScope` builds it, and a user handle is refused.
 */

const RUN = `er${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.engine.itest.motion`;

let ownerId: string;
let orgId: string;
let periodMay: string;
let revenueAccount: string;
let payrollAccount: string;

const server = () => serviceClientScoped(orgId);
const call = async <T = unknown>(fn: string, args: Record<string, unknown>): Promise<T> => {
  const { data, error } = await rpc<T>(server(), fn, args, { server: true });
  if (error) throw error;
  return data as T;
};

beforeAll(async () => {
  const org = await seedOrg({ name: `ITest Engine ${RUN}`, ownerEmail: `owner@${DOMAIN}` });
  ownerId = org.ownerId;
  orgId = org.orgId;
  periodMay = await periodFor(orgId, '2026-05-01');
  revenueAccount = org.accounts.revenue!;
  payrollAccount = org.accounts.payroll!;
});

afterAll(async () => {
  await removeSeeded([orgId], DOMAIN);
});

beforeEach(async () => {
  await clearTables(orgId, ['metric_current', 'metric_snapshots', 'calculation_runs', 'ledger_entries', 'health_current', 'health_scores']);
});

const aggregate = (args: Record<string, unknown> = {}) => call<Array<Record<string, unknown>>>('aggregate_periods', {
  p_org: orgId, p_from: '2026-05-01', p_to: '2026-05-31', ...args,
});

describe('the L0 aggregation counts only what the engine may see (§1.3)', () => {
  it('sums accepted rows per period, category and account', async () => {
    await seedLedgerEntry(orgId, { date: '2026-05-10', accountId: revenueAccount, direction: 'credit', amount: '10000.00' });
    await seedLedgerEntry(orgId, { date: '2026-05-20', accountId: payrollAccount, direction: 'debit', amount: '4000.00' });

    const rows = (await aggregate()).filter((r) => r.source === 'ledger')
      .map((r) => `${r.standard_category}=${r.amount}`).sort().join(',');
    // Debit − credit, raw: the account-type sign rule is the engine's job, not the aggregate's.
    expect(rows).toBe('payroll=4000.00,revenue=-10000.00');
  });

  it('ignores a row that is not accepted', async () => {
    await seedLedgerEntry(orgId, {
      date: '2026-05-10', accountId: revenueAccount, direction: 'credit', amount: '500.00', recordStatus: 'pending',
    });
    expect(await aggregate(), 'a pending row is invisible to the engine').toHaveLength(0);
  });

  it('ignores a superseded row', async () => {
    const kept = await seedLedgerEntry(orgId, { date: '2026-05-10', accountId: revenueAccount, direction: 'credit', amount: '100.00' });
    await seedLedgerEntry(orgId, {
      date: '2026-05-11', accountId: revenueAccount, direction: 'credit', amount: '99999.00', supersededBy: kept,
    });
    const revenue = (await aggregate()).filter((r) => r.source === 'ledger' && r.standard_category === 'revenue');
    expect(revenue.map((r) => r.amount), 'the superseded 99,999 must not reach any figure').toEqual(['-100.00']);
  });

  it('pins its read to an instant, so a chunk can be reproduced later', async () => {
    await seedLedgerEntry(orgId, { date: '2026-05-10', accountId: revenueAccount, direction: 'credit', amount: '100.00' });
    const now = await aggregate();
    const before = await aggregate({ p_aggregated_at: new Date(Date.now() - 86_400_000).toISOString() });
    expect(now.length).toBeGreaterThan(0);
    expect(before, 'an earlier instant sees the data that existed then').toHaveLength(0);
  });

  it('is not reachable by a signed-in user', async () => {
    // The aggregate reads every record in the organisation regardless of the read policies.
    const { error } = await rpc(clientFor(ownerId), 'aggregate_periods', {
      p_org: orgId, p_from: '2026-05-01', p_to: '2026-05-31',
    }, { server: true });
    expect(error?.code).toBe('PERMISSION_DENIED');
  });
});

const startArgs = (fingerprint: string, trigger = 'import_commit') => ({
  p_org: orgId, p_trigger: trigger, p_trigger_ref: null, p_engine_version: '1.0.0',
  p_period_from: periodMay, p_period_to: periodMay, p_as_of: '2026-06-15', p_fingerprint: fingerprint,
  p_job: null, p_periods_total: 1,
});

type Started = { runId: string; noChange: boolean };

describe('a run that has nothing to do does nothing (ADR-047.8)', () => {
  it('finishes immediately when the fingerprint is unchanged', async () => {
    const first = await call<Started>('start_calculation_run', startArgs('abcd'));
    expect(first.noChange).toBe(false);
    await call('finish_calculation_run', { p_org: orgId, p_run: first.runId, p_status: 'succeeded' });

    const second = await call<Started>('start_calculation_run', startArgs('abcd'));
    expect(second.noChange, 'nothing the engine reads has changed').toBe(true);

    const run = (await orgRow(fs(), orgId, 'calculation_runs', second.runId).get()).data()!;
    expect(run.stats).toEqual({ no_change: true });
    expect(run.status).toBe('succeeded');
  });

  it('but a human asking for a recalculation always gets one', async () => {
    const first = await call<Started>('start_calculation_run', startArgs('beef'));
    await call('finish_calculation_run', { p_org: orgId, p_run: first.runId, p_status: 'succeeded' });
    const manual = await call<Started>('start_calculation_run', startArgs('beef', 'recalc_manual'));
    expect(manual.noChange).toBe(false);
  });

  it('refuses a trigger reference the trigger cannot name, and a scope that is not the organisation', async () => {
    const named = await rpc(server(), 'start_calculation_run', {
      ...startArgs('cafe', 'recalc_manual'), p_trigger_ref: periodMay,
    }, { server: true });
    expect(named.error?.code, 'recalc_manual names no row').toBe('VALIDATION');
    const missing = await rpc(server(), 'start_calculation_run', {
      ...startArgs('cafe', 'import_commit'), p_trigger_ref: '00000000-0000-4000-8000-000000000001',
    }, { server: true });
    expect(missing.error?.code, 'an import batch that does not exist').toBe('VALIDATION');
    const elsewhere = await rpc(serviceClientScoped('00000000-0000-4000-8000-00000000abcd'), 'start_calculation_run', startArgs('cafe'), { server: true });
    expect(elsewhere.error?.code).toBe('PERMISSION_DENIED');
  });
});

const snapshot = (key: string, value: string | null) => ({
  period_id: periodMay, metric_key: key, dimension_type: 'none', dimension_id: null, value, unit: 'money',
  currency: 'GBP', basis: 'ledger', assurance_level: 'calculated',
  data_quality: { completeness: 1, proxy: false, warnings: [], missing: [] }, components: {}, evidence_query: null,
});

/** A category-dimensioned snapshot: `dimension_key`, never `dimension_id` (ADR-053). */
const categorySnapshot = (category: string, value: string) => ({
  ...snapshot('expense_by_category', value), dimension_type: 'standard_category', dimension_key: category,
});

async function startRun(fingerprint: string): Promise<string> {
  return (await call<Started>('start_calculation_run', startArgs(fingerprint, 'recalc_manual'))).runId;
}

async function writeChunk(runId: string, snapshots: unknown[]): Promise<void> {
  await call('finish_chunk', {
    p_org: orgId, p_run: runId, p_snapshots: snapshots, p_period_ids: [periodMay],
    p_aggregated_at: new Date().toISOString(), p_cursor: periodMay, p_as_of_keys: null,
  });
}

const finish = (runId: string, status: 'succeeded' | 'failed') =>
  call('finish_calculation_run', { p_org: orgId, p_run: runId, p_status: status });

async function pointers(): Promise<Array<Record<string, unknown>>> {
  return (await orgCollection(fs(), orgId, 'metric_current').get()).docs.map((d) => d.data());
}

async function valueOf(snapshotId: unknown): Promise<string> {
  return String((await orgRow(fs(), orgId, 'metric_snapshots', String(snapshotId)).get()).get('value'));
}

describe('the pointer rewrite (§2.4 step 8, F-B-16)', () => {
  it('names the current snapshot for every metric it wrote', async () => {
    const runId = await startRun('a1a1');
    await writeChunk(runId, [snapshot('revenue', '10000.00'), snapshot('net_profit', '2000.00')]);
    expect((await pointers()).map((p) => p.metric_key).sort()).toEqual(['net_profit', 'revenue']);
  });

  it('retires a dimension the new run no longer produces', async () => {
    const first = await startRun('a1a1');
    await writeChunk(first, [snapshot('revenue', '10000.00'), snapshot('expense_by_category', '500.00')]);
    await finish(first, 'succeeded');

    const second = await startRun('b2b2');
    await writeChunk(second, [snapshot('revenue', '12000.00')]);

    const now = await pointers();
    expect(now.map((p) => p.metric_key), 'the vanished category must not linger').toEqual(['revenue']);
    expect(await valueOf(now[0]!.snapshot_id)).toBe('12000.000000');
  });

  it('records what each pointer replaced, so a failure can put it back', async () => {
    const first = await startRun('a1a1');
    await writeChunk(first, [snapshot('revenue', '10000.00')]);
    await finish(first, 'succeeded');

    const second = await startRun('b2b2');
    await writeChunk(second, [snapshot('revenue', '99999.00')]);
    expect((await pointers())[0]!.previous_snapshot_id).not.toBeNull();
  });

  it('names, per cell, the NEWEST earlier run\'s snapshot as the one each pointer replaced', async () => {
    const customer = await seedCounterparty(orgId, { name: `Pointer Customer A ${RUN}` });
    const other = await seedCounterparty(orgId, { name: `Pointer Customer B ${RUN}` });
    const id = (n: number) => `00000000-0000-4000-8000-${RUN.slice(-4).replace(/[^0-9a-f]/g, '0').padStart(4, '0')}${String(n).padStart(8, '0')}`;
    const counterpartySnapshot = (counterpartyId: string, value: string) => ({
      ...snapshot('customer_revenue', value), dimension_type: 'counterparty', dimension_id: counterpartyId,
    });
    const withId = <T extends object>(n: number, s: T) => ({ ...s, id: id(n) });

    const first = await startRun('d1d1');
    await writeChunk(first, [
      withId(101, snapshot('revenue', '100.00')),
      withId(102, categorySnapshot('marketing', '10.00')),
      withId(103, counterpartySnapshot(customer, '60.00')),
    ]);
    await finish(first, 'succeeded');

    const second = await startRun('d2d2');
    await writeChunk(second, [
      withId(201, snapshot('revenue', '200.00')),
      withId(202, categorySnapshot('rent', '20.00')),
      withId(203, counterpartySnapshot(other, '70.00')),
    ]);
    await finish(second, 'succeeded');

    const third = await startRun('d3d3');
    await writeChunk(third, [
      withId(301, snapshot('revenue', '300.00')),
      withId(302, categorySnapshot('marketing', '30.00')),
      withId(303, categorySnapshot('rent', '31.00')),
      withId(304, counterpartySnapshot(customer, '80.00')),
      withId(305, counterpartySnapshot(other, '90.00')),
      withId(306, categorySnapshot('software', '5.00')),
    ]);

    const replaced = (await pointers())
      .map((c) => `${c.snapshot_id}>${c.previous_snapshot_id ?? 'none'}`).sort();
    expect(replaced).toEqual([
      `${id(301)}>${id(201)}`, // revenue: the newest earlier run (second), not the first
      `${id(302)}>${id(102)}`, // marketing: only the first run wrote it — by key, not any category
      `${id(303)}>${id(202)}`, // rent: the second run
      `${id(304)}>${id(103)}`, // the customer: by dimension_id, not the other customer's newer row
      `${id(305)}>${id(203)}`, // the other customer
      `${id(306)}>none`,       // a category no earlier run wrote
    ]);
  });

  it('refuses a dimension that names no row of the organisation', async () => {
    const runId = await startRun('e1e1');
    const { error } = await rpc(server(), 'finish_chunk', {
      p_org: orgId, p_run: runId, p_period_ids: [periodMay], p_aggregated_at: new Date().toISOString(), p_cursor: periodMay,
      p_snapshots: [{ ...snapshot('customer_revenue', '1.00'), dimension_type: 'counterparty', dimension_id: '00000000-0000-4000-8000-0000000000ff' }],
    }, { server: true });
    expect(error?.code).toBe('VALIDATION');
  });

  it('restores category-dimensioned pointers with their categories intact (ADR-055.1)', async () => {
    const first = await startRun('a1a1');
    await writeChunk(first, [
      categorySnapshot('marketing', '3000.00'), categorySnapshot('payroll', '18000.00'), categorySnapshot('software', '450.00'),
    ]);
    await finish(first, 'succeeded');

    const second = await startRun('b2b2');
    await writeChunk(second, [
      categorySnapshot('marketing', '9000.00'), categorySnapshot('payroll', '19000.00'), categorySnapshot('software', '460.00'),
    ]);
    await finish(second, 'failed');

    const restored: string[] = [];
    for (const c of (await pointers()).filter((p) => p.metric_key === 'expense_by_category')) {
      restored.push(`${c.dimension_key}=${await valueOf(c.snapshot_id)}`);
    }
    expect(restored.sort()).toEqual(['marketing=3000.000000', 'payroll=18000.000000', 'software=450.000000']);
  });

  it('restores the previous pointers when a run fails (§2.4 step 12)', async () => {
    const first = await startRun('a1a1');
    await writeChunk(first, [snapshot('revenue', '10000.00')]);
    await finish(first, 'succeeded');

    const second = await startRun('b2b2');
    await writeChunk(second, [snapshot('revenue', '99999.00')]);
    await finish(second, 'failed');

    const revenue = (await pointers()).find((p) => p.metric_key === 'revenue')!;
    // A reader must never see this month from a failed run and last month from the previous one.
    expect(await valueOf(revenue.snapshot_id), 'the failed run\'s figure must not stand').toBe('10000.000000');
    const run = (await orgRow(fs(), orgId, 'calculation_runs', second).get()).data()!;
    expect(`${run.status}|${run.failure_reason ?? '-'}`).toBe('failed|error');
  });

  it('is idempotent when a chunk is retried', async () => {
    // A worker that died after writing half a chunk must not double it on the next attempt.
    const runId = await startRun('a1a1');
    await writeChunk(runId, [snapshot('revenue', '10000.00')]);
    await writeChunk(runId, [snapshot('revenue', '10000.00')]);
    const mine = await orgCollection(fs(), orgId, 'metric_snapshots').where('calculation_run_id', '==', runId).get();
    expect(mine.size).toBe(1);
    const run = (await orgRow(fs(), orgId, 'calculation_runs', runId).get()).data()!;
    expect(run.chunks).toHaveLength(2);
    expect(run.progress).toEqual({ periods_done: 2, periods_total: 1 });
  });

  it('keeps snapshots append-only even for the engine', async () => {
    // Nothing offers an update of a snapshot; the only rewrite is a RUNNING run redoing its own
    // chunk. Once the run has finished, its figures can no longer be replaced.
    const runId = await startRun('a1a1');
    await writeChunk(runId, [snapshot('revenue', '10000.00')]);
    await finish(runId, 'succeeded');
    const { error } = await rpc(server(), 'finish_chunk', {
      p_org: orgId, p_run: runId, p_snapshots: [snapshot('revenue', '1')], p_period_ids: [periodMay],
      p_aggregated_at: new Date().toISOString(), p_cursor: periodMay,
    }, { server: true });
    expect(error?.code, 'a finished run is not running').toBe('CONFLICT');
    const values = (await orgCollection(fs(), orgId, 'metric_snapshots').get()).docs.map((d) => d.get('value'));
    expect(values).toEqual(['10000.000000']);
  });
});

describe('a run marks its periods complete (ADR-030.1)', () => {
  it('sets is_complete only where the engine says so', async () => {
    await setComplete(orgId, ['2026-05-01'], false);
    await call('set_period_completeness', { p_org: orgId, p_periods: [periodMay], p_complete: [true] });
    expect((await orgRow(fs(), orgId, 'fiscal_periods', periodMay).get()).get('is_complete')).toBe(true);
  });

  it('is not reachable by a signed-in user', async () => {
    const { error } = await rpc(clientFor(ownerId), 'set_period_completeness', {
      p_org: orgId, p_periods: [periodMay], p_complete: [true],
    }, { server: true });
    expect(error?.code).toBe('PERMISSION_DENIED');
  });
});

describe('the Health score of a run (ADR-030.4, ADR-051)', () => {
  const score = (value: number) => ({
    period_id: periodMay, score: value, dimensions_used: 3, dimensions_total: 6, breakdown: [], config_version: 'health.config.v5',
    evidence: [{ item_type: 'calculation_run', ref_id: null, label: 'The run', assurance_level: 'calculated' }],
  });

  it('refuses a score for an incomplete period, and points health_current at the new score', async () => {
    const runId = await startRun('f1f1');
    await setComplete(orgId, ['2026-05-01'], false);
    const refused = await rpc(server(), 'finish_health', { p_org: orgId, p_run: runId, p_scores: [score(70)], p_period_ids: [periodMay] }, { server: true });
    expect(refused.error?.code).toBe('CONFLICT');

    await setComplete(orgId, ['2026-05-01'], true);
    expect(await call('finish_health', { p_org: orgId, p_run: runId, p_scores: [score(70)], p_period_ids: [periodMay] })).toBe(1);
    // A retried chunk replaces the run's own score rather than adding a second.
    expect(await call('finish_health', { p_org: orgId, p_run: runId, p_scores: [score(71)], p_period_ids: [periodMay] })).toBe(1);
    const scores = await orgCollection(fs(), orgId, 'health_scores').where('calculation_run_id', '==', runId).get();
    expect(scores.docs.map((d) => d.get('score'))).toEqual([71]);
    const current = (await orgRow(fs(), orgId, 'health_current', periodMay).get()).data()!;
    expect(current.health_score_id).toBe(scores.docs[0]!.id);

    // An incomplete period's shown score is withdrawn (FU-14).
    await call('set_period_completeness', { p_org: orgId, p_periods: [periodMay], p_complete: [false] });
    expect((await orgRow(fs(), orgId, 'health_current', periodMay).get()).exists).toBe(false);
  });
});

describe('the banking pass (ADR-101)', () => {
  it('categorises undecided rows only, and derives a transfer\'s kind', async () => {
    const current = await seedBankAccount(orgId, { name: `Current ${RUN}`, accountType: 'current' });
    const card = await seedBankAccount(orgId, { name: `Card ${RUN}`, accountType: 'credit_card' });
    const rule = await seedBankTransaction(orgId, { bankAccountId: current, date: '2026-05-03', amount: '-12.00', description: 'coffee' });
    const decided = await seedBankTransaction(orgId, {
      bankAccountId: current, date: '2026-05-04', amount: '-20.00', categorySource: 'user', categoryAccountId: payrollAccount,
    });
    const out = await seedBankTransaction(orgId, { bankAccountId: current, date: '2026-05-05', amount: '-300.00' });
    const inn = await seedBankTransaction(orgId, { bankAccountId: card, date: '2026-05-05', amount: '300.00' });
    const runId = await startRun('a7a7');

    const counts = await call<Record<string, number>>('apply_banking_pass', {
      p_org: orgId, p_run: runId, p_plan: {
        categorisations: [
          { transactionId: rule, categoryAccountId: revenueAccount, categorySource: 'rule' },
          { transactionId: decided, categoryAccountId: revenueAccount, categorySource: 'rule' },
        ],
        pairs: [{ outflowTransactionId: out, inflowTransactionId: inn, kind: 'cash_transfer' }],
        groups: [], versions: { detector: 'test' },
      },
    });
    expect(counts).toMatchObject({ categorised: 1, paired: 1, groups: 0 });
    const row = async (id: string) => (await orgRow(fs(), orgId, 'bank_transactions', id).get()).data()!;
    expect((await row(rule)).category_account_id).toBe(revenueAccount);
    expect((await row(decided)).category_account_id, 'a person\'s decision stands').toBe(payrollAccount);
    expect((await row(out)).transfer_kind, 'the kind comes from the accounts, not the plan').toBe('card_repayment');
    const history = await orgCollection(fs(), orgId, 'category_history').where('bank_transaction_id', '==', rule).get();
    expect(history.docs.filter((d) => d.get('valid_to') === null)).toHaveLength(1);
    expect(history.size).toBe(2);
  });
});

describe('a metric\'s evidence bundle (EVIDENCE_MODEL.md §9, ADR-066)', () => {
  it('is built once, from items derivable from the snapshot only', async () => {
    const runId = await startRun('b7b7');
    const id = '00000000-0000-4000-8000-00000000b7b7';
    const descriptor = { v: 1, table: 'ledger_entries', filters: { period_id: periodMay }, order: [{ field: 'id', dir: 'asc' }] };
    await writeChunk(runId, [{ ...snapshot('revenue', '5.00'), id, evidence_query: { kind: 'leaf', descriptor } }]);
    const build = (items: unknown[]) => rpc<string>(serviceClientScoped(), 'build_metric_bundle_as', {
      p_actor: ownerId, p_snapshot: id, p_items: items,
    }, { server: true });

    const foreign = await build([{ item_type: 'calculation_run', ref_id: '00000000-0000-4000-8000-000000000123', label: 'x', assurance_level: 'calculated' }]);
    expect(foreign.error?.code, 'not the run that produced this figure').toBe('VALIDATION');
    const strangerQuery = await build([{
      item_type: 'query', query_descriptor: { ...descriptor, table: 'invoices' }, descriptor_hash: 'abcd', label: 'q', assurance_level: 'calculated',
    }]);
    expect(strangerQuery.error?.code).toBe('VALIDATION');

    const first = await build([
      { item_type: 'calculation_run', ref_id: runId, label: 'The run', assurance_level: 'calculated' },
      { item_type: 'query', query_descriptor: { ...descriptor, order: undefined }, descriptor_hash: 'ABCD', label: 'The rows', assurance_level: 'verified' },
    ]);
    expect(first.error).toBeNull();
    const again = await build([{ item_type: 'calculation_run', ref_id: runId, label: 'The run', assurance_level: 'calculated' }]);
    expect(again.data, 'the existing bundle is returned').toBe(first.data);
    const items = await orgCollection(fs(), orgId, 'evidence_items').where('bundle_id', '==', first.data).get();
    expect(items.docs.map((d) => d.get('descriptor_hash')).sort()).toEqual(['abcd', null]);

    const stranger = await rpc(serviceClientScoped(), 'build_metric_bundle_as', {
      p_actor: '00000000-0000-4000-8000-0000000000aa', p_snapshot: id, p_items: [],
    }, { server: true });
    expect(stranger.error?.code).toBe('NOT_FOUND');
  });
});
