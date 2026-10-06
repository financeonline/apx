import { describe, expect, it } from 'vitest';

import { Decimal } from '@/core/money';

import {
  balancePnlContext, balanceRowsByKind, choosePrecedence, composePeriod, computeCoverage,
  type AccountRef, type AggregateCell, type CoverageBatch, type EngineContext, type MetricResult, type PeriodRef,
} from '@/modules/financial-engine';

/**
 * H-2 (independent audit of step0d-review-frozen): a trial balance's or P&L report's P&L was a
 * verified 0.00. The fold read `debit_total` / `credit_total`, which no import fills, instead of
 * `closing_balance`; §3's differencing (`periodBalancePnlAmount`) had no caller; the batch's basis was
 * hard-coded to "movement"; every report kind covering the month was summed.
 *
 * Every case runs the path the calculation does: coverage → the prior-month facts → compose. The cells
 * are shaped as the aggregate returns imported rows: `amount` = Σ `closing_balance` (natural sign,
 * debit − credit), debit and credit totals 0 because the import never sets them.
 */

const month = (ym: string, n: number): PeriodRef => {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { id: `p-${ym}`, periodStart: `${ym}-01`, periodEnd: `${ym}-${String(last).padStart(2, '0')}`,
    fiscalYear: y, fiscalQuarter: Math.floor((m - 1) / 3) + 1, label: ym, isComplete: true, ...(n ? {} : {}) };
};
const PERIODS = ['2026-05', '2026-06', '2026-07', '2026-08'].map(month);
const [, JUN, JUL, AUG] = PERIODS as [PeriodRef, PeriodRef, PeriodRef, PeriodRef];

const acct = (id: string, category: AccountRef['standardCategory'], type: AccountRef['accountType']): AccountRef =>
  ({ id, code: id, name: id, standardCategory: category, accountType: type, isSystem: false });
const REV = 'a-rev'; const COS = 'a-cos'; const OPEX = 'a-opex'; const MKT = 'a-mkt'; const CASH = 'a-cash'; const EQ = 'a-eq';
const ACCOUNTS = [acct(REV, 'revenue', 'income'), acct(COS, 'cost_of_sales', 'expense'), acct(OPEX, 'operating_expense', 'expense'),
  acct(MKT, 'marketing', 'expense'), acct(CASH, 'cash', 'asset'), acct(EQ, 'equity', 'equity')];

const context = (fiscalYearStartMonth = 1): EngineContext => ({
  organizationId: 'org', calculationRunId: 'run', aggregatedAt: '2026-09-15T00:00:00.000Z', asOf: '2026-09-15', engineVersion: 'test',
  settings: { baseCurrency: 'GBP', fiscalYearStartMonth, timezone: 'Europe/London', vatRegistered: false, defaultVatRate: null, taxableCategories: [] },
  costOfSalesEverUsed: true, costOfSalesInInvoices: false, accounts: ACCOUNTS, counterparties: [], bankAccounts: [], periods: PERIODS,
});

type Kind = 'trial_balance' | 'pnl_report';
const bal = (p: PeriodRef, kind: Kind, basis: 'movement' | 'cumulative', accountId: string, closing: string): AggregateCell => ({
  periodId: p.id, source: 'period_balances', standardCategory: ACCOUNTS.find((a) => a.id === accountId)!.standardCategory,
  accountId, counterpartyId: null, bankAccountId: null, balanceKind: kind, balanceBasis: basis, invoiceType: null,
  transferKind: null, unpairedTransferCandidate: false, debit: '0', credit: '0', amount: closing, rowCount: 1, fallbackRows: 0,
  minDate: null, maxDate: null,
});
const gl = (p: PeriodRef, accountId: string, debit: string, credit: string): AggregateCell => ({
  ...bal(p, 'trial_balance', 'movement', accountId, '0'), source: 'ledger', balanceKind: null, balanceBasis: null,
  debit, credit, amount: new Decimal(debit).minus(credit).toFixed(2),
});
/** `complete`: the reviewer attested at import that the report lists every account (IMP-TB-016, N-1). */
const batch = (id: string, kind: Kind | 'general_ledger', basis: 'movement' | 'cumulative' | null, start: string, end: string,
  fy: number | null = null, rowMonths?: string[], complete = false): CoverageBatch => ({
  id, targetTable: kind === 'general_ledger' ? 'ledger_entries' : 'period_balances', balanceKind: kind === 'general_ledger' ? null : kind,
  balanceBasis: basis, bankAccountId: null, invoiceListKind: null, importType: kind, periodStart: start, periodEnd: end,
  committedAt: '2026-09-10T10:00:00Z', fiscalYearStartMonthAtCommit: fy, ...(rowMonths === undefined ? {} : { rowMonths }),
  ...(kind === 'general_ledger' ? {} : { reportComplete: complete }),
});
const monthly = (prefix: string, kind: Kind, basis: 'movement' | 'cumulative', fy: number | null = null, complete = false) =>
  [JUN, JUL, AUG].map((p) => batch(`${prefix}-${p.label}`, kind, basis, p.periodStart, p.periodEnd, fy, undefined, complete));
