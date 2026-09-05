import { describe, expect, it } from 'vitest';

import {
  choosePrecedence, chooseBalanceKind, computeCoverage, isPeriodComplete, winningBalanceBatch,
  type BankAccountRef, type CoverageBatch, type PeriodRef,
} from '@/modules/financial-engine';

/**
 * Coverage and precedence (FINANCIAL_ENGINE.md §2.2, §2.3).
 *
 * Two properties are defended throughout:
 *   - Coverage reads the DECLARED export range, never the last posting date (ADR-047.6). A quiet
 *     month is covered data, not missing data.
 *   - The first covering source wins the WHOLE family. Sources are never summed across, because
 *     adding a bank figure to a trial-balance figure double-counts.
 */

const may: PeriodRef = {
  id: 'p-may', periodStart: '2026-05-01', periodEnd: '2026-05-31',
  fiscalYear: 2026, fiscalQuarter: 1, label: 'May 2026', isComplete: false,
};

const batch = (over: Partial<CoverageBatch>): CoverageBatch => ({
  id: 'b1', targetTable: 'ledger_entries', balanceKind: null, balanceBasis: null,
  bankAccountId: null, invoiceListKind: null,
  periodStart: '2026-05-01', periodEnd: '2026-05-31',
  committedAt: '2026-06-01T10:00:00Z', ...over,
});

const current: BankAccountRef = {
  id: 'ba-1', name: 'Current', accountType: 'current',
  openingBalance: null, openingBalanceDate: null, isActive: true,
};
const savings: BankAccountRef = { ...current, id: 'ba-2', name: 'Savings', accountType: 'savings' };
const card: BankAccountRef = { ...current, id: 'ba-3', name: 'Card', accountType: 'credit_card' };

const coverageOf = (over: Partial<Parameters<typeof computeCoverage>[0]> = {}) =>
  computeCoverage({
    period: may, batches: [], bankAccounts: [], rowCounts: {}, asOf: '2026-06-15', ...over,
  });

describe('the declared export range decides coverage, not the last posting (ADR-047.6)', () => {
  it('covers a month whose last posting falls on the 28th', () => {
    // The whole point of the declared range: a quiet last week is not missing data.
    const coverage = coverageOf({
      batches: [batch({ periodStart: '2026-05-01', periodEnd: '2026-05-31' })],
      rowCounts: { ledger: 40 },
    });
    expect(coverage.bySource.ledger.covers).toBe(true);
    expect(coverage.bySource.ledger.warnings).toHaveLength(0);
  });

  it('does not cover a month the export stops short of', () => {
    const coverage = coverageOf({
      batches: [batch({ periodStart: '2026-05-01', periodEnd: '2026-05-20' })],
      rowCounts: { ledger: 40 },
    });
    // Rows exist but the export never claimed the whole month, so it is partial, not complete.
    expect(coverage.bySource.ledger.warnings).toContain('partial_month');
    expect(coverage.bySource.ledger.completeness).toBeLessThan(1);
  });

  it('requires both rows and a declared range for the ledger', () => {
    // A declared range with no rows would let an empty month claim coverage it has no data for.
    const noRows = coverageOf({ batches: [batch({})], rowCounts: { ledger: 0 } });
    expect(noRows.bySource.ledger.covers).toBe(false);
  });
});

describe('the winning balance batch (ADR-029.2)', () => {
  const early = batch({
    id: 'b-early', targetTable: 'period_balances', balanceKind: 'trial_balance',
    balanceBasis: 'cumulative', committedAt: '2026-06-01T10:00:00Z',
  });
  const late = batch({
    id: 'b-late', targetTable: 'period_balances', balanceKind: 'trial_balance',
    balanceBasis: 'cumulative', committedAt: '2026-06-10T10:00:00Z',
  });

  it('takes the latest committed batch that spans the period', () => {
    expect(winningBalanceBatch([early, late], may, 'trial_balance')?.id).toBe('b-late');
    // And is not sensitive to the order it was handed them.
    expect(winningBalanceBatch([late, early], may, 'trial_balance')?.id).toBe('b-late');
  });

  it('ignores a batch that does not span the whole period', () => {
    const short = batch({
      id: 'b-short', targetTable: 'period_balances', balanceKind: 'trial_balance',
      periodEnd: '2026-05-15', committedAt: '2026-07-01T10:00:00Z',
    });
    expect(winningBalanceBatch([early, short], may, 'trial_balance')?.id).toBe('b-early');
  });

  it('prefers a trial balance over a P&L report for the P&L family (ADR-047.4)', () => {
    // A customer who uploads both must not get two different revenue figures depending on which
    // the engine happened to pick.
    const pnl = batch({
      id: 'b-pnl', targetTable: 'period_balances', balanceKind: 'pnl_report',
      committedAt: '2026-07-01T10:00:00Z',
    });
    expect(chooseBalanceKind([pnl, early], may, 'pnl')?.kind).toBe('trial_balance');
  });

  it('prefers a trial balance over a balance sheet for balance families', () => {
    const bs = batch({
      id: 'b-bs', targetTable: 'period_balances', balanceKind: 'balance_sheet',
      committedAt: '2026-07-01T10:00:00Z',
    });
    expect(chooseBalanceKind([bs, early], may, 'balance')?.kind).toBe('trial_balance');
  });

  it('falls back to the P&L report when there is no trial balance', () => {
    const pnl = batch({
      id: 'b-pnl', targetTable: 'period_balances', balanceKind: 'pnl_report',
    });
    expect(chooseBalanceKind([pnl], may, 'pnl')?.kind).toBe('pnl_report');
  });
});

