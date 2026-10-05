import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  composePeriod, computeCoverage, ENGINE_VERSION,
  type AccountRef, type AggregateCell, type BankAccountRef, type EngineContext,
  type MetricResult, type PeriodRef,
} from '@/modules/financial-engine';

/**
 * Determinism, in the two places it can break silently (FINANCIAL_ENGINE.md §1.1, §2.4 step 4).
 *
 * The engine's whole claim is that identical inputs produce byte-identical snapshots. The failure it
 * cannot survive is not a wrong number — a wrong number gets disputed — but the SAME data producing
 * a different answer on a second run, because then nothing on the screen can be trusted and nothing
 * can be reproduced.
 *
 * Two mechanisms are pinned here, both found by an intermittent failure of `evidence-drawer` in
 * which `cost_of_sales` sometimes wrote a leaf descriptor and sometimes wrote none, over one fixed
 * fixture:
 *
 *   1. The instant a run aggregates as of. It filters `created_at`, which Postgres stamps, so
 *      reading it from the worker's clock decides which rows exist by comparing two clocks.
 *   2. The composition itself, including ADR-059's two passes, which must differ in ids and in
 *      nothing else.
 *
 * The shape of `cost_of_sales`'s evidence is pinned alongside them, because it is the thing that
 * moved: it is legitimately a function of the chart of accounts (CD-05), and a function of the chart
 * is only a defensible contract if the chart is the ONLY thing it is a function of.
 */

// ---------------------------------------------------------------------------------------------
// The fixture: one May, a ledger basis, four accounts.
// ---------------------------------------------------------------------------------------------

const may: PeriodRef = {
  id: 'p-may', periodStart: '2026-05-01', periodEnd: '2026-05-31',
  fiscalYear: 2026, fiscalQuarter: 2, label: 'May 2026', isComplete: false,
};

const account = (
  id: string,
  category: AccountRef['standardCategory'],
  type: AccountRef['accountType'],
  isSystem = true,
): AccountRef => ({
  id, code: null, name: id, standardCategory: category, accountType: type, isSystem,
});

const ACCOUNTS: AccountRef[] = [
  account('a-rev', 'revenue', 'income'),
  account('a-cos', 'cost_of_sales', 'expense'),
  account('a-pay', 'payroll', 'expense'),
  // The customer's own account, left where a fresh insert leaves it: `mapping_confidence` is
  // `unmapped` until `api.remap_account` confirms it, so it carries no category of its own.
  account('a-unmapped', 'uncategorised', 'expense', false),
];

const context = (over: Partial<EngineContext> = {}): EngineContext => ({
  organizationId: 'org-1',
  calculationRunId: 'run-1',
  aggregatedAt: '2026-06-01T00:00:00.000Z',
  asOf: '2026-06-15',
  engineVersion: ENGINE_VERSION,
  settings: {
    baseCurrency: 'GBP', fiscalYearStartMonth: 1, timezone: 'Europe/London',
    vatRegistered: false, defaultVatRate: null,
    taxableCategories: ['revenue', 'cost_of_sales', 'operating_expense', 'marketing'],
  },
  costOfSalesEverUsed: true,
  costOfSalesInInvoices: false,
  accounts: ACCOUNTS,
  counterparties: [],
  bankAccounts: [],
  periods: [may],
  ...over,
});

const ledgerCell = (
  accountId: string, category: AggregateCell['standardCategory'],
  debit: string, credit: string,
): AggregateCell => ({
  periodId: may.id, source: 'ledger', standardCategory: category, accountId,
  counterpartyId: null, bankAccountId: null, balanceKind: null, balanceBasis: null,
  invoiceType: null, transferKind: null, unpairedTransferCandidate: false,
  debit, credit, amount: String(Number(debit) - Number(credit)), fallbackRows: 0,
  rowCount: 1, minDate: '2026-05-01', maxDate: '2026-05-31',
});

/** The four entries the evidence suite seeds: 20,000 + 5,000 revenue, 6,000 cost, 5,000 payroll. */
const WHOLE_MONTH: AggregateCell[] = [
  ledgerCell('a-rev', 'revenue', '0', '25000.00'),
  ledgerCell('a-cos', 'cost_of_sales', '6000.00', '0'),
  ledgerCell('a-pay', 'payroll', '5000.00', '0'),
];