/** Attested complete month by month. */
const attested = (prefix: string, kind: Kind, basis: 'movement' | 'cumulative', fy: number | null = null) => monthly(prefix, kind, basis, fy, true);

function run(period: PeriodRef, cells: AggregateCell[], batches: CoverageBatch[], fiscalYearStartMonth = 1): MetricResult[] {
  const rowCounts = {
    period_balances: cells.filter((c) => c.periodId === period.id && c.source === 'period_balances').length,
    ledger: cells.filter((c) => c.periodId === period.id && c.source === 'ledger').length,
  };
  const coverage = computeCoverage({ period, batches, bankAccounts: [], rowCounts, asOf: '2026-09-15',
    balanceRowsByKind: balanceRowsByKind(cells, period.id), balanceCells: cells });
  const index = PERIODS.findIndex((p) => p.id === period.id);
  const balancePnl = balancePnlContext({ period, prior: PERIODS[index - 1], coverage, batches, cells, organisationFiscalYearStartMonth: fiscalYearStartMonth });
  return composePeriod({ period, coverage, cells, transferLegs: [], context: context(fiscalYearStartMonth), balancePnl });
}
const fig = (r: MetricResult[], key: string) => r.find((m) => m.key === key && m.dimensionType === 'none')!;
const v = (r: MetricResult[], key: string) => fig(r, key).value === null ? null : new Decimal(fig(r, key).value!).toFixed(2);

/**
 * Adds, per month, the equity line that makes each month's trial balance balance (Σ closing = 0) —
 * what a report listing every account does. Balance-sheet lines carry no P&L.
 */
const withEquity = (cells: AggregateCell[]): AggregateCell[] => [...cells, ...[...new Set(cells.map((c) => c.periodId))].map((id) => {
  const first = cells.find((c) => c.periodId === id)!;
  const net = cells.filter((c) => c.periodId === id).reduce((t, c) => t.plus(c.amount), new Decimal(0));
  return { ...first, accountId: EQ, standardCategory: 'equity' as const, amount: net.negated().toFixed(2) };
})];

// Revenue 1,000 / 1,100 / 1,210; cost of sales 400 / 440 / 484; operating expense 300 each month.
// These three lines alone: an extract that does NOT balance and need not list every account.
const MOVEMENT: AggregateCell[] = [
  [JUN, '-1000', '400', '300'], [JUL, '-1100', '440', '300'], [AUG, '-1210', '484', '300'],
].flatMap(([p, r, c, o]) => [bal(p as PeriodRef, 'trial_balance', 'movement', REV, r as string),
  bal(p as PeriodRef, 'trial_balance', 'movement', COS, c as string), bal(p as PeriodRef, 'trial_balance', 'movement', OPEX, o as string)]);
// The same business as a year-to-date (cumulative) trial balance, fiscal year from January.
const CUMULATIVE: AggregateCell[] = [
  [JUN, '-1000', '400', '300'], [JUL, '-2100', '840', '600'], [AUG, '-3310', '1324', '900'],
].flatMap(([p, r, c, o]) => [bal(p as PeriodRef, 'trial_balance', 'cumulative', REV, r as string),
  bal(p as PeriodRef, 'trial_balance', 'cumulative', COS, c as string), bal(p as PeriodRef, 'trial_balance', 'cumulative', OPEX, o as string)]);

