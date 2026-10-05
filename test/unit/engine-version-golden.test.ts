import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { Decimal } from '@/core/money';

import {
  balancePnlContext, balanceRowsByKind, bankRecordAssuranceFor, buildCashHistory, composePeriod, computeCoverage, computeReceivables, denominatorInputsFor,
  ENGINE_VERSION, invoiceSideCoverage, isPeriodComplete, statementRecordAssurance, variancesForPeriod,
  type AccountRef, type AggregateCell, type AgingInvoice, type BankAccountRef, type CoverageBatch,
  type DailyMovement, type EngineContext, type MetricResult, type PeriodRef, type ReceivablesPeriodInput, type StatementRef,
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
 * a dated opening journal, the AR/AP freshness matrix, the variance pass, (ADR-122 FU-1) when an
 * invoice list may state a month's revenue and (FU-12) when it may state its costs — and hashes the
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
  // R-2: these lists stand for complete exports — confirmed to hold every invoice open at their start.
  openingConfirmed: true,
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
    // FU-15 (ADR-128): a list knows through min(declared end, commit date).
    ['declared past commit', { periodStart: '2026-07-01', periodEnd: '2026-07-31', committedAt: '2026-07-10T00:00:00Z' }],
    ['late month-end', { periodStart: '2026-07-01', periodEnd: '2026-07-31', committedAt: '2026-11-20T00:00:00Z' }],
    ['open-items as at end, committed before it', { invoiceListKind: 'open_items', periodStart: '2026-07-31', periodEnd: '2026-07-31', committedAt: '2026-07-20T00:00:00Z' }],
    ['committed before the month, range over it', { periodStart: '2026-07-01', periodEnd: '2026-07-31', committedAt: '2026-06-28T00:00:00Z' }],
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
  return {
    periods: out, freshness, history: [...history.entries()], tolerance, lastDayJournal,
    fu1: fu1Corpus(ctx), fu12: fu12Corpus(ctx), fu12Variance: fu12VarianceCorpus(ctx),
    fu9: fu9Corpus(ctx), adr130: adr130Corpus(ctx), adr133: adr133Corpus(ctx), step0d: step0dCorpus(), step0e: step0eCorpus(ctx),
  };
}

/**
 * FU-9 (ADR-129): payables days on one VAT footing. The invoice path over the purchase lists' gross;
 * the balance path over a gross expense base only — a net or unknown base is NULL `vat_basis_unknown`.
 */
function fu9Corpus(ctx: EngineContext): unknown {
  const purchaseList = batch(95, { importType: 'purchase_invoices', periodStart: '2026-06-01', periodEnd: '2026-08-31' });
  const gross = [JUN, JUL, AUG].map((p) => denominatorInputsFor(p, [], [
    cell({ periodId: p.id, source: 'invoices', invoiceType: 'purchase', counterpartyId: SUPPLIER, amount: '1000.00', debit: '200.00' }),
    cell({ periodId: p.id, source: 'invoices', invoiceType: 'purchase', counterpartyId: SUPPLIER, amount: '500.00', debit: '0.00' }),
    cell({ periodId: p.id, source: 'invoices', invoiceType: 'purchase_credit_note', counterpartyId: SUPPLIER, amount: '100.00', debit: '20.00' }),
  ], [purchaseList]));
  const ap = INVOICES.filter((i) => i.invoiceType === 'purchase');
  const input = (p: PeriodRef, i: number, over: Partial<ReceivablesPeriodInput>): ReceivablesPeriodInput => ({
    ...gross[i]!,
    period: p, basis: { basis: 'invoices', assurance: 'verified', warnings: [], proxy: false }, asOfIsPeriodEnd: true,
    invoices: ap, receivablesFallback: { accountIds: [] }, payablesFallback: { accountIds: [AP!] },
    balanceSheetClosings: {}, closingCash: null,
    payablesExpenseBase: '6000.00', payablesExpenseBasis: 'ledger', ...over,
  });
  const days = (settings: Partial<EngineContext['settings']>, over: Partial<ReceivablesPeriodInput>) =>
    computeReceivables({ ...ctx, settings: { ...ctx.settings, ...settings } }, [JUN, JUL, AUG].map((p, i) => input(p, i, over)))
      .map((pm) => pm.metrics.find((m) => m.key === 'payables_days'));
  const fromBalance = { invoices: null, purchaseInvoices: null, payablesFallback: { accountIds: [AP!], periodBalanceClosing: '2600.00', periodBalanceKind: 'balance_sheet' as const } };
  return {
    gross: gross.map((g) => g.purchaseInvoiceGross),
    invoices: days({}, {}),
    notRegistered: days({ vatRegistered: false, vatStatusKnown: true }, fromBalance),
    registered: days({ vatRegistered: true, vatStatusKnown: true }, fromBalance),
    unknown: days({ vatRegistered: false, vatStatusKnown: false }, fromBalance),
    bank: days({ vatRegistered: true, vatStatusKnown: true }, { ...fromBalance, payablesExpenseBasis: 'bank' }),
  };
}

