import { describe, expect, it } from 'vitest';

import {
  composePeriod, computeCoverage, ENGINE_VERSION,
  type AggregateCell, type AccountRef, type BankAccountRef, type EngineContext, type PeriodRef,
} from '@/modules/financial-engine';

/**
 * Composition (FINANCIAL_ENGINE.md §2.4 step 6).
 *
 * The seam between the SQL aggregation and the metric modules. Two things go wrong here and nowhere
 * else, and both are silent: a sign applied twice or not at all, and a transfer leg counted for the
 * wrong family. Both are tested directly.
 */

const may: PeriodRef = {
  id: 'p-may', periodStart: '2026-05-01', periodEnd: '2026-05-31',
  fiscalYear: 2026, fiscalQuarter: 2, label: 'May 2026', isComplete: false,
};

const account = (id: string, category: AccountRef['standardCategory'],
                 type: AccountRef['accountType']): AccountRef =>
  ({ id, code: null, name: id, standardCategory: category, accountType: type, isSystem: true });

const ACCOUNTS: AccountRef[] = [
  account('a-rev', 'revenue', 'income'),
  account('a-cos', 'cost_of_sales', 'expense'),
  account('a-pay', 'payroll', 'expense'),
  account('a-mkt', 'marketing', 'expense'),
  account('a-cash', 'cash', 'asset'),
  account('a-card', 'credit_card', 'liability'),
];

const current: BankAccountRef = {
  id: 'ba-current', name: 'Current', accountType: 'current',
  openingBalance: '5000.00', openingBalanceDate: '2026-04-30', isActive: true,
};
const card: BankAccountRef = {
  id: 'ba-card', name: 'Card', accountType: 'credit_card',
  openingBalance: null, openingBalanceDate: null, isActive: true,
};

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
  accounts: ACCOUNTS,
  counterparties: [],
  bankAccounts: [],
  periods: [may],
  ...over,
});

const ledgerCell = (
  accountId: string, category: AggregateCell['standardCategory'],
  debit: string, credit: string, rowCount = 1,
): AggregateCell => ({
  periodId: may.id, source: 'ledger', standardCategory: category, accountId,
  counterpartyId: null, bankAccountId: null, balanceKind: null, balanceBasis: null,
  invoiceType: null, transferKind: null, unpairedTransferCandidate: false,
  debit, credit, amount: String(Number(debit) - Number(credit)),
  rowCount, minDate: '2026-05-01', maxDate: '2026-05-31', fallbackRows: 0,
});

const bankCell = (over: Partial<AggregateCell> = {}): AggregateCell => ({
  periodId: may.id, source: 'bank', standardCategory: null, accountId: null,
  counterpartyId: null, bankAccountId: 'ba-current', balanceKind: null, balanceBasis: null,
  invoiceType: null, transferKind: 'none', unpairedTransferCandidate: false,
  debit: '0', credit: '0', amount: '0', rowCount: 1, fallbackRows: 0,
  minDate: '2026-05-01', maxDate: '2026-05-31', ...over,
});

const ledgerCoverage = (bankAccounts: BankAccountRef[] = []) => computeCoverage({
  period: may,
  batches: [{
    id: 'b1', targetTable: 'ledger_entries', balanceKind: null, balanceBasis: null,
    bankAccountId: null, invoiceListKind: null,
    periodStart: '2026-05-01', periodEnd: '2026-05-31', committedAt: '2026-06-01T00:00:00Z',
  }],
  bankAccounts, rowCounts: { ledger: 4 }, asOf: '2026-06-15',
});

const valueOf = (results: ReturnType<typeof composePeriod>, key: string) =>
  results.find((r) => r.key === key && r.dimensionType === 'none')?.value ?? null;