describe('H-2 · P&L from a MOVEMENT trial balance is its closing balances', () => {
  it.each([[JUN, '1000.00', '400.00', '300.00', '300.00'], [JUL, '1100.00', '440.00', '300.00', '360.00'], [AUG, '1210.00', '484.00', '300.00', '426.00']] as const)(
    '%s', (p, revenue, cos, opex, net) => {
      // Attested complete and balancing: marketing, with no line, is a stated zero.
      const r = run(p, withEquity(MOVEMENT), attested('tbm', 'trial_balance', 'movement'));
      expect([v(r, 'revenue'), v(r, 'cost_of_sales'), v(r, 'operating_expenses'), v(r, 'net_profit')]).toEqual([revenue, cos, opex, net]);
      expect(fig(r, 'revenue').basis).toBe('period_balances');
      expect(fig(r, 'revenue').assurance).toBe('verified');
    });

  it('margins follow: August gross margin 0.60, net margin 426 / 1,210', () => {
    const r = run(AUG, withEquity(MOVEMENT), attested('tbm', 'trial_balance', 'movement'));
    expect(new Decimal(fig(r, 'gross_margin').value!).toFixed(6)).toBe('0.600000');
    expect(new Decimal(fig(r, 'net_margin').value!).toFixed(6)).toBe(new Decimal(426).dividedBy(1210).toFixed(6));
  });

  it('evidence: the winning report kind\'s rows of P, which total the figure', () => {
    const r = run(JUL, MOVEMENT, monthly('tbm', 'trial_balance', 'movement'));
    const q = fig(r, 'revenue').evidenceQuery as { kind: string; descriptor: { filters: Record<string, unknown> } };
    expect(q.kind).toBe('leaf');
    expect(q.descriptor.filters).toMatchObject({ period_ids: [JUL.id], account_ids: [REV], balance_kind: 'trial_balance' });
  });

  it('the same lines NOT attested complete: stated lines stand, a category with no line is NULL, never zero (N-1)', () => {
    const r = run(JUL, MOVEMENT, monthly('tbm', 'trial_balance', 'movement'));
    expect([v(r, 'revenue'), v(r, 'cost_of_sales')]).toEqual(['1100.00', '440.00']);
    // Operating expenses include marketing, which the report has no line for.
    expect(v(r, 'operating_expenses')).toBeNull();
    expect(fig(r, 'operating_expenses').dataQuality.missing).toContain('category_not_in_report');
    expect(v(r, 'net_profit')).toBeNull();
  });

  it('a stated zero is a verified 0.00, not unavailable', () => {
    const cells = withEquity([bal(JUL, 'trial_balance', 'movement', REV, '0'), bal(JUL, 'trial_balance', 'movement', OPEX, '300')]);
    const r = run(JUL, cells, attested('tbm', 'trial_balance', 'movement'));
    expect(v(r, 'revenue')).toBe('0.00');
    expect(fig(r, 'revenue').dataQuality.missing).toEqual([]);
  });
});

