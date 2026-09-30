import { describe, expect, it } from 'vitest';

import { Decimal } from '@/core/money';
import {
  COMPARISON_PERIOD_COUNT,
  VARIANCE_BASE_METRICS,
  VARIANCE_SUFFIXES,
  computeRevenueGrowth,
  computeVariance,
  varianceKey,
  type VarianceInput,
  type VarianceObservation,
  type VariancePeriodInput,
  type VarianceSuffix,
} from '@/modules/financial-engine';
import type { MetricResult } from '@/modules/financial-engine';

/**
 * FINANCIAL_ENGINE.md §3.2. Most of these tests assert a REFUSAL: a percentage across zero, a
 * percentage across a sign change, an average of two months called three, a comparison between two
 * different bases. Each of those would look like a number on a dashboard and mean nothing.
 */

const P0 = 'period-2026-03';
const P1 = 'period-2026-02';
const P2 = 'period-2026-01';
const P3 = 'period-2025-12';
const PY = 'period-2025-03';

function observation(over: Partial<VarianceObservation> = {}): VarianceObservation {
  return {
    dimensionId: null,
    value: '1000.00',
    basis: 'ledger',
    assurance: 'calculated',
    completeness: 1,
    ...over,
  };
}

function period(periodId: string | null, ...observations: VarianceObservation[]): VariancePeriodInput {
  return { periodId, observations };
}

function input(over: Partial<VarianceInput> = {}): VarianceInput {
  return {
    baseKey: 'revenue',
    unit: 'money',
    dimensionType: 'none',
    currency: 'GBP',
    suffix: 'prev_period',
    current: { periodId: P0, observations: [observation({ value: '1200.00' })] },
    comparisons: [period(P1, observation({ value: '1000.00' }))],
    ...over,
  };
}

const resolve = (periodId: string, key: string, dimensionId: string | null): string =>
  `snap:${periodId}:${key}:${dimensionId ?? '-'}`;

function only(results: readonly MetricResult[]): MetricResult {
  expect(results).toHaveLength(1);
  return results[0] as MetricResult;
}

function byDimension(results: readonly MetricResult[], dimensionId: string | null): MetricResult {
  const found = results.find((r) => r.dimensionId === dimensionId);
  if (found === undefined) throw new Error(`no variance for ${dimensionId ?? '-'}`);
  return found;
}

// ---------------------------------------------------------------------------------------------

describe('the variance registry (§3.2)', () => {
  it('names the three comparison suffixes and how many periods each needs', () => {
    expect([...VARIANCE_SUFFIXES]).toEqual(['prev_period', 'same_period_last_year', 'trailing_3m_avg']);
    expect(COMPARISON_PERIOD_COUNT.prev_period).toBe(1);
    expect(COMPARISON_PERIOD_COUNT.same_period_last_year).toBe(1);
    expect(COMPARISON_PERIOD_COUNT.trailing_3m_avg).toBe(3);
  });

  it('names every base metric §3.2 lists', () => {
    expect([...VARIANCE_BASE_METRICS]).toEqual([
      'revenue', 'gross_profit', 'gross_margin', 'operating_expenses', 'operating_profit',
      'net_profit', 'net_margin', 'closing_cash', 'net_cash_movement', 'receivables', 'payables',
      // ADR-120: §8.2's receivables/payables deterioration rules read `*_days.variance.prev_period`.
      'receivables_days', 'payables_days',
      'expense_by_category', 'expense_by_account',
    ]);
  });

  it('builds the key as B.variance.suffix', () => {
    expect(varianceKey('revenue', 'prev_period')).toBe('revenue.variance.prev_period');
    expect(varianceKey('expense_by_category', 'trailing_3m_avg'))
      .toBe('expense_by_category.variance.trailing_3m_avg');
  });
});

