import { describe, expect, it } from 'vitest';

import { Decimal, parseDecimal } from '@/core/money';

import {
  bankRecordAssuranceFor, buildCashHistory, composePeriod, computeCoverage,
  type BankAccountRef, type CoverageBatch, type DailyMovement, type EngineContext, type MetricResult,
  type PeriodRef, type StatementRef,
} from '@/modules/financial-engine';
import { INFERRED_CAP_NOTE, computeHealthScore } from '@/modules/health';
import { baselineSnapshots, healthInput, withMetric } from '../fixtures/health';

/**
 * Opening cash carried out of an AI-read month (Step 0D; the ADR-130 limitation).
 *
 * A month's opening is the balance at the close of the day before it, carried along the chain of
 * statements from an anchor (ADR-124). Before, it was badged by the anchor's SOURCE alone, so cash
 * carried through a month an AI read — or opened by a balance typed onto an AI-read statement — was
 * `verified` in every later month, on Home and in Health. Now a balance is no firmer than the anchor
 * that attests it and the rows of every statement crossed since; a later verified printed balance
 * that agrees with the chain attests it again.
 *
 * One account, June to September. Every figure is written out.
 */

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const A = uuid(1);
const B = uuid(2);

function month(ym: string, index: number): PeriodRef {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return {
    id: uuid(100 + index), periodStart: `${ym}-01`, periodEnd: `${ym}-${String(last).padStart(2, '0')}`,
    fiscalYear: y, fiscalQuarter: Math.floor((m - 1) / 3) + 1, label: ym, isComplete: true,
  };
}
const PERIODS = ['2026-06', '2026-07', '2026-08', '2026-09'].map(month);
const P = (ym: string): PeriodRef => PERIODS.find((p) => p.label === ym)!;

const bank = (id: string): BankAccountRef => ({
  id, name: id === A ? 'Main' : 'Reserve', accountType: 'current', openingBalance: null, openingBalanceDate: null, isActive: true,
});

const JUN = uuid(5001); const JUL = uuid(5002); const AUG = uuid(5003); const SEP = uuid(5004);
const JUL_CSV = uuid(5012);

function st(batchId: string, account: string, ym: string, o: {
  open?: string; close?: string; assurance?: StatementRef['assurance']; committedAt?: string;
} = {}): StatementRef {
  const p = P(ym);
  return {
    batchId, bankAccountId: account, periodStart: p.periodStart, periodEnd: p.periodEnd,
    committedAt: o.committedAt ?? `${ym}-28T09:00:00Z`, openingBalance: o.open ?? null, closingBalance: o.close ?? null,
    unreconciled: o.assurance === 'calculated', ...(o.assurance === undefined ? {} : { assurance: o.assurance }),
  };
}
const mv = (bankAccountId: string, date: string, amount: string): DailyMovement => ({ bankAccountId, date, amount });

// June CSV (printed 10,000 → 9,000), July READ BY AI, August and September CSV without printed balances.
const ROWS = [mv(A, '2026-06-10', '-1000'), mv(A, '2026-07-10', '-500'), mv(A, '2026-08-10', '-200'), mv(A, '2026-09-10', '100')];
const BASE = [
  st(JUN, A, '2026-06', { open: '10000', close: '9000' }),
  st(JUL, A, '2026-07', { assurance: 'inferred' }),
  st(AUG, A, '2026-08'),
  st(SEP, A, '2026-09'),
];

function history(statements: readonly StatementRef[], movements: readonly DailyMovement[] = ROWS, accounts = [bank(A)]) {
  return buildCashHistory({ bankAccounts: accounts, statements, movements, periods: PERIODS });
}
/** [opening value, opening assurance, closing value, closing assurance, what the closing rests on] */
function account(h: ReturnType<typeof history>, ym: string, id = A) {
  const s = h.get(P(ym).id)!.find((a) => a.bankAccountId === id)!;
  return [s.opening?.value ?? null, s.opening?.assurance ?? null, s.closing?.value ?? null, s.closing?.assurance ?? null,
    s.closing?.weakenedBy ?? []];
}

