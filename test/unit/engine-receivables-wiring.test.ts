import { describe, expect, it } from 'vitest';

import {
  composePeriod, computeCash, computeCoverage, ENGINE_VERSION, invoiceOutstandingAt, invoiceSideCoverage,
  type AccountRef, type AggregateCell, type AgingInvoice, type BankAccountRef, type CoverageBatch,
  type EngineContext, type MetricResult, type OpeningCashCandidate, type PeriodRef, type ReceivablesComposeInput,
} from '@/modules/financial-engine';

/**
 * ADR-120: the receivables family wired into composition, and the cash chain's runway window.
 *
 * `computeReceivables` itself is covered by engine-receivables.test.ts. These tests pin the SEAM that
 * was missing — which source each side is answered from, when a zero is stated and when a figure is
 * unknown — and the one cash rule this remediation added: a month no statement fully covered has an
 * unknown movement, never a 0.00 burn.
 */

const aug: PeriodRef = {
  id: 'p-aug', periodStart: '2026-08-01', periodEnd: '2026-08-31',
  fiscalYear: 2026, fiscalQuarter: 3, label: 'Aug 2026', isComplete: true,
};
const jul: PeriodRef = { ...aug, id: 'p-jul', periodStart: '2026-07-01', periodEnd: '2026-07-31', label: 'Jul 2026' };
const jun: PeriodRef = { ...aug, id: 'p-jun', periodStart: '2026-06-01', periodEnd: '2026-06-30', label: 'Jun 2026' };

const account = (id: string, category: AccountRef['standardCategory'], type: AccountRef['accountType']): AccountRef =>
  ({ id, code: null, name: id, standardCategory: category, accountType: type, isSystem: true });

const ACCOUNTS: AccountRef[] = [
  account('a-ar', 'receivables', 'asset'),
  account('a-ap', 'payables', 'liability'),
  account('a-inv', 'inventory', 'asset'),
  account('a-rev', 'revenue', 'income'),
  account('a-cos', 'cost_of_sales', 'expense'),
];

const context = (over: Partial<EngineContext> = {}): EngineContext => ({
  organizationId: 'org-1', calculationRunId: 'run-1', aggregatedAt: '2026-09-15T00:00:00.000Z',
  asOf: '2026-09-15', engineVersion: ENGINE_VERSION,
  settings: {
    baseCurrency: 'GBP', fiscalYearStartMonth: 1, timezone: 'Europe/London',
    vatRegistered: false, defaultVatRate: null, taxableCategories: [],
  },
  costOfSalesEverUsed: true, costOfSalesInInvoices: false,
  accounts: ACCOUNTS, counterparties: [], bankAccounts: [], periods: [jun, jul, aug],
  ...over,
});

const batch = (over: Partial<CoverageBatch>): CoverageBatch => ({
  id: `b-${Math.random().toString(36).slice(2)}`, targetTable: 'invoices', balanceKind: null, balanceBasis: null,
  bankAccountId: null, invoiceListKind: 'full', importType: 'sales_invoices',
  periodStart: '2026-06-01', periodEnd: '2026-08-31', committedAt: '2026-09-01T00:00:00Z', ...over,
});

const sale = (over: Partial<AgingInvoice> & { id: string }): AgingInvoice => ({
  invoiceType: 'sales', counterpartyId: null, issueDate: '2026-08-03', dueDate: '2026-09-02',
  totalAmount: '1000.00', amountPaid: '0.00', balanceDue: '1000.00', paidDate: null, status: 'open', ...over,
});

const cell = (over: Partial<AggregateCell>): AggregateCell => ({
  periodId: aug.id, source: 'period_balances', standardCategory: null, accountId: null, counterpartyId: null,
  bankAccountId: null, balanceKind: 'trial_balance', balanceBasis: 'cumulative', invoiceType: null,
  transferKind: null, unpairedTransferCandidate: false, debit: '0', credit: '0', amount: '0', rowCount: 1,
  fallbackRows: 0, minDate: null, maxDate: null, ...over,
});

const noLedger = null;

function compose(
  receivables: Partial<ReceivablesComposeInput>,
  cells: readonly AggregateCell[] = [],
  over: Partial<EngineContext> = {},
  batchesForCoverage: readonly CoverageBatch[] = receivables.batches ?? [],
): readonly MetricResult[] {
  const ctx = context(over);
  const coverage = computeCoverage({
    period: aug, batches: batchesForCoverage, bankAccounts: ctx.bankAccounts,
    rowCounts: { ledger: cells.filter((c) => c.source === 'ledger' && c.periodId === aug.id).length }, asOf: ctx.asOf,
  });
  return composePeriod({
    period: aug, coverage, cells, transferLegs: [], context: ctx,
    receivables: {
      invoices: [], batches: [], asOfIsPeriodEnd: true, priorDenominators: [], ledger: noLedger, ...receivables,
    },
  });
}

