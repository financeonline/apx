import { describe, expect, it } from 'vitest';

import { Decimal, parseDecimal } from '@/core/money';
import {
  accountScope, bankCoverageFor, buildCashHistory, computeCash, coveredRuns, currentStatements,
  type BankAccountRef, type BankAggregateCell, type DailyMovement, type EngineContext, type MetricResult,
  type PeriodRef, type StatementRef,
} from '@/modules/financial-engine';

/**
 * Per-account cash histories (FINANCIAL_ENGINE.md §3.3; ADR-124 D-1, D-2).
 *
 * Each case builds an organisation's bank data from nothing — accounts, statements with their
 * declared ranges and printed balances, and the rows — and runs the SAME pure pipeline the
 * calculation run runs: `buildCashHistory` over every period, then `computeCash` per period. Every
 * expected figure is written out: a reader must be able to check each one against the statements by
 * hand. The second independent audit's shapes are here by name (GAP, PARTJUL, MIDTYPED, NEWACCT,
 * CYCLE, UNRECON); their queue-level reproductions are `adr124-remediation.test.ts`.
 */

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const A = uuid(1);
const B = uuid(2);
const C = uuid(3);
const CARD = uuid(4);

function month(ym: string, index: number): PeriodRef {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return {
    id: uuid(100 + index), periodStart: `${ym}-01`, periodEnd: `${ym}-${String(last).padStart(2, '0')}`,
    fiscalYear: y, fiscalQuarter: Math.floor((m - 1) / 3) + 1, label: ym, isComplete: true,
  };
}
const PERIODS = ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'].map(month);
const P = (ym: string): PeriodRef => PERIODS.find((p) => p.label === ym)!;

function account(id: string, over: Partial<BankAccountRef> = {}): BankAccountRef {
  return {
    id, name: id === A ? 'Main' : id === B ? 'Savings' : id === C ? 'Reserve' : 'Card',
    accountType: 'current', openingBalance: null, openingBalanceDate: null, isActive: true, ...over,
  };
}
const typed = (id: string, value: string, date: string, over: Partial<BankAccountRef> = {}): BankAccountRef =>
  account(id, { openingBalance: value, openingBalanceDate: date, ...over });

let batch = 0;
function st(bankAccountId: string, periodStart: string, periodEnd: string, o: {
  open?: string; close?: string; committedAt?: string; unreconciled?: boolean;
} = {}): StatementRef {
  batch += 1;
  return {
    batchId: uuid(5000 + batch), bankAccountId, periodStart, periodEnd,
    committedAt: o.committedAt ?? '2026-09-10T10:00:00Z',
    openingBalance: o.open ?? null, closingBalance: o.close ?? null, unreconciled: o.unreconciled ?? false,
  };
}
const mv = (bankAccountId: string, date: string, amount: string): DailyMovement => ({ bankAccountId, date, amount });

function context(bankAccounts: readonly BankAccountRef[]): EngineContext {
  return {
    organizationId: uuid(1000), calculationRunId: uuid(9001), aggregatedAt: '2026-09-15T00:00:00Z', asOf: '2026-09-15',
    engineVersion: 'test', accounts: [], costOfSalesEverUsed: true, costOfSalesInInvoices: false, counterparties: [],
    bankAccounts, periods: PERIODS,
    settings: { baseCurrency: 'GBP', fiscalYearStartMonth: 1, timezone: 'Europe/London', vatRegistered: false, defaultVatRate: null, taxableCategories: [] },
  };
}

/** The bank cells `app.aggregate_periods` would produce from the same rows: one per account-month. */
function cellsFor(movements: readonly DailyMovement[], period: PeriodRef): BankAggregateCell[] {
  const byAccount = new Map<string, { inflow: Decimal; outflow: Decimal }>();
  for (const m of movements) {
    if (m.date < period.periodStart || m.date > period.periodEnd) continue;
    const t = byAccount.get(m.bankAccountId) ?? { inflow: new Decimal(0), outflow: new Decimal(0) };
    const amount = parseDecimal(m.amount);
    if (amount.greaterThan(0)) t.inflow = t.inflow.plus(amount); else t.outflow = t.outflow.plus(amount.abs());
    byAccount.set(m.bankAccountId, t);
  }
  return [...byAccount.entries()].map(([bankAccountId, t]) => ({
    periodId: period.id, source: 'bank', standardCategory: 'revenue', accountId: null, counterpartyId: null, bankAccountId,
    balanceKind: null, balanceBasis: null, invoiceType: null, debit: t.inflow.toFixed(2), credit: t.outflow.toFixed(2),
    amount: t.inflow.minus(t.outflow).toFixed(2), rowCount: 1, fallbackRows: 0, minDate: null, maxDate: null,
    transferKind: 'none', unpairedTransferCandidate: false,
  }));
}

