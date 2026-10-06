import { describe, expect, it } from 'vitest';
import {
  assessAffordability, parseWrittenAmount, writtenInQuestion,
  type AffordabilityInput, type ScenarioBasis,
} from '@/modules/scenarios';

/**
 * Affordability (SOW §12; ADR-146). Every expected figure is worked by hand from the basis beside it:
 * opening cash 10,000.00; money in 8,000.00 and money out 7,000.00 a month, so cash rises by
 * 1,000.00 a month to 11,000.00, 12,000.00 and 13,000.00. The buffer is one month of money out,
 * 7,000.00.
 */

const HORIZON = [
  { periodId: 'p1', periodStart: '2026-10-01', periodLabel: 'Oct 2026' },
  { periodId: 'p2', periodStart: '2026-11-01', periodLabel: 'Nov 2026' },
  { periodId: 'p3', periodStart: '2026-12-01', periodLabel: 'Dec 2026' },
];

const basis = (over: Partial<ScenarioBasis['leafLevels']> = {}, opening: string | null = '10000.00'): ScenarioBasis => ({
  leafLevels: {
    revenue: '9000.00', cost_of_sales: '2000.00', operating_expenses: '4000.00',
    cash_inflows: '8000.00', cash_outflows: '7000.00', receivables: null, payables: null, ...over,
  },
  categoryLevels: {},
  lastActualClosingCash: opening,
});

const check = (over: Partial<AffordabilityInput>) => assessAffordability({
  amount: '1000.00', recurrence: 'one_off', startsInMonth: 1, basis: basis(), horizon: HORIZON, ...over,
});

describe('the verdict', () => {
  it('affordable: a one-off 3,000.00 in October leaves 8,000.00, above the 7,000.00 buffer', () => {
    const r = check({ amount: '3000.00' });
    expect(r.months.map((m) => [m.expectedCash, m.cashAfter])).toEqual([
      ['11000.00', '8000.00'], ['12000.00', '9000.00'], ['13000.00', '10000.00'],
    ]);
    expect(r).toMatchObject({
      verdict: 'affordable', verdictWithout: 'affordable', totalSpent: '3000.00', buffer: '7000.00', headroom: '1000.00',
      lowest: { periodLabel: 'Oct 2026', cashAfter: '8000.00' }, lowestWithout: { periodLabel: 'Oct 2026', expectedCash: '11000.00' },
    });
  });

  it('exactly the buffer is affordable', () => {
    expect(check({ amount: '4000.00' })).toMatchObject({ verdict: 'affordable', headroom: '0.00' });
  });

  it('tight: 5,000.00 leaves 6,000.00 — still positive, 1,000.00 short of the buffer', () => {
    expect(check({ amount: '5000.00' })).toMatchObject({ verdict: 'tight', headroom: '-1000.00', lowest: { cashAfter: '6000.00' } });
  });

  it('tight at exactly zero: 12,000.00 in November leaves 0.00 that month', () => {
    const r = check({ amount: '12000.00', startsInMonth: 2 });
    expect(r.months.map((m) => m.cashAfter)).toEqual(['11000.00', '0.00', '1000.00']);
    expect(r).toMatchObject({ verdict: 'tight', lowest: { periodLabel: 'Nov 2026', cashAfter: '0.00' } });
  });

  it('not affordable: a penny below zero', () => {
    expect(check({ amount: '11000.01' })).toMatchObject({ verdict: 'not_affordable', lowest: { cashAfter: '-0.01' } });
  });

  it('a monthly cost counts in every month from its start: 1,500.00 a month turns +1,000.00 into −500.00', () => {
    const r = check({ amount: '1500.00', recurrence: 'monthly' });
    expect(r.months.map((m) => m.cashAfter)).toEqual(['9500.00', '9000.00', '8500.00']);
    expect(r).toMatchObject({ verdict: 'affordable', totalSpent: '4500.00', lowest: { periodLabel: 'Dec 2026' } });
  });

  it('a monthly cost starting in November leaves October alone', () => {
    const r = check({ amount: '4000.00', recurrence: 'monthly', startsInMonth: 2 });
    expect(r.months.map((m) => m.cashAfter)).toEqual(['11000.00', '8000.00', '5000.00']);
    expect(r).toMatchObject({ verdict: 'tight', totalSpent: '8000.00', lowest: { periodLabel: 'Dec 2026', cashAfter: '5000.00' } });
  });

  it('says when cash is already tight before anything is spent', () => {
    // Opening 2,000.00: expected 3,000.00, 4,000.00, 5,000.00, all under the 7,000.00 buffer.
    const r = check({ amount: '100.00', basis: basis({}, '2000.00') });
    expect(r).toMatchObject({ verdictWithout: 'tight', verdict: 'tight', lowestWithout: { expectedCash: '3000.00' } });
  });

  it('names the first month when the lowest point is a tie', () => {
    // Money in equals money out: every month after a one-off sits at the same balance.
    const r = check({ amount: '500.00', basis: basis({ cash_inflows: '7000.00' }) });
    expect(r.months.map((m) => m.cashAfter)).toEqual(['9500.00', '9500.00', '9500.00']);
    expect(r.lowest?.periodLabel).toBe('Oct 2026');
  });
});

describe('what it refuses, with the reason, never a zero', () => {
  it('no opening balance, or no money in or out to forecast', () => {
    expect(check({ basis: basis({}, null) })).toMatchObject({ unavailable: 'no_cash_forecast', verdict: null, months: [] });
    expect(check({ basis: basis({ cash_outflows: null }) }).unavailable).toBe('no_cash_forecast');
    expect(check({ basis: basis({ cash_inflows: null }) }).unavailable).toBe('no_cash_forecast');
  });
  it('no forecast months at all', () => {
    expect(check({ horizon: [] }).unavailable).toBe('no_forecast');
  });
  it('a start beyond the forecast', () => {
    expect(check({ startsInMonth: 4 }).unavailable).toBe('starts_after_horizon');
    expect(check({ startsInMonth: 0 }).unavailable).toBe('starts_after_horizon');
  });
  it('an amount that is not more than zero, or past the modelling limit', () => {
    for (const amount of ['0', '-5.00', '1000000001', 'abc']) expect(check({ amount }).unavailable).toBe('invalid_amount');
  });
});

describe('the amount as the person wrote it', () => {
  it('reads plain, separated, symbol-led and suffixed amounts', () => {
    expect(parseWrittenAmount('£25,000')).toBe('25000.00');
    expect(parseWrittenAmount('25000')).toBe('25000.00');
    expect(parseWrittenAmount('AED 12,500.50')).toBe('12500.50');
    expect(parseWrittenAmount('$ 300')).toBe('300.00');
    expect(parseWrittenAmount('5k')).toBe('5000.00');
    expect(parseWrittenAmount('1.5m')).toBe('1500000.00');
    expect(parseWrittenAmount('10 thousand')).toBe('10000.00');
  });
  it('refuses what it would have to guess at', () => {
    for (const written of ['1,50', '1.234,56', '25,00,000', 'twenty', '5-10k', '', '£', '1.234']) {
      expect(parseWrittenAmount(written), written).toBeNull();
    }
  });
  it('finds the amount in the question only as written, ignoring case and spacing', () => {
    const q = 'Can we afford a £25,000  van and a 5K   laptop budget?';
    expect(writtenInQuestion('£25,000', q)).toBe(true);
    expect(writtenInQuestion('5k', q)).toBe(true);
    expect(writtenInQuestion('£25000', q)).toBe(false);
    expect(writtenInQuestion('30000', q)).toBe(false);
    expect(writtenInQuestion('  ', q)).toBe(false);
  });
});