const metric = (results: readonly MetricResult[], key: string): MetricResult => {
  const found = results.find((r) => r.key === key && r.dimensionType === 'none');
  if (!found) throw new Error(`no ${key}`);
  return found;
};

describe('the AR/AP invoice test is per side, and "after" means after (§2.2, ADR-120)', () => {
  it('covers a period its batch spans', () => {
    expect(invoiceSideCoverage([batch({})], aug, 'sales').covers).toBe(true);
  });

  it('covers a period whose list was committed within 45 days after it ended, when the list reaches back into it', () => {
    const asAt = batch({ periodStart: '2026-08-15', periodEnd: '2026-09-10', committedAt: '2026-10-15T09:00:00Z' });
    expect(invoiceSideCoverage([asAt], aug, 'sales').covers).toBe(true); // 45 days after 08-31
    const tooLate = batch({ periodStart: '2026-08-15', periodEnd: '2026-09-10', committedAt: '2026-10-16T09:00:00Z' });
    expect(invoiceSideCoverage([tooLate], aug, 'sales').covers).toBe(false); // 46 days
  });

  it('F-4 · a list whose range starts AFTER the period says nothing about it — never a verified zero', () => {
    // A March-only list committed 5 April used to "cover" February.
    const feb: PeriodRef = { ...aug, id: 'p-feb', periodStart: '2026-02-01', periodEnd: '2026-02-28', label: 'Feb 2026' };
    const march = batch({ periodStart: '2026-03-01', periodEnd: '2026-03-31', committedAt: '2026-04-05T09:00:00Z' });
    expect(invoiceSideCoverage([march], feb, 'sales')).toMatchObject({ covers: false, anyBatch: true });
  });

  it('and a list that ENDED before the period says nothing about it either', () => {
    const apr: PeriodRef = { ...aug, id: 'p-apr', periodStart: '2026-04-01', periodEnd: '2026-04-30', label: 'Apr 2026' };
    const march = batch({ periodStart: '2026-03-01', periodEnd: '2026-03-31', committedAt: '2026-04-05T09:00:00Z' });
    expect(invoiceSideCoverage([march], apr, 'sales').covers).toBe(false);
  });

  it('F-9 · a list uploaded DURING the current month covers it', () => {
    const sep: PeriodRef = { ...aug, id: 'p-sep', periodStart: '2026-09-01', periodEnd: '2026-09-30', label: 'Sep 2026', isComplete: false };
    const midMonth = batch({ periodStart: '2026-06-01', periodEnd: '2026-09-10', committedAt: '2026-09-10T10:00:00Z' });
    expect(invoiceSideCoverage([midMonth], sep, 'sales').covers).toBe(true);
  });

  it('never covers a period with a list committed BEFORE it ended', () => {
    const early = batch({ periodStart: '2026-01-01', periodEnd: '2026-01-31', committedAt: '2026-02-05T00:00:00Z' });
    const verdict = invoiceSideCoverage([early], aug, 'sales');
    expect(verdict.covers).toBe(false);
    expect(verdict.anyBatch).toBe(true);
  });

  it('a sales list says nothing about payables', () => {
    expect(invoiceSideCoverage([batch({})], aug, 'purchase')).toMatchObject({ covers: false, anyBatch: false });
  });

  it('knows a full list from an aged-debtors list', () => {
    expect(invoiceSideCoverage([batch({ invoiceListKind: 'open_items' })], aug, 'sales'))
      .toMatchObject({ covers: true, fullListSpans: false, openItemsSpans: true });
  });
});

describe('what one invoice still owed at a date — the one rule the engine and the resolver share', () => {
  it('counts an invoice paid AFTER the date at its whole total', () => {
    expect(invoiceOutstandingAt({ invoiceType: 'sales', paidDate: '2026-07-01', totalAmount: '1200', balanceDue: '0' }, '2026-06-30').toFixed(2)).toBe('1200.00');
  });
  it('counts an invoice paid on or before the date at what is left', () => {
    expect(invoiceOutstandingAt({ invoiceType: 'sales', paidDate: '2026-06-30', totalAmount: '1200', balanceDue: '0' }, '2026-06-30').toFixed(2)).toBe('0.00');
  });
  it('subtracts a credit note', () => {
    expect(invoiceOutstandingAt({ invoiceType: 'sales_credit_note', paidDate: null, totalAmount: '600', balanceDue: '600' }, '2026-08-31').toFixed(2)).toBe('-600.00');
  });
});

