import { describe, expect, it } from 'vitest';

import { Decimal } from '@/core/money';

import {
  balancePnlContext, balanceRowsByKind, composePeriod, computeCoverage,
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
const batch = (id: string, kind: Kind | 'general_ledger', basis: 'movement' | 'cumulative' | null, start: string, end: string,
  fy: number | null = null, rowMonths?: string[]): CoverageBatch => ({
  id, targetTable: kind === 'general_ledger' ? 'ledger_entries' : 'period_balances', balanceKind: kind === 'general_ledger' ? null : kind,
  balanceBasis: basis, bankAccountId: null, invoiceListKind: null, importType: kind, periodStart: start, periodEnd: end,
  committedAt: '2026-09-10T10:00:00Z', fiscalYearStartMonthAtCommit: fy, ...(rowMonths === undefined ? {} : { rowMonths }),
});
const monthly = (prefix: string, kind: Kind, basis: 'movement' | 'cumulative', fy: number | null = null) =>
  [JUN, JUL, AUG].map((p) => batch(`${prefix}-${p.label}`, kind, basis, p.periodStart, p.periodEnd, fy));

function run(period: PeriodRef, cells: AggregateCell[], batches: CoverageBatch[], fiscalYearStartMonth = 1): MetricResult[] {
  const rowCounts = {
    period_balances: cells.filter((c) => c.periodId === period.id && c.source === 'period_balances').length,
    ledger: cells.filter((c) => c.periodId === period.id && c.source === 'ledger').length,
  };
  const coverage = computeCoverage({ period, batches, bankAccounts: [], rowCounts, asOf: '2026-09-15', balanceRowsByKind: balanceRowsByKind(cells, period.id) });
  const index = PERIODS.findIndex((p) => p.id === period.id);
  const balancePnl = balancePnlContext({ period, prior: PERIODS[index - 1], coverage, batches, cells, organisationFiscalYearStartMonth: fiscalYearStartMonth });
  return composePeriod({ period, coverage, cells, transferLegs: [], context: context(fiscalYearStartMonth), balancePnl });
}
const fig = (r: MetricResult[], key: string) => r.find((m) => m.key === key && m.dimensionType === 'none')!;
const v = (r: MetricResult[], key: string) => fig(r, key).value === null ? null : new Decimal(fig(r, key).value!).toFixed(2);

// Revenue 1,000 / 1,100 / 1,210; cost of sales 400 / 440 / 484; operating expense 300 each month.
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
      const r = run(p, MOVEMENT, monthly('tbm', 'trial_balance', 'movement'));
      expect([v(r, 'revenue'), v(r, 'cost_of_sales'), v(r, 'operating_expenses'), v(r, 'net_profit')]).toEqual([revenue, cos, opex, net]);
      expect(fig(r, 'revenue').basis).toBe('period_balances');
      expect(fig(r, 'revenue').assurance).toBe('verified');
    });

  it('margins follow: August gross margin 0.60, net margin 426 / 1,210', () => {
    const r = run(AUG, MOVEMENT, monthly('tbm', 'trial_balance', 'movement'));
    expect(new Decimal(fig(r, 'gross_margin').value!).toFixed(6)).toBe('0.600000');
    expect(new Decimal(fig(r, 'net_margin').value!).toFixed(6)).toBe(new Decimal(426).dividedBy(1210).toFixed(6));
  });

  it('evidence: the winning report kind\'s rows of P, which total the figure', () => {
    const r = run(JUL, MOVEMENT, monthly('tbm', 'trial_balance', 'movement'));
    const q = fig(r, 'revenue').evidenceQuery as { kind: string; descriptor: { filters: Record<string, unknown> } };
    expect(q.kind).toBe('leaf');
    expect(q.descriptor.filters).toMatchObject({ period_ids: [JUL.id], account_ids: [REV], balance_kind: 'trial_balance' });
  });

  it('a stated zero is a verified 0.00, not unavailable', () => {
    const cells = [bal(JUL, 'trial_balance', 'movement', REV, '0'), bal(JUL, 'trial_balance', 'movement', OPEX, '300')];
    const r = run(JUL, cells, monthly('tbm', 'trial_balance', 'movement'));
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
    const jul = run(JUL, CUMULATIVE, batches);
    const aug = run(AUG, CUMULATIVE, batches);
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

  it('an account the prior report lacks is a zero ONLY when that report balances (it lists every account)', () => {
    const july = balanced(CUMULATIVE.filter((c) => c.periodId === JUL.id), JUL);
    const aug = balanced([...CUMULATIVE.filter((c) => c.periodId === AUG.id), bal(AUG, 'trial_balance', 'cumulative', MKT, '75')], AUG);
    expect(v(run(AUG, [...july, ...aug], batches), 'operating_expenses')).toBe('375.00');
  });

  it('…and is NULL account_absent_unconfirmed when the prior report does not establish completeness', () => {
    const r = run(AUG, [...CUMULATIVE, bal(AUG, 'trial_balance', 'cumulative', MKT, '75')], batches);
    expect(v(r, 'operating_expenses')).toBeNull();
    expect(fig(r, 'operating_expenses').dataQuality.missing).toContain('account_absent_unconfirmed');
  });

  it('an account this month\'s report lacks (but last month stated) is −prior only when this report balances', () => {
    const july = [...CUMULATIVE.filter((c) => c.periodId === JUL.id), bal(JUL, 'trial_balance', 'cumulative', MKT, '50')];
    const augComplete = balanced(CUMULATIVE.filter((c) => c.periodId === AUG.id), AUG);
    expect(v(run(AUG, [...july, ...augComplete], batches), 'operating_expenses')).toBe('250.00');
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
    const cells = [...MOVEMENT, bal(JUL, 'pnl_report', 'movement', REV, '-9999')];
    const batches = [...monthly('tbm', 'trial_balance', 'movement'), batch('pr-jul', 'pnl_report', 'movement', JUL.periodStart, JUL.periodEnd)];
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
    const batches = [batch('tb-jul', 'trial_balance', 'movement', JUL.periodStart, JUL.periodEnd, null, ['2026-07-01']),
      batch('gl', 'general_ledger', null, '2026-07-01', '2026-07-31')];
    const r = run(JUL, cells, batches);
    expect(fig(r, 'revenue').basis).toBe('period_balances');
    expect(v(r, 'revenue')).toBe('0.00');
  });

  it('a report line of 0.00 is a row: the month is stated as zero', () => {
    const cells = [bal(JUL, 'trial_balance', 'movement', REV, '0'), gl(JUL, REV, '0', '700')];
    const batches = [batch('tb-jul', 'trial_balance', 'movement', JUL.periodStart, JUL.periodEnd, null, ['2026-07-01']),
      batch('gl', 'general_ledger', null, '2026-07-01', '2026-07-31')];
    expect(v(run(JUL, cells, batches), 'revenue')).toBe('0.00');
  });

  it('with rows, the trial balance outranks the ledger (§2.3), unchanged', () => {
    const cells = [...MOVEMENT, gl(JUL, REV, '0', '700')];
    const batches = [...monthly('tbm', 'trial_balance', 'movement'), batch('gl', 'general_ledger', null, '2026-07-01', '2026-07-31')];
    const r = run(JUL, cells, batches);
    expect(fig(r, 'revenue').basis).toBe('period_balances');
    expect(v(r, 'revenue')).toBe('1100.00');
  });
});