describe('H-2 · P&L from a CUMULATIVE trial balance is §3\'s difference', () => {
  const batches = monthly('tbc', 'trial_balance', 'cumulative');

  it('June: no May report and not the fiscal year\'s first month → NULL no_prior_trial_balance, never zero', () => {
    const r = run(JUN, CUMULATIVE, batches);
    expect(v(r, 'revenue')).toBeNull();
    expect(fig(r, 'revenue').dataQuality.missing).toContain('no_prior_trial_balance');
    expect(v(r, 'net_profit')).toBeNull();
  });

  it('July and August: this month\'s year-to-date less last month\'s', () => {
    const complete = attested('tbc', 'trial_balance', 'cumulative');
    const jul = run(JUL, withEquity(CUMULATIVE), complete);
    const aug = run(AUG, withEquity(CUMULATIVE), complete);
    expect([v(jul, 'revenue'), v(jul, 'cost_of_sales'), v(jul, 'operating_expenses')]).toEqual(['1100.00', '440.00', '300.00']);
    expect([v(aug, 'revenue'), v(aug, 'cost_of_sales'), v(aug, 'operating_expenses')]).toEqual(['1210.00', '484.00', '300.00']);
  });

  it('evidence names BOTH periods\' records and the subtraction, never one row selection', () => {
    const q = fig(run(JUL, CUMULATIVE, batches), 'revenue').evidenceQuery as unknown as {
      kind: string; formula: string;
      terms: Array<{ name: string; sign: number; period_id: string | null; descriptor: { filters: Record<string, unknown> } | null; unavailable: string | null }>;
    };
    expect(q.kind).toBe('difference');
    expect(q.formula).toBe('year_to_date - prior_year_to_date');
    expect(q.terms.map((t) => [t.name, t.sign, t.period_id, t.unavailable])).toEqual([
      ['year_to_date', 1, JUL.id, null], ['prior_year_to_date', -1, JUN.id, null],
    ]);
    expect(q.terms[0]!.descriptor!.filters).toMatchObject({ period_ids: [JUL.id], account_ids: [REV], balance_kind: 'trial_balance' });
    expect(q.terms[1]!.descriptor!.filters).toMatchObject({ period_ids: [JUN.id], account_ids: [REV], balance_kind: 'trial_balance' });
  });

  it('N-2: each side states its own expected total in reporting sign — 2,100 and 1,000 — which differ by the figure', () => {
    const r = run(JUL, withEquity(CUMULATIVE), attested('tbc', 'trial_balance', 'cumulative'));
    for (const [key, current, prior] of [['revenue', '2100.00', '1000.00'], ['cost_of_sales', '840.00', '400.00'], ['operating_expenses', '600.00', '300.00']] as const) {
      const q = fig(r, key).evidenceQuery as unknown as { terms: Array<{ expected: string | null }> };
      expect(q.terms.map((t) => t.expected), key).toEqual([current, prior]);
      expect(new Decimal(current).minus(prior).toFixed(2), key).toBe(v(r, key));
    }
  });

  it('N-2: an unavailable side states no expected value', () => {
    const q = fig(run(JUN, CUMULATIVE, batches), 'revenue').evidenceQuery as unknown as { terms: Array<{ expected: string | null }> };
    expect(q.terms.map((t) => t.expected)).toEqual(['1000.00', null]);
  });

  it('with no prior report, the prior term says why it is unavailable', () => {
    const q = fig(run(JUN, CUMULATIVE, batches), 'revenue').evidenceQuery as unknown as { kind: string; terms: Array<{ descriptor: unknown; unavailable: string | null }> } | null;
    expect(q?.kind).toBe('difference');
    expect(q!.terms[1]).toMatchObject({ descriptor: null, unavailable: 'no_prior_trial_balance' });
  });

  it('the fiscal year resets where the BATCH froze it: with a June year start, June is its own closing', () => {
    const r = run(JUN, CUMULATIVE, monthly('tbf', 'trial_balance', 'cumulative', 6));
    expect(v(r, 'revenue')).toBe('1000.00');
    expect(fig(r, 'revenue').evidenceQuery).not.toBeNull();
  });

  /** Adds the balancing line that makes a month's trial balance balance (Σ debit − credit = 0). */
  const balanced = (cells: AggregateCell[], p: PeriodRef): AggregateCell[] => {
    const net = cells.filter((c) => c.periodId === p.id).reduce((t, c) => t.plus(c.amount), new Decimal(0));
    return [...cells, bal(p, 'trial_balance', 'cumulative', EQ, net.negated().toFixed(2))];
  };

  it('an account the prior report lacks is a zero ONLY when both reports are attested complete and balance', () => {
    const july = balanced(CUMULATIVE.filter((c) => c.periodId === JUL.id), JUL);
    const aug = balanced([...CUMULATIVE.filter((c) => c.periodId === AUG.id), bal(AUG, 'trial_balance', 'cumulative', MKT, '75')], AUG);
    expect(v(run(AUG, [...july, ...aug], attested('tbc', 'trial_balance', 'cumulative')), 'operating_expenses')).toBe('375.00');
    // Balancing alone is not completeness (N-1): the same rows, not attested.
    const unattested = run(AUG, [...july, ...aug], batches);
    expect(v(unattested, 'operating_expenses')).toBeNull();
    expect(fig(unattested, 'operating_expenses').dataQuality.missing).toContain('account_absent_unconfirmed');
  });

  it('…and is NULL account_absent_unconfirmed when the prior report does not establish completeness', () => {
    const r = run(AUG, [...CUMULATIVE, bal(AUG, 'trial_balance', 'cumulative', MKT, '75')], batches);
    expect(v(r, 'operating_expenses')).toBeNull();
    expect(fig(r, 'operating_expenses').dataQuality.missing).toContain('account_absent_unconfirmed');
  });

  it('an account this month\'s report lacks (but last month stated) is −prior only when this report balances', () => {
    const july = [...CUMULATIVE.filter((c) => c.periodId === JUL.id), bal(JUL, 'trial_balance', 'cumulative', MKT, '50')];
    const augComplete = balanced(CUMULATIVE.filter((c) => c.periodId === AUG.id), AUG);
    expect(v(run(AUG, [...july, ...augComplete], attested('tbc', 'trial_balance', 'cumulative')), 'operating_expenses')).toBe('250.00');
    const r = run(AUG, [...july, ...CUMULATIVE.filter((c) => c.periodId === AUG.id)], batches);
    expect(v(r, 'operating_expenses')).toBeNull();
    expect(fig(r, 'operating_expenses').dataQuality.missing).toContain('account_absent_unconfirmed');
  });

  it('a P&L report never establishes completeness: an account it adds is NULL, not an inferred zero', () => {
    const cells = [bal(JUL, 'pnl_report', 'cumulative', REV, '-2100'), bal(AUG, 'pnl_report', 'cumulative', REV, '-3310'),
      bal(AUG, 'pnl_report', 'cumulative', MKT, '75')];
    const prBatches = [JUL, AUG].map((p) => batch(`pr-${p.label}`, 'pnl_report', 'cumulative', p.periodStart, p.periodEnd));
    const r = run(AUG, cells, prBatches);
    expect(v(r, 'revenue')).toBe('1210.00');
    expect(v(r, 'operating_expenses')).toBeNull();
    expect(fig(r, 'operating_expenses').dataQuality.missing).toContain('account_absent_unconfirmed');
  });

  it('a prior month on another BASIS is not a prior: NULL, never a cross-basis difference', () => {
    const cells = [...MOVEMENT.filter((c) => c.periodId === JUN.id), ...CUMULATIVE.filter((c) => c.periodId === JUL.id)];
    const mixed = [batch('m-jun', 'trial_balance', 'movement', JUN.periodStart, JUN.periodEnd), batch('c-jul', 'trial_balance', 'cumulative', JUL.periodStart, JUL.periodEnd)];
    const r = run(JUL, cells, mixed);
    expect(v(r, 'revenue')).toBeNull();
    expect(fig(r, 'revenue').dataQuality.missing).toContain('no_prior_trial_balance');
  });
});

