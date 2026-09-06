import { describe, it, expect } from 'vitest';
import {
  DISMISSAL_COOLDOWN_DAYS, EVALUATORS, PER_RUN_CAP, isMaterialChange, planEvaluation,
  statusOnAbsence, statusOnRecurrence, userSuppressed,
  type AlertRuleKey, type EvaluateInput, type ExistingAlert, type PlannedInsert,
  type PlannedResolve, type PlannedRevision, type PlannedTouch, type RuleOutcome,
} from '@/modules/alerts';
import { PERIODS, emptyRuleContext, snapshot, variance } from '../fixtures/health';

/**
 * The two-pass evaluation and the lifecycle (TEST_STRATEGY.md §8, §8.1; ADR-036, ADR-047.2/11).
 *
 * These are the tests about what a PERSON sees: how many alerts, which ones, and whether an alert
 * they already dealt with comes back.
 */

const NOW = '2026-04-01T00:00:00.000Z';

function baseInput(overrides: Partial<EvaluateInput> = {}): EvaluateInput {
  return {
    organizationId: 'org-1',
    calculationRunId: 'run-1',
    currency: 'GBP',
    ruleVersion: 'alerts.rules.v1',
    periods: [],
    existing: new Map(),
    now: NOW,
    evaluators: EVALUATORS,
    ...overrides,
  };
}

/** A context that makes exactly one rule fire, so the plan is about the plan and not the rules. */
function spikingPeriod(periodId: string, periodStart: string, categories: readonly string[]) {
  return {
    periodStart,
    ctx: emptyRuleContext({
      periodId,
      snapshots: [
        snapshot({ key: 'revenue', value: '100000', unit: 'money', periodId }),
        ...categories.map((category) => variance({
          key: 'expense_by_category.variance.prev_period', value: '5000', unit: 'money',
          periodId, dimensionKey: category, pctChange: '0.40',
        })),
      ],
    }),
  };
}

function inserts(plan: ReturnType<typeof planEvaluation>): PlannedInsert[] {
  return plan.changes.filter((c): c is PlannedInsert => c.kind === 'insert');
}

describe('state versus event keys (F-D-12)', () => {
  it('six months of the same persistent customer produce ONE alert', () => {
    const periods = PERIODS.map((periodId, index) => ({
      periodStart: `2025-1${index}-01`,
      ctx: emptyRuleContext({
        periodId,
        snapshots: [
          snapshot({ key: 'customer_concentration_top1', value: '0.55', periodId }),
          snapshot({
            key: 'customer_revenue', value: '55000', unit: 'money',
            periodId, dimensionId: 'cp-acme',
          }),
        ],
      }),
    }));

    const plan = planEvaluation(baseInput({ periods }));
    const created = inserts(plan).filter((c) => c.ruleKey === 'concentration.customer');
    expect(created).toHaveLength(1);
    expect(created[0]!.klass).toBe('state');
    expect(created[0]!.dedupeKey).not.toContain(PERIODS[0]!);
  });

  it('six months of expense spikes produce SIX alerts', () => {
    const periods = PERIODS.map((periodId, index) =>
      spikingPeriod(periodId, `2025-1${index}-01`, ['marketing']));

    const created = inserts(planEvaluation(baseInput({ periods })))
      .filter((c) => c.ruleKey === 'expense.spike_category');
    expect(created).toHaveLength(6);
    expect(new Set(created.map((c) => c.dedupeKey)).size).toBe(6);
  });
});

