import { describe, expect, it } from 'vitest';

import {
  AS_OF_DEPENDENT_KEYS, COMPUTATION_ORDER, METRIC_DEFINITIONS, VARIANCE_BASES,
  isMetricKey, metricDefinition, varianceKey,
} from '@/modules/financial-engine';
import { computeFingerprint, __canonical } from '@/modules/financial-engine';
import { affectedRange, chunkPeriods, chunkWindow } from '@/modules/financial-engine';
import { CHUNK_PERIODS, ENGINE_VERSION } from '@/modules/financial-engine';
import type { PeriodRef } from '@/modules/financial-engine';

/**
 * The run-control layer (FINANCIAL_ENGINE.md §2.4, §3.6, §6).
 *
 * These are the guarantees the whole engine rests on: that a key nobody declared is an error, that
 * two runs over identical data are indistinguishable, and that a run computes the periods it should
 * and no others.
 */

const period = (n: number): PeriodRef => ({
  id: `p${String(n).padStart(2, '0')}`,
  periodStart: `2026-${String(((n - 1) % 12) + 1).padStart(2, '0')}-01`,
  periodEnd: `2026-${String(((n - 1) % 12) + 1).padStart(2, '0')}-28`,
  fiscalYear: 2026, fiscalQuarter: 1, label: `M${n}`, isComplete: true,
});
const periods = (count: number) => Array.from({ length: count }, (_, i) => period(i + 1));

