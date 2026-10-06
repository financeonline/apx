import { describe, expect, it } from 'vitest';
import {
  computeDebtBalance, ENGINE_VERSION,
  type AccountRef, type AggregateCell, type CoverageBatch, type EngineContext, type PeriodRef,
} from '@/modules/financial-engine';

/**
 * `debt_balance` (Phase 16 §5.4.1, ADR-145). Natural sign is debit − credit, so a liability owed is a
 * negative natural amount; the metric reports it positive. Every expected figure is worked by hand.
 */

const aug: PeriodRef = { id: 'p-aug', periodStart: '2026-08-01', periodEnd: '2026-08-31', fiscalYear: 2026, fiscalQuarter: 3, label: 'Aug 2026', isComplete: true };
const account = (id: string, category: AccountRef['standardCategory'], type: AccountRef['accountType']): AccountRef =>
  ({ id, code: null, name: id, standardCategory: category, accountType: type, isSystem: true });

const ctx = (over: Partial<EngineContext> = {}): EngineContext => ({
  organizationId: 'org', calculationRunId: 'run', aggregatedAt: '2026-09-15T00:00:00Z', asOf: '2026-09-15', engineVersion: ENGINE_VERSION,
  settings: { baseCurrency: 'GBP', fiscalYearStartMonth: 1, timezone: 'Europe/London', vatRegistered: false, defaultVatRate: null, taxableCategories: [] },
  costOfSalesEverUsed: false, costOfSalesInInvoices: false,
  accounts: [account('a-loan', 'loan', 'liability'), account('a-ltl', 'long_term_liability', 'liability'),
    account('a-card', 'credit_card', 'liability'), account('a-cash', 'cash', 'asset'), account('a-eq', 'equity', 'equity')],
  counterparties: [], bankAccounts: [], periods: [aug], ...over,
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

describe('debt_balance', () => {
  it('sums loans and long-term liabilities, owed positive; a credit card is not debt', () => {
    // Loan owes 5,000 and long-term 20,000 (natural −5,000 and −20,000); the card's 700 is left out.
    // The trial balance balances: cash 25,700 against the three liabilities.
    const result = computeDebtBalance(ctx(), aug, [
      cell('a-loan', '-5000.00'), cell('a-ltl', '-20000.00'), cell('a-card', '-700.00'), cell('a-cash', '25700.00'),
    ], [batch('trial_balance')]);
    expect(result).toMatchObject({ key: 'debt_balance', value: '25000.00', basis: 'period_balances' });
    expect(result.components).toMatchObject({ balance_kind: 'trial_balance', account_ids: ['a-loan', 'a-ltl'] });
    expect(result.evidenceQuery).toMatchObject({ kind: 'leaf', descriptor: { table: 'period_balances', filters: { account_ids: ['a-loan', 'a-ltl'], balance_kind: 'trial_balance' } } });
  });

  it('a complete statement with no borrowing line is a known zero', () => {
    const result = computeDebtBalance(ctx(), aug, [cell('a-cash', '100.00'), cell('a-eq', '-100.00')], [batch('trial_balance')]);
    expect(result).toMatchObject({ value: '0.00', dataQuality: { missing: [] } });
  });

  it('an unconfirmed statement with no borrowing line is unknown, never zero', () => {
    const result = computeDebtBalance(ctx(), aug, [cell('a-cash', '100.00'), cell('a-eq', '-100.00')],
      [batch('trial_balance', { completenessByMonth: {} })]);
    expect(result).toMatchObject({ value: null, dataQuality: { missing: ['report_completeness_unconfirmed'] } });
  });

  it('no cumulative statement for the month: unknown (no_balance_sheet)', () => {
    expect(computeDebtBalance(ctx(), aug, [], [])).toMatchObject({ value: null, dataQuality: { missing: ['no_balance_sheet'] } });
    // A movement-basis trial balance states movements, not what is owed.
    const movement = computeDebtBalance(ctx(), aug, [cell('a-loan', '-5000.00', { balanceBasis: 'movement' })],
      [batch('trial_balance', { balanceBasis: 'movement' })]);
    expect(movement).toMatchObject({ value: null, dataQuality: { missing: ['no_balance_sheet'] } });
  });

  it('reads a balance sheet when there is no trial balance; a trial balance wins when both exist', () => {
    const bs = cell('a-loan', '-8000.00', { balanceKind: 'balance_sheet' });
    expect(computeDebtBalance(ctx(), aug, [bs], [batch('balance_sheet')])).toMatchObject({ value: '8000.00', components: { balance_kind: 'balance_sheet' } });
    const both = computeDebtBalance(ctx(), aug, [bs, cell('a-loan', '-6000.00'), cell('a-cash', '6000.00')],
      [batch('trial_balance'), batch('balance_sheet')]);
    expect(both).toMatchObject({ value: '6000.00', components: { balance_kind: 'trial_balance' } });
  });

  it('a debit balance on debt accounts is reported with a warning', () => {
    const result = computeDebtBalance(ctx(), aug, [cell('a-loan', '300.00'), cell('a-cash', '-300.00')], [batch('trial_balance')]);
    expect(result).toMatchObject({ value: '-300.00', dataQuality: { warnings: ['debit_balance_on_debt_accounts'] } });
  });

  it('a loan-type bank account never establishes debt, whatever it is called (U-3)', () => {
    const result = computeDebtBalance(ctx({
      bankAccounts: [{ id: 'bank-loan', name: 'Business Loan', accountType: 'loan', currency: 'GBP', ledgerAccountId: null } as never],
    }), aug, [], []);
    expect(result).toMatchObject({ value: null, dataQuality: { missing: ['no_balance_sheet'] } });
  });
});
