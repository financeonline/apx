import { describe, expect, it } from 'vitest';
import type { HorizonPeriod } from '@/modules/forecast';
import {
  applyScenario, parseAssumptions, sufficiency,
  type Assumption, type ScenarioBasis, type ScenarioCell,
} from '@/modules/scenarios';

/**
 * The scenario engine (REQ-SC-01…09, §6, §7; ADR-100).
 *
 * Every case is about one of two properties:
 *
 *   * **the scenario cannot contradict the engine** — profit is derived from sales and costs on
 *     both sides, cash is chained from the same real opening balance, and the identities hold in
 *     the scenario exactly as they hold in the forecast; and
 *   * **nothing is invented** — a relationship MOTION's data does not define is refused with a
 *     reason rather than approximated.
 */

const HORIZON: HorizonPeriod[] = [
  { periodId: 'p1', periodStart: '2026-09-01', periodLabel: 'Sep 2026' },
  { periodId: 'p2', periodStart: '2026-10-01', periodLabel: 'Oct 2026' },
  { periodId: 'p3', periodStart: '2026-11-01', periodLabel: 'Nov 2026' },
];

/** A steady business: the same figures Phase 11's own tests forecast. */
const BASIS: ScenarioBasis = {
  leafLevels: {
    revenue: '10000.00', cost_of_sales: '4000.00', operating_expenses: '3000.00',
    cash_inflows: '9000.00', cash_outflows: '7000.00',
    receivables: '5000.00', payables: '2000.00',
  },
  categoryLevels: { payroll: '2000.00', marketing: '500.00' },
  lastActualClosingCash: '20000.00',
};

const run = (assumptions: unknown[], basis: ScenarioBasis = BASIS) => applyScenario({
  assumptions: parseAssumptions(assumptions),
  basis,
  horizon: HORIZON,
  forecastBasis: 'strong',
});

const at = (cells: readonly ScenarioCell[], metricKey: string, periodId = 'p1') =>
  cells.find((c) => c.metricKey === metricKey && c.periodId === periodId);

const scenarioOf = (cells: readonly ScenarioCell[], key: string, periodId = 'p1') =>
  at(cells, key, periodId)?.scenarioValue;
const baselineOf = (cells: readonly ScenarioCell[], key: string, periodId = 'p1') =>
  at(cells, key, periodId)?.baselineValue;

const REVENUE_UP_10 = {
  kind: 'revenue_change', mode: 'percent', value: '10',
  directCostsFollow: false, startsInMonth: 1, cashEffect: 'none',
};

describe('the baseline a scenario is compared against is the forecast, unchanged', () => {
  it('reproduces the forecast figures on the baseline side', () => {
    const { cells } = run([REVENUE_UP_10]);
    expect(baselineOf(cells, 'revenue')).toBe('10000.00');
    expect(baselineOf(cells, 'gross_profit'), 'revenue − direct costs').toBe('6000.00');
    expect(baselineOf(cells, 'operating_profit')).toBe('3000.00');
    expect(baselineOf(cells, 'closing_cash'), 'opened on the last real balance').toBe('22000.00');
    expect(baselineOf(cells, 'closing_cash', 'p3'), 'and chained forward').toBe('26000.00');
  });

  it('puts the months in horizon order, never in alphabetical order of their names', () => {
    const { cells } = run([REVENUE_UP_10]);
    const seen: string[] = [];
    for (const cell of cells) if (!seen.includes(cell.periodLabel)) seen.push(cell.periodLabel);
    expect(seen).toEqual(['Sep 2026', 'Oct 2026', 'Nov 2026']);
  });
});