describe('receivables and payables from invoices (§3.4)', () => {
  const both = [batch({}), batch({ importType: 'purchase_invoices' })];

  it('A · a positive balance, aged as at the period end', () => {
    const results = compose({
      batches: both,
      invoices: [
        sale({ id: 'i-2', totalAmount: '2400', balanceDue: '2400', issueDate: '2026-07-10', dueDate: '2026-08-09' }),
        sale({ id: 'i-3', totalAmount: '3600', balanceDue: '2600', amountPaid: '1000', issueDate: '2026-08-03', dueDate: '2026-09-02' }),
        sale({ id: 'c-1', invoiceType: 'sales_credit_note', totalAmount: '600', balanceDue: '600', issueDate: '2026-08-20', dueDate: '2026-08-20' }),
        sale({ id: 'v-1', totalAmount: '9999', balanceDue: '9999', status: 'void' }),
      ],
    });
    expect(metric(results, 'receivables').value).toBe('4400.00');
    expect(metric(results, 'receivables_overdue').value).toBe('1800.00');
    expect(metric(results, 'receivables').basis).toBe('invoices');
    expect(metric(results, 'receivables').dataQuality.warnings).toContain('payment_date_unknown');
    expect(metric(results, 'receivables').evidenceQuery).toMatchObject({
      kind: 'leaf', descriptor: { table: 'invoices', filters: { open_as_of: '2026-08-31' } },
    });
  });

  it('B · a genuine zero: the list covers the period and nothing is outstanding', () => {
    const results = compose({ batches: both, invoices: [sale({ id: 'i-1', balanceDue: '0', amountPaid: '1000', paidDate: '2026-08-10', status: 'paid' })] });
    expect(metric(results, 'receivables').value).toBe('0.00');
    expect(metric(results, 'receivables').dataQuality.missing).toEqual([]);
  });

  it('C · unavailable, never zero, when no source covers the period', () => {
    const results = compose({ batches: [] });
    for (const key of ['receivables', 'receivables_overdue', 'payables', 'payables_overdue', 'working_capital']) {
      expect(metric(results, key).value, key).toBeNull();
      expect(metric(results, key).dataQuality.missing, key).toContain('no_source_covers_period');
    }
  });

  it('D/F · payables unknown when only a SALES list exists — never a stated zero', () => {
    const results = compose({ batches: [batch({})], invoices: [sale({ id: 'i-1' })] });
    expect(metric(results, 'receivables').value).toBe('1000.00');
    expect(metric(results, 'payables').value).toBeNull();
    expect(metric(results, 'payables').dataQuality.missing).toContain('no_source_covers_period');
  });

  it('E · payables genuinely zero when the purchase list covers the period and all is paid', () => {
    const results = compose({ batches: both, invoices: [sale({ id: 'p-1', invoiceType: 'purchase', balanceDue: '0', paidDate: '2026-08-02', status: 'paid' })] });
    expect(metric(results, 'payables').value).toBe('0.00');
  });

  it('stale: a list exists but none covers the period → stale_invoice_data', () => {
    const results = compose({ batches: [batch({ periodStart: '2026-01-01', periodEnd: '2026-01-31', committedAt: '2026-02-01T00:00:00Z' })] });
    expect(metric(results, 'receivables').value).toBeNull();
    expect(metric(results, 'receivables').dataQuality.missing).toContain('stale_invoice_data');
  });
});