describe('an ordinary comparison (§3.2)', () => {
  const result = only(computeVariance(input(), resolve));

  it('writes the absolute change and the percentage', () => {
    expect(result.key).toBe('revenue.variance.prev_period');
    expect(result.value).toBe('200.00');
    expect(result.components.pct_change).toBe('0.200000');
    expect(result.components.current).toBe('1200.00');
    expect(result.components.comparison).toBe('1000.00');
    expect(result.components.comparison_period_id).toBe(P1);
    expect(result.components.comparison_basis).toBe('ledger');
  });

  it('points at both snapshots so a reader can descend into each side', () => {
    expect(result.evidenceQuery).toEqual({
      kind: 'derived',
      components: [
        { name: 'current', snapshot_id: `snap:${P0}:revenue:-` },
        { name: 'comparison', snapshot_id: `snap:${P1}:revenue:-` },
      ],
    });
  });

  it('compares against the same month last year under the year-on-year suffix', () => {
    const yoy = only(computeVariance(input({
      suffix: 'same_period_last_year',
      comparisons: [period(PY, observation({ value: '800.00' }))],
    }), resolve));
    expect(yoy.key).toBe('revenue.variance.same_period_last_year');
    expect(yoy.value).toBe('400.00');
    expect(yoy.components.pct_change).toBe('0.500000');
  });

  it('reports a ratio base in ratio points', () => {
    const margin = only(computeVariance(input({
      baseKey: 'gross_margin',
      unit: 'ratio',
      current: { periodId: P0, observations: [observation({ value: '0.420000' })] },
      comparisons: [period(P1, observation({ value: '0.500000' }))],
    }), resolve));
    expect(margin.unit).toBe('ratio');
    expect(margin.currency).toBeNull();
    expect(margin.value).toBe('-0.080000');
  });
});

describe('a percentage that would be meaningless (§3.2)', () => {
  it('writes the absolute change but refuses the percentage when the comparison is zero', () => {
    const result = only(computeVariance(input({
      comparisons: [period(P1, observation({ value: '0.00' }))],
    }), resolve));
    expect(result.value).toBe('1200.00');
    expect(result.components.pct_change).toBeNull();
    expect(result.dataQuality.missing).toContain('comparison_is_zero');
  });

  it('refuses the percentage across a sign change, and says which case it was', () => {
    // "−£2,000 became +£3,000, so costs fell 250%" is not a sentence anybody should read.
    const result = only(computeVariance(input({
      current: { periodId: P0, observations: [observation({ value: '3000.00' })] },
      comparisons: [period(P1, observation({ value: '-2000.00' }))],
    }), resolve));
    expect(result.value).toBe('5000.00');
    expect(result.components.pct_change).toBeNull();
    expect(result.dataQuality.warnings).toContain('sign_change');
  });

  it('divides by the MAGNITUDE of the comparison, so a shrinking loss reads as an improvement', () => {
    const result = only(computeVariance(input({
      current: { periodId: P0, observations: [observation({ value: '-500.00' })] },
      comparisons: [period(P1, observation({ value: '-1000.00' }))],
    }), resolve));
    expect(result.value).toBe('500.00');
    expect(result.components.pct_change).toBe('0.500000');
  });
});

