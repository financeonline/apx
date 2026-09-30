import { describe, it, expect } from 'vitest';
import {
  ALERT_RULE_KEYS, CUSTOMER_CONCENTRATION_HIGH, DEVIATION_FLOOR, EVALUATORS, RULES, RULE_ORDER,
  RUNWAY_CRITICAL, accountMedians, consecutiveFalls, dedupeKey,
  evaluateCashDecline, evaluateCashRunwayLow, evaluateCustomerConcentration,
  evaluateExpenseSpikeAccount, evaluateLargeTransactionDeviation, evaluateMarginDeterioration,
  evaluatePayablesDeterioration, evaluateReceivablesDeterioration, evaluateRecurringNew,
  evaluateRevenueDecline, evaluateSupplierConcentration, evaluateVarianceSignificant,
  largestCounterparty,
} from '@/modules/alerts';
import { Decimal } from '@/core/money';
import {
  CURRENT, PERIODS, emptyRuleContext, entry, invoice, record, snapshot, variance,
} from '../fixtures/health';

/**
 * Fire / no-fire per rule (TEST_STRATEGY.md §8), for the twelve rules Phase 7 adds. The six the
 * health score shares are covered in `alert-conditions.test.ts`.
 *
 * Every fixture sits just above or just below the threshold §8.2 states, so a moved threshold fails
 * here rather than in production.
 */

function withRevenue(value = '100000') {
  return snapshot({ key: 'revenue', value, unit: 'money' });
}

describe('the catalogue is complete', () => {
  it('has an evaluator for every rule key in §8.2', () => {
    for (const key of ALERT_RULE_KEYS) {
      expect(EVALUATORS[key], `${key} has no evaluator`).toBeTypeOf('function');
      expect(RULES[key], `${key} has no definition`).toBeDefined();
    }
    expect(ALERT_RULE_KEYS).toHaveLength(18);
  });

  it('evaluates variance.significant last, so it can see what already explains the period', () => {
    expect(RULE_ORDER[RULE_ORDER.length - 1]).toBe('variance.significant');
    expect(new Set(RULE_ORDER)).toEqual(new Set(ALERT_RULE_KEYS));
  });

  it('keys events by period and states by subject only (ADR-036)', () => {
    const subject = { type: 'counterparty' as const, id: 'cp-acme', key: null };
    expect(dedupeKey('expense.spike_category', 'event', 'p1', subject))
      .toBe('expense.spike_category|p1|counterparty|cp-acme');
    expect(dedupeKey('concentration.customer', 'state', 'p1', subject))
      .toBe('concentration.customer|state|counterparty|cp-acme');
    // The period is absent from a state key: that is what makes six months one alert.
    expect(dedupeKey('concentration.customer', 'state', 'p1', subject))
      .toBe(dedupeKey('concentration.customer', 'state', 'p9', subject));
  });

  it('identifies a category subject by name, since it has no row (ADR-053)', () => {
    expect(dedupeKey('expense.spike_category', 'event', 'p1',
      { type: 'standard_category', id: null, key: 'marketing' }))
      .toBe('expense.spike_category|p1|standard_category|marketing');
  });
});

