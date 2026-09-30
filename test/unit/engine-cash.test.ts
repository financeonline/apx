import { describe, expect, it } from 'vitest';

import { Decimal, parseDecimal } from '@/core/money';
import { parseQueryDescriptor } from '@/modules/evidence';
import {
  CASH_LIKE_ACCOUNT_TYPES,
  RUNWAY_DISPLAY_CAP,
  buildCashHistory,
  computeCash,
  countsInCashMetrics,
  isCashLike,
  type AccountPeriodState,
  type BankAggregateCell,
  type CashPeriodInput,
  type DailyMovement,
  type StatementRef,
} from '@/modules/financial-engine';
import type {
  BankAccountRef,
  EngineContext,
  MetricResult,
  PeriodRef,
} from '@/modules/financial-engine';

/**
 * Cash metrics (FINANCIAL_ENGINE.md §3.3, ADR-028, CD-06, ADR-124).
 *
 * `computeCash` sums the per-account states the history builds (`buildCashHistory`, covered shape
 * by shape in engine-cash-history.test.ts). Here: ADR-028's transfer rule, the sums and what is
 * missing from them, runway, the snapshot's shape — and, over generated organisations, the one
 * property that matters most: every balance published is the TRUE balance.
 *
 * The property tests here are the ones §3.3 names, and they are genuine properties: each generates
 * a hundred different organisations from a seeded PRNG and asserts the identity over all of them.
 * The seed is fixed, so a failure is reproducible — the engine's own determinism rule applied to its
 * tests.
 */

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

/** Descriptor ids must be uuids (`EVIDENCE_MODEL.md §3`), so fixtures use real ones. */
function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

const RUN_ID = uuid(9001);
const AGGREGATED_AT = '2026-09-05T09:00:00Z';

function period(index: number): PeriodRef {
  const month = ((index % 12) + 12) % 12;
  const year = 2025 + Math.floor(index / 12);
  const start = `${year}-${String(month + 1).padStart(2, '0')}-01`;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return {
    id: uuid(100 + index),
    periodStart: start,
    periodEnd: `${year}-${String(month + 1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`,
    fiscalYear: year,
    fiscalQuarter: Math.floor(month / 3) + 1,
    label: `M${index}`,
    isComplete: true,
  };
}

const CURRENT = uuid(1);
const SAVINGS = uuid(2);
const CARD = uuid(3);
const LOAN = uuid(4);

function bankAccount(
  id: string,
  accountType: BankAccountRef['accountType'],
  overrides: Partial<BankAccountRef> = {},
): BankAccountRef {
  return {
    id,
    name: accountType,
    accountType,
    openingBalance: null,
    openingBalanceDate: null,
    isActive: true,
    ...overrides,
  };
}

function context(overrides: Partial<EngineContext> = {}): EngineContext {
  return {
    organizationId: uuid(1000),
    calculationRunId: RUN_ID,
    aggregatedAt: AGGREGATED_AT,
    asOf: '2026-09-05',
    engineVersion: '1.0.0',
    settings: {
      baseCurrency: 'GBP',
      fiscalYearStartMonth: 4,
      timezone: 'Europe/London',
      vatRegistered: false,
      defaultVatRate: null,
      taxableCategories: [],
    },
    accounts: [],
    costOfSalesEverUsed: true,
    costOfSalesInInvoices: false,
    counterparties: [],
    bankAccounts: [bankAccount(CURRENT, 'current'), bankAccount(SAVINGS, 'savings')],
    periods: [],
    ...overrides,
  };
}


function cell(input: {
  periodId: string;
  bankAccountId: string;
  inflow?: string;
  outflow?: string;
  category?: BankAggregateCell['standardCategory'];
  transferKind?: BankAggregateCell['transferKind'];
  unpaired?: boolean;
}): BankAggregateCell {
  const debit = input.inflow ?? '0.00';
  const credit = input.outflow ?? '0.00';
  return {
    periodId: input.periodId,
    source: 'bank',
    standardCategory: input.category ?? 'revenue',
    accountId: null,
    counterpartyId: null,
    bankAccountId: input.bankAccountId,
    balanceKind: null,
    balanceBasis: null,
    invoiceType: null,
    debit,
    credit,
    amount: parseDecimal(debit).minus(parseDecimal(credit)).toFixed(2),
    rowCount: 1,
    fallbackRows: 0,
    minDate: null,
    maxDate: null,
    transferKind: input.transferKind ?? 'none',
    unpairedTransferCandidate: input.unpaired ?? false,
  };
}

/**
 * One account's state in one period, as the history would hand it over. `closing` is derived the way
 * the history derives it — opening + the account's own rows, only when both are known — so these
 * aggregation tests cannot hand `computeCash` a state the history could never produce.
 */