describe('the per-run cap (§8.1, R2-B-11)', () => {
  /** Thirty spiking categories across three months: forty outcomes, twenty-five rows. */
  function overflowingInput() {
    const many = Array.from({ length: 20 }, (_, i) => `cat-${String(i).padStart(2, '0')}`);
    return baseInput({
      periods: [
        spikingPeriod(PERIODS[0]!, '2025-10-01', many),
        spikingPeriod(PERIODS[5]!, '2026-03-01', many),
      ],
    });
  }

  it('persists at most twenty-five new rows and summarises the rest', () => {
    const plan = planEvaluation(overflowingInput());
    const created = inserts(plan);
    const overflow = created.filter((c) => c.ruleKey === 'attention.overflow');
    const real = created.filter((c) => c.ruleKey !== 'attention.overflow');

    expect(real).toHaveLength(PER_RUN_CAP);
    expect(overflow).toHaveLength(1);
    expect(overflow[0]!.severity).toBe('info');
    expect(overflow[0]!.thresholdSummary.count).toBe(String(40 - PER_RUN_CAP));
    expect(overflow[0]!.rendered.title).toBe('15 further items need attention');
  });

  it('spends the cap on the LATEST period first', () => {
    const real = inserts(planEvaluation(overflowingInput()))
      .filter((c) => c.ruleKey !== 'attention.overflow');

    // Every one of March's twenty findings is persisted; the backfill gets only the remainder.
    const march = real.filter((c) => c.periodId === PERIODS[5]!);
    const backfill = real.filter((c) => c.periodId === PERIODS[0]!);
    expect(march).toHaveLength(20);
    expect(backfill).toHaveLength(PER_RUN_CAP - 20);
  });

  it('persists a critical outcome even when the cap is already full', () => {
    const many = Array.from({ length: 30 }, (_, i) => `cat-${String(i).padStart(2, '0')}`);
    const periods = [
      spikingPeriod(PERIODS[0]!, '2025-10-01', many),
      {
        periodStart: '2026-03-01',
        ctx: emptyRuleContext({
          periodId: PERIODS[5]!,
          snapshots: [
            snapshot({ key: 'cash_runway_months', value: '0.5', unit: 'days', periodId: PERIODS[5]! }),
          ],
        }),
      },
    ];

    const created = inserts(planEvaluation(baseInput({ periods })));
    const critical = created.filter((c) => c.severity === 'critical');
    expect(critical).toHaveLength(1);
    expect(critical[0]!.ruleKey).toBe('cash.runway_low');
    // The critical row did not spend the budget: a full twenty-five other findings still land.
    expect(created.filter((c) => c.ruleKey !== 'attention.overflow' && c.severity !== 'critical'))
      .toHaveLength(PER_RUN_CAP);
  });

  it('writes no overflow alert when nothing overflowed', () => {
    const plan = planEvaluation(baseInput({
      periods: [spikingPeriod(PERIODS[5]!, '2026-03-01', ['marketing'])],
    }));
    expect(plan.overflow).toBe(0);
    expect(inserts(plan).some((c) => c.ruleKey === 'attention.overflow')).toBe(false);
  });
});

