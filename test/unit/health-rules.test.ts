import { describe, it, expect } from 'vitest';
import { Decimal } from '@/core/money';
import {
  BANKING_HEALTH_RULES, CASH_FLOW_RULES, COST_CONTROL_RULES, CUSTOMER_QUALITY_RULES,
  DIMENSION_WEIGHTS, HEALTH_DIMENSION_KEYS, PROFITABILITY_RULES, REVENUE_GROWTH_RULES,
  TOTAL_WEIGHT, bandOf, bandFor, bandLabel, coefficientOfVariation, evaluateBankingHealth,
  evaluateCashFlow, evaluateCostControl, evaluateCustomerQuality, evaluateProfitability,
  evaluateRevenueGrowth, type BandedRule,
} from '@/modules/health';
import {
  CURRENT, PERIODS, baselineSnapshots, healthInput, snapshot, variance, withMetric, withoutMetric,
} from '../fixtures/health';

/**
 * The rule table (TEST_STRATEGY.md §7): "Every rule in FINANCIAL_ENGINE.md §7.3 has a fixture at,
 * just below and just above each threshold; points awarded match".
 *
 * The table below is TRANSCRIBED FROM THE DOCUMENT, not derived from the config. That is the whole
 * point: a test generated from the same constants it checks would pass just as happily against a
 * typo. Every row here can be read against §7.3 by eye.
 */

const ALL_RULES: Readonly<Record<string, BandedRule>> = {
  ...PROFITABILITY_RULES, ...CASH_FLOW_RULES, ...REVENUE_GROWTH_RULES,
  ...COST_CONTROL_RULES, ...CUSTOMER_QUALITY_RULES, ...BANKING_HEALTH_RULES,
};

type Case = [rule: string, value: string, points: number];

const THRESHOLD_TABLE: readonly Case[] = [
  // P1 net margin: >= 0.15 +30; 0.05-0.15 +15; 0-0.05 0; < 0 -30
  ['P1', '0.20', 30], ['P1', '0.15', 30], ['P1', '0.1499', 15],
  ['P1', '0.05', 15], ['P1', '0.0499', 0], ['P1', '0', 0],
  ['P1', '-0.0001', -30], ['P1', '-0.10', -30],
  // P2 gross margin: >= 0.50 +10; 0.30-0.50 +5; < 0.20 -10 (0.20-0.30 scores nothing)
  ['P2', '0.60', 10], ['P2', '0.50', 10], ['P2', '0.4999', 5],
  ['P2', '0.30', 5], ['P2', '0.2999', 0], ['P2', '0.20', 0], ['P2', '0.1999', -10],
  // P3 margin trend: >= +0.02 +10; <= -0.02 -15
  ['P3', '0.03', 10], ['P3', '0.02', 10], ['P3', '0.0199', 0], ['P3', '0', 0],
  ['P3', '-0.0199', 0], ['P3', '-0.02', -15], ['P3', '-0.03', -15],
  // P4 profit momentum: >= +0.10 +5; <= -0.20 -10
  ['P4', '0.11', 5], ['P4', '0.10', 5], ['P4', '0.0999', 0],
  ['P4', '-0.1999', 0], ['P4', '-0.20', -10], ['P4', '-0.25', -10],
  // C1 closing cash: > 0 +10; <= 0 -40
  ['C1', '1', 10], ['C1', '0.01', 10], ['C1', '0', -40], ['C1', '-1', -40],
  // C2 runway: >= 6 +20; 3-6 +5; 1-3 -15; < 1 -30
  ['C2', '7', 20], ['C2', '6', 20], ['C2', '5.99', 5], ['C2', '3', 5],
  ['C2', '2.99', -15], ['C2', '1', -15], ['C2', '0.99', -30],
  // C4 cash cover: >= 2 +5; < 0.5 -10
  ['C4', '3', 5], ['C4', '2', 5], ['C4', '1.99', 0], ['C4', '0.5', 0], ['C4', '0.49', -10],
  // G1 growth: >= +0.20 +30; +0.05-+0.20 +15; -0.05-+0.05 0; -0.20--0.05 -15; < -0.20 -30
  ['G1', '0.25', 30], ['G1', '0.20', 30], ['G1', '0.1999', 15], ['G1', '0.05', 15],
  ['G1', '0.0499', 0], ['G1', '-0.05', 0], ['G1', '-0.0501', -15], ['G1', '-0.20', -15],
  ['G1', '-0.2001', -30],
  // K1 opex ratio: <= 0.60 +20; 0.60-0.85 +5; 0.85-1.0 -10; > 1.0 -25
  ['K1', '0.50', 20], ['K1', '0.60', 20], ['K1', '0.6001', 5], ['K1', '0.85', 5],
  ['K1', '0.8501', -10], ['K1', '1.0', -10], ['K1', '1.0001', -25],
  // K2 cost growth gap: <= 0 +15; > +0.10 -15
  ['K2', '-0.10', 15], ['K2', '0', 15], ['K2', '0.0001', 0], ['K2', '0.10', 0],
  ['K2', '0.1001', -15],
  // K3 spike count: 0 +10; 1-2 -5; >= 3 -15
  ['K3', '0', 10], ['K3', '1', -5], ['K3', '2', -5], ['K3', '3', -15], ['K3', '5', -15],
  // Q1 top-1 share: <= 0.20 +25; 0.20-0.35 +10; 0.35-0.50 -10; > 0.50 -25
  ['Q1', '0.10', 25], ['Q1', '0.20', 25], ['Q1', '0.2001', 10], ['Q1', '0.35', 10],
  ['Q1', '0.3501', -10], ['Q1', '0.50', -10], ['Q1', '0.5001', -25],
  // Q2 top-5 share: <= 0.60 +10; > 0.85 -10
  ['Q2', '0.50', 10], ['Q2', '0.60', 10], ['Q2', '0.6001', 0], ['Q2', '0.85', 0],
  ['Q2', '0.8501', -10],
  // Q3 collection: <= 30 +15; 30-60 0; 60-90 -10; > 90 -20
  ['Q3', '20', 15], ['Q3', '30', 15], ['Q3', '30.0001', 0], ['Q3', '60', 0],
  ['Q3', '60.0001', -10], ['Q3', '90', -10], ['Q3', '90.0001', -20],
  // B2 inflow/outflow: >= 1.1 +15; 0.9-1.1 0; < 0.9 -15
  ['B2', '1.20', 15], ['B2', '1.1', 15], ['B2', '1.0999', 0], ['B2', '0.9', 0],
  ['B2', '0.8999', -15],
  // B3 anomaly count: 0 +10; 1-2 -5; >= 3 -15
  ['B3', '0', 10], ['B3', '1', -5], ['B3', '2', -5], ['B3', '3', -15],
];

