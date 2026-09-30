import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { Decimal } from '@/core/money';

import {
  buildCashHistory, composePeriod, computeCoverage, ENGINE_VERSION, invoiceSideCoverage, variancesForPeriod,
  type AccountRef, type AggregateCell, type AgingInvoice, type BankAccountRef, type CoverageBatch,
  type DailyMovement, type EngineContext, type MetricResult, type PeriodRef, type StatementRef,
} from '@/modules/financial-engine';

/**
 * ADR-124 D-6 — a change to what the engine computes cannot ship without an engine version bump.
 *
 * FINANCIAL_ENGINE.md §6 makes the version the ONLY thing that re-queues every organisation for a
 * recalculation (`api_server.enqueue_engine_upgrade`). ADR-123 changed figures and kept 2.0.0, and
 * the second independent audit found the consequence (N-6): organisations computed before it kept
 * their old figures, and later runs built on them. A reviewer remembering to bump is not a control.
 *
 * This test is. It runs the pure engine over a fixed corpus — every family: P&L on a ledger, cash
 * from per-account statement histories, receivables and payables from invoices, a balance sheet and
 * a dated opening journal, the AR/AP freshness matrix, and the variance pass — and hashes the
 * canonical output. The hash is recorded beside the version it was produced by, in
 * `test/fixtures/engine-golden.json`:
 *
 *   - outputs changed, version unchanged → FAILS: bump ENGINE_VERSION (major when an existing value
 *     changes, §6) and record the new hash;
 *   - version changed → FAILS until the hash is recorded for it: `ENGINE_GOLDEN_RECORD=1 npm test`.
 *     Recording refuses to overwrite a hash for the SAME version, so the escape hatch cannot be used
 *     to hide a change.
 *
 * The corpus's context carries a fixed version string, so the hash measures what the engine
 * computes, not what it is called.
 */

const GOLDEN = path.resolve('test/fixtures/engine-golden.json');

// ---------------------------------------------------------------------------------------------
// The corpus
// ---------------------------------------------------------------------------------------------

const month = (ym: string, n: number): PeriodRef => {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return {
    id: `00000000-0000-4000-8000-0000000001${String(n).padStart(2, '0')}`,
    periodStart: `${ym}-01`, periodEnd: `${ym}-${String(last).padStart(2, '0')}`,
    fiscalYear: y, fiscalQuarter: Math.floor((m - 1) / 3) + 1, label: ym, isComplete: true,
  };
};
const PERIODS = ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09'].map(month);
const [MAY, JUN, JUL, AUG, SEP] = PERIODS as [PeriodRef, PeriodRef, PeriodRef, PeriodRef, PeriodRef];

const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const account = (n: number, category: AccountRef['standardCategory'], type: AccountRef['accountType']): AccountRef =>
  ({ id: id(n), code: String(n), name: `${category}-${n}`, standardCategory: category, accountType: type, isSystem: true });
const ACCOUNTS: AccountRef[] = [
  account(11, 'revenue', 'income'), account(12, 'cost_of_sales', 'expense'), account(13, 'operating_expense', 'expense'),
  account(14, 'receivables', 'asset'), account(15, 'payables', 'liability'), account(16, 'cash', 'asset'),
  account(17, 'equity', 'equity'), account(18, 'marketing', 'expense'),
];
const [REV, COS, OPEX, AR, AP, , EQ, MKT] = ACCOUNTS.map((a) => a.id) as string[];

const BANK_A = id(21);
const BANK_B = id(22);
const CARD = id(23);
const BANKS: BankAccountRef[] = [
  { id: BANK_A, name: 'Main', accountType: 'current', openingBalance: '10000', openingBalanceDate: '2026-04-30', isActive: true },
  { id: BANK_B, name: 'Savings', accountType: 'savings', openingBalance: '2000', openingBalanceDate: '2026-06-30', isActive: true },
  { id: CARD, name: 'Card', accountType: 'credit_card', openingBalance: null, openingBalanceDate: null, isActive: true },
];
const CUSTOMER = id(31);
const SUPPLIER = id(32);

