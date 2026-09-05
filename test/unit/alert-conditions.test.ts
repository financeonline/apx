import { describe, it, expect } from 'vitest';
import { Decimal } from '@/core/money';
import {
  CONDITION_RULE_KEYS, DUPLICATE_CRITICAL_AMOUNT, DUPLICATE_MIN_AMOUNT,
  MIN_ABS_FLOOR, RECURRING_MISSED_MIN_OCCURRENCES, UNUSUAL_ABSOLUTE_FLOOR,
  conditionsFor, dataSuppressed, dataSuppression, evaluateBankUnusualTransaction,
  evaluateConditions, evaluateDuplicateTransaction, evaluateExpenseSpikeCategory,
  evaluateRecurringAmountChanged, evaluateRecurringMissed, minAbsThreshold, monthlyOutflows,
  unusualThreshold, type RecurringGroupObservation,
} from '@/modules/alerts';
import {
  CURRENT, PERIODS, emptyRuleContext, record, snapshot, variance,
} from '../fixtures/health';

/**
 * The six condition rules the health score counts (§7.3 K3/B3, §8.2).
 *
 * These are the functions Phase 9's alert job will call unchanged, so the fixtures assert the
 * `threshold_summary` fields as well as the firing, per §8.2.
 */

function withCashOutflows(value: string) {
  return PERIODS.map((periodId) =>
    snapshot({ key: 'cash_outflows', value, unit: 'money', periodId }));
}

describe('expense.spike_category (§8.2)', () => {
  function ctx(pctChange: string, value: string, revenue = '100000') {
    return emptyRuleContext({
      snapshots: [
        snapshot({ key: 'revenue', value: revenue, unit: 'money' }),
        variance({
          key: 'expense_by_category.variance.prev_period', value, unit: 'money',
          dimensionKey: 'marketing', pctChange,
          components: { current: '9000', comparison: '6000' },
        }),
      ],
    });
  }

  it('fires when the rise is both 25% and 2% of revenue', () => {
    const outcomes = evaluateExpenseSpikeCategory(ctx('0.25', '3000'));
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.subject).toEqual({ type: 'standard_category', id: null, key: 'marketing' });
    expect(outcomes[0]!.severity).toBe('medium');
    expect(outcomes[0]!.thresholdSummary).toMatchObject({
      category: 'marketing', current: '9000', previous: '6000',
      pct_change: '0.250000', threshold_value: '2000.00',
    });
  });

  it('does not fire on a large percentage of a small number', () => {
    // Tripled, but £150 on £100,000 of revenue is not a finding.
    expect(evaluateExpenseSpikeCategory(ctx('2.0', '150'))).toHaveLength(0);
  });

  it('does not fire on a small percentage of a large number', () => {
    expect(evaluateExpenseSpikeCategory(ctx('0.2499', '30000'))).toHaveLength(0);
  });

  it('is high when the rise reaches half again, or 5% of revenue', () => {
    expect(evaluateExpenseSpikeCategory(ctx('0.50', '3000'))[0]!.severity).toBe('high');
    expect(evaluateExpenseSpikeCategory(ctx('0.30', '5000'))[0]!.severity).toBe('high');
  });

  it('falls back to a £500 floor when revenue is unknown', () => {
    const withoutRevenue = emptyRuleContext({
      snapshots: [
        variance({
          key: 'expense_by_category.variance.prev_period', value: '499', unit: 'money',
          dimensionKey: 'marketing', pctChange: '0.90',
        }),
      ],
    });
    expect(evaluateExpenseSpikeCategory(withoutRevenue)).toHaveLength(0);
  });

  it('never fires on a variance measured across two different bases (ADR-030.3)', () => {
    const mixed = emptyRuleContext({
      snapshots: [
        snapshot({ key: 'revenue', value: '100000', unit: 'money' }),
        variance({
          key: 'expense_by_category.variance.prev_period', value: '30000', unit: 'money',
          dimensionKey: 'marketing', pctChange: '3.0', warnings: ['basis_differs'],
        }),
      ],
    });
    expect(evaluateExpenseSpikeCategory(mixed)).toHaveLength(0);
  });

  it('orders outcomes by category, so two runs agree', () => {
    const many = emptyRuleContext({
      snapshots: [
        snapshot({ key: 'revenue', value: '100000', unit: 'money' }),
        ...['travel', 'marketing', 'software'].map((category) => variance({
          key: 'expense_by_category.variance.prev_period', value: '4000', unit: 'money',
          dimensionKey: category, pctChange: '0.40',
        })),
      ],
    });
    expect(evaluateExpenseSpikeCategory(many).map((o) => o.subject.key))
      .toEqual(['marketing', 'software', 'travel']);
  });
});

