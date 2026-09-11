import { describe, expect, it } from 'vitest';
import { ASSURANCE_LEVELS, weakestIn, weakestOf, type AssuranceLevel } from '@/core/assurance';
import { minAssurance as minOverList } from '@/modules/evidence';
import { minAssurance as minOverPair } from '@/modules/financial-engine';

/**
 * One assurance ladder (EVIDENCE_MODEL.md §7; ADR-094).
 *
 * There were two rank tables for these four values, ordered against each other — `verified: 0 …
 * inferred: 3` in `modules/evidence`, `verified: 3 … inferred: 0` in `financial-engine/domain/pnl`
 * — under two exported functions both called `minAssurance`, plus two declarations of the type
 * itself. Both were correct. Nothing held them together, and a fifth level would have had to be
 * added to two tables in opposite directions.
 *
 * These cases hold the surviving entry points against the ladder over every pair, so a divergence
 * is a failing test rather than a figure that claims to be firmer than its evidence.
 */

describe('the two forms agree over every pair of levels', () => {
  for (const a of ASSURANCE_LEVELS) {
    for (const b of ASSURANCE_LEVELS) {
      it(`${a} vs ${b}`, () => {
        const expected = weakestOf(a, b);
        expect(minOverPair(a, b), 'the engine pairwise form').toBe(expected);
        expect(minOverList([a, b]), 'the evidence list form').toBe(expected);
      });
    }
  }
});

describe('the ladder itself', () => {
  it('runs verified > calculated > estimated > inferred', () => {
    expect([...ASSURANCE_LEVELS]).toEqual(['verified', 'calculated', 'estimated', 'inferred']);
  });

  it('is order-independent: the weakest of a list is the weakest however it is shuffled', () => {
    const levels: AssuranceLevel[] = ['calculated', 'inferred', 'verified', 'estimated'];
    expect(weakestIn(levels)).toBe('inferred');
    expect(weakestIn([...levels].reverse())).toBe('inferred');
  });

  it('is commutative and idempotent', () => {
    for (const a of ASSURANCE_LEVELS) {
      expect(weakestOf(a, a)).toBe(a);
      for (const b of ASSURANCE_LEVELS) expect(weakestOf(a, b)).toBe(weakestOf(b, a));
    }
  });

  it('answers null for an empty list rather than inventing `verified` (§8.6)', () => {
    expect(weakestIn([])).toBeNull();
    expect(minOverList([])).toBeNull();
  });
});
