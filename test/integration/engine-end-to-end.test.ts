import { beforeAll, afterAll, describe, expect, it } from 'vitest';

import {
  composePeriod, computeCoverage, computeFingerprint, ENGINE_VERSION,
  type AggregateCell, type EngineContext, type PeriodRef,
} from '@/modules/financial-engine';
import { aggregatePeriods } from '@/core/db';
import { periodId } from '@/db/app/shared';
import { orgCollection, orgRow } from '@/db/schema';
import { deleteOrg, fs } from './setup';
import { seedBatch, seedDocument, seedLedgerEntry, seedOrg } from '../fixtures/seed';

/**
 * The engine end to end (FINANCIAL_ENGINE.md §1–§4): real records, through the aggregation
 * (`api_server.aggregate_periods`), the composition and the metric modules, to figures.
 *
 * The guarantee under test is §1.1's: the same accepted records and the same engine version must
 * produce the same numbers, every time. And §1.5's: a figure that cannot be computed is NULL with a
 * reason, never zero.
 */

const RUN = `e2e${Date.now().toString(36)}`;
let orgId: string;
let mayPeriod: PeriodRef;
let accounts: EngineContext['accounts'];
let chart: Readonly<Record<string, string>>;

const accountId = (category: string): string => chart[category]!;

/** Reads the aggregate exactly as the engine's repository does. */
async function loadAggregate(from: string, to: string): Promise<AggregateCell[]> {
  const rows = await aggregatePeriods(orgId, from, to, new Date().toISOString());
  return rows.map((r) => ({
    periodId: r.period_id as string,
    source: r.source as AggregateCell['source'],
    standardCategory: r.standard_category as AggregateCell['standardCategory'],
    accountId: r.account_id as string | null,
    counterpartyId: r.counterparty_id as string | null,
    bankAccountId: r.bank_account_id as string | null,
    balanceKind: r.balance_kind as AggregateCell['balanceKind'],
    balanceBasis: r.balance_basis as AggregateCell['balanceBasis'],
    invoiceType: r.invoice_type as string | null,
    transferKind: (r.transfer_kind as string | null) ?? null,
    unpairedTransferCandidate: r.unpaired_transfer === true,
    debit: String(r.debit ?? '0'),
    credit: String(r.credit ?? '0'),
    amount: String(r.amount ?? '0'),
    rowCount: Number(r.row_count ?? 0),
    fallbackRows: Number(r.fallback_rows ?? 0),
    minDate: r.min_date as string | null,
    maxDate: r.max_date as string | null,
  }));
}

beforeAll(async () => {
  const seeded = await seedOrg({ name: `ITest Engine E2E ${RUN}`, ownerEmail: `owner@${RUN}.engine.itest.motion` });
  orgId = seeded.orgId;
  chart = seeded.accounts;

  const may = (await orgRow(fs(), orgId, 'fiscal_periods', periodId(orgId, '2026-05-01')).get()).data()!;
  mayPeriod = {
    id: String(may.id), periodStart: String(may.period_start), periodEnd: String(may.period_end),
    fiscalYear: 2026, fiscalQuarter: 2, label: String(may.label), isComplete: false,
  };

  accounts = (await orgCollection(fs(), orgId, 'accounts').get()).docs.map((d) => ({
    id: d.id, code: d.get('code') as string | null, name: String(d.get('name')),
    standardCategory: d.get('standard_category'), accountType: d.get('account_type'), isSystem: d.get('is_system') === true,
  })) as unknown as EngineContext['accounts'];

  // A month of trading: revenue 20,000; cost of sales 6,000; payroll 5,000; marketing 1,000.
  const post = (category: string, direction: 'debit' | 'credit', amount: string, day: string) =>
    seedLedgerEntry(orgId, { date: `2026-05-${day}`, accountId: accountId(category), direction, amount });

  await post('revenue', 'credit', '20000.00', '10');
  await post('cost_of_sales', 'debit', '6000.00', '12');
  await post('payroll', 'debit', '5000.00', '25');
  await post('marketing', 'debit', '1000.00', '20');

  // A general ledger batch declaring the whole month, so the period is covered (§2.2).
  const doc = await seedDocument(orgId, 'gl.csv', 'general_ledger');
  await seedBatch(orgId, {
    importType: 'general_ledger', target: 'ledger_entries', start: '2026-05-01', end: '2026-05-31', documentId: doc,
  });
});