describe('the trailing three-month average (§3.2)', () => {
  it('averages the three months', () => {
    const result = only(computeVariance(input({
      suffix: 'trailing_3m_avg',
      current: { periodId: P0, observations: [observation({ value: '1000.00' })] },
      comparisons: [
        period(P1, observation({ value: '900.00' })),
        period(P2, observation({ value: '600.00' })),
        period(P3, observation({ value: '300.00' })),
      ],
    }), resolve));
    expect(result.components.comparison).toBe('600.00');
    expect(result.value).toBe('400.00');
    expect(result.components.comparison_period_id).toBeNull();
    expect(result.components.comparison_period_ids).toEqual([P1, P2, P3]);
  });

  it('names each of the three comparison snapshots separately', () => {
    const result = only(computeVariance(input({
      suffix: 'trailing_3m_avg',
      comparisons: [
        period(P1, observation()), period(P2, observation()), period(P3, observation()),
      ],
    }), resolve));
    expect(result.evidenceQuery).toEqual({
      kind: 'derived',
      components: [
        { name: 'current', snapshot_id: `snap:${P0}:revenue:-` },
        { name: 'comparison_1', snapshot_id: `snap:${P1}:revenue:-` },
        { name: 'comparison_2', snapshot_id: `snap:${P2}:revenue:-` },
        { name: 'comparison_3', snapshot_id: `snap:${P3}:revenue:-` },
      ],
    });
  });

  it('refuses to average two months and call it three', () => {
    const result = only(computeVariance(input({
      suffix: 'trailing_3m_avg',
      comparisons: [
        period(P1, observation()), period(P2, observation()), period(null),
      ],
    }), resolve));
    expect(result.value).toBeNull();
    expect(result.dataQuality.missing).toEqual(['insufficient_history']);
  });

  it('refuses when one of the three values could not be computed', () => {
    const result = only(computeVariance(input({
      suffix: 'trailing_3m_avg',
      comparisons: [
        period(P1, observation()), period(P2, observation({ value: null })), period(P3, observation()),
      ],
    }), resolve));
    expect(result.value).toBeNull();
    expect(result.dataQuality.missing).toEqual(['insufficient_history']);
  });

  it('refuses when the caller supplies the wrong number of comparison periods', () => {
    const result = only(computeVariance(input({
      suffix: 'trailing_3m_avg',
      comparisons: [period(P1, observation())],
    }), resolve));
    expect(result.value).toBeNull();
    expect(result.dataQuality.missing).toEqual(['insufficient_history']);
  });
});

describe('a comparison that does not exist (§3.2)', () => {
  it('reports comparison_period_missing when there is no previous period', () => {
    const result = only(computeVariance(input({ comparisons: [period(null)] }), resolve));
    expect(result.value).toBeNull();
    expect(result.dataQuality.missing).toEqual(['comparison_period_missing']);
  });

  it('reports comparison_period_missing when the metric was never written for that period', () => {
    const result = only(computeVariance(input({ comparisons: [period(P1)] }), resolve));
    expect(result.value).toBeNull();
    expect(result.dataQuality.missing).toEqual(['comparison_period_missing']);
  });

  it('propagates the current period’s own reason when the current value is NULL', () => {
    const result = only(computeVariance(input({
      current: {
        periodId: P0,
        observations: [observation({ value: null, missing: ['no_prior_trial_balance'] })],
      },
    }), resolve));
    expect(result.value).toBeNull();
    expect(result.dataQuality.missing).toContain('no_prior_trial_balance');
  });

  it('falls back to a stated reason when the current value is NULL without one', () => {
    const result = only(computeVariance(input({
      current: { periodId: P0, observations: [observation({ value: null })] },
    }), resolve));
    expect(result.value).toBeNull();
    expect(result.dataQuality.missing).toContain('no_source_covers_period');
  });
});

describe('the weakest assurance wins (§3.2)', () => {
  it('keeps the softer level even when the stronger one comes second', () => {
    const result = only(computeVariance(input({
      current: { periodId: P0, observations: [observation({ assurance: 'estimated' })] },
      comparisons: [period(P1, observation({ assurance: 'verified' }))],
    }), resolve));
    expect(result.assurance).toBe('estimated');
  });
});

