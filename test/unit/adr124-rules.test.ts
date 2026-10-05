import { describe, expect, it } from 'vitest';

import { EVALUATORS, evaluatePayablesDeterioration, evaluateReceivablesDeterioration, planEvaluation, renderAlert, type OpenInvoiceObservation } from '@/modules/alerts';
import { compileDescriptor, parseQueryDescriptor } from '@/modules/evidence';
import {
  composePeriod, computeCoverage, ENGINE_VERSION, invoiceSideCoverage,
  type AccountRef, type AggregateCell, type AgingInvoice, type CoverageBatch, type EngineContext, type MetricResult, type PeriodRef,
} from '@/modules/financial-engine';
import { emptyRuleContext, snapshot } from '../fixtures/health';

/**
 * ADR-124 D-3, D-4 and D-5 at unit level; their queue-level reproductions on the second audit's own
 * organisations (BSLIST, LEDGER3, CNFUTURE) are `test/integration/adr124-remediation.test.ts`.
 */

const month = (id: string, start: string, end: string): PeriodRef =>
  ({ id, periodStart: start, periodEnd: end, fiscalYear: 2026, fiscalQuarter: 3, label: id, isComplete: true });
const jun = month('p-jun', '2026-06-01', '2026-06-30');
const jul = month('p-jul', '2026-07-01', '2026-07-31');
const aug = month('p-aug', '2026-08-01', '2026-08-31');
const sep = { ...month('p-sep', '2026-09-01', '2026-09-30'), isComplete: false };

let n = 0;
const batch = (over: Partial<CoverageBatch>): CoverageBatch => ({
  id: `b-${(n += 1)}`, targetTable: 'invoices', balanceKind: null, balanceBasis: null, bankAccountId: null,
  invoiceListKind: 'full', importType: 'sales_invoices', periodStart: '2026-06-01', periodEnd: '2026-08-31',
  // R-2: these lists stand for complete exports — confirmed to hold every invoice open at their start.
  openingConfirmed: true,
  committedAt: '2026-09-10T10:00:00Z', ...over,
});
const covers = (b: CoverageBatch, p: PeriodRef, current = false): boolean => invoiceSideCoverage([b], p, 'sales', current).covers;

// ---------------------------------------------------------------------------------------------
// D-3 — a completed month needs its END position
// ---------------------------------------------------------------------------------------------

