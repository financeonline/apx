import { describe, it, expect } from 'vitest';
import {
  bankingAnomalies, computeHealthScore, spikeConditions,
} from '@/modules/health';
import {
  CURRENT, PERIODS, baselineSnapshots, emptyRuleContext, healthInput, record, snapshot, variance,
} from '../fixtures/health';

/**
 * K3 and B3 count CONDITIONS, never alerts (§7.3, R2-B-11, F-C-12).
 *
 * The tests below are the ones that make ADR-035's promise checkable. A health score that could see
 * an alert's status would rise when somebody dismissed an alert — the number would measure clicking
 * rather than trading. The type system already forbids it (`RuleContext` has no status field); these
 * tests prove the behaviour end to end, over a context that carries every kind of user-facing state
 * a Phase 9 alert row could ever have.
 */

function spikes(count: number) {
  const categories = ['advertising', 'marketing', 'software', 'travel', 'utilities'];
  return categories.slice(0, count).map((category) => variance({
    key: 'expense_by_category.variance.prev_period', value: '4000', unit: 'money',
    dimensionKey: category, pctChange: '0.40',
  }));
}

function inputWithSpikes(count: number) {
  const snapshots = [...baselineSnapshots(), ...spikes(count)];
  return healthInput({ snapshots, conditions: emptyRuleContext({ snapshots }) });
}

describe('K3 counts spike conditions from this run’s snapshots', () => {
  it.each([[0, 10], [1, -5], [2, -5], [3, -15], [5, -15]])(
    '%i spiking categories scores %i',
    (count, points) => {
      const score = computeHealthScore(inputWithSpikes(count))!;
      const k3 = score.breakdown.find((d) => d.key === 'cost_control')!
        .rules.find((r) => r.rule === 'K3')!;
      expect(k3.points).toBe(points);
    },
  );

  it('pins the snapshot behind every counted condition (§7.4)', () => {
    const score = computeHealthScore(inputWithSpikes(2))!;
    const costControl = score.breakdown.find((d) => d.key === 'cost_control')!;
    expect(costControl.conditions).toHaveLength(2);
    for (const condition of costControl.conditions) {
      expect(condition.rule_key).toBe('expense.spike_category');
      expect(condition.subject_key).not.toBeNull();
      expect(condition.snapshot_ids.length).toBeGreaterThan(0);
    }
  });

  it('names the categories in the negatives, with their numbers', () => {
    const score = computeHealthScore(inputWithSpikes(1))!;
    const costControl = score.breakdown.find((d) => d.key === 'cost_control')!;
    expect(costControl.negatives).toEqual(['advertising spending jumped 40.0% this month']);
    expect(costControl.negatives_structured[0]!.values).toEqual({
      category: 'advertising', pct: '0.400000',
    });
  });

  it('is skipped, not scored as clean, when the spike rule could not run', () => {
    const snapshots = baselineSnapshots();
    const score = computeHealthScore(healthInput({
      snapshots,
      conditions: emptyRuleContext({ snapshots, isFirstPeriodWithData: true }),
    }))!;
    const k3 = score.breakdown.find((d) => d.key === 'cost_control')!
      .rules.find((r) => r.rule === 'K3')!;
    expect(k3.points).toBe(0);
    expect(k3.skipped_reason).toBe('first_period');
  });

  it('is skipped when no record-level data was loaded at all', () => {
    const k3 = computeHealthScore(healthInput({ conditions: null }))!
      .breakdown.find((d) => d.key === 'cost_control')!.rules.find((r) => r.rule === 'K3')!;
    expect(k3.skipped_reason).toBe('no_record_data');
  });
});