describe('duplicate.transaction (§8.2)', () => {
  const base = { amount: '-1200.00', descriptionNormalized: 'acme ltd' };

  it('fires on two rows sharing a dedupe hash', () => {
    const ctx = emptyRuleContext({
      snapshots: withCashOutflows('80000'),
      records: [
        record({ ...base, id: 'a', dedupeHash: 'abc' }),
        record({ ...base, id: 'b', dedupeHash: 'abc' }),
      ],
    });
    const outcomes = evaluateDuplicateTransaction(ctx);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.recordIds).toEqual(['a', 'b']);
    expect(outcomes[0]!.thresholdSummary.match_kind).toBe('exact');
  });

  it('fires on the same money to the same payee a day apart', () => {
    const ctx = emptyRuleContext({
      snapshots: withCashOutflows('80000'),
      records: [
        record({ ...base, id: 'a', date: '2026-03-12' }),
        record({ ...base, id: 'b', date: '2026-03-13' }),
      ],
    });
    expect(evaluateDuplicateTransaction(ctx)[0]!.thresholdSummary.match_kind).toBe('fuzzy');
  });

  it('does not fuzzy-match two days apart', () => {
    const ctx = emptyRuleContext({
      snapshots: withCashOutflows('80000'),
      records: [
        record({ ...base, id: 'a', date: '2026-03-12' }),
        record({ ...base, id: 'b', date: '2026-03-14' }),
      ],
    });
    expect(evaluateDuplicateTransaction(ctx)).toHaveLength(0);
  });

  it('respects a human who has already looked (ADR-029.6)', () => {
    const ctx = emptyRuleContext({
      snapshots: withCashOutflows('80000'),
      records: [
        record({ ...base, id: 'a', dedupeHash: 'abc', duplicateReviewed: true }),
        record({ ...base, id: 'b', dedupeHash: 'abc' }),
      ],
    });
    expect(evaluateDuplicateTransaction(ctx)).toHaveLength(0);
  });

  it('ignores pairs below the £50 floor', () => {
    const small = { amount: '-49.00', descriptionNormalized: 'coffee' };
    const ctx = emptyRuleContext({
      snapshots: withCashOutflows('80000'),
      records: [record({ ...small, id: 'a', dedupeHash: 'x' }), record({ ...small, id: 'b', dedupeHash: 'x' })],
    });
    expect(evaluateDuplicateTransaction(ctx)).toHaveLength(0);
    expect(DUPLICATE_MIN_AMOUNT.toString()).toBe('50');
  });

  it('is critical at £5,000, or at 5% of monthly outflows', () => {
    const big = { amount: `-${DUPLICATE_CRITICAL_AMOUNT.toString()}.00`, descriptionNormalized: 'payroll' };
    const ctx = emptyRuleContext({
      snapshots: withCashOutflows('800000'),
      records: [record({ ...big, id: 'a', dedupeHash: 'y' }), record({ ...big, id: 'b', dedupeHash: 'y' })],
    });
    expect(evaluateDuplicateTransaction(ctx)[0]!.severity).toBe('critical');

    const shareCtx = emptyRuleContext({
      snapshots: withCashOutflows('20000'),
      records: [
        record({ amount: '-1000.00', descriptionNormalized: 'x', id: 'a', dedupeHash: 'z' }),
        record({ amount: '-1000.00', descriptionNormalized: 'x', id: 'b', dedupeHash: 'z' }),
      ],
    });
    expect(evaluateDuplicateTransaction(shareCtx)[0]!.severity).toBe('critical');
  });

  it('never pairs rows from different tables', () => {
    const ctx = emptyRuleContext({
      snapshots: withCashOutflows('80000'),
      records: [
        record({ ...base, id: 'a', dedupeHash: 'abc' }),
        record({ ...base, id: 'b', dedupeHash: 'abc', table: 'ledger_entries' }),
      ],
    });
    expect(evaluateDuplicateTransaction(ctx)).toHaveLength(0);
  });

  it('gives a ledger duplicate no subject, because the enum has no ledger_entry', () => {
    const ctx = emptyRuleContext({
      snapshots: withCashOutflows('80000'),
      records: [
        record({ ...base, id: 'a', dedupeHash: 'abc', table: 'ledger_entries' }),
        record({ ...base, id: 'b', dedupeHash: 'abc', table: 'ledger_entries' }),
      ],
    });
    const outcome = evaluateDuplicateTransaction(ctx)[0]!;
    expect(outcome.subject.type).toBe('none');
    expect(outcome.recordIds).toEqual(['a', 'b']);
  });

  it('averages monthly outflows over the trailing complete months only', () => {
    const ctx = emptyRuleContext({
      snapshots: [
        ...PERIODS.slice(-4, -1).map((periodId) =>
          snapshot({ key: 'cash_outflows', value: '30000', unit: 'money', periodId })),
        // The current, partial month must not drag the average down.
        snapshot({ key: 'cash_outflows', value: '1000', unit: 'money', periodId: CURRENT }),
      ],
      trailingCompletePeriodIds: PERIODS.slice(-4, -1),
    });
    expect(monthlyOutflows(ctx)!.toString()).toBe('30000');
  });
});

