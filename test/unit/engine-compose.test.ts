import { describe, expect, it } from 'vitest';

import {
  buildCashHistory, composePeriod, computeCoverage, ENGINE_VERSION,
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
  costOfSalesInInvoices: false,
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
  // ADR-124: the run hands composition every account's state from the per-account history; here a
  // statement covers May for each account, so the movements are stated.
  const cashAccounts = (accounts: BankAccountRef[]) => buildCashHistory({
    bankAccounts: accounts,
    statements: accounts.map((a) => ({
      batchId: `b-${a.id}`, bankAccountId: a.id, periodStart: '2026-05-01', periodEnd: '2026-05-31',
      committedAt: '2026-06-01T00:00:00Z', openingBalance: null, closingBalance: null, unreconciled: false,
    })),
    movements: [],
    periods: [may],
  }).get(may.id) ?? [];

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
      context: context({ bankAccounts: [current, savings] }), cashAccounts: cashAccounts([current, savings]),
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
      context: context({ bankAccounts: [current, card] }), cashAccounts: cashAccounts([current, card]),
    });
    expect(valueOf(results, 'cash_outflows')).toBe('3000.00');
  });

  it('does not count a credit-card account as cash', () => {
    const cells = [
      bankCell({ bankAccountId: 'ba-card', amount: '-250.00', credit: '250.00' }),
    ];
    const results = composePeriod({
      period: may, coverage: bankCoverage([current, card]), cells, transferLegs: [],
      context: context({ bankAccounts: [current, card] }), cashAccounts: cashAccounts([current, card]),
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

describe('the bank-basis population: one rule for the P&L lines and the counterparties (§4.4, ADR-110)', () => {
  const bankOnly = computeCoverage({
    period: may,
    batches: [{
      id: 'b-current', targetTable: 'bank_transactions', balanceKind: null, balanceBasis: null,
      bankAccountId: current.id, invoiceListKind: null,
      periodStart: '2026-05-01', periodEnd: '2026-05-31', committedAt: '2026-06-01T00:00:00Z',
    }],
    bankAccounts: [current], rowCounts: { bank: 9 }, asOf: '2026-06-15',
  });
  const party = (id: string, kind: 'customer' | 'supplier') =>
    ({ id, name: id, kind, mergedIntoId: null, defaultExpenseCategory: null });
  const ctx = context({
    bankAccounts: [current],
    counterparties: [party('c1', 'customer'), party('s1', 'supplier'), party('s3', 'supplier')],
  });
  const cells = [
    // Customer c1: a receipt, and a refund in the same category (one cell carries both sides).
    bankCell({ accountId: 'a-rev', standardCategory: 'revenue', counterpartyId: 'c1',
               debit: '5000.00', credit: '300.00', amount: '4700.00', rowCount: 2 }),
    // A revenue-categorised transfer leg, as a hand-marked pair keeps its category.
    bankCell({ accountId: 'a-rev', standardCategory: 'revenue', counterpartyId: 'c1',
               debit: '2000.00', amount: '2000.00', transferKind: 'cash_transfer' }),
    // An uncategorised receipt from the same customer.
    bankCell({ counterpartyId: 'c1', debit: '900.00', amount: '900.00' }),
    // A receipt nobody is named on.
    bankCell({ accountId: 'a-rev', standardCategory: 'revenue', debit: '600.00', amount: '600.00' }),
    // Supplier s1: a payment and a refund in cost of sales; a card repayment leg carrying cost of sales.
    bankCell({ accountId: 'a-cos', standardCategory: 'cost_of_sales', counterpartyId: 's1',
               debit: '150.00', credit: '1200.00', amount: '-1050.00', rowCount: 2 }),
    bankCell({ accountId: 'a-cos', standardCategory: 'cost_of_sales', counterpartyId: 's1',
               credit: '700.00', amount: '-700.00', transferKind: 'card_repayment' }),
    // Supplier s3: the HIGH-3 shape — only an uncategorised payment and a transfer.
    bankCell({ counterpartyId: 's3', credit: '4100.00', amount: '-4100.00' }),
    bankCell({ accountId: 'a-cash', standardCategory: 'cash', counterpartyId: 's3',
               credit: '2020.00', amount: '-2020.00', transferKind: 'cash_transfer' }),
  ];
  const results = composePeriod({ period: may, coverage: bankOnly, cells, transferLegs: [], context: ctx });
  const counterparty = (key: string, id: string | null) =>
    results.find((r) => r.key === key && r.dimensionType === 'counterparty' && r.dimensionId === id);

  it('counts revenue inflows and expense outflows, never a transfer and never the other side', () => {
    expect(results.find((r) => r.key === 'revenue')?.basis).toBe('bank');
    expect(valueOf(results, 'revenue')).toBe('5600.00');
    expect(valueOf(results, 'cost_of_sales')).toBe('1200.00');
  });

  it('attributes the same rows to the counterparties, so Σ customers + Unattributed = revenue', () => {
    expect(counterparty('customer_revenue', 'c1')?.value).toBe('5000.00');
    expect(counterparty('customer_revenue', null)?.value).toBe('600.00');
    expect(counterparty('supplier_spend', 's1')?.value).toBe('1200.00');
  });

  it('gives a party with only uncategorised and transfer rows no figure at all', () => {
    // The old rule summed their magnitudes: 4,100 + 2,020 = 6,120 of "spend" behind an empty drill-down.
    expect(counterparty('supplier_spend', 's3')).toBeUndefined();
  });

  it('builds each counterparty descriptor from the population the figure used', () => {
    for (const [key, id, direction, accounts] of [
      ['customer_revenue', 'c1', 'inflow', ['a-rev']],
      ['supplier_spend', 's1', 'outflow', ['a-cos', 'a-mkt', 'a-pay']],
    ] as const) {
      const evidence = counterparty(key, id)?.evidenceQuery;
      if (evidence?.kind !== 'leaf') throw new Error(`expected a leaf for ${key}`);
      expect(evidence.descriptor.filters).toMatchObject({
        category_account_ids: [...accounts], direction, exclude_transfers: 'all',
      });
    }
  });
});

describe('the ledger-basis population: the P&L accounts, in reporting sign (§3.5, ADR-111)', () => {
  const party = (id: string, kind: 'customer' | 'supplier') =>
    ({ id, name: id, kind, mergedIntoId: null, defaultExpenseCategory: null });
  const ctx = context({ counterparties: [party('c1', 'customer'), party('s1', 'supplier')] });
  const on = (cell: AggregateCell, counterpartyId: string | null): AggregateCell => ({ ...cell, counterpartyId });
  const cells = [
    // Customer c1: 18,000 of sales and a 1,000 refund on the revenue account; the receivable is not revenue.
    on(ledgerCell('a-rev', 'revenue', '1000.00', '18000.00', 2), 'c1'),
    on(ledgerCell('a-cash', 'cash', '18000.00', '0'), 'c1'),
    // Revenue nobody is named on.
    ledgerCell('a-rev', 'revenue', '0', '2400.00'),
    // Supplier s1: cost of sales and marketing, a 200 credit on cost of sales, and the same contact on
    // the settling lines of its own journals — a general-ledger export prints it on every line.
    on(ledgerCell('a-cos', 'cost_of_sales', '5200.00', '200.00', 2), 's1'),
    on(ledgerCell('a-mkt', 'marketing', '900.00', '0'), 's1'),
    on(ledgerCell('a-card', 'credit_card', '5200.00', '5200.00', 2), 's1'),
    on(ledgerCell('a-cash', 'cash', '0', '5200.00'), 's1'),
  ];
  const results = composePeriod({ period: may, coverage: ledgerCoverage(), cells, transferLegs: [], context: ctx });
  const counterparty = (key: string, id: string | null) =>
    results.find((r) => r.key === key && r.dimensionType === 'counterparty' && r.dimensionId === id);

  it('a supplier is its expense lines net of credits, never its settling lines', () => {
    // The old rule summed |every non-revenue cell|: 5,000 + 900 + 0 + 5,200 = 11,100.
    expect(counterparty('supplier_spend', 's1')?.value).toBe('5900.00');
  });

  it('a customer is its revenue lines net of refunds, so Σ customers + Unattributed = revenue', () => {
    expect(valueOf(results, 'revenue')).toBe('19400.00');
    expect(counterparty('customer_revenue', 'c1')?.value).toBe('17000.00');
    expect(counterparty('customer_revenue', null)?.value).toBe('2400.00');
  });

  it('builds each counterparty descriptor from the population the figure used', () => {
    for (const [key, id, accounts] of [
      ['customer_revenue', 'c1', ['a-rev']],
      ['supplier_spend', 's1', ['a-cos', 'a-mkt', 'a-pay']],
    ] as const) {
      const evidence = counterparty(key, id)?.evidenceQuery;
      if (evidence?.kind !== 'leaf') throw new Error(`expected a leaf for ${key}`);
      expect(evidence.descriptor.table).toBe('ledger_entries');
      expect(evidence.descriptor.filters).toEqual({
        period_ids: [may.id], counterparty_ids: [id], account_ids: [...accounts],
      });
    }
  });
});
