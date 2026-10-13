import { describe, expect, it } from 'vitest';
import { Decimal } from '@/core/money';
/*
 * Relative imports: the Marketing barrel (`@/modules/marketing`) is written alongside this feature,
 * and `motion/no-deep-module-import` (correctly) refuses `@/modules/marketing/domain/financials`.
 */
import {
  buildMarketingFinancials,
  changePercent,
  financialYearOf,
  reportYears,
  shareOfTurnover,
  type AccountSpendFact,
  type CategorySpendFact,
  type FigureFact,
  type FinancialFacts,
  type MonthFacts,
  type ProductSalesFact,
  type Section03Key,
} from '../../src/modules/marketing/domain/financials';

/**
 * Section 03 of the Marketing report (ADR-170): the product's monthly figures added up into financial
 * years. Every expected figure is worked by hand beside the fixture that produces it.
 */

const LAST_DAY = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** A ledger-basis figure the engine stated. */
const known = (value: string): FigureFact => ({ value, basis: 'ledger', warnings: [], missing: [] });
/** A figure the engine could not state. */
const unknown = (missing = 'no_source_covers_period'): FigureFact => ({ value: null, basis: 'none', warnings: [], missing: [missing] });

/** A month with a simple, balanced statement: revenue 1,000, cost of sales 400, running costs 300, net profit 300. */
function month(ym: string, over: Partial<Record<Section03Key, FigureFact>> = {}, isComplete = true): MonthFacts {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  const leap = m === 2 && y % 4 === 0;
  return {
    periodId: `p-${ym}`,
    periodStart: `${ym}-01`,
    periodEnd: `${ym}-${leap ? 29 : LAST_DAY[m - 1]}`,
    isComplete,
    figures: {
      revenue: known('1000.00'), cost_of_sales: known('400.00'), gross_profit: known('600.00'),
      operating_expenses: known('300.00'), net_profit: known('300.00'), other_income: known('0.00'), tax_expense: known('0.00'),
      ...over,
    },
  };
}

/** Every month from `from` to `to` inclusive (YYYY-MM). */
function months(from: string, to: string, over: Partial<Record<Section03Key, FigureFact>> = {}): MonthFacts[] {
  const out: MonthFacts[] = [];
  let [y, m] = from.split('-').map(Number) as [number, number];
  const [ty, tm] = to.split('-').map(Number) as [number, number];
  while (y < ty || (y === ty && m <= tm)) {
    out.push(month(`${y}-${String(m).padStart(2, '0')}`, over));
    m += 1;
    if (m === 13) { m = 1; y += 1; }
  }
  return out;
}

function facts(over: Partial<FinancialFacts> = {}): FinancialFacts {
  return {
    currency: 'GBP', fiscalYearStartMonth: 10, months: [], categorySpend: [], accountSpend: [], campaignSpend: [], productSales: [],
    ...over,
  };
}

const category = (periodId: string, cat: string, value: string | null, label = cat): CategorySpendFact => ({ periodId, category: cat, label, value });
const account = (periodId: string, accountId: string, name: string, cat: string, value: string | null): AccountSpendFact => ({
  periodId, accountId, name, category: cat, value,
});
const sale = (periodId: string, productId: string, amount: string): ProductSalesFact => ({ periodId, productId, product: productId, amount });

// ---------------------------------------------------------------------------------------------

