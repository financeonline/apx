import { describe, expect, it } from 'vitest';

import { Decimal, sum, toMoneyString } from '@/core/money';
import { STANDARD_CATEGORIES, type StandardCategory } from '@/modules/financials';
import {
  BALANCE_SHEET_SET,
  CASH_LIKE_BANK_ACCOUNT_TYPES,
  CASH_SET,
  EXPENSE_BY_CATEGORY_CATEGORIES,
  HOLDING_SET,
  NON_PNL,
  OPEX_CATEGORIES,
  OPEX_SET,
  BELOW_LINE,
  PNL_SET,
  categoryPartitionErrors,
  isCashLikeBankAccount,
  placementOf,
} from '@/modules/financial-engine';
import {
  computePnl,
  minAssurance,
  type AccountAmount,
  type PnlInput,
} from '@/modules/financial-engine';
import type {
  AccountRef, BasisChoice, EngineContext, MetricResult, PeriodRef,
} from '@/modules/financial-engine';

/**
 * FINANCIAL_ENGINE.md §3.1. The edge-case column of that table IS the specification, so every row
 * of it has a test below named after the behaviour it defends, alongside the property tests §3.1
 * requires.
 */

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

const RUN_ID = '11111111-0000-4000-8000-000000000001';
const AGGREGATED_AT = '2026-03-31T23:00:00.000Z';
const PERIOD_ID = '22222222-0000-4000-8000-000000000002';

const PERIOD: PeriodRef = {
  id: PERIOD_ID,
  periodStart: '2026-03-01',
  periodEnd: '2026-03-31',
  fiscalYear: 2026,
  fiscalQuarter: 1,
  label: 'Mar 2026',
  isComplete: true,
};

const CONTEXT: EngineContext = {
  organizationId: '33333333-0000-4000-8000-000000000003',
  calculationRunId: RUN_ID,
  aggregatedAt: AGGREGATED_AT,
  asOf: '2026-04-02',
  engineVersion: '1.0.0',
  settings: {
    baseCurrency: 'GBP',
    fiscalYearStartMonth: 1,
    timezone: 'Europe/London',
    vatRegistered: true,
    defaultVatRate: '0.20',
    taxableCategories: ['revenue', 'cost_of_sales', 'operating_expense', 'marketing'],
  },
  accounts: [],
  costOfSalesEverUsed: true,
  costOfSalesInInvoices: false,
  counterparties: [],
  bankAccounts: [],
  periods: [PERIOD],
};

const LEDGER_BASIS: BasisChoice = {
  basis: 'ledger', assurance: 'calculated', warnings: [], proxy: false,
};

const ACCOUNT_TYPE_OF: Readonly<Record<StandardCategory, AccountRef['accountType']>> = Object
  .fromEntries(STANDARD_CATEGORIES.map((c) => [c, categoryType(c)])) as Readonly<
    Record<StandardCategory, AccountRef['accountType']>
  >;

function categoryType(category: StandardCategory): AccountRef['accountType'] {
  if (PNL_SET.has(category)) {
    return category === 'revenue' || category === 'other_income' ? 'income' : 'expense';
  }
  if (category === 'equity' || category === 'drawings') return 'equity';
  if (BALANCE_SHEET_SET.has(category)) {
    return ['payables', 'credit_card', 'loan', 'tax_liability', 'other_current_liability',
      'long_term_liability'].includes(category) ? 'liability' : 'asset';
  }
  return 'asset';
}

function accountRef(id: string, category: StandardCategory, isSystem = false): AccountRef {
  return {
    id, code: id.toUpperCase(), name: `${category} ${id}`,
    standardCategory: category, accountType: ACCOUNT_TYPE_OF[category], isSystem,
  };
}

/** A scenario expressed as `category -> amount`, one account per category, ids fixed for order. */
function scenario(
  amounts: Partial<Record<StandardCategory, string>>,
  over: Partial<PnlInput> = {},
): PnlInput {
  const entries = STANDARD_CATEGORIES
    .filter((c) => amounts[c] !== undefined)
    .map((c) => ({ category: c, accountId: `acc-${c}`, amount: amounts[c] as string }));
  const accounts = entries.map((e) => accountRef(e.accountId, e.category));
  const accountAmounts: AccountAmount[] = entries.map((e) => ({
    accountId: e.accountId, category: e.category, amount: e.amount, rowCount: 1,
  }));
  return {
    period: PERIOD,
    basis: LEDGER_BASIS,
    currency: 'GBP',
    accounts,
    // Derived from the scenario: an organisation that posts cost of sales in the month plainly
    // tracks it. The cases that matter — a chart with the system account only, and a month that is
    // simply quiet — set this explicitly (§3.1, ADR-063).
    costOfSalesEverUsed: amounts.cost_of_sales !== undefined,
    accountAmounts,
    uncategorised: { absoluteAmount: '0.00', totalAbsoluteAmount: totalAbs(accountAmounts) },
    ...over,
  };
}

function totalAbs(amounts: readonly AccountAmount[]): string {
  return toMoneyString(
    sum(amounts.filter((a) => a.amount !== null).map((a) => new Decimal(a.amount as string).abs())),
  );
}

const resolver = (key: string, dimensionId: string | null): string =>
  `snap:${key}:${dimensionId ?? '-'}`;