function accountState(
  id: string,
  movements: readonly BankAggregateCell[],
  o: { opening?: string | null; covered?: boolean; statementClosing?: string | null; unreconciled?: boolean } = {},
): AccountPeriodState {
  const covered = o.covered ?? true;
  const opening = o.opening ?? null;
  const own = movements.filter((m) => m.bankAccountId === id)
    .reduce((acc, m) => acc.plus(parseDecimal(m.debit)).minus(parseDecimal(m.credit)), new Decimal(0));
  const fact = (value: string) => ({ value, source: 'statement_opening_balance' as const, assurance: 'verified' as const, anchorDate: '2025-01-01' });
  return {
    bankAccountId: id, name: id === CURRENT ? 'current' : id === SAVINGS ? 'savings' : id, inScope: true,
    movementKnown: covered, anyDayCovered: covered,
    opening: opening === null ? null : fact(opening),
    closing: opening !== null && covered ? fact(parseDecimal(opening).plus(own).toFixed(2)) : null,
    movement: own.toFixed(2), statementClosing: o.statementClosing ?? null, balanceMismatch: false,
    unreconciled: o.unreconciled ?? false, openingMissing: opening === null, everStated: opening !== null,
  };
}

/**
 * A period's input. `openings` states each in-scope account's opening (absent = unknown); `covered`
 * lists the accounts whose statements cover every day (default: every in-scope account).
 */
function periodInput(
  index: number,
  movements: readonly BankAggregateCell[],
  o: {
    accounts?: readonly string[]; openings?: Readonly<Record<string, string>>; covered?: readonly string[];
    statementClosing?: Readonly<Record<string, string>>; unreconciled?: boolean;
  } = {},
): CashPeriodInput {
  const p = period(index);
  const ids = o.accounts ?? [CURRENT, SAVINGS];
  return {
    period: p,
    movements: movements.map((m) => ({ ...m, periodId: p.id })),
    accounts: ids.map((id) => accountState(id, movements, {
      opening: o.openings?.[id] ?? null,
      covered: o.covered === undefined || o.covered.includes(id),
      statementClosing: o.statementClosing?.[id] ?? null,
      unreconciled: o.unreconciled ?? false,
    })),
  };
}

const bothZero = { openings: { [CURRENT]: '0.00', [SAVINGS]: '0.00' } } as const;

function metric(results: readonly { periodId: string; metrics: readonly MetricResult[] }[], index: number, key: string): MetricResult {
  const period = results[index];
  if (period === undefined) throw new Error(`no period at ${index}`);
  const found = period.metrics.find((m) => m.key === key);
  if (found === undefined) throw new Error(`no metric ${key}`);
  return found;
}