describe('opening cash carried out of an AI-read month', () => {
  it('marks every later month it is carried into, naming the AI-read statement', () => {
    const h = history(BASE);
    expect(account(h, '2026-06')).toEqual(['10000.00', 'verified', '9000.00', 'verified', []]);
    // July's opening is June's printed close — verified. Its close adds July's AI-read rows.
    expect(account(h, '2026-07')).toEqual(['9000.00', 'verified', '8500.00', 'inferred', [JUL]]);
    // August and September have only CSV rows of their own, but their balances are carried through July.
    expect(account(h, '2026-08')).toEqual(['8500.00', 'inferred', '8300.00', 'inferred', [JUL]]);
    expect(account(h, '2026-09')).toEqual(['8300.00', 'inferred', '8400.00', 'inferred', [JUL]]);
    expect(h.get(P('2026-08').id)![0]!.opening!.weakenedBy).toEqual([JUL]);
  });

  it('a balance typed onto an AI-read statement anchors as inferred', () => {
    const h = history([st(JUL, A, '2026-07', { open: '9000', assurance: 'inferred' }), st(AUG, A, '2026-08')],
      ROWS.filter((r) => r.date >= '2026-07-01' && r.date < '2026-09-01'));
    expect(account(h, '2026-07')).toEqual(['9000.00', 'inferred', '8500.00', 'inferred', [JUL]]);
    expect(account(h, '2026-08')).toEqual(['8500.00', 'inferred', '8300.00', 'inferred', [JUL]]);
  });

  it('an unreconciled text-PDF month carries `calculated` the same way', () => {
    const h = history([BASE[0]!, st(JUL, A, '2026-07', { assurance: 'calculated' }), BASE[2]!, BASE[3]!]);
    expect(account(h, '2026-08')).toEqual(['8500.00', 'calculated', '8300.00', 'calculated', [JUL]]);
  });
});

describe('a later verified statement', () => {
  it('whose printed opening AGREES with the chain attests the balance from that day on', () => {
    const h = history([BASE[0]!, BASE[1]!, st(AUG, A, '2026-08', { open: '8500' }), BASE[3]!]);
    // The bank's own printed 8,500 at 31 July attests July's close and everything after it.
    expect(account(h, '2026-07')).toEqual(['9000.00', 'verified', '8500.00', 'verified', []]);
    expect(account(h, '2026-08')).toEqual(['8500.00', 'verified', '8300.00', 'verified', []]);
    expect(account(h, '2026-09')).toEqual(['8300.00', 'verified', '8400.00', 'verified', []]);
  });

  it('whose printed balance DISAGREES attests nothing: the computed figure stands, still inferred, and the mismatch shows', () => {
    const h = history([BASE[0]!, BASE[1]!, st(AUG, A, '2026-08', { open: '8400' }), BASE[3]!]);
    expect(account(h, '2026-08')).toEqual(['8500.00', 'inferred', '8300.00', 'inferred', [JUL]]);
    expect(h.get(P('2026-07').id)![0]!.balanceMismatch).toBe(true);
  });

  it('a printed CLOSE that agrees attests that month\'s end, while its opening stays inferred', () => {
    const h = history([BASE[0]!, BASE[1]!, st(AUG, A, '2026-08', { close: '8300' }), BASE[3]!]);
    expect(account(h, '2026-08')).toEqual(['8500.00', 'inferred', '8300.00', 'verified', []]);
    expect(account(h, '2026-09')).toEqual(['8300.00', 'verified', '8400.00', 'verified', []]);
  });
});