describe('D-3 · invoice-list freshness depends on whether the month is finished', () => {
  it('a finished month: a full list reaching its end, committed within 45 days after it, covers it', () => {
    expect(covers(batch({ periodStart: '2026-07-01', periodEnd: '2026-09-05', committedAt: '2026-09-06T00:00:00Z' }), aug)).toBe(true);
  });

  it('a finished month: an open-items list dated exactly at its end covers it', () => {
    const asAt = batch({ invoiceListKind: 'open_items', periodStart: '2026-08-31', periodEnd: '2026-08-31', committedAt: '2026-09-03T00:00:00Z' });
    expect(covers(asAt, aug)).toBe(true);
  });

  it('45 days after the month end is inside the window; 46 is not', () => {
    const at = (committedAt: string) => batch({ periodStart: '2026-08-15', periodEnd: '2026-09-10', committedAt });
    expect(covers(at('2026-10-15T09:00:00Z'), aug)).toBe(true);
    expect(covers(at('2026-10-16T09:00:00Z'), aug)).toBe(false);
  });

  it('N-4 · a list uploaded partway through a finished month states nothing about its end (BSLIST)', () => {
    // Declared 1 June – 3 August, committed 3 August: it knew nothing after the 3rd.
    const midMonth = batch({ periodStart: '2026-06-01', periodEnd: '2026-08-03', committedAt: '2026-08-03T12:00:00Z' });
    expect(covers(midMonth, aug)).toBe(false);
    // The months it spans in full it still covers (a full list reconstructs any day inside its range).
    expect(covers(midMonth, jul)).toBe(true);
  });

  it('a list whose range does not reach the month states nothing about it (F-4 stays fixed)', () => {
    expect(covers(batch({ periodStart: '2026-09-01', periodEnd: '2026-09-05', committedAt: '2026-09-06T00:00:00Z' }), aug)).toBe(false);
    expect(covers(batch({ periodStart: '2026-06-01', periodEnd: '2026-06-30', committedAt: '2026-08-02T00:00:00Z' }), jul)).toBe(false);
  });

  it('N-10 · an aged-debtors list as at a LATER date cannot state a finished month: payments in between are not on it', () => {
    const asAtFifth = batch({ invoiceListKind: 'open_items', periodStart: '2026-09-01', periodEnd: '2026-09-05', committedAt: '2026-09-06T00:00:00Z' });
    expect(covers(asAtFifth, aug)).toBe(false);
    // Even one whose declared range spans August: its as-at date is its range end, 5 September.
    const spanning = batch({ invoiceListKind: 'open_items', periodStart: '2026-01-01', periodEnd: '2026-09-05', committedAt: '2026-09-06T00:00:00Z' });
    expect(covers(spanning, aug)).toBe(false);
  });

  it('the current month keeps its rule: committed on or after its start, range overlapping it', () => {
    const tenth = batch({ periodStart: '2026-06-01', periodEnd: '2026-09-10', committedAt: '2026-09-10T10:00:00Z' });
    expect(covers(tenth, sep, true)).toBe(true);
    expect(covers(batch({ periodStart: '2026-06-01', periodEnd: '2026-08-31', committedAt: '2026-09-10T10:00:00Z' }), sep, true)).toBe(false);
    // An aged-debtors list uploaded during the current month ages it as at the run's date.
    expect(covers(batch({ invoiceListKind: 'open_items', periodStart: '2026-09-10', periodEnd: '2026-09-10' }), sep, true)).toBe(true);
    expect(covers(batch({ committedAt: '2026-08-20T00:00:00Z', periodStart: '2026-06-01', periodEnd: '2026-09-10' }), sep, true)).toBe(false);
  });

  it('precedence: a finished month the list cannot state falls through to its balance sheet', () => {
    const accounts: AccountRef[] = [{ id: 'a-ar', code: null, name: 'AR', standardCategory: 'receivables', accountType: 'asset', isSystem: true }];
    const ctx: EngineContext = {
      organizationId: 'org', calculationRunId: 'run', aggregatedAt: '2026-09-15T00:00:00Z', asOf: '2026-09-15', engineVersion: ENGINE_VERSION,
      settings: { baseCurrency: 'GBP', fiscalYearStartMonth: 1, timezone: 'Europe/London', vatRegistered: false, defaultVatRate: null, taxableCategories: [] },
      costOfSalesEverUsed: true, costOfSalesInInvoices: false, accounts, counterparties: [], bankAccounts: [], periods: [jun, jul, aug],
    };
    const bs = batch({ targetTable: 'period_balances', importType: 'balance_sheet', invoiceListKind: null, balanceKind: 'balance_sheet', balanceBasis: 'cumulative', periodStart: '2026-08-01', periodEnd: '2026-08-31' });
    const list = batch({ periodStart: '2026-06-01', periodEnd: '2026-08-03', committedAt: '2026-08-03T12:00:00Z' });
    const cell: AggregateCell = {
      periodId: aug.id, source: 'period_balances', standardCategory: 'receivables', accountId: 'a-ar', counterpartyId: null, bankAccountId: null,
      balanceKind: 'balance_sheet', balanceBasis: 'cumulative', invoiceType: null, transferKind: null, unpairedTransferCandidate: false,
      debit: '3000', credit: '0', amount: '3000', rowCount: 1, fallbackRows: 0, minDate: null, maxDate: null,
    };
    const invoices: AgingInvoice[] = [{ id: 'x-1', invoiceType: 'sales', counterpartyId: null, issueDate: '2026-07-10', dueDate: '2026-08-09',
      totalAmount: '5000.00', amountPaid: '0.00', balanceDue: '5000.00', paidDate: null, status: 'open' }];
    const coverage = computeCoverage({ period: aug, batches: [bs, list], bankAccounts: [], rowCounts: { period_balances: 1 }, asOf: ctx.asOf });
    const results = composePeriod({ period: aug, coverage, cells: [cell], transferLegs: [], context: ctx,
      receivables: { invoices, batches: [bs, list], asOfIsPeriodEnd: true, priorDenominators: [], ledger: null } });
    const ar = results.find((r) => r.key === 'receivables' && r.dimensionType === 'none')!;
    expect([ar.value, ar.basis]).toEqual(['3000.00', 'period_balances']);
  });
});

// ---------------------------------------------------------------------------------------------
// R-2 (owner decision) — a full list states what is owed only once its opening is confirmed
// ---------------------------------------------------------------------------------------------