describe('a metric that was written last month but not this one', () => {
  it('has no variance, and says the current side is what is missing', () => {
    const result = only(computeVariance(input({
      current: { periodId: P0, observations: [] },
      comparisons: [period(P1, observation({ value: '1000.00' }))],
    }), resolve));
    expect(result.value).toBeNull();
    expect(result.components.current).toBeNull();
    expect(result.components.comparison).toBe('1000.00');
    expect(result.dataQuality.missing).toContain('comparison_period_missing');
  });

  it('reports no basis at all when neither side contributed one', () => {
    const result = only(computeVariance(input({
      baseKey: 'expense_by_category',
      dimensionType: 'standard_category',
      suffix: 'trailing_3m_avg',
      current: { periodId: P0, observations: [] },
      comparisons: [
        period(P1, observation({ dimensionId: 'marketing', value: '500.00' })),
        period(P2, observation({ dimensionId: 'marketing', value: '400.00' })),
        period(null),
      ],
    }), resolve));
    expect(result.dimensionId).toBe('marketing');
    expect(result.value).toBeNull();
    expect(result.basis).toBe('none');
    expect(result.dataQuality.missing).toEqual(['insufficient_history']);
  });
});

describe('two periods measured differently (§3.2)', () => {
  const result = only(computeVariance(input({
    current: { periodId: P0, observations: [observation({ value: '1200.00', basis: 'bank' })] },
    comparisons: [period(P1, observation({ value: '1000.00', basis: 'period_balances' }))],
  }), resolve));

  it('warns, downgrades to an estimate and marks the basis mixed', () => {
    // Consumers must treat this variance as NULL: a trial balance against a bank statement can move
    // a "figure" by tens of thousands without a penny changing hands (§8.1, ADR-030.3).
    expect(result.dataQuality.warnings).toContain('basis_differs');
    expect(result.assurance).toBe('estimated');
    expect(result.basis).toBe('mixed');
  });

  it('still writes the absolute value for a reader who understands both bases', () => {
    expect(result.value).toBe('200.00');
  });
});

describe('dimension variances (§3.2)', () => {
  const dimensioned = (
    currentDims: ReadonlyArray<[string, string]>,
    comparisonDims: ReadonlyArray<[string, string]>,
  ): VarianceInput => input({
    baseKey: 'expense_by_category',
    dimensionType: 'standard_category',
    current: {
      periodId: P0,
      observations: currentDims.map(([id, v]) => observation({ dimensionId: id, value: v })),
    },
    comparisons: [period(
      P1,
      ...comparisonDims.map(([id, v]) => observation({ dimensionId: id, value: v })),
    )],
  });

  it('writes one variance per dimension present in either period', () => {
    const results = computeVariance(
      dimensioned([['marketing', '500.00'], ['payroll', '2000.00']], [['payroll', '1800.00'], ['depreciation', '100.00']]),
      resolve,
    );
    expect(results.map((r) => r.dimensionId)).toEqual(['depreciation', 'marketing', 'payroll']);
  });

  it('gives a category that is new this month a zero comparison and no percentage', () => {
    const results = computeVariance(dimensioned([['marketing', '500.00']], [['payroll', '1800.00']]), resolve);
    const marketing = byDimension(results, 'marketing');
    expect(marketing.value).toBe('500.00');
    expect(marketing.components.comparison).toBe('0.00');
    expect(marketing.components.pct_change).toBeNull();
    expect(marketing.dataQuality.warnings).toContain('new_in_period');
    expect(marketing.dataQuality.missing).toContain('comparison_is_zero');
  });

  it('reports a category that has fallen away as a move to zero', () => {
    const results = computeVariance(dimensioned([['marketing', '500.00']], [['payroll', '1800.00']]), resolve);
    const payroll = byDimension(results, 'payroll');
    expect(payroll.components.current).toBe('0.00');
    expect(payroll.value).toBe('-1800.00');
    expect(payroll.components.pct_change).toBe('-1.000000');
  });

  it('orders dimensions deterministically whatever order they arrived in', () => {
    const forwards = computeVariance(
      dimensioned([['payroll', '1.00'], ['marketing', '2.00']], [['depreciation', '3.00']]), resolve,
    );
    const backwards = computeVariance(
      dimensioned([['marketing', '2.00'], ['payroll', '1.00']], [['depreciation', '3.00']]), resolve,
    );
    expect(JSON.stringify(backwards)).toBe(JSON.stringify(forwards));
  });
});