describe('bank coverage needs every active cash-like account (§2.2)', () => {
  const statement = (accountId: string) => batch({
    id: `b-${accountId}`, targetTable: 'bank_transactions', bankAccountId: accountId,
  });

  it('is full when every cash-like account has a covering statement', () => {
    const coverage = coverageOf({
      batches: [statement('ba-1'), statement('ba-2')],
      bankAccounts: [current, savings],
    });
    expect(coverage.bankCoverageRatio).toBe(1);
    expect(coverage.bySource.bank.warnings).not.toContain('bank_coverage_partial');
  });

  it('is partial, and says so, when one account is missing', () => {
    // The missing account's movements are simply invisible; the figure must not pretend otherwise.
    const coverage = coverageOf({
      batches: [statement('ba-1')], bankAccounts: [current, savings],
    });
    expect(coverage.bankCoverageRatio).toBe(0.5);
    expect(coverage.bySource.bank.warnings).toContain('bank_coverage_partial');
  });

  it('does not count a credit-card account towards cash coverage (§4.4)', () => {
    const coverage = coverageOf({
      batches: [statement('ba-1')], bankAccounts: [current, card],
    });
    expect(coverage.bankCoverageRatio, 'a card is tracked but is not cash').toBe(1);
  });

  it('treats an organization with no bank accounts as fully covered', () => {
    expect(coverageOf({ bankAccounts: [] }).bankCoverageRatio).toBe(1);
  });
});

describe('invoice coverage distinguishes a full list from an aged-debtors list (ADR-047.10)', () => {
  it('covers revenue only from a full list', () => {
    const coverage = coverageOf({
      batches: [batch({ targetTable: 'invoices', invoiceListKind: 'full' })],
    });
    expect(coverage.bySource.invoices.covers).toBe(true);
    expect(coverage.bySource.invoices.warnings).toHaveLength(0);
  });

  it('accepts an open-items list for receivables but flags it', () => {
    // An open-items list defines what is owed; it must never define revenue.
    const coverage = coverageOf({
      batches: [batch({ targetTable: 'invoices', invoiceListKind: 'open_items' })],
    });
    expect(coverage.bySource.invoices.covers).toBe(true);
    expect(coverage.bySource.invoices.warnings).toContain('open_items_only');
  });

  it('accepts a list committed within the freshness window after the period', () => {
    const coverage = coverageOf({
      batches: [batch({
        targetTable: 'invoices', invoiceListKind: null,
        periodStart: '2026-07-01', periodEnd: '2026-07-31',
        committedAt: '2026-06-20T10:00:00Z',
      })],
    });
    expect(coverage.bySource.invoices.covers).toBe(true);
  });

  it('rejects a list uploaded long after the period', () => {
    // Last May's receivables must not be answered from a list uploaded a year later.
    const coverage = coverageOf({
      batches: [batch({
        targetTable: 'invoices', invoiceListKind: null,
        periodStart: '2027-05-01', periodEnd: '2027-05-31',
        committedAt: '2027-06-01T10:00:00Z',
      })],
    });
    expect(coverage.bySource.invoices.covers).toBe(false);
  });
});

describe('precedence gives the whole family to one source (§2.3)', () => {
  it('prefers a trial balance over the ledger for the P&L', () => {
    const coverage = coverageOf({
      batches: [
        batch({ targetTable: 'period_balances', balanceKind: 'trial_balance', balanceBasis: 'cumulative' }),
        batch({ id: 'b-gl', targetTable: 'ledger_entries' }),
      ],
      rowCounts: { ledger: 10 },
    });
    const choice = choosePrecedence(coverage, 'pnl');
    expect(choice.basis).toBe('period_balances');
    expect(choice.assurance).toBe('verified');
    expect(choice.balanceBasis).toBe('cumulative');
  });

  it('prefers the bank for cash, and the ledger only as a fallback', () => {
    const withBank = coverageOf({
      batches: [batch({ targetTable: 'bank_transactions', bankAccountId: 'ba-1' })],
      bankAccounts: [current],
    });
    expect(choosePrecedence(withBank, 'cash').basis).toBe('bank');
    expect(choosePrecedence(withBank, 'cash').assurance).toBe('verified');

    const withoutBank = coverageOf({
      batches: [batch({ targetTable: 'ledger_entries' })], rowCounts: { ledger: 5 },
    });
    expect(choosePrecedence(withoutBank, 'cash').basis).toBe('ledger');
  });

  it('marks a bank-basis P&L as a proxy and an estimate', () => {
    // A cash figure standing in for an accrual figure is an estimate however exact the arithmetic.
    const coverage = coverageOf({
      batches: [batch({ targetTable: 'bank_transactions', bankAccountId: 'ba-1' })],
      bankAccounts: [current],
    });
    const choice = choosePrecedence(coverage, 'pnl');
    expect(choice.basis).toBe('bank');
    expect(choice.assurance).toBe('estimated');
    expect(choice.proxy).toBe(true);
    expect(choice.warnings).toContain('cash_basis_proxy');
    expect(choice.warnings).toContain('vat_inclusive');
  });

  it('returns no basis when nothing covers the period', () => {
    // The caller then writes every metric of the family NULL with no_source_covers_period —
    // never zero.
    const choice = choosePrecedence(coverageOf(), 'pnl');
    expect(choice.basis).toBe('none');
    expect(choice.proxy).toBe(false);
  });
});