describe('H-2 · which source and which report states the P&L', () => {
  it('a trial balance beside a P&L report: the trial balance alone (§2.2 kind precedence), never their sum', () => {
    const cells = [...withEquity(MOVEMENT), bal(JUL, 'pnl_report', 'movement', REV, '-9999')];
    const batches = [...attested('tbm', 'trial_balance', 'movement'), batch('pr-jul', 'pnl_report', 'movement', JUL.periodStart, JUL.periodEnd)];
    expect(v(run(JUL, cells, batches), 'revenue')).toBe('1100.00');
  });

  it('a P&L report alone states the P&L', () => {
    const cells = [bal(JUL, 'pnl_report', 'movement', REV, '-1100'), bal(JUL, 'pnl_report', 'movement', COS, '440')];
    const r = run(JUL, cells, [batch('pr-jul', 'pnl_report', 'movement', JUL.periodStart, JUL.periodEnd)]);
    expect([v(r, 'revenue'), v(r, 'cost_of_sales')]).toEqual(['1100.00', '440.00']);
    expect((fig(r, 'revenue').evidenceQuery as { descriptor: { filters: Record<string, unknown> } }).descriptor.filters.balance_kind).toBe('pnl_report');
  });

  it('a report whose range spans the month but whose rows are all in another month is unavailable there: the ledger states it', () => {
    const cells = [bal(AUG, 'trial_balance', 'movement', REV, '-1210'), gl(JUN, REV, '0', '700'), gl(JUN, OPEX, '200', '0')];
    const batches = [batch('tb-q', 'trial_balance', 'movement', '2026-06-01', '2026-08-31', null, ['2026-08-01']),
      batch('gl', 'general_ledger', null, '2026-06-01', '2026-06-30')];
    const r = run(JUN, cells, batches);
    expect(fig(r, 'revenue').basis).toBe('ledger');
    expect(v(r, 'revenue')).toBe('700.00');
  });

  it('a complete report stating a genuine ZERO P&L for the month keeps it: never revives the ledger', () => {
    // July's trial balance has rows — only balance-sheet lines, so no income or expense that month.
    const cells = [bal(JUL, 'trial_balance', 'movement', CASH, '500'), bal(JUL, 'trial_balance', 'movement', EQ, '-500'),
      gl(JUL, REV, '0', '700')];
    const batches = [batch('tb-jul', 'trial_balance', 'movement', JUL.periodStart, JUL.periodEnd, null, ['2026-07-01'], true),
      batch('gl', 'general_ledger', null, '2026-07-01', '2026-07-31')];
    const r = run(JUL, cells, batches);
    expect(fig(r, 'revenue').basis).toBe('period_balances');
    expect(v(r, 'revenue')).toBe('0.00');
  });

  it('a report line of 0.00 is a row: the month is stated as zero', () => {
    const cells = [bal(JUL, 'trial_balance', 'movement', REV, '0'), gl(JUL, REV, '0', '700')];
    const batches = [batch('tb-jul', 'trial_balance', 'movement', JUL.periodStart, JUL.periodEnd, null, ['2026-07-01'], true),
      batch('gl', 'general_ledger', null, '2026-07-01', '2026-07-31')];
    expect(v(run(JUL, cells, batches), 'revenue')).toBe('0.00');
  });

  it('with rows, the trial balance outranks the ledger (§2.3), unchanged', () => {
    const cells = [...withEquity(MOVEMENT), gl(JUL, REV, '0', '700')];
    const batches = [...attested('tbm', 'trial_balance', 'movement'), batch('gl', 'general_ledger', null, '2026-07-01', '2026-07-31')];
    const r = run(JUL, cells, batches);
    expect(fig(r, 'revenue').basis).toBe('period_balances');
    expect(v(r, 'revenue')).toBe('1100.00');
  });
});

/**
 * N-1 (re-review of 39711f5): an absent category is not automatically zero. Completeness for a report,
 * period and category is established only by the reviewer's attestation at import (IMP-TB-016) and, for
 * a trial balance, by the report balancing as well. Row presence, balancing alone or a declared range
 * never establish it. Every expected figure below is worked from the lines, by hand.
 */
