import { describe, expect, it } from 'vitest';
import {
  computeBalanceSheetFigures, computeDebtBalance, ENGINE_VERSION,
  type AccountRef, type AggregateCell, type CoverageBatch, type EngineContext, type MetricResult, type PeriodRef,
} from '@/modules/financial-engine';

/**
 * Assets and loans by security (ADR-156). Natural sign is debit − credit: an asset is positive, a
 * liability owed negative; the figures report both positive. Every expected figure is worked by hand.
 */

const aug: PeriodRef = { id: 'p-aug', periodStart: '2026-08-01', periodEnd: '2026-08-31', fiscalYear: 2026, fiscalQuarter: 3, label: 'Aug 2026', isComplete: true };
const account = (id: string, category: AccountRef['standardCategory'], type: AccountRef['accountType'], loanSecurity: AccountRef['loanSecurity'] = null): AccountRef =>
  ({ id, code: null, name: id, standardCategory: category, accountType: type, isSystem: false, loanSecurity });

const ACCOUNTS: AccountRef[] = [
  account('a-van', 'fixed_asset', 'asset'),
  account('a-deposit', 'other_asset', 'asset'),
  account('a-cash', 'cash', 'asset'),
  account('a-debtors', 'receivables', 'asset'),
  account('a-stock', 'inventory', 'asset'),
  account('a-prepay', 'other_current_asset', 'asset'),
  account('a-mortgage', 'long_term_liability', 'liability', 'secured'),
  account('a-hp', 'loan', 'liability', 'secured'),
  account('a-director', 'loan', 'liability', 'unsecured'),
  account('a-bounce', 'loan', 'liability'),
  account('a-creditors', 'payables', 'liability'),
  account('a-eq', 'equity', 'equity'),
];

const ctx = (over: Partial<EngineContext> = {}): EngineContext => ({
  organizationId: 'org', calculationRunId: 'run', aggregatedAt: '2026-09-15T00:00:00Z', asOf: '2026-09-15', engineVersion: ENGINE_VERSION,
  settings: { baseCurrency: 'GBP', fiscalYearStartMonth: 1, timezone: 'Europe/London', vatRegistered: false, defaultVatRate: null, taxableCategories: [] },
  costOfSalesEverUsed: false, costOfSalesInInvoices: false,
  accounts: ACCOUNTS, counterparties: [], bankAccounts: [], periods: [aug], ...over,
});

const batch = (kind: 'trial_balance' | 'balance_sheet', over: Partial<CoverageBatch> = {}): CoverageBatch => ({
  id: `b-${kind}`, targetTable: 'period_balances', balanceKind: kind, balanceBasis: 'cumulative', bankAccountId: null,
  invoiceListKind: null, importType: kind, openingConfirmed: null,
  periodStart: '2026-08-01', periodEnd: '2026-08-31', committedAt: '2026-09-01T00:00:00Z',
  completenessByMonth: { '2026-08-01': 'complete' }, ...over,
});

const cell = (accountId: string, amount: string, over: Partial<AggregateCell> = {}): AggregateCell => ({
  periodId: aug.id, source: 'period_balances', standardCategory: null, accountId, counterpartyId: null, bankAccountId: null,
  balanceKind: 'trial_balance', balanceBasis: 'cumulative', invoiceType: null, transferKind: null, unpairedTransferCandidate: false,
  debit: '0', credit: '0', amount, rowCount: 1, fallbackRows: 0, minDate: null, maxDate: null, ...over,
});

const byKey = (results: MetricResult[]) => Object.fromEntries(results.map((r) => [r.key, r]));

/*
 * A balancing trial balance:
 *   van 18,000 · deposit 2,000 · cash 9,500 · debtors 6,000 · stock 3,000 · prepayment 500   (assets 39,000)
 *   mortgage 12,000 (secured) · HP 4,000 (secured) · director's loan 5,000 (unsecured) ·
 *   Bounce Back loan 3,000 (not marked) · creditors 2,500 · equity 12,500                    (39,000)
 */