describe('R-2 · a full invoice list must be confirmed to hold the invoices open at its start', () => {
  const unconfirmed = (over: Partial<CoverageBatch> = {}) => batch({ openingConfirmed: null, ...over });

  it('an unconfirmed full list spanning the month does not cover it, and says why', () => {
    const side = invoiceSideCoverage([unconfirmed({ periodStart: '2026-07-01', periodEnd: '2026-09-05', committedAt: '2026-09-06T00:00:00Z' })], aug, 'sales');
    expect(side.covers).toBe(false);
    expect(side.openingUnconfirmed).toBe(true);
  });

  it('answered partial (only invoices issued in the range) is not confirmed either', () => {
    expect(covers(batch({ openingConfirmed: false, periodStart: '2026-07-01', periodEnd: '2026-09-05', committedAt: '2026-09-06T00:00:00Z' }), aug)).toBe(false);
  });

  it('confirmed: it covers, as before', () => {
    expect(covers(batch({ periodStart: '2026-07-01', periodEnd: '2026-09-05', committedAt: '2026-09-06T00:00:00Z' }), aug)).toBe(true);
  });

  it('an open-items list needs no confirmation: it is every unpaid invoice by kind', () => {
    expect(covers(unconfirmed({ invoiceListKind: 'open_items', periodStart: '2026-08-31', periodEnd: '2026-08-31', committedAt: '2026-09-03T00:00:00Z' }), aug)).toBe(true);
  });

  it('BSLIST: an unconfirmed list beside a balance sheet — the balance sheet\'s 3,000, never the list\'s 0.00', () => {
    const accounts: AccountRef[] = [{ id: 'a-ar', code: null, name: 'AR', standardCategory: 'receivables', accountType: 'asset', isSystem: true }];
    const ctx: EngineContext = {
      organizationId: 'org', calculationRunId: 'run', aggregatedAt: '2026-09-15T00:00:00Z', asOf: '2026-09-15', engineVersion: ENGINE_VERSION,
      settings: { baseCurrency: 'GBP', fiscalYearStartMonth: 1, timezone: 'Europe/London', vatRegistered: false, defaultVatRate: null, taxableCategories: [] },
      costOfSalesEverUsed: true, costOfSalesInInvoices: false, accounts, counterparties: [], bankAccounts: [], periods: [jun, jul, aug],
    };
    const bs = batch({ targetTable: 'period_balances', importType: 'balance_sheet', invoiceListKind: null, balanceKind: 'balance_sheet', balanceBasis: 'cumulative', periodStart: '2026-06-01', periodEnd: '2026-06-30' });
    // June: the list (declared 1 Jun–3 Aug) holds a single July invoice; the balance sheet says 3,000 owed.
    const list = unconfirmed({ periodStart: '2026-06-01', periodEnd: '2026-08-03', committedAt: '2026-08-03T12:00:00Z' });
    const cell: AggregateCell = {
      periodId: jun.id, source: 'period_balances', standardCategory: 'receivables', accountId: 'a-ar', counterpartyId: null, bankAccountId: null,
      balanceKind: 'balance_sheet', balanceBasis: 'cumulative', invoiceType: null, transferKind: null, unpairedTransferCandidate: false,
      debit: '3000', credit: '0', amount: '3000', rowCount: 1, fallbackRows: 0, minDate: null, maxDate: null,
    };
    const invoices: AgingInvoice[] = [{ id: 'x-1', invoiceType: 'sales', counterpartyId: null, issueDate: '2026-07-10', dueDate: '2026-08-09',
      totalAmount: '5000.00', amountPaid: '0.00', balanceDue: '5000.00', paidDate: null, status: 'open' }];
    const run = (batches: CoverageBatch[], cells: AggregateCell[]) => {
      const coverage = computeCoverage({ period: jun, batches, bankAccounts: [], rowCounts: { period_balances: cells.length }, asOf: ctx.asOf });
      const results = composePeriod({ period: jun, coverage, cells, transferLegs: [], context: ctx,
        receivables: { invoices, batches, asOfIsPeriodEnd: true, priorDenominators: [], ledger: null } });
      return results.find((r) => r.key === 'receivables' && r.dimensionType === 'none')!;
    };
    const withSheet = run([bs, list], [cell]);
    expect([withSheet.value, withSheet.basis]).toEqual(['3000.00', 'period_balances']);
    // No balance sheet: NULL with the reason, never the list's 0.00.
    const alone = run([list], []);
    expect(alone.value).toBeNull();
    expect(alone.dataQuality.missing).toContain('opening_invoices_unconfirmed');
  });
});

// ---------------------------------------------------------------------------------------------
// D-4 — an opening journal starts on its own date
// ---------------------------------------------------------------------------------------------