describe('supersession (§8.2, §8.3)', () => {
  it('does not raise an account spike inside a category that already fired', () => {
    const periods = [{
      periodStart: '2026-03-01',
      ctx: emptyRuleContext({
        periodId: PERIODS[5]!,
        snapshots: [
          snapshot({ key: 'revenue', value: '100000', unit: 'money', periodId: PERIODS[5]! }),
          variance({
            key: 'expense_by_category.variance.prev_period', value: '5000', unit: 'money',
            periodId: PERIODS[5]!, dimensionKey: 'marketing', pctChange: '0.40',
          }),
          variance({
            key: 'expense_by_account.variance.prev_period', value: '5000', unit: 'money',
            periodId: PERIODS[5]!, dimensionId: 'acct-1', basis: 'ledger', pctChange: '0.40',
          }),
        ],
      }),
    }];

    const created = inserts(planEvaluation(baseInput({ periods })));
    expect(created.map((c) => c.ruleKey)).toContain('expense.spike_category');
    expect(created.map((c) => c.ruleKey)).not.toContain('expense.spike_account');
  });

  it('does not raise variance.significant where a more specific rule already explains it', () => {
    const periodId = PERIODS[5]!;
    const periods = [{
      periodStart: '2026-03-01',
      ctx: emptyRuleContext({
        periodId,
        snapshots: [
          snapshot({ key: 'revenue', value: '100000', unit: 'money', periodId }),
          variance({
            key: 'revenue.variance.prev_period', value: '-40000', unit: 'money',
            periodId, pctChange: '-0.40',
          }),
          snapshot({ key: 'net_profit', value: '5000', unit: 'money', periodId }),
          variance({
            key: 'net_profit.variance.prev_period', value: '-20000', unit: 'money',
            periodId, pctChange: '-0.80',
          }),
        ],
      }),
    }];

    const created = inserts(planEvaluation(baseInput({ periods })));
    expect(created.map((c) => c.ruleKey)).toContain('revenue.decline');
    expect(created.map((c) => c.ruleKey)).not.toContain('variance.significant');
  });

  it('raises variance.significant when nothing more specific did', () => {
    const periodId = PERIODS[5]!;
    const periods = [{
      periodStart: '2026-03-01',
      ctx: emptyRuleContext({
        periodId,
        snapshots: [
          snapshot({ key: 'revenue', value: '100000', unit: 'money', periodId }),
          snapshot({ key: 'net_profit', value: '5000', unit: 'money', periodId }),
          variance({
            key: 'net_profit.variance.prev_period', value: '-20000', unit: 'money',
            periodId, pctChange: '-0.80',
          }),
        ],
      }),
    }];
    expect(inserts(planEvaluation(baseInput({ periods }))).map((c) => c.ruleKey))
      .toContain('variance.significant');
  });
});

// ---------------------------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------------------------

function existingAlert(overrides: Partial<ExistingAlert> = {}): ExistingAlert {
  return {
    id: 'alert-1',
    dedupeKey: 'concentration.customer|state|counterparty|cp-acme',
    ruleKey: 'concentration.customer',
    status: 'open',
    severity: 'medium',
    revisionNo: 1,
    thresholdSummary: { share: '0.400000', band: 'medium', customer: 'Acme Ltd' },
    snapshotIds: ['snap-1'],
    recordIds: [],
    dismissedAt: null,
    firstSeenAt: '2025-10-01T00:00:00.000Z',
    ...overrides,
  };
}

function outcome(overrides: Partial<RuleOutcome> = {}): RuleOutcome {
  return {
    ruleKey: 'concentration.customer' as AlertRuleKey,
    severity: 'medium',
    subject: { type: 'counterparty', id: 'cp-acme', key: null },
    periodId: PERIODS[5]!,
    thresholdSummary: { share: '0.400000', band: 'medium', customer: 'Acme Ltd' },
    snapshotIds: ['snap-1'],
    recordIds: [],
    ...overrides,
  };
}

describe('materiality (§8.1)', () => {
  it('an identical re-evaluation is not a change', () => {
    expect(isMaterialChange(existingAlert(), outcome())).toBe(false);
  });

  it('a severity change is', () => {
    expect(isMaterialChange(existingAlert(), outcome({ severity: 'high' }))).toBe(true);
  });

  it('different pinned rows are', () => {
    expect(isMaterialChange(existingAlert(), outcome({ snapshotIds: ['snap-2'] }))).toBe(true);
  });

  it('a threshold value that rounds the same way is not', () => {
    const drifted = outcome({
      ruleKey: 'cash.runway_low' as AlertRuleKey,
      thresholdSummary: { runway: '2.501' },
    });
    const before = existingAlert({
      ruleKey: 'cash.runway_low', thresholdSummary: { runway: '2.5009' },
    });
    expect(isMaterialChange(before, drifted)).toBe(false);
  });

  it('a concentration share that moved less than 5 points is not (§8.2)', () => {
    const before = existingAlert({ thresholdSummary: { share: '0.400000', band: 'medium' } });
    expect(isMaterialChange(before, outcome({
      thresholdSummary: { share: '0.440000', band: 'medium' },
    }))).toBe(false);
    expect(isMaterialChange(before, outcome({
      thresholdSummary: { share: '0.450000', band: 'medium' },
    }))).toBe(true);
  });

  it('a concentration share that crossed a band always is', () => {
    const before = existingAlert({ thresholdSummary: { share: '0.490000', band: 'medium' } });
    expect(isMaterialChange(before, outcome({
      severity: 'high', thresholdSummary: { share: '0.500000', band: 'high' },
    }))).toBe(true);
  });
});