describe('sales (REQ-SC-02)', () => {
  it('moves sales and lets profit follow from the engine’s own identity', () => {
    const { cells } = run([REVENUE_UP_10]);
    expect(scenarioOf(cells, 'revenue')).toBe('11000.00');
    expect(scenarioOf(cells, 'gross_profit'), '11,000 − 4,000').toBe('7000.00');
    expect(scenarioOf(cells, 'operating_profit'), '7,000 − 3,000').toBe('4000.00');
  });

  it('states the change in money and as a share, and never divides by a zero baseline', () => {
    const revenue = at(run([REVENUE_UP_10]).cells, 'revenue')!;
    expect(revenue.change).toBe('1000.00');
    expect(revenue.changeRatio).toBe('0.100000');
  });

  it('leaves cash alone unless the assumption says the money is collected (§7)', () => {
    const { cells } = run([REVENUE_UP_10]);
    expect(scenarioOf(cells, 'closing_cash'), 'unchanged from the baseline').toBe('22000.00');
  });

  it('moves cash when — and only when — the assumption says so', () => {
    const { cells } = run([{ ...REVENUE_UP_10, cashEffect: 'same_month' }]);
    // The £1,000 of extra SALES arrives as £1,000 of cash — not a tenth of the cash that was
    // already coming in, which would be a different number about a different thing.
    expect(scenarioOf(cells, 'cash_inflows')).toBe('10000.00');
    expect(scenarioOf(cells, 'closing_cash')).toBe('23000.00');
    expect(scenarioOf(cells, 'closing_cash', 'p3'), 'and compounds down the chain').toBe('29000.00');
  });

  it('holds direct costs still by default: extra sales are all margin unless told otherwise', () => {
    expect(scenarioOf(run([REVENUE_UP_10]).cells, 'gross_profit')).toBe('7000.00');
  });

  it('moves direct costs at the organisation’s OWN rate when asked to', () => {
    const { cells } = run([{ ...REVENUE_UP_10, directCostsFollow: true }]);
    // 4,000 × 10% = 400. The rate is read from the forecast, not chosen here.
    expect(scenarioOf(cells, 'gross_profit'), '11,000 − 4,400').toBe('6600.00');
    expect(scenarioOf(cells, 'operating_profit')).toBe('3600.00');
  });

  it('takes an amount as well as a percentage', () => {
    const { cells } = run([{ ...REVENUE_UP_10, mode: 'amount', value: '2500' }]);
    expect(scenarioOf(cells, 'revenue')).toBe('12500.00');
  });

  it('works downwards too', () => {
    const { cells } = run([{ ...REVENUE_UP_10, value: '-20' }]);
    expect(scenarioOf(cells, 'revenue')).toBe('8000.00');
    expect(scenarioOf(cells, 'operating_profit'), '8,000 − 4,000 − 3,000').toBe('1000.00');
  });
});

describe('wages, suppliers, marketing and hiring (REQ-SC-03…06)', () => {
  it('adds an amount of wages to running costs and takes it out of cash', () => {
    const { cells } = run([
      { kind: 'payroll_change', mode: 'amount', value: '500', startsInMonth: 1, cashEffect: 'same_month' },
    ]);
    expect(scenarioOf(cells, 'operating_expenses')).toBe('3500.00');
    expect(scenarioOf(cells, 'operating_profit'), '6,000 − 3,500').toBe('2500.00');
    expect(scenarioOf(cells, 'cash_outflows')).toBe('7500.00');
    expect(scenarioOf(cells, 'closing_cash')).toBe('21500.00');
  });

  it('reads a percentage of wages from the engine’s own breakdown of what wages are', () => {
    const { cells } = run([
      { kind: 'payroll_change', mode: 'percent', value: '10', startsInMonth: 1, cashEffect: 'none' },
    ]);
    // 10% of the payroll category's 2,000, not 10% of all running costs.
    expect(scenarioOf(cells, 'operating_expenses')).toBe('3200.00');
  });

  it('moves direct costs when a supplier puts its prices up, so profit after direct costs falls', () => {
    const { cells } = run([
      { kind: 'supplier_cost_change', mode: 'percent', value: '15', startsInMonth: 1, cashEffect: 'same_month' },
    ]);
    expect(scenarioOf(cells, 'gross_profit'), '10,000 − 4,600').toBe('5400.00');
    expect(scenarioOf(cells, 'cash_outflows')).toBe('7600.00');
  });

  it('spends more on marketing without inventing a single extra sale (§10)', () => {
    const { cells } = run([
      { kind: 'marketing_change', mode: 'amount', value: '250', startsInMonth: 1, cashEffect: 'same_month' },
    ]);
    expect(scenarioOf(cells, 'operating_expenses')).toBe('3250.00');
    expect(scenarioOf(cells, 'revenue'), 'marketing buys no revenue MOTION can prove').toBe('10000.00');
    expect(scenarioOf(cells, 'operating_profit')).toBe('2750.00');
  });

  it('costs a hire at the figure the user gave, per person (§8)', () => {
    const { cells } = run([
      { kind: 'hiring', headcount: 2, monthlyCostPerPerson: '2500', startsInMonth: 1, cashEffect: 'same_month' },
    ]);
    expect(scenarioOf(cells, 'operating_expenses')).toBe('8000.00');
    expect(scenarioOf(cells, 'operating_profit')).toBe('-2000.00');
  });

  it('starts a change in the month it was asked to start', () => {
    const { cells } = run([
      { kind: 'hiring', headcount: 1, monthlyCostPerPerson: '2000', startsInMonth: 2, cashEffect: 'none' },
    ]);
    expect(scenarioOf(cells, 'operating_expenses', 'p1')).toBe('3000.00');
    expect(scenarioOf(cells, 'operating_expenses', 'p2')).toBe('5000.00');
    expect(scenarioOf(cells, 'operating_expenses', 'p3')).toBe('5000.00');
  });
});

