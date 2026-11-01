import { describe, expect, it } from 'vitest';
import { ValidationError } from '@/core/errors';
import {
  DEFAULT_TARGETS, assessTargets, isTargetMonth, parseExpectedRevision, parseMonthlyTargets, parseTargetMonth,
  type TargetActuals, type TargetAssessment, type TargetKey,
} from '@/modules/targets';

/**
 * Monthly targets (docs/DEPARTMENT_DASHBOARD_PLAN.md). The assessment is the prototype's
 * `assessTargets` (operations-model.js); the September sample month is its own data, so the expected
 * statuses are what the prototype shows for it.
 */

const item = (a: TargetAssessment, key: TargetKey) => a.items.find((i) => i.key === key)!;

const issuesOf = (fn: () => unknown): Array<{ path: string; message: string }> => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ValidationError);
    return (e as ValidationError).issues;
  }
  throw new Error('expected a ValidationError');
};

describe('the default targets', () => {
  it('are the prototype starting values, money as strings', () => {
    expect(DEFAULT_TARGETS).toEqual({ workflow: 80, sales: '300000', marketing: '15000', costRatio: '65', marketingRatio: '5' });
  });

  it('pass their own validation', () => {
    expect(parseMonthlyTargets(DEFAULT_TARGETS)).toEqual({
      workflow: 80, sales: '300000.00', marketing: '15000.00', costRatio: '65.0', marketingRatio: '5.0',
    });
  });
});

describe('assessTargets, as the prototype', () => {
  // operations-model.js monthlyActuals, 2026-09: sales 278,000, cost 176,000, marketing 18,000, workflow 78.
  const september: TargetActuals = { sales: '278000', costs: '176000', marketing: '18000', workflowCompleted: 78 };
  const result = assessTargets(september, DEFAULT_TARGETS);

  it('returns the five items in the prototype order with its labels and directions', () => {
    expect(result.items.map((i) => [i.key, i.label, i.unit, i.direction])).toEqual([
      ['workflow', 'Workflow completion', 'tasks', 'min'],
      ['sales', 'Sales', 'money', 'min'],
      ['marketing', 'Marketing spend', 'money', 'max'],
      ['costRatio', 'Cost / revenue', 'percent', 'max'],
      ['marketingRatio', 'Marketing / revenue', 'percent', 'max'],
    ]);
  });

  it('judges September as the prototype does: 4 of 5 need attention', () => {
    expect(item(result, 'workflow').status).toBe('attention'); // 78 < 80
    expect(item(result, 'sales').status).toBe('attention'); // 278,000 < 300,000
    expect(item(result, 'marketing').status).toBe('attention'); // 18,000 > 15,000
    expect(item(result, 'costRatio').status).toBe('on-track'); // 63.309…% ≤ 65%
    expect(item(result, 'marketingRatio').status).toBe('attention'); // 6.474…% > 5%
    expect(result.warnings).toBe(4);
    expect(result.missing).toEqual([]);
    expect(result.hasActuals).toBe(true);
  });

  it('computes the ratios exactly with Decimal and reports them to six places', () => {
    expect(item(result, 'costRatio').actual).toBe('63.309353'); // 176000 / 278000 × 100
    expect(item(result, 'marketingRatio').actual).toBe('6.474820'); // 18000 / 278000 × 100
    expect(item(result, 'sales').actual).toBe('278000.00');
    expect(item(result, 'sales').target).toBe('300000.00');
    expect(item(result, 'workflow').actual).toBe('78');
  });

  it('gives the meter as actual ÷ target, held to 0–100', () => {
    expect(item(result, 'workflow').meterPercent).toBe('97.5'); // 78 / 80
    expect(item(result, 'marketing').meterPercent).toBe('100.0'); // 120% held to 100
    expect(item(result, 'sales').meterPercent).toBe('92.7'); // 278 / 300 = 92.666…
  });

  it('counts a met target exactly at the boundary as on track, in both directions', () => {
    const exact = assessTargets(
      { sales: '300000.00', costs: '195000', marketing: '15000', workflowCompleted: 80 },
      DEFAULT_TARGETS,
    );
    expect(exact.items.map((i) => i.status)).toEqual(['on-track', 'on-track', 'on-track', 'on-track', 'on-track']);
    expect(exact.warnings).toBe(0);
  });

  it('a zero marketing ceiling with no spend is on track and the meter is full', () => {
    const a = assessTargets(september, { ...DEFAULT_TARGETS, marketing: '0' });
    expect(item(a, 'marketing').status).toBe('attention');
    const none = assessTargets({ ...september, marketing: '0' }, { ...DEFAULT_TARGETS, marketing: '0' });
    expect(item(none, 'marketing').status).toBe('on-track');
    expect(item(none, 'marketing').meterPercent).toBe('100.0');
  });
});

