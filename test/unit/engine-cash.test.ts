import { describe, expect, it } from 'vitest';

import { Decimal, parseDecimal } from '@/core/money';
import { parseQueryDescriptor } from '@/modules/evidence';
import {
  CASH_LIKE_ACCOUNT_TYPES,
  RUNWAY_DISPLAY_CAP,
  computeCash,
  countsInCashMetrics,
  isCashLike,
  type BankAggregateCell,
  type CashPeriodInput,
  type CashSeriesOptions,
  type OpeningCashCandidate,
} from '@/modules/financial-engine';
import type {
  BankAccountRef,
  BasisChoice,
  EngineContext,
  MetricResult,
  PeriodRef,
} from '@/modules/financial-engine';

/**
 * Cash metrics (FINANCIAL_ENGINE.md §3.3, ADR-028, CD-06).
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
    counterparties: [],
    bankAccounts: [bankAccount(CURRENT, 'current'), bankAccount(SAVINGS, 'savings')],
    periods: [],
    ...overrides,
  };
}

const BANK_BASIS: BasisChoice = {
  basis: 'bank',
  assurance: 'verified',
  warnings: [],
  proxy: false,
};

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
    minDate: null,
    maxDate: null,
    transferKind: input.transferKind ?? 'none',
    unpairedTransferCandidate: input.unpaired ?? false,
  };
}

function periodInput(
  index: number,
  movements: readonly BankAggregateCell[],
  overrides: Partial<CashPeriodInput> = {},
): CashPeriodInput {
  const p = period(index);
  return {
    period: p,
    basis: BANK_BASIS,
    movements: movements.map((m) => ({ ...m, periodId: p.id })),
    openingCandidates: [],
    coveredBankAccountIds: [CURRENT, SAVINGS],
    ...overrides,
  };
}

function statementOpening(bankAccountId: string, value: string): OpeningCashCandidate {
  return { bankAccountId, source: 'statement_opening_balance', value, asAtDate: null };
}

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
      ], { openingCandidates: [statementOpening(CURRENT, '1000.00'), statementOpening(SAVINGS, '0.00')] }),
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
      ], {
        coveredBankAccountIds: [CURRENT],
        openingCandidates: [statementOpening(CURRENT, '10000.00')],
      }),
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
      ], { coveredBankAccountIds: [CURRENT], openingCandidates: [statementOpening(CURRENT, '0.00')] }),
    ]);

    expect(metric(results, 0, 'cash_inflows').value).toBe('25000.00');
    expect(metric(results, 0, 'cash_outflows').value).toBe('500.00');
  });

  it('keeps an unpaired transfer candidate in the sums and warns rather than dropping it', () => {
    const results = computeCash(context(), [
      periodInput(0, [
        cell({ periodId: '', bankAccountId: CURRENT, outflow: '1200.00', unpaired: true }),
      ], { openingCandidates: [statementOpening(CURRENT, '5000.00'), statementOpening(SAVINGS, '0.00')] }),
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
      ], { openingCandidates: [statementOpening(CURRENT, '0.00'), statementOpening(SAVINGS, '0.00')] }),
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
      periodInput(0, [cell({ periodId: '', bankAccountId: uuid(77), inflow: '900.00' })], {
        openingCandidates: [statementOpening(CURRENT, '0.00'), statementOpening(SAVINGS, '0.00')],
      }),
    ]);
    expect(metric(results, 0, 'cash_inflows').value).toBe('0.00');
    expect(metric(results, 0, 'cash_inflows').components).toMatchObject({ unresolved_bank_account_cells: 1 });
  });
});

// ---------------------------------------------------------------------------------------------
// Opening and closing cash
// ---------------------------------------------------------------------------------------------

describe('opening cash (CD-06, ADR-027.3)', () => {
  const sources: ReadonlyArray<[OpeningCashCandidate['source'], string]> = [
    ['statement_opening_balance', '100.00'],
    ['bank_account_opening_balance', '200.00'],
    ['balance_sheet_prior_period', '300.00'],
    ['opening_balance_journal', '400.00'],
  ];

  it('prefers the statement balance, then the entered balance, then a prior balance sheet, then a journal', () => {
    for (let from = 0; from < sources.length; from += 1) {
      const available = sources.slice(from).map(([source, value]) => ({
        bankAccountId: CURRENT,
        source,
        value,
        asAtDate: null,
      }));
      const results = computeCash(
        context({ bankAccounts: [bankAccount(CURRENT, 'current')] }),
        [periodInput(0, [], { coveredBankAccountIds: [CURRENT], openingCandidates: available })],
      );
      const expected = sources[from];
      expect(metric(results, 0, 'opening_cash').value).toBe(expected?.[1]);
      expect(metric(results, 0, 'opening_cash').components).toMatchObject({
        accounts: [{ account_id: CURRENT, source: expected?.[0], value: expected?.[1] }],
      });
    }
  });

  it('never treats a missing opening balance as zero', () => {
    const results = computeCash(context(), [
      periodInput(0, [cell({ periodId: '', bankAccountId: CURRENT, inflow: '4000.00' })]),
    ]);
    const opening = metric(results, 0, 'opening_cash');
    const closing = metric(results, 0, 'closing_cash');

    expect(opening.value).toBeNull();
    expect(opening.value).not.toBe('0.00');
    expect(opening.dataQuality.missing).toContain('no_opening_cash');
    expect(closing.value).toBeNull();
    expect(closing.dataQuality.missing).toContain('no_opening_cash');
    // §3.3: the movement metrics are still written; only the balances are unknown.
    expect(metric(results, 0, 'cash_inflows').value).toBe('4000.00');
    expect(metric(results, 0, 'net_cash_movement').value).toBe('4000.00');
  });

  it('poisons every later closing balance when the opening balance is unknown', () => {
    const results = computeCash(context(), [
      periodInput(0, [cell({ periodId: '', bankAccountId: CURRENT, inflow: '100.00' })]),
      periodInput(1, [cell({ periodId: '', bankAccountId: CURRENT, inflow: '200.00' })]),
      periodInput(2, [cell({ periodId: '', bankAccountId: CURRENT, inflow: '300.00' })]),
    ]);
    for (const index of [0, 1, 2]) {
      expect(metric(results, index, 'closing_cash').value).toBeNull();
      expect(metric(results, index, 'closing_cash').dataQuality.missing).toContain('no_opening_cash');
      expect(metric(results, index, 'net_cash_movement').value).not.toBeNull();
    }
  });

  it('refuses a partial sum when one cash-like account has no opening balance', () => {
    const results = computeCash(context(), [
      periodInput(0, [], { openingCandidates: [statementOpening(CURRENT, '5000.00')] }),
    ]);
    expect(metric(results, 0, 'opening_cash').value).toBeNull();
    expect(metric(results, 0, 'opening_cash').components).toMatchObject({
      accounts_without_opening_balance: [SAVINGS],
    });
  });

  it('ignores an entered opening balance dated after the period start', () => {
    const ctx = context({ bankAccounts: [bankAccount(CURRENT, 'current')] });
    const late: OpeningCashCandidate = {
      bankAccountId: CURRENT,
      source: 'bank_account_opening_balance',
      value: '900.00',
      asAtDate: '2025-06-15',
    };
    const results = computeCash(ctx, [
      periodInput(0, [], { coveredBankAccountIds: [CURRENT], openingCandidates: [late] }),
    ]);
    expect(metric(results, 0, 'opening_cash').value).toBeNull();
    expect(metric(results, 0, 'opening_cash').dataQuality.missing).toContain('no_opening_cash');
  });

  it('lets a new account joining mid-history bring its opening balance with it', () => {
    const ctx = context({
      bankAccounts: [bankAccount(CURRENT, 'current'), bankAccount(SAVINGS, 'savings')],
    });
    const results = computeCash(ctx, [
      periodInput(0, [cell({ periodId: '', bankAccountId: CURRENT, inflow: '1000.00' })], {
        coveredBankAccountIds: [CURRENT],
        openingCandidates: [statementOpening(CURRENT, '500.00'), statementOpening(SAVINGS, '0.00')],
      }),
      periodInput(1, [cell({ periodId: '', bankAccountId: SAVINGS, inflow: '50.00' })], {
        coveredBankAccountIds: [CURRENT, SAVINGS],
        openingCandidates: [statementOpening(SAVINGS, '7000.00')],
      }),
    ]);

    expect(metric(results, 0, 'closing_cash').value).toBe('1500.00');
    // 1,500 carried + the savings account's own 7,000 opening balance.
    expect(metric(results, 1, 'opening_cash').value).toBe('8500.00');
    expect(metric(results, 1, 'opening_cash').components).toMatchObject({
      new_accounts_this_period: [SAVINGS],
    });
    expect(metric(results, 1, 'closing_cash').value).toBe('8550.00');
  });

  it('takes the opening balance from a carried-in closing balance across a chunk boundary', () => {
    const options: CashSeriesOptions = {
      openingCarry: {
        value: '12000.00',
        basis: 'bank',
        assurance: 'verified',
        missing: [],
        coveredBankAccountIds: [CURRENT, SAVINGS],
      },
    };
    const results = computeCash(
      context(),
      [periodInput(3, [cell({ periodId: '', bankAccountId: CURRENT, outflow: '2000.00' })])],
      options,
    );
    expect(metric(results, 0, 'opening_cash').value).toBe('12000.00');
    expect(metric(results, 0, 'closing_cash').value).toBe('10000.00');
  });

  it('carries a NULL closing balance across a chunk boundary with its reason intact', () => {
    const results = computeCash(
      context(),
      [periodInput(3, [cell({ periodId: '', bankAccountId: CURRENT, inflow: '10.00' })])],
      { openingCarry: { value: null, basis: 'none', assurance: 'calculated', missing: ['no_opening_cash'] } },
    );
    expect(metric(results, 0, 'opening_cash').value).toBeNull();
    expect(metric(results, 0, 'opening_cash').dataQuality.missing).toEqual(['no_opening_cash']);
  });

  it('records a reason even when the carried-in NULL arrived without one', () => {
    // A carry that says "unknown" but not why would otherwise produce a NULL with no reason, which
    // §1.5 forbids: a NULL a reader cannot explain is indistinguishable from a bug.
    const results = computeCash(
      context(),
      [periodInput(3, [cell({ periodId: '', bankAccountId: CURRENT, inflow: '10.00' })])],
      { openingCarry: { value: null, basis: 'none', assurance: 'calculated', missing: [] } },
    );
    expect(metric(results, 0, 'opening_cash').value).toBeNull();
    expect(metric(results, 0, 'opening_cash').dataQuality.missing).toEqual(['no_opening_cash']);
  });

  it('reports zero opening cash for an organization with no cash-like accounts at all', () => {
    // Zero here is knowledge, not a gap: there is nothing to have a balance (§1.5).
    const ctx = context({ bankAccounts: [bankAccount(CARD, 'credit_card')] });
    const results = computeCash(ctx, [periodInput(0, [], { coveredBankAccountIds: [] })]);
    expect(metric(results, 0, 'opening_cash').value).toBe('0.00');
    expect(metric(results, 0, 'opening_cash').dataQuality.missing).toEqual([]);
  });
});

describe('the closing balance cross-check (§3.3)', () => {
  const movements = [cell({ periodId: '', bankAccountId: CURRENT, inflow: '1000.00' })];

  it('warns when the statement disagrees by more than a penny, and still stores the computed value', () => {
    const results = computeCash(context({ bankAccounts: [bankAccount(CURRENT, 'current')] }), [
      periodInput(0, movements, {
        coveredBankAccountIds: [CURRENT],
        openingCandidates: [statementOpening(CURRENT, '4000.00')],
        statementClosing: [{ bankAccountId: CURRENT, balanceAfter: '5100.00' }],
      }),
    ]);
    const closing = metric(results, 0, 'closing_cash');
    expect(closing.value).toBe('5000.00');
    expect(closing.dataQuality.warnings).toContain('statement_balance_mismatch');
    expect(closing.components).toMatchObject({
      statement_closing_cash: '5100.00',
      statement_delta: '100.00',
    });
  });

  it('stays silent when the statement agrees to within a penny', () => {
    const results = computeCash(context({ bankAccounts: [bankAccount(CURRENT, 'current')] }), [
      periodInput(0, movements, {
        coveredBankAccountIds: [CURRENT],
        openingCandidates: [statementOpening(CURRENT, '4000.00')],
        statementClosing: [{ bankAccountId: CURRENT, balanceAfter: '5000.01' }],
      }),
    ]);
    expect(metric(results, 0, 'closing_cash').dataQuality.warnings).not.toContain('statement_balance_mismatch');
  });

  it('does not cross-check when one covered account supplies no closing balance', () => {
    const results = computeCash(context(), [
      periodInput(0, movements, {
        openingCandidates: [statementOpening(CURRENT, '0.00'), statementOpening(SAVINGS, '0.00')],
        statementClosing: [{ bankAccountId: CURRENT, balanceAfter: '999999.00' }],
      }),
    ]);
    expect(metric(results, 0, 'closing_cash').components).not.toHaveProperty('statement_delta');
  });

  it('passes an unreconciled statement warning through to the period', () => {
    const results = computeCash(context(), [
      periodInput(0, movements, {
        openingCandidates: [statementOpening(CURRENT, '0.00'), statementOpening(SAVINGS, '0.00')],
        unreconciledStatement: true,
      }),
    ]);
    expect(metric(results, 0, 'closing_cash').dataQuality.warnings).toContain('unreconciled_statement');
  });
});

// ---------------------------------------------------------------------------------------------
// Coverage and completeness
// ---------------------------------------------------------------------------------------------

describe('bank coverage (§2.2, §5)', () => {
  it('flags partial coverage and reduces completeness proportionally', () => {
    const results = computeCash(context(), [
      periodInput(0, [], {
        coveredBankAccountIds: [CURRENT],
        openingCandidates: [statementOpening(CURRENT, '10.00'), statementOpening(SAVINGS, '0.00')],
      }),
    ]);
    const inflows = metric(results, 0, 'cash_inflows');
    expect(inflows.dataQuality.warnings).toContain('bank_coverage_partial');
    expect(inflows.dataQuality.completeness).toBe(0.5);
  });

  it('halves completeness again while opening cash is unknown', () => {
    const results = computeCash(context(), [periodInput(0, [])]);
    expect(metric(results, 0, 'cash_inflows').dataQuality.completeness).toBe(0.5);
    expect(metric(results, 0, 'closing_cash').dataQuality.completeness).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------------------------
// Runway
// ---------------------------------------------------------------------------------------------

describe('cash_runway_months (§3.3)', () => {
  function burning(monthlyOutflow: string, opening: string, months = 3): CashPeriodInput[] {
    return Array.from({ length: months }, (_, index) =>
      periodInput(index, [cell({ periodId: '', bankAccountId: CURRENT, outflow: monthlyOutflow })], {
        coveredBankAccountIds: [CURRENT],
        openingCandidates: index === 0 ? [statementOpening(CURRENT, opening)] : [],
      }),
    );
  }

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
      [
        periodInput(5, [cell({ periodId: '', bankAccountId: CURRENT, outflow: '1000.00' })], {
          coveredBankAccountIds: [CURRENT],
        }),
      ],
      {
        openingCarry: { value: '8000.00', basis: 'bank', assurance: 'verified', missing: [], coveredBankAccountIds: [CURRENT] },
        priorNetMovements: ['-1000.00', '-1000.00'],
      },
    );
    expect(metric(results, 0, 'cash_runway_months').value).toBe('7.000000');
  });

  it('refuses the window when the three periods are not consecutive months', () => {
    const results = computeCash(oneAccount, [
      periodInput(0, [cell({ periodId: '', bankAccountId: CURRENT, outflow: '100.00' })], {
        coveredBankAccountIds: [CURRENT],
        openingCandidates: [statementOpening(CURRENT, '900.00')],
      }),
      periodInput(1, [cell({ periodId: '', bankAccountId: CURRENT, outflow: '100.00' })], { coveredBankAccountIds: [CURRENT] }),
      periodInput(4, [cell({ periodId: '', bankAccountId: CURRENT, outflow: '100.00' })], { coveredBankAccountIds: [CURRENT] }),
    ]);
    expect(metric(results, 2, 'cash_runway_months').dataQuality.missing).toContain('insufficient_history');
  });

  it('is NULL with cash_positive when the business is not burning', () => {
    const results = computeCash(oneAccount, [
      periodInput(0, [cell({ periodId: '', bankAccountId: CURRENT, inflow: '500.00' })], {
        coveredBankAccountIds: [CURRENT],
        openingCandidates: [statementOpening(CURRENT, '1000.00')],
      }),
      periodInput(1, [cell({ periodId: '', bankAccountId: CURRENT, inflow: '500.00' })], { coveredBankAccountIds: [CURRENT] }),
      periodInput(2, [cell({ periodId: '', bankAccountId: CURRENT, inflow: '500.00' })], { coveredBankAccountIds: [CURRENT] }),
    ]);
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
    const results = computeCash(oneAccount, [
      periodInput(0, [cell({ periodId: '', bankAccountId: CURRENT, outflow: '100.00' })], { coveredBankAccountIds: [CURRENT] }),
      periodInput(1, [cell({ periodId: '', bankAccountId: CURRENT, outflow: '100.00' })], { coveredBankAccountIds: [CURRENT] }),
      periodInput(2, [cell({ periodId: '', bankAccountId: CURRENT, outflow: '100.00' })], { coveredBankAccountIds: [CURRENT] }),
    ]);
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
    periodInput(0, [cell({ periodId: '', bankAccountId: CURRENT, inflow: '10.00' })], {
      openingCandidates: [statementOpening(CURRENT, '0.00'), statementOpening(SAVINGS, '0.00')],
    }),
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
// Properties (§3.3)
// ---------------------------------------------------------------------------------------------

/** Build a random but valid multi-period organization from a seeded generator. */
function randomSeries(random: () => number): { inputs: CashPeriodInput[]; ctx: EngineContext } {
  const months = 3 + Math.floor(random() * 6);
  const inputs: CashPeriodInput[] = [];
  for (let index = 0; index < months; index += 1) {
    const movements: BankAggregateCell[] = [];
    const count = Math.floor(random() * 4);
    for (let i = 0; i < count; i += 1) {
      const onSavings = random() < 0.4;
      movements.push(
        cell({
          periodId: '',
          bankAccountId: onSavings ? SAVINGS : CURRENT,
          inflow: random() < 0.5 ? money(random) : '0.00',
          outflow: random() < 0.5 ? money(random) : '0.00',
        }),
      );
    }
    if (random() < 0.3) {
      const amount = money(random, 2000);
      movements.push(cell({ periodId: '', bankAccountId: CURRENT, outflow: amount, category: 'transfer', transferKind: 'cash_transfer' }));
      movements.push(cell({ periodId: '', bankAccountId: SAVINGS, inflow: amount, category: 'transfer', transferKind: 'cash_transfer' }));
    }
    inputs.push(
      periodInput(index, movements, {
        openingCandidates:
          index === 0
            ? [statementOpening(CURRENT, money(random, 20000)), statementOpening(SAVINGS, money(random, 20000))]
            : [],
      }),
    );
  }
  return { inputs, ctx: context() };
}