describe('bank.unusual_transaction (§8.2)', () => {
  const history = Array.from({ length: 12 }, (_, i) =>
    record({ id: `h${i}`, amount: '-500.00', periodId: PERIODS[0]!, date: '2026-01-05' }));

  function ctx(current: ReturnType<typeof record>[], extra: Partial<Parameters<typeof emptyRuleContext>[0]> = {}) {
    return emptyRuleContext({
      snapshots: withCashOutflows('20000'),
      records: current,
      trailingRecords: history,
      ...extra,
    });
  }

  it('uses max(£1,000, median + 3 x MAD) as the threshold', () => {
    // Every historic outflow is £500, so the MAD is 0 and the floor stands.
    const { threshold, median, mad } = unusualThreshold(ctx([]));
    expect(median!.toString()).toBe('500');
    expect(mad!.toString()).toBe('0');
    expect(threshold.toString()).toBe(UNUSUAL_ABSOLUTE_FLOOR.toString());
  });

  it('fires on a payment above the threshold', () => {
    const outcomes = evaluateBankUnusualTransaction(ctx([record({ id: 'big', amount: '-1000.00' })]));
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.thresholdSummary.trigger).toBe('size');
    expect(outcomes[0]!.severity).toBe('medium');
  });

  it('does not fire just below it', () => {
    expect(evaluateBankUnusualTransaction(ctx([record({ id: 'x', amount: '-999.99' })]))).toHaveLength(0);
  });

  it('is high at a quarter of monthly outflows', () => {
    const outcomes = evaluateBankUnusualTransaction(ctx([record({ id: 'huge', amount: '-5000.00' })]));
    expect(outcomes[0]!.severity).toBe('high');
  });

  it('never fires on a transfer or a recurring payment', () => {
    expect(evaluateBankUnusualTransaction(
      ctx([record({ id: 't', amount: '-9000.00', isTransfer: true })]),
    )).toHaveLength(0);
    expect(evaluateBankUnusualTransaction(
      ctx([record({ id: 'r', amount: '-9000.00', recurringGroupId: 'g1' })]),
    )).toHaveLength(0);
  });

  it('never fires on an inflow', () => {
    expect(evaluateBankUnusualTransaction(
      ctx([record({ id: 'in', amount: '90000.00' })]),
    )).toHaveLength(0);
  });

  it('fires on a smaller payment to a brand new counterparty', () => {
    const outcomes = evaluateBankUnusualTransaction(ctx(
      [record({ id: 'new', amount: '-2000.00', counterpartyId: 'cp-1' })],
      { newCounterpartyIds: ['cp-1'] },
    ));
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.thresholdSummary.trigger).toBe('size');
  });
});