describe('receivables and payables from a trial balance (§3.4 fallback)', () => {
  const tb = batch({ targetTable: 'period_balances', importType: 'trial_balance', balanceKind: 'trial_balance', invoiceListKind: null, periodStart: '2026-08-01', periodEnd: '2026-08-31' });

  it('reads the closing balance in reporting sign, and states a zero for an absent row', () => {
    const results = compose({ batches: [tb] }, [
      cell({ accountId: 'a-ar', standardCategory: 'receivables', amount: '9000' }),
      cell({ accountId: 'a-inv', standardCategory: 'inventory', amount: '2000' }),
    ], {}, [tb]);
    expect(metric(results, 'receivables').value).toBe('9000.00');
    expect(metric(results, 'receivables').basis).toBe('period_balances');
    // The trial balance lists no payables: a statement that lists no balance states zero.
    expect(metric(results, 'payables').value).toBe('0.00');
    expect(metric(results, 'receivables_overdue').value).toBeNull();
  });

  it('a liability stated as a credit reads positive', () => {
    const results = compose({ batches: [tb] }, [
      cell({ accountId: 'a-ar', standardCategory: 'receivables', amount: '100' }),
      cell({ accountId: 'a-ap', standardCategory: 'payables', amount: '-4000' }),
    ], {}, [tb]);
    expect(metric(results, 'payables').value).toBe('4000.00');
  });

  it('a movement-basis statement is not a balance', () => {
    const results = compose({ batches: [tb] }, [
      cell({ accountId: 'a-ar', standardCategory: 'receivables', amount: '9000', balanceBasis: 'movement' }),
    ], {}, [tb]);
    expect(metric(results, 'receivables').value).toBeNull();
  });
});

describe('receivables from the ledger (ADR-027.3 item 3)', () => {
  const gl = batch({ targetTable: 'ledger_entries', importType: 'general_ledger', invoiceListKind: null });
  const ledgerCells = [
    cell({ periodId: jun.id, source: 'ledger', accountId: 'a-ar', standardCategory: 'receivables', balanceKind: null, balanceBasis: null, debit: '9000', credit: '3000' }),
    cell({ periodId: aug.id, source: 'ledger', accountId: 'a-ar', standardCategory: 'receivables', balanceKind: null, balanceBasis: null, debit: '2000', credit: '6000' }),
  ];
  const periodStarts = new Map([[jun.id, jun.periodStart], [jul.id, jul.periodStart], [aug.id, aug.periodStart]]);

  it('is opening journal + every movement to P, and its evidence names every period it summed', () => {
    const results = compose({
      batches: [gl],
      ledger: { cells: ledgerCells, openingJournal: [{ accountId: 'a-ar', periodId: jun.id, debit: '5000', credit: '0' }], periodStarts },
    }, ledgerCells, {}, [gl]);
    // 9,000 − 3,000 (June, including the 5,000 opening line) + 2,000 − 6,000 = 2,000
    const ar = metric(results, 'receivables');
    expect(ar.value).toBe('2000.00');
    expect(ar.basis).toBe('ledger');
    expect(ar.components).toMatchObject({ opening_balance: '5000.00', movements: '-3000.00' });
    expect(ar.evidenceQuery).toMatchObject({
      kind: 'leaf', descriptor: { table: 'ledger_entries', filters: { period_ids: [aug.id, jun.id].sort(), account_ids: ['a-ar'] } },
    });
  });

  it('starts at the journal: movements before it are already inside it, and a month before it has no opening', () => {
    // The journal is posted in AUGUST; June's movements (+6,000) predate it and must not be added.
    const journal = [{ accountId: 'a-ar', periodId: aug.id, debit: '5000', credit: '0' }];
    const augCells = [...ledgerCells, cell({ periodId: aug.id, source: 'ledger', accountId: 'a-ar', standardCategory: 'receivables', balanceKind: null, balanceBasis: null, debit: '5000', credit: '0' })];
    const results = compose({ batches: [gl], ledger: { cells: augCells, openingJournal: journal, periodStarts } }, augCells, {}, [gl]);
    // August: journal 5,000 + (2,000 − 6,000) = 1,000 — June's 6,000 is not counted again.
    expect(metric(results, 'receivables').value).toBe('1000.00');
  });

  it('a month the GL export only partly reaches is not a stated balance', () => {
    const results = compose({
      batches: [], // no declared GL range spans August: rows alone make it a partial month
      ledger: { cells: ledgerCells, openingJournal: [{ accountId: 'a-ar', periodId: jun.id, debit: '5000', credit: '0' }], periodStarts },
    }, ledgerCells, {}, []);
    expect(metric(results, 'receivables').value).toBeNull();
  });

  it('without an opening journal a ledger total is not a balance → no_opening_balance', () => {
    const results = compose({ batches: [gl], ledger: null }, ledgerCells, {}, [gl]);
    expect(metric(results, 'receivables').value).toBeNull();
    expect(metric(results, 'receivables').dataQuality.missing).toContain('no_opening_balance');
  });
});