describe('a dismissal holds, but not for ever (ADR-047.2)', () => {
  const dismissed = existingAlert({
    status: 'dismissed', dismissedAt: '2026-03-25T00:00:00.000Z',
  });

  it('suppresses the same finding inside ninety days', () => {
    expect(userSuppressed(dismissed, outcome(), NOW)).toBe(true);
    expect(statusOnRecurrence(dismissed, outcome(), NOW).status).toBe('dismissed');
  });

  it('does not suppress a worse one', () => {
    expect(userSuppressed(dismissed, outcome({ severity: 'high' }), NOW)).toBe(false);
    const decision = statusOnRecurrence(dismissed, outcome({ severity: 'high' }), NOW);
    expect(decision.status).toBe('open');
    expect(decision.reasonCode).toBe('condition_returned');
    expect(decision.reopened).toBe(true);
  });

  it('lapses after ninety days', () => {
    const later = new Date(
      Date.parse('2026-03-25T00:00:00.000Z') + DISMISSAL_COOLDOWN_DAYS * 86_400_000,
    ).toISOString();
    expect(userSuppressed(dismissed, outcome(), later)).toBe(false);
    expect(statusOnRecurrence(dismissed, outcome(), later).status).toBe('open');
  });
});

describe('re-opening and resolving', () => {
  it('a resolved state alert whose condition returns re-opens, keeping first_seen_at (R2-B-02)', () => {
    const resolved = existingAlert({ status: 'resolved' });
    const decision = statusOnRecurrence(resolved, outcome(), NOW);
    expect(decision).toEqual({
      status: 'open', reasonCode: 'condition_returned', reopened: true,
    });
  });

  it('a severity increase re-opens an acknowledged alert; a decrease does not', () => {
    const acknowledged = existingAlert({ status: 'acknowledged' });
    expect(statusOnRecurrence(acknowledged, outcome({ severity: 'high' }), NOW)).toEqual({
      status: 'open', reasonCode: 'severity_increased', reopened: false,
    });
    expect(statusOnRecurrence(acknowledged, outcome({ severity: 'low' }), NOW).status)
      .toBe('acknowledged');
  });

  it('an open alert stays open without a new reason', () => {
    expect(statusOnRecurrence(existingAlert(), outcome(), NOW)).toEqual({
      status: 'open', reasonCode: null, reopened: false,
    });
  });

  it('an open or acknowledged alert whose condition cleared is resolved', () => {
    expect(statusOnAbsence(existingAlert())).toEqual({
      status: 'resolved', reasonCode: 'condition_cleared', reopened: false,
    });
    expect(statusOnAbsence(existingAlert({ status: 'acknowledged' }))!.status).toBe('resolved');
  });

  it('a dismissed or already resolved alert is left exactly as it is', () => {
    expect(statusOnAbsence(existingAlert({ status: 'dismissed' }))).toBeNull();
    expect(statusOnAbsence(existingAlert({ status: 'resolved' }))).toBeNull();
  });
});