describe('§7.3 threshold table', () => {
  it.each(THRESHOLD_TABLE)('%s at %s scores %i', (rule, value, points) => {
    const definition = ALL_RULES[rule];
    expect(definition, `${rule} must exist in the config`).toBeDefined();
    expect(bandOf(definition!, new Decimal(value)).points).toBe(points);
  });

  it('covers every threshold declared in the config', () => {
    // The transcribed table above must exercise every band of every rule; a band nobody tests is a
    // band that could be silently wrong.
    for (const [name, rule] of Object.entries(ALL_RULES)) {
      for (const band of rule.bands) {
        const tested = THRESHOLD_TABLE.some(
          ([r, value]) => r === name && bandOf(rule, new Decimal(value)).result === band.result,
        );
        expect(tested, `${name} band "${band.result}" has no fixture`).toBe(true);
      }
    }
  });

  it('every rule ends in a catch-all band', () => {
    for (const [name, rule] of Object.entries(ALL_RULES)) {
      expect(rule.bands[rule.bands.length - 1]!.bound, `${name}`).toBeNull();
    }
  });
});

describe('§7.1 weights', () => {
  it('the six MVP dimensions sum to 100', () => {
    expect(TOTAL_WEIGHT).toBe(100);
  });

  it('declares exactly the six MVP dimensions with the documented weights', () => {
    expect(HEALTH_DIMENSION_KEYS).toEqual([
      'profitability', 'cash_flow', 'revenue_growth', 'cost_control',
      'customer_quality', 'banking_health',
    ]);
    expect(DIMENSION_WEIGHTS).toEqual({
      profitability: 25, cash_flow: 25, revenue_growth: 15,
      cost_control: 15, customer_quality: 10, banking_health: 10,
    });
  });
});