/**
 * ADR-133: `receivables_days` over gross revenue only (no default-rate netting), and a bank flow the
 * proxy netted by a default rate is `unknown` for both days figures.
 */
function adr133Corpus(ctx: EngineContext): unknown {
  const input = (p: PeriodRef, revenueBasis: ReceivablesPeriodInput['revenueBasis']): ReceivablesPeriodInput => ({
    period: p, basis: { basis: 'period_balances', assurance: 'calculated', warnings: [], proxy: false }, asOfIsPeriodEnd: true,
    invoices: null, salesInvoices: null, purchaseInvoices: null,
    receivablesFallback: { accountIds: [AR!], periodBalanceClosing: '8100.00', periodBalanceKind: 'balance_sheet' },
    payablesFallback: { accountIds: [AP!], periodBalanceClosing: '2600.00', periodBalanceKind: 'balance_sheet' },
    balanceSheetClosings: {}, closingCash: null, revenue: '9000.00', revenueBasis, invoiceSalesTotal: null,
    payablesExpenseBase: '6000.00', payablesExpenseBasis: revenueBasis, hasOpenItemsList: false,
  });
  const days = (settings: Partial<EngineContext['settings']>, basis: ReceivablesPeriodInput['revenueBasis']) =>
    computeReceivables({ ...ctx, settings: { ...ctx.settings, ...settings } }, [JUN, JUL, AUG].map((p) => input(p, basis)))[2]!
      .metrics.filter((m) => m.key.endsWith('_days')).map((m) => [m.key, m.value, m.dataQuality.missing, m.components.denominator_basis ?? null]);
  return {
    ledgerNotRegistered: days({ vatRegistered: false, vatStatusKnown: true }, 'ledger'),
    ledgerRegistered: days({ vatRegistered: true, vatStatusKnown: true, defaultVatRate: '0.20' }, 'ledger'),
    ledgerUnknown: days({ vatRegistered: false, vatStatusKnown: false }, 'ledger'),
    bankNetted: days({ vatRegistered: true, vatStatusKnown: true, defaultVatRate: '0.20' }, 'bank'),
    bankGross: days({ vatRegistered: false, vatStatusKnown: true, defaultVatRate: null }, 'bank'),
  };
}

/**
 * ADR-130: a bank figure is no firmer than the bank rows under it. The main corpus with August's
 * statement read by AI (inferred) and July's PDF unreconciled (calculated): cash and every bank-basis
 * figure carry the weaker level; values are unchanged.
 */
function adr130Corpus(ctx: EngineContext): unknown {
  const statements: StatementRef[] = STATEMENTS.map((st) => (st.batchId === id(43)
    ? { ...st, assurance: statementRecordAssurance('pdf_claude', st.unreconciled) }
    : st.batchId === id(42) ? { ...st, assurance: statementRecordAssurance('pdf_text', true) } : st));
  const history = buildCashHistory({ bankAccounts: BANKS, statements, movements: MOVEMENTS, periods: PERIODS });
  const bankOnly = BATCHES.filter((b) => b.targetTable === 'bank_transactions');
  return Object.fromEntries([JUN, JUL, AUG].map((period) => {
    const coverage = computeCoverage({ period, batches: bankOnly, bankAccounts: BANKS, rowCounts: { bank: 1 }, asOf: ctx.asOf, statements });
    const level = bankRecordAssuranceFor(statements, period);
    const results = composePeriod({
      period, coverage, cells: CELLS.filter((c) => c.source === 'bank'), transferLegs: [], context: ctx,
      cashAccounts: history.get(period.id) ?? [], bankRecordAssurance: level,
    }).map((r) => [r.key, r.dimensionId, r.value, r.basis, r.assurance]);
    return [period.label, { level, results }];
  }));
}