describe('the plan a re-run produces', () => {
  const key = 'expense.spike_category|' + PERIODS[5]! + '|standard_category|marketing';

  function rerun(existing: ExistingAlert) {
    return planEvaluation(baseInput({
      periods: [spikingPeriod(PERIODS[5]!, '2026-03-01', ['marketing'])],
      existing: new Map([[key, existing]]),
    }));
  }

  /** The outcome the fixture actually produces, so the "unchanged" case really is unchanged. */
  function currentOutcome() {
    const created = inserts(planEvaluation(baseInput({
      periods: [spikingPeriod(PERIODS[5]!, '2026-03-01', ['marketing'])],
    })))[0]!;
    return created;
  }

  it('touches, and does nothing else, when nothing changed (dedupe)', () => {
    const created = currentOutcome();
    const plan = rerun(existingAlert({
      dedupeKey: key, ruleKey: 'expense.spike_category',
      severity: created.severity, thresholdSummary: created.thresholdSummary,
      snapshotIds: created.snapshotIds, recordIds: created.recordIds,
    }));
    const touches = plan.changes.filter((c): c is PlannedTouch => c.kind === 'touch');
    expect(touches).toHaveLength(1);
    expect(plan.changes.filter((c) => c.kind === 'insert')).toHaveLength(0);
    expect(plan.changes.filter((c) => c.kind === 'revision')).toHaveLength(0);
  });

  it('writes a revision when the severity moved', () => {
    const created = currentOutcome();
    const plan = rerun(existingAlert({
      dedupeKey: key, ruleKey: 'expense.spike_category',
      severity: 'low', thresholdSummary: created.thresholdSummary,
      snapshotIds: created.snapshotIds, recordIds: created.recordIds,
    }));
    const revisions = plan.changes.filter((c): c is PlannedRevision => c.kind === 'revision');
    expect(revisions).toHaveLength(1);
    expect(revisions[0]!.previousSeverity).toBe('low');
    expect(revisions[0]!.severity).toBe(created.severity);
  });

  it('resolves an alert whose condition no longer holds', () => {
    const plan = planEvaluation(baseInput({
      // The same period, with no spike this time.
      periods: [spikingPeriod(PERIODS[5]!, '2026-03-01', [])],
      existing: new Map([[key, existingAlert({
        dedupeKey: key, ruleKey: 'expense.spike_category',
      })]]),
    }));
    const resolved = plan.changes.filter((c): c is PlannedResolve => c.kind === 'resolve');
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.statusReasonCode).toBe('condition_cleared');
  });

  it('does NOT resolve an alert whose rule was suppressed in every period', () => {
    // "We did not look" must never read as "it cleared" (ADR-054.8, ADR-056.1).
    const suppressed = {
      periodStart: '2026-03-01',
      ctx: emptyRuleContext({ periodId: PERIODS[5]!, isFirstPeriodWithData: true }),
    };
    const plan = planEvaluation(baseInput({
      periods: [suppressed],
      existing: new Map([[key, existingAlert({
        dedupeKey: key, ruleKey: 'expense.spike_category',
      })]]),
    }));
    expect(plan.changes.filter((c) => c.kind === 'resolve')).toHaveLength(0);
  });
});

describe('determinism', () => {
  it('two runs over identical data produce an identical plan', () => {
    const input = () => baseInput({
      periods: [
        spikingPeriod(PERIODS[0]!, '2025-10-01', ['travel', 'marketing']),
        spikingPeriod(PERIODS[5]!, '2026-03-01', ['software', 'marketing']),
      ],
    });
    expect(JSON.stringify(planEvaluation(input())))
      .toBe(JSON.stringify(planEvaluation(input())));
  });
});