const context = (): EngineContext => ({
  organizationId: id(1), calculationRunId: id(2), aggregatedAt: '2026-09-15T00:00:00.000Z', asOf: '2026-09-15',
  engineVersion: 'golden',
  settings: { baseCurrency: 'GBP', fiscalYearStartMonth: 4, timezone: 'Europe/London', vatRegistered: true, defaultVatRate: '0.20', taxableCategories: ['revenue', 'cost_of_sales', 'operating_expense', 'marketing'] },
  costOfSalesEverUsed: true, costOfSalesInInvoices: false, accounts: ACCOUNTS,
  counterparties: [
    { id: CUSTOMER, name: 'Customer Ltd', kind: 'customer', mergedIntoId: null, defaultExpenseCategory: null },
    { id: SUPPLIER, name: 'Supplier Ltd', kind: 'supplier', mergedIntoId: null, defaultExpenseCategory: 'cost_of_sales' },
  ],
  bankAccounts: BANKS, periods: PERIODS,
});

const cell = (over: Partial<AggregateCell>): AggregateCell => ({
  periodId: JUN.id, source: 'ledger', standardCategory: null, accountId: null, counterpartyId: null, bankAccountId: null,
  balanceKind: null, balanceBasis: null, invoiceType: null, transferKind: null, unpairedTransferCandidate: false,
  debit: '0', credit: '0', amount: '0', rowCount: 1, fallbackRows: 0, minDate: null, maxDate: null, ...over,
});
const ledger = (p: PeriodRef, accountId: string, category: AggregateCell['standardCategory'], debit: string, credit: string, counterpartyId: string | null = null): AggregateCell =>
  cell({ periodId: p.id, source: 'ledger', accountId, standardCategory: category, counterpartyId, debit, credit,
    amount: (Number(debit) - Number(credit)).toFixed(2) });
const bankCell = (p: PeriodRef, bankAccountId: string, inflow: string, outflow: string, category: AggregateCell['standardCategory'], transferKind = 'none'): AggregateCell =>
  cell({ periodId: p.id, source: 'bank', bankAccountId, standardCategory: category, debit: inflow, credit: outflow,
    amount: (Number(inflow) - Number(outflow)).toFixed(2), transferKind });

const CELLS: AggregateCell[] = [
  // A ledger P&L for June–August, with a mid-July export split carrying an opening journal on 15 July.
  ...[JUN, JUL, AUG].flatMap((p, i) => [
    ledger(p, REV!, 'revenue', '0', String(9000 + i * 1500), CUSTOMER),
    ledger(p, COS!, 'cost_of_sales', String(4000 + i * 300), '0', SUPPLIER),
    ledger(p, OPEX!, 'operating_expense', String(2500 - i * 200), '0'),
    ledger(p, MKT!, 'marketing', '400', '0'),
    ledger(p, AR!, 'receivables', String(9000 + i * 1500), String(8000 + i * 1000), CUSTOMER),
    ledger(p, AP!, 'payables', String(3000 + i * 100), String(4000 + i * 300), SUPPLIER),
  ]),
  ledger(JUN, AR!, 'receivables', '6000', '0'), ledger(JUN, EQ!, 'equity', '0', '6000'),
  ledger(JUL, AR!, 'receivables', '7200', '0'), ledger(JUL, EQ!, 'equity', '0', '7200'),
  // Bank rows: A every month, B from July, a card repayment and a cash transfer A → B.
  bankCell(MAY, BANK_A, '0', '1000', 'operating_expense'),
  bankCell(JUN, BANK_A, '8000', '6500', 'revenue'),
  bankCell(JUL, BANK_A, '9500', '7000', 'revenue'), bankCell(JUL, BANK_A, '0', '500', 'payables', 'card_repayment'),
  bankCell(JUL, BANK_A, '0', '1000', null, 'cash_transfer'), bankCell(JUL, BANK_B, '1000', '0', null, 'cash_transfer'),
  bankCell(AUG, BANK_A, '11000', '9800', 'revenue'), bankCell(AUG, BANK_B, '25', '0', 'other_income'),
  // A balance sheet for August, cumulative, to meet the ledger and the lists.
  cell({ periodId: AUG.id, source: 'period_balances', balanceKind: 'balance_sheet', balanceBasis: 'cumulative', accountId: AR!, standardCategory: 'receivables', amount: '8100', debit: '8100' }),
  cell({ periodId: AUG.id, source: 'period_balances', balanceKind: 'balance_sheet', balanceBasis: 'cumulative', accountId: AP!, standardCategory: 'payables', amount: '-2600', credit: '2600' }),
];