describe('§7.2 bands', () => {
  it.each([
    [0, 'at_risk'], [39, 'at_risk'], [40, 'needs_attention'], [59, 'needs_attention'],
    [60, 'stable'], [79, 'stable'], [80, 'strong'], [100, 'strong'],
  ])('%i is %s', (score, band) => {
    expect(bandFor(score)).toBe(band);
  });

  it('a NULL score has no band', () => {
    expect(bandFor(null)).toBeNull();
    expect(bandLabel(null)).toBeNull();
  });

  it.each([
    ['at_risk', 'At risk'], ['needs_attention', 'Needs attention'],
    ['stable', 'Stable'], ['strong', 'Strong'],
  ] as const)('%s reads "%s"', (band, label) => {
    expect(bandLabel(band)).toBe(label);
  });
});

describe('profitability substitutions', () => {
  it('reads operating margin when the organisation has no cost-of-sales accounts (§7.1)', () => {
    const snapshots = withMetric(
      withMetric(baselineSnapshots(), {
        key: 'gross_margin', value: null, missing: ['no_cost_of_sales_accounts'],
      }),
      { key: 'operating_margin', value: '0.55' },
    );
    const evaluation = evaluateProfitability(healthInput({ snapshots }));
    // P2 read operating margin at 0.55, which is the >= 0.50 band.
    expect(evaluation.rules.find((r) => r.rule === 'P2')!.points).toBe(10);
    expect(evaluation.requirements[1]!.keys).toEqual(['operating_margin']);
  });

  it('skips P3 and P4 rather than scoring a variance measured on two different bases', () => {
    const snapshots = withMetric(
      withMetric(baselineSnapshots(), {
        key: 'gross_margin.variance.trailing_3m_avg', value: '-0.09',
        warnings: ['basis_differs'],
      }),
      {
        key: 'net_profit.variance.prev_period', value: '-5000', unit: 'money',
        warnings: ['basis_differs'], components: { pct_change: '-0.60' },
      },
    );
    const rules = evaluateProfitability(healthInput({ snapshots })).rules;
    expect(rules.find((r) => r.rule === 'P3')!.points).toBe(0);
    expect(rules.find((r) => r.rule === 'P3')!.skipped_reason).toBe('no_comparable_trend');
    expect(rules.find((r) => r.rule === 'P4')!.points).toBe(0);
    expect(rules.find((r) => r.rule === 'P4')!.skipped_reason).toBe('no_comparable_prior_period');
  });

  it('names a loss in the negatives', () => {
    const snapshots = withMetric(baselineSnapshots(), {
      key: 'net_profit', value: '-4200', unit: 'money',
    });
    const evaluation = evaluateProfitability(healthInput({ snapshots }));
    expect(evaluation.negatives.map((n) => n.text)).toContain(
      'The business made a loss of £4,200 this month',
    );
  });
});

describe('C2 — a NULL runway is not automatically bad', () => {
  it('scores +20 when the runway is NULL because the business is cash generative', () => {
    const snapshots = withMetric(baselineSnapshots(), {
      key: 'cash_runway_months', value: null, unit: 'days', warnings: ['cash_positive'],
    });
    const rules = evaluateCashFlow(healthInput({ snapshots })).rules;
    expect(rules.find((r) => r.rule === 'C2')!.points).toBe(20);
    expect(rules.find((r) => r.rule === 'C2')!.result).toBe('cash generative');
  });

  it('skips C2 when the runway is NULL for any other reason', () => {
    const snapshots = withMetric(baselineSnapshots(), {
      key: 'cash_runway_months', value: null, unit: 'days',
    });
    const rule = evaluateCashFlow(healthInput({ snapshots })).rules.find((r) => r.rule === 'C2')!;
    expect(rule.points).toBe(0);
    expect(rule.skipped_reason).toBe('runway_unavailable');
  });
});