describe('N-1 · report completeness decides what an absent category means, and which source wins', () => {
  const tb = (p: PeriodRef, accountId: string, amount: string, basis: 'movement' | 'cumulative' = 'movement') =>
    bal(p, 'trial_balance', basis, accountId, amount);
  const julTb = (complete: boolean) => [batch('tb-jul', 'trial_balance', 'movement', JUL.periodStart, JUL.periodEnd, null, ['2026-07-01'], complete)];

  it('cash-only trial balance, not attested: revenue and net profit NULL category_not_in_report, never 0.00', () => {
    const r = run(JUL, [tb(JUL, CASH, '500'), tb(JUL, EQ, '-500')], julTb(false));
    for (const key of ['revenue', 'net_profit']) {
      expect(v(r, key), key).toBeNull();
      expect(fig(r, key).dataQuality.missing, key).toContain('category_not_in_report');
    }
  });

  it('cash-only trial balance, attested and balancing: no P&L that month, a verified 0.00', () => {
    const r = run(JUL, [tb(JUL, CASH, '500'), tb(JUL, EQ, '-500')], julTb(true));
    expect([v(r, 'revenue'), v(r, 'operating_expenses'), v(r, 'net_profit')]).toEqual(['0.00', '0.00', '0.00']);
    expect(fig(r, 'revenue').assurance).toBe('verified');
  });

  it('cash-only trial balance attested but NOT balancing: still incomplete — balancing is required too', () => {
    const r = run(JUL, [tb(JUL, CASH, '500')], julTb(true));
    expect(v(r, 'revenue')).toBeNull();
    // NF-6: the reason says what is wrong — answered complete, but the lines do not balance.
    expect(fig(r, 'revenue').dataQuality.missing).toContain('trial_balance_not_balanced');
  });

  it('expenses-only P&L report, not attested: cost of sales 400 stated; revenue NULL, not 0; net profit NULL', () => {
    const cells = [bal(JUL, 'pnl_report', 'movement', COS, '400'), bal(JUL, 'pnl_report', 'movement', OPEX, '300')];
    const r = run(JUL, cells, [batch('pr-jul', 'pnl_report', 'movement', JUL.periodStart, JUL.periodEnd, null, ['2026-07-01'])]);
    expect(v(r, 'cost_of_sales')).toBe('400.00');
    expect(v(r, 'revenue')).toBeNull();
    expect(fig(r, 'revenue').dataQuality.missing).toContain('category_not_in_report');
    expect(v(r, 'net_profit')).toBeNull();
  });

  it('expenses-only P&L report, attested complete: revenue 0.00, expenses 300, net profit −700 (a P&L report need not balance)', () => {
    const cells = [bal(JUL, 'pnl_report', 'movement', COS, '400'), bal(JUL, 'pnl_report', 'movement', OPEX, '300')];
    const r = run(JUL, cells, [batch('pr-jul', 'pnl_report', 'movement', JUL.periodStart, JUL.periodEnd, null, ['2026-07-01'], true)]);
    expect([v(r, 'revenue'), v(r, 'cost_of_sales'), v(r, 'operating_expenses'), v(r, 'net_profit')]).toEqual(['0.00', '400.00', '300.00', '-700.00']);
  });

  it('explicit zero revenue in a complete report: 0.00 verified, and the ledger\'s 700 is NOT revived', () => {
    const cells = [tb(JUL, REV, '0'), tb(JUL, OPEX, '300'), tb(JUL, CASH, '-300'), gl(JUL, REV, '0', '700')];
    const r = run(JUL, cells, [...julTb(true), batch('gl', 'general_ledger', null, '2026-07-01', '2026-07-31')]);
    expect(fig(r, 'revenue').basis).toBe('period_balances');
    expect(v(r, 'revenue')).toBe('0.00');
    expect(fig(r, 'revenue').dataQuality.missing).toEqual([]);
    expect(v(r, 'net_profit')).toBe('-300.00');
  });

  it('partial cumulative reports: an absent category is a zero only when BOTH months are attested complete', () => {
    // Year to date: July revenue 2,100 and opex 600; August states revenue 3,310 and no opex line at all.
    const july = withEquity([tb(JUL, REV, '-2100', 'cumulative'), tb(JUL, OPEX, '600', 'cumulative')]);
    const aug = withEquity([tb(AUG, REV, '-3310', 'cumulative')]);
    const both = [batch('c-jul', 'trial_balance', 'cumulative', JUL.periodStart, JUL.periodEnd, null, undefined, true),
      batch('c-aug', 'trial_balance', 'cumulative', AUG.periodStart, AUG.periodEnd, null, undefined, true)];
    // Both complete: August's opex year to date is 0, so the month is 0 − 600 = −600 (a reversal), net 1,210 + 600.
    const complete = run(AUG, [...july, ...aug], both);
    expect([v(complete, 'revenue'), v(complete, 'operating_expenses'), v(complete, 'net_profit')]).toEqual(['1210.00', '-600.00', '1810.00']);
    // August not attested: the absent opex is unknown.
    const augPartial = run(AUG, [...july, ...aug], [both[0]!, { ...both[1]!, reportComplete: false }]);
    expect(v(augPartial, 'revenue')).toBe('1210.00');
    expect(v(augPartial, 'operating_expenses')).toBeNull();
    expect(v(augPartial, 'net_profit')).toBeNull();
    // July not attested: August's absent marketing cannot be differenced against a July that may omit it.
    const julPartial = run(AUG, [...july, ...aug], [{ ...both[0]!, reportComplete: false }, both[1]!]);
    expect(v(julPartial, 'operating_expenses')).toBeNull();
    // NF-6: August is complete; the reason names last month's report as the one that is not.
    expect(fig(julPartial, 'operating_expenses').dataQuality.missing.some((m) => m === 'prior_report_not_complete' || m === 'account_absent_unconfirmed')).toBe(true);
  });

  it('missing accounts between cumulative periods: marketing stated in July only — −50 in August only when both are complete', () => {
    const july = withEquity([tb(JUL, REV, '-2100', 'cumulative'), tb(JUL, OPEX, '600', 'cumulative'), tb(JUL, MKT, '50', 'cumulative')]);
    const aug = withEquity([tb(AUG, REV, '-3310', 'cumulative'), tb(AUG, OPEX, '900', 'cumulative')]);
    const make = (jul: boolean, augC: boolean) => [batch('c-jul', 'trial_balance', 'cumulative', JUL.periodStart, JUL.periodEnd, null, undefined, jul),
      batch('c-aug', 'trial_balance', 'cumulative', AUG.periodStart, AUG.periodEnd, null, undefined, augC)];
    expect(v(run(AUG, [...july, ...aug], make(true, true)), 'operating_expenses')).toBe('250.00'); // 300 − 50
    const r = run(AUG, [...july, ...aug], make(true, false));
    expect(v(r, 'operating_expenses')).toBeNull();
    expect(fig(r, 'operating_expenses').dataQuality.missing).toContain('account_absent_unconfirmed');
  });

  it('usable ledger beside an INCOMPLETE higher-priority report: the ledger states the whole P&L, never mixed', () => {
    // The report: revenue 1,100 only. The ledger: revenue 700, expense 200. Not 1,100, not 1,800.
    const cells = [tb(JUL, REV, '-1100'), gl(JUL, REV, '0', '700'), gl(JUL, OPEX, '200', '0')];
    const r = run(JUL, cells, [...julTb(false), batch('gl', 'general_ledger', null, '2026-07-01', '2026-07-31')]);
    expect(fig(r, 'revenue').basis).toBe('ledger');
    expect(fig(r, 'revenue').assurance).toBe('calculated');
    expect([v(r, 'revenue'), v(r, 'operating_expenses'), v(r, 'net_profit')]).toEqual(['700.00', '200.00', '500.00']);
    expect(fig(r, 'revenue').dataQuality.warnings).toContain('balance_report_incomplete');
  });

  it('an incomplete report with only the bank beside it keeps the report: the cash proxy never displaces it', () => {
    const bank = { id: 'ba-1', name: 'Current', accountType: 'current' as const, openingBalance: null, openingBalanceDate: null, isActive: true };
    const statement: CoverageBatch = { id: 'st', targetTable: 'bank_transactions', balanceKind: null, balanceBasis: null, bankAccountId: bank.id,
      invoiceListKind: null, importType: 'bank_statement', periodStart: JUL.periodStart, periodEnd: JUL.periodEnd, committedAt: '2026-09-10T10:00:00Z' };
    const cells = [tb(JUL, REV, '-1100')];
    const coverage = computeCoverage({ period: JUL, batches: [...julTb(false), statement], bankAccounts: [bank], rowCounts: { period_balances: 1 },
      asOf: '2026-09-15', balanceRowsByKind: balanceRowsByKind(cells, JUL.id), balanceCells: cells });
    expect(choosePrecedence(coverage, 'pnl').basis).toBe('period_balances');
    expect(coverage.bySource.period_balances.reportComplete).toBe(false);
  });
});