describe('working capital (§3.4, ADR-120)', () => {
  const both = [batch({}), batch({ importType: 'purchase_invoices' })];
  const bank: BankAccountRef = { id: 'ba', name: 'Main', accountType: 'current', openingBalance: '5000.00', openingBalanceDate: '2026-07-31', isActive: true };
  const bankBatch = batch({ targetTable: 'bank_transactions', importType: 'bank_statement', bankAccountId: 'ba', invoiceListKind: null, periodStart: '2026-08-01', periodEnd: '2026-08-31' });

  it('G · cash + receivables − payables when all three are known, naming the derived ids', () => {
    const results = compose({
      batches: [...both, bankBatch],
      invoices: [sale({ id: 'i-1', totalAmount: '4400', balanceDue: '4400' }), sale({ id: 'p-1', invoiceType: 'purchase', totalAmount: '900', balanceDue: '900' })],
    }, [], { bankAccounts: [bank] }, [...both, bankBatch]);
    const wc = metric(results, 'working_capital');
    expect(wc.value).toBe('8500.00'); // 5,000 + 4,400 − 900; no trial balance, so the balance-sheet terms are partial
    expect(wc.dataQuality.warnings).toContain('partial_working_capital');
  });

  it('a genuine zero: 5,000 cash + nothing owed to you − 5,000 owed = 0.00, a stated figure', () => {
    const results = compose({
      batches: [...both, bankBatch],
      invoices: [sale({ id: 'p-1', invoiceType: 'purchase', totalAmount: '5000', balanceDue: '5000' })],
    }, [], { bankAccounts: [bank] }, [...both, bankBatch]);
    const wc = metric(results, 'working_capital');
    expect(wc.value).toBe('0.00');
    expect(wc.dataQuality.missing).toEqual([]);
  });

  it('H · NULL when payables are unknown — never summed as nil', () => {
    const results = compose({ batches: [batch({}), bankBatch], invoices: [sale({ id: 'i-1' })] }, [], { bankAccounts: [bank] }, [bankBatch]);
    const wc = metric(results, 'working_capital');
    expect(wc.value).toBeNull();
    expect(wc.dataQuality.missing).toContain('no_source_covers_period');
  });
});

describe('the runway window reads only months a statement fully stated (ADR-120)', () => {
  const accounts: BankAccountRef[] = [{ id: 'ba', name: 'Main', accountType: 'current', openingBalance: '9000.00', openingBalanceDate: '2026-05-31', isActive: true }];
  const movement = (p: PeriodRef, outflow: string) => ({
    ...cell({ periodId: p.id, source: 'bank', bankAccountId: 'ba', balanceKind: null, balanceBasis: null, credit: outflow }),
    source: 'bank' as const, bankAccountId: 'ba', transferKind: 'none' as const, unpairedTransferCandidate: false,
  });
  const input = (p: PeriodRef, covered: readonly string[]) => ({
    period: p,
    basis: { basis: 'bank' as const, assurance: 'verified' as const, warnings: [], proxy: false },
    movements: [movement(p, '1000')],
    openingCandidates: [{ bankAccountId: 'ba', source: 'bank_account_opening_balance' as const, value: '9000.00', asAtDate: '2026-05-31' }],
    coveredBankAccountIds: covered,
  });

  it('three fully covered months give a runway', () => {
    const series = computeCash(context({ bankAccounts: accounts }), [input(jun, ['ba']), input(jul, ['ba']), input(aug, ['ba'])]);
    const runway = series[2]!.metrics.find((m) => m.key === 'cash_runway_months')!;
    expect(runway.value).toBe('6.000000'); // 6,000 / 1,000
  });

  it('a month with no statement makes the runway unknown instead of reading a 0.00 burn', () => {
    const series = computeCash(context({ bankAccounts: accounts }), [input(jun, ['ba']), input(jul, []), input(aug, ['ba'])]);
    const runway = series[2]!.metrics.find((m) => m.key === 'cash_runway_months')!;
    expect(runway.value).toBeNull();
    expect(runway.dataQuality.missing).toContain('insufficient_history');
  });

  it('a carried-in month that was not fully stated arrives as unknown', () => {
    const series = computeCash(context({ bankAccounts: accounts }), [input(aug, ['ba'])], {
      openingCarry: { value: '7000.00', basis: 'bank', assurance: 'verified', missing: [], coveredBankAccountIds: ['ba'] },
      priorNetMovements: [null, '-1000.00'],
    });
    const aug0 = series[0]!.metrics;
    expect(aug0.find((m) => m.key === 'opening_cash')!.value).toBe('7000.00');
    expect(aug0.find((m) => m.key === 'cash_runway_months')!.value).toBeNull();
  });
});