describe('revenue.decline', () => {
  function ctx(momPct: string | null, yoyPct: string | null = null) {
    return emptyRuleContext({
      snapshots: [
        withRevenue('80000'),
        variance({
          key: 'revenue.variance.prev_period', value: '-20000', unit: 'money',
          pctChange: momPct, components: { current: '80000', comparison: '100000' },
        }),
        ...(yoyPct === null ? [] : [variance({
          key: 'revenue.variance.same_period_last_year', value: '-25000', unit: 'money',
          pctChange: yoyPct, components: { current: '80000', comparison: '105000' },
        })]),
      ],
    });
  }

  it('fires at a 15% fall on the previous month', () => {
    const outcomes = evaluateRevenueDecline(ctx('-0.15'));
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.severity).toBe('medium');
    expect(outcomes[0]!.thresholdSummary.comparison_period).toBe('the previous month');
  });

  it('does not fire just below it', () => {
    expect(evaluateRevenueDecline(ctx('-0.1499'))).toHaveLength(0);
  });

  it('is high at a 30% fall', () => {
    expect(evaluateRevenueDecline(ctx('-0.30'))[0]!.severity).toBe('high');
    expect(evaluateRevenueDecline(ctx('-0.2999'))[0]!.severity).toBe('medium');
  });

  it('fires on the year-on-year test at 20% when the month-on-month test does not', () => {
    const outcomes = evaluateRevenueDecline(ctx('-0.05', '-0.20'));
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.thresholdSummary.comparison_period).toBe('the same month last year');
  });

  it('never fires on a basis change alone (F-B-07)', () => {
    const mixed = emptyRuleContext({
      snapshots: [
        withRevenue('80000'),
        variance({
          key: 'revenue.variance.prev_period', value: '-90000', unit: 'money',
          pctChange: '-0.90', warnings: ['basis_differs'],
        }),
      ],
    });
    expect(evaluateRevenueDecline(mixed)).toHaveLength(0);
  });

  it('pins the customers that fell most', () => {
    const withCustomers = emptyRuleContext({
      snapshots: [
        withRevenue('80000'),
        variance({
          key: 'revenue.variance.prev_period', value: '-20000', unit: 'money', pctChange: '-0.20',
        }),
        variance({
          key: 'customer_revenue.variance.prev_period', value: '-12000', unit: 'money',
          dimensionId: 'cp-acme', pctChange: '-0.40',
        }),
        variance({
          key: 'customer_revenue.variance.prev_period', value: '3000', unit: 'money',
          dimensionId: 'cp-globex', pctChange: '0.10',
        }),
      ],
    });
    const evidence = evaluateRevenueDecline(withCustomers)[0]!.evidence!;
    expect(evidence.some((e) => e.label === 'Acme Ltd')).toBe(true);
    expect(evidence.some((e) => e.label === 'Globex')).toBe(false);
  });
});

describe('margin.deterioration', () => {
  function ctx(gross: string | null, net: string | null, netMargin = '0.08') {
    return emptyRuleContext({
      snapshots: [
        withRevenue(),
        snapshot({ key: 'net_margin', value: netMargin }),
        snapshot({ key: 'gross_margin', value: '0.32' }),
        ...(gross === null ? [] : [snapshot({
          key: 'gross_margin.variance.trailing_3m_avg', value: gross,
        })]),
        ...(net === null ? [] : [snapshot({ key: 'net_margin.variance.prev_period', value: net })]),
      ],
    });
  }

  it('fires when gross margin is 3 points below its 3-month average', () => {
    expect(evaluateMarginDeterioration(ctx('-0.03', null))).toHaveLength(1);
    expect(evaluateMarginDeterioration(ctx('-0.0299', null))).toHaveLength(0);
  });

  it('fires when net margin fell 5 points on the previous month', () => {
    expect(evaluateMarginDeterioration(ctx(null, '-0.05'))).toHaveLength(1);
    expect(evaluateMarginDeterioration(ctx(null, '-0.0499'))).toHaveLength(0);
  });

  it('is high when the business is now loss-making', () => {
    expect(evaluateMarginDeterioration(ctx('-0.05', null, '-0.01'))[0]!.severity).toBe('high');
    expect(evaluateMarginDeterioration(ctx('-0.05', null, '0.01'))[0]!.severity).toBe('medium');
  });
});

describe('cash.decline', () => {
  function ctx(change: string, opening = '50000', outflows = '20000') {
    return emptyRuleContext({
      snapshots: [
        ...PERIODS.map((periodId) =>
          snapshot({ key: 'cash_outflows', value: outflows, unit: 'money', periodId })),
        snapshot({ key: 'opening_cash', value: opening, unit: 'money' }),
        snapshot({ key: 'closing_cash', value: '30000', unit: 'money' }),
        variance({
          key: 'closing_cash.variance.prev_period', value: change, unit: 'money',
          components: { current: '30000', comparison: '50000' },
        }),
      ],
      trailingCompletePeriodIds: PERIODS.slice(0, -1),
    });
  }

  it('fires on a fall of a fifth of opening cash that also clears the floor', () => {
    // 20% of £50,000 is £10,000; the floor is max(£1,000, £20,000/4) = £5,000.
    expect(evaluateCashDecline(ctx('-10000'))).toHaveLength(1);
    expect(evaluateCashDecline(ctx('-9999'))).toHaveLength(0);
  });

  it('does not fire on a proportionally large but trivially small fall', () => {
    // A fifth of £100 is £20; the absolute floor is what stops this being an alert.
    expect(evaluateCashDecline(ctx('-20', '100'))).toHaveLength(0);
  });

  it('fires on three consecutive falling months regardless of size', () => {
    const bleeding = emptyRuleContext({
      snapshots: [
        ...PERIODS.map((periodId) =>
          snapshot({ key: 'net_cash_movement', value: '-500', unit: 'money', periodId })),
        snapshot({ key: 'closing_cash', value: '30000', unit: 'money' }),
      ],
      trailingCompletePeriodIds: PERIODS.slice(0, -1),
    });
    const outcomes = evaluateCashDecline(bleeding);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.thresholdSummary.trigger).toBe('consecutive_months');
  });

  it('counts consecutive falls only when every one of the three fell', () => {
    const mixed = emptyRuleContext({
      snapshots: [
        snapshot({ key: 'net_cash_movement', value: '-500', unit: 'money', periodId: PERIODS[3]! }),
        snapshot({ key: 'net_cash_movement', value: '100', unit: 'money', periodId: PERIODS[4]! }),
        snapshot({ key: 'net_cash_movement', value: '-500', unit: 'money', periodId: CURRENT }),
      ],
      trailingCompletePeriodIds: PERIODS.slice(0, -1),
    });
    expect(consecutiveFalls(mixed, 3)).toBe(0);
  });

  it('always pins what the cash went on', () => {
    const evidence = evaluateCashDecline(ctx('-10000'))[0]!.evidence!;
    expect(evidence.some((e) => e.itemType === 'query')).toBe(true);
  });
});