describe('the account-type sign rule is applied exactly once (§3)', () => {
  const cells = [
    ledgerCell('a-rev', 'revenue', '0', '20000.00'),
    ledgerCell('a-cos', 'cost_of_sales', '6000.00', '0'),
    ledgerCell('a-pay', 'payroll', '5000.00', '0'),
    ledgerCell('a-mkt', 'marketing', '1000.00', '0'),
  ];

  it('reads a credit balance on an income account as positive revenue', () => {
    // The aggregate carries debit − credit = −20,000. Reporting sign makes it +20,000. Applying the
    // rule twice, or not at all, is the classic way an engine reports negative revenue.
    const results = composePeriod({
      period: may, coverage: ledgerCoverage(), cells, transferLegs: [], context: context(),
    });
    expect(valueOf(results, 'revenue')).toBe('20000.00');
  });

  it('reads a debit balance on an expense account as positive cost', () => {
    const results = composePeriod({
      period: may, coverage: ledgerCoverage(), cells, transferLegs: [], context: context(),
    });
    expect(valueOf(results, 'cost_of_sales')).toBe('6000.00');
    expect(valueOf(results, 'operating_expenses')).toBe('6000.00');
  });

  it('lets revenue go negative in a refund-heavy month rather than taking an absolute value', () => {
    const refunds = [ledgerCell('a-rev', 'revenue', '3000.00', '1000.00')];
    const results = composePeriod({
      period: may, coverage: ledgerCoverage(), cells: refunds, transferLegs: [], context: context(),
    });
    // Debit 3,000 against credit 1,000 on an income account: −2,000, which is the truth.
    expect(valueOf(results, 'revenue')).toBe('-2000.00');
    const revenue = results.find((r) => r.key === 'revenue');
    expect(revenue?.dataQuality.warnings).toContain('negative_revenue');
  });

  it('sums several cells of one account before applying anything', () => {
    const split = [
      ledgerCell('a-rev', 'revenue', '0', '12000.00'),
      ledgerCell('a-rev', 'revenue', '0', '8000.00'),
    ];
    const results = composePeriod({
      period: may, coverage: ledgerCoverage(), cells: split, transferLegs: [], context: context(),
    });
    expect(valueOf(results, 'revenue')).toBe('20000.00');
  });

  it('ignores a cell whose account is not in the chart', () => {
    // An account deleted between the aggregate and the load: the figure is short, not corrupt.
    const orphan = [...cells, ledgerCell('a-gone', 'revenue', '0', '99999.00')];
    const results = composePeriod({
      period: may, coverage: ledgerCoverage(), cells: orphan, transferLegs: [], context: context(),
    });
    expect(valueOf(results, 'revenue')).toBe('20000.00');
  });
});

describe('cash and the transfer rule (ADR-028)', () => {
  const bankCoverage = (accounts: BankAccountRef[]) => computeCoverage({
    period: may,
    batches: accounts.map((a) => ({
      id: `b-${a.id}`, targetTable: 'bank_transactions' as const, balanceKind: null,
      balanceBasis: null, bankAccountId: a.id, invoiceListKind: null,
      periodStart: '2026-05-01', periodEnd: '2026-05-31', committedAt: '2026-06-01T00:00:00Z',
    })),
    bankAccounts: accounts, rowCounts: { bank: 3 }, asOf: '2026-06-15',
  });

  it('excludes a cash-to-cash transfer from both inflows and outflows', () => {
    const savings: BankAccountRef = { ...current, id: 'ba-savings', accountType: 'savings' };
    const cells = [
      bankCell({ bankAccountId: 'ba-current', amount: '-500.00', credit: '500.00',
                 transferKind: 'cash_transfer' }),
      bankCell({ bankAccountId: 'ba-savings', amount: '500.00', debit: '500.00',
                 transferKind: 'cash_transfer' }),
      bankCell({ bankAccountId: 'ba-current', amount: '2000.00', debit: '2000.00' }),
    ];
    const results = composePeriod({
      period: may, coverage: bankCoverage([current, savings]), cells, transferLegs: [],
      context: context({ bankAccounts: [current, savings] }),
    });

    // Only the genuine 2,000 receipt counts; the internal move cancels by construction.
    expect(valueOf(results, 'cash_inflows')).toBe('2000.00');
    expect(valueOf(results, 'cash_outflows')).toBe('0.00');
  });

  it('KEEPS a card repayment in cash outflows', () => {
    // The case ADR-028 exists for. Excluding it would make £3,000 leave the bank and vanish from
    // the figures.
    const cells = [
      bankCell({ bankAccountId: 'ba-current', amount: '-3000.00', credit: '3000.00',
                 transferKind: 'card_repayment' }),
    ];
    const results = composePeriod({
      period: may, coverage: bankCoverage([current, card]), cells, transferLegs: [],
      context: context({ bankAccounts: [current, card] }),
    });
    expect(valueOf(results, 'cash_outflows')).toBe('3000.00');
  });

  it('does not count a credit-card account as cash', () => {
    const cells = [
      bankCell({ bankAccountId: 'ba-card', amount: '-250.00', credit: '250.00' }),
    ];
    const results = composePeriod({
      period: may, coverage: bankCoverage([current, card]), cells, transferLegs: [],
      context: context({ bankAccounts: [current, card] }),
    });
    // A card purchase is an expense, not a cash movement; cash is unmoved.
    expect(valueOf(results, 'cash_outflows')).toBe('0.00');
  });
});