describe('D-4 · an opening journal takes effect from its date', () => {
  const accounts: AccountRef[] = [
    { id: 'a-ar', code: null, name: 'AR', standardCategory: 'receivables', accountType: 'asset', isSystem: true },
    { id: 'a-eq', code: null, name: 'Equity', standardCategory: 'equity', accountType: 'equity', isSystem: true },
  ];
  const ctx: EngineContext = {
    organizationId: 'org', calculationRunId: 'run', aggregatedAt: '2026-09-15T00:00:00Z', asOf: '2026-09-15', engineVersion: ENGINE_VERSION,
    settings: { baseCurrency: 'GBP', fiscalYearStartMonth: 1, timezone: 'Europe/London', vatRegistered: false, defaultVatRate: null, taxableCategories: [] },
    costOfSalesEverUsed: true, costOfSalesInInvoices: false, accounts, counterparties: [], bankAccounts: [], periods: [jun, jul, aug],
  };
  const periodStarts = new Map([jun, jul, aug].map((p) => [p.id, p.periodStart]));
  const gl = batch({ targetTable: 'ledger_entries', importType: 'general_ledger', invoiceListKind: null, periodStart: '2026-06-01', periodEnd: '2026-08-31' });
  const ar = (p: PeriodRef, debit: string, credit = '0'): AggregateCell => ({
    periodId: p.id, source: 'ledger', standardCategory: 'receivables', accountId: 'a-ar', counterpartyId: null, bankAccountId: null,
    balanceKind: null, balanceBasis: null, invoiceType: null, transferKind: null, unpairedTransferCandidate: false,
    debit, credit, amount: String(Number(debit) - Number(credit)), rowCount: 1, fallbackRows: 0, minDate: null, maxDate: null,
  });
  const journalLine = (p: PeriodRef, entryDate: string, amount: string) => ({ accountId: 'a-ar', periodId: p.id, entryDate, debit: amount, credit: '0' });

  /** LEDGER3: June journal 5,000 (+1,000 June); July +1,000 on the 5th, then a journal dated 15 July of 7,000; August −2,000. */
  const cells = [ar(jun, '5000'), ar(jun, '1000'), ar(jul, '1000'), ar(jul, '7000'), ar(aug, '0', '2000')];
  const journal = [journalLine(jun, '2026-06-01', '5000'), journalLine(jul, '2026-07-15', '7000')];
  const preJournal = [{ journalDate: '2026-07-15', accountId: 'a-ar', debit: '1000', credit: '0' }];

  const receivablesAt = (p: PeriodRef, withPreJournal = true): MetricResult => {
    const coverage = computeCoverage({ period: p, batches: [gl], bankAccounts: [], rowCounts: { ledger: 1 }, asOf: ctx.asOf });
    return composePeriod({
      period: p, coverage, cells, transferLegs: [], context: ctx,
      receivables: { invoices: [], batches: [gl], asOfIsPeriodEnd: true, priorDenominators: [],
        ledger: { cells, openingJournal: journal, periodStarts, ...(withPreJournal ? { preJournal } : {}) } },
    }).find((r) => r.key === 'receivables' && r.dimensionType === 'none')!;
  };

  it('a journal at a month start: journal + movements since (June 6,000)', () => {
    expect(receivablesAt(jun).value).toBe('6000.00');
    expect(receivablesAt(jun).evidenceQuery).toMatchObject({ kind: 'leaf' });
    // A month-start journal needs no date filter: whole months are exactly what it contains.
    const filters = (receivablesAt(jun).evidenceQuery as { descriptor: { filters: Record<string, unknown> } }).descriptor.filters;
    expect(filters).not.toHaveProperty('entry_date_from');
  });

  it('a journal mid-month: the month\'s rows before it are inside it — July 7,000, August 5,000 (LEDGER3, N-5)', () => {
    expect(receivablesAt(jul).value).toBe('7000.00');
    expect(receivablesAt(aug).value).toBe('5000.00');
    expect(receivablesAt(aug).components).toMatchObject({ opening_balance: '7000.00', movements: '-2000.00' });
  });

  it('without the rows before the journal the month would be counted twice: 6,000 — which is why the run loads them', () => {
    expect(receivablesAt(aug, false).value).toBe('6000.00');
  });

  it('the drill-down starts on the journal\'s day, so it selects exactly the rows the figure summed', () => {
    const evidence = receivablesAt(aug).evidenceQuery as { kind: 'leaf'; descriptor: { filters: Record<string, unknown> } };
    expect(evidence.descriptor.filters).toMatchObject({ period_ids: [aug.id, jul.id].sort(), entry_date_from: '2026-07-15' });
    // The filter is part of the v1 schema and compiles to a day bound on the ledger rows.
    const uuid = (k: number) => `00000000-0000-4000-8000-${String(k).padStart(12, '0')}`;
    const descriptor = parseQueryDescriptor({
      ...evidence.descriptor,
      filters: { ...evidence.descriptor.filters, period_ids: [uuid(1), uuid(2)], account_ids: [uuid(3)] },
      as_of: { calculation_run_id: uuid(4), aggregated_at: '2026-09-15T00:00:00Z' },
    });
    const compiled = compileDescriptor(descriptor);
    expect(compiled.filters).toContainEqual({ column: 'entry_date', op: 'gte', value: '2026-07-15' });
  });

  it('with two journals the LATEST effective by the month\'s end is the start (F-3 stays fixed)', () => {
    // June's balance is from the June journal; the July journal is not yet effective.
    expect(receivablesAt(jun).components).toMatchObject({ opening_balance: '5000.00' });
    expect(receivablesAt(jul).components).toMatchObject({ opening_balance: '7000.00' });
  });
});