describe('rollback', () => {
  it('rolling back the AI-read statement (its rows go with it) leaves July uncovered, never a verified guess', () => {
    const h = history([BASE[0]!, BASE[2]!, BASE[3]!], ROWS.filter((r) => !r.date.startsWith('2026-07')));
    expect(account(h, '2026-07')[0]).toBe('9000.00'); // the close of June is still stated
    expect(account(h, '2026-07')[2]).toBeNull();
    expect(account(h, '2026-08')).toEqual([null, null, null, null, []]);
  });

  it('replacing it with a verified statement of the same month restores verified everywhere', () => {
    const h = history([BASE[0]!, st(JUL_CSV, A, '2026-07'), BASE[2]!, BASE[3]!]);
    for (const ym of ['2026-07', '2026-08', '2026-09']) expect(account(h, ym)[3], ym).toBe('verified');
  });

  it('rolling back the verified statement that attested the chain makes the balance inferred again', () => {
    const attested = history([BASE[0]!, BASE[1]!, st(AUG, A, '2026-08', { open: '8500' }), BASE[3]!]);
    expect(account(attested, '2026-09')[1]).toBe('verified');
    // August rolled back: its rows and its printed balance are gone, so August is uncovered.
    const after = history([BASE[0]!, BASE[1]!, BASE[3]!], ROWS.filter((r) => !r.date.startsWith('2026-08')));
    expect(account(after, '2026-07')).toEqual(['9000.00', 'verified', '8500.00', 'inferred', [JUL]]);
    expect(account(after, '2026-08')[0]).toBe('8500.00');
    expect(account(after, '2026-08')[1]).toBe('inferred');
  });
});

describe('mixed assurance across accounts', () => {
  it('the total is as firm as its weakest account; each account says its own', () => {
    const accounts = [bank(A), bank(B)];
    const statements = [...BASE, st(uuid(6001), B, '2026-06', { open: '500' }), st(uuid(6002), B, '2026-07'),
      st(uuid(6003), B, '2026-08'), st(uuid(6004), B, '2026-09')];
    const rows = [...ROWS, mv(B, '2026-08-15', '50')];
    const h = history(statements, rows, accounts);
    expect(account(h, '2026-08', A)[1]).toBe('inferred');
    expect(account(h, '2026-08', B)).toEqual(['500.00', 'verified', '550.00', 'verified', []]);
  });
});

// ---- Through compose (the figures the run stores) and Health ---------------------------------

const context = (): EngineContext => ({
  organizationId: uuid(1000), calculationRunId: uuid(9001), aggregatedAt: '2026-09-30T00:00:00Z', asOf: '2026-09-30',
  engineVersion: 'test', accounts: [], costOfSalesEverUsed: true, costOfSalesInInvoices: false, counterparties: [],
  bankAccounts: [bank(A)], periods: PERIODS,
  settings: { baseCurrency: 'GBP', fiscalYearStartMonth: 1, timezone: 'Europe/London', vatRegistered: false, defaultVatRate: null, taxableCategories: [] },
});

type Resolver = NonNullable<Parameters<typeof composePeriod>[0]['resolveSnapshotId']>;
function composed(ym: string, statements: readonly StatementRef[], resolveSnapshotId?: Resolver): MetricResult[] {
  const period = P(ym);
  const h = history(statements);
  const batches: CoverageBatch[] = statements.map((s) => ({
    id: s.batchId, importType: 'bank_statement', targetTable: 'bank_transactions', bankAccountId: s.bankAccountId,
    periodStart: s.periodStart, periodEnd: s.periodEnd, committedAt: s.committedAt, invoiceListKind: null,
    balanceKind: null, balanceBasis: null,
  }));
  const coverage = computeCoverage({ period, batches, bankAccounts: [bank(A)], rowCounts: { bank: 1 }, asOf: '2026-09-30', statements });
  const own = ROWS.filter((r) => r.date >= period.periodStart && r.date <= period.periodEnd);
  const amounts = own.map((r) => parseDecimal(r.amount));
  const inflow = amounts.filter((a) => a.greaterThan(0)).reduce((t, a) => t.plus(a), new Decimal(0));
  const outflow = amounts.filter((a) => a.lessThan(0)).reduce((t, a) => t.minus(a), new Decimal(0));
  return composePeriod({
    ...(resolveSnapshotId ? { resolveSnapshotId } : {}),
    period, coverage, transferLegs: [], context: context(), cashAccounts: h.get(period.id) ?? [],
    bankRecordAssurance: bankRecordAssuranceFor(statements, period),
    cells: [{
      periodId: period.id, source: 'bank', standardCategory: 'revenue', accountId: null, counterpartyId: null, bankAccountId: A,
      balanceKind: null, balanceBasis: null, invoiceType: null, debit: inflow.toFixed(2), credit: outflow.toFixed(2),
      amount: inflow.minus(outflow).toFixed(2), rowCount: own.length, fallbackRows: 0, minDate: null, maxDate: null,
      transferKind: 'none', unpairedTransferCandidate: false,
    }],
  });
}
const metric = (results: readonly MetricResult[], key: string) => results.find((r) => r.key === key && r.dimensionType === 'none')!;