describe('C3 — the direction of cash over three months', () => {
  function withMovements(values: readonly (string | null)[]) {
    let snapshots = baselineSnapshots();
    PERIODS.slice(-3).forEach((periodId, index) => {
      snapshots = withMetric(snapshots, {
        key: 'net_cash_movement', value: values[index] ?? null, unit: 'money', periodId,
      });
    });
    return snapshots;
  }

  it('scores +15 when cash rose in two of the last three months', () => {
    const rules = evaluateCashFlow(healthInput({ snapshots: withMovements(['100', '-50', '200']) })).rules;
    expect(rules.find((r) => r.rule === 'C3')!.points).toBe(15);
  });

  it('scores -20 when cash did not rise in any of them', () => {
    const rules = evaluateCashFlow(healthInput({ snapshots: withMovements(['-100', '0', '-200']) })).rules;
    expect(rules.find((r) => r.rule === 'C3')!.points).toBe(-20);
  });

  it('scores nothing when exactly one of three rose', () => {
    const rules = evaluateCashFlow(healthInput({ snapshots: withMovements(['100', '-50', '-200']) })).rules;
    expect(rules.find((r) => r.rule === 'C3')!.points).toBe(0);
  });

  it('is skipped rather than assumed when a month is missing', () => {
    const rule = evaluateCashFlow(healthInput({ snapshots: withMovements(['100', null, '200']) }))
      .rules.find((r) => r.rule === 'C3')!;
    expect(rule.points).toBe(0);
    expect(rule.skipped_reason).toBe('insufficient_history');
  });
});

describe('G2 — revenue volatility', () => {
  it('is the population coefficient of variation', () => {
    // Six values with mean 100 and population standard deviation 10 → CV 0.1.
    const values = ['90', '110', '90', '110', '90', '110'].map((v) => new Decimal(v));
    expect(coefficientOfVariation(values)!.toDecimalPlaces(6).toString()).toBe('0.1');
  });

  it('refuses a coefficient against non-positive revenue', () => {
    expect(coefficientOfVariation([new Decimal('0'), new Decimal('0')])).toBeNull();
    expect(coefficientOfVariation([])).toBeNull();
  });

  function withRevenue(values: readonly string[]) {
    let snapshots = baselineSnapshots();
    PERIODS.forEach((periodId, index) => {
      snapshots = withMetric(snapshots, {
        key: 'revenue', value: values[index]!, unit: 'money', periodId,
      });
    });
    return snapshots;
  }

  it('rewards a steady six months', () => {
    const rules = evaluateRevenueGrowth(healthInput({
      snapshots: withRevenue(['100000', '101000', '99000', '100500', '99500', '100000']),
    })).rules;
    expect(rules.find((r) => r.rule === 'G2')!.points).toBe(10);
  });

  it('penalises a volatile six months', () => {
    const rules = evaluateRevenueGrowth(healthInput({
      snapshots: withRevenue(['20000', '180000', '30000', '170000', '40000', '160000']),
    })).rules;
    expect(rules.find((r) => r.rule === 'G2')!.points).toBe(-10);
  });

  it('needs six periods and says so rather than flattering a young business', () => {
    const snapshots = withoutMetric(baselineSnapshots(), 'revenue');
    const withFive = PERIODS.slice(1).reduce(
      (acc, periodId) => withMetric(acc, { key: 'revenue', value: '100000', unit: 'money', periodId }),
      snapshots,
    );
    const rule = evaluateRevenueGrowth(healthInput({ snapshots: withFive }))
      .rules.find((r) => r.rule === 'G2')!;
    expect(rule.points).toBe(0);
    expect(rule.skipped_reason).toBe('insufficient_history');
  });
});

describe('G1 — year on year, falling back to month on month', () => {
  it('prefers the year-on-year figure', () => {
    const evaluation = evaluateRevenueGrowth(healthInput());
    expect(evaluation.rules[0]!.points).toBe(15); // yoy 0.10
    expect(evaluation.metrics.some((m) => m.metric_key === 'revenue_growth_yoy')).toBe(true);
  });

  it('falls back to month on month when there is no year to compare with', () => {
    const snapshots = withMetric(baselineSnapshots(), { key: 'revenue_growth_yoy', value: null });
    const evaluation = evaluateRevenueGrowth(healthInput({ snapshots }));
    expect(evaluation.rules[0]!.points).toBe(0); // mom 0.02 → the -0.05..+0.05 band
    expect(evaluation.metrics.some((m) => m.metric_key === 'revenue_growth_mom')).toBe(true);
  });
});