describe('prices (REQ-SC-07)', () => {
  const pricing = {
    kind: 'pricing_change', pricePercent: '5', volumePercent: '0',
    directCostsFollow: false, startsInMonth: 1, cashEffect: 'none',
  };

  it('does not turn a price rise into a sales rise on its own terms: the volume answer is used', () => {
    const { cells } = run([pricing]);
    expect(scenarioOf(cells, 'revenue'), '10,000 × 1.05 × 1.00').toBe('10500.00');
    expect(scenarioOf(cells, 'gross_profit'), 'nothing costs more to buy').toBe('6500.00');
  });

  it('combines a price rise with fewer sales the way the two actually compound', () => {
    const { cells } = run([{ ...pricing, volumePercent: '-10', directCostsFollow: true }]);
    // 1.05 × 0.90 = 0.945 of sales; direct costs follow VOLUME alone, so 4,000 × 0.90 = 3,600.
    expect(scenarioOf(cells, 'revenue')).toBe('9450.00');
    expect(scenarioOf(cells, 'gross_profit'), '9,450 − 3,600').toBe('5850.00');
  });

  it('leaves direct costs alone when a price change sells the same number of things', () => {
    const { cells } = run([{ ...pricing, directCostsFollow: true }]);
    expect(scenarioOf(cells, 'gross_profit'), '10,500 − 4,000').toBe('6500.00');
  });
});

describe('borrowing and repaying (REQ-SC-08, §11)', () => {
  it('brings borrowed money in once, in the month it was assumed to arrive', () => {
    const { cells } = run([
      { kind: 'debt_drawdown', amount: '5000', startsInMonth: 2, cashEffect: 'same_month' },
    ]);
    expect(scenarioOf(cells, 'cash_inflows', 'p1')).toBe('9000.00');
    expect(scenarioOf(cells, 'cash_inflows', 'p2')).toBe('14000.00');
    expect(scenarioOf(cells, 'cash_inflows', 'p3'), 'borrowing is an event, not a habit').toBe('9000.00');
    expect(scenarioOf(cells, 'closing_cash', 'p3')).toBe('31000.00');
  });

  it('never lets borrowing look like profit', () => {
    const { cells } = run([
      { kind: 'debt_drawdown', amount: '5000', startsInMonth: 1, cashEffect: 'same_month' },
    ]);
    expect(scenarioOf(cells, 'operating_profit')).toBe('3000.00');
  });

  it('takes capital and interest out of cash, and neither out of operating profit', () => {
    const { cells } = run([
      { kind: 'debt_repayment', monthlyAmount: '1200', monthlyInterest: '300', startsInMonth: 1, cashEffect: 'same_month' },
    ]);
    expect(scenarioOf(cells, 'cash_outflows')).toBe('8500.00');
    expect(scenarioOf(cells, 'closing_cash')).toBe('20500.00');
    expect(scenarioOf(cells, 'operating_profit'), 'interest sits below the operating line').toBe('3000.00');
  });

  it('counts no interest when none was given, rather than deriving a rate (§11)', () => {
    const { cells } = run([
      { kind: 'debt_repayment', monthlyAmount: '1200', monthlyInterest: null, startsInMonth: 1, cashEffect: 'same_month' },
    ]);
    expect(scenarioOf(cells, 'cash_outflows')).toBe('8200.00');
  });
});