describe('the properties §3.3 names', () => {
  it('holds net_cash_movement = cash_inflows − cash_outflows over generated organisations', () => {
    const random = prng(20260905);
    for (let trial = 0; trial < 100; trial += 1) {
      const { inputs, ctx } = randomSeries(random);
      const results = computeCash(ctx, inputs);
      for (let index = 0; index < results.length; index += 1) {
        const inflows = parseDecimal(metric(results, index, 'cash_inflows').value ?? '0');
        const outflows = parseDecimal(metric(results, index, 'cash_outflows').value ?? '0');
        expect(metric(results, index, 'net_cash_movement').value).toBe(inflows.minus(outflows).toFixed(2));
      }
    }
  });

  it('holds closing_cash(P) = opening_cash(P+1) for consecutive covered periods', () => {
    const random = prng(4242);
    for (let trial = 0; trial < 100; trial += 1) {
      const { inputs, ctx } = randomSeries(random);
      const results = computeCash(ctx, inputs);
      for (let index = 0; index + 1 < results.length; index += 1) {
        expect(metric(results, index + 1, 'opening_cash').value).toBe(
          metric(results, index, 'closing_cash').value,
        );
      }
    }
  });

  it('holds closing_cash = opening_cash + net_cash_movement over generated organisations', () => {
    const random = prng(777);
    for (let trial = 0; trial < 100; trial += 1) {
      const { inputs, ctx } = randomSeries(random);
      const results = computeCash(ctx, inputs);
      for (let index = 0; index < results.length; index += 1) {
        const opening = metric(results, index, 'opening_cash').value;
        const net = metric(results, index, 'net_cash_movement').value ?? '0';
        const closing = metric(results, index, 'closing_cash').value;
        if (opening === null) {
          expect(closing).toBeNull();
          continue;
        }
        expect(closing).toBe(parseDecimal(opening).plus(parseDecimal(net)).toFixed(2));
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
        ], { openingCandidates: [statementOpening(CURRENT, '0.00'), statementOpening(SAVINGS, '0.00')] }),
      ]);
      const without = computeCash(context(), [
        periodInput(0, [cell({ periodId: '', bankAccountId: CURRENT, inflow: noise })], {
          openingCandidates: [statementOpening(CURRENT, '0.00'), statementOpening(SAVINGS, '0.00')],
        }),
      ]);
      expect(metric(withTransfer, 0, 'cash_inflows').value).toBe(metric(without, 0, 'cash_inflows').value);
      expect(metric(withTransfer, 0, 'cash_outflows').value).toBe(metric(without, 0, 'cash_outflows').value);
      expect(new Decimal(metric(withTransfer, 0, 'net_cash_movement').value ?? '0').toFixed(2)).toBe(noise);
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
        ], { coveredBankAccountIds: [CURRENT], openingCandidates: [statementOpening(CURRENT, '0.00')] }),
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
  const random = prng(11);
  const { inputs, ctx } = randomSeries(random);

  it('produces byte-identical results when run twice', () => {
    expect(JSON.stringify(computeCash(ctx, inputs))).toBe(JSON.stringify(computeCash(ctx, inputs)));
  });

  it('produces the same results whatever order the periods and cells arrive in', () => {
    const shuffled = [...inputs]
      .reverse()
      .map((input) => ({ ...input, movements: [...input.movements].reverse() }));
    expect(JSON.stringify(computeCash(ctx, shuffled))).toBe(JSON.stringify(computeCash(ctx, inputs)));
  });
});