describe('revenue_growth_mom and revenue_growth_yoy (§3.2)', () => {
  const variances = [
    ...computeVariance(input(), resolve),
    ...computeVariance(input({
      suffix: 'same_period_last_year',
      comparisons: [period(PY, observation({ value: '800.00' }))],
    }), resolve),
  ];
  const growth = computeRevenueGrowth(variances, P0, resolve);

  it('writes both as ratio metrics of their own', () => {
    expect(growth.map((r) => r.key)).toEqual(['revenue_growth_mom', 'revenue_growth_yoy']);
    expect(growth.every((r) => r.unit === 'ratio' && r.currency === null)).toBe(true);
  });

  it('carries the percentage change of the corresponding variance', () => {
    expect(growth[0]?.value).toBe('0.200000');
    expect(growth[1]?.value).toBe('0.500000');
  });

  it('inherits the variance’s NULL rules exactly', () => {
    const zeroComparison = computeVariance(input({
      comparisons: [period(P1, observation({ value: '0.00' }))],
    }), resolve);
    const mom = computeRevenueGrowth(zeroComparison, P0, resolve);
    expect(mom[0]?.value).toBeNull();
    expect(mom[0]?.dataQuality.missing).toContain('comparison_is_zero');
  });

  it('writes nothing when the underlying variance was not computed', () => {
    expect(computeRevenueGrowth([], P0, resolve)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Property tests
// ---------------------------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pence(rng: () => number, min: number, max: number): string {
  return (Math.floor(min * 100 + rng() * (max - min) * 100) / 100).toFixed(2);
}

describe('property: the prev_period identity holds for every generated pair (§3.2)', () => {
  it('B.variance.prev_period.value(P) = B(P) − B(P−1) whenever both are present', () => {
    for (let seed = 2000; seed < 2200; seed += 1) {
      const rng = mulberry32(seed);
      const current = pence(rng, -5000, 5000);
      const previous = pence(rng, -5000, 5000);
      const result = only(computeVariance(input({
        current: { periodId: P0, observations: [observation({ value: current })] },
        comparisons: [period(P1, observation({ value: previous }))],
      }), resolve));
      expect(result.value, `seed ${seed}`)
        .toBe(new Decimal(current).minus(previous).toFixed(2));
    }
  });

  it('pct_change is written exactly when the comparison is non-zero and the signs agree', () => {
    for (let seed = 3000; seed < 3200; seed += 1) {
      const rng = mulberry32(seed);
      const current = new Decimal(pence(rng, -3000, 3000));
      const previous = new Decimal(pence(rng, -3000, 3000));
      const result = only(computeVariance(input({
        current: { periodId: P0, observations: [observation({ value: current.toFixed(2) })] },
        comparisons: [period(P1, observation({ value: previous.toFixed(2) }))],
      }), resolve));
      const signsAgree = current.isZero() || previous.isZero()
        ? true
        : current.greaterThan(0) === previous.greaterThan(0);
      const expected = !previous.isZero() && signsAgree;
      expect(result.components.pct_change !== null, `seed ${seed}`).toBe(expected);
      if (expected) {
        expect(result.components.pct_change)
          .toBe(current.minus(previous).dividedBy(previous.abs()).toDecimalPlaces(6).toFixed(6));
      }
    }
  });
});

describe('determinism (§1.1)', () => {
  it('produces byte-identical output for the same inputs, twice', () => {
    for (const suffix of VARIANCE_SUFFIXES) {
      const comparisons = suffix === 'trailing_3m_avg'
        ? [period(P1, observation()), period(P2, observation({ value: '500.00' })), period(P3, observation())]
        : [period(P1, observation())];
      const spec = input({ suffix: suffix as VarianceSuffix, comparisons });
      expect(JSON.stringify(computeVariance(spec, resolve)))
        .toBe(JSON.stringify(computeVariance(spec, resolve)));
    }
  });
});