describe('several changes at once', () => {
  it('applies them all, and the identities still hold', () => {
    const { cells } = run([
      REVENUE_UP_10,
      { kind: 'payroll_change', mode: 'amount', value: '500', startsInMonth: 1, cashEffect: 'same_month' },
      { kind: 'marketing_change', mode: 'amount', value: '250', startsInMonth: 1, cashEffect: 'same_month' },
    ]);
    expect(scenarioOf(cells, 'revenue')).toBe('11000.00');
    expect(scenarioOf(cells, 'operating_expenses'), '3,000 + 500 + 250').toBe('3750.00');
    expect(scenarioOf(cells, 'gross_profit')).toBe('7000.00');
    expect(scenarioOf(cells, 'operating_profit'), '7,000 − 3,750').toBe('3250.00');
    // Sales were not assumed to be collected; the two costs were.
    expect(scenarioOf(cells, 'cash_outflows')).toBe('7750.00');
    expect(scenarioOf(cells, 'cash_inflows')).toBe('9000.00');
  });

  it('gives the same answer whatever order the changes arrive in', () => {
    const a = run([
      REVENUE_UP_10,
      { kind: 'payroll_change', mode: 'amount', value: '500', startsInMonth: 1, cashEffect: 'same_month' },
      { kind: 'debt_repayment', monthlyAmount: '1200', monthlyInterest: null, startsInMonth: 2, cashEffect: 'same_month' },
    ]);
    const b = run([
      { kind: 'debt_repayment', monthlyAmount: '1200', monthlyInterest: null, startsInMonth: 2, cashEffect: 'same_month' },
      { kind: 'payroll_change', mode: 'amount', value: '500', startsInMonth: 1, cashEffect: 'same_month' },
      REVENUE_UP_10,
    ]);
    expect(JSON.stringify(a.cells)).toBe(JSON.stringify(b.cells));
  });

  it('gives byte-identical answers on two runs of the same question', () => {
    expect(JSON.stringify(run([REVENUE_UP_10]))).toBe(JSON.stringify(run([REVENUE_UP_10])));
  });
});