describe('the stored figures, the dashboard label and Health', () => {
  it('August: cash carried through AI-read July is inferred, though August\'s own rows are verified', () => {
    const results = composed('2026-08', BASE);
    expect([metric(results, 'opening_cash').value, metric(results, 'opening_cash').assurance]).toEqual(['8500.00', 'inferred']);
    expect([metric(results, 'closing_cash').value, metric(results, 'closing_cash').assurance]).toEqual(['8300.00', 'inferred']);
    // The movement is August's own CSV rows.
    expect(metric(results, 'net_cash_movement').assurance).toBe('verified');
    // The evidence: which statement the balance rests on.
    expect(metric(results, 'closing_cash').components.rests_on_statements).toEqual([JUL]);
    expect(metric(results, 'opening_cash').components.rests_on_statements).toEqual([JUL]);
  });

  it('July: the opening (June\'s close) is not marked by July\'s own AI-read rows; the close is', () => {
    const results = composed('2026-07', BASE);
    expect(metric(results, 'opening_cash').assurance).toBe('verified');
    expect(metric(results, 'closing_cash').assurance).toBe('inferred');
    expect(metric(results, 'net_cash_movement').assurance).toBe('inferred');
  });

  it('Health caps cash flow at 70 when closing cash rests on an AI read, with the AI reason (ADR-134; the cap awaits approval)', () => {
    const closing = metric(composed('2026-08', BASE), 'closing_cash');
    const snapshots = withMetric(baselineSnapshots(), { key: 'closing_cash', value: closing.value, unit: 'money', assurance: closing.assurance });
    const scored = computeHealthScore(healthInput({ snapshots }))!;
    const cashFlow = scored.breakdown.find((d) => d.key === 'cash_flow')!;
    expect(cashFlow.capped).toBe(true);
    expect(cashFlow.score).toBeLessThanOrEqual(70);
    expect(cashFlow.cap_reason).toContain(INFERRED_CAP_NOTE);

    const verified = withMetric(baselineSnapshots(), { key: 'closing_cash', value: closing.value, unit: 'money', assurance: 'verified' });
    expect(computeHealthScore(healthInput({ snapshots: verified }))!.breakdown.find((d) => d.key === 'cash_flow')!.capped).toBe(false);
  });
});


describe('derived cash figures name the figures they came from (the "Why?" on Cash)', () => {
  // The run mints an id per undimensioned figure before composing (composeWithIds); stand in for it.
  const ids = (key: string, dimensionId: string | null) => (dimensionId === null ? `id-${key}` : null);
  const components = (results: readonly MetricResult[], key: string) => {
    const q = metric(results, key).evidenceQuery;
    return q?.kind === 'derived' ? q.components : null;
  };

  it('closing cash links opening cash and net cash movement; net movement links inflows and outflows', () => {
    const results = composed('2026-08', BASE, ids);
    expect(components(results, 'closing_cash')).toEqual([
      { name: 'opening_cash', snapshot_id: 'id-opening_cash' },
      { name: 'net_cash_movement', snapshot_id: 'id-net_cash_movement' },
    ]);
    expect(components(results, 'net_cash_movement')).toEqual([
      { name: 'cash_inflows', snapshot_id: 'id-cash_inflows' },
      { name: 'cash_outflows', snapshot_id: 'id-cash_outflows' },
    ]);
  });

  it('a component that is no figure of the period stays honestly unlinked (null), never invented', () => {
    const results = composed('2026-08', BASE, (key, dimensionId) => (key === 'opening_cash' && dimensionId === null ? 'id-opening_cash' : null));
    expect(components(results, 'closing_cash')).toEqual([
      { name: 'opening_cash', snapshot_id: 'id-opening_cash' },
      { name: 'net_cash_movement', snapshot_id: null },
    ]);
  });
});
