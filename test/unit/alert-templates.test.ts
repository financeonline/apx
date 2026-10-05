import { describe, it, expect } from 'vitest';
import {
  ALERT_RULE_KEYS, EVALUATORS, OVERFLOW_RULE_KEY, TEMPLATES, planEvaluation, renderAlert,
  renderOverflow, type AlertRuleKey,
} from '@/modules/alerts';
import { PERIODS, emptyRuleContext, snapshot, variance } from '../fixtures/health';

/**
 * Alert copy (UX_ARCHITECTURE.md §8.3, FINANCIAL_ENGINE.md §8.2).
 *
 * Every alert is rendered in three labelled parts, and every number in the prose comes from
 * `threshold_summary` — so the sentence and the typed fields the AI reads can never disagree.
 */

describe('every rule has all three parts (§8.3)', () => {
  it.each([...ALERT_RULE_KEYS, OVERFLOW_RULE_KEY])('%s', (ruleKey) => {
    const template = TEMPLATES[ruleKey as AlertRuleKey];
    expect(template, `${ruleKey} has no template`).toBeDefined();
    for (const part of ['title', 'whatHappened', 'whyItMatters', 'whatYouCanDo', 'thresholdNote'] as const) {
      expect(template[part], `${ruleKey}.${part}`).toBeTypeOf('function');
    }
  });

  it('renders every rule without leaking undefined into a sentence', () => {
    // Rendered with an EMPTY threshold summary: a template that reaches for a field the outcome did
    // not record must degrade into words, never into "undefined" on a customer's screen.
    for (const ruleKey of [...ALERT_RULE_KEYS, OVERFLOW_RULE_KEY]) {
      const rendered = renderAlert(
        { ruleKey: ruleKey as AlertRuleKey, thresholdSummary: {} }, 'GBP');
      for (const [part, value] of Object.entries(rendered)) {
        expect(value, `${ruleKey}.${part}`).not.toContain('undefined');
        expect(value, `${ruleKey}.${part}`).not.toContain('null');
        expect(value, `${ruleKey}.${part}`).not.toContain('NaN');
        expect(value.length, `${ruleKey}.${part}`).toBeGreaterThan(3);
      }
    }
  });

  it('ends every sentence with a full stop, and titles without one', () => {
    for (const ruleKey of [...ALERT_RULE_KEYS, OVERFLOW_RULE_KEY]) {
      const r = renderAlert({ ruleKey: ruleKey as AlertRuleKey, thresholdSummary: {} }, 'GBP');
      expect(r.whatHappened.endsWith('.'), `${ruleKey} whatHappened`).toBe(true);
      expect(r.whyItMatters.endsWith('.'), `${ruleKey} whyItMatters`).toBe(true);
      expect(r.whatYouCanDo.endsWith('.'), `${ruleKey} whatYouCanDo`).toBe(true);
      expect(r.title.endsWith('.'), `${ruleKey} title`).toBe(false);
    }
  });
});