/**
 * Step 0D: a balance carried out of an AI-read month. Account A's July–August statement is read by
 * AI; September's CSV statement has no printed balances, so September's opening and closing are
 * carried through it (inferred, resting on that batch). A variant prints September's opening, which
 * agrees with the chain and attests it (verified again).
 */
function step0dCorpus(): unknown {
  const SEP_ROW: DailyMovement = { bankAccountId: BANK_A, date: '2026-09-09', amount: '-300' };
  const sep = (open: string | null): StatementRef => ({
    batchId: id(45), bankAccountId: BANK_A, periodStart: '2026-09-01', periodEnd: '2026-09-30',
    committedAt: '2026-10-01T00:00:00Z', openingBalance: open, closingBalance: null, unreconciled: false,
  });
  const ai = STATEMENTS.map((st) => (st.batchId === id(43) ? { ...st, assurance: statementRecordAssurance('pdf_claude', false) } : st));
  const run = (open: string | null) => {
    const history = buildCashHistory({
      bankAccounts: BANKS, statements: [...ai, sep(open)], movements: [...MOVEMENTS, SEP_ROW], periods: PERIODS,
    });
    return [JUL, AUG, SEP].map((p) => [p.label, history.get(p.id)]);
  };
  // The chain reaches 12,700 at 31 August (May's printed 10,000 plus every row since).
  return { carried: run(null), attested: run('12700') };
}

/**
 * Step 0E (ADR-138). H-2: a trial balance / P&L report states the P&L from `closing_balance` — movement
 * as is, cumulative by §3's difference (no prior → NULL), the winning kind only. H-1: coverage's bank
 * evidence is NULL with no cash-like account in scope.
 */
function step0eCorpus(ctx: EngineContext): unknown {
  const bal = (p: PeriodRef, kind: 'trial_balance' | 'pnl_report', basis: 'movement' | 'cumulative', accountId: string, category: AggregateCell['standardCategory'], closing: string) =>
    cell({ periodId: p.id, source: 'period_balances', balanceKind: kind, balanceBasis: basis, accountId, standardCategory: category, amount: closing });
  const tb = (prefix: string, kind: 'trial_balance' | 'pnl_report', basis: 'movement' | 'cumulative', periods: PeriodRef[]) =>
    periods.map((p, i) => batch(70 + i + (prefix === 'c' ? 10 : prefix === 'r' ? 20 : 0), {
      targetTable: 'period_balances', invoiceListKind: null, importType: kind, balanceKind: kind, balanceBasis: basis,
      periodStart: p.periodStart, periodEnd: p.periodEnd,
    }));
  const cases: Record<string, { cells: AggregateCell[]; batches: CoverageBatch[] }> = {
    movement: {
      cells: [JUN, JUL].flatMap((p, i) => [bal(p, 'trial_balance', 'movement', REV!, 'revenue', i ? '-1100' : '-1000'),
        bal(p, 'trial_balance', 'movement', COS!, 'cost_of_sales', i ? '440' : '400'), bal(p, 'trial_balance', 'movement', OPEX!, 'operating_expense', '300')]),
      batches: tb('m', 'trial_balance', 'movement', [JUN, JUL]),
    },
    cumulative: {
      cells: [JUN, JUL].flatMap((p, i) => [bal(p, 'trial_balance', 'cumulative', REV!, 'revenue', i ? '-2100' : '-1000'),
        bal(p, 'trial_balance', 'cumulative', COS!, 'cost_of_sales', i ? '840' : '400')]),
      batches: tb('c', 'trial_balance', 'cumulative', [JUN, JUL]),
    },
    kinds: {
      cells: [bal(JUL, 'trial_balance', 'movement', REV!, 'revenue', '-1100'), bal(JUL, 'pnl_report', 'movement', REV!, 'revenue', '-9999')],
      batches: [...tb('m', 'trial_balance', 'movement', [JUL]), ...tb('r', 'pnl_report', 'movement', [JUL])],
    },
  };
  const periods = [MAY, JUN, JUL];
  const out: Record<string, unknown> = {};
  for (const [name, c] of Object.entries(cases)) {
    out[name] = [JUN, JUL].map((period) => {
      const coverage = computeCoverage({ period, batches: c.batches, bankAccounts: [], rowCounts: { period_balances: 1 }, asOf: ctx.asOf,
        balanceRowsByKind: balanceRowsByKind(c.cells, period.id) });
      const prior = periods[periods.findIndex((p) => p.id === period.id) - 1];
      const balancePnl = balancePnlContext({ period, prior, coverage, batches: c.batches, cells: c.cells, organisationFiscalYearStartMonth: 1 });
      return composePeriod({ period, coverage, cells: c.cells, transferLegs: [], context: { ...ctx, bankAccounts: [] }, balancePnl })
        .filter((r) => r.dimensionType === 'none')
        .map((r) => [r.key, r.value, r.basis, r.assurance, r.dataQuality.missing, r.evidenceQuery === null ? null : 'q']);
    });
  }
  out.bankEvidence = computeCoverage({ period: JUL, batches: [], bankAccounts: [], rowCounts: {}, asOf: ctx.asOf }).bankEvidenceRatio;
  return out;
}