/**
 * The same month as a run would see it if the aggregate's `created_at` cutoff fell between the first
 * entry and the second: the later three rows are simply not there.
 */
const TRUNCATED_MONTH: AggregateCell[] = [ledgerCell('a-rev', 'revenue', '0', '20000.00')];

const ledgerCoverage = computeCoverage({
  period: may,
  batches: [{
    id: 'b1', targetTable: 'ledger_entries', balanceKind: null, balanceBasis: null,
    bankAccountId: null, invoiceListKind: null,
    periodStart: '2026-05-01', periodEnd: '2026-05-31', committedAt: '2026-06-01T00:00:00Z',
  }],
  bankAccounts: [], rowCounts: { ledger: 4 }, asOf: '2026-06-15',
});

const compose = (cells: readonly AggregateCell[], over: Partial<EngineContext> = {}) =>
  composePeriod({
    period: may, coverage: ledgerCoverage, cells, transferLegs: [], context: context(over),
  });

const find = (results: readonly MetricResult[], key: string): MetricResult =>
  results.find((r) => r.key === key && r.dimensionType === 'none')!;

const evidenceKind = (results: readonly MetricResult[], key: string): string =>
  find(results, key).evidenceQuery?.kind ?? 'none';

// ---------------------------------------------------------------------------------------------
// 1. The evidence shape is a function of the chart, and of nothing else.
// ---------------------------------------------------------------------------------------------