/**
 * Step 0F follow-up: the owner's per-month attestation for an existing import, the two reasons an
 * absent category is unknown, and the rule that completeness never raises assurance.
 */
describe('report completeness per month, and completeness is not accuracy', () => {
  const tb = (p: PeriodRef, accountId: string, amount: string) => bal(p, 'trial_balance', 'movement', accountId, amount);
  const julCells = [tb(JUL, REV, '-1100'), tb(JUL, OPEX, '300'), tb(JUL, CASH, '800')];
  const withMonths = (map: Record<string, 'complete' | 'partial'> | null, recordAssurance: 'verified' | 'inferred' = 'verified'): CoverageBatch => ({
    ...batch('tb-jul', 'trial_balance', 'movement', JUL.periodStart, JUL.periodEnd, null, ['2026-07-01']),
    reportComplete: undefined, completenessByMonth: map, recordAssurance,
  });

  it('never answered → NULL report_completeness_unconfirmed (a confirmation is still possible)', () => {
    const r = run(JUL, julCells, [withMonths({})]);
    expect(v(r, 'net_profit')).toBeNull();
    expect(fig(r, 'net_profit').dataQuality.missing).toContain('report_completeness_unconfirmed');
  });

  it('answered partial for the month → NULL category_not_in_report', () => {
    const r = run(JUL, julCells, [withMonths({ '2026-07-01': 'partial' })]);
    expect(fig(r, 'net_profit').dataQuality.missing).toContain('category_not_in_report');
    expect(fig(r, 'net_profit').dataQuality.missing).not.toContain('report_completeness_unconfirmed');
  });

  it('confirmed complete for THIS month → absent categories are zero: net profit 1,100 − 300 = 800', () => {
    expect(v(run(JUL, julCells, [withMonths({ '2026-07-01': 'complete' })]), 'net_profit')).toBe('800.00');
  });

  it('confirmed for ANOTHER month only → this month is still unconfirmed', () => {
    const r = run(JUL, julCells, [withMonths({ '2026-08-01': 'complete' })]);
    expect(fig(r, 'net_profit').dataQuality.missing).toContain('report_completeness_unconfirmed');
  });

  it('an AI-read report confirmed complete: every figure, the zeros included, stays inferred', () => {
    const r = run(JUL, julCells, [withMonths({ '2026-07-01': 'complete' }, 'inferred')]);
    expect([v(r, 'revenue'), v(r, 'net_profit')]).toEqual(['1100.00', '800.00']);
    for (const key of ['revenue', 'operating_expenses', 'net_profit']) expect(fig(r, key).assurance, key).toBe('inferred');
  });

  it('a cumulative month rests on the PRIOR report too: an AI-read June makes July inferred', () => {
    const cells = [bal(JUN, 'trial_balance', 'cumulative', REV, '-1000'), bal(JUN, 'trial_balance', 'cumulative', CASH, '1000'),
      bal(JUL, 'trial_balance', 'cumulative', REV, '-2100'), bal(JUL, 'trial_balance', 'cumulative', CASH, '2100')];
    const b = (p: PeriodRef, ra: 'verified' | 'inferred'): CoverageBatch => ({
      ...batch(`c-${p.label}`, 'trial_balance', 'cumulative', p.periodStart, p.periodEnd, null, [p.periodStart]),
      reportComplete: undefined, completenessByMonth: { [p.periodStart]: 'complete' }, recordAssurance: ra });
    const r = run(JUL, cells, [b(JUN, 'inferred'), b(JUL, 'verified')]);
    expect(v(r, 'revenue')).toBe('1100.00');
    expect(fig(r, 'revenue').assurance).toBe('inferred');
  });
});