describe('financial years', () => {
  it('names a year by the calendar year it ends in, across a non-January start', () => {
    expect(financialYearOf('2025-10-01', 10)).toBe(2026); // Oct 2025 – Sep 2026
    expect(financialYearOf('2026-09-01', 10)).toBe(2026);
    expect(financialYearOf('2026-10-01', 10)).toBe(2027);
    expect(financialYearOf('2026-03-01', 4)).toBe(2026); // Apr 2025 – Mar 2026
    expect(financialYearOf('2026-12-01', 1)).toBe(2026);
  });

  it('groups an October year-start into three years, oldest first, the latest one partial', () => {
    // Sep 2023 belongs to the year ended 30 Sep 2023 — a fourth year back, so it is not shown.
    const result = buildMarketingFinancials(facts({ months: months('2023-09', '2026-03') }))!;
    expect(result.years.map((y) => [y.label, y.periodStart, y.periodEnd, y.partial])).toEqual([
      ['2024', '2023-10-01', '2024-09-30', false],
      ['2025', '2024-10-01', '2025-09-30', false],
      ['2026 (6 months)', '2025-10-01', '2026-03-31', true],
    ]);
    // Twelve months of 1,000 each; six for the partial year.
    expect(result.years.map((y) => y.turnover)).toEqual(['12000.00', '12000.00', '6000.00']);
    expect(result.sourceNote).toMatch(
      /^Financial years ended 30 September 2024 and 2025, and the six months to 31 March 2026 \(part of the financial year to 30 September 2026\)\. All figures GBP\. /,
    );
  });

  it('leaves out a month still in progress, even one with figures, and says the year is partial', () => {
    const list = [...months('2025-10', '2026-02'), month('2026-03', { revenue: known('99999.00') }, false)];
    const result = buildMarketingFinancials(facts({ months: list }))!;
    expect(result.years).toHaveLength(1);
    expect(result.years[0]).toMatchObject({ label: '2026 (5 months)', partial: true, periodEnd: '2026-02-28', turnover: '5000.00' });
  });

  it('leaves out a month no source covers; the year then has fewer months', () => {
    const empty = month('2025-12', {
      revenue: unknown(), cost_of_sales: unknown(), gross_profit: unknown(), operating_expenses: unknown(), net_profit: unknown(),
    });
    const list = months('2024-10', '2025-09').map((m) => (m.periodStart === '2024-12-01' ? { ...empty, periodId: 'p-2024-12', periodStart: '2024-12-01', periodEnd: '2024-12-31' } : m));
    const [year] = reportYears(list, 10);
    expect(year!.months).toHaveLength(11);
    expect(buildMarketingFinancials(facts({ months: list }))!.years[0]).toMatchObject({ label: '2025 (11 months)', partial: true, turnover: '11000.00' });
  });

  it('skips a year in the window with no figures rather than showing a column of blanks', () => {
    const list = [...months('2023-10', '2024-09'), ...months('2025-10', '2026-09')];
    expect(buildMarketingFinancials(facts({ months: list }))!.years.map((y) => y.label)).toEqual(['2024', '2026']);
  });

  it('says "1 month" in the singular', () => {
    expect(buildMarketingFinancials(facts({ months: [month('2026-01')] }))!.years[0]!.label).toBe('2026 (1 month)');
  });
});