const TB = [
  cell('a-van', '18000.00'), cell('a-deposit', '2000.00'), cell('a-cash', '9500.00'), cell('a-debtors', '6000.00'),
  cell('a-stock', '3000.00'), cell('a-prepay', '500.00'),
  cell('a-mortgage', '-12000.00'), cell('a-hp', '-4000.00'), cell('a-director', '-5000.00'), cell('a-bounce', '-3000.00'),
  cell('a-creditors', '-2500.00'), cell('a-eq', '-12500.00'),
];

describe('assets and loans at the month end (ADR-156)', () => {
  it('totals each asset group and each loan group from the statement, positive', () => {
    const r = byKey(computeBalanceSheetFigures(ctx(), aug, TB, [batch('trial_balance')]));
    expect(r.fixed_assets).toMatchObject({ value: '18000.00', basis: 'period_balances' });
    expect(r.other_long_term_assets).toMatchObject({ value: '2000.00' });
    expect(r.current_assets).toMatchObject({ value: '19000.00' });            // 9,500 + 6,000 + 3,000 + 500
    expect(r.total_assets).toMatchObject({ value: '39000.00' });              // 18,000 + 2,000 + 19,000
    expect(r.loan_balance).toMatchObject({ value: '12000.00' });              // HP 4,000 + director 5,000 + Bounce Back 3,000
    expect(r.long_term_borrowing).toMatchObject({ value: '12000.00' });       // mortgage
    expect(r.loans_secured).toMatchObject({ value: '16000.00', components: { loan_security: 'secured', account_ids: ['a-hp', 'a-mortgage'] } });
    expect(r.loans_unsecured).toMatchObject({ value: '5000.00', components: { loan_security: 'unsecured' } });
    expect(r.loans_unmarked).toMatchObject({ value: '3000.00', components: { loan_security: 'unmarked', account_ids: ['a-bounce'] } });
  });

  it('secured + unsecured + not marked equals borrowing owed', () => {
    const r = byKey(computeBalanceSheetFigures(ctx(), aug, TB, [batch('trial_balance')]));
    const debt = computeDebtBalance(ctx(), aug, TB, [batch('trial_balance')]);
    expect([r.loans_secured!.value, r.loans_unsecured!.value, r.loans_unmarked!.value]).toEqual(['16000.00', '5000.00', '3000.00']);
    expect(debt.value).toBe('24000.00');                                       // 16,000 + 5,000 + 3,000
  });

  it('nothing marked: every loan is "not marked", none secured or unsecured (never guessed from a name)', () => {
    const unmarked = ACCOUNTS.map((a) => ({ ...a, loanSecurity: null }));
    const r = byKey(computeBalanceSheetFigures(ctx({ accounts: unmarked }), aug, TB, [batch('trial_balance')]));
    expect(r.loans_unmarked!.value).toBe('24000.00');
    expect(r.loans_secured!.value).toBe('0.00');                              // a complete statement: a known zero
    expect(r.loans_unsecured!.value).toBe('0.00');
  });

  it('on an unconfirmed statement, a group with no line is unknown, never zero', () => {
    const r = byKey(computeBalanceSheetFigures(ctx(), aug, [cell('a-cash', '100.00'), cell('a-eq', '-100.00')],
      [batch('trial_balance', { completenessByMonth: {} })]));
    expect(r.fixed_assets).toMatchObject({ value: null, dataQuality: { missing: ['report_completeness_unconfirmed'] } });
    expect(r.loans_secured).toMatchObject({ value: null, dataQuality: { missing: ['report_completeness_unconfirmed'] } });
    expect(r.current_assets).toMatchObject({ value: '100.00' });             // the cash line itself is stated
  });

  it('no cumulative statement for the month: every figure is unknown (no_balance_sheet)', () => {
    for (const r of computeBalanceSheetFigures(ctx(), aug, [], [])) {
      expect(r).toMatchObject({ value: null, dataQuality: { missing: ['no_balance_sheet'] } });
    }
  });

  it('reads a balance sheet when there is no trial balance', () => {
    const r = byKey(computeBalanceSheetFigures(ctx(), aug,
      [cell('a-van', '7000.00', { balanceKind: 'balance_sheet' }), cell('a-eq', '-7000.00', { balanceKind: 'balance_sheet' })],
      [batch('balance_sheet')]));
    expect(r.fixed_assets).toMatchObject({ value: '7000.00', components: { balance_kind: 'balance_sheet' } });
  });
});
