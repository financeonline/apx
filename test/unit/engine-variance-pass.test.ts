import { describe, expect, it } from 'vitest';
import {
  comparisonPeriodIds, monthsBefore, variancesForPeriod,
  type EvidenceQuery, type MetricResult, type PeriodRef, type StoredFigure,
} from '@/modules/financial-engine';

/** The ids a derived evidence query names, in order. */
const idsOf = (q: EvidenceQuery | null | undefined): Array<string | null> =>
  q?.kind === 'derived' ? q.components.map((c) => c.snapshot_id) : [];

/**
 * The variance pass (FINANCIAL_ENGINE.md §3.2; ADR-080): the run's one place where levels become
 * comparisons. `computeVariance` is tested on its own; this pins the WIRING — where a comparison
 * comes from, how a category dimension is written, that growth names its variance, and that the
 * ids the evidence chain needs are real.
 */

const period = (id: string, start: string, end: string): PeriodRef => ({
  id, periodStart: start, periodEnd: end, fiscalYear: Number(start.slice(0, 4)), fiscalQuarter: 1, label: start, isComplete: true,
});
const MAR = period('p-mar', '2026-03-01', '2026-03-31');
const APR = period('p-apr', '2026-04-01', '2026-04-30');
const MAY = period('p-may', '2026-05-01', '2026-05-31');
const ALL = [MAR, APR, MAY];

const level = (id: string, key: string, value: string, over: Partial<MetricResult> = {}): MetricResult => ({
  id, key, value, unit: 'money', basis: 'ledger', assurance: 'calculated', dimensionType: 'none', dimensionId: null,
  currency: 'GBP', components: {}, dataQuality: { completeness: 1, proxy: false, warnings: [], missing: [] }, evidenceQuery: null, ...over,
});

let n = 0;
const mint = () => `v-${(n += 1)}`;

describe('offsets', () => {
  it('walks back whole months, across a year end', () => {
    expect(monthsBefore('2026-05-01', 1)).toBe('2026-04-01');
    expect(monthsBefore('2026-01-01', 1)).toBe('2025-12-01');
    expect(monthsBefore('2026-05-01', 12)).toBe('2025-05-01');
  });
  it('names only the comparison periods that exist', () => {
    expect(comparisonPeriodIds(MAY, ALL).sort()).toEqual(['p-apr', 'p-mar']);
  });
});

describe('variancesForPeriod', () => {
  it('compares against this run’s own result for the previous month, and names both snapshots', () => {
    const april = [level('s-apr-rev', 'revenue', '18000.00')];
    const may = [level('s-may-rev', 'revenue', '25000.00')];
    const out = variancesForPeriod({
      period: MAY, allPeriods: ALL, results: may, computed: new Map([['p-apr', april]]), stored: [], currency: 'GBP', mint,
    });
    const prev = out.find((r) => r.key === 'revenue.variance.prev_period');
    expect(prev?.value).toBe('7000.00');
    expect(prev?.components.pct_change).toBeTruthy();
    expect(prev?.evidenceQuery).toEqual({ kind: 'derived', components: [
      { name: 'current', snapshot_id: 's-may-rev' }, { name: 'comparison', snapshot_id: 's-apr-rev' },
    ] });
    expect(prev?.id).toMatch(/^v-/);
  });

  it('falls back to the stored current figure for a period this run did not compute', () => {
    const stored: StoredFigure[] = [{
      periodId: 'p-apr', metricKey: 'revenue', dimensionType: 'none', dimensionId: null, dimensionKey: null,
      snapshotId: 'stored-apr-rev', value: '18000.00', basis: 'ledger', assurance: 'calculated', dataQuality: { completeness: 1 },
    }];
    const out = variancesForPeriod({
      period: MAY, allPeriods: ALL, results: [level('s-may-rev', 'revenue', '25000.00')], computed: new Map(), stored, currency: 'GBP', mint,
    });
    const prev = out.find((r) => r.key === 'revenue.variance.prev_period');
    expect(prev?.value).toBe('7000.00');
    expect(idsOf(prev?.evidenceQuery)).toEqual(['s-may-rev', 'stored-apr-rev']);
  });

  it('writes a category variance under dimension_key, never a uuid column', () => {
    const april = [level('s-apr-mk', 'expense_by_category', '1200.00', { dimensionType: 'standard_category', dimensionKey: 'marketing' })];
    const may = [level('s-may-mk', 'expense_by_category', '3400.00', { dimensionType: 'standard_category', dimensionKey: 'marketing' })];
    const out = variancesForPeriod({
      period: MAY, allPeriods: ALL, results: may, computed: new Map([['p-apr', april]]), stored: [], currency: 'GBP', mint,
    });
    const mk = out.find((r) => r.key === 'expense_by_category.variance.prev_period');
    expect(mk?.dimensionType).toBe('standard_category');
    expect(mk?.dimensionId).toBeNull();
    expect(mk?.dimensionKey).toBe('marketing');
    expect(mk?.value).toBe('2200.00');
    expect(idsOf(mk?.evidenceQuery)).toEqual(['s-may-mk', 's-apr-mk']);
  });

  it('writes revenue growth as its own ratio metric that names the variance it came from', () => {
    const out = variancesForPeriod({
      period: MAY, allPeriods: ALL, results: [level('s-may-rev', 'revenue', '25000.00')],
      computed: new Map([['p-apr', [level('s-apr-rev', 'revenue', '20000.00')]]]), stored: [], currency: 'GBP', mint,
    });
    const growth = out.find((r) => r.key === 'revenue_growth_mom');
    const variance = out.find((r) => r.key === 'revenue.variance.prev_period');
    expect(growth?.unit).toBe('ratio');
    // (25,000 − 20,000) / 20,000, at the six places the domain writes a ratio with.
    expect(growth?.value).toBe('0.250000');
    expect(idsOf(growth?.evidenceQuery)[0]).toBe(variance?.id);
  });

  it('a missing comparison period is comparison_period_missing, not zero', () => {
    const out = variancesForPeriod({
      period: MAR, allPeriods: ALL, results: [level('s-mar-rev', 'revenue', '1000.00')], computed: new Map(), stored: [], currency: 'GBP', mint,
    });
    const prev = out.find((r) => r.key === 'revenue.variance.prev_period');
    expect(prev?.value).toBeNull();
    expect(prev?.dataQuality.missing).toContain('comparison_period_missing');
  });

  it('writes nothing for a base metric absent on both sides', () => {
    const out = variancesForPeriod({
      period: MAY, allPeriods: ALL, results: [level('s-may-rev', 'revenue', '1.00')], computed: new Map(), stored: [], currency: 'GBP', mint,
    });
    expect(out.some((r) => r.key.startsWith('receivables.variance'))).toBe(false);
  });
});