describe('what MOTION refuses to work out, and says so (§7, §12)', () => {
  const without = (...keys: string[]): ScenarioBasis => ({
    ...BASIS,
    leafLevels: Object.fromEntries(
      Object.entries(BASIS.leafLevels).map(([k, v]) => [k, keys.includes(k) ? null : v]),
    ),
  });

  it('refuses a supplier change for a business with no direct costs (CD-05)', () => {
    const result = run([
      { kind: 'supplier_cost_change', mode: 'percent', value: '10', startsInMonth: 1, cashEffect: 'same_month' },
    ], without('cost_of_sales'));
    expect(result.cells).toHaveLength(0);
    expect(result.unavailable[0]).toMatchObject({ kind: 'supplier_cost_change', reason: 'no_direct_costs' });
  });

  it('refuses to let direct costs follow sales when there are no direct costs', () => {
    const result = run([{ ...REVENUE_UP_10, directCostsFollow: true }], without('cost_of_sales'));
    expect(result.unavailable[0]).toMatchObject({ reason: 'no_direct_costs' });
  });

  it('refuses a percentage of wages when it does not know what wages have been', () => {
    const result = applyScenario({
      assumptions: parseAssumptions([
        { kind: 'payroll_change', mode: 'percent', value: '10', startsInMonth: 1, cashEffect: 'none' },
      ]),
      basis: { ...BASIS, categoryLevels: {} },
      horizon: HORIZON,
      forecastBasis: 'limited',
    });
    expect(result.unavailable[0]).toMatchObject({ reason: 'no_category_baseline' });
  });

  it('accepts an AMOUNT of wages even when it does not know what wages have been', () => {
    const result = applyScenario({
      assumptions: parseAssumptions([
        { kind: 'payroll_change', mode: 'amount', value: '500', startsInMonth: 1, cashEffect: 'none' },
      ]),
      basis: { ...BASIS, categoryLevels: {} },
      horizon: HORIZON,
      forecastBasis: 'limited',
    });
    expect(result.unavailable).toHaveLength(0);
    expect(scenarioOf(result.cells, 'operating_expenses')).toBe('3500.00');
  });

  it('refuses to work out a share of sales that are forecast at zero', () => {
    const result = run(
      [{ ...REVENUE_UP_10, mode: 'amount', value: '1000', directCostsFollow: true }],
      { ...BASIS, leafLevels: { ...BASIS.leafLevels, revenue: '0.00' } },
    );
    expect(result.unavailable[0]).toMatchObject({ reason: 'no_revenue_baseline' });
  });

  it('refuses a change that is meant to move cash when there is no cash figure to move', () => {
    const result = run([
      { kind: 'payroll_change', mode: 'amount', value: '500', startsInMonth: 1, cashEffect: 'same_month' },
    ], without('cash_outflows'));
    expect(result.unavailable[0]).toMatchObject({ reason: 'metric_not_forecast', metricKey: 'cash_outflows' });
  });

  it('accepts the same change when the user says it does not move cash', () => {
    const result = run([
      { kind: 'payroll_change', mode: 'amount', value: '500', startsInMonth: 1, cashEffect: 'none' },
    ], without('cash_outflows'));
    expect(result.unavailable).toHaveLength(0);
    expect(scenarioOf(result.cells, 'operating_expenses')).toBe('3500.00');
  });

  it('refuses a sales change for a business whose sales cannot be forecast', () => {
    const result = run([REVENUE_UP_10], without('revenue'));
    expect(result.unavailable[0]).toMatchObject({ reason: 'metric_not_forecast', metricKey: 'revenue' });
  });

  it('returns NO figures at all when anything is refused — never a partial answer (§7)', () => {
    const result = run([
      REVENUE_UP_10,
      { kind: 'supplier_cost_change', mode: 'amount', value: '100', startsInMonth: 1, cashEffect: 'none' },
    ], without('cost_of_sales'));
    expect(result.cells, 'a half-applied scenario would look complete').toHaveLength(0);
  });

  it('names every missing thing at once', () => {
    const missing = sufficiency(parseAssumptions([
      { ...REVENUE_UP_10, directCostsFollow: true },
      { kind: 'supplier_cost_change', mode: 'amount', value: '100', startsInMonth: 1, cashEffect: 'none' },
    ]) as Assumption[], without('cost_of_sales'), HORIZON.length);
    expect(missing).toHaveLength(2);
  });
});

