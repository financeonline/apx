import { describe, expect, it } from 'vitest';
import { budgetByCategory, computeBudgetVariance, type ActualFigure, type BudgetLineKey } from '@/modules/budgets';

/** Budget against actual (ADR-142). Every expected figure is worked by hand. */

const actual = (value: string | null, missing: string[] = []): ActualFigure =>
  ({ value, snapshotId: value === null ? null : `snap-${value}`, missing, statusLabel: null });

const actuals = (entries: Partial<Record<BudgetLineKey, ActualFigure | null>>) =>
  new Map(Object.entries(entries) as [BudgetLineKey, ActualFigure | null][]);

const row = (result: ReturnType<typeof computeBudgetVariance>, key: string) => result.rows.find((r) => r.key === key);

describe('budget against actual', () => {
  const budget = budgetByCategory([
    { category: 'revenue', amount: '10000.00' },
    { category: 'revenue', amount: '2000.00' },     // two revenue accounts: 12,000
    { category: 'cost_of_sales', amount: '4000.00' },
    { category: 'payroll', amount: '3000.00' },
    { category: 'marketing', amount: '500.00' },
    { category: 'cash', amount: '999.00' },          // not a P&L category
  ]);

  const result = computeBudgetVariance({
    budgetByCategory: budget,
    actualByLine: actuals({
      revenue: actual('13200.00'),
      cost_of_sales: actual('4400.00'),
      gross_profit: actual('8800.00'),
      payroll: actual('2900.00'),
      marketing: actual(null, ['no_cost_accounts']),
      operating_expenses: actual('3500.00'),
      operating_profit: actual('5300.00'),
      net_profit: actual('5300.00'),
    }),
  });

  it('sums the budget by category, exactly', () => {
    expect(budget.get('revenue')).toBe('12000.00');
  });

  it('subtracts budget from actual, with the share of the budget, favourable by line kind', () => {
    // Revenue 13,200 − 12,000 = +1,200 (+10%), favourable.
    expect(row(result, 'revenue')).toMatchObject({ budget: '12000.00', actual: '13200.00', variance: '1200.00', variancePct: '0.100000', favourable: true });
    // Cost of sales 4,400 − 4,000 = +400 (+10%): above budget for a cost is unfavourable.
    expect(row(result, 'cost_of_sales')).toMatchObject({ variance: '400.00', variancePct: '0.100000', favourable: false });
    // Payroll 2,900 − 3,000 = −100: below budget for a cost is favourable.
    expect(row(result, 'payroll')).toMatchObject({ variance: '-100.00', favourable: true });
  });

  it('derives budgeted profits the way the engine derives actual ones', () => {
    // Gross: 12,000 − 4,000 = 8,000; actual 8,800 → +800.
    expect(row(result, 'gross_profit')).toMatchObject({ budget: '8000.00', variance: '800.00', favourable: true });
    // Operating expenses budget: payroll 3,000 + marketing 500 (+ nil for the others) = 3,500.
    expect(row(result, 'operating_expenses')).toMatchObject({ budget: '3500.00', variance: '0.00' });
    // Operating profit: 8,000 − 3,500 = 4,500; actual 5,300 → +800.
    expect(row(result, 'operating_profit')).toMatchObject({ budget: '4500.00', variance: '800.00' });
    // And says which categories it counted as nil.
    expect(row(result, 'operating_profit')?.assumedZero).toEqual(['operating_expense', 'depreciation']);
  });

  it('never treats a missing actual as zero: no difference, and the engine\'s reason', () => {
    expect(row(result, 'marketing')).toMatchObject({ budget: '500.00', actual: null, variance: null, favourable: null, actualMissing: ['no_cost_accounts'] });
  });

  it('lists budgeted balance-sheet categories as not compared, rather than dropping them', () => {
    expect(result.notCompared).toEqual([{ category: 'cash', budget: '999.00' }]);
  });

  it('shows no derived profit when no income was budgeted', () => {
    const costsOnly = computeBudgetVariance({
      budgetByCategory: budgetByCategory([{ category: 'payroll', amount: '100.00' }]),
      actualByLine: actuals({}),
    });
    expect(costsOnly.rows.map((r) => r.key)).toEqual(['payroll', 'operating_expenses']);
  });

  it('gives no percentage against a zero budget', () => {
    const zero = computeBudgetVariance({
      budgetByCategory: budgetByCategory([{ category: 'revenue', amount: '0.00' }]),
      actualByLine: actuals({ revenue: actual('50.00') }),
    });
    expect(row(zero, 'revenue')).toMatchObject({ variance: '50.00', variancePct: null });
  });
});
