import { describe, it, expect } from 'vitest';
import { Decimal } from '@/core/money';
import {
  PROFITABILITY_RULES, TEMPLATE_IDS, bandOf, evaluateCustomerQuality, evaluateProfitability,
  evaluateRevenueGrowth, sentence, type TemplateId,
} from '@/modules/health';
import { PERIODS, baselineSnapshots, healthInput, withMetric } from '../fixtures/health';

/**
 * Factor sentences (§7.3 templates, §7.4 `positives_structured`).
 *
 * Every template is rendered here, because a template nobody renders is a sentence nobody has read
 * — and these strings go on the first line a business owner sees about their own month.
 */

const VALUES: Readonly<Record<TemplateId, Record<string, string>>> = {
  net_margin_healthy: { net_margin: '0.083' },
  gross_margin_improved: { delta: '0.031' },
  made_a_loss: { net_profit: '4200' },
  gross_margin_fell: { delta: '0.031' },
  runway_months: { runway: '4.5' },
  cash_fell_months: { n: '3' },
  cash_grew: { net_cash_movement: '4200' },
  revenue_up_yoy: { pct: '0.18', comparison: 'the same month last year' },
  revenue_down: { pct: '0.22', comparison: 'last month' },
  revenue_volatile: {},
  costs_grew_slower: {},
  category_spend_jumped: { category: 'marketing', pct: '0.85' },
  no_customer_dominant: { share: '0.18' },
  customer_concentration: { share: '0.62' },
  collections_slow: { days: '74' },
  bank_balance_rising: {},
  bank_balance_falling: {},
  bank_anomalies: { count: '3' },
};

describe('every template renders', () => {
  it.each(TEMPLATE_IDS)('%s', (templateId) => {
    const rendered = sentence(templateId, VALUES[templateId], 'GBP', ['snap-1', null]);
    expect(rendered.text.length).toBeGreaterThan(5);
    expect(rendered.text).not.toContain('undefined');
    expect(rendered.text).not.toContain('NaN');
    expect(rendered.template_id).toBe(templateId);
    // An in-flight snapshot has no id; pinning null would be a dead link in the panel.
    expect(rendered.snapshot_ids).toEqual(['snap-1']);
  });

  it('renders margins as percentage POINTS, not as a percentage of a percentage', () => {
    expect(sentence('gross_margin_fell', { delta: '-0.031' }, 'GBP').text)
      .toBe('Gross margin fell 3.1 pts over the last 3 months');
  });

  it('renders money in the organisation’s own currency', () => {
    expect(sentence('made_a_loss', { net_profit: '4200' }, 'EUR').text).toContain('€4,200');
    expect(sentence('made_a_loss', { net_profit: '4200' }, 'GBP').text).toContain('£4,200');
  });

  it('carries the numbers as typed values as well as in the prose (ADR-032.1)', () => {
    const rendered = sentence('net_margin_healthy', { net_margin: '0.083' }, 'GBP');
    expect(rendered.values).toEqual({ net_margin: '0.083' });
  });
});

describe('the negative factors', () => {
  it('names a concentration risk when one customer dominates', () => {
    const snapshots = withMetric(baselineSnapshots(), {
      key: 'customer_concentration_top1', value: '0.62',
    });
    const evaluation = evaluateCustomerQuality(healthInput({ snapshots }));
    expect(evaluation.negatives.map((n) => n.text)).toContain(
      'Your largest customer is 62.0% of revenue — a concentration risk',
    );
  });

  it('names slow collection only when it scores against the business', () => {
    const slow = withMetric(baselineSnapshots(), {
      key: 'receivables_days', value: '74', unit: 'days',
    });
    expect(evaluateCustomerQuality(healthInput({ snapshots: slow }))
      .negatives.map((n) => n.text)).toContain('Customers take about 74 days to pay');

    const prompt = withMetric(baselineSnapshots(), {
      key: 'receivables_days', value: '21', unit: 'days',
    });
    expect(evaluateCustomerQuality(healthInput({ snapshots: prompt }))
      .negatives.map((n) => n.template_id)).not.toContain('collections_slow');
  });

  it('names a revenue fall against the period it was measured against', () => {
    const snapshots = withMetric(
      withMetric(baselineSnapshots(), { key: 'revenue_growth_yoy', value: null }),
      { key: 'revenue_growth_mom', value: '-0.22' },
    );
    expect(evaluateRevenueGrowth(healthInput({ snapshots })).negatives.map((n) => n.text))
      .toContain('Revenue is down 22.0% on last month');
  });

  it('names a margin improvement in the positives', () => {
    const snapshots = withMetric(baselineSnapshots(), {
      key: 'gross_margin.variance.trailing_3m_avg', value: '0.031',
    });
    expect(evaluateProfitability(healthInput({ snapshots })).positives.map((n) => n.text))
      .toContain('Gross margin improved 3.1 pts over the last 3 months');
  });

  it('refuses a volatility figure when revenue is not positive', () => {
    let snapshots = baselineSnapshots();
    for (const periodId of PERIODS) {
      snapshots = withMetric(snapshots, { key: 'revenue', value: '0', unit: 'money', periodId });
    }
    const rule = evaluateRevenueGrowth(healthInput({ snapshots })).rules.find((r) => r.rule === 'G2')!;
    expect(rule.skipped_reason).toBe('revenue_not_positive');
  });
});

describe('a rule with no catch-all band is a programming error, not a zero', () => {
  it('throws rather than scoring nothing', () => {
    const broken = {
      ...PROFITABILITY_RULES.P1,
      bands: PROFITABILITY_RULES.P1.bands.filter((b) => b.bound !== null),
    };
    expect(() => bandOf(broken, new Decimal('-99'))).toThrow(/no catch-all band/);
  });
});