afterAll(async () => {
  if (orgId) await deleteOrg(orgId);
});

function contextFor(): EngineContext {
  return {
    organizationId: orgId,
    calculationRunId: 'run-e2e',
    aggregatedAt: '2026-06-01T00:00:00.000Z',
    costOfSalesEverUsed: true,
    costOfSalesInInvoices: false,
    asOf: '2026-06-15',
    engineVersion: ENGINE_VERSION,
    settings: {
      baseCurrency: 'GBP', fiscalYearStartMonth: 1, timezone: 'Europe/London',
      vatRegistered: false, defaultVatRate: null,
      taxableCategories: ['revenue', 'cost_of_sales', 'operating_expense', 'marketing'],
    },
    accounts,
    counterparties: [],
    bankAccounts: [],
    periods: [mayPeriod],
  };
}

async function computeMay() {
  const cells = await loadAggregate('2026-05-01', '2026-05-31');
  const rowCounts: Record<string, number> = {};
  for (const cell of cells) {
    if (cell.periodId !== mayPeriod.id) continue;
    rowCounts[cell.source] = (rowCounts[cell.source] ?? 0) + cell.rowCount;
  }
  const coverage = computeCoverage({
    period: mayPeriod,
    batches: [{
      id: 'b1', targetTable: 'ledger_entries', balanceKind: null, balanceBasis: null,
      bankAccountId: null, invoiceListKind: null,
      periodStart: '2026-05-01', periodEnd: '2026-05-31', committedAt: '2026-06-01T00:00:00Z',
    }],
    bankAccounts: [], rowCounts, asOf: '2026-06-15',
  });

  return composePeriod({
    period: mayPeriod, coverage, cells, transferLegs: [], context: contextFor(),
  });
}

const valueOf = (results: Awaited<ReturnType<typeof computeMay>>, key: string): string | null =>
  results.find((r) => r.key === key && r.dimensionType === 'none')?.value ?? null;

describe('a month of real ledger entries becomes figures', () => {
  it('computes the P&L from the ledger, in the right signs', async () => {
    const results = await computeMay();

    // The account-type rule: revenue is a credit balance and reads positive (§3).
    expect(valueOf(results, 'revenue')).toBe('20000.00');
    expect(valueOf(results, 'cost_of_sales')).toBe('6000.00');
    expect(valueOf(results, 'gross_profit')).toBe('14000.00');
    // Payroll 5,000 + marketing 1,000.
    expect(valueOf(results, 'operating_expenses')).toBe('6000.00');
    expect(valueOf(results, 'operating_profit')).toBe('8000.00');
    expect(valueOf(results, 'net_profit')).toBe('8000.00');
  });

  it('records the basis and the assurance the source earns', async () => {
    const revenue = (await computeMay()).find((r) => r.key === 'revenue');
    expect(revenue?.basis).toBe('ledger');
    // A ledger aggregate is calculated, not verified: it is a sum, not a stated balance.
    expect(revenue?.assurance).toBe('calculated');
  });

  it('states the margins as ratios, not percentages', async () => {
    const results = await computeMay();
    // 14,000 / 20,000.
    expect(valueOf(results, 'gross_margin')).toBe('0.700000');
    expect(valueOf(results, 'net_margin')).toBe('0.400000');
  });

  it('carries components so a reader can redo the arithmetic (§1.7)', async () => {
    const grossProfit = (await computeMay()).find((r) => r.key === 'gross_profit');
    expect(grossProfit?.components).toHaveProperty('revenue');
    expect(grossProfit?.components).toHaveProperty('cost_of_sales');
  });

  it('carries an evidence descriptor naming account ids, never a category (ADR-034)', async () => {
    const revenue = (await computeMay()).find((r) => r.key === 'revenue');
    expect(revenue?.evidenceQuery?.kind).toBe('leaf');

    const descriptor = revenue?.evidenceQuery?.kind === 'leaf'
      ? revenue.evidenceQuery.descriptor : null;
    expect(descriptor?.table).toBe('ledger_entries');
    // A category is a mutable property of an account; storing one would make old evidence follow a
    // later remap.
    expect(descriptor?.filters.account_ids?.length).toBeGreaterThan(0);
    expect(JSON.stringify(descriptor)).not.toContain('standard_categories');
    expect(descriptor?.filters.account_ids).toContain(accountId('revenue'));
  });

  it('points a derived metric at the snapshots it came from', async () => {
    const operatingProfit = (await computeMay()).find((r) => r.key === 'operating_profit');
    expect(operatingProfit?.evidenceQuery?.kind).toBe('derived');
  });
});