describe('the recurring rules (§8.2)', () => {
  function group(spec: Partial<RecurringGroupObservation>): RecurringGroupObservation {
    return {
      id: 'g-1', groupKey: 'k1', direction: 'outflow', signature: 'acme software',
      status: 'active', occurrences: 8, expectedAmount: '100.00', lastAmount: '100.00',
      amountToleranceRatio: '0.100000', lastSeen: '2026-03-01', cadence: 'monthly',
      nextExpected: '2026-04-01', ...spec,
    };
  }

  it('fires amount_changed outside the group tolerance', () => {
    const ctx = emptyRuleContext({
      recurringGroups: [group({ status: 'changed', lastAmount: '130.00' })],
    });
    const outcomes = evaluateRecurringAmountChanged(ctx);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.severity).toBe('medium'); // 30% deviation
    expect(outcomes[0]!.thresholdSummary).toMatchObject({
      expected: '100.00', actual: '130.00', deviation: '0.300000',
    });
  });

  it('is low for a deviation inside 25% and under £250', () => {
    const ctx = emptyRuleContext({
      recurringGroups: [group({ status: 'changed', lastAmount: '115.00' })],
    });
    expect(evaluateRecurringAmountChanged(ctx)[0]!.severity).toBe('low');
  });

  it('respects a wide tolerance on a naturally variable payment', () => {
    const ctx = emptyRuleContext({
      recurringGroups: [group({
        status: 'changed', lastAmount: '130.00', amountToleranceRatio: '0.400000',
      })],
    });
    expect(evaluateRecurringAmountChanged(ctx)).toHaveLength(0);
  });

  it('only fires missed for a group with a history worth trusting', () => {
    const enough = emptyRuleContext({
      recurringGroups: [group({ status: 'stopped', occurrences: RECURRING_MISSED_MIN_OCCURRENCES })],
    });
    const tooFew = emptyRuleContext({
      recurringGroups: [group({ status: 'stopped', occurrences: RECURRING_MISSED_MIN_OCCURRENCES - 1 })],
    });
    expect(evaluateRecurringMissed(enough, 'outflow')).toHaveLength(1);
    expect(evaluateRecurringMissed(tooFew, 'outflow')).toHaveLength(0);
  });

  it('treats a missed inflow as more serious than a missed outflow', () => {
    const outflow = emptyRuleContext({ recurringGroups: [group({ status: 'stopped' })] });
    const inflow = emptyRuleContext({
      recurringGroups: [group({ status: 'stopped', direction: 'inflow' })],
    });
    expect(evaluateRecurringMissed(outflow, 'outflow')[0]!.severity).toBe('low');
    expect(evaluateRecurringMissed(inflow, 'inflow')[0]!.severity).toBe('medium');
    expect(evaluateRecurringMissed(inflow, 'inflow')[0]!.ruleKey).toBe('recurring.inflow_missed');
  });
});