/**
 * NF-4 (review of 6a551de, CUMMIX): a cumulative July over a PARTIAL June is unknown, so a ledger
 * covering July states it — the pass-over judged only July's report and left July NULL.
 */
describe('NF-4 · a cumulative month is only as complete as the prior month\'s report', () => {
  const cum = (p: PeriodRef, complete: boolean): CoverageBatch => ({
    ...batch(`c-${p.label}`, 'trial_balance', 'cumulative', p.periodStart, p.periodEnd, null, [p.periodStart]), reportComplete: complete });
  const cells = [bal(JUN, 'trial_balance', 'cumulative', REV, '-1000'), bal(JUN, 'trial_balance', 'cumulative', CASH, '1000'),
    bal(JUL, 'trial_balance', 'cumulative', REV, '-2100'), bal(JUL, 'trial_balance', 'cumulative', CASH, '2100')];
  const gl = batch('gl', 'general_ledger', null, '2026-06-01', '2026-08-31');
  const coverage = (juneComplete: boolean) => computeCoverage({ period: JUL, batches: [cum(JUN, juneComplete), cum(JUL, true), gl],
    bankAccounts: [], rowCounts: { period_balances: 2, ledger: 4 }, asOf: '2026-09-15',
    balanceRowsByKind: balanceRowsByKind(cells, JUL.id), balanceCells: cells, prior: JUN, organisationFiscalYearStartMonth: 1 });

  it('June partial, July complete, a ledger covering July → the ledger states July', () => {
    expect(choosePrecedence(coverage(false), 'pnl').basis).toBe('ledger');
    expect(choosePrecedence(coverage(false), 'pnl').warnings).toContain('balance_report_incomplete');
  });

  it('both complete → the report states July (control)', () => {
    expect(choosePrecedence(coverage(true), 'pnl').basis).toBe('period_balances');
  });
});

describe('NF-7 · a zero that rests on a completeness confirmation says so', () => {
  it('a complete report with categories it has no line for: every P&L figure carries zero_by_completeness', () => {
    const r = run(JUL, withEquity(MOVEMENT), attested('tbm', 'trial_balance', 'movement'));
    for (const key of ['revenue', 'operating_expenses', 'net_profit']) {
      expect(fig(r, key).dataQuality.warnings, key).toContain('zero_by_completeness');
    }
  });

  it('a report not confirmed complete carries no such warning (its gaps are NULL instead)', () => {
    const r = run(JUL, MOVEMENT, monthly('tbm', 'trial_balance', 'movement'));
    expect(fig(r, 'revenue').dataQuality.warnings).not.toContain('zero_by_completeness');
  });
});