describe('the numbers in the prose come from threshold_summary (ADR-032.7)', () => {
  it('renders the figures the outcome recorded, in the organisation’s currency', () => {
    const rendered = renderAlert({
      ruleKey: 'expense.spike_category',
      thresholdSummary: {
        category: 'marketing', current: '6300', value: '2900', pct_change: '0.85',
        threshold_pct: '0.25', threshold_value: '2000',
      },
    }, 'GBP');

    expect(rendered.whatHappened)
      .toBe('marketing spending was £6,300 this period, up £2,900 (85.0%) on the month before.');
    expect(rendered.whatYouCanDo)
      .toBe('Review the largest marketing transactions and confirm they are expected.');
    expect(rendered.thresholdNote)
      .toBe('We flag a category that rises at least 25.0% and £2,000 month on month.');
  });

  it('follows base_currency, not a hard-coded symbol', () => {
    const values = { amount: '1200', signature: 'Acme', first_date: '12 Mar', second_date: '13 Mar' };
    expect(renderAlert({ ruleKey: 'duplicate.transaction', thresholdSummary: values }, 'EUR')
      .whatHappened).toContain('€1,200');
    expect(renderAlert({ ruleKey: 'duplicate.transaction', thresholdSummary: values }, 'AED')
      .whatHappened).toContain('1,200');
  });

  it('renders a margin change as percentage points, not a percentage', () => {
    const rendered = renderAlert({
      ruleKey: 'margin.deterioration',
      thresholdSummary: {
        margin: 'gross', current: '0.29', value: '-0.031',
        comparison_period: 'the 3-month average',
      },
    }, 'GBP');
    expect(rendered.whatHappened)
      .toBe('Gross margin is 29.0%, down 3.1 pts from the 3-month average.');
  });

  it('never prints a minus sign in a sentence that already says "fell"', () => {
    const rendered = renderAlert({
      ruleKey: 'revenue.decline',
      thresholdSummary: {
        pct_change: '-0.22', current: '80000', comparison_period: 'the previous month',
      },
    }, 'GBP');
    expect(rendered.whatHappened).toBe('Revenue fell 22.0% to £80,000, compared with the previous month.');
    expect(rendered.whatHappened).not.toContain('−22');
  });

  it('adapts the cash sentence to which trigger fired', () => {
    const consecutive = renderAlert({
      ruleKey: 'cash.decline',
      thresholdSummary: { trigger: 'consecutive_months', consecutive_months: '3', current: '12000' },
    }, 'GBP');
    // R-4: what was measured is three months of net outflow, not a falling balance.
    expect(consecutive.title).toBe('More money went out than came in');
    expect(consecutive.whatHappened).toBe('More money has gone out than come in for 3 months in a row. Cash now stands at £12,000.');
    expect(consecutive.whatHappened).not.toMatch(/fallen/);

    const single = renderAlert({
      ruleKey: 'cash.decline',
      thresholdSummary: { trigger: 'single_month', current: '12000', comparison: '30000' },
    }, 'GBP');
    expect(single.whatHappened).toBe('Cash fell from £30,000 to £12,000 this period.');
    expect(single.title).toBe('Cash fell');
  });

  it('drops the overdue clause from the runway advice when there is nothing to collect', () => {
    const withOverdue = renderAlert({
      ruleKey: 'cash.runway_low',
      thresholdSummary: { runway: '2.1', receivables_overdue: '8000' },
    }, 'GBP');
    expect(withOverdue.whatYouCanDo).toContain('£8,000');

    const without = renderAlert({
      ruleKey: 'cash.runway_low',
      thresholdSummary: { runway: '2.1', receivables_overdue: null },
    }, 'GBP');
    expect(without.whatYouCanDo).not.toContain('£');
    expect(without.whatYouCanDo.length).toBeGreaterThan(20);
  });
});

describe('the threshold note §8.3 asks for', () => {
  it('states the rule in words, so a reader can argue with it', () => {
    expect(renderAlert({ ruleKey: 'concentration.customer', thresholdSummary: {} }, 'GBP')
      .thresholdNote).toBe('We flag a single customer at 35% of revenue, and 50% as high.');
    expect(renderAlert({ ruleKey: 'cash.runway_low', thresholdSummary: {} }, 'GBP')
      .thresholdNote).toContain('under 3 months');
  });
});

describe('the overflow summary', () => {
  it('counts what it hid and points at the full list', () => {
    const rendered = renderOverflow(15, 'GBP');
    expect(rendered.title).toBe('15 further items need attention');
    expect(rendered.whatYouCanDo).toContain('Insights');
  });
});

describe('copy is attached to every planned change', () => {
  it('an insert carries its three parts, rendered', () => {
    const periodId = PERIODS[5]!;
    const plan = planEvaluation({
      organizationId: 'org-1', calculationRunId: 'run-1', currency: 'GBP',
      ruleVersion: 'alerts.rules.v1',
      periods: [{
        periodStart: '2026-03-01',
        ctx: emptyRuleContext({
          periodId,
          snapshots: [
            snapshot({ key: 'revenue', value: '100000', unit: 'money', periodId }),
            variance({
              key: 'expense_by_category.variance.prev_period', value: '5000', unit: 'money',
              periodId, dimensionKey: 'marketing', pctChange: '0.40',
            }),
          ],
        }),
      }],
      existing: new Map(), now: '2026-04-01T00:00:00.000Z', evaluators: EVALUATORS,
    });

    const insert = plan.changes.find((c) => c.kind === 'insert')!;
    expect(insert.kind).toBe('insert');
    if (insert.kind !== 'insert') return;
    expect(insert.rendered.title).toBe('marketing spending jumped');
    expect(insert.rendered.whatHappened).toContain('£5,000');
    expect(insert.rendered.whyItMatters.length).toBeGreaterThan(20);
    expect(insert.rendered.whatYouCanDo).toContain('marketing');
  });
});