interface Org { accounts: BankAccountRef[]; statements: StatementRef[]; movements: DailyMovement[] }

/** The pipeline, month by month: history over all periods, then each period's six metrics. */
function run(org: Org): Map<string, readonly MetricResult[]> {
  const ctx = context(org.accounts);
  const history = buildCashHistory({ bankAccounts: org.accounts, statements: org.statements, movements: org.movements, periods: PERIODS });
  const out = new Map<string, readonly MetricResult[]>();
  for (const period of PERIODS) {
    const [result] = computeCash(ctx, [{ period, movements: cellsFor(org.movements, period), accounts: history.get(period.id)! }]);
    out.set(period.label, result!.metrics);
  }
  return out;
}

const money = (v: string | null): string | null => (v === null ? null : parseDecimal(v).toFixed(2));
function figure(results: Map<string, readonly MetricResult[]>, ym: string, key: string): MetricResult {
  return results.get(ym)!.find((m) => m.key === key)!;
}
const v = (results: Map<string, readonly MetricResult[]>, ym: string, key: string): string | null => money(figure(results, ym, key).value);
/** [opening, net, closing] for a month. */
const row = (results: Map<string, readonly MetricResult[]>, ym: string): Array<string | null> =>
  [v(results, ym, 'opening_cash'), v(results, ym, 'net_cash_movement'), v(results, ym, 'closing_cash')];

// ---------------------------------------------------------------------------------------------
// D-1 — the sixteen shapes
// ---------------------------------------------------------------------------------------------