describe('a change has to land inside the months the scenario is about (MEDIUM-1 remediation)', () => {
  const hire = (startsInMonth: number) => ({
    kind: 'hiring', headcount: 1, monthlyCostPerPerson: '2000', startsInMonth, cashEffect: 'none',
  });
  const twoMonths = HORIZON.slice(0, 2);
  const withHorizon = (assumptions: unknown[], horizon: HorizonPeriod[]) => applyScenario({
    assumptions: parseAssumptions(assumptions), basis: BASIS, horizon, forecastBasis: 'strong',
  });

  it('applies a change that starts inside the horizon', () => {
    const result = withHorizon([hire(1)], twoMonths);
    expect(result.unavailable).toHaveLength(0);
    expect(scenarioOf(result.cells, 'operating_expenses', 'p1')).toBe('5000.00');
    expect(scenarioOf(result.cells, 'operating_expenses', 'p2')).toBe('5000.00');
  });

  it('applies a change that starts exactly on the last month of the horizon', () => {
    const result = withHorizon([hire(2)], twoMonths);
    expect(result.unavailable).toHaveLength(0);
    expect(scenarioOf(result.cells, 'operating_expenses', 'p1'), 'untouched before it starts').toBe('3000.00');
    expect(scenarioOf(result.cells, 'operating_expenses', 'p2'), 'applied on the boundary month').toBe('5000.00');
  });

  it('refuses a change that would start after the horizon, rather than accepting it and applying it to nothing', () => {
    // The form's month picker cannot produce this — its options are the real horizon — but the
    // service can be asked to, and the audit found it silently accepted (MEDIUM-1).
    const result = withHorizon([hire(3)], twoMonths);
    expect(result.cells).toHaveLength(0);
    expect(result.unavailable).toEqual([
      { kind: 'hiring', reason: 'starts_after_horizon', metricKey: null },
    ]);
  });

  it('refuses the whole scenario when one of several changes starts after the horizon', () => {
    // Mixed applicability is not partially applied: an in-range sales change and an out-of-range
    // hire produce no figures and name the hire — never a scenario that quietly lost the hire.
    const result = withHorizon([REVENUE_UP_10, hire(3)], twoMonths);
    expect(result.cells).toHaveLength(0);
    expect(result.unavailable).toEqual([
      { kind: 'hiring', reason: 'starts_after_horizon', metricKey: null },
    ]);
  });

  it('treats month three as inside a three-month horizon (the shipped case is unchanged)', () => {
    const result = withHorizon([hire(3)], HORIZON);
    expect(result.unavailable).toHaveLength(0);
    expect(scenarioOf(result.cells, 'operating_expenses', 'p3')).toBe('5000.00');
  });
});

describe('zero is a figure, and a percentage across it is not (§6)', () => {
  it('states the money change and NO percentage when the baseline is zero', () => {
    const { cells } = run(
      [{ kind: 'marketing_change', mode: 'amount', value: '250', startsInMonth: 1, cashEffect: 'none' }],
      { ...BASIS, leafLevels: { ...BASIS.leafLevels, operating_expenses: '0.00' } },
    );
    const opex = at(cells, 'operating_expenses')!;
    expect(opex.baselineValue).toBe('0.00');
    expect(opex.change, 'the money is still knowable').toBe('250.00');
    expect(opex.changeRatio, 'a percentage across zero is meaningless').toBeNull();
  });

  it('states a percentage of zero as zero rather than refusing it', () => {
    // Marketing has been zero, so 10% of it is zero. That is an answer, not a missing figure.
    const result = applyScenario({
      assumptions: parseAssumptions([
        { kind: 'marketing_change', mode: 'percent', value: '10', startsInMonth: 1, cashEffect: 'none' },
      ]),
      basis: { ...BASIS, categoryLevels: { ...BASIS.categoryLevels, marketing: '0.00' } },
      horizon: HORIZON,
      forecastBasis: 'strong',
    });
    expect(result.unavailable).toHaveLength(0);
    expect(scenarioOf(result.cells, 'operating_expenses')).toBe('3000.00');
    expect(at(result.cells, 'operating_expenses')!.changeRatio).toBe('0.000000');
  });
});

describe('a business with no bank data can still model its profit', () => {
  it('reports profit and omits cash rather than opening a balance at zero (§8)', () => {
    const result = run([REVENUE_UP_10], {
      ...BASIS, lastActualClosingCash: null,
    });
    expect(scenarioOf(result.cells, 'operating_profit')).toBe('4000.00');
    expect(at(result.cells, 'closing_cash'), 'no balance to chain from').toBeUndefined();
    expect(at(result.cells, 'net_cash_movement'), 'the movement is still knowable').toBeDefined();
  });
});