describe('a period nothing covers (§1.5, §2.3)', () => {
  it('writes NULL with a reason rather than zero', () => {
    const coverage = computeCoverage({
      period: may, batches: [], bankAccounts: [], rowCounts: {}, asOf: '2026-06-15',
    });
    const results = composePeriod({
      period: may, coverage, cells: [], transferLegs: [], context: context(),
    });

    const revenue = results.find((r) => r.key === 'revenue');
    expect(revenue?.value, 'zero would claim the business earned nothing').toBeNull();
    expect(revenue?.basis).toBe('none');
    expect(revenue?.dataQuality.missing).toContain('no_source_covers_period');
  });
});

describe('determinism (§1.1)', () => {
  const cells = [
    ledgerCell('a-rev', 'revenue', '0', '20000.00'),
    ledgerCell('a-cos', 'cost_of_sales', '6000.00', '0'),
    ledgerCell('a-pay', 'payroll', '5000.00', '0'),
  ];

  it('produces byte-identical output from identical input', () => {
    const run = () => JSON.stringify(composePeriod({
      period: may, coverage: ledgerCoverage(), cells, transferLegs: [], context: context(),
    }));
    expect(run()).toBe(run());
  });

  it('is unaffected by the order the aggregate arrives in', () => {
    const forwards = composePeriod({
      period: may, coverage: ledgerCoverage(), cells, transferLegs: [], context: context(),
    });
    const backwards = composePeriod({
      period: may, coverage: ledgerCoverage(), cells: [...cells].reverse(), transferLegs: [],
      context: context(),
    });
    expect(JSON.stringify(backwards)).toBe(JSON.stringify(forwards));
  });

  it('emits results in a stable order, by key then dimension', () => {
    const results = composePeriod({
      period: may, coverage: ledgerCoverage(), cells, transferLegs: [], context: context(),
    });
    // The same comparator the composition uses. Sorting the joined strings instead would compare
    // under a different collation and prove nothing about the code.
    const resorted = [...results].sort(
      (a, b) => a.key.localeCompare(b.key)
        || (a.dimensionId ?? '').localeCompare(b.dimensionId ?? ''),
    );
    expect(resorted.map((r) => `${r.key}|${r.dimensionId ?? ''}`))
      .toEqual(results.map((r) => `${r.key}|${r.dimensionId ?? ''}`));
  });

  it('never emits the same key and dimension twice', () => {
    // A duplicate would violate the snapshot uniqueness index and abort the whole chunk.
    const results = composePeriod({
      period: may, coverage: ledgerCoverage(), cells, transferLegs: [], context: context(),
    });
    // A dimension is identified by its id OR its key, depending on whether it is a row (ADR-053).
    const keys = results.map(
      (r) => `${r.key}|${r.dimensionType}|${r.dimensionId ?? ''}|${r.dimensionKey ?? ''}`,
    );
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('evidence metadata (§3, ADR-034)', () => {
  const cells = [
    ledgerCell('a-rev', 'revenue', '0', '20000.00'),
    ledgerCell('a-cos', 'cost_of_sales', '6000.00', '0'),
  ];

  it('names resolved account ids on a leaf, never a category', () => {
    const results = composePeriod({
      period: may, coverage: ledgerCoverage(), cells, transferLegs: [], context: context(),
    });
    const revenue = results.find((r) => r.key === 'revenue');
    expect(revenue?.evidenceQuery?.kind).toBe('leaf');

    const serialised = JSON.stringify(revenue?.evidenceQuery);
    expect(serialised).toContain('a-rev');
    // A category is a mutable property of an account; storing one would make old evidence follow a
    // later remap.
    expect(serialised).not.toContain('standard_categories');
  });

  it('points a derived metric at its components', () => {
    const results = composePeriod({
      period: may, coverage: ledgerCoverage(), cells, transferLegs: [], context: context(),
    });
    const grossProfit = results.find((r) => r.key === 'gross_profit');
    expect(grossProfit?.evidenceQuery?.kind).toBe('derived');
    expect(grossProfit?.components).toHaveProperty('revenue');
  });
});