describe('the edges of the lifecycle', () => {
  it('a dismissal with no timestamp does not suppress for ever', () => {
    // A row dismissed before `dismissed_at` existed, or by a path that forgot to set it. Treating a
    // missing timestamp as "dismissed just now" would silence a real finding indefinitely.
    const dismissed = existingAlert({ status: 'dismissed', dismissedAt: null });
    expect(userSuppressed(dismissed, outcome(), NOW)).toBe(false);
    expect(statusOnRecurrence(dismissed, outcome(), NOW).status).toBe('open');
  });

  it('an unreadable dismissal timestamp does not suppress either', () => {
    const dismissed = existingAlert({ status: 'dismissed', dismissedAt: 'not a date' });
    expect(userSuppressed(dismissed, outcome(), NOW)).toBe(false);
  });

  it('an open alert is never user-suppressed, whatever its history', () => {
    for (const status of ['open', 'acknowledged', 'resolved'] as const) {
      expect(userSuppressed(existingAlert({ status, dismissedAt: NOW }), outcome(), NOW), status)
        .toBe(false);
    }
  });

  it('compares thresholds as strings when neither is a number', () => {
    const before = existingAlert({
      ruleKey: 'duplicate.transaction', thresholdSummary: { signature: 'acme ltd' },
    });
    expect(isMaterialChange(before, outcome({
      ruleKey: 'duplicate.transaction' as AlertRuleKey,
      thresholdSummary: { signature: 'acme ltd' },
    }))).toBe(false);
    expect(isMaterialChange(before, outcome({
      ruleKey: 'duplicate.transaction' as AlertRuleKey,
      thresholdSummary: { signature: 'globex' },
    }))).toBe(true);
  });

  it('treats a field appearing or vanishing as a change', () => {
    const before = existingAlert({
      ruleKey: 'cash.runway_low', thresholdSummary: { runway: '2.5' },
    });
    expect(isMaterialChange(before, outcome({
      ruleKey: 'cash.runway_low' as AlertRuleKey,
      thresholdSummary: { runway: '2.5', receivables_overdue: '8000' },
    }))).toBe(true);
  });

  it('compares a concentration share that cannot be read at all as unchanged only when both are absent', () => {
    const before = existingAlert({ thresholdSummary: { share: null, band: 'medium' } });
    expect(isMaterialChange(before, outcome({
      thresholdSummary: { share: null, band: 'medium' },
    }))).toBe(false);
    expect(isMaterialChange(before, outcome({
      thresholdSummary: { share: '0.400000', band: 'medium' },
    }))).toBe(true);
  });
});

describe('a dismissed alert is touched, not revised', () => {
  it('records only that the engine looked', () => {
    const key = 'expense.spike_category|' + PERIODS[5]! + '|standard_category|marketing';
    const plan = planEvaluation(baseInput({
      periods: [spikingPeriod(PERIODS[5]!, '2026-03-01', ['marketing'])],
      existing: new Map([[key, existingAlert({
        dedupeKey: key,
        ruleKey: 'expense.spike_category',
        status: 'dismissed',
        severity: 'high',
        dismissedAt: '2026-03-30T00:00:00.000Z',
        // Deliberately different from what the rule will produce, so the ONLY reason this is a
        // touch rather than a revision is the dismissal.
        thresholdSummary: { category: 'marketing', pct_change: '0.10' },
        snapshotIds: [],
      })]]),
    }));

    expect(plan.changes.filter((c): c is PlannedTouch => c.kind === 'touch')).toHaveLength(1);
    expect(plan.changes.filter((c) => c.kind === 'revision')).toHaveLength(0);
  });
});

describe('the plan reports what it saw', () => {
  it('counts outcomes and suppressed rules for the audit note', () => {
    const plan = planEvaluation(baseInput({
      periods: [spikingPeriod(PERIODS[5]!, '2026-03-01', ['marketing', 'travel'])],
    }));
    expect(plan.outcomeCount).toBe(2);
    expect(plan.suppressedCount).toBeGreaterThanOrEqual(0);
  });

  it('suppresses every comparative rule on an incomplete period (ADR-030.4)', () => {
    const partial = {
      periodStart: '2026-03-01',
      ctx: emptyRuleContext({ periodId: PERIODS[5]!, isComplete: false }),
    };
    const plan = planEvaluation(baseInput({ periods: [partial] }));
    // §8.1: only `duplicate.*`, `bank.unusual_transaction` and `recurring.*` — six of eighteen —
    // are evaluated on a partial month. The other twelve are suppressed.
    expect(plan.suppressedCount).toBe(12);
    expect(plan.changes).toHaveLength(0);
  });
});