const MOVEMENTS: DailyMovement[] = [
  { bankAccountId: BANK_A, date: '2026-05-12', amount: '-1000' },
  { bankAccountId: BANK_A, date: '2026-06-05', amount: '8000' }, { bankAccountId: BANK_A, date: '2026-06-20', amount: '-6500' },
  { bankAccountId: BANK_A, date: '2026-07-03', amount: '9500' }, { bankAccountId: BANK_A, date: '2026-07-18', amount: '-8500' },
  { bankAccountId: BANK_B, date: '2026-07-18', amount: '1000' },
  { bankAccountId: BANK_A, date: '2026-08-04', amount: '11000' }, { bankAccountId: BANK_A, date: '2026-08-22', amount: '-9800' },
  { bankAccountId: BANK_B, date: '2026-08-31', amount: '25' },
];
const STATEMENTS: StatementRef[] = [
  // A: 5th-to-4th cycles from May, the first printing its opening; B: calendar months from July.
  { batchId: id(41), bankAccountId: BANK_A, periodStart: '2026-05-05', periodEnd: '2026-06-04', committedAt: '2026-09-01T00:00:00Z', openingBalance: '10000', closingBalance: '9000', unreconciled: false },
  { batchId: id(42), bankAccountId: BANK_A, periodStart: '2026-06-05', periodEnd: '2026-07-04', committedAt: '2026-09-01T00:00:00Z', openingBalance: '9000', closingBalance: '20000', unreconciled: false },
  { batchId: id(43), bankAccountId: BANK_A, periodStart: '2026-07-05', periodEnd: '2026-08-31', committedAt: '2026-09-01T00:00:00Z', openingBalance: null, closingBalance: '12200', unreconciled: true },
  { batchId: id(44), bankAccountId: BANK_B, periodStart: '2026-07-01', periodEnd: '2026-08-31', committedAt: '2026-09-01T00:00:00Z', openingBalance: '2000', closingBalance: '3025', unreconciled: false },
];

const batch = (n: number, over: Partial<CoverageBatch>): CoverageBatch => ({
  id: id(60 + n), targetTable: 'invoices', balanceKind: null, balanceBasis: null, bankAccountId: null,
  invoiceListKind: 'full', importType: 'sales_invoices', periodStart: '2026-06-01', periodEnd: '2026-08-31',
  committedAt: '2026-09-10T10:00:00Z', ...over,
});
const BATCHES: CoverageBatch[] = [
  batch(1, {}),
  batch(2, { importType: 'purchase_invoices', invoiceListKind: 'open_items', periodStart: '2026-07-01', periodEnd: '2026-07-31', committedAt: '2026-08-20T00:00:00Z' }),
  batch(3, { targetTable: 'ledger_entries', invoiceListKind: null, importType: 'general_ledger', periodStart: '2026-06-01', periodEnd: '2026-07-14' }),
  batch(4, { targetTable: 'ledger_entries', invoiceListKind: null, importType: 'general_ledger', periodStart: '2026-07-15', periodEnd: '2026-08-31' }),
  batch(5, { targetTable: 'period_balances', invoiceListKind: null, importType: 'balance_sheet', balanceKind: 'balance_sheet', balanceBasis: 'cumulative', periodStart: '2026-08-01', periodEnd: '2026-08-31' }),
  ...STATEMENTS.map((st, i) => batch(10 + i, { targetTable: 'bank_transactions', invoiceListKind: null, importType: 'bank_statement', bankAccountId: st.bankAccountId, periodStart: st.periodStart, periodEnd: st.periodEnd })),
];

const INVOICES: AgingInvoice[] = [
  { id: id(71), invoiceType: 'sales', counterpartyId: CUSTOMER, issueDate: '2026-06-10', dueDate: '2026-07-10', totalAmount: '4000.00', amountPaid: '1500.00', balanceDue: '2500.00', paidDate: '2026-07-20', status: 'partially_paid' },
  { id: id(72), invoiceType: 'sales', counterpartyId: CUSTOMER, issueDate: '2026-07-15', dueDate: '2026-08-14', totalAmount: '5200.00', amountPaid: '0.00', balanceDue: '5200.00', paidDate: null, status: 'open' },
  { id: id(73), invoiceType: 'sales_credit_note', counterpartyId: CUSTOMER, issueDate: '2026-08-20', dueDate: '2026-09-30', totalAmount: '800.00', amountPaid: '0.00', balanceDue: '800.00', paidDate: null, status: 'open' },
  { id: id(74), invoiceType: 'purchase', counterpartyId: SUPPLIER, issueDate: '2026-07-02', dueDate: '2026-07-30', totalAmount: '3100.00', amountPaid: '3100.00', balanceDue: '0.00', paidDate: '2026-08-15', status: 'paid' },
  { id: id(75), invoiceType: 'purchase', counterpartyId: SUPPLIER, issueDate: '2026-08-05', dueDate: '2026-09-04', totalAmount: '2600.00', amountPaid: '0.00', balanceDue: '2600.00', paidDate: null, status: 'open' },
];