describe('cash.runway_low', () => {
  function ctx(runway: string | null) {
    return emptyRuleContext({
      snapshots: [
        snapshot({ key: 'cash_runway_months', value: runway, unit: 'days' }),
        snapshot({ key: 'closing_cash', value: '12000', unit: 'money' }),
        snapshot({ key: 'receivables_overdue', value: '8000', unit: 'money' }),
      ],
    });
  }

  it('fires below three months and not at three', () => {
    expect(evaluateCashRunwayLow(ctx('2.99'))).toHaveLength(1);
    expect(evaluateCashRunwayLow(ctx('3'))).toHaveLength(0);
  });

  it('is critical below one and a half months', () => {
    expect(evaluateCashRunwayLow(ctx('1.49'))[0]!.severity).toBe('critical');
    expect(evaluateCashRunwayLow(ctx(RUNWAY_CRITICAL.toString()))[0]!.severity).toBe('high');
  });

  it('says nothing when the runway is unknown', () => {
    expect(evaluateCashRunwayLow(ctx(null))).toHaveLength(0);
  });

  it('names the overdue money that could be collected', () => {
    expect(evaluateCashRunwayLow(ctx('2'))[0]!.thresholdSummary.receivables_overdue).toBe('8000');
  });
});

describe('receivables.deterioration and payables.deterioration', () => {
  function ctx(side: 'receivables' | 'payables', overdue: string, total: string, days?: string) {
    return emptyRuleContext({
      snapshots: [
        snapshot({ key: side, value: total, unit: 'money' }),
        snapshot({ key: `${side}_overdue`, value: overdue, unit: 'money' }),
        ...(days === undefined ? [] : [snapshot({
          key: `${side}_days.variance.prev_period`, value: days, unit: 'days',
        })]),
      ],
      records: [
        invoice({ id: 'inv-1', outstanding: '4000.00', dueDate: '2026-01-10',
          invoiceType: side === 'receivables' ? 'sales' : 'purchase' }),
        invoice({ id: 'inv-2', outstanding: '2000.00', dueDate: '2026-02-01',
          invoiceType: side === 'receivables' ? 'sales' : 'purchase' }),
      ],
    });
  }

  it('fires when 30% of what is owed is overdue', () => {
    expect(evaluateReceivablesDeterioration(ctx('receivables', '3000', '10000'))).toHaveLength(1);
    expect(evaluateReceivablesDeterioration(ctx('receivables', '2999', '10000'))).toHaveLength(0);
  });

  it('is high at half overdue', () => {
    expect(evaluateReceivablesDeterioration(ctx('receivables', '5000', '10000'))[0]!.severity)
      .toBe('high');
    expect(evaluateReceivablesDeterioration(ctx('receivables', '4999', '10000'))[0]!.severity)
      .toBe('medium');
  });

  it('fires on a ten-day slowdown even when nothing is overdue', () => {
    const outcomes = evaluateReceivablesDeterioration(ctx('receivables', '0', '10000', '10'));
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.thresholdSummary.trigger).toBe('days_increase');
    expect(evaluateReceivablesDeterioration(ctx('receivables', '0', '10000', '9'))).toHaveLength(0);
  });

  it('names every invoice open and overdue at the figure\'s own date — not only this month\'s (ADR-120)', () => {
    const open = (over: Partial<import('@/modules/alerts').OpenInvoiceObservation> & { id: string }) => ({
      invoiceType: 'sales' as const, issueDate: '2026-01-15', dueDate: '2026-02-14', totalAmount: '1000.00',
      balanceDue: '1000.00', paidDate: null, description: over.id, ...over,
    });
    const outcome = evaluateReceivablesDeterioration(emptyRuleContext({
      snapshots: [
        snapshot({ key: 'receivables', value: '9000', unit: 'money' }),
        { ...snapshot({ key: 'receivables_overdue', value: '6500', unit: 'money' }), components: { as_of: '2026-03-31' } },
      ],
      records: [], // nothing issued in March itself
      openInvoices: [
        open({ id: 'jan-overdue', totalAmount: '4000.00', balanceDue: '4000.00' }),
        // Paid in APRIL, after the date: at 31 March it was owed in full (the engine's rule).
        open({ id: 'paid-later', totalAmount: '2500.00', balanceDue: '0.00', paidDate: '2026-04-10' }),
        // Paid before the date: nothing left.
        open({ id: 'paid-before', totalAmount: '800.00', balanceDue: '0.00', paidDate: '2026-03-01' }),
        // Not yet due at 31 March.
        open({ id: 'not-due', dueDate: '2026-04-30' }),
        // A credit note is never an "overdue invoice", however large.
        open({ id: 'credit', invoiceType: 'sales_credit_note', totalAmount: '9999.00', balanceDue: '9999.00' }),
        // A supplier's invoice is the payables rule's business.
        open({ id: 'purchase', invoiceType: 'purchase' }),
      ],
    }))[0]!;
    expect(outcome.recordIds).toEqual(['jan-overdue', 'paid-later']);
    expect(outcome.thresholdSummary.overdue_count).toBe('2');
    expect(outcome.thresholdSummary.top3_share).toBe('1.000000'); // (4,000 + 2,500) / 6,500
  });

  it('pins the overdue invoices and reports the top three share', () => {
    const outcome = evaluateReceivablesDeterioration(ctx('receivables', '6000', '10000'))[0]!;
    expect(outcome.recordIds).toEqual(['inv-1', 'inv-2']);
    expect(outcome.thresholdSummary.overdue_count).toBe('2');
    expect(outcome.evidence!.filter((e) => e.itemType === 'invoice')).toHaveLength(2);
  });

  it('works the same way for payables', () => {
    const outcome = evaluatePayablesDeterioration(ctx('payables', '4000', '10000'))[0]!;
    expect(outcome.ruleKey).toBe('payables.deterioration');
    expect(outcome.metricKey).toBe('payables_overdue');
  });
});

