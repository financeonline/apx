import { describe, expect, it } from 'vitest';
import { withMergedCounterparties, type CounterpartyRef } from '@/modules/financial-engine';

/**
 * The one closure over merges that every evidence descriptor names (ADR-108).
 *
 * The fold attributes a merged party's rows to its survivor; the rows keep their original ids. A
 * descriptor naming only the survivor re-selects only the survivor's own rows, and the drill-down
 * understates by the absorbed party's contribution. These are the shapes the engine sees.
 */
const cp = (id: string, mergedIntoId: string | null = null): CounterpartyRef => ({
  id, name: id, kind: 'customer', mergedIntoId, defaultExpenseCategory: null,
} as CounterpartyRef);

describe('withMergedCounterparties', () => {
  it('returns the ids unchanged, sorted, when nothing was merged into them', () => {
    expect(withMergedCounterparties([cp('b'), cp('a')], ['b', 'a'])).toEqual(['a', 'b']);
  });

  it('adds every party merged into a named survivor', () => {
    const parties = [cp('acme'), cp('acme-ltd', 'acme'), cp('acme-limited', 'acme'), cp('other')];
    expect(withMergedCounterparties(parties, ['acme'])).toEqual(['acme', 'acme-limited', 'acme-ltd']);
  });

  it('follows a chain: A into B, B into C, when C is named', () => {
    const parties = [cp('a', 'b'), cp('b', 'c'), cp('c')];
    expect(withMergedCounterparties(parties, ['c'])).toEqual(['a', 'b', 'c']);
  });

  it('does not add the survivor when only the absorbed party is named', () => {
    // A descriptor is about a figure; the figure belongs to the survivor. Naming an absorbed id
    // alone is not something the engine does, and the helper must not silently widen it.
    const parties = [cp('dup', 'main'), cp('main')];
    expect(withMergedCounterparties(parties, ['dup'])).toEqual(['dup']);
  });

  it('is byte-stable: the same inputs in another order give the same list', () => {
    const parties = [cp('z', 'm'), cp('m'), cp('a', 'm')];
    expect(withMergedCounterparties(parties, ['m'])).toEqual(withMergedCounterparties([...parties].reverse(), ['m']));
  });
});