describe('missing actuals are missing, never judged', () => {
  it('a null actual makes its item missing, and the ratios that need it', () => {
    const a = assessTargets({ sales: null, costs: '176000', marketing: '18000', workflowCompleted: 78 }, DEFAULT_TARGETS);
    expect(item(a, 'sales').status).toBe('missing');
    expect(item(a, 'sales').actual).toBeNull();
    expect(item(a, 'sales').meterPercent).toBeNull();
    expect(item(a, 'costRatio').status).toBe('missing');
    expect(item(a, 'marketingRatio').status).toBe('missing');
    expect(a.missing).toEqual(['sales', 'costRatio', 'marketingRatio']);
    expect(a.warnings).toBe(2); // workflow and marketing; a missing item is not a warning
    expect(a.hasActuals).toBe(true);
  });

  it('no costs makes only the cost ratio missing', () => {
    const a = assessTargets({ sales: '278000', costs: null, marketing: '18000', workflowCompleted: 78 }, DEFAULT_TARGETS);
    expect(a.missing).toEqual(['costRatio']);
  });

  it('a ratio over zero (or negative) sales is missing, not infinite', () => {
    const zero = assessTargets({ sales: '0', costs: '100', marketing: '10', workflowCompleted: 1 }, DEFAULT_TARGETS);
    expect(item(zero, 'sales').status).toBe('attention');
    expect(zero.missing).toEqual(['costRatio', 'marketingRatio']);
    const negative = assessTargets({ sales: '-50', costs: '100', marketing: '10', workflowCompleted: 1 }, DEFAULT_TARGETS);
    expect(negative.missing).toEqual(['costRatio', 'marketingRatio']);
  });

  it('a month with no figures at all has nothing judged (the prototype’s “Data completion required”)', () => {
    const a = assessTargets({ sales: null, costs: null, marketing: null, workflowCompleted: null }, DEFAULT_TARGETS);
    expect(a.items).toHaveLength(5);
    expect(a.items.every((i) => i.status === 'missing')).toBe(true);
    expect(a.warnings).toBe(0);
    expect(a.hasActuals).toBe(false);
  });

  it('an unreadable figure is treated as missing rather than as zero', () => {
    const a = assessTargets({ sales: 'abc', costs: '1', marketing: '1', workflowCompleted: 1 }, DEFAULT_TARGETS);
    expect(item(a, 'sales').status).toBe('missing');
  });
});

describe('validation of the targets dialog', () => {
  const valid = { workflow: 80, sales: '300000', marketing: '15000', costRatio: '65', marketingRatio: '5' };

  it('accepts numbers or decimal strings and normalises them', () => {
    expect(parseMonthlyTargets({ workflow: '12', sales: 1234.5, marketing: 0, costRatio: 62.5, marketingRatio: '4.5' })).toEqual({
      workflow: 12, sales: '1234.50', marketing: '0.00', costRatio: '62.5', marketingRatio: '4.5',
    });
  });

  it('refuses a workflow target that is not a whole number from 1 to 1,000,000', () => {
    for (const workflow of [0, -1, 1.5, 1_000_001, 'x', null]) {
      expect(issuesOf(() => parseMonthlyTargets({ ...valid, workflow })).map((i) => i.path)).toEqual(['workflow']);
    }
    expect(parseMonthlyTargets({ ...valid, workflow: 1_000_000 }).workflow).toBe(1_000_000);
  });

  it('wants sales above zero and marketing at least zero, both money to the penny', () => {
    expect(issuesOf(() => parseMonthlyTargets({ ...valid, sales: '0' })).map((i) => i.path)).toEqual(['sales']);
    expect(issuesOf(() => parseMonthlyTargets({ ...valid, sales: '10.005' })).map((i) => i.path)).toEqual(['sales']);
    expect(issuesOf(() => parseMonthlyTargets({ ...valid, sales: '100000000.01' })).map((i) => i.path)).toEqual(['sales']);
    expect(issuesOf(() => parseMonthlyTargets({ ...valid, marketing: '-1' })).map((i) => i.path)).toEqual(['marketing']);
    expect(issuesOf(() => parseMonthlyTargets({ ...valid, sales: '1e3' })).map((i) => i.path)).toEqual(['sales']);
    expect(issuesOf(() => parseMonthlyTargets({ ...valid, sales: Infinity })).map((i) => i.path)).toEqual(['sales']);
    expect(parseMonthlyTargets({ ...valid, marketing: '0' }).marketing).toBe('0.00');
  });

  it('wants each ratio from 0 to 1000, to one decimal place', () => {
    expect(issuesOf(() => parseMonthlyTargets({ ...valid, costRatio: '1000.1' })).map((i) => i.path)).toEqual(['costRatio']);
    expect(issuesOf(() => parseMonthlyTargets({ ...valid, costRatio: '-0.1' })).map((i) => i.path)).toEqual(['costRatio']);
    expect(issuesOf(() => parseMonthlyTargets({ ...valid, marketingRatio: '5.25' })).map((i) => i.path)).toEqual(['marketingRatio']);
    expect(parseMonthlyTargets({ ...valid, costRatio: '1000', marketingRatio: '0' })).toMatchObject({ costRatio: '1000.0', marketingRatio: '0.0' });
  });

  it('reports every bad field at once', () => {
    expect(issuesOf(() => parseMonthlyTargets({})).map((i) => i.path))
      .toEqual(['workflow', 'sales', 'marketing', 'costRatio', 'marketingRatio']);
  });

  it('takes a month as YYYY-MM from 2020-01 to 2100-12', () => {
    expect(isTargetMonth('2026-09')).toBe(true);
    expect(isTargetMonth('2100-12')).toBe(true);
    for (const bad of ['2026-13', '2026-00', '2026-9', '2019-12', '2101-01', '2026-09-01', 202609, null]) {
      expect(isTargetMonth(bad)).toBe(false);
    }
    expect(parseTargetMonth('2026-09')).toBe('2026-09');
    expect(issuesOf(() => parseTargetMonth('Sept')).map((i) => i.path)).toEqual(['month']);
  });

  it('takes the expected revision as a whole number, 0 for nothing saved', () => {
    expect(parseExpectedRevision(0)).toBe(0);
    expect(parseExpectedRevision(7)).toBe(7);
    for (const bad of [-1, 1.5, '1', null, undefined]) {
      expect(issuesOf(() => parseExpectedRevision(bad)).map((i) => i.path)).toEqual(['expectedRevision']);
    }
  });
});