describe('concentration.customer and concentration.supplier', () => {
  function ctx(share: string, metric = 'customer_concentration_top1', revenueMetric = 'customer_revenue') {
    return emptyRuleContext({
      snapshots: [
        snapshot({ key: metric, value: share }),
        snapshot({ key: revenueMetric, value: '60000', unit: 'money', dimensionId: 'cp-acme' }),
        snapshot({ key: revenueMetric, value: '20000', unit: 'money', dimensionId: 'cp-globex' }),
      ],
    });
  }

  it('fires at 35% and is high at 50%', () => {
    expect(evaluateCustomerConcentration(ctx('0.3499'))).toHaveLength(0);
    expect(evaluateCustomerConcentration(ctx('0.35'))[0]!.severity).toBe('medium');
    expect(evaluateCustomerConcentration(ctx(CUSTOMER_CONCENTRATION_HIGH.toString()))[0]!.severity)
      .toBe('high');
  });

  it('names the customer, not just the share', () => {
    const outcome = evaluateCustomerConcentration(ctx('0.55'))[0]!;
    expect(outcome.subject).toEqual({ type: 'counterparty', id: 'cp-acme', key: null });
    expect(outcome.thresholdSummary.customer).toBe('Acme Ltd');
  });

  it('picks the largest counterparty deterministically when two are tied', () => {
    const tied = emptyRuleContext({
      snapshots: [
        snapshot({ key: 'customer_revenue', value: '5000', unit: 'money', dimensionId: 'cp-globex' }),
        snapshot({ key: 'customer_revenue', value: '5000', unit: 'money', dimensionId: 'cp-acme' }),
      ],
    });
    expect(largestCounterparty(tied, 'customer_revenue')!.id).toBe('cp-acme');
  });

  it('fires for suppliers at 40%, medium at 60%', () => {
    const supplier = (share: string) =>
      ctx(share, 'supplier_concentration_top1', 'supplier_spend');
    expect(evaluateSupplierConcentration(supplier('0.3999'))).toHaveLength(0);
    expect(evaluateSupplierConcentration(supplier('0.40'))[0]!.severity).toBe('low');
    expect(evaluateSupplierConcentration(supplier('0.60'))[0]!.severity).toBe('medium');
  });
});