describe('B3 counts banking anomalies across five rules', () => {
  function bankingInput(records: ReturnType<typeof record>[]) {
    const snapshots = baselineSnapshots();
    return healthInput({
      snapshots,
      conditions: emptyRuleContext({
        snapshots,
        records,
        trailingRecords: Array.from({ length: 8 }, (_, i) =>
          record({ id: `h${i}`, amount: '-400.00', periodId: PERIODS[0]! })),
      }),
    });
  }

  it('scores +10 for a clean month', () => {
    const b3 = computeHealthScore(bankingInput([]))!
      .breakdown.find((d) => d.key === 'banking_health')!.rules.find((r) => r.rule === 'B3')!;
    expect(b3.points).toBe(10);
  });

  it('counts a duplicate and an unusual payment together', () => {
    const input = bankingInput([
      record({ id: 'd1', amount: '-2000.00', descriptionNormalized: 'acme', dedupeHash: 'h' }),
      record({ id: 'd2', amount: '-2000.00', descriptionNormalized: 'acme', dedupeHash: 'h' }),
    ]);
    const banking = computeHealthScore(input)!.breakdown.find((d) => d.key === 'banking_health')!;
    // One duplicate pair plus two unusually large payments.
    expect(banking.conditions.length).toBeGreaterThanOrEqual(3);
    expect(banking.rules.find((r) => r.rule === 'B3')!.points).toBe(-15);
    expect(new Set(banking.conditions.map((c) => c.rule_key)))
      .toEqual(new Set(['duplicate.transaction', 'bank.unusual_transaction']));
  });

  it('is skipped rather than scored +10 when every banking rule was suppressed', () => {
    const snapshots = baselineSnapshots();
    const b3 = computeHealthScore(healthInput({
      snapshots,
      conditions: emptyRuleContext({
        snapshots: [
          ...snapshots.filter((s) => !(s.metricKey === 'cash_outflows' && s.periodId === CURRENT)),
          ...['cash_outflows', 'cash_inflows'].map((key) =>
            snapshot({ key, value: '1000', unit: 'money', completeness: 0.1 })),
        ],
      }),
    }))!.breakdown.find((d) => d.key === 'banking_health')!.rules.find((r) => r.rule === 'B3')!;
    expect(b3.points).toBe(0);
    expect(b3.skipped_reason).toBe('low_completeness');
  });
});

describe('the score does not move when an alert is acknowledged or dismissed (R2-B-11, F-C-12)', () => {
  /**
   * A Phase 9 alert row carries a status, a dismissal timestamp and an acknowledger. The rule
   * context is built without any of them, so this test constructs the SAME data twice with those
   * fields present in the surrounding object and asserts the score is byte-identical.
   */
  function run(alertState: Record<string, unknown>) {
    const snapshots = [...baselineSnapshots(), ...spikes(2)];
    const conditions = emptyRuleContext({
      snapshots,
      records: [
        record({ id: 'd1', amount: '-2000.00', descriptionNormalized: 'acme', dedupeHash: 'h' }),
        record({ id: 'd2', amount: '-2000.00', descriptionNormalized: 'acme', dedupeHash: 'h' }),
      ],
      trailingRecords: Array.from({ length: 8 }, (_, i) =>
        record({ id: `h${i}`, amount: '-400.00', periodId: PERIODS[0]! })),
    });
    // Whatever a caller attaches, the engine reads only the declared fields.
    return computeHealthScore(healthInput({
      snapshots,
      conditions: { ...conditions, ...alertState } as typeof conditions,
    }))!;
  }

  it('gives identical scores before and after every alert is dismissed', () => {
    const before = run({});
    const after = run({
      alerts: [
        { rule_key: 'expense.spike_category', status: 'dismissed', dismissed_at: '2026-03-20' },
        { rule_key: 'duplicate.transaction', status: 'dismissed', dismissed_at: '2026-03-20' },
        { rule_key: 'bank.unusual_transaction', status: 'acknowledged' },
      ],
      dismissedRuleKeys: ['expense.spike_category', 'duplicate.transaction'],
    });

    expect(after.score).toBe(before.score);
    expect(JSON.stringify(after.breakdown)).toBe(JSON.stringify(before.breakdown));
  });

  it('the K3 and B3 counts themselves are identical', () => {
    const before = run({});
    const after = run({ alerts: [{ status: 'dismissed' }] });

    const k3 = (s: typeof before) => s.breakdown.find((d) => d.key === 'cost_control')!
      .rules.find((r) => r.rule === 'K3')!.points;
    const b3 = (s: typeof before) => s.breakdown.find((d) => d.key === 'banking_health')!
      .rules.find((r) => r.rule === 'B3')!.points;

    expect(k3(after)).toBe(k3(before));
    expect(b3(after)).toBe(b3(before));
  });

  it('the counts DO change when the data changes', () => {
    // The control for the test above: if nothing could move these counts, they would prove nothing.
    const one = computeHealthScore(inputWithSpikes(1))!;
    const four = computeHealthScore(inputWithSpikes(4))!;
    const k3 = (s: typeof one) => s.breakdown.find((d) => d.key === 'cost_control')!
      .rules.find((r) => r.rule === 'K3')!.points;
    expect(k3(one)).toBe(-5);
    expect(k3(four)).toBe(-15);
  });
});

describe('the shared helpers behave the same for health as for the alert job', () => {
  it('spikeConditions returns the same outcomes the rule function does', () => {
    const input = inputWithSpikes(3);
    expect(spikeConditions(input).outcomes.map((o) => o.subject.key))
      .toEqual(['advertising', 'marketing', 'software']);
  });

  it('bankingAnomalies reports suppression rather than an empty count', () => {
    expect(bankingAnomalies(healthInput({ conditions: null }))).toEqual({
      outcomes: [], suppressed: true, suppressionReason: 'no_record_data',
    });
  });
});