/**
 * ADR-122 FU-1: when an invoice list may state a month's revenue. Each case is the invoice basis on
 * its own (no ledger, no balances, no bank), so the invoices source's coverage alone decides the
 * P&L — a regression that lets a list cover a month it does not establish turns a NULL here into a
 * 0.00 and changes the hash.
 */
const OCT = month('2026-10', 10);
const MAR = month('2026-03', 13);
const FU1_CELLS: AggregateCell[] = [
  cell({ periodId: JUL.id, source: 'invoices', invoiceType: 'sales', counterpartyId: CUSTOMER, amount: '4000.00', debit: '800.00' }),
  cell({ periodId: JUL.id, source: 'invoices', invoiceType: 'purchase', counterpartyId: SUPPLIER, amount: '900.00', debit: '180.00' }),
  cell({ periodId: MAR.id, source: 'invoices', invoiceType: 'sales', counterpartyId: CUSTOMER, amount: '3000.00' }),
  cell({ periodId: SEP.id, source: 'invoices', invoiceType: 'sales', counterpartyId: CUSTOMER, amount: '500.00', debit: '100.00' }),
];
const FU1_CASES: Array<[string, PeriodRef, Partial<CoverageBatch> | Array<Partial<CoverageBatch>>]> = [
  // A full sales list spanning the month: its sales (July) and a genuine, stated zero (August).
  ['spanned', JUL, {}],
  ['genuine zero', AUG, {}],
  // Months the list's range does not span: before it, after it (committed before the month ends).
  ['before the range', MAY, {}],
  ['after the range', OCT, {}],
  // Committed during a completed month, its range stopping short of the month's end.
  ['stops short', JUL, { periodEnd: '2026-07-20', committedAt: '2026-07-20T12:00:00Z' }],
  // Committed BEFORE the month (the negative-gap bug, BSREV).
  ['committed before', MAY, { periodStart: '2026-03-01', periodEnd: '2026-03-31', committedAt: '2026-04-05T09:00:00Z' }],
  // Lists that establish no revenue whatever their range.
  ['purchase only', JUL, { importType: 'purchase_invoices' }],
  ['open items', JUL, { invoiceListKind: 'open_items' }],
  // The current month (as of 15 September): to date from a list reaching the 10th; not from one
  // ending before it; whole from one spanning it.
  ['current to date', SEP, { periodEnd: '2026-09-10' }],
  ['current unreached', SEP, {}],
  ['current spanned', SEP, { periodEnd: '2026-09-30' }],
  // A list knows nothing after the day it was committed: committed mid-July with a range to August.
  ['committed mid-month', JUL, { committedAt: '2026-07-20T12:00:00Z' }],
  // Lists that meet combine, as statements do; a day missing between them does not.
  ['contiguous halves', JUL, [{ periodStart: '2026-07-01', periodEnd: '2026-07-15' }, { periodStart: '2026-07-16', periodEnd: '2026-07-31' }]],
  ['halves with a gap', JUL, [{ periodStart: '2026-07-01', periodEnd: '2026-07-14' }, { periodStart: '2026-07-16', periodEnd: '2026-07-31' }]],
];