describe('the overview figures', () => {
  it('adds months exactly, in decimals, and states shares of turnover to one place, half up', () => {
    const list = [
      month('2025-10', { revenue: known('0.10'), cost_of_sales: known('0.05'), gross_profit: known('0.05'), operating_expenses: known('0.01'), net_profit: known('0.04') }),
      month('2025-11', { revenue: known('999.90'), cost_of_sales: known('574.45'), gross_profit: known('425.45'), operating_expenses: known('200.00'), net_profit: known('-323.04') }),
    ];
    const [year] = buildMarketingFinancials(facts({ months: list }))!.years;
    // 0.10 + 999.90 = 1000.00 exactly (no float drift).
    expect(year!.turnover).toBe('1000.00');
    // 574.50 / 1000 = 57.45% → 57.5 (ROUND_HALF_UP, once).
    expect(year!.costOfSales).toBe('574.50');
    expect(year!.costOfSalesPct).toBe('57.5');
    // 425.50 / 1000 = 42.55% → 42.6.
    expect(year!.grossProfitPct).toBe('42.6');
    expect(year!.adminCosts).toBe('200.01');
    // −323.00 / 1000 = −32.3%.
    expect(year!.netProfit).toBe('-323.00');
    expect(year!.netProfitPct).toBe('-32.3');
  });

  it('never writes a share as "-0.0"', () => {
    const [year] = buildMarketingFinancials(facts({ months: [month('2025-10', { net_profit: known('-0.04') })] }))!.years;
    expect(year!.netProfitPct).toBe('0.0');
  });

  it('makes a year unknown — not "the other months" — when one month of it is unknown', () => {
    const list = months('2024-10', '2025-09').map((m) => (m.periodStart === '2025-02-01'
      ? { ...m, figures: { ...m.figures, cost_of_sales: unknown(), gross_profit: unknown(), net_profit: unknown(), operating_expenses: unknown() } }
      : m));
    const [year] = buildMarketingFinancials(facts({ months: list }))!.years;
    expect(year).toMatchObject({
      label: '2025', turnover: '12000.00', costOfSales: null, costOfSalesPct: null, grossProfit: null, grossProfitPct: null,
      adminCosts: null, netProfit: null, netProfitPct: null,
    });
  });

  it('treats a key with no snapshot at all as unknown, never zero', () => {
    const m = month('2025-10');
    const { cost_of_sales: _dropped, ...rest } = m.figures;
    const [year] = buildMarketingFinancials(facts({ months: [{ ...m, figures: rest }] }))!.years;
    expect(year!.costOfSales).toBeNull();
    expect(year!.costOfSalesPct).toBeNull();
  });

  it('ADR-106: a gross profit that is only revenue with no cost of sales is not a gross profit', () => {
    const list = months('2024-10', '2025-09', {
      cost_of_sales: unknown('no_cost_of_sales_accounts'),
      gross_profit: { value: '1000.00', basis: 'ledger', warnings: ['no_cost_of_sales'], missing: [] },
    });
    const result = buildMarketingFinancials(facts({ months: list }))!;
    expect(result.years[0]).toMatchObject({ turnover: '12000.00', costOfSales: null, grossProfit: null, grossProfitPct: null, netProfit: '3600.00' });
    expect(result.sourceNote).toContain('Cost of sales and gross profit are left blank where the records do not state direct costs');
  });

  it('states no share of a turnover that is zero or negative', () => {
    const [zero] = buildMarketingFinancials(facts({ months: [month('2025-10', { revenue: known('0.00') })] }))!.years;
    expect(zero).toMatchObject({ turnover: '0.00', costOfSalesPct: null, grossProfitPct: null, netProfitPct: null });
    expect(shareOfTurnover(new Decimal('50'), new Decimal('-100'))).toBeNull();
    expect(shareOfTurnover(null, new Decimal('100'))).toBeNull();
  });
});

describe('advertising and marketing', () => {
  const list = months('2024-10', '2025-09');

  it('reads the accounts classified as Marketing; a month with stated costs and no Marketing row is a known zero', () => {
    const spend = [category('p-2024-10', 'marketing', '120.00'), category('p-2025-03', 'marketing', '30.50')];
    const result = buildMarketingFinancials(facts({ months: list, categorySpend: spend }))!;
    // 150.50 / 12,000 = 1.254…% → 1.3.
    expect(result.years[0]).toMatchObject({ marketingSpend: '150.50', marketingPct: '1.3' });
    expect(result.sourceNote).toContain('Advertising and marketing is the spend on accounts classified as Marketing in APX.');
  });

  it('is unknown for a year when a month of it has no stated running costs (FU-12)', () => {
    const uncovered = list.map((m) => (m.periodStart === '2025-06-01' ? { ...m, figures: { ...m.figures, operating_expenses: unknown(), net_profit: unknown() } } : m));
    const result = buildMarketingFinancials(facts({ months: uncovered, categorySpend: [category('p-2024-10', 'marketing', '120.00')] }))!;
    expect(result.years[0]).toMatchObject({ marketingSpend: null, marketingPct: null });
  });

  it('falls back to recorded campaign spend when no account is classified as Marketing — never both', () => {
    const campaigns = [{ periodId: 'p-2025-01', amount: '500.00' }, { periodId: 'p-2025-02', amount: '250.25' }];
    const result = buildMarketingFinancials(facts({ months: list, campaignSpend: campaigns }))!;
    expect(result.years[0]).toMatchObject({ marketingSpend: '750.25', marketingPct: '6.3' });
    expect(result.sourceNote).toContain('Advertising and marketing is the campaign spend recorded in APX');

    const both = buildMarketingFinancials(facts({ months: list, campaignSpend: campaigns, categorySpend: [category('p-2024-10', 'marketing', '120.00')] }))!;
    expect(both.years[0]!.marketingSpend).toBe('120.00');
  });

  it('is null, and says why, when neither the accounts nor the campaigns show any', () => {
    const result = buildMarketingFinancials(facts({ months: list }))!;
    expect(result.years[0]).toMatchObject({ marketingSpend: null, marketingPct: null });
    expect(result.sourceNote).toContain('Advertising and marketing spend is not shown');
  });
});