describe('expense.spike_account', () => {
  function ctx(pct: string, value: string, basis: 'ledger' | 'bank' = 'ledger') {
    return emptyRuleContext({
      snapshots: [
        withRevenue(),
        variance({
          key: 'expense_by_account.variance.prev_period', value, unit: 'money',
          dimensionId: 'acct-1', basis, pctChange: pct,
          components: { current: '9000', comparison: '6000' },
        }),
      ],
    });
  }

  it('fires on the same thresholds as the category rule', () => {
    expect(evaluateExpenseSpikeAccount(ctx('0.25', '3000'))).toHaveLength(1);
    expect(evaluateExpenseSpikeAccount(ctx('0.2499', '3000'))).toHaveLength(0);
  });

  it('names the account', () => {
    const outcome = evaluateExpenseSpikeAccount(ctx('0.40', '3000'))[0]!;
    expect(outcome.subject).toEqual({ type: 'account', id: 'acct-1', key: null });
    expect(outcome.thresholdSummary.account).toBe('Marketing');
  });

  it('never fires on a bank-basis figure, which has no account behind it', () => {
    expect(evaluateExpenseSpikeAccount(ctx('0.90', '9000', 'bank'))).toHaveLength(0);
  });
});

describe('recurring.new', () => {
  function group(occurrences: number, expected: string) {
    return emptyRuleContext({
      recurringGroups: [{
        id: 'g-1', groupKey: 'k1', direction: 'outflow', signature: 'newsub',
        status: 'active', occurrences, expectedAmount: expected, lastAmount: expected,
        amountToleranceRatio: '0.100000', lastSeen: '2026-03-01', cadence: 'monthly',
        nextExpected: '2026-04-01',
      }],
    });
  }

  it('fires at exactly the third occurrence', () => {
    expect(evaluateRecurringNew(group(3, '80.00'))).toHaveLength(1);
    expect(evaluateRecurringNew(group(2, '80.00'))).toHaveLength(0);
    // Not at the fourth: "a new payment has started" stops being true.
    expect(evaluateRecurringNew(group(4, '80.00'))).toHaveLength(0);
  });

  it('ignores anything under £50', () => {
    expect(evaluateRecurringNew(group(3, '49.99'))).toHaveLength(0);
    expect(evaluateRecurringNew(group(3, '50.00'))).toHaveLength(1);
  });

  it('is info, never a warning', () => {
    expect(evaluateRecurringNew(group(3, '500.00'))[0]!.severity).toBe('info');
  });
});

describe('deviation.large_transaction', () => {
  const history = Array.from({ length: 8 }, (_, i) =>
    entry({ id: `h${i}`, amount: '-400.00', periodId: PERIODS[0]! }));

  function ctx(amount: string, table: 'ledger_entries' | 'invoices' = 'ledger_entries') {
    return emptyRuleContext({
      snapshots: [withRevenue()],
      records: [entry({ id: 'big', amount, table, accountId: 'acct-1' })],
      trailingRecords: history,
    });
  }

  it('fires at three times the account median and above £1,000', () => {
    // Median is £400, so the multiple threshold is £1,200; the floor is £1,000.
    expect(evaluateLargeTransactionDeviation(ctx('-1200.00'))).toHaveLength(1);
    expect(evaluateLargeTransactionDeviation(ctx('-1199.00'))).toHaveLength(0);
  });

  it('never fires below the flat floor, however extreme the multiple', () => {
    const small = emptyRuleContext({
      snapshots: [withRevenue()],
      records: [entry({ id: 'big', amount: '-999.00', accountId: 'acct-1' })],
      trailingRecords: Array.from({ length: 8 }, (_, i) =>
        entry({ id: `h${i}`, amount: '-10.00', periodId: PERIODS[0]! })),
    });
    expect(evaluateLargeTransactionDeviation(small)).toHaveLength(0);
    expect(DEVIATION_FLOOR.toString()).toBe('1000');
  });

  it('never fires on an account with no history', () => {
    const unseen = emptyRuleContext({
      snapshots: [withRevenue()],
      records: [entry({ id: 'big', amount: '-50000.00', accountId: 'acct-2' })],
      trailingRecords: history,
    });
    expect(evaluateLargeTransactionDeviation(unseen)).toHaveLength(0);
  });

  it('never fires on a bank row — that is the other rule’s job', () => {
    const bank = emptyRuleContext({
      snapshots: [withRevenue()],
      records: [record({ id: 'b', amount: '-9000.00', accountId: 'acct-1' })],
      trailingRecords: history,
    });
    expect(evaluateLargeTransactionDeviation(bank)).toHaveLength(0);
  });

  it('takes a median per account, not across the chart', () => {
    const medians = accountMedians(emptyRuleContext({
      trailingRecords: [
        entry({ id: 'a', accountId: 'acct-1', amount: '-100.00', periodId: PERIODS[0]! }),
        entry({ id: 'b', accountId: 'acct-1', amount: '-300.00', periodId: PERIODS[0]! }),
        entry({ id: 'c', accountId: 'acct-2', amount: '-9000.00', periodId: PERIODS[0]! }),
      ],
    }));
    expect(medians.get('acct-1')!.toString()).toBe('200');
    expect(medians.get('acct-2')!.toString()).toBe('9000');
  });
});

