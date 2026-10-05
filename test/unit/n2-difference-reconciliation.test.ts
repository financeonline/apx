import { describe, expect, it } from 'vitest';

import { reconcileDifference } from '@/modules/evidence';

/**
 * N-2 (re-review of 39711f5): a cumulative month's evidence must reconcile each side against its OWN
 * expected value and then the formula — never a side against the figure, which it can never total.
 * August revenue: year to date 3,310.00 less July's 2,100.00 = 1,210.00. Each case below is worked by
 * hand; the mismatches are the faults the drawer must state.
 */
describe('reconcileDifference', () => {
  const terms = (current: string | null, prior: string | null, expectedCurrent?: string | null, expectedPrior?: string | null) => [
    { sign: 1 as const, total: current, ...(expectedCurrent === undefined ? {} : { expected: expectedCurrent }) },
    { sign: -1 as const, total: prior, ...(expectedPrior === undefined ? {} : { expected: expectedPrior }) },
  ];

  it('3,310 − 2,100 = 1,210: each side matches its expected value, and the formula the figure', () => {
    expect(reconcileDifference(terms('3310.00', '2100.00', '3310.00', '2100.00'), '1210.000000')).toEqual({
      terms: [true, true], recordsResult: '1210.00', formula: true, arithmetic: true, reconciles: true,
    });
  });

  it('a side whose records no longer total what the calculation used is a fault on that side', () => {
    // A July row changed after the run: the records total 2,000; the calculation used 2,100.
    const r = reconcileDifference(terms('3310.00', '2000.00', '3310.00', '2100.00'), '1210.00');
    expect(r.terms).toEqual([true, false]);
    expect(r.recordsResult).toBe('1310.00');
    expect(r.formula).toBe(false);
    expect(r.arithmetic).toBe(true);
    expect(r.reconciles).toBe(false);
  });

  it('two offsetting errors: the formula balances but each side is a fault — never reported as reconciled', () => {
    const r = reconcileDifference(terms('3410.00', '2200.00', '3310.00', '2100.00'), '1210.00');
    expect(r.formula).toBe(true);
    expect(r.terms).toEqual([false, false]);
    expect(r.reconciles).toBe(false);
  });

  it('the engine\'s own arithmetic is checked: sides that match but do not produce the figure', () => {
    const r = reconcileDifference(terms('3310.00', '2100.00', '3310.00', '2100.00'), '1200.00');
    expect(r.terms).toEqual([true, true]);
    expect(r.formula).toBe(false);
    expect(r.arithmetic).toBe(false);
    expect(r.reconciles).toBe(false);
  });

  it('an unavailable side: nothing to compare, never a pass', () => {
    const r = reconcileDifference(terms('1000.00', null, '1000.00', null), null);
    expect(r.recordsResult).toBeNull();
    expect(r.formula).toBeNull();
    expect(r.reconciles).toBeNull();
  });

  it('a figure written before sides stated their expected value: the formula still reconciles from the records', () => {
    const r = reconcileDifference(terms('3310.00', '2100.00'), '1210.00');
    expect(r.terms).toEqual([null, null]);
    expect(r.arithmetic).toBeNull();
    expect(r.formula).toBe(true);
    expect(r.reconciles).toBe(true);
    expect(reconcileDifference(terms('3310.00', '2000.00'), '1210.00').reconciles).toBe(false);
  });

  it('to the cent: 0.004 apart reconciles, 0.01 apart does not', () => {
    expect(reconcileDifference(terms('3310.004', '2100.00', '3310.00', '2100.00'), '1210.00').reconciles).toBe(true);
    expect(reconcileDifference(terms('3310.01', '2100.00', '3310.00', '2100.00'), '1210.00').reconciles).toBe(false);
  });
});