describe('the registry is the single declaration of every metric (§3.6)', () => {
  it('declares every key exactly once', () => {
    const keys = METRIC_DEFINITIONS.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('makes an undeclared key an error rather than a silent unknown', () => {
    // A key nobody declared cannot be labelled, described, rolled up or grounded.
    expect(() => metricDefinition('revenue')).not.toThrow();
    expect(() => metricDefinition('made_up_metric')).toThrow(/Unknown metric key/);
    expect(isMetricKey('made_up_metric')).toBe(false);
  });

  it('gives every metric a label and a plain-language description', () => {
    for (const definition of METRIC_DEFINITIONS) {
      // The label is what the AI grounding check looks for near a quoted number (ADR-045.1).
      expect(definition.label.length, `${definition.key} has no label`).toBeGreaterThan(0);
      expect(definition.description.length, `${definition.key} has no description`).toBeGreaterThan(10);
      expect(definition.description.endsWith('.'), `${definition.key} description`).toBe(true);
    }
  });

  it('never lets a metric depend on one at its own level or above', () => {
    // This is what makes the computation order a topological sort rather than a guess.
    for (const definition of METRIC_DEFINITIONS) {
      for (const dependency of definition.dependencies) {
        const upstream = metricDefinition(dependency);
        expect(
          upstream.level,
          `${definition.key} (L${definition.level}) depends on ${dependency} (L${upstream.level})`,
        ).toBeLessThan(definition.level);
      }
    }
  });

  it('orders computation so every dependency comes first', () => {
    const position = new Map(COMPUTATION_ORDER.map((key, i) => [key, i]));
    for (const definition of METRIC_DEFINITIONS) {
      for (const dependency of definition.dependencies) {
        expect(position.get(dependency)!).toBeLessThan(position.get(definition.key)!);
      }
    }
  });

  it('produces the same computation order every time', () => {
    expect(COMPUTATION_ORDER).toEqual([...COMPUTATION_ORDER]);
    expect(COMPUTATION_ORDER.length).toBe(METRIC_DEFINITIONS.length);
  });

  it('derives the as-of-dependent set from the registry rather than a second list', () => {
    // ADR-047.8: a nightly run recomputes exactly these. Hard-coding the list elsewhere is how one
    // gets forgotten when a metric is added.
    expect(AS_OF_DEPENDENT_KEYS).toContain('receivables_overdue');
    expect(AS_OF_DEPENDENT_KEYS).toContain('payables_overdue');
    expect(AS_OF_DEPENDENT_KEYS).toContain('cash_runway_months');
    expect(AS_OF_DEPENDENT_KEYS).toContain('receivables_days');
    expect(AS_OF_DEPENDENT_KEYS).not.toContain('revenue');
  });

  it('names every variance base as a real metric', () => {
    for (const base of VARIANCE_BASES) {
      expect(isMetricKey(base), `${base} is not a declared metric`).toBe(true);
    }
    expect(varianceKey('revenue', 'prev_period')).toBe('revenue.variance.prev_period');
  });

  it('carries a semver engine version', () => {
    expect(ENGINE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('the fingerprint decides whether a run has anything to do (ADR-047.8)', () => {
  const base = {
    organizationId: 'org-1', engineVersion: ENGINE_VERSION,
    periodFrom: 'p01', periodTo: 'p12',
    maxRecordEventAt: '2026-05-01T10:00:00Z',
    rowCounts: { ledger: 100, bank: 50 },
    accountCategories: { 'acc-1': 'revenue', 'acc-2': 'payroll' },
    categoryHistoryHeads: { 'txn-1': 'hist-1' },
    counterpartyMerges: {},
    settings: { baseCurrency: 'GBP', fiscalYearStartMonth: 4 },
    detectorVersion: 'recurring.v1',
    asOfDate: null,
  };

  it('is stable across runs over identical data', () => {
    expect(computeFingerprint(base)).toBe(computeFingerprint(base));
  });

  it('does not depend on the order the database returned rows in', () => {
    const reordered = {
      ...base,
      accountCategories: { 'acc-2': 'payroll', 'acc-1': 'revenue' },
      rowCounts: { bank: 50, ledger: 100 },
    };
    expect(computeFingerprint(reordered)).toBe(computeFingerprint(base));
  });

  it('changes when a record moves', () => {
    expect(computeFingerprint({ ...base, maxRecordEventAt: '2026-05-01T10:00:01Z' }))
      .not.toBe(computeFingerprint(base));
  });

  it('changes when rows are removed even though the latest instant is unchanged', () => {
    // A rollback can leave the max event instant alone while emptying a month.
    expect(computeFingerprint({ ...base, rowCounts: { ledger: 90, bank: 50 } }))
      .not.toBe(computeFingerprint(base));
  });

  it('changes when an account is re-categorised', () => {
    expect(computeFingerprint({
      ...base, accountCategories: { 'acc-1': 'other_income', 'acc-2': 'payroll' },
    })).not.toBe(computeFingerprint(base));
  });

  it('changes when a counterparty is merged', () => {
    expect(computeFingerprint({ ...base, counterpartyMerges: { 'cp-2': 'cp-1' } }))
      .not.toBe(computeFingerprint(base));
  });

  it('changes when the engine version changes', () => {
    expect(computeFingerprint({ ...base, engineVersion: '2.0.0' })).not.toBe(computeFingerprint(base));
  });

  it('changes when the banking detector changes', () => {
    // §4.3: a new detector produces different recurring groups, so the run is not a no-change run.
    expect(computeFingerprint({ ...base, detectorVersion: 'recurring.v2' }))
      .not.toBe(computeFingerprint(base));
  });

  it('ignores today when the range does not reach the current period', () => {
    // Including asOf always would make every nightly run look different and the optimisation would
    // never fire.
    expect(computeFingerprint({ ...base, asOfDate: null })).toBe(computeFingerprint(base));
  });

  it('but changes with today when it does', () => {
    const monday = computeFingerprint({ ...base, asOfDate: '2026-05-04' });
    const tuesday = computeFingerprint({ ...base, asOfDate: '2026-05-05' });
    expect(tuesday, 'aging and runway move overnight').not.toBe(monday);
  });

  it('serialises deterministically regardless of key order', () => {
    expect(__canonical({ b: 1, a: 2 })).toBe(__canonical({ a: 2, b: 1 }));
    expect(__canonical([3, 1, 2])).toBe(__canonical([1, 2, 3]));
  });
});

describe('which periods a run computes (§2.4)', () => {
  const all = periods(24);

  it('computes from the earliest changed period, reading twelve months before it', () => {
    const range = affectedRange({
      trigger: 'import_commit', changedPeriodIds: ['p18', 'p15'], allPeriods: all,
      currentPeriodId: 'p24',
    });
    expect(range.affectedFrom).toBe('p15');
    // Comparisons need the previous year, read but never rewritten.
    expect(range.readFrom).toBe('p03');
    expect(range.to).toBe('p24');
    expect(range.asOfDependentOnly).toBe(false);
  });

  it('recomputes everything when an account is re-categorised', () => {
    // A remap changes how every month is computed, not only the months whose records moved.
    const range = affectedRange({
      trigger: 'account_remapped', changedPeriodIds: ['p20'], allPeriods: all, currentPeriodId: 'p24',
    });
    expect(range.affectedFrom).toBe('p01');
  });

  it('recomputes everything on a manual recalculation and on a settings change', () => {
    for (const trigger of ['recalc_manual', 'settings_changed'] as const) {
      expect(affectedRange({
        trigger, changedPeriodIds: [], allPeriods: all, currentPeriodId: 'p24',
      }).affectedFrom, trigger).toBe('p01');
    }
  });

  it('touches only the current period, and only as-of keys, on a scheduled run', () => {
    const range = affectedRange({
      trigger: 'scheduled', changedPeriodIds: [], allPeriods: all, currentPeriodId: 'p24',
    });
    expect(range.affectedFrom).toBe('p24');
    expect(range.to).toBe('p24');
    expect(range.asOfDependentOnly, 'a nightly run must not rewrite a year of snapshots').toBe(true);
  });

  it('does nothing on a scheduled run when there is no current period', () => {
    // An organization whose calendar has not reached today yet. The nightly run has nothing to
    // recompute rather than falling back to the whole range.
    const range = affectedRange({
      trigger: 'scheduled', changedPeriodIds: [], allPeriods: all, currentPeriodId: null,
    });
    expect(range.affectedFrom).toBeNull();
    expect(range.asOfDependentOnly).toBe(true);
  });

  it('does nothing on a scheduled run when the current period is not one of ours', () => {
    const range = affectedRange({
      trigger: 'scheduled', changedPeriodIds: [], allPeriods: all, currentPeriodId: 'not-a-period',
    });
    expect(range.affectedFrom).toBeNull();
  });

  it('does nothing when nothing changed', () => {
    const range = affectedRange({
      trigger: 'import_commit', changedPeriodIds: [], allPeriods: all, currentPeriodId: 'p24',
    });
    expect(range.affectedFrom).toBeNull();
  });

  it('handles an organization with no periods at all', () => {
    const range = affectedRange({
      trigger: 'recalc_manual', changedPeriodIds: [], allPeriods: [], currentPeriodId: null,
    });
    expect(range).toEqual({ affectedFrom: null, readFrom: null, to: null, asOfDependentOnly: false });
  });

  it('ignores a changed period the organization does not have', () => {
    const range = affectedRange({
      trigger: 'import_commit', changedPeriodIds: ['nope'], allPeriods: all, currentPeriodId: 'p24',
    });
    expect(range.affectedFrom).toBeNull();
  });
});

describe('chunking (§2.4)', () => {
  it('slices into chunks of at most the configured size, oldest first', () => {
    const chunks = chunkPeriods(periods(30));
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(CHUNK_PERIODS);
    expect(chunks[2]).toHaveLength(30 - 2 * CHUNK_PERIODS);
    // Oldest first matters: cross-period inputs read pointers the previous chunk wrote.
    expect(chunks[0]![0]!.id).toBe('p01');
    expect(chunks[2]![chunks[2]!.length - 1]!.id).toBe('p30');
  });

  it('returns one chunk when everything fits', () => {
    expect(chunkPeriods(periods(5))).toHaveLength(1);
  });

  it('returns nothing for no periods', () => {
    expect(chunkPeriods([])).toHaveLength(0);
  });

  it('refuses a chunk size below one rather than looping forever', () => {
    expect(() => chunkPeriods(periods(3), 0)).toThrow();
  });

  it('gives a chunk twelve months of lead-in for its comparisons', () => {
    const all = periods(30);
    const chunk = all.slice(15, 20);
    const window = chunkWindow(all, chunk);
    expect(window[0]!.id).toBe('p04');
    expect(window[window.length - 1]!.id).toBe('p20');
  });

  it('does not read before the start of history', () => {
    const all = periods(30);
    const window = chunkWindow(all, all.slice(0, 3));
    expect(window[0]!.id).toBe('p01');
  });
});