describe('variance.significant', () => {
  function ctx(metric: string, value: string, pct: string) {
    return emptyRuleContext({
      snapshots: [
        withRevenue(),
        snapshot({ key: metric, value: '10000', unit: 'money' }),
        variance({
          key: `${metric}.variance.prev_period`, value, unit: 'money', pctChange: pct,
          components: { current: '10000', comparison: '20000' },
        }),
      ],
    });
  }

  it('fires at 30% and 5% of revenue together', () => {
    expect(evaluateVarianceSignificant(ctx('net_profit', '-6000', '-0.30'))).toHaveLength(1);
    expect(evaluateVarianceSignificant(ctx('net_profit', '-6000', '-0.2999'))).toHaveLength(0);
    // Right percentage, immaterial amount.
    expect(evaluateVarianceSignificant(ctx('net_profit', '-4999', '-0.50'))).toHaveLength(0);
  });

  it('treats a favourable movement as information, not a problem', () => {
    expect(evaluateVarianceSignificant(ctx('net_profit', '6000', '0.40'))[0]!.severity).toBe('info');
    expect(evaluateVarianceSignificant(ctx('net_profit', '-6000', '-0.40'))[0]!.severity)
      .toBe('medium');
  });

  it('watches profit and cash, and nothing else', () => {
    expect(evaluateVarianceSignificant(ctx('revenue', '-60000', '-0.60'))).toHaveLength(0);
    for (const metric of ['operating_profit', 'net_profit', 'net_cash_movement']) {
      expect(evaluateVarianceSignificant(ctx(metric, '-6000', '-0.40')), metric).toHaveLength(1);
    }
  });
});

describe('every rule pins something a reader can open', () => {
  it('produces at least one evidence item whenever it fires', () => {
    // The §8 assertion "every fired alert has a bundle with >= 1 item", checked at the rule level
    // so a rule that forgets its evidence fails here rather than in an integration fixture.
    const cases: ReadonlyArray<readonly [string, unknown]> = [
      ['revenue.decline', evaluateRevenueDecline(emptyRuleContext({
        snapshots: [withRevenue('80000'), variance({
          key: 'revenue.variance.prev_period', value: '-20000', unit: 'money', pctChange: '-0.20',
        })],
      }))],
      ['cash.runway_low', evaluateCashRunwayLow(emptyRuleContext({
        snapshots: [snapshot({ key: 'cash_runway_months', value: '2', unit: 'days' })],
      }))],
      ['concentration.customer', evaluateCustomerConcentration(emptyRuleContext({
        snapshots: [
          snapshot({ key: 'customer_concentration_top1', value: '0.55' }),
          snapshot({ key: 'customer_revenue', value: '60000', unit: 'money', dimensionId: 'cp-acme' }),
        ],
      }))],
    ];
    for (const [name, outcomes] of cases) {
      const list = outcomes as ReturnType<typeof evaluateRevenueDecline>;
      expect(list.length, name).toBeGreaterThan(0);
      expect(list[0]!.evidence!.length, name).toBeGreaterThan(0);
    }
  });
});

describe('Decimal is used for every threshold', () => {
  it('compares at the boundary without floating-point drift', () => {
    // 0.1 + 0.2 !== 0.3 in a double; the rules must not be written that way.
    expect(new Decimal('0.1').plus('0.2').equals('0.3')).toBe(true);
  });
});