describe('D-1 · per-account balance history', () => {
  it('1 · a missing statement month (GAP): July is unknown, August restarts at its printed 4,000', () => {
    const r = run({
      accounts: [account(A)],
      statements: [st(A, '2026-06-01', '2026-06-30', { open: '10000' }), st(A, '2026-08-01', '2026-08-31', { open: '4000', close: '3500' })],
      movements: [mv(A, '2026-06-10', '-1000'), mv(A, '2026-08-10', '-500')],
    });
    expect(row(r, '2026-06')).toEqual(['10000.00', '-1000.00', '9000.00']);
    // July's opening is June's stated close; nothing states what moved in July, so no July close.
    expect(row(r, '2026-07')).toEqual(['9000.00', null, null]);
    expect(figure(r, '2026-07', 'closing_cash').dataQuality.missing).toEqual(['no_source_covers_period']);
    expect(figure(r, '2026-07', 'closing_cash').dataQuality.completeness).toBe(0);
    expect(row(r, '2026-08')).toEqual(['4000.00', '-500.00', '3500.00']);
    expect(figure(r, '2026-08', 'opening_cash').assurance).toBe('verified');
  });

  it('2 · a partial-month statement (PARTJUL, 1–15 July): July is unknown, not a verified 7,000', () => {
    const r = run({
      accounts: [account(A)],
      statements: [
        st(A, '2026-06-01', '2026-06-30', { open: '10000', close: '9000' }),
        st(A, '2026-07-01', '2026-07-15', { open: '9000', close: '7000' }),
        st(A, '2026-08-01', '2026-08-31', { open: '4000', close: '3500' }),
      ],
      movements: [mv(A, '2026-06-10', '-1000'), mv(A, '2026-07-05', '-2000'), mv(A, '2026-08-10', '-500')],
    });
    expect(row(r, '2026-06')).toEqual(['10000.00', '-1000.00', '9000.00']);
    expect(row(r, '2026-07')).toEqual(['9000.00', null, null]);
    expect(figure(r, '2026-07', 'net_cash_movement').dataQuality.warnings).toContain('bank_coverage_partial');
    expect(row(r, '2026-08')).toEqual(['4000.00', '-500.00', '3500.00']);
  });

  it('3 · a statement ending mid-month, the next starting the day after (MIDTYPED): continuous, so known', () => {
    const r = run({
      accounts: [typed(A, '10000', '2026-05-31')],
      statements: [
        st(A, '2026-06-01', '2026-06-20', { open: '10000', close: '6000' }),
        st(A, '2026-06-21', '2026-07-31', { open: '6000', close: '5500' }),
        st(A, '2026-08-01', '2026-08-31', { open: '5500', close: '5600' }),
      ],
      movements: [mv(A, '2026-06-10', '-4000'), mv(A, '2026-06-25', '-1000'), mv(A, '2026-07-10', '500'), mv(A, '2026-08-10', '100')],
    });
    expect(row(r, '2026-06')).toEqual(['10000.00', '-5000.00', '5000.00']);
    expect(row(r, '2026-07')).toEqual(['5000.00', '500.00', '5500.00']);
    expect(row(r, '2026-08')).toEqual(['5500.00', '100.00', '5600.00']);
    for (const ym of ['2026-06', '2026-07', '2026-08']) {
      expect(figure(r, ym, 'closing_cash').dataQuality.warnings, ym).not.toContain('statement_balance_mismatch');
    }
  });

  it('4 · a full-month statement', () => {
    const r = run({
      accounts: [account(A)],
      statements: [st(A, '2026-06-01', '2026-06-30', { open: '2500', close: '2800' })],
      movements: [mv(A, '2026-06-03', '700'), mv(A, '2026-06-20', '-400')],
    });
    expect(row(r, '2026-06')).toEqual(['2500.00', '300.00', '2800.00']);
    expect(v(r, '2026-06', 'cash_inflows')).toBe('700.00');
    expect(v(r, '2026-06', 'cash_outflows')).toBe('400.00');
    expect(figure(r, '2026-06', 'closing_cash').assurance).toBe('verified');
    expect(figure(r, '2026-06', 'closing_cash').dataQuality.completeness).toBe(1);
  });

  it('5 · several statements covering one month combine; a gap day between them does not', () => {
    const joined = run({
      accounts: [account(A)],
      statements: [st(A, '2026-06-01', '2026-06-10', { open: '1000' }), st(A, '2026-06-11', '2026-06-30')],
      movements: [mv(A, '2026-06-05', '100'), mv(A, '2026-06-15', '-50')],
    });
    expect(row(joined, '2026-06')).toEqual(['1000.00', '50.00', '1050.00']);

    const holed = run({
      accounts: [account(A)],
      statements: [st(A, '2026-06-01', '2026-06-10', { open: '1000' }), st(A, '2026-06-12', '2026-06-30')],
      movements: [mv(A, '2026-06-05', '100'), mv(A, '2026-06-15', '-50')],
    });
    expect(row(holed, '2026-06')).toEqual(['1000.00', null, null]);
  });

  it('6 · a restart: after a gap only a balance stated exactly at the boundary opens the account', () => {
    // July missing. August's statement prints no opening; the typed balance is dated 31 July: exact.
    const exact = run({
      accounts: [typed(A, '4200', '2026-07-31')],
      statements: [st(A, '2026-06-01', '2026-06-30', { open: '5000' }), st(A, '2026-08-01', '2026-08-31')],
      movements: [mv(A, '2026-08-10', '-200')],
    });
    expect(row(exact, '2026-08')).toEqual(['4200.00', '-200.00', '4000.00']);
    expect(figure(exact, '2026-08', 'opening_cash').assurance).toBe('calculated');

    // The same with nothing stated at 31 July: August's movement is known, its balance is not.
    const none = run({
      accounts: [account(A)],
      statements: [st(A, '2026-06-01', '2026-06-30', { open: '5000' }), st(A, '2026-08-01', '2026-08-31')],
      movements: [mv(A, '2026-08-10', '-200')],
    });
    expect(row(none, '2026-08')).toEqual([null, '-200.00', null]);
    // The account's balance WAS stated (June); what is missing is July — a statement, not an opening.
    expect(figure(none, '2026-08', 'closing_cash').dataQuality.missing).toEqual(['no_source_covers_period']);
    expect(figure(none, '2026-08', 'closing_cash').components.missing_bank_accounts).toEqual([{ account_id: A, name: 'Main' }]);
  });

  it('7 · a stale typed opening balance cannot cross months nothing covers (N-2)', () => {
    // Typed 10,000 at 31 March; statements start 1 June with no printed opening. April and May are
    // uncovered, so the typed figure says nothing about 1 June — the old engine made it June's opening.
    const r = run({
      accounts: [typed(A, '10000', '2026-03-31')],
      statements: [st(A, '2026-06-01', '2026-06-30'), st(A, '2026-07-01', '2026-07-31')],
      movements: [mv(A, '2026-06-10', '-4000'), mv(A, '2026-07-10', '500')],
    });
    expect(row(r, '2026-04')).toEqual(['10000.00', null, null]);
    expect(row(r, '2026-06')).toEqual([null, '-4000.00', null]);
    expect(figure(r, '2026-06', 'opening_cash').dataQuality.missing).toEqual(['no_source_covers_period']);
    expect(row(r, '2026-07')).toEqual([null, '500.00', null]);
  });

  it('8 · an active account with no history makes the total unknown and is named (D-2)', () => {
    const r = run({
      accounts: [account(A), account(B)],
      statements: [st(A, '2026-06-01', '2026-06-30', { open: '1000' })],
      movements: [mv(A, '2026-06-10', '-100')],
    });
    expect(row(r, '2026-06')).toEqual([null, null, null]);
    const opening = figure(r, '2026-06', 'opening_cash');
    // Nothing has EVER stated B's balance: that is an opening balance to give.
    expect(opening.dataQuality.missing).toEqual(['no_opening_cash']);
    expect(opening.components.missing_bank_accounts).toEqual([{ account_id: B, name: 'Savings' }]);
    expect(figure(r, '2026-06', 'net_cash_movement').dataQuality.warnings).toContain('bank_coverage_partial');
  });

  it('9 · a second account added later (NEWACCT): before it starts, the total is the first account', () => {
    // A: typed 10,000 at 28 Feb, statements March–August without printed balances, −500 a month.
    // B: typed 2,000 at 31 July, an August statement, +100.
    const r = run({
      accounts: [typed(A, '10000', '2026-02-28'), typed(B, '2000', '2026-07-31')],
      statements: [
        ...['03', '04', '05', '06', '07', '08'].map((m) => st(A, `2026-${m}-01`, month(`2026-${m}`, 0).periodEnd)),
        st(B, '2026-08-01', '2026-08-31'),
      ],
      movements: [...['03', '04', '05', '06', '07', '08'].map((m) => mv(A, `2026-${m}-10`, '-500')), mv(B, '2026-08-12', '100')],
    });
    expect(row(r, '2026-03')).toEqual(['10000.00', '-500.00', '9500.00']);
    expect(row(r, '2026-07')).toEqual(['8000.00', '-500.00', '7500.00']);
    // August: A 7,500 + B 2,000 = 9,500 open; −500 + 100; A 7,000 + B 2,100 = 9,100 — the audit's truth.
    expect(row(r, '2026-08')).toEqual(['9500.00', '-400.00', '9100.00']);
    expect(figure(r, '2026-08', 'closing_cash').components.per_account).toEqual([
      // Both balances rest on typed opening balances (`calculated`) and CSV rows only.
      { account_id: A, value: '7000.00', assurance: 'calculated', rests_on_statements: [] },
      { account_id: B, value: '2100.00', assurance: 'calculated', rests_on_statements: [] },
    ]);
  });

  it('10 · a closed account counts for the days its statements cover and no further', () => {
    const r = run({
      accounts: [account(A), account(B, { isActive: false })],
      statements: [
        st(A, '2026-06-01', '2026-06-30', { open: '1000' }), st(A, '2026-07-01', '2026-07-31'),
        st(B, '2026-06-01', '2026-06-30', { open: '300', close: '0' }),
      ],
      movements: [mv(B, '2026-06-30', '-300'), mv(A, '2026-06-30', '300')],
    });
    expect(row(r, '2026-06')).toEqual(['1300.00', '0.00', '1300.00']);
    expect(row(r, '2026-07')).toEqual(['1300.00', '0.00', '1300.00']);
    expect((figure(r, '2026-07', 'closing_cash').components.per_account as unknown[]).length).toBe(1);
  });

  it('11 · accounts with different start dates join the total when each starts', () => {
    const r = run({
      accounts: [account(A), typed(B, '500', '2026-06-30')],
      statements: [
        st(A, '2026-06-01', '2026-06-30', { open: '1000' }), st(A, '2026-07-01', '2026-07-31'),
        st(B, '2026-07-01', '2026-07-31'),
      ],
      movements: [mv(A, '2026-07-02', '-100'), mv(B, '2026-07-03', '50')],
    });
    expect(row(r, '2026-06')).toEqual(['1000.00', '0.00', '1000.00']);
    expect(row(r, '2026-07')).toEqual(['1500.00', '-50.00', '1450.00']);
  });

  it('12 · history first, banking later: months before the first statement say nothing covers them', () => {
    const r = run({
      accounts: [account(A)],
      statements: [st(A, '2026-06-01', '2026-06-30', { open: '800' })],
      movements: [mv(A, '2026-06-10', '200')],
    });
    for (const ym of ['2026-03', '2026-04', '2026-05']) {
      expect(row(r, ym), ym).toEqual([null, null, null]);
      expect(figure(r, ym, 'closing_cash').dataQuality.missing, ym).toEqual(['no_source_covers_period']);
    }
    expect(row(r, '2026-06')).toEqual(['800.00', '200.00', '1000.00']);
  });

  it('13 · an organisation with no cash-like account has no cash, not zero cash', () => {
    const r = run({ accounts: [account(CARD, { accountType: 'credit_card' })], statements: [], movements: [] });
    expect(row(r, '2026-06')).toEqual([null, null, null]);
    expect(figure(r, '2026-06', 'closing_cash').dataQuality.missing).toEqual(['no_bank_accounts']);
  });

  it('14 · a genuine 0.00 stated by a statement is 0.00, not NULL', () => {
    const r = run({
      accounts: [account(A)],
      statements: [st(A, '2026-06-01', '2026-06-30', { open: '0', close: '0' })],
      movements: [],
    });
    expect(row(r, '2026-06')).toEqual(['0.00', '0.00', '0.00']);
    expect(figure(r, '2026-06', 'closing_cash').dataQuality.missing).toEqual([]);
  });

  it('15 · a negative (overdrawn) balance is carried as it is', () => {
    const r = run({
      accounts: [account(A)],
      statements: [st(A, '2026-06-01', '2026-07-31', { open: '100' })],
      movements: [mv(A, '2026-06-10', '-600'), mv(A, '2026-07-10', '-50')],
    });
    expect(row(r, '2026-06')).toEqual(['100.00', '-600.00', '-500.00']);
    expect(row(r, '2026-07')).toEqual(['-500.00', '-50.00', '-550.00']);
  });

  it('16 · an empty organisation: no accounts, no statements, no rows — nothing, everywhere', () => {
    const r = run({ accounts: [], statements: [], movements: [] });
    for (const period of PERIODS) {
      expect(row(r, period.label), period.label).toEqual([null, null, null]);
      expect(figure(r, period.label, 'closing_cash').dataQuality.missing).toEqual(['no_bank_accounts']);
      expect(figure(r, period.label, 'cash_runway_months').value).toBeNull();
    }
  });

  it('P-2 · statements running from the 5th to the 4th cover the months between them (CYCLE)', () => {
    // Typed 10,000 at 30 April; statements 5 May–4 Jun, 5 Jun–4 Jul, 5 Jul–4 Aug, 5 Aug–4 Sep.
    const cycles: Array<[string, string, string, number]> = [
      ['2026-05-05', '2026-06-04', '2026-05-10', 10000], ['2026-06-05', '2026-07-04', '2026-06-10', 9000],
      ['2026-07-05', '2026-08-04', '2026-07-10', 8000], ['2026-08-05', '2026-09-04', '2026-08-10', 7000],
    ];
    const r = run({
      accounts: [typed(A, '10000', '2026-04-30')],
      statements: cycles.map(([s, e, , bal]) => st(A, s, e, { open: String(bal), close: String(bal - 1000) })),
      movements: cycles.map(([, , d]) => mv(A, d, '-1000')),
    });
    // May: 1–4 May are covered by nothing, so May's movement is unknown; its opening is typed.
    expect(row(r, '2026-05')).toEqual(['10000.00', null, null]);
    // From June every day is covered by two statements between them; the chain starts at the
    // 5 May statement's printed opening (the close of 4 May).
    expect(row(r, '2026-06')).toEqual(['9000.00', '-1000.00', '8000.00']);
    expect(row(r, '2026-07')).toEqual(['8000.00', '-1000.00', '7000.00']);
    expect(row(r, '2026-08')).toEqual(['7000.00', '-1000.00', '6000.00']);
  });

  it('a printed balance that disagrees with the chain is flagged, and the arithmetic stands (§3.3)', () => {
    const r = run({
      accounts: [account(A)],
      statements: [st(A, '2026-06-01', '2026-06-30', { open: '1000', close: '1200' }), st(A, '2026-07-01', '2026-07-31', { open: '1150' })],
      movements: [mv(A, '2026-06-10', '100')],
    });
    expect(row(r, '2026-06')).toEqual(['1000.00', '100.00', '1100.00']);
    expect(figure(r, '2026-06', 'closing_cash').dataQuality.warnings).toContain('statement_balance_mismatch');
    expect(figure(r, '2026-06', 'closing_cash').components.statement_closing_cash).toBe('1200.00');
    expect(row(r, '2026-07')).toEqual(['1100.00', '0.00', '1100.00']);
  });

  it('N-8 · only a current statement can flag its month unreconciled (UNRECON)', () => {
    const r = run({
      accounts: [typed(A, '1000', '2026-05-31')],
      statements: [
        st(A, '2026-06-01', '2026-06-30', { committedAt: '2026-07-02T09:00:00Z', unreconciled: true }),
        st(A, '2026-06-01', '2026-06-30', { committedAt: '2026-07-03T09:00:00Z', open: '1000', close: '900' }),
      ],
      movements: [mv(A, '2026-06-10', '-100')],
    });
    expect(row(r, '2026-06')).toEqual(['1000.00', '-100.00', '900.00']);
    expect(figure(r, '2026-06', 'closing_cash').dataQuality.warnings).not.toContain('unreconciled_statement');
  });

  it('a transfer between two own accounts in different months shows as money in transit', () => {
    const r = run({
      accounts: [account(A), account(B)],
      statements: [st(A, '2026-06-01', '2026-07-31', { open: '1000' }), st(B, '2026-06-01', '2026-07-31', { open: '0' })],
      movements: [mv(A, '2026-06-30', '-400'), mv(B, '2026-07-01', '400')],
    });
    // The balances are the truth: 600 at the end of June, 1,000 at the end of July.
    expect(v(r, '2026-06', 'closing_cash')).toBe('600.00');
    expect(v(r, '2026-07', 'closing_cash')).toBe('1000.00');
  });

  it('is the same whatever order statements, rows and periods arrive in', () => {
    const statements = [
      st(A, '2026-06-01', '2026-06-20', { open: '10000' }), st(A, '2026-06-21', '2026-07-31', { open: '6000' }),
      st(B, '2026-07-01', '2026-07-31', { open: '50' }),
    ];
    const movements = [mv(A, '2026-06-10', '-4000'), mv(A, '2026-06-25', '-1000'), mv(B, '2026-07-02', '5')];
    const accounts = [account(A), account(B)];
    const forward = buildCashHistory({ bankAccounts: accounts, statements, movements, periods: PERIODS });
    const reversed = buildCashHistory({
      bankAccounts: [...accounts].reverse(), statements: [...statements].reverse(), movements: [...movements].reverse(),
      periods: [...PERIODS].reverse(),
    });
    expect(JSON.stringify([...reversed.entries()].sort())).toBe(JSON.stringify([...forward.entries()].sort()));
  });
});