describe('a metric’s evidence shape follows the chart of accounts, not the run (§3.1, F-C-15)', () => {
  it('writes the same evidence shape for the same cells and the same chart of accounts', () => {
    const first = compose(WHOLE_MONTH);
    const second = compose(WHOLE_MONTH);

    // Byte-identical, not merely equivalent: §1.1 promises the snapshot serialises the same way.
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('descends cost of sales straight to records whenever its account carried rows', () => {
    expect(evidenceKind(compose(WHOLE_MONTH), 'cost_of_sales')).toBe('leaf');
    expect(find(compose(WHOLE_MONTH), 'cost_of_sales').value).toBe('6000.00');
  });

  it('gives cost of sales no descriptor at all when the organisation has never used one', () => {
    /*
     * CD-05. A seeded SYSTEM account exists for every category, so "has this organisation a cost of
     * sales account" cannot be answered from the chart alone — it is answered by whether a
     * cost-of-sales account has ever carried a figure, which `costOfSalesEverUsed` reports for the
     * ORGANISATION (ADR-063). An organisation that has never used one has no cost of sales figure at
     * all: not zero, unknown. An unknown figure has no rows to descend to, so `evidence_query` is
     * null and the drawer's `component.leaf` is false.
     */
    const never = compose(TRUNCATED_MONTH, { costOfSalesEverUsed: false });
    expect(find(never, 'revenue').value).toBe('20000.00');
    expect(find(never, 'cost_of_sales').value).toBeNull();
    expect(find(never, 'cost_of_sales').dataQuality.missing).toContain('no_cost_of_sales_accounts');
    expect(evidenceKind(never, 'cost_of_sales')).toBe('none');
  });

  it('still reports a period with no cost-of-sales rows as zero once the organisation has used one', () => {
    /*
     * The other half of the same rule, and the reason the intermittent `evidence-drawer` failure was
     * invisible: this fixture is the WHOLE_MONTH organisation seen through a cutoff that fell
     * between its first entry and its second, so the cost-of-sales row is simply absent from the
     * cells. Before ADR-063 the shape was derived per period from that period's rows, so losing the
     * row turned a quiet month into "does not track cost of sales" — a claim about the business,
     * published off an accident of timing. The organisation-level flag makes the shape a function of
     * the chart, as §3.1 promises, and leaves the missing month as what it is: zero.
     */
    const quiet = compose(TRUNCATED_MONTH);
    expect(find(quiet, 'cost_of_sales').value).toBe('0.00');
    expect(find(quiet, 'cost_of_sales').dataQuality.missing)
      .not.toContain('no_cost_of_sales_accounts');
  });

  it('keeps that shape when the customer adds an account it has not categorised yet', () => {
    // An unconfirmed account is `uncategorised` exposure (§3.1), never a reason for a categorised
    // metric to change shape. Adding one to the chart was blamed for the flake; it is not the cause.
    const withoutIt = compose(WHOLE_MONTH, { accounts: ACCOUNTS.slice(0, 3) });
    const withIt = compose(WHOLE_MONTH);

    expect(evidenceKind(withIt, 'cost_of_sales')).toBe(evidenceKind(withoutIt, 'cost_of_sales'));
    expect(find(withIt, 'revenue').value).toBe(find(withoutIt, 'revenue').value);
    expect(find(withIt, 'cost_of_sales').value).toBe(find(withoutIt, 'cost_of_sales').value);
  });

  it('does not depend on the order the aggregation handed the cells over in', () => {
    // The SQL aggregate declares no ORDER BY, so a plan change is free to reorder the rows.
    const reversed = compose([...WHOLE_MONTH].reverse());
    expect(JSON.stringify(reversed)).toBe(JSON.stringify(compose(WHOLE_MONTH)));
  });
});

// ---------------------------------------------------------------------------------------------
// 2. ADR-059's two passes.
// ---------------------------------------------------------------------------------------------

describe('composing a period twice to mint its ids changes the ids and nothing else (ADR-059)', () => {
  it('returns exactly the metrics, values and evidence kinds a single composition returns', async () => {
    const { composeWithIds } = await import('@/modules/jobs/handlers/calculation-run');
    const once = composePeriod({
      period: may, coverage: ledgerCoverage, cells: WHOLE_MONTH, transferLegs: [],
      context: context(),
    });
    const twice = composeWithIds({
      period: may, coverage: ledgerCoverage, cells: WHOLE_MONTH, transferLegs: [],
      context: context(),
    });

    const shapeOf = (results: readonly MetricResult[]) => results.map((r) => ({
      key: r.key,
      dimensionId: r.dimensionId,
      dimensionKey: r.dimensionKey ?? null,
      value: r.value,
      evidence: r.evidenceQuery?.kind ?? 'none',
    }));

    expect(shapeOf(twice)).toEqual(shapeOf(once));
  });

  it('names each derived component with the id of the snapshot that component will be written as', async () => {
    const { composeWithIds } = await import('@/modules/jobs/handlers/calculation-run');
    const results = composeWithIds({
      period: may, coverage: ledgerCoverage, cells: WHOLE_MONTH, transferLegs: [],
      context: context(),
    });

    const grossProfit = find(results, 'gross_profit');
    expect(grossProfit.evidenceQuery?.kind).toBe('derived');
    if (grossProfit.evidenceQuery?.kind !== 'derived') throw new Error('expected a derived metric');

    for (const component of grossProfit.evidenceQuery.components) {
      expect(component.snapshot_id, `${component.name} names the snapshot it came from`).not.toBeNull();
      expect(component.snapshot_id).toBe(find(results, component.name).id);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// 3. The instant a run reads at.
// ---------------------------------------------------------------------------------------------

const repository = vi.hoisted(() => ({
  loadPeriods: vi.fn(),
  loadAccounts: vi.fn(),
  loadCounterparties: vi.fn(),
  loadBankAccounts: vi.fn(),
  loadSettings: vi.fn(),
  loadFingerprintSources: vi.fn(),
  loadFirstPeriodWithData: vi.fn(),
  loadCostOfSalesEverUsed: vi.fn(),
  loadCostOfSalesInInvoices: vi.fn(),
  loadCurrentObservations: vi.fn(),
  loadAggregates: vi.fn(),
  loadTransferLegs: vi.fn(),
  loadCoverageBatches: vi.fn(),
  // ADR-120: the receivables family's reads and the engine-version gate.
  loadLatestEngineVersion: vi.fn(),
  loadLatestRunAsOf: vi.fn(),
  loadAgingInvoices: vi.fn(),
  loadOpeningJournal: vi.fn(),
  loadStatements: vi.fn(),
  // ADR-124: the per-account cash history's rows, and the rows before a mid-month opening journal.
  loadBankDailyMovements: vi.fn(),
  loadLinesBeforeJournal: vi.fn(),
}));

vi.mock('@/modules/financial-engine/data/repository', () => repository);

/** Thirteen months, so the run has to take more than one chunk (§2.4). */
const THIRTEEN_MONTHS: PeriodRef[] = Array.from({ length: 13 }, (_unused, index) => ({
  id: `p-${index}`,
  periodStart: `2026-${String(index + 1).padStart(2, '0')}-01`,
  periodEnd: `2026-${String(index + 1).padStart(2, '0')}-28`,
  fiscalYear: 2026,
  fiscalQuarter: 1,
  label: `M${index}`,
  isComplete: false,
}));

/** The instant the DATABASE stamped on the run — deliberately behind the process clock. */
const DB_STARTED_AT = '2020-01-01T00:00:00.000Z';

const noBankAccounts: BankAccountRef[] = [];

describe('a run reads the ledger at one instant, and that instant is the database’s (§2.4 step 4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repository.loadPeriods.mockResolvedValue(THIRTEEN_MONTHS);
    repository.loadAccounts.mockResolvedValue(ACCOUNTS);
    repository.loadCounterparties.mockResolvedValue([]);
    repository.loadBankAccounts.mockResolvedValue(noBankAccounts);
    repository.loadSettings.mockResolvedValue(context().settings);
    repository.loadFingerprintSources.mockResolvedValue({
      maxRecordEventAt: null, rowCounts: {}, accountCategories: {},
      counterpartyMerges: {}, categoryHistoryHeads: {},
    });
    repository.loadFirstPeriodWithData.mockResolvedValue(null);
    repository.loadCostOfSalesEverUsed.mockResolvedValue(true);
    repository.loadCostOfSalesInInvoices.mockResolvedValue(false);
    repository.loadCurrentObservations.mockResolvedValue([]);
    repository.loadAggregates.mockResolvedValue([]);
    repository.loadTransferLegs.mockResolvedValue([]);
    repository.loadCoverageBatches.mockResolvedValue([]);
    repository.loadLatestEngineVersion.mockResolvedValue(null);
    repository.loadLatestRunAsOf.mockResolvedValue(null);
    repository.loadAgingInvoices.mockResolvedValue([]);
    repository.loadOpeningJournal.mockResolvedValue(null);
    repository.loadStatements.mockResolvedValue([]);
    repository.loadBankDailyMovements.mockResolvedValue([]);
    repository.loadLinesBeforeJournal.mockResolvedValue([]);
  });

  /**
   * `instants` is what the DATABASE answers, in order, each time a chunk asks for its pin. The
   * default hands every chunk the same answer, which is what a quiet ledger looks like; a test that
   * cares which chunk got which passes distinct ones.
   */
  const run = async (instants: readonly string[] = [DB_STARTED_AT]) => {
    const { runCalculation } = await import('@/modules/financial-engine');
    const finishChunk = vi.fn().mockResolvedValue({ written: 0 });
    const scoreHealth = vi.fn().mockResolvedValue({ written: 0 });
    let asked = 0;
    const aggregationInstant = vi.fn(async () =>
      instants[Math.min(asked++, instants.length - 1)]!);

    const outcome = await runCalculation({
      scoped: {} as never,
      computePeriod: () => [],
      aggregationInstant,
      startRun: vi.fn().mockResolvedValue({ runId: 'run-1', noChange: false }),
      finishChunk,
      finishRun: vi.fn().mockResolvedValue(undefined),
      setCompleteness: vi.fn().mockResolvedValue(undefined),
      scoreHealth,
    }, {
      organizationId: 'org-1',
      trigger: 'recalc_manual',
      triggerRefId: null,
      asOf: '2026-06-15',
      jobId: 'job-1',
      changedPeriodIds: THIRTEEN_MONTHS.map((p) => p.id),
    });

    return { outcome, finishChunk, scoreHealth, aggregationInstant };
  };

  it('aggregates as of the instant the database stamped on the run, never the worker’s own clock', async () => {
    /*
     * The regression this exists for. `app.aggregate_periods` selects `created_at <=
     * p_aggregated_at` and `created_at` comes from Postgres, so a pin minted by `new Date()` is a
     * comparison between two clocks: with the database's the further ahead — it is, on any host
     * running it in a VM — rows committed before the run was queued fall outside the cutoff, and the
     * run reports a month that is short of some of its entries with no error anywhere.
     *
     * A wall-clock pin would put "now" here and the assertion would fail by six years.
     */
    const { finishChunk } = await run();

    for (const call of repository.loadAggregates.mock.calls) expect(call[4]).toBe(DB_STARTED_AT);
    for (const call of repository.loadTransferLegs.mock.calls) expect(call[4]).toBe(DB_STARTED_AT);
    for (const call of finishChunk.mock.calls) {
      expect((call[0] as { p_aggregated_at: string }).p_aggregated_at).toBe(DB_STARTED_AT);
    }
  });

  it('pins each chunk to its own instant, asked for when that chunk starts (ADR-047.7)', async () => {
    /*
     * PER CHUNK, not per run. A chunk is its own transaction (§2.4), and ADR-047.7 makes the pin a
     * property of the chunk precisely so that a long run stays restartable: a run that failed on its
     * ninth chunk resumes without having to re-read the first eight at an instant that has since
     * gone stale. EVIDENCE_MODEL.md §11 tests the consequence directly — "a run of three chunks
     * whose middle chunk aggregated after a supersession resolves chunk-1 descriptors to the
     * pre-supersession rows and chunk-2 descriptors to the post-supersession rows" — which is only
     * possible if the chunks hold different instants.
     *
     * What ADR-063 fixed is WHERE each instant comes from, not how many there are: the database, so
     * the cutoff and the `created_at` it is compared against are stamped by one clock.
     */
    const CHUNK_1 = '2020-01-01T00:00:00.000Z';
    const CHUNK_2 = '2020-01-01T00:05:00.000Z';
    const { finishChunk, scoreHealth, aggregationInstant } = await run([CHUNK_1, CHUNK_2]);

    // Thirteen months is two chunks; without both, the assertion would prove nothing.
    expect(repository.loadAggregates.mock.calls.length).toBe(2);
    expect(aggregationInstant, 'the database is asked once per chunk').toHaveBeenCalledTimes(2);

    expect(repository.loadAggregates.mock.calls.map((call) => call[4]))
      .toEqual([CHUNK_1, CHUNK_2]);
    expect(repository.loadTransferLegs.mock.calls.map((call) => call[4]))
      .toEqual([CHUNK_1, CHUNK_2]);
    expect(finishChunk.mock.calls
      .map((call) => (call[0] as { p_aggregated_at: string }).p_aggregated_at))
      .toEqual([CHUNK_1, CHUNK_2]);

    // The health step scores against the rows its own chunk read, so it carries that chunk's pin.
    for (const call of scoreHealth.mock.calls) {
      expect([CHUNK_1, CHUNK_2]).toContain((call[0] as { aggregatedAt: string }).aggregatedAt);
    }
  });

  it('never asks the database for an instant when the fingerprint says there is nothing to do', async () => {
    const { runCalculation } = await import('@/modules/financial-engine');
    const outcome = await runCalculation({
      scoped: {} as never,
      computePeriod: () => [],
      aggregationInstant: vi.fn(async () => DB_STARTED_AT),
      startRun: vi.fn().mockResolvedValue({ runId: 'run-1', noChange: true }),
      finishChunk: vi.fn(),
      finishRun: vi.fn(),
      setCompleteness: vi.fn(),
      scoreHealth: vi.fn(),
    }, {
      organizationId: 'org-1',
      trigger: 'import_commit',
      triggerRefId: null,
      asOf: '2026-06-15',
      jobId: 'job-1',
      changedPeriodIds: THIRTEEN_MONTHS.map((p) => p.id),
    });

    expect(outcome.status).toBe('no_change');
    expect(repository.loadPeriods).toHaveBeenCalled();
  });
});