/** Every output of the corpus, in one canonical structure. */
function corpus(): unknown {
  const ctx = context();
  const history = buildCashHistory({ bankAccounts: BANKS, statements: STATEMENTS, movements: MOVEMENTS, periods: PERIODS });
  const journal = [
    { accountId: AR!, periodId: JUN.id, entryDate: '2026-06-01', debit: '6000', credit: '0' },
    { accountId: EQ!, periodId: JUN.id, entryDate: '2026-06-01', debit: '0', credit: '6000' },
    { accountId: AR!, periodId: JUL.id, entryDate: '2026-07-15', debit: '7200', credit: '0' },
    { accountId: EQ!, periodId: JUL.id, entryDate: '2026-07-15', debit: '0', credit: '7200' },
  ];
  const preJournal = [{ journalDate: '2026-07-15', accountId: AR!, debit: '900', credit: '400' }];
  const periodStarts = new Map(PERIODS.map((p) => [p.id, p.periodStart]));

  let minted = 0;
  const computed = new Map<string, readonly MetricResult[]>();
  const out: Record<string, unknown> = {};
  for (const period of PERIODS) {
    const rowCounts = {
      ledger: CELLS.filter((c) => c.periodId === period.id && c.source === 'ledger').length,
      bank: CELLS.filter((c) => c.periodId === period.id && c.source === 'bank').length,
      period_balances: CELLS.filter((c) => c.periodId === period.id && c.source === 'period_balances').length,
    };
    const coverage = computeCoverage({ period, batches: BATCHES, bankAccounts: BANKS, rowCounts, asOf: ctx.asOf, statements: STATEMENTS });
    const results = composePeriod({
      period, coverage, cells: CELLS, transferLegs: [], context: ctx,
      cashAccounts: history.get(period.id) ?? [],
      receivables: {
        invoices: INVOICES, batches: BATCHES, asOfIsPeriodEnd: period.id !== SEP.id, priorDenominators: [],
        ledger: { cells: CELLS, openingJournal: journal, periodStarts, preJournal },
      },
    }).map((r, i) => ({ ...r, id: `level-${period.label}-${i}` }));
    const variances = variancesForPeriod({
      period, allPeriods: PERIODS, results, computed, stored: [], currency: 'GBP', mint: () => `v-${(minted += 1)}`,
    });
    computed.set(period.id, [...results, ...variances]);
    out[period.label] = { coverage, results, variances };
  }
  const freshness: Record<string, unknown> = {};
  for (const period of PERIODS) {
    for (const current of [false, true]) {
      freshness[`${period.label}/${current ? 'current' : 'completed'}`] = (['sales', 'purchase'] as const)
        .map((side) => invoiceSideCoverage(BATCHES, period, side, current));
    }
  }
  // The boundaries themselves, one list at a time, so a change to any of them changes the hash: the
  // 45-day window either side, a list committed during the month, an aged-debtors list on and after
  // the month end, a range that stops short of it.
  const july = JUL;
  const boundary: Array<[string, Partial<CoverageBatch>]> = [
    ['full +44', { periodStart: '2026-07-15', periodEnd: '2026-08-15', committedAt: '2026-09-13T00:00:00Z' }],
    ['full +45', { periodStart: '2026-07-15', periodEnd: '2026-08-15', committedAt: '2026-09-14T00:00:00Z' }],
    ['full +46', { periodStart: '2026-07-15', periodEnd: '2026-08-15', committedAt: '2026-09-15T00:00:00Z' }],
    ['during', { periodStart: '2026-06-01', periodEnd: '2026-07-20', committedAt: '2026-07-20T00:00:00Z' }],
    ['open-items at end', { invoiceListKind: 'open_items', periodStart: '2026-07-31', periodEnd: '2026-07-31', committedAt: '2026-08-02T00:00:00Z' }],
    ['open-items later', { invoiceListKind: 'open_items', periodStart: '2026-08-05', periodEnd: '2026-08-05', committedAt: '2026-08-06T00:00:00Z' }],
    ['open-items spanning', { invoiceListKind: 'open_items', periodStart: '2026-01-01', periodEnd: '2026-08-05', committedAt: '2026-08-06T00:00:00Z' }],
    ['stops short', { periodStart: '2026-06-01', periodEnd: '2026-07-30', committedAt: '2026-08-02T00:00:00Z' }],
  ];
  // A printed closing a penny and two pennies off the chain, for the §3.3 cross-check's tolerance; and a
  // journal dated on a month's last day, for "effective by P's end".
  const tolerance = ['0.01', '0.02'].map((delta) => buildCashHistory({
    bankAccounts: [BANKS[0]!],
    statements: [{ ...STATEMENTS[0]!, periodStart: '2026-05-01', periodEnd: '2026-05-31', openingBalance: '100', closingBalance: new Decimal(100).plus(delta).toFixed(2) }],
    movements: [], periods: [MAY],
  }).get(MAY.id));
  // The ledger branch on its own (no list, no balance sheet): the mid-month journal with the rows
  // before it, and a journal dated on a month's last day.
  const ledgerBatches = BATCHES.filter((b) => b.targetTable === 'ledger_entries');
  const ledgerOnly = (journals: typeof journal) => [JUN, JUL, AUG].map((p) => composePeriod({
    period: p, coverage: computeCoverage({ period: p, batches: ledgerBatches, bankAccounts: [], rowCounts: { ledger: 1 }, asOf: ctx.asOf }),
    cells: CELLS.filter((c) => c.source === 'ledger'), transferLegs: [], context: ctx,
    receivables: { invoices: [], batches: ledgerBatches, asOfIsPeriodEnd: true, priorDenominators: [],
      ledger: { cells: CELLS, openingJournal: journals, periodStarts, preJournal } },
  }).filter((r) => r.key === 'receivables' || r.key === 'payables'));
  const lastDayJournal = [
    ledgerOnly(journal),
    ledgerOnly([...journal, { accountId: AR!, periodId: AUG.id, entryDate: '2026-08-31', debit: '9999', credit: '0' }]),
  ];
  for (const [name, over] of boundary) {
    freshness[`boundary/${name}`] = [false, true].map((current) => invoiceSideCoverage([batch(90, over)], july, 'sales', current));
  }
  return { periods: out, freshness, history: [...history.entries()], tolerance, lastDayJournal };
}