describe('3.4 the largest cost lines of the latest year', () => {
  const latest = months('2025-10', '2025-12');

  it('lists the top four expense accounts by amount, leaving out income and tax', () => {
    const rows = latest.flatMap((m) => [
      account(m.periodId, 'a1', 'Transportation & distribution', 'cost_of_sales', '300.00'),
      account(m.periodId, 'a2', 'Websites & IT', 'operating_expense', '100.00'),
      account(m.periodId, 'a3', 'Rent', 'operating_expense', '100.00'),
      account(m.periodId, 'a4', 'Wages', 'payroll', '50.00'),
      account(m.periodId, 'a5', 'Postage', 'operating_expense', '10.00'),
      account(m.periodId, 'a6', 'Corporation tax', 'tax_expense', '900.00'),
    ]);
    const categories = latest.map((m) => category(m.periodId, 'operating_expense', '210.00'));
    const result = buildMarketingFinancials(facts({ months: latest, accountSpend: rows, categorySpend: categories }))!;
    // Ties (Rent, Websites & IT at 300.00) are broken by name.
    expect(result.costLines).toEqual([
      { name: 'Transportation & distribution', amount: '900.00' },
      { name: 'Rent', amount: '300.00' },
      { name: 'Websites & IT', amount: '300.00' },
      { name: 'Wages', amount: '150.00' },
    ]);
    expect(result.sourceNote).not.toContain('by spending category');
  });

  it('a line that is unknown in any month is left out rather than shown at a guessed size', () => {
    const rows = [
      account('p-2025-10', 'a1', 'Freight', 'cost_of_sales', '500.00'),
      account('p-2025-11', 'a1', 'Freight', 'cost_of_sales', null),
      account('p-2025-10', 'a2', 'Rent', 'operating_expense', '100.00'),
    ];
    expect(buildMarketingFinancials(facts({ months: latest, accountSpend: rows }))!.costLines).toEqual([{ name: 'Rent', amount: '100.00' }]);
  });

  it('falls back to spending categories when a month with costs has no account breakdown (bank basis)', () => {
    const rows = [account('p-2025-10', 'a1', 'Freight', 'cost_of_sales', '500.00')];
    const categories = [
      category('p-2025-10', 'cost_of_sales', '500.00', 'Cost of sales'),
      category('p-2025-11', 'payroll', '800.00', 'Payroll'),
      category('p-2025-11', 'other_income', '5000.00', 'Other income'),
    ];
    const result = buildMarketingFinancials(facts({ months: latest, accountSpend: rows, categorySpend: categories }))!;
    expect(result.costLines).toEqual([{ name: 'Payroll', amount: '800.00' }, { name: 'Cost of sales', amount: '500.00' }]);
    expect(result.sourceNote).toContain('The largest costs are shown by spending category');
  });

  it('states no line when the year\'s running costs are not known for every month', () => {
    const list = latest.map((m, i) => (i === 1 ? { ...m, figures: { ...m.figures, operating_expenses: unknown() } } : m));
    const rows = latest.map((m) => account(m.periodId, 'a1', 'Rent', 'operating_expense', '100.00'));
    expect(buildMarketingFinancials(facts({ months: list, accountSpend: rows }))!.costLines).toEqual([]);
  });
});