describe('data-only suppression (§8.1, ADR-047.11)', () => {
  it('evaluates only the record-level rules on an incomplete period (ADR-030.4)', () => {
    const ctx = emptyRuleContext({ isComplete: false });
    expect(dataSuppressed('expense.spike_category', ctx)).toBe(true);
    expect(dataSuppression('expense.spike_category', ctx).reason).toBe('incomplete_period');
    for (const rule of ['duplicate.transaction', 'bank.unusual_transaction',
      'recurring.missed', 'recurring.amount_changed', 'recurring.inflow_missed'] as const) {
      expect(dataSuppressed(rule, ctx), rule).toBe(false);
    }
  });

  it('silences variance rules in the first period with data', () => {
    const ctx = emptyRuleContext({ isFirstPeriodWithData: true });
    expect(dataSuppression('expense.spike_category', ctx).reason).toBe('first_period');
    expect(dataSuppressed('duplicate.transaction', ctx)).toBe(false);
  });

  it('silences a rule whose figures are less than half complete', () => {
    const ctx = emptyRuleContext({
      snapshots: [snapshot({ key: 'cash_outflows', value: '1000', unit: 'money', completeness: 0.49 })],
    });
    expect(dataSuppression('duplicate.transaction', ctx).reason).toBe('low_completeness');

    const usable = emptyRuleContext({
      snapshots: [snapshot({ key: 'cash_outflows', value: '1000', unit: 'money', completeness: 0.5 })],
    });
    expect(dataSuppressed('duplicate.transaction', usable)).toBe(false);
  });

  it('floors every money condition at max(£100, 0.5% of revenue)', () => {
    expect(minAbsThreshold(null).toString()).toBe(MIN_ABS_FLOOR.toString());
    expect(minAbsThreshold(new Decimal('10000')).toString()).toBe('100');
    expect(minAbsThreshold(new Decimal('100000')).toString()).toBe('500');
  });

  it('cannot see an alert status at all', () => {
    // The whole of R2-B-11 in one assertion: the context type has no status field, so no
    // dismissal can reach a rule. A future field named like one would fail this test.
    const ctx = emptyRuleContext();
    expect(Object.keys(ctx).some((k) => /status|dismiss|acknowledg/i.test(k))).toBe(false);
  });
});

describe('evaluateConditions', () => {
  it('returns every rule, in a fixed order, with its suppression reason', () => {
    const evaluations = evaluateConditions(emptyRuleContext());
    expect(evaluations.map((e) => e.ruleKey)).toEqual([...CONDITION_RULE_KEYS]);
    for (const evaluation of evaluations) {
      expect(evaluation.suppression.suppressed).toBe(false);
      expect(evaluation.outcomes).toEqual([]);
    }
  });

  it('collects the outcomes of a named subset', () => {
    const ctx = emptyRuleContext({
      snapshots: [
        snapshot({ key: 'revenue', value: '100000', unit: 'money' }),
        variance({
          key: 'expense_by_category.variance.prev_period', value: '3000', unit: 'money',
          dimensionKey: 'marketing', pctChange: '0.40',
        }),
      ],
    });
    const evaluations = evaluateConditions(ctx);
    expect(conditionsFor(evaluations, ['expense.spike_category'])).toHaveLength(1);
    expect(conditionsFor(evaluations, ['duplicate.transaction'])).toHaveLength(0);
  });
});