/** Canonical JSON: keys sorted at every level, so the hash depends on content and not on insertion order. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (value instanceof Map) return canonical([...value.entries()]);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

const hashOf = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');

describe('engine version golden (ADR-124 D-6)', () => {
  const recorded = JSON.parse(readFileSync(GOLDEN, 'utf8')) as { engineVersion: string; hash: string };
  const actual = hashOf(corpus());

  it('the corpus is deterministic', () => {
    expect(hashOf(corpus())).toBe(actual);
  });

  it('changes nothing the engine computes without an ENGINE_VERSION bump', () => {
    if (process.env.ENGINE_GOLDEN_RECORD === '1' && recorded.engineVersion !== ENGINE_VERSION) {
      writeFileSync(GOLDEN, `${JSON.stringify({ engineVersion: ENGINE_VERSION, hash: actual }, null, 2)}\n`);
      return;
    }
    expect(
      recorded.engineVersion,
      `ENGINE_VERSION is ${ENGINE_VERSION} but the golden hash was recorded for ${recorded.engineVersion}. `
      + 'Record it for the new version: ENGINE_GOLDEN_RECORD=1 npx vitest run --project unit test/unit/engine-version-golden.test.ts',
    ).toBe(ENGINE_VERSION);
    expect(
      actual,
      `The engine's outputs changed but ENGINE_VERSION is still ${ENGINE_VERSION}. FINANCIAL_ENGINE.md §6: a change to an `
      + 'existing value is a MAJOR bump, and the bump is what re-queues every organisation (api_server.enqueue_engine_upgrade). '
      + 'Bump src/modules/financial-engine/domain/version.ts, then record: ENGINE_GOLDEN_RECORD=1 npx vitest run --project unit test/unit/engine-version-golden.test.ts',
    ).toBe(recorded.hash);
  });

  it('the corpus reaches every family it guards', () => {
    // A corpus that produced only NULLs would hash the same whatever the engine did.
    const out = corpus() as { periods: Record<string, { results: MetricResult[] }> };
    const known = (ym: string, key: string): boolean =>
      out.periods[ym]!.results.some((r) => r.key === key && r.dimensionType === 'none' && r.value !== null);
    for (const [ym, key] of [
      ['2026-06', 'revenue'], ['2026-07', 'closing_cash'], ['2026-08', 'closing_cash'], ['2026-08', 'net_cash_movement'],
      ['2026-08', 'receivables'], ['2026-08', 'payables'], ['2026-08', 'working_capital'], ['2026-07', 'receivables'],
    ] as const) {
      expect(known(ym, key), `${ym} ${key}`).toBe(true);
    }
  });
});