// ---------------------------------------------------------------------------------------------
// D-5 — the overdue share is a share
// ---------------------------------------------------------------------------------------------

describe('D-5 · the deterioration alert\'s share is overdue invoices ÷ open invoices', () => {
  const open = (over: Partial<OpenInvoiceObservation> & { id: string }): OpenInvoiceObservation => ({
    invoiceType: 'sales', issueDate: '2026-07-01', dueDate: '2026-08-01', totalAmount: '1000.00',
    balanceDue: '1000.00', paidDate: null, description: over.id, ...over,
  });
  const evaluate = (total: string, overdue: string, invoices: OpenInvoiceObservation[], side: 'receivables' | 'payables' = 'receivables') =>
    (side === 'receivables' ? evaluateReceivablesDeterioration : evaluatePayablesDeterioration)(emptyRuleContext({
      snapshots: [
        snapshot({ key: side, value: total, unit: 'money' }),
        { ...snapshot({ key: `${side}_overdue`, value: overdue, unit: 'money' }), components: { as_of: '2026-08-31' } },
      ],
      records: [],
      openInvoices: invoices,
    }));

  it('0% overdue: nothing fires', () => {
    expect(evaluate('1000', '0', [open({ id: 'a', dueDate: '2026-09-30' })])).toEqual([]);
  });

  it('partly overdue: 400 of 1,000 is 40%, medium', () => {
    const [outcome] = evaluate('1000', '400', [open({ id: 'a', totalAmount: '400.00', balanceDue: '400.00' }), open({ id: 'b', totalAmount: '600.00', balanceDue: '600.00', dueDate: '2026-09-30' })]);
    expect(outcome!.thresholdSummary).toMatchObject({ share: '0.400000', overdue_invoices: '400.00', open_invoices: '1000.00', open_credits: '0.00' });
    expect(outcome!.severity).toBe('medium');
  });

  it('fully overdue: 100%, high', () => {
    const [outcome] = evaluate('1000', '1000', [open({ id: 'a' })]);
    expect(outcome!.thresholdSummary.share).toBe('1.000000');
    expect(outcome!.severity).toBe('high');
  });

  it('N-7 · a credit note not yet due: 100% of the open invoices, the credit stated beside it — never 500% (CNFUTURE)', () => {
    const invoices = [open({ id: 'O-1' }), open({ id: 'CN-9', invoiceType: 'sales_credit_note', totalAmount: '800.00', balanceDue: '800.00', issueDate: '2026-08-20', dueDate: '2026-09-30' })];
    const [outcome] = evaluate('200', '1000', invoices);
    const summary = outcome!.thresholdSummary;
    expect(summary).toMatchObject({ share: '1.000000', overdue_invoices: '1000.00', open_invoices: '1000.00', open_credits: '800.00', total: '200.00', overdue: '1000.00' });
    // The figures themselves are untouched: the net figures stay what the engine computed.
    const text = renderAlert(outcome!, 'GBP').whatHappened;
    expect(text).toBe('£1,000 of the £1,000 owed to you on open invoices is overdue (100.0%). Open credit notes of £800 bring what you are owed to £200.');
    expect(text).not.toMatch(/500/);
  });

  it('a net customer credit (receivables below zero) raises nothing', () => {
    expect(evaluate('-700', '300', [open({ id: 'a', totalAmount: '300.00', balanceDue: '300.00' }), open({ id: 'cn', invoiceType: 'sales_credit_note', totalAmount: '1000.00', balanceDue: '1000.00' })])).toEqual([]);
  });

  it('zero open invoices: there is no share to state, so the share trigger cannot fire', () => {
    // A balance-sheet receivable with no invoice list behind it.
    expect(evaluate('5000', '0', [])).toEqual([]);
    const [slowing] = evaluateReceivablesDeterioration(emptyRuleContext({
      snapshots: [
        snapshot({ key: 'receivables', value: '5000', unit: 'money' }),
        snapshot({ key: 'receivables_days.variance.prev_period', value: '12', unit: 'days' }),
      ],
      records: [], openInvoices: [],
    }));
    expect(slowing!.thresholdSummary).toMatchObject({ trigger: 'days_increase', share: null, open_invoices: '0.00' });
  });

  it('never states a share above 100%, whatever the population', () => {
    for (const credit of ['0.00', '100.00', '999.00', '5000.00']) {
      const outcomes = evaluate('100', '1000', [open({ id: 'a' }), open({ id: 'cn', invoiceType: 'sales_credit_note', totalAmount: credit, balanceDue: credit, dueDate: '2026-12-31' })]);
      for (const o of outcomes) expect(Number(o.thresholdSummary.share)).toBeLessThanOrEqual(1);
    }
  });

  it('without the invoice population, a net share above 100% is withheld rather than stated', () => {
    const outcomes = evaluateReceivablesDeterioration(emptyRuleContext({
      snapshots: [snapshot({ key: 'receivables', value: '200', unit: 'money' }), snapshot({ key: 'receivables_overdue', value: '1000', unit: 'money' })],
      records: [],
    }));
    expect(outcomes).toEqual([]);
  });

  it('the payables sentence names the past-due invoices', () => {
    const [outcome] = evaluate('2600', '2600', [open({ id: 'p', invoiceType: 'purchase', totalAmount: '2600.00', balanceDue: '2600.00' })], 'payables');
    expect(renderAlert(outcome!, 'GBP').whatHappened).toBe('You owe £2,600 that is past due.');
  });

  it('an alert stored before ADR-124, without the invoice figures, keeps its original sentence', () => {
    const [outcome] = evaluate('1000', '400', [open({ id: 'a', totalAmount: '400.00', balanceDue: '400.00' }), open({ id: 'b', totalAmount: '600.00', balanceDue: '600.00', dueDate: '2026-09-30' })]);
    const legacy = { ...outcome!, thresholdSummary: { ...outcome!.thresholdSummary, open_invoices: null, overdue_invoices: null, open_credits: null } };
    expect(renderAlert(legacy, 'GBP').whatHappened).toBe('£400 of the £1,000 owed to you is overdue (40.0%).');
  });
});