describe('the rules refuse rather than guess', () => {
  it('ignores a category-dimensioned variance with no category on it', () => {
    const ctx = emptyRuleContext({
      snapshots: [
        snapshot({ key: 'revenue', value: '100000', unit: 'money' }),
        // dimension_id set, dimension_key absent: not a category, so not a category spike.
        variance({
          key: 'expense_by_category.variance.prev_period', value: '9000', unit: 'money',
          dimensionId: '00000000-0000-4000-8000-0000000000aa', pctChange: '0.90',
        }),
      ],
    });
    expect(evaluateExpenseSpikeCategory(ctx)).toHaveLength(0);
  });

  it('ignores a variance with no percentage change to read', () => {
    const ctx = emptyRuleContext({
      snapshots: [
        snapshot({ key: 'revenue', value: '100000', unit: 'money' }),
        variance({
          key: 'expense_by_category.variance.prev_period', value: '9000', unit: 'money',
          dimensionKey: 'marketing', pctChange: null,
        }),
      ],
    });
    expect(evaluateExpenseSpikeCategory(ctx)).toHaveLength(0);
  });

  it('is medium, never high on a revenue share, when revenue is unknown', () => {
    const ctx = emptyRuleContext({
      snapshots: [
        variance({
          key: 'expense_by_category.variance.prev_period', value: '600', unit: 'money',
          dimensionKey: 'marketing', pctChange: '0.30',
        }),
      ],
    });
    const outcome = evaluateExpenseSpikeCategory(ctx)[0]!;
    expect(outcome.severity).toBe('medium');
    expect(outcome.thresholdSummary.revenue).toBeNull();
  });

  it('falls back to the £1,000 floor when there is no history to take a median from', () => {
    const ctx = emptyRuleContext({ snapshots: [], trailingRecords: [] });
    const { threshold, median: centre, mad } = unusualThreshold(ctx);
    expect(centre).toBeNull();
    expect(mad).toBeNull();
    expect(threshold.toString()).toBe(UNUSUAL_ABSOLUTE_FLOOR.toString());
  });

  it('reports no share of outflows when there are no outflow figures', () => {
    const ctx = emptyRuleContext({
      snapshots: [],
      records: [record({ id: 'big', amount: '-4000.00' })],
      trailingRecords: [],
    });
    const outcome = evaluateBankUnusualTransaction(ctx)[0]!;
    expect(outcome.severity).toBe('medium');
    expect(outcome.thresholdSummary.share_of_outflows).toBeNull();
    expect(outcome.thresholdSummary.monthly_outflows).toBeNull();
  });

  it('cannot flag a new counterparty when it does not know a month of outflows', () => {
    const ctx = emptyRuleContext({
      snapshots: [],
      records: [record({ id: 'new', amount: '-200.00', counterpartyId: 'cp-1' })],
      trailingRecords: [],
      newCounterpartyIds: ['cp-1'],
    });
    expect(evaluateBankUnusualTransaction(ctx)).toHaveLength(0);
  });

  it('skips a record whose amount cannot be read at all', () => {
    const ctx = emptyRuleContext({
      snapshots: [],
      records: [
        record({ id: 'a', amount: 'not-a-number', dedupeHash: 'h' }),
        record({ id: 'b', amount: 'not-a-number', dedupeHash: 'h' }),
      ],
    });
    expect(evaluateDuplicateTransaction(ctx)).toHaveLength(0);
    expect(evaluateBankUnusualTransaction(ctx)).toHaveLength(0);
  });

  it('never pairs a record with itself', () => {
    const ctx = emptyRuleContext({
      snapshots: [],
      records: [record({ id: 'solo', amount: '-1200.00', dedupeHash: 'h' })],
    });
    expect(evaluateDuplicateTransaction(ctx)).toHaveLength(0);
  });

  it('reports a pair once, not once per ordering', () => {
    const ctx = emptyRuleContext({
      snapshots: [],
      records: [
        record({ id: 'a', amount: '-1200.00', descriptionNormalized: 'x', dedupeHash: 'h' }),
        record({ id: 'b', amount: '-1200.00', descriptionNormalized: 'x', dedupeHash: 'h' }),
      ],
    });
    expect(evaluateDuplicateTransaction(ctx)).toHaveLength(1);
  });

  it('ignores a recurring group whose expected amount is zero', () => {
    const ctx = emptyRuleContext({
      recurringGroups: [{
        id: null, groupKey: 'k', direction: 'outflow', signature: 's', status: 'changed',
        occurrences: 9, expectedAmount: '0.00', lastAmount: '50.00',
        amountToleranceRatio: '0.100000', lastSeen: '2026-03-01', cadence: 'monthly',
        nextExpected: null,
      }],
    });
    expect(evaluateRecurringAmountChanged(ctx)).toHaveLength(0);
  });

  it('falls back to the 10% floor when a group carries no tolerance', () => {
    const ctx = emptyRuleContext({
      recurringGroups: [{
        id: 'g', groupKey: 'k', direction: 'outflow', signature: 's', status: 'changed',
        occurrences: 9, expectedAmount: '100.00', lastAmount: '115.00',
        amountToleranceRatio: 'nonsense', lastSeen: '2026-03-01', cadence: 'monthly',
        nextExpected: null,
      }],
    });
    expect(evaluateRecurringAmountChanged(ctx)).toHaveLength(1);
  });
});