describe('every family and source pairing carries the right assurance (§2.3)', () => {
  const withAll = () => coverageOf({
    batches: [
      batch({ targetTable: 'period_balances', balanceKind: 'trial_balance' }),
      batch({ id: 'b-gl', targetTable: 'ledger_entries' }),
      batch({ id: 'b-inv', targetTable: 'invoices', invoiceListKind: 'full' }),
      batch({ id: 'b-bank', targetTable: 'bank_transactions', bankAccountId: 'ba-1' }),
    ],
    bankAccounts: [current],
    rowCounts: { ledger: 5 },
  });

  it('treats an invoice-based receivable as verified and a balance-based one as calculated', () => {
    const coverage = withAll();
    expect(choosePrecedence(coverage, 'receivables_payables').assurance).toBe('verified');

    const withoutInvoices = coverageOf({
      batches: [batch({ targetTable: 'period_balances', balanceKind: 'trial_balance' })],
    });
    const fallback = choosePrecedence(withoutInvoices, 'receivables_payables');
    // A closing balance tells you the total but not the aging, so it is a weaker claim.
    expect(fallback.basis).toBe('period_balances');
    expect(fallback.assurance).toBe('calculated');
  });

  it('treats a ledger-based P&L as calculated rather than verified', () => {
    const coverage = coverageOf({
      batches: [batch({ targetTable: 'ledger_entries' })], rowCounts: { ledger: 5 },
    });
    expect(choosePrecedence(coverage, 'pnl').assurance).toBe('calculated');
  });

  it('treats cash from the ledger as calculated and from balances as an estimate', () => {
    const fromLedger = coverageOf({
      batches: [batch({ targetTable: 'ledger_entries' })], rowCounts: { ledger: 5 },
    });
    expect(choosePrecedence(fromLedger, 'cash').assurance).toBe('calculated');

    const fromBalances = coverageOf({
      batches: [batch({ targetTable: 'period_balances', balanceKind: 'trial_balance' })],
    });
    const choice = choosePrecedence(fromBalances, 'cash');
    expect(choice.basis).toBe('period_balances');
    // A balance without an opening position is the weakest cash claim there is.
    expect(choice.assurance).toBe('estimated');
  });

  it('treats counterparty figures from invoices as calculated and from the bank as estimated', () => {
    expect(choosePrecedence(withAll(), 'counterparty').assurance).toBe('calculated');

    const bankOnly = coverageOf({
      batches: [batch({ targetTable: 'bank_transactions', bankAccountId: 'ba-1' })],
      bankAccounts: [current],
    });
    expect(choosePrecedence(bankOnly, 'counterparty').assurance).toBe('estimated');
  });
});

describe('period completeness (ADR-030.1)', () => {
  const full = () => coverageOf({
    batches: [
      batch({ targetTable: 'period_balances', balanceKind: 'trial_balance' }),
      batch({ id: 'b-bank', targetTable: 'bank_transactions', bankAccountId: 'ba-1' }),
    ],
    bankAccounts: [current],
  });

  it('is complete when the P&L source reaches the period end and the bank is fully covered', () => {
    expect(isPeriodComplete(full(), may, [current])).toBe(true);
  });

  it('is incomplete when no source covers the period', () => {
    expect(isPeriodComplete(coverageOf(), may, [current])).toBe(false);
  });

  it('is complete for an organization with no bank account at all', () => {
    const coverage = coverageOf({
      batches: [batch({ targetTable: 'period_balances', balanceKind: 'trial_balance' })],
    });
    expect(isPeriodComplete(coverage, may, [])).toBe(true);
  });

  it('is incomplete when a cash-like account is uncovered', () => {
    const coverage = coverageOf({
      batches: [
        batch({ targetTable: 'period_balances', balanceKind: 'trial_balance' }),
        batch({ id: 'b-bank', targetTable: 'bank_transactions', bankAccountId: 'ba-1' }),
      ],
      bankAccounts: [current, savings],
    });
    expect(isPeriodComplete(coverage, may, [current, savings])).toBe(false);
  });

  it('is incomplete when the P&L source stops before the period ends', () => {
    const coverage = coverageOf({
      batches: [batch({
        targetTable: 'period_balances', balanceKind: 'trial_balance', periodEnd: '2026-05-20',
      })],
    });
    expect(isPeriodComplete(coverage, may, [])).toBe(false);
  });
});