/** A seeded LCG, so a property failure is reproducible and the suite never flakes. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function money(random: () => number, max = 5000): string {
  return (Math.round(random() * max * 100) / 100).toFixed(2);
}

// ---------------------------------------------------------------------------------------------
// The cash-like set and the ADR-028 leg rule
// ---------------------------------------------------------------------------------------------

describe('the cash-like account set (§3, ADR-028)', () => {
  it('is exactly current and savings', () => {
    expect([...CASH_LIKE_ACCOUNT_TYPES].sort()).toEqual(['current', 'savings']);
    expect(isCashLike('current')).toBe(true);
    expect(isCashLike('savings')).toBe(true);
    expect(isCashLike('credit_card')).toBe(false);
    expect(isCashLike('loan')).toBe(false);
    expect(isCashLike('other')).toBe(false);
  });

  it('keeps every leg except a cash-to-cash transfer in the cash figures', () => {
    expect(countsInCashMetrics('current', 'none')).toBe(true);
    expect(countsInCashMetrics('current', 'cash_transfer')).toBe(false);
    expect(countsInCashMetrics('current', 'card_repayment')).toBe(true);
    expect(countsInCashMetrics('current', 'loan_repayment')).toBe(true);
    expect(countsInCashMetrics('current', 'loan_drawdown')).toBe(true);
    // A card or loan account is not cash at all, whatever the pairing.
    expect(countsInCashMetrics('credit_card', 'card_repayment')).toBe(false);
    expect(countsInCashMetrics('loan', 'none')).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Transfers
// ---------------------------------------------------------------------------------------------

describe('transfers in the cash figures (ADR-028)', () => {
  it('cancels a cash-like to cash-like pair out of both inflows and outflows', () => {
    const results = computeCash(context(), [
      periodInput(0, [
        cell({ periodId: '', bankAccountId: CURRENT, outflow: '2000.00', category: 'transfer', transferKind: 'cash_transfer' }),
        cell({ periodId: '', bankAccountId: SAVINGS, inflow: '2000.00', category: 'transfer', transferKind: 'cash_transfer' }),
        cell({ periodId: '', bankAccountId: CURRENT, inflow: '500.00' }),
      ], { openings: { [CURRENT]: '1000.00', [SAVINGS]: '0.00' } }),
    ]);

    expect(metric(results, 0, 'cash_inflows').value).toBe('500.00');
    expect(metric(results, 0, 'cash_outflows').value).toBe('0.00');
    expect(metric(results, 0, 'net_cash_movement').value).toBe('500.00');
    expect(metric(results, 0, 'cash_inflows').components).toMatchObject({ excluded_cash_transfer_legs: 2 });
  });

  it('counts a current-account payment to a credit card as a cash outflow, under credit_card', () => {
    // ADR-028's central case: excluding this leg overstates closing cash by every repayment made.
    const ctx = context({
      bankAccounts: [bankAccount(CURRENT, 'current'), bankAccount(CARD, 'credit_card')],
    });
    const results = computeCash(ctx, [
      periodInput(0, [
        cell({ periodId: '', bankAccountId: CURRENT, outflow: '3000.00', category: 'credit_card', transferKind: 'card_repayment' }),
        cell({ periodId: '', bankAccountId: CARD, inflow: '3000.00', category: 'credit_card', transferKind: 'card_repayment' }),
      ], { accounts: [CURRENT], openings: { [CURRENT]: '10000.00' } }),
    ]);

    expect(metric(results, 0, 'cash_outflows').value).toBe('3000.00');
    expect(metric(results, 0, 'cash_inflows').value).toBe('0.00');
    expect(metric(results, 0, 'net_cash_movement').value).toBe('-3000.00');
    expect(metric(results, 0, 'closing_cash').value).toBe('7000.00');
    expect(metric(results, 0, 'cash_outflows').components).toMatchObject({
      by_category: [{ category: 'credit_card', inflow: '0.00', outflow: '3000.00' }],
    });
  });

  it('counts a loan drawdown as a cash inflow and a loan repayment as an outflow', () => {
    const ctx = context({ bankAccounts: [bankAccount(CURRENT, 'current'), bankAccount(LOAN, 'loan')] });
    const results = computeCash(ctx, [
      periodInput(0, [
        cell({ periodId: '', bankAccountId: CURRENT, inflow: '25000.00', category: 'loan', transferKind: 'loan_drawdown' }),
        cell({ periodId: '', bankAccountId: CURRENT, outflow: '500.00', category: 'loan', transferKind: 'loan_repayment' }),
      ], { accounts: [CURRENT], openings: { [CURRENT]: '0.00' } }),
    ]);

    expect(metric(results, 0, 'cash_inflows').value).toBe('25000.00');
    expect(metric(results, 0, 'cash_outflows').value).toBe('500.00');
  });

  it('keeps an unpaired transfer candidate in the sums and warns rather than dropping it', () => {
    const results = computeCash(context(), [
      periodInput(0, [
        cell({ periodId: '', bankAccountId: CURRENT, outflow: '1200.00', unpaired: true }),
      ], { openings: { [CURRENT]: '5000.00', [SAVINGS]: '0.00' } }),
    ]);

    expect(metric(results, 0, 'cash_outflows').value).toBe('1200.00');
    expect(metric(results, 0, 'cash_outflows').dataQuality.warnings).toContain('unpaired_transfer_candidate');
  });

  it('sums cells that differ only by category, kind or account, under one stable order', () => {
    const base = { periodId: '', bankAccountId: CURRENT };
    const results = computeCash(context(), [
      periodInput(0, [
        { ...cell({ ...base, outflow: '10.00', category: 'payroll' }), accountId: uuid(61) },
        { ...cell({ ...base, outflow: '20.00', category: 'payroll' }), accountId: uuid(62) },
        cell({ ...base, outflow: '30.00', category: 'marketing' }),
        cell({ ...base, outflow: '40.00', category: 'loan', transferKind: 'loan_repayment' }),
        { ...cell({ ...base, outflow: '50.00' }), standardCategory: null },
      ], bothZero),
    ]);
    expect(metric(results, 0, 'cash_outflows').value).toBe('150.00');
    // An uncategorised movement is reported as such rather than silently joining another category.
    expect(metric(results, 0, 'cash_outflows').components).toMatchObject({
      by_category: [
        { category: 'loan', outflow: '40.00' },
        { category: 'marketing', outflow: '30.00' },
        { category: 'payroll', outflow: '30.00' },
        { category: 'uncategorised', outflow: '50.00' },
      ],
    });
  });

  it('ignores movements on a bank account the run did not load, and says how many', () => {
    const results = computeCash(context(), [
      periodInput(0, [cell({ periodId: '', bankAccountId: uuid(77), inflow: '900.00' })], bothZero),
    ]);
    expect(metric(results, 0, 'cash_inflows').value).toBe('0.00');
    expect(metric(results, 0, 'cash_inflows').components).toMatchObject({ unresolved_bank_account_cells: 1 });
  });
});

// ---------------------------------------------------------------------------------------------
// Opening and closing cash: the sum of the accounts, never part of it (ADR-124)
// ---------------------------------------------------------------------------------------------

describe('opening and closing cash are the in-scope accounts summed (§3.3, ADR-124)', () => {
  it('sums every account\'s balance when every one is known', () => {
    const results = computeCash(context(), [
      periodInput(0, [
        cell({ periodId: '', bankAccountId: CURRENT, inflow: '100.00' }),
        cell({ periodId: '', bankAccountId: SAVINGS, outflow: '40.00' }),
      ], { openings: { [CURRENT]: '1000.00', [SAVINGS]: '500.00' } }),
    ]);
    expect(metric(results, 0, 'opening_cash').value).toBe('1500.00');
    expect(metric(results, 0, 'closing_cash').value).toBe('1560.00');
    expect(metric(results, 0, 'closing_cash').dataQuality.missing).toEqual([]);
    expect(metric(results, 0, 'closing_cash').components).toMatchObject({
      per_account: [{ account_id: CURRENT, value: '1100.00' }, { account_id: SAVINGS, value: '460.00' }],
    });
  });

  it('never treats a missing opening balance as zero, and still states the movement', () => {
    const results = computeCash(context(), [
      periodInput(0, [cell({ periodId: '', bankAccountId: CURRENT, inflow: '4000.00' })]),
    ]);
    const opening = metric(results, 0, 'opening_cash');
    const closing = metric(results, 0, 'closing_cash');
    expect(opening.value).toBeNull();
    expect(opening.dataQuality.missing).toEqual(['no_opening_cash']);
    expect(closing.value).toBeNull();
    expect(closing.dataQuality.missing).toEqual(['no_opening_cash']);
    // §3.3: the movement metrics are still written when the statements cover the month.
    expect(metric(results, 0, 'cash_inflows').value).toBe('4000.00');
    expect(metric(results, 0, 'net_cash_movement').value).toBe('4000.00');
  });

  it('refuses a partial sum when one account has no opening, and names it (D-2)', () => {
    const results = computeCash(context(), [periodInput(0, [], { openings: { [CURRENT]: '5000.00' } })]);
    const opening = metric(results, 0, 'opening_cash');
    expect(opening.value).toBeNull();
    expect(opening.components).toMatchObject({
      accounts_without_opening_balance: [SAVINGS],
      missing_bank_accounts: [{ account_id: SAVINGS, name: 'savings' }],
    });
    expect(metric(results, 0, 'closing_cash').components).toMatchObject({
      missing_bank_accounts: [{ account_id: SAVINGS, name: 'savings' }],
    });
  });

  it('a month an account\'s statements do not fully cover has no stated movement and no closing (N-1)', () => {
    const results = computeCash(context(), [
      periodInput(0, [cell({ periodId: '', bankAccountId: CURRENT, outflow: '2000.00' })], {
        openings: { [CURRENT]: '9000.00', [SAVINGS]: '0.00' }, covered: [SAVINGS],
      }),
    ]);
    for (const key of ['cash_inflows', 'cash_outflows', 'net_cash_movement', 'closing_cash']) {
      const m = metric(results, 0, key);
      expect(m.value, key).toBeNull();
      expect(m.dataQuality.missing, key).toEqual(['no_source_covers_period']);
      expect(m.dataQuality.warnings, key).toContain('bank_coverage_partial');
      expect(m.dataQuality.completeness, key).toBe(0);
      expect(m.basis, key).toBe('none');
    }
    // The balance at the START of the month is still known — it is a statement's, not this month's.
    expect(metric(results, 0, 'opening_cash').value).toBe('9000.00');
    expect(metric(results, 0, 'cash_inflows').components).toMatchObject({ bank_coverage_ratio: 0.5, covered_bank_account_ids: [SAVINGS] });
  });

  it('a NULL figure is never "verified" and never complete (audit N-12)', () => {
    const results = computeCash(context(), [periodInput(0, [], { covered: [] })]);
    for (const key of ['cash_inflows', 'cash_outflows', 'net_cash_movement', 'opening_cash', 'closing_cash']) {
      const m = metric(results, 0, key);
      expect(m.value, key).toBeNull();
      expect(m.assurance, key).not.toBe('verified');
      expect(m.dataQuality.completeness, key).toBe(0);
    }
  });

  /*
   * ADR-104. A sum over zero accounts is not knowledge: a business whose statements were never
   * uploaded was once told, with completeness 1, that it had no money.
   */
  it('reports cash as unavailable, not zero, for an organization with no cash-like account at all', () => {
    for (const bankAccounts of [[], [bankAccount(CARD, 'credit_card')]]) {
      const ctx = context({ bankAccounts });
      const results = computeCash(ctx, [periodInput(0, [], { accounts: [] }), periodInput(1, [], { accounts: [] })]);
      for (const key of ['opening_cash', 'closing_cash', 'cash_inflows', 'cash_outflows', 'net_cash_movement']) {
        for (const index of [0, 1]) {
          const m = metric(results, index, key);
          expect(m.value, `${key} in period ${index}`).toBeNull();
          expect(m.dataQuality.missing, key).toEqual(['no_bank_accounts']);
          expect(m.dataQuality.completeness, key).toBe(0);
          expect(m.basis, key).toBe('none');
        }
      }
      expect(metric(results, 1, 'cash_runway_months').value).toBeNull();
    }
  });

  it('an organisation whose accounts have not started yet: nothing covers the month', () => {
    const results = computeCash(context(), [periodInput(0, [], { accounts: [] })]);
    expect(metric(results, 0, 'closing_cash').dataQuality.missing).toEqual(['no_source_covers_period']);
  });

  it('still computes the months a since-closed account was covered for', () => {
    const ctx = context({ bankAccounts: [bankAccount(CURRENT, 'current', { isActive: false })] });
    const results = computeCash(ctx, [
      periodInput(0, [cell({ periodId: '', bankAccountId: CURRENT, inflow: '250.00' })], {
        accounts: [CURRENT], openings: { [CURRENT]: '1000.00' },
      }),
    ]);
    expect(metric(results, 0, 'closing_cash').value).toBe('1250.00');
  });
});