function fu1Corpus(ctx: EngineContext): unknown {
  return Object.fromEntries(FU1_CASES.map(([name, period, over]) => {
    const batches = (Array.isArray(over) ? over : [over]).map((o, i) => batch(80 + i, o));
    const coverage = computeCoverage({ period, batches, bankAccounts: [], rowCounts: {}, asOf: ctx.asOf });
    const results = composePeriod({
      period, coverage, cells: FU1_CELLS, transferLegs: [], context: { ...ctx, bankAccounts: [] },
      receivables: { invoices: [], batches, asOfIsPeriodEnd: period.id !== SEP.id, priorDenominators: [], ledger: null },
    }).map((r, i) => ({ ...r, id: `fu1-${name}-${i}` }));
    return [name, {
      invoices: coverage.bySource.invoices,
      latest: coverage.latestDataDate.invoices ?? null,
      complete: isPeriodComplete(coverage, period, []),
      results,
    }];
  }));
}

/**
 * ADR-122 FU-12: when an invoice list may state a month's COSTS. The invoice basis on its own again: a
 * full sales list hands it the P&L, and only full PURCHASE lists establish the cost side. A regression
 * that lets a sales list (or a purchase list that does not establish the month) state costs turns a
 * NULL cost of sales, profit or supplier concentration here into a 0.00 or a sum, and changes the hash.
 */
const FU12_CELLS: AggregateCell[] = [
  ...FU1_CELLS,
  cell({ periodId: SEP.id, source: 'invoices', invoiceType: 'purchase', counterpartyId: SUPPLIER, amount: '120.00', debit: '24.00' }),
];
const PURCHASE_LIST: Partial<CoverageBatch> = { importType: 'purchase_invoices' };
const FU12_CASES: Array<[string, PeriodRef, Array<Partial<CoverageBatch>>]> = [
  // A sales list alone: revenue stated, every cost and profit figure NULL (was 0.00 / profit = revenue).
  ['sales only', JUL, [{}]],
  // Sales and purchase lists spanning the month: costs and profit stated.
  ['sales and purchases', JUL, [{}, PURCHASE_LIST]],
  // Purchase lists that do not establish July: stopping short, committed mid-month, committed before.
  ['purchases stop short', JUL, [{}, { ...PURCHASE_LIST, periodEnd: '2026-07-20', committedAt: '2026-07-20T12:00:00Z' }]],
  ['purchases committed mid-month', JUL, [{}, { ...PURCHASE_LIST, committedAt: '2026-07-20T12:00:00Z' }]],
  ['purchases committed before', JUL, [{}, { ...PURCHASE_LIST, periodStart: '2026-03-01', periodEnd: '2026-03-31', committedAt: '2026-04-05T09:00:00Z' }]],
  // Purchase halves that meet combine.
  ['purchase halves', JUL, [{}, { ...PURCHASE_LIST, periodStart: '2026-07-01', periodEnd: '2026-07-15' }, { ...PURCHASE_LIST, periodStart: '2026-07-16', periodEnd: '2026-07-31' }]],
  // The current month: purchases to date (partial_month), and purchases not reaching it.
  // FU-12 review: costs to date only when the purchase lists reach exactly as far as the sales lists
  // (both to the 12th); purchases reaching further (12th against sales to the 10th) — or falling short
  // — are not the same days as the revenue, so costs are NULL.
  ['current purchases to date', SEP, [
    { periodEnd: '2026-09-12', committedAt: '2026-09-12T18:00:00Z' },
    { ...PURCHASE_LIST, periodEnd: '2026-09-12', committedAt: '2026-09-12T18:00:00Z' },
  ]],
  ['current purchases unequal reach', SEP, [{ periodEnd: '2026-09-10' }, { ...PURCHASE_LIST, periodEnd: '2026-09-12', committedAt: '2026-09-12T18:00:00Z' }]],
  ['current purchases unreached', SEP, [{ periodEnd: '2026-09-10' }, PURCHASE_LIST]],
  // A covering purchase list with no purchases in the month: a genuine, stated 0.00.
  ['genuine zero costs', AUG, [{}, PURCHASE_LIST]],
  // A purchase list alone still does not hand the invoices source the P&L (FU-1 mirror).
  ['purchases only', JUL, [PURCHASE_LIST]],
];