describe('3.2 product sales', () => {
  it('compares a partial year with the SAME months of the year before, and states the change', () => {
    const list = months('2024-10', '2026-03');
    const sales = [
      sale('p-2024-10', 'Handbags', '1000.00'), sale('p-2025-03', 'Handbags', '1000.00'),
      sale('p-2025-06', 'Handbags', '9999.00'), // July–Sep of the previous year is outside the like-for-like months
      sale('p-2025-10', 'Handbags', '1500.00'),
      sale('p-2024-11', 'Wallets', '200.00'), sale('p-2025-11', 'Wallets', '300.00'), sale('p-2025-12', 'Wallets', '-150.00'),
    ];
    const result = buildMarketingFinancials(facts({ months: list, productSales: sales }))!;
    expect(result.productSales).toEqual({
      previousLabel: '2025 (same 6 months)',
      currentLabel: '2026 (6 months)',
      rows: [
        // (1500 − 2000) / 2000 = −25.0%
        { product: 'Handbags', previous: '2000.00', current: '1500.00', changePct: '-25.0' },
        // A credit note subtracts: 300 − 150 = 150; (150 − 200) / 200 = −25.0%
        { product: 'Wallets', previous: '200.00', current: '150.00', changePct: '-25.0' },
      ],
    });
    expect(result.sourceNote).toContain('Product sales are the invoice lines attributed to each product');
  });

  it('a product nobody sold in a year that HAS attributed lines sold zero; a zero comparison has no change', () => {
    const list = months('2023-10', '2025-09');
    const sales = [sale('p-2024-01', 'Handbags', '400.00'), sale('p-2025-01', 'Handbags', '500.00'), sale('p-2025-02', 'Embossing', '75.00')];
    const rows = buildMarketingFinancials(facts({ months: list, productSales: sales }))!.productSales!.rows;
    expect(rows).toEqual([
      { product: 'Handbags', previous: '400.00', current: '500.00', changePct: '25.0' },
      { product: 'Embossing', previous: '0.00', current: '75.00', changePct: null },
    ]);
  });

  it('a year with no attributed lines at all is unknown, not zero', () => {
    const list = months('2023-10', '2025-09');
    const result = buildMarketingFinancials(facts({ months: list, productSales: [sale('p-2025-01', 'Handbags', '500.00')] }))!;
    expect(result.productSales).toEqual({
      previousLabel: '2024', currentLabel: '2025',
      rows: [{ product: 'Handbags', previous: null, current: '500.00', changePct: null }],
    });
  });

  it('states no change when the two columns cover different months', () => {
    // The previous year has only Jan–Sep; the current year is whole.
    const list = [...months('2024-01', '2024-09'), ...months('2024-10', '2025-09')];
    const sales = [sale('p-2024-02', 'Handbags', '100.00'), sale('p-2025-02', 'Handbags', '200.00')];
    const result = buildMarketingFinancials(facts({ months: list, productSales: sales }))!;
    expect(result.productSales).toMatchObject({ previousLabel: '2024 (9 months)', currentLabel: '2025' });
    expect(result.productSales!.rows[0]).toEqual({ product: 'Handbags', previous: '100.00', current: '200.00', changePct: null });
    expect(result.sourceNote).toContain('No change is shown for product sales because the two columns do not cover the same months.');
  });

  it('keeps the table to eight rows by adding the smallest into "All other products"', () => {
    const list = months('2024-10', '2025-09');
    const sales = Array.from({ length: 10 }, (_, i) => sale('p-2025-01', `P${String(i).padStart(2, '0')}`, `${(10 - i) * 10}.00`));
    const rows = buildMarketingFinancials(facts({ months: list, productSales: sales }))!.productSales!.rows;
    expect(rows).toHaveLength(8);
    expect(rows[0]).toMatchObject({ product: 'P00', current: '100.00' });
    // P07, P08, P09: 30 + 20 + 10.
    expect(rows[7]).toEqual({ product: 'All other products', previous: null, current: '60.00', changePct: null });
  });

  it('is null when no invoice line names a product', () => {
    expect(buildMarketingFinancials(facts({ months: months('2024-10', '2025-09') }))!.productSales).toBeNull();
  });
});