describe('the closing balance cross-check (§3.3)', () => {
  const movements = [cell({ periodId: '', bankAccountId: CURRENT, inflow: '1000.00' })];
  const one = context({ bankAccounts: [bankAccount(CURRENT, 'current')] });

  it('warns when the statement disagrees by more than a penny, and still stores the computed value', () => {
    const results = computeCash(one, [
      periodInput(0, movements, { accounts: [CURRENT], openings: { [CURRENT]: '4000.00' }, statementClosing: { [CURRENT]: '5100.00' } }),
    ]);
    const closing = metric(results, 0, 'closing_cash');
    expect(closing.value).toBe('5000.00');
    expect(closing.dataQuality.warnings).toContain('statement_balance_mismatch');
    expect(closing.components).toMatchObject({ statement_closing_cash: '5100.00', statement_delta: '100.00' });
  });

  it('stays silent when the statement agrees to within a penny', () => {
    const results = computeCash(one, [
      periodInput(0, movements, { accounts: [CURRENT], openings: { [CURRENT]: '4000.00' }, statementClosing: { [CURRENT]: '5000.01' } }),
    ]);
    expect(metric(results, 0, 'closing_cash').dataQuality.warnings).not.toContain('statement_balance_mismatch');
  });

  it('does not cross-check when one account supplies no printed closing', () => {
    const results = computeCash(context(), [
      periodInput(0, movements, { ...bothZero, statementClosing: { [CURRENT]: '999999.00' } }),
    ]);
    expect(metric(results, 0, 'closing_cash').components).not.toHaveProperty('statement_delta');
  });

  it('passes a mismatch the history found inside the month through to the closing', () => {
    const ctx = context({ bankAccounts: [bankAccount(CURRENT, 'current')] });
    const input = periodInput(0, movements, { accounts: [CURRENT], openings: { [CURRENT]: '4000.00' } });
    const flagged: CashPeriodInput = { ...input, accounts: input.accounts.map((a) => ({ ...a, balanceMismatch: true })) };
    expect(metric(computeCash(ctx, [flagged]), 0, 'closing_cash').dataQuality.warnings).toContain('statement_balance_mismatch');
  });

  it('passes an unreconciled statement warning through to the period', () => {
    const results = computeCash(context(), [periodInput(0, movements, { ...bothZero, unreconciled: true })]);
    expect(metric(results, 0, 'closing_cash').dataQuality.warnings).toContain('unreconciled_statement');
  });
});