// ---------------------------------------------------------------------------------------------
// N-11 — the overflow summary is dated where the run's as-of is
// ---------------------------------------------------------------------------------------------

describe('N-11 · the overflow summary is dated in the latest month that has begun', () => {
  it('not in a future month the run merely reached', () => {
    const months = ['2026-08-01', '2026-09-01', '2026-10-01', '2027-08-01'].map((start, i) => ({
      periodStart: start,
      ctx: { ...emptyRuleContext({ snapshots: [], records: [] }), periodId: `p${i}` },
    }));
    const noisy = { ...Object.fromEntries(Object.keys(EVALUATORS).map((k) => [k, () => []])), ...Object.fromEntries(['revenue.decline'].map((k) => [k, () => Array.from({ length: 30 }, (_, i) => ({
      ruleKey: 'revenue.decline', severity: 'medium', subject: { type: 'none', id: null, key: `s${i}` }, periodId: 'p0', metricKey: 'revenue',
      thresholdSummary: {}, snapshotIds: [], recordIds: [],
    }))])) };
    const plan = planEvaluation({
      organizationId: 'org', calculationRunId: 'run', currency: 'GBP', ruleVersion: 'v', periods: months as never,
      existing: new Map(), now: '2026-09-15T00:00:00Z', evaluators: noisy as never, asOf: '2026-09-15',
    });
    expect(plan.overflow).toBeGreaterThan(0);
    const overflow = plan.changes.find((c) => c.kind === 'insert' && c.ruleKey === 'attention.overflow');
    expect(overflow && 'periodId' in overflow ? overflow.periodId : null).toBe('p1');
  });
});