function run(input: PnlInput): readonly MetricResult[] {
  return computePnl(input, CONTEXT, resolver);
}

/**
 * Finds a result by key and dimension.
 *
 * A dimension is identified by `dimensionId` when it is a row (an account, a counterparty) and by
 * `dimensionKey` when it is not (a standard category has no row to point at, and `dimension_id` is
 * a uuid column — ADR-053). The helper accepts either so a caller can name a category or an account
 * without knowing which column carries it.
 */
function matches(r: MetricResult, key: string, dimension: string | null): boolean {
  if (r.key !== key) return false;
  const identity = r.dimensionId ?? r.dimensionKey ?? null;
  return identity === dimension;
}

function pick(results: readonly MetricResult[], key: string, dimension: string | null = null) {
  const found = results.find((r) => matches(r, key, dimension));
  if (found === undefined) throw new Error(`no result for ${key}/${dimension ?? '-'}`);
  return found;
}

function maybe(results: readonly MetricResult[], key: string, dimension: string | null = null) {
  return results.find((r) => matches(r, key, dimension));
}

const FULL_MONTH: Partial<Record<StandardCategory, string>> = {
  revenue: '10000.00',
  other_income: '200.00',
  cost_of_sales: '4000.00',
  operating_expense: '1000.00',
  payroll: '2000.00',
  marketing: '500.00',
  depreciation: '100.00',
  other_expense: '50.00',
  interest_expense: '30.00',
  tax_expense: '120.00',
};

// ---------------------------------------------------------------------------------------------
// Category sets (§3)
// ---------------------------------------------------------------------------------------------