describe('the percentage change (FINANCIAL_ENGINE.md §3.2)', () => {
  it('is refused across zero, across a change of sign, and when either side is unknown', () => {
    expect(changePercent(new Decimal('200'), new Decimal('150'))).toBe('-25.0');
    expect(changePercent(new Decimal('-200'), new Decimal('-100'))).toBe('50.0');
    expect(changePercent(new Decimal('0'), new Decimal('150'))).toBeNull();
    expect(changePercent(new Decimal('-100'), new Decimal('50'))).toBeNull();
    expect(changePercent(null, new Decimal('50'))).toBeNull();
    expect(changePercent(new Decimal('50'), null)).toBeNull();
    // A fall to exactly zero is a fall of 100%, not a sign change.
    expect(changePercent(new Decimal('50'), new Decimal('0'))).toBe('-100.0');
  });
});

describe('the source note', () => {
  it('names the year-end, the currency and where the figures came from', () => {
    const note = buildMarketingFinancials(facts({ fiscalYearStartMonth: 1, months: months('2026-01', '2026-09') }))!.sourceNote;
    expect(note).toBe(
      'The nine months to 30 September 2026 (part of the financial year to 31 December 2026). All figures GBP. '
      + "Source: the company's own records in APX — the monthly profit and loss figures APX calculated from its accounts, added together for each financial year. "
      + 'Net profit is after interest and any tax recorded in the accounts; no tax charge is recorded in these figures. '
      + 'Advertising and marketing spend is not shown: no spend is recorded on accounts classified as Marketing, and no campaign spend is recorded in APX.',
    );
  });

  it('says so when tax and other income are recorded, and names every basis the months used', () => {
    const list = months('2024-10', '2025-09', { tax_expense: known('50.00'), other_income: known('10.00') })
      .map((m, i) => (i === 0 ? { ...m, figures: { ...m.figures, revenue: { ...known('1000.00'), basis: 'bank' } } } : m));
    const note = buildMarketingFinancials(facts({ months: list }))!.sourceNote;
    expect(note).toMatch(/^Financial year ended 30 September 2025\./);
    expect(note).toContain('calculated from its bank statements and accounts');
    expect(note).toContain('Net profit is after interest and the tax recorded in the accounts.');
    expect(note).toContain('other income is included in net profit but not in turnover');
  });

  it('lists the year-ends in full when they differ (a February year-end across a leap year)', () => {
    const note = buildMarketingFinancials(facts({ fiscalYearStartMonth: 3, months: months('2023-03', '2025-02') }))!.sourceNote;
    expect(note).toMatch(/^Financial years ended 29 February 2024 and 28 February 2025\./);
  });
});

describe('no figures at all', () => {
  it('is null — the report then has no Section 03 tables', () => {
    expect(buildMarketingFinancials(facts())).toBeNull();
    expect(buildMarketingFinancials(facts({ months: [month('2026-01', {}, false)] }))).toBeNull();
    const nothing = month('2026-01', {
      revenue: unknown(), cost_of_sales: unknown(), gross_profit: unknown(), operating_expenses: unknown(), net_profit: unknown(),
    });
    expect(buildMarketingFinancials(facts({ months: [nothing] }))).toBeNull();
  });
});