describe('G3 — concentration drag', () => {
  it('subtracts 10 when one customer is at least half of revenue', () => {
    const snapshots = withMetric(baselineSnapshots(), {
      key: 'customer_concentration_top1', value: '0.50',
    });
    expect(evaluateRevenueGrowth(healthInput({ snapshots })).rules
      .find((r) => r.rule === 'G3')!.points).toBe(-10);
  });

  it('scores nothing just below the threshold', () => {
    const snapshots = withMetric(baselineSnapshots(), {
      key: 'customer_concentration_top1', value: '0.4999',
    });
    expect(evaluateRevenueGrowth(healthInput({ snapshots })).rules
      .find((r) => r.rule === 'G3')!.points).toBe(0);
  });
});

describe('K1/K2 skip rather than invent a comparison', () => {
  it('skips K1 when there is no revenue to divide by', () => {
    const snapshots = withMetric(baselineSnapshots(), { key: 'revenue', value: '0', unit: 'money' });
    const rule = evaluateCostControl(healthInput({ snapshots })).rules.find((r) => r.rule === 'K1')!;
    expect(rule.points).toBe(0);
    expect(rule.skipped_reason).toBe('no_revenue_to_compare');
  });

  it('scores K2 on the gap between cost growth and revenue growth', () => {
    const snapshots = [
      ...baselineSnapshots(),
      variance({ key: 'operating_expenses.variance.prev_period', value: '1000', unit: 'money', pctChange: '0.02' }),
      variance({ key: 'revenue.variance.prev_period', value: '9000', unit: 'money', pctChange: '0.09' }),
    ];
    const evaluation = evaluateCostControl(healthInput({ snapshots }));
    expect(evaluation.rules.find((r) => r.rule === 'K2')!.points).toBe(15);
    expect(evaluation.positives.map((p) => p.text)).toContain('Costs grew slower than revenue');
  });
});

describe('customer quality skips what it cannot know', () => {
  it('does not score Q3 as slow collection when there is no invoice data', () => {
    const snapshots = withMetric(baselineSnapshots(), {
      key: 'receivables_days', value: null, unit: 'days',
    });
    const rule = evaluateCustomerQuality(healthInput({ snapshots })).rules.find((r) => r.rule === 'Q3')!;
    expect(rule.points).toBe(0);
    expect(rule.skipped_reason).toBe('no_invoice_data');
  });
});

describe('B1 and B4', () => {
  function withClosingCash(values: readonly string[]) {
    let snapshots = baselineSnapshots();
    PERIODS.slice(-3).forEach((periodId, index) => {
      snapshots = withMetric(snapshots, {
        key: 'closing_cash', value: values[index]!, unit: 'money', periodId,
      });
    });
    return snapshots;
  }

  it('rewards three rising months', () => {
    const rules = evaluateBankingHealth(healthInput({ snapshots: withClosingCash(['100', '200', '300']) })).rules;
    expect(rules.find((r) => r.rule === 'B1')!.points).toBe(15);
  });

  it('penalises three falling months', () => {
    const rules = evaluateBankingHealth(healthInput({ snapshots: withClosingCash(['300', '200', '100']) })).rules;
    expect(rules.find((r) => r.rule === 'B1')!.points).toBe(-15);
  });

  it('scores nothing for a balance with no clear direction', () => {
    const rules = evaluateBankingHealth(healthInput({ snapshots: withClosingCash(['200', '100', '300']) })).rules;
    expect(rules.find((r) => r.rule === 'B1')!.points).toBe(0);
  });

  it.each([[1, 10], [0.5, -5]])('scores B4 at coverage %s as %i', (ratio, points) => {
    const rules = evaluateBankingHealth(healthInput({ bankCoverageRatio: ratio })).rules;
    expect(rules.find((r) => r.rule === 'B4')!.points).toBe(points);
  });
});

describe('a rule that reads nothing scores nothing', () => {
  it('records why every skipped rule was skipped', () => {
    const snapshots = [snapshot({ key: 'revenue', value: '1000', unit: 'money', periodId: CURRENT })];
    const input = healthInput({ snapshots });
    for (const evaluate of [
      evaluateProfitability, evaluateCashFlow, evaluateRevenueGrowth,
      evaluateCostControl, evaluateCustomerQuality, evaluateBankingHealth,
    ]) {
      for (const rule of evaluate(input).rules) {
        if (rule.points === 0 && rule.result === 'skipped') {
          expect(rule.skipped_reason, `${rule.rule} must say why`).not.toBeNull();
        }
      }
    }
  });
});