describe('the category sets (§3)', () => {
  it('places every standard category in exactly one part of the partition', () => {
    // A 27th category added later would otherwise vanish from every statement silently.
    expect(categoryPartitionErrors()).toEqual([]);
  });

  it('accounts for all 26 categories across the three parts', () => {
    expect(PNL_SET.size + BALANCE_SHEET_SET.size + HOLDING_SET.size).toBe(STANDARD_CATEGORIES.length);
  });

  it('names the four operating-expense categories and keeps cost of sales out', () => {
    expect([...OPEX_SET].sort()).toEqual(['depreciation', 'marketing', 'operating_expense', 'payroll']);
    expect(OPEX_SET.has('cost_of_sales')).toBe(false);
  });

  it('names the four below-the-line categories', () => {
    expect([...BELOW_LINE].sort())
      .toEqual(['interest_expense', 'other_expense', 'other_income', 'tax_expense']);
  });

  it('treats only current and savings accounts as cash', () => {
    expect([...CASH_LIKE_BANK_ACCOUNT_TYPES].sort()).toEqual(['current', 'savings']);
    expect(isCashLikeBankAccount('credit_card')).toBe(false);
    expect(isCashLikeBankAccount('savings')).toBe(true);
    expect(CASH_SET.has('cash')).toBe(true);
  });

  it('keeps every non-P&L category off the P&L, and vice versa', () => {
    for (const category of STANDARD_CATEGORIES) {
      expect(NON_PNL.has(category), category).toBe(!PNL_SET.has(category));
    }
    expect(placementOf('transfer')).toBe('holding');
    expect(placementOf('cash')).toBe('balance_sheet');
    expect(placementOf('revenue')).toBe('pnl');
  });

  it('builds expense_by_category from opex, below-the-line and cost of sales', () => {
    expect([...EXPENSE_BY_CATEGORY_CATEGORIES].sort()).toEqual([
      'cost_of_sales', 'depreciation', 'interest_expense', 'marketing', 'operating_expense',
      'other_expense', 'other_income', 'payroll', 'tax_expense',
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// The ordinary month
// ---------------------------------------------------------------------------------------------

describe('a complete month on the ledger basis (§3.1)', () => {
  const results = run(scenario(FULL_MONTH));

  it('computes the whole statement', () => {
    expect(pick(results, 'revenue').value).toBe('10000.00');
    expect(pick(results, 'other_income').value).toBe('200.00');
    expect(pick(results, 'cost_of_sales').value).toBe('4000.00');
    expect(pick(results, 'gross_profit').value).toBe('6000.00');
    expect(pick(results, 'gross_margin').value).toBe('0.600000');
    expect(pick(results, 'operating_expenses').value).toBe('3600.00');
    expect(pick(results, 'operating_profit').value).toBe('2400.00');
    expect(pick(results, 'operating_margin').value).toBe('0.240000');
    expect(pick(results, 'other_expense').value).toBe('50.00');
    expect(pick(results, 'interest_expense').value).toBe('30.00');
    expect(pick(results, 'tax_expense').value).toBe('120.00');
    expect(pick(results, 'net_profit').value).toBe('2400.00');
    expect(pick(results, 'net_margin').value).toBe('0.240000');
    expect(pick(results, 'contribution_margin').value).toBe('5500.00');
    expect(pick(results, 'contribution_margin_ratio').value).toBe('0.550000');
  });

  it('carries every named input in components so a reader can redo the arithmetic', () => {
    expect(pick(results, 'gross_profit').components)
      .toEqual({ revenue: '10000.00', cost_of_sales: '4000.00' });
    expect(pick(results, 'net_profit').components).toEqual({
      operating_profit: '2400.00', other_income: '200.00', other_expense: '50.00',
      interest_expense: '30.00', tax_expense: '120.00',
    });
  });

  it('gives leaf metrics a descriptor of concrete account ids, never a category name (ADR-034)', () => {
    const revenue = pick(results, 'revenue');
    expect(revenue.evidenceQuery).toEqual({
      kind: 'leaf',
      descriptor: {
        v: 1,
        table: 'ledger_entries',
        filters: { period_ids: [PERIOD_ID], account_ids: ['acc-revenue'] },
        as_of: { calculation_run_id: RUN_ID, aggregated_at: AGGREGATED_AT },
      },
    });
    expect(JSON.stringify(revenue.evidenceQuery)).not.toContain('standard_categor');
  });

  it('gives derived metrics component snapshot ids to descend into', () => {
    expect(pick(results, 'operating_profit').evidenceQuery).toEqual({
      kind: 'derived',
      components: [
        { name: 'gross_profit', snapshot_id: 'snap:gross_profit:-' },
        { name: 'operating_expenses', snapshot_id: 'snap:operating_expenses:-' },
      ],
    });
  });

  it('marks money metrics with the currency and ratio metrics without one', () => {
    expect(pick(results, 'revenue').currency).toBe('GBP');
    expect(pick(results, 'gross_margin').currency).toBeNull();
    expect(pick(results, 'gross_margin').unit).toBe('ratio');
  });

  it('writes one expense_by_category snapshot per category that has rows', () => {
    expect(pick(results, 'expense_by_category', 'marketing').value).toBe('500.00');
    expect(pick(results, 'expense_by_category', 'marketing').dimensionType).toBe('standard_category');
    expect(maybe(results, 'expense_by_category', 'inventory')).toBeUndefined();
  });

  it('writes one expense_by_account snapshot per expense-type account', () => {
    expect(pick(results, 'expense_by_account', 'acc-payroll').value).toBe('2000.00');
    // other_income is an income account: it never appears in an expense breakdown by account.
    expect(maybe(results, 'expense_by_account', 'acc-other_income')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------
// The edge cases (§3.1), one test each
// ---------------------------------------------------------------------------------------------

describe('negative revenue is a real month, not an error (§3.1)', () => {
  const results = run(scenario({ ...FULL_MONTH, revenue: '-2000.00' }));

  it('reports the negative figure with a warning rather than clamping it', () => {
    expect(pick(results, 'revenue').value).toBe('-2000.00');
    expect(pick(results, 'revenue').dataQuality.warnings).toContain('negative_revenue');
  });

  it('refuses every margin over it, because the ratio would read as healthy', () => {
    for (const key of ['gross_margin', 'operating_margin', 'net_margin', 'contribution_margin_ratio']) {
      expect(pick(results, key).value, key).toBeNull();
      expect(pick(results, key).dataQuality.warnings, key).toContain('negative_revenue');
    }
  });
});

describe('uncategorised amounts (§3.1)', () => {
  it('leaves a small share alone', () => {
    const results = run(scenario(FULL_MONTH, {
      uncategorised: { absoluteAmount: '400.00', totalAbsoluteAmount: '18400.00' },
    }));
    expect(pick(results, 'revenue').dataQuality.warnings).not.toContain('uncategorised_amounts');
    expect(pick(results, 'revenue').assurance).toBe('calculated');
  });

  it('warns and reduces completeness past 5% of |revenue|', () => {
    const results = run(scenario(FULL_MONTH, {
      uncategorised: { absoluteAmount: '1000.00', totalAbsoluteAmount: '19000.00' },
    }));
    const revenue = pick(results, 'revenue');
    expect(revenue.dataQuality.warnings).toContain('uncategorised_amounts');
    expect(revenue.dataQuality.completeness).toBeCloseTo(1 - 1000 / 19000, 10);
    expect(revenue.value).toBe('10000.00');
    expect(revenue.assurance).toBe('calculated');
  });

  it('still writes the value past 25%, but only as an estimate', () => {
    const results = run(scenario(FULL_MONTH, {
      uncategorised: { absoluteAmount: '4000.00', totalAbsoluteAmount: '22000.00' },
    }));
    const revenue = pick(results, 'revenue');
    expect(revenue.value).toBe('10000.00');
    expect(revenue.assurance).toBe('estimated');
    expect(revenue.dataQuality.missing).toContain('uncategorised_amounts_exceed_threshold');
  });

  it('treats any unexplained money against zero revenue as exceeding every threshold', () => {
    const results = run(scenario({ revenue: '0.00', operating_expense: '500.00' }, {
      uncategorised: { absoluteAmount: '500.00', totalAbsoluteAmount: '1000.00' },
    }));
    expect(pick(results, 'revenue').assurance).toBe('estimated');
    expect(pick(results, 'revenue').dataQuality.missing)
      .toContain('uncategorised_amounts_exceed_threshold');
  });
});

describe('an organization with no cost-of-sales account at all (CD-05, §3.1)', () => {
  const base = scenario({ revenue: '10000.00', marketing: '500.00', payroll: '2000.00' });
  const results = run(base);

  it('reports cost of sales as unknown, not as zero', () => {
    const cos = pick(results, 'cost_of_sales');
    expect(cos.value).toBeNull();
    expect(cos.dataQuality.missing).toEqual(['no_cost_of_sales_accounts']);
  });

  it('reports gross profit as revenue, with a warning that the line is missing', () => {
    const gp = pick(results, 'gross_profit');
    expect(gp.value).toBe('10000.00');
    expect(gp.dataQuality.warnings).toContain('no_cost_of_sales');
    expect(gp.dataQuality.missing).not.toContain('no_cost_of_sales_accounts');
  });

  it('shows gross margin as n/a and NEVER as 100%', () => {
    const gm = pick(results, 'gross_margin');
    expect(gm.value).toBeNull();
    expect(gm.dataQuality.missing).toEqual(['no_cost_of_sales_accounts']);
  });

  it('still computes operating profit and its margin', () => {
    expect(pick(results, 'operating_profit').value).toBe('7500.00');
    expect(pick(results, 'operating_margin').value).toBe('0.750000');
  });

  it('treats the missing cost line as zero in the contribution margin, with the same warning', () => {
    const cm = pick(results, 'contribution_margin');
    expect(cm.value).toBe('9500.00');
    expect(cm.dataQuality.warnings).toContain('no_cost_of_sales');
  });

  it('counts a seeded system account only once the organisation has ever used it', () => {
    const withSystemOnly: PnlInput = {
      ...base,
      accounts: [...base.accounts, accountRef('acc-cos-system', 'cost_of_sales', true)],
      costOfSalesEverUsed: false,
    };
    expect(pick(run(withSystemOnly), 'cost_of_sales').value).toBeNull();

    const systemUsed: PnlInput = {
      ...withSystemOnly,
      costOfSalesEverUsed: true,
      accountAmounts: [...base.accountAmounts, {
        accountId: 'acc-cos-system', category: 'cost_of_sales', amount: '1200.00', rowCount: 3,
      }],
    };
    expect(pick(run(systemUsed), 'cost_of_sales').value).toBe('1200.00');
    expect(pick(run(systemUsed), 'gross_margin').value).toBe('0.880000');
  });

  /*
   * The regression this rule was rewritten for (ADR-063).
   *
   * A shop that bought no stock in August has not stopped tracking cost of sales — it had a quiet
   * month. Asking the question of the period made the engine say the opposite: cost of sales
   * unknown, gross profit silently equal to revenue with a warning, and gross margin "n/a" for a
   * month it could state exactly. CD-05's exception describes a chart, not a month.
   */
  it('reports a quiet month as zero, not as an organisation that does not track cost of sales', () => {
    const quietMonth: PnlInput = {
      ...base,
      accounts: [...base.accounts, accountRef('acc-cos-system', 'cost_of_sales', true)],
      costOfSalesEverUsed: true,
    };
    const results = run(quietMonth);

    expect(pick(results, 'cost_of_sales').value, 'a known zero, not unknown').toBe('0.00');
    expect(pick(results, 'cost_of_sales').dataQuality.missing).not.toContain('no_cost_of_sales_accounts');
    expect(pick(results, 'gross_profit').value).toBe('10000.00');
    expect(pick(results, 'gross_profit').dataQuality.warnings).not.toContain('no_cost_of_sales');
    expect(pick(results, 'gross_margin').value, 'and a margin it can state exactly').toBe('1.000000');
  });
});

describe('zero and missing revenue under a margin (§3.1)', () => {
  it('refuses every margin when revenue is zero', () => {
    const results = run(scenario({ revenue: '0.00', cost_of_sales: '500.00' }));
    for (const key of ['gross_margin', 'operating_margin', 'net_margin', 'contribution_margin_ratio']) {
      expect(pick(results, key).value, key).toBeNull();
      expect(pick(results, key).dataQuality.missing, key).toContain('comparison_is_zero');
    }
  });

  it('refuses every margin when revenue itself could not be computed', () => {
    const input = scenario({ revenue: '0.00', cost_of_sales: '500.00' });
    const withNullRevenue: PnlInput = {
      ...input,
      accountAmounts: input.accountAmounts.map((a) => a.category === 'revenue'
        ? { ...a, amount: null, missing: ['no_prior_trial_balance' as const] }
        : a),
    };
    const results = run(withNullRevenue);
    expect(pick(results, 'revenue').value).toBeNull();
    expect(pick(results, 'revenue').dataQuality.missing).toContain('no_prior_trial_balance');
    expect(pick(results, 'gross_profit').value).toBeNull();
    expect(pick(results, 'gross_margin').value).toBeNull();
    expect(pick(results, 'net_profit').value).toBeNull();
  });
});

describe('zero rows (§3.1)', () => {
  const results = run(scenario({ revenue: '10000.00', cost_of_sales: '4000.00' }));

  it('writes the below-the-line lines as a known zero when the source covers the period', () => {
    // A covered trial balance with no interest line means zero interest, not unknown interest.
    expect(pick(results, 'other_expense').value).toBe('0.00');
    expect(pick(results, 'interest_expense').value).toBe('0.00');
    expect(pick(results, 'tax_expense').value).toBe('0.00');
  });

  it('does NOT write a dimensioned snapshot for a category with no rows', () => {
    for (const category of EXPENSE_BY_CATEGORY_CATEGORIES) {
      const written = maybe(results, 'expense_by_category', category) !== undefined;
      expect(written, category).toBe(category === 'cost_of_sales');
    }
  });

  it('writes every P&L metric as NULL when nothing covers the period', () => {
    const none = run(scenario(FULL_MONTH, {
      basis: { basis: 'none', assurance: 'calculated', warnings: [], proxy: false },
    }));
    expect(none).toHaveLength(15);
    for (const result of none) {
      expect(result.value, result.key).toBeNull();
      expect(result.dataQuality.missing, result.key).toEqual(['no_source_covers_period']);
      expect(result.evidenceQuery, result.key).toBeNull();
    }
  });
});

describe('expense_by_account is only written where accounts exist (§3.1)', () => {
  it('writes per account on the ledger and period-balances bases', () => {
    for (const basis of ['ledger', 'period_balances'] as const) {
      const results = run(scenario(FULL_MONTH, {
        basis: { basis, assurance: 'verified', warnings: [], proxy: false },
      }));
      expect(maybe(results, 'expense_by_account', 'acc-marketing')?.value, basis).toBe('500.00');
    }
  });

  it('writes per category only on the bank basis, where there is no nominal account', () => {
    const results = run(scenario(FULL_MONTH, {
      basis: {
        basis: 'bank', assurance: 'estimated', proxy: true,
        warnings: ['cash_basis_proxy', 'vat_inclusive'],
      },
    }));
    expect(results.some((r) => r.key === 'expense_by_account')).toBe(false);
    expect(pick(results, 'expense_by_category', 'marketing').value).toBe('500.00');
    expect(pick(results, 'revenue').dataQuality.proxy).toBe(true);
    expect(pick(results, 'revenue').dataQuality.warnings).toContain('cash_basis_proxy');
    expect(pick(results, 'net_profit').dataQuality.warnings).toContain('cash_basis_proxy');
  });

  it('points a bank-basis descriptor at category accounts, not at nominal accounts', () => {
    const results = run(scenario(FULL_MONTH, {
      basis: { basis: 'bank', assurance: 'estimated', warnings: [], proxy: true },
    }));
    expect(pick(results, 'revenue').evidenceQuery).toEqual({
      kind: 'leaf',
      descriptor: {
        v: 1,
        table: 'bank_transactions',
        // The side of the statement revenue counts, and no transfer of any kind (§4.4, ADR-110).
        filters: {
          period_ids: [PERIOD_ID], category_account_ids: ['acc-revenue'], direction: 'inflow', exclude_transfers: 'all',
        },
        as_of: { calculation_run_id: RUN_ID, aggregated_at: AGGREGATED_AT },
      },
    });
  });

  it('points an invoice-basis descriptor at invoice types, and an expense figure at its suppliers (ADR-104)', () => {
    const results = run(scenario(FULL_MONTH, {
      basis: { basis: 'invoices', assurance: 'verified', warnings: [], proxy: false },
      // An invoice has no account, so an expense figure is scoped by the suppliers that make it up.
      invoiceCounterparties: new Map([['cost_of_sales', ['00000000-0000-4000-8000-000000000501']]]),
    }));
    const descriptor = pick(results, 'revenue').evidenceQuery;
    expect(descriptor).toEqual({
      kind: 'leaf',
      descriptor: {
        v: 1,
        table: 'invoices',
        filters: { period_ids: [PERIOD_ID], invoice_types: ['sales', 'sales_credit_note'] },
        as_of: { calculation_run_id: RUN_ID, aggregated_at: AGGREGATED_AT },
      },
    });
    expect(pick(results, 'cost_of_sales').evidenceQuery).toMatchObject({
      descriptor: { filters: {
        invoice_types: ['purchase', 'purchase_credit_note'],
        counterparty_ids: ['00000000-0000-4000-8000-000000000501'],
      } },
    });
    // A figure no supplier's purchases went into gets no descriptor rather than every purchase.
    const withoutSuppliers = run(scenario(FULL_MONTH, {
      basis: { basis: 'invoices', assurance: 'verified', warnings: [], proxy: false },
    }));
    expect(pick(withoutSuppliers, 'cost_of_sales').evidenceQuery).toBeNull();
  });
});

describe('the VAT fallback on the invoice basis (§3)', () => {
  const invoiceBasis: BasisChoice = {
    basis: 'invoices', assurance: 'verified', warnings: [], proxy: false,
  };

  it('flags vat_inclusive from a single fallback row', () => {
    const results = run(scenario(FULL_MONTH, {
      basis: invoiceBasis, invoiceVat: { contributingRows: 40, fallbackRows: 1 },
    }));
    expect(pick(results, 'revenue').dataQuality.warnings).toContain('vat_inclusive');
    expect(pick(results, 'revenue').assurance).toBe('verified');
  });

  it('downgrades revenue to an estimate once the fallback share passes 10%', () => {
    const results = run(scenario(FULL_MONTH, {
      basis: invoiceBasis, invoiceVat: { contributingRows: 10, fallbackRows: 2 },
    }));
    expect(pick(results, 'revenue').assurance).toBe('estimated');
  });

  it('does nothing when no row fell back', () => {
    const results = run(scenario(FULL_MONTH, {
      basis: invoiceBasis, invoiceVat: { contributingRows: 10, fallbackRows: 0 },
    }));
    expect(pick(results, 'revenue').dataQuality.warnings).not.toContain('vat_inclusive');
  });
});

describe('a cumulative trial balance with no pinned predecessor (§3, ADR-047.4)', () => {
  it('propagates the NULL and its reason through every metric that depends on it', () => {
    const input = scenario(FULL_MONTH);
    const broken: PnlInput = {
      ...input,
      basis: { basis: 'period_balances', assurance: 'verified', warnings: [], proxy: false },
      accountAmounts: input.accountAmounts.map((a) => a.category === 'marketing'
        ? { ...a, amount: null, missing: ['no_prior_trial_balance' as const] }
        : a),
    };
    const results = run(broken);
    expect(pick(results, 'operating_expenses').value).toBeNull();
    expect(pick(results, 'operating_expenses').dataQuality.missing)
      .toContain('no_prior_trial_balance');
    expect(pick(results, 'operating_profit').value).toBeNull();
    expect(pick(results, 'net_profit').value).toBeNull();
    // Revenue is untouched: one broken account does not invalidate the whole statement.
    expect(pick(results, 'revenue').value).toBe('10000.00');
    expect(pick(results, 'expense_by_category', 'marketing').value).toBeNull();
    expect(pick(results, 'expense_by_account', 'acc-marketing').value).toBeNull();
  });

  it('carries an account_absent_prior note alongside a real value', () => {
    const input = scenario(FULL_MONTH);
    const noted: PnlInput = {
      ...input,
      accountAmounts: input.accountAmounts.map((a) => a.category === 'payroll'
        ? { ...a, warnings: ['account_absent_prior' as const] }
        : a),
    };
    const results = run(noted);
    expect(pick(results, 'operating_expenses').value).toBe('3600.00');
    expect(pick(results, 'operating_expenses').dataQuality.warnings)
      .toContain('account_absent_prior');
  });
});

describe('assurance', () => {
  it('takes the weakest of two levels', () => {
    expect(minAssurance('verified', 'estimated')).toBe('estimated');
    expect(minAssurance('inferred', 'calculated')).toBe('inferred');
    expect(minAssurance('verified', 'verified')).toBe('verified');
    expect(minAssurance('calculated', 'verified')).toBe('calculated');
  });

  it('never lets a derived figure look firmer than its softest input', () => {
    const input = scenario(FULL_MONTH, {
      basis: { basis: 'ledger', assurance: 'calculated', warnings: [], proxy: false },
      uncategorised: { absoluteAmount: '5000.00', totalAbsoluteAmount: '23000.00' },
    });
    const results = run(input);
    expect(pick(results, 'revenue').assurance).toBe('estimated');
    expect(pick(results, 'gross_profit').assurance).toBe('estimated');
    expect(pick(results, 'net_profit').assurance).toBe('estimated');
  });
});

describe('inputs at the edge of what a caller can hand over', () => {
  it('rejects a broken partition, naming every category that is misplaced', () => {
    const broken = categoryPartitionErrors({
      // `revenue` is in two parts and `payroll` is in none; `cash` has been dragged onto the P&L.
      pnl: new Set<StandardCategory>([...PNL_SET, 'cash']),
      balanceSheet: new Set<StandardCategory>([...BALANCE_SHEET_SET, 'revenue']),
      holding: HOLDING_SET,
    });
    expect(broken.some((e) => e.startsWith('revenue appears in 2 sets'))).toBe(true);
    expect(broken.some((e) => e.startsWith('cash appears in 2 sets'))).toBe(true);
    expect(broken.some((e) => e === 'cash is a P&L category no P&L metric sums')).toBe(true);
    expect(broken.some((e) => e.startsWith('cash is typed asset'))).toBe(true);
  });

  it('reports a category dropped from every part', () => {
    const broken = categoryPartitionErrors({
      pnl: new Set([...PNL_SET].filter((c) => c !== 'payroll')),
      balanceSheet: BALANCE_SHEET_SET,
      holding: HOLDING_SET,
    });
    expect(broken).toContain('payroll appears in 0 sets (none)');
  });

  it('floors completeness at zero when more is uncategorised than the period holds', () => {
    const results = run(scenario(FULL_MONTH, {
      uncategorised: { absoluteAmount: '99000.00', totalAbsoluteAmount: '18000.00' },
    }));
    expect(pick(results, 'revenue').dataQuality.completeness).toBe(0);
  });

  it('treats a period with no amounts at all as fully complete', () => {
    const results = run(scenario({ revenue: '0.00' }, {
      uncategorised: { absoluteAmount: '0.00', totalAbsoluteAmount: '0.00' },
    }));
    expect(pick(results, 'revenue').dataQuality.completeness).toBe(1);
    expect(pick(results, 'revenue').dataQuality.warnings).not.toContain('uncategorised_amounts');
  });

  it('writes no descriptor when the family basis is mixed, because there is nothing single to re-select', () => {
    const results = run(scenario(FULL_MONTH, {
      basis: { basis: 'mixed', assurance: 'calculated', warnings: [], proxy: false },
    }));
    expect(pick(results, 'revenue').evidenceQuery).toBeNull();
    expect(pick(results, 'revenue').value).toBe('10000.00');
  });

  it('states a reason even when an uncomputable amount arrived without one', () => {
    const input = scenario(FULL_MONTH);
    const silent: PnlInput = {
      ...input,
      accountAmounts: input.accountAmounts.map((a) => a.category === 'marketing'
        ? { ...a, amount: null } : a),
    };
    const results = run(silent);
    expect(pick(results, 'operating_expenses').dataQuality.missing)
      .toContain('no_source_covers_period');
    expect(pick(results, 'expense_by_account', 'acc-marketing').dataQuality.missing)
      .toEqual(['no_source_covers_period']);
  });

  it('keeps an amount whose account is not in the chart of accounts', () => {
    const input = scenario({ revenue: '5000.00' });
    const orphaned: PnlInput = {
      ...input,
      accountAmounts: [...input.accountAmounts, {
        accountId: 'acc-orphan', category: 'payroll', amount: '750.00', rowCount: 2,
      }],
    };
    const results = run(orphaned);
    expect(pick(results, 'operating_expenses').value).toBe('750.00');
    expect(pick(results, 'expense_by_account', 'acc-orphan').value).toBe('750.00');
    // With no AccountRef there is no resolved id list, so the descriptor selects nothing rather
    // than selecting everything.
    expect(pick(results, 'expense_by_category', 'payroll').evidenceQuery)
      .toMatchObject({ descriptor: { filters: { account_ids: [] } } });
  });

  it('sums several rows for one account and orders them the same way whatever order they arrive in', () => {
    const base = scenario({ revenue: '5000.00' });
    const rows: AccountAmount[] = [
      { accountId: 'acc-b', category: 'payroll', amount: '100.00', rowCount: 1 },
      { accountId: 'acc-a', category: 'payroll', amount: '200.00', rowCount: 1 },
      { accountId: 'acc-a', category: 'payroll', amount: '300.00', rowCount: 1 },
    ];
    const withRows: PnlInput = {
      ...base,
      accounts: [...base.accounts, accountRef('acc-a', 'payroll'), accountRef('acc-b', 'payroll')],
      accountAmounts: [...base.accountAmounts, ...rows],
    };
    const forwards = run(withRows);
    const backwards = run({ ...withRows, accountAmounts: [...withRows.accountAmounts].reverse() });
    expect(pick(forwards, 'expense_by_account', 'acc-a').value).toBe('500.00');
    expect(pick(forwards, 'operating_expenses').value).toBe('600.00');
    expect(JSON.stringify(backwards)).toBe(JSON.stringify(forwards));
  });

  it('refuses gross profit when cost of sales exists but could not be computed', () => {
    const input = scenario({ revenue: '10000.00', cost_of_sales: '4000.00' });
    const broken: PnlInput = {
      ...input,
      accountAmounts: input.accountAmounts.map((a) => a.category === 'cost_of_sales'
        ? { ...a, amount: null, missing: ['no_prior_trial_balance' as const] } : a),
    };
    const results = run(broken);
    expect(pick(results, 'cost_of_sales').value).toBeNull();
    // Distinct from the CD-05 case: here the line exists and is simply unknown, so gross profit
    // must NOT quietly become revenue.
    expect(pick(results, 'gross_profit').value).toBeNull();
    expect(pick(results, 'gross_profit').dataQuality.warnings).not.toContain('no_cost_of_sales');
    expect(pick(results, 'gross_margin').value).toBeNull();
    expect(pick(results, 'contribution_margin').value).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// Property tests (§3.1, "Property tests")
// ---------------------------------------------------------------------------------------------

/**
 * A seeded generator, not a random one.
 *
 * The engine's contract is that the same inputs give byte-identical output, and a test suite that
 * cannot be replayed exactly cannot check that. `mulberry32` is deterministic, so a failure here is
 * reproducible from the seed printed in the case name.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Whole pence, so the generated figures are exactly representable at 2 dp. */
function pence(rng: () => number, min: number, max: number): string {
  const cents = Math.floor(min * 100 + rng() * (max - min) * 100);
  return (cents / 100).toFixed(2);
}

interface GeneratedCase {
  readonly input: PnlInput;
  readonly seed: number;
}

/** A statement with several accounts per category, so per-account sums have something to sum. */
function generateCase(seed: number): GeneratedCase {
  const rng = mulberry32(seed);
  const categories: StandardCategory[] = [
    'revenue', 'other_income', 'cost_of_sales', 'operating_expense', 'payroll', 'marketing',
    'depreciation', 'other_expense', 'interest_expense', 'tax_expense',
  ];
  const accounts: AccountRef[] = [];
  const accountAmounts: AccountAmount[] = [];
  for (const category of categories) {
    // Some categories are simply absent in a given month; that is the "absence ≠ zero" case.
    if (rng() < 0.15) continue;
    const howMany = 1 + Math.floor(rng() * 3);
    for (let i = 0; i < howMany; i += 1) {
      const accountId = `gen-${category}-${i}`;
      accounts.push(accountRef(accountId, category));
      accountAmounts.push({
        accountId,
        category,
        amount: pence(rng, category === 'revenue' ? -2000 : 0, 5000),
        rowCount: 1 + Math.floor(rng() * 20),
      });
    }
  }
  return {
    seed,
    input: {
      period: PERIOD,
      basis: LEDGER_BASIS,
      currency: 'GBP',
      accounts,
      costOfSalesEverUsed: true,
      accountAmounts,
      uncategorised: { absoluteAmount: '0.00', totalAbsoluteAmount: totalAbs(accountAmounts) },
    },
  };
}

const CASES = Array.from({ length: 120 }, (_, i) => generateCase(1000 + i));

function decimalOf(result: MetricResult): Decimal | null {
  return result.value === null ? null : new Decimal(result.value);
}

describe('property: the statement identities hold for generated months (§3.1)', () => {
  it('gross_profit = revenue − cost_of_sales whenever both are non-null', () => {
    for (const { input, seed } of CASES) {
      const results = run(input);
      const revenue = decimalOf(pick(results, 'revenue'));
      const cos = decimalOf(pick(results, 'cost_of_sales'));
      const gp = decimalOf(pick(results, 'gross_profit'));
      if (revenue === null || cos === null) continue;
      expect(gp?.toFixed(2), `seed ${seed}`).toBe(revenue.minus(cos).toFixed(2));
    }
  });

  it('operating_profit = gross_profit − operating_expenses', () => {
    for (const { input, seed } of CASES) {
      const results = run(input);
      const gp = decimalOf(pick(results, 'gross_profit'));
      const opex = decimalOf(pick(results, 'operating_expenses'));
      const op = decimalOf(pick(results, 'operating_profit'));
      if (gp === null || opex === null) continue;
      expect(op?.toFixed(2), `seed ${seed}`).toBe(gp.minus(opex).toFixed(2));
    }
  });

  it('net_profit = operating_profit + other_income − other_expense − interest − tax', () => {
    for (const { input, seed } of CASES) {
      const results = run(input);
      const parts = ['operating_profit', 'other_income', 'other_expense', 'interest_expense', 'tax_expense']
        .map((key) => decimalOf(pick(results, key)));
      if (parts.some((p) => p === null)) continue;
      // `noUncheckedIndexedAccess` types an array element as possibly undefined, so index
      // explicitly after the null guard rather than destructuring.
      const [op, oi, oe, ie, te] = parts as [Decimal, Decimal, Decimal, Decimal, Decimal];
      const expected = op.plus(oi).minus(oe).minus(ie).minus(te);
      expect(decimalOf(pick(results, 'net_profit'))?.toFixed(2), `seed ${seed}`)
        .toBe(expected.toFixed(2));
    }
  });

  it('Σ expense_by_category over OPEX_SET = operating_expenses', () => {
    for (const { input, seed } of CASES) {
      const results = run(input);
      const opex = decimalOf(pick(results, 'operating_expenses'));
      if (opex === null) continue;
      const parts = OPEX_CATEGORIES
        .map((c) => maybe(results, 'expense_by_category', c))
        .filter((r): r is MetricResult => r !== undefined)
        .map((r) => decimalOf(r));
      if (parts.some((p) => p === null)) continue;
      const total = sum(parts as Decimal[]);
      expect(total.toFixed(2), `seed ${seed}`).toBe(opex.toFixed(2));
    }
  });

  it('Σ expense_by_account for the accounts of category c = expense_by_category[c]', () => {
    for (const { input, seed } of CASES) {
      const results = run(input);
      for (const category of EXPENSE_BY_CATEGORY_CATEGORIES) {
        const byCategory = maybe(results, 'expense_by_category', category);
        if (byCategory === undefined || byCategory.value === null) continue;
        const accountIds = input.accounts
          .filter((a) => a.standardCategory === category && a.accountType === 'expense')
          .map((a) => a.id);
        if (accountIds.length === 0) continue;
        const parts = accountIds.map((id) => decimalOf(pick(results, 'expense_by_account', id)));
        expect(sum(parts as Decimal[]).toFixed(2), `seed ${seed} / ${category}`)
          .toBe(new Decimal(byCategory.value).toFixed(2));
      }
    }
  });

  it('margins equal their numerator over revenue whenever revenue is positive', () => {
    for (const { input, seed } of CASES) {
      const results = run(input);
      const revenue = decimalOf(pick(results, 'revenue'));
      if (revenue === null || !revenue.greaterThan(0)) continue;
      // The one deliberate exception: with no cost-of-sales account gross profit equals revenue,
      // and §3.1 refuses the resulting 100% gross margin outright.
      const costOfSalesUnknown = pick(results, 'cost_of_sales').value === null;
      for (const [marginKey, numeratorKey] of [
        ['gross_margin', 'gross_profit'],
        ['operating_margin', 'operating_profit'],
        ['net_margin', 'net_profit'],
        ['contribution_margin_ratio', 'contribution_margin'],
      ] as const) {
        const numerator = decimalOf(pick(results, numeratorKey));
        const margin = decimalOf(pick(results, marginKey));
        if (numerator === null) continue;
        if (marginKey === 'gross_margin' && costOfSalesUnknown) {
          expect(margin, `seed ${seed}`).toBeNull();
          continue;
        }
        expect(margin?.toFixed(6), `seed ${seed} / ${marginKey}`)
          .toBe(numerator.dividedBy(revenue).toDecimalPlaces(6).toFixed(6));
      }
    }
  });
});

describe('determinism (§1.1)', () => {
  it('produces byte-identical output for the same inputs, twice', () => {
    for (const { input, seed } of CASES.slice(0, 20)) {
      const first = JSON.stringify(run(input));
      const second = JSON.stringify(run(input));
      expect(second, `seed ${seed}`).toBe(first);
    }
  });

  it('does not depend on the order the aggregates arrived in', () => {
    const input = scenario(FULL_MONTH);
    const reversed: PnlInput = {
      ...input,
      accounts: [...input.accounts].reverse(),
      accountAmounts: [...input.accountAmounts].reverse(),
    };
    expect(JSON.stringify(run(reversed))).toBe(JSON.stringify(run(input)));
  });
});