// ---------------------------------------------------------------------------------------------
// D-2 — scope
// ---------------------------------------------------------------------------------------------

describe('D-2 · which accounts count, and naming the missing one', () => {
  const june = P('2026-06');

  it('an active account with nothing stated is in scope everywhere, never covered', () => {
    expect(accountScope(account(B), [])).toEqual({ start: null, end: null, excluded: false });
    expect(bankCoverageFor([account(B)], [], june)).toEqual({ inScope: [B], covered: [] });
  });

  it('two unknown accounts beside a known one are both named', () => {
    const r = run({
      accounts: [account(A), account(B), account(C)],
      statements: [st(A, '2026-06-01', '2026-06-30', { open: '1' })],
      movements: [],
    });
    expect(figure(r, '2026-06', 'opening_cash').components.missing_bank_accounts)
      .toEqual([{ account_id: B, name: 'Savings' }, { account_id: C, name: 'Reserve' }]);
  });

  it('an account with an opening balance only: known at its start, unknown after it', () => {
    const r = run({ accounts: [typed(A, '750', '2026-05-31')], statements: [], movements: [] });
    expect(row(r, '2026-06')).toEqual(['750.00', null, null]);
    expect(row(r, '2026-07')).toEqual([null, null, null]);
    expect(figure(r, '2026-07', 'opening_cash').components.missing_bank_accounts).toEqual([{ account_id: A, name: 'Main' }]);
  });

  it('an account with statements only (no printed or typed balance): movement known, balance unknown', () => {
    const r = run({ accounts: [account(A)], statements: [st(A, '2026-06-01', '2026-06-30')], movements: [mv(A, '2026-06-02', '10')] });
    expect(row(r, '2026-06')).toEqual([null, '10.00', null]);
    expect(figure(r, '2026-06', 'closing_cash').components.missing_bank_accounts).toEqual([{ account_id: A, name: 'Main' }]);
  });

  it('an account that starts later is out of scope before it starts', () => {
    const scope = accountScope(typed(B, '0', '2026-07-31'), [st(B, '2026-08-01', '2026-08-31')]);
    expect(scope).toEqual({ start: '2026-08-01', end: null, excluded: false });
    expect(bankCoverageFor([typed(B, '0', '2026-07-31')], [], june)).toEqual({ inScope: [], covered: [] });
  });

  it('a closed account ends at its last statement; a closed account never stated is out entirely', () => {
    expect(accountScope(account(B, { isActive: false }), [st(B, '2026-04-01', '2026-06-30')]))
      .toEqual({ start: '2026-04-01', end: '2026-06-30', excluded: false });
    expect(accountScope(account(B, { isActive: false }), [])).toEqual({ start: null, end: null, excluded: true });
  });

  it('credit-card and loan accounts are never in cash scope', () => {
    expect(bankCoverageFor([account(CARD, { accountType: 'credit_card' })], [], june)).toEqual({ inScope: [], covered: [] });
  });
});

describe('the helpers', () => {
  it('merge touching and overlapping ranges into runs', () => {
    expect(coveredRuns([
      { periodStart: '2026-06-11', periodEnd: '2026-06-30' }, { periodStart: '2026-06-01', periodEnd: '2026-06-10' },
      { periodStart: '2026-06-20', periodEnd: '2026-07-05' }, { periodStart: '2026-07-07', periodEnd: '2026-07-31' },
    ])).toEqual([{ start: '2026-06-01', end: '2026-07-05' }, { start: '2026-07-07', end: '2026-07-31' }]);
  });

  it('a statement a later upload of the same range replaces is not current', () => {
    const early = st(A, '2026-06-01', '2026-06-30', { committedAt: '2026-07-01T00:00:00Z' });
    const late = st(A, '2026-06-01', '2026-06-30', { committedAt: '2026-07-02T00:00:00Z' });
    const other = st(A, '2026-07-01', '2026-07-31', { committedAt: '2026-07-01T00:00:00Z' });
    expect(currentStatements([early, late, other])).toEqual([late, other]);
  });
});