describe('opening cash: the statement\'s own opening balance comes first (CD-06, ADR-120 hardening)', () => {
  const bank: BankAccountRef = { id: 'ba', name: 'Main', accountType: 'current', openingBalance: '5000.00', openingBalanceDate: '2026-07-31', isActive: true };
  const statement = batch({ targetTable: 'bank_transactions', importType: 'bank_statement', bankAccountId: 'ba', invoiceListKind: null, periodStart: '2026-08-01', periodEnd: '2026-08-31' });
  const run = (statementOpenings: readonly OpeningCashCandidate[]) => {
    const ctx = context({ bankAccounts: [bank] });
    const coverage = computeCoverage({ period: aug, batches: [statement], bankAccounts: [bank], rowCounts: {}, asOf: ctx.asOf });
    return composePeriod({ period: aug, coverage, cells: [], transferLegs: [], context: ctx, coveredBankAccountIds: ['ba'], statementOpenings });
  };

  it('uses the statement\'s opening balance over the one typed on the account, and rates it verified', () => {
    const results = run([{ bankAccountId: 'ba', source: 'statement_opening_balance', value: '5200.00', asAtDate: '2026-08-01' }]);
    expect(metric(results, 'opening_cash').value).toBe('5200.00');
    expect(metric(results, 'opening_cash').assurance).toBe('verified');
  });

  it('falls back to the typed balance when no statement states one', () => {
    const results = run([]);
    expect(metric(results, 'opening_cash').value).toBe('5000.00');
    expect(metric(results, 'opening_cash').assurance).toBe('calculated');
  });
});

describe('the chain restart takes only a balance stated exactly at the period start (ADR-123, F-1/F-2)', () => {
  const statement = batch({ targetTable: 'bank_transactions', importType: 'bank_statement', bankAccountId: 'ba', invoiceListKind: null, periodStart: '2026-08-01', periodEnd: '2026-08-31' });
  const run = (bank: BankAccountRef, over: Partial<Parameters<typeof composePeriod>[0]> = {}) => {
    const ctx = context({ bankAccounts: [bank] });
    const coverage = computeCoverage({ period: aug, batches: [statement], bankAccounts: [bank], rowCounts: {}, asOf: ctx.asOf });
    return composePeriod({ period: aug, coverage, cells: [], transferLegs: [], context: ctx, coveredBankAccountIds: ['ba'], ...over });
  };
  const typedLongAgo: BankAccountRef = { id: 'ba', name: 'Main', accountType: 'current', openingBalance: '10000.00', openingBalanceDate: '2026-05-31', isActive: true };

  it('refuses a typed balance from months earlier on a restart — unknown, not a stale figure', () => {
    const results = run(typedLongAgo, { openingExactOnly: true });
    expect(metric(results, 'opening_cash').value).toBeNull();
    expect(metric(results, 'opening_cash').dataQuality.missing).toContain('no_opening_cash');
  });

  it('accepts a typed balance dated the day before the restart', () => {
    const results = run({ ...typedLongAgo, openingBalanceDate: '2026-07-31' }, { openingExactOnly: true });
    expect(metric(results, 'opening_cash').value).toBe('10000.00');
  });

  it('accepts the statement that starts that day, and prefers it', () => {
    const results = run(typedLongAgo, {
      openingExactOnly: true,
      statementOpenings: [{ bankAccountId: 'ba', source: 'statement_opening_balance', value: '4000.00', asAtDate: '2026-08-01' }],
    });
    expect(metric(results, 'opening_cash').value).toBe('4000.00');
    expect(metric(results, 'opening_cash').assurance).toBe('verified');
  });

  it('the printed closing cross-checks the computed close; a mismatch is flagged, not overwritten', () => {
    const results = run({ ...typedLongAgo, openingBalanceDate: '2026-07-31' }, {
      statementClosing: [{ bankAccountId: 'ba', balanceAfter: '9000.00' }],
    });
    const closing = metric(results, 'closing_cash');
    expect(closing.value).toBe('10000.00');
    expect(closing.dataQuality.warnings).toContain('statement_balance_mismatch');
    expect(closing.components).toMatchObject({ statement_closing_cash: '9000.00', statement_delta: '-1000.00' });
  });

  it('a statement that did not reconcile at import marks the month', () => {
    const results = run({ ...typedLongAgo, openingBalanceDate: '2026-07-31' }, { unreconciledStatement: true });
    expect(metric(results, 'closing_cash').dataQuality.warnings).toContain('unreconciled_statement');
  });
});