function fu12Corpus(ctx: EngineContext): unknown {
  return Object.fromEntries(FU12_CASES.map(([name, period, overs]) => {
    const batches = overs.map((o, i) => batch(84 + i, o));
    const coverage = computeCoverage({ period, batches, bankAccounts: [], rowCounts: {}, asOf: ctx.asOf });
    const results = composePeriod({
      period, coverage, cells: FU12_CELLS, transferLegs: [], context: { ...ctx, bankAccounts: [] },
      receivables: { invoices: [], batches, asOfIsPeriodEnd: period.id !== SEP.id, priorDenominators: [], ledger: null },
    }).map((r, i) => ({ ...r, id: `fu12-${name}-${i}` }));
    return [name, { invoices: coverage.bySource.invoices, costs: coverage.invoiceCosts ?? null, results }];
  }));
}

/**
 * FU-12 review: the variance pass across an invoice-basis month whose costs a purchase list states
 * (July, cost of sales 900) and one whose costs nothing establishes (August, sales list only). An
 * absent category in August is unknown, not a known zero: a regression to "−900.00, −100%" moves the hash.
 */
function fu12VarianceCorpus(ctx: EngineContext): unknown {
  const salesList = { periodStart: '2026-07-01', periodEnd: '2026-08-31' };
  const runFor = (period: PeriodRef, overs: Array<Partial<CoverageBatch>>, tag: string): MetricResult[] => {
    const batches = overs.map((o, i) => batch(94 + i, o));
    const coverage = computeCoverage({ period, batches, bankAccounts: [], rowCounts: {}, asOf: ctx.asOf });
    return composePeriod({
      period, coverage, cells: FU12_CELLS, transferLegs: [], context: { ...ctx, bankAccounts: [] },
      receivables: { invoices: [], batches, asOfIsPeriodEnd: true, priorDenominators: [], ledger: null },
    }).map((r, i) => ({ ...r, id: `fu12v-${tag}-${i}` }));
  };
  const july = runFor(JUL, [salesList, { ...PURCHASE_LIST, periodStart: '2026-07-01', periodEnd: '2026-07-31' }], 'jul');
  const august = runFor(AUG, [salesList, { ...PURCHASE_LIST, periodStart: '2026-07-01', periodEnd: '2026-07-31' }], 'aug');
  let minted = 0;
  const variances = variancesForPeriod({
    period: AUG, allPeriods: PERIODS, results: august, computed: new Map([[JUL.id, july]]), stored: [],
    currency: 'GBP', mint: () => `fu12v-${(minted += 1)}`,
  });
  return { july, august, variances };
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

  it('the Step 0D cases carry an AI read into a later month, and a verified printed balance ends it', () => {
    const out = corpus() as { step0d: Record<'carried' | 'attested', Array<[string, Array<{ bankAccountId: string; opening: { assurance: string } | null }>]>> };
    const septemberA = (variant: 'carried' | 'attested') =>
      out.step0d[variant].find(([label]) => label === '2026-09')![1].find((a) => a.bankAccountId === BANK_A)!.opening!.assurance;
    expect(septemberA('carried')).toBe('inferred');
    expect(septemberA('attested')).toBe('verified');
  });

  it('the Step 0E cases state balance-report P&L from closing balances, and no bank evidence as NULL', () => {
    const out = corpus() as { step0e: Record<string, Array<Array<[string, string | null, string, string, string[], string | null]>>> & { bankEvidence: unknown } };
    const revenue = (name: string, i: number) => out.step0e[name]![i]!.find((r) => r[0] === 'revenue')!;
    expect(revenue('movement', 0)[1]).toBe('1000.00');
    expect(revenue('movement', 1)[1]).toBe('1100.00');
    expect(revenue('cumulative', 0)[1]).toBeNull();
    expect(revenue('cumulative', 0)[4]).toContain('no_prior_trial_balance');
    expect(revenue('cumulative', 1)[1]).toBe('1100.00');
    expect(revenue('kinds', 1)[1]).toBe('1100.00');
    expect(out.step0e.bankEvidence).toBeNull();
  });

  it('the FU-1 cases state revenue exactly where a full sales list establishes it', () => {
    // The corpus must exercise both sides of the rule, or a regression could not move the hash.
    const out = corpus() as { fu1: Record<string, { results: MetricResult[] }> };
    const revenue = (name: string): string | null =>
      out.fu1[name]!.results.find((r) => r.key === 'revenue' && r.dimensionType === 'none')?.value ?? null;
    expect(revenue('spanned')).toBe('4000.00');
    expect(revenue('genuine zero')).toBe('0.00');
    expect(revenue('current to date')).toBe('500.00');
    expect(revenue('current spanned')).toBe('500.00');
    expect(revenue('contiguous halves')).toBe('4000.00');
    for (const name of ['before the range', 'after the range', 'stops short', 'committed before', 'purchase only', 'open items', 'current unreached',
      'committed mid-month', 'halves with a gap']) {
      expect(revenue(name), name).toBeNull();
    }
  });

  it('the FU-12 cases state costs exactly where a full purchase list establishes them', () => {
    // Both sides of the rule again, or a regression could not move the hash.
    const out = corpus() as { fu12: Record<string, { results: MetricResult[] }> };
    const figure = (name: string, key: string): string | null =>
      out.fu12[name]!.results.find((r) => r.key === key && r.dimensionType === 'none')?.value ?? null;
    expect(figure('sales and purchases', 'cost_of_sales')).toBe('900.00');
    expect(figure('sales and purchases', 'net_profit')).toBe('3100.00');
    expect(figure('purchase halves', 'cost_of_sales')).toBe('900.00');
    // FU-12 review: equal reach (both lists to the 12th) states costs to date.
    expect(figure('current purchases to date', 'revenue')).toBe('500.00');
    expect(figure('current purchases to date', 'cost_of_sales')).toBe('120.00');
    expect(figure('current purchases to date', 'net_profit')).toBe('380.00');
    expect(figure('genuine zero costs', 'cost_of_sales')).toBe('0.00');
    expect(figure('genuine zero costs', 'net_profit')).toBe('0.00');
    for (const name of ['sales only', 'purchases stop short', 'purchases committed mid-month', 'purchases committed before',
      'current purchases unequal reach', 'current purchases unreached', 'purchases only']) {
      expect(figure(name, 'cost_of_sales'), name).toBeNull();
      expect(figure(name, 'net_profit'), name).toBeNull();
      expect(figure(name, 'supplier_concentration_top1'), name).toBeNull();
    }
    expect(figure('sales only', 'revenue')).toBe('4000.00');
    // FU-12 review: unequal reach states revenue to date but never revenue minus a different window's costs.
    expect(figure('current purchases unequal reach', 'revenue')).toBe('500.00');
  });

  it('the FU-12 variance case: a category absent from a month whose costs nothing establishes is unknown', () => {
    const out = corpus() as { fu12Variance: { july: MetricResult[]; august: MetricResult[]; variances: MetricResult[] } };
    const { july, august, variances } = out.fu12Variance;
    const headline = (rs: MetricResult[], key: string) => rs.find((r) => r.key === key && r.dimensionType === 'none');
    expect(headline(july, 'cost_of_sales')?.value).toBe('900.00');
    expect(headline(august, 'cost_of_sales')?.value).toBeNull();
    expect(headline(august, 'revenue')?.value).toBe('0.00');
    const row = variances.find((r) => r.key === 'expense_by_category.variance.prev_period'
      && (r.dimensionKey ?? r.dimensionId) === 'cost_of_sales');
    expect(row, 'August cost_of_sales prev_period').toBeDefined();
    expect(row!.value).toBeNull();
    expect(row!.dataQuality.missing).toContain('no_source_covers_period');
    expect(row!.components.comparison).toBe('900.00');
  });
});