// ---------------------------------------------------------------------------------------------
// Runway
// ---------------------------------------------------------------------------------------------

describe('cash_runway_months (§3.3)', () => {
  /** Three months of the same burn; each month opens where the history would put it. */
  function burning(monthlyOutflow: string, opening: string, months = 3): CashPeriodInput[] {
    return Array.from({ length: months }, (_, index) =>
      periodInput(index, [cell({ periodId: '', bankAccountId: CURRENT, outflow: monthlyOutflow })], {
        accounts: [CURRENT],
        openings: { [CURRENT]: parseDecimal(opening).minus(parseDecimal(monthlyOutflow).times(index)).toFixed(2) },
      }),
    );
  }
  const burn = (index: number, outflow: string, opening: string | null): CashPeriodInput =>
    periodInput(index, [cell({ periodId: '', bankAccountId: CURRENT, outflow })], {
      accounts: [CURRENT], ...(opening === null ? {} : { openings: { [CURRENT]: opening } }),
    });
  const earn = (index: number, inflow: string, opening: string): CashPeriodInput =>
    periodInput(index, [cell({ periodId: '', bankAccountId: CURRENT, inflow })], { accounts: [CURRENT], openings: { [CURRENT]: opening } });

  const oneAccount = context({ bankAccounts: [bankAccount(CURRENT, 'current')] });

  it('divides closing cash by the mean burn of three months', () => {
    const results = computeCash(oneAccount, burning('1000.00', '10000.00'));
    // Closing 7,000 after three months of 1,000 burn → 7 months.
    expect(metric(results, 2, 'cash_runway_months').value).toBe('7.000000');
    expect(metric(results, 2, 'cash_runway_months').components).toMatchObject({ avg_burn: '1000.00' });
  });

  it('is NULL with insufficient_history before three months exist', () => {
    const results = computeCash(oneAccount, burning('1000.00', '10000.00'));
    for (const index of [0, 1]) {
      const runway = metric(results, index, 'cash_runway_months');
      expect(runway.value).toBeNull();
      expect(runway.dataQuality.missing).toContain('insufficient_history');
    }
  });

  it('uses carried-in movements so a chunk boundary does not lose the window', () => {
    const results = computeCash(
      oneAccount,
      [burn(5, '1000.00', '8000.00')],
      { priorNetMovements: ['-1000.00', '-1000.00'] },
    );
    expect(metric(results, 0, 'cash_runway_months').value).toBe('7.000000');
  });

  it('refuses the window when the three periods are not consecutive months', () => {
    const results = computeCash(oneAccount, [burn(0, '100.00', '900.00'), burn(1, '100.00', '800.00'), burn(4, '100.00', '700.00')]);
    expect(metric(results, 2, 'cash_runway_months').dataQuality.missing).toContain('insufficient_history');
  });

  it('is NULL with cash_positive when the business is not burning', () => {
    const results = computeCash(oneAccount, [earn(0, '500.00', '1000.00'), earn(1, '500.00', '1500.00'), earn(2, '500.00', '2000.00')]);
    const runway = metric(results, 2, 'cash_runway_months');
    expect(runway.value).toBeNull();
    expect(runway.dataQuality.warnings).toContain('cash_positive');
    expect(runway.dataQuality.missing.length).toBeGreaterThan(0);
  });

  it('is zero, not NULL, when the cash is gone', () => {
    const results = computeCash(oneAccount, burning('1000.00', '2000.00'));
    expect(metric(results, 2, 'closing_cash').value).toBe('-1000.00');
    expect(metric(results, 2, 'cash_runway_months').value).toBe('0.000000');
    expect(metric(results, 2, 'cash_runway_months').dataQuality.missing).toEqual([]);
  });

  it('stores the true figure and flags that the display caps it at 36', () => {
    const results = computeCash(oneAccount, burning('100.00', '100000.00'));
    const runway = metric(results, 2, 'cash_runway_months');
    expect(parseDecimal(runway.value ?? '0').greaterThan(RUNWAY_DISPLAY_CAP)).toBe(true);
    expect(runway.components).toMatchObject({ display_cap: 36, capped_for_display: true });
  });

  it('is NULL when the closing balance it would divide is unknown', () => {
    const results = computeCash(oneAccount, [burn(0, '100.00', null), burn(1, '100.00', null), burn(2, '100.00', null)]);
    const runway = metric(results, 2, 'cash_runway_months');
    expect(runway.value).toBeNull();
    expect(runway.dataQuality.missing).toContain('no_opening_cash');
  });
});