describe('determinism (§1.1)', () => {
  it('produces byte-identical results from the same records', async () => {
    const first = JSON.stringify(await computeMay());
    const second = JSON.stringify(await computeMay());
    expect(second).toBe(first);
  });

  it('produces the same fingerprint from the same metadata', async () => {
    const inputs = {
      organizationId: orgId, engineVersion: ENGINE_VERSION,
      periodFrom: mayPeriod.id, periodTo: mayPeriod.id,
      maxRecordEventAt: null, rowCounts: { ledger_entries: 4 },
      accountCategories: Object.fromEntries(accounts.map((a) => [a.id, a.standardCategory])),
      categoryHistoryHeads: {}, counterpartyMerges: {},
      settings: { baseCurrency: 'GBP' }, detectorVersion: 'recurring.v1', asOfDate: null,
    };
    expect(computeFingerprint(inputs)).toBe(computeFingerprint(inputs));
  });

  it('is unaffected by the order the aggregate arrives in', async () => {
    const cells = await loadAggregate('2026-05-01', '2026-05-31');
    const coverage = computeCoverage({
      period: mayPeriod,
      batches: [{
        id: 'b1', targetTable: 'ledger_entries', balanceKind: null, balanceBasis: null,
        bankAccountId: null, invoiceListKind: null,
        periodStart: '2026-05-01', periodEnd: '2026-05-31', committedAt: '2026-06-01T00:00:00Z',
      }],
      bankAccounts: [], rowCounts: { ledger: 4 }, asOf: '2026-06-15',
    });

    const forwards = composePeriod({
      period: mayPeriod, coverage, cells, transferLegs: [], context: contextFor(),
    });
    const backwards = composePeriod({
      period: mayPeriod, coverage, cells: [...cells].reverse(), transferLegs: [],
      context: contextFor(),
    });
    expect(JSON.stringify(backwards)).toBe(JSON.stringify(forwards));
  });
});

describe('a period nothing covers is NULL with a reason, never zero (§1.5)', () => {
  it('writes no_source_covers_period rather than a zero P&L', async () => {
    const emptyPeriod: PeriodRef = {
      ...mayPeriod, id: mayPeriod.id, periodStart: '2026-01-01', periodEnd: '2026-01-31',
      label: 'Jan 2026',
    };
    const coverage = computeCoverage({
      period: emptyPeriod, batches: [], bankAccounts: [], rowCounts: {}, asOf: '2026-06-15',
    });

    const results = composePeriod({
      period: emptyPeriod, coverage, cells: [], transferLegs: [], context: contextFor(),
    });

    const revenue = results.find((r) => r.key === 'revenue');
    expect(revenue?.value, 'zero would say the business earned nothing').toBeNull();
    expect(revenue?.basis).toBe('none');
    expect(revenue?.dataQuality.missing).toContain('no_source_covers_period');
  });
});

describe('the aggregate reflects only what the engine may see', () => {
  it('drops a row the moment it is superseded', async () => {
    const before = (await loadAggregate('2026-05-01', '2026-05-31'))
      .filter((c) => c.source === 'ledger' && c.standardCategory === 'revenue')[0];
    expect(before?.amount).toBe('-20000.00');

    const kept = (await orgCollection(fs(), orgId, 'ledger_entries').where('amount', '==', '20000.00').limit(1).get()).docs[0]!.id;
    const extra = await seedLedgerEntry(orgId, {
      date: '2026-05-28', accountId: accountId('revenue'), direction: 'credit', amount: '500.00',
    });

    const withExtra = (await loadAggregate('2026-05-01', '2026-05-31'))
      .filter((c) => c.source === 'ledger' && c.standardCategory === 'revenue')[0];
    expect(withExtra?.amount).toBe('-20500.00');

    await orgRow(fs(), orgId, 'ledger_entries', extra).update({ superseded_by: kept, superseded_at: new Date().toISOString() });

    const after = (await loadAggregate('2026-05-01', '2026-05-31'))
      .filter((c) => c.source === 'ledger' && c.standardCategory === 'revenue')[0];
    expect(after?.amount, 'a superseded row leaves the figures at once').toBe('-20000.00');
  });
});