// ---------------------------------------------------------------------------------------------
// Evidence and shape
// ---------------------------------------------------------------------------------------------

describe('the shape of a cash snapshot', () => {
  const results = computeCash(context(), [
    periodInput(0, [cell({ periodId: '', bankAccountId: CURRENT, inflow: '10.00' })], bothZero),
  ]);

  it('writes a v1 leaf descriptor the evidence schema accepts', () => {
    const evidence = metric(results, 0, 'cash_outflows').evidenceQuery;
    expect(evidence?.kind).toBe('leaf');
    if (evidence?.kind !== 'leaf') throw new Error('expected a leaf');
    const parsed = parseQueryDescriptor(evidence.descriptor);
    expect(parsed.table).toBe('bank_transactions');
    expect(parsed.filters.direction).toBe('outflow');
    expect(parsed.filters.exclude_cash_transfers).toBe(true);
    expect(parsed.as_of).toEqual({ calculation_run_id: RUN_ID, aggregated_at: AGGREGATED_AT });
  });

  it('points derived metrics at the metrics they were computed from', () => {
    const evidence = metric(results, 0, 'closing_cash').evidenceQuery;
    expect(evidence).toEqual({
      kind: 'derived',
      components: [
        { name: 'opening_cash', snapshot_id: null },
        { name: 'net_cash_movement', snapshot_id: null },
      ],
    });
  });

  it('states the currency on money metrics and omits it on the runway count', () => {
    expect(metric(results, 0, 'closing_cash').currency).toBe('GBP');
    expect(metric(results, 0, 'cash_runway_months').currency).toBeNull();
    expect(metric(results, 0, 'cash_runway_months').unit).toBe('count');
  });

  it('writes all six keys once per period', () => {
    expect(results[0]?.metrics.map((m) => m.key)).toEqual([
      'cash_inflows', 'cash_outflows', 'net_cash_movement',
      'opening_cash', 'closing_cash', 'cash_runway_months',
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// Properties (§3.3), over generated organisations run through the whole pipeline
// ---------------------------------------------------------------------------------------------

const PROPERTY_PERIODS = [0, 1, 2, 3, 4, 5].map(period);

function addDay(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

interface GeneratedOrg {
  readonly ctx: EngineContext;
  readonly inputs: CashPeriodInput[];
  /** The TRUE balance of each account at the close of `date` — including every day no statement covered. */
  readonly truth: (accountId: string, date: string) => Decimal;
  readonly scopeStart: ReadonlyMap<string, string | null>;
}

/**
 * A random organisation with a hidden truth. Every account has a real balance every day; statements
 * cover random stretches of it (gaps, splits mid-month, some printing their balances — truthfully);
 * some accounts carry a typed opening balance; a second account may start later. The engine sees only
 * what the statements show. Whatever it publishes must be the truth.
 */
function generatedOrg(random: () => number): GeneratedOrg {
  const first = PROPERTY_PERIODS[0]!.periodStart;
  const last = PROPERTY_PERIODS[PROPERTY_PERIODS.length - 1]!.periodEnd;
  const accounts: BankAccountRef[] = [];
  const statements: StatementRef[] = [];
  const truthMoves: DailyMovement[] = [];
  const initial = new Map<string, Decimal>();
  let batch = 0;

  for (const [id, type] of [[CURRENT, 'current'], [SAVINGS, 'savings']] as const) {
    if (id === SAVINGS && random() < 0.4) continue;
    const start = addDay(first, Math.floor(random() * (id === CURRENT ? 20 : 100)));
    const opening = new Decimal(money(random, 20000));
    initial.set(id, opening);
    const typed = random() < 0.5;
    accounts.push(bankAccount(id, type, typed
      ? { openingBalance: opening.toFixed(2), openingBalanceDate: addDay(start, -1 - Math.floor(random() * 2) * 40) }
      : {}));

    for (let day = start; day <= last; day = addDay(day, 1)) {
      if (random() < 0.12) truthMoves.push({ bankAccountId: id, date: day, amount: (random() < 0.5 ? '-' : '') + money(random, 3000) });
    }
    const balanceAt = (date: string): Decimal => truthMoves
      .filter((m) => m.bankAccountId === id && m.date <= date)
      .reduce((acc, m) => acc.plus(parseDecimal(m.amount)), opening);

    // Statement stretches: cut the account's life at random days; drop some stretches (gaps).
    const cuts = new Set<string>();
    const span = Math.round((Date.parse(`${last}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000);
    for (let i = 0, n = 2 + Math.floor(random() * 5); i < n; i += 1) cuts.add(addDay(start, 1 + Math.floor(random() * span)));
    const bounds = [start, ...[...cuts].sort(), addDay(last, 1)];
    for (let i = 0; i + 1 < bounds.length; i += 1) {
      const from = bounds[i]!;
      const to = addDay(bounds[i + 1]!, -1);
      if (to < from || random() < 0.2) continue;
      batch += 1;
      statements.push({
        batchId: uuid(7000 + batch), bankAccountId: id, periodStart: from, periodEnd: to, committedAt: '2025-12-01T00:00:00Z',
        openingBalance: random() < 0.6 ? balanceAt(addDay(from, -1)).toFixed(2) : null,
        closingBalance: random() < 0.5 ? balanceAt(to).toFixed(2) : null,
        unreconciled: false,
      });
    }
  }

  // The engine sees only rows on days a statement covers.
  const covered = (m: DailyMovement): boolean =>
    statements.some((st) => st.bankAccountId === m.bankAccountId && st.periodStart <= m.date && st.periodEnd >= m.date);
  const visible = truthMoves.filter(covered);
  const ctx = context({ bankAccounts: accounts });
  const history = buildCashHistory({ bankAccounts: accounts, statements, movements: visible, periods: PROPERTY_PERIODS });
  const inputs = PROPERTY_PERIODS.map((p) => {
    const cells: BankAggregateCell[] = [];
    for (const account of accounts) {
      const rows = visible.filter((m) => m.bankAccountId === account.id && m.date >= p.periodStart && m.date <= p.periodEnd);
      if (rows.length === 0) continue;
      const inflow = rows.map((r) => parseDecimal(r.amount)).filter((a) => a.greaterThan(0)).reduce((a, b) => a.plus(b), new Decimal(0));
      const outflow = rows.map((r) => parseDecimal(r.amount)).filter((a) => a.lessThan(0)).reduce((a, b) => a.plus(b.abs()), new Decimal(0));
      cells.push(cell({ periodId: p.id, bankAccountId: account.id, inflow: inflow.toFixed(2), outflow: outflow.toFixed(2) }));
    }
    return { period: p, movements: cells, accounts: history.get(p.id)! };
  });

  const truth = (accountId: string, date: string): Decimal => truthMoves
    .filter((m) => m.bankAccountId === accountId && m.date <= date)
    .reduce((acc, m) => acc.plus(parseDecimal(m.amount)), initial.get(accountId)!);
  const scopeStart = new Map(accounts.map((a) => {
    const starts = statements.filter((st) => st.bankAccountId === a.id).map((st) => st.periodStart);
    if (a.openingBalanceDate !== null) starts.push(addDay(a.openingBalanceDate, 1));
    return [a.id, starts.length === 0 ? null : starts.sort()[0]!] as const;
  }));
  return { ctx, inputs, truth, scopeStart };
}

describe('the properties §3.3 names, over 150 generated organisations each', () => {
  const orgs = (seed: number): GeneratedOrg[] => {
    const random = prng(seed);
    return Array.from({ length: 150 }, () => generatedOrg(random));
  };

  it('every balance published is the TRUE balance — no gap, split or stale figure ever becomes one', () => {
    let published = 0;
    for (const org of orgs(20261001)) {
      const results = computeCash(org.ctx, org.inputs);
      org.inputs.forEach((input, index) => {
        const p = input.period;
        const inScope = [...org.scopeStart.entries()].filter(([, start]) => start === null || start <= p.periodEnd).map(([id]) => id);
        const expectAt = (date: (id: string) => string) => inScope
          .reduce((acc, id) => acc.plus(org.truth(id, date(id))), new Decimal(0)).toFixed(2);
        // D-2: an account joins the total on the first day anything is recorded for it, with its
        // balance at the close of the day before. Joining mid-month, that is the balance it brings.
        const openingDate = (id: string): string => {
          const start = org.scopeStart.get(id) ?? null;
          const dayBefore = addDay(p.periodStart, -1);
          return start !== null && addDay(start, -1) > dayBefore ? addDay(start, -1) : dayBefore;
        };
        const opening = metric(results, index, 'opening_cash').value;
        const closing = metric(results, index, 'closing_cash').value;
        if (opening !== null) {
          published += 1;
          expect(parseDecimal(opening).toFixed(2), `${p.label} opening`).toBe(expectAt(openingDate));
        }
        if (closing !== null) {
          published += 1;
          expect(parseDecimal(closing).toFixed(2), `${p.label} closing`).toBe(expectAt(() => p.periodEnd));
        }
      });
    }
    // The generator must actually produce publishable months, or the property is vacuous.
    expect(published).toBeGreaterThan(300);
  });

  it('holds net_cash_movement = cash_inflows − cash_outflows wherever it is stated', () => {
    for (const org of orgs(20260905)) {
      const results = computeCash(org.ctx, org.inputs);
      org.inputs.forEach((_, index) => {
        const net = metric(results, index, 'net_cash_movement').value;
        if (net === null) return;
        const inflows = parseDecimal(metric(results, index, 'cash_inflows').value!);
        const outflows = parseDecimal(metric(results, index, 'cash_outflows').value!);
        expect(net).toBe(inflows.minus(outflows).toFixed(2));
      });
    }
  });

  it('holds closing_cash = opening_cash + net_cash_movement wherever all three are stated', () => {
    for (const org of orgs(777)) {
      const results = computeCash(org.ctx, org.inputs);
      org.inputs.forEach((_, index) => {
        const [opening, net, closing] = ['opening_cash', 'net_cash_movement', 'closing_cash'].map((k) => metric(results, index, k).value);
        if (closing === null) return;
        expect(opening).not.toBeNull();
        expect(net).not.toBeNull();
        expect(closing).toBe(parseDecimal(opening!).plus(parseDecimal(net!)).toFixed(2));
      });
    }
  });

  it('holds closing_cash(P) = opening_cash(P+1) when both are stated over the same accounts', () => {
    for (const org of orgs(4242)) {
      const results = computeCash(org.ctx, org.inputs);
      for (let index = 0; index + 1 < org.inputs.length; index += 1) {
        const closing = metric(results, index, 'closing_cash').value;
        const next = metric(results, index + 1, 'opening_cash').value;
        const sameScope = org.inputs[index]!.accounts.filter((a) => a.inScope).length
          === org.inputs[index + 1]!.accounts.filter((a) => a.inScope).length;
        if (closing !== null && next !== null && sameScope) expect(next).toBe(closing);
      }
    }
  });

  it('keeps a cash-to-cash transfer out of both directions, whatever else is going on', () => {
    const random = prng(31337);
    for (let trial = 0; trial < 100; trial += 1) {
      const amount = money(random, 9000);
      const noise = money(random, 4000);
      const withTransfer = computeCash(context(), [
        periodInput(0, [
          cell({ periodId: '', bankAccountId: CURRENT, inflow: noise }),
          cell({ periodId: '', bankAccountId: CURRENT, outflow: amount, category: 'transfer', transferKind: 'cash_transfer' }),
          cell({ periodId: '', bankAccountId: SAVINGS, inflow: amount, category: 'transfer', transferKind: 'cash_transfer' }),
        ], bothZero),
      ]);
      const without = computeCash(context(), [
        periodInput(0, [cell({ periodId: '', bankAccountId: CURRENT, inflow: noise })], bothZero),
      ]);
      expect(metric(withTransfer, 0, 'cash_inflows').value).toBe(metric(without, 0, 'cash_inflows').value);
      expect(metric(withTransfer, 0, 'cash_outflows').value).toBe(metric(without, 0, 'cash_outflows').value);
      expect(new Decimal(metric(withTransfer, 0, 'net_cash_movement').value ?? '0').toFixed(2)).toBe(noise);
      // The balances move and cancel: the total is the same with and without the internal move.
      expect(metric(withTransfer, 0, 'closing_cash').value).toBe(metric(without, 0, 'closing_cash').value);
    }
  });

  it('always keeps a card repayment in cash_outflows, whatever else is going on', () => {
    const random = prng(28028);
    const ctx = context({ bankAccounts: [bankAccount(CURRENT, 'current'), bankAccount(CARD, 'credit_card')] });
    for (let trial = 0; trial < 100; trial += 1) {
      const repayment = money(random, 9000);
      const other = money(random, 3000);
      const results = computeCash(ctx, [
        periodInput(0, [
          cell({ periodId: '', bankAccountId: CURRENT, outflow: other, category: 'operating_expense' }),
          cell({ periodId: '', bankAccountId: CURRENT, outflow: repayment, category: 'credit_card', transferKind: 'card_repayment' }),
          cell({ periodId: '', bankAccountId: CARD, inflow: repayment, category: 'credit_card', transferKind: 'card_repayment' }),
        ], { accounts: [CURRENT], openings: { [CURRENT]: '0.00' } }),
      ]);
      expect(metric(results, 0, 'cash_outflows').value).toBe(
        parseDecimal(repayment).plus(parseDecimal(other)).toFixed(2),
      );
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Determinism (§1.1)
// ---------------------------------------------------------------------------------------------

describe('determinism (§1.1)', () => {
  const org = generatedOrg(prng(11));

  it('produces byte-identical results when run twice', () => {
    expect(JSON.stringify(computeCash(org.ctx, org.inputs))).toBe(JSON.stringify(computeCash(org.ctx, org.inputs)));
  });

  it('produces the same results whatever order the periods, cells and accounts arrive in', () => {
    const shuffled = [...org.inputs]
      .reverse()
      .map((input) => ({ ...input, movements: [...input.movements].reverse(), accounts: [...input.accounts].reverse() }));
    expect(JSON.stringify(computeCash(org.ctx, shuffled))).toBe(JSON.stringify(computeCash(org.ctx, org.inputs)));
  });
});
